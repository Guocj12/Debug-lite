'use strict';
// B16 /api/v1/ai/* 端点测试 —— T-AP-1/2/3/4/5 + T-LG-8；契约 docs/interfaces.md §2
// （信封/错误码）、 systems/08-ai.md §4.7、examples A-10。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const FIXTURES = require('../fixtures/ai-programs.json');
const prog = (key) => JSON.parse(JSON.stringify(FIXTURES[key].program));

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
  const logger = createLogger({ level: 'debug', ringSize: 20000 });
  const s = await serverMod.start({ logger });
  try {
    await fn({ port: s.port, logger });
  } finally {
    await s.close();
  }
}

test('T-AP-1 /ai/validate + /ai/compile 正常路径：信封 + programHash + 统计', async () => {
  await withServer(null, async ({ port }) => {
    const v = await request(port, 'POST', '/api/v1/ai/validate', { program: prog('a1Countdown'), tier: 'common' });
    assert.equal(v.status, 200);
    assert.equal(v.body.ok, true);
    assert.deepEqual(v.body.data, { ok: true });
    assert.equal(typeof v.body.log.level, 'string');
    const c = await request(port, 'POST', '/api/v1/ai/compile', { program: prog('a1Countdown') });
    assert.equal(c.status, 200);
    assert.equal(c.body.ok, true);
    assert.equal(typeof c.body.data.programHash, 'string');
    assert.equal(c.body.data.programHash.length, 64);
    assert.equal(c.body.data.version, 2, 'v1 输入被迁移到当前版本');
    assert.equal(c.body.data.migrated, true);
    assert.ok(c.body.data.stats.nodes > 0 && typeof c.body.data.stats.depth === 'number');
    assert.ok(Array.isArray(c.body.data.stats.usedNodeTypes));
    // 同程序两次 compile hash 一致（A-10a/b 经 API）
    const c2 = await request(port, 'POST', '/api/v1/ai/compile', { program: prog('a1Countdown') });
    assert.equal(c2.body.data.programHash, c.body.data.programHash, 'hash 确定性');
  });
});

test('T-AP-1/2 /ai/battle 正常路径：服务端执行 + 帧含 aiTraces + seed 回带', async () => {
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), seed: 20260912, opponent: 'kiter' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.seed, 20260912, 'seed 显式回带（T-AP-5）');
    assert.ok(['p1', 'p2', 'draw'].includes(r.body.data.winner));
    assert.equal(typeof r.body.data.ticks, 'number');
    assert.equal(r.body.data.ticks, r.body.data.frames.length, '帧数 == tick 数');
    const f1 = r.body.data.frames[0];
    assert.ok(Array.isArray(f1.aiTrace) && f1.aiTrace.length > 0, '首帧含 AI trace（冻结字段 diff.aiTrace）');
    const last = f1.aiTrace[f1.aiTrace.length - 1];
    assert.equal(last.nodeType, 'action', '末条为 action');
    assert.equal(last.result, 'move_right', '首 tick 行动 = move_right（n=0 < 2 → then 分支）');
    assert.equal(last.path, 'body.s[1].then.s[1]', 'trace 路径规范');
    assert.equal(f1.aiTrace[0].path, 'body.s[0]', 'trace 从 var 语句开始');
  });
});

test('T-AP-4 服务端重新执行、不信任客户端结果：同 seed 两次一致；伪造 result 字段被忽略', async () => {
  await withServer(null, async ({ port }) => {
    const body = { program: prog('a2Breakpoint'), seed: 4242, opponent: 'charger' };
    const r1 = await request(port, 'POST', '/api/v1/ai/battle', body);
    const r2 = await request(port, 'POST', '/api/v1/ai/battle', body);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual(
      { winner: r2.body.data.winner, ticks: r2.body.data.ticks, frames: r2.body.data.frames },
      { winner: r1.body.data.winner, ticks: r1.body.data.ticks, frames: r1.body.data.frames },
      '同 seed 完全复现',
    );
    // 客户端携带伪造结果 → 服务端忽略（不信任客户端结果，T-AP-4）
    const fake = await request(port, 'POST', '/api/v1/ai/battle', { ...body, result: { winner: 'p1', ticks: 1 } });
    assert.equal(fake.body.data.winner, r1.body.data.winner, '伪造 result 不影响服务端重执行');
    assert.equal(fake.body.data.ticks, r1.body.data.ticks);
  });
});

test('T-AP-5 seed 缺省：服务端生成并回带；携带回带 seed 可复现', async () => {
  await withServer(null, async ({ port }) => {
    const r1 = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a2Breakpoint') });
    assert.equal(r1.status, 200);
    const seed = r1.body.data.seed;
    assert.ok(Number.isInteger(seed) && seed >= 1, `服务端生成 seed=${seed}`);
    const r2 = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a2Breakpoint'), seed });
    assert.equal(r2.body.data.winner, r1.body.data.winner, '带 seed 复现同结果');
    assert.equal(r2.body.data.ticks, r1.body.data.ticks);
  });
});

test('T-AP-2 参数错误：bad_json / bad_ai / bad_tier / bad_seed → 400 + error.code', async () => {
  await withServer(null, async ({ port }) => {
    const badJson = await request(port, 'POST', '/api/v1/ai/validate', '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    const noProg = await request(port, 'POST', '/api/v1/ai/validate', {});
    assert.equal(noProg.status, 400);
    assert.equal(noProg.body.error.code, 'bad_ai');
    const badTier = await request(port, 'POST', '/api/v1/ai/validate', { program: prog('a1Countdown'), tier: 'diamond' });
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');
    // P2-2：battle 同样拒绝非法 tier（不得落入误导性 ai_invalid+node_locked）
    const battleBadTier = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), tier: 'diamond' });
    assert.equal(battleBadTier.status, 400);
    assert.equal(battleBadTier.body.error.code, 'bad_tier');
    const badSeed = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), seed: 'abc' });
    assert.equal(badSeed.status, 400);
    assert.equal(badSeed.body.error.code, 'bad_seed');
    const zeroSeed = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), seed: 0 });
    assert.equal(zeroSeed.status, 400);
    assert.equal(zeroSeed.body.error.code, 'bad_seed');
  });
});

test('T-AP-3 业务拒绝与校验失败：未知对手 409 unknown_opponent；病态程序 400 ai_invalid 带路径', async () => {
  await withServer(null, async ({ port }) => {
    const opp = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), opponent: 'nope' });
    assert.equal(opp.status, 409);
    assert.equal(opp.body.error.code, 'unknown_opponent');
    const bad = await request(port, 'POST', '/api/v1/ai/validate', { program: { type: 'program', version: 1, body: { type: 'seq', statements: [
      { type: 'loop', kind: 'count', times: { type: 'literal', value: 2 }, body: { type: 'seq', statements: [{ type: 'set', name: 'x', value: { type: 'literal', value: 1 } }] } },
    ] } }, tier: 'rare' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'ai_invalid');
    assert.ok(Array.isArray(bad.body.error.details) && bad.body.error.details.length > 0);
    assert.equal(bad.body.error.details[0].code, 'branch_without_action', '错误带节点路径与 code');
    assert.equal(typeof bad.body.error.details[0].path, 'string');
    // v3 版本 → 信封 ai_invalid，details 带 ai_version_unsupported
    const p3 = prog('a1Countdown');
    p3.version = 3;
    const v3 = await request(port, 'POST', '/api/v1/ai/validate', { program: p3 });
    assert.equal(v3.status, 400);
    assert.equal(v3.body.error.code, 'ai_invalid', 'validate 信封主码固定 ai_invalid');
    assert.equal(v3.body.error.details[0].code, 'ai_version_unsupported');
    // P2-7：compile v3 同样拒绝（信封码 = 首个错误码 ai_version_unsupported）
    const c3 = await request(port, 'POST', '/api/v1/ai/compile', { program: p3 });
    assert.equal(c3.status, 400);
    assert.equal(c3.body.error.code, 'ai_version_unsupported');
  });
});

test('T-LG-8 API 日志：ai 端点经服务端 logger 记录 ai.migrate/ai.validate/api.req/api.res 等事件', async () => {
  await withServer(null, async ({ port, logger }) => {
    await request(port, 'POST', '/api/v1/ai/compile', { program: prog('a1Countdown') });
    assert.ok(logger.records.some((x) => x.event === 'api.req' && x.data.path === '/api/v1/ai/compile'), 'api.req');
    assert.ok(logger.records.some((x) => x.event === 'api.res' && x.data.path === '/api/v1/ai/compile'), 'api.res');
    assert.ok(logger.records.some((x) => x.event === 'ai.migrate'), 'ai.migrate（v1 → v2）');
    await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a2Breakpoint'), seed: 11 });
    assert.ok(logger.records.some((x) => x.event === 'battle.create'), 'battle.create');
    assert.ok(logger.records.some((x) => x.event === 'tick.begin'), 'tick.begin');
    assert.ok(logger.records.some((x) => x.event === 'ai.action'), 'ai.action（运行时续执行接入引擎）');
  });
});