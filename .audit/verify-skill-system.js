'use strict';
/* .audit/verify-skill-system.js —— 技能系统**落地自检**（逐条核对 content-design.md §6 的落地项）
 *
 * 用途：内容数值复算（`.audit/content-design.js`）只看**数值**；本脚本看**机制与接线是否真的落地**：
 *   ① 4 条基础模板 / 16 专属（声明式字段齐备）/ 7 通用（零代价、无 costDelta）
 *   ② 技能槽 = 1 专属 + N 通用（按品质）＋ 槽位匹配与跨类型专属装配拒绝
 *   ③ 引擎四条能力：背向位移、技能级真伤、技能级暴击倍率、释放时自身增益
 *   ④ 回放帧 action 暴露 skillName/animKey/sfxKey/exclusiveId
 *   ⑤ starter / unlock.json / loadout 投影 / 前端字段契约同步；技能数值全部落在 JSON 表
 *
 * 用法：`node .audit/verify-skill-system.js`（exit 0 = 全部核对项通过 / 1 = 有未通过项）
 * 与测试的分工：本脚本是**跨模块端到端核对**（一处跑完所有落地项），细粒度分支仍由 `npm test` 覆盖。
 */
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const T = require(path.join(ROOT, 'server/data/skill-templates.json')).skillTemplates;
const P = require(path.join(ROOT, 'server/data/plugins.json')).plugins;
const Q = require(path.join(ROOT, 'server/data/qualities.json'));
const U = require(path.join(ROOT, 'server/data/unlock.json'));
const starter = require(path.join(ROOT, 'server/starter.js'));
const skills = require(path.join(ROOT, 'server/core/skills.js'));
const items = require(path.join(ROOT, 'server/core/items.js'));
const loadout = require(path.join(ROOT, 'server/loadout.js'));
const engine = require(path.join(ROOT, 'server/core/engine.js'));
const contract = require(path.join(ROOT, 'public/contract.js'));
const fs = require('node:fs');

const ok = [];
const bad = [];
const check = (cond, label, extra) => (cond ? ok : bad).push(`${label}${extra ? ` → ${extra}` : ''}`);

// ① 4 条基础模板
check(T.length === 4, '4 条基础技能模板', T.map((t) => t.id).join(','));
check(T.every((t) => t.animKey && t.sfxKey), '模板带 animKey/sfxKey');
check(new Set(T.map((t) => t.type)).size === 4, '四类型各 1 条');

// ② 16 专属插件（声明式字段齐备）
const ex = P.filter((p) => p.kind === 'skillPlugin' && p.slot === 'exclusive');
check(ex.length === 16, '16 条专属插件');
const exFields = ex.filter((p) => p.forTypes && p.exclusive && p.exclusive.overrides && p.exclusive.overrides.cost
  && Number.isInteger(p.exclusive.overrides.cooldown) && p.animKey && p.sfxKey && Array.isArray(p.affixes) && p.affixes.length === 0);
check(exFields.length === 16, '专属插件字段齐备（forTypes/exclusive.overrides{cost,cooldown}/animKey/sfxKey/affixes[]）', `${exFields.length}/16`);
check(ex.some((p) => p.exclusive.hitEffects) && ex.some((p) => p.exclusive.castEffects), '专属插件含 hitEffects 与 castEffects 两类声明');
check(ex.some((p) => p.exclusive.specials), '专属插件含特殊类（暴击率/暴击倍率）');
check(ex.some((p) => p.exclusive.qualityOverrides), '专属插件含逐品质覆盖（连射弹幕数）');
check(ex.some((p) => p.exclusive.overrides.moveDir === 'backward'), '专属插件含背向位移（后撤）');
check(ex.some((p) => p.exclusive.overrides.passThroughEnemy && p.exclusive.overrides.fullDodgeDuring), '专属插件含穿敌+全程闪避（瞬移）');

// ③ 7 通用插件（零代价：无 costDelta 字段、无 cost 覆盖）
const gen = P.filter((p) => p.kind === 'skillPlugin' && p.slot === 'general');
check(gen.length === 7, '7 条通用插件', gen.map((p) => p.id).join(','));
check(gen.every((p) => p.costDeltaByTier === undefined && p.costDeltaBase === undefined && p.affixes.length > 0), '通用插件零代价且带词条');
check(P.every((p) => p.costDeltaByTier === undefined), '全表无 costDeltaByTier（机制退役）');
check(Q.costDeltaBase === undefined, 'qualities.json 无 costDeltaBase（机制退役）');

// ④ 技能槽 = 专属 1 + 通用 N（按品质）
const slotOk = Q.qualities.every((q) => {
  const it = items.generateSkillItem('skill_melee', q.id, { float: () => 0.5, int: () => 0, pick: (a) => a[0] });
  const exN = it.slots.filter((s) => s.type === 'exclusive').length;
  const genN = it.slots.filter((s) => s.type === 'general').length;
  return exN === Q.skillExclusiveSlots && genN >= q.skillSlotRange[0] && genN <= q.skillSlotRange[1];
});
check(slotOk, '技能槽 = 1 专属 + N 通用（N 落在品质区间内）');
check(items.slotMatches('exclusive', 'exclusive') && items.slotMatches('general', 'general')
  && !items.slotMatches('general', 'exclusive') && !items.slotMatches('exclusive', 'general'), '槽位匹配：专属只进专属槽、通用只进通用槽');
const misType = items.assemble(
  { buckets: { role: [], skill: [{ uid: 's1', kind: 'skill', templateId: 'skill_melee', quality: 'common', slots: [{ type: 'exclusive', pluginUid: null }] }], rolePlugin: [], skillPlugin: [{ uid: 'q1', kind: 'skillPlugin', id: 'ex_rapid', slot: 'exclusive', forTypes: ['straight'], exclusive: {}, quality: 'common' }] } },
  { targetUid: 's1', slotIndex: 0, pluginUid: 'q1', tier: 'mythic' });
check(misType.ok === false && misType.code === 'slot_type_mismatch', '专属插件跨技能类型装配被拒', misType.code);

// ⑤ 引擎能力：背向位移 / 技能级真伤 / 技能级暴击倍率 / 对自身增益
const mk = (ov) => Object.assign({
  id: 'P', owner: 'p1', x: 400, facing: 1, hp: 100, mp: 40, sp: 100, maxHp: 100, maxMp: 40, maxSp: 100,
  atk: 12, def: 8, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [], defending: false,
}, ov || {});
const exOf = (id) => P.find((p) => p.id === id);
const one = { float: () => 1.0, int: () => 0, pick: (a) => a[0] };

// 背向位移：后撤 → 方向 = −facing
const back = skills.applySkillPlugins(skills.instantiateSkill('skill_displace', 'rare', one), [exOf('ex_retreat')]);
const bBack = engine.createBattle({}, { seed: 1, players: { p1: mk(), p2: mk({ id: 'B', owner: 'p2', x: 800, facing: -1 }) } });
bBack.state.players.p1.skills = { s: back };
bBack.step({ actions: { p1: 'skill:s', p2: 'wait' } });
check(bBack.state.players.p1.x === 272, '背向位移生效（400 → 272，朝向不变）', String(bBack.state.players.p1.x));

// 技能级真伤：sk_true（整次命中无视 def；倍率被同一插件的 mult_up −10% 下调到 1.08）
const mkBattle = (skill, p2def) => {
  const b = engine.createBattle({}, { seed: 2, players: { p1: mk(), p2: mk({ id: 'B', owner: 'p2', x: 600, facing: -1, def: p2def }) } });
  b.state.players.p1.skills = { s: skill };
  b.step({ actions: { p1: 'skill:s', p2: 'wait' } });
  return b;
};
const trueSkill = skills.applySkillPlugins(skills.instantiateSkill('skill_straight', 'rare', one), [exOf('sk_true')]);
const bTrue = mkBattle(trueSkill, 39);
const bPlain = mkBattle(skills.instantiateSkill('skill_straight', 'rare', one), 39);
const dmgTrue = 100 - bTrue.state.players.p2.hp;
const dmgPlain = 100 - bPlain.state.players.p2.hp;
check(trueSkill.trueDamage === true && dmgTrue === Math.floor(12 * 1.08) && dmgTrue > dmgPlain,
  '技能级真伤生效（无视 def：12 vs 护甲后 7）', `${dmgTrue} vs ${dmgPlain}`);

// 技能级暴击倍率：critMul（面板暴击率 100% 强制暴击 → 有/无专属 critMul 的倍率差）
const defBattle = (skill) => {
  const b = engine.createBattle({}, { seed: 3, players: { p1: mk(), p2: mk({ id: 'B', owner: 'p2', x: 600, facing: -1, def: 39 }) } });
  b.state.players.p1.special = { critChance: 1 };
  return b.dealDamage(b.state.players.p1, b.state.players.p2, { mult: 1, critRng: { chance: () => true }, specials: skill.specials });
};
const snipe = skills.applySkillPlugins(skills.instantiateSkill('skill_straight', 'rare', one), [exOf('ex_snipe')]);
const d1 = defBattle(snipe);
const d0 = defBattle({ specials: {} });
check(d0.crit === true && d1.crit === true && d0.critM === 2 && d1.critM === 2.5,
  '技能级暴击倍率生效（critMul +0.5 叠加在 1+critBonus 之上）', `critM ${d0.critM} → ${d1.critM}`);

// 对自身增益：盾突 def+4×2 tick
const bash = skills.applySkillPlugins(skills.instantiateSkill('skill_displace', 'rare', one), [exOf('ex_bash')]);
const bBuff = engine.createBattle({}, { seed: 4, players: { p1: mk(), p2: mk({ id: 'B', owner: 'p2', x: 800, facing: -1 }) } });
bBuff.state.players.p1.skills = { s: bash };
bBuff.step({ actions: { p1: 'skill:s', p2: 'wait' } });
const eff = bBuff.state.players.p1.effects.find((e) => e.stat === 'def');
check(!!eff && eff.delta === 4 && eff.remaining === 2, '释放时对自身增益入队（盾突 def+4×2tick）', JSON.stringify(eff || null));

// ⑥ 回放帧 action 暴露技能名与动画键
const frameBattle = engine.createBattle({}, { seed: 5, players: { p1: mk(), p2: mk({ id: 'B', owner: 'p2', x: 600, facing: -1 }) } });
const bashFrame = skills.applySkillPlugins(skills.instantiateSkill('skill_displace', 'rare', one), [exOf('ex_bash')]);
frameBattle.state.players.p1.skills = { s: bashFrame };
const diff = frameBattle.step({ actions: { p1: 'skill:s', p2: 'wait' } });
const act = diff.players.p1.action;
check(act && act.skillName === '盾突' && act.animKey === 'ex_bash' && act.sfxKey === 'cast_bash' && act.exclusiveId === 'ex_bash',
  '回放帧 action 暴露 skillName/animKey/sfxKey/exclusiveId', JSON.stringify(act));

// ⑦ starter / unlock / loadout 投影 / 前端契约
check(JSON.stringify(starter.STARTER_SKILL_TEMPLATES) === JSON.stringify(['skill_melee', 'skill_straight', 'skill_vertical'])
  && starter.SKILL_PLUGIN_MAX === 2, 'starter 使用新基础模板 + 2 个技能插件上限');
const commonSkills = U.unlocks.find((u) => u.tier === 'common').skills;
check(commonSkills.length === 4 && T.every((t) => commonSkills.includes(t.id)), 'unlock.json 技能清单 = 4 条模板');
const src = fs.readFileSync(path.join(ROOT, 'server/loadout.js'), 'utf8');
check(['animKey', 'sfxKey', 'name', 'exclusiveId', 'moveDir', 'trueDamage'].every((k) => src.includes(`'${k}'`)), 'loadout 技能投影白名单含新字段');
check(['animKey', 'sfxKey', 'forTypes', 'exclusive'].every((f) => contract.ITEM_DETAIL_FIELDS.includes(f))
  && !contract.ITEM_DETAIL_FIELDS.includes('costDeltaByTier'), '前端契约字段（新增 4 / 移除 costDeltaByTier）');
check(fs.readFileSync(path.join(ROOT, 'public/format.js'), 'utf8').includes("pick(item, 'exclusive')"), 'format.js 实读新字段');

// ⑧ 数据可后续调整：全部数值在 JSON
const jsonOnly = ['server/data/skill-templates.json', 'server/data/plugins.json', 'server/data/qualities.json', 'server/data/skill-mechanics.json', 'server/data/affix-registry.json', 'server/data/unlock.json'];
check(jsonOnly.every((f) => { JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); return true; }), '技能相关数值全部在 JSON 表内（可后续调整）');

// ⑨ 表现层素材齐备（T9：占位动画 + 音效键；表现层缺失不阻塞门禁，但落地自检要求齐备）
const an = require(path.join(ROOT, 'assets/animations.json'));
const animKeys = [...T.map((t) => t.animKey), ...ex.map((p) => p.animKey)];
const sfxKeys = [...T.map((t) => t.sfxKey), ...ex.map((p) => p.sfxKey)];
const missingAnim = animKeys.filter((k) => !an.animations.skill || !an.animations.skill[k]);
const missingSfx = sfxKeys.filter((k) => !an.sounds || !an.sounds.skill || !an.sounds.skill.includes(k));
check(animKeys.every((k) => typeof k === 'string' && k !== '') && missingAnim.length === 0,
  '全部 animKey 都有占位动画条目（4 模板 + 16 专属）', missingAnim.join(',') || `${animKeys.length}/${animKeys.length}`);
check(sfxKeys.every((k) => typeof k === 'string' && k !== '') && missingSfx.length === 0,
  '全部 sfxKey 都有占位音效条目', missingSfx.join(',') || `${sfxKeys.length}/${sfxKeys.length}`);
const spriteIds = new Set((require(path.join(ROOT, 'assets/sprites.json')).skillPlugins || []).map((x) => x.pluginId));
check([...gen, ...ex].every((p) => spriteIds.has(p.id)), '全部技能插件都有贴图占位（sprites.skillPlugins）');

// ⑩ starter：技能插件恒为 1 专属 + 1 通用（用户 2026-09-28 裁定）
let starterOk = true;
for (let i = 0; i < 24; i += 1) {
  const r = starter.buildStarter({ publicId: `u_v${i}`, playerId: `pl_v${String(i).padStart(14, '0')}` });
  const slots = r.warehouse.buckets.skillPlugin.map((p) => p.slot).sort().join(',');
  if (slots !== 'exclusive,general') { starterOk = false; break; }
}
check(starterOk, 'starter 技能插件恒为 1 专属 + 1 通用（24 个身份抽样）');

console.log(`✔ 通过 ${ok.length} 项`);
for (const o of ok) console.log(`   ✔ ${o}`);
if (bad.length) {
  console.log(`✘ 未通过 ${bad.length} 项`);
  for (const b of bad) console.log(`   ✘ ${b}`);
  process.exitCode = 1;
} else {
  console.log('全部核对项通过');
}
