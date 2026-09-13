'use strict';
/* B18 对抗性红队独立探针（core 级）—— 非测试代码路径，可复跑：node .review-b18/probe-core.js
 * 1) deepFreeze 原子性实证（成功/失败路径）
 * 2) 克隆独立性（返回仓库与入参零引用共享）
 * 3) 插件作目标（kind=rolePlugin/skillPlugin）→ 观察崩溃/语义
 * 4) 缺省 tier=mythic 宽松；空串 tier
 * 5) 拆卸两次（slot_empty）；先卸再装（应合法）
 * 6) equipped=true 孤儿插件（不在任何槽）→ 卡死态观察
 * 7) wh 缺省/空对象/无 buckets 结构免疫
 * 8) 悬挂引用计 0 与 points 0 兜底
 */
const assert = require('node:assert/strict');
const items = require('../server/core/items.js');
const WH = require('../tests/fixtures/wh-ok.json');
const wh = () => JSON.parse(JSON.stringify(WH));

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}: ${e.message}`); }
}

function deepFreeze(o, seen) {
  seen = seen || new Set();
  if (!o || typeof o !== 'object' || seen.has(o)) return o;
  seen.add(o);
  Object.freeze(o);
  for (const k of Object.keys(o)) deepFreeze(o[k], seen);
  return o;
}

console.log('-- 1) deepFreeze 原子性（成功与失败路径入参纹丝不动）');
check('成功路径：全深冻结入参不抛且结果正确', () => {
  const src = deepFreeze(wh());
  const r = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r.ok, true);
  assert.equal(src.buckets.role[0].slots[0].pluginUid, null);
  assert.equal(src.buckets.rolePlugin[0].equipped, false);
});
check('失败路径（points_exceeded）：深冻结入参不抛', () => {
  const src = wh();
  src.buckets.role[0].pluginPoints = 0; // 冻结前改（0 点预算，p1 需 1 → 必超限）
  deepFreeze(src);
  const r = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r.code, 'points_exceeded');
});
check('失败路径（tier_locked）：深冻结入参不抛', () => {
  const src = wh();
  src.buckets.role[0].unlockTier = 'legendary';
  deepFreeze(src);
  const r = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'rare' });
  assert.equal(r.code, 'tier_locked');
});

console.log('-- 2) 克隆独立性（返回仓库与入参零引用共享）');
check('返回仓库与入参无共享引用', () => {
  const src = wh();
  const a = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  const d = items.disassemble(a, { targetUid: 'r1', slotIndex: 0 }).warehouse;
  // 修改返回结果不得影响 src / 修改 src 不得影响结果
  a.buckets.role[0].slots[0].pluginUid = 'hacked';
  assert.equal(src.buckets.role[0].slots[0].pluginUid, null);
  src.buckets.role[0].slots[0].pluginUid = 'hacked2';
  assert.equal(d.buckets.role[0].slots[0].pluginUid, null);
});

console.log('-- 3) 插件作目标（kind=rolePlugin 等非 role/skill 目标）');
check('插件作目标 + 整数槽 → 观察行为', () => {
  const src = wh();
  const r = items.assemble(src, { targetUid: 'p1', slotIndex: 0, pluginUid: 'p2', tier: 'common' });
  console.log(`      [观察] r = ${JSON.stringify(r)}`);
});

console.log('-- 4) 缺省 tier');
check('tier 缺省 → 宽松（unlockTier=legendary 的插件可装）', () => {
  const src = wh();
  src.buckets.rolePlugin.push({ uid: 'p9', kind: 'rolePlugin', id: 'hp_up', slot: 'atk', quality: 'legendary', tier: 5, pointCost: 1, affixes: [], unlockTier: 'legendary', equipped: false });
  const r = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p9' });
  assert.equal(r.ok, true, '缺省 mythic 应放行');
});
check('tier 空串 → 兜底 mythic', () => {
  const r = items.assemble(wh(), { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: '' });
  assert.equal(r.ok, true);
});

console.log('-- 5) 拆卸两次 / 先卸再装（应合法）');
check('成功拆卸后再拆卸 → slot_empty', () => {
  const w1 = items.assemble(wh(), { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  const w2 = items.disassemble(w1, { targetUid: 'r1', slotIndex: 0 }).warehouse;
  const r = items.disassemble(w2, { targetUid: 'r1', slotIndex: 0 });
  assert.equal(r.code, 'slot_empty');
});
check('先卸再装同一插件（换目标）→ 合法', () => {
  const src = wh();
  const w1 = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  const w2 = items.disassemble(w1, { targetUid: 'r1', slotIndex: 0 }).warehouse;
  w2.buckets.role.push({ uid: 'r9', kind: 'role', templateId: 'role_bal', quality: 'common', slotCount: 1, slots: [{ type: 'atk', pluginUid: null }], pluginPoints: 3, unlockTier: 'common', equipped: false });
  const r = items.assemble(w2, { targetUid: 'r9', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r.ok, true, '卸后应可再装');
});

console.log('-- 6) equipped=true 孤儿插件（不在任何槽）');
check('孤儿 equipped=true 再装 → plugin_equipped（永久卡死观察）', () => {
  const src = wh();
  src.buckets.rolePlugin[0].equipped = true; // p1 标为已装配但无槽引用
  const r = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  console.log(`      [观察] r = ${JSON.stringify(r)}`);
});

console.log('-- 7) 结构免疫');
check('assemble(undefined) → item_missing 不抛', () => {
  const r = items.assemble(undefined, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r.code, 'item_missing');
});
check('wh 无 buckets 键 → item_missing 不抛', () => {
  const r = items.assemble({}, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1' });
  assert.equal(r.code, 'item_missing');
});
check('buckets 为字符串 → 不抛', () => {
  const r = items.assemble({ buckets: 'abc' }, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1' });
  assert.equal(r.ok, false);
});
check('disassemble 无参 → 不抛（plugin_missing）', () => {
  const r = items.disassemble(undefined, {});
  assert.equal(r.code, 'plugin_missing');
});
check('slotIndex 非整（1.5/空串/true）→ slot_type_mismatch', () => {
  for (const si of [1.5, '', true, null, NaN, '2']) {
    const r = items.assemble(wh(), { targetUid: 'r1', slotIndex: si, pluginUid: 'p1', tier: 'common' });
    assert.equal(r.code, 'slot_type_mismatch', `slotIndex=${String(si)}`);
  }
});

console.log('-- 8) 点数兜底');
check('已装插件缺 pointCost → 计 0；插件 pointCost=0 → 0', () => {
  const w1 = items.assemble(wh(), { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' }).warehouse;
  delete w1.buckets.rolePlugin[0].pointCost;
  const r2 = items.assemble(w1, { targetUid: 'r1', slotIndex: 1, pluginUid: 'p2', tier: 'common' });
  assert.equal(r2.ok, true);
});
check("悬挂空串引用（slot.pluginUid=''）→ 计入 0 且 slot_occupied", () => {
  const src = wh();
  src.buckets.role[0].slots[0].pluginUid = '';
  const r = items.assemble(src, { targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
  assert.equal(r.code, 'slot_occupied');
});

console.log(`\n结果: ${failed === 0 ? '全部通过' : failed + ' 项失败'}`);
process.exitCode = failed === 0 ? 0 : 1;