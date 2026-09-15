'use strict';
// P6 R6 editor 契约测试 —— blocks 注册（stub）/ toolbox 门控 / editor 屏布局（screens.md 表）+ main 装配
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let blocksMod, main, editorView, rm;
before(async () => {
  blocksMod = await import('../../public/js/editor/blocks.js');
  main = await import('../../public/js/editor/main.js');
  editorView = await import('../../public/js/views/editor.js');
  rm = await import('../../public/js/store/reducer.js');
});

function st(patch) {
  let s = rm.reducer(undefined, { type: '@@init' });
  for (const [type, payload] of patch || []) s = rm.reducer(s, { type, ...payload });
  return s;
}

function boxAt(boxes, id) {
  return boxes.find((b) => b.id === id);
}

// Blockly stub：Blocks 注册表 + inject 返回带监听/serialization 的 workspace 桩
function stubBlockly() {
  const Blocks = {};
  const injected = [];
  let wsi = 0;
  return {
    Blocks: {},
    inject(div, opts) {
      const ws = {
        _id: ++wsi,
        _div: div, _opts: opts,
        _listeners: [],
        addChangeListener(fn) { this._listeners.push(fn); },
        dispose() { this._disposed = true; },
        _rootBlock: null,
      };
      injected.push(ws);
      return ws;
    },
    serialization: {
      blocks: { append(json, ws) { ws._rootBlock = { type: json.type, id: 'root1', fields: {}, inputs: {}, next: null }; return ws._rootBlock; } },
      workspaces: { save(ws) { return ws._rootBlock; } },
    },
    injected,
  };
}

test('R6 blocks：注册清单 16 型与 bridge 块型全集一一对应（数量+命名）+ 幂等', async () => {
  const bridge = await import('../../public/js/editor/bridge.js');
  const stub = stubBlockly();
  const want = Object.keys(bridge.STMT_TYPES).concat(Object.keys(bridge.EXPR_TYPES));
  const registered = blocksMod.registerBlocks(stub);
  assert.deepEqual(registered.sort(), want.sort(), '块词汇逐字一致');
  assert.deepEqual(Object.keys(stub.Blocks).sort(), want.sort(), 'Blocks 表 16 键');
  const again = blocksMod.registerBlocks(stub); // 幂等
  assert.deepEqual(again, [], '重复注册跳过');
});

test('R6 blocks：块 init 方法面（stub 核验 colour/连接/字段）', () => {
  const stub = stubBlockly();
  blocksMod.registerBlocks(stub);
  const mk = (type) => {
    const proto = stub.Blocks[type];
    const b = { colour: null, out: null, prev: null, next: null, fields: [], appendDummyInput() { const i = { fields: [], appendField(a, b2) { this.fields.push([a, b2]); return this; } }; this.fields.push(i); return i; }, setColour(c) { this.colour = c; }, setOutput(v) { this.out = v; }, setPreviousStatement(v) { this.prev = v; }, setNextStatement(v) { this.next = v; } };
    proto.init.call(b);
    return b;
  };
  const num = mk('num');
  assert.equal(num.out, true, '表达式块有输出');
  assert.equal(num.prev, null);
  const act = mk('action');
  assert.equal(act.prev, true, '语句块有前后连接');
  assert.equal(act.next, true);
  assert.ok(act.fields[0].fields.some((f) => f[0] === 'action'), 'dummy 字段含类型名');
});

test('R6 blocks：buildToolbox 节点键门控（真实 availableNodes 形状）', async () => {
  const unlock = require('../../server/core/unlock.js');
  const mythic = unlock.availableNodes('mythic');
  const common = unlock.availableNodes('common');
  const tb = blocksMod.buildToolbox(mythic);
  const stmts = tb.contents[0].contents.map((x) => x.type);
  assert.ok(stmts.includes('if') && stmts.includes('loop_forever'), 'mythic 含全语句块');
  assert.ok(stmts.includes('random'), 'mythic 含 random');
  const tbCommon = blocksMod.buildToolbox(common);
  const commonStmts = tbCommon.contents[0].contents.map((x) => x.type);
  assert.equal(commonStmts.includes('random'), false, 'common 不含 random（unlock 口径）');
  assert.equal(commonStmts.includes('loop_forever'), false, 'common 无 loop 节点');
  assert.ok(commonStmts.includes('action') && commonStmts.includes('if'), 'common 含基础语句块');
  // 未知键剔除
  const tb3 = blocksMod.buildToolbox(['bogus', 'action']);
  assert.deepEqual(tb3.contents[0].contents.map((x) => x.type), ['action']);
});

test('R6 editorLayout：screens.md 表逐行坐标一致 + 分支（编译态/无错误/错误行）+ verify 全绿', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const s = st([['goto', {}]]);
  let boxes = editorView.editorLayout(s);
  const want = [
    ['toolbox', 0, 64, 120, 592, 2],
    ['workspace', 120, 64, 1024, 432, 2],
    ['loop_forever', 144, 88, 200, 48, 3],
    ['panel_right', 1144, 64, 136, 592, 2],
    ['btn_validate', 1156, 80, 112, 32, 3],
    ['btn_compile', 1156, 120, 112, 32, 3],
    ['btn_run', 1156, 160, 112, 32, 3],
    ['hash', 1156, 216, 112, 40, 3],
    ['errCount', 1156, 272, 112, 24, 3],
    ['errors', 120, 496, 1024, 160, 2],
  ];
  for (const [id, x, y, w, h, z] of want) {
    const b = boxAt(boxes, id);
    assert.ok(b, `${id} 应存在`);
    assert.deepEqual({ id, x: b.x, y: b.y, w: b.w, h: b.h, z: b.z }, { id, x, y, w, h, z }, `${id} 坐标`);
  }
  assert.ok(boxAt(boxes, 'btn_validate').action === 'ai/edit', '校验按钮 action');
  assert.ok(boxAt(boxes, 'btn_run').payload.opponent === 'kiter', '试运行对手');
  assert.ok(boxAt(boxes, 'errors_none').text.includes('暂无'), '无错误提示');
  assert.deepEqual(verifyLayout(boxes), [], 'editor 布局应无 issue');

  // 编译中 + 错误行（点击高亮 action）
  const sErr = st([['ai/errors', { errors: [{ path: 'body.s[0]', code: 'branch_without_action', message: 'x' }, { path: 'body.s[1]', code: 'y', message: 'y' }], compiling: false }], ['ai/compile']]);
  boxes = editorView.editorLayout(sErr);
  assert.equal(boxAt(boxes, 'errCount').text, '错误 2');
  assert.equal(boxAt(boxes, 'err1').action, 'editor/highlight');
  assert.deepEqual(boxAt(boxes, 'err1').payload, { path: 'body.s[0]' });
  assert.equal(boxAt(boxes, 'btn_compile').action, null, '编译中死按钮');
  assert.deepEqual(verifyLayout(boxes), [], '错误态布局全绿');
});

test('R6 createEditor：注入流（stub）→ 预置根 + 变更防抖 → 后端形状 program + dispose', async () => {
  const fired = [];
  const timers = { setTimeout: (fn, ms) => { fired.push(['set', ms]); return fired.length; }, clearTimeout: (id) => fired.push(['clear', id]) };
  const stub = stubBlockly();
  stub.serialization.workspaces.save = () => ({
    type: 'loop_forever',
    inputs: { body0: { block: { type: 'action', fields: { name: 'move_right' }, inputs: {}, next: null } } },
    next: null,
  });
  const programs = [];
  const editor = main.createEditor({
    blockly: stub, div: { id: 'blocklyDiv' }, nodes: ['action', 'loop_forever'],
    registerBlocks: blocksMod.registerBlocks, timers, debounceMs: 300,
    onChange: (p) => programs.push(p),
  });
  assert.ok(editor, '有 Blockly 注入 → 装配');
  assert.ok(editor.root && editor.root.type === 'loop_forever', '预置外层循环');
  assert.ok(stub.injected[0]._opts.toolbox.contents[0].contents.length > 0, 'toolbox 传入');
  editor.workspace._listeners.forEach((fn) => fn()); // 触发变更
  assert.ok(fired.some((x) => x[0] === 'set' && x[1] === 300), '防抖 300ms');
  assert.equal(programs.length, 0, '防抖未到期不 emit');
  editor.dispose();
  assert.ok(stub.injected[0]._disposed, 'dispose');
});

test('R6 createEditor：无防抖臂（timers null）→ 直接产出 + findPath 接缝', () => {
  const stub = stubBlockly();
  stub.serialization.workspaces.save = () => ({ type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } }, next: null });
  const programs = [];
  const editor = main.createEditor({
    blockly: stub, div: {}, nodes: ['action'],
    onChange: (p) => programs.push(p), debounceMs: null,
  });
  editor.workspace._listeners.forEach((fn) => fn());
  assert.equal(programs.length, 1);
  assert.deepEqual(programs[0].body.statements, [{ type: 'action', name: 'wait' }], '后端形状 program');
  assert.ok(editor.findPath({ type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } } }, 'body.s[0]'), 'findPath');
  // 无 blockly / 无 div → null
  assert.equal(main.createEditor({}), null);
  assert.equal(main.createEditor({ blockly: stub, div: null }), null);
  // 无 serialization → workspace._rootBlock 注入缝
  const stub2 = { inject: () => ({ _rootBlock: { type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } }, next: null }, addChangeListener: (f) => { f(); } }) };
  const programs2 = [];
  main.createEditor({ blockly: stub2, div: {}, onChange: (p) => programs2.push(p) });
  assert.equal(programs2.length, 1);
});
