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

const ARCHIVE_VERSION = 2;
const RECORD_VERSION = 1;
const TIERS = Object.freeze(['common', 'rare', 'epic', 'legendary', 'mythic']);
const DEFAULT_MAX_SLOTS = 3;
const DEFAULT_RECENT_LIMIT = 100;
const PLAYER_ID_RE = /^pl_[0-9a-f]{16}$/;
const PUBLIC_ID_RE = /^u_[0-9a-f]{8}$/;
const USERNAME_RE = /^[A-Za-z0-9_-]{3,24}$/;

// ---------- D-159：服务端权威仓库（四桶）与 D-161：AI 库 ----------
const WAREHOUSE_BUCKETS = Object.freeze(['role', 'skill', 'rolePlugin', 'skillPlugin']);
const DEFAULT_WAREHOUSE_MAX_PER_BUCKET = 500;
const DEFAULT_AI_MAX_PER_PLAYER = 100;
// 开箱批次幂等环形窗口（与 server/index.js 的 EVICTED_REMEMBERED 同量级）：记录最近若干 grantId +
//   seq，用于"水位已过但内容键能证明已应用"的判定（§6.3 幂等规则，与 battleId 环形窗口同构）
const GRANT_WINDOW = 256;
// 这些记录改变的是**状态量**（仓库正文 / AI 库），无法由"段内增量"无损重建 →
//   含它们的 journal 段**不参与 compact**（真源始终留在 journal；检查点里的物化态只作降级兜底）
const NON_COMPACTABLE = Object.freeze(['box.opened', 'warehouse.assemble', 'warehouse.disassemble', 'ai.created', 'ai.deleted']);

function warehouseMaxPerBucketOf(config) {
  const v = config && config.warehouse && config.warehouse.maxPerBucket;
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_WAREHOUSE_MAX_PER_BUCKET;
}

function aiMaxPerPlayerOf(config) {
  const v = config && config.ai && config.ai.maxPerPlayer;
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_AI_MAX_PER_PLAYER;
}

// 四桶空仓库（与 core/items.emptyWarehouse 同形；store 层不得 require core，故本地重建）
function emptyWarehouse() {
  return { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
}

function normalizeWarehouse(raw) {
  const src = raw && typeof raw === 'object' && raw.buckets && typeof raw.buckets === 'object' ? raw.buckets : {};
  const out = emptyWarehouse();
  for (const key of WAREHOUSE_BUCKETS) {
    out.buckets[key] = Array.isArray(src[key]) ? deepClone(src[key]) : [];
  }
  return out;
}

function warehouseCounts(warehouse) {
  const out = {};
  const buckets = (warehouse && warehouse.buckets) || {};
  for (const key of WAREHOUSE_BUCKETS) out[key] = Array.isArray(buckets[key]) ? buckets[key].length : 0;
  return out;
}

// 仓库内按 uid 找物品（返回 {bucket,item,index} 或 null；四桶全局唯一由写入路径保证）
function findWarehouseItem(warehouse, uid) {
  if (!warehouse || typeof warehouse !== 'object') return null;
  for (const key of WAREHOUSE_BUCKETS) {
    const list = (warehouse.buckets || {})[key];
    if (!Array.isArray(list)) continue;
    const index = list.findIndex((it) => it && it.uid === uid);
    if (index >= 0) return { bucket: key, item: list[index], index };
  }
  return null;
}

// D-163（2026-09-25 热修）：发放路径的 uid 必须**四桶唯一**。
//   物品 uid 由 core 的**模块级**计数器生成（`item_<seq>`，进程级）——进程重启后计数器归零，于是同一
//   玩家"重启前领的物品"与"重启后领的物品"会撞 uid；而 apply 分支对撞 uid 的发放只能丢弃
//   （实测：真重启后开箱 12 件，响应/journal 记 12 件、档案只落 2 件，且**零日志**）。
//   本函数在**写 journal 记录之前**把撞车的 uid 重映射为仓库内空闲的 `item_<n>`（n 从"现有最大编号+1"
//   起，同一批次内也逐个避开）→ "响应 = journal 记录 = 档案"三者一致；重放按记录里的 uid 落档，仍确定。
//   返回 {items（新数组，不改入参）, remapped:[{from,to}]}。
function allocateGrantUids(warehouse, items) {
  const list = Array.isArray(items) ? items : [];
  const used = new Set();
  for (const bucket of WAREHOUSE_BUCKETS) {
    const arr = (warehouse && warehouse.buckets && warehouse.buckets[bucket]) || [];
    for (const it of Array.isArray(arr) ? arr : []) {
      if (it && typeof it.uid === 'string' && it.uid !== '') used.add(it.uid);
    }
  }
  let next = 1;
  const bump = (uid) => {
    const m = /^item_(\d+)$/.exec(typeof uid === 'string' ? uid : '');
    if (m) next = Math.max(next, Number(m[1]) + 1);
  };
  for (const uid of used) bump(uid);
  for (const it of list) bump(it && it.uid); // 同一批次内已用编号也要避开
  const out = [];
  const remapped = [];
  for (const it of list) {
    if (!it || typeof it !== 'object') { out.push(it); continue; }
    const uid = typeof it.uid === 'string' ? it.uid : '';
    if (uid !== '' && !used.has(uid)) { used.add(uid); out.push(it); continue; }
    let fresh = `item_${next}`;
    while (used.has(fresh)) { next += 1; fresh = `item_${next}`; }
    next += 1;
    used.add(fresh);
    remapped.push({ from: uid === '' ? null : uid, to: fresh });
    out.push(Object.assign({}, it, { uid: fresh }));
  }
  return { items: out, remapped };
}

// 「该物品装配于哪个出战配置」派生视图（§5.2 的 data.usage）：
//   同一物品可被多个配置引用（服务端不禁止）→ 每个 uid 列出全部 slotId。
function warehouseUsage(archive) {
  const usage = {};
  const mark = (uid, slotId) => {
    if (typeof uid !== 'string' || uid === '') return;
    if (!usage[uid]) usage[uid] = { slotIds: [] };
    if (!usage[uid].slotIds.includes(slotId)) usage[uid].slotIds.push(slotId);
  };
  for (const slot of (archive && archive.configs && archive.configs.slots) || []) {
    const ld = slot && slot.loadout;
    if (!ld || typeof ld !== 'object') continue;
    if (ld.role && typeof ld.role.uid === 'string') mark(ld.role.uid, slot.slotId);
    for (const sk of Array.isArray(ld.skills) ? ld.skills : []) {
      if (sk && typeof sk.uid === 'string') mark(sk.uid, slot.slotId);
    }
    // 插件：角色/技能物品的 slots[].pluginUid 指向插件物品
    const collect = (item) => {
      for (const s of (item && Array.isArray(item.slots)) ? item.slots : []) {
        if (s && typeof s.pluginUid === 'string' && s.pluginUid !== '') mark(s.pluginUid, slot.slotId);
      }
    };
    collect(ld.role);
    for (const sk of Array.isArray(ld.skills) ? ld.skills : []) collect(sk);
  }
  return usage;
}

// D-160：出战配置的完整性判据（角色 + 恰 3 技能 + AI；**允许插槽为空**）
function loadoutMissingOf(loadout) {
  const missing = [];
  if (!loadout || typeof loadout !== 'object' || Array.isArray(loadout)) return ['loadout'];
  if (!loadout.role || typeof loadout.role !== 'object') missing.push('role');
  const skills = Array.isArray(loadout.skills) ? loadout.skills : [];
  for (let i = 0; i < 3; i += 1) {
    if (!skills[i] || typeof skills[i] !== 'object') missing.push(`skills[${i}]`);
  }
  if (skills.length > 3) missing.push('skills.length');
  if (!loadout.ai || typeof loadout.ai !== 'object') missing.push('ai');
  return missing;
}

function isLoadoutComplete(loadout) {
  return loadoutMissingOf(loadout).length === 0;
}

// D-160：缺项 → 逐位置 details（前端逐条渲染；文案与既有 loadout_invalid 口径一致）
function loadoutMissingDetails(missing, code) {
  const c = code || 'loadout_invalid';
  return (missing || []).map((p) => {
    let message = `缺少 ${p}`;
    if (p === 'loadout') message = '缺少出战配置';
    else if (p === 'role') message = '缺少角色物品';
    else if (p === 'ai') message = '缺少 AI 程序';
    else if (p === 'skills.length') message = '技能必须恰 3 个';
    else {
      const m = /^skills\[(\d+)\]$/.exec(p);
      if (m) message = `技能位置缺失: ${m[1]}`;
    }
    return { path: p, code: c, message };
  });
}

function emptyIncompleteLoadout() {
  return { role: null, skills: [null, null, null], ai: null };
}

function findAi(archive, aiId) {
  return ((archive && archive.ai && archive.ai.items) || []).find((x) => x && x.aiId === aiId) || null;
}


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
  // D-159：开箱发放（服务端权威仓库）与装配/拆卸（增量记录，回放可确定性重演）
  'box.opened',
  'warehouse.assemble',
  'warehouse.disassemble',
  // D-161：AI 库
  'ai.created',
  'ai.deleted',
  // D-170：管理员直接改账号段位/积分/入池（运维与验收用；写 journal 留痕、可重放）
  'account.patched',
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
    // D-159：服务端权威仓库（四桶）。grantIds 只用于开箱记录的幂等判定（环形窗口，可重建）
    warehouse: { ...emptyWarehouse(), starterIssued: false, grantIds: [] },
    // D-161：AI 库（与物品分别计数）
    ai: { items: [] },
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
  if (opts.warehouse) {
    archive.warehouse = { ...normalizeWarehouse(opts.warehouse), starterIssued: !!opts.starterIssued, grantIds: [] };
  }
  if (Array.isArray(opts.aiLibrary)) {
    archive.ai.items = opts.aiLibrary
      .filter((a) => a && typeof a.aiId === 'string' && a.aiId !== '')
      .map((a) => ({
        aiId: a.aiId,
        name: a.name === undefined || a.name === null ? a.aiId : a.name,
        program: deepClone(a.program),
        createdAt: at,
        updatedAt: at,
      }));
  }
  // D-159/D-160：注册可一次建多个槽（slot1 = starter 完整出战；slot2/slot3 = 空槽，无快照）
  const slotInputs = Array.isArray(opts.slots) ? opts.slots : (opts.slot ? [opts.slot] : []);
  if (slotInputs.length > 0) {
    const slots = [];
    let activeId = null;
    for (let i = 0; i < slotInputs.length; i += 1) {
      const spec = slotInputs[i] || {};
      const isFirst = i === 0;
      const slot = createSlot({ ...spec, at, isDefault: isFirst ? true : spec.isDefault === true });
      if (isFirst || spec.activate === true) activeId = slot.slotId;
      slots.push(slot);
    }
    archive.configs.slots = slots;
    archive.configs.activeSlotId = activeId === null ? slots[0].slotId : activeId;
    const active = slots.find((s) => s.slotId === archive.configs.activeSlotId);
    archive.configs.activeSnapshotHash = active && active.snapshot ? active.snapshot.hash : null;
    archive.flags.unverifiedLoadout = !(active && active.snapshot && active.snapshot.verifiedAgainstWarehouse);
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
  for (const section of ['progress', 'rating', 'configs', 'pool', 'record', 'flags', 'warehouse', 'ai']) {
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
      // D-160：**非出战槽允许不完整**（可无快照、可缺角色/技能/AI）；出战槽必须完整且有已冻结快照
      const isActive = slot.slotId === archive.configs.activeSlotId;
      if (!rebuilt && isActive && (!slot.snapshot || !isHash(slot.snapshot.hash))) {
        pushError(errors, 'no_active_config', `出战槽 ${slot.slotId} 缺少已冻结快照`, `configs.slots.${slot.slotId}`);
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
  // D-159：服务端权威仓库（四桶 + 每桶上限 + uid 四桶全局唯一）
  const wh = archive.warehouse;
  if (wh && typeof wh === 'object') {
    const cap = warehouseMaxPerBucketOf(config);
    const seenUid = new Set();
    const buckets = wh.buckets;
    if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) {
      pushError(errors, 'store_inconsistent', 'warehouse.buckets 必须是对象', 'warehouse.buckets');
    } else {
      for (const key of WAREHOUSE_BUCKETS) {
        const list = buckets[key];
        if (!Array.isArray(list)) {
          pushError(errors, 'store_inconsistent', `warehouse.buckets.${key} 必须是数组`, `warehouse.buckets.${key}`);
          continue;
        }
        if (list.length > cap) {
          pushError(errors, 'warehouse_full', `warehouse.buckets.${key} 长度 ${list.length} 超过上限 ${cap}`, `warehouse.buckets.${key}`);
        }
        for (const it of list) {
          if (!it || typeof it !== 'object' || typeof it.uid !== 'string' || it.uid === '') {
            pushError(errors, 'store_inconsistent', `warehouse.buckets.${key} 含非法物品`, `warehouse.buckets.${key}`);
            continue;
          }
          if (seenUid.has(it.uid)) pushError(errors, 'store_inconsistent', `仓库 uid 重复 ${it.uid}`, `warehouse.buckets.${key}`);
          seenUid.add(it.uid);
        }
      }
    }
    if (!Array.isArray(wh.grantIds)) pushError(errors, 'store_inconsistent', 'warehouse.grantIds 必须是数组', 'warehouse.grantIds');
  }
  // D-161：AI 库（上限 + aiId 唯一）
  const aiLib = archive.ai;
  if (aiLib && typeof aiLib === 'object') {
    const items = aiLib.items;
    const cap = aiMaxPerPlayerOf(config);
    if (!Array.isArray(items)) {
      pushError(errors, 'store_inconsistent', 'ai.items 必须是数组', 'ai.items');
    } else {
      if (items.length > cap) pushError(errors, 'ai_limit', `ai.items 长度 ${items.length} 超过上限 ${cap}`, 'ai.items');
      const seenAi = new Set();
      for (const a of items) {
        if (!a || typeof a.aiId !== 'string' || a.aiId === '') {
          pushError(errors, 'store_inconsistent', 'ai.items 含非法条目', 'ai.items');
          continue;
        }
        if (seenAi.has(a.aiId)) pushError(errors, 'store_inconsistent', `aiId 重复 ${a.aiId}`, 'ai.items');
        seenAi.add(a.aiId);
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

// v1 → v2（D-159/D-161）：补齐服务端权威仓库段与 AI 库段。
//   **老账号保持空仓**（用户 2026-09-22 裁定）：迁移只补空结构，不补发 starter（starterIssued=false），
//   因此 v1 存量档案升级后仓库为空、需删号重注册才能拿到新手套装。
function migrateV1toV2(raw) {
  const out = deepClone(raw);
  const wh = out.warehouse;
  out.warehouse = {
    ...normalizeWarehouse(wh),
    starterIssued: !!(wh && wh.starterIssued === true),
    grantIds: Array.isArray(wh && wh.grantIds) ? wh.grantIds.filter((g) => g && typeof g.grantId === 'string') : [],
  };
  if (!out.ai || typeof out.ai !== 'object' || !Array.isArray(out.ai.items)) out.ai = { items: [] };
  return out;
}

const MIGRATIONS = Object.freeze({ 1: migrateV0toV1, 2: migrateV1toV2 });

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

// ---------- 装配引用子集（缺口 1：快照自带镜像） ----------
// 背景：仓库由客户端权威持有（D-130），服务端**只**在进程内缓存镜像；进程重启/缓存淘汰后，
//   `flags.unverifiedLoadout === false` 的玩家的装配引用无法再解析 → 只能用基准面板退化实例化
//   （插件词条不生效）。修法：把"该次校验所用的镜像"中**该配置实际引用到的那几个插件项**
//   随冻结快照一起持久化（进快照库正文），此后对局与回放不再依赖进程内缓存。
// 数据量有界：只取 `loadout.role.slots[].pluginUid` 与 `loadout.skills[].slots[].pluginUid`
//   命中的项（上限 = 槽位数），不整仓拷贝；无引用 → null（不落该字段，旧快照形状不变）。
// 语义：本函数**只取值、不校验**（校验由 loadout.validateLoadout 在前置步骤完成）；
//   取不到任何引用项 → 返回 null（宁可不落，也不落一份不足以重建面板的空壳）。
function warehouseExcerpt(loadout, warehouse) {
  if (!loadout || typeof loadout !== 'object') return null;
  if (!warehouse || typeof warehouse !== 'object') return null;
  const bucketsIn = warehouse.buckets;
  if (!bucketsIn || typeof bucketsIn !== 'object' || Array.isArray(bucketsIn)) return null;
  const refs = loadoutRefs(loadout);
  if (refs.length === 0) return null;
  const wanted = new Set(refs);
  const buckets = {};
  let found = 0;
  for (const key of Object.keys(bucketsIn)) {
    const list = bucketsIn[key];
    if (!Array.isArray(list)) continue;
    const picked = list.filter((it) => it && typeof it === 'object' && wanted.has(it.uid));
    if (picked.length > 0) {
      buckets[key] = deepClone(picked);
      found += picked.length;
    }
  }
  return found > 0 ? { buckets } : null;
}

// 出战配置引用的插件 uid 列表（role.slots[] + skills[].slots[]；顺序稳定、含重复以便双引用检测）
function loadoutRefs(loadout) {
  const refs = [];
  const collect = (slots) => {
    for (const s of Array.isArray(slots) ? slots : []) {
      if (s && typeof s.pluginUid === 'string' && s.pluginUid !== '') refs.push(s.pluginUid);
    }
  };
  if (!loadout || typeof loadout !== 'object') return refs;
  collect(loadout.role && loadout.role.slots);
  for (const sk of Array.isArray(loadout.skills) ? loadout.skills : []) collect(sk && sk.slots);
  return refs;
}

// 摘录是否覆盖该配置的全部装配引用（自省/诊断用；缺口 1 的"足够重建面板"判定）
function excerptCoversRefs(loadout, excerpt) {
  const refs = loadoutRefs(loadout);
  if (refs.length === 0) return false;
  const uids = new Set();
  for (const list of Object.values((excerpt && excerpt.buckets) || {})) {
    for (const it of Array.isArray(list) ? list : []) if (it && it.uid) uids.add(it.uid);
  }
  return refs.every((uid) => uids.has(uid));
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
    // D-170：管理员改账号——幂等键 = "当前值已等于记录值即视为已应用"
    case 'account.patched': {
      if (isTier(record.tier) && archive.progress.tier !== record.tier) return false;
      if (Number.isInteger(record.points) && archive.rating.points !== record.points) return false;
      if (typeof record.inPool === 'boolean' && archive.pool.inPool !== record.inPool) return false;
      return true;
    }
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
    // D-159：开箱批次（grantIds 环形窗口，与 battleId 同构）
    case 'box.opened': {
      const ring = (archive.warehouse && archive.warehouse.grantIds) || [];
      if (ring.some((g) => g && g.grantId === record.grantId)) return true;
      const windowFrom = ring.length > 0 ? ring[0].seq : null;
      return windowFrom !== null && record.seq < windowFrom;
    }
    // D-159：装配/拆卸 —— 内容键 = 目标槽当前的 pluginUid 是否已是记录要求的值
    case 'warehouse.assemble': {
      const found = findWarehouseItem(archive.warehouse, record.targetUid);
      if (!found) return false;
      const slot = (found.item.slots || [])[record.slotIndex];
      return !!slot && slot.pluginUid === record.pluginUid;
    }
    case 'warehouse.disassemble': {
      const found = findWarehouseItem(archive.warehouse, record.targetUid);
      if (!found) return false;
      const slot = (found.item.slots || [])[record.slotIndex];
      return !!slot && (slot.pluginUid === null || slot.pluginUid === undefined);
    }
    // D-161：AI 库
    case 'ai.created':
      return findAi(archive, record.aiId) !== null;
    case 'ai.deleted':
      return findAi(archive, record.aiId) === null;
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
  // D-160：非出战槽允许不完整 —— 无快照时把 loadout 正文随记录携带（记录体积有界：空/半成品配置）
  const inlineLoadout = record.loadout === undefined ? undefined : deepClone(record.loadout);
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
      loadout: snapshot ? snapshot.loadout : (inlineLoadout === undefined ? null : inlineLoadout),
      snapshot: record.snapshotHash ? slotSnapshotFromRecord(record, at) : null,
    });
    archive.configs.slots.push(slot);
  } else {
    if (record.name !== undefined) slot.name = record.name;
    if (snapshot) slot.loadout = deepClone(snapshot.loadout);
    else if (inlineLoadout !== undefined) slot.loadout = inlineLoadout;
    slot.snapshot = record.snapshotHash ? slotSnapshotFromRecord(record, at) : null;
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
  // D-159/D-161：检查点携带的仓库/AI 物化态（老检查点无该字段 → 保持空）
  if (totals.warehouse) {
    archive.warehouse = { ...normalizeWarehouse(totals.warehouse), starterIssued: true, grantIds: [] };
  }
  if (Array.isArray(totals.ai)) {
    archive.ai.items = deepClone(totals.ai);
  }
  return { changed: true };
}

// 应用一条 journal 记录到某个玩家档案（幂等；返回 {changed}）
async function applyRecordToArchive(archive, record, playerId, ctx) {
  const at = Number.isInteger(record.at) ? record.at : ctx.now();
  switch (record.type) {
    case 'account.created':
    case 'admin.bot.injected': {
      let changed = applyAccountFields(archive, record, at);
      // D-159：注册即发 starter（服务端权威仓库）——仓库正文随记录携带（一次性、有界 ≤ 1+3+n 件）
      if (record.warehouse) {
        archive.warehouse = {
          ...normalizeWarehouse(record.warehouse),
          starterIssued: true,
          grantIds: (archive.warehouse && archive.warehouse.grantIds) || [],
        };
        changed = true;
      }
      // D-161：注册即带一条默认 AI（starter 的 AI 同时登记进库，供配置编辑器选择）
      if (Array.isArray(record.aiLibrary)) {
        for (const a of record.aiLibrary) {
          if (!a || typeof a.aiId !== 'string' || a.aiId === '') continue;
          if (findAi(archive, a.aiId)) continue;
          archive.ai.items.push({
            aiId: a.aiId,
            name: a.name === undefined || a.name === null ? a.aiId : a.name,
            program: deepClone(a.program),
            createdAt: at,
            updatedAt: at,
          });
          changed = true;
        }
      }
      // D-159/D-160：注册可一次建多个槽（slot1 完整出战 + slot2/slot3 空槽）
      const slotRecords = Array.isArray(record.slots) ? record.slots : (record.slot ? [record.slot] : []);
      for (let i = 0; i < slotRecords.length; i += 1) {
        const spec = slotRecords[i] || {};
        const isFirst = i === 0;
        const res = await applyConfigSaved(archive, {
          ...spec, at,
          activate: isFirst ? true : spec.activate === true,
          create: true,
          isDefault: isFirst ? true : spec.isDefault === true,
        }, ctx);
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
    // D-170：管理员直接改段位/积分/入池。**峰值只升不降**（`max`，不变量 `peakPoints >= points` /
    //   `TIERS.indexOf(peakTier) >= TIERS.indexOf(tier)` 必须保持）：调高时峰值随之上移（"曾经达到过"依然成立），
    //   调低时峰值原样保留 —— 于是**永远无法用改档伪造（压低）历史峰值**（用户 2026-09-25 裁定）；
    //   段位变化同步 tierUpdatedAt（段位榜按到达时间排序要用）。
    case 'account.patched': {
      let changed = false;
      if (isTier(record.tier) && archive.progress.tier !== record.tier) {
        archive.progress.tier = record.tier;
        if (TIERS.indexOf(record.tier) > TIERS.indexOf(archive.progress.peakTier)) {
          archive.progress.peakTier = record.tier;
        }
        archive.progress.tierUpdatedAt = at;
        changed = true;
      }
      if (Number.isInteger(record.points)) {
        const p = Math.max(0, record.points); // 上限由 admin 层按 rating-config.cap 校验（此处只保证非负）
        if (archive.rating.points !== p) {
          archive.rating.points = p;
          archive.rating.peakPoints = Math.max(archive.rating.peakPoints, p);
          changed = true;
        }
      }
      if (typeof record.inPool === 'boolean' && archive.pool.inPool !== record.inPool) {
        archive.pool.inPool = record.inPool;
        if (record.inPool && !Number.isInteger(archive.pool.enteredAt)) archive.pool.enteredAt = at;
        changed = true;
      }
      return { changed };
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
    // D-159：开箱发放（幂等键 = grantId 环形窗口；物品按 kind 入桶）
    //   超限防御分支（独立审查 F-2）：正常路径由 `adapter.grantBox` **前置**拒绝（409 原子、零写入），
    //   本分支只在"档案仓库与 journal 不一致"时可达。修前它**静默丢弃**却仍报 `changed:true` 并推进水位
    //   → journal 写"N 件"、档案只落 M<N 件且**永久漂移**（水位已过，rebuild 也补不回）。
    //   现改为：逐件 `error` 记录（带 grantId/uid/桶）+ 把 `dropped` 落进 grantIds 环形条目，
    //   使差额**可审计、可判定**（不改判定语义、不抛错——抛错会让 journal 重放永久失败）。
    case 'box.opened': {
      const cap = warehouseMaxPerBucketOf(ctx.config);
      const ring = (archive.warehouse && Array.isArray(archive.warehouse.grantIds)) ? archive.warehouse.grantIds : [];
      if (record.grantId && ring.some((g) => g && g.grantId === record.grantId)) return { changed: false };
      let added = 0;
      const dropped = [];
      for (const it of Array.isArray(record.items) ? record.items : []) {
        if (!it || typeof it !== 'object' || typeof it.uid !== 'string' || it.uid === '') continue;
        const bucket = it.kind === 'skillPlugin' ? 'skillPlugin'
          : it.kind === 'rolePlugin' ? 'rolePlugin'
            : it.kind === 'skill' ? 'skill' : 'role';
        const list = archive.warehouse.buckets[bucket];
        if (!Array.isArray(list)) continue;
        if (findWarehouseItem(archive.warehouse, it.uid)) {
          // D-163 热修：uid 撞车在**发放路径**已被 `allocateGrantUids` 消解；能走到这里说明是
          //   "档案与 journal 不一致"或历史遗留记录 —— 绝不能静默丢（修前就是静默 `continue`）。
          dropped.push({ uid: it.uid, kind: it.kind, bucket });
          ctx.logger.error('store', 'store.warehouse.uid_collision',
            `开箱发放 uid 与档案已有物品冲突，已丢弃该件（journal 记为发放、档案未落）——需人工核对`,
            { playerId, uid: it.uid, bucket, grantId: record.grantId || null, droppedCount: dropped.length });
          continue;
        }
        if (list.length >= cap) {
          dropped.push({ uid: it.uid, kind: it.kind, bucket });
          ctx.logger.error('store', 'store.warehouse.full',
            `开箱发放超限丢弃（${bucket} 已达 ${cap}）——journal 与档案出现差额，需人工核对`,
            { playerId, uid: it.uid, bucket, cap, grantId: record.grantId || null, droppedCount: dropped.length });
          continue;
        }
        list.push(deepClone(it));
        added += 1;
      }
      if (record.grantId) {
        // `dropped` 落进环形条目：差额在档案里**可见**（`GET /me/warehouse` 不带该字段，但 journal/档案可审计）
        ring.push({
          grantId: record.grantId, seq: record.seq, at, count: added,
          ...(dropped.length > 0 ? { dropped: dropped.length, droppedUids: dropped.map((d) => d.uid).slice(0, 8) } : {}),
        });
        while (ring.length > GRANT_WINDOW) ring.shift();
        archive.warehouse.grantIds = ring;
      }
      return { changed: added > 0 || !!record.grantId || dropped.length > 0 };
    }
    // D-159：装配/拆卸 —— 改目标物品的插槽引用 **并同步插件物品的 `equipped` 标志**。
    //   `equipped` 是**语义承重**字段：`server/loadout.js` 用它判"插件未装配"（`p.equipped !== true`
    //   → loadout_invalid），`core/items.assemble` 用它判"插件已装配别处"（→ 409 plugin_equipped）。
    //   L6 端点先用 core/items 纯函数校验（那时 `equipped` 只改在克隆上），**校验结果必须在这里落档**，
    //   否则会出现两个真实缺陷：① 拆卸后插件仍是 equipped=true → 再也装不回去（plugin_equipped）；
    //   ② 新装配的插件 equipped 未置位 → 引用它的出战配置保存时报"插件未装配"。
    case 'warehouse.assemble':
    case 'warehouse.disassemble': {
      const found = findWarehouseItem(archive.warehouse, record.targetUid);
      if (!found) {
        ctx.logger.warn('store', 'store.error', `仓库变更目标不存在（${record.type}）：${record.targetUid}`, {
          playerId, targetUid: record.targetUid, type: record.type,
        });
        return { changed: false };
      }
      const slots = found.item.slots;
      const slot = Array.isArray(slots) ? slots[record.slotIndex] : null;
      if (!slot) {
        ctx.logger.warn('store', 'store.error', `仓库变更槽位不可用（${record.type}）：${record.targetUid}[${record.slotIndex}]`, {
          playerId, targetUid: record.targetUid, slotIndex: record.slotIndex, type: record.type,
        });
        return { changed: false };
      }
      const prevPluginUid = slot.pluginUid === undefined ? null : slot.pluginUid;
      slot.pluginUid = record.type === 'warehouse.assemble' ? record.pluginUid : null;
      // 独立审查加固：**直接替换**槽位引用时（journal 里出现"装 A 再装 B 到同一槽"）必须把 A 复位为
      //   未装配，否则 A 会永久停在 equipped=true（再也装不回去）。HTTP 路径由 core/items 的
      //   `slot_occupied` 拦死，故本分支不可达；这里做的是"畸形/重放记录"下的自洽兜底。
      if (record.type === 'warehouse.assemble' && prevPluginUid !== null && prevPluginUid !== record.pluginUid) {
        const prev = findWarehouseItem(archive.warehouse, prevPluginUid);
        if (prev && prev.item) prev.item.equipped = false;
      }
      if (record.type === 'warehouse.disassemble') {
        // 拆下来的插件恢复"未装配"（找不到物品时只记 warn：数据自洽性由 L6 前置校验保证）
        const prev = prevPluginUid === null ? null : findWarehouseItem(archive.warehouse, prevPluginUid);
        if (prev && prev.item) prev.item.equipped = false;
      } else {
        const plugin = findWarehouseItem(archive.warehouse, record.pluginUid);
        if (plugin && plugin.item) plugin.item.equipped = true;
        else {
          ctx.logger.warn('store', 'store.error', `装配记录引用的插件不在仓库：${record.pluginUid}`, {
            playerId, targetUid: record.targetUid, pluginUid: record.pluginUid, type: record.type,
          });
        }
      }
      return { changed: true };
    }
    // D-161：AI 库
    case 'ai.created': {
      if (findAi(archive, record.aiId)) return { changed: false };
      archive.ai.items.push({
        aiId: record.aiId,
        name: record.name === undefined ? record.aiId : record.name,
        program: deepClone(record.program),
        createdAt: at,
        updatedAt: at,
      });
      return { changed: true };
    }
    case 'ai.deleted': {
      const before = archive.ai.items.length;
      archive.ai.items = archive.ai.items.filter((x) => !x || x.aiId !== record.aiId);
      return { changed: archive.ai.items.length !== before };
    }
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
// D-159/D-161：仓库与 AI 库是**状态量**（不是增量）——这里按段内记录**物化**一份，
//   供"档案损坏后按检查点重建"时恢复（与其它计数一样属**精度降级**路径；
//   含仓库/AI 变更的段不参与 compact，故真源仍是 journal，见 NON_COMPACTABLE）。
function applyRecordToMaterializedWarehouse(wh, record) {
  if (!wh || !record) return;
  if (record.type === 'box.opened') {
    for (const it of Array.isArray(record.items) ? record.items : []) {
      if (!it || typeof it !== 'object' || typeof it.uid !== 'string' || it.uid === '') continue;
      const bucket = it.kind === 'skillPlugin' ? 'skillPlugin'
        : it.kind === 'rolePlugin' ? 'rolePlugin'
          : it.kind === 'skill' ? 'skill' : 'role';
      if (!Array.isArray(wh.buckets[bucket])) continue;
      if (findWarehouseItem(wh, it.uid)) continue;
      wh.buckets[bucket].push(deepClone(it));
    }
    return;
  }
  const found = findWarehouseItem(wh, record.targetUid);
  if (!found) return;
  const slot = Array.isArray(found.item.slots) ? found.item.slots[record.slotIndex] : null;
  if (!slot) return;
  const prevPluginUid = slot.pluginUid === undefined ? null : slot.pluginUid;
  slot.pluginUid = record.type === 'warehouse.assemble' ? record.pluginUid : null;
  // 与 applyRecordToArchive 同一口径：`equipped` 必须随装配/拆卸同步（否则检查点重建后
  //   会出现"拆卸后仍 equipped=true"或"装配后 equipped 未置位"的坏状态）
  if (record.type === 'warehouse.disassemble') {
    const prev = prevPluginUid === null ? null : findWarehouseItem(wh, prevPluginUid);
    if (prev && prev.item) prev.item.equipped = false;
  } else {
    const plugin = findWarehouseItem(wh, record.pluginUid);
    if (plugin && plugin.item) plugin.item.equipped = true;
  }
}

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
        warehouse: null, ai: null,
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
      if (record.warehouse) t.warehouse = normalizeWarehouse(record.warehouse);
      if (Array.isArray(record.aiLibrary)) {
        t.ai = record.aiLibrary
          .filter((a) => a && typeof a.aiId === 'string' && a.aiId !== '')
          .map((a) => ({
            aiId: a.aiId,
            name: a.name === undefined || a.name === null ? a.aiId : a.name,
            program: deepClone(a.program),
            createdAt: record.at === undefined ? null : record.at,
            updatedAt: record.at === undefined ? null : record.at,
          }));
      }
      continue;
    }
    if (record.type === 'box.opened' || record.type === 'warehouse.assemble' || record.type === 'warehouse.disassemble') {
      const t = ensure(record.playerId);
      if (!t.warehouse) t.warehouse = emptyWarehouse();
      applyRecordToMaterializedWarehouse(t.warehouse, record);
      t.lastAt = record.at === undefined ? t.lastAt : record.at;
      continue;
    }
    if (record.type === 'ai.created') {
      const t = ensure(record.playerId);
      if (!t.ai) t.ai = [];
      if (!t.ai.some((x) => x && x.aiId === record.aiId)) {
        t.ai.push({
          aiId: record.aiId,
          name: record.name === undefined ? record.aiId : record.name,
          program: deepClone(record.program),
          createdAt: record.at === undefined ? null : record.at,
          updatedAt: record.at === undefined ? null : record.at,
        });
      }
      continue;
    }
    if (record.type === 'ai.deleted') {
      const t = ensure(record.playerId);
      if (!t.ai) t.ai = [];
      t.ai = t.ai.filter((x) => !x || x.aiId !== record.aiId);
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
  NON_COMPACTABLE,
  WAREHOUSE_BUCKETS,
  GRANT_WINDOW,
  PLAYER_ID_RE,
  PUBLIC_ID_RE,
  USERNAME_RE,
  MIGRATIONS,
  applyDefaults,
  applyRecordToArchive,
  applyRecordToMaterializedWarehouse,
  aggregateRecords,
  activeSlot,
  aiMaxPerPlayerOf,
  archiveRelPath,
  assertArchiveInvariants,
  checkSlotDeletable,
  checkSlotLimit,
  emptyIncompleteLoadout,
  emptyWarehouse,
  findAi,
  findWarehouseItem,
  isLoadoutComplete,
  loadoutMissingDetails,
  loadoutMissingOf,
  normalizeWarehouse,
  warehouseCounts,
  warehouseMaxPerBucketOf,
  warehouseUsage,
  warehouseExcerpt,
  allocateGrantUids,
  excerptCoversRefs,
  loadoutRefs,
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
