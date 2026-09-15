'use strict';
/* server/core/bullets.js —— 弹幕系统（P1 B7，契约 docs/interfaces.md §1）
 * 依据：systems/04-bullets.md（数据结构/核心流程/遍历递归）；examples/04-bullets.md P1..P7/Q1..Q4/2.1/C1..C9/B1..B6（数值期望）。
 * decisions：D-07（1px 精度）/D-20（不跨 tick）/D-21（无 pathThisTick）/D-23（连续方程）/D-24（AOE 位移后判定）/
 *   D-25（命中次数与等级抵消）/D-26（每格独立）/D-27（生成序+可移除集合+递归）/D-28（高穿低继续命中）/
 *   D-30（t∈(0,1] 含终点、不伤己、生成格无敌人）/D-31/D-32（弹幕互撞 t∈[0,1] 含 t=0）/D-72（fullDodge 忽略）/D-118。
 * 纯函数内核（L11）：无 IO / 无随机 / 无 console；日志经 withLogger 注入（缺省 nullLogger）。
 * 事件：bullet.spawn(debug) / bullet.hit(debug) / bullet.block(debug)（§4.6）。
 * 边界（B7 登记）：本模块交付**运动学**（判定/互撞/递归/falloff 系数）；完整伤害数值（×atk×mult×抵消×护甲×背击×暴击）由 B9 伤害链路组合。
 * 互撞语义（B7 登记，复现 C9 双变体）：对每枚弹幕（生成序），先扫描与存活敌弹的 **t=0 立即拦截**（D-32，优先于一切 t>0），
 *   再做 t>0 逐对判定；判据基于"当前存活集合"（D-27 递归），任何移除影响后续判定。
 */
const { nullLogger } = require('../../shared/log.js');
const field = require('./field.js');

const CELL = require('../data/battle-config.json').cellPx;

function makeBullets(logger) {
  let seq = 0; // uid 计数器：实例级（B11：模块级共享会导致跨 battle uid 顺延、破坏逐帧一致）
  const L = logger || nullLogger;

  // 连续方程求解原语（弹幕-弹幕、弹幕-角色共用）：x1+v1·t = x2+v2·t → t* ∈ [tMin, tMax]
  // 命中/互撞统一闭区间（D-30 命中 t=0 因"生成格无敌人"天然不可达，D-32 互撞含 t=0）
  function solveIntersection(x1, v1, x2, v2, tMax, tMin) {
    const dv = v1 - v2;
    if (dv === 0) return null;
    const t = (x2 - x1) / dv;
    if (!(t >= tMin && t <= tMax)) return null;
    return { t, x: x1 + v1 * t };
  }

  // 等级矩阵（数字小 = 高）：'b1'（b1 穿）| 'b2'（b2 穿）| 'both'（双消）| 'none'（同方不相撞）
  function bulletBattle(b1, b2) {
    if (b1.owner === b2.owner) return 'none';
    if (b1.level === b2.level) return 'both';
    return b1.level < b2.level ? 'b1' : 'b2';
  }

  // 生成（systems §4.1）：技能释放指令 → 战场弹幕（补 uid/order/hitSet），记录生成顺序与 spawn 事件
  function spawnBullets(battle, act) {
    const out = battle.bullets;
    for (const spec of (act && act.bullets) || []) {
      const b = {
        uid: spec.uid || `b_${seq++}`,
        owner: (act && act.owner) || 'p1',
        order: out.length,
        type: spec.type || spec.btype || 'straight',
        srcType: spec.srcType || (spec.type === 'aoe' ? 'aoe' : 'straight'),
        level: spec.level,
        dir: spec.dir || 0,
        x0: spec.x0,
        len: spec.len || 0,
        v: spec.v || 0,
        hitSet: [],
        payload: { ...(spec.payload || {}) },
      };
      out.push(b);
      L.debug('bullets', 'bullet.spawn', `${b.uid} @${b.x0}`, { uid: b.uid, owner: b.owner, x0: b.x0, v: b.v, level: b.level });
    }
    return out;
  }

  // 整 tick 解算（systems §4.2..4.4）：互撞（可移除集合+递归）→ 命中（连续方程/AOE）→ 清场
  function resolveBullets(battle, ctx) {
    const actors = (ctx && ctx.actors) || [];
    const aliveSet = new Set(battle.bullets.map((b) => b.uid));
    const events = { spawns: [], collides: [], hits: [], expires: [] };

    // ── 1) 弹幕互撞（D-27 递归语义）
    // 阶段一：**全局 t=0 立即拦截扫描**（D-32：生成点同位置的碰撞优先于一切 t>0，C9 双变体复现；
    //   循环直到无 t=0 碰撞——每次结算都会改变存活集合，需按当前集合重扫）
    let foundT0 = true;
    while (foundT0) {
      foundT0 = false;
      outer0:
      for (const b1 of battle.bullets) {
        if (!aliveSet.has(b1.uid)) continue;
        for (const b2 of battle.bullets) {
          if (b2.uid === b1.uid || !aliveSet.has(b2.uid) || b2.owner === b1.owner) continue;
          if (Math.abs(b1.x0 - b2.x0) > 0.5) continue;
          battleResolve(b1, b2, Math.round((b1.x0 + b2.x0) / 2), aliveSet, events);
          foundT0 = true;
          break outer0;
        }
      }
    }
    // 阶段二：t>0 逐对（生成序 × 存活敌弹）
    for (const b1 of battle.bullets) {
      if (!aliveSet.has(b1.uid)) continue;
      const enemyList = battle.bullets.filter((b) => b.owner !== b1.owner && b.uid !== b1.uid && aliveSet.has(b.uid));
      for (const b2 of enemyList) {
        if (!aliveSet.has(b2.uid) || !aliveSet.has(b1.uid)) continue;
        const it = solveIntersection(b1.x0, b1.dir * b1.v, b2.x0, b2.dir * b2.v, 1, 0);
        if (it) {
          battleResolve(b1, b2, Math.round(it.x), aliveSet, events);
        }
      }
    }

    // ── 2) 命中判定（存活弹幕 vs 敌方目标；同方/fullDodge/已死/基地区域跳过）
    for (const b of battle.bullets) {
      if (!aliveSet.has(b.uid)) continue;
      if (b.type === 'aoe') {
        for (const t of actors) {
          if (t.owner === b.owner || t.hp <= 0 || t.fullDodge) continue;
          if (field.cellOf(t.x2) === field.cellOf(b.x0)) {
            registerHit(b, t, b.x0, events);
          }
        }
      } else {
        for (const t of actors) {
          if (t.owner === b.owner || t.hp <= 0 || t.fullDodge) continue;
          if (b.hitSet.includes(t.id)) continue;
          const it = solveIntersection(b.x0, b.dir * b.v, t.x1, t.x2 - t.x1, 1, 0);
          if (it) {
            b.hitSet.push(t.id);
            registerHit(b, t, Math.round(it.x), events);
          }
        }
      }
    }

    // ── 3) tick 末清场（D-20/B6；bullet.expire(trace)，§4.6）
    events.expires = battle.bullets
      .filter((b) => aliveSet.has(b.uid))
      .map((b) => {
        aliveSet.delete(b.uid);
        L.trace('bullets', 'bullet.expire', `${b.uid} tick 末清场`, { uid: b.uid, reason: 'tick_end' });
        return { uid: b.uid, reason: 'tick_end' };
      });
    battle.bullets.length = 0;
    return events;
  }

  // 互撞结算：等级矩阵 → 移除败者（双消移除双方），胜者留在候选集（D-28）；双消 winner='none'
  function battleResolve(b1, b2, atX, aliveSet, events) {
    const outcome = bulletBattle(b1, b2);
    let winner = null;
    if (outcome === 'both') {
      aliveSet.delete(b1.uid);
      aliveSet.delete(b2.uid);
      winner = 'none';
    } else if (outcome === 'b1') {
      aliveSet.delete(b2.uid);
      winner = b1.uid;
    } else if (outcome === 'b2') {
      aliveSet.delete(b1.uid);
      winner = b2.uid;
    }
    if (winner !== null) {
      events.collides.push({ a: b1.uid, b: b2.uid, atX, winner });
      L.debug('bullets', 'bullet.collide', `collide ${b1.uid} vs ${b2.uid} @${atX}`, { a: b1.uid, b: b2.uid, atX, winner });
    }
    return outcome;
  }

  // 命中登记：附 1px 位置、falloff 系数、弹幕方向（背击判定用，B9）与 btype
  function registerHit(b, t, atX, events) {
    const distCells = b.payload.distCells === undefined ? 0 : b.payload.distCells;
    const falloffFactor = Math.max(0, 1 - (b.payload.falloff || 0) * distCells);
    events.hits.push({
      uid: b.uid, owner: b.owner, target: t.id, atX,
      level: b.level, distCells,
      falloffFactor,
      dir: b.dir,
      btype: b.type,
      srcType: b.srcType,
      payload: { ...b.payload },
    });
    L.debug('bullets', 'bullet.hit', `${b.uid} -> ${t.id} @${atX}`, { uid: b.uid, target: t.id, atX });
  }

  function bulletsOnField(battle) {
    return battle.bullets.length;
  }

  return { spawnBullets, resolveBullets, solveIntersection, bulletBattle, bulletsOnField };
}

module.exports = Object.assign(makeBullets(), { withLogger: (logger) => makeBullets(logger) });