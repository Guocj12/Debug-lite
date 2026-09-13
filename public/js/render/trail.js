// render/trail.js —— AI 轨迹可视化（F7：帧序列 → 轨迹图元；纯函数）
// 玩家位置轨迹：相邻帧 toX 连线（1px）；限长（最近 32 帧）防长线堆积。
const TRAIL_MAX = 32;

export function planTrail(frames, tick, owner) {
  const out = [];
  const upto = Math.min(tick === undefined || tick === null ? 0 : tick + 1, (frames || []).length);
  const points = [];
  for (let i = 0; i < upto; i++) {
    const p = frames[i] && frames[i].diff && frames[i].diff.players && frames[i].diff.players[owner];
    if (p && Number.isInteger(p.toX)) points.push({ x: p.toX, y: 96, tick: i + 1 });
  }
  const tail = points.slice(-TRAIL_MAX);
  if (tail.length >= 2) {
    out.push({ kind: 'trail', owner, points: tail.map((p) => ({ x: p.x, y: p.y })) });
  }
  return out;
}