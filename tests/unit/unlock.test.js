'use strict';
// B4 core/unlock.js 契约测试 —— 接口见 docs/interfaces.md §1（tierIndex/isUnlocked/filterByTier/validateLoadout/availableNodes）
// 依据：examples/09-unlock.md U-1..U-6（全分支）；decisions D-112/D-120；unlock.json 数据
// 归属：tasks.md §6 B4（T-IT-6 + T-UL-1..4）；日志 unlock.check(debug)/unlock.reject(warn)（§4.6）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const ul = require('../../server/core/unlock.js');

const ROLE_TEMPLATES = require('../../server/data/role-templates.json').roleTemplates;
const SKILL_TEMPLATES = require('../../server/data/skill-templates.json').skillTemplates;
const PLUGINS = require('../../server/data/plugins.json').plugins;

test('T-UL-1/U-1 累计与继承：availableNodes 只返回真实节点类型（mythic 全集 16；rare 含 if；common 不含 random）', () => {
  const common = ul.availableNodes('common');
  const rare = ul.availableNodes('rare');
  const mythic = ul.availableNodes('mythic');
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
  // 权限语义：while 可用（别名折叠到 loop）；arith_ext 未实现 → 恒 false
  assert.equal(ul.isUnlocked('rare', 'while'), true, 'while 权限在 rare 可用（折叠为 loop）');
  assert.equal(ul.isUnlocked('epic', 'arith_ext'), false, 'arith_ext 未实现 → 不可用');
});

test('T-UL-1/U-2 isUnlocked 全分支（含未知 tier/key 保守拒绝）', () => {
  assert.equal(ul.isUnlocked('rare', 'loop'), true, 'U-2a');
  assert.equal(ul.isUnlocked('rare', 'random'), false, 'U-2b');
  assert.equal(ul.isUnlocked('epic', 'loop'), true, 'U-2c 继承');
  assert.equal(ul.isUnlocked('common', 'if'), true, 'U-2d');
  assert.equal(ul.isUnlocked('nope', 'if'), false, 'U-2e 未知 tier');
  assert.equal(ul.isUnlocked('mythic', 'no_such_node'), false, 'U-2f 未知 key');
  assert.equal(ul.isUnlocked('common', 'seq'), true, '基础节点恒可用');
});

test('T-UL-3/U-3 filterByTier 全分支（含缺 unlockTier 保留/空列表/全超段位）', () => {
  const roles = [
    { id: 'a', unlockTier: 'common' },
    { id: 'b', unlockTier: 'rare' },
    { id: 'c', unlockTier: 'legendary' },
  ];
  assert.deepEqual(ul.filterByTier(roles, 'rare').map((x) => x.id), ['a', 'b'], 'U-3a');
  const skills = [
    { id: 's1', unlockTier: 'common' }, { id: 's2', unlockTier: 'rare' },
    { id: 's3', unlockTier: 'legendary' }, { id: 's4', unlockTier: 'mythic' },
  ];
  assert.deepEqual(ul.filterByTier(skills, 'epic').map((x) => x.id), ['s1', 's2'], 'U-3b');
  const mixed = [{ id: 'no-tier' }, { id: 'x', unlockTier: 'common' }];
  assert.deepEqual(ul.filterByTier(mixed, 'common').map((x) => x.id), ['no-tier', 'x'], 'U-3c 缺 unlockTier 保留');
  assert.deepEqual(ul.filterByTier([], 'common'), [], 'U-3d 空列表');
  assert.deepEqual(ul.filterByTier([{ id: 'z', unlockTier: 'mythic' }], 'common'), [], 'U-3e 全超段位');
});



test('U-5 validateLoadout：角色/技能/插件门控（tier_locked + 具体成员）', () => {
  const loadout = {
    role: { templateId: 'role_bal' },
    skills: [
      { sid: 'skill1', templateId: 'skill_melee_whirl' },
      { sid: 'skill2', templateId: 'skill_melee_heavy' },
      { sid: 'skill3', templateId: 'skill_dash_bash' },
    ],
    plugins: [{ uid: 'p1', id: 'rp_atk_pct' }],
  };
  const ok = ul.validateLoadout(loadout, 'mythic');
  assert.equal(ok.ok, true, 'U-5a 全满足');
  const badRole = ul.validateLoadout({ role: { templateId: 'role_exp_atk' }, skills: [], plugins: [] }, 'rare');
  assert.equal(badRole.ok, false);
  assert.equal(badRole.errors[0].code, 'tier_locked');
  assert.equal(badRole.errors[0].where, 'role', 'U-5b 角色定位');
  const badSkill = ul.validateLoadout({
    role: { templateId: 'role_bal' },
    skills: [{ sid: 'skill1', templateId: 'skill_dash_bash' }],
    plugins: [],
  }, 'rare');
  assert.equal(badSkill.ok, false);
  assert.equal(badSkill.errors[0].where, 'skills[0]', 'U-5c 技能槽定位');
  // U-5d 插件门控（B20 真分支：rp_sp_opt 已带 unlockTier=legendary；此前 29 插件全无该字段）
  const badPlugin = ul.validateLoadout({
    role: { templateId: 'role_bal' },
    skills: [],
    plugins: [{ uid: 'p1', id: 'rp_sp_opt' }],
  }, 'rare');
  assert.equal(badPlugin.ok, false, 'U-5d 真分支：legendary 插件 + rare → tier_locked');
  assert.equal(badPlugin.errors[0].code, 'tier_locked');
  const okPlugin = ul.validateLoadout({
    role: { templateId: 'role_bal' },
    skills: [],
    plugins: [{ uid: 'p1', id: 'sp_buff' }],
  }, 'common');
  assert.equal(okPlugin.ok, true, '无 unlockTier 插件不拒绝');
});

test('UL-6 tierIndex：段位序号映射与未知保守', () => {
  assert.equal(ul.tierIndex('common'), 0);
  assert.equal(ul.tierIndex('rare'), 1);
  assert.equal(ul.tierIndex('epic'), 2);
  assert.equal(ul.tierIndex('legendary'), 3);
  assert.equal(ul.tierIndex('mythic'), 4);
  assert.equal(ul.tierIndex('nope'), null, '未知 → null（保守拒绝）');
});

test('UL-7 T-IT-6 协同：filterByTier 与 items.validateUnlock 同一口径', () => {
  const items = require('../../server/core/items.js');
  for (const t of ROLE_TEMPLATES) {
    const tier = t.unlockTier || 'common';
    assert.equal(items.validateUnlock(t, tier), true, `${t.id} 自身段位通过`);
    const filtered = ul.filterByTier([t], 'common');
    if (tier === 'common') assert.equal(filtered.length, 1, `${t.id} common 保留`);
    else assert.equal(filtered.length, 0, `${t.id} common 剔除`);
  }
  // 全部模板的 unlockTier 覆盖五段位（数据完备性）
  const roles = new Set(ROLE_TEMPLATES.map((x) => x.unlockTier || 'common'));
  const skills = new Set(SKILL_TEMPLATES.map((x) => x.unlockTier || 'common'));
  const plugins = new Set(PLUGINS.map((x) => x.unlockTier || 'common'));
  assert.deepEqual([...roles].sort(), ['common', 'legendary', 'rare'], '角色覆盖 3 段');
  assert.deepEqual([...skills].sort(), ['common', 'epic', 'legendary', 'mythic', 'rare'], '技能覆盖 5 段');
  assert.deepEqual([...plugins].sort(), ['common', 'legendary'], 'B20：插件引入 unlockTier（rp_sp_opt/sp_displacement）——T-PB-7 真分支');
  // 门控插件与 filterByTier 同口径（T-PB-7）
  assert.deepEqual(ul.filterByTier(PLUGINS, 'rare').map((x) => x.id).filter((id) => id === 'rp_sp_opt' || id === 'sp_displacement'), [], 'rare 剔除高段位插件');
  assert.deepEqual(ul.filterByTier(PLUGINS, 'legendary').map((x) => x.id).filter((id) => id === 'rp_sp_opt' || id === 'sp_displacement'), ['rp_sp_opt', 'sp_displacement'], 'legendary 保留');
});

test('UL-9 健壮性：validateLoadout(null/空) 不抛错（审查 P2-b）', () => {
  assert.doesNotThrow(() => ul.validateLoadout(null, 'common'));
  assert.deepEqual(ul.validateLoadout(null, 'common'), { ok: true, errors: [] });
  assert.deepEqual(ul.validateLoadout(undefined, 'mythic').ok, true);
});

test('UL-8 日志：unlock.check(debug) / unlock.reject(warn)（§4.6 事件；validateAi 退役后保留原语断言）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const u = ul.withLogger(logger);
  u.isUnlocked('rare', 'loop');
  assert.ok(logger.records.some((r) => r.event === 'unlock.check' && r.data.tier === 'rare' && r.data.key === 'loop'), '应有 unlock.check');
  // validateLoadout tier_locked 记 unlock.reject（B4 审查 P2-a）
  const bad = u.validateLoadout({ role: { templateId: 'role_exp_atk' }, skills: [], plugins: [] }, 'common');
  assert.equal(bad.ok, false);
  assert.ok(logger.records.some((x) => x.event === 'unlock.reject' && x.data.where === 'role'), 'tier_locked 记 unlock.reject');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    ul.isUnlocked('common', 'if');
    ul.filterByTier([{ id: 'x' }], 'common');
    ul.validateLoadout({ role: { templateId: 'role_bal' }, skills: [], plugins: [] }, 'common');
    ul.availableNodes('epic');
    ul.tierIndex('mythic');
  });
});