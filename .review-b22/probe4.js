'use strict';
// B22 审查探针 4：基地扣血路径 → diff.bases.hp 可重建
const engine = require('../server/core/engine.js');
function mkPlayer(P) {
  return {
    id: P === 'p1' ? 'A' : 'B', owner: P,
    x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
    hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
    atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9,
    regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [],
  };
}
// p2 不停向右（撞自己的哨位侧基地? 见 engine: facing>0 => 'p2'）——注意：p2 初始 facing=-1
// 用 p1 向右冲 -> facing +1 -> owner 判定为 p2 基地（敌对侧），预期卡住并在 diff.bases.p2.hp 扣血
const b = engine.createBattle(undefined, { seed: 5, players: { p1: mkPlayer('p1'), p2: mkPlayer('p2') } });
const ev = [];
const diffs = [];
for (let i = 0; i < 16; i++) {
  const d = b.step({ actions: { p1: () => 'move_right' }, eventsBuf: ev });
  diffs.push(d);
  if (b.state.verdict) break;
}
const baseFrames = diffs.filter((d) => d.bases.p1.hp < 100 || d.bases.p2.hp < 100);
console.log('扣血帧:', baseFrames.map((d) => `t${d.tick} p1=${d.bases.p1.hp} p2=${d.bases.p2.hp} p1.x=${d.players.p1.toX} hit=${d.bulletHits.length ? d.bulletHits[0].atX : 'none'}`).join(' | '));
// 重建验证：bases.hp 在扣血帧上一致
let rebuiltP1 = 100, rebuiltP2 = 100;
let mismatch = 0;
for (const d of diffs) {
  matching: {
    // 找对应 state —— 逐步对拍
  }
}
// 用 runFull + 对拍：直接再跑一遍并逐 tick 比对 diff.bases 与 state
const b2 = engine.createBattle(undefined, { seed: 5, players: { p1: mkPlayer('p1'), p2: mkPlayer('p2') } });
const ev2 = [];
const ds = [];
for (let i = 0; i < 16; i++) {
  const d = b2.step({ actions: { p1: () => 'move_right' }, eventsBuf: ev2 });
  ds.push(d);
  const st = b2.state;
  if (st.bases.p1.hp !== d.bases.p1.hp || st.bases.p2.hp !== d.bases.p2.hp) { console.log('bases diff mismatch', d.tick); mismatch++; }
  if (st.verdict) break;
}
console.log('bases diff/state 不一致数:', mismatch, '总帧:', ds.length, 'winner:', b2.state.verdict && b2.state.verdict.winner);