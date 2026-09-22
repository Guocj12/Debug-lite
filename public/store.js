'use strict';
/* public/store.js —— 自研状态容器（D-124：无框架 + 自研 store；设计依据 docs/frontend/01-auth.md §7
 *   + F2 增量 docs/frontend/02-accounts.md §7）
 *
 * 纯函数 reducer + 订阅式 store。状态形状与 reducer 动作表逐条对应 01-auth.md §7.1/§7.2 与
 * 02-accounts.md §7；本文件**不读响应字段**（不做投影，投影单一真源在 public/format.js）。
 *
 * F2 关键约束（Q3 结论 A）：`adminToken` **仅内存** —— 本文件不写任何存储，也不产生持久化副作用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.store = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMPTY_SESSION = Object.freeze({ token: null, publicId: null, nickname: null, expiresAt: null, isAdmin: false });
  var FORM_FIELDS = Object.freeze(['username', 'password', 'confirm', 'nickname', 'oldPassword', 'newPassword', 'newConfirm']);
  // F1 四屏 + F2 两屏（02-accounts.md §3：`admin` / `accounts` 仅管理员可达）
  var VIEWS = Object.freeze(['login', 'register', 'home', 'password', 'admin', 'accounts']);
  var ADMIN_VIEWS = Object.freeze(['admin', 'accounts']);
  // 账号列表每页条数三档（02-accounts.md §3.2）
  var ADMIN_LIMITS = Object.freeze([20, 50, 100]);
  // 管理面板输入框（02-accounts.md §3.1；全部只进内存，含管理员令牌）
  var ADMIN_FIELDS = Object.freeze(['adminToken', 'adminTarget', 'adminCount']);
  var ADMIN_DEFAULT_LIMIT = 20;
  var ADMIN_DEFAULT_COUNT = 1;

  function emptyForm() {
    return { username: '', password: '', confirm: '', nickname: '', oldPassword: '', newPassword: '', newConfirm: '' };
  }

  // 管理面初始状态（02-accounts.md §7：accounts/offset/limit/result/confirm/target/count）
  function emptyAdmin() {
    return { accounts: null, offset: 0, limit: ADMIN_DEFAULT_LIMIT, result: null, confirm: null, target: '', count: ADMIN_DEFAULT_COUNT };
  }

  // 初始状态（01-auth.md §7.1 + 02-accounts.md §7）
  function initialState() {
    return {
      view: 'login',
      form: emptyForm(),
      session: { token: null, publicId: null, nickname: null, expiresAt: null, isAdmin: false },
      auth: null,      // 最近一次 register/login 的完整信封（首屏即时显示）
      profile: null,   // GET /me 的完整信封
      notice: null,    // {kind,text} —— text 已是最终文案
      busy: false,
      booted: false,
      adminToken: '',  // **仅内存**（Q3 A）：不写 localStorage；刷新页面后需重填（A-9）
      admin: emptyAdmin(),
    };
  }

  function strOf(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function intOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value ? value : fallback;
  }

  // 纯 reducer：未知动作原样返回（不静默吞掉任何已知动作）
  function reduce(state, action) {
    if (!action || typeof action.type !== 'string') return state;
    switch (action.type) {
      case 'form.set': {
        if (FORM_FIELDS.indexOf(action.field) === -1) return state;
        var form1 = Object.assign({}, state.form);
        form1[action.field] = strOf(action.value);
        return Object.assign({}, state, { form: form1 });
      }
      case 'form.clear': {
        var form2 = Object.assign({}, state.form);
        (action.fields || []).forEach(function (f) { if (FORM_FIELDS.indexOf(f) !== -1) form2[f] = ''; });
        return Object.assign({}, state, { form: form2 });
      }
      case 'view.go':
        // 切屏一律清空提示（01-auth.md §4：goto-* 清空 #notice）；需要提示时在其后单独 notice.set
        return Object.assign({}, state, { view: VIEWS.indexOf(action.view) === -1 ? state.view : action.view, notice: null });
      case 'session.set':
        return Object.assign({}, state, {
          session: {
            token: action.token === undefined ? null : action.token,
            publicId: action.publicId === undefined ? null : action.publicId,
            nickname: action.nickname === undefined ? null : action.nickname,
            expiresAt: action.expiresAt === undefined ? null : action.expiresAt,
            // 02-accounts.md §7：来自 data.player.isAdmin（register|login）/ data.flags.isAdmin（me）；
            // 缺省 false —— 未确认的管理员身份一律不渲染任何管理入口
            isAdmin: action.isAdmin === true,
          },
        });
      case 'session.clear':
        return Object.assign({}, state, { session: Object.assign({}, EMPTY_SESSION) });
      case 'auth.set':
        return Object.assign({}, state, { auth: action.envelope || null });
      case 'profile.set':
        return Object.assign({}, state, { profile: action.envelope || null });
      case 'notice.set':
        return Object.assign({}, state, { notice: action.notice || null });
      case 'busy.set':
        return Object.assign({}, state, { busy: action.busy === true });
      case 'booted.set':
        return Object.assign({}, state, { booted: action.booted === true });
      // 02-accounts.md §7：管理员令牌（仅内存；空串 = 未填）
      case 'admin.token.set':
        return Object.assign({}, state, { adminToken: strOf(action.value) });
      // 02-accounts.md §7：账号列表响应 + 本次请求的 offset/limit（分页信息行与翻页都读它）
      case 'admin.accounts.set': {
        var admin1 = Object.assign({}, state.admin, {
          accounts: action.envelope || null,
          offset: intOr(action.offset, state.admin.offset),
          limit: intOr(action.limit, state.admin.limit),
        });
        return Object.assign({}, state, { admin: admin1 });
      }
      // 02-accounts.md §7：只改分页游标（每页条数切换 / 回到第一页）
      case 'admin.page.set': {
        var admin2 = Object.assign({}, state.admin, {
          offset: intOr(action.offset, state.admin.offset),
          limit: intOr(action.limit, state.admin.limit),
        });
        return Object.assign({}, state, { admin: admin2 });
      }
      // 02-accounts.md §7：最近一次管理操作的结果（{kind,text}，text 已是最终文案）
      case 'admin.result.set': {
        var admin3 = Object.assign({}, state.admin, { result: action.result || null });
        return Object.assign({}, state, { admin: admin3 });
      }
      // 02-accounts.md §7：二次确认态（{kind:'delete',playerId,publicId} | null）
      case 'admin.confirm.set': {
        var admin4 = Object.assign({}, state.admin, { confirm: action.confirm || null });
        return Object.assign({}, state, { admin: admin4 });
      }
      // 02-accounts.md §7：管理面板输入框（管理员令牌 / 封禁目标 / 注入数量）
      case 'admin.form.set': {
        if (ADMIN_FIELDS.indexOf(action.field) === -1) return state;
        if (action.field === 'adminToken') return Object.assign({}, state, { adminToken: strOf(action.value) });
        var admin5 = Object.assign({}, state.admin);
        if (action.field === 'adminTarget') admin5.target = strOf(action.value);
        if (action.field === 'adminCount') admin5.count = strOf(action.value);
        return Object.assign({}, state, { admin: admin5 });
      }
      default:
        return state;
    }
  }

  function createStore(initial) {
    var state = initial || initialState();
    var listeners = [];
    return {
      getState: function () { return state; },
      dispatch: function (action) {
        state = reduce(state, action);
        for (var i = 0; i < listeners.length; i++) listeners[i](state);
        return state;
      },
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      },
    };
  }

  return {
    VIEWS: VIEWS,
    ADMIN_VIEWS: ADMIN_VIEWS,
    ADMIN_LIMITS: ADMIN_LIMITS,
    ADMIN_FIELDS: ADMIN_FIELDS,
    ADMIN_DEFAULT_LIMIT: ADMIN_DEFAULT_LIMIT,
    ADMIN_DEFAULT_COUNT: ADMIN_DEFAULT_COUNT,
    FORM_FIELDS: FORM_FIELDS,
    initialState: initialState,
    emptyForm: emptyForm,
    emptyAdmin: emptyAdmin,
    reduce: reduce,
    createStore: createStore,
  };
});
