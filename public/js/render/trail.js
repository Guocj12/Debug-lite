'use strict';
/* render/trail.js —— AI 轨迹可视化（frontend-spec §7 打磨项）：
 * planTrail：从回放帧派生双方位置轨迹点（相邻帧连线；限长 32；缺字段安全）。
 * 渲染层只读 frames——轨迹是 diff 的重投影，不重算战斗。
 */
import { FIELD_PX, CELL_PX, PLAYER_Y, ACTOR_HALF } from './planFrame.js';

const TRAIL_LIMIT = 32;

export function planTrail(frames, opts) {
  const o = opts || {};
  const owners = o.owners || ['p1', 'p2'];
  const out = [];
  for (const owner of owners) {
    const points = [];
    for (const f of frames || []) {
      const d = (f && f.diff) || {};
      const p = (d.players && d.players[owner]) || null;
      if (!p) continue;
      const x = p.toX !== undefined ? p.toX : p.fromX;
      if (x === undefined) continue;
      points.push(Math.round(x));
    }
    if (points.length < 2) continue;
    out.push({ owner, points: points.slice(-TRAIL_LIMIT), alpha: 0.4, y: PLAYER_Y + ACTOR_HALF / 2, color: owner === 'p1' ? '#58a6ff' : '#f85149' });
  }
  return out;
}

// tick 滑块域（纯）：当前帧 → 滑块位置
export function sliderTick(tick, frames) {
  const n = (frames || []).length;
  if (n === 0) return 0;
  return Math.max(0, Math.min(n - 1, tick || 0));
}
