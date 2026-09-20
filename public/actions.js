'use strict';
/* public/actions.js —— 按钮↔动作白名单（总纲 §4.1「按钮永不无声」；设计依据 docs/frontend/01-auth.md §4）
 *
 * 本文件是**唯一动作注册表**：render 产出的每个 data-action 必须命中它（双向核对见
 * tests/frontend/auth-ui-contract.test.js）。
 * ctx = { state, dispatch, api, format, storage, actions }。
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

  /* ---------- 客户端预校验（01-auth.md §6 预校验行 / §8 B-1..B-5） ---------- */

  function validateLogin(form) {
    if (!form.username || !form.password) return '请填写用户名与密码';
    return null;
  }

  function validateRegister(form) {
    if (!form.username || !form.password || !form.confirm) return '请填写用户名与密码';
    if (!USERNAME_RE.test(form.username)) return '用户名需 3~24 字符，且只含 [A-Za-z0-9_-]';
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

  function failFrom(ctx, result) {
    if (result.transport === 'error') return noticeNotice(ctx, 'error', ctx.format.networkText(result.message));
    noticeNotice(ctx, 'error', ctx.format.noticeText(result.envelope));
    return undefined;
  }

  // 会话失效（401/403）：清本地凭据 → 切登录屏 → 提示（01-auth.md §6「401 的统一处理」）
  function sessionLost(ctx, result) {
    ctx.storage.clear();
    ctx.dispatch({ type: 'session.clear' });
    ctx.dispatch({ type: 'auth.set', envelope: null });
    ctx.dispatch({ type: 'profile.set', envelope: null });
    ctx.dispatch({ type: 'view.go', view: 'login' });
    if (result && result.envelope) noticeNotice(ctx, 'error', ctx.format.noticeText(result.envelope));
    else noticeNotice(ctx, 'error', '会话已失效，请重新登录');
  }

  function busy(ctx, value) { ctx.dispatch({ type: 'busy.set', busy: value }); }

  /* ---------- 动作表（01-auth.md §4，共 9 个） ---------- */

  var ACTIONS = {

    'submit-login': {
      label: '登录',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var invalid = validateLogin(ctx.state.form);
        if (invalid !== null) { noticeNotice(ctx, 'error', invalid); return Promise.resolve(); }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.login({ username: ctx.state.form.username, password: ctx.state.form.password }).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) return failFrom(ctx, result);
          var session = ctx.format.sessionOf(result.envelope);
          ctx.storage.saveSession(session);
          ctx.dispatch({ type: 'auth.set', envelope: result.envelope });
          ctx.dispatch({ type: 'session.set', token: session.token, publicId: session.publicId, nickname: session.nickname, expiresAt: session.expiresAt });
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
        var payload = { username: ctx.state.form.username, password: ctx.state.form.password };
        if (ctx.state.form.nickname) payload.nickname = ctx.state.form.nickname;
        return ctx.api.register(payload).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) return failFrom(ctx, result);
          var session = ctx.format.sessionOf(result.envelope);
          ctx.storage.saveSession(session);
          ctx.dispatch({ type: 'auth.set', envelope: result.envelope });
          ctx.dispatch({ type: 'session.set', token: session.token, publicId: session.publicId, nickname: session.nickname, expiresAt: session.expiresAt });
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
          ctx.dispatch({ type: 'session.set', token: ctx.state.session.token, publicId: session.publicId, nickname: session.nickname, expiresAt: ctx.state.session.expiresAt });
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
  };

  return {
    ACTIONS: ACTIONS,
    USERNAME_RE: USERNAME_RE,
    validateLogin: validateLogin,
    validateRegister: validateRegister,
    validatePassword: validatePassword,
  };
});
