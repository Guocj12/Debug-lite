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

test('T-AP-1 POST /ranked/run：10 场统计 + seed 回带 + 平局不计胜', async () => {
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'POST', '/api/v1/ranked/run', {
      loadout: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic',
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.matches, 10);
    assert.equal(r.body.data.results.length, 10);
    assert.equal(r.body.data.seed, 20260913);
    assert.equal(r.body.data.wins + r.body.data.draws + r.body.data.losses + r.body.data.invalids, 10);
    assert.equal(typeof r.body.data.promoted, 'boolean');
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