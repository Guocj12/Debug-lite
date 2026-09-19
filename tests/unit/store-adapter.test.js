'use strict';
/* tests/unit/store-adapter.test.js —— JSON 适配器的事务/维护/可观测性补充断言
 * （契约本身在 tests/contract/store-contract.test.js；此处覆盖 A 类写、维护方法、缓存与日志矩阵）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../server/store/index.js');
const { createLogger, nullLogger } = require('../../shared/log.js');

const VERSIONS = { engine: '3.0.0', data: 'b25' };

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-adapter-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function loadout(tag) {
  return { role: { uid: `r_${tag}` }, skills: [{ uid: `s_${tag}` }], ai: { version: 2, tag } };
}

async function open(opts) {
  const dir = (opts && opts.dir) || mkTmp();
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: (opts && opts.logger) || nullLogger, ...opts });
  await store.open();
  return { store, dir };
}

async function withAccount(store, tag) {
  const snap = store.freezeSnapshot(loadout(tag));
  const archive = await store.createAccount({
    username: tag, nickname: tag, auth: { algo: 'scrypt', hash: `h_${tag}` },
    slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS },
  });
  return { archive, snap };
}

test('AD-1 updateArchive：create 分支 / 不存在报错 / 不变量破损拒绝落盘', async () => {
  const { store, dir } = await open();
  try {
    const archMod = require('../../server/store/archive.js');
    await assert.rejects(() => store.updateArchive('pl_1111111111111111', () => {}), (e) => e.code === 'store_not_found');
    // create 分支：调用方注入合法档案（空壳不是合法档案，会被不变量拦下 —— 见下方断言）
    await assert.rejects(() => store.updateArchive('pl_1111111111111111', () => null, {
      create: (pid) => archMod.createArchiveShell(pid, 5),
    }), (e) => e.code === 'store_inconsistent');
    const seedSnap = store.freezeSnapshot(loadout('seed'));
    const created = await store.updateArchive('pl_1111111111111111', () => ({ boxed: 1 }), {
      create: (pid) => archMod.createArchive({
        playerId: pid, at: 5, nickname: 'created', auth: { hash: 'h' },
        slot: { slotId: 'slot1', snapshot: { hash: seedSnap.hash, engineVersion: '3.0.0', dataVersion: 'b25' } },
      }),
    });
    assert.equal(created.archive.playerId, 'pl_1111111111111111');
    assert.equal(created.result.boxed, 1);
    // 不变量破损 → store_inconsistent（不落盘）
    const snap = store.freezeSnapshot(loadout('a'));
    const acc = await store.createAccount({
      username: 'a', nickname: 'a', auth: { hash: 'a' },
      slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS },
    });
    await assert.rejects(() => store.updateArchive(acc.playerId, (archive) => { archive.configs.activeSlotId = 'gone'; }),
      (e) => e.code === 'store_inconsistent');
    const reload = await store.loadArchive(acc.playerId);
    assert.equal(reload.configs.activeSlotId, 'slot1', '失败的更新不得落盘');
    // 深拷贝返回：外部修改不进入缓存
    const res = await store.updateArchive(acc.playerId, () => null);
    res.archive.nickname = 'mutated';
    assert.equal((await store.loadArchive(acc.playerId)).nickname, 'a');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('AD-2 saveArchive（A 类写）：不变量校验、appliedSeq 单调不回退、索引同步', async () => {
  const { store, dir } = await open();
  try {
    const { archive } = await withAccount(store, 'a');
    await assert.rejects(() => store.saveArchive(null), (e) => e.code === 'bad_request');
    const broken = JSON.parse(JSON.stringify(archive));
    broken.progress.tier = 'nope';
    await assert.rejects(() => store.saveArchive(broken), (e) => e.code === 'store_inconsistent');
    // 合法 A 类写 + 试图回退 appliedSeq → 被单调水位保护
    const copy = JSON.parse(JSON.stringify(archive));
    copy.nickname = 'renamed';
    copy.record.appliedSeq = 0;
    const saved = await store.saveArchive(copy);
    assert.equal(saved.nickname, 'renamed');
    assert.equal(saved.record.appliedSeq, archive.record.appliedSeq, 'appliedSeq 不得回退');
    assert.equal(store.index.get(archive.playerId).nickname, 'renamed', '索引随 A 类写增量更新');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'players', archive.playerId.slice(3, 5), `${archive.playerId}.json`), 'utf8')).nickname, 'renamed');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('AD-3 单玩家 journal 事件方法：昵称/池/封禁（撤销会话）/改密', async () => {
  const { store, dir } = await open();
  try {
    const { archive } = await withAccount(store, 'a');
    const pid = archive.playerId;
    await assert.rejects(() => store.setNickname({ playerId: pid, nickname: '' }), (e) => e.code === 'bad_request');
    const renamed = await store.setNickname({ playerId: pid, nickname: '新昵称' });
    assert.equal(renamed.nickname, '新昵称');
    const out = await store.setPool({ playerId: pid, inPool: false });
    assert.equal(out.pool.inPool, false);
    const back = await store.setPool({ playerId: pid, inPool: true });
    assert.equal(back.pool.inPool, true);
    const now = Date.now();
    store.sessions.put({ tokenHash: 't1', playerId: pid, createdAt: now, expiresAt: now + 86400000 });
    const banned = await store.setBanned({ playerId: pid, banned: true, reason: 'cheat' });
    assert.equal(banned.flags.banned, true);
    assert.equal(banned.flags.banReason, 'cheat');
    assert.equal(store.sessions.size(), 0, '封禁撤销全部会话（§4.3）');
    const unbanned = await store.setBanned({ playerId: pid, banned: false });
    assert.equal(unbanned.flags.banned, false);
    const pw = await store.setPasswordHash({ playerId: pid, auth: { algo: 'scrypt', hash: 'new' } });
    assert.equal(pw.auth.hash, 'new');
    // 事件全部落 journal（可审计 / 可重放，§12.2）
    const types = (await store.readRecords({})).map((r) => r.type);
    for (const t of ['account.created', 'player.nickname.changed', 'player.pool.changed', 'account.banned', 'account.unbanned', 'account.password.changed']) {
      assert.ok(types.includes(t), `journal 缺 ${t}`);
    }
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('AD-4 listPlayerIds / rebuildArchive / touchLastSeen（A 类不入 journal）', async () => {
  const { store, dir } = await open();
  try {
    const a = await withAccount(store, 'a');
    const b = await withAccount(store, 'b');
    assert.deepEqual(await store.listPlayerIds(), [a.archive.playerId, b.archive.playerId].sort());
    const before = (await store.readRecords({})).length;
    const touched = await store.touchLastSeen(a.archive.playerId, 777);
    assert.equal(touched.lastSeenAt, 777);
    assert.equal(touched.lastLoginAt, 777);
    assert.equal((await store.readRecords({})).length, before, 'touchLastSeen 不入 journal（A 类）');
    // 删除档案文件后 rebuildArchive 从 journal 重建
    const file = path.join(dir, 'players', a.archive.playerId.slice(3, 5), `${a.archive.playerId}.json`);
    fs.rmSync(file);
    const rebuilt = await store.rebuildArchive(a.archive.playerId);
    assert.ok(rebuilt);
    assert.equal(rebuilt.record.appliedSeq, a.archive.record.appliedSeq);
    assert.equal(rebuilt.nickname, 'a');
    assert.equal(await store.rebuildArchive('pl_9999999999999999'), null);
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('AD-5 compactJournal / gc / recover / stats / 索引 rebuild 公开方法', async () => {
  // 注入 now → 记录落在 2020-01 段，便于用 2026 的 at 触发"超期压缩"
  const frozenNow = Date.UTC(2020, 0, 15);
  const { store, dir } = await open({ now: () => frozenNow, config: { journal: { compactAfterDays: 0 } } });
  try {
    const a = await withAccount(store, 'a');
    const b = await withAccount(store, 'b');
    await store.settleBattle({
      mode: 'quick', seed: 1,
      p1: { playerId: a.archive.playerId, role: 'attacker', snapshotHash: a.snap.hash, pointsBefore: 0, pointsAfter: 5, result: 'win' },
      p2: { playerId: b.archive.playerId, role: 'defender', snapshotHash: b.snap.hash, pointsBefore: 0, pointsAfter: 0, result: 'loss' },
      verdict: { winner: 'p1', ticks: 10 }, versions: VERSIONS,
    });
    assert.deepEqual(store.stats().journal.segments.map((s) => s.key), ['2020-01']);
    const compacted = store.compactJournal({ at: Date.UTC(2026, 8, 16), retentionDays: 0 });
    assert.deepEqual(compacted.compacted, ['2020-01'], '超期且已物化的段被压缩');
    assert.ok(fs.readdirSync(path.join(dir, 'journal')).some((f) => f.endsWith('.checkpoint.json')));
    assert.equal(store.maxSeq() >= 3, true, '检查点保留水位');
    const recoverReport = await store.recover();
    assert.ok(Number.isInteger(recoverReport.replayed));
    assert.equal(recoverReport.journalSeq, store.maxSeq());
    const gc = await store.gc();
    assert.ok(gc.snapshots && gc.sessions);
    const idxStats = await store.rebuildIndex();
    assert.equal(idxStats.players, 2);
    const stats = store.stats();
    for (const key of ['adapter', 'dataDir', 'opened', 'seq', 'indexSeq', 'players', 'cache', 'journal', 'snapshots', 'sessions', 'reads', 'writes', 'applies', 'skipped', 'quarantined']) {
      assert.ok(Object.prototype.hasOwnProperty.call(stats, key), `stats 缺 ${key}`);
    }
    assert.equal(stats.opened, true);
    assert.equal(stats.players, 2);
    assert.equal(stats.adapter, 'json');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('AD-6 档案 LRU 上限（archiveCacheSize）与读计数', async () => {
  const { store, dir } = await open({ config: { store: { archiveCacheSize: 2 } } });
  try {
    const a = await withAccount(store, 'a');
    const b = await withAccount(store, 'b');
    const c = await withAccount(store, 'c');
    const s0 = store.stats();
    for (const x of [a, b, c, c, b, a, a]) {
      await store.loadArchive(x.archive.playerId);
    }
    const stats = store.stats();
    assert.equal(stats.cache.limit, 2);
    assert.ok(stats.cache.size <= 2, '缓存不超过上限');
    assert.ok(stats.cache.evictions >= 1, '发生淘汰');
    assert.ok(stats.cache.hits > s0.cache.hits, '存在缓存命中');
    assert.ok(stats.cache.misses > s0.cache.misses, '存在缓存未命中（被淘汰后回读磁盘）');
    assert.ok(stats.reads >= 3, '磁盘读计入 stats.reads');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('AD-7 appendMany / readRecords / findBattleRecord / replayJournal / maxSeq', async () => {
  const { store, dir } = await open();
  try {
    const a = await withAccount(store, 'a');
    const records = await store.appendMany([
      { type: 'player.pool.changed', playerId: a.archive.playerId, inPool: true },
      { type: 'player.pool.changed', playerId: a.archive.playerId, inPool: false },
    ]);
    assert.equal(records.length, 2);
    assert.equal(records[0].seq + 1, records[1].seq, 'group commit 顺序分配 seq');
    const applied = await store.applyRecords(records);
    assert.equal(applied.applied, 2);
    assert.equal(store.maxSeq(), records[1].seq);
    const all = await store.readRecords({});
    assert.ok(all.length >= 3);
    assert.equal((await store.readRecords({ fromSeq: records[0].seq })).length, 1);
    let replayed = 0;
    const n = await store.replayJournal({ fromSeq: 0 }, () => { replayed += 1; });
    assert.equal(n, replayed);
    assert.equal(await store.findBattleRecord('b_nope'), null);
  } finally {
    await store.close();
    rmTmp(dir);
  }
});

test('AD-8 日志矩阵：存储层只发 store 通道、事件名均为 store.*（interfaces §6）', async () => {
  const dir = mkTmp();
  const logger = createLogger({ level: 'all', ringSize: 10000 });
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger });
  try {
    await store.open();
    const snap = store.freezeSnapshot(loadout('a'));
    const acc = await store.createAccount({
      username: 'a', auth: { hash: 'a' },
      slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS },
    });
    await store.loadArchive(acc.playerId);
    await store.setNickname({ playerId: acc.playerId, nickname: 'x' });
    await store.snapshot.gc({ retentionDays: 0, at: Date.now() + 86400000 });
    await store.rebuildIndex();
    await store.close();
    const records = logger.records.filter((r) => r.channel !== 'log');
    assert.ok(records.length > 5, '应有可观测事件');
    const allowed = new Set([
      'store.open', 'store.close', 'store.write', 'store.read', 'store.journal.append', 'store.journal.flush',
      'store.journal.truncate', 'store.journal.compact', 'store.recover', 'store.index.rebuild', 'store.migrate',
      'store.snapshot.write', 'store.snapshot.gc', 'store.snapshot.missing', 'store.auth.register', 'store.auth.login',
      'store.auth.reject', 'store.auth.lock', 'store.abuse.suspect', 'store.error',
    ]);
    for (const rec of records) {
      assert.equal(rec.channel, 'store', `非 store 通道: ${rec.channel}`);
      assert.ok(allowed.has(rec.event), `未登记事件: ${rec.event}`);
      assert.ok(rec.event.startsWith('store.'), `事件首段必须是 store: ${rec.event}`);
    }
    assert.ok(records.some((r) => r.event === 'store.open'));
    assert.ok(records.some((r) => r.event === 'store.close'));
    assert.ok(records.some((r) => r.event === 'store.journal.append'));
    assert.ok(records.some((r) => r.event === 'store.snapshot.write'));
  } finally {
    if (store.isOpen()) await store.close();
    rmTmp(dir);
  }
});
