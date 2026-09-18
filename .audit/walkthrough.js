'use strict';
/* .audit/walkthrough.js —— 走查文档（docs/battle-walkthrough.md §3.1）的可复算基准
 *
 * 目的：让 §3.1 的逐 tick 轨迹**完全来自真实引擎**，而不是设计期手算。
 * 场景来源（决策依据见报告）：`docs/battle-walkthrough.md` §2 只给了面板/技能名与片段，
 *   缺插件 uid/品质/词条值/AI 程序 → **无法无歧义重建**；因此本脚本以
 *   `.audit/golden-battle.json`（gate 项 8 在用、seed 20260912、固定 loadout×固定行动计划）
 *   的既有场景为准，并把 §3.1 改写成该场景的轨迹（文中显式标注"本节基准 = 黄金战斗场景"）。
 *
 * 复算内容：
 *   ① 真实引擎跑完整场（createBattle + runFull，注入事件记录 logger），逐 tick 打印
 *      双方行动 / 结束时 x·hp·mp·sp·facing / 跨系统事件（弹幕生成·抵消·命中、碰撞、伤害、verdict）。
 *   ② 与 `.audit/golden-battle.json` 逐字段比对（防脚本与 gate 项 8 漂移）。
 *   ③ 用真实技能对象 + `field` 公式复算火球术（vertical）落点，检验"落点 288"这一说法。
 *   ④ 用引擎的 `normalizeAction` 检验 `turn` 是否合法（ACTIONS 白名单）。
 *
 * 输出：人类可读表格（stdout）+ 机器可校验 `.audit/walkthrough.json`。
 * 用法：`node .audit/walkthrough.js`。退出码：0=与黄金快照一致；1=漂移。
 * 依赖：仅 `node:fs` / `node:path`（Node 内建）+ `../server/core/engine.js`、`../server/core/skills.js`、
 *   `../server/core/field.js`、`../server/data/*.json`。**无 child_process、无 Math.random**（内核铁律）。
 */
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../server/core/engine.js');
const skillsMod = require('../server/core/skills.js');
const field = require('../server/core/field.js');

const SEED = 20260912; // 与 .audit/golden-battle.js 同源（gate 项 8）
const SNAPSHOT = path.join(__dirname, 'golden-battle.json');
const OUT_JSON = path.join(__dirname, 'walkthrough.json');

/* ---------------------------------------------------------------- 场景重建（镜像 .audit/golden-battle.js） */
// 固定面板：不走任何随机生成（黄金锚定）
function mkPlayer(P) {
  return {
    id: P === 'p1' ? 'A' : 'B', owner: P,
    x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
    hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
    atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9,
    regen: { mp: 1, sp: 2 }, special: { critChance: 0, dodgeChance: 0, lifesteal: 0 },
    cooldowns: {}, effects: [],
  };
}

// 固定技能实例：模板走 items.generateSkillItem（系数固定 1.00）→ 与黄金战斗同一实例化路径
function skillOf(templateId, overrides) {
  const sk = skillsMod.instantiateSkill(templateId, 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 });
  return Object.assign(sk, overrides || {});
}

// 行动计划：tick → 行动（镜像 .audit/golden-battle.js makeActionPlan）
function makeActionPlan() {
  const plan = {
    p1: ['dodge_right', 'move_left', 'wait', 'skill:precise', 'move_right', 'skill:precise', 'dodge_left', 'wait',
         'move_right', 'move_left', 'skill:precise', 'dodge_right', 'wait', 'move_left', 'skill:precise', 'dodge_left',
         'move_right', 'wait', 'move_left', 'skill:precise', 'dodge_right', 'move_right', 'wait', 'skill:precise',
         'dodge_left', 'move_left', 'wait', 'dodge_right', 'move_right', 'skill:precise', 'wait', 'move_left',
         'dodge_left', 'skill:precise', 'wait', 'move_right', 'dodge_right', 'wait', 'move_left', 'skill:precise'],
    p2: ['move_left', 'wait', 'skill:bash', 'dodge_left', 'move_right', 'wait', 'skill:bash', 'dodge_right',
         'wait', 'move_left', 'skill:bash', 'wait', 'dodge_right', 'move_left', 'skill:bash', 'wait',
         'dodge_left', 'move_right', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'skill:bash', 'wait',
         'move_right', 'wait', 'dodge_left', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'skill:bash',
         'wait', 'move_right', 'dodge_left', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'wait'],
  };
  return {
    plan,
    actions: {
      p1: (state) => plan.p1[state.tick - 1] || 'wait',
      p2: (state) => plan.p2[state.tick - 1] || 'wait',
    },
  };
}

function buildScenario() {
  const p1 = mkPlayer('p1');
  const p2 = mkPlayer('p2');
  p1.special.critChance = 0.5; // 暴击流被真实消费（确定性由 seed 保证）
  p1.skills = { precise: skillOf('skill_straight_precise', { multiplier: 1.0 }) };
  p2.skills = { bash: skillOf('skill_dash_bash', { multiplier: 1.3, distance: 4, passThroughEnemy: false, dealDamage: true }) };
  return { p1, p2 };
}

/* ----------------------------------------------------------------------------------- 事件捕获（真实引擎日志） */
// 引擎 createBattle 只要求 logger 具备各等级方法；可选 log() 用于逐条记录（含 tick/cid 装饰）
const EVENT_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

function makeCapture() {
  const events = [];
  const logger = { records: events };
  for (const lv of EVENT_LEVELS) {
    logger[lv] = (channel, event, msg, data) => { events.push({ level: lv, channel, event, msg, data: data || {} }); };
  }
  logger.log = (level, channel, event, msg, data) => { events.push({ level, channel, event, msg, data: data || {} }); };
  return logger;
}

// 引擎 14 步自身噪声（每 tick 14 条）不进入走查表
const ENGINE_NOISE = new Set(['tick.step', 'tick.begin', 'tick.end', 'battle.create', 'rng.create', 'rng.stream', 'rng.draw', 'skill.instantiate']);

function keyEventsOf(events, tick) {
  return events
    .filter((r) => r.data && r.data.tick === tick && !ENGINE_NOISE.has(r.event))
    .map((r) => ({ level: r.level, channel: r.channel, event: r.event, msg: r.msg, cid: r.data.cid || null, data: r.data }));
}

/* ------------------------------------------------------------------------------------- 真实引擎跑一整场 */
function runScenario() {
  const { p1, p2 } = buildScenario();
  const logger = makeCapture();
  const battle = engine.createBattle(undefined, { seed: SEED, players: { p1, p2 }, logger });
  const { actions, plan } = makeActionPlan();
  // runFull 内部逐 tick step；eventsBuf 不需要（本脚本直接按 tick 过滤 logger 记录）
  const result = battle.runFull({ actions });

  const ticks = result.diffs.map((d) => {
    const tick = d.tick;
    const evs = keyEventsOf(logger.records, tick);
    const dmg = evs.filter((e) => e.event === 'damage.calc').map((e) => e.data);
    return {
      tick,
      rawAction: { p1: plan.p1[tick - 1] || 'wait', p2: plan.p2[tick - 1] || 'wait' },
      p1: { fromX: d.players.p1.fromX, x: d.players.p1.toX, facing: d.players.p1.facing, hp: d.players.p1.hp, mp: d.players.p1.mp, sp: d.players.p1.sp },
      p2: { fromX: d.players.p2.fromX, x: d.players.p2.toX, facing: d.players.p2.facing, hp: d.players.p2.hp, mp: d.players.p2.mp, sp: d.players.p2.sp },
      bases: { p1: d.bases.p1.hp, p2: d.bases.p2.hp },
      // 注意：回放帧 bullets[] 契约不含 srcType（engine.js 快照白名单），srcType 只在 bullet.hit 事件里
      bulletsOnField: (d.bullets || []).map((b) => ({ uid: b.uid, owner: b.owner, type: b.type, level: b.level, dir: b.dir, x0: b.x })),
      bulletHits: d.bulletHits.map((h) => ({ uid: h.uid, target: h.target, atX: h.atX })),
      collision: d.collision ? d.collision.contactX : null,
      damage: dmg.map((v) => ({ attacker: v.attacker, target: v.target, mult: v.mult, reduction: v.reduction, backM: v.backM, critM: v.critM, backstab: v.backstab, crit: v.crit, raw: v.raw, dmg: v.dmg, lifesteal: v.lifesteal, hitUid: v.hitUid })),
      verdict: d.verdict ? { winner: d.verdict.winner, phase: d.verdict.phase } : null,
      events: evs.map((e) => ({ level: e.level, channel: e.channel, event: e.event, cid: (e.data && e.data.cid) || null, msg: e.msg, atX: (e.data && e.data.atX !== undefined) ? e.data.atX : null, uid: (e.data && e.data.uid) || null, winner: (e.data && e.data.winner) || null })),
      rawEvents: evs,
    };
  });

  return {
    summary: {
      seed: SEED,
      ticks: result.ticks,
      winner: result.winner,
      phase: battle.state.verdict ? battle.state.verdict.phase : null,
      finalHp: { p1: battle.state.players.p1.hp, p2: battle.state.players.p2.hp },
    },
    ticks,
    logCount: logger.records.length,
  };
}

/* --------------------------------------------------------------------------------- 与黄金快照逐字段比对 */
function compareWithGolden(run) {
  if (!fs.existsSync(SNAPSHOT)) return { ok: false, reason: '缺少 .audit/golden-battle.json' };
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
  const cur = {
    seed: run.summary.seed,
    ticks: run.summary.ticks,
    winner: run.summary.winner,
    phase: run.summary.phase,
    frames: run.ticks.map((t) => ({
      t: t.tick,
      p1: { x: t.p1.x, hp: t.p1.hp, mp: t.p1.mp, sp: t.p1.sp },
      p2: { x: t.p2.x, hp: t.p2.hp, mp: t.p2.mp, sp: t.p2.sp },
      collision: t.collision,
      hits: t.bulletHits.map((h) => ({ uid: h.uid, target: h.target, atX: h.atX })),
    })),
  };
  const a = JSON.stringify(snap);
  const b = JSON.stringify(cur);
  return { ok: a === b, reason: a === b ? null : '与 golden-battle.json 不一致（引擎/场景漂移）', snapshot: snap };
}

/* ------------------------------------------------- 火球术落点复算（vertical 分支：clampX + cellRange） */
// 落点 = clampX(caster.x + caster.facing × range × 64)。P2 起点 800 / facing −1 与 P1 起点 224 / facing +1
// 都算一遍（避免把"谁的技能"弄混）。
function fireballCheck() {
  const sk = skillsMod.instantiateSkill('skill_vert_fireball', 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 });
  const cast = (x, facing) => {
    const act = skillsMod.buildSkillAction(sk, { x, facing });
    const raw = x + facing * sk.range * field.CELL_PX;
    return {
      casterX: x, casterFacing: facing,
      expression: `clampX(${x} + (${facing}) * ${sk.range} * ${field.CELL_PX})`,
      unclamped: raw, impactX: act.impactX, impactCell: field.cellOf(act.impactX),
      clamped: act.impactX !== raw, xCenters: act.bullets.map((b) => b.x0),
    };
  };
  return {
    template: sk.templateId,
    name: sk.name,
    type: sk.type,
    rangeCells: sk.range,
    area: sk.area,
    bulletLevel: sk.bulletLevel,
    p2AtDocPosition: cast(800, -1), // §3.1/§3.2 里火球术的施法者 = P2（起点 800、朝向 −1）
    p1AtDocPosition: cast(224, 1),  // 若误把施法者当成 P1（起点 224、朝向 +1）
  };
}

/* ------------------------------------------------------------------------- 行动白名单校验（ACTIONS + normalizeAction） */
// 通过真实 createBattle 暴露的 normalizeAction 判断行动是否合法（非法 → wait）
function actionLegality() {
  const { p1, p2 } = buildScenario();
  const b = engine.createBattle(undefined, { seed: SEED, players: { p1, p2 } });
  const probe = ['move_left', 'move_right', 'dodge_left', 'dodge_right', 'wait', 'defend', 'turn', 'skill:precise', 'skill:bash', 'skill1'];
  return probe.map((raw) => ({ raw, normalized: b.normalizeAction(raw) }));
}

/* ------------------------------------- §3.2 示例场景复算：位移路径弹幕 ⇄ 敌方竖直技能 AOE 抵消 */
// 说明：这是 §3.2 的**设计期示例**（P1 突击盾 224→480 vs P2 火球术），不是黄金战斗场景。
// 全部走真实 helper：skills.buildSkillAction 生成弹幕规格 → bullets.resolveBullets 解算 →
// 命中伤害用 battle-config 常数按引擎公式（defender def 未 defend 时不放大）确定性计算。
function collisionExample() {
  const bulletsMod = require('../server/core/bullets.js');
  const cfg = require('../server/data/battle-config.json');
  const dash = Object.assign(skillsMod.instantiateSkill('skill_dash_bash', 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }),
    { multiplier: 1.3, distance: 4, passThroughEnemy: false, dealDamage: true });
  const ball = skillsMod.instantiateSkill('skill_vert_fireball', 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 });
  const dashAct = skillsMod.buildSkillAction(dash, { x: 224, facing: 1 });
  const ballAct = skillsMod.buildSkillAction(ball, { x: 800, facing: -1 });

  const state = { bullets: [], rng: { deriveStream: () => ({ chance: () => false }) } };
  bulletsMod.spawnBullets(state, Object.assign({ owner: 'p1' }, dashAct));
  bulletsMod.spawnBullets(state, Object.assign({ owner: 'p2' }, ballAct));
  const spawned = state.bullets.map((b) => ({ uid: b.uid, owner: b.owner, level: b.level, x0: b.x0, srcType: b.srcType }));
  const ev = bulletsMod.resolveBullets(state, {
    actors: [{ id: 'p1', owner: 'p1', x1: 224, x2: 480, hp: 100, fullDodge: false },
      { id: 'p2', owner: 'p2', x1: 800, x2: 800, hp: 100, fullDodge: false }],
  });
  // 变体：P1 留在起点不动（224）→ 检验"孤立的第 3 枚 AOE 是否命中 P1"（设计示例断言"P1 未被火球命中"）
  const state2 = { bullets: [], rng: { deriveStream: () => ({ chance: () => false }) } };
  bulletsMod.spawnBullets(state2, Object.assign({ owner: 'p1' }, dashAct));
  bulletsMod.spawnBullets(state2, Object.assign({ owner: 'p2' }, ballAct));
  const ev2 = bulletsMod.resolveBullets(state2, {
    actors: [{ id: 'p1', owner: 'p1', x1: 224, x2: 224, hp: 100, fullDodge: false },
      { id: 'p2', owner: 'p2', x1: 800, x2: 800, hp: 100, fullDodge: false }],
  });
  // 变体 2：只有火球术（无位移弹幕参与抵消）→ 检验"P1 未被火球命中"这一断言
  const state3 = { bullets: [], rng: { deriveStream: () => ({ chance: () => false }) } };
  bulletsMod.spawnBullets(state3, Object.assign({ owner: 'p2' }, ballAct));
  const ev3 = bulletsMod.resolveBullets(state3, {
    actors: [{ id: 'p1', owner: 'p1', x1: 224, x2: 224, hp: 100, fullDodge: false },
      { id: 'p2', owner: 'p2', x1: 800, x2: 800, hp: 100, fullDodge: false }],
  });
  // 若存活弹幕命中，伤害按引擎 dealDamage 公式（无 defend/背击/暴击/吸血）
  const dmgOf = (atk, mult, def) => Math.max(1, Math.floor(atk * mult * (1 - def / (def + cfg.defK))));
  return {
    p1Skill: dash.name, p2Skill: ball.name,
    p1PathCells: dashAct.bullets.map((b) => b.x0),
    p1Move: { from: 224, to: 480, cells: dash.distance },
    p2ImpactX: ballAct.impactX,
    p2ImpactCell: field.cellOf(ballAct.impactX),
    p2RangeCells: ball.range,
    p2AoeCells: ballAct.bullets.map((b) => b.x0),
    spawned,
    collides: ev.collides.map((c) => ({ atX: c.atX, a: c.a, b: c.b, winner: c.winner })),
    hits: ev.hits.map((h) => ({ uid: h.uid, owner: h.owner, target: h.target, atX: h.atX })),
    stationaryHits: ev2.hits.map((h) => ({ uid: h.uid, owner: h.owner, target: h.target, atX: h.atX })),
    fireballOnlyHits: ev3.hits.map((h) => ({ uid: h.uid, owner: h.owner, target: h.target, atX: h.atX })),
    p1ToP2: { atk: 12, def: 9, mult: dash.multiplier, raw: 12 * dash.multiplier * (1 - 9 / (9 + cfg.defK)), dmg: dmgOf(12, dash.multiplier, 9) },
    p2ToP1: { atk: 19, def: 8, mult: ball.multiplier, raw: 19 * ball.multiplier * (1 - 8 / (8 + cfg.defK)), dmg: dmgOf(19, ball.multiplier, 8) },
  };
}

/* ---------------------------------------------------------------------------------------------- 输出渲染 */
function pad(s, n) {
  const v = String(s);
  return v.length >= n ? v : v + ' '.repeat(n - v.length);
}
function padL(s, n) {
  const v = String(s);
  return v.length >= n ? v : ' '.repeat(n - v.length) + v;
}

function renderTable(run) {
  const lines = [];
  lines.push('tick | P1 行动            | P1 x/hp/mp/sp/f        | P2 行动            | P2 x/hp/mp/sp/f        | 跨系统事件');
  lines.push('-----+--------------------+------------------------+--------------------+------------------------+------------------------------------------');
  for (const t of run.ticks) {
    const ev = [];
    const spawn = t.events.filter((e) => e.event === 'bullet.spawn').length;
    const collide = t.events.filter((e) => e.event === 'bullet.collide').length;
    const hits = t.events.filter((e) => e.event === 'bullet.hit').length;
    if (spawn) ev.push(`spawn×${spawn}`);
    if (collide) ev.push(`collide×${collide}`);
    if (hits) ev.push(`hit×${hits}`);
    if (t.collision !== null) ev.push(`碰撞@${t.collision}`);
    for (const d of t.damage) ev.push(`${d.attacker}->${d.target} ${d.dmg}${d.backstab ? ' 背击' : ''}${d.crit ? ' 暴击' : ''}`);
    if (t.verdict) ev.push(`verdict ${t.verdict.winner}/${t.verdict.phase}`);
    const s1 = `${t.p1.x}/${t.p1.hp}/${t.p1.mp}/${t.p1.sp}/${t.p1.facing > 0 ? '+1' : '-1'}`;
    const s2 = `${t.p2.x}/${t.p2.hp}/${t.p2.mp}/${t.p2.sp}/${t.p2.facing > 0 ? '+1' : '-1'}`;
    lines.push(`${padL(t.tick, 4)} | ${pad(t.rawAction.p1, 18)} | ${pad(s1, 22)} | ${pad(t.rawAction.p2, 18)} | ${pad(s2, 22)} | ${ev.join('；')}`);
  }
  return lines.join('\n');
}

function renderDetail(run) {
  const lines = [];
  for (const t of run.ticks) {
    const bullets = t.bulletsOnField.map((b) => `${b.uid}(${b.owner}/L${b.level}@${b.x0}/dir${b.dir})`).join(' ') || '—';
    lines.push(`— tick ${t.tick}  行动 p1=${t.rawAction.p1} p2=${t.rawAction.p2}`);
    lines.push(`  弹幕（步骤 6 生成后快照，${t.bulletsOnField.length} 枚）：${bullets}`);
    if (t.collision !== null) lines.push(`  碰撞：contactX=${t.collision}`);
    for (const h of t.bulletHits) lines.push(`  命中：${h.uid} -> ${h.target} @${h.atX}`);
    for (const d of t.damage) {
      lines.push(`  伤害：${d.attacker}->${d.target} mult=${d.mult} reduction=${d.reduction} 背击=${d.backstab} 暴击=${d.crit} raw=${d.raw} dmg=${d.dmg} 吸血=${d.lifesteal} hitUid=${d.hitUid}`);
    }
    for (const e of t.events) {
      if (e.event === 'damage.calc') continue;
      const extra = e.event === 'bullet.collide' ? ` @${e.atX} winner=${e.winner}`
        : e.event === 'bullet.hit' ? ` ${e.uid} @${e.atX}`
          : e.event === 'bullet.spawn' ? ` ${e.uid}`
            : '';
      lines.push(`  事件：[${e.level}] ${e.channel}.${e.event} cid=${e.cid} ${e.msg}${extra}`);
    }
    lines.push(`  结束：p1 x=${t.p1.x} hp=${t.p1.hp} mp=${t.p1.mp} sp=${t.p1.sp} f=${t.p1.facing}｜p2 x=${t.p2.x} hp=${t.p2.hp} mp=${t.p2.mp} sp=${t.p2.sp} f=${t.p2.facing}｜基地 ${t.bases.p1}/${t.bases.p2}`);
    if (t.verdict) lines.push(`  verdict：winner=${t.verdict.winner} phase=${t.verdict.phase}`);
  }
  return lines.join('\n');
}

function main() {
  const run = runScenario();
  const cmp = compareWithGolden(run);
  const fb = fireballCheck();
  const actions = actionLegality();
  const cx = collisionExample();
  const facingSeries = run.ticks.map((t) => `${t.p1.facing}/${t.p2.facing}`);
  const facingChanged = new Set(facingSeries).size > 1;
  const bulletCollides = run.ticks.reduce((n, t) => n + t.events.filter((e) => e.event === 'bullet.collide').length, 0);
  const bulletHits = run.ticks.reduce((n, t) => n + t.bulletHits.length, 0);
  const collisions = run.ticks.filter((t) => t.collision !== null).length;

  const payload = {
    generatedBy: '.audit/walkthrough.js',
    scenario: {
      source: '.audit/golden-battle.js（gate 项 8 同源；§2 场景不可无歧义重建）',
      seed: run.summary.seed,
      players: {
        p1: { id: 'A', x0: 224, facing0: 1, hp: 100, mp: 40, sp: 60, atk: 12, def: 8, critChance: 0.5, skill: 'skill_straight_precise（multiplier 1.0）', actionSource: '固定行动计划（p1 数组）' },
        p2: { id: 'B', x0: 800, facing0: -1, hp: 100, mp: 40, sp: 60, atk: 19, def: 9, critChance: 0, skill: 'skill_dash_bash（multiplier 1.3 / distance 4 / passThroughEnemy false）', actionSource: '固定行动计划（p2 数组）' },
      },
    },
    summary: Object.assign({}, run.summary, { collisions, bulletHits, bulletCollides, facingChanged }),
    ticks: run.ticks.map((t) => Object.assign({}, t, { rawEvents: undefined })),
    checks: {
      goldenSnapshot: { ok: cmp.ok, reason: cmp.reason },
      fireballImpact: fb,
      actionLegality: actions,
      facingConstant: !facingChanged,
      section32Collision: cx,
    },
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 1) + '\n', 'utf8');

  console.log('=== [1] 场景基准 = 黄金战斗（.audit/golden-battle.js，seed 20260912）===');
  console.log(`p1: x=224 f=+1 hp=100 mp=40 sp=60 atk=12 def=8 crit=0.5 技能 skill_straight_precise(mult 1.0)`);
  console.log(`p2: x=800 f=-1 hp=100 mp=40 sp=60 atk=19 def=9 crit=0   技能 skill_dash_bash(mult 1.3 / dist 4)`);
  console.log(`双方行动 = 固定行动计划（脚本内 plan 数组，与 .audit/golden-battle.js 逐项一致）`);
  console.log('');
  console.log('=== [2] 逐 tick 轨迹（真实引擎输出）===');
  console.log(renderTable(run));
  console.log('');
  console.log(`合计：${run.summary.ticks} tick，winner=${run.summary.winner}，phase=${run.summary.phase}，` +
    `碰撞 ${collisions} 次，弹幕命中 ${bulletHits} 次，弹幕互撞 ${bulletCollides} 次，朝向是否变化=${facingChanged}`);
  console.log(`终局 hp：p1=${run.summary.finalHp.p1}（≤0）p2=${run.summary.finalHp.p2}；基地 ${run.ticks[run.ticks.length - 1].bases.p1}/${run.ticks[run.ticks.length - 1].bases.p2}（未受弹幕伤害）`);
  console.log('');
  console.log('=== [3] 与 .audit/golden-battle.json 比对（gate 项 8 同源）===');
  console.log(cmp.ok ? '[PASS] 逐字段一致（seed/ticks/winner/phase/每 tick x·hp·mp·sp/碰撞/命中）' : `[FAIL] ${cmp.reason}`);
  console.log('');
  console.log('=== [4] 火球术落点复算（skill_vert_fireball，vertical 分支）===');
  console.log(`${fb.name}（${fb.template}）：range=${fb.rangeCells} 格，area=[${fb.area}]，L${fb.bulletLevel}`);
  const p2c = fb.p2AtDocPosition;
  console.log(`施法者 = P2（${p2c.casterX}，facing ${p2c.casterFacing}）：落点 = ${p2c.expression} = ${p2c.unclamped}` +
    `${p2c.clamped ? '（clamp 生效）' : '（未越界）'} → 真实落点 ${p2c.impactX}（格 ${p2c.impactCell}），覆盖格心 ${p2c.xCenters.join('/')}`);
  const p1c = fb.p1AtDocPosition;
  console.log(`施法者 = P1（${p1c.casterX}，facing +1）：落点 = ${p1c.expression} = ${p1c.unclamped}` +
    `${p1c.clamped ? '（clamp 生效）' : '（未越界）'} → ${p1c.impactX}（格 ${p1c.impactCell}），覆盖格心 ${p1c.xCenters.join('/')}`);
  console.log(`⇒ 文档"火球术落点 288"在**施法者为 P2（800,facing −1）**时成立（clampX(800 − 8×64)）；` +
    `若把施法者当成 P1（224,+1）则得 736（"736"的来处）。两者都只由该公式得到，不涉及 288 的第三种来源。`);
  console.log('');
  console.log('=== [5] 行动白名单校验（引擎 normalizeAction，非法 → wait）===');
  for (const a of actions) console.log(`  ${pad(a.raw, 16)} → ${JSON.stringify(a.normalized)}`);
  console.log('  ⇒ 白名单无 turn：turn 会被归一化为 wait，不能产生朝向变化；引擎内也没有任何写 facing 的代码路径（facing 恒为初始值）');
  console.log('');
  console.log('=== [5b] §3.2 示例场景复算（设计期示例，非黄金战斗场景）===');
  console.log(`P1 ${cx.p1Skill}（位移 ${cx.p1Move.from}→${cx.p1Move.to}，${cx.p1Move.cells} 格）路径弹幕格心：${cx.p1PathCells.join('/')}`);
  console.log(`P2 ${cx.p2Skill}（竖直，range ${cx.p2RangeCells} 格）落点 ${cx.p2ImpactX}（格 ${cx.p2ImpactCell}），AOE 格心：${cx.p2AoeCells.join('/')}`);
  console.log(`生成弹幕：${cx.spawned.map((b) => `${b.uid}(${b.owner}/${b.srcType}/L${b.level}@${b.x0})`).join(' ')}`);
  console.log(`真实解算 → 抵消 ${cx.collides.length} 次：${cx.collides.map((c) => `@${c.atX} ${c.a}(p1) vs ${c.b}(p2) winner=${c.winner}`).join('；') || '—'}`);
  console.log(`真实解算 → 命中 ${cx.hits.length} 次：${cx.hits.map((h) => `${h.uid}->${h.target}@${h.atX}`).join('；') || '—'}`);
  console.log(`变体（P1 留在起点 224 不动）→ 命中 ${cx.stationaryHits.length} 次：${cx.stationaryHits.map((h) => `${h.uid}->${h.target}@${h.atX}`).join('；') || '—'}`);
  console.log(`变体（只放火球、无位移弹幕抵消，P1 不动）→ 命中 ${cx.fireballOnlyHits.length} 次：${cx.fireballOnlyHits.map((h) => `${h.uid}->${h.target}@${h.atX}`).join('；') || '—'}` +
    ` ⇒ 未被抵消的 AOE 弹幕会命中生成格上的敌方角色（实测命中 @${cx.fireballOnlyHits.length ? cx.fireballOnlyHits[0].atX : '—'}）`);
  console.log(`位移路径 ⇄ AOE 的实际重叠格心：${cx.p1PathCells.filter((x) => cx.p2AoeCells.includes(x)).join('/') || '—'}` +
    `（位移 5 枚覆盖 ${cx.p1PathCells.join('/')}；AOE 3 枚覆盖 ${cx.p2AoeCells.join('/')}）`);
  console.log(`伤害公式复算（无 defend/背击/暴击）：p1→p2 = ${cx.p1ToP2.raw} → ${cx.p1ToP2.dmg}；p2→p1 = ${cx.p2ToP1.raw} → ${cx.p2ToP1.dmg}`);
  console.log('');
  console.log('=== [6] 逐 tick 明细（事件链）===');
  console.log(renderDetail(run));
  console.log('');
  console.log(`JSON 已写入 ${path.relative(process.cwd(), OUT_JSON)}（${payload.ticks.length} tick，原始日志 ${run.logCount} 条）`);
  return cmp.ok ? 0 : 1;
}

module.exports = { runScenario, compareWithGolden, fireballCheck, actionLegality, collisionExample, SEED };

if (require.main === module) {
  process.exitCode = main();
}
