'use strict';
/* server/core/engine.js —— 战斗引擎（P1 B8 骨架，契约 docs/interfaces.md §1）
 * 依据：systems/07-engine.md §4.2 14 步管线/§4.3 移动碰撞/§4.6 judge/§4.7 快进；examples/07-movement-collision.md M/N/O/P 全分支（数值期望）。
 * decisions：D-10..D-18（统一落位）/D-19（恰相邻不算接触）/D-33（互穿各进一格）/D-34（位移撞基地 atk×0.8）/D-43（defend def×1.6）/
 *   D-61（撞基地停原地）/D-71（控制位移不可穿）/D-80（行动归一化 wait）/D-82（冷却递减）/D-83（控制复写时机）/D-84（复写不扣资源）/D-110（模板 regen）。
 * 事件：battle.create(info)/tick.begin(info)/tick.step(debug，14 步各一条)/move.resolve(debug)/collision.resolve(info)/
 *   resource.regen(trace)/battle.overtime(info)/tick.end(info)/battle.judge(info)/battle.end(info)/action.invalid(warn)（§4.6 L4 行）。
 * 边界（B8 登记）：本批伤害为**基础链路**——普通 max(1,floor(atk×mult×(1−def/(def+40)))) 与碰撞 atk×0.8，不记 damage.* 事件；
 *   背击/暴击/吸血/真实/附加效果与 damage.* 事件（§4.6 B9 行）由 B9 交付。步骤 3 AI 续执行由调用方注入 actions（B15 起 AI 链路替换）。
 * 减伤公式常数 def+40 为机制公式常量（examples/README §1 基准），非战斗数值（L9）；B21 校准若需入表再迁移。
 */
const { nullLogger } = require('../../shared/log.js');
const { createRng } = require('./rng.js');
const field = require('./field.js');
const skillsMod = require('./skills.js');
const effectsMod = require('./effects.js');
const bulletsMod = require('./bullets.js');

const ACTIONS = new Set(['move_left', 'move_right', 'dodge_left', 'dodge_right', 'wait', 'defend']);
const DEF_K = 40; // 减伤公式分母常数（examples/README §1：1 − def/(def+40)）
const round1 = Math.round;
// L9：全部战斗数值默认自 battle-config.json（createBattle 覆盖注入）；引擎无字面量兜底
const DEFAULT_CFG = require('../data/battle-config.json');

function createBattle(cfgIn, options) {
  const opts = options || {};
  const cfg = Object.assign({}, DEFAULT_CFG, cfgIn || {});
  const logger = opts.logger || nullLogger;
  // 子系统接线（B8 审查教训：模块默认版为 nullLogger，必须在战斗级注入真实 logger）
  const skills = skillsMod.withLogger(logger);
  const effects = effectsMod.withLogger(logger);
  const bullets = bulletsMod.withLogger(logger);
  const fieldApi = field.withLogger(logger);
  const CELL = cfg.cellPx;

  // ---- 完整伤害链路（systems/07-engine.md §4.4 八步；§4.5 背击；D-40..D-46/D-50/D-51）----
  // params: {mult, trueDamage, backstab, critRng, affixes, sourceDir}；defender.dodging（dodge 行动叠加 bonus）
  function dealDamage(attacker, defender, params) {
    const p = params || {};
    const rng = p.critRng || { chance: () => 0 };
    // 步骤 1 闪避判定（§4.4：dodgeChance + 本 tick dodge 行动的 dodgeChanceBonus）
    const dodgeChanceTotal = Math.min(1, ((defender.special && defender.special.dodgeChance) || 0) + (defender.dodging ? cfg.dodgeChanceBonus : 0));
    if (dodgeChanceTotal > 0 && rng.chance('dodge', dodgeChanceTotal)) {
      logger.debug('damage', 'damage.dodge', `${defender.id} 闪避`, { target: defender.id, chance: dodgeChanceTotal });
      return { dmg: 0, dodged: true, dodgeChanceTotal };
    }
    // 步骤 2-3 攻防属性：defending def×1.6（D-43）；真实伤害不吃护甲（reduction=1）
    const mult = p.mult === undefined ? cfg.baseHitMul : p.mult;
    const def = defender.defending ? defender.def * cfg.defendDefMul : defender.def;
    const reduction = p.trueDamage ? 1 : 1 - def / (def + DEF_K);
    // 步骤 4-5 背击 ×1.5（D-42/D-50）与暴击 ×1.5（critChance 消耗 crit 流）
    const backM = p.backstab ? cfg.backstab : 1;
    const critChance = (attacker.special && attacker.special.critChance) || 0;
    const crit = !!(critChance > 0 && rng.chance('crit', critChance));
    const critM = crit ? cfg.crit : 1;
    // 步骤 6 倍率相乘后只取整一次（D-41），下限 1
    const raw = attacker.atk * mult * reduction * backM * critM;
    const dmg = Math.max(1, Math.floor(raw));
    // 步骤 7 吸血（角色伤害；基地不吸血由调用方不走本函数）
    let lifesteal = 0;
    const ls = (attacker.special && attacker.special.lifesteal) || 0;
    if (ls > 0) {
      lifesteal = Math.floor(dmg * ls);
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + lifesteal);
      logger.trace('damage', 'damage.lifesteal', `${attacker.id} 吸血 +${lifesteal}`, { attacker: attacker.id, lifesteal });
    }
    // 步骤 8 应用 + damage.calc（每步中间值）
    defender.hp = Math.max(0, defender.hp - dmg);
    logger.debug('damage', 'damage.calc', `${attacker.id} -> ${defender.id} ${dmg}`, {
      attacker: attacker.id, target: defender.id, mult, reduction, backM, critM,
      backstab: !!p.backstab, crit, trueDamage: !!p.trueDamage, raw, dmg, lifesteal,
    });
    // 步骤 9 附加效果（伤害生效后添加：眩晕/击退/拉近/持续伤害）
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

  // 附加效果入列（§4.4 步骤 9；登记：knockback/pull ±1 格、stun remaining 1、dot 持续 3 tick，B21 校准）
  function addAffixEffect(attacker, defender, affix, sourceDir) {
    const dir = sourceDir || attacker.facing || 1;
    const v = (affix.params && affix.params.v) || 1;
    if (affix.id === 'stun') {
      effects.addEffect(battleState, { kind: 'control', target: defender.owner, displacement: 0, remaining: 1, source: attacker.owner });
    } else if (affix.id === 'knockback') {
      effects.addEffect(battleState, { kind: 'control', target: defender.owner, displacement: dir * v, remaining: 1, source: attacker.owner });
    } else if (affix.id === 'pull') {
      effects.addEffect(battleState, { kind: 'control', target: defender.owner, displacement: -dir * v, remaining: 1, source: attacker.owner });
    } else if (affix.id === 'dot') {
      effects.addEffect(battleState, { kind: 'continuous', target: defender.owner, stat: 'hp', delta: -v, remaining: 3, source: attacker.owner });
    } else if (affix.id === 'true_dmg') {
      const trueDmg = Math.max(0, Math.floor(v));
      defender.hp = Math.max(0, defender.hp - trueDmg); // 附加真实伤害（登记：数值直扣，B21 校准）
      logger.debug('damage', 'damage.calc', `${attacker.id} -> ${defender.id} ${trueDmg}（附加真实伤害）`, {
        attacker: attacker.id, target: defender.id, trueDamage: true, raw: trueDmg, dmg: trueDmg, lifesteal: 0,
      });
    }
    // cast_buff / crit_chance / lifesteal 词条：buff 结算属 B14 谱系，crit/lifesteal 已并入面板（B5）
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
      return {
        p1: { fromX: a.x, toX: round1(field.clampX(settle(a))) },
        p2: { fromX: b.x, toX: round1(field.clampX(settle(b))) },
        collision: null,
        // owner 与 field.touchesBase 同规则（facing 朝向哨位侧基地，B8 审查 P1-1）
        baseHit: aBase ? { owner: a.player.facing > 0 ? 'p2' : 'p1', by: a.player, atX: a.x }
          : bBase ? { owner: b.player.facing > 0 ? 'p2' : 'p1', by: b.player, atX: b.x }
            : null,
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
    const players = state.players;
    const p1 = players.p1, p2 = players.p2;

    state.tick += 1;
    const tick = state.tick;
    logger.info('engine', 'tick.begin', `tick ${tick}`, { tick });
    const stepLog = (stepNo, msg, data) => logger.debug('engine', 'tick.step', `[${stepNo}] ${msg}`, Object.assign({ step: stepNo }, data || {}));

    // 步骤 1：冷却递减 max(0, cd−1)（D-82）+ 重置临时标记
    for (const p of [p1, p2]) {
      for (const k of Object.keys(p.cooldowns)) p.cooldowns[k] = Math.max(0, p.cooldowns[k] - 1);
      p.defending = false;
      p.fullDodgeDuring = false;
      p.dodging = false;
    }
    stepLog(1, '冷却递减/重置标记');

    // 步骤 2：持续效果
    effects.resolveContinuous({ tick, players });
    stepLog(2, '持续效果');

    // 步骤 3：AI 续执行 / 行动注入（B8：由调用方注入；B15 起 AI 链路替换）
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
        if (!sk) { plans[owner] = plan; continue; } // 未知技能（normalize 已挡；防御）
        const can = skills.canCast(sk, p);
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
        }
      } else if (intent.type === 'defend') {
        plan.kind = 'defend';
        p.defending = true; // 本 tick def×1.6（D-43）
      }
      plans[owner] = plan;
    }
    stepLog(6, '意图提交');

    // 步骤 7：统一落位与角色碰撞（07 §1 五步）
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
    const critRng = battleState.rng.deriveStream(tick, 'crit');
    for (const h of bulletEvents.hits) {
      const atk = players[h.owner];
      const def = players[h.target];
      if (def.hp <= 0) continue;
      const backstab = isBackstab({ attackerX: atk.x, attackerFacing: atk.facing }, def, h.srcType || 'aoe', h.dir);
      dealDamage(atk, def, {
        mult: h.payload.multiplier * h.falloffFactor,
        critRng, backstab, affixes: h.payload.affixes || [], sourceDir: h.dir,
      });
    }
    if (resolved.collision) {
      // 双方各受对方 atk×0.8（D-10），走完整机制（闪避/暴击/背击/吸血，§4.3）；背击按位移后位置判定
      dealDamage(p1, p2, { mult: cfg.collisionDmgMul, critRng, backstab: isBackstab({ attackerX: p1.x }, p2, 'melee') });
      dealDamage(p2, p1, { mult: cfg.collisionDmgMul, critRng, backstab: isBackstab({ attackerX: p2.x }, p1, 'melee') });
    }
    if (resolved.baseHit) {
      // 撞基地：atk×0.8 走基地 def 减伤（D-34/D-61；无暴击/背击/吸血）
      const base = battleState.bases[resolved.baseHit.owner];
      const atk = resolved.baseHit.by;
      const reduction = 1 - base.def / (base.def + DEF_K);
      base.hp = Math.max(0, base.hp - Math.max(1, Math.floor(atk.atk * cfg.collisionDmgMul * reduction)));
    }
    stepLog(9, '伤害结算');

    // 步骤 10：资源恢复（D-110 模板 regen，上限封顶）
    for (const owner of ['p1', 'p2']) {
      const p = players[owner];
      const before = { mp: p.mp, sp: p.sp };
      p.mp = Math.min(p.maxMp, p.mp + (p.regen.mp || 0));
      p.sp = Math.min(p.maxSp, p.sp + (p.regen.sp || 0));
      if (p.mp !== before.mp || p.sp !== before.sp) {
        logger.trace('engine', 'resource.regen', `${owner} mp ${before.mp}->${p.mp} sp ${before.sp}->${p.sp}`, { owner, mp: p.mp, sp: p.sp });
      }
    }
    stepLog(10, '资源恢复');

    // 步骤 11：超时扣血（tick ≥ overtimeStart：双方基地与角色同时扣 ceil(本方 maxHp×ratio)，B8 审查 P2-1）
    if (tick >= cfg.overtimeStart) {
      for (const owner of ['p1', 'p2']) {
        const p = players[owner];
        const cut = Math.ceil(p.maxHp * cfg.overtimeRatio);
        p.hp = Math.max(0, p.hp - cut);
        state.bases[owner].hp = Math.max(0, state.bases[owner].hp - cut);
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

    // 步骤 13：帧差异（diff；前端只按 diff 插值）
    const diff = {
      tick,
      players: {
        p1: { fromX: resolved.p1.fromX, toX: p1.x, facing: p1.facing, hp: p1.hp, mp: p1.mp, sp: p1.sp },
        p2: { fromX: resolved.p2.fromX, toX: p2.x, facing: p2.facing, hp: p2.hp, mp: p2.mp, sp: p2.sp },
      },
      collision: resolved.collision,
      bulletHits: bulletEvents.hits.map((h) => ({ uid: h.uid, target: h.target, atX: h.atX })),
      verdict: state.verdict || null,
      aiTraces: [],
    };
    stepLog(13, '帧输出');

    // 步骤 14
    logger.info('engine', 'tick.end', `tick ${tick} 完成`, { tick });
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
      let winner;
      for (let i = 0; i < cfg.hardCapTick; i++) {
        battle.step(ro);
        if (battleState.verdict) { winner = battleState.verdict.winner; break; }
      }
      return { winner, ticks: battleState.tick };
    },
  };
  return battle;
}

module.exports = { createBattle };