'use strict';
// B19 loadout 校验与面板契约测试 —— 依据 examples/01-items.md I-12 全案；systems/01-items.md §4.12；
// tasks §3.6 T-PB-9（引用完整性）+ T-IT-8/T-RK-6（往返无损）；面板数值机器推导（I-8 公式）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadout = require('../../server/loadout.js');
const FIXTURE = require('../fixtures/loadout-ok.json');

const fixture = () => JSON.parse(JSON.stringify(FIXTURE));

test('I-12a 合法 loadout 通过（角色 1 + 技能 3 + AI 合法 + 引用完整 + 门控过）', () => {
  const v = loadout.validateLoadout(fixture().loadout, { warehouse: fixture().warehouse, tier: 'mythic' });
  assert.equal(v.ok, true, JSON.stringify(v.errors));
});

test('I-12b 技能数 ≠ 3 → loadout_invalid；角色/技能/AI 缺失同样拒绝', () => {
  const f2 = fixture();
  f2.loadout.skills = f2.loadout.skills.slice(0, 2);
  const v2 = loadout.validateLoadout(f2.loadout, { warehouse: f2.warehouse, tier: 'mythic' });
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.where === 'skills' && e.message.includes('3')), JSON.stringify(v2.errors));
  const f3 = fixture();
  f3.loadout.role = null;
  const v3 = loadout.validateLoadout(f3.loadout, { warehouse: f3.warehouse, tier: 'mythic' });
  assert.equal(v3.ok, false);
  assert.ok(v3.errors.some((e) => e.where === 'role'));
  const f4 = fixture();
  f4.loadout.ai = null;
  const v4 = loadout.validateLoadout(f4.loadout, { warehouse: f4.warehouse, tier: 'mythic' });
  assert.equal(v4.ok, false);
  assert.ok(v4.errors.some((e) => e.where === 'ai'));
});

test('T-PB-9/I-12d 引用完整性：悬挂引用与未装配插件 → loadout_invalid', () => {
  const f1 = fixture();
  f1.loadout.role.slots[0].pluginUid = 'ghost';
  f1.warehouse.buckets.role[0].slots[0].pluginUid = 'ghost';
  const v1 = loadout.validateLoadout(f1.loadout, { warehouse: f1.warehouse, tier: 'mythic' });
  assert.equal(v1.ok, false);
  assert.ok(v1.errors.some((e) => e.message.includes('悬挂引用')), JSON.stringify(v1.errors));
  const f2 = fixture();
  f2.warehouse.buckets.rolePlugin[0].equipped = false; // 装配引用但插件未装配
  const v2 = loadout.validateLoadout(f2.loadout, { warehouse: f2.warehouse, tier: 'mythic' });
  assert.equal(v2.ok, false);
  assert.ok(v2.errors.some((e) => e.message.includes('未装配')), JSON.stringify(v2.errors));
});

test('I-12e 段位门控：物品解锁段位 > tier → 拒绝；AI 节点超段位 → 拒绝', () => {
  const f1 = fixture();
  f1.loadout.role.unlockTier = 'legendary';
  f1.warehouse.buckets.role[0].unlockTier = 'legendary';
  const v1 = loadout.validateLoadout(f1.loadout, { warehouse: f1.warehouse, tier: 'rare' });
  assert.equal(v1.ok, false, '角色超段位');
  // s3 的 unlockTier=mythic → rare 拒绝（fixture 里 s3 本身 mythic）
  const v2 = loadout.validateLoadout(fixture().loadout, { warehouse: fixture().warehouse, tier: 'rare' });
  assert.equal(v2.ok, false, '技能 s3 mythic 超 rare');
  // AI 节点门控：加入 random（epic）→ common 拒绝
  const f3 = fixture();
  f3.loadout.ai.body.statements.push({ type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] }, else: null });
  f3.warehouse.buckets.skill[2].unlockTier = 'common';
  const v3 = loadout.validateLoadout(f3.loadout, { warehouse: f3.warehouse, tier: 'common' });
  assert.equal(v3.ok, false, `AI random 超 common（s3 改为 common 以免干扰）`);
  assert.ok(v3.errors.some((e) => e.where.startsWith('ai:')), JSON.stringify(v3.errors));
});

test('I-12a AI 非法（分支无 action）→ loadout_invalid（带 ai: 路径）', () => {
  const f = fixture();
  f.loadout.ai.body.statements.push({ type: 'loop', kind: 'count', times: { type: 'literal', value: 2 }, body: { type: 'seq', statements: [{ type: 'set', name: 'x', value: { type: 'literal', value: 1 } }] } });
  const v = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.where.startsWith('ai:')), JSON.stringify(v.errors));
});

test('T-IT-8/T-RK-6 往返无损：校验通过后回带 loadout 深度相等（JSON 往返）', () => {
  const f = fixture();
  const orig = JSON.stringify(f.loadout);
  const v = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  assert.equal(v.ok, true);
  assert.equal(JSON.stringify(JSON.parse(orig)), JSON.stringify(f.loadout), 'loadout 对象未被修改');
});

test('B19 面板聚合（I-8 公式机器推导）：atk=round(20×1.10)=22、hp=round(100×1+50)=150、critChance=0.5、regen 直透', () => {
  const f = fixture();
  const p = loadout.buildPanel(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  const role = p.panel.role;
  assert.equal(role.stats.atk, 22, '20×1.10 取整 = 22');
  assert.equal(role.stats.hp, 150, '100+50 = 150');
  assert.equal(role.stats.def, 8, '无词条不变');
  assert.deepEqual(role.special, { critChance: 0.5 }, '概率词条进 special');
  assert.deepEqual(role.regen, { mp: 1, sp: 2 });
  assert.equal(role.pluginPoints, 4);
  assert.equal(role.quality, 'epic');
  assert.equal(p.panel.skills.length, 3, '技能参数直透');
  assert.equal(p.panel.skills[0].params.multiplier, 1.38, 'B20 聚合：1.2×(1+0.15) = 1.38（sp_mult）');
  assert.equal(p.panel.skills[0].params.cost.mp, 16, 'B20 消耗补偿：10 + costDeltaBase.rare(3)×tier2 = 16');
  // 非法 loadout → panel 拒绝
  const f2 = fixture();
  f2.loadout.skills = f2.loadout.skills.slice(0, 2);
  const p2 = loadout.buildPanel(f2.loadout, { warehouse: f2.warehouse, tier: 'mythic' });
  assert.equal(p2.ok, false);
});

test('B19 防御：loadout/warehouse 缺失或畸形 → 拒绝不抛', () => {
  const v1 = loadout.validateLoadout(null, { tier: 'mythic' });
  assert.equal(v1.ok, false);
  const f = fixture();
  f.warehouse.buckets.rolePlugin = 'abc'; // 畸形桶 → 引用解析失败 → 优雅拒绝（不抛 TypeError）
  const v2 = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  assert.equal(v2.ok, false, '畸形桶 → 拒绝（不抛）');
  assert.ok(v2.errors.some((e) => e.message.includes('悬挂引用')), JSON.stringify(v2.errors));
  const v3 = loadout.validateLoadout({ role: { kind: 'rolePlugin', uid: 'x' }, skills: [], ai: {} }, { tier: 'mythic' });
  assert.equal(v3.ok, false);
});

// P1-1 回归（审查 docs/reviews/B19.md）：skills 缺失/非数组不崩溃（B18 P1-1 同型漏网）
test('P1-1 回归：skills 非数组/缺失 + wh 存在 → 拒绝不抛（不 500）', () => {
  const f = fixture();
  f.loadout.skills = null;
  const v1 = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  assert.equal(v1.ok, false);
  assert.ok(v1.errors.some((e) => e.where === 'skills'), JSON.stringify(v1.errors));
  const f2 = fixture();
  f2.loadout.skills = 'nope';
  const v2 = loadout.validateLoadout(f2.loadout, { warehouse: f2.warehouse, tier: 'mythic' });
  assert.equal(v2.ok, false, 'skills 非数组 + 有 warehouse → 拒绝不抛');
});

// P1-2 回归：同一插件双处引用 → 拒绝（T-PB-8；面板词条不再双计）
test('P1-2 回归：同一插件双引用（同目标双槽/跨目标）→ loadout_invalid', () => {
  const f1 = fixture();
  f1.loadout.role.slots = [
    { type: 'atk', pluginUid: 'pa' },
    { type: 'atk', pluginUid: 'pa' }, // 同 uid 双槽
  ];
  const v1 = loadout.validateLoadout(f1.loadout, { warehouse: f1.warehouse, tier: 'mythic' });
  assert.equal(v1.ok, false, '同目标双槽引用同一插件 → 拒绝');
  assert.ok(v1.errors.some((e) => e.message.includes('双处引用')), JSON.stringify(v1.errors));
  // 跨目标：技能槽引用 pa
  const f2 = fixture();
  f2.loadout.skills[0].slots = [{ type: 'basic', pluginUid: 'pa' }];
  f2.warehouse.buckets.rolePlugin[0].equipped = true;
  const v2 = loadout.validateLoadout(f2.loadout, { warehouse: f2.warehouse, tier: 'mythic' });
  assert.equal(v2.ok, false, '跨目标双引用 → 拒绝');
  assert.ok(v2.errors.some((e) => e.message.includes('双处引用')), JSON.stringify(v2.errors));
});

// P1-3 回归：带装配引用但无 warehouse → missing_warehouse（引用校验不得空转）；空装配无 warehouse 放行
test('P1-3 回归：装配引用缺 warehouse → missing_warehouse；空装配放行；插件门控复核', () => {
  const f1 = fixture();
  const v1 = loadout.validateLoadout(f1.loadout, { tier: 'mythic' }); // 有引用（pa/pb）无 warehouse
  assert.equal(v1.ok, false);
  assert.ok(v1.errors.some((e) => e.code === 'missing_warehouse'), JSON.stringify(v1.errors));
  // 空装配（无引用）+ 无 warehouse → 放行
  const f2 = fixture();
  f2.loadout.role.slots = [{ type: 'atk', pluginUid: null }, { type: 'hp', pluginUid: null }];
  f2.loadout.skills = f2.loadout.skills.map((s) => ({ ...s, slots: [{ type: 'basic', pluginUid: null }] }));
  const v2 = loadout.validateLoadout(f2.loadout, { tier: 'mythic' });
  assert.equal(v2.ok, true, '空装配无 warehouse → 放行（面板即最终值）');
  // 插件门控复核（P2-2）：warehouse 中插件 unlockTier 超 tier → 拒绝
  const f3 = fixture();
  f3.warehouse.buckets.rolePlugin[0].unlockTier = 'legendary';
  const v3 = loadout.validateLoadout(f3.loadout, { warehouse: f3.warehouse, tier: 'rare' });
  assert.equal(v3.ok, false, '插件超段位 → 拒绝');
  assert.ok(v3.errors.some((e) => e.message.includes('需 legendary')), JSON.stringify(v3.errors));
});

// P2-3 回归：AI 错误 >5 条 → 截断标记
test('P2-3 回归：AI 错误截断标记', () => {
  const f = fixture();
  f.loadout.ai.body.statements.push(...[1, 2, 3, 4, 5, 6, 7].map((i) => ({ type: 'alienType' + i, i })));
  const v = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.message.includes('已截断')), JSON.stringify(v.errors));
});

// P1-1 回归（审查 docs/reviews/B20.md）：未知模板/品质 → 校验拒绝（面板聚合路径不再 500）
test('P1-1 回归：未知技能模板/品质 → loadout_invalid（不抛）', () => {
  const f1 = fixture();
  f1.loadout.skills[0].templateId = 'nope_not_a_template';
  const v1 = loadout.validateLoadout(f1.loadout, { warehouse: f1.warehouse, tier: 'mythic' });
  assert.equal(v1.ok, false, '未知技能模板拒绝');
  assert.ok(v1.errors.some((e) => e.where === 'skills[0]' && e.message.includes('未知技能模板')), JSON.stringify(v1.errors));
  const f2 = fixture();
  f2.loadout.skills[1].quality = 'platinum';
  const v2 = loadout.validateLoadout(f2.loadout, { warehouse: f2.warehouse, tier: 'mythic' });
  assert.equal(v2.ok, false, '未知品质拒绝');
  const f3 = fixture();
  f3.loadout.role.templateId = 'ghost_role';
  const v3 = loadout.validateLoadout(f3.loadout, { warehouse: f3.warehouse, tier: 'mythic' });
  assert.equal(v3.ok, false, '未知角色模板拒绝');
  // 面板同样拒绝（不再 500）
  const p1 = loadout.buildPanel(f1.loadout, { warehouse: f1.warehouse, tier: 'mythic' });
  assert.equal(p1.ok, false);
  assert.equal(p1.errors[0].where, 'skills[0]');
});

// B20 P2 落实回归：类别错配/缺 tier 插件拒绝；junkField 透传；非声明维不变
test('B20 P2 回归：技能槽类别错配与缺 tier 插件拒绝；junkField 透传；非声明维度不变', () => {
  const f1 = fixture();
  f1.loadout.skills[0].slots = [{ type: 'basic', pluginUid: 'pa' }]; // rolePlugin 装技能槽
  const v1 = loadout.validateLoadout(f1.loadout, { warehouse: f1.warehouse, tier: 'mythic' });
  assert.equal(v1.ok, false, '类别错配拒绝');
  const f2 = fixture();
  f2.warehouse.buckets.skillPlugin[0].tier = undefined; // qx 缺 tier
  const v2 = loadout.validateLoadout(f2.loadout, { warehouse: f2.warehouse, tier: 'mythic' });
  assert.equal(v2.ok, false, '技能插件缺 tier 拒绝');
  // 非白名单字段透传（P2-②）
  const f3 = fixture();
  f3.loadout.skills[0].params.junkField = 'keep-me';
  const p = loadout.buildPanel(f3.loadout, { warehouse: f3.warehouse, tier: 'mythic' });
  assert.equal(p.ok, true);
  assert.equal(p.panel.skills[0].params.junkField, 'keep-me', '非标准字段保留');
  // 非声明维不变（P2-⑦）：qx 只声明 mp；hp/sp 不被补偿
  const p4 = loadout.buildPanel(fixture().loadout, { warehouse: fixture().warehouse, tier: 'mythic' });
  assert.equal(p4.panel.skills[0].params.cost.hp, 0, 'hp 非声明维不变');
  assert.equal(p4.panel.skills[0].params.cost.sp, 0, 'sp 非声明维不变');
  assert.equal(p4.panel.skills[0].params.cost.mp, 16, 'mp 声明维 = 10 + 3×2');
});