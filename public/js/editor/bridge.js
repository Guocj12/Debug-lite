'use strict';
/* editor/bridge.js —— 积木 JSON ↔ 后端 AI 程序（契约直译，frontend-spec §6.2/F6 根因原则）。
 * 程序形状冻结（interfaces §1/D-100..103）：{type:'program', version, body:{type:'seq', statements:[...]}}；
 * 节点白名单 16 型（server/ai/ast.js）：literal get getVar bullets var set arith cmp logic random if loop break function call action。
 * 积木词汇 16 块型：var/set/if/loop_forever/loop_count/random/action/break/function/call/num/get/bullets/arith/cmp/logic。
 * 积木 JSON：{id, type, fields:{}, inputs:{KEY:{block:child}|null}, next:{block}|null}；分支容器经 then0/else0/body0 挂链。
 */
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

let seq = 0;
const newId = () => `blk_${++seq}`;

// ===== 语句/表达式 → 积木 =====

function chainOf(nodes) {
  const list = (nodes || []).filter(Boolean);
  let head = null;
  let tail = null;
  for (const n of list) {
    const blk = stmtToBlock(n);
    if (!blk) continue;
    if (!head) { head = blk; tail = blk; continue; }
    tail.next = { block: blk };
    tail = blk;
  }
  return head;
}

// 单语句 seq 的包装保真（fields._seq，F6 P1 语义；多语句 seq 无需标记）
function nodeToBodyBlock(node) {
  if (!node || typeof node !== 'object') return null;
  const stmts = node.type === 'seq' ? node.statements || [] : [node];
  const head = chainOf(stmts);
  if (head && node.type === 'seq' && stmts.length === 1) head.fields = { ...(head.fields || {}), _seq: 1 };
  return head;
}

function exprToBlock(e) {
  if (!e || !e.type) return null;
  const id = newId();
  switch (e.type) {
    case 'literal':
      return { id, type: 'num', fields: { value: e.value }, inputs: {}, next: null };
    case 'get':
      return { id, type: 'get', fields: { path: e.path || '' }, inputs: {}, next: null };
    case 'getVar':
      return { id, type: 'get', fields: { name: e.name || '' }, inputs: {}, next: null };
    case 'bullets':
      return { id, type: 'bullets', fields: {}, inputs: {}, next: null };
    case 'arith':
      return { id, type: 'arith', fields: { op: e.op || '+' }, inputs: { a: e.left ? { block: exprToBlock(e.left) } : null, b: e.right ? { block: exprToBlock(e.right) } : null }, next: null };
    case 'cmp':
      return { id, type: 'cmp', fields: { op: e.op || '==' }, inputs: { a: e.left ? { block: exprToBlock(e.left) } : null, b: e.right ? { block: exprToBlock(e.right) } : null }, next: null };
    case 'logic':
      return { id, type: 'logic', fields: { op: e.op || 'and' }, inputs: { a: e.left ? { block: exprToBlock(e.left) } : null, b: e.right ? { block: exprToBlock(e.right) } : null }, next: null };
    default:
      return null;
  }
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
        }, next: null,
      };
    case 'loop': {
      if (s.kind === 'count') {
        return { id, type: 'loop_count', fields: {}, inputs: { times: s.times ? { block: exprToBlock(s.times) } : null, body0: s.body ? { block: nodeToBodyBlock(s.body) } : null }, next: null };
      }
      // forever：cond=literal true 省略 cond 输入（无限循环语义）
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
        }, next: null,
      };
    case 'action':
      return { id, type: 'action', fields: { name: s.name || '' }, inputs: {}, next: null };
    case 'break':
      return { id, type: 'break', fields: {}, inputs: {}, next: null };
    case 'function':
      return { id, type: 'function', fields: { name: s.name || '' }, inputs: { body0: s.body ? { block: nodeToBodyBlock(s.body) } : null }, next: null };
    case 'call':
      return { id, type: 'call', fields: { name: s.name || '' }, inputs: {}, next: null };
    // 表达式语句（runtime 无状态语句：语句位直接放表达式节点——coverageProgram 实拍）
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

// 程序 → 积木（根 loop_forever 预置体；非法 → null）
export function toBlocks(program) {
  if (!program || typeof program !== 'object') return null;
  const body = program.body && program.body.type === 'seq' ? program.body : program.body || {};
  const stmts = Array.isArray(body.statements) ? body.statements : Array.isArray(program.statements) ? program.statements : [];
  const inner = chainOf(stmts);
  return { id: newId(), type: 'loop_forever', fields: {}, inputs: { body0: inner ? { block: inner } : null }, next: null };
}

// ===== 积木 → 程序 =====

// 输入键读取（inputs 挂子块；next 兼容顶层属性与输入两种挂法）
function inKey(b, key) {
  if (!b) return null;
  const viaInputs = (b.inputs || {})[key];
  if (viaInputs && viaInputs.block) return viaInputs.block;
  const top = b[key];
  return top && top.block ? top.block : null;
}

// 分支容器 → 单语句 seq 保真（_seq 标记）
function bodyToNode(b, map) {
  if (!b) return null;
  const chain = [];
  let cur = b;
  while (cur) {
    const node = blockToNode(cur, map);
    if (node !== null) chain.push(node);
    cur = inKey(cur, 'next');
  }
  if (chain.length === 0) return null;
  if (chain.length === 1 && !(b.fields && b.fields._seq)) return chain[0];
  const node = { type: 'seq', statements: chain };
  map.set(node, b.id);
  return node;
}

function exprFromBlock(b, map) {
  if (!b || !b.type) return null;
  const f = b.fields || {};
  switch (b.type) {
    case 'num': return { type: 'literal', value: f.value };
    case 'get': return f.name !== undefined && f.name !== '' ? { type: 'getVar', name: f.name } : { type: 'get', path: f.path || 'self' };
    case 'bullets': return { type: 'bullets' };
    case 'arith': return { type: 'arith', op: f.op || '+', left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) };
    case 'cmp': return { type: 'cmp', op: f.op || '==', left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) };
    case 'logic': return { type: 'logic', op: f.op || 'and', left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) };
    default: return null;
  }
}

function blockToNode(b, map) {
  if (!b || !b.type) return null;
  const f = b.fields || {};
  let node = null;
  switch (b.type) {
    case 'var': node = { type: 'var', name: f.name || '', value: exprFromBlock(inKey(b, 'init'), map) }; break;
    case 'set': node = { type: 'set', name: f.name || '', value: exprFromBlock(inKey(b, 'expr'), map) }; break;
    case 'if':
      node = {
        type: 'if',
        cond: exprFromBlock(inKey(b, 'cond'), map),
        then: bodyToNode(inKey(b, 'then0'), map),
        else: bodyToNode(inKey(b, 'else0'), map),
      };
      if (!node.cond) node.cond = { type: 'literal', value: false };
      break;
    case 'loop_count':
      node = { type: 'loop', kind: 'count', times: exprFromBlock(inKey(b, 'times'), map), body: bodyToNode(inKey(b, 'body0'), map) };
      break;
    case 'loop_forever': {
      // forever 与 while 同构（无限循环语义）；canonical：积木省略 literal-true cond，回读 kind:'while'
      const cond = inKey(b, 'cond');
      node = cond
        ? { type: 'loop', kind: 'while', cond: exprFromBlock(cond, map), body: bodyToNode(inKey(b, 'body0'), map) }
        : { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: bodyToNode(inKey(b, 'body0'), map) };
      break;
    }
    case 'random':
      node = {
        type: 'random',
        prob: exprFromBlock(inKey(b, 'prob'), map) || { type: 'literal', value: 0.5 },
        then: bodyToNode(inKey(b, 'then0'), map),
        else: bodyToNode(inKey(b, 'else0'), map),
      };
      break;
    case 'action': node = { type: 'action', name: f.name || 'wait' }; break;
    case 'break': node = { type: 'break' }; break;
    case 'function': node = { type: 'function', name: f.name || 'fn', body: bodyToNode(inKey(b, 'body0'), map) }; break;
    case 'call': node = { type: 'call', name: f.name || 'fn' }; break;
    case 'num': node = { type: 'literal', value: f.value }; break;
    case 'get': node = f.name !== undefined && f.name !== '' ? { type: 'getVar', name: f.name } : { type: 'get', path: f.path || 'self' }; break;
    case 'bullets': node = { type: 'bullets' }; break;
    case 'arith': node = { type: 'arith', op: f.op || '+', left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) }; break;
    case 'cmp': node = { type: 'cmp', op: f.op || '==', left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) }; break;
    case 'logic': node = { type: 'logic', op: f.op || 'and', left: exprFromBlock(inKey(b, 'a'), map), right: exprFromBlock(inKey(b, 'b'), map) }; break;
    default: return null;
  }
  map.set(node, b.id);
  return node;
}

// 根积木 → 程序（非 loop_forever 根 → 包一层隐式主循环）
export function toAst(rootBlock) {
  if (!rootBlock || !rootBlock.type) return null;
  const map = new Map(); // node → blockId（错误高亮定位）
  const inner = rootBlock.type === 'loop_forever' ? inKey(rootBlock, 'body0') : rootBlock;
  const statements = [];
  let cur = inner;
  while (cur) {
    const node = blockToNode(cur, map);
    if (node !== null) statements.push(node);
    cur = inKey(cur, 'next');
  }
  return { type: 'program', version: 1, body: { type: 'seq', statements }, map };
}

// 按 AST 路径定位积木（错误高亮；路径形态 = 后端 details.path：'body.s[i].then/.else/.body/.expr'）
const SEG_MAP = { then: 'then0', else: 'else0', body: 'body0', left: 'a', right: 'b' };
export function findBlockByPath(rootBlock, path) {
  const parts = splitPath(path || '');
  if (parts.length === 0) return null; // 空路径无定位语义
  let cur = rootBlock && rootBlock.type === 'loop_forever' ? inKey(rootBlock, 'body0') : rootBlock;
  let i = 0;
  while (i < parts.length && parts[i] === 'body') i++; // 开头 body = 隐式主循环（已 unwrap）
  for (; i < parts.length; i++) {
    const part = parts[i];
    if (typeof part === 'number' || /^\d+$/.test(String(part))) {
      const n = Number(part);
      for (let k = 0; k < n && cur; k++) cur = inKey(cur, 'next');
      continue;
    }
    if (part === 's') continue; // statements 标记
    if (!cur) return null;
    const key = SEG_MAP[part] || (part === 'value' ? (cur.type === 'var' ? 'init' : 'expr') : part);
    const child = inKey(cur, key);
    if (!child) return null;
    cur = child;
  }
  return cur || null;
}

function splitPath(path) {
  const out = [];
  for (const seg of String(path).split('.')) {
    if (seg === '') continue;
    const m = seg.match(/^(\w+)\[(\d+)\]$/);
    if (m) { out.push(m[1]); out.push(Number(m[2])); continue; }
    if (/^\d+$/.test(seg)) { out.push(Number(seg)); continue; }
    out.push(seg);
  }
  return out;
}
