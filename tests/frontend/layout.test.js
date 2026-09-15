'use strict';
// P6 R1 布局引擎契约测试 —— frontend-spec §3.3~§3.5（grid/center/stack/panel/button + verifyLayout 四类 issue）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let VIEW, SIZES, SPACES, GRID_GAP, HEADER_H, CANVAS, SHELL;
let box, grid, center, stack, panel, button, verifyLayout;
before(async () => {
  const sizes = await import('../../public/js/ui/sizes.js');
  const layout = await import('../../public/js/ui/layout.js');
  ({ VIEW, SIZES, SPACES, GRID_GAP, HEADER_H, CANVAS, SHELL } = sizes);
  ({ box, grid, center, stack, panel, button, verifyLayout } = layout);
});

test('R1 sizes：组件尺寸常量与 §3.2 一致（唯一来源）', () => {
  assert.deepEqual(SIZES.button, { w: 160, h: 40 });
  assert.deepEqual(SIZES.buttonGhost, { w: 96, h: 32 });
  assert.deepEqual(SIZES.gridCell, { w: 168, h: 108 });
  assert.equal(GRID_GAP, SPACES.s4);
  assert.deepEqual(VIEW, { w: 1280, h: 720 });
  assert.equal(HEADER_H, 64);
  assert.deepEqual(CANVAS, { w: 1024, h: 128 });
  assert.deepEqual(SHELL.logo, { x: 16, y: 9, w: 180, h: 46, z: 1 });
});

test('R1 box：坐标取整 + 默认 z3/visible true', () => {
  const b = box('x', 'button', 10.4, 20.6, 100.2, 40.5, { z: 5, style: 'primary' });
  assert.deepEqual({ x: b.x, y: b.y, w: b.w, h: b.h, z: b.z, visible: b.visible }, { x: 10, y: 21, w: 100, h: 41, z: 5, visible: true });
  assert.equal(b.style, 'primary');
});

test('R1 grid：0/1/多行坐标公式（含 gap 与字段透传）', () => {
  assert.deepEqual(grid(0, 0, 4, 100, 50, 10, []), []);
  const one = grid(200, 80, 4, 168, 108, 16, [{ id: 'c1', text: 'A' }]);
  assert.deepEqual({ x: one[0].x, y: one[0].y, w: one[0].w, h: one[0].h }, { x: 200, y: 80, w: 168, h: 108 });
  assert.equal(one[0].text, 'A');
  const many = grid(200, 80, 4, 168, 108, 16, [
    { id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }, { id: 'c5' }, { id: 'c6' },
  ]);
  assert.equal(many[4].x, 200);                      // 第二行首列
  assert.equal(many[4].y, 80 + 108 + 16);            // 204
  assert.equal(many[5].x, 200 + 168 + 16);           // 384
  assert.equal(many[1].y, 80);
  assert.equal(many[0].parent, null);
  const withParent = grid(0, 0, 1, 10, 10, 0, [{ id: 'z', visible: false }], { parent: 'p' });
  assert.equal(withParent[0].parent, 'p');
  assert.equal(withParent[0].visible, false);
});

test('R1 center/stack：视口与父盒居中、纵向累加 gap', () => {
  assert.deepEqual(center(560, 360), { x: 360, y: 180 });  // menu 面板（screens.md）
  assert.deepEqual(center(100, 40, { x: 0, y: 0, w: 1000, h: 200 }), { x: 450, y: 80 });
  assert.deepEqual(center(160, 40), { x: 560, y: 340 });   // 按钮居中公式
  const st = stack(268, [
    { id: 'b1', x: 560, w: 160, h: 40 },
    { id: 'b2', x: 560, w: 160, h: 40 },
  ], { gap: 12 });
  assert.equal(st[0].y, 268);
  assert.equal(st[1].y, 268 + 40 + 12); // 320 —— menu 按钮栈步距（screens.md 表）
  const defGap = stack(0, [{ id: 'a', x: 0, w: 10, h: 10 }, { id: 'b', x: 0, w: 10, h: 10 }]);
  assert.equal(defGap[1].y, 22, '默认 gap=12');
});

test('R1 panel/button：面板 z2、按钮 160×40/ghost 96×32', () => {
  const p = panel('panel_menu', 360, 180, 560, 360, '标题');
  assert.deepEqual({ id: p.id, kind: p.kind, x: p.x, y: p.y, z: p.z, text: p.text }, { id: 'panel_menu', kind: 'panel', x: 360, y: 180, z: 2, text: '标题' });
  const b1 = button('btn_x', 560, 268, { text: '开箱', action: 'goto gacha' });
  assert.deepEqual({ w: b1.w, h: b1.h, z: b1.z, style: b1.style, action: b1.action }, { w: 160, h: 40, z: 4, style: 'primary', action: 'goto gacha' });
  const g = button('btn_y', 0, 0, { style: 'ghost' });
  assert.deepEqual({ w: g.w, h: g.h }, { w: 96, h: 32 });
});

test('R1 verifyLayout：clip/zero 基础判定', () => {
  const issues = verifyLayout([
    box('in', 'panel', 0, 0, 100, 100),
    box('out', 'panel', 1200, 700, 200, 100),   // 越界
    box('nil', 'panel', 0, 200, 0, 40),         // 零宽
  ]);
  const ids = issues.map((i) => `${i.boxId}:${i.issue}`);
  assert.ok(ids.includes('out:clip'), '越界应报 clip');
  assert.ok(ids.includes('nil:zero'), '零尺寸应报 zero');
  assert.ok(!ids.includes('in:clip'));
});

test('R1 verifyLayout：同层 overlap 与父子例外 + zconflict', () => {
  const p = panel('p1', 0, 0, 500, 500);
  const child = box('c1', 'button', 10, 10, 100, 40, { parent: 'p1', z: 3 }); // 父 z2 子 z3 → 合法
  const sib = box('s1', 'button', 10, 10, 100, 40, { z: 3 });                 // 与 child 同 z 相交（无父子关系）
  const badChild = box('c2', 'button', 300, 300, 100, 40, { parent: 'p1', z: 1 }); // 子 z ≤ 父 z
  const issues = verifyLayout([p, child, sib, badChild]);
  const kinds = issues.map((i) => i.issue);
  assert.ok(kinds.includes('overlap'), '同层相交应报 overlap');
  assert.ok(kinds.includes('zconflict'), '父子 z 颠倒应报 zconflict');
  // 父子相交不应报 overlap
  assert.ok(!issues.some((i) => i.issue === 'overlap' && i.boxId.includes('p1~') || i.boxId === 'p1~c1' || i.boxId === 'c1~p1'));
});

test('R1 verifyLayout：不同 z 相交合法 + 祖孙链例外 + 全屏遮罩不报 clip', () => {
  const base = box('base', 'panel', 0, 0, 1280, 720, { z: 0 });
  const mask = box('mask', 'mask', 0, 0, 1280, 720, { z: 90, parent: null });
  const modal = box('modal', 'modal', 400, 280, 480, 160, { z: 91, parent: 'mask' });
  const issues = verifyLayout([base, mask, modal]);
  assert.deepEqual(issues, [], '遮罩压底/盖内容均为合法层叠，不应有 issue');
});

test('R1 verifyLayout：自定义视口尺寸（1280×720 之外）', () => {
  const issues = verifyLayout([box('big', 'panel', 0, 0, 2000, 800)], { viewW: 1000, viewH: 500 });
  assert.ok(issues.some((i) => i.issue === 'clip'));
  assert.ok(!issues.some((i) => i.issue === 'zero'));
});

test('R1 verifyLayout：空表与空 box 输入安全', () => {
  assert.deepEqual(verifyLayout([]), []);
  assert.deepEqual(verifyLayout(null), []);
});
