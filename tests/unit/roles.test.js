'use strict';
// B5 core/roles.js 契约测试 —— 接口见 docs/interfaces.md §1（instantiateRole/applyTypeModifier/equipPlugins/getFinalStats）
// 依据：examples/02-roles.md R-1..R-8（数值期望唯一出处）；decisions D-45/D-46/D-110
// 归属：tasks.md §6 B5（T-RO-1..7）；日志 role.instantiate(debug)/role.panel(debug)（§4.6）
// 语义（B5 登记）：equipPlugins 只做"校验+登记"（不改 stats）；getFinalStats 每次从原始五维+已装词条幂等重算面板。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../../server/core/rng.js');
const { createLogger } = require('../../shared/log.js');
const roles = require('../../server/core/roles.js');

const TEMPLATES = require('../../server/data/role-templates.json').roleTemplates;
const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
const T = byId(TEMPLATES);
const BAL = T.role_bal;
const SPC_ATK = T.role_spc_atk;
const EXP_ATK = T.role_exp_atk;

// 序列化 stub：float/int 按序弹值（定点复算用；implementation 消耗顺序见 roles.js 登记注释）
function stubSeq(values) {
  let i = 0;
  return { float: () => values[i++], int: (lo, hi) => values[i++], pick: (a) => a[0] };
}

// 消耗顺序（登记）：[修饰随机 ints] → 5×品质系数 float → slotCount int → 槽类型 float×slotCount
test('T-RO-1/R-1 均衡：无修饰，品质系数与取整（→ 112/11/8/72/41）', () => {
  const role = roles.instantiateRole(BAL, 'rare', stubSeq([1.12, 1.08, 1.05, 1.20, 1.02, 0, 0, 0, 0]));
  assert.deepEqual(role.stats, { hp: 112, atk: 11, def: 8, sp: 72, mp: 41 }, 'R-1 完整实例');
  assert.deepEqual(role.regen, { mp: 1, sp: 2 });
  assert.equal(role.type, 'balanced');
});

test('T-RO-1/R-2 特化：高属性 +15%、恰 1 低 -15%（R-2a 完整实例）', () => {
  // int(0,3)=3 → 低属性 mp（0-hp 1-def 2-sp 3-mp）→ 40×0.85=34
  const role = roles.instantiateRole(SPC_ATK, 'rare', stubSeq([3, 1.10, 1.20, 1.15, 1.05, 1.00, 0, 0, 0, 0]));
  assert.deepEqual(role.stats, { hp: 110, atk: 14, def: 9, sp: 63, mp: 34 }, 'R-2a：atk 11.5×1.20=13.8→14；mp 34×1.00=34');
});

test('T-RO-1/R-2b 特化随机低属性：同名模板两种结果', () => {
  const r1 = roles.instantiateRole(SPC_ATK, 'rare', stubSeq([3, 1.10, 1.20, 1.15, 1.05, 1.00, 0, 0, 0, 0]));
  assert.equal(r1.stats.mp, 34, '低 mp');
  const r2 = roles.instantiateRole(SPC_ATK, 'rare', stubSeq([0, 1.10, 1.20, 1.15, 1.05, 1.00, 0, 0, 0, 0]));
  assert.equal(r2.stats.hp, 94, 'R-2b 低 hp：100×0.85=85（修饰后）→ ×1.10=93.5 → 94');
});

test('T-RO-2/R-3 专家：高属性 +30%、四修饰各一次（R-3a 完整实例）', () => {
  // 修饰数组 [1.1, 0.7, 0.9, 1.0]（hp/def/sp/mp）；FY 洗牌轨迹 ints=[1,2,1] 产生 hp+10%/def0%/sp-10%/mp-30%
  const role = roles.instantiateRole(EXP_ATK, 'rare', stubSeq([1, 2, 1, 1.10, 1.20, 1.15, 1.05, 1.00, 0, 0, 0, 0]));
  assert.deepEqual(role.stats, { hp: 121, atk: 16, def: 9, sp: 57, mp: 28 }, 'R-3a：hp 110×1.10=121；atk 13×1.20=15.6→16；sp 54×1.05=56.7→57；mp 28×1.00=28');
});

test('T-RO-2/R-3b 专家四修饰覆盖：applyTypeModifier 每属性分配互斥的四种修饰', () => {
  for (let i = 0; i < 80; i++) {
    const m = roles.applyTypeModifier(EXP_ATK, createRng(5000 + i));
    const ratios = { hp: m.hp / 100, def: m.def / 8, sp: m.sp / 60, mp: m.mp / 40 };
    const seen = Object.values(ratios).map((x) => Math.round(x * 100) / 100);
    for (const e of [1.1, 0.7, 0.9, 1.0]) assert.ok(seen.includes(e), `缺修饰 ${e}: ${seen}`);
    assert.equal(new Set(seen).size, 4, `四修饰互斥: ${seen}`);
  }
  // 高属性恒 +30%（atk）
  const m1 = roles.applyTypeModifier(EXP_ATK, createRng(9));
  assert.equal(Math.round(m1.atk * 100) / 100, 13, 'atk 基础 10×1.3=13');
});

test('T-RO-7/R-4 模板 regen 进实例 + 插件叠加（R-4b/c）', () => {
  const base = roles.instantiateRole(BAL, 'rare', stubSeq([1, 1, 1, 1, 1, 0, 0, 0, 0]));
  base.slots = [{ type: 'mp', pluginUid: null }, { type: 'sp', pluginUid: null }];
  assert.deepEqual(base.regen, { mp: 1, sp: 2 }, 'R-4a');
  const r1 = roles.equipPlugins(base, [{ id: 'rp_mp_regen', kind: 'rolePlugin', slot: 'mp', pointCost: 1, affixes: [{ id: 'mp_regen', params: { v: 1 } }] }]);
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.role.regen.mp, 2, 'R-4b');
  const r2 = roles.equipPlugins(r1.role, [{ id: 'rp_sp_regen', kind: 'rolePlugin', slot: 'sp', pointCost: 1, affixes: [{ id: 'sp_regen', params: { v: 1 } }] }]);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(r2.role.regen.sp, 3, 'R-4c');
});

test('T-RO-5/R-5 五维聚合：getFinalStats 幂等重算（R-5a/b）', () => {
  const mkAtk = (atk) => {
    const b = roles.instantiateRole(BAL, 'rare', stubSeq([1, 1, 1, 1, 1, 0, 0, 0, 0]));
    b.stats.atk = atk;
    b.slots = [{ type: 'atk', pluginUid: null }, { type: 'atk', pluginUid: null }];
    return b;
  };
  // R-5a：基础 11 → 11×1.0816=11.8976→12
  const a = roles.equipPlugins(mkAtk(11), [{ id: 'rp_atk_pct', kind: 'rolePlugin', slot: 'atk', pointCost: 1, affixes: [{ id: 'atk_pct', params: { v: 0.0816 } }] }]);
  assert.equal(a.ok, true, a.error);
  assert.equal(roles.getFinalStats(a.role).stats.atk, 12, 'R-5a');
  // R-5b：基础 14 → 14×1.0816+4=19.1424→19
  const b = roles.equipPlugins(mkAtk(14), [
    { uid: 'u1', id: 'rp_atk_pct', kind: 'rolePlugin', slot: 'atk', pointCost: 1, affixes: [{ id: 'atk_pct', params: { v: 0.0816 } }] },
    { uid: 'u2', id: 'rp_atk_flat', kind: 'rolePlugin', slot: 'atk', pointCost: 2, affixes: [{ id: 'atk_flat', params: { v: 4 } }] },
  ]);
  assert.equal(b.ok, true, b.error);
  assert.equal(roles.getFinalStats(b.role).stats.atk, 19, 'R-5b');
  assert.equal(roles.getFinalStats(b.role).stats.atk, 19, '幂等：两次重算一致');
});

test('T-RO-5/R-6 特殊插件：概率封顶 1（R-6d）', () => {
  const base = roles.instantiateRole(BAL, 'rare', stubSeq([1, 1, 1, 1, 1, 0, 0, 0, 0]));
  base.slots = [{ type: 'special', pluginUid: null }, { type: 'special', pluginUid: null }];
  const r = roles.equipPlugins(base, [
    { uid: 'd1', id: 'rp_dodge', kind: 'rolePlugin', slot: 'special', pointCost: 1, affixes: [{ id: 'dodge_chance', params: { v: 0.05 } }] },
    { uid: 'd2', id: 'rp_dodge', kind: 'rolePlugin', slot: 'special', pointCost: 1, affixes: [{ id: 'dodge_chance', params: { v: 1.2 } }] },
  ]);
  assert.equal(r.ok, true, r.error);
  assert.equal(roles.getFinalStats(r.role).special.dodgeChance, 1, 'R-6d');
});

test('T-RO-4/R-7 装配失败分支：槽型不匹配 / 点数超限 / 段位不足 / 唯一性（原子性）', () => {
  const mkBase = () => {
    const b = roles.instantiateRole(BAL, 'rare', stubSeq([1, 1, 1, 1, 1, 0, 0, 0, 0]));
    b.pluginPoints = 4;
    b.slots = [{ type: 'def', pluginUid: null }];
    return b;
  };
  // R-7a：atk 插件，但角色无 atk 空槽（只有 def 槽）
  const r7a = roles.equipPlugins(mkBase(), [{ id: 'rp_atk_pct', kind: 'rolePlugin', slot: 'atk', pointCost: 1, affixes: [] }]);
  assert.equal(r7a.ok, false, 'R-7a slot_type_mismatch');
  assert.equal(r7a.role, undefined, '失败不产出新实例');
  // R-7b：点数 2+2+1=5 > 4
  const b2 = mkBase();
  b2.slots = [{ type: 'atk', pluginUid: null }, { type: 'def', pluginUid: null }, { type: 'def', pluginUid: null }];
  const ok2 = roles.equipPlugins(b2, [
    { uid: 'p1', id: 'x1', kind: 'rolePlugin', slot: 'atk', pointCost: 2, affixes: [] },
    { uid: 'p2', id: 'x2', kind: 'rolePlugin', slot: 'def', pointCost: 2, affixes: [] },
  ]);
  assert.equal(ok2.ok, true, '2+2=4 通过');
  const r7b = roles.equipPlugins(ok2.role, [{ uid: 'p3', id: 'x3', kind: 'rolePlugin', slot: 'def', pointCost: 1, affixes: [] }]);
  assert.equal(r7b.ok, false, 'R-7b points_exceeded');
  assert.equal(r7b.role, undefined);
  // R-7c 段位不足
  const r7c = roles.equipPlugins(mkBase(), [{ id: 'p9', kind: 'rolePlugin', slot: 'def', pointCost: 1, unlockTier: 'legendary', affixes: [] }], { tier: 'rare' });
  assert.equal(r7c.ok, false, 'R-7c tier_locked');
  // R-7d 同一插件已装（equipped=true）再装 → 唯一性拒绝
  const b4 = mkBase();
  const dup = { uid: 'dup1', id: 'x9', kind: 'rolePlugin', slot: 'def', pointCost: 1, affixes: [], equipped: true };
  const ok4 = roles.equipPlugins(b4, [dup]);
  assert.equal(ok4.ok, false, 'R-7d equipped 唯一性');
});

test('T-RO-3/R-8 最终面板：getFinalStats（maxHp=hp、下限 1、regen/special 汇总）', () => {
  const base = roles.instantiateRole(BAL, 'rare', stubSeq([1.10, 1.10, 1.10, 1.10, 1.10, 0, 0, 0, 0]));
  const panel = roles.getFinalStats(base);
  assert.equal(panel.maxHp, base.stats.hp, 'R-8d');
  assert.equal(panel.maxMp, base.stats.mp);
  assert.deepEqual(panel.stats, base.stats);
  assert.deepEqual(panel.regen, { mp: 1, sp: 2 });
  assert.deepEqual(panel.special, {});
  // 下限 1：common 极低系数
  const low = roles.instantiateRole(BAL, 'common', stubSeq([0.80, 0.80, 0.80, 0.80, 0.80, 0, 0, 0, 0]));
  for (const k of ['hp', 'atk', 'def', 'sp', 'mp']) assert.ok(low.stats[k] >= 1, `${k} 下限 1`);
});

test('RO-10 补充分支：kind 不匹配拒绝；hp_regen 叠加（真实插件 rp_regen）', () => {
  const base = roles.instantiateRole(BAL, 'rare', stubSeq([1, 1, 1, 1, 1, 0, 0, 0, 0]));
  base.slots = [{ type: 'special', pluginUid: null }];
  const km = roles.equipPlugins(base, [{ id: 'sp_mult', kind: 'skillPlugin', slot: 'basic', pointCost: 1, affixes: [] }]);
  assert.equal(km.ok, false, 'kind_mismatch');
  assert.equal(km.error, 'kind_mismatch');
  const hr = roles.equipPlugins(base, [{ uid: 'r1', id: 'rp_regen', kind: 'rolePlugin', slot: 'special', pointCost: 1, affixes: [{ id: 'hp_regen', params: { v: 1 } }] }]);
  assert.equal(hr.ok, true, hr.error);
  assert.equal(hr.role.regen.hp, 1, '每 tick hp +1 叠加');
});

test('RO-9 日志：role.instantiate / role.panel（§4.6）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const r = roles.withLogger(logger);
  const role = r.instantiateRole(BAL, 'rare', createRng(1));
  assert.ok(logger.records.some((x) => x.event === 'role.instantiate' && x.data.templateId === 'role_bal'), '应有 role.instantiate');
  r.getFinalStats(role);
  assert.ok(logger.records.some((x) => x.event === 'role.panel'), '应有 role.panel');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    roles.instantiateRole(BAL, 'common', createRng(2));
    roles.applyTypeModifier(BAL, createRng(2));
    roles.equipPlugins(roles.instantiateRole(BAL, 'common', createRng(2)), []);
    roles.getFinalStats(roles.instantiateRole(BAL, 'common', createRng(2)));
  });
});