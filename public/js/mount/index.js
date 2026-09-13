// mount/index.js —— 唯一 DOM 写入点（frontend-spec §6.0/§3.5：挂载/事件委托/verifyLayout/日志）
import { boxesToHtml, collectBoxes, validateBoxIds } from './render.js';
import { routeEvent } from './delegate.js';
import { verifyLayout } from '../ui/verify.js';

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