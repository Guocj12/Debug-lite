'use strict';
// B15 ai/runtime 兜底与轨迹契约测试 —— 依据 examples/08-ai.md A-9 全案 + systems/08-ai.md §4.3(3/4/6)；
// 日志事件 §4.6 L5 ai.runtime 行（ai.step.limit/ai.depth.limit/trace.truncated/ai.node/ai.error，B14~B15 冻结）。
// 归属：tasks.md §6 B15（T-AI-6/10 + T-AF-4/6）；A-8（T-AI-8/T-AF-1）由 B14 runtime.test.js 覆盖。
// 注意：病态 fixtures（pBurnSteps/pDeepRec）绕过 ast 校验直接注入运行时——测的是"运行时兜底，绝不抛穿引擎"。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const runtime = require('../../server/ai/runtime.js');
const FIXTURES = require('../fixtures/ai-programs.json');
const prog = (key) => JSON.parse(JSON.stringify(FIXTURES[key].program));

// 只读快照基具（与 runtime.test.js 同构）
function mkSnapshot(overrides) {
  return Object.assign({
    self: { hp: 100, atk: 12, def: 8, sp: 60, mp: 40, x: 224, baseHp: 100, facing: 1 },
    enemy: { hp: 100, atk: 19, def: 9, sp: 60, mp: 40, x: 800, baseHp: 100, facing: -1 },
    bullets: [{ owner: 'p1', level: 2, dir: 1, x: 416, type: 'aoe' }],
    field: { fieldPx: 1024, cellPx: 64 },
  }, overrides);
}
function mkRng(logCalls) {
  return { chance: () => { logCalls.push('ai'); return false; } };
}

test('T-AF-4/A-9a 步数兜底：guard 耗尽无行动 → wait + 重置入口 + ai.step.limit(warn){steps:10000} + stepLimited', () => {
  const logger = createLogger({ level: 'all', ringSize: 30000 });
  const rt = runtime.withLogger(logger);
  const ctx = rt.createContext(prog('pBurnSteps')); // count=99999 无 action 循环（D-101 拒；运行时兜底）
  const snap = mkSnapshot();
  const rng = mkRng([]);
  const r1 = rt.resume(ctx, snap, rng);
  assert.equal(r1.action, 'wait', '步数兜底返回 wait（D-81）');
  assert.equal(r1.stepLimited, true, 'stepLimited 标记');
  const warn = logger.records.find((x) => x.event === 'ai.step.limit');
  assert.ok(warn, 'ai.step.limit warn 记录存在');
  assert.equal(warn.level, 'warn');
  assert.ok(warn.data.steps <= runtime.STEP_LIMIT, `单 tick 步数不超 STEP_LIMIT（实际 ${warn.data.steps}）`);
  assert.equal(warn.data.steps, runtime.STEP_LIMIT, 'guard 耗尽即 stepCount == STEP_LIMIT（主循环重入不计步场景除外）');
  // 重置到入口：第二 tick 从入口重新 burn（行为一致 → 证明 frames 已清空）
  const r2 = rt.resume(ctx, snap, rng);
  assert.equal(r2.action, 'wait');
  assert.equal(r2.stepLimited, true, '重置后再次兜底');
  assert.equal(runtime.getVar(ctx, 'n'), 2 * Math.floor(runtime.STEP_LIMIT / 3), '两次 burn 各推进 floor(STEP_LIMIT/3) 次 set（每次迭代 3 步：loop/body/pop）');
});

test('A-9e trace 截断：超过 2000 条不再记录 + trace.truncated(warn) 仅一次', () => {
  const logger = createLogger({ level: 'all', ringSize: 30000 });
  const rt = runtime.withLogger(logger);
  const ctx = rt.createContext(prog('pBurnSteps'));
  const snap = mkSnapshot();
  const rng = mkRng([]);
  rt.resume(ctx, snap, rng);
  assert.equal(ctx.trace.length, ctx.traceLimit, 'trace 封顶 = TRACE_LIMIT(2000)（A-9e）');
  assert.equal(ctx.traceTruncated, true, '截断标记');
  const trunc = logger.records.filter((x) => x.event === 'trace.truncated');
  assert.equal(trunc.length, 1, 'trace.truncated 仅记一次');
  assert.equal(trunc[0].data.limit, runtime.TRACE_LIMIT);
  const nodes = logger.records.filter((x) => x.event === 'ai.node');
  assert.equal(nodes.length, ctx.traceLimit, 'ai.node(trace)：每入一条 trace 记一次（封顶 2000）');
  // 第二 tick：不再追加、也不再记截断事件
  rt.resume(ctx, snap, rng);
  assert.equal(ctx.trace.length, ctx.traceLimit, '截断后不再记录');
  assert.equal(logger.records.filter((x) => x.event === 'trace.truncated').length, 1, '不重复记截断');
});

test('A-9b 递归上限：65 层 → wait + 弹栈到入口 + ai.depth.limit(warn){limit:64,depth:65}，之后继续执行', () => {
  const logger = createLogger({ level: 'all', ringSize: 5000 });
  const rt = runtime.withLogger(logger);
  const ctx = rt.createContext(prog('pDeepRec')); // n=70，每 tick 递一层、减一
  const snap = mkSnapshot();
  const rng = mkRng([]);
  const out = [];
  for (let i = 0; i < 64; i++) out.push(rt.resume(ctx, snap, rng).action); // 64 层递减
  assert.deepEqual(out, new Array(64).fill('dec'), '前 64 tick 各减一');
  const r65 = rt.resume(ctx, snap, rng);
  assert.equal(r65.action, 'wait');
  assert.equal(r65.depthLimited, true, '第 65 层触发深度上限');
  const warn = logger.records.find((x) => x.event === 'ai.depth.limit');
  assert.ok(warn, 'ai.depth.limit warn 记录存在');
  assert.deepEqual(warn.data, { limit: runtime.RECURSION_LIMIT, depth: runtime.RECURSION_LIMIT + 1 });
  // 弹栈到入口后继续（vars 保留：n=70-64=6）→ 再 6 个 dec 后 base
  const after = [];
  for (let i = 0; i < 8; i++) after.push(rt.resume(ctx, snap, rng).action);
  assert.deepEqual(after, ['dec', 'dec', 'dec', 'dec', 'dec', 'dec', 'base', 'base'], '弹栈后继续递减到 0 → base 分支');
  assert.equal(runtime.getVar(ctx, 'n'), 0, 'n 递减到 0（vars 跨弹栈保留）');
  assert.ok(!logger.records.some((x) => x.event === 'ai.step.limit'), '深度兜底不触发步数兜底');
});

test('T-AI-10/T-AF-6 trace 一致：顺序=求值顺序、末条 action==返回值、跨 tick 连续编号', () => {
  const logger = createLogger({ level: 'all', ringSize: 2000 });
  const rt = runtime.withLogger(logger);
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'x', value: { type: 'literal', value: 0 } },
    { type: 'if', cond: { type: 'literal', value: 1 }, then: { type: 'seq', statements: [{ type: 'action', name: 'A' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'B' }] } },
  ] } };
  const ctx = rt.createContext(program);
  const snap = mkSnapshot();
  const rng = mkRng([]);
  const r1 = rt.resume(ctx, snap, rng);
  assert.equal(r1.action, 'A');
  assert.deepEqual(ctx.trace.map((e) => [e.path, e.nodeType]), [
    ['body.s[0]', 'var'],
    ['body.s[1]', 'if'],
    ['body.s[1].then.s[0]', 'action'],
  ], 'trace 顺序 = 求值顺序（T-AF-6）');
  const last = ctx.trace[ctx.trace.length - 1];
  assert.equal(last.nodeType, 'action', '末条为 action');
  assert.equal(last.result, r1.action, '末条 action == 返回值（T-AF-6）');
  assert.deepEqual(ctx.trace.map((e) => e.seq), [0, 1, 2], 'seq 连续编号');
  // 跨 tick：主循环回绕 → 编号连续
  const r2 = rt.resume(ctx, snap, rng);
  assert.equal(r2.action, 'A');
  assert.deepEqual(ctx.trace.map((e) => e.seq), [0, 1, 2, 3, 4, 5], '跨 tick 编号连续');
  const nodes = logger.records.filter((x) => x.event === 'ai.node');
  assert.equal(nodes.length, 6, 'ai.node 事件 = trace 条目数');
  assert.equal(nodes[5].data.path, 'body.s[1].then.s[0]', 'ai.node data.path 与 trace 一致');
});

test('A-9d 内部异常：快照 getter 抛错 → wait + ai.error(err) 日志 + 绝不抛穿引擎', () => {
  const logger = createLogger({ level: 'all', ringSize: 2000 });
  const rt = runtime.withLogger(logger);
  const evilSelf = { hp: 100, def: 8, x: 224, baseHp: 100, facing: 1 };
  Object.defineProperty(evilSelf, 'atk', { enumerable: true, get() { throw new Error('boom'); } });
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'get', path: 'self.atk' },
    { type: 'action', name: 'x' },
  ] } };
  const ctx = rt.createContext(program);
  let r = null;
  assert.doesNotThrow(() => { r = rt.resume(ctx, mkSnapshot({ self: evilSelf }), mkRng([])); }, '内部异常绝不抛穿（A-9d）');
  assert.equal(r.action, 'wait');
  assert.equal(r.error, 'ai_crash');
  const rec = logger.records.find((x) => x.event === 'ai.error');
  assert.ok(rec, 'ai.error 日志记录存在');
  assert.equal(rec.level, 'error');
  assert.equal(rec.data.message, 'boom', 'ai.error 记录消息体');
  assert.ok(typeof rec.data.stack === 'string' && rec.data.stack.length > 0, 'ai.error 补 stack（P2-3 可观测性）');
});

test('A-9b/T-AI-6 组合：深度兜底后帧清空，后续 resume 从入口继续（无残留调用栈）', () => {
  const rt = runtime.withLogger(createLogger({ level: 'silent' }));
  const ctx = rt.createContext(prog('pDeepRec'));
  const snap = mkSnapshot();
  const rng = mkRng([]);
  for (let i = 0; i < 65; i++) rt.resume(ctx, snap, rng); // 含第 65 tick 的深度兜底 wait
  assert.equal(ctx.frames.length, 0, '深度兜底后帧栈清空（弹栈到入口）');
  const r = rt.resume(ctx, snap, rng);
  assert.equal(r.action, 'dec', '下一 tick 从入口正常执行（无残留）');
});