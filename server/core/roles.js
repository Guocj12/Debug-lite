'use strict';
/* server/core/roles.js —— 角色系统（P1 B5，契约 docs/interfaces.md §1）
 * 依据：systems/02-roles.md；examples/02-roles.md R-1..R-8（数值期望唯一出处）；decisions D-45/D-46/D-110。
 * 纯函数内核（L11）：随机走注入 rng；无 IO / 无 console；日志经 withLogger 注入。
 * 事件：role.instantiate(debug) / role.panel(debug)（§4.6）。
 * 语义（B5 登记）：
 *   - instantiateRole：基础值 → 类型修饰 → 品质系数 → 取整（R-3 顺序冻结）；消耗顺序 =
 *     修饰随机 ints → 5×品质系数 float → slotCount int → 每槽类型 float（测试 stubSeq 依赖此顺序）。
 *   - equipPlugins：只做"校验 + 登记"（不改 stats）；失败原子（返回 {ok:false, role:undefined}）。
 *   - getFinalStats：每次从原始五维 + 已装词条**幂等重算**面板（多次调用结果一致）。
 */
const { nullLogger } = require('../../shared/log.js');
const items = require('./items.js'); // validateUnlock/rollSlotCount/applyAffixes（B3；UL-7 已证与 unlock 口径一致）

const FLAT_STATS = ['hp', 'atk', 'def', 'sp', 'mp'];
const QUALITIES = require('../data/qualities.json').qualities;
const qMap = Object.fromEntries(QUALITIES.map((q) => [q.id, q]));
// 类型修饰系数（L9：数值在表，role-templates.json typeModifiers；schema T-DC-1 冻结校验）
const TYPE_MODIFIERS = require('../data/role-templates.json').typeModifiers;

function makeRoles(logger) {
  const L = logger || nullLogger;

  // 类型修饰（R-2/R-3）：只作用于基础值，返回修饰后五维（浮点）
  function applyTypeModifier(template, rng) {
    const base = template.baseStats;
    const stats = { hp: base.hp, atk: base.atk, def: base.def, sp: base.sp, mp: base.mp };
    if (template.type === 'specialized') {
      stats[template.highStat] = base[template.highStat] * TYPE_MODIFIERS.specialized.high;
      const others = FLAT_STATS.filter((k) => k !== template.highStat);
      const lowIdx = rng.int(0, others.length - 1);
      stats[others[lowIdx]] = base[others[lowIdx]] * TYPE_MODIFIERS.specialized.low;
    } else if (template.type === 'expert') {
      stats[template.highStat] = base[template.highStat] * TYPE_MODIFIERS.expert.high;
      const others = FLAT_STATS.filter((k) => k !== template.highStat);
      const spread = [...TYPE_MODIFIERS.expert.spread];
      // Fisher–Yates（消耗 3 个 int：i=3→int(0,3)、i=2→int(0,2)、i=1→int(0,1)）
      for (let i = spread.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        const tmp = spread[i];
        spread[i] = spread[j];
        spread[j] = tmp;
      }
      others.forEach((k, idx) => {
        stats[k] = base[k] * spread[idx];
      });
    }
    return stats;
  }

  // 实例化（R-1..R-4；T-RO-7 regen 由模板必填字段直入）
  function instantiateRole(template, qualityId, rng) {
    const q = qMap[qualityId];
    if (!q) throw new RangeError(`未知品质 ${qualityId}`);
    const modified = applyTypeModifier(template, rng);
    const stats = {};
    for (const k of FLAT_STATS) {
      const v = Math.round(modified[k] * rng.float(q.statRange[0], q.statRange[1]));
      stats[k] = v < 1 ? 1 : v;
    }
    const slotCount = items.rollSlotCount('role', qualityId, rng);
    const slots = [];
    const totalWeight = Object.values(template.slotWeights).reduce((a, b) => a + b, 0);
    while (slots.length < slotCount) {
      let r = rng.float(0, 1) * totalWeight;
      let chosen = 'special';
      for (const [type, w] of Object.entries(template.slotWeights)) {
        r -= w;
        if (r < 0) { chosen = type; break; }
      }
      slots.push({ type: chosen, pluginUid: null });
    }
    const role = {
      charId: `char_${template.id}_${qualityId}`,
      templateId: template.id, name: template.name, type: template.type, quality: qualityId,
      stats, regen: { mp: template.regen.mp, sp: template.regen.sp },
      special: {}, slots, pluginPoints: q.pluginPoints, equipped: [],
    };
    L.debug('roles', 'role.instantiate', `role ${template.id} ${qualityId}`, { templateId: template.id, quality: qualityId });
    return role;
  }

  // 装配校验 + 登记（R-7 全分支；原子性：任一失败不产出新实例）
  function equipPlugins(role, plugins, options) {
    const opts = options || {};
    const tier = opts.tier || 'mythic';
    const candidate = plugins || [];
    // 先全量校验
    const consumed = new Set(role.equipped.map((e) => e.plugin.uid || e.plugin.id));
    const usedSlots = new Set(role.equipped.map((e) => e.slotIndex));
    let spent = role.equipped.reduce((a, e) => a + e.plugin.pointCost, 0);
    const plan = [];
    for (const p of candidate) {
      if (p.kind !== 'rolePlugin') return { ok: false, error: 'kind_mismatch' };
      const uid = p.uid || p.id;
      if (consumed.has(uid) || p.equipped === true) return { ok: false, error: 'already_equipped' }; // R-7d
      if (!items.validateUnlock(p, tier)) return { ok: false, error: 'tier_locked' }; // R-7c（items.validateUnlock 同 unlock 口径）
      const slotIdx = role.slots.findIndex((s, i) => s.type === p.slot && s.pluginUid === null && !usedSlots.has(i));
      if (slotIdx === -1) return { ok: false, error: 'slot_type_mismatch' }; // R-7a（含无空槽）
      if (spent + p.pointCost > role.pluginPoints) return { ok: false, error: 'points_exceeded' }; // R-7b
      plan.push({ p, slotIdx });
      spent += p.pointCost;
      consumed.add(uid);
      usedSlots.add(slotIdx);
    }
    // 全部通过 → 登记（不改 stats；面板由 getFinalStats 幂等重算）
    const next = {
      ...role,
      slots: role.slots.map((s, i) => {
        const hit = plan.find((x) => x.slotIdx === i);
        return hit ? { ...s, pluginUid: hit.p.uid || hit.p.id } : s;
      }),
      equipped: [...role.equipped, ...plan.map((x) => ({ slotIndex: x.slotIdx, plugin: x.p }))],
    };
    // regen 词条叠加（R-4b/c）
    for (const { p } of plan) {
      for (const a of p.affixes || []) {
        if (a.id === 'mp_regen') next.regen = { ...next.regen, mp: next.regen.mp + a.params.v };
        if (a.id === 'sp_regen') next.regen = { ...next.regen, sp: next.regen.sp + a.params.v };
        if (a.id === 'hp_regen') next.regen = { ...next.regen, hp: (next.regen.hp || 0) + a.params.v };
      }
    }
    return { ok: true, role: next };
  }

  // 最终面板（R-8）：五维聚合（D-45 顺序）+ special 概率封顶（D-46）+ max*
  function getFinalStats(role) {
    const affixes = role.equipped.flatMap((e) => e.plugin.affixes || []);
    const aggr = items.applyAffixes(role.stats, affixes);
    const panel = {
      stats: aggr.stats,
      regen: { ...role.regen },
      special: aggr.special,
      maxHp: aggr.stats.hp, maxMp: aggr.stats.mp, maxSp: aggr.stats.sp,
    };
    L.debug('roles', 'role.panel', `panel ${role.templateId}`, { templateId: role.templateId, stats: panel.stats });
    return panel;
  }

  return { instantiateRole, applyTypeModifier, equipPlugins, getFinalStats };
}

module.exports = Object.assign(makeRoles(), { withLogger: (logger) => makeRoles(logger) });