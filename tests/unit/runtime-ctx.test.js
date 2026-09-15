'use strict';
// B16 上下文序列化契约测试 —— T-AF-7（serialize/restore 往返后继续执行结果一致）+ interfaces §4.5
//   AiContext 可序列化（programHash/frames/vars/halted/stepCount/trace/entry）；帧存 path、节点引用不序列化。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const runtime = require('../../server/ai/runtime.js');

function mkSnapshot(overrides) {
  return Object.assign({
    self: { hp: 100, atk: 12, def: 8, sp: 60, mp: 40, x: 224, baseHp: 100, facing: 1 },
    enemy: { hp: 100, atk: 19, def: 9, sp: 60, mp: 40, x: 800, baseHp: 100, facing: -1 },
    bullets: [],
    field: { fieldPx: 1024, cellPx: 64 },
  }, overrides);
}
function mkRng(logCalls) {
  return { chance: () => { logCalls.push('ai'); return false; } };
}

// 混合程序：count 循环 + if 分支 + 函数调用 + 顶层 set/action（帧类型全谱）
function mixedProgram() {
  return { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'n', value: { type: 'literal', value: 3 } },
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 2 }, body: { type: 'seq', statements: [
      { type: 'action', name: 'a' },
      { type: 'if', cond: { type: 'literal', value: 1 }, then: { type: 'seq', statements: [{ type: 'action', name: 'b' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'c' }] } },
    ] } },
    { type: 'function', name: 'f', body: { type: 'seq', statements: [
      { type: 'action', name: 'f1' },
      { type: 'set', name: 'x', value: { type: 'literal', value: 5 } },
    ] } },
    { type: 'call', name: 'f' },
    { type: 'set', name: 'n', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 1 } } },
    { type: 'action', name: 'tail' },
  ] } };
}

test('T-AF-7 serialize/restore 往返：中途序列化（JSON 往返）后继续执行与不间断基线一致', () => {
  const program = mixedProgram();
  const snap = mkSnapshot();
  const rng = mkRng([]);
  // 基线：一口气跑 10 次
  const base = runtime.createContext(program);
  const baseActions = [];
  for (let i = 0; i < 10; i++) baseActions.push(runtime.resume(base, snap, rng).action);
  // 中途：跑 4 次 → serialize（含 JSON 往返）→ restore → 再跑 6 次
  const ctx = runtime.createContext(program);
  const first = [];
  for (let i = 0; i < 4; i++) first.push(runtime.resume(ctx, snap, rng).action);
  const ser = JSON.parse(JSON.stringify(runtime.serializeContext(ctx)));
  const ctx2 = runtime.restoreContext(ser, program);
  const second = [];
  for (let i = 0; i < 6; i++) second.push(runtime.resume(ctx2, snap, rng).action);
  assert.deepEqual(second, baseActions.slice(4), '往返后继续执行的行动序列与基线一致');
  assert.deepEqual(ctx2.trace, base.trace, 'trace 逐条一致（含 result/depth）');
  assert.equal(runtime.getVar(ctx2, 'n'), runtime.getVar(base, 'n'), 'vars 一致');
  assert.equal(runtime.getVar(ctx2, 'x'), runtime.getVar(base, 'x'), '函数作用域效果一致');
});

test('serializeContext 产物是干净 JSON：帧不含节点引用，全体可 JSON 序列化', () => {
  const program = mixedProgram();
  const ctx = runtime.createContext(program);
  const snap = mkSnapshot();
  const rng = mkRng([]);
  runtime.resume(ctx, snap, rng); // 停在循环体内
  const ser = runtime.serializeContext(ctx);
  assert.equal(typeof JSON.stringify(ser), 'string', '可 JSON 序列化（无函数/环引用）');
  for (const f of ser.frames) {
    assert.equal(f.list, undefined, '帧不携带节点引用');
    assert.equal(f.node, undefined, 'loop 帧不携带节点引用');
    assert.equal(typeof f.path, 'string', '帧存 path');
  }
  assert.deepEqual(ser.vars, ctx.vars, 'vars 快照');
  assert.ok(Array.isArray(ser.trace), 'trace 数组');
});

test('restoreContext 初始态（零帧）与新建 ctx 等价；不认识路径防御为空帧表', () => {
  const program = mixedProgram();
  const snap = mkSnapshot();
  const rng = mkRng([]);
  const ctx1 = runtime.createContext(program);
  const ctx2 = runtime.restoreContext(runtime.serializeContext(ctx1), program);
  const a1 = [], a2 = [];
  for (let i = 0; i < 5; i++) {
    a1.push(runtime.resume(ctx1, snap, rng).action);
    a2.push(runtime.resume(ctx2, snap, rng).action);
  }
  assert.deepEqual(a2, a1, '初始态 restore 等价');
  // 坏帧路径：restore 后帧表为空（防御），继续执行退化为从头开始
  const ctx3 = runtime.restoreContext({ frames: [{ kind: 'loop', path: 'body.s[99].zzz', childIndex: 0 }], vars: {}, entry: 'body' }, program);
  assert.equal(ctx3.frames.length, 0, '无法反查的帧被丢弃');
  assert.equal(runtime.resume(ctx3, snap, rng).action, 'a', '丢弃坏帧后从头执行');
});

test('destroyContext：释放引用后 resume 防御性 wait（ai_invalid），不抛', () => {
  const ctx = runtime.createContext(mixedProgram());
  assert.doesNotThrow(() => runtime.destroyContext(ctx));
  assert.equal(ctx.frames.length, 0);
  assert.equal(ctx.program, null);
  const r = runtime.resume(ctx, mkSnapshot(), mkRng([]));
  assert.equal(r.action, 'wait');
  assert.equal(r.error, 'ai_invalid');
});

// ---- P1-1 回归（审查 docs/reviews/B16.md）：函数体内嵌套帧的 serialize/restore 反查 ----

test('P1-1 回归：函数内 count 循环挂起 → restore 后剩余迭代完整（A-3+A-5 组合）', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'function', name: 'f', body: { type: 'seq', statements: [
      { type: 'loop', kind: 'count', times: { type: 'literal', value: 3 }, body: { type: 'seq', statements: [{ type: 'action', name: 'skill1' }] } },
      { type: 'set', name: 'n', value: { type: 'literal', value: 5 } },
    ] } },
    { type: 'call', name: 'f' },
    { type: 'action', name: 'tail' },
  ] } };
  const snap = mkSnapshot();
  const rng = mkRng([]);
  const base = runtime.createContext(program);
  const baseActs = [];
  for (let i = 0; i < 10; i++) baseActs.push(runtime.resume(base, snap, rng).action);
  const ctx = runtime.createContext(program);
  assert.equal(runtime.resume(ctx, snap, rng).action, 'skill1', 'tick1：fn 内循环第 1 次迭代');
  const ser = JSON.parse(JSON.stringify(runtime.serializeContext(ctx)));
  const ctx2 = runtime.restoreContext(ser, program);
  const acts2 = [];
  for (let i = 0; i < 9; i++) acts2.push(runtime.resume(ctx2, snap, rng).action);
  assert.deepEqual(acts2, baseActs.slice(1), 'fn 内剩余 2 次迭代 + set n + tail + 下轮循环与基线一致');
  assert.deepEqual(ctx2.trace, base.trace, 'trace 逐条一致');
  assert.equal(runtime.getVar(ctx2, 'n'), 5, 'fn 内 set 生效（n=5）');
});

test('P1-1 回归：函数内 if 分支 action 后语句跨 resume 保留（分支 seq 帧恢复）', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'function', name: 'f', body: { type: 'seq', statements: [
      { type: 'if', cond: { type: 'literal', value: 1 },
        then: { type: 'seq', statements: [{ type: 'action', name: 'skill1' }, { type: 'set', name: 'n', value: { type: 'literal', value: 7 } }] },
        else: { type: 'seq', statements: [{ type: 'action', name: 'defend' }] } },
    ] } },
    { type: 'call', name: 'f' },
    { type: 'action', name: 'tail' },
  ] } };
  const snap = mkSnapshot();
  const rng = mkRng([]);
  const base = runtime.createContext(program);
  const baseActs = [];
  for (let i = 0; i < 9; i++) baseActs.push(runtime.resume(base, snap, rng).action);
  const ctx = runtime.createContext(program);
  assert.equal(runtime.resume(ctx, snap, rng).action, 'skill1', 'tick1：fn 内分支 action');
  const ser = JSON.parse(JSON.stringify(runtime.serializeContext(ctx)));
  const ctx2 = runtime.restoreContext(ser, program);
  const acts2 = [];
  for (let i = 0; i < 8; i++) acts2.push(runtime.resume(ctx2, snap, rng).action);
  assert.deepEqual(acts2, baseActs.slice(1), '分支 seq 内 set n → tail → 下轮与基线一致');
  assert.equal(runtime.getVar(ctx2, 'n'), 7, 'fn 内分支 set 生效');
});

test('P1-1 回归：深层递归中途 serialize/restore 继续与基线一致', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'n', value: { type: 'literal', value: 6 } },
    { type: 'function', name: 'r', body: { type: 'seq', statements: [
      { type: 'if', cond: { type: 'cmp', op: '>', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 0 } },
        then: { type: 'seq', statements: [
          { type: 'set', name: 'n', value: { type: 'arith', op: '-', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 1 } } },
          { type: 'action', name: 'dec' },
          { type: 'call', name: 'r' },
        ] },
        else: { type: 'seq', statements: [{ type: 'action', name: 'base' }] } },
    ] } },
    { type: 'call', name: 'r' },
  ] } };
  const snap = mkSnapshot();
  const rng = mkRng([]);
  const base = runtime.createContext(program);
  const baseActs = [];
  for (let i = 0; i < 12; i++) baseActs.push(runtime.resume(base, snap, rng).action);
  const ctx = runtime.createContext(program);
  const first = [];
  for (let i = 0; i < 3; i++) first.push(runtime.resume(ctx, snap, rng).action);
  assert.deepEqual(first, ['dec', 'dec', 'dec'], '前 3 层递归');
  const ser = JSON.parse(JSON.stringify(runtime.serializeContext(ctx)));
  const ctx2 = runtime.restoreContext(ser, program);
  const acts2 = [];
  for (let i = 0; i < 9; i++) acts2.push(runtime.resume(ctx2, snap, rng).action);
  assert.deepEqual(acts2, baseActs.slice(3), '3 层 fn 帧 + 分支帧恢复后与基线一致（多层 fnScope 链）');
  assert.equal(runtime.getVar(ctx2, 'n'), 0, 'n 递减到 0');
});

test('P2-3 防御：serializeContext(null/undefined) → null 不抛', () => {
  assert.equal(runtime.serializeContext(null), null);
  assert.equal(runtime.serializeContext(undefined), null);
  assert.doesNotThrow(() => runtime.serializeContext({}));
});