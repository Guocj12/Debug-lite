'use strict';
/* tests/unit/account.test.js —— 玩家档案门面（P7-2/B29+B30；D-129 §5.2/§5.3/§5.4/§7.5）
 * 覆盖：摘要视图 · 配置槽四条规则（≤3 / 唯一出战 / 必有出战 / 默认与出战不可删）· 快照冻结与内容寻址
 *      · 乐观锁 config_conflict · loadout 校验 · 仓库镜像引用校验 · 战绩 since 增量与未读游标
 *      · 防守战绩汇总 · 昵称 · 文件所有权（本层不得直接 IO）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const accountMod = require('../../server/account.js');
const loadoutMod = require('../../server/loadout.js');
const rankedMod = require('../../server/ranked.js');
const { StoreError } = require('../../server/store/errors.js');
const { openFixture, registerPlayer, sampleLoadout, quickRecord, makeLogger } = require('../helpers/account.js');
const LD = require('../fixtures/loadout-ok.json');

const REPO = path.join(__dirname, '..', '..');

async function playerFacts(fx, playerId) {
  const archive = await fx.store.loadArchive(playerId);
  const active = archive.configs.slots.find((s) => s.slotId === archive.configs.activeSlotId);
  return {
    playerId,
    publicId: archive.publicId,
    snapshotHash: active.snapshot.hash,
    configHash: active.snapshot.configHash,
  };
}

// 结算一场（B 类跨玩家写：journal + 幂等 apply，D-134）
async function settle(fx, a, b, overrides) {
  const pa = await playerFacts(fx, a.playerId);
  const pb = await playerFacts(fx, b.playerId);
  return fx.store.settleBattle(quickRecord(pa, pb, overrides));
}

async function activeOf(fx, playerId) {
  const res = await fx.account.listConfigs(playerId);
  return res.data;
}

/* ---------- D-163 夹具：出战配置引用的物品必须**真实存在于本人仓库** ----------
 * 背景：旧写法 `sampleLoadout(fx.account)` 取自 `ranked.buildDefaultLoadout()` 的 bot 夹具
 *   （uid = bot_role / bot_skill1…）——这些物品从来不在任何玩家仓库里。D-163 起
 *   `loadout.resolveItems` 按 uid 从**服务端权威仓库**取回物品身份与数值（客户端正文一律丢弃），
 *   未知 uid → `loadout_invalid`「物品不在仓库: <uid>」。故夹具物品必须**先入档**。
 * 另：D-163 跨配置独占（一件物品同时只能被一份配置引用）→ 需要两套互不相交的夹具时用 set 序号区分。
 * 物品形状与 tests/unit/warehouse-invariants.test.js 的 fixtureWarehouse() 同形（模板/品质取自数据表）。
 */
const FIX_SKILL_TEMPLATES = ['skill_melee_whirl', 'skill_straight_precise', 'skill_dash_bash'];

function fixtureItems(set) {
  const tag = `acc_fix${set}`;
  const skillPluginUid = `${tag}_sp`;
  const role = {
    uid: `${tag}_role`, kind: 'role', templateId: 'role_bal', name: `夹具角色${set}`, quality: 'common',
    slotCount: 1, slots: [{ type: 'atk', pluginUid: null }],
    stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
    pluginPoints: 3, unlockTier: 'common',
  };
  const skills = FIX_SKILL_TEMPLATES.map((templateId, i) => ({
    uid: `${tag}_skill${i}`, kind: 'skill', templateId, name: `夹具技能${set}-${i}`, quality: 'common',
    slotCount: 1, slots: [{ type: 'basic', pluginUid: i === 0 ? skillPluginUid : null }],
    // skills[0].params.cooldown = 3 —— ACC-4 的"客户端改写正文不影响已冻结快照"断言依赖该仓库基准值
    params: { multiplier: 1 + i / 10, cost: { hp: 0, mp: 8 + i, sp: 0 }, cooldown: 3 - i, bulletLevel: 2 + i },
    unlockTier: 'common',
  }));
  const skillPlugin = {
    uid: skillPluginUid, kind: 'skillPlugin', id: 'sp_mult', name: '倍率提升', slot: 'basic',
    quality: 'common', tier: 2, affixes: [], costDeltaByTier: { mp: [2, 4, 6] }, equipped: true, unlockTier: 'common',
  };
  return { role, skills, skillPlugin };
}

// 把夹具物品注入该玩家的**服务端权威仓库**（D-163：这是"这件物品存在"的唯一真源）
async function injectFixture(fx, playerId, set) {
  const items = fixtureItems(set);
  await fx.store.updateArchive(playerId, (a) => {
    a.warehouse.buckets.role.push(items.role);
    for (const sk of items.skills) a.warehouse.buckets.skill.push(sk);
    a.warehouse.buckets.skillPlugin.push(items.skillPlugin);
    return null;
  });
  return items;
}

// 以夹具物品构造一份完整合法的出战配置（每次调用返回新对象，互不别名）
function fixtureLoadout(fx, items, mutate) {
  const ld = { role: items.role, skills: items.skills.slice(), ai: fx.account.defaultLoadout().ai };
  if (typeof mutate === 'function') mutate(ld);
  return JSON.parse(JSON.stringify(ld));
}

// 把一份既有仓库正文（如 tests/fixtures/loadout-ok.json 的 warehouse）整仓注入玩家档案仓库
async function injectWarehouse(fx, playerId, warehouse) {
  await fx.store.updateArchive(playerId, (a) => {
    for (const key of Object.keys(warehouse.buckets)) {
      const list = warehouse.buckets[key];
      if (Array.isArray(list)) for (const it of list) a.warehouse.buckets[key].push(JSON.parse(JSON.stringify(it)));
    }
    return null;
  });
}

test('ACC-1 getSummary：§10.2 形状（段位/积分/未读/槽位/pool）；未知档案 404；非法 playerId 400', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Sum_1', nickname: '摘要' });
    const res = await fx.account.getSummary(u.playerId);
    assert.equal(res.ok, true);
    assert.deepEqual(Object.keys(res.data).sort(), [
      'activeSlotId', 'activeSlotName', 'activeSnapshotHash', 'flags', 'nickname', 'pool',
      'progress', 'publicId', 'rating', 'record', 'slots',
    ]);
    assert.equal(res.data.nickname, '摘要');
    assert.match(res.data.publicId, /^u_[0-9a-f]{8}$/);
    assert.deepEqual(res.data.progress, { tier: 'common', peakTier: 'common', batchesPlayed: 0, batchesPromoted: 0 });
    assert.deepEqual(res.data.rating, { points: 0, peakPoints: 0, games: 0, wins: 0, losses: 0, draws: 0 });
    assert.equal(res.data.slots.length, 3, 'D-159：注册即建满 3 个槽');
    assert.deepEqual(res.data.slots.map((s) => s.slotId), ['slot1', 'slot2', 'slot3']);
    assert.equal(res.data.slots[0].slotId, 'slot1');
    assert.equal(res.data.slots[0].isDefault, true);
    assert.equal(res.data.slots[0].name, '默认配置');
    assert.equal(res.data.slots[0].snapshotHash, res.data.activeSnapshotHash);
    assert.ok(res.data.slots[0].updatedAt > 0);
    assert.equal(res.data.slots[1].snapshotHash, null, 'D-160：非出战空槽无快照');
    assert.equal(res.data.slots[2].snapshotHash, null, 'D-160：非出战空槽无快照');
    assert.equal(res.data.activeSlotId, 'slot1');
    assert.equal(res.data.flags.unverifiedLoadout, false, 'D-159：starter 自带服务端权威仓库 → 注册即已校验');
    assert.deepEqual(res.data.pool, { inPool: true, drawnCount: 0 });
    assert.deepEqual(res.data.record.unread, { attack: 0, defense: 0, fromSeq: 0 });
    assert.equal(res.data.playerId, undefined, '摘要**不返回** playerId（§4.5）');
    // 幂等：连续两次逐值一致（无副作用）
    const again = await fx.account.getSummary(u.playerId);
    assert.deepEqual(again.data, res.data, 'GET /me 幂等');
    const missing = await fx.account.getSummary('pl_0000000000000000');
    assert.equal(missing.code, 'store_not_found');
    assert.equal(missing.status, 404);
    assert.equal((await fx.account.getSummary('')).code, 'bad_request');
  } finally {
    await fx.cleanup();
  }
});

test('ACC-2 配置槽：注册即 3 槽（D-159）、第 4 个 409 slot_limit、唯一出战、必有出战（D-131）', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Slot_1' });
    const first = await activeOf(fx, u.playerId);
    // D-159：注册发放 starter 并建满 3 槽 —— slot1 完整出战，slot2/slot3 为空槽（无快照）
    assert.equal(first.slots.length, 3);
    assert.equal(first.maxSlots, 3);
    assert.deepEqual(first.slots.map((s) => s.slotId), ['slot1', 'slot2', 'slot3']);
    assert.equal(first.activeSlotId, 'slot1');
    assert.equal(typeof first.slots[0].snapshot.hash, 'string', '出战槽必有快照');
    assert.equal(first.slots[1].snapshot, null, 'D-160：非出战空槽可无快照');
    assert.equal(first.slots[2].snapshot, null);
    // 已满 3 槽 → 第 4 个 409 slot_limit（旧写法"再建 2 个成功再撞限"已废除）
    const s4 = await fx.account.createSlot({ playerId: u.playerId, name: '四套' });
    assert.equal(s4.ok, false);
    assert.equal(s4.code, 'slot_limit');
    assert.equal(s4.status, 409);
    assert.equal(s4.details[0].code, 'slot_limit');
    // 必有出战：activeSlotId 指向存在且唯一的槽
    const three = await activeOf(fx, u.playerId);
    assert.equal(three.slots.length, 3);
    assert.equal(three.slots.filter((s) => s.slotId === three.activeSlotId).length, 1);
    // D-160：空槽不可设为出战 → 409 cannot_activate_incomplete（完整性校验推迟到 activate）
    const actEmpty = await fx.account.activateConfig({ playerId: u.playerId, slotId: 'slot2' });
    assert.equal(actEmpty.ok, false);
    assert.equal(actEmpty.code, 'cannot_activate_incomplete');
    assert.equal(actEmpty.status, 409);
    assert.ok(actEmpty.details.length > 0, 'details 逐位置列出缺项');
    // 写入完整配置后激活：唯一出战，且 activeSnapshotHash 跟随
    //   D-163：配置引用的物品必须来自本人仓库 → 先注入夹具（跨配置独占 ⇒ 与 slot1 的 starter 物品不重叠）
    const fix = await injectFixture(fx, u.playerId, 1);
    const saved = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot2', loadout: fixtureLoadout(fx, fix) });
    assert.equal(saved.ok, true, JSON.stringify(saved.details));
    const act = await fx.account.activateConfig({ playerId: u.playerId, slotId: 'slot2' });
    assert.equal(act.ok, true);
    assert.equal(act.data.activeSlotId, 'slot2');
    assert.equal(act.data.activeSnapshotHash, act.data.slot.snapshot.hash);
    const after = await activeOf(fx, u.playerId);
    assert.equal(after.slots.filter((s) => s.slotId === after.activeSlotId).length, 1);
    assert.equal(after.activeSlotId, 'slot2');
    assert.equal(after.activeSnapshotHash, after.slots.find((s) => s.slotId === 'slot2').snapshot.hash);
    const missing = await fx.account.activateConfig({ playerId: u.playerId, slotId: 'slot9' });
    assert.equal(missing.code, 'slot_not_found');
    assert.equal(missing.status, 404);
  } finally {
    await fx.cleanup();
  }
});

test('ACC-3 删除保护：默认槽 / 出战槽 → 409 slot_locked；切换后可删旧槽（T-AC-3）', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Del_1' });
    // D-159：注册即 3 槽；先让非默认槽 slot2 成为出战槽（空槽不可激活 → 先写完整配置）
    //   D-163：写进 slot2 的物品必须在本人仓库里（与 slot1 的 starter 物品不同 → 不触发跨配置独占）
    const fix = await injectFixture(fx, u.playerId, 1);
    const fill = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot2', loadout: fixtureLoadout(fx, fix) });
    assert.equal(fill.ok, true, JSON.stringify(fill.details));
    const delDefault = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot1' });
    assert.equal(delDefault.code, 'slot_locked');
    assert.equal(delDefault.status, 409);
    // slot1 既是默认槽又是出战槽：切到 slot2 后仍不可删（默认槽语义，§5.3）
    const act = await fx.account.activateConfig({ playerId: u.playerId, slotId: 'slot2' });
    assert.equal(act.ok, true, JSON.stringify(act.details));
    const delDefaultActive = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot1' });
    assert.equal(delDefaultActive.code, 'slot_locked', '默认槽可改不可删');
    const delActiveNow = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot2' });
    assert.equal(delActiveNow.code, 'slot_locked', '出战槽不可删（提示先切换）');
    // D-160：非出战槽（未写入完整配置的 slot3）可直接删除
    const del3 = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot3' });
    assert.equal(del3.ok, true, JSON.stringify(del3.details));
    assert.deepEqual(del3.data.slots.map((s) => s.slotId), ['slot1', 'slot2']);
    assert.equal(del3.data.activeSlotId, 'slot2');
    // 必有出战：删掉非出战槽后出战槽仍在
    const now = await activeOf(fx, u.playerId);
    assert.ok(now.slots.some((s) => s.slotId === now.activeSlotId));
    const unknown = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'nope' });
    assert.equal(unknown.code, 'slot_not_found');
  } finally {
    await fx.cleanup();
  }
});

test('ACC-4 快照冻结（T-AC-4）：保存后改客户端对象不影响已冻结快照；内容寻址去重', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Snap_1' });
    // D-163：物品身份/数值一律取自仓库 → 先注入两套互不相交的夹具（第二套用于"引用了另一件物品"的对照）
    const fix1 = await injectFixture(fx, u.playerId, 1);
    const fix2 = await injectFixture(fx, u.playerId, 2);
    const ld = fixtureLoadout(fx, fix1);
    const saved = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: ld });
    assert.equal(saved.ok, true);
    const hash1 = saved.data.snapshot.hash;
    assert.match(hash1, /^sha256:[0-9a-f]{64}$/);
    assert.equal(saved.data.activeSnapshotHash, hash1, '出战槽保存后 activeSnapshotHash 跟随');
    assert.equal(fx.store.snapshot.has(hash1), true);
    // 客户端对象被后续修改 → 档案与快照库都不变（深拷贝冻结）
    ld.skills[0].params.cooldown = 99;
    ld.skills[0].templateId = 'tampered';
    const after = await activeOf(fx, u.playerId);
    assert.equal(after.slots[0].loadout.skills[0].params.cooldown, 3);
    assert.notEqual(after.slots[0].loadout.skills[0].templateId, 'tampered');
    const snap = fx.store.snapshot.get(hash1);
    assert.equal(snap.loadout.skills[0].params.cooldown, 3);
    assert.equal(snap.engineVersion, '3.0.0');
    assert.equal(snap.dataVersion, 'b25');
    // 同内容重复保存 → 同 hash（内容寻址幂等）；不同内容 → 不同 hash
    const sameAgain = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: fixtureLoadout(fx, fix1) });
    assert.equal(sameAgain.data.snapshot.hash, hash1, '同内容 → 同快照 hash');
    // D-163：客户端正文（含 params）一律被仓库副本覆盖 → "不同内容"只能来自**引用仓库里的另一件物品**；
    //   这里把 skills[1] 换成第二套夹具的技能（同一槽重存 → 不触发跨配置独占）。
    const other = fixtureLoadout(fx, fix1, (l) => { l.skills[1] = fix2.skills[0]; });
    const saved2 = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: other });
    assert.notEqual(saved2.data.snapshot.hash, hash1, '不同内容 → 不同快照 hash');
    assert.equal(saved2.data.activeSnapshotHash, saved2.data.snapshot.hash);
    // D-160：新槽是**空槽**（不再复制出战配置）→ snapshot 为 null、loadout 为空骨架；出战仍是 slot1
    //   先释放一个非出战槽（D-159：注册即满 3 槽，直接 createSlot 会撞 409 slot_limit）
    const released = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot3' });
    assert.equal(released.ok, true, JSON.stringify(released.details));
    const s2 = await fx.account.createSlot({ playerId: u.playerId });
    assert.equal(s2.ok, true, JSON.stringify(s2.details));
    assert.equal(s2.data.snapshot, null, 'D-160：新建槽无快照');
    assert.equal(s2.data.slot.snapshot, null, 'D-160：槽记录内 snapshot 为 null');
    assert.deepEqual(s2.data.slot.loadout, { role: null, skills: [null, null, null], ai: null }, 'D-160：新建槽为空槽');
    assert.equal(s2.data.activeSlotId, 'slot1', 'D-160：新建槽不改变出战');
  } finally {
    await fx.cleanup();
  }
});

test('ACC-5 乐观锁：baseUpdatedAt 不匹配 → 409 config_conflict（T-AC-5）；缺省不校验', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Lock_2' });
    // D-163：物品必须来自本人仓库 → 注入夹具（同一份配置在**同一个槽**反复重存，不触发跨配置独占）
    const fix = await injectFixture(fx, u.playerId, 1);
    const ld = fixtureLoadout(fx, fix);
    const first = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: ld });
    assert.equal(first.ok, true);
    const stamp = first.data.slotUpdatedAt;
    const second = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: ld, baseUpdatedAt: stamp });
    assert.equal(second.ok, true, '携带最新 baseUpdatedAt → 通过');
    const stale = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: ld, baseUpdatedAt: stamp });
    assert.equal(stale.ok, false);
    assert.equal(stale.code, 'config_conflict');
    assert.equal(stale.status, 409);
    assert.equal(stale.details[0].path, 'baseUpdatedAt');
    const noLock = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: ld });
    assert.equal(noLock.ok, true, '不传 baseUpdatedAt = 不做乐观锁');
  } finally {
    await fx.cleanup();
  }
});

test('ACC-6 loadout 校验：非法 → 409 loadout_invalid（带 details.path）；缺 loadout → 400；未知槽 404', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Valid_1' });
    // D-160：**出战槽**要求完整 —— 不完整 → 409 loadout_invalid + 逐位置 details
    const bad = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: { role: null, skills: [], ai: null } });
    assert.equal(bad.code, 'loadout_invalid');
    assert.equal(bad.status, 409);
    assert.ok(bad.details.length > 0);
    assert.ok(bad.details.every((d) => typeof d.path === 'string' && typeof d.code === 'string'));
    assert.deepEqual(bad.details.map((d) => d.path), ['role', 'skills[0]', 'skills[1]', 'skills[2]', 'ai'], '逐位置列出缺项');
    assert.equal(bad.details[0].message, '缺少角色物品');
    assert.equal(bad.details[1].message, '技能位置缺失: 0');
    assert.equal(bad.details[4].message, '缺少 AI 程序');
    // D-160：**非出战槽**允许写不完整配置 → 200（无快照、complete:false、missing 逐位置）
    const partial = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot2', loadout: { role: null, skills: [], ai: null } });
    assert.equal(partial.ok, true, JSON.stringify(partial.details));
    assert.equal(partial.status, 200);
    assert.equal(partial.data.complete, false);
    assert.deepEqual(partial.data.missing, ['role', 'skills[0]', 'skills[1]', 'skills[2]', 'ai']);
    assert.equal(partial.data.snapshot, null, '不完整 → 不冻结快照');
    const partial2 = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot2', loadout: { role: null, skills: [null, null, null], ai: null } });
    assert.equal(partial2.data.complete, false);
    assert.deepEqual(partial2.data.missing, ['role', 'skills[0]', 'skills[1]', 'skills[2]', 'ai'],
      '空骨架 = 三个 null 技能位 → 与 saveConfig 的完整性判据一致（逐位置列出）');
    // 非出战槽缺少 loadout 字段 → 仍 400（缺 loadout 与"不完整 loadout"是两件事）
    const noLoadout = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1' });
    assert.equal(noLoadout.code, 'bad_request');
    assert.equal(noLoadout.status, 400);
    // D-160：缺 loadout 时出战槽同样 400（先于完整性判定）
    const noLoadout2 = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot2' });
    assert.equal(noLoadout2.code, 'bad_request');
    assert.equal(noLoadout2.status, 400);
    const unknownSlot = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot9', loadout: sampleLoadout(fx.account) });
    assert.equal(unknownSlot.code, 'slot_not_found');
    // createSlot 带**显式不完整** loadout → 409 loadout_invalid（空槽是"不传 loadout"，不是"传空 loadout"）
    const badSlotCreate = await fx.account.createSlot({ playerId: u.playerId, loadout: { role: null, skills: [], ai: null } });
    assert.equal(badSlotCreate.code, 'loadout_invalid');
    assert.equal(badSlotCreate.status, 409);
    // D-163：引用校验用**服务端权威仓库**。要让本用例真正覆盖"悬挂引用"分支，脏引用必须落在**仓库副本**上
    //   （写在客户端正文里会被 resolveItems 丢弃 → 只会撞"物品不在仓库: <uid>"，覆盖不到目标分支）。
    const fixDangling = await injectFixture(fx, u.playerId, 4);
    await fx.store.updateArchive(u.playerId, (a) => {
      const sk = a.warehouse.buckets.skill.find((x) => x.uid === fixDangling.skills[0].uid);
      sk.slots[0].pluginUid = 'plg1'; // 仓库里不存在该插件 → 悬挂引用
      return null;
    });
    const withRef = fixtureLoadout(fx, fixDangling);
    const noWh = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: withRef });
    assert.equal(noWh.code, 'loadout_invalid');
    assert.equal(noWh.status, 409);
    assert.ok(noWh.details.some((d) => d.code === 'loadout_invalid'));
    assert.ok(noWh.details.some((d) => /悬挂引用/.test(d.message)),
      `必须报"悬挂引用"（这才是本用例要覆盖的分支）：${JSON.stringify(noWh.details)}`);
    assert.ok(!noWh.details.some((d) => d.code === 'missing_warehouse'), 'D-159：不再因"未提交镜像"拒绝');
  } finally {
    await fx.cleanup();
  }
});

test('ACC-7 仓库镜像：形状校验 400；与出战配置一致才 verified（并清 unverifiedLoadout）；回读一致', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Wh_1' });
    // D-159：starter 自带服务端权威仓库并写入 slot1 → 注册即已校验（旧断言"未提交镜像 → true"已废除）
    assert.equal((await activeOf(fx, u.playerId)).unverifiedLoadout, false, 'D-159：注册发放 starter → 已校验');
    // D-159：GET /me 路径的仓库读取（account.getWarehouse）= 服务端真源，不再是 warehouse_missing
    const server = await fx.account.getWarehouse(u.playerId);
    assert.equal(server.ok, true, JSON.stringify(server.details));
    assert.deepEqual(Object.keys(server.data).sort(), ['buckets', 'caps', 'counts', 'starterIssued', 'usage']);
    assert.equal(server.data.starterIssued, true);
    assert.equal(server.data.counts.skill, 3);
    assert.equal(server.data.caps.role, 500);
    // 形状非法（PUT /me/warehouse 退役为只做形状校验）
    for (const bad of [null, [], {}, { buckets: [] }, { buckets: { role: 'nope' } }]) {
      const res = await fx.account.saveWarehouseMirror({ playerId: u.playerId, warehouse: bad });
      assert.equal(res.code, 'bad_request', JSON.stringify(bad));
      assert.equal(res.status, 400);
      assert.ok(res.details[0].path.startsWith('warehouse'));
    }
    // 带装配引用的配置：D-163 起**物品身份/数值与引用全部取自服务端仓库**（客户端正文与镜像都不再作数），
    //   故夹具物品（含"已被引用的技能插件"）必须先入档；客户端镜像 `wh` 仅用于快照摘录。
    const fix = await injectFixture(fx, u.playerId, 1);
    const wh = { buckets: { skillPlugin: [fix.skillPlugin], role: [], skill: [] } };
    const withRef = fixtureLoadout(fx, fix); // 仓库里的 skills[0] 自带对该技能插件的装配引用
    const saved = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: withRef, warehouse: wh });
    assert.equal(saved.ok, true, JSON.stringify(saved.details));
    assert.equal(saved.data.unverifiedLoadout, false, '提交仓库镜像 → verifiedAgainstWarehouse');
    // D-159：引用不覆盖出战配置的镜像 → **不再 409 loadout_invalid**，改 200 + verified:false + saved:true
    const mismatched = await fx.account.saveWarehouseMirror({ playerId: u.playerId, warehouse: { buckets: { skillPlugin: [] } } });
    assert.equal(mismatched.ok, true, JSON.stringify(mismatched.details));
    assert.equal(mismatched.status, 200);
    assert.equal(mismatched.data.saved, true);
    assert.equal(mismatched.data.verified, false, 'D-159：不覆盖出战配置引用 → verified:false（旧 409 已废除）');
    assert.equal((await activeOf(fx, u.playerId)).unverifiedLoadout, false, 'D-159：真源为服务端仓库 → 档案标志不被镜像降级');
    // 一致的镜像 → verified，并回读一致（round-trip）
    const good = await fx.account.saveWarehouseMirror({ playerId: u.playerId, warehouse: wh });
    assert.equal(good.ok, true);
    assert.equal(good.data.verified, true);
    assert.equal(good.data.unverifiedLoadout, false);
    assert.deepEqual(good.data.buckets, { skillPlugin: 1, role: 0, skill: 0 });
    assert.deepEqual(good.data.warehouse, wh, '回执带镜像正文');
    assert.match(good.data.warehouseHash, /^sha256:[0-9a-f]{64}$/);
    const back = await fx.account.getWarehouseMirror(u.playerId);
    assert.equal(back.ok, true);
    assert.deepEqual(back.data.warehouse, wh, 'PUT/GET 往返一致');
    assert.equal(back.data.warehouseHash, good.data.warehouseHash);
    assert.equal((await activeOf(fx, u.playerId)).unverifiedLoadout, false);
    assert.equal(fx.account.mirrorCacheSize(), 1, '镜像缓存按玩家计条目');
    // 未提交过镜像的玩家 → warehouse_missing（镜像缓存语义保留；注意与服务端真源是两回事）
    const other = await registerPlayer(fx.auth, { username: 'Wh_2' });
    assert.equal((await fx.account.getWarehouseMirror(other.playerId)).code, 'warehouse_missing');
    assert.equal((await fx.account.getWarehouse(other.playerId)).ok, true, 'D-159：真源对每位玩家恒可读（不再 404）');
  } finally {
    await fx.cleanup();
  }
});

test('ACC-8 战绩 since 增量游标 + 未读游标 + markSeen（T-AU 覆盖点 16）', async () => {
  const fx = await openFixture({});
  try {
    const a = await registerPlayer(fx.auth, { username: 'Rec_A' });
    const b = await registerPlayer(fx.auth, { username: 'Rec_B' });
    const r1 = await settle(fx, a, b, { seed: 11 });
    const r2 = await settle(fx, a, b, { seed: 12, p1Result: 'loss', p2Result: 'win', winner: 'p2' });
    assert.equal(r1.duplicate, false);
    assert.equal(r2.duplicate, false);
    const seq1 = r1.record.seq;
    const seq2 = r2.record.seq;
    assert.ok(seq2 > seq1);
    // 进攻方：2 条进攻战绩、未读 2、角色 attacker
    const all = await fx.account.records({ playerId: a.playerId });
    assert.equal(all.ok, true);
    assert.equal(all.data.records.length, 2);
    assert.deepEqual(all.data.records.map((e) => e.role), ['attacker', 'attacker']);
    assert.deepEqual(all.data.records.map((e) => e.result), ['win', 'loss']);
    assert.equal(all.data.unread.attack, 2);
    assert.equal(all.data.unread.defense, 0);
    assert.equal(all.data.latestSeq, seq2, 'latestSeq = 本次返回里最大的 seq');
    assert.equal(all.data.maxSeq >= seq2, true);
    assert.equal(all.data.records[0].opponentPublicId, b.publicId);
    assert.equal(all.data.records[0].seed, 11);
    assert.equal(all.data.records[0].ticks, 23);
    // since 增量
    const inc = await fx.account.records({ playerId: a.playerId, since: seq1 });
    assert.equal(inc.data.records.length, 1);
    assert.equal(inc.data.records[0].seq, seq2);
    assert.equal(inc.data.latestSeq, seq2);
    const none = await fx.account.records({ playerId: a.playerId, since: seq2 });
    assert.equal(none.data.records.length, 0);
    assert.equal(none.data.latestSeq, seq2);
    // role 过滤
    assert.equal((await fx.account.records({ playerId: a.playerId, role: 'defense' })).data.records.length, 0);
    // latestSeq 不是游标：limit 截断时它指向最新一条，而 unread 仍为 2（游标推进只能由 records/seen 负责）
    const truncated = await fx.account.records({ playerId: a.playerId, limit: 1 });
    assert.equal(truncated.data.records.length, 1);
    assert.equal(truncated.data.records[0].seq, seq2, '返回的是最新 1 条');
    assert.equal(truncated.data.latestSeq, seq2);
    assert.equal(truncated.data.unread.attack, 2, '未读未被读取清空');
    // 防守方（离线也产生，§7.3）
    const def = await fx.account.records({ playerId: b.playerId, role: 'defense' });
    assert.equal(def.data.records.length, 2);
    assert.deepEqual(def.data.records.map((e) => e.role), ['defender', 'defender']);
    assert.equal(def.data.unread.defense, 2);
    // markSeen 推进游标 → 红点清零；已读条目标记 seen
    const seen = await fx.account.markSeen({ playerId: a.playerId, uptoSeq: seq2 });
    assert.equal(seen.ok, true);
    assert.deepEqual(seen.data.unread, { attack: 0, defense: 0, fromSeq: seq2 });
    const afterSeen = await fx.account.records({ playerId: a.playerId, since: 0 });
    assert.deepEqual(afterSeen.data.records.map((e) => e.seen), [true, true]);
    // 参数校验
    assert.equal((await fx.account.records({ playerId: a.playerId, since: -1 })).code, 'bad_request');
    assert.equal((await fx.account.records({ playerId: a.playerId, limit: 0 })).code, 'bad_request');
    assert.equal((await fx.account.records({ playerId: a.playerId, limit: 101 })).code, 'bad_request');
    assert.equal((await fx.account.records({ playerId: a.playerId, role: 'both' })).code, 'bad_request');
    assert.equal((await fx.account.markSeen({ playerId: a.playerId, uptoSeq: 'x' })).code, 'bad_request');
  } finally {
    await fx.cleanup();
  }
});

test('ACC-9 防守战绩汇总：被抽场次 / 胜负 / 最近列表 / 未读（T-RK-3 视图侧）', async () => {
  const fx = await openFixture({});
  try {
    const a = await registerPlayer(fx.auth, { username: 'Def_A' });
    const b = await registerPlayer(fx.auth, { username: 'Def_B' });
    await settle(fx, a, b, { seed: 21 });
    await settle(fx, a, b, { seed: 22, p1Result: 'draw', p2Result: 'draw', winner: 'draw' });
    const res = await fx.account.defenseSummary({ playerId: b.playerId });
    assert.equal(res.ok, true);
    assert.equal(res.data.drawnCount, 2, '被抽 2 场');
    assert.deepEqual(res.data.stats, { wins: 0, losses: 1, draws: 1 });
    assert.equal(res.data.recent.length, 2);
    assert.equal(res.data.unread, 2);
    for (const e of res.data.recent) {
      assert.equal(e.opponentPublicId, a.publicId);
      assert.equal(typeof e.battleId, 'string');
      assert.equal(e.seen, false);
    }
    const limited = await fx.account.defenseSummary({ playerId: b.playerId, limit: 1 });
    assert.equal(limited.data.recent.length, 1);
    assert.equal((await fx.account.defenseSummary({ playerId: b.playerId, limit: 0 })).code, 'bad_request');
    // 进攻方没有防守战绩
    const attacker = await fx.account.defenseSummary({ playerId: a.playerId });
    assert.equal(attacker.data.drawnCount, 0);
    assert.deepEqual(attacker.data.stats, { wins: 0, losses: 0, draws: 0 });
  } finally {
    await fx.cleanup();
  }
});

test('ACC-10 昵称：合法落盘（journal player.nickname.changed）；非法 1~16 校验', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Nick_2' });
    assert.equal(u.res.data.nickname, 'Nick_2', '缺省昵称 = 用户名');
    const okRes = await fx.account.setNickname({ playerId: u.playerId, nickname: '调试员🎮' });
    assert.equal(okRes.ok, true);
    assert.equal(okRes.data.nickname, '调试员🎮');
    assert.equal((await fx.account.getSummary(u.playerId)).data.nickname, '调试员🎮');
    assert.equal((await fx.account.setNickname({ playerId: u.playerId, nickname: '' })).code, 'bad_request');
    assert.equal((await fx.account.setNickname({ playerId: u.playerId, nickname: 'x'.repeat(17) })).code, 'bad_request');
    const journal = fx.store.readRecords({ includeCheckpoints: false });
    assert.ok(journal.some((r) => r.type === 'player.nickname.changed' && r.nickname === '调试员🎮'));
  } finally {
    await fx.cleanup();
  }
});

test('ACC-11 文件所有权：auth.js/account.js 不直接 IO / 不 spawn / 不用 Math.random（D-92/§3.1）', () => {
  for (const rel of ['server/auth.js', 'server/account.js']) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    assert.equal(/require\(\s*['"]node:fs['"]\s*\)/.test(src), false, `${rel} 不得 require node:fs（唯一允许 fs 的是 server/store/*）`);
    assert.equal(/require\(\s*['"](node:)?child_process['"]\s*\)/.test(src), false, `${rel} 不得 require child_process`);
    assert.equal(/Math\s*\.\s*random\s*\(/.test(src), false, `${rel} 不得用 Math.random（D-92）`);
  }
  // 账号层是唯一需要密码学随机的地方：必须经 node:crypto
  const authSrc = fs.readFileSync(path.join(REPO, 'server/auth.js'), 'utf8');
  assert.ok(/require\(\s*['"]node:crypto['"]\s*\)/.test(authSrc), 'auth.js 的随机/哈希经 node:crypto');
  assert.ok(/crypto\.randomBytes\(/.test(authSrc), 'token/盐使用 crypto.randomBytes');
  assert.ok(/scryptSync/.test(authSrc), '密码使用 scryptSync 加盐哈希');
});

test('ACC-12 模块级纯工具与信封：defaultLoadout/校验器/错误码→HTTP 映射（P7-4 直接复用）', () => {
  // 默认配置构造（§5.3：role_bal + 3 技能 + 兜底 AI），两次调用相互独立
  const ld = accountMod.defaultLoadout();
  const ld2 = accountMod.defaultLoadout();
  assert.deepEqual(ld, ld2);
  assert.equal(ld.skills.length, 3);
  assert.notEqual(ld, ld2, '每次返回新对象（不受调用方修改影响）');
  ld.skills[0].params.cooldown = 999;
  assert.deepEqual(accountMod.defaultLoadout(), ld2);
  assert.equal(accountMod.validateLoadoutOf(ld2, {}).ok, true);
  assert.equal(accountMod.validateLoadoutOf(ld2, {}).warehouseVerified, false);
  // 校验器把 loadout.js 的 {where,code,message} 映射为 details 的 {path,code,message}
  const bad = accountMod.validateLoadoutOf({ role: null, skills: [], ai: null }, {});
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  for (const e of bad.errors) assert.deepEqual(Object.keys(e).sort(), ['code', 'message', 'path']);
  assert.equal(accountMod.validateWarehouseMirror({ buckets: { role: [] } }).ok, true);
  assert.equal(accountMod.validateWarehouseMirror({ buckets: { role: {} } }).ok, false);
  assert.equal(accountMod.validateWarehouseMirror(null).details[0].path, 'warehouse');
  // 信封 + 错误码 → HTTP（§10.3）
  assert.deepEqual(accountMod.ok({ a: 1 }), { ok: true, status: 200, code: null, message: null, data: { a: 1 }, details: [] });
  const f = accountMod.fail('slot_limit', '满了');
  assert.equal(f.status, 409);
  assert.equal(f.details.length, 0);
  for (const [code, status] of [['slot_locked', 409], ['slot_not_found', 404], ['loadout_invalid', 409], ['config_conflict', 409],
    ['unauthorized', 401], ['session_expired', 401], ['invalid_credentials', 401], ['too_many_attempts', 429], ['weak_password', 400],
    ['username_taken', 409], ['banned', 403], ['forbidden', 403], ['store_not_found', 404], ['bad_request', 400],
    ['warehouse_missing', 404]]) {
    assert.equal(accountMod.statusOf(code), status, code);
  }
  assert.equal(accountMod.statusOf('no_such_code'), 500, '未登记错误码 → 500');
  assert.deepEqual(accountMod.detailOf('bad_request', 'x', 'field'), { path: 'field', code: 'bad_request', message: 'x' });
  const mapped = accountMod.toFailure(new StoreError('slot_locked', '默认槽不可删', [{ path: 'slot1', code: 'slot_locked', message: 'x' }]), null, 'unit');
  assert.equal(mapped.code, 'slot_locked');
  assert.equal(mapped.status, 409);
  assert.equal(mapped.details.length, 1);
  assert.equal(accountMod.toFailure(new TypeError('boom'), null, 'unit').code, 'store_internal');
});

/* ---------- 缺口 1（P1 最终报告 ⑧）：快照自带镜像，"已校验"状态可持久 ---------- */

test('ACC-D1 缺口 1：校验通过时把"该配置引用到的插件项"随快照落盘（有界 / 重启可回读 / 旧快照兼容）', async (t) => {
  let fx = await openFixture({ logger: makeLogger() });
  t.after(() => fx.cleanup());
  const u = await registerPlayer(fx.auth, { username: 'P1Wh_1', nickname: '装配' });

  // D-163：物品身份/数值按 uid 从**服务端权威仓库**取回（`warehouse` 入参只作降级/摘录来源）
  //   → LD 的那套物品必须先真实入档，否则保存直接 409「物品不在仓库: r1」。
  await injectWarehouse(fx, u.playerId, LD.warehouse);
  // 保存带装配引用的配置（LD.loadout 引用 pa/pb/qx；装配校验必须带镜像）
  const save = await fx.account.saveConfig({
    playerId: u.playerId, slotId: 'slot1', loadout: LD.loadout, warehouse: LD.warehouse,
  });
  assert.equal(save.ok, true, JSON.stringify(save.details).slice(0, 240));
  assert.equal(save.data.unverifiedLoadout, false, '带镜像保存 → 已校验');
  const hash = save.data.slot.snapshot.hash;

  // ① 快照正文携带装配引用子集，且只含**该配置引用到的**插件项（不整仓拷贝）
  const snap = await fx.store.snapshot.get(hash);
  assert.ok(snap.warehouse && snap.warehouse.buckets, '快照必须自带装配引用子集');
  const uids = [];
  const bucketNames = [];
  for (const [key, list] of Object.entries(snap.warehouse.buckets)) {
    bucketNames.push(key);
    for (const it of list) uids.push(it.uid);
  }
  assert.deepEqual(uids.slice().sort(), ['pa', 'pb', 'qx'], '恰好 3 个被引用插件（rolePlugin pa/pb + skillPlugin qx）');
  assert.deepEqual(bucketNames.sort(), ['rolePlugin', 'skillPlugin'], '不携带未被引用的 role/skill 桶');
  assert.equal(require('../../server/store/archive.js').excerptCoversRefs(LD.loadout, snap.warehouse), true,
    '摘录覆盖该配置的全部装配引用（足以重建面板）');
  assert.equal(Object.prototype.hasOwnProperty.call(snap, 'hash'), true);
  assert.equal(snap.hash, hash, '内容寻址键不变（摘录不参与 hash）');

  // ② 面板可重建：与真镜像逐值一致；与"退化（no-op 占位插件）"面板不同 → 词条真实生效
  //   D-163：`buildPanel(loadout, {warehouse})` 也按 uid 从仓库解析物品（纵深防御）→ 摘录只含**插件**，
  //   重建面板时须把快照正文里的角色/技能并入仓库（= syntheticVerifiedWarehouse 的角色/技能部分），
  //   插件仍用摘录里的真品（否则会退化成 no-op 面板，本断言就失去意义）。
  const excerptWarehouse = {
    buckets: Object.assign({}, rankedMod.syntheticVerifiedWarehouse(snap.loadout).buckets, snap.warehouse.buckets),
  };
  const fromExcerpt = loadoutMod.buildPanel(LD.loadout, { warehouse: excerptWarehouse, tier: 'mythic' });
  const fromReal = loadoutMod.buildPanel(LD.loadout, { warehouse: LD.warehouse, tier: 'mythic' });
  assert.equal(fromExcerpt.ok, true);
  assert.deepEqual(fromExcerpt.panel, fromReal.panel, '摘录重建的面板与真镜像逐值一致');
  const noop = rankedMod.syntheticVerifiedWarehouse(LD.loadout);
  const degraded = loadoutMod.buildPanel(LD.loadout, { warehouse: noop, tier: 'mythic' });
  assert.equal(degraded.ok, true);
  assert.notDeepEqual(degraded.panel, fromReal.panel, '退化面板 ≠ 真实面板（证明插件词条确实生效）');

  // ③ 数据量：单快照体积 + 摘录体积 + 磁盘文件体积（KB 级，见报告）
  const digest = hash.slice('sha256:'.length);
  const file = path.join(fx.dir, 'snapshots', digest.slice(0, 2), `${digest}.json`);
  const bytes = {
    snapshotFile: fs.statSync(file).size,
    snapshotJson: Buffer.byteLength(JSON.stringify(snap)),
    excerptJson: Buffer.byteLength(JSON.stringify(snap.warehouse)),
    wholeWarehouseJson: Buffer.byteLength(JSON.stringify(LD.warehouse)),
  };
  t.diagnostic(`[缺口1] 单快照 ${bytes.snapshotFile}B / 正文JSON ${bytes.snapshotJson}B；装配引用子集 ${bytes.excerptJson}B（整仓 ${bytes.wholeWarehouseJson}B，占比 ${(bytes.excerptJson / bytes.wholeWarehouseJson * 100).toFixed(1)}%）`);
  assert.ok(bytes.excerptJson < bytes.wholeWarehouseJson / 2, '摘录必须显著小于整仓（只存被引用项）');
  assert.ok(bytes.snapshotFile < 8 * 1024, `单快照应保持 KB 级（实得 ${bytes.snapshotFile}B）`);

  // ④ 保存镜像后**刷新**同 hash 快照的摘录（"只提交镜像、不再重存配置"的客户端同样持久）
  const refreshed = await fx.account.saveWarehouseMirror({ playerId: u.playerId, warehouse: LD.warehouse });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.data.snapshotWarehouseRefreshed, true, 'PUT /me/warehouse 会把引用子集附到出战快照');

  // ⑤ 重启（同目录新 store 实例：进程内镜像缓存必然为空）→ 摘录仍可回读且逐值一致
  const before = snap.warehouse;
  fx = await fx.reopen();
  const after = (await fx.store.snapshot.get(hash)).warehouse;
  assert.deepEqual(after, before, '重启后摘录逐值一致（不再依赖进程内缓存）');
  assert.equal((await fx.store.loadArchive(u.playerId)).flags.unverifiedLoadout, false);
});

test('ACC-D2 缺口 1 兼容：无摘录的旧快照（无新字段）不报错；未校验/无镜像仍如实 missing_warehouse', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'P1Wh_2' });
    // 旧形状快照：freezeSnapshot 不带 warehouse → 正文无该字段
    const legacy = fx.store.freezeSnapshot(LD.loadout);
    assert.equal(legacy.warehouse, undefined, '无镜像 → 快照形状与旧版一致（不落该字段）');
    // D-163：先把 LD 的物品真实入档（保存正文 = 按 uid 从权威仓库解析出的副本）
    await injectWarehouse(fx, u.playerId, LD.warehouse);
    // 同 loadout 再冻结**不会**丢已有摘录（无新字段 → 不改写）
    const save = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: LD.loadout, warehouse: LD.warehouse });
    assert.equal(save.ok, true);
    // D-163：落盘正文多一个 `aiId: null`（resolveItems 规范化的产物）→ 内容寻址键与裸 LD.loadout 不同，
    //   故此处冻结**落盘的那份正文**（同 hash）才能验证"再冻结不带 warehouse 仍保留既有摘录"。
    const again = fx.store.freezeSnapshot(save.data.slot.loadout);
    assert.ok(again.warehouse, '同 hash 再冻结（不带 warehouse）保留既有摘录');
    // 旧快照 + 未校验 → 生产路径必须如实 409（绝不放宽）
    const res = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: { role: null, skills: [], ai: null } });
    assert.equal(res.code, 'loadout_invalid');
    assert.equal(loadoutMod.validateLoadout(LD.loadout, { warehouse: null, tier: 'mythic' }).errors
      .some((e) => e.code === 'missing_warehouse'), true, '无镜像 → missing_warehouse（不放宽口径）');
  } finally {
    await fx.cleanup();
  }
});
