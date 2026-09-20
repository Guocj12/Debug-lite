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
    function mount() {
      var model = DL.format.viewModel(store.getState());
      doc.title = model.pageTitle;
      var host = doc.getElementById('view');
      if (host) host.innerHTML = DL.render.render(model);
    }

    function dispatch(action) {
      store.dispatch(action);
      if (action && action.type === 'form.set') return; // 输入不重绘，避免光标跳动
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
    function run(action) {
      var def = DL.actions.ACTIONS[action];
      if (!def || typeof def.run !== 'function') {
        dispatch({ type: 'notice.set', notice: { kind: 'error', text: '未实现的动作：' + action } });
        return Promise.resolve(null);
      }
      return Promise.resolve(def.run(buildCtx())).catch(function (e) {
        dispatch({ type: 'notice.set', notice: { kind: 'error', text: '内部错误：' + (e && e.message ? e.message : String(e)) } });
        return null;
      });
    }

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-action]') : null;
      if (!el) return;
      var action = el.getAttribute('data-action');
      if (!action) return;
      // submit 型按钮交给 form 的 submit 事件处理，避免同一动作跑两遍
      if (el.tagName === 'BUTTON' && el.type === 'submit') {
        var form = el.form;
        if (form && form.getAttribute && form.getAttribute('data-enter') === action) return;
      }
      run(action);
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
      dispatch({ type: 'form.set', field: t.name, value: t.value });
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
      dispatch({
        type: 'session.set', token: token,
        publicId: saved ? saved.publicId : null,
        nickname: saved ? saved.nickname : null,
        expiresAt: saved ? saved.expiresAt : null,
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
        dispatch({ type: 'session.set', token: token, publicId: session.publicId, nickname: session.nickname, expiresAt: session.expiresAt });
        dispatch({ type: 'view.go', view: 'home' });
        dispatch({ type: 'booted.set', booted: true });
        return result;
      });
    }

    function start() {
      mount();
      doc.addEventListener('click', onClick);
      doc.addEventListener('submit', onSubmit);
      doc.addEventListener('input', onInput);
      return boot();
    }

    return {
      store: store, api: api, storage: storage,
      mount: mount, dispatch: dispatch, run: run, boot: boot, start: start,
      handlers: { onClick: onClick, onSubmit: onSubmit, onInput: onInput },
    };
  }

  return { createApp: createApp, createStorage: createStorage, KEY_TOKEN: KEY_TOKEN, KEY_SESSION: KEY_SESSION };
});
