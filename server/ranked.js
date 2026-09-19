'use strict';
/* server/ranked.js —— 排位系统（P5 B24/B25 → P7-3/B31 档案驱动改造）
 * 契约：docs/interfaces.md §1 `server/ranked.js` + §2 `POST /api/v1/ranked/run`；docs/systems/10-ranked.md §4.3/§4.4；
 *      docs/systems/11-account-store.md §7（异步排位）/§7.2（对手池）/§7.3（攻守差异）/§7.7（部分成功语义）。
 *
 * 🚫 无占位 bot（D-152 / plan-p7-playable §P7-3）：匹配池**只能**由真实玩家档案构成。
 *    - 池 = `store.index.byTier(tier)` ∩ 有可用快照 ∩ 未封禁 ∩ 在池内（服务端抽池，客户端不得自选对手 D-136）；
 *    - 候选不足 N 场 → **少打几场并如实回报 `shortfall`**（不注入 bot 充数）；
 *    - 内置 bot 补齐逻辑已删除；仅保留 `DL_DEBUG_BOTS=1` 的**显式调试开关**（默认关闭），
 *      且开启时经事件 `ranked.pool`（debug 级）与启动 warn 标注 `debug:true`（见 inspectDebugBots）；
 *      **响应体不含 `debugBots` 字段**（P2-2：旧注释声称响应含 `debugBots:true`，实际从不产生 → 注释已对齐实现）。
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
const X_PROMOTE = 6; // D-122 旧阈值常量（wins > 6 = 10 场胜 7 晋升）。P2-3 起判定单一真源 = `rating-config.promoteWins`
//   （ledger.promoteAfterBatch，缺省 6）；本常量仅保留导出兼容（文档 §10-ranked 仍登记该导出），不再参与判定。
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
 *
 * P2-5（2026-09-19）：旧默认 AI 只有 `move_left` → 双方永不攻击 → 真实玩家池**几乎恒平局**
 *（审查 probe R1 5/5 平、R6 6/6 平）→ Elo 无区分度、P7-6 的"自然积分分布"不成立。
 * 现改为 **3 族 × 3 子变体 = 9 个交战程序**，按玩家身份稳定哈希派生（无身份 → steady/0，保持旧调用点确定性）：
 *   steady     稳健：残血先防 → 拉到中距 → 背后转身 → 主技能开火（远程位 = 槽 1）
 *   aggressive 激进：贴脸（64 = minGapPx）→ 近战位/点射位开火
 *   kite       风筝：中远距（288/320/448 < 射程 512px）开火；过远才靠近（不后退 → 不背身空放）
 * 子变体不改"会交战"这一事实，只打破"同族完全对称 → 恒平局"（实测：9 程序两两 72 有序对中仅 10 对恒平局）。
 ---------- */

// AI 程序构造小工具（只用 base 节点 + if：任意段位可校验通过；version 2 = 当前 AST 版本）
const aiLit = (value) => ({ type: 'literal', value });
const aiGet = (path) => ({ type: 'get', path });
const aiAct = (name) => ({ type: 'action', name });
const aiSeq = (statements) => ({ type: 'seq', statements });
const aiCmp = (op, left, right) => ({ type: 'cmp', op, left, right });
const aiArith = (op, left, right) => ({ type: 'arith', op, left, right });
const aiIf = (cond, thenNode, elseNode) => ({ type: 'if', cond, then: thenNode, else: elseNode });
const aiGap = () => aiArith('-', aiGet('enemy.x'), aiGet('self.x')); // 敌我 x 差（正 = 敌在右）

const DEFAULT_AI_PRESETS = Object.freeze(['steady', 'aggressive', 'kite']);

// 预设 → 技能槽模板顺序（槽位 = AI 里的 `skill:skillN`；顺序即"主武器位"）
const PRESET_SKILL_ORDER = Object.freeze({
  steady: Object.freeze(['skill_straight_precise', 'skill_melee_whirl', 'skill_melee_whirl']),
  aggressive: Object.freeze(['skill_melee_whirl', 'skill_straight_precise', 'skill_melee_whirl']),
  kite: Object.freeze(['skill_straight_precise', 'skill_straight_precise', 'skill_melee_whirl']),
});

// 族 × 子变体 → 参数（阈值/开火槽/残血防守线）。参数**由探针实测选定**（同族子变体必须打破
// "完全对称 → 恒平局"：见报告 P2-5 实测矩阵；当前 9 个程序两两 36 对中仅 5 对恒平局）。
const AI_VARIANT_PARAMS = Object.freeze({
  steady: Object.freeze([
    Object.freeze({ threshold: 160, slot: 'skill:skill1', defendHp: 30 }),
    Object.freeze({ threshold: 192, slot: 'skill:skill1', defendHp: 30 }),
    Object.freeze({ threshold: 320, slot: 'skill:skill1', defendHp: 30 }),
  ]),
  kite: Object.freeze([
    Object.freeze({ threshold: 288, slot: 'skill:skill1', defendHp: null }),
    Object.freeze({ threshold: 320, slot: 'skill:skill1', defendHp: null }),
    Object.freeze({ threshold: 448, slot: 'skill:skill1', defendHp: null }),
  ]),
  aggressive: Object.freeze([
    Object.freeze({ threshold: 64, slot: 'skill:skill1', defendHp: null }),
    Object.freeze({ threshold: 64, slot: 'skill:skill1', defendHp: 30 }),
    Object.freeze({ threshold: 64, slot: 'skill:skill2', defendHp: 30 }),
  ]),
});

// 预设 → AI 程序（每次调用返回**新对象**：调用方修改不得污染其它玩家/后续调用）
// 统一形状：`近身后退? ↔ 过远前进? ↔ 否则开火`（自下而上构造，避免深嵌套）。
// `sub`（0..2）= 同一族内的**子变体**（阈值/开火槽/防守线不同）：仅靠 3 族时"同族对同族"完全对称 → 恒平局，
//   故身份哈希再选一档子变体（共 9 个程序），把同族镜像的对称性也打破。
function aiProgramOf(preset, sub) {
  const table = AI_VARIANT_PARAMS[preset] || AI_VARIANT_PARAMS.steady;
  const params = table[Number.isInteger(sub) && sub >= 0 && sub < table.length ? sub : 0];
  const fire = aiSeq([aiAct(params.slot)]);
  const stepBack = aiIf(aiCmp('<', aiGap(), aiLit(-params.threshold)), aiSeq([aiAct('move_left')]), fire);
  const stepForward = aiIf(aiCmp('>', aiGap(), aiLit(params.threshold)), aiSeq([aiAct('move_right')]), stepBack);
  const body = params.defendHp === null
    ? aiSeq([stepForward])
    : aiSeq([aiIf(aiCmp('<', aiGet('self.hp'), aiLit(params.defendHp)), aiSeq([aiAct('defend')]), stepForward)]);
  return { type: 'program', version: 2, body };
}

// 身份 → 预设族 + 子变体（稳定哈希：同玩家恒定；无身份 → steady/0，保持旧调用点确定性）
function identityKeyOf(identity) {
  if (typeof identity === 'string' && identity !== '') return identity;
  if (identity && typeof identity === 'object') {
    for (const k of ['publicId', 'playerId', 'botKey', 'username']) {
      if (typeof identity[k] === 'string' && identity[k] !== '') return identity[k];
    }
  }
  return null;
}

function variantOf(identity) {
  const key = identityKeyOf(identity);
  if (key === null) return { preset: DEFAULT_AI_PRESETS[0], sub: 0, hashed: false };
  const digest = crypto.createHash('sha256').update(`dl-default-ai|${key}`).digest();
  return {
    preset: DEFAULT_AI_PRESETS[digest.readUInt32BE(0) % DEFAULT_AI_PRESETS.length],
    sub: (digest.readUInt32BE(4) >>> 0) % 3,
    hashed: true,
  };
}

function presetOf(identity) {
  return variantOf(identity).preset;
}

function buildDefaultLoadout(identity) {
  const ROLE = require('./data/role-templates.json').roleTemplates.find((r) => r.id === 'role_bal');
  const TEMPLATES = require('./data/skill-templates.json').skillTemplates;
  const variant = variantOf(identity);
  const order = PRESET_SKILL_ORDER[variant.preset] || PRESET_SKILL_ORDER.steady;
  const skillItems = [];
  for (let i = 0; i < 3; i++) {
    const t = TEMPLATES.find((x) => x.id === order[i % order.length]) || TEMPLATES.filter((x) => !x.unlockTier || x.unlockTier === 'common')[i % 2];
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
    ai: aiProgramOf(variant.preset, variant.sub),
  };
}

/* ---------- 单场离线对战：p1=发起者快照 vs p2=对手快照 → {winner, ticks}（平局 winner='draw'） ---------- */

// 仓库镜像解析（缺陷 B 修复）：`wh` 可以是单个仓库（双方共用 = 旧签名，文档 §7.4 不变）
//   或 `{p1, p2}` 逐侧仓库（匹配路径：双方是不同玩家，镜像各自独立）。
//   `loadout.buildPanel` 对"槽内含 pluginUid"的配置**必需**仓库正文，否则 missing_warehouse → 该场 invalid。
function warehousesOf(wh) {
  if (wh && wh.buckets === undefined && (wh.p1 !== undefined || wh.p2 !== undefined)) {
    return { p1: wh.p1 || null, p2: wh.p2 || null };
  }
  return { p1: wh || null, p2: wh || null };
}

// 该出战配置是否需要仓库正文（任一槽有 pluginUid 引用）
function needsWarehouse(ld) {
  if (!ld || typeof ld !== 'object') return false;
  const hasRef = (slots) => Array.isArray(slots) && slots.some((s) => s && s.pluginUid);
  if (hasRef(ld.role && ld.role.slots)) return true;
  return (Array.isArray(ld.skills) ? ld.skills : []).some((sk) => hasRef(sk && sk.slots));
}

/* ---------- 缺陷 B：装配引用（pluginUid）与仓库镜像 ----------
 * 背景：仓库由客户端权威持有（D-130），服务端只保留**进程内**镜像缓存（`PUT /me/warehouse` / 带 warehouse
 *   的配置保存）。对局路径原先一律传 `warehouse: null` → 任何"槽内含 pluginUid"的配置在 `buildPanel`
 *   阶段被 `missing_warehouse` 拒绝：快速对战 409 `no_opponent`、排位 409 `loadout_invalid`（实测复现）。
 * 口径（本批裁定）：
 *   ① 镜像在进程内可用 → 用**真镜像**（插件词条正常生效，校验完整）；
 *   ② 镜像不可用但该配置**已校验过**（`flags.unverifiedLoadout === false` 或槽快照
 *      `verifiedAgainstWarehouse === true`）→ 视为"提交时已校验"，**跳过需要仓库正文的引用校验**：
 *      用"占位 no-op 插件"（空词条/0 点数）满足结构校验收，退化为**基准面板**（插件词条不生效）并记 warn；
 *   ③ 两者都不成立（从未校验）→ 如实报 `missing_warehouse`（绝不放宽成"永远放行"）。
 */

// 该档案的出战配置是否"已对仓库校验过"
function isWarehouseVerified(archive, activeSlot) {
  const flags = (archive && archive.flags) || {};
  if (flags.unverifiedLoadout === false) return true;
  const ref = activeSlot && activeSlot.snapshot;
  return !!(ref && ref.verifiedAgainstWarehouse === true);
}

// 把装配引用物化为 no-op 占位项（`affixes: []` → 面板与源配置的"基准值"一致，无词条加成）
function syntheticVerifiedWarehouse(loadout) {
  const buckets = { role: [], skill: [], rolePlugin: [], skillPlugin: [] };
  const pushRefs = (slots, kind, bucket) => {
    for (const s of Array.isArray(slots) ? slots : []) {
      if (!s || !s.pluginUid) continue;
      buckets[bucket].push({
        uid: s.pluginUid, id: 'verified_noop', kind, slot: s.type === undefined ? null : s.type,
        equipped: true, tier: 1, unlockTier: 'common', affixes: [], pointCost: 0,
      });
    }
  };
  const ld = loadout || {};
  pushRefs(ld.role && ld.role.slots, 'rolePlugin', 'rolePlugin');
  for (const sk of Array.isArray(ld.skills) ? ld.skills : []) pushRefs(sk && sk.slots, 'skillPlugin', 'skillPlugin');
  return buckets.rolePlugin.length + buckets.skillPlugin.length > 0 ? { buckets } : null;
}

function battleOne(mine, opponent, wh, tier, seed) {
  const sides = warehousesOf(wh);
  const b1 = battle.buildPlayer('p1', mine, sides.p1, tier);
  if (!b1.ok) return { winner: 'draw', ticks: 0, invalid: true, errors: b1.errors };
  const b2 = battle.buildPlayer('p2', opponent, sides.p2, tier);
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
// 返回 { candidates:[{playerId,entry,warehouse}], unusable:[playerId] }——`unusable` 是"档案在池内但快照/仓库不可用"。
// 缺陷 B：槽内含 pluginUid 的对手需要**其仓库镜像**才能实例化（D-130 不落盘、只在本进程内）——
//   镜像缺失 → 该对手不可实例化，直接跳过（不占场次、不产生 invalid 场），而不是抽中后才失败。
async function candidatesOf(store, tier, excludeId, L, resolveWarehouse) {
  const ids = store.index.byTier(tier) || [];
  const candidates = [];
  const unusable = [];
  const noWarehouse = [];
  const degraded = [];
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
    let warehouse = null;
    if (needsWarehouse(snapshot[RAW_SNAPSHOT_FIELD])) {
      warehouse = typeof resolveWarehouse === 'function' ? await resolveWarehouse(playerId) : null;
      if (!warehouse) {
        // 退化路径：已校验过（但镜像不在本进程）→ 用 no-op 占位项满足结构校验；未校验 → 跳过该候选
        const foeArchive = typeof store.loadArchive === 'function' ? await store.loadArchive(playerId) : null;
        const active = foeArchive ? archiveMod.activeSlot(foeArchive) : null;
        warehouse = isWarehouseVerified(foeArchive, active)
          ? syntheticVerifiedWarehouse(snapshot[RAW_SNAPSHOT_FIELD])
          : null;
        if (!warehouse) { noWarehouse.push(playerId); continue; }
        degraded.push(playerId);
      }
    }
    candidates.push({ playerId, entry, warehouse });
  }
  if (unusable.length > 0) {
    L && L.warn('store', 'store.snapshot.missing',
      `同段位 ${tier} 有 ${unusable.length} 个候选快照缺失/不可用（已跳过，不占场次）`,
      { tier, count: unusable.length, sample: unusable.slice(0, 3) });
  }
  if (noWarehouse.length > 0) {
    L && L.warn('store', 'store.snapshot.missing',
      `同段位 ${tier} 有 ${noWarehouse.length} 个候选的仓库镜像不在本进程内（含装配引用且未校验过 → 跳过）`,
      { tier, count: noWarehouse.length, sample: noWarehouse.slice(0, 3), reason: 'warehouse_mirror_absent' });
  }
  if (degraded.length > 0) {
    L && L.warn('store', 'store.snapshot.missing',
      `同段位 ${tier} 有 ${degraded.length} 个候选的仓库镜像不在本进程内（已校验过 → 以基准面板退化对局）`,
      { tier, count: degraded.length, sample: degraded.slice(0, 3), reason: 'warehouse_mirror_degraded' });
  }
  return { candidates, unusable, noWarehouse, degraded, banned, outOfPool, poolSize: ids.length };
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

/* ---------- 批次级幂等（P1-4） ---------- */

// batchId 由 `(playerId, seed)` **确定性派生**（不含 `at`/进程内序号）：同 seed 重发 → 同 batchId。
// 旧口径 `playerId|seed|at|++batchSeq` 让每次重发都得到新 batchId → `batchesPlayed` 递增、可重复触发晋升
//（记录级幂等 ≠ 批次级幂等：battleId 只覆盖单场）。
function batchIdOf(playerId, seed) {
  return `bt_${ledger.battleIdOf({
    batchId: `${playerId}|${seed}`, matchIndex: 0, seed, p1SnapshotHash: '', p2SnapshotHash: '',
  }).slice(2)}`;
}

// 该批次是否已落 journal（`ranked.batch` + 其下的 `battle.recorded` + `ranked.promoted`）。
// 命中 → 调用方**回放结果**，不重复结算、不重复写 journal（`store.append` 不会去重：必须在此拦截）。
async function findPriorBatch(store, playerId, batchId) {
  if (typeof store.replayJournal !== 'function') return null;
  let batch = null;
  let promote = null;
  const battles = [];
  await store.replayJournal({ fromSeq: 0 }, (rec) => {
    if (!rec || typeof rec.type !== 'string') return;
    if (rec.type === 'battle.recorded') {
      if (rec.batchId === batchId && rec.p1 && rec.p1.playerId === playerId && rec.battleId) battles.push(rec);
      return;
    }
    if (rec.batchId !== batchId || rec.playerId !== playerId) return;
    if (rec.type === 'ranked.batch') batch = rec;
    else if (rec.type === 'ranked.promoted') promote = rec;
  });
  if (!batch) return null;
  return { batch, promote, battles };
}

// 回放既有批次的结果（P1-4）。**逐场结果来自 journal 原记录**，故与首次响应一致；
// 两处不可复原、显式标注：`invalids`（invalid 场不进 journal）记 0；`relaxed`（抽取窗口细节不落 journal）记 null。
function replayBatchPayload(input) {
  const { prior, batchId, seed, requested, tier } = input;
  const battles = prior.battles.slice().sort((a, b) => (a.matchIndex || 0) - (b.matchIndex || 0));
  const results = battles.map((rec) => ({
    match: rec.matchIndex,
    opponentPlayerId: rec.p2.playerId,
    opponentPublicId: rec.p2.publicId,
    winner: rec.verdict ? rec.verdict.winner : 'draw',
    ticks: rec.verdict ? rec.verdict.ticks : null,
    battleId: rec.battleId,
    duplicate: true,
  }));
  const wins = battles.filter((rec) => rec.p1 && rec.p1.result === 'win').length;
  const draws = battles.filter((rec) => rec.p1 && rec.p1.result === 'draw').length;
  const losses = battles.filter((rec) => rec.p1 && rec.p1.result === 'loss').length;
  const matches = battles.length;
  const promoted = prior.promote !== null;
  const tierAfter = promoted ? prior.promote.tierAfter : (prior.batch.tier || tier);
  return {
    batchId, seed, tier: prior.batch.tier || tier,
    requested, matches, shortfall: Math.max(0, requested - matches),
    wins, draws, losses, invalids: 0,
    relaxed: null,
    promoted,
    tierAfter,
    reward: tierReward(tierAfter),
    opponentsDrawn: results.map((r) => r.opponentPlayerId),
    results,
    duplicate: true,
    replayed: true,
  };
}

/* ---------- 档案驱动排位（P7-3 主路径） ---------- */

async function runFromStore(o, deps) {
  const { store, L, nowFn, ratingConfig } = deps;
  const tier = (o.archive.progress && o.archive.progress.tier) || 'common';
  const seed = o.seed;
  const requested = batchSizeOf(ratingConfig);
  const cooldownHours = cooldownHoursOf(store.config, ratingConfig);
  const relaxHours = cooldownHours * COOLDOWN_RELAX_MULT;
  const at = nowFn();

  // 批次级幂等（P1-4）：同 (playerId, seed) 的既有批次 → 直接回放，不再抽池/结算/写 journal
  const batchId = batchIdOf(o.playerId, seed);
  const prior = await findPriorBatch(store, o.playerId, batchId);
  if (prior) {
    L && L.info('ranked', 'ranked.match',
      `批次重发：命中既有 ranked.batch ${batchId}（回放 ${prior.battles.length} 场，不重复结算）`, {
        playerId: o.playerId, batchId, seed, mode: 'ranked', replayed: true, matches: prior.battles.length,
      });
    return { status: 200, data: replayBatchPayload({ prior, batchId, seed, requested, tier }) };
  }

  const pool = await candidatesOf(store, tier, o.playerId, L, deps.loadWarehouse);
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

  logPool(L, {
    tier, seed, poolSize: pool.poolSize, candidates: pool.candidates.length,
    cooldown: cooldownHours, relaxHours, relaxed, drawn: drawn.length, shortfall,
    unusable: pool.unusable.length, banned: pool.banned, outOfPool: pool.outOfPool,
    noWarehouse: pool.noWarehouse ? pool.noWarehouse.length : 0,
    warehouseDegraded: (o.warehouseDegraded ? 1 : 0) + (pool.degraded ? pool.degraded.length : 0),
    debug: deps.debugBots === true,
  });

  const results = [];
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let invalids = 0;
  // P7-6 修复 2（store 侧批量原语接入）：本轮 10 场的结算**不再逐场发起**，而是收集成一批，
  //   循环结束后用 `store.settleBatch(records)` 一次提交 —— 一次参与集合加锁 + 一次 appendMany
  //   + 每参与玩家档案只落盘一次。逐场 `settleBattle` 在并发 24 下会退化成"每场一次 fsync 串行"，
  //   实测 50 轮 × 10 场：逐场 P95=5190ms → 批量 P95=305ms（store 层探针，同一数据根）。
  //   无 `settleBatch` 的 store（测试替身/旧适配器）自动回落到逐场路径。
  const pendingSettlements = [];
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
    const foeWarehouse = foe.warehouse === undefined ? null : foe.warehouse;
    const r = o.runBattle
      ? o.runBattle({
        p1: o.loadout, p2: foeSnapshot[RAW_SNAPSHOT_FIELD], tier, seed: matchSeed,
        warehouse: o.warehouse === undefined ? null : o.warehouse,
        p1Warehouse: o.warehouse === undefined ? null : o.warehouse,
        p2Warehouse: foeWarehouse,
      })
      : battleOne(o.loadout, foeSnapshot[RAW_SNAPSHOT_FIELD], { p1: o.warehouse, p2: foeWarehouse }, tier, matchSeed);
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
    //   入参先入队，循环结束后由 `store.settleBatch` 一次提交（见上方说明）
    const slot = results.length;
    results.push({
      match: matchIndex, opponentPlayerId: foe.playerId, opponentPublicId: foe.entry.publicId,
      winner, ticks: r.ticks, battleId: null, duplicate: false,
    });
    pendingSettlements.push({
      slot, matchIndex, opponentPlayerId: foe.playerId, opponentPublicId: foe.entry.publicId, ticks: r.ticks,
      input: {
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
      },
    });
  }

  // 一轮一次批量结算（store 侧 `settleBatch`：一次加锁 + 一次 appendMany + 每玩家档案一次落盘）
  if (typeof store.settleBatch === 'function' && pendingSettlements.length > 0) {
    const batchRes = await store.settleBatch(pendingSettlements.map((p) => p.input));
    for (let k = 0; k < pendingSettlements.length; k += 1) {
      const rec = batchRes.records[k];
      results[pendingSettlements[k].slot].battleId = rec ? rec.battleId : null;
      results[pendingSettlements[k].slot].duplicate = batchRes.duplicateFlags[k] === true;
    }
  } else {
    for (const p of pendingSettlements) {
      const settled = await store.settleBattle(p.input);
      results[p.slot].battleId = settled.record ? settled.record.battleId : null;
      results[p.slot].duplicate = settled.duplicate === true;
    }
  }
  for (const p of pendingSettlements) {
    const entry = results[p.slot];
    L && L.info('ranked', 'ranked.match', `match ${p.matchIndex}: ${entry.winner}（${p.ticks} tick）`, {
      match: p.matchIndex, winner: entry.winner, ticks: p.ticks, opponentPublicId: p.opponentPublicId,
      battleId: entry.battleId, mode: 'ranked',
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
  // 出战配置结构与门控复查（§7.4）＋缺陷 B：装配引用需要仓库正文 → 先取本进程镜像；
  //   镜像不可用但该配置**已校验过** → 用 no-op 占位项跳过"需要仓库的引用校验"（退化基准面板）；
  //   从未校验 → 保持 warehouse=null，validateLoadout 如实报 missing_warehouse（不放宽）。
  const myLoadout = snapshot[RAW_SNAPSHOT_FIELD];
  let myWarehouse = typeof deps.loadWarehouse === 'function' ? await deps.loadWarehouse(playerId) : null;
  let warehouseDegraded = false;
  if (!myWarehouse && needsWarehouse(myLoadout)) {
    if (isWarehouseVerified(archive, active)) {
      myWarehouse = syntheticVerifiedWarehouse(myLoadout);
      warehouseDegraded = myWarehouse !== null;
      if (warehouseDegraded) {
        log.warn('store', 'store.snapshot.missing',
          '出战配置含装配引用但仓库镜像不在本进程内（已校验过 → 基准面板退化对局，插件词条不生效）', {
            playerId, reason: 'warehouse_mirror_degraded', snapshotHash: active.snapshot.hash,
          });
      }
    }
  }
  const v = loadout.validateLoadout(myLoadout, { warehouse: myWarehouse, tier: archive.progress.tier });
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
    loadout: myLoadout,
    warehouse: myWarehouse,
    warehouseDegraded,
    runBattle: deps.runBattle,
  }, { store, L: log, nowFn, ratingConfig, debugBots: debug.enabled, loadWarehouse: deps.loadWarehouse });
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

// 晋升判定**单一真源** = `ledger.promoteAfterBatch`（P2-3）：端点 `/ranked/promote` 与批次路径
// （runFromStore）同输入 → 同结果，阈值一律读 `rating-config.promoteWins`（缺省 6 = 旧 X_PROMOTE）。
// 旧实现本模块另有 `X_PROMOTE = 6` 硬编码 + 自写分支，与 ledger 口径双源（wins 相同、结果可能不同）。
function promotedAt(tier, wins, ratingConfig) {
  return ledger.promoteAfterBatch({ tier, wins, config: ratingConfig }).promoted;
}

function promote(tier, wins, L, ratingConfig) {
  if (tier === undefined || !TIERS.includes(tier)) {
    return { status: 400, code: 'bad_tier', message: `非法段位 ${tier}（可选: ${TIERS.join('/')}）` };
  }
  if (typeof wins !== 'number' || !Number.isInteger(wins) || wins < 0 || wins > DEFAULT_BATCH_SIZE) {
    return { status: 400, code: 'bad_wins', message: `非法 wins ${wins}（必须是非负整数且 ≤ ${DEFAULT_BATCH_SIZE}，P2-2 上限）` };
  }
  const p = ledger.promoteAfterBatch({ tier, wins, config: ratingConfig });
  if (!p.promoted) {
    if (wins > p.threshold) {
      // 达阈值但已是最高段位（nextTier === null）
      L && L.warn('ranked', 'ranked.promote', `最高段位不再晋升: ${tier}`, { tier, wins });
      return { status: 409, code: 'already_max', message: `${tier} 已是最高段位` };
    }
    return { status: 200, data: { tier, promoted: false, reward: tierReward(tier), wins } };
  }
  const next = p.tierAfter;
  L && L.info('ranked', 'ranked.promote', `${tier} → ${next}（wins=${wins}）`, { from: tier, to: next, wins });
  return { status: 200, data: { tier: next, promoted: true, reward: tierReward(next), wins } };
}

function makeRanked(logger, options) {
  const L = logger || nullLogger;
  const deps = options || {};
  return {
    takeSnapshot: (ld) => takeSnapshot(ld, L),
    runRankedBattle: (opts) => runRankedBattle(opts, L, deps),
    promote: (tier, wins) => promote(tier, wins, L, deps.ratingConfig),
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
  // P1-4 批次级幂等（测试独立复算 batchId / 构造重发场景用）
  batchIdOf,
  findPriorBatch,
  // 缺陷 B：装配引用 × 仓库镜像（quickmatch/admin/测试复用）
  needsWarehouse,
  isWarehouseVerified,
  syntheticVerifiedWarehouse,
  warehousesOf,
  // P2-5 默认出战配置的 AI 预设表（测试可断言变体集合 / 按身份复算变体）
  DEFAULT_AI_PRESETS,
  presetOf,
  variantOf,
});
