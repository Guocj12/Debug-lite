'use strict';
/* js/app.js —— 启动流程（frontend-spec §1.3）：
 * 1) util/log 引导（模块加载即完成，util/log.js）→ 2) api client → 3) store（persist 读档）
 * → 4) views/mount（R2 接线）→ 5) boot 副作用（health/unlock）→ 6) store.boot 日志。
 * 测试可注入 {fetch, storage, log, timers, patch}；浏览器直接 start()。
 */
import { log } from './util/log.js';
import { createClient } from './api/client.js';
import { createPersist } from './store/persist.js';
import { reducer } from './store/reducer.js';
import { effects } from './store/effects.js';
import { createStore } from './store/index.js';

export function start(deps) {
  const d = deps || {};
  const logger = d.log || log;
  const storage = d.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const timers = d.timers || null;
  const persist = createPersist({ storage, log: logger, timers });
  const api = createClient({ fetch: d.fetch, log: logger });
  const store = createStore({
    reducer,
    effects: effects(),
    persist,
    api,
    log: logger,
    timers,
    initialPatch: { seed: persist.loadSeed(), ...persist.load(), ...(d.patch || {}) },
  });
  // seed 回带直连 store（T-AP-5）；boot 副作用随后
  api.setSeedHandler((seed) => store.dispatch({ type: 'seed/set', seed }));
  store.dispatch({ type: 'boot' });
  return { store, api, persist };
}

start();
