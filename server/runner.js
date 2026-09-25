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
const skillsMod = require('./core/skills.js');
const loadoutApi = require('./loadout.js'); // P1-3：面板聚合单一实现（loadout 不 require 本模块 → 无环）
const { createLogger, nullLogger } = require('../shared/log.js');
const crypto = require('node:crypto');

const BATTLE_CFG = require('./data/battle-config.json');

// 技能实例化基准 rng（与 server/battle.js / server/loadout.js 同一口径：确定性、不消费随机流）
const STUB_RNG = { float: () => 1, int: () => 0, pick: () => 0 };
const SKILL_TEMPLATE_IDS = new Set(require('./data/skill-templates.json').skillTemplates.map((s) => s.id));

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
//   self.cooldowns.<slotKey>          number（只读副本；未装配技能不在其中）
//     键语义（P1-4 裁定，2026-09-19）：**槽位键 `skill1..3`**（= AI 动作名 `skill:<槽位>` 的槽位，
//     也是引擎冷却键）；不再是模板 id——`sys/08-ai` §4.5 的字段说明需同步。旧快照缺该键 → 读到 null。
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

/* ---------- 守方镜像（用户 2026-09-25 口径；D-164） ----------
 * 规则：**每个玩家都在自己的 p1 坐标系里思考**。p2（右侧、facing=−1）的 AI 拿到的是**镜像世界**：
 *   x' = fieldPx − x、facing' = −facing、effects[].displacement' = −displacement；
 *   它产出的方向动作再**反镜像**回真实世界（move_left↔move_right、dodge_left↔dodge_right）。
 * 为什么不是"只翻动作名"（实测反例，2026-09-25 探针）：
 *   出厂默认/新手 AI（ranked.buildDefaultLoadout，所有新号与 bot 都用它）用**有符号距离**
 *   `enemy.x − self.x` 选绝对方向，两侧本来就自洽；若只翻输出动作，p2 会掉头退回自己基地角、
 *   永不交战（实测：默认 AI 当守方从 800 退到 992，整场不开火）。
 *   完整镜像对这类"方向无关"程序是**恒等变换**（实测逐 tick 帧完全一致），
 *   而对"按 p1 坐标写死方向"的玩家程序（永远 move_right、self.x<500→move_right、看 facing 转身）
 *   才产生正确行为。`turn`（自反）、`wait`/`defend`（无方向）、`skill:<槽位>`（方向取自 facing）不参与映射。
 * 范围：仅**玩家编写的出战配置 AI**。内置对手 OPPONENTS（runner.js 下方，写死 p2 语义、且不经
 *   runtime.resume）与 `/ai/battle` 的 p2 一律不镜像。
 */
const MIRROR_ACTION = Object.freeze({
  move_left: 'move_right',
  move_right: 'move_left',
  dodge_left: 'dodge_right',
  dodge_right: 'dodge_left',
});

function mirrorSnapshot(snapshot) {
  const snap = snapshot;
  if (!snap || typeof snap !== 'object') return snap;
  const W = snap.field && typeof snap.field.fieldPx === 'number' ? snap.field.fieldPx : BATTLE_CFG.fieldPx;
  const flip = (side) => {
    if (!side || typeof side !== 'object') return side;
    const out = Object.assign({}, side);
    if (typeof side.x === 'number') out.x = W - side.x;
    if (typeof side.facing === 'number') out.facing = -side.facing;
    out.effects = (Array.isArray(side.effects) ? side.effects : []).map((e) => {
      const c = Object.assign({}, e);
      if (typeof c.displacement === 'number') c.displacement = -c.displacement;
      return c;
    });
    return out;
  };
  // 只镜像绝对量（x/facing/位移）；self/enemy 的归属、bases、field、cooldowns、五维与资源都不变
  return {
    tick: snap.tick,
    self: flip(snap.self),
    enemy: flip(snap.enemy),
    bases: snap.bases,
    field: snap.field,
  };
}

// 反镜像：把"镜像世界里产出的动作"翻译回真实世界（未登记的动作名原样返回，交由引擎按 D-80 归一化）
function unmirrorAction(action) {
  const name = typeof action === 'string' && action !== '' ? action : 'wait';
  return MIRROR_ACTION[name] || name;
}

// 共享 AI 驱动：p1 直通；p2 走"镜像快照 → 执行 → 反镜像动作"。
// 排位/快速（ranked.battleOne）与 /battle·回放重算（battle.runBattle）都必须用它，避免两处实现漂移。
function makeAiDriver(built) {
  const owner = built.player.owner;
  const mirrored = owner === 'p2';
  return (state) => {
    const snap = projectSnapshot(state, owner);
    const view = mirrored ? mirrorSnapshot(snap) : snap;
    const r = runtime.resume(built.ctx, view, state.rng.deriveStream(state.tick, 'ai'));
    return mirrored ? unmirrorAction(r.action) : r.action;
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

/* ---------- P1-3：p1 技能槽装配（可选入参；缺省 = baseline，黄金快照零回归） ----------
 * 背景：`baselinePlayer` 无 `skills` → 任何 `skill:*` 恒 `unknown_skill`，技能类 AI 在 /ai/battle
 *       **没有任何通过路径**（实测 62/62 ineffective）。修法：新增可选 `skills`（或 `loadout`）入参。
 * 口径：
 *   · `skills` —— 数组（下标 i → 槽位键 `skill${i+1}`，与 `server/battle.js` 的 `p.skills` 键、
 *     AI 动作名 `skill:<槽位>`、P1-4 的**槽位冷却键**三者同源）或对象（键即槽位键）。
 *     元素 = 模板 id 字符串，或 `{templateId, quality?, params?}`（loadout 形态的技能项）。
 *   · `loadout` —— 出战配置全文（role + skills + ai）：走 `loadout.buildPanel` **面板聚合单一实现**
 *     （与 /panel、/battle 同源，含插件词条；含 `slots[].pluginUid` 时需 `warehouse`）。
 *   · `skills` 与 `loadout` **互斥**（都给了 → 400 bad_request，避免"参数取舍"隐式规则）。
 *   · 两者皆不给 → 逐字节沿用 `baselinePlayer('p1')`（既有 62/62 unknown_skill 语义不变）。
 * 说明：本端点用于**验证 AI 程序**，不落盘、不记账；技能实例的参数由调用方给定（`params`）或由
 *   `loadout` 面板聚合得出，模板参数随机一律走 STUB_RNG（确定性，不消费随机流）。
 */
function normalizeSkillSlots(input) {
  if (Array.isArray(input)) {
    if (input.length === 0) return { slots: [] };
    if (input.length > 3) {
      return { error: { path: 'skills', code: 'bad_skills', message: `技能槽最多 3 个（loadout 口径），实得 ${input.length}` } };
    }
    return { slots: input.map((item, i) => ({ key: `skill${i + 1}`, item, path: `skills[${i}]` })) };
  }
  if (input && typeof input === 'object') {
    const keys = Object.keys(input);
    if (keys.length > 3) {
      return { error: { path: 'skills', code: 'bad_skills', message: `技能槽最多 3 个（loadout 口径），实得 ${keys.length}` } };
    }
    return { slots: keys.map((k) => ({ key: k, item: input[k], path: `skills.${k}` })) };
  }
  return { error: { path: 'skills', code: 'bad_skills', message: 'skills 必须是数组（下标 → skill1..3）或对象（键即槽位键）' } };
}

// 单个槽条目 → {templateId, quality, params} | {error}
function slotSpecOf(slot) {
  const raw = slot.item;
  if (typeof raw === 'string') return { templateId: raw, quality: 'common', params: null };
  if (raw && typeof raw === 'object') {
    const templateId = raw.templateId === undefined ? null : raw.templateId;
    if (typeof templateId !== 'string' || templateId === '') {
      return { error: { path: `${slot.path}.templateId`, code: 'bad_skills', message: '技能槽缺少 templateId' } };
    }
    if (raw.params !== undefined && raw.params !== null && typeof raw.params !== 'object') {
      return { error: { path: `${slot.path}.params`, code: 'bad_skills', message: 'params 必须是对象' } };
    }
    return { templateId, quality: typeof raw.quality === 'string' && raw.quality !== '' ? raw.quality : 'common', params: raw.params || null };
  }
  return { error: { path: slot.path, code: 'bad_skills', message: '技能槽元素必须是模板 id 字符串或 {templateId, quality?, params?} 对象' } };
}

// p1 玩家：{ok, player, source:'baseline'|'explicit'|'archive', slots:[…]} | {ok:false, status, code, details}
function playerOneOf(opts) {
  const hasSkills = opts.skills !== undefined && opts.skills !== null;
  const hasLoadout = opts.loadout !== undefined && opts.loadout !== null;
  if (hasSkills && hasLoadout) {
    return {
      ok: false, status: 400, code: 'bad_request',
      details: [{ path: 'skills', code: 'conflict', message: 'skills 与 loadout 互斥：只能给其一（loadout 已含技能槽）' }],
    };
  }
  if (!hasSkills && !hasLoadout) {
    return { ok: true, player: baselinePlayer('p1'), source: 'baseline', slots: [] };
  }
  const base = baselinePlayer('p1');
  const p = { ...base };
  let specs = [];
  if (hasLoadout) {
    if (typeof opts.loadout !== 'object') {
      return { ok: false, status: 400, code: 'loadout_invalid', details: [{ path: 'loadout', code: 'loadout_invalid', message: 'loadout 必须是对象' }] };
    }
    const panel = loadoutApi.buildPanel(opts.loadout, { warehouse: opts.warehouse || null, tier: opts.tier || 'mythic' });
    if (!panel.ok) return { ok: false, status: 409, code: 'loadout_invalid', details: panel.errors };
    const role = panel.panel.role;
    p.hp = role.stats.hp; p.maxHp = role.stats.hp;
    p.mp = role.stats.mp; p.maxMp = role.stats.mp;
    p.sp = role.stats.sp; p.maxSp = role.stats.sp;
    p.atk = role.stats.atk; p.def = role.stats.def;
    if (role.regen) p.regen = role.regen;
    if (role.special) p.special = role.special;
    specs = (opts.loadout.skills || []).map((item, i) => ({
      key: `skill${i + 1}`, templateId: item && item.templateId, quality: (item && item.quality) || 'common',
      params: panel.panel.skills[i] ? panel.panel.skills[i].params : null, path: `loadout.skills[${i}]`,
    }));
  } else {
    const norm = normalizeSkillSlots(opts.skills);
    if (norm.error) return { ok: false, status: 400, code: 'bad_skills', details: [norm.error] };
    const details = [];
    specs = norm.slots.map((slot) => {
      const spec = slotSpecOf(slot);
      if (spec.error) { details.push(spec.error); return null; }
      return { key: slot.key, ...spec, path: slot.path };
    }).filter(Boolean);
    if (details.length > 0) return { ok: false, status: 400, code: 'bad_skills', details };
  }
  const bad = [];
  const skills = {};
  for (const spec of specs) {
    if (typeof spec.templateId !== 'string' || !SKILL_TEMPLATE_IDS.has(spec.templateId)) {
      bad.push({ path: `${spec.path}.templateId`, code: 'unknown_skill', message: `未知技能模板 ${spec.templateId}（skill-templates.json 未登记）` });
      continue;
    }
    const inst = skillsMod.instantiateSkill(spec.templateId, spec.quality, STUB_RNG);
    skills[spec.key] = spec.params ? Object.assign(inst, spec.params) : inst;
  }
  if (bad.length > 0) return { ok: false, status: 400, code: 'bad_skills', details: bad };
  p.skills = skills;
  return { ok: true, player: p, source: opts.loadoutSource === 'archive' ? 'archive' : 'explicit', slots: specs.map((s) => s.key) };
}

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
  // P1-3：p1 = baseline（缺省）或调用方给定的技能槽/出战配置（见 playerOneOf 的口径说明）
  const p1res = playerOneOf(opts);
  if (!p1res.ok) {
    return { status: p1res.status || 400, code: p1res.code, details: p1res.details, message: p1res.code === 'loadout_invalid' ? 'loadout 不合法（与 /panel、/battle 同源校验）' : '技能槽入参不合法' };
  }
  const p1 = p1res.player;
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
  // 计数口径**单源**（2026-09-19 审查修复）：帧级 `actions` 与顶层 `actionsEffective/ineffectiveActions`
  //   都取自 countActions 的 (owner,tick) 去重结果——此前帧级用"事件条数"、顶层用"去重动作数"，
  //   同一动作产生两条 warn 时两个数字会互相打架（同一件事两套计数）。
  //   帧内事件必为该 tick 的事件（引擎按 `r.tick === tick` 切帧），故按 tick 取用与顶层口径逐帧一致。
  const agg = countActions(result.diffs, battleEvents);
  const ineffByTick = new Map(); // tick → p1 未生效**动作**数（已按 (owner,tick) 去重）
  for (const a of agg.ineffectiveActions.actions) {
    if (a.owner !== 'p1') continue;
    ineffByTick.set(a.tick, (ineffByTick.get(a.tick) || 0) + 1);
  }
  const frames = result.diffs.map((d) => {
    const events = (d.events || []).filter(isObservableActionEvent);
    const ineff = ineffByTick.get(d.tick) || 0;
    return {
      tick: d.tick,
      players: d.players,
      collision: d.collision || null,
      bulletHits: d.bulletHits,
      verdict: d.verdict || null,
      aiTrace: d.aiTrace, // 冻结字段名（interfaces §4.3 diff.aiTrace[]，P2-6 对齐）
      actions: { effective: Math.max(0, 1 - ineff), ineffective: ineff },
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
      // P1-3（附加字段，向后兼容）：p1 技能槽来源与槽位键，便于调用方自证"技能类 AI 真的被装配了"
      skillSource: p1res.source,
      skillSlots: p1res.slots,
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
// **字段口径（2026-09-19 审查澄清，避免同一字段两处解释）**：
//   · `ineffectiveActions.count` / `byOwner` / `byReason` / `causes` 覆盖**全部 owner**（含对手）。
//     当前对手是内置机器人，实际恒为 0；但**不要**假设"计数只含 p1"（P7-3 接入真实玩家后 p2 会贡献）。
//   · `actionsEffective` 与 `frames[].actions` **只统计 p1**（玩家方；= 帧数 − p1 去重后未生效动作数）。
//     因此 `actionsEffective + ineffectiveActions.count` 不必然等于帧数——两者口径不同，各自带定义。
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

module.exports = { compileAi, runAiBattle, playerOneOf, projectSnapshot, OPPONENTS, baselinePlayer, takeTrace, countActions, isObservableActionEvent, mirrorSnapshot, unmirrorAction, makeAiDriver, MIRROR_ACTION };