'use strict';
/* server/store/index-file.js —— 轻量索引：加载/保存/重建/`byTier`/`leaderboard`（D-129 §5.6/§7.2/§8.6）
 * 权威：docs/systems/11-account-store.md §5.6（结构）、§6.4（损坏可重建）、§8.6（排行榜排序）、§11.3（常驻内存）
 * 索引是**派生数据**：可随时由 `players/*.json` 重建；`seq` 字段只是水位缓存，真源是 journal。
 */
const { nullLogger } = require('../../shared/log.js');
const { StoreError } = require('./errors.js');
const fsatomic = require('./fsatomic.js');

const INDEX_VERSION = 1;
const TIERS = Object.freeze(['common', 'rare', 'epic', 'legendary', 'mythic']);

function emptyIndex() {
  return { indexVersion: INDEX_VERSION, seq: 0, builtAt: 0, players: {}, byTier: {}, leaderboard: [] };
}

// archive → 索引条目（只放匹配/排行榜/登录必需字段，约 200 B/玩家）
function entryOf(archive, archiveMtime) {
  const cfg = archive.configs || {};
  const active = (cfg.slots || []).find((s) => s.slotId === cfg.activeSlotId);
  return {
    publicId: archive.publicId,
    nickname: archive.nickname,
    tier: archive.progress.tier,
    points: archive.rating.points,
    peakPoints: archive.rating.peakPoints,
    activeSnapshotHash: cfg.activeSnapshotHash || (active && active.snapshot ? active.snapshot.hash : null),
    inPool: !!(archive.pool && archive.pool.inPool),
    isBot: !!(archive.flags && archive.flags.isBot),
    banned: !!(archive.flags && archive.flags.banned),
    lastSeenAt: archive.lastSeenAt === undefined ? null : archive.lastSeenAt,
    updatedAt: archive.updatedAt === undefined ? null : archive.updatedAt,
    archiveMtime: archiveMtime === undefined ? null : archiveMtime,
  };
}

function createIndex(options) {
  const opts = options || {};
  const log = opts.logger || nullLogger;
  let data = emptyIndex();
  let ok = false;
  let sorted = null; // 懒排序缓存

  function reset() {
    data = emptyIndex();
    sorted = null;
  }

  function isValid(raw) {
    return !!raw && typeof raw === 'object' && raw.indexVersion === INDEX_VERSION
      && raw.players && typeof raw.players === 'object' && !Array.isArray(raw.players)
      && raw.byTier && typeof raw.byTier === 'object';
  }

  // 读入磁盘索引；损坏 → false（调用方进入重建分支）
  function load(raw) {
    if (!isValid(raw)) {
      ok = false;
      reset();
      return false;
    }
    data = {
      indexVersion: INDEX_VERSION,
      seq: Number.isInteger(raw.seq) ? raw.seq : 0,
      builtAt: Number.isInteger(raw.builtAt) ? raw.builtAt : 0,
      players: { ...raw.players },
      byTier: {},
      leaderboard: Array.isArray(raw.leaderboard) ? raw.leaderboard.map((e) => ({ ...e })) : [],
    };
    for (const tier of TIERS) {
      const list = raw.byTier[tier];
      data.byTier[tier] = Array.isArray(list) ? list.filter((pid) => typeof pid === 'string') : [];
    }
    sorted = null;
    ok = true;
    return true;
  }

  function save(file) {
    return fsatomic.writeJsonAtomicSync(file, data, { logger: log, pretty: true });
  }

  function setSeq(seq) {
    if (Number.isInteger(seq) && seq > data.seq) data.seq = seq;
  }

  function upsert(archive, archiveMtime) {
    const pid = archive.playerId;
    const entry = entryOf(archive, archiveMtime);
    const prev = data.players[pid];
    if (prev && prev.tier !== entry.tier) {
      const list = data.byTier[prev.tier];
      if (Array.isArray(list)) data.byTier[prev.tier] = list.filter((id) => id !== pid);
    }
    if (!data.byTier[entry.tier]) data.byTier[entry.tier] = [];
    if (!data.byTier[entry.tier].includes(pid)) data.byTier[entry.tier].push(pid);
    data.players[pid] = entry;
    if (!prev || prev.points !== entry.points || prev.peakPoints !== entry.peakPoints
      || prev.nickname !== entry.nickname || prev.tier !== entry.tier) {
      sorted = null;
    }
    return entry;
  }

  function remove(playerId) {
    const prev = data.players[playerId];
    if (!prev) return false;
    delete data.players[playerId];
    const list = data.byTier[prev.tier];
    if (Array.isArray(list)) data.byTier[prev.tier] = list.filter((id) => id !== playerId);
    sorted = null;
    return true;
  }

  function rebuild(archives, at) {
    data = emptyIndex();
    sorted = null;
    for (const archive of archives || []) upsert(archive, archive.archiveMtime);
    data.builtAt = Number.isInteger(at) ? at : Date.now();
    ok = true;
    log.info('store', 'store.index.rebuild', `索引已重建（${Object.keys(data.players).length} 玩家）`, {
      players: Object.keys(data.players).length, seq: data.seq,
    });
    return data;
  }

  function ensureSorted() {
    if (sorted) return sorted;
    sorted = Object.keys(data.players).map((pid) => ({ playerId: pid, ...data.players[pid] }));
    sorted.sort((a, b) => {
      if (b.points !== a.points) return b.points - a.points;
      if (b.peakPoints !== a.peakPoints) return b.peakPoints - a.peakPoints;
      if ((a.updatedAt || 0) !== (b.updatedAt || 0)) return (a.updatedAt || 0) - (b.updatedAt || 0);
      return a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0;
    });
    data.leaderboard = sorted.map((e) => ({ publicId: e.publicId, points: e.points }));
    return sorted;
  }

  function parseScope(scope) {
    const s = scope === undefined || scope === null || scope === '' ? 'global' : String(scope);
    if (s === 'global') return { kind: 'global' };
    const m = /^tier:([a-z]+)$/.exec(s);
    if (m) {
      if (!TIERS.includes(m[1])) throw new StoreError('bad_scope', `非法排行榜 scope: ${s}`);
      return { kind: 'tier', tier: m[1] };
    }
    throw new StoreError('bad_scope', `非法排行榜 scope: ${s}`);
  }

  // 排行榜（§8.6）：按 points 降序 → peakPoints 降序 → updatedAt 升序；不暴露 playerId
  function leaderboard(query) {
    const q = query || {};
    const parsed = parseScope(q.scope);
    const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 50;
    const all = ensureSorted().filter((e) => !e.banned && (parsed.kind === 'global' || e.tier === parsed.tier));
    return all.slice(0, limit).map((e, i) => ({
      rank: i + 1, publicId: e.publicId, nickname: e.nickname, points: e.points, tier: e.tier,
    }));
  }

  function rank(playerId) {
    const list = ensureSorted();
    const idx = list.findIndex((e) => e.playerId === playerId);
    return idx === -1 ? null : idx + 1;
  }

  function byTier(tier) {
    const list = data.byTier[tier];
    return Array.isArray(list) ? list.slice() : [];
  }

  return {
    TIERS,
    emptyIndex,
    reset,
    load,
    save,
    rebuild,
    upsert,
    remove,
    setSeq,
    seq: () => data.seq,
    get: (playerId) => (data.players[playerId] ? { ...data.players[playerId] } : null),
    has: (playerId) => Object.prototype.hasOwnProperty.call(data.players, playerId),
    size: () => Object.keys(data.players).length,
    playerIds: () => Object.keys(data.players),
    byTier,
    leaderboard,
    rank,
    isLoaded: () => ok,
    toJSON: () => data,
    raw: () => data,
    stats: () => ({ players: Object.keys(data.players).length, seq: data.seq, builtAt: data.builtAt }),
  };
}

module.exports = { INDEX_VERSION, TIERS, emptyIndex, entryOf, createIndex };
