'use strict';
/* tests/api/api-admin.test.js —— P7-4（B33）管理端接线：POST /admin/*
 *
 * 契约：docs/interfaces.md §2（admin/bots、admin/rebuild-index 行 + 401/403）+ §7（DL_ADMIN_TOKEN）；
 *      docs/systems/11-account-store.md §7.6（bot 是管理员注入的**真实档案**）/§10.1。
 * 覆盖：DL_ADMIN_TOKEN 未配置 503 / 缺 token 与错 token 403 / 正确 token 正例（rebuild-index、stats、ban）
 *      / 调试注入双门控（DL_DEBUG_BOTS 默认关闭）/ 未知子端点 404 / 坏 JSON 400。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');

const ADMIN = 'admin-token-for-test';

test('AD-1 DL_ADMIN_TOKEN 未配置：管理端整体不可用（503 admin_token_missing）', async () => {
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'POST', '/api/v1/admin/rebuild-index', {});
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'admin_token_missing');
    // 注意顺序：调试注入先过 DL_DEBUG_BOTS 门控（默认关闭）→ 403 debug_bots_disabled，早于 token 校验
    const bots = await h.request(s.port, 'POST', '/api/v1/admin/bots', { count: 1 });
    assert.equal(bots.status, 403);
    assert.equal(bots.body.error.code, 'debug_bots_disabled');
    // stats 走 token 校验 → 503 admin_token_missing
    const stats = await h.request(s.port, 'POST', '/api/v1/admin/stats', {});
    assert.equal(stats.status, 503);
    assert.equal(stats.body.error.code, 'admin_token_missing');
  }, { server: { adminToken: '' } });
});

test('AD-2 缺 token / 错 token → 403 forbidden（不泄露 token 是否配置）', async () => {
  await h.withServer(null, async (s) => {
    const none = await h.request(s.port, 'POST', '/api/v1/admin/rebuild-index', {});
    assert.equal(none.status, 403);
    assert.equal(none.body.error.code, 'forbidden');
    const wrong = await h.request(s.port, 'POST', '/api/v1/admin/rebuild-index', {}, { 'x-admin-token': 'nope' });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.error.code, 'forbidden');
    const wrongBody = await h.request(s.port, 'POST', '/api/v1/admin/stats', { adminToken: 'nope' });
    assert.equal(wrongBody.status, 403);
    assert.ok(s.logger.records.some((x) => x.event === 'store.abuse.suspect' && x.data.op === 'admin.auth'), '未授权访问记 store.abuse.suspect(warn)');
  }, { server: { adminToken: ADMIN } });
});

test('AD-3 正确 token：rebuild-index 200 + stats 200 + 未知子端点 404 + 坏 JSON 400', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('ad'));
    const headers = { 'x-admin-token': ADMIN };
    const rebuild = await h.request(s.port, 'POST', '/api/v1/admin/rebuild-index', {}, headers);
    assert.equal(rebuild.status, 200, rebuild.raw);
    assert.equal(typeof rebuild.body.data.players, 'number');
    assert.ok(rebuild.body.data.players >= 1, '至少含刚注册的玩家');
    assert.ok(s.logger.records.some((x) => x.event === 'store.index.rebuild'));
    const stats = await h.request(s.port, 'POST', '/api/v1/admin/stats', {}, headers);
    assert.equal(stats.status, 200, stats.raw);
    assert.equal(stats.body.data.adapter, 'json');
    assert.equal(stats.body.data.players, rebuild.body.data.players);
    assert.equal(typeof stats.body.data.tiers.common, 'number');
    // token 也可经 Authorization: Bearer（运维脚本口径）
    const viaBearer = await h.request(s.port, 'POST', '/api/v1/admin/stats', {}, { authorization: `Bearer ${ADMIN}` });
    assert.equal(viaBearer.status, 200);
    const unknown = await h.request(s.port, 'POST', '/api/v1/admin/nope', {}, headers);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'unknown_endpoint');
    const badJson = await h.request(s.port, 'POST', '/api/v1/admin/rebuild-index', '{nope', headers);
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    // 管理端不返回玩家 playerId 的对象？—— 运维通道**返回** playerId（ban/clear 需要），此处仅断言不崩
    assert.equal(typeof u.publicId, 'string');
  }, { server: { adminToken: ADMIN } });
});

test('AD-4 bot 注入双门控：DL_DEBUG_BOTS 默认关闭 403；开启后注入真实档案（入池、isBot、幂等）', async () => {
  // 默认关闭
  await h.withServer(null, async (s) => {
    const off = await h.request(s.port, 'POST', '/api/v1/admin/bots', { count: 2, tier: 'common' }, { 'x-admin-token': ADMIN });
    assert.equal(off.status, 403);
    assert.equal(off.body.error.code, 'debug_bots_disabled');
  }, { server: { adminToken: ADMIN, env: { ...process.env, DL_DEBUG_BOTS: '' } } });
  // 显式开启
  await h.withServer(null, async (s) => {
    const headers = { 'x-admin-token': ADMIN };
    // playerIdPrefix 决定 bot 档案 id → 同前缀重复注入幂等（§7.6 幂等，admin.js 按 id 去重）
    const prefix = 'pl_abcdefabcdefabc';
    const injected = await h.request(s.port, 'POST', '/api/v1/admin/bots', { count: 2, tier: 'common', points: 50, botKey: 'it1', playerIdPrefix: prefix }, headers);
    assert.equal(injected.status, 200, injected.raw);
    assert.equal(injected.body.data.injected, 2);
    assert.equal(injected.body.data.skipped, 0);
    assert.equal(injected.body.data.debug, true);
    assert.equal(injected.body.data.bots.length, 2);
    assert.match(injected.body.data.bots[0].playerId, /^pl_[0-9a-f]{16}$/);
    assert.equal(typeof injected.body.data.bots[0].snapshotHash, 'string', 'bot 也是真实档案（冻结快照）');
    // 幂等：同 playerIdPrefix + botKey 再注入 → skipped
    const again = await h.request(s.port, 'POST', '/api/v1/admin/bots', { count: 2, tier: 'common', points: 50, botKey: 'it1', playerIdPrefix: prefix }, headers);
    assert.equal(again.body.data.injected, 0);
    assert.equal(again.body.data.skipped, 2);
    // 参数负例
    const badTier = await h.request(s.port, 'POST', '/api/v1/admin/bots', { count: 1, tier: 'platinum' }, headers);
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');
    const badCount = await h.request(s.port, 'POST', '/api/v1/admin/bots', { count: 0 }, headers);
    assert.equal(badCount.status, 400);
    assert.equal(badCount.body.error.code, 'bad_request');
    // 清理
    const cleared = await h.request(s.port, 'POST', '/api/v1/admin/clear-bots', {}, headers);
    assert.equal(cleared.status, 200, cleared.raw);
    assert.ok(cleared.body.data.removed >= 2);
    assert.ok(s.logger.records.some((x) => x.event === 'store.abuse.suspect' && x.data.op === 'injectDebugBots'));
  }, { server: { adminToken: ADMIN, env: { ...process.env, DL_DEBUG_BOTS: '1' } } });
});

test('AD-5 封禁/解封：admin ban → 该玩家登录与带 token 访问均 403 banned；unban 恢复', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('ban'));
    const playerId = await h.playerIdByPublicId(s.store, u.publicId);
    const headers = { 'x-admin-token': ADMIN };
    const banned = await h.request(s.port, 'POST', '/api/v1/admin/ban', { playerId }, headers);
    assert.equal(banned.status, 200, banned.raw);
    assert.equal(banned.body.data.banned, true);
    const login = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: u.username, password: u.password });
    assert.equal(login.status, 403);
    assert.equal(login.body.error.code, 'banned');
    const gone = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(u.token));
    assert.equal(gone.status, 401, '封禁内部撤销全部会话（§4.3）');
    const unbanned = await h.request(s.port, 'POST', '/api/v1/admin/unban', { playerId }, headers);
    assert.equal(unbanned.status, 200, unbanned.raw);
    assert.equal(unbanned.body.data.banned, false);
    const login2 = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: u.username, password: u.password });
    assert.equal(login2.status, 200);
    const nf = await h.request(s.port, 'POST', '/api/v1/admin/ban', { playerId: 'pl_0000000000000000' }, headers);
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, 'store_not_found');
  }, { server: { adminToken: ADMIN } });
});
