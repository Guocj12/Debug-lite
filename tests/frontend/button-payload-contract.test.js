'use strict';
/* tests/frontend/button-payload-contract.test.js —— 「按钮字段 → data-* → payload」三层契约（D-179）
 *
 * 背景（用户实测缺陷的第二个根因）：`format.js` 早就产出 `node`（加积木节点）与 `preset`（套用模板）
 *   两个按钮字段，但 `render.js` 的 targetAttrs 不搬运、`app.js` 的 payloadOf 不收集 →
 *   点击后 payload 为空 → `ai-node-append` 直接 return、`ai-bp-preset` 报"模板不在清单里"，
 *   积木编辑器最核心的两个交互**完全失效**，而当时所有测试都是直接调用动作函数（自造 payload），
 *   于是又一次全绿。
 *
 * 机器判定：
 *   BP-1  render.js 搬运的字段集合 == app.js payloadOf 的 keys 集合（双向，防单边漂移）
 *   BP-2  format.js 全部按钮对象的字段 ⊆ {action,label,kind,disabled} ∪ 搬运字段（防"产出了没人搬的字段"）
 *   BP-3  字段级往返：真 DOM 事件委托下，每个字段都能从 vm → HTML → payload 原样回来
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createBrowser } = require('../helpers/browser.js');

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

// 按钮上"非载荷"的排版字段
const LAYOUT_FIELDS = new Set(['action', 'label', 'kind', 'disabled']);

function transportedFields() {
  const src = read('render.js');
  const out = new Set();
  for (const m of src.matchAll(/button\.([a-zA-Z][a-zA-Z0-9]*)/g)) out.add(m[1]);
  for (const f of LAYOUT_FIELDS) out.delete(f);
  return out;
}

function payloadKeys() {
  const src = read('app.js');
  const m = /var keys = \[([^\]]*)\]/.exec(src);
  assert.ok(m, 'app.js 的 payloadOf keys 数组应可解析');
  const out = new Set([...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  // 紧随其后的 keys.push('node', 'preset') 也算（D-179 的追加写法）
  for (const p of src.matchAll(/keys\.push\(([^)]*)\)/g)) {
    for (const x of p[1].matchAll(/'([^']+)'/g)) out.add(x[1]);
  }
  return out;
}

test('BP-1 render.js 搬运字段 == app.js payloadOf 收集字段（双向相等）', () => {
  const transported = transportedFields();
  const collected = payloadKeys();
  const onlyRender = [...transported].filter((f) => !collected.has(f)).sort();
  const onlyApp = [...collected].filter((f) => !transported.has(f)).sort();
  assert.deepEqual(onlyRender, [], 'render.js 搬了但 app.js 不收（点了会丢载荷）');
  assert.deepEqual(onlyApp, [], 'app.js 收了但 render.js 不搬（永远拿不到）');
  assert.ok(collected.size >= 15, `载荷字段数可疑地少：${[...collected].join(',')}`);
});

test('BP-2 format.js 的按钮字段必须都被搬运（否则该字段永远到不了动作）', () => {
  const src = read('format.js');
  const transported = transportedFields();
  const allowed = new Set([...LAYOUT_FIELDS, ...transported]);
  const found = new Map();
  // 扫 `{ ... action: 'x' ... }` 形状的按钮对象字面量
  for (const m of src.matchAll(/\{[^{}]*\baction:\s*[^{}]*\}/g)) {
    const body = m[0];
    for (const k of body.matchAll(/(?:^|[,{\s])([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g)) {
      const key = k[1];
      if (/^[A-Z][A-Z0-9_]*$/.test(key)) continue;   // 常量标识符（三目/取值）不是字段名
      found.set(key, (found.get(key) || 0) + 1);
    }
  }
  const orphans = [...found.keys()].filter((k) => !allowed.has(k)).sort();
  assert.deepEqual(orphans, [],
    `这些字段被 format 产出、但 render/app 都不搬运（对应按钮点了没反应）：${orphans.join(',')}`);
  // 反向哨兵：本测必须真的扫到字段，否则正则失效会变"永远绿"
  assert.ok(found.has('addr') && found.has('node') && found.has('preset'),
    `扫描结果可疑：${[...found.keys()].join(',')}`);
});

test('BP-3 字段级往返：vm → HTML(data-*) → app.js payload 同名键（真 DOM 委托）', async () => {
  const h = await createBrowser();
  assert.deepEqual(h.errors, [], '脚本装配抛异常');
  assert.ok(await h.ready(), '启动自检未结束');
  const seen = [];
  // 探针动作只进沙箱内的注册表（vm 上下文独立，不污染其它测试的 require 实例）
  h.DL.actions.ACTIONS['zz-probe'] = { label: '探针', run: function (ctx, payload) { seen.push(payload); return Promise.resolve(); } };
  const vm = (button) => ({
    pageTitle: 't', title: 't', notice: null, hint: '', result: null,
    lines: [], rows: [], confirm: null, fields: [], buttons: [button], enterAction: null, modal: null,
  });
  const cases = [
    ['playerId', 'pl_x'], ['publicId', 'u_x'], ['uid', 'item_1'], ['slot', 'slot2'], ['bucket', 'role'],
    ['pos', 'role'], ['idx', '3'], ['empty', true], ['aiId', 'ai_1'], ['tier', 'rare'],
    ['addr', 'body[1].inputs[0]'], ['field', 'x'], ['value', '7'], ['node', 'a_wait'], ['preset', 'preset_rush'],
  ];
  for (const [key, value] of cases) {
    const button = { action: 'zz-probe', label: '探针', kind: 'button' };
    button[key] = value;
    h.setHtml(h.DL.render.render(vm(button)));
    const expected = {};
    expected[key] = key === 'empty' ? '1' : String(value);
    h.click('zz-probe');
    const got = seen.pop();
    assert.deepEqual(got, expected, `字段 ${key} 未能原样回到 payload（实际 ${JSON.stringify(got)}）`);
  }
  // 多字段并存也要一起回来
  h.setHtml(h.DL.render.render(vm({ action: 'zz-probe', label: '探针', kind: 'button', addr: 'body[0]', field: 'x', value: '9', node: 'a_wait', preset: 'p1', aiId: 'ai_9' })));
  h.click('zz-probe');
  assert.deepEqual(seen.pop(), { addr: 'body[0]', aiId: 'ai_9', field: 'x', node: 'a_wait', preset: 'p1', value: '9' });
});
