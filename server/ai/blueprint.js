/* server/ai/blueprint.js —— 积木蓝图（玩家层）→ AST（执行层）编译器（L5，D-178）
 *
 * 设计（用户 2026-09-28 拍板）：
 *   · 玩家只与**积木节点**打交道；编译产物是**旧 AST**，故 runtime / engine / 回放 / 排名**零改动**；
 *   · 节点目录 = server/data/ai-node-catalog.json（单一数据源，**只有原语、没有战术宏**）。
 *
 * 三条必须遵守的底层事实（本文件的实现全部围绕它们）：
 *   ① **嵌套 seq 不可执行**：runtime 只把 seq 当"帧"处理于 根 body / if.then / if.else / random.then / random.else /
 *      loop.body / function.body 这些**分支位**（那里取 `.statements`），而 statements 列表里的 `seq` 语句
 *      没有任何分支处理（会落到表达式兜底被静默忽略）→ 编译器在组装语句列表时**必须扁平化**（flat）。
 *   ② **traceMap 后置生成**：扁平化会移动语句位置，故编译期只给语句节点打临时标签 `__uid`，
 *      组装完成后再按最终 AST 走一遍算出真实路径（body.s[i] / .then / .else / .body），
 *      然后**剥掉标签**（不污染 programHash）。
 *   ③ **记忆变量声明**：AST 合法层要求 getVar/set 的名字在程序某处被 var 声明过（保守检查，不区分顺序），
 *      而顶层 var 会随隐式主循环每轮重跑（= 每轮清空记忆）→ 声明放进**执行 0 次**的循环体
 *      （runtime 对 loop{count,times:0} 直接弹栈：不产行动、不占帧）；真实写入发生在首次 set
 *      （未声明 → 落 ctx.vars 根作用域，跨帧持久，runtime.js:13/91-96/104-107）。
 *
 * 编译契约：compileBlueprint(bp) 返回的 program **必须能过 ast.validate**（编译器最后一步做校验）。
 * 纯函数、确定性：同一蓝图 → 逐字节相同的 AST（记忆变量名由节点 uid 派生）。
 */
'use strict';

const CATALOG = require('../data/ai-node-catalog.json');
const PRESET_DATA = require('../data/ai-blueprint-presets.json');
const ast = require('./ast.js');

const NODE_BY_ID = Object.fromEntries(CATALOG.nodes.map((n) => [n.id, n]));
const BLUEPRINT_VERSION = CATALOG.version;
const MAX_SLOTS = 128;          // cl:128 蓝图节点数上限（用户拍板：128；与 dodgePx 撞值，属 AI 层常量）
const MAX_DEPTH = 24;           // 蓝图嵌套深度上限（UI 与可读性保护）
const EFFECT_SCAN_SLOTS = CATALOG._scanSlots.effects; // 集合类条件的索引展开上界
const SKILL_SLOTS = CATALOG._scanSlots.skills;
const TAG = '__uid';            // 编译期临时标签（最终会剥掉）

/* ================= 1. AST 构造小工具 ================= */
// 注意：AST 校验的环检测按**对象引用**判重 → 任何被复用的节点对象都会误报 ai_cycle，
//   故所有构造器一律返回新对象（不要提取共享常量）。
const lit = (v) => ({ type: 'literal', value: v });
const get = (p) => ({ type: 'get', path: p });
const arith = (op, l, r) => ({ type: 'arith', op, left: l, right: r });
const cmp = (op, l, r) => ({ type: 'cmp', op, left: l, right: r });
const logic = (op, l, r) => ({ type: 'logic', op, left: l, right: r });
const act = (name) => ({ type: 'action', name });
const seq = (list) => ({ type: 'seq', statements: list });
const ifn = (cond, then, els) => ({ type: 'if', cond, then, else: els });
const loopCount = (n, body) => ({ type: 'loop', kind: 'count', times: lit(n), body });
const loopWhile = (cond, body) => ({ type: 'loop', kind: 'while', cond, body });
const getVar = (name) => ({ type: 'getVar', name });
const setVar = (name, value) => ({ type: 'set', name, value });
const randExpr = (p) => ({ type: 'random', prob: lit(p) });
const wait = () => act('wait');
const GAP = () => arith('-', get('enemy.x'), get('self.x'));
const pctOf = (num, den) => arith('/', get(num), get(den));
const memName = (uid) => `__m_${uid}`;
const subName = (uid) => `sub_${uid}`;

// 比较运算符取反（德摩根用）
const NOT_OP = { '>': '<=', '<': '>=', '>=': '<', '<=': '>', '==': '!=', '!=': '==' };

/* ================= 2. 工具：扁平化 / 动作保证 ================= */
// 语句列表扁平化（底层事实①）：把内层 seq 的 statements 就地展开，其余原样保留
function flat(list) {
  const out = [];
  const push = (x) => {
    if (x === undefined || x === null) return;
    if (Array.isArray(x)) { x.forEach(push); return; }
    if (typeof x !== 'object') return;
    if (x.type === 'seq') { (x.statements || []).forEach(push); return; }
    out.push(x);
  };
  (list || []).forEach(push);
  return out;
}

function hasAction(list) {
  let found = false;
  const scan = (n) => {
    if (!n || typeof n !== 'object' || found) return;
    if (n.type === 'action' || n.type === 'call') { found = true; return; }
    if (n.type === 'seq') n.statements.forEach(scan);
    else if (n.type === 'if') { scan(n.then); scan(n.else); }
    else if (n.type === 'loop') scan(n.body);
    else if (n.type === 'random') { scan(n.then); scan(n.else); }
  };
  list.forEach(scan);
  return found;
}

// 分支位（if.then/else、random.then/else、loop.body、function.body）：必须是 seq，且必须含动作
function branchOf(list) {
  const stmts = flat(list);
  return seq(hasAction(stmts) ? stmts : stmts.concat([wait()]));
}

/* ================= 3. 结构校验 ================= */
function makeCtx(bp) {
  return { bp, errors: [], refs: { memories: new Set(), subs: new Set() } };
}

function paramOf(catalogNode, bnode, key) {
  const spec = (catalogNode.params || []).find((p) => p.key === key);
  const raw = bnode.params ? bnode.params[key] : undefined;
  if (raw === undefined || raw === null || raw === '') return spec ? spec.default : undefined;
  return raw;
}

function walkBp(bp, fn) {
  const visit = (n, path, depth) => {
    if (!n || typeof n !== 'object') return;
    fn(n, path, depth);
    const ins = Array.isArray(n.inputs) ? n.inputs : [];
    ins.forEach((c, i) => visit(c, `${path}.inputs[${i}]`, depth + 1));
  };
  (Array.isArray(bp.body) ? bp.body : []).forEach((n, i) => visit(n, `body[${i}]`, 1));
}

function validateShape(bp) {
  const errors = [];
  const push = (path, code, message) => errors.push({ path, code, message });
  if (!bp || typeof bp !== 'object' || bp.type !== 'blueprint') {
    return { ok: false, errors: [{ path: '', code: 'not_blueprint', message: '根必须是 blueprint' }] };
  }
  if (!Number.isInteger(bp.version) || bp.version < 1 || bp.version > BLUEPRINT_VERSION) {
    push('version', 'bad_version', `蓝图版本非法（当前支持 1..${BLUEPRINT_VERSION}）`);
  }
  if (!Array.isArray(bp.body)) {
    push('body', 'bad_body', 'body 必须是节点数组');
    return { ok: false, errors };
  }
  if (bp.body.length === 0) push('body', 'empty_body', '蓝图至少要有一个节点');

  const seen = new Set();
  let count = 0;
  walkBp(bp, (n, path, depth) => {
    count += 1;
    if (depth > MAX_DEPTH) push(path, 'too_deep', `蓝图嵌套超过 ${MAX_DEPTH} 层`);
    if (typeof n.uid !== 'string' || n.uid === '') push(path, 'bad_uid', '节点缺 uid');
    else if (seen.has(n.uid)) push(path, 'dup_uid', `节点 uid 重复: ${n.uid}`);
    else seen.add(n.uid);
    const cat = NODE_BY_ID[n.node];
    if (!cat) {
      push(path, 'unknown_node', `未知积木节点 ${JSON.stringify(n.node)}`);
      return;
    }
    const ins = Array.isArray(n.inputs) ? n.inputs : [];
    const spec = cat.inputs || { min: 0, max: 0 };
    if (ins.length < spec.min) push(path, 'too_few_inputs', `${cat.name} 至少需要 ${spec.min} 个子节点（当前 ${ins.length}）`);
    if (spec.max >= 0 && ins.length > spec.max) push(path, 'too_many_inputs', `${cat.name} 最多 ${spec.max} 个子节点（当前 ${ins.length}）`);
    ins.forEach((child, i) => {
      const want = (spec.kinds && (spec.kinds[i] !== undefined ? spec.kinds[i] : spec.kinds[spec.kinds.length - 1])) || null;
      if (!want || !child || typeof child !== 'object') return;
      const ccat = NODE_BY_ID[child.node];
      if (ccat && ccat.kind !== want) {
        push(`${path}.inputs[${i}]`, 'bad_input_kind',
          `${cat.name} 的第 ${i + 1} 个位置需要「${want === 'stmt' ? '语句' : want === 'bool' ? '条件' : '数值'}」类节点，实得「${ccat.name}」`);
      }
    });
    for (const p of (cat.params || [])) {
      const v = paramOf(cat, n, p.key);
      if (v === undefined || v === null || v === '') {
        if (p.default === '') push(path, 'bad_param', `${cat.name} 的参数「${p.label}」未选择`);
        continue;
      }
      if (p.type === 'int') {
        if (!Number.isInteger(v) || v < p.min || v > p.max) push(path, 'bad_param', `${cat.name} 的参数「${p.label}」需为 ${p.min}~${p.max} 的整数`);
      } else if (p.type === 'num') {
        if (typeof v !== 'number' || !Number.isFinite(v) || v < p.min || v > p.max) push(path, 'bad_param', `${cat.name} 的参数「${p.label}」需为 ${p.min}~${p.max} 的数值`);
      } else if (p.type === 'pct') {
        if (!Number.isFinite(v) || v < p.min || v > p.max) push(path, 'bad_param', `${cat.name} 的参数「${p.label}」需为 ${p.min}~${p.max}`);
      } else if (p.type === 'slot') {
        if (!(p.values || []).includes(v)) push(path, 'bad_param', `${cat.name} 的参数「${p.label}」非法`);
      } else if (p.type === 'enum') {
        if (!(p.values || []).includes(v)) push(path, 'bad_param', `${cat.name} 的参数「${p.label}」非法`);
      }
    }
    if (cat.compile === 'gap_between') {
      const x = paramOf(cat, n, 'x');
      const y = paramOf(cat, n, 'y');
      if (Number.isInteger(x) && Number.isInteger(y) && x > y) push(path, 'bad_param', '『距离在X~Y格』要求 X ≤ Y');
    }
  });
  if (count > MAX_SLOTS) push('body', 'too_many_nodes', `蓝图节点数 ${count} 超过上限 ${MAX_SLOTS}`);
  return { ok: errors.length === 0, errors, count };
}

function collectRefs(bp) {
  const memories = new Set();
  const subs = new Set();
  walkBp(bp, (n) => {
    if (n.node === 'm_remember' || n.node === 'm_counter' || n.node === 'm_timer') memories.add(n.uid);
    if (n.node === 'r_sub') subs.add(n.uid);
  });
  return { memories, subs };
}

/* ================= 4. 编译规则 ================= */
/* ctx：uid、child(i)（编译子节点）、param(key)、err(code, message) */
const RULES = {
  seq(n, ctx) { return seq(flat((n.inputs || []).map((c, i) => ctx.child(i)))); },

  if(n, ctx) {
    const ins = n.inputs || [];
    const cond = ctx.child(0);
    const thenFrag = branchOf([ctx.child(1)]);
    const elseFrag = ins.length > 2 ? branchOf([ctx.child(2)]) : seq([wait()]);
    return ifn(cond, thenFrag, elseFrag);
  },

  action(n) { return act(NODE_BY_ID[n.node].action); },
  action_skill(n, ctx) { return act(`skill:skill${ctx.param('slot')}`); },
  loop_count(n, ctx) { return loopCount(ctx.param('n'), branchOf([ctx.child(0)])); },
  loop_until(n, ctx) { return loopWhile(invert(ctx.child(0), ctx), branchOf([ctx.child(1)])); },
  loop_forever(n, ctx) { return loopWhile(lit(true), branchOf([ctx.child(0)])); },
  break() { return { type: 'break' }; },

  /* ---- 取值 ---- */
  get(n) { return get(NODE_BY_ID[n.node].path); },
  number(n, ctx) { return lit(Number(ctx.param('value'))); },
  pct(n) { const r = NODE_BY_ID[n.node].ref; return pctOf(r.num, r.den); },
  arith_paths(n) { const r = NODE_BY_ID[n.node].ref; return arith(r.op, get(r.left), get(r.right)); },
  slot_path(n, ctx) {
    const cat = NODE_BY_ID[n.node];
    return get(String(cat.pathTemplate).replace('{slot}', String(ctx.param('slot'))));
  },
  base_pct(n, ctx) { return pctOf(`bases.${ctx.param('side')}.hp`, `bases.${ctx.param('side')}.maxHp`); },
  skill_field(n, ctx) {
    const cat = NODE_BY_ID[n.node];
    return get(`self.skills[${Number(ctx.param('slot')) - 1}].${cat.field}`);
  },
  effect_field(n, ctx) {
    const cat = NODE_BY_ID[n.node];
    return get(`${cat.on}.effects[${ctx.param('index')}].${cat.field}`);
  },
  mem_read(n, ctx) {
    const target = ctx.param('target');
    if (!ctx.refs.memories.has(target)) {
      ctx.err('bad_ref', `『读取记忆』指向的节点不存在或不是记忆节点（${target || '未选择'}）`);
      return lit(0);
    }
    return getVar(memName(target));
  },
  arith(n, ctx) {
    const op = ctx.param('op');
    const l = ctx.child(0);
    const r = ctx.child(1);
    if (op === '/' && r && r.type === 'literal' && r.value === 0) ctx.err('div_zero', '『计算』的除法右边不能是 0');
    return arith(op, l, r);
  },

  /* ---- 条件 ---- */
  gap_cmp(n, ctx) { return cmp(NODE_BY_ID[n.node].op, GAP(), lit(ctx.param('x'))); },
  gap_between(n, ctx) { return logic('and', cmp('>=', GAP(), lit(ctx.param('x'))), cmp('<=', GAP(), lit(ctx.param('y')))); },
  pct_below(n, ctx) {
    const cat = NODE_BY_ID[n.node];
    return cmp('<', pctOf(cat.ref.num, cat.ref.den), lit(ctx.param('x') / 100)); // cl:100（百分数换算，非战斗数值）
  },
  slot_ready(n, ctx) { return cmp('==', get(`self.cooldowns.skill${ctx.param('slot')}`), lit(0)); },
  tick_after(n, ctx) { return cmp('>', get('tick'), lit(ctx.param('x'))); },
  random(n, ctx) { return randExpr(ctx.param('x') / 100); }, // cl:100（百分数换算，非战斗数值）
  logic(n, ctx) { return logic(NODE_BY_ID[n.node].op, ctx.child(0), ctx.child(1)); },
  not(n, ctx) { return invert(ctx.child(0), ctx); },
  compare(n, ctx) { return cmp(ctx.param('op'), ctx.child(0), ctx.child(1)); },
  effect_any(n) {
    const cat = NODE_BY_ID[n.node];
    const parts = [];
    for (let i = 0; i < EFFECT_SCAN_SLOTS; i += 1) {
      const p = `${cat.on}.effects[${i}].${cat.field}`;
      // equals === null = "存在性"判定：用 remaining > 0（缺省 undefined > 0 → false）。
      //   不用 `!= null`：AST 的 literal 不接受 null 值（FIELD_CHECKS 把 null 当"缺字段"）。
      parts.push(cat.equals === null ? cmp('>', get(`${cat.on}.effects[${i}].remaining`), lit(0)) : cmp('==', get(p), lit(cat.equals)));
    }
    let acc = parts[0];
    for (let i = 1; i < parts.length; i += 1) acc = logic('or', acc, parts[i]);
    return acc;
  },
  any_skill_ready() {
    const parts = [];
    for (let s = 1; s <= SKILL_SLOTS; s += 1) parts.push(cmp('==', get(`self.cooldowns.skill${s}`), lit(0)));
    let acc = parts[0];
    for (let i = 1; i < parts.length; i += 1) acc = logic('or', acc, parts[i]);
    return acc;
  },

  /* ---- 记忆（set 未声明 → 写入跨帧持久的根作用域） ---- */
  mem_remember(n, ctx) { return setVar(memName(n.uid), ctx.child(0)); },
  mem_counter(n) { return setVar(memName(n.uid), arith('+', getVar(memName(n.uid)), lit(1))); },
  mem_timer(n, ctx) {
    // 周期恰好 N 帧：计数从 0 起、判定阈值取 N−1（N=1 → 每帧执行）
    const k = Math.max(0, Number(ctx.param('n')) - 1);
    const cond = cmp('>=', getVar(memName(n.uid)), lit(k));
    const body = flat([ctx.child(0)]);
    const fireFrag = branchOf([setVar(memName(n.uid), lit(0))].concat(body));
    const tickFrag = branchOf([setVar(memName(n.uid), arith('+', getVar(memName(n.uid)), lit(1))), wait()]);
    return ifn(cond, fireFrag, tickFrag);
  },

  /* ---- 结构 ---- */
  sub_def(n, ctx) { return { type: 'function', name: subName(n.uid), body: branchOf([ctx.child(0)]) }; },
  sub_call(n, ctx) {
    const target = ctx.param('target');
    if (!ctx.refs.subs.has(target)) {
      ctx.err('bad_ref', `『调用子程序』指向的节点不存在或不是子程序（${target || '未选择'}）`);
      return seq([wait()]);
    }
    return { type: 'call', name: subName(target) };
  },
};

/* 取反（德摩根）：只对"可结构取反"的布尔表达式成立，其余报错 */
function invert(node, ctx) {
  if (!node || typeof node !== 'object') {
    ctx.err('not_invertible', '『非』只能作用于条件类节点');
    return lit(false);
  }
  if (node.type === 'cmp') return cmp(NOT_OP[node.op] || node.op, node.left, node.right);
  if (node.type === 'logic') return logic(node.op === 'and' ? 'or' : 'and', invert(node.left, ctx), invert(node.right, ctx));
  if (node.type === 'random') return { type: 'random', prob: arith('-', lit(1), node.prob) };
  if (node.type === 'literal') return lit(!node.value);
  ctx.err('not_invertible', '『非』只能作用于条件类节点（比较/且或/随机）');
  return lit(false);
}

/* ================= 5. traceMap（后置扫描）+ 标签剥离 ================= */
// 与 runtime 的路径口径逐字一致：body / .s[i] / .then / .else / .body
function buildTraceMap(program) {
  const map = {};
  const visit = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (node[TAG] !== undefined) map[path] = node[TAG];
    if (node.type === 'seq') (node.statements || []).forEach((c, i) => visit(c, `${path}.s[${i}]`));
    else if (node.type === 'if') { visit(node.cond, `${path}.cond`); visit(node.then, `${path}.then`); visit(node.else, `${path}.else`); }
    else if (node.type === 'random') { visit(node.prob, `${path}.prob`); visit(node.then, `${path}.then`); visit(node.else, `${path}.else`); }
    else if (node.type === 'loop') visit(node.body, `${path}.body`);
    else if (node.type === 'function') visit(node.body, `${path}.body`);
  };
  visit(program.body, 'body');
  return map;
}

function stripTags(node) {
  if (!node || typeof node !== 'object') return;
  if (node[TAG] !== undefined) delete node[TAG];
  if (Array.isArray(node)) { node.forEach(stripTags); return; }
  for (const k of Object.keys(node)) stripTags(node[k]);
}

/* ================= 6. 主入口 ================= */
function compileBlueprint(bp) {
  const shape = validateShape(bp);
  if (!shape.ok) return { ok: false, errors: shape.errors, program: null, traceMap: {}, stats: null, slotCount: shape.count || 0 };

  const ctx = makeCtx(bp);
  ctx.refs = collectRefs(bp);

  const compileAt = (n) => {
    const cat = NODE_BY_ID[n.node];
    const rule = RULES[cat.compile];
    const local = Object.create(ctx);
    local.uid = n.uid;
    local.param = (key) => paramOf(cat, n, key);
    local.child = (i) => compileAt((n.inputs || [])[i]);
    local.err = (code, message) => ctx.errors.push({ path: n.uid, code, message });
    if (!rule) {
      ctx.errors.push({ path: n.uid, code: 'no_rule', message: `节点 ${cat.id} 缺编译规则 ${cat.compile}` });
      return seq([wait()]);
    }
    const frag = rule(n, local);
    if (cat.kind === 'stmt' && frag && typeof frag === 'object' && !Array.isArray(frag)) frag[TAG] = n.uid;
    return frag;
  };

  const bodyList = [];
  // 记忆声明块（见文件头事实③）：放进执行 0 次的循环体，只为满足静态 var 检查
  const memDecls = [...ctx.refs.memories].sort().map((uid) => ({ type: 'var', name: memName(uid), value: lit(0) }));
  if (memDecls.length > 0) bodyList.push(loopCount(0, branchOf(memDecls)));
  (bp.body || []).forEach((n) => bodyList.push(compileAt(n)));
  const stmts = flat(bodyList);
  const program = { type: 'program', version: ast.CURRENT_VERSION, body: seq(hasAction(stmts) ? stmts : stmts.concat([wait()])) };

  if (ctx.errors.length > 0) {
    return { ok: false, errors: ctx.errors, program: null, traceMap: {}, stats: null, slotCount: shape.count };
  }

  const traceMap = buildTraceMap(program);
  stripTags(program);

  // 最终闸门：编译产物必须过 AST 校验（结构/限额/白名单/分支动作规则）
  const check = ast.validate(program);
  if (!check.ok) {
    return {
      ok: false, program: null, traceMap: {}, slotCount: shape.count, stats: null,
      errors: check.errors.map((e) => ({ path: e.path, code: `ast_${e.code}`, message: `编译结果未通过程序校验：${e.message}` })),
    };
  }
  return { ok: true, errors: [], program, traceMap, slotCount: shape.count, stats: statsOf(bp) };
}

/* 蓝图统计：槽位数 / 各品质用量 / 每种节点用量（供占用校验与前端显示） */
function statsOf(bp) {
  const byQuality = {};
  const byNode = {};
  let slots = 0;
  walkBp(bp, (n) => {
    const cat = NODE_BY_ID[n.node];
    if (!cat) return;
    slots += 1;
    byQuality[cat.quality] = (byQuality[cat.quality] || 0) + 1;
    byNode[cat.id] = (byNode[cat.id] || 0) + 1;
  });
  return { slots, byQuality, byNode };
}

module.exports = {
  compileBlueprint,
  validateBlueprint: (bp) => {
    const r = compileBlueprint(bp);
    return { ok: r.ok, errors: r.errors, slotCount: r.slotCount };
  },
  statsOf,
  nodeById: (id) => NODE_BY_ID[id] || null,
  catalog: () => CATALOG.nodes,
  // D-178：预设蓝图模板（数据即内容；只用绿档节点，任何新账号都能直接套用）——返回深拷贝，调用方改了不污染数据表
  presets: () => PRESET_DATA.presets.map((p) => ({
    id: p.id, name: p.name, desc: p.desc, blueprint: JSON.parse(JSON.stringify(p.blueprint)),
  })),
  limits: { maxSlots: MAX_SLOTS, maxDepth: MAX_DEPTH, blueprintVersion: BLUEPRINT_VERSION, effectScanSlots: EFFECT_SCAN_SLOTS },
};
