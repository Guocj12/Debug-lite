'use strict';
/* tests/unit/store-branches.test.js —— 存储层边界分支补充（错误码/降级/清理/默认参数）
 * 目的：把 server/store 的分支覆盖率补到阈值以上（gate 项 7 阈值目录不含 server/store，但存量的
 * `npm run cov` 为**聚合**语义，避免新层拉低总量）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const errors = require('../../server/store/errors.js');
const fa = require('../../server/store/fsatomic.js');
const journalMod = require('../../server/store/journal.js');
const indexMod = require('../../server/store/index-file.js');
const snapMod = require('../../server/store/snapshot-store.js');
const ledger = require('../../server/store/ledger.js');
const { createStore } = require('../../server/store/index.js');
const { nullLogger } = require('../../shared/log.js');

const VERSIONS = { engine: '3.0.0', data: 'b25' };

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-branch-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function recorder() {
  const events = [];
  const push = (level) => (ch, ev, msg, data) => events.push({ level, ch, ev, msg, data });
  return {
    events,
    has: (ev) => events.some((e) => e.ev === ev),
    logger: {
      fatal: push('fatal'), error: push('error'), warn: push('warn'), info: push('info'),
      debug: push('debug'), trace: push('trace'), log: push('log'),
    },
  };
}

function loadout(tag) {
  return { role: { uid: `r_${tag}` }, skills: [{ uid: `s_${tag}` }], ai: { version: 2, tag } };
}

test('BR-1 errors：StoreError 映射/序列化/构造助手', () => {
  const e = new errors.StoreError('slot_limit', '满了');
  assert.equal(e.name, 'StoreError');
  assert.equal(e.code, 'slot_limit');
  assert.equal(e.status, 409);
  assert.equal(e.exitCode, 1);
  assert.equal(e.fatal, false);
  assert.deepEqual(e.details, []);
  assert.deepEqual(e.toJSON(), { code: 'slot_limit', message: '满了', details: [], status: 409 });
  const fatal = new errors.StoreError('store_corrupt');
  assert.equal(fatal.message, 'store_corrupt', '缺省 message = code');
  assert.equal(fatal.fatal, true);
  assert.equal(fatal.status, 500);
  const unknown = new errors.StoreError('custom_code', 'x', [{ path: 'p' }], { exitCode: 2, fatal: false, cause: new Error('root') });
  assert.equal(unknown.status, 500, '未登记错误码 → 500');
  assert.equal(unknown.exitCode, 2);
  assert.equal(unknown.fatal, false);
  assert.equal(unknown.cause.message, 'root');
  assert.equal(errors.storeError('bad_request', 'bad').code, 'bad_request');
  assert.equal(errors.isStoreError(new errors.StoreError('slot_limit')), true);
  assert.equal(errors.isStoreError(new Error('x')), false);
  assert.equal(errors.isStoreError(null), false);
  assert.deepEqual(errors.detail('code'), { path: '', code: 'code', message: 'code' });
  assert.deepEqual(errors.detail('code', 'msg', 'a.b'), { path: 'a.b', code: 'code', message: 'msg' });
  assert.equal(errors.FATAL_CODES.has('store_locked'), true);
  assert.equal(errors.STATUS_BY_CODE.store_not_found, 404);
});

test('BR-2 fsatomic：异步包装、fsyncDir 失败降级、listDirFiles 非目录抛错', async () => {
  const dir = mkTmp();
  try {
    const target = path.join(dir, 'a.json');
    await fa.writeJsonAtomic(target, { ok: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { ok: 1 });
    await fa.writeFileAtomic(target, 'raw');
    assert.equal(fs.readFileSync(target, 'utf8'), 'raw');
    // 不 fsync / 不 fsync 目录
    fa.writeFileAtomicSync(target, 'no-fsync', { fsync: false, dirFsync: false });
    assert.equal(fs.readFileSync(target, 'utf8'), 'no-fsync');
    // fsyncDir 失败路径（路径不存在）→ 记 debug 不抛错
    const log = recorder();
    fa.fsyncDir(path.join(dir, 'nope'), log.logger);
    assert.equal(log.events[0].ev, 'store.write');
    assert.equal(log.events[0].level, 'debug');
    fa.fsyncDir(path.join(dir, 'nope'), null); // 无 logger 也不抛
    // listDirFiles 指向文件 → 非 ENOENT 错误向上抛
    assert.throws(() => fa.listDirFiles(target));
  } finally {
    rmTmp(dir);
  }
});

test('BR-3 fsatomic：rename 遇 EPERM/EACCES/EBUSY → 退避重试；始终失败 → 保留 tmp 并报错', () => {
  const dir = mkTmp();
  const realRename = fs.renameSync;
  try {
    const target = path.join(dir, 'x.json');
    let calls = 0;
    fs.renameSync = (from, to) => {
      calls += 1;
      if (calls <= 2) {
        const err = new Error('locked');
        err.code = calls === 1 ? 'EPERM' : 'EBUSY';
        throw err;
      }
      return realRename(from, to);
    };
    const log = recorder();
    fa.writeFileAtomicSync(target, 'ok', { logger: log.logger });
    assert.equal(fs.readFileSync(target, 'utf8'), 'ok');
    assert.equal(calls, 3);
    assert.ok(log.events.some((e) => e.level === 'debug' && e.ev === 'store.write'), '重试要记 debug');
    // 始终失败（非重试码立刻失败）
    fs.renameSync = () => { const err = new Error('nope'); err.code = 'EXDEV'; throw err; };
    assert.throws(() => fa.writeFileAtomicSync(path.join(dir, 'y.json'), 'x'),
      (e) => e.code === 'store_write_failed');
    assert.ok(fs.readdirSync(dir).some((f) => f.includes('.tmp-')), '失败时保留临时文件供排查');
    fs.renameSync = realRename;
    // 重试耗尽（总是 EACCES）
    fs.renameSync = () => { const err = new Error('denied'); err.code = 'EACCES'; throw err; };
    assert.throws(() => fa.writeFileAtomicSync(path.join(dir, 'z.json'), 'x'),
      (e) => e.code === 'store_write_failed');
  } finally {
    fs.renameSync = realRename;
    rmTmp(dir);
  }
});

test('BR-4 journal：空 flush、默认区间、compact 无 aggregate、未 open 的 close', async () => {
  const dir = mkTmp();
  try {
    const j = journalMod.createJournal({ dir, logger: nullLogger, config: {} });
    await j.flush(); // 未 load：flush 不抛（无待写）
    j.load();
    await j.flush(); // 空缓冲
    assert.equal(j.stats().pending, 0);
    await j.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111', at: 0 });
    assert.equal(j.readAll().length, 1, 'readAll 无参默认全量');
    assert.equal(j.readAll({ fromSeq: 999 }).length, 0);
    const res = j.compact({ appliedSeq: j.maxSeq(), retentionDays: 0, at: Date.UTC(2100, 0, 1) });
    assert.equal(res.compacted.length, 1);
    await j.close();
    await j.close(); // 二次 close 幂等
    const fresh = journalMod.createJournal({ dir: path.join(dir, 'other'), logger: nullLogger, config: {} });
    await fresh.close(); // 未 load 的 close
    assert.equal(fresh.isOpen(), false);
  } finally {
    rmTmp(dir);
  }
});

test('BR-5 adapter：缺失档案的记录 → missing（记 store.error）；空批 apply 不动索引', async () => {
  const dir = mkTmp();
  const log = recorder();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: log.logger });
  try {
    await store.open();
    const rec = await store.append({ type: 'player.pool.changed', at: 1, playerId: 'pl_7777777777777777' });
    const res = await store.applyRecord(rec);
    assert.equal(res.applied, 0);
    assert.ok(log.has('store.error'), '无法创建的档案要记 store.error');
    assert.equal(await store.loadArchive('pl_7777777777777777'), null);
    const empty = await store.applyRecords([]);
    assert.deepEqual(empty, { applied: 0, count: 0 });
    // 未 open 的 store：close 幂等
    assert.equal(await createStore({ dataDir: path.join(dir, 'x'), logger: nullLogger }).close(), false);
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('BR-6 adapter：出战槽无 loadout（快照正文缺失）→ 新建槽报 loadout_invalid', async () => {
  const dir = mkTmp();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
  try {
    await store.open();
    const snap = store.freezeSnapshot(loadout('ghost'));
    await store.close();
    // 删除快照正文 → 新开的 store 缓存为空，引用仍在但正文不可用（模拟快照被 GC/人为删除）
    const hex = require('../../server/store/canonical.js').digestOf(snap.hash);
    fs.rmSync(path.join(dir, 'snapshots', hex.slice(0, 2), `${hex}.json`));
    const store2 = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
    await store2.open();
    const acc = await store2.createAccount({
      username: 'ghost', nickname: 'ghost', auth: { hash: 'g' },
      slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS },
    });
    assert.equal(acc.configs.slots[0].loadout, null, '快照正文缺失 → loadout 缺失（结构仍在）');
    await assert.rejects(() => store2.createConfigSlot({ playerId: acc.playerId, name: '复制' }),
      (e) => e.code === 'loadout_invalid');
    // 激活仍可行（快照 hash 引用有效，仅正文暂缺 → 由回放/实例化侧判 replay_expired / no_active_config）
    const activated = await store2.activateConfigSlot({ playerId: acc.playerId, slotId: 'slot1' });
    assert.equal(activated.archive.configs.activeSnapshotHash, snap.hash);
    await store2.close();
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('BR-7 snapshot-store：GC 遇到损坏正文按 0 时间戳处理；index 默认 scope', () => {
  const dir = mkTmp();
  try {
    const store = snapMod.createSnapshotStore({ dir, logger: nullLogger, config: {} });
    const snap = snapMod.buildSnapshot({ loadout: { role: 1 }, frozenAt: 5000, engineVersion: '3.0.0', dataVersion: 'b25' });
    store.put(snap);
    fs.writeFileSync(snapMod.snapshotPath(dir, snap.hash), '{broken', 'utf8');
    const res = store.gc({ retentionDays: 0, at: 6000 });
    assert.deepEqual(res.removed, [snap.hash], '损坏正文（frozenAt 视为 0）在超期后清理');
    const idx = indexMod.createIndex({ logger: nullLogger });
    assert.deepEqual(idx.leaderboard({}), []);
    assert.deepEqual(idx.leaderboard(), [], '无参 → 默认 global/50');
  } finally {
    rmTmp(dir);
  }
});

test('BR-8 ledger：平铺配置对象、非 half_up 舍入、未知结果按平局处理', () => {
  const flat = { cap: 3000, scale: 400, kBase: 32, kMin: 8, kMax: 64, drawFactor: 0.5, rounding: 'round' };
  assert.equal(ledger.expectedScore(0, 0, flat), 0.5);
  const win = ledger.ratingDelta({ points: 100, opponentPoints: 100, result: 'win', config: flat });
  assert.equal(win.k, ledger.gainFactor(100, flat));
  const weird = ledger.ratingDelta({ points: 100, opponentPoints: 100, result: 'nonsense', config: flat });
  assert.equal(weird.delta, 0, '未知结果 → 平局分支');
  const noCfg = ledger.ratingDelta({ points: 0, opponentPoints: 0, result: 'win' });
  assert.equal(noCfg.delta, 16, '无配置 → 内置默认参数');
  const p = ledger.promoteAfterBatch({ tier: 'common', wins: 7 });
  assert.equal(p.threshold, 6);
  assert.equal(ledger.roundBy(-2.5, 'half_up'), -3);
  assert.equal(ledger.roundBy(-2.5, 'round'), -2);
});

test('BR-9 adapter：snapshot.gc 的 retain 与 require 缺失路径；compactJournal 默认参数', async () => {
  const dir = mkTmp();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
  try {
    await store.open();
    const snap = store.freezeSnapshot(loadout('gc'));
    assert.equal(store.snapshot.require(`sha256:${'0'.repeat(64)}`), null);
    const gc = store.snapshot.gc(); // 使用配置默认 retentionDays
    assert.equal(Array.isArray(gc.removed), true);
    const compacted = store.compactJournal(); // 默认参数
    assert.ok(Array.isArray(compacted.compacted));
    assert.equal(store.snapshot.has(snap.hash), true);
    const listed = store.snapshot.refCounts();
    assert.equal(typeof listed, 'object');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('BR-10 session-table：空表 save/list/all 与默认配置', () => {
  const dir = mkTmp();
  try {
    const t = require('../../server/store/session-table.js').createSessionTable({
      file: path.join(dir, 'sessions.json'), logger: nullLogger,
    });
    assert.equal(t.maxPerPlayer, 5, '缺配置 → 默认 5');
    assert.equal(t.save(), 0);
    assert.deepEqual(t.list('pl_1111111111111111'), []);
    assert.deepEqual(t.all(), []);
    assert.deepEqual(t.prune().removed, 0);
    assert.throws(() => require('../../server/store/session-table.js').createSessionTable({}), (e) => e.code === 'store_internal');
  } finally {
    rmTmp(dir);
  }
});
