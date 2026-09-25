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

// 单场 |Δ| 的真实理论上界（§8.5 突变告警的判据；**不是** kBase/2）：
//   加分上界 = K_gain(base) = kBase（E→0 时取满，低分玩家赢满积分对手 → +32）；
//   扣分上界 = K_loss(cap) = kMax（E→1 时取满，满积分玩家输 0 分对手 → −64）。
//   旧口径误用 "kBase × 0.5 = 16"（同分对手的加分），把合法败局（R=2900 输同分对手 ≈ −31）判成突变（P1-3）。
function maxSingleMatchDelta(config) {
  const cfg = (config && config.rating) || config || {};
  const cap = Number.isInteger(cfg.cap) ? cfg.cap : 3000;
  const base = Number.isInteger(cfg.base) ? cfg.base : 0;
  return Math.max(ledger.gainFactor(base, cfg), ledger.lossFactor(cap, cfg));
}

/* ---------- 匹配（§8.2，纯函数） ---------- */

function matchWindowConfig(config) {
  const cfg = config || {};
  return {
    start: Number.isInteger(cfg.matchWindowStart) ? cfg.matchWindowStart : 0,
    step: Number.isInteger(cfg.matchWindowStep) && cfg.matchWindowStep > 0 ? cfg.matchWindowStep : 0,
    max: Number.isInteger(cfg.matchWindowMax) ? cfg.matchWindowMax : 0,
    // D-168：`opponentRecoveryHours` = 软冷却"线性回满"小时数（取代 D-136 的 opponentCooldownHours 硬底线）
    recovery: Number.isInteger(cfg.opponentRecoveryHours) && cfg.opponentRecoveryHours > 0 ? cfg.opponentRecoveryHours : 0,
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

// D-168 软冷却：**不再有 strict/relaxed 双池、不再有 24h 硬底线**——任何候选都可被抽中，
//   只是"刚打过"的权重低、随时间线性回满。选择实现与排位同源：`ranked.pickByCooldownWeight`。

function findMatch(input) {
  const o = input || {};
  const cfg = matchWindowConfig(o.config);
  const at = Number.isInteger(o.at) ? o.at : 0;
  const rng = o.rng || createRng(Number.isInteger(o.seed) ? o.seed : 1).deriveStream(0, 'quick');
  const maxWindow = cfg.max > cfg.start ? cfg.max : cfg.start;
  for (let window = cfg.start; ; window += cfg.step) {
    const found = matchCandidates(o.pool, o.selfPoints, window, o.isEligible);
    if (found.length > 0) {
      // D-168 软冷却：按"距上次交手时间 / recoveryHours"加权轮盘抽签（同 seed 可复现）；
      //   全员权重为 0（池子极小、都刚打过）时取"最久未打"一组 —— **永不 no_opponent**（除非池空）。
      const pick = ranked.pickByCooldownWeight(found, o.foeArchive, at, cfg.recovery, rng);
      if (pick) {
        return {
          ok: true, window, recoveryHours: cfg.recovery, opponent: pick,
          candidateCount: found.length,
          weight: ranked.cooldownWeightOf(o.foeArchive, pick.playerId, at, cfg.recovery),
        };
      }
    }
    if (window >= maxWindow || cfg.step <= 0) break;
  }
  return { ok: false, window: maxWindow, recoveryHours: cfg.recovery, opponent: null, candidateCount: 0 };
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
  // 缺陷 B：仓库镜像解析缝（缺省 = 无镜像）。装配了插件（槽内 pluginUid）的配置**必须**有仓库正文
  //   才能实例化；镜像不在本进程内时按 ranked 的已校验口径退化（见 ranked.syntheticVerifiedWarehouse）。
  const loadWarehouse = typeof opts.loadWarehouse === 'function' ? opts.loadWarehouse : null;

  async function warehouseFor(playerId, archive, active, loadout) {
    if (!ranked.needsWarehouse(loadout)) return { warehouse: null, degraded: false };
    const real = loadWarehouse ? await loadWarehouse(playerId) : null;
    if (real) return { warehouse: real, degraded: false };
    if (ranked.isWarehouseVerified(archive, active)) {
      const synthetic = ranked.syntheticVerifiedWarehouse(loadout);
      if (synthetic) return { warehouse: synthetic, degraded: true };
    }
    return { warehouse: null, degraded: false };
  }

  // 候选池：排行榜索引 + 可用快照 + 未封禁 + 在池内 + **可实例化**（D1-residual：判定与实例化同源）
  //   D1-residual（2026-09-19 修复）：抽池曾经只判"仓库镜像是否**非空**"，而实例化（`battle.buildPlayer`）
  //   还会因**镜像不覆盖引用**（陈旧子集账号镜像遮蔽快照自带镜像）而失败 → "抽得到但打不了"，
  //   表现为 `409 no_opponent("抽到的对手快照无法实例化")` 且根因埋在 warn 里。
  //   修法：对**带装配引用**的候选（唯一有风险的一类）用 `ranked.sideInstantiable` 证明"真的能实例化"
  //   —— 与 `ranked.battleOne` 同一实现（`battle.buildPlayer`），失败者直接不入池（`skipped.notInstantiable`）。
  //   成本：仅为带引用的候选付一次 buildPlayer（无引用者不受影响）。
  async function candidatePool(selfId) {
    const ids = store.index.playerIds();
    const pool = [];
    const skipped = { unusable: 0, banned: 0, outOfPool: 0, noWarehouse: 0, degraded: 0, notInstantiable: 0 };
    for (const playerId of ids) {
      if (playerId === selfId) continue;
      const entry = store.index.get(playerId);
      if (!entry) continue;
      if (entry.banned) { skipped.banned += 1; continue; }
      if (!entry.inPool) { skipped.outOfPool += 1; continue; }
      const snapshot = await ranked.loadSnapshotOf(store, entry.activeSnapshotHash);
      if (!ranked.isUsableSnapshot(snapshot)) { skipped.unusable += 1; continue; }
      let warehouse = null;
      if (ranked.needsWarehouse(snapshot[ranked.RAW_SNAPSHOT_FIELD])) {
        const foeArchive = await store.loadArchive(playerId);
        const active = foeArchive ? archiveMod.activeSlot(foeArchive) : null;
        const w = await warehouseFor(playerId, foeArchive, active, snapshot[ranked.RAW_SNAPSHOT_FIELD]);
        if (!w.warehouse) { skipped.noWarehouse += 1; continue; }
        warehouse = w.warehouse;
        if (w.degraded) skipped.degraded += 1;
        // 与实例化同源的可用性证明（含"镜像存在但不覆盖引用"的残余态）
        const usable = ranked.sideInstantiable(snapshot[ranked.RAW_SNAPSHOT_FIELD], warehouse, entry.tier);
        if (!usable.ok) {
          skipped.notInstantiable += 1;
          log.warn('store', 'store.snapshot.missing', '候选对手快照无法实例化（抽池阶段已排除，不再拖到对局时 409）', {
            playerId: selfId, opponentPlayerId: playerId, code: 'not_instantiable', reason: 'pool_availability',
            errors: usable.errors.slice(0, 3),
          });
          continue;
        }
      }
      pool.push({
        playerId, publicId: entry.publicId, nickname: entry.nickname, tier: entry.tier,
        points: entry.points, snapshotHash: entry.activeSnapshotHash, isBot: !!entry.isBot, warehouse,
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
    // 缺陷 B：装配引用 + 无仓库正文（且未校验过）→ 如实 409 loadout_invalid（details 含 missing_warehouse），
    //   而不是拖到 buildPlayer 后变成含混的 409 no_opponent。已校验者走退化路径仍可对局。
    const w = await warehouseFor(playerId, archive, active, snapshot[ranked.RAW_SNAPSHOT_FIELD]);
    if (!w.warehouse && ranked.needsWarehouse(snapshot[ranked.RAW_SNAPSHOT_FIELD])) {
      return {
        error: {
          status: 409,
          code: 'loadout_invalid',
          message: '出战快照不合法（装配引用需要仓库镜像）',
          details: [{
            where: 'warehouse', path: 'warehouse', code: 'missing_warehouse',
            message: '出战配置含装配引用，需要 warehouse 校验引用完整性（T-PB-9）',
          }],
        },
      };
    }
    // D1-residual：自身侧也要**证明可实例化**（与实例化同源）——镜像存在但不覆盖引用时，
    //   早失败（可解释的 409 loadout_invalid + 逐条明细），而不是匹配成功后才 409 no_opponent。
    if (ranked.needsWarehouse(snapshot[ranked.RAW_SNAPSHOT_FIELD])) {
      const usable = ranked.sideInstantiable(snapshot[ranked.RAW_SNAPSHOT_FIELD], w.warehouse, archive.progress.tier);
      if (!usable.ok) {
        return {
          error: {
            status: 409,
            code: 'loadout_invalid',
            message: '出战快照不合法（引用无法解析：仓库镜像不可用/不完整）',
            details: usable.errors,
          },
        };
      }
    }
    if (w.degraded) {
      log.warn('store', 'store.snapshot.missing',
        '出战配置含装配引用但仓库镜像不在本进程内（已校验过 → 基准面板退化对局，插件词条不生效）', {
          playerId, reason: 'warehouse_mirror_degraded', snapshotHash: active.snapshot.hash,
        });
    }
    return { archive, active, snapshot, warehouse: w.warehouse, warehouseDegraded: w.degraded };
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
      ? opts.runBattle({
        p1: mine.snapshot.loadout, p2: foeSnapshot.loadout, tier: mine.archive.progress.tier, seed: matchSeed,
        warehouse: mine.warehouse === undefined ? null : mine.warehouse,
        p1Warehouse: mine.warehouse === undefined ? null : mine.warehouse,
        p2Warehouse: found.opponent.warehouse === undefined ? null : found.opponent.warehouse,
      })
      : ranked.battleOne(
        mine.snapshot.loadout, foeSnapshot.loadout,
        { p1: mine.warehouse, p2: found.opponent.warehouse },
        mine.archive.progress.tier, matchSeed,
      );
    if (r.invalid) {
      // D1-residual：抽池已用 `ranked.sideInstantiable` 排除不可实例化候选 → 此处**不应**再发生；
      //   真发生即口径再次漂移：保持对外错误码 `no_opponent`（契约兼容，interfaces §2/e2e 依赖）但
      //   回带 `details`（逐条 buildPanel 原因）+ 记 warn，使失败可解释、不再"含混"。
      log.warn('store', 'store.snapshot.missing', '对手/我方快照无法实例化 → 本场 invalid（不记账）', {
        playerId: o.playerId, opponentPlayerId: found.opponent.playerId, code: 'snapshot_invalid',
        reason: 'instantiation_diverged',
        errors: r.errors === undefined ? null : r.errors.slice(0, 3),
      });
      return {
        status: 409,
        code: 'no_opponent',
        message: '抽到的对手快照无法实例化（本场不成立）',
        details: (r.errors || []).slice(0, 5).map((e) => ({
          path: e.path === undefined ? e.where : e.path, where: e.where === undefined ? e.path : e.where,
          code: e.code, message: e.message, side: 'p1',
        })),
      };
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
    // 分数突变告警（§8.5：只记 warn，不阻断）——判据 = 单场真实理论上界（加分 ≤ kBase、扣分 ≤ kMax，P1-3）
    const maxDelta = maxSingleMatchDelta(config);
    if (Math.abs(selfDelta) > maxDelta || Math.abs(opponentDelta) > maxDelta) {
      log.warn('store', 'store.abuse.suspect', `积分突变超出单场理论上限（Δ1=${selfDelta} Δ2=${opponentDelta}）`, {
        playerId: o.playerId, opponentPlayerId: found.opponent.playerId, battleId,
        deltaP1: selfDelta, deltaP2: opponentDelta,
      });
    }
    log.info('ranked', 'quick.match', `快速对战匹配成功（窗口 ${found.window}，软冷却权重 ${Math.round((found.weight || 0) * 100)}%）`, {
      playerId: o.playerId, opponentPublicId: found.opponent.publicId, opponents: found.candidateCount,
      poolSize: poolInfo.poolSize, skipped: poolInfo.skipped, window: found.window,
      recoveryHours: found.recoveryHours, weight: found.weight, debug: debugBots.enabled, at: peek(),
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
        // D-168：`relaxed` 随 strict/relaxed 双池废止；改回带软冷却信息（权重与回满小时数）
        opponentWeight: found.weight,
        recoveryHours: found.recoveryHours,
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
        // D-167：**内联全量战斗过程**（画面数据 + 双方 aiTrace；不含引擎日志 events）。
        //   幂等重放（同 seed + 同双方快照 → 已存在记录）时 `r` 仍是本次真实执行结果，故帧照常回带。
        frames: Array.isArray(r.frames) ? r.frames : null,
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
  matchWindowConfig,
  maxSingleMatchDelta,
  // 对外便捷入口：等价于 `const qm = createQuickMatch({store}); await qm.run({playerId, seed})`
  runQuickMatch: (options, input) => createQuickMatch(options).run(input),
  MAX_LIMIT,
  SEED_MAX,
};
