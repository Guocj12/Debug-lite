// Battle Engine - 16tick回合制战斗引擎

const skillsData = require('../data/skills.json');
const config = require('../data/config.json');

class BattleEngine {
  constructor() {
    this.state = null;
    this.p1Actions = [];
    this.p2Actions = [];
  }

  init(s) { this.state = s; }

  setActions(a1, a2) { this.p1Actions = a1; this.p2Actions = a2; }

  getState() { return JSON.parse(JSON.stringify(this.state)); }

  // 执行全部16tick
  executeAll() {
    const frames = [];
    const s = this.state;
    s.bullets = [];
    s._effects_p1 = [];
    s._effects_p2 = [];

    for (let tick = 0; tick < 16; tick++) {
      const frame = this.executeTick(tick);
      frames.push(frame);
      if (s.p1.hp <= 0 || s.p2.hp <= 0) break;
    }
    return frames;
  }

  executeTick(tick) {
    const s = this.state;
    const a1 = this.p1Actions[tick] || 'wait';
    const a2 = this.p2Actions[tick] || 'wait';

    const p1Stunned = this.tickEffects(s, 'p1');
    const p2Stunned = this.tickEffects(s, 'p2');
    const p1Act = p1Stunned ? 'stunned' : a1;
    const p2Act = p2Stunned ? 'stunned' : a2;

    // 记录tick开始时的位置（for动画插值）
    const p1FromX = s.p1.x, p1FromFacing = s.p1.facing;
    const p2FromX = s.p2.x, p2FromFacing = s.p2.facing;

    const p1Intent = this.getMoveIntent(s.p1, p1Act);
    const p2Intent = this.getMoveIntent(s.p2, p2Act);
    const collision = this.checkCollision(s.p1, s.p2, p1Intent, p2Intent);
    this.applyMovement(s.p1, s.p2, p1Intent, p2Intent, collision, p1Act, p2Act);

    const p1SkillResult = this.executeAction(s.p1, s.p2, p1Act, 'p1', 'p2');
    const p2SkillResult = this.executeAction(s.p2, s.p1, p2Act, 'p2', 'p1');

    // shield bullets maintenance
    this.updateBullets(s);

    // resource regen
    s.p1.sp = Math.min(s.p1.maxSp, s.p1.sp + 2);
    s.p2.sp = Math.min(s.p2.maxSp, s.p2.sp + 2);
    s.p1.mp = Math.min(s.p1.maxMp, s.p1.mp + 1);
    s.p2.mp = Math.min(s.p2.maxMp, s.p2.mp + 1);

    return {
      tick,
      p1: this.clonePlayer(s.p1), p2: this.clonePlayer(s.p2),
      p1FromX, p1FromFacing, p2FromX, p2FromFacing,
      bullets: JSON.parse(JSON.stringify(s.bullets)),
      events: [...(p1SkillResult?.events || []), ...(p2SkillResult?.events || []), ...(collision?.events || [])],
      animData: this.getAnimData([...(p1SkillResult?.events||[]),...(p2SkillResult?.events||[]),...(collision?.events||[])]),
      p1Act, p2Act, p1Stunned, p2Stunned,
    };
  }

  getAnimData(events) {
    const anims = require('../data/skills.json').animations || {};
    return events.map(ev => {
      let animKey = null;
      if (ev.type === 'collision') animKey = 'collision';
      else if (ev.type === 'melee_hit') animKey = 'melee_hit';
      else if (ev.type === 'melee_miss') animKey = 'melee_miss';
      else if (ev.type === 'bullet_hit') animKey = 'bullet_hit';
      else if (ev.type === 'bullet_clash') animKey = 'bullet_clash';
      else if (ev.type === 'bullet_trail') animKey = 'bullet_fly';
      else if (ev.type === 'dash' || ev.type === 'dash_hit') animKey = 'dash';
      else if (ev.type === 'dodged') animKey = 'dodge';
      else if (ev.type === 'teleport') animKey = 'teleport';
      else if (ev.type === 'aoe_hit' || ev.type === 'aoe_cast') animKey = 'aoe';
      const cfg = animKey ? (anims[animKey] || null) : null;
      return { ...ev, anim: cfg };
    });
  }

  getMoveIntent(player, action) {
    const intent = { dx: 0, isDodge: false, isDefend: false, isTurn: false };
    if (action === 'move_left' || action === '左') intent.dx = -1 * player.facing * player.facing; // generic
    if (action === 'move_left') intent.dx = -1;
    if (action === 'move_right') intent.dx = 1;
    if (action === 'dodge_left') { intent.dx = -2; intent.isDodge = true; }
    if (action === 'dodge_right') { intent.dx = 2; intent.isDodge = true; }
    if (action === 'defend' || action === '防') intent.isDefend = true;
    if (action === 'turn' || action === '转向') intent.isTurn = true;
    return intent;
  }

  checkCollision(p1, p2, i1, i2) {
    const events = [];
    const p1Dest = p1.x + i1.dx;
    const p2Dest = p2.x + i2.dx;

    // 都在移动且目标冲突
    if (i1.dx !== 0 && i2.dx !== 0) {
      if (p1Dest === p2Dest) {
        // 同目标格：碰撞
        const dmg1 = Math.max(1, Math.floor(p2.atk * 0.3));
        const dmg2 = Math.max(1, Math.floor(p1.atk * 0.3));
        p1.hp = Math.max(0, p1.hp - dmg1);
        p2.hp = Math.max(0, p2.hp - dmg2);
        events.push({ type: 'collision', pos: p1Dest, dmg1, dmg2 });
        return { type: 'both', events };
      }
      if (p1Dest === p2.x && p2Dest === p1.x) {
        // 交叉穿越：碰撞在中间
        const midX = Math.floor((p1.x + p2.x) / 2);
        const dmg1 = Math.max(1, Math.floor(p2.atk * 0.25));
        const dmg2 = Math.max(1, Math.floor(p1.atk * 0.25));
        p1.hp = Math.max(0, p1.hp - dmg1);
        p2.hp = Math.max(0, p2.hp - dmg2);
        events.push({ type: 'collision', pos: midX, dmg1, dmg2 });
        return { type: 'cross', events };
      }
    }

    // P1移向P2位置
    if (i1.dx !== 0 && p1Dest === p2.x && i2.dx === 0) {
      const dmg1 = Math.max(1, Math.floor(p2.atk * 0.3));
      const dmg2 = Math.max(1, Math.floor(p1.atk * 0.3));
      p1.hp = Math.max(0, p1.hp - dmg1);
      p2.hp = Math.max(0, p2.hp - dmg2);
      events.push({ type: 'collision', pos: p2.x, dmg1, dmg2 });
      return { type: 'p1Blocked', events };
    }
    if (i2.dx !== 0 && p2Dest === p1.x && i1.dx === 0) {
      const dmg1 = Math.max(1, Math.floor(p2.atk * 0.3));
      const dmg2 = Math.max(1, Math.floor(p1.atk * 0.3));
      p1.hp = Math.max(0, p1.hp - dmg1);
      p2.hp = Math.max(0, p2.hp - dmg2);
      events.push({ type: 'collision', pos: p1.x, dmg1, dmg2 });
      return { type: 'p2Blocked', events };
    }
    return null;
  }

  applyMovement(p1, p2, i1, i2, collision, a1, a2) {
    // 转向
    if (i1.isTurn) {
      p1.facing *= -1;
    }
    if (i2.isTurn) {
      p2.facing *= -1;
    }

    // 非dodge的转向类技能也算
    // 防御（不减移动，但应用防御buff）
    if (i1.isDefend) {
      p1._defBuff = (p1._defBuff || 0) + Math.floor(p1.def * 0.5);
    }
    if (i2.isDefend) {
      p2._defBuff = (p2._defBuff || 0) + Math.floor(p2.def * 0.5);
    }

    // 移动
    if (collision) {
      // 碰撞：不移动
    } else {
      if (i1.dx !== 0 && !i1.isTurn) {
        let dest = p1.x + i1.dx;
        dest = Math.max(0, Math.min(15, dest));
        // dodge穿过对方
        if (i1.isDodge) {
          if (p2.x >= Math.min(p1.x, dest) && p2.x <= Math.max(p1.x, dest)) {
            // 穿过，不受阻
          } else if (dest === p2.x) {
            // dodge 终点有敌人，停旁边
            dest = p2.x + (i1.dx > 0 ? -1 : 1);
            dest = Math.max(0, Math.min(15, dest));
          }
        } else {
          if (dest === p2.x) dest = p1.x; // 不能站同一格
        }
        p1.x = Math.max(0, Math.min(15, dest));
      }
      if (i2.dx !== 0 && !i2.isTurn) {
        let dest = p2.x + i2.dx;
        dest = Math.max(0, Math.min(15, dest));
        if (i2.isDodge) {
          if (p1.x >= Math.min(p2.x, dest) && p1.x <= Math.max(p2.x, dest)) { /* 穿过 */ }
          else if (dest === p1.x) { dest = p1.x + (i2.dx > 0 ? -1 : 1); dest = Math.max(0, Math.min(15, dest)); }
        } else {
          if (dest === p1.x) dest = p2.x;
        }
        p2.x = Math.max(0, Math.min(15, dest));
      }
    }

    // Dodge无敌标记
    p1._dodging = i1.isDodge;
    p2._dodging = i2.isDodge;
  }

  executeAction(caster, target, action, casterKey, targetKey) {
    const events = [];
    // 通用技能
    if (['move_left', 'move_right', 'dodge_left', 'dodge_right', 'defend', 'turn', 'stunned', 'wait'].includes(action)) {
      return { events };
    }

    // 技能 (skill1/skill2/skill3)
    const skillIdxMap = { 'skill1': 0, 'skill2': 1, 'skill3': 2, '技1': 0, '技2': 1, '技3': 2 };
    const idx = skillIdxMap[action];
    if (idx === undefined) return { events };

    const skillId = caster.skills?.[idx];
    if (!skillId) return { events };

    const allSkills = { ...skillsData.skills, ...(caster.customSkills || {}) };
    const skill = allSkills[skillId];
    if (!skill) return { events };

    // 检查资源
    if ((caster.mp || 0) < (skill.mpCost || 0)) return { events: [{ type: 'noMp', actor: casterKey }] };
    if ((caster.sp || 0) < (skill.spCost || 0)) return { events: [{ type: 'noSp', actor: casterKey }] };
    caster.mp -= (skill.mpCost || 0);
    caster.sp -= (skill.spCost || 0);

    // 释放方向
    const dir = caster.facing;
    // back direction for "behind" skills
    let targetX = target.x;
    let isBehind = false;
    if (dir === 1 && caster.x > targetX) isBehind = true;
    if (dir === -1 && caster.x < targetX) isBehind = true;

    switch (skill.type) {
      case 'melee': {
        const range = skill.range || 1;
        let dist = Math.abs(caster.x - target.x);
        let inRange = false;
        if (skill.direction === 'forward') {
          inRange = dist <= range && ((dir === 1 && target.x >= caster.x) || (dir === -1 && target.x <= caster.x));
        } else if (skill.direction === 'around') {
          inRange = dist <= range;
        } else if (skill.direction === 'behind') {
          inRange = dist <= range && isBehind;
        }

        if (inRange) {
          let ratio = skill.damageRatio || 1;
          if (skill.backstabBonus && isBehind) ratio *= skill.backstabBonus;
          const dmg = this.calcDamage(caster.atk, ratio, target.def, skill.effect);

          // dodge中不受伤害
          if (!target._dodging) {
            target.hp = Math.max(0, target.hp - dmg);
          } else {
            events.push({ type: 'dodged', actor: targetKey });
          }

          events.push({ type: 'melee_hit', actor: casterKey, target: targetKey, dmg, skillId });

          // dot debuff
          if (skill.effect === 'dot_debuff') {
            target._effects = target._effects || [];
            target._effects.push({
              type: 'dot', dmgPerTick: Math.max(1, Math.floor(caster.atk * (skill.dotDamage || 0.05))),
              ticks: skill.dotTicks || 3
            });
          }
        } else {
          events.push({ type: 'melee_miss', actor: casterKey });
        }
        break;
      }

      case 'projectile': {
        const bx = caster.x + dir;
        let hitTarget = false;
        const traj = [];
        const bState = this.state;
        for (let scan = 0; scan <= (skill.bulletRange || 99); scan++) {
          const sx = caster.x + dir * (scan + 1);
          if (sx < 0 || sx > 15) break;
          traj.push(sx);
          if (sx === target.x) {
            if (!target._dodging) {
              const dmg = this.calcDamage(caster.atk, skill.damageRatio || 1, target.def, skill.effect);
              target.hp = Math.max(0, target.hp - dmg);
              events.push({ type: 'bullet_hit', actor: casterKey, target: targetKey, dmg, x: sx, skillId, color: skill.color });
            } else {
              events.push({ type: 'dodged', actor: targetKey, x: sx });
            }
            hitTarget = true;
            const enemyBullets = bState.bullets.filter(b => b.owner !== casterKey);
            for (const eb of enemyBullets) {
              if (eb.x === sx) {
                if ((skill.bulletPriority || 4) < (eb.priority || 4)) {
                  bState.bullets = bState.bullets.filter(b => b !== eb);
                  events.push({ type: 'bullet_clash', x: sx, winner: casterKey });
                } else if ((skill.bulletPriority || 4) > (eb.priority || 4)) {
                  events.push({ type: 'bullet_clash', x: sx, winner: eb.owner });
                  hitTarget = false;
                } else {
                  bState.bullets = bState.bullets.filter(b => b !== eb);
                  events.push({ type: 'bullet_clash', x: sx, winner: 'both' });
                  hitTarget = false;
                }
                break;
              }
            }
            break;
          }
          const enemyBullets2 = bState.bullets.filter(b => b.owner !== casterKey && !b.isShield);
          for (const eb of enemyBullets2) {
            if (eb.x === sx) {
              if ((skill.bulletPriority || 4) < (eb.priority || 4)) {
                bState.bullets = bState.bullets.filter(b => b !== eb);
                events.push({ type: 'bullet_clash', x: sx, winner: casterKey });
              } else if ((skill.bulletPriority || 4) > (eb.priority || 4)) {
                events.push({ type: 'bullet_clash', x: sx, winner: eb.owner });
                hitTarget = true;
                break;
              } else {
                bState.bullets = bState.bullets.filter(b => b !== eb);
                events.push({ type: 'bullet_clash', x: sx, winner: 'both' });
                hitTarget = true;
                break;
              }
            }
          }
          if (hitTarget) break;
        }
        events.push({ type: 'bullet_trail', actor: casterKey, skillId, traj, color: skill.color, priority: skill.bulletPriority || 4 });
        break;
      }

      case 'targeted': {
        // 定点AOE: 对target位置附近范围
        const aoeR = skill.aoeRadius || 0;
        const tgtRange = skill.targetRange || 8;
        let aoeX = target.x + (Math.random() > 0.5 ? aoeR : -aoeR);
        aoeX = Math.max(0, Math.min(15, aoeX));
        let dist2 = Math.abs(caster.x - aoeX);
        if (dist2 <= tgtRange) {
          const distToTarget = Math.abs(target.x - aoeX);
          if (distToTarget <= aoeR + 1) {
            const dmg = this.calcDamage(caster.atk, skill.damageRatio || 0.6, target.def, skill.effect);
            if (!target._dodging) target.hp = Math.max(0, target.hp - dmg);
            events.push({ type: 'aoe_hit', actor: casterKey, target: targetKey, dmg, pos: aoeX });
          }
        }
        events.push({ type: 'aoe_cast', actor: casterKey, skillId, pos: aoeX });
        break;
      }

      case 'dash': {
        const dashDist = skill.range || 4;
        const dest = caster.x + dir * dashDist;
        const clamped = Math.max(0, Math.min(15, dest));
        // 检测路径上的敌人
        const start = Math.min(caster.x, clamped);
        const end = Math.max(caster.x, clamped);
        if (target.x >= start && target.x <= end) {
          const dmg = this.calcDamage(caster.atk, skill.damageRatio || 1, target.def, skill.effect);
          if (!target._dodging) target.hp = Math.max(0, target.hp - dmg);
          events.push({ type: 'dash_hit', actor: casterKey, target: targetKey, dmg });
        }
        caster.x = (clamped === target.x) ? Math.max(0, Math.min(15, target.x + (dir > 0 ? -1 : 1))) : clamped;
        events.push({ type: 'dash', actor: casterKey, from: caster.x, to: clamped });
        break;
      }

      case 'teleport': {
        if (skill.effect === 'teleport_back') {
          const behindX = target.x - dir;
          const tpX = Math.max(0, Math.min(15, behindX));
          if (tpX === target.x) caster.x = Math.max(0, Math.min(15, behindX - dir));
          else caster.x = tpX;
          events.push({ type: 'teleport', actor: casterKey, to: caster.x });
        }
        break;
      }
    }

    return { events };
  }

  updateBullets(s) {
    for (const b of s.bullets) {
      if (b.isShield) {
        b.x = (b.owner === 'p1' ? s.p1.x : s.p2.x) + (b.owner === 'p1' ? s.p1.facing : s.p2.facing);
        b.traveled = 0;
      }
    }
  }

  resolveBullets(s) {
    const shields = s.bullets.filter(b => b.isShield);
    for (let i = 0; i < shields.length; i++) {
      for (let j = i + 1; j < shields.length; j++) {
        if (shields[i].owner !== shields[j].owner && shields[i].x === shields[j].x) {
          s.bullets = s.bullets.filter(b => b !== shields[i] && b !== shields[j]);
        }
      }
    }
  }

  tickEffects(s, key) {
    const player = s[key];
    let stunned = false;
    player._effects = (player._effects || []).filter(e => {
      if (e.type === 'dot') {
        if (!player._dodging) {
          player.hp = Math.max(0, player.hp - (e.dmgPerTick || 1));
        }
        e.ticks--;
        return e.ticks > 0;
      }
      if (e.type === 'stun') {
        e.ticks--;
        stunned = true;
        return e.ticks > 0;
      }
      return true;
    });
    // 重置tick buffs
    player._defBuff = 0;
    player._dodging = false;
    return stunned;
  }

  calcDamage(atk, ratio, def, effect) {
    const base = atk * ratio;
    if (effect === 'true_damage') return Math.max(1, Math.floor(base));
    const defVal = def || 0;
    return Math.max(1, Math.floor(base - defVal));
  }

  clonePlayer(p) {
    return {
      x: p.x, facing: p.facing, hp: p.hp, maxHp: p.maxHp,
      mp: p.mp, maxMp: p.maxMp, sp: p.sp, maxSp: p.maxSp,
      atk: p.atk, def: p.def, charId: p.charId,
      effects: JSON.parse(JSON.stringify(p._effects || [])),
      dodging: p._dodging || false,
      defBuff: p._defBuff || 0,
    };
  }
}

module.exports = BattleEngine;
