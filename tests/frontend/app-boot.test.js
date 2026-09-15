'use strict';
// P6 R1 app.js 启动流程契约测试 —— spec §1.3（log 引导/api/persist 读档/boot 副作用/seed 回带）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let start;
before(async () => {
  ({ start } = await import('../../public/js/app.js'));
});

function sink() {
  const rec = [];
  const log = {
    debug: (c, e, m, d) => rec.push({ lv: 'debug', c, e, m, d }),
    info: (c, e, m, d) => rec.push({ lv: 'info', c, e, m, d }),
    warn: (c, e, m, d) => rec.push({ lv: 'warn', c, e, m, d }),
    error: (c, e, m, d) => rec.push({ lv: 'error', c, e, m, d }),
    setLevel: () => {}, setChannelLevel: () => {},
  };
  return { rec, log };
}

function okEnvelope(data) {
  return { status: 200, json: async () => ({ ok: true, data, log: { level: 'debug', events: [] } }) };
}

test('R0/R1 app：start() 为引导入口且模块加载即执行（noop 环境）', async () => {
  assert.equal(typeof start, 'function');
  assert.doesNotThrow(() => start());
});

test('R1 app：注入 fetch+storage → boot 拉 health/unlock + 存档合并', async () => {
  const storage = (() => {
    const m = new Map();
    m.set('dl.v3.state', JSON.stringify({ schemaVersion: 1, tier: 'epic', warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: null, skills: [null, null, null], ai: null } }));
    m.set('dl.v3.seed', '42');
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  })();
  const fetchFn = async (url) => {
    if (url.endsWith('/health')) return { status: 200, json: async () => ({ ok: true, data: { status: 'ok', version: '9.9.9' } }) };
    return { status: 200, json: async () => ({ ok: true, data: { tier: 'epic', nodes: ['n1'] } }) };
  };
  const { store } = start({ fetch: fetchFn, storage, log: sink().log });
  await new Promise((r) => setTimeout(r, 10));
  const s = store.getState();
  assert.equal(s.meta.serverOk, true, 'health 成功');
  assert.equal(s.meta.version, '9.9.9');
  assert.equal(s.tier, 'epic', '存档 tier 合并');
  assert.equal(s.seed, 42, '读档 seed 载入');
  assert.equal(s.tierInfo.nodes.length, 1, 'unlock 已刷新');
  // seed 回带：后续响应携带 seed 且请求不带 → 回写
  const { store: st2 } = start({ fetch: async () => ({ status: 200, json: async () => ({ ok: true, data: { status: 'ok', version: '1', seed: 100 } }) }), storage: null, log: sink().log });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(st2.getState().seed, 100, 'boot 响应 seed 回带写回 store');
});

test('R1 app：全局 localStorage 分支（临时挂载）+ log/patch 注入分支', async () => {
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  try {
    const h = start({ fetch: async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'x', message: 'y' } }) }) });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(h.store.getState().meta.serverOk, false, 'health 失败路径');
  } finally {
    delete globalThis.localStorage;
  }
  // d.log 优先于默认 log；d.patch 合并臂；d.timers 注入
  const custom = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {}, setChannelLevel: () => {} };
  const pending = [];
  const timers = { setTimeout: (fn, ms) => pending.push([fn, ms]), clearTimeout: () => {} };
  const h2 = start({ log: custom, storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }, timers, patch: { tier: 'mythic', screen: 'gacha' } });
  assert.ok(h2.store);
  assert.equal(h2.store.getState().tier, 'mythic', 'patch 合并');
  assert.equal(h2.store.getState().screen, 'gacha', 'patch 覆盖初始屏');
  assert.equal(typeof h2.api.request, 'function');
});

test('R1 app：doc 注入 → dom 缝创建 + root 挂载（mountApp 生效）', async () => {
  const root = { innerHTML: '', listeners: {}, addEventListener() {} };
  const doc = { getElementById: (id) => (id === 'app' ? root : null), createElement: () => ({}), body: { appendChild() {}, removeChild() {} } };
  const h = start({ doc, fetch: async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'x', message: 'y' } }) }), log: { ...sink().log, dump: () => [] } });
  assert.ok(h.mount, 'doc+root → mount 装配');
  assert.ok(root.innerHTML.includes('data-box-id'), 'root 已渲染');
});

test('R7 app：editorFactory —— 入 editor 屏 → 动态 import 失败 → 占位不炸（warn 日志）', async () => {
  const warns = [];
  const root = { innerHTML: '', listeners: {}, addEventListener() {} };
  const doc = { getElementById: (id) => (id === 'app' ? root : null), createElement: () => ({}), body: { appendChild() {}, removeChild() {} } };
  const h = start({ doc, fetch: async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'x', message: 'y' } }) }), log: { ...sink().log, warn: (c, e, m, d) => warns.push(m), dump: () => [] } });
  h.store.dispatch({ type: 'goto', screen: 'editor' });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(warns.some((m) => /Blockly 加载失败/.test(m)), 'node 环境 import(/vendor/...) 失败 → warn 占位');
  assert.equal(root.innerHTML.includes('data-box-id'), true, 'paint 仍完成');
});

test('R7 app：editorFactory 成功臂（blocklyUrl data: 模块）→ wireEditor 返回 null 也安全 + document 全局臂', async () => {
  const prev = globalThis.document;
  globalThis.document = { getElementById: () => null }; // document 全局臂（无 #app → root null）
  try {
    const root = { innerHTML: '', listeners: {}, addEventListener() {} };
    const doc = { getElementById: (id) => (id === 'app' ? root : null), createElement: () => ({}), body: { appendChild() {}, removeChild() {} } };
    const h = start({
      doc,
      fetch: async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'x', message: 'y' } }) }),
      log: { ...sink().log, dump: () => [] },
      blocklyUrl: 'data:text/javascript,export default {}',
    });
    h.store.dispatch({ type: 'goto', screen: 'editor' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(typeof h.mount, 'object', 'editorFactory 成功路径（wireEditor 缺 div → null 占位）');
  } finally {
    globalThis.document = prev;
  }
});
