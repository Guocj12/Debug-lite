'use strict';
const engine = require('../server/core/engine.js');
const skills = require('../server/core/skills.js');
const mk = (P) => ({ id: P, owner: P, x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1, hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60, atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [] });
const sk = (id, ov) => Object.assign(skills.instantiateSkill(id, 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }), ov || {});
const p1 = Object.assign(mk('p1'), { skills: { bash: sk('skill_dash_bash', { multiplier: 1.3, distance: 4, passThroughEnemy: false, dealDamage: true }) } });
console.log('p1.skills.bash =', JSON.stringify(p1.skills.bash));
const b = engine.createBattle(undefined, { seed: 9, players: { p1, p2: mk('p2') } });
for (let i = 0; i < 24; i++) {
  const st = b.state;
  const prevP1x = st.players.p1.x;
  const d = b.step({ actions: { p1: (s) => (s.players.p1.x < 832 ? 'move_right' : 'skill:bash'), p2: () => 'wait' } });
  console.log('t' + d.tick, 'p1.x', prevP1x, '->', d.players.p1.toX, 'hp', d.players.p1.hp, 'mp', d.players.p1.mp, 'bases', d.bases.p1.hp + '/' + d.bases.p2.hp, 'hits', d.bulletHits.length, 'collision', d.collision ? d.collision.contactX : null, 'verdict', d.verdict ? d.verdict.winner + '/' + d.verdict.phase : '');
  if (b.state.verdict) break;
}