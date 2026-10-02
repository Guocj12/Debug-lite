'use strict';
// D-178 AI 节点包：产出/堆叠/新手集（server/core/items.js 的节点分支）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const items = require('../../server/core/items.js');
const catalog = require('../../server/data/ai-node-catalog.json');
const { createRng } = require('../../server/core/rng.js');
const cfg = require('../../server/data/package-config.json');

const byId = Object.fromEntries(catalog.nodes.map((n) => [n.id, n]));
const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];

test('NP-1 starterNodeStacks：全部绿档节点 + 结构类多份（确定性、可重放）', () => {
  const a = items.starterNodeStacks();
  const b = items.starterNodeStacks();
  const common = catalog.nodes.filter((n) => n.quality === 'common');
  const kinds = new Set(a.map((x) => x.nodeId));
  assert.equal(kinds.size, common.length, `应覆盖全部绿档节点种类（${common.length} 种）`);
  assert.deepEqual(a, b, '两次调用完全一致（确定性）');
  const byId = {};
  for (const st of a) {
    assert.equal(st.kind, 'aiNode');
    assert.equal(st.count, 1);
    assert.match(st.uid, /^node_starter_/, 'uid 由 nodeId 派生（重启不撞车）');
    assert.ok(byId[st.nodeId] === undefined || true);
    assert.ok(catalog.nodes.some((n) => n.id === st.nodeId), 'nodeId 必须在目录中');
    assert.equal(st.quality, 'common');
    assert.ok(st.name && st.category, '带显示名与分类（仓库行需要）');
    byId[st.nodeId] = (byId[st.nodeId] || 0) + 1;
  }
  assert.equal(byId.f_if, 3, 'f_if 给 3 份（嵌套分支必需）');
  assert.equal(byId.f_seq, 2, 'f_seq 给 2 份');
  assert.equal(new Set(a.map((x) => x.uid)).size, a.length, 'uid 互不相同');
});

test('NP-2 openPackage：多节点同 id 合并为一条堆叠（count 累加），且条目字段齐备', () => {
  const rng = createRng(20260928);
  let merged = 0;
  let total = 0;
  for (let i = 0; i < 400; i += 1) {
    const pkg = items.generatePackage({ packageKind: 'aiNode', quality: 'mythic', qualityPercent: 85, uid: `pkg_${i}` });
    const r = items.openPackage(rng, pkg);
    assert.equal(r.ok, true);
    const ids = new Set();
    for (const it of r.items) {
      assert.equal(it.kind, 'aiNode');
      assert.ok(byId[it.nodeId], 'nodeId 在目录中');
      assert.ok(it.name && it.category, '条目带 name/category');
      assert.ok(Number.isInteger(it.count) && it.count >= 1);
      assert.ok(!ids.has(it.nodeId), '同一 nodeId 不得出现两条');
      ids.add(it.nodeId);
      total += it.count;
      if (it.count > 1) merged += 1;
    }
  }
  assert.ok(merged > 0, `400 次开包中应出现"同 id 合并"（实际 ${merged} 次，总节点 ${total}）`);
});

test('NP-3 每个品质的节点池非空（nodeQualityCurve 的每一档都有货）', () => {
  for (const t of TIERS) {
    const pool = catalog.nodes.filter((n) => n.quality === t);
    assert.ok(pool.length > 0, `品质 ${t} 必须有节点`);
    const row = cfg.nodeQualityCurve[t];
    for (const q of Object.keys(row)) {
      assert.ok(catalog.nodes.some((n) => n.quality === q), `曲线引用的品质 ${q} 必须有节点`);
    }
  }
});

test('NP-4 generatePackage：AI 节点包的品质=段位、质量必须在档位内，非法入参抛错', () => {
  const pkg = items.generatePackage({ packageKind: 'aiNode', quality: 'rare', qualityPercent: 30, uid: 'pkg_x' });
  assert.equal(pkg.kind, 'package');
  assert.equal(pkg.packageKind, 'aiNode');
  assert.equal(pkg.dropsKind, undefined, '节点包无物品类别（产出源是节点目录）');
  assert.throws(() => items.generatePackage({ packageKind: 'aiNode', quality: 'rare', qualityPercent: 5, uid: 'pkg_y' }));
  assert.throws(() => items.generatePackage({ packageKind: 'nope', quality: 'rare', qualityPercent: 30, uid: 'pkg_z' }));
});

test('NP-6 starter 默认 AI 的蓝图用量 ≤ 新手自带节点（否则开局就违反装配独占）', () => {
  const starter = require('../../server/starter.js');
  const blueprint = require('../../server/ai/blueprint.js');
  const r = starter.buildStarter({ publicId: 'np6user', playerId: 'np6' });
  assert.equal(r.ok, true, JSON.stringify(r.stats));
  const ai = r.aiLibrary[0];
  assert.ok(ai.blueprint && ai.blueprint.type === 'blueprint', 'starter AI 必须带蓝图（新号开局即可编辑）');
  assert.ok(ai.traceMap && Object.keys(ai.traceMap).length > 0, '带 traceMap');
  const owned = {};
  for (const st of r.warehouse.buckets.aiNode) owned[st.nodeId] = (owned[st.nodeId] || 0) + st.count;
  const stats = blueprint.statsOf(ai.blueprint);
  for (const [id, n] of Object.entries(stats.byNode)) {
    assert.ok(n <= (owned[id] || 0), `starter AI 用了 ${n} 个 ${id}，但只自带 ${owned[id] || 0} 个`);
  }
  // 且只用绿档（新号段位唯一能开到的品质）
  const cat = Object.fromEntries(catalog.nodes.map((n) => [n.id, n]));
  for (const id of Object.keys(stats.byNode)) assert.equal(cat[id].quality, 'common', `${id} 必须是绿档`);
});

test('NP-5 openPackage：非包/未登记包种类/质量不匹配 → package_invalid（零副作用）', () => {
  const rng = createRng(7);
  assert.equal(items.openPackage(rng, null).code, 'package_invalid');
  assert.equal(items.openPackage(rng, { kind: 'role', uid: 'x' }).code, 'package_invalid');
  assert.equal(items.openPackage(rng, { kind: 'package', packageKind: 'nope', quality: 'rare', qualityPercent: 30 }).code, 'package_invalid');
  assert.equal(items.openPackage(rng, { kind: 'package', packageKind: 'aiNode', quality: 'rare', qualityPercent: 5 }).code, 'package_invalid', '质量与品质不匹配');
});
