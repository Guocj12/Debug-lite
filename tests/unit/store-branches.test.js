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
    assert.deepEqual(empty, { applied: 0, count: 0, recordsApplied: 0 });
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

test('BR-11 档案版本迁移：磁盘上的 v0 档案在读取时升级并原子写回（§5.7）', async () => {
  const dir = mkTmp();
  const log = recorder();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: log.logger });
  try {
    await store.open();
    const snap = store.freezeSnapshot(loadout('v0'));
    const pid = 'pl_abababababababab';
    const file = path.join(dir, 'players', pid.slice(3, 5), `${pid}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // v0：无 archiveVersion、缺 progress/pool/record/flags 段
    fs.writeFileSync(file, JSON.stringify({
      playerId: pid, publicId: 'u_abababab', nickname: 'legacy', auth: { hash: 'h' },
      rating: { points: 33, peakPoints: 33 },
      configs: {
        slots: [{ slotId: 'slot1', name: '默认', isDefault: true, loadout: loadout('v0'), snapshot: { hash: snap.hash, engineVersion: '3.0.0', dataVersion: 'b25', configHash: snap.configHash, frozenAt: 1 } }],
        activeSlotId: 'slot1', activeSnapshotHash: snap.hash,
      },
    }), 'utf8');
    const archive = await store.loadArchive(pid);
    assert.equal(archive.archiveVersion, 1, '读档时升级到当前版本');
    assert.equal(archive.rating.points, 33, '保留 v0 已有字段');
    assert.equal(archive.progress.tier, 'common', '补齐缺失段');
    assert.equal(archive.record.appliedSeq, 0);
    assert.ok(log.has('store.migrate'));
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(onDisk.archiveVersion, 1, '升级后立即原子写回');
    assert.equal(store.index.get(pid).points, 33, '索引同步');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('BR-12 快照去重 + 版本戳不一致：保留首个并记 store.snapshot.write(warn)', async () => {
  const dir = mkTmp();
  const log = recorder();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: log.logger });
  try {
    await store.open();
    const first = store.freezeSnapshot(loadout('ver'));
    const again = store.freezeSnapshot(loadout('ver'), { engine: '9.9.9', data: 'zz' });
    assert.equal(again.hash, first.hash, '内容寻址：同内容同 hash');
    assert.equal(again.engineVersion, '3.0.0', '保留首个冻结的版本戳（幂等）');
    assert.ok(log.events.some((e) => e.event === undefined && e.ev === 'store.snapshot.write' && e.level === 'warn'));
    // 库内只有一份
    assert.equal(store.snapshot.list().length, 1);
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('BR-13 激活缺快照的槽（仅检查点重建档案）→ no_active_config', async () => {
  const dir = mkTmp();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
  try {
    await store.open();
    const archMod = require('../../server/store/archive.js');
    const shell = archMod.createArchiveShell('pl_cdcdcdcdcdcdcdcd', 1);
    shell.publicId = 'u_cdcdcdcd';
    shell.flags.rebuiltFromCheckpoint = true;
    shell.configs.slots.push(archMod.createSlot({ slotId: 'slot1', snapshot: null, loadout: null }));
    shell.configs.activeSlotId = 'slot1';
    shell.configs.activeSnapshotHash = null;
    await store.saveArchive(shell);
    await assert.rejects(() => store.activateConfigSlot({ playerId: shell.playerId, slotId: 'slot1' }),
      (e) => e.code === 'no_active_config');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('BR-14 原子写 openSync 失败 → store_write_failed（保留诊断信息）', () => {
  const dir = mkTmp();
  const realOpen = fs.openSync;
  try {
    fs.openSync = () => {
      const err = new Error('denied');
      err.code = 'EACCES';
      throw err;
    };
    assert.throws(() => fa.writeFileAtomicSync(path.join(dir, 'a.json'), 'x'),
      (e) => e.code === 'store_write_failed' && e.details[0].code === 'store_write_failed');
    fs.openSync = realOpen;
    // 正常路径恢复
    fa.writeFileAtomicSync(path.join(dir, 'a.json'), 'x');
    assert.equal(fs.readFileSync(path.join(dir, 'a.json'), 'utf8'), 'x');
    // removeFileSafe：存在 → true；不存在 → false
    assert.equal(fa.removeFileSafe(path.join(dir, 'a.json')), true);
    assert.equal(fa.removeFileSafe(path.join(dir, 'a.json')), false);
  } finally {
    fs.openSync = realOpen;
    rmTmp(dir);
  }
});

test('BR-15 ledger：缺省/局部配置的参数回落', () => {
  assert.equal(ledger.expectedScore(0, 0, undefined), 0.5);
  assert.equal(ledger.expectedScore(0, 400, { rating: { scale: 400 } }) < 0.5, true);
  assert.equal(ledger.gainFactor(0, { cap: 1000 }), 32, 'kBase 缺省 32');
  assert.equal(ledger.gainFactor(1000, { cap: 1000, kBase: 32, kMin: 8 }), 8);
  assert.equal(ledger.lossFactor(0, { cap: 1000 }), 32);
  assert.equal(ledger.lossFactor(1000, { cap: 1000, kBase: 32, kMax: 64 }), 64);
  const d = ledger.ratingDelta({ points: 10, opponentPoints: 20, result: 'win', config: { cap: 100, kBase: 10, kMin: 1, kMax: 20, scale: 100, drawFactor: 0.25 } });
  assert.ok(d.delta >= 0 && d.pointsAfter <= 100);
  const draw = ledger.ratingDelta({ points: 10, opponentPoints: 2000, result: 'draw', config: { cap: 100, kBase: 10, drawFactor: 0.25 } });
  assert.ok(draw.delta > 0, '弱者平局加分');
  assert.equal(ledger.ratingConfigOf, undefined, '内部助手不对外暴露（避免误用）');
});

test('BR-16 snapshot-store：损坏正文覆盖写、protect 数组、非 hash 查询、目录内杂项文件', () => {
  const dir = mkTmp();
  try {
    const store = snapMod.createSnapshotStore({ dir, logger: nullLogger, config: {} });
    const snap = snapMod.buildSnapshot({ loadout: { role: 'x' }, engineVersion: '3.0.0', dataVersion: 'b25', frozenAt: 1 });
    const file = snapMod.snapshotPath(dir, snap.hash);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"hash":"sha256:' + 'f'.repeat(64) + '"}', 'utf8'); // 同路径但正文 hash 不符
    const res = store.put(snap);
    assert.equal(res.written, true, '正文 hash 不符 → 重新写入');
    assert.equal(store.get(snap.hash).hash, snap.hash);
    fs.writeFileSync(path.join(dir, 'stray.txt'), 'x', 'utf8');
    fs.writeFileSync(path.join(path.dirname(file), 'notes.txt'), 'x', 'utf8');
    assert.equal(store.list().length, 1, '非 .json 文件不进入清单');
    assert.equal(store.get('not-a-hash'), null);
    assert.equal(store.ref('not-a-hash', 1), 0);
    assert.equal(store.has('not-a-hash'), false, '非法 hash 一律视为不存在');
    const gc = store.gc({ retentionDays: 0, at: 1e15, protect: [snap.hash] });
    assert.deepEqual(gc.removed, []);
    assert.deepEqual(gc.kept, [snap.hash]);
  } finally {
    rmTmp(dir);
  }
});

test('BR-17 index-file：scope/limit 边界与缺失段位表', () => {
  const idx = indexMod.createIndex({ logger: nullLogger });
  assert.deepEqual(idx.leaderboard({ scope: '' }), []);
  assert.deepEqual(idx.leaderboard({ limit: 0 }), []);
  assert.deepEqual(idx.leaderboard({ limit: -1 }), []);
  assert.deepEqual(idx.leaderboard({ scope: 'tier:common' }), []);
  const arch = require('../../server/store/archive.js').createArchive({
    playerId: 'pl_efefefefefefefef', publicId: 'u_efefefef', nickname: 'E', at: 1,
    slot: { slotId: 'slot1', snapshot: { hash: `sha256:${'b'.repeat(64)}` } },
  });
  idx.upsert(arch);
  idx.toJSON().byTier.common = undefined;
  assert.deepEqual(idx.byTier('common'), [], '段位表缺失 → 空数组');
  assert.equal(idx.rank('pl_0000000000000000'), null);
  idx.remove('pl_efefefefefefefef');
  assert.equal(idx.get('pl_efefefefefefefef'), null);
  assert.equal(idx.has('pl_efefefefefefefef'), false);
});

test('BR-18 canonical：Buffer/数组/非法值分支', () => {
  const canon = require('../../server/store/canonical.js');
  assert.equal(canon.sha256Hex(Buffer.from('abc', 'utf8')).length, 64);
  assert.equal(canon.sha256Hex('abc'), canon.sha256Hex(Buffer.from('abc', 'utf8')));
  const arr = canon.deepClone([1, { a: 2 }]);
  arr[1].a = 9;
  assert.equal(arr[1].a, 9);
  assert.equal(canon.isHash(123), false);
  assert.equal(canon.isHash('sha256:' + 'A'.repeat(64)), false, '大写 hex 不合法');
  assert.equal(canon.canonicalJson('str'), '"str"');
  assert.equal(canon.canonicalJson(undefined), undefined, 'undefined 无 JSON 表示');
  assert.equal(canon.sortValue([1, { b: 1, a: 2 }])[1].a, 2);
});

test('BR-19 archive：applyRecordToArchive 未登记类型默认分支 / 平局聚合 / 攻击视图', async () => {
  const archMod = require('../../server/store/archive.js');
  const warns = [];
  const ctx = {
    config: require('../../server/store/config.js').DEFAULT_SERVICE_CONFIG,
    now: () => 1,
    logger: { warn: (ch, ev) => warns.push(ev), debug: () => {}, info: () => {}, error: () => {}, log: () => {}, trace: () => {} },
    loadSnapshot: async () => null,
  };
  const a = archMod.createArchive({
    playerId: 'pl_0101010101010101', publicId: 'u_01010101', nickname: 'A', at: 1,
    slot: { slotId: 'slot1', snapshot: { hash: `sha256:${'c'.repeat(64)}` } },
  });
  const res = await archMod.applyRecordToArchive(a, { seq: 1, type: 'unknown.type', at: 1, playerId: a.playerId }, a.playerId, ctx);
  assert.deepEqual(res, { changed: false });
  assert.deepEqual(warns, ['store.error']);
  // 聚合：平局 + attack 桶
  const per = archMod.aggregateRecords([{
    seq: 2, type: 'battle.recorded', at: 2, battleId: 'b_d', mode: 'quick',
    p1: { playerId: a.playerId, side: 'p1', role: 'attacker', result: 'draw', pointsAfter: 5, tierAfter: 'common' },
    p2: { playerId: 'pl_0202020202020202', side: 'p2', role: 'defender', result: 'draw', pointsAfter: 5, tierAfter: 'common' },
  }]);
  assert.equal(per[a.playerId].quickDraws, 1);
  assert.equal(per[a.playerId].stats.attack.draws, 1);
  // recentView：role=attack 分支 + limit 裁剪
  a.record.recent = [
    { battleId: 'b1', seq: 1, role: 'attacker', result: 'win' },
    { battleId: 'b2', seq: 2, role: 'defender', result: 'loss' },
  ];
  assert.equal(archMod.recentView(a, { role: 'attack' }).length, 1);
  assert.equal(archMod.recentView(a, { role: 'attack', limit: 5 })[0].battleId, 'b1');
  assert.equal(archMod.recentView(a, { role: 'bogus' }).length, 2, '非法 role → 不过滤');
});

test('BR-21 ledger/buildBattleRecord：缺省值与非法入参的回落', () => {
  const rec = ledger.buildBattleRecord({
    batchId: null, matchIndex: null, seed: null,
    p1: { playerId: 'pl_1111111111111111', role: 'bogus', pointsBefore: 'x', result: 'bogus', tierBefore: 'bogus', tierAfter: 'bogus' },
    p2: { playerId: 'pl_2222222222222222' },
    versions: {},
    verdict: {},
  });
  assert.equal(rec.batchId, null);
  assert.equal(rec.matchIndex, null);
  assert.equal(rec.seed, null);
  assert.equal(rec.p1.role, 'attacker', '非法 role → attacker');
  assert.equal(rec.p1.result, 'draw', '非法 result → draw');
  assert.equal(rec.p1.pointsBefore, 0);
  assert.equal(rec.p1.pointsAfter, 0);
  assert.equal(rec.p1.tierBefore, 'common');
  assert.equal(rec.p1.tierAfter, 'common');
  assert.equal(rec.versions.engine, '0.0.0');
  assert.equal(rec.versions.data, 'unknown');
  assert.equal(rec.verdict.ticks, null);
  assert.equal(rec.replay.to, null);
  assert.equal(rec.p1.publicId, null);
  assert.equal(rec.p1.configHash, null);
  assert.equal(ledger.battleIdOf({ batchId: null, matchIndex: null, seed: null }).startsWith('b_'), true);
  assert.equal(ledger.battleIdOf({ batchId: undefined, matchIndex: undefined, seed: undefined }), ledger.battleIdOf({}));
  assert.equal(ledger.promoteAfterBatch({}).promoted, false, '缺 tier/wins → common/0');
  assert.equal(ledger.settleRating({ winner: 'bogus' }).winner, 'draw', '非法 winner → 平局');
  assert.equal(ledger.settleRating({}).p1.pointsAfter, 0);
});

test('BR-22 adapter-sqlite 占位：全部方法均为 Promise 拒绝（不静默）', async () => {
  const sqliteAdapter = require('../../server/store/adapter-sqlite.js');
  const adapter = sqliteAdapter.createSqliteAdapter({ dataDir: 'X:/nope' });
  assert.equal(adapter.adapterName, 'sqlite');
  assert.equal(adapter.implemented, false);
  assert.ok(adapter.triggers.length >= 3);
  assert.ok(adapter.tables.some((t) => t.startsWith('players(')));
  for (const method of ['close', 'loadArchive', 'saveArchive', 'settleBattle', 'records', 'stats', 'recover']) {
    await assert.rejects(() => adapter[method](), (e) => e.code === 'store_adapter_unavailable' && e.fatal === true);
  }
  assert.equal(sqliteAdapter.ADAPTER_NAME, 'sqlite');
  // 无参装配：dataDir 回落 null
  const bare = sqliteAdapter.createSqliteAdapter();
  assert.equal(bare.dataDir, null);
  await assert.rejects(() => bare.open(), (e) => e.code === 'store_adapter_unavailable');
});

test('BR-25 adapter：rebuildIndex 遇到高版本档案 → 版本错误必须冒泡（不静默隔离）', async () => {
  const dir = mkTmp();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
  try {
    await store.open();
    const snap = store.freezeSnapshot(loadout('vp'));
    const acc = await store.createAccount({
      username: 'vp', nickname: 'vp', auth: { hash: 'v' },
      slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS },
    });
    const file = path.join(dir, 'players', acc.playerId.slice(3, 5), `${acc.playerId}.json`);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.archiveVersion = 42;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    // 用**未 open** 的新实例重建索引（绕开缓存），验证版本错误冒泡而非静默隔离
    const cold = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
    await assert.rejects(() => cold.rebuildIndex(), (e) => e.code === 'store_version_unsupported');
    // 缓存命中时（同一实例）不受影响：重建仍成功（隔离语义只在冷读时生效）
    assert.equal((await store.rebuildIndex()).players, 1);
    // 非版本类损坏（JSON 坏）→ 走隔离分支：隔离后其余档案仍可索引
    fs.writeFileSync(file, '{ broken', 'utf8');
    const cold2 = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
    assert.equal((await cold2.rebuildIndex()).players, 0, '唯一档案损坏 → 隔离后索引为空（不抛错）');
    assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')), '损坏档案被隔离保留');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('BR-23 fsatomic：删除目录/写失败/清理失败的兜底分支', () => {
  const dir = mkTmp();
  const realWrite = fs.writeFileSync;
  const realUnlink = fs.unlinkSync;
  try {
    // removeFileSafe 对目录 → 非 ENOENT 错误照旧抛出
    const sub = path.join(dir, 'subdir');
    fs.mkdirSync(sub);
    assert.throws(() => fa.removeFileSafe(sub));
    // 写入阶段失败 → 关闭 fd 并包成 store_write_failed
    fs.writeFileSync = () => { const err = new Error('disk full'); err.code = 'ENOSPC'; throw err; };
    assert.throws(() => fa.writeFileAtomicSync(path.join(dir, 'w.json'), 'x'),
      (e) => e.code === 'store_write_failed');
    fs.writeFileSync = realWrite;
    // 清理 tmp 失败 → 记 warn 不中断
    fs.writeFileSync(path.join(dir, 'a.tmp-1-ff'), 'x');
    const log = recorder();
    fs.unlinkSync = () => { const err = new Error('locked'); err.code = 'EPERM'; throw err; };
    assert.equal(fa.sweepTmpSync(dir, log.logger), 0);
    assert.ok(log.events.some((e) => e.level === 'warn' && e.ev === 'store.error'));
    fs.unlinkSync = realUnlink;
    // 写失败的 tmp（保留供排查）+ 手工造的 tmp 都会被清理
    assert.ok(fa.sweepTmpSync(dir) >= 1);
    assert.equal(fs.readdirSync(dir).some((f) => f.includes('.tmp-')), false);
  } finally {
    fs.writeFileSync = realWrite;
    fs.unlinkSync = realUnlink;
    rmTmp(dir);
  }
});

test('BR-24 removeArchive 走 journal 墓碑：删档案+摘索引+记 player.removed；重启/重放均不复活', async () => {
  const dir = mkTmp();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
  try {
    await store.open();
    const snap = store.freezeSnapshot(loadout('rm'));
    const acc = await store.createAccount({
      username: 'rm', nickname: 'rm', auth: { hash: 'r' },
      slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS },
    });
    assert.equal(await store.removeArchive(acc.playerId, { reason: 'debug' }), true);
    assert.equal(await store.loadArchive(acc.playerId), null);
    assert.equal(store.index.has(acc.playerId), false);
    // 删除必须可重放：journal 里留下墓碑（D-134），且墓碑 seq 之后无该玩家记录
    const recs = await store.readRecords({});
    const tomb = recs.find((r) => r.type === 'player.removed');
    assert.ok(tomb, '必须有墓碑记录');
    assert.equal(tomb.reason, 'debug');
    assert.equal(recs.filter((r) => r.type === 'player.removed').length, 1);
    // 幂等：不存在 → false（不写第二条墓碑）；重复 apply 墓碑 → 跳过
    assert.equal(await store.removeArchive(acc.playerId), false, '幂等');
    assert.equal((await store.applyRecord(tomb)).applied, 0, '重复 apply 墓碑不报错且不重复删除');
    await assert.rejects(() => store.removeArchive(''), (e) => e.code === 'bad_request');
    await store.close();
    // 重启：墓碑水位由 journal 重建 → 档案不复活（无需全量重放）
    const store2 = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
    await store2.open();
    assert.equal(await store2.loadArchive(acc.playerId), null, '删除后重启不复活');
    assert.ok((await store2.readRecords({})).some((r) => r.type === 'player.removed' && r.playerId === acc.playerId));
    await store2.close();
  } finally {
    rmTmp(dir);
  }
});

