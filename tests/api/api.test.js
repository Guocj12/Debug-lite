'use strict';
// T-AP-1/2/3/5 + 信封契约测试 —— 契约见 docs/interfaces.md §2（/api/v1 统一信封）
// P0-8 范围端点：health / data/:table / log-level。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const { requestChunks } = require('../helpers/http.js');

const REPO_DATA = path.join(__dirname, '..', '..', 'server', 'data');
const REPO_ASSETS = path.join(__dirname, '..', '..', 'assets');
const TABLES = []
  .concat(require('node:fs').readdirSync(REPO_DATA).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')))
  .concat(require('node:fs').readdirSync(REPO_ASSETS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')));

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

test('AP-2 data：全部 9 张表（7 数据表 + sprites/animations）可达且信封正确', async () => {
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

test('AP-11 endpoint 覆盖：unlock?tier= 正常/400 bad_tier（B4 接入，L14；门控默认关闭 = 全解锁）', async () => {
  await withServer(null, async ({ port }) => {
    // 门控关闭（默认，用户决策 2026-09-16）：任意段位都返回**全部真实节点/模板/技能/插件**（段位仅回带）
    const ok = await request(port, 'GET', '/api/v1/unlock?tier=common');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.tier, 'common', 'tier 仍回带（参数校验/回带不受门控影响）');
    assert.equal(ok.body.data.nodes.length, 16, '门控关闭：全部 16 类真实节点（= ai-nodes.json nodes）');
    assert.ok(ok.body.data.nodes.includes('random'), '门控关闭：common 也给 random');
    assert.ok(ok.body.data.nodes.includes('function') && ok.body.data.nodes.includes('call'), 'function/call 亦全解锁');
    assert.ok(ok.body.data.roleTemplates.includes('role_bal'), '均衡角色可用');
    assert.ok(ok.body.data.skills.includes('skill_dash_bash'), '门控关闭：mythic 技能在 common 也可用');
    // 与最低段位相比无差异（段位不参与判定）
    const mythic = await request(port, 'GET', '/api/v1/unlock?tier=mythic');
    assert.deepEqual(mythic.body.data.nodes, ok.body.data.nodes, 'common 与 mythic 节点集相同');
    assert.deepEqual(mythic.body.data.roleTemplates, ok.body.data.roleTemplates, '模板集相同');
    assert.deepEqual(mythic.body.data.plugins, ok.body.data.plugins, '插件集相同');
    // 参数校验与门控是两件事：非法/缺省 tier 仍必须 400 bad_tier
    const bad = await request(port, 'GET', '/api/v1/unlock');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_tier');
    const bad2 = await request(port, 'GET', '/api/v1/unlock?tier=nope');
    assert.equal(bad2.status, 400);
    assert.equal(bad2.body.error.code, 'bad_tier');
  });
});

test('AP-8 请求体超限（>1MB）→ 413 payload_too_large（P7-7 §⑩ P0：不再是 500 internal_error）', async () => {
  const logger = createLogger({ level: 'debug', ringSize: 500 });
  const s = await serverMod.start({ logger });
  try {
    const big = 'x'.repeat(1500000);
    const r = await request(s.port, 'POST', '/api/v1/log-level', JSON.stringify({ level: 'trace', pad: big }));
    assert.equal(r.status, 413);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, 'payload_too_large');
    assert.match(r.body.error.message, /1MB/);
    assert.ok(logger.records.some((x) => x.event === 'api.reject' && x.data.code === 'payload_too_large'), '超限记 api.reject(warn)');
    // 分块写入（Transfer-Encoding: chunked）同样必须 413
    const chunked = await requestChunks(s.port, '/api/v1/log-level', [JSON.stringify({ level: 'trace', pad: big })]);
    assert.equal(chunked.status, 413);
    assert.equal(chunked.body.error.code, 'payload_too_large');
    // 超限请求不得改变服务端状态
    const g = await request(s.port, 'GET', '/api/v1/log-level');
    assert.equal(g.body.data.level, 'debug');
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

test('AP-12 CORS（DL_CORS_ORIGIN，P7-4）：默认不发送头；白名单命中发送 + OPTIONS 预检 204', async () => {
  // 默认（未配置 DL_CORS_ORIGIN）：任何响应都不带 CORS 头
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'GET', '/api/v1/health');
    assert.equal(r.status, 200);
    const noCors = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/api/v1/health', headers: { origin: 'https://a.example' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.headers));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(noCors['access-control-allow-origin'], undefined, '空 = 不发送 CORS 头（同源部署）');
  });
  // 白名单命中（注入 corsOrigin，等价 DL_CORS_ORIGIN=https://a.example）
  const logger = createLogger({ level: 'debug', ringSize: 500 });
  const s = await serverMod.start({ logger, corsOrigin: 'https://a.example,https://b.example' });
  try {
    const hit = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, method: 'GET', path: '/api/v1/health', headers: { origin: 'https://a.example' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(hit.status, 200);
    assert.equal(hit.headers['access-control-allow-origin'], 'https://a.example');
    assert.match(hit.headers['access-control-allow-headers'], /authorization/i);
    const miss = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: s.port, method: 'GET', path: '/api/v1/health', headers: { origin: 'https://evil.example' } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(miss.headers['access-control-allow-origin'], undefined, '白名单外不发送');
    // 预检
    const preflight = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: s.port, method: 'OPTIONS', path: '/api/v1/me',
        headers: { origin: 'https://b.example', 'access-control-request-method': 'GET' },
      }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], 'https://b.example');
  } finally {
    await s.close();
  }
});