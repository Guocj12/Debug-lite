'use strict';
// T-AP-1/2/3/5 + 信封契约测试 —— 契约见 docs/interfaces.md §2（/api/v1 统一信封）
// P0-8 范围端点：health / data/:table / log-level。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');

const REPO_DATA = path.join(__dirname, '..', '..', 'server', 'data');
const TABLES = require('node:fs').readdirSync(REPO_DATA).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));

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
  const logger = createLogger({ level: 'debug', ringSize: 500 }); // 服务端默认级别 debug（log-level 端点断言用）
  const s = await serverMod.start({ logger });
  const port = s.port;
  try {
    await fn({ port, logger });
  } finally {
    await s.close();
  }
}

test('AP-1 health：统一信封 + api.* 日志事件', async () => {
  await withServer(null, async ({ port, logger }) => {
    const r = await request(port, 'GET', '/api/v1/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.status, 'ok');
    assert.equal(typeof r.body.data.version, 'string');
    assert.equal(typeof r.body.log.level, 'string');
    assert.ok(Array.isArray(r.body.log.events));
    // 日志：api.req( info ) + api.res( info )
    assert.ok(logger.records.some((x) => x.event === 'api.req' && x.data.method === 'GET' && x.data.path === '/api/v1/health'), '应有 api.req');
    assert.ok(logger.records.some((x) => x.event === 'api.res' && typeof x.data.durationMs === 'number' && x.data.bytes > 0), '应有 api.res');
  });
});

test('AP-2 data：全部 7 张表可达且信封正确', async () => {
  await withServer(null, async ({ port }) => {
    assert.ok(TABLES.includes('battle-config'), '表清单应含 battle-config');
    for (const t of TABLES) {
      const r = await request(port, 'GET', `/api/v1/data/${t}`);
      assert.equal(r.status, 200, `${t} 应 200`);
      assert.equal(r.body.ok, true);
      assert.ok(r.body.data !== undefined, `${t} 应有 data`);
    }
    const bc = await request(port, 'GET', '/api/v1/data/battle-config');
    assert.equal(bc.body.data.cellPx, 64, 'battle-config 内容与数据表一致');
  });
});

test('AP-3 data 未知表 → 404 unknown_table 信封', async () => {
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'GET', '/api/v1/data/nope');
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, 'unknown_table');
    assert.equal(typeof r.body.error.message, 'string');
    assert.ok(Array.isArray(r.body.error.details));
  });
});

test('AP-4 未知端点 → 404 unknown_endpoint 信封', async () => {
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'GET', '/api/v1/bogus');
    assert.equal(r.status, 404);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, 'unknown_endpoint');
  });
});

test('AP-5 log-level：GET 当前级别 / POST 修改 / 非法 400 bad_level / 坏 JSON 400', async () => {
  await withServer(null, async ({ port }) => {
    const g0 = await request(port, 'GET', '/api/v1/log-level');
    assert.equal(g0.status, 200);
    assert.equal(g0.body.data.level, 'debug', '注入 logger 默认 debug');
    const set = await request(port, 'POST', '/api/v1/log-level', { level: 'trace' });
    assert.equal(set.status, 200);
    assert.equal(set.body.data.level, 'trace');
    const g1 = await request(port, 'GET', '/api/v1/log-level');
    assert.equal(g1.body.data.level, 'trace');
    const bad = await request(port, 'POST', '/api/v1/log-level', { level: 'bogus' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_level');
    const badJson = await request(port, 'POST', '/api/v1/log-level', '{bad json');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    // 复位
    await request(port, 'POST', '/api/v1/log-level', { level: 'debug' });
  });
});

test('AP-6 服务端异常 → 500 internal_error + api.err(error) 日志', async () => {
  const routes = { GET: { '/api/v1/boom': () => { throw new Error('boom-test'); } } };
  const logger = createLogger({ level: 'debug', ringSize: 500 });
  const s = await serverMod.start({ logger, routes });
  try {
    const r = await request(s.port, 'GET', '/api/v1/boom');
    assert.equal(r.status, 500);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, 'internal_error');
    assert.ok(logger.records.some((x) => x.event === 'api.err' && x.data.message.includes('boom-test')), '应有 api.err');
  } finally {
    await s.close();
  }
});

test('AP-7 坏表名/边界路径：../ 与目录穿越 → 400 bad_table；精确 /api/v1/data → unknown_endpoint；POST 到 data → unknown_endpoint', async () => {
  await withServer(null, async ({ port }) => {
    const travel = await request(port, 'GET', '/api/v1/data/..%2Fsecret');
    assert.equal(travel.status, 400);
    assert.equal(travel.body.error.code, 'bad_table');
    const exact = await request(port, 'GET', '/api/v1/data');
    assert.equal(exact.status, 404);
    assert.equal(exact.body.error.code, 'unknown_endpoint');
    const post = await request(port, 'POST', '/api/v1/data/battle-config', {});
    assert.equal(post.status, 404);
    assert.equal(post.body.error.code, 'unknown_endpoint');
  });
});

test('AP-8 请求体超限（>1MB）→ 500 internal_error + api.err', async () => {
  const logger = createLogger({ level: 'debug', ringSize: 500 });
  const s = await serverMod.start({ logger });
  try {
    const big = 'x'.repeat(1500000);
    const r = await request(s.port, 'POST', '/api/v1/log-level', JSON.stringify({ level: 'trace', pad: big }));
    assert.equal(r.status, 500);
    assert.equal(r.body.error.code, 'internal_error');
    assert.ok(logger.records.some((x) => x.event === 'api.err' && x.data.message.includes('1MB')), 'api.err 应记录超限');
  } finally {
    await s.close();
  }
});

test('AP-9 log-level 原子性：混合载荷校验失败 → 400 且级别不变（审查 P2-a）', async () => {
  const logger = createLogger({ level: 'debug', ringSize: 500 });
  const s = await serverMod.start({ logger });
  try {
    const r = await request(s.port, 'POST', '/api/v1/log-level', { level: 'trace', channels: { api: 'bogus' } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'bad_level');
    const g = await request(s.port, 'GET', '/api/v1/log-level');
    assert.equal(g.body.data.level, 'debug', '失败不得部分生效（level 未被改成 trace）');
  } finally {
    await s.close();
  }
});

test('AP-10 channels 非法形状 / 畸形 URI → 400（审查 P2-b）', async () => {
  await withServer(null, async ({ port }) => {
    const nullCh = await request(port, 'POST', '/api/v1/log-level', { level: 'trace', channels: null });
    assert.equal(nullCh.status, 400);
    assert.equal(nullCh.body.error.code, 'bad_level');
    const arrCh = await request(port, 'POST', '/api/v1/log-level', { channels: ['api'] });
    assert.equal(arrCh.status, 400);
    const badUri = await request(port, 'GET', '/api/v1/data/%zz');
    assert.equal(badUri.status, 400);
    assert.equal(badUri.body.error.code, 'bad_table');
  });
});