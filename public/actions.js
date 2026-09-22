'use strict';
/* public/actions.js —— 按钮↔动作白名单（总纲 §4.1「按钮永不无声」；设计依据 docs/frontend/01-auth.md §4
 *   + F2 增量 docs/frontend/02-accounts.md §4/§6/§8）
 *
 * 本文件是**唯一动作注册表**：render 产出的每个 data-action 必须命中它（双向核对见
 * tests/frontend/auth-ui-contract.test.js 与 admin-ui-contract.test.js）。
 * ctx = { state, dispatch, api, format, storage, actions }；行级动作另收 payload = {playerId, publicId}
 *   （来自被点按钮的 data-player-id / data-public-id，见 02-accounts.md §3.2）。
 * 本文件只做「客户端预校验 → 发请求（经唯一网络出口 api）→ dispatch → 投影文案（经 format）」，
 * 不读响应字段、不碰 DOM。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.actions = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/;   // 与服务端 auth.js 同规则（3~24、[A-Za-z0-9_-]）
  var PW_MIN = 8;
  var PW_MAX = 72;
  var NICK_MAX = 16;

  // F2：账号列表每页条数三档、bots 单次注入上限（与 server/admin.js 的 MAX_BOTS_PER_CALL 同口径）
  var ADMIN_LIMITS = [20, 50, 100];
  var ADMIN_DEFAULT_LIMIT = 20;
  var BOTS_COUNT_MAX = 200;
  // 目标解析（publicId → playerId）的翻页上限：后端 ban 只认 playerId，故从账号列表逐页找
  var TARGET_SCAN_PAGES = 25;
  var TARGET_SCAN_LIMIT = 200;

  /* ---------- 客户端预校验（01-auth.md §6 预校验行 / §8 B-1..B-5） ---------- */

  // 用户名统一去首尾空白（复制粘贴常带空格；服务端建号时不含空白，故去空白不改变语义）
  function usernameOf(form) {
    return typeof form.username === 'string' ? form.username.trim() : '';
  }

  function validateLogin(form) {
    if (!usernameOf(form) || !form.password) return '请填写用户名与密码';
    return null;
  }

  function validateRegister(form) {
    if (!usernameOf(form) || !form.password || !form.confirm) return '请填写用户名与密码';
    if (!USERNAME_RE.test(usernameOf(form))) return '用户名需 3~24 字符，且只含 [A-Za-z0-9_-]';
    if (form.password.length < PW_MIN || form.password.length > PW_MAX) return '密码需 8~72 字符';
    if (form.password !== form.confirm) return '两次输入的密码不一致';
    if (form.nickname && form.nickname.length > NICK_MAX) return '昵称最长 16 字符';
    return null;
  }

  function validatePassword(form) {
    if (!form.oldPassword || !form.newPassword || !form.newConfirm) return '请填写原密码与新密码';
    if (form.newPassword.length < PW_MIN || form.newPassword.length > PW_MAX) return '密码需 8~72 字符';
    if (form.newPassword !== form.newConfirm) return '两次输入的密码不一致';
    return null;
  }

  /* ---------- 公共小工具（全部经 format 投影，本文件不读响应字段） ---------- */

  function noticeNotice(ctx, kind, text) {
    ctx.dispatch({ type: 'notice.set', notice: { kind: kind, text: text } });
  }

  // 失败时清空「密码类」输入框，保留用户名/昵称（01-auth.md §8 B-14）：
  //   否则密码框残留旧值，用户再输入会变成"追加"，表现为莫名其妙的 invalid_credentials。
  var PASSWORD_FIELDS_OF_VIEW = Object.freeze({
    login: ['password'],
    register: ['password', 'confirm'],
    password: ['oldPassword', 'newPassword', 'newConfirm'],
  });

  // 业务失败（服务端给了信封）→ 清密码框；传输失败（网络）→ 原样保留，用户直接重试
  function failFrom(ctx, result) {
    if (result.transport === 'error') return noticeNotice(ctx, 'error', ctx.format.networkText(result.message));
    noticeNotice(ctx, 'error', ctx.format.noticeText(result.envelope));
    var fields = PASSWORD_FIELDS_OF_VIEW[ctx.state.view] || [];
    if (fields.length > 0) ctx.dispatch({ type: 'form.clear', fields: fields });
    return undefined;
  }

  // 会话失效（401/403）：清本地凭据 → 切登录屏 → 提示（01-auth.md §6「401 的统一处理」）
  function sessionLost(ctx, result) {
    ctx.storage.clear();
    ctx.dispatch({ type: 'session.clear' });
    ctx.dispatch({ type: 'auth.set', envelope: null });
    ctx.dispatch({ type: 'profile.set', envelope: null });
    clearAdminState(ctx);
    ctx.dispatch({ type: 'view.go', view: 'login' });
    if (result && result.envelope) noticeNotice(ctx, 'error', ctx.format.noticeText(result.envelope));
    else noticeNotice(ctx, 'error', '会话已失效，请重新登录');
  }

  function busy(ctx, value) { ctx.dispatch({ type: 'busy.set', busy: value }); }

  /* ---------- F2 管理面工具（02-accounts.md §4/§6/§8） ---------- */

  // 管理令牌与列表/确认态一律随会话一起清掉（凭据只在内存，登出即弃）
  function clearAdminState(ctx) {
    var limit = limitOf(ctx);
    ctx.dispatch({ type: 'admin.token.set', value: '' });
    ctx.dispatch({ type: 'admin.accounts.set', envelope: null, offset: 0, limit: limit });
    ctx.dispatch({ type: 'admin.confirm.set', confirm: null });
    ctx.dispatch({ type: 'admin.result.set', result: null });
  }

  // 管理操作的结果只进「结果区」（state.admin.result）；不占用 #notice，避免被 view.go 清掉。
  // 例外：若当前不在管理两屏（只可能是被强制构造的调用，A-1），同时写 #notice —— 保证「按钮永不无声」
  //   （文案只有一份可见：管理屏看结果区，非管理屏看提示行）。
  function adminResult(ctx, kind, text) {
    ctx.dispatch({ type: 'admin.result.set', result: { kind: kind, text: text } });
    var onAdminScreen = ctx.state.view === 'admin' || ctx.state.view === 'accounts';
    if (!onAdminScreen) ctx.dispatch({ type: 'notice.set', notice: { kind: kind, text: text } });
  }

  function limitOf(ctx) {
    var limit = ctx.state.admin && ctx.state.admin.limit;
    return ADMIN_LIMITS.indexOf(limit) === -1 ? ADMIN_DEFAULT_LIMIT : limit;
  }

  // 管理请求：同时带 X-Admin-Token（若填了）与 Bearer（若已登录）；服务端以账号身份优先
  function adminCall(ctx, op, body) {
    var session = ctx.state.session || {};
    var bearer = typeof session.token === 'string' && session.token !== '' ? session.token : null;
    var token = typeof ctx.state.adminToken === 'string' && ctx.state.adminToken !== '' ? ctx.state.adminToken : null;
    return ctx.api.admin(op, body === undefined ? {} : body, token, bearer);
  }

  // 管理动作失败：网络/会话失效/服务端文案三档（§6 全部失败路径）
  function adminFail(ctx, result) {
    if (result.transport === 'error') { adminResult(ctx, 'error', ctx.format.networkText(result.message)); return undefined; }
    if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
    adminResult(ctx, 'error', ctx.format.adminNoticeText(result.envelope));
    return undefined;
  }

  function targetOf(payload) {
    var p = payload || {};
    return {
      playerId: typeof p.playerId === 'string' && p.playerId !== '' ? p.playerId : null,
      publicId: typeof p.publicId === 'string' && p.publicId !== '' ? p.publicId : null,
    };
  }

  // 拉取账号列表（§4：`刷新账号列表` / 翻页 / 每页条数都用它）
  //   · 成功 → 写入 envelope 与本次 offset/limit，并切到 accounts 屏
  //   · A-4：该页变空且不是第一页 → 自动回退一页（最多回退一次，防死循环）
  function loadAccounts(ctx, offset, limit, opts) {
    var o = opts || {};
    busy(ctx, true);
    return adminCall(ctx, 'accounts', { offset: offset, limit: limit }).then(function (result) {
      busy(ctx, false);
      if (result.transport === 'error') return adminFail(ctx, result);
      if (!ctx.format.isOk(result.envelope)) return adminFail(ctx, result);
      var count = ctx.format.accountRows(result.envelope).length;
      if (count === 0 && offset > 0 && o.allowBack !== false) {
        return loadAccounts(ctx, Math.max(0, offset - limit), limit, { allowBack: false });
      }
      ctx.dispatch({ type: 'admin.accounts.set', envelope: result.envelope, offset: offset, limit: limit });
      ctx.dispatch({ type: 'view.go', view: 'accounts' });
      return undefined;
    });
  }

  // publicId → playerId（后端 ban 只收 playerId）：逐页扫账号列表，最多 TARGET_SCAN_PAGES 页
  //   返回 playerId / null（未找到）/ undefined（请求失败，失败文案已写入结果区）
  function resolvePlayerIdByPublicId(ctx, publicId) {
    function step(offset, page) {
      if (page > TARGET_SCAN_PAGES) return Promise.resolve(null);
      return adminCall(ctx, 'accounts', { offset: offset, limit: TARGET_SCAN_LIMIT }).then(function (result) {
        if (result.transport === 'error') { adminFail(ctx, result); return undefined; }
        if (!ctx.format.isOk(result.envelope)) { adminFail(ctx, result); return undefined; }
        var rows = ctx.format.accountRows(result.envelope);
        for (var i = 0; i < rows.length; i++) if (rows[i].publicId === publicId) return rows[i].playerId;
        if (rows.length === 0 || !ctx.format.accountsHasMore(result.envelope)) return null;
        return step(offset + rows.length, page + 1);
      });
    }
    return step(0, 1);
  }

  // 封禁/解封结果文案（§4：`已封禁 <publicId>` / `已解封 <publicId>`）
  function banOutcome(ctx, result, publicId) {
    if (result.transport === 'error') return adminFail(ctx, result);
    if (!ctx.format.isOk(result.envelope)) return adminFail(ctx, result);
    adminResult(ctx, 'info', ctx.format.banText(result.envelope, publicId));
    return undefined;
  }

  // 管理动作的通用执行：busy → 请求 → 成功文案
  function runAdminOp(ctx, op, body, okText) {
    if (ctx.state.busy) return Promise.resolve();
    busy(ctx, true);
    return adminCall(ctx, op, body).then(function (result) {
      busy(ctx, false);
      if (result.transport === 'error') return adminFail(ctx, result);
      if (!ctx.format.isOk(result.envelope)) return adminFail(ctx, result);
      adminResult(ctx, 'info', okText(result.envelope));
      return undefined;
    });
  }

  /* ---------- 动作表（01-auth.md §4 九个 + 02-accounts.md §4 十六个） ----------
   *
   * ⚠️ 机器口径（tests/frontend/admin-op-parity.test.js 的 AP-2）：管理动作发出后端 op 时，
   *   op 必须是 adminCall(ctx, …) / runAdminOp(ctx, …) 第二个实参上的**单引号字面量**；
   *   新增管理动作时同步 public/api.js 的 ADMIN_OPS，否则 AP-1/AP-2 直接 FAIL。
   */

  var ACTIONS = {

    'submit-login': {
      label: '登录',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var invalid = validateLogin(ctx.state.form);
        if (invalid !== null) { noticeNotice(ctx, 'error', invalid); return Promise.resolve(); }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.login({ username: usernameOf(ctx.state.form), password: ctx.state.form.password }).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) return failFrom(ctx, result);
          var session = ctx.format.sessionOf(result.envelope);
          ctx.storage.saveSession(session);
          ctx.dispatch({ type: 'auth.set', envelope: result.envelope });
          ctx.dispatch({ type: 'session.set', token: session.token, publicId: session.publicId, nickname: session.nickname, expiresAt: session.expiresAt, isAdmin: session.isAdmin });
          ctx.dispatch({ type: 'form.clear', fields: ['password', 'confirm', 'newPassword', 'newConfirm'] });
          ctx.dispatch({ type: 'view.go', view: 'home' });
          noticeNotice(ctx, 'info', ctx.format.loginOkText(result.envelope));
          return undefined;
        });
      },
    },

    'submit-register': {
      label: '注册',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var invalid = validateRegister(ctx.state.form);
        if (invalid !== null) { noticeNotice(ctx, 'error', invalid); return Promise.resolve(); }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        var payload = { username: usernameOf(ctx.state.form), password: ctx.state.form.password };
        if (ctx.state.form.nickname) payload.nickname = ctx.state.form.nickname;
        return ctx.api.register(payload).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) return failFrom(ctx, result);
          var session = ctx.format.sessionOf(result.envelope);
          ctx.storage.saveSession(session);
          ctx.dispatch({ type: 'auth.set', envelope: result.envelope });
          ctx.dispatch({ type: 'session.set', token: session.token, publicId: session.publicId, nickname: session.nickname, expiresAt: session.expiresAt, isAdmin: session.isAdmin });
          ctx.dispatch({ type: 'form.clear', fields: ['password', 'confirm', 'newPassword', 'newConfirm'] });
          ctx.dispatch({ type: 'view.go', view: 'home' });
          noticeNotice(ctx, 'info', ctx.format.registerOkText(result.envelope));
          return undefined;
        });
      },
    },

    'submit-password': {
      label: '提交改密',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        if (!ctx.state.session.token) return sessionLost(ctx, null);
        var invalid = validatePassword(ctx.state.form);
        if (invalid !== null) { noticeNotice(ctx, 'error', invalid); return Promise.resolve(); }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        var payload = { oldPassword: ctx.state.form.oldPassword, newPassword: ctx.state.form.newPassword };
        return ctx.api.changePassword(ctx.state.session.token, payload).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            return failFrom(ctx, result);
          }
          ctx.dispatch({ type: 'form.clear', fields: ['oldPassword', 'newPassword', 'newConfirm'] });
          noticeNotice(ctx, 'info', ctx.format.passwordOkText(result.envelope));
          return undefined;
        });
      },
    },

    'refresh-profile': {
      label: '刷新档案',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        if (!ctx.state.session.token) return sessionLost(ctx, null);
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.me(ctx.state.session.token).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            return failFrom(ctx, result);
          }
          var session = ctx.format.sessionOf(result.envelope);
          ctx.dispatch({ type: 'profile.set', envelope: result.envelope });
          // isAdmin 必须一并刷新：否则管理员点「刷新档案」后管理入口会消失（§5：data.flags.isAdmin）
          ctx.dispatch({ type: 'session.set', token: ctx.state.session.token, publicId: session.publicId, nickname: session.nickname, expiresAt: ctx.state.session.expiresAt, isAdmin: session.isAdmin });
          noticeNotice(ctx, 'info', ctx.format.REFRESH_OK_TEXT);
          return undefined;
        });
      },
    },

    logout: {
      label: '登出',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        busy(ctx, true);
        var done = function (text) {
          busy(ctx, false);
          ctx.storage.clear();
          ctx.dispatch({ type: 'session.clear' });
          ctx.dispatch({ type: 'auth.set', envelope: null });
          ctx.dispatch({ type: 'profile.set', envelope: null });
          clearAdminState(ctx);
          ctx.dispatch({ type: 'view.go', view: 'login' });
          noticeNotice(ctx, 'info', text);
        };
        // 无 token：无可登出，直接按本地意图清空
        if (!token) { done(ctx.format.logoutUnconfirmedText('本地无会话')); return Promise.resolve(); }
        return ctx.api.logout(token).then(function (result) {
          if (result.transport === 'error') return done(ctx.format.logoutUnconfirmedText(result.message));
          if (!ctx.format.isOk(result.envelope)) return done(ctx.format.logoutUnconfirmedText(ctx.format.errorCodeOf(result.envelope)));
          return done(ctx.format.logoutOkText(result.envelope));
        });
      },
    },

    'goto-register': {
      label: '去注册',
      run: function (ctx) {
        ctx.dispatch({ type: 'view.go', view: 'register' });
        return Promise.resolve();
      },
    },

    'goto-login': {
      label: '返回登录',
      run: function (ctx) {
        ctx.dispatch({ type: 'view.go', view: 'login' });
        return Promise.resolve();
      },
    },

    'goto-password': {
      label: '设置密码',
      run: function (ctx) {
        ctx.dispatch({ type: 'form.clear', fields: ['oldPassword', 'newPassword', 'newConfirm'] });
        ctx.dispatch({ type: 'view.go', view: 'password' });
        return Promise.resolve();
      },
    },

    'goto-home': {
      label: '返回主页',
      run: function (ctx) {
        ctx.dispatch({ type: 'form.clear', fields: ['oldPassword', 'newPassword', 'newConfirm'] });
        ctx.dispatch({ type: 'view.go', view: 'home' });
        return Promise.resolve();
      },
    },

    /* ----- F2：管理面板与账号列表（02-accounts.md §4） ----- */

    'goto-admin': {
      label: '管理员面板',
      run: function (ctx) {
        // §3：两屏仅管理员可达；非管理员（手工构造/状态被篡改）→ 与 403 同文案，不切屏
        if (!ctx.state.session || ctx.state.session.isAdmin !== true) {
          adminResult(ctx, 'error', ctx.format.ADMIN_FORBIDDEN_TEXT);
          return Promise.resolve();
        }
        ctx.dispatch({ type: 'admin.confirm.set', confirm: null });
        ctx.dispatch({ type: 'view.go', view: 'admin' });
        return Promise.resolve();
      },
    },

    'admin-refresh-accounts': {
      label: '刷新账号列表',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        // §4：面板与列表的「刷新」都回第一页（offset:0）
        return loadAccounts(ctx, 0, limitOf(ctx));
      },
    },

    'accounts-prev': {
      label: '上一页',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var limit = limitOf(ctx);
        var offset = ctx.state.admin.offset;
        if (offset <= 0) return Promise.resolve(); // 首页：按钮已禁用，此处兜底
        return loadAccounts(ctx, Math.max(0, offset - limit), limit);
      },
    },

    'accounts-next': {
      label: '下一页',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        // A-3：hasMore=false（最后一页）时「下一页」禁用，此处兜底
        if (!ctx.format.accountsHasMore(ctx.state.admin.accounts)) return Promise.resolve();
        var limit = limitOf(ctx);
        return loadAccounts(ctx, ctx.state.admin.offset + limit, limit);
      },
    },

    'accounts-size-20': {
      label: '每页 20',
      run: function (ctx) { return setPageSize(ctx, 20); },
    },

    'accounts-size-50': {
      label: '每页 50',
      run: function (ctx) { return setPageSize(ctx, 50); },
    },

    'accounts-size-100': {
      label: '每页 100',
      run: function (ctx) { return setPageSize(ctx, 100); },
    },

    'admin-delete-account': {
      label: '删除',
      run: function (ctx, payload) {
        // §3.2：删除必须二次确认 → 只进确认态，不发请求
        var target = targetOf(payload);
        if (target.playerId === null && target.publicId === null) {
          adminResult(ctx, 'error', '缺少删除目标（需要 playerId 或 publicId）');
          return Promise.resolve();
        }
        ctx.dispatch({ type: 'admin.confirm.set', confirm: { kind: 'delete', playerId: target.playerId, publicId: target.publicId } });
        return Promise.resolve();
      },
    },

    'confirm-yes': {
      label: '确认删除',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var confirm = ctx.state.admin.confirm;
        if (!confirm || confirm.kind !== 'delete') {
          ctx.dispatch({ type: 'admin.confirm.set', confirm: null });
          return Promise.resolve();
        }
        var body = confirm.playerId === null || confirm.playerId === undefined
          ? { publicId: confirm.publicId }
          : { playerId: confirm.playerId };
        busy(ctx, true);
        return adminCall(ctx, 'delete-account', body).then(function (result) {
          busy(ctx, false);
          ctx.dispatch({ type: 'admin.confirm.set', confirm: null });
          if (result.transport === 'error') return adminFail(ctx, result);
          if (!ctx.format.isOk(result.envelope)) return adminFail(ctx, result);
          adminResult(ctx, 'info', ctx.format.deleteAccountText(result.envelope, confirm.publicId));
          // §4：删后重新拉当前页（页变空且 offset>0 时 loadAccounts 内部按 A-4 回退一页）
          return loadAccounts(ctx, ctx.state.admin.offset, limitOf(ctx));
        });
      },
    },

    'confirm-no': {
      label: '取消',
      run: function (ctx) {
        ctx.dispatch({ type: 'admin.confirm.set', confirm: null });
        return Promise.resolve();
      },
    },

    'admin-stats': {
      label: '服务统计',
      run: function (ctx) {
        return runAdminOp(ctx, 'stats', {}, function (env) { return ctx.format.statsText(env); });
      },
    },

    'admin-rebuild-index': {
      label: '重建索引',
      run: function (ctx) {
        return runAdminOp(ctx, 'rebuild-index', {}, function (env) { return ctx.format.rebuildText(env); });
      },
    },

    'admin-bots': {
      label: '注入调试 bot',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var raw = ctx.state.admin.count === undefined || ctx.state.admin.count === null ? '' : String(ctx.state.admin.count).trim();
        var count = raw === '' ? 1 : Number(raw);
        if (!isFinite(count) || Math.floor(count) !== count || count < 1 || count > BOTS_COUNT_MAX) {
          adminResult(ctx, 'error', '注入数量需为 1~' + BOTS_COUNT_MAX + ' 的整数');
          return Promise.resolve();
        }
        return runAdminOp(ctx, 'bots', { count: count }, function (env) { return ctx.format.botsText(env); });
      },
    },

    'admin-clear-bots': {
      label: '清除调试 bot',
      run: function (ctx) {
        return runAdminOp(ctx, 'clear-bots', {}, function (env) { return ctx.format.clearBotsText(env); });
      },
    },

    'admin-ban-row': {
      label: '封禁',
      run: function (ctx, payload) {
        if (ctx.state.busy) return Promise.resolve();
        var target = targetOf(payload);
        // 行按钮带 playerId（直接封禁）；面板「封禁目标」只带 publicId → 先经账号列表解析 playerId
        if (target.playerId !== null) {
          var known = target.publicId;
          busy(ctx, true);
          return adminCall(ctx, 'ban', { playerId: target.playerId, banned: true }).then(function (result) {
            busy(ctx, false);
            return banOutcome(ctx, result, known);
          });
        }
        var publicId = target.publicId === null ? String(ctx.state.admin.target || '').trim() : target.publicId;
        if (publicId === '') {
          adminResult(ctx, 'error', '请填写封禁目标 publicId');
          return Promise.resolve();
        }
        busy(ctx, true);
        return resolvePlayerIdByPublicId(ctx, publicId).then(function (playerId) {
          if (playerId === undefined) { busy(ctx, false); return undefined; } // 失败文案已写入结果区
          if (playerId === null) {
            busy(ctx, false);
            adminResult(ctx, 'error', '账号列表中没有 publicId=' + publicId + ' 的账号');
            return undefined;
          }
          return adminCall(ctx, 'ban', { playerId: playerId, banned: true }).then(function (result) {
            busy(ctx, false);
            return banOutcome(ctx, result, publicId);
          });
        });
      },
    },

    'admin-unban-row': {
      label: '解封',
      run: function (ctx, payload) {
        if (ctx.state.busy) return Promise.resolve();
        var target = targetOf(payload);
        if (target.playerId === null) {
          adminResult(ctx, 'error', '缺少解封目标 playerId（请在账号列表里点「解封此行」）');
          return Promise.resolve();
        }
        busy(ctx, true);
        return adminCall(ctx, 'unban', { playerId: target.playerId }).then(function (result) {
          busy(ctx, false);
          return banOutcome(ctx, result, target.publicId);
        });
      },
    },
  };

  // 每页条数切换（§4：改 limit 并回到第 1 页）
  function setPageSize(ctx, limit) {
    if (ctx.state.busy) return Promise.resolve();
    ctx.dispatch({ type: 'admin.page.set', offset: 0, limit: limit });
    return loadAccounts(ctx, 0, limit);
  }

  return {
    ACTIONS: ACTIONS,
    USERNAME_RE: USERNAME_RE,
    validateLogin: validateLogin,
    validateRegister: validateRegister,
    validatePassword: validatePassword,
    ADMIN_LIMITS: ADMIN_LIMITS,
  };
});
