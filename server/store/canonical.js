'use strict';
/* server/store/canonical.js —— canonical JSON、内容 hash、深拷贝（D-129 §5.4/§6.6.5/§9.1）
 * canonical = 键排序 + 无空白：快照 hash 与 battleId 必须可复现（同内容 → 同 hash）。
 * 依赖：仅 node:crypto（L6 允许外部模块；本目录是唯一允许 node:fs 的目录，本文件不用 fs）。
 */
const crypto = require('node:crypto');

// 键排序递归（数组顺序保留，undefined 字段剔除）
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sha256Hex(data) {
  const input = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return crypto.createHash('sha256').update(input).digest('hex');
}

// 'sha256:' + hex —— 统一 id 形状（§5.4 hash / §9.1 battleId 之外的 configHash）
function contentHash(value) {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}

// 前 len 个 hex（battleId = sha256(...)[0..16]，§9.1）
function shortDigest(value, len) {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  return sha256Hex(text).slice(0, len === undefined ? 16 : len);
}

function deepClone(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

// 去掉 'sha256:' 前缀 → 纯 hex（文件名/分片目录用；Windows 文件名不允许 ':'）
function digestOf(hash) {
  return String(hash).replace(/^sha256:/, '');
}

function isHash(value) {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

module.exports = { sortValue, canonicalJson, sha256Hex, contentHash, shortDigest, deepClone, digestOf, isHash };
