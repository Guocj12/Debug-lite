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
  // F3：屏内弹窗种类（03 §3.7/§3.8；至多一个）。
  //   提交③ 新增两级选择弹窗：slot-pick（角色/技能模板）· plugin-pick（某插槽的插件）· ai-pick（AI 库）
  var MODAL_KINDS = Object.freeze(['item-detail', 'config', 'slot-pick', 'plugin-pick', 'ai-pick']);
  // F3：配置弹窗里的**位置键**（03 §3.7 逐位置：角色模板 / 角色插槽 / 技能1..3 / 技能插槽 / 战斗AI）。
  //   `skillN` 表示第 N 个技能（0 起）；插件位置在 `pos` 之外另带 `idx`（插槽序号）。
  var CONFIG_POSITIONS = Object.freeze(['role', 'skill0', 'skill1', 'skill2', 'ai']);
  // F3：技能位置数（D-160：完整性判据 = 角色 + **恰 3 技能** + AI）
  var SKILL_SLOTS = 3;

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

  // 出战配置（03 §7）：`data` = GET /me/configs 的**响应信封**（投影仍在 format.js）；
  //   `ai` = GET /me/ai 的响应信封（提交③ 的 ai-pick 候选来源）；
  //   `draft` = 弹窗内的**本地草稿**（`{slotId, loadout}`；点「保存」才 PUT）；`dirty` = 是否有未保存编辑。
  function emptyConfigs() {
    return { data: null, ai: null, draft: null, dirty: false };
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
      // 审查 F-1（FR-10）：**"用户没取消才打开"** 的弹窗替换 —— 供「编辑器/候选弹窗里的异步动作在
      //   await 回来后回弹」使用。条件必须在 reducer 里判：动作拿到的 `ctx.state` 是**动作开始时的快照**
      //   （public/app.js buildCtx），await 之后读它永远是旧值，判不出"用户是否已点背景关闭"。
      //   语义：当前没有弹窗（= 用户在等待期间点背景关闭，modal-close 已丢弃草稿）→ 保持关闭，不做任何事。
      case 'modal.setIfOpen': {
        if (state.modal === null) return state;
        var nextModal = action.modal && MODAL_KINDS.indexOf(action.modal.kind) !== -1 ? action.modal : null;
        return nextModal === null ? state : Object.assign({}, state, { modal: nextModal });
      }
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
      case 'configs.set': {
        // 配置列表整包（GET /me/configs 的**响应信封**）；换列表即丢弃旧草稿（草稿绑定单个槽）
        var data = objectOr(action.data, null);
        return Object.assign({}, state, {
          configs: {
            data: data,
            ai: data === null ? null : state.configs.ai,
            draft: null,
            dirty: false,
          },
        });
      }
      // 提交③：AI 库列表整包（GET /me/ai 的响应信封；ai-pick 的候选来源）
      case 'configs.ai.set':
        return Object.assign({}, state, {
          configs: Object.assign({}, state.configs, { ai: objectOr(action.ai, null) }),
        });
      // 提交③：草稿整体替换（打开配置弹窗时灌入服务端副本；关闭时置 null = 丢弃）
      case 'configs.draft.set':
        return Object.assign({}, state, {
          configs: Object.assign({}, state.configs, {
            draft: objectOr(action.draft, null),
            dirty: action.draft === undefined || action.draft === null ? false : action.dirty === true,
          }),
        });
      // 提交③：草稿局部替换（替换模板 / 装配插件都先作用在草稿上；**不动服务端**）
      case 'configs.draft.patch': {
        if (state.configs.draft === null) return state;
        return Object.assign({}, state, {
          configs: Object.assign({}, state.configs, {
            draft: Object.assign({}, state.configs.draft, objectOr(action.patch, {})),
            dirty: true,
          }),
        });
      }
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
    CONFIG_POSITIONS: CONFIG_POSITIONS,
    SKILL_SLOTS: SKILL_SLOTS,
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
