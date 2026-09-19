'use strict';
// B22 /api/v1/battle + /api/v1/replay/:id 端点测试 —— T-AP-1/2/3；契约 docs/interfaces.md §2。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const LD = require('../fixtures/loadout-ok.json');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
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
  const logger = createLogger({ level: 'debug', ringSize: 5000 });
  const s = await serverMod.start({ logger });
  try {
    await fn({ port: s.port, logger });
  } finally {
    await s.close();
  }
}

test('T-AP-1 POST /battle 完整帧 + GET /replay/:id 全量与分片', async () => {
  await withServer(null, async ({ port }) => {
    const body = { p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' };
    const r = await request(port, 'POST', '/api/v1/battle', body);
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.seed, 20260913);
    const id = r.body.data.id;
    assert.equal(typeof id, 'string');
    assert.equal(r.body.data.frames.length, r.body.data.ticks);
    const f0 = r.body.data.frames[0].diff;
    for (const k of ['players', 'bullets', 'bases', 'events', 'aiTrace']) {
      assert.ok(k in f0, `frame.diff 缺 ${k}`);
    }
    assert.ok(f0.events.length > 0, '事件带 cid/tick（回放帧契约）');
    assert.equal(f0.events[0].tick, 1, 'events 归属 tick 1');
    // 每帧 aiTrace 必须非空（2026-09-16 回归：runtime 改为每 tick 重置 trace 后，
    //   battle.js 若仍按 slice(prevLen) 取增量，第 2 tick 起 aiTrace 会恒为空——此处钉死该契约）
    const emptyTraceFrames = r.body.data.frames.filter((fr) => !Array.isArray(fr.diff.aiTrace) || fr.diff.aiTrace.length === 0);
    assert.equal(emptyTraceFrames.length, 0, `每帧 aiTrace 必须非空（空帧：${emptyTraceFrames.map((fr) => fr.tick).join(',')}）`);
    const traceTicks = r.body.data.frames.map((fr) => fr.diff.aiTrace[0].tick);
    assert.deepEqual(traceTicks, r.body.data.frames.map((fr) => fr.tick), 'aiTrace 条目归属各自的 tick');
    // 全量
    const full = await request(port, 'GET', `/api/v1/replay/${id}`);
    assert.equal(full.status, 200);
    assert.equal(full.body.data.frames.length, r.body.data.ticks);
    // 分片 from/to（1-based 含端）
    const slice = await request(port, 'GET', `/api/v1/replay/${id}?from=2&to=4`);
    assert.equal(slice.status, 200);
    assert.equal(slice.body.data.frames.length, 3);
    assert.equal(slice.body.data.frames[0].tick, 2);
    // 同 seed 复现（P1-2 升级：帧字节级 deepEqual，ts 归零；仅 replayId 因注册表单调而不同）
    const r2 = await request(port, 'POST', '/api/v1/battle', body);
    assert.equal(r2.body.data.winner, r.body.data.winner);
    assert.deepEqual(r2.body.data.frames, r.body.data.frames, '同 seed 帧字节级一致（P1-2）');
    assert.notEqual(r2.body.data.id, id, 'replayId 每次新发（注册表单调）');
    assert.equal(typeof r2.body.data.frames[0].diff.events[0].cid, 'string', '事件带 cid');
  });
});

test('T-AP-3/T-AP-2 错误路径：404 unknown_replay / 400 / 409 loadout_invalid', async () => {
  await withServer(null, async ({ port }) => {
    const nf = await request(port, 'GET', '/api/v1/replay/r999');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, 'unknown_replay');
    const badReplay = await request(port, 'GET', '/api/v1/replay/..%2Fetc');
    assert.equal(badReplay.status, 400);
    assert.equal(badReplay.body.error.code, 'bad_replay');
    const noP2 = await request(port, 'POST', '/api/v1/battle', { p1: LD.loadout });
    assert.equal(noP2.status, 400);
    assert.equal(noP2.body.error.code, 'bad_request');
    const badSeed = await request(port, 'POST', '/api/v1/battle', { p1: LD.loadout, p2: LD.loadout, seed: 'x' });
    assert.equal(badSeed.status, 400);
    assert.equal(badSeed.body.error.code, 'bad_seed');
    const badTier = await request(port, 'POST', '/api/v1/battle', { p1: LD.loadout, p2: LD.loadout, tier: 'platinum' });
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');
    const badLd = JSON.parse(JSON.stringify(LD.loadout));
    badLd.skills = badLd.skills.slice(0, 2);
    const inv = await request(port, 'POST', '/api/v1/battle', { p1: badLd, p2: LD.loadout, warehouse: LD.warehouse });
    assert.equal(inv.status, 409);
    assert.equal(inv.body.error.code, 'loadout_invalid');
    assert.ok(inv.body.error.details.length > 0);
  });
});