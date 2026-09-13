// ui/layout.js —— 确定性布局工具（frontend-spec §3.4；纯函数；坐标必须整数）
// 所有坐标相对视口左上角（CSS px）；份额唯一事实源（§0.2 确定性盒模型）。
import { SPACES, SIZES } from './sizes.js';

export function grid(x0, y0, cols, cellW, cellH, gap, items) {
  const out = [];
  const list = items || [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    out.push({
      ...it,
      x: x0 + (i % cols) * (cellW + gap),
      y: y0 + Math.floor(i / cols) * (cellH + gap),
      w: it.w || cellW,
      h: it.h || cellH,
    });
  }
  return out;
}

export function center(w, h, parentW, parentH) {
  const W = parentW === undefined ? SIZES.viewportW : parentW;
  const H = parentH === undefined ? SIZES.viewportH : parentH;
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2) };
}

export function stack(y0, items, opts) {
  const gap = (opts && opts.gap) || SPACES.s2;
  const out = [];
  let y = y0;
  for (const it of items || []) {
    out.push({ ...it, y: Math.round(y), x: it.x === undefined ? 0 : it.x });
    y += (it.h || 0) + gap;
  }
  return out;
}

export function panel(x, y, w, h, title, id) {
  return {
    id: id || 'panel',
    kind: 'panel',
    parent: null,
    x, y, w, h, z: 0, visible: true,
    text: title || '',
  };
}

export function button(id, x, y, text, opts) {
  const o = opts || {};
  const ghost = o.ghost || false;
  const sz = ghost ? SIZES.buttonGhost : SIZES.button;
  return {
    id, kind: 'button', parent: o.parent || null,
    x, y, w: sz.w, h: sz.h, z: o.z === undefined ? 0 : o.z, visible: true,
    style: o.style || (ghost ? 'ghost' : 'default'), text, disabled: !!o.disabled,
    ...(o.action !== undefined ? { action: o.action } : {}),
    ...(o.goto !== undefined ? { goto: o.goto } : {}),
    ...(o.payload !== undefined ? { payload: o.payload } : {}),
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
  };
}