'use strict';
/* server/core/items.js —— 物品系统数值层（P1 B3，契约 docs/interfaces.md §1）
 * 依据：systems/01-items.md（流程）；examples/01-items.md I-1..I-12（数值期望）；examples/02-roles.md R-5/R-6（词条聚合）。
 * 纯函数内核（L11）：随机全部走注入 rng（core/rng.js）；无 IO / 无 console；日志经 withLogger 注入。
 * 事件：items.roll.quality(debug) / items.generate(debug) / items.affix.apply(trace)（§4.6）。
 * 数值来源：server/data/*.json（L9）。
 * 注意：本模块只做"数值/生成"；仓库/装配/loadout 属 L3（B18，同文件双分层）。
 *
 * 2026-09-16 用户拍板 A 的三处集中改动（详见 systems/01-items.md 与 server/data/README.md）：
 *   ① `applyTypeModifier` 成为**类型修饰的唯一实现**，`generateRoleItem` 开箱时即套修饰
 *      （修正前只有 roles.instantiateRole 套 → 同品质 11 个角色数值完全相同）；
 *   ② 掉落池 `dropPool` / 池内抽取 `pickFromPool`：是否掉落（`drop`）与同类权重（`dropWeight`）
 *      全部由内容层 JSON 配置，`openBox` 不再只按类别；
 *   ③ `buildRolePanel` 成为**角色面板聚合的唯一实现**（`roles.getFinalStats` 与 `loadout.buildPanel` 共用，
 *      regen 只叠一次，消除双写）。
 *
 * **段位门控开关（用户决策 2026-09-16：默认所有功能全部解锁，段位不参与判定）**：
 *   总开关 = server/data/unlock.json 的 `gating.enabled`（与 core/unlock.js 同一字段，单一数据源）；
 *   缺省实例按该字段取值：false（当前默认）→ validateUnlock 恒 true、rollQuality 不做品质池截断（全池按
 *   dropRates 抽）、dropPool 不再按 unlockTier 过滤、assemble 不再产生 tier_locked；
 *   true → 旧行为完全不变（D-122/RK-5/I-9/§4.10 口径）。本文件无 IO/console/Math.random（L11）。
 *   测试可注入：`items.withGating(true|false)`（返回新实例，链式 `withGating(x).withLogger(log)` 可用），
 *   工厂签名 `makeItems(logger?, gating?)`——gating 缺省 = 开关值。
 */
const { nullLogger } = require('../../shared/log.js');
const { createRng } = require('./rng.js');

const QUALITIES = require('../data/qualities.json');
const ROLE_TEMPLATES = require('../data/role-templates.json').roleTemplates;
const SKILL_TEMPLATES = require('../data/skill-templates.json').skillTemplates;
const PLUGINS = require('../data/plugins.json').plugins;
const ITEMS_CONFIG = require('../data/items-config.json');
// 段位门控开关（unlock.json 的 gating.enabled 为单一数据源；字段缺失/非 false → 按启用处理，旧表行为不变）
const GATING_DEFAULT = !require('../data/unlock.json').gating || require('../data/unlock.json').gating.enabled !== false;
// 类型修饰系数（L9：数值在表，role-templates.json typeModifiers；schema T-DC-1 冻结校验）
const TYPE_MODIFIERS = require('../data/role-templates.json').typeModifiers;

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

// 类型修饰（R-2/R-3；systems/02-roles.md §4.2）：只作用于基础值，返回修饰后五维（浮点）。
// **单一实现**：roles.applyTypeModifier 委托本函数 —— 开箱生成（generateRoleItem）与角色实例化
//   （roles.instantiateRole）不再各写一份；随机消耗顺序冻结为「修饰随机 → 品质系数 → 取整」：
//   specialized 消耗 1 次 int（随机低属性索引）；expert 消耗 3 次 int（Fisher–Yates 洗牌）；
//   balanced 不消耗随机（既有确定性测试的字节级行为由此保持）。
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

let uidSeq = 0;
const qMap = Object.fromEntries(QUALITIES.qualities.map((q) => [q.id, q]));
const roleMap = Object.fromEntries(ROLE_TEMPLATES.map((r) => [r.id, r]));
const skillMap = Object.fromEntries(SKILL_TEMPLATES.map((s) => [s.id, s]));
const pluginList = PLUGINS.slice();

function makeItems(logger, gating) {
  const L = logger || nullLogger;
  // 实例门控：显式 true/false 覆盖开关；缺省（undefined/null）→ 读 unlock.json 的 gating.enabled
  const gatingOn = gating === undefined || gating === null ? GATING_DEFAULT : gating === true;
  const rand = (rng, lo, hi) => (typeof rng.float === 'function' ? rng.float(lo, hi) : rng.float());

  function getQuality(qualityId) {
    const q = qMap[qualityId];
    if (!q) throw new RangeError(`未知品质 ${qualityId}`);
    return q;
  }

  // 品质抽取（I-1）：dropRates 加权；tier 提供时按 D-122/RK-5 截断品质池（段位序号即品质上限，B17 掉落池门控）
  // P1-1 修复（审查 docs/reviews/B17.md）：截断后按剩余池 dropRates **重归一**（acc/total），残量不再落入兜底；
  //   无 tier 时 pool=全池 total=1.0，与 B3 行为逐字节一致。
  // **门控关闭（当前默认，用户决策 2026-09-16）**：tier 不再起门控作用 → 恒全池（等价 tier 缺省路径）；
  //   tier 参数保留（API/CLI 兼容），仅作回带信息。开启时行为不变。
  function rollQuality(rng, tier) {
    const rates = ITEMS_CONFIG.dropRates;
    const capIdx = !gatingOn || tier === undefined || !TIERS.includes(tier) ? TIERS.length - 1 : TIERS.indexOf(tier);
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
  // 2026-09-16 修正（用户拍板 A）：开箱物品**真正套用类型修饰**——此前只在 roles.instantiateRole 生效，
  //   导致同品质的 11 个角色在数值上完全相同（特化 ±15% / 专家 1.30 与 spread 全部失效）。
  function generateRoleItem(template, qualityId, rng) {
    const q = getQuality(qualityId);
    const t = typeof template === 'string' ? roleMap[template] : template;
    const modified = applyTypeModifier(t, rng); // R-2/R-3 顺序：修饰随机 → 品质系数 → 取整
    const stats = {};
    for (const k of FLAT_STATS) {
      const v = Math.round(modified[k] * rand(rng, q.statRange[0], q.statRange[1]));
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
  // poolOverride：openBox 门控池（I-7a/b）；缺省全量池（仍按 kind + drop 过滤）
  function generatePlugin(kind, qualityId, rng, poolOverride) {
    const q = getQuality(qualityId);
    const pool = (poolOverride || pluginList).filter((p) => p.kind === kind && p.drop !== false);
    if (pool.length === 0) throw new RangeError(`插件池为空: ${kind}`);
    const def = pickFromPool(rng, pool, `插件: ${kind}`);
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

  // ---- 掉落池原语（用户拍板 A：是否掉落 / 权重 / 解锁段位全部由内容层 JSON 配置）----
  //   `drop`      布尔：false → 不进入掉落池；缺省（未写字段）视为 true（旧表兼容）
  //   `dropWeight` 数值：同类池内相对权重；缺省 / 非正数 / 非数值 → 1
  //   `unlockTier` 段位门控：≤ tier 才进池（I-9 / D-112；缺省已解锁）
  //   门控关闭（当前默认）→ validateUnlock 恒 true，本函数只按 drop 过滤（不再因段位剔条目）
  function dropPool(list, tier) {
    return (list || []).filter((x) => x && x.drop !== false && validateUnlock(x, tier));
  }

  function dropWeightOf(x) {
    return x && Number.isFinite(x.dropWeight) && x.dropWeight > 0 ? x.dropWeight : 1;
  }

  // 池内抽取：权重全为 1（含缺省）→ 均匀取一，与旧 `rng.pick` **逐字节一致**；
  //   存在显式权重 → 按 dropWeight 加权（两条路径都恰好消耗 1 次 float，故默认表下随机流不变）。
  function pickFromPool(rng, pool, label) {
    if (pool.length === 0) throw new RangeError(`该段位无可用${label}`);
    if (pool.every((x) => dropWeightOf(x) === 1)) return rng.pick(pool);
    let r = rand(rng, 0, 1) * pool.reduce((a, x) => a + dropWeightOf(x), 0);
    for (const x of pool) {
      r -= dropWeightOf(x);
      if (r < 0) return x;
    }
    return pool[pool.length - 1]; // rng 返回值越界（≥1 的防御路径）→ 尾项兜底
  }

  // 开箱（I-7）：品质（tier 截断，D-122）→ 类别 → 生成；掉落池按 drop/unlockTier 过滤、按 dropWeight 加权
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
      const pool = dropPool(ROLE_TEMPLATES, tier);
      return generateRoleItem(pickFromPool(rng, pool, '角色模板'), quality, rng);
    }
    if (kind === 'skill') {
      const pool = dropPool(SKILL_TEMPLATES, tier);
      return generateSkillItem(pickFromPool(rng, pool, '技能模板'), quality, rng);
    }
    const pool = dropPool(pluginList.filter((x) => x.kind === kind), tier);
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

  // ---- 角色面板聚合（R-4/R-5/R-8 的**单一实现**）----
  // 2026-09-16 合并（用户拍板 A）：`roles.getFinalStats` 与 `loadout.buildPanel` 此前各算一遍词条聚合，
  //   且 regen 两侧各加一次（角色先经 equipPlugins 再进 buildPanel 会**双计**）。现在两者都调用本函数：
  //   五维（applyAffixes，D-45 顺序）+ special（D-46 封顶）+ regen（模板值 + 词条值，**只加一次**）。
  // plugins：已装配插件实例数组；调用方按各自形状解析（运行时角色 equipped[] / 仓库 slots[].pluginUid）。
  // 形状容错：role 缺 stats/regen/slots 等字段时按缺省处理（不抛 TypeError）。
  function buildRolePanel(role, plugins) {
    const r = role || {};
    const list = (plugins || []).filter(Boolean);
    const affixes = [];
    for (const p of list) for (const a of p.affixes || []) affixes.push(a);
    const aggr = applyAffixes(r.stats || {}, affixes);
    // regen 目标维度由注册表 def.regen 声明（sp_regen→sp / mp_regen→mp / hp_regen→hp），代码不按 id 分支
    const regen = Object.assign({ mp: 0, sp: 0 }, r.regen || {});
    for (const a of affixes) {
      const def = affixDef(a.id);
      if (def && def.regen) regen[def.regen] = (regen[def.regen] || 0) + ((a.params && a.params.v) || 0);
    }
    return {
      stats: aggr.stats, special: aggr.special || {}, regen,
      maxHp: aggr.stats.hp, maxMp: aggr.stats.mp, maxSp: aggr.stats.sp,
      pluginPoints: r.pluginPoints === undefined ? null : r.pluginPoints,
      quality: r.quality === undefined ? null : r.quality,
    };
  }

  // 段位门控（I-9；D-112 缺省已解锁）
  // **门控关闭（当前默认，用户决策 2026-09-16）**：恒 true——物品级门控（掉落池/装配/loadout）随之全部失效；
  //   开启时按 TIERS 序号比较（未知段位/未知 unlockTier 一律拒绝，保守）。
  function validateUnlock(item, tier) {
    if (!gatingOn) return true;
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
    // ④ 段位门控（I-10c）：插件与目标均须 ≤ tier——**由 validateUnlock 单点决定**：
    //   门控关闭（当前默认）→ validateUnlock 恒 true → 本行永不产生 tier_locked（装配不再因段位拒绝）
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
    applyAffixes, buildRolePanel, applyTypeModifier, dropPool, pickFromPool, validateUnlock,
    emptyWarehouse, assemble, disassemble,
    // 实例自省：当前门控是否参与判定（测试/文档断言用；属性非函数）
    gatingEnabled: gatingOn,
    // 实例级工厂（保证链式调用 withGating(true).withLogger(log) 不丢设置）
    withLogger: (lg) => makeItems(lg, gatingOn),
    withGating: (g) => makeItems(L, g),
  };
}

module.exports = Object.assign(makeItems(), {
  // 段位门控开关缺省值（= unlock.json gating.enabled；门禁/文档可读）
  GATING_DEFAULT,
});