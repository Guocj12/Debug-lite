'use strict';
// B7 core/bullets.js 契约测试 —— 接口见 docs/interfaces.md §1（spawnBullets/resolveBullets/solveIntersection/bulletBattle/bulletsOnField）
// 依据：examples/04-bullets.md P1..P7/Q1..Q4/2.1/C1..C9/B1..B6（数值期望唯一出处）；systems/04-bullets.md；decisions D-20..D-32/D-118
// 归属：tasks.md §6 B7（T-BU-1..8 + T-BT-8/19）；日志 bullet.spawn/hit/block（§4.6）
// 边界（B7 登记）：本次交付为运动学——命中/碰撞/递归/系数；完整伤害数值（×atk×护甲×背击×暴击）由 B9 伤害链路组合。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const bullets = require('../../server/core/bullets.js');

// 用例基具：bullet 工厂（uid/owner/order/type/level/dir/x0/len/v/payload）
const mk = (o) => Object.assign({
  uid: 'b', owner: 'p1', order: 1, type: 'straight', level: 3, dir: 1,
  x0: 224, len: 512, v: 512, hitSet: [], payload: { multiplier: 1.0, falloff: 0, affixes: [] },
}, o);
const mkActor = (o) => Object.assign({ id: 'B', owner: 'p2', x1: 800, x2: 800, hp: 30, fullDodge: false }, o);

test('T-BU-5/P1..P7 平射命中：连续方程 t* 与 1px 命中位置（含终点 D-30）', () => {
  // 相向必中：B 800→736
  const r1 = bullets.solveIntersection(224, 512, 800, -64, 1, 0);
  assert.ok(r1, 'P1 应命中');
  assert.equal(Math.round(r1.t * 10000) / 10000, 1.0, 'P1 t*=1');
  assert.equal(Math.round(r1.x), 736, 'P1 @736');
  // 同向追及：B 400→464
  const r2 = bullets.solveIntersection(224, 512, 400, 64, 1, 0);
  assert.ok(r2, 'P2 应命中');
  assert.equal(Math.round(r2.t * 10000) / 10000, 0.3929, 'P2 t*=0.3929');
  assert.equal(Math.round(r2.x), 425, 'P2 @425（1px）');
  // 弹幕更慢追不上
  assert.equal(bullets.solveIntersection(224, 128, 400, 64, 1, 0), null, 'P3 t*=2.75>1 不命中');
  // 等速平行
  assert.equal(bullets.solveIntersection(224, 64, 400, 64, 1, 0), null, 'P4 无解');
  // 目标静止
  const r5 = bullets.solveIntersection(224, 512, 400, 0, 1, 0);
  assert.ok(r5);
  assert.equal(Math.round(r5.t * 10000) / 10000, 0.3438, 'P5');
  assert.equal(Math.round(r5.x), 400, 'P5 @400');
  // 背离
  assert.equal(bullets.solveIntersection(400, 512, 300, 0, 1, 0), null, 'P6 t<0 不命中');
  // 够不着
  assert.equal(bullets.solveIntersection(224, 512, 800, 64, 1, 0), null, 'P7 t=1.2857>1');
});

test('T-BU-6/Q1..Q4 AOE：按位移后位置判定（走出范围方躲开 D-24）', () => {
  const battle = { bullets: [], tick: 1 };
  bullets.spawnBullets(battle, {
    skill: { type: 'melee' },
    bullets: [
      mk({ uid: 'a1', order: 1, type: 'aoe', level: 2, x0: 736, v: 0, len: 0, dir: 0, payload: { multiplier: 1.3, falloff: 0, affixes: [] } }),
      mk({ uid: 'a2', order: 2, type: 'aoe', level: 2, x0: 800, v: 0, len: 0, dir: 0, payload: { multiplier: 1.3, falloff: 0, affixes: [] } }),
      mk({ uid: 'a3', order: 3, type: 'aoe', level: 2, x0: 864, v: 0, len: 0, dir: 0, payload: { multiplier: 1.3, falloff: 0, affixes: [] } }),
    ],
  });
  const run = (x1, x2) => {
    const b = { bullets: battle.bullets.map((x) => ({ ...x, hitSet: [] })), tick: 1 };
    const target = mkActor({ x1, x2 });
    return bullets.resolveBullets(b, { actors: [target] });
  };
  // Q1 静止 800 → 命中（@800 弹幕）；Q2 移动 64 → 格 13 仍在范围；Q3 闪避 128 → 格 14 躲开；Q4 退一格 → 736 仍在
  const q1 = run(800, 800).hits;
  assert.equal(q1.length, 1, 'Q1 命中一次');
  assert.equal(q1[0].atX, 800);
  const q2 = run(800, 864).hits;
  assert.equal(q2.length, 1, 'Q2 命中（864 在格 13 覆盖内）');
  assert.equal(q2[0].atX, 864);
  const q3 = run(800, 928).hits;
  assert.equal(q3.length, 0, 'Q3 出范围躲开');
  const q4 = run(800, 736).hits;
  assert.equal(q4.length, 1, 'Q4 退一格仍在范围');
  assert.equal(q4[0].atX, 736);
});

test('T-BU-7/2.1 falloff 衰减系数（每向外一格 −20%，distCells 由技能层写入）', () => {
  // 弹幕格位与目标同格（falloff 只随 distCells 变化）
  const single = (actorX, distCells) => {
    const out = bullets.resolveBullets({
      bullets: [mk({ uid: 'c', order: 1, type: 'aoe', level: 2, x0: fieldX(actorX), v: 0, len: 0, dir: 0, payload: { multiplier: 1.3, falloff: 0.2, affixes: [], distCells } })],
      tick: 1,
    }, { actors: [mkActor({ x1: actorX, x2: actorX })] });
    return out.hits[0];
  };
  const fieldX = (x) => Math.floor(x / 64) * 64 + 32;
  assert.equal(single(736, 0).falloffFactor, 1.0, '中心格 ×1.0');
  assert.equal(single(800, 1).falloffFactor, 0.8, '+1 格 ×0.8');
  assert.equal(single(864, 2).falloffFactor, 0.6, '+2 格 ×0.6');
  // 默认 0 → 恒 1.0
  const r4 = bullets.resolveBullets({ bullets: [mk({ uid: 'z', order: 1, type: 'aoe', level: 2, x0: 864, v: 0, len: 0, dir: 0, payload: { multiplier: 1.3, falloff: 0, affixes: [] } })], tick: 1 }, { actors: [mkActor({ x1: 864, x2: 864 })] });
  assert.equal(r4.hits[0].falloffFactor, 1.0, 'falloff 0 → ×1.0');
});

test('T-BU-1/C1..C5 弹幕互撞：连续方程碰撞位置（含 t=0 立即拦截 D-32）', () => {
  const collide = (a, b) => bullets.solveIntersection(a.x0, a.dir * a.v, b.x0, b.dir * b.v, 1, 0);
  // C1 A 平射 +512 vs B 平射 −320 → t*=0.6923 @578
  const c1 = collide(mk({ x0: 224, dir: 1, v: 512 }), mk({ owner: 'p2', x0: 800, dir: -1, v: 320 }));
  assert.ok(c1);
  assert.equal(Math.round(c1.t * 10000) / 10000, 0.6923, 'C1 t*');
  assert.equal(Math.round(c1.x), 578, 'C1 @578');
  // C2 AOE @800 vs 平射 @800 → t=0 立即拦截 @800
  const c2 = collide(mk({ x0: 800, v: 0 }), mk({ owner: 'p2', x0: 800, dir: -1, v: 512 }));
  assert.ok(c2, 'C2 t=0 拦截');
  assert.equal(Math.round(c2.t), 0, 'C2 t*=0');
  assert.equal(Math.round(c2.x), 800, 'C2 @800');
  // C3 AOE @736 vs 平射 −320 → t=0.2 @736
  const c3 = collide(mk({ x0: 736, v: 0 }), mk({ owner: 'p2', x0: 800, dir: -1, v: 320 }));
  assert.equal(Math.round(c3.x), 736, 'C3 @736');
  // C4 平射对碰 512/−512 → t=0.5625 @512
  const c4 = collide(mk({ x0: 224, v: 512 }), mk({ owner: 'p2', x0: 800, dir: -1, v: 512 }));
  assert.equal(Math.round(c4.x), 512, 'C4 @512');
  // C5 同向等速 → 无解
  assert.equal(collide(mk({ x0: 224, v: 512 }), mk({ owner: 'p2', x0: 400, dir: 1, v: 512 })), null, 'C5 不相遇');
});

test('T-BU-1/3.2 等级矩阵：数字小等级高（16 格）', () => {
  const L = 1;
  const result = (a, b) => {
    const r = bullets.bulletBattle(a, b);
    return r === 'b1' ? '高穿' : r === 'b2' ? '低穿' : r === 'both' ? '双消' : 'none';
  };
  assert.equal(result(mk({ level: L }), mk({ level: 2, owner: 'p2' })), '高穿', 'L1 vs L2 → 高者穿');
  assert.equal(result(mk({ level: L }), mk({ level: 3, owner: 'p2' })), '高穿');
  assert.equal(result(mk({ level: L }), mk({ level: 4, owner: 'p2' })), '高穿');
  assert.equal(result(mk({ level: 2, owner: 'p2' }), mk({ level: L })), '低穿', 'L2 vs L1 → 低者被消');
  assert.equal(result(mk({ level: 2 }), mk({ level: 2, owner: 'p2' })), '双消', '同级双消');
  assert.equal(result(mk({ level: 2 }), mk({ level: 4, owner: 'p2' })), '高穿');
  assert.equal(result(mk({ level: 4, owner: 'p2' }), mk({ level: 2 })), '低穿');
  assert.equal(result(mk({ level: 4 }), mk({ level: 4, owner: 'p2' })), '双消');
  // 同 owner 不互撞
  assert.equal(bullets.bulletBattle(mk({ level: 2 }), mk({ level: 4 })), 'none', '同方不相撞');
});

test('T-BU-4/C6..C9 递归语义（D-27）：可移除集合、生成顺序、t=0 优先', () => {
  const aoe = (uid, order, x0, level, owner) => mk({ uid, order, owner: owner || 'p2', type: 'aoe', level, x0, v: 0, len: 0, dir: 0, payload: { multiplier: 1.3, falloff: 0, affixes: [] } });
  const shot = (uid, order, x0, level, dir, owner) => mk({ uid, order, owner: owner || 'p2', type: 'straight', level, x0, dir, v: 512, len: 512, payload: { multiplier: 1.0, falloff: 0, affixes: [] } });
  // C7：A 的 L4 平射 vs B 的 L2 近战（同刻同点）→ A 发完全失效（L4 被消）
  const b7b = { bullets: [
    shot('A1', 1, 736, 4, 1, 'p1'),
    aoe('B1', 2, 736, 2, 'p2'),
  ], tick: 1 };
  const r7 = bullets.resolveBullets(b7b, { actors: [mkActor({ x1: 800, x2: 800 })] });
  assert.equal(r7.collides.length, 1, 'C7 一次碰撞');
  assert.equal(r7.collides[0].winner, 'B1', 'L2 高者留下');
  assert.equal(r7.hits.length, 0, 'A 的 L4 完全失效（B 不受该发伤害）');
  // C8：同级双消 = 等价交换（t=0 于 800）
  const b8 = { bullets: [
    aoe('A1', 1, 800, 2, 'p1'),
    shot('B1', 2, 800, 2, -1, 'p2'),
  ], tick: 1 };
  const r8 = bullets.resolveBullets(b8, { actors: [mkActor({ x1: 800, x2: 800 })] });
  assert.equal(r8.collides.length, 1);
  assert.equal(r8.collides[0].winner, 'none', '同级双消');
  assert.equal(r8.hits.length, 0, 'C8 双方都无伤');
  // C9 主情形：B 两枚 L3 平射（从 800 向左）→ 被 A 的 L2 AOE 全消 → @800 命中 B
  const b9 = { bullets: [
    aoe('A1', 1, 736, 2, 'p1'),
    aoe('A2', 2, 800, 2, 'p1'),
    shot('B1', 3, 800, 3, -1, 'p2'),
    shot('B2', 4, 800, 3, -1, 'p2'),
  ], tick: 1 };
  const r9 = bullets.resolveBullets(b9, { actors: [mkActor({ x1: 800, x2: 800 })] });
  assert.ok(r9.collides.length >= 2, 'C9 至少两次碰撞');
  assert.equal(r9.hits.length, 1, 'C9 A 的 @800 命中 B（12 的伤害数值由 B9 组合）');
  assert.equal(r9.hits[0].uid, 'A2');
  // C9 变体：B 第 2 枚换 L2 → 与 @800 同级双消（t=0 优先于与 @736 的 t>0 碰撞）→ A 失去命中
  const b9v = { bullets: [
    aoe('A1', 1, 736, 2, 'p1'),
    aoe('A2', 2, 800, 2, 'p1'),
    shot('B1', 3, 800, 3, -1, 'p2'),
    shot('B2', 4, 800, 2, -1, 'p2'),
  ], tick: 1 };
  const r9v = bullets.resolveBullets(b9v, { actors: [mkActor({ x1: 800, x2: 800 })] });
  assert.equal(r9v.hits.length, 0, 'C9 变体：@800 双消后 A 失去命中（B 在格 12，@736 覆盖不到）');
});

test('T-BU-2/B1..B6 边界：射程尽头含终点 / 出界 / 不伤己 / 基地 0 伤害 / 已死目标 / 不跨 tick', () => {
  // B1：t*=1 恰好命中（P1 已证）；B6：tick 末存活=0；B3：不伤己（同方目标天然跳过）
  const battle = { bullets: [mk({ uid: 's1', order: 1, x0: 224, v: 512, len: 512 })], tick: 1 };
  const r = bullets.resolveBullets(battle, { actors: [mkActor({ x1: 736, x2: 736 }), mkActor({ id: 'Z', owner: 'p1', x1: 300, x2: 300, hp: 10 })] });
  assert.equal(r.hits.length, 1, 'B3 同方目标不判命中（只有 B 被打）');
  assert.ok(r.hits.every((h) => h.target !== 'Z'), '不伤己');
  assert.equal(bullets.bulletsOnField(battle), 0, 'B6 存活 0');
  // B4：基地区域目标不判命中（打向基地不产生基地伤害 D-60）
  const b2 = { bullets: [mk({ uid: 's2', order: 1, x0: 224, v: 512, len: 512 })], tick: 1 };
  const r2 = bullets.resolveBullets(b2, { actors: [], bases: { p2: { centerX: 1056 } } });
  assert.equal(r2.hits.length, 0, 'B4 基地不参与命中');
  // B5：已死目标不结算伤害，但抵消照常（碰撞阶段不受 hp 影响）
  const b3 = { bullets: [mk({ uid: 'a1', order: 1, type: 'aoe', level: 2, x0: 800, v: 0, len: 0, dir: 0 }), mk({ uid: 's3', order: 2, owner: 'p2', type: 'straight', level: 2, x0: 800, dir: -1, v: 512, len: 512 })] };
  const r3 = bullets.resolveBullets({ bullets: b3.bullets, tick: 1 }, { actors: [mkActor({ x1: 800, x2: 800, hp: 0 })] });
  assert.equal(r3.collides.length, 1, 'B5 抵消照常（双消）');
  assert.equal(r3.hits.length, 0, 'B5 已死目标不产生命中伤害');
  // fullDodgeDuring（D-72）：不参与命中与抵消
  const b4 = { bullets: [mk({ uid: 'a1', order: 1, type: 'aoe', level: 2, x0: 800, v: 0, len: 0, dir: 0, payload: { multiplier: 1.3, falloff: 0, affixes: [] } })] };
  const r4 = bullets.resolveBullets(
    { bullets: b4.bullets, tick: 1 },
    { actors: [mkActor({ x1: 800, x2: 800, fullDodge: true })] }
  );
  assert.equal(r4.hits.length, 0, 'D-72 fullDodge 角完全忽略');
  assert.equal(bullets.bulletsOnField({ bullets: b4.bullets }), 0, '弹幕仍于 tick 末清空');
});

test('T-BU-3/D-25 hitSet：多枚弹幕各算一次；同一枚对同一目标只结算一次', () => {
  const battle = { bullets: [
    mk({ uid: 'm1', order: 1, x0: 224, v: 512, len: 512 }),
    mk({ uid: 'm2', order: 2, x0: 224, v: 512, len: 512 }),
  ], tick: 1 };
  const r = bullets.resolveBullets(battle, { actors: [mkActor({ x1: 400, x2: 464 })] });
  assert.equal(r.hits.length, 2, '两枚各命中一次（平射可多次命中同一目标 D-25）');
});

test('BU-8 日志：bullet.spawn / bullet.collide / bullet.expire（§4.6 冻结事件）', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const bl = bullets.withLogger(logger);
  const battle = { bullets: [], tick: 1 };
  bl.spawnBullets(battle, {
    skill: { type: 'straight' },
    bullets: [mk({ uid: 'x1', order: 1, x0: 224, v: 512, len: 512 })],
  });
  const spawnEvt = logger.records.find((x) => x.event === 'bullet.spawn');
  assert.ok(spawnEvt, '应有 bullet.spawn');
  assert.equal(spawnEvt.data.uid, 'x1');
  bl.resolveBullets(battle, { actors: [mkActor({ x1: 400, x2: 464 })] });
  const hit = logger.records.find((x) => x.event === 'bullet.hit');
  assert.ok(hit, '应有 bullet.hit（弹幕命中后仍在场 → tick 末 expire）');
  const expire = logger.records.find((x) => x.event === 'bullet.expire');
  assert.ok(expire, '应有 bullet.expire');
  assert.equal(expire.data.reason, 'tick_end');
  // collide：互撞移除
  const logger2 = createLogger({ level: 'all', ringSize: 200 });
  const bl2 = bullets.withLogger(logger2);
  const b2 = { bullets: [
    mk({ uid: 'a1', order: 1, type: 'aoe', level: 2, x0: 800, v: 0, len: 0, dir: 0 }),
    mk({ uid: 's9', order: 2, owner: 'p2', type: 'straight', level: 2, x0: 800, dir: -1, v: 512, len: 512 }),
  ], tick: 1 };
  bl2.resolveBullets(b2, { actors: [] });
  assert.ok(logger2.records.some((x) => x.event === 'bullet.collide'), '应有 bullet.collide');
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    bullets.spawnBullets({ bullets: [], tick: 1 }, { skill: { type: 'melee' }, bullets: [mk({ uid: 'n1', order: 1, type: 'aoe', level: 2, x0: 736, v: 0, len: 0, dir: 0 })] });
    bullets.resolveBullets({ bullets: [], tick: 1 }, { actors: [] });
    bullets.solveIntersection(0, 1, 10, 1, 1, 0);
    bullets.bulletBattle(mk({ level: 1 }), mk({ level: 2, owner: 'p2' }));
    bullets.bulletsOnField({ bullets: [] });
  });
});

test('T-BT-8 生成数上界 + 每 tick 清零（审查 P2-1）', () => {
  // 近战覆盖 3 格 + 平射 2 枚同 tick → 场上最多 5 枚
  const battle = { bullets: [], tick: 1 };
  bullets.spawnBullets(battle, {
    skill: { type: 'melee' },
    bullets: [
      mk({ order: 1, type: 'aoe', x0: 736, v: 0, len: 0, dir: 0 }),
      mk({ order: 2, type: 'aoe', x0: 800, v: 0, len: 0, dir: 0 }),
      mk({ order: 3, type: 'aoe', x0: 864, v: 0, len: 0, dir: 0 }),
    ],
  });
  bullets.spawnBullets(battle, {
    skill: { type: 'straight' },
    bullets: [
      mk({ owner: 'p2', order: 4, x0: 800, dir: -1, v: 512, len: 512 }),
      mk({ owner: 'p2', order: 5, x0: 800, dir: -1, v: 512, len: 512 }),
    ],
  });
  assert.equal(bullets.bulletsOnField(battle), 5, '上界 = 覆盖格数 + bulletCount');
  const r = bullets.resolveBullets(battle, { actors: [] });
  assert.equal(bullets.bulletsOnField(battle), 0, 'tick 末清零');
  assert.equal(r.expires.length, 5);
});