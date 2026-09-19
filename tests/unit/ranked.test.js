'use strict';
/* tests/unit/ranked.test.js —— P7-3 排位改造（档案驱动）测试
 * 权威：docs/systems/10-ranked.md §4.3/§4.4 + docs/systems/11-account-store.md §7 + D-122/D-132/D-133/D-136
 *      + docs/plan-p7-playable.md §P7-3（🚫 禁止注入占位 bot 充数，池不足回报 `shortfall`）。
 *
 * 本文件改写自 P5 版本：**删除**"无池 → bot 补齐 10 场""池 3 → 补 7 bot"这类保护占位 bot 的断言，
 * 改为断言 (a) `pool:[]` → `shortfall` 且 `matches < 10`；(b) 每场对局的双方 playerId 都能在注册表/档案库中找到
 * （真实玩家）；(c) 保留 `loss`/`win`/`draw` 分支断言（改用真实构造的对手档案）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ranked = require('../../server/ranked.js');
const archiveMod = require('../../server/store/archive.js');
const h = require('../helpers/ranked.js');
const LD = require('../fixtures/loadout-ok.json');
const ld = () => JSON.parse(JSON.stringify(LD.loadout));

/* ---------- 断言工具：真实玩家校验 ---------- */

// 每个对局对手都必须能追溯到注册表（或档案库）里的真实 playerId
function assertOpponentsAreRealPlayers(results, lookup) {
  assert.ok(results.length > 0, '至少有一场对局');
  for (const m of results) {
    assert.ok(m.opponentPlayerId, `match ${m.match} 缺少 opponentPlayerId（无法追溯到真实玩家）`);
    assert.ok(archiveMod.PLAYER_ID_RE.test(m.opponentPlayerId), `match ${m.match} 的 opponentPlayerId 不是合法 playerId：${m.opponentPlayerId}`);
    assert.ok(lookup.has(m.opponentPlayerId), `match ${m.match} 的对手 ${m.opponentPlayerId} 不在注册表/档案库中`);
  }
}

function withStoreLookup(registry, store) {
  const lookup = new Set(registry.keys());
  lookup.has = (playerId) => registry.has(playerId) || store.index.has(playerId);
  return lookup;
}

/* ---------- (a) 池不足 → shortfall，不再 bot 补齐 ---------- */

test('T-RK-1a 池空（pool:[]，无 store）→ 一场不打：matches=0、shortfall=requested', () => {
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool: [], seed: 11, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.equal(r.data.requested, ranked.DEFAULT_BATCH_SIZE);
  assert.equal(r.data.matches, 0, '无真实对手 → 一场都不打（禁止 bot 补齐）');
  assert.equal(r.data.results.length, 0);
  assert.equal(r.data.shortfall, ranked.DEFAULT_BATCH_SIZE, '缺口如实回报');
  assert.equal(r.data.wins + r.data.draws + r.data.losses + r.data.invalids, 0);
});

test('T-RK-1b 池不足（3 个真实档案 / 请求 10）→ 只打 3 场，shortfall=7（不补 bot）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const me = await fx.registerPlayer({ nickname: '我' });
  const foes = await fx.registerPlayers(3);
  const pool = [];
  for (const f of foes) {
    const ldOfFoe = await fx.loadoutOf(f.playerId);
    ldOfFoe.playerId = f.playerId; // 真实档案快照自带 playerId 溯源
    pool.push(ldOfFoe);
  }
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool, seed: 11, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.equal(r.data.requested, 10);
  assert.equal(r.data.matches, 3, '只打池里真实存在的 3 场');
  assert.equal(r.data.shortfall, 7);
  assert.equal(r.data.results.length, 3);
  assert.equal(r.data.wins + r.data.draws + r.data.losses + r.data.invalids, 3, '四项闭合于实际场次');
  const lookup = new Set(foes.map((f) => f.playerId));
  assertOpponentsAreRealPlayers(r.data.results, lookup);
  assert.equal(new Set(r.data.results.map((m) => m.opponentPlayerId)).size, 3, '批次内不重复抽同一对手');
  void me;
});

test('T-RK-1c 池充足（12 个真实档案）→ 打满 10 场、shortfall=0、批次内不重复', () => {
  const pool = Array.from({ length: 12 }, (_, i) => {
    const x = h.waitOnly(ld(), `w${i}`);
    x.playerId = h.makePlayerId(i + 100);
    return x;
  });
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool, seed: 7, tier: 'mythic' });
  assert.equal(r.data.requested, 10);
  assert.equal(r.data.matches, 10);
  assert.equal(r.data.shortfall, 0);
  assert.equal(r.data.invalids, 0, '全部为结构完整的真实档案快照');
  assert.equal(new Set(r.data.results.map((m) => m.opponentPlayerId)).size, 10, '批次内对手不重复');
  assert.equal(r.data.results.length, 10);
});

test('T-RK-1d 池含自己（JSON 深等 + playerId）→ 排除自己后如实计入缺口', () => {
  const mine = ld();
  mine.playerId = h.makePlayerId(1);
  const pool = [ld(), h.waitOnly(ld(), 'a'), h.waitOnly(ld(), 'b')];
  pool[0].playerId = h.makePlayerId(2); // 内容与自己相同（另一账号的同款配置）→ 内容去重
  pool[1].playerId = h.makePlayerId(3);
  pool[2].playerId = h.makePlayerId(4);
  const r = ranked.runRankedBattle({ loadout: mine, playerId: mine.playerId, warehouse: LD.warehouse, pool, seed: 3, tier: 'mythic' });
  assert.equal(r.data.matches, 2, '与自己内容相同的池条目被排除 → 只剩 2 场');
  assert.equal(r.data.shortfall, 8);
  assert.deepEqual(r.data.results.map((m) => m.opponentPlayerId).sort(), [h.makePlayerId(3), h.makePlayerId(4)], '抽中的都不是自己');
});

/* ---------- (b) 档案驱动：池只来自注册表，双方都能在档案库找到 ---------- */

test('T-RK-1e 档案驱动（store 模式）：池来自 byTier 注册表；每场对手都是注册真实玩家', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(8, { nickname: '真人' });
  const me = players[0];
  const r = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 20260916 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.tier, 'common', '段位取自服务端档案');
  assert.equal(r.data.requested, 10);
  assert.equal(r.data.matches, 7, '同段位其他真实玩家 7 个 → 只打 7 场');
  assert.equal(r.data.shortfall, 3);
  assert.equal(r.data.results.length, 7);
  const lookup = withStoreLookup(fx.registry, fx.store);
  assertOpponentsAreRealPlayers(r.data.results, lookup);
  assert.ok(!r.data.results.some((m) => m.opponentPlayerId === me.playerId), '不会抽到自己');
  // 双方档案均落盘：发起者 attacker 战绩 + 被抽方 defender 战绩（离线只记战绩）
  const mine = await fx.store.loadArchive(me.playerId);
  assert.equal(mine.record.stats.attack.wins + mine.record.stats.attack.losses + mine.record.stats.attack.draws, 7, '发起者 7 场攻击战绩落盘');
  assert.equal(mine.progress.batchesPlayed, 1, 'ranked.batch 记录已落盘');
  const foeId = r.data.results[0].opponentPlayerId;
  const foe = await fx.store.loadArchive(foeId);
  assert.equal(foe.record.stats.defense.wins + foe.record.stats.defense.losses + foe.record.stats.defense.draws, 1, '防守方离线仍产生防守战绩（D-132）');
  assert.equal(foe.pool.drawnCount, 1);
  assert.equal(foe.record.unread.defense, 1);
  assert.equal(foe.progress.tier, 'common', '防守方段位不变');
  assert.equal(foe.rating.points, 0, '排位不改积分（D-133 双轨）');
});

test('T-RK-1f 档案驱动：禁止客户端自选对手（传 pool → pool_forbidden）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const me = await fx.registerPlayer();
  const r = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, pool: [ld()], seed: 5 });
  assert.equal(r.status, 400);
  assert.equal(r.code, 'pool_forbidden');
});

test('T-RK-1g 档案驱动：无同段位候选（真·空池）→ shortfall=10 且一场不打（不注入 bot）', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const me = await fx.registerPlayer({ nickname: '我' });
  await fx.registerPlayers(2, { tier: 'rare' }); // 另两人在别的段位 → common 池只剩自己
  const r = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 1 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.matches, 0, '同段位真实候选为空 → 一场不打');
  assert.equal(r.data.shortfall, 10);
  assert.deepEqual(r.data.results, []);
  const mine = await fx.store.loadArchive(me.playerId);
  assert.equal(mine.record.stats.attack.wins, 0, '没有任何伪造对局写入战绩');
  assert.equal(mine.record.recent.length, 0);
});

test('T-RK-1h 档案驱动：某候选快照缺失 → 跳过（不占场次）、告警、真实对手仍然全部可追溯', async (t) => {
  const fx = await h.openFixture({ logger: h.makeLogger() });
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(3);
  const me = players[0];
  // 让 1 号对手的 activeSnapshotHash 指向**不存在**的快照（真实注册表里"快照缺失"的候选）
  const victim = players[1];
  const missingHash = `sha256:${'f'.repeat(64)}`;
  await fx.store.updateArchive(victim.playerId, (a) => {
    a.configs.slots[0].snapshot.hash = missingHash;
    a.configs.activeSnapshotHash = missingHash;
    return null;
  });
  await fx.store.index.rebuild(); // 直改档案后刷新派生索引（index.json 是派生物，§5.6）
  const r = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 2 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.matches, 1, '2 名对手中 1 个快照缺失 → 只打 1 场');
  assert.equal(r.data.shortfall, 9, '缺失候选不计入已打场次，如实进缺口');
  assertOpponentsAreRealPlayers(r.data.results, withStoreLookup(fx.registry, fx.store));
  assert.ok(!r.data.results.some((m) => m.opponentPlayerId === victim.playerId), '快照缺失者未被抽中对战');
  assert.ok(fx.events().includes('store.snapshot.missing'), '记 store.snapshot.missing(warn) 告警');
});

/* ---------- 去重窗口（D-136） ---------- */

test('T-RK-4a 去重窗口：24h 内被排除；>72h 可用；候选不足时放宽到 72h 并标 relaxed', async (t) => {
  const now = Date.now();
  const hour = 3600 * 1000;
  // 以**同一时间基准**构造三种对手：fresh=1h 前（两窗口都排除）/ mid=25h 前（仅放宽窗口可用）/ stale=80h 前（两窗口都可）
  async function fixtureWith(gaps) {
    const fx = await h.openFixture({ startAt: now });
    const players = await fx.registerPlayers(4);
    const me = players[0];
    const foes = players.slice(1);
    await fx.store.updateArchive(me.playerId, (ar) => {
      foes.forEach((p, i) => { ar.pool.lastOpponentAt[p.playerId] = now - gaps[i] * hour; });
      return null;
    });
    return { fx, me, foes };
  }

  // (1) 24h 内的 fresh 被排除；>24h 的 mid/stale 可用；严格窗口凑不满 10 场 → 实际启用放宽窗口
  const one = await fixtureWith([1, 25, 80]);
  t.after(() => one.fx.cleanup());
  const r1 = await ranked.runRankedBattle({ store: one.fx.store, playerId: one.me.playerId, seed: 9 });
  assert.equal(r1.status, 200, JSON.stringify(r1));
  assert.equal(r1.data.matches, 2, '24h 内已战对手被排除，只打 mid + stale 两场');
  assert.equal(r1.data.relaxed, true, '严格窗口凑不满 → 实际启用 72h 放宽窗口（本轮无"仅放宽可用"之外的额外对手）');
  assert.ok(!r1.data.results.some((m) => m.opponentPlayerId === one.foes[0].playerId), 'fresh（1h 前）两窗口都排除');
  assert.deepEqual(r1.data.results.map((m) => m.opponentPlayerId).sort(), [one.foes[1].playerId, one.foes[2].playerId].sort(), '抽中的是 mid + stale');

  // (2) 严格窗口为空、放宽窗口有候选：1h 内的两窗口都排除，25h 前的仅放宽窗口可用 → relaxed=true
  const two = await fixtureWith([1, 25, 1]);
  t.after(() => two.fx.cleanup());
  const r2 = await ranked.runRankedBattle({ store: two.fx.store, playerId: two.me.playerId, seed: 10 });
  assert.equal(r2.status, 200, JSON.stringify(r2));
  assert.equal(r2.data.relaxed, true, '严格窗口为空 → 放宽到 72h 并标注 relaxed');
  assert.equal(r2.data.matches, 1, '放宽后仅 24h~72h 之间的对手可用（1h 内的仍被排除）');
  assert.equal(r2.data.results[0].opponentPlayerId, two.foes[1].playerId, '被放宽选中的是 25h 前那个对手');
});

test('T-RK-4b 去重窗口：全部候选都在 72h 内 → 一场不打（shortfall 如实回报，不放宽到"无限制"）', async (t) => {
  const now = Date.now();
  const fx = await h.openFixture({ startAt: now });
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(3);
  const me = players[0];
  await fx.store.updateArchive(me.playerId, (ar) => {
    for (const p of players.slice(1)) ar.pool.lastOpponentAt[p.playerId] = now - 1 * 3600 * 1000;
    return null;
  });
  const r = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 11 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.matches, 0, '72h 去重窗口内一律不重复（放宽也只到 72h）');
  assert.equal(r.data.shortfall, 10, '缺口如实回报，不用 bot 补齐');
  assert.equal(r.data.relaxed, false, '无候选可放宽 → relaxed 不置位');
  // 超过 72h：去重窗口完全失效
  fx.clock.advance(73 * 3600 * 1000);
  const r2 = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 12 });
  assert.equal(r2.data.matches, 2, '超窗后对手重新可用');
  assert.equal(r2.data.relaxed, false, '超窗后回到严格 24h 窗口（已无人被去重）');
});

/* ---------- 胜负分支（真实构造的对手档案） ---------- */

test('平局不计胜：wait-only 双方真实档案 10 场全平 → wins 0、draws 10、不晋升', () => {
  const mine = h.waitOnly(ld(), 'me');
  const pool = Array.from({ length: 10 }, (_, i) => h.waitOnly(ld(), `b${i}`));
  pool.forEach((x, i) => { x.playerId = h.makePlayerId(i + 200); });
  const r = ranked.runRankedBattle({ loadout: mine, warehouse: LD.warehouse, pool, seed: 5, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.equal(r.data.wins + r.data.draws + r.data.losses, 10);
  assert.ok(r.data.results.every((m) => m.winner === 'draw'), '全平局（wait-only 双方无敌对伤害）');
  assert.equal(r.data.promoted, false, '平局不计胜、不晋升');
});

test('输场分支：脆弱我方（hp=1/atk=0）对真实对手档案 → 真输场（losses>0）', () => {
  const weak = h.fragile(ld(), 'weak');
  const pool = Array.from({ length: 3 }, (_, i) => {
    const x = h.waitOnly(ld(), `c${i}`);
    x.playerId = h.makePlayerId(i + 300);
    return x;
  });
  const r = ranked.runRankedBattle({ loadout: weak, warehouse: LD.warehouse, pool, seed: 99, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.ok(r.data.losses > 0, `脆弱我方应有真输场（实际 losses=${r.data.losses}）`);
  assert.equal(r.data.wins + r.data.draws + r.data.losses + r.data.invalids, 3, '四项闭合于实际场次');
});

test('胜场分支 + 晋升判定：真实弱对手档案（atk=0/hp=1）→ 我方全胜 → 满场批次晋升', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const players = await fx.registerPlayers(11);
  const me = players[0];
  // 其余 10 人换成"脆弱"快照（真实档案 + 真实冻结快照，不入 bot 逻辑）
  for (const p of players.slice(1)) {
    await fx.store.saveConfigSlot({
      playerId: p.playerId, slotId: 'slot1', loadout: h.fragile(await fx.loadoutOf(p.playerId)),
      versions: fx.VERSIONS,
    });
  }
  const r = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 42 });
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.data.matches, 10);
  assert.equal(r.data.shortfall, 0);
  assert.equal(r.data.wins, 10, '对手全为脆弱档案 → 我方 10 胜');
  assert.equal(r.data.promoted, true, 'wins=10 > 6 → 晋升（D-122）');
  assert.equal(r.data.tierAfter, 'rare');
  assert.equal(r.data.reward, 'rare');
  const mine = await fx.store.loadArchive(me.playerId);
  assert.equal(mine.progress.tier, 'rare', '段位已落盘');
  assert.equal(mine.progress.batchesPromoted, 1);
  assertOpponentsAreRealPlayers(r.data.results, withStoreLookup(fx.registry, fx.store));
});

/* ---------- 单场隔离 / 参数分支 ---------- */

test('P2-4 invalid 单独计数：池含坏条目（技能 2 个）→ invalids ≥1 且不再计 loss', () => {
  const bad = h.mutateLoadout(ld(), (x) => { x.skills = x.skills.slice(0, 2); }, 'bad');
  bad.playerId = h.makePlayerId(400);
  const pool = [bad, h.waitOnly(ld(), 'ok1'), h.waitOnly(ld(), 'ok2')];
  pool[1].playerId = h.makePlayerId(401);
  pool[2].playerId = h.makePlayerId(402);
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool, seed: 13, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.ok(r.data.invalids >= 1, `坏池条目单独计数（实际 ${r.data.invalids}）`);
  assert.equal(r.data.wins + r.data.draws + r.data.losses + r.data.invalids, 3, '四项闭合');
});

test('确定性：同 seed + 同池 → 同结果序列（逐场 winner/ticks 一致）', () => {
  const pool = Array.from({ length: 10 }, (_, i) => {
    const x = h.waitOnly(ld(), `d${i}`);
    x.playerId = h.makePlayerId(i + 500);
    return x;
  });
  const opt = { loadout: ld(), warehouse: LD.warehouse, pool, seed: 20260913, tier: 'mythic' };
  const r1 = ranked.runRankedBattle(opt);
  const r2 = ranked.runRankedBattle(opt);
  assert.deepEqual(r2.data.results, r1.data.results, '同 seed 结果序列逐场一致');
  assert.equal(r2.data.wins, r1.data.wins);
});

test('409/400 参数：无 loadout → no_loadout；非法 loadout → loadout_invalid；坏 seed → bad_seed；坏 pool → bad_pool', () => {
  assert.equal(ranked.runRankedBattle({}).status, 409);
  assert.equal(ranked.runRankedBattle({}).code, 'no_loadout');
  const bad = ld();
  bad.skills = bad.skills.slice(0, 2);
  const r2 = ranked.runRankedBattle({ loadout: bad, warehouse: LD.warehouse, tier: 'mythic' });
  assert.equal(r2.status, 409);
  assert.equal(r2.code, 'loadout_invalid');
  const r3 = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, seed: 'x' });
  assert.equal(r3.status, 400);
  assert.equal(r3.code, 'bad_seed');
  const r4 = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool: 'nope' });
  assert.equal(r4.status, 400);
  assert.equal(r4.code, 'bad_pool');
});

test('档案驱动参数错误：缺 playerId → bad_request；未知档案 → store_not_found；坏 seed → bad_seed', async (t) => {
  const fx = await h.openFixture();
  t.after(() => fx.cleanup());
  const noId = await ranked.runRankedBattle({ store: fx.store });
  assert.equal(noId.status, 400);
  assert.equal(noId.code, 'bad_request');
  const missing = await ranked.runRankedBattle({ store: fx.store, playerId: h.makePlayerId(999) });
  assert.equal(missing.status, 404);
  assert.equal(missing.code, 'store_not_found');
  const me = await fx.registerPlayer();
  const badSeed = await ranked.runRankedBattle({ store: fx.store, playerId: me.playerId, seed: 0 });
  assert.equal(badSeed.status, 400);
  assert.equal(badSeed.code, 'bad_seed');
});

/* ---------- 调试开关（默认关闭；不是"bot 补齐"） ---------- */

test('DL_DEBUG_BOTS 默认关闭：inspectDebugBots 只有显式 1/true 才启用', () => {
  assert.equal(ranked.inspectDebugBots({}).enabled, false);
  assert.equal(ranked.inspectDebugBots({ DL_DEBUG_BOTS: '0' }).enabled, false);
  assert.equal(ranked.inspectDebugBots({ DL_DEBUG_BOTS: 'yes' }).enabled, false);
  assert.equal(ranked.inspectDebugBots({ DL_DEBUG_BOTS: '1' }).enabled, true);
  assert.equal(ranked.inspectDebugBots({ DL_DEBUG_BOTS: 'true' }).enabled, true);
  assert.equal(ranked.inspectDebugBots(undefined).enabled, process.env.DL_DEBUG_BOTS === '1' || process.env.DL_DEBUG_BOTS === 'true');
});

test('无 BOT_LD 导出（占位 bot 补齐逻辑已删除）；buildDefaultLoadout 仍为"新玩家默认配置"构造器', () => {
  assert.equal(ranked.BOT_LD, undefined, 'BOT_LD 必须不存在（P7-3 硬约束）');
  const def = ranked.buildDefaultLoadout();
  assert.equal(def.skills.length, 3, '默认配置 3 技能满槽');
  const b = require('../../server/battle.js').buildPlayer('p1', def, null, 'common');
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  assert.equal(typeof ranked.buildBotLoadout, 'function', '命名兼容（account/play 复用同一构造器）');
  assert.deepEqual(ranked.buildBotLoadout(), def);
});

/* ---------- 快照与段位奖励（沿用 P5 断言） ---------- */

test('T-RK-5 快照不可变：takeSnapshot 深冻结且与原 loadout 深度相等', () => {
  const src = ld();
  const snap = ranked.takeSnapshot(src);
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.role) && Object.isFrozen(snap.skills[0]), '快照深冻结');
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), src, '快照内容与源深度相等');
  assert.throws(() => { snap.role.uid = 'mutated'; }, TypeError, '冻结态写入抛错');
});

test('T-RK-4b 段位→品质上限 tierReward（RK-5a..e 逐档；非法段位 null）', () => {
  assert.equal(ranked.tierReward('common'), 'common', 'RK-5a');
  assert.equal(ranked.tierReward('rare'), 'rare', 'RK-5b');
  assert.equal(ranked.tierReward('epic'), 'epic', 'RK-5c');
  assert.equal(ranked.tierReward('legendary'), 'legendary', 'RK-5d');
  assert.equal(ranked.tierReward('mythic'), 'mythic', 'RK-5e');
  assert.equal(ranked.tierReward('platinum'), null, '非法段位');
});

test('T-RK-2 晋升阈值 x=6：wins=6 不晋升；7 晋升；连续段位递增；顶段 409 already_max', () => {
  const r6 = ranked.promote('common', 6);
  assert.equal(r6.status, 200);
  assert.deepEqual(r6.data, { tier: 'common', promoted: false, reward: 'common', wins: 6 }, 'wins=6 不晋升');
  const r7 = ranked.promote('common', 7);
  assert.equal(r7.status, 200);
  assert.deepEqual(r7.data, { tier: 'rare', promoted: true, reward: 'rare', wins: 7 }, 'wins=7 晋升 + 奖励品质=新段位');
  const r8 = ranked.promote('rare', 8);
  assert.equal(r8.data.tier, 'epic');
  const rM = ranked.promote('mythic', 7);
  assert.equal(rM.status, 409);
  assert.equal(rM.code, 'already_max', '最高段位不再晋升');
});

test('promote 参数错误：bad_tier / bad_wins（非整数/负数/缺省/超上限）', () => {
  assert.equal(ranked.promote('platinum', 7).code, 'bad_tier');
  assert.equal(ranked.promote(undefined, 7).code, 'bad_tier');
  assert.equal(ranked.promote('common', 'x').code, 'bad_wins');
  assert.equal(ranked.promote('common', -1).code, 'bad_wins');
  assert.equal(ranked.promote('common', 1.5).code, 'bad_wins');
  assert.equal(ranked.promote('common', undefined).code, 'bad_wins');
  assert.equal(ranked.promote('common', 11).code, 'bad_wins', 'P2-2：wins ≤ 10 上限');
});

test('P2-1：promotedAt 顶段不判定晋升（与 /ranked/run 口径同源分离）', () => {
  assert.equal(ranked.promotedAt('mythic', 7), false, '顶段 wins=7 不判定晋升');
  assert.equal(ranked.promotedAt('legendary', 7), true, '次顶段 wins=7 判定晋升');
  assert.equal(ranked.promotedAt('common', 6), false, 'wins=6 不达阈值');
  assert.equal(ranked.promote('mythic', 7).status, 409, 'promote 顶段仍 409 already_max');
});

test('P2-3：tierReward 与开箱品质上限交叉一致（门控开启 = 回退模式；B17 同源 D-122；逐档 5000 样本 max 品质）', () => {
  const items = require('../../server/core/items.js').withGating(true);
  const { createRng } = require('../../server/core/rng.js');
  for (const t of ranked.TIERS) {
    const rng = createRng(20260913 + ranked.TIERS.indexOf(t));
    let maxQ = null;
    for (let i = 0; i < 5000; i++) {
      const q = items.rollQuality(rng, t);
      if (maxQ === null || ranked.TIERS.indexOf(q) > ranked.TIERS.indexOf(maxQ)) maxQ = q;
    }
    assert.equal(maxQ, ranked.tierReward(t), `${t} 段位开箱上限 == tierReward（交叉绑定）`);
  }
});

test('P2-3b：门控关闭（默认）时开箱品质不受段位限制，tierReward 仍按段位返回奖励品质', () => {
  const items = require('../../server/core/items.js');
  const { createRng } = require('../../server/core/rng.js');
  const rng = createRng(20260913);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(items.rollQuality(rng, 'common'));
  assert.ok(seen.has('mythic'), `common 段位也能开出 mythic（实际 ${[...seen].join('/')}）`);
  assert.equal(ranked.tierReward('common'), 'common', '奖励映射与门控无关：common → common');
  assert.equal(ranked.tierReward('mythic'), 'mythic');
});
