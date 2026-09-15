// mount/measure.js —— 实测矩形采集 + 盒坐标偏差核对（frontend-spec §2.3「实测校准」/§10.1 标准动作 1）
// 设计：DOM 读取窄接口（querySelectorAll + getBoundingClientRect）与判定（纯函数 compareRects）分离——
// 判定可在 node 下用构造的 Map 断言，采集用假 doc 断言；浏览器实跑差异 >1px 时由 mount 打 warn（§2.3）。
export const RECT_TOLERANCE = 1; // §6「允许 ≤1px 实现差异」

function round2(n) {
  return Math.round(n * 100) / 100;
}

// 采集：所有 [data-box-id] 元素的实测矩形（视口坐标系 → 文档坐标系，抵消滚动，与 Box.x/y 同口径）。
// 无 DOM 能力（node/jsdom 假 doc）→ 空 Map（不抛）。
export function measureRects(doc) {
  const out = new Map();
  if (!doc || typeof doc.querySelectorAll !== 'function') return out;
  const view = doc.defaultView || null;
  const sx = view && typeof view.scrollX === 'number' ? view.scrollX : 0;
  const sy = view && typeof view.scrollY === 'number' ? view.scrollY : 0;
  for (const el of doc.querySelectorAll('[data-box-id]')) {
    const id = el && el.dataset ? el.dataset.boxId : null;
    if (!id || typeof el.getBoundingClientRect !== 'function') continue;
    const r = el.getBoundingClientRect();
    out.set(id, { x: round2(r.left + sx), y: round2(r.top + sy), w: round2(r.width), h: round2(r.height) });
  }
  return out;
}

// 判定（纯）：盒坐标 vs 实测矩形 → { dev:[{boxId,dx,dy,dw,dh}], missing:[id] }
// 跳过 visible:false 的盒（.dl-hidden → 实测 0×0，不是偏差；§3.5「visible===false 但被引用」由自检器管）。
export function compareRects(boxes, rects, tol) {
  const t = typeof tol === 'number' ? tol : RECT_TOLERANCE;
  const dev = [];
  const missing = [];
  for (const b of boxes || []) {
    if (!b || !b.id) continue;
    if (!rects || typeof rects.get !== 'function') continue;
    const r = rects.get(b.id);
    if (!r) {
      if (b.visible !== false) missing.push(b.id);
      continue;
    }
    if (b.visible === false) continue;
    const dx = round2(r.x - b.x);
    const dy = round2(r.y - b.y);
    const dw = round2(r.w - b.w);
    const dh = round2(r.h - b.h);
    if (Math.abs(dx) > t || Math.abs(dy) > t || Math.abs(dw) > t || Math.abs(dh) > t) {
      dev.push({ boxId: b.id, dx, dy, dw, dh });
    }
  }
  return { dev, missing };
}
