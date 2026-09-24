'use strict';
/* tests/integration/load-integrity.test.js —— P7-6 批量测试的**小规模固化**（完整性断言 ①③④⑤⑥⑦）
 *
 * 权威：docs/plan-p7-playable.md §P7-6（批量注册真实玩家 → 配齐出战配置 → 先建池后匹配 → 完整性断言）；
 *      docs/systems/11-account-store.md §6.1/§6.3（journal 幂等）/§7（异步排位）/§8（快速对战与积分守恒）；
 *      decisions.md D-132/D-133/D-134/D-136/D-152 + **D-159/D-160/D-161/D-162**（本批契约变更）。
 *
 * 规模：`--players 12` 等价（并发 6、快速 scrypt N=1024）→ 时长控制在 1~3 s，可纳入 `npm test`。
 * 断言：
 *   ① journal 幂等（重复 apply 不重复记账）
 *   ③ 积分守恒（对局粒度 + 全局粒度；D-133 非零和"汇"）
 *   ④ leaderboard 与档案一致（重建索引后一致）
 *   ⑤ 回放 LRU 不越界
 *   ⑥ 每场对局双方均为真实注册玩家（无 bot 补位；可从未删档案追溯）
 *   ⑦ 无 5xx
 * 另有"流程完整度"断言：N 个玩家全部注册成功 → 全部配齐出战配置 → 池就绪（档案 + 可用快照 ≥ N）→ 真打了对局。
 *
 * 🆕 D-159…D-162 迁移要点（本文件改动的依据，逐处标注）：
 *   · D-159：注册即发 starter（服务端权威仓库 + slot1 完整已装配出战 + 3 槽 + 库内默认 AI）。
 *     → 旧断言"**开箱次数 / 装配 HTTP 次数 / PUT /me/warehouse 镜像次数** = 结构完整度判据"的前提被推翻：
 *       开箱随机性已收归服务端（D-162），装配次数不再是确定性量。本文件把这些**分布计数断言**换成
 *       **服务端真源不变量**（`assertServerTruth`）：逐玩家核对"出战配置完整 + 每个装配引用都在其服务端仓库中、
 *       equipped=true、且装在那件物品自己的槽上"，并逐玩家核对"出战 AI 逐字节等于服务端按身份派生的默认 AI"。
 *       这比"某个 HTTP 端点被调了 N 次"更强（直接对真源），且不依赖随机掉落。
 *   · D-160：`POST /me/configs` 建空槽、非出战槽允许不完整 —— 由 `tests/integration/e2e-play.test.js` 覆盖。
 *   · D-161：AI 库（`/me/ai`）—— 同上，本文件只断言"starter 的默认 AI 与配置一致"。
 *   · D-162：HTTP 开箱**没有 seed 入参**（传了被静默忽略，不再有 bad_seed）；确定性由 `start({boxSeed})` 提供
 *     → 断言"不得出现 bad_seed"，并新增 LOAD-6b 用两个同 `boxSeed` 的独立实例验证"同 seed 同批次内容"。
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
const rankedMod = require('../../server/ranked.js');
const { createLogger } = require('../../shared/log.js');

const PLAYERS = 12;   // 小规模：时长可控（生产规模用 `node scripts/load-test.js --players 200`）
const SEED = 424242;

// 单次共享运行：全部断言共享同一份批量结果。**run() 自身绝不 assert、绝不抛出** ——
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
    deep: true,          // 小规模：开启索引重建比对（断言 ④）+ 服务端权威写端点往返（D-159）
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

/* ---------- D-159 服务端真源不变量（替代旧的"开箱/装配/镜像 分布计数"断言） ---------- */

function findInWarehouse(wh, uid) {
  for (const list of Object.values((wh && wh.buckets) || {})) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((x) => x && x.uid === uid);
    if (hit) return hit;
  }
  return null;
}

// 出战配置里"引用 → 宿主物品 + 槽下标"（用于断言引用确实装在那件物品自己的槽上）
function refSitesOfLoadout(ld) {
  const out = [];
  for (const item of [ld.role].concat(ld.skills || [])) {
    if (!item || typeof item.uid !== 'string') continue;
    (item.slots || []).forEach((s, i) => {
      if (s && s.pluginUid) out.push({ targetUid: item.uid, slotIndex: i, pluginUid: s.pluginUid });
    });
  }
  return out;
}

/**
 * D-159：对**服务端档案真源**逐玩家核对批量流程要达成的全部不变量。
 *   为什么这样替代旧断言：旧断言数的是"测试脚本自己发了几次开箱/装配/镜像请求"，
 *   D-162 之后开箱序列由服务端独占、次数不再确定；而"配齐出战配置"的真实语义是
 *   **每人的出战配置完整、且其装配引用在服务端仓库里确实装配着** —— 直接核真源既确定又更强。
 * 返回 { players, refs, distinctAi, aiMatches } 供报告 ↔ 真源交叉比对。
 */
let truthCache = null;
async function truth() {
  if (truthCache) return truthCache;
  const report = await run();
  const store = report.storeHandle;
  const ids = store.index.playerIds();
  assert.equal(ids.length, PLAYERS, '档案数 = 注册玩家真实数');
  let refs = 0;
  let aiMatches = 0;
  const aiHashes = new Set();
  for (const pid of ids) {
    const archive = await store.loadArchive(pid);
    assert.ok(archive, `${pid} 档案必须存在（可追溯）`);
    assert.equal(archive.archiveVersion, archiveMod.ARCHIVE_VERSION, `${pid} 档案必须是当前版本（D-159）`);
    // 出战槽正文（D-159/D-160：出战槽必须完整）
    const active = archiveMod.activeSlot ? archiveMod.activeSlot(archive)
      : archive.configs.slots.find((s) => s.slotId === archive.configs.activeSlotId);
    assert.ok(active && active.loadout, `${pid} 必须有出战槽正文`);
    assert.deepEqual(archiveMod.loadoutMissingOf(active.loadout), [], `${pid} 出战配置必须完整（角色 + 恰 3 技能 + AI）`);
    // 每个装配引用都必须落在服务端仓库里且真的装在那件物品的槽上
    const sites = refSitesOfLoadout(active.loadout);
    assert.ok(sites.length >= 1, `${pid} starter 出战配置必须至少 1 处装配引用（D-159）`);
    for (const site of sites) {
      refs += 1;
      const plugin = findInWarehouse(archive.warehouse, site.pluginUid);
      assert.ok(plugin, `${pid} 引用插件 ${site.pluginUid} 必须在服务端仓库中（D-159）`);
      assert.equal(plugin.equipped, true, `${pid} 引用插件 ${site.pluginUid} 必须 equipped=true（D-159）`);
      const host = findInWarehouse(archive.warehouse, site.targetUid);
      assert.ok(host, `${pid} 宿主物品 ${site.targetUid} 必须在服务端仓库中`);
      assert.equal(host.slots[site.slotIndex].pluginUid, site.pluginUid,
        `${pid} 引用必须落在宿主自己的槽上：${site.targetUid}[${site.slotIndex}]`);
    }
    // D-159：出战 AI = 服务端按身份派生的默认 AI（逐字节）
    const expected = rankedMod.buildDefaultLoadout({ publicId: archive.publicId, playerId: pid });
    const got = astApi.programHash(active.loadout.ai);
    const want = astApi.programHash(expected.ai);
    assert.equal(got, want, `${pid} 出战 AI 必须等于服务端身份派生的默认 AI（D-159）`);
    aiMatches += 1;
    aiHashes.add(got);
  }
  truthCache = { players: ids.length, refs, distinctAi: aiHashes.size, aiMatches };
  return truthCache;
}

// 收尾：关闭共享的进程内服务 + 删除临时数据根（本文件共享同一份批量运行的用例在此清理）
after(async () => {
  if (shared) await load.closeReport(shared);
  shared = null;
  truthCache = null;
});

test('LOAD-0 批量流程完整度：N 个真实玩家全部注册 + 配齐出战配置（starter 服务端权威）+ 池就绪 + 真打对局（无 bot）', async (t) => {
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
  // D-159：默认路径**不开箱、不装配**；`--deep` 时才走服务端权威写端点（每人恰一次拆卸→装配往返）。
  //   本夹具固定 deep:true，故这里断言"每人至少一次成功往返"（覆盖 12 个真实玩家的写路径）。
  assert.equal(report.options.deep, true, '本夹具走 --deep 路径（压测服务端权威写端点，D-159）');
  assert.ok(setup.assemble.placed >= PLAYERS,
    `--deep 下每人至少一次 POST /me/warehouse/assemble 成功（实得 ${setup.assemble.placed}）`);
  assert.ok(setup.assemble.disassembled >= PLAYERS,
    `--deep 下每人至少一次 POST /me/warehouse/disassemble 成功（实得 ${setup.assemble.disassembled}）`);
  assert.equal(setup.assemble.placed, setup.assemble.disassembled, '拆卸/装配往返数必须配平');

  // D-159 真源不变量（**替代**旧的"装配 HTTP 处数 > 0 / PUT /me/warehouse 200 === PLAYERS"）：
  //   旧断言数的是测试自己发的请求；新断言直接核对"每人的出战配置完整、引用齐备且真的装在槽上"。
  const tr = await truth();
  assert.equal(tr.players, PLAYERS);
  assert.ok(tr.refs >= PLAYERS * 2, `每人 starter 至少 2 处装配引用（1 角色插件 + 1 技能插件），实得 ${tr.refs}`);
  const dist0 = report.metrics.statusDistribution;
  // D-159：真源读路径必须覆盖每个玩家（配齐出战配置的 HTTP 证据）
  assert.ok(dist0['GET /api/v1/me 200'] >= PLAYERS, '每人至少一次 /me 摘要读取');
  assert.ok(dist0['GET /api/v1/me/configs 200'] >= PLAYERS, 'D-159：每人至少一次配置真源读取');
  assert.ok(dist0['GET /api/v1/me/warehouse 200'] >= PLAYERS, 'D-159：每人至少一次仓库真源读取');
  assert.ok((dist0['POST /api/v1/me/box 200'] || 0) >= PLAYERS, 'D-162/--deep：开箱走服务端权威端点 POST /me/box');
  assert.ok((dist0['POST /api/v1/me/warehouse/assemble 200'] || 0) >= PLAYERS, 'D-159：装配走 POST /me/warehouse/assemble');
  assert.ok((dist0['POST /api/v1/me/warehouse/disassemble 200'] || 0) >= PLAYERS, 'D-159：拆卸走 POST /me/warehouse/disassemble');
  // D-159：`PUT /me/warehouse` 退役为"只做形状校验" → 默认批量流程**不得**再依赖客户端镜像
  assert.equal(dist0['PUT /api/v1/me/warehouse 200'], undefined, 'D-159：默认流程不得再提交客户端仓库镜像');
  // D-162：HTTP 开箱没有 seed 入参（传了被静默忽略）→ 不得出现 bad_seed
  assert.equal(report.metrics.errorCodes.bad_seed, undefined, 'D-162：HTTP 开箱无 seed 入参，不得出现 bad_seed');

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
  // D-159：AI 不再由测试逐玩家编造 —— starter 的 AI 由服务端按身份派生（`ranked.buildDefaultLoadout`，
  //   3 预设族 × 子变体），故 `distinct` 不再等于玩家数。等价的强断言：
  //   ① 每人出战 AI 逐字节等于服务端身份派生默认 AI（assertServerTruth 已逐人核，见 tr.aiMatches）；
  //   ② 报告的去重数必须等于按真源独立复算的去重数（报告口径不得自说自话）；
  //   ③ 实际确实出现 ≥2 种（否则"按身份派生"退化为常量）。
  assert.equal(tr.aiMatches, PLAYERS, '每人出战 AI 必须逐字节等于服务端身份派生的默认 AI（D-159）');
  assert.equal(report.distribution.aiPrograms.distinct, tr.distinctAi, '报告 AI 去重数必须等于真源独立复算值');
  assert.ok(tr.distinctAi >= 2, `按身份派生的 AI 应至少出现 2 种（实得 ${tr.distinctAi}）`);
  t.diagnostic(`[LOAD-0] 注册=${reg.ok} 配齐=${setup.ok} 真源引用=${tr.refs}处 AI去重=${tr.distinctAi}/${PLAYERS} `
    + `池=${pool.archives}/快照${pool.usableSnapshots} 对局=${matches.totalMatches}`
    + `（排位 ${matches.ranked.matches} + 快速 ${matches.quick.ok}） 深度往返=装配${setup.assemble.placed}/拆卸${setup.assemble.disassembled} `
    + `吞吐=${matches.throughputPerSecond}/s`);
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
  // 本批量流程只跑 /me/*、/ranked/run、/quick/run，**不调用 POST /battle** ⇒ 不产帧
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

test('LOAD-6 ⑦无 5xx + 状态码分布自洽（D-159/D-162 端点口径）', async (t) => {
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
    // 唯一允许的业务拒绝 = "池不足不注入 bot" 的 quick no_opponent 409（D-152）；其余非 200 一律是契约问题
    if (status !== 200) {
      assert.equal(status, 409, `只允许 409 业务拒绝（实得 ${key} × ${count}）`);
    }
  }
  // 错误码白名单：迁移后批量流程只应出现 no_opponent
  for (const code of Object.keys(m.errorCodes)) {
    assert.equal(code, 'no_opponent', `出现未预期的业务错误码 ${code} × ${m.errorCodes[code]}`);
  }
  // 关键端点（D-159 迁移后的**真源读路径**）必须覆盖每个玩家
  assert.equal(dist['POST /api/v1/auth/register 200'], PLAYERS, '注册全部 200');
  assert.ok(dist['GET /api/v1/me 200'] >= PLAYERS, '每人至少一次 /me 摘要读取');
  assert.ok(dist['GET /api/v1/me/configs 200'] >= PLAYERS, 'D-159：每人至少一次配置真源读取');
  assert.ok(dist['GET /api/v1/me/warehouse 200'] >= PLAYERS, 'D-159：每人至少一次仓库真源读取');
  assert.equal(dist['GET /api/v1/leaderboard 200'], 1, '排行榜读一次（断言 ④ 的 HTTP 复核）');
  // D-159：`PUT /me/warehouse` 退役为"只做形状校验" → 默认流程不得再依赖客户端镜像
  assert.equal(dist['PUT /api/v1/me/warehouse 200'], undefined, 'D-159：默认流程不得再提交客户端仓库镜像');
  // D-159：仓库真源恒存在 → 不得再出现 warehouse_missing（旧 D-130 的 404 码）
  assert.equal(m.errorCodes.warehouse_missing, undefined, 'D-159：仓库真源恒存在，不得再出现 warehouse_missing');
  // D-162：HTTP 开箱没有 seed 入参（传了被静默忽略）→ 不得出现 bad_seed
  assert.equal(m.errorCodes.bad_seed, undefined, 'D-162：HTTP 开箱无 seed 入参，不得出现 bad_seed');
  assert.equal(m.errorCodes.loadout_invalid, undefined, '不得有 loadout_invalid（出战配置必须自洽可用）');
  // `--deep`：服务端权威写端点（D-159）必须真的被压到且成功
  assert.ok((dist['POST /api/v1/me/box 200'] || 0) >= PLAYERS, 'D-159/D-162：每人至少一次服务端权威开箱');
  assert.ok((dist['POST /api/v1/me/warehouse/disassemble 200'] || 0) >= PLAYERS, 'D-159：每人至少一次拆卸');
  assert.ok((dist['POST /api/v1/me/warehouse/assemble 200'] || 0) >= PLAYERS, 'D-159：每人至少一次装配（往返）');
  // D-162：批量流程必须注入确定性开箱 seed（同 seed 可复现 → LOAD-6b 验证语义）
  assert.ok(report.options.deterministicBoxes === true || Number.isInteger(report.options.boxSeed),
    'D-162：批量流程必须注入 boxSeed（确定性序列）');
  t.diagnostic(`[LOAD-6] 请求 ${m.requests} 次，5xx=0，传输失败=0，错误率 ${m.errorRate}；`
    + `boxSeed=${report.options.boxSeed}（确定性=${report.options.deterministicBoxes}）`);
});

/* ---------- 6b. D-162：开箱 seed 服务端独占 + start({boxSeed}) 确定性（新端点，独立小实例） ---------- */

test("LOAD-6b D-162：HTTP 开箱无 seed 入参（传了被忽略）；start({boxSeed}) 提供可复现序列（同 seed 同批次）", async (t) => {
  // 三个独立小实例（各自 dataDir 隔离）：前两个同 boxSeed → 必须产出**同一批**掉落内容；第三个不同 boxSeed。
  const logger = createLogger({ level: 'error' });
  const authConfig = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 1000 } };
  const started = [];
  const boot = async (boxSeed) => {
    const dataDir = load.makeTempDir();
    const s = await serverMod.start({
      logger, dataDir, port: 0, boxSeed, versions: { engine: serverMod.VERSION },
      authConfig, rateLimitPerMinute: 1000,
    });
    started.push({ s, dataDir });
    return s;
  };
  // 注册 + 开箱（`seed` 只在"必须被忽略"的用例里显式塞进 body —— D-162：接口没有该字段）
  const registerAndBox = async (s, tag, body) => {
    const reg = await load.httpRequest(s.port, 'POST', '/api/v1/auth/register', {
      username: `d162_${tag}`, password: load.PASSWORD, nickname: `seed${tag}`,
    });
    assert.equal(reg.status, 200, `注册应 200：${JSON.stringify(reg.body).slice(0, 160)}`);
    const token = reg.body.data.token;
    const box = await load.httpRequest(s.port, 'POST', '/api/v1/me/box', body, { authorization: `Bearer ${token}` });
    assert.equal(box.status, 200, `POST /me/box 应 200：${JSON.stringify(box.body).slice(0, 160)}`);
    return box.body.data;
  };
  // 内容投影（去掉进程内分配的 uid，只比"内容级"）
  const contentOf = (items) => items.map((it) => { const { uid, ...rest } = it; return rest; });
  try {
    const BASE = 1000;
    const s1 = await boot(BASE);
    const s2 = await boot(BASE);
    const s3 = await boot(BASE + 1000);

    // ① `start({boxSeed})` = 确定性序列：第 n 次调用 = boxSeed + n − 1（第 1 次 = boxSeed，第 2 次 = boxSeed+1）
    const a1 = await registerAndBox(s1, 'a1', { times: 4, tier: 'common' });
    const a2 = await registerAndBox(s1, 'a2', { times: 4, tier: 'common' });
    assert.ok(Number.isInteger(a1.seed) && a1.seed >= 1 && a1.seed <= 0x7fffffff, `seed 必须服务端生成（实得 ${a1.seed}）`);
    assert.equal(a1.seed, BASE, `D-162：第 1 次开箱 seed = boxSeed（实得 ${a1.seed}）`);
    assert.equal(a2.seed, a1.seed + 1, `确定性序列必须逐次推进（${a1.seed} → ${a2.seed}）`);
    assert.match(a1.grantId, /^bx_[0-9a-f]{16}$/, 'D-159：POST /me/box 必须入档并回带 grantId');

    // ② 同 boxSeed 的第二个实例：seed 与**掉落内容**必须逐值一致（内容级；uid 由进程内计数器分配，故排除）
    const b1 = await registerAndBox(s2, 'b1', { times: 4, tier: 'common' });
    assert.equal(b1.seed, a1.seed, '同 boxSeed 的第 1 次开箱必须得到同一 seed');
    assert.deepEqual(contentOf(b1.items), contentOf(a1.items), 'D-162：同 boxSeed 两次运行必须产出同一批掉落内容（uid 除外）');

    // ③ 不同 boxSeed → 不同 seed；且 body 里的 `seed` 必须被**静默忽略**（D-162：不再有 bad_seed）
    const c1 = await registerAndBox(s3, 'c1', { times: 4, tier: 'common', seed: 424242 });
    assert.notEqual(c1.seed, 424242, 'D-162：HTTP 开箱不接受客户端 seed（传了必须被忽略）');
    assert.notEqual(c1.seed, a1.seed, '不同 boxSeed 必须得到不同 seed');
    assert.equal(c1.seed, BASE + 1000, '同一注入序列口径：第 1 次 = boxSeed');
    // ④ 遗留无状态 `POST /box` 同样不接受 seed，并从**同一**确定性序列取下一个
    const legacy = await load.httpRequest(s3.port, 'POST', '/api/v1/box', { times: 2, tier: 'common', seed: 424242 });
    assert.equal(legacy.status, 200, `遗留 POST /box 应 200：${JSON.stringify(legacy.body).slice(0, 160)}`);
    assert.notEqual(legacy.body.data.seed, 424242, 'D-162：遗留 /box 也不接受客户端 seed');
    assert.equal(legacy.body.data.seed, c1.seed + 1, '遗留 /box 与 /me/box 共用同一确定性序列');
    assert.equal(legacy.body.data.grantId, undefined, 'D-159：遗留 /box 不入档 → 无 grantId');
    t.diagnostic(`[LOAD-6b] boxSeed=${BASE}：两次独立运行 seed=${a1.seed}、内容逐值一致（${a1.items.length} 件）；`
      + `序列推进 ${a1.seed}→${a2.seed}；客户端 seed=424242 被忽略（实得 ${c1.seed}）；遗留 /box 共用序列（seed=${legacy.body.data.seed}）`);
  } finally {
    for (const { s, dataDir } of started) {
      try { await s.close(); } finally { load.removeTempDir(dataDir); }
    }
  }
});

test('LOAD-7 引擎与分布：AI 由服务端身份派生 + 账务闭合 + 每人快照可实例化', async (t) => {
  const report = await run();
  const dist = report.distribution;
  // D-159：starter 的 AI 由服务端按身份派生（3 预设族 × 子变体）→ 去重数不再等于玩家数
  //   （旧断言 `distinct === PLAYERS` 依赖"测试逐玩家编造 AI"，该前提已随契约废除）。
  //   等价的强断言：报告去重数 ≡ 真源独立复算值；每人 AI 逐字节等于服务端身份派生默认 AI；实际 ≥2 种。
  const tr = await truth();
  assert.equal(dist.aiPrograms.distinct, tr.distinctAi, '报告 AI 去重数必须等于按档案真源独立复算的去重数');
  assert.ok(dist.aiPrograms.distinct >= 2 && dist.aiPrograms.distinct <= PLAYERS,
    `按身份派生的 AI 去重数应落在 [2, ${PLAYERS}]（实得 ${dist.aiPrograms.distinct}）`);
  assert.equal(tr.aiMatches, PLAYERS, '每人出战 AI 必须逐字节等于服务端身份派生的默认 AI（D-159）');
  assert.ok(Object.keys(dist.aiPrograms.presets).length >= 2, '预设应有多种（同一 seed 下多样性）');
  // 报告 ↔ 真源交叉比对：装配引用总数必须一致（防止报告与档案各说各话）
  assert.equal(dist.equippedPlugins.total, tr.refs, '报告装配引用总数必须等于真源复算值（D-159）');
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
  t.diagnostic(`[LOAD-7] AI 去重 ${dist.aiPrograms.distinct}/${PLAYERS}（服务端身份派生，逐人核对通过 ${tr.aiMatches}）；`
    + `装配引用 ${tr.refs} 处；对局 ${counts.battleRecords}（排位 ${counts.rankedMatches} + 快速 ${counts.quickMatches}）；`
    + `积分分布 ${JSON.stringify(dist.rating.bands)}`);
});
