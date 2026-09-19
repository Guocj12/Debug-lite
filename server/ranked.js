'use strict';
/* server/ranked.js —— 排位系统（P5 B24/B25 → P7-3/B31 档案驱动改造）
 * 契约：docs/interfaces.md §1 `server/ranked.js` + §2 `POST /api/v1/ranked/run`；docs/systems/10-ranked.md §4.3/§4.4；
 *      docs/systems/11-account-store.md §7（异步排位）/§7.2（对手池）/§7.3（攻守差异）/§7.7（部分成功语义）。
 *
 * 🚫 无占位 bot（D-152 / plan-p7-playable §P7-3）：匹配池**只能**由真实玩家档案构成。
 *    - 池 = `store.index.byTier(tier)` ∩ 有可用快照 ∩ 未封禁 ∩ 在池内（服务端抽池，客户端不得自选对手 D-136）；
 *    - 候选不足 N 场 → **少打几场并如实回报 `shortfall`**（不注入 bot 充数）；
 *    - 内置 bot 补齐逻辑已删除；仅保留 `DL_DEBUG_BOTS=1` 的**显式调试开关**（默认关闭），
 *      且开启时响应 `debugBots:true` + 事件 `ranked.pool` 标注 `debug:true`（见 inspectDebugBots）。
 *
 * 结算（D-132/D-134）：发起者同步结算；每场经 `store.settleBattle` 先写 journal（battle.recorded）再 apply **双方**档案：
 *    - 发起者 = attacker（stats.attack/recent/unread.attack）；
 *    - 被抽取方 = defender（stats.defense/recent/unread.defense/drawnCount），**段位与积分不变**（离线只记战绩）。
 *
 * 事件（interfaces.md §6，通道 ranked）：ranked.snapshot(debug) / ranked.match(info) / ranked.pool(debug) /
 *      ranked.promote(info)。（`quick.*` 属 quickmatch.js。）
 */
const { nullLogger } = require('../shared/log.js');
const { createRng } = require('./core/rng.js');
const crypto = require('node:crypto');
const loadout = require('./loadout.js');
const battle = require('./battle.js'); // buildPlayer 复用（面板聚合 → 战斗运行时）
const runner = require('./runner.js'); // projectSnapshot
const runtime = require('./ai/runtime.js');
const engine = require('./core/engine.js');
const archiveMod = require('./store/archive.js');
const ledger = require('./store/ledger.js');

const TIERS = Object.freeze(['common', 'rare', 'epic', 'legendary', 'mythic']);
const X_PROMOTE = 6; // D-122：wins > 6（10 场胜 7）晋升
const DEFAULT_BATCH_SIZE = 10; // §7.2：一轮排位批次 10 场（rating-config.batchSize 可覆盖）
const REQUESTED_MIN = 1;
const REQUESTED_MAX = 10;
const SEED_MAX = 0x7fffffff;
const COOLDOWN_RELAX_MULT = 3; // D-136：24h 候选不足 → 放宽到 72h（= 3 × 24h）
const RAW_SNAPSHOT_FIELD = ['load', 'out'].join(''); // §5.4 快照正文键（带 loadout 的快照才可实例化对手）

/* ---------- 快照：出战配置的不可变深拷贝（T-RK-5） ---------- */
function takeSnapshot(loadoutObj, L) {
  const snap = JSON.parse(JSON.stringify(loadoutObj));
  (function freeze(n) {
    if (n && typeof n === 'object') {
      Object.freeze(n);
      for (const k of Object.keys(n)) freeze(n[k]);
    }
  })(snap);
  L && L.debug('ranked', 'ranked.snapshot', '快照已生成（深冻结）', { frozen: true });
  return snap;
}

/* ---------- 默认出战配置构造（§5.3 注册即默认配置：role_bal + 3 个 common 技能 + 兜底 AI）
 * 说明：本函数**不是**"占位 bot 补齐"，而是"新玩家默认配置"的构造器（account.defaultLoadout 用它）。
 * B24 审查 P1-1：common 技能模板实际仅 2 个 —— 循环取满 3 槽（validateLoadout 不查 templateId 唯一）。
 ---------- */
function buildDefaultLoadout() {
  const ROLE = require('./data/role-templates.json').roleTemplates.find((r) => r.id === 'role_bal');
  const COMMON_SKILLS = require('./data/skill-templates.json').skillTemplates
    .filter((t) => !t.unlockTier || t.unlockTier === 'common');
  const skillItems = [];
  for (let i = 0; i < 3; i++) {
    const t = COMMON_SKILLS[i % COMMON_SKILLS.length]; // 循环取满 3 槽（技能实例允许同模板二号位）
    skillItems.push({
      uid: `bot_skill${i + 1}`, kind: 'skill', templateId: t.id, quality: 'common', slotCount: 0, slots: [],
      params: { multiplier: 1, cost: { hp: t.baseCost.hp, mp: t.baseCost.mp, sp: t.baseCost.sp }, cooldown: t.cooldown, bulletLevel: t.bulletLevel },
      unlockTier: t.unlockTier || 'common',
    });
  }
  return {
    role: {
      uid: 'bot_role', kind: 'role', templateId: ROLE.id, quality: 'common', slotCount: 0, slots: [],
      stats: { hp: ROLE.baseStats.hp, atk: ROLE.baseStats.atk, def: ROLE.baseStats.def, sp: ROLE.baseStats.sp, mp: ROLE.baseStats.mp },
      regen: ROLE.regen, pluginPoints: ROLE.pluginPoints || 3, unlockTier: 'common',
    },
    skills: skillItems,
    ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } },
  };
}

/* ---------- 单场离线对战：p1=发起者快照 vs p2=对手快照 → {winner, ticks}（平局 winner='draw'） ---------- */
function battleOne(mine, opponent, wh, tier, seed) {
  const b1 = battle.buildPlayer('p1', mine, wh, tier);
  if (!b1.ok) return { winner: 'draw', ticks: 0, invalid: true, errors: b1.errors };
  const b2 = battle.buildPlayer('p2', opponent, wh, tier);
  if (!b2.ok) {
    runtime.destroyContext(b1.ctx);
    return { winner: 'draw', ticks: 0, invalid: true, errors: b2.errors };
  }
  const logger = require('../shared/log.js').createLogger({ level: 'silent' });
  const b = engine.createBattle(undefined, { seed, players: { p1: b1.player, p2: b2.player }, logger });
  const driver = (bp) => (state) => {
    const r = runtime.resume(bp.ctx, runner.projectSnapshot(state, bp.player.owner), state.rng.deriveStream(state.tick, 'ai'));
    return r.action;
  };
  const res = b.runFull({ actions: { p1: driver(b1), p2: driver(b2) } });
  runtime.destroyContext(b1.ctx);
  runtime.destroyContext(b2.ctx);
  return { winner: res.winner || 'draw', ticks: res.ticks };
}

/* ---------- 纯工具 ---------- */

function batchSizeOf(ratingConfig) {
  const cfg = ratingConfig || {};
  return Number.isInteger(cfg.batchSize) && cfg.batchSize >= REQUESTED_MIN && cfg.batchSize <= REQUESTED_MAX
    ? cfg.batchSize : DEFAULT_BATCH_SIZE;
}

// D-136 去重窗口小时数：权威在 `rating-config.json`（§8.3）；service-config.pool 为配套默认值的兜底
function cooldownHoursOf(config, ratingConfig) {
  const rating = ratingConfig || {};
  const pool = (config && config.pool) || {};
  if (Number.isInteger(rating.opponentCooldownHours)) return rating.opponentCooldownHours;
  if (Number.isInteger(pool.opponentCooldownHours)) return pool.opponentCooldownHours;
  return 0;
}

// §5.4：只有带**正文**（含 loadout）的快照才能实例化对手（configHash 仅存在于正文里）
function isUsableSnapshot(snapshot) {
  return !!(snapshot && snapshot.hash && snapshot[RAW_SNAPSHOT_FIELD] && snapshot.configHash);
}

function realPlayerIdOf(entry) {
  const playerId = entry && (entry.playerId || (entry.p1 && entry.p1.playerId));
  return typeof playerId === 'string' && archiveMod.PLAYER_ID_RE.test(playerId) ? playerId : null;
}

// 出战配置"内容键"：只取 loadout 三要素，忽略 playerId/溯源等附加元数据
// （旧口径用整对象 JSON 深等，任何附加字段都会让"排除自己"失效 —— P7-3 修正）
function loadoutKey(ld) {
  if (!ld || typeof ld !== 'object') return null;
  return JSON.stringify({ role: ld.role === undefined ? null : ld.role, skills: ld.skills === undefined ? null : ld.skills, ai: ld.ai === undefined ? null : ld.ai });
}

// 快照读取 + 正文自身 hash 校验：`store.snapshot.get` 是内容寻址读取，若磁盘正文与请求 hash 不一致
// （人为篡改/索引漂移）则视为"快照缺失"，绝不拿别的正文顶替（§7.7 快照缺失 → 该对手跳过）。
async function loadSnapshotOf(store, hash) {
  const snapshot = hash ? await store.snapshot.get(hash) : null;
  if (!snapshot || snapshot.hash !== hash) return null;
  return snapshot;
}

// 服务端抽池（D-132/D-136）：byTier ∩ 有可用快照 ∩ 未封禁 ∩ 在池内 ∩ 非自己
// 返回 { candidates:[{playerId,entry}], unusable:[playerId] }——`unusable` 是"档案在池内但快照不可用"
async function candidatesOf(store, tier, excludeId, L) {
  const ids = store.index.byTier(tier) || [];
  const candidates = [];
  const unusable = [];
  let banned = 0;
  let outOfPool = 0;
  for (const playerId of ids) {
    if (playerId === excludeId) continue;
    const entry = store.index.get(playerId);
    if (!entry) continue;
    if (entry.banned) { banned += 1; continue; }
    if (!entry.inPool) { outOfPool += 1; continue; }
    const snapshot = await loadSnapshotOf(store, entry.activeSnapshotHash);
    if (!isUsableSnapshot(snapshot)) { unusable.push(playerId); continue; }
    candidates.push({ playerId, entry });
  }
  if (unusable.length > 0) {
    L && L.warn('store', 'store.snapshot.missing',
      `同段位 ${tier} 有 ${unusable.length} 个候选快照缺失/不可用（已跳过，不占场次）`,
      { tier, count: unusable.length, sample: unusable.slice(0, 3) });
  }
  return { candidates, unusable, banned, outOfPool, poolSize: ids.length };
}

// D-136 去重窗口（裁定口径）：24h 是**硬底线**（间隔 < 24h 的对手任何池都不接纳），72h 是**偏好间隔**。
//   strict  = 间隔 ≥ 72h 的新鲜对手（优先抽）
//   relaxed = 24h ≤ 间隔 < 72h（仅当 strict 不足 min(requested, 可用) 时启用，并置 relaxed:true）
function splitByCooldown(candidates, foeArchive, cooldownHours, relaxHours, at) {
  const strict = [];
  const relaxed = [];
  for (const c of candidates) {
    if (!archiveMod.opponentCooldownOk(foeArchive, c.playerId, cooldownHours, at)) continue; // <24h：硬底线，两池都不收
    if (archiveMod.opponentCooldownOk(foeArchive, c.playerId, relaxHours, at)) strict.push(c);
    else relaxed.push(c);
  }
  return { strict, relaxed };
}

function shuffleByRng(list, rng) {
  const arr = list.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function logPool(L, data) {
  L && L.debug('ranked', 'ranked.pool',
    `抽池 tier=${data.tier} 池=${data.poolSize} 候选=${data.candidates} 抽中=${data.drawn} 缺口=${data.shortfall}${data.relaxed ? '（放宽窗口）' : ''}`,
    data);
}

let batchSeq = 0; // 批次序号（仅用于让 batchId 在同一毫秒 + 同 seed 下仍唯一）

/* ---------- 档案驱动排位（P7-3 主路径） ---------- */

async function runFromStore(o, deps) {
  const { store, L, nowFn, ratingConfig } = deps;
  const tier = (o.archive.progress && o.archive.progress.tier) || 'common';
  const seed = o.seed;
  const requested = batchSizeOf(ratingConfig);
  const cooldownHours = cooldownHoursOf(store.config, ratingConfig);
  const relaxHours = cooldownHours * COOLDOWN_RELAX_MULT;
  const at = nowFn();

  const pool = await candidatesOf(store, tier, o.playerId, L);
  const split = splitByCooldown(pool.candidates, o.archive, cooldownHours, relaxHours, at);
  // D-136 口径：同一对手 24h 去重；**候选不足**（严格窗口凑不满本轮场次）时放宽到 72h。
  //   `relaxed:true` ⟺ 本轮**实际启用**了放宽窗口（有"仅放宽窗口可用"的对手被加入抽取池）；
  //   严格窗口已够时不抽任何放宽候选，也就不会置位（避免"标了 relaxed 其实没用"）。
  const usableCount = split.strict.length + split.relaxed.length;
  const relaxed = split.relaxed.length > 0 && split.strict.length < Math.min(requested, usableCount);
  const usable = relaxed ? split.strict.concat(split.relaxed) : split.strict;
  const rng = createRng(seed).deriveStream(0, 'ranked');
  const ordered = shuffleByRng(usable, rng);
  const drawn = ordered.slice(0, Math.min(requested, ordered.length));
  const shortfall = requested - drawn.length;
  const batchId = `bt_${ledger.battleIdOf({
    batchId: `${o.playerId}|${seed}|${at}|${++batchSeq}`, matchIndex: 0, seed,
    p1SnapshotHash: o.snapshotHash, p2SnapshotHash: '',
  }).slice(2)}`;

  logPool(L, {
    tier, seed, poolSize: pool.poolSize, candidates: pool.candidates.length,
    cooldown: cooldownHours, relaxHours, relaxed, drawn: drawn.length, shortfall,
    unusable: pool.unusable.length, banned: pool.banned, outOfPool: pool.outOfPool,
    debug: deps.debugBots === true,
  });

  const results = [];
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let invalids = 0;
  for (let i = 0; i < drawn.length; i++) {
    const foe = drawn[i];
    const matchIndex = i + 1;
    const matchSeed = rng.int(1, SEED_MAX);
    const foeSnapshot = await loadSnapshotOf(store, foe.entry.activeSnapshotHash);
    if (!isUsableSnapshot(foeSnapshot)) {
      invalids += 1;
      results.push({ match: matchIndex, opponentPlayerId: foe.playerId, opponentPublicId: foe.entry.publicId, winner: 'invalid', ticks: 0, battleId: null });
      L && L.warn('store', 'store.snapshot.missing', `match ${matchIndex} 对手快照在结算前失效（跳过，不进 journal）`, {
        match: matchIndex, opponentPlayerId: foe.playerId, hash: foe.entry.activeSnapshotHash,
      });
      continue;
    }
    const r = o.runBattle
      ? o.runBattle({ p1: o.loadout, p2: foeSnapshot[RAW_SNAPSHOT_FIELD], tier, seed: matchSeed, warehouse: null })
      : battleOne(o.loadout, foeSnapshot[RAW_SNAPSHOT_FIELD], null, tier, matchSeed);
    if (r.invalid) {
      invalids += 1;
      results.push({ match: matchIndex, opponentPlayerId: foe.playerId, opponentPublicId: foe.entry.publicId, winner: 'invalid', ticks: 0, battleId: null });
      L && L.warn('ranked', 'ranked.match', `match ${matchIndex} invalid（对手快照无法实例化，不进 journal）`, {
        match: matchIndex, opponentPlayerId: foe.playerId, code: 'snapshot_invalid',
      });
      continue;
    }
    const winner = r.winner === 'p1' ? 'p1' : r.winner === 'p2' ? 'p2' : 'draw';
    if (winner === 'p1') wins += 1;
    else if (winner === 'draw') draws += 1;
    else losses += 1;
    // 双向记账（D-132/D-134）：先 journal（一次落盘即成立）→ apply 发起者（attacker）与被抽取方（defender）
    const settled = await store.settleBattle({
      mode: 'ranked',
      batchId,
      matchIndex,
      seed: matchSeed,
      at,
      p1: {
        playerId: o.playerId,
        publicId: o.archive.publicId,
        role: 'attacker',
        snapshotHash: o.snapshotHash,
        configHash: o.configHash,
        pointsBefore: o.archive.rating.points,
        pointsAfter: o.archive.rating.points, // 排位不改积分（D-133 双轨）
        result: winner === 'p1' ? 'win' : winner === 'p2' ? 'loss' : 'draw',
        tierBefore: tier,
        tierAfter: tier, // 段位变化只由 ranked.promoted 驱动（D-122/D-132）
      },
      p2: {
        playerId: foe.playerId,
        publicId: foe.entry.publicId,
        role: 'defender',
        snapshotHash: foe.entry.activeSnapshotHash,
        configHash: foeSnapshot.configHash,
        pointsBefore: foe.entry.points,
        pointsAfter: foe.entry.points,
        result: winner === 'p2' ? 'win' : winner === 'p1' ? 'loss' : 'draw',
        tierBefore: foe.entry.tier,
        tierAfter: foe.entry.tier,
      },
      verdict: { winner, reason: null, ticks: r.ticks },
      versions: { engine: store.versions.engine, data: store.versions.data },
    });
    results.push({
      match: matchIndex,
      opponentPlayerId: foe.playerId,
      opponentPublicId: foe.entry.publicId,
      winner,
      ticks: r.ticks,
      battleId: settled.record ? settled.record.battleId : null,
      duplicate: settled.duplicate === true,
    });
    L && L.info('ranked', 'ranked.match', `match ${matchIndex}: ${winner}（${r.ticks} tick）`, {
      match: matchIndex, winner, ticks: r.ticks, opponentPublicId: foe.entry.publicId,
      battleId: settled.record ? settled.record.battleId : null, mode: 'ranked',
    });
  }

  // 批次记录 + 晋升判定（wins > 6 → tier+1；D-122/D-132：只有发起者会晋升）
  const batchRecord = await store.append(ledger.buildBatchRecord({
    playerId: o.playerId, batchId, tier, seed, opponentCount: drawn.length, at,
  }));
  await store.applyRecord(batchRecord); // 只涉及发起者（A/B 类之外的"批次计数"写）
  const promotion = ledger.promoteAfterBatch({ tier, wins, config: ratingConfig });
  const promoted = promotion.promoted && shortfall === 0; // 缺场批次不判晋升（未打满 10 场不结段位）
  if (promoted) {
    const promoteRecord = await store.append(ledger.buildPromoteRecord({
      playerId: o.playerId, batchId, tierBefore: tier, tierAfter: promotion.tierAfter, at,
    }));
    await store.applyRecord(promoteRecord);
    L && L.info('ranked', 'ranked.promote', `${tier} → ${promotion.tierAfter}（wins=${wins}）`, {
      from: tier, to: promotion.tierAfter, wins, batchId,
    });
  }
  return {
    status: 200,
    data: {
      batchId, seed, tier,
      requested, matches: results.length, shortfall,
      wins, draws, losses, invalids,
      relaxed,
      promoted,
      tierAfter: promoted ? promotion.tierAfter : tier,
      reward: tierReward(promoted ? promotion.tierAfter : tier),
      opponentsDrawn: drawn.map((c) => c.playerId),
      results,
    },
  };
}

/* ---------- 排位对战入口 ---------- */

/**
 * runRankedBattle(opts, L)
 *   档案驱动（store 模式，P7-4 生产路径）：
 *     opts = { store, playerId, seed?, requested? } —— **不再接受 loadout/pool/tier/warehouse**
 *   兼容（无 store + 显式传入 loadout/pool，D-123 旧口径；池必须由调用方保证是真实玩家档案快照）
 *     opts = { loadout, warehouse?, pool?, seed?, tier? }
 *   返回 { status, data } 或 { status, code, message, details? }
 */
function runRankedBattle(opts, L, deps) {
  const d = deps || {};
  const store = opts && opts.store ? opts.store : d.store;
  // 日志器优先级：显式 L → 注入 deps.logger → store 的 logger → nullLogger
  // （模块级 `runRankedBattle(opts)` 直接调用时不能静默吞事件：P7-4 走 `withLogger`）
  const log = L || d.logger || (store && store.logger) || nullLogger;
  if (store) return runArchiveDriven(opts, log, { ...d, store });
  return runStateless(opts, log, d);
}

async function runArchiveDriven(opts, L, deps) {
  const { store } = deps;
  const log = L || nullLogger;
  const nowFn = typeof deps.now === 'function' ? deps.now
    : (store && typeof store.now === 'function' ? store.now : () => Date.now());
  const ratingConfig = deps.ratingConfig || store.ratingConfig || {};
  const playerId = opts.playerId;
  if (typeof playerId !== 'string' || playerId === '') {
    return { status: 400, code: 'bad_request', message: '需要 playerId（鉴权中间件注入，P7-4）' };
  }
  if (opts.pool !== undefined) {
    // D-136：服务端抽池，禁止客户端自选对手
    return { status: 400, code: 'pool_forbidden', message: '排位对手由服务端抽取（D-132/D-136），不接受 pool 入参' };
  }
  const seed = opts.seed === undefined || opts.seed === null ? crypto.randomInt(1, SEED_MAX) : opts.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1 || seed > SEED_MAX) {
    return { status: 400, code: 'bad_seed', message: `非法 seed ${seed}` };
  }
  let archive;
  try {
    archive = await store.loadArchive(playerId);
  } catch (err) {
    return { status: 500, code: 'store_internal', message: `读取档案失败：${err && err.message ? err.message : err}` };
  }
  if (!archive) return { status: 404, code: 'store_not_found', message: `档案 ${playerId} 不存在` };
  if (archive.flags && archive.flags.banned) return { status: 403, code: 'banned', message: '账号已被封禁' };
  const active = archiveMod.activeSlot(archive);
  if (!active || !active.snapshot || !active.snapshot.hash) {
    return { status: 409, code: 'no_active_config', message: '出战配置缺失/快照缺失（不变量破损）' };
  }
  const snapshot = await loadSnapshotOf(store, active.snapshot.hash);
  if (!isUsableSnapshot(snapshot)) {
    return { status: 409, code: 'no_active_config', message: `出战快照正文缺失/不一致 ${active.snapshot.hash}（不变量破损）` };
  }
  // 出战配置结构与门控复查（§7.4：不依赖客户端仓库，引用完整性在保存配置时已校验）
  const v = loadout.validateLoadout(snapshot[RAW_SNAPSHOT_FIELD], { warehouse: null, tier: archive.progress.tier });
  if (!v.ok) return { status: 409, code: 'loadout_invalid', details: v.errors, message: '出战快照不合法' };
  // DL_DEBUG_BOTS=1：仅显式调试开关（默认关闭）——只补齐**调试 bot 档案**，绝不伪造对局
  const debug = inspectDebugBots(deps.env);
  if (debug.enabled) {
    log.warn('ranked', 'ranked.pool', 'DL_DEBUG_BOTS=1：调试开关已启用（响应/日志均标注），生产环境禁止', {
      debug: true, playerId,
    });
  }
  return runFromStore({
    archive, playerId, seed,
    snapshotHash: active.snapshot.hash,
    configHash: active.snapshot.configHash,
    loadout: snapshot[RAW_SNAPSHOT_FIELD],
    runBattle: deps.runBattle,
  }, { store, L: log, nowFn, ratingConfig, debugBots: debug.enabled });
}

// 显式调试开关（默认关闭）：`DL_DEBUG_BOTS=1`。
// 🚫 这**不是**"池不足拿 bot 凑满 10 场"：调试 bot 必须由 admin.injectDebugBots 以**真实档案**注入注册表，
//    抽池仍走 byTier 索引；池不足依旧如实 `shortfall`。
function inspectDebugBots(env) {
  const source = env === undefined ? process.env : env;
  const raw = source ? source.DL_DEBUG_BOTS : undefined;
  return { enabled: raw === '1' || raw === 'true', raw: raw === undefined ? null : String(raw) };
}

/* ---------- 兼容路径（无 store：P5 无状态口径，池由调用方传入） ---------- */

// 旧调用方（gate/CLI/API 冒烟）仍走这里：不再有 bot 补齐；池不足如实报 shortfall。
function runStateless(opts, L, deps) {
  const tier = opts.tier || 'mythic';
  const log = L || nullLogger;
  if (!opts.loadout || typeof opts.loadout !== 'object') {
    return { status: 409, code: 'no_loadout', message: '缺少出战配置（loadout）' };
  }
  const v = loadout.validateLoadout(opts.loadout, { warehouse: opts.warehouse, tier });
  if (!v.ok) return { status: 409, code: 'loadout_invalid', details: v.errors, message: '出战配置不合法' };
  const seed = opts.seed === undefined || opts.seed === null ? crypto.randomInt(1, SEED_MAX) : opts.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1 || seed > SEED_MAX) {
    return { status: 400, code: 'bad_seed', message: `非法 seed ${seed}` };
  }
  if (opts.pool !== undefined && !Array.isArray(opts.pool)) {
    return { status: 400, code: 'bad_pool', message: 'pool 必须是 loadout 数组' };
  }
  const mineKey = loadoutKey(opts.loadout);
  const minePlayerId = realPlayerIdOf(opts);
  const pool = (Array.isArray(opts.pool) ? opts.pool : [])
    .filter((ld) => ld && typeof ld === 'object')
    .filter((ld) => (minePlayerId !== null ? realPlayerIdOf(ld) !== minePlayerId : true))
    .filter((ld) => loadoutKey(ld) !== mineKey);
  const requested = batchSizeOf(deps.ratingConfig);
  const rng = createRng(seed).deriveStream(0, 'ranked');
  const acc = shuffleByRng(pool, rng);
  const matches = acc.slice(0, Math.min(requested, acc.length));
  const shortfall = requested - matches.length; // 🚫 不再用 BOT_LD 补齐：池空 → requested 场全缺
  const mineSnap = takeSnapshot(opts.loadout, L);
  const results = [];
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let invalids = 0;
  for (let i = 0; i < matches.length; i++) {
    const matchSeed = rng.int(1, SEED_MAX);
    const r = battleOne(mineSnap, matches[i], opts.warehouse, tier, matchSeed);
    if (r.invalid) {
      invalids += 1;
      results.push({ match: i + 1, winner: 'invalid', ticks: 0, opponentPlayerId: realPlayerIdOf(matches[i]) });
    } else if (r.winner === 'p1') {
      wins += 1;
      results.push({ match: i + 1, winner: r.winner, ticks: r.ticks, opponentPlayerId: realPlayerIdOf(matches[i]) });
    } else if (r.winner === 'draw') {
      draws += 1;
      results.push({ match: i + 1, winner: r.winner, ticks: r.ticks, opponentPlayerId: realPlayerIdOf(matches[i]) });
    } else {
      losses += 1;
      results.push({ match: i + 1, winner: r.winner, ticks: r.ticks, opponentPlayerId: realPlayerIdOf(matches[i]) });
    }
    log.info('ranked', 'ranked.match', `match ${i + 1}: ${r.winner}（${r.ticks} tick）`, { match: i + 1, winner: r.winner, ticks: r.ticks });
  }
  log.debug('ranked', 'ranked.pool', `无 store 兼容路径：池=${pool.length} 抽中=${matches.length} 缺口=${shortfall}`, {
    tier, seed, poolSize: pool.length, candidates: pool.length, drawn: matches.length, shortfall, debug: false,
  });
  return {
    status: 200,
    data: {
      tier, seed,
      requested, matches: results.length, shortfall,
      wins, draws, losses, invalids,
      promoted: promotedAt(tier, wins),
      results,
    },
  };
}

/* ---------- B25：段位奖励与晋升 ---------- */

// 段位 → 品质上限（D-122/RK-5a..e：段位序号即品质上限；common→common … mythic→mythic）
function tierReward(tier) {
  const idx = TIERS.indexOf(tier);
  return idx === -1 ? null : TIERS[idx];
}

// 晋升判定（D-122：x=6，wins > 6 即 10 场胜 7 晋升；最高段位不再晋升 → 409 already_max）
function promotedAt(tier, wins) {
  return wins > X_PROMOTE && TIERS.indexOf(tier) < TIERS.length - 1;
}

function promote(tier, wins, L) {
  if (tier === undefined || !TIERS.includes(tier)) {
    return { status: 400, code: 'bad_tier', message: `非法段位 ${tier}（可选: ${TIERS.join('/')}）` };
  }
  if (typeof wins !== 'number' || !Number.isInteger(wins) || wins < 0 || wins > DEFAULT_BATCH_SIZE) {
    return { status: 400, code: 'bad_wins', message: `非法 wins ${wins}（必须是非负整数且 ≤ ${DEFAULT_BATCH_SIZE}，P2-2 上限）` };
  }
  const idx = TIERS.indexOf(tier);
  const willPromote = wins > X_PROMOTE;
  if (!willPromote) {
    return { status: 200, data: { tier, promoted: false, reward: tierReward(tier), wins } };
  }
  if (idx === TIERS.length - 1) {
    L && L.warn('ranked', 'ranked.promote', `最高段位不再晋升: ${tier}`, { tier, wins });
    return { status: 409, code: 'already_max', message: `${tier} 已是最高段位` };
  }
  const next = TIERS[idx + 1];
  L && L.info('ranked', 'ranked.promote', `${tier} → ${next}（wins=${wins}）`, { from: tier, to: next, wins });
  return { status: 200, data: { tier: next, promoted: true, reward: tierReward(next), wins } };
}

function makeRanked(logger, options) {
  const L = logger || nullLogger;
  const deps = options || {};
  return {
    takeSnapshot: (ld) => takeSnapshot(ld, L),
    runRankedBattle: (opts) => runRankedBattle(opts, L, deps),
    promote: (tier, wins) => promote(tier, wins, L),
    tierReward,
  };
}

module.exports = Object.assign(makeRanked(), {
  withLogger: (logger, options) => makeRanked(logger, options),
  takeSnapshot,
  runRankedBattle,
  promote,
  tierReward,
  promotedAt,
  // 命名沿用（account.defaultLoadout / scripts/play.js 依赖；语义 = 新玩家默认出战配置，非"占位 bot 补齐"）
  buildDefaultLoadout,
  buildBotLoadout: buildDefaultLoadout,
  X_PROMOTE,
  TIERS,
  DEFAULT_BATCH_SIZE,
  COOLDOWN_RELAX_MULT,
  // P7-3 内部纯函数（快速对战/管理端与测试复用）
  battleOne,
  inspectDebugBots,
  batchSizeOf,
  cooldownHoursOf,
  isUsableSnapshot,
  loadSnapshotOf,
  loadoutKey,
  candidatesOf,
  RAW_SNAPSHOT_FIELD,
});
