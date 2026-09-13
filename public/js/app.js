// app.js —— P6 启动（frontend-spec §1.3；F1：日志 + api + store + persist + boot 主流程；视图/挂载 F2 起）
// ESM 入口：public/index.html 的最后一个 script[module]。boot 可注入（测试覆盖全分支）。
import { log } from './util/log.js';
import { createApi } from './api/client.js';
import { createStore } from './store/index.js';
import { load as loadPersist, save as savePersist, SCHEMA_VERSION, STATE_KEY } from './store/persist.js';
import { renderScreen } from './views/index.js';

// §4.3 落盘时机（F2 审查 P1：seed/set 补齐——F1 审查「落实 6」声称已入但提交代码缺失，
// 非开箱流（ai/battle）seed 回带只进 state 不落盘；dl.v3.seed 键亦同步写入）
const SAVE_ON_ACTIONS = ['tier/set', 'wh/replaced', 'loadout/set', 'box/done', 'save/import', 'log/set', 'seed/set'];

export async function boot(deps) {
  const d = deps || {};
  const f = d.fetchImpl === undefined ? (typeof fetch === 'function' ? fetch : null) : d.fetchImpl;
  const lg = d.log || log;
  const win = d.win || (typeof window !== 'undefined' ? window : null);

  // 存档读取（schemaVersion 不符 → 视为无存档，§4.3 迁移/清空语义）
  const loadP = d.loadPersist || loadPersist;
  const persisted = loadP(win);
  const versionMismatch = !!(persisted && persisted.schemaVersion !== SCHEMA_VERSION);
  lg.info('store', 'store.boot', 'P6 bootstrap start', { phase: 'F2' }); // §1.3 启动日志
  if (versionMismatch) {
    lg.warn('store', 'store.boot', '存档版本不符，已清空', { schemaVersion: persisted.schemaVersion });
  }

  let lastAction = null;
  const api = d.api || createApi({ fetchImpl: f, log: lg });
  const records = d.records || (() => {
    const raw = lg && lg.raw;
    if (!raw) return [];
    // DLLog.createLogger 的 records 是活数组（shared/log.js api.records）——F2 审查 P1：原生机铁
    // typeof === 'function' 判断永假 → 浏览器日志面板恒 0 条；函数面保留给注入 logger
    if (typeof raw.records === 'function') return raw.records();
    if (Array.isArray(raw.records)) return raw.records;
    return [];
  });
  const store = createStore({
    api, log: lg,
    loadPersist: () => (versionMismatch ? null : loadP(win)),
    save: (state) => savePersist(win, state),
    records,
    doc: (d.doc === undefined ? (win ? win.document : null) : d.doc),
    preDispatch: (action) => { lastAction = action.type; },
    // §4.3：tier/warehouse/loadout/gacha.lastResult 变化后落盘（onChange 持新状态）
    onChange: (next) => {
      if (SAVE_ON_ACTIONS.includes(lastAction)) savePersist(win, next);
    },
  });
  // seed 回带（§5.6/T-AP-5：响应 data.seed → 状态 + 落盘）
  if (!d.api) api.setSeedHandler((seed) => store.dispatch({ type: 'seed/set', payload: { seed } }));

  // F2：挂载（浏览器 doc；node 下返回 {mounted:false, reason:'no-doc'}）
  const doc = d.doc === undefined ? (win ? win.document : null) : d.doc;
  let mount = null;
  if (doc && !d.skipMount) {
    const { mountApp } = await import('./mount/index.js');
    mount = mountApp({ doc, store, log: lg, records, renderScreen: d.renderScreen || renderScreen });
  }

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
  return { store, api, health, mount };
}

// 模块级启动（可注入 deps 测试；启动失败经日志通道报告，不静默、不产生未处理拒绝）
// F2 审查 P1：原 reportBootError 用 console.error —— public/js 全域无 console 铁律回归（F1 实证属性）；
// 改经注入 logger/模块 log 报 store.boot error（浏览器 DLLog 入环形缓冲，可 exportTrace 导出）。
export function start(deps) {
  const lg = (deps && deps.log) || log;
  const p = boot(deps);
  return p.catch((e) => {
    if (lg && lg.error) lg.error('store', 'store.boot', 'boot failed', { message: e && e.message });
  }); // 返回已处理的 promise（await 不抛）
}
start();