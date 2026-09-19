'use strict';
/* server/store/lock.js —— 单进程锁（D-129 §3.4/§6.5；`runtime/lock`）
 * 语义：写入 {pid, at, version}；已有实例且 **PID 存活** → 拒绝（抛 StoreError('store_locked')，exitCode=1）。
 *      PID 已不存活（陈旧锁，如强杀残留）→ 记 store.recover(info) 并接管。
 * 约束：本层**不调 process.exit**；调用方（server/index.js，B28+）按 err.exitCode 决定退出码。
 * 依赖：node:fs/path（唯一允许 fs 的目录）、同层 fsatomic。
 */
const path = require('node:path');
const { nullLogger } = require('../../shared/log.js');
const { StoreError } = require('./errors.js');
const fsatomic = require('./fsatomic.js');

const LOCK_FILE = 'lock';

function lockPathOf(dataDir) {
  return path.join(dataDir, LOCK_FILE);
}

// PID 存活检测：同进程 → 存活；EPERM（存在但无权限）→ 存活；ESRCH → 不存活
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function acquireLock(options) {
  const opts = options || {};
  const dataDir = opts.dataDir;
  if (!dataDir) throw new StoreError('store_internal', 'lock 需要 dataDir');
  const log = opts.logger || nullLogger;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const file = lockPathOf(dataDir);
  fsatomic.ensureDir(dataDir);
  const existing = fsatomic.readJsonSync(file, null);
  if (existing && Number.isInteger(existing.pid)) {
    if (isProcessAlive(existing.pid)) {
      const err = new StoreError('store_locked',
        `运行时目录已被进程 ${existing.pid} 占用（单进程锁 ${file}）；请先停止该进程`,
        [{ path: file, code: 'store_locked', message: `pid=${existing.pid} 存活` }],
        { exitCode: 1, fatal: true });
      log.error('store', 'store.error', err.message, { file, pid: existing.pid });
      throw err;
    }
    log.info('store', 'store.recover', `接管陈旧单进程锁（pid ${existing.pid} 已不存活）`, {
      file, stalePid: existing.pid,
    });
  }
  const payload = { version: 1, pid: process.pid, at: nowFn() };
  fsatomic.writeJsonAtomicSync(file, payload, { logger: log });
  let released = false;
  return {
    file,
    pid: process.pid,
    acquiredAt: payload.at,
    release() {
      if (released) return false;
      released = true;
      const current = fsatomic.readJsonSync(file, null);
      if (current && current.pid === process.pid) {
        fsatomic.removeFile(file);
        return true;
      }
      return false;
    },
    isHeld() {
      return !released;
    },
  };
}

module.exports = { LOCK_FILE, lockPathOf, isProcessAlive, acquireLock };
