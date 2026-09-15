'use strict';
// P6 R7 契约测试 —— AI 轨迹（planTrail 限长/缺字段）+ paintCanvas trail 并入 + 存档导入文件选择器
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let trail, paint, pf, mount, rm, sm, em;
before(async () => {
  trail = await import('../../public/js/render/trail.js');
  paint = await import('../../public/js/render/paint.js');
  pf = await import('../../public/js/render/planFrame.js');
  mount = await import('../../public/js/mount/index.js');
  rm = await import('../../public/js/store/reducer.js');
  sm = await import('../../public/js/store/index.js');
  em = await import('../../public/js/store/effects.js');
});

const mkFrames = (n) => Array.from({ length: n }, (_, i) => ({
  tick: i + 1,
  diff: { players: { p1: { fromX: 100 + i * 10, toX: 110 + i * 10, facing: 1, hp: 100, mp: 40, sp: 50 }, p2: { fromX: 900, toX: 900, facing: -1, hp: 100, mp: 40, sp: 50 } } },
}));

test('R7 trail：双方轨迹点（相邻帧连线）+ 限长 32 + 缺字段安全', () => {
  const frames = mkFrames(40);
  let t = trail.planTrail(frames);
  assert.equal(t.length, 2, '双方各一条');
  assert.ok(t[0].points.length <= 32, '限长 32');
  assert.equal(t[0].points.length, 32, '40 帧 → 保留末 32 点');
  assert.equal(t[0].alpha, 0.4);
  assert.ok(t[0].color && t[1].color, '双方颜色');
  // 少帧：仅 1 点 → 不产线
  t = trail.planTrail(mkFrames(1));
  assert.deepEqual(t, [], '单帧无线');
  t = trail.planTrail([]);
  assert.deepEqual(t, []);
  t = trail.planTrail([{ tick: 1, diff: { players: { p1: { toX: 300 } } } }]);
  assert.deepEqual(t, [], '单点无轨迹');
  // 缺 toX → fromX 回退
  t = trail.planTrail([{ tick: 1, diff: { players: { p1: { fromX: 100 } } } }, { tick: 2, diff: { players: { p1: { toX: 164 } } } }]);
  assert.equal(t.length, 1);
  assert.deepEqual(t[0].points, [100, 164]);
  // null frames
  assert.deepEqual(trail.planTrail(null), []);
});

test('R7 trail：paintCanvas trail 并入（player 后/alpha 折线/日志）', () => {
  const calls = [];
  const ctx = {
    globalAlpha: 1, strokeStyle: null, fillStyle: null, font: null,
    fillRect() {}, strokeRect() {}, clearRect() {}, fillText() {},
    beginPath() {}, moveTo(x, y) { calls.push(['move', x, y]); }, lineTo(x, y) { calls.push(['line', x, y]); }, stroke() { calls.push(['stroke']); },
  };
  const recs = [];
  const log = { trace: (c, e, m, d) => recs.push([e, d]), debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const frames = mkFrames(5);
  const prims = pf.planFrame(frames[2].diff, { t: 1, maxHp: 100 });
  const t = trail.planTrail(frames.slice(0, 3));
  const seen = paint.paintCanvas(ctx, prims, { log, trail: t });
  assert.ok(seen.includes('trail'), 'trail 绘制');
  assert.ok(calls.some((x) => x[0] === 'move'), 'moveTo 起点折线');
  assert.ok(calls.some((x) => x[0] === 'line'), 'lineTo 相邻帧连线');
  assert.equal(ctx.globalAlpha, 1, '绘制后 alpha 复原');
  assert.ok(recs.some((r) => r[0] === 'render.sprite' && r[1] && r[1].points === 3), 'trail 日志点数');
});

test('R7 trail：sliderTick 滑块域', () => {
  assert.equal(trail.sliderTick(2, [{}, {}, {}]), 2);
  assert.equal(trail.sliderTick(9, [{}, {}, {}]), 2);
  assert.equal(trail.sliderTick(-1, [{}, {}, {}]), 0);
  assert.equal(trail.sliderTick(0, []), 0);
  assert.equal(trail.sliderTick(0, null), 0);
});

test('R7 mount：save/import 点击 → 文件选择器 → dispatch（取消不派发）', async () => {
  const mkStore = () => sm.createStore({
    reducer: rm.reducer, effects: em.effects(), persist: { save: () => {}, saveLogPrefs: () => {}, saveSeed: () => {}, exportState: () => '{}', parseImport: (text) => (text.includes('"tier":"mythic"') ? { ok: true, patch: { tier: 'mythic', warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: null, skills: [null, null, null], ai: null } } } : { ok: false, code: 'bad_json' }) }, api: null, log: null, timers: null,
  });
  const root = { listeners: {}, innerHTML: '', addEventListener(t, fn) { this.listeners[t] = fn; } };
  const hosts = {};
  const doc = {
    getElementById: (id) => (hosts[id] = hosts[id] || (id === 'app' ? root : { innerHTML: '' })),
  };
  let resolvePick = null;
  const store = mkStore();
  mount.mountApp({
    root, store, renderScreen: () => '<div class="dl-box" data-box-id="imp" style="left:0px;top:0px;width:100px;height:40px;z-index:3;" data-action="save/import"></div>', log: null, doc,
    dom: { pickText: () => new Promise((r) => { resolvePick = r; }), download: () => {} },
  });
  root.listeners.click({ target: { dataset: { action: 'save/import' } } });
  assert.equal(resolvePick === null, false, 'pickText 已调用');
  // 用户取消（null）→ 不派发
  resolvePick(null);
  await Promise.resolve();
  assert.equal(store.getState().tier, 'common', '取消不派发');
  // 选择文件 → save/import 文本派发（合法存档 → tier 变更 + 回菜单）
  const store2 = mkStore();
  mount.mountApp({
    root, store: store2, renderScreen: () => '<div class="dl-box" data-box-id="imp" style="left:0px;top:0px;width:100px;height:40px;z-index:3;" data-action="save/import"></div>', log: null, doc,
    dom: { pickText: () => Promise.resolve(JSON.stringify({ schemaVersion: 1, tier: 'mythic', warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: null, skills: [null, null, null], ai: null } })) },
  });
  root.listeners.click({ target: { dataset: { action: 'save/import' } } });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(store2.getState().tier, 'mythic', '导入成功 → tier 替换');
  assert.equal(store2.getState().screen, 'menu', '导入后回菜单');
  // parseImport 失败 → toast
  const store3 = mkStore();
  mount.mountApp({
    root, store: store3, renderScreen: () => '<div class="dl-box" data-box-id="imp" style="left:0px;top:0px;width:100px;height:40px;z-index:3;" data-action="save/import"></div>', log: null, doc,
    dom: { pickText: () => Promise.resolve('bad') },
  });
  root.listeners.click({ target: { dataset: { action: 'save/import' } } });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(store3.getState().ui.snackbar.some((t) => t.kind === 'error'), '坏存档 → toast');
});

test('R7 mount：无 dom 注入 → createDomHelpers 兜底（pickText 不炸）', () => {
  const root = { listeners: {}, innerHTML: '', addEventListener(t, fn) { this.listeners[t] = fn; } };
  const doc = { getElementById: () => null, createElement: () => ({ type: '', listeners: {}, addEventListener() {}, click() {} }), body: { appendChild() {}, removeChild() {} } };
  const store = { getState: () => rm.reducer(undefined, { type: '@@init' }), dispatch: () => {}, subscribe: () => () => {} };
  mount.mountApp({ root, store, renderScreen: () => '<div class="dl-box" data-box-id="imp" style="left:0px;top:0px;width:100px;height:40px;z-index:3;" data-action="save/import"></div>', log: null, doc });
  assert.doesNotThrow(() => root.listeners.click({ target: { dataset: { action: 'save/import' } } }));
});
