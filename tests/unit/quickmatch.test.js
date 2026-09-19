'use strict';
/* tests/unit/quickmatch.test.js —— 快速对战（store 驱动：匹配 + 双向结算 + 落盘）测试
 * 权威：docs/systems/11-account-store.md §8（流程/匹配/双向结算/bot 例外）、§10.2（响应示例）、§8.6（排行榜）；
 *      decisions.md D-133（非对称 Elo）/D-135（回放只存引用）。
 * 🚫 无占位 bot：匹配池只来自注册表（真实玩家档案 + 真实快照）；无候选 → `no_opponent`（不注入 bot）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const qm = require('../../server/quickmatch.js');
const ledger = require('../../server/store/ledger.js');
const archiveMod = require('../../server/store/archive.js');
const h = require('../helpers/ranked.js');

// 双向结算复算：双方 Δ / 结算后积分 / [0,cap] 边界 / 非零和标记 全部按公式独立验证
function assertEloRecomputable(data, cfg, label) {
  const { self, opponent } = data;
  const p1Result = data.winner === 'win' ? 'win' : data.winner === 'loss' ? 'loss' : 'draw';
  const p2Result = p1Result === 'win' ? 'loss' : p1Result === 'loss' ? 'win' : 'draw';
  const e1 = ledger.ratingDelta({ points: self.pointsBefore, opponentPoints: opponent.pointsBefore, result: p1Result, config: cfg });
  const e2 = ledger.ratingDelta({ points: opponent.pointsBefore, opponentPoints: self.pointsBefore, result: p2Result, config: cfg });
  assert.equal(self.delta, e1.delta, `${label}: 发起者 Δ 可复算`);
  assert.equal(self.pointsAfter, e1.pointsAfter, `${label}: 发起者积分 = clamp(R+Δ)`);
  assert.equal(opponent.delta, e2.delta, `${label}: 对手 Δ 可复算`);
  assert.equal(opponent.pointsAfter, e2.pointsAfter, `${label}: 对手积分 = clamp(R+Δ)`);
  assert.ok(self.pointsAfter >= 0 && self.pointsAfter <= cfg.cap, `${label}: 发起者积分在 [0,cap]`);
  assert.ok(opponent.pointsAfter >= 0 && opponent.pointsAfter <= cfg.cap, `${label}: 对手积分在 [0,cap]`);
  // D-133 非零和：**同分、高于起点、且分出胜负**时，赢家加分 < 输家扣分（系统存在分数汇）。
  // 两个边界不适用该式：① 双方都是 base（R=0）时 K_gain=K_loss 且 E=0.5 → 恰好对称；
  // ② 平局（Δ 向期望靠拢）与触及 clamp 的档。这些都由 Δ 公式本身复算覆盖。
  if (self.pointsBefore === opponent.pointsBefore && self.pointsBefore > (cfg.base || 0) && data.winner !== 'draw') {
    assert.ok(self.delta + opponent.delta < 0, `${label}: 同分胜负局面净变化为负（分数汇，D-133）`);
  }
}

test('T-QM-R1 store 驱动：匹配 → 跑一场 → 双向 Elo → 双方档案落盘（离线对手也能看到）', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(2);
  const me = players[0];
  const foe = players[1];
  const quick = qm.createQuickMatch({ store: fx.store, logger: fx.logger });
  const r = await quick.run({ playerId: me.playerId, seed: 424242 });
  assert.equal(r.status, 200, JSON.stringify(r));
  const d = r.data;
  assert.ok(d.battleId.startsWith('b_'), 'battleId 内容寻址（b_ 前缀）');
  // seed = **实际用于战斗的种子**（§10.2 缺省服务端生成并回带；`seed` 入参用于派生）
  const runSeed = 424242;
  const derived = require('../../server/core/rng.js').createRng(runSeed).deriveStream(0, 'quick').int(1, 0x7fffffff);
  assert.equal(d.seed, derived, 'seed 回带 = 实际战斗种子（由入参 seed 确定性派生）');
  assert.equal(require('../../server/core/rng.js').createRng(runSeed).deriveStream(0, 'quick').int(1, 0x7fffffff), d.seed, '同入参 → 同战斗种子（可复现）');
  assert.ok(['win', 'loss', 'draw'].includes(d.winner));
  assert.equal(d.opponent.playerId, foe.playerId, '匹配到同池的唯一真实对手');
  assert.equal(d.opponent.isBot, false, '对手是真实玩家（非 bot）');
  assertEloRecomputable(d, fx.RATING, 'T-QM-R1');

  // 双方档案都更新（§8.4 双向结算）
  const mine = await fx.store.loadArchive(me.playerId);
  const theirs = await fx.store.loadArchive(foe.playerId);
  assert.equal(mine.rating.points, d.self.pointsAfter, '发起者积分已落盘');
  assert.equal(theirs.rating.points, d.opponent.pointsAfter, '对手积分已落盘（离线结算）');
  assert.equal(mine.rating.games, 1);
  assert.equal(theirs.rating.games, 1, '对手的快速对战场次也 +1');
  assert.equal(mine.record.stats.attack.wins + mine.record.stats.attack.losses + mine.record.stats.attack.draws, 1);
  assert.equal(theirs.record.stats.defense.wins + theirs.record.stats.defense.losses + theirs.record.stats.defense.draws, 1);
  assert.equal(mine.record.unread.attack, 1);
  assert.equal(theirs.record.unread.defense, 1);
  // journal 记录（D-134/D-135：只存引用，不存帧）
  const record = await fx.store.findBattleRecord(d.battleId);
  assert.ok(record, 'journal 里有该 battleId 的记录');
  assert.equal(record.mode, 'quick');
  assert.equal(record.seed, d.seed, 'journal 记录里的 seed = 实际战斗种子');
  assert.equal(record.p1.playerId, me.playerId);
  assert.equal(record.p2.playerId, foe.playerId);
  assert.equal(record.p1.snapshotHash, mine.configs.activeSnapshotHash, '记录里存快照引用（回放可重算）');
  assert.equal(record.versions.engine, fx.VERSIONS.engine);
  assert.ok(!record.frames, 'journal 记录不含帧（D-135）');
  assert.equal(d.replayId, d.battleId);
});

test('T-QM-R2 幂等：同一 battleSeed + 同双方快照 → 同 battleId，不重复记账（D-134）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(2);
  const quick = qm.createQuickMatch({ store: fx.store });
  // 先把双方积分抬到同分（≥base）以便观察分数汇；对手 25h 前打过 → 落在 24–72h 放宽窗（仍可匹配）
  await fx.store.updateArchive(players[0].playerId, (ar) => {
    ar.rating.points = 1200; ar.rating.peakPoints = 1200;
    ar.pool.lastOpponentAt[players[1].playerId] = fx.clock.now() - 25 * 3600 * 1000;
    return null;
  });
  await fx.store.updateArchive(players[1].playerId, (ar) => { ar.rating.points = 1200; ar.rating.peakPoints = 1200; return null; });
  await fx.store.index.rebuild();
  const first = await quick.run({ playerId: players[0].playerId, seed: 777, battleSeed: 555001 });
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(first.data.seed, 555001, '注入的战斗种子原样使用');
  // 同分（>base）净变化：胜/负时赢家加分 < 输家扣分（分数汇）；平局恰好为 0（公式在该点对称）
  if (first.data.winner !== 'draw') {
    assert.ok(first.data.self.delta + first.data.opponent.delta < 0, '同分（>base）胜负局面净变化为负 → 分数汇');
  }
  const before = await fx.store.loadArchive(players[0].playerId);
  // 同 battleSeed + 同双方快照 → battleId 相同 → settleBattle 命中既有记录（duplicate）
  // （先跨过 72h 去重窗口，保证能重新抽到同一对手；battleSeed 不变 → battleId 不变）
  fx.clock.advance(73 * 3600 * 1000);
  const again = await quick.run({ playerId: players[0].playerId, seed: 777, battleSeed: 555001 });
  assert.equal(again.status, 200, JSON.stringify(again));
  assert.equal(again.data.battleId, first.data.battleId, '内容寻址 → 同 battleId');
  assert.equal(again.data.duplicate, true, '重复结算被识别（幂等）');
  const after = await fx.store.loadArchive(players[0].playerId);
  assert.equal(after.rating.points, before.rating.points, '重复结算不再改积分');
  assert.equal(after.rating.games, before.rating.games, '重复结算不再计场次');
  assert.equal(after.record.recent.length, before.record.recent.length, 'recent 不重复入列');
});

test('T-QM-R3 无对手 → 409 no_opponent（不注入 bot）；错误档案/坏 seed 各自报错', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const me = await fx.registerPlayer();
  const quick = qm.createQuickMatch({ store: fx.store });
  const solo = await quick.run({ playerId: me.playerId, seed: 5 });
  assert.equal(solo.status, 409);
  assert.equal(solo.code, 'no_opponent');
  assert.equal((await fx.store.loadArchive(me.playerId)).rating.games, 0, '无对手 → 不产生任何记账');
  const missing = await quick.run({ playerId: h.makePlayerId(999), seed: 5 });
  assert.equal(missing.status, 404);
  assert.equal(missing.code, 'store_not_found');
  const noId = await quick.run({ seed: 5 });
  assert.equal(noId.status, 400);
  assert.equal(noId.code, 'bad_request');
  const badSeed = await quick.run({ playerId: me.playerId, seed: 0 });
  assert.equal(badSeed.status, 400);
  assert.equal(badSeed.code, 'bad_seed');
});

test('T-QM-R4 非真实玩家：无出战配置（无快照）的档案 → no_active_config；不参与匹配', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const a = await fx.registerPlayer();
  // 造一个"没有快照"的档案（不变量破损态）——直接删掉槽内快照引用 + 标记空槽
  await fx.store.updateArchive(h.makePlayerId(42), (ar) => {
    ar.configs.slots = [];
    ar.configs.activeSlotId = null;
    ar.configs.activeSnapshotHash = null;
    ar.flags.rebuiltFromCheckpoint = true; // 允许"无槽"通过不变量校验（仅测试构造）
    return null;
  }, { create: () => archiveMod.createArchiveShell(h.makePlayerId(42), fx.clock.now()) });
  await fx.store.index.rebuild();
  const quick = qm.createQuickMatch({ store: fx.store });
  const empty = await quick.run({ playerId: h.makePlayerId(42), seed: 3 });
  assert.equal(empty.status, 409);
  assert.equal(empty.code, 'no_active_config');
  // 对 a 而言：唯一候选（空档案）没有可用快照 → 池为空 → no_opponent
  const r = await quick.run({ playerId: a.playerId, seed: 3 });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'no_opponent');
});

test('T-QM-R5 匹配窗口：候选分差超出 maxWindow → no_opponent；分差在窗口内 → 命中', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(2);
  const me = players[0];
  const quick = qm.createQuickMatch({ store: fx.store });
  // 把对手分数拉到 900 分（|900−0| > matchWindowMax=600）→ 无候选
  await fx.store.updateArchive(players[1].playerId, (ar) => { ar.rating.points = 900; ar.rating.peakPoints = 900; return null; });
  await fx.store.index.rebuild();
  const far = await quick.run({ playerId: me.playerId, seed: 8 });
  assert.equal(far.status, 409);
  assert.equal(far.code, 'no_opponent', '分差 900 > 窗口上限 600');
  // 压到 500 分（窗口递进到 500 命中）
  await fx.store.updateArchive(players[1].playerId, (ar) => { ar.rating.points = 500; ar.rating.peakPoints = 500; return null; });
  await fx.store.index.rebuild();
  const near = await quick.run({ playerId: me.playerId, seed: 8 });
  assert.equal(near.status, 200, JSON.stringify(near));
  assert.equal(near.data.window, 500, '窗口递进 100→…→500 命中');
  assert.equal(near.data.opponent.pointsBefore, 500);
});

test('T-QM-R6 cap 3000 不越界：满积分玩家赢球仍为 3000，Δ 由公式给出（不超 kBase）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(2);
  const me = players[0];
  const foe = players[1];
  // 我 = cap − 10（赢球 Δ 会被 clamp 到 cap）；对手同分（在窗口内）
  const start = fx.RATING.cap - 10;
  await fx.store.updateArchive(me.playerId, (ar) => { ar.rating.points = start; ar.rating.peakPoints = start; return null; });
  await fx.store.updateArchive(foe.playerId, (ar) => { ar.rating.points = start; ar.rating.peakPoints = start; return null; });
  await fx.store.index.rebuild();
  const quick = qm.createQuickMatch({ store: fx.store });
  const r = await quick.run({ playerId: me.playerId, seed: 99 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.self.pointsBefore, start, '起点接近 cap');
  assert.ok(r.data.self.pointsAfter <= fx.RATING.cap, `积分不越界（实际 ${r.data.self.pointsAfter}）`);
  assert.ok(r.data.self.delta <= fx.RATING.kBase, `Δ ≤ kBase（实际 ${r.data.self.delta}）`);
  assertEloRecomputable(r.data, fx.RATING, 'T-QM-R6');
  const mine = await fx.store.loadArchive(me.playerId);
  assert.ok(mine.rating.points <= fx.RATING.cap, '落盘积分不越界');
});

test('T-QM-R7 去重窗口：24h 内唯一对手被排除 → no_opponent；超 72h 后重新可匹', async (t) => {
  const now = Date.now();
  const fx = await h.openFixture({ startAt: now });
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(2);
  const me = players[0];
  const foe = players[1];
  await fx.store.updateArchive(me.playerId, (ar) => {
    ar.pool.lastOpponentAt[foe.playerId] = now - 1 * 3600 * 1000; // 1h 前 → 24h 硬底线内
    return null;
  });
  const quick = qm.createQuickMatch({ store: fx.store });
  const blocked = await quick.run({ playerId: me.playerId, seed: 6 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.code, 'no_opponent', '24h 内唯一对手被去重 → 无候选');
  fx.clock.advance(73 * 3600 * 1000); // 超过 72h（偏好间隔）→ 进 strict 池
  const ok = await quick.run({ playerId: me.playerId, seed: 6 });
  assert.equal(ok.status, 200, JSON.stringify(ok));
  assert.equal(ok.data.relaxed, false, '≥72h → strict 池，不标 relaxed');
  assert.equal(ok.data.opponent.playerId, foe.playerId);
});

test('T-QM-R8 bot 例外（§8.4）：对 bot 计分时 bot 积分冻结，真人正常计分', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  // bot 账号 = 普通档案 + flags.isBot（由管理端注入；此处直接建档案以隔离 admin）
  const me = await fx.registerPlayer({ nickname: '真人' });
  const bot = await fx.registerPlayer({ nickname: '调试账号', isBot: true, tier: 'common', points: 600, flags: { isBot: true, botKey: 'dl-debug-test-1' } });
  const botBefore = (await fx.store.loadArchive(bot.playerId)).rating.points;
  const quick = qm.createQuickMatch({ store: fx.store });
  const r = await quick.run({ playerId: me.playerId, seed: 31 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.opponent.playerId, bot.playerId);
  assert.equal(r.data.opponent.isBot, true, '响应标注对手是 bot（可观测）');
  const botAfter = (await fx.store.loadArchive(bot.playerId)).rating.points;
  assert.equal(botAfter, botBefore, 'bot 积分冻结（isBot 跳过积分更新）');
  assert.equal(r.data.opponent.pointsAfter, botBefore, '响应里 bot 的 pointsAfter 不变');
  const mine = await fx.store.loadArchive(me.playerId);
  assert.equal(mine.rating.games, 1, '真人正常计分');
  assert.equal(mine.rating.points, r.data.self.pointsAfter);
  assert.equal(r.data.opponent.tier, 'common');
});

test('T-QM-L1 排行榜读取接口：scope=global / tier:<t> / 非法 scope → bad_scope；不暴露 playerId', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(4);
  await fx.store.updateArchive(players[1].playerId, (ar) => { ar.rating.points = 250; ar.rating.peakPoints = 250; return null; });
  await fx.store.updateArchive(players[2].playerId, (ar) => { ar.rating.points = 150; ar.rating.peakPoints = 150; return null; });
  await fx.store.updateArchive(players[3].playerId, (ar) => { ar.progress.tier = 'rare'; ar.progress.peakTier = 'rare'; ar.rating.points = 900; ar.rating.peakPoints = 900; return null; });
  await fx.store.index.rebuild();
  const quick = qm.createQuickMatch({ store: fx.store });
  const global = await quick.loadLeaderboard({ limit: 10 });
  assert.equal(global.status, 200);
  assert.deepEqual(global.data.rows.map((r) => r.points), [900, 250, 150, 0], '按 points 降序');
  assert.deepEqual(global.data.rows.map((r) => r.rank), [1, 2, 3, 4]);
  assert.ok(global.data.rows.every((r) => r.publicId && r.playerId === undefined), '只给 publicId，不暴露 playerId');
  assert.equal(global.data.rows[0].nickname, '玩家4');
  const rare = await quick.loadLeaderboard({ scope: 'tier:rare', limit: 10 });
  assert.equal(rare.status, 200);
  assert.equal(rare.data.rows.length, 1);
  assert.equal(rare.data.rows[0].tier, 'rare');
  const bad = await quick.loadLeaderboard({ scope: 'tier:nope' });
  assert.equal(bad.status, 400);
  assert.equal(bad.code, 'bad_scope');
  const badLimit = await quick.loadLeaderboard({ limit: 0 });
  assert.equal(badLimit.status, 400);
  assert.equal(badLimit.code, 'bad_request');
});

test('T-QM-F1 工厂与入口：缺少已装配 store → TypeError；runQuickMatch 便捷入口等价', async (t) => {
  assert.throws(() => qm.createQuickMatch({}), TypeError);
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(2);
  const r = await qm.runQuickMatch({ store: fx.store }, { playerId: players[0].playerId, seed: 12 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.ok(r.data.battleId.startsWith('b_'));
});
