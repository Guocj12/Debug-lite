'use strict';
// 内容数值 v2（D-173）新增机制契约测试：荆棘反伤 / 暴击倍率加成 / 低血加攻 / 注册表 cap 分类
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const engine = require('../../server/core/engine.js');
const items = require('../../server/core/items.js');
const CONFIG = require('../../server/data/battle-config.json');

const BASE = {
  cellPx: 64, fieldPx: 1024, actorHalfPx: 32, minGapPx: 64, movePx: 64, dodgePx: 128,
  collisionDmgMul: 0.8, baseHitMul: 1.0, baseDef: 64, defendDefMul: 1.6,
  dodgeChanceBonus: 0.2, backstab: 1.5, critBonus: CONFIG.critBonus, lowHpThreshold: CONFIG.lowHpThreshold,
  overtimeStart: 48, overtimeRatio: 0.0625, hardCapTick: 64,
  startX: { p1: 224, p2: 800 }, startFacing: { p1: 1, p2: -1 },
  bases: { p1: { hp: 100, maxHp: 100, def: 64 }, p2: { hp: 100, maxHp: 100, def: 64 } },
};
const mkActor = (o) => Object.assign({
  id: 'A', owner: 'p1', atk: 12, def: 8, hp: 100, maxHp: 100, mp: 40, maxMp: 40, sp: 60, maxSp: 60,
  facing: 1, x: 400, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [],
  defending: false, dodging: false,
}, o);
const mkDef = (o) => Object.assign({
  id: 'B', owner: 'p2', atk: 19, def: 9, hp: 100, maxHp: 100, mp: 40, maxMp: 40, sp: 60, maxSp: 60,
  facing: -1, x: 800, regen: { mp: 1, sp: 2 }, special: {}, effects: [], cooldowns: {},
  defending: false, dodging: false,
}, o);
const critNever = () => ({ chance: () => 0 });
const critAlways = () => ({ chance: () => 0.999 });
function mkBattle(p1, p2, logger) {
  return engine.createBattle(BASE, { seed: 11, logger: logger || createLogger(), players: { p1, p2 } });
}

test('CV2-1 荆棘反伤：受击方按 v × 攻击者有效 atk 反弹（真伤、不递归、进帧 damages.kind=thorns）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const b = mkBattle(mkActor(), mkDef({ special: { thorns: 0.5 } }), logger);
  b.state._frameDamages = []; // 引擎在 step 内初始化该缓冲；本用例直接调用 dealDamage → 手工建
  const attackerBefore = b.state.players.p1.hp;
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critNever() });
  // 攻击者 atk 12 → 反弹 round(0.5 × 12) = 6
  assert.equal(r.thorns, 6, '荆棘反弹值 = round(v × atk)');
  assert.equal(b.state.players.p1.hp, attackerBefore - 6, '攻击者掉血');
  assert.equal(b.state.players.p2.hp, 100 - r.dmg, '受击方仍按原伤害掉血');
  const ev = logger.records.find((x) => x.event === 'damage.thorns');
  assert.ok(ev, '应记 damage.thorns');
  assert.equal(ev.channel, 'damage');
  const frame = b.state._frameDamages.find((d) => d.kind === 'thorns');
  assert.ok(frame, '回放帧 damages[] 应含 kind=thorns');
  assert.equal(frame.target, 'p1');
  assert.equal(frame.amount, 6);
});

test('CV2-2 荆棘反伤边界：无词条不触发；闪避/位移免疫时不被反击', () => {
  const b1 = mkBattle(mkActor(), mkDef());
  const r1 = b1.dealDamage(b1.state.players.p1, b1.state.players.p2, { critRng: critNever() });
  assert.equal(r1.thorns, 0, '无 thorns → 0');
  // 受击方必闪：dealDamage 的 dodge 与 crit 共用同一条注入流（生产路径同为 `crit` 派生流的 `chance()`）
  const b2 = mkBattle(mkActor(), mkDef({ special: { thorns: 0.5, dodgeChance: 1 } }));
  const before = b2.state.players.p1.hp;
  const r2 = b2.dealDamage(b2.state.players.p1, b2.state.players.p2, { critRng: critAlways() });
  assert.equal(r2.dodged, true, '受击方必闪');
  assert.ok(!r2.thorns, '未被打中 → 无反击（闪避早退对象无 thorns 字段）');
  assert.equal(b2.state.players.p1.hp, before);
});

test('CV2-3 暴击倍率加成 critMul：倍率 = 1 + critBonus + ΣcritMul（面板与技能词条累加）', () => {
  const b = mkBattle(mkActor({ special: { critChance: 1, critMul: 0.5 } }), mkDef());
  const r = b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critAlways() });
  assert.equal(r.crit, true);
  assert.equal(r.critM, 1 + CONFIG.critBonus + 0.5, '角色面板 critMul 参与');
  const rs = b.dealDamage(b.state.players.p1, b.state.players.p2, { critRng: critAlways(), specials: { critMul: 0.25 } });
  assert.equal(rs.critM, 1 + CONFIG.critBonus + 0.5 + 0.25, '技能词条 critMul 叠加在面板之上');
});

test('CV2-4 低血加攻 lowHpAtk：hp/maxHp < lowHpThreshold 才生效（阈值边界）', () => {
  // 阈值 0.5：60/100 = 0.6 ≥ 0.5 → 不加成
  const hi = mkBattle(mkActor({ hp: 60, maxHp: 100, special: { lowHpAtk: 0.5 } }), mkDef());
  const rHi = hi.dealDamage(hi.state.players.p1, hi.state.players.p2, { critRng: critNever() });
  const base = mkBattle(mkActor({ hp: 60, maxHp: 100 }), mkDef());
  const rBase = base.dealDamage(base.state.players.p1, base.state.players.p2, { critRng: critNever() });
  assert.equal(rHi.dmg, rBase.dmg, '未低于阈值 → 不加成');
  // 49/100 < 0.5 → 加成 50%：raw = 12×1.5=18 → 18×0.816327=14.69 → 14
  const lo = mkBattle(mkActor({ hp: 49, maxHp: 100, special: { lowHpAtk: 0.5 } }), mkDef());
  const rLo = lo.dealDamage(lo.state.players.p1, lo.state.players.p2, { critRng: critNever() });
  assert.equal(rLo.dmg, 14, '低血加攻 50% → 14');
  // 边界：恰好 50/100 不触发（严格小于）
  const edge = mkBattle(mkActor({ hp: 50, maxHp: 100, special: { lowHpAtk: 0.5 } }), mkDef());
  assert.equal(edge.dealDamage(edge.state.players.p1, edge.state.players.p2, { critRng: critNever() }).dmg, 9, '恰好等于阈值不触发');
  // maxHp 缺失 → 不加成（防御分支）
  const noMax = mkBattle(mkActor({ hp: 10, maxHp: 0, special: { lowHpAtk: 0.5 } }), mkDef());
  assert.equal(noMax.dealDamage(noMax.state.players.p1, noMax.state.players.p2, { critRng: critNever() }).dmg, 9, 'maxHp 非正 → 不加成');
});

test('CV2-5 低血加攻三路统一：撞基地伤害同样取有效 atk', () => {
  // p1 贴右边界、低血（20/100）、lowHpAtk 1.0 → 有效 atk = 12×2 = 24
  // 基地 def 64 / defK 40 → 减伤 1 − 64/104 = 0.384615；baseHitMul = 1.0 → floor(24 × 0.384615) = 9
  const mkSide = (special) => engine.createBattle(BASE, {
    seed: 5,
    players: { p1: mkActor({ hp: 20, maxHp: 100, special, x: 992, facing: 1 }), p2: mkDef({ x: 400, facing: 1 }) },
  });
  // 撞基地：停原地 + 有效 atk × baseHitMul × 基地减伤（D-34/D-61）；帧内 damages 在 step 末被清空 → 用基地血量断言
  const withBonus = mkSide({ lowHpAtk: 1.0 });
  withBonus.step({ actions: { p1: 'move_right', p2: 'wait' } });
  assert.equal(withBonus.state.bases.p2.hp, 91, '低血加成后撞基地 = 9（100 → 91）');
  const noBonus = mkSide({});
  noBonus.step({ actions: { p1: 'move_right', p2: 'wait' } });
  assert.equal(noBonus.state.bases.p2.hp, 96, '无加成时撞基地 = 4（100 → 96）');
});

test('CV2-6 注册表 cap 分类：概率类按 caps.probability 封顶，非概率类不封顶', () => {
  const cap = items.applyAffixes({ hp: 10 }, [
    { id: 'dodge_chance', params: { v: 5 } },
    { id: 'crit_chance', params: { v: 5 } },
    { id: 'lifesteal', params: { v: 5 } },
  ]);
  assert.equal(cap.special.dodgeChance, 1, '概率类封顶 1');
  assert.equal(cap.special.critChance, 1);
  assert.equal(cap.special.lifesteal, 1);
  const noCap = items.applyAffixes({ hp: 10 }, [
    { id: 'thorns', params: { v: 0.5 } },
    { id: 'critMul', params: { v: 0.5 } },
    { id: 'lowHpAtk', params: { v: 1.5 } },
  ]);
  assert.equal(noCap.special.thorns, 0.5, '荆棘不封顶');
  assert.equal(noCap.special.critMul, 0.5, '暴击倍率不封顶');
  assert.equal(noCap.special.lowHpAtk, 1.5, '低血加攻不封顶（可累加超过 1）');
});

test('CV2-7 槽位匹配 slotMatches：万能槽 any 收五维、拒特殊；独立槽不收异维', () => {
  for (const s of ['hp', 'atk', 'def', 'sp', 'mp']) assert.equal(items.slotMatches(s, 'any'), true, `${s} → any`);
  assert.equal(items.slotMatches('special', 'any'), false, 'special 不入万能槽');
  assert.equal(items.slotMatches('atk', 'hp'), false, '异维不入独立槽');
  assert.equal(items.slotMatches('special', 'special'), true);
  // 装配路径：万能槽装五维插件成功、装特殊插件被拒
  const wh = items.emptyWarehouse();
  wh.buckets.role.push({ uid: 'r1', kind: 'role', templateId: 'role_bal', quality: 'common', slotCount: 1, slots: [{ type: 'any', pluginUid: null }], stats: { hp: 95, atk: 15, def: 8, sp: 73, mp: 62 }, regen: { mp: 2, sp: 2 }, pluginPoints: 3 });
  wh.buckets.rolePlugin.push({ uid: 'p1', kind: 'rolePlugin', id: 'rp_atk_flat', slot: 'atk', pointCost: 1, affixes: [], equipped: false });
  wh.buckets.rolePlugin.push({ uid: 'p2', kind: 'rolePlugin', id: 'rp_dodge', slot: 'special', pointCost: 2, affixes: [], equipped: false });
  assert.equal(items.assemble(wh, { targetUid: 'r1', pluginUid: 'p1', slotIndex: 0, tier: 'mythic' }).ok, true, '五维插件入万能槽');
  const bad = items.assemble(wh, { targetUid: 'r1', pluginUid: 'p2', slotIndex: 0, tier: 'mythic' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'slot_type_mismatch', '特殊插件不入万能槽');
});
