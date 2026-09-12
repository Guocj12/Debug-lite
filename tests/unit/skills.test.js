'use strict';
// B6 core/skills.js 契约测试 —— 接口见 docs/interfaces.md §1（instantiateSkill/applySkillPlugins/canCast/buildSkillAction/coveredCellRanges）
// 依据：examples/03-skills.md S-1..S-9（数值期望唯一出处）；decisions D-07/D-15/D-18/D-21/D-22/D-25/D-29/D-113/D-115/D-118
// 归属：tasks.md §6 B6（T-SK-1..4）；日志 skills.*（§4.6）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const skills = require('../../server/core/skills.js');

const SKILLS = require('../../server/data/skill-templates.json').skillTemplates;
const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const S = byId(SKILLS);
const WHIRL = S.skill_melee_whirl;
const HEAVY = S.skill_melee_heavy;
const PRECISE = S.skill_straight_precise;
const FIREBALL = S.skill_vert_fireball;
const BASH = S.skill_dash_bash;
const SHADOW = S.skill_dash_shadow;

// 品质系数固定 1.00 的 stub
const one = { float: () => 1.0, int: (lo, hi) => lo, pick: (a) => a[0] };

test('T-SK-1/S-1a 实例化：倍率/冷却取整、弹幕等级/消耗/falloff 不随品质（S-1a/j/k/l）', () => {
  const s = skills.instantiateSkill(PRECISE, 'common', { float: () => 1.10, int: (lo, hi) => lo, pick: (a) => a[0] });
  assert.equal(s.multiplier, 0.99, 'S-1a 0.9×1.10=0.99');
  assert.equal(s.bulletLevel, 3, 'S-1j 不随品质');
  assert.deepEqual(s.cost, { hp: 0, mp: 0, sp: 6 }, 'S-1k');
  assert.equal(s.falloff, 0, 'S-1l');
  // S-1c 射程缩短、S-1e 数量下限
  const s2 = skills.instantiateSkill(PRECISE, 'common', { float: () => 0.9, int: (lo, hi) => lo, pick: (a) => a[0] });
  assert.equal(s2.range, 7, 'S-1c 8×0.9=7.2→7');
  assert.equal(s2.bulletCount, 1, 'S-1e 下限 1');
  // 无 bulletSpeed（D-21）
  assert.equal('bulletSpeed' in s, false);
});

test('T-SK-1/S-6 近战：每格一枚 0 速弹幕（A=736 重击 [0,2]）', () => {
  const skill = skills.instantiateSkill(HEAVY, 'rare', one);
  const act = skills.buildSkillAction(skill, { x: 736, facing: 1 });
  assert.equal(act.type, 'cast');
  assert.equal(act.bullets.length, 3, 'S-6 三枚');
  assert.deepEqual(act.bullets.map((b) => b.x0), [736, 800, 864], '格心 px');
  assert.ok(act.bullets.every((b) => b.v === 0 && b.payload.multiplier === 1.3 && b.level === 2), '0 速 + 倍率（payload）+ 等级');
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
  assert.equal(b.v, 512, '8×64px 当 tick 飞完（D-07/D-20）');
  assert.equal(b.len, 512);
  assert.equal(b.level, 3);
});

test('T-SK-1/S-8 垂直：落点 clamp + area 覆盖格（A=224 火球 range8 area[-1,1]）', () => {
  const skill = skills.instantiateSkill(FIREBALL, 'rare', one);
  const act = skills.buildSkillAction(skill, { x: 224, facing: 1 });
  assert.equal(act.impactX, 736, 'S-8 224+8×64=736');
  assert.deepEqual(act.bullets.map((b) => b.x0), [672, 736, 800], '落点 ±1 格');
  // 越界：贴边释放落点 clamp（992 朝右 → 范围 8 → 目标 1504 → clamp 992）
  const edge = skills.buildSkillAction(skill, { x: 992, facing: 1 });
  assert.equal(edge.impactX, 992, 'clampX 落点 992');
  assert.deepEqual(edge.bullets.map((b) => b.x0), [928, 992], '越界格丢弃');
});

test('T-SK-1/S-9 位移：移动意图 + 路径弹幕（D-18/D-118，assault 突击盾）', () => {
  const bash = skills.instantiateSkill(BASH, 'rare', one);
  const act = skills.buildSkillAction(bash, { x: 736, facing: 1 });
  assert.equal(act.move.dir, 1);
  assert.equal(act.move.cells, 4, '距离 4 格');
  assert.equal(act.move.passThroughEnemy, false);
  assert.equal(act.move.dealDamage, true);
  // 路径弹幕：起点格到终点格（含端点，07-movement M 系列：400→656 = 格 6~10 五枚），等级取模板 bulletLevel=2（D-118）
  assert.deepEqual(act.bullets.map((b) => b.x0), [736, 800, 864, 928, 992], 'D-18 声明路径每格一枚（含终点格）');
  assert.ok(act.bullets.every((b) => b.level === 2 && b.v === 0), 'D-118 路径弹幕等级=模板 bulletLevel');
  // 暗影步：穿敌 + 无伤 + 全程闪避，不产路径弹幕
  const shadow = skills.instantiateSkill(SHADOW, 'rare', one);
  const act2 = skills.buildSkillAction(shadow, { x: 736, facing: -1 });
  assert.equal(act2.move.dir, -1);
  assert.equal(act2.move.passThroughEnemy, true);
  assert.equal(act2.move.dealDamage, false);
  assert.equal(act2.move.fullDodgeDuring, true);
  assert.deepEqual(act2.bullets, [], 'dealDamage=false 无路径弹幕（D-18④）');
});

test('T-SK-2/S-2 插件叠加（倍率/冷却/射程/等级 + 消耗补偿，rare [3,6,9]）', () => {
  const mkPlugin = (id, tier, quality, costDelta, affixes) => ({ id, tier, quality, costDeltaByTier: costDelta, affixes, kind: 'skillPlugin' });
  const base = skills.instantiateSkill(PRECISE, 'rare', one);
  // S-2b 倍率提升 tier1（rare）→ ×1.15 + mp+3
  const r1 = skills.applySkillPlugins(base, [mkPlugin('sp_mult', 1, 'rare', { mp: [2, 4, 6] }, [{ id: 'mult_up', params: { v: 0.15 } }])]);
  assert.equal(Math.round(r1.multiplier * 1000) / 1000, 1.035, 'S-2b 0.9×1.15=1.035');
  assert.deepEqual(r1.cost, { hp: 0, mp: 3, sp: 6 }, 'S-2b mp +3（rare base 3 × tier1）');
  // S-2c 冷却缩减 tier2 → cd 2→1 + sp +6
  const r2 = skills.applySkillPlugins(r1, [mkPlugin('sp_cooldown', 2, 'rare', { sp: [2, 4, 6] }, [{ id: 'cooldown_down', params: { v: 1 } }])]);
  assert.equal(r2.cooldown, 1, 'S-2c');
  assert.deepEqual(r2.cost, { hp: 0, mp: 3, sp: 12 }, 'S-2c sp +6');
  // S-2d 射程 +2 → 8→10 + mp+3
  const r3 = skills.applySkillPlugins(r2, [mkPlugin('sp_range', 1, 'rare', { mp: [2, 4, 6] }, [{ id: 'range_plus', params: { v: 2 } }])]);
  assert.equal(r3.range, 10, 'S-2d');
  assert.deepEqual(r3.cost, { hp: 0, mp: 6, sp: 12 });
  // S-2e 等级凝练 tier1 → L3→L2 + mp+3
  const r4 = skills.applySkillPlugins(r3, [mkPlugin('sp_level', 1, 'rare', { mp: [2, 4, 6] }, [{ id: 'level_up', params: { v: 1 } }])]);
  assert.equal(r4.bulletLevel, 2, 'S-2e');
  assert.deepEqual(r4.cost, { hp: 0, mp: 9, sp: 12 }, 'S-2e 终值 mp9/sp12');
  // S-3 消耗优化 tier1 → −20% 用 ceil，不加消耗
  const r5 = skills.applySkillPlugins(r4, [mkPlugin('sp_cost_down', 1, 'rare', null, [{ id: 'cost_down', params: { v: 0.2 } }])]);
  assert.equal(r5.cost.mp, 8, 'S-3 ceil(9×0.8)=8');
  assert.equal(r5.cost.sp, 10, 'S-3 ceil(12×0.8)=10');
});

test('T-SK-2/S-4 下限 clamp：等级凝练连装到 1、冷却到 0（D-115）', () => {
  const mk = (id, tier, costDelta, affixes) => ({ id, tier, quality: 'rare', costDeltaByTier: costDelta, affixes, kind: 'skillPlugin' });
  const base = skills.instantiateSkill(PRECISE, 'rare', one);
  const r1 = skills.applySkillPlugins(base, [mk('sp_level', 1, { mp: [2, 4, 6] }, [{ id: 'level_up', params: { v: 1 } }])]);
  const r2 = skills.applySkillPlugins(r1, [mk('sp_level', 1, { mp: [2, 4, 6] }, [{ id: 'level_up', params: { v: 1 } }])]);
  assert.equal(r2.bulletLevel, 1, 'S-4 等级下限 1');
  const whirl = skills.instantiateSkill(WHIRL, 'rare', { float: () => 0.1, int: (lo, hi) => lo, pick: (a) => a[0] });
  assert.equal(whirl.cooldown, 0, 'S-1h 冷却下限 0（0.1→0）');
});

test('T-SK-4/S-5 canCast 全分支：成功扣资源写 CD / 冷却 / 资源不足 / 资源恰等', () => {
  const base = skills.instantiateSkill(PRECISE, 'rare', one);
  const caster = { hp: 100, mp: 40, sp: 60, cooldowns: {}, cooldownTicks: {} };
  // S-5a 成功
  const ok = skills.canCast(base, { ...caster });
  assert.equal(ok.ok, true, 'S-5a');
  assert.equal(ok.caster.sp, 54, 'sp 60−6');
  assert.equal(ok.caster.cooldowns.skill_straight_precise, 2, 'S-5a 写 CD=2');
  // S-5b 冷却中
  const c2 = { hp: 100, mp: 40, sp: 60, cooldowns: { skill_straight_precise: 2 } };
  const r2 = skills.canCast(base, c2);
  assert.equal(r2.ok, false, 'S-5b');
  assert.equal(r2.reason, 'cooldown');
  assert.equal(c2.sp, 60, '失败不扣资源');
  // S-5c 资源不足（cost sp6，只有 5）
  const c3 = { hp: 100, mp: 40, sp: 5, cooldowns: {} };
  const r3 = skills.canCast(base, c3);
  assert.equal(r3.ok, false, 'S-5c');
  assert.equal(r3.reason, 'resource');
  // S-5e 资源恰等（≥ 语义）
  const c4 = { hp: 100, mp: 40, sp: 6, cooldowns: {} };
  const r4 = skills.canCast(base, { ...c4 });
  assert.equal(r4.ok, true, 'S-5e');
  assert.equal(r4.caster.sp, 0);
});

test('T-SK-3 越界：clamp 与格区间丢弃（贴边 AOE 截断）', () => {
  const heavy = skills.instantiateSkill(HEAVY, 'rare', one);
  const edge = skills.buildSkillAction(heavy, { x: 992, facing: 1 });
  assert.deepEqual(edge.bullets.map((b) => b.x0), [992], 'F-26 只覆盖格 15');
  const edge2 = skills.buildSkillAction(heavy, { x: 32, facing: -1 });
  assert.deepEqual(edge2.bullets.map((b) => b.x0), [32], 'F-27 贴边截断（[0,2] 朝左 → 仅格 0）');
});

test('SK-8 插件词条矩阵（分支覆盖）：弹幕数/射程各类型/位移增强/近战不可增强/hp 维度消耗', () => {
  const mk = (id, tier, costDelta, affixes, quality) => ({ id, tier, quality: quality || 'rare', costDeltaByTier: costDelta, affixes, kind: 'skillPlugin' });
  // bulletUp：平射 1→2
  const p = skills.instantiateSkill(PRECISE, 'rare', one);
  const r1 = skills.applySkillPlugins(p, [mk('sp_bullet', 1, { mp: [2, 4, 6] }, [{ id: 'bullet_plus', params: { v: 1 } }])]);
  assert.equal(r1.bulletCount, 2, '弹幕增强 +1');
  // rangeUp vertical：火球 range 8→10
  const fb = skills.instantiateSkill(FIREBALL, 'rare', one);
  const r2 = skills.applySkillPlugins(fb, [mk('sp_range', 1, { mp: [2, 4, 6] }, [{ id: 'range_plus', params: { v: 2 } }])]);
  assert.equal(r2.range, 10, '垂直射程 +2');
  // rangeUp displacement：按登记取向作用于 distance（突击盾 4→6）
  const bs = skills.instantiateSkill(BASH, 'rare', one);
  const r3 = skills.applySkillPlugins(bs, [mk('sp_range', 1, { sp: [2, 4, 6] }, [{ id: 'range_plus', params: { v: 2 } }])]);
  assert.equal(r3.distance, 6, '位移距离 +2');
  // distUp：距离 +1
  const r4 = skills.applySkillPlugins(bs, [mk('sp_displacement', 1, { sp: [2, 4, 6] }, [{ id: 'distance_plus', params: { v: 1 } }])]);
  assert.equal(r4.distance, 5, '位移增强 +1');
  // rangeUp melee：不可增强（登记取向）
  const hv = skills.instantiateSkill(HEAVY, 'rare', one);
  const r5 = skills.applySkillPlugins(hv, [mk('sp_range', 1, { mp: [2, 4, 6] }, [{ id: 'range_plus', params: { v: 2 } }])]);
  assert.deepEqual(r5.range, [0, 2], '近战范围不可增强');
  // costDelta hp 维度
  const r6 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [mk('sp_mult', 1, { hp: [2, 4, 6] }, [{ id: 'mult_up', params: { v: 0.1 } }])]);
  assert.equal(r6.cost.hp, 3, 'hp 维度补偿 3（rare tier1）');
  // 特殊类词条登记（B9 命中结算读取）
  const r7 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [mk('sp_stun', 1, { mp: [2, 4, 6] }, [{ id: 'stun', params: { v: 1 } }])]);
  assert.ok(r7.affixes.some((a) => a.id === 'stun'), 'stun 登记进 affixes');
});

test('SK-10 补充分支：字符串模板 / coveredCellRanges 各类型 / 缺 quality·tier 插件 / hp 消耗 canCast', () => {
  // 字符串模板实例化
  const s = skills.instantiateSkill('skill_melee_whirl', 'rare', one);
  assert.equal(s.sid, 'skill_melee_whirl');
  // coveredCellRanges：melee / vertical / straight（空）
  assert.deepEqual(skills.coveredCellRanges(s, { x: 736, facing: 1 }), [10, 11, 12]);
  assert.deepEqual(skills.coveredCellRanges(skills.instantiateSkill(FIREBALL, 'rare', one), { x: 224, facing: 1 }), [10, 11, 12]);
  assert.deepEqual(skills.coveredCellRanges(skills.instantiateSkill(PRECISE, 'rare', one), { x: 500, facing: 1 }), [], '平射无覆盖格');
  // 缺 quality（costDeltaBase 兜底 2）与缺 tier（跳过补偿）
  const r1 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [
    { id: 'sp_mult', tier: 1, costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'mult_up', params: { v: 0.1 } }], kind: 'skillPlugin' },
  ]);
  assert.equal(r1.cost.mp, 2, '缺 quality → 基准 2 × tier1');
  const r2 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [
    { id: 'sp_mult', quality: 'rare', costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'mult_up', params: { v: 0.1 } }], kind: 'skillPlugin' },
  ]);
  assert.deepEqual(r2.cost, { hp: 0, mp: 0, sp: 6 }, '缺 tier → 不补偿');
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
  // bullet_plus 装在近战（straight 条件 false）
  const r3 = skills.applySkillPlugins(skills.instantiateSkill(HEAVY, 'rare', one), [
    { id: 'sp_bullet', tier: 1, quality: 'rare', costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'bullet_plus', params: { v: 1 } }], kind: 'skillPlugin' },
  ]);
  assert.equal(r3.type, 'melee', '近战无 bulletCount 字段，不受影响');
});

test('SK-11 资源不足条件矩阵：hp/mp 维度触发 + cost_down 带非 null costDelta 组合', () => {
  const costSkill = (cost) => ({ sid: 'x', templateId: 'x', type: 'melee', cost, cooldown: 1 });
  // hp 不足触发（短路第一条件）
  const a = skills.canCast(costSkill({ hp: 10, mp: 0, sp: 0 }), { hp: 5, mp: 0, sp: 0, cooldowns: {} });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'resource');
  // mp 不足触发（短路第二条件）
  const b = skills.canCast(costSkill({ hp: 0, mp: 10, sp: 0 }), { hp: 100, mp: 5, sp: 0, cooldowns: {} });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'resource');
  // cost_down 词条但 costDeltaByTier 非 null：不减耗，走 costDelta 补偿分支
  const sk = skills.instantiateSkill(PRECISE, 'rare', one);
  const r = skills.applySkillPlugins(sk, [
    { id: 'sp_cost_down', tier: 1, quality: 'rare', costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'cost_down', params: { v: 0.2 } }], kind: 'skillPlugin' },
  ]);
  assert.deepEqual(r.cost, { hp: 0, mp: 3, sp: 6 }, 'costDown 被 costDelta 补偿覆盖（不减耗）');
});

test('SK-12 裸插件分支：无 affixes 字段 / distUp 装平射 / costDelta 数值非数组', () => {
  // 插件无 affixes 字段（各 find 的 `|| []` falsy 分支）
  const r1 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [
    { id: 'sp_mult', tier: 1, quality: 'rare', costDeltaByTier: { mp: [2, 4, 6] }, kind: 'skillPlugin' },
  ]);
  assert.deepEqual(r1.cost, { hp: 0, mp: 3, sp: 6 }, '无词条仅补偿');
  assert.equal(r1.multiplier, 0.9, '无 mult_up 不变');
  // distUp 装在平射（displacement 条件 false）
  const r2 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [
    { id: 'sp_displacement', tier: 1, quality: 'rare', costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'distance_plus', params: { v: 1 } }], kind: 'skillPlugin' },
  ]);
  assert.equal(r2.type, 'straight', '平射无 distance 不受影响');
  // costDeltaByTier 维度值为数字（非数组 → 不补偿该维）
  const r3 = skills.applySkillPlugins(skills.instantiateSkill(PRECISE, 'rare', one), [
    { id: 'sp_mult', tier: 1, quality: 'rare', costDeltaByTier: { mp: 5, sp: [2, 4, 6] }, affixes: [{ id: 'mult_up', params: { v: 0.1 } }], kind: 'skillPlugin' },
  ]);
  assert.deepEqual(r3.cost, { hp: 0, mp: 0, sp: 9 }, 'mp 数值 5 非数组不补偿；sp 数组补偿 3');
});

test('SK-7 日志：skill.instantiate / skill.plugin.apply / skill.area / skill.cast / skill.reject（§4.6 五事件）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const sk = skills.withLogger(logger);
  const s = sk.instantiateSkill(PRECISE, 'rare', one);
  assert.ok(logger.records.some((x) => x.event === 'skill.instantiate' && x.data.templateId === 'skill_straight_precise'), '应有 skill.instantiate');
  const r1 = sk.applySkillPlugins(s, [{ id: 'sp_mult', tier: 1, quality: 'rare', costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'mult_up', params: { v: 0.15 } }], kind: 'skillPlugin' }]);
  assert.ok(logger.records.some((x) => x.event === 'skill.plugin.apply'), '应有 skill.plugin.apply');
  sk.coveredCellRanges(sk.instantiateSkill(HEAVY, 'rare', one), { x: 736, facing: 1 });
  const area = logger.records.find((x) => x.event === 'skill.area');
  assert.ok(area, '应有 skill.area（审查 P2-1）');
  assert.deepEqual(area.data.cells, [11, 12, 13]);
  const caster = { hp: 100, mp: 40, sp: 60, cooldowns: {}, cooldownTicks: {} };
  sk.canCast(r1, caster);
  assert.ok(logger.records.some((x) => x.event === 'skill.cast'), '应有 skill.cast');
  sk.canCast(r1, { hp: 100, mp: 40, sp: 60, cooldowns: { skill_straight_precise: 1 } });
  assert.ok(logger.records.some((x) => x.event === 'skill.reject' && x.data.reason === 'cooldown'), '应有 skill.reject');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    const b = skills.instantiateSkill(HEAVY, 'rare', one);
    skills.buildSkillAction(b, { x: 500, facing: 1 });
    skills.coveredCellRanges(b, { x: 500, facing: 1 });
    skills.canCast(b, { hp: 100, mp: 100, sp: 100, cooldowns: {} });
  });
});