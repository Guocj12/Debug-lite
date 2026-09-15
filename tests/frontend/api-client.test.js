'use strict';
// P6 R1 api client 契约测试 —— frontend-spec §5（信封/错误归一/seed 回带/超时）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let createClient;
before(async () => {
  ({ createClient } = await import('../../public/js/api/client.js'));
});

function resOk(data) {
  return { status: 200, json: async () => ({ ok: true, data, log: { level: 'debug', events: [] } }) };
}
function resErr(status, code, message, details) {
  return { status, json: async () => ({ ok: false, error: { code, message, details: details || [] } }) };
}

function sink() {
  const rec = [];
  return { rec, log: { debug: (c, e, m, d) => rec.push([c, e, m, d]), info: (c, e, m, d) => rec.push([c, e, m, d]), warn: (c, e, m, d) => rec.push([c, e, m, d]), error: (c, e, m, d) => rec.push([c, e, m, d]), setLevel: () => {}, setChannelLevel: () => {} } };
}

test('R1 client：成功信封 → {ok:true,data} + api.req/api.res 日志', async () => {
  const { log, rec } = sink();
  const calls = [];
  const api = createClient({ fetch: async (url, init) => { calls.push([url, init]); return resOk({ status: 'ok' }); }, log });
  const r = await api.health();
  assert.deepEqual(r, { ok: true, data: { status: 'ok' } });
  assert.equal(calls[0][0], '/api/v1/health');
  assert.equal(calls[0][1].method, 'GET');
  assert.ok(rec.some(([, e]) => e === 'api.req'));
  assert.ok(rec.some(([, e, , d]) => e === 'api.res' && d.code === 'ok'));
});

test('R1 client：失败信封 → code/message/details 归一 + api.err(warn/error) 记录', async () => {
  const { log } = sink();
  const api = createClient({ fetch: async () => resErr(409, 'tier_locked', '锁定', ['d1']), log });
  const r = await api.box({ seed: 1, tier: 'mythic', times: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'tier_locked');
  assert.equal(r.message, '锁定');
  assert.deepEqual(r.details, ['d1']);
});

test('R1 client：非 JSON 响应 → unknown；网络异常 → network', async () => {
  const api = createClient({ fetch: async () => ({ status: 503, json: async () => { throw new Error('bad'); } }), log: sink().log });
  const r1 = await api.health();
  assert.equal(r1.code, 'unknown');
  const api2 = createClient({ fetch: async () => { throw new Error('ECONN'); }, log: sink().log });
  const r2 = await api2.health();
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'network');
});

test('R1 client：seed 回带 —— 响应带 seed 且请求未带 → onSeed；请求带 seed → 不回调', async () => {
  const api = createClient({ fetch: async () => resOk({ seed: 7, items: [] }), log: sink().log });
  const seeds = [];
  api.setSeedHandler((s) => seeds.push(s));
  await api.box({ seed: undefined, tier: 'common', times: 1 });
  assert.deepEqual(seeds, [7]);
  const seeds2 = [];
  api.setSeedHandler((s) => seeds2.push(s));
  await api.box({ seed: 42, tier: 'common', times: 1 });
  assert.deepEqual(seeds2, []);
});

test('R1 client：超时 → code timeout（注入 timers 立即触发 abort）', async () => {
  const immediate = { setTimeout: (f) => f(), clearTimeout: () => {} };
  const api = createClient({
    fetch: async (url, init) => new Promise((resolve, reject) => {
      const sig = init && init.signal;
      if (sig && sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      sig && sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      setTimeout(() => resolve(resOk({})), 50);
    }),
    log: sink().log,
    timers: immediate,
  });
  const r = await api.health();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'timeout');
  assert.equal(r.message, '请求超时');
});

test('R1 client：POST 体序列化 + GET 查询拼接 + 长超时路径', async () => {
  const { log } = sink();
  const calls = [];
  const api = createClient({ fetch: async (url, init) => { calls.push([url, init]); return resOk({}); }, log });
  await api.unlock('rare');
  assert.equal(calls[0][0], '/api/v1/unlock?tier=rare');
  await api.box({ seed: 1, tier: 'common', times: 3 });
  assert.deepEqual(JSON.parse(calls[1][1].body), { seed: 1, tier: 'common', times: 3 });
  await api.aiBattle({ program: {} });
  assert.equal(calls[2][0], '/api/v1/ai/battle');
  await api.replay('r1', 0, 5);
  assert.equal(calls[3][0], '/api/v1/replay/r1?from=0&to=5');
  await api.rankedRun({ seed: 1 });
  await api.rankedPromote({ tier: 'rare', wins: 7 });
  assert.equal(calls[5][0], '/api/v1/ranked/promote');
});

test('R1 client：api 全方法遍历（URL/方法面）', async () => {
  const calls = [];
  const api = createClient({ fetch: async (url, init) => { calls.push([init.method, url, init.body ? JSON.parse(init.body) : null]); return resOk({}); }, log: sink().log });
  await api.data('plugins');
  await api.logLevel.get();
  await api.logLevel.set({ level: 'trace' });
  await api.aiValidate({ program: {} });
  await api.aiCompile({ program: {} });
  await api.wh.list();
  await api.wh.assemble({ warehouse: {}, targetUid: 'a', pluginUid: 'b', slotIndex: 0 });
  await api.wh.disassemble({ warehouse: {}, targetUid: 'a', slotIndex: 0 });
  await api.loadout.get();
  await api.loadout.save({ loadout: {} });
  await api.panel({ loadout: {} });
  await api.battle({ seed: 1 });
  const want = [
    ['GET', '/api/v1/data/plugins'],
    ['GET', '/api/v1/log-level'],
    ['POST', '/api/v1/log-level', { level: 'trace' }],
    ['POST', '/api/v1/ai/validate', { program: {} }],
    ['POST', '/api/v1/ai/compile', { program: {} }],
    ['GET', '/api/v1/warehouse'],
    ['POST', '/api/v1/warehouse/assemble', { warehouse: {}, targetUid: 'a', pluginUid: 'b', slotIndex: 0 }],
    ['POST', '/api/v1/warehouse/disassemble', { warehouse: {}, targetUid: 'a', slotIndex: 0 }],
    ['GET', '/api/v1/loadout'],
    ['POST', '/api/v1/loadout', { loadout: {} }],
    ['POST', '/api/v1/panel', { loadout: {} }],
    ['POST', '/api/v1/battle', { seed: 1 }],
  ];
  assert.equal(calls.length, want.length);
  for (let i = 0; i < want.length; i++) {
    assert.equal(calls[i][0], want[i][0], `#${i} method`);
    assert.equal(calls[i][1], want[i][1], `#${i} url`);
    if (want[i][2] !== undefined) assert.deepEqual(calls[i][2], want[i][2], `#${i} body`);
  }
});

test('R1 client：无 log 注入 → 日志分支短路不抛；显式 signal 透传', async () => {
  const api = createClient({ fetch: async () => resOk({}) });
  assert.doesNotThrow(() => api.request('GET', '/health'));
  let gotSignalVal = null;
  const api2 = createClient({ fetch: async (url, init) => { gotSignalVal = init.signal; return resOk({}); }, log: sink().log });
  const ctrl = new AbortController();
  await api2.request('GET', '/health', undefined, { signal: ctrl.signal });
  assert.equal(gotSignalVal, ctrl.signal, 'signal 应透传');
  const seeds = [];
  api2.setSeedHandler((s) => seeds.push(s));
  await api2.request('POST', '/box', { seed: 9, tier: 'common', times: 1 });
  assert.deepEqual(seeds, [], '请求带 seed → 不回带');
});

test('R1 client：响应 data.seed 缺失/非对象 data 不回调', async () => {
  const seeds = [];
  const api = createClient({ fetch: async () => resOk(null), log: sink().log });
  api.setSeedHandler((s) => seeds.push(s));
  await api.unlock('common');
  assert.deepEqual(seeds, []);
  const api2 = createClient({ fetch: async () => resOk({}), log: sink().log });
  api2.setSeedHandler((s) => seeds.push(s));
  await api2.data('unlock');
  assert.deepEqual(seeds, []);
});

test('R1 client：GET 响应 seed 也回带 + 无 details 信封 + data.seed 缺失不回调', async () => {
  const seeds = [];
  const api = createClient({ fetch: async () => resOk({ seed: 3 }), log: sink().log });
  api.setSeedHandler((s) => seeds.push(s));
  await api.request('GET', '/battle', undefined, {});
  assert.deepEqual(seeds, [3], 'GET 且 data.seed → 回带');
  const seeds2 = [];
  const api2 = createClient({ fetch: async () => ({ status: 200, json: async () => ({ ok: false, error: { code: 'x', message: 'm' } }) }), log: sink().log });
  api2.setSeedHandler((s) => seeds2.push(s));
  const r = await api2.request('GET', '/health');
  assert.equal(r.code, 'x', '无 details 信封 → details 归一 []');
  assert.deepEqual(r.details, []);
  assert.deepEqual(seeds2, []);
});

test('R1 client：AbortController 缺失分支（临时删除）→ 无 ctrl 无 timer 仍可请求', async () => {
  const prevAbort = globalThis.AbortController;
  delete globalThis.AbortController;
  try {
    const api = createClient({ fetch: async () => resOk({ z: 1 }), log: sink().log });
    const r = await api.request('GET', '/health');
    assert.equal(r.ok, true);
  } finally {
    globalThis.AbortController = prevAbort;
  }
});

test('R1 client：fetch 全局缺失分支（临时删除）→ network 兜底', async () => {
  const prevFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    const api = createClient({ log: sink().log });
    const r = await api.request('GET', '/health');
    assert.equal(r.ok, false);
    assert.equal(r.code, 'network', 'doFetch null → 抛穿 → network');
  } finally {
    globalThis.fetch = prevFetch;
  }
});
test('R1 client：缺省 timeoutMs（非长路径 8s）与显式 timeoutMs（不触发 abort）', async () => {
  const seen = [];
  const timers = { setTimeout: (fn, ms) => seen.push(ms), clearTimeout: () => {} };
  const api = createClient({ fetch: async () => resOk({}), log: sink().log, timers });
  await api.health();
  assert.deepEqual(seen, [8000]);
  await api.battle({});
  assert.ok(seen.includes(120000), 'battle 长超时 120s');
  seen.length = 0;
  await api.request('GET', '/health', undefined, { timeoutMs: 1000 });
  assert.deepEqual(seen, [1000]);
});
