'use strict';
// P6 R6 覆盖收官 —— bridge 缺字段 canonical 化 + mount/editor 残余臂
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let bridge, me, rm;
before(async () => {
  bridge = await import('../../public/js/editor/bridge.js');
  me = await import('../../public/js/mount/editor.js');
  rm = await import('../../public/js/store/reducer.js');
});

// drop null/undefined 键（canonical 比较）
const drop = (x) => {
  if (x === null || x === undefined) return undefined;
  if (Array.isArray(x)) return x.map(drop).filter((v) => v !== undefined);
  if (typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      const d = drop(v);
      if (d !== undefined) out[k] = d;
    }
    return out;
  }
  return x;
};

test('R6 收口：bridge 缺字段 canonical 矩阵（回退臂逐一命中）', () => {
  const cases = [
    [{ type: 'var' }, { type: 'var', name: '', value: null }],
    [{ type: 'set' }, { type: 'set', name: '', value: null }],
    [{ type: 'if' }, { type: 'if', cond: { type: 'literal', value: false }, then: null, else: null }],
    [{ type: 'loop', kind: 'count' }, { type: 'loop', kind: 'count', times: null, body: null }],
    [{ type: 'loop', kind: 'forever' }, { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: null }],
    [{ type: 'random' }, { type: 'random', prob: { type: 'literal', value: 0.5 }, then: null, else: null }],
    [{ type: 'action' }, { type: 'action', name: 'wait' }],
    [{ type: 'break' }, { type: 'break' }],
    [{ type: 'function' }, { type: 'function', name: 'fn', body: null }],
    [{ type: 'call' }, { type: 'call', name: 'fn' }],
    [{ type: 'literal', value: 7 }, { type: 'literal', value: 7 }],
    [{ type: 'get' }, { type: 'get', path: 'self' }],
    [{ type: 'getVar' }, { type: 'get', path: 'self' }],
    [{ type: 'bullets' }, { type: 'bullets' }],
    [{ type: 'arith' }, { type: 'arith', op: '+', left: null, right: null }],
    [{ type: 'cmp' }, { type: 'cmp', op: '==', left: null, right: null }],
    [{ type: 'logic' }, { type: 'logic', op: 'and', left: null, right: null }],
  ];
  for (const [inNode, want] of cases) {
    const back = bridge.toAst(bridge.toBlocks({ type: 'program', version: 1, body: { type: 'seq', statements: [inNode] } }));
    assert.deepEqual(drop(back.body.statements[0]), drop(want), JSON.stringify(inNode));
  }
});

test('R6 收口：bridge null/空安全全谱', () => {
  assert.equal(bridge.exprToBlock ? undefined : undefined, undefined);
  assert.deepEqual(bridge.toAst(bridge.toBlocks({ type: 'program', version: 1, body: { type: 'seq', statements: [null, undefined, { type: 'action', name: 'wait' }] } })).body.statements, [{ type: 'action', name: 'wait' }], 'null 语句剔除');
  assert.deepEqual(bridge.toAst(bridge.toBlocks({ type: 'program', version: 1, body: { type: 'seq', statements: [] } })).body.statements, []);
  // 裸数字路径段
  const blocks = bridge.toBlocks({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }, { type: 'action', name: 'defend' }] } });
  assert.ok(bridge.findBlockByPath(blocks, 'body.1'), '裸数字段');
  assert.equal(bridge.findBlockByPath(blocks, 'body.s[0].cond'), null, 'action 无 cond → null');
});

test('R6 收口：mount/editor tierInfo 缺 nodes 臂 + block type-only id 臂', async () => {
  const store = { _state: rm.reducer(undefined, { type: '@@init' }), subs: [] };
  store.getState = () => store._state;
  store.dispatch = (a) => { store._state = rm.reducer(store._state, a); store.subs.forEach((f) => f(store._state)); return a; };
  store.subscribe = (f) => { store.subs.push(f); return () => { store.subs = store.subs.filter((x) => x !== f); }; };
  store._state.tierInfo = {}; // 缺 nodes → || [] 臂
  const recs = [];
  const log = { debug: (c, e, m, d) => recs.push([e, d]), info: () => {}, warn: () => {}, error: () => {} };
  const stub = {
    inject: () => ({ _rootBlock: { type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } }, next: null }, _listeners: [], addChangeListener(f) { this._listeners.push(f); } }),
    serialization: { blocks: { append(json, ws) { return { type: json.type }; } }, workspaces: { save(ws) { return ws._rootBlock; } } },
  };
  const ctl = me.wireEditor({ doc: { querySelector: () => ({ id: 'ws' }) }, store, log, blockly: stub });
  assert.ok(ctl, 'tierInfo 空也装配');
  assert.ok(recs.some((r) => r[0] === 'editor.toolbox'), 'toolbox 日志');
  // 高亮命中：json 无 id 块 → block.type 臂
  store.dispatch({ type: 'editor/highlight', path: 'body.s[0]' });
  assert.ok(recs.some((r) => r[0] === 'editor.block.pos'), '高亮日志');
  ctl.dispose();
});
