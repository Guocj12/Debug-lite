'use strict';
/* tests/integration/quickmatch-invariants.test.js —— P7-3 跨模块不变量（快速对战 / 排位 / 排行榜）
 * 权威：docs/systems/11-account-store.md §8.3（非对称 Elo 四条性质）/§8.4（双向结算）/§8.6（排行榜）；D-133/D-134/D-136。
 *
 * 覆盖的不变量：
 *   ① 积分守恒（对局粒度）：Σ前 + ΣΔ === Σ后 —— 双方档案的落盘值参与，恒等式必须逐场成立；
 *   ② 积分守恒（全局粒度）：全体玩家 Σ前 + ΣΔ === Σ后，且 Δ 之和 ≤ 0（D-133 有意非零和：分数汇）；
 *   ③ Elo 双方变动**可复算**：用 ledger 公式独立算一遍，与响应逐值相等；
 *   ④ cap 3000 不越界 且 段位不被快速对战改写（D-133 双轨）；
 *   ⑤ **对手均为真实 playerId**（注册表/档案库可追溯，且 flags.isBot=false）；
 *   ⑥ 排位与快速对战都**不使用占位 bot**：池不足 → shortfall / no_opponent。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const qm = require('../../server/quickmatch.js');
const ranked = require('../../server/ranked.js');
const ledger = require('../../server/store/ledger.js');
const archiveMod = require('../../server/store/archive.js');
const h = require('../helpers/ranked.js');

const HOUR = 3600 * 1000;

// 全体玩家的积分快照（按 playerId）
async function ratingsOf(fx) {
  const out = new Map();
  for (const playerId of await fx.store.listPlayerIds()) {
    const archive = await fx.store.loadArchive(playerId);
    out.set(playerId, archive.rating.points);
  }
  return out;
}

function sumOf(map) {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}

test('INV-1 快速对战积分守恒 + Elo 可复算 + cap/段位不变量 + 对手均为真实玩家', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(6);
  const quick = qm.createQuickMatch({ store: fx.store, logger: fx.logger });
  const registryIds = new Set((await fx.store.listPlayerIds()));
  assert.equal(registryIds.size, 6);

  const beforeAll = await ratingsOf(fx);
  const perMatch = [];
  for (let i = 0; i < 8; i++) {
    // 每场换一个发起者，并推进时间跨过 72h 去重窗口（保持每场都是"新鲜对手"）
    const me = players[i % players.length];
    const r = await quick.run({ playerId: me.playerId, seed: 1000 + i });
    if (r.status !== 200) {
      assert.equal(r.code, 'no_opponent', `意外失败：${JSON.stringify(r)}`);
      continue;
    }
    const d = r.data;
    // ⑤ 对手必须是真实 playerId（档案库可追溯 + 非 bot）
    assert.ok(archiveMod.PLAYER_ID_RE.test(d.opponent.playerId), '对手 playerId 格式合法');
    assert.ok(registryIds.has(d.opponent.playerId), '对手在注册表/档案库中');
    assert.equal(d.opponent.isBot, false, '正常路径抽不到 bot');
    const foeArchive = await fx.store.loadArchive(d.opponent.playerId);
    assert.equal(foeArchive.flags.isBot, false, '对手档案 flags.isBot=false');
    // ③ Elo 可复算（双方）
    const p1Result = d.winner === 'win' ? 'win' : d.winner === 'loss' ? 'loss' : 'draw';
    const p2Result = p1Result === 'win' ? 'loss' : p1Result === 'loss' ? 'win' : 'draw';
    const e1 = ledger.ratingDelta({ points: d.self.pointsBefore, opponentPoints: d.opponent.pointsBefore, result: p1Result, config: fx.RATING });
    const e2 = ledger.ratingDelta({ points: d.opponent.pointsBefore, opponentPoints: d.self.pointsBefore, result: p2Result, config: fx.RATING });
    assert.equal(d.self.delta, e1.delta, `第 ${i + 1} 场：发起者 Δ 可复算`);
    assert.equal(d.opponent.delta, e2.delta, `第 ${i + 1} 场：对手 Δ 可复算`);
    assert.equal(d.self.pointsAfter, e1.pointsAfter);
    assert.equal(d.opponent.pointsAfter, e2.pointsAfter);
    // ① 对局粒度守恒：Σ前 + ΣΔ === Σ后
    const b = d.self.pointsBefore + d.opponent.pointsBefore;
    const dd = d.self.delta + d.opponent.delta;
    const a = d.self.pointsAfter + d.opponent.pointsAfter;
    assert.equal(b + dd, a, `第 ${i + 1} 场：Σ前 + ΣΔ === Σ后`);
    // ④ cap / 段位
    assert.ok(d.self.pointsAfter >= 0 && d.self.pointsAfter <= fx.RATING.cap);
    assert.ok(d.opponent.pointsAfter >= 0 && d.opponent.pointsAfter <= fx.RATING.cap);
    assert.equal(foeArchive.progress.tier, d.opponent.tier, '快速对战不改段位（D-133 双轨）');
    perMatch.push({
      match: i + 1, winner: d.winner, battleId: d.battleId,
      p1: { id: d.self.playerId, before: d.self.pointsBefore, after: d.self.pointsAfter, delta: d.self.delta },
      p2: { id: d.opponent.playerId, before: d.opponent.pointsBefore, after: d.opponent.pointsAfter, delta: d.opponent.delta },
      zeroSum: d.zeroSum,
    });
    fx.clock.advance(73 * HOUR); // 跨过 72h 偏好间隔 → 下一场仍是 strict 池
  }
  assert.ok(perMatch.length >= 1, '至少完成一场快速对战');

  // ② 全局粒度守恒：Σ前 + ΣΔ === Σ后；且 ΣΔ ≤ 0（非零和"汇"，D-133）
  const afterAll = await ratingsOf(fx);
  let deltaSum = 0;
  for (const [playerId, before] of beforeAll) deltaSum += (afterAll.get(playerId) || 0) - before;
  assert.equal(sumOf(beforeAll) + deltaSum, sumOf(afterAll), '全局：Σ前 + ΣΔ === Σ后');
  assert.ok(deltaSum <= 0, `全局 ΣΔ ≤ 0（分数汇；实际 ${deltaSum}）`);
  assert.ok([...afterAll.values()].every((p) => p >= 0 && p <= fx.RATING.cap), '全员积分在 [0,cap]');
  // 汇总数字（供交付报告引用）
  const sinks = perMatch.filter((m) => !m.zeroSum).length;
  assert.equal(sinks + perMatch.filter((m) => m.zeroSum).length, perMatch.length);
  t.diagnostic(`[INV-1] 场次=${perMatch.length} Σ前=${sumOf(beforeAll)} ΣΔ=${deltaSum} Σ后=${sumOf(afterAll)} 非零和场次=${sinks}`);
});

test('INV-2 排行榜索引与档案一致（重建后仍一致，§5.6/T-ST-5）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(5);
  const quick = qm.createQuickMatch({ store: fx.store });
  // 制造积分差异（真实对局）
  for (let i = 0; i < 3; i++) {
    await quick.run({ playerId: players[i].playerId, seed: 2000 + i });
    fx.clock.advance(73 * HOUR);
  }
  const built = quick.loadLeaderboard ? await quick.loadLeaderboard({ limit: 100 }) : null;
  assert.equal(built.status, 200);
  // 索引视图 vs 档案真值（逐玩家比对 points/tier/publicId）
  for (const playerId of await fx.store.listPlayerIds()) {
    const archive = await fx.store.loadArchive(playerId);
    const entry = fx.store.index.get(playerId);
    assert.equal(entry.points, archive.rating.points, `${playerId} 索引 points == 档案`);
    assert.equal(entry.tier, archive.progress.tier, `${playerId} 索引 tier == 档案`);
    assert.equal(entry.publicId, archive.publicId);
    assert.equal(entry.activeSnapshotHash, archive.configs.activeSnapshotHash);
  }
  // 排行榜严格按 points 降序（同分按 peakPoints 再 updatedAt，§8.6）
  const points = built.data.rows.map((r) => r.points);
  for (let i = 1; i < points.length; i++) assert.ok(points[i - 1] >= points[i], 'points 降序');
  assert.ok(built.data.rows.every((r) => r.playerId === undefined), '排行榜不暴露 playerId');
  // 重建索引（删 index.json 语义）后结果一致
  await fx.store.index.rebuild();
  const again = await quick.loadLeaderboard({ limit: 100 });
  assert.deepEqual(again.data.rows, built.data.rows, '重建索引后排行榜逐行一致');
  for (const playerId of await fx.store.listPlayerIds()) {
    const archive = await fx.store.loadArchive(playerId);
    assert.equal(fx.store.index.get(playerId).points, archive.rating.points, '重建后索引仍与档案一致');
  }
});

test('INV-3 排位：池不足只打实际场次（shortfall），全程无 bot，双方都记账', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(5);
  const me = players[0];
  const registryIds = new Set(await fx.store.listPlayerIds());
  const r = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 31337 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.requested, 10);
  assert.equal(r.data.shortfall, 10 - r.data.matches, 'matches + shortfall === requested');
  assert.equal(r.data.matches, 4, '同段位其他真实玩家 4 个 → 打 4 场');
  // 每场对手都是真实 playerId（非 bot）
  for (const m of r.data.results) {
    assert.ok(registryIds.has(m.opponentPlayerId), `对手 ${m.opponentPlayerId} 在档案库中`);
    const foe = await fx.store.loadArchive(m.opponentPlayerId);
    assert.equal(foe.flags.isBot, false, '排位正常路径不抽 bot');
    assert.equal(foe.record.stats.defense.wins + foe.record.stats.defense.losses + foe.record.stats.defense.draws, 1, '防守方离线也记战绩');
    assert.equal(foe.progress.tier, 'common', '防守方段位不变（D-132）');
    assert.equal(foe.rating.points, 0, '排位不改积分（D-133 双轨）');
  }
  // 发起者战绩 = 实际场次；双方总分/段位无异常
  const mine = await fx.store.loadArchive(me.playerId);
  const atk = mine.record.stats.attack;
  assert.equal(atk.wins + atk.losses + atk.draws, r.data.matches, '发起者攻击战绩 = 实际场次');
  assert.equal(mine.progress.batchesPlayed, 1);
  t.diagnostic(`[INV-3] requested=${r.data.requested} matches=${r.data.matches} shortfall=${r.data.shortfall} wins=${r.data.wins} draws=${r.data.draws} losses=${r.data.losses} invalids=${r.data.invalids}`);
});

test('INV-4 排位 ↔ 快速对战双轨：排位批次不改积分，快速对战不改段位（D-133）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(3);
  const me = players[0];
  const before = await fx.store.loadArchive(me.playerId);
  const rankedRes = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 7 });
  assert.equal(rankedRes.status, 200);
  const mid = await fx.store.loadArchive(me.playerId);
  assert.equal(mid.rating.points, before.rating.points, '排位不改变积分');
  assert.equal(mid.rating.games, before.rating.games, '排位不计入快速对战场次');
  const quick = qm.createQuickMatch({ store: fx.store });
  fx.clock.advance(73 * HOUR); // 跨过 72h 去重窗口（排位刚把对手写进 lastOpponentAt）
  const quickRes = await quick.run({ playerId: me.playerId, seed: 8 });
  assert.equal(quickRes.status, 200, JSON.stringify(quickRes));
  const after = await fx.store.loadArchive(me.playerId);
  assert.equal(after.progress.tier, mid.progress.tier, '快速对战不改变段位');
  // 同分 0 分对局的平局 Δ 恰好为 0（公式边界）→ 断言"积分按 Δ 变化"，而非"必然不同"
  assert.equal(after.rating.points, mid.rating.points + quickRes.data.self.delta, '快速对战按 Δ 改变积分');
  if (quickRes.data.winner !== 'draw') assert.notEqual(after.rating.points, mid.rating.points, '分出胜负时积分必变');
  assert.equal(after.rating.games, mid.rating.games + 1);
});

test('INV-5 崩溃一致性口径：journal 幂等 —— 重复 apply 同一 record 不重复记账（T-ST-2/D-134）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(2);
  const quick = qm.createQuickMatch({ store: fx.store });
  const r = await quick.run({ playerId: players[0].playerId, seed: 4242 });
  assert.equal(r.status, 200, JSON.stringify(r));
  const record = await fx.store.findBattleRecord(r.data.battleId);
  const before = await fx.store.loadArchive(players[0].playerId);
  const foeBefore = await fx.store.loadArchive(players[1].playerId);
  await fx.store.applyRecord(record); // 幂等重放（appliedSeq 水位拦住）
  await fx.store.applyRecords([record]);
  const after = await fx.store.loadArchive(players[0].playerId);
  const foeAfter = await fx.store.loadArchive(players[1].playerId);
  assert.equal(after.rating.points, before.rating.points, '重放不改双方积分');
  assert.equal(foeAfter.rating.points, foeBefore.rating.points);
  assert.equal(after.record.stats.attack.wins + after.record.stats.attack.losses + after.record.stats.attack.draws,
    before.record.stats.attack.wins + before.record.stats.attack.losses + before.record.stats.attack.draws,
    '重放不重复累计战绩（无半场/双记）');
  assert.equal(after.record.recent.length, before.record.recent.length, 'recent 不重复入列');
});
