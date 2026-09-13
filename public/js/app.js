// app.js —— P6 启动（frontend-spec §1.3；F1：日志 + api + store + persist + boot 主流程；视图/挂载 F2 起）
// ESM 入口：public/index.html 的最后一个 script[module]。boot 可注入（测试覆盖全分支）。
import { log } from './util/log.js';
import { createApi } from './api/client.js';
import { createStore } from './store/index.js';
import { load as loadPersist, save as savePersist, SCHEMA_VERSION, STATE_KEY } from './store/persist.js';

const SAVE_ON_ACTIONS = ['tier/set', 'wh/replaced', 'loadout/set', 'box/done', 'save/import', 'log/set']; // §4.3 落盘时机

export function boot(deps) {
  const d = deps || {};
  const f = d.fetchImpl === undefined ? (typeof fetch === 'function' ? fetch : null) : d.fetchImpl;
  const lg = d.log || log;
  const win = d.win || (typeof window !== 'undefined' ? window : null);

  // 存档读取（schemaVersion 不符 → 视为无存档，§4.3 迁移/清空语义）
  const loadP = d.loadPersist || loadPersist;
  const persisted = loadP(win);
  const versionMismatch = !!(persisted && persisted.schemaVersion !== SCHEMA_VERSION);
  if (versionMismatch) {
    lg.warn('store', 'store.boot', '存档版本不符，已清空', { schemaVersion: persisted.schemaVersion });
  }

  let lastAction = null;
  const api = d.api || createApi({ fetchImpl: f, log: lg });
  const store = createStore({
    api, log: lg,
    loadPersist: () => (versionMismatch ? null : loadP(win)),
    save: (state) => savePersist(win, state),
    preDispatch: (action) => { lastAction = action.type; },
    // §4.3：tier/warehouse/loadout/gacha.lastResult 变化后落盘（onChange 持新状态）
    onChange: (next) => {
      if (SAVE_ON_ACTIONS.includes(lastAction)) savePersist(win, next);
    },
  });
  // seed 回带（§5.6/T-AP-5：响应 data.seed → 状态 + 落盘）
  if (!d.api) api.setSeedHandler((seed) => store.dispatch({ type: 'seed/set', payload: { seed } }));

  // 服务端健康检查（异步；失败不阻塞界面）
  const health = (f || (() => Promise.reject(new Error('no fetch'))))('/api/v1/health')
    .then((r) => r.json())
    .then((data) => {
      store.dispatch({ type: 'meta/loaded', payload: { ok: !!data.ok, version: data.data && data.data.version, tableNames: data.data && data.data.tableNames } });
      lg.info('store', 'store.boot', 'server ok', { ok: !!data.ok });
    })
    .catch((e) => {
      lg.warn('store', 'store.boot', 'server unreachable', { message: e.message });
      return null;
    });

  store.dispatch({ type: 'goto', payload: { screen: 'menu' } });
  lg.debug('store', 'store.boot', 'boot complete', { screen: store.getState().screen, schemaVersion: SCHEMA_VERSION, stateKey: STATE_KEY });
  return { store, api, health };
}

boot();