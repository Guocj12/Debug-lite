'use strict';
/* server/store/fsatomic.js —— 原子写与文件工具（D-129 §6.6；本目录是唯一允许 node:fs 的目录）
 * 原子写四步：① 写 <target>.tmp-<pid>-<rand> → fsync（内容先落盘）
 *             ② rename 覆盖（Windows 走 MoveFileEx(MOVEFILE_REPLACE_EXISTING)）
 *             ③ 父目录 fsync（POSIX 有效；Windows/不支持 → 忽略并记 store.write(debug)）
 *             ④ Windows 专属重试：EPERM/EACCES/EBUSY → 退避 5/20/80ms ×3；
 *                仍失败 → store_write_failed 并**保留临时文件**供排查（绝不写坏目标文件）
 * 说明：本实现的"异步"方法在内部使用同步 IO（单进程同步结算模型，§3.4）；
 *       Promise 签名只是为了契约统一，调用方 `await` 语义不受影响。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StoreError } = require('./errors.js');
const { canonicalJson } = require('./canonical.js');

const RENAME_RETRY_DELAYS_MS = Object.freeze([5, 20, 80]);
const WIN_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const TMP_MARK = '.tmp-';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pathExists(target) {
  try {
    fs.accessSync(target);
    return true;
  } catch (err) {
    return false;
  }
}

function statSafe(target) {
  try {
    return fs.statSync(target);
  } catch (err) {
    return null;
  }
}

function readText(target) {
  return fs.readFileSync(target, 'utf8');
}

function removeFile(target) {
  try {
    fs.unlinkSync(target);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

function renameSafe(from, to) {
  // 目标已存在时先删除（Windows 上 rename 覆盖偶发 EPERM 的兜底；正常路径不走到这里）
  try {
    fs.renameSync(from, to);
    return;
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EPERM') {
      removeFile(to);
      fs.renameSync(from, to);
      return;
    }
    throw err;
  }
}

function listDirFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function sleepSync(ms) {
  if (!(ms > 0)) return;
  // Atomics.wait 在 Node 主线程可用（实测 v24.18.0）；不需要 setTimeout、不产生悬挂句柄
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fsyncDir(dir, logger) {
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (err) {
    // POSIX 目录 fsync 有效；Windows 打开目录会 EPERM/EISDIR —— 按设计忽略并记 debug
    if (logger) {
      logger.debug('store', 'store.write', `父目录 fsync 跳过（${err.code || err.message}）`, { dir, code: err.code || null });
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (err) { /* 忽略关闭失败 */ }
    }
  }
}

function tmpPathFor(target) {
  return `${target}${TMP_MARK}${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
}

function wrapWriteError(err, phase, target) {
  if (err instanceof StoreError) return err;
  return new StoreError('store_write_failed', `${phase} 失败（${target}）: ${err.code || err.message}`, [
    { path: target, code: 'store_write_failed', message: err.code || err.message },
  ], { cause: err });
}

function renameWithRetrySync(tmp, target, logger) {
  let last = null;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      renameSafe(tmp, target);
      return;
    } catch (err) {
      last = err;
      const retryable = WIN_RETRY_CODES.has(err.code) && attempt < RENAME_RETRY_DELAYS_MS.length;
      if (!retryable) break;
      if (logger) {
        logger.debug('store', 'store.write', `rename 重试 ${attempt + 1}/${RENAME_RETRY_DELAYS_MS.length}（${err.code}）`, { target, code: err.code });
      }
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
  throw new StoreError('store_write_failed',
    `rename ${path.basename(tmp)} → ${path.basename(target)} 失败: ${last && (last.code || last.message)}（临时文件保留供排查）`,
    [{ path: target, code: 'store_write_failed', message: String(last && (last.code || last.message)) }],
    { cause: last });
}

// 原子写（同步实现；返回目标路径）
function writeFileAtomicSync(target, data, options) {
  const opts = options || {};
  const dir = path.dirname(target);
  ensureDir(dir);
  const tmp = tmpPathFor(target);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    if (opts.fsync !== false) fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (closeErr) { /* 忽略 */ }
    }
    throw wrapWriteError(err, 'write(tmp)', tmp);
  }
  try { fs.closeSync(fd); } catch (err) { /* 忽略 */ }
  renameWithRetrySync(tmp, target, opts.logger);
  if (opts.dirFsync !== false) fsyncDir(dir, opts.logger);
  return target;
}

function writeJsonAtomicSync(target, value, options) {
  const opts = options || {};
  const text = opts.canonical ? canonicalJson(value) : `${JSON.stringify(value, null, opts.pretty ? 2 : 0)}\n`;
  return writeFileAtomicSync(target, text, opts);
}

async function writeFileAtomic(target, data, options) {
  return writeFileAtomicSync(target, data, options);
}

async function writeJsonAtomic(target, value, options) {
  return writeJsonAtomicSync(target, value, options);
}

// 读取 JSON：失败时返回 fallback（未提供 fallback → 抛 store_corrupt）
function readJsonSync(target, fallback) {
  let text;
  try {
    text = fs.readFileSync(target, 'utf8');
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new StoreError('store_corrupt', `读取 ${target} 失败: ${err.code || err.message}`, [], { cause: err });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (fallback !== undefined) return fallback;
    throw new StoreError('store_corrupt', `${target} JSON 解析失败: ${err.message}`, [], { cause: err });
  }
}

// 清理崩溃残留的 *.tmp-*（只扫给定目录的第一层；不递归删除任何非 tmp 文件）
function sweepTmpSync(dir, logger) {
  let removed = 0;
  for (const entry of listDirFiles(dir)) {
    if (!entry.isFile() || !entry.name.includes(TMP_MARK)) continue;
    try {
      removeFile(path.join(dir, entry.name));
      removed += 1;
    } catch (err) {
      if (logger) logger.warn('store', 'store.error', `清理临时文件失败: ${entry.name}`, { code: err.code || null });
    }
  }
  if (removed > 0 && logger) {
    logger.debug('store', 'store.recover', `清理崩溃残留临时文件 ${removed} 个`, { dir, removed });
  }
  return removed;
}

module.exports = {
  RENAME_RETRY_DELAYS_MS,
  WIN_RETRY_CODES,
  TMP_MARK,
  ensureDir,
  pathExists,
  statSafe,
  readText,
  readJsonSync,
  removeFile,
  renameSafe,
  renameWithRetrySync,
  listDirFiles,
  fsyncDir,
  sleepSync,
  tmpPathFor,
  writeFileAtomicSync,
  writeJsonAtomicSync,
  writeFileAtomic,
  writeJsonAtomic,
  sweepTmpSync,
};
