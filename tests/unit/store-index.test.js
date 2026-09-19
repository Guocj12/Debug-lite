'use strict';
/* tests/unit/store-index.test.js —— 索引：加载/损坏重建/增量维护/排行榜排序（D-129 §5.6/§8.6/§6.4） */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const indexMod = require('../../server/store/index-file.js');
const archiveMod = require('../../server/store/archive.js');
const { nullLogger } = require('../../shared/log.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-index-'));
}

function archiveOf(playerId, publicId, nickname, tier, points, extra) {
  const arch = archiveMod.createArchive({
    playerId, publicId, nickname, at: 1000, auth: { algo: 'scrypt', hash: 'h' },
    slot: {
      slotId: 'slot1', name: '默认', loadout: { role: 1 }, at: 1000,
      snapshot: { hash: `sha256:${'a'.repeat(64)}`, engineVersion: '3.0.0', dataVersion: 'b25', configHash: 'sha256:c' },
    },
  });
  arch.progress.tier = tier;
  arch.progress.peakTier = tier;
  arch.rating.points = points;
  arch.rating.peakPoints = points;
  return Object.assign(arch, extra || {});
}

test('IDX-1 空索引与非法输入：load 返回 false 并保持空索引', () => {
  const idx = indexMod.createIndex({ logger: nullLogger });
  assert.equal(idx.isLoaded(), false);
  assert.equal(idx.load(null), false);
  assert.equal(idx.load({}), false);
  assert.equal(idx.load({ indexVersion: 99, players: {}, byTier: {} }), false);
  assert.equal(idx.load({ indexVersion: 1, players: [] }), false);
  assert.equal(idx.isLoaded(), false);
  assert.equal(idx.size(), 0);
  assert.deepEqual(idx.leaderboard({}), []);
  assert.equal(idx.rank('pl_1111111111111111'), null);
});

test('IDX-2 upsert/remove：byTier 随段位移动、条目字段、排行榜不暴露 playerId', () => {
  const idx = indexMod.createIndex({ logger: nullLogger });
  const a = archiveOf('pl_1111111111111111', 'u_11111111', 'A', 'common', 120);
  idx.upsert(a, 777);
  assert.equal(idx.size(), 1);
  assert.deepEqual(idx.byTier('common'), ['pl_1111111111111111']);
  const entry = idx.get('pl_1111111111111111');
  assert.equal(entry.publicId, 'u_11111111');
  assert.equal(entry.tier, 'common');
  assert.equal(entry.points, 120);
  assert.equal(entry.activeSnapshotHash, `sha256:${'a'.repeat(64)}`);
  assert.equal(entry.inPool, true);
  assert.equal(entry.isBot, false);
  assert.equal(entry.banned, false);
  assert.equal(entry.archiveMtime, 777);
  assert.equal(idx.has('pl_1111111111111111'), true);
  // 升段 → byTier 迁移
  a.progress.tier = 'rare';
  idx.upsert(a);
  assert.deepEqual(idx.byTier('common'), []);
  assert.deepEqual(idx.byTier('rare'), ['pl_1111111111111111']);
  assert.deepEqual(idx.byTier('bogus'), [], '未登记段位返回空表');
  // 幂等 upsert 不重复
  idx.upsert(a);
  assert.equal(idx.byTier('rare').length, 1);
  // remove
  assert.equal(idx.remove('pl_1111111111111111'), true);
  assert.equal(idx.remove('pl_1111111111111111'), false);
  assert.deepEqual(idx.byTier('rare'), []);
  assert.equal(idx.rank('pl_1111111111111111'), null);
});

test('IDX-3 排行榜排序：points 降序 → peakPoints 降序 → updatedAt 升序 → publicId（稳定）', () => {
  const idx = indexMod.createIndex({ logger: nullLogger });
  const mk = (id, pub, points, peak, updatedAt) => {
    const a = archiveOf(id, pub, pub, 'common', points);
    a.rating.peakPoints = peak;
    a.updatedAt = updatedAt;
    idx.upsert(a);
    return a;
  };
  mk('pl_0000000000000001', 'u_00000001', 100, 100, 5);
  mk('pl_0000000000000002', 'u_00000002', 100, 200, 9);
  mk('pl_0000000000000003', 'u_00000003', 100, 200, 3);
  mk('pl_0000000000000004', 'u_00000004', 150, 150, 9);
  const board = idx.leaderboard({ scope: 'global', limit: 10 });
  assert.deepEqual(board.map((e) => e.publicId), ['u_00000004', 'u_00000003', 'u_00000002', 'u_00000001']);
  assert.deepEqual(board.map((e) => e.rank), [1, 2, 3, 4]);
  assert.equal(board[0].tier, 'common');
  assert.equal(Object.prototype.hasOwnProperty.call(board[0], 'playerId'), false);
  // limit 与 scope
  assert.equal(idx.leaderboard({ scope: 'global', limit: 2 }).length, 2);
  assert.equal(idx.leaderboard({ scope: 'tier:common', limit: 2 })[0].publicId, 'u_00000004');
  assert.equal(idx.rank('pl_0000000000000004'), 1);
  assert.throws(() => idx.leaderboard({ scope: 'tier:nope' }), (e) => e.code === 'bad_scope');
  assert.throws(() => idx.leaderboard({ scope: 'globalx' }), (e) => e.code === 'bad_scope');
  // 封禁玩家不上榜，但仍在索引中
  const banned = archiveOf('pl_0000000000000005', 'u_00000005', 'E', 'common', 999);
  banned.flags.banned = true;
  idx.upsert(banned);
  assert.equal(idx.leaderboard({}).some((e) => e.publicId === 'u_00000005'), false);
  assert.equal(idx.get('pl_0000000000000005').banned, true);
});

test('IDX-4 save/load 往返 + seq 单调前进', () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'index.json');
    const idx = indexMod.createIndex({ logger: nullLogger });
    idx.upsert(archiveOf('pl_1111111111111111', 'u_11111111', 'A', 'rare', 137));
    idx.setSeq(41);
    idx.setSeq(7);
    assert.equal(idx.seq(), 41, 'seq 只前进不回退');
    idx.save(file);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.indexVersion, 1);
    assert.equal(raw.seq, 41);
    assert.equal(raw.players.pl_1111111111111111.points, 137);
    const idx2 = indexMod.createIndex({ logger: nullLogger });
    assert.equal(idx2.load(raw), true);
    assert.equal(idx2.isLoaded(), true);
    assert.equal(idx2.size(), 1);
    assert.equal(idx2.seq(), 41);
    assert.deepEqual(idx2.byTier('rare'), ['pl_1111111111111111']);
    assert.equal(idx2.leaderboard({})[0].points, 137);
    // 缺 leaderboard 数组的索引 → 容错归一化为 []；缺 byTier 视为损坏（返回 false）
    const loose = { indexVersion: 1, seq: 3, players: {}, byTier: { common: ['x', 7] }, leaderboard: 'bad' };
    const idx3 = indexMod.createIndex({ logger: nullLogger });
    assert.equal(idx3.load(loose), true);
    assert.deepEqual(idx3.byTier('common'), ['x'], '非字符串条目被过滤');
    assert.deepEqual(idx3.toJSON().leaderboard, []);
    assert.equal(idx3.load({ indexVersion: 1, seq: 3, players: {} }), false, '缺 byTier → 损坏（走重建分支）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('IDX-5 rebuild：清空重建 + builtAt/事件 + reset', () => {
  const events = [];
  const logger = { info: (ch, ev, msg, data) => events.push({ ch, ev, data }), warn: () => {}, debug: () => {}, trace: () => {}, error: () => {}, log: () => {} };
  const idx = indexMod.createIndex({ logger });
  idx.upsert(archiveOf('pl_1111111111111111', 'u_11111111', 'A', 'common', 1));
  idx.rebuild([
    archiveOf('pl_2222222222222222', 'u_22222222', 'B', 'epic', 400),
    archiveOf('pl_3333333333333333', 'u_33333333', 'C', 'common', 50),
  ], 123456);
  assert.equal(idx.size(), 2);
  assert.equal(idx.get('pl_1111111111111111'), null, 'rebuild 会清空旧数据');
  assert.deepEqual(idx.byTier('common'), ['pl_3333333333333333']);
  assert.equal(idx.toJSON().builtAt, 123456);
  assert.equal(events[0].ev, 'store.index.rebuild');
  idx.reset();
  assert.equal(idx.size(), 0);
  assert.equal(idx.seq(), 0);
  assert.equal(idx.stats().players, 0);
  assert.equal(typeof idx.playerIds()[0] === 'undefined', true);
  assert.equal(indexMod.entryOf(archiveOf('pl_4444444444444444', 'u_44444444', 'D')).publicId, 'u_44444444');
  assert.deepEqual(indexMod.emptyIndex().byTier, {});
  assert.ok(indexMod.TIERS.includes('mythic'));
});
