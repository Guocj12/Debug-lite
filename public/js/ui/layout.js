'use strict';
/* ui/layout.js —— 确定性盒模型工具与自检器（frontend-spec §3.3~§3.5）。
 * 布局计算只允许这里：grid/center/stack/panel 产出整数坐标 Box[]；verifyLayout 检出
 * clip（越界）/ overlap（同层重叠）/ zero（零尺寸）/ zconflict（父子层序颠倒）。
 * 纯函数：jsdom 无布局引擎也能断言。
 */
import { VIEW } from './sizes.js';

const r = (n) => Math.round(Number(n) || 0);

// 基础盒：坐标取整 + 默认值归一（id/kind 必填）
export function box(id, kind, x, y, w, h, opts) {
  const o = opts || {};
  return {
    id, kind,
    parent: o.parent || null,
    x: r(x), y: r(y), w: r(w), h: r(h),
    z: o.z === undefined ? 3 : o.z,
    visible: o.visible === false ? false : true,
    ...o,
  };
}

// 网格：坐标 = x0+(i%cols)*(cellW+gap), y0+floor(i/cols)*(cellH+gap)（§3.4）
// items: [{id, ...rest}]；额外字段透传（text/action/data...）
export function grid(x0, y0, cols, cellW, cellH, gap, items, opts) {
  const o = opts || {};
  const out = [];
  const list = items || [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const x = r(x0 + (i % cols) * (cellW + gap));
    const y = r(y0 + Math.floor(i / cols) * (cellH + gap));
    out.push({ ...it, id: it.id || `cell_${i}`, kind: it.kind || 'cell', x, y, w: r(it.w || cellW), h: r(it.h || cellH), z: it.z === undefined ? 3 : it.z, parent: o.parent || null, visible: it.visible === false ? false : true });
  }
  return out;
}

// 居中：父盒或视口内 (W-w)/2, (H-h)/2 整数
export function center(w, h, parent) {
  const W = (parent && parent.w) || VIEW.w;
  const H = (parent && parent.h) || VIEW.h;
  return { x: r((W - w) / 2), y: r((H - h) / 2) };
}

// 纵向排列：y0 起，逐项累加 gap；items 需自带 x/w/h（§3.4）
export function stack(y0, items, opts) {
  const o = opts || {};
  const gap = o.gap === undefined ? 12 : o.gap;
  const out = [];
  let y = r(y0);
  for (const it of items || []) {
    out.push({ ...it, y });
    y = r(y + (it.h || 0) + gap);
  }
  return out;
}

// 面板盒（z=2 层；细边框由 CSS 承担）
export function panel(id, x, y, w, h, title) {
  return box(id, 'panel', x, y, w, h, { z: 2, text: title || null });
}

// 按钮盒：primary/danger 160×40，ghost 96×32（§3.2）；payload/valueKey/options 透传
export function button(id, x, y, opts) {
  const o = opts || {};
  const size = o.style === 'ghost' ? { w: 96, h: 32 } : { w: 160, h: 40 };
  return box(id, 'button', x, y, size.w, size.h, {
    style: o.style || 'primary', text: o.text || id, action: o.action || null,
    payload: o.payload, valueKey: o.valueKey, options: o.options, value: o.value,
    z: o.z === undefined ? 4 : o.z, disabled: !!o.disabled,
  });
}

function covers(viewW, viewH, b) {
  return b.x <= 0 && b.y <= 0 && b.w >= viewW && b.h >= viewH;
}

function parentsOf(map, id) {
  const chain = [];
  let cur = map.get(id);
  while (cur !== undefined && cur !== null && chain.length < 32) {
    chain.push(cur);
    cur = map.get(cur);
  }
  return chain;
}

function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// 自检器（§3.5）：clip/overlap/zero/zconflict → [{boxId, issue, detail}]
export function verifyLayout(boxes, opts) {
  const o = opts || {};
  const view = { w: o.viewW || VIEW.w, h: o.viewH || VIEW.h };
  const issues = [];
  const list = boxes || [];
  const byId = new Map(list.map((b) => [b.id, b]));
  const parentOf = new Map(list.map((b) => [b.id, b.parent || null]));
  const ancestors = new Map(); // id → Set(祖先 id)
  for (const b of list) ancestors.set(b.id, new Set(parentsOf(parentOf, b.id)));

  for (const b of list) {
    if (b.w <= 0 || b.h <= 0) {
      issues.push({ boxId: b.id, issue: 'zero', detail: `w=${b.w},h=${b.h}` });
    }
    const fullscreenMask = (b.kind === 'mask' || b.kind === 'modal') && covers(view.w, view.h, b);
    if (!fullscreenMask && (b.x < 0 || b.y < 0 || b.x + b.w > view.w || b.y + b.h > view.h)) {
      issues.push({ boxId: b.id, issue: 'clip', detail: `x=${b.x},y=${b.y},w=${b.w},h=${b.h}` });
    }
  }
  // 同 z 可见盒两两相交（父子/祖先链除外）
  const vis = list.filter((b) => b.visible !== false && b.w > 0 && b.h > 0);
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i];
      const c = vis[j];
      if (a.z !== c.z) continue;
      if (ancestors.get(a.id).has(c.id) || ancestors.get(c.id).has(a.id)) continue;
      if (intersects(a, c)) {
        issues.push({ boxId: `${a.id}~${c.id}`, issue: 'overlap', detail: `z=${a.z} 同层相交 (${a.id}×${c.id})` });
      }
    }
  }
  // 父子 z 颠倒（子 z < 父 z 才判颠倒；同层父子为正常 DOM 嵌套——见 docs/rewrite-issues.md RW-4）
  for (const b of list) {
    if (b.parent === null || b.parent === undefined) continue;
    const p = byId.get(b.parent);
    if (!p) continue; // 悬挂引用由 zero/其他检查覆盖
    if (b.z < p.z) issues.push({ boxId: b.id, issue: 'zconflict', detail: `子 z=${b.z} < 父 z=${p.z}` });
  }
  return issues;
}
