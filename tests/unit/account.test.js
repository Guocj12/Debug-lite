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
    assert.equal(res.data.slots.length, 1);
    assert.equal(res.data.slots[0].slotId, 'slot1');
    assert.equal(res.data.slots[0].isDefault, true);
    assert.equal(res.data.slots[0].name, '默认配置');
    assert.equal(res.data.slots[0].snapshotHash, res.data.activeSnapshotHash);
    assert.ok(res.data.slots[0].updatedAt > 0);
    assert.equal(res.data.activeSlotId, 'slot1');
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

test('ACC-2 配置槽：最多 3 套（第 4 个 409 slot_limit）、唯一出战、必有出战（D-131）', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Slot_1' });
    const first = await activeOf(fx, u.playerId);
    assert.equal(first.slots.length, 1);
    assert.equal(first.maxSlots, 3);
    const s2 = await fx.account.createSlot({ playerId: u.playerId, name: '二套' });
    assert.equal(s2.ok, true);
    assert.equal(s2.data.slotId, 'slot2');
    assert.equal(s2.data.slot.isDefault, false);
    assert.equal(s2.data.activeSlotId, 'slot1', '新建槽默认不改变出战');
    const s3 = await fx.account.createSlot({ playerId: u.playerId });
    assert.equal(s3.data.slotId, 'slot3');
    const s4 = await fx.account.createSlot({ playerId: u.playerId });
    assert.equal(s4.ok, false);
    assert.equal(s4.code, 'slot_limit');
    assert.equal(s4.status, 409);
    assert.equal(s4.details[0].code, 'slot_limit');
    // 必有出战：每一步 activeSlotId 都指向存在且唯一的槽
    const three = await activeOf(fx, u.playerId);
    assert.equal(three.slots.length, 3);
    assert.equal(three.slots.filter((s) => s.slotId === three.activeSlotId).length, 1);
    // 唯一出战：切换只有一个生效，且 activeSnapshotHash 跟随
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
    await fx.account.createSlot({ playerId: u.playerId });
    await fx.account.createSlot({ playerId: u.playerId });
    const delDefault = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot1' });
    assert.equal(delDefault.code, 'slot_locked');
    assert.equal(delDefault.status, 409);
    // slot1 既是默认槽又是出战槽：切到 slot2 后仍不可删（默认槽语义，§5.3）
    await fx.account.activateConfig({ playerId: u.playerId, slotId: 'slot2' });
    const delDefaultActive = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot1' });
    assert.equal(delDefaultActive.code, 'slot_locked', '默认槽可改不可删');
    const delActiveNow = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot2' });
    assert.equal(delActiveNow.code, 'slot_locked', '出战槽不可删（提示先切换）');
    const del3 = await fx.account.deleteSlot({ playerId: u.playerId, slotId: 'slot3' });
    assert.equal(del3.ok, true);
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
    const ld = sampleLoadout(fx.account);
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
    const sameAgain = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: sampleLoadout(fx.account) });
    assert.equal(sameAgain.data.snapshot.hash, hash1, '同内容 → 同快照 hash');
    const other = sampleLoadout(fx.account, (l) => { l.skills[1].params = Object.assign({}, l.skills[1].params, { cooldown: 9 }); });
    const saved2 = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: other });
    assert.notEqual(saved2.data.snapshot.hash, hash1, '不同内容 → 不同快照 hash');
    assert.equal(saved2.data.activeSnapshotHash, saved2.data.snapshot.hash);
    // 新槽复制出战配置 → 快照 hash 与出战槽一致（复用同一份快照）
    const s2 = await fx.account.createSlot({ playerId: u.playerId });
    assert.equal(s2.data.slot.snapshot.hash, saved2.data.snapshot.hash);
  } finally {
    await fx.cleanup();
  }
});

test('ACC-5 乐观锁：baseUpdatedAt 不匹配 → 409 config_conflict（T-AC-5）；缺省不校验', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Lock_2' });
    const ld = sampleLoadout(fx.account);
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
    const bad = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: { role: null, skills: [], ai: null } });
    assert.equal(bad.code, 'loadout_invalid');
    assert.equal(bad.status, 409);
    assert.ok(bad.details.length > 0);
    assert.ok(bad.details.every((d) => typeof d.path === 'string' && typeof d.code === 'string'));
    assert.ok(bad.details.some((d) => d.path === 'skills'));
    const noLoadout = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1' });
    assert.equal(noLoadout.code, 'bad_request');
    assert.equal(noLoadout.status, 400);
    const unknownSlot = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot9', loadout: sampleLoadout(fx.account) });
    assert.equal(unknownSlot.code, 'slot_not_found');
    const badSlotCreate = await fx.account.createSlot({ playerId: u.playerId, loadout: { role: null, skills: [], ai: null } });
    assert.equal(badSlotCreate.code, 'loadout_invalid');
    // 引用完整性：有装配引用但没给仓库镜像 → loadout_invalid（missing_warehouse，I-12d/T-PB-9）
    const withRef = sampleLoadout(fx.account, (l) => { l.skills[0].slots = [{ pluginUid: 'plg1' }]; });
    const noWh = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: withRef });
    assert.equal(noWh.code, 'loadout_invalid');
    assert.ok(noWh.details.some((d) => d.code === 'missing_warehouse'));
  } finally {
    await fx.cleanup();
  }
});

test('ACC-7 仓库镜像：形状校验 400；与出战配置一致才 verified（并清 unverifiedLoadout）；回读一致', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Wh_1' });
    assert.equal((await activeOf(fx, u.playerId)).unverifiedLoadout, true, '注册未提交仓库镜像 → 标记未校验');
    // 形状非法
    for (const bad of [null, [], {}, { buckets: [] }, { buckets: { role: 'nope' } }]) {
      const res = await fx.account.saveWarehouseMirror({ playerId: u.playerId, warehouse: bad });
      assert.equal(res.code, 'bad_request', JSON.stringify(bad));
      assert.equal(res.status, 400);
      assert.ok(res.details[0].path.startsWith('warehouse'));
    }
    // 把带装配引用的配置存起来（必须同时给仓库镜像才能通过引用校验）
    const wh = { buckets: { skillPlugin: [{ uid: 'plg1', kind: 'skillPlugin', equipped: true, tier: 2, unlockTier: 'common' }], role: [], skill: [] } };
    const withRef = sampleLoadout(fx.account, (l) => { l.skills[0].slots = [{ pluginUid: 'plg1' }]; });
    const saved = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: withRef, warehouse: wh });
    assert.equal(saved.ok, true, JSON.stringify(saved.details));
    assert.equal(saved.data.unverifiedLoadout, false, '提交仓库镜像 → verifiedAgainstWarehouse');
    // 空镜像与出战配置不一致 → loadout_invalid
    const mismatched = await fx.account.saveWarehouseMirror({ playerId: u.playerId, warehouse: { buckets: { skillPlugin: [] } } });
    assert.equal(mismatched.code, 'loadout_invalid');
    assert.equal(mismatched.status, 409);
    assert.ok(mismatched.details.some((d) => d.code === 'loadout_invalid'));
    // 一致的镜像 → verified，并回读一致（round-trip）
    const good = await fx.account.saveWarehouseMirror({ playerId: u.playerId, warehouse: wh });
    assert.equal(good.ok, true);
    assert.equal(good.data.verified, true);
    assert.equal(good.data.unverifiedLoadout, false);
    assert.deepEqual(good.data.buckets, { skillPlugin: 1, role: 0, skill: 0 });
    assert.match(good.data.warehouseHash, /^sha256:[0-9a-f]{64}$/);
    const back = await fx.account.getWarehouseMirror(u.playerId);
    assert.equal(back.ok, true);
    assert.deepEqual(back.data.warehouse, wh, 'PUT/GET 往返一致');
    assert.equal(back.data.warehouseHash, good.data.warehouseHash);
    assert.equal((await activeOf(fx, u.playerId)).unverifiedLoadout, false);
    assert.equal(fx.account.mirrorCacheSize(), 1, '镜像缓存按玩家计条目');
    // 未提交过镜像的玩家 → warehouse_missing
    const other = await registerPlayer(fx.auth, { username: 'Wh_2' });
    assert.equal((await fx.account.getWarehouseMirror(other.playerId)).code, 'warehouse_missing');
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
  assert.equal(Object.prototype.hasOwnProperty.call(snap, 'hash'), true);
  assert.equal(snap.hash, hash, '内容寻址键不变（摘录不参与 hash）');

  // ② 面板可重建：与真镜像逐值一致；与"退化（no-op 占位插件）"面板不同 → 词条真实生效
  const fromExcerpt = loadoutMod.buildPanel(LD.loadout, { warehouse: snap.warehouse, tier: 'mythic' });
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
    // 同 loadout 再冻结**不会**丢已有摘录（无新字段 → 不改写）
    const save = await fx.account.saveConfig({ playerId: u.playerId, slotId: 'slot1', loadout: LD.loadout, warehouse: LD.warehouse });
    assert.equal(save.ok, true);
    const again = fx.store.freezeSnapshot(LD.loadout);
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
