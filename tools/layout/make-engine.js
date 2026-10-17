'use strict';
/* tools/layout/make-engine.js —— 把布局台的引擎抽成前端正式模块 public/layout-engine.js
 *
 * 为什么要生成：引擎（断点解算 / 占位符替换 / 多边形解析…）必须是**单一真源**，
 *   布局台与产品渲染层都要用同一份。这里从布局台的 `<script id="core">` 直接抽出来包成 UMD，
 *   并写一个哈希到产物头部 —— 测试会核对"产物 == 布局台里的 core"，防止两边漂移。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(__dirname, 'lab.html'), 'utf8');
const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const digest = crypto.createHash('sha256').update(core).digest('hex').slice(0, 16);

const out = [
  "'use strict';",
  '/* public/layout-engine.js —— **由 tools/layout/make-engine.js 生成，请勿手改**',
  ' * 真源：tools/layout/lab.html 的 <script id="core">（core digest: ' + digest + '）',
  ' * 职责：布局表的纯逻辑 —— 归一化 / 断点解算 / 锚点 / 占位符替换 / 多边形解析 / 校验。',
  ' *   不碰 DOM、不发请求、不读响应字段（投影仍归 format.js）。',
  ' * 形态：零依赖双模模块（浏览器挂 window.DL.layoutEngine，Node 可 require）。',
  ' */',
  '(function (root, factory) {',
  '  var mod = factory();',
  "  if (typeof module !== 'undefined' && module.exports) module.exports = mod;",
  '  root.DL = root.DL || {};',
  '  root.DL.layoutEngine = mod;',
  "})(typeof window !== 'undefined' ? window : globalThis, function () {",
  core.replace(/^\s*var LAYOUT_CORE = \(function \(\) \{/, '  var CORE = (function () {').replace(/\}\)\(\);\s*$/, '})();'),
  '  CORE.CORE_DIGEST = ' + JSON.stringify(digest) + ';',
  '  return CORE;',
  '});',
  '',
].join('\n');

fs.writeFileSync(path.join(ROOT, 'public', 'layout-engine.js'), out);
console.log('已生成 public/layout-engine.js（core digest ' + digest + '，' + out.length + ' 字节）');
