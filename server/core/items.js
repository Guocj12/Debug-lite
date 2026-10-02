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
// D-176/D-177：包（模块包）配置 —— 品质=段位、质量=该品质 4 档百分比、三套曲线 + 掉落白名单。
//   本节全部概率**零字面量**（表为单一来源）；包体系**自成门控**（不读 unlock.json 的 gating.enabled）。
const PACKAGE_CONFIG = require('../data/package-config.json');
const PACKAGE_DEFS = PACKAGE_CONFIG.packages;
const PACKAGE_BY_KIND = Object.fromEntries(PACKAGE_DEFS.map((p) => [p.packageKind, p]));
const PACKAGE_KINDS = PACKAGE_DEFS.map((p) => p.packageKind);
// D-178：积木节点目录（AI 节点包的产出源；节点品质由 nodeQualityCurve 决定、同品质内等概率抽）
const AI_NODE_CATALOG = require('../data/ai-node-catalog.json').nodes;
const AI_NODES_BY_QUALITY = AI_NODE_CATALOG.reduce((acc, n) => {
  (acc[n.quality] = acc[n.quality] || []).push(n);
  return acc;
}, {});
// 段位门控开关（unlock.json 的 gating.enabled 为单一数据源；字段缺失/非 false → 按启用处理，旧表行为不变）
const GATING_DEFAULT = !require('../data/unlock.json').gating || require('../data/unlock.json').gating.enabled !== false;
// 类型修饰系数（L9：数值在表，role-templates.json typeModifiers；schema T-DC-1 冻结校验）
const TYPE_MODIFIERS = require('../data/role-templates.json').typeModifiers;

// 机制表（数据驱动）：词条语义 + 技能类型机制。代码只做解释，不按 id/类型写分支。
const REGISTRY = require('../data/affix-registry.json');
const MECHANICS = require('../data/skill-mechanics.json');
const AFFIXES = REGISTRY.affixes;
// 词条适用域（E-1，2026-09-19 闭环）：注册表用 `domain` 声明"该词条适用于角色插件 / 技能插件 / 两者"，
//   并用 `_domainOfKind` 声明插件类别 → 域的映射。此前 `domain` **只声明不消费**（全仓零 JS 读取，
//   而 docs/systems/01-items.md:18,56 称其声明 role/skill/both）→ 现于 generatePlugin 处消费：
//   域与插件类别不符 = 该词条在本类别没有任何消费方（角色插件走面板聚合、技能插件走技能链）→ 记 warn 并跳过。
const DOMAIN_OF_KIND = REGISTRY._domainOfKind || {};
const FLAT_STATS = REGISTRY.stats;                  // 五维（面板聚合作用域）
const TIERS = QUALITIES.qualities.map((q) => q.id); // 段位序 = 品质表顺序（单一来源，勿另立字面量）
const STAT_PRECISION = MECHANICS.precision.stat;

// 已登记词条；未登记 = 配置错误（gate 会拦；运行期记 warn 并跳过，不静默失效）
function affixDef(id) {
  return Object.prototype.hasOwnProperty.call(AFFIXES, id) ? AFFIXES[id] : null;
}

// 类型修饰（2026-09-28 内容设计 §3.2；**乘性守恒** Π 因子 = 1，schema 强制校验）：
//   特化 specialized：高属性 ×high（略高），**一个随机低属性** ×low（略低），high×low=1；
//   专家 expert（README 五档，2026-09-28 用户裁定）：高属性 ×high（极高），其余四维按 spread 洗牌，
//     各承担『略高 1.20 / 极低 0.6667 / 略低 0.8333 / 均衡 1.00』之一，high×Πspread=1；
//   **无 def 特判**：五维等权，任何维度都可作高/低属性（旧 `excludeLow` 已退役）。
// 随机消耗顺序冻结：修饰随机（特化 1 int / 专家 3 int）→ 5 次品质系数 float → 插槽数 → 槽类型 → 点数。
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

  // 插槽数（I-3；**2026-09-28 修订**：下限 1 已作废——用户口径允许 0 槽，绿 0-2 / 技能 0-1）
  function rollSlotCount(kind, qualityId, rng) {
    const q = getQuality(qualityId);
    let range;
    if (kind === 'role') range = q.roleSlotRange;
    else if (kind === 'skill') range = q.skillSlotRange;
    else throw new RangeError(`未知物品类别 ${kind}`);
    if (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[0] < 0 || range[0] > range[1]) {
      throw new RangeError(`品质 ${qualityId} 的 ${kind} 插槽区间非法`);
    }
    const v = rand(rng, 0, 1);
    let n = range[0] + Math.floor(v * (range[1] - range[0] + 1));
    if (n > range[1]) n = range[1];  // v=1 防御（rng 产出 [0,1) 不到；stub 可触发）
    if (n < range[0]) n = range[0];
    return n;
  }

  // 角色模板插件点数（2026-09-28 内容设计 §3.4）：品质 `pluginPointsRange` 闭区间均匀取整。
  //   消耗 1 次 float；调用方把它排在**插槽之后**，以保持既有随机序列前缀不变（修饰→5 系数→插槽数→槽类型→点数）。
  function rollPluginPoints(qualityId, rng) {
    const q = getQuality(qualityId);
    const range = q.pluginPointsRange;
    if (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1]) || range[0] < 1 || range[0] > range[1]) {
      throw new RangeError(`品质 ${qualityId} 的 pluginPointsRange 非法`);
    }
    const v = rand(rng, 0, 1);
    let n = range[0] + Math.floor(v * (range[1] - range[0] + 1));
    if (n > range[1]) n = range[1];
    if (n < range[0]) n = range[0];
    return n;
  }

  // 插槽类型权重来源（2026-09-28 §3.3）：角色 = qualities.slotTypeWeights（五维各 0.15 / 万能槽 any 0.10 / 特殊槽 special 0.15）。
  // 技能不再是"按权重掷类型"：技能物品 = **1 个专属槽 + 品质区间的通用槽**（§6.2），类型确定、无随机。
  function slotWeightsOf(kind) {
    if (kind === 'role') {
      const w = QUALITIES.slotTypeWeights;
      if (!w || typeof w !== 'object') throw new RangeError('qualities.json 缺 slotTypeWeights（角色插槽类型权重）');
      return w;
    }
    throw new RangeError(`未知插槽权重来源: ${kind}`);
  }

  // 插槽类型掷法（仅角色）：按权重逐槽掷，同一模板内某类型第 k 次出现时权重 × decay^k（重复槽概率较小）。
  // 随机消耗 = 每槽恰好 1 次 float（与旧实现同数量）。万能槽 `any` 只接受五维插件（见 slotMatches）。
  // 技能：1 个 `exclusive` + count 个 `general`（确定性，无随机消耗）。
  function rollSlots(kind, qualityId, template, rng, count) {
    if (kind === 'skill') {
      const exSlots = Number.isInteger(QUALITIES.skillExclusiveSlots) ? QUALITIES.skillExclusiveSlots : 1;
      const out = [];
      for (let i = 0; i < exSlots; i += 1) out.push({ type: 'exclusive', pluginUid: null });
      for (let i = 0; i < count; i += 1) out.push({ type: 'general', pluginUid: null });
      return out;
    }
    const q = getQuality(qualityId);
    const decay = typeof q.slotRepeatDecay === 'number' ? q.slotRepeatDecay
      : (typeof QUALITIES.slotRepeatDecay === 'number' ? QUALITIES.slotRepeatDecay : 1);
    const base = slotWeightsOf(kind);
    const types = Object.keys(base);
    const slots = [];
    const seen = {};
    while (slots.length < count) {
      let total = 0;
      const weighted = [];
      for (const t of types) {
        const f = base[t] * Math.pow(decay, seen[t] || 0);
        weighted.push([t, f]);
        total += f;
      }
      let r = rand(rng, 0, 1) * total;
      let chosen = null;
      for (const [t, f] of weighted) {
        r -= f;
        if (r < 0) { chosen = t; break; }
      }
      if (chosen === null) chosen = types[types.length - 1]; // rng 越界（≥1）防御
      slots.push({ type: chosen, pluginUid: null });
      seen[chosen] = (seen[chosen] || 0) + 1;
    }
    return slots;
  }

  // 槽位匹配（2026-09-28：新增五维万能槽 `any`）
  //   `any` 接受五维任一插件（atk/def/hp/sp/mp），**不接受 special**（用户口径 G2）。
  function slotMatches(pluginSlot, slotType) {
    if (pluginSlot === slotType) return true;
    return slotType === 'any' && FLAT_STATS.includes(pluginSlot);
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
    const slots = rollSlots('role', qualityId, t, rng, slotCount);
    // 插件点数：品质区间内掷（排在插槽之后，保持既有随机序列前缀）
    const pluginPoints = rollPluginPoints(qualityId, rng);
    const item = {
      uid: `item_${uidSeq++}`, kind: 'role', templateId: t.id, name: t.name, quality: qualityId,
      slotCount, slots, stats, regen: { mp: t.regen.mp, sp: t.regen.sp },
      unlockTier: t.unlockTier, pluginPoints,
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
    const slots = rollSlots('skill', qualityId, t, rng, slotCount);
    const item = {
      uid: `item_${uidSeq++}`, kind: 'skill', templateId: t.id, name: t.name, quality: qualityId,
      slotCount, slots, params, unlockTier: t.unlockTier,
      // 展示字段（2026-09-28 §6.2）：基础模板的动画/音效键；装上专属插件后由插件覆盖（帧 action 暴露）
      animKey: t.animKey === undefined ? null : t.animKey,
      sfxKey: t.sfxKey === undefined ? null : t.sfxKey,
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
    // 适用域校验（E-1）：域与插件类别不符 → 该词条在本类别无消费方 → warn 并跳过（与"未登记词条"同一处置）
    const wantDomain = DOMAIN_OF_KIND[kind];
    const affixes = [];
    for (const a of def.affixes) {
      const reg = affixDef(a.id);
      if (!reg) {
        L.warn('items', 'items.affix.unknown', `未登记词条 ${a.id}（affix-registry.json）`, { affixId: a.id });
      } else if (wantDomain && reg.domain && reg.domain !== 'both' && reg.domain !== wantDomain) {
        L.warn('items', 'items.affix.domain',
          `词条 ${a.id} 声明 domain=${reg.domain}，不适用于 ${kind}（应为 ${wantDomain} 或 both）→ 跳过`,
          { affixId: a.id, domain: reg.domain, kind, wantDomain });
        continue;
      }
      const rounded = (reg && reg.roll === 'int') ? Math.round(a.params.v * coeff) : round2(a.params.v * coeff);
      affixes.push({ id: a.id, desc: a.desc, params: { ...a.params, v: rounded } });
    }
    const plugin = {
      uid: `item_${uidSeq++}`, kind, id: def.id, name: def.name, desc: def.desc,
      slot: def.slot, category: def.category, quality: qualityId,
      tier, affixes, unlockTier: def.unlockTier,
    };
    if (kind === 'rolePlugin') {
      // 点数消耗 = **插件定义里的固定 pointCost**（2026-09-28 内容设计 §5.1：与品质/档位解耦，
      //   使"每点收益恒定"可实现；`tier` 仅保留为品质档位展示字段，不再决定消耗）
      if (!Number.isInteger(def.pointCost) || def.pointCost < 1) {
        throw new RangeError(`角色插件 ${def.id} 缺合法 pointCost（正整数）`);
      }
      plugin.pointCost = def.pointCost;
    }
    if (kind === 'skillPlugin') {
      // 2026-09-28 §6：技能插件分两类 —— `general`（通用：纯词条加成，消耗补偿 costDeltaByTier 已退役）
      //   与 `exclusive`（专属：声明式形态覆盖，**覆盖型字段不随品质浮动**，随实例整体带过去）。
      //   两者**字段形状一致**（都带 tier，作品质档位展示字段；前端契约据此保持单表核对）。
      if (def.slot === 'exclusive') {
        plugin.exclusive = def.exclusive === undefined ? {} : def.exclusive;
        plugin.forTypes = Array.isArray(def.forTypes) ? [...def.forTypes] : [];
        plugin.animKey = def.animKey === undefined ? null : def.animKey;
        plugin.sfxKey = def.sfxKey === undefined ? null : def.sfxKey;
      }
    }
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

  // ===== D-176：包（模块包）—— 生成 / 三套曲线抽样 =====
  // 口径（用户 2026-09-28 裁定，docs/content-design.md §10）：
  //   · **包品质 = 玩家当前段位**（调用方传入；本层不读档案，保持纯函数）；
  //   · **包质量 = 该品质 4 档百分比**（qualityPercentBands；跨品质不合法 → RangeError）；
  //   · 物品品质分布、掉落件数、战斗掉落个数/质量档 全部读 package-config.json（零概率字面量）。

  function packageDefOf(packageKind) {
    const def = PACKAGE_BY_KIND[packageKind];
    if (!def) throw new RangeError(`未登记包种类 ${packageKind}（package-config.json）`);
    return def;
  }

  // 该品质的 4 档百分比（升序）
  function packagePercentsOf(qualityId) {
    const band = PACKAGE_CONFIG.qualityPercentBands[qualityId];
    if (!Array.isArray(band)) throw new RangeError(`未知包品质 ${qualityId}（package-config.json）`);
    return band;
  }

  // 质量档位（1..4）；非法（不在该品质的档位集合内）→ null
  function packageStepOf(qualityId, percent) {
    const band = packagePercentsOf(qualityId);
    const i = band.indexOf(percent);
    return i < 0 ? null : i + 1;
  }

  // 按权重表抽一个键（键为字符串，值为非负权重）；全零/空表 → null（调用方兜底）
  function pickWeighted(rng, weights, label) {
    const keys = Object.keys(weights || {});
    let total = 0;
    for (const k of keys) total += weights[k];
    if (!(total > 0)) throw new RangeError(`权重表为空或全零: ${label}`);
    let r = rand(rng, 0, 1) * total;
    for (const k of keys) {
      r -= weights[k];
      if (r < 0) return k;
    }
    return keys[keys.length - 1]; // rng 越界（≥1）防御
  }

  // 生成一个包（**uid 由调用方给定**，使"响应 = journal = 档案"且跨重启不撞号；
  //   缺省回落进程内计数器，仅用于离线/测试路径）
  function generatePackage(input) {
    const o = input || {};
    const def = packageDefOf(o.packageKind);
    if (!TIERS.includes(o.quality)) throw new RangeError(`未知包品质 ${o.quality}`);
    const percent = o.qualityPercent;
    if (!Number.isInteger(percent) || packageStepOf(o.quality, percent) === null) {
      throw new RangeError(`包质量 ${percent} 不属于品质 ${o.quality} 的档位（${packagePercentsOf(o.quality).join('/')}）`);
    }
    const uid = typeof o.uid === 'string' && o.uid !== '' ? o.uid : `pkg_${uidSeq++}`;
    const item = {
      uid, kind: 'package', packageKind: def.packageKind, name: def.name,
      quality: o.quality, qualityPercent: percent,
    };
    L.debug('items', 'items.package.generate', `package ${def.packageKind} ${o.quality} ${percent}%`, {
      packageKind: def.packageKind, quality: o.quality, qualityPercent: percent, uid,
    });
    return item;
  }

  // 战斗掉落的包（返回 [{packageKind, quality, qualityPercent}]）：
  //   结果按请求者视角 win/loss/draw；品质 = 玩家段位（tier）；个数 = battleDropCountCurve 抽；
  //   质量档 = battleDropQualityCurve 抽；包种类 = packageKindWeights 抽（每次独立）。
  function rollBattlePackages(rng, options) {
    const o = options || {};
    const tier = o.tier;
    if (!TIERS.includes(tier)) throw new RangeError(`未知段位 ${tier}（包品质 = 段位）`);
    const result = o.result === 'win' || o.result === 'loss' ? o.result : 'draw';
    const band = packagePercentsOf(tier);
    const countKey = pickWeighted(rng, PACKAGE_CONFIG.battleDropCountCurve[result], `battleDropCountCurve.${result}`);
    const count = Number(countKey);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const stepKey = pickWeighted(rng, PACKAGE_CONFIG.battleDropQualityCurve[result], `battleDropQualityCurve.${result}`);
      const kindKey = pickWeighted(rng, PACKAGE_CONFIG.packageKindWeights, 'packageKindWeights');
      const step = Number(stepKey);
      out.push({ packageKind: kindKey, quality: tier, qualityPercent: band[step - 1] });
    }
    L.debug('items', 'items.package.drop', `battle drop ${result} ${tier}: ${out.length} 个`, {
      result, tier, count: out.length, percents: out.map((x) => x.qualityPercent), kinds: out.map((x) => x.packageKind),
    });
    return out;
  }

  // 该包在给定质量档下的掉落下限/上限模板（白名单 + 内容表 drop 标记；**不读段位门控** D-176）
  function packageDropPoolOf(packageKind, percent) {
    const def = packageDefOf(packageKind);
    if (def.dropsKind === null) return [];
    const key = String(percent);
    const table = (PACKAGE_CONFIG.dropPool || {})[packageKind] || {};
    const whitelist = table[key] === undefined ? 'all' : table[key];
    const allow = (x) => x && x.drop !== false && (whitelist === 'all' || whitelist.includes(x.id));
    if (def.dropsKind === 'role') return ROLE_TEMPLATES.filter(allow);
    if (def.dropsKind === 'skill') return SKILL_TEMPLATES.filter(allow);
    return pluginList.filter((p) => p.kind === def.dropsKind && allow(p));
  }

  // 按类别生成一件掉落物（品质由曲线给定）
  function generateDropItem(dropsKind, quality, rng, ctx) {
    if (dropsKind === 'role') {
      const pool = packageDropPoolOf(ctx.packageKind, ctx.qualityPercent);
      return generateRoleItem(pickFromPool(rng, pool, '角色模板'), quality, rng);
    }
    if (dropsKind === 'skill') {
      const pool = packageDropPoolOf(ctx.packageKind, ctx.qualityPercent);
      return generateSkillItem(pickFromPool(rng, pool, '技能模板'), quality, rng);
    }
    const pool = packageDropPoolOf(ctx.packageKind, ctx.qualityPercent);
    return generatePlugin(dropsKind, quality, rng, pool);
  }

  // D-178：新手自带节点包（**全部绿档节点各 1 个**）。uid 由 nodeId 派生 → 确定性（starter 必须可复现，
  //   且跨进程重启不撞车：不消耗模块级 uidSeq）。
  // D-178：新手自带节点包（**全部绿档节点**；结构类节点给多份 —— 只给 1 个 `f_if` 就写不出嵌套分支，
  //   与"十几个节点就能搭出完整 AI"的设计目标冲突）。uid 由 (nodeId, 序号) 派生 → 确定性、跨重启不撞车。
  const STARTER_NODE_EXTRA = Object.freeze({ f_seq: 2, f_if: 3 });
  function starterNodeStacks() {
    const out = [];
    for (const n of (AI_NODES_BY_QUALITY.common || [])) {
      const count = STARTER_NODE_EXTRA[n.id] || 1;
      for (let i = 0; i < count; i += 1) {
        out.push({
          uid: count === 1 ? `node_starter_${n.id}` : `node_starter_${n.id}_${i + 1}`,
          kind: 'aiNode', nodeId: n.id, name: n.name, category: n.category, quality: n.quality, count: 1,
        });
      }
    }
    return out;
  }

  // 开包（纯函数）：包 → 1~3 件物品。保留包（openable=false，如 AI 节点包）→ {reserved:true, items:[]}。
  //   调用方（L6）负责：校验包确实属于该玩家仓库、扣包、把 items 落 journal（package.opened）。
  function openPackage(rng, pkg, options) {
    const o = options || {};
    if (!pkg || typeof pkg !== 'object' || pkg.kind !== 'package') {
      return { ok: false, code: 'package_invalid', message: '不是有效的包' };
    }
    const def = PACKAGE_BY_KIND[pkg.packageKind];
    if (!def) return { ok: false, code: 'package_invalid', message: `未登记包种类 ${pkg.packageKind}` };
    const step = packageStepOf(pkg.quality, pkg.qualityPercent);
    if (step === null) {
      return { ok: false, code: 'package_invalid', message: `包质量 ${pkg.qualityPercent} 与品质 ${pkg.quality} 不匹配` };
    }
    // 保留包（openable=false）：静默消耗但零产出；L6 回带 notice 供前端提示（当前已无保留包，防御保留）
    if (def.openable !== true) {
      L.info('items', 'items.package.open', `保留包 ${def.packageKind}（未开放产出）`, {
        packageKind: def.packageKind, quality: pkg.quality, qualityPercent: pkg.qualityPercent, reserved: true,
      });
      return { ok: true, reserved: true, items: [] };
    }
    // AI 节点包（D-178）：产出**可堆叠的积木节点**——品质走 nodeQualityCurve（本级及以下均匀），
    //   个数复用 itemCountCurve（**质量只影响个数，不影响品质**，用户口径）；同 nodeId 合并为一条堆叠（count++）。
    if (def.packageKind === 'aiNode') {
      const countKey = pickWeighted(rng, PACKAGE_CONFIG.itemCountCurve[String(step)], `itemCountCurve.${step}`);
      const nodes = [];
      const byId = new Map();
      for (let i = 0; i < Number(countKey); i += 1) {
        const qKey = pickWeighted(rng, PACKAGE_CONFIG.nodeQualityCurve[pkg.quality], `nodeQualityCurve.${pkg.quality}`);
        const pool = AI_NODES_BY_QUALITY[qKey] || [];
        if (pool.length === 0) {
          L.warn('items', 'items.package.open', `节点品质 ${qKey} 无可用节点（目录为空）`, { quality: qKey });
          continue;
        }
        const node = rng.pick(pool);
        if (byId.has(node.id)) byId.get(node.id).count += 1;
        else {
          const entry = { uid: `node_${uidSeq++}`, kind: 'aiNode', nodeId: node.id, name: node.name, category: node.category, quality: node.quality, count: 1 };
          byId.set(node.id, entry);
          nodes.push(entry);
        }
      }
      L.info('items', 'items.package.open', `开节点包 ${pkg.quality} ${pkg.qualityPercent}% → ${nodes.length} 种（共 ${nodes.reduce((a, x) => a + x.count, 0)} 个）`, {
        packageKind: 'aiNode', quality: pkg.quality, qualityPercent: pkg.qualityPercent,
        stacks: nodes.length, total: nodes.reduce((a, x) => a + x.count, 0),
      });
      return { ok: true, reserved: false, items: nodes };
    }
    const countKey = pickWeighted(rng, PACKAGE_CONFIG.itemCountCurve[String(step)], `itemCountCurve.${step}`);
    const count = Number(countKey);
    const items = [];
    for (let i = 0; i < count; i += 1) {
      const qKey = pickWeighted(rng, PACKAGE_CONFIG.itemQualityCurve[String(pkg.qualityPercent)], `itemQualityCurve.${pkg.qualityPercent}`);
      items.push(generateDropItem(def.dropsKind, qKey, rng, {
        packageKind: def.packageKind, qualityPercent: pkg.qualityPercent,
      }));
    }
    L.info('items', 'items.package.open', `开包 ${def.packageKind} ${pkg.quality} ${pkg.qualityPercent}% → ${items.length} 件`, {
      packageKind: def.packageKind, quality: pkg.quality, qualityPercent: pkg.qualityPercent,
      count: items.length, qualities: items.map((x) => x.quality),
    });
    return { ok: true, reserved: false, items };
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
        // 概率类词条按 caps.probability 封顶；非概率类（荆棘/暴击倍率/低血加攻）**不封顶**
        //   （注册表 `cap` 字段声明；2026-09-28 内容设计 §5.4）
        const cap = def.cap === 'probability' ? REGISTRY.caps.probability : Infinity;
        special[def.special] = Math.min(cap, (special[def.special] || 0) + v);
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
  // D-176：新增第 5 桶 `package`（包）；D-178：新增第 6 桶 `aiNode`（可堆叠积木节点）。
  //   桶键与物品 `kind` 的对应：role/skill/rolePlugin/skillPlugin 同名，包的 kind='package' 桶键也是 'package'，
  //   节点的 kind='aiNode' 桶键也是 'aiNode'（节点条目 = 一个堆叠：{uid, kind:'aiNode', nodeId, quality, count}）。
  function emptyWarehouse() {
    return { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [], package: [], aiNode: [] } };
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
    if (!slotMatches(plugin.slot, slot.type)) return rejectOut('slot_type_mismatch', `插件槽 ${plugin.slot} 不适用于插槽 ${slot.type}`);
    // 专属插件的类型绑定（2026-09-28 §6.2）：`forTypes` 必须包含该技能模板的类型
    if (plugin.slot === 'exclusive' && target.kind === 'skill') {
      const tpl = skillMap[target.templateId];
      const types = (Array.isArray(plugin.forTypes) && plugin.forTypes.length > 0)
        ? plugin.forTypes
        : ((plugin.exclusive && Array.isArray(plugin.exclusive.forTypes)) ? plugin.exclusive.forTypes : []);
      if (tpl && types.length > 0 && !types.includes(tpl.type)) {
        return rejectOut('slot_type_mismatch', `专属插件 ${plugin.id} 不适用于技能类型 ${tpl.type}`);
      }
    }
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
    getQuality, rollQuality, rollSlotCount, rollPluginPoints, rollSlots, slotMatches, tierOf,
    generateRoleItem, generateSkillItem, generatePlugin, openBox,
    // D-176/D-177：包（模块包）—— 生成、战斗掉落抽样、开包、白名单池与档位查询
    generatePackage, rollBattlePackages, openPackage, packageDefOf, packagePercentsOf, packageStepOf,
    packageDropPoolOf, pickWeighted,
    // D-178：AI 积木节点（新手自带绿档节点的确定性堆叠）
    starterNodeStacks,
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