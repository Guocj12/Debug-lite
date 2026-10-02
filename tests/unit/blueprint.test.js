'use strict';
// D-178 积木蓝图 → AST 编译器契约测试（server/ai/blueprint.js）
// 依据：docs/systems/12-ai-nodes.md；docs/interfaces.md §1 server/ai/blueprint.js
// 口径：玩家只见积木层；编译产物是**旧 AST**（运行时/回放/排名零改动）→ 因此本文件最重要的断言是
//   「编译产物必过 ast.validate」与「用真实 runtime 跑出来的行为符合积木语义」。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const blueprint = require('../../server/ai/blueprint.js');
const ast = require('../../server/ai/ast.js');
const runtime = require('../../server/ai/runtime.js');

const CATALOG = blueprint.catalog();
const bp = (body) => ({ type: 'blueprint', version: 1, body });
const n = (uid, node, params, inputs) => ({ uid, node, params: params || {}, inputs: inputs || [] });

// 真实 runtime 用的只读快照（x 为**格序号**，D-174）
function snap(over) {
  return Object.assign({
    tick: 5,
    self: { hp: 100, maxHp: 100, mp: 40, maxMp: 40, sp: 60, maxSp: 60, atk: 12, def: 8, x: 3, facing: 1, baseHp: 100, cooldowns: {}, effects: [], skills: [] },
    enemy: { hp: 100, maxHp: 100, mp: 40, maxMp: 40, sp: 60, maxSp: 60, atk: 19, def: 9, x: 6, facing: -1, baseHp: 100, cooldowns: {}, effects: [], skills: [] },
    bases: { self: { hp: 100, maxHp: 100, def: 64 }, enemy: { hp: 100, maxHp: 100, def: 64 } },
    field: { fieldPx: 1024, cellPx: 64 },
  }, over);
}
const rng = () => ({ chance: () => false });
function steps(program, snapshot, count, ctxIn) {
  const ctx = ctxIn || runtime.createContext(program);
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(runtime.resume(ctx, snapshot, rng()).action);
  return { actions: out, ctx };
}

/* ---------- BP-1 结构校验 ---------- */
test('BP-1 蓝图结构校验：根/版本/空体/uid/节点/arity/参数', () => {
  assert.equal(blueprint.validateBlueprint(null).ok, false, 'null → 非法');
  assert.equal(blueprint.validateBlueprint({ type: 'program', version: 2, body: [] }).ok, false, 'program 不是 blueprint');
  assert.equal(blueprint.validateBlueprint({ type: 'blueprint', version: 9, body: [n('a', 'a_wait')] }).ok, false, '版本越界');
  assert.equal(blueprint.validateBlueprint(bp([])).ok, false, '空体');
  assert.equal(blueprint.validateBlueprint(bp([n('a', 'nope')])).ok, false, '未知节点');
  assert.equal(blueprint.validateBlueprint(bp([n('a', 'a_wait'), n('a', 'a_wait')])).ok, false, 'uid 重复');
  assert.equal(blueprint.validateBlueprint(bp([n('a', 'f_if', {}, [n('b', 'c_and', {}, [n('c', 'c_random'), n('d', 'c_random')])])])).ok, false, 'arity 不足');
  assert.equal(blueprint.validateBlueprint(bp([n('a', 'f_if', {}, [n('b', 'a_wait'), n('c', 'a_wait')])])).ok, false, '条件位放了语句节点');
  assert.equal(blueprint.validateBlueprint(bp([n('a', 'c_gap_less', { x: 99 })])).ok, false, '参数越界');
  assert.equal(blueprint.validateBlueprint(bp([n('a', 'm_read', { target: 'zzz' })])).ok, false, '坏记忆引用');
  assert.equal(blueprint.validateBlueprint(bp([n('a', 'r_call', { target: 'zzz' })])).ok, false, '坏子程序引用');
});

/* ---------- BP-2 新手级蓝图：编译 + 校验 + 真实行为 ---------- */
test('BP-2 新手蓝图：编译过 ast.validate，且真实 runtime 行为符合积木语义', () => {
  // 如果(我的血量<30%) 则 防御 否则【如果(距离<3格) 则 放技能1 否则 等待】
  const program_bp = bp([
    n('t1', 'f_if', {}, [
      n('c1', 'c_hp_below', { x: 30 }),
      n('a1', 'a_defend'),
      n('t2', 'f_if', {}, [
        n('c2', 'c_gap_less', { x: 3 }),
        n('a2', 'a_skill', { slot: 1 }),
        n('a3', 'a_wait'),
      ]),
    ]),
  ]);
  const r = blueprint.compileBlueprint(program_bp);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(ast.validate(r.program).ok, true, '编译产物必须过 ast.validate');

  // 血满 + 距离 3（enemy 6 − self 3）→ 走"否则→如果(距离<3)→否则→等待"
  assert.equal(steps(r.program, snap(), 1).actions[0], 'wait');
  // 距离 2 → 放技能 1
  assert.equal(steps(r.program, snap({ enemy: Object.assign(snap().enemy, { x: 5 }) }), 1).actions[0], 'skill:skill1');
  // 血低 → 防御
  assert.equal(steps(r.program, snap({ self: Object.assign(snap().self, { hp: 20 }) }), 1).actions[0], 'defend');
});

/* ---------- BP-3 全目录扫描：52 个节点都能编译通过 ---------- */
test('BP-3 全目录：每个节点构造最小合法蓝图 → 编译 + ast.validate 全通过', () => {
  let seqId = 0;
  const filler = {
    stmt: () => n(`fill_s${seqId++}`, 'a_wait'),
    bool: () => n(`fill_b${seqId++}`, 'c_gap_less', { x: 2 }),
    value: () => n(`fill_v${seqId++}`, 's_gap'),
  };
  const built = [];
  for (const cat of CATALOG) {
    const spec = cat.inputs || { min: 0, max: 0 };
    const kinds = spec.kinds || [];
    const inputs = [];
    for (let i = 0; i < spec.min; i += 1) {
      const kind = kinds[i] !== undefined ? kinds[i] : kinds[kinds.length - 1];
      inputs.push(filler[kind]());
    }
    const params = {};
    for (const p of (cat.params || [])) {
      if (p.type === 'uid') { params[p.key] = cat.id === 'm_read' ? 'mem1' : 'sub1'; continue; }
      if (p.default !== undefined) params[p.key] = p.default;
    }
    const node = n(`u_${cat.id}`, cat.id, params, inputs);
    // 每个节点单独成蓝图；需要前置/包裹的特例单独处理
    let body;
    if (cat.id === 'f_break') body = [n('loop1', 'f_loop_n', { n: 2 }, [n('brk', 'f_break')])];
    else if (cat.id === 'm_read') body = [n('mem1', 'm_remember', {}, [n('v1', 's_my_sp')]), node];
    else if (cat.id === 'r_call') body = [n('sub1', 'r_sub', { label: 'x' }, [n('s1', 'a_wait')]), node];
    else body = [node];
    const res = blueprint.compileBlueprint(bp(body));
    assert.equal(res.ok, true, `${cat.id}（${cat.quality}）编译失败：${JSON.stringify(res.errors)}`);
    built.push(cat.id);
  }
  assert.equal(built.length, CATALOG.length, '目录节点数一致');
  assert.ok(CATALOG.length >= 50, `目录节点数 ${CATALOG.length} 应 ≥ 50`);
});

/* ---------- BP-4 记忆：跨帧持久 + 语义 ---------- */
test('BP-4 记忆节点：记住/读取/计数/计时器跨帧生效（真实 runtime）', () => {
  // 计数+1（每帧）→ 用『比较(读取记忆 >= 3)』判定
  const counter = blueprint.compileBlueprint(bp([
    n('m1', 'm_counter'),
    n('t1', 'f_if', {}, [
      n('c1', 'c_compare', { op: '>=' }, [n('r1', 'm_read', { target: 'm1' }), n('k1', 's_tick')]),
      n('a1', 'a_defend'),
      n('a2', 'a_wait'),
    ]),
  ]));
  assert.equal(counter.ok, true, JSON.stringify(counter.errors));
  const run = steps(counter.program, snap(), 3);
  // tick=5 的 s_tick=5；m1 前两帧 1/2（<5）→ wait，第 3 帧 m1 仍 <5 → wait（证明计数在累加，未重置）
  assert.deepEqual(run.actions, ['wait', 'wait', 'wait']);
  assert.equal(runtime.getVar(run.ctx, '__m_m1'), 3, '计数每帧 +1 且跨帧保留（无 var 声明也持久）');

  // 计时器 2 帧：第 1 帧等待，第 2 帧执行子节点（后撤）
  const timer = blueprint.compileBlueprint(bp([n('mt', 'm_timer', { n: 2 }, [n('a', 'a_retreat')])]));
  assert.equal(timer.ok, true, JSON.stringify(timer.errors));
  assert.deepEqual(steps(timer.program, snap(), 4).actions, ['wait', 'move_left', 'wait', 'move_left']);
});

/* ---------- BP-5 子程序 ---------- */
test('BP-5 子程序：定义 + 调用编译成 function/call 并被 ast 接受', () => {
  const r = blueprint.compileBlueprint(bp([
    n('s1', 'r_sub', { label: '保命' }, [n('s1a', 'a_defend')]),
    n('c1', 'r_call', { target: 's1' }),
    n('w1', 'a_wait'),
  ]));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const json = JSON.stringify(r.program);
  assert.ok(json.includes('"function"') && json.includes('sub_s1') && json.includes('"call"'), '含 function/call');
  assert.deepEqual(steps(r.program, snap(), 2).actions, ['defend', 'wait']);
});

/* ---------- BP-6 德摩根取反 ---------- */
test('BP-6 非：比较取反 + 且或交换（德摩根）', () => {
  // 非(距离<3) ≡ 距离>=3
  const a = blueprint.compileBlueprint(bp([n('t', 'f_if', {}, [
    n('c', 'c_not', {}, [n('x', 'c_gap_less', { x: 3 })]),
    n('y', 'a_defend'), n('z', 'a_wait'),
  ])]));
  assert.equal(a.ok, true, JSON.stringify(a.errors));
  const condPath = a.program.body.statements[0].cond;
  assert.equal(condPath.op, '>=', 'cmp 取反');
  // 距离正好 3 → 条件成立 → 防御
  assert.equal(steps(a.program, snap(), 1).actions[0], 'defend');
  // 非(且(距离<3, 距离>1)) ≡ 或(距离>=3, 距离<=1)
  const b = blueprint.compileBlueprint(bp([n('t', 'f_if', {}, [
    n('c', 'c_not', {}, [n('and', 'c_and', {}, [n('x', 'c_gap_less', { x: 3 }), n('y', 'c_gap_greater', { x: 1 })])]),
    n('p', 'a_defend'), n('q', 'a_wait'),
  ])]));
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  const cond = b.program.body.statements[0].cond;
  assert.equal(cond.op, 'or', 'logic 交换');
  assert.equal(cond.left.op, '>=');
  assert.equal(cond.right.op, '<=');
});

/* ---------- BP-7 集合类条件的固定索引展开 ---------- */
test('BP-7 集合条件：对手被控制 / 我有技能就绪（固定索引展开，不改运行时）', () => {
  const r = blueprint.compileBlueprint(bp([n('t', 'f_if', {}, [
    n('c', 'c_foe_stunned'), n('a', 'a_defend'), n('b', 'a_wait'),
  ])]));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // 敌方第 2 个效果是 control → 成立
  const foe = Object.assign(snap().enemy, { effects: [{ kind: 'continuous' }, { kind: 'control' }] });
  assert.equal(steps(r.program, snap({ enemy: foe }), 1).actions[0], 'defend');
  // 无效果 → 不成立
  assert.equal(steps(r.program, snap(), 1).actions[0], 'wait');

  const ready = blueprint.compileBlueprint(bp([n('t', 'f_if', {}, [
    n('c', 'c_any_skill_ready'), n('a', 'a_defend'), n('b', 'a_wait'),
  ])]));
  assert.equal(ready.ok, true, JSON.stringify(ready.errors));
  const selfCd = Object.assign(snap().self, { cooldowns: { skill2: 3 } });
  assert.equal(steps(ready.program, snap({ self: selfCd }), 1).actions[0], 'defend', 'skill1 就绪 → 成立');
  const allCd = Object.assign(snap().self, { cooldowns: { skill1: 1, skill2: 3, skill3: 2 } });
  assert.equal(steps(ready.program, snap({ self: allCd }), 1).actions[0], 'wait', '全冷却 → 不成立');
});

/* ---------- BP-8 技能数据（只投影自己） ---------- */
test('BP-8 我的技能射程：读 self.skills[i].range（投影新增字段）', () => {
  const r = blueprint.compileBlueprint(bp([n('t', 'f_if', {}, [
    n('c', 'c_compare', { op: '<=' }, [n('g', 's_gap'), n('sr', 's_my_skill_range', { slot: 1 })]),
    n('a', 'a_skill', { slot: 1 }), n('b', 'a_wait'),
  ])]));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const self = Object.assign(snap().self, { skills: [{ slotKey: 'skill1', type: 'melee', range: 4 }] });
  // 距离 3 ≤ 射程 4 → 放技能
  assert.equal(steps(r.program, snap({ self }), 1).actions[0], 'skill:skill1');
  const far = Object.assign(snap().enemy, { x: 12 }); // 距离 9 > 4
  assert.equal(steps(r.program, snap({ self, enemy: far }), 1).actions[0], 'wait');
});

/* ---------- BP-9 traceMap / stats / 确定性 ---------- */
test('BP-9 traceMap 覆盖语句节点、stats 统计正确、编译确定性', () => {
  const program_bp = bp([
    n('t1', 'f_if', {}, [n('c1', 'c_gap_less', { x: 3 }), n('a1', 'a_defend'), n('a2', 'a_wait')]),
  ]);
  const r = blueprint.compileBlueprint(program_bp);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.traceMap['body.s[0]'], 't1', '语句路径 → 积木 uid');
  assert.equal(r.traceMap['body.s[0].then.s[0]'], 'a1');
  assert.equal(r.traceMap['body.s[0].else.s[0]'], 'a2');
  assert.equal(r.traceMap['body.s[0].cond'], undefined, '表达式节点不进 trace');
  assert.deepEqual(r.stats, { slots: 4, byQuality: { common: 4 }, byNode: { f_if: 1, c_gap_less: 1, a_defend: 1, a_wait: 1 } }, 'stats 统计真实节点（含条件）');
  const again = blueprint.compileBlueprint(JSON.parse(JSON.stringify(program_bp)));
  assert.equal(JSON.stringify(again.program), JSON.stringify(r.program), '同蓝图 → 同 AST（确定性）');
  assert.deepEqual(again.traceMap, r.traceMap);
});

/* ---------- BP-11 错误分支全覆盖（编译器必须给中文可读错误，且不产出半成品） ---------- */
test('BP-11 编译错误分支：结构/参数/引用/取反 逐类给出中文错误', () => {
  const cases = [
    ['根不是 blueprint', { type: 'x' }, 'not_blueprint'],
    ['body 非数组', { type: 'blueprint', version: 1, body: {} }, 'bad_body'],
    ['缺 uid', bp([{ node: 'a_wait', params: {}, inputs: [] }]), 'bad_uid'],
    ['arity 过多', bp([n('a', 'c_and', {}, [n('b', 'c_random'), n('c', 'c_random'), n('d', 'c_random')])]), 'too_many_inputs'],
    ['输入类别错（值位放条件）', bp([n('a', 'v_arith', { op: '+' }, [n('b', 'c_random'), n('c', 's_gap')])]), 'bad_input_kind'],
    ['int 参数越界', bp([n('a', 'c_tick_after', { x: 999 })]), 'bad_param'],
    ['pct 参数越界', bp([n('a', 'c_hp_below', { x: 0 })]), 'bad_param'],
    ['slot 参数非法', bp([n('a', 'a_skill', { slot: 9 })]), 'bad_param'],
    ['enum 参数非法', bp([n('a', 'v_arith', { op: '^' }, [n('b', 's_gap'), n('c', 's_tick')])]), 'bad_param'],
    ['距离区间 X>Y', bp([n('a', 'c_gap_between', { x: 5, y: 2 })]), 'bad_param'],
    ['蓝图嵌套过深', (function deepBp() {
      let inner = n('deep_leaf', 'a_wait');
      for (let i = 0; i < 26; i += 1) inner = n(`d${i}`, 'f_if', {}, [n(`dc${i}`, 'c_gap_less', { x: 3 }), inner, n(`de${i}`, 'a_wait')]);
      return bp([inner]);
    })(), 'too_deep'],
    ['uid 未选择（记忆/子程序）', bp([n('a', 'm_read', { target: '' })]), 'bad_param'],
    ['数字参数越界', bp([n('a', 'f_if', {}, [n('c', 'c_compare', { op: '<' }, [n('l', 's_foe_hp_pct'), n('r', 'v_number', { value: 9999 })]), n('t', 'a_wait'), n('e', 'a_wait')])]), 'bad_param'],
    ['除法右值为 0', bp([n('a', 'f_if', {}, [n('c', 'c_compare', { op: '>' }, [n('l', 'v_arith', { op: '/' }, [n('x', 's_gap'), n('zero', 's_tick')]), n('r', 's_gap')]), n('t', 'a_wait'), n('e', 'a_wait')])]), null],
  ];
  for (const [label, input, code] of cases) {
    const r = blueprint.compileBlueprint(input);
    if (code === null) continue; // 该例仅验证"不崩"
    assert.equal(r.ok, false, `${label} 应被拒绝`);
    assert.ok(r.errors.some((e) => e.code === code), `${label} 期望 ${code}，实得 ${JSON.stringify(r.errors.map((e) => e.code))}`);
    assert.equal(r.program, null, `${label} 失败时不得产出程序`);
  }
});

/* ---------- BP-12 记忆/零帧循环/补动作分支 ---------- */
test('BP-12 兜底分支：记忆声明块不占帧、分支缺动作自动补等待、随机条件可编译', () => {
  // 记忆声明块（loop{count,0}）不得消耗 tick：第一帧就应产出真实动作
  const mem = blueprint.compileBlueprint(bp([
    n('m1', 'm_remember', {}, [n('v1', 's_my_sp')]),
    n('a1', 'a_defend'),
  ]));
  assert.equal(mem.ok, true, JSON.stringify(mem.errors));
  assert.deepEqual(steps(mem.program, snap(), 2).actions, ['defend', 'defend'], '声明块不占帧');

  // 分支里只有"计算/记住"（无动作）→ 编译器自动补 wait，且仍过 ast.validate
  const branchy = blueprint.compileBlueprint(bp([
    n('t1', 'f_if', {}, [
      n('c1', 'c_gap_less', { x: 3 }),
      n('m2', 'm_counter'),
      n('w1', 'a_wait'),
    ]),
  ]));
  assert.equal(branchy.ok, true, JSON.stringify(branchy.errors));
  assert.equal(ast.validate(branchy.program).ok, true);
  assert.equal(steps(branchy.program, snap(), 1).actions[0], 'wait', 'then 分支无动作 → 补 wait');

  // 随机条件（表达式位 random）与「非(随机)」
  const rnd = blueprint.compileBlueprint(bp([n('t', 'f_if', {}, [
    n('c', 'c_random', { x: 40 }), n('a', 'a_defend'), n('b', 'a_wait'),
  ])]));
  assert.equal(rnd.ok, true, JSON.stringify(rnd.errors));
  const rndNot = blueprint.compileBlueprint(bp([n('t', 'f_if', {}, [
    n('c', 'c_not', {}, [n('r', 'c_random', { x: 40 })]), n('a', 'a_defend'), n('b', 'a_wait'),
  ])]));
  assert.equal(rndNot.ok, true, JSON.stringify(rndNot.errors));
  assert.equal(rndNot.program.body.statements[0].cond.prob.op, '-', '非(随机) → 概率取补（1-p）');

  // 循环体 / 打断：编译产物结构正确
  const looped = blueprint.compileBlueprint(bp([
    n('l1', 'f_loop_n', { n: 2 }, [n('br', 'f_break')]),
    n('a2', 'a_defend'),
  ]));
  assert.equal(looped.ok, true, JSON.stringify(looped.errors));
  assert.equal(looped.program.body.statements[0].kind, 'count');
  assert.equal(looped.program.body.statements[0].body.statements[0].type, 'break');
});

/* ---------- BP-13 条件类节点逐个数值语义 ---------- */
test('BP-13 条件语义：血%/距离区间/帧数/背水/基地血量/效果剩余帧', () => {
  const mk = (condNode, over) => {
    const r = blueprint.compileBlueprint(bp([n('t', 'f_if', {}, [condNode, n('a', 'a_defend'), n('b', 'a_wait')])]));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    return steps(r.program, snap(over), 1).actions[0];
  };
  assert.equal(mk(n('c', 'c_gap_between', { x: 2, y: 4 })), 'defend', '距离 3 落在 [2,4]');
  assert.equal(mk(n('c', 'c_tick_after', { x: 3 })), 'defend', 'tick=5 > 3');
  assert.equal(mk(n('c', 'c_skill_ready', { slot: 2 }), { self: Object.assign(snap().self, { cooldowns: { skill2: 0 } }) }), 'defend');
  assert.equal(mk(n('c', 'c_skill_ready', { slot: 2 }), { self: Object.assign(snap().self, { cooldowns: { skill2: 2 } }) }), 'wait');
  // 对手血量% < 50%（数字常量节点 v_number）
  assert.equal(mk(n('c', 'c_compare', { op: '<' }, [n('l', 's_foe_hp_pct'), n('r', 'v_number', { value: 0.5 })]),
    { enemy: Object.assign(snap().enemy, { hp: 10 }) }), 'defend', '对手血量 10% < 50%');  // 基地血量%（我方基地满血 → > 50%）
  assert.equal(mk(n('c', 'c_compare', { op: '>' }, [n('v', 's_base_hp_pct', { side: 'self' }), n('k', 's_gap')]), { self: Object.assign(snap().self, { x: 0 }), enemy: Object.assign(snap().enemy, { x: 10 }) }), 'wait', '1.0 > 10 不成立');
  // 效果剩余帧（自身第 0 个效果剩 3 帧 > 0 → 有）
  assert.equal(mk(n('c', 'c_has_effect'), { self: Object.assign(snap().self, { effects: [{ uid: 'e1', remaining: 3 }] }) }), 'defend');
});

test('BP-10 128 槽上限 + 深层嵌套不被 analyzeDepth 误判', () => {
  const many = [];
  for (let i = 0; i < 129; i += 1) many.push(n(`w${i}`, 'a_wait'));
  assert.equal(blueprint.validateBlueprint(bp(many)).ok, false, '超过 128 槽 → 拒绝');

  // 深层嵌套（20 层 if）→ 编译必须成功（analyzeDepth 已随 D-178 提高）
  let inner = n('deep_a', 'a_wait');
  for (let i = 0; i < 20; i += 1) {
    inner = n(`deep${i}`, 'f_if', {}, [n(`deepc${i}`, 'c_gap_less', { x: 3 }), inner, n(`deepe${i}`, 'a_wait')]);
  }
  const deep = blueprint.compileBlueprint(bp([inner]));
  assert.equal(deep.ok, true, `深层嵌套应通过：${JSON.stringify(deep.errors)}`);
  assert.equal(ast.validate(deep.program).ok, true);
  assert.ok(deep.program.body.statements[0].then.statements[0].then, '嵌套结构保留（分支统一编译成 seq）');
});
