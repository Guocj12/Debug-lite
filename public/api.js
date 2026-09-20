'use strict';
/* public/api.js —— **单一网络出口**（总纲 §1.5 / docs/tasks.md §7「单一网络出口」）
 *
 * 全前端只有本文件调用 fetch（tests/frontend/auth-ui-contract.test.js 机器核对）。
 * 本文件**不解释信封**（不读 ok/error/data 任何字段）——只回 {transport,status,envelope,raw}，
 * 由投影层 public/format.js 解读（投影单一真源）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.api = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function createApi(options) {
    var opts = options || {};
    var baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl : '';
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    function call(method, path, body, token) {
      if (!fetchImpl) return Promise.resolve({ transport: 'error', message: '当前环境不支持 fetch' });
      var headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (typeof token === 'string' && token !== '') headers.authorization = 'Bearer ' + token;
      var init = { method: method, headers: headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      return fetchImpl(baseUrl + path, init).then(function (res) {
        return res.text().then(function (raw) {
          var envelope = null;
          try {
            envelope = JSON.parse(raw);
          } catch (e) {
            return { transport: 'error', status: res.status, message: '服务端返回非 JSON（HTTP ' + res.status + '）', raw: raw };
          }
          return { transport: 'response', status: res.status, envelope: envelope, raw: raw };
        });
      }).catch(function (e) {
        return { transport: 'error', message: e && e.message ? e.message : String(e) };
      });
    }

    return {
      baseUrl: baseUrl,
      call: call,
      register: function (input) { return call('POST', '/api/v1/auth/register', input, null); },
      login: function (input) { return call('POST', '/api/v1/auth/login', input, null); },
      logout: function (token) { return call('POST', '/api/v1/auth/logout', {}, token); },
      changePassword: function (token, input) { return call('POST', '/api/v1/auth/password', input, token); },
      me: function (token) { return call('GET', '/api/v1/me', undefined, token); },
    };
  }

  return { createApi: createApi };
});
