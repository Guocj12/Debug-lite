'use strict';
/* tests/helpers/e2e.js —— P7-5（全链路端到端）测试夹具
 *
 * 职责：在 `os.tmpdir()` 下装配一套**隔离**的真实服务（`server/index.js` 的 handler + `node:http` 随机端口），
 *      并提供"真实玩家"原语：注册（走 HTTP，真 scrypt/token/默认配置/快照冻结）、开箱、装配、构造出战配置、
 *      取玩家 `playerId`（§4.5：`playerId` 不对外，只能从档案库反查 —— "无 bot" 断言的唯一凭据）。
 *
 * 关键约定：
 *   · 数据根一律 `os.tmpdir()` 下临时目录（**不污染仓库 `runtime/`**），cleanup 后删除；
 *   · `DL_DATA_DIR` 语义等价：显式传 `dataDir` 才装配档案存储（见 `server/index.js` `storeWanted`），
 *     本夹具**同时设置 `env.DL_DATA_DIR`**，使"环境变量装配存储"这条生产路径也被 e2e 走到；
 *   · 注册用快速 scrypt（N=1024；生产默认 N=16384 每次约 60ms，端到端无需承担）；
 *   · 全局限速放宽到极大值（本链路用请求数 ~200，默认 600 次/分/IP 会拦截）——
 *     限速语义本身由 `tests/api/api-auth.test.js` AU-8 专门覆盖，不在本夹具角色内；
 *   · 不 spawn 任何子进程、不用 `Math.random`（项目铁律）。
 *
 * 无 bot 断言口径（用户明令 "不许用占位 bot 敷衍"）：
 *   对局里出现的每个 `publicId` 都必须能由 `playerIdByPublicId` 从**档案索引**反查到 `pl_…` 真实 playerId，
 *   且该档案带真实出战快照（`activeSnapshotHash` + 快照库正文）。本夹具提供 `assertRealPlayers()` 做这件事。
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const itemsCore = require('../../server/core/items.js');
const serverMod = require('../../server/index.js');

// 端到端夹具默认鉴权配置：
//   · scrypt N=1024（生产 16384 每次约 60ms，端到端无需承担）；
//   · `rateLimitPerMinute` 放宽——本夹具的**同一 IP** 会注册/登录 8~10 次，会撞上生产默认的
//     "10 次/分/IP" 防护。该防护本身由 `tests/api/api-auth.test.js` AU-8 与 `server/auth.js`
//     的 `createFailureLimiter` 单测覆盖；夹具保留的是**锁定**语义（`maxFailures`/`lockMinutes`
//     仍为生产默认 5/5，故"连错 5 次 → 429 too_many_attempts"依旧是真的业务锁定）。
const FAST_AUTH = Object.freeze({
  auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 1000 },
});
const PASSWORD = 'pw12345678';
const RATE_LIMIT = 100000000; // 等价关闭全局限速（见文件头说明）
const BOX_TIMES_MAX = 100;    // server/box.js 上限（单次请求）

function makeTempDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dl-p7-5-'));
}

function removeTempDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

// HTTP 请求（body 为对象或字符串；headers 原样透传，鉴权用 { authorization: 'Bearer …' }）
function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const h = { ...(headers || {}) };
    if (body !== undefined && h['content-type'] === undefined) h['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      // 跨 chunk 多字节字符必须整段解码（`data += chunk` 会对每个 chunk 各自 toString → U+FFFD 假红）
      const chunks = [];
      res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: json, raw: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function authed(token) {
  return { authorization: `Bearer ${token}` };
}

// 起服务（随机端口 + 临时数据根）。start() 缺省端口 0 = 系统分配 → 不冲突。
// `config` / `configDir`：透传给 `server.start({ config })` → `store.openStore` —— 注意
//   `server/store/config.js` 的合并顺序是「文件 > 内置 > opts」，所以想覆盖某个**已存在于**
//   `server/data/service-config.json` 的键（如 `replayCacheSize`），必须走 `config`（它是最终覆盖，
//   在文件之后合并）；仅传 configDir 指向临时表也可，但需要把整张表复制过去。
async function startE2E(options) {
  const o = options || {};
  const dataDir = o.dataDir || makeTempDataDir(o.prefix);
  const s = await serverMod.start({
    logger: o.logger,
    port: 0,
    dataDir,
    authConfig: o.authConfig || FAST_AUTH,
    rateLimitPerMinute: o.rateLimitPerMinute === undefined ? RATE_LIMIT : o.rateLimitPerMinute,
    env: { DL_DATA_DIR: dataDir, ...(o.env || {}) },
    configDir: o.configDir,
    config: o.config,
    replayLimit: o.replayLimit,
  });
  const state = {
    server: s.server,
    port: s.port,
    store: s.store,
    runtime: s.runtime,
    dataDir,
    fastAuth: o.authConfig === undefined || o.authConfig === FAST_AUTH,
  };
  state.request = (method, urlPath, body, headers) => request(s.port, method, urlPath, body, headers);
  state.req = (method, urlPath, body, headers) => state.request(method, urlPath, body, headers);
  state.close = async () => {
    await s.close();
    removeTempDir(dataDir);
  };
  return state;
}

let usernameSeq = 0;

function uniqueName(tag) {
  usernameSeq += 1;
  const base = String(tag === undefined ? 'user' : tag).replace(/[^A-Za-z0-9_-]/g, '') || 'user';
  return `${base}${usernameSeq}`.slice(0, 24);
}

// 注册真实玩家（HTTP；返回 token/publicId，playerId 由调用方从档案库反查）
async function registerPlayer(s, tag, extra) {
  const o = extra || {};
  const username = o.username || uniqueName(tag);
  const password = o.password || PASSWORD;
  const body = { username, password };
  if (o.nickname !== undefined) body.nickname = o.nickname;
  const res = await s.request('POST', '/api/v1/auth/register', body);
  const data = res.body && res.body.ok ? res.body.data : null;
  return {
    res,
    status: res.status,
    username,
    password,
    token: data ? data.token : null,
    publicId: data ? data.publicId : null,
    nickname: data ? data.nickname : null,
  };
}

// publicId → playerId（§4.5：playerId 只作服务端内部标识，响应里绝不出现）
async function playerIdByPublicId(store, publicId) {
  for (const id of store.index.playerIds()) {
    const entry = store.index.get(id);
    if (entry && entry.publicId === publicId) return id;
  }
  return null;
}

// 玩家出战槽（快照 hash / configHash / loadout 正文）—— "真实档案"的可核对凭据
async function activeSlotOf(store, playerId) {
  const archive = await store.loadArchive(playerId);
  const slot = archive.configs.slots.find((x) => x.slotId === archive.configs.activeSlotId);
  const snapshot = await store.snapshot.get(slot.snapshot.hash);
  return {
    archive,
    slotId: slot.slotId,
    snapshotHash: slot.snapshot.hash,
    configHash: slot.snapshot.configHash,
    loadout: snapshot ? snapshot.loadout : null,
  };
}

/* ---------- 无 bot 证据链 ---------- */

// 断言：publicIds 里每个 id 都能反查到真实 playerId，且该档案有可用出战快照（非 bot 占位）
async function assertRealPlayers(store, publicIds, fail) {
  const ids = [...new Set(publicIds.filter((x) => typeof x === 'string' && x !== ''))];
  if (ids.length === 0) fail('无 bot 断言：对局里没有任何 publicId');
  const trace = [];
  for (const publicId of ids) {
    const playerId = await playerIdByPublicId(store, publicId);
    if (!playerId) fail(`publicId ${publicId} 无法从档案索引反查 playerId（疑似占位 bot）`);
    const archive = await store.loadArchive(playerId);
    if (!archive) fail(`publicId ${publicId}（${playerId}）档案不存在`);
    if (archive.flags && archive.flags.isBot) fail(`publicId ${publicId} 的档案 flags.isBot=true（bot 参与了对局）`);
    const slot = await activeSlotOf(store, playerId);
    if (!slot.loadout) fail(`publicId ${publicId} 出战快照正文缺失（无法证明是真实玩家）`);
    trace.push({ playerId, publicId, snapshotHash: slot.snapshotHash, isBot: false });
  }
  return trace;
}

/* ---------- 开箱 / 装配 / 出战配置（走真实端点与真实物品） ---------- */

// 开箱并合并进仓库（多次调用直至备齐 1 角色 + 3 技能；每次请求 ≤ BOX_TIMES_MAX）
async function openIntoWarehouse(s, token, seedBase, tier, needRole, needSkill) {
  const warehouse = itemsCore.emptyWarehouse();
  const opened = [];
  const wantRole = needRole === undefined ? 1 : needRole;
  const wantSkill = needSkill === undefined ? 3 : needSkill;
  let round = 0;
  while ((warehouse.buckets.role.length < wantRole || warehouse.buckets.skill.length < wantSkill) && round < 8) {
    const seed = seedBase + round * 977;
    const r = await s.request('POST', '/api/v1/box', { seed, tier, times: 12 }, authed(token));
    if (r.status !== 200) return { ok: false, res: r, warehouse, opened };
    for (const it of r.body.data.items) {
      if (!Array.isArray(warehouse.buckets[it.kind])) warehouse.buckets[it.kind] = [];
      warehouse.buckets[it.kind].push(it);
      opened.push(it);
    }
    round += 1;
  }
  return { ok: warehouse.buckets.role.length >= wantRole && warehouse.buckets.skill.length >= wantSkill, warehouse, opened, rounds: round };
}

// 仓库内按 uid 找物品（与 server/loadout.js findItem 同语义）
function findItem(warehouse, uid) {
  for (const list of Object.values((warehouse && warehouse.buckets) || {})) {
    if (!Array.isArray(list)) continue;
    const it = list.find((x) => x && x.uid === uid);
    if (it) return it;
  }
  return null;
}

// 逐槽装配（走 POST /warehouse/assemble；失败即跳过并记录原因——与 scripts/play.js 同风格）
async function assembleAll(s, token, warehouse, tier) {
  let cur = warehouse;
  const placed = [];
  const skipped = [];
  const targets = cur.buckets.role.concat(cur.buckets.skill);
  for (const t0 of targets) {
    for (let i = 0; i < (t0.slots || []).length; i++) {
      const target = findItem(cur, t0.uid);
      if (!target || !target.slots[i] || target.slots[i].pluginUid) continue;
      const kind = target.kind === 'role' ? 'rolePlugin' : 'skillPlugin';
      const cand = (cur.buckets[kind] || []).find((p) => p.slot === target.slots[i].type && p.equipped !== true);
      if (!cand) { skipped.push(`${target.uid}[${i}] 无 ${target.slots[i].type} 槽插件`); continue; }
      const r = await s.request('POST', '/api/v1/warehouse/assemble', {
        warehouse: cur, targetUid: target.uid, pluginUid: cand.uid, slotIndex: i, tier,
      }, authed(token));
      if (r.status === 200) {
        cur = r.body.data.warehouse;
        placed.push({ targetUid: target.uid, slotIndex: i, pluginUid: cand.uid });
      } else {
        skipped.push(`${target.uid}[${i}] ${r.body.error.code}`);
      }
    }
  }
  return { warehouse: cur, placed, skipped };
}

// 合并多个仓库（同一进程内双方共用一份 warehouse 只有测试/编排会这么做；生产由各自快照承担）
function mergeWarehouses(...list) {
  const out = itemsCore.emptyWarehouse();
  for (const wh of list) {
    for (const [k, arr] of Object.entries((wh && wh.buckets) || {})) {
      if (!Array.isArray(arr)) continue;
      if (!Array.isArray(out.buckets[k])) out.buckets[k] = [];
      out.buckets[k] = out.buckets[k].concat(arr);
    }
  }
  return out;
}

// 声明式 AI 程序（只含 base 节点：seq/action，任意段位合法；`action` 名为自由标签，D-80）
function programOf(statements) {
  return { type: 'program', version: 2, body: { type: 'seq', statements } };
}

function action(name) {
  return { type: 'action', name };
}

// 出战配置 = 角色 1 + 技能恰 3 + AI（**不携带装配引用**：见报告"后端缺陷 D1"）
function loadoutOf(warehouse, aiProgram) {
  const role = (warehouse.buckets.role || [])[0];
  const skills = (warehouse.buckets.skill || []).slice(0, 3);
  if (!role || skills.length < 3) return null;
  return { role, skills, ai: aiProgram === undefined ? programOf([action('move_right')]) : aiProgram };
}

// 「裸」出战配置：剥离槽内装配引用（保留 slots 类型结构）
function bareLoadout(loadout) {
  const copy = JSON.parse(JSON.stringify(loadout));
  for (const s of copy.role.slots || []) s.pluginUid = null;
  for (const sk of copy.skills || []) for (const s of sk.slots || []) s.pluginUid = null;
  return copy;
}

module.exports = {
  FAST_AUTH,
  PASSWORD,
  RATE_LIMIT,
  BOX_TIMES_MAX,
  makeTempDataDir,
  removeTempDir,
  request,
  authed,
  startE2E,
  uniqueName,
  registerPlayer,
  playerIdByPublicId,
  activeSlotOf,
  assertRealPlayers,
  openIntoWarehouse,
  findItem,
  assembleAll,
  mergeWarehouses,
  programOf,
  action,
  loadoutOf,
  bareLoadout,
};
