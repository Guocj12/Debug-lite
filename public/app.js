'use strict';
/* public/app.js —— 外壳引导：store 装配 + **单一 DOM 写入点** + 事件委托（总纲 §1.5；设计依据 01-auth.md §7）
 *
 * 硬约束（机器核对见 tests/frontend/auth-ui-contract.test.js）：
 *   · `innerHTML` 只在本文件出现（单一 DOM 写入点）；
 *   · 所有 DOM 事件在此集中委托到 public/actions.js 的白名单动作；
 *   · 本文件不读响应字段（不出现契约路径字面量），一律经 public/format.js 投影。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.app = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var KEY_TOKEN = 'dl.token';       // 01-auth.md §7.3
  var KEY_SESSION = 'dl.session';   // 01-auth.md §7.3

  // localStorage 封装；不可用（隐私模式/被禁用）→ 内存降级并标记 degraded
  function createStorage(win) {
    var memory = { token: null, session: null };
    var degraded = false;
    function ls() {
      try {
        return win && win.localStorage ? win.localStorage : null;
      } catch (e) {
        degraded = true;
        return null;
      }
    }
    function readRaw(key) {
      var store = ls();
      if (!store) return null;
      try {
        return store.getItem(key);
      } catch (e) {
        degraded = true;
        return null;
      }
    }
    function writeRaw(key, value) {
      var store = ls();
      if (!store) return false;
      try {
        store.setItem(key, value);
        return true;
      } catch (e) {
        degraded = true;
        return false;
      }
    }
    function removeRaw(key) {
      var store = ls();
      if (!store) return;
      try {
        store.removeItem(key);
      } catch (e) {
        degraded = true;
      }
    }
    return {
      get degraded() { return degraded || ls() === null; },
      readToken: function () {
        var raw = readRaw(KEY_TOKEN);
        return typeof raw === 'string' && raw !== '' ? raw : null;
      },
      readSession: function () {
        var raw = readRaw(KEY_SESSION);
        if (typeof raw !== 'string' || raw === '') return null;
        try {
          var parsed = JSON.parse(raw);
          return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (e) {
          return null;
        }
      },
      saveSession: function (session) {
        if (!session || typeof session !== 'object') return;
        if (typeof session.token === 'string' && session.token !== '') writeRaw(KEY_TOKEN, session.token);
        writeRaw(KEY_SESSION, JSON.stringify({
          publicId: session.publicId === undefined ? null : session.publicId,
          nickname: session.nickname === undefined ? null : session.nickname,
          expiresAt: session.expiresAt === undefined ? null : session.expiresAt,
        }));
      },
      clear: function () {
        removeRaw(KEY_TOKEN);
        removeRaw(KEY_SESSION);
      },
    };
  }

  function createApp(deps) {
    var d = deps || {};
    var doc = d.doc;
    var win = d.win || (typeof window !== 'undefined' ? window : null);
    var DL = d.DL || (typeof self !== 'undefined' && self.DL ? self.DL : (typeof globalThis !== 'undefined' ? globalThis.DL : null));
    if (!DL) throw new Error('public/app.js 需要先加载 store/format/render/actions/api（window.DL）');
    if (!doc) throw new Error('public/app.js 需要 document（浏览器环境）');

    var storage = d.storage || createStorage(win);
    var api = d.api || DL.api.createApi({ baseUrl: d.baseUrl || '', fetchImpl: d.fetchImpl });
    var store = DL.store.createStore(DL.store.initialState());

    // 单一 DOM 写入点
    // D-179：**渲染绝不外抛**。背景（用户实测）：某屏 viewModel/render 抛异常时，异常会沿
    //   dispatch → 动作的 promise 链一路上抛，链尾的 `busy(ctx,false)` 永不执行 → 全局 busy 卡在 true
    //   → 所有按钮变灰且点击被 `if (ctx.state.busy) return` 静默吞掉（刷新页面才恢复）。
    //   故此处两级兜底：① viewModel 失败 → format.fatalViewModel（常量 vm，自身不可能再失败）；
    //   ② 连 render 也失败 → 一段不含任何状态的最小 HTML（innerHTML 仍只在本文件出现）。
    function mount() {
      var host = doc.getElementById('view');
      var model;
      try {
        model = DL.format.viewModel(store.getState());
      } catch (e) {
        // 只改状态、不重绘（避免 mount → dispatch → mount 递归）；busy 复位是"按钮不永久变灰"的关键
        if (store.getState().busy === true) store.dispatch({ type: 'busy.set', busy: false });
        try {
          model = DL.format.fatalViewModel(e && e.message ? e.message : String(e));
        } catch (e2) {
          model = null;
        }
      }
      if (!host) return;
      if (model === null) {
        host.innerHTML = '<h2>界面内部错误</h2><p class="notice">渲染失败，请刷新页面。</p>';
        return;
      }
      try {
        doc.title = model.pageTitle;
        // D-194：**渲染前后保留滚动位置**。整屏是 `innerHTML` 重绘，重绘会把每个滚动容器
        //   的 scrollTop/Left 归零 —— 树/节点库一操作就跳回顶部，用户会以为"点了没反应"。
        //   所以按元素 id 记下当前滚动量，重绘后再写回去。
        var scrollMemo = snapshotScroll(host);
        host.innerHTML = DL.render.render(model);
        restoreScroll(host, scrollMemo);
      } catch (e3) {
        host.innerHTML = '<h2>界面内部错误</h2><p class="notice">渲染失败，请刷新页面。</p>';
      }
    }

    /** 记下 host 内所有滚动容器的滚动位置（按 id） */
    function snapshotScroll(host) {
      var out = {};
      var list = host.querySelectorAll ? host.querySelectorAll('.dl-scroll') : [];
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        if (!el.id) continue;
        if (el.scrollTop || el.scrollLeft) out[el.id] = [el.scrollTop, el.scrollLeft];
      }
      return out;
    }
    /** 把记下的滚动位置写回去（重绘后能对上的 id） */
    function restoreScroll(host, memo) {
      if (!memo || !host.querySelectorAll) return;
      Object.keys(memo).forEach(function (id) {
        var el = host.querySelector('#' + id);
        if (!el) return;                       // 该容器这次没渲染（切屏/收起）→ 直接放弃
        el.scrollTop = memo[id][0];
        el.scrollLeft = memo[id][1];
      });
    }

    function dispatch(action) {
      store.dispatch(action);
      // 输入不重绘，避免光标跳动（F1 表单 / F2 管理面板 / F3 开箱与设置输入框 / F5 AI 编辑器同理）
      if (action && (action.type === 'form.set' || action.type === 'admin.form.set' || action.type === 'screen.form.set'
        || action.type === 'ai.text.set' || action.type === 'ai.import.set')) return;
      // D-196：幽灵节点跟手时**不重绘**（每帧重建整屏会掉帧、也会打断拖动）；
      //   只有"开始拖动"那一次（redraw:true）才重绘，让幽灵节点出现。
      if (action && action.type === 'ai.drag.set' && action.redraw !== true) return;
      mount();
    }

    function buildCtx() {
      return {
        state: store.getState(),
        dispatch: dispatch,
        api: api,
        format: DL.format,
        storage: storage,
        actions: DL.actions.ACTIONS,
      };
    }

    // 动作执行：白名单未命中 → 可见兜底提示（「按钮永不无声」的最后一道保险）
    //   payload = 行级动作的目标（来自被点按钮的 data-player-id / data-public-id，02-accounts.md §3.2）
    // D-179：**动作绝不无声**。三类异常都必须落到可见提示并复位 busy：
    //   ① run 同步抛（`Promise.resolve(def.run(...))` 之前就抛，旧实现连 catch 都进不去 → 点击毫无反应）；
    //   ② run 返回的 promise 拒绝；③ 提示 DOM 本身渲染失败（已由 mount 兜底）。
    function actionError(e) {
      if (store.getState().busy === true) store.dispatch({ type: 'busy.set', busy: false });  // 只改状态，不重绘
      dispatch({ type: 'notice.set', notice: { kind: 'error', text: '内部错误：' + (e && e.message ? e.message : String(e)) } });
      return null;
    }

    function run(action, payload) {
      var def = DL.actions.ACTIONS[action];
      if (!def || typeof def.run !== 'function') {
        dispatch({ type: 'notice.set', notice: { kind: 'error', text: '未实现的动作：' + action } });
        return Promise.resolve(null);
      }
      var out;
      try {
        out = def.run(buildCtx(), payload || null);
      } catch (e) {
        return Promise.resolve(actionError(e));
      }
      return Promise.resolve(out).catch(actionError);
    }

    // 从被点元素上取行级/元素级目标（render 只搬运 vm 给的字符串，见 public/render.js 的 targetAttrs）
    //   F2：data-player-id / data-public-id；F3：data-uid（物品行）/ data-slot（出战配置）/ data-bucket（分桶）
    //   提交③：data-pos（位置）/ data-idx（插槽序号）/ data-empty（`空`候选）/ data-ai-id（AI 库引用）
    /**
     * 把按钮上的 `data-*` 收成动作载荷。
     *
     * D-194：两端都改成**通用透传**（render 的 layAttrs 全写、这里全收）。
     *   白名单踩过两次同样的坑：D-188 漏 `bucket`、D-194 漏 `node` —— 都是"字段明明在
     *   payload 里，却到不了动作层，按钮点了没反应/行为不对"。现在只排除**明确不是载荷**的：
     *   `data-action`（就是动作名）、`data-field`（输入框字段，走 change 不派发点击）、
     *   `data-pan`/`data-depth`/`data-scroll-*`（渲染层的布局标记）。
     */
    var NON_PAYLOAD = ['action', 'pan', 'depth', 'scrollTop', 'scrollLeft'];

    function payloadOf(el) {
      var ds = el && el.dataset ? el.dataset : null;
      if (!ds) return null;
      var out = {};
      Object.keys(ds).forEach(function (k) {
        if (NON_PAYLOAD.indexOf(k) >= 0) return;
        var v = ds[k];
        if (typeof v === 'string' && v !== '') out[k] = v;
      });
      return Object.keys(out).length === 0 ? null : out;
    }

    // D-190：点在弹窗"包装层/空白"上要等同于点遮罩。
    //   遮罩是弹窗的**唯一出口**（弹窗内已无关闭键），所以这条兜底不能只靠 CSS 的 pointer-events：
    //   一旦有人给 `.dl-layer` 加了尺寸（真实踩过：`position:absolute;inset:0` 把遮罩整块盖住），
    //   CSS 层面就静默失效了。这里在 DOM 层面再判一次，保证"点弹窗外面"永远能关。
    var MODAL_CHROME = ['dl-layer', 'dl-modal'];

    function isModalChrome(node) {
      if (!node || !node.classList) return false;
      for (var i = 0; i < MODAL_CHROME.length; i++) {
        if (node.classList.contains(MODAL_CHROME[i])) return true;
      }
      return false;
    }

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (!el) {
        // 没命中任何动作：如果点在弹窗的包装层/空白上 → 等同点遮罩（关闭）
        if (isModalChrome(ev.target)) run('modal-close', null);
        return;
      }
      var action = el.getAttribute('data-action');
      if (!action) return;
      // submit 型按钮交给 form 的 submit 事件处理，避免同一动作跑两遍
      if (el.tagName === 'BUTTON' && el.type === 'submit') {
        var form = el.form;
        if (form && form.getAttribute && form.getAttribute('data-enter') === action) return;
      }
      run(action, payloadOf(el));
    }

    function onSubmit(ev) {
      var form = ev.target;
      var action = form && form.getAttribute ? form.getAttribute('data-enter') : null;
      if (!action) return;
      ev.preventDefault();
      run(action);
    }

    function onInput(ev) {
      var t = ev.target;
      if (!t || !t.name) return;
      // F5/D-172：AI 编辑器的字段输入（`ai.<地址>.<字段键>`）——**只记文本、不重绘、不提交**；
      //   提交发生在 change（失焦/回车）事件上 → 走 ai-field-commit 动作（改草稿 + 触发一次校验）
      if (DL.store.isAiField && DL.store.isAiField(t.name)) {
        dispatch({ type: 'ai.text.set', field: t.name, value: t.value });
        return;
      }
      // F5：导入 JSON 的多行输入（唯一 textarea 用途，裁决 ③）
      if (t.name === 'aiImport') {
        dispatch({ type: 'ai.import.set', value: t.value });
        return;
      }
      // F2：管理面板输入框（adminToken/adminTarget/adminCount）走 admin.form.set（02-accounts.md §7）
      var isAdminField = DL.store.ADMIN_FIELDS && DL.store.ADMIN_FIELDS.indexOf(t.name) !== -1;
      // F3：开箱次数 / 新昵称走 screen.form.set（03 §7；各自落 state.box.times / state.settings.nickname）
      var isScreenField = DL.store.SCREEN_FIELDS && DL.store.SCREEN_FIELDS.indexOf(t.name) !== -1;
      dispatch({
        type: isAdminField ? 'admin.form.set' : (isScreenField ? 'screen.form.set' : 'form.set'),
        field: t.name,
        value: t.value,
      });
    }

    // F5：AI 编辑器字段「提交」（change = 失焦或回车）→ 写入草稿并自动校验一次（裁决 ⑨）
    function onChange(ev) {
      var t = ev.target;
      // D-194：布局表里的输入框（`kind:'input'` / `'textarea'`）提交。
      //   `aiImport` 由 onInput 逐键收进 `ai.import.set`（"应用导入"才解析），这里不重复处理。
      var fname = t && t.getAttribute ? t.getAttribute('data-field') : null;
      if (fname === 'aiImport') return;
      if (fname === 'aiName') { dispatch({ type: 'ai.name.set', value: t.value }); return; }
      if (fname) { dispatch({ type: 'form.set', field: fname, value: t.value }); return; }
      if (!t || !t.name) return;
      if (DL.store.isAiField && DL.store.isAiField(t.name)) {
        run('ai-field-commit', { field: t.name });
      }
    }

    /* ---------------- D-194：拖拽平移（`data-pan` 的滚动容器） ----------------
     * 口径（用户 2026-10-18）：「空白处左键移动视图」。
     * 要点：
     *   · 只有**滚动容器**响应（`data-pan`）；
     *   · 按下后移动 **< 4px** 视为**点击**、不进入平移 —— 否则"点空白收起详情"永远点不到；
     *   · 平移量 = 位移取反写进 scrollLeft/Top（往左拖 = 看右边内容）；
     *   · 命中 `[data-action]` / 输入框的元素**不**启动平移（那是按钮、树行、名字框）。
     */
    var PAN_THRESHOLD = 4;
    var panState = null;

    function findPanBox(node) {
      var walk = node;
      for (var guard = 0; walk && guard < 32; guard++) {
        if (walk.getAttribute && walk.getAttribute('data-pan')) return walk;
        walk = walk.parentNode;
      }
      return null;
    }

    function onPointerDown(ev) {
      if (ev.button !== undefined && ev.button !== 0) return;      // 只认左键
      var t = ev.target;
      if (!t) return;
      if (t.closest && (t.closest('[data-action]') || t.closest('input, textarea, select'))) return;
      var box = findPanBox(t);
      if (!box) return;
      panState = { box: box, x: ev.clientX, y: ev.clientY,
                   top: box.scrollTop, left: box.scrollLeft, moved: false };
    }

    function onPointerMove(ev) {
      if (!panState) return;
      var dx = ev.clientX - panState.x, dy = ev.clientY - panState.y;
      if (!panState.moved && Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return;
      panState.moved = true;
      var pan = panState.box.getAttribute('data-pan');
      if (pan === 'both' || pan === 'h') panState.box.scrollLeft = panState.left - dx;
      if (pan === 'both' || pan === 'v') panState.box.scrollTop = panState.top - dy;
      if (ev.preventDefault) ev.preventDefault();
    }

    function onPointerUp() {
      // 没移动过 = 一次普通点击（空白点击的语义由 onClick / 动作层处理）
      if (panState && !panState.moved) panState = null;
      else panState = null;
      dragState = null;
    }

    /* ---------------- D-194：滚轮缩放（树区） ----------------
     * 用户口径：「滚轮放大缩小」，不按 Ctrl。
     * 只对**布局屏里的滚动容器**生效（`[data-pan]`），文本屏滚轮照常滚动。
     * 缩放值是状态（`ai.zoom.set`），由 format 按它放大行高/缩进/字号 —— 不用 transform
     * （transform 会让浏览器算错滚动尺寸，滚动条到不了底）。
     */
    function onWheel(ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var box = t.closest('[data-pan]');
      if (!box) return;
      var st = store.getState();
      var ed = st.aiEditor;
      if (!ed) return;
      if (ev.preventDefault) ev.preventDefault();
      var step = (ev.deltaY || 0) > 0 ? -0.1 : 0.1;
      var next = Math.round((Number(ed.zoom || 1) + step) * 100) / 100;
      dispatch({ type: 'ai.zoom.set', zoom: next });
    }

    /* ---------------- D-194：拖动节点进树（含落点预览） ----------------
     * 口径：按住节点行拖动 ≥4px 才进入拖动；移动时算**最近可插入位**并显示预览线；
     *   松手按命中的候选落位；没有候选 = 取消（不提示成功）。
     * 几何全部交给 `aiBlueprint.nearestDrop()`（纯函数，与测试共用）。
     */
    var dragState = null;
    var DND_THRESHOLD = 4;

    function onDragStart(ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      var t = ev.target;
      if (!t || !t.closest) return;
      var node = t.closest('[data-action="ai-node-append"]');
      if (!node || node.disabled) return;
      var nodeId = node.getAttribute('data-node') || '';
      if (nodeId === '') return;
      dragState = { nodeId: nodeId, x: ev.clientX, y: ev.clientY, active: false };
    }

    function onDragMove(ev) {
      if (!dragState) return;
      var dx = ev.clientX - dragState.x, dy = ev.clientY - dragState.y;
      if (!dragState.active && Math.abs(dx) < DND_THRESHOLD && Math.abs(dy) < DND_THRESHOLD) return;
      dragState.active = true;
      var box = doc.querySelector('[data-pan]');
      if (!box) return;
      var st = store.getState();
      var ed = st.aiEditor;
      if (!ed || !ed.draft) return;
      // 指针坐标 → **树内容坐标**（扣掉容器位置与滚动量）
      var r = box.getBoundingClientRect ? box.getBoundingClientRect() : { left: 0, top: 0 };
      var px = ev.clientX - r.left + box.scrollLeft;
      var py = ev.clientY - r.top + box.scrollTop;
      var bpMod = DL.aiBlueprint;
      if (!bpMod) return;
      var hit = bpMod.nearestDrop(ed.draft, { x: px, y: py }, {
        kind: kindOfNode(bpMod, dragState.nodeId),
        pitch: treePitch(), indentPx: 16,
      });
      dispatch({ type: 'ai.drop.set', y: hit ? hit.anchorY : null, target: hit });
    }

    function onDragEnd() {
      if (!dragState) return;
      var st = store.getState();
      var hit = st.aiEditor && st.aiEditor.dropTarget;
      var nodeId = dragState.nodeId;
      var active = dragState.active;
      dragState = null;
      if (!active) return;                       // 只是点了一下 → 交给 onClick 的 ai-node-append
      dispatch({ type: 'ai.drop.set', y: null, target: null });
      if (!hit) return;                          // 没有可插入位 = 取消放置
      run('ai-node-drop', {
        node: nodeId, parentAddr: hit.parentAddr, index: hit.index, where: hit.where,
      });
    }

    function kindOfNode(bpMod, nodeId) {
      var spec = bpMod.specOf(nodeId);
      return spec && spec.kind ? spec.kind : 'stmt';
    }
    /** 树的行走高（与布局表 rowsFrom.pitch 一致；缩放后按 zoom 放大） */
    function treePitch() {
      var st = store.getState();
      var ed = st.aiEditor || {};
      var z = Number(ed.zoom || 1);
      return Math.round(24 * z);
    }

    // 启动自检（01-auth.md §7.3）：无 token → 登录屏；有 token → GET /me 判定会话真伪
    function boot() {
      var token = storage.readToken();
      if (!token) {
        dispatch({ type: 'booted.set', booted: true });
        if (storage.degraded) {
          dispatch({ type: 'notice.set', notice: { kind: 'error', text: '本机浏览器禁用了本地存储：刷新后需重新登录' } });
        }
        return Promise.resolve(null);
      }
      var saved = storage.readSession();
      // isAdmin **不落盘**（Q3 A / 02-accounts.md §2.1）：本地存储里没有管理员标记，
      //   管理入口一律等 GET /me 的 data.flags.isAdmin 确认后才出现
      dispatch({
        type: 'session.set', token: token,
        publicId: saved ? saved.publicId : null,
        nickname: saved ? saved.nickname : null,
        expiresAt: saved ? saved.expiresAt : null,
        isAdmin: false,
      });
      return api.me(token).then(function (result) {
        if (result.transport === 'error') {
          dispatch({ type: 'view.go', view: 'login' });
          dispatch({ type: 'notice.set', notice: { kind: 'error', text: DL.format.networkText(result.message) } });
          dispatch({ type: 'booted.set', booted: true });
          return null;
        }
        if (!DL.format.isOk(result.envelope)) {
          if (DL.format.isSessionError(result.envelope)) {
            storage.clear();
            dispatch({ type: 'session.clear' });
            dispatch({ type: 'auth.set', envelope: null });
            dispatch({ type: 'profile.set', envelope: null });
          }
          dispatch({ type: 'view.go', view: 'login' });
          dispatch({ type: 'notice.set', notice: { kind: 'error', text: DL.format.noticeText(result.envelope) } });
          dispatch({ type: 'booted.set', booted: true });
          return null;
        }
        var session = DL.format.sessionOf(result.envelope);
        dispatch({ type: 'profile.set', envelope: result.envelope });
        dispatch({ type: 'session.set', token: token, publicId: session.publicId, nickname: session.nickname, expiresAt: session.expiresAt, isAdmin: session.isAdmin });
        // FR-11：登录态下的落点 = 主界面 hub（F1 的 home 已降级为 profile 子屏）
        dispatch({ type: 'view.go', view: 'hub' });
        dispatch({ type: 'booted.set', booted: true });
        // F9/D-180：主界面由布局表渲染，落地时就要备齐**三份数据**（/me + /me/configs + /me/warehouse），
        //   否则装备/技能/候选是空的。放在 booted 之后**不阻塞**启动自检（`ready()` 只看 booted）。
        // background: 预取不占全局 busy（否则会把用户随后的点击静默吞掉）
        run('refresh-hub', { skipProfile: true, background: true });
        return result;
      });
    }

    /** 手势层的挂载点（`mount()` 里的 host 是局部变量，这里单独取一次） */
    function viewHost() { return doc.getElementById('view'); }

    function start() {
      mount();
      doc.addEventListener('click', onClick);
      doc.addEventListener('submit', onSubmit);
      doc.addEventListener('input', onInput);
      doc.addEventListener('change', onChange);   // F5：AI 编辑器字段提交（失焦/回车）
      // D-195：**手势层统一走 DL.layoutInteract**（滚轮缩放 / 拖动空白平移 / 拖动节点放置 / 点空白收起）。
      //   点击仍由本文件的 onClick 负责（传 click:false 避免重复绑定）。
      //   以前在手势只写在本文件、预览另写一套 ⇒ 同一个界面两套行为。
      if (DL.layoutInteract && typeof DL.layoutInteract.attach === 'function') {
        var gh = viewHost();
        if (gh) {
          DL.layoutInteract.attach(gh, {
            DL: DL,
            getState: function () { return store.getState(); },
            dispatch: dispatch,
            run: run,
            click: false,
          });
        }
      }
      return boot();
    }

    return {
      store: store, api: api, storage: storage,
      mount: mount, dispatch: dispatch, run: run, boot: boot, start: start,
      handlers: { onClick: onClick, onSubmit: onSubmit, onInput: onInput, onChange: onChange },
    };
  }

  return { createApp: createApp, createStorage: createStorage, KEY_TOKEN: KEY_TOKEN, KEY_SESSION: KEY_SESSION };
});
