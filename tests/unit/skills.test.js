'use strict';
// B6 core/skills.js 契约测试 —— 接口见 docs/interfaces.md §1（instantiateSkill/applySkillPlugins/applyExclusive/canCast/buildSkillAction/coveredCellRanges）
// 依据：docs/content-design.md §6（技能系统：4 条基础模板 + 专属插件声明式覆盖 + 通用插件零代价）；decisions D-07/D-15/D-18/D-21/D-22/D-25/D-29/D-113/D-115/D-118/D-173
// 归属：tasks.md §6 B6（T-SK-1..4）；日志 skills.*（§4.6）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const skills = require('../../server/core/skills.js');

const SKILLS = require('../../server/data/skill-templates.json').skillTemplates;
const PLUGINS = require('../../server/data/plugins.json').plugins;
const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const S = byId(SKILLS);
const P = byId(PLUGINS);
const WHIRL = S.skill_melee;
const HEAVY = S.skill_melee;
const PRECISE = S.skill_straight;
const FIREBALL = S.skill_vertical;
const BASH = S.skill_displace;
const SHADOW = S.skill_displace;

// 品质系数固定 1.00 的 stub（float 的返回值即品质系数 k，见 items.rand）
const one = { float: () => 1.0, int: (lo, hi) => lo, pick: (a) => a[0] };
// 通用技能插件 stub：零代价（D-173 取消 costDeltaByTier），只有词条
const mk = (id, affixes) => ({ id, kind: 'skillPlugin', slot: 'general', quality: 'rare', affixes });

test('T-SK-1/S-1a 实例化：倍率随品质浮动，等级/消耗/射程/弹幕数/衰减不浮动（S-1a/c/e/j/k/l）', () => {
  const s = skills.instantiateSkill(PRECISE, 'common', { float: () => 1.10, int: (lo, hi) => lo, pick: (a) => a[0] });
  assert.equal(s.multiplier, 1.32, 'S-1a 1.2×1.10=1.32');
  assert.equal(s.bulletLevel, 3, 'S-1j 不随品质');
  assert.deepEqual(s.cost, { hp: 0, mp: 4, sp: 2 }, 'S-1k 消耗 copy');
  assert.equal(s.falloff, 0, 'S-1l');
  // S-1c 射程不随品质浮动（copy）；S-1e 弹幕数同样 copy
  const s2 = skills.instantiateSkill(PRECISE, 'common', { float: () => 0.9, int: (lo, hi) => lo, pick: (a) => a[0] });
  assert.equal(s2.range, 5, 'S-1c 射程 copy（不随品质缩放）');
  assert.equal(s2.bulletCount, 1, 'S-1e 弹幕数 copy');
  // 展示/形态字段默认值（§6.2/§6.4：基础模板动画、未装专属、前进、非真伤）
  assert.equal(s2.name, '平射');
  assert.equal(s2.animKey, 'skill_straight');
  assert.equal(s2.sfxKey, 'cast_straight');
  assert.equal(s2.exclusiveId, null, '未装专属插件');
  assert.equal(s2.moveDir, 'forward');
  assert.equal(s2.trueDamage, false);
  // 无 bulletSpeed（D-21）
  assert.equal('bulletSpeed' in s, false);
});

test('T-SK-1/S-6 近战：每格一枚 0 速弹幕（A=736 近战 [0,2]）', () => {
  const skill = skills.instantiateSkill(HEAVY, 'rare', one);
  const act = skills.buildSkillAction(skill, { x: 736, facing: 1 });
  assert.equal(act.type, 'cast');
  assert.equal(act.bullets.length, 3, 'S-6 三枚');
  assert.deepEqual(act.bullets.map((b) => b.x0), [736, 800, 864], '格心 px');
  assert.ok(act.bullets.every((b) => b.v === 0 && b.payload.multiplier === 1 && b.level === 2), '0 速 + 倍率（payload）+ 等级');
  assert.ok(act.bullets.every((b) => b.payload.trueDamage === false), '默认非真伤');
  // coveredCellRanges
  assert.deepEqual(skills.coveredCellRanges(skill, { x: 736, facing: 1 }), [11, 12, 13]);
});

test('T-SK-1/S-7 平射：起点释放者所在格、当 tick 飞完射程（D-20/D-22）', () => {
  const skill = skills.instantiateSkill(PRECISE, 'rare', one);
  const act = skills.buildSkillAction(skill, { x: 736, facing: 1 });
  assert.equal(act.bullets.length, 1);
  const b = act.bullets[0];
  assert.equal(b.x0, 736, 'D-22 生成位置 = 释放者所在格');
  assert.equal(b.dir, 1);
  assert.equal(b.v, 320, '5×64px 当 tick 飞完（D-07/D-20）');
  assert.equal(b.len, 320);
  assert.equal(b.level, 3);
});

test('T-SK-1/S-8 垂直：落点 clamp + area 覆盖格（A=224 定点 range5 area[0,0]）', () => {
  const skill = skills.instantiateSkill(FIREBALL, 'rare', one);
  const act = skills.buildSkillAction(skill, { x: 224, facing: 1 });
  assert.equal(act.impactX, 544, 'S-8 224+5×64=544');
  assert.deepEqual(act.bullets.map((b) => b.x0), [544], '单格落点');
  assert.ok(act.bullets.every((b) => b.payload.falloff === 0.2), '定点衰减 0.2（§6.3：每向外一格 −20%）');
  // 越界：贴边释放落点 clamp（992 朝右 → 目标 1312 → clamp 992）
  const edge = skills.buildSkillAction(skill, { x: 992, facing: 1 });
  assert.equal(edge.impactX, 992, 'clampX 落点 992');
  assert.deepEqual(edge.bullets.map((b) => b.x0), [992], '越界截断到贴边格');
});

test('T-SK-1/S-9 位移：移动意图（默认无伤）+ 专属插件改形态（D-18/D-118，§6.4）', () => {
  // 基础模板：位移 3 格、无伤 → 无路径弹幕
  const bash = skills.instantiateSkill(BASH, 'rare', one);
  const act = skills.buildSkillAction(bash, { x: 736, facing: 1 });
  assert.equal(act.move.dir, 1);
  assert.equal(act.move.cells, 3, '距离 3 格');
  assert.equal(act.move.passThroughEnemy, false);
  assert.equal(act.move.dealDamage, false);
  assert.equal(act.move.fullDodgeDuring, false);
  assert.deepEqual(act.bullets, [], 'dealDamage=false 无路径弹幕（D-18④）');
  // 专属「盾突 ex_bash」：造成伤害 + 多一格路径弹幕（736→928 = 格 11~14）
  const bash2 = skills.applySkillPlugins(skills.instantiateSkill(SHADOW, 'rare', one), [P.ex_bash]);
  const act2 = skills.buildSkillAction(bash2, { x: 736, facing: 1 });
  assert.equal(bash2.exclusiveId, 'ex_bash');
  assert.equal(bash2.name, '盾突', '技能名 = 专属插件名');
  assert.equal(bash2.multiplier, 0.8, '专属覆盖倍率');
  assert.equal(bash2.cost.sp, 32, '专属自带代价（§6.4：adv 19.07 → sp32/cd4）');
  assert.equal(bash2.cooldown, 4);
  assert.deepEqual(bash2.castEffects, [{ kind: 'continuous', stat: 'def', delta: 4, remaining: 2 }], '专属释放类效果');
  assert.equal(act2.move.dealDamage, true);
  assert.deepEqual(act2.bullets.map((b) => b.x0), [736, 800, 864, 928], 'D-18 声明路径每格一枚（含终点格）');
  assert.ok(act2.bullets.every((b) => b.level === 1 && b.v === 0), 'D-118 路径弹幕等级=模板 bulletLevel');
  // 专属「瞬移 ex_blink」：穿敌 + 全程闪避 + 距离 5
  const shadow = skills.applySkillPlugins(skills.instantiateSkill(SHADOW, 'rare', one), [P.ex_blink]);
  const act3 = skills.buildSkillAction(shadow, { x: 736, facing: -1 });
  assert.equal(act3.move.dir, -1);
  assert.equal(act3.move.cells, 5);
  assert.equal(act3.move.passThroughEnemy, true);
  assert.equal(act3.move.dealDamage, false);
  assert.equal(act3.move.fullDodgeDuring, true);
  assert.equal(shadow.animKey, 'ex_blink', '动画键随专属插件');
  assert.deepEqual(act3.bullets, [], '不改 dealDamage 时仍无路径弹幕');
  // 专属「后撤 ex_retreat」：背向位移（朝向不变）
  const back = skills.applySkillPlugins(skills.instantiateSkill(SHADOW, 'rare', one), [P.ex_retreat]);
  const act4 = skills.buildSkillAction(back, { x: 736, facing: 1 });
  assert.equal(act4.move.dir, -1, 'moveDir=backward → 反朝向');
  assert.equal(act4.move.cells, 2);
});

test('T-SK-2/S-2 通用插件叠加：词条生效且**零代价**（倍率/冷却/射程/等级/减耗/真伤）', () => {
  const base = skills.instantiateSkill(PRECISE, 'rare', one);
  // S-2b 倍率提升 +15%
  const r1 = skills.applySkillPlugins(base, [mk('sk_mult', [{ id: 'mult_up', params: { v: 0.15 } }])]);
  assert.equal(r1.multiplier, 1.38, 'S-2b 1.2×1.15=1.38');
  assert.deepEqual(r1.cost, { hp: 0, mp: 4, sp: 2 }, '通用插件零代价（D-173）');
  // 百分比冷却缩减 −25%（向下取整，下限 1）：近战 cd3 → floor(3×0.75) = 2
  const meleeCd = skills.applySkillPlugins(skills.instantiateSkill(HEAVY, 'rare', one), [P.sk_cd_down]);
  assert.equal(meleeCd.cooldown, 2, 'cd 3 → 2（−25% 向下取整）');
  assert.equal(skills.applySkillPlugins(base, [P.sk_cd_down]).cooldown, 1, 'cd 1 → 下限 1（不被压到 0）');
  // 射程 +2 → 5→7
  const r3 = skills.applySkillPlugins(r1, [mk('sk_range', [{ id: 'range_plus', params: { v: 2 } }])]);
  assert.equal(r3.range, 7);
  // 等级凝练 L3→L2
  const r4 = skills.applySkillPlugins(r3, [mk('sk_level', [{ id: 'level_up', params: { v: 1 } }])]);
  assert.equal(r4.bulletLevel, 2);
  // 减耗 −20% 用 ceil：近战 sp 11 → 9
  const melee = skills.instantiateSkill(HEAVY, 'rare', one);
  const r5 = skills.applySkillPlugins(melee, [mk('sk_cost_down', [{ id: 'cost_down', params: { v: 0.2 } }])]);
  assert.equal(r5.cost.sp, 9, 'ceil(11×0.8)=9');
  // 真伤替换：倍率 −10% + trueDamage
  const r6 = skills.applySkillPlugins(base, [P.sk_true]);
  assert.equal(r6.multiplier, 1.08, '1.2×0.9=1.08');
  assert.equal(r6.trueDamage, true, '整次命中改真伤');
  const act = skills.buildSkillAction(r6, { x: 736, facing: 1 });
  assert.equal(act.bullets[0].payload.trueDamage, true, '真伤随 payload 下发');
});

test('T-SK-2/S-4 下限 clamp：等级凝练连装到 1、百分比减冷却下限 1（D-115）', () => {
  const base = skills.instantiateSkill(PRECISE, 'rare', one);
  const r1 = skills.applySkillPlugins(base, [mk('sk_level', [{ id: 'level_up', params: { v: 1 } }])]);
  const r2 = skills.applySkillPlugins(r1, [mk('sk_level', [{ id: 'level_up', params: { v: 1 } }])]);
  assert.equal(r2.bulletLevel, 1, 'S-4 等级下限 1');
  const r3 = skills.applySkillPlugins(skills.instantiateSkill(HEAVY, 'rare', one), [mk('sk_cd_down', [{ id: 'cooldown_down', params: { v: 0.9 } }])]);
  assert.equal(r3.cooldown, 1, '百分比减冷却下限 1（minCooldownReduced；floor(3×0.1)=0 → 1）');
  const whirl = skills.instantiateSkill(WHIRL, 'rare', { float: () => 0.1, int: (lo, hi) => lo, pick: (a) => a[0] });
  assert.equal(whirl.cooldown, 0, 'S-1h 冷却下限 0（0.1→0，模板生成期）');
});

test('T-SK-4/S-5 canCast 全分支：成功扣资源写 CD / 冷却 / 资源不足 / 资源恰等', () => {
  const base = skills.instantiateSkill(PRECISE, 'rare', one);
  const caster = { hp: 100, mp: 40, sp: 60, cooldowns: {}, cooldownTicks: {} };
  // S-5a 成功
  const ok = skills.canCast(base, { ...caster });
  assert.equal(ok.ok, true, 'S-5a');
  assert.equal(ok.caster.mp, 36, 'mp 40−4');
  assert.equal(ok.caster.sp, 58, 'sp 60−2');
  assert.equal(ok.caster.cooldowns.skill_straight, 1, 'S-5a 写 CD=1');
  // 冷却键 = 槽位键（P1-4）：同一模板两槽 CD 独立
  const slot = skills.canCast(base, { ...caster, cooldowns: { skill1: 2 } }, 'skill1');
  assert.equal(slot.ok, false, 'S-5d 槽位键冷却中');
  assert.equal(slot.reason, 'cooldown');

  // S-5b 冷却中
  const c2 = { hp: 100, mp: 40, sp: 60, cooldowns: { skill_straight: 2 } };
  const r2 = skills.canCast(base, c2);
  assert.equal(r2.ok, false, 'S-5b');
  assert.equal(r2.reason, 'cooldown');
  assert.equal(c2.sp, 60, '失败不扣资源');
  // S-5c 资源不足（cost sp2，只有 1）
  const c3 = { hp: 100, mp: 40, sp: 1, cooldowns: {} };
  const r3 = skills.canCast(base, c3);
  assert.equal(r3.ok, false, 'S-5c');
  assert.equal(r3.reason, 'resource');
  // S-5e 资源恰等（≥ 语义）
  const c4 = { hp: 100, mp: 4, sp: 2, cooldowns: {} };
  const r4 = skills.canCast(base, { ...c4 });
  assert.equal(r4.ok, true, 'S-5e');
  assert.equal(r4.caster.mp, 0);
  assert.equal(r4.caster.sp, 0);
});

test('T-SK-3 越界：clamp 与格区间丢弃（贴边 AOE 截断）', () => {
  const heavy = skills.instantiateSkill(HEAVY, 'rare', one);
  const edge = skills.buildSkillAction(heavy, { x: 992, facing: 1 });
  assert.deepEqual(edge.bullets.map((b) => b.x0), [992], 'F-26 只覆盖格 15');
  const edge2 = skills.buildSkillAction(heavy, { x: 32, facing: -1 });
  assert.deepEqual(edge2.bullets.map((b) => b.x0), [32], 'F-27 贴边截断（[0,2] 朝左 → 仅格 0）');
});

test('SK-8 插件词条矩阵（分支覆盖）：弹幕数/射程各类型/位移增强/近战不可增强/概率类', () => {
  // bulletUp：平射 1→2
  const p = skills.instantiateSkill(PRECISE, 'rare', one);
  const r1 = skills.applySkillPlugins(p, [mk('sk_bullet', [{ id: 'bullet_plus', params: { v: 1 } }])]);
  assert.equal(r1.bulletCount, 2, '弹幕增强 +1');
  // rangeUp vertical：定点 range 5→7
  const fb = skills.instantiateSkill(FIREBALL, 'rare', one);
  const r2 = skills.applySkillPlugins(fb, [mk('sk_range', [{ id: 'range_plus', params: { v: 2 } }])]);
  assert.equal(r2.range, 7, '定点射程 +2');
  // rangeUp displacement：按登记取向作用于 distance（位移 3→5）
  const bs = skills.instantiateSkill(BASH, 'rare', one);
  const r3 = skills.applySkillPlugins(bs, [mk('sk_range', [{ id: 'range_plus', params: { v: 2 } }])]);
  assert.equal(r3.distance, 5, '位移距离 +2（slots.range → distance）');
  // distUp：距离 +1
  const r4 = skills.applySkillPlugins(bs, [mk('sk_dist', [{ id: 'distance_plus', params: { v: 1 } }])]);
  assert.equal(r4.distance, 4, '位移增强 +1');
  // rangeUp melee：不可增强（槽位缺席）
  const hv = skills.instantiateSkill(HEAVY, 'rare', one);
  const r5 = skills.applySkillPlugins(hv, [mk('sk_range', [{ id: 'range_plus', params: { v: 2 } }])]);
  assert.deepEqual(r5.range, [0, 2], '近战范围不可增强');
  // 命中类词条登记（engine 命中结算读取）
  const r6 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [mk('sk_stun', [{ id: 'stun', params: { v: 1 } }])]);
  assert.deepEqual(r6.affixes, [{ id: 'stun', params: { v: 1 } }], 'stun 登记进 affixes');
  // 概率类词条登记进 specials（随 payload 下发）
  const r7 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [P.sk_critdmg]);
  assert.equal(r7.specials.critMul, 0.17, '暴击倍率进 specials');
  // 专属插件类型绑定：装错类型不生效
  const r8 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [P.ex_bash]);
  assert.equal(r8.exclusiveId, null, '专属插件 forTypes 不符 → 不生效');
  assert.equal(r8.multiplier, 1.2);
});

test('SK-10 补充分支：字符串模板 / coveredCellRanges 各类型 / 空词条插件 / hp 消耗 canCast', () => {
  // 字符串模板实例化
  const s = skills.instantiateSkill('skill_melee', 'rare', one);
  assert.equal(s.sid, 'skill_melee');
  // coveredCellRanges：melee / vertical / straight（空）
  assert.deepEqual(skills.coveredCellRanges(s, { x: 736, facing: 1 }), [11, 12, 13]);
  assert.deepEqual(skills.coveredCellRanges(skills.instantiateSkill(FIREBALL, 'rare', one), { x: 224, facing: 1 }), [8]);
  assert.deepEqual(skills.coveredCellRanges(skills.instantiateSkill(PRECISE, 'rare', one), { x: 500, facing: 1 }), [], '平射无覆盖格');
  // 无 affixes 字段的插件（`|| []` falsy 分支）：技能不变
  const r1 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [{ id: 'bare', kind: 'skillPlugin', slot: 'general', quality: 'rare' }]);
  assert.equal(r1.multiplier, 1.2, '无词条 → 倍率不变');
  assert.deepEqual(r1.cost, { hp: 0, mp: 4, sp: 2 }, '无词条 → 无代价');
  // hp 消耗技能 canCast
  const hpSkill = { sid: 'hp_cost', templateId: 'hp_cost', type: 'melee', cost: { hp: 5, mp: 0, sp: 0 }, cooldown: 1 };
  const c = skills.canCast(hpSkill, { hp: 8, mp: 0, sp: 0, cooldowns: {} });
  assert.equal(c.ok, true);
  assert.equal(c.caster.hp, 3, 'hp 消耗扣减');
  assert.equal(c.caster.cooldowns.hp_cost, 1);
  // caster 无 cooldowns 字段（短路分支）
  const c2 = skills.canCast(hpSkill, { hp: 8, mp: 0, sp: 0 });
  assert.equal(c2.ok, true, '无 cooldowns 字段不炸');
  assert.equal(c2.caster.cooldowns.hp_cost, 1);
  // bullet_plus 装在近战（无 bulletCount 字段 → 不生效）
  const r3 = skills.applySkillPlugins(skills.instantiateSkill(HEAVY, 'rare', one), [mk('sk_bullet', [{ id: 'bullet_plus', params: { v: 1 } }])]);
  assert.equal(r3.type, 'melee', '近战无 bulletCount 字段，不受影响');
});

test('SK-11 资源不足条件矩阵 + 单维减耗（sp/mp 各自生效，ceil）', () => {
  const costSkill = (cost) => ({ sid: 'x', templateId: 'x', type: 'melee', cost, cooldown: 1 });
  // hp 不足触发（短路第一条件）
  const a = skills.canCast(costSkill({ hp: 10, mp: 0, sp: 0 }), { hp: 5, mp: 0, sp: 0, cooldowns: {} });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'resource');
  // mp 不足触发（短路第二条件）
  const b = skills.canCast(costSkill({ hp: 0, mp: 10, sp: 0 }), { hp: 100, mp: 5, sp: 0, cooldowns: {} });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'resource');
  // sp 不足触发（短路第三条件）
  const c = skills.canCast(costSkill({ hp: 0, mp: 0, sp: 10 }), { hp: 100, mp: 100, sp: 5, cooldowns: {} });
  assert.equal(c.ok, false);
  assert.equal(c.reason, 'resource');
  // 单维减耗：近战 sp 11 → 9（只作用 sp 维度）
  const melee = skills.instantiateSkill(HEAVY, 'rare', one);
  const r = skills.applySkillPlugins(melee, [mk('sk_sp_down', [{ id: 'cost_down_sp', params: { v: 0.2 } }])]);
  assert.equal(r.cost.sp, 9, 'SP 消耗 −20%');
  assert.equal(r.cost.mp, 0, 'mp 维度不受影响');
  const r2 = skills.applySkillPlugins(melee, [mk('sk_mp_down', [{ id: 'cost_down_mp', params: { v: 0.2 } }])]);
  assert.equal(r2.cost.sp, 11, 'mp 维度减耗不影响 sp');
  assert.equal(r2.cost.mp, 0);
});

test('SK-12 裸插件分支：未登记词条 warn 跳过 / 未登记算子 warn 跳过', () => {
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const sk = skills.withLogger(logger);
  // 未登记词条 id → warn + 跳过（技能不变）
  const r1 = sk.applySkillPlugins(sk.instantiateSkill(PRECISE, 'rare', one), [mk('sk_unknown', [{ id: 'no_such_affix', params: { v: 1 } }])]);
  assert.equal(r1.multiplier, 1.2, '未登记词条不生效');
  assert.ok(logger.records.some((x) => x.event === 'skill.plugin.unknown'), '应有 skill.plugin.unknown');
  // 未登记算子 → warn + 跳过（机制表注入 fake registry）
  const L2 = createLogger({ level: 'all', ringSize: 200 });
  const fake = skills.withTables({ registry: { affixes: { bad_op: { domain: 'skill', roll: 'stat', skillOp: { op: 'not_an_op' } } }, caps: { probability: 1 } } }, L2);
  const r2 = fake.applySkillPlugins(fake.instantiateSkill(PRECISE, 'rare', one), [mk('sk_bad', [{ id: 'bad_op', params: { v: 1 } }])]);
  assert.equal(r2.multiplier, 1.2, '未登记算子不生效');
  assert.ok(L2.records.some((x) => x.event === 'skill.plugin.unknown' && x.data.op === 'not_an_op'), '应有未登记算子 warn');
  // distUp 装在平射（位移槽位缺失 → 不生效）
  const r3 = sk.applySkillPlugins(sk.instantiateSkill(PRECISE, 'rare', one), [mk('sk_dist', [{ id: 'distance_plus', params: { v: 1 } }])]);
  assert.equal(r3.type, 'straight', '平射无 distance 不受影响');
  // 专属插件未登记效果字段（无 exclusive 块）→ 只补 id/展示，不炸
  const r4 = sk.applySkillPlugins(sk.instantiateSkill(PRECISE, 'rare', one), [{ id: 'ex_bare', kind: 'skillPlugin', slot: 'exclusive', name: '空专属', affixes: [] }]);
  assert.equal(r4.exclusiveId, 'ex_bare');
  assert.equal(r4.name, '空专属');
  assert.equal(r4.multiplier, 1.2, '无覆盖时不改数值');
});

test('SK-13 防御分支：专属覆盖的标量/逐品质/名称兜底 + 算子缺省参数（覆盖 `?:`/`||` 兜底路径）', () => {
  // ① 专属覆盖：标量 range/area、cost 覆盖、qualityOverrides、specials、内联效果、name 兜底（空名保留模板名）
  const ex = {
    id: 'ex_syn', kind: 'skillPlugin', slot: 'exclusive', name: '', quality: 'mythic',
    animKey: 'anim_syn', sfxKey: 'sfx_syn', affixes: [],
    exclusive: {
      forTypes: ['straight'],
      overrides: { range: 7, area: 3, cost: { mp: 5 } },
      qualityOverrides: { mythic: { bulletCount: 5, area: [-6, 6] } },
      specials: { critChance: 2 },
      hitEffects: [{ kind: 'control', remaining: 1, params: { v: 1 } }],
      castEffects: [{ kind: 'continuous', stat: 'atk', delta: 2, remaining: 2 }],
    },
  };
  const s1 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [ex]);
  assert.equal(s1.range, 7, '标量 range 覆盖');
  assert.deepEqual(s1.area, [-6, 6], '逐品质覆盖（数组）优先于标量 area');
  assert.equal(s1.bulletCount, 5, 'qualityOverrides（mythic）生效');
  assert.deepEqual(s1.cost, { hp: 0, mp: 5, sp: 0 }, 'cost 覆盖（缺省维补 0）');
  assert.equal(s1.specials.critChance, 1, '专属 specials 按 caps.probability 封顶');
  assert.equal(s1.name, '平射', '插件名为空 → 保留模板名（`||` 兜底）');
  assert.equal(s1.animKey, 'anim_syn');
  assert.equal(s1.affixes.length, 1, '内联 hitEffects 进 affixes');
  assert.deepEqual(s1.castEffects, [{ kind: 'continuous', stat: 'atk', delta: 2, remaining: 2 }]);
  // ② 缺省字段的技能实例（无 specials/castEffects）：`|| {}` / `|| []` 兜底
  const bare = skills.instantiateSkill(PRECISE, 'rare', one);
  delete bare.specials;
  delete bare.castEffects;
  const s2 = skills.applySkillPlugins(bare, [{ id: 'x', slot: 'general', affixes: [{ id: 'crit_chance', params: { v: 0.1 } }, { id: 'cast_buff', params: { v: 2, duration: 2 } }, { id: 'mult_up' }] }]);
  assert.equal(s2.specials.critChance, 0.1, '缺 specials 字段 → 兜底为空对象');
  assert.deepEqual(s2.castEffects, [{ kind: 'continuous', stat: 'atk', delta: 2, remaining: 2 }]);
  assert.equal(s2.multiplier, 1.2, '缺 params 的词条按 v=0 处理');
  assert.deepEqual(s2.affixes, [], '无命中类词条');
  assert.equal(skills.buildSkillAction(s2, { x: 736, facing: 1 }).bullets.length, 1, '构建释放指令时缺省 specials/castEffects 不炸');
  // ③ 未登记技能类型 → coveredCellRanges 返回空
  assert.deepEqual(skills.coveredCellRanges({ type: 'nope', range: 5 }, { x: 0, facing: 1 }), []);
  // ④ 算子缺省参数（fake registry 注入）：min 缺省 / min 键未登记 / round 缺省 / castEffect 无 durationFrom
  const fake = skills.withTables({
    registry: {
      affixes: {
        cd_bare: { domain: 'skill', roll: 'stat', skillOp: { op: 'scaleCooldownPct', field: 'cooldown' } },
        cd_bad_min: { domain: 'skill', roll: 'stat', skillOp: { op: 'scaleCooldownPct', field: 'cooldown', min: 'nope' } },
        sub_bare: { domain: 'skill', roll: 'int', skillOp: { op: 'sub', field: 'cooldown' } },
        pct_bare: { domain: 'skill', roll: 'stat', skillOp: { op: 'scalePct', field: 'multiplier' } },
        add_bare: { domain: 'skill', roll: 'int', skillOp: { op: 'add', field: 'bulletCount' } },
        cost_bad_dim: { domain: 'skill', roll: 'stat', skillOp: { op: 'scaleCostCeilByDim', dim: 'xx' } },
        buff_bare: { domain: 'skill', roll: 'stat', castEffect: { kind: 'continuous', stat: 'atk', deltaFrom: 'v', fallbackDuration: 2 } },
      },
      caps: { probability: 1 },
    },
  });
  const melee = fake.instantiateSkill(HEAVY, 'rare', one);
  assert.equal(fake.applySkillPlugins(melee, [{ id: 'a', slot: 'general', affixes: [{ id: 'cd_bare', params: { v: 0.25 } }] }]).cooldown, 2, 'min 缺省 → 下限 1');
  assert.equal(fake.applySkillPlugins(melee, [{ id: 'b', slot: 'general', affixes: [{ id: 'cd_bad_min', params: { v: 0.25 } }] }]).cooldown, 2, 'min 键未登记 → 下限 1');
  assert.equal(fake.applySkillPlugins(melee, [{ id: 'c', slot: 'general', affixes: [{ id: 'sub_bare', params: { v: 1 } }] }]).cooldown, 2, 'sub 缺 min → 下限 0');
  const precise = fake.instantiateSkill(PRECISE, 'rare', one);
  assert.equal(fake.applySkillPlugins(precise, [{ id: 'd', slot: 'general', affixes: [{ id: 'pct_bare', params: { v: 0.1 } }] }]).multiplier, 1.32, 'scalePct 缺 round → precision.stat');
  assert.equal(fake.applySkillPlugins(precise, [{ id: 'e', slot: 'general', affixes: [{ id: 'add_bare', params: { v: 1 } }] }]).bulletCount, 2, 'add 缺 min → 下限 0');
  assert.deepEqual(fake.applySkillPlugins(precise, [{ id: 'f', slot: 'general', affixes: [{ id: 'cost_bad_dim', params: { v: 0.2 } }] }]).cost, { hp: 0, mp: 4, sp: 2 }, '单维减耗维度未登记 → 整条不生效');
  assert.deepEqual(fake.applySkillPlugins(precise, [{ id: 'g', slot: 'general', affixes: [{ id: 'buff_bare', params: { v: 2 } }] }]).castEffects,
    [{ kind: 'continuous', stat: 'atk', delta: 2, remaining: 2 }], 'castEffect 无 durationFrom → fallbackDuration');
});

test('SK-7 日志：skill.instantiate / skill.plugin.apply / skill.area / skill.cast / skill.reject（§4.6 五事件）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const sk = skills.withLogger(logger);
  const s = sk.instantiateSkill(PRECISE, 'rare', one);
  assert.ok(logger.records.some((x) => x.event === 'skill.instantiate' && x.data.templateId === 'skill_straight'), '应有 skill.instantiate');
  const r1 = sk.applySkillPlugins(s, [mk('sk_mult', [{ id: 'mult_up', params: { v: 0.15 } }])]);
  assert.ok(logger.records.some((x) => x.event === 'skill.plugin.apply'), '应有 skill.plugin.apply');
  sk.coveredCellRanges(sk.instantiateSkill(HEAVY, 'rare', one), { x: 736, facing: 1 });
  const area = logger.records.find((x) => x.event === 'skill.area');
  assert.ok(area, '应有 skill.area（审查 P2-1）');
  assert.deepEqual(area.data.cells, [11, 12, 13]);
  const caster = { hp: 100, mp: 40, sp: 60, cooldowns: {}, cooldownTicks: {} };
  sk.canCast(r1, caster);
  assert.ok(logger.records.some((x) => x.event === 'skill.cast'), '应有 skill.cast');
  sk.canCast(r1, { hp: 100, mp: 40, sp: 60, cooldowns: { skill_straight: 1 } });
  assert.ok(logger.records.some((x) => x.event === 'skill.reject' && x.data.reason === 'cooldown'), '应有 skill.reject');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    const b = skills.instantiateSkill(HEAVY, 'rare', one);
    skills.buildSkillAction(b, { x: 500, facing: 1 });
    skills.coveredCellRanges(b, { x: 500, facing: 1 });
    skills.canCast(b, { hp: 100, mp: 100, sp: 100, cooldowns: {} });
  });
});
