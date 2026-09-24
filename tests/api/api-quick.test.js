'use strict';
/* tests/api/api-quick.test.js —— P7-4（B31/B32）快速对战与档案驱动排位接线
 *
 * 契约：docs/systems/11-account-store.md §7（异步排位 D-132）/§8（快速对战与非对称 Elo D-133）
 *      /§10.1（端点总表）；docs/interfaces.md §2（quick/run、ranked/run、ranked/promote 行）
 * 覆盖：快速对战正例（对手池 = 真实档案、双向落盘、无 bot）+ 负例（409 no_opponent、401、400 bad_seed、
 *      400 pool_forbidden）+ 档案驱动排位的 shortfall（池不足不注入 bot，D-152）+ 晋升读档案（403 不一致）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');
const battleApi = require('../../server/battle.js');
const loadoutApi = require('../../server/loadout.js');
const LD = require('../fixtures/loadout-ok.json');

test('QU-1 POST /quick/run：抽真实档案对手 + 双向 Elo 落盘 + 回放引用 + 排行榜联动', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('qa'));
    const b = await h.register(s.port, h.uniqueName('qb'));
    const r = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 20260919 }, h.authed(a.token));
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    const d = r.body.data;
    assert.equal(typeof d.battleId, 'string');
    assert.match(d.battleId, /^b_[0-9a-f]{16}$/, 'battleId 内容寻址（§9.1）');
    assert.ok(Number.isInteger(d.seed) && d.seed >= 1, 'seed 回带（对局种子由匹配种子派生）');
    assert.ok(['win', 'loss', 'draw'].includes(d.winner));
    assert.ok(d.ticks >= 1);
    assert.equal(d.replayId, d.battleId);
    assert.equal(d.self.pointsBefore, 0);
    assert.ok(d.self.pointsAfter >= 0 && d.self.pointsAfter <= 3000, '积分恒在 [0, cap]（D-133）');
    assert.equal(d.opponent.publicId, b.publicId, '对手来自真实档案（非 bot）');
    assert.equal(typeof d.opponent.delta, 'number');
    assert.equal(d.opponent.pointsBefore, 0);
    assert.ok(!r.raw.includes('pl_'), '响应不得回带 playerId');
    // 双方档案都落盘（D-133 双向结算）→ A 进攻战绩、B 防守战绩
    const recA = await h.request(s.port, 'GET', '/api/v1/me/records', undefined, h.authed(a.token));
    assert.equal(recA.body.data.records.length, 1);
    assert.equal(recA.body.data.records[0].role, 'attacker');
    assert.equal(recA.body.data.records[0].battleId, d.battleId);
    const defB = await h.request(s.port, 'GET', '/api/v1/me/defense', undefined, h.authed(b.token));
    assert.equal(defB.status, 200, defB.raw);
    assert.equal(defB.body.data.drawnCount, 1, '被抽方离线也记防守战绩（D-132）');
    assert.equal(defB.body.data.recent[0].battleId, d.battleId);
    const meB = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(b.token));
    assert.equal(meB.body.data.rating.points, d.opponent.pointsAfter, '双方积分均落盘（双向计分）');
    assert.equal(meB.body.data.progress.tier, 'common', '快速对战不改段位（双轨 D-133）');
    // 排行榜与档案一致
    const lb = await h.request(s.port, 'GET', '/api/v1/leaderboard');
    const points = new Map(lb.body.data.rows.map((x) => [x.publicId, x.points]));
    assert.equal(points.get(a.publicId), d.self.pointsAfter);
    assert.equal(points.get(b.publicId), d.opponent.pointsAfter);
    // 日志：quick.match / quick.settle（通道 ranked，首段 quick）
    assert.ok(s.logger.records.some((x) => x.event === 'quick.match' && x.channel === 'ranked'));
    assert.ok(s.logger.records.some((x) => x.event === 'quick.settle' && x.channel === 'ranked'));
  });
});

test('QU-6 缺口 1 端到端：重启进程（新 store 实例、进程内镜像清空）后 quick/ranked 仍可打且插件词条真实生效', async (t) => {
  const dir = h.makeTempDataDir('dl-p1-restart-');
  let s = await h.startServer({ dataDir: dir });
  try {
    const a = await h.register(s.port, h.uniqueName('dwa'));
    const b = await h.register(s.port, h.uniqueName('dwb'));
    const c = await h.register(s.port, h.uniqueName('dwc')); // 第二名对手：24h 去重窗口内 quick 已抽走 B
    // ① 注册 → 装配配置保存（LD.loadout 引用 pa/pb/qx）+ PUT /me/warehouse
    const putWh = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: LD.warehouse }, h.authed(a.token));
    assert.equal(putWh.status, 200, putWh.raw);
    const save = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', { loadout: LD.loadout, warehouse: LD.warehouse }, h.authed(a.token));
    assert.equal(save.status, 200, save.raw);
    assert.equal(save.body.data.unverifiedLoadout, false);
    const hash = save.body.data.slot.snapshot.hash;
    const panelBefore = loadoutApi.buildPanel(LD.loadout, { warehouse: LD.warehouse, tier: 'mythic' });
    assert.equal(panelBefore.ok, true);
    const snapshotBytes = Buffer.byteLength(JSON.stringify(await s.store.snapshot.get(hash)));

    // ② 重启进程：关服务（保留数据根）→ 同目录新实例（新 store、新 runtime，进程内镜像缓存必然为空）
    await s.close();
    s = await h.startServer({ dataDir: dir });
    // D-159：仓库改为**服务端权威**（`warehouse` 段进档案、随 journal 落盘）→ 重启后 `GET /me/warehouse`
    //   是**真源**，不再是 D-130 的"进程内镜像（重启即丢）→ 404 warehouse_missing"。
    //   旧断言（404 = 镜像不落盘）已被契约废除，改断言"真源跨重启仍在且四桶/用量齐全"（等价强度）。
    const whAfter = await h.request(s.port, 'GET', `/api/v1/me/warehouse`, undefined, h.authed(a.token));
    assert.equal(whAfter.status, 200, `重启后仓库真源必须仍在（D-159）：${whAfter.raw.slice(0, 200)}`);
    assert.equal(whAfter.body.ok, true);
    assert.ok(whAfter.body.data.buckets && typeof whAfter.body.data.buckets === 'object', '回带四桶真源');
    assert.ok(Array.isArray(whAfter.body.data.buckets.role) && whAfter.body.data.buckets.role.length >= 1,
      'starter 角色仍在服务端仓库（跨重启）');
    assert.ok(whAfter.body.data.counts && whAfter.body.data.caps, '回带 counts/caps（前端用量口径）');
    assert.equal(typeof whAfter.body.data.starterIssued, 'boolean', '回带 starterIssued');
    assert.ok(whAfter.body.data.usage, '回带 usage（装配于配置几）');
    const snapAfter = await s.runtime.snapshotWarehouseOf(await h.playerIdByPublicId(s.store, a.publicId));
    assert.ok(snapAfter && snapAfter.buckets, '落地载体 = 快照自带的装配引用子集');
    // 面板逐值一致（这就是"插件词条真实生效"的实测口径）
    const panelAfter = loadoutApi.buildPanel(LD.loadout, { warehouse: snapAfter, tier: 'mythic' });
    assert.deepEqual(panelAfter.panel, panelBefore.panel, '重启后从快照重建的面板与重启前逐值一致');
    const rtOk = battleApi.buildPlayer('p1', LD.loadout, snapAfter, 'mythic');
    assert.equal(rtOk.ok, true);
    assert.deepEqual(rtOk.player, battleApi.buildPlayer('p1', LD.loadout, LD.warehouse, 'mythic').player,
      '战斗运行时逐值一致（hp/atk/def/regen/special/技能参数）');

    // ③ 重启后 quick / ranked 必须能打（修前：已校验 + 镜像不可得 → 基准面板退化；未校验 → 409）
    const quick = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 20260919 }, h.authed(a.token));
    assert.equal(quick.status, 200, `重启后 quick 必须能打：${quick.raw.slice(0, 200)}`);
    const ranked = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 20260920 }, h.authed(a.token));
    assert.equal(ranked.status, 200, `重启后 ranked 必须能打：${ranked.raw.slice(0, 200)}`);
    assert.ok(ranked.body.data.matches >= 1, `排位必须真的打满（实得 ${ranked.body.data.matches} 场）`);
    assert.equal(ranked.body.data.invalids, 0, '不得出现"抽中却实例化失败"的 invalid 场');
    // 对手（默认配置无引用）不受影响：两场都真实结算到防守战绩
    let drawn = 0;
    for (const p of [b, c]) {
      const def = await h.request(s.port, 'GET', '/api/v1/me/defense', undefined, h.authed(p.token));
      assert.equal(def.status, 200);
      drawn += def.body.data.drawnCount;
    }
    assert.equal(drawn, 1 + ranked.body.data.matches, 'quick + ranked 的场次都被真实对手接下（非退化空跑）');
    t.diagnostic(`[缺口1] 单快照 ${snapshotBytes}B（含装配引用子集）；重启后 quick+ranked 均 200，对手防守 ${drawn} 场`);
  } finally {
    await s.close();
    h.removeTempDir(dir);
  }
});

test('QU-2 快速对战负例：池中无对手 409 no_opponent / 无 token 401 / 非法 seed 400 / 坏 JSON 400', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('qm'));
    const alone = await h.request(s.port, 'POST', '/api/v1/quick/run', {}, h.authed(a.token));
    assert.equal(alone.status, 409, alone.raw);
    assert.equal(alone.body.error.code, 'no_opponent', '不注入占位 bot（§7.2/D-152）');
    const noToken = await h.request(s.port, 'POST', '/api/v1/quick/run', {});
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, 'unauthorized');
    const badSeed = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 'x' }, h.authed(a.token));
    assert.equal(badSeed.status, 400);
    assert.equal(badSeed.body.error.code, 'bad_seed');
    const badJson = await h.request(s.port, 'POST', '/api/v1/quick/run', '{nope', h.authed(a.token));
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
  });
});

test('QU-3 POST /ranked/run（有 token）：服务端抽池 + 池不足如实 shortfall（不注入 bot）+ 排位不改积分', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('ra'));
    const b = await h.register(s.port, h.uniqueName('rb'));
    const c = await h.register(s.port, h.uniqueName('rc'));
    const r = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 11 }, h.authed(a.token));
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    assert.equal(d.seed, 11);
    assert.equal(d.tier, 'common');
    assert.equal(d.requested, 10, '批次目标 10 场（D-122）');
    assert.equal(d.matches, 2, '池内仅 2 个真实对手 → 只打 2 场');
    assert.equal(d.shortfall, 8);
    assert.equal(d.wins + d.draws + d.losses + d.invalids, d.matches);
    assert.equal(d.promoted, false, '缺场批次不判晋升');
    assert.equal(d.results.length, 2);
    const ids = new Set([b.publicId, c.publicId]);
    for (const m of d.results) {
      assert.ok(ids.has(m.opponentPublicId), `对手必须是注册表里的真实玩家：${m.opponentPublicId}`);
      assert.match(m.battleId, /^b_[0-9a-f]{16}$/);
      assert.ok(!('opponentPlayerId' in m), '结果不得回带 opponentPlayerId');
    }
    // 发起者战绩 2 条；积分不变（双轨 D-133）
    const me = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(a.token));
    assert.equal(me.body.data.progress.batchesPlayed, 1);
    assert.equal(me.body.data.rating.points, 0, '排位不影响积分（D-133 双轨）');
    const rec = await h.request(s.port, 'GET', '/api/v1/me/records', undefined, h.authed(a.token));
    assert.equal(rec.body.data.records.length, 2);
    assert.equal(rec.body.data.unread.attack, 2);
    // 防守方战绩（被抽 2 位各 1 场）
    for (const p of [b, c]) {
      const def = await h.request(s.port, 'GET', '/api/v1/me/defense', undefined, h.authed(p.token));
      assert.equal(def.body.data.drawnCount, 1);
      assert.equal(def.body.data.stats.wins + def.body.data.stats.losses + def.body.data.stats.draws, 1);
    }
  });
});

test('QU-4 POST /ranked/run 负例：不接受客户端自选对手（pool → 400 pool_forbidden）/ 非法 seed 400 / 无 token 走遗留口径', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('rp'));
    const pool = await h.request(s.port, 'POST', '/api/v1/ranked/run', { pool: [] }, h.authed(a.token));
    assert.equal(pool.status, 400, pool.raw);
    assert.equal(pool.body.error.code, 'pool_forbidden', '服务端抽池，禁止自选对手（D-136）');
    const badSeed = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 0 }, h.authed(a.token));
    assert.equal(badSeed.status, 400);
    assert.equal(badSeed.body.error.code, 'bad_seed');
    // 无 token：仍是遗留无状态口径（缺 loadout → 409 no_loadout），不因"未登录"直接 401
    const legacy = await h.request(s.port, 'POST', '/api/v1/ranked/run', {});
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.error.code, 'no_loadout');
  });
});

test('QU-5 POST /ranked/promote（有 token）：段位读档案 + 403 段位不一致 + 400 wins 非法 + 不越权落盘', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('pr'));
    const ok = await h.request(s.port, 'POST', '/api/v1/ranked/promote', { wins: 7 }, h.authed(a.token));
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.data.tier, 'rare', 'common + wins>6 → 晋升判定（D-122）');
    assert.equal(ok.body.data.promoted, true);
    assert.equal(ok.body.data.reward, 'rare');
    // 兼容端点只做判定（不落盘）：晋升权威在 POST /ranked/run（§7.1 步骤 6）
    const me = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(a.token));
    assert.equal(me.body.data.progress.tier, 'common', '兼容端点不写档案（避免"不打就升段"）');
    const mismatch = await h.request(s.port, 'POST', '/api/v1/ranked/promote', { tier: 'mythic', wins: 7 }, h.authed(a.token));
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.body.error.code, 'forbidden');
    assert.ok(s.logger.records.some((x) => x.event === 'api.reject' && x.data.code === 'forbidden'));
    const badWins = await h.request(s.port, 'POST', '/api/v1/ranked/promote', { wins: 'x' }, h.authed(a.token));
    assert.equal(badWins.status, 400);
    assert.equal(badWins.body.error.code, 'bad_wins');
    // 无 token：遗留口径（tier 由入参给）
    const legacy = await h.request(s.port, 'POST', '/api/v1/ranked/promote', { tier: 'common', wins: 7 });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.data.promoted, true);
  });
});
