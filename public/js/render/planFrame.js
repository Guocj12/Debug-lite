'use strict';
/* render/planFrame.js —— 战斗帧 → 图元（frontend-spec §7：渲染层只读 frames，绝不重算战斗）。
 * 帧值域：1 引擎 px = 1 CSS px（canvas 1024×128，s=1，§7.1）。常量为 battle-config 的投影值（D-117）。
 * diff 字段名对齐 B22 冻结帧：players{p1,p2:{fromX,toX,facing,hp,mp,sp}}/bullets[]/bulletHits[]/
 * collision{contactX}/aiTrace[]/events[]；终局高亮由 opts.winner（接口层 winner）注入。
 */
export const FIELD_PX = 1024;
export const CELL_PX = 64;    // battle-config.cellPx
export const ACTOR_HALF = 32;
export const PLAYER_Y = 96;   // 角色中心线（画布高 128）
export const BULLET_Y = 96;
export const BASE_W = 32;     // 基地盒（screens.md replay 表 base_l 0,102,32,26 / base_r 992,102,32,26）
export const BASE_H = 26;
export const BASE_Y = 102;
export const BASE_RIGHT_X = FIELD_PX - BASE_W; // 992

const clamp01 = (t) => {
  const n = Number(t);
  const v = n === undefined || Number.isNaN(n) ? 1 : n;
  return Math.max(0, Math.min(1, v));
};

// diff → 图元 [{kind, owner, x, y, w, h, ...}]；坐标全整数（Math.round）
export function planFrame(diff, opts) {
  const o = opts || {};
  const t = clamp01(o.t === undefined ? 1 : o.t);
  const d = diff || {};
  const out = [];
  const bases = d.bases || {};
  for (const owner of ['p1', 'p2']) {
    const base = bases[owner];
    if (!base) continue;
    out.push({ kind: 'base', owner, x: owner === 'p1' ? 0 : BASE_RIGHT_X, y: BASE_Y, w: BASE_W, h: BASE_H, hp: base.hp });
  }
  const players = d.players || {};
  for (const owner of ['p1', 'p2']) {
    const p = players[owner];
    if (!p) continue;
    const x = Math.round((p.fromX === undefined ? p.toX : p.fromX) + ((p.toX === undefined ? p.fromX : p.toX) - (p.fromX === undefined ? p.toX : p.fromX)) * t);
    out.push({
      kind: 'player', owner, x: Math.round(x), y: PLAYER_Y - ACTOR_HALF, w: CELL_PX, h: CELL_PX,
      hp: p.hp, maxHp: o.maxHp || 100, facing: p.facing, winner: o.winner === owner,
    });
  }
  for (const b of d.bullets || []) {
    const len = b.len === undefined ? CELL_PX : b.len;
    const from = Math.min(b.x, b.x + len);
    out.push({ kind: 'bullet', owner: b.owner, x: Math.round(from), y: BULLET_Y - 4, w: Math.round(Math.abs(len) || CELL_PX), h: 8, level: b.level || 1 });
  }
  for (const h of d.bulletHits || []) {
    out.push({ kind: 'hit', target: h.target, x: Math.round(h.atX), y: BULLET_Y - 8, w: 16, h: 16 });
  }
  if (d.collision && d.collision.contactX !== undefined) {
    out.push({ kind: 'collision', x: Math.round(d.collision.contactX), y: PLAYER_Y - 12, w: 24, h: 24 });
  }
  if (o.winner) {
    out.push({ kind: 'verdict', text: `winner=${o.winner}`, x: 8, y: 8, w: FIELD_PX - 16, h: 16 });
  }
  return out;
}

// tick 域校验与步进（纯）
export function clampTick(tick, frames, delta) {
  const n = (frames || []).length;
  if (n === 0) return 0;
  const cur = tick === undefined || tick === null ? 0 : tick;
  return Math.max(0, Math.min(n - 1, cur + (delta || 0)));
}
