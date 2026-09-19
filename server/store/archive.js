'use strict';
/* server/store/archive.js —— 玩家档案模型 + 纯函数领域规则（D-129 §5.2/§5.3/§5.5/§5.7/§6.2/§6.3）
 * 权威：docs/systems/11-account-store.md §5.2（字段全表）/§5.3（配置槽规则）/§5.7（版本迁移）
 *      §6.2（journal 记录类型）/§6.3（apply 幂等）/§7.3（攻守差异 D-132）/§7.6（bot 冻结）
 * 本文件是**纯领域层**：不碰 fs、不碰 journal；只对档案对象做校验/迁移/应用记录（快照正文由 ctx.loadSnapshot 注入）。
 * 调用方：adapter-json.js（读改写）、account.js（B29 门面，后续批次）。
 */
const crypto = require('node:crypto');
const { nullLogger } = require('../../shared/log.js');
const { StoreError } = require('./errors.js');
const { deepClone, isHash } = require('./canonical.js');

const ARCHIVE_VERSION = 1;
const RECORD_VERSION = 1;
const TIERS = Object.freeze(['common', 'rare', 'epic', 'legendary', 'mythic']);
const DEFAULT_MAX_SLOTS = 3;
const DEFAULT_RECENT_LIMIT = 100;
const PLAYER_ID_RE = /^pl_[0-9a-f]{16}$/;
const PUBLIC_ID_RE = /^u_[0-9a-f]{8}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/;

// journal 记录类型全表（§6.2；未登记类型 → store.error 而非静默忽略）
// 说明：`player.removed` 是 P7-3 追加的**墓碑记录**（管理端删除调试/bot 档案用）——journal 是唯一真源，
//   删除必须可重放，故不能只删档案文件；墓碑 seq 之后的同名玩家记录才会重建档案（见 adapter 的 removedAt 守卫）。
const RECORD_TYPES = Object.freeze([
  'account.created',
  'account.password.changed',
  'account.banned',
  'account.unbanned',
  'player.config.saved',
  'player.nickname.changed',
  'player.pool.changed',
  'player.removed',
  'ranked.batch',
  'ranked.promoted',
  'admin.bot.injected',
  'battle.recorded',
  'checkpoint',
]);

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function newPlayerId() {
  return `pl_${randomHex(8)}`; // 16 hex，仅服务端内部使用（§4.5）
}

function newPublicId() {
  return `u_${randomHex(4)}`; // 8 hex，对外展示（§4.5）
}

// 分片目录：playerId 的**前 2 个 hex 字符**（§5.1）。
// 注意：playerId 形如 'pl_9f3a…'，直接取前 2 字符会得到 'pl'（全部玩家同分片）；
// 因此实现取前缀 'pl_' 之后的前 2 hex（设计文档 §5.1 的"前 2 个 hex 字符"按此落实）。
function shardOf(playerId) {
  const body = String(playerId).replace(/^pl_/, '');
  return body.slice(0, 2) || '00';
}

function archiveRelPath(playerId) {
  return `players/${shardOf(playerId)}/${playerId}.json`;
}

function isTier(tier) {
  return TIERS.includes(tier);
}

function nextTier(tier) {
  const idx = TIERS.indexOf(tier);
  if (idx === -1 || idx === TIERS.length - 1) return null;
  return TIERS[idx + 1];
}

function isValidUsername(name) {
  return typeof name === 'string' && USERNAME_RE.test(name);
}

function isValidNickname(name) {
  return typeof name === 'string' && name.length >= 1 && name.length <= 16;
}

function defaultRecentLimit(config) {
  const n = config && config.record && config.record.recentLimit;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_RECENT_LIMIT;
}

function maxSlotsOf(config) {
  const n = config && config.config && config.config.maxSlots;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_SLOTS;
}

function slotIdOf(config, index) {
  const prefix = (config && config.config && config.config.slotIdPrefix) || 'slot';
  return `${prefix}${index}`;
}

// 配置槽（§5.2 configs.slots[]）：内容 + 不可变快照引用
function createSlot(input) {
  const opts = input || {};
  const at = Number.isInteger(opts.at) ? opts.at : 0;
  const snapshot = opts.snapshot || null;
  return {
    slotId: opts.slotId,
    name: opts.name === undefined ? opts.slotId : opts.name,
    isDefault: !!opts.isDefault,
    createdAt: Number.isInteger(opts.createdAt) ? opts.createdAt : at,
    updatedAt: Number.isInteger(opts.updatedAt) ? opts.updatedAt : at,
    loadout: opts.loadout === undefined ? null : deepClone(opts.loadout),
    snapshot: snapshot === null ? null : {
      hash: snapshot.hash,
      engineVersion: snapshot.engineVersion === undefined ? null : snapshot.engineVersion,
      dataVersion: snapshot.dataVersion === undefined ? null : snapshot.dataVersion,
      configHash: snapshot.configHash === undefined ? null : snapshot.configHash,
      frozenAt: Number.isInteger(snapshot.frozenAt) ? snapshot.frozenAt : at,
      verifiedAgainstWarehouse: !!snapshot.verifiedAgainstWarehouse,
    },
  };
}

// 空档案骨架（注册前 / 仅由检查点重建时使用）
function createArchiveShell(playerId, at) {
  const ts = Number.isInteger(at) ? at : 0;
  return {
    archiveVersion: ARCHIVE_VERSION,
    playerId,
    publicId: null,
    nickname: null,
    createdAt: ts,
    lastLoginAt: null,
    lastSeenAt: null,
    auth: null,
    progress: {
      tier: 'common', peakTier: 'common', tierUpdatedAt: ts, batchesPlayed: 0, batchesPromoted: 0,
      lastBatchId: null, lastPromotedBatchId: null,
    },
    rating: {
      points: 0, peakPoints: 0, games: 0, wins: 0, losses: 0, draws: 0, lastBattleAt: null, seasonId: 's0',
    },
    configs: { slots: [], activeSlotId: null, activeSnapshotHash: null },
    pool: { inPool: true, enteredAt: ts, lastDrawnAt: null, drawnCount: 0, lastOpponentAt: {} },
    record: {
      appliedSeq: 0,
      recent: [],
      stats: { attack: { wins: 0, losses: 0, draws: 0 }, defense: { wins: 0, losses: 0, draws: 0 } },
      unread: { attack: 0, defense: 0, fromSeq: 0 },
    },
    flags: { banned: false, banReason: null, isBot: false, cheatSuspect: false, unverifiedLoadout: true, rebuiltFromCheckpoint: false },
    updatedAt: ts,
  };
}

// 注册档案（§5.2 字段全表）：必有 1 个默认出战槽 + 已冻结快照（§5.3 注册即默认配置）
function createArchive(input) {
  const opts = input || {};
  if (!PLAYER_ID_RE.test(String(opts.playerId))) {
    throw new StoreError('bad_request', `非法 playerId: ${opts.playerId}`);
  }
  const at = Number.isInteger(opts.at) ? opts.at : 0;
  const archive = createArchiveShell(opts.playerId, at);
  archive.publicId = opts.publicId || newPublicId();
  archive.nickname = opts.nickname === undefined ? opts.username || opts.playerId : opts.nickname;
  archive.createdAt = at;
  archive.lastLoginAt = at;
  archive.lastSeenAt = at;
  archive.auth = opts.auth ? deepClone(opts.auth) : null;
  if (opts.isBot) {
    archive.flags.isBot = true;
    archive.progress.tier = isTier(opts.tier) ? opts.tier : 'common';
    archive.progress.peakTier = archive.progress.tier;
    archive.rating.points = Number.isInteger(opts.points) ? opts.points : 0;
    archive.rating.peakPoints = archive.rating.points;
    archive.pool.enteredAt = at;
  }
  if (opts.slot) {
    const slot = createSlot({ ...opts.slot, at, isDefault: true });
    archive.configs.slots = [slot];
    archive.configs.activeSlotId = slot.slotId;
    archive.configs.activeSnapshotHash = slot.snapshot ? slot.snapshot.hash : null;
    archive.flags.unverifiedLoadout = !(slot.snapshot && slot.snapshot.verifiedAgainstWarehouse);
  }
  return archive;
}

// ---------- 校验 ----------

function pushError(errors, code, message, path) {
  errors.push({ path: path === undefined ? '' : path, code, message });
}

function validateArchive(archive, options) {
  const opts = options || {};
  const config = opts.config;
  const errors = [];
  const eq = (a, b) => a === b;
  if (!archive || typeof archive !== 'object') {
    pushError(errors, 'store_inconsistent', '档案不是对象');
    return { ok: false, errors };
  }
  if (eq(archive.archiveVersion, undefined) || archive.archiveVersion > ARCHIVE_VERSION) {
    pushError(errors, 'store_version_unsupported', `archiveVersion=${archive.archiveVersion} 不受支持（当前 ${ARCHIVE_VERSION}）`, 'archiveVersion');
  }
  if (!PLAYER_ID_RE.test(String(archive.playerId))) pushError(errors, 'store_inconsistent', 'playerId 非法', 'playerId');
  if (archive.publicId !== null && !PUBLIC_ID_RE.test(String(archive.publicId))) {
    pushError(errors, 'store_inconsistent', 'publicId 非法', 'publicId');
  }
  for (const section of ['progress', 'rating', 'configs', 'pool', 'record', 'flags']) {
    if (!archive[section] || typeof archive[section] !== 'object') {
      pushError(errors, 'store_inconsistent', `缺少 ${section} 段`, section);
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  const rebuilt = archive.flags.rebuiltFromCheckpoint === true;
  const maxSlots = maxSlotsOf(config);
  const slots = archive.configs.slots;
  if (!Array.isArray(slots)) {
    pushError(errors, 'store_inconsistent', 'configs.slots 必须是数组', 'configs.slots');
  } else {
    if (slots.length > maxSlots) pushError(errors, 'slot_limit', `配置槽 ${slots.length} > 上限 ${maxSlots}`, 'configs.slots');
    const seen = new Set();
    let defaults = 0;
    for (const slot of slots) {
      if (!slot || typeof slot.slotId !== 'string' || slot.slotId === '') {
        pushError(errors, 'store_inconsistent', '槽缺少 slotId', 'configs.slots');
        continue;
      }
      if (seen.has(slot.slotId)) pushError(errors, 'store_inconsistent', `槽 id 重复 ${slot.slotId}`, 'configs.slots');
      seen.add(slot.slotId);
      if (slot.isDefault) defaults += 1;
      if (!rebuilt && (!slot.snapshot || !isHash(slot.snapshot.hash))) {
        pushError(errors, 'no_active_config', `槽 ${slot.slotId} 缺少已冻结快照`, `configs.slots.${slot.slotId}`);
      }
    }
    if (defaults > 1) pushError(errors, 'store_inconsistent', '存在多个默认槽', 'configs.slots');
    if (!rebuilt) {
      const active = slots.find((s) => s.slotId === archive.configs.activeSlotId);
      if (slots.length === 0) pushError(errors, 'no_active_config', '档案没有配置槽（必有出战配置）', 'configs.activeSlotId');
      else if (!active) pushError(errors, 'no_active_config', `activeSlotId=${archive.configs.activeSlotId} 不存在`, 'configs.activeSlotId');
      else if (active.snapshot && archive.configs.activeSnapshotHash !== active.snapshot.hash) {
        pushError(errors, 'store_inconsistent', 'activeSnapshotHash 与出战槽快照不一致', 'configs.activeSnapshotHash');
      }
    }
  }
  const rating = archive.rating;
  if (!Number.isInteger(rating.points) || rating.points < 0) pushError(errors, 'store_inconsistent', 'rating.points 非法', 'rating.points');
  if (!Number.isInteger(rating.peakPoints) || rating.peakPoints < rating.points) {
    pushError(errors, 'store_inconsistent', 'rating.peakPoints 非法', 'rating.peakPoints');
  }
  if (!isTier(archive.progress.tier)) pushError(errors, 'store_inconsistent', `非法段位 ${archive.progress.tier}`, 'progress.tier');
  if (!isTier(archive.progress.peakTier)) pushError(errors, 'store_inconsistent', `非法峰值段位 ${archive.progress.peakTier}`, 'progress.peakTier');
  const rec = archive.record;
  if (!Number.isInteger(rec.appliedSeq) || rec.appliedSeq < 0) pushError(errors, 'store_inconsistent', 'record.appliedSeq 非法', 'record.appliedSeq');
  if (!Array.isArray(rec.recent)) pushError(errors, 'store_inconsistent', 'record.recent 必须是数组', 'record.recent');
  else if (rec.recent.length > defaultRecentLimit(config)) {
    pushError(errors, 'store_inconsistent', `record.recent 长度 ${rec.recent.length} 超过上限`, 'record.recent');
  }
  for (const bucket of ['attack', 'defense']) {
    const stats = rec.stats && rec.stats[bucket];
    if (!stats || !Number.isInteger(stats.wins) || !Number.isInteger(stats.losses) || !Number.isInteger(stats.draws)) {
      pushError(errors, 'store_inconsistent', `record.stats.${bucket} 非法`, `record.stats.${bucket}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function assertArchiveInvariants(archive, options) {
  const res = validateArchive(archive, options);
  if (!res.ok) {
    throw new StoreError('store_inconsistent', `档案不变量破损（${res.errors[0].message} 等 ${res.errors.length} 项）`, res.errors);
  }
  return archive;
}

// ---------- 版本迁移（§5.7） ----------

// v0 → v1：补齐缺失字段（v0 = 无 archiveVersion 的早期形状）
function migrateV0toV1(raw) {
  const shell = createArchiveShell(raw.playerId, raw.createdAt);
  return applyDefaults(shell, raw);
}

function applyDefaults(target, source) {
  const out = { ...target };
  for (const key of Object.keys(source)) {
    if (!Object.prototype.hasOwnProperty.call(target, key)) {
      out[key] = source[key];
    } else if (target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
      && source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = applyDefaults(target[key], source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

const MIGRATIONS = Object.freeze({ 1: migrateV0toV1 });

// 读档时按需升级；更高版本 → 拒绝（防止新版本写过的数据被旧版本覆盖）
function migrateArchive(archive, options) {
  const opts = options || {};
  const log = opts.logger || nullLogger;
  const from = Number.isInteger(archive.archiveVersion) ? archive.archiveVersion : 0;
  if (from > ARCHIVE_VERSION) {
    throw new StoreError('store_version_unsupported',
      `档案 archiveVersion=${from} 高于本进程支持的 ${ARCHIVE_VERSION}，拒绝启动`,
      [{ path: 'archiveVersion', code: 'store_version_unsupported', message: `档案版本 ${from} > ${ARCHIVE_VERSION}` }],
      { fatal: true });
  }
  if (from === ARCHIVE_VERSION) return { archive, migrated: false, from, to: from };
  let current = deepClone(archive);
  let version = from;
  while (version < ARCHIVE_VERSION) {
    const fn = MIGRATIONS[version + 1];
    if (typeof fn !== 'function') {
      throw new StoreError('store_version_unsupported', `缺少 archiveVersion ${version} → ${version + 1} 的迁移函数`, [
        { path: 'archiveVersion', code: 'store_version_unsupported', message: `无迁移路径 ${version} → ${version + 1}` },
      ], { fatal: true });
    }
    current = fn(current);
    version += 1;
    current.archiveVersion = version;
  }
  log.info('store', 'store.migrate', `档案迁移 ${from} → ${version}`, { playerId: archive.playerId, from, to: version });
  return { archive: current, migrated: true, from, to: version };
}

// ---------- 记录 → 参与者 ----------

function validateRecord(record) {
  if (!record || typeof record !== 'object') throw new StoreError('bad_request', 'journal 记录必须是对象');
  if (!Number.isInteger(record.seq) || record.seq <= 0) throw new StoreError('bad_request', 'journal 记录缺少正整数 seq');
  if (!RECORD_TYPES.includes(record.type)) throw new StoreError('bad_request', `未登记的 journal 记录类型 ${record.type}`);
  if (record.type === 'battle.recorded' && (typeof record.battleId !== 'string' || record.battleId === '')) {
    throw new StoreError('bad_request', 'battle.recorded 必须带 battleId（内容寻址，§9.1）');
  }
  return record;
}

function playersOfRecord(record) {
  if (!record) return [];
  if (record.type === 'battle.recorded') {
    const ids = [];
    for (const side of ['p1', 'p2']) {
      const part = record[side];
      if (part && typeof part.playerId === 'string' && !ids.includes(part.playerId)) ids.push(part.playerId);
    }
    return ids;
  }
  if (record.type === 'checkpoint') return Object.keys(record.perPlayer || {});
  return typeof record.playerId === 'string' ? [record.playerId] : [];
}

// ---------- 槽位纯操作（§5.3） ----------

function findSlot(archive, slotId) {
  return (archive.configs.slots || []).find((s) => s.slotId === slotId) || null;
}

function activeSlot(archive) {
  return findSlot(archive, archive.configs.activeSlotId);
}

function checkSlotLimit(archive, config) {
  if ((archive.configs.slots || []).length >= maxSlotsOf(config)) {
    throw new StoreError('slot_limit', `配置槽已达上限 ${maxSlotsOf(config)}（D-131）`, [
      { path: 'configs.slots', code: 'slot_limit', message: '最多 3 套完整配置' },
    ]);
  }
}

function checkSlotDeletable(archive, slotId) {
  const slot = findSlot(archive, slotId);
  if (!slot) throw new StoreError('slot_not_found', `槽 ${slotId} 不存在`);
  if (slot.isDefault) throw new StoreError('slot_locked', `默认槽 ${slotId} 不可删除（§5.3）`);
  if (archive.configs.activeSlotId === slotId) throw new StoreError('slot_locked', `出战槽 ${slotId} 不可删除，请先切换（§5.3）`);
  return slot;
}

// 同步 activeSnapshotHash（不变量：它必须等于出战槽的快照 hash）
function syncActiveSnapshot(archive) {
  const active = activeSlot(archive);
  archive.configs.activeSnapshotHash = active && active.snapshot ? active.snapshot.hash : null;
  return archive.configs.activeSnapshotHash;
}

// ---------- journal 记录 → 档案（幂等；调用方负责 appliedSeq 水位与落盘） ----------

// 战绩环形：**按 seq 升序插入**（不是简单 push）。
// 理由（P7-6 并发缺陷修复）：并发结算下"补 apply/乱序 apply"可能晚于更高 seq 落地，
// 若按应用顺序 push，环形会失去"seq 递增"的稳定视图（recent[0] 也不再是窗口下界）。
// 保持 seq 有序，使 `recent[0].seq` 可作"已应用窗口下界"用于幂等判定（见 isRecordApplied）。
function pushRecent(archive, entry, limit) {
  const recent = archive.record.recent;
  let at = recent.length;
  while (at > 0 && recent[at - 1].seq > entry.seq) at -= 1;
  recent.splice(at, 0, entry);
  if (recent.length > limit) {
    recent.splice(0, recent.length - limit);
  }
}

function bumpStats(archive, bucket, result) {
  const stats = archive.record.stats[bucket];
  if (result === 'win') stats.wins += 1;
  else if (result === 'loss') stats.losses += 1;
  else stats.draws += 1;
}

// ---------- 幂等判定（P7-6 并发缺陷修复的核心，§6.3） ----------
// 背景：`appliedSeq` 是**单调水位**，但并发结算下"到达顺序 ≠ seq 顺序"（同一玩家在一条记录里当 p1、
//   在另一条并发记录里当 p2，两条记录的两侧 apply 交错），仅凭 `record.seq <= appliedSeq` 跳过
//   会把**从未 apply** 的记录永久丢掉（journal 里有、档案里没有，且水位已超过 → 重放也跳过）。
// 现在水位降级为**加速/诊断**：命中水位区间时还要用"内容级幂等键"证明该记录确实已应用，证明不了就补 apply。
// 各类型的幂等键（都是"最后写入者胜"的字段，天然可重放）：
//   battle.recorded     → recent 内 battleId；若 seq 已滑出环形窗口下界 → 视为早已应用（窗口外无键可查）
//   account.created/bot → 档案已具备账号 + 配置（或已是检查点重建态）
//   password / banned / nickname / pool → 目标字段是否已是记录要求的值
//   player.config.saved → 槽存在且 snapshot.hash/updatedAt 与记录一致（deleted → 槽已不存在）
//   ranked.batch / ranked.promoted → progress.lastBatchId / lastPromotedBatchId（防止计数器重复 +1）
//   checkpoint          → 仅对"检查点重建的空壳"生效（已有内容 → 视为已应用）
//   player.removed      → 适配器按墓碑水位处理（此处不作为判据）
function isRecordApplied(archive, record) {
  if (!archive || !record) return false;
  switch (record.type) {
    case 'battle.recorded': {
      const ring = archive.record.recent || [];
      if (ring.some((e) => e.battleId === record.battleId)) return true;
      const windowFrom = ring.length > 0 ? ring[0].seq : null;
      // 环形窗口下界之外（seq 更小）说明该场早已应用并已滑出窗口 → 可安全跳过；
      // 窗口之内却查不到 battleId，则说明**从未应用** → 必须补 apply（不得因水位跳过）。
      return windowFrom !== null && record.seq < windowFrom;
    }
    case 'account.created':
    case 'admin.bot.injected':
      return archive.auth !== null && archive.auth !== undefined
        && ((archive.configs.slots || []).length > 0 || archive.flags.rebuiltFromCheckpoint === true);
    case 'account.password.changed':
      return !!record.auth && !!archive.auth && archive.auth.hash === record.auth.hash;
    case 'account.banned':
      return archive.flags.banned === true;
    case 'account.unbanned':
      return archive.flags.banned === false;
    case 'player.nickname.changed':
      return record.nickname === undefined || archive.nickname === record.nickname;
    case 'player.pool.changed':
      return archive.pool.inPool === (record.inPool !== false);
    case 'player.config.saved': {
      const slot = findSlot(archive, record.slotId);
      if (record.deleted === true) return slot === null;
      if (!slot) return false;
      if (record.snapshotHash && (!slot.snapshot || slot.snapshot.hash !== record.snapshotHash)) return false;
      if (Number.isInteger(record.at) && slot.updatedAt !== record.at) return false;
      return true;
    }
    case 'ranked.batch':
      return record.batchId === undefined || archive.progress.lastBatchId === record.batchId;
    case 'ranked.promoted':
      return record.batchId === undefined || archive.progress.lastPromotedBatchId === record.batchId;
    case 'checkpoint':
      return archive.record.appliedSeq > 0 || archive.flags.rebuiltFromCheckpoint === true;
    default:
      return true; // 未知类型：交给上层统一报错/忽略，不在幂等层做决定
  }
}

function slotSnapshotFromRecord(record, at) {
  const versions = record.versions || {};
  return {
    hash: record.snapshotHash,
    engineVersion: versions.engine === undefined ? null : versions.engine,
    dataVersion: versions.data === undefined ? null : versions.data,
    configHash: record.configHash === undefined ? null : record.configHash,
    frozenAt: at,
    verifiedAgainstWarehouse: record.warehouseVerified === true,
  };
}

async function applyConfigSaved(archive, record, ctx) {
  if (record.deleted === true) {
    const slot = findSlot(archive, record.slotId);
    if (!slot) return { changed: false };
    if (slot.isDefault || archive.configs.activeSlotId === slot.slotId) {
      throw new StoreError('slot_locked', `journal 要求删除受保护槽 ${record.slotId}`, [], { fatal: true });
    }
    archive.configs.slots = archive.configs.slots.filter((s) => s.slotId !== record.slotId);
    syncActiveSnapshot(archive);
    return { changed: true };
  }
  const at = Number.isInteger(record.at) ? record.at : ctx.now();
  let slot = findSlot(archive, record.slotId);
  const snapshot = record.snapshotHash ? await ctx.loadSnapshot(record.snapshotHash) : null;
  if (!slot) {
    if (record.create !== true) {
      ctx.logger.warn('store', 'store.error', `player.config.saved 指向不存在的槽 ${record.slotId} 且未标记 create`, {
        playerId: archive.playerId, slotId: record.slotId,
      });
      return { changed: false };
    }
    checkSlotLimit(archive, ctx.config);
    slot = createSlot({
      slotId: record.slotId,
      name: record.name === undefined ? record.slotId : record.name,
      isDefault: record.isDefault === true,
      at,
      loadout: snapshot ? snapshot.loadout : null,
      snapshot: slotSnapshotFromRecord(record, at),
    });
    archive.configs.slots.push(slot);
  } else {
    if (record.name !== undefined) slot.name = record.name;
    if (snapshot) slot.loadout = deepClone(snapshot.loadout);
    slot.snapshot = slotSnapshotFromRecord(record, at);
    slot.updatedAt = at;
  }
  if (record.activate === true || archive.configs.activeSlotId === null) {
    archive.configs.activeSlotId = slot.slotId;
  }
  syncActiveSnapshot(archive);
  if (record.warehouseVerified === true) archive.flags.unverifiedLoadout = false;
  return { changed: true };
}

function applyAccountFields(archive, record, at) {
  let changed = false;
  if (record.publicId && archive.publicId !== record.publicId) { archive.publicId = record.publicId; changed = true; }
  if (record.nickname !== undefined && archive.nickname !== record.nickname) { archive.nickname = record.nickname; changed = true; }
  if (record.auth) { archive.auth = deepClone(record.auth); changed = true; }
  if (Number.isInteger(record.createdAt) && archive.createdAt !== record.createdAt) { archive.createdAt = record.createdAt; changed = true; }
  if (record.flags && typeof record.flags === 'object') {
    Object.assign(archive.flags, record.flags);
    changed = true;
  }
  if (isTier(record.tier) && archive.progress.tier !== record.tier) {
    archive.progress.tier = record.tier;
    archive.progress.peakTier = TIERS.indexOf(record.tier) > TIERS.indexOf(archive.progress.peakTier) ? record.tier : archive.progress.peakTier;
    archive.progress.tierUpdatedAt = at;
    changed = true;
  }
  if (Number.isInteger(record.points) && record.points >= 0) {
    archive.rating.points = record.points;
    archive.rating.peakPoints = Math.max(archive.rating.peakPoints, record.points);
    changed = true;
  }
  return changed;
}

function applyBattleRecorded(archive, record, playerId, ctx) {
  const side = record.p1 && record.p1.playerId === playerId ? 'p1' : (record.p2 && record.p2.playerId === playerId ? 'p2' : null);
  if (side === null) return { changed: false };
  const mine = record[side];
  const foe = record[side === 'p1' ? 'p2' : 'p1'];
  if (archive.record.recent.some((e) => e.battleId === record.battleId)) return { changed: false }; // 第二道幂等保险
  const at = Number.isInteger(record.at) ? record.at : ctx.now();
  const role = mine.role === 'defender' ? 'defender' : 'attacker';
  const bucket = role === 'defender' ? 'defense' : 'attack';
  const result = mine.result === 'win' ? 'win' : mine.result === 'loss' ? 'loss' : 'draw';
  const pointsBefore = Number.isInteger(mine.pointsBefore) ? mine.pointsBefore : archive.rating.points;
  const pointsAfter = Number.isInteger(mine.pointsAfter) ? mine.pointsAfter : pointsBefore;
  pushRecent(archive, {
    battleId: record.battleId,
    seq: record.seq,
    mode: record.mode || 'quick',
    role,
    opponentPublicId: foe && foe.publicId ? foe.publicId : null,
    mySide: side,
    result,
    reason: record.verdict && record.verdict.reason ? record.verdict.reason : null,
    ticks: record.verdict && Number.isInteger(record.verdict.ticks) ? record.verdict.ticks : null,
    pointsDelta: pointsAfter - pointsBefore,
    tierBefore: mine.tierBefore === undefined ? archive.progress.tier : mine.tierBefore,
    tierAfter: mine.tierAfter === undefined ? archive.progress.tier : mine.tierAfter,
    seed: Number.isInteger(record.seed) ? record.seed : null,
    at,
    seen: false,
  }, defaultRecentLimit(ctx.config));
  bumpStats(archive, bucket, result);
  if (role === 'defender') {
    archive.record.unread.defense += 1;
    archive.pool.drawnCount += 1;
    archive.pool.lastDrawnAt = at;
  } else {
    archive.record.unread.attack += 1;
  }
  if (foe && typeof foe.playerId === 'string' && playerId !== foe.playerId) {
    archive.pool.lastOpponentAt[foe.playerId] = at; // D-136 去重窗口的存储原语（§8.2）
  }
  const isBot = archive.flags.isBot === true;
  if (!isBot) {
    if (record.mode === 'quick') {
      // 积分轨道（D-133）：只有快速对战改积分；排位不影响积分
      archive.rating.points = Math.max(0, pointsAfter);
      archive.rating.peakPoints = Math.max(archive.rating.peakPoints, archive.rating.points);
      archive.rating.games += 1;
      if (result === 'win') archive.rating.wins += 1;
      else if (result === 'loss') archive.rating.losses += 1;
      else archive.rating.draws += 1;
    }
    archive.rating.lastBattleAt = at;
  }
  return { changed: true };
}

function applyCheckpoint(archive, record, playerId) {
  const totals = (record.perPlayer || {})[playerId];
  if (!totals) return { changed: false };
  const fresh = archive.record.appliedSeq === 0 && archive.configs.slots.length === 0;
  if (!fresh) return { changed: false };
  archive.flags.rebuiltFromCheckpoint = true;
  if (totals.publicId) archive.publicId = totals.publicId;
  if (totals.nickname) archive.nickname = totals.nickname;
  if (totals.auth) archive.auth = deepClone(totals.auth);
  if (totals.isBot) archive.flags.isBot = true;
  if (isTier(totals.tier)) { archive.progress.tier = totals.tier; archive.progress.peakTier = totals.peakTier || totals.tier; }
  if (Number.isInteger(totals.points)) { archive.rating.points = totals.points; archive.rating.peakPoints = totals.peakPoints || totals.points; }
  if (Number.isInteger(totals.createdAt)) archive.createdAt = totals.createdAt;
  archive.rating.games += totals.quickGames || 0;
  archive.rating.wins += totals.quickWins || 0;
  archive.rating.losses += totals.quickLosses || 0;
  archive.rating.draws += totals.quickDraws || 0;
  for (const bucket of ['attack', 'defense']) {
    const src = (totals.stats && totals.stats[bucket]) || {};
    archive.record.stats[bucket].wins += src.wins || 0;
    archive.record.stats[bucket].losses += src.losses || 0;
    archive.record.stats[bucket].draws += src.draws || 0;
  }
  archive.pool.drawnCount += totals.drawnCount || 0;
  return { changed: true };
}

// 应用一条 journal 记录到某个玩家档案（幂等；返回 {changed}）
async function applyRecordToArchive(archive, record, playerId, ctx) {
  const at = Number.isInteger(record.at) ? record.at : ctx.now();
  switch (record.type) {
    case 'account.created':
    case 'admin.bot.injected': {
      let changed = applyAccountFields(archive, record, at);
      if (record.slot) {
        const res = await applyConfigSaved(archive, { ...record.slot, at, activate: true, create: true, isDefault: true }, ctx);
        changed = changed || res.changed;
      }
      return { changed };
    }
    case 'account.password.changed':
      if (record.auth) { archive.auth = deepClone(record.auth); return { changed: true }; }
      return { changed: false };
    case 'account.banned':
      archive.flags.banned = true;
      archive.flags.banReason = record.reason === undefined ? null : record.reason;
      return { changed: true };
    case 'account.unbanned':
      archive.flags.banned = false;
      archive.flags.banReason = null;
      return { changed: true };
    case 'player.config.saved':
      return applyConfigSaved(archive, record, ctx);
    case 'player.nickname.changed':
      if (typeof record.nickname !== 'string') return { changed: false };
      archive.nickname = record.nickname;
      return { changed: true };
    case 'player.pool.changed': {
      const inPool = record.inPool !== false;
      archive.pool.inPool = inPool;
      if (inPool && !Number.isInteger(archive.pool.enteredAt)) archive.pool.enteredAt = at;
      return { changed: true };
    }
    case 'ranked.batch':
      archive.progress.batchesPlayed += 1;
      archive.progress.lastBatchId = record.batchId === undefined ? null : record.batchId;
      return { changed: true };    case 'ranked.promoted': {
      if (!isTier(record.tierAfter)) return { changed: false };
      archive.progress.tier = record.tierAfter;
      archive.progress.peakTier = TIERS.indexOf(record.tierAfter) > TIERS.indexOf(archive.progress.peakTier)
        ? record.tierAfter : archive.progress.peakTier;
      archive.progress.tierUpdatedAt = at;
      archive.progress.batchesPromoted += 1;
      // 幂等键：同一批次重复 apply 不再累加 batchesPromoted（见 isRecordApplied）
      if (record.batchId !== undefined) archive.progress.lastPromotedBatchId = record.batchId;
      return { changed: true };
    }
    case 'battle.recorded':
      return applyBattleRecorded(archive, record, playerId, ctx);
    case 'player.removed':
      // 墓碑：档案应被删除（文件/索引由适配器负责）。本纯函数只报告"该档案进入已删除态"，
      //   便于直接调用本函数的测试与上层判断；不在这里改档案字段（避免"删除"语义渗进档案模型）。
      return { changed: true, removed: true };
    case 'checkpoint':
      return applyCheckpoint(archive, record, playerId);
    default:
      ctx.logger.warn('store', 'store.error', `未处理的 journal 记录类型 ${record.type}`, { type: record.type });
      return { changed: false };
  }
}

// 检查点聚合（§6.7：段内每个玩家的累计增量）
function aggregateRecords(records) {
  const perPlayer = {};
  const ensure = (playerId) => {
    if (!perPlayer[playerId]) {
      perPlayer[playerId] = {
        playerId, publicId: null, nickname: null, auth: null, isBot: false,
        tier: null, peakTier: null, points: null, peakPoints: null, createdAt: null,
        quickGames: 0, quickWins: 0, quickLosses: 0, quickDraws: 0, drawnCount: 0,
        stats: { attack: { wins: 0, losses: 0, draws: 0 }, defense: { wins: 0, losses: 0, draws: 0 } },
        lastAt: null,
      };
    }
    return perPlayer[playerId];
  };
  for (const record of records || []) {
    // 墓碑：该玩家的历史从检查点里一并抹掉（journal 全量重放时账目不得复活，D-134）
    if (record.type === 'player.removed') {
      delete perPlayer[record.playerId];
      continue;
    }
    if (record.type === 'account.created' || record.type === 'admin.bot.injected') {
      const t = ensure(record.playerId);
      t.publicId = record.publicId || t.publicId;
      t.nickname = record.nickname || t.nickname;
      t.auth = record.auth || t.auth;
      t.isBot = t.isBot || record.type === 'admin.bot.injected';
      t.tier = isTier(record.tier) ? record.tier : t.tier;
      t.peakTier = t.tier;
      t.points = Number.isInteger(record.points) ? record.points : t.points;
      t.peakPoints = t.points;
      t.createdAt = Number.isInteger(record.createdAt) ? record.createdAt : t.createdAt;
      continue;
    }
    if (record.type === 'ranked.promoted') {
      const t = ensure(record.playerId);
      t.tier = isTier(record.tierAfter) ? record.tierAfter : t.tier;
      t.peakTier = t.tier;
      continue;
    }
    if (record.type !== 'battle.recorded') continue;
    for (const side of ['p1', 'p2']) {
      const part = record[side];
      if (!part || typeof part.playerId !== 'string') continue;
      const t = ensure(part.playerId);
      const role = part.role === 'defender' ? 'defender' : 'attacker';
      const bucket = role === 'defender' ? 'defense' : 'attack';
      const result = part.result === 'win' ? 'win' : part.result === 'loss' ? 'loss' : 'draw';
      t.stats[bucket][result === 'win' ? 'wins' : result === 'loss' ? 'losses' : 'draws'] += 1;
      if (role === 'defender') t.drawnCount += 1;
      if (record.mode === 'quick') {
        t.quickGames += 1;
        if (result === 'win') t.quickWins += 1;
        else if (result === 'loss') t.quickLosses += 1;
        else t.quickDraws += 1;
        if (Number.isInteger(part.pointsAfter)) t.points = part.pointsAfter;
        if (t.points !== null) t.peakPoints = Math.max(t.peakPoints === null ? t.points : t.peakPoints, t.points);
      }
      if (isTier(part.tierAfter)) t.tier = part.tierAfter;
      t.lastAt = record.at === undefined ? t.lastAt : record.at;
    }
  }
  return perPlayer;
}

// ---------- 读取视图（§7.5 / §10.2） ----------

function unreadOf(archive) {
  return {
    attack: archive.record.unread.attack,
    defense: archive.record.unread.defense,
    fromSeq: archive.record.unread.fromSeq,
  };
}

function recentView(archive, query) {
  const q = query || {};
  const since = Number.isInteger(q.since) ? q.since : 0;
  const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 20;
  const role = q.role === 'attack' || q.role === 'defense' ? q.role : null;
  return archive.record.recent
    .filter((e) => e.seq > since)
    .filter((e) => (role === null ? true : (role === 'defense' ? e.role === 'defender' : e.role === 'attacker')))
    .slice(-limit)
    .map((e) => ({
      battleId: e.battleId, seq: e.seq, mode: e.mode, role: e.role, opponentPublicId: e.opponentPublicId,
      mySide: e.mySide, result: e.result, reason: e.reason, ticks: e.ticks, pointsDelta: e.pointsDelta,
      tierBefore: e.tierBefore, tierAfter: e.tierAfter, seed: e.seed, at: e.at,
      seen: e.seq <= archive.record.unread.fromSeq,
    }));
}

// 推进未读游标（A 类写，不入 journal）：重算游标之后的未读计数（环形容量内精确）
function markSeen(archive, uptoSeq) {
  const from = archive.record.unread.fromSeq;
  if (!Number.isInteger(uptoSeq) || uptoSeq <= from) return { changed: false };
  archive.record.unread.fromSeq = uptoSeq;
  let attack = 0;
  let defense = 0;
  for (const entry of archive.record.recent) {
    if (entry.seq > uptoSeq) {
      if (entry.role === 'defender') defense += 1;
      else attack += 1;
    } else {
      entry.seen = true;
    }
  }
  archive.record.unread.attack = attack;
  archive.record.unread.defense = defense;
  return { changed: true };
}

function summaryOf(archive) {
  const active = activeSlot(archive);
  return {
    nickname: archive.nickname,
    publicId: archive.publicId,
    progress: {
      tier: archive.progress.tier,
      peakTier: archive.progress.peakTier,
      batchesPlayed: archive.progress.batchesPlayed,
      batchesPromoted: archive.progress.batchesPromoted,
    },
    rating: {
      points: archive.rating.points,
      peakPoints: archive.rating.peakPoints,
      games: archive.rating.games,
      wins: archive.rating.wins,
      losses: archive.rating.losses,
      draws: archive.rating.draws,
    },
    slots: (archive.configs.slots || []).map((s) => ({
      slotId: s.slotId, name: s.name, isDefault: s.isDefault, updatedAt: s.updatedAt,
      snapshotHash: s.snapshot ? s.snapshot.hash : null,
    })),
    activeSlotId: archive.configs.activeSlotId,
    activeSnapshotHash: archive.configs.activeSnapshotHash,
    activeSlotName: active ? active.name : null,
    pool: { inPool: archive.pool.inPool, drawnCount: archive.pool.drawnCount },
    record: { stats: deepClone(archive.record.stats), unread: unreadOf(archive) },
    flags: { unverifiedLoadout: !!archive.flags.unverifiedLoadout, isBot: !!archive.flags.isBot },
  };
}

function defenseSummaryOf(archive, query) {
  const q = query || {};
  const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 20;
  return {
    drawnCount: archive.pool.drawnCount,
    stats: deepClone(archive.record.stats.defense),
    recent: archive.record.recent
      .filter((e) => e.role === 'defender')
      .slice(-limit)
      .map((e) => ({
        battleId: e.battleId, seq: e.seq, opponentPublicId: e.opponentPublicId, result: e.result,
        ticks: e.ticks, at: e.at, seen: e.seq <= archive.record.unread.fromSeq,
      })),
    unread: archive.record.unread.defense,
  };
}

// ---------- 对手去重窗口的存储原语（D-136 / §8.2） ----------

// 去重窗口判定：返回 true = 该对手已过冷却、可被抽取。
// 无档案 / 无 pool 段（P7-3 纯函数路径）→ 视为"无任何历史对手" → true（保守放行，不抛错）
function opponentCooldownOk(archive, opponentPlayerId, hours, at) {
  if (hours <= 0) return true;
  const map = archive && archive.pool && archive.pool.lastOpponentAt;
  if (!map || typeof map !== 'object') return true;
  const last = map[opponentPlayerId];
  if (!Number.isInteger(last)) return true;
  return at - last >= hours * 3600000;
}

function recentOpponents(archive, hours, at) {
  const out = new Set();
  const map = (archive && archive.pool && archive.pool.lastOpponentAt) || {};
  for (const [playerId, last] of Object.entries(map)) {
    if (at - last < hours * 3600000) out.add(playerId);
  }
  return out;
}

module.exports = {
  ARCHIVE_VERSION,
  RECORD_VERSION,
  TIERS,
  RECORD_TYPES,
  PLAYER_ID_RE,
  PUBLIC_ID_RE,
  USERNAME_RE,
  MIGRATIONS,
  applyDefaults,
  applyRecordToArchive,
  aggregateRecords,
  activeSlot,
  archiveRelPath,
  assertArchiveInvariants,
  checkSlotDeletable,
  checkSlotLimit,
  createArchive,
  createArchiveShell,
  createSlot,
  defaultRecentLimit,
  defenseSummaryOf,
  findSlot,
  isTier,
isRecordApplied,
  isValidNickname,
  isValidUsername,
  markSeen,
  maxSlotsOf,
  migrateArchive,
  newPlayerId,
  newPublicId,
  nextTier,
  opponentCooldownOk,
  playersOfRecord,
  randomHex,
  recentOpponents,
  recentView,
  shardOf,
  slotIdOf,
  summaryOf,
  syncActiveSnapshot,
  unreadOf,
  validateArchive,
  validateRecord,
};
