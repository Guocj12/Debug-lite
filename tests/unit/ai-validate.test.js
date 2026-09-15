'use strict';
// B13 ai/ast.js 合法性检测与段位门控契约测试 —— 接口见 docs/interfaces.md §1（checkLegality/validate）
// 依据：examples/08-ai.md A-6 全案（分支 action 规则 D-101）与 A-5（函数/调用）；systems/08-ai.md §4.2②/③；
//   decisions D-101..D-104；unlock.js 原语（B4，validateAi 退役由本模块统一承担）
// 归属：tasks.md §6 B13（T-AI-1/3/12 + T-UL-1..4 原语 + T-AF-5/10）；日志 ai.validate.reject(warn) + ai.validate(debug)（§4.6 L5 行）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const ast = require('../../server/ai/ast.js');
const unlock = require('../../server/core/unlock.js');
const FIXTURES = require('../fixtures/ai-programs.json');

const prog = (key) => JSON.parse(JSON.stringify(FIXTURES[key].program));
const seq = (statements) => ({ type: 'seq', statements });
const act = (name) => ({ type: 'action', name });

// A-6 辅助程序骨架：循环内 if（then/else 可注入）
function loopWithIf(thenStatements, elseStatements) {
  return {
    type: 'program', version: 1,
    body: seq([
      { type: 'loop', kind: 'count', times: { type: 'literal', value: 2 },
        body: seq([
          { type: 'if',
            cond: { type: 'literal', value: true },
            then: seq(thenStatements),
            else: elseStatements === null ? null : seq(elseStatements) },
        ]) },
    ]),
  };
}

test('T-AF-5/A-6 分支 action 规则全案（D-101）', () => {
  // A-6a 循环体直接有 action → 合法
  const a6a = { type: 'program', version: 1, body: seq([{ type: 'loop', kind: 'count', times: { type: 'literal', value: 2 }, body: seq([act('skill1')]) }]) };
  assert.equal(ast.checkLegality(a6a).ok, true, 'A-6a');
  // A-6b 循环内 if 的 else 无 action → 拒绝（循环体与其 else 分支双报）
  const a6b = loopWithIf([act('skill1')], [{ type: 'set', name: 'n', value: { type: 'literal', value: 1 } }]);
  const r6b = ast.checkLegality(a6b);
  assert.equal(r6b.ok, false, 'A-6b');
  assert.ok(r6b.errors.some((e) => e.code === 'branch_without_action' && e.path === 'body.s[0].body.s[0].else'), JSON.stringify(r6b.errors));
  assert.ok(r6b.errors.some((e) => e.code === 'branch_without_action' && e.path === 'body.s[0].body'), JSON.stringify(r6b.errors));
  // A-6c 两分支都有 action → 合法
  const a6c = loopWithIf([act('skill1')], [act('defend')]);
  assert.equal(ast.checkLegality(a6c).ok, true, 'A-6c');
  // A-6d 嵌套循环在 then → 合法（嵌套循环体有 action）
  const a6d = loopWithIf([{ type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([act('skill1')]) }], [act('defend')]);
  assert.equal(ast.checkLegality(a6d).ok, true, 'A-6d');
  // A-6e if 无 else（隐式空分支）→ 拒绝
  const a6e = loopWithIf([act('skill1')], null);
  const r6e = ast.checkLegality(a6e);
  assert.equal(r6e.ok, false, 'A-6e');
  assert.ok(r6e.errors.some((e) => e.path === 'body.s[0].body.s[0].else'), JSON.stringify(r6e.errors));
  // A-6f while(true) 循环体有 action → 合法
  const a6f = { type: 'program', version: 1, body: seq([{ type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: seq([act('move_right')]) }]) };
  assert.equal(ast.checkLegality(a6f).ok, true, 'A-6f');
  // A-6g 循环体只有 break → 拒绝（无 action）
  const a6g = { type: 'program', version: 1, body: seq([{ type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([{ type: 'break' }]) }]) };
  assert.equal(ast.checkLegality(a6g).ok, false, 'A-6g');
  // A-6h 函数体内循环缺 action → 拒绝（逐层检查）
  const a6h = { type: 'program', version: 1, body: seq([
    { type: 'function', name: 'f', body: seq([{ type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([{ type: 'set', name: 'x', value: { type: 'literal', value: 0 } }]) }]) },
  ]) };
  const r6h = ast.checkLegality(a6h);
  assert.equal(r6h.ok, false, 'A-6h');
  assert.ok(r6h.errors.some((e) => e.code === 'branch_without_action'), JSON.stringify(r6h.errors));
});

test('T-AI-12 break 与调用规则：循环外 break 拒绝；跨函数 break 拒绝；call 未定义拒绝；hoisting 合法', () => {
  // break 在顶层 → break_outside_loop
  const p1 = { type: 'program', version: 1, body: seq([{ type: 'break' }]) };
  const r1 = ast.checkLegality(p1);
  assert.equal(r1.ok, false);
  assert.equal(r1.errors[0].code, 'break_outside_loop');
  assert.equal(r1.errors[0].path, 'body.s[0]');
  // break 在函数内（无自身循环）→ 拒绝（跨函数 break）
  const p2 = { type: 'program', version: 1, body: seq([
    { type: 'function', name: 'f', body: seq([{ type: 'break' }]) },
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([act('wait')]) },
  ]) };
  assert.equal(ast.checkLegality(p2).ok, false, '跨函数 break 拒绝');
  // break 在循环内 if 内（分支仍含 action）→ 合法
  const p3 = { type: 'program', version: 1, body: seq([
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([
      { type: 'if', cond: { type: 'literal', value: true }, then: seq([{ type: 'break' }, act('wait')]), else: seq([act('wait')]) },
    ]) },
  ]) };
  assert.equal(ast.checkLegality(p3).ok, true, '循环内 if 内 break 合法（分支含 action）');
  // call 未定义 → unknown_call
  const p4 = { type: 'program', version: 1, body: seq([{ type: 'call', name: 'nope' }]) };
  const r4 = ast.checkLegality(p4);
  assert.equal(r4.ok, false);
  assert.equal(r4.errors[0].code, 'unknown_call');
  // hoisting：先调用后定义 → 合法（A-5 语义）
  const p5 = prog('a5Function');
  assert.equal(ast.checkLegality(p5).ok, true, 'a5Function 合法');
});

test('T-AI-3 段位门控：结构合法后按可用节点集拒绝/放行（错误带 path 与 node）', () => {
  const loopProg = { type: 'program', version: 1, body: seq([{ type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([act('wait')]) }]) };
  // loop @ common 拒绝（rare 解锁）
  const r1 = ast.validate(loopProg, 'common');
  assert.equal(r1.ok, false);
  const g1 = r1.errors.find((e) => e.code === 'node_locked');
  assert.ok(g1, JSON.stringify(r1.errors));
  assert.equal(g1.node, 'loop');
  assert.ok(g1.path.startsWith('body'), g1.path);
  // loop @ rare 通过
  assert.equal(ast.validate(loopProg, 'rare').ok, true);
  // random @ rare 拒绝 / @ epic 通过（继承）
  const rnd = { type: 'program', version: 1, body: seq([
    { type: 'random', prob: { type: 'literal', value: 0.5 }, then: seq([act('wait')]), else: seq([act('wait')]) },
  ]) };
  assert.equal(ast.validate(rnd, 'rare').ok, false);
  assert.equal(ast.validate(rnd, 'epic').ok, true, 'epic 继承解锁 random');
  // function/call @ epic 拒绝 / mythic 通过
  const fn = prog('a5Function');
  assert.equal(ast.validate(fn, 'epic').ok, false, 'A-5 含 function/call @ epic 拒绝');
  assert.equal(ast.validate(fn, 'mythic').ok, true);
  // 段位原语（T-UL-1..4）保持可用（unlock.validateAi 退役后）
  assert.equal(unlock.isUnlocked('rare', 'loop'), true);
  assert.equal(unlock.isUnlocked('common', 'random'), false);
  assert.equal(unlock.isUnlocked('epic', 'random'), true);
  assert.ok(unlock.availableNodes('mythic').includes('function'));
});

test('T-AI-1 validate 三段合一：结构错误优先报告；合法性+门控并行；空 body 合法（运行时兜底）', () => {
  // 结构错误：未知节点 → unknown_node（结构阶段）
  const p1 = { type: 'program', version: 1, body: seq([{ type: 'eval' }]) };
  const r1 = ast.validate(p1, 'mythic');
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.code === 'unknown_node'));
  // 合法性 + 门控并行：loop 缺 action @ common → 两个错误都有
  const p2 = { type: 'program', version: 1, body: seq([{ type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: seq([{ type: 'set', name: 'x', value: { type: 'literal', value: 1 } }]) }]) };
  const r2 = ast.validate(p2, 'common');
  assert.ok(r2.errors.some((e) => e.code === 'branch_without_action'), JSON.stringify(r2.errors));
  assert.ok(r2.errors.some((e) => e.code === 'node_locked' && e.node === 'loop'), JSON.stringify(r2.errors));
  // 空 body → 合法（wait 兜底）
  const p3 = { type: 'program', version: 1, body: seq([]) };
  assert.equal(ast.validate(p3, 'common').ok, true, '空 body 合法');
  // B12 fixtures 回归：coverageProgram（loop 体内 action）与 a1Countdown（顶层 if 无 else）@ mythic 全过
  assert.equal(ast.validate(prog('coverageProgram'), 'mythic').ok, true, '覆盖型程序合法');
  assert.equal(ast.validate(prog('a1Countdown'), 'mythic').ok, true, 'A-1 顶层 if 无 else 不触发分支规则');
});

test('T-AI-12b 表达式位不逃逸（审查 P2-1）：if.cond / loop.cond 内的 call/break 被捕获；顶层 if 无 else 显式用例', () => {
  // if.cond 内未定义 call → unknown_call
  const p1 = { type: 'program', version: 1, body: seq([
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([
      { type: 'if', cond: { type: 'call', name: 'ghost' }, then: seq([act('wait')]), else: seq([act('wait')]) },
    ]) },
  ]) };
  const r1 = ast.checkLegality(p1);
  assert.equal(r1.ok, false, 'cond 位 call 逃逸应被拒');
  assert.ok(r1.errors.some((e) => e.code === 'unknown_call' && e.path.includes('.expr')), JSON.stringify(r1.errors));
  // loop.while cond 位 break → break_outside_loop（cond 先于 body 求值，不在循环内）
  const p2 = { type: 'program', version: 1, body: seq([
    { type: 'loop', kind: 'while', cond: { type: 'break' }, body: seq([act('wait')]) },
  ]) };
  const r2 = ast.checkLegality(p2);
  assert.equal(r2.ok, false, 'cond 位 break 应拒');
  assert.ok(r2.errors.some((e) => e.code === 'break_outside_loop'), JSON.stringify(r2.errors));
  // 顶层 if 无 else + 分支有 action → 合法（A-1 显式用例；fixture a1Countdown 实际含 else，注释归因修正）
  const p3 = { type: 'program', version: 1, body: seq([
    { type: 'if', cond: { type: 'literal', value: true }, then: seq([act('move_right')]), else: null },
  ]) };
  assert.equal(ast.checkLegality(p3).ok, true, '顶层 if 无 else 合法');
});

test('T-AF-10 日志：ai.validate.reject(warn) 带 path/code；ai.validate(debug) ok 状态', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const a = ast.withLogger(logger);
  const bad = loopWithIf([act('skill1')], null);
  a.validate(bad, 'mythic');
  const rej = logger.records.find((x) => x.event === 'ai.validate.reject');
  assert.ok(rej, '应有 ai.validate.reject');
  assert.equal(rej.data.code, 'branch_without_action');
  assert.equal(rej.data.path, 'body.s[0].body.s[0].else');
  const okEvt = logger.records.filter((x) => x.event === 'ai.validate').pop();
  assert.ok(okEvt, '应有 ai.validate');
  assert.equal(okEvt.data.ok, false, '组合入口最终状态为拒绝');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    ast.checkLegality(prog('a5Function'));
    ast.validate(prog('a5Function'), 'mythic');
  });
});