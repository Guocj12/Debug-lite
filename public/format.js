'use strict';
/* public/format.js —— **投影单一真源**（总纲 §1.5；设计依据 docs/frontend/01-auth.md §3/§5/§6
 *   + F2 增量 docs/frontend/02-accounts.md §3/§5/§6）
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
  function numOr(v, fallback) { return typeof v === 'number' && isFinite(v) ? v : fallback; }
  function yesNo(v, yes, no) { return v === true ? yes : no; }

  function stamp(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '未知';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 详情里的字段级错误（取首条 path）；F1 与 F2 共用同一口径
  function fieldTail(env) {
    var details = pick(env, 'error.details');
    var first = Array.isArray(details) && details.length > 0 ? details[0] : null;
    var fieldPath = first && typeof first.path === 'string' && first.path !== '' ? first.path : null;
    return fieldPath === null ? '' : '（字段：' + fieldPath + '）';
  }

  /* ---------- 会话 ---------- */

  // 登录/注册响应 与 /me 响应都含 data.publicId / data.nickname（/me 无 token → 传 null 保留原 token）
  function sessionOf(env) {
    return {
      token: str(pick(env, 'data.token')),
      publicId: str(pick(env, 'data.publicId')),
      nickname: str(pick(env, 'data.nickname')),
      expiresAt: typeof pick(env, 'data.expiresAt') === 'number' ? pick(env, 'data.expiresAt') : null,
      isAdmin: isAdminOf(env),
    };
  }

  // 02-accounts.md §5：管理员身份的两个回带位置（register|login 的 player.isAdmin / me 的 flags.isAdmin）
  function isAdminOf(env) {
    return pick(env, 'data.player.isAdmin') === true || pick(env, 'data.flags.isAdmin') === true;
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
    invalid_credentials: '注意：密码区分大小写，且不要有多余空格或全角字符',
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
    var text = hint === '' ? message : hint + '：' + message;
    return text + fieldTail(env);
  }

  function networkText(reason) { return '无法连接服务器：' + or(reason, '未知错误'); }

  /* ---------- 管理面文案（02-accounts.md §4/§6） ---------- */

  // §6 全部失败路径的界面文案（与 F1 的 HINTS **分开**：F1 的 bad_request 指引是"用户名与昵称"，
  //   用在分页参数/bots count 上会误导，故管理面自成一表；未登记 code 一律只展示服务端文案）
  var ADMIN_HINTS = Object.freeze({
    forbidden: '需要管理员权限（登录管理员账号，或填写管理员令牌）',
    admin_token_missing: '服务端未配置管理员令牌（DL_ADMIN_TOKEN），且当前账号不是管理员',
    debug_bots_disabled: '调试 bot 注入已关闭（需服务端设 DL_DEBUG_BOTS=1）',
    cannot_delete_self: '不能删除当前登录的管理员账号',
    store_not_found: '该账号不存在或已被删除',
    rate_limited: '请求过于频繁',
    unauthorized: '会话已失效，请重新登录',
    session_expired: '会话已失效，请重新登录',
    banned: '账号已被封禁',
    store_unavailable: '服务暂不可用（存储未启用）',
    internal_error: '服务端内部错误',
  });

  // 非管理员被拦下时的固定文案（§6 forbidden 行；本地兜底与 403 响应同文案）
  var ADMIN_FORBIDDEN_TEXT = ADMIN_HINTS.forbidden;

  function adminNoticeText(env) {
    var message = or(pick(env, 'error.message'), '请求失败');
    var hint = ADMIN_HINTS[errorCodeOf(env)] === undefined ? '' : ADMIN_HINTS[errorCodeOf(env)];
    // 服务端文案已含该指引时不再重复前置（如 cannot_delete_self 的 message 与指引同文）
    var text = (hint === '' || message.indexOf(hint) !== -1) ? message : hint + '：' + message;
    return text + fieldTail(env);
  }

  // data.stats 摘要行（§11 走查步 4 期望 `players=<n> seq=<n> snapshots=<n>`）
  function statsText(env) {
    var snapshots = pick(env, 'data.snapshots');
    var snapText = snapshots === null || snapshots === undefined ? '不可用' : '已装配';
    return 'players=' + num(pick(env, 'data.players'))
      + ' seq=' + num(pick(env, 'data.seq'))
      + ' snapshots=' + snapText;
  }
  function rebuildText(env) { return '重建完成：' + num(pick(env, 'data.players')) + ' 玩家'; }
  function botsText(env) {
    return '已注入 ' + num(pick(env, 'data.injected')) + ' 个（跳过 ' + num(pick(env, 'data.skipped')) + ' 个）';
  }
  function clearBotsText(env) { return '已清除 ' + num(pick(env, 'data.removed')) + ' 个'; }
  function deleteAccountText(env, fallbackPublicId) {
    var removed = pick(env, 'data.removed') === true;
    return (removed ? '已删除 ' : '服务端未确认删除：') + or(pick(env, 'data.publicId'), or(fallbackPublicId, '该账号'));
  }
  function banText(env, publicId) {
    var banned = pick(env, 'data.banned') === true;
    return (banned ? '已封禁 ' : '已解封 ') + or(publicId, '该账号');
  }

  /* ---------- 账号列表（02-accounts.md §3.2/§5） ---------- */

  // 行字段清单（§5 的 `data.rows` 行「逐项取 …」；与 public/contract.js 的 ADMIN_ROW_FIELDS
  //   逐条相等，由 tests/frontend/admin-ui-contract.test.js 机器核对）
  var ADMIN_ROW_FIELDS = Object.freeze(['playerId', 'publicId', 'nickname', 'tier', 'points', 'inPool', 'isBot', 'banned', 'lastSeenAt']);

  function rowValueOf(row) {
    var out = {};
    for (var i = 0; i < ADMIN_ROW_FIELDS.length; i++) out[ADMIN_ROW_FIELDS[i]] = pick(row, ADMIN_ROW_FIELDS[i]);
    return out;
  }

  function accountRows(env) {
    var rows = pick(env, 'data.rows');
    if (!Array.isArray(rows)) return [];
    var offset = numOr(pick(env, 'data.offset'), 0);
    return rows.map(function (row, i) {
      var r = rowValueOf(row);
      var marks = (r.inPool === true ? '[在池]' : '[不在池]')
        + (r.isBot === true ? ' [bot]' : '')
        + (r.banned === true ? ' [已封禁]' : '');
      return {
        playerId: str(r.playerId),
        publicId: str(r.publicId),
        text: (offset + i + 1) + '. ' + or(r.publicId, '未知账号') + '  ' + or(r.nickname, '（无昵称）')
          + '  段位' + or(r.tier, '未知') + '  积分' + num(r.points) + '  ' + marks
          + '  playerId=' + or(r.playerId, '未知') + '  最后活跃' + stamp(r.lastSeenAt),
      };
    });
  }

  // 分页信息行（§3.2：`共 <total> 个账号，第 <page>/<pages> 页（每页 <limit>）`）
  function accountsInfoText(env) {
    var total = numOr(pick(env, 'data.total'), 0);
    var offset = numOr(pick(env, 'data.offset'), 0);
    var limit = Math.max(1, numOr(pick(env, 'data.limit'), 20));
    var pages = Math.max(1, Math.ceil(total / limit));
    var page = Math.min(pages, Math.floor(Math.max(0, offset) / limit) + 1);
    return '共 ' + total + ' 个账号，第 ' + page + '/' + pages + ' 页（每页 ' + limit + '）';
  }
  function accountsHasMore(env) { return pick(env, 'data.hasMore') === true; }

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
      result: null,
      lines: [],
      rows: [],
      confirm: null,
      fields: [],
      buttons: [],
      enterAction: null,
    }, extra || {});
  }

  function noticeOf(state) {
    return state.notice && state.notice.text ? { kind: state.notice.kind || 'info', text: state.notice.text } : null;
  }

  // 主页视图模型（home；也是 admin/accounts 在**非管理员**态下的兜底 —— 02-accounts.md §8 A-1）
  function homeViewModel(state, notice, busy) {
    var buttons = [
      { action: 'refresh-profile', label: '刷新档案', kind: 'button', disabled: busy },
      { action: 'goto-password', label: '设置密码', kind: 'button', disabled: busy },
      { action: 'logout', label: '登出', kind: 'button', disabled: busy },
    ];
    // §3.3：仅 state.session.isAdmin === true 才渲染管理入口；普通账号**完全**不出现（含非管理员态兜底）
    if (state.session && state.session.isAdmin === true) {
      buttons.push({ action: 'goto-admin', label: '管理员面板', kind: 'button', disabled: busy });
    }
    return vm('已登录', { notice: notice, lines: homeLines(state), buttons: buttons });
  }

  // 管理面板（02-accounts.md §3.1）
  function adminViewModel(state, notice, busy) {
    return vm('管理员面板', {
      notice: notice,
      hint: '你是管理员账号：' + or(state.session && state.session.publicId, '未知')
        + '；下方为后端已实现的管理能力（管理员令牌仅存于本页内存：刷新页面后需重填）',
      result: state.admin.result,
      fields: [
        { name: 'adminToken', label: '管理员令牌（可留空：用管理员账号身份免填）', type: 'password', value: state.adminToken },
        { name: 'adminTarget', label: '封禁目标 publicId', type: 'text', value: state.admin.target },
        { name: 'adminCount', label: '注入数量', type: 'text', value: state.admin.count },
      ],
      buttons: [
        { action: 'admin-refresh-accounts', label: '刷新账号列表', kind: 'button', disabled: busy },
        { action: 'admin-stats', label: '服务统计', kind: 'button', disabled: busy },
        { action: 'admin-rebuild-index', label: '重建索引', kind: 'button', disabled: busy },
        { action: 'admin-bots', label: '注入调试 bot', kind: 'button', disabled: busy },
        { action: 'admin-clear-bots', label: '清除调试 bot', kind: 'button', disabled: busy },
        { action: 'admin-ban-row', label: '封禁目标', kind: 'button', disabled: busy },
        { action: 'goto-home', label: '返回主页', kind: 'button', disabled: busy },
      ],
      enterAction: 'admin-refresh-accounts',
    });
  }

  // 账号列表（02-accounts.md §3.2）
  function accountsViewModel(state, notice, busy) {
    var envelope = state.admin.accounts;
    var rows = envelope ? accountRows(envelope) : [];
    var hasMore = envelope ? accountsHasMore(envelope) : false;
    var offset = state.admin.offset;
    var confirm = state.admin.confirm;
    var confirmVm = confirm && confirm.kind === 'delete'
      ? {
        text: '确认删除 ' + or(confirm.publicId, '该账号') + '？此操作不可撤销',
        buttons: [
          { action: 'confirm-yes', label: '确认删除', kind: 'button', disabled: busy },
          { action: 'confirm-no', label: '取消', kind: 'button', disabled: busy },
        ],
      }
      : null;
    return vm('账号列表', {
      notice: notice,
      result: state.admin.result,
      lines: [envelope ? accountsInfoText(envelope) : '（尚未加载账号列表：点「刷新」）'],
      rows: rows.map(function (row) {
        return {
          text: row.text,
          buttons: [
            { action: 'admin-delete-account', label: '删除', kind: 'button', disabled: busy, playerId: row.playerId, publicId: row.publicId },
            { action: 'admin-ban-row', label: '封禁此行', kind: 'button', disabled: busy, playerId: row.playerId, publicId: row.publicId },
            { action: 'admin-unban-row', label: '解封此行', kind: 'button', disabled: busy, playerId: row.playerId, publicId: row.publicId },
          ],
        };
      }),
      confirm: confirmVm,
      buttons: [
        { action: 'accounts-prev', label: '上一页', kind: 'button', disabled: busy || offset <= 0 },
        { action: 'accounts-next', label: '下一页', kind: 'button', disabled: busy || !hasMore },
        { action: 'admin-refresh-accounts', label: '刷新', kind: 'button', disabled: busy },
        { action: 'goto-admin', label: '返回面板', kind: 'button', disabled: busy },
        { action: 'accounts-size-20', label: '每页 20', kind: 'button', disabled: busy },
        { action: 'accounts-size-50', label: '每页 50', kind: 'button', disabled: busy },
        { action: 'accounts-size-100', label: '每页 100', kind: 'button', disabled: busy },
      ],
    });
  }

  function viewModel(state) {
    var notice = noticeOf(state);
    var busy = state.busy === true;

    // F2 两屏仅管理员可达（02-accounts.md §3）；非管理员态一律兜底到主页（A-1：入口完全不渲染）
    var isAdmin = state.session && state.session.isAdmin === true;
    if ((state.view === 'admin' || state.view === 'accounts') && !isAdmin) return homeViewModel(state, notice, busy);

    if (state.view === 'admin') return adminViewModel(state, notice, busy);
    if (state.view === 'accounts') return accountsViewModel(state, notice, busy);

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

    if (state.view === 'home') return homeViewModel(state, notice, busy);

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
    isAdminOf: isAdminOf,
    loginOkText: loginOkText,
    registerOkText: registerOkText,
    passwordOkText: passwordOkText,
    logoutOkText: logoutOkText,
    logoutUnconfirmedText: logoutUnconfirmedText,
    REFRESH_OK_TEXT: REFRESH_OK_TEXT,
    hintFor: hintFor,
    noticeText: noticeText,
    networkText: networkText,
    ADMIN_HINTS: ADMIN_HINTS,
    ADMIN_FORBIDDEN_TEXT: ADMIN_FORBIDDEN_TEXT,
    adminNoticeText: adminNoticeText,
    statsText: statsText,
    rebuildText: rebuildText,
    botsText: botsText,
    clearBotsText: clearBotsText,
    deleteAccountText: deleteAccountText,
    banText: banText,
    ADMIN_ROW_FIELDS: ADMIN_ROW_FIELDS,
    accountRows: accountRows,
    accountsInfoText: accountsInfoText,
    accountsHasMore: accountsHasMore,
    authLines: authLines,
    profileLines: profileLines,
    homeLines: homeLines,
    viewModel: viewModel,
  };
});
