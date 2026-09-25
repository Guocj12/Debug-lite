'use strict';
/* tests/unit/quickmatch-availability.test.js —— D1-residual：抽池筛选与实例化**共用同一可用性判定**
 *
 * 权威要求：docs/systems/10-ranked.md §4.3 注记（2026-09-19 登记）——"抽池筛选与最终实例化必须共用同一
 *   '可用性'判定；若两处口径不一致，会出现'抽得到但打不了'的含混失败"。docs/progress.md 待办同款。
 *
 * 实测复现（修前，见交付报告 D1-residual）：
 *   ① 玩家先 `PUT /me/warehouse` 提交**子集**镜像（当时配置无引用 → 校验必过，且置 `unverifiedLoadout=false`）；
 *   ② 之后开箱装配并 `PUT /me/configs/slot1 {带引用 loadout, 全量 warehouse}`（进程内缓存 = 全量，
 *      快照自带镜像 = 全量，但**账号级镜像仍是子集**）；
 *   ③ `rt.loadWarehouse` 原先取**首个非空**来源（账号级子集镜像遮蔽更好的来源）→ 抽池认为"可用"，
 *      实例化（`battle.buildPlayer`）报 `悬挂引用` → `POST /quick/run` = 409 `no_opponent`
 *      （"抽到的对手快照无法实例化"），根因埋在 warn 里；清掉账号级镜像后同 seed 立刻 200。
 * 修法：`rt.loadWarehouse` 逐来源做**覆盖判定**（`ranked.warehouseCovers`）后再采用；抽池/自身校验用
 *   `ranked.sideInstantiable`（= `battle.buildPlayer`，与 `battleOne` 同源）证明可实例化；失败回带逐条明细。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const qm = require('../../server/quickmatch.js');
const rankedMod = require('../../server/ranked.js');
const serverMod = require('../../server/index.js');
const itemsApi = require('../../server/core/items.js');
const boxApi = require('../../server/box.js');
const h = require('../helpers/ranked.js');
const { nullLogger, createLogger } = require('../../shared/log.js');

// 真实物品 + 真实装配的仓库与出战配置（零 HTTP；与 tests/unit/quickmatch.test.js 同构）
function pluginFixture() {
  let wh = itemsApi.emptyWarehouse();
  const boxed = boxApi.openBoxes({ seed: 20260919, tier: 'common', times: 24 });
  const boxedItems = boxed && boxed.data && Array.isArray(boxed.data.items) ? boxed.data.items : (boxed.items || []);
  for (const it of boxedItems) {
    if (!Array.isArray(wh.buckets[it.kind])) wh.buckets[it.kind] = [];
    wh.buckets[it.kind].push(it);
  }
  const find = (uid) => {
    for (const list of Object.values(wh.buckets)) {
      if (!Array.isArray(list)) continue;
      const hit = list.find((x) => x && x.uid === uid);
      if (hit) return hit;
    }
    return null;
  };
  const targets = wh.buckets.role.slice(0, 1).concat(wh.buckets.skill.slice(0, 3));
  for (const t0 of targets) {
    for (let i = 0; i < (t0.slots || []).length; i++) {
      const target = find(t0.uid);
      if (!target || !target.slots[i] || target.slots[i].pluginUid) continue;
      const kind = target.kind === 'role' ? 'rolePlugin' : 'skillPlugin';
      const cand = (wh.buckets[kind] || []).find((p) => p.slot === target.slots[i].type && p.equipped !== true);
      if (!cand) continue;
      const r = itemsApi.assemble(wh, { targetUid: target.uid, slotIndex: i, pluginUid: cand.uid, tier: 'common' });
      if (r && r.warehouse) wh = r.warehouse;
    }
  }
  const role = find(targets[0].uid);
  const skills = targets.slice(1).map((t) => find(t.uid));
  const refs = (role.slots || []).filter((s) => s.pluginUid).length
    + skills.reduce((n, sk) => n + (sk.slots || []).filter((s) => s.pluginUid).length, 0);
  return { warehouse: wh, loadout: { role, skills, ai: rankedMod.buildDefaultLoadout().ai }, refs };
}

const emptyWarehouse = () => itemsApi.emptyWarehouse();

// 剥掉装配引用（保持结构合法 = 一份"无引用"的真实配置）
function bareOf(loadout) {
  const copy = JSON.parse(JSON.stringify(loadout));
  for (const s of copy.role.slots || []) s.pluginUid = null;
  for (const sk of copy.skills || []) for (const s of sk.slots || []) s.pluginUid = null;
  return copy;
}

// D-163：**无引用配置必须由仓库里"插槽为空"的物品构成**——客户端把 slots[].pluginUid 置 null 已不再生效
//   （resolveItems 取回的是仓库那份物品，其 slots 里的 pluginUid 原样带出）。故直接注入 1 角色 + 3 技能
//   （slotCount=0，无任何装配引用），再让配置引用它们。
async function injectBareSet(store, playerId, tag) {
  const roleUid = `bare_role_${tag}`;
  const skillUids = [1, 2, 3].map((i) => `bare_skill_${tag}_${i}`);
  await store.updateArchive(playerId, (a) => {
    a.warehouse.buckets.role.push({
      uid: roleUid, kind: 'role', templateId: 'role_bal', name: '无槽角色（夹具）', quality: 'common',
      slotCount: 0, slots: [], stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 },
      regen: { mp: 1, sp: 2 }, pluginPoints: 0, unlockTier: 'common',
    });
    ['skill_melee_whirl', 'skill_straight_precise', 'skill_dash_bash'].forEach((tid, i) => {
      a.warehouse.buckets.skill.push({
        uid: skillUids[i], kind: 'skill', templateId: tid, name: `无槽技能${i + 1}（夹具）`, quality: 'common',
        slotCount: 0, slots: [], params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 10 }, cooldown: 2, bulletLevel: 2 },
        unlockTier: 'common',
      });
    });
    return null;
  });
  const wh = (await store.getWarehouse(playerId)).warehouse;
  const find = (uid) => wh.buckets.role.find((x) => x.uid === uid) || wh.buckets.skill.find((x) => x.uid === uid);
  return { role: find(roleUid), skills: skillUids.map(find) };
}

test('AV-1 纯函数：warehouseCovers / warehouseMissingRefs（无引用恒覆盖；缺引用逐项列出）', () => {
  const { warehouse, loadout, refs } = pluginFixture();
  assert.ok(refs > 0, `夹具必须带装配引用（实得 ${refs}）`);
  assert.equal(rankedMod.warehouseCovers(loadout, warehouse), true, '全量镜像覆盖');
  assert.equal(rankedMod.warehouseCovers(loadout, null), false, '有引用 + 无镜像 = 不覆盖');
  assert.equal(rankedMod.warehouseCovers(bareOf(loadout), null), true, '无引用 → 恒覆盖（含 null）');
  const missing = rankedMod.warehouseMissingRefs(loadout, emptyWarehouse());
  assert.equal(missing.length, refs, '空镜像 → 全部引用缺失');
  assert.equal(rankedMod.warehouseMissingRefs(loadout, warehouse).length, 0);
});

test('AV-2 纯函数：sideInstantiable 与实例化同源（覆盖镜像可实例化；不覆盖 → 逐条错误）', () => {
  const { warehouse, loadout } = pluginFixture();
  const ok = rankedMod.sideInstantiable(loadout, warehouse, 'common');
  assert.equal(ok.ok, true, `覆盖镜像应可实例化：${JSON.stringify(ok.errors).slice(0, 200)}`);
  const bad = rankedMod.sideInstantiable(loadout, emptyWarehouse(), 'common');
  assert.equal(bad.ok, false, '空镜像不得判为可实例化');
  assert.ok(bad.errors.length > 0 && bad.errors.every((e) => typeof e.code === 'string'), '回带逐条 buildPanel 错误');
  const noRefs = rankedMod.sideInstantiable(bareOf(loadout), null, 'common');
  assert.equal(noRefs.ok, true, `无引用配置无需镜像：${JSON.stringify(noRefs.errors).slice(0, 200)}`);
});

test('AV-3 抽池与实例化口径一致：不可实例化的候选在抽池阶段即被排除（`skipped.notInstantiable`）', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const { warehouse, loadout } = pluginFixture();
  const me = h.makePlayerId(201);
  const foe = h.makePlayerId(202);
  // ⚠️ D-159：注册（无显式 loadout 且非 bot）即发 starter —— 新号的默认配置**带真实物品与插件引用**
  //   （`slot1.loadout.role.slots[].pluginUid` 指向服务端仓库物品），所以"发起者不受镜像影响"这一前提
  //   在 D-159 后不再成立。此处改为**显式无引用 loadout** 建档，保留原用例"发起者自身侧不需要仓库"的原意。
  const meCreated = await fx.account.createPlayerArchive({
    playerId: me, nickname: '无引用发起者', loadout: bareOf(loadout), tier: 'common', at: fx.clock(),
  });
  assert.equal(meCreated.ok, true, JSON.stringify(meCreated).slice(0, 200));
  assert.equal(meCreated.data.starter.issued, false, '显式 loadout → 不发放 starter（D-159）');
  assert.equal(rankedMod.needsWarehouse((await fx.store.loadArchive(me)).configs.slots[0].loadout), false,
    '发起者配置确无装配引用 → 其可用性不受镜像影响');
  // 对手：带引用且**已校验**（快照自带镜像齐备）
  const foeCreated = await fx.account.createPlayerArchive({ playerId: foe, nickname: '装配置对手', loadout, warehouse, tier: 'common', at: fx.clock() });
  assert.equal(foeCreated.ok, true, JSON.stringify(foeCreated).slice(0, 200));

  // ① 覆盖镜像 → 入池（对照）
  const healthy = qm.createQuickMatch({ store: fx.store, logger: fx.logger, loadWarehouse: async () => warehouse });
  const poolOk = await healthy.candidatePool(me);
  assert.equal(poolOk.pool.length, 1, '覆盖镜像的候选应入池');
  assert.equal(poolOk.skipped.notInstantiable, 0);
  assert.equal(poolOk.skipped.noWarehouse, 0);

  // ② 镜像"存在但不覆盖" → 抽池阶段必须排除（修前：非空即放行 → 对局时 409 no_opponent）
  const broken = qm.createQuickMatch({ store: fx.store, logger: fx.logger, loadWarehouse: async () => emptyWarehouse() });
  const pool2 = await broken.candidatePool(me);
  assert.equal(pool2.skipped.notInstantiable, 1, `不可实例化候选必须在抽池阶段被排除（skipped=${JSON.stringify(pool2.skipped)}）`);
  assert.equal(pool2.pool.length, 0);
  assert.ok(fx.logger.records.some((x) => x.event === 'store.snapshot.missing' && x.data && x.data.code === 'not_instantiable'),
    '留可观测 warn（pool_availability）');
  // 候选池空 → 如实 no_opponent（不注入 bot、不放宽）
  fx.clock.advance(73 * 3600 * 1000);
  const r = await broken.run({ playerId: me, seed: 3 });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'no_opponent');

  // ③ 自身侧同轴：发起者带引用 + 镜像不覆盖 → **匹配前**即 409 loadout_invalid（可解释，不是含混的 no_opponent）
  //   D-159：`registerPlayer` 的 starter 配置自带装配引用（服务端仓库），恰好是"带引用"的发起者；
  //   此处再把镜像缝指向空仓（覆盖不了任何引用）→ 验证自身侧判定与抽池侧同轴。
  const self = await fx.registerPlayer({ playerId: h.makePlayerId(203), nickname: '装配发起者' });
  assert.equal(rankedMod.needsWarehouse((await fx.store.loadArchive(self.playerId)).configs.slots[0].loadout), true,
    'D-159 starter 配置带装配引用（本用例的"带引用发起者"由此产生）');
  const selfRun = await broken.run({ playerId: self.playerId, seed: 4 });
  assert.equal(selfRun.status, 409, JSON.stringify(selfRun).slice(0, 220));
  assert.equal(selfRun.code, 'loadout_invalid', '自身不可实例化 → 明确 loadout_invalid（含逐条明细）');
  assert.ok((selfRun.details || []).length > 0, '带 buildPanel 逐条原因');
  assert.ok((selfRun.details || []).every((d) => typeof d.code === 'string' && typeof d.where === 'string'),
    '逐条明细带 code/where（可解释，不是含混的 no_opponent）');
});

test('AV-4 端到端复现（修前 409 no_opponent）：陈旧账号级镜像不再遮蔽覆盖来源 → quick/run 200', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-av4-'));
  let rt = null;
  try {
    const logger = createLogger({ level: 'debug', ringSize: 20000 });
    rt = await serverMod.createRuntime(logger, {
      dataDir: dir,
      authConfig: { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 1000 } },
    });
    const reg = await rt.auth.register({ username: 'av4a', password: 'pw12345678' });
    assert.equal(reg.ok, true, JSON.stringify(reg).slice(0, 200));
    const playerId = reg.data.playerId;
    const { warehouse, loadout, refs } = pluginFixture();
    assert.ok(refs > 0);
    // ① 先提交**空/子集**镜像。D-159 起 PUT /me/warehouse 退役为"只做形状校验"：引用不覆盖出战配置
    //   **不再 409**，改 200 + verified:false（服务端仓库才是真源）。
    const sub = await rt.account.saveWarehouseMirror({ playerId, warehouse: emptyWarehouse() });
    assert.equal(sub.ok, true, JSON.stringify(sub).slice(0, 200));
    assert.equal(sub.data.verified, false, '空镜像覆盖不了引用 → verified:false（D-159 不再 409）');
    assert.equal(sub.data.saved, true, '形状合法 → 仍然落缓存（遗留兼容路径）');
    assert.equal(sub.data.unverifiedLoadout, true, '不覆盖 → 如实回带 unverified');
    // 形状非法仍必须 400（保留原有防护，不因退役而放宽）
    const badShape = await rt.account.saveWarehouseMirror({ playerId, warehouse: { buckets: { role: 'nope' } } });
    assert.equal(badShape.ok, false);
    assert.equal(badShape.code, 'bad_request', '形状非法 → bad_request（D-159 保留）');
    // 正向路径（D-159 后仍成立）：显式无引用配置 + 形状合法镜像 → verified:true，镜像仍进进程内缓存
    //   D-163：出战配置的物品必须来自**本人服务端仓库**，且"无引用"必须由**仓库里插槽为空的物品**构成
    //   （客户端把 pluginUid 置 null 已不生效）→ 先注入一套无槽物品，再引用它们。
    const positive = await rt.auth.register({ username: 'av4c', password: 'pw12345678' });
    assert.equal(positive.ok, true);
    const bareSet = await injectBareSet(rt.store, positive.data.playerId, 'av4c');
    const bareSave = await rt.account.saveConfig({
      playerId: positive.data.playerId, slotId: 'slot1',
      loadout: { role: bareSet.role, skills: bareSet.skills, ai: loadout.ai },
    });
    assert.equal(bareSave.ok, true, JSON.stringify(bareSave).slice(0, 300));
    const okMirror = await rt.account.saveWarehouseMirror({
      playerId: positive.data.playerId, warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
    });
    assert.equal(okMirror.ok, true, JSON.stringify(okMirror).slice(0, 200));
    assert.equal(okMirror.data.verified, true, '无引用配置 → 任何形状合法镜像都覆盖 → verified:true');
    assert.equal(okMirror.data.saved, true);
    assert.equal(okMirror.data.unverifiedLoadout, false);
    assert.equal(typeof okMirror.data.warehouseHash, 'string', '回带镜像内容 hash（可对账）');
    const readBack = await rt.account.getWarehouseMirror(positive.data.playerId);
    assert.equal(readBack.ok, true, '镜像仍保留在进程内缓存（PUT 只校验，不落盘）');
    assert.deepEqual(readBack.data.warehouse, okMirror.data.warehouse, '回读镜像逐值一致');
    // ② 保存带引用的出战配置 + 全量镜像
    //   D-163：resolveItems 只认**服务端权威仓库** → 先把夹具仓库的物品注入 av4a 的档案仓库
    //   （夹具物品此前只作为客户端镜像存在；不注入则 saveConfig 会如实 409 `物品不在仓库`）。
    await rt.store.updateArchive(playerId, (a) => {
      for (const kind of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
        for (const it of warehouse.buckets[kind] || []) a.warehouse.buckets[kind].push(JSON.parse(JSON.stringify(it)));
      }
      return null;
    });
    const save = await rt.account.saveConfig({ playerId, slotId: 'slot1', loadout, warehouse });
    assert.equal(save.ok, true, JSON.stringify(save).slice(0, 300));
    const foe = await rt.auth.register({ username: 'av4b', password: 'pw12345678' });
    assert.equal(foe.ok, true);
    // ③ 服务端必须取到**覆盖**配置引用的仓库（修前：账号级空镜像遮蔽 → 不覆盖）
    const wh = await rt.loadWarehouse(playerId);
    assert.ok(wh, 'loadWarehouse 不得返回 null（有覆盖来源）');
    assert.equal(rankedMod.warehouseCovers(loadout, wh), true, '取到的镜像必须覆盖全部引用');
    // D-163/D-159：真源（档案仓库）本就覆盖 → ⓪ 号来源命中即返回，陈旧账号级空镜像**根本不被咨询**
    //   （"跳过不覆盖来源"的 warn 只属于兜底路径，见 ⑤ —— 那里仍然钉住该观测点）。
    assert.equal((await rt.account.getWarehouseMirror(playerId)).data.warehouse.buckets.role.length, 0,
      '陈旧账号级空镜像仍在进程内缓存（本用例的"遮蔽源"），但没有被采用');
    // ④ 快速对战必须成立（修前 409 no_opponent）
    const q = await rt.quick.run({ playerId, seed: 7 });
    assert.equal(q.status, 200, `陈旧镜像不得再导致抽得到打不了：${JSON.stringify(q).slice(0, 300)}`);
    assert.ok(q.data.battleId.startsWith('b_'));
    // ⑤ D-163 兜底 + 可观测性（真源**不覆盖**时；现实来源 = 档案被事后清理/迁移不完整）：
    //   覆盖的账号级镜像必须兜底，且被跳过的来源必须留 warn `warehouse_mirror_incomplete`。
    const mirrorSave = await rt.account.saveWarehouseMirror({ playerId, warehouse });
    assert.equal(mirrorSave.ok, true, JSON.stringify(mirrorSave).slice(0, 200));
    const fixtureUids = new Set();
    for (const kind of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
      for (const it of warehouse.buckets[kind] || []) fixtureUids.add(it.uid);
    }
    await rt.store.updateArchive(playerId, (a) => {
      for (const kind of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
        a.warehouse.buckets[kind] = a.warehouse.buckets[kind].filter((it) => !fixtureUids.has(it.uid));
      }
      return null;
    });
    const fallback = await rt.loadWarehouse(playerId);
    assert.ok(fallback && rankedMod.warehouseCovers(loadout, fallback), '真源不覆盖 → 覆盖的账号级镜像兜底');
    assert.ok(fallback.buckets.role.length > 0, '兜底镜像含角色（D-163 起插件子集不足以保证可实例化）');
    assert.ok(logger.records.some((x) => x.event === 'store.snapshot.missing' && x.data && x.data.reason === 'warehouse_mirror_incomplete'),
      '跳过不覆盖来源必须留 warn（warehouse_mirror_incomplete）');
  } finally {
    if (rt && rt.store) await rt.store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('AV-5 残余兜底：真发生实例化失败时错误可解释（保持 no_opponent 契约 + details）', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const me = await fx.registerPlayer({});
  await fx.registerPlayer({});
  const quick = qm.createQuickMatch({
    store: fx.store,
    logger: fx.logger,
    // 注入接缝：模拟"抽池说可用、实例化却失败"的漂移（修后抽池已排除，此处只验证兜底可解释性）
    runBattle: () => ({ invalid: true, winner: 'draw', ticks: 0, errors: [{ where: 'skills[0]', code: 'loadout_invalid', message: '悬挂引用 item_x' }] }),
  });
  const r = await quick.run({ playerId: me.playerId, seed: 5 });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'no_opponent', '对外错误码保持契约（interfaces §2 / e2e 断言依赖）');
  assert.equal(r.details.length, 1, '必须回带逐条明细（不再"含混"）');
  assert.equal(r.details[0].path, 'skills[0]', 'P2-3：details 必须含 path');
  assert.equal(r.details[0].where, 'skills[0]', '向后兼容：where 一并保留');
  assert.equal(r.details[0].code, 'loadout_invalid');
  assert.ok(fx.logger.records.some((x) => x.event === 'store.snapshot.missing' && x.data && x.data.reason === 'instantiation_diverged'),
    '留可观测 warn（instantiation_diverged）');
});

test('AV-6 不放宽：未校验且无镜像的候选仍不参与抽取（skipped.noWarehouse）', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const { warehouse, loadout } = pluginFixture();
  const me = h.makePlayerId(301);
  const foe = h.makePlayerId(302);
  await fx.account.createPlayerArchive({ playerId: me, nickname: '发起者', loadout, warehouse, tier: 'common', at: fx.clock() });
  const foeCreated = await fx.account.createPlayerArchive({ playerId: foe, nickname: '未校验对手', loadout, warehouse, tier: 'common', at: fx.clock() });
  assert.equal(foeCreated.ok, true);
  // 翻转成"未校验"（快照的 verifiedAgainstWarehouse 也清掉）
  await fx.store.updateArchive(foe, (a) => {
    a.flags.unverifiedLoadout = true;
    for (const slot of a.configs.slots) if (slot.snapshot) slot.snapshot.verifiedAgainstWarehouse = false;
    return null;
  });
  const quick = qm.createQuickMatch({ store: fx.store, logger: fx.logger, loadWarehouse: async () => null });
  const pool = await quick.candidatePool(me);
  assert.equal(pool.pool.length, 0);
  assert.equal(pool.skipped.noWarehouse, 1, '未校验 + 无镜像 → 不入池（口径未放宽）');
  assert.equal(pool.skipped.notInstantiable, 0);
  assert.equal(warehouse.buckets.role.length > 0, true);
});
