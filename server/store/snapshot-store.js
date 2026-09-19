'use strict';
/* server/store/snapshot-store.js —— 内容寻址快照库 + 引用计数 GC（D-129 §5.4/§9.2/§9.3）
 * 权威：docs/systems/11-account-store.md §5.4（冻结内容与 hash/configHash）、§9.2（引用计数与 GC）、§9.3（失效策略）
 * 结构：`snapshots/<hex[0:2]>/<hex>.json`（**注意**：hash 字符串为 `sha256:<64hex>`，Windows 文件名
 *       不允许 ':'，故磁盘名只取 hex 部分；完整 hash 保存在快照正文里，回读时以正文为准）。
 * 语义：写入幂等（同 hash 只存一份，保留首个版本戳）；快照不可变 → 对外一律深拷贝。
 */
const path = require('node:path');
const { nullLogger } = require('../../shared/log.js');
const { deepClone, contentHash, digestOf, isHash } = require('./canonical.js');
const fsatomic = require('./fsatomic.js');
const { StoreError } = require('./errors.js');

const MS_PER_DAY = 86400000;

// 冻结内容 = 完整 loadout 深拷贝 + 版本戳（§5.4）
function buildSnapshot(input) {
  const opts = input || {};
  const copy = deepClone(opts.loadout);
  const engineVersion = opts.engineVersion === undefined ? '0.0.0' : opts.engineVersion;
  const dataVersion = opts.dataVersion === undefined ? 'unknown' : opts.dataVersion;
  return {
    hash: contentHash(copy),
    engineVersion,
    dataVersion,
    configHash: contentHash({ engineVersion, dataVersion, loadout: copy }),
    loadout: copy,
    frozenAt: Number.isInteger(opts.frozenAt) ? opts.frozenAt : Date.now(),
  };
}

function shardOf(hash) {
  return digestOf(hash).slice(0, 2);
}

function snapshotPath(dir, hash) {
  const hex = digestOf(hash);
  return path.join(dir, hex.slice(0, 2), `${hex}.json`);
}

// §9.3 步骤 3：记录版本戳 vs 当前版本
function verifyRecordVersions(record, currentVersions) {
  const versions = (record && record.versions) || {};
  const current = currentVersions || {};
  if (versions.engine !== current.engine) return { ok: false, reason: 'engine_mismatch' };
  if (versions.data !== current.data) return { ok: false, reason: 'data_mismatch' };
  return { ok: true, reason: null };
}

// §9.3 步骤 4：快照正文可用性（缺失/版本戳不一致 → 410 replay_expired）
function verifySnapshotForReplay(snapshot, currentVersions) {
  if (!snapshot) return { ok: false, reason: 'snapshot_gc' };
  const current = currentVersions || {};
  if (snapshot.engineVersion !== current.engine) return { ok: false, reason: 'snapshot_engine_mismatch' };
  if (snapshot.dataVersion !== current.data) return { ok: false, reason: 'snapshot_data_mismatch' };
  return { ok: true, reason: null };
}

function createSnapshotStore(options) {
  const opts = options || {};
  const dir = opts.dir;
  if (!dir) throw new StoreError('store_internal', 'snapshot store 需要 dir');
  const log = opts.logger || nullLogger;
  const cfg = opts.config || {};
  const cacheSize = Number.isInteger(cfg.snapshotCacheSize) && cfg.snapshotCacheSize > 0 ? cfg.snapshotCacheSize : 500;
  const cache = new Map(); // hash → snapshot（LRU：Map 插入序）
  const refs = new Map();  // hash → 引用计数（内存 + 启动时按 journal 重建）

  function cacheGet(hash) {
    if (!cache.has(hash)) return null;
    const value = cache.get(hash);
    cache.delete(hash);
    cache.set(hash, value);
    return deepClone(value);
  }

  function cacheSet(hash, snapshot) {
    cache.set(hash, deepClone(snapshot));
    while (cache.size > cacheSize) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  }

  function invalidate(hash) {
    cache.delete(hash);
  }

  function put(snapshot) {
    if (!snapshot || !isHash(snapshot.hash)) throw new StoreError('bad_request', '快照缺少合法 hash');
    fsatomic.ensureDir(dir);
    const file = snapshotPath(dir, snapshot.hash);
    if (fsatomic.pathExists(file)) {
      const existing = fsatomic.readJsonSync(file, null);
      if (existing && existing.hash === snapshot.hash) {
        cacheSet(snapshot.hash, existing);
        log.debug('store', 'store.snapshot.write', `快照已存在（内容寻址去重）${snapshot.hash.slice(0, 15)}…`, {
          hash: snapshot.hash, written: false,
        });
        return { snapshot: deepClone(existing), written: false };
      }
    }
    const body = { ...snapshot, loadout: deepClone(snapshot.loadout) };
    fsatomic.writeJsonAtomicSync(file, body, { logger: log, canonical: true });
    cacheSet(snapshot.hash, body);
    log.debug('store', 'store.snapshot.write', `快照落盘 ${snapshot.hash.slice(0, 15)}…`, {
      hash: snapshot.hash, written: true, file,
    });
    return { snapshot: deepClone(body), written: true };
  }

  function get(hash) {
    if (!isHash(hash)) return null;
    const cached = cacheGet(hash);
    if (cached) return cached;
    const file = snapshotPath(dir, hash);
    const body = fsatomic.readJsonSync(file, null);
    if (!body || body.hash !== hash) return null;
    cacheSet(hash, body);
    return deepClone(body);
  }

  function requireSnapshot(hash) {
    const snap = get(hash);
    if (!snap) {
      log.warn('store', 'store.snapshot.missing', `快照缺失 ${String(hash).slice(0, 15)}…`, { hash });
    }
    return snap;
  }

  function has(hash) {
    if (cache.has(hash)) return true;
    return fsatomic.pathExists(snapshotPath(dir, hash));
  }

  function list() {
    const out = [];
    for (const entry of fsatomic.listDirFiles(dir)) {
      if (!entry.isDirectory()) continue;
      for (const file of fsatomic.listDirFiles(path.join(dir, entry.name))) {
        if (file.isFile() && file.name.endsWith('.json')) out.push(file.name.slice(0, -5));
      }
    }
    return out.sort();
  }

  function ref(hash, delta) {
    if (!isHash(hash)) return 0;
    const next = Math.max(0, (refs.get(hash) || 0) + (delta === undefined ? 1 : delta));
    refs.set(hash, next);
    return next;
  }

  function refCount(hash) {
    return refs.get(hash) || 0;
  }

  // 启动时按 journal 重建引用计数（§9.2）
  function rebuildRefs(records) {
    refs.clear();
    let counted = 0;
    for (const rec of records || []) {
      if (!rec || rec.type !== 'battle.recorded') continue;
      for (const side of ['p1', 'p2']) {
        const part = rec[side];
        if (part && isHash(part.snapshotHash)) {
          ref(part.snapshotHash, 1);
          counted += 1;
        }
      }
    }
    return { hashes: refs.size, refs: counted };
  }

  // GC：无引用且超过 retentionDays → 删除；被引用（含近期对局）**不删**（§9.2）
  function gc(gcOpts) {
    const o = gcOpts || {};
    const retentionDays = Number.isInteger(o.retentionDays) ? o.retentionDays : 90;
    const at = Number.isInteger(o.at) ? o.at : Date.now();
    const protect = o.protect instanceof Set ? o.protect : new Set(o.protect || []);
    const removed = [];
    const kept = [];
    for (const hex of list()) {
      const hash = `sha256:${hex}`;
      if (protect.has(hash)) {
        kept.push(hash);
        continue;
      }
      if (refCount(hash) > 0) {
        kept.push(hash);
        continue;
      }
      const file = snapshotPath(dir, hash);
      const body = fsatomic.readJsonSync(file, null);
      const frozenAt = body && Number.isInteger(body.frozenAt) ? body.frozenAt : 0;
      if (at - frozenAt <= retentionDays * MS_PER_DAY) {
        kept.push(hash);
        continue;
      }
      fsatomic.removeFile(file);
      invalidate(hash);
      refs.delete(hash);
      removed.push(hash);
    }
    log.info('store', 'store.snapshot.gc', `快照 GC：删除 ${removed.length} / 保留 ${kept.length}`, {
      removed: removed.length, kept: kept.length, retentionDays,
    });
    return { removed, kept, scanned: removed.length + kept.length };
  }

  return {
    dir,
    build: buildSnapshot,
    put,
    get,
    requireSnapshot,
    has,
    list,
    ref,
    refCount,
    refCounts: () => Object.fromEntries(refs),
    rebuildRefs,
    gc,
    cacheSize: () => cache.size,
    stats: () => ({ files: list().length, refs: refs.size, cached: cache.size }),
  };
}

module.exports = {
  MS_PER_DAY,
  buildSnapshot,
  shardOf,
  snapshotPath,
  verifyRecordVersions,
  verifySnapshotForReplay,
  createSnapshotStore,
};
