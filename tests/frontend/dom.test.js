'use strict';
// P6 R2 mount/dom 缝契约测试 —— 下载/文件选择（浏览器专属；node 下用全局桩）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let domMod;
before(async () => {
  domMod = await import('../../public/js/mount/dom.js');
});

test('R2 dom：download 走锚点创建/点击/清理 + revoke', async () => {
  const anchor = { href: null, download: null, clicked: false, click() { this.clicked = true; } };
  const created = [];
  const doc = {
    createElement: () => { created.push(anchor); return anchor; },
    body: { appended: 0, removed: 0, appendChild() { this.appended++; }, removeChild() { this.removed++; } },
  };
  const d = domMod.createDomHelpers(doc);
  d.download('dl-save-1.json', '{"schemaVersion":1}');
  assert.equal(anchor.clicked, true, '锚点已点击');
  assert.equal(anchor.download, 'dl-save-1.json');
  assert.ok(anchor.href && anchor.href.includes('blob'), 'objectURL');
  assert.equal(doc.body.appended, 1);
  assert.equal(doc.body.removed, 1);
});

test('R2 dom：pickText 成功/取消/读失败', async () => {
  let input = null;
  const doc = {
    createElement: () => (input = input || { type: '', accept: '', listeners: {}, files: null, addEventListener(t, fn) { this.listeners[t] = fn; }, click() { /* 触发由测试手动完成 */ } }),
    body: { appendChild() {}, removeChild() {} },
  };
  const d = domMod.createDomHelpers(doc);
  const prevReader = globalThis.FileReader;
  // 成功路径（注入 FileReader 桩）
  const results = [];
  globalThis.FileReader = class {
    constructor() { this.result = 'file-content'; }
    readAsText() { this.onload(); }
  };
  const p = d.pickText('.json').then((r) => results.push(r));
  input.files = ['save-text'];
  input.listeners.change();
  await new Promise((r) => setTimeout(r, 5));
  await p;
  assert.deepEqual(results, ['file-content'], 'onload → resolve 文本');
  // 取消（无文件）→ 不 resolve
  const results2 = [];
  const p2 = d.pickText().then((r) => results2.push(r));
  input.files = [];
  input.listeners.change();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(results2, [], '取消不 resolve');
  // 读失败 → resolve ''
  const results3 = [];
  const p3 = d.pickText().then((r) => results3.push(r));
  input.files = ['x'];
  globalThis.FileReader = class {
    readAsText() { this.onerror(); }
  };
  input.listeners.change();
  await new Promise((r) => setTimeout(r, 5));
  await p3;
  assert.deepEqual(results3, [''], 'onerror → 空文本');
  globalThis.FileReader = prevReader;
});
