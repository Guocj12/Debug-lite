'use strict';
/* public/api.js —— **单一网络出口**（总纲 §1.5 / docs/tasks.md §7「单一网络出口」）
 *
 * 全前端只有本文件调用 fetch（tests/frontend/auth-ui-contract.test.js 机器核对）。
 * 本文件**不解释信封**（不读 ok/error/data 任何字段）——只回 {transport,status,envelope,raw}，
 * 由投影层 public/format.js 解读（投影单一真源）。
 *
 * F2 增量（docs/frontend/02-accounts.md §2.2/§10.1）：新增管理面出口 `admin(op, body, adminToken, bearerToken)`。
 *   · `ADMIN_OPS` 是**前端登记的全部管理能力**（唯一清单）：与后端 `server/index.js` 的 adminOp 分支
 *     双向相等，由 tests/frontend/admin-op-parity.test.js 机器强制 —— 后端以后新增 admin 能力时，
 *     本表不同步即 FAIL（用户硬要求）。
 *   · 鉴权二选一：`X-Admin-Token: <DL_ADMIN_TOKEN>` **或** 管理员账号的 Bearer；两者都带上时服务端
 *     以账号身份优先（server/admin.js 的 checkAccess）。
 *   · 令牌只经参数传入（内存值），本文件不读也不写任何存储。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.api = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ADMIN_PATH = '/api/v1/admin/';
  // 与 server/index.js 的 `op === '<name>'` 分支逐条对应（顺序与 §1 端点映射表一致）
  var ADMIN_OPS = Object.freeze([
    'accounts',        // F2 新增：分页账号列表
    'delete-account',  // F2 新增：删除账号（墓碑）
    'stats',           // 既有：服务统计
    'rebuild-index',   // 既有：重建索引
    'bots',            // 既有：注入调试 bot（另需 DL_DEBUG_BOTS=1）
    'clear-bots',      // 既有：清除调试 bot
    'ban',             // 既有：封禁
    'unban',           // 既有：解封（server/index.js 映射到 ban{banned:false}）
  ]);

  function createApi(options) {
    var opts = options || {};
    var baseUrl = typeof opts.baseUrl === 'string' ? opts.baseUrl : '';
    var fetchImpl = opts.fetchImpl || (typeof fetch === 'function' ? fetch : null);

    function call(method, path, body, token, extraHeaders) {
      if (!fetchImpl) return Promise.resolve({ transport: 'error', message: '当前环境不支持 fetch' });
      var headers = {};
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (typeof token === 'string' && token !== '') headers.authorization = 'Bearer ' + token;
      if (extraHeaders) {
        for (var k in extraHeaders) {
          if (Object.prototype.hasOwnProperty.call(extraHeaders, k) && extraHeaders[k] !== undefined) headers[k] = extraHeaders[k];
        }
      }
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

    // 管理面出口：未登记 op 一律不发请求（前端登记表是唯一入口）
    function admin(op, body, adminToken, bearerToken) {
      if (ADMIN_OPS.indexOf(op) === -1) {
        return Promise.resolve({ transport: 'error', message: '未登记的管理端点：' + String(op) });
      }
      var headers = {};
      if (typeof adminToken === 'string' && adminToken !== '') headers['x-admin-token'] = adminToken;
      return call('POST', ADMIN_PATH + op, body === undefined ? {} : body, bearerToken, headers);
    }

    return {
      baseUrl: baseUrl,
      call: call,
      register: function (input) { return call('POST', '/api/v1/auth/register', input, null); },
      login: function (input) { return call('POST', '/api/v1/auth/login', input, null); },
      logout: function (token) { return call('POST', '/api/v1/auth/logout', {}, token); },
      changePassword: function (token, input) { return call('POST', '/api/v1/auth/password', input, token); },
      me: function (token) { return call('GET', '/api/v1/me', undefined, token); },
      admin: admin,
    };
  }

  return { createApi: createApi, ADMIN_OPS: ADMIN_OPS, ADMIN_PATH: ADMIN_PATH };
});
