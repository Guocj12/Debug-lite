// mount/delegate.js —— 事件委托路由（frontend-spec §6：data-action/data-goto → dispatch；纯函数）
// 浏览器根监听 document click → routeEvent(target el)。el 需具备 .closest/.dataset（测试可注入桩）。

export function routeEvent(el, dispatch, log) {
  if (!el || typeof el.closest !== 'function') return null;
  const gotoEl = el.closest('[data-goto]');
  if (gotoEl && gotoEl.dataset && gotoEl.dataset.goto) {
    const screen = gotoEl.dataset.goto;
    if (log) log.debug('ui', 'ui.click', `goto ${screen}`, { screen, boxId: gotoEl.dataset.boxId || null });
    dispatch({ type: 'goto', payload: { screen } });
    return { kind: 'goto', screen };
  }
  const actEl = el.closest('[data-action]');
  if (actEl && actEl.dataset && actEl.dataset.action) {
    const action = actEl.dataset.action;
    let payload = null;
    if (actEl.dataset.payload !== undefined && actEl.dataset.payload !== '') {
      try {
        payload = JSON.parse(actEl.dataset.payload);
      } catch (e) {
        if (log) log.warn('ui', 'ui.click', `坏 payload: ${action}`, { action, message: e.message });
        return { kind: 'action', action, payload: null, badPayload: true };
      }
    }
    if (log) log.debug('ui', 'ui.click', `action ${action}`, { action, boxId: actEl.dataset.boxId || null });
    dispatch({ type: action, payload });
    return { kind: 'action', action, payload };
  }
  return null;
}