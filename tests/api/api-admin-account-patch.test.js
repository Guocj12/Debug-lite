'use strict';
/* tests/api/api-admin-account-patch.test.js —— D-170 管理员改账号（段位/积分/入池）
 *
 * 设计依据：docs/frontend/02-accounts.md §2.5（请求/响应/错误码）+ §13-10/13-12（实现备案）；
 *   docs/interfaces.md §2（admin 接口唯一权威）+ decisions.md D-170。
 *
 * 本文件覆盖四件事（用户 2026-09-25 要求："可调用后端接口修改任意账号的段位/积分"）：
 *   ① 契约：请求/响应逐字段、publicId 与 playerId 两种寻址、部分更新语义（缺省字段不改）；
 *   ② 真源：改的是**档案**（写 account.patched journal），不只是列表投影 —— 重启重放后仍在；
 *   ③ 诚实：峰值只升不降（不变量 peakPoints >= points / peakTier 序），且不动战绩（wins/losses/games）；
 *   ④ 权限与校验：非管理员 403 / 令牌路径 200 / 非法值 400 / 未知目标 404 / 三项全缺 400。
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer, register, authed, request, playerIdByPublicId, makeTempDataDir, removeTempDir } = require('../helpers/http.js');

const TOKEN = 'admin-token-for-d170';
const ADMIN = 'd170admin';
const ENV = { DL_ADMIN_TOKEN: TOKEN, DL_ADMIN_USERS: ADMIN };

function withPatchServer(fn, options) {
  return startServer(Object.assign({ prefix: 'dl-d170-', level: 'warn', server: { env: ENV } }, options || {}))
    .then(async (s) => {
      try {
        return await fn(s);
      } finally {
        await s.cleanup();
      }
    });
}

const patch = (port, body, headers) => request(port, 'POST', '/api/v1/admin/account-patch', body, headers);

async function archiveOf(s, publicId) {
  const playerId = await playerIdByPublicId(s.store, publicId);
  assert.ok(playerId, `应能由 publicId=${publicId} 反查 playerId`);
  return { playerId, archive: await s.store.loadArchive(playerId) };
}

test('AP-1 按 publicId 改段位+积分：响应逐字段、档案真源生效、账号列表投影同步', async () => {
  await withPatchServer(async (s) => {
    const admin = await register(s.port, ADMIN);
    const target = await register(s.port, 'd170target');
    const before = await archiveOf(s, target.publicId);
    assert.equal(before.archive.progress.tier, 'common');
    assert.equal(before.archive.rating.points, 0);

    const r = await patch(s.port, { publicId: target.publicId, tier: 'legendary', points: 1234 }, authed(admin.token));
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    assert.equal(d.publicId, target.publicId);
    assert.equal(d.playerId, before.playerId, 'admin 通道回带真实 playerId');
    assert.equal(d.tier, 'legendary');
    assert.equal(d.points, 1234);
    assert.equal(d.peakTier, 'legendary', '调高段位 → 峰值随之上移（不变量）');
    assert.equal(d.peakPoints, 1234, '调高积分 → 峰值随之上移（不变量）');
    assert.ok(Number.isInteger(d.tierUpdatedAt), '段位变化必须同步 tierUpdatedAt（段位榜按到达时间排序要用）');
    assert.equal(d.inPool, true, '未给 inPool → 原值回带');

    // 档案（真源）
    const after = await archiveOf(s, target.publicId);
    assert.equal(after.archive.progress.tier, 'legendary');
    assert.equal(after.archive.rating.points, 1234);
    assert.equal(after.archive.progress.tierUpdatedAt, d.tierUpdatedAt);

    // 索引投影（账号列表看到的行）
    const list = await request(s.port, 'POST', '/api/v1/admin/accounts', { limit: 200 }, authed(admin.token));
    const row = list.body.data.rows.find((x) => x.publicId === target.publicId);
    assert.ok(row, '账号列表应含目标账号');
    assert.equal(row.tier, 'legendary');
    assert.equal(row.points, 1234);
    assert.equal(row.peakPoints, 1234);
    assert.equal(row.isBot, false);
  });
});

test('AP-2 部分更新：缺省字段一律不改（只给 tier / 只给 points / 只给 inPool）', async () => {
  await withPatchServer(async (s) => {
    await register(s.port, ADMIN);
    const admin = await request(s.port, 'POST', '/api/v1/auth/login', { username: ADMIN, password: 'pw12345678' });
    assert.equal(admin.status, 200, admin.raw);
    const h = authed(admin.body.data.token);
    const target = await register(s.port, 'd170partial');
    const { playerId } = await archiveOf(s, target.publicId);

    const onlyTier = await patch(s.port, { playerId, tier: 'epic' }, h);
    assert.equal(onlyTier.status, 200, onlyTier.raw);
    assert.equal(onlyTier.body.data.tier, 'epic');
    assert.equal(onlyTier.body.data.points, 0, '未给 points → 积分为原值 0');
    assert.equal(onlyTier.body.data.inPool, true, '未给 inPool → 原值');

    const onlyPoints = await patch(s.port, { playerId, points: 500 }, h);
    assert.equal(onlyPoints.status, 200);
    assert.equal(onlyPoints.body.data.points, 500);
    assert.equal(onlyPoints.body.data.tier, 'epic', '未给 tier → 段位保持 epic');

    const onlyPool = await patch(s.port, { playerId, inPool: false }, h);
    assert.equal(onlyPool.status, 200, onlyPool.raw);
    assert.equal(onlyPool.body.data.inPool, false, 'inPool=false 应把账号踢出匹配池');
    assert.equal(onlyPool.body.data.tier, 'epic', '段位不受影响');
    assert.equal(onlyPool.body.data.points, 500, '积分不受影响');

    const back = await patch(s.port, { playerId, inPool: true }, h);
    assert.equal(back.body.data.inPool, true, 'inPool=true 放回池内');
    assert.equal(back.body.data.points, 500);
  });
});

test('AP-3 峰值只升不降：调低段位/积分不会压低历史峰值（无法用改档伪造峰值）', async () => {
  await withPatchServer(async (s) => {
    const admin = await register(s.port, ADMIN);
    const target = await register(s.port, 'd170peak');
    const { playerId } = await archiveOf(s, target.publicId);

    const up = await patch(s.port, { playerId, tier: 'mythic', points: 2800 }, authed(admin.token));
    assert.equal(up.status, 200, up.raw);
    assert.equal(up.body.data.peakTier, 'mythic');
    assert.equal(up.body.data.peakPoints, 2800);

    const down = await patch(s.port, { playerId, tier: 'common', points: 10 }, authed(admin.token));
    assert.equal(down.status, 200, down.raw);
    assert.equal(down.body.data.tier, 'common', '现值可以被调低');
    assert.equal(down.body.data.points, 10);
    assert.equal(down.body.data.peakTier, 'mythic', '峰值**不**被压低（历史事实）');
    assert.equal(down.body.data.peakPoints, 2800, '峰值**不**被压低（历史事实）');

    // 档案不变量：peakPoints >= points（applyRecord 的自检会抛 store_inconsistent）
    const { archive } = await archiveOf(s, target.publicId);
    assert.equal(archive.progress.tier, 'common');
    assert.equal(archive.progress.peakTier, 'mythic');
    assert.equal(archive.rating.points, 10);
    assert.equal(archive.rating.peakPoints, 2800);
    assert.ok(archive.rating.peakPoints >= archive.rating.points);
  });
});

test('AP-4 改档不伪造战绩：wins/losses/games/streak 全不动', async () => {
  await withPatchServer(async (s) => {
    const admin = await register(s.port, ADMIN);
    const target = await register(s.port, 'd170record');
    const before = await archiveOf(s, target.publicId);
    // 只比较「不该被改档碰」的字段：战绩与批次计数（points/peakPoints 属于本 op 的正当改动范围）
    const recordFields = (a) => JSON.stringify({
      games: a.rating.games, wins: a.rating.wins, losses: a.rating.losses, draws: a.rating.draws,
      lastBattleAt: a.rating.lastBattleAt, seasonId: a.rating.seasonId,
      batchesPlayed: a.progress.batchesPlayed, batchesPromoted: a.progress.batchesPromoted,
    });
    const snapshotBefore = recordFields(before.archive);
    const r = await patch(s.port, { publicId: target.publicId, tier: 'rare', points: 900 }, authed(admin.token));
    assert.equal(r.status, 200, r.raw);
    const after = await archiveOf(s, target.publicId);
    assert.equal(recordFields(after.archive), snapshotBefore,
      '战绩/胜负场/连胜/批次计数不得被改档改写（只动 points 与段位，及其峰值）');
  });
});

test('AP-5 写 journal 可重放：重启同一 dataDir 后改档结果仍在（不是只改内存/索引）', async () => {
  const dataDir = makeTempDataDir('dl-d170-replay-');
  let playerId = null;
  try {
    const s1 = await startServer({ prefix: 'dl-d170-r1-', level: 'warn', dataDir, server: { env: ENV } });
    const admin = await register(s1.port, ADMIN);
    const target = await register(s1.port, 'd170persist');
    const r = await patch(s1.port, { publicId: target.publicId, tier: 'epic', points: 777 }, authed(admin.token));
    assert.equal(r.status, 200, r.raw);
    playerId = await playerIdByPublicId(s1.store, target.publicId);
    await s1.close();

    // 重启（保留数据根）：若改档只改了内存/索引而未落 journal，这里会退回 common/0
    const s2 = await startServer({ prefix: 'dl-d170-r2-', level: 'warn', dataDir, server: { env: ENV } });
    try {
      const archive = await s2.store.loadArchive(playerId);
      assert.equal(archive.progress.tier, 'epic', '重启后段位应仍为 epic（journal 重放生效）');
      assert.equal(archive.rating.points, 777, '重启后积分应仍为 777');
      // 重放幂等：再次重建索引/重放不得二次抬高或抛不变量错误
      const again = await request(s2.port, 'POST', '/api/v1/admin/account-patch',
        { playerId, points: 777 }, { 'x-admin-token': TOKEN });
      assert.equal(again.status, 200, again.raw);
      assert.equal(again.body.data.points, 777);
    } finally {
      await s2.close();
    }
  } finally {
    removeTempDir(dataDir);
  }
});

test('AP-6 参数与错误码：缺字段 400 / 非法段位 400 / 积分越界 400 / 未知目标 404', async () => {
  await withPatchServer(async (s) => {
    const admin = await register(s.port, ADMIN);
    const h = authed(admin.token);
    const target = await register(s.port, 'd170errors');
    const { playerId } = await archiveOf(s, target.publicId);

    const noTarget = await patch(s.port, { tier: 'rare' }, h);
    assert.equal(noTarget.status, 400);
    assert.equal(noTarget.body.error.code, 'bad_request');

    const noField = await patch(s.port, { playerId }, h);
    assert.equal(noField.status, 400);
    assert.equal(noField.body.error.code, 'bad_request');

    const badTier = await patch(s.port, { playerId, tier: 'godlike' }, h);
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_request');

    const badPoints = await patch(s.port, { playerId, points: 3001 }, h);
    assert.equal(badPoints.status, 400);
    assert.equal(badPoints.body.error.code, 'bad_request');
    const negPoints = await patch(s.port, { playerId, points: -1 }, h);
    assert.equal(negPoints.status, 400);
    const floatPoints = await patch(s.port, { playerId, points: 1.5 }, h);
    assert.equal(floatPoints.status, 400);
    const strPoints = await patch(s.port, { playerId, points: '100' }, h);
    assert.equal(strPoints.status, 400);

    const badPool = await patch(s.port, { playerId, inPool: 'yes' }, h);
    assert.equal(badPool.status, 400);

    const unknown = await patch(s.port, { publicId: 'u_nope' }, h);
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'store_not_found');

    // 失败请求一律不得改动档案
    const { archive } = await archiveOf(s, target.publicId);
    assert.equal(archive.progress.tier, 'common');
    assert.equal(archive.rating.points, 0);
    assert.equal(archive.pool.inPool, true);
  });
});

test('AP-7 权限：非管理员账号 403；无身份 + 正确管理令牌 200（两条既有路径都不变）', async () => {
  await withPatchServer(async (s) => {
    const admin = await register(s.port, ADMIN);
    const normal = await register(s.port, 'd170plain');
    const target = await register(s.port, 'd170perm');
    const { playerId } = await archiveOf(s, target.publicId);

    const denied = await patch(s.port, { playerId, tier: 'rare' }, authed(normal.token));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.error.code, 'forbidden');

    const anon = await patch(s.port, { playerId, tier: 'rare' });
    assert.equal(anon.status, 403, '无令牌无身份（令牌已配置）→ 403');

    const byToken = await patch(s.port, { playerId, tier: 'rare' }, { 'x-admin-token': TOKEN });
    assert.equal(byToken.status, 200, byToken.raw);
    assert.equal(byToken.body.data.tier, 'rare');

    const byAdminBearer = await patch(s.port, { playerId, points: 42 }, authed(admin.token));
    assert.equal(byAdminBearer.status, 200, byAdminBearer.raw);
    assert.equal(byAdminBearer.body.data.points, 42);
  });
});

test('AP-8 改档后快速对战真实生效：inPool=false 的账号不再被抽为对手', async () => {
  // 池内只留 A 一个候选；把唯一候选 B 踢出池后，A 的匹配应回 shortfall/no_opponent 而不是抽到 B。
  const authConfig = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };
  await withPatchServer(async (s) => {
    const admin = await register(s.port, ADMIN);
    const h = authed(admin.token);
    const a = await register(s.port, 'd170poola');
    const b = await register(s.port, 'd170poolb');
    const { playerId: bId } = await archiveOf(s, b.publicId);

    const kick = await patch(s.port, { playerId: bId, inPool: false }, h);
    assert.equal(kick.status, 200, kick.raw);
    assert.equal(kick.body.data.inPool, false);

    const qm = await request(s.port, 'POST', '/api/v1/quick/run', {}, authed(a.token));
    assert.equal(qm.status, 200, `快速对战应 200（极端情况也不可用 5xx 表达"没人"）：${qm.raw.slice(0, 200)}`);
    assert.notEqual(qm.body.data.opponent && qm.body.data.opponent.publicId, b.publicId,
      '被踢出池的账号不应再被抽为对手');
  }, { authConfig });
});
