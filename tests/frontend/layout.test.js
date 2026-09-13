'use strict';
// F1 布局引擎测试 —— frontend-spec §3.4/§3.5（纯函数；坐标机器推导；verifyLayout 四类 issue）
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('grid：0/1/多行坐标公式（x0+(i%cols)*(w+gap)）与字段透传', async () => {
  const { grid } = await import('../../public/js/ui/layout.js');
  assert.deepEqual(grid(0, 0, 4, 168, 108, 16, []), [], '0 项 → 空');
  const one = grid(100, 50, 4, 168, 108, 16, [{ id: 'a', kind: 'cell' }]);
  assert.deepEqual(one[0], { id: 'a', kind: 'cell', x: 100, y: 50, w: 168, h: 108 }, '1 项 → 原点');
  const six = grid(10, 20, 4, 168, 108, 16, Array.from({ length: 6 }, (_, i) => ({ id: `i${i}` })));
  assert.deepEqual(six.map((b) => [b.x, b.y]), [[10, 20], [194, 20], [378, 20], [562, 20], [10, 144], [194, 144]], '多行公式（168+16 步进）');
  assert.equal(six[5].w, 168);
  const override = grid(0, 0, 2, 168, 108, 16, [{ id: 'x', w: 80, h: 40 }]);
  assert.deepEqual([override[0].w, override[0].h], [80, 40], '字段优先于单元格默认');
});

test('center：视口/父盒居中整数公式', async () => {
  const { center } = await import('../../public/js/ui/layout.js');
  assert.deepEqual(center(480, 400), { x: 400, y: 160 }, '(1280-480)/2=400, (720-400)/2=160');
  assert.deepEqual(center(321, 17), { x: Math.round(959 / 2), y: Math.round(703 / 2) }, '奇宽取整');
  assert.deepEqual(center(100, 50, 800, 600), { x: 350, y: 275 }, '父盒维度');
});

test('stack：纵向排列含 gap；x 默认 0', async () => {
  const { stack } = await import('../../public/js/ui/layout.js');
  const { SPACES } = await import('../../public/js/ui/sizes.js');
  const out = stack(10, [{ id: 'a', h: 40 }, { id: 'b', h: 32, x: 5 }], { gap: SPACES.s2 });
  assert.deepEqual(out.map((b) => ({ id: b.id, y: b.y, x: b.x })), [
    { id: 'a', y: 10, x: 0 }, { id: 'b', y: 10 + 40 + 8, x: 5 },
  ], 'y 步进 h+gap');
  assert.deepEqual(stack(0, [], { gap: 8 }), [], '0 项');
});

test('panel/button：组件盒形状（sizes 回读）', async () => {
  const { panel, button } = await import('../../public/js/ui/layout.js');
  const p = panel(10, 10, 400, 300, '标题', 'p1');
  assert.equal(p.kind, 'panel');
  assert.equal(p.text, '标题');
  const b = button('b1', 100, 200, '开箱', { primary: true, z: 5 });
  assert.deepEqual([b.w, b.h], [160, 40], '主按钮 160×40');
  const g = button('g1', 0, 0, '取消', { ghost: true });
  assert.deepEqual([g.w, g.h], [96, 32], 'ghost 96×32');
  assert.equal(b.text, '开箱');
});

test('verifyLayout：clip/overlap/zero/zconflict 四类 issue + 例外（fullscreen/父子）', async () => {
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const clip = verifyLayout([{ id: 'c1', x: -1, y: 0, w: 100, h: 100, z: 0, visible: true }]);
  assert.equal(clip.issues.length, 1);
  assert.equal(clip.issues[0].issue, 'clip');
  assert.equal(verifyLayout([{ id: 'c1', x: 0, y: 0, w: 2000, h: 100, z: 0, visible: true, fullscreen: true }]).issues.length, 0, 'fullscreen 遮罩排除');
  const overlap = verifyLayout([
    { id: 'a', x: 0, y: 0, w: 100, h: 100, z: 1, visible: true },
    { id: 'b', x: 50, y: 50, w: 100, h: 100, z: 1, visible: true },
  ]);
  assert.ok(overlap.issues.some((i) => i.issue === 'overlap' && i.boxId === 'a'), '同 z 相交 → overlap');
  const noOv = verifyLayout([
    { id: 'a', x: 0, y: 0, w: 100, h: 100, z: 1, visible: true },
    { id: 'b', x: 0, y: 0, w: 100, h: 100, z: 1, visible: true, parent: 'a' },
  ]);
  assert.equal(noOv.issues.filter((i) => i.issue === 'overlap').length, 0, '父子相交除外');
  const zero = verifyLayout([{ id: 'z1', x: 0, y: 0, w: 0, h: 50, z: 0, visible: true }]);
  assert.equal(zero.issues[0].issue, 'zero');
  const zconf = verifyLayout([
    { id: 'm', x: 0, y: 0, w: 1280, h: 720, z: 90, visible: true, kind: 'modal-mask' },
    { id: 'm1', x: 100, y: 100, w: 480, h: 200, z: 91, visible: true, parent: 'm' },
    { id: 'inner', x: 120, y: 120, w: 100, h: 50, z: 90, visible: true, parent: 'm1' },
  ]);
  assert.ok(zconf.issues.some((i) => i.issue === 'zconflict' && i.boxId === 'inner'), '子 z ≤ 父 z → zconflict');
  assert.equal(zconf.issues.filter((i) => i.issue === 'zconflict' && i.boxId === 'm').length, 0, '遮罩 ≥ 子面板 不误报');
});