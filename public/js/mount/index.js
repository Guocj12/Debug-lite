// mount/index.js —— 唯一 DOM 写入点（frontend-spec §6.0/§3.5：挂载/事件委托/verifyLayout/日志）
import { boxesToHtml, collectBoxes, validateBoxIds } from './render.js';
import { routeEvent } from './delegate.js';
import { verifyLayout } from '../ui/verify.js';
import { planFrame } from '../render/planFrame.js';
import { paintCanvas } from './canvas.js';

// F5 审查 P1：盒坐标注入——.dl-box 携带 data-box-* 坐标，但此前无任何代码把坐标落到元素几何
// （style.css 注释「坐标由布局层注入（JS 写 position/left/top/width/height），CSS 只负责视觉」从未实现）
// → 所有盒子在浏览器视觉堆叠于 (0,0)，F2~F5 各屏全部不可见。此处补齐为唯一注入点（mount=唯一 DOM 写入层）。
// 防御冗余说明：boxes 恒为 collectBoxes 数组、id 恒非空、x/y/w/h/z 经 num() 恒为数字、doc.getElementById
// 由 mountApp 入口守卫——故不再叠 ||[]/||0/三元兜底（F5 审查分支净化）。
function injectBoxGeom(doc, boxes) {
  let n = 0;
  for (const b of boxes) {
    const el = doc.getElementById(b.id);
    if (!el || !el.style) continue;
    el.style.position = 'absolute';
    el.style.left = `${b.x}px`;
    el.style.top = `${b.y}px`;
    el.style.width = `${b.w}px`;
    el.style.height = `${b.h}px`;
    el.style.zIndex = String(b.z);
    n++;
  }
  return n;
}

export function mountApp(deps) {
  const o = deps || {};
  const doc = o.doc || null;
  const log = o.log || null;
  if (!doc || typeof doc.getElementById !== 'function') return { mounted: false, reason: 'no-doc' };
  const app = doc.getElementById('app');
  if (!app) return { mounted: false, reason: 'no-app' };
  const store = o.store;
  const render = o.renderScreen; // (state, opts) → {shell, main}
  const records = () => (typeof o.records === 'function' ? o.records() : []);
  let lastVerify = { ok: true, issues: [] };

  function paint() {
    const st = store.getState();
    const r = render(st, { records });
    const html = boxesToHtml([...(r.shell || []), ...(r.main || [])]);
    app.innerHTML = html;
    const boxes = collectBoxes(html);
    const ids = validateBoxIds(boxes);
    if (!ids.ok && log) log.warn('ui', 'ui.layout.report', `重复盒子 id: ${ids.dups.join(',')}`, { dups: ids.dups });
    lastVerify = verifyLayout(boxes);
    if (!lastVerify.ok && log) log.warn('ui', 'ui.layout.report', `布局自检 ${lastVerify.issues.length} 项`, { issues: lastVerify.issues.slice(0, 8) });
    injectBoxGeom(doc, boxes);
    // F5 审查 P1：#battle 画布（index.html 骨架，原 display:none 且无定位——回放绘制在浏览器不可见；
    // 回放屏时按画布盒定位显示，其余屏隐藏；getElementById 由入口守卫保证存在）
    const canvasEl = doc.getElementById('battle');
    const canvasBox = boxes.find((b) => b.kind === 'canvas');
    if (canvasEl && canvasEl.style) {
      if (st.screen === 'replay' && canvasBox) {
        canvasEl.style.display = 'block';
        canvasEl.style.position = 'absolute';
        canvasEl.style.left = `${canvasBox.x}px`;
        canvasEl.style.top = `${canvasBox.y}px`;
        canvasEl.style.width = `${canvasBox.w}px`;
        canvasEl.style.height = `${canvasBox.h}px`;
        canvasEl.style.zIndex = String(canvasBox.z);
      } else {
        canvasEl.style.display = 'none';
      }
    }
    // F5：回放屏画布绘制（画布盒存在 → #battle 元素 → planFrame 图元；no-ctx（测试/doc 缺 canvas）安全跳过）
    if (st.screen === 'replay') {
      const el = canvasBox && canvasEl ? canvasEl : null;
      if (el) {
        const frames = st.battle.frames;
        const frame = frames[st.battle.tick || 0];
        const res = paintCanvas(el, planFrame(frame && frame.diff, st.battle.tick || 0), {});
        if (log) log.debug('render', 'render.frame', `canvas ${res.painted ? res.count : res.reason}`, { tick: st.battle.tick || 0, painted: res.painted });
      }
    }
    if (log) log.debug('render', 'render.frame', `paint ${st.screen}`, { screen: st.screen, boxes: boxes.length, issues: lastVerify.issues.length });
    return { boxes, verify: lastVerify };
  }

  const onClick = (evt) => {
    const t = evt && evt.target;
    routeEvent(t, (action) => store.dispatch(action), log);
  };
  doc.addEventListener('click', onClick);

  // toast 挂载区（#dl-toasts）
  let toastsEl = doc.getElementById('dl-toasts');
  if (!toastsEl && typeof doc.createElement === 'function') {
    toastsEl = doc.createElement('div');
    toastsEl.id = 'dl-toasts';
    if (app.parentNode && app.parentNode.appendChild) app.parentNode.appendChild(toastsEl);
  }

  const unsubscribe = store.subscribe(() => paint());
  paint();
  return {
    mounted: true,
    paint,
    lastVerify: () => lastVerify,
    toastsEl: toastsEl || null,
    handleClick: onClick, // 测试钩子（事件委托路由）
    unsubscribe: () => {
      unsubscribe();
      if (doc.removeEventListener) doc.removeEventListener('click', onClick);
    },
  };
}