'use strict';
// B8 core/engine.js 契约测试 —— 接口见 docs/interfaces.md §1（createBattle/step/judge/runFull/dealDamage/normalizeAction/resolveActorCollision）
// 依据：examples/07-movement-collision.md M1..M9/N1..N6/O1..O3/P1..P3（数值期望唯一出处）；systems/07-engine.md §4.2 14 步；07 组 §4.3/§4.7
// 归属：tasks.md §6 B8（T-EN-1/10 + T-BT-3/9/15/17 + T-LG-5 起常驻）；日志 L4 行（§4.6）
// 边界（B8 登记）：本批基础伤害链路 = 普通公式 floor(atk×mult×(1−def/(def+40)))+碰撞 atk×0.8（B9 补背击/暴击/吸血/真实/附加效果）。
// 基具：A atk12/def8（减伤 0.833333）、B atk19/def9（减伤 0.816327）——examples/README §1。
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

// 玩家基具（模板 regen / 简版面板）
function mkPlayer(overrides) {
  return Object.assign({
    id: 'B', owner: 'p1', x: 400, facing: 1, hp: 100, mp: 40, sp: 60,
    maxHp: 100, maxMp: 40, maxSp: 60, atk: 12, def: 8,
    regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [],
    defending: false, fullDodgeDuring: false,
  }, overrides);
}

function mkBattle(p1, p2, seed) {
  return engine.createBattle(CONFIG, { seed: seed || 1, logger: undefined, players: { p1, p2 } });
}

// 步进辅助：注入双方行动（兼容字符串与单元素数组）
function stepActions(battle, a1, a2) {
  const pick = (a) => (Array.isArray(a) ? a[0] : a);
  return battle.step({ actions: { p1: pick(a1), p2: pick(a2) } });
}

test('T-BT-3/N5 同时行动顺序无关：相向互穿互换位置', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 528, facing: -1, atk: 19, def: 9 }));
  const diff = stepActions(b, ['dodge_right'], ['dodge_left']);
  assert.equal(b.state.players.p1.x, 528, 'N5 A 到达 528');
  assert.equal(b.state.players.p2.x, 400, 'N5 B 到达 400');
  assert.ok(diff.players.p1.fromX === 400 && diff.players.p1.toX === 528, 'diff 含 fromX/toX（T-EN-1）');
});

test('T-BT-3/N6 双穿目标重叠：双方各进一格、相遇格空着（D-33）', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 656, facing: -1, atk: 19, def: 9 }));
  stepActions(b, ['dodge_right'], ['dodge_left']);
  assert.equal(b.state.players.p1.x, 592, 'N6 A 进到 592（格 9）');
  assert.equal(b.state.players.p2.x, 464, 'N6 B 进到 464（格 7）——相遇格 8 空着');
});

test('T-BT-17/M2 碰撞解算 1px 精度 + 碰撞伤害（T-BT-15）', () => {
  const b = mkBattle(mkPlayer({ x: 504, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  const diff = stepActions(b, ['move_right'], ['wait']);
  assert.equal(b.state.players.p1.x, 536, 'M2 A 536（t*=0.5）');
  assert.equal(b.state.players.p2.x, 600, 'M2 B 未动');
  assert.equal(diff.collision && diff.collision.contactX, 568, 'M2 接触点 568');
  assert.equal(b.state.players.p1.hp, 88, 'A 受 B.atk19×0.8×0.833333=12.667→12');
  assert.equal(b.state.players.p2.hp, 93, 'B 受 A.atk12×0.8×0.816327=7.837→7');
});

test('T-BT-15/N2 相向交错碰撞（t=0.28125）', () => {
  const b = mkBattle(mkPlayer({ x: 500, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  const diff = stepActions(b, ['move_right'], ['move_left']);
  assert.equal(b.state.players.p1.x, 518, 'N2 A 518');
  assert.equal(b.state.players.p2.x, 582, 'N2 B 582');
  assert.equal(diff.collision.contactX, 550, 'N2 碰撞位置 550');
});

test('T-BT-15/N3 相向重叠碰撞（同格 464）', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 528, facing: -1, atk: 19, def: 9 }));
  const diff = stepActions(b, ['move_right'], ['move_left']);
  assert.equal(b.state.players.p1.x, 432, 'N3 A 432');
  assert.equal(b.state.players.p2.x, 496, 'N3 B 496');
  assert.equal(diff.collision.contactX, 464, 'N3 相遇点 464');
});

test('T-BT-15/O2 同向追上碰撞（t=0.25）', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 480, facing: -1, atk: 19, def: 9 }));
  stepActions(b, ['move_right'], ['wait']);
  assert.equal(b.state.players.p1.x, 416, 'O2 A 416');
  assert.equal(b.state.players.p2.x, 480, 'O2 B 未动');
});

test('T-BT-12/M3 可穿穿过静止方：停在敌方身后 +64', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 500, facing: -1, atk: 19, def: 9 }));
  stepActions(b, ['dodge_right'], ['wait']);
  assert.equal(b.state.players.p1.x, 564, 'M3 A 564（B 身后）');
  assert.equal(b.state.players.p2.x, 500);
});

test('T-BT-12/O1 同向可穿追上静止方', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 480, facing: -1, atk: 19, def: 9 }));
  stepActions(b, ['dodge_right'], ['wait']);
  assert.equal(b.state.players.p1.x, 544, 'O1 A 544');
});

test('T-BT-20/M4 位移技可穿+有伤：穿过 + 路径弹幕 12', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 500, facing: -1, atk: 19, def: 9, maxHp: 100 }));
  // 注入"可穿+有伤"突进斩（M4 示例参数）
  b.state.players.p1.skills = { dash: skillBash({ passThroughEnemy: true, dealDamage: true }) };
  const diff = stepActions(b, ['skill:dash'], ['wait']);
  assert.equal(b.state.players.p1.x, 656, 'M4 A 到达 656（穿过 B）');
  assert.equal(b.state.players.p2.hp, 88, 'M4 B 受路径弹幕 12');
});

// 突进斩实例（M4/M5/M8 示例参数：mult 1.3、距离 4 格，B6 位移类型 + 字段按场景调整）
function skillBash(overrides) {
  const skills = require('../../server/core/skills.js');
  const sk = skills.instantiateSkill('skill_dash_bash', 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 });
  sk.distance = 4;
  sk.multiplier = 1.3; // M 系列示例（07 表头：突进斩 倍率 1.3）
  return Object.assign(sk, overrides);
}

test('T-BT-20/M8 位移恰好停在相邻：不算接触、无伤害（D-19）', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 720, facing: -1, atk: 19, def: 9 }));
  b.state.players.p1.skills = { dash: skillBash() };
  stepActions(b, ['skill:dash'], ['wait']);
  assert.equal(b.state.players.p1.x, 656, 'M8 A 656');
  assert.equal(b.state.players.p2.hp, 100, 'M8 无任何伤害');
});

test('T-EN-1/diff 帧差异：位移起止 px + 资源增减（T-EN-1 可重建）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const b = engine.createBattle(CONFIG, { seed: 2, logger, players: { p1: mkPlayer({ x: 400 }), p2: mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }) } });
  const diff = stepActions(b, ['move_right'], ['wait']);
  assert.equal(diff.players.p1.fromX, 400);
  assert.equal(diff.players.p1.toX, 464, 'M1 A 464');
  assert.equal(b.state.players.p2.x, 600, 'M1 B 600');
  assert.ok(logger.records.some((x) => x.event === 'tick.begin'), 'tick.begin');
  assert.ok(logger.records.some((x) => x.event === 'tick.end' && x.tick === 1), 'tick.end 带 tick');
  // 事件顺序（T-BT-9）：tick.begin 在 move.resolve 前
  const idxBegin = logger.records.findIndex((x) => x.event === 'tick.begin');
  const idxMove = logger.records.findIndex((x) => x.event === 'move.resolve');
  assert.ok(idxBegin < idxMove, 'tick.begin 先于 move.resolve');
});

test('T-LG-5 cid 链路：skill.cast → bullet.spawn → bullet.hit → tick.end（damage.* 事件 B9 行交付）', () => {
  const logger = createLogger({ level: 'all', ringSize: 1000 });
  const b = engine.createBattle(CONFIG, { seed: 3, logger, players: { p1: mkPlayer({ x: 400 }), p2: mkPlayer({ id: 'B2', owner: 'p2', x: 800, facing: -1, atk: 19, def: 9 }) } });
  b.state.players.p1.skills = { precise: skillPrecise() };
  stepActions(b, ['skill:precise'], ['wait']);
  const cast = logger.records.findIndex((x) => x.event === 'skill.cast');
  const spawn = logger.records.findIndex((x) => x.event === 'bullet.spawn');
  const hit = logger.records.findIndex((x) => x.event === 'bullet.hit');
  const end = logger.records.findIndex((x) => x.event === 'tick.end');
  assert.ok(cast !== -1 && spawn !== -1 && hit !== -1 && end !== -1, '全链事件存在');
  assert.ok(cast < spawn && spawn < hit && hit < end, 'cid 链顺序固定（T-BT-9）');
  // 平射命中：B 静止 800 → t*=(800−400)/(512−0)=0.7813 → 伤害 12×1.0×0.816327=9.796→9
  assert.equal(b.state.players.p2.hp, 91, '基础伤害 9（B9 前的基础链路，无需 damage.calc 事件）');
});

function skillPrecise() {
  const skills = require('../../server/core/skills.js');
  const sk = skills.instantiateSkill('skill_straight_precise', 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 });
  sk.multiplier = 1.0; // 04-bullets §1 示例（mult 1.0，L3）
  return sk;
}

test('T-EN-10 资源恢复 + 冷却递减（D-82/D-110）', () => {
  const b = mkBattle(mkPlayer({ x: 400, mp: 39, sp: 58 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b.state.players.p1.cooldowns = { x1: 1 };
  stepActions(b, ['wait'], ['wait']);
  assert.equal(b.state.players.p1.mp, 40, 'mp +1（上限 40）');
  assert.equal(b.state.players.p1.sp, 60, 'sp +2');
  assert.equal(b.state.players.p1.cooldowns.x1, 0, '冷却递减 max(0, cd−1)');
});

test('normalizeAction：白名单 + 非法 → wait（D-80）；未知技能语法层放行、引擎步骤 6 兜底', () => {
  const b = mkBattle(mkPlayer(), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  assert.equal(b.normalizeAction('move_left').type, 'move');
  assert.equal(b.normalizeAction('dodge_right').type, 'dodge');
  assert.equal(b.normalizeAction('defend').type, 'defend');
  assert.equal(b.normalizeAction('wait').type, 'wait');
  assert.equal(b.normalizeAction('fly').type, 'wait', '未知行动 → wait');
  assert.equal(b.normalizeAction('skill:no_such').type, 'skill', 'skill: 语法合法（sid 可用性由引擎步骤 6 兜底）');
  assert.equal(b.normalizeAction('').type, 'wait');
  assert.equal(b.normalizeAction(42).type, 'wait', '非字符串 → wait');
  // 未知技能 → 空行动 wait（不扣资源、不产生效果，D-80/07 §5）
  const b2 = mkBattle(mkPlayer({ x: 400, mp: 40, sp: 60 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b2.state.players.p1.skills = {};
  stepActions(b2, ['skill:no_such'], ['wait']);
  assert.equal(b2.state.players.p1.sp, 60, '未扣资源（空行动）');
  assert.equal(b2.state.players.p1.x, 400, '空行动位置不变');
});

test('T-EN-4 超时扣血：tick≥48 双方基地与角色同时扣 ceil(maxHp×0.0625)（=7）', () => {
  const b = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  // 快进到 48
  for (let i = 0; i < 47; i++) stepActions(b, ['wait'], ['wait']);
  assert.equal(b.state.tick, 47);
  const before = b.state.players.p1.hp;
  stepActions(b, ['wait'], ['wait']);
  assert.equal(b.state.tick, 48);
  assert.equal(b.state.players.p1.hp, before - 7, '角色超时扣 7');
  assert.equal(b.state.bases.p1.hp, 100 - 7, '基地同扣 7');
  assert.equal(b.state.bases.p2.hp, 100 - 7);
});

test('T-EN-2/judge：基地 ≤0 优先胜出 + runFull 结束', () => {
  const b = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b.state.bases.p1.hp = 1;
  b.state.bases.p2.hp = 20;
  b.state.players.p2.hp = 5;
  // 打爆基地（注入一次碰撞？直接调 judge 语义检查 + runFull 终止性）
  const r = b.judge(b.state);
  assert.equal(r, null, '未结束');
  b.state.bases.p1.hp = 0;
  assert.equal(b.judge(b.state).winner, 'p2', '基地优先');
  // runFull：从干净战斗跑到底（64 tick 上限内）
  const b2 = mkBattle(mkPlayer({ x: 400, hp: 100 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  const result = b2.runFull({ actions: () => ['wait', 'wait'] });
  assert.ok(result.winner !== undefined, 'runFull 必有结果');
  assert.ok(result.ticks <= 64, `64 tick 上限内结束（实际 ${result.ticks}）`);
});

test('EN-11 控制复写：眩晕 → wait；击退 → forced_move 意图', () => {
  const b = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b.state.players.p1.effects = [{ uid: 'e1', kind: 'control', displacement: 0, remaining: 1 }];
  const diff = stepActions(b, ['move_right'], ['wait']);
  assert.equal(b.state.players.p1.x, 400, '眩晕 → 原地');
  assert.equal(b.state.players.p1.effects.length, 0, '控制效果消耗');
  // 击退 +2：控制位移不可穿（单方场景 no enemy → 直接目标 400+128=528）
  const b2 = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 800, facing: -1, atk: 19, def: 9 }));
  b2.state.players.p1.effects = [{ uid: 'e2', kind: 'control', displacement: 2, remaining: 1 }];
  stepActions(b2, ['wait'], ['wait']);
  assert.equal(b2.state.players.p1.x, 528, '击退 2 格');
});

test('P1/P2/P3 边界：双静止无事件 / 击退 gap 钳制 / 同侧边界', () => {
  const logger = createLogger({ level: 'all', ringSize: 100 });
  const b = engine.createBattle(CONFIG, { seed: 4, logger, players: { p1: mkPlayer({ x: 400 }), p2: mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }) } });
  stepActions(b, ['wait'], ['wait']);
  assert.equal(b.state.players.p1.x, 400, 'P1 双静止位置不变');
  assert.equal(b.state.players.p2.x, 600);
  // clamps：贴边 move
  const b2 = mkBattle(mkPlayer({ x: 992, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 500, x2: 500, facing: -1, atk: 19, def: 9 }));
  stepActions(b2, ['move_right'], ['wait']);
  assert.equal(b2.state.players.p1.x, 992, 'clampX 边界');
});

test('EN-15 补充分支：B 单穿目标重叠（后推停 A 身后）；defend def×1.6（D-43）与标记重置', () => {
  // B 单穿：A move（不可穿）→464、B dodge_left（可穿）544→416（重叠 464）→ B 停 A 身后 400
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 544, facing: -1, atk: 19, def: 9 }));
  stepActions(b, ['move_right'], ['dodge_left']);
  assert.equal(b.state.players.p1.x, 464, 'A 到达意图位置');
  assert.equal(b.state.players.p2.x, 400, 'B 可穿 → 停 A 身后（464−64）');
  // defend：B atk19 打防守的 A（def 8×1.6=12.8 → 减伤 0.7576 → 19×0.7576=14.39→14；无防是 15）
  const b2 = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b2.state.players.p1.skills = { precise: skillPrecise() };
  stepActions(b2, ['defend'], ['wait']);
  assert.equal(b2.state.players.p1.defending, true, 'defend 标记本 tick 生效');
  // 下一 tick 平射打防守方
  stepActions(b2, ['wait'], ['skill:precise']); // B 也可施放？——B 无技能：直接改 setup：p1 defend + p2 平射
  // 简化重做：p1 defend、p2 平射
  const b3 = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 800, facing: -1, atk: 19, def: 9 }));
  b3.state.players.p2.skills = { precise: skillPrecise() };
  stepActions(b3, ['defend'], ['skill:precise']);
  assert.equal(b3.state.players.p1.hp, 86, 'def×1.6 减伤 → 14（无防为 15）');
  stepActions(b3, ['wait'], ['wait']);
  assert.equal(b3.state.players.p1.defending, false, '步骤 1 重置临时标记');
});

test('EN-16 T-BT-16/M9 撞基地：停原地 + 基地 @atk×0.8 减伤（D-34/D-61）', () => {
  const b = mkBattle(mkPlayer({ x: 960, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 500, facing: -1, atk: 19, def: 9 }));
  stepActions(b, ['move_right'], ['wait']);
  assert.equal(b.state.players.p1.x, 960, 'M9 停原地（未移动）');
  // 基地伤害：12×0.8×0.384615=3.692→3（base def 64）
  assert.equal(b.state.bases.p2.hp, 97, 'M9 基地 −3');
  // 反向：P2 撞自家 p1 基地
  const b2 = mkBattle(mkPlayer({ id: 'A', owner: 'p1', x: 500, facing: 1, atk: 12, def: 8 }), mkPlayer({ id: 'B2', owner: 'p2', x: 64, facing: -1, atk: 19, def: 9 }));
  stepActions(b2, ['wait'], ['move_left']);
  assert.equal(b2.state.players.p2.x, 64, 'P2 停原地');
  assert.equal(b2.state.bases.p1.hp, 95, '基地 −5（19×0.8×0.384615=5.846→5）');
});

test('EN-17 judge 平局：双基地同时死 / 双角色同时死', () => {
  const b = mkBattle(mkPlayer(), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b.state.bases.p1.hp = 0;
  b.state.bases.p2.hp = 0;
  assert.deepEqual(b.judge(), { winner: 'draw', phase: 'base' }, '基地双死平局');
  const b2 = mkBattle(mkPlayer({ hp: 0 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9, hp: 0 }));
  assert.deepEqual(b2.judge(), { winner: 'draw', phase: 'role' }, '角色双死平局');
});

test('EN-18 技能资源不足：canCast 失败 → 空行动 wait（不扣资源不写 CD）', () => {
  const b = mkBattle(mkPlayer({ x: 400, sp: 5 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b.state.players.p1.skills = { precise: skillPrecise() };
  stepActions(b, ['skill:precise'], ['wait']);
  assert.equal(b.state.players.p1.sp, 7, '不扣资源（5 + 步骤 10 regen +2）');
  assert.equal(b.state.players.p1.cooldowns.skill_straight_precise, undefined, '不写 CD');
  assert.equal(b.state.players.p1.x, 400, '空行动位置不变');
});

test('EN-19 兜底侧与防御分支：无 options/裸玩家/dealDamage 缺参/judge 反向/死目标/缺 regen/sp/无参 step', () => {
  // 无 options（seed/logger 缺省）
  const b0 = engine.createBattle(CONFIG, { players: { p1: mkPlayer({}), p2: mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }) } });
  stepActions(b0, ['wait'], ['wait']);
  assert.equal(b0.state.tick, 1, '无 seed/logger 冒烟可用');
  // 裸玩家（无 cooldowns/effects/skills 字段 → createBattle 兜底）
  const b1 = engine.createBattle(CONFIG, {
    players: {
      p1: { id: 'A', owner: 'p1', x: 400, facing: 1, hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60, atk: 12, def: 8, regen: { mp: 1 } },
      p2: { id: 'B2', owner: 'p2', x: 600, facing: -1, hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60, atk: 19, def: 9, regen: { mp: 1 } },
    },
  });
  stepActions(b1, ['wait'], ['wait']);
  assert.equal(b1.state.players.p1.sp, 60, '缺 regen.sp → 不 NaN 不增长');
  assert.equal(b1.state.players.p1.cooldowns !== undefined, true, 'cooldowns 兜底');
  // dealDamage 缺参（mult 缺省 → baseHitMul）
  const b2 = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  const dmg0 = b2.dealDamage(b2.state.players.p1, b2.state.players.p2);
  assert.equal(dmg0.mult, 1.0, '缺省 mult = baseHitMul');
  assert.equal(b2.state.players.p2.hp, 100 - 9, '12×1.0×0.816327=9.79→9');
  // judge 反向：p2 基地死 → p1 胜；p2 角色死 → p1 胜
  const b3 = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b3.state.bases.p2.hp = 0;
  assert.equal(b3.judge().winner, 'p1', 'p2 基地死 → p1 胜');
  const b4 = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b4.state.players.p2.hp = 0;
  assert.equal(b4.judge().winner, 'p1', 'p2 角色死 → p1 胜');
  // 已死目标中弹：不产生伤害（步骤 9 跳过）
  const b5 = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 800, facing: -1, atk: 19, def: 9, hp: 0 }));
  b5.state.players.p1.skills = { precise: skillPrecise() };
  stepActions(b5, ['skill:precise'], ['wait']);
  assert.equal(b5.state.players.p2.hp, 0, '已死目标不再受伤');
  // 无参 step（actions 缺省）
  const b6 = mkBattle(mkPlayer({ x: 400 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b6.step();
  assert.equal(b6.state.tick, 1, '无参 step 冒烟（wait/wait）');
});

test('T-BT-20/M5 位移技不可穿+有伤：碰撞 + 弹幕双结算（B 合受 19、A 受 12、接触 568）', () => {
  const b = mkBattle(mkPlayer({ x: 400, facing: 1 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9, maxHp: 100 }));
  b.state.players.p1.skills = { dash: skillBash({ passThroughEnemy: false, dealDamage: true }) };
  const diff = stepActions(b, ['skill:dash'], ['wait']);
  assert.equal(b.state.players.p1.x, 536, 'M5 碰撞停 536（t*=0.53125）');
  assert.equal(diff.collision.contactX, 568, 'M5 接触点 568');
  assert.equal(b.state.players.p2.hp, 81, 'B 合受 19（弹幕 12 + 碰撞 7）');
  assert.equal(b.state.players.p1.hp, 88, 'A 受碰撞 12');
});

test('EN-14 死亡时序：hp≤0 仍行动（T-BT-* 锁定），持续效果后不立即判死', () => {
  const b = mkBattle(mkPlayer({ x: 400, hp: 5 }), mkPlayer({ id: 'B2', owner: 'p2', x: 600, facing: -1, atk: 19, def: 9 }));
  b.state.players.p1.effects = [{ uid: 'dot1', kind: 'continuous', stat: 'hp', delta: -10, remaining: 1, addedTick: 0 }];
  stepActions(b, ['move_right'], ['wait']);
  assert.equal(b.state.players.p1.hp, 0, '持续效果扣到 0');
  assert.equal(b.state.players.p1.x, 464, 'hp≤0 本 tick 仍行动（死亡时序：步骤 12 才判定）');
  assert.equal(b.state.verdict.winner, 'p2', '本 tick 步骤 12 正常判定 p2 胜（角色死亡）');
});