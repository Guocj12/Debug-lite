'use strict';
/* tests/frontend/static-hosting.test.js —— F1 静态托管契约（docs/frontend/01-auth.md §9；决定 FR-4）
 *
 * 覆盖：资源可达、扩展名白名单、路径穿越防护、既有 404 语义零回归、publicDir 测试缝。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startServer, request, makeTempDataDir, removeTempDir } = require('../helpers/http.js');

const PUBLIC_ASSETS = ['/index.html', '/app.js', '/api.js', '/store.js', '/format.js', '/render.js', '/actions.js', '/boot.js', '/contract.js'];

test('SH-1 根路径返回 index.html（唯一入口）', async () => {
  const s = await startServer({ prefix: 'dl-fe-static-', level: 'warn' });
  try {
    const r = await request(s.port, 'GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.raw, /Debug-Lite v3/);
    assert.match(r.raw, /id="view"/);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally {
    await s.cleanup();
  }
});

test('SH-2 public/ 下全部前端资源可达且类型正确', async () => {
  const s = await startServer({ prefix: 'dl-fe-static-', level: 'warn' });
  try {
    for (const asset of PUBLIC_ASSETS) {
      const r = await request(s.port, 'GET', asset);
      assert.equal(r.status, 200, `${asset} 应 200，实际 ${r.status}`);
      const type = r.headers['content-type'];
      if (asset.endsWith('.html')) assert.match(type, /text\/html/);
      else if (asset.endsWith('.js')) assert.match(type, /javascript/);
      assert.ok(r.raw.length > 0, `${asset} 不应为空`);
    }
  } finally {
    await s.cleanup();
  }
});

test('SH-3 路径穿越一律 404，且不泄漏仓库内文件', async () => {
  const s = await startServer({ prefix: 'dl-fe-static-', level: 'warn' });
  try {
    const attacks = ['/../package.json', '/..%2Fpackage.json', '/a/../../package.json', '/%2e%2e/package.json', '/..%5Cpackage.json'];
    for (const a of attacks) {
      const r = await request(s.port, 'GET', a);
      assert.equal(r.status, 404, `${a} 应 404，实际 ${r.status}：${r.raw.slice(0, 120)}`);
      assert.equal(r.body.error.code, 'unknown_endpoint');
      assert.ok(!r.raw.includes('"name": "debug-lite"'), `${a} 泄漏了仓库根文件`);
    }
    // public/ 内不存在、仓库根存在的文件，也不得被托管
    const pkg = await request(s.port, 'GET', '/package.json');
    assert.equal(pkg.status, 404, 'public/package.json 不存在 → 404');
  } finally {
    await s.cleanup();
  }
});

test('SH-4 非白名单扩展名 / 缺失文件 / 非 GET → 既有 404 语义不变', async () => {
  const s = await startServer({ prefix: 'dl-fe-static-', level: 'warn' });
  try {
    const cases = [
      ['GET', '/nope.js'],
      ['GET', '/server/index.js'],   // 仓库内存在，但不在 public/ 且含非法段
      ['GET', '/secrets.txt'],       // 非白名单扩展名
      ['POST', '/'],
      ['POST', '/app.js'],
      // 注意：DELETE **不带**请求体。Node 的 http 客户端对 DELETE 不发送 chunked 框架，
      // 带体时服务端解析器会与后续字节错位（既有行为，与静态托管无关；实测 publicDir 为空时同样 400）。
      ['DELETE', '/index.html'],
      ['PUT', '/index.html'],
    ];
    for (const [method, url] of cases) {
      const body = method === 'GET' || method === 'DELETE' ? undefined : {};
      const r = await request(s.port, method, url, body);
      assert.equal(r.status, 404, `${method} ${url} 应 404，实际 ${r.status}`);
      assert.equal(r.body.error.code, 'unknown_endpoint');
    }
  } finally {
    await s.cleanup();
  }
});

test('SH-5 /api/v1 路由与动态路由不受静态托管影响（回归）', async () => {
  const s = await startServer({ prefix: 'dl-fe-static-', level: 'warn' });
  try {
    const health = await request(s.port, 'GET', '/api/v1/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.data.status, 'ok');
    const bogus = await request(s.port, 'GET', '/api/v1/bogus');
    assert.equal(bogus.status, 404);
    assert.equal(bogus.body.error.code, 'unknown_endpoint');
    const table = await request(s.port, 'GET', '/api/v1/data/battle-config');
    assert.equal(table.status, 200);
    assert.equal(table.body.ok, true);
    // 动态回放路由仍生效：`r0` 永不出现（replaySeq 从 r1 起）→ 404 unknown_replay
    //   （注意：`server/battle.js` 的 REPLAYS 是**模块级**注册表，单进程 runner 下跨实例共享，
    //    故不可用 r1 之类"别的用例可能已创建"的 id 做断言）
    const replay = await request(s.port, 'GET', '/api/v1/replay/r0');
    assert.equal(replay.status, 404);
    assert.equal(replay.body.error.code, 'unknown_replay');
    // 动态路由的入参校验也未被静态托管吞掉：畸形 id → 400 bad_replay
    const badReplay = await request(s.port, 'GET', '/api/v1/replay/..%2Fsecret');
    assert.equal(badReplay.status, 400);
    assert.equal(badReplay.body.error.code, 'bad_replay');
  } finally {
    await s.cleanup();
  }
});

test('SH-6 publicDir 测试缝：目录无 index.html 时根路径仍 404（public/ 缺失即行为不变）', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-fe-emptypublic-'));
  const dataDir = makeTempDataDir('dl-fe-static-seam-');
  const s = await startServer({ dataDir, server: { publicDir: empty }, level: 'warn' });
  try {
    const root = await request(s.port, 'GET', '/');
    assert.equal(root.status, 404);
    assert.equal(root.body.error.code, 'unknown_endpoint');
    const asset = await request(s.port, 'GET', '/app.js');
    assert.equal(asset.status, 404);
  } finally {
    await s.cleanup();
    removeTempDir(dataDir);
    removeTempDir(empty);
  }
});

test('SH-7 静态请求不产生新日志事件（复用 api.req/api.res）', async () => {
  const s = await startServer({ prefix: 'dl-fe-static-', level: 'info' });
  try {
    await request(s.port, 'GET', '/');
    const events = s.logger.records.map((r) => r.event);
    assert.ok(events.includes('api.req'), '应有 api.req');
    assert.ok(events.includes('api.res'), '应有 api.res');
    const unknown = events.filter((e) => !e.startsWith('api.') && !e.startsWith('store.') && !e.startsWith('log.'));
    assert.deepEqual(unknown, [], `静态托管不得引入新日志事件：${unknown.join(', ')}`);
  } finally {
    await s.cleanup();
  }
});
