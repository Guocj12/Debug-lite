'use strict';
/* server/index.js —— /api/v1 HTTP 层（P0-8 基线 + P7-4 账号 / 档案 / 快速对战接线）
 *
 * 契约（唯一权威）：
 *   · docs/interfaces.md §2（端点表）/§6（日志事件矩阵）/§7（环境与门禁契约）
 *   · docs/systems/11-account-store.md §4.4（鉴权中间件）/§4.6（安全清单）/§9.3-§9.4（回放重算与可见性）
 *     /§10（端点总表与错误码）/§11.3（帧 LRU 上限）
 *   · docs/server.md §2（环境变量）/§3（端点速查）/§4（状态语义）；decisions.md D-129…D-136
 *
 * 中间件与状态语义（P7-4）：
 *   401 unauthorized / session_expired（缺 token / token 失效 / 会话过期）
 *   403 forbidden / banned / replay_forbidden（越权 / 封禁 / 非回放参与者）
 *   404 unknown_endpoint / unknown_replay / slot_not_found
 *   409 业务拒绝（slot_limit/config_conflict/no_opponent/…）
 *   410 deprecated（DL_LEGACY_STATELESS=0）/ replay_expired（D-135：版本不匹配、快照缺失、LRU 淘汰）
 *   413 payload_too_large（>1MB 请求体）；429 rate_limited / too_many_attempts
 *   503 store_unavailable（未装配档案存储）/ admin_token_missing（DL_ADMIN_TOKEN 未配置）
 *
 * 遗留无状态端点（`/box`、`/warehouse*`、`/loadout`、`/panel`、`/ai/*`、`/battle`、`r` 型回放 id）默认保留：
 *   `DL_LEGACY_STATELESS`（默认 `1`）置 `0` → `410 deprecated`。`b_` 型归档回放不受该开关影响（按需重算，§9.3）。
 *
 * 回放注册表：进程内 LRU（默认 `store.config.replayCacheSize` = 64，D-135），淘汰 → `410 replay_expired`；
 *   归档回放（`b_…`）在帧被淘汰/从未缓存时按 journal 记录 + 快照库**按需重算**。
 *
 * 日志脱敏（§4.6/§12.2）：`api.req` / `api.res` 只记 method/path/query/publicId；绝不记 token/密码/载荷全文。
 * IO（stdout/文件）只在本层与 server/store/*：≥info 经 onRecord sink 输出。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger, parseLevel } = require('../shared/log.js');
const accountMod = require('./account.js');
const authMod = require('./auth.js');
const storeMod = require('./store/index.js');
const archiveFx = require('./store/archive.js'); // P2-5：注册时显式生成身份（publicId/playerId）供默认配置派生
const quickmatchMod = require('./quickmatch.js');
const adminMod = require('./admin.js');
const rankedMod = require('./ranked.js');
const battleApi = require('./battle.js');

const DATA_DIR = path.join(__dirname, 'data');
const ASSETS_DIR = path.join(__dirname, '..', 'assets'); // P0-9：占位美术表作为数据表经 API 提供
const VERSION = '3.0.0';

const BODY_LIMIT_BYTES = 1000000;               // §4.6 请求体上限 1MB（超限 → 413）
const DEFAULT_PORT = 3000;
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_RATE_LIMIT_PER_MINUTE = 600;      // §4.6 全局：600 次/分/token（未登录按 IP）
                                                //   分层命名（P2-4）：表内键为 `global.rateLimitPerMinute`，
                                                //   与 `auth.rateLimitPerMinute`（登录/注册失败限速，10/分/IP）**同名两义**，禁止混用
const RATE_WINDOW_MS = 60000;
const DEFAULT_REPLAY_LRU = 64;                  // §11.3/D-135 帧 LRU 上限
const EVICTED_REMEMBERED = 256;                 // 已淘汰 id 记忆（用于区分 410 与 404）
const WAREHOUSE_CACHE_MAX = 200;                // 缺陷 B：进程内仓库镜像缓存上限（与 account.js 的 MIRROR_CACHE_MAX 同口径）

/* ---------- P6/F1：前端静态托管（契约 docs/frontend/01-auth.md §9；决定 FR-4） ----------
 * 只读托管 `public/`：仅 GET、扩展名白名单、路径穿越防护，**不新增 /api/v1 端点**、不新增日志事件
 * （复用既有 api.req/api.res）。静态分支只在路由表未命中时尝试，因此 /api/v1 与全部动态路由语义不变。
 * `public/` 不存在 → 分支整体不生效（行为与改动前逐字一致）。
 */
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const STATIC_EXT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
});

/* ---------- 通用工具（P0-8 基线，行为不变） ---------- */

function tableNames() {
  const data = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5));
  const assets = fs.existsSync(ASSETS_DIR)
    ? fs.readdirSync(ASSETS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    : [];
  return [...data, ...assets].sort();
}

function loadTable(name) {
  for (const dir of [DATA_DIR, ASSETS_DIR]) {
    const file = path.join(dir, `${name}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return null;
}

function okEnvelope(data, logger) {
  return { ok: true, data, log: { level: logger.getLevel(), events: [] } };
}

// 解析 query string → 对象（unlock?tier=rare 用）
function parseQuery(url) {
  const q = (url || '').split('?')[1];
  if (!q) return {};
  const out = {};
  for (const pair of q.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const k = decodeURIComponent(pair.slice(0, eq));
    const v = decodeURIComponent(pair.slice(eq + 1));
    out[k] = v;
  }
  return out;
}

// P2-3（details 键统一）：对外**必须**含 `path`（文档承诺的字段名），同时保留 `where`（向后兼容）。
//   生产侧历史上两套键混用（account/store 用 `path`；loadout/quickmatch/unlock 用 `where`，共 22 处），
//   故在 HTTP 边界**单点归一**（不逐个改生产侧、不破坏既有断言）：缺 `path` 时由 `where` 补齐，反之亦然。
//   纯函数、无副作用：非对象条目原样透传，空数组保持 `[]`。
function normalizeDetails(details) {
  if (!Array.isArray(details)) return details;
  return details.map((d) => {
    if (!d || typeof d !== 'object') return d;
    const path = typeof d.path === 'string' && d.path !== '' ? d.path
      : (typeof d.where === 'string' && d.where !== '' ? d.where : undefined);
    if (path === undefined) return d;
    if (d.path === path && (typeof d.where === 'string' || d.where === undefined)) return d;
    return { ...d, path, where: typeof d.where === 'string' && d.where !== '' ? d.where : path };
  });
}

function errEnvelope(code, message, details) {
  return { ok: false, error: { code, message, details: normalizeDetails(details) || [] } };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
  return Buffer.byteLength(body);
}

// 静态资源响应（P6/F1；body 为 Buffer，不经 JSON 序列化）——开发期禁用缓存，避免旧资源干扰走查
function sendStatic(res, status, asset) {
  res.writeHead(status, {
    'content-type': asset.contentType,
    'content-length': asset.body.length,
    'cache-control': 'no-store',
  });
  res.end(asset.body);
  return asset.body.length;
}

// 请求体超限（P7-7 §⑩ P0：500 internal_error → 413 payload_too_large）
class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`请求体超过 1MB 上限（${limit} 字节）`);
    this.name = 'BodyTooLargeError';
    this.code = 'payload_too_large';
    this.status = 413;
    this.limit = limit;
  }
}

// 请求体读取（≤1MB **字节**；UTF-8 整段解码）。
//   ⚠️ 必须按 Buffer 累积再一次性解码：此前 `data += chunk` 会对**每个 TCP chunk 各自** toString('utf8')，
//   一个多字节字符恰好跨 chunk 边界时会被解成 U+FFFD（实测：以 3 字节字符为例，66 个切点中 10 个会损坏），
//   即"响应/请求体里的中文被静默损坏"。测试夹具同类缺陷曾造成 RP-3/RP-8 帧逐值比较的假红（见报告）。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c), 'utf8');
      bytes += buf.length;
      if (bytes > BODY_LIMIT_BYTES) {
        tooBig = true;
        reject(new BodyTooLargeError(BODY_LIMIT_BYTES));
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => { if (!tooBig) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

// POST 请求体 → 对象（解析失败返回 null；B16 ai 端点共用）
function jsonBody(ctx) {
  if (!ctx || typeof ctx.rawBody !== 'string') return null;
  try {
    return ctx.rawBody ? JSON.parse(ctx.rawBody) : {};
  } catch (e) {
    return null;
  }
}

/* ---------- P7-4 中间件辅助 ---------- */

// `Authorization: Bearer <token>` → token（其它形状 → null）
function bearerOf(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(headerValue.trim());
  return m ? m[1] : null;
}

// §4.5：playerId 只作服务端内部标识，**不返回给任何客户端**（含自己）
//   除精确键 `playerId` 外，还剔除 ranked 响应里的 `opponentPlayerId` / `opponentsDrawn`（同样是内部 id）
const REDACT_KEYS = new Set(['playerid', 'opponentplayerid', 'opponentsdrawn', 'playerids']);

function stripPlayerId(value) {
  if (Array.isArray(value)) return value.map((v) => stripPlayerId(v));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (REDACT_KEYS.has(String(k).toLowerCase())) continue;
      out[k] = stripPlayerId(v);
    }
    return out;
  }
  return value;
}

// query 值 → 整数（非法值原样透传，由业务层回 400）
function intOf(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

// 全局滑动窗口限速（§4.6：600 次/分/token；未登录按 IP）
function createRateLimiter(options) {
  const o = options || {};
  const limit = Number.isInteger(o.limit) && o.limit > 0 ? o.limit : DEFAULT_RATE_LIMIT_PER_MINUTE;
  const windowMs = Number.isInteger(o.windowMs) && o.windowMs > 0 ? o.windowMs : RATE_WINDOW_MS;
  const buckets = new Map();
  return {
    limit,
    windowMs,
    check(key, at) {
      const now = Number.isInteger(at) ? at : Date.now();
      const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
      if (hits.length >= limit) {
        buckets.set(key, hits);
        return { ok: false, retryAfterMs: Math.max(0, windowMs - (now - hits[0])) };
      }
      hits.push(now);
      buckets.set(key, hits);
      return { ok: true, remaining: limit - hits.length };
    },
    size: () => buckets.size,
  };
}

// P2-4：全局限速取值（分层命名 `global.rateLimitPerMinute`）。
//   优先级：测试接缝 `opts.rateLimitPerMinute` → `opts.config.global.rateLimitPerMinute`
//   → 存储装配后的 `store.config.global.rateLimitPerMinute` → 默认 600。
//   ⚠️ 把该键写进 `server/data/service-config.json` 需同步 `server/data/schema.js` 的
//      `SERVICE_CONFIG_FROZEN` 键集与段校验（不在本批所有权内，见交付报告）。
function globalRateLimitOf(opts, storeConfig) {
  const o = opts || {};
  if (Number.isInteger(o.rateLimitPerMinute) && o.rateLimitPerMinute > 0) return o.rateLimitPerMinute;
  const fromOpts = o.config && o.config.global ? o.config.global.rateLimitPerMinute : undefined;
  if (Number.isInteger(fromOpts) && fromOpts > 0) return fromOpts;
  const fromStore = storeConfig && storeConfig.global ? storeConfig.global.rateLimitPerMinute : undefined;
  if (Number.isInteger(fromStore) && fromStore > 0) return fromStore;
  return DEFAULT_RATE_LIMIT_PER_MINUTE;
}

// P2-1：`DL_PORT` 显式解析——**`0` = 临时端口**（与 docs/server.md §2 一致），
//   修前 `Number(env) || DEFAULT_PORT` 会把 0 吞成 3000；非法值返回 null（调用方拒绝启动）。
function resolvePort(env) {
  const raw = (env || process.env).DL_PORT;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return null;
  return n;
}

// 遗留无状态端点（DL_LEGACY_STATELESS=0 → 410 deprecated）
function isLegacyPath(urlPath) {
  if (urlPath === '/api/v1/box' || urlPath === '/api/v1/loadout' || urlPath === '/api/v1/panel' || urlPath === '/api/v1/battle') return true;
  if (urlPath.startsWith('/api/v1/warehouse')) return true;
  if (urlPath.startsWith('/api/v1/ai/')) return true;
  return false;
}

function legacyStatelessOf(opts, env) {
  const raw = opts.legacyStateless !== undefined ? opts.legacyStateless : env.DL_LEGACY_STATELESS;
  if (raw === undefined || raw === null || raw === '') return true; // §2/§7：默认 1
  if (raw === false || raw === 0 || raw === '0' || raw === 'false') return false;
  return true;
}

// 是否装配档案存储（D-129）：显式 dataDir/store/enableStore，或 DL_DATA_DIR 已设置。
// 说明：`start()` 缺省不落盘（沿用无状态基线，旧测试/冒烟零副作用）；`npm start` 走 main() 显式 enableStore。
//   `enableStore: false` = **显式否决**（即使 env 里有 DL_DATA_DIR 也不装配）——测试用"确定不落盘"的口径。
function storeWanted(opts, env) {
  if (opts.enableStore === false) return false;
  if (opts.store) return true;
  if (typeof opts.dataDir === 'string' && opts.dataDir !== '') return true;
  if (opts.enableStore === true) return true;
  if (typeof env.DL_DATA_DIR === 'string' && env.DL_DATA_DIR !== '') return true;
  return false;
}

// 环境变量读取（§2/§7）：DL_DATA_DIR / DL_STORE / DL_ADMIN_TOKEN / DL_LEGACY_STATELESS / DL_CORS_ORIGIN
// C5 修复（2026-09-19）：显式注入是**覆盖层**——未提供的键回退真实 `process.env`（空对象不再整体屏蔽，
//   否则 `start({env:{}})` 会把 store/legacyStateless/CORS 全部重置为相反值）。
function envOf(options) {
  const opts = options || {};
  const env = { ...(process.env || {}), ...(opts.env || {}) };
  if (opts.adminToken !== undefined) env.DL_ADMIN_TOKEN = opts.adminToken;
  if (opts.corsOrigin !== undefined) env.DL_CORS_ORIGIN = opts.corsOrigin;
  if (opts.legacyStateless !== undefined) env.DL_LEGACY_STATELESS = opts.legacyStateless === false ? '0' : String(opts.legacyStateless);
  return env;
}

// D-162 注入缝：`start({boxSeed})` 提供**确定性 seed 序列**——**第 n 次调用 = boxSeed + n − 1**
//   （与 `docs/interfaces.md` §7 的契约逐字一致；归一化到合法区间 1..0x7ffffffe）。
//   为什么不是"每次都用同一个 seed"：同 seed 会开出同一批物品（实测），无法验证"每次不同"的语义。
function makeBoxSeedFactory(base) {
  if (typeof base !== 'number' || !Number.isInteger(base)) return null;
  let n = 0;
  return () => {
    const seed = base + n;
    n += 1;
    return ((seed - 1) % 0x7ffffffe) + 1;
  };
}

async function createRuntime(logger, options) {
  const opts = options || {};
  const env = envOf(opts);
  const rt = {
    logger,
    env,
    legacyStateless: legacyStatelessOf(opts, env),
    corsOrigin: typeof env.DL_CORS_ORIGIN === 'string' ? env.DL_CORS_ORIGIN : '',
    // P6/F1（FR-4）：静态根。缺省 <repo>/public；start({publicDir}) 可覆盖（测试缝）
    publicDir: typeof opts.publicDir === 'string' && opts.publicDir !== '' ? path.resolve(opts.publicDir) : PUBLIC_DIR,
    store: null,
    auth: null,
    account: null,
    quick: null,
    admin: null,
    rateLimiter: createRateLimiter({ limit: globalRateLimitOf(opts, null), windowMs: opts.rateWindowMs }),
    replayLimit: Number.isInteger(opts.replayLimit) && opts.replayLimit > 0 ? opts.replayLimit : null,
    replayMeta: new Map(),   // 回放 id → { participants, frameId, kind }
    evicted: new Set(),      // 已淘汰 id（区分 410 与 404）
    ownReplays: [],          // 本实例登记的帧 id（LRU 淘汰记账）
    runBattle: typeof opts.runBattle === 'function' ? opts.runBattle : null, // 测试接缝（P2-1：排位/快速同源）
    // D-162：开箱 seed **服务端独占** —— `start({boxSeed})` 提供确定性 seed 序列（注入缝，
    //   同 `replayLimit` 的实例级覆盖风格；缺省 null → box.js 用 crypto.randomInt）
    boxSeedFactory: makeBoxSeedFactory(opts.boxSeed),
  };
  // 缺陷 B：仓库镜像解析。来源 ① account 模块镜像缓存（PUT /me/warehouse）；
  //   ② 携带 warehouse 的配置保存/注册请求（校验通过后登记，见 rememberWarehouse/路由接线）；
  //   ③ **快照自带镜像**（P1 缺口 1，2026-09-19）：配置保存时随冻结快照落盘的"装配引用子集"
  //      （server/store/archive.js warehouseExcerpt）——进程重启/进程内缓存淘汰后，已校验玩家
  //      仍能拿到足以重建面板的镜像（插件词条真实生效），不再退化为基准面板。
  //   D-130 不变：仓库正文仍由客户端权威持有；服务端只持久化**该配置引用到的那几个插件项**，永不整仓落盘。
  rt.warehouses = new Map();
  rt.rememberWarehouse = (playerId, warehouse) => {
    if (typeof playerId !== 'string' || playerId === '' || !warehouse || typeof warehouse !== 'object') return false;
    rt.warehouses.delete(playerId);
    rt.warehouses.set(playerId, warehouse);
    while (rt.warehouses.size > WAREHOUSE_CACHE_MAX) rt.warehouses.delete(rt.warehouses.keys().next().value);
    return true;
  };
  // 出战快照（正文）——loadWarehouse 的覆盖判定与第 ③ 级来源共用一次读取（默认槽）
  rt.activeSnapshotOf = async (playerId) => {
    if (!rt.store || typeof playerId !== 'string' || playerId === '') return null;
    try {
      const archive = await rt.store.loadArchive(playerId);
      const active = archive ? archiveFx.activeSlot(archive) : null;
      const hash = active && active.snapshot ? active.snapshot.hash : null;
      if (!hash) return null;
      const snap = await rt.store.snapshot.get(hash);
      if (!snap || snap.hash !== hash) return null;
      return snap;
    } catch (err) {
      logger.warn('store', 'store.snapshot.missing', `读取出战快照失败：${err && err.message ? err.message : err}`, {
        playerId, reason: 'active_snapshot_read_failed',
      });
      return null;
    }
  };
  // D1-residual：镜像来源必须**覆盖**当前出战配置的引用，否则跳过该来源并落到下一级
  //   （修前：账号级陈旧子集镜像会遮蔽快照自带镜像 → 抽池"可用"而实例化"悬挂引用"→ 409 no_opponent）。
  rt.loadWarehouse = async (playerId) => {
    if (typeof playerId !== 'string' || playerId === '') return null;
    const snap = await rt.activeSnapshotOf(playerId);
    const loadoutOfPlayer = snap && snap.loadout ? snap.loadout : null;
    const needs = loadoutOfPlayer ? rankedMod.needsWarehouse(loadoutOfPlayer) : false;
    const covers = (wh) => !needs || rankedMod.warehouseCovers(loadoutOfPlayer, wh);
    const sources = [];
    // ⓪ D-159：**服务端权威仓库（真源）** —— 仓库上云后这是首选来源；命中即用。
    if (rt.store && typeof rt.store.getWarehouse === 'function') {
      try {
        const view = await rt.store.getWarehouse(playerId);
        if (view && view.warehouse) sources.push({ name: 'archive', warehouse: view.warehouse });
      } catch (err) {
        logger.warn('store', 'store.read', `读取服务端仓库失败：${err && err.message ? err.message : err}`, {
          op: 'loadWarehouse', playerId, source: 'archive',
        });
      }
    }
    // ① account 模块镜像（PUT /me/warehouse 的显式提交；D-130 遗留路径）
    if (rt.account && typeof rt.account.getWarehouseMirror === 'function') {
      const r = await rt.account.getWarehouseMirror(playerId);
      if (r && r.ok === true && r.data && r.data.warehouse) sources.push({ name: 'account', warehouse: r.data.warehouse });
    }
    // ② 配置保存请求登记的进程内镜像
    const cached = rt.warehouses.get(playerId);
    if (cached) sources.push({ name: 'cache', warehouse: cached });
    // ③ 快照自带镜像（缺口 1 落盘载体）
    if (snap && snap.warehouse && typeof snap.warehouse === 'object') sources.push({ name: 'snapshot', warehouse: snap.warehouse });
    for (const s of sources) {
      if (covers(s.warehouse)) {
        rt.rememberWarehouse(playerId, s.warehouse);
        if (s.name === 'snapshot') {
          logger.trace('store', 'store.read', '装配引用子集取自快照（不依赖进程内镜像缓存）', {
            op: 'loadWarehouse', playerId, source: 'snapshot',
          });
        }
        return s.warehouse;
      }
      logger.warn('store', 'store.snapshot.missing', `仓库镜像不覆盖出战配置引用 → 跳过该来源（${s.name}）`, {
        playerId, reason: 'warehouse_mirror_incomplete', source: s.name,
        missing: rankedMod.warehouseMissingRefs(loadoutOfPlayer, s.warehouse).slice(0, 5),
      });
    }
    // 无覆盖来源 → null（上层按既有口径退化：已校验 → 基准面板退化；未校验 → 如实 409）
    return null;
  };
  // 出战快照自带的装配引用子集（缺口 1 的落盘载体；旧快照无该字段 → null，走既有退化路径）
  rt.snapshotWarehouseOf = async (playerId) => {
    const snap = await rt.activeSnapshotOf(playerId);
    return snap && snap.warehouse && typeof snap.warehouse === 'object' ? snap.warehouse : null;
  };
  if (storeWanted(opts, env)) {
    rt.store = await storeMod.openStore({
      dataDir: opts.dataDir,
      adapter: opts.adapter,
      configDir: opts.configDir,
      env, // C5：把已解析的 env 透传给存储层（否则 store 只读真实 process.env，注入缝失效）
      logger,
      now: opts.now,
      config: opts.config,
      ratingConfig: opts.ratingConfig,
      versions: opts.versions || { engine: VERSION },
    });
    rt.account = accountMod.createAccount({ store: rt.store, logger, now: opts.now });
    // D-159（2026-09-22）：注册默认配置改由 `account.createPlayerArchive` 内部走 **starter**
    //   （服务端权威仓库 + 已装配配置 + 三个槽 + 库内默认 AI）。
    //   原先 P2-5 在此处注入 `ranked.buildDefaultLoadout` 的那层包装**已删除**——它会用合成物品
    //   （bot_role/bot_skill1..3，不在仓库里）顶掉 starter 路径，导致"仓库空、配置满"的矛盾（R-6）。
    rt.auth = authMod.createAuth({ store: rt.store, logger, now: opts.now, account: rt.account, config: opts.authConfig });
    // F2：管理员账号白名单（DL_ADMIN_USERS，契约 docs/frontend/02-accounts.md §2.1）——唯一判定处
    rt.adminUsers = adminMod.adminUsersOf(env);
    rt.quick = quickmatchMod.createQuickMatch({
      store: rt.store, logger, now: opts.now, env, config: opts.ratingConfig, runBattle: opts.runBattle,
      loadWarehouse: (playerId) => rt.loadWarehouse(playerId),
    });
    rt.admin = adminMod.createAdmin({
      store: rt.store, logger, now: opts.now, env,
      adminUsers: rt.adminUsers,
      // 用户名 → playerId 复用 auth 的用户名索引（不在 admin 层重复实现）
      resolveUsername: (name) => (rt.auth && typeof rt.auth.usernameIndexOf === 'function' ? rt.auth.usernameIndexOf(name) : null),
    });
  }
  // 未装配存储时：管理员判定恒 false（admin 面整体不可用，既有语义不变）
  rt.isAdminPlayer = (player) => (rt.admin && typeof rt.admin.isAdminPlayer === 'function' ? rt.admin.isAdminPlayer(player) : false);
  if (rt.replayLimit === null) {
    const configured = rt.store && rt.store.config && Number.isInteger(rt.store.config.replayCacheSize)
      ? rt.store.config.replayCacheSize : 0;
    rt.replayLimit = configured > 0 ? configured : DEFAULT_REPLAY_LRU;
  }
  // P2-4：存储装配后若表/覆盖提供了全局限速值，则按同一取值函数重建限速器（测试接缝仍最高优先）
  if (rt.store) {
    const limit = globalRateLimitOf(opts, rt.store.config);
    if (limit !== rt.rateLimiter.limit) {
      rt.rateLimiter = createRateLimiter({ limit, windowMs: opts.rateWindowMs });
    }
  }
  return rt;
}

/* ---------- 路由表（P0-8 基线；P7-4 新增端点见 p74Routes） ---------- */

// 路由表：GET/POST → path → handler(ctx) → {status, payload}
// handler 抛异常 → api.err + 500 internal_error（AP-6）
// P7-4 形状扩展：`{ auth: true, handler }` = 需 Bearer 鉴权；`{ admin: true }` = 需管理员身份
//   （F2 起：**管理员账号（DL_ADMIN_USERS）或 DL_ADMIN_TOKEN 二者之一**，见 docs/frontend/02-accounts.md §2.2）
function createHandler(logger, extraRoutes, runtime) {
  const rt = runtime;
  const routes = {
    GET: {
      '/api/v1/health': () => ({ status: 200, payload: okEnvelope({ status: 'ok', version: VERSION }, logger) }),
      '/api/v1/log-level': () => ({ status: 200, payload: okEnvelope({ level: logger.getLevel() }, logger) }),
      '/api/v1/unlock': (ctx) => {
        // 该段位可用节点/模板/技能（B4 接入；未知段位 → 400 bad_tier）
        const unlockApi = require('./core/unlock.js');
        const tier = ctx.query ? ctx.query.tier : null;
        if (tier === null || unlockApi.tierIndex(tier) === null) {
          return { status: 400, payload: errEnvelope('bad_tier', `非法段位 ${tier || '(缺省)'}（可选: common/rare/epic/legendary/mythic）`) };
        }
        const roles = require('./data/role-templates.json').roleTemplates;
        const skills = require('./data/skill-templates.json').skillTemplates;
        const plugins = require('./data/plugins.json').plugins;
        return {
          status: 200,
          payload: okEnvelope({
            tier,
            nodes: unlockApi.availableNodes(tier),
            roleTemplates: unlockApi.filterByTier(roles, tier).map((x) => x.id),
            skills: unlockApi.filterByTier(skills, tier).map((x) => x.id),
            plugins: unlockApi.filterByTier(plugins, tier).map((x) => x.id),
          }, logger),
        };
      },
      '/api/v1/warehouse': () => {
        // B18：仓库规范骨架（分桶键 + 装配状态语义；D-123 不持久化，客户端状态为权威）
        const itemsApi = require('./core/items.js');
        return { status: 200, payload: okEnvelope(itemsApi.emptyWarehouse(), logger) };
      },
      '/api/v1/loadout': () => {
        // B19：出战配置规范骨架（D-123 不持久化；客户端 loadout 为权威，POST 校验回带）
        const loadoutApi = require('./loadout.js');
        return { status: 200, payload: okEnvelope({ loadout: loadoutApi.EMPTY_LOADOUT }, logger) };
      },
    },
    POST: {
      '/api/v1/log-level': async (ctx) => {
        let body;
        try {
          body = JSON.parse(ctx.rawBody || '{}');
        } catch (e) {
          return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        }
        // 先全量校验、后应用（失败不产生任何部分生效，P0-8 审查 P2-a）
        const { parseLevel } = require('../shared/log.js');
        let levelSet = null;
        if (body.level !== undefined) {
          if (parseLevel(String(body.level)) === null) {
            return { status: 400, payload: errEnvelope('bad_level', `非法级别 ${body.level}`) };
          }
          levelSet = body.level;
        }
        const channelSets = [];
        if (body.channels !== undefined) {
          if (body.channels === null || typeof body.channels !== 'object' || Array.isArray(body.channels)) {
            return { status: 400, payload: errEnvelope('bad_level', 'channels 必须是 {channel: level} 对象') };
          }
          for (const [ch, lv] of Object.entries(body.channels)) {
            if (parseLevel(String(lv)) === null) {
              return { status: 400, payload: errEnvelope('bad_level', `非法通道级别 ${ch}=${lv}`) };
            }
            channelSets.push([ch, lv]);
          }
        }
        if (levelSet !== null) logger.setLevel(levelSet);
        for (const [ch, lv] of channelSets) logger.setChannelLevel(ch, lv);
        return { status: 200, payload: okEnvelope({ level: logger.getLevel() }, logger) };
      },
      '/api/v1/ai/validate': async (ctx) => {
        // B16：静态校验 + 合法性 + 段位门控；错误带节点路径（interfaces §2/T-AP-1/2）
        const astApi = require('./ai/ast.js');
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        const program = body.program || body.ai;
        if (!program || typeof program !== 'object') {
          return { status: 400, payload: errEnvelope('bad_ai', '缺少 program（AI 程序对象）') };
        }
        const tier = body.tier === undefined ? 'common' : String(body.tier);
        const unlockApi = require('./core/unlock.js');
        if (unlockApi.tierIndex(tier) === null) {
          return { status: 400, payload: errEnvelope('bad_tier', `非法段位 ${tier}（可选: common/rare/epic/legendary/mythic）`) };
        }
        const v = astApi.validate(program, tier);
        if (!v.ok) {
          // 信封主码固定 ai_invalid（interfaces §2 行），每条错误的具体 code/path 在 details
          return { status: 400, payload: errEnvelope('ai_invalid', 'AI 程序不合法', v.errors) };
        }
        // B26：warnings 通道回带（非阻断提示，如"动作名不在引擎词汇表"；D-80 保持运行期归一化）。
        //   防御：并行任务尚未在 ast.validate 落地 warnings 时字段缺席 → || []，接口不崩。
        return { status: 200, payload: okEnvelope({ ok: true, warnings: Array.isArray(v.warnings) ? v.warnings : [] }, logger) };
      },
      '/api/v1/ai/compile': async (ctx) => {
        // B16：规范化 + programHash + 统计（结构校验；不查合法性/门控）
        const runner = require('./runner.js');
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        const program = body.program || body.ai;
        if (!program || typeof program !== 'object') {
          return { status: 400, payload: errEnvelope('bad_ai', '缺少 program（AI 程序对象）') };
        }
        const r = runner.compileAi(program, logger);
        if (r.status !== 200) return { status: r.status, payload: errEnvelope(r.code, 'AI 程序不可编译', r.details) };
        return { status: 200, payload: okEnvelope(r.data, logger) };
      },
      '/api/v1/ai/battle': {
        // B16：给定 AI 跑一场（服务端重新执行，T-AP-4；seed 显式化回带，T-AP-5）
        // P1-3：对象路由 = 让管线解析 Bearer 身份（tolerant：无/坏 token 按匿名）→ 可选用调用方**真实档案**
        //        的出战配置作为 p1 技能槽来源（`store:false` 保证无档案存储时该端点照旧可用）。
        store: false,
        tolerant: true,
        handler: async (ctx) => {
          const runner = require('./runner.js');
          const body = jsonBody(ctx);
          if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
          const program = body.program || body.ai;
          if (!program || typeof program !== 'object') {
            return { status: 400, payload: errEnvelope('bad_ai', '缺少 program（AI 程序对象）') };
          }
          const seed = body.seed;
          // P1-3：技能槽来源优先级 = 显式 `skills`/`loadout` → 调用方档案出战配置（带有效 token + 已装配存储）
          //   → baseline（缺省，黄金语义不变）。档案配置不可实例化时**回落 baseline 并记 warn**（不静默改语义）。
          let skills = body.skills;
          let loadout = body.loadout;
          let warehouse = body.warehouse;
          let loadoutSource = null;
          if (skills === undefined && loadout === undefined && ctx.player && rt.store) {
            const own = await ownLoadoutOf(ctx.player.playerId);
            if (own) {
              loadout = own.loadout;
              warehouse = own.warehouse;
              loadoutSource = 'archive';
            } else {
              logger.warn('api', 'api.reject', 'ai/battle: 档案出战配置不可用 → 回落 baseline 技能槽', {
                path: '/api/v1/ai/battle', publicId: ctx.player.publicId, reason: 'archive_loadout_missing',
              });
            }
          }
          const callRunner = (extra) => runner.runAiBattle({
            program,
            seed,
            tier: body.tier === undefined ? 'mythic' : String(body.tier),
            opponent: body.opponent === undefined ? 'kiter' : String(body.opponent),
            skills: extra.skills, loadout: extra.loadout, warehouse: extra.warehouse, loadoutSource: extra.loadoutSource,
            logger,
          });
          let r = callRunner({ skills, loadout, warehouse, loadoutSource });
          if (r.status === 409 && loadoutSource === 'archive') {
            // 档案配置读到了但不可实例化（缺镜像/门控）→ 如实记 warn 后回落 baseline（端点不因档案而 409）
            logger.warn('api', 'api.reject', 'ai/battle: 档案出战配置不可实例化 → 回落 baseline 技能槽', {
              path: '/api/v1/ai/battle', publicId: ctx.player.publicId, reason: 'archive_loadout_unusable',
            });
            r = callRunner({});
          }
          if (r.status !== 200) {
            return { status: r.status, payload: errEnvelope(r.code, r.code === 'unknown_opponent' ? '未知对手' : 'AI 战斗无法执行', r.details) };
          }
          return { status: 200, payload: okEnvelope(r.data, logger) };
        },
      },
      '/api/v1/box': async (ctx) => {
        // B17（**遗留无状态路径**）：开箱 —— D-162 起 HTTP 层**不接受客户端 seed**（接口没有该字段），
        //   随机性由服务端生成（`start({boxSeed})` 为测试/e2e 提供确定性序列）。
        //   本路径**不入档**（物品不写服务端仓库）；服务端权威开箱见 `POST /api/v1/me/box`。
        const boxApi = require('./box.js');
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        const r = boxApi.openBoxes({ tier: body.tier, times: body.times, logger, seedFactory: rt.boxSeedFactory });
        if (r.status !== 200) {
          return { status: r.status, payload: errEnvelope(r.code, r.message || '开箱请求被拒绝') };
        }
        return { status: 200, payload: okEnvelope(r.data, logger) };
      },
      '/api/v1/warehouse/assemble': async (ctx) => {
        // B18：装配（I-10 四道校验 + T-PB-8 唯一性；原子性：失败状态完全不变；日志经 withLogger 接线）
        const itemsApi = require('./core/items.js').withLogger(logger);
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        if (!body.warehouse || typeof body.warehouse !== 'object' ||
            typeof body.targetUid !== 'string' || typeof body.pluginUid !== 'string' ||
            !Number.isInteger(body.slotIndex) || body.slotIndex < 0) {
          return { status: 400, payload: errEnvelope('bad_request', '需要 warehouse 对象 + targetUid/pluginUid 字符串 + slotIndex 非负整数') };
        }
        const r = itemsApi.assemble(body.warehouse, { targetUid: body.targetUid, pluginUid: body.pluginUid, slotIndex: body.slotIndex, tier: body.tier });
        if (!r.ok) return { status: 409, payload: errEnvelope(r.code, r.message) };
        return { status: 200, payload: okEnvelope({ warehouse: r.warehouse }, logger) };
      },
      '/api/v1/warehouse/disassemble': async (ctx) => {
        // B18：拆卸（I-11；空槽 404 slot_empty；悬挂引用 404 plugin_missing）
        const itemsApi = require('./core/items.js').withLogger(logger);
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        if (!body.warehouse || typeof body.warehouse !== 'object' ||
            typeof body.targetUid !== 'string' || !Number.isInteger(body.slotIndex) || body.slotIndex < 0) {
          return { status: 400, payload: errEnvelope('bad_request', '需要 warehouse 对象 + targetUid 字符串 + slotIndex 非负整数') };
        }
        const r = itemsApi.disassemble(body.warehouse, { targetUid: body.targetUid, slotIndex: body.slotIndex });
        if (!r.ok) return { status: 404, payload: errEnvelope(r.code, r.message) };
        return { status: 200, payload: okEnvelope({ warehouse: r.warehouse }, logger) };
      },
      '/api/v1/loadout': async (ctx) => {
        // B19：出战配置校验（I-12 全案 + T-PB-9 引用完整性 + I-12e 门控）；无持久化回带
        const loadoutApi = require('./loadout.js');
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        if (!body.loadout || typeof body.loadout !== 'object') {
          return { status: 400, payload: errEnvelope('bad_request', '需要 loadout 对象') };
        }
        const tier = body.tier === undefined ? 'mythic' : String(body.tier);
        const unlockApi = require('./core/unlock.js');
        if (unlockApi.tierIndex(tier) === null) {
          return { status: 400, payload: errEnvelope('bad_tier', `非法段位 ${tier}（可选: common/rare/epic/legendary/mythic）`) };
        }
        const v = loadoutApi.validateLoadout(body.loadout, { warehouse: body.warehouse, tier });
        if (!v.ok) {
          logger.warn('api', 'api.reject', `loadout_invalid: ${v.errors.length} 条`, { path: '/api/v1/loadout', count: v.errors.length, errors: v.errors.slice(0, 5) });
          return { status: 409, payload: errEnvelope('loadout_invalid', '出战配置不合法', v.errors) };
        }
        return { status: 200, payload: okEnvelope({ loadout: body.loadout }, logger) };
      },
      '/api/v1/panel': async (ctx) => {
        // B19：最终面板（五维/regen/special/技能参数；loadout 校验同 /loadout）
        const loadoutApi = require('./loadout.js');
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        if (!body.loadout || typeof body.loadout !== 'object') {
          return { status: 400, payload: errEnvelope('bad_request', '需要 loadout 对象') };
        }
        const tier = body.tier === undefined ? 'mythic' : String(body.tier);
        const unlockApi = require('./core/unlock.js');
        if (unlockApi.tierIndex(tier) === null) {
          return { status: 400, payload: errEnvelope('bad_tier', `非法段位 ${tier}（可选: common/rare/epic/legendary/mythic）`) };
        }
        const p = loadoutApi.buildPanel(body.loadout, { warehouse: body.warehouse, tier });
        if (!p.ok) {
          logger.warn('api', 'api.reject', `loadout_invalid: ${p.errors.length} 条`, { path: '/api/v1/panel', count: p.errors.length, errors: p.errors.slice(0, 5) });
          return { status: 409, payload: errEnvelope('loadout_invalid', '出战配置不合法', p.errors) };
        }
        return { status: 200, payload: okEnvelope({ panel: p.panel }, logger) };
      },
      '/api/v1/battle': {
        // `store:false`：无档案存储时仍必须可走遗留路径（既有 tests/api/api-battle.test.js 依赖）；
        // `tolerant:true`：无 token / 无效 token 一律按匿名处理（旧语义未读 Authorization）。
        // P1-2：改为对象路由只为让管线解析 Bearer 身份 → 登记"调用方所在 side"供 `GET /replay/r*` 裁剪
        //        （无 token 时 participants=[] → 读取端退化为"不含 aiTrace 的帧"，绝不返回双方轨迹）。
        store: false,
        tolerant: true,
        handler: async (ctx) => {
          // B22：双方 loadout + AI + seed → 完整回放帧（服务端重执行；回放注册表进程内，D-123 不落盘）
          const body = jsonBody(ctx);
          if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
          const tier = body.tier === undefined ? 'mythic' : String(body.tier);
          const unlockApi = require('./core/unlock.js');
          if (unlockApi.tierIndex(tier) === null) {
            return { status: 400, payload: errEnvelope('bad_tier', `非法段位 ${tier}（可选: common/rare/epic/legendary/mythic）`) };
          }
          // P1-2：调用方声明自己占哪一侧（缺省 p1 = 自己的配置）；未知值 → 400（不静默按 p1）
          const side = body.side === undefined || body.side === null ? 'p1' : String(body.side);
          if (side !== 'p1' && side !== 'p2') {
            return { status: 400, payload: errEnvelope('bad_request', `非法 side=${side}（可选: p1/p2）`) };
          }
          const r = battleApi.runBattle({ p1: body.p1, p2: body.p2, warehouse: body.warehouse, seed: body.seed, tier });
          if (r.status !== 200) {
            if (r.code === 'loadout_invalid') {
              return { status: 409, payload: errEnvelope(r.code, r.message, r.details) };
            }
            return { status: r.status, payload: errEnvelope(r.code, r.message) };
          }
          // P7-4 + P1-2：登记进有上限 LRU，并登记参与者（持 token = 调用方 playerId；匿名 = 无参与者）
          const playerId = ctx.player ? ctx.player.playerId : null;
          registerReplay({
            id: r.data.id, frameId: r.data.id, kind: 'legacy',
            participants: playerId ? [playerId] : [],
            sides: playerId ? { [side]: playerId, [side === 'p1' ? 'p2' : 'p1']: null } : null,
          });
          return { status: 200, payload: okEnvelope(r.data, logger) };
        },
      },
      // 双轨端点（P7-4）：有 Bearer token → 档案驱动；无 token → 遗留无状态口径（DL_LEGACY_STATELESS=1）
      // `store:false`：无档案存储时仍必须可走遗留路径（既有 tests/api/api-ranked.test.js 依赖）
      '/api/v1/ranked/run': {
        store: false,
        redact: true,
        handler: async (ctx) => {
          if (ctx.player) return rankedRunArchive(ctx);
          if (!rt.legacyStateless) return failStatus(401, 'unauthorized', '缺少会话 token（DL_LEGACY_STATELESS=0 时排位为鉴权端点）');
          return rankedRunLegacy(ctx);
        },
      },
      '/api/v1/ranked/promote': {
        store: false,
        redact: true,
        handler: async (ctx) => {
          if (ctx.player) return rankedPromoteArchive(ctx);
          if (!rt.legacyStateless) return failStatus(401, 'unauthorized', '缺少会话 token（DL_LEGACY_STATELESS=0 时晋升为鉴权端点）');
          return rankedPromoteLegacy(ctx);
        },
      },
    },
    PUT: {},
    DELETE: {},
  };
  if (extraRoutes) {
    for (const method of Object.keys(extraRoutes)) {
      routes[method] = { ...(routes[method] || {}), ...extraRoutes[method] };
    }
  }

  /* ---------- P7-4 新端点（§10.1） ---------- */

  // 模块结果信封 → HTTP（auth/account 用 {ok,status,code,data}；quickmatch/ranked/admin 用 {status,data|code}）
  function respond(res) {
    if (res && (res.ok === true || (res.ok === undefined && res.status === 200))) {
      return { status: 200, payload: okEnvelope(res.data === undefined ? null : res.data, logger) };
    }
    const code = (res && res.code) || 'internal_error';
    const status = Number.isInteger(res && res.status) ? res.status : accountMod.statusOf(code);
    return { status, payload: errEnvelope(code, (res && res.message) || code, (res && res.details) || []) };
  }

  function failStatus(status, code, message) {
    return { status, payload: errEnvelope(code, message) };
  }

  function deprecated(what) {
    return failStatus(410, 'deprecated', `${what} 为遗留无状态端点，已由 DL_LEGACY_STATELESS=0 关闭`);
  }

  // 请求体（空体 → {}；坏 JSON → null，由调用方回 400 bad_json）
  function bodyOf(ctx) {
    return jsonBody(ctx);
  }

  /* ----- 认证（§4.4） ----- */

  async function authenticate(token) {
    if (!rt.store || !rt.auth) return { ok: false, status: 503, code: 'store_unavailable', message: '服务未装配档案存储' };
    const tokenHash = authMod.tokenHashOf(token);
    const peek = rt.store.sessions.peek(tokenHash); // 只读探针：区分"不存在"与"刚过期"
    if (peek && Number.isInteger(peek.expiresAt) && peek.expiresAt <= Date.now()) {
      logger.warn('store', 'store.auth.reject', '会话已过期', { op: 'authenticate', reason: 'session_expired' });
      return { ok: false, status: 401, code: 'session_expired', message: '会话已过期，请重新登录' };
    }
    const res = await rt.auth.authenticate(token);
    if (!res.ok) {
      return { ok: false, status: Number.isInteger(res.status) ? res.status : accountMod.statusOf(res.code), code: res.code, message: res.message };
    }
    return { ok: true, player: res.data.player, data: res.data };
  }

  /* ----- 回放（§9.3/§9.4/D-135） ----- */

  function rememberEvicted(id) {
    rt.evicted.add(id);
    while (rt.evicted.size > EVICTED_REMEMBERED) {
      const first = rt.evicted.values().next().value;
      rt.evicted.delete(first);
    }
  }

  // 本实例登记的帧按 LRU 上限淘汰（battle.REPLAYS 是模块级注册表：淘汰只针对本实例创建的帧，
  // 生产为单实例 → 等价于全局上限 64；测试同进程多实例时互不干扰）
  function pruneReplays() {
    while (rt.ownReplays.length > rt.replayLimit) {
      const id = rt.ownReplays.shift();
      battleApi.REPLAYS.delete(id);
      rememberEvicted(id);
      for (const meta of rt.replayMeta.values()) if (meta.frameId === id) meta.frameId = null;
    }
  }

  function registerReplay(entry) {
    // 遗留 `r<seq>` 回放不需要元数据（参与者恒为"无"）；归档回放只缓存 frameId（未命中则按需重算）。
    // 元数据表同样有上限：超过 EVICTED_REMEMBERED 条按插入序淘汰最旧（缺失只影响缓存命中，不影响正确性）。
    if (Array.isArray(entry.participants)) {
      rt.replayMeta.set(entry.id, {
        id: entry.id, frameId: entry.frameId, participants: entry.participants, kind: entry.kind,
        sides: entry.sides === undefined ? null : entry.sides, // P1-1：请求者 side（aiTrace 裁剪用）
        createdAt: Date.now(),
      });
      while (rt.replayMeta.size > EVICTED_REMEMBERED) {
        const oldest = rt.replayMeta.keys().next().value;
        rt.replayMeta.delete(oldest);
      }
    }
    if (entry.frameId) {
      rt.ownReplays.push(entry.frameId);
      pruneReplays();
    }
  }

  function sliceReplay(data, from, to) {
    const frames = Array.isArray(data.frames) ? data.frames : [];
    const lo = Number.isInteger(from) && from >= 1 ? from : 1;
    const hi = Number.isInteger(to) && to >= lo ? Math.min(to, frames.length) : frames.length;
    return { ...data, frames: frames.slice(lo - 1, hi) };
  }

  // P1-3：调用方**真实档案**的出战配置（activeSlot 快照正文 + 该配置自带的装配引用子集）。
  // 任一环节缺失/读取失败 → null（调用方回落 baseline，不阻断端点）。
  async function ownLoadoutOf(playerId) {
    if (!rt.store || typeof playerId !== 'string' || playerId === '') return null;
    try {
      const archive = await rt.store.loadArchive(playerId);
      const active = archive ? archiveFx.activeSlot(archive) : null;
      const hash = active && active.snapshot ? active.snapshot.hash : null;
      if (!hash) return null;
      const snap = await rt.store.snapshot.get(hash);
      if (!snap || snap.hash !== hash || !snap.loadout) return null;
      // D-159：服务端权威仓库优先（真源、始终最新）；快照自带的装配引用子集仅作兜底
      const warehouse = (await rt.loadWarehouse(playerId)) || snap.warehouse || null;
      return { loadout: snap.loadout, warehouse };
    } catch (err) {
      logger.warn('store', 'store.snapshot.missing', `读取调用方出战配置失败：${err && err.message ? err.message : err}`, {
        playerId, reason: 'own_loadout_read_failed',
      });
      return null;
    }
  }

  /* ----- 回放 aiTrace 裁剪（P1-1 / §9.4；P1-2 扩展到遗留 `r<seq>`） -----
   * §9.4：`aiTrace` **默认只返回请求方自己一侧**的（避免把对手 AI 的逐步决策喂给玩家）；
   *       `?trace=all` 仅管理员令牌通过时放行；未知 trace 值 → 400 bad_request。
   * 两条归档路径（进程内帧缓存命中 / 按 journal + 快照重算）都必须裁剪；`?trace=self` 是默认值。
   * **P1-2（2026-09-19）**：遗留 `r<seq>` 回放同样登记"调用方所在 side"（`POST /battle` 的 Bearer 身份
   *   + 可选 `body.side`，缺省 `p1`），因此 `GET /replay/r*` 也按 side 裁剪；**调用方无法判定时**（匿名
   *   遗留调用）退化为"返回帧但**剥掉全部 aiTrace**"，并记 `api.replay.trace_denied`(warn)——绝不返回双方轨迹。
   */
  function parseTraceMode(query) {
    const raw = query && query.trace !== undefined && query.trace !== null ? String(query.trace) : 'self';
    if (raw === 'self' || raw === 'all') return { mode: raw };
    return { mode: null, error: failStatus(400, 'bad_request', `非法 trace=${raw}（可选: self/all）`) };
  }

  function traceAllAllowed(ctx) {
    if (!rt.admin || typeof rt.admin.checkToken !== 'function') {
      return { ok: false, status: 503, code: 'admin_token_missing', message: '管理端未装配，trace=all 不可用' };
    }
    const auth = rt.admin.checkToken(ctx.adminToken);
    if (auth.ok) return { ok: true };
    logger.warn('api', 'api.reject', `trace=all 被拒：${auth.code}`, {
      path: ctx.urlPath, publicId: ctx.player ? ctx.player.publicId : null, code: auth.code,
    });
    return auth;
  }

  // participants = [p1PlayerId, p2PlayerId]（任一可为 undefined/null）→ 请求者的 side
  function sideOfPlayer(participants, playerId) {
    if (!Array.isArray(participants) || typeof playerId !== 'string') return null;
    if (participants[0] === playerId) return 'p1';
    if (participants[1] === playerId) return 'p2';
    return null;
  }

  function applyTrace(data, side, mode) {
    if (mode === 'all') return data;
    // side === null（调用方 side 不可判定）→ **剥离全部 aiTrace**（P1-2：不得返回双方轨迹）
    const frames = (Array.isArray(data.frames) ? data.frames : []).map((f) => {
      const diff = f && f.diff;
      if (!diff || !Array.isArray(diff.aiTrace)) return f;
      const kept = side === null ? [] : diff.aiTrace.filter((t) => t && t.owner === side);
      return { ...f, diff: { ...diff, aiTrace: kept } };
    });
    return { ...data, frames };
  }

  // GET /api/v1/replay/:id（`r<seq>` = 遗留无状态注册表；`b_…` = 归档记录 → 参与者鉴权 + 按需重算）
  async function serveReplay(ctx, id, query) {
    const from = intOf(query.from);
    const to = intOf(query.to);
    const parsedTrace = parseTraceMode(query);
    if (parsedTrace.error) return parsedTrace.error;
    const traceMode = parsedTrace.mode;
    if (traceMode === 'all') {
      const gate = traceAllAllowed(ctx);
      if (!gate.ok) return failStatus(gate.status, gate.code, gate.message);
    }
    if (/^r\d+$/.test(id)) {
      if (!rt.legacyStateless) return deprecated(`GET /api/v1/replay/${id}`);
      const r = battleApi.getReplay(id, from, to);
      if (r.status === 200) {
        // P1-2：遗留回放同样做参与者鉴权 + 按 side 裁剪（见 legacyReplayEntry 的登记口径）
        const meta = rt.replayMeta.get(id);
        const participants = meta && Array.isArray(meta.participants) ? meta.participants : [];
        let side = null;
        if (ctx.player && participants.includes(ctx.player.playerId)) {
          side = sideOfPlayer(meta && meta.sides ? [meta.sides.p1, meta.sides.p2] : null, ctx.player.playerId);
        } else if (ctx.player && participants.length > 0) {
          logger.warn('api', 'api.reject', 'replay_forbidden: 非参与者请求遗留回放', {
            path: `/api/v1/replay/${id}`, publicId: ctx.player.publicId, code: 'replay_forbidden',
          });
          return failStatus(403, 'replay_forbidden', '只能查看自己参与的对局回放');
        } else if (participants.length > 0 || traceMode === 'self') {
          // 匿名/无效 token：无法判定调用方 side → 只返回**不含 aiTrace** 的帧（明确 warn，不静默）
          logger.warn('api', 'api.replay.trace_denied',
            `遗留回放 ${id} aiTrace 已剥离（请求方 side 不可判定：匿名或非参与者身份）`, {
              path: `/api/v1/replay/${id}`, replayId: id, kind: 'legacy',
              reason: ctx.player ? 'not_participant' : 'anonymous', participants: participants.length,
            });
        }
        return { status: 200, payload: okEnvelope(applyTrace(r.data, side, traceMode), logger) };
      }
      if (rt.evicted.has(id)) {
        logger.warn('store', 'store.snapshot.missing', `回放 ${id} 已从帧缓存淘汰（LRU ${rt.replayLimit}）`, { replayId: id, reason: 'evicted', limit: rt.replayLimit });
        return failStatus(410, 'replay_expired', `回放 ${id} 已过期（帧缓存淘汰，上限 ${rt.replayLimit} 场）`);
      }
      return { status: r.status, payload: errEnvelope(r.code, r.message) };
    }
    // 归档回放：必须登录（§9.4）
    if (!ctx.player) return failStatus(401, 'unauthorized', '回放需要登录（参与者鉴权，D-135）');
    const playerId = ctx.player.playerId;
    const meta = rt.replayMeta.get(id);
    if (meta && Array.isArray(meta.participants)) {
      if (!meta.participants.includes(playerId)) {
        logger.warn('api', 'api.reject', 'replay_forbidden: 非参与者请求回放', { path: `/api/v1/replay/${id}`, publicId: ctx.player.publicId, code: 'replay_forbidden' });
        return failStatus(403, 'replay_forbidden', '只能查看自己参与的对局回放');
      }
      // 缓存路径同样裁剪 aiTrace（P1-1）；侧别不可知时落到重算路径（那边可从 journal 记录定位 side）
      const cachedSide = sideOfPlayer(meta.sides && [meta.sides.p1, meta.sides.p2], playerId);
      if (meta.frameId && (cachedSide !== null || traceMode === 'all')) {
        const cached = battleApi.getReplay(meta.frameId, from, to);
        if (cached.status === 200) {
          return { status: 200, payload: okEnvelope(applyTrace({ ...cached.data, id }, cachedSide, traceMode), logger) };
        }
      }
    }
    if (!rt.store) return failStatus(404, 'unknown_replay', `未知回放 ${id}`);
    const record = await rt.store.findBattleRecord(id);
    if (!record) return failStatus(404, 'unknown_replay', `未知回放 ${id}`);
    const participants = [record.p1 && record.p1.playerId, record.p2 && record.p2.playerId].filter((x) => typeof x === 'string');
    if (!participants.includes(playerId)) {
      logger.warn('api', 'api.reject', 'replay_forbidden: 非参与者请求归档回放', { path: `/api/v1/replay/${id}`, publicId: ctx.player.publicId, code: 'replay_forbidden' });
      return failStatus(403, 'replay_forbidden', '只能查看自己参与的对局回放');
    }
    // 版本门槛（§9.3：宁可 replay_expired，也不返回"看起来对但实际不同"的帧）
    const versions = record.versions || {};
    if (versions.engine !== rt.store.versions.engine) {
      return failStatus(410, 'replay_expired', `回放过期：引擎版本 ${versions.engine} ≠ ${rt.store.versions.engine}（engine_mismatch）`);
    }
    if (versions.data !== rt.store.versions.data) {
      return failStatus(410, 'replay_expired', `回放过期：数据版本 ${versions.data} ≠ ${rt.store.versions.data}（data_mismatch）`);
    }
    const snap1 = record.p1 && record.p1.snapshotHash ? await rt.store.snapshot.get(record.p1.snapshotHash) : null;
    const snap2 = record.p2 && record.p2.snapshotHash ? await rt.store.snapshot.get(record.p2.snapshotHash) : null;
    // 内容寻址复核（同 ranked.loadSnapshotOf 口径）：正文 hash 与引用不符 → 视为缺失，绝不拿别的正文顶替
    if (!snap1 || snap1.hash !== record.p1.snapshotHash || !snap2 || snap2.hash !== record.p2.snapshotHash) {
      logger.warn('store', 'store.snapshot.missing', `回放 ${id} 依赖的快照缺失/不一致（GC/人为篡改）`, { replayId: id, reason: 'snapshot_gc' });
      return failStatus(410, 'replay_expired', `回放过期：快照已不可用（snapshot_gc）`);
    }
    const tier = (record.p1 && record.p1.tierBefore) || 'common';
    // 缺口 2 / D-159：归档回放重算必须**逐侧**给出仓库镜像——含装配引用的一侧若拿不到镜像，
    //   buildPlayer → buildPanel 会报 missing_warehouse，本端点只能如实 410（replay_expired）。
    //   **来源优先级（D-159 起）**：① 服务端权威仓库（`rt.loadWarehouse`，真源、始终最新；
    //   配置保存不再要求客户端提交镜像 → 快照里可能没有子集）→ ② 快照自带的装配引用子集（旧数据兜底）。
    //   修前只取 ②，会导致"不带 warehouse 保存的配置"所打的对局**回放永久 410**。
    const p1Wh = (await rt.loadWarehouse(record.p1.playerId)) || snap1.warehouse || null;
    const p2Wh = (await rt.loadWarehouse(record.p2.playerId)) || snap2.warehouse || null;
    const r = battleApi.runBattle({
      p1: snap1.loadout, p2: snap2.loadout, seed: record.seed, tier,
      p1Warehouse: p1Wh,
      p2Warehouse: p2Wh,
    });
    if (r.status !== 200) return failStatus(410, 'replay_expired', `回放过期：快照无法实例化（${r.code}）`);
    registerReplay({
      id, frameId: r.data.id, participants, kind: 'archive',
      sides: { p1: record.p1 && record.p1.playerId, p2: record.p2 && record.p2.playerId },
    });
    logger.debug('store', 'store.read', `回放 ${id} 按需重算（${r.data.frames.length} 帧）`, { replayId: id, frames: r.data.frames.length, kind: 'archive' });
    const side = record.p1 && record.p1.playerId === playerId ? 'p1' : 'p2';
    return { status: 200, payload: okEnvelope(applyTrace({ ...sliceReplay(r.data, from, to), id }, side, traceMode), logger) };
  }

  /* ----- 排位/快速对战（P7-3 档案驱动 + P5 遗留口径） ----- */

  // P2-1：排位路径必须与 quick/admin 同源注入 `env`（`DL_DEBUG_BOTS` 门控）与 `runBattle` 测试接缝、
  //   以及 `ratingConfig`（P2-3 晋升阈值单一真源）——旧接线只传 logger → 同一 `DL_DEBUG_BOTS=1` 下
  //   `quick.match debug=true` 而 `ranked.pool debug=false`（同一开关两种行为）。
  function rankedDeps() {
    return {
      env: rt.env,
      runBattle: typeof rt.runBattle === 'function' ? rt.runBattle : undefined,
      ratingConfig: rt.store ? rt.store.ratingConfig : undefined,
      loadWarehouse: (playerId) => rt.loadWarehouse(playerId), // 缺陷 B
    };
  }

  async function rankedRunArchive(ctx) {
    const body = bodyOf(ctx);
    if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
    // `pool` 原样透传给业务层 → 400 pool_forbidden（服务端抽池，D-136 不接受客户端自选对手）
    return respond(await rankedMod.withLogger(logger, rankedDeps()).runRankedBattle({
      store: rt.store, playerId: ctx.player.playerId, seed: body.seed, pool: body.pool,
    }));
  }

  function rankedRunLegacy(ctx) {
    const body = bodyOf(ctx);
    if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
    const tier = body.tier === undefined ? 'mythic' : String(body.tier);
    const unlockApi = require('./core/unlock.js');
    if (unlockApi.tierIndex(tier) === null) {
      return failStatus(400, 'bad_tier', `非法段位 ${tier}（可选: common/rare/epic/legendary/mythic）`);
    }
    const r = rankedMod.withLogger(logger, rankedDeps()).runRankedBattle({ loadout: body.loadout, warehouse: body.warehouse, pool: body.pool, seed: body.seed, tier });
    if (r.status !== 200) {
      if (r.code === 'loadout_invalid') return { status: 409, payload: errEnvelope(r.code, r.message, r.details) };
      return { status: r.status, payload: errEnvelope(r.code, r.message) };
    }
    return { status: 200, payload: okEnvelope(r.data, logger) };
  }

  // 有 token：段位以**档案**为准（§10.1）；不一致 → 403（越权/伪造段位）
  async function rankedPromoteArchive(ctx) {
    const body = bodyOf(ctx);
    if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
    const archive = await rt.store.loadArchive(ctx.player.playerId);
    if (!archive) return failStatus(404, 'store_not_found', '档案不存在');
    const tier = archive.progress.tier;
    if (body.tier !== undefined && body.tier !== tier) {
      logger.warn('api', 'api.reject', 'forbidden: tier 与档案不一致', { path: '/api/v1/ranked/promote', publicId: ctx.player.publicId, code: 'forbidden' });
      return failStatus(403, 'forbidden', `段位以档案为准（档案 ${tier}），不接受入参 tier=${body.tier}`);
    }
    const r = rankedMod.withLogger(logger, rankedDeps()).promote(tier, body.wins);
    return respond(r);
  }

  function rankedPromoteLegacy(ctx) {
    const body = bodyOf(ctx);
    if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
    const r = rankedMod.withLogger(logger, rankedDeps()).promote(body.tier, body.wins);
    if (r.status !== 200) return { status: r.status, payload: errEnvelope(r.code, r.message) };
    return { status: 200, payload: okEnvelope(r.data, logger) };
  }

  /* ----- 管理端（F2：管理员账号 DL_ADMIN_USERS **或** DL_ADMIN_TOKEN；判定在 admin.js 的 checkAccess） ----- */

  async function adminOp(ctx, op) {
    if (!rt.admin) return failStatus(503, 'store_unavailable', '服务未装配档案存储（管理端不可用）');
    const body = bodyOf(ctx);
    if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
    const adminToken = ctx.adminToken || body.adminToken;
    // player：已登录的管理员账号走这条（无/坏 token 在 tolerant 下为 null，仍可走令牌路径）
    const input = { ...body, adminToken, player: ctx.player || null };
    if (op === 'bots') return respond(await rt.admin.injectDebugBots(input));
    if (op === 'rebuild-index') return respond(await rt.admin.rebuildIndex(input));
    if (op === 'stats') return respond(await rt.admin.stats(input));
    if (op === 'clear-bots') return respond(await rt.admin.clearDebugBots(input));
    if (op === 'ban') return respond(await rt.admin.ban({ ...input, banned: body.banned !== false }));
    if (op === 'unban') return respond(await rt.admin.ban({ ...input, banned: false }));
    if (op === 'accounts') return respond(await rt.admin.accounts(input));
    if (op === 'delete-account') return respond(await rt.admin.deleteAccount(input));
    return failStatus(404, 'unknown_endpoint', `未知管理端点 POST /api/v1/admin/${op}`);
  }

  /* ----- F2：把「是否管理员」注入响应（契约 docs/frontend/02-accounts.md §2.1/§5） ----- */
  // register/login → data.player.isAdmin；GET /me → data.flags.isAdmin
  function withIsAdmin(result, isAdmin) {
    if (!result || !result.payload || result.payload.ok !== true) return result;
    const data = result.payload.data;
    if (!data || typeof data !== 'object') return result;
    if (data.player && typeof data.player === 'object') {
      return { ...result, payload: { ...result.payload, data: { ...data, player: { ...data.player, isAdmin: isAdmin === true } } } };
    }
    if (data.flags && typeof data.flags === 'object') {
      return { ...result, payload: { ...result.payload, data: { ...data, flags: { ...data.flags, isAdmin: isAdmin === true } } } };
    }
    return result;
  }

  // 白名单里的 username（用于注册响应：此刻账号刚建、用户名索引可能尚未刷新）
  function isAdminUsername(username) {
    return !!(rt.adminUsers && rt.adminUsers.names && typeof username === 'string' && rt.adminUsers.names.has(username.toLowerCase()));
  }

  /* ----- 静态托管（P6/F1；契约 docs/frontend/01-auth.md §9） -----
   * 返回 {status:200, static:{contentType, body}}；任何"不归我管"的情形一律返回 null，
   * 由既有路由表/404 语义处理（未知非 API 路径仍是 404 unknown_endpoint）。
   * 防护：解码后拒绝空段 / `.` / `..` / `\0` / `\`；path.resolve 后必须仍在 publicDir 前缀内。
   */
  function serveStatic(urlPath) {
    const dir = rt.publicDir;
    if (typeof dir !== 'string' || dir === '') return null;
    let decoded = null;
    try {
      decoded = decodeURIComponent(urlPath === '' || urlPath === '/' ? '/index.html' : urlPath);
    } catch (e) {
      return null; // 畸形 URI 编码 → 既有 404 语义
    }
    if (decoded.includes('\0') || decoded.includes('\\')) return null;
    const relPath = decoded.replace(/^\/+/, '');
    const segs = relPath.split('/');
    if (relPath === '' || segs.some((s) => s === '' || s === '.' || s === '..')) return null;
    const contentType = STATIC_EXT_TYPES[path.extname(relPath).toLowerCase()];
    if (contentType === undefined) return null; // 非白名单扩展名 → 不归静态分支
    const target = path.resolve(dir, relPath);
    const rootWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
    if (!target.startsWith(rootWithSep)) return null; // 穿越防护
    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch (e) {
      return null; // 不存在 → 404
    }
    if (!stat.isFile()) return null;
    let body = null;
    try {
      body = fs.readFileSync(target);
    } catch (e) {
      return null;
    }
    return { status: 200, static: { contentType, body } };
  }

  /* ----- 路由分派 ----- */

  const P74_GET = {
    '/api/v1/me': {
      auth: true,
      redact: true,
      handler: async (ctx) => withIsAdmin(respond(await rt.account.getSummary(ctx.player.playerId)), rt.isAdminPlayer(ctx.player)),
    },
    '/api/v1/me/configs': { auth: true, redact: true, handler: async (ctx) => respond(await rt.account.listConfigs(ctx.player.playerId)) },
    // D-159：仓库**真源**（服务端权威；D-130 的镜像语义退役，PUT 仍保留为"只校验"路径）
    '/api/v1/me/warehouse': { auth: true, redact: true, handler: async (ctx) => respond(await rt.account.getWarehouse(ctx.player.playerId)) },
    // D-161：AI 库（本批前端只用 list）
    '/api/v1/me/ai': { auth: true, redact: true, handler: async (ctx) => respond(await rt.account.listAi(ctx.player.playerId)) },
    '/api/v1/me/records': {
      auth: true,
      redact: true,
      handler: async (ctx) => respond(await rt.account.records({
        playerId: ctx.player.playerId,
        since: intOf(ctx.query.since),
        limit: intOf(ctx.query.limit),
        role: ctx.query.role,
      })),
    },
    '/api/v1/me/defense': {
      auth: true,
      redact: true,
      handler: async (ctx) => respond(await rt.account.defenseSummary({ playerId: ctx.player.playerId, limit: intOf(ctx.query.limit) })),
    },
    '/api/v1/leaderboard': {
      redact: true,
      handler: async (ctx) => respond(await rt.quick.loadLeaderboard({ scope: ctx.query.scope, limit: intOf(ctx.query.limit) })),
    },
  };

  const P74_POST = {
    '/api/v1/auth/register': {
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        // P2-5：注册即生成身份（与 store 内部生成同形），显式下传 → 默认出战配置可按身份派生
        //   （否则 `auth.register` 把 playerId/publicId 留空、由 store 就地生成，装配层拿不到身份）
        const playerId = typeof body.playerId === 'string' && archiveFx.PLAYER_ID_RE.test(body.playerId)
          ? body.playerId : archiveFx.newPlayerId();
        const publicId = typeof body.publicId === 'string' && archiveFx.PUBLIC_ID_RE.test(body.publicId)
          ? body.publicId : archiveFx.newPublicId();
        const r = await rt.auth.register({
          username: body.username, password: body.password, nickname: body.nickname,
          warehouse: body.warehouse, ip: ctx.ip, userAgent: ctx.userAgent,
          playerId, publicId,
        });
        // 缺陷 B：注册请求携带的仓库镜像 → 登记（后续对局/回放解析装配引用用；D-130 不落盘）
        if (r.status === 200 && body.warehouse && r.data && r.data.playerId) rt.rememberWarehouse(r.data.playerId, body.warehouse);
        // F2：注册响应也带 isAdmin（此刻用户名索引可能尚未刷新，故同时按白名单用户名判定）
        const isAdmin = rt.isAdminPlayer({
          publicId: r.data ? r.data.publicId : null,
          playerId: r.data ? r.data.playerId : null,
        }) || isAdminUsername(body.username);
        return withIsAdmin(respond(r), isAdmin);
      },
    },
    '/api/v1/auth/login': {
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        const r = await rt.auth.login({ username: body.username, password: body.password, ip: ctx.ip, userAgent: ctx.userAgent });
        // F2：登录响应带 isAdmin（前端据此决定是否渲染管理入口）
        const isAdmin = r.status === 200 && r.data
          ? rt.isAdminPlayer({ publicId: r.data.publicId, playerId: r.data.playerId })
          : false;
        return withIsAdmin(respond(r), isAdmin);
      },
    },
    '/api/v1/auth/logout': { auth: true, redact: true, handler: async (ctx) => respond(await rt.auth.logout({ token: ctx.token })) },
    '/api/v1/auth/password': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        return respond(await rt.auth.changePassword({
          token: ctx.token, playerId: ctx.player.playerId,
          oldPassword: body.oldPassword === undefined ? body.old_password : body.oldPassword,
          newPassword: body.newPassword === undefined ? body.new_password : body.newPassword,
        }));
      },
    },
    '/api/v1/me/configs': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        const r = await respond(await rt.account.createSlot({
          playerId: ctx.player.playerId, loadout: body.loadout,
          name: body.name, activate: body.activate,
        }));
        if (r.status === 200 && body.warehouse) rt.rememberWarehouse(ctx.player.playerId, body.warehouse);
        return r;
      },
    },
    '/api/v1/me/records/seen': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        const uptoSeq = body.uptoSeq === undefined ? intOf(ctx.query.uptoSeq) : body.uptoSeq;
        return respond(await rt.account.markSeen({ playerId: ctx.player.playerId, uptoSeq }));
      },
    },
    // D-159：开箱（**服务端权威**：物品直接入档；D-162：接口不设 seed 入参）
    '/api/v1/me/box': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        const boxApi = require('./box.js');
        // D-162：不接受客户端 seed（接口没有该字段）；seed 由服务端生成，注入缝保证测试/e2e 确定性
        const r = boxApi.openBoxes({ tier: body.tier, times: body.times, logger, seedFactory: rt.boxSeedFactory });
        if (r.status !== 200) return respond(r);
        try {
          const granted = await rt.store.grantBox({
            playerId: ctx.player.playerId, seed: r.data.seed, tier: r.data.tier,
            times: r.data.times, items: r.data.items,
          });
          return {
            status: 200,
            payload: okEnvelope({
              seed: r.data.seed, tier: r.data.tier, times: r.data.times,
              // D-163：用**落档后**的 items（发放路径可能重映射过 uid）—— 保证响应 = journal = 档案
              items: Array.isArray(granted.items) ? granted.items : r.data.items,
              counts: granted.counts, caps: granted.caps, grantId: granted.grantId,
            }, logger),
          };
        } catch (err) {
          return respond(err);
        }
      },
    },
    // D-159：装配/拆卸（校验用 core/items 纯函数，落 journal 增量记录）
    '/api/v1/me/warehouse/assemble': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        return respond(await rt.account.assemblePlugin({
          playerId: ctx.player.playerId, targetUid: body.targetUid,
          pluginUid: body.pluginUid, slotIndex: body.slotIndex,
        }));
      },
    },
    '/api/v1/me/warehouse/disassemble': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        return respond(await rt.account.disassemblePlugin({
          playerId: ctx.player.playerId, targetUid: body.targetUid, slotIndex: body.slotIndex,
        }));
      },
    },
    // D-161：AI 库创建（命名保存；上限 100 → 409 ai_limit）
    '/api/v1/me/ai': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        return respond(await rt.account.createAi({
          playerId: ctx.player.playerId, name: body.name, program: body.program,
        }));
      },
    },
    '/api/v1/quick/run': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        return respond(await rt.quick.run({ playerId: ctx.player.playerId, seed: body.seed }));
      },
    },
  };

  const P74_PUT = {
    '/api/v1/me/nickname': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        return respond(await rt.account.setNickname({ playerId: ctx.player.playerId, nickname: body.nickname }));
      },
    },
    '/api/v1/me/warehouse': {
      auth: true,
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        return respond(await rt.account.saveWarehouseMirror({ playerId: ctx.player.playerId, warehouse: body.warehouse }));
      },
    },
  };

  // 端点别名（任务口径与设计口径并存；两条路径等价，见 P7-4 报告）
  P74_POST['/api/v1/auth/change-password'] = P74_POST['/api/v1/auth/password'];
  P74_POST['/api/v1/me/seen'] = P74_POST['/api/v1/me/records/seen'];

  /* ----- 请求管线 ----- */

  function applyCors(req, res) {
    const whitelist = rt.corsOrigin;
    if (typeof whitelist !== 'string' || whitelist === '') return false;
    const origin = req.headers.origin;
    const allowed = whitelist.split(',').map((s) => s.trim()).filter((s) => s !== '');
    const match = typeof origin === 'string' && origin !== '' && (allowed.includes('*') || allowed.includes(origin));
    if (match) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type, x-admin-token');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    return true; // 已配置 CORS → 处理 OPTIONS 预检
  }

  // 端点元数据 → 管线（鉴权 → 限速 → 取体 → 越权 → 业务）
  async function runEntry(entry, ctx) {
    const isLegacy = typeof entry === 'function';
    const meta = isLegacy ? { legacy: true } : entry;
    const handler = isLegacy ? entry : entry.handler;
    if (meta.legacy !== true && meta.store !== false && !rt.store) {
      return failStatus(503, 'store_unavailable', '服务未装配档案存储（DL_DATA_DIR 未启用）：/auth、/me、/quick、/leaderboard、归档回放不可用');
    }
    if (meta.legacy !== true) {
      const token = bearerOf(ctx.headers.authorization);
      if (token) {
        const a = await authenticate(token);
        if (!a.ok) {
          // tolerant：遗留 `r<seq>` 回放等端点忽略无效 token（旧语义未读 Authorization），仅按匿名处理
          if (meta.tolerant !== true) {
            logger.warn('api', 'api.reject', `${a.code}: ${a.message}`, { path: ctx.urlPath, code: a.code });
            return failStatus(a.status, a.code, a.message);
          }
          logger.debug('api', 'api.req', `忽略无效 token（tolerant 端点）：${a.code}`, { path: ctx.urlPath, code: a.code });
        } else {
          ctx.player = a.player;
          ctx.token = token;
        }
      }
      if (meta.auth === true && !ctx.player) {
        logger.warn('api', 'api.reject', 'unauthorized: 缺少会话 token', { path: ctx.urlPath, code: 'unauthorized' });
        return failStatus(401, 'unauthorized', '缺少会话 token（Authorization: Bearer <token>）');
      }
    }
    // 全局限速（§4.6：600 次/分/token；未登录按 IP）
    const key = ctx.player ? ctx.player.playerId : `ip:${ctx.ip}`;
    const gate = rt.rateLimiter.check(key);
    if (!gate.ok) {
      logger.warn('api', 'api.reject', 'rate_limited: 全局限速命中', { path: ctx.urlPath, code: 'rate_limited', retryAfterMs: gate.retryAfterMs });
      return failStatus(429, 'rate_limited', `请求过于频繁（上限 ${rt.rateLimiter.limit} 次/分钟），请稍后重试`);
    }
    if (ctx.method !== 'GET') {
      const raw = await readBody(ctx.req); // 超限 → BodyTooLargeError → 413（外层捕获）
      ctx.rawBody = raw || '{}';
    }
    // 越权防护（§4.4 步骤 5）：请求体不得指定他人 playerId
    //   **F2 例外**：admin 面（meta.admin）以他人为操作对象是设计意图（ban/delete-account 都收 playerId），
    //   其授权由 admin.js 的 checkAccess 承担（管理员账号或 DL_ADMIN_TOKEN），故此处不施加玩家级一致性检查。
    if (ctx.player && meta.admin !== true) {
      const body = jsonBody(ctx);
      if (body && body.playerId !== undefined && body.playerId !== null && body.playerId !== ctx.player.playerId) {
        logger.warn('api', 'api.reject', 'forbidden: 请求体 playerId 与令牌不一致', { path: ctx.urlPath, publicId: ctx.player.publicId, code: 'forbidden' });
        return failStatus(403, 'forbidden', '不能访问其他玩家的资源（playerId 与令牌不一致）');
      }
    }
    const result = await handler(ctx);
    // §4.5：玩家侧响应一律剔除 playerId（admin 运维通道除外）
    const payload = meta.redact === true && result.payload && result.payload.ok === true
      ? { ...result.payload, data: stripPlayerId(result.payload.data) }
      : result.payload;
    return {
      status: result.status,
      payload,
      publicId: ctx.player && ctx.player.publicId ? ctx.player.publicId : null,
    };
  }

  async function dispatch(req) {
    const urlPath = (req.url || '/').split('?')[0];
    const query = parseQuery(req.url);
    const ctx = {
      method: req.method, urlPath, query, headers: req.headers, req,
      rawBody: '', logger,
      ip: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null,
      userAgent: req.headers['user-agent'] === undefined ? null : req.headers['user-agent'],
      player: null, token: null,
      adminToken: typeof req.headers['x-admin-token'] === 'string' && req.headers['x-admin-token'] !== ''
        ? req.headers['x-admin-token'] : bearerOf(req.headers.authorization),
    };
    // 遗留无状态端点开关（DL_LEGACY_STATELESS=0 → 410 deprecated）
    if (!rt.legacyStateless && isLegacyPath(urlPath)) return deprecated(`${req.method} ${urlPath}`);

    // 动态表端点：GET /api/v1/data/:table
    if (req.method === 'GET' && urlPath.startsWith('/api/v1/data/')) {
      let table = null;
      let badUri = false;
      try {
        table = decodeURIComponent(urlPath.slice('/api/v1/data/'.length));
      } catch (e) {
        badUri = true; // 畸形 URI 编码（如 %zz）→ 400 bad_table
      }
      if (badUri) return failStatus(400, 'bad_table', '表名含非法 URI 编码');
      if (table.includes('/') || table.includes('..')) return failStatus(400, 'bad_table', `非法表名 ${table}`);
      const data = loadTable(table);
      if (data === null) return { status: 404, payload: errEnvelope('unknown_table', `未知数据表 ${table}`, [`可用表: ${tableNames().join(', ')}`]) };
      return { status: 200, payload: okEnvelope(data, logger) };
    }

    // 动态回放端点：GET /api/v1/replay/:id
    if (req.method === 'GET' && urlPath.startsWith('/api/v1/replay/')) {
      let id = null;
      let badUri = false;
      try {
        id = decodeURIComponent(urlPath.slice('/api/v1/replay/'.length));
      } catch (e) {
        badUri = true;
      }
      if (badUri || id === null || id === '' || id.includes('/') || id.includes('..')) {
        return failStatus(400, 'bad_replay', `非法回放 id ${id || ''}`);
      }
      return runEntry({ auth: false, store: false, tolerant: true, handler: async (c) => serveReplay(c, id, query) }, ctx);
    }

    // 管理端：POST /api/v1/admin/:op（DL_ADMIN_TOKEN）
    if (req.method === 'POST' && urlPath.startsWith('/api/v1/admin/')) {
      const op = urlPath.slice('/api/v1/admin/'.length);
      // F2：tolerant → 无/坏 token 不 401，仅按匿名处理；管理员账号身份经 Bearer 解析（adminOp 内判定）
      return runEntry({ admin: true, store: false, tolerant: true, handler: async (c) => adminOp(c, op) }, ctx);
    }

    // 配置槽动态路由：PUT|DELETE /me/configs/:slotId、POST /me/configs/:slotId/activate
    const cfgPrefix = '/api/v1/me/configs/';
    if (urlPath.startsWith(cfgPrefix)) {
      const rest = urlPath.slice(cfgPrefix.length);
      const parts = rest.split('/');
      let slotId = null;
      let badUri = false;
      try {
        slotId = decodeURIComponent(parts[0]);
      } catch (e) {
        badUri = true;
      }
      if (badUri) return failStatus(400, 'bad_request', `非法槽位 id ${parts[0]}`);
      if (parts.length === 1 && req.method === 'PUT') {
        return runEntry({
          auth: true,
          handler: async (c) => {
            const body = bodyOf(c);
            if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
            const r = await respond(await rt.account.saveConfig({
              // D-163 热修：**不透传客户端提交的 warehouse 镜像** —— 仓库是服务端权威（D-159），
              //   物品身份/数值由 account 层按 uid 从服务端真源解析；把客户端镜像当校验/解析来源
              //   等于把"服务端权威"交回给客户端（实测：同时 PUT 一个自带 buff 物品的镜像即可绕过）。
              playerId: c.player.playerId, slotId, loadout: body.loadout,
              name: body.name, baseUpdatedAt: body.baseUpdatedAt, activate: body.activate,
            }));
            return r;
          },
        }, ctx);
      }
      if (parts.length === 1 && req.method === 'DELETE') {
        return runEntry({ auth: true, handler: async (c) => respond(await rt.account.deleteSlot({ playerId: c.player.playerId, slotId })) }, ctx);
      }
      if (parts.length === 2 && parts[1] === 'activate' && req.method === 'POST') {
        return runEntry({ auth: true, handler: async (c) => respond(await rt.account.activateConfig({ playerId: c.player.playerId, slotId })) }, ctx);
      }
    }

    // D-161：AI 库动态路由 DELETE /me/ai/:aiId（删除被出战配置引用者 → 409 ai_in_use）
    const aiPrefix = '/api/v1/me/ai/';
    if (req.method === 'DELETE' && urlPath.startsWith(aiPrefix)) {
      const rest = urlPath.slice(aiPrefix.length);
      if (rest !== '' && !rest.includes('/')) {
        let aiId = null;
        try {
          aiId = decodeURIComponent(rest);
        } catch (e) {
          return failStatus(400, 'bad_request', `非法 aiId ${rest}`);
        }
        return runEntry({ auth: true, handler: async (c) => respond(await rt.account.deleteAi({ playerId: c.player.playerId, aiId })) }, ctx);
      }
    }

    // 静态路由（P7-4 优先于遗留：同名端点以 P7-4 语义为准）
    const p74 = { GET: P74_GET, POST: P74_POST, PUT: P74_PUT, DELETE: {} }[req.method];
    const entry = (p74 && p74[urlPath]) || (routes[req.method] || {})[urlPath];
    if (!entry) {
      // P6/F1：路由表未命中时才尝试 public/ 静态资源（仅 GET；/api/* 一律不进入静态分支）
      if (req.method === 'GET' && !urlPath.startsWith('/api/')) {
        const st = serveStatic(urlPath);
        if (st) return st;
      }
      return { status: 404, payload: errEnvelope('unknown_endpoint', `未知端点 ${req.method} ${urlPath}`) };
    }
    return runEntry(entry, ctx);
  }

  return async (req, res) => {
    const started = Date.now();
    const urlPath = (req.url || '/').split('?')[0];
    const hasCors = applyCors(req, res);
    if (req.method === 'OPTIONS' && hasCors) {
      res.writeHead(204);
      res.end();
      logger.info('api', 'api.req', `OPTIONS ${req.url}`, { method: 'OPTIONS', path: urlPath, preflight: true });
      logger.info('api', 'api.res', `OPTIONS ${urlPath} -> 204`, { method: 'OPTIONS', path: urlPath, status: 204, durationMs: Date.now() - started, bytes: 0 });
      return;
    }
    let status = 404;
    let payload = errEnvelope('unknown_endpoint', `未知端点 ${req.method} ${urlPath}`);
    let publicId = null;
    let staticAsset = null; // P6/F1：静态资源（dispatch 返回 r.static 时走原始字节响应）
    try {
      const r = await dispatch(req);
      status = r.status;
      if (r.payload !== undefined) payload = r.payload;
      if (r.static !== undefined) staticAsset = r.static;
      publicId = r.publicId === undefined ? null : r.publicId;
    } catch (e) {
      if (e && e.code === 'payload_too_large') {
        // P7-7 §⑩：请求体超限 → 413 payload_too_large（不再是 500 internal_error）
        status = 413;
        payload = errEnvelope('payload_too_large', e.message);
        logger.warn('api', 'api.reject', `payload_too_large: ${urlPath}`, { path: urlPath, code: 'payload_too_large', limit: e.limit });
      } else {
        status = 500;
        payload = errEnvelope('internal_error', e.message || '服务端内部错误');
        logger.error('api', 'api.err', `处理 ${urlPath} 异常`, { message: e.message, stack: e.stack });
      }
    }
    // §4.6 日志脱敏：只记路径与玩家 publicId（不记 token/密码/载荷全文）
    logger.info('api', 'api.req', `${req.method} ${req.url}`, {
      method: req.method, path: urlPath, query: req.url.includes('?') ? req.url.split('?')[1] : null, publicId,
    });
    const bytes = staticAsset === null ? send(res, status, payload) : sendStatic(res, status, staticAsset);
    logger.info('api', 'api.res', `${req.method} ${urlPath} -> ${status}`, { method: req.method, path: urlPath, status, durationMs: Date.now() - started, bytes, publicId });
  };
}

/* ---------- 启动 ---------- */

// start(options) → Promise<{server, port, close, store, runtime}>；端口 0 = 临时端口（测试/冒烟用）
// 缺省不装配档案存储（沿用无状态基线）；传 dataDir/store/enableStore 或设 DL_DATA_DIR 才落盘（D-129）。
async function start(options) {
  const opts = options || {};
  const logger = opts.logger || createLogger();
  const runtime = await createRuntime(logger, opts); // 失败（锁占用/版本拒绝）原样冒泡 → 调用方 exit 1
  const server = http.createServer(createHandler(logger, opts.routes, runtime));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, opts.host || DEFAULT_HOST, resolve);
  });
  const port = server.address().port;
  return {
    server,
    port,
    store: runtime.store,
    runtime,
    close: async () => {
      await new Promise((resolve) => server.close(() => resolve()));
      if (runtime.store) await runtime.store.close();
    },
  };
}

async function main() {
  const logger = createLogger({
    onRecord: (r) => {
      if (r.levelValue >= 3) console.log(`[${r.level}] ${r.channel} ${r.event} ${r.msg}${Object.keys(r.data).length ? ' ' + JSON.stringify(r.data) : ''}`);
    },
  });
  const port = resolvePort(process.env);
  if (port === null) {
    console.error(`[server] DL_PORT=${process.env.DL_PORT} 非法（应为 0..65535 的整数；0 = 临时端口）`);
    process.exitCode = 1;
    return;
  }
  // 生产入口：显式装配档案存储（DL_DATA_DIR 或默认 <repo>/runtime），失败则拒绝启动（§3.4，退出码 1）
  const s = await start({
    logger,
    port,
    host: process.env.DL_HOST || DEFAULT_HOST,
    enableStore: true,
    versions: { engine: VERSION },
  });
  // 启动信息用普通 stdout（不属于日志矩阵事件，P0-8 审查 P3：避免占用 battle.create/api.req 语义）
  console.log(`[server] Debug-Lite v${VERSION} listening http://${s.server.address().address}:${port}`);
  if (s.store) {
    console.log(`[store] archive=${s.store.index.size()} seq=${s.store.maxSeq()} dataDir=${s.store.dataDir}`);
  }
}

module.exports = {
  createHandler,
  createRuntime,
  start,
  loadTable,
  tableNames,
  okEnvelope,
  errEnvelope,
  isLegacyPath,
  stripPlayerId,
  bearerOf,
  globalRateLimitOf,
  resolvePort,
  envOf,
  storeWanted,
  PUBLIC_DIR,
  STATIC_EXT_TYPES,
  VERSION,
};

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
