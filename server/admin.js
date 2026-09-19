'use strict';
/* server/admin.js —— 管理端（P7-3 / B33 的本批次部分：重建索引、注入/清理测试数据、统计、封禁）
 * 契约：docs/interfaces.md §1 `server/admin.js` + §2 `POST /api/v1/admin/bots` / `POST /api/v1/admin/rebuild-index`
 *      + §7 `DL_ADMIN_TOKEN`；docs/systems/11-account-store.md §7.6（bot 账号：管理员注入的**真实档案**）/§10.1。
 *
 * ⚠️ 令牌校验在**本模块内**实现（HTTP 中间件属 P7-4）。
 * 🚫 与 plan-p7-playable §P7-3 的关系（必须读）：本模块的 `injectDebugBots` **不是**"池不足拿占位 bot 凑满 10 场"。
 *    - 它把调试账号作为**真实档案**（真实 loadout 快照 + 真实 AI + 入池 + 被正常抽中）写进注册表；
 *    - 调用它需要 ① 正确的 `DL_ADMIN_TOKEN` 且 ② `DL_DEBUG_BOTS=1` 显式开关（默认关闭）；
 *    - 排位/快速对战的池**只**来自注册表，池不足依旧如实 `shortfall`/`no_opponent`，生产路径不会自动调用本模块；
 *    - 响应与日志一律标注 `debug:true`，可用 `clearDebugBots` 一次性清理。
 *
 * 事件（interfaces.md §6；本模块只用既有事件名）：`store.index.rebuild`(info) / `store.write`(debug) /
 *      `store.abuse.suspect`(warn，未授权访问) / `store.error`(error)。
 */
const { nullLogger } = require('../shared/log.js');
const archiveMod = require('./store/archive.js');
const ranked = require('./ranked.js');

const TOKEN_ENV = 'DL_ADMIN_TOKEN';
const DEBUG_ENV = 'DL_DEBUG_BOTS';
const BOT_KEY_PREFIX = 'dl-debug-';
const MAX_BOTS_PER_CALL = 200;
const TIERS = archiveMod.TIERS;

// 由 botKey + 序号确定性派生 playerId（`pl_` + 16 hex）→ 同 botKey 重复注入 = 幂等（§7.6"按 botKey 去重"）
function botPlayerIdOf(botKey, index) {
  const crypto = require('node:crypto');
  return `pl_${crypto.createHash('sha256').update(`${BOT_KEY_PREFIX}${botKey}|${index}`).digest('hex').slice(0, 16)}`;
}

function envOf(env) {
  return env === undefined ? process.env : (env || {});
}

// 令牌比较：长度不等先补齐再比（沿用 auth.js 口径，避免长度泄露 + 不抛错）
function tokenEquals(a, b) {
  const crypto = require('node:crypto');
  const A = Buffer.from(String(a === undefined || a === null ? '' : a));
  const B = Buffer.from(String(b === undefined || b === null ? '' : b));
  const len = Math.max(A.length, B.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  A.copy(pa);
  B.copy(pb);
  return A.length === B.length && crypto.timingSafeEqual(pa, pb);
}

/**
 * createAdmin({ store, logger?, now?, env? })
 *   store 必填（server/store 适配器，已 open）；env 为测试接缝（默认 process.env）。
 * 返回：
 *   checkToken(token)                 → { ok, code, status, message }（不抛错）
 *   rebuildIndex()                    → { status, data:{players,seq,leaderboardRows} }
 *   stats()                           → { status, data:{…store.stats + index/leaderboard 摘要} }
 *   injectDebugBots(input)            → 受 token + DL_DEBUG_BOTS 双门控；批量建调试档案
 *   clearDebugBots(input)             → 受 token 门控；清理由本模块注入的调试档案
 *   ban(input) / unban(input)         → 受 token 门控；写 journal（account.banned/unbanned）
 */
function createAdmin(options) {
  const opts = options || {};
  const store = opts.store;
  if (!store || typeof store.createAccount !== 'function' || typeof store.index !== 'object') {
    throw new TypeError('createAdmin 需要已装配的 store 适配器（server/store/index.js createStore/openStore）');
  }
  const log = opts.logger || nullLogger;
  const nowFn = typeof opts.now === 'function' ? opts.now
    : (typeof store.now === 'function' ? store.now : () => Date.now());
  const env = envOf(opts.env);

  // DL_ADMIN_TOKEN 语义（P7-4 接线口径，tests/api/api-admin.test.js AD-1/AD-2）：
  //   · 变量**未配置或为空串** → 管理面整体不可用 → 503 admin_token_missing（不得把空令牌当成"放行"）
  //   · 已配置非空值 → 逐请求校验：不匹配 → 403 forbidden（不泄露是否配置）
  function adminToken() {
    const raw = env[TOKEN_ENV];
    if (typeof raw !== 'string' || raw === '') return null;
    return raw;
  }

  function debugEnabled() {
    return ranked.inspectDebugBots(env).enabled;
  }

  function checkToken(token) {
    const expected = adminToken();
    if (expected === null) {
      return { ok: false, status: 503, code: 'admin_token_missing', message: `${TOKEN_ENV} 未配置，管理端不可用` };
    }
    if (!tokenEquals(token, expected)) {
      log.warn('store', 'store.abuse.suspect', `管理端鉴权失败（token 不匹配）`, { op: 'admin.auth', code: 'forbidden' });
      return { ok: false, status: 403, code: 'forbidden', message: '管理员令牌无效' };
    }
    return { ok: true, status: 200, code: null, message: null };
  }

  async function withToken(input, op, fn) {
    const o = input || {};
    const auth = checkToken(o.adminToken === undefined ? o.token : o.adminToken);
    if (!auth.ok) return { status: auth.status, code: auth.code, message: auth.message };
    try {
      return await fn(o);
    } catch (err) {
      log.error('store', 'store.error', `admin.${op} 失败：${err && err.message ? err.message : err}`, {
        op, code: (err && err.code) || null,
      });
      if (err && err.name === 'StoreError') {
        return { status: 500, code: err.code, message: err.message, details: err.details || [] };
      }
      return { status: 500, code: 'store_internal', message: `内部错误（${op}）` };
    }
  }

  // 重建索引：扫描 players/* → upsert → 保存 index.json（§5.6 / T-ST-5）
  async function rebuildIndex(input) {
    return withToken(input, 'rebuildIndex', async () => {
      const stats = await store.index.rebuild();
      const rows = store.index.leaderboard({ scope: 'global', limit: 1 });
      log.info('store', 'store.index.rebuild', `管理端触发索引重建（${stats.players} 玩家，seq=${stats.seq}）`, {
        op: 'rebuildIndex', players: stats.players, seq: stats.seq, leaderboardRows: rows.length,
      });
      return { status: 200, data: { players: stats.players, seq: stats.seq, builtAt: stats.builtAt, leaderboardRows: rows.length } };
    });
  }

  // 只读统计（不要求 token 的部分由 P7-4 决定是否暴露；此处保守要求 token）
  async function stats(input) {
    return withToken(input, 'stats', async () => {
      const base = typeof store.stats === 'function' ? store.stats() : {};
      const snapshotStats = store.snapshot && typeof store.snapshot.stats === 'function' ? store.snapshot.stats() : null;
      const tierCounts = {};
      for (const tier of TIERS) tierCounts[tier] = store.index.byTier(tier).length;
      return {
        status: 200,
        data: {
          adapter: base.adapter || store.adapterName,
          players: store.index.size(),
          seq: store.maxSeq(),
          tiers: tierCounts,
          leaderboard: store.index.leaderboard({ scope: 'global', limit: 10 }).length,
          snapshots: snapshotStats,
          journal: base.journal || null,
          cache: base.cache || null,
        },
      };
    });
  }

  // 注水调试账号（真实档案）：需要 token + DL_DEBUG_BOTS=1 双门控
  // P2-7：**令牌校验前置**——未配置/错误 `DL_ADMIN_TOKEN` 时先返回 503/403，而不是先撞 debug 门控
  //   得到含混的 403 debug_bots_disabled（那会让"管理面不可用"看起来像"调试开关没开"）。
  async function injectDebugBots(input) {
    return withToken(input, 'injectDebugBots', async (o) => {
      if (!debugEnabled()) {
        return {
          status: 403,
          code: 'debug_bots_disabled',
          message: `调试注入默认关闭：需显式设置 ${DEBUG_ENV}=1（占位 bot 不参与正常路径，见 plan-p7-playable §P7-3）`,
        };
      }
      const tier = o.tier === undefined ? 'common' : o.tier;
      if (!TIERS.includes(tier)) {
        return { status: 400, code: 'bad_tier', message: `非法段位 ${tier}（可选: ${TIERS.join('/')}）` };
      }
      const count = o.count === undefined ? 1 : o.count;
      if (!Number.isInteger(count) || count < 1 || count > MAX_BOTS_PER_CALL) {
        return { status: 400, code: 'bad_request', message: `count 必须是 1..${MAX_BOTS_PER_CALL} 的整数` };
      }
      const points = o.points === undefined ? 0 : o.points;
      if (!Number.isInteger(points) || points < 0 || points > (store.ratingConfig.cap || 0)) {
        return { status: 400, code: 'bad_request', message: `points 必须是 0..${store.ratingConfig.cap} 的整数` };
      }
      const keyBase = o.botKey === undefined || o.botKey === null ? `auto-${nowFn()}` : String(o.botKey);
      const at = nowFn();
      const loadout = o.loadout === undefined || o.loadout === null ? ranked.buildDefaultLoadout() : o.loadout;
      const created = [];
      for (let i = 0; i < count; i++) {
        const botKey = `${BOT_KEY_PREFIX}${keyBase}-${i + 1}`;
        const playerId = o.playerIdPrefix ? `${o.playerIdPrefix}${i + 1}` : botPlayerIdOf(keyBase, i + 1);
        const existing = await store.loadArchive(playerId);
        if (existing) { created.push({ playerId, botKey, skipped: true }); continue; }
        const snapshot = store.freezeSnapshot(loadout, store.versions);
        const slotId = archiveMod.slotIdOf(store.config || {}, 1);
        await store.createAccount({
          playerId, publicId: archiveMod.newPublicId(), nickname: o.nickname || `debug-bot-${i + 1}`,
          at, tier, points, isBot: true,
          flags: { isBot: true, botKey, debug: true },
          slot: { slotId, name: '调试配置', snapshotHash: snapshot.hash, configHash: snapshot.configHash, versions: store.versions },
        });
        created.push({ playerId, botKey, tier, points, snapshotHash: snapshot.hash, skipped: false });
        log.debug('store', 'store.write', `调试账号已注入 ${playerId}（tier=${tier} points=${points}）`, {
          op: 'injectDebugBots', playerId, botKey, tier, points, debug: true,
        });
      }
      log.warn('store', 'store.abuse.suspect',
        `管理端注入调试账号 ${created.filter((c) => !c.skipped).length} 个（debug:true，非正常匹配路径）`, {
          op: 'injectDebugBots', count: created.length, tier, points, debug: true, botKeyPrefix: BOT_KEY_PREFIX,
        });
      return {
        status: 200,
        data: {
          injected: created.filter((c) => !c.skipped).length,
          skipped: created.filter((c) => c.skipped).length,
          tier, points, debug: true, bots: created,
        },
      };
    });
  }

  // 清理由本模块注入的调试档案（flags.isBot && flags.botKey 以 dl-debug- 开头）
  async function clearDebugBots(input) {
    return withToken(input, 'clearDebugBots', async () => {
      const ids = await store.listPlayerIds();
      const removed = [];
      for (const playerId of ids) {
        const archive = await store.loadArchive(playerId);
        if (!archive || !archive.flags || archive.flags.isBot !== true) continue;
        const botKey = archive.flags.botKey;
        if (typeof botKey !== 'string' || !botKey.startsWith(BOT_KEY_PREFIX)) continue;
        await store.removeArchive(playerId);
        removed.push({ playerId, botKey });
      }
      log.info('store', 'store.write', `调试账号已清理 ${removed.length} 个`, { op: 'clearDebugBots', removed: removed.length });
      return { status: 200, data: { removed: removed.length, bots: removed } };
    });
  }

  async function ban(input) {
    return withToken(input, 'ban', async () => {
      const o = input || {};
      if (typeof o.playerId !== 'string' || o.playerId === '') {
        return { status: 400, code: 'bad_request', message: '需要 playerId' };
      }
      const archive = await store.loadArchive(o.playerId);
      if (!archive) return { status: 404, code: 'store_not_found', message: `档案 ${o.playerId} 不存在` };
      const updated = await store.setBanned({ playerId: o.playerId, banned: o.banned !== false, reason: o.reason });
      return { status: 200, data: { playerId: o.playerId, banned: !!updated.flags.banned, reason: updated.flags.banReason || null } };
    });
  }

  return {
    store,
    checkToken,
    rebuildIndex,
    stats,
    injectDebugBots,
    clearDebugBots,
    ban,
    debugEnabled,
  };
}

let defaultInstance = null;

function defaultAdmin(options) {
  if (!defaultInstance) defaultInstance = createAdmin(options);
  return defaultInstance;
}

module.exports = {
  createAdmin,
  defaultAdmin,
  tokenEquals,
  TOKEN_ENV,
  DEBUG_ENV,
  BOT_KEY_PREFIX,
  MAX_BOTS_PER_CALL,
};
