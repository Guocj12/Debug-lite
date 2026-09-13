'use strict';
/* server/ranked.js —— 排位系统（P5 B24/B25；契约 docs/interfaces.md §2 ranked 行 + systems/10-ranked.md）
 * L6：D-123 不持久化——段位/仓库/出战配置由请求传入并回带；快照 = 不可变深拷贝。
 * B24：takeSnapshot / runRankedBattle（抽 10 同段位快照（排除自己），不足 bot 补齐，逐一离线对战，平局不计胜）。
 * B25（下一批）：promote（x=6）/ tierReward（段位→品质上限）。
 * 事件（§4.6 L6 ranked 行）：ranked.snapshot(debug) / ranked.match(info)。
 */
const { nullLogger, createLogger } = require('../shared/log.js');
const { createRng } = require('./core/rng.js');
const crypto = require('node:crypto');
const loadout = require('./loadout.js');
const battle = require('./battle.js'); // buildPlayer 复用（面板聚合 → 战斗运行时）
const runner = require('./runner.js'); // projectSnapshot
const runtime = require('./ai/runtime.js');
const engine = require('./core/engine.js');

const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const X_PROMOTE = 6; // D-122：wins > 6（10 场胜 7）晋升

// 快照：出战配置的不可变深拷贝（T-RK-5）
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

// 内置 bot 出战配置（池补齐；程序化构造——数据表 + 追击 AI；无插件引用 → wh 可空校验通过）
// B24 审查 P1-1：common 技能模板实际仅 2 个——循环取满 3 槽（validateLoadout 不查 templateId 唯一）
function buildBotLoadout() {
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
const BOT_LD = takeSnapshot(buildBotLoadout(), null); // 启动期冻结一次（bot 模板不可变）

// 单场离线对战：p1=玩家快照 vs p2=对手快照 → {winner, ticks}（平局 winner='draw'）
function battleOne(mine, opponent, wh, tier, seed) {
  const b1 = battle.buildPlayer('p1', mine, wh, tier);
  const b2 = battle.buildPlayer('p2', opponent, wh, tier);
  if (!b1.ok || !b2.ok) return { winner: 'draw', ticks: 0, invalid: true };
  const logger = createLogger({ level: 'silent' });
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

// 排位对战（B24）：抽 10 同段位快照（排除自己；池不足 bot 补齐）→ 逐场离线结算 → 胜场统计
function runRankedBattle(opts, L) {
  const tier = opts.tier || 'mythic';
  if (!opts.loadout || typeof opts.loadout !== 'object') {
    return { status: 409, code: 'no_loadout', message: '缺少出战配置（loadout）' };
  }
  const v = loadout.validateLoadout(opts.loadout, { warehouse: opts.warehouse, tier });
  if (!v.ok) return { status: 409, code: 'loadout_invalid', details: v.errors, message: '出战配置不合法' };
  const seed = opts.seed === undefined || opts.seed === null ? crypto.randomInt(1, 0x7fffffff) : opts.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1 || seed > 0x7fffffff) {
    return { status: 400, code: 'bad_seed', message: `非法 seed ${seed}` };
  }
  const mineJson = JSON.stringify(opts.loadout);
  // 池：请求传入（排除自己：JSON 深等）；不足 10 用 bot 补齐
  const pool = (Array.isArray(opts.pool) ? opts.pool : [])
    .filter((ld) => ld && typeof ld === 'object' && JSON.stringify(ld) !== mineJson);
  if (opts.pool !== undefined && !Array.isArray(opts.pool)) {
    return { status: 400, code: 'bad_pool', message: 'pool 必须是 loadout 数组' };
  }
  const rng = createRng(seed).deriveStream(0, 'ranked');
  const matches = [];
  const acc = pool.slice();
  for (let i = 0; i < 10; i++) {
    if (acc.length === 0) {
      matches.push(BOT_LD);
      continue;
    }
    const idx = rng.int(0, acc.length - 1);
    matches.push(acc.splice(idx, 1)[0]);
  }
  // 逐场离线对战（平局不计胜；每场独立派生种子保证确定性）
  const results = [];
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let invalids = 0; // B24 P2-4：池坏条目单独计数（不再静默计 loss）
  const mineSnap = takeSnapshot(opts.loadout, L);
  for (let i = 0; i < matches.length; i++) {
    const matchSeed = rng.int(1, 0x7fffffff);
    const r = battleOne(mineSnap, matches[i], opts.warehouse, tier, matchSeed);
    if (r.invalid) {
      invalids += 1;
      results.push({ match: i + 1, winner: 'invalid', ticks: 0 });
    } else if (r.winner === 'p1') {
      wins += 1;
      results.push({ match: i + 1, winner: r.winner, ticks: r.ticks });
    } else if (r.winner === 'draw') {
      draws += 1;
      results.push({ match: i + 1, winner: r.winner, ticks: r.ticks });
    } else {
      losses += 1;
      results.push({ match: i + 1, winner: r.winner, ticks: r.ticks });
    }
    L && L.info('ranked', 'ranked.match', `match ${i + 1}: ${r.winner}（${r.ticks} tick）`, { match: i + 1, winner: r.winner, ticks: r.ticks });
  }
  return {
    status: 200,
    data: {
      tier, seed, matches: 10,
      wins, draws, losses, invalids,
      promoted: promotedAt(tier, wins), // P2-1：顶段不判定晋升（与 promote 的 409 口径同源分离）
      results,
    },
  };
}

function makeRanked(logger) {
  const L = logger || nullLogger;
  return {
    takeSnapshot: (ld) => takeSnapshot(ld, L),
    runRankedBattle: (opts) => runRankedBattle(opts, L),
    promote: (tier, wins) => promote(tier, wins, L),
    tierReward,
  };
}

// ---- B25：段位奖励与晋升 ----

// 段位 → 品质上限（D-122/RK-5a..e：段位序号即品质上限；common→common … mythic→mythic）
function tierReward(tier) {
  const idx = TIERS.indexOf(tier);
  return idx === -1 ? null : TIERS[idx];
}

// 晋升判定（D-122：x=6，wins > 6 即 10 场胜 7 晋升；最高段位不再晋升 → 409 already_max）
function promotedAt(tier, wins) {
  return wins > X_PROMOTE && TIERS.indexOf(tier) < TIERS.length - 1; // P2-1：顶段不判定晋升（与 rank/run 同源）
}

function promote(tier, wins, L) {
  if (tier === undefined || !TIERS.includes(tier)) {
    return { status: 400, code: 'bad_tier', message: `非法段位 ${tier}（可选: ${TIERS.join('/')}）` };
  }
  if (typeof wins !== 'number' || !Number.isInteger(wins) || wins < 0 || wins > 10) {
    return { status: 400, code: 'bad_wins', message: `非法 wins ${wins}（必须是非负整数且 ≤ 10，P2-2 上限）` };
  }
  const idx = TIERS.indexOf(tier);
  const willPromote = wins > X_PROMOTE; // 原始阈值（顶段「想晋不可」由 409 拒绝，P2-1 口径分离）
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

module.exports = Object.assign(makeRanked(), {
  withLogger: (logger) => makeRanked(logger),
  takeSnapshot, runRankedBattle, promote, tierReward, promotedAt, BOT_LD, buildBotLoadout, X_PROMOTE, TIERS,
});