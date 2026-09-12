'use strict';
// B14 server/ai/runtime.js 契约测试 —— 接口见 docs/interfaces.md §1（createContext/resume）
// 依据：examples/08-ai.md A-1..A-8 全案；systems/08-ai.md §4.3（续执行状态机）/§4.4（随机流）/§4.5（只读快照）；
//   decisions D-90/D-91/D-100..D-104；fixtures ai-programs.json（A-1/A-2/A-5 复用）
// 归属：tasks.md §6 B14（T-AI-4/5/7/9 + T-AF-1/2/3/11）；日志 ai.runtime.*（§4.6 L5 行）
// 注意：B14 交付状态机主体；步数/递归上限与错误兜底属 B15（本批测试绕过超限场景）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const runtime = require('../../server/ai/runtime.js');
const FIXTURES = require('../fixtures/ai-programs.json');
const prog = (key) => JSON.parse(JSON.stringify(FIXTURES[key].program));

// 只读快照（B14 测试基具；引擎注入 D-107 投影）
function mkSnapshot(overrides) {
  return Object.assign({
    self: { hp: 100, atk: 12, def: 8, sp: 60, mp: 40, x: 224, baseHp: 100, facing: 1 },
    enemy: { hp: 100, atk: 19, def: 9, sp: 60, mp: 40, x: 800, baseHp: 100, facing: -1 },
    bullets: [{ owner: 'p1', level: 2, dir: 1, x: 416, type: 'aoe' }],
    field: { fieldPx: 1024, cellPx: 64 },
  }, overrides);
}

// ai 流 stub（记录消耗次数；随机语义用可控值）
function mkRng(logCalls) {
  return { chance: () => { logCalls.push('ai'); return false; } };
}

// 辅助：连续 resume 直到产出（每 tick 一次）
function resumeN(ctx, snapshot, rng, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = runtime.resume(ctx, snapshot, rng);
    out.push(r.action);
  }
  return out;
}

test('T-AF-9/A-1 隐式主循环：跨 tick 持续产出（n<2 计数程序）', () => {
  const ctx = runtime.createContext(prog('a1Countdown'));
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 4);
  assert.deepEqual(actions, ['move_right', 'move_right', 'skill1', 'move_right'], 'A-1 tick 序列');
  assert.equal(runtime.getVar(ctx, 'n'), 1, 'tick4 后 n=1（回到第一行继续）');
});

test('T-AF-3/A-2 续执行断点：n 次 resume 与一次性跑到第 n 个 action 等价', () => {
  const ctx = runtime.createContext(prog('a2Breakpoint'));
  ctx.stepLimit = 100000; // B14 测试放宽（B15 接管限额语义）
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 5);
  assert.deepEqual(actions.slice(0, 4), ['skill1', 'defend', 'move_right', 'skill1'], 'A-2 断点序列（跑完回主循环）');
  // 等价性：一次性求值（模拟器：直接连跑直到 4 个 action）
  const ctx2 = runtime.createContext(prog('a2Breakpoint'));
  ctx2.stepLimit = 100000;
  const oneShot = [];
  let guard = 0;
  while (oneShot.length < 4 && guard++ < 1000) {
    const r = runtime.resume(ctx2, mkSnapshot(), mkRng([]));
    oneShot.push(r.action);
  }
  assert.deepEqual(oneShot, actions.slice(0, 4), 'T-AF-3 续执行等价性');
});

test('T-AI-5/A-3 循环计数跨 tick 保持（count=3 → 三个 move_left 后回主循环再入）', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 3 }, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } },
  ] } };
  const ctx = runtime.createContext(p);
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 4);
  assert.deepEqual(actions, ['move_left', 'move_left', 'move_left', 'move_left'], 'A-3 循环计数跨 tick + 回主循环再进');
});

test('T-AI-7/A-4 变量跨 tick 持久（vars 属 AiContext 不随 pass 清空；var 幂等声明、set 赋值）', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'cd1', value: { type: 'literal', value: 2 } },
    { type: 'set', name: 'cd1', value: { type: 'arith', op: '-', left: { type: 'getVar', name: 'cd1' }, right: { type: 'literal', value: 1 } } },
    { type: 'action', name: 'wait' },
  ] } };
  const ctx = runtime.createContext(p);
  // tick1：声明 cd1=2 → set → 1；tick2：var 幂等（保持 1）→ set → 0；tick3：var 幂等 → set → -1？——set 结果 0 后再 -1
  assert.equal(resumeN(ctx, mkSnapshot(), mkRng([]), 1)[0], 'wait');
  assert.equal(runtime.getVar(ctx, 'cd1'), 1, 'tick1 后 cd1=1');
  resumeN(ctx, mkSnapshot(), mkRng([]), 1);
  assert.equal(runtime.getVar(ctx, 'cd1'), 0, 'tick2 后 cd1=0（var 幂等不重置，set 递减）');
});

test('T-AF-11/A-5 函数：独立作用域 + 调用栈 + 词法读取外层（局部不泄漏）', () => {
  const ctx = runtime.createContext(prog('a5Function'));
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 2);
  assert.deepEqual(actions, ['skill1', 'move_right'], 'f 内 global>5 → skill1；返回后 body 继续 move_right');
  assert.equal(runtime.getVar(ctx, 'global'), 10);
  assert.equal(runtime.getVar(ctx, 'local'), 0, 'f 内局部不泄漏（getVar 安全默认 0）');
});

test('T-AI-9/A-7 随机：random 节点仅在求值消耗 ai 流；未走到不消耗（random 置 if cond 位）', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'if', cond: { type: 'random', prob: { type: 'literal', value: 0.5 }, then: null, else: null }, then: { type: 'seq', statements: [{ type: 'action', name: 'skill1' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'defend' }] } },
    { type: 'if', cond: { type: 'literal', value: false }, then: { type: 'seq', statements: [
      { type: 'random', prob: { type: 'literal', value: 0.9 }, then: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] }, else: null },
    ] }, else: null },
    { type: 'action', name: 'move_right' },
  ] } };
  const calls = [];
  const ctx = runtime.createContext(p);
  const r1 = runtime.resume(ctx, mkSnapshot(), mkRng(calls));
  assert.equal(r1.action, 'defend', 'random(false) → else 分支');
  assert.equal(calls.length, 1, '仅求值 1 次（未走到的 if 内 random 不消耗——A-7d）');
  // 挂起不消耗（A-7c）：下次 resume 只推进断点后语句（move_right 前无 random）
  runtime.resume(ctx, mkSnapshot(), mkRng(calls));
  assert.equal(calls.length, 1, '挂起期间不消耗随机');
});

test('T-I-1 条件/算术/逻辑/比较全谱：if 分支选择与操作符语义', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'if',
      cond: { type: 'logic', op: 'and', left: { type: 'cmp', op: '<', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 100 } }, right: { type: 'literal', value: true } },
      then: { type: 'seq', statements: [{ type: 'action', name: 'dodge_left' }] },
      else: { type: 'seq', statements: [{ type: 'action', name: 'dodge_right' }] } },
  ] } };
  const ctx = runtime.createContext(p);
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 2);
  assert.deepEqual(actions, ['dodge_left', 'dodge_left'], '真实快照 getVar(n)=0 安全默认；0<100 and true → then');
});

test('T-AF-1/A-8 只读快照：写入无效、安全默认、bullets 只读数组（深度相等）', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'set', name: 'x', value: { type: 'get', path: 'self.hp' } },
    { type: 'set', name: 'y', value: { type: 'get', path: 'enemy.no_such_field' } },
    { type: 'set', name: 'self.hp', value: { type: 'literal', value: 0 } },
    { type: 'action', name: 'wait' },
  ] } };
  const ctx = runtime.createContext(p);
  const snap = mkSnapshot();
  runtime.resume(ctx, snap, mkRng([]));
  assert.equal(runtime.getVar(ctx, 'x'), 100, 'A-8a 读 self.hp');
  assert.equal(runtime.getVar(ctx, 'y'), 0, 'A-8b 越界字段安全默认 0');
  assert.equal(snap.self.hp, 100, '快照不可变（set 不生效）');
  // bullets 只读
  const p2 = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'set', name: 'b', value: { type: 'bullets' } },
    { type: 'action', name: 'wait' },
  ] } };
  const ctx2 = runtime.createContext(p2);
  runtime.resume(ctx2, snap, mkRng([]));
  const b = runtime.getVar(ctx2, 'b');
  assert.equal(b.length, 1);
  assert.throws(() => { b[0].x = 0; }, TypeError, '深冻结');
});

test('RT-9 get 路径语义：self/enemy/bullets/field 白名单投影', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'set', name: 'a', value: { type: 'get', path: 'enemy.x' } },
    { type: 'set', name: 'c', value: { type: 'get', path: 'field.cellPx' } },
    { type: 'set', name: 'd', value: { type: 'get', path: 'bullets[0].owner' } },
    { type: 'action', name: 'wait' },
  ] } };
  const ctx = runtime.createContext(p);
  runtime.resume(ctx, mkSnapshot(), mkRng([]));
  assert.equal(runtime.getVar(ctx, 'a'), 800);
  assert.equal(runtime.getVar(ctx, 'c'), 64);
  assert.equal(runtime.getVar(ctx, 'd'), 'p1');
});

test('RT-10 while 循环：条件每迭代求值；while(false) 直接跳过', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'i', value: { type: 'literal', value: 0 } },
    { type: 'loop', kind: 'while', cond: { type: 'cmp', op: '<', left: { type: 'getVar', name: 'i' }, right: { type: 'literal', value: 2 } }, body: { type: 'seq', statements: [
      { type: 'set', name: 'i', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'i' }, right: { type: 'literal', value: 1 } } },
      { type: 'action', name: 'wait' },
    ] } },
    { type: 'action', name: 'move_right' },
  ] } };
  const ctx = runtime.createContext(p);
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 4);
  assert.deepEqual(actions, ['wait', 'wait', 'move_right', 'move_right'], 'while 两次迭代后退出 → move_right → 主循环重入（var 幂等 i=2 → while 直接跳过）');
});

test('RT-11 break：跳出最近循环（信号对象语义）', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'seq', statements: [
      { type: 'if', cond: { type: 'literal', value: true }, then: { type: 'seq', statements: [{ type: 'break' }] }, else: null },
      { type: 'action', name: 'unreachable' },
    ] } },
    { type: 'action', name: 'after_loop' },
  ] } };
  const ctx = runtime.createContext(p);
  // break 分支合法（B13 要求分支含行动？此项 break 无 action——静态应拒；B14 运行时下 break 直接跳，跳过 body 后续）
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 4);
  assert.deepEqual(actions, ['after_loop', 'after_loop', 'after_loop', 'after_loop'], '循环被 break 立即终止，后续语句执行');
});

test('T-AF-2 确定性：同 seed 同程序 → 同行动序列与 trace（随机流可控）', () => {
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'seq', statements: [{ type: 'action', name: 'a1' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'a2' }] } },
  ] } };
  const run1 = [];
  const ctx1 = runtime.createContext(p);
  // 固定 ai 流：true/false 交替
  let flip = true;
  const rng1 = { chance: () => { flip = !flip; return flip; } };
  for (let i = 0; i < 3; i++) run1.push(runtime.resume(ctx1, mkSnapshot(), rng1).action);
  const run2 = [];
  let flip2 = true;
  const rng2 = { chance: () => { flip2 = !flip2; return flip2; } };
  const ctx2 = runtime.createContext(p);
  for (let i = 0; i < 3; i++) run2.push(runtime.resume(ctx2, mkSnapshot(), rng2).action);
  assert.deepEqual(run1, run2, '同程序同随机流 → 同行动序列');
  assert.deepEqual(ctx1.trace, ctx2.trace, '同 trace（确定性）');
});

test('RT-13 stepLimit 兜底：超限 → wait + 重置入口（B15 完整语义前置验证）', () => {
  // 无限 while 循环（count 无界）→ 不产 action → 步数上限兜底
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'seq', statements: [
      { type: 'set', name: 'x', value: { type: 'getVar', name: 'x' } },
    ] } },
    { type: 'action', name: 'unreachable' },
  ] } };
  const ctx = runtime.createContext(p);
  ctx.stepLimit = 5; // 微量上限触发兜底
  const r = runtime.resume(ctx, mkSnapshot(), mkRng([]));
  assert.equal(r.action, 'wait', '超限兜底 wait');
  assert.equal(r.stepLimited, true);
  assert.equal(ctx.frames.length, 0, '重置到入口');
});

test('RT-14 补充分支：while(false) 直接跳过；getPath 深层缺失；set 词法写外层（函数内）', () => {
  // while(false) 跳过 → 直接 move_right
  const p1 = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'loop', kind: 'while', cond: { type: 'literal', value: false }, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } },
    { type: 'action', name: 'move_right' },
  ] } };
  const ctx1 = runtime.createContext(p1);
  assert.equal(runtime.resume(ctx1, mkSnapshot(), mkRng([])).action, 'move_right', 'while(false) 直接跳过');
  // getPath：深层缺失 → 0；对象根（无剩余段）→ 原样
  const p2 = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'set', name: 'a', value: { type: 'get', path: 'self.hp.deep.missing' } },
    { type: 'set', name: 'b', value: { type: 'get', path: 'bullets[0].x' } },
    { type: 'action', name: 'wait' },
  ] } };
  const ctx2 = runtime.createContext(p2);
  runtime.resume(ctx2, mkSnapshot(), mkRng([]));
  assert.equal(runtime.getVar(ctx2, 'a'), 0, '深层缺失安全默认');
  assert.equal(runtime.getVar(ctx2, 'b'), 416, '数组索引+属性');
  // set 词法写外层（A-5 变体：函数内 set 修改根变量 → 对外可见）
  const p3 = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'g', value: { type: 'literal', value: 1 } },
    { type: 'function', name: 'f', body: { type: 'seq', statements: [
      { type: 'set', name: 'g', value: { type: 'literal', value: 99 } },
      { type: 'action', name: 'skill1' },
    ] } },
    { type: 'call', name: 'f' },
    { type: 'action', name: 'wait' },
  ] } };
  const ctx3 = runtime.createContext(p3);
  assert.equal(runtime.resume(ctx3, mkSnapshot(), mkRng([])).action, 'skill1');
  assert.equal(runtime.getVar(ctx3, 'g'), 99, '函数内 set 词法写外层变量生效');
});

test('RT-15 表达式全操作符：arith 乘除/求整；cmp <=/>=/==/!=；logic or', () => {
  // 运算符全谱经一条程序验证（乘、除、==、!=、<=、>=、or）
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'a', value: { type: 'literal', value: 10 } },
    { type: 'if', cond: {
      type: 'logic', op: 'or',
      left: { type: 'cmp', op: '==', left: { type: 'arith', op: '*', left: { type: 'getVar', name: 'a' }, right: { type: 'literal', value: 2 } }, right: { type: 'literal', value: 20 } },
      right: { type: 'cmp', op: '<=', left: { type: 'getVar', name: 'a' }, right: { type: 'literal', value: 5 } },
    }, then: { type: 'seq', statements: [{ type: 'action', name: 'then_ok' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'else_bad' }] } },
    { type: 'set', name: 'b', value: { type: 'arith', op: '/', left: { type: 'literal', value: 17 }, right: { type: 'literal', value: 4 } } },
    { type: 'if', cond: { type: 'cmp', op: '!=', left: { type: 'getVar', name: 'b' }, right: { type: 'literal', value: 4 } }, then: { type: 'seq', statements: [{ type: 'action', name: 'div_ok' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'div_bad' }] } },
    { type: 'if', cond: { type: 'cmp', op: '>=', left: { type: 'getVar', name: 'a' }, right: { type: 'literal', value: 10 } }, then: { type: 'seq', statements: [{ type: 'action', name: 'ge_ok' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'ge_bad' }] } },
  ] } };
  const ctx = runtime.createContext(program);
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 5);
  assert.deepEqual(actions, ['then_ok', 'div_bad', 'ge_ok', 'then_ok', 'div_bad'], '乘/除/==/!=/<=/>=/or 全谱（一轮主循环跨 3 tick，每 tick 一个行动）');
  assert.equal(runtime.getVar(ctx, 'b'), 4, '17/4 求整 = 4');
});

test('RT-12 日志：ai.resume/ai.action 事件（§4.6 L5 行）与缺省 logger 安全', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const rt = runtime.withLogger(logger);
  const ctx = rt.createContext(prog('a2Breakpoint'));
  const snap = mkSnapshot();
  rt.resume(ctx, snap, mkRng([]));
  assert.ok(logger.records.some((x) => x.event === 'ai.resume' && x.data.action === 'skill1'), '应有 ai.resume');
  assert.ok(logger.records.some((x) => x.event === 'ai.action'), '应有 ai.action');
  assert.ok(ctx.trace.length > 0, 'trace 记录');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    const c = runtime.createContext(prog('a2Breakpoint'));
    runtime.resume(c, snap, mkRng([]));
    runtime.getVar(c, 'x');
  });
});

// ---- RT-16：兜底分支全谱（表达式/取值/结构边界；B14 契约的防御性语义） ----
const seqOf = (...names) => ({ type: 'seq', statements: names.map((n) => ({ type: 'action', name: n })) });

test('RT-16a 表达式兜底：未知 arith/cmp/logic 操作符与未知类型 → 0/false；getPath 边界；random then 支路', () => {
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'if', cond: { type: 'arith', op: '**', left: { type: 'literal', value: 2 }, right: { type: 'literal', value: 3 } }, then: seqOf('bad_arith_then'), else: seqOf('bad_arith_else') },
    { type: 'if', cond: { type: 'cmp', op: '~=', left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 1 } }, then: seqOf('bad_cmp_then'), else: seqOf('bad_cmp_else') },
    { type: 'if', cond: { type: 'logic', op: 'xor', left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 0 } }, then: seqOf('bad_logic_then'), else: seqOf('bad_logic_else') },
    { type: 'alienType', foo: 1 }, // 未知节点类型：表达式语句 → 0（无行动）
    { type: 'if', cond: { type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'literal', value: 1 }, else: { type: 'literal', value: 0 } }, then: seqOf('random_then'), else: seqOf('random_else') },
    { type: 'if', cond: { type: 'logic', op: 'or', left: { type: 'get', path: undefined }, right: { type: 'get', path: 'self[0]' } }, then: seqOf('g1_then'), else: seqOf('g1_else') },
    { type: 'if', cond: { type: 'get', path: '???' }, then: seqOf('g2_then'), else: seqOf('g2_else') },
    { type: 'if', cond: { type: 'get', path: 'bullets[9].level' }, then: seqOf('g3_then'), else: seqOf('g3_else') },
    { type: 'if', cond: { type: 'get', path: 'enemy.nothing' }, then: seqOf('g4_then'), else: seqOf('g4_else') },
    { type: 'if', cond: { type: 'get', path: 'bullets[0].dir' }, then: seqOf('g5_then'), else: seqOf('g5_else') },
    { type: 'if', cond: { type: 'get', path: 5 }, then: seqOf('g6_then'), else: seqOf('g6_else') },
  ] } };
  const ctx = runtime.createContext(program);
  const rngTrue = { chance: () => true }; // random then 支路
  const actions = resumeN(ctx, mkSnapshot(), rngTrue, 11);
  assert.deepEqual(actions.slice(0, 10), [
    'bad_arith_else', 'bad_cmp_else', 'bad_logic_else', 'random_then',
    'g1_else', 'g2_else', 'g3_else', 'g4_else', 'g5_then', 'g6_else',
  ], '未知操作符/类型 → falsy；random then；getPath 越界/非数组/缺字段/缺失path/非字符串 → 0');
  assert.equal(actions[10], 'bad_arith_else', '隐式主循环回绕（无 action 的语句不产出）');
});

test('RT-16b 结构兜底：break 无 loop、call 未定义、单节点函数体/if 分支/loop 体、null 语句、无 cond/无 else if', () => {
  // break 无 loop：弹空帧栈 → 隐式主循环重入 → 重复 break 无行动 → 步数兜底 wait（非法程序的防御行为）
  const c1 = runtime.createContext({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'break' }, { type: 'action', name: 'after_break' }] } });
  c1.stepLimit = 50;
  const r1 = runtime.resume(c1, mkSnapshot(), mkRng([]));
  assert.equal(r1.action, 'wait', 'break 无 loop → 防御性 wait');
  assert.equal(r1.stepLimited, undefined, 'guard 耗尽（主循环重入不增步数）→ 无 stepLimited 标记');

  // call 未定义函数：跳过（不崩）
  const c2 = runtime.createContext({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'call', name: 'missing_fn' }, { type: 'action', name: 'after_call' }] } });
  assert.equal(runtime.resume(c2, mkSnapshot(), mkRng([])).action, 'after_call', '未定义 call → 跳过');

  // 单节点函数体（非 seq）+ 单节点 if 分支 + 单节点 loop 体 + null 语句 + 无 cond/无 else 的 if + 数字表达式语句
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    null, // 空位：list 中 null 语句跳过
    { type: 'function', name: 'fnX', body: { type: 'action', name: 'fn_single' } },
    { type: 'if', cond: { type: 'literal', value: 1 }, then: { type: 'action', name: 'if_single' } }, // 无 else
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: { type: 'action', name: 'body_single' } },
    { type: 'if', then: seqOf('nope') }, // 无 cond（undefined → 0 → falsy）+ 无 else（br falsy → 跳过）
    5, // 数字表达式语句（非对象 → evalExpr 直返）
    { type: 'call', name: 'fnX' },
  ] } };
  const ctx = runtime.createContext(program);
  const actions = resumeN(ctx, mkSnapshot(), mkRng([]), 4);
  assert.deepEqual(actions, ['if_single', 'body_single', 'fn_single', 'if_single'], '单节点分支/函数体/循环体推进正确');

  // traceLimit=0：trace 记录被截断（不崩）
  const c3 = runtime.createContext({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'x' }] } });
  c3.traceLimit = 0;
  assert.equal(runtime.resume(c3, mkSnapshot(), mkRng([])).action, 'x');
  assert.equal(c3.trace.length, 0, 'traceLimit=0 → 不记录 trace');

  // 函数体内 break（无 loop）：帧清空且 scopes 回退到根（不崩，超步数兜底 wait）
  const c4 = runtime.createContext({ type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'x', value: { type: 'literal', value: 1 } },
    { type: 'function', name: 'fnB', body: { type: 'seq', statements: [{ type: 'break' }] } },
    { type: 'call', name: 'fnB' },
  ] } });
  c4.stepLimit = 500;
  const r4 = runtime.resume(c4, mkSnapshot(), mkRng([]));
  assert.equal(r4.action, 'wait', '函数内 break 清空帧后重入主循环 → 无行动 → 步数兜底');
  assert.equal(r4.stepLimited, undefined, 'guard 耗尽路径（无 stepLimited 标记）');
  assert.equal(runtime.getVar(c4, 'x'), 1, '变量保留在根作用域');

  // 顶层 body 非 seq（无 statements）→ 空语句表 → 步数兜底 wait
  const c5 = runtime.createContext({ type: 'program', version: 1, body: { type: 'action', name: 'never' } });
  c5.stepLimit = 20;
  const r5 = runtime.resume(c5, mkSnapshot(), mkRng([]));
  assert.equal(r5.action, 'wait');
  assert.equal(r5.stepLimited, undefined);

  // 非法程序：program 缺失 / body 缺失 → ai_invalid
  const c6 = runtime.createContext(undefined);
  assert.equal(runtime.resume(c6, mkSnapshot(), mkRng([])).error, 'ai_invalid', 'program 缺失 → ai_invalid');
  const c7 = runtime.createContext({ type: 'program', version: 1 });
  assert.equal(runtime.resume(c7, mkSnapshot(), mkRng([])).error, 'ai_invalid', 'body 缺失 → ai_invalid');
});

// ---- RT-17：P0-1 回归（审查 docs/reviews/B14.md）——函数作用域链跨 resume 重建 ----

test('RT-17a P0-1 回归：函数体 action 后 var/set 跨 resume 续执行（A-5/D-103；不抛、不泄漏）', () => {
  // 场景 A（审查复现）：var g=1; fn f { var local=99; action skill1; set local=getVar local }; call f; set g=g+10
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'g', value: { type: 'literal', value: 1 } },
    { type: 'function', name: 'f', body: { type: 'seq', statements: [
      { type: 'var', name: 'local', value: { type: 'literal', value: 99 } },
      { type: 'action', name: 'skill1' },
      { type: 'set', name: 'local', value: { type: 'getVar', name: 'local' } },
    ] } },
    { type: 'call', name: 'f' },
    { type: 'set', name: 'g', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'g' }, right: { type: 'literal', value: 10 } } },
  ] } };
  const ctx = runtime.createContext(program);
  const snap = mkSnapshot();
  const rng = mkRng([]);
  assert.doesNotThrow(() => {
    assert.equal(runtime.resume(ctx, snap, rng).action, 'skill1', 'tick1：函数内 action');
    assert.equal(runtime.resume(ctx, snap, rng).action, 'skill1', 'tick2：续执行 set local → fn 弹栈 → 顶层 set g');
  }, '跨 resume 函数续执行不抛（A-9d）');
  assert.equal(runtime.getVar(ctx, 'g'), 11, 'fn 完成后顶层 set g 生效（g=1+10）');
  assert.equal(runtime.getVar(ctx, 'local'), 0, 'local 不泄漏到根作用域（D-103）');
  assert.doesNotThrow(() => {
    assert.equal(runtime.resume(ctx, snap, rng).action, 'skill1', 'tick3 续跑');
  });
  assert.equal(runtime.getVar(ctx, 'g'), 21, '每轮顶层 set g 只执行一次（g=1+10*(tick-1)）');
});

test('RT-17b P0-1 回归：call 后同 tick 顶层 set——scopes 不误弹根作用域（不抛）', () => {
  // 场景 B（审查复现）：var g=1; fn f { action skill1 }; call f; set g=2
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'g', value: { type: 'literal', value: 1 } },
    { type: 'function', name: 'f', body: { type: 'seq', statements: [{ type: 'action', name: 'skill1' }] } },
    { type: 'call', name: 'f' },
    { type: 'set', name: 'g', value: { type: 'literal', value: 2 } },
  ] } };
  const ctx = runtime.createContext(program);
  const snap = mkSnapshot();
  const rng = mkRng([]);
  assert.equal(runtime.resume(ctx, snap, rng).action, 'skill1', 'tick1');
  assert.doesNotThrow(() => {
    assert.equal(runtime.resume(ctx, snap, rng).action, 'skill1', 'tick2：fn 完成弹栈后顶层 set g 不抛');
  }, 'call 后写变量不抛（A-9d）');
  assert.equal(runtime.getVar(ctx, 'g'), 2, 'g=2');
});

test('RT-17c P0-1 回归：递归跨 resume 作用域链重建（多层 fnScope 按帧序恢复，不抛）', () => {
  // var n=2; fn r { if n>0 then { set n=n-1; action dec; call r } else { action base } }; call r
  const program = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'var', name: 'n', value: { type: 'literal', value: 2 } },
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
  const ctx = runtime.createContext(program);
  const acts = resumeN(ctx, mkSnapshot(), mkRng([]), 4);
  assert.deepEqual(acts, ['dec', 'dec', 'base', 'base'], '递归跨 resume：2 层递减 → base；第二轮回 base（不抛）');
  assert.equal(runtime.getVar(ctx, 'n'), 0, 'n=0（递减到基）');
});