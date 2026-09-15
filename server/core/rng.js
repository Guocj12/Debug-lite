'use strict';
/* server/core/rng.js —— 种子随机数生成器（P1 B1，契约 docs/interfaces.md §1）
 * 依据：decisions D-90（每局一条全局种子）/ D-91（每 tick 每用途派生流 hash(seed,tick,purpose)）/ D-92（引擎禁 Math.random）。
 * 纯函数内核（L11）：无 IO / 无 Math.random / 无 console；日志经 options.logger 注入（缺省 nullLogger）。
 * 实现：mulberry32（v3-design §15.1）+ fnv1a 变体（deriveStream 派生散列）。
 * 与 tests/helpers/gen.js 相互独立（测试不得与被测实现共享随机实现）。
 */
const { nullLogger } = require('../../shared/log.js');

// 种子归一化：有限数 → uint32；缺失/非法 → 0
function normalizeSeed(seed) {
  const n = Number(seed);
  return (Number.isFinite(n) ? n : 0) >>> 0;
}

// fnv1a 变体：字符串 → uint32（deriveStream 派生散列；tick/purpose 拼入输入）
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// mulberry32 流：a 为可序列化内部状态（state/restore 直接读写它 → 往返后序列完全一致，R-8）
function createStream(seed) {
  let a = normalizeSeed(seed);
  const next = function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    get: () => a,
    set: (v) => { a = v >>> 0; },
  };
}

// createRng(seed, {logger}) → rng：单条确定流 + state/restore + deriveStream（纯函数派生）
function createRng(seed, options) {
  const opts = options || {};
  const logger = opts.logger || nullLogger;
  const stream = createStream(seed);
  const base = normalizeSeed(seed);

  const rng = {
    // [lo, hi) 均匀浮点；purpose 为可选尾参（日志标注；用途隔离走 deriveStream，D-91）
    float(lo, hi, purpose) {
      const p = purpose === undefined ? 'default' : String(purpose);
      const v = stream.next();
      logger.trace('rng', 'rng.draw', `float(${p}) = ${v}`, { purpose: p, value: v });
      const low = lo === undefined ? 0 : lo;
      const high = hi === undefined ? 1 : hi;
      return low + (high - low) * v;
    },
    // 闭区间均匀整数 [lo, hi]
    int(lo, hi, purpose) {
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
        throw new RangeError(`int(${lo},${hi}) 需要整数区间且 lo<=hi`);
      }
      const p = purpose === undefined ? 'default' : String(purpose);
      const v = stream.next();
      logger.trace('rng', 'rng.draw', `int(${p}) = ${v}`, { purpose: p, value: v });
      return lo + Math.floor(v * (hi - lo + 1));
    },
    // 非空数组均匀取一
    pick(arr, purpose) {
      if (!Array.isArray(arr) || arr.length === 0) {
        throw new RangeError('pick 需要非空数组');
      }
      const p = purpose === undefined ? 'default' : String(purpose);
      const v = stream.next();
      logger.trace('rng', 'rng.draw', `pick(${p}) = ${v}`, { purpose: p, value: v });
      return arr[Math.floor(v * arr.length)];
    },
    // 概率 [0,1] 布尔
    chance(p, purpose) {
      if (!(p >= 0 && p <= 1)) {
        throw new RangeError(`chance(${p}) 需要在 [0,1]`);
      }
      const pn = purpose === undefined ? 'default' : String(purpose);
      const v = stream.next();
      logger.trace('rng', 'rng.draw', `chance(${pn}) = ${v}`, { purpose: pn, value: v });
      return v < p;
    },
    // 纯函数派生：hash(base:tick:purpose) → 新独立 rng（不消耗本流，D-91）
    deriveStream(tick, purpose) {
      logger.debug('rng', 'rng.stream', `derive tick=${tick} purpose=${purpose}`, { tick, purpose });
      return createRng(hash32(`${base}:${tick}:${purpose}`));
    },
    // 可序列化状态（AiContext 序列化精神；JSON 往返安全，R-8）
    state() {
      return { seed: base, a: stream.get() };
    },
    restore(s) {
      const st = s || {};
      stream.set(Number.isFinite(st.a) ? st.a : base);
      return rng;
    },
  };
  logger.info('rng', 'rng.create', `seed=${base}`, { seed: base });
  return rng;
}

module.exports = { createRng, normalizeSeed, hash32 };