'use strict';
/* tests/unit/store-snapshot.test.js —— 快照库：内容寻址/幂等/引用计数/GC/回放版本门槛（D-129 §5.4/§9.2/§9.3） */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const snapMod = require('../../server/store/snapshot-store.js');
const { nullLogger } = require('../../shared/log.js');

const DAY = 86400000;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-snap-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

const LOADOUT = { role: { uid: 'r1' }, skills: [{ uid: 's1' }, { uid: 's2' }, { uid: 's3' }], ai: { version: 2 } };

test('SNP-1 buildSnapshot：hash 只随 loadout 变化，configHash 含版本三元组；深拷贝冻结', () => {
  const s1 = snapMod.buildSnapshot({ loadout: LOADOUT, engineVersion: '3.0.0', dataVersion: 'b25', frozenAt: 5 });
  const s2 = snapMod.buildSnapshot({ loadout: LOADOUT, engineVersion: '3.0.0', dataVersion: 'b25', frozenAt: 9 });
  assert.equal(s1.hash, s2.hash, 'hash 与 frozenAt 无关（内容寻址）');
  assert.equal(s1.configHash, s2.configHash);
  const s3 = snapMod.buildSnapshot({ loadout: LOADOUT, engineVersion: '3.1.0', dataVersion: 'b25' });
  assert.equal(s3.hash, s1.hash, 'hash 仍是纯内容 hash');
  assert.notEqual(s3.configHash, s1.configHash, 'configHash 随引擎版本变化（可复现性三元组）');
  assert.notEqual(s1.hash, s1.configHash);
  assert.equal(s1.frozenAt, 5);
  assert.equal(snapMod.buildSnapshot({ loadout: LOADOUT }).dataVersion, 'unknown');
  assert.equal(snapMod.buildSnapshot({ loadout: LOADOUT }).engineVersion, '0.0.0');
  LOADOUT.role.uid = 'mutated';
  assert.equal(s1.loadout.role.uid, 'r1', '冻结时深拷贝，外部后续修改不影响快照');
  LOADOUT.role.uid = 'r1';
  assert.equal(snapMod.shardOf(s1.hash), require('../../server/store/canonical.js').digestOf(s1.hash).slice(0, 2));
  assert.ok(snapMod.snapshotPath('/tmp/x', s1.hash).endsWith('.json'));
  assert.equal(snapMod.snapshotPath('/tmp/x', s1.hash).includes(':'), false, 'Windows 文件名不得含 ":"');
});

test('SNP-2 put/get/has：幂等去重（保留首个版本戳）、缺失返回 null、损坏文件视为缺失', () => {
  const dir = mkTmp();
  try {
    const store = snapMod.createSnapshotStore({ dir, logger: nullLogger, config: { snapshotCacheSize: 2 } });
    const snap = snapMod.buildSnapshot({ loadout: LOADOUT, engineVersion: '3.0.0', dataVersion: 'b25', frozenAt: 1 });
    const first = store.put(snap);
    assert.equal(first.written, true);
    assert.equal(store.has(snap.hash), true);
    const again = store.put({ ...snap, engineVersion: '9.9.9', frozenAt: 2 });
    assert.equal(again.written, false, '同 hash 不重复写盘');
    assert.equal(again.snapshot.engineVersion, '3.0.0', '保留首个冻结版本（幂等）');
    assert.equal(store.list().length, 1);
    const got = store.get(snap.hash);
    assert.equal(got.engineVersion, '3.0.0');
    got.loadout.role.uid = 'mutated';
    assert.equal(store.get(snap.hash).loadout.role.uid, 'r1');
    assert.equal(store.get('bogus'), null);
    assert.equal(store.get('sha256:' + '0'.repeat(64)), null);
    assert.equal(store.has('bogus'), false);
    // 缺文件 → requireSnapshot 记 store.snapshot.missing(warn) 并返回 null
    const warns = [];
    const store2 = snapMod.createSnapshotStore({
      dir, logger: { warn: (ch, ev) => warns.push(ev), debug: () => {}, info: () => {}, error: () => {}, log: () => {}, trace: () => {} },
      config: {},
    });
    assert.equal(store2.requireSnapshot('sha256:' + '1'.repeat(64)), null);
    assert.deepEqual(warns, ['store.snapshot.missing']);
    // 损坏快照正文 → get 视为缺失
    fs.writeFileSync(snapMod.snapshotPath(dir, snap.hash), '{oops', 'utf8');
    const store3 = snapMod.createSnapshotStore({ dir, logger: nullLogger, config: {} });
    assert.equal(store3.get(snap.hash), null);
    assert.throws(() => store3.put({ hash: 'nope' }), (e) => e.code === 'bad_request');
  } finally {
    rmTmp(dir);
  }
});

test('SNP-3 引用计数：ref/rebuildRefs/refCounts（按 journal 记录重建）', () => {
  const dir = mkTmp();
  try {
    const store = snapMod.createSnapshotStore({ dir, logger: nullLogger, config: {} });
    const h1 = 'sha256:' + 'a'.repeat(64);
    const h2 = 'sha256:' + 'b'.repeat(64);
    store.ref(h1, 1);
    store.ref(h1, 1);
    store.ref(h2, 1);
    store.ref(h1, -5);
    assert.equal(store.refCount(h1), 0, '计数不为负');
    assert.equal(store.refCount(h2), 1);
    assert.equal(store.ref('bogus'), 0);
    const records = [
      { type: 'battle.recorded', battleId: 'b1', p1: { snapshotHash: h1 }, p2: { snapshotHash: h2 } },
      { type: 'player.pool.changed', playerId: 'pl_1' },
      { type: 'battle.recorded', battleId: 'b2', p1: { snapshotHash: h1 }, p2: {} },
    ];
    const res = store.rebuildRefs(records);
    assert.equal(res.refs, 3);
    assert.equal(res.hashes, 2);
    assert.equal(store.refCount(h1), 2);
    assert.equal(store.refCount(h2), 1);
    assert.deepEqual(Object.keys(store.refCounts()).length, 2);
  } finally {
    rmTmp(dir);
  }
});

test('SNP-4 GC：无引用且超期删除；被引用或保护名单保留；缓存失效', () => {
  const dir = mkTmp();
  try {
    const store = snapMod.createSnapshotStore({ dir, logger: nullLogger, config: {} });
    const oldSnap = snapMod.buildSnapshot({ loadout: { role: 1 }, frozenAt: 1000, engineVersion: '3.0.0', dataVersion: 'b25' });
    const freshSnap = snapMod.buildSnapshot({ loadout: { role: 2 }, frozenAt: 1000, engineVersion: '3.0.0', dataVersion: 'b25' });
    const protectedSnap = snapMod.buildSnapshot({ loadout: { role: 3 }, frozenAt: 1000, engineVersion: '3.0.0', dataVersion: 'b25' });
    store.put(oldSnap);
    store.put(freshSnap);
    store.put(protectedSnap);
    store.ref(freshSnap.hash, 1);
    assert.equal(store.stats().files, 3);
    const res = store.gc({ retentionDays: 90, at: 1000 + 91 * DAY, protect: [protectedSnap.hash] });
    assert.deepEqual(res.removed, [oldSnap.hash], '只有无引用且超期的被删');
    assert.equal(res.scanned, 3);
    assert.equal(store.has(oldSnap.hash), false);
    assert.equal(store.has(freshSnap.hash), true, '被引用 → 保留');
    assert.equal(store.has(protectedSnap.hash), true, '保护名单 → 保留');
    assert.equal(store.list().length, 2);
    // 未超期
    const res2 = store.gc({ retentionDays: 90, at: 1000 + DAY });
    assert.deepEqual(res2.removed, []);
    assert.equal(store.stats().cached >= 0, true);
  } finally {
    rmTmp(dir);
  }
});

test('SNP-5 回放版本门槛（§9.3）：record/snapshot 与当前版本戳比对', () => {
  const current = { engine: '3.0.0', data: 'b25' };
  const record = { versions: { engine: '3.0.0', data: 'b25' } };
  assert.deepEqual(snapMod.verifyRecordVersions(record, current), { ok: true, reason: null });
  assert.deepEqual(snapMod.verifyRecordVersions({ versions: { engine: '2.9.0', data: 'b25' } }, current),
    { ok: false, reason: 'engine_mismatch' });
  assert.deepEqual(snapMod.verifyRecordVersions({ versions: { engine: '3.0.0', data: 'b24' } }, current),
    { ok: false, reason: 'data_mismatch' });
  assert.deepEqual(snapMod.verifyRecordVersions({}, current), { ok: false, reason: 'engine_mismatch' });
  const snap = { engineVersion: '3.0.0', dataVersion: 'b25' };
  assert.equal(snapMod.verifySnapshotForReplay(snap, current).ok, true);
  assert.deepEqual(snapMod.verifySnapshotForReplay(null, current), { ok: false, reason: 'snapshot_gc' });
  assert.equal(snapMod.verifySnapshotForReplay({ engineVersion: '9.9.9', dataVersion: 'b25' }, current).reason, 'snapshot_engine_mismatch');
  assert.equal(snapMod.verifySnapshotForReplay({ engineVersion: '3.0.0', dataVersion: 'x' }, current).reason, 'snapshot_data_mismatch');
  assert.equal(snapMod.verifySnapshotForReplay(snap, {}).ok, false);
  assert.equal(snapMod.MS_PER_DAY, DAY);
});

test('SNP-6 LRU 上限：超过 snapshotCacheSize 后仍可正确回读（淘汰重取）', () => {
  const dir = mkTmp();
  try {
    const store = snapMod.createSnapshotStore({ dir, logger: nullLogger, config: { snapshotCacheSize: 1 } });
    const s1 = snapMod.buildSnapshot({ loadout: { role: 'a' }, engineVersion: '3.0.0', dataVersion: 'b25' });
    const s2 = snapMod.buildSnapshot({ loadout: { role: 'b' }, engineVersion: '3.0.0', dataVersion: 'b25' });
    store.put(s1);
    store.put(s2);
    assert.ok(store.cacheSize() <= 1);
    assert.equal(store.get(s1.hash).loadout.role, 'a', '被淘汰后可从磁盘回读');
    assert.equal(store.get(s2.hash).loadout.role, 'b');
  } finally {
    rmTmp(dir);
  }
});
