'use strict';
/* tests/unit/store-archive.test.js —— 档案领域模型：字段/校验/迁移/记录应用/视图（D-129 §5.2/§5.3/§5.7/§6.2） */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const arch = require('../../server/store/archive.js');
const { nullLogger } = require('../../shared/log.js');
const { DEFAULT_SERVICE_CONFIG } = require('../../server/store/config.js');
const { contentHash } = require('../../server/store/canonical.js');

const PID1 = 'pl_1111111111111111';
const PID2 = 'pl_2222222222222222';
const SHA_A = contentHash({ role: 'a' });
const SHA_B = contentHash({ role: 'b' });

function ctx(extra) {
  return {
    config: DEFAULT_SERVICE_CONFIG,
    now: () => 5000,
    logger: nullLogger,
    loadSnapshot: async (hash) => (hash === SHA_A ? { hash: SHA_A, loadout: { role: 'a', skills: [], ai: null } } : null),
    ...(extra || {}),
  };
}

function newArchive(playerId, opts) {
  return arch.createArchive({
    playerId: playerId || PID1, publicId: 'u_11111111', nickname: 'n1', at: 1000,
    auth: { algo: 'scrypt', hash: 'h1', N: 16384 },
    slot: { slotId: 'slot1', name: '默认配置', loadout: { role: 'a' }, snapshot: { hash: SHA_A, engineVersion: '3.0.0', dataVersion: 'b25', configHash: 'sha256:c1' } },
    ...(opts || {}),
  });
}

test('ARC-1 createArchive：§5.2 字段全表 + 注册即有默认槽与快照 + 校验通过', () => {
  const a = newArchive();
  assert.equal(a.archiveVersion, 1);
  assert.equal(a.playerId, PID1);
  assert.match(a.publicId, /^u_[0-9a-f]{8}$/);
  assert.equal(a.progress.tier, 'common');
  assert.equal(a.progress.peakTier, 'common');
  assert.equal(a.rating.points, 0);
  assert.equal(a.rating.seasonId, 's0');
  assert.equal(a.configs.slots.length, 1);
  assert.equal(a.configs.slots[0].isDefault, true);
  assert.equal(a.configs.activeSlotId, 'slot1');
  assert.equal(a.configs.activeSnapshotHash, SHA_A);
  assert.equal(a.pool.inPool, true);
  assert.equal(a.record.appliedSeq, 0);
  assert.deepEqual(a.record.unread, { attack: 0, defense: 0, fromSeq: 0 });
  assert.equal(arch.validateArchive(a, { config: DEFAULT_SERVICE_CONFIG }).ok, true);
  assert.equal(arch.assertArchiveInvariants(a, { config: DEFAULT_SERVICE_CONFIG }), a);
  assert.equal(arch.activeSlot(a).slotId, 'slot1');
  // 非法 playerId
  assert.throws(() => arch.createArchive({ playerId: 'bogus' }), (e) => e.code === 'bad_request');
  // bot 档案
  const bot = arch.createArchive({ playerId: PID2, at: 1, isBot: true, tier: 'epic', points: 500, nickname: 'bot' });
  assert.equal(bot.flags.isBot, true);
  assert.equal(bot.progress.tier, 'epic');
  assert.equal(bot.rating.points, 500);
  assert.equal(bot.configs.slots.length, 0);
  // 工具
  assert.equal(arch.shardOf(PID1), '11', '分片取 pl_ 之后的前 2 个 hex（不是 "pl"）');
  assert.equal(arch.archiveRelPath(PID1), `players/11/${PID1}.json`);
  assert.match(arch.newPlayerId(), /^pl_[0-9a-f]{16}$/);
  assert.match(arch.newPublicId(), /^u_[0-9a-f]{8}$/);
  assert.equal(arch.isTier('mythic'), true);
  assert.equal(arch.isTier('nope'), false);
  assert.equal(arch.nextTier('common'), 'rare');
  assert.equal(arch.nextTier('mythic'), null);
  assert.equal(arch.nextTier('bogus'), null);
  assert.equal(arch.isValidUsername('dev_01'), true);
  assert.equal(arch.isValidUsername('ab'), false);
  assert.equal(arch.isValidNickname('调试员'), true);
  assert.equal(arch.isValidNickname(''), false);
  assert.equal(arch.slotIdOf(DEFAULT_SERVICE_CONFIG, 2), 'slot2');
  assert.equal(arch.maxSlotsOf(DEFAULT_SERVICE_CONFIG), 3);
  assert.equal(arch.defaultRecentLimit(DEFAULT_SERVICE_CONFIG), 100);
  assert.equal(arch.maxSlotsOf({ config: { maxSlots: 0 } }), 3, '非法配置回落默认');
  assert.equal(arch.defaultRecentLimit({}), 100);
});

test('ARC-2 validateArchive 各失败分支 + assertArchiveInvariants 抛 store_inconsistent', () => {
  const cfg = { config: DEFAULT_SERVICE_CONFIG };
  assert.equal(arch.validateArchive(null, cfg).ok, false);
  assert.equal(arch.validateArchive({ archiveVersion: 1, playerId: PID1, publicId: 'u_11111111', progress: {}, rating: {}, configs: {}, pool: {}, record: {}, flags: {} }, cfg).ok, false);
  const bad = newArchive();
  bad.archiveVersion = 9;
  assert.equal(arch.validateArchive(bad, cfg).errors[0].code, 'store_version_unsupported');
  const noSection = newArchive();
  delete noSection.rating;
  assert.ok(arch.validateArchive(noSection, cfg).errors.some((e) => e.path === 'rating'));
  const badIds = newArchive();
  badIds.playerId = 'x';
  badIds.publicId = 'y';
  assert.ok(arch.validateArchive(badIds, cfg).errors.length >= 2);
  const tooMany = newArchive();
  for (let i = 2; i <= 4; i += 1) {
    tooMany.configs.slots.push(arch.createSlot({ slotId: `slot${i}`, snapshot: { hash: SHA_B } }));
  }
  assert.ok(arch.validateArchive(tooMany, cfg).errors.some((e) => e.code === 'slot_limit'));
  const dup = newArchive();
  dup.configs.slots.push(arch.createSlot({ slotId: 'slot1', snapshot: { hash: SHA_B } }));
  assert.ok(arch.validateArchive(dup, cfg).errors.some((e) => e.message.includes('重复')));
  const twoDefaults = newArchive();
  twoDefaults.configs.slots.push(arch.createSlot({ slotId: 'slot2', isDefault: true, snapshot: { hash: SHA_B } }));
  assert.ok(arch.validateArchive(twoDefaults, cfg).errors.some((e) => e.message.includes('多个默认槽')));
  const noSnapshot = newArchive();
  noSnapshot.configs.slots[0].snapshot = null;
  assert.ok(arch.validateArchive(noSnapshot, cfg).errors.some((e) => e.code === 'no_active_config'));
  const badActive = newArchive();
  badActive.configs.activeSlotId = 'slot_gone';
  assert.ok(arch.validateArchive(badActive, cfg).errors.some((e) => e.code === 'no_active_config'));
  const mismatch = newArchive();
  mismatch.configs.activeSnapshotHash = SHA_B;
  assert.ok(arch.validateArchive(mismatch, cfg).errors.some((e) => e.path === 'configs.activeSnapshotHash'));
  const emptySlots = newArchive();
  emptySlots.configs.slots = [];
  assert.ok(arch.validateArchive(emptySlots, cfg).errors.some((e) => e.code === 'no_active_config'));
  const badRating = newArchive();
  badRating.rating.points = -1;
  badRating.rating.peakPoints = -5;
  assert.ok(arch.validateArchive(badRating, cfg).errors.length >= 2);
  const badTier = newArchive();
  badTier.progress.tier = 'nope';
  badTier.progress.peakTier = 'nope';
  assert.ok(arch.validateArchive(badTier, cfg).errors.some((e) => e.path === 'progress.tier'));
  const badRecent = newArchive();
  badRecent.record.recent = new Array(101).fill({ battleId: 'b' });
  assert.ok(arch.validateArchive(badRecent, cfg).errors.some((e) => e.path === 'record.recent'));
  const badStats = newArchive();
  badStats.record.stats.attack = {};
  assert.ok(arch.validateArchive(badStats, cfg).errors.some((e) => e.path === 'record.stats.attack'));
  const badSlotsArr = newArchive();
  badSlotsArr.configs.slots = 'nope';
  assert.ok(arch.validateArchive(badSlotsArr, cfg).errors.some((e) => e.path === 'configs.slots'));
  const slotNoId = newArchive();
  slotNoId.configs.slots.push({ name: 'x' });
  assert.ok(arch.validateArchive(slotNoId, cfg).errors.some((e) => e.message.includes('缺少 slotId')));
  // 检查点重建档案：允许无槽（不变量放宽，§6.7 的"检查点精度"）
  const rebuilt = newArchive();
  rebuilt.configs.slots = [];
  rebuilt.flags.rebuiltFromCheckpoint = true;
  assert.equal(arch.validateArchive(rebuilt, cfg).ok, true);
  const broken = newArchive();
  broken.rating.points = -1;
  assert.throws(() => arch.assertArchiveInvariants(broken, cfg), (e) => e.code === 'store_inconsistent');
});

test('ARC-3 槽位纯操作：上限/可删性/激活同步', () => {
  const a = newArchive();
  arch.checkSlotLimit(a, DEFAULT_SERVICE_CONFIG);
  a.configs.slots.push(arch.createSlot({ slotId: 'slot2', snapshot: { hash: SHA_B } }));
  a.configs.slots.push(arch.createSlot({ slotId: 'slot3', snapshot: { hash: SHA_B } }));
  assert.throws(() => arch.checkSlotLimit(a, DEFAULT_SERVICE_CONFIG), (e) => e.code === 'slot_limit');
  assert.throws(() => arch.checkSlotDeletable(a, 'slot1'), (e) => e.code === 'slot_locked');
  assert.throws(() => arch.checkSlotDeletable(a, 'slot9'), (e) => e.code === 'slot_not_found');
  a.configs.activeSlotId = 'slot2';
  assert.throws(() => arch.checkSlotDeletable(a, 'slot2'), (e) => e.code === 'slot_locked');
  assert.equal(arch.checkSlotDeletable(a, 'slot3').slotId, 'slot3');
  a.configs.slots = a.configs.slots.filter((s) => s.slotId !== 'slot3');
  a.configs.activeSlotId = 'slot1';
  assert.equal(arch.syncActiveSnapshot(a), SHA_A);
  assert.equal(a.configs.activeSnapshotHash, SHA_A);
  assert.equal(arch.findSlot(a, 'nope'), null);
  a.configs.slots = [];
  assert.equal(arch.syncActiveSnapshot(a), null, '无槽 → activeSnapshotHash 为 null');
});

test('ARC-4 迁移：v0 → v1 补齐字段并记 store.migrate；更高版本拒绝启动', () => {
  const events = [];
  const logger = { info: (ch, ev, data) => events.push({ ch, ev, data }), warn: () => {}, debug: () => {}, trace: () => {}, error: () => {}, log: () => {} };
  const v0 = { playerId: PID1, nickname: 'legacy', rating: { points: 77 } };
  const res = arch.migrateArchive(v0, { logger });
  assert.equal(res.migrated, true);
  assert.equal(res.from, 0);
  assert.equal(res.to, 1);
  assert.equal(res.archive.archiveVersion, 1);
  assert.equal(res.archive.rating.points, 77, '保留 v0 已有字段');
  assert.equal(res.archive.progress.tier, 'common', '补齐缺失字段');
  assert.equal(events[0].ev, 'store.migrate');
  assert.equal(events[0].ch, 'store');
  const same = arch.migrateArchive(newArchive(), { logger });
  assert.equal(same.migrated, false);
  assert.throws(() => arch.migrateArchive({ ...newArchive(), archiveVersion: 2 }, { logger }),
    (e) => e.code === 'store_version_unsupported' && e.fatal === true);
  assert.equal(typeof arch.MIGRATIONS[1], 'function');
  assert.deepEqual(arch.applyDefaults({ a: 1, o: { x: 1 } }, { a: 2, o: { y: 2 }, b: 3 }), { a: 2, o: { x: 1, y: 2 }, b: 3 });
});

test('ARC-5 applyRecordToArchive：账号/密码/封禁/昵称/池/批次/晋升', async () => {
  const c = ctx();
  // account.created 到空壳（含默认槽 + 从快照库回填 loadout）
  const shell = arch.createArchiveShell(PID1, 0);
  const created = await arch.applyRecordToArchive(shell, {
    seq: 1, type: 'account.created', at: 1100, playerId: PID1, publicId: 'u_11111111', nickname: 'n1',
    auth: { algo: 'scrypt', hash: 'h' }, flags: { unverifiedLoadout: true },
    slot: { slotId: 'slot1', name: '默认', snapshotHash: SHA_A, configHash: 'sha256:c1', versions: { engine: '3.0.0', data: 'b25' } },
  }, PID1, c);
  assert.equal(created.changed, true);
  assert.equal(shell.nickname, 'n1');
  assert.equal(shell.auth.hash, 'h');
  assert.equal(shell.configs.slots.length, 1);
  assert.deepEqual(shell.configs.slots[0].loadout, { role: 'a', skills: [], ai: null }, '从快照库回填 loadout（journal 不存正文）');
  assert.equal(shell.configs.slots[0].snapshot.hash, SHA_A);
  assert.equal(shell.configs.slots[0].isDefault, true);
  assert.equal(shell.configs.activeSlotId, 'slot1');
  // 再次应用同一记录 → 无实质变化（幂等由 appliedSeq 保证，这里验证字段级幂等）
  const again = await arch.applyRecordToArchive(shell, {
    seq: 1, type: 'account.created', at: 1100, playerId: PID1, nickname: 'n1',
    slot: { slotId: 'slot1', snapshotHash: SHA_A, versions: { engine: '3.0.0', data: 'b25' } },
  }, PID1, c);
  assert.equal(shell.configs.slots.length, 1);

  // 密码 / 封禁 / 解封
  assert.equal((await arch.applyRecordToArchive(shell, { seq: 2, type: 'account.password.changed', at: 2, playerId: PID1, auth: { hash: 'h2' } }, PID1, c)).changed, true);
  assert.equal(shell.auth.hash, 'h2');
  assert.equal((await arch.applyRecordToArchive(shell, { seq: 3, type: 'account.password.changed', at: 3, playerId: PID1 }, PID1, c)).changed, false);
  await arch.applyRecordToArchive(shell, { seq: 4, type: 'account.banned', at: 4, playerId: PID1, reason: 'cheat' }, PID1, c);
  assert.equal(shell.flags.banned, true);
  assert.equal(shell.flags.banReason, 'cheat');
  await arch.applyRecordToArchive(shell, { seq: 5, type: 'account.unbanned', at: 5, playerId: PID1 }, PID1, c);
  assert.equal(shell.flags.banned, false);
  assert.equal(shell.flags.banReason, null);

  // 昵称 / 池
  await arch.applyRecordToArchive(shell, { seq: 6, type: 'player.nickname.changed', at: 6, playerId: PID1, nickname: 'n2' }, PID1, c);
  assert.equal(shell.nickname, 'n2');
  assert.equal((await arch.applyRecordToArchive(shell, { seq: 7, type: 'player.nickname.changed', at: 7, playerId: PID1 }, PID1, c)).changed, false);
  await arch.applyRecordToArchive(shell, { seq: 8, type: 'player.pool.changed', at: 8, playerId: PID1, inPool: false }, PID1, c);
  assert.equal(shell.pool.inPool, false);
  await arch.applyRecordToArchive(shell, { seq: 9, type: 'player.pool.changed', at: 9, playerId: PID1, inPool: true }, PID1, c);
  assert.equal(shell.pool.inPool, true);
  assert.ok(Number.isInteger(shell.pool.enteredAt));

  // 排位批次 / 晋升
  await arch.applyRecordToArchive(shell, { seq: 10, type: 'ranked.batch', at: 10, playerId: PID1, batchId: 'bt1' }, PID1, c);
  assert.equal(shell.progress.batchesPlayed, 1);
  assert.equal(shell.progress.lastBatchId, 'bt1');
  await arch.applyRecordToArchive(shell, { seq: 11, type: 'ranked.promoted', at: 11, playerId: PID1, tierBefore: 'common', tierAfter: 'rare' }, PID1, c);
  assert.equal(shell.progress.tier, 'rare');
  assert.equal(shell.progress.peakTier, 'rare');
  assert.equal(shell.progress.batchesPromoted, 1);
  assert.equal((await arch.applyRecordToArchive(shell, { seq: 12, type: 'ranked.promoted', at: 12, playerId: PID1, tierAfter: 'bogus' }, PID1, c)).changed, false);

  // 未登记类型（防御分支）
  const warns = [];
  const c2 = ctx({ logger: { warn: (ch, ev) => warns.push(ev), debug: () => {}, info: () => {}, error: () => {}, log: () => {}, trace: () => {} } });
  shell.record.appliedSeq = 0;
  const unk = await arch.applyRecordToArchive(shell, { seq: 13, type: 'account.created', at: 13, playerId: PID1, bogus: true }, PID1, c2);
  assert.equal(typeof unk.changed, 'boolean');
});

test('ARC-6 配置记录：create/update/delete/激活/乐观字段/缺槽保护', async () => {
  const c = ctx();
  const a = newArchive(PID1);
  a.record.appliedSeq = 0;
  // 新建槽（create:true）
  await arch.applyRecordToArchive(a, {
    seq: 2, type: 'player.config.saved', at: 2000, playerId: PID1, slotId: 'slot2', name: '二号',
    snapshotHash: SHA_B, configHash: 'sha256:c2', create: true, activate: true,
    versions: { engine: '3.0.0', data: 'b25' },
  }, PID1, c);
  assert.equal(a.configs.slots.length, 2);
  assert.equal(a.configs.activeSlotId, 'slot2');
  assert.equal(a.configs.activeSnapshotHash, SHA_B);
  assert.equal(a.configs.slots[1].loadout, null, '快照库无正文 → loadout 为 null（可从快照回填）');
  // 更新既有槽（保留原 loadout 若快照缺失）+ 仓库镜像已验证
  await arch.applyRecordToArchive(a, {
    seq: 3, type: 'player.config.saved', at: 3000, playerId: PID1, slotId: 'slot1', name: '改',
    snapshotHash: SHA_A, configHash: 'sha256:c1', warehouseVerified: true,
    versions: { engine: '3.0.0', data: 'b25' },
  }, PID1, c);
  assert.equal(arch.findSlot(a, 'slot1').name, '改');
  assert.equal(arch.findSlot(a, 'slot1').updatedAt, 3000);
  assert.deepEqual(arch.findSlot(a, 'slot1').loadout, { role: 'a', skills: [], ai: null });
  assert.equal(a.flags.unverifiedLoadout, false);
  // 指向不存在且未标 create → 记 store.error 且不改变
  const errs = [];
  const c3 = ctx({ logger: { warn: (ch, ev) => errs.push(ev), debug: () => {}, info: () => {}, error: () => {}, log: () => {}, trace: () => {} } });
  const miss = await arch.applyRecordToArchive(a, { seq: 4, type: 'player.config.saved', at: 4000, playerId: PID1, slotId: 'slotX' }, PID1, c3);
  assert.equal(miss.changed, false);
  assert.deepEqual(errs, ['store.error']);
  // 超限创建 → slot_limit
  await arch.applyRecordToArchive(a, { seq: 5, type: 'player.config.saved', at: 5, playerId: PID1, slotId: 'slot3', snapshotHash: SHA_B, create: true }, PID1, c);
  await assert.rejects(() => arch.applyRecordToArchive(a, { seq: 6, type: 'player.config.saved', at: 6, playerId: PID1, slotId: 'slot4', snapshotHash: SHA_B, create: true }, PID1, c),
    (e) => e.code === 'slot_limit');
  // 删除受保护槽 → slot_locked（fatal）
  await assert.rejects(() => arch.applyRecordToArchive(a, { seq: 7, type: 'player.config.saved', at: 7, playerId: PID1, slotId: 'slot1', deleted: true }, PID1, c),
    (e) => e.code === 'slot_locked' && e.fatal === true);
  // 删除普通槽
  const del = await arch.applyRecordToArchive(a, { seq: 8, type: 'player.config.saved', at: 8, playerId: PID1, slotId: 'slot3', deleted: true }, PID1, c);
  assert.equal(del.changed, true);
  assert.equal(arch.findSlot(a, 'slot3'), null);
  const delMissing = await arch.applyRecordToArchive(a, { seq: 9, type: 'player.config.saved', at: 9, playerId: PID1, slotId: 'slotY', deleted: true }, PID1, c);
  assert.equal(delMissing.changed, false);
});

test('ARC-7 battle.recorded：攻守分桶/未读/被抽计数/对手窗口/幂等/排位与 bot 规则', async () => {
  const c = ctx();
  const a = newArchive(PID1);
  const b = newArchive(PID2, { publicId: 'u_22222222' });
  const rec = {
    seq: 20, type: 'battle.recorded', at: 9000, battleId: 'b_x', mode: 'quick', seed: 7,
    p1: { playerId: PID1, publicId: 'u_11111111', side: 'p1', role: 'attacker', snapshotHash: SHA_A, pointsBefore: 0, pointsAfter: 14, result: 'win', tierBefore: 'common', tierAfter: 'common' },
    p2: { playerId: PID2, publicId: 'u_22222222', side: 'p2', role: 'defender', snapshotHash: SHA_B, pointsBefore: 5, pointsAfter: 5, result: 'loss', tierBefore: 'common', tierAfter: 'common' },
    verdict: { winner: 'p1', reason: 'hero_dead', ticks: 23 },
  };
  const r1 = arch.applyRecordToArchive(a, rec, PID1, c);
  assert.equal((await r1).changed, true);
  assert.equal(a.record.stats.attack.wins, 1);
  assert.equal(a.record.stats.defense.losses, 0);
  assert.equal(a.record.unread.attack, 1);
  assert.equal(a.rating.points, 14);
  assert.equal(a.rating.games, 1);
  assert.equal(a.rating.wins, 1);
  assert.equal(a.rating.lastBattleAt, 9000);
  assert.equal(a.record.recent.length, 1);
  assert.deepEqual(a.record.recent[0].opponentPublicId, 'u_22222222');
  assert.equal(a.record.recent[0].pointsDelta, 14);
  assert.equal(a.record.recent[0].seen, false);
  assert.equal(a.pool.lastOpponentAt[PID2], 9000);
  assert.equal(arch.opponentCooldownOk(a, PID2, 24, 9000 + 1000), false);
  assert.equal(arch.opponentCooldownOk(a, PID2, 24, 9000 + 25 * 3600000), true);
  assert.equal(arch.opponentCooldownOk(a, 'pl_9999999999999999', 24, 9000), true);
  assert.equal(arch.opponentCooldownOk(a, PID2, 0, 9000), true);
  assert.deepEqual([...arch.recentOpponents(a, 24, 9000 + 1000)], [PID2]);

  const r2 = await arch.applyRecordToArchive(a, rec, PID1, c);
  assert.equal(r2.changed, false, '同 battleId 第二次 → 不入列（第二道幂等保险）');
  assert.equal(a.record.recent.length, 1);

  // 防守方视角
  await arch.applyRecordToArchive(b, rec, PID2, c);
  assert.equal(b.record.stats.defense.losses, 1);
  assert.equal(b.record.unread.defense, 1);
  assert.equal(b.pool.drawnCount, 1);
  assert.equal(b.pool.lastDrawnAt, 9000);
  assert.equal(b.rating.points, 5, '快速对战防守方按记录扣分（此处 p2After=5=before）');
  assert.equal(b.record.recent[0].role, 'defender');
  assert.equal(b.record.recent[0].mySide, 'p2');

  // 排位：不改积分/段位（由 settleBattle 规范化保证；此处直接给越权数值验证 archive 层不越权改段位）
  const ranked = {
    ...rec, seq: 21, battleId: 'b_r', mode: 'ranked', p1: { ...rec.p1, pointsAfter: 999, tierAfter: 'mythic' },
  };
  const before = a.rating.points;
  await arch.applyRecordToArchive(a, ranked, PID1, c);
  assert.equal(a.rating.games, 1, '排位不计入积分轨道场次');
  assert.equal(a.rating.points, before, '排位不改积分');
  assert.equal(a.progress.tier, 'common', '排位战斗记录不改段位（只由 ranked.promoted 驱动）');
  assert.equal(a.record.stats.attack.wins, 2);

  // bot：只累加战绩
  const bot = arch.createArchive({ playerId: 'pl_3333333333333333', at: 1, isBot: true, tier: 'rare', points: 500, nickname: 'bot' });
  bot.configs.slots.push(arch.createSlot({ slotId: 'slot1', snapshot: { hash: SHA_A } }));
  bot.configs.activeSlotId = 'slot1';
  bot.configs.activeSnapshotHash = SHA_A;
  await arch.applyRecordToArchive(bot, { ...rec, seq: 30, battleId: 'b_bot', mode: 'quick', p1: { ...rec.p1, playerId: bot.playerId, pointsAfter: 1500 } }, bot.playerId, c);
  assert.equal(bot.rating.points, 500);
  assert.equal(bot.progress.tier, 'rare');
  assert.equal(bot.record.stats.attack.wins, 1);
  // 非参与者 → 不改变
  const outsider = newArchive('pl_4444444444444444');
  const notMine = await arch.applyRecordToArchive(outsider, { ...rec, seq: 31, battleId: 'b_other' }, outsider.playerId, c);
  assert.equal(notMine.changed, false);
  // recent 环形上限（默认 100）
  const many = newArchive('pl_5555555555555555');
  for (let i = 0; i < 105; i += 1) {
    await arch.applyRecordToArchive(many, {
      ...rec, seq: 100 + i, battleId: `b_${i}`, p1: { ...rec.p1, playerId: many.playerId },
    }, many.playerId, c);
  }
  assert.equal(many.record.recent.length, 100);
  assert.equal(many.rating.games, 105);
});

test('ARC-8 aggregateRecords + checkpoint 应用（检查点精度重建）', async () => {
  const records = [
    { seq: 1, type: 'account.created', at: 1, playerId: PID1, publicId: 'u_11111111', nickname: 'n1', auth: { hash: 'h' }, createdAt: 1 },
    { seq: 2, type: 'admin.bot.injected', at: 2, playerId: PID2, publicId: 'u_22222222', nickname: 'bot', tier: 'epic', points: 300 },
    {
      seq: 3, type: 'battle.recorded', at: 3, battleId: 'b1', mode: 'quick', seed: 1,
      p1: { playerId: PID1, side: 'p1', role: 'attacker', pointsAfter: 20, result: 'win', tierAfter: 'common' },
      p2: { playerId: PID2, side: 'p2', role: 'defender', pointsAfter: 300, result: 'loss', tierAfter: 'epic' },
    },
    { seq: 4, type: 'ranked.promoted', at: 4, playerId: PID1, tierBefore: 'common', tierAfter: 'rare' },
    { seq: 5, type: 'player.nickname.changed', at: 5, playerId: PID1, nickname: 'n2' },
  ];
  const per = arch.aggregateRecords(records);
  assert.equal(per[PID1].quickGames, 1);
  assert.equal(per[PID1].quickWins, 1);
  assert.equal(per[PID1].points, 20);
  assert.equal(per[PID1].tier, 'rare');
  assert.equal(per[PID1].nickname, 'n1');
  assert.equal(per[PID1].stats.attack.wins, 1);
  assert.equal(per[PID2].isBot, true);
  assert.equal(per[PID2].drawnCount, 1);
  assert.equal(per[PID2].stats.defense.losses, 1);
  assert.equal(arch.aggregateRecords([])[PID1], undefined);
  const c = ctx();
  const shell = arch.createArchiveShell(PID1, 0);
  const res = await arch.applyRecordToArchive(shell, { seq: 10, type: 'checkpoint', at: 10, perPlayer: per }, PID1, c);
  assert.equal(res.changed, true);
  assert.equal(shell.flags.rebuiltFromCheckpoint, true);
  assert.equal(shell.rating.points, 20);
  assert.equal(shell.rating.games, 1);
  assert.equal(shell.progress.tier, 'rare');
  assert.equal(shell.record.stats.attack.wins, 1);
  assert.equal(shell.nickname, 'n1');
  // 已有档案 → 检查点不覆盖
  const existing = newArchive(PID1);
  existing.record.appliedSeq = 5;
  const noChange = await arch.applyRecordToArchive(existing, { seq: 11, type: 'checkpoint', perPlayer: per }, PID1, c);
  assert.equal(noChange.changed, false);
  // 检查点里没有该玩家
  const miss = await arch.applyRecordToArchive(arch.createArchiveShell(PID2, 0), { seq: 12, type: 'checkpoint', perPlayer: {} }, PID2, c);
  assert.equal(miss.changed, false);
});

test('ARC-9 视图：recentView/unreadOf/markSeen/summaryOf/defenseSummaryOf', async () => {
  const c = ctx();
  const a = newArchive(PID1);
  const mk = (seq, role, result) => ({
    seq, type: 'battle.recorded', at: seq, battleId: `b_${seq}`, mode: 'quick', seed: seq,
    p1: role === 'attacker'
      ? { playerId: PID1, publicId: 'u_11111111', side: 'p1', role: 'attacker', pointsBefore: 0, pointsAfter: 5, result, tierBefore: 'common', tierAfter: 'common' }
      : { playerId: PID2, publicId: 'u_22222222', side: 'p1', role: 'attacker', pointsBefore: 0, pointsAfter: 0, result: 'win', tierBefore: 'common', tierAfter: 'common' },
    p2: role === 'defender'
      ? { playerId: PID1, publicId: 'u_11111111', side: 'p2', role: 'defender', pointsBefore: 0, pointsAfter: 0, result, tierBefore: 'common', tierAfter: 'common' }
      : { playerId: PID2, publicId: 'u_22222222', side: 'p2', role: 'defender', pointsBefore: 0, pointsAfter: 0, result: 'loss', tierBefore: 'common', tierAfter: 'common' },
    verdict: { winner: 'p1', reason: 'timeout', ticks: 40 },
  });
  await arch.applyRecordToArchive(a, mk(10, 'attacker', 'win'), PID1, c);
  await arch.applyRecordToArchive(a, mk(11, 'defender', 'loss'), PID1, c);
  await arch.applyRecordToArchive(a, mk(12, 'defender', 'win'), PID1, c);
  assert.deepEqual(arch.unreadOf(a), { attack: 1, defense: 2, fromSeq: 0 });
  const all = arch.recentView(a, { since: 0, limit: 10 });
  assert.equal(all.length, 3);
  assert.equal(all[0].seq, 10);
  assert.equal(all[0].seen, false);
  assert.equal(arch.recentView(a, { role: 'defense' }).length, 2);
  assert.equal(arch.recentView(a, { role: 'attack' }).length, 1);
  assert.equal(arch.recentView(a, { since: 10 }).length, 2, 'since 为开区间（严格大于）');
  assert.equal(arch.recentView(a, { since: 11, limit: 1 })[0].seq, 12);
  const seen = arch.markSeen(a, 11);
  assert.equal(seen.changed, true);
  assert.deepEqual(arch.unreadOf(a), { attack: 0, defense: 1, fromSeq: 11 });
  assert.equal(a.record.recent[0].seen, true);
  assert.equal(a.record.recent[1].seen, true);
  assert.equal(a.record.recent[2].seen, false);
  assert.equal(arch.markSeen(a, 11).changed, false, '游标只前进');
  arch.markSeen(a, 99);
  assert.deepEqual(arch.unreadOf(a), { attack: 0, defense: 0, fromSeq: 99 });
  const summary = arch.summaryOf(a);
  assert.equal(summary.publicId, 'u_11111111');
  assert.equal(summary.slots.length, 1);
  assert.equal(summary.activeSlotName, '默认配置');
  assert.equal(summary.record.stats.attack.wins, 1);
  assert.equal(summary.record.stats.defense.wins, 1);
  assert.equal(summary.record.stats.defense.losses, 1);
  assert.equal(summary.pool.drawnCount, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'playerId'), false);
  const def = arch.defenseSummaryOf(a, { limit: 1 });
  assert.equal(def.drawnCount, 2);
  assert.equal(def.unread, 0);
  assert.equal(def.recent.length, 1, 'limit 截断（取最新）');
  assert.equal(def.recent[0].battleId, 'b_12');
  const defAll = arch.defenseSummaryOf(a);
  assert.equal(defAll.recent.length, 2);
  assert.equal(defAll.recent[0].seen, true);
});

test('ARC-10 validateRecord/playersOfRecord：类型白名单与参与者解析', () => {
  assert.throws(() => arch.validateRecord(null), (e) => e.code === 'bad_request');
  assert.throws(() => arch.validateRecord({ type: 'account.created' }), (e) => e.code === 'bad_request');
  assert.throws(() => arch.validateRecord({ seq: 1, type: 'nope' }), (e) => e.code === 'bad_request');
  assert.throws(() => arch.validateRecord({ seq: 1, type: 'battle.recorded' }), (e) => e.code === 'bad_request');
  const ok = { seq: 1, type: 'battle.recorded', battleId: 'b_1', p1: { playerId: PID1 }, p2: { playerId: PID2 } };
  assert.equal(arch.validateRecord(ok), ok);
  assert.deepEqual(arch.playersOfRecord(ok), [PID1, PID2]);
  assert.deepEqual(arch.playersOfRecord({ type: 'battle.recorded', p1: { playerId: PID1 }, p2: { playerId: PID1 } }), [PID1]);
  assert.deepEqual(arch.playersOfRecord({ type: 'player.pool.changed', playerId: PID1 }), [PID1]);
  assert.deepEqual(arch.playersOfRecord({ type: 'checkpoint', perPlayer: { [PID1]: {}, [PID2]: {} } }), [PID1, PID2]);
  assert.deepEqual(arch.playersOfRecord({ type: 'player.pool.changed' }), []);
  assert.deepEqual(arch.playersOfRecord(null), []);
  assert.ok(arch.RECORD_TYPES.includes('battle.recorded'));
  assert.equal(arch.PLAYER_ID_RE.test(PID1), true);
  assert.equal(arch.PUBLIC_ID_RE.test('u_11111111'), true);
  assert.equal(arch.USERNAME_RE.test('a-b_c'), true);
  assert.match(arch.randomHex(2), /^[0-9a-f]{4}$/);
  assert.equal(arch.RECORD_VERSION, 1);
  assert.deepEqual(arch.TIERS, ['common', 'rare', 'epic', 'legendary', 'mythic']);
});
