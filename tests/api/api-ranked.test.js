'use strict';
// B24 /api/v1/ranked/run 端点测试 —— T-AP-1/2/3；契约 docs/interfaces.md §2。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const LD = require('../fixtures/loadout-ok.json');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function withServer(t, fn) {
  const logger = createLogger({ level: 'debug', ringSize: 3000 });
  const s = await serverMod.start({ logger });
  try {
    await fn({ port: s.port, logger });
  } finally {
    await s.close();
  }
}

test('T-AP-1a POST /ranked/run：真实池 10 场全平（requested=10/matches=10/shortfall=0）+ seed 回带', async () => {
  await withServer(null, async ({ port }) => {
    const h = require('../helpers/ranked.js');
    // 10 个**真实构造**的对手档案快照（wait-only → 全平局），每个都带 playerId 溯源
    const pool = Array.from({ length: 10 }, (_, i) => {
      const x = h.waitOnly(LD.loadout, `w${i}`);
      x.playerId = h.makePlayerId(i + 1);
      return x;
    });
    const r = await request(port, 'POST', '/api/v1/ranked/run', {
      loadout: LD.loadout, warehouse: LD.warehouse, pool, seed: 20260913, tier: 'mythic',
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.requested, 10);
    assert.equal(r.body.data.matches, 10, '池里 10 个真实对手 → 打满 10 场');
    assert.equal(r.body.data.shortfall, 0);
    assert.equal(r.body.data.results.length, 10);
    assert.equal(r.body.data.seed, 20260913, 'seed 回带');
    assert.equal(r.body.data.wins + r.body.data.draws + r.body.data.losses + r.body.data.invalids, 10);
    assert.equal(r.body.data.wins, 0, '双方 wait-only → 全平局（平局不计胜）');
    assert.equal(typeof r.body.data.promoted, 'boolean');
    // HTTP 层当前只回带场次与胜负（不回带对手标识，见 QU-3 的"不暴露 playerId"口径）→
    // 这一段让位于 HTTP 契约：真实玩家可追溯性在模块层用同一份池逐场断言（见下）
    assert.equal(r.body.data.matches + r.body.data.shortfall, r.body.data.requested);
    // 模块层（同一份真实池）：每场对手都能追溯到真实 playerId
    const ranked = require('../../server/ranked.js');
    const direct = ranked.runRankedBattle({ loadout: LD.loadout, warehouse: LD.warehouse, pool, seed: 20260913, tier: 'mythic' });
    const poolIds = new Set(pool.map((x) => x.playerId));
    assert.ok(direct.data.results.every((m) => poolIds.has(m.opponentPlayerId)), '每场对手都是池中的真实 playerId');
    assert.equal(new Set(direct.data.results.map((m) => m.opponentPlayerId)).size, 10, '批次内 10 个互不相同的真实对手');
  });
});

test('T-AP-1b POST /ranked/run：无池 → 少打并如实回报 shortfall（禁止 bot 凑 10 场）', async () => {
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'POST', '/api/v1/ranked/run', {
      loadout: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic',
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.requested, 10);
    assert.equal(r.body.data.matches, 0, '无真实对手 → 一场都不打（不注入占位 bot）');
    assert.equal(r.body.data.shortfall, 10);
    assert.equal(r.body.data.results.length, 0);
    assert.equal(r.body.data.matches + r.body.data.shortfall, r.body.data.requested, 'matches + shortfall === requested');
    assert.equal(r.body.data.wins + r.body.data.draws + r.body.data.losses + r.body.data.invalids, r.body.data.matches);
  });
});

test('T-AP-3/T-AP-2 错误路径：409 no_loadout/loadout_invalid；400 bad_seed/bad_tier/bad_json', async () => {
  await withServer(null, async ({ port }) => {
    const noLd = await request(port, 'POST', '/api/v1/ranked/run', {});
    assert.equal(noLd.status, 409);
    assert.equal(noLd.body.error.code, 'no_loadout');
    const bad = JSON.parse(JSON.stringify(LD.loadout));
    bad.skills = bad.skills.slice(0, 2);
    const inv = await request(port, 'POST', '/api/v1/ranked/run', { loadout: bad, warehouse: LD.warehouse });
    assert.equal(inv.status, 409);
    assert.equal(inv.body.error.code, 'loadout_invalid');
    const badSeed = await request(port, 'POST', '/api/v1/ranked/run', { loadout: LD.loadout, warehouse: LD.warehouse, seed: 'x' });
    assert.equal(badSeed.status, 400);
    assert.equal(badSeed.body.error.code, 'bad_seed');
    const badTier = await request(port, 'POST', '/api/v1/ranked/run', { loadout: LD.loadout, tier: 'platinum' });
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');
    const bj = await request(port, 'POST', '/api/v1/ranked/run', '{nope');
    assert.equal(bj.status, 400);
    assert.equal(bj.body.error.code, 'bad_json');
    const badPool = await request(port, 'POST', '/api/v1/ranked/run', { loadout: LD.loadout, warehouse: LD.warehouse, pool: 'nope' });
    assert.equal(badPool.status, 400);
    assert.equal(badPool.body.error.code, 'bad_pool');
  });
});

test('B25 POST /ranked/promote：晋升/不晋升/顶段 409/参数 400', async () => {
  await withServer(null, async ({ port }) => {
    const ok = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'common', wins: 7 });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.data.tier, 'rare');
    assert.equal(ok.body.data.promoted, true);
    assert.equal(ok.body.data.reward, 'rare');
    const no = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'common', wins: 6 });
    assert.equal(no.status, 200);
    assert.equal(no.body.data.promoted, false);
    const max = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'mythic', wins: 7 });
    assert.equal(max.status, 409);
    assert.equal(max.body.error.code, 'already_max');
    const bt = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'platinum', wins: 7 });
    assert.equal(bt.status, 400);
    assert.equal(bt.body.error.code, 'bad_tier');
    const bw = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'common', wins: 'x' });
    assert.equal(bw.status, 400);
    assert.equal(bw.body.error.code, 'bad_wins');
    const bj = await request(port, 'POST', '/api/v1/ranked/promote', '{nope');
    assert.equal(bj.status, 400);
    assert.equal(bj.body.error.code, 'bad_json');
  });
});