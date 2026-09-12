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

// 概率类词条 id → special 字段（I-8d/e、R-6）
const PROB_AFFIX_TO_SPECIAL = {
  dodge_chance: 'dodgeChance',
  lifesteal: 'lifesteal',
  crit_chance: 'critChance',
};
const FLAT_STATS = ['hp', 'atk', 'def', 'sp', 'mp'];
const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];

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

  // 品质抽取（I-1）：dropRates 加权
  function rollQuality(rng) {
    const rates = ITEMS_CONFIG.dropRates;
    const v = rand(rng, 0, 1);
    let acc = 0;
    for (const t of TIERS) {
      acc += rates[t];
      if (v < acc) {
        L.debug('items', 'items.roll.quality', `quality=${t}`, { quality: t, v });
        return t;
      }
    }
    L.debug('items', 'items.roll.quality', `quality=${TIERS[TIERS.length - 1]}（尾部兜底）`, { quality: TIERS[TIERS.length - 1], v });
    return TIERS[TIERS.length - 1]; // v=1 的防御路径（rng 产出 [0,1) 不到；stub 可触发）
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

  // 保留 2 位小数（100 = 精度常量，非战斗数值，门禁豁免见 // cl:）
  function round2(x) {
    return Math.round(x * 100) / 100; // cl:100
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

  // 生成技能物品（S-1：可随机参数 × 系数取整 + 下限 D-115；bulletLevel/cost/falloff 不随品质）
  function generateSkillItem(template, qualityId, rng) {
    const q = getQuality(qualityId);
    const t = typeof template === 'string' ? skillMap[template] : template;
    const k = rand(rng, q.statRange[0], q.statRange[1]);
    const params = {
      multiplier: round2(t.baseMultiplier * k),
      cost: { hp: t.baseCost.hp, mp: t.baseCost.mp, sp: t.baseCost.sp },
      cooldown: Math.max(0, Math.round(t.cooldown * k)),
      bulletLevel: t.bulletLevel,
    };
    if (t.type === 'melee') params.range = [t.range[0], t.range[1]];
    else if (t.type === 'straight') {
      params.range = Math.max(1, Math.round(t.range * k));
      params.bulletCount = Math.max(1, Math.round(t.bulletCount * k));
    } else if (t.type === 'vertical') {
      params.range = Math.max(1, Math.round(t.range * k));
      params.area = [t.area[0], t.area[1]];
    } else if (t.type === 'displacement') {
      params.distance = Math.max(1, Math.round(t.distance * k));
      params.passThroughEnemy = t.passThroughEnemy;
      params.dealDamage = t.dealDamage;
      params.fullDodgeDuring = t.fullDodgeDuring;
    }
    params.falloff = t.falloff;
    const slotCount = rollSlotCount('skill', qualityId, rng);
    const slots = [];
    const totalWeight = t.slotWeights.basic + t.slotWeights.special;
    while (slots.length < slotCount) {
      let r = rand(rng, 0, 1) * totalWeight;
      const type = r < t.slotWeights.basic ? 'basic' : 'special';
      slots.push({ type, pluginUid: null });
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
    // 词条入包：flat 类 **即时取整**（I-6b：4.48 → +4），百分比类保留 2 位（I-6a：0.096）——R-5b 聚合依赖该语义
    const affixes = def.affixes.map((a) => ({
      id: a.id, desc: a.desc,
      params: { ...a.params, v: a.id.endsWith('_flat') ? Math.round(a.params.v * coeff) : round2(a.params.v * coeff) },
    }));
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

  // 开箱（I-7）：品质 → 类别 → 生成；tier 门控池过滤（I-9/validateUnlock）
  function openBox(rng, options) {
    const opts = options || {};
    const tier = opts.tier || 'mythic';
    const quality = rollQuality(rng);
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

  // 词条聚合（D-45/D-46，I-8/R-5/R-6）：base × (1+Σpct) + Σflat → 一次取整；概率类累加封顶 1
  // 作用域：五维百分比/数值 + 概率类；regen 词条（hp/sp/mp_regen）由 roles 层叠加到模板 regen（R-4，B5）。
  function applyAffixes(baseStats, affixes) {
    const stats = { ...baseStats };
    const pct = {};
    const flat = {};
    const special = {};
    for (const a of affixes || []) {
      const aid = a.id;
      const v = a.params ? a.params.v : 0;
      if (PROB_AFFIX_TO_SPECIAL[aid]) {
        const key = PROB_AFFIX_TO_SPECIAL[aid];
        special[key] = Math.min(1, (special[key] || 0) + v);
      } else if (aid.endsWith('_pct') || aid === 'sp_cap' || aid === 'mp_cap') {
        const stat = aid === 'sp_cap' ? 'sp' : aid === 'mp_cap' ? 'mp' : aid.replace('_pct', '');
        pct[stat] = (pct[stat] || 0) + v;
      } else if (aid.endsWith('_flat')) {
        const stat = aid.replace('_flat', '');
        if (FLAT_STATS.includes(stat)) flat[stat] = (flat[stat] || 0) + v;
      }
      // 其它词条（regen/dot/stun 等特殊效果）不在五维聚合作用域内，由对应系统读取
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

  return {
    getQuality, rollQuality, rollSlotCount, tierOf,
    generateRoleItem, generateSkillItem, generatePlugin, openBox,
    applyAffixes, validateUnlock,
  };
}

module.exports = Object.assign(makeItems(), { withLogger: (logger) => makeItems(logger) });