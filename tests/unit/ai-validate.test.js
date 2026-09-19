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

test('T-AI-3 段位门控（两模式）：默认关闭 → 不产生 node_locked；开关开启 → 按可用节点集拒绝/放行（带 path 与 node）', () => {
  // 门控总开关（server/data/unlock.json `gating.enabled`；用户决策 2026-09-16 起默认 false = 全部解锁）。
  //   ast.validate 的门控段经注入的 unlock 实例（`ast.withGating(true)` = makeAst(null, unlock.withGating(true))）
  //   → 本用例两条路径都走真实工厂，不做单例打补丁。
  const gatedAst = ast.withGating(true);
  const loopProg = { type: 'program', version: 1, body: seq([{ type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([act('wait')]) }]) };
  const rnd = { type: 'program', version: 1, body: seq([
    { type: 'random', prob: { type: 'literal', value: 0.5 }, then: seq([act('wait')]), else: seq([act('wait')]) },
  ]) };
  const fn = prog('a5Function');
  // ① 默认（门控关闭）：段位不参与判定 → loop/random/function 各段位一律放行，且不出现 node_locked
  assert.equal(unlock.gatingEnabled, false, '缺省实例 = 门控关闭');
  const rOff = ast.validate(loopProg, 'common');
  assert.equal(rOff.errors.some((e) => e.code === 'node_locked'), false, `门控关闭 → 不产生 node_locked: ${JSON.stringify(rOff.errors)}`);
  assert.equal(rOff.ok, true, 'loop @ common 放行');
  assert.equal(ast.validate(rnd, 'rare').ok, true, 'random @ rare 放行');
  assert.equal(ast.validate(fn, 'epic').ok, true, 'function/call @ epic 放行');
  // ② 门控开启（回退模式）：loop @ common 拒绝（错误带 path 与 node）；rare 放行；random 需 epic；function 需 mythic
  const r1 = gatedAst.validate(loopProg, 'common');
  assert.equal(r1.ok, false);
  const g1 = r1.errors.find((e) => e.code === 'node_locked');
  assert.ok(g1, JSON.stringify(r1.errors));
  assert.equal(g1.node, 'loop');
  assert.ok(g1.path.startsWith('body'), g1.path);
  assert.equal(gatedAst.validate(loopProg, 'rare').ok, true);
  assert.equal(gatedAst.validate(rnd, 'rare').ok, false);
  assert.equal(gatedAst.validate(rnd, 'epic').ok, true, 'epic 继承解锁 random');
  assert.equal(gatedAst.validate(fn, 'epic').ok, false, 'A-5 含 function/call @ epic 拒绝');
  assert.equal(gatedAst.validate(fn, 'mythic').ok, true);
  // 段位原语（T-UL-1..4）保持可用（validateAi 退役后）；显式 withGating(true) 下门控口径不变
  const gated = unlock.withGating(true);
  assert.equal(gated.isUnlocked('rare', 'loop'), true);
  assert.equal(gated.isUnlocked('common', 'random'), false);
  assert.equal(gated.isUnlocked('epic', 'random'), true);
  assert.ok(gated.availableNodes('mythic').includes('function'));
  assert.equal(unlock.isUnlocked('common', 'random'), true, '缺省单例：全解锁');
});

test('T-AI-1 validate 三段合一：结构错误优先报告；合法性+门控并行；空 body 校验期拒绝（no_action_program）', () => {
  // 结构错误：未知节点 → unknown_node（结构阶段）
  const p1 = { type: 'program', version: 1, body: seq([{ type: 'eval' }]) };
  const r1 = ast.validate(p1, 'mythic');
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.code === 'unknown_node'));
  // 合法性 + 门控并行：loop 缺 action @ common → 两个错误都有
  const p2 = { type: 'program', version: 1, body: seq([{ type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: seq([{ type: 'set', name: 'x', value: { type: 'literal', value: 1 } }]) }]) };
  const r2 = ast.validate(p2, 'common');
  assert.ok(r2.errors.some((e) => e.code === 'branch_without_action'), JSON.stringify(r2.errors));
  // 门控段并行：默认（gating.enabled=false）**不再**报 node_locked；开关开启时（回退模式）必须报
  assert.ok(!r2.errors.some((e) => e.code === 'node_locked'), `默认关闭 → 无 node_locked: ${JSON.stringify(r2.errors)}`);
  const r2g = ast.withGating(true).validate(p2, 'common');
  assert.ok(r2g.errors.some((e) => e.code === 'node_locked' && e.node === 'loop'), `门控开启 → node_locked: ${JSON.stringify(r2g.errors)}`);
  // 空 body：**校验期拒绝**（B26 no_action_program；旧行为"空 body 合法"已被用户决策 A 收紧）。
  //   分层原则：校验层拒绝的是"把静默恒 wait 的程序当合法交付"；运行层对空 body 仍有 wait 兜底
  //   （runtime.resume 步数兜底），绕过校验直接注入运行时依旧安全退化——两层不互相替代。
  const p3 = { type: 'program', version: 1, body: seq([]) };
  const r3 = ast.validate(p3, 'common');
  assert.equal(r3.ok, false, '空 body 拒绝（no_action_program）');
  assert.ok(r3.errors.some((e) => e.code === 'no_action_program' && e.path === ''), JSON.stringify(r3.errors));
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
  // B26：新增错误码同样走 ai.validate.reject(warn)（bad_path 示例）
  logger.records.length = 0;
  a.validate({ type: 'program', version: 2, body: seq([{ type: 'get', path: 'self.hpx' }, act('wait')]) }, 'mythic');
  const rej2 = logger.records.find((x) => x.event === 'ai.validate.reject');
  assert.ok(rej2, 'bad_path 应有 ai.validate.reject');
  assert.equal(rej2.data.code, 'bad_path');
  assert.equal(rej2.data.path, 'body.s[0].path', '错误 path 精确定位到 get.path 字段');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    ast.checkLegality(prog('a5Function'));
    ast.validate(prog('a5Function'), 'mythic');
  });
});

// ==== B26：4 类"校验放过、运行期静默算错"的错误在校验期拒绝（用户决策 A）+ warnings 通道（D-80 不拒绝）====
// 分层原则（本批登记）：**校验层拒绝**（非法路径/未声明变量/表达式位语句节点/无 action 程序 → 错误码 + 精确 path，
//   让写错的程序当场报错）与**运行层兜底**（runtime.getPath 非法/缺失/越界 → 0；normalizeAction 未知名 → wait +
//   action.invalid）是两层，互不替代：绕过校验直接注入运行时的程序（tests/unit/runtime-limit.test.js 的病态 fixtures）
//   仍必须安全退化、绝不抛穿引擎。
const P2 = (body) => ({ type: 'program', version: 2, body });

test('B26 ① get.path 白名单：合法路径放行；容器/未知字段/危险段/已移除的 bullets → bad_path（带精确 path）', () => {
  // 合法清单（= runner.projectSnapshot 投影；见 ast.js 顶部白名单注释）
  const ALLOWED = ['tick', 'self.hp', 'self.baseHp', 'enemy.maxSp', 'self.facing', 'enemy.atk',
    'self.cooldowns.cd1', 'enemy.cooldowns.skill1',
    'self.effects[0].uid', 'self.effects[12].displacement', 'enemy.effects[3].remaining',
    'bases.self.hp', 'bases.enemy.def', 'field.fieldPx', 'field.cellPx'];
  const okProg = P2(seq(ALLOWED.map((path) => ({ type: 'get', path })).concat(act('wait'))));
  const rOk = ast.validate(okProg, 'mythic');
  assert.equal(rOk.ok, true, `白名单内路径应放行: ${JSON.stringify(rOk.errors)}`);
  // 非法清单：未知字段 / 容器当值 / 已移除的 bullets / 危险段 / 结构不合法
  const BAD = ['', 'self.hpx', 'enemy.hpX', 'self', 'enemy', 'self.cooldowns', 'self.effects', 'self.effects[0]',
    'bases.self', 'bases.enemy', 'field', 'field.x', 'tick.x', 'bullets', 'bullets[0].x', 'bullets[0].owner',
    'bases.self.x', 'self.effects[0].hpx', 'self.effects[0].remaining.x', 'self.effects[a].remaining',
    'self.cooldowns.1bad', '__proto__', 'constructor', 'prototype', 'self.__proto__', 'self.constructor',
    'self.cooldowns.__proto__', 'self.cooldowns.constructor'];
  for (const path of BAD) {
    const rb = ast.validate(P2(seq([{ type: 'get', path }, act('wait')])), 'mythic');
    assert.equal(rb.ok, false, `path=${JSON.stringify(path)} 应拒绝`);
    const e = rb.errors.find((x) => x.code === 'bad_path');
    assert.ok(e, `path=${JSON.stringify(path)} 应报 bad_path: ${JSON.stringify(rb.errors)}`);
    assert.equal(e.path, 'body.s[0].path', `错误带精确 path（get.path 字段）: ${JSON.stringify(path)}`);
    assert.ok(e.message.includes(JSON.stringify(path)), 'message 带非法取值');
  }
  // message 给合法示例；错误路径同时定位到表达式位（.expr.path）
  const rMsg = ast.validate(P2(seq([{ type: 'if', cond: { type: 'get', path: 'self.hpx' }, then: seq([act('a')]), else: seq([act('b')]) }])), 'mythic');
  const eMsg = rMsg.errors.find((x) => x.code === 'bad_path');
  assert.equal(eMsg.path, 'body.s[0].expr.path');
  assert.ok(eMsg.message.includes('self.effects[0].remaining'), `message 给合法示例: ${eMsg.message}`);
  // 运行层兜底不被替换：同一路径在 runtime 里仍是安全默认 0（绕过校验直接注入 → 不抛）
  const rt = require('../../server/ai/runtime.js');
  const ctx = rt.createContext(P2(seq([{ type: 'set', name: 'v', value: { type: 'get', path: 'self.hpx' } }, act('wait')])));
  assert.doesNotThrow(() => rt.resume(ctx, { self: { hp: 100 } }, { chance: () => false }));
  assert.equal(rt.getVar(ctx, 'v'), 0, '运行层：非法路径 → 安全默认 0');
});

test('B26 ② 未声明变量：getVar/set 引用未 var 声明的名字 → undefined_var（保守检查，带精确 path）', () => {
  // set 目标写错（运行期会静默新建变量）
  const p1 = P2(seq([{ type: 'var', name: 'cd', value: { type: 'literal', value: 0 } },
    { type: 'set', name: 'cd1', value: { type: 'literal', value: 1 } }, act('wait')]));
  const r1 = ast.validate(p1, 'mythic');
  assert.equal(r1.ok, false);
  const e1 = r1.errors.find((e) => e.code === 'undefined_var');
  assert.ok(e1, JSON.stringify(r1.errors));
  assert.equal(e1.path, 'body.s[1]', '错误带精确 path（set 节点）');
  assert.ok(e1.message.includes('cd1'));
  // getVar 读拼错（运行期静默 0）
  const p2 = P2(seq([{ type: 'var', name: 'cd', value: { type: 'literal', value: 0 } },
    { type: 'if', cond: { type: 'cmp', op: '<', left: { type: 'getVar', name: 'cd2' }, right: { type: 'literal', value: 3 } }, then: seq([act('a')]), else: seq([act('b')]) }]));
  const r2 = ast.validate(p2, 'mythic');
  assert.equal(r2.ok, false);
  const e2 = r2.errors.find((e) => e.code === 'undefined_var');
  assert.ok(e2, JSON.stringify(r2.errors));
  assert.equal(e2.path, 'body.s[1].expr.expr', '表达式位 getVar 的精确定位');
  // 保守边界（刻意放过，不误伤）：函数内声明 / 分支内声明后分支外使用 / 使用先于声明 → 全部合法
  const p3 = P2(seq([
    { type: 'function', name: 'f', body: seq([{ type: 'var', name: 'local', value: { type: 'literal', value: 1 } }, act('wait')]) },
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([{ type: 'if', cond: { type: 'literal', value: true },
      then: seq([{ type: 'var', name: 'branchOnly', value: { type: 'literal', value: 1 } }, { type: 'set', name: 'branchOnly', value: { type: 'literal', value: 2 } }, act('a')]),
      else: seq([{ type: 'set', name: 'branchOnly', value: { type: 'getVar', name: 'branchOnly' } }, act('b')]) }]) },
    { type: 'set', name: 'local', value: { type: 'getVar', name: 'branchOnly' } },
    { type: 'call', name: 'f' },
  ]));
  assert.equal(ast.validate(p3, 'mythic').ok, true, '保守检查不误伤作用域/顺序问题（只查"程序某处 var 声明过"）');
});

test('B26 ③ 表达式位写语句节点 → not_expression（运行期会把它们静默当 0/false）', () => {
  const cases = [
    { body: seq([{ type: 'if', cond: act('wait'), then: seq([act('a')]), else: seq([act('b')]) }]), path: 'body.s[0].expr' },
    { body: seq([{ type: 'var', name: 'n', value: { type: 'literal', value: 0 } }, { type: 'set', name: 'n', value: { type: 'var', name: 'n', value: { type: 'literal', value: 1 } } }, act('wait')]), path: 'body.s[1].expr' },
    { body: seq([{ type: 'loop', kind: 'count', times: seq([]), body: seq([act('a')]) }]), path: 'body.s[0].expr' },
    { body: seq([{ type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'literal', value: 1 }, else: { type: 'literal', value: 0 } }, { type: 'set', name: 'n', value: { type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: seq([act('a')]) } }, act('wait')]), path: 'body.s[1].expr' },
  ];
  for (const c of cases) {
    const r = ast.validate(P2(c.body), 'mythic');
    const e = r.errors.find((x) => x.code === 'not_expression');
    assert.ok(e, `应报 not_expression: ${JSON.stringify(r.errors)}`);
    assert.equal(e.path, c.path, '错误带精确 path（表达式槽）');
  }
  // 表达式节点全谱（literal/get/getVar/arith/cmp/logic/random）合法
  const good = P2(seq([
    { type: 'var', name: 'n', value: { type: 'literal', value: 0 } },
    { type: 'set', name: 'n', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'n' }, right: { type: 'get', path: 'self.hp' } } },
    { type: 'if',
      cond: { type: 'logic', op: 'and', left: { type: 'cmp', op: '<', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 3 } }, right: { type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'literal', value: 1 }, else: { type: 'literal', value: 0 } } },
      then: seq([act('a')]), else: seq([act('b')]) },
    act('wait'),
  ]));
  assert.equal(ast.validate(good, 'mythic').ok, true, JSON.stringify(ast.validate(good, 'mythic').errors));
});

test('B26 ④ 无 action 程序：整棵程序（含空 body）没有任何 action → no_action_program（只数存在性）', () => {
  const noAction = [
    seq([]),
    seq([{ type: 'var', name: 'n', value: { type: 'literal', value: 0 } }, { type: 'set', name: 'n', value: { type: 'literal', value: 1 } }]),
    seq([{ type: 'if', cond: { type: 'literal', value: true }, then: seq([{ type: 'set', name: 'n', value: { type: 'literal', value: 1 } }]), else: null }]),
  ];
  for (const body of noAction) {
    const r = ast.validate(P2(body), 'mythic');
    assert.equal(r.ok, false, JSON.stringify(body));
    assert.ok(r.errors.some((e) => e.code === 'no_action_program' && e.path === ''), JSON.stringify(r.errors));
  }
  // 只数"是否存在 action"，不做可达性分析：不可达分支里的 action 也算数
  const unreachable = P2(seq([{ type: 'if', cond: { type: 'literal', value: false }, then: seq([act('wait')]), else: null }]));
  assert.equal(ast.validate(unreachable, 'mythic').ok, true, '不可达分支的 action 也算数');
});

test('B26 ⑤ warnings 通道：动作名不在引擎词汇表 → warning（不阻断校验；D-80 运行期归一化 wait）', () => {
  const p = P2(seq([{ type: 'var', name: 'n', value: { type: 'literal', value: 0 } }, act('skill1'), act('skill:skill1'), act('move_right')]));
  const r = ast.validate(p, 'mythic');
  assert.equal(r.ok, true, 'warnings 不阻断校验：ok 仍为 true');
  assert.deepEqual(r.errors, [], '非法动作名不产生 errors');
  assert.equal(r.warnings.length, 1, JSON.stringify(r.warnings));
  const w = r.warnings[0];
  // 数据结构：{ path: AST 路径, code: 'unknown_action', name: 动作名, message: 说明 }
  assert.equal(w.path, 'body.s[1]');
  assert.equal(w.code, 'unknown_action');
  assert.equal(w.name, 'skill1');
  assert.equal(typeof w.message, 'string');
  // 词汇表来源 = server/data/ai-nodes.json：fixed 固定名 + 前缀式 parametric（'skill:'）
  const acts = require('../../server/data/ai-nodes.json').actions;
  assert.ok(acts.fixed.includes('move_right') && acts.fixed.includes('wait'), `fixed 词汇表: ${acts.fixed}`);
  assert.ok(acts.parametric.includes('skill:'), `前缀词汇表: ${acts.parametric}`);
  // 无 warning 时恒为空数组（调用方 Array.isArray 兜底）
  assert.deepEqual(ast.validate(P2(seq([act('move_right')])), 'mythic').warnings, []);
  // validateProgram 同样回带（/ai/compile 走 validateProgram；runner.js 用 || [] 兜底）
  const vp = ast.validateProgram(P2(seq([act('skill1')])));
  assert.equal(vp.ok, true);
  assert.equal(vp.warnings.length, 1);
  // 拒绝态 warnings 恒为数组（结构非法 → 不扫描）
  assert.deepEqual(ast.validate(P2(seq([{ type: 'eval' }])), 'mythic').warnings, []);
  // checkLegality 签名不变（{ok, errors}，无 warnings 字段）
  const cl = ast.checkLegality(p);
  assert.equal(typeof cl.ok, 'boolean');
  assert.equal(cl.warnings, undefined);
  assert.ok(Array.isArray(cl.errors));
});