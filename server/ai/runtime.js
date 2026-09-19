'use strict';
/* server/ai/runtime.js —— AI 续执行解释器（P2 B14，契约 docs/interfaces.md §1）
 * 依据：systems/08-ai.md §4.3（续执行状态机）/§4.4（随机流）/§4.5（只读快照）；examples/08-ai.md A-1..A-8；
 *   decisions D-90/D-91/D-100..D-104。
 * 纯函数内核（L11）：随机走注入 rng（ai 流）；快照深冻结；日志经 withLogger（B14 已接线：ai.resume(debug)/ai.action(info)；ai.node(trace) 属 B15——§4.6 L5 ai.runtime 行）。
 * 状态机约定（B14 登记）：
 *   - 程序引用存于 ctx.program（内存态）；帧 = {kind, container(节点引用), childIndex, remaining, condValue, fnScope}，
 *     path 仅作 trace 描述（B16 serializeContext/restoreContext 兑现序列化契约：path→node 反查 + 表达式索引）。
 *   - 表达式（literal/get/arith/cmp/logic/random 与 var/set 值）在语句推进中立即求值——无跨 resume 状态。
 *   - 隐式主循环（D-100）：顶层 body seq 完成 → frames 重置回入口（vars 保留，A-1/A-4）。
 *   - action 断点 = 父 seq childIndex 已推进到 action 之后（A-2）。
 *   - break = 信号：向上弹掉最近 loop 帧（终止迭代），继续外层。
 *   - 变量：根作用域 ctx.vars；函数体独立作用域（D-103：内部 var 不泄漏、可读外层）；getVar 未声明 → 0。
 *   - random 两种用法（2026-09-17 用户决策 A 修语义）：语句位 = 概率分支（真执行 then/else，与 if 同规则、缺 else 跳过）；
 *     表达式位 = 布尔（求值为 rng.chance(prob,'ai') 的 true/false，不再返回 AST 子树）。
 *     两种用法都只在**实际求值**时消费一次 ai 流（A-7c/d；D-91 每 tick 每用途派生流）。
 * B15 登记：步数兜底统一（guard 耗尽即 wait + 重置入口 + ai.step.limit(warn)，D-81/A-9a）；
 *   递归上限 64（ai.depth.limit(warn)，弹栈到入口，A-5/A-9b；vars 保留故弹栈后仍可推进）；
 *   trace 条目 {seq,path,nodeType,phase,result,depth} + ai.node(trace) 事件 + **单 tick**上限 2000 截断
 *   （trace 每 tick 重置，seq 为本 tick 内序号；trace.truncated(warn) 每 tick 至多一次，A-9e + v3-design §11.10）；
 *   内部异常捕获 → wait + ai.error(err) 日志，绝不抛穿引擎（A-9d）。
 */
const { nullLogger } = require('../../shared/log.js');

const STEP_LIMIT = 10000;
const TRACE_LIMIT = 2000;
const RECURSION_LIMIT = 64; // cl:64（递归深度上限 A-5/A-9b，通用限制常量、非战斗数值）

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
      recursionLimit: RECURSION_LIMIT,
    };
  }

  // 快照路径读取（B26 泛化）：通用点分路径 + 索引——a / a.b / a.b[i].c / a[i][j] / a.b[i][j].c …
  //   旧实现只支持"基名 + 可选 [i] + 可选单层 .prop"，因此读不到 self.effects[0].remaining 这类新投影字段。
  //   兜底语义不变（A-8b）：路径非法 / 缺字段 / 非对象 / 索引越界 / 索引落到非数组 → 安全默认 0，绝不抛。
  //   只读保证：取值对象来自 deepFreeze 后的只读快照副本（容器亦冻结），不泄漏引擎可变引用；
  //   危险段（__proto__/constructor/prototype）一律拒绝——否则可经原型链取到引擎之外的可变对象。
  const SNAP_PATH_RE = /^\w+(?:\[\d+\])*(?:\.\w+(?:\[\d+\])*)*$/;
  const FORBIDDEN_SEG_RE = /^(?:__proto__|constructor|prototype)$/;
  function getPath(snap, path) {
    if (!path || typeof path !== 'string' || !SNAP_PATH_RE.test(path)) return 0;
    let v = snap;
    for (const chunk of path.split('.')) {
      const parts = chunk.split(/[[\]]/); // 'effects[0][1]' → ['effects','0','1']；'hp' → ['hp']
      for (let i = 0; i < parts.length; i++) {
        const seg = parts[i];
        if (seg === '') continue; // 尾随空段（'effects[0]' → ['effects','0','']）
        if (v === null || typeof v !== 'object') return 0; // 缺失/标量继续下钻 → 安全默认
        if (i === 0) {
          if (FORBIDDEN_SEG_RE.test(seg)) return 0;
          v = v[seg];
        } else {
          if (!Array.isArray(v)) return 0; // 索引只能落在数组上（对象键走 .prop，不做数字键兜底）
          v = v[Number(seg)];
        }
        if (v === undefined || v === null) return 0;
      }
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
        // 表达式位：布尔（true 概率 = prob）；每次求值消费一次 ai 流。
        //   语句位的概率分支执行见 resumeInner 的 st === 'random' 处理（同一个节点两种用法，按位置分派）。
        const prob = evalExpr(node.prob, snap, rng, scopes);
        return !!rng.chance(prob, 'ai');
      }
      default: return 0;
    }
  }

  // trace 条目：seq = **本 tick 内**序号（每 tick 重置，见 resumeInner）；单 tick 上限 traceLimit
  function traceNode(ctx, path, stmt) {
    if (ctx.trace.length < ctx.traceLimit) {
      const nodeType = stmt && stmt.type ? stmt.type : 'stmt';
      const entry = { seq: ctx.trace.length, path, nodeType, phase: 'eval', depth: ctx.frames.length };
      if (nodeType === 'action') entry.result = stmt.name; // T-AF-6：末条 action 与返回值一致性
      ctx.trace.push(entry);
      L.trace('ai.runtime', 'ai.node', `node ${path}`, { path, nodeType });
    } else if (!ctx.traceTruncated) {
      ctx.traceTruncated = true; // A-9e：本 tick 内超限 → 截断、本 tick 后续不再记录；trace.truncated(warn) 每 tick 至多一次
      L.warn('ai.runtime', 'trace.truncated', `trace 超限 ${ctx.traceLimit} 截断（单 tick）`, { limit: ctx.traceLimit });
    }
  }

  // resume：推进到产出 action 或步数上限；内部异常绝不抛穿引擎（A-9d → wait + ai.error）
  function resume(ctx, snapshot, rng) {
    try {
      return resumeInner(ctx, snapshot, rng);
    } catch (e) {
      ctx.halted = false;
      // P2-3 可观测性：data 补 stack。抛错点实测为入口 deepFreeze 深度冻结读值处（getter 触发），非 evalExpr 求值；
      // 行为契约不变：wait + ai.error + 绝不抛穿（A-9d）。
      L.error('ai.runtime', 'ai.error', `runtime error: ${e && e.message}`, { message: e && String(e.message || e), stack: e && e.stack ? String(e.stack) : undefined });
      return { action: 'wait', trace: (ctx.trace || []).slice(-ctx.traceLimit), error: 'ai_crash' };
    }
  }
  function resumeInner(ctx, snapshot, rng) {
    const snap = deepFreeze(Object.assign({}, snapshot));
    ctx.stepCount = 0;
    ctx.halted = false;
    // B26（并行任务移交的语义变更）：trace 每 tick 重置——resume 是"单 tick 续执行"的边界，
    //   故本次 resume 产出的 trace 恰为**该 tick 全量**（单 tick 上限仍为 traceLimit=2000）。
    //   司机（server/runner.js / server/battle.js）据此直接取全量，不再按 prevLen 取增量。
    ctx.trace = [];
    ctx.traceTruncated = false; // 截断标记语义：**本 tick 内**是否被截断（随 trace 一起按 tick 重置）
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
        traceNode(ctx, base, stmt);
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
        if (st === 'random') {
          // 语句位：概率分支——求值 prob + 消费一次 ai 流 → 压入 then/else 分支帧（与 if 分支同规则：
          //   分支为 seq 取 statements，单节点包成 [node]；else 缺省 → 跳过，不产出行动）。
          const prob = evalExpr(stmt.prob, snap, rng, scopes);
          const condVal = !!rng.chance(prob, 'ai');
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
          const def = findFunctionDef(program, stmt.name);
          if (def && def.node.body) {
            // 递归深度上限（A-5/A-9b）：挂起函数帧（fnScope 计数）达上限 → 弹栈到入口 + wait（vars 保留，下一 tick 从入口继续）
            let depth = 0;
            for (const f of ctx.frames) if (f.fnScope) depth += 1;
            if (depth >= ctx.recursionLimit) {
              ctx.frames.length = 0;
              L.warn('ai.runtime', 'ai.depth.limit', `depth=${depth + 1}`, { limit: ctx.recursionLimit, depth: depth + 1 });
              return { action: 'wait', trace: ctx.trace.slice(-ctx.traceLimit), depthLimited: true };
            }
            const fnScope = {};
            scopes.push(fnScope);
            const fnList = def.node.body.type === 'seq' ? def.node.body.statements : [def.node.body];
            ctx.frames.push({ kind: 'seq', list: fnList, childIndex: 0, path: `${def.path}.body`, fnScope });
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

    if (produced === null) {
      // 步数兜底（D-81/A-9a）：guard 耗尽且无产出 → 重置到入口 + ai.step.limit(warn)（B15：无条件兜底）
      ctx.frames.length = 0;
      L.warn('ai.runtime', 'ai.step.limit', `steps=${ctx.stepCount}`, { steps: ctx.stepCount });
      return { action: 'wait', trace: ctx.trace.slice(-ctx.traceLimit), stepLimited: true };
    }
    const action = produced;
    L.debug('ai.runtime', 'ai.resume', `resume action=${action}`, { action, frames: ctx.frames.length });
    return { action, trace: ctx.trace.slice(-ctx.traceLimit) };
  }

  function getVar(ctx, name) {
    const v = lookupVar([ctx.vars], name);
    return v === undefined ? 0 : v;
  }

  // B16 序列化契约（AiContext 可序列化，interfaces §4.5）：帧存 path，节点引用不序列化；
  //  restored 后 resume 行为与未序列化路径一致（T-AF-7）。null/undefined → null（P2-3 防御）。
  function serializeContext(ctx) {
    if (!ctx) return null;
    return {
      programHash: ctx && ctx.programHash !== undefined ? ctx.programHash : null,
      entry: ctx.entry,
      frames: (ctx.frames || []).map((f) => ({
        kind: f.kind,
        path: f.path,
        childIndex: f.childIndex,
        remaining: f.remaining === undefined ? null : f.remaining,
        condValue: f.condValue === undefined ? null : f.condValue,
        fnScope: f.fnScope ? Object.assign({}, f.fnScope) : null,
      })),
      vars: Object.assign({}, ctx.vars),
      halted: !!ctx.halted,
      stepCount: ctx.stepCount || 0,
      trace: (ctx.trace || []).map((e) => Object.assign({}, e)),
      stepLimit: ctx.stepLimit,
      traceLimit: ctx.traceLimit,
      recursionLimit: ctx.recursionLimit,
      traceTruncated: !!ctx.traceTruncated,
    };
  }

  // path → 节点反查（restoreContext 帧重建；L5 禁同层 require，反查内联在运行时；
  //   与 ast.js getNodeAtPath 同规则：'.s[i]'/'then'/'else'/'body'/'expr' 段；函数体内帧为 body.s[i].body... 规范路径）
  function nodeAtPath(program, path) {
    if (typeof path !== 'string' || !program || !program.body) return null;
    if (path === 'body') return program.body;
    const parts = path.split('.');
    if (parts[0] !== 'body') return null;
    let node = program.body;
    for (let i = 1; i < parts.length && node; i++) {
      const t = parts[i];
      const m = /^s\[(\d+)\]$/.exec(t);
      if (m) node = node && Array.isArray(node.statements) ? node.statements[Number(m[1])] : null;
      else if (t === 'then' || t === 'else' || t === 'body' || t === 'expr') node = node[t] || null;
      else return null;
    }
    return node || null;
  }

  // 子节点路径步进（与 ast.nodePathOf 同规则：seq→s[i]、if/random→then/else、loop/function→body、表达式→.expr；
  //   B16 P1-1 修复：fn 帧路径改用 AST 规范路径，嵌套帧（循环/分支）经 nodeAtPath 统一可反查）
  function walkChildren(node, path, cb) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'seq') {
      const list = node.statements;
      if (Array.isArray(list)) list.forEach((c, i) => { if (c && typeof c === 'object') cb(c, `${path}.s[${i}]`); });
    } else if (node.type === 'if' || node.type === 'random') {
      for (const seg of ['then', 'else']) {
        const v = node[seg];
        if (v && typeof v === 'object') cb(v, `${path}.${seg}`);
      }
    } else if (node.type === 'loop' || node.type === 'function') {
      const v = node.body;
      if (v && typeof v === 'object') cb(v, `${path}.body`);
    }
    for (const k of ['value', 'left', 'right', 'cond', 'prob', 'times']) {
      const v = node[k];
      if (v && typeof v === 'object') cb(v, `${path}.expr`);
    }
  }

  // 函数定义查找：返回 {node, path}（path 为 AST 规范路径；call 帧以此为锚）
  function findFunctionDef(program, name) {
    let found = null;
    (function walk(n, path) {
      if (found || !n || typeof n !== 'object' || typeof n.type !== 'string') return;
      if (n.type === 'function' && n.name === name) { found = { node: n, path }; return; }
      walkChildren(n, path, walk);
    })(program && program.body, 'body');
    return found;
  }

  // 反序列化：path → program 节点重建帧（seq 帧取 statements/[node]；loop 帧取节点；全规范路径，无 fn: 特例）
  function restoreContext(ser, program) {
    const ctx = createContext(program || { type: 'program', version: 1, body: { type: 'seq', statements: [] } });
    ctx.entry = ser && ser.entry ? ser.entry : 'body';
    ctx.vars = Object.assign({}, (ser && ser.vars) || {});
    ctx.halted = !!(ser && ser.halted);
    ctx.stepCount = (ser && ser.stepCount) || 0;
    if (ser && ser.stepLimit !== undefined) ctx.stepLimit = ser.stepLimit;
    if (ser && ser.traceLimit !== undefined) ctx.traceLimit = ser.traceLimit;
    if (ser && ser.recursionLimit !== undefined) ctx.recursionLimit = ser.recursionLimit;
    if (ser && ser.programHash !== undefined) ctx.programHash = ser.programHash;
    ctx.traceTruncated = !!(ser && ser.traceTruncated);
    ctx.trace = (ser && Array.isArray(ser.trace)) ? ser.trace.map((e) => Object.assign({}, e)) : [];
    ctx.frames = ((ser && Array.isArray(ser.frames)) ? ser.frames : []).map((f) => {
      const fnScope = f && f.fnScope ? Object.assign({}, f.fnScope) : null;
      if (f && f.kind === 'seq') {
        // 全规范路径（含函数体 body.s[i].body...）；不可反查的帧丢弃（防御）
        const node = nodeAtPath(program, f.path);
        if (!node) return null;
        const list = node.type === 'seq' ? node.statements || [] : [node];
        return { kind: 'seq', list, childIndex: f.childIndex || 0, path: f.path, fnScope };
      }
      if (f && f.kind === 'loop') {
        const node = nodeAtPath(program, f.path);
        if (!node) return null; // 无法反查的帧丢弃（防御）
        return { kind: 'loop', node, remaining: f.remaining === undefined ? null : f.remaining, condValue: f.condValue === undefined ? null : f.condValue, path: f.path, fnScope: null };
      }
      return null;
    }).filter(Boolean);
    return ctx;
  }

  // 释放引用（引擎打完不再需要时调用；AiContext 生命周期收尾）
  function destroyContext(ctx) {
    if (!ctx) return;
    ctx.frames = [];
    ctx.trace = [];
    ctx.vars = {};
    ctx.program = null;
    ctx.halted = true;
  }

  return { createContext, resume, getVar, serializeContext, restoreContext, destroyContext, STEP_LIMIT, TRACE_LIMIT, RECURSION_LIMIT };
}

module.exports = Object.assign(makeRuntime(), { withLogger: (logger) => makeRuntime(logger), STEP_LIMIT, TRACE_LIMIT, RECURSION_LIMIT });