'use strict';
/* server/battle.js —— 双方 loadout 对战编排与回放（P4 B22；契约 docs/interfaces.md §2 POST /api/v1/battle + GET /api/v1/replay/:id）
 * L6 组合：loadout 校验/构建玩家（面板聚合含 B20 插件词条）→ 引擎（双 AI 驱动器 + 整场事件缓冲）→ 回放帧。
 * 回放注册表为进程内存储（D-123 不落盘）：id = r<seq>；GET ?from=&to= 1-based 含端切分；未知 id → 404。
 * frame 契约（§4.3）：tick + diff{players[], bullets[], bases[], events[], aiTrace[]}——1px、事件带 cid。
 */
const engine = require('./core/engine.js');
const skills = require('./core/skills.js');
const runtime = require('./ai/runtime.js');
const loadout = require('./loadout.js');
const runner = require('./runner.js'); // projectSnapshot（D-107 投影）
const { createLogger } = require('../shared/log.js');
const crypto = require('node:crypto');

const STUB_RNG = { float: () => 1, int: () => 0, pick: () => 0 };

// 进程内回放注册表（D-123：不持久化）
const REPLAYS = new Map();
let replaySeq = 0;

// loadout → 战斗玩家运行时（面板聚合 = 最终数值；技能实例 = 模板基准 + 面板聚合参数）
function buildPlayer(owner, ld, wh, tier) {
  const panel = loadout.buildPanel(ld, { warehouse: wh, tier });
  if (!panel.ok) return { ok: false, errors: panel.errors };
  const cfg = require('./data/battle-config.json');
  const role = panel.panel.role;
  const p = {
    id: owner === 'p1' ? 'A' : 'B', owner,
    x: cfg.startX[owner], facing: cfg.startFacing[owner],
    hp: role.stats.hp, maxHp: role.stats.hp, mp: role.stats.mp, maxMp: role.stats.mp, sp: role.stats.sp, maxSp: role.stats.sp,
    atk: role.stats.atk, def: role.stats.def,
    regen: role.regen, special: role.special || {},
    cooldowns: {}, effects: [],
  };
  const ctx = runtime.createContext(ld.ai);
  ctx.programHash = require('./ai/ast.js').programHash(ld.ai);
  p.aiContext = ctx; // 冻结玩家运行时（§4.1）含 aiContext（P2-5 落实）
  p.skills = {};
  ld.skills.forEach((sk, i) => {
    const inst = skills.instantiateSkill(sk.templateId, sk.quality || 'common', STUB_RNG);
    const agg = panel.panel.skills[i].params; // B20 聚合（含插件词条/消耗补偿）
    // 槽位键 = 引擎的寻址键（`skill:skillN`）**且**是冷却键（P1-4 裁定：按槽位冷却）
    //   → 同一模板装两槽时两槽 CD 独立；`inst.sid` 仍是模板 id（身份/日志用，两者不再混同）
    p.skills[`skill${i + 1}`] = Object.assign(inst, agg);
  });
  return { ok: true, player: p, ctx };
}

// 逐侧仓库解析（P1 缺口 2）：优先级 = 逐侧显式值（p1Warehouse/p2Warehouse 或 {p1,p2} 形态）
//   → 兼容旧签名 `warehouse`（单仓库 = 双方共用）。
// 为什么需要逐侧：匹配路径（ranked.battleOne）双方是**不同玩家**，各自镜像独立；归档回放重算时
//   两侧的镜像来自各自快照（缺口 1 落盘的装配引用子集）。只接受单个 warehouse 会让含装配引用的
//   一侧拿不到镜像 → buildPanel 报 missing_warehouse → 回放 410（snapshot_gc/版本不匹配类）。
function sideWarehouses(opts) {
  const base = opts.warehouse && typeof opts.warehouse === 'object' ? opts.warehouse : null;
  if (base && base.buckets === undefined && (base.p1 !== undefined || base.p2 !== undefined)) {
    return { p1: base.p1 || null, p2: base.p2 || null };
  }
  const pick = (side, legacy) => (side === undefined || side === null ? (legacy || null) : side);
  return { p1: pick(opts.p1Warehouse, base), p2: pick(opts.p2Warehouse, base) };
}

// 跑一场（双方 loadout + AI + seed）：返回 {status, code?, data?}
function runBattle(opts) {
  const tier = opts.tier || 'mythic';
  if (!opts.p1 || !opts.p2 || typeof opts.p1 !== 'object' || typeof opts.p2 !== 'object') {
    return { status: 400, code: 'bad_request', message: '需要 p1/p2 loadout 对象' };
  }
  const seed = opts.seed === undefined || opts.seed === null ? crypto.randomInt(1, 0x7fffffff) : opts.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1 || seed > 0x7fffffff) {
    return { status: 400, code: 'bad_seed', message: `非法 seed ${seed}` };
  }
  const wh = sideWarehouses(opts);
  const b1 = buildPlayer('p1', opts.p1, wh.p1, tier);
  if (!b1.ok) return { status: 409, code: 'loadout_invalid', details: b1.errors, message: 'p1 出战配置不合法' };
  const b2 = buildPlayer('p2', opts.p2, wh.p2, tier);
  if (!b2.ok) return { status: 409, code: 'loadout_invalid', details: b2.errors, message: 'p2 出战配置不合法' };

  // 整场事件缓冲（回放帧 events[] 契约：记录带 cid/tick；B22 P1-2：now 归零保证同 seed 帧字节级可复现）
  const battleEvents = [];
  const battleLogger = createLogger({ level: 'all', ringSize: 50000, now: () => 0, onRecord: (r) => battleEvents.push(r) });
  const b = engine.createBattle(undefined, { seed, players: { p1: b1.player, p2: b2.player }, logger: battleLogger });
  const aiTrace = [];
  const driver = (owner, bp) => (state) => {
    const r = runtime.resume(bp.ctx, runner.projectSnapshot(state, owner), state.rng.deriveStream(state.tick, 'ai'));
    // runtime 已改为**每 tick 重置** ctx.trace（单 tick 上限 2000）→ 必须取该 tick 全量，
    // 不能再用 slice(prevLen) 增量（否则第 2 tick 起 aiTrace 恒为空；2026-09-16 修复）。
    for (const e of runner.takeTrace(bp.ctx)) aiTrace.push(Object.assign({ tick: state.tick, owner }, e));
    return r.action;
  };
  const result = b.runFull({ actions: { aiTrace, p1: driver('p1', b1), p2: driver('p2', b2) }, eventsBuf: battleEvents });
  runtime.destroyContext(b1.ctx);
  runtime.destroyContext(b2.ctx);

  const id = `r${++replaySeq}`;
  const frames = result.diffs.map((d) => ({
    tick: d.tick,
    diff: {
      players: d.players,
      bullets: d.bullets,
      bases: d.bases,
      events: d.events || [],
      aiTrace: d.aiTrace || [],
      collision: d.collision || null,
      bulletHits: d.bulletHits,
      verdict: d.verdict || null,
    },
  }));
  const summary = { id, seed, tier, winner: result.winner, phase: b.state.verdict ? b.state.verdict.phase : null, ticks: result.ticks };
  REPLAYS.set(id, { ...summary, frames });
  return { status: 200, data: { ...summary, frames } };
}

// 取回放（?from=&to= 1-based 含端；默认全量）；未知 id → 404
function getReplay(id, from, to) {
  const rep = REPLAYS.get(String(id || ''));
  if (!rep) return { status: 404, code: 'unknown_replay', message: `未知回放 ${id}` };
  const lo = Number.isInteger(from) && from >= 1 ? from : 1;
  const hi = Number.isInteger(to) && to >= lo ? to : rep.frames.length;
  return { status: 200, data: { id: rep.id, seed: rep.seed, winner: rep.winner, phase: rep.phase, ticks: rep.ticks, frames: rep.frames.slice(lo - 1, hi) } };
}

module.exports = { runBattle, getReplay, buildPlayer, sideWarehouses, REPLAYS };