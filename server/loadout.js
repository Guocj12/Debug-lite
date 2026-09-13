'use strict';
/* server/loadout.js —— 出战配置校验与最终面板（P3 B19；契约 docs/interfaces.md §2 /api/v1/loadout + /api/v1/panel）
 * L6 组合：结构（I-12a/b：角色 1 + 技能恰 3 + AI 合法）+ 引用完整性（T-PB-9/I-12d）+ 段位门控
 * （I-12e：物品级 items.validateUnlock + AI 节点 ast.validate(tier)）+ 面板聚合（五维/regen/special/技能参数）。
 * D-123：不持久化——POST 校验后回带；GET 返回规范骨架。事件：api.*（api 行）；unlock.reject/ai.validate（既有行）。
 */
const items = require('./core/items.js');
const ast = require('./ai/ast.js');

// 规范骨架（GET /api/v1/loadout）
const EMPTY_LOADOUT = { role: null, skills: [null, null, null], ai: null };

// 仓库内按 uid 找物品（与 items.findItem 同语义；L6 侧内联，避免导出依赖）
function findItem(wh, uid) {
  const buckets = (wh && wh.buckets) || {};
  for (const list of Object.values(buckets)) {
    if (!Array.isArray(list)) continue;
    const it = list.find((x) => x && x.uid === uid);
    if (it) return it;
  }
  return null;
}

// 校验（I-12a/b/d/e + T-PB-9）：{ok, errors:[{where, code, message}]}
function validateLoadout(loadout, opts) {
  const tier = (opts && opts.tier) || 'mythic';
  const wh = (opts && opts.warehouse) || null;
  const ld = loadout || {};
  const errors = [];
  if (!ld.role || typeof ld.role !== 'object') errors.push({ where: 'role', code: 'loadout_invalid', message: '缺少角色物品' });
  else if (ld.role.kind !== 'role') errors.push({ where: 'role', code: 'loadout_invalid', message: '角色位置必须是角色物品' });
  const skills = Array.isArray(ld.skills) ? ld.skills : null;
  if (!skills || skills.length !== 3) errors.push({ where: 'skills', code: 'loadout_invalid', message: `技能必须恰 3 个（实际 ${skills ? skills.length : 0}）` });
  else {
    skills.forEach((s, i) => {
      if (!s || typeof s !== 'object') errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: `技能位置缺失: ${i}` });
      else if (s.kind !== 'skill') errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: '技能位置必须是技能物品' });
    });
  }
  if (!ld.ai || typeof ld.ai !== 'object') errors.push({ where: 'ai', code: 'loadout_invalid', message: '缺少 AI 程序' });
  // 引用完整性（T-PB-9/I-12d + T-PB-8 双引用防御）：装配引用必须存在于仓库、equipped=true、且同一插件不得被双处引用。
  // 存在装配引用但无 warehouse → missing_warehouse（P1-3：引用校验不得空转）。
  const refs = [];
  if (ld.role && Array.isArray(ld.role.slots)) {
    ld.role.slots.forEach((s, i) => { if (s && s.pluginUid) refs.push({ where: `role.slots[${i}]`, uid: s.pluginUid }); });
  }
  (skills || []).forEach((sk, j) => {
    if (sk && Array.isArray(sk.slots)) sk.slots.forEach((s, i) => { if (s && s.pluginUid) refs.push({ where: `skills[${j}].slots[${i}]`, uid: s.pluginUid }); });
  });
  if (refs.length > 0 && !wh) {
    errors.push({ where: 'warehouse', code: 'missing_warehouse', message: '出战配置含装配引用，需要 warehouse 校验引用完整性（T-PB-9）' });
  } else if (wh && errors.length === 0 && refs.length > 0) {
    const seen = new Set();
    for (const ref of refs) {
      if (seen.has(ref.uid)) {
        errors.push({ where: ref.where, code: 'loadout_invalid', message: `同一插件被双处引用: ${ref.uid}（T-PB-8）` });
        continue;
      }
      seen.add(ref.uid);
      const p = findItem(wh, ref.uid);
      if (!p) errors.push({ where: ref.where, code: 'loadout_invalid', message: `悬挂引用 ${ref.uid}` });
      else if (p.equipped !== true) errors.push({ where: ref.where, code: 'loadout_invalid', message: `插件未装配: ${ref.uid}` });
      else if (!items.validateUnlock(p, tier)) errors.push({ where: ref.where, code: 'loadout_invalid', message: `插件 ${ref.uid} 需 ${p.unlockTier} 段位（P2-2 复核）` });
    }
  }
  // 段位门控（I-12e）：物品级（unlockTier ≤ tier）+ AI 节点（ast.validate 含门控）
  if (errors.length === 0) {
    const members = [ld.role].concat(skills).filter(Boolean);
    for (const m of members) {
      if (!items.validateUnlock(m, tier)) {
        errors.push({ where: m.kind === 'role' ? 'role' : 'skills', code: 'loadout_invalid', message: `物品 ${m.templateId} 需 ${m.unlockTier} 段位` });
      }
    }
    const aiV = ast.validate(ld.ai, tier);
    if (!aiV.ok) {
      for (const e of aiV.errors.slice(0, 5)) errors.push({ where: `ai:${e.path}`, code: 'loadout_invalid', message: `${e.code}: ${e.message}` });
      if (aiV.errors.length > 5) errors.push({ where: 'ai', code: 'loadout_invalid', message: `其余 ${aiV.errors.length - 5} 条 AI 错误已截断（P2-3 标记）` });
    }
  }
  return { ok: errors.length === 0, errors };
}

// 最终面板（B19 基础聚合）：角色五维/regen/special（applyAffixes 已装插件词条）+ 技能参数直透（消耗补偿 B20）
function buildPanel(loadout, opts) {
  const v = validateLoadout(loadout, opts);
  if (!v.ok) return { ok: false, errors: v.errors };
  const wh = (opts && opts.warehouse) || null;
  const role = loadout.role;
  const rAffixes = [];
  for (const s of role.slots || []) {
    if (!s || !s.pluginUid) continue;
    const p = findItem(wh, s.pluginUid);
    if (p && Array.isArray(p.affixes)) rAffixes.push(...p.affixes);
  }
  const aff = items.applyAffixes(Object.assign({}, role.stats || {}), rAffixes);
  return {
    ok: true,
    panel: {
      role: {
        stats: aff.stats,
        special: aff.special || {},
        regen: Object.assign({ mp: 0, sp: 0 }, role.regen || {}),
        pluginPoints: role.pluginPoints === undefined ? null : role.pluginPoints,
        quality: role.quality === undefined ? null : role.quality,
      },
      skills: loadout.skills.map((sk) => ({ templateId: sk.templateId, uid: sk.uid, params: sk.params || {} })),
    },
  };
}

module.exports = { EMPTY_LOADOUT, validateLoadout, buildPanel, findItem };