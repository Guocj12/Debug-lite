'use strict';
/* server/store/session-table.js —— 会话表（D-129 §4.3；`runtime/sessions.json`）
 * 权威：docs/systems/11-account-store.md §4.3（token 只存 sha256；TTL 默认 7 天；每人最多 5 个活跃会话，
 *      超出淘汰最旧；登出删当前 / 改密删其他 / 封禁删全部）
 * 定位：**纯持久化**——token 生成、密码哈希、限速锁定都在 server/auth.js（B28）；本表只管记录与淘汰。
 * 可丢弃：文件损坏 → 记 store.error 并从空表开始（等价"全员登出"，设计允许）。
 */
const { nullLogger } = require('../../shared/log.js');
const { deepClone } = require('./canonical.js');
const fsatomic = require('./fsatomic.js');
const { StoreError } = require('./errors.js');

const SESSION_VERSION = 1;
const MS_PER_DAY = 86400000;

function createSessionTable(options) {
  const opts = options || {};
  const file = opts.file;
  if (!file) throw new StoreError('store_internal', 'session table 需要 file');
  const log = opts.logger || nullLogger;
  const cfg = opts.config || {};
  const maxPerPlayer = Number.isInteger(cfg.session && cfg.session.maxPerPlayer) && cfg.session.maxPerPlayer > 0
    ? cfg.session.maxPerPlayer : 5;
  let table = new Map(); // tokenHash → record

  function load() {
    table = new Map();
    if (!fsatomic.pathExists(file)) return 0; // 首次启动：正常空表，不记错误
    const body = fsatomic.readJsonSync(file, null);
    if (!body || !Array.isArray(body.sessions)) {
      log.error('store', 'store.error', `会话表 ${file} 损坏，按空表启动（等价全员登出）`, { file });
      return 0;
    }
    for (const rec of body.sessions) {
      if (rec && typeof rec.tokenHash === 'string') table.set(rec.tokenHash, rec);
    }
    return table.size;
  }

  function save() {
    const body = { sessionVersion: SESSION_VERSION, savedAt: Date.now(), sessions: [...table.values()] };
    fsatomic.writeJsonAtomicSync(file, body, { logger: log, pretty: true });
    return body.sessions.length;
  }

  function sortedOf(playerId) {
    return [...table.values()]
      .filter((rec) => rec.playerId === playerId)
      .sort((a, b) => (a.lastUsedAt || a.createdAt || 0) - (b.lastUsedAt || b.createdAt || 0));
  }

  function put(record) {
    if (!record || typeof record.tokenHash !== 'string' || record.tokenHash === '') {
      throw new StoreError('bad_request', '会话记录缺少 tokenHash');
    }
    const mine = sortedOf(record.playerId);
    while (mine.length >= maxPerPlayer) {
      const oldest = mine.shift();
      table.delete(oldest.tokenHash);
    }
    const stored = { ...deepClone(record) };
    if (!Number.isInteger(stored.createdAt)) stored.createdAt = Date.now();
    if (!Number.isInteger(stored.lastUsedAt)) stored.lastUsedAt = stored.createdAt;
    table.set(stored.tokenHash, stored);
    save();
    return deepClone(stored);
  }

  function get(tokenHash) {
    const rec = table.get(tokenHash);
    if (!rec) return null;
    if (Number.isInteger(rec.expiresAt) && rec.expiresAt <= Date.now()) {
      table.delete(tokenHash);
      save();
      return null;
    }
    return deepClone(rec);
  }

  // 只读探针（P7-2 最小加法）：**不做过期清理、不落盘**，用于区分"会话不存在"与"刚过期"。
  // 授权路径必须先 peek 再 get：get 会把过期行删掉，此后就只能回 unauthorized（§4.4 步骤 2 / §10.3）。
  function peek(tokenHash) {
    const rec = table.get(tokenHash);
    return rec ? deepClone(rec) : null;
  }

  function touch(tokenHash, patch) {
    const rec = table.get(tokenHash);
    if (!rec) return null;
    Object.assign(rec, deepClone(patch || {}));
    table.set(tokenHash, rec);
    save();
    return deepClone(rec);
  }

  function revoke(tokenHash) {
    const had = table.delete(tokenHash);
    if (had) save();
    return had;
  }

  function revokePlayer(playerId, options2) {
    const keep = options2 && options2.keepTokenHash ? options2.keepTokenHash : null;
    let revoked = 0;
    for (const [hash, rec] of [...table.entries()]) {
      if (rec.playerId !== playerId) continue;
      if (keep !== null && hash === keep) continue;
      table.delete(hash);
      revoked += 1;
    }
    if (revoked > 0) save();
    return { revoked };
  }

  function list(playerId) {
    return sortedOf(playerId).map((rec) => deepClone(rec));
  }

  function prune(at) {
    const now = Number.isInteger(at) ? at : Date.now();
    let removed = 0;
    for (const [hash, rec] of [...table.entries()]) {
      if (Number.isInteger(rec.expiresAt) && rec.expiresAt <= now) {
        table.delete(hash);
        removed += 1;
      }
    }
    if (removed > 0) save();
    return { removed, remaining: table.size };
  }

  return {
    file,
    load,
    save,
    put,
    get,
    peek,
    touch,
    revoke,
    revokePlayer,
    list,
    prune,
    size: () => table.size,
    all: () => [...table.values()].map((rec) => deepClone(rec)),
    stats: () => ({ sessions: table.size, players: new Set([...table.values()].map((r) => r.playerId)).size }),
    maxPerPlayer,
  };
}

module.exports = { SESSION_VERSION, MS_PER_DAY, createSessionTable };
