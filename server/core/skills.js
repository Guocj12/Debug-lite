'use strict';
/* server/core/skills.js —— 技能系统（P1 B6，契约 docs/interfaces.md §1）
 * 依据：systems/03-skills.md；**docs/content-design.md §6（技能数值唯一权威）**；decisions D-07/D-15/D-18/D-21/D-22/D-25/D-29/D-113/D-115/D-118/D-173。
 * 纯函数内核（L11）：随机走注入 rng；canCast/applySkillPlugins/applyExclusive 不改入参（纯函数，返回新对象）；日志经 withLogger 注入。
 * 事件：skill.instantiate(debug) / skill.plugin.apply(debug) / skill.cast(info) / skill.reject(warn)（§4.6）。
 *
 * 【数据驱动改造（2026-09-16）】本模块不再按技能类型/词条 id 写死分支：
 *   - 类型机制（参数滚动、语义槽位、弹幕发射模式与常量）→ server/data/skill-mechanics.json
 *   - 词条语义（skillOp 算子 / hitEffect / castEffect）      → server/data/affix-registry.json
 *   - 专属插件形态（overrides / specials / hitEffects / castEffects / 名称与动画键） → server/data/plugins.json
 *   代码只解释表里声明的 pattern / op 名称；新增类型、词条或专属插件 = 改表，不改此处（未登记项由 gate 拦下）。
 * 语义（B6 登记，未变）：
 *   - sid = templateId（技能**模板**身份；实例化时写入，日志与拒绝原因用）。
 *   - **冷却键 = 槽位键（P1-4 裁定，2026-09-19）**：`canCast(skill, caster, cooldownKey)` 的第三个入参
 *     即冷却键；引擎传 `intent.sid`（= AI 动作名 `skill:<槽位>` 的槽位，`server/battle.js` 的
 *     `p.skills[skill1..3]` 也就是按槽位装配的）。**同一模板装两槽 → 两槽 CD 独立**（默认出战配置
 *     `ranked.PRESET_SKILL_ORDER` 故意重复同一模板，此前两槽共享模板键 CD → `skill.reject cooldown`）。
 *     未传第三参时回落到 `skill.sid || skill.templateId`（纯函数单测/旧调用点语义不变）。
 *     旧快照/旧帧里的 `cooldowns` 键读不到 → 视作 0（缺键判定，永不抛错）。
 *   - instantiateSkill 复用 items.generateSkillItem 的参数随机（同构，避免双实现）。
 *   - **插件顺序（2026-09-28 冻结）**：专属插件（`slot:'exclusive'`，声明式覆盖形态/名称/动画音效）→ 通用插件（纯词条加成）。
 *   - **通用插件零代价**（D-173）：旧的 costDeltaByTier / costDeltaBase 消耗补偿已退役；只有减耗词条会降低消耗（`ceil(cost×(1−v))`）。
 *   - 命中类效果（专属插件的内联 hitEffects、以及注册表登记的 stun/knockback/pull/dot）登记进 skill.affixes，由 engine 步骤 9 结算；
 *     释放类效果登记进 skill.castEffects，由 engine 步骤 6 入效果队列；
 *     概率类词条（crit_chance/lifesteal/critMul）登记进 skill.specials，随弹幕 payload 传给命中结算（B9）。
 */
const { nullLogger } = require('../../shared/log.js');
const items = require('./items.js');
const field = require('./field.js');

const QUALITIES = require('../data/qualities.json');
const SKILL_TEMPLATES = require('../data/skill-templates.json').skillTemplates;
const REGISTRY = require('../data/affix-registry.json');
const MECHANICS = require('../data/skill-mechanics.json');
const skillMap = Object.fromEntries(SKILL_TEMPLATES.map((t) => [t.id, t]));

// "rangePx" → skill.range × cellPx；其余字段名 → 原值
function fieldValue(skill, ref) {
  if (typeof ref !== 'string') return ref;
  if (ref.endsWith('Px')) {
    const base = ref.slice(0, -2);
    return skill[base] * field.CELL_PX;
  }
  return skill[ref];
}

// 落点（2026-09-28 D-174）：缺省 = 施法者前方 rangePx（clamp 到场内）；
//   机制表声明 `emit.impactAim === 'enemyCell'` 时（定点类）：**敌方所在格**落在射程覆盖格内
//   → 落点 = 该格格心（"以对方所在格为目标"）；射程内没有对方角色 → 回落"最远位置"释放（不再失败）。
//   `ctx.targetX` = 敌方当前 px 坐标（引擎步骤 6 注入）；缺省 = 无敌人 → 最远位置（向后兼容）。
function impactXOf(skill, caster, emit, ctx) {
  const maxX = field.clampX(caster.x + caster.facing * fieldValue(skill, emit.impactFrom));
  if (emit.impactAim !== 'enemyCell') return maxX;
  if (!ctx || !Number.isFinite(ctx.targetX)) return maxX;
  const fromCell = field.cellOf(caster.x);
  const toCell = field.cellOf(maxX);
  const targetCell = field.cellOf(ctx.targetX);
  const lo = Math.min(fromCell, toCell);
  const hi = Math.max(fromCell, toCell);
  if (targetCell < lo || targetCell > hi) return maxX; // 前方射程覆盖格内无敌人 → 最远位置
  return field.xCenter(targetCell);                    // 命中敌方所在格（格心）
}

function makeSkills(logger, tables) {
  // 机制表可注入（与 logger 注入同构）：缺省用 server/data/*.json；注入用于单测覆盖防御分支与未来扩展。
  const T = tables || {};
  const MECHANICS_ = T.mechanics || MECHANICS;
  const REGISTRY_ = T.registry || REGISTRY;
  const AFFIXES_ = REGISTRY_.affixes;
  const B = MECHANICS_.bounds;
  const P = MECHANICS_.precision;
  const L = logger || nullLogger;

  // 实例化出战技能（S-1：可随机参数；复用 items.generateSkillItem 参数随机逻辑）
  function instantiateSkill(template, qualityId, rng) {
    const t = typeof template === 'string' ? skillMap[template] : template;
    const gen = items.generateSkillItem(t, qualityId, rng);
    const p = gen.params;
    const skill = {
      sid: t.id, templateId: t.id, name: t.name, type: t.type,
      multiplier: p.multiplier,
      cost: { hp: p.cost.hp, mp: p.cost.mp, sp: p.cost.sp },
      cooldown: p.cooldown,
      bulletLevel: p.bulletLevel,
      range: p.range, bulletCount: p.bulletCount, area: p.area, distance: p.distance,
      passThroughEnemy: p.passThroughEnemy, dealDamage: p.dealDamage, fullDodgeDuring: p.fullDodgeDuring,
      moveDir: p.moveDir === undefined ? 'forward' : p.moveDir, // 'backward' = 背向位移（2026-09-28 §6.4 后撤）
      trueDamage: p.trueDamage === true,                        // 整次命中改真伤（专属/通用插件的 setTrueDamage）
      animKey: t.animKey === undefined ? null : t.animKey,       // 动画键（专属插件可覆盖；帧 action 暴露）
      sfxKey: t.sfxKey === undefined ? null : t.sfxKey,
      exclusiveId: null,                                        // 已装专属插件 id（至多 1 个）
      falloff: p.falloff, affixes: [], specials: {}, castEffects: [],
    };
    L.debug('skills', 'skill.instantiate', `skill ${t.id} ${qualityId}`, { templateId: t.id, quality: qualityId });
    return skill;
  }

  // 词条算子解释器（op 名称取自词条注册表；未知 op → warn 并跳过）
  function applySkillOp(skill, op, v, pluginCtx, affixDef) {
    switch (op.op) {
      case 'scalePct': {
        const digits = P[op.round] === undefined ? P.stat : P[op.round];
        const scale = Math.pow(10, digits);
        return { ...skill, [op.field]: Math.round(skill[op.field] * (1 + v) * scale) / scale };
      }
      case 'sub': {
        const min = op.min === undefined ? 0 : (B[op.min] === undefined ? 0 : B[op.min]);
        return { ...skill, [op.field]: Math.max(min, skill[op.field] - v) };
      }
      case 'add': {
        if (skill[op.field] === undefined) return skill; // 该类型无此字段 → 词条不生效（如近战无弹幕数）
        const min = op.min === undefined ? 0 : (B[op.min] === undefined ? 0 : B[op.min]);
        return { ...skill, [op.field]: Math.max(min, skill[op.field] + v) };
      }
      case 'addSlot': {
        // 语义槽位 → 具体字段由类型机制表声明；槽位缺席（如 melee 射程不可增强）= 不生效
        const mech = MECHANICS_.types[skill.type];
        const target = mech && mech.slots ? mech.slots[op.slot] : undefined;
        if (!target || skill[target] === undefined) return skill;
        return { ...skill, [target]: skill[target] + v };
      }
      case 'addSpecial': {
        // 概率类（cap:'probability'）封顶 1；非概率类（critMul）不封顶（与 items.applyAffixes 同口径，2026-09-28）
        const cap = affixDef && affixDef.cap === 'probability' ? REGISTRY_.caps.probability : Infinity;
        const cur = (skill.specials && skill.specials[op.field]) || 0;
        return { ...skill, specials: { ...(skill.specials || {}), [op.field]: Math.min(cap, cur + v) } };
      }
      case 'scaleCooldownPct': {
        // 百分比减冷却（`sk_cd_down`：−25%）：向下取整，下限 = bounds.minCooldownReduced（1）
        const min = op.min === undefined ? 1 : (B[op.min] === undefined ? 1 : B[op.min]);
        return { ...skill, [op.field]: Math.max(min, Math.floor(skill[op.field] * (1 - v))) };
      }
      case 'scaleCostCeil': {
        const factor = 1 - v;
        const cost = {};
        for (const dim of MECHANICS_.costDims) cost[dim] = Math.ceil(skill.cost[dim] * factor);
        return { ...skill, cost };
      }
      case 'scaleCostCeilByDim': {
        // 单维减耗（`sk_sp_down` / `sk_mp_down`）：只作用于 op.dim 声明的资源维度
        const dim = op.dim;
        if (!dim || skill.cost[dim] === undefined) return skill;
        return { ...skill, cost: { ...skill.cost, [dim]: Math.ceil(skill.cost[dim] * (1 - v)) } };
      }
      case 'setTrueDamage':
        // 整次命中改为真实伤害（无视 def；倍率下调由同一插件的 scalePct 负值承担）
        return { ...skill, trueDamage: true };
      default:
        L.warn('skills', 'skill.plugin.unknown', `未登记算子 ${op.op}（affix-registry.json）`, { op: op.op });
        return skill;
    }
  }

  // 释放类词条 → 效果队列条目（engine 步骤 6 入队；duration 缺省取注册表 fallbackDuration）
  function buildCastEffect(spec, params) {
    const eff = { kind: spec.kind, stat: spec.stat };
    if (spec.deltaFrom) eff.delta = params[spec.deltaFrom];
    const dur = spec.durationFrom ? params[spec.durationFrom] : undefined;
    eff.remaining = dur === undefined ? spec.fallbackDuration : dur;
    return eff;
  }

  // 专属插件应用（2026-09-28 §6.2）：**声明式覆盖**（不随品质浮动）+ 技能级 specials + 内联命中/释放效果 + 展示字段。
  //   `forTypes` 绑定技能类型；每个技能至多 1 个（`assemble` 保证；此处只应用第一个匹配的专属）。
  function applyExclusive(skill, plugin) {
    const ex = plugin.exclusive || {};
    const forTypes = Array.isArray(ex.forTypes) ? ex.forTypes : [];
    if (forTypes.length > 0 && !forTypes.includes(skill.type)) return skill; // 类型不符 → 不生效（装配层已拦）
    let out = {
      ...skill,
      cost: { ...skill.cost },
      specials: { ...(skill.specials || {}) },
      affixes: [...skill.affixes],
      castEffects: [...(skill.castEffects || [])],
    };
    for (const [k, val] of Object.entries(ex.overrides || {})) {
      if (k === 'cost') { out.cost = { hp: 0, mp: 0, sp: 0, ...val }; continue; }
      if (k === 'range' || k === 'area') { out[k] = Array.isArray(val) ? [val[0], val[1]] : val; continue; }
      out[k] = val;
    }
    // 逐品质覆盖（`qualityOverrides`）：按插件自身品质取一套覆盖值，用于"随品质变化"的非浮动字段（如连射弹幕数）
    const byQ = ex.qualityOverrides && ex.qualityOverrides[plugin.quality];
    for (const [k, val] of Object.entries(byQ || {})) {
      if (k === 'cost') { out.cost = { hp: 0, mp: 0, sp: 0, ...val }; continue; }
      if (k === 'range' || k === 'area') { out[k] = Array.isArray(val) ? [val[0], val[1]] : val; continue; }
      out[k] = val;
    }
    for (const [k, val] of Object.entries(ex.specials || {})) {
      out.specials[k] = Math.min(REGISTRY_.caps.probability, (out.specials[k] || 0) + val);
    }
    // 内联命中/释放效果：`{effect: <规格>, params: {v}}`（值内联，不经词条注册表）
    for (const spec of (ex.hitEffects || [])) {
      const { params, ...rest } = spec;
      out.affixes = [...out.affixes, { effect: rest, params: params || { v: 1 } }];
    }
    for (const spec of (ex.castEffects || [])) {
      const { params, ...rest } = spec;
      out.castEffects = [...out.castEffects, rest];
    }
    out.exclusiveId = plugin.id;
    out.name = plugin.name || out.name;                     // 技能显示名 = 专属插件名
    out.animKey = plugin.animKey === undefined ? out.animKey : plugin.animKey;
    out.sfxKey = plugin.sfxKey === undefined ? out.sfxKey : plugin.sfxKey;
    return out;
  }

  // 插件叠加（S-2/S-3/S-4；纯函数返回新实例）——循环体内无 id/type 分支
  //   顺序（2026-09-28 冻结）：**专属插件（改形态）→ 通用插件（词条加成）**；通用插件零代价（D-173 取消 costDeltaByTier）。
  function applySkillPlugins(skill, plugins) {
    let out = {
      ...skill, cost: { ...skill.cost }, affixes: [...skill.affixes],
      specials: { ...(skill.specials || {}) },
      castEffects: [...(skill.castEffects || [])],
    };
    const list = (plugins || []).filter(Boolean);
    const excl = list.find((p) => p.slot === 'exclusive');
    if (excl) out = applyExclusive(out, excl);
    for (const p of list) {
      if (p === excl) continue;
      for (const a of (p.affixes || [])) {
        const def = AFFIXES_[a.id];
        const v = (a.params && a.params.v) || 0;
        if (!def) {
          L.warn('skills', 'skill.plugin.unknown', `未登记词条 ${a.id}（affix-registry.json）`, { affixId: a.id });
          continue;
        }
        if (def.skillOp) out = applySkillOp(out, def.skillOp, v, p, def);
        if (def.hitEffect) out = { ...out, affixes: [...out.affixes, { id: a.id, params: a.params }] };
        if (def.castEffect) out = { ...out, castEffects: [...out.castEffects, buildCastEffect(def.castEffect, a.params)] };
      }
      L.debug('skills', 'skill.plugin.apply', `plugin ${p.id || '?'}`, { pluginId: p.id, slot: p.slot || null });
    }
    return out;
  }

  // 释放判定（S-5；纯函数：成功返回扣资源/写 CD 后的克隆 caster）
  // 第三参 `cooldownKey` = 冷却键（P1-4：引擎传槽位键 skill1..3 → **按槽位冷却**；缺省回落模板 id）。
  function canCast(skill, caster, cooldownKey) {
    const sid = skill.sid || skill.templateId;
    const cdKey = typeof cooldownKey === 'string' && cooldownKey !== '' ? cooldownKey : sid;
    // 缺键 → undefined > 0 为 false（旧存档/旧帧快照的 cooldowns 键与当前不一致时视作 0，不抛错）
    if ((caster.cooldowns && caster.cooldowns[cdKey]) > 0) {
      L.warn('skills', 'skill.reject', `skill ${sid} cooldown`, { reason: 'cooldown', sid, slot: cdKey });
      return { ok: false, reason: 'cooldown' };
    }
    const c = skill.cost;
    if (caster.hp < c.hp || caster.mp < c.mp || caster.sp < c.sp) {
      L.warn('skills', 'skill.reject', `skill ${sid} resource`, { reason: 'resource', sid, slot: cdKey });
      return { ok: false, reason: 'resource' };
    }
    const next = {
      ...caster,
      hp: caster.hp - c.hp,
      mp: caster.mp - c.mp,
      sp: caster.sp - c.sp,
      cooldowns: { ...(caster.cooldowns || {}), [cdKey]: skill.cooldown },
    };
    L.info('skills', 'skill.cast', `skill ${sid} cast`, { sid, slot: cdKey, cost: c });
    return { ok: true, caster: next };
  }

  // 覆盖格集合（T-SK-3/F-20..27 语义；由类型机制表 cellsFrom/impactFrom 决定锚点）
  //   ctx（可选）：`{ targetX }` —— 定点类"以对方所在格为目标"索敌（D-174）
  function coveredCellRanges(skill, caster, ctx) {
    const mech = MECHANICS_.types[skill.type];
    if (!mech || !mech.emit || !mech.emit.cellsFrom) return [];
    const span = skill[mech.emit.cellsFrom];
    if (!Array.isArray(span)) return [];
    const anchor = mech.emit.impactFrom ? impactXOf(skill, caster, mech.emit, ctx) : caster.x;
    const cells = field.cellRange(span[0], span[1], caster.facing, anchor);
    if (mech.emit.impactFrom) {
      L.trace('skills', 'skill.area', `${skill.type} cells=${cells.join(',')} impact=${anchor}`, { type: skill.type, cells, impactX: anchor });
    } else {
      L.trace('skills', 'skill.area', `${skill.type} cells=${cells.join(',')}`, { type: skill.type, cells });
    }
    return cells;
  }

  // 释放指令（S-6..S-9）：{type:'cast', skill, bullets, move?, impactX?, castEffects?}
  //   ctx（可选）：`{ targetX }` —— 定点类索敌（D-174）
  function buildSkillAction(skill, caster, ctx) {
    const mech = MECHANICS_.types[skill.type];
    const payload = {
      multiplier: skill.multiplier, falloff: skill.falloff, affixes: skill.affixes,
      specials: skill.specials || {}, trueDamage: skill.trueDamage === true,
    };
    const action = { type: 'cast', skill, bullets: [], castEffects: skill.castEffects || [] };
    if (mech && mech.move) {
      const raw = skill[mech.move.cellsFrom];
      // 背向位移（2026-09-28 §6.4 后撤）：`moveDir === 'backward'` 或 distance 为负 → 方向取反、格数取绝对值
      const backward = skill.moveDir === 'backward' || raw < 0;
      action.move = {
        dir: backward ? -caster.facing : caster.facing,
        cells: Math.abs(raw),
        passThroughEnemy: skill.passThroughEnemy,
        dealDamage: skill.dealDamage,
        fullDodgeDuring: skill.fullDodgeDuring,
      };
    }
    if (!mech || !mech.emit) return action;
    if (mech.emit.when && !skill[mech.emit.when]) return action; // 条件不满足（如位移技 dealDamage=false → 无路径弹幕）
    const emitter = EMITTERS[mech.emit.pattern];
    if (!emitter) {
      L.warn('skills', 'skill.emit.unknown', `未登记发射模式 ${mech.emit.pattern}（skill-mechanics.json）`, { pattern: mech.emit.pattern });
      return action;
    }
    const fired = emitter(skill, caster, mech, payload, coveredCellRanges, ctx);
    action.bullets = fired.bullets;
    if (mech.emit.exposeImpactX && fired.impactX !== undefined) action.impactX = fired.impactX;
    return action;
  }

  return { instantiateSkill, applySkillPlugins, applyExclusive, canCast, buildSkillAction, coveredCellRanges };
}

// 弹幕构造：所有常量/字段名来自 skill-mechanics.json 的 bullet 描述
function makeBullet(spec, skill, caster, ctx, payload) {
  const bullet = {
    btype: spec.btype,
    srcType: spec.srcType,
    x0: spec.origin === 'caster' ? caster.x : field.xCenter(ctx.cell),
    v: spec.vFrom ? fieldValue(skill, spec.vFrom) : spec.v,
    len: spec.lenFrom ? fieldValue(skill, spec.lenFrom) : spec.len,
    dir: spec.dirFrom === 'facing' ? (ctx.dir === undefined ? caster.facing : ctx.dir) : spec.dir,
    level: skill.bulletLevel,
    payload: { ...payload },
  };
  if (spec.distCells && spec.distCells !== 'none' && ctx.distCells !== undefined) {
    bullet.payload.distCells = ctx.distCells;
  }
  return bullet;
}

// 发射模式解释器（pattern 名取自 skill-mechanics.json；新增模式 = 在此登记一个函数）
const EMITTERS = {
  cellsFromRange(skill, caster, mech, payload, coveredCellRanges, ctx) {
    const originCell = field.cellOf(caster.x);
    const bullets = coveredCellRanges(skill, caster, ctx).map((c) => makeBullet(mech.emit.bullet, skill, caster, {
      cell: c, distCells: Math.abs(c - originCell),
    }, payload));
    return { bullets };
  },

  repeatCount(skill, caster, mech, payload) {
    const count = skill[mech.emit.countFrom];
    const bullets = [];
    for (let i = 0; i < count; i++) {
      bullets.push(makeBullet(mech.emit.bullet, skill, caster, {}, payload)); // 逐枚拷贝（审查 P2-2）
    }
    return { bullets };
  },

  impactCells(skill, caster, mech, payload, coveredCellRanges, ctx) {
    const impact = impactXOf(skill, caster, mech.emit, ctx);
    const impactCell = field.cellOf(impact);
    const span = skill[mech.emit.cellsFrom];
    const bullets = field.cellRange(span[0], span[1], caster.facing, impact).map((c) => makeBullet(mech.emit.bullet, skill, caster, {
      cell: c, distCells: Math.abs(c - impactCell),
    }, payload));
    return { bullets, impactX: impact };
  },

  pathCells(skill, caster, mech, payload) {
    const bullet = mech.emit.bullet;
    const dir = bullet.dirFrom === 'facing' ? caster.facing : bullet.dir;
    const targetCell = field.cellOf(field.clampX(caster.x + dir * skill[mech.move.cellsFrom] * field.CELL_PX));
    const startCell = field.cellOf(caster.x);
    const bullets = [];
    for (let c = startCell; dir > 0 ? c <= targetCell : c >= targetCell; c += dir) {
      bullets.push(makeBullet(bullet, skill, caster, { cell: c, dir }, payload));
    }
    return { bullets };
  },
};

module.exports = Object.assign(makeSkills(), {
  withLogger: (logger) => makeSkills(logger),
  // 机制表注入（单测覆盖防御分支 / 未来扩展）；缺省 = server/data/*.json
  withTables: (tables, logger) => makeSkills(logger, tables),
});
