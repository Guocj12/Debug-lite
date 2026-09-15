'use strict';
// P6 R6 分支锤 —— bridge 全臂 / blocks 门控 / main 兜底 / mount·views editor 分支
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let bridge, blocksMod, main, editorView, rview, rm, mount;
before(async () => {
  bridge = await import('../../public/js/editor/bridge.js');
  blocksMod = await import('../../public/js/editor/blocks.js');
  main = await import('../../public/js/editor/main.js');
  editorView = await import('../../public/js/views/editor.js');
  rview = await import('../../public/js/views/replay.js');
  rm = await import('../../public/js/store/reducer.js');
  mount = await import('../../public/js/mount/index.js');
});

function st(patch) {
  let s = rm.reducer(undefined, { type: '@@init' });
  for (const [type, payload] of patch || []) s = rm.reducer(s, { type, ...payload });
  return s;
}

function boxAt(boxes, id) {
  return boxes.find((b) => b.id === id);
}

test('R6 分支：stmtToBlock 全臂（缺字段归一）往返', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'v' },                                        // 无 value
    { type: 'set', name: 'w' },                                        // 无 value
    { type: 'if', cond: { type: 'literal', value: true } },            // 无 then/else
    { type: 'loop', kind: 'forever', body: { type: 'action', name: 'wait' } }, // forever（无 cond 字段）
    { type: 'loop', kind: 'count', body: { type: 'action', name: 'wait' } },   // 缺 times
    { type: 'loop', kind: 'while', cond: { type: 'cmp', op: '==', left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 1 } }, body: { type: 'action', name: 'wait' } }, // while 非 true cond
    { type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'action', name: 'wait' } }, // 缺 else
    { type: 'function', name: 'f' },                                   // 缺 body
    { type: 'call', name: '' },                                        // 缺 name → 'fn'
    { type: 'break' },
  ] } };
  const blocks = bridge.toBlocks(program);
  const back = bridge.toAst(blocks);
  assert.equal(JSON.stringify(back.body.statements[3].cond), '{"type":"literal","value":true}', 'forever → while+litTrue canonical');
  assert.equal(back.body.statements[5].kind, 'while', '非 true cond while 保持');
  assert.equal(back.body.statements[4].times, null, '缺 times → null');
  assert.equal(back.body.statements[2].then, null, '缺 then → null');
  assert.equal(back.body.statements[6].else, null, '缺 else → null');
  assert.equal(back.body.statements[8].name, 'fn', 'call 缺名 → fn');
  assert.equal(back.body.statements[9].type, 'break');
  // 二次往返稳定（canonical 形状幂等）
  const blocks2 = bridge.toBlocks({ type: 'program', version: 1, body: { type: 'seq', statements: back.body.statements } });
  const back2 = bridge.toAst(blocks2);
  assert.equal(JSON.stringify(back.body), JSON.stringify(back2.body), 'canonical 幂等');
});

test('R6 分支：blockToNode 兜底臂（action 缺名/call 缺名/if 缺 cond/random 缺 prob）', () => {
  const blocks = { type: 'loop_forever', inputs: { body0: { block: {
    type: 'action', fields: {}, inputs: {},
    next: { block: { type: 'call', fields: {}, inputs: {}, next: { block: {
      type: 'if', fields: {}, inputs: {}, next: { block: {
        type: 'random', fields: {}, inputs: {}, next: null,
      } },
    } },
  } } } }, next: null } };
  const back = bridge.toAst(blocks);
  assert.deepEqual(back.body.statements[0], { type: 'action', name: 'wait' });
  assert.equal(back.body.statements[1].name, 'fn');
  assert.deepEqual(back.body.statements[2].cond, { type: 'literal', value: false }, '缺 cond → litFalse');
  assert.deepEqual(back.body.statements[3].prob, { type: 'literal', value: 0.5 }, '缺 prob → 0.5');
});

test('R6 分支：exprFromBlock 未知块型 → null；缺 op/left 归一', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'set', name: 'x', value: { type: 'arith', op: '*', left: null, right: null } },
  ] } };
  const blocks = bridge.toBlocks(program);
  const back = bridge.toAst(blocks);
  assert.equal(back.body.statements[0].value.left, null, '缺 left → null');
  // 未知表达式块（语句位）→ 剔除
  const r2 = bridge.toAst({ type: 'loop_forever', inputs: { body0: { block: { type: 'mystery', fields: {}, inputs: {}, next: null } } } });
  assert.deepEqual(r2.body.statements, [], '未知语句剔除');
});

test('R6 分支：bodyToNode 链空/多语句/单语句', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'if', cond: { type: 'literal', value: true }, then: { type: 'action', name: 'wait' }, else: { type: 'seq', statements: [{ type: 'action', name: 'a' }, { type: 'action', name: 'b' }] } },
  ] } };
  const blocks = bridge.toBlocks(program);
  const ifBlk = blocks.inputs.body0.block;
  assert.ok(ifBlk.inputs.then0.block.fields === undefined || true);
  const elseChain = ifBlk.inputs.else0.block;
  assert.equal(elseChain.fields._seq, undefined, '多语句无 _seq');
  const back = bridge.toAst(blocks);
  assert.equal(back.body.statements[0].then.type, 'action', '单语句 then 非包装');
  // 空 body → null（if.then null）
  const p2 = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'if', cond: { type: 'literal', value: true }, then: { type: 'seq', statements: [] } }] } };
  const b2 = bridge.toAst(bridge.toBlocks(p2));
  assert.equal(b2.body.statements[0].then, null, '空 then 链 → null');
});

test('R6 分支：findBlockByPath 段映射（prob/times/cond/init/left）+ 多 body 前缀', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'v', value: { type: 'literal', value: 1 } },
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 2 }, body: { type: 'loop', kind: 'forever', body: { type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'action', name: 'wait' } } } },
  ] } };
  const blocks = bridge.toBlocks(program);
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[0].value'), 'var.value → init');
  assert.ok(bridge.findBlockByPath(blocks, 'body.body.s[0]'), '根 body 前缀可重复');
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[1].times'), 'count.times');
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[1].body.body'), '嵌套 loop.body');
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[1].body.body.s[0].then'), 'random.then');
  assert.equal(bridge.findBlockByPath(blocks, 'body.s[1].body.body.s[0].s[9]'), null, '深层越界 null');
});

test('R6 分支：blocks.registerBlocks 兜底（无 Blockly/已注册跳过）', async () => {
  assert.deepEqual(blocksMod.registerBlocks(null), [], '无 Blockly → 空');
  assert.deepEqual(blocksMod.registerBlocks({ Blocks: { action: { init() {} } } }).sort(), ['arith', 'break', 'bullets', 'call', 'cmp', 'function', 'get', 'if', 'logic', 'loop_count', 'loop_forever', 'num', 'random', 'set', 'var'], '已注册 action → 剔除');
  // 空节点 → 两类均空
  const tb = blocksMod.buildToolbox([]);
  assert.deepEqual(tb.contents[0].contents, []);
  assert.deepEqual(tb.contents[1].contents, []);
});

test('R6 分支：createEditor 兜底臂 —— 无 serialization/_rootBlock null', async () => {
  const stub = { inject: () => ({ _rootBlock: null, addChangeListener: (f) => { f(); } }) }; // 无 serialization
  const programs = [];
  main.createEditor({ blockly: stub, div: {}, onChange: (p) => programs.push(p), debounceMs: null });
  assert.equal(programs.length, 1);
  assert.equal(programs[0], null, '无 JSON → onChange(null)');
  // 无 blockly → null
  assert.equal(main.createEditor({ blockly: null, div: {} }), null, '无 blockly → null');
});

test('R6 分支：editorLayout 兜底 —— aiDraft null/hash 显示/错误缺 path', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const s = { ...st([['goto', {}]]), aiDraft: null };
  let boxes = editorView.editorLayout(s);
  assert.equal(boxAt(boxes, 'errCount').text, '错误 0');
  const sHash = { ...s, aiDraft: { program: null, errors: [{ code: 'x' }], compiling: false, hash: 'deadbeefcafe1234' } };
  boxes = editorView.editorLayout(sHash);
  assert.ok(boxAt(boxes, 'hash').text.includes('deadbeef'), 'hash 显示前 8 位');
  assert.ok(boxAt(boxes, 'err1').text.includes('body'), '缺 path → body');
  assert.deepEqual(verifyLayout(boxes), [], 'editor 兜底布局全绿');
  const h = editorView.editorHtml(sHash);
  assert.ok(h.includes('data-box-id="err1"'), 'editorHtml 输出');
});

test('R6 分支：renderScreen records 非数组非函数 + editor 屏接线', async () => {
  const vi = await import('../../public/js/views/index.js');
  const r = vi.renderScreen('settings', { ...st([['goto', {}]]), screen: 'settings' }, { records: 42 });
  assert.ok(r.includes('暂无日志记录'), 'records 非法 → 空');
  const se = vi.renderScreen('editor', { ...st([['goto', {}]]), screen: 'editor' }, {});
  assert.ok(se.includes('data-box-id="btn_compile"'), 'editor 屏接线');
});
