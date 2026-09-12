'use strict';
/* server/ai/runtime.js —— AI 续执行解释器（P2 B14，契约 docs/interfaces.md §1）
 * 依据：systems/08-ai.md §4.3（续执行状态机）/§4.4（随机流）/§4.5（只读快照）；examples/08-ai.md A-1..A-8；
 *   decisions D-90/D-91/D-100..D-104。
 * 纯函数内核（L11）：随机走注入 rng（ai 流）；快照深冻结；日志经 withLogger（B14 已接线：ai.resume(debug)/ai.action(info)；ai.node(trace) 属 B15——§4.6 L5 ai.runtime 行）。
 * 状态机约定（B14 登记）：
 *   - 程序引用存于 ctx.program（内存态）；帧 = {kind, container(节点引用), childIndex, remaining, condValue, fnScope}，
 *     path 仅作 trace 描述（B16 serializeContext/restoreContext 兑现序列化契约：path→node 反查 + 表达式索引）。
 *   - 表达式（literal/get/bullets/arith/cmp/logic/random 与 var/set 值）在语句推进中立即求值——无跨 resume 状态。
 *   - 隐式主循环（D-100）：顶层 body seq 完成 → frames 重置回入口（vars 保留，A-1/A-4）。
 *   - action 断点 = 父 seq childIndex 已推进到 action 之后（A-2）。
 *   - break = 信号：向上弹掉最近 loop 帧（终止迭代），继续外层。
 *   - 变量：根作用域 ctx.vars；函数体独立作用域（D-103：内部 var 不泄漏、可读外层）；getVar 未声明 → 0。
 *   - random 仅实际求值时消费 ai 流（A-7c/d）；stepLimit/traceLimit 常量（B15 完整兜底语义；本批基础 wait 不崩）。
 */
const { nullLogger } = require('../../shared/log.js');

const STEP_LIMIT = 10000;
const TRACE_LIMIT = 2000;

function deepFreeze(obj) {
  if (obj && typeof obj === 'object') {
    Object.freeze(obj);
    for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  }
  return obj;
}

function makeRuntime(logger) {
  const L = logger || nullLogger;

  function createContext(program) {
    return {
      program,
      entry: 'body',
      frames: [],
      vars: {},
      halted: false,
      stepCount: 0,
      trace: [],
      stepLimit: STEP_LIMIT,
      traceLimit: TRACE_LIMIT,
    };
  }

  // 快照路径读取（白名单投影；越界 → 安全默认，A-8b）
  function getPath(snap, path) {
    if (!path || typeof path !== 'string') return 0;
    const m = path.match(/^([\w]+)(?:\[(\d+)\])?(?:\.([\w]+))?$/);
    if (!m) return 0;
    let v = snap[m[1]];
    if (v === undefined || v === null) return 0;
    if (m[2] !== undefined) {
      v = Array.isArray(v) ? v[parseInt(m[2], 10)] : undefined;
      if (v === undefined || v === null) return 0;
    }
    if (m[3] !== undefined) {
      v = v[m[3]];
      if (v === undefined || v === null) return 0;
    }
    return v;
  }

  // 作用域链（根 = ctx.vars；函数作用于 fnScope 链）
  function lookupVar(scopes, name) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i] && Object.prototype.hasOwnProperty.call(scopes[i], name)) return scopes[i][name];
    }
    return undefined;
  }
  function writeVar(scopes, name, value) {
    for (let i = scopes.length - 1; i >= 0; i--) {
      if (scopes[i] && Object.prototype.hasOwnProperty.call(scopes[i], name)) { scopes[i][name] = value; return; }
    }
    scopes[0][name] = value;
  }

  // 表达式立即求值
  function evalExpr(node, snap, rng, scopes) {
    if (!node || typeof node !== 'object') return node === undefined ? 0 : node;
    switch (node.type) {
      case 'literal': return node.value;
      case 'get': return getPath(snap, node.path);
      case 'bullets': return snap.bullets;
      case 'getVar': {
        const v = lookupVar(scopes, node.name);
        return v === undefined ? 0 : v;
      }
      case 'arith': {
        const l = evalExpr(node.left, snap, rng, scopes);
        const r = evalExpr(node.right, snap, rng, scopes);
        if (node.op === '+') return l + r;
        if (node.op === '-') return l - r;
        if (node.op === '*') return l * r;
        if (node.op === '/') return Math.floor(l / r);
        return 0;
      }
      case 'cmp': {
        const l = evalExpr(node.left, snap, rng, scopes);
        const r = evalExpr(node.right, snap, rng, scopes);
        if (node.op === '<') return l < r;
        if (node.op === '>') return l > r;
        if (node.op === '<=') return l <= r;
        if (node.op === '>=') return l >= r;
        if (node.op === '==') return l === r;
        if (node.op === '!=') return l !== r;
        return false;
      }
      case 'logic': {
        const l = evalExpr(node.left, snap, rng, scopes);
        if (node.op === 'and' && !l) return false;
        if (node.op === 'or' && l) return true;
        const r = evalExpr(node.right, snap, rng, scopes);
        return node.op === 'and' ? !!r : node.op === 'or' ? !!r : false;
      }
      case 'random': {
        const prob = evalExpr(node.prob, snap, rng, scopes);
        return rng.chance(prob, 'ai') ? node.then : node.else;
      }
      default: return 0;
    }
  }

  function traceNode(ctx, path) {
    if (ctx.trace.length < ctx.traceLimit) {
      ctx.trace.push({ seq: ctx.trace.length, path, nodeType: 'stmt', phase: 'eval', depth: ctx.frames.length });
    }
  }

  // resume：推进到产出 action 或步数上限
  function resume(ctx, snapshot, rng) {
    const snap = deepFreeze(Object.assign({}, snapshot));
    ctx.stepCount = 0;
    ctx.halted = false;
    const program = ctx.program;
    if (!program || !program.body) return { action: 'wait', trace: ctx.trace, error: 'ai_invalid' };
    const scopes = [ctx.vars]; // 作用域链（栈底根）
    // 跨 resume 恢复挂起函数帧的独立作用域（P0-1 修复：帧序=压栈序，外层在前，D-103）
    for (const f of ctx.frames) {
      if (f.fnScope) scopes.push(f.fnScope);
    }
    if (ctx.frames.length === 0) {
      ctx.frames.push({ kind: 'seq', list: program.body.statements || [], childIndex: 0, path: ctx.entry, fnScope: null });
    }
    let produced = null;
    let failedLimit = false;

    for (let guard = 0; guard < ctx.stepLimit; guard++) {
      const top = ctx.frames[ctx.frames.length - 1];
      if (!top) {
        // 顶层 seq 完成 → 隐式主循环（D-100）
        if (scopes.length > 1) scopes.length = 1;
        ctx.frames.push({ kind: 'seq', list: program.body.statements || [], childIndex: 0, path: ctx.entry, fnScope: null });
        continue;
      }
      ctx.stepCount += 1;
      if (top.kind === 'seq') {
        const list = top.list || [];
        if (top.childIndex >= list.length) {
          ctx.frames.pop();
          // 函数体完成 → 作用域出栈（D-103）；防御：仅弹出确为该帧 fnScope 的栈顶（P0-1 修复配套）
          if (top.fnScope !== null && scopes[scopes.length - 1] === top.fnScope) scopes.pop();
          continue;
        }
        const stmt = list[top.childIndex];
        const base = `${top.path}.s[${top.childIndex}]`;
        top.childIndex += 1;
        if (!stmt) continue;
        const st = stmt.type;
        traceNode(ctx, base);
        if (st === 'action') {
          produced = stmt.name;
          ctx.halted = true;
          L.info('ai.runtime', 'ai.action', `action ${stmt.name}`, { action: stmt.name, path: base });
          break;
        }
        if (st === 'break') {
          let popped = false;
          while (ctx.frames.length > 0) {
            const f = ctx.frames.pop();
            if (f.kind === 'loop') { popped = true; break; }
          }
          if (!popped) ctx.frames.length = 0;
          continue;
        }
        if (st === 'if') {
          const condVal = !!evalExpr(stmt.cond, snap, rng, scopes);
          const br = condVal ? stmt.then : stmt.else;
          if (br) {
            const brList = br.type === 'seq' ? br.statements : [br];
            ctx.frames.push({ kind: 'seq', list: brList, childIndex: 0, path: `${base}.${condVal ? 'then' : 'else'}`, fnScope: null });
          }
          continue;
        }
        if (st === 'loop') {
          // 帧创建仅登记；count 的 times 在首次迭代时惰性求值（对 while 的 cond 语义一致，跨 resume 持久）
          ctx.frames.push({ kind: 'loop', node: stmt, remaining: null, condValue: null, path: base, fnScope: null });
          continue;
        }
        if (st === 'function') continue; // hoisting（B13）；定义不执行
        if (st === 'call') {
          const fn = findFunction(program, stmt.name);
          if (fn && fn.body) {
            const fnScope = {};
            scopes.push(fnScope);
            const fnList = fn.body.type === 'seq' ? fn.body.statements : [fn.body];
            ctx.frames.push({ kind: 'seq', list: fnList, childIndex: 0, path: `fn:${stmt.name}`, fnScope });
          }
          continue;
        }
        // 无状态语句（var/set/表达式）
        if (st === 'var') {
          // 幂等声明（B14 拍板）：变量已存在则跳过赋值（隐式主循环回绕不重置 A-1；set 才赋值 A-4）
          const own = scopes[scopes.length - 1];
          if (!Object.prototype.hasOwnProperty.call(own, stmt.name)) {
            own[stmt.name] = evalExpr(stmt.value, snap, rng, scopes);
          }
        } else if (st === 'set') {
          const value = evalExpr(stmt.value, snap, rng, scopes);
          writeVar(scopes, stmt.name, value);
        } else {
          evalExpr(stmt, snap, rng, scopes); // 表达式语句：副作用仅 rng
        }
        continue;
      }
      if (top.kind === 'loop') {
        const node = top.node;
        if (node.kind === 'count') {
          if (top.remaining === null) top.remaining = evalExpr(node.times, snap, rng, scopes);
          if (top.remaining <= 0) { ctx.frames.pop(); continue; }
          top.remaining -= 1;
        } else {
          top.condValue = !!evalExpr(node.cond, snap, rng, scopes);
          if (!top.condValue) { ctx.frames.pop(); continue; }
        }
        const bodyList = node.body ? (node.body.type === 'seq' ? node.body.statements : [node.body]) : [];
        ctx.frames.push({ kind: 'seq', list: bodyList, childIndex: 0, path: `${top.path}.body`, fnScope: null });
        continue;
      }
      // 其余 kind 不可达（帧类型仅 seq/loop）；无兜底代码（stepLimit guard 保证终止）
    }

    if (produced === null && ctx.stepCount >= ctx.stepLimit) {
      ctx.frames.length = 0;
      L.warn('ai.runtime', 'ai.step.limit', `steps=${ctx.stepCount}`, { steps: ctx.stepCount });
      return { action: 'wait', trace: ctx.trace, stepLimited: true };
    }
    const action = produced === null ? 'wait' : produced;
    L.debug('ai.runtime', 'ai.resume', `resume action=${action}`, { action, frames: ctx.frames.length });
    return { action, trace: ctx.trace.slice(-ctx.traceLimit) };
  }

  function findFunction(program, name) {
    let found = null;
    (function walk(n) {
      if (found || !n || typeof n !== 'object') return;
      if (n.type === 'function' && n.name === name) { found = n; return; }
      if (Array.isArray(n)) { n.forEach(walk); return; }
      for (const k of Object.keys(n)) {
        const v = n[k];
        if (v && typeof v === 'object') walk(v);
      }
    })(program.body);
    return found;
  }

  function getVar(ctx, name) {
    const v = lookupVar([ctx.vars], name);
    return v === undefined ? 0 : v;
  }

  return { createContext, resume, getVar, STEP_LIMIT, TRACE_LIMIT };
}

module.exports = Object.assign(makeRuntime(), { withLogger: (logger) => makeRuntime(logger), STEP_LIMIT, TRACE_LIMIT });