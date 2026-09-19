'use strict';
/* tests/integration/load-integrity.test.js —— P7-6 批量测试的**小规模固化**（完整性断言 ①③④⑤⑥⑦）
 *
 * 权威：docs/plan-p7-playable.md §P7-6（批量注册真实玩家 → 配齐出战配置 → 先建池后匹配 → 完整性断言）；
 *      docs/systems/11-account-store.md §6.1/§6.3（journal 幂等）/§7（异步排位）/§8（快速对战与积分守恒）；
 *      decisions.md D-132/D-133/D-134/D-136/D-152。
 *
 * 规模：`--players 12` 等价（并发 6、快速 scrypt N=1024）→ 时长控制在 1~3 s，可纳入 `npm test`。
 * 断言：
 *   ① journal 幂等（重复 apply 不重复记账）
 *   ③ 积分守恒（对局粒度 + 全局粒度；D-133 非零和"汇"）
 *   ④ leaderboard 与档案一致（重建索引后一致）
 *   ⑤ 回放 LRU 不越界
 *   ⑥ 每场对局双方均为真实注册玩家（无 bot 补位；可从未删档案追溯）
 *   ⑦ 无 5xx
 * 另有"流程完整度"断言：N 个玩家全部注册成功 → 全部配齐出战配置（开箱 / GET /me / 装配 / AI validate+compile /
 *   配置槽）→ 池就绪（档案 + 可用快照 ≥ N）→ 真打了对局（排位 + 快速）。
 *
 * 实现共用 `tests/helpers/load.js`（与 `scripts/load-test.js` 同一份引擎，避免第二套语义）；
 * 本文件**只做断言**，不复制批量流程，也不 mock store（走真实 HTTP + 真实 store）。
 */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const load = require('../helpers/load.js');
const serverMod = require('../../server/index.js');
const archiveMod = require('../../server/store/archive.js');
const astApi = require('../../server/ai/ast.js');

const PLAYERS = 12;   // 小规模：时长可控（生产规模用 `node scripts/load-test.js --players 200`）
const SEED = 424242;

// 单次共享运行：8 个断言共享同一份批量结果。**run() 自身绝不 assert、绝不抛出** ——
// 否则一个断言失败会污染其余用例（甚至读不到 storeHandle）。失败信息一律通过返回值断言。
let shared = null;
async function run() {
  if (shared) return shared;
  shared = await load.runLoadTest({
    players: PLAYERS,
    concurrency: 6,
    rankRuns: 1,
    quickRuns: 1,
    boxes: 20,
    seed: SEED,
    deep: true,          // 小规模：开启索引重建比对（断言 ④ 的"重建后一致"）
    fastAuth: true,      // N=1024；默认（生产）为 N=16384，见 scripts/load-test.js
    keepDataDir: true,   // 保留临时数据根与 store 句柄 → 供断言做独立复核；由 after() 清理
    level: 'error',
  });
  return shared;
}

function checkOf(report, id) {
  const hit = ((report.integrity && report.integrity.checks) || []).find((c) => c.id === id);
  assert.ok(hit, `缺少断言 ${id}（报告完整性检查未产出）`);
  return hit;
}

// 收尾：关闭共享的进程内服务 + 删除临时数据根（本文件的 8 个用例共用一次批量运行）
after(async () => {
  if (shared) await load.closeReport(shared);
  shared = null;
});

test('LOAD-0 批量流程完整度：N 个真实玩家全部注册 + 配齐出战配置 + 池就绪 + 真打对局（无 bot）', async (t) => {
  const report = await run();
  assert.equal(report.options.players, PLAYERS);
  assert.equal(report.options.scrypt.includes('N=1024'), true, '集成测试走快速 scrypt（生产默认 N=16384）');
  assert.equal(report.fatal, undefined, `致命错误：${JSON.stringify(report.fatal)}`);

  const reg = report.phases.register;
  assert.equal(reg.requested, PLAYERS);
  assert.equal(reg.ok, PLAYERS, `注册失败：${JSON.stringify(reg.failures)}`);

  const setup = report.phases.setup;
  assert.equal(setup.ok, PLAYERS, `配齐出战配置失败：${JSON.stringify(setup.failures)}`);
  assert.ok(setup.assemble, '报告缺少装配统计');
  // 装配走真实 HTTP（POST /warehouse/assemble）路径：逐条提交、服务端裁决
  assert.ok(setup.assemble.placed > 0, '至少应有若干装配成功（真实插件入槽）');
  assert.ok(report.metrics.statusDistribution['POST /api/v1/warehouse/assemble 200'] > 0, '装配请求必须走 HTTP 端点并成功');
  assert.ok(report.metrics.statusDistribution['POST /api/v1/ai/validate 200'] === PLAYERS, 'AI validate 全部 200');
  assert.ok(report.metrics.statusDistribution['POST /api/v1/ai/compile 200'] === PLAYERS, 'AI compile 全部 200');
  assert.ok(report.metrics.statusDistribution['PUT /api/v1/me/warehouse 200'] === PLAYERS, '仓库镜像全部提交成功');

  const pool = report.phases.pool;
  assert.equal(pool.registeredPlayers, PLAYERS);
  assert.equal(pool.archives, PLAYERS, '档案数 = 注册玩家数');
  assert.equal(pool.usableSnapshots, PLAYERS, '可用快照数 = 注册玩家数（先建池后匹配）');
  assert.equal(pool.isBotArchives, 0, '池内不得有 bot 档案（D-152）');

  const matches = report.phases.matches;
  assert.ok(matches.totalMatches > 0, '必须真的打成对局');
  assert.ok(matches.ranked.matches > 0, `排位批次必须成场（实际 ${matches.ranked.matches}）`);
  // 快速对战：对手去重窗口（D-136 的 24h 硬底线）使 N 个玩家一轮最多 ceil(N/2) 场成局（每场消耗 2 人）；
  // 后发起的玩家池子变小 → 允许 no_opponent（这是"池不足不打 bot"的设计口径，不是缺陷）。
  assert.ok(matches.quick.ok > 0, `快速对战必须成场（实际 ${matches.quick.ok}）`);
  assert.ok(matches.quick.ok <= Math.ceil(PLAYERS / 2),
    `快速成局数不得超过 ceil(N/2)=${Math.ceil(PLAYERS / 2)}（实际 ${matches.quick.ok}）`);
  // 延迟口径：P50 ≤ P95 ≤ max
  for (const [group, s] of Object.entries(report.metrics.latencyMs)) {
    if (s.count === 0) continue;
    assert.ok(s.p50 <= s.p95, `${group}: P50 ${s.p50} ≤ P95 ${s.p95}`);
    assert.ok(s.p95 <= s.max, `${group}: P95 ${s.p95} ≤ max ${s.max}`);
  }
  // 每人的 AI 程序内容互不相同（行为各不相同）
  assert.equal(report.distribution.aiPrograms.distinct, PLAYERS, 'AI 程序应两两不同');
  assert.equal(report.distribution.aiPrograms.equalToPlayers, true);
  t.diagnostic(`[LOAD-0] 注册=${reg.ok} 配齐=${setup.ok} 装配=${setup.assemble.placed}处 池=${pool.archives}/快照${pool.usableSnapshots} 对局=${matches.totalMatches}（排位 ${matches.ranked.matches} + 快速 ${matches.quick.ok}） 吞吐=${matches.throughputPerSecond}/s`);
});

test('LOAD-1 ①journal 幂等：重复 apply 不重复记账 / 不推水位', async (t) => {
  const report = await run();
  const check = checkOf(report, 'A1-journal-idempotent');
  assert.equal(check.ok, true, check.detail);

  // 独立复核：取 journal 里第一条 battle.recorded，重复 apply 两次 → 双方档案逐字段不变
  const store = report.storeHandle;
  let target = null;
  await store.replayJournal({ includeCheckpoints: false }, (r) => {
    if (!target && r.type === 'battle.recorded') target = r;
  });
  assert.ok(target, 'journal 中应有 battle.recorded');
  const snap = (a) => ({
    points: a.rating.points, games: a.rating.games, appliedSeq: a.record.appliedSeq,
    attack: a.record.stats.attack, defense: a.record.stats.defense, recent: a.record.recent.length,
    unread: a.record.unread,
  });
  const before1 = snap(await store.loadArchive(target.p1.playerId));
  const before2 = snap(await store.loadArchive(target.p2.playerId));
  const seqBefore = store.maxSeq();
  const r1 = await store.applyRecord(target);
  const r2 = await store.applyRecords([target]);
  assert.equal(r1.applied, 0, '重复 apply 必须 applied=0');
  assert.equal(r2.applied, 0, '批量重复 apply 必须 applied=0');
  assert.deepEqual(snap(await store.loadArchive(target.p1.playerId)), before1, 'p1 档案不因重放改变');
  assert.deepEqual(snap(await store.loadArchive(target.p2.playerId)), before2, 'p2 档案不因重放改变');
  assert.equal(store.maxSeq(), seqBefore, '重复 apply 不得推进 journal 水位');
  t.diagnostic(`[LOAD-1] battleId=${target.battleId} 重放 applied=0，水位 ${seqBefore} 不变`);
});

test('LOAD-2 ③积分守恒：逐场 + 全局恒等式 + journal 一致性 + Elo 可复算 + 幅度上界', async (t) => {
  const report = await run();
  const check = checkOf(report, 'A3-rating-conservation');
  assert.equal(check.ok, true, check.detail);
  const n = check.numbers;
  // (a) 逐场恒等式（核心）
  assert.equal(n.conservation, true, '全局恒等式必须成立');
  assert.equal(n.before + n.delta, n.after, 'Σ前 + ΣΔ = Σ后');
  // (b) journal ΣΔ === 档案 ΣΔ（缺陷 A 的回归护栏）
  assert.equal(n.journalConservation, true, 'journal 粒度 ΣΔ 必须等于档案粒度 ΣΔ（记账丢失回归护栏）');
  assert.equal(n.journalDelta, n.delta, 'journal ΣΔ === 档案 ΣΔ');
  // (c) Elo 逐侧可复算 + 幅度上界（用 rating-config 复算，不写字面量）
  assert.equal(n.eloFormulaBad, 0, '每侧 Δ 必须等于 ledger 公式值（快速）且排位不动积分');
  assert.ok(Math.abs(n.delta) <= n.magnitudeBound,
    `|ΣΔ| ${Math.abs(n.delta)} ≤ 场次 × kMax = ${n.magnitudeBound}`);
  // (d) 符号：只在"无 bot 参与且无 0 积分地板截断"时才主张"分数汇"（D-133 §8.4 bot 例外 +
  //     clamp(R+Δ,0,cap) 的 0 地板会把败者扣分截断 ⇒ 全 0 起点场景 ΣΔ 必为正）。
  //     两条件任一不满足时只断言恒等式 + 幅度上界，并**显式打印**实测符号与判据依据。
  assert.equal(n.botParticipants, 0, `本次运行不得有 bot/debug 账号参与（实际 ${n.botParticipants}）`);
  if (n.sinkRequired) {
    assert.ok(n.delta <= 0, `无 bot 参与且无 0 地板截断时 ΣΔ ≤ 0（分数汇；实际 ${n.delta}）`);
  }

  // 独立复核（不用 helper 的中间量）：流式读 journal 逐场复算，再与档案落盘值比
  const store = report.storeHandle;
  const archivePoints = new Map();
  for (const pid of store.index.playerIds()) {
    const a = await store.loadArchive(pid);
    archivePoints.set(pid, a.rating.points);
  }
  let perMatch = 0;
  let perMatchBad = 0;
  let sumDelta = 0;
  const seen = new Set();
  await store.replayJournal({ includeCheckpoints: false }, (r) => {
    if (r.type !== 'battle.recorded') return;
    assert.equal(seen.has(r.battleId), false, `journal 不得出现重复 battleId ${r.battleId}`);
    seen.add(r.battleId);
    perMatch += 1;
    for (const side of ['p1', 'p2']) {
      const s = r[side];
      assert.ok(Number.isInteger(s.pointsBefore) && Number.isInteger(s.pointsAfter), `${r.battleId}.${side} 积分字段完整`);
      sumDelta += s.pointsAfter - s.pointsBefore;
    }
    const before = r.p1.pointsBefore + r.p2.pointsBefore;
    const delta = (r.p1.pointsAfter - r.p1.pointsBefore) + (r.p2.pointsAfter - r.p2.pointsBefore);
    if (before + delta !== r.p1.pointsAfter + r.p2.pointsAfter) perMatchBad += 1;
  });
  assert.ok(perMatch > 0, '至少一场对局');
  assert.equal(perMatchBad, 0, '逐场恒等式必须成立');
  assert.equal(sumDelta, n.journalDelta, 'journal 复算 ΣΔ === 报告 journal ΣΔ');
  // 每个玩家档案的 points === 该玩家在 journal 中最后一条记录的处理后 points
  const lastPoints = new Map();
  await store.replayJournal({ includeCheckpoints: false }, (r) => {
    if (r.type !== 'battle.recorded') return;
    if (archivePoints.has(r.p1.playerId)) lastPoints.set(r.p1.playerId, r.p1.pointsAfter);
    if (archivePoints.has(r.p2.playerId)) lastPoints.set(r.p2.playerId, r.p2.pointsAfter);
  });
  for (const [pid, points] of archivePoints) {
    if (!lastPoints.has(pid)) continue;
    assert.equal(points, lastPoints.get(pid), `${pid} 档案 points === journal 末值`);
  }
  assert.ok(report.distribution.rating.p50 >= report.distribution.rating.min, 'P50 ≥ min');
  t.diagnostic(`[LOAD-2] 场次=${perMatch} Σ前=${n.before} ΣΔ=${n.delta} Σ后=${n.after} journalΣΔ=${n.journalDelta} `
    + `幅度上界=${n.magnitudeBound} bot参与=${n.botParticipants} 符号主张=${n.sinkRequired}->ΣΔ${n.sink ? '≤0' : '>0'} `
    + `非零和=${n.nonZeroSumMatches} 零和=${n.zeroSumMatches} 单侧|Δ|max=${n.singleSideMaxAbsDelta}`);
});

test('LOAD-3 ④leaderboard 与档案一致（重建索引后一致）+ 排序 + 不暴露 playerId', async (t) => {
  const report = await run();
  const check = checkOf(report, 'A4-leaderboard-consistent');
  assert.equal(check.ok, true, check.detail);
  assert.equal(check.numbers.sortedOk, true);
  assert.equal(check.numbers.rebuiltOk, true, '索引重建后排行榜应逐行一致');
  assert.equal(check.numbers.mismatch, 0);

  // 独立复核：排行榜 vs 档案真值 + 直接重建索引再比一次
  const store = report.storeHandle;
  const rows = store.index.leaderboard({ scope: 'global', limit: 100 });
  assert.ok(rows.length > 0);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i - 1].points >= rows[i].points, 'points 降序');
  for (const row of rows) {
    assert.equal(row.playerId, undefined, '排行榜不暴露 playerId');
    assert.equal(typeof row.publicId, 'string');
  }
  const beforeRebuild = rows.map((r) => `${r.publicId}:${r.points}:${r.tier}`).join('|');
  await store.index.rebuild();
  const after = store.index.leaderboard({ scope: 'global', limit: 100 }).map((r) => `${r.publicId}:${r.points}:${r.tier}`).join('|');
  assert.equal(after, beforeRebuild, '索引重建后逐行一致');
  t.diagnostic(`[LOAD-3] 排行榜 ${rows.length} 行，重建前后一致；段位分布 ${JSON.stringify(report.distribution.tiers)}`);
});

test('LOAD-4 ⑤回放 LRU 不越界（批量流程不产帧；配置上限 = service-config.replayCacheSize）', async (t) => {
  const report = await run();
  const check = checkOf(report, 'A5-replay-lru-bounded');
  assert.equal(check.ok, true, check.detail);
  const n = check.numbers;
  // 上限必须等于 service-config.json 的 replayCacheSize 且被 store/index 真正装配（配置接线）
  const svc = require('../../server/data/service-config.json');
  assert.equal(n.limit, svc.replayCacheSize, `replayCacheSize 取自 service-config.json（${svc.replayCacheSize}）`);
  assert.ok(Number.isInteger(n.limit) && n.limit > 0, `replayCacheSize 应为正整数（实际 ${n.limit}）`);
  // store 侧真值（非测试自算）
  assert.equal(report.storeHandle.config.replayCacheSize, n.limit, 'store.config.replayCacheSize === 运行期 LRU 上限');
  assert.equal(report.storeHandle.config.replayCacheSize, svc.replayCacheSize);
  // 本批量流程只跑 /ai/*、/ranked/run、/quick/run，**不调用 POST /battle** ⇒ 不产帧
  assert.equal(n.addedByThisRun, 0, '本批量流程不得新增回放帧（不调用 POST /battle）');
  const games = report.integrity.counts.battleRecords;
  assert.ok(games > 0, '批量流程必须真的打了对局');
  const check2 = checkOf(report, 'A2-no-half-battle');
  assert.equal(check2.numbers.battleRecords, games, '对局数与断言 ② 口径一致');
  assert.ok(n.size >= 0 && report.metrics.statusDistribution['POST /api/v1/battle 200'] === undefined,
    '批量流程不应出现 POST /battle');
  t.diagnostic(`[LOAD-4] 本次对局=${games} 场；本批量流程新增帧=${n.addedByThisRun}（必须 0，因不调 POST /battle）；`
    + `上限 replayCacheSize=${n.limit}（store.config=${report.storeHandle.config.replayCacheSize}）；`
    + `模块级 REPLAYS.size=${n.size}（含同进程其它用例，故不作实例口径）；已淘汰记忆集=${n.evictedRemembered}`);
});

test('LOAD-4b ⑤回放 LRU 语义（真实 eviction → 410 replay_expired / 未知 → 404；实例登记数 ≤ 上限）', async (t) => {
  // 独立小实例（replayLimit=3，随机端口，DL_DATA_DIR 隔离）——LRU 的语义核心必须在**有帧**时验证，
  // 不能依赖"批量流程天然 0 帧"这种恒真断言。
  const dataDir = load.makeTempDir();
  const limit = 3;
  const logger = require('../../shared/log.js').createLogger({ level: 'error' });
  const s = await serverMod.start({ logger, dataDir, port: 0, replayLimit: limit, versions: { engine: serverMod.VERSION } });
  try {
    assert.equal(s.runtime.replayLimit, limit, 'server/index.js 必须按 opts.replayLimit 装配 LRU 上限（0 = 无上限语义已废弃）');
    const defaultLoadout = require('../../server/ranked.js').buildDefaultLoadout();
    const registered = [];
    for (let i = 0; i < limit + 3; i += 1) {
      const r = await load.httpRequest(s.port, 'POST', '/api/v1/battle', {
        p1: defaultLoadout, p2: defaultLoadout, seed: 1000 + i, tier: 'common',
      });
      assert.equal(r.status, 200, `第 ${i + 1} 次 POST /battle 应 200（${JSON.stringify(r.body).slice(0, 120)}）`);
      registered.push(r.body.data.id);
    }
    // LRU 语义核心：登记 limit+3 帧后，**最早登记的帧必然已被淘汰** → 410 replay_expired（而非 404）
    const evicted = registered[0];
    const expired = await load.httpRequest(s.port, 'GET', `/api/v1/replay/${evicted}`, null, {});
    assert.equal(expired.status, 410, `${evicted} 应因 LRU 淘汰返回 410（实际 ${expired.status}）：LRU 上限未生效或淘汰记忆缺失`);
    assert.equal(expired.body.error.code, 'replay_expired');
    // 最后登记的帧仍应在缓存（同进程其它用例不会在本用例的两条请求之间插入 3 场以上帧）
    const fresh = await load.httpRequest(s.port, 'GET', `/api/v1/replay/${registered[registered.length - 1]}`, null, {});
    assert.equal(fresh.status, 200, `最新帧 ${registered[registered.length - 1]} 应可读取（实际 ${fresh.status}）`);
    // 从未登记过的 id → 404 unknown_replay（与"已淘汰 410"区分）
    const unknown = await load.httpRequest(s.port, 'GET', '/api/v1/replay/r999999', null, {});
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'unknown_replay');
    const evictedCount = s.runtime.evicted ? s.runtime.evicted.size : null;
    assert.ok(evictedCount === null || evictedCount >= 1, `已淘汰记忆集应至少 1 条（实际 ${evictedCount}）`);
    t.diagnostic(`[LOAD-4b] replayLimit=${limit}；登记 ${registered.length} 帧；最早帧 ${evicted} → 410 replay_expired；`
      + `最新帧 → 200；未登记 id → 404 unknown_replay；已淘汰记忆集=${evictedCount}`);
  } finally {
    await s.close();
    load.removeTempDir(dataDir);
  }
});

test('LOAD-5 ⑥每场对局双方均为真实注册玩家（无 bot 补位，可从未删档案追溯）', async (t) => {
  const report = await run();
  const check = checkOf(report, 'A6-no-bot-players');
  assert.equal(check.ok, true, check.detail);
  assert.equal(check.numbers.badEndpoints, 0);
  assert.equal(check.numbers.botArchives, 0);
  assert.equal(check.numbers.registryBotCount, 0);

  // 独立复核：逐条 journal 对局，双方 playerId 必须能在档案库找到、格式合法、flags.isBot=false
  const store = report.storeHandle;
  const ids = new Set(store.index.playerIds());
  assert.equal(ids.size, PLAYERS);
  let endpoints = 0;
  const archives = new Map();
  for (const pid of ids) archives.set(pid, await store.loadArchive(pid));
  await store.replayJournal({ includeCheckpoints: false }, (r) => {
    if (r.type !== 'battle.recorded') return;
    for (const side of ['p1', 'p2']) {
      const pid = r[side].playerId;
      endpoints += 1;
      assert.ok(archiveMod.PLAYER_ID_RE.test(pid), `playerId 格式合法：${pid}`);
      assert.ok(ids.has(pid), `对手 ${pid} 必须是注册玩家（无 bot 补位，D-152）`);
      const archive = archives.get(pid);
      assert.ok(archive, `${pid} 档案必须存在（可追溯）`);
      assert.equal(archive.flags.isBot, false, `${pid} 不得是 bot 档案`);
      assert.equal(archive.flags.banned, false);
    }
    assert.notEqual(r.p1.playerId, r.p2.playerId, '不得自己打自己');
    assert.ok(['quick', 'ranked'].includes(r.mode), `模式登记（实际 ${r.mode}）`);
  });
  assert.equal(endpoints, check.numbers.endpoints, '端数一致（报告 vs 独立复算）');
  assert.ok(endpoints >= 2, '至少一局两端的对局');
  t.diagnostic(`[LOAD-5] 对局 ${endpoints / 2} 场 / ${endpoints} 端全部为真实注册玩家，isBot 档案 0 个`);
});

test('LOAD-6 ⑦无 5xx + 状态码分布自洽', async (t) => {
  const report = await run();
  const check = checkOf(report, 'A7-no-5xx');
  assert.equal(check.ok, true, check.detail);
  const m = report.metrics;
  assert.equal(m.server5xx, 0, '不得出现任何 5xx');
  assert.equal(m.transportFailures, 0, '不得出现传输层失败');
  const dist = m.statusDistribution;
  for (const [key, count] of Object.entries(dist)) {
    const status = Number(key.slice(key.lastIndexOf(' ') + 1));
    assert.ok(status < 500, `状态码分布含 5xx：${key} × ${count}`);
    assert.ok(count > 0);
  }
  // 关键端点必须全部 200（注册 / 开箱 / AI / 仓库镜像 / 配置槽 / 排行榜）
  assert.equal(dist['POST /api/v1/auth/register 200'], PLAYERS);
  assert.ok(dist['POST /api/v1/box 200'] >= PLAYERS, '开箱至少每人一次');
  assert.ok(dist['POST /api/v1/box 200'] <= PLAYERS * 3, '开箱最多每人三次（掉落不足才补开）');
  assert.equal(dist['PUT /api/v1/me/configs/slot1 200'], PLAYERS);
  assert.equal(dist['POST /api/v1/ai/validate 200'], PLAYERS);
  assert.equal(dist['POST /api/v1/ai/compile 200'], PLAYERS);
  assert.equal(dist['PUT /api/v1/me/warehouse 200'], PLAYERS);
  assert.equal(dist['GET /api/v1/leaderboard 200'], 1, '排行榜读一次（断言 ④ 的 HTTP 复核）');
  assert.equal(m.errorCodes.loadout_invalid, undefined, '不得有 loadout_invalid（出战配置必须自洽可用）');
  t.diagnostic(`[LOAD-6] 请求 ${m.requests} 次，5xx=0，传输失败=0，错误率 ${m.errorRate}`);
});

test('LOAD-7 引擎与分布：AI 程序互不相同 + 账务闭合 + 每人快照可实例化', async (t) => {
  const report = await run();
  const dist = report.distribution;
  assert.equal(dist.aiPrograms.distinct, PLAYERS, '每个玩家的 AI 程序内容必须不同');
  assert.ok(Object.keys(dist.aiPrograms.presets).length >= 2, '预设应有多种（同一 seed 下多样性）');
  const counts = report.integrity.counts;
  // 积分轨道：只有快速对战改积分（D-133 双轨），排位一场都不计入 rating.games
  assert.ok(dist.ratingGamesTotal >= counts.quickMatches, '积分场次 ≥ 快速对战数（每场两端各计一次）');
  assert.ok(dist.ratingGamesTotal <= counts.quickMatches * 2, '积分场次 ≤ 快速对战数 × 2');
  assert.ok(counts.journalRecords > 0);
  assert.ok(report.wallMs > 0);
  // journal 两侧记账与档案统计闭合（无半场战绩的档案层证据）
  assert.equal(counts.attackRecordsApplied, counts.battleRecords);
  assert.equal(counts.defenseRecordsApplied, counts.battleRecords);
  assert.equal(counts.duplicateBattleIds, 0);
  assert.equal(counts.journalSeqMonotonic, true);
  // 每个玩家的出战快照必须能实例化（快照正文可读 + AI 程序可校验）
  const store = report.storeHandle;
  for (const pid of store.index.playerIds()) {
    const archive = await store.loadArchive(pid);
    const slot = archive.configs.slots.find((s) => s.slotId === archive.configs.activeSlotId);
    assert.ok(slot && slot.snapshot && slot.snapshot.hash, `${pid} 必须有出战快照`);
    const snap = await store.snapshot.get(slot.snapshot.hash);
    assert.ok(snap && snap.loadout, `${pid} 快照正文必须可读`);
    const v = astApi.validate(snap.loadout.ai, archive.progress.tier);
    assert.equal(v.ok, true, `${pid} 快照 AI 必须通过校验`);
  }
  t.diagnostic(`[LOAD-7] AI 去重 ${dist.aiPrograms.distinct}/${PLAYERS}；对局 ${counts.battleRecords}（排位 ${counts.rankedMatches} + 快速 ${counts.quickMatches}）；积分分布 ${JSON.stringify(dist.rating.bands)}`);
});
