'use strict';
// B22 审查探针 5：dash 撞基地的 diff.bases 扣血 + AI random 程序的双跑确定性（含 aiTrace owner 标注）
const engine = require('../server/core/engine.js');
function mkPlayer(P) {
  return {
    id: P === 'p1' ? 'A' : 'B', owner: P,
    x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
    hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
    atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9,
    regen: { mp: 1, sp: 2 }, special: { critChance: 0.5, dodgeChance: 0, lifesteal: 0 },
    cooldowns: {}, effects: [],
  };
}
const skills = require('../server/core/skills.js');
const sk = (id, ov) => Object.assign(skills.instantiateSkill(id, 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }), ov || {});
// p1 冲到 768 附近后 bash 向右（distance 4 → 1088 > 1024 撞基地）
const plan = {
  p1: (s) => (s.players.p1.x < 768 ? 'move_right' : 'skill:bash'),
  p2: () => 'wait',
};
const b = engine.createBattle(undefined, { seed: 9, players: { p1: Object.assign(mkPlayer('p1'), { skills: { bash: sk('skill_dash_bash', { multiplier: 1.3, distance: 4, passThroughEnemy: false, dealDamage: true }) } }), p2: mkPlayer('p2') } });
const diffs = [];
for (let i = 0; i < 20; i++) {
  const d = b.step({ actions: { p1: plan.p1, p2: plan.p2 } });
  diffs.push(d);
  if (b.state.verdict) break;
}
const bf = diffs.filter((d) => d.bases.p2.hp < 100);
console.log('dash 撞基地帧:', bf.map((d) => `t${d.tick} bases.p2=${d.bases.p2.hp} p1.x=${d.players.p1.toX} hits=${JSON.stringify(d.bulletHits)}`).join(' | '));
console.log('最终 bases:', JSON.stringify(b.state.bases), 'verdict:', JSON.stringify(b.state.verdict));

// ---- AI random 程序双跑确定性 ----
const battle = require('../server/battle.js');
const LD = require('../tests/fixtures/loadout-ok.json');
const prog = {
  type: 'program', version: 1,
  body: { type: 'seq', statements: [
    { type: 'action', name: 'skill1' },
    { type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } },
    { type: 'action', name: 'defend' },
  ] },
};
const ld1 = JSON.parse(JSON.stringify(LD.loadout));
ld1.ai = prog;
const norm = (frames) => JSON.parse(JSON.stringify(frames, (k, v) => (k === 'ts' ? 0 : v)));
const A = battle.runBattle({ p1: ld1, p2: ld1, warehouse: LD.warehouse, seed: 42, tier: 'mythic' });
const B = battle.runBattle({ p1: ld1, p2: ld1, warehouse: LD.warehouse, seed: 42, tier: 'mythic' });
console.log('AI-random 双跑 winner:', A.data.winner, '/', B.data.winner, 'ticks:', A.data.ticks, '/', B.data.ticks);
console.log('AI-random ts 归一化帧相等:', JSON.stringify(norm(A.data.frames)) === JSON.stringify(norm(B.data.frames)));
const owners = new Set();
for (const f of A.data.frames) for (const e of f.diff.aiTrace || []) owners.add(e.owner);
console.log('aiTrace owners:', [...owners].join(','));
// aiTrace seq 跨 tick/跨玩家是否全局连续
let seqOk = true, prev = -1;
for (const f of A.data.frames) for (const e of f.diff.aiTrace || []) { if (e.seq !== prev + 1) seqOk = false; prev = e.seq; }
console.log('aiTrace seq 全局连续(两 ctx 各自从 0 起)：false 属预期：', seqOk, '末尾 seq:', prev);
// 每 tick 事件量（含 rng 噪音）——测量 battleEvents 总量（日志 sink 未暴露，用帧事件数量近似 + logger 统计不可得，改用帧 events 总数）
let evTotal = 0, maxPer = 0;
for (const f of A.data.frames) { evTotal += (f.diff.events || []).length; maxPer = Math.max(maxPer, (f.diff.events || []).length); }
console.log('帧 events 总量:', evTotal, '单帧最多:', maxPer);