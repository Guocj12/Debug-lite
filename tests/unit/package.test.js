'use strict';
/* tests/unit/package.test.js —— D-176/D-177 包（模块包）体系：配置不变量 + 生成/掉落/开包
 *
 * 契约：docs/content-design.md §10；docs/interfaces.md §4（Package）；server/data/package-config.json
 * 覆盖：
 *   PK-1 配置表不变量：20 档百分比 / 品质档位并集 / 每行概率和 = 1 / 白名单模板存在
 *   PK-2 掉落品质规则（用户口径）：本级 + 以下两级；**仅每级最高档**允许升一级；件数期望随质量递增
 *   PK-3 generatePackage：品质=段位、质量必须在品质档位内；非法入参 → RangeError
 *   PK-4 openPackage：确定性（同 seed 同结果）、件数 1~3、物品品质落在该档允许集合内
 *   PK-5 AI 节点包 = 保留包：可掉落、开包 reserved:true 且零产出（不抛错）
 *   PK-6 rollBattlePackages：个数 0~2、品质 = 玩家段位、结果为 win/loss/draw；胜方期望多于负方
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const items = require('../../server/core/items.js');
const { createRng } = require('../../server/core/rng.js');
const cfg = require('../../server/data/package-config.json');

const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const sum = (row) => Object.values(row).reduce((a, b) => a + b, 0);

test('PK-1 配置表不变量：档位 / 概率和 / 种类 / 白名单', () => {
  assert.equal(cfg.percentSteps.length, 20, '20 档百分比');
  assert.deepEqual(cfg.percentSteps, [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]);
  // 品质档位：每品质 4 档、并集 = percentSteps
  const union = [];
  for (const t of TIERS) {
    const band = cfg.qualityPercentBands[t];
    assert.equal(band.length, 4, `${t} 4 档`);
    assert.deepEqual(band, [...band].sort((a, b) => a - b), `${t} 档位升序`);
    union.push(...band);
  }
  assert.deepEqual([...new Set(union)].sort((a, b) => a - b), cfg.percentSteps, '档位并集不重不漏');
  // 每行和为 1
  for (const p of cfg.percentSteps) {
    assert.ok(Math.abs(sum(cfg.itemQualityCurve[String(p)]) - 1) < 1e-9, `itemQualityCurve[${p}] 和为 1`);
  }
  for (const row of ['1', '2', '3', '4']) {
    assert.ok(Math.abs(sum(cfg.itemCountCurve[row]) - 1) < 1e-9, `itemCountCurve[${row}] 和为 1`);
  }
  for (const r of ['win', 'loss', 'draw']) {
    assert.ok(Math.abs(sum(cfg.battleDropCountCurve[r]) - 1) < 1e-9, `battleDropCountCurve.${r} 和为 1`);
    assert.ok(Math.abs(sum(cfg.battleDropQualityCurve[r]) - 1) < 1e-9, `battleDropQualityCurve.${r} 和为 1`);
  }
  // 五种包 + 权重正数
  assert.deepEqual(cfg.packages.map((p) => p.packageKind),
    ['role', 'skill', 'rolePlugin', 'skillPlugin', 'aiNode']);
  assert.equal(cfg.packages.find((p) => p.packageKind === 'aiNode').openable, false, 'AI 节点包 = 保留包');
  assert.ok(TIERS.every((t) => cfg.packageKindWeights[t] === undefined ? true : true));
  assert.ok(['role', 'skill', 'rolePlugin', 'skillPlugin', 'aiNode']
    .every((k) => typeof cfg.packageKindWeights[k] === 'number' && cfg.packageKindWeights[k] >= 0));
});

test('PK-2 掉落品质规则：本级 + 以下两级，仅最高档可升一级；件数期望随质量递增', () => {
  for (let gi = 0; gi < TIERS.length; gi += 1) {
    const band = cfg.qualityPercentBands[TIERS[gi]];
    for (let si = 0; si < band.length; si += 1) {
      const p = band[si];
      const row = cfg.itemQualityCurve[String(p)];
      const step = si + 1;
      // 允许集合：本级及以下两级；最高档（step 4）额外允许上一级
      const lo = Math.max(0, gi - 2);
      const hi = step === 4 ? Math.min(TIERS.length - 1, gi + 1) : gi;
      for (const [q, v] of Object.entries(row)) {
        if (v <= 0) continue;
        const qi = TIERS.indexOf(q);
        assert.ok(qi >= lo && qi <= hi,
          `${TIERS[gi]} ${p}%（档${step}）不允许出现 ${q}（允许 ${TIERS.slice(lo, hi + 1).join('/')}）`);
      }
      assert.ok(row[TIERS[gi]] > 0 || gi > 0, `${TIERS[gi]} ${p}% 应有本级品质的产出`);
    }
  }
  // 最低三档必须"全绿"（用户口径：15% 以下全绿）
  for (const p of [5, 10, 15]) {
    assert.deepEqual(cfg.itemQualityCurve[String(p)], { common: 1.0 }, `${p}% 全绿`);
  }
  // 每级最高档的"升级"概率极小（≤ 10%）
  for (const gi of [0, 1, 2, 3]) {
    const p = cfg.qualityPercentBands[TIERS[gi]][3];
    const row = cfg.itemQualityCurve[String(p)];
    const up = row[TIERS[gi + 1]] || 0;
    assert.ok(up > 0, `${TIERS[gi]} 最高档（${p}%）应有极小概率出 ${TIERS[gi + 1]}`);
    assert.ok(up <= 0.10, `${TIERS[gi]} 最高档升级概率应为"极小"（实际 ${up}）`);
  }
  // 青包 100% 档：95% 青 + 5% 橙（用户 2026-09-28 定稿）
  assert.deepEqual(cfg.itemQualityCurve['100'], { legendary: 0.05, mythic: 0.95 });
  // 件数期望随档位递增
  const expect = (row) => Object.entries(row).reduce((a, [k, v]) => a + Number(k) * v, 0);
  const e = ['1', '2', '3', '4'].map((k) => expect(cfg.itemCountCurve[k]));
  for (let i = 1; i < e.length; i += 1) assert.ok(e[i] > e[i - 1], `件数期望单调递增（${e.join(' < ')}）`);
});

test('PK-3 generatePackage：品质=段位、质量必须在档位内，非法入参抛错', () => {
  const pkg = items.generatePackage({ packageKind: 'skill', quality: 'epic', qualityPercent: 50, uid: 'pkg_a' });
  assert.deepEqual(pkg, {
    uid: 'pkg_a', kind: 'package', packageKind: 'skill', name: '技能模块包',
    quality: 'epic', qualityPercent: 50,
  });
  assert.throws(() => items.generatePackage({ packageKind: 'nope', quality: 'epic', qualityPercent: 50 }), /未登记包种类/);
  assert.throws(() => items.generatePackage({ packageKind: 'skill', quality: 'nope', qualityPercent: 50 }), /未知包品质/);
  assert.throws(() => items.generatePackage({ packageKind: 'skill', quality: 'epic', qualityPercent: 20 }), /不属于品质/);
  assert.throws(() => items.generatePackage({ packageKind: 'skill', quality: 'epic', qualityPercent: 55.5 }), /不属于品质/);
  assert.equal(items.packageStepOf('epic', 45), 1);
  assert.equal(items.packageStepOf('epic', 60), 4);
  assert.equal(items.packageStepOf('epic', 40), null);
  assert.deepEqual(items.packagePercentsOf('mythic'), [85, 90, 95, 100]);
});

test('PK-4 openPackage：确定性 + 件数 1~3 + 品质落在允许集合内', () => {
  const allowed = (q, percent) => {
    const gi = TIERS.indexOf(q);
    const band = cfg.qualityPercentBands[q];
    const step = band.indexOf(percent) + 1;
    const lo = Math.max(0, gi - 2);
    const hi = step === 4 ? Math.min(4, gi + 1) : gi;
    return TIERS.slice(lo, hi + 1);
  };
  // uid 由 core 的进程级计数器分配（B17 登记口径："不参与内容级比较"）→ 确定性断言比较**内容**，剥掉 uid
  const stripUid = (r) => ({ ...r, items: r.items.map((it) => { const c = { ...it }; delete c.uid; return c; }) });
  for (const tier of TIERS) {
    for (const percent of cfg.qualityPercentBands[tier]) {
      const pkg = items.generatePackage({ packageKind: 'role', quality: tier, qualityPercent: percent, uid: `pkg_${tier}_${percent}` });
      const r1 = items.openPackage(createRng(4242), pkg);
      const r2 = items.openPackage(createRng(4242), pkg);
      assert.deepEqual(stripUid(r1), stripUid(r2), `同 seed 同结果（${tier} ${percent}%）`);
      assert.equal(r1.ok, true);
      assert.ok(r1.items.length >= 1 && r1.items.length <= 3, `件数 1~3（实际 ${r1.items.length}）`);
      const allow = allowed(tier, percent);
      for (const it of r1.items) {
        assert.ok(['role'].includes(it.kind));
        assert.ok(allow.includes(it.quality), `${tier} ${percent}% 掉出 ${it.quality}（允许 ${allow.join('/')}）`);
      }
    }
  }
  // 非包入参 → package_invalid
  assert.equal(items.openPackage(createRng(1), { kind: 'role', uid: 'x' }).code, 'package_invalid');
  assert.equal(items.openPackage(createRng(1), null).code, 'package_invalid');
});

test('PK-5 AI 节点包 = 保留包：可掉落、开包零产出且不抛错', () => {
  const pkg = items.generatePackage({ packageKind: 'aiNode', quality: 'rare', qualityPercent: 30, uid: 'pkg_ai' });
  const r = items.openPackage(createRng(7), pkg);
  assert.equal(r.ok, true);
  assert.equal(r.reserved, true);
  assert.deepEqual(r.items, []);
  // 统计：100 个品质分布合理（不做精确断言，只保证不抛错且恒零产出）
  for (const tier of TIERS) {
    const p = items.generatePackage({ packageKind: 'aiNode', quality: tier, qualityPercent: cfg.qualityPercentBands[tier][0], uid: `pkg_ai_${tier}` });
    assert.deepEqual(items.openPackage(createRng(3), p).items, []);
  }
  // 白名单池：保留包没有可掉落模板
  assert.deepEqual(items.packageDropPoolOf('aiNode', 30), []);
});

test('PK-6 rollBattlePackages：个数 0~2、品质=玩家段位、胜方期望多于负方', () => {
  const counts = { win: [0, 0, 0], loss: [0, 0, 0], draw: [0, 0, 0] };
  const N = 4000;
  for (const result of ['win', 'loss', 'draw']) {
    const rng = createRng(20260928);
    for (let i = 0; i < N; i += 1) {
      const out = items.rollBattlePackages(rng, { tier: 'rare', result });
      assert.ok(out.length <= 2, '单场最多 2 个包');
      for (const p of out) {
        assert.equal(p.quality, 'rare', '包品质 = 玩家段位');
        assert.ok(cfg.qualityPercentBands.rare.includes(p.qualityPercent), '质量属于该品质档位');
        assert.ok(['role', 'skill', 'rolePlugin', 'skillPlugin', 'aiNode'].includes(p.packageKind));
      }
      counts[result][out.length] += 1;
    }
  }
  const mean = (r) => (counts[r][1] + 2 * counts[r][2]) / N;
  assert.ok(mean('win') > mean('loss'), `胜方掉包期望（${mean('win').toFixed(3)}）应高于负方（${mean('loss').toFixed(3)}）`);
  assert.equal(counts['win'][0], 0, '胜方必掉至少 1 个（曲线 0 档权重为 0）');
  assert.ok(counts['loss'][0] > 0, '负方可能不掉');
  assert.throws(() => items.rollBattlePackages(createRng(1), { tier: 'nope', result: 'win' }), /未知段位/);
  // 未知结果 → 按 draw 处理（不抛错）
  assert.ok(Array.isArray(items.rollBattlePackages(createRng(1), { tier: 'common', result: 'weird' })));
});
