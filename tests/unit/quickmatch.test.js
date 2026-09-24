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
// ⚠️ 口径分界（D-133 + docs/systems/11-account-store.md §8.3「下限保护」）：
//   `ledger.ratingDelta` 回带的是**公式原始 Δ**（可为 −16 等负值）；而 `quickmatch` 响应里的 `delta`
//   是**档案落盘值之差**（`pointsAfter − pointsBefore`），受 `结果积分 = clamp(R+Δ, 0, cap)` 裁剪。
//   两者只在**未触发裁剪**时相等：例如 0 分玩家输球 → 公式 Δ=−16、落盘 Δ=0（下限保护）。
//   故本函数先断言恒真的守恒式 `delta === pointsAfter − pointsBefore`，再在未触发下限裁剪时断言公式值。
function assertEloRecomputable(data, cfg, label) {
  const { self, opponent } = data;
  const p1Result = data.winner === 'win' ? 'win' : data.winner === 'loss' ? 'loss' : 'draw';
  const p2Result = p1Result === 'win' ? 'loss' : p1Result === 'loss' ? 'win' : 'draw';
  const e1 = ledger.ratingDelta({ points: self.pointsBefore, opponentPoints: opponent.pointsBefore, result: p1Result, config: cfg });
  const e2 = ledger.ratingDelta({ points: opponent.pointsBefore, opponentPoints: self.pointsBefore, result: p2Result, config: cfg });
  // ① 守恒（恒真）：落盘 Δ 必须逐值等于 `pointsAfter − pointsBefore`（无论是否被 clamp）
  assert.equal(self.delta, self.pointsAfter - self.pointsBefore, `${label}: 发起者 Δ = 落盘前后差（守恒）`);
  assert.equal(opponent.delta, opponent.pointsAfter - opponent.pointsBefore, `${label}: 对手 Δ = 落盘前后差（守恒）`);
  // ② 公式复算：仅在**未触发下限保护**（`pointsBefore + 公式Δ ≥ 0`）时 Δ 才与公式值逐值相等（§8.3 性质 4）
  if (self.pointsBefore + e1.delta >= 0) {
    assert.equal(self.delta, e1.delta, `${label}: 发起者 Δ 可复算（未触发下限保护）`);
  } else {
    assert.equal(self.pointsAfter, 0, `${label}: 触发下限保护 → 积分被夹到 0（§8.3 性质 4）`);
    assert.equal(self.delta, self.pointsBefore === 0 ? 0 : -self.pointsBefore, `${label}: 触发下限保护 → 落盘 Δ 恰为 −R_self`);
  }
  if (opponent.pointsBefore + e2.delta >= 0) {
    assert.equal(opponent.delta, e2.delta, `${label}: 对手 Δ 可复算（未触发下限保护）`);
  } else {
    assert.equal(opponent.pointsAfter, 0, `${label}: 对手触发下限保护 → 积分被夹到 0（§8.3 性质 4）`);
    assert.equal(opponent.delta, opponent.pointsBefore === 0 ? 0 : -opponent.pointsBefore, `${label}: 对手触发下限保护 → 落盘 Δ 恰为 −R_self`);
  }
  assert.equal(self.pointsAfter, e1.pointsAfter, `${label}: 发起者积分 = clamp(R+Δ)`);
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

/* ---------- P1-3 突变告警：合法败局不再误报；篡改 Δ 仍报 ---------- */

// 用真实档案构造"指定积分 + 指定强度"的玩家（loadout 由调用方给定，避免全同默认配置导致恒平）
async function seedPlayer(fx, playerId, points, loadout) {
  const res = await fx.account.createPlayerArchive({
    playerId, nickname: playerId, loadout, tier: 'common', points, at: fx.clock(),
  });
  assert.equal(res.ok, true, `建档失败：${JSON.stringify(res).slice(0, 200)}`);
  return res.data.archive;
}

test('P1-3 合法对局不再触发 store.abuse.suspect：R=2900 败局（-31）与 R=0 胜 R=3000（+32）', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const R = fx.RATING;
  const rankedMod = require('../../server/ranked.js');
  // 案例①：我 = 2900 分 + 脆弱配置（必败）vs 同分正常对手；Δ = -round(K_loss(2900) × E(0.5)) = -31
  await seedPlayer(fx, h.makePlayerId(1), 2900, h.fragile(rankedMod.buildDefaultLoadout('probe-fragile'), 'f1'));
  await seedPlayer(fx, h.makePlayerId(2), 2900, rankedMod.buildDefaultLoadout('probe-strong'));
  const quick1 = qm.createQuickMatch({ store: fx.store, logger: fx.logger, config: R });
  const r1 = await quick1.run({ playerId: h.makePlayerId(1), seed: 31337 });
  assert.equal(r1.status, 200, JSON.stringify(r1));
  assert.equal(r1.data.winner, 'loss', '脆弱配置且对手会交战 → 必败');
  assert.equal(r1.data.self.delta, -31, 'R=2900 败局 Δ=-31（公式值）');
  assert.ok(Math.abs(r1.data.self.delta) > R.kBase / 2, '该 Δ 已超旧阈值 kBase/2=16（修前必然误报）');
  assert.ok(!fx.events().includes('store.abuse.suspect'), '合法败局**不得**产生 store.abuse.suspect');

  // 案例②：我 = 0 分 vs 3000 分脆弱对手（必败于我方）→ Δ = +round(K_gain(0) × (1-E)) = +32
  const cfgWide = { ...R, matchWindowMax: 3000 }; // 3000 分差需放宽匹配窗口（正常配置下窗口上限 600）
  await seedPlayer(fx, h.makePlayerId(11), 0, rankedMod.buildDefaultLoadout('probe-strong2'));
  await seedPlayer(fx, h.makePlayerId(12), R.cap, h.fragile(rankedMod.buildDefaultLoadout('probe-fragile2'), 'f2'));
  const quick2 = qm.createQuickMatch({ store: fx.store, logger: fx.logger, config: cfgWide });
  const r2 = await quick2.run({ playerId: h.makePlayerId(11), seed: 4242 });
  assert.equal(r2.status, 200, JSON.stringify(r2));
  assert.equal(r2.data.winner, 'win', '对满积分脆弱对手 → 我方胜');
  assert.equal(r2.data.self.delta, R.kBase, 'R=0 胜满积分对手 Δ=+32=kBase（对满分对手上限）');
  assert.ok(r2.data.self.delta > R.kBase / 2, '该 Δ 已超旧阈值 16（修前必然误报）');
  assert.ok(!fx.events().includes('store.abuse.suspect'), '合法胜局**不得**产生 store.abuse.suspect');

  // 案例③（真异常仍抓得住）：人为篡改落盘积分 —— **首次读（结算前取值）保持真值，其后每次读 +500**
  //   → 结算后回读的 Δ ≈ 500 + 公式值，远超真实上界 → 必须报（不依赖适配器内部读次数与 clamp）
  const realLoad = fx.store.loadArchive.bind(fx.store);
  let reads = 0;
  fx.store.loadArchive = async (pid) => {
    const a = await realLoad(pid);
    if (pid === h.makePlayerId(1)) {
      reads += 1;
      if (reads > 1) a.rating.points += 500;
    }
    return a;
  };
  fx.clock.advance(73 * 3600 * 1000);
  const r3 = await quick1.run({ playerId: h.makePlayerId(1), seed: 31338 });
  assert.equal(r3.status, 200, JSON.stringify(r3));
  assert.ok(Math.abs(r3.data.self.delta) > qm.maxSingleMatchDelta(R), `篡改 Δ=${r3.data.self.delta} 超真实上界`);
  assert.ok(fx.logger.records.some((x) => x.event === 'store.abuse.suspect' && Math.abs(x.data.deltaP1) > qm.maxSingleMatchDelta(R)),
    '人为篡改 Δ 超真实上界 → store.abuse.suspect(warn) 仍然触发（告警未被削弱）');
});

/* ---------- 缺陷 B：装配引用（pluginUid）与仓库镜像 ---------- */

// 造一份"真实物品 + 真实装配"的仓库与出战配置（零 HTTP：box 开箱 → core/items 装配）
function pluginWarehouseFixture() {
  const itemsApi = require('../../server/core/items.js');
  const boxApi = require('../../server/box.js');
  const rankedMod = require('../../server/ranked.js');
  let wh = itemsApi.emptyWarehouse();
  const boxed = boxApi.openBoxes({ seed: 20260919, tier: 'common', times: 24 });
  const boxedItems = boxed && boxed.data && Array.isArray(boxed.data.items) ? boxed.data.items : (boxed.items || []);
  const find = (uid) => {
    for (const list of Object.values(wh.buckets)) {
      if (!Array.isArray(list)) continue;
      const hit = list.find((x) => x && x.uid === uid);
      if (hit) return hit;
    }
    return null;
  };
  for (const it of boxedItems) {
    if (!Array.isArray(wh.buckets[it.kind])) wh.buckets[it.kind] = [];
    wh.buckets[it.kind].push(it);
  }
  const targets = wh.buckets.role.slice(0, 1).concat(wh.buckets.skill.slice(0, 3));
  for (const t0 of targets) {
    for (let i = 0; i < (t0.slots || []).length; i++) {
      const target = find(t0.uid);
      if (!target || !target.slots[i] || target.slots[i].pluginUid) continue;
      const kind = target.kind === 'role' ? 'rolePlugin' : 'skillPlugin';
      const cand = (wh.buckets[kind] || []).find((p) => p.slot === target.slots[i].type && p.equipped !== true);
      if (!cand) continue;
      const r = itemsApi.assemble(wh, { targetUid: target.uid, slotIndex: i, pluginUid: cand.uid, tier: 'common' });
      if (r && r.warehouse) wh = r.warehouse;
    }
  }
  const role = find(targets[0].uid);
  const skills = targets.slice(1).map((t) => find(t.uid));
  const refs = (role.slots || []).filter((s) => s.pluginUid).length
    + skills.reduce((n, sk) => n + (sk.slots || []).filter((s) => s.pluginUid).length, 0);
  return { warehouse: wh, loadout: { role, skills, ai: rankedMod.buildDefaultLoadout().ai }, refs };
}

/** D-159 契约变更：注册（无显式 loadout 且非 bot）即发 starter —— **默认对手也带装配引用**，
 *  其引用只存在于**服务端仓库**里，本用例的注入镜像（`warehouse`）覆盖不了。
 *  故"无镜像"缝必须**逐玩家**给：夹具玩家 → 按各用例口径（真实镜像 / null），
 *  其余玩家（starter 默认配置）→ 服务端仓库（等价真实运行时的 ⓪ 级来源），否则连正常对局也会
 *  被判 `skipped.notInstantiable` → 409 no_opponent（本组用例最初的变红主因）。 */
function foeWarehouseOf(store) {
  const cache = new Map();
  return async (playerId) => {
    if (cache.has(playerId)) return cache.get(playerId);
    let wh = null;
    const view = await store.getWarehouse(playerId);
    wh = view && view.warehouse ? view.warehouse : null;
    cache.set(playerId, wh);
    return wh;
  };
}

test('BUG-B 装配插件的出战配置三态：有镜像可打 / 已校验无镜像退化可打 / 未校验如实 missing_warehouse', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const { warehouse, loadout, refs } = pluginWarehouseFixture();
  assert.ok(refs > 0, `夹具必须带装配引用（实得 ${refs}）`);
  const me = h.makePlayerId(101);
  const created = await fx.account.createPlayerArchive({
    playerId: me, nickname: '装配玩家', loadout, warehouse, tier: 'common', at: fx.clock(),
  });
  assert.equal(created.ok, true, `装配配置应能建档（带 warehouse 校验）：${JSON.stringify(created).slice(0, 200)}`);
  const foe = await fx.registerPlayer({ playerId: h.makePlayerId(500) }); // 对手：D-159 默认（starter）配置，带引用
  const foeWarehouse = await foeWarehouseOf(fx.store);
  const rankedMod = require('../../server/ranked.js');
  assert.equal(rankedMod.needsWarehouse((await fx.store.loadArchive(foe.playerId)).configs.slots[0].loadout), true,
    'D-159：默认对手配置带装配引用（其正文在服务端仓库里）');
  assert.equal((await fx.store.loadArchive(me)).flags.unverifiedLoadout, false, '带 warehouse 建档 → 已校验');

  // ① 镜像可用 → 正常对局（插件词条生效）
  const q1 = qm.createQuickMatch({
    store: fx.store, logger: fx.logger,
    loadWarehouse: async (pid) => (pid === me ? warehouse : foeWarehouse(pid)),
  });
  const r1 = await q1.run({ playerId: me, seed: 11 });
  assert.equal(r1.status, 200, `有镜像必须能打：${JSON.stringify(r1).slice(0, 220)}`);
  assert.equal(r1.data.duplicate, false);
  // ①b 排位同样能打（缺陷 B 报告的另一半：修前 409 loadout_invalid / missing_warehouse）
  fx.clock.advance(73 * 3600 * 1000);
  const ranked1 = await rankedMod.withLogger(fx.logger, {
    loadWarehouse: async (pid) => (pid === me ? warehouse : foeWarehouse(pid)),
  }).runRankedBattle({ store: fx.store, playerId: me, seed: 21 });
  assert.equal(ranked1.status, 200, `排位有镜像必须能打：${JSON.stringify(ranked1).slice(0, 220)}`);
  assert.ok(ranked1.data.matches >= 1, `排位至少 1 场：${JSON.stringify(ranked1.data).slice(0, 160)}`);
  assert.equal(ranked1.data.invalids, 0, '不得出现"抽中却实例化失败"的 invalid 场');

  // ② 已校验但镜像不在本进程（D-130 不落盘/重启后）→ 基准面板退化对局（不再 409），并记 warn
  const q2 = qm.createQuickMatch({
    store: fx.store, logger: fx.logger,
    loadWarehouse: async (pid) => (pid === me ? null : foeWarehouse(pid)),
  });
  fx.clock.advance(73 * 3600 * 1000);
  const r2 = await q2.run({ playerId: me, seed: 12 });
  assert.equal(r2.status, 200, `已校验 + 无镜像应退化可打（修前 409 no_opponent）：${JSON.stringify(r2).slice(0, 220)}`);
  assert.ok(fx.logger.records.some((x) => x.event === 'store.snapshot.missing' && x.data && x.data.reason === 'warehouse_mirror_degraded'),
    '退化对局必须留下可观测 warn（store.snapshot.missing / warehouse_mirror_degraded）');
  fx.clock.advance(73 * 3600 * 1000);
  const ranked2 = await rankedMod.withLogger(fx.logger, {
    loadWarehouse: async (pid) => (pid === me ? null : foeWarehouse(pid)),
  }).runRankedBattle({ store: fx.store, playerId: me, seed: 22 });
  assert.equal(ranked2.status, 200, `排位退化路径同样可打：${JSON.stringify(ranked2).slice(0, 220)}`);
  assert.equal(ranked2.data.invalids, 0);

  // ③ 未校验 + 无镜像 → 如实 409 loadout_invalid + missing_warehouse（不得放宽成"永远放行"）
  await fx.store.updateArchive(me, (ar) => {
    ar.flags.unverifiedLoadout = true;
    for (const slot of ar.configs.slots) if (slot.snapshot) slot.snapshot.verifiedAgainstWarehouse = false;
    return null;
  });
  fx.clock.advance(73 * 3600 * 1000);
  const r3 = await q2.run({ playerId: me, seed: 13 });
  assert.equal(r3.status, 409, JSON.stringify(r3).slice(0, 220));
  assert.equal(r3.code, 'loadout_invalid');
  assert.ok((r3.details || []).some((d) => d.code === 'missing_warehouse'), '未校验 → 如实 missing_warehouse');
  const ranked3 = await rankedMod.withLogger(fx.logger, {
    loadWarehouse: async (pid) => (pid === me ? null : foeWarehouse(pid)),
  }).runRankedBattle({ store: fx.store, playerId: me, seed: 23 });
  assert.equal(ranked3.status, 409, JSON.stringify(ranked3).slice(0, 220));
  assert.equal(ranked3.code, 'loadout_invalid');
  assert.ok((ranked3.details || []).some((d) => d.code === 'missing_warehouse'), '排位同样如实报（不放宽）');
});

test('P1-D1 缺口 1 端到端（重启 / 淘汰）：快照自带镜像使插件词条真实生效；旧快照退化不报错；未校验仍 409', async (t) => {
  let fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const battleApi = require('../../server/battle.js');
  const rankedMod = require('../../server/ranked.js');
  const { warehouse, loadout, refs } = pluginWarehouseFixture();
  assert.ok(refs > 0, `夹具必须带装配引用（实得 ${refs}）`);
  const me = h.makePlayerId(301);
  const created = await fx.account.createPlayerArchive({
    playerId: me, nickname: '装配·重启', loadout, warehouse, tier: 'common', at: fx.clock(),
  });
  assert.equal(created.ok, true, `装配配置应能建档：${JSON.stringify(created).slice(0, 200)}`);
  await fx.registerPlayer({ playerId: h.makePlayerId(601) }); // 对手（默认配置，无引用）
  const hash = (await fx.store.loadArchive(me)).configs.slots[0].snapshot.hash;
  const snapBefore = await fx.store.snapshot.get(hash);
  assert.ok(snapBefore.warehouse, '出战快照必须自带装配引用子集（缺口 1 的落盘载体）');

  // —— 进程重启：close → 同目录新 store 实例（进程内镜像缓存必然为空） ——
  fx = await fx.reopen();
  const archive2 = await fx.store.loadArchive(me);
  assert.equal(archive2.flags.unverifiedLoadout, false, '重启后仍是"已校验"');
  const snapAfter = await fx.store.snapshot.get(hash);
  assert.deepEqual(snapAfter.warehouse, snapBefore.warehouse, '重启后镜像逐值一致');

  // ① 面板逐值一致（这就是"插件词条真实生效"的实测口径）
  const withSnapshot = battleApi.buildPlayer('p1', loadout, snapAfter.warehouse, 'common');
  const withRealMirror = battleApi.buildPlayer('p1', loadout, warehouse, 'common');
  assert.equal(withSnapshot.ok, true);
  assert.deepEqual(withSnapshot.player, withRealMirror.player, '重启前后玩家运行时（五维/regen/special/技能参数）逐值一致');
  const degradedPanel = battleApi.buildPlayer('p1', loadout, rankedMod.syntheticVerifiedWarehouse(loadout), 'common');
  assert.equal(degradedPanel.ok, true);
  assert.notDeepEqual(degradedPanel.player, withSnapshot.player, '退化（无词条）面板与真实面板不同 → 词条确实生效');
  const snapBytes = Buffer.byteLength(JSON.stringify(snapAfter.warehouse));
  const whBytes = Buffer.byteLength(JSON.stringify(warehouse));
  t.diagnostic(`[缺口1·真实仓库] 装配引用子集 ${snapBytes}B / 整仓 ${whBytes}B（占比 ${(snapBytes / whBytes * 100).toFixed(2)}%）；引用 ${refs} 处`);

  // ② 重启后 quick / ranked 均可打，且判定使用快照镜像（等价 rt.loadWarehouse 的③级来源）
  const fromSnapshot = async (playerId) => (playerId === me ? snapAfter.warehouse : null);
  const q1 = qm.createQuickMatch({ store: fx.store, logger: fx.logger, loadWarehouse: fromSnapshot });
  const r1 = await q1.run({ playerId: me, seed: 41 });
  assert.equal(r1.status, 200, `重启后 quick 必须能打：${JSON.stringify(r1).slice(0, 220)}`);
  fx.clock.advance(73 * 3600 * 1000);
  const rk1 = await rankedMod.withLogger(fx.logger, { loadWarehouse: fromSnapshot })
    .runRankedBattle({ store: fx.store, playerId: me, seed: 42 });
  assert.equal(rk1.status, 200, `重启后 ranked 必须能打：${JSON.stringify(rk1).slice(0, 220)}`);
  assert.equal(rk1.data.invalids, 0);

  // ③ 旧快照（无新字段）+ 已校验 → 退化路径（不报错，记 warn）
  const legacyLoadout = JSON.parse(JSON.stringify(loadout));
  legacyLoadout.role.name = '均衡(旧快照)'; // 内容不同 → 不同 hash，可造"缺口 1 之前"的正文
  const legacySnap = fx.store.freezeSnapshot(legacyLoadout);
  assert.equal(legacySnap.warehouse, undefined, '旧形状：不落装配引用子集');
  const legacyId = h.makePlayerId(302);
  await fx.store.createAccount({
    playerId: legacyId, username: 'legacy_30', nickname: '旧快照',
    auth: { algo: 'scrypt', hash: 'h_legacy30', N: 1024 },
    slot: { slotId: 'slot1', snapshotHash: legacySnap.hash, configHash: legacySnap.configHash, versions: fx.VERSIONS, warehouseVerified: true },
    at: fx.clock(),
  });
  assert.equal((await fx.store.loadArchive(legacyId)).flags.unverifiedLoadout, false, '旧口径：已校验');
  const q2 = qm.createQuickMatch({ store: fx.store, logger: fx.logger, loadWarehouse: async () => null });
  fx.clock.advance(73 * 3600 * 1000);
  const r2 = await q2.run({ playerId: legacyId, seed: 43 });
  assert.equal(r2.status, 200, `旧快照无镜像 → 退化对局（不报错）：${JSON.stringify(r2).slice(0, 220)}`);
  assert.ok(fx.logger.records.some((x) => x.event === 'store.snapshot.missing' && x.data && x.data.reason === 'warehouse_mirror_degraded'),
    '旧快照退化必须留可观测 warn（不静默）');

  // ④ 未校验 + 无镜像 → 如实 409 missing_warehouse（口径不得放宽）
  await fx.store.updateArchive(legacyId, (ar) => {
    ar.flags.unverifiedLoadout = true;
    for (const slot of ar.configs.slots) if (slot.snapshot) slot.snapshot.verifiedAgainstWarehouse = false;
    return null;
  });
  fx.clock.advance(73 * 3600 * 1000);
  const r3 = await q2.run({ playerId: legacyId, seed: 44 });
  assert.equal(r3.status, 409, JSON.stringify(r3).slice(0, 220));
  assert.ok((r3.details || []).some((d) => d.code === 'missing_warehouse'), '未校验 → 如实 missing_warehouse');
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
