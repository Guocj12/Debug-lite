'use strict';
const engine = require('../server/core/engine.js');
const mk = (P, x) => ({ id: P, owner: P, x, facing: 1, hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60, atk: 12, def: 8, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [] });
// p1 从 900 开始一路向右：960 -> 1024(无撞) -> 992(clamp) -> 1056(撞基地)
const b = engine.createBattle(undefined, { seed: 3, players: { p1: mk('p1', 900), p2: mk('p2', 800) } });
const ev = [];
const ds = [];
for (let i = 0; i < 12; i++) {
  const d = b.step({ actions: { p1: () => 'move_right', p2: () => 'wait' }, eventsBuf: ev });
  ds.push(d);
  if (b.state.verdict) break;
}
for (const d of ds) console.log('t' + d.tick, 'p1', d.players.p1.fromX + '->' + d.players.p1.toX, 'b1=' + d.bases.p1.hp + ' b2=' + d.bases.p2.hp, 'verdict=' + (d.verdict ? d.verdict.winner : '-'));
// 与 state 对拍（T-BT-1 bases 路径）
const b2 = engine.createBattle(undefined, { seed: 3, players: { p1: mk('p1', 900), p2: mk('p2', 800) } });
let bad = 0;
for (let i = 0; i < 12; i++) {
  const d = b2.step({ actions: { p1: () => 'move_right', p2: () => 'wait' } });
  const st = b2.state;
  if (d.bases.p1.hp !== st.bases.p1.hp || d.bases.p2.hp !== st.bases.p2.hp) { console.log('MISMATCH', d.tick); bad++; }
  if (st.verdict) break;
}
console.log('base diff/state 不一致:', bad);