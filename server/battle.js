// Battle Engine v3 - Cooldowns, exhaust, debuff true damage
const skillsData = require('../data/skills.json');
class BattleEngine {
  constructor() { this.state = null; this.p1Actions = []; this.p2Actions = []; }
  init(s) { this.state = s; s._cooldowns_p1 = {}; s._cooldowns_p2 = {}; }
  setActions(a1, a2) { this.p1Actions = a1; this.p2Actions = a2; }
  getState() { return JSON.parse(JSON.stringify(this.state)); }

  executeAll() {
    const frames = [], s = this.state;
    s.bullets = [];
    for (let tick = 0; tick < 16; tick++) {
      const frame = this.executeTick(tick);
      frames.push(frame);
      if (s.p1.hp <= 0 || s.p2.hp <= 0) break;
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

    const p1Stunned = this.tickEffects(s, 'p1');
    const p2Stunned = this.tickEffects(s, 'p2');
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
    this.applyMovement(s.p1, s.p2, p1Intent, p2Intent, collision, p1Act, p2Act);

    // 保存敌人移动前位置，供 teleport_backstab 使用
    s.p1._enemyFromX = p2FromX; s.p2._enemyFromX = p1FromX;
    s.p1._enemyFromFacing = p2FromFacing; s.p2._enemyFromFacing = p1FromFacing;

    const p1SR = this.executeAction(s.p1, s.p2, p1Act, 'p1', 'p2', tick, p2FromX, p2FromFacing);
    const p2SR = this.executeAction(s.p2, s.p1, p2Act, 'p2', 'p1', tick, p1FromX, p1FromFacing);

    this.updateBullets(s);

    s.p1.sp = Math.min(s.p1.maxSp, s.p1.sp + 2);
    s.p2.sp = Math.min(s.p2.maxSp, s.p2.sp + 2);
    s.p1.mp = Math.min(s.p1.maxMp, s.p1.mp + 1);
    s.p2.mp = Math.min(s.p2.maxMp, s.p2.mp + 1);

    return {
      tick, p1: this.clonePlayer(s.p1), p2: this.clonePlayer(s.p2),
      p1FromX, p1FromFacing, p2FromX, p2FromFacing,
      p1Actions: [...this.p1Actions], p2Actions: [...this.p2Actions],
      bullets: JSON.parse(JSON.stringify(s.bullets)),
      events: [...(p1SR?.events || []), ...(p2SR?.events || []), ...(collision?.events || [])],
      animData: this.getAnimData([...(p1SR?.events||[]),...(p2SR?.events||[]),...(collision?.events||[])]),
      p1Act, p2Act, p1Stunned, p2Stunned,
    };
  }

  getAnimData(events) {
    const anims = require('../data/skills.json').animations || {};
    const map = { collision: 'collision', melee_hit: 'melee_hit', bullet_hit: 'bullet_hit', bullet_clash: 'bullet_clash', bullet_trail: 'bullet_fly', dash: 'dash', dash_hit: 'dash', dodged: 'dodge', teleport: 'teleport', aoe_hit: 'aoe', aoe_cast: 'aoe', stun_hit: 'stun', freeze_hit: 'freeze', burn_hit: 'burn', poison_hit: 'poison', knockback: 'knockback', backstab_hit: 'backstab', shield_wall: 'shield_wall' };
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
    if (i1.dx !== 0 && i2.dx !== 0) {
      if (p1D === p2D) {
        const d1 = Math.max(1, Math.floor(p2.atk * 0.3)), d2 = Math.max(1, Math.floor(p1.atk * 0.3));
        p1.hp = Math.max(0, p1.hp - d1); p2.hp = Math.max(0, p2.hp - d2);
        events.push({ type: 'collision', x: p1D, dmg1: d1, dmg2: d2, hit_anim:'collisionFX', bullet_color:'#ffff00' });
        return { type: 'both', events };
      }
    }
    if (i1.dx !== 0 && p1D === p2.x && i2.dx === 0 && !i1.isDodge) {
      const d1 = Math.max(1, Math.floor(p2.atk * 0.3)), d2 = Math.max(1, Math.floor(p1.atk * 0.3));
      p1.hp = Math.max(0, p1.hp - d1); p2.hp = Math.max(0, p2.hp - d2);
      events.push({ type: 'collision', x: p2.x, dmg1: d1, dmg2: d2, hit_anim:'collisionFX', bullet_color:'#ffff00' });
      return { type: 'p1Blocked', events };
    }
    if (i2.dx !== 0 && p2D === p1.x && i1.dx === 0 && !i2.isDodge) {
      const d1 = Math.max(1, Math.floor(p2.atk * 0.3)), d2 = Math.max(1, Math.floor(p1.atk * 0.3));
      p1.hp = Math.max(0, p1.hp - d1); p2.hp = Math.max(0, p2.hp - d2);
      events.push({ type: 'collision', x: p1.x, dmg1: d1, dmg2: d2, hit_anim:'collisionFX', bullet_color:'#ffff00' });
      return { type: 'p2Blocked', events };
    }
    return null;
  }

  applyMovement(p1, p2, i1, i2, collision, a1, a2) {
    if (i1.isTurn) p1.facing *= -1;
    if (i2.isTurn) p2.facing *= -1;
    if (i1.isDefend) p1._defBuff = (p1._defBuff || 0) + Math.floor(p1.def * 0.5);
    if (i2.isDefend) p2._defBuff = (p2._defBuff || 0) + Math.floor(p2.def * 0.5);
    if (collision) return;
    if (i1.dx !== 0 && !i1.isTurn) {
      let d = p1.x + i1.dx; d = Math.max(0, Math.min(15, d));
      if (!i1.isDodge && d === p2.x) d = p1.x;
      if (i1.isDodge && d === p2.x) d = p2.x + (i1.dx > 0 ? -1 : 1);
      p1.x = Math.max(0, Math.min(15, d));
    }
    if (i2.dx !== 0 && !i2.isTurn) {
      let d = p2.x + i2.dx; d = Math.max(0, Math.min(15, d));
      if (!i2.isDodge && d === p1.x) d = p2.x;
      if (i2.isDodge && d === p1.x) d = p1.x + (i2.dx > 0 ? -1 : 1);
      p2.x = Math.max(0, Math.min(15, d));
    }
    p1._dodging = i1.isDodge; p2._dodging = i2.isDodge;
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
    if (this.state[cdKey]?.[sid] > 0) {
      events.push({ type: 'on_cooldown', actor: cKey, skillId: sid });
      return { events };
    }

    // Check resources - if insufficient, EXHAUST
    const hasMp = (caster.mp || 0) >= (sk.mpCost || 0);
    const hasSp = (caster.sp || 0) >= (sk.spCost || 0);
    if (!hasMp || !hasSp) {
      events.push({ type: 'exhausted', actor: cKey, skillId: sid });
      return { events };
    }
    caster.mp -= (sk.mpCost || 0);
    caster.sp -= (sk.spCost || 0);
    // Set cooldown
    if (sk.cooldown) this.state[cdKey][sid] = sk.cooldown;

    const dir = caster.facing;
    const isBehind = (dir === 1 && caster.x > target.x) || (dir === -1 && caster.x < target.x);

    switch (sk.type) {
      case 'melee': {
        const rg = sk.range || 1;
        const dist = Math.abs(caster.x - target.x);
        let inRange = false;
        if (sk.direction === 'forward') inRange = dist <= rg && ((dir === 1 && target.x >= caster.x) || (dir === -1 && target.x <= caster.x));
        else if (sk.direction === 'forward_and_back') inRange = dist <= rg;
        else if (sk.direction === 'around') inRange = dist <= rg;
        // ★ 近战弹幕：根据技能范围在覆盖的格子上各播一次
        const bulletGrids = [];
        if (sk.direction === 'forward') {
          for (let offset = 1; offset <= (sk.range || 1); offset++) {
            const gx = caster.x + dir * offset;
            if (gx >= 0 && gx <= 15) bulletGrids.push(gx);
          }
        } else if (sk.direction === 'forward_and_back') {
          for (let offset = -(sk.range || 1); offset <= (sk.range || 1); offset++) {
            const gx = caster.x + offset;
            if (gx >= 0 && gx <= 15) bulletGrids.push(gx);
          }
        } else {
          for (let offset = -(sk.range || 1); offset <= (sk.range || 1); offset++) {
            const gx = caster.x + offset;
            if (gx >= 0 && gx <= 15) bulletGrids.push(gx);
          }
        }
        for (const gx of bulletGrids) {
          events.push({ type: 'melee_slash', actor: cKey, skillId: sid,
            bullet_anim: sk.anim_bullet || 'meleeSwing', bullet_color: sk.color, bullet_x: gx });
        }

        if (inRange) {
          let ratio = sk.damageRatio || 1;
          if (sk.backstabRatio && isBehind) ratio = sk.backstabRatio;
          const dmg = this.calcDmg(caster.atk, ratio, target.def, sk.effect);
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
        const bState = this.state;
        const range = sk.bulletRange || 99;
        const pri = sk.bulletPriority || 4;
        const shots = sk.multiShot || 1;
        for (let s = 0; s < shots; s++) {
          let hitDone = false;
          for (let scan = 1; scan <= range; scan++) {
            const sx = caster.x + dir * scan;
            if (sx < 0 || sx > 15) break;
            const enemyB = bState.bullets.filter(b => b.owner !== cKey && !b.isShield);
            let blocked = false;
            for (const eb of enemyB) {
              if (eb.x === sx) {
                if (pri < eb.priority) bState.bullets = bState.bullets.filter(b => b !== eb);
                else if (pri > eb.priority) { blocked = true; events.push({ type: 'bullet_clash', x: sx, winner: eb.owner, hit_anim: sk.anim_hit||'hitExplosion', bullet_color: sk.color }); }
                else { bState.bullets = bState.bullets.filter(b => b !== eb); blocked = true; events.push({ type: 'bullet_clash', x: sx, winner: 'both', hit_anim: sk.anim_hit||'hitExplosion', bullet_color: sk.color }); }
                break;
              }
            }
            if (blocked) break;
            if (sx === target.x) {
              if (!target._dodging) {
                const dmg = this.calcDmg(caster.atk, sk.damageRatio || 1, target.def, sk.effect);
                target.hp = Math.max(0, target.hp - dmg);
                const evT = sk.effect === 'freeze_damage' ? 'freeze_hit' : (sk.effect === 'poison_debuff' ? 'poison_hit' : 'bullet_hit');
                events.push({ type: evT, actor: cKey, target: tKey, dmg, x: sx, skillId: sid,
                  bullet_anim: sk.anim_bullet||'arrowFly', hit_anim: sk.anim_hit||'hitExplosion', bullet_color: sk.color,
                  bullet_from: caster.x, bullet_to: sx });
                if (sk.effect === 'freeze_damage') { target._frozen = true; target._effects = target._effects || []; target._effects.push({ type: 'freeze', ticks: sk.freezeDuration || 1 }); }
                if (sk.effect === 'poison_debuff') { target._effects = target._effects || []; target._effects.push({ type: 'poison', ticks: sk.poisonTicks || 5, dmgPerTick: Math.max(1, Math.floor(caster.atk * (sk.poisonRatio || 0.08))) }); }
              } else { events.push({ type: 'dodged', actor: tKey, x: sx }); }
              hitDone = true; break;
            }
          }
          // If not hit, the bullet flies to max range
          if (!hitDone) {
            const maxX = Math.max(0, Math.min(15, caster.x + dir * range));
            events.push({ type: 'bullet_trail', actor: cKey, skillId: sid,
              bullet_anim: sk.anim_bullet||'arrowFly', bullet_color: sk.color,
              bullet_from: caster.x, bullet_to: maxX, bullet_faded: true });
          }
        }
        break;
      }
      case 'targeted_aoe': {
        const aoeR = sk.aoeRadius || 1;
        const tX = target.x;
        for (let ox = -aoeR; ox <= aoeR; ox++) {
          const ax = tX + ox;
          if (ax < 0 || ax > 15) continue;
          if (ax === target.x) {
            if (!target._dodging) {
              const dmg = this.calcDmg(caster.atk, sk.damageRatio || 1, target.def, sk.effect);
              target.hp = Math.max(0, target.hp - dmg);
              const evT = sk.effect === 'burn_debuff' ? 'burn_hit' : 'aoe_hit';
              events.push({ type: evT, actor: cKey, target: tKey, dmg, x: ax, skillId: sid,
                bullet_anim: sk.anim_bullet||'arrowRainDrop', hit_anim: sk.anim_hit||'hitAOE', bullet_color: sk.color });
              if (sk.effect === 'burn_debuff') { target._effects = target._effects || []; target._effects.push({ type: 'burn', ticks: sk.burnTicks || 3, dmgPerTick: Math.max(1, Math.floor(caster.atk * (sk.burnRatio || 0.1))) }); }
            } else { events.push({ type: 'dodged', actor: tKey, x: ax }); }
          }
        }
        // Also spawn visual drops on empty aoe positions
        for (let ox = -aoeR; ox <= aoeR; ox++) {
          const ax = tX + ox;
          if (ax < 0 || ax > 15) continue;
          if (ax !== target.x) {
            events.push({ type: 'aoe_cast', actor: cKey, skillId: sid, x: ax,
              bullet_anim: sk.anim_bullet||'arrowRainDrop', bullet_color: sk.color, bullet_noHit: true });
          }
        }
        events.push({ type: 'aoe_cast', actor: cKey, skillId: sid, x: tX,
          bullet_anim: sk.anim_bullet||'arrowRainDrop', bullet_color: sk.color, bullet_noHit: false });
        break;
      }
      case 'dash': {
        const dDist = sk.range || 3;
        let dest = caster.x + dir * dDist;
        dest = Math.max(0, Math.min(15, dest));
        const startX = Math.min(caster.x, dest), endX = Math.max(caster.x, dest);
        if (target.x >= startX && target.x <= endX && !target._dodging) {
          const dmg = this.calcDmg(caster.atk, sk.damageRatio || 1, target.def, sk.effect);
          target.hp = Math.max(0, target.hp - dmg);
          events.push({ type: 'dash_hit', actor: cKey, target: tKey, dmg, skillId: sid, bullet_anim: sk.anim_bullet||'dashTrail', hit_anim: sk.anim_hit||'hitSlash', bullet_color: sk.color, bullet_from: caster.x, bullet_to: dest });
          if (sk.knockback) {
            const kbDir = dir;
            let tNewX = target.x + kbDir * sk.knockback;
            tNewX = Math.max(0, Math.min(15, tNewX));
            if (tNewX === caster.x) tNewX += kbDir;
            if (tNewX === dest) tNewX += kbDir;
            tNewX = Math.max(0, Math.min(15, tNewX));
            target.x = tNewX;
            events.push({ type: 'knockback', actor: tKey, from: target.x, to: tNewX, hit_anim: 'knockbackFX', bullet_color: '#ffaa00' });
          }
          if (dest === target.x) dest = target.x + (dir > 0 ? -1 : 1);
          dest = Math.max(0, Math.min(15, dest));
        }
        if (sk.defBuff) caster._defDash = Math.floor(caster.def * sk.defBuff);
        caster.x = dest;
        events.push({ type: 'dash', actor: cKey, to: dest, skillId: sid, bullet_anim: sk.anim_bullet||'dashTrail', bullet_color: sk.color, bullet_from: caster.x, bullet_to: dest });
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
          const dmg1 = Math.max(1, Math.floor(caster.atk * 0.3));
          const dmg2 = Math.max(1, Math.floor(target.atk * 0.3));
          caster.hp = Math.max(0, caster.hp - dmg2);
          target.hp = Math.max(0, target.hp - dmg1);
          events.push({ type: 'collision', x: tpX, dmg1, dmg2, hit_anim: 'collisionFX', bullet_color: '#ffff00' });
          console.log(`[BACKSTAB] ${cKey} collision at ${tpX}! enemy already there. staying at ${oldX}`);
        } else {
          caster.x = tpX;
          console.log(`[BACKSTAB] ${cKey} teleport: ${oldX}->${tpX}, enemyFromX=${enemyX} (now at ${target.x}), facing=${caster.facing}, enemyFromFacing=${enemyFacing} (now ${target.facing})`);
        }
        if (caster.x > enemyX) caster.facing = -1;
        else if (caster.x < enemyX) caster.facing = 1;
        events.push({ type: 'teleport', actor: cKey, to: caster.x, skillId: sid,
          bullet_anim: sk.anim_bullet || 'teleportFlash', hit_anim: sk.anim_hit || 'teleportFlash', bullet_color: sk.color });
        break;
      }
      case 'shield_wall': {
        const sX = caster.x + dir;
        this.state.bullets.push({ id: sid + '_' + Date.now(), x: sX, dir, priority: sk.bulletPriority || 2, isShield: true, color: sk.color, owner: cKey });
        events.push({ type: 'shield_wall', actor: cKey, x: sX, skillId: sid, color: sk.color });
        break;
      }
    }
    return { events };
  }

  calcDmg(atk, ratio, def, effect) {
    const base = atk * ratio;
    if (effect === 'true_damage' || effect === 'true_damage_backstab') return Math.max(1, Math.floor(base));
    return Math.max(1, Math.floor(base - (def || 0)));
  }

  updateBullets(s) {
    for (const b of s.bullets) {
      if (b.isShield) { b.x = (b.owner === 'p1' ? s.p1.x : s.p2.x) + (b.owner === 'p1' ? s.p1.facing : s.p2.facing); }
    }
  }

  tickEffects(s, key) {
    const p = s[key]; let stunned = false;
    p._effects = (p._effects || []).filter(e => {
      if ((e.type === 'dot' || e.type === 'burn' || e.type === 'poison') && e.ticks > 0) {
        if (!p._dodging) p.hp = Math.max(0, p.hp - (e.dmgPerTick || 1));
        e.ticks--; return e.ticks > 0;
      }
      if ((e.type === 'stun' || e.type === 'freeze') && e.ticks > 0) { stunned = true; e.ticks--; return e.ticks > 0; }
      return false;
    });
    p._defBuff = 0; p._dodging = false;
    if (p._defDash) { p._defBuff = (p._defBuff || 0) + p._defDash; p._defDash = 0; }
    return stunned;
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
}
module.exports = BattleEngine;
