'use strict';
/* D-193 布局台界面整理：**结构不变量**（防止"整理时把还在用的控件删了"）
 *
 * 用户口径（2026-10-17）：「现在这个布局工具太乱了，帮我整理下，
 *   把没用的提示信息都删掉，使用体验丝滑整洁一点」。
 *
 * 整理本身是主观的，但下面几条是**可机器判定**的，必须一直成立：
 *   LT-1  app 脚本里 `$('id')` 引用的每个 id 在 HTML 里**必须存在**
 *         （整理最容易犯的错：删掉一段"看起来只是提示"的 DOM，其实脚本在写它 → 运行时 null 崩）
 *   LT-2  右栏分区是可折叠 `<details>`，默认展开 ≤3 块（否则又变回一长条）
 *   LT-3  不再有"无 id 的静态讲解 hint"（纯说明性长文已清掉；有 id 的是 JS 写的活状态行）
 *   LT-4  顶栏已分组，且关键控件仍在
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const LAB = path.join(REPO, 'tools', 'layout', 'lab.html');
const html = fs.readFileSync(LAB, 'utf8');
const appScript = (html.match(/<script id="app">([\s\S]*?)<\/script>/) || [])[1] || '';
const coreScript = (html.match(/<script id="core">([\s\S]*?)<\/script>/) || [])[1] || '';

test('LT-1 app 脚本里 $(\'id\') 引用的每个 id 在 HTML 中都存在', () => {
  assert.ok(appScript.length > 1000, '应能抽到 <script id="app">');
  const refs = [...new Set([...appScript.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  assert.ok(refs.length > 100, '应抽出大量 id 引用，实际 ' + refs.length);
  const missing = refs.filter((id) => html.indexOf('id="' + id + '"') < 0);
  assert.deepEqual(missing, [],
    '这些 id 被脚本引用但 HTML 里已经没有了（整理时误删，运行到会 null 崩）：' + missing.join(', '));
});

test('LT-1b core 脚本里没有 DOM 依赖（纯逻辑，可被 Node 抽取）', () => {
  assert.ok(coreScript.length > 1000, '应能抽到 <script id="core">');
  assert.equal(/document\.|window\./.test(coreScript), false,
    'core 脚本不得碰 DOM（它是被 Node 抽取做纯数学断言的）');
});

test('LT-2 右栏分区是可折叠 <details>，默认展开 ≤3 块', () => {
  const right = html.slice(html.indexOf('<aside class="col right">'), html.indexOf('</aside>', html.indexOf('<aside class="col right">')));
  const secs = [...right.matchAll(/<details class="sect"([^>]*)>/g)];
  assert.ok(secs.length >= 10, '右栏应按用途拆成 ≥10 个分区，实际 ' + secs.length);
  const open = secs.filter((m) => /\bopen\b/.test(m[1]));
  assert.ok(open.length <= 3,
    '默认只该展开 ≤3 块（否则又变回一长条），实际展开 ' + open.length + ' 块');
  // 每个分区都要有 summary（否则收起来就点不开了）
  const summaries = [...right.matchAll(/<summary>/g)];
  assert.ok(summaries.length >= secs.length, '每个 details 分区都必须有 <summary>');
});

test('LT-3 不再有「无 id 的静态讲解 hint」（纯说明长文已清理）', () => {
  // 有 id 的 hint 是 JS 实时写的状态行，必须保留；无 id 的是静态讲解 → 已清掉
  const hints = [...html.matchAll(/<div class="hint"([^>]*)>/g)];
  const noId = hints.filter((m) => !/\bid="/.test(m[1]));
  assert.deepEqual(noId.map((m) => m[0]), [],
    '还有静态讲解 hint（无 id）：应该删除或把内容放进 title 提示');
});

test('LT-4 顶栏已分组，关键控件仍在', () => {
  const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));
  const groups = header.match(/class="grp"/g) || [];
  assert.ok(groups.length >= 5, '顶栏应按用途分组（≥5 组），实际 ' + groups.length);
  assert.equal(header.indexOf('dev 原型 · 单文件 · 无依赖'), -1, '那句冗长副标题应已删除');

  // 关键控件（脚本与测试都直接引用它们）
  const must = ['screenSel', 'editBp', 'grid', 'btnGuides', 'btnUndo', 'btnRedo', 'btnFit', 'btnAdd', 'btnDel',
    'btnImport', 'btnExport', 'btnCheck', 'btnPreview', 'btnSaveWs', 'btnApplyAll', 'btnManifest', 'btnAssets',
    'btnScreenAdd', 'btnScreenModal', 'btnScreenDel', 'btnStatus', 'btnMissing', 'btnMissingAll',
    'toolInfo', 'toolPanel', 'jsonPanel'];
  const gone = must.filter((id) => html.indexOf('id="' + id + '"') < 0);
  assert.deepEqual(gone, [], '关键控件被删了：' + gone.join(', '));
});

test('LT-5 顶栏「更多」下拉：打开后点别处会收起（不然一直挡着画布）', () => {
  assert.ok(html.indexOf('class="hdr-more"') >= 0, '应有「更多」下拉');
  assert.match(appScript, /hdr-more\[open\]/, '脚本里应有「点别处自动收起」的处理');
});
