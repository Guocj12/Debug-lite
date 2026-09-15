'use strict';
/* api/client.js —— 唯一网络出口（frontend-spec §5）。
 * 统一信封解析；seed 回带（T-AP-5）；AbortController 超时（默认 8s，对战类 120s）；
 * 日志 api.req/api.res/api.err（channel=api）。测试注入 fetch/log/timers。
 */
const DEFAULT_TIMEOUT_MS = 8000;
const LONG_TIMEOUT_MS = 120000;

function longPath(path) {
  return path.startsWith('/ai/battle') || path.startsWith('/battle') || path.startsWith('/replay/');
}

export function createClient(options) {
  const opts = options || {};
  const doFetch = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  const log = opts.log || null; // util/log 三态对象（noop 兜底）
  const base = opts.base || '/api/v1';
  const timers = opts.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  let onSeed = opts.onSeed || null;
  const setSeedHandler = (fn) => { onSeed = fn; };

  async function request(method, path, body, reqOpts) {
    const o = reqOpts || {};
    const started = Date.now();
    log && log.info('api', 'api.req', `${method} ${path}`, { method, path, query: null, bytes: body === undefined ? 0 : JSON.stringify(body).length });
    const timeoutMs = o.timeoutMs || (longPath(path) ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? timers.setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: o.signal || (ctrl ? ctrl.signal : undefined),
      });
      let json = null;
      try {
        json = await res.json();
      } catch (e) {
        log && log.error('api', 'api.err', `${method} ${path} 非 JSON 响应`, { code: 'unknown', status: res.status });
        return { ok: false, code: 'unknown', message: `HTTP ${res.status}`, details: [] };
      }
      const ms = Date.now() - started;
      if (json && json.ok === true) {
        const data = json.data;
        log && log.info('api', 'api.res', `${method} ${path} -> ${res.status}`, { ms, code: 'ok', status: res.status, bytes: JSON.stringify(json).length });
        // seed 回带（T-AP-5）：请求未带 seed 且响应 data.seed 存在
        if (onSeed && data && typeof data === 'object' && data.seed !== undefined && (body === undefined || body === null || body.seed === undefined)) {
          onSeed(data.seed);
        }
        return { ok: true, data };
      }
      const err = (json && json.error) || {};
      log && log.error('api', 'api.err', `${method} ${path} -> ${res.status}`, { code: err.code || 'unknown', ms, status: res.status });
      return { ok: false, code: err.code || 'unknown', message: err.message || `HTTP ${res.status}`, details: Array.isArray(err.details) ? err.details : [] };
    } catch (e) {
      const isAbort = ctrl && (e && e.name === 'AbortError');
      const code = isAbort ? 'timeout' : 'network';
      log && log.error('api', 'api.err', `${method} ${path} 失败`, { code, ms: Date.now() - started, message: (e && e.message) || String(e) });
      return { ok: false, code, message: isAbort ? '请求超时' : '网络异常', details: [] };
    } finally {
      if (timer) timers.clearTimeout(timer);
    }
  }

  const get = (path, o) => request('GET', path, undefined, o);
  const post = (path, body, o) => request('POST', path, body, o);

  const api = {
    request,
    setSeedHandler,
    health: () => get('/health'),
    unlock: (tier) => get(`/unlock?tier=${encodeURIComponent(tier)}`),
    data: (table) => get(`/data/${encodeURIComponent(table)}`),
    logLevel: { get: () => get('/log-level'), set: (lvl) => post('/log-level', lvl) },
    aiValidate: (p) => post('/ai/validate', p),
    aiCompile: (p) => post('/ai/compile', p),
    aiBattle: (p) => post('/ai/battle', p),
    box: ({ seed, tier, times }) => post('/box', { seed, tier, times }),
    wh: {
      list: () => get('/warehouse'),
      assemble: (b) => post('/warehouse/assemble', b),
      disassemble: (b) => post('/warehouse/disassemble', b),
    },
    loadout: { get: () => get('/loadout'), save: (b) => post('/loadout', b) },
    panel: (b) => post('/panel', b),
    battle: (b) => post('/battle', b),
    replay: (id, from, to) => get(`/replay/${encodeURIComponent(id)}?from=${from || 0}&to=${to || 0}`),
    rankedRun: (b) => post('/ranked/run', b),
    rankedPromote: (b) => post('/ranked/promote', b),
  };
  return api;
}
