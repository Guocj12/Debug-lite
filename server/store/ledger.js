'use strict';
/* server/store/ledger.js —— 积分/排位记账的存储原语（D-133 非对称 Elo、D-132 攻守差异、D-135 回放引用）
 * 权威：docs/systems/11-account-store.md §8.3（公式与性质）、§8.4（双向结算/bot 例外）、§7.3（攻守差异）、
 *      §9.1（battleId 内容寻址）、§6.2（battle.recorded 记录格式）
 * 定位：本模块是**纯函数 + 记录构造器**；真正的落盘由 adapter 的 settleBattle()（append journal → apply 双方档案）
 *       完成。后续 B31/B32 的 ranked.js/quickmatch.js 只负责抽人与跑引擎，记账统一走这里，保证 json/sqlite 可替换。
 */
const { StoreError } = require('./errors.js');
const { deepClone, shortDigest } = require('./canonical.js');
const { RECORD_VERSION, TIERS, isTier, nextTier } = require('./archive.js');

function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

// rounding: "half_up"（§8.3；负数按绝对值四舍五入后回符号）
function roundHalfUp(value) {
  const abs = Math.abs(value);
  const rounded = Math.floor(abs + 0.5);
  return value < 0 ? -rounded : rounded;
}

function roundBy(value, rounding) {
  return rounding === 'half_up' || rounding === undefined ? roundHalfUp(value) : Math.round(value);
}

function ratingConfigOf(config) {
  return (config && config.rating) || config || {};
}

// E_self = 1 / (1 + 10 ^ ((R_opp - R_self) / scale))（§8.3）
function expectedScore(selfPoints, opponentPoints, config) {
  const cfg = ratingConfigOf(config);
  const scale = cfg.scale === undefined ? 400 : cfg.scale;
  return 1 / (1 + Math.pow(10, (opponentPoints - selfPoints) / scale));
}

// K_gain(R) = clamp(kBase * (1 - R/cap), kMin, kBase)
function gainFactor(points, config) {
  const cfg = ratingConfigOf(config);
  const cap = cfg.cap === undefined ? 3000 : cfg.cap;
  const kBase = cfg.kBase === undefined ? 32 : cfg.kBase;
  const kMin = cfg.kMin === undefined ? 8 : cfg.kMin;
  return clamp(kBase * (1 - points / cap), kMin, kBase);
}

// K_loss(R) = clamp(kBase * (1 + R/cap), kBase, kMax)
function lossFactor(points, config) {
  const cfg = ratingConfigOf(config);
  const cap = cfg.cap === undefined ? 3000 : cfg.cap;
  const kBase = cfg.kBase === undefined ? 32 : cfg.kBase;
  const kMax = cfg.kMax === undefined ? 64 : cfg.kMax;
  return clamp(kBase * (1 + points / cap), kBase, kMax);
}

// 单方 Δ（胜/负/平）；结果为 clamp(R + Δ, 0, cap)（§8.3）
function ratingDelta(input) {
  const o = input || {};
  const cfg = ratingConfigOf(o.config);
  const cap = cfg.cap === undefined ? 3000 : cfg.cap;
  const drawFactor = cfg.drawFactor === undefined ? 0.5 : cfg.drawFactor;
  const rounding = cfg.rounding || 'half_up';
  const points = Number.isInteger(o.points) ? o.points : 0;
  const opponentPoints = Number.isInteger(o.opponentPoints) ? o.opponentPoints : 0;
  const expected = expectedScore(points, opponentPoints, cfg);
  let delta;
  let k;
  if (o.result === 'win') {
    k = gainFactor(points, cfg);
    delta = roundBy(k * (1 - expected), rounding);
  } else if (o.result === 'loss') {
    k = lossFactor(points, cfg);
    delta = -roundBy(k * expected, rounding);
  } else {
    k = cfg.kBase === undefined ? 32 : cfg.kBase;
    delta = roundBy(drawFactor * k * (0.5 - expected), rounding);
  }
  return { delta: delta === 0 ? 0 : delta, expected, k, pointsAfter: clamp(points + delta, 0, cap) };
}

// 一场快速对战的双向结算（非零和，D-133：Δ_self + Δ_opp ≠ 0 属有意设计）
function settleRating(input) {
  const o = input || {};
  const winner = o.winner === 'p1' || o.winner === 'p2' ? o.winner : 'draw';
  const p1Result = winner === 'p1' ? 'win' : winner === 'p2' ? 'loss' : 'draw';
  const p2Result = winner === 'p2' ? 'win' : winner === 'p1' ? 'loss' : 'draw';
  const p1 = { result: p1Result, ...ratingDelta({ points: o.p1Points, opponentPoints: o.p2Points, result: p1Result, config: o.config }) };
  const p2 = { result: p2Result, ...ratingDelta({ points: o.p2Points, opponentPoints: o.p1Points, result: p2Result, config: o.config }) };
  return {
    winner,
    p1: { pointsBefore: o.p1Points, ...p1 },
    p2: { pointsBefore: o.p2Points, ...p2 },
    zeroSum: p1.delta + p2.delta === 0,
  };
}

// 段位晋升（D-122：批次 10 场、胜 > 6 晋升；最高段位不晋升）
function promoteAfterBatch(input) {
  const o = input || {};
  const cfg = ratingConfigOf(o.config);
  const threshold = cfg.promoteWins === undefined ? 6 : cfg.promoteWins;
  const tier = isTier(o.tier) ? o.tier : 'common';
  const wins = Number.isInteger(o.wins) ? o.wins : 0;
  const promoted = wins > threshold && nextTier(tier) !== null;
  return { promoted, tierBefore: tier, tierAfter: promoted ? nextTier(tier) : tier, wins, threshold };
}

// battleId = 'b_' + sha256(batchId|matchIndex|seed|p1.snapshotHash|p2.snapshotHash)[0..16]（§9.1，天然幂等）
function battleIdOf(input) {
  const o = input || {};
  const key = [o.batchId === undefined || o.batchId === null ? '' : o.batchId,
    o.matchIndex === undefined || o.matchIndex === null ? '' : o.matchIndex,
    o.seed === undefined || o.seed === null ? '' : o.seed,
    o.p1SnapshotHash || '', o.p2SnapshotHash || ''].join('|');
  return `b_${shortDigest(key, 16)}`;
}

function sideOf(input, defaultSide) {
  const o = input || {};
  const out = {
    playerId: o.playerId,
    publicId: o.publicId === undefined ? null : o.publicId,
    side: o.side || defaultSide,
    role: o.role === 'defender' ? 'defender' : 'attacker',
    snapshotHash: o.snapshotHash === undefined ? null : o.snapshotHash,
    configHash: o.configHash === undefined ? null : o.configHash,
    pointsBefore: Number.isInteger(o.pointsBefore) ? o.pointsBefore : 0,
    pointsAfter: Number.isInteger(o.pointsAfter) ? o.pointsAfter : (Number.isInteger(o.pointsBefore) ? o.pointsBefore : 0),
    result: o.result === 'win' || o.result === 'loss' ? o.result : 'draw',
    tierBefore: isTier(o.tierBefore) ? o.tierBefore : 'common',
    tierAfter: isTier(o.tierAfter) ? o.tierAfter : (isTier(o.tierBefore) ? o.tierBefore : 'common'),
  };
  return out;
}

// battle.recorded 记录构造（§6.2；seq/at/v 由 journal 补；不含帧 —— D-135）
function buildBattleRecord(input) {
  const o = input || {};
  if (!o.p1 || !o.p1.playerId || !o.p2 || !o.p2.playerId) {
    throw new StoreError('bad_request', 'battle.recorded 需要双方 playerId');
  }
  const mode = o.mode === 'ranked' ? 'ranked' : 'quick';
  const p1 = sideOf({ side: 'p1', ...o.p1 }, 'p1');
  const p2 = sideOf({ side: 'p2', ...o.p2 }, 'p2');
  const verdict = {
    winner: o.verdict && (o.verdict.winner === 'p1' || o.verdict.winner === 'p2') ? o.verdict.winner : 'draw',
    reason: o.verdict && o.verdict.reason ? o.verdict.reason : null,
    ticks: o.verdict && Number.isInteger(o.verdict.ticks) ? o.verdict.ticks : null,
  };
  const versions = {
    engine: (o.versions && o.versions.engine) || '0.0.0',
    data: (o.versions && o.versions.data) || 'unknown',
    configHashP1: p1.configHash,
    configHashP2: p2.configHash,
  };
  return {
    type: 'battle.recorded',
    v: RECORD_VERSION,
    at: Number.isInteger(o.at) ? o.at : undefined,
    battleId: o.battleId || battleIdOf({
      batchId: o.batchId, matchIndex: o.matchIndex, seed: o.seed,
      p1SnapshotHash: p1.snapshotHash, p2SnapshotHash: p2.snapshotHash,
    }),
    mode,
    batchId: o.batchId === undefined ? null : o.batchId,
    matchIndex: o.matchIndex === undefined ? null : o.matchIndex,
    seed: Number.isInteger(o.seed) ? o.seed : null,
    p1,
    p2,
    verdict,
    versions,
    replay: o.replay === undefined
      ? { from: '1', to: verdict.ticks === null ? null : String(verdict.ticks), phase: 'idle' }
      : deepClone(o.replay),
  };
}

// 单玩家记录构造器（§6.2 表：账号/昵称/池/配置/排位/bot）
function buildAccountRecord(input) {
  const o = input || {};
  return {
    type: 'account.created', v: RECORD_VERSION, at: o.at,
    playerId: o.playerId, publicId: o.publicId, nickname: o.nickname,
    auth: deepClone(o.auth), createdAt: o.createdAt === undefined ? o.at : o.createdAt,
    tier: isTier(o.tier) ? o.tier : undefined,
    points: Number.isInteger(o.points) ? o.points : undefined,
    flags: o.flags ? deepClone(o.flags) : undefined,
    slot: o.slot ? deepClone(o.slot) : undefined,
  };
}

function buildBotRecord(input) {
  const o = input || {};
  return {
    type: 'admin.bot.injected', v: RECORD_VERSION, at: o.at,
    playerId: o.playerId, publicId: o.publicId,
    nickname: o.nickname === undefined ? `bot:${o.botKey || (o.publicId || o.playerId)}` : o.nickname,
    botKey: o.botKey === undefined ? null : o.botKey,
    tier: isTier(o.tier) ? o.tier : 'common',
    points: Number.isInteger(o.points) ? o.points : 0,
    createdAt: o.createdAt === undefined ? o.at : o.createdAt,
    flags: { isBot: true, ...(o.flags || {}) },
    slot: o.slot ? deepClone(o.slot) : undefined,
  };
}

function buildPasswordRecord(input) {
  const o = input || {};
  return { type: 'account.password.changed', v: RECORD_VERSION, at: o.at, playerId: o.playerId, auth: deepClone(o.auth) };
}

function buildBanRecord(input) {
  const o = input || {};
  return {
    type: o.banned === false ? 'account.unbanned' : 'account.banned',
    v: RECORD_VERSION, at: o.at, playerId: o.playerId,
    reason: o.reason === undefined ? null : o.reason,
  };
}

function buildNicknameRecord(input) {
  const o = input || {};
  return { type: 'player.nickname.changed', v: RECORD_VERSION, at: o.at, playerId: o.playerId, nickname: o.nickname };
}

function buildPoolRecord(input) {
  const o = input || {};
  return { type: 'player.pool.changed', v: RECORD_VERSION, at: o.at, playerId: o.playerId, inPool: o.inPool !== false };
}

// 墓碑记录（P7-3 追加，D-134 一致）：删除档案必须可重放 —— 只删文件会在"journal 全量重放"时复活账号，
//   故删除走 journal：append(player.removed) → apply（删档案文件 + 摘索引）；重放遇到墓碑不再重建。
function buildRemovedRecord(input) {
  const o = input || {};
  return {
    type: 'player.removed', v: RECORD_VERSION, at: o.at, playerId: o.playerId,
    reason: o.reason === undefined ? null : o.reason,
  };
}

function buildConfigRecord(input) {
  const o = input || {};
  return {
    type: 'player.config.saved', v: RECORD_VERSION, at: o.at, playerId: o.playerId,
    slotId: o.slotId, name: o.name === undefined ? undefined : o.name,
    snapshotHash: o.snapshotHash, configHash: o.configHash,
    create: o.create === true, activate: o.activate === true, deleted: o.deleted === true,
    isDefault: o.isDefault === true, warehouseVerified: o.warehouseVerified === true,
    versions: o.versions ? deepClone(o.versions) : undefined,
  };
}

function buildBatchRecord(input) {
  const o = input || {};
  return {
    type: 'ranked.batch', v: RECORD_VERSION, at: o.at, playerId: o.playerId,
    batchId: o.batchId, tier: isTier(o.tier) ? o.tier : 'common',
    seed: Number.isInteger(o.seed) ? o.seed : null,
    opponentCount: Number.isInteger(o.opponentCount) ? o.opponentCount : 0,
    // P1 缺口 3 配套：批次内 invalid 场数（不进 journal 的 battle.recorded）与是否启用放宽窗口。
    // 二者不进 journal 就无法在"回放既有批次"时复原 → 一并落记录，使重发响应与首次逐值一致。
    invalids: Number.isInteger(o.invalids) ? o.invalids : 0,
    relaxed: o.relaxed === true,
  };
}

function buildPromoteRecord(input) {
  const o = input || {};
  return {
    type: 'ranked.promoted', v: RECORD_VERSION, at: o.at, playerId: o.playerId,
    batchId: o.batchId === undefined ? null : o.batchId,
    tierBefore: isTier(o.tierBefore) ? o.tierBefore : 'common',
    tierAfter: isTier(o.tierAfter) ? o.tierAfter : 'common',
  };
}

module.exports = {
  TIERS,
  clamp,
  roundHalfUp,
  roundBy,
  expectedScore,
  gainFactor,
  lossFactor,
  ratingDelta,
  settleRating,
  promoteAfterBatch,
  battleIdOf,
  buildAccountRecord,
  buildBotRecord,
  buildPasswordRecord,
  buildBanRecord,
  buildNicknameRecord,
  buildPoolRecord,
  buildRemovedRecord,
  buildConfigRecord,
  buildBatchRecord,
  buildPromoteRecord,
  buildBattleRecord,
};
