'use strict';
// P6 R6 mount/editor 装配契约测试 —— 入屏装配/离屏销毁/高亮消费（stub Blockly）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let me, rm;
before(async () => {
  me = await import('../../public/js/mount/editor.js');
  rm = await import('../../public/js/store/reducer.js');
});

function stubBlockly() {
  return {
    inject(div, opts) {
      const ws = { _opts: opts, _listeners: [], addChangeListener(fn) { this._listeners.push(fn); }, dispose() { this._disposed = true; }, _rootBlock: { type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } }, next: null } };
      return ws;
    },
    serialization: {
      blocks: { append(json, ws) { ws._rootBlock = { type: json.type }; return ws._rootBlock; } },
      workspaces: { save(ws) { return ws._rootBlock; } },
    },
  };
}

function fakeDocWithWorkspace() {
  return {
    querySelector: (sel) => (sel === '[data-box-id="workspace"]' ? { id: 'ws' } : null),
  };
}

test('R6 mount：wireEditor —— 装配 + 变更→ai/edit + 高亮消费 + dispose 解绑', async () => {
  const edits = [];
  const store = { _state: rm.reducer(undefined, { type: '@@init' }), subs: [] };
  store.getState = () => store._state;
  store.dispatch = (a) => { store._state = rm.reducer(store._state, a); edits.push(a); store.subs.forEach((f) => f(store._state)); return a; };
  store.subscribe = (f) => { store.subs.push(f); return () => { store.subs = store.subs.filter((x) => x !== f); }; };
  const rec = [];
  const log = { debug: (c, e, m, d) => rec.push([e]), info: () => {}, warn: () => {}, error: () => {} };
  const ctl = me.wireEditor({
    doc: fakeDocWithWorkspace(), store, log,
    blockly: stubBlockly(), registerBlocks: () => [],
    debounceMs: null,
  });
  assert.ok(ctl && ctl.editor, '装配成功');
  // workspace 变更 → ai/edit dispatch（stub _rootBlock 形状）
  ctl.editor.workspace._listeners.forEach((fn) => fn());
  assert.ok(edits.some((a) => a.type === 'ai/edit' && a.program), '变更 → ai/edit dispatch');
  // 高亮消费：ui.highlight 变化 → editor.block.pos 日志
  store.dispatch({ type: 'editor/highlight', path: 'body.s[0]' });
  assert.ok(rec.some((r) => r[0] === 'editor.block.pos'), '高亮日志');
  const subsBefore = store.subs.length;
  ctl.dispose();
  assert.equal(store.subs.length, subsBefore - 1, 'dispose 解绑订阅');
  assert.ok(ctl.editor.workspace._disposed, 'Blockly 销毁');
});

test('R6 mount：缺件跳过（无 doc/无 store/无 blockly/无 workspace div）', () => {
  assert.equal(me.wireEditor({}), null);
  assert.equal(me.wireEditor({ doc: null, store: {}, blockly: {} }), null);
  assert.equal(me.wireEditor({ doc: { querySelector: () => null }, store: {}, blockly: {} }), null);
});
