'use strict';
/* tests/api/api-leaderboard.test.js —— P7-4（B32）排行榜：GET /leaderboard
 *
 * 契约：docs/systems/11-account-store.md §8.6（排序与 scope）/§10.1（端点总表：无需鉴权）
 * 覆盖：正例（global / tier:common 排序、字段、不暴露 playerId）+ 负例（limit 越界 400、
 *      scope 非法 400 bad_scope）+ 无鉴权可访问。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/http.js');
const archiveMod = require('../../server/store/archive.js');

const ADMIN_TOKEN = 'lb-admin-token';
const ADMIN_ENV = { server: { env: { DL_ADMIN_TOKEN: ADMIN_TOKEN } } };
// 造 25 个账号会越过 auth 的同 IP 每分钟限速（既有行为，非本批引入）→ 用例内放宽
const FAST = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// 管理端改账号（D-170）：给测试账号造出确定的段位/积分——段位变化会盖 `tierUpdatedAt` 时间戳（D-171 段位榜的排序键）
async function patchAccount(port, body) {
  const r = await h.request(port, 'POST', '/api/v1/admin/account-patch', body, { 'x-admin-token': ADMIN_TOKEN });
  assert.equal(r.status, 200, `改账号应 200：${r.raw}`);
  return r.body.data;
}

async function board(port, qs, token) {
  const r = await h.request(port, 'GET', '/api/v1/leaderboard' + (qs || ''), undefined, token ? h.authed(token) : undefined);
  assert.equal(r.status, 200, `榜单应 200：${r.raw}`);
  return r.body.data;
}

// 用真实档案 + 手工 journal 记录构造积分梯度（apply 会落 rating.points，D-133）
// 注意：battleId = hash(batchId|matchIndex|seed|p1快照|p2快照)，**不含 playerId**；三名玩家的默认配置快照
//   内容相同 → 必须用不同 seed，否则会被内容寻址判定为同一场（幂等 duplicate，不落账）。
async function settlePts(s, winner, loser, pointsAfter, seed) {
  const w = await h.activeSlotOf(s.store, winner.playerId);
  const l = await h.activeSlotOf(s.store, loser.playerId);
  const before = w.archive.rating.points;
  const res = await h.settleRecord(s.store, {
    mode: 'quick',
    seed,
    at: Date.now(),
    p1: {
      playerId: winner.playerId, publicId: w.archive.publicId, role: 'attacker',
      snapshotHash: w.snapshotHash, configHash: w.configHash,
      pointsBefore: before, pointsAfter, result: 'win', tierBefore: 'common', tierAfter: 'common',
    },
    p2: {
      playerId: loser.playerId, publicId: l.archive.publicId, role: 'defender',
      snapshotHash: l.snapshotHash, configHash: l.configHash,
      pointsBefore: l.archive.rating.points, pointsAfter: l.archive.rating.points,
      result: 'loss', tierBefore: 'common', tierAfter: 'common',
    },
    verdict: { winner: 'p1', reason: 'hero_dead', ticks: 20 },
    versions: { engine: s.store.versions.engine, data: s.store.versions.data },
  });
}

test('LB-1 排行榜：按积分降序 + 字段完整 + 不暴露 playerId + 无需鉴权', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lba'));
    const b = await h.register(s.port, h.uniqueName('lbb'));
    const c = await h.register(s.port, h.uniqueName('lbc'));
    const aId = await h.playerIdByPublicId(s.store, a.publicId);
    const bId = await h.playerIdByPublicId(s.store, b.publicId);
    const cId = await h.playerIdByPublicId(s.store, c.publicId);
    await settlePts(s, { playerId: aId }, { playerId: bId }, 114, 9001);
    await settlePts(s, { playerId: aId }, { playerId: cId }, 150, 9002);
    await settlePts(s, { playerId: bId }, { playerId: cId }, 60, 9003);
    const r = await h.request(s.port, 'GET', '/api/v1/leaderboard');
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.data.scope, 'global');
    assert.equal(r.body.data.limit, 50);
    const rows = r.body.data.rows;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((x) => x.rank), [1, 2, 3]);
    assert.deepEqual(rows.map((x) => x.points), [150, 60, 0], '按 points 降序（§8.6）');
    assert.equal(rows[0].publicId, a.publicId);
    assert.equal(rows[0].nickname, a.nickname);
    assert.equal(rows[0].tier, 'common');
    assert.ok(!r.raw.includes('pl_'), '排行榜只给 publicId（§8.6）');
    // limit 截断
    const one = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=1');
    assert.equal(one.status, 200);
    assert.equal(one.body.data.rows.length, 1);
    assert.equal(one.body.data.rows[0].points, 150);
    // tier scope（全部 common）
    const tier = await h.request(s.port, 'GET', '/api/v1/leaderboard?scope=tier:common');
    assert.equal(tier.status, 200);
    assert.equal(tier.body.data.scope, 'tier:common');
    assert.equal(tier.body.data.rows.length, 3);
    const emptyTier = await h.request(s.port, 'GET', '/api/v1/leaderboard?scope=tier:mythic');
    assert.equal(emptyTier.status, 200);
    assert.equal(emptyTier.body.data.rows.length, 0, '无该段位玩家 → 空榜');
  });
});

test('LB-2 排行榜负例：limit 越界 400 bad_request / scope 非法 400 bad_scope / 未装配存储 503', async () => {
  await h.withServer(null, async (s) => {
    const zero = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=0');
    assert.equal(zero.status, 400);
    assert.equal(zero.body.error.code, 'bad_request');
    const huge = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=999');
    assert.equal(huge.status, 400);
    const nan = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=abc');
    assert.equal(nan.status, 400);
    const badScope = await h.request(s.port, 'GET', '/api/v1/leaderboard?scope=nope');
    assert.equal(badScope.status, 400);
    assert.equal(badScope.body.error.code, 'bad_scope');
    const badTier = await h.request(s.port, 'GET', '/api/v1/leaderboard?scope=tier:platinum');
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_scope');
  });
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'GET', '/api/v1/leaderboard');
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'store_unavailable');
  }, { server: { enableStore: false, dataDir: undefined, env: {} } });
});

/* ---------- D-171：分页 + 本人名次 + 段位榜 ---------- */

test('LB-3 分页：逐页拼起来 == 全量（无重复无遗漏）、total/hasMore 口径、越界 offset', async () => {
  await h.withServer(null, async (s) => {
    const TOTAL = 25;
    const users = [];
    for (let i = 0; i < TOTAL; i++) users.push(await h.register(s.port, h.uniqueName('lbp')));
    const ids = [];
    for (const u of users) ids.push(await h.playerIdByPublicId(s.store, u.publicId));
    // 造出互不相同的积分（i+1）→ 排序完全确定
    for (let i = 0; i < TOTAL; i++) await patchAccount(s.port, { playerId: ids[i], points: i + 1 });

    const full = await board(s.port, '?limit=100');
    assert.equal(full.total, TOTAL, 'total 必须是该榜全量（不受本页 limit 影响）');
    assert.equal(full.rows.length, TOTAL);
    assert.equal(full.hasMore, false);
    assert.deepEqual(full.rows.map((r) => r.points), Array.from({ length: TOTAL }, (_, i) => TOTAL - i), '积分降序');
    assert.deepEqual(full.rows.map((r) => r.rank), Array.from({ length: TOTAL }, (_, i) => i + 1));

    const SIZE = 7;
    const seen = [];
    let offset = 0;
    const more = [];
    for (let guard = 0; guard < 10; guard++) {
      const page = await board(s.port, `?limit=${SIZE}&offset=${offset}`);
      assert.equal(page.total, TOTAL, '每一页的 total 都相同');
      assert.equal(page.offset, offset);
      assert.equal(page.limit, SIZE);
      for (const row of page.rows) seen.push(row.publicId);
      more.push(page.hasMore);
      if (!page.hasMore) break;
      offset += page.rows.length;
    }
    assert.deepEqual(more, [true, true, true, false], 'hasMore 只在最后一页为 false');
    assert.equal(seen.length, TOTAL, '逐页拼起来必须恰好 == 全量（无重复无遗漏）');
    assert.deepEqual(seen, full.rows.map((r) => r.publicId), '逐页顺序必须与全量一致');
    assert.equal(new Set(seen).size, TOTAL, '分页不得出现重复行');

    const beyond = await board(s.port, '?offset=100&limit=7');
    assert.deepEqual(beyond.rows, []);
    assert.equal(beyond.hasMore, false, '越界 offset → 空页且 hasMore=false');
    assert.equal(beyond.total, TOTAL);
  }, Object.assign({ authConfig: FAST }, ADMIN_ENV));
});

test('LB-4 本人名次：带 Bearer 回带 data.self（名次与全量一致）；无/坏 token 时 self=null', async () => {
  await h.withServer(null, async (s) => {
    const TOTAL = 6;
    const users = [];
    for (let i = 0; i < TOTAL; i++) users.push(await h.register(s.port, h.uniqueName('lbs')));
    const ids = [];
    for (const u of users) ids.push(await h.playerIdByPublicId(s.store, u.publicId));
    for (let i = 0; i < TOTAL; i++) await patchAccount(s.port, { playerId: ids[i], points: (i + 1) * 10 });
    const me = users[2];

    const anon = await board(s.port, '?limit=100');
    assert.equal(anon.self, null, '匿名请求没有"本人名次"（不得伪造）');

    const mine = await board(s.port, '?limit=100', me.token);
    assert.ok(mine.self, '带 Bearer 应回带本人名次');
    assert.equal(mine.self.publicId, me.publicId);
    const full = await board(s.port, '?limit=100');
    const expectedRank = full.rows.findIndex((r) => r.publicId === me.publicId) + 1;
    assert.equal(mine.self.rank, expectedRank, 'self.rank 必须与同一榜同一 scope 的行位置一致');
    assert.equal(mine.self.points, (2 + 1) * 10);
    assert.ok(!JSON.stringify(mine.self).includes('pl_'), 'self 不回带 playerId');

    // 分页不影响本人名次（self 是全榜名次，不是页内序号）
    const paged = await board(s.port, '?limit=2&offset=4', me.token);
    assert.equal(paged.self.rank, expectedRank, 'self 是全榜名次（与 offset 无关）');

    // 坏 token：按匿名处理（榜单仍 200）—— 与既有"公开榜单"语义一致
    const bad = await h.request(s.port, 'GET', '/api/v1/leaderboard?limit=100', undefined, h.authed('not-a-token'));
    assert.equal(bad.status, 200, bad.raw);
    assert.equal(bad.body.data.self, null);

    // scope 内名次：只有 common 段位 → 与全榜相同的 rank 口径
    const scoped = await board(s.port, '?scope=tier:common&limit=100', me.token);
    assert.equal(scoped.self.rank, scoped.rows.findIndex((r) => r.publicId === me.publicId) + 1);
  }, Object.assign({ authConfig: FAST }, ADMIN_ENV));
});

test('LB-5 段位榜（order=arrival）：段位高→低、同段位按 tierUpdatedAt 升序（先到者在前）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lbt1'));
    const b = await h.register(s.port, h.uniqueName('lbt2'));
    const c = await h.register(s.port, h.uniqueName('lbt3'));
    const ids = {
      a: await h.playerIdByPublicId(s.store, a.publicId),
      b: await h.playerIdByPublicId(s.store, b.publicId),
      c: await h.playerIdByPublicId(s.store, c.publicId),
    };
    // 先到 epic 的顺序：a 再 b；c 稍后到 legendary（每次之间 sleep 保证时间戳严格递增）
    assert.equal((await patchAccount(s.port, { playerId: ids.a, tier: 'epic' })).tier, 'epic');
    await sleep(10);
    assert.equal((await patchAccount(s.port, { playerId: ids.b, tier: 'epic' })).tier, 'epic');
    await sleep(10);
    assert.equal((await patchAccount(s.port, { playerId: ids.c, tier: 'legendary' })).tier, 'legendary');

    const arrival = await board(s.port, '?order=arrival&limit=100');
    assert.equal(arrival.order, 'arrival');
    assert.equal(arrival.rows[0].publicId, c.publicId, '段位最高者在前');
    assert.equal(arrival.rows[0].tier, 'legendary');
    const epics = arrival.rows.filter((r) => r.tier === 'epic');
    assert.deepEqual(epics.map((r) => r.publicId), [a.publicId, b.publicId], '同段位按到达时间升序（先到者在前）');
    assert.ok(epics[0].tierUpdatedAt < epics[1].tierUpdatedAt, '到达时间必须严格递增（sleep 保证）');
    assert.ok(Number.isInteger(arrival.rows[0].tierUpdatedAt), '段位榜行必须带回 tierUpdatedAt');
    // 段位序：legendary(4) > epic(2) > common(0)（本用例只有 3 个账号）
    const tiers = arrival.rows.map((r) => r.tier);
    assert.deepEqual(tiers, ['legendary', 'epic', 'epic'], tiers.join(','));

    // 积分榜仍是积分序（order 缺省 = points）
    await patchAccount(s.port, { playerId: ids.b, points: 999 });
    const points = await board(s.port, '?limit=100');
    assert.equal(points.order, 'points');
    assert.equal(points.rows[0].publicId, b.publicId, '积分榜按积分降序（与段位榜口径不同）');
    assert.equal(points.rows[0].tier, 'epic');

    // 单段位榜：scope=tier:epic → 只有 epics，且仍按到达时间
    const scoped = await board(s.port, '?scope=tier:epic&order=arrival&limit=100');
    assert.deepEqual(scoped.rows.map((r) => r.publicId), [a.publicId, b.publicId]);
    assert.deepEqual(scoped.rows.map((r) => r.rank), [1, 2]);

    // 段位榜里本人名次
    const mine = await board(s.port, '?order=arrival&limit=100', a.token);
    assert.equal(mine.self.rank, 2, 'a 在段位榜第 2（c 之后）');
    assert.equal(mine.self.tier, 'epic');
  }, Object.assign({ authConfig: FAST }, ADMIN_ENV));
});

test('LB-6 分页/排序参数负例：offset 非法 400、order 非法 400、scope 非法仍 bad_scope', async () => {
  await h.withServer(null, async (s) => {
    for (const qs of ['?offset=-1', '?offset=abc', '?offset=1.5', '?order=xxx', '?order=POINTS']) {
      const r = await h.request(s.port, 'GET', '/api/v1/leaderboard' + qs);
      assert.equal(r.status, 400, `${qs} 应 400：${r.raw}`);
      assert.equal(r.body.error.code, 'bad_request', qs);
    }
    const badScope = await h.request(s.port, 'GET', '/api/v1/leaderboard?order=arrival&scope=nope');
    assert.equal(badScope.status, 400);
    assert.equal(badScope.body.error.code, 'bad_scope');
    const ok = await h.request(s.port, 'GET', '/api/v1/leaderboard?offset=0&limit=1&order=points');
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.order, 'points');
    assert.equal(ok.body.data.offset, 0);
  }, ADMIN_ENV);
});

test('LB-8 D-171 审查 F7-A：封禁/解封必须立刻反映到两张榜（缓存不得漏失效 banned）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lbban1'));
    const b = await h.register(s.port, h.uniqueName('lbban2'));
    const c = await h.register(s.port, h.uniqueName('lbban3'));
    const aId = await h.playerIdByPublicId(s.store, a.publicId);
    await patchAccount(s.port, { playerId: aId, points: 999 });   // a 成为积分榜榜首
    // 预热两张榜的排序缓存（关键：先查询，再封禁）
    const warmPoints = await board(s.port, '?order=points&limit=100');
    const warmArrival = await board(s.port, '?order=arrival&limit=100');
    assert.equal(warmPoints.rows.length, 3);
    assert.equal(warmArrival.rows.length, 3);
    assert.equal(warmPoints.rows[0].publicId, a.publicId);

    const ban = await h.request(s.port, 'POST', '/api/v1/admin/ban', { playerId: aId }, { 'x-admin-token': ADMIN_TOKEN });
    assert.equal(ban.status, 200, ban.raw);
    // 封禁**不改变任何排序键**（points/tier/tierUpdatedAt 全不变）⇒ 只有 banned 失效条件能救它
    const afterPoints = await board(s.port, '?order=points&limit=100');
    const afterArrival = await board(s.port, '?order=arrival&limit=100');
    assert.equal(afterPoints.rows.length, 2, '被封禁者必须立刻从积分榜消失（systems/11 §8.6）');
    assert.equal(afterArrival.rows.length, 2, '被封禁者必须立刻从段位榜消失');
    assert.equal(afterPoints.rows.some((r) => r.publicId === a.publicId), false, '积分榜仍含被封禁者 → 缓存漏失效');
    assert.equal(afterArrival.rows.some((r) => r.publicId === a.publicId), false, '段位榜仍含被封禁者 → 缓存漏失效');
    assert.equal(afterPoints.total, 2, 'total 也必须随之减少');
    // 同一响应里 self 走新鲜数组、rows 走缓存 —— 两者必须一致（修前会自相矛盾）
    const mine = await board(s.port, '?order=points&limit=100', a.token);
    assert.equal(mine.self, null, '被封禁者自己也不应在榜内（self=null）');
    assert.ok(!mine.rows.some((r) => r.publicId === a.publicId));

    const unban = await h.request(s.port, 'POST', '/api/v1/admin/unban', { playerId: aId }, { 'x-admin-token': ADMIN_TOKEN });
    assert.equal(unban.status, 200, unban.raw);
    const backPoints = await board(s.port, '?order=points&limit=100');
    const backArrival = await board(s.port, '?order=arrival&limit=100');
    assert.equal(backPoints.rows.length, 3, '解封后应立刻回到榜上');
    assert.equal(backArrival.rows.length, 3);
    assert.equal(backPoints.rows[0].publicId, a.publicId, '解封后仍应是榜首（999 分）');
  }, ADMIN_ENV);
});

test('LB-9 D-171 审查 F7-B：**档案**本身缺 tierUpdatedAt → 读档兜底盖章；迁移必须收敛（第二次开机不再重建）', async () => {
  const dataDir = h.makeTempDataDir('dl-lb-mig2-');
  const indexPath = () => path.join(dataDir, 'index.json');
  const archivePathOf = (playerId) => path.join(dataDir, archiveMod.archiveRelPath(playerId));
  try {
    // 第一次开机：造两个账号并给不同段位
    const s1 = await h.startServer({ prefix: 'dl-lb-migb1-', level: 'warn', dataDir, server: { env: { DL_ADMIN_TOKEN: ADMIN_TOKEN } } });
    const a = await h.register(s1.port, h.uniqueName('lbmb1'));
    const b = await h.register(s1.port, h.uniqueName('lbmb2'));
    const aId = await h.playerIdByPublicId(s1.store, a.publicId);
    const bId = await h.playerIdByPublicId(s1.store, b.publicId);
    await patchAccount(s1.port, { playerId: aId, tier: 'rare' });
    await sleep(10);
    await patchAccount(s1.port, { playerId: bId, tier: 'epic' });
    await s1.close();

    // 退化**档案**（不是只退化索引）：删掉 progress.tierUpdatedAt，同时删掉索引里的键
    for (const pid of [aId, bId]) {
      const file = archivePathOf(pid);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      delete raw.progress.tierUpdatedAt;
      fs.writeFileSync(file, JSON.stringify(raw));
    }
    const rawIndex = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    for (const pid of Object.keys(rawIndex.players)) delete rawIndex.players[pid].tierUpdatedAt;
    fs.writeFileSync(indexPath(), JSON.stringify(rawIndex, null, 2));

    // 第二次开机：迁移从档案重建（此时档案已被读档兜底盖章）→ 索引拿到整数值
    const s2 = await h.startServer({ prefix: 'dl-lb-migb2-', level: 'info', dataDir, server: { env: { DL_ADMIN_TOKEN: ADMIN_TOKEN } } });
    try {
      assert.equal(s2.store.index.needsTierStamp(), false, '第一次迁移后索引必须已补齐（收敛）');
      const arrival = await board(s2.port, '?order=arrival&limit=100');
      assert.equal(arrival.rows[0].tier, 'epic');
      const epic = arrival.rows.find((r) => r.tier === 'epic');
      const rare = arrival.rows.find((r) => r.tier === 'rare');
      assert.ok(Number.isInteger(epic.tierUpdatedAt) && Number.isInteger(rare.tierUpdatedAt),
        '档案兜底盖章后索引值必须是整数（否则段位榜排序失真）');
      assert.ok(rare.tierUpdatedAt < epic.tierUpdatedAt, '盖章值来自 createdAt → 老账号在前（保守代理，不伪造最近变化）');
      // 档案也被写回（一次性盖章，不是每次开机重做）
      for (const pid of [aId, bId]) {
        const raw = JSON.parse(fs.readFileSync(archivePathOf(pid), 'utf8'));
        assert.ok(Number.isInteger(raw.progress.tierUpdatedAt), `档案 ${pid} 应已落盘盖章`);
      }
    } finally {
      await s2.close();
    }
    // 第三次开机：**不得**再出现迁移日志（否则就是 F7-B 的"每次开机全量重建"）
    const s3 = await h.startServer({ prefix: 'dl-lb-migb3-', level: 'info', dataDir, server: { env: { DL_ADMIN_TOKEN: ADMIN_TOKEN } } });
    try {
      assert.equal(s3.store.index.needsTierStamp(), false, '第三次开机不应再需要迁移');
      const migrations = s3.logger.records.filter((r) => String(r.msg || '').includes('tierUpdatedAt')).length;
      assert.equal(migrations, 0, `第三次开机不得再触发 tierUpdatedAt 迁移（实际 ${migrations} 次）`);
    } finally {
      await s3.close();
    }
  } finally {
    h.removeTempDir(dataDir);
  }
});

test('LB-7 D-171 迁移：老索引缺 tierUpdatedAt → 开机从档案补齐（段位榜排序不失真）', async () => {
  const dataDir = h.makeTempDataDir('dl-lb-mig-');
  let indexPath = null;
  try {
    const s1 = await h.startServer({ prefix: 'dl-lb-mig1-', level: 'warn', dataDir, server: { env: { DL_ADMIN_TOKEN: ADMIN_TOKEN } } });
    const a = await h.register(s1.port, h.uniqueName('lbm1'));
    const b = await h.register(s1.port, h.uniqueName('lbm2'));
    const aId = await h.playerIdByPublicId(s1.store, a.publicId);
    const bId = await h.playerIdByPublicId(s1.store, b.publicId);
    await patchAccount(s1.port, { playerId: aId, tier: 'rare' });
    await sleep(10);
    await patchAccount(s1.port, { playerId: bId, tier: 'epic' });
    await s1.close();

    // 手工退化索引：删掉每个条目的 tierUpdatedAt（= D-171 之前落盘的形状），保留 indexVersion
    indexPath = path.join(dataDir, 'index.json');
    assert.ok(fs.existsSync(indexPath), `索引文件应存在：${indexPath}`);
    const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    for (const pid of Object.keys(raw.players)) delete raw.players[pid].tierUpdatedAt;
    fs.writeFileSync(indexPath, JSON.stringify(raw, null, 2));
    assert.ok(Object.values(JSON.parse(fs.readFileSync(indexPath, 'utf8')).players)
      .every((e) => e.tierUpdatedAt === undefined), '预置条件：退化索引里没有 tierUpdatedAt');

    // 同 dataDir 重启 → open() 必须检测到并**从档案重建**索引
    const s2 = await h.startServer({ prefix: 'dl-lb-mig2-', level: 'info', dataDir, server: { env: { DL_ADMIN_TOKEN: ADMIN_TOKEN } } });
    try {
      const arrival = await board(s2.port, '?order=arrival&limit=100');
      const epic = arrival.rows.find((r) => r.tier === 'epic');
      const rare = arrival.rows.find((r) => r.tier === 'rare');
      assert.ok(epic && rare, '两账号都应在榜上');
      assert.ok(Number.isInteger(epic.tierUpdatedAt) && Number.isInteger(rare.tierUpdatedAt),
        '迁移后每个条目的 tierUpdatedAt 必须已补齐');
      assert.equal(arrival.rows[0].tier, 'epic', '段位榜排序仍正确（高段位在前）');
      assert.ok(rare.tierUpdatedAt < epic.tierUpdatedAt, '到达时间关系保持（rare 先到）');
      const stamped = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      assert.ok(Object.values(stamped.players).every((e) => Number.isInteger(e.tierUpdatedAt)),
        '补齐结果必须落盘（否则每次开机都要重建）');
      assert.ok(s2.logger.records.some((r) => String(r.msg || '').includes('tierUpdatedAt')),
        '迁移必须留痕（info 日志说明原因，不是"索引损坏"）');
    } finally {
      await s2.close();
    }
  } finally {
    h.removeTempDir(dataDir);
  }
});

