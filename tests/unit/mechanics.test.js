'use strict';
// 机制接线回归测试（2026-09-16 补齐）—— 本文件覆盖"文档/决策已设计但此前未生效"的机制，
// 正是这些机制此前因**没有任何用例覆盖**而漏网（459 用例全绿却玩法失效）。
// 覆盖：
//   ① D-72 fullDodgeDuring 位移全程免疫（①免疫伤害 ②免疫控制 ③不参与弹幕判定）
//   ② 技能插件特殊词条消费：crit_chance / lifesteal / cast_buff（此前为死代码）
//   ③ hp_regen 逐 tick 回复（面板已入 regen.hp，但引擎步骤 10 此前只回 mp/sp）
//   ④ ast 字段枚举校验（logic.op / loop.kind / arith.op 表外取值必须校验期拒绝）
// 依据：decisions D-70/D-72/D-113/D-128；systems/03-skills.md、07-engine.md §4.4、08-ai.md §3；
//   server/data/affix-registry.json、skill-mechanics.json（机制表）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../../server/core/engine.js');
const skills = require('../../server/core/skills.js');
const ast = require('../../server/ai/ast.js');
const CONFIG = require('../../server/data/battle-config.json');

function mkPlayer(overrides) {
  return Object.assign({
    id: 'A', owner: 'p1', x: 224, facing: 1, hp: 100, mp: 40, sp: 60,
    maxHp: 100, maxMp: 40, maxSp: 60, atk: 12, def: 8,
    regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [],
    defending: false, fullDodgeDuring: false, dodging: false,
  }, overrides);
}
function mkBattle(p1, p2, seed) {
  return engine.createBattle(CONFIG, { seed: seed || 7, players: { p1, p2 } });
}
function step(battle, a1, a2) {
  return battle.step({ actions: { p1: a1, p2: a2 } });
}
const critNever = () => ({ chance: () => 0 });
const critAlways = () => ({ chance: () => 0.999 });

// 位移技（可切换 fullDodgeDuring，用于同场景对照）
const dashSkill = (fullDodge) => ({
  sid: 'dash', templateId: 'dash', name: 'dash', type: 'displacement',
  multiplier: 0.8, cost: { hp: 0, mp: 0, sp: 0 }, cooldown: 2, bulletLevel: 2,
  distance: 3, passThroughEnemy: true, dealDamage: false, fullDodgeDuring: fullDodge,
  falloff: 0, affixes: [], specials: {}, castEffects: [],
});
const shootSkill = () => ({
  sid: 'shoot', templateId: 'shoot', name: 'shoot', type: 'straight',
  multiplier: 1.0, cost: { hp: 0, mp: 0, sp: 0 }, cooldown: 1, bulletLevel: 3,
  range: 8, bulletCount: 1, falloff: 0, affixes: [], specials: {}, castEffects: [],
});

// ===== ① D-72 位移全程免疫 =====

test('D-72①③ fullDodgeDuring：位移期间免疫伤害且不参与弹幕判定（同场景对照）', () => {
  const run = (fullDodge) => {
    const p1 = mkPlayer({ x: 224, facing: 1, skills: { dash: dashSkill(fullDodge) } });
    const p2 = mkPlayer({ id: 'B', owner: 'p2', x: 800, facing: -1, atk: 19, def: 9, skills: { shoot: shootSkill() } });
    const b = mkBattle(p1, p2, 21);
    return step(b, 'skill:dash', 'skill:shoot');
  };
  const immune = run(true);
  assert.equal(immune.players.p1.hp, 100, '免疫组：位移全程不掉血（D-72①）');
  assert.equal(immune.bulletHits.filter((h) => h.target === 'p1').length, 0, '免疫组：不参与命中判定（D-72③）');
  const exposed = run(false);
  assert.ok(exposed.players.p1.hp < 100, '对照组：同一场景关闭 fullDodgeDuring 即被命中（证明本用例真的覆盖了命中路径）');
  assert.ok(exposed.bulletHits.some((h) => h.target === 'p1'), '对照组：p1 应被命中');
});

test('D-72② fullDodgeDuring：位移期间免疫控制（stun/击退不入效果队列）', () => {
  const stunAffix = [{ id: 'stun', params: { v: 1 } }];
  // 受击方（p2）处于位移全程免疫（标志为每 tick 瞬时状态，建场后置位）
  const immuneB = mkBattle(mkPlayer(), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  immuneB.state.players.p2.fullDodgeDuring = true;
  immuneB.dealDamage(immuneB.state.players.p1, immuneB.state.players.p2, { critRng: critNever(), affixes: stunAffix });
  assert.equal(immuneB.state.players.p2.effects.length, 0, '免疫组：控制效果未入队');

  const exposedB = mkBattle(mkPlayer(), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  exposedB.dealDamage(exposedB.state.players.p1, exposedB.state.players.p2, { critRng: critNever(), affixes: stunAffix });
  assert.equal(exposedB.state.players.p2.effects.length, 1, '对照组：正常目标被眩晕（同场景对照）');
  assert.equal(exposedB.state.players.p2.effects[0].kind, 'control');
});

test('D-72① fullDodgeDuring：也免疫附加真实伤害（true_dmg 直扣）', () => {
  const b = mkBattle(mkPlayer(), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  b.state.players.p2.fullDodgeDuring = true;
  const before = b.state.players.p2.hp;
  const r1 = b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critNever(), affixes: [{ id: 'true_dmg', params: { v: 5 } }] });
  assert.equal(r1.dmg, 0, '免疫组：主伤害为 0');
  assert.equal(b.state.players.p2.hp, before, '免疫组：附加真实伤害不生效');
  const b2 = mkBattle(mkPlayer(), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  const before2 = b2.state.players.p2.hp;
  const r2 = b2.dealDamage(b2.state.players.p1, b2.state.players.p2, { critRng: critNever(), affixes: [{ id: 'true_dmg', params: { v: 5 } }] });
  assert.equal(b2.state.players.p2.hp, before2 - r2.dmg - 5, '对照组：普通伤害 + 附加直扣 5 生效');
});

// ===== ② 技能插件特殊词条消费 =====

const baseSkill = () => ({
  sid: 's', templateId: 's', name: 's', type: 'straight',
  multiplier: 1, cost: { hp: 0, mp: 0, sp: 0 }, cooldown: 1, bulletLevel: 3,
  range: 8, bulletCount: 1, falloff: 0, affixes: [], specials: {}, castEffects: [],
});
const skillPlugin = (affix) => ({ id: 'p', tier: 1, quality: 'rare', costDeltaByTier: { mp: [2, 4, 6] }, affixes: [affix], kind: 'skillPlugin' });

test('词条注册表：crit_chance / lifesteal 进 skill.specials（此前只登记不消费）', () => {
  const s1 = skills.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'crit_chance', params: { v: 0.1 } })]);
  assert.equal(s1.specials.critChance, 0.1, 'crit_chance → specials.critChance');
  const s2 = skills.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'lifesteal', params: { v: 0.2 } })]);
  assert.equal(s2.specials.lifesteal, 0.2, 'lifesteal → specials.lifesteal');
  // 概率封顶（caps.probability）
  const s3 = skills.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'crit_chance', params: { v: 5 } })]);
  assert.equal(s3.specials.critChance, 1, '概率类封顶 1');
});

test('技能词条 crit_chance：随 payload.specials 进入命中结算并真的触发暴击', () => {
  const s = skills.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'crit_chance', params: { v: 1 } })]);
  const b = mkBattle(mkPlayer(), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  const atk = b.state.players.p1;
  const def = b.state.players.p2;
  const plain = mkBattle(mkPlayer(), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  const noCrit = plain.dealDamage(plain.state.players.p1, plain.state.players.p2, { mult: 1, critRng: critAlways(), specials: {} });
  const withCrit = b.dealDamage(atk, def, { mult: 1, critRng: critAlways(), specials: s.specials });
  assert.equal(noCrit.crit, false, '无词条：critChance=0 → 不暴击（crit 流即使为真也不消费）');
  assert.equal(withCrit.crit, true, '有词条：critChance=1 → 必暴击');
  assert.equal(withCrit.dmg, Math.floor(noCrit.dmg * CONFIG.crit), '暴击倍率来自 battle-config.crit');
});

test('技能词条 lifesteal：命中后按 floor(D×v) 回复攻击者（maxHp 封顶）', () => {
  const s = skills.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'lifesteal', params: { v: 0.5 } })]);
  const b = mkBattle(mkPlayer({ hp: 50 }), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { mult: 1, critRng: critNever(), specials: s.specials });
  assert.equal(r.lifesteal, Math.floor(r.dmg * 0.5), '吸血 = floor(D×0.5)');
  assert.equal(b.state.players.p1.hp, 50 + r.lifesteal, '攻击者回血');
});

test('技能词条 cast_buff：释放后入效果队列，下一 tick 生效（D-70）', () => {
  const s = skills.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'cast_buff', params: { v: 2, duration: 2 } })]);
  assert.equal(s.castEffects.length, 1, 'cast_buff → castEffects');
  assert.deepEqual(s.castEffects[0], { kind: 'continuous', stat: 'atk', delta: 2, remaining: 2 }, '释放效果取自注册表 + params');
  const b = mkBattle(mkPlayer({ atk: 12, skills: { s } }), mkPlayer({ id: 'B', owner: 'p2', x: 800 }), 33);
  step(b, 'skill:s', 'wait');
  assert.equal(b.state.players.p1.effects.length, 1, '释放后入队 1 个持续效果');
  assert.equal(b.state.players.p1.atk, 12, '新效果下一 tick 起效');
  step(b, 'wait', 'wait');
  assert.equal(b.state.players.p1.atk, 14, '第二 tick 生效 atk +2');
});

// ===== ③ hp_regen 逐 tick 回复 =====

test('hp_regen 词条：每 tick 回复 hp（步骤 10），且不在 hp≤0 时复活', () => {
  const b = mkBattle(mkPlayer({ hp: 50, regen: { hp: 1, mp: 1, sp: 2 } }), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  step(b, 'wait', 'wait');
  assert.equal(b.state.players.p1.hp, 51, 'regen.hp=1 → 本 tick +1');
  const b2 = mkBattle(mkPlayer({ hp: 0, regen: { hp: 5, mp: 1, sp: 2 } }), mkPlayer({ id: 'B', owner: 'p2', x: 800 }));
  step(b2, 'wait', 'wait');
  assert.equal(b2.state.players.p1.hp, 0, 'hp≤0 不因 regen 复活（死亡时序统一在步骤 12）');
});

// ===== ⑤ API 路径投影：面板聚合不得丢失词条字段（D5 发现的真实缺陷） =====

test('loadout.buildPanel 投影必须保留 specials/castEffects/affixes 与插件 regen（否则 API 战斗静默丢失机制）', () => {
  const loadoutApi = require('../../server/loadout.js');
  const mkSkill = (i, pluginUid) => ({
    uid: `sk${i}`, kind: 'skill', templateId: i === 0 ? 'skill_straight_precise' : 'skill_melee_whirl', quality: 'common',
    params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 0 }, cooldown: 1, bulletLevel: 3, range: 3, bulletCount: 1, falloff: 0 },
    slots: [{ type: 'special', pluginUid }],
  });
  const role = {
    uid: 'r1', kind: 'role', templateId: 'role_bal', quality: 'common',
    stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
    slots: [{ type: 'special', pluginUid: 'rpRegen' }],
  };
  const AI = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
  const P_REGEN = { uid: 'rpRegen', kind: 'rolePlugin', id: 'rp_regen', slot: 'special', quality: 'common', tier: 1, pointCost: 1, equipped: true, affixes: [{ id: 'hp_regen', params: { v: 1 } }] };
  const P_CRIT = { uid: 'spCrit', kind: 'skillPlugin', id: 'sp_crit', slot: 'special', quality: 'common', tier: 1, equipped: true, costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'crit_chance', params: { v: 0.1 } }] };
  const P_BUFF = { uid: 'spBuff', kind: 'skillPlugin', id: 'sp_buff', slot: 'special', quality: 'common', tier: 1, equipped: true, costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'cast_buff', params: { v: 2, duration: 2 } }] };
  const P_STUN = { uid: 'spStun', kind: 'skillPlugin', id: 'sp_stun', slot: 'special', quality: 'common', tier: 1, equipped: true, costDeltaByTier: { mp: [2, 4, 6] }, affixes: [{ id: 'stun', params: { v: 1 } }] };
  const warehouse = { buckets: { role: [role], skill: [], rolePlugin: [P_REGEN], skillPlugin: [P_CRIT, P_BUFF, P_STUN] } };
  const loadout = { role, skills: [mkSkill(0, 'spCrit'), mkSkill(1, 'spStun'), mkSkill(2, null)], plugins: [P_REGEN, P_CRIT, P_STUN], ai: AI };
  const r = loadoutApi.buildPanel(loadout, { warehouse, tier: 'mythic' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  const p0 = r.panel.skills[0].params;
  assert.equal(p0.specials && p0.specials.critChance, 0.1, 'crit_chance 必须穿过面板投影（经 /battle 才会生效）');
  assert.ok(Array.isArray(p0.affixes), 'affixes 字段必须存在');
  assert.equal(r.panel.role.regen.hp, 1, '角色插件 hp_regen 必须叠加进 panel.regen.hp');
  assert.equal(r.panel.role.regen.sp, 2, '模板 regen 保留');
  // 第二组：cast_buff + stun 必须穿过投影到达技能实例
  const r2 = loadoutApi.buildPanel(
    { role, skills: [mkSkill(0, 'spBuff'), mkSkill(1, 'spStun'), mkSkill(2, null)], plugins: [P_REGEN, P_BUFF, P_STUN], ai: AI },
    { warehouse, tier: 'mythic' },
  );
  const p0b = r2.panel.skills[0].params;
  assert.equal(p0b.castEffects.length, 1, 'cast_buff → castEffects 穿过投影');
  assert.equal(p0b.castEffects[0].stat, 'atk');
  assert.ok(r2.panel.skills[1].params.affixes.some((a) => a.id === 'stun'), '命中类词条必须穿过投影');
});


// ===== ⑥ turn 动作（2026-09-16 决策 C：只能通过 turn 转身） =====

test('turn 动作：翻转朝向、不移动、不消耗；移动不改变朝向（06-field §4.2 / D-50）', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1, sp: 50, regen: { mp: 0, sp: 0 } }), mkPlayer({ id: 'B', owner: 'p2', x: 800, facing: -1 }), 9);
  const spBefore = b.state.players.p1.sp;
  const d1 = step(b, 'turn', 'wait');
  assert.equal(d1.players.p1.facing, -1, 'turn 翻转朝向');
  assert.equal(d1.players.p1.toX, 400, 'turn 不移动');
  assert.equal(b.state.players.p1.sp, spBefore, 'turn 不消耗资源');
  const d2 = step(b, 'move_left', 'wait');
  assert.equal(d2.players.p1.facing, -1, '移动不改变朝向（只能靠 turn 转身）');
  assert.ok(d2.players.p1.toX < 400, '移动本身生效');
  const d3 = step(b, 'turn', 'wait');
  assert.equal(d3.players.p1.facing, 1, '再次 turn 翻回');
});

// ===== ⑦ 函数行动产出定点分析（用户决策：call 算行动，但不得出现空死循环） =====

test('函数行动产出定点分析：只调用"能产出 action"的函数才算，纯检测函数不能填补循环体', () => {
  const P_ = (body) => ({ type: 'program', version: 2, body });
  const act = (n) => ({ type: 'action', name: n });
  const call = (n) => ({ type: 'call', name: n });
  const fn = (name, body) => ({ type: 'function', name, body });
  const loop = (body) => ({ type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body });
  const setN = { type: 'set', name: 'n', value: { type: 'literal', value: 1 } };
  // ① 循环体只调"纯检测"函数（无 action、无产出链）→ 拒绝（正是"空死循环"防护）
  const pure = P_({ type: 'seq', statements: [fn('probe', { type: 'seq', statements: [setN] }), loop({ type: 'seq', statements: [call('probe')] })] });
  const r1 = ast.checkLegality(pure);
  assert.equal(r1.ok, false, '循环体只调纯检测函数 → 拒绝');
  assert.ok(r1.errors.some((e) => e.code === 'branch_without_action'));
  // ② 函数直接含 action → 允许
  const direct = P_({ type: 'seq', statements: [fn('hit', { type: 'seq', statements: [act('move_right')] }), loop({ type: 'seq', statements: [call('hit')] })] });
  assert.equal(ast.checkLegality(direct).ok, true, '函数直接含 action → 允许');
  // ③ 传递产出（f→g，g 含 action）→ 允许
  const transitive = P_({ type: 'seq', statements: [fn('g', { type: 'seq', statements: [act('wait')] }), fn('f', { type: 'seq', statements: [call('g')] }), loop({ type: 'seq', statements: [call('f')] })] });
  assert.equal(ast.checkLegality(transitive).ok, true, '传递产出 action → 允许');
  // ④ 纯检测函数在顶层单独调用 → 允许（纯计算函数合法，只是不能充当行动）
  const topLevel = P_({ type: 'seq', statements: [fn('probe', { type: 'seq', statements: [setN] }), call('probe')] });
  assert.equal(ast.checkLegality(topLevel).ok, true, '顶层调用纯检测函数合法');
});

// ===== ⑧ 解释器兜底分支（覆盖率 & 健壮性） =====

test('applySkillPlugins：缺 specials/castEffects 字段的旧实例也能安全叠加（兜底分支）', () => {
  const bare = { sid: 'b', type: 'straight', multiplier: 1, cost: { hp: 0, mp: 0, sp: 0 }, cooldown: 1, bulletLevel: 1, range: 1, bulletCount: 1, falloff: 0, affixes: [] };
  const out = skills.applySkillPlugins(bare, [skillPlugin({ id: 'crit_chance', params: { v: 0.5 } })]);
  assert.equal(out.specials.critChance, 0.5, '缺字段时安全初始化 specials');
  assert.deepEqual(out.castEffects, [], '缺字段时安全初始化 castEffects');
});

test('instantiateSkill：接受模板对象（非字符串 id）', () => {
  const tpl = require('../../server/data/skill-templates.json').skillTemplates[0];
  const rng = { float: (lo, hi) => (hi === undefined ? 0.5 : (lo + hi) / 2), int: (a) => a, pick: (arr) => arr[0] };
  const s = skills.instantiateSkill(tpl, 'common', rng);
  assert.equal(s.templateId, tpl.id);
  assert.ok(Array.isArray(s.affixes));
});

test('cast_buff 缺 duration → 取注册表 fallbackDuration', () => {
  const s = skills.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'cast_buff', params: { v: 3 } })]);
  assert.equal(s.castEffects[0].remaining, 2, '缺 duration 时用 fallbackDuration=2');
});

test('位移技向左移动：路径弹幕逐格发射（dir<0 分支）', () => {
  const dashLeft = Object.assign(dashSkill(false), { distance: 2, dealDamage: true });
  const p1 = mkPlayer({ x: 500, facing: -1, skills: { dash: dashLeft } });
  const b = mkBattle(p1, mkPlayer({ id: 'B', owner: 'p2', x: 200 }), 5);
  const d = step(b, 'skill:dash', 'wait');
  assert.ok((d.bullets || []).length >= 2, '向左位移仍逐格发射路径弹幕');
});

test('未登记词条 id：warn 并跳过（不静默失效）', () => {
  const logs = [];
  const logger = { warn: (c, e) => logs.push(e), debug() {}, trace() {}, info() {}, error() {} };
  const its = require('../../server/core/items.js').withLogger(logger);
  const r = its.applyAffixes({ atk: 10 }, [{ id: 'not_registered_affix', params: { v: 5 } }]);
  assert.equal(r.stats.atk, 10, '未登记词条不参与聚合');
  assert.ok(logs.includes('items.affix.unknown'), '记 items.affix.unknown(warn)');
});


// ===== ④ ast 字段枚举校验（静默失效防护） =====

const P = (body) => ({ type: 'program', version: 2, body });
const withLogic = (op) => P({
  type: 'seq',
  statements: [
    { type: 'if', cond: { type: 'logic', op, left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 1 } }, then: { type: 'action', name: 'move_right' }, else: { type: 'action', name: 'move_left' } },
    { type: 'action', name: 'wait' },
  ],
});
const withLoop = (node) => P({ type: 'seq', statements: [node, { type: 'action', name: 'wait' }] });

test('ast 枚举：logic.op 只接受 and/or（表外取值必须校验期拒绝，否则运行期恒 false）', () => {
  assert.equal(ast.validate(withLogic('and'), 'mythic').ok, true, 'and 合法');
  assert.equal(ast.validate(withLogic('or'), 'mythic').ok, true, 'or 合法');
  for (const bad of ['&&', '||', 'not', 'xor']) {
    const r = ast.validate(withLogic(bad), 'mythic');
    assert.equal(r.ok, false, `logic.op=${bad} 应被拒绝`);
    assert.ok(r.errors.some((e) => e.code === 'bad_enum'), `logic.op=${bad} 报 bad_enum`);
  }
});

test('ast 枚举：loop.kind 只接受 count/while，且 count 需 times、while 需 cond', () => {
  const count = { type: 'loop', kind: 'count', times: { type: 'literal', value: 2 }, body: { type: 'action', name: 'wait' } };
  const whileNode = { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'action', name: 'wait' } };
  assert.equal(ast.validate(withLoop(count), 'mythic').ok, true, 'count + times 合法');
  assert.equal(ast.validate(withLoop(whileNode), 'mythic').ok, true, 'while + cond 合法');
  const noTimes = { type: 'loop', kind: 'count', body: { type: 'action', name: 'wait' } };
  assert.equal(ast.validate(withLoop(noTimes), 'mythic').ok, false, 'count 缺 times 应拒绝');
  const noCond = { type: 'loop', kind: 'while', body: { type: 'action', name: 'wait' } };
  assert.equal(ast.validate(withLoop(noCond), 'mythic').ok, false, 'while 缺 cond 应拒绝');
  for (const bad of ['forever', 'for', 'until']) {
    const node = { type: 'loop', kind: bad, times: { type: 'literal', value: 1 }, cond: { type: 'literal', value: true }, body: { type: 'action', name: 'wait' } };
    const r = ast.validate(withLoop(node), 'mythic');
    assert.equal(r.ok, false, `loop.kind=${bad} 应被拒绝`);
    assert.ok(r.errors.some((e) => e.code === 'bad_enum'), `loop.kind=${bad} 报 bad_enum`);
  }
});

test('ast 枚举：arith.op 只接受 + - * /（% 未实现，必须拒绝而不是静默 undefined）', () => {
  const arith = (op) => P({
    type: 'seq',
    statements: [
      { type: 'set', name: 'v', value: { type: 'arith', op, left: { type: 'literal', value: 5 }, right: { type: 'literal', value: 2 } } },
      { type: 'action', name: 'wait' },
    ],
  });
  for (const ok of ['+', '-', '*', '/']) assert.equal(ast.validate(arith(ok), 'mythic').ok, true, `${ok} 合法`);
  for (const bad of ['%', '**', '^']) {
    const r = ast.validate(arith(bad), 'mythic');
    assert.equal(r.ok, false, `arith.op=${bad} 应被拒绝`);
    assert.ok(r.errors.some((e) => e.code === 'bad_enum'), `arith.op=${bad} 报 bad_enum`);
  }
});

// ===== ⑨ 解释器防御分支（机制表注入：未登记 pattern/算子、非 Px 字段引用、未登记类型） =====

test('机制表可注入 + 防御分支：未登记 pattern/算子给 warn 并安全退化（不抛、不静默错算）', () => {
  const M0 = require('../../server/data/skill-mechanics.json');
  const R0 = require('../../server/data/affix-registry.json');
  const logs = [];
  const logger = { warn: (c, e) => logs.push(e), debug() {}, trace() {}, info() {}, error() {} };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ① 未登记发射模式 → warn + 空弹幕
  const M1 = clone(M0);
  M1.types.straight.emit.pattern = 'no_such_pattern';
  const sk1 = skills.withTables({ mechanics: M1 }, logger);
  const act1 = sk1.buildSkillAction(baseSkill(), { x: 100, facing: 1 });
  assert.deepEqual(act1.bullets, [], '未知 pattern → 无弹幕');
  assert.ok(logs.includes('skill.emit.unknown'), '记 skill.emit.unknown(warn)');

  // ② 未登记算子 → warn + 技能字段不变
  const R1 = clone(R0);
  R1.affixes.mult_up.skillOp = { op: 'no_such_op', field: 'multiplier' };
  const sk2 = skills.withTables({ registry: R1 }, logger);
  const out2 = sk2.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'mult_up', params: { v: 0.5 } })]);
  assert.equal(out2.multiplier, 1, '未知算子不改写字段');
  assert.ok(logs.includes('skill.plugin.unknown'), '记 skill.plugin.unknown(warn)');

  // ②b 未登记词条 id → warn + 跳过（不抛、不影响其它字段）
  const skDef = skills.withLogger(logger); // 用注入了 logger 的实例（模块单例是 nullLogger，收不到 warn）
  const out2b = skDef.applySkillPlugins(baseSkill(), [skillPlugin({ id: 'not_registered_affix', params: { v: 9 } })]);
  assert.equal(out2b.multiplier, 1, '未登记词条被跳过');
  assert.ok(logs.filter((e) => e === 'skill.plugin.unknown').length >= 2, '未登记词条同样记 warn');

  // ③ 非 Px 字段引用（vFrom 直接取字段值）→ 走 fieldValue 的非 Px 分支
  const M2 = clone(M0);
  M2.types.straight.emit.bullet.vFrom = 'bulletCount';
  M2.types.straight.emit.bullet.lenFrom = 'bulletCount';
  const sk3 = skills.withTables({ mechanics: M2 }, logger);
  const act3 = sk3.buildSkillAction(baseSkill(), { x: 100, facing: 1 });
  assert.equal(act3.bullets[0].v, 1, 'v 直接取字段值（非 Px 分支）');

  // ④ 类型未登记 → 空动作 + 空覆盖格（防御，不抛）
  const M3 = clone(M0);
  delete M3.types.straight;
  const sk4 = skills.withTables({ mechanics: M3 }, logger);
  assert.deepEqual(sk4.buildSkillAction(baseSkill(), { x: 100, facing: 1 }).bullets, []);
  assert.deepEqual(sk4.coveredCellRanges(baseSkill(), { x: 100, facing: 1 }), []);

  // ⑤ 未登记技能类型（实例化路径）→ 抛 RangeError（配置错误应显式失败）
  const itemsApi = require('../../server/core/items.js');
  assert.throws(() => itemsApi.generateSkillItem({ id: 'x', type: 'no_such_type', baseMultiplier: 1, baseCost: { hp: 0, mp: 0, sp: 0 }, cooldown: 1, bulletLevel: 1, slotWeights: { basic: 1 } }, 'common', { float: () => 0.5, int: () => 0, pick: (a) => a[0] }), /未登记技能类型/);
});
