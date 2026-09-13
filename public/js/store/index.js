// store/index.js —— 自研 store（frontend-spec §4；唯一状态源；reducer+effects 分离）
import { reducer, initialState } from './reducer.js';
import { runEffect } from './effects.js';

function normWh(w) {
  if (w && w.buckets) return w;
  if (w) return { buckets: { role: w.role || [], skill: w.skill || [], rolePlugin: w.rolePlugin || [], skillPlugin: w.skillPlugin || [] } };
  return { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
}

export function createStore(opts) {
  const o = opts || {};
  const initial = o.state || (o.loadPersist && o.loadPersist() ? mergePersist(initialState(), o.loadPersist()) : initialState());
  let state = initial;
  const listeners = [];
  const ctx = {
    api: o.api,
    store: () => state,
    dispatch: (action) => dispatch(action),
    log: o.log || null,
    save: o.save || null,
    records: o.records || null, // 日志面板数据源（F2）
    doc: o.doc || null, // 导出下载等浏览器副作用（F2）
  };
  function mergePersist(base, data) {
    return {
      ...base,
      tier: data.tier || base.tier,
      warehouse: normWh(data.warehouse), // F1 P1-1：旧扁平形状归一化
      loadout: { role: data.loadout && data.loadout.role !== undefined ? data.loadout.role : base.loadout.role, skills: data.loadout && data.loadout.skills || base.loadout.skills, ai: data.loadout && data.loadout.ai !== undefined ? data.loadout.ai : base.loadout.ai },
      gacha: { ...base.gacha, lastResult: data.gachaLastResult || null },
      seed: data.seed === undefined ? base.seed : data.seed,
      logPrefs: data.logPrefs || base.logPrefs,
    };
  }
  function dispatch(action) {
    if (o.preDispatch) o.preDispatch(action, state);
    const next = reducer(state, action);
    if (next !== state) {
      state = next;
      for (const l of listeners) l(state);
      if (o.onChange) o.onChange(state, action);
    }
    if (o.log) o.log.debug('store', 'store.dispatch', action.type, { type: action.type });
    // 带动效的 action 同步跑 effect（异步内部自行 dispatch）
    runEffect(ctx, action);
  }
  return {
    getState: () => state,
    dispatch,
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
  };
}