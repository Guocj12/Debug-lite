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
    if (p.kind === 'player') {
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
    } else if (p.kind === 'verdict') {
      ctx.fillStyle = PALETTE.verdict;
      if (typeof ctx.fillText === 'function') ctx.fillText(p.text || '', p.x, p.y + 12);
    }
  }
  return { painted: true, count: (primitives || []).length };
}