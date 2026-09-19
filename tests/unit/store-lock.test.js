'use strict';
/* tests/unit/store-lock.test.js —— 单进程锁（D-129 §3.4/§6.5；T-ST-6 的进程内等价验证）
 * 沙箱禁止 child_process，无法真起第二个进程；等价替代 = 直接构造锁文件（存活 PID / 已死 PID）再调用 acquireLock。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lockMod = require('../../server/store/lock.js');
const { nullLogger } = require('../../shared/log.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-lock-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

// 必然不存活的 PID（超出常见 pid_max，ESRCH）
const DEAD_PID = 3999999;

test('LOCK-1 acquire 写入 {pid,at,version}；release 只删自己的锁；重复 release 返回 false', () => {
  const dir = mkTmp();
  try {
    const lock = lockMod.acquireLock({ dataDir: dir, logger: nullLogger, now: () => 1234 });
    assert.equal(lock.file, path.join(dir, 'lock'));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.acquiredAt, 1234);
    assert.equal(lock.isHeld(), true);
    const body = JSON.parse(fs.readFileSync(lock.file, 'utf8'));
    assert.deepEqual(body, { version: 1, pid: process.pid, at: 1234 });
    assert.equal(lock.release(), true);
    assert.equal(fs.existsSync(lock.file), false);
    assert.equal(lock.release(), false, '重复 release 幂等');
    assert.equal(lock.isHeld(), false);
  } finally {
    rmTmp(dir);
  }
});

test('LOCK-2 已有存活实例（同 PID）→ store_locked（exitCode 1 / fatal），不覆盖锁文件', () => {
  const dir = mkTmp();
  try {
    const first = lockMod.acquireLock({ dataDir: dir, logger: nullLogger });
    const before = fs.readFileSync(first.file, 'utf8');
    const errors = [];
    const logger = { error: (ch, ev) => errors.push({ ch, ev }), info: () => {}, debug: () => {}, warn: () => {}, trace: () => {}, log: () => {} };
    assert.throws(() => lockMod.acquireLock({ dataDir: dir, logger }),
      (e) => e.code === 'store_locked' && e.exitCode === 1 && e.fatal === true);
    assert.equal(fs.readFileSync(first.file, 'utf8'), before, '拒绝启动时不改写锁');
    assert.deepEqual(errors, [{ ch: 'store', ev: 'store.error' }]);
    first.release();
  } finally {
    rmTmp(dir);
  }
});

test('LOCK-3 陈旧锁（PID 已不存活）→ 记 store.recover 并接管', () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'lock');
    fs.writeFileSync(file, JSON.stringify({ version: 1, pid: DEAD_PID, at: 1 }), 'utf8');
    const events = [];
    const logger = { info: (ch, ev, msg, data) => events.push({ ch, ev, data }), error: () => {}, debug: () => {}, warn: () => {}, trace: () => {}, log: () => {} };
    const lock = lockMod.acquireLock({ dataDir: dir, logger, now: () => 9 });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
    assert.equal(events[0].ev, 'store.recover');
    assert.equal(events[0].data.stalePid, DEAD_PID);
    lock.release();
  } finally {
    rmTmp(dir);
  }
});

test('LOCK-4 锁文件损坏/非法 pid → 视为可接管；release 不删他人的锁', () => {
  const dir = mkTmp();
  try {
    const file = path.join(dir, 'lock');
    fs.writeFileSync(file, '{not-json', 'utf8');
    const lock = lockMod.acquireLock({ dataDir: dir, logger: nullLogger });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
    // 模拟"锁已被别的进程接管"（PID 变更）→ release 不得删除
    fs.writeFileSync(file, JSON.stringify({ version: 1, pid: DEAD_PID, at: 2 }), 'utf8');
    assert.equal(lock.release(), false);
    assert.equal(fs.existsSync(file), true);
    assert.equal(lock.isHeld(), false);
    // 缺 dataDir → store_internal
    assert.throws(() => lockMod.acquireLock({}), (e) => e.code === 'store_internal');
  } finally {
    rmTmp(dir);
  }
});

test('LOCK-5 isProcessAlive：自身存活、非法 PID/0 视为不存活', () => {
  assert.equal(lockMod.isProcessAlive(process.pid), true);
  assert.equal(lockMod.isProcessAlive(DEAD_PID), false);
  assert.equal(lockMod.isProcessAlive(0), false);
  assert.equal(lockMod.isProcessAlive(-1), false);
  assert.equal(lockMod.isProcessAlive('x'), false);
  assert.equal(lockMod.isProcessAlive(1.5), false);
  assert.equal(lockMod.LOCK_FILE, 'lock');
  assert.ok(lockMod.lockPathOf('D:/x').endsWith('lock'));
});
