'use strict';
/* server/index.js —— /api/v1 HTTP 层（P0-8，契约 docs/interfaces.md §2）
 * 实现取向：零依赖 node:http（白名单 express 允许但未引入：与门禁/测试零依赖哲学一致，
 * 且当时网络不稳定；后续如需路由中间件可换 express，接口不变）。
 * IO（stdout/文件）只在本层：≥info 经 onRecord sink 输出；api.* 事件见 §6 日志矩阵。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createLogger } = require('../shared/log.js');

const DATA_DIR = path.join(__dirname, 'data');
const ASSETS_DIR = path.join(__dirname, '..', 'assets'); // P0-9：占位美术表作为数据表经 API 提供
const VERSION = '3.0.0';

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (c) => {
      if (tooBig) return;
      data += c;
      if (data.length > 1e6) {
        tooBig = true;
        reject(new Error('请求体超过 1MB 上限'));
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

// 路由表：GET/POST → path → handler(ctx) → {status, payload}
// handler 抛异常 → api.err + 500 internal_error（AP-6）
function createHandler(logger, extraRoutes) {
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
        return { status: 200, payload: okEnvelope({ ok: true }, logger) };
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
    },
  };
  if (extraRoutes) {
    for (const method of Object.keys(extraRoutes)) {
      routes[method] = { ...(routes[method] || {}), ...extraRoutes[method] };
    }
  }

  return async (req, res) => {
    const started = Date.now();
    const urlPath = (req.url || '/').split('?')[0];
    logger.info('api', 'api.req', `${req.method} ${req.url}`, { method: req.method, path: urlPath, query: req.url.includes('?') ? req.url.split('?')[1] : null });
    let status = 404;
    let payload = errEnvelope('unknown_endpoint', `未知端点 ${req.method} ${urlPath}`);
    try {
      // 动态表端点：GET /api/v1/data/:table
      if (req.method === 'GET' && urlPath.startsWith('/api/v1/data/')) {
        let table = null;
        let badUri = false;
        try {
          table = decodeURIComponent(urlPath.slice('/api/v1/data/'.length));
        } catch (e) {
          badUri = true; // 畸形 URI 编码（如 %zz）→ 400 bad_table
        }
        if (badUri) {
          status = 400;
          payload = errEnvelope('bad_table', '表名含非法 URI 编码');
        } else if (table.includes('/') || table.includes('..')) {
          status = 400;
          payload = errEnvelope('bad_table', `非法表名 ${table}`);
        } else {
          const data = loadTable(table);
          if (data === null) {
            status = 404;
            payload = errEnvelope('unknown_table', `未知数据表 ${table}`, [`可用表: ${tableNames().join(', ')}`]);
          } else {
            status = 200;
            payload = okEnvelope(data, logger);
          }
        }
      } else {
        const handler = (routes[req.method] || {})[urlPath];
        if (handler) {
          let rawBody = '';
          if (req.method === 'POST') {
            rawBody = await readBody(req);
            if (!rawBody) rawBody = '{}';
          }
          const ctx = { rawBody, logger, query: parseQuery(req.url) };
          const r = await handler(ctx);
          status = r.status;
          payload = r.payload;
        }
      }
    } catch (e) {
      status = 500;
      payload = errEnvelope('internal_error', e.message || '服务端内部错误');
      logger.error('api', 'api.err', `处理 ${urlPath} 异常`, { message: e.message, stack: e.stack });
    }
    const bytes = send(res, status, payload);
    logger.info('api', 'api.res', `${req.method} ${urlPath} -> ${status}`, { method: req.method, path: urlPath, status, durationMs: Date.now() - started, bytes });
  };
}

// start(port) → Promise<{server, port, close}>；端口 0 = 临时端口（测试/冒烟用）
async function start(options) {
  const opts = options || {};
  const logger = opts.logger || createLogger();
  const server = http.createServer(createHandler(logger, opts.routes));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port || 0, opts.host || '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function main() {
  const logger = createLogger({
    onRecord: (r) => {
      if (r.levelValue >= 3) console.log(`[${r.level}] ${r.channel} ${r.event} ${r.msg}${Object.keys(r.data).length ? ' ' + JSON.stringify(r.data) : ''}`);
    },
  });
  const port = Number(process.env.DL_PORT) || 3000;
  const s = await start({ logger, port, host: process.env.DL_HOST || '127.0.0.1' });
  // 启动信息用普通 stdout（不属于日志矩阵事件，P0-8 审查 P3：避免占用 battle.create/api.req 语义）
  console.log(`[server] Debug-Lite v${VERSION} listening http://${s.server.address().address}:${port}`);
}

module.exports = { createHandler, start, loadTable, tableNames, okEnvelope, errEnvelope, VERSION };

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}