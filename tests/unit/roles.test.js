'use strict';
// B5 core/roles.js 契约测试 —— 接口见 docs/interfaces.md §1（instantiateRole/applyTypeModifier/equipPlugins/getFinalStats）
// 依据：examples/02-roles.md R-1..R-8（数值期望唯一出处）；decisions D-45/D-46/D-110
// 归属：tasks.md §6 B5（T-RO-1..7）；日志 role.instantiate(debug)/role.panel(debug)（§4.6）
// 语义（2026-09-16 合并后）：equipPlugins 只做"校验+登记"（不改 stats、**不改 regen**）；
//   getFinalStats 调用 items.buildRolePanel（**单一聚合实现**，与 loadout.buildPanel 同源）——
//   regen 只在那一次叠加，杜绝"equipPlugins 加一次 + buildPanel 再加一次"的双计。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../../server/core/rng.js');
const { createLogger } = require('../../shared/log.js');
const roles = require('../../server/core/roles.js');
const items = require('../../server/core/items.js');

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

test('T-RO-7/R-4 模板 regen 进实例 + 插件 regen 由单一聚合并入面板（R-4b/c；不再写回 role.regen）', () => {
  const base = roles.instantiateRole(BAL, 'rare', stubSeq([1, 1, 1, 1, 1, 0, 0, 0, 0]));
  base.slots = [{ type: 'mp', pluginUid: null }, { type: 'sp', pluginUid: null }];
  assert.deepEqual(base.regen, { mp: 1, sp: 2 }, 'R-4a');
  const r1 = roles.equipPlugins(base, [{ id: 'rp_mp_regen', kind: 'rolePlugin', slot: 'mp', pointCost: 1, affixes: [{ id: 'mp_regen', params: { v: 1 } }] }]);
  assert.equal(r1.ok, true, r1.error);
  // 登记阶段**不改写 regen**（旧实现会写回 → 与 buildPanel 双计）
  assert.deepEqual(r1.role.regen, { mp: 1, sp: 2 }, 'R-4b 登记不动 regen');
  assert.equal(roles.getFinalStats(r1.role).regen.mp, 2, 'R-4b 面板：模板 1 + 词条 +1 = 2');
  const r2 = roles.equipPlugins(r1.role, [{ id: 'rp_sp_regen', kind: 'rolePlugin', slot: 'sp', pointCost: 1, affixes: [{ id: 'sp_regen', params: { v: 1 } }] }]);
  assert.equal(r2.ok, true, r2.error);
  assert.equal(roles.getFinalStats(r2.role).regen.sp, 3, 'R-4c');
  assert.equal(roles.getFinalStats(r2.role).regen.mp, 2, 'R-4c 幂等：mp 不被叠加两次');
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
  // R-7c 段位不足（门控开启 = 回退模式：roles.withGating(true) 内部持有 items.withGating(true)）；
  //   门控关闭（默认，用户决策 2026-09-16）时同一调用必须放行 —— 两条路径都钉住（细节见 RO-14）。
  const r7c = roles.withGating(true).equipPlugins(mkBase(), [{ id: 'p9', kind: 'rolePlugin', slot: 'def', pointCost: 1, unlockTier: 'legendary', affixes: [] }], { tier: 'rare' });
  assert.equal(r7c.ok, false, 'R-7c tier_locked（门控开启）');
  const r7cOff = roles.equipPlugins(mkBase(), [{ id: 'p9', kind: 'rolePlugin', slot: 'def', pointCost: 1, unlockTier: 'legendary', affixes: [] }], { tier: 'rare' });
  assert.equal(r7cOff.ok, true, '门控关闭：R-7c 不再因段位拒绝');
  // R-7d 同一插件已装（equipped=true）再装 → 唯一性拒绝
  const b4 = mkBase();
  const dup = { uid: 'dup1', id: 'x9', kind: 'rolePlugin', slot: 'def', pointCost: 1, affixes: [], equipped: true };
  const ok4 = roles.equipPlugins(b4, [dup]);
  assert.equal(ok4.ok, false, 'R-7d equipped 唯一性');
});

test('RO-14 门控注入缝（推荐方向，替代单例打补丁）：roles.withGating(mode) 与链式 withLogger 不丢设置', () => {
  const mk = () => ({ stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 }, slots: [{ type: 'def', pluginUid: null }], equipped: [], pluginPoints: 3 });
  const gatedPlugin = [{ uid: 'g9', id: 'rp_def_flat', kind: 'rolePlugin', slot: 'def', pointCost: 1, unlockTier: 'legendary', affixes: [] }];
  // 默认实例 = 门控关闭（unlock.json gating.enabled=false）→ 段位不参与判定
  assert.equal(roles.gatingEnabled, false, '缺省实例门控关闭');
  assert.equal(roles.equipPlugins(mk(), gatedPlugin, { tier: 'rare' }).ok, true, '默认：超段位插件放行');
  // 注入门控开启实例 → 复核 R-7c 的 tier_locked 分支（不依赖单例打补丁）
  const gated = roles.withGating(true);
  assert.equal(gated.gatingEnabled, true, 'withGating(true) 自省');
  assert.equal(gated.equipPlugins(mk(), gatedPlugin, { tier: 'rare' }).error, 'tier_locked', '门控开启：tier_locked');
  assert.equal(gated.equipPlugins(mk(), gatedPlugin, { tier: 'mythic' }).ok, true, '门控开启：段位足够放行');
  // 链式：withGating(true).withLogger(log) 两者都要生效（不丢门控设置）
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const chained = roles.withGating(true).withLogger(logger);
  assert.equal(chained.gatingEnabled, true, '链式后门控设置保留');
  assert.equal(chained.equipPlugins(mk(), gatedPlugin, { tier: 'rare' }).error, 'tier_locked');
  chained.getFinalStats(roles.instantiateRole(BAL, 'rare', stubSeq([1, 1, 1, 1, 1, 0, 0, 0, 0])));
  assert.ok(logger.records.some((x) => x.event === 'role.panel'), '链式后 logger 仍生效');
  assert.equal(roles.withGating(false).gatingEnabled, false, 'withGating(false) 可显式关闭');
  // 实例级工厂可再次切换（链式不丢 logger/门控设置）
  const reGated = chained.withGating(false);
  assert.equal(reGated.gatingEnabled, false, '实例级 withGating 可再次切换');
  assert.equal(reGated.equipPlugins(mk(), gatedPlugin, { tier: 'rare' }).ok, true, '切回关闭后放行');
  // 角色物品形状 + 注入实例：同一聚合实现（角色物品无 equipped 也不抛）
  assert.equal(chained.getFinalStats(mk(), []).stats.hp, 100, '角色物品形状可被聚合');
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
  assert.equal(hr.role.regen.hp, undefined, '登记阶段不写 regen.hp（单一聚合负责）');
  assert.equal(roles.getFinalStats(hr.role).regen.hp, 1, '面板 regen.hp = 1（每 tick hp +1，引擎步骤 10 消费）');
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

// ---- 2026-09-16 合并（用户拍板 A）：单一聚合实现 + 角色对象形状容错 ----

test('RO-11 单一聚合：roles.applyTypeModifier 就是 items.applyTypeModifier；getFinalStats 与 items.buildRolePanel 逐值同源', () => {
  assert.equal(roles.applyTypeModifier, items.applyTypeModifier, '类型修饰只有一份实现（开箱 generateRoleItem 同用）');
  const base = roles.instantiateRole(BAL, 'rare', stubSeq([1.10, 1.10, 1.10, 1.10, 1.10, 0, 0, 0, 0]));
  base.slots = [{ type: 'hp', pluginUid: null }];
  const plugin = { uid: 'p1', id: 'rp_hp_flat', kind: 'rolePlugin', slot: 'hp', pointCost: 1, affixes: [{ id: 'hp_flat', params: { v: 20 } }] };
  const equipped = roles.equipPlugins(base, [plugin]);
  assert.equal(equipped.ok, true, equipped.error);
  const role = equipped.role;
  role.regen = { mp: 1, sp: 2 };
  const viaRoles = roles.getFinalStats(role);
  const viaItems = items.buildRolePanel(role, [plugin]);
  assert.deepEqual(viaRoles, viaItems, 'getFinalStats 与 items.buildRolePanel 输出逐值一致（同一份算法）');
  assert.equal(viaRoles.stats.hp, items.applyAffixes(role.stats, plugin.affixes).stats.hp, '面板 = applyAffixes 结果');
  // 幂等：两次调用一致；重复传入已装配插件不会二次叠加（插件列表由调用方解析，去重由装配唯一性保证）
  assert.deepEqual(roles.getFinalStats(role), viaRoles, '幂等');
});

test('RO-12 形状容错：角色物品（无 kind/equipped）可被两个入口接受；畸形输入给明确错误而非 TypeError', () => {
  // ① 角色物品形态（warehouse/openBox 产物：有 slots/stats/regen/pluginPoints，无 equipped/charId）
  const roleItem = {
    uid: 'it1', kind: 'role', templateId: BAL.id, quality: 'rare',
    stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
    slots: [{ type: 'atk', pluginUid: null }], pluginPoints: 3,
  };
  const r1 = roles.equipPlugins(roleItem, [{ uid: 'p1', id: 'rp_atk_pct', kind: 'rolePlugin', slot: 'atk', pointCost: 1, affixes: [{ id: 'atk_pct', params: { v: 0.5 } }] }]);
  assert.equal(r1.ok, true, `${r1.error}`);
  assert.equal(roles.getFinalStats(r1.role).stats.atk, 15, '10×(1+0.5)=15（角色物品形态可用）');
  // ② 无 equipped、靠 slots.pluginUid + plugins[] 解析（同一份聚合函数）
  const bySlot = {
    kind: 'role', stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
    slots: [{ type: 'atk', pluginUid: 'q1' }],
    plugins: [{ uid: 'q1', affixes: [{ id: 'atk_flat', params: { v: 5 } }] }],
  };
  assert.equal(roles.getFinalStats(bySlot).stats.atk, 15, 'slots 引用 + plugins 索引可解析（不抛 TypeError）');
  // ③ 缺 slots / pluginPoints：明确错误码，不抛
  const bare = { stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 } };
  const r2 = roles.equipPlugins(bare, [{ uid: 'x', id: 'x', kind: 'rolePlugin', slot: 'atk', pointCost: 1, affixes: [] }]);
  assert.equal(r2.ok, false);
  assert.equal(r2.error, 'slot_type_mismatch', '无 slots → 槽位语义错误（旧实现 TypeError）');
  assert.equal(roles.getFinalStats(bare).stats.atk, 10, '无 equipped → 空插件列表（面板=原始五维）');
  const r3 = roles.equipPlugins({ stats: {}, slots: [{ type: 'atk', pluginUid: null }] }, [{ uid: 'y', id: 'y', kind: 'rolePlugin', slot: 'atk', pointCost: 1, affixes: [] }]);
  assert.equal(r3.error, 'points_exceeded', '缺 pluginPoints → 预算 0（明确拒绝，不 NaN 静默通过）');
  const r4 = roles.equipPlugins({ stats: {}, slots: [{ type: 'atk', pluginUid: null }] }, [{ uid: 'z', id: 'z', kind: 'rolePlugin', slot: 'atk', affixes: [] }]);
  assert.equal(r4.ok, true, 'pointCost 缺失按 0 计 → 放行');
  // ④ 畸形 equipped 条目（缺 plugin）不抛；非数组 plugins 视为空候选
  const messy = { stats: { hp: 1, atk: 10, def: 1, sp: 1, mp: 1 }, slots: [], equipped: [{}, null], regen: { mp: 0, sp: 0 } };
  assert.equal(roles.equipPlugins(messy, 'nope').ok, true, 'plugins 非数组 → 空候选');
  assert.equal(roles.getFinalStats(messy).stats.atk, 10, '畸形 equipped 不参与聚合、不抛');
  // ⑤ 非对象输入 → 明确 role_invalid；null 角色 → 空面板（下限 1）
  assert.equal(roles.equipPlugins(null, []).error, 'role_invalid');
  assert.equal(roles.equipPlugins('nope', []).error, 'role_invalid');
  assert.deepEqual(roles.getFinalStats(null).stats, { hp: 1, atk: 1, def: 1, sp: 1, mp: 1 }, 'null → 空面板下限 1');
  // ⑥ 第二参显式传插件列表（与 loadout.buildPanel 同形调用）
  assert.equal(roles.getFinalStats(bare, [{ affixes: [{ id: 'atk_flat', params: { v: 7 } }] }]).stats.atk, 17, '显式插件列表优先');
});

test('RO-13 开箱与实例化同口径：generateRoleItem 与 instantiateRole 在相同 rng 序列下逐值一致（含类型修饰）', () => {
  for (const tpl of [BAL, SPC_ATK, EXP_ATK]) {
    const seq = [2, 1, 1, 1.10, 1.00, 1.05, 0.95, 0, 0, 0, 0]; // 修饰 ints → 5×品质系数 → slotCount → 槽
    const item = items.generateRoleItem(tpl, 'rare', stubSeq(seq));
    const role = roles.instantiateRole(tpl, 'rare', stubSeq(seq));
    assert.deepEqual(item.stats, role.stats, `${tpl.id}: 开箱物品与运行时角色同口径（修饰随机 → 品质系数 → 取整）`);
    assert.deepEqual(item.slots.map((s) => s.type), role.slots.map((s) => s.type), `${tpl.id}: 插槽序列一致（同一随机消耗顺序）`);
  }
});
