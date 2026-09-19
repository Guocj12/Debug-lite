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
const { createLogger, nullLogger } = require('../shared/log.js');
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

// D-107 白名单投影（systems/08-ai §4.5；每 tick 新建对象 + deepFreeze 由 runtime.resume 施加，
//   本函数只做**值拷贝**：绝不把引擎状态对象/数组引用交给 AI（数组/对象一律只读副本））
// 语义澄清（B26 拍板，用户原话）：「baseHp 与 maxHp 完全是两个东西」——
//   * baseHp = 该方**基地**当前血量（state.bases[owner].hp）；
//   * maxHp  = 该方**角色**血量上限（state.players[owner].maxHp）。
// 快照字段总清单（与 docs/systems/08-ai §4.5 / interfaces 同步；get.path 白名单以本清单为准）：
//   tick                              number
//   self.{hp,maxHp,mp,maxMp,sp,maxSp,atk,def,x,facing,baseHp}  number
//   self.cooldowns.<sid>              number（只读副本；未装配技能不在其中）
//   self.effects[i].{kind,stat,delta,remaining,displacement,uid}  （只读摘要；缺省 null）
//   enemy.*                           同 self.*（对称）
//   bases.self.{hp,maxHp,def} / bases.enemy.{hp,maxHp,def}        number（基地血量可读路径）
//   field.{fieldPx,cellPx}
// 弹幕不投影（用户决策：取消弹幕观测——AI 无法看到弹幕，弹幕在生成当 tick 全解算完毕；
//   回放帧 diff.bullets 与日志通道 bullets 不是本投影，不受此影响）。
function projectSnapshot(state, owner) {
  const me = state.players[owner];
  const foe = state.players[owner === 'p1' ? 'p2' : 'p1'];
  const myBase = (state.bases && state.bases[owner]) || {};
  const foeBase = (state.bases && state.bases[owner === 'p1' ? 'p2' : 'p1']) || {};
  // 只读副本：cooldowns 逐键取数（不传引用）；effects 重建成最小摘要（不传引擎 effect 对象）
  const copyCooldowns = (p) => {
    const out = {};
    const src = p && p.cooldowns ? p.cooldowns : {};
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  };
  const summarizeEffects = (p) => (Array.isArray(p && p.effects) ? p.effects : []).map((e) => ({
    uid: e.uid === undefined ? null : String(e.uid),
    kind: e.kind === undefined ? null : String(e.kind),
    stat: e.stat === undefined ? null : String(e.stat),
    delta: typeof e.delta === 'number' ? e.delta : null,
    displacement: typeof e.displacement === 'number' ? e.displacement : null,
    remaining: typeof e.remaining === 'number' ? e.remaining : null,
  }));
  const pick = (p, base) => ({
    hp: p.hp, maxHp: p.maxHp, mp: p.mp, maxMp: p.maxMp, sp: p.sp, maxSp: p.maxSp,
    atk: p.atk, def: p.def, x: p.x, facing: p.facing,
    baseHp: base.hp === undefined ? null : base.hp, // B26 修正：基地当前血量（原误填角色 maxHp）
    cooldowns: copyCooldowns(p),
    effects: summarizeEffects(p),
  });
  const pickBase = (base) => ({ hp: base.hp === undefined ? null : base.hp, maxHp: base.maxHp === undefined ? null : base.maxHp, def: base.def === undefined ? null : base.def });
  // 弹幕不跨 tick（生成当 tick 全解算完毕）→ 快照不再投影 bullets（AI 无法观测弹幕，设计如此）
  return {
    tick: state.tick,
    self: pick(me, myBase),
    enemy: pick(foe, foeBase),
    bases: { self: pickBase(myBase), enemy: pickBase(foeBase) },
    field: { fieldPx: BATTLE_CFG.fieldPx, cellPx: BATTLE_CFG.cellPx },
  };
}

// 编译（/ai/compile）：版本迁移 → 结构校验 → programHash + 统计（+ warnings 非阻断提示回带）
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
      // B26：warnings 通道（并行任务在 ast.validate 落地）；此处防御性 || []，字段缺席也不崩
      warnings: Array.isArray(v.warnings) ? v.warnings : [],
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
  // B26：动作生效性观测（唯一真源 = 引擎/技能系统自己的 warn 记录：action.invalid / skill.reject）
  //   内部 logger 全量记录进 battleEvents（帧 events[] 契约：与 /api/v1/battle 同源，带 cid/tick），
  //   并**逐条镜像**到调用方 logger（不改变既有日志矩阵：battle.create/tick.begin/... 全部照旧可观测）。
  const battleEvents = [];
  const battleLogger = createLogger({
    level: 'trace', ringSize: 8192, now: () => 0,
    onRecord: (r) => {
      battleEvents.push(r);
      if (logger && typeof logger.log === 'function') logger.log(r.level, r.channel, r.event, r.msg, r.data);
    },
  });
  const b = engine.createBattle(undefined, { seed, players: { p1, p2 }, logger: battleLogger });

  // AI 驱动器：每 tick resume（投影快照 + ai 流）→ 本 tick **全量** ctx.trace 推进 aiTrace 缓冲
  //   （runtime 每 tick 重置 ctx.trace：单 tick 上限 traceLimit=2000，故"全量 = 本 tick"；见 takeTrace 的兼容分支）
  const aiCtx = rt.createContext(program);
  aiCtx.programHash = programHash;
  p1.aiContext = aiCtx; // 冻结 BattleState：玩家运行时含 aiContext
  const aiBuf = [];
  const actions = {
    aiTrace: aiBuf,
    p1: (state) => {
      const r = rt.resume(aiCtx, projectSnapshot(state, 'p1'), state.rng.deriveStream(state.tick, 'ai'));
      const fresh = takeTrace(aiCtx);
      for (const e of fresh) aiBuf.push(Object.assign({ tick: state.tick, owner: 'p1' }, e));
      return r.action;
    },
    p2: (state) => opponent(state, state.players.p2),
  };
  // eventsBuf：回放帧 events[] 与 /api/v1/battle 同源契约（记录带 cid/tick）
  const result = b.runFull({ actions, eventsBuf: battleEvents });
  rt.destroyContext(aiCtx);

  // ---- 每帧动作生效性：p1 = 玩家 AI（对手为内置纯状态机器人，不参与统计）----
  const agg = countActions(result.diffs, battleEvents);
  const frames = result.diffs.map((d) => {
    const events = (d.events || []).filter(isObservableActionEvent);
    // 无 owner 的动作事件（如 action.invalid 的非法原始值）默认归玩家 p1（对手为内置机器人，不产生这类事件）
    const p1Events = events.filter((e) => !e.data || e.data.owner === undefined || e.data.owner === 'p1');
    return {
      tick: d.tick,
      players: d.players,
      collision: d.collision || null,
      bulletHits: d.bulletHits,
      verdict: d.verdict || null,
      aiTrace: d.aiTrace, // 冻结字段名（interfaces §4.3 diff.aiTrace[]，P2-6 对齐）
      actions: { effective: Math.max(0, 1 - p1Events.length), ineffective: p1Events.length },
      events,
    };
  });
  return {
    status: 200,
    data: {
      seed,
      programHash, // P2-8：已捕获，不依赖 destroyContext 后的 ctx
      winner: result.winner,
      phase: b.state.verdict ? b.state.verdict.phase : null,
      ticks: result.ticks,
      frames,
      warnings: Array.isArray(v.warnings) ? v.warnings : [], // B26：非阻断提示（ast.validate 通道）
      actionsEffective: agg.actionsEffective,
      ineffectiveActions: agg.ineffectiveActions,
    },
  };
}

// 该 tick 的**全量** trace（runtime 每 tick 重置 ctx.trace：单 tick 上限 traceLimit=2000）。
// 判据用 trace 条目自身的 seq（每次 resume 从 0 连续递增）：取"从 0 连续递增的最长后缀"= 本次 resume 的条目。
// 无状态、对"每 tick 重置"与"累积+seq 递增"两种 runtime 语义都正确；返回值恒为新数组（只读副本，
// 不把 ctx 内部数组交给引擎/调用方）。
function takeTrace(ctx) {
  const all = Array.isArray(ctx.trace) ? ctx.trace : [];
  const traceLimit = Number.isInteger(ctx.traceLimit) ? ctx.traceLimit : all.length;
  const win = all.length > traceLimit ? all.slice(all.length - traceLimit) : all;
  let start = win.length;
  while (start > 0 && win[start - 1] && win[start - 1].seq === start - 1) start -= 1;
  return win.slice(start);
}

// 可观测动作事件（帧 events 只回带这两类：失败行动 + 技能被拒；正常运行不产生噪声级事件）
function isObservableActionEvent(r) {
  return !!r && (r.event === 'action.invalid' || r.event === 'skill.reject');
}

// 动作生效性聚合（唯一真源 = 事件记录）：{actionsEffective, ineffectiveActions}
// 归属口径：/ai/battle 的 p2 是内置纯状态机器人（OPPONENTS），不产生 action.invalid/skill.reject；
//   故"无 owner 的动作事件"= 玩家 p1 的动作（engine 的 normalizeAction 记 action.invalid 时不带 owner）。
// 计数口径：一个 tick 内一方至多一个行动 → 未生效**动作数**按 (owner,tick) 去重（同一动作可能同时落
//   normalizeAction 与技能装配两处 warn，属"同一动作的两个原因"，不重复计数）；`causes` 保留逐条原因明细。
function countActions(diffs, events) {
  const causes = [];
  const byOwner = {};
  const byReason = {};
  const byAction = {}; // `${owner}#${tick}` → 该动作的去重原因集合
  for (const r of events || []) {
    if (!isObservableActionEvent(r)) continue;
    const owner = r.data && r.data.owner !== undefined && r.data.owner !== null ? r.data.owner : 'p1';
    const tick = r.tick === null || r.tick === undefined ? null : r.tick;
    const reason = r.event === 'action.invalid'
      ? ((r.data && r.data.reason) || 'invalid_action')
      : `skill_${(r.data && r.data.reason) || 'reject'}`;
    const raw = r.data && r.data.raw !== undefined ? r.data.raw : null;
    const sid = r.data && r.data.sid !== undefined ? r.data.sid : null;
    causes.push({ tick, owner, reason, raw, sid, message: r.msg });
    byReason[reason] = (byReason[reason] || 0) + 1;
    const key = `${owner}#${tick}`;
    if (!byAction[key]) byAction[key] = { tick, owner, reasons: [], raw: null, sid: null };
    if (!byAction[key].reasons.includes(reason)) byAction[key].reasons.push(reason);
    if (byAction[key].raw === null && raw !== null) byAction[key].raw = raw;
    if (byAction[key].sid === null && sid !== null) byAction[key].sid = sid;
  }
  const actions = Object.keys(byAction).map((k) => byAction[k]);
  for (const a of actions) byOwner[a.owner] = (byOwner[a.owner] || 0) + 1;
  // p1 每 tick 至多一个动作 → 生效动作数 = tick 数（帧数）− 未生效动作数（下限 0）
  const p1Total = (diffs || []).length;
  const p1Ineffective = byOwner.p1 || 0;
  return {
    actionsEffective: Math.max(0, p1Total - p1Ineffective),
    ineffectiveActions: {
      count: actions.length,
      byReason,
      byOwner,
      actions,
      causes,
    },
  };
}

module.exports = { compileAi, runAiBattle, projectSnapshot, OPPONENTS, baselinePlayer, takeTrace, countActions, isObservableActionEvent };