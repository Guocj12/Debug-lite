'use strict';
/* tests/unit/admin.test.js —— 管理端（重建索引 / 注入与清理调试账号 / 统计 / 封禁）测试
 * 权威：docs/interfaces.md §1/§2（`server/admin.js`、`/admin/bots`、`/admin/rebuild-index`）+ §7（`DL_ADMIN_TOKEN`）
 *      + docs/systems/11-account-store.md §7.6（bot 账号=管理员注入的**真实档案**）。
 * 🚫 与 plan-p7-playable §P7-3 的关系：本模块的 `injectDebugBots` 需要 token + `DL_DEBUG_BOTS=1` 双门控，
 *    且只把调试账号作为**真实档案**写进注册表；正常匹配路径永不调用它（池不足依旧 shortfall）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const adminMod = require('../../server/admin.js');
const ranked = require('../../server/ranked.js');
const qm = require('../../server/quickmatch.js');
const h = require('../helpers/ranked.js');

const TOKEN = 'test-admin-token';

function makeAdmin(fx, env) {
  return adminMod.createAdmin({ store: fx.store, logger: fx.logger, now: fx.clock, env });
}

test('T-AD-1 令牌校验：未配置 DL_ADMIN_TOKEN → 503；错误令牌 → 403；正确令牌 → 放行', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const noToken = makeAdmin(fx, {});
  const missing = noToken.checkToken('x');
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 503);
  assert.equal(missing.code, 'admin_token_missing');
  const denied = await noToken.rebuildIndex({ adminToken: 'x' });
  assert.equal(denied.status, 503);

  const admin = makeAdmin(fx, { DL_ADMIN_TOKEN: TOKEN });
  assert.equal(admin.checkToken(TOKEN).ok, true);
  assert.equal(admin.checkToken('').ok, false);
  assert.equal(admin.checkToken('wrong').code, 'forbidden');
  const denied2 = await admin.rebuildIndex({ adminToken: 'wrong' });
  assert.equal(denied2.status, 403);
  assert.equal(denied2.code, 'forbidden');
  // 未授权访问记 store.abuse.suspect(warn)（§8.5/§12.2）
  assert.ok(fx.events().includes('store.abuse.suspect'));
});

test('T-AD-2 重建索引：扫盘重建 → 与档案一致；未授权被拒', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(3);
  await fx.store.updateArchive(players[0].playerId, (ar) => { ar.rating.points = 321; ar.rating.peakPoints = 321; return null; });
  const admin = makeAdmin(fx, { DL_ADMIN_TOKEN: TOKEN });
  const res = await admin.rebuildIndex({ adminToken: TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.data.players, 3);
  assert.ok(res.data.seq >= 0);
  for (const playerId of await fx.store.listPlayerIds()) {
    const archive = await fx.store.loadArchive(playerId);
    assert.equal(fx.store.index.get(playerId).points, archive.rating.points, '重建后索引 == 档案');
    assert.equal(fx.store.index.get(playerId).tier, archive.progress.tier);
  }
  assert.equal(fx.store.index.get(players[0].playerId).points, 321, '重建吸收了直改的档案值');
  const rows = fx.store.index.leaderboard({ scope: 'global', limit: 10 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].publicId, players[0].publicId, '排行榜首位 = 321 分玩家');
});

test('T-AD-3 统计：players/seq/tiers/leaderboard 摘要；未授权被拒', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(3);
  await fx.store.updateArchive(players[1].playerId, (ar) => {
    ar.progress.tier = 'rare'; ar.progress.peakTier = 'rare';
    return null;
  });
  await fx.store.index.rebuild();
  const admin = makeAdmin(fx, { DL_ADMIN_TOKEN: TOKEN });
  assert.equal((await admin.stats({})).status, 403, '无令牌 → 403');
  const res = await admin.stats({ adminToken: TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.data.players, 3);
  assert.equal(res.data.tiers.common, 2);
  assert.equal(res.data.tiers.rare, 1);
  assert.equal(res.data.adapter, 'json');
  assert.equal(typeof res.data.seq, 'number');
});

test('T-AD-4 调试注入双门控：DL_DEBUG_BOTS 未开 → 403（即使令牌正确）；开了 + 令牌 → 建成真实档案', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const off = makeAdmin(fx, { DL_ADMIN_TOKEN: TOKEN }); // 未设 DL_DEBUG_BOTS
  const disabled = await off.injectDebugBots({ adminToken: TOKEN, count: 2, tier: 'common', points: 100 });
  assert.equal(disabled.status, 403);
  assert.equal(disabled.code, 'debug_bots_disabled');
  assert.equal((await fx.store.listPlayerIds()).length, 0, '门控关闭时一个档案都不建');

  const admin = makeAdmin(fx, { DL_ADMIN_TOKEN: TOKEN, DL_DEBUG_BOTS: '1' });
  assert.equal(admin.debugEnabled(), true);
  const res = await admin.injectDebugBots({ adminToken: TOKEN, count: 2, tier: 'common', points: 100, botKey: 'k1' });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.data.debug, true, '响应显式标注 debug:true');
  assert.equal(res.data.injected, 2);
  for (const bot of res.data.bots) {
    const archive = await fx.store.loadArchive(bot.playerId);
    assert.equal(archive.flags.isBot, true);
    assert.ok(archive.flags.botKey.startsWith(adminMod.BOT_KEY_PREFIX), 'botKey 带 dl-debug- 前缀（可清理）');
    assert.equal(archive.rating.points, 100);
    assert.equal(archive.progress.tier, 'common');
    assert.ok(archive.configs.activeSnapshotHash, '调试账号也有真实冻结快照');
    assert.equal(fx.store.index.get(bot.playerId).inPool, true, '调试账号入池（与真人同权被抽）');
  }
  assert.ok(fx.events().includes('store.abuse.suspect'), '注入记 store.abuse.suspect(warn) 审计');
  // 参数校验
  const badTier = await admin.injectDebugBots({ adminToken: TOKEN, count: 1, tier: 'platinum' });
  assert.equal(badTier.code, 'bad_tier');
  const badCount = await admin.injectDebugBots({ adminToken: TOKEN, count: 0 });
  assert.equal(badCount.code, 'bad_request');
  const badPoints = await admin.injectDebugBots({ adminToken: TOKEN, count: 1, points: -1 });
  assert.equal(badPoints.code, 'bad_request');
  const countCap = await admin.injectDebugBots({ adminToken: TOKEN, count: adminMod.MAX_BOTS_PER_CALL + 1 });
  assert.equal(countCap.code, 'bad_request');
});

test('T-AD-5 清理调试账号：只删 dl-debug-* 的 bot，真人档案与 botKey 无关的 bot 不受影响', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const human = await fx.registerPlayer({ nickname: '真人' });
  // 一个"非本模块注入"的 bot（无 dl-debug- 前缀）——模拟运维自行注入
  const foreign = await fx.registerPlayer({ nickname: '运维bot', isBot: true, flags: { isBot: true, botKey: 'ops-1' } });
  const admin = makeAdmin(fx, { DL_ADMIN_TOKEN: TOKEN, DL_DEBUG_BOTS: '1' });
  await admin.injectDebugBots({ adminToken: TOKEN, count: 2, botKey: 'cleanup' });
  assert.equal((await fx.store.listPlayerIds()).length, 4);
  assert.equal((await admin.clearDebugBots({})).status, 403, '无令牌 → 403');
  const res = await admin.clearDebugBots({ adminToken: TOKEN });
  assert.equal(res.status, 200, JSON.stringify(res));
  assert.equal(res.data.removed, 2);
  const left = await fx.store.listPlayerIds();
  assert.equal(left.length, 2);
  assert.ok(left.includes(human.playerId), '真人档案保留');
  assert.ok(left.includes(foreign.playerId), '非 dl-debug- 前缀的 bot 保留');
  assert.equal(fx.store.index.get(human.playerId).points >= 0, true, '索引中真人仍在');
  await fx.store.index.rebuild();
  assert.equal(fx.store.index.size(), 2, '重建后索引不含已删除的调试档案');
});

test('T-AD-6 封禁/解封：写 journal（account.banned/unbanned）；未授权被拒', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const me = await fx.registerPlayer();
  const admin = makeAdmin(fx, { DL_ADMIN_TOKEN: TOKEN });
  assert.equal((await admin.ban({ playerId: me.playerId })).status, 403);
  const banned = await admin.ban({ playerId: me.playerId, adminToken: TOKEN, reason: 'test' });
  assert.equal(banned.status, 200, JSON.stringify(banned));
  assert.equal(banned.data.banned, true);
  assert.equal((await admin.ban({ adminToken: TOKEN })).status, 400, '缺 playerId → bad_request');
  const archive = await fx.store.loadArchive(me.playerId);
  assert.equal(archive.flags.banned, true);
  // 被封禁者不能参与排位/快速对战（403 banned）
  const rankRes = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 1 });
  assert.equal(rankRes.status, 403);
  assert.equal(rankRes.code, 'banned');
  const unbanned = await admin.ban({ playerId: me.playerId, adminToken: TOKEN, banned: false });
  assert.equal(unbanned.data.banned, false);
  assert.equal((await fx.store.loadArchive(me.playerId)).flags.banned, false);
  const missing = await admin.ban({ playerId: h.makePlayerId(999), adminToken: TOKEN });
  assert.equal(missing.status, 404);
});

test('T-AD-7 调试账号是"真实档案"：可被正常匹配抽中并双向结算（不是占位 bot 垫片）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const me = await fx.registerPlayer({ nickname: '真人' });
  const admin = makeAdmin(fx, { DL_ADMIN_TOKEN: TOKEN, DL_DEBUG_BOTS: '1' });
  const injected = await admin.injectDebugBots({ adminToken: TOKEN, count: 1, tier: 'common', points: 0, botKey: 'pool' });
  const botId = injected.data.bots[0].playerId;
  // 未开启调试开关的普通实例：池里只有调试档案（真实档案）→ 能匹配上
  const quick = qm.createQuickMatch({ store: fx.store, env: {} });
  const r = await quick.run({ playerId: me.playerId, seed: 5150 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.opponent.playerId, botId, '抽中的是注册表里的调试档案');
  assert.equal(r.data.opponent.isBot, true);
  assert.equal(r.data.opponent.pointsAfter, 0, 'bot 积分冻结（§7.6）');
  const botArchive = await fx.store.loadArchive(botId);
  assert.equal(botArchive.rating.points, 0, 'bot 档案积分不变');
  assert.equal(botArchive.record.stats.defense.wins + botArchive.record.stats.defense.losses + botArchive.record.stats.defense.draws, 1, 'bot 仍记战绩（可观察）');
});

test('T-AD-8 工厂：缺少已装配 store → TypeError；defaultAdmin 单例可复用', async (t) => {
  assert.throws(() => adminMod.createAdmin({}), TypeError);
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const a = adminMod.defaultAdmin({ store: fx.store, env: { DL_ADMIN_TOKEN: TOKEN } });
  const b = adminMod.defaultAdmin({ store: fx.store, env: { DL_ADMIN_TOKEN: TOKEN } });
  assert.equal(a, b, '默认实例单例');
  assert.equal(a.checkToken(TOKEN).ok, true);
});
