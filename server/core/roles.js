'use strict';
/* server/core/roles.js —— 角色系统（P1 B5，契约 docs/interfaces.md §1）
 * 依据：systems/02-roles.md；examples/02-roles.md R-1..R-8（数值期望唯一出处）；decisions D-45/D-46/D-110。
 * 纯函数内核（L11）：随机走注入 rng；无 IO / 无 console；日志经 withLogger 注入。
 * 事件：role.instantiate(debug) / role.panel(debug)（§4.6）。
 * 语义（B5 登记 + 2026-09-16 合并）：
 *   - instantiateRole：基础值 → 类型修饰 → 品质系数 → 取整（R-3 顺序冻结）；消耗顺序 =
 *     修饰随机 ints → 5×品质系数 float → slotCount int → 每槽类型 float（测试 stubSeq 依赖此顺序）。
 *   - applyTypeModifier：委托 items.applyTypeModifier（**单一实现**；开箱生成同用一份，见 items.generateRoleItem）。
 *   - equipPlugins：只做"校验 + 登记"（不改 stats、**不改 regen**）；失败原子（返回 {ok:false, role:undefined}）。
 *   - getFinalStats：调用 items.buildRolePanel（**单一聚合实现**，与 loadout.buildPanel 同源）——
 *     每次从原始五维 + 已装词条幂等重算面板，regen 只在此处叠加一次（消除与 buildPanel 的双写）。
 */
const { nullLogger } = require('../../shared/log.js');
const items = require('./items.js'); // validateUnlock/rollSlotCount/applyAffixes/buildRolePanel（B3；UL-7 已证与 unlock 口径一致）

const FLAT_STATS = require('../data/affix-registry.json').stats; // 五维口径单一来源（词条注册表）
const QUALITIES = require('../data/qualities.json').qualities;
const qMap = Object.fromEntries(QUALITIES.map((q) => [q.id, q]));

// itemsApi：items.js 实例（缺省 = 模块单例）。段位门控开关（unlock.json `gating.enabled`，用户决策
//   2026-09-16：默认关闭、段位不参与判定）由 items 实例承载——本工厂保留注入缝，
//   便于用 `roles.withGating(true)` 复核"门控开启 = 旧行为"（与 core/items.js、core/unlock.js 同一模式）。
function makeRoles(logger, itemsApi) {
  const L = logger || nullLogger;
  const I = itemsApi || items;

  // 类型修饰（R-2/R-3）：单一实现移至 items.applyTypeModifier（开箱与实例化共用；顺序冻结）。
  const applyTypeModifier = items.applyTypeModifier;

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
    const slotCount = I.rollSlotCount('role', qualityId, rng);
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
  // 形状容错（2026-09-16 合并）：角色对象可以是运行时角色（instantiateRole 产物）或角色物品
  //   （warehouse/openBox 产物）。缺 equipped/slots/pluginPoints 时按缺省处理并给出**明确错误码**，
  //   不再抛 TypeError（此前 `role.equipped.map` 对角色物品直接崩）。
  function equipPlugins(role, plugins, options) {
    const opts = options || {};
    const tier = opts.tier || 'mythic';
    if (!role || typeof role !== 'object') return { ok: false, error: 'role_invalid' };
    const candidate = Array.isArray(plugins) ? plugins : [];
    const slots = Array.isArray(role.slots) ? role.slots : [];
    const equipped = Array.isArray(role.equipped) ? role.equipped : [];
    // 点数预算：未声明 pluginPoints → 0（任何正点数插件都会被 points_exceeded 明确拒绝）
    const budget = Number.isFinite(role.pluginPoints) ? role.pluginPoints : 0;
    // 先全量校验
    const consumed = new Set(equipped.map((e) => pluginUidOf(e)).filter(Boolean));
    const usedSlots = new Set(equipped.map((e) => e && e.slotIndex));
    let spent = equipped.reduce((a, e) => a + pluginCostOf(e), 0);
    const plan = [];
    for (const p of candidate) {
      if (!p || p.kind !== 'rolePlugin') return { ok: false, error: 'kind_mismatch' };
      const uid = p.uid || p.id;
      const cost = Number.isFinite(p.pointCost) ? p.pointCost : 0;
      if (consumed.has(uid) || p.equipped === true) return { ok: false, error: 'already_equipped' }; // R-7d
      if (!I.validateUnlock(p, tier)) return { ok: false, error: 'tier_locked' }; // R-7c（items.validateUnlock 同 unlock 口径；门控关闭时恒放行）
      const slotIdx = slots.findIndex((s, i) => s.type === p.slot && s.pluginUid === null && !usedSlots.has(i));
      if (slotIdx === -1) return { ok: false, error: 'slot_type_mismatch' }; // R-7a（含无空槽）
      if (spent + cost > budget) return { ok: false, error: 'points_exceeded' }; // R-7b
      plan.push({ p, slotIdx });
      spent += cost;
      consumed.add(uid);
      usedSlots.add(slotIdx);
    }
    // 全部通过 → 登记（**不改 stats、不写 regen**；面板由 getFinalStats / buildPanel 幂等重算，
    //   两处共用 items.buildRolePanel —— regen 只在那一次叠加，杜绝双计）
    const next = {
      ...role,
      slots: slots.map((s, i) => {
        const hit = plan.find((x) => x.slotIdx === i);
        return hit ? { ...s, pluginUid: hit.p.uid || hit.p.id } : s;
      }),
      equipped: [...equipped, ...plan.map((x) => ({ slotIndex: x.slotIdx, plugin: x.p }))],
    };
    return { ok: true, role: next };
  }

  // equipped 条目读取（形状容错：缺失字段按缺省，不抛）
  function pluginUidOf(entry) {
    const p = entry && (entry.plugin || entry);
    return p ? (p.uid || p.id || null) : null;
  }

  function pluginCostOf(entry) {
    const p = entry && entry.plugin;
    return p && Number.isFinite(p.pointCost) ? p.pointCost : 0;
  }

  // 已装插件解析（形状容错）：运行时角色 → equipped[]；角色物品形态 → slots[].pluginUid + role.plugins 索引
  function equippedPlugins(role) {
    const r = role || {};
    if (Array.isArray(r.equipped)) return r.equipped.map((e) => (e && (e.plugin || e)) || null).filter(Boolean);
    const pool = new Map();
    for (const p of (Array.isArray(r.plugins) ? r.plugins : [])) if (p) pool.set(p.uid || p.id, p);
    const out = [];
    for (const s of (Array.isArray(r.slots) ? r.slots : [])) {
      if (s && s.pluginUid && pool.has(s.pluginUid)) out.push(pool.get(s.pluginUid));
    }
    return out;
  }

  // 最终面板（R-8）：单一聚合实现 items.buildRolePanel（= loadout.buildPanel 同源）；
  //   plugins 可显式传入（第二参），缺省按角色形状解析。
  function getFinalStats(role, plugins) {
    const r = role || {};
    const panel = items.buildRolePanel(r, plugins === undefined ? equippedPlugins(r) : plugins);
    L.debug('roles', 'role.panel', `panel ${r.templateId}`, { templateId: r.templateId, stats: panel.stats });
    return panel;
  }

  return {
    instantiateRole, applyTypeModifier, equipPlugins, getFinalStats,
    // 实例自省：当前门控是否参与判定（与 items 实例同源；测试/文档断言用）
    gatingEnabled: I.gatingEnabled,
    // 实例级工厂（链式 withGating(true).withLogger(log) 不丢设置，与 core/items.js 同模式）
    withLogger: (lg) => makeRoles(lg, I),
    withGating: (g) => makeRoles(L, items.withGating(g)),
  };
}

module.exports = Object.assign(makeRoles(), {
  withLogger: (logger) => makeRoles(logger),
  withGating: (g) => makeRoles(undefined, items.withGating(g)),
});