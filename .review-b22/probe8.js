'use strict';
const engine = require('../server/core/engine.js');
const skills = require('../server/core/skills.js');
const mk = (P) => ({ id: P, owner: P, x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1, hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60, atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [] });
const sk = (id, ov) => Object.assign(skills.instantiateSkill(id, 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }), ov || {});
const p1 = Object.assign(mk('p1'), { skills: { bash: sk('skill_dash_bash', { multiplier: 1.3, distance: 4, passThroughEnemy: true, dealDamage: true }) } });
const p2 = mk('p2');
const b = engine.createBattle(undefined, { seed: 9, players: { p1, p2 } });
const d = [];
for (let i = 0; i < 20; i++) {
  const x = b.step({ actions: { p1: (s) => (s.players.p1.x < 832 ? 'move_right' : 'skill:bash'), p2: () => 'move_left' } });
  d.push(x);
  if (b.state.verdict) break;
}
const bf = d.filter((f) => f.bases.p2.hp < 100 || f.bases.p1.hp < 100);
console.log('base frames:', bf.map((f) => 't' + f.tick + ' b1=' + f.bases.p1.hp + ' b2=' + f.bases.p2.hp + ' p1.x=' + f.players.p1.toX + ' collision=' + (f.collision ? f.collision.contactX : '-')).join(' | ') || '（无）');
console.log('final verdict:', JSON.stringify(b.state.verdict), 'bases:', b.state.bases.p1.hp + '/' + b.state.bases.p2.hp);