'use strict';
// B4 core/unlock.js 契约测试 —— 接口见 docs/interfaces.md §1（tierIndex/isUnlocked/filterByTier/validateLoadout/availableNodes）
// 依据：examples/09-unlock.md U-1..U-6（全分支）；decisions D-112/D-120；unlock.json 数据
// 归属：tasks.md §6 B4（T-IT-6 + T-UL-1..4）；日志 unlock.check(debug)/unlock.reject(warn)（§4.6）
// **两模式（2026-09-16 用户决策）**：默认 `gating.enabled=false` → 段位不参与判定。本文件对每个原语
//   成对覆盖：`gated = ul.withGating(true)`（开关打开 = 原行为）+ 缺省实例（开关关闭 = 全解锁）。
//   段位树/权限表/unlockTier 字段保留为元数据 —— UL-7b 断言数据完备性两边都成立。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const ul = require('../../server/core/unlock.js');

const ROLE_TEMPLATES = require('../../server/data/role-templates.json').roleTemplates;
const SKILL_TEMPLATES = require('../../server/data/skill-templates.json').skillTemplates;
const PLUGINS = require('../../server/data/plugins.json').plugins;
const AI_NODES = require('../../server/data/ai-nodes.json');

const gated = ul.withGating(true); // 门控开启（回退模式）：旧行为
const ALL_TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];

test('T-UL-0 开关自省：缺省 = unlock.json gating.enabled(false)；两模式工厂可注入且可链式', () => {
  const data = require('../../server/data/unlock.json');
  assert.equal(data.gating.enabled, false, '开关数据落在 unlock.json（gating.enabled=false，用户决策 2026-09-16）');
  assert.equal(typeof data.gating.note, 'string');
  assert.equal(ul.GATING_DEFAULT, false, '模块导出的缺省门控值 = 开关字段');
  assert.equal(ul.gatingEnabled, false, '缺省实例 = 门控关闭');
  assert.equal(gated.gatingEnabled, true, 'withGating(true) 实例 = 门控开启');
  assert.equal(ul.withGating(false).gatingEnabled, false);
  // 链式：withGating 与 withLogger 互不覆盖
  const logger = createLogger({ level: 'all', ringSize: 50 });
  assert.equal(gated.withLogger(logger).gatingEnabled, true, 'withGating(true).withLogger 保持开启');
  assert.equal(ul.withLogger(logger).withGating(true).gatingEnabled, true, 'withLogger 后仍可切门控');
  assert.equal(ul.withLogger(logger).gatingEnabled, false, 'withLogger 保持缺省关闭');
});

test('T-UL-1/U-1（门控开启）累计与继承：availableNodes 只返回真实节点类型（mythic 全集 16；rare 含 if；common 不含 random）', () => {
  const common = gated.availableNodes('common');
  const rare = gated.availableNodes('rare');
  const mythic = gated.availableNodes('mythic');
  assert.ok(common.includes('if'), 'U-1a rare 含 if（继承在 rare 上验证）');
  assert.ok(rare.includes('if'), 'if 属于 common 基础');
  assert.ok(!common.includes('random'), 'U-1b common 不含 random');
  // 2026-09-16 修正：availableNodes = **真实节点类型**（ai-nodes.json 单一数据源），
  //   权限别名（while→loop）与未实现的预留权限（arith_ext）不再混入，避免编辑器插入服务端必拒的积木。
  //   2026-09-17：`bullets` 节点已从语言中移除（AI 无法观测弹幕，弹幕当 tick 全解算）→ 全集 17 → 16。
  assert.equal(mythic.length, 16, 'U-1c mythic 全集 16（= ai-nodes.json nodes 长度）');
  for (const n of ['seq', 'literal', 'get', 'var', 'set', 'getVar', 'arith', 'cmp', 'action',
    'if', 'loop', 'break', 'random', 'logic', 'function', 'call']) {
    assert.ok(mythic.includes(n), `mythic 应含 ${n}`);
  }
  assert.ok(!mythic.includes('while'), '权限别名 while 不是节点类型');
  assert.ok(!mythic.includes('arith_ext'), '未实现的预留权限不进入可用节点集');
  // 段位累计数（门控开启时的口径，09-unlock §3）：10/12/14/14/16
  assert.deepEqual(ALL_TIERS.map((t) => gated.availableNodes(t).length), [10, 12, 14, 14, 16], '段位累计数 10/12/14/14/16');
  // 权限语义：while 可用（别名折叠到 loop）；arith_ext 未实现 → 恒 false
  assert.equal(gated.isUnlocked('rare', 'while'), true, 'while 权限在 rare 可用（折叠为 loop）');
  assert.equal(gated.isUnlocked('epic', 'arith_ext'), false, 'arith_ext 未实现 → 不可用');
});

test('T-UL-1b（门控关闭·默认）availableNodes 分段位不生效：任意段位都返回全部 16 类真实节点', () => {
  for (const t of ALL_TIERS) {
    const nodes = ul.availableNodes(t);
    assert.equal(nodes.length, AI_NODES.nodes.length, `${t} 应返回全部 ${AI_NODES.nodes.length} 类节点`);
    assert.deepEqual(nodes, AI_NODES.nodes, `${t} 与 ai-nodes.json nodes 逐项一致`);
  }
  assert.equal(ul.availableNodes('nope').length, 16, '未知段位也照给（段位不参与判定）');
  // 返回副本：调用方修改不外泄（纯函数不入参/不泄漏内部状态）
  const copy = ul.availableNodes('common');
  copy.push('hacked');
  assert.equal(ul.availableNodes('common').length, 16, '返回值修改不影响后续查询');
});

test('T-UL-1/U-2（门控开启）isUnlocked 全分支（含未知 tier/key 保守拒绝）', () => {
  assert.equal(gated.isUnlocked('rare', 'loop'), true, 'U-2a');
  assert.equal(gated.isUnlocked('rare', 'random'), false, 'U-2b');
  assert.equal(gated.isUnlocked('epic', 'loop'), true, 'U-2c 继承');
  assert.equal(gated.isUnlocked('common', 'if'), true, 'U-2d');
  assert.equal(gated.isUnlocked('nope', 'if'), false, 'U-2e 未知 tier');
  assert.equal(gated.isUnlocked('mythic', 'no_such_node'), false, 'U-2f 未知 key');
  assert.equal(gated.isUnlocked('common', 'seq'), true, '基础节点恒可用');
});

test('T-UL-2b（门控关闭·默认）isUnlocked 恒 true：任意段位 × 任意 key', () => {
  for (const t of ALL_TIERS.concat(['nope', null, undefined])) {
    for (const k of ['function', 'random', 'while', 'arith_ext', 'no_such_node']) {
      assert.equal(ul.isUnlocked(t, k), true, `isUnlocked(${t}, ${k}) 段位不参与判定`);
    }
  }
});

test('T-UL-3/U-3（门控开启）filterByTier 全分支（含缺 unlockTier 保留/空列表/全超段位）', () => {
  const roles = [
    { id: 'a', unlockTier: 'common' },
    { id: 'b', unlockTier: 'rare' },
    { id: 'c', unlockTier: 'legendary' },
  ];
  assert.deepEqual(gated.filterByTier(roles, 'rare').map((x) => x.id), ['a', 'b'], 'U-3a');
  const skills = [
    { id: 's1', unlockTier: 'common' }, { id: 's2', unlockTier: 'rare' },
    { id: 's3', unlockTier: 'legendary' }, { id: 's4', unlockTier: 'mythic' },
  ];
  assert.deepEqual(gated.filterByTier(skills, 'epic').map((x) => x.id), ['s1', 's2'], 'U-3b');
  const mixed = [{ id: 'no-tier' }, { id: 'x', unlockTier: 'common' }];
  assert.deepEqual(gated.filterByTier(mixed, 'common').map((x) => x.id), ['no-tier', 'x'], 'U-3c 缺 unlockTier 保留');
  assert.deepEqual(gated.filterByTier([], 'common'), [], 'U-3d 空列表');
  assert.deepEqual(gated.filterByTier([{ id: 'z', unlockTier: 'mythic' }], 'common'), [], 'U-3e 全超段位');
});

test('T-UL-3b（门控关闭·默认）filterByTier 原样返回：任意段位不剔除任何条目', () => {
  const list = [{ id: 'a', unlockTier: 'mythic' }, { id: 'b', unlockTier: 'common' }, { id: 'c' }];
  for (const t of ALL_TIERS.concat(['nope'])) {
    assert.deepEqual(ul.filterByTier(list, t), list, `${t} 原样返回`);
  }
  // 真实表：任意段位都拿全量角色/技能/插件（= 全部模板/插件解锁）
  assert.equal(ul.filterByTier(ROLE_TEMPLATES, 'common').length, ROLE_TEMPLATES.length);
  assert.equal(ul.filterByTier(SKILL_TEMPLATES, 'common').length, SKILL_TEMPLATES.length);
  assert.equal(ul.filterByTier(PLUGINS, 'common').length, PLUGINS.length);
  assert.equal(ul.filterByTier([], 'common').length, 0, '空列表 → 空');
});

test('U-5（门控开启）validateLoadout：角色/技能/插件门控（tier_locked + 具体成员）', () => {
  const loadout = {
    role: { templateId: 'role_bal' },
    skills: [
      { sid: 'skill1', templateId: 'skill_melee_whirl' },
      { sid: 'skill2', templateId: 'skill_melee_heavy' },
      { sid: 'skill3', templateId: 'skill_dash_bash' },
    ],
    plugins: [{ uid: 'p1', id: 'rp_atk_pct' }],
  };
  const ok = gated.validateLoadout(loadout, 'mythic');
  assert.equal(ok.ok, true, 'U-5a 全满足');
  const badRole = gated.validateLoadout({ role: { templateId: 'role_exp_atk' }, skills: [], plugins: [] }, 'rare');
  assert.equal(badRole.ok, false);
  assert.equal(badRole.errors[0].code, 'tier_locked');
  assert.equal(badRole.errors[0].where, 'role', 'U-5b 角色定位');
  const badSkill = gated.validateLoadout({
    role: { templateId: 'role_bal' },
    skills: [{ sid: 'skill1', templateId: 'skill_dash_bash' }],
    plugins: [],
  }, 'rare');
  assert.equal(badSkill.ok, false);
  assert.equal(badSkill.errors[0].where, 'skills[0]', 'U-5c 技能槽定位');
  // U-5d 插件门控（B20 真分支：rp_sp_opt 已带 unlockTier=legendary；此前 29 插件全无该字段）
  const badPlugin = gated.validateLoadout({
    role: { templateId: 'role_bal' },
    skills: [],
    plugins: [{ uid: 'p1', id: 'rp_sp_opt' }],
  }, 'rare');
  assert.equal(badPlugin.ok, false, 'U-5d 真分支：legendary 插件 + rare → tier_locked');
  assert.equal(badPlugin.errors[0].code, 'tier_locked');
  const okPlugin = gated.validateLoadout({
    role: { templateId: 'role_bal' },
    skills: [],
    plugins: [{ uid: 'p1', id: 'sp_buff' }],
  }, 'common');
  assert.equal(okPlugin.ok, true, '无 unlockTier 插件不拒绝');
});

test('U-5b（门控关闭·默认）validateLoadout 不再产生 tier_locked：{ok:true,errors:[]}', () => {
  // 三个成员臂（角色/技能/插件）都被"超段位"数据打满，仍恒放行
  const loadout = {
    role: { templateId: 'role_exp_atk' }, // 需 legendary
    skills: [
      { sid: 's1', templateId: 'skill_dash_bash' },      // 需 mythic
      { sid: 's2', templateId: 'skill_vert_fireball' },  // 需 legendary
      { sid: 's3', templateId: 'skill_melee_whirl' },
    ],
    plugins: [{ uid: 'p1', id: 'rp_sp_opt' }, { uid: 'p2', id: 'sp_displacement' }], // 均需 legendary
  };
  for (const t of ALL_TIERS) {
    assert.deepEqual(ul.validateLoadout(loadout, t), { ok: true, errors: [] }, `${t} 不因段位拒绝`);
  }
  assert.deepEqual(ul.validateLoadout(loadout, 'nope'), { ok: true, errors: [] }, '未知段位也不拒绝');
});

test('UL-6 tierIndex：段位序号映射与未知保守', () => {
  assert.equal(ul.tierIndex('common'), 0);
  assert.equal(ul.tierIndex('rare'), 1);
  assert.equal(ul.tierIndex('epic'), 2);
  assert.equal(ul.tierIndex('legendary'), 3);
  assert.equal(ul.tierIndex('mythic'), 4);
  assert.equal(ul.tierIndex('nope'), null, '未知 → null（保守拒绝）');
  assert.equal(gated.tierIndex('mythic'), 4, 'tierIndex 与门控无关（两模式同一原语）');
});

test('UL-7（门控开启）T-IT-6 协同：filterByTier 与 items.validateUnlock 同一口径', () => {
  const items = require('../../server/core/items.js').withGating(true);
  for (const t of ROLE_TEMPLATES) {
    const tier = t.unlockTier || 'common';
    assert.equal(items.validateUnlock(t, tier), true, `${t.id} 自身段位通过`);
    const filtered = gated.filterByTier([t], 'common');
    if (tier === 'common') assert.equal(filtered.length, 1, `${t.id} common 保留`);
    else assert.equal(filtered.length, 0, `${t.id} common 剔除`);
  }
  // 门控插件与 filterByTier 同口径（T-PB-7）
  assert.deepEqual(gated.filterByTier(PLUGINS, 'rare').map((x) => x.id).filter((id) => id === 'rp_sp_opt' || id === 'sp_displacement'), [], 'rare 剔除高段位插件');
  assert.deepEqual(gated.filterByTier(PLUGINS, 'legendary').map((x) => x.id).filter((id) => id === 'rp_sp_opt' || id === 'sp_displacement'), ['rp_sp_opt', 'sp_displacement'], 'legendary 保留');
});

test('UL-7b 段位元数据保留（两模式共同事实）：模板/插件 unlockTier 覆盖五段位，数据不因关掉门控而丢失', () => {
  const items = require('../../server/core/items.js');
  for (const t of ROLE_TEMPLATES) {
    assert.equal(items.validateUnlock(t, t.unlockTier || 'common'), true, `${t.id} 门控关闭时自身段位仍通过`);
  }
  const roles = new Set(ROLE_TEMPLATES.map((x) => x.unlockTier || 'common'));
  const skills = new Set(SKILL_TEMPLATES.map((x) => x.unlockTier || 'common'));
  const plugins = new Set(PLUGINS.map((x) => x.unlockTier || 'common'));
  assert.deepEqual([...roles].sort(), ['common', 'legendary', 'rare'], '角色覆盖 3 段');
  assert.deepEqual([...skills].sort(), ['common', 'epic', 'legendary', 'mythic', 'rare'], '技能覆盖 5 段');
  assert.deepEqual([...plugins].sort(), ['common', 'legendary'], 'B20：插件引入 unlockTier（rp_sp_opt/sp_displacement）——T-PB-7 真分支');
  // 段位树（unlock.json unlocks）与真实节点表仍在（仅作为进度/评分元数据）
  const data = require('../../server/data/unlock.json');
  assert.equal(data.unlocks.length, 5, '段位树保留 5 档');
  assert.equal(data.nodePermissions.arith_ext.implemented, false, 'nodePermissions 预留权限声明保留');
});

test('UL-9 健壮性：validateLoadout(null/空) 不抛错（审查 P2-b）', () => {
  assert.doesNotThrow(() => ul.validateLoadout(null, 'common'));
  assert.deepEqual(ul.validateLoadout(null, 'common'), { ok: true, errors: [] });
  assert.deepEqual(ul.validateLoadout(undefined, 'mythic').ok, true);
  assert.deepEqual(gated.validateLoadout(null, 'common'), { ok: true, errors: [] }, '门控开启时空入参同样放行');
});

test('UL-8 日志：unlock.check(debug) / unlock.reject(warn)（§4.6 事件；两模式分别断言）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  // 门控开启：check 记录 hit，tier_locked 记 unlock.reject
  const u = ul.withGating(true).withLogger(logger);
  u.isUnlocked('rare', 'loop');
  assert.ok(logger.records.some((r) => r.event === 'unlock.check' && r.data.tier === 'rare' && r.data.key === 'loop'), '应有 unlock.check');
  const bad = u.validateLoadout({ role: { templateId: 'role_exp_atk' }, skills: [], plugins: [] }, 'common');
  assert.equal(bad.ok, false);
  assert.ok(logger.records.some((x) => x.event === 'unlock.reject' && x.data.where === 'role'), 'tier_locked 记 unlock.reject');
  // 门控关闭（默认）：check 仍记（hit=true），但**不再**产生 unlock.reject
  const logger2 = createLogger({ level: 'all', ringSize: 500 });
  const off = ul.withLogger(logger2);
  assert.equal(off.isUnlocked('common', 'random'), true);
  assert.ok(logger2.records.some((r) => r.event === 'unlock.check' && r.data.key === 'random' && r.data.hit === true), '关闭时 hit=true 照记');
  assert.deepEqual(off.validateLoadout({ role: { templateId: 'role_exp_atk' }, skills: [], plugins: [] }, 'common'), { ok: true, errors: [] });
  assert.equal(logger2.records.filter((x) => x.event === 'unlock.reject').length, 0, '门控关闭不得记 unlock.reject');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    ul.isUnlocked('common', 'if');
    ul.filterByTier([{ id: 'x' }], 'common');
    ul.validateLoadout({ role: { templateId: 'role_bal' }, skills: [], plugins: [] }, 'common');
    ul.availableNodes('epic');
    ul.tierIndex('mythic');
  });
});
