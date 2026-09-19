'use strict';
/* tests/unit/auth.test.js —— 账号与会话（P7-2/B28；D-129 §4）
 * 覆盖：加盐哈希与密码规则 · 注册（默认配置/download token）· 登录失败限速与锁定 · token 生命周期
 *      （登出失效/过期/伪造）· 改密撤销其他会话 · 多设备上限 · 日志事件矩阵 · 越权（改他人密码）。
 * 数据目录：os.tmpdir()（夹具），不污染仓库 runtime/。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const authMod = require('../../server/auth.js');
const {
  openFixture, registerPlayer, makeClock, makeLogger, FAST_AUTH, PASSWORD,
} = require('../helpers/account.js');

/* ---------- 纯函数：密码/用户名/token ---------- */

test('AU-1 加盐哈希：同密码两次哈希不同；verify 正确/错误/损坏凭据；按存储参数校验', () => {
  const cfg = { scrypt: { N: 1024, r: 8, p: 1 }, saltBytes: 16, hashBytes: 64 };
  const a = authMod.hashPassword('pw12345678', cfg);
  const b = authMod.hashPassword('pw12345678', cfg);
  assert.equal(a.algo, 'scrypt');
  assert.equal(a.N, 1024);
  assert.equal(a.r, 8);
  assert.equal(a.p, 1);
  assert.equal(Buffer.from(a.salt, 'base64').length, 16, '盐 16 字节');
  assert.equal(Buffer.from(a.hash, 'base64').length, 64, '哈希 64 字节');
  assert.notEqual(a.salt, b.salt, '每次注册盐必须不同');
  assert.notEqual(a.hash, b.hash, '同密码 + 不同盐 → 不同哈希');
  assert.equal(authMod.verifyPassword('pw12345678', a), true);
  assert.equal(authMod.verifyPassword('pw12345679', a), false);
  assert.equal(authMod.verifyPassword('pw12345678', null), false);
  assert.equal(authMod.verifyPassword('pw12345678', { algo: 'scrypt', salt: '!!!', hash: '!!!' }), false);
  assert.equal(authMod.verifyPassword('pw12345678', { algo: 'md5', salt: a.salt, hash: a.hash }), false);
  assert.equal(authMod.verifyPassword('pw12345678', { algo: 'scrypt', N: 3, r: 8, p: 1, salt: a.salt, hash: a.hash }), false,
    '非法算法参数不得抛错，按校验失败处理');
  // 存储参数可升级：旧参数档案用旧参数校验
  const upgraded = authMod.hashPassword('pw12345678', { scrypt: { N: 2048, r: 8, p: 1 } });
  assert.equal(upgraded.N, 2048);
  assert.equal(authMod.verifyPassword('pw12345678', upgraded), true);
  assert.equal(authMod.verifyPassword('pw12345678', a), true, '不同 N 的旧档案仍可用旧参数校验');
});

test('AU-2 密码与用户名规则（§4.2）：长度 8~72、UTF-8 ≤256B、用户名 3~24 [A-Za-z0-9_-]', () => {
  assert.equal(authMod.validatePassword('1234567', {}).code, 'weak_password');
  assert.equal(authMod.validatePassword('12345678', {}).ok, true);
  assert.equal(authMod.validatePassword('x'.repeat(72), {}).ok, true);
  assert.equal(authMod.validatePassword('x'.repeat(73), {}).code, 'weak_password');
  assert.equal(authMod.validatePassword('中'.repeat(66), {}).ok, true, '66 个中文 = 198B ≤ 256B');
  // 字节上限是**独立**于字符数的防线（默认 72 字符时不可达；passwordMax 放宽后生效）
  assert.equal(authMod.validatePassword('中'.repeat(100), { passwordMax: 200 }).code, 'weak_password', '300B > 256B');
  assert.equal(authMod.validatePassword('中'.repeat(80), { passwordMax: 200 }).ok, true, '240B ≤ 256B');
  assert.equal(authMod.validatePassword('x'.repeat(73), {}).code, 'weak_password');
  assert.equal(authMod.validatePassword(undefined, {}).code, 'weak_password');
  assert.equal(authMod.validateUsername('ab').ok, false);
  assert.equal(authMod.validateUsername('abc').ok, true);
  assert.equal(authMod.validateUsername('a'.repeat(24)).ok, true);
  assert.equal(authMod.validateUsername('a'.repeat(25)).ok, false);
  assert.equal(authMod.validateUsername('bad name').ok, false);
  assert.equal(authMod.validateUsername('bad.name').ok, false);
  assert.equal(authMod.validateUsername('A-Z_0-9').ok, true);
  // token：32 字节 base64url = 43 字符；sha256 存储且稳定
  const t1 = authMod.randomToken();
  const t2 = authMod.randomToken();
  assert.match(t1, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(t1, t2);
  assert.equal(authMod.tokenHashOf(t1), authMod.tokenHashOf(t1));
  assert.match(authMod.tokenHashOf(t1), /^[0-9a-f]{64}$/);
  assert.notEqual(authMod.tokenHashOf(t1), t1);
  assert.equal(authMod.hash16('1.2.3.4').length, 16);
  assert.equal(authMod.hash16(''), null);
  assert.equal(authMod.normalizeScrypt({}).N, 16384, '缺省算法参数 = §4.2 口径');
});

/* ---------- 注册 / 登录 / 会话闭环 ---------- */

test('AU-3 注册→登录→token 校验→登出后旧 token 立即失效（T-AU-2）', async () => {
  const fx = await openFixture({ logger: makeLogger() });
  try {
    const u = await registerPlayer(fx.auth, { username: 'Dev_01', nickname: '调试员', ip: '9.9.9.9', userAgent: 'UA/1' });
    assert.equal(u.res.ok, true);
    assert.match(u.res.data.publicId, /^u_[0-9a-f]{8}$/);
    assert.match(u.res.data.playerId, /^pl_[0-9a-f]{16}$/);
    assert.equal(u.res.data.nickname, '调试员');
    assert.match(u.res.data.token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(u.res.data.expiresAt > fx.clock.now());
    assert.deepEqual(u.res.data.player.tier, 'common');
    assert.equal(u.res.data.player.points, 0, '积分从 0 起（D-133）');
    assert.equal(u.res.data.player.activeSlotId, 'slot1');
    // 注册即默认配置（T-AC-1）：槽 + 冻结快照都真实落盘
    const cfg = await fx.account.listConfigs(u.playerId);
    assert.equal(cfg.data.slots.length, 1);
    assert.equal(cfg.data.slots[0].slotId, 'slot1');
    assert.equal(cfg.data.slots[0].isDefault, true);
    assert.equal(cfg.data.slots[0].name, '默认配置');
    assert.equal(cfg.data.activeSlotId, 'slot1');
    assert.equal(fx.store.snapshot.has(cfg.data.slots[0].snapshot.hash), true, '快照已冻结入库');
    // token 校验
    const who = await fx.auth.authenticate(u.token);
    assert.equal(who.ok, true);
    assert.equal(who.data.player.playerId, u.playerId);
    assert.equal(who.data.publicId, u.publicId);
    assert.deepEqual(who.data.player.slots.map((s) => s.slotId), ['slot1']);
    // 登录（大小写不敏感）
    const lg = await fx.auth.login({ username: 'DEV_01', password: PASSWORD, ip: '9.9.9.9' });
    assert.equal(lg.ok, true);
    assert.equal(lg.data.playerId, u.playerId);
    assert.equal((await fx.auth.authenticate(lg.data.token)).ok, true);
    // 登出只撤销当前 token
    assert.equal((await fx.auth.logout({ token: lg.data.token })).ok, true);
    assert.equal((await fx.auth.authenticate(lg.data.token)).code, 'unauthorized');
    assert.equal((await fx.auth.authenticate(lg.data.token)).status, 401);
    assert.equal((await fx.auth.authenticate(u.token)).ok, true, '其他设备（注册 token）不受影响');
    // 事件矩阵（§6 通道 store）
    const events = fx.events();
    assert.ok(events.includes('store.auth.register'), '注册事件');
    assert.ok(events.includes('store.auth.login'), '登录事件');
    assert.equal(fx.logger.records.find((r) => r.event === 'store.auth.register').channel, 'store');
  } finally {
    await fx.cleanup();
  }
});

test('AU-4 注册拒绝：重名（大小写不敏感）409 / 弱密码 400 / 非法用户名与昵称 400；服务端不存明文密码', async () => {
  const fx = await openFixture({});
  try {
    const first = await registerPlayer(fx.auth, { username: 'Taken_1' });
    assert.equal(first.res.ok, true);
    const dup = await fx.auth.register({ username: 'taken_1', password: PASSWORD });
    assert.equal(dup.ok, false);
    assert.equal(dup.code, 'username_taken');
    assert.equal(dup.status, 409);
    const weak = await fx.auth.register({ username: 'Weak_1', password: 'short' });
    assert.equal(weak.code, 'weak_password');
    assert.equal(weak.status, 400);
    const badName = await fx.auth.register({ username: 'bad name', password: PASSWORD });
    assert.equal(badName.code, 'bad_request');
    assert.equal(badName.status, 400);
    const badNick = await fx.auth.register({ username: 'Nick_1', password: PASSWORD, nickname: 'x'.repeat(17) });
    assert.equal(badNick.code, 'bad_request');
    // 档案里只有哈希：明文密码不出现在任何落盘文件里
    const archive = await fx.store.loadArchive(first.playerId);
    assert.equal(archive.auth.algo, 'scrypt');
    assert.equal(archive.auth.username, 'Taken_1', '用户名校验保留原大小写');
    assert.equal(archive.auth.usernameLower, 'taken_1', '索引键为 lowercase');
    assert.equal(archive.auth.password, undefined);
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else files.push(abs);
      }
    };
    walk(fx.dir);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      assert.equal(text.includes(PASSWORD), false, `${path.basename(file)} 不得出现明文密码`);
    }
  } finally {
    await fx.cleanup();
  }
});

test('AU-5 默认 scrypt 参数（N=16384/r=8/p=1）真实可用：注册即写入默认参数并可登录', async () => {
  const fx = await openFixture({ config: null }); // config:null → 不覆盖，用 service-config 缺省（N=16384）
  try {
    const u = await registerPlayer(fx.auth, { username: 'Default_1' });
    assert.equal(u.res.ok, true);
    const archive = await fx.store.loadArchive(u.playerId);
    assert.equal(archive.auth.N, 16384);
    assert.equal(archive.auth.r, 8);
    assert.equal(archive.auth.p, 1);
    assert.equal(Buffer.from(archive.auth.salt, 'base64').length, 16);
    assert.equal(Buffer.from(archive.auth.hash, 'base64').length, 64);
    assert.equal((await fx.auth.login({ username: 'Default_1', password: PASSWORD })).ok, true);
    assert.equal((await fx.auth.login({ username: 'Default_1', password: 'nope-nope' })).code, 'invalid_credentials');
  } finally {
    await fx.cleanup();
  }
});

/* ---------- 登录失败限速与锁定（T-AU-1） ---------- */

test('AU-6 错密码统一 invalid_credentials；连续 5 次失败 → 锁定（第 6 次 429 too_many_attempts）；成功清零', async () => {
  const fx = await openFixture({ logger: makeLogger() });
  try {
    const u = await registerPlayer(fx.auth, { username: 'Lock_1', ip: '8.8.8.8' });
    for (let i = 1; i <= 4; i += 1) {
      const res = await fx.auth.login({ username: 'Lock_1', password: 'wrong-pass', ip: '8.8.8.8' });
      assert.equal(res.code, 'invalid_credentials', `第 ${i} 次失败`);
      assert.equal(res.status, 401);
    }
    // 不存在的用户名与密码错误**不可区分**（§4.6）
    const ghost = await fx.auth.login({ username: 'ghost_user', password: 'wrong-pass', ip: '8.8.8.8' });
    assert.equal(ghost.code, 'invalid_credentials');
    // 第 5 次失败触发锁定
    const fifth = await fx.auth.login({ username: 'Lock_1', password: 'wrong-pass', ip: '8.8.8.8' });
    assert.equal(fifth.code, 'invalid_credentials');
    assert.ok(fx.events().includes('store.auth.lock'), '锁定事件 store.auth.lock(warn)');
    // 第 6 次（即使密码正确）→ 429
    const sixth = await fx.auth.login({ username: 'Lock_1', password: PASSWORD, ip: '8.8.8.8' });
    assert.equal(sixth.ok, false);
    assert.equal(sixth.code, 'too_many_attempts');
    assert.equal(sixth.status, 429);
    assert.ok(fx.auth.limiter.lockedUntil('lock_1') > fx.clock.now());
    assert.ok(fx.events().includes('store.auth.reject'), '拒绝事件 store.auth.reject(warn)');
    // 另一个用户不受影响
    await registerPlayer(fx.auth, { username: 'Other_1', ip: '8.8.8.8' });
    assert.equal((await fx.auth.login({ username: 'Other_1', password: PASSWORD })).ok, true);
  } finally {
    await fx.cleanup();
  }
});

test('AU-7 成功后失败计数清零；锁定到期自动解锁（注入时钟）', async () => {
  const clock = makeClock();
  const fx = await openFixture({ clock, config: { auth: { scrypt: { N: 1024 }, maxFailures: 2, lockMinutes: 5, rateLimitPerMinute: 100 } } });
  try {
    await registerPlayer(fx.auth, { username: 'Clear_1' });
    assert.equal((await fx.auth.login({ username: 'Clear_1', password: 'bad-pass-1' })).code, 'invalid_credentials');
    assert.equal((await fx.auth.login({ username: 'Clear_1', password: PASSWORD })).ok, true, '成功一次');
    // 计数已清零：再失败 1 次仍不锁定（否则会是 429）
    assert.equal((await fx.auth.login({ username: 'Clear_1', password: 'bad-pass-2' })).code, 'invalid_credentials');
    // 第 2 次连续失败 → 锁定
    assert.equal((await fx.auth.login({ username: 'Clear_1', password: 'bad-pass-3' })).code, 'invalid_credentials');
    assert.equal((await fx.auth.login({ username: 'Clear_1', password: PASSWORD })).code, 'too_many_attempts');
    // 把时钟推过锁定窗口（5 分钟）→ 解锁
    for (let i = 0; i < 400; i += 1) clock(); // 400s = 6.7min > 5min
    const after = await fx.auth.login({ username: 'Clear_1', password: PASSWORD });
    assert.equal(after.ok, true, '锁定期满后正确密码可登录');
  } finally {
    await fx.cleanup();
  }
});

/* ---------- 改密 / 越权 / 过期 / 多设备 ---------- */

test('AU-8 改密：原密码错误 401；弱新密码 400；成功后旧密码失效、其他会话被撤销、当前会话保持', async () => {
  const fx = await openFixture({ logger: makeLogger() });
  try {
    const u = await registerPlayer(fx.auth, { username: 'Pass_1' });
    const second = await fx.auth.login({ username: 'Pass_1', password: PASSWORD });
    assert.equal(second.ok, true);
    const wrongOld = await fx.auth.changePassword({ token: second.data.token, oldPassword: 'not-the-one', newPassword: 'newpw12345' });
    assert.equal(wrongOld.code, 'invalid_credentials');
    assert.equal(wrongOld.status, 401);
    const weakNew = await fx.auth.changePassword({ token: second.data.token, oldPassword: PASSWORD, newPassword: 'short' });
    assert.equal(weakNew.code, 'weak_password');
    assert.equal(weakNew.status, 400);
    const changed = await fx.auth.changePassword({ token: second.data.token, oldPassword: PASSWORD, newPassword: 'newpw12345' });
    assert.equal(changed.ok, true);
    assert.equal(changed.data.revokedOthers, 1, '注册时的会话被撤销');
    assert.equal((await fx.auth.authenticate(u.token)).code, 'unauthorized', '旧会话失效');
    assert.equal((await fx.auth.authenticate(second.data.token)).ok, true, '当前会话保持登录');
    assert.equal((await fx.auth.login({ username: 'Pass_1', password: PASSWORD })).code, 'invalid_credentials', '旧密码失效');
    assert.equal((await fx.auth.login({ username: 'Pass_1', password: 'newpw12345' })).ok, true, '新密码可用');
    // 越权：不能改他人密码
    const other = await registerPlayer(fx.auth, { username: 'Other_2' });
    const forbidden = await fx.auth.changePassword({
      token: second.data.token, playerId: other.playerId, oldPassword: 'newpw12345', newPassword: 'another12345',
    });
    assert.equal(forbidden.code, 'forbidden');
    assert.equal(forbidden.status, 403);
  } finally {
    await fx.cleanup();
  }
});

test('AU-9 token 过期/伪造/缺失 → 401 unauthorized；封禁档案 → 403 banned', async () => {
  const fx = await openFixture({ logger: makeLogger() });
  try {
    const u = await registerPlayer(fx.auth, { username: 'Tok_1' });
    assert.equal((await fx.auth.authenticate(undefined)).code, 'unauthorized');
    assert.equal((await fx.auth.authenticate('')).code, 'unauthorized');
    assert.equal((await fx.auth.authenticate('not-a-real-token')).code, 'unauthorized');
    assert.equal((await fx.auth.logout({ token: 'not-a-real-token' })).code, 'unauthorized');
    // 手工塞一个已过期会话（会话表读时清理 → authenticate 视为无效）
    const token = authMod.randomToken();
    fx.store.sessions.put({
      tokenHash: authMod.tokenHashOf(token), playerId: u.playerId,
      createdAt: fx.clock.now() - 10 * 86400000, expiresAt: fx.clock.now() - 86400000,
      lastUsedAt: fx.clock.now() - 10 * 86400000,
    });
    const expired = await fx.auth.authenticate(token);
    assert.equal(expired.ok, false);
    assert.equal(expired.status, 401);
    // 封禁（store.setBanned 会撤销全部会话）
    const banned = await fx.store.setBanned({ playerId: u.playerId, banned: true, reason: 'test' });
    assert.equal(banned.flags.banned, true);
    const res = await fx.auth.authenticate(u.token);
    assert.equal(res.code, 'unauthorized', '封禁同时撤销会话 → 401');
    // 重新登录 → banned 403
    const relogin = await fx.auth.login({ username: 'Tok_1', password: PASSWORD });
    assert.equal(relogin.code, 'banned');
    assert.equal(relogin.status, 403);
    await fx.store.setBanned({ playerId: u.playerId, banned: false });
    assert.equal((await fx.auth.login({ username: 'Tok_1', password: PASSWORD })).ok, true, '解封后可登录');
  } finally {
    await fx.cleanup();
  }
});

test('AU-10 多设备：最多 5 个活跃会话，超出淘汰最旧；listSessions 不泄露 tokenHash', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Multi_1' });
    assert.equal(u.res.ok, true);
    const tokens = [u.token];
    for (let i = 0; i < 4; i += 1) {
      const lg = await fx.auth.login({ username: 'Multi_1', password: PASSWORD, userAgent: `UA/${i}` });
      assert.equal(lg.ok, true);
      tokens.push(lg.data.token);
    }
    assert.equal(fx.store.sessions.list(u.playerId).length, 5);
    const sixth = await fx.auth.login({ username: 'Multi_1', password: PASSWORD });
    assert.equal(sixth.ok, true);
    assert.equal(fx.store.sessions.list(u.playerId).length, 5, '上限 5（service-config.session.maxPerPlayer）');
    assert.equal((await fx.auth.authenticate(tokens[0])).code, 'unauthorized', '最旧会话被淘汰');
    assert.equal((await fx.auth.authenticate(tokens[4])).ok, true);
    const list = await fx.auth.listSessions(u.playerId);
    assert.equal(list.ok, true);
    assert.equal(list.data.count, 5);
    for (const s of list.data.sessions) {
      assert.equal(s.tokenHash, undefined, '不得返回 tokenHash');
      assert.equal(s.token, undefined, '不得返回 token 明文');
      assert.ok(s.expiresAt > 0);
    }
    const all = await fx.auth.revokeAllSessions(u.playerId);
    assert.equal(all.data.revoked, 5);
    assert.equal((await fx.auth.authenticate(sixth.data.token)).code, 'unauthorized');
  } finally {
    await fx.cleanup();
  }
});

test('AU-11 会话滑动续期：TTL 内每次鉴权延长 expiresAt，但不超过 createdAt + maxTotalDays', async () => {
  const clock = makeClock();
  const fx = await openFixture({ clock, config: { session: { ttlDays: 7, maxTotalDays: 30 } } });
  try {
    const u = await registerPlayer(fx.auth, { username: 'Renew_1' });
    const first = await fx.auth.authenticate(u.token);
    assert.equal(first.ok, true);
    const created = first.data.session.createdAt;
    const before = first.data.session.expiresAt;
    for (let i = 0; i < 80; i += 1) clock(); // 推进 80s（超过 60s 续期节流）
    const second = await fx.auth.authenticate(u.token);
    assert.equal(second.ok, true);
    assert.ok(second.data.session.expiresAt > before, '滑动续期延长 expiresAt');
    assert.ok(second.data.session.expiresAt <= created + 30 * 86400000, '不超过 createdAt + 30 天上限');
    assert.ok(second.data.session.lastUsedAt > first.data.session.lastUsedAt);
  } finally {
    await fx.cleanup();
  }
});

test('AU-12 authenticate 返回的 ctx.player 形状（§4.4）：playerId/publicId/tier/points/slots；不含密码', async () => {
  const fx = await openFixture({});
  try {
    const u = await registerPlayer(fx.auth, { username: 'Ctx_1' });
    const who = await fx.auth.authenticate(u.token);
    assert.equal(who.ok, true);
    assert.deepEqual(Object.keys(who.data.player).sort(), [
      'activeSlotId', 'activeSlotName', 'activeSnapshotHash', 'nickname', 'playerId', 'points', 'publicId', 'slots', 'tier',
    ]);
    assert.equal(who.data.player.tier, 'common');
    assert.equal(who.data.player.points, 0);
    assert.equal(who.data.player.activeSlotId, 'slot1');
    assert.equal(who.data.player.auth, undefined, '不得注入凭据');
    assert.equal(JSON.stringify(who.data).includes('scrypt'), false);
    assert.equal(FAST_AUTH.auth.scrypt.N, 1024);
  } finally {
    await fx.cleanup();
  }
});
