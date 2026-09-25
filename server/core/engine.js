'use strict';
/* server/core/engine.js —— 战斗引擎（P1 B8 骨架，契约 docs/interfaces.md §1）
 * 依据：systems/07-engine.md §4.2 14 步管线/§4.3 移动碰撞/§4.6 judge/§4.7 快进；examples/07-movement-collision.md M/N/O/P 全分支（数值期望）。
 * decisions：D-10..D-18（统一落位）/D-19（恰相邻不算接触）/D-33（互穿各进一格）/D-34（位移撞基地 atk×0.8）/D-43（defend def×1.6）/
 *   D-61（撞基地停原地）/D-71（控制位移不可穿）/D-80（行动归一化 wait）/D-82（冷却递减）/D-83（控制复写时机）/D-84（复写不扣资源）/D-110（模板 regen）。
 * 事件：battle.create(info)/tick.begin(info)/tick.step(debug，14 步各一条)/move.resolve(debug)/collision.resolve(info)/
 *   resource.regen(trace)/battle.overtime(info)/tick.end(info)/battle.judge(info)/battle.end(info)/action.invalid(warn)（§4.6 L4 行）。
 * 边界（B8 登记）：本批伤害为**基础链路**——普通 max(1,floor(atk×mult×(1−def/(def+40)))) 与碰撞 atk×0.8，不记 damage.* 事件；
 *   背击/暴击/吸血/真实/附加效果与 damage.* 事件（§4.6 B9 行）由 B9 交付。步骤 3 AI 续执行由调用方注入 actions（B15 起 AI 链路替换）。
 * 减伤公式常数 def+40 已随 B21 校准入表（battle-config.defK，L9：无代码字面量兜底）。
 */
const { nullLogger } = require('../../shared/log.js');
const { createRng } = require('./rng.js');
const field = require('./field.js');
const skillsMod = require('./skills.js');
const effectsMod = require('./effects.js');
const bulletsMod = require('./bullets.js');

const ACTIONS = new Set(['move_left', 'move_right', 'dodge_left', 'dodge_right', 'wait', 'defend', 'turn']);
const round1 = Math.round;
// L9：全部战斗数值默认自 battle-config.json（createBattle 覆盖注入）；引擎无字面量兜底
const DEFAULT_CFG = require('../data/battle-config.json');
// 词条语义注册表（命中类/释放类词条由本模块按表结算，不按 id 写分支）
const AFFIXES = require('../data/affix-registry.json').affixes;

/* ---------- D-167：回放帧的"画面数据"投影（纯标签化，不复制任何战斗公式） ---------- */

// 本 tick 实际提交的行动 → 帧字段。kind 词表（冻结于 docs/interfaces.md §4.3）：
//   move / dodge / forced_move / cast / displacement / defend / turn / wait
function actionOfPlan(plan, intent) {
  const p = plan || { kind: 'wait' };
  const out = { kind: p.kind };
  if (typeof p.dir === 'number') out.dir = p.dir;
  if (p.kind === 'cast' || p.kind === 'displacement') {
    out.sid = intent && typeof intent.sid === 'string' ? intent.sid : null;
  }
  if (p.kind === 'forced_move') out.cells = intent && typeof intent.cells === 'number' ? intent.cells : null;
  return out;
}

// 持续效果摘要（与 AI 快照 `self.effects[i]` 同形状：uid/kind/stat/delta/remaining/displacement）
function effectsSummaryOf(player) {
  const list = player && Array.isArray(player.effects) ? player.effects : [];
  return list.map((e) => ({
    uid: e.uid === undefined ? null : String(e.uid),
    kind: e.kind === undefined ? null : String(e.kind),
    stat: e.stat === undefined ? null : String(e.stat),
    delta: typeof e.delta === 'number' ? e.delta : null,
    displacement: typeof e.displacement === 'number' ? e.displacement : null,
    remaining: typeof e.remaining === 'number' ? e.remaining : null,
  }));
}

// 弹幕生命周期：把"步骤 6 的生成记录"与"步骤 8 的解算事件（互撞/命中/清场）"合成一条**自足**的记录，
//   使渲染方无需自行推算"在哪里消失 / 是什么结局"（弹幕当 tick 全解算，D-20）。
//   outcome ∈ {'hit'|'collide'|'expire'}：'collide' = 该弹幕被互撞移除（含双方同灭）；'expire' = tick 末清场。
function bulletsLifecycleOf(spawns, events) {
  const ev = events || {};
  const collides = Array.isArray(ev.collides) ? ev.collides : [];
  const hits = Array.isArray(ev.hits) ? ev.hits : [];
  const expires = Array.isArray(ev.expires) ? ev.expires : [];
  return (Array.isArray(spawns) ? spawns : []).map((b) => {
    const col = collides.find((c) => c.a === b.uid || c.b === b.uid) || null;
    const removedByCollide = col !== null && (col.winner === 'none' || col.winner !== b.uid);
    const hit = hits.find((h) => h.uid === b.uid) || null;
    const exp = expires.find((e) => e.uid === b.uid) || null;
    const endX = hit ? hit.atX : (col && removedByCollide ? col.atX : round1(b.x + b.dir * b.len));
    const out = {
      uid: b.uid,
      owner: b.owner,
      level: b.level === undefined ? null : b.level,
      btype: b.type === undefined ? null : b.type,
      srcType: b.srcType === undefined ? null : b.srcType,
      dir: b.dir,
      v: b.v,
      len: b.len,
      spawnX: b.x,
      endX,
      outcome: hit ? 'hit' : (removedByCollide ? 'collide' : 'expire'),
      hitTarget: hit ? hit.target : null,
      collideWith: col ? (col.a === b.uid ? col.b : col.a) : null,
      collideWinner: col ? col.winner : null,
      collided: col !== null,
      expired: exp !== null,
    };
    if (hit) out.falloffFactor = hit.falloffFactor;
    return out;
  });
}

function createBattle(cfgIn, options) {
  const opts = options || {};
  const cfg = Object.assign({}, DEFAULT_CFG, cfgIn || {});
  const rawLogger = opts.logger || nullLogger;
  // B22 P1-1：tick/cid 感知装饰——子系统的日志记录缺 data.tick（如 bullet.spawn/damage.calc），回放帧 events
  //   按 tick 过滤会剔除它们；装饰统一补 tick 并按 `t{tick}:{seq}` 生成 cid（§4.3「事件带 cid」；链序=seq 序）。
  let tickStamp = 0;
  let cidSeq = 0;
  const L = {};
  const stamp = (level, channel, event, msg, data) => {
    const d = Object.assign({}, data || {});
    if (d.tick === undefined) d.tick = tickStamp;
    if (d.cid === undefined) d.cid = `t${tickStamp}:${++cidSeq}`;
    rawLogger.log ? rawLogger.log(level, channel, event, msg, d) : nullLogger[level](channel, event, msg, d);
  };
  for (const lv of ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'log']) L[lv] = lv === 'log'
    ? (level, channel, event, msg, data) => stamp(level, channel, event, msg, data)
    : (channel, event, msg, data) => stamp(lv, channel, event, msg, data);
  const logger = L;
  // 子系统接线（B8 审查教训：模块默认版为 nullLogger，必须在战斗级注入真实 logger）
  const skills = skillsMod.withLogger(logger);
  const effects = effectsMod.withLogger(logger);
  const bullets = bulletsMod.withLogger(logger);
  const fieldApi = field.withLogger(logger);
  const CELL = cfg.cellPx;

  // ---- 完整伤害链路（systems/07-engine.md §4.4 八步；§4.5 背击；D-40..D-46/D-50/D-51/D-72）----
  // params: {mult, trueDamage, backstab, critRng, affixes, specials, sourceDir, hitUid}
  function dealDamage(attacker, defender, params) {
    const p = params || {};
    const rng = p.critRng || { chance: () => 0 };
    // 步骤 0 D-72①：位移全程免疫（fullDodgeDuring 由步骤 6 置位）——不参与命中判定也不吃伤害
    if (defender.fullDodgeDuring) {
      logger.debug('damage', 'damage.dodge', `${defender.id} 位移全程免疫（D-72）`, { target: defender.id, fullDodgeDuring: true });
      return { dmg: 0, dodged: true, fullDodgeDuring: true, dodgeChanceTotal: 0, lifesteal: 0 };
    }
    // 步骤 1 闪避判定（§4.4：dodgeChance + 本 tick dodge 行动的 dodgeChanceBonus）
    const dodgeChanceTotal = Math.min(1, ((defender.special && defender.special.dodgeChance) || 0) + (defender.dodging ? cfg.dodgeChanceBonus : 0));
    if (dodgeChanceTotal > 0 && rng.chance(dodgeChanceTotal, 'dodge')) {
      logger.debug('damage', 'damage.dodge', `${defender.id} 闪避`, { target: defender.id, chance: dodgeChanceTotal });
      return { dmg: 0, dodged: true, dodgeChanceTotal };
    }
    // 技能插件携带的概率类词条（crit_chance/lifesteal）叠加在面板值之上，累加封顶 1（D-46）
    const skillSpecials = p.specials || {};
    // 步骤 2-3 攻防属性：defending def×1.6（D-43）；真实伤害不吃护甲（reduction=1）
    const mult = p.mult === undefined ? cfg.baseHitMul : p.mult;
    const def = defender.defending ? defender.def * cfg.defendDefMul : defender.def;
    const reduction = p.trueDamage ? 1 : 1 - def / (def + cfg.defK);
    // 步骤 4-5 背击 ×1.5（D-42/D-50）与暴击 ×1.5（critChance 消耗 crit 流）
    const backM = p.backstab ? cfg.backstab : 1;
    const critChance = Math.min(1, ((attacker.special && attacker.special.critChance) || 0) + (skillSpecials.critChance || 0));
    const crit = !!(critChance > 0 && rng.chance(critChance, 'crit'));
    const critM = crit ? cfg.crit : 1;
    // 步骤 6 倍率相乘后只取整一次（D-41），下限 1
    const raw = attacker.atk * mult * reduction * backM * critM;
    const dmg = Math.max(1, Math.floor(raw));
    // 步骤 7 吸血（角色伤害；基地不吸血由调用方不走本函数）
    let lifesteal = 0;
    const ls = Math.min(1, ((attacker.special && attacker.special.lifesteal) || 0) + (skillSpecials.lifesteal || 0));
    if (ls > 0) {
      lifesteal = Math.floor(dmg * ls);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + lifesteal);
      logger.trace('damage', 'damage.lifesteal', `${attacker.id} 吸血 +${lifesteal}`, { attacker: attacker.id, lifesteal });
    }
    // 步骤 8 应用 + damage.calc（每步中间值）
    defender.hp = Math.max(0, defender.hp - dmg);
    logger.debug('damage', 'damage.calc', `${attacker.id} -> ${defender.id} ${dmg}`, {
      attacker: attacker.id, target: defender.id, mult, reduction, backM, critM, critChance,
      backstab: !!p.backstab, crit, trueDamage: !!p.trueDamage, raw, dmg, lifesteal,
      hitUid: p.hitUid === undefined ? null : p.hitUid,
    });
    // 步骤 9 附加效果（伤害生效后添加：眩晕/击退/拉近/持续伤害/附加真实伤害）
    for (const affix of p.affixes || []) addAffixEffect(attacker, defender, affix, p.sourceDir);
    return { dmg, reduction, raw, mult, backstab: !!p.backstab, crit, trueDamage: !!p.trueDamage, lifesteal, dodged: false, dodgeChanceTotal };
  }

  // 背击判定（§4.5，2026-09-12 拍板"追尾语义"并统一弹幕来源判定）：
//   近战 = 攻方本体位于受击方朝向反方向；平射/位移路径弹幕 = 方向与受击方朝向**相同**（追尾；迎面不算）；
//   垂直 = 永不触发（示例 M4/M5 位移路径弹幕 12 无背击保持一致）
  function isBackstab(attacker, defender, attackType, dir) {
    if (attackType === 'vertical' || attackType === 'aoe') return false;
    if (attackType === 'displacement' || attackType === 'straight') return dir === defender.facing;
    return defender.facing > 0 ? attacker.attackerX < defender.x : attacker.attackerX > defender.x;
  }

  // 附加效果入列（§4.4 步骤 9）：结算规则全部来自词条注册表 hitEffect（affix-registry.json），
  // 不再按 affix.id 写分支；D-72②：位移全程免疫期间不吃控制/持续/附加伤害。
  function addAffixEffect(attacker, defender, affix, sourceDir) {
    const def = AFFIXES[affix.id];
    if (!def || !def.hitEffect) return; // skillOp / castEffect 类词条不在此结算
    const spec = def.hitEffect;
    const dir = sourceDir || attacker.facing || 1;
    const v = (affix.params && affix.params.v) || 1;
    if (defender.fullDodgeDuring) {
      logger.debug('damage', 'damage.dodge', `${defender.id} 位移全程免疫控制（D-72）`, { target: defender.id, affixId: affix.id });
      return;
    }
    if (spec.kind === 'control') {
      const displacement = spec.displacementFrom ? (spec.sign || 1) * dir * v : (spec.displacement || 0);
      effects.addEffect(battleState, { kind: 'control', target: defender.owner, displacement, remaining: spec.remaining, source: attacker.owner });
      return;
    }
    if (spec.kind === 'continuous') {
      const delta = (spec.sign || 1) * (spec.deltaFrom ? v : (spec.delta || 0));
      effects.addEffect(battleState, { kind: 'continuous', target: defender.owner, stat: spec.stat, delta, remaining: spec.remaining, source: attacker.owner });
      return;
    }
    if (spec.kind === 'flatTrueDamage') {
      const trueDmg = Math.max(0, Math.floor(spec.amountFrom ? v : (spec.amount || 0)));
      defender.hp = Math.max(0, defender.hp - trueDmg); // 附加真实伤害（数值直扣，B21 校准 D-128）
      logger.debug('damage', 'damage.calc', `${attacker.id} -> ${defender.id} ${trueDmg}（附加真实伤害）`, {
        attacker: attacker.id, target: defender.id, trueDamage: true, raw: trueDmg, dmg: trueDmg, lifesteal: 0,
      });
      return;
    }
    logger.warn('damage', 'damage.affix.unknown', `未登记命中效果 ${spec.kind}（affix-registry.json）`, { affixId: affix.id, kind: spec.kind });
  }

  // ---- 行动归一化（D-80：白名单 + 非法 → wait）----
  function normalizeAction(raw) {
    if (typeof raw !== 'string') {
      logger.warn('engine', 'action.invalid', `非法行动 → wait`, { raw: String(raw) });
      return { type: 'wait' };
    }
    if (ACTIONS.has(raw)) {
      const [kind, dirName] = raw.split('_');
      const dir = dirName === 'left' ? -1 : 1;
      if (kind === 'move' || kind === 'dodge') return { type: kind, dir };
      return { type: kind };
    }
    if (raw.startsWith('skill:')) {
      return { type: 'skill', sid: raw.slice(6) };
    }
    logger.warn('engine', 'action.invalid', `非法行动 ${JSON.stringify(raw)} → wait`, { raw });
    return { type: 'wait' };
  }

  // ---- 统一落位（07 §1 五步；M/N/O/P 全分支）----
  // 输入双方 {player, x, dir, toX(意图原始，未 clamp), pass}；返回 {p1:{fromX,toX}, p2:{...}, collision, baseHit}
  function resolveActorCollision(a, b) {
    // 规则 0：撞基地（未 clamp 意图越过边界且 dir===facing，D-61）→ 停原地（对基地 atk×0.8 走基地减伤，D-34）
    const hitBase = (m) => field.touchesBase({ x: m.x, facing: m.player.facing }, m.toX, m.dir);
    const aBase = hitBase(a);
    const bBase = hitBase(b);
    if (aBase || bBase) {
      const settle = (m) => (hitBase(m) ? m.x : m.toX);
      // D-167：**双方可在同一 tick 各自撞到对方基地**（修前只回报第一个 ⇒ 第二个基地不掉血）。
      //   这里返回数组；`baseHit` 保留为首项（兼容既有调用点/测试）。
      const baseHits = [];
      if (aBase) baseHits.push({ owner: a.player.facing > 0 ? 'p2' : 'p1', by: a.player, atX: a.x });
      if (bBase) baseHits.push({ owner: b.player.facing > 0 ? 'p2' : 'p1', by: b.player, atX: b.x });
      return {
        p1: { fromX: a.x, toX: round1(field.clampX(settle(a))) },
        p2: { fromX: b.x, toX: round1(field.clampX(settle(b))) },
        collision: null,
        // owner 与 field.touchesBase 同规则（facing 朝向哨位侧基地，B8 审查 P1-1）
        baseHit: baseHits[0] || null,
        baseHits,
      };
    }
    const t1 = field.clampX(a.toX);
    const t2 = field.clampX(b.toX);
    const v1 = t1 - a.x;
    const v2 = t2 - b.x;
    // 规则 1-2：双方都不可穿且"意图落位后中心距 < 64px"（D-10 判定）→ 碰撞
    if (!a.pass && !b.pass) {
      const d0 = b.x - a.x;
      const dv = v2 - v1;
      let minGap;
      if (dv === 0) {
        minGap = Math.abs(d0);
      } else {
        const tCross = -d0 / dv;
        const cand = [0, 1];
        if (tCross >= 0 && tCross <= 1) cand.push(tCross);
        minGap = Math.min(...cand.map((t) => Math.abs(d0 + dv * t)));
      }
      if (minGap < cfg.minGapPx - 1e-9) {
        // 解 |d0 + dv·t| = minGapPx 的 t ∈ (0,1] 最小正解
        //（数学保证：minGap<64 ⇒ |d0+dv·t|=64 在 [0,1] 有解——线性绝对值函数连续性；sols 恒非空，无防御分支）
        //（dv=0 时解为 ±Infinity/NaN，filter 排除——不产生分支）
        const sols = [((cfg.minGapPx - d0) / dv), ((-cfg.minGapPx - d0) / dv)]
          .filter((t) => Number.isFinite(t) && t >= 0 && t <= 1);
        const tStar = Math.min(...sols);
        const ax = a.x + v1 * tStar;
        const bx = b.x + v2 * tStar;
        return {
          p1: { fromX: a.x, toX: round1(field.clampX(ax)) },
          p2: { fromX: b.x, toX: round1(field.clampX(bx)) },
          collision: { contactX: round1((ax + bx) / 2), t: round1(tStar * 10000) / 10000 },
          baseHit: null,
          baseHits: [],
        };
      }
    }
    // 规则 3：各自到达；若到达后中心距 <64（目标重叠）→ 后推（D-33 / 停敌方身后）
    let to1 = t1;
    let to2 = t2;
    if (Math.abs(to2 - to1) < cfg.minGapPx - 1e-9) {
      if (a.pass && b.pass) {
        // 双方都可穿：各沿原方向再进一格（D-33，相遇格空着，中心距 128）
        to1 = field.clampX(to1 + a.dir * CELL);
        to2 = field.clampX(to2 + b.dir * CELL);
      } else if (a.pass) {
        to1 = field.clampX(to2 + a.dir * cfg.minGapPx);
      } else if (b.pass) {
        to2 = field.clampX(to1 + b.dir * cfg.minGapPx);
      }
    }
    return {
      p1: { fromX: a.x, toX: round1(to1) },
      p2: { fromX: b.x, toX: round1(to2) },
      collision: null,
      baseHit: null,
      baseHits: [],
    };
  }

  // ---- judge（§4.6：基地 > 角色；同时 → 平局）----
  function judge(state) {
    const b1 = state.bases.p1, b2 = state.bases.p2;
    const r1 = state.players.p1, r2 = state.players.p2;
    const b1Dead = b1.hp <= 0, b2Dead = b2.hp <= 0;
    if (b1Dead || b2Dead) {
      if (b1Dead && b2Dead) return { winner: 'draw', phase: 'base' };
      return { winner: b1Dead ? 'p2' : 'p1', phase: 'base' };
    }
    if (r1.hp <= 0 || r2.hp <= 0) {
      if (r1.hp <= 0 && r2.hp <= 0) return { winner: 'draw', phase: 'role' };
      return { winner: r1.hp <= 0 ? 'p2' : 'p1', phase: 'role' };
    }
    return null;
  }

  // ---- 单 tick（14 步冻结顺序，§4.2）----
  function step(battle, stepOpts) {
    const o = stepOpts || {};
    const state = battle.state;
    const actions = o.actions || state.queuedActions || {};
    // B22：帧事件缓冲（调用方注入整场记录，diff.events 按 tick 切分；记录带 cid/tick，§4.3 回放帧契约）
    const frameEvents = o.eventsBuf || null;
    const players = state.players;
    const p1 = players.p1, p2 = players.p2;

    state.tick += 1;
    const tick = state.tick;
    if (tickStamp !== tick) { tickStamp = tick; cidSeq = 0; } // 每 tick 重置 cid 序列（B22 P1-1 装饰）
    logger.info('engine', 'tick.begin', `tick ${tick}`, { tick });
    const stepLog = (stepNo, msg, data) => logger.debug('engine', 'tick.step', `[${stepNo}] ${msg}`, Object.assign({ step: stepNo, tick }, data || {}));

    // 步骤 1：冷却递减 max(0, cd−1)（D-82）+ 重置临时标记
    for (const p of [p1, p2]) {
      for (const k of Object.keys(p.cooldowns)) p.cooldowns[k] = Math.max(0, p.cooldowns[k] - 1);
      p.defending = false;
      p.fullDodgeDuring = false;
      p.dodging = false;
    }
    // D-167：本 tick 的"画面数据"累加器（步骤 6 填 action、步骤 9 填 damages；步骤 13 输出）
    state._frameActions = null;
    state._frameDamages = [];
    stepLog(1, '冷却递减/重置标记');

    // 步骤 2：持续效果
    effects.resolveContinuous({ tick, players });
    stepLog(2, '持续效果');

    // 步骤 3：AI 续执行 / 行动注入（B8：由调用方注入；B16：actions.aiTrace 可选缓冲——AI 驱动器
    //   每 tick 向该数组推本 tick 增量 trace，步骤 13 输出到 diff.aiTrace（冻结字段名 interfaces §4.3，P2-6 对齐））
    const aiTraceBuf = actions && Array.isArray(actions.aiTrace) ? actions.aiTrace : null;
    if (aiTraceBuf) aiTraceBuf.length = 0;
    const rawActions = {
      p1: typeof actions.p1 === 'function' ? actions.p1(state, p1) : actions.p1,
      p2: typeof actions.p2 === 'function' ? actions.p2(state, p2) : actions.p2,
    };
    stepLog(3, '行动获取');

    // 步骤 4：行动归一化（D-80）
    const intents = { p1: normalizeAction(rawActions.p1), p2: normalizeAction(rawActions.p2) };
    stepLog(4, '行动归一化');

    // 步骤 5：控制效果复写（D-83/D-84：复写在意图提交前 → 不扣资源不写 CD）
    for (const owner of ['p1', 'p2']) {
      const p = players[owner];
      const intent = intents[owner];
      const aiLabel = intent.type === 'skill' ? `skill:${intent.sid}` : intent.type === 'wait' ? 'wait' : `${intent.type}_${intent.dir > 0 ? 'right' : 'left'}`;
      const ctl = effects.resolveControl(p.effects, aiLabel);
      if (ctl.action === 'wait') intents[owner] = { type: 'wait' };
      else if (ctl.action === 'forced_move') intents[owner] = { type: 'forced_move', dir: ctl.dir, cells: ctl.cells };
    }
    stepLog(5, '控制复写');

    // 步骤 6：意图提交（只算意图、不写回位置；技能 canCast → 扣资源+写 CD+生成弹幕）
    const plans = {};
    for (const owner of ['p1', 'p2']) {
      const p = players[owner];
      const intent = intents[owner];
      const plan = { kind: 'wait', x: p.x, dir: intent.dir === undefined ? p.facing : intent.dir, pass: false, rawToX: p.x };
      if (intent.type === 'move' || intent.type === 'dodge') {
        const px = intent.type === 'move' ? cfg.movePx : cfg.dodgePx;
        plan.kind = intent.type;
        plan.dir = intent.dir === undefined ? p.facing : intent.dir;
        plan.pass = intent.type === 'dodge'; // dodge 可穿（07 §1）
        plan.rawToX = p.x + plan.dir * px;
        if (intent.type === 'dodge') p.dodging = true; // 本 tick dodge 行动 → 闪避叠加（§4.4 步骤 1）
      } else if (intent.type === 'forced_move') {
        plan.kind = 'forced_move';
        plan.dir = intent.dir;
        plan.pass = false; // 控制类位移不可穿（D-71）
        plan.rawToX = p.x + intent.dir * intent.cells * CELL;
      } else if (intent.type === 'skill') {
        const sk = p.skills[intent.sid];
        if (!sk) {
          // 未知/未装配技能 → 空行动（不静默：记 action.invalid(warn)，可进帧 events，便于玩家自测发现）
          logger.warn('engine', 'action.invalid', `${owner} 技能 ${intent.sid} 未装配或不存在 → 空行动`, { owner, sid: intent.sid, reason: 'unknown_skill' });
          plans[owner] = plan;
          continue;
        }
        // P1-4：冷却键 = 槽位键（intent.sid 就是 AI 动作名里的槽位，也是 p.skills 的查找键）
        //   → 同一模板装两个槽时两槽 CD 独立（默认出战配置会重复同一模板）
        const can = skills.canCast(sk, p, intent.sid);
        if (!can.ok) { plans[owner] = plan; continue; } // 无效技能行动 → 空行动（07 §5 / skill.reject 已记）
        Object.assign(p, can.caster); // 扣资源 + 写 CD
        const act = skills.buildSkillAction(sk, { x: p.x, facing: p.facing });
        plan.kind = 'cast';
        plan.skill = sk;
        bullets.spawnBullets(state, Object.assign({ owner }, act));
        if (act.move) {
          plan.kind = 'displacement';
          plan.dir = act.move.dir;
          plan.pass = act.move.passThroughEnemy; // 看模板（D-18）
          plan.rawToX = p.x + act.move.dir * act.move.cells * CELL;
          // D-72①②③：位移全程免疫——本 tick 生效（步骤 8 弹幕判定读该标志；步骤 9 伤害/控制免疫）
          if (act.move.fullDodgeDuring) {
            p.fullDodgeDuring = true;
            logger.debug('engine', 'tick.step', `[6] ${owner} 位移全程免疫（fullDodgeDuring）`, { owner, tick });
          }
        }
        // 释放类词条（castEffect，如 cast_buff）：入效果队列，下一 tick 起效（D-70）
        for (const eff of (act.castEffects || [])) {
          effects.addEffect(state, Object.assign({ target: owner, source: owner }, eff));
        }
      } else if (intent.type === 'defend') {
        plan.kind = 'defend';
        p.defending = true; // 本 tick def×1.6（D-43）
      } else if (intent.type === 'turn') {
        // 转向（06-field §4.2 / v3-design §10.2）：只翻转朝向，不移动、不消耗；写回在步骤 7 统一进行
        plan.kind = 'turn';
      }
      plans[owner] = plan;
    }
    stepLog(6, '意图提交');
    // D-167：本 tick 双方**实际提交的行动**（步骤 5 控制复写后、步骤 6 提交后的 plan；只做标签化，不复制公式）
    //   技能未装配/不可施放 → plan 保持 kind:'wait'（诚实表达"这一步什么也没做成"）
    state._frameActions = { p1: actionOfPlan(plans.p1, intents.p1), p2: actionOfPlan(plans.p2, intents.p2) };
    // 弹幕快照（B22 回放帧：bullets[] 契约——步骤 6 生成完毕、步骤 8 解算前的场上弹幕，1px x0）
    state._frameBullets = state.bullets.map((b) => ({ uid: b.uid, owner: b.owner, type: b.type, level: b.level, dir: b.dir, x: b.x0, len: b.len, v: b.v }));

    // 步骤 7：统一落位与角色碰撞（07 §1 五步）
    //   转向写回（06-field §4.2：`turn` 翻转朝向；move/dodge/位移**不**改变朝向，D-50 的"位移后朝向"= 本步骤写回后的朝向）
    for (const owner of ['p1', 'p2']) {
      if (plans[owner].kind !== 'turn') continue;
      players[owner].facing = -players[owner].facing;
      logger.debug('engine', 'tick.step', `[7] ${owner} turn -> facing ${players[owner].facing}`, { owner, facing: players[owner].facing });
    }
    const resolved = resolveActorCollision(
      { player: p1, x: p1.x, dir: plans.p1.dir, toX: plans.p1.rawToX, pass: plans.p1.pass },
      { player: p2, x: p2.x, dir: plans.p2.dir, toX: plans.p2.rawToX, pass: plans.p2.pass },
    );
    const p1From = p1.x;
    const p2From = p2.x;
    p1.x = resolved.p1.toX;
    p2.x = resolved.p2.toX;
    if (p1From !== p1.x) logger.debug('engine', 'move.resolve', `p1 ${p1From} -> ${p1.x}`, { owner: 'p1', fromX: p1From, toX: p1.x });
    if (p2From !== p2.x) logger.debug('engine', 'move.resolve', `p2 ${p2From} -> ${p2.x}`, { owner: 'p2', fromX: p2From, toX: p2.x });
    if (resolved.collision) {
      logger.info('engine', 'collision.resolve', `collision @${resolved.collision.contactX}`, { atX: resolved.collision.contactX });
    }
    stepLog(7, '落位与碰撞');

    // 步骤 8：弹幕解算（当 tick 全解算，B7）
    const bulletEvents = bullets.resolveBullets(state, {
      actors: [
        { id: 'p1', owner: 'p1', x1: resolved.p1.fromX, x2: p1.x, hp: p1.hp, fullDodge: p1.fullDodgeDuring },
        { id: 'p2', owner: 'p2', x1: resolved.p2.fromX, x2: p2.x, hp: p2.hp, fullDodge: p2.fullDodgeDuring },
      ],
    });
    stepLog(8, '弹幕解算');

    // 步骤 9：伤害结算（B9 完整链路：弹幕命中 + 碰撞 + 基地；crit 流每 tick 派生一次共享）
    // B23 P2-9：damage.calc 带 hitUid（命中与伤害一一对应，回放帧审计七维消歧）
    const critRng = battleState.rng.deriveStream(tick, 'crit');
    for (const h of bulletEvents.hits) {
      const atk = players[h.owner];
      const def = players[h.target];
      if (def.hp <= 0) continue;
      const backstab = isBackstab({ attackerX: atk.x, attackerFacing: atk.facing }, def, h.srcType || 'aoe', h.dir);
      const res = dealDamage(atk, def, {
        mult: h.payload.multiplier * h.falloffFactor,
        critRng, backstab, affixes: h.payload.affixes || [], specials: h.payload.specials || {},
        sourceDir: h.dir, hitUid: h.uid,
      });
      // D-167：伤害数值进帧（剥离 events 后，渲染方仍需"这一下打掉多少、是不是暴击/背击"）
      battleState._frameDamages.push({
        target: h.target, amount: res.dmg, atX: h.atX, kind: 'bullet', srcUid: h.uid,
        attacker: h.owner, crit: res.crit === true, critM: res.crit ? cfg.crit : 1,
        backstab: res.backstab === true, backM: res.backstab ? cfg.backstab : 1, dodged: res.dodged === true,
      });
    }
    if (resolved.collision) {
      // 双方各受对方 atk×0.8（D-10），走完整机制（闪避/暴击/背击/吸血，§4.3）；背击按位移后位置判定
      const c1 = dealDamage(p1, p2, { mult: cfg.collisionDmgMul, critRng, backstab: isBackstab({ attackerX: p1.x }, p2, 'melee') });
      const c2 = dealDamage(p2, p1, { mult: cfg.collisionDmgMul, critRng, backstab: isBackstab({ attackerX: p2.x }, p1, 'melee') });
      battleState._frameDamages.push({ target: 'p2', amount: c1.dmg, atX: resolved.collision.contactX, kind: 'collision', srcUid: null, attacker: 'p1', crit: c1.crit === true, critM: c1.crit ? cfg.crit : 1, backstab: c1.backstab === true, backM: c1.backstab ? cfg.backstab : 1, dodged: c1.dodged === true });
      battleState._frameDamages.push({ target: 'p1', amount: c2.dmg, atX: resolved.collision.contactX, kind: 'collision', srcUid: null, attacker: 'p2', crit: c2.crit === true, critM: c2.crit ? cfg.crit : 1, backstab: c2.backstab === true, backM: c2.backstab ? cfg.backstab : 1, dodged: c2.dodged === true });
    }
    // 撞基地：atk × baseHitMul 走基地 def 减伤（D-34/D-61；无暴击/背击/吸血）。
    // D-167：**逐条**结算（修前只看 `baseHit` 首项 ⇒ 同 tick 双方各自撞基地时第二个不掉血）
    for (const bh of resolved.baseHits || []) {
      const base = battleState.bases[bh.owner];
      const atk = bh.by;
      const reduction = 1 - base.def / (base.def + cfg.defK);
      const amount = Math.max(1, Math.floor(atk.atk * cfg.baseHitMul * reduction));
      base.hp = Math.max(0, base.hp - amount);
      battleState._frameDamages.push({ target: bh.owner, amount, atX: bh.atX, kind: 'base', srcUid: null, attacker: atk.owner || null, crit: false, critM: 1, backstab: false, backM: 1, dodged: false });
    }
    stepLog(9, '伤害结算');

    // 步骤 10：资源恢复（D-110 模板 regen + 词条叠加的 hp_regen；上限封顶）
    for (const owner of ['p1', 'p2']) {
      const p = players[owner];
      const before = { hp: p.hp, mp: p.mp, sp: p.sp };
      // hp 回复：不在 hp≤0（本 tick 已阵亡）时复活（死亡时序统一在步骤 12 判定）
      if (p.regen.hp && p.hp > 0) p.hp = Math.min(p.maxHp, p.hp + p.regen.hp);
      p.mp = Math.min(p.maxMp, p.mp + (p.regen.mp || 0));
      p.sp = Math.min(p.maxSp, p.sp + (p.regen.sp || 0));
      if (p.hp !== before.hp || p.mp !== before.mp || p.sp !== before.sp) {
        logger.trace('engine', 'resource.regen', `${owner} hp ${before.hp}->${p.hp} mp ${before.mp}->${p.mp} sp ${before.sp}->${p.sp}`, { owner, hp: p.hp, mp: p.mp, sp: p.sp });
      }
    }
    stepLog(10, '资源恢复');

    // 步骤 11：超时扣血（tick ≥ overtimeStart：双方基地与角色同时扣**各自 maxHp**×ratio）
    //   2026-09-16 修正（用户拍板 A）：基地此前被扣「角色 maxHp 的同额」，而基地 maxHp 固定 100、角色
    //   maxHp 随品质涨到 ~180 → hp 越高的一方超时越先阵亡（"变强即变弱"）。现改为：
    //   角色扣 ceil(角色.maxHp × ratio)，基地扣 ceil(基地.maxHp × ratio)（base.maxHp 缺省回退 base.hp）。
    if (tick >= cfg.overtimeStart) {
      for (const owner of ['p1', 'p2']) {
        const p = players[owner];
        const base = state.bases[owner];
        const baseMaxHp = base.maxHp === undefined ? base.hp : base.maxHp;
        const cut = Math.ceil(p.maxHp * cfg.overtimeRatio);
        const baseCut = Math.ceil(baseMaxHp * cfg.overtimeRatio);
        p.hp = Math.max(0, p.hp - cut);
        base.hp = Math.max(0, base.hp - baseCut);
        // D-167：超时扣血也进帧（否则渲染方看到血条无故下降，无法归因）
        state._frameDamages.push({ target: owner, amount: cut, atX: null, kind: 'overtime', srcUid: null, attacker: null, crit: false, critM: 1, backstab: false, backM: 1, dodged: false, overtime: 'role' });
        state._frameDamages.push({ target: owner, amount: baseCut, atX: null, kind: 'overtime', srcUid: null, attacker: null, crit: false, critM: 1, backstab: false, backM: 1, dodged: false, overtime: 'base' });
      }
      logger.info('engine', 'battle.overtime', `tick ${tick} 超时扣血`, { tick });
    }
    stepLog(11, '超时扣血');

    // 步骤 12：结束判定（死亡统一在此；步骤 2 扣到 0 仍行动）
    const verdict = judge(state);
    if (verdict) {
      logger.info('engine', 'battle.judge', `winner=${verdict.winner}`, verdict);
      logger.info('engine', 'battle.end', `battle end @tick ${tick}`, { tick, winner: verdict.winner });
      state.verdict = verdict;
    }
    stepLog(12, '结束判定');
    // B22 P1-1：tick.end 于帧捕获前发出——回放帧 events 以 end 收尾（§4.3 链终止符；B22 审查调整登记）
    logger.info('engine', 'tick.end', `tick ${tick} 完成`, { tick });

    // 步骤 13：帧差异（diff；前端只按 diff 插值；B22 回放帧契约：players/bullets/bases/events/aiTrace，1px + cid）
    //   D-167 扩充（画面自足）：players 补五维/上限/行动/buff/标记；bullets 合成完整生命周期；
    //   bases 补 maxHp；新增 baseHits[]（玩家撞基地）与 damages[]（伤害数值）；
    //   对外帧由 server/battle.js 剥掉 events 后再发给调用方（日志走专用管理员接口）。
    const sideFrame = (owner) => {
      const p = players[owner];
      const mv = resolved[owner];
      return {
        fromX: mv.fromX, toX: p.x, facing: p.facing,
        hp: p.hp, mp: p.mp, sp: p.sp,
        maxHp: p.maxHp, maxMp: p.maxMp, maxSp: p.maxSp,
        atk: p.atk, def: p.def,
        defending: p.defending === true, dodging: p.dodging === true, fullDodge: p.fullDodgeDuring === true,
        action: (battleState._frameActions && battleState._frameActions[owner]) || null,
        effects: effectsSummaryOf(p),
      };
    };
    const diff = {
      tick,
      players: { p1: sideFrame('p1'), p2: sideFrame('p2') },
      bullets: bulletsLifecycleOf(battleState._frameBullets, bulletEvents),
      bases: {
        p1: { hp: battleState.bases.p1.hp, maxHp: battleState.bases.p1.maxHp === undefined ? null : battleState.bases.p1.maxHp, def: battleState.bases.p1.def },
        p2: { hp: battleState.bases.p2.hp, maxHp: battleState.bases.p2.maxHp === undefined ? null : battleState.bases.p2.maxHp, def: battleState.bases.p2.def },
      },
      events: frameEvents ? frameEvents.filter((r) => r.tick === tick) : [],
      collision: resolved.collision,
      baseHits: (resolved.baseHits || []).map((h) => ({ owner: h.owner, by: h.by && h.by.owner ? h.by.owner : null, atX: h.atX })),
      bulletHits: bulletEvents.hits.map((h) => ({ uid: h.uid, target: h.target, atX: h.atX })),
      damages: (battleState._frameDamages || []).slice(),
      verdict: state.verdict || null,
      aiTrace: aiTraceBuf ? aiTraceBuf.slice() : [],
    };
    battleState._frameBullets = null;
    battleState._frameActions = null;
    battleState._frameDamages = [];
    stepLog(13, '帧输出');

    return diff;
  }

  // ---- 创建战斗（§4.1）：seed、玩家运行时、基地、弹幕场 ----
  const players = {
    p1: Object.assign({}, opts.players && opts.players.p1),
    p2: Object.assign({}, opts.players && opts.players.p2),
  };
  for (const owner of ['p1', 'p2']) {
    players[owner].owner = owner;
    players[owner].cooldowns = players[owner].cooldowns || {};
    players[owner].effects = players[owner].effects || [];
    players[owner].skills = players[owner].skills || {};
    players[owner].defending = false;
    players[owner].fullDodgeDuring = false;
    players[owner].dodging = false;
  }
  const seed = opts.seed === undefined ? 1 : opts.seed;
  const battleState = {
    tick: 0,
    seed,
    rng: createRng(seed),
    players,
    bases: {
      p1: Object.assign({ def: cfg.baseDef }, (cfg.bases || {}).p1),
      p2: Object.assign({ def: cfg.baseDef }, (cfg.bases || {}).p2),
    },
    bullets: [],
    verdict: null,
    queuedActions: null,
  };
  logger.info('engine', 'battle.create', `battle seed=${seed}`, { seed, tick: 0 });

  const battle = {
    state: battleState,
    step: (so) => step(battle, so),
    normalizeAction,
    resolveActorCollision,
    judge: (st) => judge(st || battleState),
    dealDamage,
    isBackstab,
    runFull: (ro) => {
      // §4.7 快进：循环 step 直到判定；返回完整 tick 序列（T-EN-2 与逐 tick 回放逐帧一致）
      let winner;
      const diffs = [];
      for (let i = 0; i < cfg.hardCapTick; i++) {
        diffs.push(battle.step(ro));
        if (battleState.verdict) { winner = battleState.verdict.winner; break; }
      }
      return { winner, ticks: battleState.tick, diffs };
    },
  };
  return battle;
}

module.exports = { createBattle };