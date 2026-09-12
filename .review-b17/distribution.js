'use strict';
/* .review-b17/distribution.js —— B17 独立复算：rollQuality(tier) 截断后概率语义
 * 问题：B17 交付要求「截断品质池后按 dropRates 重归一加权」（D-122/RK-5）。
 * 本脚本用大样本实测 rollQuality 的实际分布，并与两种模型对比：
 *   模型A（要求语义）：P(t) = rate(t) / Σ_{t∈pool} rate(t)          （重归一）
 *   模型B（现状语义）：P(t) = rate(t)，残量 1-Σ 全部落入池顶（tail 兜底）  （截断不归一）
 * 同时复算无 tier 参数（B3 回归）是否与 dropRates 一致。
 */
const items = require('../server/core/items.js');
const { createRng } = require('../server/core/rng.js');

const RATES = require('../server/data/items-config.json').dropRates;
const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const N = 400000;

function sample(tier) {
  const rng = createRng(987654321);
  const counts = {};
  const rq = tier === undefined ? items.rollQuality : (r) => items.rollQuality(r, tier);
  for (let i = 0; i < N; i++) {
    const q = rq(rng);
    counts[q] = (counts[q] || 0) + 1;
  }
  const out = {};
  for (const t of TIERS) out[t] = (counts[t] || 0) / N;
  return out;
}

function renorm(tier) {
  const pool = TIERS.slice(0, TIERS.indexOf(tier) + 1);
  const total = pool.reduce((a, t) => a + RATES[t], 0);
  const out = {};
  for (const t of TIERS) out[t] = pool.includes(t) ? RATES[t] / total : 0;
  return out;
}

function rawWithTail(tier) {
  const pool = TIERS.slice(0, TIERS.indexOf(tier) + 1);
  const out = {};
  let acc = 0;
  for (const t of TIERS) out[t] = 0;
  for (const t of pool) { out[t] = RATES[t]; acc += RATES[t]; }
  out[pool[pool.length - 1]] += 1 - acc; // 残量落入池顶
  return out;
}

function maxDev(a, b) {
  let d = 0;
  for (const t of TIERS) d = Math.max(d, Math.abs(a[t] - b[t]));
  return d;
}

console.log('== 实测分布（N=' + N + '） vs 模型A（重归一） vs 模型B（截断不归一+残量落顶）==');
for (const tier of ['common', 'rare', 'epic', 'legendary', 'mythic']) {
  const actual = sample(tier);
  const A = renorm(tier);
  const B = rawWithTail(tier);
  const devA = maxDev(actual, A);
  const devB = maxDev(actual, B);
  console.log(`tier=${tier}`);
  console.log(`  实测       ${TIERS.map((t) => `${t}:${(actual[t] * 100).toFixed(2)}%`).join(' ')}`);
  console.log(`  模型A重归一 ${TIERS.map((t) => `${t}:${(A[t] * 100).toFixed(2)}%`).join(' ')}  → 最大偏差 ${(devA * 100).toFixed(2)}pp`);
  console.log(`  模型B截断   ${TIERS.map((t) => `${t}:${(B[t] * 100).toFixed(2)}%`).join(' ')}  → 最大偏差 ${(devB * 100).toFixed(2)}pp`);
}
console.log('');
console.log('== B3 回归：无 tier 参数 ==');
{
  const actual = sample(undefined);
  let md = 0;
  for (const t of TIERS) md = Math.max(md, Math.abs(actual[t] - RATES[t]));
  console.log(`无 tier 实测 vs dropRates：最大偏差 ${(md * 100).toFixed(3)}pp（<2pp 即 T-IT-1 基线保持）`);
}