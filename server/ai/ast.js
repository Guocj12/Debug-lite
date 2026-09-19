'use strict';
/* server/ai/ast.js —— AI 程序 AST 静态校验（P2 B12/B13，契约 docs/interfaces.md §1）
 * 依据：systems/08-ai.md §3（节点清单）/§4.2（结构校验 + 合法性检测 D-101 + 段位门控）；B13 落地 checkLegality。
 * 纯函数内核（L11）：日志经 withLogger 注入；事件 ai.validate(debug)/ai.validate.reject(warn)（§4.6 L5 行）。
 * 路径 id 规范（B12 登记，08-ai A-6h 格式）：seq→s[i]、if/random→then/else、loop→body、function→body（body 内再 s[i]）；
 *   表达式子节点 → .expr；其余节点为叶子。
 * B13 登记：validateAi 自 unlock.js 退役（B4→B13），段位门控由本模块 validate(program, tier) 统一承担
 *   （unlock 保留 tierIndex/isUnlocked/filterByTier/availableNodes/validateLoadout 原语；ai L5 → core L1 方向合法）。
 * 分支行动规则（D-101）：loop 体内所有 if/random（语句位概率分支）的每个分支（含隐式空 else）必须含至少一个 action
 *   或已定义函数 call；random 与 if 同规则（2026-09-17 随机语义修正配套）；
 *   call 视为行动产出点（静态保守）；break 必须位于同一函数作用域内的 loop 体内（跨函数 break 拒绝）；call 必须已定义（hoisting）。
 */

const { nullLogger } = require('../../shared/log.js');
const unlock = require('../core/unlock.js'); // L5 → L1：availableNodes/isUnlocked（段位原语）

// 纯 JS sha256（L5 禁止 node 内建导入——check-arch；与 node:crypto 逐字节对齐，测试用 crypto 锚定）
function sha256Hex(data) {
  const bytes = [];
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < data.length) {
      const c2 = data.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        // 代理对 → UTF-8 4 字节（与 node:crypto UTF-8 一致；P2-1）
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i += 1;
        continue;
      }
    }
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 56; i >= 0; i -= 8) bytes.push(Math.floor(bitLen / Math.pow(2, i)) % 256);
  const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = (bytes[i + t * 4] * 0x1000000 + ((bytes[i + t * 4 + 1] * 0x10000) + (bytes[i + t * 4 + 2] * 0x100) + bytes[i + t * 4 + 3])) | 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const hex = (n) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

// 节点白名单（systems/08-ai.md §3；单一数据源 server/data/ai-nodes.json；loop 含 count/while 两种 kind）
const AI_LANG = require('../data/ai-nodes.json');
const NODE_TYPES = new Set(AI_LANG.nodes);

// 引擎动作词汇表（ai-nodes.json actions）——**仅登记**，不在校验期强制：
//   依据 D-80 与 frontend-spec §6.9，action.name 是自由标签，未知名由引擎 normalizeAction 归一化为 wait
//   并记 action.invalid(warn)；前端下拉只允许给词汇表内的值（自检器 C6 负责）。
const ACTION_SPEC = AI_LANG.actions || { fixed: [], parametric: [] };
// 动作词汇表（D-80：仅用于 warnings 通道，**不在校验期拒绝**）——fixed 固定名 + 前缀式（如 'skill:'）
const ACTION_FIXED = new Set(ACTION_SPEC.fixed || []);
const ACTION_PREFIXES = ACTION_SPEC.parametric || ACTION_SPEC.params || []; // 兼容并行任务对 actions 键的命名

// 快照读路径白名单（B26，D-107 投影；字段清单权威来源 = server/runner.js projectSnapshot 的投影注释）：
//   tick
//   self|enemy.<f>                  f ∈ {hp,maxHp,mp,maxMp,sp,maxSp,atk,def,x,facing,baseHp}
//   self|enemy.cooldowns.<sid>      sid = 标识符（只读副本；未装配技能不出现）
//   self|enemy.effects[<i>].<f>     f ∈ {uid,kind,stat,delta,displacement,remaining}
//   bases.self|enemy.<f>            f ∈ {hp,maxHp,def}
//   field.fieldPx / field.cellPx
//   容器（self / self.cooldowns / self.effects[i] / bases.self …）不可当值读；bullets 已从语言与快照移除 → 一律非法。
//   分层原则：校验层拒绝（bad_path）**不替代**运行层兜底（runtime.getPath 非法/缺失/越界 → 0），
//   绕过校验直接注入运行时的程序仍须安全退化（tests/unit/runtime-limit.test.js 的病态 fixtures 即此层）。
const SNAPSHOT_ACTOR_FIELDS = new Set(['hp', 'maxHp', 'mp', 'maxMp', 'sp', 'maxSp', 'atk', 'def', 'x', 'facing', 'baseHp']);
const SNAPSHOT_EFFECT_FIELDS = new Set(['uid', 'kind', 'stat', 'delta', 'displacement', 'remaining']);
const SNAPSHOT_BASE_FIELDS = new Set(['hp', 'maxHp', 'def']);
const SNAPSHOT_PATH_EXAMPLES = 'tick / self.hp / self.cooldowns.<sid> / self.effects[0].remaining / bases.enemy.hp / field.cellPx';
const PATH_IDENT_SRC = '[A-Za-z_$][A-Za-z0-9_$]*';
const RE_ACTOR_FIELD = new RegExp(`^(?:self|enemy)\\.(${PATH_IDENT_SRC})$`);
const RE_COOLDOWN_FIELD = new RegExp(`^(?:self|enemy)\\.cooldowns\\.(${PATH_IDENT_SRC})$`);
const RE_EFFECT_FIELD = new RegExp(`^(?:self|enemy)\\.effects\\[(\\d+)\\]\\.(${PATH_IDENT_SRC})$`);
const RE_BASE_FIELD = new RegExp(`^bases\\.(?:self|enemy)\\.(${PATH_IDENT_SRC})$`);
const FORBIDDEN_PATH_SEGS = new Set(['__proto__', 'constructor', 'prototype']);

// 路径白名单判定（非字符串/容器/未知字段/危险段/已移除的 bullets → false）
function isAllowedSnapshotPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p === 'tick' || p === 'field.fieldPx' || p === 'field.cellPx') return true;
  let m = RE_ACTOR_FIELD.exec(p);
  if (m) return SNAPSHOT_ACTOR_FIELDS.has(m[1]);
  m = RE_COOLDOWN_FIELD.exec(p);
  if (m) return !FORBIDDEN_PATH_SEGS.has(m[1]);
  m = RE_EFFECT_FIELD.exec(p);
  if (m) return SNAPSHOT_EFFECT_FIELDS.has(m[2]);
  m = RE_BASE_FIELD.exec(p);
  if (m) return SNAPSHOT_BASE_FIELDS.has(m[1]);
  return false;
}

// 表达式位允许的节点类型（值语义）：语句节点出现在表达式位 → not_expression（运行层会把它们静默当 0 求值）
const EXPR_TYPES = new Set(['literal', 'get', 'getVar', 'arith', 'cmp', 'logic', 'random']);

// 全局上限（systems §4.2①/§4.3；程序上限常量与战斗数值无关，撞值豁免见 cl:）
const LIMITS = {
  maxDepth: 32, // cl:32
  maxNodes: 2000,
  maxBytes: 256 * 1024, // cl:1024
  stepLimit: 10000,
  traceLimit: 2000,
  recursionLimit: 64, // cl:64
  analyzeDepth: 16, // cl:16 —— 静态分支分析防爆上限（B13）
};

// 程序版本（A-10d/e）：版本高于 CURRENT_VERSION → ai_version_unsupported；低于且存在迁移链 → 逐级迁移（记 ai.migrate）
const CURRENT_VERSION = 2;
// 迁移表：n → n+1 的迁移函数；v1→v2 为结构无变更的预留迁移（B16 框架演示，A-10e）；
//   新版本引入结构变更时在此登记并在 examples/08-ai.md A-10e 复算。
const MIGRATIONS = {
  1: { to: 2, migrate: (p) => p },
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

  // 版本迁移（A-10d/e）：克隆后逐级迁移；返回 {program, error?, migrated?, from?, to?}；每级记 ai.migrate(info)
  function migrateProgram(program) {
    if (!program || typeof program !== 'object') return { program, error: null };
    const v = program.version;
    if (!Number.isInteger(v) || v < 1) return { program, error: null }; // bad_version 由结构校验报
    if (v > CURRENT_VERSION) return { program, error: 'ai_version_unsupported' };
    if (v === CURRENT_VERSION) return { program, migrated: false };
    let clone;
    try {
      clone = JSON.parse(JSON.stringify(program));
    } catch (e) {
      return { program, error: null }; // 环/不可克隆：跳过迁移，交由结构校验报 ai_cycle
    }
    for (let step = v; step < CURRENT_VERSION; step++) {
      const m = MIGRATIONS[step];
      if (!m) return { program, error: 'ai_version_unsupported' };
      clone = m.migrate(clone);
      clone.version = m.to;
      L.info('ai.ast', 'ai.migrate', `migrate v${step} → v${m.to}`, { from: step, to: m.to });
    }
    return { program: clone, migrated: true, from: v, to: clone.version };
  }

  // 结构校验（B12）：白名单/字段类型/深度/节点数/字节/危险键/root 契约 → {ok, errors:[{path,code,message}]}
  // 接口名按 interfaces §1 冻结：validateProgram（B13 checkLegality 分离）
  function validateProgram(program) {
    const errors = [];
    const state = { nodes: 0, maxDepthSeen: 0, visited: new Set() };
    if (!program || program.type !== 'program') {
      return { ok: false, errors: [{ path: '', code: 'not_program', message: '根节点必须是 program' }], warnings: [] };
    }
    // 版本迁移（A-10d/e）：低版本先迁移（克隆），高版本在此拒绝
    const mig = migrateProgram(program);
    if (mig.error) {
      return { ok: false, errors: [{ path: '', code: mig.error, message: mig.error === 'ai_version_unsupported' ? `版本 ${program.version} 超过当前支持 ${CURRENT_VERSION}` : '程序版本无法迁移' }], warnings: [] };
    }
    if (mig.migrated) program = mig.program;
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
      return { ok: errors.length === 0, errors, warnings: [] };
    }
    if (errors.length > 0) return { ok: false, errors, warnings: [] };

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
    // warnings 通道（D-80，**不阻断**校验）：仅扫描结构合法的程序（拒绝态/含环结构不重复遍历，warnings 恒为数组）
    const warnings = ok ? collectActionWarnings(program) : [];
    L.debug('ai.ast', 'ai.validate', `validate ok=${ok}`, { ok, version: program.version, nodes: state.nodes });
    return { ok, errors, warnings };
  }

  // 统一带路径遍历（seq→s[i]、if/random→then/else、loop/function→body、表达式→.expr；与 nodePathOf 同规则）
  function walkNodes(root, cb) {
    (function walk(n, path) {
      if (!n || typeof n !== 'object') return;
      cb(n, path);
      const ch = childList(n);
      ch.list.forEach((c, i) => {
        const cp = ch.pathName === 's' ? `${path}.s[${i}]` : ch.key === null ? `${path}.${i === 0 ? 'then' : 'else'}` : `${path}.${ch.pathName}`;
        walk(c, cp);
      });
      for (const c of exprChildren(n)) walk(c, `${path}.expr`);
    })(root, 'body');
  }

  // 动作名不在引擎词汇表 → warning（**不拒绝**：D-80 运行期仍由 normalizeAction 归一化为 wait + action.invalid）
  function collectActionWarnings(program) {
    const warnings = [];
    if (!program || !program.body) return warnings;
    walkNodes(program.body, (n, path) => {
      if (n.type !== 'action' || typeof n.name !== 'string') return;
      if (ACTION_FIXED.has(n.name)) return;
      for (const p of ACTION_PREFIXES) {
        if (n.name.startsWith(p)) return;
      }
      warnings.push({ path, code: 'unknown_action', name: n.name, message: `动作名 ${n.name} 不在引擎词汇表（运行期归一化为 wait，见 D-80）` });
    });
    return warnings;
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
        // 枚举校验（2026-09-16 补漏）：运行时不认识的取值必须在校验期拒绝，
        // 否则会出现"校验通过但执行静默失效"（如 logic.op='&&' 恒 false、loop.kind='forever' 空转）
        const allowed = FIELD_ENUMS[`${type}.${field}`];
        if (allowed && !allowed.includes(v)) {
          errors.push({ path: `${path}.${field}`, code: 'bad_enum', message: `${type}.${field} 应为 ${allowed.join(' | ')}（当前 ${JSON.stringify(v)}）` });
        }
      }
    }
    // 枚举取值决定的必填字段（如 loop.kind='count' 需 times、'while' 需 cond）
    for (const rule of ENUM_REQUIRED) {
      if (node.type !== rule.type) continue;
      if (node[rule.field] !== rule.value) continue;
      const req = node[rule.require];
      if (req === undefined || req === null) {
        errors.push({ path: `${path}.${rule.require}`, code: 'bad_field', message: `${type}.${rule.field}=${rule.value} 时必填 ${rule.require}` });
      }
    }
    // get.path 白名单（B26）：非法路径 → 校验期拒绝（运行层另有安全默认 0 兜底；分层见文件头注释）
    if (type === 'get' && typeof node.path === 'string' && !isAllowedSnapshotPath(node.path)) {
      errors.push({ path: `${path}.path`, code: 'bad_path', message: `get.path 非法（不在快照白名单）: ${JSON.stringify(node.path)}；合法示例: ${SNAPSHOT_PATH_EXAMPLES}` });
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
      // 表达式位只能是表达式节点（literal/get/getVar/arith/cmp/logic/random）；
      //   语句节点（action/var/set/seq/if/loop/break/function/call）落在表达式位 → 运行期被静默当 0 求值 → 校验期拒绝
      if (!EXPR_TYPES.has(c.type)) {
        errors.push({ path: `${path}.expr`, code: 'not_expression', message: `表达式位只能是表达式节点（${[...EXPR_TYPES].join('/')}），当前 ${JSON.stringify(c.type)}` });
      }
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

  // ---- B13：合法性检测（D-101）----
  // 行动产出函数集（fixpoint，2026-09-16 补）：函数体**直接含 action**，或调用其它行动产出函数。
  //   目的：允许"分支内只写 call"，同时保证**不会出现空死循环**——纯检测函数（无 action、无调用链）
  //   不能用来满足"分支/循环体必须含 action"，因此 `while(true){ call 纯检测() }` 这类空转会被拒绝。
  function collectActionFns(program) {
    const defs = new Map(); // name -> body（后定义覆盖同名，与 call hoisting 口径一致）
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'function' && typeof n.name === 'string') defs.set(n.name, n.body);
      const ch = childList(n);
      for (const c of (Array.isArray(ch.list) ? ch.list : [])) walk(c);
      for (const c of exprChildren(n)) walk(c);
    })(program.body);
    // 语句位递归（不跨越嵌套 function 定义边界；表达式位的 call 已被 P2-1 判非法）
    const scanBody = (root, visit) => {
      (function walk(n) {
        if (!n || typeof n !== 'object') return;
        visit(n);
        if (n.type === 'function') return; // 嵌套定义体不属于本函数
        const ch = childList(n);
        for (const c of (Array.isArray(ch.list) ? ch.list : [])) walk(c);
      })(root);
    };
    const actionFns = new Set();
    for (const [name, body] of defs) {
      let hasAction = false;
      scanBody(body, (n) => { if (n.type === 'action') hasAction = true; });
      if (hasAction) actionFns.add(name);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, body] of defs) {
        if (actionFns.has(name)) continue;
        let callsProducer = false;
        scanBody(body, (n) => { if (n.type === 'call' && actionFns.has(n.name)) callsProducer = true; });
        if (callsProducer) { actionFns.add(name); changed = true; }
      }
    }
    return actionFns;
  }

  // 分支行动规则：loop 体内所有 if/random（语句位概率分支）的每个分支（含隐式空 else）必须含 action
  //   或调用**行动产出**函数（A-6 全案；random 与 if 同规则——2026-09-17 随机语义修正配套）
  function branchHasAction(node, fns, actionFns, depth) {
    if (!node || typeof node !== 'object') return false;
    if (depth > LIMITS.analyzeDepth) return false; // 保守上限（B13 登记：静态分析防爆炸）
    if (node.type === 'action') return true;
    if (node.type === 'call') return actionFns.has(node.name); // 只有能（传递）产出 action 的函数才算
    if (node.type === 'seq') return (node.statements || []).some((s) => branchHasAction(s, fns, actionFns, depth + 1));
    if (node.type === 'if' || node.type === 'random') return branchHasAction(node.then, fns, actionFns, depth + 1) && (!node.else || branchHasAction(node.else, fns, actionFns, depth + 1));
    if (node.type === 'loop') return branchHasAction(node.body, fns, actionFns, depth + 1);
    return false;
  }

  // 合法性：分支行动规则 + break 位置 + call 存在性（错误带 path）
  function checkLegality(program) {
    const errors = [];
    if (!program || !program.body) return { ok: false, errors };
    // 函数名收集（hoisting，D-103：先调用后定义合法）
    const fns = new Set();
    (function walk(n) {
      if (!n || typeof n !== 'object') return;
      if (n.type === 'function' && typeof n.name === 'string') fns.add(n.name);
      const ch = childList(n);
      for (const c of (Array.isArray(ch.list) ? ch.list : [])) walk(c);
      for (const c of exprChildren(n)) walk(c);
    })(program.body);
    const actionFns = collectActionFns(program);
    (function scan(node, path, ctx) {
      if (!node || typeof node !== 'object') return;
      switch (node.type) {
        case 'loop': {
          if (!branchHasAction(node.body, fns, actionFns, 0)) {
            errors.push({ path: `${path}.body`, code: 'branch_without_action', message: '循环体必须至少包含一个 action（或调用会产出 action 的函数）' });
          }
          scan(node.body, `${path}.body`, { loopDepth: ctx.loopDepth + 1, scope: ctx.scope }, fns, errors);
          for (const c of exprChildren(node)) scan(c, `${path}.expr`, ctx, fns, errors); // P2-1：表达式位 call/break 不逃逸
          break;
        }
        case 'if': {
          // 仅在循环体内检查分支行动（顶层 if 允许无 else，A-1）
          if (ctx.loopDepth > 0) {
            if (!branchHasAction(node.then, fns, actionFns, 0)) errors.push({ path: `${path}.then`, code: 'branch_without_action', message: 'if 的 then 分支必须包含 action' });
            if (!node.else || !branchHasAction(node.else, fns, actionFns, 0)) errors.push({ path: `${path}.else`, code: 'branch_without_action', message: 'if 的 else 分支必须包含 action（缺 else 视为空分支）' });
          }
          if (node.then) scan(node.then, `${path}.then`, ctx, fns, errors);
          if (node.else) scan(node.else, `${path}.else`, ctx, fns, errors);
          for (const c of exprChildren(node)) scan(c, `${path}.expr`, ctx, fns, errors); // P2-1：cond 位不逃逸
          break;
        }
        case 'random': {
          // 语句位概率分支：与 if 同规则（循环体内每个分支必须含 action；缺 else 视为空分支）；
          //   表达式位的 random（如 set 值 / if.cond）不在此检查，仅按表达式递归（exprChildren）。
          if (ctx.loopDepth > 0) {
            if (!branchHasAction(node.then, fns, actionFns, 0)) errors.push({ path: `${path}.then`, code: 'branch_without_action', message: 'random 的 then 分支必须包含 action' });
            if (!node.else || !branchHasAction(node.else, fns, actionFns, 0)) errors.push({ path: `${path}.else`, code: 'branch_without_action', message: 'random 的 else 分支必须包含 action（缺 else 视为空分支）' });
          }
          if (node.then) scan(node.then, `${path}.then`, ctx, fns, errors);
          if (node.else) scan(node.else, `${path}.else`, ctx, fns, errors);
          for (const c of exprChildren(node)) scan(c, `${path}.expr`, ctx, fns, errors);
          break;
        }
        case 'break': {
          if (ctx.loopDepth === 0) errors.push({ path, code: 'break_outside_loop', message: 'break 只能位于循环体内' });
          break;
        }
        case 'call': {
          if (!fns.has(node.name)) errors.push({ path, code: 'unknown_call', message: `未定义函数 ${node.name}` });
          break;
        }
        case 'function': {
          // 函数体独立作用域：循环深度重置（函数内 break 只能指向自身循环）
          scan(node.body, `${path}.body`, { loopDepth: 0, scope: 'fn' }, fns, errors);
          break;
        }
        default: {
          const ch = childList(node);
          if (ch.list && Array.isArray(ch.list)) {
            ch.list.forEach((c, i) => {
              const cp = ch.pathName === 's' ? `${path}.s[${i}]` : ch.key === null ? `${path}.${i === 0 ? 'then' : 'else'}` : `${path}.${ch.pathName}`;
              scan(c, cp, ctx, fns, errors);
            });
          }
          for (const c of exprChildren(node)) scan(c, `${path}.expr`, ctx, fns, errors);
        }
      }
    })(program.body, 'body', { loopDepth: 0, scope: 'root' }, fns, errors);
    return { ok: errors.length === 0, errors };
  }

  // 全量校验（B13）：结构 + 合法性 + 段位门控 → {ok, errors:[{path,code,message}]}；拒绝记 ai.validate.reject(warn)
  function validate(program, tier) {
    const errors = [];
    // 版本迁移先行：后续结构/合法性/门控全用迁移后程序（A-10d/e）
    const mig = migrateProgram(program);
    if (mig.error) {
      return { ok: false, errors: [{ path: '', code: mig.error, message: mig.error === 'ai_version_unsupported' ? `版本 ${program && program.version} 超过当前支持 ${CURRENT_VERSION}` : '程序版本无法迁移' }] };
    }
    if (mig.migrated) program = mig.program;
    const struct = validateProgram(program);
    errors.push(...struct.errors);
    let legality = { ok: true, errors: [] };
    if (struct.ok) {
      legality = checkLegality(program);
      errors.push(...legality.errors);
    }
    // 段位门控（unlock 原语：unknown → 保守拒绝）
    const gateErrors = [];
    if (struct.ok) {
      const seen = new Set();
      (function walk(n, p) {
        if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
        if (!seen.has(n)) {
          seen.add(n);
          if (!unlock.isUnlocked(tier, n.type)) {
            gateErrors.push({ path: p, code: 'node_locked', node: n.type, message: `节点 ${n.type} 需 ${tierOfNode(n.type)} 段位` });
          }
        }
        const ch = childList(n);
        const chList = Array.isArray(ch.list) ? ch.list : [];
        chList.forEach((c, i) => walk(c, ch.pathName === 's' ? `${p}.s[${i}]` : ch.key === null ? `${p}.${i === 0 ? 'then' : 'else'}` : `${p}.${ch.pathName}`));
        for (const c of exprChildren(n)) walk(c, `${p}.expr`);
      })(program && program.body, 'body');
    }
    errors.push(...gateErrors);
    const ok = errors.length === 0;
    if (!ok) {
      for (const e of errors) {
        if (e.code === 'node_locked' || e.code === 'branch_without_action' || e.code === 'break_outside_loop' || e.code === 'unknown_call') {
          L.warn('ai.ast', 'ai.validate.reject', `${e.code} @ ${e.path}`, { code: e.code, path: e.path, node: e.node });
        }
      }
    }
    L.debug('ai.ast', 'ai.validate', `validate(${tier}) ok=${ok}`, { ok, tier, version: program && program.version });
    return { ok, errors };
  }

  // 节点所属解锁段位（错误消息用；unlock 原语反查）
  function tierOfNode(nodeType) {
    for (const t of ['common', 'rare', 'epic', 'legendary', 'mythic']) {
      if (unlock.isUnlocked(t, nodeType)) return t;
    }
    return 'unknown';
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

  // 程序统计（/ai/compile：{nodes, depth, usedNodeTypes}，systems §4.7）
  function statsOf(program) {
    const usedNodeTypes = collectUsedNodeTypes(program);
    let nodes = 0;
    let depth = 0;
    (function walk(n, d) {
      if (!n || typeof n !== 'object' || typeof n.type !== 'string') return;
      nodes += 1;
      if (d > depth) depth = d;
      const ch = childList(n);
      if (ch.list && Array.isArray(ch.list)) ch.list.forEach((c) => walk(c, d + 1));
      for (const c of exprChildren(n)) walk(c, d + 1);
    })(program && program.body, 1);
    return { nodes, depth, usedNodeTypes: [...usedNodeTypes] };
  }

  return { validateProgram, collectUsedNodeTypes, checkLegality, validate, nodePathOf, NODE_TYPES, limits: LIMITS, canonicalize, programHash, statsOf, getNodeAtPath, migrateProgram };
}

// A-10a/b/c 规范化：对象键排序 + 紧凑序列化（去空白）→ 同一程序不同书写/空白 → 相同 canonical 串
function canonicalize(program) {
  const canon = (n) => {
    if (Array.isArray(n)) return n.map(canon);
    if (n === null || typeof n !== 'object') return n;
    const out = {};
    for (const k of Object.keys(n).sort()) {
      if (n[k] === undefined) continue;
      out[k] = canon(n[k]);
    }
    return out;
  };
  return JSON.stringify(canon(program));
}

// A-10a..c：sha256(programHash)（纯 JS 实现，键序/空白无关；字面量一变即变；与 node:crypto 锚定测试）
function programHash(program) {
  return sha256Hex(canonicalize(program));
}

// path → 节点反查（B16 serializeContext/restoreContext；nodePathOf 的逆；fn: 帧路径 B16 起统一为规范路径，无特例）
//   .expr 段：在表达式字段（value/left/right/cond/prob/times）中取首个对象（多表达式字段共享 .expr 段是
//   nodePathOf 的既有登记缺陷；运行时帧从不产生表达式路径，反查仅服务序列化防御/诊断；P2-4）
function getNodeAtPath(program, path) {
  if (typeof path !== 'string' || !program || !program.body) return null;
  if (path === 'body') return program.body;
  const parts = path.split('.');
  if (parts[0] !== 'body') return null;
  let node = program.body;
  for (let i = 1; i < parts.length && node; i++) {
    const t = parts[i];
    const m = /^s\[(\d+)\]$/.exec(t);
    if (m) node = node && Array.isArray(node.statements) ? node.statements[Number(m[1])] : null;
    else if (t === 'expr') {
      let n = null;
      for (const k of ['value', 'left', 'right', 'cond', 'prob', 'times']) {
        const v = node && node[k];
        if (v && typeof v === 'object') { n = v; break; }
      }
      node = n;
    } else if (t === 'then' || t === 'else' || t === 'body') node = node[t] || null;
    else return null;
  }
  return node || null;
}

// 字段枚举表（2026-09-16 补漏）：取值必须与 runtime.js 实际实现一致；表外取值一律校验期拒绝
const FIELD_ENUMS = {
  'arith.op': ['+', '-', '*', '/'],
  'cmp.op': ['>', '<', '>=', '<=', '==', '!='],
  'logic.op': ['and', 'or'],
  'loop.kind': ['count', 'while'],
};

// 枚举取值 → 追加必填字段（loop.count 需 times；loop.while 需 cond）
const ENUM_REQUIRED = [
  { type: 'loop', field: 'kind', value: 'count', require: 'times' },
  { type: 'loop', field: 'kind', value: 'while', require: 'cond' },
];

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
  CURRENT_VERSION,
  MIGRATIONS,
});