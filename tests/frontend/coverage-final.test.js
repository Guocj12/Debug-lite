'use strict';
// P6 R6 覆盖收口 —— 缺字段矩阵/臂级兜底（blocks/bridge/main/mount-editor/mount）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let bridge, blocksMod, main, me, rm, mount, rview;
before(async () => {
  bridge = await import('../../public/js/editor/bridge.js');
  blocksMod = await import('../../public/js/editor/blocks.js');
  main = await import('../../public/js/editor/main.js');
  me = await import('../../public/js/mount/editor.js');
  rview = await import('../../public/js/views/replay.js');
  rm = await import('../../public/js/store/reducer.js');
  mount = await import('../../public/js/mount/index.js');
});

function boxAt(boxes, id) {
  return boxes.find((b) => b.id === id);
}

function st(patch) {
  let s = rm.reducer(undefined, { type: '@@init' });
  for (const [type, payload] of patch || []) s = rm.reducer(s, { type, ...payload });
  return s;
}

test('R6 覆盖：registerBlocks 臂 —— truthy 无 Blocks / fieldOf 各型 init', () => {
  assert.deepEqual(blocksMod.registerBlocks('not-object'), []);
  // init 方法面逐型（fields/default 臂）
  const stub = { Blocks: {} };
  blocksMod.registerBlocks(stub);
  const mk = (type) => {
    const b = { colour: null, out: null, prev: null, next: null, dummy: [], appendDummyInput() { const i = { fields: [], appendField(a, f) { this.fields.push([a, f]); return this; } }; b.dummy = i; return i; }, setColour(c) { b.colour = c; }, setOutput(v) { b.out = v; }, setPreviousStatement(v) { b.prev = v; }, setNextStatement(v) { b.next = v; } };
    stub.Blocks[type].init.call(b);
    return b;
  };
  for (const t of ['call', 'get', 'arith', 'logic', 'cmp', 'if', 'break', 'loop_forever', 'loop_count', 'random', 'bullets', 'function', 'var', 'set', 'action', 'num']) {
    const b = mk(t);
    assert.ok(b.dummy.fields.length >= 1, `${t} dummy 字段`);
  }
});

test('R6 覆盖：buildToolbox null/空节点', () => {
  const tb = blocksMod.buildToolbox(null);
  assert.deepEqual(tb.contents[0].contents, []);
  assert.deepEqual(tb.contents[1].contents, []);
});

test('R6 覆盖：bridge 缺字段矩阵 —— 每个节点缺子字段仍安全往返（默认值臂）', () => {
  const programs = [
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'var', name: 'v', value: { type: 'literal', value: 0 } }] } },
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'set', name: 'w', value: { type: 'bullets' } }] } },
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'if', cond: { type: 'literal', value: true }, then: { type: 'action', name: 'wait' }, else: { type: 'action', name: 'defend' } }] } },
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: { type: 'action', name: 'wait' } }] } },
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'loop', kind: 'while', cond: { type: 'literal', value: false }, body: { type: 'action', name: 'wait' } }] } },
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'random', prob: { type: 'literal', value: 0.25 }, then: { type: 'action', name: 'wait' }, else: { type: 'action', name: 'defend' } }] } },
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'function', name: 'f', body: { type: 'action', name: 'wait' } }] } },
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'call', name: 'f' }, { type: 'break' }] } },
    // 缺子表达式（exprToBlock false 臂：left/right/cond/prob 缺省）
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'set', name: 'q', value: { type: 'cmp', op: '<', left: { type: 'literal', value: 1 } } }] } },
    { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'set', name: 'r', value: { type: 'logic', op: 'or', right: { type: 'literal', value: false } } }] } },
  ];
  for (const program of programs) {
    const blocks = bridge.toBlocks(program);
    const back = bridge.toAst(blocks);
    // 缺子字段 ↔ null 归一（absent ⇄ null 语义等价）
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
    assert.equal(JSON.stringify(drop(back.body)), JSON.stringify(drop(program.body)), JSON.stringify(drop(program.body)).slice(0, 60));
  }
});

test('R6 覆盖：bridge toBlocks 缺 body/statements 变体 + inKey 顶层 next', () => {
  // body 非 seq → 以 body 为 statements 来源
  const flat = { type: 'program', version: 1, body: { statements: [{ type: 'action', name: 'wait' }] } };
  assert.equal(bridge.toAst(bridge.toBlocks(flat)).body.statements.length, 1);
  // program.statements 顶层（旧形态防御）
  const legacy = { type: 'program', version: 1, statements: [{ type: 'action', name: 'wait' }] };
  assert.equal(bridge.toAst(bridge.toBlocks(legacy)).body.statements.length, 1);
  // toBlocks 容忍垃圾输入（null → null；垃圾 body → 空程序语义）
  assert.equal(bridge.toBlocks(undefined), null, 'null program → null');
  assert.equal(bridge.toAst(null), null, 'toAst(null) → null');
  const weird = bridge.toAst(bridge.toBlocks({ type: 'program', version: 1, body: 5 }));
  assert.deepEqual(weird.body.statements, [], '非对象 body → 空程序');
});

test('R6 覆盖：createEditor 防抖二次变更（clearTimeout 臂）+ 到期回调', async () => {
  const fns = [];
  const timers = { setTimeout: (fn, ms) => { fns.push(fn); return fns.length; }, clearTimeout: (id) => fns.push(['clear', id]) };
  const stub = {
    inject: () => ({ _rootBlock: { type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } }, next: null }, _listeners: [], addChangeListener(f) { this._listeners.push(f); } }),
    serialization: { blocks: { append(json, ws) { return { type: json.type }; } } },
  };
  const programs = [];
  const editor = main.createEditor({ blockly: stub, div: {}, nodes: ['action'], registerBlocks: () => [], timers, onChange: (p) => programs.push(p) });
  editor.workspace._listeners.forEach((f) => f());
  editor.workspace._listeners.forEach((f) => f()); // 二次变更 → clearTimeout 臂
  assert.ok(fns.filter((x) => Array.isArray(x) && x[0] === 'clear').length >= 1, '防抖重置');
  fns.filter((x) => !Array.isArray(x)).forEach((fn) => fn()); // 全部到期回调
  assert.ok(programs.length >= 1, '到期回调 emit program');
});

test('R6 覆盖：mount/editor 缺件与高亮臂（无 registerBlocks/tierInfo null/program null/未命中）', async () => {
  const store = { _state: rm.reducer(undefined, { type: '@@init' }), subs: [] };
  store.getState = () => store._state;
  store.dispatch = (a) => { store._state = rm.reducer(store._state, a); store.subs.forEach((f) => f(store._state)); return a; };
  store.subscribe = (f) => { store.subs.push(f); return () => { store.subs = store.subs.filter((x) => x !== f); }; };
  const ctl = me.wireEditor({ doc: { querySelector: () => ({ id: 'ws' }) }, store, log: null, blockly: stub_editor(), registerBlocks: undefined });
  assert.ok(ctl, '无 registerBlocks 也装配');
  // 高亮消费：无 program（aiDraft null）→ json null 分支
  store.dispatch({ type: 'editor/highlight', path: 'body.s[0]' });
  assert.ok(store._state.ui.highlight, '高亮态存储');
  // 高亮 miss（路径不存在）→ block null 分支不炸
  store.dispatch({ type: 'ai/edit', program: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } } });
  store.dispatch({ type: 'editor/highlight', path: 'body.s[9]' });
  assert.ok(true);
  ctl.dispose();
  function stub_editor() {
    return {
      inject: () => ({ _rootBlock: { type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } }, next: null }, _listeners: [], addChangeListener(f) { this._listeners.push(f); } }),
      serialization: { blocks: { append(json, ws) { return { type: json.type }; } }, workspaces: { save(ws) { return ws._rootBlock; } } },
    };
  }
});

test('R6 覆盖：mount editorFactory 进/离屏 + change 滑块臂 + toast 特殊字符', async () => {
  const prevDoc = globalThis.document;
  globalThis.document = { getElementById: () => null }; // document 全局臂
  try {
    const root = { html: '', listeners: {}, innerHTML: '', addEventListener(t, fn) { this.listeners[t] = fn; } };
    const doc = { getElementById: (id) => (id === 'app' ? root : null), querySelector: () => null };
    const log = { debug: () => {}, warn: () => {}, error: () => {}, info: () => {}, dump: () => [] };
    // 真实 store：可切屏（editor → menu → editorFactory dispose 臂）
    const sm = await import('../../public/js/store/index.js');
    const em = await import('../../public/js/store/effects.js');
    const store = sm.createStore({ reducer: rm.reducer, effects: em.effects(), persist: { save: () => {}, saveLogPrefs: () => {}, saveSeed: () => {}, exportState: () => '{}', parseImport: () => ({ ok: false, code: 'x' }) }, api: null, log, timers: null });
    const factoryCalls = [];
    mount.mountApp({
      root, store, renderScreen: () => '<div class="dl-box" data-box-id="x" style="left:0px;top:0px;width:10px;height:10px;z-index:1;"></div>', log, doc,
      editorFactory: () => (factoryCalls.push(1), { dispose() { factoryCalls.push(-1); } }),
    });
    store.dispatch({ type: 'goto', screen: 'editor' });
    await Promise.resolve();
    assert.deepEqual(factoryCalls, [1], 'editor 屏入屏装配');
    store.dispatch({ type: 'goto', screen: 'menu' });
    await Promise.resolve();
    assert.deepEqual(factoryCalls, [1, -1], '离屏 dispose');
    root.listeners.change({ target: { dataset: { action: 'battle/seek', valueKey: 'tick' }, tagName: 'INPUT', type: 'range', value: 'abc' } });
    // toast 特殊字符（#dl-toasts 存在；getElementById 记忆同一 host）
    const hosts = {};
    const doc2 = { getElementById: (id) => (hosts[id] = hosts[id] || { innerHTML: '' }) };
    const store2 = sm.createStore({ reducer: rm.reducer, effects: em.effects(), persist: { save: () => {}, saveLogPrefs: () => {}, saveSeed: () => {}, exportState: () => '{}', parseImport: () => ({ ok: false, code: 'x' }) }, api: null, log, timers: null });
    store2.dispatch({ type: 'ui/toast', text: '<a&b>', kind: 'info' });
    mount.mountApp({ root, store: store2, renderScreen: () => '<div class="dl-box" data-box-id="z" style="left:0px;top:0px;width:10px;height:10px;z-index:1;"></div>', log, doc: doc2, editorFactory: null });
    const toasts = doc2.getElementById('dl-toasts');
    assert.ok(toasts.innerHTML.includes('<span>ab</span>'), '尖括号/取址符被剥（原文不进 DOM）');
  } finally {
    globalThis.document = prevDoc;
  }
});
