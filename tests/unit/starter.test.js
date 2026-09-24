'use strict';
/* tests/unit/starter.test.js —— D-159 新手套装（starter）契约（docs/frontend/03-hub-warehouse-loadout.md 附录 D）
 *
 * 断言意图（不是"跑一遍不报错"）：
 *   ST-1 确定性：同一身份两次生成**内容级**逐值相同（uid 由进程内计数器分配，不参与内容级比较，B17 口径）
 *   ST-2 不同身份不同种子 → 不同套装
 *   ST-3 插槽下限：角色 slotCount ≥ 1（common 的 roleSlotRange=[1,3]）
 *   ST-4 技能：恰 3 个；至少 1 个技能有插槽（重掷规则生效）
 *   ST-5 装配必成：每个装入的插件 slot === 目标槽 type，且能在仓库内经 assemble 复验不 409
 *   ST-6 点数预算：角色插件 pointCost 之和 ≤ 角色 pluginPoints
 *   ST-7 AI：取自预设（type=program）且库条目 aiId 与 loadout.aiId 一致
 *   ST-8 桶归属：物品按 kind 入对应桶；总数远低于每桶上限
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const starter = require('../../server/starter.js');
const items = require('../../server/core/items.js');

const stripUid = (value) => {
  if (Array.isArray(value)) return value.map(stripUid);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (k === 'uid' || k === 'pluginUid' || k === 'equipped') continue;
      out[k] = stripUid(value[k]);
    }
    return out;
  }
  return value;
};

const identity = (i) => ({
  publicId: `u_${String(i).padStart(8, '0')}`,
  playerId: `pl_${String(i).padStart(16, '0')}`,
});

test('ST-1 同身份两次生成内容级逐值相同（uid 除外）', () => {
  const id = identity(11);
  const a = starter.buildStarter(id);
  const b = starter.buildStarter(id);
  assert.equal(a.ok, true);
  assert.equal(a.seed, b.seed, '种子由身份派生 → 必须相同');
  assert.deepEqual(stripUid(a.warehouse), stripUid(b.warehouse), '仓库内容（去 uid）逐值相同');
  assert.deepEqual(stripUid(a.loadout), stripUid(b.loadout), '出战配置内容（去 uid）逐值相同');
  assert.deepEqual(a.aiLibrary.map((x) => x.aiId), b.aiLibrary.map((x) => x.aiId));
});

test('ST-2 不同身份 → 不同种子与不同套装', () => {
  const a = starter.buildStarter(identity(21));
  const b = starter.buildStarter(identity(22));
  assert.notEqual(a.seed, b.seed, '种子必须随身份变化');
  assert.notDeepEqual(stripUid(a.warehouse), stripUid(b.warehouse));
});

test('ST-3/ST-4/ST-6 插槽下限、技能恰 3 且至少 1 槽、角色插件点数不超预算', () => {
  for (let i = 0; i < 12; i += 1) {
    const r = starter.buildStarter(identity(30 + i));
    const role = r.warehouse.buckets.role[0];
    assert.ok((role.slots || []).length >= 1, `角色必须至少 1 个插槽（实际 ${(role.slots || []).length}）`);
    assert.equal(r.loadout.skills.length, 3, '出战配置必须恰 3 个技能');
    assert.ok(r.stats.skillSlotTotal >= 1, `至少 1 个技能有插槽（实际 ${r.stats.skillSlotTotal}）`);
    const used = r.warehouse.buckets.rolePlugin.reduce((sum, p) => sum + (p.pointCost || 0), 0);
    assert.ok(used <= (role.pluginPoints || 0), `角色插件点数 ${used} 不得超过 ${role.pluginPoints}`);
  }
});

test('ST-5 装配必成：装入的插件类型与目标槽一致，且仓库内复验 assemble 不再是 slot_type_mismatch', () => {
  for (let i = 0; i < 12; i += 1) {
    const r = starter.buildStarter(identity(50 + i));
    for (const p of r.stats.plugins) {
      const bucket = p.kind === 'rolePlugin' ? 'role' : 'skill';
      const target = r.warehouse.buckets[bucket].find((x) => x.uid === p.targetUid);
      assert.ok(target, `目标物品 ${p.targetUid} 在仓库中`);
      const slot = target.slots[p.slotIndex];
      assert.equal(slot.pluginUid, p.uid, '槽位引用指向该插件');
      const plugin = r.warehouse.buckets[p.kind].find((x) => x.uid === p.uid);
      assert.equal(plugin.slot, slot.type, `插件类型 ${plugin.slot} 必须等于插槽类型 ${slot.type}`);
    }
  }
});

test('ST-7 AI 取自预设并同时登记进库（aiId 对齐）', () => {
  const r = starter.buildStarter(identity(77));
  assert.equal(r.loadout.ai.type, 'program');
  assert.equal(r.aiLibrary.length, 1);
  assert.equal(r.aiLibrary[0].aiId, r.loadout.aiId);
  assert.equal(r.aiLibrary[0].program, r.loadout.ai, '库条目与出战配置共用同一程序对象内容');
  assert.equal(r.aiLibrary[0].name, starter.STARTER_AI_NAME);
});

test('ST-8 桶归属正确、总量有界（远低于每桶上限）', () => {
  const r = starter.buildStarter(identity(88));
  const c = r.stats.counts;
  assert.equal(c.role, 1);
  assert.equal(c.skill, 3);
  assert.ok(c.rolePlugin >= 1 && c.rolePlugin <= starter.ROLE_PLUGIN_MAX);
  assert.ok(c.skillPlugin >= 1 && c.skillPlugin <= starter.SKILL_PLUGIN_MAX);
  assert.ok(c.role <= 500 && c.skill <= 500);
  for (const key of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
    for (const it of r.warehouse.buckets[key]) {
      assert.ok(it.uid && typeof it.uid === 'string');
      assert.equal(it.kind, key, `桶 ${key} 中的物品 kind 必须一致`);
    }
  }
});

test('ST-9 生成的物品可被 core/items 重新装配路径接受（仓库自洽）', () => {
  const r = starter.buildStarter(identity(99));
  const wh = r.warehouse;
  // 拆卸 starter 已装的第一个插件 → 必须成功（证明 equipped/引用状态一致）
  const p = r.stats.plugins[0];
  const dis = items.disassemble(wh, { targetUid: p.targetUid, slotIndex: p.slotIndex });
  assert.equal(dis.ok, true, `拆卸应成功：${JSON.stringify(dis)}`);
  // 再装回去 → 必须成功（类型/点数/空槽/唯一性四道校验全过）
  const re = items.assemble(dis.warehouse, {
    targetUid: p.targetUid, pluginUid: p.uid, slotIndex: p.slotIndex, tier: 'common',
  });
  assert.equal(re.ok, true, `重新装配应成功：${JSON.stringify(re)}`);
});
