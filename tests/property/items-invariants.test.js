'use strict';
// 属性测试（2026-09-16 随"用户拍板 A"新增）：用种子随机在多组输入上验证**不变量**，而不是逐例定点。
// 覆盖三项新机制：
//   ① 类型修饰进开箱路径：物品五维恒 ≥1，且 ≤「修饰后基础值 × 品质区间上界」（机器可复算的上界）
//   ② 掉落池：drop === false 的条目**永不**出现在池中（与门控无关）；unlockTier 门控在**门控开启**时恒成立
//      （2026-09-16 用户决策：默认关闭门控，故默认模式下 unlockTier 不再是池过滤条件）
//   ③ 池内加权抽取：权重重采样频率收敛到 dropWeight 比例（±容差），且返回值必在池内
// 依赖：server/core/items.js、server/core/rng.js、内容层表（L9）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const items = require('../../server/core/items.js');
const { createRng } = require('../../server/core/rng.js');

const TEMPLATES = require('../../server/data/role-templates.json').roleTemplates;
const SKILLS = require('../../server/data/skill-templates.json').skillTemplates;
const PLUGINS = require('../../server/data/plugins.json').plugins;
const QUALITIES = require('../../server/data/qualities.json').qualities;
const TIERS = QUALITIES.map((q) => q.id);
const QMAP = Object.fromEntries(QUALITIES.map((q) => [q.id, q]));
const FIVE = ['hp', 'atk', 'def', 'sp', 'mp'];

// 修饰后的**最大可能**系数（上界推导用）：特化高属性 ×1.15（低 0.85 不影响上界）；
// 专家高属性 ×1.30、其余最多 ×1.1（spread 的四个取值里最大者）
function maxModifier(t, k) {
  const base = t.baseStats;
  if (t.type === 'specialized') return k === t.highStat ? base[k] * 1.15 : base[k];
  if (t.type === 'expert') return k === t.highStat ? base[k] * 1.30 : base[k] * 1.1;
  return base[k];
}

test('PT-IT-1 不变量：任意模板 × 任意品质，开箱角色五维 ∈ [1, 最大修饰系数 × statRange 上界]', () => {
  const rng = createRng(20260916);
  for (let i = 0; i < 400; i++) {
    const t = TEMPLATES[rng.int(0, TEMPLATES.length - 1)];
    const q = QMAP[TIERS[rng.int(0, TIERS.length - 1)]];
    const item = items.generateRoleItem(t, q.id, rng);
    for (const k of FIVE) {
      assert.ok(Number.isInteger(item.stats[k]) && item.stats[k] >= 1, `${t.id}/${q.id}: ${k}=${item.stats[k]} 必须 ≥1 整数`);
      const upper = Math.ceil(maxModifier(t, k) * q.statRange[1]) + 1; // +1 = 四舍五入容差
      assert.ok(item.stats[k] <= upper, `${t.id}/${q.id}: ${k}=${item.stats[k]} 超过上界 ${upper}（最大修饰 ${maxModifier(t, k)} × ${q.statRange[1]}）`);
    }
    assert.ok(item.slots.length >= 1, '插槽数下限 1');
    assert.ok(item.slots.every((s) => s.pluginUid === null), '新生成插槽未装配');
  }
});

test('PT-IT-2 不变量：类型修饰确实生效 —— 同品质下特化/专家的高属性下界严格高于均衡', () => {
  const high = (id) => TEMPLATES.find((t) => t.id === id);
  const lo = (t, q) => {
    let min = Infinity;
    for (let s = 1; s <= 400; s++) min = Math.min(min, items.generateRoleItem(t, q, createRng(s)).stats.atk);
    return min;
  };
  const bal = lo(high('role_bal'), 'rare');
  const spc = lo(high('role_spc_atk'), 'rare');
  const exp = lo(high('role_exp_atk'), 'rare');
  assert.ok(spc > bal, `特化 atk 下界 ${spc} 应 > 均衡 ${bal}`);
  assert.ok(exp > spc, `专家 atk 下界 ${exp} 应 > 特化 ${spc}`);
  assert.deepEqual([bal, spc, exp], [10, 12, 13], '机器复算：10×1.00 / round(10×1.15×1.00) / round(10×1.30×1.00)');
});

test('PT-IT-3 不变量：掉落池 —— drop=false 永不出现在任何段位（与门控无关）；门控开启时 unlockTier 恒成立', () => {
  const pool = [
    { id: 'keep', drop: true, unlockTier: 'common' },
    { id: 'off', drop: false, unlockTier: 'common' },
    { id: 'late', drop: true, dropWeight: 5, unlockTier: 'mythic' },
    { id: 'legacy', dropWeight: 2 },
  ];
  // ① 与门控无关的掉落不变量：任何模式、任何段位下 drop=false 条目都不得进池，池恒非空
  for (const tier of TIERS) {
    const got = items.dropPool(pool, tier);
    assert.ok(!got.some((x) => x.id === 'off'), `${tier}: drop=false 不得进池`);
    assert.ok(got.length >= 1, `${tier}: 池非空（keep/legacy 恒可掉落）`);
  }
  // ② 门控关闭（默认，用户决策 2026-09-16）：unlockTier 不再是约束 → late 在所有段位都进池
  for (const tier of TIERS) {
    assert.ok(items.dropPool(pool, tier).some((x) => x.id === 'late'), `${tier}: 门控关闭 → late 恒进池`);
  }
  // ③ 门控开启（回退模式）：unlockTier 门控恒成立（原断言）
  const gated = items.withGating(true);
  for (const tier of TIERS) {
    const got = gated.dropPool(pool, tier);
    assert.ok(!got.some((x) => x.id === 'off'), `${tier}: drop=false 不得进池`);
    assert.ok(!got.some((x) => x.id === 'late') || tier === 'mythic', `${tier}: late 只允许 mythic 起`);
    assert.ok(got.length >= 1, `${tier}: 池非空（keep/legacy 恒可掉落）`);
  }
  // 真实表：池 = 全部条目（示例内容 drop 全 true），且每项都在表内（两种模式各断言一次）
  for (const mode of [items, gated]) {
    for (const tier of TIERS) {
      const roles = mode.dropPool(TEMPLATES, tier);
      assert.ok(roles.every((r) => r.drop !== false));
      assert.ok(roles.every((r) => mode.validateUnlock(r, tier)));
      const plug = mode.dropPool(PLUGINS, tier);
      assert.ok(plug.every((p) => p.drop !== false && mode.validateUnlock(p, tier)));
      assert.ok(roles.length >= 1 && plug.length >= 1 && mode.dropPool(SKILLS, tier).length >= 1);
    }
  }
});

test('PT-IT-4 不变量：加权抽取频率 = dropWeight 比例（±3%），返回值必在池内', () => {
  const pool = [
    { id: 'a', dropWeight: 1 },
    { id: 'b', dropWeight: 2 },
    { id: 'c', dropWeight: 5 },
  ];
  const total = 8;
  const rng = createRng(97531);
  const N = 6000;
  const cnt = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < N; i++) {
    const hit = items.pickFromPool(rng, pool, '属性采样');
    assert.ok(pool.includes(hit), '返回值必须来自池');
    cnt[hit.id]++;
  }
  for (const p of pool) {
    const expected = p.dropWeight / total;
    const actual = cnt[p.id] / N;
    assert.ok(Math.abs(actual - expected) < 0.03, `${p.id}: 频率 ${actual.toFixed(3)} 应 ≈ ${expected.toFixed(3)}`);
  }
});

test('PT-IT-5 不变量：角色面板聚合幂等 —— 多次调用逐值一致（单一实现）', () => {
  const rng = createRng(4242);
  for (let i = 0; i < 50; i++) {
    const t = TEMPLATES[rng.int(0, TEMPLATES.length - 1)];
    const item = items.generateRoleItem(t, 'rare', rng);
    const plugins = [
      { uid: `p${i}a`, affixes: [{ id: 'atk_pct', params: { v: 0.1 } }, { id: 'hp_regen', params: { v: 1 } }] },
      { uid: `p${i}b`, affixes: [{ id: 'atk_flat', params: { v: 3 } }] },
    ];
    const a = items.buildRolePanel(item, plugins);
    const b = items.buildRolePanel(item, plugins);
    assert.deepEqual(a, b, '同一输入两次聚合逐值一致（幂等）');
    assert.ok(FIVE.every((k) => a.stats[k] >= 1), '五维下限 1');
    assert.equal(a.regen.hp, 1, 'regen 词条叠加一次');
    assert.equal(a.maxHp, a.stats.hp, 'maxHp = 最终 hp');
  }
});
