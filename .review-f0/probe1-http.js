'use strict';
/* .review-f0/probe1-http.js —— P6 F0 静态路由对抗矩阵（可复跑：node .review-f0/probe1-http.js）
 * 独立于测试套件的第三视角：遍历穿越变体（字面/编码/双重编码/反斜杠/混合）、六个前缀、
 * content-type、/api/v1 优先级、GET-only、目录/缺失/查询串/大小写/双斜杠。
 * 关键假设检验：'%2e%2e' 未经解码 → join 后为字面目录名 → readFileSync ENOENT → 404（无源码泄漏）。
 */
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { createLogger } = require('../shared/log.js');
const serverMod = require('../server/index.js');

let passed = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { fails.push(`${name}: ${detail}`); console.log(`  FAIL ${name}: ${detail}`); }
}

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

(async () => {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  const port = s.port;
  try {
    console.log('== 六个前缀 + content-type ==');
    let r = await request(port, 'GET', '/');
    check('GET / → 200 text/html', r.status === 200 && r.headers['content-type'].startsWith('text/html'),
      `${r.status} ${r.headers['content-type']}`);
    check('GET / 不泄漏 /api/v1 路由', !r.body.toString().includes('api/v1'), 'body 异常');
    r = await request(port, 'GET', '/index.html');
    check('GET /index.html → 200 html', r.status === 200 && r.headers['content-type'].startsWith('text/html'), `${r.status}`);
    r = await request(port, 'GET', '/css/tokens.css');
    check('GET /css/tokens.css → 200 css', r.status === 200 && r.headers['content-type'].includes('text/css'), `${r.status} ${r.headers['content-type']}`);
    r = await request(port, 'GET', '/js/app.js');
    check('GET /js/app.js → 200 js', r.status === 200 && r.headers['content-type'].includes('javascript'), `${r.status} ${r.headers['content-type']}`);
    r = await request(port, 'GET', '/shared/log.js');
    check('GET /shared/log.js → 200 js', r.status === 200 && r.headers['content-type'].includes('javascript'), `${r.status} ${r.headers['content-type']}`);
    r = await request(port, 'GET', '/assets/sprites.json');
    check('GET /assets/sprites.json → 200 json', r.status === 200 && r.headers['content-type'].includes('application/json'), `${r.status} ${r.headers['content-type']}`);
    r = await request(port, 'GET', '/assets/nope.json');
    check('GET /assets/nope.json → 404', r.status === 404, `${r.status}`);

    console.log('== GET-only / 方法 ==');
    r = await request(port, 'POST', '/js/app.js');
    check('POST /js/app.js → 404', r.status === 404, `${r.status}`);
    r = await request(port, 'HEAD', '/js/app.js');
    check('HEAD /js/app.js → 404', r.status === 404, `${r.status}`);
    r = await request(port, 'POST', '/');
    check('POST / → 404', r.status === 404, `${r.status}`);
    r = await request(port, 'GET', '/js/app.js?x=1');
    check('GET 带查询串 → 200（urlPath 忽略 query）', r.status === 200, `${r.status}`);
    r = await request(port, 'GET', '//js/app.js');
    check('GET //js/app.js（双斜杠前缀不匹配）→ 404', r.status === 404, `${r.status}`);
    r = await request(port, 'GET', '/JS/APP.JS');
    check('GET 大写变体 → 404（大小写敏感）', r.status === 404, `${r.status}`);
    r = await request(port, 'GET', '/css/');
    check('GET /css/（目录）→ 404', r.status === 404, `${r.status}`);
    r = await request(port, 'GET', '/js/./app.js');
    check('GET /js/./app.js（点段归一）→ 200', r.status === 200, `${r.status}`);

    console.log('== 路径穿越矩阵 ==');
    const cases = [
      ['/js/../server/index.js', 400],                    // 字面 .. → bad_static
      ['/js/..%5Cserver%5Cindex.js', 400],                // 字面 .. + 编码反斜杠 → 400
      ['/css/..%2F..%2Fserver%2Findex.js', 400],          // 字面 .. + 编码斜杠 → 400
      ['/js/..%2Fserver%2Findex.js', 400],
      ['/js/%2e%2e/server/index.js', 404],                // 全编码 .. → 不解码 → 字面目录 → 404
      ['/js/%2e%2e%2f%2e%2e%2fserver%2findex.js', 404],   // 全编码穿越 → 404
      ['/css/%2e%2e%2f%2e%2e%2fserver%2findex.js', 404],
      ['/shared/%2e%2e/server/index.js', 404],
      ['/js/%252e%252e/server/index.js', 404],            // 双重编码 → 404
      ['/js/%2e%2e%5cserver%5cindex.js', 404],            // 编码 .. + 编码反斜杠 → 404
      ['/js/%2e%2e/%2e%2e/server/index.js', 404],
      ['/assets/%2e%2e/server/index.js', 404],
      ['/js/%2E%2E/server/index.js', 404],                // 大写百分号编码 → 404
      ['/js/.../app.js', 400],                            // 三点（含 .. 子串）→ 400
      ['/js/nope.js', 404],                               // 缺失 → 404
      ['/index.html/../js/app.js', 404],                  // 前缀不匹配（仅精确 /index.html）→ 404 且无泄漏
    ];
    for (const [p, expected] of cases) {
      const rr = await request(port, 'GET', p);
      const body = rr.body.toString();
      const leaked = body.includes('staticFile') || body.includes('createHandler');
      check(`GET ${p} → ${expected}`, rr.status === expected && !leaked,
        `实际 ${rr.status}；泄漏=${leaked}；body 头 60 字: ${body.slice(0, 60)}`);
    }

    console.log('== /api/v1 优先级 ==');
    r = await request(port, 'GET', '/api/v1/health');
    check('GET /api/v1/health → 200 信封', r.status === 200 && r.headers['content-type'].includes('application/json')
      && r.body.toString().includes('"ok":true'), `${r.status} ${r.headers['content-type']}`);
    r = await request(port, 'GET', '/api/v1/nope');
    check('GET /api/v1/nope → 404 unknown_endpoint 信封（不落入静态）', r.status === 404 && r.body.toString().includes('unknown_endpoint'), `${r.status} ${r.body.toString().slice(0, 60)}`);
    r = await request(port, 'GET', '/api/v1/data/battle-config');
    check('GET /api/v1/data/battle-config → 200（动态表端点优先）', r.status === 200 && r.body.toString().includes('"ok":true'), `${r.status}`);
    r = await request(port, 'GET', '/api/v1/data/..%2F..%2Fpublic%2Findex.html');
    check('GET /api/v1/data/ 穿越 → 400 bad_table', r.status === 400 && r.body.toString().includes('bad_table'), `${r.status}`);
    r = await request(port, 'GET', '/api/v1/data/index.js');
    check('GET /api/v1/data/index.js → 404 unknown_table（表名不存在，不是静态）', r.status === 404 && r.body.toString().includes('unknown_table'), `${r.status} ${r.body.toString().slice(0, 80)}`);

    console.log('== 静态响应头完整性 ==');
    r = await request(port, 'GET', '/shared/log.js');
    check('content-length 与实际字节一致', Number(r.headers['content-length']) === r.body.length, `header=${r.headers['content-length']} body=${r.body.length}`);
    r = await request(port, 'GET', '/');
    check('index.html 含 #app/画布/ESM 入口', r.body.toString().includes('<div id="app">') && r.body.toString().includes('<canvas id="battle"') && r.body.toString().includes('type="module"'), '骨架缺失');
  } finally {
    await s.close();
  }
  console.log(`\nprobe1: ${passed} ok / ${fails.length} fail`);
  if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; }
})();