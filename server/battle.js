// Battle Engine v4 - 百分比减伤 · 个性恢复 · 动态防御 · 基地系统
const skillsData = require('../data/skills.json');
const charsData = require('../data/characters.json');
const configData = require('../data/config.json');

class BattleEngine {
  constructor() { this.state = null; this.p1Actions = []; this.p2Actions = []; }
  init(s) {
    this.state = s;
    s._cooldowns_p1 = {};
    s._cooldowns_p2 = {};
    // 缓存角色定义
    s._charDef_p1 = charsData.characters.find(c => c.id === s.p1.charId) || charsData.characters[0];
    s._charDef_p2 = charsData.characters.find(c => c.id === s.p2.charId) || charsData.characters[0];
    // 基地数据：优先从传入的 _inheritBases 继承 hp，其他字段从 config 读取
    const baseCfg = configData.base;
    const inherit = s._inheritBases || {};
    s.bases = {
      p1: { hp: inherit.p1?.hp ?? baseCfg.hp, maxHp: baseCfg.hp, def: baseCfg.def, atk: baseCfg.atk, x: baseCfg.positions.p1 },
      p2: { hp: inherit.p2?.hp ?? baseCfg.hp, maxHp: baseCfg.hp, def: baseCfg.def, atk: baseCfg.atk, x: baseCfg.positions.p2 }
    };
    delete s._inheritBases; // 清理，避免污染状态
  }
  setActions(a1, a2) { this.p1Actions = a1; this.p2Actions = a2; }
  getState() {
    const s = JSON.parse(JSON.stringify(this.state));
    // 清理内部字段，只保留前端需要的
    delete s._cooldowns_p1;
    delete s._cooldowns_p2;
    delete s._charDef_p1;
    delete s._charDef_p2;
    delete s._training;
    return s;
  }

  /** 百分比减伤公式：减伤率 = DEF / (DEF + 40)，最终伤害 = max(1, floor(基础 × (1-减伤率))) */
  getDefReduction(def) {
    return def / (def + 40);
  }

  /**
   * 判断攻击是否来自受击者的背后
   * 纯粹从受击者视角：受击者面朝前，攻击来源在身后 → true
   * 与攻击者的朝向无关
   * @param {number} attackFromX - 攻击来源的格子坐标
   * @param {object} victim - 受击者（需要有 x 和 facing）
   */
  isAttackFromBehind(attackFromX, victim) {
    const vf = victim.facing;
    // 受击者面朝右(1)，攻击来自左侧(x<victim.x)才是背后
    // 受击者面朝左(-1)，攻击来自右侧(x>victim.x)才是背后
    return (vf === 1 && attackFromX < victim.x) || (vf === -1 && attackFromX > victim.x);
  }

  /** 通用背刺增伤倍率 */
  getUniversalBackstabMultiplier() {
    return configData.damage.universalBackstabMultiplier || 1.3;
  }

  /** 
   * 统一结算规则（16tick 全部播完后调用）：
   *   优先级：基地摧毁 > 角色死亡
   *   1. 双方基地都为0 → 平局
   *   2. 一方基地为0 → 基地未归零的获胜
   *   3. 双方基地都正常 → 检查角色：
   *      双方角色同时死亡 → 平局
   *      一方死亡 → 存活方获胜
   *      都存活 → null (继续下一轮)
   *   特殊情况：一方基地为0且另一方角色血量为0 → 基地为0的优先判负
   * 返回：{ winner: 'P1'|'P2'|'draw'|null, reason: string }
   */
  static judge(s, maxRounds, round) {
    const b1hp = s.bases?.p1?.hp ?? 100, b2hp = s.bases?.p2?.hp ?? 100;
    const p1Dead = s.p1.hp <= 0, p2Dead = s.p2.hp <= 0;
    const b1Dead = b1hp <= 0, b2Dead = b2hp <= 0;

    // 双基地都无 → 平局
    if (b1Dead && b2Dead) return { winner: 'draw', reason: '双方基地均被摧毁' };
    // 单方基地无 → 另一人胜（即使他角色也死了）
    if (b1Dead) return { winner: 'P2', reason: 'P1基地被摧毁' };
    if (b2Dead) return { winner: 'P1', reason: 'P2基地被摧毁' };
    // 基地都健在，看角色
    if (p1Dead && p2Dead) return { winner: 'draw', reason: '双方同时阵亡' };
    if (p1Dead) return { winner: 'P2', reason: '对方被击杀' };
    if (p2Dead) return { winner: 'P1', reason: '对方被击杀' };
    // 达到最大回合数
    if (round >= maxRounds) {
      if (s.p1.hp > s.p2.hp) return { winner: 'P1', reason: 'HP领先' };
      if (s.p2.hp > s.p1.hp) return { winner: 'P2', reason: 'HP领先' };
      return { winner: 'draw', reason: '达到最大回合数，平局' };
    }
    return null; // 继续
  }

  executeAll() {
    const frames = [], s = this.state;
    let dead = false;
    for (let tick = 0; tick < 16; tick++) {
      s._bullets = [];
      if (dead) {
        const saved1 = this.p1Actions[tick], saved2 = this.p2Actions[tick];
        this.p1Actions[tick] = 'wait';
        this.p2Actions[tick] = 'wait';
        const frame = this.executeTick(tick);
        this.p1Actions[tick] = saved1;
        this.p2Actions[tick] = saved2;
        frame._dead = true;
        frames.push(frame);
      } else {
        const frame = this.executeTick(tick);
        frames.push(frame);
      }
      if (!dead && (s.p1.hp <= 0 || s.p2.hp <= 0 || (s.bases && (s.bases.p1.hp <= 0 || s.bases.p2.hp <= 0)))) {
        dead = true;
      }
    }
    return frames;
  }

  executeTick(tick) {
    const s = this.state;
    // Tick cooldowns
    for (const k of ['p1', 'p2']) {
      const cd = s['_cooldowns_' + k];
      for (const sk in cd) { if (cd[sk] > 0) cd[sk]--; }
    }

    const a1 = this.p1Actions[tick] || 'wait';
    const a2 = this.p2Actions[tick] || 'wait';

    const p1Result = this.tickEffects(s, 'p1');
    const p2Result = this.tickEffects(s, 'p2');
    const p1Stunned = p1Result.stunned;
    const p2Stunned = p2Result.stunned;
    let p1Act = p1Stunned ? 'stunned' : a1;
    let p2Act = p2Stunned ? 'stunned' : a2;

    // Frozen override
    if (s.p1._frozen) { p1Act = 'stunned'; s.p1._frozen = false; s.p1._wasFrozen = true; }
    if (s.p2._frozen) { p2Act = 'stunned'; s.p2._frozen = false; s.p2._wasFrozen = true; }

    const p1FromX = s.p1.x, p1FromFacing = s.p1.facing;
    const p2FromX = s.p2.x, p2FromFacing = s.p2.facing;

    const p1Intent = this.getMoveIntent(s.p1, p1Act);
    const p2Intent = this.getMoveIntent(s.p2, p2Act);
    const collision = this.checkCollision(s.p1, s.p2, p1Intent, p2Intent);
    const baseEvents = this.applyMovement(s.p1, s.p2, p1Intent, p2Intent, collision, p1Act, p2Act);

    // 保存敌人移动前位置，供 teleport_backstab 使用
    s.p1._enemyFromX = p2FromX; s.p2._enemyFromX = p1FromX;
    s.p1._enemyFromFacing = p2FromFacing; s.p2._enemyFromFacing = p1FromFacing;

    const p1SR = this.executeAction(s.p1, s.p2, p1Act, 'p1', 'p2', tick, p2FromX, p2FromFacing);
    const p2SR = this.executeAction(s.p2, s.p1, p2Act, 'p2', 'p1', tick, p1FromX, p1FromFacing);

    // 弹幕碰撞
    const clashEvents = this.resolveBulletCollisions(s._bullets);

    if (s.p1._effects?.length > 0) {}
    if (s.p2._effects?.length > 0) {}
    if (p1Stunned) {}
    if (p2Stunned) {}

    // 资源恢复
    const cd1 = s._charDef_p1, cd2 = s._charDef_p2;
    s.p1.sp = Math.min(s.p1.maxSp, s.p1.sp + (cd1.spRegen || 2));
    s.p2.sp = Math.min(s.p2.maxSp, s.p2.sp + (cd2.spRegen || 2));
    s.p1.mp = Math.min(s.p1.maxMp, s.p1.mp + (cd1.mpRegen || 1));
    s.p2.mp = Math.min(s.p2.maxMp, s.p2.mp + (cd2.mpRegen || 1));

    return {
      tick, p1: this.clonePlayer(s.p1), p2: this.clonePlayer(s.p2),
      p1FromX, p1FromFacing, p2FromX, p2FromFacing,
      p1Actions: [...this.p1Actions], p2Actions: [...this.p2Actions],
      bullets: JSON.parse(JSON.stringify(s._bullets)),
      events: [...(p1SR?.events || []), ...(p2SR?.events || []), ...(collision?.events || []), ...(baseEvents || []), ...(clashEvents || []), ...(p1Result.dotEvents || []), ...(p2Result.dotEvents || [])],
      animData: this.getAnimData([...(p1SR?.events||[]),...(p2SR?.events||[]),...(collision?.events||[]),...(clashEvents||[])]),
      p1Act, p2Act, p1Stunned, p2Stunned,
      bases: this.cloneBases(s.bases),
    };
  }

  getAnimData(events) {
    const anims = require('../data/skills.json').animations || {};
    const map = { collision: 'collision', melee_hit: 'melee_hit', bullet_hit: 'bullet_hit', bullet_clash: 'bullet_clash', bullet_trail: 'bullet_fly', bullet_trail_cut: 'bullet_fly', dash: 'dash', dash_hit: 'dash', dash_charge: 'dash_charge', dodged: 'dodge', teleport: 'teleport', aoe_hit: 'aoe', aoe_cast: 'aoe', stun_hit: 'stun', freeze_hit: 'freeze', burn_hit: 'burn', poison_hit: 'poison', knockback: 'knockback', backstab_hit: 'backstab', shield_wall: 'shield_wall', base_hit: 'baseHit', burn_tick: 'burn', poison_tick: 'poison', melee_clash: 'bullet_clash' };
    return events.map(ev => ({ ...ev, anim: anims[map[ev.type]] || null }));
  }

  getMoveIntent(player, action) {
    const i = { dx: 0, isDodge: false, isDefend: false, isTurn: false };
    if (action === 'move_left') i.dx = -1;
    if (action === 'move_right') i.dx = 1;
    if (action === 'dodge_left') { i.dx = -2; i.isDodge = true; }
    if (action === 'dodge_right') { i.dx = 2; i.isDodge = true; }
    if (action === 'defend') i.isDefend = true;
    if (action === 'turn') i.isTurn = true;
    return i;
  }

  checkCollision(p1, p2, i1, i2) {
    const events = [], p1D = p1.x + i1.dx, p2D = p2.x + i2.dx;
    // 碰撞伤害用百分比减伤（但保留最低伤害），加上通用背刺增伤
    let dmgP1toP2 = Math.max(1, Math.floor(p1.atk * 0.75 * (1 - this.getDefReduction(p2.def))));
    let dmgP2toP1 = Math.max(1, Math.floor(p2.atk * 0.75 * (1 - this.getDefReduction(p1.def))));
    // 通用背刺增伤：攻击来自受击者背后时 ×1.3
    if (this.isAttackFromBehind(p1.x, p2)) dmgP1toP2 = Math.floor(dmgP1toP2 * this.getUniversalBackstabMultiplier());
    if (this.isAttackFromBehind(p2.x, p1)) dmgP2toP1 = Math.floor(dmgP2toP1 * this.getUniversalBackstabMultiplier());
    if (i1.dx !== 0 && i2.dx !== 0) {
      if (p1D === p2D) {
        p1.hp = Math.max(0, p1.hp - dmgP2toP1); p2.hp = Math.max(0, p2.hp - dmgP1toP2);
        events.push({ type: 'collision', x: p1D, dmg1: dmgP2toP1, dmg2: dmgP1toP2, hit_anim:'collisionFX', bullet_color:'#ffff00' });
        return { type: 'both', events };
      }
    }
    if (i1.dx !== 0 && p1D === p2.x && i2.dx === 0 && !i1.isDodge) {
      p1.hp = Math.max(0, p1.hp - dmgP2toP1); p2.hp = Math.max(0, p2.hp - dmgP1toP2);
      events.push({ type: 'collision', x: p2.x, dmg1: dmgP2toP1, dmg2: dmgP1toP2, hit_anim:'collisionFX', bullet_color:'#ffff00' });
      return { type: 'p1Blocked', events };
    }
    if (i2.dx !== 0 && p2D === p1.x && i1.dx === 0 && !i2.isDodge) {
      p1.hp = Math.max(0, p1.hp - dmgP2toP1); p2.hp = Math.max(0, p2.hp - dmgP1toP2);
      events.push({ type: 'collision', x: p1.x, dmg1: dmgP2toP1, dmg2: dmgP1toP2, hit_anim:'collisionFX', bullet_color:'#ffff00' });
      return { type: 'p2Blocked', events };
    }
    return null;
  }

  applyMovement(p1, p2, i1, i2, collision, a1, a2) {
    const events = [];
    if (i1.isTurn) p1.facing *= -1;
    if (i2.isTurn) p2.facing *= -1;
    if (i1.isDefend) p1._defBuff = (p1._defBuff || 0) + Math.floor(p1.def * 2.4);
    if (i2.isDefend) p2._defBuff = (p2._defBuff || 0) + Math.floor(p2.def * 2.4);
    if (collision) return events;
    if (i1.dx !== 0 && !i1.isTurn) {
      let d = p1.x + i1.dx;
      if (!i1.isDodge && d === p2.x) d = p1.x;
      if (i1.isDodge && d === p2.x) d = p2.x + (i1.dx > 0 ? -1 : 1);
      // 基地攻击：P1向右侧边界（=P2基地方向）移动攻击基地
      if (i1.dx > 0 && d > 15 && this.state.bases) {
        const base = this.state.bases.p2;
        const dmg = Math.max(1, Math.floor(p1.atk * 0.75 * (1 - this.getDefReduction(base.def))));
        base.hp = Math.max(0, base.hp - dmg);
        const rebound = Math.max(1, Math.floor(base.atk * 0.75 * (1 - this.getDefReduction(p1.def))));
        p1.hp = Math.max(0, p1.hp - rebound);
        p1.x = 15;
        events.push({ type: 'base_hit', actor: 'p1', target: 'p2_base', dmg, x: 15, bullet_color: '#ff8800' });
      } else {
        p1.x = Math.max(0, Math.min(15, d));
      }
    }
    if (i2.dx !== 0 && !i2.isTurn) {
      let d = p2.x + i2.dx;
      if (!i2.isDodge && d === p1.x) d = p2.x;
      if (i2.isDodge && d === p1.x) d = p1.x + (i2.dx > 0 ? -1 : 1);
      // 基地攻击：P2向左侧边界（=P1基地方向）移动攻击基地
      if (i2.dx < 0 && d < 0 && this.state.bases) {
        const base = this.state.bases.p1;
        const dmg = Math.max(1, Math.floor(p2.atk * 0.75 * (1 - this.getDefReduction(base.def))));
        base.hp = Math.max(0, base.hp - dmg);
        const rebound = Math.max(1, Math.floor(base.atk * 0.75 * (1 - this.getDefReduction(p2.def))));
        p2.hp = Math.max(0, p2.hp - rebound);
        p2.x = 0;
        events.push({ type: 'base_hit', actor: 'p2', target: 'p1_base', dmg, x: 0, bullet_color: '#ff8800' });
      } else {
        p2.x = Math.max(0, Math.min(15, d));
      }
    }
    p1._dodging = i1.isDodge; p2._dodging = i2.isDodge;
    return events;
  }

  executeAction(caster, target, action, cKey, tKey, tick, enemyFromX, enemyFromFacing) {
    const events = [];
    if (['move_left', 'move_right', 'dodge_left', 'dodge_right', 'defend', 'turn', 'stunned', 'wait'].includes(action)) return { events };

    const idxMap = { skill1: 0, skill2: 1, skill3: 2 };
    const idx = idxMap[action];
    if (idx === undefined) return { events };

    const sid = caster.skills?.[idx];
    if (!sid) return { events };

    const allSk = { ...skillsData.skills, ...(caster.customSkills || {}) };
    const sk = allSk[sid];
    if (!sk) return { events };

    // Check cooldown
    const cdKey = '_cooldowns_' + cKey;
    const isTraining = this.state._training === true;
    if (!isTraining && this.state[cdKey]?.[sid] > 0) {
      events.push({ type: 'on_cooldown', actor: cKey, skillId: sid });
      return { events };
    }

    // Check resources - if insufficient, EXHAUST (skip in training mode)
    const hasMp = (caster.mp || 0) >= (sk.mpCost || 0);
    const hasSp = (caster.sp || 0) >= (sk.spCost || 0);
    if (!isTraining && (!hasMp || !hasSp)) {
      events.push({ type: 'exhausted', actor: cKey, skillId: sid });
      return { events };
    }
    if (!isTraining) {
      caster.mp -= (sk.mpCost || 0);
      caster.sp -= (sk.spCost || 0);
    }
    // Set cooldown (skip in training mode)
    if (!isTraining && sk.cooldown) this.state[cdKey][sid] = sk.cooldown;

    const dir = caster.facing;

    switch (sk.type) {
      case 'melee': {
        const rg = sk.range || 1;
        // 使用敌人初始位置（移位前），不受本tick移动影响
        const targetX = enemyFromX !== undefined ? enemyFromX : target.x;
        const dist = Math.abs(caster.x - targetX);
        let inRange = false;
        if (sk.direction === 'forward') inRange = dist <= rg && ((dir === 1 && targetX >= caster.x) || (dir === -1 && targetX <= caster.x));
        else if (sk.direction === 'forward_and_back') inRange = dist <= rg;
        else if (sk.direction === 'around') inRange = dist <= rg;
        // ★ 近战弹幕：中心格 = 攻击范围的中心
        let centerGX = caster.x;
        if (sk.direction === 'forward') {
          const midOffset = Math.floor((rg + 1) / 2);
          centerGX = caster.x + dir * midOffset;
        }
        // forward_and_back 和 around：中心在 caster.x
        events.push({ type: 'melee_slash', actor: cKey, skillId: sid,
          bullet_anim: sk.anim_bullet || 'meleeSwing', bullet_color: sk.color, bullet_x: centerGX, facing: dir });

        // 计算近战覆盖范围
        const meleePath = [];
        if (sk.direction === 'forward') {
          for (let d = 1; d <= rg; d++) {
            const gx = caster.x + dir * d;
            if (gx >= 0 && gx <= 15) meleePath.push(gx);
          }
        } else if (sk.direction === 'forward_and_back') {
          for (let d = -rg; d <= rg; d++) {
            const gx = caster.x + d;
            if (gx >= 0 && gx <= 15) meleePath.push(gx);
          }
        } else if (sk.direction === 'around') {
          for (let d = -rg; d <= rg; d++) {
            const gx = caster.x + d;
            if (gx >= 0 && gx <= 15) meleePath.push(gx);
          }
        }
        this.state._bullets.push({
          owner: cKey, type: 'melee', priority: sk.bulletPriority || 3,
          fromX: caster.x, dir, pathGrids: meleePath,
          color: sk.color, anim_hit: sk.anim_hit || 'hitSlash', skillId: sid
        });

        if (inRange) {
          // 统一背刺判断：攻击来源(caster.x)是否在受击者(target)的背后
          const isBehind = this.isAttackFromBehind(caster.x, target);
          let ratio = sk.damageRatio || 1;
          // 刺客匕首背刺：2倍真实伤害（无视防御），不使用 backstabRatio
          if (sk.effect === 'true_damage' && isBehind) {
            ratio = (sk.damageRatio || 1) * 2;
          } else if (sk.backstabRatio && isBehind) {
            ratio = sk.backstabRatio;
          }
          const defBuff = target._defBuff || 0;
          let dmg = this.calcDmg(caster.atk, ratio, target.def, sk.effect, defBuff);
          // 通用背刺增伤：来自后方的攻击 ×1.3（刺客匕首已在上面单独处理，不叠加）
          if (isBehind && sk.effect !== 'true_damage') {
            dmg = Math.floor(dmg * this.getUniversalBackstabMultiplier());
          }
          if (!target._dodging) target.hp = Math.max(0, target.hp - dmg);
          else events.push({ type: 'dodged', actor: tKey });
          const evType = sk.effect === 'stun_damage' ? 'stun_hit' : (sk.effect === 'true_damage' && isBehind ? 'backstab_hit' : 'melee_hit');
          events.push({ type: evType, actor: cKey, target: tKey, dmg, skillId: sid,
            hit_anim: sk.anim_hit || 'hitSlash', bullet_color: sk.color, x: target.x });
          if (sk.effect === 'stun_damage' && sk.stunDuration) {
            target._effects = target._effects || [];
            target._effects.push({ type: 'stun', ticks: sk.stunDuration });
          }
        }
        break;
      }
      case 'projectile': {
        const range = sk.bulletRange || 99;
        const pri = sk.bulletPriority || 4;
        const shots = sk.multiShot || 1;
        const targetX = enemyFromX !== undefined ? enemyFromX : target.x;
        const maxX = Math.max(0, Math.min(15, caster.x + dir * range));
        const bulletPath = [];
        for (let scan = 1; scan <= range; scan++) {
          const sx = caster.x + dir * scan;
          if (sx < 0 || sx > 15) break;
          bulletPath.push(sx);
        }

        for (let s = 0; s < shots; s++) {
          const hitIdx = bulletPath.indexOf(targetX);
          const willHit = hitIdx >= 0 && !target._dodging;
          const targetDodged = hitIdx >= 0 && target._dodging;

          // 注册弹幕到 _bullets（不在此处应用伤害，留给碰撞解析后统一处理）
          // 通用背刺判断：弹幕来自目标背后时 ×1.3
          let projDmg = this.calcDmg(caster.atk, sk.damageRatio || 1, target.def, sk.effect, target._defBuff || 0);
          const projIsBackstab = this.isAttackFromBehind(caster.x, target);
          if (projIsBackstab) {
            projDmg = Math.floor(projDmg * this.getUniversalBackstabMultiplier());
          }
          this.state._bullets.push({
            owner: cKey, type: 'projectile', priority: pri,
            fromX: caster.x, toX: maxX, dir,
            pathGrids: [...bulletPath],
            color: sk.color,
            anim_bullet: sk.anim_bullet || 'arrowFly',
            anim_hit: sk.anim_hit || 'hitExplosion',
            skillId: sid, multiIdx: s,
            _hitGrid: willHit ? targetX : null,
            _hitCtx: willHit ? {
              casterKey: cKey, targetKey: tKey,
              dmg: projDmg,
              effect: sk.effect,
              freezeDuration: sk.freezeDuration,
              poisonTicks: sk.poisonTicks,
              poisonRatio: sk.poisonRatio,
              hitAnim: sk.anim_hit || 'hitExplosion',
              fromX: caster.x,
              isBackstab: projIsBackstab,
            } : null
          });
          if (targetDodged) {
            events.push({ type: 'dodged', actor: tKey, x: targetX });
          }
        }
        break;
      }
      case 'targeted_aoe': {
        const aoeR = sk.aoeRadius || 1;
        const tX = target.x;
        // 伤害判定（仅目标格）
        if (!target._dodging) {
          const defBuff = target._defBuff || 0;
          const dmg = this.calcDmg(caster.atk, sk.damageRatio || 1, target.def, sk.effect, defBuff);
          target.hp = Math.max(0, target.hp - dmg);
          const evT = sk.effect === 'burn_debuff' ? 'burn_hit' : 'aoe_hit';
          events.push({ type: evT, actor: cKey, target: tKey, dmg, x: tX, skillId: sid,
            bullet_anim: sk.anim_bullet||'arrowRainDrop', hit_anim: sk.anim_hit||'hitAOE', bullet_color: sk.color });
          if (sk.effect === 'burn_debuff') { target._effects = target._effects || []; target._effects.push({ type: 'burn', ticks: sk.burnTicks || 3, dmgPerTick: Math.max(1, Math.floor(caster.atk * (sk.burnRatio || 0.1))) }); }
        } else { events.push({ type: 'dodged', actor: tKey, x: tX }); }

        // 火球术(burn_debuff)：只落一个弹幕
        if (sk.effect === 'burn_debuff') {
          events.push({ type: 'aoe_cast', actor: cKey, skillId: sid, x: tX,
            bullet_anim: sk.anim_bullet||'fireballDrop', bullet_color: sk.color, bullet_noHit: false });
        } else {
          // 箭雨：多根箭接力下落（目标格 + 周围空格的视觉箭）
          for (let ox = -aoeR; ox <= aoeR; ox++) {
            const ax = tX + ox;
            if (ax < 0 || ax > 15) continue;
            if (ax !== tX) {
              events.push({ type: 'aoe_cast', actor: cKey, skillId: sid, x: ax,
                bullet_anim: sk.anim_bullet||'arrowRainDrop', bullet_color: sk.color, bullet_noHit: true });
            }
          }
          events.push({ type: 'aoe_cast', actor: cKey, skillId: sid, x: tX,
            bullet_anim: sk.anim_bullet||'arrowRainDrop', bullet_color: sk.color, bullet_noHit: false });
        }
        break;
      }
      case 'dash': {
        const dDist = sk.range || 3;
        const dashFromX = caster.x; // 保存冲刺起点
        let dest = caster.x + dir * dDist;
        dest = Math.max(0, Math.min(15, dest));
        const startX = Math.min(caster.x, dest), endX = Math.max(caster.x, dest);
        if (target.x >= startX && target.x <= endX && !target._dodging) {
          const defBuff = target._defBuff || 0;
          let dmg = this.calcDmg(caster.atk, sk.damageRatio || 1, target.def, sk.effect, defBuff);
          // 通用背刺增伤：冲刺命中来自目标背后时 ×1.3
          if (this.isAttackFromBehind(caster.x, target)) {
            dmg = Math.floor(dmg * this.getUniversalBackstabMultiplier());
          }
          const hitTargetX = target.x; // 保存命中位置
          target.hp = Math.max(0, target.hp - dmg);
          events.push({ type: 'dash_hit', actor: cKey, target: tKey, dmg, x: hitTargetX, skillId: sid, bullet_anim: sk.anim_bullet||'dashTrail', hit_anim: sk.anim_hit||'hitSlash', bullet_color: sk.color, bullet_from: dashFromX, bullet_to: dest, facing: dir });
          if (sk.knockback) {
            const kbDir = dir; // 始终向技能释放方向击退
            const oldTargetX = target.x;
            let tNewX = oldTargetX + kbDir * sk.knockback;
            tNewX = Math.max(0, Math.min(15, tNewX));
            if (tNewX === caster.x) tNewX += kbDir;
            if (tNewX === dest) tNewX += kbDir;
            tNewX = Math.max(0, Math.min(15, tNewX));
            target.x = tNewX;
            events.push({ type: 'knockback', actor: tKey, from: oldTargetX, to: tNewX, hit_anim: 'knockbackFX', bullet_color: '#ffaa00' });
          }
          if (dest === target.x) dest = target.x + (dir > 0 ? -1 : 1);
          dest = Math.max(0, Math.min(15, dest));
        } else if (target._dodging && target.x === dest) {
          // 目标闪避到了 dash 终点，把目标再推一格（推到 dash 施法者身后）
          const dodgePushDir = (target.x > (enemyFromX !== undefined ? enemyFromX : caster.x)) ? 1 : -1;
          const oldTargetX = target.x;
          let newTargetX = target.x + dodgePushDir;
          newTargetX = Math.max(0, Math.min(15, newTargetX));
          // 如果推到边界外或推到施法者身上，反向推
          if (newTargetX === oldTargetX || newTargetX === caster.x) {
            newTargetX = target.x - dodgePushDir;
            newTargetX = Math.max(0, Math.min(15, newTargetX));
          }
          target.x = newTargetX;
        }
        if (sk.defBuff) caster._defDash = Math.floor(caster.def * sk.defBuff);
        caster.x = dest;
        events.push({ type: 'dash', actor: cKey, to: dest, skillId: sid, bullet_anim: sk.anim_bullet||'dashTrail', bullet_color: sk.color, bullet_from: dashFromX, bullet_to: dest, facing: dir });
        // 金色冲锋特效：跟随角色移动的像素画光效
        events.push({ type: 'dash_charge', actor: cKey, skillId: sid, bullet_from: dashFromX, bullet_to: dest, facing: dir,
          bullet_anim: 'dash_charge', bullet_color: '#ffcc00' });
        break;
      }
      case 'teleport_backstab': {
        const enemyX = enemyFromX !== undefined ? enemyFromX : target.x;
        const enemyFacing = enemyFromFacing !== undefined ? enemyFromFacing : target.facing;
        let tpX = enemyX - enemyFacing;
        tpX = Math.max(0, Math.min(15, tpX));
        if (tpX === enemyX) tpX = Math.max(0, Math.min(15, enemyX + enemyFacing));
        const oldX = caster.x;
        // 碰撞检测：如果目标格已被占据（敌人移动到了那里），则留在原地并碰撞
        if (tpX === target.x) {
          const dmgToTarget = Math.max(1, Math.floor(caster.atk * 0.75 * (1 - this.getDefReduction(target.def))));
          const dmgToCaster = Math.max(1, Math.floor(target.atk * 0.75 * (1 - this.getDefReduction(caster.def))));
          caster.hp = Math.max(0, caster.hp - dmgToCaster);
          target.hp = Math.max(0, target.hp - dmgToTarget);
          events.push({ type: 'collision', x: tpX, dmg1: dmgToCaster, dmg2: dmgToTarget, hit_anim: 'collisionFX', bullet_color: '#ffff00' });
        } else {
          caster.x = tpX;
        }
        if (caster.x > enemyX) caster.facing = -1;
        else if (caster.x < enemyX) caster.facing = 1;
        events.push({ type: 'teleport', actor: cKey, to: caster.x, skillId: sid,
          bullet_anim: sk.anim_bullet || 'teleportFlash', hit_anim: sk.anim_hit || 'teleportFlash', bullet_color: sk.color });
        break;
      }

    }
    return { events };
  }

  calcDmg(atk, ratio, def, effect, defBuff = 0) {
    const base = atk * ratio;
    // 真实伤害：完全无视防御和防御buff
    if (effect === 'true_damage' || effect === 'true_damage_backstab') return Math.max(1, Math.floor(base));
    // 计算有效防御（基础DEF + 临时防御buff）
    const effectiveDef = Math.max(0, (def || 0) + defBuff);
    const reduction = this.getDefReduction(effectiveDef);
    return Math.max(1, Math.floor(base * (1 - reduction)));
  }

  /**
   * 弹幕碰撞解析器
   *
   * 算法：
   * 1. 遍历所有弹幕对，找路径交集
   * 2. 交集中心 = Math.round((minOverlap + maxOverlap) / 2)
   * 3. melee vs melee: 双方在中心爆炸，都不消失
   * 4. melee vs projectile: projectile 被截断在交集的远端（projectile 最先进入交集的格）
   * 5. projectile vs projectile: 低等级在中心被消灭，同级双方都消灭
   * 6. 被消灭的弹幕生成 bullet_trail_cut（飞到截断位置）
   * 7. 未被消灭的弹幕：有 _hitCtx 则生成 bullet_hit；否则生成 bullet_trail
   */
  resolveBulletCollisions(bullets) {
    const events = [];
    if (!bullets || bullets.length < 2) {
      // 无碰撞：直接给所有投射物生成最终事件
      if (bullets) {
        for (const b of bullets) {
          if (b.type !== 'projectile') continue;
          if (b._hitCtx) {
            const ctx = b._hitCtx;
            const target = this.state[ctx.targetKey === 'p1' ? 'p1' : 'p2'];
            target.hp = Math.max(0, target.hp - ctx.dmg);
            const evT = ctx.effect === 'freeze_damage' ? 'freeze_hit' : (ctx.effect === 'poison_debuff' ? 'poison_hit' : 'bullet_hit');
            events.push({ type: evT, actor: ctx.casterKey, target: ctx.targetKey, dmg: ctx.dmg, x: b._hitGrid,
              bullet_anim: b.anim_bullet, hit_anim: ctx.hitAnim, bullet_color: b.color,
              bullet_from: ctx.fromX, bullet_to: b._hitGrid, facing: b.dir });
            if (ctx.effect === 'freeze_damage') { target._frozen = true; target._effects = target._effects || []; target._effects.push({ type: 'freeze', ticks: ctx.freezeDuration || 1 }); }
            if (ctx.effect === 'poison_debuff') { target._effects = target._effects || []; target._effects.push({ type: 'poison', ticks: ctx.poisonTicks || 5, dmgPerTick: Math.max(1, Math.floor(target.atk * (ctx.poisonRatio || 0.08))) }); }
          } else {
            events.push({ type: 'bullet_trail', actor: b.owner, bullet_anim: b.anim_bullet, bullet_color: b.color,
              bullet_from: b.fromX, bullet_to: b.toX, bullet_faded: true, facing: b.dir, skillId: b.skillId });
          }
        }
      }
      return events;
    }

    const eliminated = new Set();
    const n = bullets.length;

    for (let i = 0; i < n; i++) {
      if (eliminated.has(i)) continue;
      const a = bullets[i];
      for (let j = i + 1; j < n; j++) {
        if (eliminated.has(j)) continue;
        const b = bullets[j];
        if (a.owner === b.owner) continue;

        const overlap = a.pathGrids.filter(g => b.pathGrids.includes(g));
        if (overlap.length === 0) continue;

        const center = Math.round((overlap[0] + overlap[overlap.length - 1]) / 2);

        // melee vs melee
        if (a.type === 'melee' && b.type === 'melee') {
          events.push({ type: 'bullet_clash', x: center, winner: 'both', hit_anim: 'collisionFX', bullet_color: '#ffff00' });
          continue;
        }

        // melee vs projectile
        if ((a.type === 'melee' && b.type === 'projectile') || (a.type === 'projectile' && b.type === 'melee')) {
          const melee = a.type === 'melee' ? a : b;
          const proj = a.type === 'projectile' ? a : b;
          const projIdx = a.type === 'projectile' ? i : j;
          // projectile 被截断在 overlap 远端（projectile 最先到达的交集格）
          const projCutX = proj.dir > 0 ? overlap[0] : overlap[overlap.length - 1];

          if (melee.priority <= proj.priority) {
            eliminated.add(projIdx);
            events.push({ type: 'bullet_trail_cut', actor: proj.owner, bullet_anim: proj.anim_bullet, bullet_color: proj.color, bullet_from: proj.fromX, bullet_to: projCutX, facing: proj.dir, skillId: proj.skillId });
            events.push({ type: 'bullet_clash', x: projCutX, winner: melee.owner, hit_anim: proj.anim_hit, bullet_color: proj.color });
          } else {
            events.push({ type: 'bullet_clash', x: center, winner: proj.owner, hit_anim: melee.anim_hit, bullet_color: melee.color });
          }
          continue;
        }

        // projectile vs projectile
        if (a.type === 'projectile' && b.type === 'projectile') {
          if (a.priority < b.priority) {
            eliminated.add(j);
            events.push({ type: 'bullet_trail_cut', actor: b.owner, bullet_anim: b.anim_bullet, bullet_color: b.color, bullet_from: b.fromX, bullet_to: center, facing: b.dir, skillId: b.skillId });
            events.push({ type: 'bullet_clash', x: center, winner: a.owner, hit_anim: b.anim_hit, bullet_color: b.color });
          } else if (a.priority > b.priority) {
            eliminated.add(i);
            events.push({ type: 'bullet_trail_cut', actor: a.owner, bullet_anim: a.anim_bullet, bullet_color: a.color, bullet_from: a.fromX, bullet_to: center, facing: a.dir, skillId: a.skillId });
            events.push({ type: 'bullet_clash', x: center, winner: b.owner, hit_anim: a.anim_hit, bullet_color: a.color });
            break;
          } else {
            eliminated.add(i); eliminated.add(j);
            events.push({ type: 'bullet_trail_cut', actor: a.owner, bullet_anim: a.anim_bullet, bullet_color: a.color, bullet_from: a.fromX, bullet_to: center, facing: a.dir, skillId: a.skillId });
            events.push({ type: 'bullet_trail_cut', actor: b.owner, bullet_anim: b.anim_bullet, bullet_color: b.color, bullet_from: b.fromX, bullet_to: center, facing: b.dir, skillId: b.skillId });
            events.push({ type: 'bullet_clash', x: center, winner: 'both', hit_anim: 'collisionFX', bullet_color: '#ffff00' });
            break;
          }
        }
      }
    }

    // 未被消灭的投射物：应用命中伤害或生成飞行
    for (let i = 0; i < n; i++) {
      if (eliminated.has(i)) continue;
      const b = bullets[i];
      if (b.type !== 'projectile') continue;

      if (b._hitCtx) {
        const ctx = b._hitCtx;
        const caster = this.state[ctx.casterKey === 'p1' ? 'p1' : 'p2'];
        const target = this.state[ctx.targetKey === 'p1' ? 'p1' : 'p2'];
        target.hp = Math.max(0, target.hp - ctx.dmg);
        const evT = ctx.effect === 'freeze_damage' ? 'freeze_hit' : (ctx.effect === 'poison_debuff' ? 'poison_hit' : 'bullet_hit');
        events.push({ type: evT, actor: ctx.casterKey, target: ctx.targetKey, dmg: ctx.dmg, x: b._hitGrid,
          bullet_anim: b.anim_bullet, hit_anim: ctx.hitAnim, bullet_color: b.color,
          bullet_from: ctx.fromX, bullet_to: b._hitGrid, facing: b.dir, skillId: b.skillId });
        if (ctx.effect === 'freeze_damage') { target._frozen = true; target._effects = target._effects || []; target._effects.push({ type: 'freeze', ticks: ctx.freezeDuration || 1 }); }
        if (ctx.effect === 'poison_debuff') { target._effects = target._effects || []; target._effects.push({ type: 'poison', ticks: ctx.poisonTicks || 5, dmgPerTick: Math.max(1, Math.floor(caster.atk * (ctx.poisonRatio || 0.08))) }); }
      } else {
        events.push({ type: 'bullet_trail', actor: b.owner, bullet_anim: b.anim_bullet, bullet_color: b.color,
          bullet_from: b.fromX, bullet_to: b.toX, bullet_faded: true, facing: b.dir, skillId: b.skillId });
      }
    }

    return events;
  }

  tickEffects(s, key) {
    const p = s[key]; let stunned = false;
    const dotEvents = [];
    p._effects = (p._effects || []).filter(e => {
      if ((e.type === 'dot' || e.type === 'burn' || e.type === 'poison') && e.ticks > 0) {
        const dmg = e.dmgPerTick || 1;
        if (!p._dodging) p.hp = Math.max(0, p.hp - dmg);
        dotEvents.push({ type: e.type + '_tick', actor: key, dmg: p._dodging ? 0 : dmg, x: p.x,
          hit_anim: e.type === 'burn' ? 'hitBurn' : 'hitPoison', bullet_color: e.type === 'burn' ? '#ff6600' : '#88ff00' });
        e.ticks--; return e.ticks > 0;
      }
      if ((e.type === 'stun' || e.type === 'freeze') && e.ticks > 0) { stunned = true; e.ticks--; return e.ticks > 0; }
      return false;
    });
    p._defBuff = 0; p._dodging = false;
    if (p._defDash) { p._defBuff = (p._defBuff || 0) + p._defDash; p._defDash = 0; }
    return { stunned, dotEvents };
  }

  clonePlayer(p) {
    return {
      x: p.x, facing: p.facing, hp: p.hp, maxHp: p.maxHp,
      mp: p.mp, maxMp: p.maxMp, sp: p.sp, maxSp: p.maxSp,
      atk: p.atk, def: p.def, charId: p.charId,
      effects: JSON.parse(JSON.stringify(p._effects || [])),
      dodging: p._dodging || false, defBuff: p._defBuff || 0,
    };
  }

  cloneBases(bases) {
    if (!bases) return null;
    return {
      p1: { hp: bases.p1.hp, maxHp: bases.p1.maxHp, def: bases.p1.def, atk: bases.p1.atk, x: bases.p1.x },
      p2: { hp: bases.p2.hp, maxHp: bases.p2.maxHp, def: bases.p2.def, atk: bases.p2.atk, x: bases.p2.x }
    };
  }
}
module.exports = BattleEngine;
