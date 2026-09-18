'use strict';
/* server/loadout.js —— 出战配置校验与最终面板（P3 B19；契约 docs/interfaces.md §2 /api/v1/loadout + /api/v1/panel）
 * L6 组合：结构（I-12a/b：角色 1 + 技能恰 3 + AI 合法）+ 引用完整性（T-PB-9/I-12d）+ 段位门控
 * （I-12e：物品级 items.validateUnlock + AI 节点 ast.validate(tier)）+ 面板聚合（五维/regen/special/技能参数）。
 * D-123：不持久化——POST 校验后回带；GET 返回规范骨架。事件：api.*（api 行）；unlock.reject/ai.validate（既有行）。
 */
const items = require('./core/items.js');
const skills = require('./core/skills.js'); // B20：技能插件词条聚合（消耗补偿/减耗/倍率冷却，L2 → L6 合法）
const ast = require('./ai/ast.js');
// 词条注册表（regen 等词条去向的唯一来源；L6 → 数据层合法）
const AFFIX_REGISTRY = require('./data/affix-registry.json');

// 技能实例化基准 rng（面板聚合只需确定性基=1；物品参数随后覆盖）
const STUB_RNG = { float: () => 1, int: () => 0, pick: () => 0 };

// 数据表存在性索引（P1-1 修复：聚合路径不得对客户端注入的未知模板/品质崩溃）
const ROLE_IDS = new Set(require('./data/role-templates.json').roleTemplates.map((r) => r.id));
const SKILL_IDS = new Set(require('./data/skill-templates.json').skillTemplates.map((s) => s.id));
const QUALITY_IDS = new Set(require('./data/qualities.json').qualities.map((q) => q.id));

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
  else {
    if (!ROLE_IDS.has(ld.role.templateId)) errors.push({ where: 'role', code: 'loadout_invalid', message: `未知角色模板 ${ld.role.templateId}` });
    if (ld.role.quality !== undefined && ld.role.quality !== null && !QUALITY_IDS.has(ld.role.quality)) {
      errors.push({ where: 'role', code: 'loadout_invalid', message: `未知品质 ${ld.role.quality}` });
    }
  }
  const skills = Array.isArray(ld.skills) ? ld.skills : null;
  if (!skills || skills.length !== 3) errors.push({ where: 'skills', code: 'loadout_invalid', message: `技能必须恰 3 个（实际 ${skills ? skills.length : 0}）` });
  else {
    skills.forEach((s, i) => {
      if (!s || typeof s !== 'object') errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: `技能位置缺失: ${i}` });
      else if (s.kind !== 'skill') errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: '技能位置必须是技能物品' });
      else {
        if (!SKILL_IDS.has(s.templateId)) errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: `未知技能模板 ${s.templateId}` });
        if (s.quality !== undefined && s.quality !== null && !QUALITY_IDS.has(s.quality)) {
          errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: `未知品质 ${s.quality}` });
        }
      }
    });
  }
  if (!ld.ai || typeof ld.ai !== 'object') errors.push({ where: 'ai', code: 'loadout_invalid', message: '缺少 AI 程序' });
  // 引用完整性（T-PB-9/I-12d + T-PB-8 双引用防御）：装配引用必须存在于仓库、equipped=true、且同一插件不得被双处引用。
  // 存在装配引用但无 warehouse → missing_warehouse（P1-3：引用校验不得空转）。
  const refs = [];
  if (ld.role && Array.isArray(ld.role.slots)) {
    ld.role.slots.forEach((s, i) => { if (s && s.pluginUid) refs.push({ where: `role.slots[${i}]`, uid: s.pluginUid, kind: 'role' }); });
  }
  (skills || []).forEach((sk, j) => {
    if (sk && Array.isArray(sk.slots)) sk.slots.forEach((s, i) => { if (s && s.pluginUid) refs.push({ where: `skills[${j}].slots[${i}]`, uid: s.pluginUid, kind: 'skill' }); });
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
      else if (p.kind !== (ref.kind === 'role' ? 'rolePlugin' : 'skillPlugin')) errors.push({ where: ref.where, code: 'loadout_invalid', message: `插件类别与槽位不匹配: ${ref.uid}` });
      else if (ref.kind === 'skill' && (!Number.isInteger(p.tier) || p.tier < 1)) errors.push({ where: ref.where, code: 'loadout_invalid', message: `技能插件缺档位（tier 必须 ≥1）: ${ref.uid}` });
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
  // 角色插件 regen 词条叠加（R-4b/c）：目标维度由词条注册表 def.regen 声明（hp/sp/mp）
  const regen = Object.assign({ mp: 0, sp: 0 }, role.regen || {});
  for (const a of rAffixes) {
    const def = AFFIX_REGISTRY.affixes[a.id];
    if (def && def.regen) regen[def.regen] = (regen[def.regen] || 0) + ((a.params && a.params.v) || 0);
  }
  return {
    ok: true,
    panel: {
      role: {
        stats: aff.stats,
        special: aff.special || {},
        regen,
        pluginPoints: role.pluginPoints === undefined ? null : role.pluginPoints,
        quality: role.quality === undefined ? null : role.quality,
      },
      skills: loadout.skills.map((sk) => {
        // B20：技能插件词条聚合——消耗补偿（D-113：costDeltaBase×tier）/减耗 ceil（S-3）/倍率·冷却·射程等
        const plugins = [];
        for (const s of sk.slots || []) {
          if (!s || !s.pluginUid) continue;
          const p = findItem(wh, s.pluginUid);
          if (p) plugins.push(p);
        }
        let params = Object.assign({}, sk.params || {});
        if (plugins.length > 0) {
          const base = skills.instantiateSkill(sk.templateId, sk.quality || 'common', STUB_RNG);
          const applied = skills.applySkillPlugins(Object.assign({}, base, sk.params || {}), plugins);
          params = {};
          // 投影白名单：含 specials/castEffects/affixes——否则技能插件的
          //   crit_chance/lifesteal（概率类）、cast_buff（释放类）、stun/knockback/pull/dot/true_dmg（命中类）
          //   会在 API 路径（/battle → battle.js buildPlayer 的 Object.assign）被丢掉，导致"文档已设计但实际不生效"。
          for (const k of ['multiplier', 'cost', 'cooldown', 'bulletLevel', 'bulletCount', 'range', 'area', 'distance', 'passThroughEnemy', 'dealDamage', 'fullDodgeDuring', 'falloff', 'specials', 'castEffects', 'affixes']) {
            if (applied[k] !== undefined) params[k] = applied[k];
          }
          // P2-②：未列入白名单的自定义字段保留透传（聚合投影不丢非标准字段）
          for (const k of Object.keys(sk.params || {})) {
            if (params[k] === undefined) params[k] = sk.params[k];
          }
        }
        return { templateId: sk.templateId, uid: sk.uid, params };
      }),
    },
  };
}

module.exports = { EMPTY_LOADOUT, validateLoadout, buildPanel, findItem };