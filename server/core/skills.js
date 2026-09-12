'use strict';
/* server/core/skills.js —— 技能系统（P1 B6，契约 docs/interfaces.md §1）
 * 依据：systems/03-skills.md；examples/03-skills.md S-1..S-9（数值期望唯一出处）；decisions D-07/D-15/D-18/D-21/D-22/D-25/D-29/D-113/D-115/D-118。
 * 纯函数内核（L11）：随机走注入 rng；canCast/applySkillPlugins 不改入参（纯函数，返回新对象）；日志经 withLogger 注入。
 * 事件：skill.instantiate(debug) / skill.plugin.apply(debug) / skill.cast(info) / skill.reject(warn)（§4.6）。
 * 语义（B6 登记）：
 *   - sid = templateId（物品链 B20 可另行分配实例 uid，引擎 cooldowns 键用 sid）。
 *   - instantiateSkill 复用 items.generateSkillItem 的参数随机（同构，避免双实现）。
 *   - 消耗补偿：costDeltaByTier 按**插件品质**的 costDeltaBase 缩放：档位 i 增量 = costDeltaBase[quality] × (i+1)（D-113，S-2b rare tier1=mp+3）。
 *   - 减耗类（costDeltaByTier=null）：cost × (1−v) 后 **ceil**（S-3）。
 *   - 特殊效果词条（stun/knockback/pull/dot/true_dmg/crit/lifesteal/cast_buff）只登记进 skill.affixes，命中结算（B9）读取。
 */
const { nullLogger } = require('../../shared/log.js');
const items = require('./items.js');
const field = require('./field.js');

const QUALITIES = require('../data/qualities.json');
const SKILL_TEMPLATES = require('../data/skill-templates.json').skillTemplates;
const skillMap = Object.fromEntries(SKILL_TEMPLATES.map((t) => [t.id, t]));

// 指定档位 → 实例化后的词条值（生成层级已缩放；本模块接收插件实例或构造插件）
function makeSkills(logger) {
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
      falloff: p.falloff, affixes: [],
    };
    L.debug('skills', 'skill.instantiate', `skill ${t.id} ${qualityId}`, { templateId: t.id, quality: qualityId });
    return skill;
  }

  // 插件叠加（S-2/S-3/S-4；纯函数返回新实例）
  function applySkillPlugins(skill, plugins) {
    let out = {
      ...skill, cost: { ...skill.cost }, affixes: [...skill.affixes],
      multiplier: skill.multiplier, cooldown: skill.cooldown, bulletLevel: skill.bulletLevel,
    };
    const costBaseOf = QUALITIES.costDeltaBase;
    for (const p of (plugins || [])) {
      // 特殊效果词条登记（命中结算 B9 读取）
      const specials = (p.affixes || []).filter((a) => ['stun', 'knockback', 'pull', 'dot', 'true_dmg', 'crit_chance', 'lifesteal', 'cast_buff'].includes(a.id));
      if (specials.length) out = { ...out, affixes: [...out.affixes, ...specials] };
      // 基础类词条
      const mult = (p.affixes || []).find((a) => a.id === 'mult_up');
      const cdDown = (p.affixes || []).find((a) => a.id === 'cooldown_down');
      const rangeUp = (p.affixes || []).find((a) => a.id === 'range_plus');
      const bulletUp = (p.affixes || []).find((a) => a.id === 'bullet_plus');
      const levelUp = (p.affixes || []).find((a) => a.id === 'level_up');
      const distUp = (p.affixes || []).find((a) => a.id === 'distance_plus');
      const costDown = (p.affixes || []).find((a) => a.id === 'cost_down');
      if (mult) out.multiplier = Math.round(out.multiplier * (1 + mult.params.v) * 1000) / 1000;
      if (cdDown) out.cooldown = Math.max(0, out.cooldown - cdDown.params.v);
      if (rangeUp) {
        if (out.type === 'straight') out.range = out.range + rangeUp.params.v;
        else if (out.type === 'vertical') out.range = out.range + rangeUp.params.v;
        else if (out.type === 'displacement') out.distance = out.distance + rangeUp.params.v;
        // melee 范围不可增强（登记，B21 校准）
      }
      if (bulletUp && out.type === 'straight') out.bulletCount = out.bulletCount + bulletUp.params.v;
      if (levelUp) out.bulletLevel = Math.max(1, out.bulletLevel - levelUp.params.v); // S-4 下限 1（D-115）
      if (distUp && out.type === 'displacement') out.distance = out.distance + distUp.params.v;
      // 消耗补偿（D-113）：非减耗类 + costDeltaBase[quality]×tier（缺失品质 = common 基准，L9 读表）
      if (p.costDeltaByTier !== null && p.tier) {
        const base = costBaseOf[p.quality] ?? costBaseOf.common;
        const delta = base * p.tier;
        const dims = p.costDeltaByTier || {};
        for (const dim of ['hp', 'mp', 'sp']) {
          if (Array.isArray(dims[dim])) out.cost[dim] = out.cost[dim] + delta;
        }
      }
      // 减耗类（costDeltaByTier=null）：ceil 应用（S-3）
      if (costDown && p.costDeltaByTier === null) {
        const factor = 1 - costDown.params.v;
        out.cost = {
          hp: Math.ceil(out.cost.hp * factor),
          mp: Math.ceil(out.cost.mp * factor),
          sp: Math.ceil(out.cost.sp * factor),
        };
      }
      L.debug('skills', 'skill.plugin.apply', `plugin ${p.id || '?'} tier ${p.tier || 1}`, { pluginId: p.id, tier: p.tier });
    }
    return out;
  }

  // 释放判定（S-5；纯函数：成功返回扣资源/写 CD 后的克隆 caster）
  function canCast(skill, caster) {
    const sid = skill.sid || skill.templateId;
    if ((caster.cooldowns && caster.cooldowns[sid]) > 0) {
      L.warn('skills', 'skill.reject', `skill ${sid} cooldown`, { reason: 'cooldown', sid });
      return { ok: false, reason: 'cooldown' };
    }
    const c = skill.cost;
    if (caster.hp < c.hp || caster.mp < c.mp || caster.sp < c.sp) {
      L.warn('skills', 'skill.reject', `skill ${sid} resource`, { reason: 'resource', sid });
      return { ok: false, reason: 'resource' };
    }
    const next = {
      ...caster,
      hp: caster.hp - c.hp,
      mp: caster.mp - c.mp,
      sp: caster.sp - c.sp,
      cooldowns: { ...(caster.cooldowns || {}), [sid]: skill.cooldown },
    };
    L.info('skills', 'skill.cast', `skill ${sid} cast`, { sid, cost: c });
    return { ok: true, caster: next };
  }

  // 覆盖格集合（T-SK-3/F-20..27 语义；melee/vertical 用；skill.area(trace) 记录 px 区间，§4.6）
  function coveredCellRanges(skill, caster) {
    if (skill.type === 'melee') {
      const cells = field.cellRange(skill.range[0], skill.range[1], caster.facing, caster.x);
      L.trace('skills', 'skill.area', `melee cells=${cells.join(',')}`, { type: 'melee', cells });
      return cells;
    }
    if (skill.type === 'vertical') {
      const impact = field.clampX(caster.x + caster.facing * skill.range * field.CELL_PX);
      const cells = field.cellRange(skill.area[0], skill.area[1], caster.facing, impact);
      L.trace('skills', 'skill.area', `vertical cells=${cells.join(',')} impact=${impact}`, { type: 'vertical', cells, impactX: impact });
      return cells;
    }
    return [];
  }

  // 释放指令（S-6..S-9）：{type:'cast', skill, bullets, move?, impactX?}
  function buildSkillAction(skill, caster) {
    const payload = { multiplier: skill.multiplier, falloff: skill.falloff, affixes: skill.affixes };
    const x = caster.x;
    const dir = caster.facing;
    const CELL = field.CELL_PX;
    const bullets = [];

    if (skill.type === 'melee') {
      const cells = coveredCellRanges(skill, caster);
      const originCell = field.cellOf(x);
      for (const c of cells) {
        bullets.push({
          btype: 'aoe', x0: field.xCenter(c), v: 0, len: 0, dir: 0,
          level: skill.bulletLevel, payload: { ...payload, distCells: Math.abs(c - originCell) },
        });
      }
    } else if (skill.type === 'straight') {
      for (let i = 0; i < skill.bulletCount; i++) {
        bullets.push({
          btype: 'straight', x0: x, dir, v: skill.range * CELL, len: skill.range * CELL,
          level: skill.bulletLevel, payload: { ...payload }, // 逐枚拷贝（审查 P2-2）
        });
      }
    } else if (skill.type === 'vertical') {
      const impact = field.clampX(x + dir * skill.range * CELL);
      const cells = field.cellRange(skill.area[0], skill.area[1], dir, impact);
      const impactCell = field.cellOf(impact);
      for (const c of cells) {
        bullets.push({
          btype: 'aoe', x0: field.xCenter(c), v: 0, len: 0, dir: 0,
          level: skill.bulletLevel, payload: { ...payload, distCells: Math.abs(c - impactCell) },
        });
      }
      return { type: 'cast', skill, impactX: impact, bullets };
    } else if (skill.type === 'displacement') {
      // 路径弹幕（D-18/D-118）：声明路径起点格起每格一枚 0 速弹幕（与是否被碰撞截停无关）
      if (skill.dealDamage) {
        const targetCell = field.cellOf(field.clampX(x + dir * skill.distance * CELL));
        const startCell = field.cellOf(x);
        for (let c = startCell; dir > 0 ? c <= targetCell : c >= targetCell; c += dir) {
          bullets.push({
            btype: 'aoe', x0: field.xCenter(c), v: 0, len: 0, dir: 0,
            level: skill.bulletLevel, payload: { ...payload },
            // 注意（审查 P2-3）：位移路径弹幕无 distCells——falloff 距离基准由 B9 命中结算时定义（当前位移技能 falloff 恒 0）
          });
        }
      }
      return {
        type: 'cast', skill,
        move: {
          dir, cells: skill.distance,
          passThroughEnemy: skill.passThroughEnemy,
          dealDamage: skill.dealDamage,
          fullDodgeDuring: skill.fullDodgeDuring,
        },
        bullets,
      };
    }
    return { type: 'cast', skill, bullets };
  }

  return { instantiateSkill, applySkillPlugins, canCast, buildSkillAction, coveredCellRanges };
}

module.exports = Object.assign(makeSkills(), { withLogger: (logger) => makeSkills(logger) });