'use strict';
/* server/store/adapter-json.js —— JSON 文件适配器（D-129 §3.1/§5.1/§6；本轮唯一实现）
 * 目录布局（§5.1）：
 *   <DL_DATA_DIR>/journal/<YYYY-MM>.jsonl     唯一真源（跨玩家结算）
 *   <DL_DATA_DIR>/players/<shard>/<id>.json   物化档案（可重建）
 *   <DL_DATA_DIR>/snapshots/<aa>/<hex>.json   内容寻址快照（不可变）
 *   <DL_DATA_DIR>/index.json                  派生索引（可重建）
 *   <DL_DATA_DIR>/sessions.json               会话表（可丢弃）
 *   <DL_DATA_DIR>/lock                        单进程锁
 * 契约：docs/interfaces.md §1 `server/store/*`（open/close、loadArchive/saveArchive、append、applyRecord、
 *   recover、index.*、snapshot.*、sessions.*）+ 本文件补充的高层事务方法（供 auth/account/quickmatch/ranked 调用）。
 * 事件（通道 store）：open/close/write/read/journal.* /recover/index.rebuild/migrate/snapshot.* /error。
 */
const path = require('node:path');
const { nullLogger } = require('../../shared/log.js');
const { StoreError } = require('./errors.js');
const { deepClone } = require('./canonical.js');
const fsatomic = require('./fsatomic.js');
const configMod = require('./config.js');
const journalMod = require('./journal.js');
const indexMod = require('./index-file.js');
const snapMod = require('./snapshot-store.js');
const archiveMod = require('./archive.js');
const ledger = require('./ledger.js');
const lockMod = require('./lock.js');
const sessionMod = require('./session-table.js');
const recoveryMod = require('./recovery.js');

const ADAPTER_NAME = 'json';

function createJsonAdapter(options) {
  const opts = options || {};
  const dataDir = opts.dataDir;
  if (!dataDir) throw new StoreError('store_internal', 'JSON 适配器需要 dataDir');
  const log = opts.logger || nullLogger;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const configDir = opts.configDir;
  const loaded = configMod.loadConfigs({ configDir, service: opts.config, rating: opts.ratingConfig });
  const serviceConfig = loaded.service;
  const ratingConfig = loaded.rating;
  const versions = {
    engine: (opts.versions && opts.versions.engine) || '0.0.0',
    data: (opts.versions && opts.versions.data) || configMod.computeDataVersion(configDir),
  };

  const playersDir = path.join(dataDir, 'players');
  const snapshotsDir = path.join(dataDir, 'snapshots');
  const journalDir = path.join(dataDir, 'journal');
  const indexPath = path.join(dataDir, 'index.json');
  const sessionsPath = path.join(dataDir, 'sessions.json');

  const journal = journalMod.createJournal({ dir: journalDir, logger: log, config: serviceConfig.journal, now: nowFn });
  const index = indexMod.createIndex({ logger: log, config: serviceConfig });
  const snapshots = snapMod.createSnapshotStore({ dir: snapshotsDir, logger: log, config: serviceConfig.store, now: nowFn });
  const sessions = sessionMod.createSessionTable({ file: sessionsPath, logger: log, config: serviceConfig });

  const archiveCache = new Map(); // playerId → archive（LRU：Map 插入序）
  const queues = new Map();       // playerId → Promise（每玩家写队列，§6.5）
  const removedAt = new Map();    // playerId → 墓碑 seq（journal 派生的删除水位，D-134）
  const stats = {
    reads: 0, writes: 0, applies: 0, skipped: 0, reapplied: 0, reconciled: 0,
    cacheHits: 0, cacheMisses: 0, evictions: 0, quarantined: 0,
  };
  const pendingArchiveWrites = new Map(); // playerId → archive（批次内延迟落盘，见 applyForPlayer）
  let lock = null;
  let opened = false;

  const archiveCacheSize = Number.isInteger(serviceConfig.store.archiveCacheSize) && serviceConfig.store.archiveCacheSize > 0
    ? serviceConfig.store.archiveCacheSize : 200;

  function playerArchivePath(playerId) {
    return path.join(dataDir, archiveMod.archiveRelPath(playerId));
  }

  function ctx() {
    return {
      config: serviceConfig,
      ratingConfig,
      now: nowFn,
      logger: log,
      loadSnapshot: async (hash) => snapshots.get(hash),
    };
  }

  // ---------- 每玩家写队列（§6.5：读改写串行，避免丢失更新） ----------
  function queueFor(playerId, fn) {
    const prev = queues.get(playerId) || Promise.resolve();
    const run = prev.then(() => fn());
    let settled = null;
    settled = run.then(() => undefined, () => undefined).then(() => {
      if (queues.get(playerId) === settled) queues.delete(playerId);
    });
    queues.set(playerId, settled);
    return run;
  }

  // ---------- 档案缓存（LRU；对外一律深拷贝） ----------
  function cacheGet(playerId) {
    if (!archiveCache.has(playerId)) {
      stats.cacheMisses += 1;
      return null;
    }
    const value = archiveCache.get(playerId);
    archiveCache.delete(playerId);
    archiveCache.set(playerId, value);
    stats.cacheHits += 1;
    return value;
  }

  function cacheSet(playerId, archive) {
    archiveCache.set(playerId, archive);
    while (archiveCache.size > archiveCacheSize) {
      const oldest = archiveCache.keys().next().value;
      archiveCache.delete(oldest);
      stats.evictions += 1;
    }
  }

  function cacheDelete(playerId) {
    archiveCache.delete(playerId);
  }

  // ---------- 参与集合锁（P7-6 修复 2：串行粒度 全局 → 参与玩家集合） ----------
  // 背景（P7-6 问题 2）：上一版把"append + 双方 apply"整体挂进**一条全局结算链**，排位一轮 10 场要在
  //   锁内做 10 次结算 × 双方 apply，concurrency=24 时 POST /ranked/run P50≈11s（吞吐 21 场/秒），
  //   瓶颈从"引擎 0.3ms/场"变成这把全局锁。
  // 现在：**同一玩家串行、不同玩家并行** —— 一条结算只锁它的参与玩家，按 playerId 排序后固定顺序
  //   逐个入队（经典有序加锁 → 无死锁）。
  // 为什么 seq 必须在锁内分配：`journal.append` 在调用时**同步**分配 seq。若 seq 在锁外分配，同一玩家
  //   的两条记录就会"seq 小的后 apply" ⇒ 档案 rating.points ≠ journal 末值（P7-6 问题 1 的第二个症状）。
  //   因此所有结算路径都是「先取齐参与玩家的锁 → append（拿 seq）→ apply → 释放」。
  function participantIdsOf(record) {
    const involved = archiveMod.playersOfRecord(record);
    if (involved.length > 0) return involved;
    // 尚未构造的 battle 入参（无 type 字段）：playersOfRecord 认不出，直接取双方 playerId
    const out = [];
    for (const side of ['p1', 'p2']) {
      const part = record && record[side];
      if (part && typeof part.playerId === 'string' && part.playerId !== '' && !out.includes(part.playerId)) {
        out.push(part.playerId);
      }
    }
    return out;
  }

  function participantsOf(records) {
    const set = new Set();
    for (const record of records || []) for (const id of participantIdsOf(record)) set.add(id);
    return [...set];
  }

  // 全局模式（legacy：调用方未声明参与者）：等价于"索引内全部玩家一起加锁"。
  // 仅 `withSettlementLock(fn)` 的旧签名使用；生产路径（settleBattle/settleBatch/applyRecords）都声明参与者。
  function globalKeys() {
    return index.playerIds();
  }

  function withPlayerLocks(playerIds, fn) {
    const keys = [...new Set((playerIds || []).filter((id) => typeof id === 'string' && id !== ''))].sort();
    const run = (i) => (i >= keys.length ? Promise.resolve().then(fn) : queueFor(keys[i], () => run(i + 1)));
    return Promise.resolve().then(() => run(0));
  }

  // 公开形态（P7-6 修复 1 的推荐用法）：把"读档案 → 算 δ → append → 双方 apply"整条链放进参与集合锁。
  //   withSettlementLock([p1Id, p2Id], fn)   显式参与玩家（最精确）
  //   withSettlementLock(record, fn)         从记录/入参推导参与玩家（battle → p1/p2；其余 → playerId）
  //   withSettlementLock(fn)                 legacy：未声明参与者 → 退化为全局模式（索引内全部玩家）
  function withSettlementLock(playerIdsOrRecordOrFn, maybeFn) {
    if (typeof playerIdsOrRecordOrFn === 'function') {
      return withPlayerLocks(globalKeys(), playerIdsOrRecordOrFn);
    }
    const fn = maybeFn;
    if (typeof fn !== 'function') {
      throw new StoreError('bad_request', 'withSettlementLock 需要回调 fn（可选第一参数 = 参与玩家/记录）');
    }
    let ids;
    if (Array.isArray(playerIdsOrRecordOrFn)) ids = playerIdsOrRecordOrFn;
    else if (typeof playerIdsOrRecordOrFn === 'string') ids = [playerIdsOrRecordOrFn];
    else if (playerIdsOrRecordOrFn && typeof playerIdsOrRecordOrFn === 'object') ids = participantIdsOf(playerIdsOrRecordOrFn);
    else ids = [];
    return withPlayerLocks(ids.length > 0 ? ids : globalKeys(), fn);
  }

  // ---------- 派生索引合并写（P7-6 修复 2 的配套） ----------
  // index.json 是**派生**数据（可重建，§5.6/§6.4 步骤 2），且只在 open() 时从磁盘读取。
  //   实测单次原子写 ≈7ms（50 玩家、深拷贝 + pretty 序列化 + fsync），占单场结算成本的一半以上。
  //   运行期改为"标脏 + 微任务合并落盘"；open()/close()/index.save()/rebuildIndex()/recover() 一律
  //   **立即**落盘 —— 对外可观察语义（"操作返回后索引文件已是最新"）只在维护/生命周期接口上被依赖。
  let indexDirty = false;
  let indexFlushScheduled = false;

  function flushIndexNow() {
    indexDirty = false;
    fsatomic.writeJsonAtomicSync(indexPath, index.toJSON(), { logger: log, pretty: true });
    return indexPath;
  }

  function saveIndex() {
    indexDirty = true;
    if (!indexFlushScheduled) {
      indexFlushScheduled = true;
      setImmediate(() => {
        indexFlushScheduled = false;
        if (!indexDirty) return;
        try {
          flushIndexNow();
        } catch (err) {
          // 派生索引写失败不得让进程崩：journal + 档案仍是真源，重启时按 §6.4 步骤 2 重建
          log.error('store', 'store.error', `派生索引合并落盘失败（可重建，不阻断）：${err && err.message}`, {
            file: indexPath, code: err && err.code ? err.code : null,
          });
        }
      });
    }
    return indexPath;
  }

  // ---------- 档案读写（§6.6 原子写；§5.7 迁移） ----------
  function readArchiveRaw(playerId) {
    const cached = cacheGet(playerId);
    if (cached) return cached;
    const file = playerArchivePath(playerId);
    if (!fsatomic.pathExists(file)) return null;
    const raw = fsatomic.readJsonSync(file, undefined); // 损坏 → store_corrupt
    const migrated = archiveMod.migrateArchive(raw, { logger: log });
    archiveMod.assertArchiveInvariants(migrated.archive, { config: serviceConfig });
    cacheSet(playerId, migrated.archive);
    stats.reads += 1;
    log.trace('store', 'store.read', `读取档案 ${playerId}（seq=${migrated.archive.record.appliedSeq}）`, {
      playerId, seq: migrated.archive.record.appliedSeq,
    });
    if (migrated.migrated) {
      // 升级后立即原子写回（§5.7）
      writeArchiveRaw(migrated.archive);
      saveIndex();
    }
    return migrated.archive;
  }

  function writeArchiveRaw(archive, writeOpts) {
    const o = writeOpts || {};
    if (o.touch !== false) archive.updatedAt = nowFn();
    const file = playerArchivePath(archive.playerId);
    fsatomic.ensureDir(path.dirname(file));
    fsatomic.writeJsonAtomicSync(file, archive, { logger: log });
    const stat = fsatomic.statSafe(file);
    index.upsert(archive, stat ? stat.mtimeMs : null);
    // 缓存私有副本：调用方持有的对象后续被修改也不会污染缓存（读改写路径必须先 clone，见 readArchiveForUpdate）
    cacheSet(archive.playerId, deepClone(archive));
    stats.writes += 1;
    log.debug('store', 'store.write', `档案落盘 ${archive.playerId}（seq=${archive.record.appliedSeq}）`, {
      playerId: archive.playerId, seq: archive.record.appliedSeq,
    });
    return archive;
  }

  // 读→改→写路径专用：返回**深拷贝**，保证"校验失败/写失败"时不污染缓存（§6.6 不变量在保存前后各断言一次）
  function readArchiveForUpdate(playerId) {
    const archive = readArchiveRaw(playerId);
    return archive ? deepClone(archive) : null;
  }

  function listPlayerIds() {
    const out = [];
    for (const shard of fsatomic.listDirFiles(playersDir)) {
      if (!shard.isDirectory()) continue;
      for (const file of fsatomic.listDirFiles(path.join(playersDir, shard.name))) {
        if (file.isFile() && file.name.endsWith('.json') && !file.name.includes(fsatomic.TMP_MARK)) {
          out.push(file.name.slice(0, -5));
        }
      }
    }
    return out.sort();
  }

  function quarantineArchive(playerId, err) {
    const file = playerArchivePath(playerId);
    if (!fsatomic.pathExists(file)) return null;
    const target = `${file}.corrupt-${nowFn()}`;
    try {
      fsatomic.renameSafe(file, target);
    } catch (renameErr) {
      log.error('store', 'store.error', `损坏档案改名失败: ${playerId}`, { code: renameErr.code || null });
      return null;
    }
    cacheDelete(playerId);
    index.remove(playerId);
    stats.quarantined += 1;
    log.error('store', 'store.error', `档案损坏已隔离: ${playerId}（${err && err.message}）`, {
      playerId, file: target, code: err && err.code ? err.code : null,
    });
    return target;
  }

  function rebuildIndexFromArchives(archives) {
    index.rebuild(archives, nowFn());
  }

  function rebuildIndex() {
    const ids = listPlayerIds();
    const archives = [];
    for (const playerId of ids) {
      try {
        const archive = readArchiveRaw(playerId);
        if (archive) archives.push(archive);
      } catch (err) {
        if (recoveryMod.isFatalArchiveError(err)) throw err;
        quarantineArchive(playerId, err);
      }
    }
    index.rebuild(archives, nowFn());
    flushIndexNow(); // 修复类操作：索引立即落盘（重建结果必须可被磁盘观察）
    return index.stats();
  }

  // 重建"派生内存状态"：快照引用计数 + 墓碑水位（都只依赖 journal，§9.2/D-134）
  function rebuildDerivedState() {
    const records = journal.readAll({ includeCheckpoints: false });
    for (const record of records) {
      if (record.type === 'player.removed' && typeof record.playerId === 'string' && Number.isInteger(record.seq)) {
        const prev = removedAt.get(record.playerId);
        if (prev === undefined || record.seq > prev) removedAt.set(record.playerId, record.seq);
      }
    }
    return { ...snapshots.rebuildRefs(records), removed: removedAt.size };
  }

  // ---------- journal apply（§6.3 幂等） ----------
  function archiveFromRecord(record, playerId) {
    if (record.type === 'account.created' || record.type === 'admin.bot.injected' || record.type === 'checkpoint') {
      return archiveMod.createArchiveShell(playerId, Number.isInteger(record.at) ? record.at : nowFn());
    }
    return null;
  }

  // 在给定玩家的写队列内应用一条记录（调用方负责队列；返回 applied|skipped|missing）
  //   opts.deferWrite（P7-6 修复 2）：批次内只更新内存态（cache 拥有该对象），批次结束由
  //   flushPendingArchiveWrites() 每玩家**只落盘一次**（排位一轮 10 场 = 攻方档案 10 次写 → 1 次写）。
  //   安全性：批次持有该玩家全部参与锁，期间没有其他写者；崩溃时 journal 仍是真源（§6.4）。
  async function applyForPlayer(record, playerId, opts) {
    const deferWrite = !!(opts && opts.deferWrite === true);
    // 墓碑（player.removed）：删档案文件 + 失效缓存 + 摘索引 + 记墓碑水位（可重放、幂等）
    if (record.type === 'player.removed') {
      const prev = removedAt.get(playerId);
      if (prev !== undefined && prev >= record.seq) {
        stats.skipped += 1;
        return 'skipped';
      }
      const file = playerArchivePath(playerId);
      const removed = fsatomic.removeFileSafe(file);
      cacheDelete(playerId);
      const inIndex = index.remove(playerId);
      removedAt.set(playerId, record.seq);
      index.setSeq(record.seq);
      stats.applies += 1;
      log.info('store', 'store.player.removed',
        `档案已删除（墓碑 seq=${record.seq}${record.reason ? `，原因 ${record.reason}` : ''}）`,
        { playerId, seq: record.seq, reason: record.reason || null, fileRemoved: removed, indexRemoved: inIndex });
      return 'applied';
    }
    let archive = readArchiveForUpdate(playerId); // 深拷贝：不变量校验失败时不污染缓存
    if (!archive) {
      // 墓碑守卫：seq 小于墓碑的历史记录不得重建档案（journal 全量重放不复活，D-134）
      const tomb = removedAt.get(playerId);
      if (tomb !== undefined && tomb > record.seq) {
        stats.skipped += 1;
        return 'skipped';
      }
      archive = archiveFromRecord(record, playerId);
      if (!archive) {
        log.error('store', 'store.error',
          `journal 记录 ${record.type}#${record.seq} 涉及的档案 ${playerId} 不存在且本类型无法创建`,
          { playerId, seq: record.seq, type: record.type });
        return 'missing';
      }
      if (tomb !== undefined && record.seq > tomb) removedAt.delete(playerId); // 墓碑之后重新注册 → 解禁
    }
    // 幂等快路径（§6.3）：水位只做加速 —— 命中水位区间时必须再有**内容级幂等键**证明已应用；
    //   证明不了（例如并发交错导致水位被更高 seq 推前，而本记录从未 apply）→ **补 apply**，绝不丢弃。
    if (archive.record.appliedSeq >= record.seq) {
      if (archiveMod.isRecordApplied(archive, record)) {
        stats.skipped += 1;
        return 'skipped';
      }
      stats.reapplied += 1;
      log.info('store', 'store.recover',
        `水位缺口补 apply：${record.type}#${record.seq}（档案水位 ${archive.record.appliedSeq}）`,
        { playerId, seq: record.seq, appliedSeq: archive.record.appliedSeq, type: record.type, reason: 'watermark_gap' });
    }
    const res = await archiveMod.applyRecordToArchive(archive, record, playerId, ctx());
    // 水位：只允许前进（补 apply 不回退水位）；同一玩家两条并发记录交错时可能留下"水位 > 某些已应用 seq"
    //   的形态，这是允许的 —— 幂等由 isRecordApplied 的内容键保证（P7-6 修复）。
    if (record.seq > archive.record.appliedSeq) archive.record.appliedSeq = record.seq;
    if (res.changed) archive.updatedAt = Number.isInteger(record.at) ? record.at : nowFn();
    archiveMod.assertArchiveInvariants(archive, { config: serviceConfig });
    if (deferWrite) {
      pendingArchiveWrites.set(playerId, archive);
      cacheSet(playerId, archive);
    } else {
      writeArchiveRaw(archive, { touch: false });
    }
    stats.applies += 1;
    if (record.type === 'battle.recorded') {
      const part = record.p1 && record.p1.playerId === playerId ? record.p1 : record.p2;
      if (part && part.snapshotHash) snapshots.ref(part.snapshotHash, 1);
    }
    return 'applied';
  }

  // 批次内延迟落盘的玩家档案：每玩家只写一次（调用方持有其参与锁）
  function flushPendingArchiveWrites() {
    if (pendingArchiveWrites.size === 0) return 0;
    const entries = [...pendingArchiveWrites.entries()];
    pendingArchiveWrites.clear();
    for (const [, archive] of entries) writeArchiveRaw(archive, { touch: false });
    return entries.length;
  }

  // 批量 apply 的**内部实现**（调用方必须已持有全部参与玩家的锁；不得在此再加锁，避免自锁）
  async function applyRecordsLocked(records, opts) {
    const o = opts || {};
    const list = records || [];
    let applied = 0;
    let recordsApplied = 0;
    try {
      for (const record of list) {
        archiveMod.validateRecord(record);
        const involved = archiveMod.playersOfRecord(record);
        let allKnown = involved.length > 0;
        let touched = 0;
        for (const playerId of involved) {
          const status = await applyForPlayer(record, playerId, o);
          if (status === 'applied') { applied += 1; touched += 1; }
          if (status === 'missing') allKnown = false;
        }
        if (touched > 0) recordsApplied += 1;
        if (allKnown) index.setSeq(record.seq); // 全局水位：所有参与方都已在/超过该 seq
      }
    } finally {
      // 即使中途抛错也要把内存里已完成的变更落盘（journal 已 append，绝不能"只改了内存"）
      if (o.deferWrite === true) flushPendingArchiveWrites();
    }
    if (list.length > 0) saveIndex();
    return { applied, count: list.length, recordsApplied };
  }

  // 公开入口：按**参与玩家集合**加锁（同一玩家串行、不同玩家并行）
  async function applyRecords(records) {
    const players = participantsOf(records);
    return withPlayerLocks(players.length > 0 ? players : globalKeys(), () => applyRecordsLocked(records));
  }

  async function appendAndApply(records) {
    const players = participantsOf(records);
    return withPlayerLocks(players.length > 0 ? players : globalKeys(), async () => {
      const appended = await journal.appendMany(records);
      const res = await applyRecordsLocked(appended, { deferWrite: true });
      return { records: appended, applied: res.applied };
    });
  }

  // ---------- 高层事务方法（后续 auth/account/quickmatch/ranked 直接调用） ----------

  async function createAccount(input) {
    const o = input || {};
    const playerId = o.playerId || archiveMod.newPlayerId();
    const publicId = o.publicId || archiveMod.newPublicId();
    const at = Number.isInteger(o.at) ? o.at : nowFn();
    const record = ledger.buildAccountRecord({
      playerId, publicId, nickname: o.nickname, auth: o.auth, at, createdAt: at,
      tier: o.tier, points: o.points, slot: o.slot,
      // D-159：注册即发 starter（服务端权威仓库正文 + 多槽：slot1 完整出战、slot2/3 空）
      warehouse: o.warehouse,
      slots: o.slots,
      aiLibrary: o.aiLibrary,
      // isBot 便捷入口（§7.6 bot 账号：普通档案 + flags.isBot，被抽时 rating/tier 冻结）
      flags: o.flags === undefined && o.isBot ? { isBot: true } : o.flags,
    });
    await appendAndApply([record]);
    return loadArchive(playerId);
  }

  async function setPasswordHash(input) {
    const o = input || {};
    const record = ledger.buildPasswordRecord({ playerId: o.playerId, auth: o.auth, at: nowFn() });
    await appendAndApply([record]);
    return loadArchive(o.playerId);
  }

  async function setBanned(input) {
    const o = input || {};
    const record = ledger.buildBanRecord({ playerId: o.playerId, banned: o.banned !== false, reason: o.reason, at: nowFn() });
    await appendAndApply([record]);
    if (record.type === 'account.banned') sessions.revokePlayer(o.playerId);
    return loadArchive(o.playerId);
  }

  async function setNickname(input) {
    const o = input || {};
    if (!archiveMod.isValidNickname(o.nickname)) {
      throw new StoreError('bad_request', '昵称需 1~16 字符', [
        { path: 'nickname', code: 'bad_request', message: '昵称需 1~16 字符' },
      ]);
    }
    const record = ledger.buildNicknameRecord({ playerId: o.playerId, nickname: o.nickname, at: nowFn() });
    await appendAndApply([record]);
    return loadArchive(o.playerId);
  }

  async function setPool(input) {
    const o = input || {};
    const record = ledger.buildPoolRecord({ playerId: o.playerId, inPool: o.inPool !== false, at: nowFn() });
    await appendAndApply([record]);
    return loadArchive(o.playerId);
  }

  // 冻结快照。`extras.warehouse`（缺口 1）：本次冻结**校验所用的仓库镜像**——只把其中该配置
  //   实际引用到的插件项（archive.warehouseExcerpt，有界）随快照正文落盘，使对局/回放不再依赖
  //   进程内镜像缓存（重启/淘汰后仍可用）。缺省 undefined → 快照形状与旧版逐字节一致。
  function freezeSnapshot(loadout, versionOverride, extras) {
    if (!loadout || typeof loadout !== 'object' || Array.isArray(loadout)) {
      throw new StoreError('loadout_invalid', '配置必须是对象（loadout = {role, skills[3], ai}）', [
        { path: 'loadout', code: 'loadout_invalid', message: 'loadout 必须是对象' },
      ]);
    }
    const wh = extras && extras.warehouse ? extras.warehouse : null;
    const excerpt = wh ? archiveMod.warehouseExcerpt(loadout, wh) : null;
    if (wh && !excerpt && archiveMod.loadoutRefs(loadout).length > 0) {
      // 有装配引用却取不到任何引用项（理论上不可能：调用方已通过引用完整性校验）→ 显式留痕，不静默丢
      log.warn('store', 'store.snapshot.write',
        '仓库镜像未能提取装配引用子集（快照不携带镜像，重启后退化为基准面板）',
        { refs: archiveMod.loadoutRefs(loadout).length });
    }
    const built = snapMod.buildSnapshot({
      loadout,
      engineVersion: (versionOverride && versionOverride.engine) || versions.engine,
      dataVersion: (versionOverride && versionOverride.data) || versions.data,
      frozenAt: nowFn(),
      warehouse: excerpt,
    });
    const stored = snapshots.put(built);
    if (stored.snapshot.configHash !== built.configHash) {
      // 同内容 + 不同版本戳（内容寻址去重保留首个版本）：回放侧以记录版本戳判定可复现性
      log.warn('store', 'store.snapshot.write',
        `快照已存在但版本戳不同（保留首个）：${built.hash.slice(0, 15)}…`,
        { hash: built.hash, keptEngine: stored.snapshot.engineVersion, newEngine: built.engineVersion });
    }
    return stored.snapshot;
  }

  // 在写队列内部完成"冻结 → journal → apply"（PUT /me/configs/:slotId，§5.4）
  // D-160：**非出战槽允许不完整** —— 不完整时冻结快照并把 loadout 正文随记录携带；
  //   出战槽仍要求完整（角色 + 恰 3 技能 + AI），不完整 → loadout_invalid + 逐位置 details。
  async function saveConfigSlot(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      const slot = archiveMod.findSlot(archive, o.slotId);
      if (!slot) throw new StoreError('slot_not_found', `槽 ${o.slotId} 不存在`);
      if (Number.isInteger(o.baseUpdatedAt) && slot.updatedAt !== o.baseUpdatedAt) {
        throw new StoreError('config_conflict', '配置已被其他请求修改（乐观锁 baseUpdatedAt 不匹配）', [
          { path: 'baseUpdatedAt', code: 'config_conflict', message: `期望 ${slot.updatedAt}，收到 ${o.baseUpdatedAt}` },
        ]);
      }
      const isActive = archive.configs.activeSlotId === slot.slotId;
      const loadout = o.loadout === undefined || o.loadout === null ? archiveMod.emptyIncompleteLoadout() : o.loadout;
      const missing = archiveMod.loadoutMissingOf(loadout);
      let snapshot = null;
      let record;
      if (missing.length > 0) {
        if (isActive) {
          throw new StoreError('loadout_invalid', '出战配置必须完整（角色 + 恰 3 技能 + AI；允许插槽为空）', missingDetails(missing));
        }
        record = ledger.buildConfigRecord({
          playerId: o.playerId, slotId: slot.slotId, name: o.name, at: nowFn(),
          loadout, activate: false,
          versions: { engine: versions.engine, data: versions.data },
        });
      } else {
        snapshot = freezeSnapshot(loadout, o.versions, { warehouse: o.warehouse });
        record = ledger.buildConfigRecord({
          playerId: o.playerId, slotId: slot.slotId, name: o.name, at: nowFn(),
          snapshotHash: snapshot.hash, configHash: snapshot.configHash,
          activate: o.activate === true, warehouseVerified: o.warehouseVerified === true,
          versions: { engine: versions.engine, data: versions.data },
        });
      }
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      const updated = readArchiveRaw(o.playerId);
      return { archive: deepClone(updated), snapshot, slot: deepClone(archiveMod.findSlot(updated, slot.slotId)) };
    });
  }

  // 下一个空闲槽 id：checkSlotLimit 已保证 slots.length < maxSlots，故 1..maxSlots 内必有空位
  function nextSlotId(archive) {
    const prefix = (serviceConfig.config && serviceConfig.config.slotIdPrefix) || 'slot';
    const maxSlots = archiveMod.maxSlotsOf(serviceConfig);
    for (let i = 1; i <= maxSlots; i += 1) {
      const candidate = `${prefix}${i}`;
      if (!archiveMod.findSlot(archive, candidate)) return candidate;
    }
    throw new StoreError('slot_limit', `配置槽已满（${maxSlots}）`);
  }

  // D-160 缺项 → details（唯一实现见 archive.loadoutMissingDetails；本层不重复文案）
  function missingDetails(missing) {
    return archiveMod.loadoutMissingDetails(missing);
  }

  // 新建槽（POST /me/configs）：D-160 起**默认建空槽**（不再复制出战配置；出战仍由 activate 决定）
  async function createConfigSlot(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      archiveMod.checkSlotLimit(archive, serviceConfig);
      const slotId = nextSlotId(archive);
      const loadout = o.loadout === undefined || o.loadout === null ? archiveMod.emptyIncompleteLoadout() : o.loadout;
      const missing = archiveMod.loadoutMissingOf(loadout);
      let snapshot = null;
      if (missing.length === 0) snapshot = freezeSnapshot(loadout, o.versions, { warehouse: o.warehouse });
      const record = ledger.buildConfigRecord({
        playerId: o.playerId, slotId, name: o.name === undefined ? slotId : o.name, at: nowFn(),
        snapshotHash: snapshot ? snapshot.hash : undefined,
        configHash: snapshot ? snapshot.configHash : undefined,
        loadout: snapshot ? undefined : loadout,
        create: true, activate: false, isDefault: false,
        warehouseVerified: o.warehouseVerified === true,
        versions: { engine: versions.engine, data: versions.data },
      });
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      const updated = readArchiveRaw(o.playerId);
      return { archive: deepClone(updated), snapshot, slot: deepClone(archiveMod.findSlot(updated, slotId)) };
    });
  }

  // D-160：**设为出战**时才校验完整性（角色 + 恰 3 技能 + AI；允许插槽为空）
  async function activateConfigSlot(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      const slot = archiveMod.findSlot(archive, o.slotId);
      if (!slot) throw new StoreError('slot_not_found', `槽 ${o.slotId} 不存在`);
      const missing = archiveMod.loadoutMissingOf(slot.loadout);
      if (missing.length > 0) {
        throw new StoreError('cannot_activate_incomplete',
          `配置 ${o.slotId} 不完整，无法设为出战（角色 + 恰 3 技能 + AI；允许插槽为空）`,
          missingDetails(missing).map((d) => ({ ...d, code: 'cannot_activate_incomplete' })));
      }
      // 自愈：完整但缺快照（如检查点重建后的档案）→ 现场冻结一次
      let snapshot = slot.snapshot;
      if (!snapshot || !snapshot.hash) snapshot = freezeSnapshot(slot.loadout, o.versions, {});
      const record = ledger.buildConfigRecord({
        playerId: o.playerId, slotId: slot.slotId, at: nowFn(),
        snapshotHash: snapshot.hash, configHash: snapshot.configHash, activate: true,
        versions: { engine: versions.engine, data: versions.data },
      });
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      const updated = readArchiveRaw(o.playerId);
      return { archive: deepClone(updated), slot: deepClone(archiveMod.findSlot(updated, slot.slotId)), snapshot };
    });
  }

  async function deleteConfigSlot(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      archiveMod.checkSlotDeletable(archive, o.slotId);
      const record = ledger.buildConfigRecord({ playerId: o.playerId, slotId: o.slotId, deleted: true, at: nowFn() });
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      return { archive: deepClone(readArchiveRaw(o.playerId)) };
    });
  }

  // ranked：双轨（D-132/D-133）——段位变化只由 ranked.promoted 记录驱动，战斗记录只落战绩。
  function normalizeRankedSides(record) {
    if (record.mode !== 'ranked') return record;
    for (const side of ['p1', 'p2']) {
      const part = record[side];
      if (!part) continue;
      part.pointsAfter = part.pointsBefore;
      part.tierAfter = part.tierBefore;
    }
    return record;
  }

  // 结算入参规范化：深拷贝（不原地改写调用方对象）+ 排位双轨规整
  function prepareBattleInput(input) {
    const prepared = input && input.type === 'battle.recorded'
      ? deepClone(input)
      : ledger.buildBattleRecord(input || {});
    return normalizeRankedSides(prepared);
  }

  // ---------- P7-6 修复 1 的兜底：把"锁外读到的旧档案"换成锁内当前值重算 ----------
  // 缺陷（可复现）：调用方（quickmatch/ranked）在**锁外**读档案算 pointsBefore/pointsAfter。同一玩家
  //   在两个并发请求里被结算时（自己发起快速对战 + 自己被别人抽为防守方；或排位一轮进行中积分被并发改写），
  //   两条记录会基于同一个旧 pointsBefore 各算一份 δ，后 apply 的覆盖先 apply 的 ⇒
  //     · journal ΣΔ(664) > 档案 ΣΔ(536)（P7-6 50 人实测；12 人小规模掩盖）
  //     · 档案 rating.points ≠ journal 末值（ranked 记录仍写旧 pointsAfter）
  // 本层修法：持有参与集合锁后**重取双方档案**；只要某个非 bot 参与方的当前积分 ≠ 记录声明的
  //   pointsBefore（能证明"这条记录基于旧档案"），就在锁内用当前档案值重算整场结算，再 append。
  // 只在"能证明陈旧"时重算 ⇒ 顺序路径与既有单测/契约用例的手工数值**逐字节不变**。
  // 再加一道闸（P7-4 ME-4 回归）：仅当记录声明的 pointsBefore/pointsAfter **本身符合该模式的标准
  //   结算口径**（quick → ledger 公式逐侧相符；ranked → 双轨 Δ=0）才补正。手工写入的非公式值
  //   （管理端/测试夹具）一律视为权威值原样落账 —— 避免把"业务上刻意的数值"当成陈旧读改写。
  // 调用方契约（更强、推荐）：把"读档案 → 算 δ → settle"整体放进
  //   `store.withSettlementLock([p1, p2], fn)` + 锁内 `store.settleBattleLocked(...)`，
  //   或直接用 `store.settleBatch(records)`；此时本兜底永不触发（stats().reconciled === 0）。
  function reconcileStaleSettlement(record) {
    if (!record || record.type !== 'battle.recorded') return false;
    const mode = record.mode === 'ranked' ? 'ranked' : 'quick';
    const sides = [];
    for (const side of ['p1', 'p2']) {
      const part = record[side];
      if (!part || typeof part.playerId !== 'string' || part.playerId === '') return false;
      if (sides.some((s) => s.part.playerId === part.playerId)) return false; // 自战（异常数据）→ 不重算
      const archive = readArchiveForUpdate(part.playerId);
      if (!archive) return false; // 档案缺失：交给既有的 missing 路径
      sides.push({ side, part, archive });
    }
    const declared = (part) => (Number.isInteger(part.pointsBefore) ? part.pointsBefore : 0);
    const declaredAfter = (part) => (Number.isInteger(part.pointsAfter) ? part.pointsAfter : declared(part));
    const fresh = (s) => (s.archive.flags.isBot === true ? declared(s.part) : s.archive.rating.points);
    const stale = sides.some((s) => fresh(s) !== declared(s.part));
    if (!stale) return false;
    if (mode === 'quick') {
      const b1 = declared(sides[0].part);
      const b2 = declared(sides[1].part);
      const e1 = ledger.ratingDelta({ points: b1, opponentPoints: b2, result: sides[0].part.result, config: ratingConfig });
      const e2 = ledger.ratingDelta({ points: b2, opponentPoints: b1, result: sides[1].part.result, config: ratingConfig });
      const formulaConsistent = e1.pointsAfter === declaredAfter(sides[0].part)
        && e2.pointsAfter === declaredAfter(sides[1].part);
      if (!formulaConsistent) return false; // 非公式值（手工/管理端/夹具）→ 原样落账，不补正
    }
    if (mode === 'quick') {
      const winner = record.verdict && (record.verdict.winner === 'p1' || record.verdict.winner === 'p2')
        ? record.verdict.winner : 'draw';
      const settled = ledger.settleRating({
        p1Points: sides[0].archive.rating.points,
        p2Points: sides[1].archive.rating.points,
        winner, config: ratingConfig,
      });
      for (let i = 0; i < sides.length; i += 1) {
        const s = sides[i];
        if (s.archive.flags.isBot === true) continue; // bot 积分/段位冻结（§7.6）：保留调用方原值
        const next = i === 0 ? settled.p1 : settled.p2;
        s.part.pointsBefore = s.archive.rating.points;
        s.part.pointsAfter = next.pointsAfter;
        s.part.tierBefore = s.archive.progress.tier;
        s.part.tierAfter = s.archive.progress.tier;
      }
    } else {
      for (const s of sides) {
        if (s.archive.flags.isBot === true) continue;
        s.part.pointsBefore = s.archive.rating.points;
        s.part.pointsAfter = s.archive.rating.points; // 排位不改积分（D-132/D-133）
        s.part.tierBefore = s.archive.progress.tier;
        s.part.tierAfter = s.archive.progress.tier;
      }
    }
    stats.reconciled += 1;
    log.info('store', 'store.recover',
      `结算陈旧读补正：${record.battleId || '(no id)'} 的 pointsBefore 已被并发结算推进，锁内以当前档案值重算`,
      {
        battleId: record.battleId || null, mode, type: record.type, reason: 'stale_settlement_reconciled',
        p1: { playerId: sides[0].part.playerId, pointsBefore: sides[0].part.pointsBefore, pointsAfter: sides[0].part.pointsAfter },
        p2: { playerId: sides[1].part.playerId, pointsBefore: sides[1].part.pointsBefore, pointsAfter: sides[1].part.pointsAfter },
      });
    return true;
  }

  // 锁内批量结算（调用方已持有全部参与玩家的锁）：
  //   battleId 去重 → appendMany（**一次**落盘/group commit）→ applyRecordsLocked（每玩家档案**一次**落盘）
  //   幂等：已在 journal 的 battleId 直接回放既有记录，不重复写、不重复记账（§9.1）
  async function settleBatchLocked(inputs) {
    const list = inputs || [];
    const entries = new Array(list.length);
    const pending = [];
    let duplicates = 0;
    for (let i = 0; i < list.length; i += 1) {
      const prepared = prepareBattleInput(list[i]);
      const existing = prepared.battleId ? journal.findBattle(prepared.battleId) : null;
      if (existing) {
        duplicates += 1;
        entries[i] = { record: existing, duplicate: true };
        continue;
      }
      reconcileStaleSettlement(prepared);
      pending.push({ index: i, record: prepared });
      entries[i] = { record: prepared, duplicate: false, pending: true };
    }
    let applied = 0;
    if (pending.length > 0) {
      const appended = await journal.appendMany(pending.map((p) => p.record));
      // applyRecordsLocked 内部已 saveIndex()（合并写）
      const res = await applyRecordsLocked(appended, { deferWrite: true });
      applied = res.applied;
      for (let k = 0; k < appended.length; k += 1) entries[pending[k].index].record = appended[k];
    } else {
      saveIndex(); // 纯重复：不写 journal，但索引回写仍幂等
    }
    return {
      records: entries.map((e) => e.record),
      duplicateFlags: entries.map((e) => e.duplicate === true),
      applied, count: list.length, duplicates,
    };
  }

  // B 类事务：先 append journal（一次落盘即成立）→ 再 apply 双方档案（§6.1/D-134）
  // 调用方契约：`pointsBefore/pointsAfter` 由调用方计算；若希望"同一玩家的多次并发结算"积分守恒
  //   （ΣΔ(journal) === ΣΔ(档案)）且档案末值与 journal 末值一致，请：
  //     ① 用 `store.settleBatch(records)`（一轮多场；一次 appendMany + 一次 apply，锁只获取一次），或
  //     ② 把"读档案 → 算 δ → settle"整体放进 `store.withSettlementLock([p1, p2], fn)`，
  //        锁内用 `store.settleBattleLocked(record)`（避免自锁）。
  //   只调 settleBattle 也能保证**每场双方记账一份不少**（本层保证），并在检测到"调用方读到旧档案"时
  //   于锁内重算补正（reconcileStaleSettlement）；但调用方拿到的 Elo 明细会是重算后的值。
  async function settleBattleLocked(input) {
    const res = await settleBatchLocked([input]);
    return { record: res.records[0], applied: res.applied, duplicate: res.duplicates === 1 };
  }

  async function settleBattle(input) {
    const players = participantIdsOf(input && input.type === 'battle.recorded' ? input : (input || {}));
    return withPlayerLocks(players.length > 0 ? players : globalKeys(), () => settleBattleLocked(input));
  }

  // 批量结算原语（P7-6 修复 2）：一轮 N 场 = 1 次加锁 + 1 次 appendMany + 1 次 apply（每玩家档案 1 次落盘）
  async function settleBatch(records) {
    const players = participantsOf(records);
    return withPlayerLocks(players.length > 0 ? players : globalKeys(), () => settleBatchLocked(records));
  }

  async function touchLastSeen(playerId, at) {
    const res = await updateArchive(playerId, (archive) => {
      archive.lastSeenAt = Number.isInteger(at) ? at : nowFn();
      archive.lastLoginAt = archive.lastSeenAt;
      return null;
    });
    return res.archive;
  }

  async function markRecordsSeen(input) {
    const o = input || {};
    const res = await updateArchive(o.playerId, (archive) => archiveMod.markSeen(archive, o.uptoSeq));
    return res.archive;
  }

  // ---------- 读取视图 ----------
  function recordEntryFor(record, playerId) {
    const side = record.p1 && record.p1.playerId === playerId ? 'p1' : 'p2';
    const mine = record[side];
    const foe = record[side === 'p1' ? 'p2' : 'p1'];
    const role = mine.role === 'defender' ? 'defender' : 'attacker';
    const pointsBefore = Number.isInteger(mine.pointsBefore) ? mine.pointsBefore : 0;
    const pointsAfter = Number.isInteger(mine.pointsAfter) ? mine.pointsAfter : pointsBefore;
    return {
      battleId: record.battleId, seq: record.seq, mode: record.mode, role,
      opponentPublicId: foe && foe.publicId ? foe.publicId : null, mySide: side,
      result: mine.result, reason: record.verdict ? record.verdict.reason : null,
      ticks: record.verdict ? record.verdict.ticks : null, pointsDelta: pointsAfter - pointsBefore,
      tierBefore: mine.tierBefore, tierAfter: mine.tierAfter, seed: record.seed, at: record.at, seen: true,
    };
  }

  // 战绩查询（§7.5）：since 缺省 = 档案未读游标；完整历史来自 journal（recent 只是环形缓存）
  async function listRecords(playerId, query) {
    const q = query || {};
    const archive = readArchiveRaw(playerId);
    if (!archive) throw new StoreError('store_not_found', `档案 ${playerId} 不存在`);
    const since = Number.isInteger(q.since) ? q.since : archive.record.unread.fromSeq;
    const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 20;
    const role = q.role === 'attack' || q.role === 'defense' ? q.role : null;
    const buf = [];
    const seenBattles = new Set();
    await journal.replay({ fromSeq: since, includeCheckpoints: false }, (record) => {
      if (record.type !== 'battle.recorded') return;
      if (record.p1.playerId !== playerId && record.p2.playerId !== playerId) return;
      if (record.battleId && seenBattles.has(record.battleId)) return; // 历史遗留重复记录防御
      const entry = recordEntryFor(record, playerId);
      if (role === 'attack' && entry.role !== 'attacker') return;
      if (role === 'defense' && entry.role !== 'defender') return;
      if (record.battleId) seenBattles.add(record.battleId);
      buf.push(entry);
      if (buf.length > limit) buf.shift();
    });
    for (const entry of buf) entry.seen = entry.seq <= archive.record.unread.fromSeq;
    return buf;
  }

  async function defenseSummary(playerId, query) {
    const archive = readArchiveRaw(playerId);
    if (!archive) throw new StoreError('store_not_found', `档案 ${playerId} 不存在`);
    return archiveMod.defenseSummaryOf(archive, query);
  }

  async function getSummary(playerId) {
    const archive = readArchiveRaw(playerId);
    if (!archive) throw new StoreError('store_not_found', `档案 ${playerId} 不存在`);
    return archiveMod.summaryOf(archive);
  }

  function opponentWindow(playerId, hours, at) {
    const archive = archiveCache.get(playerId);
    if (!archive) return new Set();
    return archiveMod.recentOpponents(archive, hours, Number.isInteger(at) ? at : nowFn());
  }

  // ---------- 公开档案 API ----------
  async function loadArchive(playerId) {
    if (typeof playerId !== 'string' || playerId === '') throw new StoreError('bad_request', 'loadArchive 需要 playerId');
    const archive = readArchiveRaw(playerId);
    return archive ? deepClone(archive) : null;
  }

  async function saveArchive(archive) {
    if (!archive || typeof archive.playerId !== 'string') throw new StoreError('bad_request', 'saveArchive 需要完整档案');
    archiveMod.assertArchiveInvariants(archive, { config: serviceConfig });
    return queueFor(archive.playerId, async () => {
      const cached = archiveCache.get(archive.playerId);
      if (cached && cached.record.appliedSeq > archive.record.appliedSeq) {
        archive.record.appliedSeq = cached.record.appliedSeq; // 单调水位：不允许回退
      }
      writeArchiveRaw(archive);
      saveIndex();
      return deepClone(archive);
    });
  }

  async function updateArchive(playerId, mutator, updateOpts) {
    const o = updateOpts || {};
    return queueFor(playerId, async () => {
      let archive = readArchiveForUpdate(playerId); // 深拷贝：失败不污染缓存
      if (!archive) {
        if (typeof o.create === 'function') archive = o.create(playerId);
        else throw new StoreError('store_not_found', `档案 ${playerId} 不存在`);
      }
      const result = await mutator(archive, ctx());
      archiveMod.assertArchiveInvariants(archive, { config: serviceConfig });
      writeArchiveRaw(archive, { touch: o.touch });
      if (o.saveIndex !== false) saveIndex();
      return { archive: deepClone(archive), result: result === undefined ? null : result };
    });
  }

  // ---------- 生命周期 ----------
  async function open() {
    if (opened) return adapter;
    fsatomic.ensureDir(dataDir);
    fsatomic.ensureDir(playersDir);
    fsatomic.ensureDir(journalDir);
    fsatomic.ensureDir(snapshotsDir);
    if (opts.lock !== false) {
      lock = lockMod.acquireLock({ dataDir, logger: log, now: nowFn });
    }
    try {
      fsatomic.sweepTmpSync(dataDir, log);
      fsatomic.sweepTmpSync(playersDir, log);
      for (const shard of fsatomic.listDirFiles(playersDir)) {
        if (shard.isDirectory()) fsatomic.sweepTmpSync(path.join(playersDir, shard.name), log);
      }
      const journalLoad = journal.load();
      const indexExists = fsatomic.pathExists(indexPath);
      const rawIndex = fsatomic.readJsonSync(indexPath, null);
      let indexLoaded = false;
      if (rawIndex !== null && index.load(rawIndex)) {
        indexLoaded = true;
      } else if (indexExists) {
        log.error('store', 'store.error', '索引损坏（index.json 不可解析或结构非法）→ 进入重建分支', { file: indexPath });
      }
      sessions.load();
      // 启动清理（P7-2 最小加法，§6.7：会话 TTL 过期清理 = 启动一次 + 读时懒清理；§3.4 无定时器）
      sessions.prune(nowFn());
      const report = await recoveryMod.recoverStore({
        journal,
        index,
        logger: log,
        indexLoaded,
        listPlayerIds,
        readArchiveRaw,
        quarantineArchive,
        applyRecords,
        saveIndex,
        rebuildIndexFromArchives,
        rebuildDerivedState,
      });
      flushIndexNow(); // 生命周期边界：索引必须立即落盘（契约：open() 返回后 index.json 已存在）
      opened = true;
      log.info('store', 'store.open',
        `存储层已打开（adapter=${ADAPTER_NAME}，玩家 ${index.size()}，journal seq=${journal.maxSeq()}）`, {
          adapter: ADAPTER_NAME, dataDir, players: index.size(), seq: journal.maxSeq(),
          engineVersion: versions.engine, dataVersion: versions.data,
          truncatedSegments: journalLoad.truncatedSegments, replayed: report.replayed,
        });
      return adapter;
    } catch (err) {
      if (lock) {
        try { lock.release(); } catch (releaseErr) { /* 忽略释放失败 */ }
        lock = null;
      }
      throw err;
    }
  }

  async function close() {
    if (!opened) return false;
    await journal.close();
    flushIndexNow(); // 生命周期边界：合并写必须在关闭前刷干净（重开/崩溃恢复都依赖它）
    sessions.save();
    if (lock) {
      lock.release();
      lock = null;
    }
    opened = false;
    log.info('store', 'store.close', `存储层已关闭（flush 完成，seq=${journal.maxSeq()}）`, {
      adapter: ADAPTER_NAME, seq: journal.maxSeq(), players: index.size(),
    });
    return true;
  }

  function statsOf() {
    return {
      adapter: ADAPTER_NAME,
      dataDir,
      opened,
      seq: journal.maxSeq(),
      indexSeq: index.seq(),
      players: index.size(),
      cache: { size: archiveCache.size, limit: archiveCacheSize, hits: stats.cacheHits, misses: stats.cacheMisses, evictions: stats.evictions },
      queues: queues.size,
      reads: stats.reads,
      writes: stats.writes,
      applies: stats.applies,
      skipped: stats.skipped,
      reapplied: stats.reapplied, // 水位缺口补 apply 次数（P7-6 修复；正常并发下应为 0）
      // 锁内"陈旧读补正"次数（P7-6 修复 1）：调用方在锁外读到旧档案时本层重算整场结算；
      //   用 settleBatch / withSettlementLock 的调用方应恒为 0
      reconciled: stats.reconciled,
      pendingArchives: pendingArchiveWrites.size, // 批次内延迟落盘的档案数（批次结束即为 0）
      quarantined: stats.quarantined,
      journal: journal.stats(),
      snapshots: snapshots.stats(),
      sessions: sessions.stats(),
    };
  }

  // ---------- D-159：服务端权威仓库（读真源 / 开箱发放 / 装配拆卸） ----------

  function warehouseCaps() {
    const cap = archiveMod.warehouseMaxPerBucketOf(serviceConfig);
    const out = {};
    for (const key of archiveMod.WAREHOUSE_BUCKETS) out[key] = cap;
    return out;
  }

  function warehouseView(archive) {
    return {
      warehouse: archiveMod.normalizeWarehouse(archive && archive.warehouse),
      usage: archiveMod.warehouseUsage(archive),
      caps: warehouseCaps(),
      counts: archiveMod.warehouseCounts(archive && archive.warehouse),
      starterIssued: !!(archive && archive.warehouse && archive.warehouse.starterIssued === true),
    };
  }

  async function getWarehouse(playerId) {
    const archive = await loadArchive(playerId);
    if (!archive) throw new StoreError('store_not_found', `档案 ${playerId} 不存在`);
    return warehouseView(archive);
  }

  // 开箱发放：**上限前置校验**（超限 → warehouse_full，不写 journal）→ append(box.opened) → apply
  async function grantBox(input) {
    const o = input || {};
    const items = Array.isArray(o.items) ? o.items : [];
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      const cap = archiveMod.warehouseMaxPerBucketOf(serviceConfig);
      const counts = archiveMod.warehouseCounts(archive.warehouse);
      const add = {};
      for (const it of items) {
        const bucket = it && it.kind === 'skillPlugin' ? 'skillPlugin'
          : it && it.kind === 'rolePlugin' ? 'rolePlugin'
            : it && it.kind === 'skill' ? 'skill' : 'role';
        add[bucket] = (add[bucket] || 0) + 1;
      }
      const details = [];
      for (const key of Object.keys(add)) {
        if ((counts[key] || 0) + add[key] > cap) {
          details.push({
            path: `warehouse.buckets.${key}`, code: 'warehouse_full',
            message: `${key} 已达上限 ${cap}（当前 ${counts[key] || 0}，本次 ${add[key]} 件）`,
          });
        }
      }
      if (details.length > 0) {
        throw new StoreError('warehouse_full', '仓库已满，无法开箱（请先清理）', details);
      }
      const record = ledger.buildBoxRecord({
        playerId: o.playerId, seed: o.seed, tier: o.tier, times: o.times, items, at: nowFn(),
      });
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      const updated = readArchiveRaw(o.playerId);
      return { archive: deepClone(updated), grantId: appended.grantId, ...warehouseView(updated) };
    });
  }

  // 装配/拆卸：**校验在 L6（server/account.js）用 core/items 纯函数前置完成**；本层只落增量记录，
  //   使回放/恢复可确定性重演（记录体积恒定，不携带整仓）。
  async function applyWarehouseChange(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      if (!archiveMod.findWarehouseItem(archive.warehouse, o.targetUid)) {
        throw new StoreError('item_missing', `物品 ${o.targetUid} 不在仓库中`, [
          { path: 'targetUid', code: 'item_missing', message: '物品不存在（可能已被清除）' },
        ]);
      }
      const record = ledger.buildWarehouseRecord({
        playerId: o.playerId, op: o.op, targetUid: o.targetUid, slotIndex: o.slotIndex,
        pluginUid: o.pluginUid, at: nowFn(),
      });
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      const updated = readArchiveRaw(o.playerId);
      return { archive: deepClone(updated), ...warehouseView(updated) };
    });
  }

  // ---------- D-161：AI 库（与物品分别计数） ----------

  function aiView(archive) {
    return {
      items: deepClone((archive && archive.ai && archive.ai.items) || []),
      max: archiveMod.aiMaxPerPlayerOf(serviceConfig),
    };
  }

  // 「被哪些配置引用」：按 loadout.aiId（出战与否都算；删除被**出战**配置引用者由上层拒绝）
  function aiRefsOf(archive) {
    const refs = new Map();
    for (const slot of (archive && archive.configs && archive.configs.slots) || []) {
      const aiId = slot && slot.loadout && slot.loadout.aiId;
      if (typeof aiId !== 'string' || aiId === '') continue;
      if (!refs.has(aiId)) refs.set(aiId, []);
      refs.get(aiId).push(slot.slotId);
    }
    return refs;
  }

  async function listAi(playerId) {
    const archive = await loadArchive(playerId);
    if (!archive) throw new StoreError('store_not_found', `档案 ${playerId} 不存在`);
    return { ...aiView(archive), usage: Object.fromEntries(aiRefsOf(archive)) };
  }

  async function createAi(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      const cap = archiveMod.aiMaxPerPlayerOf(serviceConfig);
      const count = ((archive.ai && archive.ai.items) || []).length;
      if (count >= cap) {
        throw new StoreError('ai_limit', `AI 库已满（${cap} 条），请先删除`, [
          { path: 'ai.items', code: 'ai_limit', message: `最多同时保存 ${cap} 条 AI` },
        ]);
      }
      const aiId = typeof o.aiId === 'string' && o.aiId !== '' ? o.aiId : `ai_${archiveMod.randomHex(8)}`;
      if (archiveMod.findAi(archive, aiId)) {
        throw new StoreError('bad_request', `aiId 重复 ${aiId}`, [
          { path: 'aiId', code: 'bad_request', message: 'aiId 已存在' },
        ]);
      }
      const record = ledger.buildAiRecord({
        playerId: o.playerId, op: 'create', aiId, name: o.name, program: o.program, at: nowFn(),
      });
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      const updated = readArchiveRaw(o.playerId);
      return { archive: deepClone(updated), ai: deepClone(archiveMod.findAi(updated, aiId)) };
    });
  }

  // 删除：被**出战配置**引用 → 409 ai_in_use（非出战配置的引用只作提示，不阻止删除）
  async function deleteAi(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      const ai = archiveMod.findAi(archive, o.aiId);
      if (!ai) {
        throw new StoreError('store_not_found', `AI ${o.aiId} 不存在`, [
          { path: 'aiId', code: 'store_not_found', message: 'AI 不存在' },
        ]);
      }
      const refs = aiRefsOf(archive);
      const slots = refs.get(o.aiId) || [];
      if (slots.includes(archive.configs.activeSlotId)) {
        throw new StoreError('ai_in_use', `AI ${o.aiId} 被出战配置引用，无法删除`, [
          { path: 'aiId', code: 'ai_in_use', message: `被出战配置 ${archive.configs.activeSlotId} 引用` },
        ]);
      }
      const record = ledger.buildAiRecord({ playerId: o.playerId, op: 'delete', aiId: o.aiId, at: nowFn() });
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      const updated = readArchiveRaw(o.playerId);
      return { archive: deepClone(updated), aiId: o.aiId, referencedBy: slots, ...aiView(updated) };
    });
  }

  const adapter = {
    adapterName: ADAPTER_NAME,
    dataDir,
    paths: { playersDir, snapshotsDir, journalDir, indexPath, sessionsPath, lockPath: lockMod.lockPathOf(dataDir) },
    config: serviceConfig,
    ratingConfig,
    versions,
    logger: log, // P7-3 最小加法：L6 业务层（ranked/quickmatch）默认复用适配器的 logger（不新增语义）
    now: nowFn,  // P7-3 最小加法：同上，业务层默认复用适配器的时钟（测试可注入确定性时钟）
    peekNow: () => nowFn(), // P7-3 最小加法：**只读**取当前时间（不推进注入时钟）
    open,
    close,
    isOpen: () => opened,
    // 档案
    loadArchive,
    saveArchive,
    updateArchive,
    listPlayerIds,
    // 删除档案（管理端）：**走 journal 墓碑**（`player.removed`），保证 journal 全量重放不复活已删玩家（D-134）
    //   返回 true = 本次确实删除了（首次删除）；false = 档案本就不存在且无索引条目（幂等，不写墓碑）
    removeArchive: async (playerId, removeOpts) => {
      if (typeof playerId !== 'string' || playerId === '') {
        throw new StoreError('bad_request', 'removeArchive 需要 playerId');
      }
      const o = removeOpts || {};
      // 墓碑的 append 也必须在**该玩家的锁内**（seq 顺序 = 应用顺序，见 withPlayerLocks 注释）
      return withPlayerLocks([playerId], async () => {
        const known = fsatomic.pathExists(playerArchivePath(playerId)) || index.has(playerId);
        if (!known) return false; // 幂等：不存在 → 不产生墓碑（避免无意义 journal 记录）
        const record = ledger.buildRemovedRecord({ playerId, reason: o.reason, at: nowFn() });
        const appended = await journal.append(record);
        await applyRecordsLocked([appended]);
        return true;
      });
    },
    rebuildArchive: async (playerId) => {
      cacheDelete(playerId);
      removedAt.delete(playerId); // 显式重建：清掉本进程内的墓碑水位（journal 墓碑仍在，重启后仍受其约束）
      await recoveryMod.recoverStore({
        journal, index, logger: log, indexLoaded: false,
        listPlayerIds: async () => [playerId],
        readArchiveRaw: async (id) => (id === playerId ? null : readArchiveRaw(id)),
        quarantineArchive,
        applyRecords,
        saveIndex,
        rebuildIndexFromArchives,
        rebuildDerivedState,
      });
      flushIndexNow();
      return loadArchive(playerId);
    },
    getSummary,
    // 账号 / 单玩家（journal 事件）
    createAccount,
    setPasswordHash,
    setBanned,
    setNickname,
    setPool,
    touchLastSeen,
    markRecordsSeen,
    // 配置槽 + 快照
    saveConfigSlot,
    createConfigSlot,
    activateConfigSlot,
    deleteConfigSlot,
    freezeSnapshot,
    // D-159：服务端权威仓库（真源读取 / 开箱发放 / 装配拆卸）
    getWarehouse,
    grantBox,
    applyWarehouseChange,
    // D-161：AI 库
    listAi,
    createAi,
    deleteAi,
    // journal
    append: (record) => journal.append(record),
    appendMany: (records) => journal.appendMany(records),
    applyRecord: async (record) => applyRecords([record]),
    applyRecords,
    settleBattle,             // 单场（按参战双方加锁；自动补正陈旧读，见 reconcileStaleSettlement）
    settleBatch,              // 批量结算原语：一轮 N 场 = 1 次加锁 + 1 次 appendMany + 1 次 apply
    settleBattleLocked,       // 锁内版本（须在 withSettlementLock([...]) 内调用；见 settleBattle 注释的调用方契约）
    withSettlementLock,       // (playerIds|record|fn, fn) → 读档案→算 δ→append→apply 全链在参与集合锁内
    flushIndex: () => flushIndexNow(), // 维护接口：立即把派生索引落盘（运行期默认合并写）
    readRecords: (readOpts) => journal.readAll(readOpts),
    findBattleRecord: async (battleId) => journal.findBattle(battleId),
    replayJournal: (replayOpts, fn) => journal.replay(replayOpts, fn),
    maxSeq: () => journal.maxSeq(),
    compactJournal: (compactOpts) => journal.compact({
      appliedSeq: index.seq(),
      retentionDays: serviceConfig.journal.compactAfterDays,
      aggregate: archiveMod.aggregateRecords,
      at: nowFn(),
      ...(compactOpts || {}),
    }),
    // 战绩视图
    records: listRecords,
    defenseSummary,
    opponentWindow,
    // 索引
    index: {
      snapshot: () => deepClone(index.toJSON()),
      toJSON: () => deepClone(index.toJSON()),
      seq: () => index.seq(),
      get: (playerId) => index.get(playerId),
      has: (playerId) => index.has(playerId),
      size: () => index.size(),
      playerIds: () => index.playerIds(),
      byTier: (tier) => index.byTier(tier),
      leaderboard: (query) => index.leaderboard(query),
      rank: (playerId) => index.rank(playerId),
      rebuild: async () => rebuildIndex(),
      save: async () => flushIndexNow(),
      stats: () => index.stats(),
    },
    // 快照
    snapshot: {
      freeze: (loadout, versionOverride, extras) => freezeSnapshot(loadout, versionOverride, extras),
      put: (snapshot) => snapshots.put(snapshot),
      get: (hash) => snapshots.get(hash),
      require: (hash) => snapshots.requireSnapshot(hash),
      has: (hash) => snapshots.has(hash),
      list: () => snapshots.list(),
      ref: (hash, delta) => snapshots.ref(hash, delta),
      refCount: (hash) => snapshots.refCount(hash),
      refCounts: () => snapshots.refCounts(),
      rebuildRefs: (records) => snapshots.rebuildRefs(records),
      gc: (gcOpts) => snapshots.gc({
        retentionDays: serviceConfig.snapshot.retentionDays, at: nowFn(), ...(gcOpts || {}),
      }),
      stats: () => snapshots.stats(),
    },
    // 会话
    sessions: {
      load: () => sessions.load(),
      save: () => sessions.save(),
      put: (record) => sessions.put(record),
      get: (tokenHash) => sessions.get(tokenHash),
      peek: (tokenHash) => sessions.peek(tokenHash),
      touch: (tokenHash, patch) => sessions.touch(tokenHash, patch),
      revoke: (tokenHash) => sessions.revoke(tokenHash),
      revokePlayer: (playerId, sessionOpts) => sessions.revokePlayer(playerId, sessionOpts),
      list: (playerId) => sessions.list(playerId),
      prune: (at) => sessions.prune(at),
      all: () => sessions.all(),
      size: () => sessions.size(),
      stats: () => sessions.stats(),
    },
    // 恢复 / 维护 / 统计
    recover: async () => {
      const report = await recoveryMod.recoverStore({
        journal, index, logger: log, indexLoaded: index.isLoaded(),
        listPlayerIds,
        readArchiveRaw,
        quarantineArchive,
        applyRecords,
        saveIndex,
        rebuildIndexFromArchives,
        rebuildDerivedState,
      });
      flushIndexNow();
      return report;
    },
    rebuildIndex: async () => rebuildIndex(),
    gc: async () => {
      const snap = snapshots.gc({ retentionDays: serviceConfig.snapshot.retentionDays, at: nowFn() });
      const sess = sessions.prune(nowFn());
      return { snapshots: snap, sessions: sess };
    },
    stats: statsOf,
  };

  return adapter;
}

module.exports = { ADAPTER_NAME, createJsonAdapter };
