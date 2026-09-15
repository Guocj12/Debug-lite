// mount/canvas.js —— 画布绘制器（frontend-spec §7：planFrame 图元 → 2d canvas；禁止业务判断）
// 仅执行图元投影；色板为 tokens.css 镜像（canvas 无法用 var()）。
import { FIELD_PX } from '../render/planFrame.js';

export const PALETTE = {
  bg: '#0e1116', // --color-bg
  line: '#30363d', // --color-line
  p1: '#58a6ff', // --color-accent
  p2: '#f85149', // --color-danger
  bullet: '#e6edf3', // --color-text
  hit: '#f0883e', // 命中标记（无 token——文字映射登记）
  collision: '#f85149', // --color-danger
  verdict: '#3fb950', // --color-ok
  base1: '#1f6feb', // 基地 P1（--color-accent 的深色档；无 token——文字映射登记）
  base2: '#da3633', // 基地 P2（--color-danger 的深色档；无 token——文字映射登记）
};

const CANVAS_H = 128; // index.html 骨架 <canvas id="battle" height=128>

export function paintCanvas(canvasEl, primitives, opts) {
  const o = opts || {};
  const ctx = o.ctx || (canvasEl && typeof canvasEl.getContext === 'function' ? canvasEl.getContext('2d') : null);
  if (!ctx) return { painted: false, reason: 'no-ctx' };
  const w = o.width || FIELD_PX;
  const h = o.height || CANVAS_H;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = PALETTE.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = PALETTE.line;
  ctx.beginPath();
  ctx.moveTo(0, 96);
  ctx.lineTo(w, 96);
  ctx.stroke();
  for (const p of primitives || []) {
    if (p.kind === 'base') {
      // 基地盒（screens.md replay 表 base_l/base_r；填充高度按 hp/maxHp 投影，缺 maxHp → 满格）
      const ratio = Number.isFinite(p.maxHp) && p.maxHp > 0 && Number.isFinite(p.hp) ? Math.max(0, Math.min(1, p.hp / p.maxHp)) : 1;
      ctx.fillStyle = p.owner === 'p1' ? PALETTE.base1 : PALETTE.base2;
      ctx.fillRect(p.x, p.y + p.h * (1 - ratio), p.w, p.h * ratio);
      ctx.strokeStyle = PALETTE.line;
      ctx.strokeRect(p.x, p.y, p.w, p.h);
    } else if (p.kind === 'player') {
      ctx.fillStyle = p.owner === 'p1' ? PALETTE.p1 : PALETTE.p2;
      ctx.fillRect(p.x, p.y, p.w, p.h);
    } else if (p.kind === 'bullet') {
      ctx.fillStyle = PALETTE.bullet;
      ctx.fillRect(p.x, p.y, p.w, p.h);
    } else if (p.kind === 'hit') {
      ctx.fillStyle = PALETTE.hit;
      ctx.fillRect(p.x, p.y, p.w, p.h);
    } else if (p.kind === 'collision') {
      ctx.fillStyle = PALETTE.collision;
      ctx.fillRect(p.x, p.y, p.w, p.h);
    } else if (p.kind === 'trail') {
      // F7 AI 轨迹线（连续 toX 折线；透明色弱化）
      if (typeof ctx.beginPath === 'function') {
        ctx.strokeStyle = p.owner === 'p1' ? PALETTE.p1 : PALETTE.p2;
        ctx.globalAlpha = 0.4;
        ctx.beginPath();
        const pts = p.points || [];
        for (let i = 0; i < pts.length; i++) {
          if (i === 0) ctx.moveTo(pts[i].x, pts[i].y);
          else ctx.lineTo(pts[i].x, pts[i].y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    } else if (p.kind === 'verdict') {
      ctx.fillStyle = PALETTE.verdict;
      if (typeof ctx.fillText === 'function') ctx.fillText(p.text || '', p.x, p.y + 12);
    }
  }
  return { painted: true, count: (primitives || []).length };
}