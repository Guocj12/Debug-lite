'use strict';
// B10 结束判定 + 超时 + runFull 契约测试 —— 接口：engine.judge/step/runFull（systems/07-engine.md §4.6/§4.7）
// 依据：decisions D-82（冷却）/D-110（regen）；battle-config overtimeStart 48/overtimeRatio 0.0625/hardCapTick 64/startX 224·800/startFacing ±1
// 归属：tasks.md §6 B10（T-EN-2/3/4 + T-BT-2/4/11）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const engine = require('../../server/core/engine.js');

const CONFIG = {
  cellPx: 64, fieldPx: 1024, actorHalfPx: 32, minGapPx: 64, movePx: 64, dodgePx: 128,
  collisionDmgMul: 0.8, baseHitMul: 1.0, baseDef: 64, defendDefMul: 1.6,
  dodgeChanceBonus: 0.2, backstab: 1.5, crit: 1.5,
  overtimeStart: 48, overtimeRatio: 0.0625, hardCapTick: 64,
  startX: { p1: 224, p2: 800 }, startFacing: { p1: 1, p2: -1 },
  bases: { p1: { hp: 100, maxHp: 100, def: 64 }, p2: { hp: 100, maxHp: 100, def: 64 } },
};

function mk(P) {
  return Object.assign({
    id: P === 'p1' ? 'A' : 'B', owner: P, x: 224, facing: 1, hp: 100, mp: 40, sp: 60,
    maxHp: 100, maxMp: 40, maxSp: 60, atk: 12, def: 8,
    regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [],
  }, P === 'p2' ? { x: 800, facing: -1, atk: 19, def: 9 } : {});
}

function mkBattle(seed, o1, o2) {
  const b = engine.createBattle(CONFIG, { seed: seed || 21, logger: createLogger({ level: 'silent' }), players: { p1: mk('p1'), p2: mk('p2') } });
  if (o1) Object.assign(b.state.players.p1, o1);
  if (o2) Object.assign(b.state.players.p2, o2);
  return b;
}

const waitBoth = { actions: { p1: 'wait', p2: 'wait' } };

test('T-BT-11 超时精确：tick=47 不扣、tick≥48 双方基地与角色同时扣 ceil(maxHp×0.0625)=7', () => {
  const b = mkBattle(31);
  for (let i = 0; i < 47; i++) b.step(waitBoth);
  assert.equal(b.state.tick, 47);
  assert.equal(b.state.players.p1.hp, 100);
  assert.equal(b.state.bases.p2.hp, 100);
  b.step(waitBoth);
  assert.equal(b.state.tick, 48);
  assert.equal(b.state.players.p1.hp, 93, '角色 −7');
  assert.equal(b.state.players.p2.hp, 93);
  assert.equal(b.state.bases.p1.hp, 93, '基地 −7');
  assert.equal(b.state.bases.p2.hp, 93);
  b.step(waitBoth);
  assert.equal(b.state.players.p1.hp, 86, '逐 tick 继续扣');
});

test('T-BT-4/T-EN-3 64 tick 上界：wait-only 双方同死同时 → 平局（基地与角色同归零，基地优先 = base phase）', () => {
  const b = mkBattle(32);
  const r = b.runFull(waitBoth);
  assert.ok(r.ticks <= 64, `64 tick 内结束（实际 ${r.ticks}）`);
  // 100/7≈14.3 → 48 起第 15 tick 归零 = tick 62（角色与基地同 tick 归零 → 基地先判 → base 平局）
  assert.equal(r.ticks, 62, '100−7×14=2 → 第 15 次扣血归零');
  assert.equal(r.winner, 'draw', '双方同 tick 双亡 → 平局');
  assert.equal(b.state.verdict.phase, 'base', '双方基地同 tick 归零 → base 优先');
});

test('T-BT-11b 超时口径修正（2026-09-16，用户拍板 A）：hp180 vs hp100 纯对峙不再"谁强谁先死"', () => {
  // 旧口径：双方基地都被扣「对方角色 maxHp 的份额」——p1 基地 −ceil(180×0.0625)=−12 → 第 9 次归零（tick 56）→ p1 必败；
  // 新口径：基地按**自身 maxHp** 100 扣 7 → 双方基地同 tick 归零 → 平局（角色 maxHp 180 只影响自己角色 −12）。
  const b = mkBattle(31, { hp: 180, maxHp: 180 }, null);
  const r = b.runFull(waitBoth);
  assert.equal(r.ticks, 62, '基地 100 按自身 maxHp 扣 7 → 48+15−1 = 62');
  assert.equal(r.winner, 'draw', '新口径：双方基地同 tick 归零 → base 平局（旧口径 p2 胜 @tick 56）');
  assert.equal(b.state.verdict.phase, 'base');
  assert.equal(b.state.players.p1.hp, 0, 'p1 角色按自身 180 扣 12 → 同样在 62 tick 归零');
});

test('T-BT-2 数值边界（补，审查 P1）：整场全程 x∈[32,992]、hp/mp/sp∈[0,max]、atk/def≥0', () => {
  const b = mkBattle(41);
  const r = b.runFull({ actions: (state) => (state.tick % 3 === 0 ? 'dodge_right' : state.tick % 3 === 1 ? 'move_left' : 'wait') });
  for (const d of r.diffs) {
    for (const owner of ['p1', 'p2']) {
      const p = d.players[owner];
      assert.ok(p.fromX >= 32 && p.fromX <= 992 && p.toX >= 32 && p.toX <= 992, `${owner} toX 越界 @tick ${d.tick}`);
      assert.ok(p.hp >= 0 && p.mp >= 0 && p.sp >= 0, `${owner} 资源非负`);
      assert.ok(p.hp <= 100 && p.mp <= 40 && p.sp <= 60, `${owner} 资源不超上限`);
    }
  }
  assert.ok(r.ticks <= 64, '边界战斗也在上界内结束');
});

test('T-EN-4/T-BT-2 judge 优先级：基地区域先于角色；同级同时 → 平局（phase 区分）', () => {
  const b = mkBattle(33);
  // 基地死 → base 胜（角色还活着）
  b.state.bases.p1.hp = 0;
  assert.deepEqual(b.judge(), { winner: 'p2', phase: 'base' });
  // 双方基地同时 0 + 角色一死 → 基地优先平局
  const b2 = mkBattle(34);
  b2.state.bases.p1.hp = 0;
  b2.state.bases.p2.hp = 0;
  b2.state.players.p2.hp = 0;
  assert.deepEqual(b2.judge(), { winner: 'draw', phase: 'base' }, '基地同时死优先于角色');
  // 角色同时死 → role 平局
  const b3 = mkBattle(35);
  b3.state.players.p1.hp = 0;
  b3.state.players.p2.hp = 0;
  assert.deepEqual(b3.judge(), { winner: 'draw', phase: 'role' });
  // 单方角色死 → p2 胜
  const b4 = mkBattle(36);
  b4.state.players.p1.hp = 0;
  assert.deepEqual(b4.judge(), { winner: 'p2', phase: 'role' });
});

test('T-EN-2 runFull 与逐 tick 回放逐帧一致（同 seed 同 actions：diffs 逐帧 deepEqual）', () => {
  const seq = () => ({ actions: (state) => (state.tick % 2 ? 'move_right' : 'move_left') });
  const full = mkBattle(37).runFull(seq());
  assert.ok(full.diffs && full.diffs.length === full.ticks, 'runFull 返回完整 tick 序列');
  // 逐 tick 回放（同 seed 同 actions 函数 —— 确定性）
  const b2 = mkBattle(37);
  const stepDiffs = [];
  for (let i = 0; i < full.ticks; i++) stepDiffs.push(b2.step(seq()));
  assert.equal(b2.state.tick, full.ticks);
  assert.deepEqual(stepDiffs, full.diffs, 'runFull 与逐 tick 逐帧一致（T-EN-2）');
  assert.deepEqual(stepDiffs.map((d) => d.players), full.diffs.map((d) => d.players));
});

test('BE-5 单方死亡路径：一方角色死 → 另一方继续到基地/超时？——死亡即结束（T-EN-3 死后即判）', () => {
  // 角色 hp≤0 在步骤 12 判定 → 本 tick 结束
  const b = mkBattle(38);
  b.state.players.p1.hp = 1;
  // 持续效果扣死
  b.state.players.p1.effects = [{ uid: 'd1', kind: 'continuous', stat: 'hp', delta: -10, remaining: 1, addedTick: 0 }];
  b.step(waitBoth);
  assert.equal(b.state.verdict.winner, 'p2', '扣死后本 tick 判定 p2 胜');
  assert.equal(b.state.tick, 1);
});

test('BE-6 step 后 judge 状态持久：verdict 缓存 + battle.end 事件', () => {
  const logger = createLogger({ level: 'all', ringSize: 300 });
  const b = engine.createBattle(CONFIG, { seed: 39, logger, players: { p1: mk('p1'), p2: mk('p2') } });
  b.state.players.p1.hp = 1;
  b.state.players.p1.effects = [{ uid: 'd1', kind: 'continuous', stat: 'hp', delta: -10, remaining: 1, addedTick: 0 }];
  b.step(waitBoth);
  assert.ok(logger.records.some((x) => x.event === 'battle.judge'), 'battle.judge 事件');
  assert.ok(logger.records.some((x) => x.event === 'battle.end' && x.data.winner === 'p2'), 'battle.end 带 winner');
  // 战斗结束后继续 step 不崩溃（防御）
  b.step(waitBoth);
  assert.equal(b.state.tick, 2);
});

test('BE-7 超时扣血与角色死亡交叉：角色先死 vs 基地先死（同 tick 扣血）', () => {
  // 48 tick 时角色 hp 余量 < 7 → 角色死、基地 93 存活 → role phase p2 胜
  const b = mkBattle(40);
  b.state.players.p1.hp = 3;
  for (let i = 0; i < 48; i++) b.step(waitBoth);
  assert.equal(b.state.tick, 48);
  assert.equal(b.state.players.p1.hp, 0, '超时扣血杀死角色');
  assert.equal(b.state.bases.p1.hp, 93, '基地同 tick 扣但存活');
  assert.equal(b.state.verdict.winner, 'p2', 'role phase 判定（超时同 tick）');
});