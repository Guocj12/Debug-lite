// util/log.js —— 前端日志封装（frontend-spec §2；window.DLLog 由 shared/log.js UMD 提供）
// 环境无关：node（测试）无 window 时注入 logger 或使用 noop 兜底；浏览器经 URL ?log= 与 localStorage.logPrefs 引导。
export function createFrontLog(win, opts) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  const raw = (w && w.DLLog) || null;
  const injected = (opts && opts.logger) || null;
  const sink = (opts && opts.sink) || null; // 记录收集器（测试/日志面板）
  let logger = injected;
  if (!logger && raw) {
    let level = 'all';
    // F0 P2-2：?log= 与 localStorage 各自独立 try（localStorage 异常不吞并 URL 引导）
    let q = null;
    try {
      q = w.location && new URL(w.location.href).searchParams.get('log');
      if (q) level = q;
    } catch (e) { /* 解析失败保持默认 */ }
    let prefs = null;
    try {
      // F1 P1-5：与 store/persist 同为 dl.v3.logPrefs（spec §4.3 权威；§2.4 措辞漂移已登记）
      const local = w.localStorage && w.localStorage.getItem('dl.v3.logPrefs');
      if (local) prefs = JSON.parse(local);
    } catch (e) { /* localStorage 不可用/损坏 → 保持 */ }
    if (prefs && prefs.level) level = prefs.level; // localStorage 优先（F0 审查确认语义）
    const lv = raw.parseLevel ? raw.parseLevel(level) : null;
    logger = raw.createLogger({ level: lv === null ? 'all' : lv, ringSize: 3000, onRecord: (r) => { if (sink) sink.push(r); } });
    // 调试出口（§2.4「总控与导出」）：环形缓冲需可从控制台/自动化读取——`window.DLLog.instance.dump()`。
    // 缺此出口时页面日志只在闭包内，外部（含 AI 调试器）无法取到 → 无法按 §10.1 排障。
    raw.instance = logger;
  }
  if (!logger) {
    // node 无 DLLog 且未注入：noop 兜底（保持方法面）
    const noop = () => {};
    logger = { fatal: noop, error: noop, warn: noop, info: noop, debug: noop, trace: noop, log: noop, setLevel: noop, setChannelLevel: noop };
  }
  const wrap = (name) => (channel, event, msg, data) => {
    if (logger[name]) logger[name](channel, event, msg, data);
  };
  return {
    fatal: wrap('fatal'), error: wrap('error'), warn: wrap('warn'), info: wrap('info'),
    debug: wrap('debug'), trace: wrap('trace'),
    log: (level, channel, event, msg, data) => {
      if (logger.log) logger.log(level, channel, event, msg, ...(data !== undefined ? [data] : []));
    },
    setLevel: (l) => { if (logger.setLevel) logger.setLevel(l); },
    setChannelLevel: (ch, lv) => { if (logger.setChannelLevel) logger.setChannelLevel(ch, lv); },
    raw: logger,
  };
}

export const log = createFrontLog();