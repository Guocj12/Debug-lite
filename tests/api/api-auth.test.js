'use strict';
/* tests/api/api-auth.test.js —— P7-4（B28）鉴权接线：/auth/* + Bearer 中间件
 *
 * 契约：docs/systems/11-account-store.md §4（身份与鉴权）/§10.1（端点总表）/§10.3（错误码）
 *      docs/interfaces.md §2（/auth/* 行 + 401/403/409/429 语义）
 * 覆盖：注册/登录/登出/改密正例 + 负例（弱密码、非法用户名、重名、坏 JSON、坏 token、过期 token、
 *      连续失败锁定 429、全局限速 429、越权 403、**HTTP 层并发注册 P0 负例**）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');
const authMod = require('../../server/auth.js');

const PW = h.PASSWORD;

test('AU-1 注册：200 信封 + 下发 token/默认配置 + playerId 不外泄 + store.auth.register 日志', async () => {
  await h.withServer(null, async (s) => {
    const username = h.uniqueName('reg');
    const r = await h.request(s.port, 'POST', '/api/v1/auth/register', { username, password: PW, nickname: '调试员' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.nickname, '调试员');
    assert.equal(typeof r.body.data.token, 'string');
    assert.ok(r.body.data.token.length >= 40, 'token 应为 32 随机字节 base64url');
    assert.equal(typeof r.body.data.expiresAt, 'number');
    assert.equal(r.body.data.player.publicId, r.body.data.publicId);
    assert.equal(r.body.data.player.tier, 'common');
    assert.equal(r.body.data.player.points, 0);
    // §4.5：playerId 绝不出现在任何响应里
    assert.ok(!r.raw.includes('pl_'), `响应不得含 playerId：${r.raw.slice(0, 200)}`);
    assert.equal(r.body.data.playerId, undefined);
    // 日志：api.req/api.res + store.auth.register（通道 store）
    assert.ok(s.logger.records.some((x) => x.event === 'api.req' && x.data.path === '/api/v1/auth/register'));
    assert.ok(s.logger.records.some((x) => x.event === 'api.res' && x.data.status === 200));
    assert.ok(s.logger.records.some((x) => x.event === 'store.auth.register'));
    // D-159：注册即发 starter 并**建满 3 个槽** —— slot1 = starter 完整出战配置（快照已冻结、快照自带装配引用
    //   摘录），slot2/slot3 = 空槽（`snapshotHash: null`），出战仍是 slot1（D-160：非出战槽允许不完整）。
    const me = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(r.body.data.token));
    assert.equal(me.status, 200);
    assert.equal(me.body.data.activeSlotId, 'slot1');
    assert.equal(me.body.data.slots.length, 3, 'D-159：注册即建满 3 个槽');
    assert.deepEqual(me.body.data.slots.map((s) => s.slotId), ['slot1', 'slot2', 'slot3']);
    assert.equal(me.body.data.slots[0].isDefault, true);
    assert.equal(typeof me.body.data.slots[0].snapshotHash, 'string', 'slot1 出战槽必有已冻结快照');
    assert.equal(me.body.data.slots[1].snapshotHash, null, 'D-160：非出战空槽无快照');
    assert.equal(me.body.data.slots[2].snapshotHash, null, 'D-160：非出战空槽无快照');
    // D-159：starter 自带服务端权威仓库 → 已校验（不再等待客户端提交仓库镜像）
    assert.equal(me.body.data.flags.unverifiedLoadout, false, 'D-159：starter 已发仓库 → unverifiedLoadout=false');
    // D-159：starter 仓库四桶非空 + starterIssued 标记（GET /me/warehouse = 真源）
    const wh = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(r.body.data.token));
    assert.equal(wh.status, 200, wh.raw);
    assert.equal(wh.body.data.starterIssued, true);
    assert.ok(wh.body.data.counts.role >= 1, 'starter 至少 1 个角色物品');
    assert.equal(wh.body.data.counts.skill, 3, 'starter 恰 3 个技能物品');
    assert.ok(wh.body.data.counts.rolePlugin >= 1, 'starter 至少 1 个角色插件');
    assert.equal(wh.body.data.counts.skillPlugin, 1, 'starter 恰 1 个技能插件');
    assert.equal(wh.body.data.caps.role, 500);
    // D-161：starter 同时登记一条默认 AI（名字 '新手AI'），并被出战配置 slot1 引用
    const ai = await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(r.body.data.token));
    assert.equal(ai.status, 200, ai.raw);
    assert.equal(ai.body.data.count, 1);
    assert.equal(ai.body.data.max, 100);
    assert.equal(ai.body.data.items[0].name, '新手AI');
    assert.deepEqual(ai.body.data.usage[ai.body.data.items[0].aiId], ['slot1'], 'D-161：starter AI 被出战配置引用');
    // GET /me/configs：3 套配置正文；slot1 完整（有快照），slot2/slot3 空且无快照
    const cfgs = await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(r.body.data.token));
    assert.equal(cfgs.status, 200, cfgs.raw);
    assert.equal(cfgs.body.data.slots.length, 3);
    assert.equal(cfgs.body.data.slots[0].loadout.skills.length, 3);
    assert.equal(cfgs.body.data.slots[0].loadout.aiId, ai.body.data.items[0].aiId, 'slot1 的 loadout.aiId 指向库内默认 AI');
    assert.equal(typeof cfgs.body.data.slots[0].snapshot.hash, 'string');
    assert.deepEqual(cfgs.body.data.slots[1].loadout, { role: null, skills: [null, null, null], ai: null }, 'D-160：新建/注册出的空槽形状');
    assert.equal(cfgs.body.data.slots[1].snapshot, null);
    assert.equal(cfgs.body.data.slots[2].snapshot, null);
    // 鉴权后的请求把 publicId 记进 api.req/api.res（§4.6 脱敏口径：只记 publicId，不记 token）
    assert.ok(s.logger.records.some((x) => x.event === 'api.req' && x.data.path === '/api/v1/me' && x.data.publicId === r.body.data.publicId), 'api.req 带 publicId');
    assert.ok(s.logger.records.some((x) => x.event === 'api.res' && x.data.path === '/api/v1/me' && x.data.publicId === r.body.data.publicId), 'api.res 带 publicId');
    assert.ok(!s.logger.records.some((x) => JSON.stringify(x.data).includes(r.body.data.token)), '日志不得出现 token 明文');
  });
});

test('AU-2 注册负例：弱密码 400 weak_password / 非法用户名 400 bad_request / 重名 409 username_taken / 坏 JSON 400', async () => {
  await h.withServer(null, async (s) => {
    const first = await h.register(s.port, h.uniqueName('dup'));
    assert.equal(first.status, 200, first.res.raw);
    const dup = await h.request(s.port, 'POST', '/api/v1/auth/register', { username: first.username, password: PW });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'username_taken');
    const dupUpper = await h.request(s.port, 'POST', '/api/v1/auth/register', { username: first.username.toUpperCase(), password: PW });
    assert.equal(dupUpper.status, 409, '用户名唯一性大小写不敏感（§4.2）');
    const weak = await h.request(s.port, 'POST', '/api/v1/auth/register', { username: h.uniqueName('weak'), password: 'short' });
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, 'weak_password');
    const badName = await h.request(s.port, 'POST', '/api/v1/auth/register', { username: 'a b', password: PW });
    assert.equal(badName.status, 400);
    assert.equal(badName.body.error.code, 'bad_request');
    const badJson = await h.request(s.port, 'POST', '/api/v1/auth/register', '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
  });
});

test('AU-3 并发注册（P0 负例）：同用户名 3 并发恰 1 成功；不同用户名并发不互相阻塞', async () => {
  await h.withServer(null, async (s) => {
    const username = h.uniqueName('race');
    const body = { username, password: PW };
    const results = await Promise.all([1, 2, 3].map(() => h.request(s.port, 'POST', '/api/v1/auth/register', body)));
    const ok = results.filter((r) => r.status === 200);
    const taken = results.filter((r) => r.status === 409);
    assert.equal(ok.length, 1, `并发同名注册必须恰 1 个成功（实得 ${results.map((r) => r.status).join(',')}）`);
    assert.equal(taken.length, 2, '其余必须 409');
    assert.ok(taken.every((r) => r.body.error.code === 'username_taken'));
    // 反向对照：不同用户名并发必须全部成功（注册临界区不得退化成"只允许一个注册"）
    const names = [h.uniqueName('multi'), h.uniqueName('multi'), h.uniqueName('multi')];
    const multi = await Promise.all(names.map((n) => h.request(s.port, 'POST', '/api/v1/auth/register', { username: n, password: PW })));
    assert.deepEqual(multi.map((r) => r.status), [200, 200, 200], `不同用户名并发注册应全部成功：${multi.map((r) => r.raw).join('|')}`);
    assert.equal(new Set(multi.map((r) => r.body.data.publicId)).size, 3, '三个独立档案');
  });
});

test('AU-4 登录：正例 + 错误密码/不存在用户统一 401 + 连续失败锁定 429 + 坏 JSON 400', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('login'));
    const ok = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: u.username, password: PW });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(typeof ok.body.data.token, 'string');
    assert.ok(s.logger.records.some((x) => x.event === 'store.auth.login'));
    const wrong = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: u.username, password: 'wrong-password' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, 'invalid_credentials', '不区分"用户不存在/密码错误"（§4.6）');
    const ghost = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: 'nobody_here', password: PW });
    assert.equal(ghost.status, 401);
    assert.equal(ghost.body.error.code, 'invalid_credentials');
    const badJson = await h.request(s.port, 'POST', '/api/v1/auth/login', '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    // 连续失败 5 次 → 锁 5 分钟；第 6 次 429 too_many_attempts
    const victim = await h.register(s.port, h.uniqueName('lock'));
    let last = null;
    for (let i = 0; i < 5; i++) {
      last = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: victim.username, password: 'bad-password' });
      assert.equal(last.status, 401, `第 ${i + 1} 次失败应为 401`);
    }
    const locked = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: victim.username, password: PW });
    assert.equal(locked.status, 429);
    assert.equal(locked.body.error.code, 'too_many_attempts');
    assert.ok(s.logger.records.some((x) => x.event === 'store.auth.lock'), '应记 store.auth.lock(warn)');
    assert.ok(s.logger.records.some((x) => x.event === 'store.auth.reject'), '应记 store.auth.reject(warn)');
  });
});

test('AU-5 鉴权中间件：缺 token 401 / 坏 token 401 / 过期 token 401 session_expired / 登出后 token 立即失效', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('auth'));
    const none = await h.request(s.port, 'GET', '/api/v1/me');
    assert.equal(none.status, 401);
    assert.equal(none.body.error.code, 'unauthorized');
    const bad = await h.request(s.port, 'GET', '/api/v1/me', undefined, { authorization: 'Bearer not-a-real-token' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'unauthorized');
    const wrongScheme = await h.request(s.port, 'GET', '/api/v1/me', undefined, { authorization: `Token ${u.token}` });
    assert.equal(wrongScheme.status, 401, '只接受 Authorization: Bearer');
    // 过期会话（§4.4 步骤 2：401 session_expired，与"不存在"区分）
    const expired = 'expired-token-for-test';
    const playerId = await h.playerIdByPublicId(s.store, u.publicId);
    const at = Date.now();
    s.store.sessions.put({
      tokenHash: authMod.tokenHashOf(expired), playerId,
      createdAt: at - 100000, lastUsedAt: at - 100000, expiresAt: at - 1000,
    });
    const exp = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(expired));
    assert.equal(exp.status, 401);
    assert.equal(exp.body.error.code, 'session_expired');
    // 登出撤销当前会话
    const out = await h.request(s.port, 'POST', '/api/v1/auth/logout', {}, h.authed(u.token));
    assert.equal(out.status, 200, out.raw);
    assert.equal(out.body.data.revoked, true);
    assert.ok(!out.raw.includes('pl_'), '登出响应也不得回带 playerId');
    const after = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(u.token));
    assert.equal(after.status, 401);
    assert.equal(after.body.error.code, 'unauthorized');
    const noToken = await h.request(s.port, 'POST', '/api/v1/auth/logout', {});
    assert.equal(noToken.status, 401, '登出也必须带 token');
  });
});

test('AU-6 改密：撤销其他会话 + 旧密码错误 401 + 弱新密码 400 + 缺 token 401', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('chpw'));
    const other = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: u.username, password: PW });
    assert.equal(other.status, 200);
    const otherToken = other.body.data.token;
    const ok = await h.request(s.port, 'POST', '/api/v1/auth/change-password', { oldPassword: PW, newPassword: 'new-password-9' }, h.authed(u.token));
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.data.changed, true);
    assert.ok(ok.body.data.revokedOthers >= 1, '改密撤销其他会话（§4.1）');
    const revoked = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(otherToken));
    assert.equal(revoked.status, 401, '其他设备会话应失效');
    const keep = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(u.token));
    assert.equal(keep.status, 200, '当前会话保持登录');
    const loginNew = await h.request(s.port, 'POST', '/api/v1/auth/login', { username: u.username, password: 'new-password-9' });
    assert.equal(loginNew.status, 200);
    const wrongOld = await h.request(s.port, 'POST', '/api/v1/auth/change-password', { oldPassword: 'bad-old-pass', newPassword: 'another-pw-9' }, h.authed(u.token));
    assert.equal(wrongOld.status, 401);
    assert.equal(wrongOld.body.error.code, 'invalid_credentials');
    const weak = await h.request(s.port, 'POST', '/api/v1/auth/change-password', { oldPassword: 'new-password-9', newPassword: 'x' }, h.authed(u.token));
    assert.equal(weak.status, 400);
    assert.equal(weak.body.error.code, 'weak_password');
    const noToken = await h.request(s.port, 'POST', '/api/v1/auth/change-password', { oldPassword: 'new-password-9', newPassword: 'another-pw-9' });
    assert.equal(noToken.status, 401);
    // 别名路径等价（任务口径 /auth/change-password = 设计口径 /auth/password）
    const alias = await h.request(s.port, 'POST', '/api/v1/auth/password', { oldPassword: 'new-password-9', newPassword: 'third-password-9' }, h.authed(u.token));
    assert.equal(alias.status, 200, alias.raw);
  });
});

test('AU-7 越权 403：请求体指定他人 playerId → forbidden；banned 档案 → 403 banned', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('own'));
    const b = await h.register(s.port, h.uniqueName('other'));
    const aId = await h.playerIdByPublicId(s.store, a.publicId);
    const bId = await h.playerIdByPublicId(s.store, b.publicId);
    const forbidden = await h.request(s.port, 'POST', '/api/v1/me/configs', { playerId: bId }, h.authed(a.token));
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'forbidden');
    assert.ok(s.logger.records.some((x) => x.event === 'api.reject' && x.data.code === 'forbidden'), '越权应记 api.reject(warn)');
    // 自己的 playerId 允许（不构成越权）。D-159：注册已建满 3 槽 → POST /me/configs 会先撞 409 slot_limit，
    //   无法再断言 200；改用同一条越权检查覆盖的端点 POST /me/records/seen 验证"自己 = 放行"。
    const self = await h.request(s.port, 'POST', '/api/v1/me/records/seen', { playerId: aId, uptoSeq: 0 }, h.authed(a.token));
    assert.equal(self.status, 200, self.raw);
    // 反向对照：同一端点上带他人 playerId 仍必须 403（证明上一条不是因为端点忽略 playerId 才 200）
    const forbidden2 = await h.request(s.port, 'POST', '/api/v1/me/records/seen', { playerId: bId, uptoSeq: 0 }, h.authed(a.token));
    assert.equal(forbidden2.status, 403);
    assert.equal(forbidden2.body.error.code, 'forbidden');
    // D-159 连带：注册即 3 槽 → 再建槽必须 409 slot_limit（旧写法"再建 2 个槽测上限"会提前撞限）
    const overLimit = await h.request(s.port, 'POST', '/api/v1/me/configs', {}, h.authed(a.token));
    assert.equal(overLimit.status, 409);
    assert.equal(overLimit.body.error.code, 'slot_limit');
    // 档案被标记 banned（保留会话）→ 中间件 403 banned（§4.4 步骤 3）
    await s.store.updateArchive(bId, (arch) => { arch.flags.banned = true; return null; });
    const banned = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(b.token));
    assert.equal(banned.status, 403);
    assert.equal(banned.body.error.code, 'banned');
  });
});

test('AU-8 全局限速 429 rate_limited（600 次/分/token 的同族语义：可注入小上限实测）', async () => {
  await h.withServer(null, async (s) => {
    const u = await h.register(s.port, h.uniqueName('rl'));
    // 上限 3：注册已占掉 IP 桶 1 次；token 桶独立计数 → 前 3 次 200，第 4 次 429
    for (let i = 1; i <= 3; i++) {
      const r = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(u.token));
      assert.equal(r.status, 200, `第 ${i} 次应在限内`);
    }
    const fourth = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(u.token));
    assert.equal(fourth.status, 429, '超过注入上限（3 次/分/token）应 429');
    assert.equal(fourth.body.error.code, 'rate_limited');
    assert.ok(s.logger.records.some((x) => x.event === 'api.reject' && x.data.code === 'rate_limited'));
    // 未登录按 IP 计（注册 1 + 匿名 1 + 匿名 1 = 3 → 第 3 次匿名即超限）
    assert.equal((await h.request(s.port, 'GET', '/api/v1/leaderboard')).status, 200);
    assert.equal((await h.request(s.port, 'GET', '/api/v1/leaderboard')).status, 200);
    const anon = await h.request(s.port, 'GET', '/api/v1/leaderboard');
    assert.equal(anon.status, 429, '同一 IP 超过注入上限（3 次/分/IP）应 429');
    assert.equal(anon.body.error.code, 'rate_limited');
  }, { server: { rateLimitPerMinute: 3 } });
});
