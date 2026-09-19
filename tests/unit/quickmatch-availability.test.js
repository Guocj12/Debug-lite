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

test('AV-1 纯函数：warehouseCovers / warehouseMissingRefs（无引用恒覆盖；缺引用逐项列出）', () => {
  const { warehouse, loadout, refs } = pluginFixture();
  assert.ok(refs > 0, `夹具必须带装配引用（实得 ${refs}）`);
  assert.equal(rankedMod.warehouseCovers(loadout, warehouse), true, '全量镜像覆盖');
  assert.equal(rankedMod.warehouseCovers(loadout, null), false, '有引用 + 无镜像 = 不覆盖');
  assert.equal(rankedMod.warehouseCovers({ role: { slots: [] }, skills: [] }, null), true, '无引用 → 恒覆盖（含 null）');
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
  const noRefs = rankedMod.sideInstantiable({ role: { slots: [] }, skills: [] }, null, 'common');
  assert.equal(noRefs.ok, true, '无引用配置无需镜像');
});

test('AV-3 抽池与实例化口径一致：不可实例化的候选在抽池阶段即被排除（`skipped.notInstantiable`）', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const { warehouse, loadout } = pluginFixture();
  const me = h.makePlayerId(201);
  const foe = h.makePlayerId(202);
  const created = await fx.account.createPlayerArchive({ playerId: me, nickname: '装配发起者', loadout, warehouse, tier: 'common', at: fx.clock() });
  assert.equal(created.ok, true, JSON.stringify(created).slice(0, 200));
  await fx.registerPlayer({ playerId: foe }); // 对手：默认配置（无引用）

  // ① 抽池：默认配置对手可实例化 → 入池；带引用且镜像覆盖的对手也应入池
  const quick = qm.createQuickMatch({ store: fx.store, logger: fx.logger, loadWarehouse: async (pid) => (pid === me ? warehouse : null) });
  const pool = await quick.candidatePool(me);
  assert.equal(pool.pool.length, 1, '默认配置对手入池');
  assert.equal(pool.skipped.notInstantiable, 0);

  // ② 让**对手**的镜像"存在但不覆盖"（模拟陈旧/残缺镜像）→ 抽池阶段必须排除，而不是拖到对局时 409
  const foeArchive = await fx.store.loadArchive(foe);
  const foeLoadoutWithRefs = JSON.parse(JSON.stringify(loadout));
  await fx.store.updateArchive(foe, (a) => {
    const slot = a.configs.slots.find((x) => x.slotId === a.configs.activeSlotId);
    const snap = { hash: slot.snapshot.hash, configHash: slot.snapshot.configHash, loadout: foeLoadoutWithRefs, engineVersion: slot.snapshot.engineVersion, dataVersion: slot.snapshot.dataVersion, frozenAt: slot.snapshot.frozenAt };
    fx.store.snapshot.put(snap); // 同一 hash 内容寻址：把对手快照换成"带引用"的正文（缺覆盖镜像）
    a.flags.unverifiedLoadout = false;
    return null;
  });
  const quick2 = qm.createQuickMatch({ store: fx.store, logger: fx.logger, loadWarehouse: async () => emptyWarehouse() });
  const pool2 = await quick2.candidatePool(me);
  assert.equal(pool2.skipped.notInstantiable, 1, `不可实例化候选必须在抽池阶段被排除（skipped=${JSON.stringify(pool2.skipped)}）`);
  assert.equal(pool2.pool.length, 0);
  assert.ok(fx.logger.records.some((x) => x.event === 'store.snapshot.missing' && x.data && x.data.code === 'not_instantiable'),
    '留可观测 warn（pool_availability）');
  // 候选池空 → 如实 no_opponent（不注入 bot、不放宽）
  fx.clock.advance(73 * 3600 * 1000);
  const r = await quick2.run({ playerId: me, seed: 3 });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'no_opponent');
  assert.equal(foeArchive.publicId !== undefined, true);
});

test('AV-4 端到端复现（修前 409 no_opponent）：陈旧账号级镜像不再遮蔽覆盖来源 → quick/run 200', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-av4-'));
  let rt = null;
  try {
    const logger = createLogger({ level: 'debug', ringSize: 20000 });
    rt = await serverMod.createRuntime(logger, { dataDir: dir, authConfig: h.SERVICE && { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 1000 } } });
    const reg = await rt.auth.register({ username: 'av4a', password: 'pw12345678' });
    assert.equal(reg.ok, true, JSON.stringify(reg).slice(0, 200));
    const playerId = reg.data.playerId;
    const { warehouse, loadout, refs } = pluginFixture();
    assert.ok(refs > 0);
    // ① 先提交**空/子集**镜像（此时默认配置无引用 → 校验必过）
    const sub = await rt.account.saveWarehouseMirror({ playerId, warehouse: emptyWarehouse() });
    assert.equal(sub.ok, true, JSON.stringify(sub).slice(0, 200));
    // ② 保存带引用的出战配置 + 全量镜像
    const save = await rt.account.saveConfig({ playerId, slotId: 'slot1', loadout, warehouse });
    assert.equal(save.ok, true, JSON.stringify(save).slice(0, 300));
    const foe = await rt.auth.register({ username: 'av4b', password: 'pw12345678' });
    assert.equal(foe.ok, true);
    // ③ 服务端必须取到**覆盖**配置引用的镜像（修前：账号级空镜像遮蔽 → 不覆盖）
    const wh = await rt.loadWarehouse(playerId);
    assert.ok(wh, 'loadWarehouse 不得返回 null（有覆盖来源）');
    assert.equal(rankedMod.warehouseCovers(loadout, wh), true, '取到的镜像必须覆盖全部引用');
    assert.ok(logger.records.some((x) => x.event === 'store.snapshot.missing' && x.data && x.data.reason === 'warehouse_mirror_incomplete'),
      '跳过不覆盖来源必须留 warn（warehouse_mirror_incomplete）');
    // ④ 快速对战必须成立（修前 409 no_opponent）
    const q = await rt.quick.run({ playerId, seed: 7 });
    assert.equal(q.status, 200, `陈旧镜像不得再导致抽得到打不了：${JSON.stringify(q).slice(0, 300)}`);
    assert.ok(q.data.battleId.startsWith('b_'));
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
  await fx.registerPlayer({ playerId: foe });
  // 对手换成带引用但**未校验**的配置（unverifiedLoadout=true）且无镜像
  await fx.store.updateArchive(foe, (a) => {
    const slot = a.configs.slots.find((x) => x.slotId === a.configs.activeSlotId);
    fx.store.snapshot.put({
      hash: slot.snapshot.hash, configHash: slot.snapshot.configHash, loadout: JSON.parse(JSON.stringify(loadout)),
      engineVersion: slot.snapshot.engineVersion, dataVersion: slot.snapshot.dataVersion, frozenAt: slot.snapshot.frozenAt,
    });
    a.flags.unverifiedLoadout = true;
    return null;
  });
  const quick = qm.createQuickMatch({ store: fx.store, logger: fx.logger, loadWarehouse: async () => null });
  const pool = await quick.candidatePool(me);
  assert.equal(pool.pool.length, 0);
  assert.equal(pool.skipped.noWarehouse, 1, '未校验 + 无镜像 → 不入池（口径未放宽）');
  assert.equal(pool.skipped.notInstantiable, 0);
  assert.equal(warehouse.buckets.role.length > 0, true);
});
