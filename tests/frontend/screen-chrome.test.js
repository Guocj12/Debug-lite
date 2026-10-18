'use strict';
/* D-192 屏即界面（page chrome）：**预览与真实产品都只显示那个屏**
 *
 * 用户口径（2026-10-17）：「预览和实际前端效果都应该直接只有这个屏，
 *   不应再有上面的 debuglitev3 和外面一圈白框。」
 *
 * 三个来源造成过"屏外多余的东西"：
 *   ① `public/index.html` 的页面级 `<h1>Debug-Lite v3 · 账号</h1>`；
 *   ② `render.js` 给**布局屏**也输出了 `<h2>` 标题；
 *   ③ `app.css` **没有 `body` 规则** ⇒ 深色屏坐在浏览器默认**白色**页面 + 8px 默认边距里（那圈白框）；
 *      预览侧还有 `#pvbox` 的 1px 描边阴影与 `.pvwrap` 的 10px 内边距。
 *
 * 编号：SC-1…SC-4。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
/** 去掉 HTML 注释 —— 注释里会**提到**被删掉的标签（说明文字），不剥会被自己的注释骗到 */
const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
/** 去掉 CSS 注释（同理：说明里会出现选择器名） */
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

const store = require('../../public/store.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
format.setLayout(require('../../public/layout-engine.js'), require('../../public/layout-data.js'));

/** 一个"已登录 + 有档案"的最小状态（hub 会走布局渲染） */
function hubState() {
  const st = store.createStore(store.initialState());
  st.dispatch({ type: 'session.set', token: 't', publicId: 'u_x', nickname: '甲', expiresAt: null, isAdmin: false });
  st.dispatch({
    type: 'profile.set',
    envelope: {
      ok: true, code: null, message: null, details: [],
      data: {
        nickname: '甲', publicId: 'u_x',
        progress: { tier: 'common', peakTier: 'common' },
        rating: { points: 0, games: 0, wins: 0, losses: 0, draws: 0 },
        slots: [{ slotId: 'slot1', name: '默认配置', isDefault: true, snapshotHash: 'h' }],
        activeSlotId: 'slot1', activeSlotName: '默认配置', activeSnapshotHash: 'h',
        viewedSlotId: 'slot1', battleSlot: 'slot1',
        pool: { inPool: true, drawnCount: 0 },
        record: { stats: { attack: {}, defense: {} }, unread: { attack: 0, defense: 0 } },
        flags: { unverifiedLoadout: false },
      },
    },
  });
  st.dispatch({
    type: 'configs.set',
    data: { ok: true, code: null, message: null, details: [], data: { slots: [{ slotId: 'slot1', name: '默认配置', loadout: null }], activeSlotId: 'slot1', maxSlots: 3 } },
  });
  st.dispatch({ type: 'view.go', view: 'hub' });
  return st;
}

/* ---------------- SC-1：页面骨架里没有应用标题 ---------------- */

test('SC-1 index.html 不再有页面级标题（只有 #view 一个容器）', () => {
  const html = stripHtmlComments(read('public/index.html'));
  assert.equal(html.indexOf('<h1'), -1, '页面级 <h1> 会让标题一直挂在屏上方');
  assert.equal(html.indexOf('Debug-Lite v3 · 账号'), -1, '那句「Debug-Lite v3 · 账号」必须消失');
  const divs = html.match(/<div\b[^>]*>/g) || [];
  assert.equal(divs.length, 1, 'index.html 只应有 #view 一个可见容器，实际：' + divs.join(' '));
  assert.match(divs[0], /id="view"/, '唯一的 div 必须是 #view');
});

/* ---------------- SC-2：布局屏不输出标题 ---------------- */

test('SC-2 布局屏的渲染输出：没有 <h2>、没有「Debug-Lite」，第一块就是屏', () => {
  const st = hubState();
  const vm = format.viewModel(st.getState(), null, false);
  assert.ok(vm.layout && Array.isArray(vm.layout.layers), '前置：hub 应走布局渲染');
  const html = render.render(vm);
  assert.equal(html.indexOf('<h2>'), -1, '布局屏就是整个界面，不该再画 <h2> 标题');
  assert.equal(html.indexOf('Debug-Lite'), -1, '屏上方不该出现「Debug-Lite」字样');
  assert.match(html.trim(), /^<div class="dl-screen"/, '渲染输出的第一块必须是 .dl-screen');
  // 标题仍然保留在 vm 里（<title> 与文档要用），只是不画到屏上
  assert.equal(typeof vm.title, 'string');
  assert.ok(vm.title.length > 0, 'vm.title 必须仍然存在（只是不渲染）');
});

test('SC-2b 文字屏（旧世代）**仍然**要标题 —— 这条口径只针对布局屏', () => {
  const st = store.createStore(store.initialState());
  st.dispatch({ type: 'view.go', view: 'login' });
  const html = render.render(format.viewModel(st.getState(), null, false));
  assert.match(html, /<h2>/, '文字屏靠 <h2> 标识自己，不能一起删掉');
});

/* ---------------- SC-3：页面就是屏幕（没有白框） ---------------- */

test('SC-3 app.css：body 深色铺满 + 布局屏绝对占满（白框的根因已消除）', () => {
  const css = stripCssComments(read('public/app.css'));
  const bodyRule = /html,body\{([^}]*)\}/.exec(css);
  assert.ok(bodyRule, 'app.css 必须有 html,body 规则（否则会落在浏览器默认白底上）');
  assert.match(bodyRule[1], /margin:0/, 'body 必须 margin:0（默认 8px 会留一圈白边）');
  assert.match(bodyRule[1], /background:var\(--dl-bg\)/, 'body 背景必须是深色（不是浏览器默认白）');
  assert.match(bodyRule[1], /height:100%/, 'body 要撑满视口');

  const screenRule = /#view>\.dl-screen\{([^}]*)\}/.exec(css);
  assert.ok(screenRule, '布局屏必须在 #view 里被显式铺满');
  assert.match(screenRule[1], /position:absolute/, '布局屏用绝对定位占满 #view');
  assert.match(screenRule[1], /inset:0/, '布局屏必须 inset:0（四边贴齐，不留缝）');
});

/* ---------------- SC-4：预览里也没有外框 ---------------- */

test('SC-4 预览：只有那个屏（#pvbox 无描边、.pvwrap 无内边距、不抄产品样式）', () => {
  const lab = read('tools/layout/lab.html');
  const css = stripCssComments(lab);

  const boxRule = /#pvbox\{([^}]*)\}/.exec(css);
  assert.ok(boxRule, '布局台应有 #pvbox 规则');
  assert.match(boxRule[1], /box-shadow:none/, '#pvbox 不该有 1px 描边/阴影（预览外面那圈框）');
  assert.equal(/box-shadow:\s*0\s+0\s+0\s+1px/.test(boxRule[1]), false, '不能再有 0 0 0 1px 的外框描边');

  const wrapRule = /\.pvwrap\{([^}]*)\}/.exec(css);
  assert.ok(wrapRule, '布局台应有 .pvwrap 规则');
  assert.match(wrapRule[1], /padding:0/, '.pvwrap 不该有内边距（屏要直接贴边）');

  // 预览必须加载产品真样式表（单一真源；D-191 也是这条）
  assert.match(lab, /'\/public\/app\.css'/, '预览必须加载 /public/app.css');
  const dup = lab.match(/#pvstage\s+\.dl-[a-z-]+\s*\{/g) || [];
  assert.deepEqual(dup, [], '不得再手抄产品的 .dl-* 样式：' + dup.join(', '));
});
