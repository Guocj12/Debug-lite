'use strict';
/* mount/index.js —— 唯一 DOM 写入点（frontend-spec §6.0/§7 装配约定）。
 * mountApp：订阅 store → paint（innerHTML + verifyLayout + ui.layout 日志）+ 事件委托
 * （click/change → data-action + data-payload → dispatch）；toast 容器随 paint 更新。
 * doc 注入缝：测试可用假 document；无 root 直接跳过（node 环境）。
 */
import { verifyLayout } from '../ui/layout.js';
import { collectBoxes } from '../views/html.js';
import { injectCanvas } from './canvas.js';
import { wireEditor } from './editor.js';
import { createDomHelpers } from './dom.js';

const TOAST_MS = 3000;

export function routeEvent(target) {
  let node = target;
  while (node) {
    if (node.dataset && node.dataset.action) {
      let payload = {};
      try {
        payload = node.dataset.payload ? JSON.parse(node.dataset.payload) : {};
      } catch (e) {
        payload = {}; // 坏 payload 不抛，按空处理
      }
      return { type: node.dataset.action, valueKey: node.dataset.valueKey || null, ...payload };
    }
    node = node.parentElement;
  }
  return null;
}

export function mountApp(options) {
  const opts = options || {};
  const root = opts.root || null;
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  const store = opts.store || null;
  const log = opts.log || null;
  const renderScreen = opts.renderScreen || null;
  if (!root || !store || !renderScreen) return null; // no-doc/no-app 跳过

  let editorCtl = null;

  function paint() {
    const state = store.getState();
    const html = renderScreen(state.screen, state, { records: () => (log ? log.dump() : []), log });
    root.innerHTML = html;
    const boxes = collectBoxes(html);
    const issues = verifyLayout(boxes);
    log && log.debug('ui', 'ui.layout', state.screen, { view: state.screen, boxes: boxes.map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, z: b.z, visible: b.visible })) });
    if (issues.length) log && log.warn('ui', 'ui.layout.report', `${issues.length} 个布局问题`, { issues: issues.slice(0, 10) });
    if (typeof window !== 'undefined') window.__DL_LAST_BOXES__ = boxes;
    renderToasts(doc, state.ui.snackbar);
    injectCanvas(doc, state, { log });
    // editor 屏：入屏装配 / 离屏销毁（mount 独占 Blockly DOM；editorFactory 注入缝）
    if (state.screen === 'editor' && !editorCtl && opts.editorFactory) {
      editorCtl = opts.editorFactory({ doc, store, log, root }) || null;
    } else if (state.screen !== 'editor' && editorCtl) {
      editorCtl.dispose();
      editorCtl = null;
    }
  }

  // 事件委托（click/change 均走 data-action；change 场景从 target.value 取参）
  function handler(eventName) {
    return (ev) => {
      const t = ev && ev.target ? ev.target : null;
      if (!t || !t.dataset) return;
      const action = routeEvent(t);
      if (!action) return;
      log && log.debug('ui', 'ui.click', `${eventName} ${action.type}`, { boxId: t.dataset.boxId || null, x: ev.clientX, y: ev.clientY });
      if (eventName === 'change') {
        if (t.tagName === 'INPUT' && t.type === 'text') action.seed = t.value === '' ? null : Number(t.value) || 0;
        if (t.tagName === 'INPUT' && t.type === 'range') action[action.valueKey || 'tick'] = Number(t.value) || 0;
        if (t.tagName === 'SELECT') action[action.valueKey || 'tier'] = t.value;
      }
      if (action.type === 'save/import' && eventName === 'click') {
        // 存档导入（§8）：文件选择器缝（用户取消 → 不 dispatch）
        const dom = opts.dom || createDomHelpers(doc);
        const text = dom.pickText ? dom.pickText() : Promise.resolve('');
        Promise.resolve(text).then((picked) => {
          if (picked === null || picked === undefined) return;
          store.dispatch({ type: 'save/import', text: picked });
        });
        return;
      }
      store.dispatch(action);
    };
  }
  root.addEventListener('click', handler('click'));
  root.addEventListener('change', handler('change'));

  const off = store.subscribe(() => paint());
  paint();
  return { paint, off };
}

// toast 渲染（spec §3.2 Toast 320×48 右上；#dl-toasts 由 paint 重建）
function renderToasts(doc, list) {
  if (!doc || !doc.getElementById) return;
  const host = doc.getElementById('dl-toasts');
  if (!host) return;
  host.innerHTML = (list || []).map((t) => `<div class="dl-toast ${t.kind === 'error' ? 'dl-error' : ''}"><span>${String(t.text).replace(/[<>&]/g, '')}</span></div>`).join('');
}
