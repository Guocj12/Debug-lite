'use strict';
// P6 R0 静态托管契约测试 —— spec §1.1 六前缀 + 穿越加固；服务端实现 server/index.js staticFile()
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');

function request(port, method, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非信封响应（静态文件） */ }
        resolve({ status: res.statusCode, type: res.headers['content-type'], raw, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(fn) {
  const logger = createLogger({ level: 'debug', ringSize: 500 });
  const s = await serverMod.start({ logger });
  try {
    await fn({ port: s.port });
  } finally {
    await s.close();
  }
}

test('R0 静态：/ 与 /index.html → 200 text/html（含 #app 骨架与 app.js 入口）', async () => {
  await withServer(async ({ port }) => {
    for (const p of ['/', '/index.html']) {
      const r = await request(port, 'GET', p);
      assert.equal(r.status, 200, `${p} 应 200`);
      assert.ok(r.type.startsWith('text/html'), `${p} 应 text/html`);
      assert.ok(r.raw.includes('id="app"'), `${p} 应含 #app`);
      assert.ok(r.raw.includes('/js/app.js'), `${p} 应含入口脚本`);
      assert.ok(r.raw.includes('/css/tokens.css'), `${p} 应引 tokens.css`);
    }
  });
});

test('R0 静态：/css/* /js/* /shared/* 内容类型正确且内容非空', async () => {
  await withServer(async ({ port }) => {
    const rCss = await request(port, 'GET', '/css/tokens.css');
    assert.equal(rCss.status, 200);
    assert.ok(rCss.type.startsWith('text/css'));
    assert.ok(rCss.raw.includes('--color-bg'));
    const rJs = await request(port, 'GET', '/js/util/log.js');
    assert.equal(rJs.status, 200);
    assert.ok(rJs.type.startsWith('text/javascript'));
    assert.ok(rJs.raw.includes('bootLogging'));
    const rShared = await request(port, 'GET', '/shared/log.js');
    assert.equal(rShared.status, 200);
    assert.ok(rShared.type.startsWith('text/javascript'));
    assert.ok(rShared.raw.includes('DLLog'), 'shared/log.js 应以 DLLog 全局暴露');
  });
});

test('R0 静态：/assets/* 可达（sprites.json 200 JSON；缺失 404 信封）', async () => {
  await withServer(async ({ port }) => {
    const ok = await request(port, 'GET', '/assets/sprites.json');
    assert.equal(ok.status, 200);
    assert.ok(ok.type.startsWith('application/json'));
    const sprites = JSON.parse(ok.raw);
    assert.ok(sprites && typeof sprites === 'object' && sprites.format, 'sprites.json 应为占位美术表对象');
    const miss = await request(port, 'GET', '/assets/nope.json');
    assert.equal(miss.status, 404);
    assert.equal(miss.json.error.code, 'unknown_endpoint');
  });
});

test('R0 静态：GET-only（POST /js/app.js → 404 信封，不落入静态）', async () => {
  await withServer(async ({ port }) => {
    const r = await request(port, 'POST', '/js/app.js');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'unknown_endpoint');
  });
});

test('R0 静态：编码型与明文穿越统一 400 bad_static（%/..与反斜杠）', async () => {
  await withServer(async ({ port }) => {
    for (const p of [
      '/js/%2e%2e/server/data/battle-config.json', // 编码型 ..
      '/js/../server/data/battle-config.json',     // 明文 ..
      '/shared/%2e%2e%2fpackage.json',             // 编码型 ../
      '/js/..\\server/data/battle-config.json',    // 反斜杠
    ]) {
      const r = await request(port, 'GET', p);
      assert.equal(r.status, 400, `${p} 应 400`);
      assert.equal(r.json.error.code, 'bad_static', `${p} 应 bad_static`);
    }
  });
});

test('R0 静态：未登记前缀不暴露（/server/*、未映射 vendor → 404）；/api/v1 优先级不受影响', async () => {
  await withServer(async ({ port }) => {
    // /vendor/blockly/* 依赖 node_modules/blockly（R6 声明依赖：blockly 13.3.0）
    for (const p of ['/server/index.js', '/shared', '/js', '/vendor/other/tool.js']) {
      const r = await request(port, 'GET', p);
      assert.equal(r.status, 404, `${p} 应 404`);
      assert.equal(r.json.error.code, 'unknown_endpoint');
    }
    const api = await request(port, 'GET', '/api/v1/health');
    assert.equal(api.status, 200);
    assert.equal(api.json.ok, true, '/api/v1 应走 API 路由而非静态');
  });
});

test('R6 静态：/vendor/blockly/* 可达（声明依赖 blockly；blockly.mjs 入口）', async () => {
  await withServer(async ({ port }) => {
    const r = await request(port, 'GET', '/vendor/blockly/blockly.mjs');
    assert.equal(r.status, 200, 'blockly.mjs 应可达');
    assert.ok(r.type.startsWith('text/javascript'), 'JS 内容类型');
    assert.ok(r.raw.includes('Blockly') || r.raw.length > 1000, '内容非空');
    const r2 = await request(port, 'GET', '/vendor/blockly/blocks.js');
    assert.equal(r2.status, 200, 'blocks.js 可达');
  });
});
