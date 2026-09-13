'use strict';
// F1 api/client 测试 —— frontend-spec §5（信封 ok/err/network、seed 回带、signal、注入 fetch）
const { test } = require('node:test');
const assert = require('node:assert/strict');

function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    impl: (url, opts) => {
      calls.push({ url, opts });
      const r = responses.shift();
      if (r && r.throw) return Promise.reject(r.throw);
      return Promise.resolve({ status: r.status, text: async () => r.text });
    },
  };
}

test('§5 request：成功信封 → {ok:true,data}；失败信封 → code/message/details；非 JSON → unknown', async () => {
  const { createApi } = await import('../../public/js/api/client.js');
  const ff = fakeFetch([
    { status: 200, text: JSON.stringify({ ok: true, data: { items: [] } }) },
    { status: 409, text: JSON.stringify({ ok: false, error: { code: 'tier_locked', message: '段位不足', details: [{ code: 'x' }] } }) },
    { status: 500, text: '<html>oops</html>' },
  ]);
  const api = createApi({ fetchImpl: ff.impl });
  const ok = await api.post('/box', { times: 1 });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, { items: [] });
  const bad = await api.post('/box', { times: 1 });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'tier_locked');
  assert.equal(bad.details.length, 1);
  const nonJson = await api.get('/health');
  assert.equal(nonJson.ok, false);
  assert.equal(nonJson.code, 'unknown');
  assert.deepEqual(ff.calls[0].opts, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ times: 1 }), signal: undefined }, 'POST 头与 body');
  assert.equal(ff.calls[2].url, '/api/v1/health', '路径前缀拼装');
});

test('§5 request：网络异常 → {code:network}；seed 回带回调（setSeedHandler 后设）', async () => {
  const { createApi } = await import('../../public/js/api/client.js');
  const ff = fakeFetch([
    { throw: new Error('ECONNREFUSED') },
    { status: 200, text: JSON.stringify({ ok: true, data: { seed: 77, frames: [] } }) },
  ]);
  const api = createApi({ fetchImpl: ff.impl });
  const n = await api.get('/health');
  assert.equal(n.ok, false);
  assert.equal(n.code, 'network');
  let seedGot = null;
  api.setSeedHandler((s) => { seedGot = s; });
  const ok = await api.post('/battle', {});
  assert.equal(ok.ok, true);
  assert.equal(seedGot, 77, '响应 data.seed 回带');
});

test('§5 request：signal 透传 + 无 fetch 环境 → network', async () => {
  const { createApi } = await import('../../public/js/api/client.js');
  const ac = new AbortController();
  const ff = fakeFetch([
    { status: 200, text: JSON.stringify({ ok: true, data: {} }) },
  ]);
  const api = createApi({ fetchImpl: ff.impl });
  await api.get('/box', { signal: ac.signal });
  assert.equal(ff.calls[0].opts.signal, ac.signal, 'signal 透传');
  const none = createApi({ fetchImpl: null });
  const r = await none.get('/health');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'network');
});

test('§5 覆盖补点：空文本 → HTTP 回退文案；非整数 seed 不回带；带 log 的 req/res/err 记录', async () => {
  const { createApi } = await import('../../public/js/api/client.js');
  const ff = fakeFetch([
    { status: 500, text: '' },
    { status: 200, text: JSON.stringify({ ok: true, data: { seed: 'x' } }) },
    { status: 200, text: JSON.stringify({ ok: true, data: {} }) },
    { status: 403, text: JSON.stringify({ ok: false, error: { code: 'forbidden', message: 'no' } }) },
  ]);
  const events = [];
  const lg = {
    debug: (ch, ev) => events.push([ev, ch]),
    warn: (ch, ev) => events.push([ev, ch]),
    error: (ch, ev) => events.push([ev, ch]),
  };
  const api = createApi({ fetchImpl: ff.impl, log: lg });
  const empty = await api.get('/health');
  assert.equal(empty.message, 'HTTP 500', '空文本 → HTTP 状态回退');
  let seeds = [];
  api.setSeedHandler((s) => seeds.push(s));
  await api.get('/unlock?tier=common');
  await api.get('/box');
  assert.deepEqual(seeds, [], '非整数/缺失 seed 不回带');
  await api.get('/loadout');
  assert.ok(events.some(([ev]) => ev === 'api.req'), 'api.req 日志');
  assert.ok(events.some(([ev]) => ev === 'api.res'), 'api.res 日志');
  assert.ok(events.some(([ev]) => ev === 'api.err'), 'api.err 日志');
});