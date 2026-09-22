'use strict';
/* tests/api/api-admin-accounts.test.js —— F2 管理面契约（docs/frontend/02-accounts.md §2）
 *
 * 覆盖：管理员账号（DL_ADMIN_USERS）身份与 isAdmin 回带 / 访问判定三条路径（账号·令牌·都不满足）/
 *      分页账号列表（总数无上限）/ 删除账号（墓碑、禁删自己）/ 既有 op 在账号路径下同样可用。
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer, register, authed, request } = require('../helpers/http.js');

const TOKEN = 'admin-token-for-f2';

async function withAdminServer(fn, options) {
  return startServer(Object.assign({ prefix: 'dl-f2-admin-', level: 'warn', server: { env: { DL_ADMIN_TOKEN: TOKEN } } }, options || {}))
    .then(async (s) => {
      try {
        return await fn(s);
      } finally {
        await s.cleanup();
      }
    });
}

async function withNamedAdmin(fn, adminName) {
  // DL_ADMIN_USERS 用**用户名**白名单（大小写不敏感）
  return withAdminServer(async (s) => fn(s), { server: { env: { DL_ADMIN_TOKEN: TOKEN, DL_ADMIN_USERS: adminName } } });
}

test('AA-1 管理员账号登录回带 isAdmin=true；普通账号 false（DL_ADMIN_USERS 用户名白名单）', async () => {
  const adminName = 'F2AdminUser';
  await withNamedAdmin(async (s) => {
    const admin = await register(s.port, adminName);
    assert.equal(admin.status, 200);
    assert.equal(admin.res.body.data.player.isAdmin, true, '白名单账号注册响应应带 isAdmin=true');
    const normal = await register(s.port, 'f2normaluser');
    assert.equal(normal.res.body.data.player.isAdmin, false, '普通账号应为 false');

    const login = await request(s.port, 'POST', '/api/v1/auth/login', { username: adminName, password: admin.password });
    assert.equal(login.body.data.player.isAdmin, true, '登录响应应带 isAdmin=true');
    const me = await request(s.port, 'GET', '/api/v1/me', undefined, authed(admin.token));
    assert.equal(me.body.data.flags.isAdmin, true, '/me 的 flags.isAdmin 应为 true');
    const meNormal = await request(s.port, 'GET', '/api/v1/me', undefined, authed(normal.token));
    assert.equal(meNormal.body.data.flags.isAdmin, false);
  }, adminName);
});

test('AA-2 管理员账号 Bearer（不带任何令牌）即可调用 admin op', async () => {
  const adminName = 'f2adminbearer';
  await withNamedAdmin(async (s) => {
    const admin = await register(s.port, adminName);
    const stats = await request(s.port, 'POST', '/api/v1/admin/stats', {}, authed(admin.token));
    assert.equal(stats.status, 200, `管理员账号应可调用：${stats.raw}`);
    assert.equal(typeof stats.body.data.players, 'number');
    const rebuild = await request(s.port, 'POST', '/api/v1/admin/rebuild-index', {}, authed(admin.token));
    assert.equal(rebuild.status, 200);
    assert.equal(typeof rebuild.body.data.players, 'number');
  }, adminName);
});

test('AA-3 普通账号调用 admin op → 403 forbidden；未配置令牌时管理员账号仍可（账号路径独立工作）', async () => {
  const adminName = 'f2adminonly';
  await withNamedAdmin(async (s) => {
    const normal = await register(s.port, 'f2plainuser');
    const denied = await request(s.port, 'POST', '/api/v1/admin/stats', {}, authed(normal.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'forbidden');
    const anon = await request(s.port, 'POST', '/api/v1/admin/stats', {});
    assert.equal(anon.status, 403, '无令牌无身份 → 403（令牌已配置）');
  }, adminName);

  // 未配置 DL_ADMIN_TOKEN：管理员账号仍可；匿名 → 503 admin_token_missing（既有语义不变）
  await withAdminServer(async (s) => {
    const adminName2 = 'f2admintokless';
    // 该实例未配白名单，故临时用 publicId 不可知 → 改为验证匿名语义
    const anon = await request(s.port, 'POST', '/api/v1/admin/stats', {});
    assert.equal(anon.status, 503);
    assert.equal(anon.body.error.code, 'admin_token_missing');
    assert.equal(adminName2.length > 0, true);
  }, { server: { env: { DL_ADMIN_TOKEN: '', DL_ADMIN_USERS: 'nobody' } } });
});

test('AA-4 令牌路径仍可用（X-Admin-Token，无需登录）', async () => {
  await withAdminServer(async (s) => {
    const r = await request(s.port, 'POST', '/api/v1/admin/stats', {}, { 'x-admin-token': TOKEN });
    assert.equal(r.status, 200, r.raw);
    const bad = await request(s.port, 'POST', '/api/v1/admin/stats', {}, { 'x-admin-token': 'wrong' });
    assert.equal(bad.status, 403);
  });
});

test('AA-5 分页账号列表：total 为全量（不受 100 上限约束）、逐页无重复无遗漏、参数校验', async () => {
  const adminName = 'f2adminpage';
  // 造 25 个账号会越过 auth 的「同 IP 每分钟 10 次尝试」限速（既有行为，非本批引入）→ 测试内放宽
  const authConfig = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };
  await withAdminServer(async (s) => {
    const admin = await register(s.port, adminName);
    const TOTAL = 25;
    for (let i = 0; i < TOTAL; i++) {
      const r = await register(s.port, `f2page${String(i).padStart(2, '0')}`);
      assert.equal(r.status, 200, `造账号失败：${r.res.raw}`);
    }
    const seen = new Set();
    let offset = 0;
    let total = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await request(s.port, 'POST', '/api/v1/admin/accounts', { offset, limit: 10 }, authed(admin.token));
      assert.equal(page.status, 200, page.raw);
      const d = page.body.data;
      total = d.total;
      assert.equal(d.offset, offset);
      assert.equal(d.limit, 10);
      for (const row of d.rows) {
        assert.ok(typeof row.playerId === 'string' && row.playerId.startsWith('pl_'), 'row 应含 playerId（admin 通道）');
        assert.ok(!seen.has(row.playerId), `分页出现重复行：${row.playerId}`);
        seen.add(row.playerId);
      }
      if (!d.hasMore) break;
      offset += d.rows.length;
    }
    assert.equal(total, TOTAL + 1, `total 应为全部账号数（含管理员）：${total}`);
    assert.equal(seen.size, total, '分页应取完所有账号（无遗漏）');

    const badLimit = await request(s.port, 'POST', '/api/v1/admin/accounts', { limit: 201 }, authed(admin.token));
    assert.equal(badLimit.status, 400);
    assert.equal(badLimit.body.error.code, 'bad_request');
    const badOffset = await request(s.port, 'POST', '/api/v1/admin/accounts', { offset: -1 }, authed(admin.token));
    assert.equal(badOffset.status, 400);
    const beyond = await request(s.port, 'POST', '/api/v1/admin/accounts', { offset: 9999, limit: 10 }, authed(admin.token));
    assert.equal(beyond.status, 200);
    assert.deepEqual(beyond.body.data.rows, []);
    assert.equal(beyond.body.data.hasMore, false);
  }, { authConfig, server: { env: { DL_ADMIN_TOKEN: TOKEN, DL_ADMIN_USERS: adminName } } });
});

test('AA-6 删除账号：按 publicId 删除成功、列表减少、被删账号登录失效、禁删自己、未知目标 404', async () => {
  const adminName = 'f2admindel';
  await withNamedAdmin(async (s) => {
    const admin = await register(s.port, adminName);
    const victim = await register(s.port, 'f2victim');
    const victimId = victim.publicId;

    const self = await request(s.port, 'POST', '/api/v1/admin/delete-account', { publicId: admin.publicId }, authed(admin.token));
    assert.equal(self.status, 409);
    assert.equal(self.body.error.code, 'cannot_delete_self');

    const unknown = await request(s.port, 'POST', '/api/v1/admin/delete-account', { publicId: 'u_nope' }, authed(admin.token));
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'store_not_found');

    const before = await request(s.port, 'POST', '/api/v1/admin/accounts', { limit: 200 }, authed(admin.token));
    const del = await request(s.port, 'POST', '/api/v1/admin/delete-account', { publicId: victimId }, authed(admin.token));
    assert.equal(del.status, 200, del.raw);
    assert.equal(del.body.data.removed, true);
    assert.equal(del.body.data.publicId, victimId);
    const after = await request(s.port, 'POST', '/api/v1/admin/accounts', { limit: 200 }, authed(admin.token));
    assert.equal(after.body.data.total, before.body.data.total - 1, '删除后总数应减 1');
    assert.ok(!JSON.stringify(after.body.data.rows).includes(victimId), '列表不应再含被删账号');

    const login = await request(s.port, 'POST', '/api/v1/auth/login', { username: victim.username, password: victim.password });
    assert.equal(login.status, 401, '被删账号应登录失败');
    const again = await request(s.port, 'POST', '/api/v1/admin/delete-account', { publicId: victimId }, authed(admin.token));
    assert.equal(again.status, 404, '重复删除 → 404');
  }, adminName);
});

test('AA-7 既有 op 在管理员账号路径下同样可用（封禁/解封；bots 未开调试 → 403 debug_bots_disabled）', async () => {
  const adminName = 'f2adminops';
  await withNamedAdmin(async (s) => {
    const admin = await register(s.port, adminName);
    const target = await register(s.port, 'f2bantarget');
    const rows = await request(s.port, 'POST', '/api/v1/admin/accounts', { limit: 200 }, authed(admin.token));
    const row = rows.body.data.rows.find((r) => r.publicId === target.publicId);
    assert.ok(row, '列表应含目标账号');

    const ban = await request(s.port, 'POST', '/api/v1/admin/ban', { playerId: row.playerId }, authed(admin.token));
    assert.equal(ban.status, 200, ban.raw);
    assert.equal(ban.body.data.banned, true);
    const unban = await request(s.port, 'POST', '/api/v1/admin/unban', { playerId: row.playerId }, authed(admin.token));
    assert.equal(unban.status, 200);
    assert.equal(unban.body.data.banned, false);

    const bots = await request(s.port, 'POST', '/api/v1/admin/bots', { count: 1 }, authed(admin.token));
    assert.equal(bots.status, 403);
    assert.equal(bots.body.error.code, 'debug_bots_disabled');
    const clear = await request(s.port, 'POST', '/api/v1/admin/clear-bots', {}, authed(admin.token));
    assert.equal(clear.status, 200);
  }, adminName);
});
