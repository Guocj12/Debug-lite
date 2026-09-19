'use strict';
/* server/quickmatch.js —— 快速对战：匹配 + 非对称 Elo + 双向结算（P7-3 / B32）
 * 契约：docs/interfaces.md §1 `server/quickmatch.js`（`runQuickMatch({playerId,seed})` / `match(points)` /
 *      `settle(record)`）+ §2 `POST /api/v1/quick/run` + §6 事件 `quick.match`(info) / `quick.settle`(info)；
 *      docs/systems/11-account-store.md §8（流程/匹配/公式/双向结算/反刷）；decisions.md D-133/D-136。
 *
 * 🚫 无占位 bot：匹配池**只能**由真实玩家档案构成（服务端 `index` + 快照库），无候选 → `no_opponent`；
 *    服务器**不接受**客户端自选对手（D-136）。调试 bot 只能由 `server/admin.js` 以真实档案注入注册表。
 *
 * 非对称 Elo（D-133，公式与数值全部来自 `rating-config.json`，本文件零数值字面量）：
 *   E_self = 1 / (1 + 10 ^ ((R_opp - R_self) / scale))
 *   K_gain(R) = clamp(kBase * (1 - R/cap), kMin, kBase)     K_loss(R) = clamp(kBase * (1 + R/cap), kBase, kMax)
 *   胜 Δ = +round(K_gain * (1 - E))   负 Δ = -round(K_loss * E)   平 Δ = +round(drawFactor * kBase * (0.5 - E))
 *   结果 = clamp(R + Δ, 0, cap)；均衡点（同分对手）r = R/cap = 2p - 1 → R = cap × (2 × 胜率 − 1)。
 *   **有意非零和**：Δ_self + Δ_opp ≠ 0（系统存在分数汇，抑制通胀，属设计）。
 */
const { nullLogger } = require('../shared/log.js');
const { createRng } = require('./core/rng.js');
const crypto = require('node:crypto');
const archiveMod = require('./store/archive.js');
const ledger = require('./store/ledger.js');
const ranked = require('./ranked.js');

const SEED_MAX = 0x7fffffff;
const COOLDOWN_RELAX_MULT = ranked.COOLDOWN_RELAX_MULT;
const MAX_LIMIT = 100;

/* ---------- Elo 原语（纯函数，供测试机器复算） ---------- */

// E_self（§8.3）
function expectedScore(selfPoints, opponentPoints, config) {
  return ledger.expectedScore(selfPoints, opponentPoints, config);
}

// 单方 Δ 与结果积分（§8.3：clamp(R + Δ, 0, cap)）
function ratingDelta(input) {
  return ledger.ratingDelta(input);
}

// 一场的双向结算（非零和：zeroSum 恒 false 属有意设计，D-133）
function settle(input) {
  const o = input || {};
  return ledger.settleRating({
    p1Points: o.p1Points, p2Points: o.p2Points, winner: o.winner, config: o.config,
  });
}

/* ---------- 匹配（§8.2，纯函数） ---------- */

function matchWindowConfig(config) {
  const cfg = config || {};
  return {
    start: Number.isInteger(cfg.matchWindowStart) ? cfg.matchWindowStart : 0,
    step: Number.isInteger(cfg.matchWindowStep) && cfg.matchWindowStep > 0 ? cfg.matchWindowStep : 0,
    max: Number.isInteger(cfg.matchWindowMax) ? cfg.matchWindowMax : 0,
    cooldown: Number.isInteger(cfg.opponentCooldownHours) ? cfg.opponentCooldownHours : 0,
  };
}

// 候选筛选：|points_opp − points_self| ≤ window 且 非自己/未封禁/在池内/有可用快照（§8.2 步骤 1）
function matchCandidates(pool, selfPoints, window, isEligible) {
  const out = [];
  for (const candidate of pool || []) {
    if (!isEligible(candidate)) continue;
    if (Math.abs((candidate.points || 0) - selfPoints) > window) continue;
    out.push(candidate);
  }
  return out;
}

// 去重窗口（§8.2 步骤 5 / D-136，与 ranked 同一裁定口径）：
//   strict = 间隔 ≥ 72h（新鲜）；relaxed = 24h ≤ 间隔 < 72h；间隔 < 24h 任何池都不收（硬底线）
function splitByCooldown(candidates, foeArchive, cooldownHours, relaxHours, at) {
  const strict = [];
  const relaxed = [];
  for (const c of candidates) {
    if (!archiveMod.opponentCooldownOk(foeArchive, c.playerId, cooldownHours, at)) continue;
    if (archiveMod.opponentCooldownOk(foeArchive, c.playerId, relaxHours, at)) strict.push(c);
    else relaxed.push(c);
  }
  return { strict, relaxed };
}

// "最久未对战"优先，再用种子随机打破平局（§8.2 步骤 3）
function lastOpponentAtOf(foeArchive, playerId) {
  const map = (foeArchive && foeArchive.pool && foeArchive.pool.lastOpponentAt) || {};
  const last = map[playerId];
  return Number.isInteger(last) ? last : 0;
}

function findMatch(input) {
  const o = input || {};
  const cfg = matchWindowConfig(o.config);
  const at = Number.isInteger(o.at) ? o.at : 0;
  const relaxHours = cfg.cooldown * COOLDOWN_RELAX_MULT;
  const rng = o.rng || createRng(Number.isInteger(o.seed) ? o.seed : 1).deriveStream(0, 'quick');
  const maxWindow = cfg.max > cfg.start ? cfg.max : cfg.start;
  for (let window = cfg.start; ; window += cfg.step) {
    const found = matchCandidates(o.pool, o.selfPoints, window, o.isEligible);
    if (found.length > 0) {
      const split = splitByCooldown(found, o.foeArchive, cfg.cooldown, relaxHours, at);
      // 严格池（≥72h 新鲜对手）优先；不足 1 个时才启用 24–72h 的放宽池（裁定口径，同 ranked）
      const relaxed = split.strict.length === 0 && split.relaxed.length > 0;
      const usable = relaxed ? split.relaxed : split.strict;
      if (usable.length > 0) {
        // 最久未对战优先 → 同分用种子随机打破平局（§8.2 步骤 3）
        const sorted = usable.slice().sort((a, b) => {
          const la = lastOpponentAtOf(o.foeArchive, a.playerId);
          const lb = lastOpponentAtOf(o.foeArchive, b.playerId);
          if (la !== lb) return la - lb;
          return a.playerId < b.playerId ? -1 : a.playerId > b.playerId ? 1 : 0;
        });
        const pick = sorted.length === 1 ? 0 : rng.int(0, sorted.length - 1);
        return { ok: true, window, relaxed, cooldown: relaxed ? relaxHours : cfg.cooldown, opponent: sorted[pick], candidateCount: found.length };
      }
    }
    if (window >= maxWindow || cfg.step <= 0) break;
  }
  return { ok: false, window: maxWindow, relaxed: false, cooldown: cfg.cooldown, opponent: null, candidateCount: 0 };
}

/* ---------- 工厂 ---------- */

/**
 * createQuickMatch({ store, logger?, now?, config?, env?, runBattle? })
 *   store 必填（server/store 适配器，已 open）。
 * 返回方法（全部 async，返回 `{status, data}` 或 `{status, code, message, details?}`）：
 *   run({ playerId, seed? })       —— POST /api/v1/quick/run 的业务体（匹配 + 跑一场 + 双向 Elo 结算 + 落盘）
 *   findOpponent({ playerId })     —— 只做匹配（dry-run，不结算；P7-4 可用于预检）
 *   loadLeaderboard(query)         —— GET /api/v1/leaderboard 的数据源（`{scope,limit}`）
 */
function createQuickMatch(options) {
  const opts = options || {};
  const store = opts.store;
  if (!store || typeof store.loadArchive !== 'function' || typeof store.settleBattle !== 'function') {
    throw new TypeError('createQuickMatch 需要已装配的 store 适配器（server/store/index.js createStore/openStore）');
  }
  const log = opts.logger || nullLogger;
  const nowFn = typeof opts.now === 'function' ? opts.now
    : (typeof store.now === 'function' ? store.now : () => Date.now());
  const env = opts.env === undefined ? process.env : opts.env;
  const config = opts.config || store.ratingConfig || {};
  const debugBots = ranked.inspectDebugBots(env);

  // 候选池：排行榜索引 + 可用快照 + 未封禁 + 在池内（服务端抽池，不可自选对手 D-136）
  async function candidatePool(selfId) {
    const ids = store.index.playerIds();
    const pool = [];
    const skipped = { unusable: 0, banned: 0, outOfPool: 0 };
    for (const playerId of ids) {
      if (playerId === selfId) continue;
      const entry = store.index.get(playerId);
      if (!entry) continue;
      if (entry.banned) { skipped.banned += 1; continue; }
      if (!entry.inPool) { skipped.outOfPool += 1; continue; }
      const snapshot = await ranked.loadSnapshotOf(store, entry.activeSnapshotHash);
      if (!ranked.isUsableSnapshot(snapshot)) { skipped.unusable += 1; continue; }
      pool.push({
        playerId, publicId: entry.publicId, nickname: entry.nickname, tier: entry.tier,
        points: entry.points, snapshotHash: entry.activeSnapshotHash, isBot: !!entry.isBot,
      });
    }
    return { pool, skipped, poolSize: ids.length };
  }

  async function requireArchive(playerId) {
    if (typeof playerId !== 'string' || playerId === '') return { error: { status: 400, code: 'bad_request', message: '需要 playerId（鉴权中间件注入，P7-4）' } };
    const archive = await store.loadArchive(playerId);
    if (!archive) return { error: { status: 404, code: 'store_not_found', message: `档案 ${playerId} 不存在` } };
    if (archive.flags && archive.flags.banned) return { error: { status: 403, code: 'banned', message: '账号已被封禁' } };
    const active = archiveMod.activeSlot(archive);
    if (!active || !active.snapshot || !active.snapshot.hash) {
      return { error: { status: 409, code: 'no_active_config', message: '出战配置缺失/快照缺失（不变量破损）' } };
    }
    const snapshot = await ranked.loadSnapshotOf(store, active.snapshot.hash);
    if (!ranked.isUsableSnapshot(snapshot)) {
      return { error: { status: 409, code: 'no_active_config', message: `出战快照正文缺失/不一致 ${active.snapshot.hash}（不变量破损）` } };
    }
    return { archive, active, snapshot };
  }

  async function findOpponent(input) {
    const o = input || {};
    const mine = await requireArchive(o.playerId);
    if (mine.error) return mine.error;
    const seed = o.seed === undefined || o.seed === null ? crypto.randomInt(1, SEED_MAX) : o.seed;
    if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1 || seed > SEED_MAX) {
      return { status: 400, code: 'bad_seed', message: `非法 seed ${seed}` };
    }
    const at = Number.isInteger(o.at) ? o.at : nowFn();
    const poolInfo = await candidatePool(o.playerId);
    const found = findMatch({
      pool: poolInfo.pool,
      selfPoints: mine.archive.rating.points,
      config,
      seed,
      at,
      foeArchive: mine.archive,
      isEligible: (c) => c.playerId !== o.playerId,
    });
    if (!found.ok) {
      log.info('ranked', 'quick.match', `无候选对手（窗口用尽 ≤ ${config.matchWindowMax}，池=${poolInfo.poolSize}）`, {
        playerId: o.playerId, points: mine.archive.rating.points, poolSize: poolInfo.poolSize,
        candidates: poolInfo.pool.length, skipped: poolInfo.skipped, window: found.window, result: 'no_opponent',
      });
      return { status: 409, code: 'no_opponent', message: '匹配不到对手（候选不足/窗口用尽；本轮不注入 bot）' };
    }
    return { mine, seed, at, found, poolInfo };
  }

  // POST /api/v1/quick/run 的业务体
  async function run(input) {
    const o = input || {};
    const matched = await findOpponent(o);
    if (matched.status !== undefined) return matched;
    const { mine, seed, at, found, poolInfo } = matched;
    const foeSnapshot = await ranked.loadSnapshotOf(store, found.opponent.snapshotHash);
    // 1) 战斗种子：优先用注入 battleSeed（测试/重放接缝），否则由匹配种子派生 → **确定性**（同 seed 同结果）
    const matchSeed = o.battleSeed === undefined || o.battleSeed === null
      ? createRng(seed).deriveStream(0, 'quick').int(1, 0x7fffffff)
      : o.battleSeed;
    const r = typeof opts.runBattle === 'function'
      ? opts.runBattle({ p1: mine.snapshot.loadout, p2: foeSnapshot.loadout, tier: mine.archive.progress.tier, seed: matchSeed })
      : ranked.battleOne(mine.snapshot.loadout, foeSnapshot.loadout, null, mine.archive.progress.tier, matchSeed);
    if (r.invalid) {
      log.warn('store', 'store.snapshot.missing', '对手/我方快照无法实例化 → 本场 invalid（不记账）', {
        playerId: o.playerId, opponentPlayerId: found.opponent.playerId, code: 'snapshot_invalid',
        errors: r.errors === undefined ? null : r.errors.slice(0, 3),
      });
      return { status: 409, code: 'no_opponent', message: '抽到的对手快照无法实例化（本场不成立）' };
    }
    const winner = r.winner === 'p1' ? 'p1' : r.winner === 'p2' ? 'p2' : 'draw';
    // 结算前取值：settleBattle 会按模式规整 pointsAfter/tierAfter，故先取一份供记录构造及公式复算使用
    const selfPointsBefore = mine.archive.rating.points;
    const opponentPointsBefore = found.opponent.points;
    const elo = settle({ p1Points: selfPointsBefore, p2Points: opponentPointsBefore, winner, config });
    // 幂等（D-134/§9.1）：同一场（同 seed + 同双方快照）→ 同 battleId，journal 内容寻址。
    // 已存在的记录**不重新构造**（否则重放写入的 pointsBefore 会取自当前档案而非原始值，破坏 journal 逐字节可复现），
    // 响应里的 Δ 一律取 **档案落盘值之差**（重复结算时为 0）。
    const battleId = ledger.battleIdOf({
      batchId: null, matchIndex: null, seed: matchSeed,
      p1SnapshotHash: mine.active.snapshot.hash, p2SnapshotHash: found.opponent.snapshotHash,
    });
    const existing = typeof store.findBattleRecord === 'function' ? await store.findBattleRecord(battleId) : null;
    if (!existing) {
      await store.settleBattle({
        type: 'battle.recorded',
        battleId,
        mode: 'quick',
        seed: matchSeed,
        at,
        p1: {
          playerId: o.playerId, publicId: mine.archive.publicId, role: 'attacker',
          snapshotHash: mine.active.snapshot.hash, configHash: mine.active.snapshot.configHash,
          pointsBefore: selfPointsBefore, pointsAfter: elo.p1.pointsAfter,
          result: elo.p1.result, tierBefore: mine.archive.progress.tier, tierAfter: mine.archive.progress.tier,
        },
        p2: {
          playerId: found.opponent.playerId, publicId: found.opponent.publicId, role: 'defender',
          snapshotHash: found.opponent.snapshotHash, configHash: foeSnapshot.configHash,
          pointsBefore: opponentPointsBefore, pointsAfter: elo.p2.pointsAfter,
          result: elo.p2.result, tierBefore: found.opponent.tier, tierAfter: found.opponent.tier,
        },
        verdict: { winner, reason: null, ticks: r.ticks },
        versions: { engine: store.versions.engine, data: store.versions.data },
      });
    }
    // 结算后再读双方档案：bot 的 rating 被冻结（§7.6），取**实际落盘值**回带，响应不得与档案不一致
    const peek = typeof store.peekNow === 'function' ? store.peekNow : nowFn;
    const selfAfter = await store.loadArchive(o.playerId);
    const opponentAfter = await store.loadArchive(found.opponent.playerId);
    const selfPointsAfter = selfAfter ? selfAfter.rating.points : elo.p1.pointsAfter;
    const opponentPointsAfter = opponentAfter ? opponentAfter.rating.points : elo.p2.pointsAfter;
    // Δ = 档案落盘值之差（重复结算时为 0）；首次结算时应与公式值一致（测试另有独立复算断言）
    const selfDelta = selfPointsAfter - selfPointsBefore;
    const opponentDelta = opponentPointsAfter - opponentPointsBefore;
    // 分数突变告警（§8.5：只记 warn，不阻断）——上限 = 满分区间下的最大加分 Δ = K_gain(base) × (1 − E = 0.5)
    const maxDelta = ledger.gainFactor(config.base === undefined ? 0 : config.base, config) * 0.5;
    if (Math.abs(selfDelta) > maxDelta || Math.abs(opponentDelta) > maxDelta) {
      log.warn('store', 'store.abuse.suspect', `积分突变超出单场理论上限（Δ1=${selfDelta} Δ2=${opponentDelta}）`, {
        playerId: o.playerId, opponentPlayerId: found.opponent.playerId, battleId,
        deltaP1: selfDelta, deltaP2: opponentDelta,
      });
    }
    log.info('ranked', 'quick.match', `快速对战匹配成功（窗口 ${found.window}${found.relaxed ? '，放宽去重' : ''}）`, {
      playerId: o.playerId, opponentPublicId: found.opponent.publicId, opponents: found.candidateCount,
      poolSize: poolInfo.poolSize, skipped: poolInfo.skipped, window: found.window,
      relaxed: found.relaxed, cooldown: found.cooldown, debug: debugBots.enabled, at: peek(),
    });
    log.info('ranked', 'quick.settle',
      `quick 结算 ${winner}：${selfPointsBefore}→${selfPointsAfter}（${selfDelta >= 0 ? '+' : ''}${selfDelta}） vs ${opponentPointsBefore}→${opponentPointsAfter}（${opponentDelta >= 0 ? '+' : ''}${opponentDelta}）`,
      {
        battleId, winner, ticks: r.ticks, seed: matchSeed,
        p1: { playerId: o.playerId, pointsBefore: selfPointsBefore, pointsAfter: selfPointsAfter, delta: selfDelta },
        p2: {
          playerId: found.opponent.playerId, pointsBefore: opponentPointsBefore,
          pointsAfter: opponentPointsAfter, delta: opponentDelta, isBot: found.opponent.isBot,
        },
        zeroSum: selfDelta + opponentDelta === 0, nonZeroSumByDesign: true, duplicate: !!existing,
      });
    return {
      status: 200,
      data: {
        battleId,
        seed: matchSeed,
        winner: winner === 'p1' ? 'win' : winner === 'p2' ? 'loss' : 'draw',
        ticks: r.ticks,
        window: found.window,
        relaxed: found.relaxed,
        zeroSum: selfDelta + opponentDelta === 0,
        self: {
          playerId: o.playerId,
          pointsBefore: selfPointsBefore,
          pointsAfter: selfPointsAfter,
          delta: selfDelta,
          winProbability: elo.p1.expected,
        },
        opponent: {
          playerId: found.opponent.playerId,
          publicId: found.opponent.publicId,
          nickname: found.opponent.nickname,
          tier: found.opponent.tier,
          isBot: found.opponent.isBot,
          pointsBefore: opponentPointsBefore,
          pointsAfter: opponentPointsAfter,
          delta: opponentDelta,
        },
        replayId: battleId,
        duplicate: !!existing,
      },
    };
  }

  // GET /api/v1/leaderboard（§8.6：按 points 降序，同分按 peakPoints，再按 updatedAt 升序）
  async function loadLeaderboard(query) {
    const q = query || {};
    const limit = q.limit === undefined || q.limit === null ? 50 : q.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return { status: 400, code: 'bad_request', message: `limit 必须是 1..${MAX_LIMIT} 的整数` };
    }
    try {
      const rows = store.index.leaderboard({ scope: q.scope, limit });
      return { status: 200, data: { scope: q.scope === undefined || q.scope === null ? 'global' : String(q.scope), limit, rows } };
    } catch (err) {
      if (err && err.code === 'bad_scope') return { status: 400, code: 'bad_scope', message: err.message };
      throw err;
    }
  }

  return { store, config, run, findOpponent, loadLeaderboard, candidatePool };
}

let defaultInstance = null;

// 进程级默认实例（惰性；CLI/HTTP 接线用）。未显式装配 store 时抛错 —— 不隐式创建数据目录。
function defaultQuickMatch(options) {
  if (!defaultInstance) defaultInstance = createQuickMatch(options);
  return defaultInstance;
}

module.exports = {
  createQuickMatch,
  defaultQuickMatch,
  // 纯函数（测试机器复算 + P7-4 复用）
  expectedScore,
  ratingDelta,
  settle,
  findMatch,
  matchCandidates,
  splitByCooldown,
  matchWindowConfig,
  // 对外便捷入口：等价于 `const qm = createQuickMatch({store}); await qm.run({playerId, seed})`
  runQuickMatch: (options, input) => createQuickMatch(options).run(input),
  COOLDOWN_RELAX_MULT,
  MAX_LIMIT,
  SEED_MAX,
};
