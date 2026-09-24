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

test('B17-1 正常开箱：个数=times、物品形状、seed 回带（门控关闭 = 默认：品质不受段位限制）', () => {
  const r = box.openBoxes({ seed: 20260913, tier: 'rare', times: 10 });
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 10);
  assert.equal(r.data.seed, 20260913);
  assert.equal(r.data.tier, 'rare');
  assert.equal(r.data.times, 10);
  for (const it of r.data.items) {
    assert.equal(typeof it.uid, 'string');
    assert.ok(['role', 'skill', 'rolePlugin', 'skillPlugin'].includes(it.kind), `kind=${it.kind}`);
    // 门控关闭（用户决策 2026-09-16）：tier 只作回带信息，品质取自全池 dropRates
    assert.ok(['common', 'rare', 'epic', 'legendary', 'mythic'].includes(it.quality), `品质合法: ${it.quality}`);
  }
});

test('B17-2 品质上限（D-122/RK-5）：门控开启时 common 段位只能出 common、mythic 全池；门控关闭时任意 tier 都能出最高品质', () => {
  // ① 门控开启（回退模式）：段位序号即品质上限，截断后按剩余池重归一
  const gatedItems = require('../../server/core/items.js').withGating(true);
  const cOn = box.openBoxes({ seed: 7, tier: 'common', times: 50, items: gatedItems });
  for (const it of cOn.data.items) assert.equal(it.quality, 'common', 'common 段位只有绿（RK-5a）');
  const mOn = box.openBoxes({ seed: 7, tier: 'mythic', times: 50, items: gatedItems });
  const seenOn = new Set(mOn.data.items.map((x) => x.quality));
  assert.ok(seenOn.has('common') && seenOn.size <= 5, `mythic 全池（含非绿概率）: ${[...seenOn]}`);
  // ② 门控关闭（默认）：tier 不再影响品质池 —— 同 seed 下 common 与 mythic 的品质序列逐项相同
  const { createRng } = require('../../server/core/rng.js');
  const coreItems = require('../../server/core/items.js');
  const cOff = box.openBoxes({ seed: 7, tier: 'common', times: 100 });
  const mOff = box.openBoxes({ seed: 7, tier: 'mythic', times: 100 });
  assert.deepEqual(cOff.data.items.map((x) => x.quality), mOff.data.items.map((x) => x.quality), 'common 与 mythic 同 seed 品质序列相同（tier 不参与）');
  for (const it of cOff.data.items) {
    assert.ok(['common', 'rare', 'epic', 'legendary', 'mythic'].includes(it.quality), `品质合法: ${it.quality}`);
    // 掉落池同样不按段位过滤：common tier 也能出高段位模板（元数据 unlockTier 仅作展示）
    const def = it.templateId
      ? (require('../../server/data/role-templates.json').roleTemplates.concat(require('../../server/data/skill-templates.json').skillTemplates).find((t) => t.id === it.templateId) || {})
      : (require('../../server/data/plugins.json').plugins.find((p) => p.id === it.id) || {});
    if (def.unlockTier) assert.ok(typeof def.unlockTier === 'string', 'unlockTier 元数据保留');
  }
  // 任意 tier 都能出最高品质：core 直调大样本（绕开 box 的 times ≤ BOX_TIMES_MAX 请求上限）
  const rng = createRng(11);
  const seen = new Set();
  for (let i = 0; i < 3000; i++) seen.add(coreItems.rollQuality(rng, 'common'));
  assert.ok(seen.has('mythic'), `门控关闭：common tier 也能出 mythic（实际 ${[...seen].join('/')}）`);
  assert.equal(seen.size, 5, `五档品质全部可达: ${[...seen].join('/')}`);
  assert.equal(box.openBoxes({ seed: 20260913, tier: 'rare', times: 10 }).status, 200, 'tier 参数仍被接受（仅不再起门控作用）');
  // 非法 tier 仍是参数错误（参数校验与门控是两件事）
  assert.equal(box.openBoxes({ seed: 7, tier: 'diamond' }).code, 'bad_tier');
});

test('B17-3 种子确定性：同 seed 内容级一致；缺 seed 生成并回带', () => {
  const a = box.openBoxes({ seed: 12345, tier: 'epic', times: 8 });
  const b = box.openBoxes({ seed: 12345, tier: 'epic', times: 8 });
  assert.deepEqual(a.data.items.map(contentOf), b.data.items.map(contentOf), '同 seed 内容一致');
  const g = box.openBoxes({ tier: 'common', times: 3 });
  assert.equal(g.status, 200);
  assert.ok(Number.isInteger(g.data.seed) && g.data.seed >= 1, `服务端生成 seed=${g.data.seed}`);
});

test('B17-4 参数错误：bad_tier / bad_times / bad_seed（显式非法 seed 一律拒绝，含非数值）', () => {
  assert.equal(box.openBoxes({ tier: 'diamond' }).code, 'bad_tier');
  assert.equal(box.openBoxes({ times: 0 }).code, 'bad_times');
  assert.equal(box.openBoxes({ times: -1 }).code, 'bad_times');
  assert.equal(box.openBoxes({ times: 1.5 }).code, 'bad_times');
  assert.equal(box.openBoxes({ times: box.BOX_TIMES_MAX + 1 }).code, 'bad_times');
  // D-162：HTTP 层**不传** seed（随机性服务端独占）；但**进程内调用方显式提供了非法值**时
  //   **必须如实 400 `bad_seed`**（不静默忽略——静默会让内部调用方把拼错的参数当成生效）。
  //   非数值（如 'abc'）与数值越界一视同仁。
  assert.equal(box.openBoxes({ seed: 'abc' }).code, 'bad_seed', '非数值显式 seed → bad_seed（不静默忽略）');
  assert.equal(box.openBoxes({ seed: 'abc' }).status, 400);
  assert.equal(box.openBoxes({ seed: null }).status, 200, 'null = 未提供 → 服务端生成（HTTP 路径同此语义）');
  assert.equal(box.openBoxes({ seed: undefined }).status, 200, 'undefined = 未提供 → 服务端生成');
  // 数值型越界 seed 同样如实拒绝
  assert.equal(box.openBoxes({ seed: 0 }).code, 'bad_seed');
  assert.equal(box.openBoxes({ seed: -1 }).code, 'bad_seed');
  assert.equal(box.openBoxes({ seed: 1.5 }).code, 'bad_seed');
  assert.equal(box.openBoxes({ seed: 0x80000000 }).code, 'bad_seed', 'seed 上界（防 32 位回绕）');
  assert.equal(box.openBoxes({ seed: 4294967297 }).code, 'bad_seed', 'seed ≥2^32 拒绝（P2 落实）');
  // 未提供时由服务端生成合法 seed 并回带
  const generated = box.openBoxes({});
  assert.ok(Number.isInteger(generated.data.seed) && generated.data.seed >= 1 && generated.data.seed <= 0x7fffffff,
    `缺省 seed 由服务端生成且合法：${generated.data.seed}`);
  // D-162 注入缝：`opts.seedFactory` 优先于 crypto（HTTP 层由 `start({boxSeed})` 接线）
  assert.equal(box.openBoxes({ seedFactory: () => 77 }).data.seed, 77, 'seedFactory 提供确定性 seed');
  assert.equal(box.openBoxes({ seed: 88, seedFactory: () => 77 }).data.seed, 88, '显式数值 seed 优先于 seedFactory');
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
// 采样走 core 直调（box.openBoxes 有 times≤100 请求上限，分布样本需 core 级 rng 序列）；
// **门控开启**（withGating(true)）时才有"截断 + 重归一"，门控关闭（默认）见 B17-6b。
test('B17-6 P1-1 回归（门控开启）：rare 档 ≥10000 样本分布重归一（common 66.27% ±2、rare 33.73% ±2）', () => {
  const items = require('../../server/core/items.js').withGating(true);
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

test('B17-6b 门控关闭（默认）：任意 tier 的品质分布 = 全池 dropRates（不截断、不重归一）', () => {
  const items = require('../../server/core/items.js');
  const { createRng } = require('../../server/core/rng.js');
  const drop = require('../../server/data/items-config.json').dropRates;
  const N = 20000;
  const rng = createRng(424242);
  const counts = {};
  for (let i = 0; i < N; i++) {
    const it = items.openBox(rng, { tier: 'rare' }); // rare 与 common 分布应完全相同（tier 不参与）
    counts[it.quality] = (counts[it.quality] || 0) + 1;
  }
  for (const [id, p] of Object.entries(drop)) {
    assert.ok(Math.abs(counts[id] / N - p) < 0.02, `${id} 频率 ${(counts[id] / N * 100).toFixed(2)}% 应 ≈ ${(p * 100).toFixed(2)}%（全池）`);
  }
  const rngCommon = createRng(424242);
  const same = [];
  for (let i = 0; i < 200; i++) same.push(items.openBox(rngCommon, { tier: 'common' }).quality);
  const rngRare = createRng(424242);
  const same2 = [];
  for (let i = 0; i < 200; i++) same2.push(items.openBox(rngRare, { tier: 'rare' }).quality);
  assert.deepEqual(same, same2, 'common 与 rare 同 seed 逐次品质相同（tier 不再影响品质池）');
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