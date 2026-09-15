'use strict';
/* mount/canvas.js —— #battle 画布显隐与坐标注入（F5 P1 根因修：屏幕盒子与画布元素对齐）。
 * replay 屏 → canvas 显示于 (16,80) 尺寸 1024×128 并执行 planFrame→paintCanvas；
 * 其他屏 → 隐藏。doc 注入缝：无 canvas → 跳过（node/测试安全）。
 */
import { planFrame } from '../render/planFrame.js';
import { planTrail } from '../render/trail.js';
import { paintCanvas } from '../render/paint.js';

export function injectCanvas(doc, state, opts) {
  const o = opts || {};
  if (!doc || typeof doc.getElementById !== 'function') return null;
  const canvas = doc.getElementById('battle');
  if (!canvas || typeof canvas.getContext !== 'function') return null;
  const show = state.screen === 'replay';
  if (canvas.style && typeof canvas.style === 'object') {
    canvas.style.display = show ? 'block' : 'none';
    if (show) {
      canvas.style.left = '16px';
      canvas.style.top = '80px';
      canvas.style.width = '1024px';
      canvas.style.height = '128px';
    }
  }
  if (!show) return null;
  const frames = state.battle.frames || [];
  const tick = state.battle.tick;
  const cur = frames[Math.min(tick, Math.max(0, frames.length - 1))];
  if (!cur) return null;
  const ctx = canvas.getContext('2d');
  const primitives = planFrame(cur.diff, { t: 1, winner: state.battle.result && state.battle.result.winner, maxHp: firstMaxHp(frames) });
  const trail = planTrail(frames.slice(0, tick + 1));
  const seen = paintCanvas(ctx, primitives, { log: o.log, trail });
  return { primitives, trail, seen };
}

// maxHp 取首帧 hp（战斗满血起始——只读派生，不重算战斗）
export function firstMaxHp(frames) {
  const f0 = (frames || [])[0];
  const p = f0 && f0.diff && f0.diff.players ? f0.diff.players.p1 : null;
  return p ? p.hp || 100 : 100;
}
