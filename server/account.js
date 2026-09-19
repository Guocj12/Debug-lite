'use strict';
/* server/account.js —— 玩家档案门面（P7-2 / B29+B30；契约 docs/interfaces.md §1 `server/account.js` + §2 `/me*`）
 *
 * 权威：docs/systems/11-account-store.md §5.2（档案字段全表）/§5.3（配置槽规则 D-131）/§5.4（快照冻结）
 *      /§5.5（段位与积分字段）/§7.5（登录视图与未读）/§10.1（端点总表）；decisions.md D-129/D-130/D-131/D-134
 *
 * 定位：L6 门面——**只做业务规则 + 结果信封**，一切持久化都走注入的 `server/store` 适配器
 *      （A 类单玩家写 = adapter 内部原子写；B 类跨玩家写 = journal + 幂等 apply，D-134）。
 *      本文件**不碰 node:fs**（唯一允许 fs 的目录是 `server/store/*`）。
 *
 * 结果信封（P7-3/P7-4 直接映射 HTTP，参照 `server/box.js` 的 `{status, code, data, message}` 并补 `ok/details`）：
 *   成功：`{ ok:true, status:200, code:null, message:null, data:{…}, details:[] }`
 *   失败：`{ ok:false, status:<HTTP>, code:'<错误码>', message:'…', data:null, details:[{path,code,message}] }`
 *   错误码与状态见 §10.3；`ok`/`fail`/`statusOf` 由本文件导出，auth.js 复用（避免新开第三个文件）。
 *
 * 日志（通道 `store`，事件名取 interfaces.md §6 矩阵既有项，**不新增事件名**）：
 *   `store.write`(debug) 档案业务写入（data.op 标注具体操作）/ `store.read`(trace) 读视图。
 */
const { nullLogger } = require('../shared/log.js');
const { StoreError, STATUS_BY_CODE } = require('./store/errors.js');
const { deepClone, contentHash } = require('./store/canonical.js');
const archiveMod = require('./store/archive.js');
const loadoutMod = require('./loadout.js');

const DEFAULT_SLOT_NAME = '默认配置';                 // §5.3 注册下发槽的展示名
const DEFAULT_TIER_FOR_VALIDATION = 'mythic';         // 与 server/loadout.js 的缺省口径一致（门控关闭时无影响）
const MIRROR_CACHE_MAX = 200;                         // 仓库镜像缓存条数（非权威、不落盘，见 saveWarehouseMirror）
const RECORDS_LIMIT_DEFAULT = 20;
const RECORDS_LIMIT_MAX = 100;                        // record.recent 环形上限同量级（§5.2）
const DEFENSE_LIMIT_DEFAULT = 20;
const DEFENSE_LIMIT_MAX = 100;

/* ---------- 结果信封（§10.3 错误码 → HTTP 状态） ---------- */

// 本层（auth/account）新增码；其余回退 store/errors.js 的 STATUS_BY_CODE
const EXTRA_STATUS = Object.freeze({
  unauthorized: 401,
  session_expired: 401,
  invalid_credentials: 401,
  too_many_attempts: 429,
  rate_limited: 429,
  weak_password: 400,
  username_taken: 409,
  forbidden: 403,
  banned: 403,
  warehouse_invalid: 400,
  warehouse_missing: 404,
  default_loadout_invalid: 500,
});

function statusOf(code) {
  if (Object.prototype.hasOwnProperty.call(EXTRA_STATUS, code)) return EXTRA_STATUS[code];
  if (Object.prototype.hasOwnProperty.call(STATUS_BY_CODE, code)) return STATUS_BY_CODE[code];
  return 500;
}

function detailOf(code, message, path) {
  return { path: path === undefined ? '' : path, code, message: message === undefined ? code : message };
}

function ok(data) {
  return { ok: true, status: 200, code: null, message: null, data: data === undefined ? null : data, details: [] };
}

function fail(code, message, details) {
  return {
    ok: false,
    status: statusOf(code),
    code,
    message: message === undefined ? code : String(message),
    data: null,
    details: Array.isArray(details) ? details : [],
  };
}

// 异常 → 信封：StoreError 原样映射（code/status/details）；其余记 store.error 并按内部错误返回
function toFailure(err, log, op) {
  if (err && err.name === 'StoreError') {
    return fail(err.code, err.message, Array.isArray(err.details) ? err.details : []);
  }
  if (log) {
    log.error('store', 'store.error', `account.${op} 内部异常：${err && err.message ? err.message : String(err)}`, {
      op, code: (err && err.code) || null,
    });
  }
  return fail('store_internal', `内部错误（${op}）`);
}

/* ---------- 纯校验/视图工具 ---------- */

// 默认出战配置 = `ranked.buildBotLoadout()` 的构造（§5.3：role_bal + 3 个 common 技能 + 兜底 AI）
// 惰性 require：避免 server/account.js 在被 require 时即拉起引擎（P7-4 可先装配 store 再触发）
function defaultLoadout() {
  const ranked = require('./ranked.js');
  return deepClone(ranked.buildBotLoadout());
}

// 校验 loadout（I-12 全案 + 引用完整性 + 门控）：统一把 loadout.js 的 {where,code,message} 映射成 details
function validateLoadoutOf(loadout, options) {
  const o = options || {};
  const tier = o.tier === undefined || o.tier === null ? DEFAULT_TIER_FOR_VALIDATION : o.tier;
  const warehouse = o.warehouse === undefined ? null : o.warehouse;
  const res = loadoutMod.validateLoadout(loadout, { warehouse, tier });
  const errors = (res.errors || []).map((e) => detailOf(e.code, e.message, e.where));
  return { ok: res.ok === true, errors, warehouseVerified: res.ok === true && warehouse !== null };
}

// 仓库镜像形状校验（D-130：镜像非权威，只用于引用校验；不要求装配状态完整）
function validateWarehouseMirror(warehouse) {
  if (!warehouse || typeof warehouse !== 'object' || Array.isArray(warehouse)) {
    return { ok: false, details: [detailOf('bad_request', 'warehouse 必须是对象（{buckets:{…}}）', 'warehouse')] };
  }
  const buckets = warehouse.buckets;
  if (!buckets || typeof buckets !== 'object' || Array.isArray(buckets)) {
    return { ok: false, details: [detailOf('bad_request', 'warehouse.buckets 必须是对象', 'warehouse.buckets')] };
  }
  for (const key of Object.keys(buckets)) {
    if (!Array.isArray(buckets[key])) {
      return { ok: false, details: [detailOf('bad_request', `warehouse.buckets.${key} 必须是数组`, `warehouse.buckets.${key}`)] };
    }
  }
  return { ok: true, details: [] };
}

function bucketCounts(warehouse) {
  const out = {};
  for (const key of Object.keys((warehouse && warehouse.buckets) || {})) {
    out[key] = warehouse.buckets[key].filter((it) => it && typeof it === 'object').length;
  }
  return out;
}

function slotBrief(slot) {
  return {
    slotId: slot.slotId,
    name: slot.name,
    isDefault: !!slot.isDefault,
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
    snapshotHash: slot.snapshot ? slot.snapshot.hash : null,
  };
}

// 配置全文视图（GET /me/configs §10.1：3 套配置全文）
function configView(slot) {
  return {
    slotId: slot.slotId,
    name: slot.name,
    isDefault: !!slot.isDefault,
    createdAt: slot.createdAt,
    updatedAt: slot.updatedAt,
    loadout: deepClone(slot.loadout),
    snapshot: slot.snapshot === null || slot.snapshot === undefined ? null : {
      hash: slot.snapshot.hash,
      configHash: slot.snapshot.configHash === undefined ? null : slot.snapshot.configHash,
      engineVersion: slot.snapshot.engineVersion === undefined ? null : slot.snapshot.engineVersion,
      dataVersion: slot.snapshot.dataVersion === undefined ? null : slot.snapshot.dataVersion,
      frozenAt: slot.snapshot.frozenAt === undefined ? null : slot.snapshot.frozenAt,
      verifiedAgainstWarehouse: !!slot.snapshot.verifiedAgainstWarehouse,
    },
  };
}

// 快照视图（冻结回执；不含 loadout 正文——配置全文已在 slot.loadout 里，避免响应翻倍）
function snapshotView(snapshot) {
  if (!snapshot) return null;
  return {
    hash: snapshot.hash,
    configHash: snapshot.configHash === undefined ? null : snapshot.configHash,
    engineVersion: snapshot.engineVersion === undefined ? null : snapshot.engineVersion,
    dataVersion: snapshot.dataVersion === undefined ? null : snapshot.dataVersion,
    frozenAt: snapshot.frozenAt === undefined ? null : snapshot.frozenAt,
  };
}

function maxSlotsOf(store) {
  return archiveMod.maxSlotsOf(store.config || {});
}

/* ---------- 门面工厂 ---------- */

/**
 * createAccount({ store, logger?, now?, buildDefaultLoadout? })
 *   store 必填（server/store 适配器，已 open）；其余为测试接缝。
 * 返回对象的方法全部 async，一律返回上面的结果信封（不抛异常）。
 */
function createAccount(options) {
  const opts = options || {};
  const store = opts.store;
  if (!store || typeof store.loadArchive !== 'function' || typeof store.updateArchive !== 'function') {
    throw new TypeError('createAccount 需要已装配的 store 适配器（server/store/index.js createStore/openStore）');
  }
  const log = opts.logger || nullLogger;
  const nowFn = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const versions = store.versions;
  const buildDefaultLoadout = typeof opts.buildDefaultLoadout === 'function' ? opts.buildDefaultLoadout : defaultLoadout;
  const mirrors = new Map(); // playerId → {warehouse, hash, savedAt}（非权威缓存：重启即失效，见 saveWarehouseMirror）

  function logWrite(op, data) {
    log.debug('store', 'store.write', `account.${op}`, Object.assign({ op }, data || {}));
  }

  // 读档案（缺失/参数非法 → StoreError，由各方法的 try/catch 统一转成信封）
  async function requireArchive(playerId) {
    if (typeof playerId !== 'string' || playerId === '') {
      throw new StoreError('bad_request', '需要 playerId', [detailOf('bad_request', 'playerId 必须是非空字符串', 'playerId')]);
    }
    const archive = await store.loadArchive(playerId);
    if (!archive) throw new StoreError('store_not_found', `档案 ${playerId} 不存在`);
    return archive;
  }

  function tierFor(archive, input) {
    if (input && input.tier !== undefined && input.tier !== null) return input.tier;
    return (archive && archive.progress && archive.progress.tier) || DEFAULT_TIER_FOR_VALIDATION;
  }

  function mirrorSet(playerId, value) {
    mirrors.delete(playerId);
    mirrors.set(playerId, value);
    while (mirrors.size > MIRROR_CACHE_MAX) mirrors.delete(mirrors.keys().next().value);
  }

  /* ---------- 注册事务（§5.3：注册即默认配置 + 必有出战） ---------- */

  // 冻结默认快照 → journal `account.created`（含 slot）→ apply 档案。auth.register 调用本方法。
  async function createPlayerArchive(input) {
    const o = input || {};
    try {
      const loadout = o.loadout === undefined || o.loadout === null ? buildDefaultLoadout() : o.loadout;
      const v = validateLoadoutOf(loadout, { warehouse: o.warehouse, tier: o.tier });
      if (!v.ok) return fail('loadout_invalid', '默认出战配置不合法（服务端构造异常）', v.errors);
      const snapshot = store.freezeSnapshot(loadout, versions);
      if (!snapshot || !snapshot.hash) return fail('default_loadout_invalid', '默认出战配置冻结失败');
      const slotId = archiveMod.slotIdOf(store.config || {}, 1);
      const archive = await store.createAccount({
        playerId: o.playerId,
        publicId: o.publicId,
        nickname: o.nickname,
        auth: o.auth,
        at: Number.isInteger(o.at) ? o.at : nowFn(),
        tier: o.tier,
        points: o.points,
        flags: o.flags,
        isBot: o.isBot,
        slot: {
          slotId,
          name: o.slotName === undefined ? DEFAULT_SLOT_NAME : o.slotName,
          snapshotHash: snapshot.hash,
          configHash: snapshot.configHash,
          versions,
          warehouseVerified: v.warehouseVerified,
        },
      });
      if (!archive) return fail('store_write_failed', '注册档案落盘失败');
      const active = archiveMod.activeSlot(archive);
      logWrite('createPlayerArchive', { playerId: archive.playerId, slotId: active ? active.slotId : null, snapshotHash: snapshot.hash });
      return ok({
        archive,
        snapshot: snapshotView(snapshot),
        slot: active ? configView(active) : null,
        playerId: archive.playerId,
        publicId: archive.publicId,
        nickname: archive.nickname,
        tier: archive.progress.tier,
        points: archive.rating.points,
        activeSlotId: archive.configs.activeSlotId,
      });
    } catch (err) {
      return toFailure(err, log, 'createPlayerArchive');
    }
  }

  /* ---------- 视图 ---------- */

  // GET /me：段位/积分/未读/槽位列表（§10.2）
  async function getSummary(playerId) {
    try {
      const archive = await requireArchive(playerId);
      log.trace('store', 'store.read', 'account.getSummary', { playerId });
      return ok(archiveMod.summaryOf(archive));
    } catch (err) {
      return toFailure(err, log, 'getSummary');
    }
  }

  // GET /me/configs：3 套配置全文 + 出战标记 + 槽位上限
  async function listConfigs(playerId) {
    try {
      const archive = await requireArchive(playerId);
      log.trace('store', 'store.read', 'account.listConfigs', { playerId });
      return ok({
        slots: archive.configs.slots.map(configView),
        activeSlotId: archive.configs.activeSlotId,
        activeSnapshotHash: archive.configs.activeSnapshotHash,
        maxSlots: maxSlotsOf(store),
        unverifiedLoadout: !!archive.flags.unverifiedLoadout,
      });
    } catch (err) {
      return toFailure(err, log, 'listConfigs');
    }
  }

  /* ---------- 配置槽（§5.3 / D-131） ---------- */

  // POST /me/configs：新建槽（默认复制出战配置；默认**不切换出战**——切换是 activate 的职责）
  async function createSlot(input) {
    const o = input || {};
    try {
      const archive = await requireArchive(o.playerId);
      let source = null;
      let warehouseVerified = false;
      if (o.loadout !== undefined && o.loadout !== null) {
        const v = validateLoadoutOf(o.loadout, { warehouse: o.warehouse, tier: tierFor(archive, o) });
        if (!v.ok) return fail('loadout_invalid', '出战配置不合法', v.errors);
        source = o.loadout;
        warehouseVerified = v.warehouseVerified;
      } else {
        const active = archiveMod.activeSlot(archive);
        if (!active) return fail('no_active_config', '没有可复制的出战配置（不变量破损）');
        source = active.loadout;
        if (o.warehouse !== undefined && o.warehouse !== null) {
          const v = validateLoadoutOf(source, { warehouse: o.warehouse, tier: tierFor(archive, o) });
          if (!v.ok) return fail('loadout_invalid', '复制的出战配置与仓库镜像不一致', v.errors);
          warehouseVerified = v.warehouseVerified;
        }
      }
      const res = await store.createConfigSlot({
        playerId: o.playerId,
        loadout: source,
        name: o.name,
        activate: o.activate === true,
        versions,
        warehouseVerified,
      });
      logWrite('createSlot', { playerId: o.playerId, slotId: res.slot.slotId });
      return ok({
        slotId: res.slot.slotId,
        slot: configView(res.slot),
        slots: res.archive.configs.slots.map(slotBrief),
        activeSlotId: res.archive.configs.activeSlotId,
        snapshot: snapshotView(res.snapshot),
      });
    } catch (err) {
      return toFailure(err, log, 'createSlot');
    }
  }

  // PUT /me/configs/:slotId：校验 → 冻结快照 → 落盘（乐观锁 baseUpdatedAt 冲突 → config_conflict）
  async function saveConfig(input) {
    const o = input || {};
    try {
      if (!o.loadout || typeof o.loadout !== 'object' || Array.isArray(o.loadout)) {
        return fail('bad_request', '缺少 loadout（必须提供完整出战配置）', [detailOf('bad_request', 'loadout 必须是对象', 'loadout')]);
      }
      const archive = await requireArchive(o.playerId);
      const slot = archiveMod.findSlot(archive, o.slotId);
      if (!slot) return fail('slot_not_found', `槽 ${o.slotId} 不存在`);
      const v = validateLoadoutOf(o.loadout, { warehouse: o.warehouse, tier: tierFor(archive, o) });
      if (!v.ok) return fail('loadout_invalid', '出战配置不合法', v.errors);
      const res = await store.saveConfigSlot({
        playerId: o.playerId,
        slotId: slot.slotId,
        loadout: o.loadout,
        name: o.name,
        baseUpdatedAt: o.baseUpdatedAt,
        activate: o.activate === true,
        versions,
        warehouseVerified: v.warehouseVerified,
      });
      logWrite('saveConfig', { playerId: o.playerId, slotId: slot.slotId, snapshotHash: res.snapshot.hash });
      return ok({
        slotId: res.slot.slotId,
        slot: configView(res.slot),
        slotUpdatedAt: res.slot.updatedAt,
        slots: res.archive.configs.slots.map(slotBrief),
        activeSlotId: res.archive.configs.activeSlotId,
        activeSnapshotHash: res.archive.configs.activeSnapshotHash,
        snapshot: snapshotView(res.snapshot),
        unverifiedLoadout: !!res.archive.flags.unverifiedLoadout,
      });
    } catch (err) {
      return toFailure(err, log, 'saveConfig');
    }
  }

  // POST /me/configs/:slotId/activate：唯一出战（同步 activeSnapshotHash）
  async function activateConfig(input) {
    const o = input || {};
    try {
      const archive = await requireArchive(o.playerId);
      if (!archiveMod.findSlot(archive, o.slotId)) return fail('slot_not_found', `槽 ${o.slotId} 不存在`);
      const res = await store.activateConfigSlot({ playerId: o.playerId, slotId: o.slotId });
      logWrite('activateConfig', { playerId: o.playerId, slotId: o.slotId, snapshotHash: res.archive.configs.activeSnapshotHash });
      return ok({
        activeSlotId: res.archive.configs.activeSlotId,
        activeSnapshotHash: res.archive.configs.activeSnapshotHash,
        slot: configView(res.slot),
        slots: res.archive.configs.slots.map(slotBrief),
      });
    } catch (err) {
      return toFailure(err, log, 'activateConfig');
    }
  }

  // DELETE /me/configs/:slotId：默认槽 / 出战槽 → slot_locked（§5.3）
  async function deleteSlot(input) {
    const o = input || {};
    try {
      const archive = await requireArchive(o.playerId);
      const res = await store.deleteConfigSlot({ playerId: o.playerId, slotId: o.slotId });
      logWrite('deleteSlot', { playerId: o.playerId, slotId: o.slotId });
      return ok({
        deleted: o.slotId,
        slots: res.archive.configs.slots.map(slotBrief),
        activeSlotId: res.archive.configs.activeSlotId,
        activeSnapshotHash: res.archive.configs.activeSnapshotHash,
      });
    } catch (err) {
      return toFailure(err, log, 'deleteSlot');
    }
  }

  /* ---------- 仓库镜像（D-130：客户端权威，服务端只做引用校验） ---------- */

  // PUT /me/warehouse：形状校验 + 用镜像复查当前出战配置的引用完整性
  // 持久化副作用：仅在引用校验通过时清除 flags.unverifiedLoadout（§5.2）。
  // 镜像正文**不落盘**（D-130：仓库不在服务端账本内）——只保留进程内缓存供 GET /me/warehouse 回读。
  async function saveWarehouseMirror(input) {
    const o = input || {};
    try {
      const archive = await requireArchive(o.playerId);
      const shape = validateWarehouseMirror(o.warehouse);
      if (!shape.ok) return fail('bad_request', '仓库镜像结构非法', shape.details);
      const active = archiveMod.activeSlot(archive);
      let verified = false;
      if (active && active.loadout) {
        const v = validateLoadoutOf(active.loadout, { warehouse: o.warehouse, tier: tierFor(archive, o) });
        if (!v.ok) return fail('loadout_invalid', '仓库镜像与当前出战配置不一致（引用校验失败）', v.errors);
        verified = true;
      }
      const hash = contentHash(o.warehouse);
      mirrorSet(o.playerId, { warehouse: deepClone(o.warehouse), hash, savedAt: nowFn() });
      let applied = false;
      if (verified && archive.flags.unverifiedLoadout !== false) {
        await store.updateArchive(o.playerId, (a) => {
          a.flags.unverifiedLoadout = false;
          return null;
        });
        applied = true;
      }
      logWrite('saveWarehouseMirror', { playerId: o.playerId, verified, warehouseHash: hash });
      return ok({
        saved: true,
        verified,
        warehouseHash: hash,
        unverifiedLoadout: !verified,
        applied,
        buckets: bucketCounts(o.warehouse),
        warehouse: deepClone(o.warehouse),
      });
    } catch (err) {
      return toFailure(err, log, 'saveWarehouseMirror');
    }
  }

  // GET /me/warehouse：回读最近一次提交的镜像（进程内缓存；重启后为空 → warehouse_missing）
  async function getWarehouseMirror(playerId) {
    try {
      const archive = await requireArchive(playerId);
      const entry = mirrors.get(playerId);
      if (!entry) {
        return fail('warehouse_missing', '本进程内没有该玩家的仓库镜像（仓库由客户端权威持有，D-130）');
      }
      return ok({
        warehouse: deepClone(entry.warehouse),
        warehouseHash: entry.hash,
        savedAt: entry.savedAt,
        unverifiedLoadout: !!archive.flags.unverifiedLoadout,
        buckets: bucketCounts(entry.warehouse),
      });
    } catch (err) {
      return toFailure(err, log, 'getWarehouseMirror');
    }
  }

  /* ---------- 战绩 / 未读 / 防守战绩（§7.5 / B30） ---------- */

  function normalizeRecordsQuery(input) {
    const o = input || {};
    const out = { since: undefined, limit: RECORDS_LIMIT_DEFAULT, role: null };
    if (o.since !== undefined && o.since !== null) {
      if (!Number.isInteger(o.since) || o.since < 0) {
        return { ok: false, details: [detailOf('bad_request', 'since 必须是非负整数（journal seq）', 'since')] };
      }
      out.since = o.since;
    }
    if (o.limit !== undefined && o.limit !== null) {
      if (!Number.isInteger(o.limit) || o.limit < 1 || o.limit > RECORDS_LIMIT_MAX) {
        return { ok: false, details: [detailOf('bad_request', `limit 必须是 1..${RECORDS_LIMIT_MAX} 的整数`, 'limit')] };
      }
      out.limit = o.limit;
    }
    if (o.role !== undefined && o.role !== null && o.role !== '') {
      if (o.role !== 'attack' && o.role !== 'defense') {
        return { ok: false, details: [detailOf('bad_request', "role 只能是 'attack' | 'defense'", 'role')] };
      }
      out.role = o.role;
    }
    return { ok: true, query: out };
  }

  // GET /me/records?since=&limit=&role=：seq 增量游标（since 缺省 = 档案未读游标）
  async function records(input) {
    const o = input || {};
    try {
      const norm = normalizeRecordsQuery(o);
      if (!norm.ok) return fail('bad_request', '战绩查询参数非法', norm.details);
      const archive = await requireArchive(o.playerId);
      const list = await store.records(o.playerId, norm.query);
      const unread = archiveMod.unreadOf(archive);
      const base = norm.query.since === undefined ? unread.fromSeq : norm.query.since;
      let nextSince = base;
      for (const entry of list) {
        if (Number.isInteger(entry.seq) && entry.seq > nextSince) nextSince = entry.seq;
      }
      log.trace('store', 'store.read', 'account.records', { playerId: o.playerId, count: list.length });
      return ok({
        records: list,
        since: base,
        nextSince,
        limit: norm.query.limit,
        role: norm.query.role,
        unread,
        maxSeq: store.maxSeq(),
      });
    } catch (err) {
      return toFailure(err, log, 'records');
    }
  }

  // POST /me/records/seen { uptoSeq }：推进未读游标（A 类写，不入 journal）
  async function markSeen(input) {
    const o = input || {};
    try {
      if (!Number.isInteger(o.uptoSeq) || o.uptoSeq < 0) {
        return fail('bad_request', 'uptoSeq 必须是非负整数（journal seq）', [detailOf('bad_request', '非法 uptoSeq', 'uptoSeq')]);
      }
      const archive = await requireArchive(o.playerId);
      const updated = await store.markRecordsSeen({ playerId: o.playerId, uptoSeq: o.uptoSeq });
      logWrite('markSeen', { playerId: o.playerId, uptoSeq: o.uptoSeq });
      return ok({ uptoSeq: o.uptoSeq, unread: archiveMod.unreadOf(updated), maxSeq: store.maxSeq() });
    } catch (err) {
      return toFailure(err, log, 'markSeen');
    }
  }

  // GET /me/defense：防守战绩汇总（被抽场次 / 胜负 / 最近列表 / 未读）
  async function defenseSummary(input) {
    const o = input || {};
    try {
      const limit = o.limit === undefined || o.limit === null ? DEFENSE_LIMIT_DEFAULT : o.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > DEFENSE_LIMIT_MAX) {
        return fail('bad_request', `limit 必须是 1..${DEFENSE_LIMIT_MAX} 的整数`, [detailOf('bad_request', '非法 limit', 'limit')]);
      }
      const archive = await requireArchive(o.playerId);
      const data = await store.defenseSummary(o.playerId, { limit });
      log.trace('store', 'store.read', 'account.defenseSummary', { playerId: o.playerId });
      return ok(data);
    } catch (err) {
      return toFailure(err, log, 'defenseSummary');
    }
  }

  /* ---------- 昵称（PUT /me/nickname，B29 附带项） ---------- */

  async function setNickname(input) {
    const o = input || {};
    try {
      if (!archiveMod.isValidNickname(o.nickname)) {
        return fail('bad_request', '昵称需 1~16 字符', [detailOf('bad_request', '非法昵称', 'nickname')]);
      }
      const archive = await requireArchive(o.playerId);
      const updated = await store.setNickname({ playerId: o.playerId, nickname: o.nickname });
      logWrite('setNickname', { playerId: o.playerId });
      return ok({ nickname: updated.nickname, publicId: updated.publicId });
    } catch (err) {
      return toFailure(err, log, 'setNickname');
    }
  }

  return {
    store,
    versions,
    // 注册事务
    createPlayerArchive,
    // 视图
    getSummary,
    listConfigs,
    // 配置槽
    createSlot,
    saveConfig,
    activateConfig,
    deleteSlot,
    // 仓库镜像
    saveWarehouseMirror,
    getWarehouseMirror,
    // 战绩
    records,
    markSeen,
    defenseSummary,
    // 昵称
    setNickname,
    // 测试/诊断
    defaultLoadout: () => buildDefaultLoadout(),
    mirrorCacheSize: () => mirrors.size,
  };
}

module.exports = {
  createAccount,
  defaultLoadout,
  validateLoadoutOf,
  validateWarehouseMirror,
  // 信封工具（auth.js 复用；P7-4 也可用来统一错误响应）
  ok,
  fail,
  statusOf,
  detailOf,
  toFailure,
  // 常量（P7-4/测试可读）
  DEFAULT_SLOT_NAME,
  RECORDS_LIMIT_DEFAULT,
  RECORDS_LIMIT_MAX,
  DEFENSE_LIMIT_DEFAULT,
  DEFENSE_LIMIT_MAX,
  MIRROR_CACHE_MAX,
};
