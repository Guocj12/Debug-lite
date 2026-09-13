'use strict';
// P6 F0：静态资源服务 —— frontend-spec §1.1（public/ shared/ assets/；GET；api 优先级；路径穿越防护）
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(t, fn) {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    await fn({ port: s.port });
  } finally {
    await s.close();
  }
}

test('F0 静态：/ 与 /index.html → 200 text/html（含 #app 骨架）；/css/* /js/* /shared/* 类型正确', async () => {
  await withServer(null, async ({ port }) => {
    const home = await request(port, 'GET', '/');
    assert.equal(home.status, 200, home.body.toString().slice(0, 80));
    assert.ok(home.headers['content-type'].includes('text/html'));
    assert.ok(home.body.toString().includes('<div id="app">'), 'index.html 含 app 挂载点');
    assert.ok(home.body.toString().includes('/js/app.js'), 'index.html 含 ESM 入口');
    const idx = await request(port, 'GET', '/index.html');
    assert.equal(idx.status, 200);
    const css = await request(port, 'GET', '/css/tokens.css');
    assert.equal(css.status, 200);
    assert.ok(css.headers['content-type'].includes('text/css'));
    assert.ok(css.body.toString().includes('--color-bg'), 'tokens.css 令牌载入');
    const style = await request(port, 'GET', '/css/style.css');
    assert.equal(style.status, 200);
    const shared = await request(port, 'GET', '/shared/log.js');
    assert.equal(shared.status, 200);
    assert.ok(shared.headers['content-type'].includes('javascript'));
    assert.ok(shared.body.toString().includes('root.DLLog'), 'UMD 全局 DLLog');
    const app = await request(port, 'GET', '/js/app.js');
    assert.equal(app.status, 200);
    assert.ok(app.headers['content-type'].includes('javascript'));
    const util = await request(port, 'GET', '/js/util/log.js');
    assert.equal(util.status, 200);
  });
});

test('F0 静态：GET-only + 编码穿越统一 400 + 缺失 404 + /api/v1 优先级', async () => {
  await withServer(null, async ({ port }) => {
    const postJs = await request(port, 'POST', '/js/app.js');
    assert.equal(postJs.status, 404, '静态仅 GET');
    const trav = await request(port, 'GET', '/js/../server/index.js');
    assert.equal(trav.status, 400, '字面穿越 → 400 bad_static');
    const travEnc = await request(port, 'GET', '/js/%2e%2e/server/index.js');
    assert.equal(travEnc.status, 400, '编码穿越 %2e%2e → 400 bad_static（P2-1 显式解码后判拒）');
    assert.ok(!travEnc.body.toString().includes('createHandler'), '零源码泄漏');
    const badUri = await request(port, 'GET', '/css/%zz');
    assert.equal(badUri.status, 400, '非法 URI 编码 → 400 bad_static');
    const miss = await request(port, 'GET', '/js/nope.js');
    assert.equal(miss.status, 404, '缺失静态 → 404 unknown_endpoint');
    const health = await request(port, 'GET', '/api/v1/health');
    assert.equal(health.status, 200, '/api/v1 优先级高于静态');
    assert.ok(health.body.toString().includes('"ok":true'));
    const apiMiss = await request(port, 'GET', '/api/v1/nope');
    assert.equal(apiMiss.status, 404, 'API 未命中不落入静态');
  });
});

test('F0 静态：/vendor/blockly/* 可达（F6 Blockly 静态路由）', async () => {
  await withServer(null, async ({ port }) => {
    const main = await request(port, 'GET', '/vendor/blockly/blockly_compressed.js');
    assert.equal(main.status, 200, 'blockly 主文件可达');
    assert.ok(main.body.toString().includes('Blockly'), '内容为 Blockly（文件头为许可注释/混淆前缀）');
    const missB = await request(port, 'GET', '/vendor/blockly/nope.js');
    assert.equal(missB.status, 404);
  });
});

test('F0 静态：/assets/* 可达（sprites.json 200，缺省 404）', async () => {
  await withServer(null, async ({ port }) => {
    const sprites = await request(port, 'GET', '/assets/sprites.json');
    assert.equal(sprites.status, 200, 'assets 表可达（P2-8 套件断言）');
    assert.ok(sprites.body.toString().includes('format'), 'sprites.json 内容');
    const missA = await request(port, 'GET', '/assets/nope.png');
    assert.equal(missA.status, 404);
  });
});