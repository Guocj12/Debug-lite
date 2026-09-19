'use strict';
/* tests/api/api-leaderboard.test.js —— P7-4（B32）排行榜：GET /leaderboard
 *
 * 契约：docs/systems/11-account-store.md §8.6（排序与 scope）/§10.1（端点总表：无需鉴权）
 * 覆盖：正例（global / tier:common 排序、字段、不暴露 playerId）+ 负例（limit 越界 400、
 *      scope 非法 400 bad_scope）+ 无鉴权可访问。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');

// 用真实档案 + 手工 journal 记录构造积分梯度（apply 会落 rating.points，D-133）
// 注意：battleId = hash(batchId|matchIndex|seed|p1快照|p2快照)，**不含 playerId**；三名玩家的默认配置快照
//   内容相同 → 必须用不同 seed，否则会被内容寻址判定为同一场（幂等 duplicate，不落账）。
async function settlePts(s, winner, loser, pointsAfter, seed) {
  const w = await h.activeSlotOf(s.store, winner.playerId);
  const l = await h.activeSlotOf(s.store, loser.playerId);
  const before = w.archive.rating.points;
  const res = await h.settleRecord(s.store, {
    mode: 'quick',
    seed,
    at: Date.now(),
    p1: {
      playerId: winner.playerId, publicId: w.archive.publicId, role: 'attacker',
      snapshotHash: w.snapshotHash, configHash: w.configHash,
      pointsBefore: before, pointsAfter, result: 'win', tierBefore: 'common', tierAfter: 'common',
    },
    p2: {
      playerId: loser.playerId, publicId: l.archive.publicId, role: 'defender',
      snapshotHash: l.snapshotHash, configHash: l.configHash,
      pointsBefore: l.archive.rating.points, pointsAfter: l.archive.rating.points,
      result: 'loss', tierBefore: 'common', tierAfter: 'common',
    },
    verdict: { winner: 'p1', reason: 'hero_dead', ticks: 20 },
    versions: { engine: s.store.versions.engine, data: s.store.versions.data },
  });
}

test('LB-1 排行榜：按积分降序 + 字段完整 + 不暴露 playerId + 无需鉴权', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lba'));
    const b = await h.register(s.port, h.uniqueName('lbb'));
    const c = await h.register(s.port, h.uniqueName('lbc'));
    const aId = await h.playerIdByPublicId(s.store, a.publicId);
    const bId = await h.playerIdByPublicId(s.store, b.publicId);
    const cId = await h.playerIdByPublicId(s.store, c.publicId);
    await settlePts(s, { playerId: aId }, { playerId: bId }, 114, 9001);
    await settlePts(s, { playerId: aId }, { playerId: cId }, 150, 9002);
    await settlePts(s, { playerId: bId }, { playerId: cId }, 60, 9003);
    const r = await h.request(s.port, 'GET', '/api/v1/leaderboard');
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.data.scope, 'global');
    assert.equal(r.body.data.limit, 50);
    const rows = r.body.data.rows;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((x) => x.rank), [1, 2, 3]);
    assert.deepEqual(rows.map((x) => x.points), [150, 60, 0], '按 points 降序（§8.6）');
    assert.equal(rows[0].publicId, a.publicId);
    assert.equal(rows[0].nickname, a.nickname);
    assert.equal(rows[0].tier, 'common');
    assert.ok(!r.raw.includes('pl_'), '排行榜只给 publicId（§8.6）');
    // limit 截断
    const one = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=1');
    assert.equal(one.status, 200);
    assert.equal(one.body.data.rows.length, 1);
    assert.equal(one.body.data.rows[0].points, 150);
    // tier scope（全部 common）
    const tier = await h.request(s.port, 'GET', '/api/v1/leaderboard?scope=tier:common');
    assert.equal(tier.status, 200);
    assert.equal(tier.body.data.scope, 'tier:common');
    assert.equal(tier.body.data.rows.length, 3);
    const emptyTier = await h.request(s.port, 'GET', '/api/v1/leaderboard?scope=tier:mythic');
    assert.equal(emptyTier.status, 200);
    assert.equal(emptyTier.body.data.rows.length, 0, '无该段位玩家 → 空榜');
  });
});

test('LB-2 排行榜负例：limit 越界 400 bad_request / scope 非法 400 bad_scope / 未装配存储 503', async () => {
  await h.withServer(null, async (s) => {
    const zero = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=0');
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, 'bad_request');
    const huge = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=999');
    assert.equal(huge.status, 400);
    const nan = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=abc');
    assert.equal(nan.status, 400);
    const badScope = await h.request(s.port, 'GET', '/api/v1/leaderboard?scope=nope');
    assert.equal(badScope.status, 400);
    assert.equal(badScope.body.error.code, 'bad_scope');
    const badTier = await h.request(s.port, 'GET', '/api/v1/leaderboard?scope=tier:platinum');
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_scope');
  });
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'GET', '/api/v1/leaderboard');
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'store_unavailable');
  }, { server: { enableStore: false, dataDir: undefined, env: {} } });
});
