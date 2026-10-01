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

test('T-IT-2 插槽数：角色/技能闭区间（**允许 0 槽**，2026-09-28 §3.3 下限 1 已作废）', () => {
  assert.equal(it.rollSlotCount('role', 'rare', stubRng(0.9)), 3, 'rare [1,3] 取 3');
  assert.equal(it.rollSlotCount('role', 'common', stubRng(0)), 0, 'common [0,2] 可取 0（下限 1 已作废）');
  assert.equal(it.rollSlotCount('skill', 'common', stubRng(0)), 0, 'skill common [0,1] 可取 0');
  assert.equal(it.rollSlotCount('skill', 'mythic', stubRng(0.49)), 3, 'mythic [3,4] 0.49 → 3');
  // 区间端点可达（真实 rng）
  const rng = createRng(7);
  const seen = new Set();
  for (let i = 0; i < 500; i++) seen.add(it.rollSlotCount('role', 'rare', rng));
  assert.deepEqual([...seen].sort(), [1, 2, 3], '闭区间两端都应可达');
});

test('T-IT-3 属性系数取整四舍五入 + 下限 1（B0=95/15/8/73/62 定点复算）', () => {
  const mk = (coeff) => it.generateRoleItem(ROLE.role_bal, 'rare', stubRng(coeff));
  assert.equal(mk(1.12).stats.hp, 106, '95×1.12=106.4 → 106');
  assert.equal(mk(1.08).stats.atk, 16, '15×1.08=16.2 → 16');
  assert.equal(mk(1.05).stats.def, 8, '8×1.05=8.4 → 8');
  assert.equal(mk(1.20).stats.sp, 88, '73×1.20=87.6 → 88');
  assert.equal(mk(1.02).stats.mp, 63, '62×1.02=63.24 → 63');
  const c = it.generateRoleItem(ROLE.role_bal, 'common', stubRng(0.80));
  assert.equal(c.stats.hp, 76, '95×0.80=76（品质下界）');
  assert.equal(c.stats.atk, 12, '15×0.80=12');
  // 极端低系数 → 下限 1
  const low = it.generateRoleItem({ ...ROLE.role_bal, baseStats: { hp: 1, atk: 1, def: 1, sp: 1, mp: 1 } }, 'common', stubRng(0.80));
  for (const k of ['hp', 'atk', 'def', 'sp', 'mp']) assert.equal(low.stats[k], 1, `${k} 下限 1`);
});

test('T-RO-7 角色物品实例携带模板 regen（D-110，B3 载体）', () => {
  const item = it.generateRoleItem(ROLE.role_bal, 'rare', createRng(3));
  assert.deepEqual(item.regen, { mp: 2, sp: 2 }, '物品携带模板 regen（B0 取推荐值，待 §8-T1 裁决）');
  const spc = it.generateRoleItem(ROLE.role_spc_atk, 'rare', createRng(4));
  assert.deepEqual(spc.regen, { mp: 2, sp: 2 });
  // 插件点数由品质区间掷出（2026-09-28 §3.4）
  assert.ok(item.pluginPoints >= QUALITY.rare.pluginPointsRange[0] && item.pluginPoints <= QUALITY.rare.pluginPointsRange[1],
    `pluginPoints=${item.pluginPoints} 应在 rare ${JSON.stringify(QUALITY.rare.pluginPointsRange)}`);
});

test('IT-2 插槽类型权重（2026-09-28 §3.3）：五维各 15% / 万能 any 10% / 特殊 15%；重复槽权重 ×0.35', () => {
  const rng = createRng(11);
  const counts = {};
  let total = 0;
  for (let i = 0; i < 2000; i++) {
    const item = it.generateRoleItem(ROLE.role_bal, 'mythic', rng); // mythic [4,6]：样本多、类型齐
    for (const s of item.slots) { counts[s.type] = (counts[s.type] || 0) + 1; total++; }
  }
  for (const t of ['hp', 'atk', 'def', 'sp', 'mp', 'special']) {
    assert.ok(Math.abs(counts[t] / total - 0.15) < 0.02, `${t} 槽频率 ${(counts[t] / total).toFixed(3)} 应 ≈ 0.15`);
  }
  assert.ok(Math.abs(counts.any / total - 0.10) < 0.02, `any 槽频率 ${(counts.any / total).toFixed(3)} 应 ≈ 0.10`);
  // 重复衰减（确定性核对）：同一权重下第二次不再命中已出现的类型
  const seq = it.rollSlots('role', 'common', ROLE.role_bal, { float: () => 0.10, int: () => 0, pick: (a) => a[0] }, 2);
  assert.deepEqual(seq.map((s) => s.type), ['hp', 'atk'], 'hp 出现后权重 ×0.35 → 0.0525，0.10×0.9025=0.09025 已越过 hp');
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

test('IT-4 插件生成：标准值 × U(品质系数)（2026-09-28 §5.1；flat 保留 2 位）', () => {
  // 池内第一个角色插件（stub pick = a[0]）= rp_atk_pct_c1；coeff 1.20 → 档 3
  const p = it.generatePlugin('rolePlugin', 'rare', stubRng(1.20));
  assert.equal(p.id, 'rp_atk_pct_c1', '池内随机取（stub pick 取第一个匹配）');
  assert.equal(p.tier, 3);
  assert.equal(p.pointCost, 1, '点数消耗取自插件定义的固定 pointCost（不再等于档位）');
  assert.equal(p.affixes[0].params.v, 0.102, '0.085 × 1.20 = 0.102（stat 类保留 2 位）');
  // flat 类：2.55 × 1.12 = 2.856 → 保留 2 位（不再即时取整为整数）
  const p2 = it.generatePlugin('rolePlugin', 'rare', { float: () => 1.12, int: (lo, hi) => lo, pick: (a) => a.find((x) => x.id === 'rp_atk_flat') });
  assert.equal(p2.tier, 2, '1.12 落档 2');
  assert.equal(p2.pointCost, 2, '固定 pointCost = 2');
  assert.equal(p2.affixes[0].params.v, 2.856, '2.55 × 1.12 = 2.856（precision.stat=3；flat 聚合时只取整一次）');
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
  const s = SKILL.skill_melee;
  // S-1e bulletCount 下限（用 straight 的 count=1 × 0.8 → 1）
  const precise = SKILL.skill_straight;
  const item = it.generateSkillItem(precise, 'common', stubRng(0.8));
  assert.equal(item.params.bulletCount, 1, 'S-1e 下限 1');
  // 射程已不随品质浮动（2026-09-28 §6.3：copy）：平射 range 恒 = 5
  const rng90 = { float: () => 0.9, int: (lo, hi) => lo, pick: (a) => a[0] };
  const item2 = it.generateSkillItem(SKILL.skill_straight, 'common', rng90);
  assert.equal(item2.params.range, 5, '射程不随品质浮动（copy）');
  assert.equal(item2.params.bulletCount, 1, '弹幕数不随品质浮动（copy）');
  // 倍率保留 2 位小数：1.2×1.10 = 1.32（S-1a）
  const rng110 = { float: () => 1.10, int: (lo, hi) => lo, pick: (a) => a[0] };
  const item3 = it.generateSkillItem(SKILL.skill_straight, 'common', rng110);
  assert.equal(item3.params.multiplier, 1.32, 'S-1a');
  // 不随品质：bulletLevel/cost/falloff 恒等（S-1j/k/l）
  assert.equal(item3.params.bulletLevel, 3, 'S-1j');
  assert.deepEqual(item3.params.cost, { hp: 0, mp: 3, sp: 2 }, 'S-1k');
  assert.equal(item3.params.falloff, 0, 'S-1l');
  // cooldown 下限 0（S-1h 语义）：3×0.1=0.3 → 0
  const rng01 = { float: () => 0.1, int: (lo, hi) => lo, pick: (a) => a[0] };
  const item4 = it.generateSkillItem(SKILL.skill_melee, 'common', rng01);
  assert.equal(item4.params.cooldown, 0, 'S-1h 冷却下限 0');
});

test('IT-3b 技能物品：vertical / displacement 类型参数分支（分支覆盖补齐）', () => {
  const rng09 = { float: () => 0.9, int: (lo, hi) => lo, pick: (a) => a[0] };
  const rain = it.generateSkillItem(SKILL.skill_vertical, 'common', rng09);
  assert.equal(rain.params.range, 5, '定点射程不随品质浮动（copy）');
  assert.deepEqual(rain.params.area, [0, 0], 'area 不随品质');
  const bash = it.generateSkillItem(SKILL.skill_displace, 'common', rng09);
  assert.equal(bash.params.distance, 3, '位移距离不随品质浮动（copy）');
  assert.equal(bash.params.passThroughEnemy, false);
  assert.equal(bash.params.dealDamage, false);
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
  // 段位门控（门控开启 = 回退模式）：common 段位只产出 common 物品（I-9/池过滤）
  const gatedIt = it.withGating(true);
  assert.equal(gatedIt.gatingEnabled, true);
  const rng = createRng(20260916);
  for (let i = 0; i < 200; i++) {
    const b = gatedIt.openBox(rng, { tier: 'common' });
    assert.equal(b.quality, 'common', 'common 段位品质池被截断');
    const required = b.templateId ? (ROLE[b.templateId] || SKILL[b.templateId] || {}).unlockTier : (PLUGIN[b.pluginId] || {}).unlockTier;
    if (required !== undefined) {
      assert.ok(['common'].includes(required), `common 段位产出被门控物品 ${b.templateId || b.pluginId}`);
    }
  }
});

test('IT-8b 门控关闭（默认）：tier 只作回带信息 —— 任意段位都能出最高品质与全量模板/插件', () => {
  assert.equal(it.gatingEnabled, false, '缺省实例 = 门控关闭（unlock.json gating.enabled=false）');
  const qualitySeen = new Set();
  const templateSeen = new Set();
  const rng = createRng(20260916);
  for (let i = 0; i < 1500; i++) {
    const b = it.openBox(rng, { tier: 'common' }); // 最低段位
    qualitySeen.add(b.quality);
    if (b.templateId) templateSeen.add(b.templateId);
  }
  assert.ok(qualitySeen.has('mythic'), `common 段位也能出 mythic（实际 ${[...qualitySeen].join('/')}）`);
  assert.equal(qualitySeen.size, QUALITIES.length, '五档品质全部可达（全池 dropRates）');
  // 高段位模板在最低段位也能被开出来（掉落池不再按 unlockTier 过滤）
  const highTierIds = new Set(TEMPLATES.concat(SKILLS).filter((t) => t.unlockTier === 'legendary' || t.unlockTier === 'mythic').map((t) => t.id));
  assert.ok([...templateSeen].some((id) => highTierIds.has(id)), `common 段位开出高段位模板: ${[...templateSeen].join('/')}`);
  // 模板/插件池不再按 unlockTier 过滤：高级段位模板在 common 段位亦可见于掉落池
  const highRole = TEMPLATES.filter((t) => t.unlockTier && t.unlockTier !== 'common');
  assert.ok(highRole.length > 0, '数据里存在高段位角色模板（元数据保留）');
  // 2026-09-28 §6.3：技能基础模板共 4 条、全部 common（每类 1 条基础形态）→ 技能侧无高段位元数据（设计如此）
  assert.ok(SKILLS.every((s) => s.unlockTier === 'common'), '技能模板全部 common（每类 1 条基础形态）');
  assert.ok(it.dropPool(TEMPLATES, 'common').some((t) => t.unlockTier === 'legendary'), 'common 段位池含 legendary 角色');
  assert.ok(it.dropPool(PLUGINS, 'common').some((p) => p.unlockTier === 'legendary'), 'common 段位池含 legendary 插件');
});

test('IT-9 validateUnlock 门控（I-9a/b/c；门控开启 = 回退模式）', () => {
  const gatedIt = it.withGating(true);
  assert.equal(gatedIt.validateUnlock({ unlockTier: 'common' }, 'common'), true, 'I-9a');
  assert.equal(gatedIt.validateUnlock({ unlockTier: 'legendary' }, 'rare'), false, 'I-9b');
  assert.equal(gatedIt.validateUnlock({}, 'common'), true, 'I-9c 未定义视为已解锁');
  assert.equal(gatedIt.validateUnlock({ unlockTier: 'legendary' }, 'nope'), false, '未知段位保守拒绝');
  assert.equal(gatedIt.validateUnlock({ unlockTier: 'nope' }, 'mythic'), false, '未知 unlockTier 保守拒绝');
});

test('IT-9b 门控关闭（默认）validateUnlock 恒 true：任意段位 × 任意 unlockTier', () => {
  for (const tier of ['common', 'rare', 'epic', 'legendary', 'mythic', 'nope']) {
    for (const item of [{ unlockTier: 'mythic' }, { unlockTier: 'common' }, {}, { unlockTier: null }]) {
      assert.equal(it.validateUnlock(item, tier), true, `validateUnlock(${JSON.stringify(item)}, ${tier}) 段位不参与判定`);
    }
  }
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
    it.generateSkillItem(SKILL.skill_melee, 'common', createRng(2));
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

// ---- 2026-09-16 用户拍板 A：类型修饰进开箱路径 + 掉落完全由 JSON 配置 ----

// 序列化 stub：float/int 按序弹值（与 roles.test.js 同构；消耗顺序 = 修饰 ints → 5×品质系数 → slotCount → 槽）
function stubSeq(values) {
  let i = 0;
  return { float: () => values[i++], int: (lo, hi) => values[i++], pick: (a) => a[0] };
}

test('IT-15 开箱角色物品套用类型修饰（乘性守恒 + 逐属性因子；2026-09-28 §3.2 / D-174）', () => {
  const TM = require('../../server/data/role-templates.json').typeModifiers;
  // 特化·攻击 rare：高属性 atk 15×1.30=19.5；低属性候选 = 五维 − 高属性 = [hp, def, sp, mp]（D-174：无 def 特判）
  //   stubSeq 顺序：1 int（低属性索引）→ 5 float（品质系数）→ slotCount int → 槽 float ×N → pluginPoints float
  const lowSp = it.generateRoleItem(ROLE.role_spc_atk, 'rare', stubSeq([2, 1, 1, 1, 1, 1, 0, 0, 0, 0]));
  assert.deepEqual(lowSp.stats, { hp: 95, atk: 20, def: 8, sp: 56, mp: 62 }, '19.5→20；低属性 sp 73×0.7692=56.15→56');
  const lowHp = it.generateRoleItem(ROLE.role_spc_atk, 'rare', stubSeq([0, 1, 1, 1, 1, 1, 0, 0, 0, 0]));
  assert.deepEqual(lowHp.stats, { hp: 73, atk: 20, def: 8, sp: 73, mp: 62 }, '低属性随机：hp 95×0.7692=73.08→73');
  // 专家·攻击 rare：高属性 atk 15×1.50=22.5→23；spread [1.2,2/3,5/6,1] 经 FY（ints 全 0）→ [2/3,5/6,1,1.2]
  //   others = [hp, def, sp, mp] → hp ×2/3 / def ×5/6 / sp ×1 / mp ×1.2（五档，D-174）
  const exp = it.generateRoleItem(ROLE.role_exp_atk, 'rare', stubSeq([0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0]));
  assert.deepEqual(exp.stats, { hp: 63, atk: 23, def: 7, sp: 73, mp: 74 }, '专家 atk 23；四因子各一次（乘性守恒）');
  // 均衡不变（零漂移）：不消耗修饰随机
  assert.deepEqual(it.generateRoleItem(ROLE.role_bal, 'rare', stubSeq([1.12, 1.08, 1.05, 1.20, 1.02, 0, 0, 0, 0])).stats,
    { hp: 106, atk: 16, def: 8, sp: 88, mp: 63 }, 'balanced 不消耗修饰随机');
  // 区间实测（seed 1..300，确定性）：高属性下界依次抬高（修正前三条完全相同）
  const range = (templateId) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let s = 1; s <= 300; s++) {
      const v = it.generateRoleItem(ROLE[templateId], 'rare', createRng(s)).stats.atk;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return [lo, hi];
  };
  const [bLo, bHi] = range('role_bal');
  const [sLo, sHi] = range('role_spc_atk');
  const [eLo, eHi] = range('role_exp_atk');
  assert.deepEqual([bLo, bHi], [15, 19], '均衡 atk = round(15×[1.00,1.25])');
  assert.deepEqual([sLo, sHi], [20, 24], '特化 ×1.30 = round(19.5×[1.00,1.25])');
  assert.deepEqual([eLo, eHi], [23, 28], '专家 ×1.50 = round(22.5×[1.00,1.25])');
  assert.ok(sLo > bLo && eLo > sLo, '高属性下界依次抬高');
  // 确定性上下界（stub 系数取品质区间端点；品质系数按五维顺序 hp,atk,def,sp,mp 消耗 → atk 是第 2 个 float）
  assert.equal(it.generateRoleItem(ROLE.role_spc_atk, 'rare', stubSeq([0, 1.00, 1, 1, 1, 1, 0, 0, 0])).stats.atk, 20, '19.5×1.00→20');
  assert.equal(it.generateRoleItem(ROLE.role_spc_atk, 'rare', stubSeq([0, 1, 1.25, 1, 1, 1, 0, 0, 0])).stats.atk, 24, '19.5×1.25=24.375→24');
  assert.equal(it.generateRoleItem(ROLE.role_exp_atk, 'rare', stubSeq([0, 0, 0, 1.00, 1, 1, 1, 1, 0, 0, 0])).stats.atk, 23, '22.5×1.00→23');
  assert.equal(it.generateRoleItem(ROLE.role_exp_atk, 'rare', stubSeq([0, 0, 0, 1, 1.25, 1, 1, 1, 0, 0, 0])).stats.atk, 28, '22.5×1.25=28.125→28');
  // D-174：**无 def 特判**（excludeLow 已退役）——def 既可作高属性，也可承担 <1 因子
  assert.equal(TM.excludeLow, undefined, 'excludeLow 已退役（无 def 特判）');
  // 特化·防御：高属性是 def；低属性候选 = [hp, atk, sp, mp] → index 3 = mp
  assert.equal(it.generateRoleItem(ROLE.role_spc_def, 'rare', stubSeq([3, 1, 1, 1, 1, 1, 0, 0, 0, 0])).stats.mp, 48, '特化低属性可落任意维度（含 def 之外的全部）');
  // 专家·攻击：FY ints=[3,0,0] → spread [2/3,5/6,1.2,1] → others [hp,def,sp,mp] ⇒ def ×5/6 < 1（旧口径会换位）
  const expDefLow = it.generateRoleItem(ROLE.role_exp_atk, 'rare', stubSeq([3, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0]));
  assert.equal(expDefLow.stats.def, 7, 'def 可承担 <1 因子：8×5/6=6.67→7（无 def 特判）');
});

test('IT-16 掉落池配置：drop=false 不进池 / dropWeight 同类加权 / 缺省 true+1（旧表兼容）', () => {
  const pool = [
    { id: 'a', drop: true, dropWeight: 1, unlockTier: 'common' },
    { id: 'b', drop: false },
    { id: 'unknown' },
    { id: 'c', drop: true, dropWeight: 3, unlockTier: 'mythic' },
  ];
  assert.deepEqual(it.dropPool(pool, 'mythic').map((x) => x.id), ['a', 'unknown', 'c'], 'drop=false 被过滤；缺省字段视为可掉落');
  assert.deepEqual(it.dropPool(pool, 'common').map((x) => x.id), ['a', 'unknown', 'c'], '门控关闭（默认）：c 不再被段位剔除');
  assert.deepEqual(it.withGating(true).dropPool(pool, 'common').map((x) => x.id), ['a', 'unknown'], '门控开启：段位门控仍生效（c 需 mythic）');
  assert.deepEqual(it.dropPool(null, 'mythic'), [], '空/缺表 → 空池（不抛）');
  // 段内权重直观可见（选项 3）：可以只凭 JSON 关掉某一项 / 调它的相对权重
  assert.ok(!it.dropPool(pool, 'mythic').some((x) => x.id === 'b'));

  // 权重全为 1（含缺省）→ 与 rng.pick **逐次一致**（默认表零行为漂移，消耗同样 1 次 float）
  const uni = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const r1 = createRng(99);
  const r2 = createRng(99);
  const viaPool = [];
  const viaPick = [];
  for (let i = 0; i < 50; i++) {
    viaPool.push(it.pickFromPool(r1, uni, '样本').id);
    viaPick.push(r2.pick(uni).id);
  }
  assert.deepEqual(viaPool, viaPick, '均匀路径 = rng.pick（逐次相同）');
  // 加权路径：权重 3:1 → 75%/25%（大样本 ±5%）；stub 无 pick → 证明走的是权重分支
  const noPick = { float: (lo, hi) => (hi === undefined ? 0.5 : lo + (hi - lo) * 0.5) };
  assert.equal(it.pickFromPool(noPick, [{ id: 'w3', dropWeight: 3 }, { id: 'w1', dropWeight: 1 }], '样本').id, 'w3');
  const weighted = [{ id: 'w3', dropWeight: 3 }, { id: 'w1', dropWeight: 1 }];
  const rw = createRng(2026);
  let n3 = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) if (it.pickFromPool(rw, weighted, '样本').id === 'w3') n3++;
  assert.ok(Math.abs(n3 / N - 0.75) < 0.05, `权重 3:1 → 约 75%（实际 ${(n3 / N * 100).toFixed(1)}%）`);
  // 非法 dropWeight（0 / 负 / 字符串）一律按 1：四项权重 [1,1,1,2] → 20%/20%/20%/40%
  const sanitized = [{ id: 'z0', dropWeight: 0 }, { id: 'neg', dropWeight: -5 }, { id: 's', dropWeight: 'z' }, { id: 'two', dropWeight: 2 }];
  const rs = createRng(31);
  const cnt = {};
  for (let i = 0; i < 2000; i++) {
    const id = it.pickFromPool(rs, sanitized, '样本').id;
    cnt[id] = (cnt[id] || 0) + 1;
  }
  assert.ok(Math.abs(cnt.z0 / 2000 - 0.2) < 0.05 && Math.abs(cnt.neg / 2000 - 0.2) < 0.05 && Math.abs(cnt.s / 2000 - 0.2) < 0.05,
    `非法权重视为 1（各 20%）：${JSON.stringify(cnt)}`);
  assert.ok(Math.abs(cnt.two / 2000 - 0.4) < 0.05, `合法权重 2 → 40%：${JSON.stringify(cnt)}`);
  // rng 返回值越界（float=1.0）→ 权重和用尽 → 尾项兜底（不返回 undefined）
  assert.equal(it.pickFromPool({ float: () => 1.0 }, [{ id: 'a', dropWeight: 2 }, { id: 'b', dropWeight: 1 }], '样本').id, 'b');
  // 空池 → 明确 RangeError（开箱 409 tier_locked 的来源）
  assert.throws(() => it.pickFromPool(createRng(1), [], '角色模板'), /该段位无可用角色模板/);

  // generatePlugin 走同一池逻辑：poolOverride 内 drop=false 永不出现，dropWeight 生效
  const plugPool = [
    { id: 'w_hi', kind: 'rolePlugin', slot: 'atk', name: 'h', desc: 'h', dropWeight: 9, pointCost: 1, affixes: [{ id: 'atk_flat', params: { v: 1 } }] },
    { id: 'w_lo', kind: 'rolePlugin', slot: 'atk', name: 'l', desc: 'l', dropWeight: 1, pointCost: 1, affixes: [{ id: 'atk_flat', params: { v: 1 } }] },
    { id: 'w_off', kind: 'rolePlugin', slot: 'atk', name: 'o', desc: 'o', drop: false, pointCost: 1, affixes: [{ id: 'atk_flat', params: { v: 1 } }] },
  ];
  const rg = createRng(4242);
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(it.generatePlugin('rolePlugin', 'rare', rg, plugPool).id);
  assert.ok(!seen.has('w_off'), 'drop=false 的插件永不掉落');
  assert.ok(seen.has('w_hi') && seen.has('w_lo'), `加权池两项都会出：${[...seen]}`);

  // 真实数据：每一项都显式带 drop / dropWeight（"是否掉落/权重都在 JSON 里"可人工核对）
  for (const t of TEMPLATES) {
    assert.equal(typeof t.drop, 'boolean', `${t.id} 缺 drop`);
    assert.ok(t.dropWeight > 0, `${t.id} dropWeight 应为正数`);
  }
  for (const t of SKILLS) assert.equal(typeof t.drop, 'boolean', `${t.id} 缺 drop`);
  for (const t of PLUGINS) assert.equal(typeof t.drop, 'boolean', `${t.id} 缺 drop`);
});

// ---- 装配门控两模式（用户决策 2026-09-16；配合 tests/unit/wh.test.js 的 I-10c）----
test('IT-17 装配门控（assemble）：门控开启 → tier_locked；门控关闭（默认）→ 放行', () => {
  const wh = () => JSON.parse(JSON.stringify(require('../fixtures/wh-ok.json')));
  const mkReq = (src) => {
    src.buckets.rolePlugin.push({ uid: 'g1', kind: 'rolePlugin', id: 'rp_sp_opt', slot: 'sp', quality: 'legendary', tier: 3, pointCost: 3, affixes: [], unlockTier: 'legendary', equipped: false });
    src.buckets.role[0].slots.push({ type: 'sp', pluginUid: null });
    return { targetUid: 'r1', slotIndex: 2, pluginUid: 'g1', tier: 'rare' };
  };
  // 门控关闭（默认）：段位不参与判定 → 装配成功
  const off = wh();
  const rOff = it.assemble(off, mkReq(off));
  assert.equal(rOff.ok, true, '门控关闭：legendary 插件 @ rare 也放行');
  assert.equal(rOff.warehouse.buckets.role[0].slots[2].pluginUid, 'g1');
  // 门控开启：同一请求被 tier_locked 拒绝
  const on = wh();
  const rOn = it.withGating(true).assemble(on, mkReq(on));
  assert.equal(rOn.ok, false);
  assert.equal(rOn.code, 'tier_locked', '门控开启：装配门控（I-10c/§4.10）仍生效');
});
