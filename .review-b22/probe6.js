'use strict';
const engine = require('../server/core/engine.js');
const skills = require('../server/core/skills.js');
const mk = (P) => ({ id: P, owner: P, x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1, hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60, atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [] });
const sk = (id, ov) => Object.assign(skills.instantiateSkill(id, 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }), ov || {});
const p1 = Object.assign(mk('p1'), { skills: { bash: sk('skill_dash_bash', { multiplier: 1.3, distance: 4, passThroughEnemy: false, dealDamage: true }) } });
const b = engine.createBattle(undefined, { seed: 9, players: { p1, p2: mk('p2') } });
const diffs = [];
for (let i = 0; i < 24; i++) {
  const d = b.step({ actions: { p1: (s) => (s.players.p1.x < 832 ? 'move_right' : 'skill:bash'), p2: () => 'wait' } });
  diffs.push(d);
  if (b.state.verdict) break;
}
const bf = diffs.filter((d) => d.bases.p2.hp < 100);
console.log('base frames:', bf.map((d) => 't' + d.tick + ' p2base=' + d.bases.p2.hp + ' p1.x=' + d.players.p1.toX).join(' | '));
console.log('final:', JSON.stringify(b.state.bases), JSON.stringify(b.state.verdict));