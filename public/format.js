'use strict';
/* public/format.js —— **投影单一真源**（总纲 §1.5；设计依据 docs/frontend/01-auth.md §3/§5/§6）
 *
 * 职责：把「状态 / 响应信封」投影成**最终文字与视图模型**。全前端只有本文件读响应字段，
 * 且一律经字段读取原语（路径为字符串字面量）—— 路径清单与 public/contract.js 逐条相等（测试强制）。
 * 本文件不碰 DOM、不发请求、不复制任何战斗公式。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.format = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var PAGE_TITLE = 'Debug-Lite v3 · 账号';

  // 唯一的字段读取原语（路径为字面量，便于机器核对）
  function pick(obj, path) {
    var cur = obj;
    var segs = String(path).split('.');
    for (var i = 0; i < segs.length; i++) {
      if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
      cur = cur[segs[i]];
    }
    return cur;
  }

  function isOk(env) { return pick(env, 'ok') === true; }
  function errorCodeOf(env) {
    var code = pick(env, 'error.code');
    return typeof code === 'string' && code !== '' ? code : 'unknown_error';
  }
  function isSessionError(env) {
    var code = errorCodeOf(env);
    return code === 'unauthorized' || code === 'session_expired' || code === 'banned';
  }

  function str(v) { return typeof v === 'string' && v !== '' ? v : null; }
  function or(v, fallback) { var s = str(v); return s === null ? fallback : s; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? String(v) : '—'; }
  function yesNo(v, yes, no) { return v === true ? yes : no; }

  function stamp(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '未知';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ---------- 会话 ---------- */

  // 登录/注册响应 与 /me 响应都含 data.publicId / data.nickname（/me 无 token → 传 null 保留原 token）
  function sessionOf(env) {
    return {
      token: str(pick(env, 'data.token')),
      publicId: str(pick(env, 'data.publicId')),
      nickname: str(pick(env, 'data.nickname')),
      expiresAt: typeof pick(env, 'data.expiresAt') === 'number' ? pick(env, 'data.expiresAt') : null,
    };
  }

  /* ---------- 成功文案（01-auth.md §4） ---------- */

  function loginOkText(env) {
    return '登录成功：' + or(pick(env, 'data.nickname'), '（无昵称）') + '（' + or(pick(env, 'data.publicId'), '未知账号') + '）';
  }
  function registerOkText(env) {
    return '注册成功：' + or(pick(env, 'data.nickname'), '（无昵称）') + '（' + or(pick(env, 'data.publicId'), '未知账号') + '）';
  }
  function passwordOkText(env) {
    var n = num(pick(env, 'data.revokedOthers'));
    var changed = pick(env, 'data.changed') === true;
    return '改密成功：已撤销其他设备会话 ' + n + ' 个' + (changed ? '' : '（服务端未确认 changed）');
  }
  function logoutOkText(env) {
    return pick(env, 'data.revoked') === true ? '已登出' : '已登出（服务端未确认）';
  }
  function logoutUnconfirmedText(reason) {
    return '已登出（服务端未确认：' + or(reason, '未知原因') + '）';
  }
  var REFRESH_OK_TEXT = '档案已刷新';

  /* ---------- 失败文案（01-auth.md §6） ---------- */

  var HINTS = Object.freeze({
    username_taken: '换个用户名试试',
    weak_password: '密码需 8~72 字符',
    bad_request: '检查用户名与昵称格式',
    too_many_attempts: '稍后再试',
    rate_limited: '请求过于频繁',
    unauthorized: '会话已失效，请重新登录',
    session_expired: '会话已失效，请重新登录',
    banned: '账号已被封禁',
    payload_too_large: '输入过长',
    store_unavailable: '服务暂不可用（存储未启用）',
    internal_error: '服务端内部错误',
  });

  function hintFor(code) { return HINTS[code] === undefined ? '' : HINTS[code]; }

  // 失败文案 = 附加指引（若有）+ 服务端 message + 首条 details 的字段名（若有）
  function noticeText(env) {
    var message = or(pick(env, 'error.message'), '请求失败');
    var hint = hintFor(errorCodeOf(env));
    var details = pick(env, 'error.details');
    var first = Array.isArray(details) && details.length > 0 ? details[0] : null;
    var fieldPath = first && typeof first.path === 'string' && first.path !== '' ? first.path : null;
    var text = hint === '' ? message : hint + '：' + message;
    if (fieldPath !== null) text += '（字段：' + fieldPath + '）';
    return text;
  }

  function networkText(reason) { return '无法连接服务器：' + or(reason, '未知错误'); }

  /* ---------- 主页文本行（01-auth.md §3.3/§5） ---------- */

  // 首屏（登录/注册刚成功，尚未取 /me）：来自 register|login 响应
  function authLines(env) {
    return [
      '账号：' + or(pick(env, 'data.publicId'), '未知'),
      '昵称：' + or(pick(env, 'data.nickname'), '（未设置）'),
      '段位：' + or(pick(env, 'data.player.tier'), '未知'),
      '积分：' + num(pick(env, 'data.player.points')),
      '出战槽：' + or(pick(env, 'data.player.activeSlotName'), '未知'),
      '会话到期：' + stamp(pick(env, 'data.expiresAt')),
      '档案明细尚未读取：点「刷新档案」获取',
    ];
  }

  // 完整档案（GET /me）
  function profileLines(env) {
    var slots = pick(env, 'data.slots');
    var slotText = Array.isArray(slots) && slots.length > 0
      ? slots.map(function (s) {
        var name = s && s.name ? s.name : '（未命名）';
        return name + (s && s.isDefault === true ? '（默认）' : '');
      }).join('、')
      : '无';
    return [
      '账号：' + or(pick(env, 'data.publicId'), '未知'),
      '昵称：' + or(pick(env, 'data.nickname'), '（未设置）'),
      '段位：' + or(pick(env, 'data.progress.tier'), '未知') + '（峰值 ' + or(pick(env, 'data.progress.peakTier'), '未知') + '）',
      '积分：' + num(pick(env, 'data.rating.points')),
      '总场次：' + num(pick(env, 'data.rating.games')) + '（胜 ' + num(pick(env, 'data.rating.wins'))
        + ' / 负 ' + num(pick(env, 'data.rating.losses')) + ' / 平 ' + num(pick(env, 'data.rating.draws')) + '）',
      '出战槽：' + or(pick(env, 'data.activeSlotId'), '未知') + '（' + or(pick(env, 'data.activeSlotName'), '未命名') + '）',
      '配置槽：' + slotText,
      '战绩·进攻：胜 ' + num(pick(env, 'data.record.stats.attack.wins')) + ' / 负 ' + num(pick(env, 'data.record.stats.attack.losses'))
        + ' / 平 ' + num(pick(env, 'data.record.stats.attack.draws')),
      '战绩·防守：胜 ' + num(pick(env, 'data.record.stats.defense.wins')) + ' / 负 ' + num(pick(env, 'data.record.stats.defense.losses'))
        + ' / 平 ' + num(pick(env, 'data.record.stats.defense.draws')),
      '未读：进攻 ' + num(pick(env, 'data.record.unread.attack')) + ' / 防守 ' + num(pick(env, 'data.record.unread.defense')),
      '匹配池：' + yesNo(pick(env, 'data.pool.inPool'), '在池', '不在池') + '（被抽 ' + num(pick(env, 'data.pool.drawnCount')) + ' 次）',
      '仓库校验：' + yesNo(pick(env, 'data.flags.unverifiedLoadout'), '未校验（提交仓库镜像后转已校验）', '已校验'),
      '机器人账号：' + yesNo(pick(env, 'data.flags.isBot'), '是', '否'),
    ];
  }

  function homeLines(state) {
    if (state && state.profile) return profileLines(state.profile);
    if (state && state.auth) return authLines(state.auth);
    return ['（尚未读取到档案数据）'];
  }

  /* ---------- 视图模型（render 的唯一输入；render 内不得再查状态） ---------- */

  function vm(title, extra) {
    return Object.assign({
      pageTitle: PAGE_TITLE,
      title: title,
      notice: null,
      hint: '',
      lines: [],
      fields: [],
      buttons: [],
      enterAction: null,
    }, extra || {});
  }

  function viewModel(state) {
    var notice = state.notice && state.notice.text ? { kind: state.notice.kind || 'info', text: state.notice.text } : null;
    var busy = state.busy === true;

    if (state.view === 'register') {
      return vm('注册', {
        notice: notice,
        hint: '用户名 3~24 字符，仅 [A-Za-z0-9_-]；密码 8~72 字符；昵称可留空，最长 16 字符',
        fields: [
          { name: 'username', label: '用户名', type: 'text', value: state.form.username },
          { name: 'password', label: '密码', type: 'password', value: state.form.password },
          { name: 'confirm', label: '确认密码', type: 'password', value: state.form.confirm },
          { name: 'nickname', label: '昵称（可留空）', type: 'text', value: state.form.nickname },
        ],
        buttons: [
          { action: 'submit-register', label: '注册', kind: 'submit', disabled: busy },
          { action: 'goto-login', label: '返回登录', kind: 'button', disabled: busy },
        ],
        enterAction: 'submit-register',
      });
    }

    if (state.view === 'home') {
      return vm('已登录', {
        notice: notice,
        lines: homeLines(state),
        buttons: [
          { action: 'refresh-profile', label: '刷新档案', kind: 'button', disabled: busy },
          { action: 'goto-password', label: '设置密码', kind: 'button', disabled: busy },
          { action: 'logout', label: '登出', kind: 'button', disabled: busy },
        ],
      });
    }

    if (state.view === 'password') {
      return vm('设置密码', {
        notice: notice,
        hint: '新密码 8~72 字符；改密成功后其他设备的会话会被撤销',
        fields: [
          { name: 'oldPassword', label: '原密码', type: 'password', value: state.form.oldPassword },
          { name: 'newPassword', label: '新密码', type: 'password', value: state.form.newPassword },
          { name: 'newConfirm', label: '确认新密码', type: 'password', value: state.form.newConfirm },
        ],
        buttons: [
          { action: 'submit-password', label: '提交改密', kind: 'submit', disabled: busy },
          { action: 'goto-home', label: '返回主页', kind: 'button', disabled: busy },
        ],
        enterAction: 'submit-password',
      });
    }

    // 缺省 = login
    return vm('登录', {
      notice: notice,
      hint: '用户名 3~24 字符，仅 [A-Za-z0-9_-]；密码 8~72 字符',
      fields: [
        { name: 'username', label: '用户名', type: 'text', value: state.form.username },
        { name: 'password', label: '密码', type: 'password', value: state.form.password },
      ],
      buttons: [
        { action: 'submit-login', label: '登录', kind: 'submit', disabled: busy },
        { action: 'goto-register', label: '去注册', kind: 'button', disabled: busy },
      ],
      enterAction: 'submit-login',
    });
  }

  return {
    PAGE_TITLE: PAGE_TITLE,
    pick: pick,
    isOk: isOk,
    errorCodeOf: errorCodeOf,
    isSessionError: isSessionError,
    sessionOf: sessionOf,
    loginOkText: loginOkText,
    registerOkText: registerOkText,
    passwordOkText: passwordOkText,
    logoutOkText: logoutOkText,
    logoutUnconfirmedText: logoutUnconfirmedText,
    REFRESH_OK_TEXT: REFRESH_OK_TEXT,
    hintFor: hintFor,
    noticeText: noticeText,
    networkText: networkText,
    authLines: authLines,
    profileLines: profileLines,
    homeLines: homeLines,
    viewModel: viewModel,
  };
});
