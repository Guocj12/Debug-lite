'use strict';
// P6 R6 editor/bridge 契约测试 —— 积木 JSON ↔ 后端 AI 程序 双向等价（真实 fixtures + 畸形防御 + 路径定位）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let bridge, fixtures;
before(async () => {
  bridge = await import('../../public/js/editor/bridge.js');
  fixtures = require('../../tests/fixtures/ai-programs.json');
});

function clean(program) {
  return JSON.stringify({ type: program.type, version: program.version, body: program.body });
}

test('R6 bridge：真实后端程序（6 fixtures）→ toBlocks → toAst 逐程序深等往返', () => {
  for (const [name, fx] of Object.entries(fixtures)) {
    const program = fx.program || fx;
    if (!program || program.type !== 'program') continue;
    const blocks = bridge.toBlocks(program);
    assert.ok(blocks && blocks.type === 'loop_forever', `${name} 根 = loop_forever（D-100）`);
    const back = bridge.toAst(blocks);
    assert.equal(clean(back), clean(program), `${name} 往返无损`);
  }
});

test('R6 bridge：空程序/畸形输入安全', () => {
  const empty = { type: 'program', version: 1, body: { type: 'seq', statements: [] } };
  const e = bridge.toAst(bridge.toBlocks(empty));
  assert.deepEqual(e.body, { type: 'seq', statements: [] });
  assert.equal(bridge.toBlocks(null), null);
  assert.equal(bridge.toBlocks('x'), null);
  assert.equal(bridge.toAst(null), null);
  const ragged = bridge.toAst({ type: 'nonsense' });
  assert.ok(ragged && ragged.body);
  // 非法块型 → 剔除（不炸）
  const r2 = bridge.toAst({ type: 'loop_forever', inputs: { body0: { block: { type: 'bogus', fields: {}, inputs: {}, next: null } } } });
  assert.deepEqual(r2.body.statements, []);
});

test('R6 bridge：全 16 节点覆盖（coverageProgram）逐语句还原', () => {
  const program = fixtures.coverageProgram.program;
  const blocks = bridge.toBlocks(program);
  const back = bridge.toAst(blocks);
  assert.equal(back.body.statements.length, program.body.statements.length);
  const kinds = back.body.statements.map((s) => s.type);
  for (const t of ['literal', 'var', 'set', 'get', 'bullets', 'cmp', 'logic', 'random', 'if', 'loop', 'action', 'function', 'call']) {
    assert.ok(kinds.includes(t), `语句级应含 ${t}`);
  }
});

test('R6 bridge：getVar/get 同块型歧义（fields.name vs fields.path）往返', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'set', name: 'x', value: { type: 'getVar', name: 'cd1' } },
    { type: 'set', name: 'y', value: { type: 'get', path: 'self' } },
    { type: 'cmp', op: '<', left: { type: 'getVar', name: 'cd1' }, right: { type: 'literal', value: 3 } },
  ] } };
  const blocks = bridge.toBlocks(program);
  const back = bridge.toAst(blocks);
  assert.equal(clean(back), clean(program));
});

test('R6 bridge：表达式语句（cmp/logic/arith 语句位）往返', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'cmp', op: '<', left: { type: 'getVar', name: 'a' }, right: { type: 'literal', value: 1 } },
    { type: 'logic', op: 'and', left: { type: 'literal', value: true }, right: { type: 'literal', value: false } },
  ] } };
  const blocks = bridge.toBlocks(program);
  const back = bridge.toAst(blocks);
  assert.equal(clean(back), clean(program), '表达式语句位往返');
});

test('R6 bridge：单语句 seq 的 _seq 包装保真（pDeepRec else=seq[单 action]）', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'if', cond: { type: 'literal', value: true }, then: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } },
  ] } };
  const blocks = bridge.toBlocks(program);
  const ifBlk = blocks.inputs.body0.block;
  const elseChain = ifBlk.inputs.else0.block;
  assert.equal(elseChain.fields._seq, 1, '单语句 seq 标记');
  const back = bridge.toAst(blocks);
  assert.equal(clean(back), clean(program), '_seq 保真');
});

test('R6 bridge：findBlockByPath —— 逐段命中（s[i]/then/else/body/expr·value）+ 未找到 null', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'set', name: 'x', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'cd1' }, right: { type: 'literal', value: 1 } } },
    { type: 'if', cond: { type: 'literal', value: true }, then: { type: 'action', name: 'wait' }, else: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } },
  ] } };
  const blocks = bridge.toBlocks(program);
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[0]'), 's[0] 命中');
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[0].value.left'), 'expr 左臂');
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[1].then'), 'then 臂');
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[1].else.s[0]'), 'else 链内');
  assert.ok(bridge.findBlockByPath(blocks, 'body.s[0].value'), 'set.value → expr');
  assert.equal(bridge.findBlockByPath(blocks, 'body.s[9]'), null, '越界 null');
  assert.equal(bridge.findBlockByPath(blocks, 'body.s[0].bogus'), null, '未知键 null');
  assert.equal(bridge.findBlockByPath(blocks, ''), null, '空路径 null');
});

test('R6 bridge：next 顶层属性与 inputs 挂法等价（防御两种形状）', () => {
  const viaInputs = { type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: { next: { block: { type: 'action', fields: { name: 'defend' }, inputs: {}, next: null } } }, next: null } } } };
  const viaTop = { type: 'loop_forever', inputs: { body0: { block: { type: 'action', fields: { name: 'wait' }, inputs: {}, next: { block: { type: 'action', fields: { name: 'defend' }, inputs: {}, next: null } } } } } };
  const a = bridge.toAst(viaInputs);
  const b = bridge.toAst(viaTop);
  assert.equal(JSON.stringify(a.body), JSON.stringify(b.body), '两种 next 挂法同构');
  assert.equal(a.body.statements.length, 2);
});
