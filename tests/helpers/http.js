'use strict';
/* tests/helpers/http.js —— P7-4（B28~B33 HTTP/CLI 接线）测试夹具
 *
 * 职责（审查 P7-7 §② 建议的公共抽取）：`request` / `withServer` / 临时 `DL_DATA_DIR` /
 *        注册取 token / 取玩家 playerId 与出战快照 —— 供 `tests/api/api-*.test.js` 复用。
 *
 * 关键约定：
 *   · 数据根一律 `os.tmpdir()` 下的临时目录（**不污染仓库 runtime/**），close 后删除；
 *   · 注册用快速 scrypt（N=1024）——生产默认 N=16384 每次约 60ms；
 *   · `start()` 显式传 `dataDir` 才装配档案存储（P7-4 语义，见 server/index.js storeWanted）；
 *   · `playerId` 不对外返回（§4.5），测试需要时用 `playerIdByPublicId` 从索引反查。
 */
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const archiveMod = require('../../server/store/archive.js');

const FAST_AUTH = Object.freeze({ auth: { scrypt: { N: 1024, r: 8, p: 1 } } });
const PASSWORD = 'pw12345678';

function makeTempDataDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dl-p7-4-'));
}

function removeTempDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

// HTTP 请求（可选 headers；body 为对象或字符串）
function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const h = { ...(headers || {}) };
    if (body !== undefined && h['content-type'] === undefined) h['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
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

// 分块写入（Transfer-Encoding: chunked；请求体超限 413 的块式用例）
function requestChunks(port, urlPath, chunks, headers) {
  return new Promise((resolve, reject) => {
    const h = { 'content-type': 'application/json', 'transfer-encoding': 'chunked', ...(headers || {}) };
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: urlPath, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    for (const c of chunks) req.write(c);
    req.end();
  });
}

// 起一个可落盘的测试服务：{ port, baseUrl, logger, dataDir, store, runtime, cleanup }
async function startServer(options) {
  const o = options || {};
  const dataDir = o.dataDir || makeTempDataDir(o.prefix);
  const logger = o.logger || createLogger({ level: o.level || 'debug', ringSize: 20000 });
  const s = await serverMod.start({
    logger,
    dataDir,
    authConfig: o.authConfig || FAST_AUTH,
    ...(o.server || {}),
  });
  return {
    server: s.server,
    port: s.port,
    baseUrl: `http://127.0.0.1:${s.port}`,
    logger,
    dataDir,
    store: s.store,
    runtime: s.runtime,
    events: () => (typeof logger.records !== 'undefined' ? logger.records.map((r) => r.event) : []),
    cleanup: async () => {
      await s.close();
      removeTempDir(dataDir);
    },
  };
}

async function withServer(t, fn, options) {
  const s = await startServer(options);
  try {
    return await fn(s);
  } finally {
    await s.cleanup();
  }
}

let usernameSeq = 0;

function uniqueName(tag) {
  usernameSeq += 1;
  const base = String(tag === undefined ? 'user' : tag).replace(/[^A-Za-z0-9_-]/g, '') || 'user';
  return `${base}${usernameSeq}`.slice(0, 24);
}

// 注册一个玩家（走 HTTP；返回 token 便于后续鉴权用例）
async function register(port, username, password, extra) {
  const o = extra || {};
  const name = username || uniqueName(o.tag);
  const pw = password || PASSWORD;
  const body = { username: name, password: pw };
  if (o.nickname !== undefined) body.nickname = o.nickname;
  if (o.warehouse !== undefined) body.warehouse = o.warehouse;
  const r = await request(port, 'POST', '/api/v1/auth/register', body);
  const data = r.body && r.body.ok ? r.body.data : null;
  return {
    res: r,
    status: r.status,
    username: name,
    password: pw,
    token: data ? data.token : null,
    publicId: data ? data.publicId : null,
    nickname: data ? data.nickname : null,
  };
}

function authed(token) {
  return { authorization: `Bearer ${token}` };
}

// publicId → playerId（§4.5：playerId 只作服务端内部标识）
async function playerIdByPublicId(store, publicId) {
  for (const id of store.index.playerIds()) {
    const entry = store.index.get(id);
    if (entry && entry.publicId === publicId) return id;
  }
  return null;
}

// 玩家当前出战槽（快照 hash / configHash / loadout 正文）
async function activeSlotOf(store, playerId) {
  const archive = await store.loadArchive(playerId);
  const slot = archiveMod.activeSlot(archive);
  const snapshot = await store.snapshot.get(slot.snapshot.hash);
  return {
    archive,
    slotId: slot.slotId,
    snapshotHash: slot.snapshot.hash,
    configHash: slot.snapshot.configHash,
    loadout: snapshot ? snapshot.loadout : null,
  };
}

// 手工写一条 journal 对局记录（回放 410 分支：版本不匹配 / 快照缺失）
async function settleRecord(store, input) {
  return store.settleBattle(input);
}

module.exports = {
  FAST_AUTH,
  PASSWORD,
  makeTempDataDir,
  removeTempDir,
  request,
  requestChunks,
  startServer,
  withServer,
  uniqueName,
  register,
  authed,
  playerIdByPublicId,
  activeSlotOf,
  settleRecord,
};
