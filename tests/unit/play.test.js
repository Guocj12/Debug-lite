'use strict';
/* tests/unit/play.test.js —— `npm run play` 离线闭环的**可测部分**契约（2026-09-19 代码级审查补）
 *
 * 背景（审查发现）：`scripts/play.js` 交付时导出 6 个函数（parseArgs/validateArgs/buildPreset/
 *   autoAssemble/cmpSkill/skillTypeScore/labelOf）却**全仓库零引用**——即"有定义无调用的导出"，
 *   而 `npm run play` 只有人工跑过、`npm test` 里没有任何断言。本测试直接消费这些导出，
 *   把"参数校验 / 预设程序可校验 / 装配语义 / 排序确定性"钉进 `npm test`（无需 child_process）。
 *
 * 覆盖（对应审查项 12）：
 *   ① 参数解析与校验（非法输入 → 说明字符串；合法 → null）
 *   ② 三个预设产出的程序都是**合法 AI 程序**（ast.validate 通过），且技能动作名恰为 skill:skillN
 *   ③ 预设技能动作名在 `battle.js` 的真实玩家对象上**真的能解析**（'skill:skill1..3' = p.skills 键）
 *   ④ autoAssemble 语义（槽位类型 / 点数预算 / 唯一性 / 失败跳过并说明）
 *   ⑤ 排序与预设构造的确定性（同输入 → 同输出）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const play = require('../../scripts/play.js');
const ast = require('../../server/ai/ast.js');
const battle = require('../../server/battle.js');
const items = require('../../server/core/items.js');
const { createRng } = require('../../server/core/rng.js');

const ROLE = require('../../server/data/role-templates.json').roleTemplates[0];
const SKILLS = require('../../server/data/skill-templates.json').skillTemplates;
const TIERS = require('../../server/data/qualities.json').qualities.map((q) => q.id);

function mkSkills() {
  // 三个不同模板（避免同模板双槽共享冷却键：那是引擎既有语义，不是本测试目标）
  return [0, 2, 6].map((i, k) => ({ ...items.generateSkillItem(SKILLS[i], 'rare', createRng(100 + k)), slots: [] }));
}
function mkRole() {
  return { ...items.generateRoleItem(ROLE, 'rare', createRng(7)), slots: [] };
}

test('PLAY-1 parseArgs/validateArgs：默认值、覆盖、非法输入全部给说明（退出码 2 路径）', () => {
  const d = play.parseArgs([]);
  assert.equal(d.seed, 20260912, '默认 seed 与黄金战斗同源');
  assert.equal(d.boxes, 12);
  assert.equal(d.tier, 'mythic');
  assert.equal(d.preset, 'steady');
  assert.equal(play.validateArgs(d), null, '默认参数合法');
  const o = play.parseArgs(['--seed', '7', '--boxes', '20', '--preset', 'kite', '--tier', 'epic', '--quality', 'rare', '--out', 'x.json']);
  assert.deepEqual({ seed: o.seed, boxes: o.boxes, preset: o.preset, tier: o.tier, quality: o.quality, out: o.out },
    { seed: 7, boxes: 20, preset: 'kite', tier: 'epic', quality: 'rare', out: 'x.json' });
  assert.equal(play.validateArgs(o), null, '显式参数合法');
  assert.ok(play.parseArgs(['--nope', '1']).bad === '--nope', '未知参数被记录（main 转成退出码 2）');
  // 非法输入：必须给出非空说明（main 打印后 return 2）
  const bads = [
    play.parseArgs(['--seed', '0']),
    play.parseArgs(['--seed', 'x']),
    play.parseArgs(['--boxes', '0']),
    play.parseArgs(['--boxes', '99999']),
    play.parseArgs(['--tier', 'gold']),
    play.parseArgs(['--preset', 'ghost']),
    play.parseArgs(['--quality', 'gold']),
    play.parseArgs(['--out', '   ']),
  ];
  for (const b of bads) {
    const msg = play.validateArgs(b);
    assert.equal(typeof msg, 'string');
    assert.ok(msg.length > 0, `非法参数应有说明：${JSON.stringify(b)}`);
  }
  assert.ok(TIERS.includes(d.tier));
});

test('PLAY-2 buildPreset：三个预设都是合法 AI 程序，技能动作名恰为 skill:skill1..3', () => {
  const slots = mkSkills().map((s, i) => ({ action: `skill:skill${i + 1}`, type: SKILLS[[0, 2, 6][i]].type }));
  for (const preset of ['steady', 'aggressive', 'kite']) {
    const prog = play.buildPreset(preset, slots);
    const v = ast.validate(prog, 'mythic');
    assert.equal(v.ok, true, `${preset} 预设应校验通过：${JSON.stringify(v.errors)}`);
    // 技能动作名必须形如 skill:<sid>，且只能落在出战的三个槽键上（battle.js 的 p.skills 键）
    const names = [...JSON.stringify(prog).matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
    for (const n of names.filter((x) => x.startsWith('skill:'))) {
      assert.match(n, /^skill:skill[123]$/, `${preset}: 技能动作名必须命中出战槽键，实际 ${n}`);
    }
    assert.ok(names.length > 0);
    // 非技能动作必须在引擎白名单内（否则运行期归一化为 wait，等于白写）
    const FIXED = new Set(require('../../server/data/ai-nodes.json').actions.fixed);
    for (const n of names.filter((x) => !x.startsWith('skill:'))) assert.ok(FIXED.has(n), `${preset}: 非技能动作 ${n} 不在引擎动作表`);
  }
});

test('PLAY-3 预设技能动作名在真实玩家对象上可解析（skill1..3 = p.skills 键）', () => {
  const skills = mkSkills();
  const role = mkRole();
  const ld = { role, skills, ai: play.buildPreset('steady', skills.map((s, i) => ({ action: `skill:skill${i + 1}`, type: s.type || SKILLS[[0, 2, 6][i]].type }))) };
  const wh = { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
  const bp = battle.buildPlayer('p1', ld, wh, 'mythic');
  assert.equal(bp.ok, true, JSON.stringify(bp.errors));
  assert.deepEqual(Object.keys(bp.player.skills).sort(), ['skill1', 'skill2', 'skill3'], 'battle.js 以出战槽位为 p.skills 键');
  // 引擎动作归一化的解析口径：key 命中 → 不产生 action.invalid（unknown_skill）
  for (const k of Object.keys(bp.player.skills)) assert.ok(bp.player.skills[k], `槽 ${k} 有技能实例`);
});

test('PLAY-4 autoAssemble：槽位类型匹配 + 点数预算 + 唯一性；失败跳过并说明原因', () => {
  const role = mkRole(); // pluginPoints = 品质点数（rare=4）
  const plug = (uid, slot, pointCost, id) => ({ uid, id: id || `p_${uid}`, kind: 'rolePlugin', slot, pointCost, equipped: false, quality: 'rare', tier: 1 });
  const wh = {
    buckets: {
      role: [{ ...role, slots: [{ type: 'atk', pluginUid: null }, { type: 'hp', pluginUid: null }] }],
      skill: [], skillPlugin: [],
      rolePlugin: [plug('P1', 'atk', 3), plug('P2', 'hp', 3), plug('P3', 'def', 1)],
    },
  };
  const r = play.autoAssemble(wh, 'mythic');
  assert.equal(r.placed.length, 1, '只装得上 1 件（第 2 件超点数预算）');
  assert.equal(r.placed[0].plugin.uid, 'P1');
  assert.ok(r.skipped.length >= 1);
  assert.ok(r.skipped.some((s) => /points_exceeded/.test(s.reason)), `超预算应说明原因，实际：${JSON.stringify(r.skipped.map((s) => s.reason))}`);
  // 入参仓库不被就地修改（纯函数语义：assemble 返回新仓库）
  assert.equal(wh.buckets.role[0].slots[0].pluginUid, null, '原仓库不应被改写');
  assert.equal(wh.buckets.rolePlugin.find((p) => p.uid === 'P1').equipped, false, '原插件不应被置 equipped');
  // 已装（equipped=true）的插件不再被选中
  const wh2 = JSON.parse(JSON.stringify(wh));
  wh2.buckets.rolePlugin.find((p) => p.uid === 'P1').equipped = true;
  const r2 = play.autoAssemble(wh2, 'mythic');
  assert.ok(!r2.placed.some((x) => x.plugin.uid === 'P1'), '已装配插件不得重复选中（唯一性）');
});

test('PLAY-5 排序与预设构造确定性（同输入两次 → 逐值一致）', () => {
  const a = mkSkills(); const b = mkSkills();
  assert.equal(JSON.stringify(a.map(play.skillTypeScore)), JSON.stringify(b.map(play.skillTypeScore)));
  // uid 由模块级序号生成，跨次生成必然不同 → 比较**模板序**（同输入应给出同序）
  assert.equal(a.slice().sort(play.cmpSkill).map((x) => x.templateId).join(','),
    b.slice().sort(play.cmpSkill).map((x) => x.templateId).join(','), '同输入排序稳定');
  assert.deepEqual(a.slice().sort(play.cmpSkill).map((x) => x.templateId),
    a.slice().sort(play.cmpSkill).map((x) => x.templateId), '同一数组重复排序稳定');
  // uid 相同、其余不同 → 排序仍稳定（cmpSkill 兜底比较 uid）
  const slots = [{ action: 'skill:skill1', type: 'melee' }, { action: 'skill:skill2', type: 'straight' }, { action: 'skill:skill3', type: 'displacement' }];
  assert.equal(ast.canonicalize(play.buildPreset('kite', slots)), ast.canonicalize(play.buildPreset('kite', slots)), '预设构造确定性');
  // 风筝预设：位移技能在第 3 槽 → 用位移技拉开距离（而非 move_left）
  const kite = JSON.stringify(play.buildPreset('kite', slots));
  assert.ok(kite.includes('skill:skill3'), '风筝预设应把位移技当逃生手段');
  assert.ok(!/buildPreset|undefined/.test(kite));
  assert.equal(typeof play.labelOf({ uid: 'u1', name: 'n' }), 'string');
});

test('PLAY-6 导出面存在且为函数（防止重构把测试缝拆掉）', () => {
  for (const k of ['parseArgs', 'validateArgs', 'buildPreset', 'autoAssemble', 'cmpSkill', 'skillTypeScore', 'labelOf']) {
    assert.equal(typeof play[k], 'function', `scripts/play.js 应导出 ${k}`);
  }
  assert.equal(path.basename(require.resolve('../../scripts/play.js')), 'play.js');
});
