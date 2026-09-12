'use strict';
/* shared/log.js —— 零依赖 UMD 日志（P0-4）
 * 契约：shared/README.md（接口冻结处；P0-7 汇总进 docs/interfaces.md）
 * 约束：自身不得 IO（无 fs/net/console/stdout）——IO 由 server/cli 层经 onRecord sink 完成；
 *       core 只使用注入的 logger（缺省 nullLogger），日志不得影响战斗结果（T-LG-5）。
 */
(function (root, factory) {
  const api = factory();
  const isNode = typeof module === 'object' && typeof module.exports === 'object';
  if (isNode) {
    module.exports = api;
  } else {
    root.DLLog = api; // 浏览器 / worker 全局
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LEVELS = Object.freeze({
    silent: -1, fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5, all: 99,
  });
  const LEVEL_NAME_BY_VALUE = Object.freeze(
    Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [v, k]))
  );

  const CHANNELS = Object.freeze([
    'rng', 'field', 'effects', 'items', 'roles', 'skills', 'bullets', 'engine',
    'damage', 'ai.ast', 'ai.runtime', 'unlock', 'api', 'cli', 'ranked',
    'store', 'view', 'render', 'editor', 'perf', 'log',
  ]);
  const CHANNEL_SET = new Set(CHANNELS);

  // 名字（大小写不敏感）或数字串 → 数值；其余（含非法）→ null
  function parseLevel(str) {
    if (typeof str !== 'string') return null;
    const k = str.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(LEVELS, k)) return LEVELS[k];
    if (/^-?\d+$/.test(k)) {
      const n = Number(k);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  // "bullets=trace,ai.runtime=debug" → {channel: 数值}；空/畸形段跳过
  function parseChannelOverrides(str) {
    const out = {};
    if (typeof str !== 'string' || str.trim() === '') return out;
    for (const part of str.split(',')) {
      const seg = part.trim();
      if (seg === '') continue;
      const eq = seg.indexOf('=');
      if (eq <= 0) continue;
      const channel = seg.slice(0, eq).trim();
      const lv = parseLevel(seg.slice(eq + 1).trim());
      if (channel === '' || lv === null) continue;
      out[channel] = lv;
    }
    return out;
  }

  function env(name) {
    if (typeof process === 'object' && process !== null &&
        typeof process.env === 'object' && process.env !== null) {
      return process.env[name];
    }
    return undefined;
  }

  function normalizeLevel(level) {
    if (typeof level === 'string') {
      const n = parseLevel(level);
      if (n !== null) return n;
      return null;
    }
    if (typeof level === 'number' && Number.isFinite(level)) return level;
    return null;
  }

  function nameOf(value) {
    return Object.prototype.hasOwnProperty.call(LEVEL_NAME_BY_VALUE, value)
      ? LEVEL_NAME_BY_VALUE[value]
      : String(value);
  }

  function resolveDefaultLevel() {
    const envLv = parseLevel(env('DL_LOG_LEVEL'));
    if (envLv !== null) return envLv;
    return env('NODE_ENV') === 'production' ? LEVELS.warn : LEVELS.debug;
  }

  function createLogger(options) {
    const opts = options || {};
    let initialLevel;
    if (opts.level === undefined || opts.level === null) {
      initialLevel = resolveDefaultLevel(); // env DL_LOG_LEVEL → NODE_ENV 默认
    } else {
      initialLevel = normalizeLevel(opts.level);
      if (initialLevel === null) {
        throw new RangeError(`createLogger: 非法级别 ${opts.level}`);
      }
    }
    const ringSize = (Number.isInteger(opts.ringSize) && opts.ringSize > 0) ? opts.ringSize : 2000;
    const sink = typeof opts.onRecord === 'function' ? opts.onRecord : null;
    const now = typeof opts.now === 'function' ? opts.now : function () { return Date.now(); };

    const channelOverrides = new Map();
    if (opts.channels !== undefined && opts.channels !== null) {
      for (const ch of Object.keys(opts.channels)) {
        const n = normalizeLevel(opts.channels[ch]);
        if (n === null) throw new RangeError(`createLogger: 非法通道级别 ${ch}=${opts.channels[ch]}`);
        channelOverrides.set(ch, n);
      }
    }

    let level = initialLevel;
    let seq = 0;
    let dropped = 0;
    let lastSuppressedBoundary = 0;
    const warnedUnknown = new Set();
    const records = [];

    function effective(channel) {
      return channelOverrides.has(channel) ? channelOverrides.get(channel) : level;
    }

    // 过滤之后才调用；data 的 cid/tick 提升到记录顶层
    function emit(lv, channel, event, msg, data) {
      const record = {
        seq: seq++, ts: now(), cid: null, tick: null,
        level: nameOf(lv), levelValue: lv, channel, event, msg, data: {},
      };
      if (data !== undefined && data !== null && typeof data === 'object') {
        if (Object.prototype.hasOwnProperty.call(data, 'cid')) record.cid = data.cid;
        if (Object.prototype.hasOwnProperty.call(data, 'tick')) record.tick = data.tick;
        for (const k of Object.keys(data)) {
          if (k !== 'cid' && k !== 'tick') record.data[k] = data[k];
        }
      }
      records.push(record);
      if (records.length > ringSize) {
        records.shift();
        dropped += 1;
        const boundary = Math.floor(dropped / 100) * 100;
        if (boundary > lastSuppressedBoundary && boundary >= 100) {
          lastSuppressedBoundary = boundary;
          // 递归入口在 boundary 处不会再次触发（lastSuppressedBoundary 已更新）
          emit('warn', 'log', 'log.suppressed',
            `环形缓冲溢出已达 ${boundary} 条（ring=${ringSize}）`,
            { dropped, ringSize });
        }
      }
      if (sink) sink(record);
    }

    function log(levelArg, channel, event, msg, data) {
      const lv = normalizeLevel(levelArg);
      if (lv === null) throw new RangeError(`非法日志级别 ${levelArg}`);
      if (typeof channel !== 'string' || channel === '') throw new RangeError('channel 必须是非空字符串');
      if (typeof event !== 'string' || event === '') throw new RangeError('event 必须是非空字符串');
      if (lv > effective(channel)) return false;
      if (!CHANNEL_SET.has(channel) && !warnedUnknown.has(channel)) {
        warnedUnknown.add(channel);
        emit(LEVELS.warn, 'log', 'log.unknownChannels', `未注册通道 "${channel}"`, { channel });
      }
      emit(lv, channel, event, msg === undefined ? '' : String(msg), data);
      return true;
    }

    const api = {
      on(channel, levelArg) {
        const lv = normalizeLevel(levelArg);
        if (lv === null) throw new RangeError(`非法日志级别 ${levelArg}`);
        return lv <= effective(channel);
      },
      log,
      fatal: (channel, event, msg, data) => log('fatal', channel, event, msg, data),
      error: (channel, event, msg, data) => log('error', channel, event, msg, data),
      warn: (channel, event, msg, data) => log('warn', channel, event, msg, data),
      info: (channel, event, msg, data) => log('info', channel, event, msg, data),
      debug: (channel, event, msg, data) => log('debug', channel, event, msg, data),
      trace: (channel, event, msg, data) => log('trace', channel, event, msg, data),
      setLevel(l) {
        const n = normalizeLevel(l);
        if (n === null) throw new RangeError(`非法日志级别 ${l}`);
        level = n;
      },
      setChannelLevel(channel, l) {
        const n = normalizeLevel(l);
        if (n === null) throw new RangeError(`非法日志级别 ${l}`);
        channelOverrides.set(channel, n);
      },
      getLevel() {
        return nameOf(level);
      },
      reset() {
        level = initialLevel;
        channelOverrides.clear();
        seq = 0;
        dropped = 0;
        lastSuppressedBoundary = 0;
        warnedUnknown.clear();
        records.length = 0;
      },
      dump() {
        return records.map((r) => ({ ...r, data: { ...r.data } }));
      },
      records,
      stats() {
        return { seq, dropped, records: records.length };
      },
    };
    return api;
  }

  const nullLogger = Object.freeze({
    on: () => false,
    log: () => false,
    fatal: () => {}, error: () => {}, warn: () => {}, info: () => {},
    debug: () => {}, trace: () => {},
    setLevel: () => {}, setChannelLevel: () => {}, reset: () => {},
    getLevel: () => 'silent',
    dump: () => [],
    records: Object.freeze([]),
    stats: () => ({ seq: 0, dropped: 0, records: 0 }),
  });

  return { LEVELS, CHANNELS, createLogger, nullLogger, parseLevel, parseChannelOverrides };
});