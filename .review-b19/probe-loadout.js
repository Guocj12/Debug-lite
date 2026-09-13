'use strict';
/* .review-b19/probe-loadout.js —— B19 对抗探针（独立第三方程式，不复用测试代码）
 * 攻击点：① skills 畸形 + warehouse → TypeError?（B18 P1 同型崩溃）
 *         ② 同一 pluginUid 双引用（role 双槽同 uid + equipped=true）→ T-PB-8 全局唯一性
 *         ③ 跨类引用（rolePlugin 出现在技能槽）→ 类别匹配
 *         ④ 无 warehouse 面板（词条不聚合 → base stats）语义
 *         ⑤ ai 错误截断 slice(0,5)
 *         ⑥ tier 空串/非法值；缺省一致性
 *         ⑦ 校验/面板不改入参（含 ai version 1 迁移路径）
 *         ⑧ 畸形输入矩阵（role.slots 非数组 / buckets 非对象 / 桶值标量）
 */
const assert = require('node:assert/strict');
const loadout = require('../server/loadout.js');
const FIXTURE = require('../tests/fixtures/loadout-ok.json');

const fx = () => JSON.parse(JSON.stringify(FIXTURE));
let pass = 0, fail = 0;

function check(name, fn) {
  try { fn(); console.log(`[PASS] ${name}`); pass++; }
  catch (e) { console.log(`[FAIL] ${name} :: ${e.message}`); fail++; }
}

function base(kind) {
  return { uid: 'r1', kind, templateId: kind === 'role' ? 'role_bal' : 'skill_straight_precise',
    quality: 'epic', slotCount: 2,
    slots: [{ type: kind === 'role' ? 'atk' : 'basic', pluginUid: null }, { type: kind === 'role' ? 'hp' : 'basic', pluginUid: null }],
    stats: { hp: 100, atk: 20, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 }, pluginPoints: 4, unlockTier: 'common',
    params: { multiplier: 1.2 } };
}
function mkWarehouse() {
  return { buckets: {
    role: [base('role')],
    skill: [base('skill')],
    rolePlugin: [
      { uid: 'pa', kind: 'rolePlugin', id: 'atk_up', slot: 'atk', quality: 'rare', tier: 2, pointCost: 2,
        affixes: [{ id: 'atk_pct', params: { v: 0.10 } }], equipped: true },
    ],
    skillPlugin: [],
  } };
}

// —— ① skills 畸形 + warehouse → 是否抛 TypeError（B18 P1-1 同型）——
check('① skills 非数组 + warehouse：validateLoadout 不抛（优雅拒绝）', () => {
  let threw = null;
  try { loadout.validateLoadout({ role: base('role'), skills: 'zzz', ai: {} }, { warehouse: mkWarehouse(), tier: 'mythic' }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛 TypeError: ${threw.message}`);
});
check('①b skills 缺失 + warehouse：不抛', () => {
  let threw = null;
  try { loadout.validateLoadout({ role: base('role'), ai: {} }, { warehouse: mkWarehouse(), tier: 'mythic' }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛: ${threw.message}`);
});

// —— ② T-PB-8 双引用：同一插件 uid 双处 + equipped=true ——
check('② 同一插件双引用（role.slots[0]/[1] 同 pa）→ 应拒绝（T-PB-8）？现行为记录', () => {
  const f = fx();
  f.loadout.role.slots[1].pluginUid = 'pa'; // 双引用同插件
  f.warehouse.buckets.role[0].slots[1].pluginUid = 'pa';
  let v;
  let threw = null;
  try { v = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛: ${threw.message}`);
  console.log(`  → ok=${v.ok} errors=${JSON.stringify(v.errors)}（若 ok=true 即接受双引用）`);
  if (v.ok) {
    const p = loadout.buildPanel(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
    console.log(`  → 面板 atk=${p.panel.role.stats.atk}（pa 词条 +10% 被聚合 ${f.loadout.role.slots.filter(s=>s.pluginUid==='pa').length} 次）`);
  }
});
check('②b 跨目标双引用（role.slots[0] 与 skills[1].slots[0] 同 pa）→ 现行为记录', () => {
  const f = fx();
  f.loadout.skills[1].slots[0].pluginUid = 'pa'; // rolePlugin 进技能槽 + 双引用
  f.warehouse.buckets.skill[1].slots[0].pluginUid = 'pa';
  let v; let threw = null;
  try { v = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛: ${threw.message}`);
  console.log(`  → ok=${v.ok} errors=${JSON.stringify(v.errors)}`);
});
check('②c 类别错配（作用域外判定）：rolePlugin 引用放进 basic 技能槽、无重复 → 现行为记录', () => {
  const f = fx();
  f.loadout.skills[0].slots[0].pluginUid = 'pa';
  f.warehouse.buckets.skill[0].slots[0].pluginUid = 'pa';
  const v = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  console.log(`  → ok=${v.ok}（rolePlugin@basic 槽；I-10a 类别匹配是否应在 loadout 层复核）`);
});

// —— ④ 无 warehouse：词条不聚合 ——
check('④a 无 warehouse：带已装插件引用的 loadout 校验通过 + 面板 base stats（非最终值）', () => {
  const f = fx();
  const v = loadout.validateLoadout(f.loadout, { tier: 'mythic' });
  const p = loadout.buildPanel(f.loadout, { tier: 'mythic' });
  console.log(`  → validate ok=${v.ok}；panel atk=${p.panel.role.stats.atk} hp=${p.panel.role.stats.hp}（带 warehouse 应为 22/150）`);
  assert.equal(v.ok, true);
  if (p.panel.role.stats.atk === 22) throw new Error('探针前提误判');
});
check('④b 无 warehouse + 悬挂引用（slot.pluginUid=ghost）：校验通过？', () => {
  const f = fx();
  f.loadout.role.slots[0].pluginUid = 'ghost';
  const v = loadout.validateLoadout(f.loadout, { tier: 'mythic' });
  console.log(`  → ok=${v.ok}（无 warehouse 时 I-12d 悬空引用校验空转）`);
});

// —— ⑤ ai 错误截断 ——
check('⑤ ai 多个错误：details 条数与截断标记', () => {
  const f = fx();
  for (let i = 0; i < 8; i++) {
    f.loadout.ai.body.statements.push({ type: 'bogus_node_' + i });
  }
  const v = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  const aiErrs = v.errors.filter((e) => e.where.startsWith('ai:'));
  console.log(`  → ai 错误 ${aiErrs.length} 条（截断 5）；总 errors=${v.errors.length}；errors 语义: ${JSON.stringify(v.errors.slice(0, 2))}`);
});

// —— ⑥ tier 边界 ——
check('⑥a tier 缺省 mythic：legendary 物品通过、epic 物品通过', () => {
  const f = fx();
  const v = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse });
  console.log(`  → ok=${v.ok}（缺省 tier）`);
  assert.equal(v.ok, true);
});
check('⑥b tier 空串/非法（diamond）：现行为记录（保守拒绝？）', () => {
  const f = fx();
  const v1 = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: '' });
  const v2 = loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'diamond' });
  console.log(`  → tier='' ok=${v1.ok} errors=${JSON.stringify(v1.errors.slice(0, 2))}`);
  console.log(`  → tier='diamond' ok=${v2.ok} errors=${JSON.stringify(v2.errors.slice(0, 2))}`);
});

// —— ⑦ 不改入参（T-IT-8/T-RK-6）——
check('⑦ 校验 + 面板后入参深度不变（含 ai version 1 → validate 迁移路径）', () => {
  const f = fx();
  const before = JSON.stringify(f);
  loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  loadout.buildPanel(f.loadout, { warehouse: f.warehouse, tier: 'mythic' });
  const after = JSON.stringify(f);
  assert.equal(before, after, '入参被修改');
});

// —— ⑧ 畸形矩阵 ——
check('⑧a role.slots 非数组 + warehouse → 不抛', () => {
  const f = fx();
  f.loadout.role.slots = 'abc';
  let threw = null;
  try { loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛: ${threw.message}`);
});
check('⑧b buckets 标量（字符串）→ 不抛', () => {
  const f = fx();
  f.warehouse.buckets = 'abc';
  let threw = null;
  try { loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛: ${threw.message}`);
});
check('⑧c 桶值标量（rolePlugin: "x"）→ 不抛（findItem 防御）', () => {
  const f = fx();
  f.warehouse.buckets.rolePlugin = 'x';
  let threw = null;
  try { loadout.validateLoadout(f.loadout, { warehouse: f.warehouse, tier: 'mythic' }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛: ${threw.message}`);
});
check('⑧d loadout 数组 / 字符串 → 不抛', () => {
  let threw = null;
  try { loadout.validateLoadout([1, 2], { tier: 'mythic' }); loadout.validateLoadout('hi', { tier: 'mythic' }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛: ${threw.message}`);
});
check('⑧e role 是数组但 kind=role → 结构错误不抛', () => {
  let threw = null;
  try { loadout.validateLoadout({ role: [], skills: [ {}, {}, {} ], ai: {} }, { warehouse: mkWarehouse() }); }
  catch (e) { threw = e; }
  if (threw) throw new Error(`抛: ${threw.message}`);
});

console.log(`\n=== 探针结果: ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail ? 1 : 0);