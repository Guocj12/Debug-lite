'use strict';
// B21 属性测试全套（T-PB-10 序列化往返包裹 T-PB-1..10 全量）+ 数值校准回归
// —— 依据 tasks §3.6（T-PB-1..10）；D-127/D-128（dodge 定稿 0.20 / defK 入表 40 / 附加效果数值定稿 / melee 冻结）。
// 全部数值机器推导：消耗补偿 = costDeltaBase[quality]×tier；减伤 = 1 − def/(def+defK)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const items = require('../../server/core/items.js');
const skills = require('../../server/core/skills.js');
const loadout = require('../../server/loadout.js');
const engine = require('../../server/core/engine.js');
const CFG = require('../../server/data/battle-config.json');
const LD = require('../fixtures/loadout-ok.json');

// RT = JSON 往返后的组合状态（T-PB-10 外层；新增 uid 避开 wh-ok 既有 p4/q1）
function rtWH() {
  const wh = JSON.parse(JSON.stringify(require('../fixtures/wh-ok.json')));
  wh.buckets.rolePlugin.push(
    { uid: 'pa', kind: 'rolePlugin', id: 'atk_up', slot: 'atk', quality: 'rare', tier: 2, pointCost: 2, affixes: [], equipped: false },
    { uid: 'pb', kind: 'rolePlugin', id: 'hp_up', slot: 'hp', quality: 'rare', tier: 2, pointCost: 2, affixes: [], equipped: false },
    { uid: 'qx1', kind: 'skillPlugin', id: 'sp_cost_down', slot: 'basic', quality: 'common', tier: 1, affixes: [{ id: 'cost_down', desc: '−20%', params: { v: 0.2 } }], costDeltaByTier: null, equipped: false },
  );
  wh.buckets.role[0].slots.push({ type: 'sp', pluginUid: null }); // 点数/门控测试用第 3 槽
  return JSON.parse(JSON.stringify(wh)); // T-PB-10 外层往返
}

test('T-PB-10 序列化往返 + T-PB-1 槽位匹配：往返后 mismatch 拒绝且状态不变', () => {
  const wh = rtWH();
  // 角色目标装技能插件 → 拒绝
  const r = items.assemble(wh, { targetUid: 'r1', slotIndex: 0, pluginUid: 'q1', tier: 'mythic' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'slot_type_mismatch');
  assert.equal(wh.buckets.role[0].slots[0].pluginUid, null, '状态完全不变（T-PB-1）');
});

test('T-PB-10 + T-PB-2 点数预算：往返后超限拒绝（1+2+2 > 4）', () => {
  const wh = rtWH();
  let w = items.assemble(wh, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'mythic' }).warehouse;
  w = items.assemble(w, { targetUid: 'r1', slotIndex: 1, pluginUid: 'p2', tier: 'mythic' }).warehouse;
  const r = items.assemble(w, { targetUid: 'r1', slotIndex: 2, pluginUid: 'p4', tier: 'mythic' });
  assert.equal(r.code, 'points_exceeded', '已用 1+2，再装 2 > 4（T-PB-2）');
});

test('T-PB-10 + T-PB-3 往返深度相等：往返后装配→拆卸 round-trip 深等', () => {
  const wh = rtWH();
  const w1 = items.assemble(wh, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'mythic' }).warehouse;
  const w2 = items.disassemble(w1, { targetUid: 'r1', slotIndex: 0 }).warehouse;
  assert.deepEqual(w2, wh, '往返后插槽/equipped/归属深度相等（T-PB-3）');
});

test('T-PB-10 + T-PB-4 档位单调：往返物品的品质/档位与数据表单调一致', () => {
  const wh = rtWH();
  const qualities = require('../../server/data/qualities.json').qualities;
  for (let i = 1; i < qualities.length; i++) {
    assert.ok(qualities[i].statRange[0] >= qualities[i - 1].statRange[0], '档位单调（min 不减）');
    assert.ok(qualities[i].pluginPoints > qualities[i - 1].pluginPoints, '点数严格增');
  }
  const plugins = wh.buckets.rolePlugin.concat(wh.buckets.skillPlugin);
  for (const p of plugins) assert.ok(Number.isInteger(p.tier) && p.tier >= 1, `${p.uid} tier 有效`);
});

test('T-PB-10 + T-PB-5/6 消耗补偿与聚合：往返后消耗补偿与非声明维不变 + 面板 1.38/16 一致', () => {
  const wh = JSON.parse(JSON.stringify(LD.warehouse)); // T-PB-10 往返态
  const ld = JSON.parse(JSON.stringify(LD.loadout)); // T-PB-10 外层的 loadout 侧
  const p = loadout.buildPanel(ld, { warehouse: wh, tier: 'mythic' });
  assert.equal(p.ok, true, JSON.stringify(p.errors));
  assert.equal(p.panel.skills[0].params.cost.mp, 16, '10 + costDeltaBase.rare(3)×tier2 = 16');
  assert.equal(p.panel.skills[0].params.cost.hp, 0, 'hp 非声明维不变');
  assert.equal(p.panel.skills[0].params.multiplier, 1.38, '1.2×1.15 = 1.38');
  // 减耗类：cost_down ceil（S-3；本地构造带词条插件——fixture q1 单词条为空）
  const base = { type: 'straight', cost: { hp: 0, mp: 10, sp: 0 }, multiplier: 1.2, cooldown: 3, bulletLevel: 3, range: 10, bulletCount: 3, affixes: [] };
  const costDown = { uid: 'q2', kind: 'skillPlugin', id: 'sp_cost_down', slot: 'basic', quality: 'common', tier: 1, affixes: [{ id: 'cost_down', desc: '−20%', params: { v: 0.2 } }], costDeltaByTier: null, equipped: false };
  const down = skills.applySkillPlugins({ ...base }, [costDown]);
  assert.equal(down.cost.mp, 8, '10×0.8 ceil = 8');
});

test('T-PB-10 + T-PB-7 门控：往返后 gated 插件装配拒绝（门控开启 = 回退模式）；数据含 unlockTier（U-5d 真分支）', () => {
  const mkWh = () => {
    const w = rtWH();
    w.buckets.rolePlugin.push({ uid: 'g1', kind: 'rolePlugin', id: 'rp_sp_opt', slot: 'sp', quality: 'legendary', tier: 3, pointCost: 3, affixes: [], unlockTier: 'legendary', equipped: false });
    return w;
  };
  // 门控开启：rare 段位装配 legendary 插件 → tier_locked；mythic 放行
  const wh = mkWh();
  const r = items.withGating(true).assemble(wh, { targetUid: 'r1', slotIndex: 2, pluginUid: 'g1', tier: 'rare' });
  assert.equal(r.code, 'tier_locked');
  const ok = items.withGating(true).assemble(wh, { targetUid: 'r1', slotIndex: 2, pluginUid: 'g1', tier: 'mythic' });
  assert.equal(ok.ok, true);
  // 门控关闭（默认，用户决策 2026-09-16）：同一请求放行
  const whOff = mkWh();
  const off = items.assemble(whOff, { targetUid: 'r1', slotIndex: 2, pluginUid: 'g1', tier: 'rare' });
  assert.equal(off.ok, true, '段位不参与判定');
});

test('T-PB-10 + T-PB-8/9 唯一性与引用完整性：往返后双引用/悬挂引用拒绝', () => {
  const wh = JSON.parse(JSON.stringify(LD.warehouse)); // T-PB-10 往返态
  const ld = JSON.parse(JSON.stringify(LD.loadout));
  const f2 = JSON.parse(JSON.stringify(ld));
  f2.skills[0].slots = [{ type: 'basic', pluginUid: 'pa' }, { type: 'basic', pluginUid: 'pa' }];
  const v2 = loadout.validateLoadout(f2, { warehouse: wh, tier: 'mythic' });
  assert.equal(v2.ok, false, '双引用拒绝（T-PB-8）');
  const f3 = JSON.parse(JSON.stringify(ld));
  f3.role.slots[0].pluginUid = 'ghost';
  const v3 = loadout.validateLoadout(f3, { warehouse: wh, tier: 'mythic' });
  assert.equal(v3.ok, false, '悬挂引用拒绝（T-PB-9）');
});

// ---- 数值校准回归（D-127/D-128）----
test('D-127/D-128 校准冻结：dodgeChanceBonus=0.20、defK=40 入表且引擎读取', () => {
  assert.equal(CFG.dodgeChanceBonus, 0.2, 'dodge 闪避加成定稿 +20%');
  assert.equal(CFG.defK, 40, '减伤公式常数入表（1 − def/(def+40)）');
  // 引擎伤害以 cfg.defK 计算（机器复算）：atk=20, mult=1, def=8 → 20×40/48 = 16.67 → 16
  const mk = (P) => ({ id: P, owner: P, hp: 100, maxHp: 100, atk: 20, def: 8, x: 224, facing: 1, cooldowns: {}, effects: [], special: {} });
  const b = engine.createBattle(undefined, { seed: 9, players: { p1: mk('p1'), p2: mk('p2') } });
  const res = b.dealDamage(b.state.players.p1, b.state.players.p2, { mult: 1 });
  assert.equal(res.dmg, Math.floor(20 * (1 - 8 / (8 + CFG.defK))), `引擎按 cfg.defK 计算（期望 ${Math.floor(20 * (1 - 8 / (8 + CFG.defK)))}）`);
  // P2-7 dodge 封顶 1：面板 1.0 + dodging 0.2 → min(1, 1.2) = 1（D-127 封顶语义显式断言）
  const dd = b.state.players.p2;
  dd.special = { dodgeChance: 1 };
  dd.dodging = true;
  const dodged = b.dealDamage(b.state.players.p1, dd, { mult: 1, critRng: { chance: () => true } });
  assert.equal(dodged.dodgeChanceTotal, 1, 'dodgeChance 叠加封顶 1（D-127）');
  assert.equal(dodged.dodged, true);
});

test('D-128 附加效果数值冻结：插件数据含 stun/knockback/pull/dot/true_dmg；melee 射程不可增强', () => {
  const PLUGINS = require('../../server/data/plugins.json').plugins;
  for (const id of ['sp_stun', 'sp_knockback', 'sp_pull', 'sp_dot', 'sp_true_dmg']) {
    assert.ok(PLUGINS.some((x) => x.id === id), `插件 ${id} 存在（附加效果数值由词条档位给出）`);
  }
  // melee 射程不可增强（B6 登记冻结）
  const melee = { type: 'melee', cost: { hp: 0, mp: 10, sp: 0 }, multiplier: 1.2, cooldown: 3, bulletLevel: 3, affixes: [] };
  const rangeUp = { uid: 'r1', kind: 'skillPlugin', id: 'sp_range', slot: 'basic', quality: 'rare', tier: 1, affixes: [{ id: 'range_plus', params: { v: 2 } }], costDeltaByTier: { mp: [2, 4, 6] } };
  const applied = skills.applySkillPlugins(melee, [rangeUp]);
  assert.equal(applied.range, undefined, 'melee 无射程可增强（冻结）');
  assert.equal(applied.cost.mp, 13, 'melee 消耗补偿仍生效：10 + 3×1 = 13');
});