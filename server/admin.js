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
const ADMIN_USERS_ENV = 'DL_ADMIN_USERS'; // F2：管理员账号白名单（用户名或 publicId，逗号分隔）
const BOT_KEY_PREFIX = 'dl-debug-';
const MAX_BOTS_PER_CALL = 200;
const ACCOUNTS_LIMIT_DEFAULT = 20; // F2：分页账号列表单页缺省
const ACCOUNTS_LIMIT_MAX = 200;    // F2：单页上限（**总数无上限**，分页可列全部）
const TIERS = archiveMod.TIERS;

// 由 botKey + 序号确定性派生 playerId（`pl_` + 16 hex）→ 同 botKey 重复注入 = 幂等（§7.6"按 botKey 去重"）
function botPlayerIdOf(botKey, index) {
  const crypto = require('node:crypto');
  return `pl_${crypto.createHash('sha256').update(`${BOT_KEY_PREFIX}${botKey}|${index}`).digest('hex').slice(0, 16)}`;
}

function envOf(env) {
  return env === undefined ? process.env : (env || {});
}

/* ---------- F2：管理员账号白名单（模块作用域，供 server/index.js 直接复用；契约见
 * docs/frontend/02-accounts.md §2.1） ----------
 * 取值 = 逗号分隔的**用户名**或 **publicId**（`u_…`）/ **playerId**（`pl_…`）；空/未配置 = 无账号级管理员。
 */
function adminUsersOf(rawEnv) {
  const raw = rawEnv ? rawEnv[ADMIN_USERS_ENV] : undefined;
  const names = new Set();
  const publicIds = new Set();
  const playerIds = new Set();
  if (typeof raw === 'string') {
    for (const part of raw.split(',')) {
      const v = part.trim();
      if (v === '') continue;
      if (v.startsWith('u_')) publicIds.add(v);
      else if (v.startsWith('pl_')) playerIds.add(v);
      else names.add(v.toLowerCase());
    }
  }
  return { names, publicIds, playerIds, size: names.size + publicIds.size + playerIds.size };
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

  /* ---------- F2：管理员账号（DL_ADMIN_USERS 白名单；契约 docs/frontend/02-accounts.md §2.1/§2.2） ----------
   * 语义：
   *   · 取值 = 逗号分隔的**用户名**或 **publicId**（`u_…`）；大小写不敏感；空/未配置 = 无账号级管理员；
   *   · 放行优先级：① 请求者账号命中白名单 → 放行（**不需要令牌**，否则该方案无法独立工作）；
   *                 ② 否则走既有令牌路径（未配置 → 503 admin_token_missing；不匹配 → 403 forbidden）；
   *   · 用户名匹配经 `opts.resolveUsername`（= server/auth.js 的 usernameIndexOf）转 playerId 比较，
   *     避免在 admin 层重复实现用户名索引。
   */
  function isAdminPlayer(player) {
    if (!player) return false;
    const admins = opts.adminUsers || adminUsersOf(env);
    if (typeof player.publicId === 'string' && admins.publicIds.has(player.publicId)) return true;
    const playerId = typeof player.playerId === 'string' ? player.playerId : null;
    if (playerId === null) return false;
    if (admins.playerIds.has(playerId)) return true;
    if (admins.names.size === 0) return false;
    const resolve = typeof opts.resolveUsername === 'function' ? opts.resolveUsername : null;
    if (resolve === null) return false;
    for (const name of admins.names) {
      if (resolve(name) === playerId) return true;
    }
    return false;
  }

  // 访问判定：管理员账号优先，其次令牌（via 便于日志与测试断言）
  function checkAccess(input) {
    const o = input || {};
    if (isAdminPlayer(o.player)) return { ok: true, status: 200, code: null, message: null, via: 'account' };
    const auth = checkToken(o.adminToken === undefined ? o.token : o.adminToken);
    return auth.ok ? { ok: true, status: 200, code: null, message: null, via: 'token' } : auth;
  }

  async function withAccess(input, op, fn) {
    const o = input || {};
    const auth = checkAccess(o);
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
    return withAccess(input, 'rebuildIndex', async () => {
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
    return withAccess(input, 'stats', async () => {
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
    return withAccess(input, 'injectDebugBots', async (o) => {
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
      const explicitLoadout = o.loadout === undefined || o.loadout === null ? null : o.loadout;
      // D-166：可显式指定预设族（强弱）；未指定时**每个 bot 按自己的 botKey 派生**不同预设/子变体
      const preset = o.preset === undefined || o.preset === null ? null : String(o.preset);
      if (preset !== null && !ranked.DEFAULT_AI_PRESETS.includes(preset)) {
        return { status: 400, code: 'bad_request', message: `非法 preset ${preset}（可选: ${ranked.DEFAULT_AI_PRESETS.join('/')}）` };
      }
      const created = [];
      for (let i = 0; i < count; i++) {
        const botKey = `${BOT_KEY_PREFIX}${keyBase}-${i + 1}`;
        const playerId = o.playerIdPrefix ? `${o.playerIdPrefix}${i + 1}` : botPlayerIdOf(keyBase, i + 1);
        const existing = await store.loadArchive(playerId);
        if (existing) { created.push({ playerId, botKey, skipped: true }); continue; }
        // D-166：修前所有 bot 共用**同一个** loadout（steady/0）⇒ 互打恒平局（实测 10 场 0 胜 10 平），
        //   无法用于段位晋升/积分验收。现按 botKey 逐个派生（9 个程序：3 族 × 3 子变体）。
        const loadout = explicitLoadout !== null
          ? explicitLoadout
          : ranked.buildDefaultLoadout({ botKey }, preset === null ? undefined : { preset });
        // D-165：bot 也要有**真实仓库**（含自己的角色/技能/插件引用）。修前 bot 仓库为空且快照不带镜像，
        //   而仓库覆盖判据只看 pluginUid ⇒ 空转通过 ⇒ 对局能跑但**回放重算 100% 410**（实测 10/10 场）。
        const warehouse = ranked.syntheticVerifiedWarehouse(loadout);
        const snapshot = store.freezeSnapshot(loadout, store.versions, { warehouse });
        const slotId = archiveMod.slotIdOf(store.config || {}, 1);
        await store.createAccount({
          playerId, publicId: archiveMod.newPublicId(), nickname: o.nickname || `debug-bot-${i + 1}`,
          at, tier, points, isBot: true,
          flags: { isBot: true, botKey, debug: true },
          warehouse,
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
          tier, points, debug: true, preset, bots: created,
        },
      };
    });
  }

  // 清理由本模块注入的调试档案（flags.isBot && flags.botKey 以 dl-debug- 开头）
  async function clearDebugBots(input) {
    return withAccess(input, 'clearDebugBots', async () => {
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
    return withAccess(input, 'ban', async () => {
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

  /* ---------- F2：分页账号列表（**总数无上限**；单页上限 ACCOUNTS_LIMIT_MAX） ----------
   * 数据源 = 索引条目（server/store/index-file.js entryOf 已有 publicId/nickname/tier/points/peakPoints/
   *   inPool/isBot/banned/lastSeenAt/updatedAt）+ 索引键 playerId → **不加载档案**，可支撑万级账号。
   * 排序 = updatedAt 降序 → publicId 升序（**稳定**，保证分页无遗漏/无重复）。
   * playerId 属 admin 通道（玩家侧响应才脱敏，见 server/index.js 的 redact）。
   */
  async function accounts(input) {
    return withAccess(input, 'accounts', async (o) => {
      const offset = o.offset === undefined ? 0 : o.offset;
      if (!Number.isInteger(offset) || offset < 0) {
        return { status: 400, code: 'bad_request', message: 'offset 必须是非负整数' };
      }
      const limit = o.limit === undefined ? ACCOUNTS_LIMIT_DEFAULT : o.limit;
      if (!Number.isInteger(limit) || limit < 1 || limit > ACCOUNTS_LIMIT_MAX) {
        return { status: 400, code: 'bad_request', message: `limit 必须是 1..${ACCOUNTS_LIMIT_MAX} 的整数（总数无上限，靠分页取完）` };
      }
      const ids = await store.listPlayerIds();
      const all = [];
      for (const playerId of ids) {
        const entry = store.index.get(playerId);
        if (!entry) continue;
        all.push({
          playerId,
          publicId: entry.publicId === undefined ? null : entry.publicId,
          nickname: entry.nickname === undefined ? null : entry.nickname,
          tier: entry.tier === undefined ? null : entry.tier,
          points: entry.points === undefined ? 0 : entry.points,
          peakPoints: entry.peakPoints === undefined ? 0 : entry.peakPoints,
          inPool: entry.inPool === true,
          isBot: entry.isBot === true,
          banned: entry.banned === true,
          lastSeenAt: entry.lastSeenAt === undefined ? null : entry.lastSeenAt,
          updatedAt: entry.updatedAt === undefined ? null : entry.updatedAt,
        });
      }
      all.sort((a, b) => {
        const au = a.updatedAt === null ? -1 : a.updatedAt;
        const bu = b.updatedAt === null ? -1 : b.updatedAt;
        if (au !== bu) return bu - au;
        return String(a.publicId).localeCompare(String(b.publicId));
      });
      const total = all.length;
      const rows = all.slice(offset, offset + limit);
      log.debug('store', 'store.read', `管理端读取账号列表（total=${total} offset=${offset} limit=${limit}）`, {
        op: 'accounts', total, offset, limit, via: checkAccess(o).via,
      });
      return { status: 200, data: { total, offset, limit, hasMore: offset + rows.length < total, rows } };
    });
  }

  // 解析目标账号：playerId 优先，其次 publicId（索引只读扫描；无 publicId→playerId 的专用索引）
  async function resolveTarget(o) {
    const playerId = typeof o.playerId === 'string' && o.playerId !== '' ? o.playerId : null;
    if (playerId !== null) return { playerId };
    const publicId = typeof o.publicId === 'string' && o.publicId !== '' ? o.publicId : null;
    if (publicId === null) return { error: { status: 400, code: 'bad_request', message: '需要 playerId 或 publicId' } };
    for (const id of await store.listPlayerIds()) {
      const entry = store.index.get(id);
      if (entry && entry.publicId === publicId) return { playerId: id, publicId };
    }
    return { error: { status: 404, code: 'store_not_found', message: `账号 ${publicId} 不存在` } };
  }

  /* ---------- F2：删除账号（写 player.removed 墓碑，防 journal 重放复活） ----------
   * 拒绝删除请求者自己（409 cannot_delete_self）——避免管理员把自己锁在门外。
   */
  async function deleteAccount(input) {
    return withAccess(input, 'deleteAccount', async (o) => {
      const target = await resolveTarget(o);
      if (target.error) return target.error;
      const me = o.player && typeof o.player.playerId === 'string' ? o.player.playerId : null;
      if (me !== null && me === target.playerId) {
        return { status: 409, code: 'cannot_delete_self', message: '不能删除当前登录的管理员账号' };
      }
      const archive = await store.loadArchive(target.playerId);
      if (!archive) return { status: 404, code: 'store_not_found', message: `档案 ${target.playerId} 不存在` };
      const publicId = archive.publicId;
      await store.removeArchive(target.playerId);
      log.warn('store', 'store.player.removed', `管理端删除账号 ${publicId}（${target.playerId}）`, {
        op: 'deleteAccount', playerId: target.playerId, publicId, via: checkAccess(o).via,
      });
      return { status: 200, data: { removed: true, playerId: target.playerId, publicId } };
    });
  }

  /* ---------- D-170：管理员直接改账号（段位/积分/入池） ----------
   * 用途（用户 2026-09-25 要求）：验收"排位升段 / 快速对战积分 / 段位榜"时可直接把任意账号改到目标状态，
   *   不必靠反复对局刷；同时是长期运维工具（如把误封/异常账号拉回正常段位）。
   * 语义：
   *   · **写 journal 留痕**（`account.patched`）——可重放、可审计（`via` 亦记日志）；
   *   · **不动 `peakTier`/`peakPoints`**（历史峰值 = "曾经达到过"，人为调低会自相矛盾）；
   *   · 段位变化同步 `tierUpdatedAt`（段位榜按到达时间排序要用）；
   *   · 至少给一项（tier/points/inPool），否则 400；未知账号 → 404；非法值 → 400。
   */
  async function accountPatch(input) {
    return withAccess(input, 'accountPatch', async (o) => {
      const target = await resolveTarget(o);
      if (target.error) return target.error;
      const archive = await store.loadArchive(target.playerId);
      if (!archive) return { status: 404, code: 'store_not_found', message: `档案 ${target.playerId} 不存在` };

      const tier = o.tier === undefined || o.tier === null ? undefined : String(o.tier);
      if (tier !== undefined && !TIERS.includes(tier)) {
        return { status: 400, code: 'bad_request', message: `非法段位 ${tier}（可选: ${TIERS.join('/')}）` };
      }
      const cap = (store.ratingConfig && Number.isInteger(store.ratingConfig.cap)) ? store.ratingConfig.cap : 3000;
      const points = o.points === undefined || o.points === null ? undefined : o.points;
      if (points !== undefined && (!Number.isInteger(points) || points < 0 || points > cap)) {
        return { status: 400, code: 'bad_request', message: `points 必须是 0..${cap} 的整数` };
      }
      const inPool = o.inPool === undefined || o.inPool === null ? undefined : o.inPool === true || o.inPool === 'true';
      if (o.inPool !== undefined && o.inPool !== null && typeof o.inPool !== 'boolean' && o.inPool !== 'true' && o.inPool !== 'false') {
        return { status: 400, code: 'bad_request', message: 'inPool 必须是布尔值' };
      }
      if (tier === undefined && points === undefined && inPool === undefined) {
        return { status: 400, code: 'bad_request', message: '至少需要一项：tier / points / inPool' };
      }

      const updated = await store.accountPatch({
        playerId: target.playerId, tier, points, inPool,
        reason: o.reason === undefined ? null : o.reason,
      });
      log.warn('store', 'store.write',
        `管理端改账号 ${updated.publicId}：tier=${updated.progress.tier} points=${updated.rating.points} inPool=${updated.pool.inPool}`, {
          op: 'accountPatch', playerId: target.playerId, publicId: updated.publicId,
          tier: updated.progress.tier, points: updated.rating.points, inPool: updated.pool.inPool, via: checkAccess(o).via,
        });
      return {
        status: 200,
        data: {
          playerId: target.playerId,
          publicId: updated.publicId,
          tier: updated.progress.tier,
          peakTier: updated.progress.peakTier,
          points: updated.rating.points,
          peakPoints: updated.rating.peakPoints,
          inPool: updated.pool.inPool,
          tierUpdatedAt: updated.progress.tierUpdatedAt === undefined ? null : updated.progress.tierUpdatedAt,
        },
      };
    });
  }

  return {
    store,
    checkToken,
    checkAccess,
    isAdminPlayer,
    rebuildIndex,
    accountPatch,
    stats,
    accounts,
    deleteAccount,
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
  adminUsersOf,
  tokenEquals,
  TOKEN_ENV,
  DEBUG_ENV,
  ADMIN_USERS_ENV,
  BOT_KEY_PREFIX,
  MAX_BOTS_PER_CALL,
  ACCOUNTS_LIMIT_DEFAULT,
  ACCOUNTS_LIMIT_MAX,
};
