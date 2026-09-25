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
  // F3：开箱次数上限（与 server/box.js 的 BOX_TIMES_MAX 同口径；03 §3.4 / §8 B-3）
  var BOX_TIMES_MAX = 100;

  // F2：账号列表每页条数三档、bots 单次注入上限（与 server/admin.js 的 MAX_BOTS_PER_CALL 同口径）
  var ADMIN_LIMITS = [20, 50, 100];
  var ADMIN_DEFAULT_LIMIT = 20;
  var BOTS_COUNT_MAX = 200;
  // 目标解析（publicId → playerId）的翻页上限：后端 ban 只认 playerId，故从账号列表逐页找
  var TARGET_SCAN_PAGES = 25;
  var TARGET_SCAN_LIMIT = 200;
  // 审查 F-1/F-3：装配/拆卸改的是**仓库那件物品**（两步顺序第①步），配置要等「保存」才变。
  //   提示一律写明这一点 —— 既解释"为什么仓库变了、配置还没变"，也说明"取消弹窗不会撤销这一步"。
  var PLUGIN_APPLIED_TEXT = '已装配（已写入仓库那件物品；点「保存」后才进这份配置）';
  var PLUGIN_CLEARED_TEXT = '已拆卸（已更新仓库那件物品；点「保存」后才从这份配置移除）';

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

  /* ---------- F3 客户端预校验（03 §8 B-3 / B-11） ---------- */

  // 开箱次数：1~100 的**整数**（"1.5"/"abc"/""/"0"/"101" 一律拦下，不发请求）
  function validateTimes(value) {
    var raw = typeof value === 'string' ? value.trim() : (typeof value === 'number' ? String(value) : '');
    if (!/^[0-9]+$/.test(raw)) return null;
    var n = Number(raw);
    return n >= 1 && n <= BOX_TIMES_MAX ? n : null;
  }

  // 新昵称：1~16 字符（服务端也会夹到 ≤16，前端提示为准；B-11）
  function validateNickname(value) {
    var raw = typeof value === 'string' ? value.trim() : '';
    if (raw === '' || raw.length > NICK_MAX) return null;
    return raw;
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
    clearUserState(ctx);
    clearAdminState(ctx);
    ctx.dispatch({ type: 'view.go', view: 'login' });
    if (result && result.envelope) noticeNotice(ctx, 'error', ctx.format.noticeText(result.envelope));
    else noticeNotice(ctx, 'error', '会话已失效，请重新登录');
  }

  // F3：随会话一起清掉的用户态数据（仓库/开箱结果/设置输入）—— 不残留上一个账号的内容
  function clearUserState(ctx) {
    ctx.dispatch({ type: 'warehouse.set', envelope: null });
    ctx.dispatch({ type: 'box.result.set', result: null });
    ctx.dispatch({ type: 'configs.set', data: null });
    ctx.dispatch({ type: 'settings.set', nickname: '', result: null });
    ctx.dispatch({ type: 'viewer.clear' });   // F6：战斗态（对局/帧/游标）随会话一起清
    ctx.dispatch({ type: 'modal.close' });
  }

  function busy(ctx, value) { ctx.dispatch({ type: 'busy.set', busy: value }); }

  /* ---------- F3 会话后的公共取数（hub 摘要与仓库都读服务端） ---------- */

  // 取 /me 并落 profile + session（**不写提示**：调用方决定成功文案）。失败按 F1 §6 统一处理。
  //   token 必须由调用方传入：动作内的 ctx.state 是本次执行开始时的快照（dispatch 不会回写 ctx）
  function loadProfile(ctx, token) {
    return ctx.api.me(token).then(function (result) {
      if (result.transport === 'error') return failFrom(ctx, result);
      if (!ctx.format.isOk(result.envelope)) {
        if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
        return failFrom(ctx, result);
      }
      var session = ctx.format.sessionOf(result.envelope);
      ctx.dispatch({ type: 'profile.set', envelope: result.envelope });
      // isAdmin 必须一并刷新：否则管理员点「刷新」后管理入口会消失（§5：data.flags.isAdmin）
      ctx.dispatch({
        type: 'session.set', token: token, publicId: session.publicId, nickname: session.nickname,
        expiresAt: ctx.state.session.expiresAt, isAdmin: session.isAdmin,
      });
      return result.envelope;
    });
  }

  // 刷新档案/摘要（hub 与 profile 同一实现；文案见 01 §4「档案已刷新」）
  function refreshProfile(ctx) {
    if (ctx.state.busy) return Promise.resolve();
    if (!ctx.state.session.token) return sessionLost(ctx, null);
    busy(ctx, true);
    ctx.dispatch({ type: 'notice.set', notice: null });
    return loadProfile(ctx, ctx.state.session.token).then(function (env) {
      busy(ctx, false);
      if (env === undefined) return undefined;   // 失败文案已写入
      noticeNotice(ctx, 'info', ctx.format.REFRESH_OK_TEXT);
      return undefined;
    });
  }

  // 取仓库真源（03 §3.3）。成功落 warehouse.set（**仓库屏与开箱屏共用这一份状态**，不产生第二个数据源）。
  //   opts.quiet = true 时不写成功提示（也不清旧提示）—— 用于"进入开箱屏 / 开箱成功后的静默刷新"；
  //   **失败一律可见**（网络文案 / 401 统一登出），且不影响调用方已渲染的内容。
  function loadWarehouse(ctx, opts) {
    var quiet = opts !== undefined && opts !== null && opts.quiet === true;
    if (ctx.state.busy) return Promise.resolve();
    if (!ctx.state.session.token) return sessionLost(ctx, null);
    busy(ctx, true);
    if (!quiet) ctx.dispatch({ type: 'notice.set', notice: null });
    return ctx.api.warehouse(ctx.state.session.token).then(function (result) {
      busy(ctx, false);
      if (result.transport === 'error') return failFrom(ctx, result);
      if (!ctx.format.isOk(result.envelope)) {
        if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
        return failFrom(ctx, result);
      }
      ctx.dispatch({ type: 'warehouse.set', envelope: result.envelope });
      if (!quiet) noticeNotice(ctx, 'info', ctx.format.WAREHOUSE_OK_TEXT);
      return undefined;
    });
  }

  /* ---------- F3 提交③：出战配置编辑器的公共工具（03 §3.7） ---------- */

  // 槽位 / 位置 / 插槽序号 / 物品 uid 都来自被点按钮的 data-*（在 render 层由 vm 搬运）
  function slotIdOf(payload, fallback) {
    var v = payload !== null && payload && typeof payload.slot === 'string' && payload.slot !== '' ? payload.slot : null;
    return v === null ? fallback : v;
  }

  function posOf(payload) {
    return payload !== null && payload && typeof payload.pos === 'string' ? payload.pos : '';
  }

  function uidOf(payload) {
    return payload !== null && payload && typeof payload.uid === 'string' && payload.uid !== '' ? payload.uid : null;
  }

  // 非负整数（`data-idx` 是字符串，必须显式解析；"1.5"/"abc"/缺省 一律 null）
  function intOf(value) {
    var raw = typeof value === 'string' ? value.trim() : (typeof value === 'number' ? String(value) : '');
    if (!/^[0-9]+$/.test(raw)) return null;
    return Number(raw);
  }

  // 当前弹窗的草稿（`{slotId, loadout}`）—— 所有编辑都作用在它上面，`保存` 才 PUT
  function draftOf(ctx) {
    var draft = ctx.state.configs ? ctx.state.configs.draft : null;
    if (!draft || typeof draft !== 'object') return null;
    if (!draft.loadout || typeof draft.loadout !== 'object') return null;
    return draft;
  }

  // 取配置列表（GET /me/configs）。activate 成功后必须刷新：`activeSlotId` 决定"出战中"与 B-5 门控。
  //   刷新时按**当前草稿的槽**重建草稿（脏标记归零）；失败可见（网络 / 401 统一登出）。
  function loadConfigs(ctx) {
    var token = ctx.state.session.token;
    if (!token) return sessionLost(ctx, null);
    return ctx.api.configs(token).then(function (result) {
      if (result.transport === 'error') return failFrom(ctx, result);
      if (!ctx.format.isOk(result.envelope)) {
        if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
        return failFrom(ctx, result);
      }
      var draft = draftOf(ctx);
      ctx.dispatch({ type: 'configs.set', data: result.envelope });
      if (draft !== null) {
        var fresh = ctx.format.draftForSlot(result.envelope, draft.slotId);
        if (fresh !== null) ctx.dispatch({ type: 'configs.draft.set', draft: fresh, dirty: false });
      }
      return undefined;
    });
  }

  // 取 AI 库（GET /me/ai）。ai-pick 的候选来源；config-open 也静默取一次（否则 AI 位置只能显示 aiId 而不是名字）。
  function loadAiList(ctx) {
    var token = ctx.state.session.token;
    if (!token) return sessionLost(ctx, null);
    return ctx.api.aiList(token).then(function (result) {
      if (result.transport === 'error') return failFrom(ctx, result);
      if (!ctx.format.isOk(result.envelope)) {
        if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
        return failFrom(ctx, result);
      }
      ctx.dispatch({ type: 'configs.ai.set', ai: result.envelope });
      return undefined;
    });
  }

  /* ⚠️ 两步顺序（03 §3.7；D-159/D-160）—— 本批最容易踩的坑，唯一实现在这里：
   *   ① 调装配/拆卸端点（改的是**仓库里那件物品**的 slots[]）
   *   ② 用响应回带的 `warehouse` 取回**更新后的那件物品** → 替换草稿里的对应物品
   *   ③ 用户点「保存」→ PUT /me/configs/:slotId
   *   只做①不做②③ = 界面看着换了、保存后依旧没换。 */
  function warehouseChange(ctx, payload, kind, invoke) {
    if (ctx.state.busy) return Promise.resolve();
    var token = ctx.state.session.token;
    if (!token) return sessionLost(ctx, null);
    var draft = draftOf(ctx);
    if (draft === null) {
      noticeNotice(ctx, 'error', '尚未打开出战配置编辑器');
      return Promise.resolve();
    }
    var pos = posOf(payload);
    var idx = intOf(payload === null || payload === undefined ? null : payload.idx);
    var pluginUid = uidOf(payload);
    // 装配目标 = 草稿里该位置物品的 uid 与插槽序号（**必须来自草稿**：草稿是即将保存的那份）
    var target = ctx.format.assemblyTargetOf(draft.loadout, pos, idx);
    if (target === null) {
      noticeNotice(ctx, 'error', '插槽寻址无效（该位置未安装物品，或插槽不存在）');
      return Promise.resolve();
    }
    if (kind === 'assemble' && pluginUid === null) {
      noticeNotice(ctx, 'error', '缺少插件 uid（plugin-set 需要 data-uid）');
      return Promise.resolve();
    }
    busy(ctx, true);
    ctx.dispatch({ type: 'notice.set', notice: null });
    return invoke(ctx, token, target, pluginUid).then(function (result) {
      busy(ctx, false);
      if (result.transport === 'error') return failFrom(ctx, result);
      if (!ctx.format.isOk(result.envelope)) {
        if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
        noticeNotice(ctx, 'error', ctx.format.pluginFailText(result.envelope));
        return undefined;
      }
      return applyPluginChange(ctx, result, target, draft, pos,
        kind === 'assemble' ? PLUGIN_APPLIED_TEXT : PLUGIN_CLEARED_TEXT);
    });
  }

  // 两步顺序的第②步（+ 把响应回带的仓库并回 state.warehouse，usage 随之刷新）
  function applyPluginChange(ctx, result, target, draft, pos, okText) {
    var updated = ctx.format.updatedItemOf(result.envelope, target.targetUid);
    if (updated === null) {
      noticeNotice(ctx, 'error', '服务端已处理，但未从响应取回更新后的物品：请重新打开出战配置再保存');
      return undefined;
    }
    ctx.dispatch({ type: 'warehouse.set', envelope: ctx.format.warehouseChangeEnvelope(result.envelope) });
    var next = ctx.format.setItemAt(draft.loadout, pos, updated);
    if (next === null) {
      noticeNotice(ctx, 'error', '插槽寻址无效（无法写回草稿）');
      return undefined;
    }
    ctx.dispatch({ type: 'configs.draft.patch', patch: { loadout: next } });
    // 审查 F-1（FR-10）：await 期间用户可能已点背景关闭（`modal-close` 丢弃草稿）——此时**不得**把
    //   弹窗重新弹开，否则编辑器按服务端副本渲染"未改动"，与"已装配"提示、仓库实际状态三方矛盾。
    //   条件放在 reducer（`modal.setIfOpen`）：动作手里的 `ctx.state` 是开始时的快照（public/app.js
    //   buildCtx），await 之后读它永远判不出"用户是否已取消"。
    ctx.dispatch({ type: 'modal.setIfOpen', modal: { kind: 'config', slotId: draft.slotId } });
    noticeNotice(ctx, 'info', okText);
    return undefined;
  }

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
          // FR-11：登录/注册成功后的落点 = 主界面 hub；hub 摘要只读 GET /me，故落地即取一次
          //   （否则用户看到的是「尚未读取到档案数据」，与走查剧本 §11 步 2 的期望不符）
          ctx.dispatch({ type: 'view.go', view: 'hub' });
          noticeNotice(ctx, 'info', ctx.format.loginOkText(result.envelope));
          return loadProfile(ctx, session.token).then(function () { return undefined; });
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
          // FR-11：注册成功后的落点同样是主界面 hub（并立即取一次 /me 填摘要）
          ctx.dispatch({ type: 'view.go', view: 'hub' });
          noticeNotice(ctx, 'info', ctx.format.registerOkText(result.envelope));
          return loadProfile(ctx, session.token).then(function () { return undefined; });
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
      run: function (ctx) { return refreshProfile(ctx); },
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
          clearUserState(ctx);
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
      label: '返回用户详情',
      run: function (ctx) {
        ctx.dispatch({ type: 'form.clear', fields: ['oldPassword', 'newPassword', 'newConfirm'] });
        // F3 §4：`goto-home` 在 F3 中指"切回 profile（原 home）"
        ctx.dispatch({ type: 'view.go', view: 'profile' });
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

    /* D-170：改账号（段位/积分/入池）——目标用 publicId（先经账号列表解析 playerId），
     * 三项都留空 → 本地拦下（服务端也会 400）。成功后刷新账号列表，使行内 tier/points 立刻可见。 */
    'admin-account-patch': {
      label: '改账号（段位/积分）',
      run: function (ctx, payload) {
        if (ctx.state.busy) return Promise.resolve();
        var patch = (ctx.state.admin && ctx.state.admin.patch) || {};
        var publicId = String(patch.publicId === undefined || patch.publicId === null ? '' : patch.publicId).trim();
        var tierRaw = String(patch.tier === undefined || patch.tier === null ? '' : patch.tier).trim();
        var pointsRaw = String(patch.points === undefined || patch.points === null ? '' : patch.points).trim();
        if (publicId === '') {
          adminResult(ctx, 'error', '请填写改账号目标 publicId');
          return Promise.resolve();
        }
        if (tierRaw === '' && pointsRaw === '') {
          adminResult(ctx, 'error', '至少要填「目标段位」或「目标积分」之一');
          return Promise.resolve();
        }
        if (pointsRaw !== '' && !/^\d+$/.test(pointsRaw)) {
          adminResult(ctx, 'error', '目标积分需为 0~3000 的整数');
          return Promise.resolve();
        }
        busy(ctx, true);
        return resolvePlayerIdByPublicId(ctx, publicId).then(function (playerId) {
          if (playerId === undefined) { busy(ctx, false); return undefined; }
          if (playerId === null) {
            busy(ctx, false);
            adminResult(ctx, 'error', '账号列表中没有 publicId=' + publicId + ' 的账号（先点「刷新账号列表」）');
            return undefined;
          }
          var body = { playerId: playerId };
          if (tierRaw !== '') body.tier = tierRaw;
          if (pointsRaw !== '') body.points = Number(pointsRaw);
          return adminCall(ctx, 'account-patch', body).then(function (result) {
            busy(ctx, false);
            if (result.transport === 'error') return adminFail(ctx, result);
            if (!ctx.format.isOk(result.envelope)) return adminFail(ctx, result);
            // 文案走 format.patchText（§5 已登记的 5 条路径；不在 actions.js 里拼字段名）
            adminResult(ctx, 'info', ctx.format.patchText(result.envelope, publicId));
            var limit = limitOf(ctx);
            return loadAccounts(ctx, ctx.state.admin.offset, limit);
          });
        });
      },
    },

    /* ----- F3：主界面线（03-hub-warehouse-loadout.md §3/§4；提交②） -----
     *
     * 提交② 只注册真正要用的动作（「按钮永不无声」不允许先注册空壳）；
     * 提交③ 在此之上新增 9 个配置编辑器动作（config-save / config-activate / slot-pick / slot-set /
     *   ai-pick / ai-set / plugin-pick / plugin-set / plugin-clear）→ 注册表 51 = F1 9 + F2 16 + ② 17 + ③ 9。
     */

    'goto-hub': {
      label: '返回主界面',
      run: function (ctx) { return goView(ctx, 'hub'); },
    },

    'goto-profile': {
      label: '用户',
      run: function (ctx) { return goView(ctx, 'profile'); },
    },

    // 切到仓库屏**并**取真源（03 §4：成功可见文本「仓库」+ 列表更新）
    'goto-warehouse': {
      label: '仓库',
      run: function (ctx) {
        ctx.dispatch({ type: 'view.go', view: 'warehouse' });
        return loadWarehouse(ctx);
      },
    },

    // 切到开箱屏**并**取一次仓库真源（03 §3.4：目标分类已达上限 → 按钮**禁用**且**不发请求**）。
    //   要"本地禁用且不发请求"就必须在渲染该屏时已握有 caps/桶长度 → 进入时取一次（不轮询）；
    //   与仓库屏共用同一份 state.warehouse，避免两处数据不一致。
    //   读取失败（网络/401）**不影响进入屏**：按钮保持可用，由服务端 409 兜底（§6 warehouse_full）。
    'goto-box': {
      label: '开箱',
      run: function (ctx) {
        ctx.dispatch({ type: 'view.go', view: 'box' });
        return loadWarehouse(ctx, { quiet: true });
      },
    },

    'goto-quick': {
      label: '快速对战',
      run: function (ctx) { return goView(ctx, 'quick'); },
    },

    'goto-tournament': {
      label: '锦标赛',
      run: function (ctx) { return goView(ctx, 'tournament'); },
    },

    'goto-leaderboard': {
      label: '排行榜',
      run: function (ctx) { return goView(ctx, 'leaderboard'); },
    },

    'goto-ai-editor': {
      label: 'AI编辑',
      run: function (ctx) { return goView(ctx, 'ai-editor'); },
    },

    'goto-settings': {
      label: '设置',
      run: function (ctx) {
        // 进入设置屏时清空上次的昵称输入（避免残留旧值被误提交）
        ctx.dispatch({ type: 'settings.set', nickname: '', result: null });
        return goView(ctx, 'settings');
      },
    },

    'refresh-hub': {
      label: '刷新',
      run: function (ctx) { return refreshProfile(ctx); },
    },

    'refresh-warehouse': {
      label: '刷新',
      run: function (ctx) { return loadWarehouse(ctx); },
    },

    // 分桶切换是**纯本地**动作（不再请求；数据一次取全）
    'warehouse-bucket': {
      label: '分桶',
      run: function (ctx, payload) {
        var bucket = payload && typeof payload.bucket === 'string' ? payload.bucket : '';
        if (bucket === '') {
          noticeNotice(ctx, 'error', '缺少分桶名（warehouse-bucket 需要 data-bucket）');
          return Promise.resolve();
        }
        ctx.dispatch({ type: 'warehouse.bucket.set', bucket: bucket });
        return Promise.resolve();
      },
    },

    // 打开物品详情弹窗（03 §3.3/§3.8；纯本地，不发请求）
    'item-open': {
      label: '物品详情',
      run: function (ctx, payload) {
        var uid = payload && typeof payload.uid === 'string' && payload.uid !== '' ? payload.uid : '';
        if (uid === '') {
          noticeNotice(ctx, 'error', '缺少物品 uid（item-open 需要 data-uid）');
          return Promise.resolve();
        }
        ctx.dispatch({ type: 'modal.set', modal: { kind: 'item-detail', uid: uid } });
        return Promise.resolve();
      },
    },

    // 打开出战配置编辑器（03 §3.7）：取配置列表 → 灌本地草稿 → 开 `config` 弹窗。
    //   随后**静默**取仓库（角色/技能模板候选 + 插槽里的插件名）与 AI 库（AI 位置要显示**名字**，
    //   而草稿里只有 `aiId`）——两者失败都可见但不挡开弹窗（候选区显示"尚未读取"占位）。
    'config-open': {
      label: '出战配置',
      run: function (ctx, payload) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        if (!token) return sessionLost(ctx, null);
        var slotId = slotIdOf(payload, 'slot1');
        // 审查 F-1（FR-10）：本动作从主界面发起，正常路径下没有弹窗（`hadModal=false` → 无条件打开）；
        //   若调用方在弹窗内发起，则等待期间用户可能已点背景关闭 → 走后者的条件 reducer。
        var hadModal = ctx.state.modal !== null;
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.configs(token).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            return failFrom(ctx, result);
          }
          var draft = ctx.format.draftForSlot(result.envelope, slotId);
          if (draft === null) {
            noticeNotice(ctx, 'error', '配置槽 ' + slotId + ' 不存在');
            return undefined;
          }
          ctx.dispatch({ type: 'configs.set', data: result.envelope });
          ctx.dispatch({ type: 'configs.draft.set', draft: draft, dirty: false });
          // 审查 F-1（FR-10）：见上文 `hadModal` —— 只有"本来就有弹窗"时才需要防被 in-flight 响应复活
          if (hadModal) {
            ctx.dispatch({ type: 'modal.setIfOpen', modal: { kind: 'config', slotId: slotId } });
          } else {
            ctx.dispatch({ type: 'modal.set', modal: { kind: 'config', slotId: slotId } });
          }
          return loadWarehouse(ctx, { quiet: true }).then(function () { return loadAiList(ctx); });
        });
      },
    },

    /* ----- F3 提交③：出战配置编辑器（two-step / 草稿 / B-5 / B-8） ----- */

    // 打开模板候选弹窗（纯本地：候选来自已取到的仓库信封）
    'slot-pick': {
      label: '选择位置',
      run: function (ctx, payload) {
        var slotId = slotIdOf(payload, null);
        var pos = posOf(payload);
        if (slotId === null || !ctx.format.isConfigPos(pos) || pos === 'ai') {
          noticeNotice(ctx, 'error', '缺少位置（slot-pick 需要 data-slot 与 data-pos）');
          return Promise.resolve();
        }
        ctx.dispatch({ type: 'modal.set', modal: { kind: 'slot-pick', slotId: slotId, pos: pos } });
        return Promise.resolve();
      },
    },

    // 选中一个模板/`空`：**只改本地草稿**（B-7：换模板 = 换仓库里另一件物品，新物品的插槽状态天然是它自己的，
    //   不需要任何"先拆插件"的清理代码）
    'slot-set': {
      label: '替换',
      run: function (ctx, payload) {
        var draft = draftOf(ctx);
        if (draft === null) {
          noticeNotice(ctx, 'error', '尚未打开出战配置编辑器');
          return Promise.resolve();
        }
        var choice = { pos: posOf(payload), uid: uidOf(payload), empty: payload !== null && payload.empty === '1' };
        var next = ctx.format.applySlotChoice(ctx.state, draft.loadout, choice);
        if (next === null) {
          noticeNotice(ctx, 'error', choice.empty
            ? '该位置无法置空（位置参数不合法）'
            : '候选物品不在仓库里（可能已被清理：点「关闭」后重新打配置）');
          return Promise.resolve();
        }
        ctx.dispatch({ type: 'configs.draft.patch', patch: { loadout: next } });
        ctx.dispatch({ type: 'modal.set', modal: { kind: 'config', slotId: draft.slotId } });
        return Promise.resolve();
      },
    },

    // 打开 AI 候选弹窗（候选 = GET /me/ai 的条目）
    'ai-pick': {
      label: '选择战斗AI',
      run: function (ctx, payload) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        if (!token) return sessionLost(ctx, null);
        var slotId = slotIdOf(payload, null);
        if (slotId === null) {
          noticeNotice(ctx, 'error', '缺少槽位（ai-pick 需要 data-slot）');
          return Promise.resolve();
        }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return loadAiList(ctx).then(function () {
          busy(ctx, false);
          // 审查 F-1（FR-10）：await 期间用户可能已点背景关闭（或关掉编辑器）——条件 reducer 判"当前是否还有弹窗"
          ctx.dispatch({ type: 'modal.setIfOpen', modal: { kind: 'ai-pick', slotId: slotId } });
          return undefined;
        });
      },
    },

    // 选中一条 AI（或 `空`）：**只改本地草稿**（`ai` = program 正文、`aiId` = 库内引用）
    'ai-set': {
      label: '替换AI',
      run: function (ctx, payload) {
        var draft = draftOf(ctx);
        if (draft === null) {
          noticeNotice(ctx, 'error', '尚未打开出战配置编辑器');
          return Promise.resolve();
        }
        var option = null;
        if (!(payload !== null && payload.empty === '1')) {
          var aiId = payload !== null && typeof payload.aiId === 'string' && payload.aiId !== '' ? payload.aiId : null;
          option = ctx.format.aiOptionOf(ctx.state.configs ? ctx.state.configs.ai : null, aiId);
          if (option === null) {
            noticeNotice(ctx, 'error', '该 AI 不在 AI 库里（点「关闭」后重新打开候选）');
            return Promise.resolve();
          }
        }
        ctx.dispatch({ type: 'configs.draft.patch', patch: { loadout: ctx.format.applyAiChoice(draft.loadout, option) } });
        ctx.dispatch({ type: 'modal.set', modal: { kind: 'config', slotId: draft.slotId } });
        return Promise.resolve();
      },
    },

    // 打开某插槽的插件候选（纯本地；类型不匹配的由 format 标灰 + 写原因 —— B-8）
    'plugin-pick': {
      label: '选择插件',
      run: function (ctx, payload) {
        var slotId = slotIdOf(payload, null);
        var pos = posOf(payload);
        var idx = intOf(payload === null || payload === undefined ? null : payload.idx);
        if (slotId === null || !ctx.format.isConfigPos(pos) || pos === 'ai' || idx === null) {
          noticeNotice(ctx, 'error', '缺少插槽寻址（plugin-pick 需要 data-slot / data-pos / data-idx）');
          return Promise.resolve();
        }
        ctx.dispatch({ type: 'modal.set', modal: { kind: 'plugin-pick', slotId: slotId, pos: pos, idx: idx } });
        return Promise.resolve();
      },
    },

    /* ⚠️ 两步顺序（03 §3.7；D-159/D-160）：装配改的是**仓库里那件物品**，而配置里存的是物品正文的副本。
     *   ① POST /me/warehouse/assemble（或 disassemble）
     *   ② 用响应回带的 `warehouse` 取回**更新后的那件物品** → 替换草稿里的对应物品
     *   ③ 用户点「保存」才 PUT /me/configs/:slotId
     *   只做①不做②③ = 界面看着换了、保存后依旧没换（本批最容易踩的坑）。 */
    'plugin-set': {
      label: '装配',
      run: function (ctx, payload) {
        return warehouseChange(ctx, payload, 'assemble', function (ctx1, token, target, pluginUid) {
          return ctx1.api.assemble(token, { targetUid: target.targetUid, pluginUid: pluginUid, slotIndex: target.slotIndex });
        });
      },
    },

    'plugin-clear': {
      label: '清空此槽',
      run: function (ctx, payload) {
        return warehouseChange(ctx, payload, 'disassemble', function (ctx1, token, target) {
          return ctx1.api.disassemble(token, { targetUid: target.targetUid, slotIndex: target.slotIndex });
        });
      },
    },

    // 保存配置（03 §4）：PUT /me/configs/:slotId（体 = {loadout: 草稿}）。
    //   非出战槽允许不完整（200）；出战槽不完整 → 409 loadout_invalid → 翻成玩家可读文案。
    'config-save': {
      label: '保存',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        if (!token) return sessionLost(ctx, null);
        var draft = draftOf(ctx);
        if (draft === null) {
          noticeNotice(ctx, 'error', '尚未打开出战配置编辑器');
          return Promise.resolve();
        }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.saveConfig(token, draft.slotId, { loadout: draft.loadout }).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            noticeNotice(ctx, 'error', ctx.format.configSaveFailText(result.envelope));
            return undefined;
          }
          // 成功：草稿即已落盘（dirty 归零），不重新拉列表（草稿就是服务端副本）
          ctx.dispatch({ type: 'configs.draft.set', draft: draft, dirty: false });
          var missing = ctx.format.missingOf(draft.loadout);
          noticeNotice(ctx, 'info', missing.length === 0
            ? '已保存'
            : '已保存（配置不完整：' + ctx.format.missingSummaryText(missing) + '，补齐后才能设为出战）');
          // 保存会改变引用（usage）→ 静默刷新仓库，否则仓库屏的 [装配于配置N] 会过期
          return loadWarehouse(ctx, { quiet: true });
        });
      },
    },

    // 设为出战（03 §4 / D-160）：**此时**才由服务端校验完整性 → 409 cannot_activate_incomplete 逐位置
    'config-activate': {
      label: '设为出战',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        if (!token) return sessionLost(ctx, null);
        var draft = draftOf(ctx);
        if (draft === null) {
          noticeNotice(ctx, 'error', '尚未打开出战配置编辑器');
          return Promise.resolve();
        }
        // 显式前置：activate 作用在**服务端**那份配置上；有未保存修改时先让用户保存（避免"看着是新的、出战的是旧的"）
        if (ctx.state.configs && ctx.state.configs.dirty === true) {
          noticeNotice(ctx, 'error', '有未保存的修改：请先点「保存」再设为出战');
          return Promise.resolve();
        }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.activateConfig(token, draft.slotId).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            noticeNotice(ctx, 'error', ctx.format.configActivateFailText(result.envelope));
            return undefined;
          }
          noticeNotice(ctx, 'info', '已设为出战配置');
          // 出战态切换 → 配置列表（activeSlotId / B-5 门控）+ 仓库 usage + /me 摘要（出战槽标记）三处同步
          return loadConfigs(ctx)
            .then(function () { return loadWarehouse(ctx, { quiet: true }); })
            .then(function () { return loadProfile(ctx, token); });
        });
      },
    },

    // 开箱（03 §3.4）：客户端先拦次数与"仓库已满"（B-2/B-3），**不传也不显示 seed**（D-162）
    'box-open': {
      label: '开箱',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        if (!ctx.state.session.token) return sessionLost(ctx, null);
        var times = validateTimes(ctx.state.box ? ctx.state.box.times : '');
        if (times === null) {
          noticeNotice(ctx, 'error', ctx.format.BOX_TIMES_RANGE_TEXT);
          return Promise.resolve();
        }
        var full = ctx.format.boxFullNotice(ctx.state);
        if (full !== null) {
          noticeNotice(ctx, 'error', full);
          return Promise.resolve();
        }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.box(ctx.state.session.token, { times: times }).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            return failFrom(ctx, result);
          }
          ctx.dispatch({ type: 'box.result.set', result: { lines: ctx.format.boxResultLines(result.envelope) } });
          noticeNotice(ctx, 'info', ctx.format.BOX_OK_TEXT);
          // 成功后**静默刷新一次仓库**：连续开箱时"满仓 → 按钮立刻禁用"才成立（03 §3.4/§8 B-2）
          return loadWarehouse(ctx, { quiet: true }).then(function () { return undefined; });
        });
      },
    },

    /* ----- F6：快速对战 + 战斗查看器 + AI 逻辑查看器（04 §4；9 个动作） -----
     * 动作层只做「预校验 → 发请求（唯一出口 api）→ dispatch → 经 format 取文案」；
     * 所有响应字段读取都走 ctx.format.*（UI-9：本文件不得出现契约路径字面量）。
     */
    'quick-run': {
      label: '开始快速对战',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        if (!token) return sessionLost(ctx, null);
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        // 不传 seed：随机性归服务端（与开箱同口径；服务端回带本次对局 seed 供复现/排查）
        return ctx.api.quickRun(token, {}).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            noticeNotice(ctx, 'error', ctx.format.quickNoticeText(result.envelope));
            return undefined;
          }
          ctx.dispatch({ type: 'quick.set', envelope: result.envelope });
          ctx.dispatch({
            type: 'viewer.set',
            frames: ctx.format.quickFrames(result.envelope),
            source: 'quick',
            battleId: ctx.format.quickBattleId(result.envelope),
          });
          noticeNotice(ctx, 'info', ctx.format.quickOkText(result.envelope));
          return undefined;
        });
      },
    },

    'viewer-first': { label: '第一帧', run: function (ctx) { return gotoFrame(ctx, 0); } },
    'viewer-prev': { label: '上一帧', run: function (ctx) { return stepFrame(ctx, -1); } },
    'viewer-next': { label: '下一帧', run: function (ctx) { return stepFrame(ctx, 1); } },
    'viewer-last': { label: '最后一帧', run: function (ctx) { return gotoLastFrame(ctx); } },
    'viewer-trace-p1': { label: '看我方(进攻方)轨迹', run: function (ctx) { return setTraceOwner(ctx, 'p1'); } },
    'viewer-trace-p2': { label: '看对手(防守方)轨迹', run: function (ctx) { return setTraceOwner(ctx, 'p2'); } },
    'viewer-ai-logic': { label: 'AI 逻辑查看器', run: function (ctx) { return openAiLogic(ctx); } },
    'viewer-load-replay': { label: '读取本场回放', run: function (ctx) { return loadReplay(ctx); } },

    /* ----- F7：锦标赛 + 排行榜（05 §4；10 个动作） -----
     * 帧查看相关动作（viewer-*）复用 F6 的 9 个，不重复注册。
     */
    'tournament-run': {
      label: '开始锦标赛',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        if (!token) return sessionLost(ctx, null);
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        // 不传 seed（服务端生成并回带）；批次幂等由 batchId 保证
        return ctx.api.rankedRun(token, {}).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            noticeNotice(ctx, 'error', ctx.format.rankedNoticeText(result.envelope));
            return undefined;
          }
          ctx.dispatch({ type: 'tournament.set', envelope: result.envelope });
          // 新批次 → 清掉上一批的查看器（避免"看着旧批的帧、列表是新批的"）
          ctx.dispatch({ type: 'viewer.set', frames: null, source: 'tournament', battleId: null });
          noticeNotice(ctx, 'info', ctx.format.rankedOkText(result.envelope));
          return undefined;
        });
      },
    },

    'tournament-page-prev': { label: '上一页', run: function (ctx) { return turnPage(ctx, -1); } },
    'tournament-page-next': { label: '下一页', run: function (ctx) { return turnPage(ctx, 1); } },

    // 看某一场的战斗：有内联帧直接用；**没有内联帧**（重放批次）则按 battleId 读归档回放（05 §2 反驳 3）
    'tournament-open-battle': {
      label: '看这一场',
      run: function (ctx, payload) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        if (!token) return sessionLost(ctx, null);
        var index = intOf(payload === null || payload === undefined ? null : payload.idx);
        if (index === null) return Promise.resolve();
        var env = ctx.state.tournament ? ctx.state.tournament.envelope : null;
        if (env === null || !ctx.format.isOk(env)) return Promise.resolve();
        var frames = ctx.format.rankedFramesOf(env, index);
        var battleId = ctx.format.rankedBattleIdOf(env, index);
        if (Array.isArray(frames) && frames.length > 0) {
          ctx.dispatch({ type: 'viewer.set', frames: frames, source: 'tournament', battleId: battleId });
          noticeNotice(ctx, 'info', ctx.format.battleLoadedText(index, frames));
          return Promise.resolve();
        }
        if (battleId === null) {
          noticeNotice(ctx, 'error', ctx.format.NO_BATTLE_ID_TEXT);
          return Promise.resolve();
        }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.replay(token, battleId).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            noticeNotice(ctx, 'error', ctx.format.rankedNoticeText(result.envelope));
            return undefined;
          }
          ctx.dispatch({ type: 'viewer.replay.set', envelope: result.envelope });
          ctx.dispatch({
            type: 'viewer.set',
            frames: ctx.format.replayFrames(result.envelope),
            source: 'tournament',
            battleId: battleId,
          });
          noticeNotice(ctx, 'info', ctx.format.replayOkText(result.envelope));
          return undefined;
        });
      },
    },

    'board-points': { label: '积分榜', run: function (ctx) { return switchBoard(ctx, 'points', null); } },
    'board-tier': { label: '段位榜', run: function (ctx) { return switchBoard(ctx, 'arrival', null); } },
    // 范围按钮（data-tier = 'global' | common | rare | epic | legendary | mythic）
    'board-scope': {
      label: '范围',
      run: function (ctx, payload) {
        var tier = payload !== null && payload !== undefined && typeof payload.tier === 'string' ? payload.tier : '';
        return switchBoard(ctx, null, tier === '' || tier === 'global' ? 'global' : 'tier:' + tier);
      },
    },
    'board-prev': { label: '上一页', run: function (ctx) { return pageBoard(ctx, -1); } },
    'board-next': { label: '下一页', run: function (ctx) { return pageBoard(ctx, 1); } },
    'board-refresh': { label: '刷新', run: function (ctx) { return loadBoard(ctx, false); } },

    // 关闭弹窗（背景 / 「关闭」/「取消」共用）：丢弃未提交输入（03 §3.8 / B-9 / FR-10）    //   提交③ 起弹窗内有**本地草稿**（state.configs.draft）→ 关闭必须一并丢弃，否则再打开会看到"上次没保存的改动"
    'modal-close': {
      label: '关闭',
      run: function (ctx) {
        ctx.dispatch({ type: 'modal.close' });
        ctx.dispatch({ type: 'configs.draft.set', draft: null });
        return Promise.resolve();
      },
    },

    // 设置屏·改昵称（03 §3.5；预校验 ≤16 字符 → PUT /me/nickname）
    'settings-nickname-save': {
      label: '保存昵称',
      run: function (ctx) {
        if (ctx.state.busy) return Promise.resolve();
        var token = ctx.state.session.token;
        if (!token) return sessionLost(ctx, null);
        var nickname = validateNickname(ctx.state.settings ? ctx.state.settings.nickname : '');
        if (nickname === null) {
          noticeNotice(ctx, 'error', ctx.format.NICKNAME_MAX_TEXT);
          return Promise.resolve();
        }
        busy(ctx, true);
        ctx.dispatch({ type: 'notice.set', notice: null });
        return ctx.api.setNickname(token, { nickname: nickname }).then(function (result) {
          busy(ctx, false);
          if (result.transport === 'error') return failFrom(ctx, result);
          if (!ctx.format.isOk(result.envelope)) {
            if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
            return failFrom(ctx, result);
          }
          ctx.dispatch({ type: 'settings.set', nickname: '', result: null });
          noticeNotice(ctx, 'info', ctx.format.nicknameOkText(result.envelope));
          // 摘要与本地会话里的昵称同步：再取一次 /me（**静默**：失败不影响上面的成功文案）
          return ctx.api.me(token).then(function (me) {
            if (!me || me.transport !== 'response' || !ctx.format.isOk(me.envelope)) return undefined;
            var session = ctx.format.sessionOf(me.envelope);
            ctx.dispatch({ type: 'profile.set', envelope: me.envelope });
            ctx.dispatch({
              type: 'session.set', token: token, publicId: session.publicId, nickname: session.nickname,
              expiresAt: ctx.state.session.expiresAt, isAdmin: session.isAdmin,
            });
            return undefined;
          });
        });
      },
    },
  };

  // F3：切屏（view.go 已负责清提示与弹窗；此处只补"切屏不需要请求"这一语义）
  function goView(ctx, view) {
    ctx.dispatch({ type: 'view.go', view: view });
    return Promise.resolve();
  }

  /* ---------- F6：战斗查看器的本地动作（不改服务端状态、不发请求） ---------- */

  // 查看器状态的唯一访问口径（缺省值与 store.emptyViewer() 同形，防脏状态打崩投影）
  function viewerOf(ctx) {
    var v = ctx.state ? ctx.state.viewer : null;
    return v && typeof v === 'object' ? v : { frames: null, index: 0, battleId: null, traceOwner: 'p1' };
  }

  // 跳到指定帧（越界夹取）。**无帧 = 空操作**：不写提示、不发请求（按钮在 UI 上已禁用）
  function gotoFrame(ctx, index) {
    if (ctx.state.busy) return Promise.resolve();
    var frames = viewerOf(ctx).frames;
    var total = Array.isArray(frames) ? frames.length : 0;
    if (total === 0) return Promise.resolve();
    var next = index;
    if (next < 0) next = 0;
    if (next > total - 1) next = total - 1;
    ctx.dispatch({ type: 'viewer.frame.set', index: next });
    return Promise.resolve();
  }

  function stepFrame(ctx, delta) {
    var current = viewerOf(ctx).index;
    return gotoFrame(ctx, (typeof current === 'number' && isFinite(current) ? current : 0) + delta);
  }

  // 「最后一帧」不是"负数"语义，必须显式取 total-1（否则 index=0 时 -1 会被当成末帧哨兵）
  function gotoLastFrame(ctx) {
    var frames = viewerOf(ctx).frames;
    var total = Array.isArray(frames) ? frames.length : 0;
    return total === 0 ? Promise.resolve() : gotoFrame(ctx, total - 1);
  }

  function setTraceOwner(ctx, owner) {
    if (ctx.state.busy) return Promise.resolve();
    ctx.dispatch({ type: 'viewer.trace.set', owner: owner });
    return Promise.resolve();
  }

  // AI 逻辑查看器（04 §3.3）：取我方出战配置（程序正文）+ AI 库（把 aiId 显示成名字）。
  //   `GET /me/configs` 是**必需**依赖（没有它就没有程序树）；`GET /me/ai` 只把 aiId 显示成名字，
  //   属**软依赖** —— 它失败时只写提示，弹窗照常打开（名字回落 aiId）。审查 F6-3 修正。
  function openAiLogic(ctx) {
    if (ctx.state.busy) return Promise.resolve();
    var token = ctx.state.session.token;
    if (!token) return sessionLost(ctx, null);
    busy(ctx, true);
    ctx.dispatch({ type: 'notice.set', notice: null });
    return ctx.api.configs(token).then(function (configs) {
      if (configs.transport === 'error') { busy(ctx, false); return failFrom(ctx, configs); }
      if (!ctx.format.isOk(configs.envelope)) {
        busy(ctx, false);
        if (ctx.format.isSessionError(configs.envelope)) return sessionLost(ctx, configs);
        return failFrom(ctx, configs);
      }
      return ctx.api.aiList(token).then(function (ai) {
        busy(ctx, false);
        var nameOk = ai.transport !== 'error' && ctx.format.isOk(ai.envelope);
        ctx.dispatch({ type: 'viewer.configs.set', envelope: configs.envelope });
        if (nameOk) ctx.dispatch({ type: 'viewer.ai.set', envelope: ai.envelope });
        ctx.dispatch({ type: 'modal.set', modal: { kind: 'ai-logic' } });
        if (nameOk) noticeNotice(ctx, 'info', ctx.format.AI_LOGIC_OK_TEXT);
        else noticeNotice(ctx, 'info', ctx.format.AI_LOGIC_NAME_FAIL_TEXT);
        return undefined;
      });
    });
  }

  // 无内联帧时的兜底：按 battleId 读归档回放（04 §2 反驳 3）
  function loadReplay(ctx) {    if (ctx.state.busy) return Promise.resolve();
    var token = ctx.state.session.token;
    if (!token) return sessionLost(ctx, null);
    var battleId = viewerOf(ctx).battleId;
    if (typeof battleId !== 'string' || battleId === '') {
      noticeNotice(ctx, 'error', ctx.format.QUICK_NO_FRAMES_TEXT);
      return Promise.resolve();
    }
    busy(ctx, true);
    ctx.dispatch({ type: 'notice.set', notice: null });
    return ctx.api.replay(token, battleId).then(function (result) {
      busy(ctx, false);
      if (result.transport === 'error') return failFrom(ctx, result);
      if (!ctx.format.isOk(result.envelope)) {
        if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
        noticeNotice(ctx, 'error', ctx.format.quickNoticeText(result.envelope));
        return undefined;
      }
      ctx.dispatch({ type: 'viewer.replay.set', envelope: result.envelope });
      ctx.dispatch({
        type: 'viewer.set',
        frames: ctx.format.replayFrames(result.envelope),
        source: 'replay',
        battleId: battleId,
      });
      noticeNotice(ctx, 'info', ctx.format.replayOkText(result.envelope));
      return undefined;
    });
  }

  /* ---------- F7：锦标赛与排行榜的公共工具 ---------- */

  // 锦标赛翻页：纯本地动作（页码夹取；不重发请求 —— 整批结果已在 state 里）
  function turnPage(ctx, delta) {
    if (ctx.state.busy) return Promise.resolve();
    var env = ctx.state.tournament ? ctx.state.tournament.envelope : null;
    if (env === null || !ctx.format.isOk(env)) return Promise.resolve();
    var total = ctx.format.resultsOf(env).length;
    var pages = total === 0 ? 1 : Math.ceil(total / ctx.format.TOURNAMENT_PAGE_SIZE);
    var next = (ctx.state.tournament.page || 0) + delta;
    if (next < 0) next = 0;
    if (next > pages - 1) next = pages - 1;
    ctx.dispatch({ type: 'tournament.page.set', page: next });
    return Promise.resolve();
  }

  // 拉榜单（唯一取数实现）：board/scope/offset 缺省沿用当前状态
  function loadBoard(ctx, quiet, override) {
    if (ctx.state.busy) return Promise.resolve();
    var token = ctx.state.session.token;
    if (!token) return sessionLost(ctx, null);
    var b = (ctx.state.board || {}).board;
    b = b === 'arrival' ? 'arrival' : 'points';
    var scope = (ctx.state.board || {}).scope || 'global';
    var offset = (ctx.state.board || {}).offset || 0;
    var limit = (ctx.state.board || {}).limit || 20;
    if (override) {
      if (override.board !== undefined) b = override.board;
      if (override.scope !== undefined) scope = override.scope;
      if (override.offset !== undefined) offset = override.offset;
    }
    busy(ctx, true);
    if (quiet !== true) ctx.dispatch({ type: 'notice.set', notice: null });
    return ctx.api.leaderboard(token, ctx.format.boardQuery(b, scope, offset, limit)).then(function (result) {
      busy(ctx, false);
      if (result.transport === 'error') return failFrom(ctx, result);
      if (!ctx.format.isOk(result.envelope)) {
        if (ctx.format.isSessionError(result.envelope)) return sessionLost(ctx, result);
        noticeNotice(ctx, 'error', ctx.format.boardNoticeText(result.envelope));
        return undefined;
      }
      // 审查 F7-D：榜上人数在会话中途缩水（封禁/删号）时不能停在空页上 —— 服务端会把越界 offset 变成
      //   "0 行 + total=1"，屏上就会出现 `第 2/1 页 · 共 1 人`（与「（本榜暂无玩家）」并列）。
      //   修法：按 `total` 夹取 offset，**最多回退一次**（与 §8 A-4 的删除后回退同一手法）。
      var total = ctx.format.boardTotal(result.envelope);
      var clamped = offset;
      var allowClamp = !(override && override.noClamp === true);
      if (allowClamp && total >= 0 && limit > 0 && offset > 0) {
        var maxOffset = total === 0 ? 0 : Math.floor((total - 1) / limit) * limit;
        if (offset > maxOffset) clamped = maxOffset;
      }
      if (clamped !== offset) {
        return loadBoard(ctx, quiet, { board: b, scope: scope, offset: clamped, noClamp: true });
      }
      ctx.dispatch({
        type: 'board.set', envelope: result.envelope, board: b, scope: scope,
        offset: offset, limit: limit,
      });
      if (quiet !== true) noticeNotice(ctx, 'info', ctx.format.BOARD_OK_TEXT);
      return undefined;
    });
  }

  // 切榜 / 换范围：改 board/scope 并**回到第 1 页**（否则会看到"第 3 页的另一个榜"）
  function switchBoard(ctx, board, scope) {
    if (ctx.state.busy) return Promise.resolve();
    var b = board === null || board === undefined ? (ctx.state.board || {}).board : board;
    var s = scope === null || scope === undefined ? (ctx.state.board || {}).scope : scope;
    return loadBoard(ctx, false, { board: b, scope: s, offset: 0 });
  }

  // 翻页（offset 由 limit 推进一步；上一页夹到 0；下一页仅在服务端说 hasMore 时有效）
  function pageBoard(ctx, delta) {
    if (ctx.state.busy) return Promise.resolve();
    var env = ctx.state.board ? ctx.state.board.envelope : null;
    if (env === null || !ctx.format.isOk(env)) {
      // 还没加载过榜单：点翻页等于"先拉第一页"，不是静默失败
      return loadBoard(ctx, false, { offset: 0 });
    }
    var limit = (ctx.state.board || {}).limit || 20;
    var offset = (ctx.state.board || {}).offset || 0;
    if (delta > 0 && !ctx.format.boardHasMore(env)) return Promise.resolve();
    var next = offset + delta * limit;
    if (next < 0) next = 0;
    return loadBoard(ctx, false, { offset: next });
  }

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
