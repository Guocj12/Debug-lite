'use strict';
/* server/core/field.js —— 场地与坐标（P1 B1，契约 docs/interfaces.md §1）
 * 依据：decisions D-01~D-08（16 格×64px 连续坐标/1px 精度/格心定位/clamp/基地/体积/速度）、D-60~D-62（基地规则）。
 * 数值全部来自 server/data/battle-config.json（L9：机制在代码、数值在表）——本模块**禁止写死**
 * 64/1024/32/992/224/800 等配置值（门禁项 6② checkNumericHardcode 强制）。
 * 纯函数内核（L11）；日志经 withLogger 注入（缺省 nullLogger）——field.clamp(trace)/field.base(debug)（§4.6）。
 */
const { nullLogger } = require('../../shared/log.js');
const config = require('../data/battle-config.json');

const CELL_PX = config.cellPx;
const FIELD_PX = config.fieldPx;
const ACTOR_HALF = config.actorHalfPx;
const MIN_GAP_PX = config.minGapPx;
const START_X = config.startX;
const START_FACING = config.startFacing;
const BASE_DEF = config.baseDef;
const BOUND_LOW = ACTOR_HALF;
const BOUND_HIGH = FIELD_PX - ACTOR_HALF;
const CELLS = config.cells;

function makeField(logger) {
  const L = logger || nullLogger;

  // 角色中心 clamp 到 [actorHalf, fieldPx-actorHalf]（D-04；不量化，1px 量化在移动结算 F-08）
  function clampX(x) {
    let to = x;
    if (to < BOUND_LOW) to = BOUND_LOW;
    else if (to > BOUND_HIGH) to = BOUND_HIGH;
    if (to !== x) L.trace('field', 'field.clamp', `clampX(${x}) -> ${to}`, { from: x, to });
    return to;
  }

  // 格归属（半开区间 [64c, 64(c+1))；越界输入贴边，F-10..F-15）
  function cellOf(x) {
    const c = Math.floor(x / CELL_PX);
    if (c < 0) return 0;
    if (c >= CELLS) return CELLS - 1;
    return c;
  }

  // 格心（F-16）
  function xCenter(c) {
    return Math.floor(c) * CELL_PX + ACTOR_HALF;
  }

  // 相对朝向的格区间 [lo,hi]（facing×c 偏移），越界格丢弃；返回绝对格序号（按朝向顺序，F-20..F-27）
  function cellRange(lo, hi, facing, originX) {
    const origin = cellOf(originX);
    const out = [];
    for (let off = lo; off <= hi; off++) {
      const c = origin + facing * off;
      if (c >= 0 && c < CELLS) out.push(c);
    }
    return out;
  }

  // 基地区域（D-05；来自 battle-config）
  function baseOf(owner) {
    return config.bases[owner];
  }

  // 撞基地判定（D-61，F-30..F-36）：面向基地（dir===facing）且意图目标越过边界
  // 注意（B1 审查 P2-c）：翻转朝向后朝自己基地方向移动同样会命中（owner 由 facing 决定）——
  // 调用方（engine，B8 起）必须保证不会向自家基地移动（行动集语义），或显式传敌方基地。
  function touchesBase(actor, targetX, dir) {
    if (dir !== actor.facing) return false;
    let hit = false;
    if (dir > 0 && targetX > BOUND_HIGH) hit = true;
    else if (dir < 0 && targetX < BOUND_LOW) hit = true;
    if (hit) {
      const owner = actor.facing > 0 ? 'p2' : 'p1';
      L.debug('field', 'field.base', `撞基地判定命中（${owner}）`, { owner, targetX, dir });
    }
    return hit;
  }

  return { CELL_PX, FIELD_PX, ACTOR_HALF, MIN_GAP_PX, START_X, START_FACING, BASE_DEF, clampX, cellOf, xCenter, cellRange, baseOf, touchesBase };
}

module.exports = Object.assign(makeField(), { withLogger: (logger) => makeField(logger) });