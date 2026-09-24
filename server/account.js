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
const starterMod = require('./starter.js');
const itemsMod = require('./core/items.js');

const DEFAULT_SLOT_NAME = '默认配置';                 // §5.3 注册下发槽的展示名
const AI_NAME_MAX = 24;                               // AI 库条目名长度上限（本地校验常量，同 RECORDS_LIMIT_MAX 口径）
const DEFAULT_TIER_FOR_VALIDATION = 'mythic';         // 与 server/loadout.js 的缺省口径一致（门控关闭时无影响）
const MIRROR_CACHE_MAX = 200;                         // 仓库镜像缓存条数（非权威、不落盘，见 saveWarehouseMirror）
const RECORDS_LIMIT_DEFAULT = 20;
const RECORDS_LIMIT_MAX = 100;                        // record.recent 环形上限同量级（§5.2）
const DEFENSE_LIMIT_DEFAULT = 20;
const DEFENSE_LIMIT_MAX = 100;

/* ---------- 结果信封（§10.3 错误码 → HTTP 状态） ---------- */

// 本层（auth/account）新增码；其余回退 store/errors.js 的 STATUS_BY_CODE
// 说明：§10.3 的 `rate_limited`（全局限速 600 次/分/token）与 `forbidden` 的中间件判定属 P7-4（HTTP 层），
// 本层只保留自己会返回的码（避免"登记了却从不产生"的死码）。
const EXTRA_STATUS = Object.freeze({
  unauthorized: 401,
  session_expired: 401,
  invalid_credentials: 401,
  too_many_attempts: 429,
  weak_password: 400,
  username_taken: 409,
  forbidden: 403,
  banned: 403,
  warehouse_missing: 404,
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
// B31（P7-3）把该构造改名 `buildDefaultLoadout` 并保留 `buildBotLoadout` 别名——两者取其一，保持兼容
function defaultLoadout() {
  const ranked = require('./ranked.js');
  const build = typeof ranked.buildDefaultLoadout === 'function' ? ranked.buildDefaultLoadout : ranked.buildBotLoadout;
  return deepClone(build());
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

// 昵称上界：config.auth.nicknameMax，但档案层不变量恒为 ≤16（archive.isValidNickname，§4.2/§5.2）
const ARCHIVE_NICKNAME_MAX = 16;

function nicknameMaxOf(store) {
  const raw = store && store.config && store.config.auth ? store.config.auth.nicknameMax : undefined;
  return Math.min(Number.isInteger(raw) && raw > 0 ? raw : ARCHIVE_NICKNAME_MAX, ARCHIVE_NICKNAME_MAX);
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

  // D-159：仓库为服务端权威 → 出战配置的引用校验**优先用服务端真源**（客户端不再需要提交镜像）。
  //   显式传入的 warehouse（遗留路径 / 测试缝）仍然被接受并优先使用。
  async function warehouseForValidation(playerId, provided) {
    if (provided !== undefined && provided !== null) return provided;
    try {
      const view = await store.getWarehouse(playerId);
      return view && view.warehouse ? view.warehouse : null;
    } catch (err) {
      log.warn('store', 'store.read',
        `读取服务端仓库失败（引用校验降级为无仓库）：${err && err.message ? err.message : err}`,
        { op: 'warehouseForValidation', playerId });
      return null;
    }
  }

  /* ---------- 注册事务（§5.3：注册即默认配置 + 必有出战） ---------- */

  // 冻结默认快照 → journal `account.created`（含 starter 仓库 + 三个槽）→ apply 档案。auth.register 调用本方法。
  // D-159（用户 2026-09-22 拍板）：注册即发 starter（服务端权威仓库 + 已装配配置写进 slot1），
  //   并**建满 3 个槽**（slot1 完整出战；slot2/slot3 空槽，无快照 —— D-160 非出战槽允许不完整）。
  //   显式传入 loadout（如管理端 bot 注入）时**不发放 starter**，退回旧的单槽路径。
  async function createPlayerArchive(input) {
    const o = input || {};
    try {
      const explicit = o.loadout !== undefined && o.loadout !== null;
      const useStarter = !explicit && o.isBot !== true;
      let starter = null;
      let loadout;
      if (useStarter) {
        starter = starterMod.buildStarter({ publicId: o.publicId, playerId: o.playerId, logger: log });
        if (!starter || !starter.ok) return fail('store_internal', '新手套装生成失败（starter 不可用）');
        loadout = starter.loadout;
      } else {
        loadout = explicit ? o.loadout : buildDefaultLoadout();
      }
      const warehouse = starter ? starter.warehouse : o.warehouse;
      const v = validateLoadoutOf(loadout, { warehouse, tier: o.tier });
      if (!v.ok) return fail('loadout_invalid', '默认出战配置不合法（服务端构造异常）', v.errors);
      // 缺口 1：带 warehouse 校验通过时，把该镜像中**本配置引用到的插件项**随快照一起冻结
      const snapshot = store.freezeSnapshot(loadout, versions, { warehouse });
      if (!snapshot || !snapshot.hash) return fail('store_internal', '默认出战配置冻结失败（快照库不可用）');
      const slotId = archiveMod.slotIdOf(store.config || {}, 1);
      const slotSpec = {
        slotId,
        name: o.slotName === undefined ? DEFAULT_SLOT_NAME : o.slotName,
        snapshotHash: snapshot.hash,
        configHash: snapshot.configHash,
        versions,
        warehouseVerified: v.warehouseVerified,
      };
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
        slot: starter ? undefined : slotSpec,
        // D-159/D-160：starter 路径建满 3 槽（空槽只带 loadout 正文，不带快照）
        slots: starter ? [
          slotSpec,
          { slotId: archiveMod.slotIdOf(store.config || {}, 2), name: '配置2', loadout: archiveMod.emptyIncompleteLoadout() },
          { slotId: archiveMod.slotIdOf(store.config || {}, 3), name: '配置3', loadout: archiveMod.emptyIncompleteLoadout() },
        ] : undefined,
        warehouse: starter ? starter.warehouse : undefined,
        aiLibrary: starter ? starter.aiLibrary : undefined,
      });
      if (!archive) return fail('store_write_failed', '注册档案落盘失败');
      const active = archiveMod.activeSlot(archive);
      logWrite('createPlayerArchive', {
        playerId: archive.playerId, slotId: active ? active.slotId : null, snapshotHash: snapshot.hash,
        starter: !!starter, starterSeed: starter ? starter.seed : null,
      });
      return ok({
        archive,
        snapshot: snapshotView(snapshot),
        slot: active ? configView(active) : null,
        slots: archive.configs.slots.map(slotBrief),
        playerId: archive.playerId,
        publicId: archive.publicId,
        nickname: archive.nickname,
        tier: archive.progress.tier,
        points: archive.rating.points,
        activeSlotId: archive.configs.activeSlotId,
        starter: starter ? {
          issued: true,
          seed: starter.seed,
          counts: starter.stats.counts,
          roleSlotCount: starter.stats.roleSlotCount,
          plugins: starter.stats.plugins.map((p) => ({ id: p.id, targetUid: p.targetUid, slotIndex: p.slotIndex })),
          aiId: starter.stats.aiId,
        } : { issued: false },
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

  // POST /me/configs：新建槽（**D-160 起默认建空槽**，不再复制出战配置；出战仍由 activate 决定）
  async function createSlot(input) {
    const o = input || {};
    try {
      const archive = await requireArchive(o.playerId);
      let loadout = null;
      let warehouseVerified = false;
      if (o.loadout !== undefined && o.loadout !== null) {
        const missing = archiveMod.loadoutMissingOf(o.loadout);
        if (missing.length > 0) {
          return fail('loadout_invalid', '新槽可留空（不传 loadout 即建空槽）；要写入的内容必须完整',
            archiveMod.loadoutMissingDetails(missing));
        }
        const v = validateLoadoutOf(o.loadout, {
          warehouse: await warehouseForValidation(o.playerId, o.warehouse), tier: tierFor(archive, o),
        });
        if (!v.ok) return fail('loadout_invalid', '出战配置不合法', v.errors);
        loadout = o.loadout;
        warehouseVerified = v.warehouseVerified;
      }
      const res = await store.createConfigSlot({
        playerId: o.playerId,
        loadout: loadout === null ? undefined : loadout,
        name: o.name,
        activate: false,
        versions,
        warehouseVerified,
        warehouse: o.warehouse, // 缺口 1：随快照冻结本配置引用到的插件项
      });
      logWrite('createSlot', { playerId: o.playerId, slotId: res.slot.slotId, empty: res.snapshot === null });
      return ok({
        slotId: res.slot.slotId,
        slot: configView(res.slot),
        slots: res.archive.configs.slots.map(slotBrief),
        activeSlotId: res.archive.configs.activeSlotId,
        snapshot: res.snapshot ? snapshotView(res.snapshot) : null,
      });
    } catch (err) {
      return toFailure(err, log, 'createSlot');
    }
  }

  // PUT /me/configs/:slotId：校验 → 冻结快照 → 落盘（乐观锁 baseUpdatedAt 冲突 → config_conflict）
  // D-160：**非出战槽允许不完整**（角色/技能/AI 可缺，插槽可空）——此时不冻结快照、loadout 正文随记录落盘；
  //   出战槽仍要求完整（不完整 → loadout_invalid + 逐位置 details）。
  async function saveConfig(input) {
    const o = input || {};
    try {
      if (!o.loadout || typeof o.loadout !== 'object' || Array.isArray(o.loadout)) {
        return fail('bad_request', '缺少 loadout（必须是对象 {role, skills[3], ai}）', [detailOf('bad_request', 'loadout 必须是对象', 'loadout')]);
      }
      const archive = await requireArchive(o.playerId);
      const slot = archiveMod.findSlot(archive, o.slotId);
      if (!slot) return fail('slot_not_found', `槽 ${o.slotId} 不存在`);
      const isActive = archive.configs.activeSlotId === slot.slotId;
      const missing = archiveMod.loadoutMissingOf(o.loadout);
      let warehouseVerified = false;
      if (missing.length > 0) {
        if (isActive) {
          return fail('loadout_invalid', '出战配置必须完整（角色 + 恰 3 技能 + AI；允许插槽为空）',
            archiveMod.loadoutMissingDetails(missing));
        }
      } else {
        const v = validateLoadoutOf(o.loadout, {
          warehouse: await warehouseForValidation(o.playerId, o.warehouse), tier: tierFor(archive, o),
        });
        if (!v.ok) return fail('loadout_invalid', '出战配置不合法', v.errors);
        warehouseVerified = v.warehouseVerified;
      }
      const res = await store.saveConfigSlot({
        playerId: o.playerId,
        slotId: slot.slotId,
        loadout: o.loadout,
        name: o.name,
        baseUpdatedAt: o.baseUpdatedAt,
        activate: o.activate === true,
        versions,
        warehouseVerified,
        warehouse: o.warehouse, // 缺口 1：随快照冻结本配置引用到的插件项（重启/淘汰后不再依赖进程内镜像）
      });
      logWrite('saveConfig', {
        playerId: o.playerId, slotId: slot.slotId,
        snapshotHash: res.snapshot ? res.snapshot.hash : null, incomplete: missing.length > 0,
      });
      return ok({
        slotId: res.slot.slotId,
        slot: configView(res.slot),
        slotUpdatedAt: res.slot.updatedAt,
        slots: res.archive.configs.slots.map(slotBrief),
        activeSlotId: res.archive.configs.activeSlotId,
        activeSnapshotHash: res.archive.configs.activeSnapshotHash,
        snapshot: res.snapshot ? snapshotView(res.snapshot) : null,
        complete: missing.length === 0,
        missing,
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
      // 先校验 playerId 与档案存在；默认槽/出战槽/不存在由 store 的写队列内判定
      await requireArchive(o.playerId);
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

  /* ---------- D-159：服务端权威仓库（真源读取 + 装配/拆卸） ---------- */

  // GET /me/warehouse：**真源**（四桶 + usage「装配于配置几」+ caps + counts）
  async function getWarehouse(playerId) {
    try {
      const view = await store.getWarehouse(playerId);
      log.trace('store', 'store.read', 'account.getWarehouse', { playerId });
      return ok({
        buckets: view.warehouse.buckets,
        usage: view.usage,
        caps: view.caps,
        counts: view.counts,
        starterIssued: view.starterIssued,
      });
    } catch (err) {
      return toFailure(err, log, 'getWarehouse');
    }
  }

  // 装配拒绝码 → 玩家可读文案（服务端原文进 details 供诊断；前端仍应做类型预过滤，R-5）
  function pluginRejectMessageOf(res) {
    const map = {
      slot_type_mismatch: '插件类型与插槽不匹配（只能装同类型插件）',
      slot_occupied: '该插槽已装配插件，请先拆卸',
      points_exceeded: '角色插件点数不足',
      plugin_equipped: '该插件已装配在其他位置',
      item_missing: '目标物品或插件不在仓库中',
      tier_locked: '物品解锁段位高于当前段位',
    };
    return map[res.code] || res.message || res.code;
  }

  // POST /me/warehouse/assemble：core/items 纯函数校验（单点真源）→ 落增量记录（journal 可重演）
  async function assemblePlugin(input) {
    const o = input || {};
    try {
      const archive = await requireArchive(o.playerId);
      const view = await store.getWarehouse(o.playerId);
      const res = itemsMod.assemble(view.warehouse, {
        targetUid: o.targetUid, pluginUid: o.pluginUid, slotIndex: o.slotIndex, tier: tierFor(archive, o),
      });
      if (!res.ok) {
        return fail(res.code, pluginRejectMessageOf(res), [
          { path: 'slotIndex', code: res.code, message: res.message || res.code },
        ]);
      }
      const applied = await store.applyWarehouseChange({
        playerId: o.playerId, op: 'assemble',
        targetUid: o.targetUid, slotIndex: o.slotIndex, pluginUid: o.pluginUid,
      });
      logWrite('assemblePlugin', {
        playerId: o.playerId, targetUid: o.targetUid, pluginUid: o.pluginUid, slotIndex: o.slotIndex,
      });
      return ok({
        warehouse: applied.warehouse, usage: applied.usage, counts: applied.counts, caps: applied.caps,
      });
    } catch (err) {
      return toFailure(err, log, 'assemblePlugin');
    }
  }

  // POST /me/warehouse/disassemble：空槽/悬挂引用 → 404 slot_empty / plugin_missing（core 口径）
  async function disassemblePlugin(input) {
    const o = input || {};
    try {
      await requireArchive(o.playerId);
      const view = await store.getWarehouse(o.playerId);
      const res = itemsMod.disassemble(view.warehouse, { targetUid: o.targetUid, slotIndex: o.slotIndex });
      if (!res.ok) {
        return fail(res.code, pluginRejectMessageOf(res), [
          { path: 'slotIndex', code: res.code, message: res.message || res.code },
        ]);
      }
      const applied = await store.applyWarehouseChange({
        playerId: o.playerId, op: 'disassemble', targetUid: o.targetUid, slotIndex: o.slotIndex,
      });
      logWrite('disassemblePlugin', { playerId: o.playerId, targetUid: o.targetUid, slotIndex: o.slotIndex });
      return ok({
        warehouse: applied.warehouse, usage: applied.usage, counts: applied.counts, caps: applied.caps,
      });
    } catch (err) {
      return toFailure(err, log, 'disassemblePlugin');
    }
  }

  /* ---------- D-161：AI 库（本批仅后端；前端只用 list） ---------- */

  function aiBrief(ai) {
    return {
      aiId: ai.aiId,
      name: ai.name,
      program: deepClone(ai.program),
      createdAt: ai.createdAt === undefined ? null : ai.createdAt,
      updatedAt: ai.updatedAt === undefined ? null : ai.updatedAt,
    };
  }

  // GET /me/ai：库内条目 + 上限 + 被哪些配置引用（usage: aiId → [slotId]）
  async function listAi(playerId) {
    try {
      const view = await store.listAi(playerId);
      log.trace('store', 'store.read', 'account.listAi', { playerId });
      return ok({
        items: (view.items || []).map(aiBrief),
        count: (view.items || []).length,
        max: view.max,
        usage: view.usage || {},
      });
    } catch (err) {
      return toFailure(err, log, 'listAi');
    }
  }

  // POST /me/ai：命名保存（上限 100 → 409 ai_limit）。
  //   注：**本批只做结构检查**（program 必须是对象且 type=program）；完整 AST 校验由 F5 编辑器在保存前
  //   调 `POST /ai/validate` 完成（见分册 §13 K-7）。
  async function createAi(input) {
    const o = input || {};
    try {
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (name === '' || name.length > AI_NAME_MAX) {
        return fail('bad_request', `AI 名称需 1~${AI_NAME_MAX} 字符`, [
          detailOf('bad_request', `AI 名称需 1~${AI_NAME_MAX} 字符`, 'name'),
        ]);
      }
      const program = o.program;
      if (!program || typeof program !== 'object' || Array.isArray(program) || program.type !== 'program') {
        return fail('bad_request', 'program 必须是 AI 程序对象（type=program）', [
          detailOf('bad_request', 'program 必须是 {type:"program", version, body}', 'program'),
        ]);
      }
      await requireArchive(o.playerId);
      const res = await store.createAi({ playerId: o.playerId, name, program });
      logWrite('createAi', { playerId: o.playerId, aiId: res.ai.aiId });
      const view = await store.listAi(o.playerId);
      return ok({ aiId: res.ai.aiId, ai: aiBrief(res.ai), count: view.items.length, max: view.max });
    } catch (err) {
      return toFailure(err, log, 'createAi');
    }
  }

  // DELETE /me/ai/:aiId：被**出战配置**引用 → 409 ai_in_use（非出战配置的引用只作提示）
  async function deleteAi(input) {
    const o = input || {};
    try {
      await requireArchive(o.playerId);
      const res = await store.deleteAi({ playerId: o.playerId, aiId: o.aiId });
      logWrite('deleteAi', { playerId: o.playerId, aiId: o.aiId, referencedBy: res.referencedBy });
      return ok({ deleted: o.aiId, referencedBy: res.referencedBy || [], count: (res.items || []).length, max: res.max });
    } catch (err) {
      return toFailure(err, log, 'deleteAi');
    }
  }

  /* ---------- 仓库镜像（D-130 遗留 / D-159 起已退役：服务端有真源） ---------- */

  // PUT /me/warehouse：**遗留兼容路径**。D-159 起仓库为服务端权威（`GET /me/warehouse` = 真源），
  //   本端点不再作为引用校验的判据，也不再拒绝请求：
  //   · 形状非法 → 400（保留原有防护）；
  //   · 引用不覆盖出战配置 → 200 + `verified:false` + warn（**旧客户端仍可继续**，见分册 K-3；
  //     修前为 409 loadout_invalid —— 那会让"服务端仓库已含真源、客户端镜像陈旧"的老流程直接卡死）。
  //   镜像正文仍只进进程内缓存（不落盘），仅作为 `loadWarehouse` 的兜底来源之一。
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
        if (!v.ok) {
          log.warn('store', 'store.write',
            `仓库镜像不覆盖出战配置引用（D-159 起不再拒绝，仅记 verified:false）：${(v.errors[0] || {}).message || ''}`,
            { playerId: o.playerId, op: 'saveWarehouseMirror', details: v.errors.slice(0, 3) });
        } else {
          verified = true;
        }
      }
      const hash = contentHash(o.warehouse);
      mirrorSet(o.playerId, { warehouse: deepClone(o.warehouse), hash, savedAt: nowFn() });
      // 缺口 1：把该镜像中出战配置**引用到的插件项**附到出战快照（同 hash → 只刷新该附加字段）。
      //   这样"只提交镜像、不再重存配置"的客户端在进程重启后同样能带着真实词条对局。
      let snapshotWarehouseRefreshed = false;
      if (verified && active && active.snapshot && active.snapshot.hash
        && archiveMod.loadoutRefs(active.loadout).length > 0 && typeof store.freezeSnapshot === 'function') {
        try {
          store.freezeSnapshot(active.loadout, versions, { warehouse: o.warehouse });
          snapshotWarehouseRefreshed = true;
        } catch (err) {
          log.warn('store', 'store.write',
            `仓库镜像未能附到出战快照（不影响本次校验）：${err && err.message ? err.message : err}`,
            { playerId: o.playerId, op: 'saveWarehouseMirror' });
        }
      }
      let applied = false;
      if (verified && archive.flags.unverifiedLoadout !== false) {
        await store.updateArchive(o.playerId, (a) => {
          a.flags.unverifiedLoadout = false;
          return null;
        });
        applied = true;
      }
      logWrite('saveWarehouseMirror', { playerId: o.playerId, verified, warehouseHash: hash });
      // ⚠️ 字段语义分叉（B29 遗留，D-159 后必须说清）：
      //   · `unverifiedLoadout` = **本次提交的镜像**是否覆盖出战配置引用（回执局部量，`!verified`）；
      //   · `archiveUnverifiedLoadout` = **档案真源**的标志位（`GET /me` 的 `flags.unverifiedLoadout` 同源）。
      //   D-159 起真源优先：镜像不覆盖**不再**把档案标志置 true，故两者可能一个 true 一个 false ——
      //   旧客户端若只看 `unverifiedLoadout` 会误判"配置未校验"，故**显式回带档案口径**（新增字段，不改旧字段）。
      return ok({
        saved: true,
        verified,
        warehouseHash: hash,
        unverifiedLoadout: !verified,
        archiveUnverifiedLoadout: !!archive.flags.unverifiedLoadout,
        applied,
        snapshotWarehouseRefreshed,
        buckets: bucketCounts(o.warehouse),
        warehouse: deepClone(o.warehouse),
      });
    } catch (err) {
      return toFailure(err, log, 'saveWarehouseMirror');
    }
  }

  // GET /me/warehouse-mirror 语义（**遗留**）：回读最近一次提交的进程内镜像；重启后为空 → warehouse_missing
  //   ⚠️ D-159 起仓库真源是 `GET /me/warehouse`（服务端权威）；本方法只服务退役中的镜像路径。
  async function getWarehouseMirror(playerId) {
    try {
      const archive = await requireArchive(playerId);
      const entry = mirrors.get(playerId);
      if (!entry) {
        return fail('warehouse_missing', '本进程内没有该玩家的仓库镜像（D-159 起仓库真源为 GET /me/warehouse，本镜像端点已退役）');
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

  // GET /me/records?since=&limit=&role=：seq 增量读取（since 缺省 = 档案未读游标）
  // 游标推进**只由** POST /me/records/seen 负责；latestSeq 是"本次返回里最大的 seq"（展示/去重用途），
  // **不可当作 since 直接回传**——limit 截断时那样会跳过更早的未读战绩。
  async function records(input) {
    const o = input || {};
    try {
      const norm = normalizeRecordsQuery(o);
      if (!norm.ok) return fail('bad_request', '战绩查询参数非法', norm.details);
      const archive = await requireArchive(o.playerId);
      const list = await store.records(o.playerId, norm.query);
      const unread = archiveMod.unreadOf(archive);
      const base = norm.query.since === undefined ? unread.fromSeq : norm.query.since;
      let latestSeq = base;
      for (const entry of list) {
        if (Number.isInteger(entry.seq) && entry.seq > latestSeq) latestSeq = entry.seq;
      }
      log.trace('store', 'store.read', 'account.records', { playerId: o.playerId, count: list.length });
      return ok({
        records: list,
        since: base,
        latestSeq,
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
      // 先校验 playerId 与档案存在（缺失 → 400/404，早于 store 的队列路径）
      await requireArchive(o.playerId);
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
      // 先校验 playerId 与档案存在（缺失 → 400/404，早于 store 的读路径）
      await requireArchive(o.playerId);
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
      const maxNick = nicknameMaxOf(store);
      if (!archiveMod.isValidNickname(o.nickname) || o.nickname.length > maxNick) {
        return fail('bad_request', `昵称需 1~${maxNick} 字符`, [detailOf('bad_request', '非法昵称', 'nickname')]);
      }
      // 先校验 playerId 与档案存在（缺失 → 400/404，早于 store 的写队列）
      await requireArchive(o.playerId);
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
    // D-159：服务端权威仓库（真源 + 装配/拆卸）
    getWarehouse,
    assemblePlugin,
    disassemblePlugin,
    // D-161：AI 库
    listAi,
    createAi,
    deleteAi,
    // 仓库镜像（D-130 遗留：只做引用校验）
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
  // 纯领域工具（P7-4 预校验 / 注册事务 / 文档核对；每个导出都有仓库内消费点或被测试直接覆盖）
  defaultLoadout,
  validateLoadoutOf,
  validateWarehouseMirror,
  // 结果信封（auth.js 复用；P7-4 用它统一错误响应）
  ok,
  fail,
  statusOf,
  detailOf,
  toFailure,
};
