'use strict';
// B3 core/items.js 数值层契约测试 —— 接口见 docs/interfaces.md §1（getQuality/rollQuality/rollSlotCount/tierOf/
// generateRoleItem/generateSkillItem/generatePlugin/openBox/applyAffixes/validateUnlock）
// 依据：examples/01-items.md I-1..I-12（数值期望唯一出处）；examples/02-roles.md R-4/R-5/R-6（词条聚合复算）
// 归属：tasks.md §6 B3（T-IT-1/2/3/4/5/9 + T-RO-7）；日志 items.roll.quality/generate/affix.apply（§4.6）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../../server/core/rng.js');
const { createLogger } = require('../../shared/log.js');
const it = require('../../server/core/items.js');

const TEMPLATES = require('../../server/data/role-templates.json').roleTemplates;
const SKILLS = require('../../server/data/skill-templates.json').skillTemplates;
const QUALITIES = require('../../server/data/qualities.json').qualities;
const PLUGINS = require('../../server/data/plugins.json').plugins;

const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const ROLE = byId(TEMPLATES);
const SKILL = byId(SKILLS);
const QUALITY = byId(QUALITIES);
const PLUGIN = byId(PLUGINS);

// 固定值 rng stub：float(lo,hi) 返回指定**绝对系数**（I-2/I-6 定点复算用；档位判定用真实系数值）
function stubRng(coeff) {
  return { float: () => coeff, int: (lo, hi) => lo, pick: (a) => a[0] };
}

test('IT-1 T-IT-1 品质分布：dropRates 加权大样本 <2% 误差（I-1）', () => {
  const rng = createRng(20260914);
  const N = 20000;
  const counts = {};
  for (let i = 0; i < N; i++) {
    const id = it.rollQuality(rng);
    counts[id] = (counts[id] || 0) + 1;
  }
  const drop = JSON.parse(require('node:fs').readFileSync('server/data/items-config.json', 'utf8')).dropRates;
  for (const [id, p] of Object.entries(drop)) {
    const rate = (counts[id] || 0) / N;
    assert.ok(Math.abs(rate - p) < 0.02, `${id} 频率 ${rate} 偏离 ${p} 超 2%`);
  }
});

test('T-IT-2 插槽数：角色/技能闭区间 + 技能下限 1（I-3 全例）', () => {
  assert.equal(it.rollSlotCount('role', 'rare', stubRng(0.9)), 4, 'I-3a rare [2,4] 取 4');
  assert.equal(it.rollSlotCount('role', 'common', stubRng(0)), 1, 'I-3b common [1,3] 取 1');
  assert.equal(it.rollSlotCount('skill', 'common', stubRng(0)), 1, 'I-3c [0,1] 抽 0 → 下限 1');
  assert.equal(it.rollSlotCount('skill', 'mythic', stubRng(0.49)), 3, 'I-3d mythic [3,4] 归一化 0.49 → 3');
  // 区间端点可达（真实 rng）
  const rng = createRng(7);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(it.rollSlotCount('role', 'rare', rng));
  assert.deepEqual([...seen].sort(), [2, 3, 4], '闭区间两端都应可达');
});

test('T-IT-3 属性系数取整四舍五入 + 下限 1（I-2a..h 定点复算）', () => {
  const mk = (coeff) => it.generateRoleItem(ROLE.role_bal, 'rare', stubRng(coeff));
  assert.equal(mk(1.12).stats.hp, 112, 'I-2a');
  assert.equal(mk(1.08).stats.atk, 11, 'I-2b');
  assert.equal(mk(1.05).stats.def, 8, 'I-2c');
  assert.equal(mk(1.20).stats.sp, 72, 'I-2d');
  assert.equal(mk(1.02).stats.mp, 41, 'I-2e');
  const common = byId(QUALITIES).common;
  const c = it.generateRoleItem(ROLE.role_bal, 'common', stubRng(0.80));
  assert.equal(c.stats.hp, 80, 'I-2f 下界');
  assert.equal(c.stats.atk, 8, 'I-2g');
  // I-2h：极端低系数 → 下限 1
  const low = it.generateRoleItem({ ...ROLE.role_bal, baseStats: { hp: 1, atk: 1, def: 1, sp: 1, mp: 1 } }, 'common', stubRng(0.80));
  for (const k of ['hp', 'atk', 'def', 'sp', 'mp']) assert.equal(low.stats[k], 1, `${k} 下限 1`);
});

test('T-RO-7 角色物品实例携带模板 regen（D-110，B3 载体）', () => {
  const item = it.generateRoleItem(ROLE.role_bal, 'rare', createRng(3));
  assert.deepEqual(item.regen, { mp: 1, sp: 2 }, '物品携带模板 regen');
  const spc = it.generateRoleItem(ROLE.role_spc_atk, 'rare', createRng(4));
  assert.deepEqual(spc.regen, { mp: 1, sp: 2 });
});

test('IT-2 插槽类型 slotWeights 加权（I-4）', () => {
  // role_bal 六键各 1 → 抽 4 个的类型分布合理（无 atk 偏向）；role_spc_atk atk 权重 2 → atk 出现率更高
  const rng = createRng(11);
  const balTypes = new Set();
  for (let i = 0; i < 200; i++) {
    const item = it.generateRoleItem(ROLE.role_bal, 'rare', rng);
    balTypes.add(item.slots.length);
  }
  assert.deepEqual([...balTypes].sort(), [2, 3, 4], 'rare 角色插槽数在 [2,4]');
  const spcRng = createRng(12);
  let atkCount = 0;
  let total = 0;
  for (let i = 0; i < 200; i++) {
    const item = it.generateRoleItem(ROLE.role_spc_atk, 'rare', spcRng);
    for (const s of item.slots) {
      total++;
      if (s.type === 'atk') atkCount++;
    }
  }
  const atkRate = atkCount / total;
  const base = 2 / 7; // atk:2 / 总和 7
  assert.ok(Math.abs(atkRate - base) < 0.06, `atk 槽频率 ${atkRate} 应接近 ${base}`);
});

test('IT-3 T-IT-9 档位 tierOf：三档区间划分（I-5）', () => {
  // rare statRange [1.00,1.25] → 三档 [1.0000,1.0833]/[1.0833,1.1667]/[1.1667,1.2500]（stub 返回绝对系数）
  const q = QUALITY.rare;
  assert.equal(it.tierOf(stubRng(1.00), q), 1, '档 1 下界');
  assert.equal(it.tierOf(stubRng(1.0833), q), 1, '档 1 上界（含边界）');
  assert.equal(it.tierOf(stubRng(1.10), q), 2, '档 2');
  assert.equal(it.tierOf(stubRng(1.1667), q), 2, '档 2 上界');
  assert.equal(it.tierOf(stubRng(1.20), q), 3, '档 3');
});

test('IT-4 插件生成：词条 = 基础值 × U(档位区间系数)（I-6 定点复算）', () => {
  // I-6a rp_atk_pct tier3：0.08 × 1.20 = 0.096（系数落在档 3 区间）
  const p = it.generatePlugin('rolePlugin', 'rare', stubRng(1.20));
  assert.equal(p.id, 'rp_atk_pct', '池内随机取（stub pick 取第一个匹配）');
  assert.equal(p.tier, 3);
  // I-6b rp_atk_flat tier2：4 × 1.12 = 4.48 → flat 词条入包即取整 → +4
  const p2 = it.generatePlugin('rolePlugin', 'rare', { float: () => 1.12, int: (lo, hi) => lo, pick: (a) => a.find((x) => x.id === 'rp_atk_flat') });
  assert.equal(p2.tier, 2, '1.12 落档 2');
  assert.equal(p2.affixes[0].params.v, 4, 'I-6b 入包数值 = 基础 × 档系数四舍五入（flat 即时取整，审查 P1-1）');
});

test('IT-5 T-IT-4 词条聚合：百分比先乘、数值后加、最后取整一次（I-8a/b/c）', () => {
  const r1 = it.applyAffixes({ atk: 14 }, [
    { id: 'atk_pct', params: { v: 0.0816 } },
    { id: 'atk_pct', params: { v: 0.096 } },
    { id: 'atk_flat', params: { v: 4 } },
  ]);
  assert.equal(r1.stats.atk, 20, 'I-8a：14×(1+0.1776)+4=20.4864 → 20');
  const r2 = it.applyAffixes({ atk: 11 }, [{ id: 'atk_pct', params: { v: 0.0816 } }]);
  assert.equal(r2.stats.atk, 12, 'I-8b：11×1.0816=11.8976 → 12');
  const r3 = it.applyAffixes({ atk: 20 }, [{ id: 'atk_pct', params: { v: -0.15 } }]);
  assert.equal(r3.stats.atk, 17, 'I-8c：20×0.85=17');
});

test('IT-6 T-IT-5 概率词条累加封顶 1 / 数值下限 1（I-8d/e/f）', () => {
  const r1 = it.applyAffixes({}, [
    { id: 'dodge_chance', params: { v: 0.05 } },
    { id: 'dodge_chance', params: { v: 0.05 } },
    { id: 'dodge_chance', params: { v: 0.05 } },
  ]);
  assert.ok(Math.abs(r1.special.dodgeChance - 0.15) < 1e-9, `I-8d：5%×3=15%（浮点容差）实际 ${r1.special.dodgeChance}`);
  const r2 = it.applyAffixes({}, [
    { id: 'dodge_chance', params: { v: 0.05 } },
    { id: 'dodge_chance', params: { v: 1.2 } },
  ]);
  assert.equal(r2.special.dodgeChance, 1, 'I-8e：封顶 1');
  const r3 = it.applyAffixes({ atk: 1 }, [{ id: 'atk_flat', params: { v: -5 } }]);
  assert.equal(r3.stats.atk, 1, 'I-8f：数值下限 1');
});

test('IT-7 技能物品生成：可随机参数 × 系数取整 + 下限（S-1 系列语义）', () => {
  const q = QUALITY.common;
  const s = SKILL.skill_melee_whirl;
  // S-1e bulletCount 下限（用 straight precise 的 count=1 × 0.8 → 1）
  const precise = SKILL.skill_straight_precise;
  const item = it.generateSkillItem(precise, 'common', stubRng(0.8));
  assert.equal(item.params.bulletCount, 1, 'S-1e 下限 1');
  // S-1c range 0.9 → 7（平射 8×0.9=7.2 → 7）
  const rng90 = { float: () => 0.9, int: (lo, hi) => lo, pick: (a) => a[0] };
  const item2 = it.generateSkillItem(SKILL.skill_straight_precise, 'common', rng90);
  assert.equal(item2.params.range, 7, 'S-1c');
  // 倍率保留 2 位小数：0.9×1.10=0.99（S-1a）
  const rng110 = { float: () => 1.10, int: (lo, hi) => lo, pick: (a) => a[0] };
  const item3 = it.generateSkillItem(SKILL.skill_straight_precise, 'common', rng110);
  assert.equal(item3.params.multiplier, 0.99, 'S-1a');
  // 不随品质：bulletLevel/cost/falloff 恒等（S-1j/k/l）
  assert.equal(item3.params.bulletLevel, 3, 'S-1j');
  assert.deepEqual(item3.params.cost, { hp: 0, mp: 0, sp: 6 }, 'S-1k');
  assert.equal(item3.params.falloff, 0, 'S-1l');
  // cooldown 下限 0（S-1h 语义）：1×0.1=0.1 → 0
  const rng01 = { float: () => 0.1, int: (lo, hi) => lo, pick: (a) => a[0] };
  const item4 = it.generateSkillItem(SKILL.skill_melee_whirl, 'common', rng01);
  assert.equal(item4.params.cooldown, 0, 'S-1h 冷却下限 0');
});

test('IT-3b 技能物品：vertical / displacement 类型参数分支（分支覆盖补齐）', () => {
  const rng09 = { float: () => 0.9, int: (lo, hi) => lo, pick: (a) => a[0] };
  const rain = it.generateSkillItem(SKILL.skill_vert_rain, 'common', rng09);
  assert.equal(rain.params.range, 7, '箭雨 8×0.9=7.2 → 7');
  assert.deepEqual(rain.params.area, [-2, 2], 'area 不随品质');
  const bash = it.generateSkillItem(SKILL.skill_dash_bash, 'common', rng09);
  assert.equal(bash.params.distance, 4, '突击盾 4×0.9=3.6 → 4');
  assert.equal(bash.params.passThroughEnemy, false);
  assert.equal(bash.params.dealDamage, true);
  assert.equal(bash.params.fullDodgeDuring, false);
  // tierOf 尾分支：系数超出最后一段（stub 越界输入）→ 档 3
  assert.equal(it.tierOf(stubRng(9), QUALITY.rare), 3, '越界系数兜底档 3');
});

test('IT-14 R-5b 聚合：flat 即时取整后的面板与示例一致（14 atk + 8.16% + flat+4 → 19）', () => {
  const r = it.applyAffixes({ atk: 14 }, [
    { id: 'atk_pct', params: { v: 0.0816 } },
    { id: 'atk_flat', params: { v: 4 } },
  ]);
  assert.equal(r.stats.atk, 19, 'R-5b：14×1.0816+4=19.1424 → 19');
});

test('IT-3c 防御路径：rng 越界输出 1.0 时品质/类别/插槽数走尾兜底（分支覆盖）', () => {
  const one = { float: () => 1.0, int: (lo, hi) => lo, pick: (a) => a[0] };
  assert.equal(it.rollQuality(one), 'mythic', 'v=1 → 兜底 mythic');
  assert.equal(it.rollSlotCount('skill', 'mythic', one), 4, 'v=1 → 插槽数钳到上界 4（P2-1）');
  const box = it.openBox(one);
  assert.ok(['role', 'skill', 'rolePlugin', 'skillPlugin'].includes(box.kind), 'v=1 → 类别兜底（skillPlugin 权重最大）');
});

test('IT-8 openBox 三段流程：品质→类别→生成（I-7）', () => {
  const box = it.openBox(createRng(20260915));
  assert.ok(['role', 'skill', 'rolePlugin', 'skillPlugin'].includes(box.kind), '类别合法');
  const hasId = (box.kind === 'role' || box.kind === 'skill') ? !!box.templateId : !!box.id;
  assert.ok(hasId, '生成完备（角色/技能有 templateId，插件有 id）');
  assert.ok(QUALITY[box.quality] !== undefined, '品质合法');
  // 段位门控：common 段位只产出 common 物品（I-9/池过滤）
  const rng = createRng(20260916);
  for (let i = 0; i < 200; i++) {
    const b = it.openBox(rng, { tier: 'common' });
    const required = b.templateId ? (ROLE[b.templateId] || SKILL[b.templateId] || {}).unlockTier : (PLUGIN[b.pluginId] || {}).unlockTier;
    if (required !== undefined) {
      assert.ok(['common'].includes(required), `common 段位产出被门控物品 ${b.templateId || b.pluginId}`);
    }
  }
});

test('IT-9 validateUnlock 门控（I-9a/b/c）', () => {
  assert.equal(it.validateUnlock({ unlockTier: 'common' }, 'common'), true, 'I-9a');
  assert.equal(it.validateUnlock({ unlockTier: 'legendary' }, 'rare'), false, 'I-9b');
  assert.equal(it.validateUnlock({}, 'common'), true, 'I-9c 未定义视为已解锁');
});

test('IT-10 日志：items.roll.quality / items.generate / items.affix.apply（§4.6 事件）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const items = it.withLogger(logger);
  const rng = createRng(1);
  const qid = items.rollQuality(rng);
  assert.ok(logger.records.some((r) => r.event === 'items.roll.quality' && r.data.quality === qid), '应有 items.roll.quality');
  items.generateRoleItem(ROLE.role_bal, 'rare', rng);
  assert.ok(logger.records.some((r) => r.event === 'items.generate' && r.data.kind === 'role'), '应有 items.generate');
  items.applyAffixes({ atk: 10 }, [{ id: 'atk_pct', params: { v: 0.08 } }]);
  assert.ok(logger.records.some((r) => r.event === 'items.affix.apply' && r.data.count === 1), '应有 items.affix.apply');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    it.rollQuality(createRng(2));
    it.generateRoleItem(ROLE.role_bal, 'common', createRng(2));
    it.generateSkillItem(SKILL.skill_melee_whirl, 'common', createRng(2));
    it.generatePlugin('skillPlugin', 'rare', createRng(2));
    it.openBox(createRng(2));
    it.applyAffixes({ hp: 100 }, []);
  });
});

test('IT-11 失败路径：未知品质/未知 kind/空池', () => {
  assert.throws(() => it.getQuality('platinum'), RangeError, '未知品质');
  assert.throws(() => it.rollSlotCount('weapon', 'rare', stubRng(0)), RangeError, '未知 kind');
  assert.throws(() => it.generatePlugin('rolePlugin', 'common', {
    float: () => 0.5, int: (lo, hi) => lo,
    pick: () => { throw new RangeError('空池'); },
  }), RangeError, 'pick 抛错会穿透（空池语义由上抛）');
});

test('IT-12 词条聚合统计：概率聚合只取概率类，数值类不进 special', () => {
  const r = it.applyAffixes({ hp: 100, atk: 10 }, [
    { id: 'crit_chance', params: { v: 0.0816 } },
    { id: 'lifesteal', params: { v: 0.102 } },
    { id: 'hp_flat', params: { v: 20 } },
  ]);
  assert.equal(r.stats.hp, 120, '数值类进 stats');
  assert.equal(r.stats.atk, 10);
  assert.equal(r.special.critChance, 0.0816, '概率类进 special（R-6a）');
  assert.equal(r.special.lifesteal, 0.102, 'R-6e');
  assert.equal(r.special.dodgeChance, undefined, '未装闪避不出现');
});