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
// D-171：决定 `board()` 输出的全部键（行字段 + 两张榜的排序键）。任一变 → 同时清掉两张榜的懒排序缓存。
const BOARD_ROW_KEYS = Object.freeze(['publicId', 'nickname', 'points', 'peakPoints', 'tier', 'tierUpdatedAt', 'banned']);

function boardRowChanged(prev, entry) {
  if (!prev) return true;
  for (const key of BOARD_ROW_KEYS) {
    if (prev[key] !== entry[key]) return true;
  }
  return false;
}

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
    // D-171：段位到达时间（段位榜同段位内按"先到者在前"排序）。老档案/老索引可能没有该字段 → null
    tierUpdatedAt: Number.isInteger(archive.progress.tierUpdatedAt) ? archive.progress.tierUpdatedAt : null,
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
  let sorted = null; // 懒排序缓存（积分榜）
  let arrivalSorted = null; // 懒排序缓存（段位榜；D-171）

  function reset() {
    data = emptyIndex();
    sorted = null;
    arrivalSorted = null;
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
    arrivalSorted = null;
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
    // 缓存失效口径（D-171 审查 F7-A 修正）：**决定 `board()` 输出的每个键**变化都必须同时清掉两张榜的缓存。
    //   修前只比 points/peakPoints/nickname/tier（漏 `banned`）⇒ `/admin/ban` 之后被封禁者**仍留在榜上**
    //   （行来自陈旧缓存、而 `self` 走新鲜数组 ⇒ 同一响应自相矛盾，违反 `systems/11` §8.6「封禁账号一律不进榜」）。
    //   修法：集中成一张键表，任一变即 `sorted = null; arrivalSorted = null;`（宁可多清一次，不可漏一个键）。
    if (boardRowChanged(prev, entry)) {
      sorted = null;
      arrivalSorted = null;
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
    arrivalSorted = null;
    return true;
  }

  function rebuild(archives, at) {
    data = emptyIndex();
    sorted = null;
    arrivalSorted = null;
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

  // D-171：**段位榜**排序 —— 段位由高到低（TIERS 序倒序）→ 同段位内 **tierUpdatedAt 升序**（先到者在前；
  //   缺该字段者排在本段位末尾）→ publicId 升序（稳定）。积分榜仍用 ensureSorted（points → peakPoints → updatedAt）。
  function ensureArrivalSorted() {
    if (arrivalSorted) return arrivalSorted;
    arrivalSorted = Object.keys(data.players).map((pid) => ({ playerId: pid, ...data.players[pid] }));
    arrivalSorted.sort((a, b) => {
      const ta = TIERS.indexOf(a.tier);
      const tb = TIERS.indexOf(b.tier);
      if (ta !== tb) return tb - ta;
      const aa = Number.isInteger(a.tierUpdatedAt) ? a.tierUpdatedAt : Number.MAX_SAFE_INTEGER;
      const bb = Number.isInteger(b.tierUpdatedAt) ? b.tierUpdatedAt : Number.MAX_SAFE_INTEGER;
      if (aa !== bb) return aa - bb;
      return a.publicId < b.publicId ? -1 : a.publicId > b.publicId ? 1 : 0;
    });
    return arrivalSorted;
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
  //   D-171 起 `board()` 是唯一实现，本函数保留为"只要行的"旧调用方薄封装（行为不变）。
  function leaderboard(query) {
    return board(query).rows;
  }

  // D-171：榜单查询（**唯一实现**）—— 两种榜 + 分页 + 本人名次。
  //   · order='points'（默认）= 积分榜（points → peakPoints → updatedAt）；
  //   · order='arrival' = **段位榜**（tier 高→低 → 同段位 tierUpdatedAt 升序 → publicId）；
  //   · scope：'global'（缺省）或 'tier:<t>'（单段位）；
  //   · 返回 `{rows, total, offset, limit, hasMore, self}`：`total` 是**该榜该 scope 的全量**，
  //     `self` 是调用者在本榜本 scope 的名次（无调用者/不在榜 → null；**不含 playerId**，与行一致不脱敏口径）。
  function board(query) {
    const q = query || {};
    const parsed = parseScope(q.scope);
    const order = q.order === 'arrival' ? 'arrival' : 'points';
    const offset = Number.isInteger(q.offset) && q.offset > 0 ? q.offset : 0;
    const limit = Number.isInteger(q.limit) && q.limit > 0 ? q.limit : 50;
    const source = order === 'arrival' ? ensureArrivalSorted() : ensureSorted();
    const all = source.filter((e) => !e.banned && (parsed.kind === 'global' || e.tier === parsed.tier));
    const rows = all.slice(offset, offset + limit).map((e, i) => ({
      rank: offset + i + 1, publicId: e.publicId, nickname: e.nickname, points: e.points, tier: e.tier,
      // 段位榜要显示"到达时间"；积分榜也一并回带（前端不读，字段恒定存在，便于同一套行投影）
      tierUpdatedAt: Number.isInteger(e.tierUpdatedAt) ? e.tierUpdatedAt : null,
    }));
    let self = null;
    if (typeof q.playerId === 'string' && q.playerId !== '') {
      const idx = all.findIndex((e) => e.playerId === q.playerId);
      if (idx >= 0) {
        const me = all[idx];
        self = {
          rank: idx + 1, publicId: me.publicId, nickname: me.nickname, points: me.points, tier: me.tier,
          tierUpdatedAt: Number.isInteger(me.tierUpdatedAt) ? me.tierUpdatedAt : null,
        };
      }
    }
    return {
      rows, total: all.length, offset, limit,
      hasMore: offset + rows.length < all.length,
      self,
    };
  }

  // D-171 迁移探针：索引里是否有条目**缺 `tierUpdatedAt` 这个键**（= D-171 之前落盘的老索引）→
  //   调用方（open()）重建索引补齐。
  //   ⚠️ 判据必须是"**缺键**"而不是"值不是整数"（审查 F7-B）：档案本身缺 `progress.tierUpdatedAt` 时
  //   `entryOf` 会写 `null`，若按值判真，则每次开机都会重建索引且**永不收敛**（全量读 + 重写 index.json）。
  //   档案侧的缺值由 `archive.stampTierUpdatedAt`（读档时一次性盖章）负责，两者职责分离。
  function needsTierStamp() {
    for (const pid of Object.keys(data.players)) {
      const entry = data.players[pid];
      if (!entry || !Object.prototype.hasOwnProperty.call(entry, 'tierUpdatedAt')) return true;
    }
    return false;
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
    board,
    needsTierStamp,
    rank,
    isLoaded: () => ok,
    toJSON: () => data,
    raw: () => data,
    stats: () => ({ players: Object.keys(data.players).length, seq: data.seq, builtAt: data.builtAt }),
  };
}

module.exports = { INDEX_VERSION, TIERS, emptyIndex, entryOf, createIndex };
