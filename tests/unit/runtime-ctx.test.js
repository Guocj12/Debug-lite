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

// ---- B26：快照读路径泛化（前置能力；ast 白名单校验依赖它） ----
// 旧实现只支持"基名 + 可选 [i] + 可选单层 .prop"，读不到 self.effects[0].remaining 这类新投影字段。
test('B26 getPath 泛化：a / a.b / a.b[i].c / a[i][j] 全谱可读（含新投影字段）', () => {
  const snap = {
    tick: 7,
    self: { hp: 100, facing: 1, cooldowns: { cd1: 3 }, effects: [{ uid: 'e1', kind: 'continuous', remaining: 2 }] },
    bases: { self: { hp: 88, def: 4 }, enemy: { hp: 90 } },
    field: { fieldPx: 1024, cellPx: 64 },
    grid: [[1, 2], [3, 4]],
  };
  // 每条路径经一次真实 resume（set r = get path）取值，锚定"快照 → AI 可读"的端到端语义
  const got = (path) => {
    const p = { type: 'program', version: 2, body: { type: 'seq', statements: [
      { type: 'set', name: 'r', value: { type: 'get', path } },
      { type: 'action', name: 'wait' },
    ] } };
    const ctx = runtime.createContext(p);
    runtime.resume(ctx, snap, mkRng([]));
    return runtime.getVar(ctx, 'r');
  };
  assert.equal(got('tick'), 7);
  assert.equal(got('self.hp'), 100);
  assert.equal(got('self.cooldowns.cd1'), 3, 'self.cooldowns.<sid>');
  assert.equal(got('self.effects[0].remaining'), 2, '三段路径：基 + [i] + 属性');
  assert.equal(got('self.effects[0].kind'), 'continuous');
  assert.equal(got('bases.self.hp'), 88, 'bases.self.<f>');
  assert.equal(got('field.cellPx'), 64);
  assert.equal(got('grid[1][0]'), 3, '多级索引');
  assert.equal(got('grid[0]'), snap.grid[0], '索引到数组元素（容器）原样返回');
  // 容器读取仍返回冻结的只读副本（不泄漏引擎可变引用）
  const cooldowns = got('self.cooldowns');
  assert.equal(cooldowns.cd1, 3);
  assert.throws(() => { cooldowns.cd1 = 9; }, TypeError, '容器为冻结副本（只读快照不变）');
  assert.equal(snap.self.cooldowns.cd1, 3, '引擎侧对象未被改写');
});

test('B26 getPath 兜底：非法路径/缺字段/非对象下钻/越界/索引落非数组/危险段 → 0（绝不抛）', () => {
  const snap = {
    tick: 7,
    self: { hp: 100, cooldowns: { cd1: 3 }, effects: [{ uid: 'e1', remaining: 2 }] },
    field: { fieldPx: 1024, cellPx: 64 },
  };
  const got = (path) => {
    const p = { type: 'program', version: 2, body: { type: 'seq', statements: [
      { type: 'set', name: 'r', value: { type: 'get', path } },
      { type: 'action', name: 'wait' },
    ] } };
    const ctx = runtime.createContext(p);
    runtime.resume(ctx, snap, mkRng([]));
    return runtime.getVar(ctx, 'r');
  };
  const ZERO = ['', 'self.hpx', 'self.hp.deep.missing', 'self.cooldowns.nope', 'self.effects[9].remaining',
    'self.effects[0].nope', 'self[0]', 'self.hp[0]', 'field.nope', '__proto__', 'self.__proto__',
    'constructor', 'prototype', 'self.constructor', 'self.effects[0].constructor', 'a b', 'a..b', 'a[', 'a]',
    '.a', 'a.', undefined, null, 5];
  for (const path of ZERO) {
    assert.equal(got(path), 0, `path=${String(path)} 应安全默认 0`);
  }
  // 危险段拒绝不得泄漏可变原型对象（旧实现 `get 'constructor'` 会返回 Object 构造函数）
  assert.notEqual(got('constructor'), Object, '不返回宿主对象');
  assert.equal(typeof got('__proto__'), 'number', '原型链读取被拒 → 0');
});