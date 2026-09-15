'use strict';
// B17 server/box.js 开箱编排 helper 测试 —— 契约 docs/interfaces.md §2 POST /api/v1/box
// （T-AP-1/2/3/5 helper 级）+ D-122/RK-5（段位品质上限）+ I-9（掉落池门控）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const box = require('../../server/box.js');

// 内容级相等（uid 为进程级自增，同 seed 同进程二次开箱 uid 不同 —— 确定性以生成内容为准，B17 登记）
function contentOf(item) {
  const c = { kind: item.kind, templateId: item.templateId, quality: item.quality, slotCount: item.slotCount };
  if (item.params) c.params = JSON.stringify(item.params);
  if (item.stats) c.stats = JSON.stringify(item.stats);
  return c;
}

test('B17-1 正常开箱：个数=times、物品形状、seed 回带', () => {
  const r = box.openBoxes({ seed: 20260913, tier: 'rare', times: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 10);
  assert.equal(r.data.seed, 20260913);
  assert.equal(r.data.tier, 'rare');
  assert.equal(r.data.times, 10);
  for (const it of r.data.items) {
    assert.equal(typeof it.uid, 'string');
    assert.ok(['role', 'skill', 'rolePlugin', 'skillPlugin'].includes(it.kind), `kind=${it.kind}`);
    assert.ok(['common', 'rare'].includes(it.quality), `rare 段位品质上限（D-122/RK-5b）: ${it.quality}`);
  }
});

test('B17-2 品质上限（D-122/RK-5）：common 段位只能出 common；mythic 全池', () => {
  const c = box.openBoxes({ seed: 7, tier: 'common', times: 50 });
  for (const it of c.data.items) assert.equal(it.quality, 'common', 'common 段位只有绿（RK-5a）');
  const m = box.openBoxes({ seed: 7, tier: 'mythic', times: 50 });
  const seen = new Set(m.data.items.map((x) => x.quality));
  assert.ok(seen.has('common') && seen.size <= 5, `mythic 全池（含非绿概率）: ${[...seen]}`);
});

test('B17-3 种子确定性：同 seed 内容级一致；缺 seed 生成并回带', () => {
  const a = box.openBoxes({ seed: 12345, tier: 'epic', times: 8 });
  const b = box.openBoxes({ seed: 12345, tier: 'epic', times: 8 });
  assert.deepEqual(a.data.items.map(contentOf), b.data.items.map(contentOf), '同 seed 内容一致');
  const g = box.openBoxes({ tier: 'common', times: 3 });
  assert.equal(g.status, 200);
  assert.ok(Number.isInteger(g.data.seed) && g.data.seed >= 1, `服务端生成 seed=${g.data.seed}`);
});

test('B17-4 参数错误：bad_tier / bad_times / bad_seed → 400 + code', () => {
  assert.equal(box.openBoxes({ tier: 'diamond' }).code, 'bad_tier');
  assert.equal(box.openBoxes({ times: 0 }).code, 'bad_times');
  assert.equal(box.openBoxes({ times: -1 }).code, 'bad_times');
  assert.equal(box.openBoxes({ times: 1.5 }).code, 'bad_times');
  assert.equal(box.openBoxes({ times: box.BOX_TIMES_MAX + 1 }).code, 'bad_times');
  assert.equal(box.openBoxes({ seed: 'abc' }).code, 'bad_seed');
  assert.equal(box.openBoxes({ seed: 0 }).code, 'bad_seed');
  assert.equal(box.openBoxes({ seed: 0x80000000 }).code, 'bad_seed', 'seed 上界（防 32 位回绕）');
  assert.equal(box.openBoxes({ seed: 4294967297 }).code, 'bad_seed', 'seed ≥2^32 拒绝（P2 落实）');
});

test('B17-5 409 tier_locked：门控后掉落池为空（RangeError 映射；防御路径）', () => {
  const stubEmpty = { openBox: () => { throw new RangeError('该段位无可用角色模板'); } };
  const r = box.openBoxes({ seed: 1, tier: 'rare', times: 1, items: stubEmpty });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'tier_locked');
  assert.ok(r.message.includes('无可用'), '透出池空原因');
  // 非 RangeError（内部错误）→ 抛穿（不吞 bug）
  const stubBoom = { openBox: () => { throw new TypeError('boom'); } };
  assert.throws(() => box.openBoxes({ seed: 1, tier: 'rare', times: 1, items: stubBoom }), TypeError);
});

// P1-1 回归（审查 docs/reviews/B17.md）：截断后按剩余池重归一 —— rare 档分布 = dropRates / Σ(前两档)
// 采样走 core 直调（box.openBoxes 有 times≤100 请求上限，分布样本需 core 级 rng 序列）
test('B17-6 P1-1 回归：rare 档 ≥10000 样本分布重归一（common 66.27% ±2、rare 33.73% ±2）', () => {
  const items = require('../../server/core/items.js');
  const { createRng } = require('../../server/core/rng.js');
  const N = 20000;
  const rng = createRng(424242);
  const counts = {};
  for (let i = 0; i < N; i++) {
    const it = items.openBox(rng, { tier: 'rare' });
    counts[it.quality] = (counts[it.quality] || 0) + 1;
  }
  // 机器推导：common = 0.55/(0.55+0.28) = 0.66265…；rare = 0.28/0.83 = 0.33735…（T-IT-1 误差 <2% 口径）
  const commonPct = counts.common / N;
  const rarePct = counts.rare / N;
  assert.ok(Math.abs(commonPct - 0.55 / 0.83) < 0.02, `common ${(commonPct * 100).toFixed(2)}% 应 ≈66.27%`);
  assert.ok(Math.abs(rarePct - 0.28 / 0.83) < 0.02, `rare ${(rarePct * 100).toFixed(2)}% 应 ≈33.73%`);
  assert.equal(counts.epic, undefined, 'rare 档无 epic+');
});

// P1-1 回归补：rollQuality 非法 tier 保守全池（不兜顶）→ 全池分布（common ≈55%）
test('B17-7 P1-1 回归：rollQuality 非法 tier → 全池重归一分布（common ≈55%）', () => {
  const items = require('../../server/core/items.js');
  const { createRng } = require('../../server/core/rng.js');
  const N = 20000;
  const rng = createRng(777);
  const counts = {};
  for (let i = 0; i < N; i++) {
    const q = items.rollQuality(rng, 'diamond'); // 非法段位 → 保守全池（与 openBox 的门控抛错解耦直测）
    counts[q] = (counts[q] || 0) + 1;
  }
  const commonPct = counts.common / N;
  assert.ok(Math.abs(commonPct - 0.55) < 0.02, `common ${(commonPct * 100).toFixed(2)}% 应 ≈55%（全池 dropRates）`);
  const seen = Object.keys(counts);
  assert.ok(seen.length >= 3, `非法 tier 直通应覆盖多档: ${seen.join('/')}`);
});