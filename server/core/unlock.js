'use strict';
/* server/core/unlock.js —— 解锁系统（P1 B4，契约 docs/interfaces.md §1）
 * 依据：systems/09-unlock.md；examples/09-unlock.md U-1..U-6（全分支）；decisions D-112/D-120。
 * 纯函数内核（L11）：无 IO / 无随机 / 无 console；日志经 withLogger 注入（缺省 nullLogger）。
 * 事件：unlock.check(debug) / unlock.reject(warn)（§4.6）。
 * 数据：unlock.json（增量 aiNodes）+ 三表 unlockTier；10 个基础节点恒可用。
 * 注：结构校验（白名单/深度/大小）由 ai/ast.js（B12）接管；本模块 validateAi 只做未知节点拒绝 + 段位门控（U-4）。
 */
const { nullLogger } = require('../../shared/log.js');
const UNLOCK = require('../data/unlock.json').unlocks;
const ROLE_TEMPLATES = require('../data/role-templates.json').roleTemplates;
const SKILL_TEMPLATES = require('../data/skill-templates.json').skillTemplates;
const PLUGINS = require('../data/plugins.json').plugins;

const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
// 基础节点恒可用（examples/09-unlock §1：common=10 基础 + if = 11）
const BASE_NODES = ['seq', 'literal', 'get', 'bullets', 'var', 'set', 'getVar', 'arith', 'cmp', 'action'];
// 全部已知节点白名单（U-4g 结构拒绝用；B12 ast.js 将接管完整结构）
const ALL_NODES = new Set([
  ...BASE_NODES,
  'if', 'loop', 'while', 'break', 'random', 'logic', 'arith_ext', 'function', 'call',
]);

const roleMap = Object.fromEntries(ROLE_TEMPLATES.map((r) => [r.id, r]));
const skillMap = Object.fromEntries(SKILL_TEMPLATES.map((s) => [s.id, s]));
const pluginMap = Object.fromEntries(PLUGINS.map((p) => [p.id, p]));

// 段位序号（common=0..mythic=4）；未知 → null（保守拒绝）
function tierIndex(tier) {
  const i = TIERS.indexOf(tier);
  return i === -1 ? null : i;
}

// 增量表（unlock.json 每段位新解锁的节点；10 基础 + 累计 = 该段位可用集）
const NODE_GAIN = Object.fromEntries(UNLOCK.map((u) => [u.tier, u.aiNodes]));

function makeUnlock(logger) {
  const L = logger || nullLogger;

  // 该段位可用节点全集（继承低段位）
  function availableNodes(tier) {
    const n = tierIndex(tier);
    if (n === null) return [];
    const nodes = [...BASE_NODES];
    for (let i = 0; i <= n; i++) {
      for (const nd of NODE_GAIN[TIERS[i]] || []) nodes.push(nd);
    }
    return nodes;
  }

  // 节点是否在该段位已解锁（U-2）
  function isUnlocked(tier, key) {
    const unlocked = availableNodes(tier);
    const hit = unlocked.includes(key);
    L.debug('unlock', 'unlock.check', `tier=${tier} key=${key} -> ${hit}`, { tier, key, hit });
    return hit;
  }

  // 过滤列表：unlockTier 序号 > 当前段位 → 剔除（U-3；缺省视为已解锁）
  function filterByTier(list, tier) {
    const n = tierIndex(tier);
    if (n === null) return [];
    return list.filter((x) => {
      if (x.unlockTier === undefined || x.unlockTier === null) return true;
      const m = tierIndex(x.unlockTier);
      return m !== null && m <= n;
    });
  }

  // 收集程序用到的节点类型（递归，附路径）
  function collectUsedNodes(node, path, out) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.type === 'string') {
      out.push({ type: node.type, path });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key === 'type' || key === 'name' || key === 'version' || key === 'kind' || key === 'value' || key === 'prob') continue;
      if (Array.isArray(child)) {
        child.forEach((c, i) => collectUsedNodes(c, `${path}.${key}[${i}]`, out));
      } else if (child && typeof child === 'object') {
        collectUsedNodes(child, `${path}.${key}`, out);
      }
    }
  }

  // AI 程序段位门控（U-4）：未知节点 → unknown_node（结构，B12 前就地拒绝）；未解锁 → node_locked（带 path 与节点名）
  function validateAi(program, tier) {
    if (!program || !program.body) {
      const err = { path: '', code: 'ai_invalid', message: '程序结构非法（缺 body）' };
      L.warn('unlock', 'unlock.reject', `ai_invalid: 缺 body`, { node: 'program' });
      return { ok: false, errors: [err] };
    }
    const used = [];
    collectUsedNodes(program.body, 'body', used);
    const errors = [];
    for (const { type, path } of used) {
      if (!ALL_NODES.has(type)) {
        errors.push({ path, code: 'unknown_node', node: type, message: `未知节点类型 ${type}` });
        L.warn('unlock', 'unlock.reject', `unknown_node ${type}`, { node: type, path });
        continue;
      }
      if (!isUnlocked(tier, type)) {
        errors.push({ path, code: 'node_locked', node: type, message: `节点 ${type} 需 ${tierOfNode(type)} 段位` });
        L.warn('unlock', 'unlock.reject', `node ${type} locked @ ${tier}`, { node: type, tier });
      }
    }
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, errors: [] };
  }

  // 出战配置门控（U-5）：角色/技能/插件 unlockTier ≤ 段位
  function validateLoadout(loadout, tier) {
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

  // 节点所属解锁段位（错误消息用）
  function tierOfNode(node) {
    if (BASE_NODES.includes(node)) return 'common';
    for (const t of TIERS) {
      if ((NODE_GAIN[t] || []).includes(node)) return t;
    }
    return 'unknown';
  }

  return { tierIndex, isUnlocked, filterByTier, validateAi, validateLoadout, availableNodes };
}

module.exports = Object.assign(makeUnlock(), { withLogger: (logger) => makeUnlock(logger) });