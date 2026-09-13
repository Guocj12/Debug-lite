// editor/bridge.js —— Blockly 积木 JSON ↔ 后端 AI 程序 AST（frontend-spec §6.2；纯函数，无 Blockly 依赖；F6）
// ★F6 审查重写（P1 根因）：原实现为自创 11 型"编辑器方言"（num/get/loop_forever/{type:'seq'}），与后端契约
// （docs/interfaces.md §1、server/ai/ast.js 白名单 16 节点、D-100..103）形状/类型/字段全不符 → ai/edit｜ai/compile
// ｜ai/run 三链恒被后端拒绝（not_program）——本版改为直接产出/消费**后端程序形状**：
//   程序：{type:'program', version, body:{type:'seq', statements:[...]}}（D-100 隐式主循环）
//   节点：var{name,value} set{name,value} if{cond,then,else} loop{kind,times?,cond?,body} random{prob,then,else}
//         action/break/function{name,body}/call{name} + 表达式 literal/get{path}/getVar{name}/bullets/
//         arith|cmp|logic{op,left,right}——块词汇表 18 型（batch 契约 11 型 + 补齐 7 型漏项：break/function/call/
//         bullets/loop_count/getVar 双语义）：门控差集核对见 views/editor.js buildToolbox。
// 积木 JSON 形状：{id, type, fields:{}, inputs:{KEY:{block:child}}, next:{block:next}|null}。
// 分支容器（if.then/else、random.then/else、loop/function.body）经 then0/else0/body0 挂"链"（首个块 + next 链）：
//   单语句 seq 的往返保真由 fields._seq 标记承担（F6 审查：pDeepRec else=seq[单 action] 不丢包装）。
// findBlockByPath：后端错误路径（body.s[i].then/.else/.body/.expr）→ 积木 id；与 ast.js getNodeAtPath 同语义
//   （.expr 在 value/left/right/cond/prob/times 中取首个对象——多表达式字段共享 .expr 段为后端既有登记缺陷，
//   前端同口径）。a/b/cond/expr/init 段（batch 契约残片）由统一 AST 映射覆盖（见 F6.md 登记）。

export const AST_VERSION = 2; // 与 server/ai/ast.js CURRENT_VERSION 对齐（桥输出程序版本；载入 v1 由后端迁移）

export const STMT_TYPES = {
  var: 'var', set: 'set', if: 'if',
  loop_forever: 'loop', loop_count: 'loop',
  random: 'random', action: 'action', break: 'break',
  function: 'function', call: 'call',
};
export const EXPR_TYPES = {
  num: 'literal', get: 'get|getVar', bullets: 'bullets',
  arith: 'arith', cmp: 'cmp', logic: 'logic',
};

let uidSeq = 0;
function newId() {
  uidSeq += 1;
  return `blk_${uidSeq}`;
}

function inKey(b, k) {
  return b && b.inputs && b.inputs[k] && b.inputs[k].block ? b.inputs[k].block : null;
}

// ---------- AST → 积木 JSON ----------

function chainOf(list) {
  let root = null;
  let prev = null;
  for (const s of list || []) {
    const blk = stmtToBlock(s);
    if (!blk) continue;
    if (!root) root = blk;
    if (prev) prev.next = { block: blk };
    prev = blk;
  }
  return root;
}

// 分支/函数体节点 → 块（seq 解链；首块打 _seq 标记保真；非 seq → 单块）
function nodeToBodyBlock(node) {
  if (!node || typeof node !== 'object') return null;
  const stmts = node.type === 'seq' ? node.statements || [] : [node];
  const head = chainOf(stmts);
  if (head && node.type === 'seq') head.fields = { ...(head.fields || {}), _seq: 1 };
  return head;
}

function stmtToBlock(s) {
  if (!s || !s.type) return null;
  const id = newId();
  switch (s.type) {
    case 'var':
      return { id, type: 'var', fields: { name: s.name || '' }, inputs: { init: s.value ? { block: exprToBlock(s.value) } : null }, next: null };
    case 'set':
      return { id, type: 'set', fields: { name: s.name || '' }, inputs: { expr: s.value ? { block: exprToBlock(s.value) } : null }, next: null };
    case 'if':
      return {
        id, type: 'if', fields: {},
        inputs: {
          cond: s.cond ? { block: exprToBlock(s.cond) } : null,
          then0: s.then ? { block: nodeToBodyBlock(s.then) } : null,
          else0: s.else ? { block: nodeToBodyBlock(s.else) } : null,
        },
        next: null,
      };
    case 'loop': {
      if (s.kind === 'count') {
        return { id, type: 'loop_count', fields: {}, inputs: { times: s.times ? { block: exprToBlock(s.times) } : null, body0: s.body ? { block: nodeToBodyBlock(s.body) } : null }, next: null };
      }
      // while：cond=literal true 时省略 cond 输入（无限循环语义）；其余 cond 保留
      const isTrue = s.cond && s.cond.type === 'literal' && s.cond.value === true;
      const blk = { id, type: 'loop_forever', fields: {}, inputs: { body0: s.body ? { block: nodeToBodyBlock(s.body) } : null }, next: null };
      if (!isTrue && s.cond) blk.inputs.cond = { block: exprToBlock(s.cond) };
      return blk;
    }
    case 'random':
      return {
        id, type: 'random', fields: {},
        inputs: {
          prob: s.prob ? { block: exprToBlock(s.prob) } : null,
          then0: s.then ? { block: nodeToBodyBlock(s.then) } : null,
          else0: s.else ? { block: nodeToBodyBlock(s.else) } : null,
        },
        next: null,
      };
    case 'action':
      return { id, type: 'action', fields: { name: s.name || '' }, inputs: {}, next: null };
    case 'break':
      return { id, type: 'break', fields: {}, inputs: {}, next: null };
    case 'function':
      return { id, type: 'function', fields: { name: s.name || '' }, inputs: { body0: s.body ? { block: nodeToBodyBlock(s.body) } : null }, next: null };
    case 'call':
      return { id, type: 'call', fields: { name: s.name || '' }, inputs: {}, next: null };
    // 表达式语句（后端 runtime「无状态语句」：语句位直接放表达式节点——coverageProgram fixture 实拍）
    case 'literal':
    case 'get':
    case 'getVar':
    case 'bullets':
    case 'arith':
    case 'cmp':
    case 'logic':
      return exprToBlock(s);
    default:
      return null;
  }
}

function exprToBlock(e) {
  if (!e || !e.type) return null;
  const id = newId();
  switch (e.type) {
    case 'literal':
      return { id, type: 'num', fields: { value: e.value }, inputs: {}, next: null };
    case 'get':
      return { id, type: 'get', fields: { path: e.path }, inputs: {}, next: null };
    case 'getVar':
      return { id, type: 'get', fields: { name: e.name || '' }, inputs: {}, next: null };
    case 'bullets':
      return { id, type: 'bullets', fields: {}, inputs: {}, next: null };
    case 'arith':
      return { id, type: 'arith', fields: { op: e.op }, inputs: { a: e.left ? { block: exprToBlock(e.left) } : null, b: e.right ? { block: exprToBlock(e.right) } : null }, next: null };
    case 'cmp':
      return { id, type: 'cmp', fields: { op: e.op }, inputs: { a: e.left ? { block: exprToBlock(e.left) } : null, b: e.right ? { block: exprToBlock(e.right) } : null }, next: null };
    case 'logic':
      return { id, type: 'logic', fields: { op: e.op }, inputs: { a: e.left ? { block: exprToBlock(e.left) } : null, b: e.right ? { block: exprToBlock(e.right) } : null }, next: null };
    default:
      return null;
  }
}

// 程序 → 积木（根 = D-100 显式可见的 loop_forever 隐式主循环；空/畸形安全）
export function toBlocks(program) {
  if (!program || typeof program !== 'object') return null;
  const body = program.body && program.body.type === 'seq' ? program.body : program.body || {};
  const stmts = Array.isArray(body.statements) ? body.statements : Array.isArray(program.statements) ? program.statements : [];
  const inner = chainOf(stmts);
  return { id: newId(), type: 'loop_forever', fields: {}, inputs: { body0: inner ? { block: inner } : null }, next: null };
}

// ---------- 积木 JSON → AST（后端程序形状） ----------

function convertRoot(root) {
  // 返回 {statements, map}；map: AST 节点对象 → 积木 id（高亮路径反查；seq 包装节点指向链首块）
  const map = new Map();
  const inner = root && root.type === 'loop_forever' ? inKey(root, 'body0') : root;
  const statements = [];
  let cur = inner;
  while (cur) {
    const s = blockToStmt(cur, map);
    if (s) statements.push(s);
    cur = cur.next ? cur.next.block : null;
  }
  return { statements, map };
}

function bodyNodeFromBlock(head, map) {
  if (!head) return null;
  const chain = [];
  let cur = head;
  while (cur) {
    const s = blockToStmt(cur, map);
    if (s) chain.push(s);
    cur = cur.next ? cur.next.block : null;
  }
  if (head.fields && head.fields._seq) {
    const node = { type: 'seq', statements: chain };
    map.set(node, head.id);
    return node;
  }
  if (chain.length === 1) return chain[0];
  if (chain.length > 1) {
    // 防御：无 _seq 标记的多块链（手写畸形积木）→ 按 seq 包装
    const node = { type: 'seq', statements: chain };
    map.set(node, head.id);
    return node;
  }
  return null;
}

function blockToStmt(b, map) {
  if (!b || !b.type) return null;
  const f = b.fields || {};
  let node = null;
  switch (b.type) {
    case 'var':
      node = { type: 'var', name: f.name || '', value: exprFromBlock(inKey(b, 'init'), map) };
      break;
    case 'set':
      node = { type: 'set', name: f.name || '', value: exprFromBlock(inKey(b, 'expr'), map) };
      break;
    case 'if':
      node = { type: 'if', cond: exprFromBlock(inKey(b, 'cond'), map), then: bodyNodeFromBlock(inKey(b, 'then0'), map), else: bodyNodeFromBlock(inKey(b, 'else0'), map) };
      break;
    case 'loop_forever': {
      const condBlk = inKey(b, 'cond');
      const litTrue = { type: 'literal', value: true };
      if (condBlk) {
        node = { type: 'loop', kind: 'while', cond: exprFromBlock(condBlk, map), body: bodyNodeFromBlock(inKey(b, 'body0'), map) };
      } else {
        node = { type: 'loop', kind: 'while', cond: litTrue, body: bodyNodeFromBlock(inKey(b, 'body0'), map) };
        if (map) map.set(litTrue, b.id); // 合成 cond（块上无对应 num 输入）→ 指向循环块本身（高亮路径 .expr 命中）
      }
      break;
    }
    case 'loop_count':
      node = { type: 'loop', kind: 'count', times: exprFromBlock(inKey(b, 'times'), map), body: bodyNodeFromBlock(inKey(b, 'body0'), map) };
      break;
    case 'random':
      node = { type: 'random', prob: exprFromBlock(inKey(b, 'prob'), map), then: bodyNodeFromBlock(inKey(b, 'then0'), map), else: bodyNodeFromBlock(inKey(b, 'else0'), map) };
      break;
    case 'action':
      node = { type: 'action', name: f.name || '' };
      break;
    case 'break':
      node = { type: 'break' };
      break;
    case 'function':
      node = { type: 'function', name: f.name || '', body: bodyNodeFromBlock(inKey(b, 'body0'), map) };
      break;
    case 'call':
      node = { type: 'call', name: f.name || '' };
      break;
    // 表达式语句（后端「无状态语句」同型）
    case 'num':
    case 'get':
    case 'bullets':
    case 'arith':
    case 'cmp':
    case 'logic':
      return exprFromBlock(b, map);
    default:
      return null;
  }
  if (map) map.set(node, b.id);
  return node;
}

function exprFromBlock(b, map) {
  if (!b || !b.type) return null;
  const f = b.fields || {};
  const mk = (node) => { if (map) map.set(node, b.id); return node; };
  switch (b.type) {
    case 'num': return mk({ type: 'literal', value: f.value === undefined ? 0 : f.value });
    case 'get': return mk(f.path !== undefined ? { type: 'get', path: f.path } : { type: 'getVar', name: f.name || '' });
    case 'bullets': return mk({ type: 'bullets' });
    case 'arith': return mk({ type: 'arith', op: f.op, left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) });
    case 'cmp': return mk({ type: 'cmp', op: f.op, left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) });
    case 'logic': return mk({ type: 'logic', op: f.op, left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) });
    default: return null;
  }
}

// 积木（根）→ 后端程序；根为 loop_forever 时按 D-100 解包为隐式主循环体
export function toAst(root) {
  const { statements } = convertRoot(root);
  return { type: 'program', version: AST_VERSION, body: { type: 'seq', statements } };
}

// 错误路径 → 积木 id（供高亮；找不到 → null）。路径形态 = 后端 ast.js details.path（'body.s[i].then/.else/.body/.expr'）
export function findBlockByPath(root, path) {
  if (!root || typeof path !== 'string' || path.length === 0) return null;
  const { statements, map } = convertRoot(root);
  const program = { type: 'program', body: { type: 'seq', statements } };
  map.set(program.body, root.id);
  const parts = path.split('.');
  if (parts[0] !== 'body') return null;
  let node = program.body;
  for (let i = 1; i < parts.length && node; i++) {
    const t = parts[i];
    const m = /^s\[(\d+)\]$/.exec(t);
    if (m) {
      node = node && Array.isArray(node.statements) ? node.statements[Number(m[1])] : null;
    } else if (t === 'expr') {
      // 与后端 getNodeAtPath 同口径：多表达式字段共享 .expr 段（取首个对象）
      let n = null;
      for (const k of ['value', 'left', 'right', 'cond', 'prob', 'times']) {
        const v = node && node[k];
        if (v && typeof v === 'object') { n = v; break; }
      }
      node = n;
    } else if (t === 'then' || t === 'else' || t === 'body') {
      const child = node ? node[t] || null : null;
      if (!child) {
        // 空分支段（如 loop 内 if 缺 else → details.path '...else'）：高亮容器块本身（语义容器才回退；
        // 非容器节点（var 等）的 .body 段为非法路径 → 仍 miss）
        const SEM = ['if', 'random', 'loop', 'function'];
        return SEM.includes(node && node.type) ? (map.get(node) || null) : null;
      }
      node = child;
    } else {
      return null;
    }
  }
  const id = node ? map.get(node) : null;
  return id || null;
}