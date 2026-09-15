'use strict';
/* public/js/util/log.js —— 前端日志三态适配（spec §1.3 步骤1 / §2.2 总控开关）
 * 形态1：无 window 且无注入 logger（node 环境/早期引用）→ noop 兜底，绝不抛错；
 * 形态2：注入 logger（shared/log.js createLogger 产物）→ 方法面转发（测试/嵌入用）；
 * 形态3：浏览器 window.DLLog → 引导级别：URL ?log= 显式覆盖 > localStorage.dl.v3.logPrefs > 默认 debug + render:trace。
 * 本文件自身不得 require/import 任何模块（L7 顶层；DLLog 为 /shared/log.js 注入的全局）。
 */

const LEVEL_NAMES = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace', 'all'];

function parseLevelName(x) {
  if (typeof x !== 'string') return null;
  const k = x.trim().toLowerCase();
  return LEVEL_NAMES.includes(k) ? k : null;
}

// ?log= 参数：`trace`（纯级别）/ `ui:trace,render:trace`（通道覆盖，spec §2.4）/ 兼容后端 `=` 语法
export function parseLogParam(str) {
  const out = { level: null, channels: {} };
  if (typeof str !== 'string' || str.trim() === '') return out;
  for (const seg of str.split(',')) {
    const s = seg.trim();
    if (s === '') continue;
    const sep = s.indexOf(':') >= 0 ? ':' : (s.indexOf('=') >= 0 ? '=' : null);
    if (sep === null) {
      const lv = parseLevelName(s);
      if (lv !== null) out.level = lv;
      continue;
    }
    const ch = s.slice(0, s.indexOf(sep)).trim();
    const lv = parseLevelName(s.slice(s.indexOf(sep) + 1).trim());
    if (ch !== '' && lv !== null) out.channels[ch] = lv;
  }
  return out;
}

// localStorage.dl.v3.logPrefs → {level?, channels?}（畸形 → 空对象，不抛）
export function readLogPrefs(storage) {
  try {
    if (!storage || typeof storage.getItem !== 'function') return {};
    const raw = storage.getItem('dl.v3.logPrefs');
    if (!raw) return {};
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    const lv = parseLevelName(v.level);
    if (lv !== null) out.level = lv;
    if (v.channels && typeof v.channels === 'object' && !Array.isArray(v.channels)) {
      out.channels = {};
      for (const k of Object.keys(v.channels)) {
        const l = parseLevelName(v.channels[k]);
        if (l !== null) out.channels[k] = l;
      }
    }
    return out;
  } catch (e) {
    return {};
  }
}

// ?log= 取参（避免依赖 URLSearchParams 的环境差异；search 形如 "?log=trace"）
export function urlLogParam(search) {
  if (typeof search !== 'string' || search === '') return '';
  const q = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of q.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    if (pair.slice(0, eq) === 'log') {
      try { return decodeURIComponent(pair.slice(eq + 1)); } catch (e) { return pair.slice(eq + 1); }
    }
  }
  return '';
}

function noopUtil() {
  const f = () => undefined;
  return {
    debug: f, info: f, warn: f, error: f, trace: f,
    setLevel: f, setChannelLevel: f,
    dump: () => [],
    records: () => [],
  };
}

function loggerUtil(logger) {
  return {
    debug: (c, e, m, x) => logger.debug(c, e, m, x),
    info: (c, e, m, x) => logger.info(c, e, m, x),
    warn: (c, e, m, x) => logger.warn(c, e, m, x),
    error: (c, e, m, x) => logger.error(c, e, m, x),
    trace: (c, e, m, x) => logger.trace(c, e, m, x),
    setLevel: (l) => logger.setLevel(l),
    setChannelLevel: (c, l) => logger.setChannelLevel(c, l),
    dump: () => logger.dump(),
    records: () => logger.records,
  };
}

// 引导入口（spec §1.3 步骤1）：解析三级来源并把级别应用到 window.DLLog，返回工具对象
export function bootLogging(deps) {
  const d = deps || {};
  if (d.logger) return loggerUtil(d.logger);
  const win = d.win || (typeof window !== 'undefined' ? window : null);
  const dl = win && typeof win === 'object' ? win.DLLog : null;
  if (!dl || typeof dl.setLevel !== 'function') return noopUtil();

  const storage = d.storage || (win.localStorage || null);
  const prefs = readLogPrefs(storage);
  const url = parseLogParam(urlLogParam(win.location ? win.location.search : ''));

  // 级别：URL 显式 > logPrefs > 默认 debug（开发期，§2.2）；逐调用守卫（部分桩对象不抛）
  const level = url.level || prefs.level || 'debug';
  if (typeof dl.setLevel === 'function') dl.setLevel(level);
  // 通道：默认 render:trace < logPrefs.channels < URL 通道覆盖
  const channels = { render: 'trace', ...(prefs.channels || {}), ...url.channels };
  if (typeof dl.setChannelLevel === 'function') {
    for (const [ch, lv] of Object.entries(channels)) dl.setChannelLevel(ch, lv);
  }

  return {
    debug: (c, e, m, x) => dl.debug(c, e, m, x),
    info: (c, e, m, x) => dl.info(c, e, m, x),
    warn: (c, e, m, x) => dl.warn(c, e, m, x),
    error: (c, e, m, x) => dl.error(c, e, m, x),
    trace: (c, e, m, x) => dl.trace(c, e, m, x),
    setLevel: (l) => dl.setLevel(l),
    setChannelLevel: (c, l) => dl.setChannelLevel(c, l),
    dump: () => dl.dump(),
    records: () => dl.records,
  };
}

// 默认单例：模块加载即完成引导（app.js import 即生效）
export const log = bootLogging();
