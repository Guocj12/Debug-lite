'use strict';
// B17 /api/v1/box 端点测试 —— T-AP-1/2/5；契约 docs/interfaces.md §2（信封与错误码）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');

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
  const logger = createLogger({ level: 'debug', ringSize: 2000 });
  const s = await serverMod.start({ logger });
  try {
    await fn({ port: s.port, logger });
  } finally {
    await s.close();
  }
}

function contentOf(item) {
  return { kind: item.kind, templateId: item.templateId, quality: item.quality };
}

test('T-AP-1 /api/v1/box 正常路径：信封 + 物品 + seed 回带 + api.* 日志', async () => {
  await withServer(null, async ({ port, logger }) => {
    const r = await request(port, 'POST', '/api/v1/box', { seed: 20260913, tier: 'rare', times: 5 });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.seed, 20260913);
    assert.equal(r.body.data.tier, 'rare');
    assert.equal(r.body.data.items.length, 5);
    for (const it of r.body.data.items) {
      assert.equal(typeof it.uid, 'string');
      assert.ok(['common', 'rare'].includes(it.quality), 'raree 上限');
    }
    assert.ok(logger.records.some((x) => x.event === 'api.req' && x.data.path === '/api/v1/box'));
    assert.ok(logger.records.some((x) => x.event === 'api.res' && x.data.path === '/api/v1/box'));
    assert.ok(logger.records.some((x) => x.event === 'items.generate'), 'items.generate 经服务端 logger');
  });
});

test('T-AP-5 /api/v1/box seed 显式化：缺省生成回带 + 携带复现（内容级）', async () => {
  await withServer(null, async ({ port }) => {
    const r1 = await request(port, 'POST', '/api/v1/box', { tier: 'epic', times: 6 });
    assert.equal(r1.status, 200);
    const seed = r1.body.data.seed;
    assert.ok(Number.isInteger(seed) && seed >= 1);
    const r2 = await request(port, 'POST', '/api/v1/box', { tier: 'epic', times: 6, seed });
    assert.deepEqual(
      r2.body.data.items.map(contentOf),
      r1.body.data.items.map(contentOf),
      '带 seed 复现同内容（uid 为进程级自增，不在复现断言范围）',
    );
  });
});

test('T-AP-2 /api/v1/box 参数错误：bad_json/bad_tier/bad_times/bad_seed → 400 + code', async () => {
  await withServer(null, async ({ port }) => {
    const badJson = await request(port, 'POST', '/api/v1/box', '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    const badTier = await request(port, 'POST', '/api/v1/box', { tier: 'diamond' });
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');
    const badTimes = await request(port, 'POST', '/api/v1/box', { times: 0 });
    assert.equal(badTimes.status, 400);
    assert.equal(badTimes.body.error.code, 'bad_times');
    const badSeed = await request(port, 'POST', '/api/v1/box', { seed: 'x' });
    assert.equal(badSeed.status, 400);
    assert.equal(badSeed.body.error.code, 'bad_seed');
  });
});