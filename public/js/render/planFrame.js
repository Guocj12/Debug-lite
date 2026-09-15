// render/planFrame.js —— 战斗帧 → 图元（frontend-spec §7：渲染层只读 frames，绝不重算战斗）
// 帧值域：1 引擎 px = 1 CSS px（canvas 1024×128，s=1，§7.1）。常量来源 battle-config（D-117 数值在表；
// 前端仅为投影常量——机制值不在前端计算，仅布局投影）。
export const FIELD_PX = 1024; // battle-config.fieldPx
export const CELL_PX = 64; // battle-config.cellPx
export const ACTOR_HALF = 32; // battle-config.actorHalfPx
export const PLAYER_Y = 96; // 角色中心线（canvas 高 128：上方 64 为 HUD 预留）
export const BULLET_Y = 96;
export const BASE_W = 32; // 基地盒（screens.md replay 表 base_l 0,102,32,26 / base_r 992,102,32,26）
export const BASE_H = 26;
export const BASE_Y = 102;
export const BASE_LEFT_X = 0;
export const BASE_RIGHT_X = FIELD_PX - BASE_W; // 992

// diff（B22 冻结帧）→ 图元数组 [{kind, owner?, x, w, y, hp, ...}]
// 图元种类：base（A/B 基地）/ player（A/B 矩形）/ bullet / hit（命中标记）/ collision（碰撞标记）/ verdict（终局文字）
export function planFrame(diff, frameIndex) {
  const d = diff || {};
  const out = [];
  const bases = d.bases || {};
  for (const owner of ['p1', 'p2']) {
    const base = bases[owner];
    if (!base) continue;
    out.push({
      kind: 'base', owner, frameIndex,
      x: owner === 'p1' ? BASE_LEFT_X : BASE_RIGHT_X, y: BASE_Y, w: BASE_W, h: BASE_H,
      hp: base.hp, maxHp: base.maxHp, def: base.def,
    });
  }
  const players = d.players || {};
  for (const owner of ['p1', 'p2']) {
    const p = players[owner];
    if (!p) continue;
    out.push({
      kind: 'player', owner, frameIndex,
      x: p.toX, w: CELL_PX, h: CELL_PX, y: PLAYER_Y - ACTOR_HALF,
      hp: p.hp, mp: p.mp, sp: p.sp, facing: p.facing,
    });
  }
  for (const b of d.bullets || []) {
    out.push({ kind: 'bullet', owner: b.owner, x: b.x, w: CELL_PX, h: 8, y: BULLET_Y - 4, len: b.len, dir: b.dir });
  }
  for (const h of d.bulletHits || []) {
    out.push({ kind: 'hit', target: h.target, x: h.atX, w: 16, h: 16, y: BULLET_Y - 8 });
  }
  if (d.collision) {
    out.push({ kind: 'collision', x: d.collision.contactX, w: 24, h: 24, y: PLAYER_Y - 12 });
  }
  if (d.verdict) {
    out.push({ kind: 'verdict', text: `winner=${d.verdict.winner} phase=${d.verdict.phase || ''}`, x: 8, y: 8, w: FIELD_PX - 16, h: 16 });
  }
  return out;
}

// 播放进度工具（纯）：tick 域校验与步进
export function clampTick(tick, frames, delta) {
  const n = (frames || []).length;
  if (n === 0) return 0;
  const next = (tick === undefined || tick === null ? 0 : tick) + (delta || 0);
  return Math.max(0, Math.min(n - 1, next));
}