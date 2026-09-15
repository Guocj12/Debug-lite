// mount/index.js —— 唯一 DOM 写入点（frontend-spec §6.0/§3.5：挂载/事件委托/verifyLayout/日志）
import { boxesToHtml, collectBoxes, validateBoxIds } from './render.js';
import { measureRects, compareRects } from './measure.js';
import { routeEvent } from './delegate.js';
import { verifyLayout } from '../ui/verify.js';
import { planFrame } from '../render/planFrame.js';
import { planTrail } from '../render/trail.js';
import { paintCanvas } from './canvas.js';
import { createEditor, presetLoop, highlightByPath } from '../editor/main.js';
import { registerBlockTypes } from '../editor/blocks.js'; // F7：自定义块注册（对准 bridge 16 块型；幂等）

// F5 审查 P1：盒坐标注入——.dl-box 携带 data-box-* 坐标，但此前无任何代码把坐标落到元素几何
// （style.css 注释「坐标由布局层注入（JS 写 position/left/top/width/height），CSS 只负责视觉」从未实现）
// → 所有盒子在浏览器视觉堆叠于 (0,0)，F2~F5 各屏全部不可见。此处补齐为唯一注入点（mount=唯一 DOM 写入层）。
// 防御冗余说明：boxes 恒为 collectBoxes 数组、id 恒非空、x/y/w/h/z 经 num() 恒为数字、doc.getElementById
// 由 mountApp 入口守卫——故不再叠 ||[]/||0/三元兜底（F5 审查分支净化）。
// ui.layout 日志摘要（§2.2 必含字段 id/x/y/w/h/z/visible；text 不入日志避免噪声膨胀）
function rectBrief(b) {
  return { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, z: b.z, visible: b.visible };
}

function injectBoxGeom(doc, boxes) {
  let n = 0;
  for (const b of boxes) {
    // ★F8 修复：getElementById 依赖 id 属性——boxToHtml 已补 id（此前只写 data-box-id → 全部取空 → 不注入几何）
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
  let editorHandle = null; // F6：Blockly 编辑器句柄（editor 屏装配一次；离屏 dispose）

  function paint() {
    const st = store.getState();
    const r = render(st, { records });
    const all = [...(r.shell || []), ...(r.main || [])];
    // F6：blocklyDiv 为 body 级骨架元素（Blockly 独占其内部 DOM，§6.2）——从 #app 渲染剔除同 id 盒：
    // 否则产生双重 id（getElementById 取到 #app 内瞬态盒）且 innerHTML 重建会摧毁 Blockly 工作区。
    const html = boxesToHtml(all.filter((b) => b.id !== 'blocklyDiv'));
    app.innerHTML = html;
    const boxes = collectBoxes(html);
    const ids = validateBoxIds(boxes);
    if (!ids.ok && log) log.warn('ui', 'ui.layout.report', `重复盒子 id: ${ids.dups.join(',')}`, { dups: ids.dups });
    lastVerify = verifyLayout(boxes);
    if (!lastVerify.ok && log) log.warn('ui', 'ui.layout.report', `布局自检 ${lastVerify.issues.length} 项`, { issues: lastVerify.issues.slice(0, 8) });
    injectBoxGeom(doc, boxes);
    // §2.2/§2.3 像素级日志：ui.layout（每次布局后的坐标事实源）+ ui.rect（实测校准，>1px 偏差入 report）
    if (log) log.debug('ui', 'ui.layout', `ui.layout ${st.screen}`, { view: st.screen, boxes: boxes.map(rectBrief) });
    const rects = measureRects(doc);
    if (rects.size > 0) {
      const cmp = compareRects(boxes, rects);
      if (log) log.debug('ui', 'ui.rect', `ui.rect ${st.screen}，实测 ${rects.size} 盒，偏差 ${cmp.dev.length}`, { view: st.screen, measured: rects.size, dev: cmp.dev, missing: cmp.missing });
      if (cmp.dev.length > 0 && log) log.warn('ui', 'ui.layout.report', `实测矩形与盒坐标偏差 ${cmp.dev.length} 项（>1px）`, { issues: cmp.dev.slice(0, 8) });
    }
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
    // F6：Blockly 编辑器装配点（§6.2）——#blocklyDiv 为 index.html body 级骨架（同 #battle 画布模式：
    // 在 #app 之外，paint 的 innerHTML 重建不触碰 Blockly 内部 DOM，§6.2「mount 不触碰 workspace 内部」）。
    // editor 屏：显示/定位（坐标来自 blocklyDiv 盒）→ Blockly 存在则装配一次（createEditor + D-100 presetLoop）
    // → 消费 errors 行点击（aiDraft.highlightPath → highlightByPath；未找到 → toast「程序已变化」）；离屏 dispose。
    const editorEl = doc.getElementById('blocklyDiv');
    const editorBox = all.find((b) => b.id === 'blocklyDiv');
    if (st.screen === 'editor' && editorBox) {
      if (editorEl && editorEl.style) {
        editorEl.style.display = 'block';
        editorEl.style.position = 'absolute';
        editorEl.style.left = `${editorBox.x}px`;
        editorEl.style.top = `${editorBox.y}px`;
        editorEl.style.width = `${editorBox.w}px`;
        editorEl.style.height = `${editorBox.h}px`;
        editorEl.style.zIndex = String(editorBox.z);
      }
      const B = (typeof globalThis !== 'undefined' && globalThis.Blockly) ? globalThis.Blockly : null;
      // F7：Blockly.Blocks 注册（幂等，null/无 Blocks 安全）——presetLoop newBlock('loop_forever') 依赖
      // 块定义（F6 P2-1：未注册类型 → Blockly 抛错 → 根循环不落座）；注册 16 型与 bridge 词汇一一对应。
      registerBlockTypes(B);
      if (B && !editorHandle) {
        editorHandle = createEditor({
          Blockly: B, container: editorEl, dispatch: (a) => store.dispatch(a), debounceMs: 300,
        });
        if (editorHandle.created) presetLoop(B, editorHandle.widget);
      }
      const hl = st.aiDraft && st.aiDraft.highlightPath;
      if (hl && editorHandle && editorHandle.created) {
        const id = highlightByPath(editorHandle.widget, editorHandle.programRoot(), hl);
        store.dispatch({ type: 'editor/highlight/done' });
        if (!id) store.dispatch({ type: 'ui/toast', payload: { text: '程序已变化', kind: 'warn' } });
      } else if (hl) {
        // Blockly 未装配（脚本未加载/inject 失败）→ 仍清空瞬时态防陈旧（高亮行为让位于下一次装配）
        store.dispatch({ type: 'editor/highlight/done' });
      }
    } else {
      if (editorEl && editorEl.style) editorEl.style.display = 'none';
      if (editorHandle) { editorHandle.dispose(); editorHandle = null; }
    }
    // F5：回放屏画布绘制（画布盒存在 → #battle 元素 → planFrame 图元 + F7 planTrail 轨迹；no-ctx 安全跳过）
    if (st.screen === 'replay') {
      const el = canvasBox && canvasEl ? canvasEl : null;
      if (el) {
        const frames = st.battle.frames;
        const tick = st.battle.tick || 0;
        const frame = frames[tick];
        const prims = planFrame(frame && frame.diff, tick).concat(planTrail(frames, tick, 'p1')).concat(planTrail(frames, tick, 'p2'));
        const res = paintCanvas(el, prims, {});
        if (log) log.debug('render', 'render.frame', `canvas ${res.painted ? res.count : res.reason}`, { tick, painted: res.painted });
      }
    }
    if (log) log.debug('render', 'render.frame', `paint ${st.screen}`, { screen: st.screen, boxes: boxes.length, issues: lastVerify.issues.length });
    renderToasts(st.ui && st.ui.snackbar);
    return { boxes, verify: lastVerify };
  }

  const onClick = (evt) => {
    const t = evt && evt.target;
    routeEvent(t, (action) => store.dispatch(action), log);
  };
  doc.addEventListener('click', onClick);
  // Esc → 返回主菜单（screens.md 各屏盒子表未列导航盒 → 用键盘逃生；否则除回放屏外无处可退）
  const onKey = (evt) => {
    if (evt && evt.key === 'Escape') store.dispatch({ type: 'goto', payload: { screen: 'menu' } });
  };
  doc.addEventListener('keydown', onKey);

  // toast 挂载区（#dl-toasts）
  let toastsEl = doc.getElementById('dl-toasts');
  if (!toastsEl && typeof doc.createElement === 'function') {
    toastsEl = doc.createElement('div');
    toastsEl.id = 'dl-toasts';
    if (app.parentNode && app.parentNode.appendChild) app.parentNode.appendChild(toastsEl);
  }
  const seenToasts = new Set();
  const toastMs = typeof o.toastMs === 'number' ? o.toastMs : 3000; // §3.2「3s 自动消失」（测试注入小值）
  // snackbar → DOM（此前 state.ui.snackbar 只进状态、无任何渲染 → 失败/成功提示在界面上完全不可见）
  // 生命周期与 DOM 解耦：首次见到的 toast 一律调度消散（无容器环境也保持状态收敛）
  function renderToasts(list) {
    const canRender = !!toastsEl && typeof toastsEl.appendChild === 'function' && typeof doc.createElement === 'function';
    if (canRender) toastsEl.innerHTML = '';
    for (const t of list || []) {
      if (!seenToasts.has(t.id)) {
        seenToasts.add(t.id);
        const timer = setTimeout(() => store.dispatch({ type: 'ui/toast/dismiss', payload: { id: t.id } }), toastMs);
        if (timer && typeof timer.unref === 'function') timer.unref(); // node 测试不留悬挂句柄
        if (log) log.debug('ui', 'ui.toast', t.text, { id: t.id, kind: t.kind || 'info' });
      }
      if (!canRender) continue;
      const el = doc.createElement('div');
      el.className = `dl-toast dl-${t.kind || 'info'}`;
      el.textContent = t.text;
      toastsEl.appendChild(el);
    }
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
      if (doc.removeEventListener) doc.removeEventListener('keydown', onKey);
    },
  };
}