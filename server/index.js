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
const RATE_WINDOW_MS = 60000;
const DEFAULT_REPLAY_LRU = 64;                  // §11.3/D-135 帧 LRU 上限
const EVICTED_REMEMBERED = 256;                 // 已淘汰 id 记忆（用于区分 410 与 404）
const WAREHOUSE_CACHE_MAX = 200;                // 缺陷 B：进程内仓库镜像缓存上限（与 account.js 的 MIRROR_CACHE_MAX 同口径）

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

function errEnvelope(code, message, details) {
  return { ok: false, error: { code, message, details: details || [] } };
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
  return Buffer.byteLength(body);
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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      data += c;
      if (data.length > BODY_LIMIT_BYTES) {
        tooBig = true;
        reject(new BodyTooLargeError(BODY_LIMIT_BYTES));
      }
    });
    req.on('end', () => { if (!tooBig) resolve(data); });
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
function storeWanted(opts, env) {
  if (opts.store) return true;
  if (typeof opts.dataDir === 'string' && opts.dataDir !== '') return true;
  if (opts.enableStore === true) return true;
  if (typeof env.DL_DATA_DIR === 'string' && env.DL_DATA_DIR !== '') return true;
  return false;
}

// 环境变量读取（§2/§7）：DL_DATA_DIR / DL_STORE / DL_ADMIN_TOKEN / DL_LEGACY_STATELESS / DL_CORS_ORIGIN
function envOf(options) {
  const opts = options || {};
  const env = { ...(opts.env || process.env) };
  if (opts.adminToken !== undefined) env.DL_ADMIN_TOKEN = opts.adminToken;
  if (opts.corsOrigin !== undefined) env.DL_CORS_ORIGIN = opts.corsOrigin;
  if (opts.legacyStateless !== undefined) env.DL_LEGACY_STATELESS = opts.legacyStateless === false ? '0' : String(opts.legacyStateless);
  return env;
}

async function createRuntime(logger, options) {
  const opts = options || {};
  const env = envOf(opts);
  const rt = {
    logger,
    env,
    legacyStateless: legacyStatelessOf(opts, env),
    corsOrigin: typeof env.DL_CORS_ORIGIN === 'string' ? env.DL_CORS_ORIGIN : '',
    store: null,
    auth: null,
    account: null,
    quick: null,
    admin: null,
    rateLimiter: createRateLimiter({ limit: opts.rateLimitPerMinute, windowMs: opts.rateWindowMs }),
    replayLimit: Number.isInteger(opts.replayLimit) && opts.replayLimit > 0 ? opts.replayLimit : null,
    replayMeta: new Map(),   // 回放 id → { participants, frameId, kind }
    evicted: new Set(),      // 已淘汰 id（区分 410 与 404）
    ownReplays: [],          // 本实例登记的帧 id（LRU 淘汰记账）
    runBattle: typeof opts.runBattle === 'function' ? opts.runBattle : null, // 测试接缝（P2-1：排位/快速同源）
  };
  // 缺陷 B：仓库镜像解析（进程内）。来源 ① account 模块镜像缓存（PUT /me/warehouse）；
  //   ② 携带 warehouse 的配置保存/注册请求（校验通过后登记，见 rememberWarehouse/路由接线）。
  //   D-130：仓库由客户端权威持有、服务端**不落盘** → 重启后镜像为空；此时装配引用的对局按
  //   ranked 的"已校验 → 跳过仓库引用校验（基准面板退化）"口径进行，未校验者仍 409 missing_warehouse。
  rt.warehouses = new Map();
  rt.rememberWarehouse = (playerId, warehouse) => {
    if (typeof playerId !== 'string' || playerId === '' || !warehouse || typeof warehouse !== 'object') return false;
    rt.warehouses.delete(playerId);
    rt.warehouses.set(playerId, warehouse);
    while (rt.warehouses.size > WAREHOUSE_CACHE_MAX) rt.warehouses.delete(rt.warehouses.keys().next().value);
    return true;
  };
  rt.loadWarehouse = async (playerId) => {
    // 优先级：account 模块镜像（PUT /me/warehouse 的显式提交）→ 配置保存请求登记的镜像
    if (typeof playerId === 'string' && playerId !== '' && rt.account && typeof rt.account.getWarehouseMirror === 'function') {
      const r = await rt.account.getWarehouseMirror(playerId);
      if (r && r.ok === true && r.data && r.data.warehouse) {
        rt.rememberWarehouse(playerId, r.data.warehouse);
        return r.data.warehouse;
      }
    }
    return rt.warehouses.get(playerId) || null;
  };
  if (storeWanted(opts, env)) {
    rt.store = await storeMod.openStore({
      dataDir: opts.dataDir,
      adapter: opts.adapter,
      configDir: opts.configDir,
      logger,
      now: opts.now,
      config: opts.config,
      ratingConfig: opts.ratingConfig,
      versions: opts.versions || { engine: VERSION },
    });
    rt.account = accountMod.createAccount({ store: rt.store, logger, now: opts.now });
    // P2-5：默认出战配置按玩家身份派生（`account.js` 的默认构造回调无身份入参，且该文件不在本批所有权内）
    //   → 在装配层补一层：**仅当调用方未显式提供 loadout** 时，用身份派生的默认配置组装调用。
    //   身份 = publicId（注册时生成）优先，其次 playerId；两者都缺 → ranked 内部回落 steady/0（确定性）。
    if (typeof rt.account.createPlayerArchive === 'function') {
      const createArchiveInner = rt.account.createPlayerArchive;
      rt.account.createPlayerArchive = (input) => {
        const o = input || {};
        if (o.loadout !== undefined && o.loadout !== null) return createArchiveInner(o);
        return createArchiveInner({
          ...o,
          loadout: rankedMod.buildDefaultLoadout({ publicId: o.publicId, playerId: o.playerId }),
        });
      };
    }
    rt.auth = authMod.createAuth({ store: rt.store, logger, now: opts.now, account: rt.account, config: opts.authConfig });
    rt.quick = quickmatchMod.createQuickMatch({
      store: rt.store, logger, now: opts.now, env, config: opts.ratingConfig, runBattle: opts.runBattle,
      loadWarehouse: (playerId) => rt.loadWarehouse(playerId),
    });
    rt.admin = adminMod.createAdmin({ store: rt.store, logger, now: opts.now, env });
  }
  if (rt.replayLimit === null) {
    const configured = rt.store && rt.store.config && Number.isInteger(rt.store.config.replayCacheSize)
      ? rt.store.config.replayCacheSize : 0;
    rt.replayLimit = configured > 0 ? configured : DEFAULT_REPLAY_LRU;
  }
  return rt;
}

/* ---------- 路由表（P0-8 基线；P7-4 新增端点见 p74Routes） ---------- */

// 路由表：GET/POST → path → handler(ctx) → {status, payload}
// handler 抛异常 → api.err + 500 internal_error（AP-6）
// P7-4 形状扩展：`{ auth: true, handler }` = 需 Bearer 鉴权；`{ admin: true }` = 需 DL_ADMIN_TOKEN。
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
      '/api/v1/ai/battle': async (ctx) => {
        // B16：给定 AI 跑一场（服务端重新执行，T-AP-4；seed 显式化回带，T-AP-5）
        const runner = require('./runner.js');
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        const program = body.program || body.ai;
        if (!program || typeof program !== 'object') {
          return { status: 400, payload: errEnvelope('bad_ai', '缺少 program（AI 程序对象）') };
        }
        const seed = body.seed;
        const r = runner.runAiBattle({
          program,
          seed,
          tier: body.tier === undefined ? 'mythic' : String(body.tier),
          opponent: body.opponent === undefined ? 'kiter' : String(body.opponent),
          logger,
        });
        if (r.status !== 200) {
          return { status: r.status, payload: errEnvelope(r.code, r.code === 'unknown_opponent' ? '未知对手' : 'AI 战斗无法执行', r.details) };
        }
        return { status: 200, payload: okEnvelope(r.data, logger) };
      },
      '/api/v1/box': async (ctx) => {
        // B17：开箱（seed/tier/次数；D-122 段位品质上限 + I-9 掉落池门控；seed 回带 T-AP-5）
        const boxApi = require('./box.js');
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        const r = boxApi.openBoxes({ seed: body.seed, tier: body.tier, times: body.times, logger });
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
      '/api/v1/battle': async (ctx) => {
        // B22：双方 loadout + AI + seed → 完整回放帧（服务端重执行；回放注册表进程内，D-123 不落盘）
        const body = jsonBody(ctx);
        if (body === null) return { status: 400, payload: errEnvelope('bad_json', '请求体不是合法 JSON') };
        const tier = body.tier === undefined ? 'mythic' : String(body.tier);
        const unlockApi = require('./core/unlock.js');
        if (unlockApi.tierIndex(tier) === null) {
          return { status: 400, payload: errEnvelope('bad_tier', `非法段位 ${tier}（可选: common/rare/epic/legendary/mythic）`) };
        }
        const r = battleApi.runBattle({ p1: body.p1, p2: body.p2, warehouse: body.warehouse, seed: body.seed, tier });
        if (r.status !== 200) {
          if (r.code === 'loadout_invalid') {
            return { status: 409, payload: errEnvelope(r.code, r.message, r.details) };
          }
          return { status: r.status, payload: errEnvelope(r.code, r.message) };
        }
        // P7-4：登记进有上限 LRU（无参与者 → 与旧无状态语义一致，任何持有 id 者可见）
        registerReplay({ id: r.data.id, frameId: r.data.id, participants: null, kind: 'legacy' });
        return { status: 200, payload: okEnvelope(r.data, logger) };
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

  /* ----- 回放 aiTrace 裁剪（P1-1 / §9.4） -----
   * §9.4：`aiTrace` **默认只返回请求方自己一侧**的（避免把对手 AI 的逐步决策喂给玩家）；
   *       `?trace=all` 仅管理员令牌通过时放行；未知 trace 值 → 400 bad_request。
   * 两条归档路径（进程内帧缓存命中 / 按 journal + 快照重算）都必须裁剪；`?trace=self` 是默认值。
   * 侧别未知的情形（遗留 `r<seq>`：双方 loadout 与 AI 程序都由调用方在 `POST /battle` 自备 → 不存在
   *       "对手私有信息"）不裁剪，保持旧语义零回归。
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
    if (mode === 'all' || side === null) return data;
    const frames = (Array.isArray(data.frames) ? data.frames : []).map((f) => {
      const diff = f && f.diff;
      if (!diff || !Array.isArray(diff.aiTrace)) return f;
      return { ...f, diff: { ...diff, aiTrace: diff.aiTrace.filter((t) => t && t.owner === side) } };
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
      if (r.status === 200) return { status: 200, payload: okEnvelope(applyTrace(r.data, null, traceMode), logger) };
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
    const r = battleApi.runBattle({ p1: snap1.loadout, p2: snap2.loadout, seed: record.seed, tier });
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

  /* ----- 管理端（DL_ADMIN_TOKEN；admin.js 内部二次校验） ----- */

  async function adminOp(ctx, op) {
    if (!rt.admin) return failStatus(503, 'store_unavailable', '服务未装配档案存储（管理端不可用）');
    const body = bodyOf(ctx);
    if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
    const adminToken = ctx.adminToken || body.adminToken;
    const input = { ...body, adminToken };
    if (op === 'bots') return respond(await rt.admin.injectDebugBots(input));
    if (op === 'rebuild-index') return respond(await rt.admin.rebuildIndex(input));
    if (op === 'stats') return respond(await rt.admin.stats(input));
    if (op === 'clear-bots') return respond(await rt.admin.clearDebugBots(input));
    if (op === 'ban') return respond(await rt.admin.ban({ ...input, banned: body.banned !== false }));
    if (op === 'unban') return respond(await rt.admin.ban({ ...input, banned: false }));
    return failStatus(404, 'unknown_endpoint', `未知管理端点 POST /api/v1/admin/${op}`);
  }

  /* ----- 路由分派 ----- */

  const P74_GET = {
    '/api/v1/me': { auth: true, redact: true, handler: async (ctx) => respond(await rt.account.getSummary(ctx.player.playerId)) },
    '/api/v1/me/configs': { auth: true, redact: true, handler: async (ctx) => respond(await rt.account.listConfigs(ctx.player.playerId)) },
    '/api/v1/me/warehouse': { auth: true, redact: true, handler: async (ctx) => respond(await rt.account.getWarehouseMirror(ctx.player.playerId)) },
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
        return respond(r);
      },
    },
    '/api/v1/auth/login': {
      redact: true,
      handler: async (ctx) => {
        const body = bodyOf(ctx);
        if (body === null) return failStatus(400, 'bad_json', '请求体不是合法 JSON');
        return respond(await rt.auth.login({ username: body.username, password: body.password, ip: ctx.ip, userAgent: ctx.userAgent }));
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
          playerId: ctx.player.playerId, loadout: body.loadout, warehouse: body.warehouse,
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
    if (meta.legacy !== true && meta.admin !== true) {
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
    if (ctx.player) {
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
      return runEntry({ admin: true, store: false, handler: async (c) => adminOp(c, op) }, ctx);
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
              playerId: c.player.playerId, slotId, loadout: body.loadout, warehouse: body.warehouse,
              name: body.name, baseUpdatedAt: body.baseUpdatedAt, activate: body.activate,
            }));
            // 缺陷 B：保存配置请求携带的仓库镜像 → 登记（校验已通过才登记，避免存入未校验镜像）
            if (r.status === 200 && body.warehouse) rt.rememberWarehouse(c.player.playerId, body.warehouse);
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

    // 静态路由（P7-4 优先于遗留：同名端点以 P7-4 语义为准）
    const p74 = { GET: P74_GET, POST: P74_POST, PUT: P74_PUT, DELETE: {} }[req.method];
    const entry = (p74 && p74[urlPath]) || (routes[req.method] || {})[urlPath];
    if (!entry) return { status: 404, payload: errEnvelope('unknown_endpoint', `未知端点 ${req.method} ${urlPath}`) };
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
    try {
      const r = await dispatch(req);
      status = r.status;
      payload = r.payload;
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
    const bytes = send(res, status, payload);
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
  const port = Number(process.env.DL_PORT) || DEFAULT_PORT;
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
  VERSION,
};

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
