'use strict';
/* tests/helpers/browser.js —— 浏览器等价测试装置（D-179）
 *
 * 为什么必须有它（用户实测缺陷的直接教训）：
 *   既有的 tests/frontend/*.test.js 一律 `require('../../public/format.js')` —— 走的是各 UMD 文件的
 *   **CommonJS 分支**，于是天然绕过了 `public/index.html` 的 `<script>` 清单。
 *   2026 年实测缺陷：index.html 漏载 `/ai-blueprint.js` → 浏览器里 `DL.aiBlueprint === undefined`
 *   → 所有触碰积木蓝图的分支（战斗后的 AI 逻辑查看器、读取回放、AI 编辑器、保存 AI）全部抛异常
 *   → 异常沿 dispatch → promise 链上抛，链尾的 busy(ctx,false) 永不执行 → 全屏按钮变灰、点击无声。
 *   而 147 个测试文件当时**全绿**。
 *
 * 本装置的做法：把 index.html 里列出的脚本**按原顺序**灌进一个 `node:vm` 上下文（强制走 UMD 的
 *   浏览器分支 `root.DL.x = factory(...)`），配一个手写假 DOM（只实现 app.js/boot.js 真正用到的成员）
 *   与**真实 HTTP**（Node 内建 fetch → 进程内真服务），于是"入口装配 + 事件委托 + 投影 + 渲染"整条链路
 *   都在测试里跑起来。
 *
 * 手写假 DOM（非 jsdom，零依赖）的边界：只支持 render.js 实际产出的标记
 *   （双引号属性、`disabled` 裸属性、`<form data-enter>`、`<button data-action>`、`<input name>`）。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO, 'public');

/* ---------- index.html 的脚本清单 ---------- */

function readIndexHtml(dir) {
  return fs.readFileSync(path.join(dir || PUBLIC_DIR, 'index.html'), 'utf8');
}

// 只认 `<script src="..."></script>`（不允许内联脚本：避免 XSS 面，见 boot.js 注释）
function scriptSrcs(html) {
  const out = [];
  const re = /<script\s+src="([^"]+)"\s*>\s*<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

// src → 磁盘文件（`/format.js` → `<public>/format.js`）
function srcToFile(src, dir) {
  return path.join(dir || PUBLIC_DIR, String(src).replace(/^\/+/, ''));
}

/* ---------- 极简标记解析（只够用：属性 + button/input/textarea/form） ---------- */

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);
const BARE_OK = new Set(['disabled', 'checked', 'selected', 'readonly', 'required', 'autofocus', 'multiple']);

function unesc(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function parseTags(html) {
  const source = String(html);
  const tags = [];
  const re = /<([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = {};
    const ar = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = ar.exec(m[2])) !== null) {
      const name = a[1].toLowerCase();
      const raw = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : (a[4] !== undefined ? a[4] : ''));
      attrs[name] = BARE_OK.has(name) ? (raw === '' ? '' : unesc(raw)) : unesc(raw);
    }
    tags.push({ tag, attrs, index: m.index, endIndex: m.index + m[0].length });
  }
  return { source, tags };
}

function camel(name) {
  return name.replace(/-([a-z0-9])/g, (all, c) => c.toUpperCase());
}

function datasetOf(attrs) {
  const out = {};
  for (const key of Object.keys(attrs)) {
    if (key.startsWith('data-')) out[camel(key.slice(5))] = attrs[key];
  }
  return out;
}

function formTagEnclosing(t, parsed, htmlText) {
  // 取最后一个开始于 t 之前、且其 </form> 在 t 之后的 <form>
  let found = null;
  for (const f of parsed.tags) {
    if (f.tag !== 'form') continue;
    if (f.index > t.index) break;
    const close = htmlText.indexOf('</form>', f.endIndex);
    if (close === -1) continue;
    if (close > t.index) found = f;
  }
  return found;
}

function formElOf(t) {
  const el = {
    tagName: 'FORM',
    getAttribute: (n) => (t.attrs[n] !== undefined ? t.attrs[n] : null),
  };
  return el;
}

function buttonElOf(t, parsed, htmlText) {
  const el = {
    tagName: 'BUTTON',
    type: t.attrs.type === undefined ? 'button' : t.attrs.type,
    disabled: t.attrs.disabled !== undefined,
    dataset: datasetOf(t.attrs),
    text: '',
    getAttribute: (n) => (t.attrs[n] !== undefined ? t.attrs[n] : null),
    closest: (sel) => (sel === '[data-action]' && t.attrs['data-action'] ? el : null),
    form: null,
  };
  const f = formTagEnclosing(t, parsed, htmlText);
  if (f) el.form = formElOf(f);
  return el;
}

/* ---------- 假 DOM + 沙箱装配 ---------- */

function createStorageBackend(seed) {
  const map = new Map(seed || []);
  return {
    map,
    api: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => { map.set(String(k), String(v)); },
      removeItem: (k) => { map.delete(k); },
    },
  };
}

// 真实 HTTP（Node 内建 fetch）；相对路径（浏览器里的 baseUrl=''）补上测试服务前缀
function makeFetch(baseUrl) {
  return function fetchImpl(url, init) {
    const target = /^https?:\/\//.test(url) ? url : String(baseUrl || '') + url;
    return fetch(target, init);
  };
}

async function createBrowser(options) {
  const opts = options || {};
  const dir = opts.publicDir || PUBLIC_DIR;
  const html = readIndexHtml(dir);
  const srcs = scriptSrcs(html);
  const listeners = Object.create(null);

  const host = {
    writes: 0,
    _html: '',
    set innerHTML(value) { this.writes += 1; this._html = String(value); },
    get innerHTML() { return this._html; },
  };

  const documentObj = {
    title: '',
    getElementById: (id) => (id === 'view' ? host : null),
    addEventListener: (type, fn) => {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
  };

  const storageBackend = createStorageBackend(opts.storage);
  const logs = [];
  const sandbox = {
    document: documentObj,
    fetch: makeFetch(opts.baseUrl),
    console: {
      log: (...a) => logs.push(['log', ...a]),
      error: (...a) => logs.push(['error', ...a]),
      warn: (...a) => logs.push(['warn', ...a]),
      info: (...a) => logs.push(['info', ...a]),
    },
    setTimeout,
    clearTimeout,
    localStorage: storageBackend.api,
  };
  vm.createContext(sandbox);
  sandbox.window = sandbox;
  sandbox.self = sandbox;

  const loaded = [];
  const errors = [];
  for (const src of srcs) {
    const file = srcToFile(src, dir);
    const code = fs.readFileSync(file, 'utf8');
    try {
      vm.runInContext(code, sandbox, { filename: file });
    } catch (e) {
      errors.push({ src, error: e });
      break;   // 装配失败即止（后续模块必然也失败，报第一个错更有信息量）
    }
    loaded.push(src);
  }

  const app = sandbox.DL && sandbox.DL.currentApp ? sandbox.DL.currentApp : null;

  const h = {
    srcs, loaded, errors, host, document: documentObj, window: sandbox, sandbox, logs, storage: storageBackend,
    DL: sandbox.DL,
    app,
    get state() { return app ? app.store.getState() : null; },
    get html() { return host.innerHTML; },
    get writes() { return host.writes; },
    setHtml(value) { host.innerHTML = String(value); },

    /* 事件派发（与浏览器同语义） */
    fire(type, event) {
      const fns = listeners[type] || [];
      for (const fn of fns) fn(event);
    },
    buttons(action) {
      const parsed = parseTags(host.innerHTML);
      return parsed.tags
        .filter((t) => t.tag === 'button' && (action === undefined || t.attrs['data-action'] === action))
        .map((t) => buttonElOf(t, parsed, parsed.source));
    },
    actions() {
      const out = new Set();
      for (const b of h.buttons()) {
        const a = b.getAttribute('data-action');
        if (a) out.add(a);
      }
      return out;
    },
    disabledActions() {
      const out = new Set();
      for (const b of h.buttons()) {
        if (!b.disabled) continue;
        const a = b.getAttribute('data-action');
        if (a) out.add(a);
      }
      return out;
    },
    fields() {
      const source = host.innerHTML;
      const parsed = parseTags(source);
      return parsed.tags.filter((t) => t.tag === 'input' || t.tag === 'textarea').map((t) => {
        let value = t.attrs.value === undefined ? '' : t.attrs.value;
        if (t.tag === 'textarea') {
          // render.js 的 textareaHtml 把值写在**元素内容**里（不是属性）→ 单独取到 </textarea>
          const close = source.indexOf('</textarea>', t.endIndex);
          value = close === -1 ? '' : unesc(source.slice(t.endIndex, close));
        }
        return { tag: t.tag, name: t.attrs.name || null, value };
      });
    },
    forms() {
      const parsed = parseTags(host.innerHTML);
      return parsed.tags.filter((t) => t.tag === 'form').map((t) => t.attrs['data-enter'] || null);
    },
    text() {
      return unesc(String(host.innerHTML).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    },

    // 点按钮（submit 型按浏览器语义走 form 的 submit 事件）
    click(action, index) {
      const list = h.buttons(action);
      const el = list[index === undefined ? 0 : index];
      if (!el) throw new Error(`当前屏没有 data-action="${action}" 的按钮（现有：${[...h.actions()].join(', ')}）`);
      if (el.type === 'submit' && el.form && el.form.getAttribute('data-enter') === action) {
        h.fire('submit', { target: el.form, preventDefault() {} });
      } else {
        h.fire('click', { target: el });
      }
      return el;
    },
    // 输入（不重绘：与 app.js 的 form.set 分支一致）
    type(name, value) {
      h.fire('input', { target: { name, value, tagName: 'INPUT' } });
    },
    // 失焦/回车（F5 的字段提交）
    blur(name, value) {
      h.fire('change', { target: { name, value, tagName: 'INPUT' } });
    },
    submitForm(enterAction) {
      const parsed = parseTags(host.innerHTML);
      const f = parsed.tags.find((t) => t.tag === 'form' && t.attrs['data-enter'] === enterAction);
      if (!f) throw new Error(`当前屏没有 data-enter="${enterAction}" 的表单`);
      h.fire('submit', { target: formElOf(f), preventDefault() {} });
      return f;
    },

    sleep(ms) { return new Promise((r) => { setTimeout(r, ms); }); },
    // 等某个条件成立（用于"不置 busy 的后台动作"：AI 校验、静默取数等）
    async waitFor(predicate, maxMs) {
      const limit = typeof maxMs === 'number' ? maxMs : 5000;
      const started = Date.now();
      while (Date.now() - started < limit) {
        let ok = false;
        try { ok = predicate(h) === true; } catch (e) { ok = false; }
        if (ok) return true;
        await new Promise((r) => { setTimeout(r, 2); });
      }
      return false;
    },
    // 等到 busy 归位（动作走真实 HTTP）；上限 8s 兜底
    async settle(maxMs) {
      const limit = typeof maxMs === 'number' ? maxMs : 8000;
      const started = Date.now();
      await new Promise((r) => { setTimeout(r, 0); });
      while (h.app && h.state.busy === true && Date.now() - started < limit) {
        await new Promise((r) => { setTimeout(r, 2); });
      }
      await new Promise((r) => { setTimeout(r, 0); });
    },
    // 等启动自检结束（无 token 时同步；有 token 时会打一次 GET /me）
    async ready(maxMs) {
      const limit = typeof maxMs === 'number' ? maxMs : 8000;
      const started = Date.now();
      while (Date.now() - started < limit) {
        if (h.state && h.state.booted === true) return true;
        await new Promise((r) => { setTimeout(r, 2); });
      }
      return false;
    },
    // 预置登录态（跳过登录屏）
    async signIn(token, session) {
      storageBackend.api.setItem('dl.token', token);
      if (session) storageBackend.api.setItem('dl.session', JSON.stringify(session));
    },
  };
  return h;
}

module.exports = {
  REPO,
  PUBLIC_DIR,
  readIndexHtml,
  scriptSrcs,
  srcToFile,
  parseTags,
  datasetOf,
  createBrowser,
};
