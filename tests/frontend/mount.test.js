'use strict';
// P6 R2 mount 契约测试 —— 唯一 DOM 写入点：paint/verify/委托/toast（spec §6.0）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let mount, rm, vi;
before(async () => {
  mount = await import('../../public/js/mount/index.js');
  rm = await import('../../public/js/store/reducer.js');
  vi = await import('../../public/js/views/index.js');
});

function fakeDoc() {
  const hosts = {};
  return {
    _handlers: {},
    getElementById: (id) => (hosts[id] = hosts[id] || { id, html: '', listeners: {}, innerHTML: null }),
    createElement: () => ({ type: '', accept: '', listeners: {}, files: [], addEventListener(t, fn) { this.listeners[t] = fn; }, click() { this.clicked = true; } }),
    body: { appendChild() {}, removeChild() {} },
  };
}

function makeRoot() {
  return {
    html: '',
    listeners: {},
    innerHTML: '',
    addEventListener(t, fn) { this.listeners[t] = fn; },
  };
}

function clickHandler(root) {
  return root.listeners.click;
}

test('R2 mount：routeEvent 委托解析（含向上查找/坏 payload/无匹配）', () => {
  const btn = { dataset: { action: 'goto', payload: '{"screen":"gacha"}', boxId: 'btn_gacha' } };
  assert.deepEqual(mount.routeEvent(btn), { type: 'goto', valueKey: null, screen: 'gacha' });
  const wrap = { parentElement: btn, dataset: {} };
  assert.deepEqual(mount.routeEvent(wrap), { type: 'goto', valueKey: null, screen: 'gacha' }, '向上查找');
  const keyed = { dataset: { action: 'battle/seek', valueKey: 'tick', payload: '{"tick":3}' } };
  assert.deepEqual(mount.routeEvent(keyed), { type: 'battle/seek', valueKey: 'tick', tick: 3 }, 'valueKey 透传');
  const bad = { dataset: { action: 'x', payload: '{oops' } };
  assert.deepEqual(mount.routeEvent(bad), { type: 'x', valueKey: null }, '坏 payload → 空 payload 不抛');
  assert.equal(mount.routeEvent({ dataset: {} }), null);
  assert.equal(mount.routeEvent(null), null);
});

test('R2 mount：no-doc/no-app 跳过（null 返回）', () => {
  assert.equal(mount.mountApp({}), null);
  assert.equal(mount.mountApp(null), null);
});

test('R2 mount：装配 → paint 初始渲染 + 订阅重渲染 + 点击 dispatch', async () => {
  const doc = fakeDoc();
  doc.getElementById = (id) => (id === 'app' ? root : (doc._hosts[id] = doc._hosts[id] || { html: '' }));
  doc._hosts = {};
  const root = makeRoot();
  const rec = [];
  const log = { debug: (c, e, m, d) => rec.push([e, m, d]), warn: (c, e, m, d) => rec.push([e, m, d]), error: () => {}, info: () => {}, dump: () => [], setLevel: () => {}, setChannelLevel: () => {} };
  const store = { subs: [] };
  store._state = { ...rm.reducer(undefined, { type: '@@init' }), meta: { serverOk: true }, warehouse: { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } } };
  store.getState = () => store._state;
  store.dispatch = (a) => { store._state = rm.reducer(store._state, a); store.subs.forEach((f) => f(store._state)); return a; };
  store.subscribe = (f) => { store.subs.push(f); return () => { store.subs = store.subs.filter((x) => x !== f); }; };
  const h = mount.mountApp({ root, store, renderScreen: vi.renderScreen, log, doc });
  assert.ok(h, '有 doc+root 应装配成功');
  assert.ok(root.innerHTML.includes('data-box-id="btn_ai"'), '初始 paint：menu 按钮');
  assert.ok(rec.some((r) => r[0] === 'ui.layout' && r[1] === 'menu'), '应有 ui.layout 日志');
  assert.equal(rec.some((r) => r[0] === 'ui.layout.report'), false, '布局无 issue 不应有 report');

  // 点击 → goto gacha
  const btn = { dataset: { action: 'goto', payload: '{"screen":"gacha"}', boxId: 'btn_gacha' } };
  clickHandler(root)({ target: btn, clientX: 600, clientY: 380 });
  assert.equal(store.getState().screen, 'gacha', '点击委托 → dispatch goto');
  assert.ok(rec.some((r) => r[0] === 'ui.click' && /goto/.test(r[1])), '点击日志');
  assert.ok(rec.some((r) => r[0] === 'ui.layout' && r[1] === 'gacha'), '订阅 → 重渲染 + 新屏布局日志');

  // change 事件：select valueKey → tier/set
  const sel = { dataset: { action: 'tier/set', valueKey: 'tier', boxId: 'sel_tier' }, tagName: 'SELECT', value: 'epic' };
  root.listeners.change({ target: sel });
  assert.equal(store.getState().tier, 'epic', 'change → tier/set');
  // change 事件：文本 seed
  const fld = { dataset: { action: 'seed/set', valueKey: 'seed' }, tagName: 'INPUT', type: 'text', value: '123' };
  root.listeners.change({ target: fld });
  assert.equal(store.getState().seed, 123, 'change → seed/set 数值化');
  h.off();
});

test('R2 mount：布局问题 → ui.layout.report warn', () => {
  const root = makeRoot();
  const doc = fakeDoc();
  doc._hosts = {};
  doc.getElementById = (id) => (id === 'app' ? root : (doc._hosts[id] = { html: '' }));
  const rec = [];
  const log = { debug: (c, e, m, d) => rec.push([e]), warn: (c, e, m, d) => rec.push([e, m, d]), error: () => {}, info: () => {}, dump: () => [] };
  const badRender = () => '<div class="dl-box" data-box-id="bad" style="left:2000px;top:0px;width:100px;height:100px;z-index:1;"></div>';
  const store = { getState: () => ({ screen: 'bogus', ui: { snackbar: [] } }), subscribe: () => () => {}, dispatch: () => {} };
  mount.mountApp({ root, store, renderScreen: badRender, log, doc });
  assert.ok(rec.some((r) => r[0] === 'ui.layout.report'), '越界应触发 report');
});

test('R2 mount：toast 容器渲染（snackbar → #dl-toasts）', () => {
  const doc = fakeDoc();
  doc._hosts = {};
  const root = makeRoot();
  doc.getElementById = (id) => (id === 'app' ? root : (doc._hosts[id] = doc._hosts[id] || { html: '' }));
  const log = { debug: () => {}, warn: () => {}, error: () => {}, info: () => {}, dump: () => [] };
  const store = { _state: null, dispatch: () => {}, subscribe: () => () => {} };
  store.getState = () => store._state;
  store._state = { ...rm.reducer(undefined, { type: '@@init' }), ui: { snackbar: [{ text: 'hi<evil>', kind: 'error' }] } };
  mount.mountApp({ root, store, renderScreen: vi.renderScreen, log, doc });
  const toasts = doc._hosts['dl-toasts'];
  assert.ok(toasts && toasts.innerHTML.includes('hievil'), '尖括号被剥（内容保留）');
  assert.equal(toasts.innerHTML.includes('<evil'), false, '未成对尖括号被剥');
  assert.ok(toasts.innerHTML.includes('dl-error'), 'error 样式');
});

test('R2 mount：分支锤 —— 无目标/无动作/无 toast 容器/无 doc/window 桩/log null', () => {
  const root = makeRoot();
  const log1 = { debug: () => {}, warn: () => {}, error: () => {}, info: () => {}, dump: () => [] };
  const store1 = { getState: () => ({ ...rm.reducer(undefined, { type: '@@init' }), screen: 'menu' }), subscribe: () => () => {}, dispatch: () => {} };
  // 无 target 与无 dataset → 委托直接返回（先装配出监听器）
  assert.doesNotThrow(() => mount.mountApp({ root, store: store1, renderScreen: vi.renderScreen, log: log1, doc: {} }));
  assert.doesNotThrow(() => root.listeners.click(null));
  assert.doesNotThrow(() => root.listeners.click({ target: {} }));
  // window 桩（__DL_LAST_BOXES__ 写入臂）
  const prevWindow = globalThis.window;
  globalThis.window = {};
  try {
    const doc2 = fakeDoc();
    doc2._hosts = {};
    doc2.getElementById = (id) => (id === 'app' ? root : null);
    const log2 = { debug: () => {}, warn: () => {}, error: () => {}, info: () => {}, dump: () => [] };
    assert.doesNotThrow(() => mount.mountApp({ root, store: store1, renderScreen: vi.renderScreen, log: log2, doc: doc2 }));
    assert.ok(Array.isArray(globalThis.window.__DL_LAST_BOXES__), '窗口桩获盒子表');
  } finally {
    globalThis.window = prevWindow;
  }
  // log null → paint 全部短路
  const doc3 = fakeDoc();
  doc3._hosts = {};
  doc3.getElementById = (id) => (id === 'app' ? root : (doc3._hosts[id] = doc3._hosts[id] || { html: '' }));
  assert.doesNotThrow(() => mount.mountApp({ root, store: store1, renderScreen: vi.renderScreen, log: null, doc: doc3 }));
});
