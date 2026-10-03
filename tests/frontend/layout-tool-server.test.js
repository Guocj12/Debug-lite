'use strict';
/* tests/frontend/layout-tool-server.test.js —— 布局工具本地服务的接口契约
 *
 * 为什么单列一个文件：这个服务是"页面写工作区"的唯一通路，它一旦回非 JSON，
 *   页面里的 `r.json()` 就会抛 **`Unexpected token 'o', "not found: "... is not valid JSON`**
 *   （用户实际踩到的报错）。所以"**所有**响应都是 JSON + 带 CORS"必须是机器判定。
 *
 *   LS-1  布局台可访问（HTML，含存盘/素材面板）
 *   LS-2  /api/status 回 JSON 且 ok:true（页面用它探测服务是否在跑）
 *   LS-3  未知路径 / 静态缺失 / 坏请求体 —— **一律 JSON**（不得回纯文本，否则页面解析炸）
 *   LS-4  CORS：GET 带 allow-origin，OPTIONS 预检 204（支持从 file:// 或别的本地页面调用）
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const labServer = require(path.join(REPO, 'tools', 'layout', 'lab-server.js'));

function withServer(fn) {
  return new Promise((resolve, reject) => {
    const srv = labServer.createLabServer();
    srv.listen(0, '127.0.0.1', async () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      try { resolve(await fn(base)); } catch (e) { reject(e); } finally { srv.close(); }
    });
  });
}

/** 断言"这是 JSON"——非 JSON 会让 r.json() 抛解析错，正是要防的缺陷 */
async function asJson(res, label) {
  const ct = res.headers.get('content-type') || '';
  assert.ok(ct.indexOf('json') >= 0, `${label} 必须回 JSON，实际 content-type=${ct}`);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { assert.fail(`${label} 的响应不是合法 JSON：${text.slice(0, 120)}`); }
  return body;
}

test('LS-1 布局台页面可访问且含工具面板', () => withServer(async (base) => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.ok(html.includes('id="view"') || html.includes('layout-lab') || html.includes('<html'), '应是布局台 HTML');
  ['btnSaveWs', 'btnManifest', 'btnAssets', 'btnApplyAll', 'toolPanel'].forEach((id) => {
    assert.ok(html.includes('id="' + id + '"'), '页面缺少元素 #' + id);
  });
}));

test('LS-2 /api/status 回 JSON 且 ok:true', () => withServer(async (base) => {
  const body = await asJson(await fetch(base + '/api/status'), '/api/status');
  assert.equal(body.ok, true);
  assert.ok(typeof body.root === 'string' && body.root.length > 0, 'status 应给出工作区路径');
  assert.ok(body.raw && body.raw.indexOf('layout-bundle.raw.json') >= 0, 'status 应给出导出 JSON 的目标路径');
}));

test('LS-3 未知路径 / 静态缺失 / 坏请求体一律回 JSON（回归：Unexpected token）', () => withServer(async (base) => {
  const cases = [
    ['未匹配路由', base + '/definitely-not-a-route', undefined],
    ['/api 未匹配', base + '/api/nope', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }],
    ['静态文件缺失', base + '/public/no-such-file.js', undefined],
    ['坏 JSON 请求体', base + '/api/save-layout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }],
  ];
  for (const [label, url, opt] of cases) {
    const res = await fetch(url, opt);
    const body = await asJson(res, label);
    assert.equal(body.ok, false, `${label} 应回 ok:false`);
    assert.ok(typeof body.error === 'string' && body.error.length > 0, `${label} 应给出 error 文案`);
    assert.ok(res.status >= 400, `${label} 的状态码应是 4xx，实际 ${res.status}`);
  }
}));

test('LS-4 CORS：GET 带 allow-origin；OPTIONS 预检 204', () => withServer(async (base) => {
  const r = await fetch(base + '/api/status');
  assert.equal(r.headers.get('access-control-allow-origin'), '*', 'GET 应带 CORS（file:// 或别的本地页面要用）');
  const opt = await fetch(base + '/api/status', { method: 'OPTIONS' });
  assert.equal(opt.status, 204);
  assert.match(opt.headers.get('access-control-allow-methods') || '', /POST/);
  assert.match(opt.headers.get('access-control-allow-headers') || '', /content-type/);
}));

test('LS-5 入口路由：常见打开方式都能进布局台；浏览器敲错路径回首页（不是把 JSON 当页面）', () => withServer(async (base) => {
  const nav = { headers: { accept: 'text/html,application/xhtml+xml' } };
  // 人习惯敲的几种入口都要能进（此前只认 / 与 /lab.html，敲 /index.html 会看到一段 JSON）
  for (const entry of ['/', '/index.html', '/lab', '/lab.html', '/tools/layout/lab.html']) {
    const r = await fetch(base + entry, nav);
    assert.equal(r.status, 200, entry + ' 应能进布局台');
    assert.match(r.headers.get('content-type') || '', /text\/html/, entry + ' 应回 HTML');
    assert.ok((await r.text()).includes('id="toolPanel"'), entry + ' 应是布局台页面');
  }
  // 浏览器导航到打错的路径 → 302 回首页（否则用户会把 JSON 错误页当成"坏了"）
  const wrong = await fetch(base + '/not-a-real-page', Object.assign({ redirect: 'manual' }, nav));
  assert.equal(wrong.status, 302, '浏览器导航打错路径应重定向');
  assert.equal(wrong.headers.get('location'), '/', '应重定向到首页');
  // 但页面脚本 fetch 打错的 API 仍必须是 JSON（LS-3 的语义不能被这条改掉）
  const api404 = await fetch(base + '/api/nope', { headers: { accept: '*/*' } });
  assert.match(api404.headers.get('content-type') || '', /json/, 'fetch 打错 /api 仍回 JSON');
}));
test('LS-6 GET /api/layout 返回工作区当前的布局表（布局台启动靠它载入，否则会拿内置示例覆盖现有设计）', () => withServer(async (base) => {
  const body = await asJson(await fetch(base + '/api/layout'), 'GET /api/layout');
  assert.equal(body.ok, true, '工作区已有布局表时应 ok:true：' + JSON.stringify(body).slice(0, 120));
  assert.ok(body.bundle && body.bundle.screens && body.bundle.screens.hub, '应返回完整 bundle');
  assert.ok(body.path && body.path.indexOf('layout-bundle.raw.json') >= 0, '应给出文件路径');
  // 与磁盘上的真源一致（读的是同一份）
  const onDisk = JSON.parse(require('node:fs').readFileSync(body.path, 'utf8'));
  assert.deepEqual(Object.keys(body.bundle.screens).sort(), Object.keys(onDisk.screens).sort(), '返回的画面集合应与真源一致');
  assert.equal(body.bundle.screens.hub.elements.length, onDisk.screens.hub.elements.length, 'hub 元素数应与真源一致');
}));

test('LS-7 /api/manifest 的 GET/POST 语义（页面必须 POST；GET 只读上次结果）', () => withServer(async (base) => {
  const got = await fetch(base + '/api/manifest');
  const gbody = await asJson(got, 'GET /api/manifest');
  // 已生成过 → ok:true + cached；没生成过 → ok:false 且给出可操作提示。两种都不许是非 JSON。
  if (gbody.ok) assert.equal(gbody.cached, true, 'GET 应标记为 cached（不重算）');
  else assert.ok(gbody.hint && gbody.hint.length > 0, 'GET 未生成时应给 hint');
  const post = await fetch(base + '/api/manifest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const pbody = await asJson(post, 'POST /api/manifest');
  assert.equal(pbody.ok, true, 'POST 应重算并成功：' + JSON.stringify(pbody).slice(0, 140));
  assert.ok(pbody.summary && pbody.summary.total > 100, '应给出清单总览');
}));
