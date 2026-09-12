'use strict';
/* server/ai/ast.js —— AI 程序 AST 静态校验（P2 B12，契约 docs/interfaces.md §1）
 * 依据：systems/08-ai.md §3（节点清单）/§4.2①（结构校验：白名单、字段类型、深度≤32、节点≤2000、字节≤256KB、
 *   危险键拒绝）——合法性检测（分支 action 规则）与段位门控属 B13；隐式主循环结构契约（body 必须 seq，D-100）。
 * 纯函数内核（L11）：日志经 withLogger 注入；事件 ai.ast.validate(debug)（§4.6 L5 行）。
 * 路径 id 规范（B12 登记，08-ai A-6h 格式）：seq→s[i]、if→then/else、loop→body、function→body（body 内再 s[i]）；
 *   其余节点为叶子。
 */

const { nullLogger } = require('../../shared/log.js');

// 节点白名单（systems/08-ai.md §3；loop 含 count/while 两种 kind）
const NODE_TYPES = new Set([
  'literal', 'get', 'bullets', 'var', 'set', 'getVar', 'arith', 'cmp', 'logic', 'random',
  'if', 'loop', 'break', 'function', 'call', 'action', 'seq',
]);

// 全局上限（systems §4.2①/§4.3；程序上限常量与战斗数值无关，撞值豁免见 cl:）
const LIMITS = {
  maxDepth: 32, // cl:32
  maxNodes: 2000,
  maxBytes: 256 * 1024, // cl:1024
  stepLimit: 10000,
  traceLimit: 2000,
  recursionLimit: 64, // cl:64
};

// 子节点字段（含其下路径段命名）：seq.statements → s[i]；if.then/else；random.then/else；loop.body；function.body
function childList(node) {
  if (node.type === 'seq') return { key: 'statements', pathName: 's', list: node.statements };
  if (node.type === 'if' || node.type === 'random') {
    return { key: null, pathName: null, list: [node.then, node.else].filter((x) => x && typeof x === 'object') };
  }
  if (node.type === 'loop' || node.type === 'function') return { key: 'body', pathName: 'body', list: [node.body].filter(Boolean) };
  return { key: null, pathName: null, list: [] };
}

// 叶子表达式节点（无子节点结构校验：literal/get/var/set/getVar/arith/cmp/logic/random/action/break/call）
// 表达式字段（值语义，递归校验类型但不算深度路径子节点）
function exprChildren(node) {
  const fields = [];
  for (const k of ['value', 'left', 'right', 'cond', 'prob', 'times']) {
    const v = node[k];
    if (v && typeof v === 'object') fields.push(v);
  }
  return fields;
}

function makeAst(logger) {
  const L = logger || nullLogger;

  // 结构校验（B12）：白名单/字段类型/深度/节点数/字节/危险键/root 契约 → {ok, errors:[{path,code,message}]}
  // 接口名按 interfaces §1 冻结：validateProgram（B13 checkLegality 分离）
  function validateProgram(program) {
    const errors = [];
    const state = { nodes: 0, maxDepthSeen: 0, visited: new Set() };
    if (!program || program.type !== 'program') {
      return { ok: false, errors: [{ path: '', code: 'not_program', message: '根节点必须是 program' }] };
    }
    // 根节点自身也要查危险键（visit 从 body 开始，根不经过）
    for (const k of Object.keys(program)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        errors.push({ path: '', code: 'forbidden_key', message: `危险键 ${k}` });
      }
    }
    if (program.version === undefined || !Number.isInteger(program.version) || program.version < 1) {
      errors.push({ path: '', code: 'bad_version', message: 'version 必须为正整数' });
    }
    const rootBody = program.body;
    if (!rootBody || rootBody.type !== 'seq') {
      errors.push({ path: 'body', code: 'bad_root', message: 'body 必须为 seq（隐式主循环结构契约，D-100）' });
      return { ok: errors.length === 0, errors };
    }
    if (errors.length > 0) return { ok: false, errors };

    // 字节上限（JSON 序列化长度）
    let bytes;
    try {
      bytes = Buffer.byteLength(JSON.stringify(program), 'utf8');
    } catch (e) {
      bytes = 0;
    }
    if (bytes > LIMITS.maxBytes) {
      errors.push({ path: '', code: 'ai_too_large', message: `程序超出 ${LIMITS.maxBytes} 字节` });
    }

    // 深度优先遍历（带路径与深度）；危险键与未知节点在收集时检测
    visit(rootBody, 'body', 1, errors, state);

    if (state.nodes > LIMITS.maxNodes) {
      errors.push({ path: '', code: 'ai_too_large', message: `节点数 ${state.nodes} 超上限 ${LIMITS.maxNodes}` });
    }
    if (state.maxDepthSeen > LIMITS.maxDepth) {
      errors.push({ path: '', code: 'ai_too_deep', message: `深度 ${state.maxDepthSeen} 超上限 ${LIMITS.maxDepth}` });
    }
    const ok = errors.length === 0;
    L.debug('ai.ast', 'ai.validate', `validate ok=${ok}`, { ok, version: program.version, nodes: state.nodes });
    return { ok, errors };
  }

  // 递归遍历（path 记录；返回节点总数用于计数）
  function visit(node, path, depth, errors, state) {
    if (node === null || node === undefined) return;
    if (typeof node !== 'object') {
      errors.push({ path, code: 'bad_field', message: `节点必须是对象（${path}）` });
      return;
    }
    // 自引用/环防御（审查 P2-2；API 输入为 JSON.parse 产物，防御非法宿主注入）
    if (state.visited.has(node)) {
      errors.push({ path, code: 'ai_cycle', message: `节点自引用/环（${path}）` });
      return;
    }
    state.visited.add(node);
    // 危险键（原型污染防，T-AF-8/A-10g）
    for (const k of Object.keys(node)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') {
        errors.push({ path, code: 'forbidden_key', message: `危险键 ${k}` });
      }
    }
    state.nodes += 1;
    if (depth > state.maxDepthSeen) state.maxDepthSeen = depth;
    const type = node.type;
    if (type === undefined || typeof type !== 'string') {
      errors.push({ path, code: 'bad_field', message: '节点缺 type' });
      return;
    }
    if (!NODE_TYPES.has(type)) {
      errors.push({ path, code: 'unknown_node', message: `未知节点类型 ${type}` });
      return;
    }
    // 字段类型检查（按类型）
    const fieldChecks = FIELD_CHECKS[type];
    if (fieldChecks) {
      for (const [field, kind] of fieldChecks) {
        const v = node[field];
        if (v === undefined || v === null) {
          if (kind === 'optional') continue;
          errors.push({ path, code: 'bad_field', message: `${type} 缺必填字段 ${field}` });
          continue;
        }
        if (kind === 'string' && typeof v !== 'string') errors.push({ path, code: 'bad_field', message: `${type}.${field} 应为字符串` });
        if (kind === 'node' && (typeof v !== 'object' || v.type === undefined)) {
          const childPath = `${path}.${field}`;
          errors.push({ path: childPath, code: 'bad_field', message: `${type}.${field} 应为节点` });
        }
        if (kind === 'nodeList' && !Array.isArray(v)) errors.push({ path: `${path}.${field}`, code: 'bad_field', message: `${type}.${field} 应为数组` });
      }
    }
    // 子节点递归（list 非数组时 bad_field 已记，防御空遍历）
    const ch = childList(node);
    const chList = Array.isArray(ch.list) ? ch.list : [];
    if (chList.length) {
      chList.forEach((c, i) => {
        if (ch.pathName === 's') visit(c, `${path}.s[${i}]`, depth + 1, errors, state);
        else if (ch.key === null) {
          // if 的 then/else：按位置给名字（then 先、else 后）
          const name = i === 0 ? 'then' : 'else';
          visit(c, `${path}.${name}`, depth + 1, errors, state);
        } else {
          visit(c, `${path}.${ch.pathName}`, depth + 1, errors, state);
        }
      });
    }
    // 表达式子节点（值语义，仅类型校验，不产生路径段）
    for (const c of exprChildren(node)) {
      visit(c, `${path}.expr`, depth + 1, errors, state);
    }
  }

  // 收集用到的节点类型（去重保序；B13 段位门控与 B16 stats 复用）
  function collectUsedNodeTypes(program) {
    const used = [];
    const seen = new Set();
    (function walk(n) {
      if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
      if (!seen.has(n.type)) {
        seen.add(n.type);
        used.push(n.type);
      }
      const ch = childList(n);
      const chList = Array.isArray(ch.list) ? ch.list : [];
      for (const c of chList) walk(c);
      for (const c of exprChildren(n)) walk(c);
    })(program && program.body);
    return used;
  }

  // 稳定路径 id：node → path 映射（遍历序确定；A-6h 格式 body.s[i].then.body.s[j]）
  function nodePathOf(program) {
    const map = new WeakMap();
    (function walk(n, path) {
      if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
      map.set(n, path);
      const ch = childList(n);
      if (ch.list) {
        ch.list.forEach((c, i) => {
          if (ch.pathName === 's') walk(c, `${path}.s[${i}]`);
          else if (ch.key === null) walk(c, `${path}.${i === 0 ? 'then' : 'else'}`);
          else walk(c, `${path}.${ch.pathName}`);
        });
      }
      for (const c of exprChildren(n)) walk(c, `${path}.expr`);
    })(program && program.body, 'body');
    return map;
  }

  return { validateProgram, collectUsedNodeTypes, nodePathOf, NODE_TYPES, limits: LIMITS };
}

// 字段类型表（B12 登记：结构层面；合法性检测（分支 action 规则）B13）
const FIELD_CHECKS = {
  seq: [['statements', 'nodeList']],
  literal: [['value', 'any']],
  get: [['path', 'string']],
  var: [['name', 'string'], ['value', 'node']],
  set: [['name', 'string'], ['value', 'node']],
  getVar: [['name', 'string']],
  arith: [['op', 'string'], ['left', 'node'], ['right', 'node']],
  cmp: [['op', 'string'], ['left', 'node'], ['right', 'node']],
  logic: [['op', 'string'], ['left', 'node'], ['right', 'node']],
  random: [['prob', 'node'], ['then', 'node'], ['else', 'node']],
  if: [['cond', 'node'], ['then', 'node'], ['else', 'optional']],
  loop: [['kind', 'string'], ['body', 'node']],
  break: [],
  function: [['name', 'string'], ['body', 'node']],
  call: [['name', 'string']],
  action: [['name', 'string']],
};

module.exports = Object.assign(makeAst(), {
  withLogger: (logger) => makeAst(logger),
  NODE_TYPES,
  limits: LIMITS,
});