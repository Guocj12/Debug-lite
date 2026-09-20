'use strict';
/* public/store.js —— 自研状态容器（D-124：无框架 + 自研 store；设计依据 docs/frontend/01-auth.md §7）
 *
 * 纯函数 reducer + 订阅式 store。状态形状与 reducer 动作表逐条对应 01-auth.md §7.1/§7.2；
 * 本文件**不读响应字段**（不做投影，投影单一真源在 public/format.js）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.store = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMPTY_SESSION = Object.freeze({ token: null, publicId: null, nickname: null, expiresAt: null });
  var FORM_FIELDS = Object.freeze(['username', 'password', 'confirm', 'nickname', 'oldPassword', 'newPassword', 'newConfirm']);
  var VIEWS = Object.freeze(['login', 'register', 'home', 'password']);

  function emptyForm() {
    return { username: '', password: '', confirm: '', nickname: '', oldPassword: '', newPassword: '', newConfirm: '' };
  }

  // 初始状态（01-auth.md §7.1）
  function initialState() {
    return {
      view: 'login',
      form: emptyForm(),
      session: { token: null, publicId: null, nickname: null, expiresAt: null },
      auth: null,      // 最近一次 register/login 的完整信封（首屏即时显示）
      profile: null,   // GET /me 的完整信封
      notice: null,    // {kind,text} —— text 已是最终文案
      busy: false,
      booted: false,
    };
  }

  // 纯 reducer：未知动作原样返回（不静默吞掉任何已知动作）
  function reduce(state, action) {
    if (!action || typeof action.type !== 'string') return state;
    switch (action.type) {
      case 'form.set': {
        if (FORM_FIELDS.indexOf(action.field) === -1) return state;
        var form1 = Object.assign({}, state.form);
        form1[action.field] = action.value === undefined || action.value === null ? '' : String(action.value);
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
    FORM_FIELDS: FORM_FIELDS,
    initialState: initialState,
    emptyForm: emptyForm,
    reduce: reduce,
    createStore: createStore,
  };
});
