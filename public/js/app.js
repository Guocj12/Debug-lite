'use strict';
/* js/app.js —— 启动流程（frontend-spec §1.3）：
 * 1) util/log 引导（模块加载即完成，util/log.js）→ 2) api client → 3) store（persist 读档）
 * → 4) views/mount 挂到 #app（editor 屏经 editorFactory 动态加载 Blockly）→ 5) boot 副作用
 * （health/unlock）→ 6) store.boot 日志。测试可注入 {fetch, storage, log, timers, patch, doc}；
 * 浏览器直接 start()。
 */
import { log } from './util/log.js';
import { createClient } from './api/client.js';
import { createPersist } from './store/persist.js';
import { reducer } from './store/reducer.js';
import { effects } from './store/effects.js';
import { createStore } from './store/index.js';
import { renderScreen } from './views/index.js';
import { mountApp } from './mount/index.js';
import { createDomHelpers } from './mount/dom.js';
import { registerBlocks } from './editor/blocks.js';
import { wireEditor } from './mount/editor.js';

// editor 屏 Blockly 装配（浏览器：动态加载 /vendor/blockly/blockly.mjs，spec §1.1 静态路由；失败 → 占位不炸）
function editorFactory(ctx) {
  const { doc, store, log, timers } = ctx;
  return import(ctx.blocklyUrl || '/vendor/blockly/blockly.mjs')
    .then((blocklyMod) => wireEditor({
      doc,
      store,
      log,
      blockly: blocklyMod && (blocklyMod.default || blocklyMod),
      registerBlocks,
      timers,
    }))
    .catch((e) => {
      log && log.warn('editor', 'editor.block.pos', 'Blockly 加载失败', { message: (e && e.message) || String(e) });
      return null;
    });
}

export function start(deps) {
  const d = deps || {};
  const logger = d.log || log;
  const storage = d.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
  const timers = d.timers || null;
  const doc = d.doc || (typeof document !== 'undefined' ? document : null);
  const persist = createPersist({ storage, log: logger, timers });
  const api = createClient({ fetch: d.fetch, log: logger });
  const store = createStore({
    reducer,
    effects: effects(),
    persist,
    api,
    log: logger,
    timers,
    dom: doc ? createDomHelpers(doc) : null,
    initialPatch: { seed: persist.loadSeed(), ...persist.load(), ...(d.patch || {}) },
  });
  // seed 回带直连 store（T-AP-5）
  api.setSeedHandler((seed) => store.dispatch({ type: 'seed/set', seed }));
  const root = doc && doc.getElementById ? doc.getElementById('app') : null;
  const mount = mountApp({
    root, store, renderScreen, log: logger, doc,
    editorFactory: (ctx) => editorFactory({ ...ctx, blocklyUrl: d.blocklyUrl }),
  });
  store.dispatch({ type: 'boot' });
  return { store, api, persist, mount };
}

start();
