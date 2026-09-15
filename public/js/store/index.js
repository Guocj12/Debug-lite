'use strict';
/* store/index.js —— createStore：dispatch → reducer → 通知订阅 → 运行 effect（§4.2）。
 * effect 异常绝不抛穿 dispatch（经 store.effect.err 记录）；测试注入假 api/timers/log。
 */
export function createStore(options) {
  const opts = options || {};
  const reducer = opts.reducer;
  const effectMap = opts.effects || {};
  const log = opts.log || null;
  const timers = opts.timers || null;

  let state = { ...(typeof reducer === 'function' ? reducer(undefined, { type: '@@init' }) : {}), ...(opts.initialPatch || {}) };
  const subscribers = new Set();
  const getState = () => state;

  const ctx = {
    api: opts.api || null,
    state: getState,
    dispatch,
    log,
    persist: opts.persist || null,
    timers,
    dom: opts.dom || null,
  };

  function dispatch(action) {
    const a = action || { type: 'noop' };
    const next = reducer(state, a);
    state = next;
    const hasEffect = Object.prototype.hasOwnProperty.call(effectMap, a.type);
    log && log.debug('store', 'store.dispatch', a.type, { action: a.type, screen: state.screen, sideEffects: hasEffect });
    for (const fn of [...subscribers]) {
      try {
        fn(state);
      } catch (e) {
        log && log.error('store', 'store.effect.err', '订阅者异常', { message: (e && e.message) || String(e) });
      }
    }
    if (hasEffect) {
      const fn = effectMap[a.type];
      Promise.resolve()
        .then(() => fn(ctx, a))
        .catch((e) => {
          log && log.error('store', 'store.effect.err', `${a.type} 异常`, { message: (e && e.message) || String(e) });
        });
    }
    return a;
  }

  function subscribe(fn) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }

  return { dispatch, getState, subscribe };
}
