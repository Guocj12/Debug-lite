'use strict';
/* server/runner.js —— AI 服务端编排（P2 B16；契约 docs/interfaces.md §2 /api/v1/ai/*
 * 本文件属 L6（server 层，与 index.js 同层）：组合 ast 静态校验（含版本迁移）→ 运行时续执行
 * （D-107 投影快照 + 每 tick 每用途 ai 随机流）→ 引擎注入（引擎保持 L4 注入模式：actions 函数 + aiTrace 缓冲）。
 * 事件：ai.validate・ai.migrate（ast 行）、api.*（api 行）、battle.*・engine.*（engine 行）。
 * 内置对手机器人：确定性纯状态函数（不消费随机流）；对手名 → 行为。
 */
const engine = require('./core/engine.js');
const ast = require('./ai/ast.js');
const runtime = require('./ai/runtime.js');
const crypto = require('node:crypto');

const BATTLE_CFG = require('./data/battle-config.json');

// 内置对手行为（opponent 名 → (state, self) → 行动字符串；纯函数、确定性）
const OPPONENTS = {
  // 风筝：近身则远离，距离拉开后喘息（演示性行为）
  kiter: (state, self) => {
    const foe = state.players.p1;
    if (Math.abs(foe.x - self.x) < 320) return self.x < foe.x ? 'move_left' : 'move_right';
    return 'wait';
  },
  // 冲锋：直扑敌方，贴身（≤96px）时等待喘息
  charger: (state, self) => {
    const foe = state.players.p1;
    if (Math.abs(foe.x - self.x) <= 96) return 'wait';
    return foe.x > self.x ? 'move_right' : 'move_left';
  },
};

// 基准面板（固定值；与 .audit/golden-battle.js 锚定同源——黄金战斗已机器复算）
function baselinePlayer(P) {
  return {
    id: P === 'p1' ? 'A' : 'B', owner: P,
    x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
    hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
    atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9,
    regen: { mp: 1, sp: 2 }, special: { critChance: 0, dodgeChance: 0, lifesteal: 0 },
    cooldowns: {}, effects: [],
  };
}

// D-107 白名单投影（systems/08-ai §4.5；每 tick 新建对象，避免 deepFreeze 冻结引擎状态）
function projectSnapshot(state, owner) {
  const self = state.players[owner];
  const foe = state.players[owner === 'p1' ? 'p2' : 'p1'];
  const pick = (p) => ({ hp: p.hp, atk: p.atk, def: p.def, sp: p.sp, mp: p.mp, x: p.x, baseHp: p.maxHp, facing: p.facing });
  // 弹幕不跨 tick，AI 时刻战场上通常为空；投影保持契约形状（owner/level/dir/x/type）
  return {
    self: pick(self),
    enemy: pick(foe),
    bullets: (state.bullets || []).map((b) => ({ owner: b.owner, level: b.level, dir: b.dir, x: b.x0, type: b.type })),
    field: { fieldPx: BATTLE_CFG.fieldPx, cellPx: BATTLE_CFG.cellPx },
  };
}

// 编译（/ai/compile）：版本迁移 → 结构校验 → programHash + 统计
function compileAi(program, logger) {
  const astApi = logger ? ast.withLogger(logger) : ast;
  const mig = astApi.migrateProgram(program);
  if (mig.error) {
    return { status: 400, code: mig.error, details: [{ path: '', code: mig.error, message: mig.error === 'ai_version_unsupported' ? `版本 ${program && program.version} 超过当前支持 ${ast.CURRENT_VERSION}` : '程序版本无法迁移' }] };
  }
  const p = mig.migrated ? mig.program : program;
  const v = astApi.validateProgram(p);
  if (!v.ok) return { status: 400, code: v.errors[0].code, details: v.errors };
  return {
    status: 200,
    data: {
      programHash: astApi.programHash(p),
      version: p.version,
      migrated: !!mig.migrated,
      stats: astApi.statsOf(p),
    },
  };
}

// 跑一场（/ai/battle）：服务端重新执行（T-AP-4）；seed 显式化（T-AP-5：缺省生成并回带）
function runAiBattle(opts) {
  const logger = opts.logger;
  const astApi = ast.withLogger(logger);
  const rt = runtime.withLogger(logger);
  const tier = opts.tier || 'mythic';
  const unlockApi = require('./core/unlock.js');
  if (unlockApi.tierIndex(tier) === null) {
    return { status: 400, code: 'bad_tier', details: [{ path: '', code: 'bad_tier', message: `非法段位 ${tier}（可选: common/rare/epic/legendary/mythic）` }] };
  }
  // 静态校验（含迁移与段位门控）
  const v = astApi.validate(opts.program, tier);
  if (!v.ok) return { status: 400, code: 'ai_invalid', details: v.errors };
  const opponentName = opts.opponent || 'kiter';
  const opponent = OPPONENTS[opponentName];
  if (!opponent) {
    return { status: 409, code: 'unknown_opponent', details: [{ path: '', code: 'unknown_opponent', message: `未知对手 ${opponentName}（可选: ${Object.keys(OPPONENTS).join('/')}）` }] };
  }
  const seed = opts.seed === undefined || opts.seed === null ? crypto.randomInt(1, 0x7fffffff) : opts.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1) {
    return { status: 400, code: 'bad_seed', details: [{ path: '', code: 'bad_seed', message: `非法 seed ${seed}（必须是正整数）` }] };
  }
  // 用迁移后程序建上下文与哈希（与 /ai/compile 口径一致：v1 输入 → v2 语义）
  const mig = astApi.migrateProgram(opts.program);
  if (mig.error) return { status: 400, code: 'ai_invalid', details: [{ path: '', code: mig.error, message: '程序版本无法迁移' }] };
  const program = mig.migrated ? mig.program : opts.program;
  const programHash = astApi.programHash(program); // P2-8：destroyContext 前捕获，回读不依赖实现细节
  const p1 = baselinePlayer('p1');
  const p2 = baselinePlayer('p2');
  const b = engine.createBattle(undefined, { seed, players: { p1, p2 }, logger });

  // AI 驱动器：每 tick resume（投影快照 + ai 流）并把本 tick 增量 trace 推进 aiTrace 缓冲
  const aiCtx = rt.createContext(program);
  aiCtx.programHash = programHash;
  p1.aiContext = aiCtx; // 冻结 BattleState：玩家运行时含 aiContext
  const aiBuf = [];
  let prevTraceLen = 0;
  const actions = {
    aiTrace: aiBuf,
    p1: (state) => {
      const r = rt.resume(aiCtx, projectSnapshot(state, 'p1'), state.rng.deriveStream(state.tick, 'ai'));
      const fresh = aiCtx.trace.slice(prevTraceLen);
      prevTraceLen = aiCtx.trace.length;
      for (const e of fresh) aiBuf.push(Object.assign({ tick: state.tick, owner: 'p1' }, e));
      return r.action;
    },
    p2: (state) => opponent(state, state.players.p2),
  };
  const result = b.runFull({ actions });
  rt.destroyContext(aiCtx);
  const frames = result.diffs.map((d) => ({
    tick: d.tick,
    players: d.players,
    collision: d.collision || null,
    bulletHits: d.bulletHits,
    verdict: d.verdict || null,
    aiTrace: d.aiTrace, // 冻结字段名（interfaces §4.3 diff.aiTrace[]，P2-6 对齐）
  }));
  return {
    status: 200,
    data: {
      seed,
      programHash, // P2-8：已捕获，不依赖 destroyContext 后的 ctx
      winner: result.winner,
      phase: b.state.verdict ? b.state.verdict.phase : null,
      ticks: result.ticks,
      frames,
    },
  };
}

module.exports = { compileAi, runAiBattle, projectSnapshot, OPPONENTS, baselinePlayer };