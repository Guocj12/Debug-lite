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
  const stats = { reads: 0, writes: 0, applies: 0, skipped: 0, cacheHits: 0, cacheMisses: 0, evictions: 0, quarantined: 0 };
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

  function saveIndex() {
    fsatomic.writeJsonAtomicSync(indexPath, index.toJSON(), { logger: log, pretty: true });
    return indexPath;
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
    saveIndex();
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
  async function applyForPlayer(record, playerId) {
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
    if (archive.record.appliedSeq >= record.seq) {
      stats.skipped += 1;
      return 'skipped';
    }
    const res = await archiveMod.applyRecordToArchive(archive, record, playerId, ctx());
    archive.record.appliedSeq = record.seq;
    if (res.changed) archive.updatedAt = Number.isInteger(record.at) ? record.at : nowFn();
    archiveMod.assertArchiveInvariants(archive, { config: serviceConfig });
    writeArchiveRaw(archive, { touch: false });
    stats.applies += 1;
    if (record.type === 'battle.recorded') {
      const part = record.p1 && record.p1.playerId === playerId ? record.p1 : record.p2;
      if (part && part.snapshotHash) snapshots.ref(part.snapshotHash, 1);
    }
    return 'applied';
  }

  async function applyRecords(records) {
    const list = records || [];
    let applied = 0;
    let recordsApplied = 0;
    for (const record of list) {
      archiveMod.validateRecord(record);
      const involved = archiveMod.playersOfRecord(record);
      let allKnown = involved.length > 0;
      let touched = 0;
      for (const playerId of involved) {
        const status = await queueFor(playerId, () => applyForPlayer(record, playerId));
        if (status === 'applied') { applied += 1; touched += 1; }
        if (status === 'missing') allKnown = false;
      }
      if (touched > 0) recordsApplied += 1;
      if (allKnown) index.setSeq(record.seq); // 全局水位：所有参与方都已在/超过该 seq
    }
    if (list.length > 0) saveIndex();
    return { applied, count: list.length, recordsApplied };
  }

  async function appendAndApply(records) {
    const appended = await journal.appendMany(records);
    const res = await applyRecords(appended);
    return { records: appended, applied: res.applied };
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

  function freezeSnapshot(loadout, versionOverride) {
    if (!loadout || typeof loadout !== 'object' || Array.isArray(loadout)) {
      throw new StoreError('loadout_invalid', '配置必须是对象（loadout = {role, skills[3], ai}）', [
        { path: 'loadout', code: 'loadout_invalid', message: 'loadout 必须是对象' },
      ]);
    }
    const built = snapMod.buildSnapshot({
      loadout,
      engineVersion: (versionOverride && versionOverride.engine) || versions.engine,
      dataVersion: (versionOverride && versionOverride.data) || versions.data,
      frozenAt: nowFn(),
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
      const snapshot = freezeSnapshot(o.loadout, o.versions);
      const record = ledger.buildConfigRecord({
        playerId: o.playerId, slotId: slot.slotId, name: o.name, at: nowFn(),
        snapshotHash: snapshot.hash, configHash: snapshot.configHash,
        activate: o.activate === true, warehouseVerified: o.warehouseVerified === true,
        versions: { engine: versions.engine, data: versions.data },
      });
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

  // 新建槽（POST /me/configs）：默认复制出战配置；注册后的默认槽由 createAccount 提供
  async function createConfigSlot(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      archiveMod.checkSlotLimit(archive, serviceConfig);
      const active = archiveMod.activeSlot(archive);
      const source = o.loadout ? o.loadout : (active ? active.loadout : null);
      if (!source) {
        throw new StoreError('loadout_invalid', '新建配置槽需要 loadout，或先拥有一套出战配置', [
          { path: 'loadout', code: 'loadout_invalid', message: '无可复制的出战配置' },
        ]);
      }
      const slotId = nextSlotId(archive);
      const snapshot = freezeSnapshot(source, o.versions);
      const record = ledger.buildConfigRecord({
        playerId: o.playerId, slotId, name: o.name === undefined ? slotId : o.name, at: nowFn(),
        snapshotHash: snapshot.hash, configHash: snapshot.configHash,
        create: true, activate: o.activate !== false, isDefault: false,
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

  async function activateConfigSlot(input) {
    const o = input || {};
    return queueFor(o.playerId, async () => {
      const archive = readArchiveRaw(o.playerId);
      if (!archive) throw new StoreError('store_not_found', `档案 ${o.playerId} 不存在`);
      const slot = archiveMod.findSlot(archive, o.slotId);
      if (!slot) throw new StoreError('slot_not_found', `槽 ${o.slotId} 不存在`);
      if (!slot.snapshot || !slot.snapshot.hash) {
        throw new StoreError('no_active_config', `槽 ${o.slotId} 缺少已冻结快照`, [
          { path: o.slotId, code: 'no_active_config', message: '快照缺失' },
        ]);
      }
      const record = ledger.buildConfigRecord({
        playerId: o.playerId, slotId: slot.slotId, at: nowFn(),
        snapshotHash: slot.snapshot.hash, configHash: slot.snapshot.configHash, activate: true,
        versions: { engine: versions.engine, data: versions.data },
      });
      const appended = await journal.append(record);
      await applyForPlayer(appended, o.playerId);
      saveIndex();
      return { archive: deepClone(readArchiveRaw(o.playerId)), slot: deepClone(slot) };
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

  // B 类事务：先 append journal（一次落盘即成立）→ 再 apply 双方档案（§6.1/D-134）
  //   重复 battleId（同 batchId/seed/双方快照）→ 不重复写 journal，返回已有记录（内容寻址幂等，§9.1）
  async function settleBattle(input) {
    const prepared = input && input.type === 'battle.recorded' ? { ...input } : ledger.buildBattleRecord(input || {});
    if (prepared.mode === 'ranked') {
      // D-132/D-133 硬约束：排位既不改积分也不改段位——段位变化只由 ranked.promoted 记录驱动（§7.1 步骤 6），
      // 防守方恒不掉段。战斗记录只落战绩（stats/recent/未读/被抽计数）。
      for (const side of ['p1', 'p2']) {
        const part = prepared[side];
        if (!part) continue;
        part.pointsAfter = part.pointsBefore;
        part.tierAfter = part.tierBefore;
      }
    }
    const existing = prepared.battleId ? journal.findBattle(prepared.battleId) : null;
    if (existing) {
      return { record: existing, applied: 0, duplicate: true };
    }
    const appended = await journal.append(prepared);
    const res = await applyRecords([appended]);
    return { record: appended, applied: res.applied, duplicate: false };
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
      saveIndex();
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
    saveIndex();
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
      quarantined: stats.quarantined,
      journal: journal.stats(),
      snapshots: snapshots.stats(),
      sessions: sessions.stats(),
    };
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
      const known = fsatomic.pathExists(playerArchivePath(playerId)) || index.has(playerId);
      if (!known) return false; // 幂等：不存在 → 不产生墓碑（避免无意义 journal 记录）
      const record = ledger.buildRemovedRecord({ playerId, reason: o.reason, at: nowFn() });
      const appended = await journal.append(record);
      await applyRecords([appended]);
      return true;
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
    // journal
    append: (record) => journal.append(record),
    appendMany: (records) => journal.appendMany(records),
    applyRecord: async (record) => applyRecords([record]),
    applyRecords,
    settleBattle,
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
      save: async () => saveIndex(),
      stats: () => index.stats(),
    },
    // 快照
    snapshot: {
      freeze: (loadout, versionOverride) => freezeSnapshot(loadout, versionOverride),
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
      saveIndex();
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
