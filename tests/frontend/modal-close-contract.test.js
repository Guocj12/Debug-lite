'use strict';
/* D-190 弹窗关闭契约：**点遮罩关闭，弹窗不再有关闭键**（用户口径 2026-10-05）
 *
 * 「弹窗外的遮罩部分点击后关闭弹窗，无需再为弹窗添加关闭键。不论预览还是实际逻辑都是这样」
 *
 * 这条口径有一个直接后果：**遮罩成了弹窗的唯一出口**。所以它不能只当约定，
 * 必须由机器钉死三件事：
 *   MC-1 布局表里任何弹窗都**不得**再有 `action:'modal-close'` 的元素（关闭键已取消）
 *   MC-2 每个弹窗的 `mask.closeOnMaskClick` 都**不得**为 false（否则是死胡同）
 *   MC-3 渲染出的遮罩真的带 `data-action="modal-close"`，且执行后弹窗栈**逐层减少**
 *   MC-4 引擎把"禁用遮罩关闭的弹窗"判为 **error**（从约定升级为门禁）
 *
 * 注意 MC-4 是 MC-1 的必要配套：取消了关闭键以后，一旦有人把遮罩关掉，
 *   玩家点哪儿都关不掉 —— 这类"死胡同"必须在布局表校验阶段就拦下。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../../public/layout-engine.js');
const store = require('../../public/store.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const actions = require('../../public/actions.js');
const layoutData = require('../../public/layout-data.js');

format.setLayout(require('../../public/layout-engine.js'), layoutData);

/** 造一个"已登录 + 有档案 + 仓库有货 + 弹窗栈压了两层"的产品状态 */
function previewState() {
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
  st.dispatch({
    type: 'warehouse.set',
    envelope: {
      ok: true, code: null, message: null, details: [],
      data: {
        buckets: {
          role: [{ uid: 'item_0', kind: 'role', templateId: 'role_bal', name: '均衡', quality: 'common', slotCount: 1, slots: [], stats: { hp: 90, atk: 12, def: 7, sp: 55, mp: 58 }, regen: { mp: 2, sp: 2 }, pluginPoints: 3 }],
          skill: [], rolePlugin: [], skillPlugin: [], package: [], aiNode: [],
        },
        usage: {}, caps: { role: 500 }, counts: { role: 1 },
      },
    },
  });
  st.dispatch({ type: 'view.go', view: 'hub' });
  st.dispatch({ type: 'warehouse.tab.set', bucket: 'role' });
  return st;
}

/* ---------------- MC-1：布局表里不得再有关闭键 ---------------- */

test('MC-1 布局表里任何弹窗都不得再有 action=modal-close 的元素（关闭键已取消）', () => {
  const offenders = [];
  Object.keys(layoutData.screens).forEach((name) => {
    const sc = layoutData.screens[name];
    (sc.elements || []).forEach((e) => {
      if (e.action === 'modal-close') offenders.push(name + '/' + e.id);
    });
  });
  assert.deepEqual(offenders, [],
    '这些元素还是「关闭键」（用户口径：不必再为弹窗添加关闭键，点遮罩即可）：' + offenders.join(', '));
});

/* ---------------- MC-2：遮罩必须是可用出口 ---------------- */

test('MC-2 每个弹窗的 mask.closeOnMaskClick 不得为 false（遮罩是唯一出口）', () => {
  const dead = [];
  Object.keys(layoutData.screens).forEach((name) => {
    const sc = layoutData.screens[name];
    if (sc.role !== 'modal') return;
    const mk = sc.mask || C.DEFAULT_MASK;
    if (mk.closeOnMaskClick === false) dead.push(name);
  });
  assert.deepEqual(dead, [], '这些弹窗点遮罩关不掉，而且已经取消关闭键 → 死胡同：' + dead.join(', '));
});

/* ---------------- MC-3：渲染出的遮罩真的能逐层关闭 ---------------- */

test('MC-3 遮罩带 data-action=modal-close；执行后弹窗栈逐层减少（仓库 → 详情 → 关闭）', async () => {
  const st = previewState();
  st.dispatch({ type: 'hub.modal.push', screen: 'modal_warehouse', ctx: {} });
  st.dispatch({ type: 'warehouse.item.set', uid: 'item_0', bucket: 'role' });
  st.dispatch({ type: 'hub.modal.push', screen: 'modal_item_detail', ctx: {} });

  const html = render.render(format.viewModel(st.getState(), null, false));
  const masks = (html.match(/class="dl-mask"/g) || []).length;
  const closable = (html.match(/class="dl-mask"[^>]*data-action="modal-close"/g) || []).length;
  assert.ok(masks >= 2, '两层弹窗应各有一个遮罩，实际 ' + masks);
  assert.equal(closable, masks, '每个遮罩都必须带 data-action="modal-close"（这是唯一的关闭途径）');

  // 真跑产品动作：连点两次遮罩 = 逐层关闭
  const run = (name, payload) => {
    const ctx = {
      state: st.getState(), dispatch: (a) => st.dispatch(a),
      api: {}, format, storage: {}, actions: actions.ACTIONS,
    };
    return Promise.resolve(actions.ACTIONS[name].run(ctx, payload || null));
  };
  assert.equal(st.getState().hub.modals.length, 2, '前置：两层弹窗');
  await run('modal-close');
  assert.equal(st.getState().hub.modals.length, 1, '第一次点遮罩 → 关掉详情，回到仓库弹窗');
  await run('modal-close');
  assert.equal(st.getState().hub.modals.length, 0, '第二次点遮罩 → 关掉仓库弹窗，回到主界面');
});

/* ---------------- MC-4：死胡同进校验器 ---------------- */

test('MC-4 引擎把「禁用遮罩关闭的弹窗」判为 error（否则取消关闭键后会关不掉）', () => {
  const bundle = JSON.parse(JSON.stringify(layoutData));
  // 前置：原样不该有这条 error
  const before = C.validateBundle(bundle).filter((i) => i.level === 'error' && /无法关闭/.test(i.msg));
  assert.deepEqual(before, [], '前置：默认布局表不应有「无法关闭」error');

  // 把仓库弹窗的遮罩关闭关掉 → 必须立刻报 error
  bundle.screens.modal_warehouse.mask.closeOnMaskClick = false;
  const after = C.validateBundle(bundle).filter((i) => i.level === 'error' && /无法关闭/.test(i.msg));
  assert.equal(after.length, 1, '禁用遮罩关闭 + 没有关闭键 = 死胡同，必须报 error');
  assert.match(after[0].msg, /modal_warehouse/, 'error 必须点名是哪个画面：' + after[0].msg);

  // 反向：blocksBackground=false 只该是 warn（底下的按钮能被点到）
  bundle.screens.modal_item_detail.mask.blocksBackground = false;
  const warn = C.validateBundle(bundle).filter((i) => i.level === 'warn' && /不拦背景点击/.test(i.msg));
  assert.equal(warn.length, 1, '遮罩不拦背景 → warn（不是 error）');
});

/* ---------------- 顺带：详情弹窗的操作按钮仍在（只取消了关闭键）---------------- */

test('MC-5 取消关闭键 ≠ 取消操作按钮：详情弹窗仍有「开包 / 分解」', () => {
  const det = layoutData.screens.modal_item_detail;
  const ids = (det.elements || []).map((e) => e.id);
  assert.ok(ids.indexOf('det_open') >= 0, '「开包」按钮应保留');
  assert.ok(ids.indexOf('det_dismantle') >= 0, '「分解」按钮应保留');
  assert.equal(ids.indexOf('det_close'), -1, '「关闭」按钮应已移除');
  const wh = layoutData.screens.modal_warehouse;
  assert.equal((wh.elements || []).map((e) => e.id).indexOf('wh_close'), -1, '仓库的「关闭」按钮应已移除');
  // 选项卡与网格原型必须还在（别误删）
  assert.equal((wh.elements || []).filter((e) => e.id.indexOf('tab_') === 0).length, 6, '6 个选项卡应保留');
});

/* ==================================================================
 * MC-6 / MC-7 —— 「点遮罩关不掉」的真实故障回归（2026-10-17 用户报告）
 *
 * 症状：**预览里**点弹窗外的遮罩没反应（产品是好的）。
 * 根因：预览**手抄了一份**产品的 `.dl-*` 样式，抄的时候把 `.dl-layer` 写成了
 *   `position:absolute;inset:0` —— 它铺满全屏、排在遮罩**之后**，把整张遮罩盖住了。
 *   产品侧 `.dl-layer` 根本没有布局规则（静态、零高），所以只有预览坏。
 * 为什么之前测不出来：jsdom 没有命中测试，测试是**直接往遮罩节点派发 click**，
 *   绕过了"点击到底落在哪个元素上"。所以必须用**结构性断言**守住这条不变量。
 * ================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const REPO = path.join(__dirname, '..', '..');
const CSS = fs.readFileSync(path.join(REPO, 'public', 'app.css'), 'utf8');
const LAB = fs.readFileSync(path.join(REPO, 'tools', 'layout', 'lab.html'), 'utf8');

/** 取出某个选择器的整条规则体（支持多选择器分组，按 `,` 拆分后精确匹配） */
function cssRulesOf(css, selector) {
  // 先剥掉注释：否则 `[^{}]+` 会把注释文本当成选择器的一部分（真实踩到）
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const sels = m[1].split(',').map((s) => s.trim());
    if (sels.indexOf(selector) >= 0) out.push(m[2]);
  }
  return out;
}

test('MC-6 产品 CSS：`.dl-layer` 绝不能有尺寸/定位（否则会盖住遮罩，点空白关不掉）', () => {
  const bodies = cssRulesOf(CSS, '.dl-layer');
  assert.ok(bodies.length > 0, 'app.css 必须显式声明 .dl-layer（把"不接收点击"写死）');
  const all = bodies.join(';');
  // 必须：明确不接收点击
  assert.match(all, /pointer-events\s*:\s*none/, '.dl-layer 必须 pointer-events:none（它只是包装层）');
  // 禁止：任何会让它铺满并盖住遮罩的写法
  const banned = [
    [/position\s*:\s*absolute/, 'position:absolute'],
    [/position\s*:\s*fixed/, 'position:fixed'],
    [/\binset\s*:/, 'inset'],
    [/height\s*:\s*100%/, 'height:100%'],
  ];
  banned.forEach(([re, name]) => {
    assert.ok(!re.test(all), `.dl-layer 不得声明 ${name} —— 那会铺满全屏盖住遮罩（真实踩过的故障）`);
  });
});

test('MC-7 预览不得手抄产品 `.dl-*` 样式（必须加载 /public/app.css 单一真源）', () => {
  // 预览用的就是产品渲染，样式必须来自同一份文件；抄一份必然漂移（本轮就是这么坏的）
  assert.ok(LAB.indexOf("'/public/app.css'") >= 0,
    '布局台必须在预览里加载 /public/app.css（单一真源）');
  // 不许再出现 `#pvstage .dl-mask` / `#pvstage .dl-layer` 之类的局部副本
  const dup = LAB.match(/#pvstage\s+\.dl-[a-z-]+\s*\{/g) || [];
  assert.deepEqual(dup, [],
    '布局台里不应再有 `#pvstage .dl-*` 的样式副本（会与产品漂移）：' + dup.join(', '));
});

test('MC-8 渲染出的弹窗结构：遮罩与元素同层，包装层不产生点击拦截', () => {
  // 结构不变量：.dl-modal > (.dl-mask, .dl-layer > .dl-el*)
  //   · 遮罩必须是 .dl-modal 的**直接子元素**（这样它 inset:0 才盖住整屏）
  //   · 包装层不得带内联尺寸样式（渲染层不写，样式层也不许给）
  const lay = {
    canvas: layoutData.canvas,
    layers: [
      { name: 'hub', role: 'screen', elements: [] },
      { name: 'modal_warehouse', role: 'modal', mask: layoutData.screens.modal_warehouse.mask, elements: layoutData.screens.modal_warehouse.elements },
    ],
  };
  const html = render.render({ title: 't', layout: lay });
  // 遮罩紧跟在 .dl-modal 之后（直接子元素）
  assert.match(html, /<div class="dl-modal"[^>]*><div class="dl-mask" data-action="modal-close"/,
    '遮罩必须是 .dl-modal 的第一个直接子元素');
  // 包装层不得带 style（渲染层一旦给它写尺寸，就会复现"盖住遮罩"）
  assert.equal(/<div class="dl-layer"[^>]*style=/.test(html), false,
    '.dl-layer 不得带内联 style（尺寸/定位会盖住遮罩）');
  // 兜底层：产品 app.js 与预览 pvWire 都必须有"点包装层 = 关闭"的 DOM 级兜底
  const APP = fs.readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');
  assert.match(APP, /isModalChrome/, 'app.js 应有 isModalChrome 兜底（不依赖 CSS 的 pointer-events）');
  assert.match(LAB, /pvRun\('modal-close'/, '预览也必须有"点包装层 = 关闭"的兜底');
});

