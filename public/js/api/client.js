// api/client.js —— 前端 API 客户端（frontend-spec §5；唯一网络出口）
// fetch 可注入（测试）；信封解析：ok:true → data；ok:false → {ok:false, code, message, details}；异常 → network。
export function createApi(opts) {
  const o = opts || {};
  const f = o.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const lg = o.log || null;
  let onSeed = o.onSeed || null; // §5.6：响应 data.seed 回带（T-AP-5；可后设——store 创建后才可 dispatch）

  async function request(method, path, body, reqOpts) {
    const started = Date.now();
    const ro = reqOpts || {};
    const bodyStr = body === undefined ? undefined : JSON.stringify(body);
    if (lg) lg.debug('api', 'api.req', `${method} ${path}`, { method, path, bodyBytes: bodyStr ? bodyStr.length : 0 });
    try {
      if (!f) throw new Error('no fetch in env');
      const res = await f(`/api/v1${path}`, {
        method,
        headers: bodyStr ? { 'content-type': 'application/json' } : {},
        body: bodyStr,
        signal: ro.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (e) { json = null; }
      if (json && json.ok === true) {
        if (onSeed && json.data && Number.isInteger(json.data.seed)) onSeed(json.data.seed);
        if (lg) lg.debug('api', 'api.res', `${method} ${path} -> ok`, { method, path, ms: Date.now() - started });
        return { ok: true, data: json.data };
      }
      const err = json && json.error ? json.error : { code: 'unknown', message: text || `HTTP ${res.status}` };
      if (lg) lg.warn('api', 'api.err', `${method} ${path} -> ${err.code}`, { method, path, code: err.code, ms: Date.now() - started });
      return { ok: false, code: err.code || 'unknown', message: err.message, details: err.details || null };
    } catch (e) {
      if (lg) lg.error('api', 'api.err', `${method} ${path} 网络异常`, { method, path, message: e.message, ms: Date.now() - started });
      return { ok: false, code: 'network', message: e.message, details: null };
    }
  }

  return {
    request,
    get: (p, ro) => request('GET', p, undefined, ro),
    post: (p, b, ro) => request('POST', p, b, ro),
    setSeedHandler: (fn) => { onSeed = fn; },
    raw: f,
  };
}

export const api = createApi();