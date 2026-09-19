'use strict';
/* tests/unit/skills-cooldown-slot.test.js —— P1-4：冷却键 = **槽位键**（skill1..3）而非模板 id
 *
 * 裁定（2026-09-19，用户口径"3 个技能槽各自可用性"）：冷却**按槽位**独立；同一模板装两个槽时两槽 CD 互不影响。
 * 修前：`canCast` 以 `skill.sid`（= templateId）为冷却键，而 `server/battle.js` 的技能槽键是 `skill1..3`
 *      → 默认出战配置（`ranked.PRESET_SKILL_ORDER` 故意重复同一模板）的两槽**共享冷却**（实测 cooldown×41）。
 * 契约：`skills.canCast(skill, caster, cooldownKey?)`；缺省第三参回落 `skill.sid || skill.templateId`（旧调用口径不变）。
 * 相关：`docs/systems/08-ai.md` §4.5 的 `self.cooldowns.<slotKey>` 字段说明（需同步，见交付报告）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const skillsMod = require('../../server/core/skills.js');
const engine = require('../../server/core/engine.js');
const battleApi = require('../../server/battle.js');
const runner = require('../../server/runner.js');
const { createLogger } = require('../../shared/log.js');
const LD = require('../fixtures/loadout-ok.json');

const STUB = { float: () => 1, int: () => 0, pick: () => 0 };
const TPL = 'skill_straight_precise';

function skillOf(overrides) {
  return Object.assign(skillsMod.instantiateSkill(TPL, 'common', STUB), { cooldown: 3, cost: { hp: 0, mp: 0, sp: 0 } }, overrides || {});
}
const casterOf = () => ({ hp: 100, mp: 40, sp: 60, cooldowns: {} });

test('CD-S1 纯函数 A/B：2 参（模板键，旧口径）两槽共享 CD；3 参（槽位键）两槽独立', () => {
  const sk = skillOf();
  // 旧口径（缺省第三参 → 模板 id）：第二次释放被第一次的 CD 挡住
  const a1 = skillsMod.canCast(sk, casterOf());
  assert.equal(a1.ok, true);
  assert.deepEqual(Object.keys(a1.caster.cooldowns), [TPL], '缺省冷却键 = 模板 id（旧调用点零回归）');
  const a2 = skillsMod.canCast(sk, a1.caster);
  assert.equal(a2.ok, false);
  assert.equal(a2.reason, 'cooldown', '同模板 → 共享 CD（修前语义）');
  // 新口径（槽位键）：另一个槽不受影响
  const b1 = skillsMod.canCast(sk, casterOf(), 'skill1');
  assert.equal(b1.ok, true);
  assert.deepEqual(Object.keys(b1.caster.cooldowns), ['skill1'], '冷却键 = 槽位键');
  const b2 = skillsMod.canCast(sk, b1.caster, 'skill2');
  assert.equal(b2.ok, true, '同模板的另一槽不受 slot1 冷却影响');
  assert.deepEqual(Object.keys(b2.caster.cooldowns).sort(), ['skill1', 'skill2']);
  // 同槽复放仍被挡（按槽位冷却不是取消冷却）
  const b3 = skillsMod.canCast(sk, b2.caster, 'skill1');
  assert.equal(b3.ok, false);
  assert.equal(b3.reason, 'cooldown');
});

test('CD-S2 旧快照/旧帧的 cooldowns 键读不到 → 视作 0（缺键不抛错、不误判冷却）', () => {
  const legacyCaster = { hp: 100, mp: 40, sp: 60, cooldowns: { [TPL]: 9 } }; // 旧口径留下的模板键
  const r = skillsMod.canCast(skillOf(), legacyCaster, 'skill1');
  assert.equal(r.ok, true, '旧键（模板 id）不阻塞新键（槽位）');
  assert.equal(r.caster.cooldowns[TPL], 9, '旧键原样保留（不做破坏性迁移）');
  assert.equal(r.caster.cooldowns.skill1, 3);
});

test('CD-S3 引擎逐 tick：同模板双槽交替释放 → 每 tick 都成功（修前 62 tick 内 cooldown×41）', () => {
  const evBuf = [];
  const mk = (owner, x, facing) => ({
    id: owner, owner, x, facing,
    hp: 100, maxHp: 100, mp: 40, maxMp: 40, sp: 60, maxSp: 60,
    atk: 12, def: 8, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [],
    skills: { skill1: skillOf({ cooldown: 3 }), skill2: skillOf({ cooldown: 3 }), skill3: skillOf({ cooldown: 3 }) },
  });
  const b = engine.createBattle(undefined, {
    seed: 99, players: { p1: mk('p1', 224, 1), p2: mk('p2', 800, -1) },
    logger: createLogger({ level: 'all', ringSize: 20000, now: () => 0, onRecord: (r) => evBuf.push(r) }),
  });
  const seen = [];
  const res = b.runFull({
    actions: {
      p1: (st) => { const raw = st.tick % 2 === 1 ? 'skill:skill1' : 'skill:skill2'; seen.push({ tick: st.tick, raw }); return raw; },
      p2: () => 'wait',
    },
    eventsBuf: evBuf,
  });
  const casts = evBuf.filter((r) => r.event === 'skill.cast');
  const cdRejects = evBuf.filter((r) => r.event === 'skill.reject' && r.data.reason === 'cooldown');
  // 前 2 tick 必须都成（修前 tick2 的 skill:skill2 被 slot1 的模板键 CD 挡住）
  assert.deepEqual(seen.slice(0, 2).map((x) => x.raw), ['skill:skill1', 'skill:skill2']);
  assert.equal(cdRejects.filter((r) => r.tick <= 2).length, 0, '前 2 tick 不得有 cooldown 拒绝（第 2 槽独立）');
  assert.deepEqual([...new Set(casts.map((r) => r.data.slot))].sort(), ['skill1', 'skill2'], 'cast 事件的 slot = 槽位键');
  assert.equal(casts.length, 32, `cd=3 交替双槽 → 62 tick 内 32 次成功（修前 21）`);
  assert.equal(cdRejects.length, 30, `每槽各按自身 CD=3 节流（修前 41 次 = 两槽互相挤占）`);
  assert.equal(casts.length + cdRejects.length, res.ticks, '成功 + 冷却拒绝 = tick 数（每 tick 一个动作）');
});

test('CD-S4 槽位键与 AI 快照同源：battle.buildPlayer 的 p.skills 键即冷却键；快照 cooldowns 用槽位键', () => {
  const ld = JSON.parse(JSON.stringify(LD.loadout));
  ld.skills[1].templateId = ld.skills[0].templateId; // 同一模板装两槽（默认出战配置的形态）
  ld.skills[1].quality = ld.skills[0].quality;
  const built = battleApi.buildPlayer('p1', ld, LD.warehouse, 'mythic');
  assert.equal(built.ok, true, JSON.stringify(built.errors || []).slice(0, 200));
  assert.deepEqual(Object.keys(built.player.skills), ['skill1', 'skill2', 'skill3'], '槽位键 skill1..3');
  const sk = built.player.skills.skill1;
  const r = skillsMod.canCast(sk, built.player, 'skill1');
  assert.equal(r.ok, true);
  built.player.cooldowns = r.caster.cooldowns;
  const snap = runner.projectSnapshot({ tick: 1, players: { p1: built.player, p2: built.player }, bases: { p1: {}, p2: {} } }, 'p1');
  // 快照逐键拷贝引擎 cooldowns → 键语义与引擎一致（= 槽位键）
  assert.equal(typeof snap.self.cooldowns.skill1, 'number', 'AI 快照 cooldowns 键 = 槽位键');
  assert.equal(snap.self.cooldowns[sk.templateId], undefined, '不再以模板 id 为键');
  require('../../server/ai/runtime.js').destroyContext(built.ctx);
});
