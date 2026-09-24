'use strict';
/* public/store.js —— 自研状态容器（D-124：无框架 + 自研 store；设计依据 docs/frontend/01-auth.md §7
 *   + F2 增量 docs/frontend/02-accounts.md §7 + F3 增量 docs/frontend/03-hub-warehouse-loadout.md §7）
 *
 * 纯函数 reducer + 订阅式 store。状态形状与 reducer 动作表逐条对应 01-auth.md §7.1/§7.2、
 * 02-accounts.md §7 与 03-hub-warehouse-loadout.md §7；本文件**不读响应字段**
 * （不做投影，投影单一真源在 public/format.js）。
 *
 * F2 关键约束（Q3 结论 A）：`adminToken` **仅内存** —— 本文件不写任何存储，也不产生持久化副作用。
 * F3 关键约束（FR-13 / D-159）：仓库与出战配置全部来自服务端，**不再有 dl.warehouse** 之类的本地持久化；
 *   `modal` 描述屏内弹窗（FR-10：弹窗 = 屏内绘制区块，不是浏览器原生弹窗）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.store = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EMPTY_SESSION = Object.freeze({ token: null, publicId: null, nickname: null, expiresAt: null, isAdmin: false });
  var FORM_FIELDS = Object.freeze(['username', 'password', 'confirm', 'nickname', 'oldPassword', 'newPassword', 'newConfirm']);
  // F1 四屏 + F2 两屏 + F3 九屏（03 §3：hub/profile/warehouse/box/settings + 4 个空页）
  var VIEWS = Object.freeze([
    'login', 'register', 'hub', 'profile', 'password', 'admin', 'accounts',
    'warehouse', 'box', 'settings', 'quick', 'tournament', 'leaderboard', 'ai-editor',
  ]);
  var ADMIN_VIEWS = Object.freeze(['admin', 'accounts']);
  // 账号列表每页条数三档（02-accounts.md §3.2）
  var ADMIN_LIMITS = Object.freeze([20, 50, 100]);
  // 管理面板输入框（02-accounts.md §3.1；全部只进内存，含管理员令牌）
  var ADMIN_FIELDS = Object.freeze(['adminToken', 'adminTarget', 'adminCount']);
  var ADMIN_DEFAULT_LIMIT = 20;
  var ADMIN_DEFAULT_COUNT = 1;

  // F3：非 form 的屏内输入框（开箱次数 / 新昵称）—— 由 app.js 的 input 委托按名字路由到各自 reducer
  var BOX_TIMES_FIELD = 'boxTimes';
  var NICKNAME_FIELD = 'settingsNickname';
  var SCREEN_FIELDS = Object.freeze([BOX_TIMES_FIELD, NICKNAME_FIELD]);

  // F3：仓库四桶（与 GET /me/warehouse 的 data.buckets 键逐条相等；03 §5.2）
  var WAREHOUSE_BUCKETS = Object.freeze(['role', 'skill', 'rolePlugin', 'skillPlugin']);
  // F3：开箱次数上限（与 server/box.js 的 BOX_TIMES_MAX 同口径；03 §3.4）
  var BOX_TIMES_MAX = 100;
  var BOX_TIMES_DEFAULT = 1;
  // F3：屏内弹窗种类（03 §3.7/§3.8；至多一个）
  var MODAL_KINDS = Object.freeze(['item-detail', 'config']);

  function emptyForm() {
    return { username: '', password: '', confirm: '', nickname: '', oldPassword: '', newPassword: '', newConfirm: '' };
  }

  // 管理面初始状态（02-accounts.md §7：accounts/offset/limit/result/confirm/target/count）
  function emptyAdmin() {
    return { accounts: null, offset: 0, limit: ADMIN_DEFAULT_LIMIT, result: null, confirm: null, target: '', count: ADMIN_DEFAULT_COUNT };
  }

  // 仓库（03 §7；真源永远是重新请求 GET /me/warehouse）—— 只存**最近一次响应信封**，
  //   由 public/format.js 投影（本文件不解释任何响应字段）
  function emptyWarehouse() {
    return { envelope: null, loading: false };
  }

  // 出战配置（03 §7）：本批只用 `activeSlotId` 判"出战中"（配置编辑器属提交③）
  function emptyConfigs() {
    return { data: null, draft: null, dirty: false };
  }

  // 初始状态（01-auth.md §7.1 + 02-accounts.md §7 + 03 §7）
  function initialState() {
    return {
      view: 'login',
      modal: null,     // {kind:'item-detail',uid} / {kind:'config',slotId} —— 至多一个（03 §3.8）
      form: emptyForm(),
      session: { token: null, publicId: null, nickname: null, expiresAt: null, isAdmin: false },
      auth: null,      // 最近一次 register/login 的完整信封（首屏即时显示）
      profile: null,   // GET /me 的完整信封（hub 摘要 / profile 各行都读它）
      notice: null,    // {kind,text} —— text 已是最终文案
      busy: false,
      booted: false,
      adminToken: '',  // **仅内存**（Q3 A）：不写 localStorage；刷新页面后需重填（A-9）
      admin: emptyAdmin(),
      warehouse: emptyWarehouse(),
      warehouseBucket: 'role',
      box: { times: String(BOX_TIMES_DEFAULT), result: null },
      configs: emptyConfigs(),
      settings: { nickname: '', result: null },
    };
  }

  function strOf(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  function intOr(value, fallback) {
    return typeof value === 'number' && isFinite(value) && Math.floor(value) === value ? value : fallback;
  }

  function objectOr(value, fallback) {
    return value && typeof value === 'object' ? value : fallback;
  }

  // 数字输入框（开箱次数）：一律存**字符串**（与 F1/F2 的输入框同构，避免"1"→1 的隐式转换歧义），
  //   由 public/actions.js 在提交前解析并做 1~100 的客户端预校验（03 §8 B-3）。
  //   空串**不做缺省填充**：它属于"非数字"，必须被拦下而不是偷偷变成 1。
  function boxTimesOf(value) {
    return strOf(value);
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
      // F3：非 form 的屏内输入框（开箱次数 / 新昵称）
      case 'screen.form.set': {
        if (SCREEN_FIELDS.indexOf(action.field) === -1) return state;
        if (action.field === BOX_TIMES_FIELD) {
          return Object.assign({}, state, { box: Object.assign({}, state.box, { times: boxTimesOf(action.value) }) });
        }
        return Object.assign({}, state, { settings: Object.assign({}, state.settings, { nickname: strOf(action.value) }) });
      }
      case 'view.go':
        // 切屏一律清空提示与弹窗（01-auth.md §4：goto-* 清空 #notice；03 §3.8：弹窗不跨屏存活）
        return Object.assign({}, state, {
          view: VIEWS.indexOf(action.view) === -1 ? state.view : action.view,
          notice: null,
          modal: null,
        });
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
      // 03 §3.8：同时至多一个弹窗；打开新弹窗即替换旧的；close 必须能真正清空
      case 'modal.set':
        return Object.assign({}, state, {
          modal: action.modal && MODAL_KINDS.indexOf(action.modal.kind) !== -1 ? action.modal : null,
        });
      case 'modal.close':
        return state.modal === null ? state : Object.assign({}, state, { modal: null });
      // 03 §7：仓库整包（GET /me/warehouse 的**响应信封**）＋ 当前桶
      case 'warehouse.set':
        return Object.assign({}, state, {
          warehouse: { envelope: action.envelope || null, loading: false },
        });
      case 'warehouse.loading.set': {
        var wh2 = Object.assign({}, state.warehouse, { loading: action.loading === true });
        return Object.assign({}, state, { warehouse: wh2 });
      }
      case 'warehouse.bucket.set':
        return Object.assign({}, state, {
          warehouseBucket: WAREHOUSE_BUCKETS.indexOf(action.bucket) === -1 ? state.warehouseBucket : action.bucket,
        });
      case 'box.times.set':
        return Object.assign({}, state, { box: Object.assign({}, state.box, { times: boxTimesOf(action.value) }) });
      case 'box.result.set':
        return Object.assign({}, state, { box: Object.assign({}, state.box, { result: action.result || null }) });
      case 'configs.set':
        // 提交③ 才消费 /me/configs 的正文；本批只保存响应信封（投影仍在 format.js）
        return Object.assign({}, state, {
          configs: { data: objectOr(action.data, null), draft: null, dirty: false },
        });
      case 'settings.set':
        return Object.assign({}, state, {
          settings: { nickname: strOf(action.nickname), result: action.result || null },
        });
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
    WAREHOUSE_BUCKETS: WAREHOUSE_BUCKETS,
    MODAL_KINDS: MODAL_KINDS,
    BOX_TIMES_FIELD: BOX_TIMES_FIELD,
    NICKNAME_FIELD: NICKNAME_FIELD,
    SCREEN_FIELDS: SCREEN_FIELDS,
    BOX_TIMES_MAX: BOX_TIMES_MAX,
    BOX_TIMES_DEFAULT: BOX_TIMES_DEFAULT,
    FORM_FIELDS: FORM_FIELDS,
    initialState: initialState,
    emptyForm: emptyForm,
    emptyAdmin: emptyAdmin,
    emptyWarehouse: emptyWarehouse,
    emptyConfigs: emptyConfigs,
    reduce: reduce,
    createStore: createStore,
  };
});
