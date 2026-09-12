'use strict';
// tests/helpers/gen.js —— 种子化生成器（契约见 tests/README.md「tests/helpers/gen.js 契约」）
// 零依赖、自包含：mulberry32 标准算法 + fnv1a 变体散列。
// 与 server/core/rng.js（B1）相互独立：测试不得与被测实现共享随机实现。
// 确定性：同 seed 同调用序列 → 完全相同序列；seed 归一化为 uint32（缺失/非法视为 0）。

function normalizeSeed(seed) {
  const n = Number(seed);
  return (Number.isFinite(n) ? n : 0) >>> 0;
}

// 标准 mulberry32：返回 () => [0,1) 浮点流（seed 锁定，2026-09-12 独立实现复算一致）
function mulberry32(seed) {
  let a = normalizeSeed(seed);
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// fnv1a 变体：字符串 → uint32（deriveStream 的派生散列；tick/purpose 拼入输入）
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 种子化生成器：单条流按调用顺序推进；deriveStream 为纯函数派生（不消耗父流，D-91 对齐）
function createGen(seed) {
  const next = mulberry32(seed);
  const base = normalizeSeed(seed);
  return {
    // [lo, hi) 均匀浮点
    float(lo = 0, hi = 1) {
      return lo + (hi - lo) * next();
    },
    // 闭区间均匀整数 [lo, hi]
    int(lo, hi) {
      if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo > hi) {
        throw new RangeError(`int(${lo},${hi}) 需要整数区间且 lo<=hi`);
      }
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    // 非空数组均匀取一
    pick(arr) {
      if (!Array.isArray(arr) || arr.length === 0) {
        throw new RangeError('pick 需要非空数组');
      }
      return arr[Math.floor(next() * arr.length)];
    },
    // 概率 [0,1] 布尔
    chance(p) {
      if (!(p >= 0 && p <= 1)) {
        throw new RangeError(`chance(${p}) 需要在 [0,1]`);
      }
      return next() < p;
    },
    // Fisher–Yates 洗牌，返回新数组（不修改入参）
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = out[i];
        out[i] = out[j];
        out[j] = tmp;
      }
      return out;
    },
    // 派生流：hash(seed, tick, purpose) → 新 createGen（对齐 D-91 每 tick 每用途派生）
    deriveStream(tick, purpose) {
      return createGen(hash32(`${base}:${tick}:${purpose}`));
    },
  };
}

module.exports = { mulberry32, createGen, hash32 };