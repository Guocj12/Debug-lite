'use strict';
// B18 items.js L3 仓库/装配契约测试 —— 依据 examples/01-items.md I-10/I-11；systems/01-items.md §4.9~4.11；
// tasks §3.6 T-PB-1/2/3/8（T-PB-4 档位单调经数据表机器校验）。纯函数：入参仓库永不被修改（原子性）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const items = require('../../server/core/items.js');

const WH = require('../fixtures/wh-ok.json');
const wh = () => JSON.parse(JSON.stringify(WH));

test('I-10f 装配成功：写 slot.pluginUid + equipped=true（克隆返回，入参不变）', () => {
  const src = wh();
  const frozen = Object.freeze(src.buckets); // 纯函数不得改入参（原子性实证）
  const r = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r.ok, true);
  assert.equal(r.warehouse.buckets.role[0].slots[0].pluginUid, 'p1');
  assert.equal(r.warehouse.buckets.rolePlugin[0].equipped, true);
  assert.equal(src.buckets.role[0].slots[0].pluginUid, null, '入参未被修改');
  assert.equal(src.buckets.rolePlugin[0].equipped, false, '入参插件的 equipped 未变');
  assert.ok(frozen, '冻结入参不抛（克隆后操作）');
});

test('I-10a 类别匹配：角色目标装配技能插件 → slot_type_mismatch', () => {
  const r = items.assemble(wh(), { targetUid: 'r1', slotIndex: 0, pluginUid: 'q1', tier: 'common' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'slot_type_mismatch');
});

test('I-10b 槽位类型：atk 插件 → def 槽 → slot_type_mismatch；越界槽 → slot_type_mismatch', () => {
  const r1 = items.assemble(wh(), { targetUid: 'r1', slotIndex: 1, pluginUid: 'p1', tier: 'common' });
  assert.equal(r1.code, 'slot_type_mismatch');
  const r2 = items.assemble(wh(), { targetUid: 'r1', slotIndex: 5, pluginUid: 'p1', tier: 'common' });
  assert.equal(r2.code, 'slot_type_mismatch', '槽位越界防御');
  const r3 = items.assemble(wh(), { targetUid: 'r1', slotIndex: -1, pluginUid: 'p1', tier: 'common' });
  assert.equal(r3.code, 'slot_type_mismatch');
});

// 测试基具：atk 槽插件（槽类型匹配优先于占用检查——占用用例必须同槽型）
const mkAtk = (uid, pointCost) => ({
  uid, kind: 'rolePlugin', id: 'atk_up2', slot: 'atk', quality: 'common', tier: 1,
  pointCost, affixes: [], equipped: false,
});

test('I-10c 段位门控：legendary 插件 + rare 玩家 → tier_locked（目标也受控）', () => {
  const src = wh();
  src.buckets.rolePlugin.push({ uid: 'p3', kind: 'rolePlugin', id: 'hp_up', slot: 'atk', quality: 'legendary', tier: 5, pointCost: 5, affixes: [], unlockTier: 'legendary', equipped: false });
  src.buckets.role[0].pluginPoints = 6; // 让点数不干扰门控判定
  const r = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p3', tier: 'rare' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'tier_locked');
  const ok = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p3', tier: 'mythic' });
  assert.equal(ok.ok, true, '同段位及以上放行');
});

test('T-PB-2/I-10d 点数预算：已装 1+2 再装 2（>4）→ points_exceeded 且状态不变', () => {
  const src = wh();
  src.buckets.role[0].slots.push({ type: 'sp', pluginUid: null });
  src.buckets.rolePlugin.push(mkAtk('p5', 2)); // p5 点数 2
  const w3 = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  const w4 = items.assemble(w3, { targetUid: 'r1', slotIndex: 1, pluginUid: 'p2', tier: 'common' }).warehouse;
  const r2 = items.assemble(w4, { targetUid: 'r1', slotIndex: 2, pluginUid: 'p4', tier: 'common' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'points_exceeded');
  assert.equal(r2.warehouse, undefined, '失败不回带仓库（状态完全不变，T-PB-1）');
});

test('I-10e 空槽占用：再装同一槽 → slot_occupied', () => {
  const src = wh();
  src.buckets.rolePlugin.push(mkAtk('p5', 1));
  const w1 = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  const r = items.assemble(w1, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p5', tier: 'common' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'slot_occupied');
});

test('T-PB-8 唯一性：已装插件再装别处 → plugin_equipped', () => {
  const w1 = items.assemble(wh(), { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  w1.buckets.role.push({ uid: 'r2', kind: 'role', templateId: 'role_bal', quality: 'common', slotCount: 1, slots: [{ type: 'atk', pluginUid: null }], pluginPoints: 3, equipped: false });
  const r = items.assemble(w1, { targetUid: 'r2', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'plugin_equipped');
});

test('I-11a/b 拆卸：成功清槽+回未装配；空槽 → slot_empty；目标缺失 → plugin_missing', () => {
  const w1 = items.assemble(wh(), { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  const r = items.disassemble(w1, { targetUid: 'r1', slotIndex: 0 });
  assert.equal(r.ok, true);
  assert.equal(r.warehouse.buckets.role[0].slots[0].pluginUid, null);
  assert.equal(r.warehouse.buckets.rolePlugin[0].equipped, false, '插件回到未装配');
  const r2 = items.disassemble(wh(), { targetUid: 'r1', slotIndex: 0 });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'slot_empty');
  const r3 = items.disassemble(wh(), { targetUid: 'ghost', slotIndex: 0 });
  assert.equal(r3.ok, false);
  assert.equal(r3.code, 'plugin_missing', '目标缺失归入 404 plugin_missing（B18 登记）');
});

test('T-PB-3/I-11c 装配→拆卸往返深度相等（T-PB-9 悬挂引用防御：幽灵 pluginUid → plugin_missing）', () => {
  const src = wh();
  const w1 = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  const w2 = items.disassemble(w1, { targetUid: 'r1', slotIndex: 0 }).warehouse;
  assert.deepEqual(w2, src, '往返后插槽/equipped/归属深度相等');
  const ghost = wh();
  ghost.buckets.role[0].slots[1].pluginUid = 'ghost';
  const rg = items.disassemble(ghost, { targetUid: 'r1', slotIndex: 1 });
  assert.equal(rg.ok, false);
  assert.equal(rg.code, 'plugin_missing');
});

test('防御：环仓库不可序列化 → 兜底空仓库（item_missing，不抛）；装配引用缺失物品 → item_missing', () => {
  const cyc = wh();
  cyc.buckets.self = cyc; // 环 → JSON 克隆失败 → 兜底空仓库
  const r = items.assemble(cyc, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'item_missing', '环仓库兜底空仓库 → 目标缺失');
  const d = items.disassemble(cyc, { targetUid: 'r1', slotIndex: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'plugin_missing');
  // 正常仓库下引用缺失物品
  const src = wh();
  const r2 = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'ghost', tier: 'common' });
  assert.equal(r2.code, 'item_missing');
  const r3 = items.assemble(src, { targetUid: 'ghost', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r3.code, 'item_missing');
});

test('B18 补充分支：技能目标装配/类别错配/目标门控/点数缺失兜底/拆卸槽越界/技能插件唯一性', () => {
  const src = wh();
  const srcS = wh();
  srcS.buckets.skill[0].slots.push({ type: 'basic', pluginUid: null });
  const wA = items.assemble(srcS, { targetUid: 's1', slotIndex: 0, pluginUid: 'q1', tier: 'common' });
  assert.equal(wA.ok, true, '技能装配成功');
  assert.equal(wA.warehouse.buckets.skill[0].slots[0].pluginUid, 'q1');
  const wA2 = items.assemble(wA.warehouse, { targetUid: 's1', slotIndex: 2, pluginUid: 'q1', tier: 'common' });
  assert.equal(wA2.code, 'plugin_equipped', '技能插件唯一性');
  // 技能目标装角色插件 → slot_type_mismatch
  const wB = items.assemble(src, { targetUid: 's1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(wB.code, 'slot_type_mismatch');
  // 目标自身门控：目标 unlockTier > tier → tier_locked
  const src2 = wh();
  src2.buckets.role[0].unlockTier = 'legendary';
  const wC = items.assemble(src2, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'rare' });
  assert.equal(wC.code, 'tier_locked', '目标物品也受段位门控');
  // 点数兜底：已装插件缺 pointCost 字段 → 计 0 不崩
  const wD = items.assemble(wh(), { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  delete wD.buckets.rolePlugin[0].pointCost;
  const wE = items.assemble(wD, { targetUid: 'r1', slotIndex: 1, pluginUid: 'p2', tier: 'common' });
  assert.equal(wE.ok, true, '缺 pointCost 计 0（不崩）');
  // 拆卸槽越界 → slot_empty
  const wF = items.disassemble(wh(), { targetUid: 'r1', slotIndex: 9 });
  assert.equal(wF.code, 'slot_empty');
});

test('T-PB-4 档位单调（数据表机器校验）：品质序号↑ → 区间整体上移（min 不减、max 严格增）+ 点数/消耗严格增', () => {
  const qualities = require('../../server/data/qualities.json').qualities;
  const ids = qualities.map((q) => q.id);
  assert.deepEqual(ids, ['common', 'rare', 'epic', 'legendary', 'mythic'], '品质序（段位序号即品质上限 D-122）');
  for (let i = 1; i < qualities.length; i++) {
    const lo = qualities[i - 1];
    const hi = qualities[i];
    // 数值区间允许重叠（common [0.80,1.05] vs rare [1.00,1.25]）——不变量是整体上移
    assert.ok(hi.statRange[0] >= lo.statRange[0], `${hi.id} 下限不减`);
    assert.ok(hi.statRange[1] > lo.statRange[1], `${hi.id} 上限严格增（数值↑）`);
    assert.ok(hi.pluginPoints > lo.pluginPoints, '插件点数↑');
    assert.ok(hi.roleSlotRange[0] >= lo.roleSlotRange[0] && hi.skillSlotRange[0] >= lo.skillSlotRange[0], '插槽数下限不减');
    assert.ok(hi.roleSlotRange[1] > lo.roleSlotRange[1] && hi.skillSlotRange[1] >= lo.skillSlotRange[1], '插槽数上限增');
  }
  const cdb = require('../../server/data/qualities.json').costDeltaBase;
  const cdbIds = ['common', 'rare', 'epic', 'legendary', 'mythic'];
  for (let i = 1; i < cdbIds.length; i++) {
    assert.ok(cdb[cdbIds[i]] > cdb[cdbIds[i - 1]], '消耗补偿基数↑（消耗↑）');
  }
});

// P1-1/P1-2 回归（审查 docs/reviews/B18.md）：插件当目标、桶值非数组 → 业务码而非 TypeError 500
test('P1-1 回归：插件当目标不抛（槽位语义），P1-2：桶值非数组不抛', () => {
  const src = wh();
  const r = items.assemble(src, { targetUid: 'p1', slotIndex: 0, pluginUid: 'p2', tier: 'common' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'slot_type_mismatch', '插件当目标 → slot_type_mismatch（第三态，非 500）');
  const d = items.disassemble(src, { targetUid: 'p1', slotIndex: 0 });
  assert.equal(d.ok, false);
  assert.equal(d.code, 'slot_empty', '插件当目标拆卸 → slot_empty（非 500）');
  const bad = wh();
  bad.buckets.role = 'abc'; // 桶值非数组
  const r2 = items.assemble(bad, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'item_missing', '桶值非数组 → 桶跳过（不抛）');
  const d2 = items.disassemble(bad, { targetUid: 'r1', slotIndex: 0 });
  assert.equal(d2.code, 'plugin_missing');
});

// P2-2 日志管线：成功 items.assemble/disassemble(info)；拒绝 items.reject(warn)（§4.6 冻结）
test('P2-2 日志管线：assemble/disassemble(info) + reject(warn)', () => {
  const { createLogger } = require('../../shared/log.js');
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const it = items.withLogger(logger);
  const src = wh();
  const ok = it.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(ok.ok, true);
  assert.ok(logger.records.some((x) => x.event === 'items.assemble' && x.level === 'info'), 'items.assemble(info)');
  it.disassemble(ok.warehouse, { targetUid: 'r1', slotIndex: 0 });
  assert.ok(logger.records.some((x) => x.event === 'items.disassemble' && x.level === 'info'), 'items.disassemble(info)');
  it.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'q1', tier: 'common' });
  const rej = logger.records.filter((x) => x.event === 'items.reject');
  assert.equal(rej[0].level, 'warn', 'items.reject(warn)');
  assert.equal(rej[0].data.code, 'slot_type_mismatch', 'reject 带 code');
});