'use strict';
// B9 完整伤害链路契约测试 —— 接口：engine.dealDamage 扩展（systems/07-engine.md §4.4 八步；§4.5 背击）
// 依据：systems/07-engine.md §4.4/§4.5；examples/04-bullets.md P1 9/Q1 12/2.1 的 12·10·7；examples/README §1 基准；
//   decisions D-40..D-46/D-50/D-51/D-72；battle-config backstab 1.5/crit 1.5/dodgeChanceBonus 0.2
// 归属：tasks.md §6 B9（T-EN-5/6/7/8 + T-EF-6 + T-BT-6/7/12/16/18）；日志 damage.calc/dodge/lifesteal + effect.add（§4.6 B9 行）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const { createRng } = require('../../server/core/rng.js');
const engine = require('../../server/core/engine.js');

const CONFIG = {
  cellPx: 64, fieldPx: 1024, actorHalfPx: 32, minGapPx: 64, movePx: 64, dodgePx: 128,
  collisionDmgMul: 0.8, baseHitMul: 1.0, baseDef: 64, defendDefMul: 1.6,
  dodgeChanceBonus: 0.2, backstab: 1.5, crit: 1.5, lifestealCap: 1,
  overtimeStart: 48, overtimeRatio: 0.0625, hardCapTick: 64,
  startX: { p1: 224, p2: 800 }, startFacing: { p1: 1, p2: -1 },
  bases: { p1: { hp: 100, maxHp: 100, def: 64 }, p2: { hp: 100, maxHp: 100, def: 64 } },
};

function mkActor(overrides) {
  return Object.assign({
    id: 'A', owner: 'p1', atk: 12, def: 8, hp: 100, maxHp: 100, maxMp: 40, maxSp: 60,
    mp: 40, sp: 60, facing: 1, x: 400,
    regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [],
    defending: false, dodging: false,
  }, overrides);
}
function mkDef(overrides) {
  return Object.assign({
    id: 'B', owner: 'p2', atk: 19, def: 9, hp: 100, maxHp: 100, mp: 40, maxMp: 40, sp: 60, maxSp: 60,
    regen: { mp: 1, sp: 2 }, facing: -1, x: 800, special: {}, effects: [], cooldowns: {},
    defending: false, dodging: false,
  }, overrides);
}

function mkBattle(p1, p2, seed) {
  const logger = createLogger({ level: 'all', ringSize: 1000 });
  const b = engine.createBattle(CONFIG, { seed: seed || 11, logger, players: { p1, p2 } });
  return { b, logger };
}

// 固定 crit 流：chance 固定返回给定值
const critStream = (v) => ({ chance: () => v });
const critNever = () => ({ chance: () => 0 });
const critAlways = () => ({ chance: () => 0.999 });

test('DM-1 T-EN-5 回归：无闪避/无背击/无暴击 → 基础伤害同 B8（12×1.0×0.816327=9）', () => {
  const { b } = mkBattle(mkActor(), mkDef());
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critNever() });
  assert.equal(r.dmg, 9);
  assert.ok(Math.abs(r.reduction - 0.816327) < 1e-5, 'B def9 减伤 0.816327');
  assert.equal(b.state.players.p2.hp, 91);
});

test('T-EN-7 闪避：dodgeChance 判定（必闪/必中）+ damage.dodge 事件', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const b = engine.createBattle(CONFIG, { seed: 12, logger, players: { p1: mkActor(), p2: mkDef({ special: { dodgeChance: 1 } }) } });
  const r1 = b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critAlways() });
  assert.equal(r1.dodged, true, '必闪');
  assert.equal(b.state.players.p2.hp, 100, '闪避无伤');
  assert.ok(logger.records.some((x) => x.event === 'damage.dodge'), 'damage.dodge 事件');
  const b2 = engine.createBattle(CONFIG, { seed: 13, logger, players: { p1: mkActor(), p2: mkDef({ special: { dodgeChance: 0 } }) } });
  const r2 = b2.dealDamage(b2.state.players.p1, b2.state.players.p2, { critRng: critNever() });
  assert.equal(r2.dodged, false);
  assert.equal(b2.state.players.p2.hp, 91);
});

test('T-EN-8 闪避叠加：dodge 行动 + dodgeChanceBonus 0.2（引擎 dodging 标记）', () => {
  const { b } = mkBattle(mkActor(), mkDef({ special: { dodgeChance: 0.3 } }));
  b.state.players.p2.dodging = true; // 引擎步骤 4 标记（dodge 行动）
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critNever() });
  assert.ok(Math.abs(r.dodgeChanceTotal - 0.5) < 1e-9, `总闪避 0.3+0.2=0.5（实际 ${r.dodgeChanceTotal}）`);
});

test('DM-3 背击 ×1.5（D-42/D-50/D-51）', () => {
  const { b } = mkBattle(mkActor(), mkDef());
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { backstab: true, critRng: critNever() });
  assert.equal(r.dmg, 14, '9×1.5=13.5→13？——复算：12×(1−9/49)=9.796；×1.5=14.693→14');
  assert.equal(r.backstab, true);
});

test('T-BT-6 背击×暴击 = ×2.25（D-42）', () => {
  const { b } = mkBattle(mkActor({ special: { critChance: 1 } }), mkDef());
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { backstab: true, critRng: critAlways() });
  assert.equal(r.crit, true);
  assert.equal(r.dmg, 22, '9×2.25=20.25→20？——12×0.816327=9.796；×2.25=22.041→22');
});

test('DM-5 真实伤害：不吃护甲（max(1, floor(atk×mult))）', () => {
  const { b } = mkBattle(mkActor(), mkDef());
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { trueDamage: true, mult: 1.3, critRng: critNever() });
  assert.equal(r.dmg, 15, '12×1.3=15.6→15（无减伤）');
  assert.equal(r.trueDamage, true);
});

test('T-EN-8 吸血：floor(D×lifesteal)，maxHp 封顶，不作用于基地（D-44）', () => {
  const { b } = mkBattle(mkActor({ hp: 50, special: { lifesteal: 0.5 } }), mkDef());
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critNever() });
  assert.equal(r.lifesteal, 4, 'floor(9×0.5)=4');
  assert.equal(b.state.players.p1.hp, 54, '吸血回 hp');
  // 封顶
  const { b: b2 } = mkBattle(mkActor({ hp: 98, special: { lifesteal: 0.5 } }), mkDef());
  b2.dealDamage(b2.state.players.p1, b2.state.players.p2, { critRng: critNever() });
  assert.equal(b2.state.players.p1.hp, 100, 'maxHp 封顶');
});

test('DM-7 damage.calc 记录每步中间值（mult/减伤/背击/暴击/吸血）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const b = engine.createBattle(CONFIG, { seed: 14, logger, players: { p1: mkActor({ special: { critChance: 1 } }), p2: mkDef() } });
  b.dealDamage(b.state.players.p1, b.state.players.p2, { backstab: true, critRng: critAlways() });
  const calc = logger.records.find((x) => x.event === 'damage.calc');
  assert.ok(calc, '应有 damage.calc');
  assert.equal(calc.data.critM, 1.5);
  assert.equal(calc.data.backM, 1.5);
  assert.ok(typeof calc.data.reduction === 'number');
  assert.ok(typeof calc.data.raw === 'number');
});

test('DM-8 附加效果：stun/knockback/pull/dot → effects.addEffect（伤害生效后添加，§4.4 步骤 9）', () => {
  const { b } = mkBattle(mkActor(), mkDef());
  const p2 = b.state.players.p2;
  const r = b.dealDamage(b.state.players.p1, p2, {
    critRng: critNever(),
    affixes: [
      { id: 'stun', params: { v: 1 } },
      { id: 'knockback', params: { v: 1 } },
      { id: 'dot', params: { v: 3 } },
    ],
  });
  assert.equal(p2.effects.length, 3, '三个附加效果入列');
  const stun = p2.effects.find((e) => e.kind === 'control' && e.displacement === 0);
  assert.ok(stun, 'stun → control 0');
  const kb = p2.effects.find((e) => e.kind === 'control' && e.displacement > 0);
  assert.ok(kb, 'knockback → control +1 格');
  const dot = p2.effects.find((e) => e.kind === 'continuous' && e.stat === 'hp' && e.delta < 0);
  assert.ok(dot, 'dot → continuous hp −3');
  assert.equal(r.dmg, 9, '附加效果不影响伤害数值');
});

test('T-BT-18/Q1 AOE 基准复算（完整链路）：重击 12、falloff 0.8 → 10、0.6 → 7', () => {
  const q1 = (falloff, distCells) => {
    const { b } = mkBattle(mkActor({ atk: 12 }), mkDef({ hp: 100 }));
    b.dealDamage(b.state.players.p1, b.state.players.p2, { mult: 1.3 * falloff, critRng: critNever() });
    return b.state.players.p2.hp;
  };
  assert.equal(q1(1.0, 0), 88, 'Q1 12×1.3×0.816327=12.735→12');
  assert.equal(q1(0.8, 1), 90, 'falloff 0.8 → 10.188→10');
  assert.equal(q1(0.6, 2), 93, 'falloff 0.6 → 7.641→7');
});

test('T-BT-7 防御单调：def 越高伤害越低（0 → 满伤；递增）', () => {
  const dmgAt = (def) => {
    const { b } = mkBattle(mkActor({ atk: 100 }), mkDef({ def }));
    b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critNever() });
    return 100 - b.state.players.p2.hp; // 受伤量
  };
  const d0 = dmgAt(0);
  const d40 = dmgAt(40);
  const d200 = dmgAt(200);
  assert.equal(d0, 100, 'def 0 → 满伤 100');
  assert.ok(d40 > 0 && d200 > 0, '有减伤');
  assert.ok(d40 < d0 && d200 < d40, '单调递减（受伤量随 def 下降）');
});

test('DM-11 引擎集成：技能命中走完整链路（暴击流 per tick）', () => {
  const { b } = mkBattle(mkActor({ x: 400 }), mkDef({ x: 800, hp: 100 }));
  b.state.players.p1.skills = { precise: preciseSkill() };
  const diff = b.step({ actions: { p1: 'skill:precise', p2: 'wait' } });
  // crit 流 chance 0 → 无暴击 → 9 伤
  assert.equal(b.state.players.p2.hp, 91, '暴击流 0 → 9');
  assert.ok(diff.tick === 1);
});

function preciseSkill() {
  const skills = require('../../server/core/skills.js');
  const sk = skills.instantiateSkill('skill_straight_precise', 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 });
  sk.multiplier = 1.0;
  return sk;
}

test('DM-13 附加效果补全（审查 P2-a/b）：pull 拉近、true_dmg 直扣 + 日志', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const b = engine.createBattle(CONFIG, { seed: 15, logger, players: { p1: mkActor(), p2: mkDef() } });
  const p2 = b.state.players.p2;
  b.dealDamage(b.state.players.p1, p2, {
    critRng: critNever(),
    sourceDir: 1,
    affixes: [
      { id: 'pull', params: { v: 1 } },
      { id: 'true_dmg', params: { v: 5 } },
    ],
  });
  const pull = p2.effects.find((e) => e.kind === 'control' && e.displacement < 0);
  assert.ok(pull, 'pull → control −1 格（朝向攻方）');
  assert.equal(pull.displacement, -1, 'sourceDir=1 → −1');
  // true_dmg：直扣 5 + damage.calc 记录
  assert.equal(p2.hp, 86, '9 常规 + 5 真实 = 14 扣血');
  const calc = logger.records.filter((x) => x.event === 'damage.calc');
  assert.ok(calc.some((x) => x.data.trueDamage === true), 'true_dmg 也记 damage.calc');
});

test('DM-12 背击判定（引擎层 §4.5，追尾语义拍板）：近战/位移攻方身后；平射追尾；垂直永不', () => {
  const { b } = mkBattle(mkActor({ x: 536, facing: 1 }), mkDef({ x: 600, facing: 1 }));
  // B facing +1（朝右）；A 在 B 左侧 → A 对 B 背击 ✓；A 在 B 右侧 → 不是
  assert.equal(b.isBackstab({ attackerX: 536, attackerFacing: 1 }, { x: 600, facing: 1 }, 'melee'), true, 'A 在 B 身后（B 朝右）→ 背击');
  assert.equal(b.isBackstab({ attackerX: 664, attackerFacing: -1 }, { x: 600, facing: 1 }, 'melee'), false, 'A 在 B 面前 → 非背击');
  // 平射：追尾（方向与朝向相同）才背击；迎面（P1）不背击
  assert.equal(b.isBackstab({ attackerX: 400 }, { x: 600, facing: -1 }, 'straight', 1), false, '迎面弹幕右行 vs B 朝左 → 非背击（04-bullets P1 保持 9）');
  assert.equal(b.isBackstab({ attackerX: 400 }, { x: 600, facing: 1 }, 'straight', 1), true, '追尾（同向）→ 背击');
  assert.equal(b.isBackstab({ attackerX: 400 }, { x: 600, facing: -1 }, 'straight', -1), true, '追尾（反向对称）');
  // 位移路径弹幕：追尾（位移方向与朝向相同）背击；迎面（M4/M5）不背击
  assert.equal(b.isBackstab({ attackerX: 656 }, { x: 500, facing: -1 }, 'displacement', 1), false, 'M4 迎面位移 → 非背击（保持 12）');
  assert.equal(b.isBackstab({ attackerX: 400 }, { x: 500, facing: 1 }, 'displacement', 1), true, '追尾位移 → 背击');
  // 近战 AOE：按攻方本体身后
  assert.equal(b.isBackstab({ attackerX: 656 }, { x: 500, facing: -1 }, 'melee', 0), true, '近战 A 在 B 身后 → 背击');
  // 垂直永不
  assert.equal(b.isBackstab({ attackerX: 400 }, { x: 600, facing: -1 }, 'vertical'), false, '垂直永不背击');
});