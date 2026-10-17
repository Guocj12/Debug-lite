'use strict';
/* D-188 引擎专项：网格自动流式排布（`grid.flow`）+ 按钮按下四模式（`press`）+ 双素材（`assetPressed`）。
 *
 * 为什么单独一个文件：这三件事是本轮（2026-10-05）新增的**引擎能力**，
 *   且都被前端与布局台共同依赖 —— 判据一旦漂移，"设计器里看着对、产品不对"。
 *   所以这里断言的是**引擎函数本身**（`gridFlowRects` / `pressActive` / `layoutAt` 产出），
 *   而不是"某个屏渲染出什么"。
 *
 * 设计依据：`docs/frontend/09-layout-driven-ui.md` §3.2 / §3.3 / §3.4。
 * 编号：GF-* = grid.flow；PB-* = press/assetPressed。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const C = require('../../public/layout-engine.js');

/* ============================== GF: grid.flow ============================== */

test('GF-1 列数由容器宽与格子尺寸算出（不硬性规定几乘几）', () => {
  // 容器 400 宽，padX 8 → usable 384；cell 72 + gap 8 = 80 → floor((384+8)/80) = 4
  const r = C.gridFlowRects([0, 0, 400, 300], { cellW: 72, cellH: 72, gapX: 8, gapY: 8, padX: 8, padY: 8 }, 10);
  assert.equal(r.cols, 4, '应算出 4 列');
  assert.equal(r.rows, 3, '10 个 → 3 行');
  assert.equal(r.rects.length, 10);

  // 容器变窄 → 列数自动变少（同一份网格配置）
  const narrow = C.gridFlowRects([0, 0, 200, 300], { cellW: 72, cellH: 72, gapX: 8, gapY: 8, padX: 8, padY: 8 }, 10);
  assert.equal(narrow.cols, 2, '窄容器应自动降为 2 列');

  // 再窄 → 至少 1 列（不能变 0）
  const tiny = C.gridFlowRects([0, 0, 40, 300], { cellW: 72, cellH: 72, gapX: 8, gapY: 8, padX: 8, padY: 8 }, 3);
  assert.equal(tiny.cols, 1, '再窄也要保证 1 列');

  // 显式 cols 优先（布局台可强制列数）
  const forced = C.gridFlowRects([0, 0, 400, 300], { cellW: 72, cellH: 72, cols: 3 }, 7);
  assert.equal(forced.cols, 3, '显式 cols 应优先于自动计算');
});

test('GF-2 排布顺序 = 从左到右、从上到下（用户口径原文）', () => {
  const r = C.gridFlowRects([0, 0, 400, 300], { cellW: 72, cellH: 72, gapX: 8, gapY: 8, padX: 8, padY: 8 }, 10);
  // 第 1 个在第 1 行第 1 列
  assert.deepEqual(r.rects[0], [8, 8, 72, 72]);
  // 第 4 个仍在第 1 行（满 4 列才换行）
  assert.deepEqual(r.rects[3], [8 + 3 * 80, 8, 72, 72], '第 4 个应在第 1 行第 4 列');
  // 第 5 个 → 换行到第 2 行第 1 列
  assert.deepEqual(r.rects[4], [8, 8 + 80, 72, 72], '第 5 个应换行到第 2 行第 1 列');
  // 第 9 个 → 第 3 行第 1 列
  assert.deepEqual(r.rects[8], [8, 8 + 160, 72, 72], '第 9 个应在第 3 行第 1 列');
});

test('GF-3 内容高度随行数增长（竖放不下 → 外层可滚动的依据）', () => {
  const g = { cellW: 72, cellH: 72, gapX: 8, gapY: 8, padX: 8, padY: 8 };
  const one = C.gridFlowRects([0, 0, 400, 300], g, 4);      // 1 行
  const three = C.gridFlowRects([0, 0, 400, 300], g, 10);   // 3 行
  // contentH = padY*2 + rows*cellH + (rows-1)*gapY
  assert.equal(one.contentH, 16 + 72, '1 行：16 + 72');
  assert.equal(three.contentH, 16 + 3 * 72 + 2 * 8, '3 行：16 + 216 + 16');
  assert.ok(three.contentH > one.contentH, '行数多 → 内容高必须更大（否则外层永远滚不动）');
  assert.ok(three.contentH <= 300, '本配置 3 行仍装得进 300 高（248 ≤ 300）—— 这是"竖放得下"');

  // 把行数堆到超出容器高：9 行 = 16 + 9*72 + 8*8 = 16+648+64 = 728 > 300
  const nine = C.gridFlowRects([0, 0, 400, 300], g, 36);
  assert.equal(nine.rows, 9, '36 个 / 4 列 = 9 行');
  assert.ok(nine.contentH > 300, '9 行内容高 728 应超出容器高 300（这就是"竖放不下 → 要滚"）');
});

test('GF-4 空列表：仍算出列数（布局台要知道一行能放几个），行数为 0', () => {
  // 无 padX → 可行宽 400；floor((400+8)/80) = 5 列
  const noPad = C.gridFlowRects([0, 0, 400, 300], { cellW: 72, cellH: 72, gapX: 8 }, 0);
  assert.equal(noPad.cols, 5, '空列表也要给出列数（可行宽 400 → 5 列）');
  assert.equal(noPad.rows, 0);
  assert.deepEqual(noPad.rects, []);
  assert.equal(noPad.contentH, 0, 'padY 缺省 0 → 内容高 0');

  // 带 padX 8 → 可行宽 384 → 4 列（与 GF-1 同口径）
  const padded = C.gridFlowRects([0, 0, 400, 300], { cellW: 72, cellH: 72, gapX: 8, padX: 8 }, 0);
  assert.equal(padded.cols, 4, 'padX 8 会占掉可用宽度 → 4 列');
  assert.equal(padded.rows, 0);
});

test('GF-5 缺 cellW/cellH 不崩、不产生 NaN（畸形输入护栏）', () => {
  const noCell = C.gridFlowRects([0, 0, 400, 300], {}, 5);
  assert.ok(Number.isInteger(noCell.cols) && noCell.cols >= 1, '没给格子尺寸也要给合法列数');
  assert.ok(noCell.rects.every((rc) => rc.every((v) => typeof v === 'number' && isFinite(v))), '不得产生 NaN');
  const noRect = C.gridFlowRects(null, { cellW: 72, cellH: 72 }, 3);
  assert.ok(noRect.rects.every((rc) => rc.every((v) => isFinite(v))), '容器 rect 缺失也不得产生 NaN');
});

/* ============================== PB: press ============================== */

const PRESS_BASE = {
  version: 1,
  canvas: { w: 100, h: 100 },
  breakpoints: { landscape: { w: 100, h: 100, adapt: 'fit', fit: 'contain' } },
};

test('PB-1 pressActive：state 模式由状态键的值决定（含数组多值）', () => {
  assert.equal(C.pressActive({ press: 'state', pressKey: 'activeSlot', pressWhen: 1 }, { activeSlot: 1 }), true);
  assert.equal(C.pressActive({ press: 'state', pressKey: 'activeSlot', pressWhen: 1 }, { activeSlot: 2 }), false);
  // 数组 = 多值命中
  assert.equal(C.pressActive({ press: 'state', pressKey: 'activeSlot', pressWhen: [1, 3] }, { activeSlot: 3 }), true);
  assert.equal(C.pressActive({ press: 'state', pressKey: 'activeSlot', pressWhen: [1, 3] }, { activeSlot: 2 }), false);
  // 字符串化比较（"1" 命中 1）—— 与 whenMatches 同口径
  assert.equal(C.pressActive({ press: 'state', pressKey: 'activeSlot', pressWhen: 1 }, { activeSlot: '1' }), true);
});

test('PB-2 pressActive：非 state 模式恒 false；缺键/缺值一律 false（不误按下）', () => {
  for (const mode of ['tap', 'hover', 'sticky']) {
    assert.equal(C.pressActive({ press: mode, pressKey: 'activeSlot', pressWhen: 1 }, { activeSlot: 1 }), false,
      mode + ' 不参与 state 判定');
  }
  assert.equal(C.pressActive({ press: 'state', pressWhen: 1 }, { activeSlot: 1 }), false, '缺 pressKey → false');
  assert.equal(C.pressActive({ press: 'state', pressKey: 'activeSlot' }, { activeSlot: 1 }), false, '缺 pressWhen → false');
  assert.equal(C.pressActive({ press: 'state', pressKey: 'activeSlot', pressWhen: 1 }, {}), false, '当前态没给值 → false');
  assert.equal(C.pressActive(null, { activeSlot: 1 }), false, 'null 元素 → false');
});

test('PB-3 PRESS_MODES 就是那四个（枚举封闭）', () => {
  assert.deepEqual(C.PRESS_MODES.slice().sort(), ['hover', 'state', 'sticky', 'tap']);
});

test('PB-4 normalizeElement：press / pressKey / pressWhen / assetPressed 原样保留', () => {
  const el = C.normalizeElement({
    id: 'b1', kind: 'button', action: 'x', rect: [0, 0, 10, 10],
    asset: 'a.webp', assetPressed: 'a_pressed.webp',
    press: 'state', pressKey: 'battleSlot', pressWhen: [1, 2],
  });
  assert.equal(el.asset, 'a.webp');
  assert.equal(el.assetPressed, 'a_pressed.webp');
  assert.equal(el.press, 'state');
  assert.equal(el.pressKey, 'battleSlot');
  assert.deepEqual(el.pressWhen, [1, 2]);

  // 非法 press **原样保留**交校验器报（与 scroll.dir/font 同口径，不静默改成默认值）
  const bad = C.normalizeElement({ id: 'b2', kind: 'button', action: 'x', rect: [0, 0, 10, 10], press: 'nope' });
  assert.equal(bad.press, 'nope', '非法 press 必须原样保留');
});

test('PB-5 layoutAt：输出 pressed 与 assetPressed（模板替换也生效）', () => {
  const layout = {
    ...PRESS_BASE,
    elements: [
      { id: 'p1', kind: 'button', action: 'a', rect: [0, 0, 10, 10], press: 'state', pressKey: 'activeSlot', pressWhen: 1 },
      { id: 'p2', kind: 'button', action: 'a', rect: [10, 0, 10, 10], press: 'state', pressKey: 'activeSlot', pressWhen: 2 },
      { id: 'p3', kind: 'button', action: 'a', rect: [20, 0, 10, 10], assetPressed: '{roleIcon}', press: 'tap' },
    ],
  };
  const out = C.layoutAt(layout, 'landscape', { activeSlot: 1 }, { roleIcon: 'assets/role/x.webp' });
  const byId = {};
  out.forEach((e) => { byId[e.id] = e; });
  assert.equal(byId.p1.pressed, true, 'activeSlot=1 → p1 按下');
  assert.equal(byId.p2.pressed, false, 'activeSlot=1 → p2 不按下');
  assert.equal(byId.p3.press, 'tap');
  assert.equal(byId.p3.assetPressed, 'assets/role/x.webp', 'assetPressed 应过模板替换');
});

test('PB-6 validateLayout：press=state 缺键、非法 press、只给按下图 → 报错/告警', () => {
  function issuesOf(el) {
    return C.validateLayout({ ...PRESS_BASE, elements: [el] }, []);
  }
  const mk = (extra) => Object.assign({ id: 'e1', kind: 'button', action: 'act', rect: [0, 0, 10, 10] }, extra);

  assert.ok(issuesOf(mk({ press: 'bogus' })).some((i) => i.level === 'error' && /press 非法/.test(i.msg)));
  assert.ok(issuesOf(mk({ press: 'state', pressWhen: 1 })).some((i) => i.level === 'error' && /pressKey/.test(i.msg)));
  assert.ok(issuesOf(mk({ press: 'state', pressKey: 'activeSlot' })).some((i) => i.level === 'error' && /pressWhen/.test(i.msg)));
  assert.ok(issuesOf(mk({ press: 'state', pressKey: 'nope', pressWhen: 1 })).some((i) => i.level === 'error' && /pressKey 非法/.test(i.msg)));
  assert.ok(issuesOf(mk({ assetPressed: 'p.webp' })).some((i) => i.level === 'warn' && /assetPressed/.test(i.msg)));

  // 合法配置 → 不应有 press 相关 error
  const ok = issuesOf(mk({ press: 'state', pressKey: 'activeSlot', pressWhen: 1, asset: 'a.webp', assetPressed: 'b.webp' }));
  assert.ok(!ok.some((i) => i.level === 'error' && /press/.test(i.msg)), '合法 press 不应报 error：' + JSON.stringify(ok));
});

test('PB-7 validateLayout：grid.flow 缺格尺寸 → error；没 scroll → warn', () => {
  function issuesOf(el) {
    return C.validateLayout({ ...PRESS_BASE, elements: [el] }, []);
  }
  const mk = (extra) => Object.assign({ id: 'g1', kind: 'deco', rect: [0, 0, 100, 100] }, extra);
  assert.ok(issuesOf(mk({ grid: { flow: true } })).some((i) => i.level === 'error' && /grid\.flow/.test(i.msg)),
    'flow 但没 cellW/cellH → error');
  assert.ok(issuesOf(mk({ grid: { flow: true, cellW: 10, cellH: 10 } })).some((i) => i.level === 'warn' && /没有 scroll/.test(i.msg)),
    'flow 但没 scroll → warn（物品多了会被裁掉）');
  assert.ok(issuesOf(mk({ grid: { autoHeight: true, cellW: 10, cellH: 10 } })).some((i) => i.level === 'warn' && /autoHeight/.test(i.msg)),
    'autoHeight 没 scroll → warn');
});

/* ============================== 引擎 ↔ 布局台一致性 ============================== */

test('PB-8 布局台 core 与 public/layout-engine.js 是同一份（digest 相等）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'layout', 'lab.html'), 'utf8');
  const m = html.match(/<script id="core">([\s\S]*?)<\/script>/);
  assert.ok(m, 'lab.html 应有 <script id="core">');
  const digest = crypto.createHash('sha256').update(m[1]).digest('hex').slice(0, 16);
  assert.equal(digest, C.CORE_DIGEST,
    'core digest 不一致：改引擎后必须重跑 node tools/layout/make-engine.js');
});

test('PB-9 新能力在两侧都可达（布局台 core 与产品导出同一批符号）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'tools', 'layout', 'lab.html'), 'utf8');
  for (const name of ['gridFlowRects', 'pressActive', 'PRESS_MODES']) {
    assert.ok(typeof C[name] !== 'undefined', '产品导出缺 ' + name);
    assert.ok(html.indexOf(name + ': ' + name) >= 0 || html.indexOf(name + ':') >= 0,
      '布局台 core 未导出 ' + name);
  }
});
