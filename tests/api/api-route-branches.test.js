'use strict';
/* tests/api/api-route-branches.test.js —— **接口的每一条链路每一个分支**（D-179）
 *
 * 背景（独立审计结论）：58 条路由**都**至少被一个用例命中过（成功路径没有缺口），
 *   但一批**错误分支**从未被任何用例走到 —— 那些分支今天能返回正确状态码，只是因为没人改坏过。
 *   本文件按审计清单逐条把缺口钉死：
 *   RB-1  401 unauthorized：全部需要 Bearer 的路由（此前 7 条从未在"无 token"下被调用）
 *   RB-2  401 unauthorized：**坏 token**（含非 tolerant 的 ranked/run|promote）
 *   RB-3  401 session_expired：过期会话（此前只在 GET /me 上断言过）
 *   RB-4  403 forbidden：请求体 playerId 与令牌不一致（此前只测过 2 条路由）
 *   RB-5  503 store_unavailable：未装配档案存储（此前只测过 /me 与 /leaderboard）
 *   RB-6  400 bad_json：请求体不是合法 JSON（16 条路由此前从未测过）
 *   RB-7  400 bad_request：畸形 URI 段（`%zz`）
 *   RB-8  404 unknown_endpoint：动态路由块的**穿透**（方法/形状不匹配）
 *   RB-9  503 admin_token_missing：`GET /replay/:id?frames=debug` 无管理员令牌
 *   RB-10 OPTIONS（未配 CORS）与 HEAD 的 404 语义
 *   RB-11 410 deprecated：遗留无状态端点逐个断言（此前只覆盖了子集）
 */
const test = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/http.js');
const authMod = require('../../server/auth.js');

const PW = h.PASSWORD;
const RELAXED = {
  authConfig: { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } },
  server: { rateLimitPerMinute: 100000 },
};

// 需要 Bearer 的路由（方法, 路径）—— 用于 RB-1/RB-3/RB-4/RB-6
const AUTH_ROUTES = [
  ['GET', '/api/v1/me'],
  ['GET', '/api/v1/me/configs'],
  ['GET', '/api/v1/me/warehouse'],
  ['GET', '/api/v1/me/ai'],
  ['GET', '/api/v1/me/ai/nodes'],
  ['GET', '/api/v1/me/records'],
  ['GET', '/api/v1/me/defense'],
  ['POST', '/api/v1/auth/logout'],
  ['POST', '/api/v1/auth/password'],
  ['POST', '/api/v1/auth/change-password'],
  ['POST', '/api/v1/me/configs'],
  ['POST', '/api/v1/me/records/seen'],
  ['POST', '/api/v1/me/seen'],
  ['POST', '/api/v1/me/box'],
  ['POST', '/api/v1/me/warehouse/assemble'],
  ['POST', '/api/v1/me/warehouse/disassemble'],
  ['POST', '/api/v1/me/warehouse/open-package'],
  ['POST', '/api/v1/me/ai'],
  ['POST', '/api/v1/me/ai/validate'],
  ['POST', '/api/v1/quick/run'],
  ['PUT', '/api/v1/me/nickname'],
  ['PUT', '/api/v1/me/warehouse'],
  ['PUT', '/api/v1/me/configs/slot1'],
  ['DELETE', '/api/v1/me/configs/slot1'],
  ['POST', '/api/v1/me/configs/slot1/activate'],
  ['PUT', '/api/v1/me/ai/ai_probe'],
  ['DELETE', '/api/v1/me/ai/ai_probe'],
];

test('RB-1 无 token → 全部需鉴权路由 401 unauthorized（含此前从未在无 token 下调用过的 7 条）', async () => {
  await h.withServer(null, async (s) => {
    for (const [method, path] of AUTH_ROUTES) {
      const r = await h.request(s.port, method, path, method === 'GET' ? undefined : {});
      assert.equal(r.status, 401, `${method} ${path} 应 401，实际 ${r.status} ${r.raw}`);
      assert.equal(r.body.error.code, 'unauthorized', `${method} ${path}`);
    }
  }, RELAXED);
});

test('RB-2 坏 token → 401 unauthorized（含非 tolerant 的 ranked/run、ranked/promote）', async () => {
  await h.withServer(null, async (s) => {
    const bad = { authorization: 'Bearer not-a-real-token' };
    const cases = [
      ['GET', '/api/v1/me'],
      ['GET', '/api/v1/me/configs'],
      ['GET', '/api/v1/me/ai/nodes'],
      ['POST', '/api/v1/ranked/run'],
      ['POST', '/api/v1/ranked/promote'],
      ['POST', '/api/v1/me/ai'],
      ['PUT', '/api/v1/me/configs/slot1'],
    ];
    for (const [method, path] of cases) {
      const r = await h.request(s.port, method, path, method === 'GET' ? undefined : {}, bad);
      assert.equal(r.status, 401, `${method} ${path} 应 401，实际 ${r.status} ${r.raw}`);
      assert.equal(r.body.error.code, 'unauthorized', `${method} ${path}`);
    }
    // tolerant 端点（归档回放/遗留回放）：坏 token 被忽略 → 不是 401
    const tolerant = await h.request(s.port, 'GET', '/api/v1/replay/r1', undefined, bad);
    assert.notEqual(tolerant.status, 401, 'tolerant 端点不该因坏 token 拒绝');
  }, RELAXED);
});

test('RB-3 过期会话 → 401 session_expired（多路由，不止 /me）', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('rb3'));
    const playerId = await h.playerIdByPublicId(s.store, u.publicId);
    const token = 'rb3-expired-token';
    const at = Date.now();
    s.store.sessions.put({
      tokenHash: authMod.tokenHashOf(token), playerId,
      createdAt: at - 100000, lastUsedAt: at - 100000, expiresAt: at - 1000,
    });
    for (const [method, path] of [['GET', '/api/v1/me'], ['GET', '/api/v1/me/configs'],
      ['GET', '/api/v1/me/warehouse'], ['GET', '/api/v1/me/ai'], ['GET', '/api/v1/me/ai/nodes'],
      ['POST', '/api/v1/quick/run'], ['POST', '/api/v1/ranked/run']]) {
      const r = await h.request(s.port, method, path, method === 'GET' ? undefined : {}, h.authed(token));
      assert.equal(r.status, 401, `${method} ${path} 应 401，实际 ${r.status}`);
      assert.equal(r.body.error.code, 'session_expired', `${method} ${path} 应是 session_expired（与"不存在"区分）`);
    }
  }, RELAXED);
});

test('RB-4 403 forbidden：请求体携带他人 playerId（跨全部收 body 的玩家路由）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('rb4a'));
    const b = await h.register(s.port, h.uniqueName('rb4b'));
    const other = await h.playerIdByPublicId(s.store, b.publicId);
    const cases = [
      ['POST', '/api/v1/me/configs', { playerId: other, name: 'x' }],
      ['PUT', '/api/v1/me/configs/slot1', { playerId: other }],
      ['DELETE', '/api/v1/me/configs/slot1', { playerId: other }],
      ['POST', '/api/v1/me/configs/slot1/activate', { playerId: other }],
      ['POST', '/api/v1/me/ai', { playerId: other, name: 'x' }],
      ['POST', '/api/v1/me/ai/validate', { playerId: other }],
      ['PUT', '/api/v1/me/ai/ai_probe', { playerId: other }],
      ['DELETE', '/api/v1/me/ai/ai_probe', { playerId: other }],
      ['POST', '/api/v1/me/warehouse/assemble', { playerId: other }],
      ['POST', '/api/v1/me/warehouse/disassemble', { playerId: other }],
      ['POST', '/api/v1/me/warehouse/open-package', { playerId: other, packageUids: [] }],
      ['PUT', '/api/v1/me/warehouse', { playerId: other }],
      ['PUT', '/api/v1/me/nickname', { playerId: other, nickname: 'x' }],
      ['POST', '/api/v1/me/records/seen', { playerId: other, uptoSeq: 1 }],
      ['POST', '/api/v1/me/seen', { playerId: other, uptoSeq: 1 }],
      ['POST', '/api/v1/me/box', { playerId: other, times: 1 }],
      ['POST', '/api/v1/quick/run', { playerId: other }],
      ['POST', '/api/v1/ranked/run', { playerId: other }],
      ['POST', '/api/v1/ranked/promote', { playerId: other }],
    ];
    for (const [method, path, body] of cases) {
      const r = await h.request(s.port, method, path, body, h.authed(a.token));
      assert.equal(r.status, 403, `${method} ${path} 应 403，实际 ${r.status} ${r.raw}`);
      assert.equal(r.body.error.code, 'forbidden', `${method} ${path}`);
    }
    // 自己的 playerId 不受影响（同一路径应该走到业务分支而不是 403）
    const own = await h.request(s.port, 'POST', '/api/v1/me/box', { playerId: await h.playerIdByPublicId(s.store, a.publicId), times: 1 }, h.authed(a.token));
    assert.notEqual(own.status, 403, '自己的 playerId 不该被拦');
  }, RELAXED);
});

test('RB-5 503 store_unavailable：未装配档案存储时全部 store 路由一致 503', async () => {
  await h.withServer(null, async (s) => {
    const storeRoutes = [
      ['GET', '/api/v1/me'], ['GET', '/api/v1/me/configs'], ['GET', '/api/v1/me/warehouse'],
      ['GET', '/api/v1/me/ai'], ['GET', '/api/v1/me/ai/nodes'], ['GET', '/api/v1/me/records'],
      ['GET', '/api/v1/me/defense'], ['GET', '/api/v1/leaderboard'],
      ['POST', '/api/v1/auth/register'], ['POST', '/api/v1/auth/login'],
      ['POST', '/api/v1/auth/logout'], ['POST', '/api/v1/auth/password'],
      ['POST', '/api/v1/me/configs'], ['POST', '/api/v1/me/records/seen'],
      ['POST', '/api/v1/me/box'], ['POST', '/api/v1/me/warehouse/assemble'],
      ['POST', '/api/v1/me/warehouse/disassemble'], ['POST', '/api/v1/me/warehouse/open-package'],
      ['POST', '/api/v1/me/ai'], ['POST', '/api/v1/me/ai/validate'],
      ['POST', '/api/v1/quick/run'], ['PUT', '/api/v1/me/nickname'], ['PUT', '/api/v1/me/warehouse'],
      ['PUT', '/api/v1/me/configs/slot1'], ['DELETE', '/api/v1/me/configs/slot1'],
      ['POST', '/api/v1/me/configs/slot1/activate'],
      ['PUT', '/api/v1/me/ai/ai_probe'], ['DELETE', '/api/v1/me/ai/ai_probe'],
    ];
    for (const [method, path] of storeRoutes) {
      const r = await h.request(s.port, method, path, method === 'GET' ? undefined : {});
      assert.equal(r.status, 503, `${method} ${path} 应 503，实际 ${r.status} ${r.raw}`);
      assert.equal(r.body.error.code, 'store_unavailable', `${method} ${path}`);
    }
    // ranked/* 是**例外**（设计如此）：未装配 store 时回落到遗留无状态口径 → 业务错，而不是 503。
    //   这里把它钉死，避免以后误以为"漏了 503 分支"。
    const rankedRun = await h.request(s.port, 'POST', '/api/v1/ranked/run', {});
    assert.equal(rankedRun.status, 409, `无 store 时 ranked/run 应回落无状态口径（409），实际 ${rankedRun.status}`);
    assert.equal(rankedRun.body.error.code, 'no_loadout');
    const rankedPromote = await h.request(s.port, 'POST', '/api/v1/ranked/promote', {});
    assert.equal(rankedPromote.status, 400, `无 store 时 ranked/promote 应回落无状态口径（400 校验），实际 ${rankedPromote.status}`);
    assert.equal(rankedPromote.body.error.code, 'bad_tier');
    // store:false 的基础设施端点不受影响（零回归）
    assert.equal((await h.request(s.port, 'GET', '/api/v1/health')).status, 200);
    assert.equal((await h.request(s.port, 'GET', '/api/v1/data/battle-config')).status, 200);
  }, { server: { enableStore: false, dataDir: undefined, env: {}, rateLimitPerMinute: 100000 } });
});

test('RB-6 400 bad_json：请求体不是合法 JSON（逐路由断言，此前 16 条从未测过）', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('rb6'));
    const authed = h.authed(u.token);
    const routes = [
      ['POST', '/api/v1/auth/register', null],
      ['POST', '/api/v1/auth/login', null],
      ['POST', '/api/v1/auth/password', authed],
      ['POST', '/api/v1/auth/change-password', authed],
      ['POST', '/api/v1/log-level', null],
      ['POST', '/api/v1/ai/validate', null],
      ['POST', '/api/v1/ai/compile', null],
      ['POST', '/api/v1/ai/battle', null],
      ['POST', '/api/v1/box', null],
      ['POST', '/api/v1/warehouse/assemble', null],
      ['POST', '/api/v1/warehouse/disassemble', null],
      ['POST', '/api/v1/loadout', null],
      ['POST', '/api/v1/panel', null],
      ['POST', '/api/v1/battle', null],
      ['POST', '/api/v1/ranked/run', authed],
      ['POST', '/api/v1/ranked/promote', authed],
      ['POST', '/api/v1/me/configs', authed],
      ['POST', '/api/v1/me/records/seen', authed],
      ['POST', '/api/v1/me/seen', authed],
      ['POST', '/api/v1/me/box', authed],
      ['POST', '/api/v1/me/warehouse/assemble', authed],
      ['POST', '/api/v1/me/warehouse/disassemble', authed],
      ['POST', '/api/v1/me/warehouse/open-package', authed],
      ['POST', '/api/v1/me/ai', authed],
      ['POST', '/api/v1/me/ai/validate', authed],
      ['PUT', '/api/v1/me/nickname', authed],
      ['PUT', '/api/v1/me/warehouse', authed],
      ['PUT', '/api/v1/me/configs/slot1', authed],
      ['PUT', '/api/v1/me/ai/ai_probe', authed],
    ];
    for (const [method, path, headers] of routes) {
      const r = await h.request(s.port, method, path, '{nope', headers || undefined);
      assert.equal(r.status, 400, `${method} ${path} 应 400，实际 ${r.status} ${r.raw.slice(0, 120)}`);
      assert.equal(r.body.error.code, 'bad_json', `${method} ${path}`);
    }
  }, RELAXED);
});

test('RB-7 400 bad_request：畸形 URI 段（%zz）按"同类输入同一判据"拒绝', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('rb7'));
    const authed = h.authed(u.token);
    for (const [method, path] of [
      ['PUT', '/api/v1/me/configs/%zz'],
      ['DELETE', '/api/v1/me/configs/%zz'],
      ['POST', '/api/v1/me/configs/%zz/activate'],
      ['PUT', '/api/v1/me/ai/%zz'],
      ['DELETE', '/api/v1/me/ai/%zz'],
    ]) {
      const r = await h.request(s.port, method, path, {}, authed);
      assert.equal(r.status, 400, `${method} ${path} 应 400，实际 ${r.status} ${r.raw.slice(0, 120)}`);
      assert.equal(r.body.error.code, 'bad_request', `${method} ${path}`);
    }
    // `%2F` 解码成 `/` 的形态必须一并拒绝（与 /me/ai/:aiId、/replay/:id、/data/:table 同口径）
    for (const [method, path] of [
      ['PUT', '/api/v1/me/ai/a%2Fb'],
      ['DELETE', '/api/v1/me/configs/a%2Fb'],
      ['PUT', '/api/v1/me/configs/a%2Fb'],
      ['POST', '/api/v1/me/configs/a%2Fb/activate'],
      ['PUT', '/api/v1/me/configs/..'],
      ['DELETE', '/api/v1/me/ai/..'],
    ]) {
      const r = await h.request(s.port, method, path, {}, authed);
      assert.equal(r.status, 400, `${method} ${path} 应 400，实际 ${r.status} ${r.raw.slice(0, 120)}`);
      assert.equal(r.body.error.code, 'bad_request', `${method} ${path}`);
    }
  }, RELAXED);
});

test('RB-8 动态路由块的穿透：方法/形状不匹配 → 404 unknown_endpoint', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('rb8'));
    const authed = h.authed(u.token);
    const cases = [
      ['POST', '/api/v1/me/ai/nodes'],          // /me/ai/ 前缀命中，但无 POST 分支
      ['DELETE', '/api/v1/me/ai/nodes'],
      ['GET', '/api/v1/me/ai/ai_x'],            // 只有 PUT/DELETE 的 aiId 分支
      ['POST', '/api/v1/me/configs/slot1'],     // 配置槽只有 PUT/DELETE/POST-activate
      ['PUT', '/api/v1/me/configs/slot1/activate'],
      ['DELETE', '/api/v1/me/configs/slot1/activate'],
      ['GET', '/api/v1/me/configs/slot1'],
      ['GET', '/api/anything.js'],              // /api/* 永不进静态分支
      ['HEAD', '/api/v1/health'],               // 未登记的方法
    ];
    for (const [method, path] of cases) {
      const r = await h.request(s.port, method, path, method === 'GET' || method === 'HEAD' ? undefined : {}, authed);
      assert.equal(r.status, 404, `${method} ${path} 应 404，实际 ${r.status} ${r.raw.slice(0, 120)}`);
      if (method === 'HEAD') continue;   // HEAD 按 HTTP 规范不带响应体（Node 会剥掉）
      // 两种 404 语义：静态表未命中 = unknown_endpoint；被当成 aiId/槽位查了库 = store_not_found
      const code = r.body === null ? '(空体)' : r.body.error.code;
      assert.ok(code === 'unknown_endpoint' || code === 'store_not_found',
        `${method} ${path} 应是 404 信封（unknown_endpoint/store_not_found），实际 ${code}：${r.raw.slice(0, 120)}`);
    }
    // 语义分别钉死：形状不匹配 → unknown_endpoint；被当成 aiId → store_not_found
    const notFound = await h.request(s.port, 'POST', '/api/v1/me/configs/slot1', {}, authed);
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error.code, 'unknown_endpoint', 'POST 到配置槽不是已登记的形状');
    const asAiId = await h.request(s.port, 'PUT', '/api/v1/me/ai/validate', {}, authed);
    assert.equal(asAiId.status, 400, 'PUT /me/ai/validate 会被当成 aiId=validate 走更新分支（空体先 400 bad_request）');
    assert.equal(asAiId.body.error.code, 'bad_request');
    const asAiId2 = await h.request(s.port, 'PUT', '/api/v1/me/ai/validate', { name: 'x' }, authed);
    assert.equal(asAiId2.status, 404, '带着合法字段时才会走到"库内无此 aiId"');
    assert.equal(asAiId2.body.error.code, 'store_not_found');
    const deletedNodes = await h.request(s.port, 'DELETE', '/api/v1/me/ai/nodes', {}, authed);
    assert.equal(deletedNodes.status, 404);
    assert.equal(deletedNodes.body.error.code, 'store_not_found', 'DELETE /me/ai/nodes 会被当成 aiId=nodes');
  }, RELAXED);
});

test('RB-9 503 admin_token_missing：frames=debug 无管理员令牌', async () => {
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'GET', '/api/v1/replay/r1?frames=debug');
    assert.equal(r.status, 503, `应 503，实际 ${r.status} ${r.raw.slice(0, 160)}`);
    assert.equal(r.body.error.code, 'admin_token_missing');
  }, { server: { enableStore: false, dataDir: undefined, env: {}, rateLimitPerMinute: 100000 } });
});

test('RB-10 OPTIONS（未配 CORS）与未知端点：404 unknown_endpoint', async () => {
  await h.withServer(null, async (s) => {
    const opt = await h.request(s.port, 'OPTIONS', '/api/v1/me', undefined, { origin: 'http://x.test' });
    assert.equal(opt.status, 404, `未配 DL_CORS_ORIGIN 时 OPTIONS 应 404，实际 ${opt.status}`);
    assert.equal(opt.body.error.code, 'unknown_endpoint');
    const unknown = await h.request(s.port, 'GET', '/api/v1/nope');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'unknown_endpoint');
  }, RELAXED);
});

test('RB-12 HTTP 解析层错误也必须是 JSON 信封（不是空 400）', async () => {
  const net = require('node:net');
  await h.withServer(null, async (s) => {
    // 无 content-length / 无 chunk 框架的请求体 → 解析层把体当成下一行的请求行（HPE_INVALID_METHOD）
    const raw = await new Promise((resolve, reject) => {
      const sock = net.connect(s.port, '127.0.0.1', () => {
        sock.write('DELETE /api/v1/me HTTP/1.1\r\nhost: 127.0.0.1\r\ncontent-type: application/json\r\n\r\n{}');
      });
      const chunks = [];
      sock.on('data', (c) => chunks.push(c));
      sock.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      sock.on('error', reject);
      setTimeout(() => { try { sock.destroy(); } catch (e) { /* 忽略 */ } resolve(Buffer.concat(chunks).toString('utf8')); }, 1500);
    });
    assert.match(raw, /^HTTP\/1\.1 400/, `应是 400：${raw.slice(0, 120)}`);
    assert.match(raw, /content-type: application\/json/i, `解析层错误也必须有 JSON content-type：${raw.slice(0, 200)}`);
    const body = raw.slice(raw.indexOf('\r\n\r\n') + 4);
    const parsed = JSON.parse(body);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'bad_request', `应是 bad_request 信封：${body}`);
  }, RELAXED);
});

test('RB-11 410 deprecated：遗留无状态端点逐个断言（DL_LEGACY_STATELESS=0）', async () => {
  await h.withServer(null, async (s) => {
    const cases = [
      ['GET', '/api/v1/warehouse'],
      ['GET', '/api/v1/loadout'],
      ['POST', '/api/v1/box'],
      ['POST', '/api/v1/loadout'],
      ['POST', '/api/v1/panel'],
      ['POST', '/api/v1/battle'],
      ['POST', '/api/v1/ai/validate'],
      ['POST', '/api/v1/ai/compile'],
      ['POST', '/api/v1/ai/battle'],
      ['POST', '/api/v1/warehouse/assemble'],
      ['POST', '/api/v1/warehouse/disassemble'],
    ];
    for (const [method, path] of cases) {
      const r = await h.request(s.port, method, path, method === 'GET' ? undefined : {});
      assert.equal(r.status, 410, `${method} ${path} 应 410，实际 ${r.status} ${r.raw.slice(0, 120)}`);
      assert.equal(r.body.error.code, 'deprecated', `${method} ${path}`);
    }
    // 基础设施端点不受影响
    assert.equal((await h.request(s.port, 'GET', '/api/v1/health')).status, 200);
    assert.equal((await h.request(s.port, 'GET', '/api/v1/data/battle-config')).status, 200);
  }, { server: { legacyStateless: false, rateLimitPerMinute: 100000 } });
});
