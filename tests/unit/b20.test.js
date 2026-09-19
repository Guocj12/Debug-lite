'use strict';
// B20 技能插件消耗补偿与聚合 + 插件门控真分支 —— 依据 tasks §3.6 T-PB-5/6/7；
// examples/01-items.md I-5/I-6（档位/词条数值）+ I-9（门控）；systems S-2b/S-3（D-113）与 01-items §4.10。
// 数值一律机器推导：消耗补偿 = costDeltaBase[quality] × tier（delta），加在 costDeltaByTier 声明的维度上。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const items = require('../../server/core/items.js');
const skills = require('../../server/core/skills.js');
const unlock = require('../../server/core/unlock.js');
const loadout = require('../../server/loadout.js');
const PLUGINS = require('../../server/data/plugins.json').plugins;

// 构造插件物品（B20 测试基具；costDeltaByTier 从数据定义透传——减耗类为 null）
function mkPlugin(p) {
  const def = PLUGINS.find((d) => d.id === p.id) || {};
  return Object.assign({
    uid: `p_${p.id}`, kind: 'skillPlugin', id: p.id, slot: def.slot || 'basic',
    quality: p.quality || 'rare', tier: p.tier || 1,
    affixes: p.affixes || def.affixes || [],
    costDeltaByTier: def.costDeltaByTier !== undefined ? def.costDeltaByTier : null,
    equipped: false,
  }, p.extra || {});
}

test('T-PB-5 消耗补偿单调：非减耗类 cost 单调不减（delta ≥ 0）；减耗类 costDeltaByTier === null 且 cost 下降', () => {
  // 数据层：costDeltaByTier 非 null 的插件才声明维数组；减耗类仅 sp_cost_down 为 null
  const nonNull = PLUGINS.filter((x) => x.kind === 'skillPlugin' && x.costDeltaByTier !== null);
  const nullList = PLUGINS.filter((x) => x.kind === 'skillPlugin' && x.costDeltaByTier === null);
  assert.ok(nonNull.length > 0, '存在非减耗技能插件');
  assert.deepEqual(nullList.map((x) => x.id), ['sp_cost_down'], '减耗类仅 sp_cost_down（costDeltaByTier=null）');
  for (const def of nonNull) {
    const base = { ...BASE_SKILL };
    const applied = skills.applySkillPlugins({ ...base }, [mkPlugin({ id: def.id, tier: 1, quality: def.costDeltaByTier ? 'common' : 'rare', affixes: def.affixes })]);
    for (const dim of Object.keys(def.costDeltaByTier || {})) {
      assert.ok(applied.cost[dim] >= base.cost[dim], `${def.id} cost.${dim} 单调不减`);
    }
  }
  // 减耗类：cost × (1−0.2) ceil 后下降
  const applied = skills.applySkillPlugins({ ...BASE_SKILL }, [mkPlugin({ id: 'sp_cost_down', tier: 1, affixes: [{ id: 'cost_down', params: { v: 0.2 } }] })]);
  assert.equal(applied.cost.mp, 8, '10×0.8 ceil = 8（S-3）');
});

test('T-PB-6 词条聚合机器推导：消耗补偿 delta = costDeltaBase×tier；倍率 = 1.2×1.15 = 1.38', () => {
  const base = { ...BASE_SKILL };
  const applied = skills.applySkillPlugins(base, [
    mkPlugin({ id: 'sp_mult', tier: 2, affixes: [{ id: 'mult_up', params: { v: 0.15 } }] }), // rare 基准 costDeltaBase 3
  ]);
  assert.equal(applied.cost.mp, 16, '10 + 3×2 = 16（D-113）');
  assert.equal(applied.multiplier, 1.38, '1.2×(1+0.15) 三位取整 = 1.38');
  // 面板一致性：buildPanel 输出的技能参数与 applySkillPlugins 一致
  const LD = require('../fixtures/loadout-ok.json');
  const p = loadout.buildPanel(LD.loadout, { warehouse: LD.warehouse, tier: 'mythic' });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.equal(p.panel.skills[0].params.cost.mp, 16, '面板反映消耗补偿（s1 装 qx rare tier2）');
  assert.equal(p.panel.skills[0].params.multiplier, 1.38, '面板反映倍率聚合');
});

test('T-PB-7 门控（开启 = 回退模式）：带 unlockTier 插件不进低段位掉落池、不可装配；数据含高段位插件（U-5d 真分支）', () => {
  const gatedPlugins = PLUGINS.filter((x) => x.unlockTier);
  assert.ok(gatedPlugins.length >= 2, `数据含 ≥2 个带 unlockTier 插件（实际 ${gatedPlugins.length}）`);
  assert.ok(gatedPlugins.every((x) => x.unlockTier === 'legendary'));
  const gatedItems = items.withGating(true);
  const gatedUnlock = unlock.withGating(true);
  // 掉落池：rare 段位 500 抽不得 sp_displacement/rp_sp_opt；mythic 500 抽可出
  const { createRng } = require('../../server/core/rng.js');
  const rLow = createRng(2026);
  let lowHit = false;
  for (let i = 0; i < 500; i++) {
    const it = gatedItems.openBox(rLow, { tier: 'rare' });
    if (it.id === 'sp_displacement' || it.id === 'rp_sp_opt') lowHit = true;
  }
  assert.equal(lowHit, false, '低段位不进掉落池（T-PB-7）');
  const rHigh = createRng(2026);
  let highHit = false;
  for (let i = 0; i < 500; i++) {
    const it = gatedItems.openBox(rHigh, { tier: 'mythic' });
    if (it.id === 'sp_displacement' || it.id === 'rp_sp_opt') highHit = true;
  }
  assert.equal(highHit, true, 'mythic 段位可出（数据门控真分支）');
  // 装配门控：unlockTier legendary 插件 + rare → tier_locked（B18 assemble 路径复用）
  const WH = JSON.parse(JSON.stringify(require('../fixtures/wh-ok.json')));
  WH.buckets.rolePlugin.push({ uid: 'g1', kind: 'rolePlugin', id: 'rp_sp_opt', slot: 'sp', quality: 'legendary', tier: 3, pointCost: 3, affixes: [], unlockTier: 'legendary', equipped: false });
  WH.buckets.role[0].slots.push({ type: 'sp', pluginUid: null });
  const r = gatedItems.assemble(WH, { targetUid: 'r1', slotIndex: 2, pluginUid: 'g1', tier: 'rare' });
  assert.equal(r.code, 'tier_locked', '装配门控（T-PB-7/§4.10）');
  const ok = gatedItems.assemble(WH, { targetUid: 'r1', slotIndex: 2, pluginUid: 'g1', tier: 'mythic' });
  assert.equal(ok.ok, true, 'mythic 放行');
  // U-5d 真分支（unlock.validateLoadout 插件臂）
  const v = gatedUnlock.validateLoadout({ role: { templateId: 'role_bal' }, skills: [], plugins: [{ uid: 'p1', id: 'rp_sp_opt' }] }, 'rare');
  assert.equal(v.ok, false);
  assert.equal(v.errors[0].code, 'tier_locked');
});

test('T-PB-7b 门控关闭（默认）：低段位同样能开出高段位插件、也能装配（用户决策 2026-09-16）', () => {
  const { createRng } = require('../../server/core/rng.js');
  const r = createRng(2026);
  let hit = false;
  for (let i = 0; i < 500; i++) {
    const it = items.openBox(r, { tier: 'rare' });
    if (it.id === 'sp_displacement' || it.id === 'rp_sp_opt') hit = true;
  }
  assert.equal(hit, true, 'rare 段位池含 legendary 插件（段位不参与掉落池过滤）');
  const WH = JSON.parse(JSON.stringify(require('../fixtures/wh-ok.json')));
  WH.buckets.rolePlugin.push({ uid: 'g1', kind: 'rolePlugin', id: 'rp_sp_opt', slot: 'sp', quality: 'legendary', tier: 3, pointCost: 3, affixes: [], unlockTier: 'legendary', equipped: false });
  WH.buckets.role[0].slots.push({ type: 'sp', pluginUid: null });
  const a = items.assemble(WH, { targetUid: 'r1', slotIndex: 2, pluginUid: 'g1', tier: 'rare' });
  assert.equal(a.ok, true, '门控关闭：装配不再因段位拒绝');
  const v = unlock.validateLoadout({ role: { templateId: 'role_bal' }, skills: [], plugins: [{ uid: 'p1', id: 'rp_sp_opt' }] }, 'rare');
  assert.deepEqual(v, { ok: true, errors: [] }, 'validateLoadout 恒放行');
});

test('T-PB-8/9 汇总（B18/B19 已覆盖）：本批回归引用完整性与唯一性不变量在面板聚合后仍成立', () => {
  const LD = require('../fixtures/loadout-ok.json');
  const v = loadout.validateLoadout(LD.loadout, { warehouse: LD.warehouse, tier: 'mythic' });
  assert.equal(v.ok, true, '装配引用完整（T-PB-9）');
  const f2 = JSON.parse(JSON.stringify(LD));
  f2.loadout.skills[0].slots = [{ type: 'basic', pluginUid: 'pa' }, { type: 'basic', pluginUid: 'pa' }];
  const v2 = loadout.validateLoadout(f2.loadout, { warehouse: f2.warehouse, tier: 'mythic' });
  assert.equal(v2.ok, false, '双引用拒绝（T-PB-8）');
});

const BASE_SKILL = {
  type: 'straight', cost: { hp: 0, mp: 10, sp: 0 }, multiplier: 1.2, cooldown: 3,
  bulletLevel: 3, range: 10, bulletCount: 3, affixes: [],
};