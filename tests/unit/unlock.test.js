'use strict';
// B4 core/unlock.js 契约测试 —— 接口见 docs/interfaces.md §1（tierIndex/isUnlocked/filterByTier/validateAi/validateLoadout/availableNodes）
// 依据：examples/09-unlock.md U-1..U-6（全分支）；decisions D-112/D-120；unlock.json 数据
// 归属：tasks.md §6 B4（T-IT-6 + T-UL-1..4）；日志 unlock.check(debug)/unlock.reject(warn)（§4.6）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const ul = require('../../server/core/unlock.js');

const ROLE_TEMPLATES = require('../../server/data/role-templates.json').roleTemplates;
const SKILL_TEMPLATES = require('../../server/data/skill-templates.json').skillTemplates;
const PLUGINS = require('../../server/data/plugins.json').plugins;

test('T-UL-1/U-1 累计与继承：availableNodes（mythic 全集 19；rare 含 if；common 不含 random）', () => {
  const common = ul.availableNodes('common');
  const rare = ul.availableNodes('rare');
  const mythic = ul.availableNodes('mythic');
  assert.ok(common.includes('if'), 'U-1a rare 含 if（继承在 rare 上验证）');
  assert.ok(rare.includes('if'), 'if 属于 common 基础');
  assert.ok(!common.includes('random'), 'U-1b common 不含 random');
  assert.equal(mythic.length, 19, 'U-1c mythic 全集 19（09-unlock §1）');
  for (const n of ['seq', 'literal', 'get', 'bullets', 'var', 'set', 'getVar', 'arith', 'cmp', 'action',
    'if', 'loop', 'while', 'break', 'random', 'logic', 'arith_ext', 'function', 'call']) {
    assert.ok(mythic.includes(n), `mythic 应含 ${n}`);
  }
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

test('T-UL-4/U-4 validateAi：节点门控 + 未知节点结构拒绝（错误带 path）', () => {
  // U-4a：if/cmp/action @ common 通过
  const ok1 = ul.validateAi({ type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'if', cond: { type: 'cmp' }, then: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] }, else: null },
  ] } }, 'common');
  assert.equal(ok1.ok, true, 'U-4a');
  // U-4b：loop @ common 拒绝 node_locked 带 path
  const bad1 = ul.validateAi({ type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'loop', kind: 'count', times: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } },
  ] } }, 'common');
  assert.equal(bad1.ok, false);
  assert.equal(bad1.errors[0].code, 'node_locked');
  assert.ok(bad1.errors[0].path, '错误必须带 path');
  assert.ok(bad1.errors[0].path.startsWith('body'), `path 应从 body 开始: ${bad1.errors[0].path}`);
  // U-4c/d：random @ rare 拒绝 / @ epic 通过
  const progRandom = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'seq', statements: [{ type: 'action', name: 'skill1' }] }, else: null },
  ] } };
  assert.equal(ul.validateAi(progRandom, 'rare').ok, false, 'U-4c');
  assert.equal(ul.validateAi(progRandom, 'epic').ok, true, 'U-4d');
  // U-4e：function/call @ epic 拒绝
  const progFunc = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'function', name: 'f', body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } },
    { type: 'call', name: 'f' },
  ] } };
  assert.equal(ul.validateAi(progFunc, 'epic').ok, false, 'U-4e');
  // U-4f：function 定义但未 call @ mythic 通过（用到了节点即需门控，已满足）
  const progFunc2 = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'function', name: 'f', body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } },
  ] } };
  assert.equal(ul.validateAi(progFunc2, 'mythic').ok, true, 'U-4f');
  // U-4g：未知节点 eval → 结构拒绝（白名单先于门控）
  const progEval = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'eval', value: 'x' }] } };
  const bad2 = ul.validateAi(progEval, 'mythic');
  assert.equal(bad2.ok, false);
  assert.equal(bad2.errors[0].code, 'unknown_node', 'U-4g');
});

test('U-4b2 门控错误细节：detail.node 含节点名', () => {
  const prog = { type: 'program', version: 1, body: { type: 'seq', statements: [
    { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'seq', statements: [{ type: 'action', name: 'skill2' }] } },
  ] } };
  const r = ul.validateAi(prog, 'common');
  assert.equal(r.errors[0].code, 'node_locked');
  assert.equal(r.errors[0].node, 'loop', 'detail.node 应为未解锁节点名');
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
  // U-5d 插件门控：当前数据 29 个插件全部无 unlockTier（UL-7 佐证）→ 任意段位通过；
  // 高段位插件路径（tier_locked）随 B20 引入带 unlockTier 的插件后由 T-PB-7 覆盖
  const badPlugin = ul.validateLoadout({
    role: { templateId: 'role_bal' },
    skills: [],
    plugins: [{ uid: 'p1', id: 'sp_buff' }],
  }, 'common');
  assert.equal(badPlugin.ok, true, 'U-5d（当前数据）: 无 unlockTier 插件不拒绝');
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
  assert.deepEqual([...plugins], ['common'], '插件当前全部已解锁');
});

test('UL-9 健壮性：validateLoadout(null/空) 不抛错（审查 P2-b）；validated 拒绝路径日志', () => {
  assert.doesNotThrow(() => ul.validateLoadout(null, 'common'));
  assert.deepEqual(ul.validateLoadout(null, 'common'), { ok: true, errors: [] });
  assert.deepEqual(ul.validateLoadout(undefined, 'mythic').ok, true);
  // validateAi 缺 body → ai_invalid + unlock.reject 日志
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const u = ul.withLogger(logger);
  const r = u.validateAi({ type: 'program' }, 'mythic');
  assert.equal(r.ok, false);
  assert.equal(r.errors[0].code, 'ai_invalid');
  assert.ok(logger.records.some((x) => x.event === 'unlock.reject' && x.data.node === 'program'), 'ai_invalid 也记 unlock.reject');
  // validateLoadout tier_locked 记 unlock.reject（P2-a）
  const bad = u.validateLoadout({ role: { templateId: 'role_exp_atk' }, skills: [], plugins: [] }, 'common');
  assert.equal(bad.ok, false);
  assert.ok(logger.records.some((x) => x.event === 'unlock.reject' && x.data.where === 'role'), 'tier_locked 记 unlock.reject');
});

test('UL-8 日志：unlock.check(debug) / unlock.reject(warn)（§4.6 事件）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const u = ul.withLogger(logger);
  u.isUnlocked('rare', 'loop');
  assert.ok(logger.records.some((r) => r.event === 'unlock.check' && r.data.tier === 'rare' && r.data.key === 'loop'), '应有 unlock.check');
  const prog = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'loop', kind: 'count', times: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } }] } };
  u.validateAi(prog, 'common');
  assert.ok(logger.records.some((r) => r.event === 'unlock.reject' && r.data.node === 'loop'), '应有 unlock.reject');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    ul.isUnlocked('common', 'if');
    ul.filterByTier([{ id: 'x' }], 'common');
    ul.validateAi(prog, 'mythic');
    ul.validateLoadout({ role: { templateId: 'role_bal' }, skills: [], plugins: [] }, 'common');
    ul.availableNodes('epic');
    ul.tierIndex('mythic');
  });
});