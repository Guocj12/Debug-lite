'use strict';
/* server/core/unlock.js —— 解锁系统（P1 B4，契约 docs/interfaces.md §1）
 * 依据：systems/09-unlock.md；examples/09-unlock.md U-1..U-6（全分支）；decisions D-112/D-120。
 * 纯函数内核（L11）：无 IO / 无随机 / 无 console；日志经 withLogger 注入（缺省 nullLogger）。
 * 事件：unlock.check(debug) / unlock.reject(warn)（§4.6）。
 * 数据：unlock.json（增量 aiNodes）+ 三表 unlockTier；9 个基础节点恒可用。
 * 注：AI 程序校验（结构/合法性/段位门控）由 ai/ast.js（B12/B13）统一承担——validateAi 于 B13 退役；
 * 本模块保留段位原语（tierIndex/isUnlocked/filterByTier/availableNodes/validateLoadout）。
 *
 * **段位门控开关（用户决策 2026-09-16：默认所有功能全部解锁，段位不参与判定）**：
 *   总开关 = server/data/unlock.json 的 `gating.enabled`（单一数据源，改一个字段即整体回退）；
 *   缺省实例按该字段取值：false（当前默认）→ isUnlocked 恒 true、availableNodes 返回**全部真实节点**、
 *   filterByTier 原样返回、validateLoadout 恒 {ok:true,errors:[]}；无任何 IO/环境变量读取（L11 纯函数）。
 *   测试可注入：`unlock.withGating(true|false)`（返回新实例，链式 `withGating(x).withLogger(log)` 可用），
 *   工厂签名 `makeUnlock(logger?, gating?)`——gating 缺省 = 开关值。
 *   段位树（unlocks/nodePermissions）与各表 unlockTier **保留**为进度/评分元数据，不因本开关删除。
 */
const { nullLogger } = require('../../shared/log.js');
const AI_NODES = require('../data/ai-nodes.json');
const UNLOCK_DATA = require('../data/unlock.json');
const UNLOCK = UNLOCK_DATA.unlocks;
const PERMISSIONS = UNLOCK_DATA.nodePermissions || {};
const ROLE_TEMPLATES = require('../data/role-templates.json').roleTemplates;
const SKILL_TEMPLATES = require('../data/skill-templates.json').skillTemplates;
const PLUGINS = require('../data/plugins.json').plugins;

const TIERS = require('../data/qualities.json').qualities.map((q) => q.id); // 段位序 = 品质表顺序（单一来源）
// 基础节点恒可用（单一数据源 ai-nodes.json；examples/09-unlock §1：common=9 基础 + if = 10）
const BASE_NODES = AI_NODES.base;
const REAL_NODES = new Set(AI_NODES.nodes);
// 全部真实节点类型（门控关闭时 availableNodes 的返回集；单一数据源 ai-nodes.json，当前 16 类）
const ALL_NODES = AI_NODES.nodes.slice();
// 门控开关缺省值（unlock.json `gating.enabled`；字段缺失/非 false 一律按启用处理 → 旧表行为不变）
const GATING_DEFAULT = !UNLOCK_DATA.gating || UNLOCK_DATA.gating.enabled !== false;

// 权限名 → 真实节点类型（nodePermissions）：
//   ① 显式 grants 覆盖；② implemented:false 不授予任何节点（预留权限，避免编辑器插入不可用积木）；
//   ③ 未声明者 = 权限名本身即真实节点类型。
function grantsOf(perm) {
  const decl = PERMISSIONS[perm];
  if (decl && decl.implemented === false) return [];
  if (decl && Array.isArray(decl.grants)) return decl.grants;
  return REAL_NODES.has(perm) ? [perm] : [];
}

const roleMap = Object.fromEntries(ROLE_TEMPLATES.map((r) => [r.id, r]));
const skillMap = Object.fromEntries(SKILL_TEMPLATES.map((s) => [s.id, s]));
const pluginMap = Object.fromEntries(PLUGINS.map((p) => [p.id, p]));

// 段位序号（common=0..mythic=4）；未知 → null（保守拒绝）
function tierIndex(tier) {
  const i = TIERS.indexOf(tier);
  return i === -1 ? null : i;
}

// 增量表（unlock.json 每段位新解锁的权限名；9 基础 + 累计展开 = 该段位可用**节点类型**集）
const NODE_GAIN = Object.fromEntries(UNLOCK.map((u) => [u.tier, u.aiNodes]));

function makeUnlock(logger, gating) {
  const L = logger || nullLogger;
  // 实例门控：显式 true/false 覆盖开关；缺省（undefined/null）→ 读 unlock.json 的 gating.enabled
  const gatingOn = gating === undefined || gating === null ? GATING_DEFAULT : gating === true;

  // 累计权限名（含低段位继承）
  function permissionsAt(tier) {
    const n = tierIndex(tier);
    if (n === null) return [];
    const perms = [];
    for (let i = 0; i <= n; i++) {
      for (const p of NODE_GAIN[TIERS[i]] || []) perms.push(p);
    }
    return perms;
  }

  // 该段位可用**节点类型**全集（继承低段位；权限名经 nodePermissions 展开并去重）
  // 门控关闭（当前默认）→ 不分段位，恒返回**全部真实节点类型**（复制数组，调用方修改不外泄）
  function availableNodes(tier) {
    if (!gatingOn) return ALL_NODES.slice();
    if (tierIndex(tier) === null) return [];
    const nodes = [...BASE_NODES];
    for (const perm of permissionsAt(tier)) {
      for (const nd of grantsOf(perm)) if (!nodes.includes(nd)) nodes.push(nd);
    }
    return nodes;
  }

  // 节点/权限是否在该段位已解锁（U-2）：
  //   - 真实节点类型 → 查展开集；
  //   - 权限别名（如 while）→ 查权限集，但必须真的展开出节点才算可用；
  //   - implemented:false 的预留权限（arith_ext）恒为 false（宁缺勿错：不让编辑器插入不可用积木）。
  // 门控关闭（当前默认）→ 恒 true（段位不参与判定；日志仍照记，便于对照排查）。
  function isUnlocked(tier, key) {
    const hit = !gatingOn || availableNodes(tier).includes(key) ||
      (permissionsAt(tier).includes(key) && grantsOf(key).length > 0);
    L.debug('unlock', 'unlock.check', `tier=${tier} key=${key} -> ${hit}`, { tier, key, hit });
    return hit;
  }

  // 过滤列表：unlockTier 序号 > 当前段位 → 剔除（U-3；缺省视为已解锁）
  // 门控关闭（当前默认）→ **原样返回**入参列表（不筛选、不复制）
  function filterByTier(list, tier) {
    if (!gatingOn) return list;
    const n = tierIndex(tier);
    if (n === null) return [];
    return list.filter((x) => {
      if (x.unlockTier === undefined || x.unlockTier === null) return true;
      const m = tierIndex(x.unlockTier);
      return m !== null && m <= n;
    });
  }

  // 出战配置门控（U-5）：角色/技能/插件 unlockTier ≤ 段位
  // 门控关闭（当前默认）→ 短路返回 {ok:true,errors:[]}（不产生任何 tier_locked，也不记 unlock.reject）
  function validateLoadout(loadout, tier) {
    if (!gatingOn) return { ok: true, errors: [] };
    const ld = loadout || {};
    const errors = [];
    if (ld.role && ld.role.templateId) {
      const t = roleMap[ld.role.templateId];
      if (t && !passes(t.unlockTier, tier)) {
        errors.push({ where: 'role', code: 'tier_locked', message: `角色 ${t.id} 需 ${t.unlockTier}` });
        L.warn('unlock', 'unlock.reject', `role ${t.id} locked @ ${tier}`, { where: 'role', tier });
      }
    }
    (ld.skills || []).forEach((s, i) => {
      const t = skillMap[s.templateId];
      if (t && !passes(t.unlockTier, tier)) {
        errors.push({ where: `skills[${i}]`, code: 'tier_locked', message: `技能 ${t.id} 需 ${t.unlockTier}` });
        L.warn('unlock', 'unlock.reject', `skill ${t.id} locked @ ${tier}`, { where: `skills[${i}]`, tier });
      }
    });
    (ld.plugins || []).forEach((p) => {
      const t = pluginMap[p.id];
      if (t && !passes(t.unlockTier, tier)) {
        errors.push({ where: `plugin:${p.uid || p.id}`, code: 'tier_locked', message: `插件 ${t.id} 需 ${t.unlockTier}` });
        L.warn('unlock', 'unlock.reject', `plugin ${t.id} locked @ ${tier}`, { where: `plugin:${p.uid || p.id}`, tier });
      }
    });
    return errors.length ? { ok: false, errors } : { ok: true, errors: [] };
  }

  function passes(unlockTier, tier) {
    if (unlockTier === undefined || unlockTier === null) return true;
    const a = tierIndex(unlockTier);
    const b = tierIndex(tier);
    return a !== null && b !== null && a <= b;
  }

  // 实例自省：当前门控是否参与判定（测试/文档断言用；属性非函数，无覆盖率副作用）
  // withLogger / withGating 为实例级工厂，保证链式调用（withGating(true).withLogger(log)）不丢设置
  return {
    tierIndex, isUnlocked, filterByTier, validateLoadout, availableNodes, gatingEnabled: gatingOn,
    withLogger: (lg) => makeUnlock(lg, gatingOn),
    withGating: (g) => makeUnlock(L, g),
  };
}

module.exports = Object.assign(makeUnlock(), {
  // 段位门控开关缺省值（= unlock.json gating.enabled；门禁/文档可读）
  GATING_DEFAULT,
});