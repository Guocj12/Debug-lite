'use strict';
/* server/core/items.js —— 物品系统数值层（P1 B3，契约 docs/interfaces.md §1）
 * 依据：systems/01-items.md（流程）；examples/01-items.md I-1..I-12（数值期望）；examples/02-roles.md R-5/R-6（词条聚合）。
 * 纯函数内核（L11）：随机全部走注入 rng（core/rng.js）；无 IO / 无 console；日志经 withLogger 注入。
 * 事件：items.roll.quality(debug) / items.generate(debug) / items.affix.apply(trace)（§4.6）。
 * 数值来源：server/data/*.json（L9）。
 * 注意：本模块只做"数值/生成"；仓库/装配/loadout 属 L3（B18，同文件双分层）。
 */
const { nullLogger } = require('../../shared/log.js');
const { createRng } = require('./rng.js');

const QUALITIES = require('../data/qualities.json');
const ROLE_TEMPLATES = require('../data/role-templates.json').roleTemplates;
const SKILL_TEMPLATES = require('../data/skill-templates.json').skillTemplates;
const PLUGINS = require('../data/plugins.json').plugins;
const ITEMS_CONFIG = require('../data/items-config.json');

// 机制表（数据驱动）：词条语义 + 技能类型机制。代码只做解释，不按 id/类型写分支。
const REGISTRY = require('../data/affix-registry.json');
const MECHANICS = require('../data/skill-mechanics.json');
const AFFIXES = REGISTRY.affixes;
const FLAT_STATS = REGISTRY.stats;                  // 五维（面板聚合作用域）
const TIERS = QUALITIES.qualities.map((q) => q.id); // 段位序 = 品质表顺序（单一来源，勿另立字面量）
const STAT_PRECISION = MECHANICS.precision.stat;

// 已登记词条；未登记 = 配置错误（gate 会拦；运行期记 warn 并跳过，不静默失效）
function affixDef(id) {
  return Object.prototype.hasOwnProperty.call(AFFIXES, id) ? AFFIXES[id] : null;
}

let uidSeq = 0;
const qMap = Object.fromEntries(QUALITIES.qualities.map((q) => [q.id, q]));
const roleMap = Object.fromEntries(ROLE_TEMPLATES.map((r) => [r.id, r]));
const skillMap = Object.fromEntries(SKILL_TEMPLATES.map((s) => [s.id, s]));
const pluginList = PLUGINS.slice();

function makeItems(logger) {
  const L = logger || nullLogger;
  const rand = (rng, lo, hi) => (typeof rng.float === 'function' ? rng.float(lo, hi) : rng.float());

  function getQuality(qualityId) {
    const q = qMap[qualityId];
    if (!q) throw new RangeError(`未知品质 ${qualityId}`);
    return q;
  }

  // 品质抽取（I-1）：dropRates 加权；tier 提供时按 D-122/RK-5 截断品质池（段位序号即品质上限，B17 掉落池门控）
  // P1-1 修复（审查 docs/reviews/B17.md）：截断后按剩余池 dropRates **重归一**（acc/total），残量不再落入兜底；
  //   无 tier 时 pool=全池 total=1.0，与 B3 行为逐字节一致。
  function rollQuality(rng, tier) {
    const rates = ITEMS_CONFIG.dropRates;
    const capIdx = tier === undefined || !TIERS.includes(tier) ? TIERS.length - 1 : TIERS.indexOf(tier);
    const pool = TIERS.slice(0, capIdx + 1);
    const total = pool.reduce((a, t) => a + rates[t], 0);
    const v = rand(rng, 0, 1);
    let acc = 0;
    for (const t of pool) {
      acc += rates[t];
      if (v < acc / total) {
        L.debug('items', 'items.roll.quality', `quality=${t}${tier ? ` tier=${tier}` : ''}`, { quality: t, v, tier: tier || null });
        return t;
      }
    }
    const tail = pool[pool.length - 1];
    L.debug('items', 'items.roll.quality', `quality=${tail}（尾部兜底）`, { quality: tail, v });
    return tail;
  }

  // 插槽数（I-3）：闭区间均匀 + 下限 1（上限防御 v=1 越界，P2-1）
  function rollSlotCount(kind, qualityId, rng) {
    const q = getQuality(qualityId);
    let range;
    if (kind === 'role') range = q.roleSlotRange;
    else if (kind === 'skill') range = q.skillSlotRange;
    else throw new RangeError(`未知物品类别 ${kind}`);
    const v = rand(rng, 0, 1);
    let n = range[0] + Math.floor(v * (range[1] - range[0] + 1));
    if (n < 1) n = 1; // 技能 common [0,1] → 下限 1（I-3c）
    if (n > range[1]) n = range[1]; // v=1 防御（rng 产出 [0,1) 不到；stub 可触发）
    return n;
  }

  // 档位（I-5）：U(statRange) 落在 tiers 三段中哪段（1/2/3）
  function tierOfValue(coeff, q) {
    for (let i = 0; i < q.tiers.length; i++) {
      if (coeff <= q.tiers[i][1]) return i + 1;
    }
    return q.tiers.length; // 超出最后一段（防御兜底；stub 越界输入可达）
  }

  function tierOf(rng, quality) {
    const q = typeof quality === 'string' ? getQuality(quality) : quality;
    return tierOfValue(rand(rng, q.statRange[0], q.statRange[1]), q);
  }

  // 保留 precision.stat 位小数（精度来自 skill-mechanics.json；非战斗数值）
  function round2(x) {
    const scale = Math.pow(10, STAT_PRECISION);
    return Math.round(x * scale) / scale;
  }

  // 生成角色物品（I-2/I-4；T-RO-7：物品携带模板 regen）
  function generateRoleItem(template, qualityId, rng) {
    const q = getQuality(qualityId);
    const t = typeof template === 'string' ? roleMap[template] : template;
    const stats = {};
    for (const k of FLAT_STATS) {
      const v = Math.round(t.baseStats[k] * rand(rng, q.statRange[0], q.statRange[1]));
      stats[k] = v < 1 ? 1 : v;
    }
    const slotCount = rollSlotCount('role', qualityId, rng);
    const slots = [];
    const totalWeight = Object.values(t.slotWeights).reduce((a, b) => a + b, 0);
    while (slots.length < slotCount) {
      let r = rand(rng, 0, 1) * totalWeight;
      let chosen = null;
      for (const [type, w] of Object.entries(t.slotWeights)) {
        r -= w;
        if (r < 0) { chosen = type; break; }
      }
      slots.push({ type: chosen || 'special', pluginUid: null });
    }
    const item = {
      uid: `item_${uidSeq++}`, kind: 'role', templateId: t.id, name: t.name, quality: qualityId,
      slotCount, slots, stats, regen: { mp: t.regen.mp, sp: t.regen.sp },
      unlockTier: t.unlockTier, pluginPoints: q.pluginPoints,
    };
    L.debug('items', 'items.generate', `role ${t.id} ${qualityId}`, { kind: 'role', templateId: t.id, quality: qualityId });
    return item;
  }

  // 生成技能物品（S-1）：参数滚动方式全部来自 skill-mechanics.json（types[t.type].params）
  //   pair    = 数值对原样拷贝（melee.range / vertical.area）
  //   intMin  = ×品质系数后取整，下限取 bounds.min<字段>
  //   copy    = 标量/布尔原样拷贝（displacement 的 pass/dealDamage/fullDodgeDuring）
  function generateSkillItem(template, qualityId, rng) {
    const q = getQuality(qualityId);
    const t = typeof template === 'string' ? skillMap[template] : template;
    const mech = MECHANICS.types[t.type];
    if (!mech) throw new RangeError(`未登记技能类型 ${t.type}（skill-mechanics.json）`);
    const k = rand(rng, q.statRange[0], q.statRange[1]);
    const cost = {};
    for (const dim of MECHANICS.costDims) cost[dim] = t.baseCost[dim];
    const params = {
      multiplier: round2(t.baseMultiplier * k),
      cost,
      cooldown: Math.max(MECHANICS.bounds.minCooldown, Math.round(t.cooldown * k)),
      bulletLevel: t.bulletLevel,
    };
    for (const [field, mode] of Object.entries(mech.params)) {
      if (mode === 'pair') {
        params[field] = [t[field][0], t[field][1]];
      } else if (mode === 'intMin') {
        const boundKey = `min${field.charAt(0).toUpperCase()}${field.slice(1)}`;
        const min = MECHANICS.bounds[boundKey] === undefined ? 1 : MECHANICS.bounds[boundKey];
        params[field] = Math.max(min, Math.round(t[field] * k));
      } else {
        params[field] = t[field];
      }
    }
    params.falloff = t.falloff;
    const slotCount = rollSlotCount('skill', qualityId, rng);
    const slots = [];
    const totalWeight = Object.values(t.slotWeights).reduce((a, b) => a + b, 0);
    while (slots.length < slotCount) {
      let r = rand(rng, 0, 1) * totalWeight;
      let chosen = null;
      for (const [type, w] of Object.entries(t.slotWeights)) {
        r -= w;
        if (r < 0) { chosen = type; break; }
      }
      slots.push({ type: chosen || Object.keys(t.slotWeights)[0], pluginUid: null });
    }
    const item = {
      uid: `item_${uidSeq++}`, kind: 'skill', templateId: t.id, name: t.name, quality: qualityId,
      slotCount, slots, params, unlockTier: t.unlockTier,
    };
    L.debug('items', 'items.generate', `skill ${t.id} ${qualityId}`, { kind: 'skill', templateId: t.id, quality: qualityId });
    return item;
  }

  // 生成插件（I-5/I-6）：词条 = 基础值 × U(档位区间系数)；角色 pointCost=tier
  // poolOverride：openBox 门控池（I-7a/b）；缺省全量池
  function generatePlugin(kind, qualityId, rng, poolOverride) {
    const q = getQuality(qualityId);
    const pool = (poolOverride || pluginList).filter((p) => p.kind === kind);
    if (pool.length === 0) throw new RangeError(`插件池为空: ${kind}`);
    const def = rng.pick(pool);
    const coeff = rand(rng, q.statRange[0], q.statRange[1]);
    const tier = tierOfValue(coeff, q);
    // 词条入包：滚动方式取自词条注册表 roll（int = 即时取整 I-6b；stat = 保留 precision.stat 位 I-6a）
    const affixes = def.affixes.map((a) => {
      const reg = affixDef(a.id);
      if (!reg) L.warn('items', 'items.affix.unknown', `未登记词条 ${a.id}（affix-registry.json）`, { affixId: a.id });
      const rounded = (reg && reg.roll === 'int') ? Math.round(a.params.v * coeff) : round2(a.params.v * coeff);
      return { id: a.id, desc: a.desc, params: { ...a.params, v: rounded } };
    });
    const plugin = {
      uid: `item_${uidSeq++}`, kind, id: def.id, name: def.name, desc: def.desc,
      slot: def.slot, category: def.category, quality: qualityId,
      tier, affixes, unlockTier: def.unlockTier,
    };
    if (kind === 'rolePlugin') plugin.pointCost = tier;
    if (kind === 'skillPlugin') plugin.costDeltaByTier = def.costDeltaByTier === null ? null : def.costDeltaByTier;
    L.debug('items', 'items.generate', `plugin ${def.id} ${qualityId} tier ${tier}`, { kind, pluginId: def.id, quality: qualityId, tier });
    return plugin;
  }

  // 开箱（I-7）：品质（tier 截断，D-122）→ 类别 → 生成；tier 门控池过滤（I-9/validateUnlock）
  function openBox(rng, options) {
    const opts = options || {};
    const tier = opts.tier || 'mythic';
    const quality = rollQuality(rng, opts.tier);
    const kindWeights = ITEMS_CONFIG.kindWeights;
    const kinds = Object.keys(kindWeights);
    let acc = 0;
    let v = rand(rng, 0, 1) * Object.values(kindWeights).reduce((a, b) => a + b, 0);
    let kind = null;
    for (const k of kinds) {
      acc += kindWeights[k];
      if (v < acc) { kind = k; break; }
    }
    if (kind === null) kind = kinds[kinds.length - 1]; // v=1 防御路径
    if (kind === 'role') {
      const pool = ROLE_TEMPLATES.filter((x) => validateUnlock(x, tier));
      if (pool.length === 0) throw new RangeError('该段位无可用角色模板');
      return generateRoleItem(rng.pick(pool), quality, rng);
    }
    if (kind === 'skill') {
      const pool = SKILL_TEMPLATES.filter((x) => validateUnlock(x, tier));
      if (pool.length === 0) throw new RangeError('该段位无可用技能模板');
      return generateSkillItem(rng.pick(pool), quality, rng);
    }
    const pool = pluginList.filter((x) => x.kind === kind && validateUnlock(x, tier));
    if (pool.length === 0) throw new RangeError(`该段位无可用插件: ${kind}`);
    return generatePlugin(kind, quality, rng, pool);
  }

  // 词条聚合（D-45/D-46，I-8/R-5/R-6）：base × (1+Σpct) + Σflat → 一次取整；概率类累加封顶 caps.probability
  // 词条去向全部由 affix-registry.json 声明：agg（面板）、special（概率）、regen（roles 层叠加）、
  // skillOp/hitEffect/castEffect（技能链，由 skills/engine 消费）。代码不按 id 写分支。
  function applyAffixes(baseStats, affixes) {
    const stats = { ...baseStats };
    const pct = {};
    const flat = {};
    const special = {};
    for (const a of affixes || []) {
      const def = affixDef(a.id);
      const v = a.params ? a.params.v : 0;
      if (!def) {
        L.warn('items', 'items.affix.unknown', `未登记词条 ${a.id}（affix-registry.json）`, { affixId: a.id });
        continue;
      }
      if (def.agg) {
        if (def.agg.mode === 'pct') pct[def.agg.target] = (pct[def.agg.target] || 0) + v;
        else flat[def.agg.target] = (flat[def.agg.target] || 0) + v;
      } else if (def.special) {
        special[def.special] = Math.min(REGISTRY.caps.probability, (special[def.special] || 0) + v);
      }
      // regen 词条（def.regen）由 roles 层叠加；技能词条（def.skillOp/hitEffect/castEffect）由技能链读取
    }
    for (const stat of FLAT_STATS) {
      let base = stats[stat] === undefined ? 0 : stats[stat];
      const pctSum = pct[stat] || 0;
      const flatV = flat[stat] || 0;
      let result = Math.round(base * (1 + pctSum) + flatV);
      if (result < 1) result = 1; // I-8f 数值下限 1
      stats[stat] = result;
    }
    L.trace('items', 'items.affix.apply', `affixes=${affixes ? affixes.length : 0}`, { count: affixes ? affixes.length : 0, stats, special });
    return { stats, special };
  }

  // 段位门控（I-9；D-112 缺省已解锁）
  function validateUnlock(item, tier) {
    if (item.unlockTier === undefined || item.unlockTier === null) return true;
    const a = TIERS.indexOf(item.unlockTier);
    const b = TIERS.indexOf(tier);
    if (a === -1 || b === -1) return false;
    return a <= b;
  }

  // ===== L3：仓库与装配（B18；同文件双分层——纯函数，输入仓库不变，成功返回新仓库）=====

  // 仓库规范骨架（分桶键；GET /api/v1/warehouse 返回）
  function emptyWarehouse() {
    return { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
  }

  function cloneWarehouse(wh) {
    try {
      return wh ? JSON.parse(JSON.stringify(wh)) : emptyWarehouse();
    } catch (e) {
      return emptyWarehouse();
    }
  }

  // 仓库内按 uid 找物品（全桶扫描；桶值非数组 → 跳过，P1-2 防御）
  function findItem(wh, uid) {
    const buckets = (wh && wh.buckets) || {};
    for (const list of Object.values(buckets)) {
      if (!Array.isArray(list)) continue;
      const it = list.find((x) => x && x.uid === uid);
      if (it) return it;
    }
    return null;
  }

  // 拒绝出口（P2-2 日志管线）：所有装配/拆卸拒绝统一记 items.reject(warn)（§4.6 冻结）
  function rejectOut(code, message) {
    L.warn('items', 'items.reject', `${code}: ${message}`, { code, message });
    return { ok: false, code, message };
  }

  // 装配（I-10 全案 + T-PB-8 唯一性）：四道校验任失败 → {ok:false, code, message}（状态完全不变）；
  // 成功 → {ok:true, warehouse}（新仓库，入参不变）。点数仅角色目标（I-10d）。
  function assemble(wh, req) {
    const w = cloneWarehouse(wh || emptyWarehouse());
    const targetUid = req && req.targetUid;
    const pluginUid = req && req.pluginUid;
    const slotIndex = req && req.slotIndex;
    const tier = (req && req.tier) || 'mythic'; // 装配门控缺省宽松（显式 tier 才收紧；与 core openBox 缺省一致）
    const target = findItem(w, targetUid);
    const plugin = findItem(w, pluginUid);
    if (!target) return rejectOut('item_missing', `目标物品不存在: ${targetUid}`);
    if (!plugin) return rejectOut('item_missing', `插件不存在: ${pluginUid}`);
    // ① 目标必须是模板物品（角色/技能）；把插件当目标 → slot_type_mismatch（P1-1 第三态）
    if (target.kind !== 'role' && target.kind !== 'skill') return rejectOut('slot_type_mismatch', '目标必须是角色/技能物品');
    // ② 类别匹配（I-10a）
    if (target.kind === 'role' && plugin.kind !== 'rolePlugin') return rejectOut('slot_type_mismatch', '角色目标只能装角色插件');
    if (target.kind === 'skill' && plugin.kind !== 'skillPlugin') return rejectOut('slot_type_mismatch', '技能目标只能装技能插件');
    // ③ 插槽存在且类型匹配（I-10b；越界/非数字/slots 缺失 → 槽位不可用，P1-1 防御）
    const slots = Array.isArray(target.slots) ? target.slots : null;
    const slot = slots && Number.isInteger(slotIndex) && slotIndex >= 0 ? slots[slotIndex] : null;
    if (!slot) return rejectOut('slot_type_mismatch', `槽位不可用: ${slotIndex}`);
    if (plugin.slot !== slot.type) return rejectOut('slot_type_mismatch', `插件槽 ${plugin.slot} ≠ 插槽 ${slot.type}`);
    // ④ 段位门控（I-10c）：插件与目标均须 ≤ tier
    if (!validateUnlock(plugin, tier) || !validateUnlock(target, tier)) return rejectOut('tier_locked', '物品解锁段位高于玩家段位');
    // ⑤ 点数预算（I-10d，仅角色目标）
    if (target.kind === 'role') {
      const used = slots.reduce((sum, s) => {
        if (!s.pluginUid) return sum;
        const p = findItem(w, s.pluginUid);
        return sum + (p && Number.isFinite(p.pointCost) ? p.pointCost : 0);
      }, 0);
      if (used + (plugin.pointCost || 0) > (target.pluginPoints || 0)) {
        return rejectOut('points_exceeded', `点数超限: ${used}+${plugin.pointCost} > ${target.pluginPoints}`);
      }
    }
    // ⑥ 空槽（I-10e）与 ⑦ 唯一性（T-PB-8：同一插件不可同时装两处）
    if (slot.pluginUid !== null && slot.pluginUid !== undefined) return rejectOut('slot_occupied', `槽位已被占用: ${slot.pluginUid}`);
    if (plugin.equipped === true) return rejectOut('plugin_equipped', `插件已装配别处: ${pluginUid}`);
    // 提交（在克隆上）
    target.slots[slotIndex].pluginUid = plugin.uid;
    plugin.equipped = true;
    L.info('items', 'items.assemble', `装 ${pluginUid} → ${targetUid}[${slotIndex}]`, { targetUid, slotIndex, pluginUid, tier });
    return { ok: true, warehouse: w };
  }

  // 拆卸（I-11 全案）：空槽 → slot_empty；悬挂引用（T-PB-9 防御）→ plugin_missing；成功清槽 + equipped=false
  function disassemble(wh, req) {
    const w = cloneWarehouse(wh || emptyWarehouse());
    const targetUid = req && req.targetUid;
    const slotIndex = req && req.slotIndex;
    const target = findItem(w, targetUid);
    if (!target) return rejectOut('plugin_missing', `目标物品不存在: ${targetUid}`);
    const slots = Array.isArray(target.slots) ? target.slots : null;
    const slot = slots && Number.isInteger(slotIndex) && slotIndex >= 0 ? slots[slotIndex] : null;
    if (!slot) return rejectOut('slot_empty', `槽位不可用: ${slotIndex}`);
    const pluginUid = slot.pluginUid;
    if (pluginUid === null || pluginUid === undefined) return rejectOut('slot_empty', `槽位为空: ${targetUid}[${slotIndex}]`);
    const plugin = findItem(w, pluginUid);
    if (!plugin) return rejectOut('plugin_missing', `装配引用的插件不在仓库: ${pluginUid}`);
    slot.pluginUid = null;
    plugin.equipped = false;
    L.info('items', 'items.disassemble', `卸 ${pluginUid} ← ${targetUid}[${slotIndex}]`, { targetUid, slotIndex, pluginUid });
    return { ok: true, warehouse: w };
  }

  return {
    getQuality, rollQuality, rollSlotCount, tierOf,
    generateRoleItem, generateSkillItem, generatePlugin, openBox,
    applyAffixes, validateUnlock,
    emptyWarehouse, assemble, disassemble,
  };
}

module.exports = Object.assign(makeItems(), { withLogger: (logger) => makeItems(logger) });