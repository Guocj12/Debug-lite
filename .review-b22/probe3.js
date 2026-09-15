'use strict';
// B22 审查探针 3：T-BT-1 扩展（含技能/命中/碰撞/基地扣血路径）+ bullets 快照 + base 损伤帧
const engine = require('../server/core/engine.js');

function mkPlayer(P) {
  const base = {
    id: P === 'p1' ? 'A' : 'B', owner: P,
    x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
    hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
    atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9,
    regen: { mp: 1, sp: 2 }, special: { critChance: 0, dodgeChance: 0, lifesteal: 0 },
    cooldowns: {}, effects: [],
  };
  return base;
}
function skillOf(skills, templateId, overrides) {
  const sk = skills.instantiateSkill(templateId, 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 });
  return Object.assign(sk, overrides || {});
}
const plan = {
  p1: ['dodge_right', 'move_left', 'wait', 'skill:precise', 'move_right', 'skill:precise', 'dodge_left', 'wait',
    'move_right', 'move_left', 'skill:precise', 'dodge_right', 'wait', 'move_left', 'skill:precise', 'dodge_left',
    'move_right', 'wait', 'move_left', 'skill:precise', 'dodge_right', 'move_right', 'wait', 'skill:precise',
    'dodge_left', 'move_left', 'wait', 'dodge_right', 'move_right', 'skill:precise', 'wait', 'move_left',
    'dodge_left', 'skill:precise', 'wait', 'move_right', 'dodge_right', 'wait', 'move_left', 'skill:precise'],
  p2: ['move_left', 'wait', 'skill:bash', 'dodge_left', 'move_right', 'wait', 'skill:bash', 'dodge_right',
    'wait', 'move_left', 'skill:bash', 'wait', 'dodge_right', 'move_left', 'skill:bash', 'wait',
    'dodge_left', 'move_right', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'skill:bash', 'wait',
    'move_right', 'wait', 'dodge_left', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'skill:bash',
    'wait', 'move_right', 'dodge_left', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'wait'],
};

const skills = require('../server/core/skills.js');
const p1 = mkPlayer('p1');
const p2 = mkPlayer('p2');
p1.special.critChance = 0.5;
p1.skills = { precise: skillOf(skills, 'skill_straight_precise', { multiplier: 1.0 }) };
p2.skills = { bash: skillOf(skills, 'skill_dash_bash', { multiplier: 1.3, distance: 4, passThroughEnemy: false, dealDamage: true }) };
const b = engine.createBattle(undefined, { seed: 20260912, players: { p1, p2 } });

const bufs = { ai: [], ev: [] };
const diffs = [];
const states = [];
for (let i = 0; i < 64; i++) {
  const d = b.step({
    actions: {
      aiTrace: bufs.ai,
      p1: (s) => plan.p1[s.tick - 1] || 'wait',
      p2: (s) => plan.p2[s.tick - 1] || 'wait',
    },
    eventsBuf: bufs.ev,
  });
  diffs.push(d);
  const st = b.state;
  states.push({
    p1: { x: st.players.p1.x, hp: st.players.p1.hp, mp: st.players.p1.mp, sp: st.players.p1.sp, facing: st.players.p1.facing },
    p2: { x: st.players.p2.x, hp: st.players.p2.hp, mp: st.players.p2.mp, sp: st.players.p2.sp, facing: st.players.p2.facing },
    bases: { p1: st.bases.p1.hp, p2: st.bases.p2.hp },
  });
  if (b.state.verdict) break;
}
console.log('golden ticks:', diffs.length, 'winner:', b.state.verdict.winner);
// 采样 20 tick（与 replay.test 相同协议）
const sample = new Set();
for (let i = 1; i <= 20; i++) sample.add(Math.min(diffs.length, Math.ceil((i * diffs.length) / 20)));
const rebuilt = {
  p1: { x: 224, hp: 100, mp: 40, sp: 60, facing: 1 },
  p2: { x: 800, hp: 100, mp: 40, sp: 60, facing: -1 },
  bases: { p1: 100, p2: 100 },
};
let bad = 0, checked = 0;
for (let i = 0; i < diffs.length; i++) {
  const d = diffs[i];
  rebuilt.p1 = { x: d.players.p1.toX, hp: d.players.p1.hp, mp: d.players.p1.mp, sp: d.players.p1.sp, facing: d.players.p1.facing };
  rebuilt.p2 = { x: d.players.p2.toX, hp: d.players.p2.hp, mp: d.players.p2.mp, sp: d.players.p2.sp, facing: d.players.p2.facing };
  rebuilt.bases.p1 = d.bases.p1.hp;
  rebuilt.bases.p2 = d.bases.p2.hp;
  if (sample.has(d.tick)) {
    checked++;
    if (JSON.stringify(rebuilt) !== JSON.stringify(states[i])) { bad++; console.log('MISMATCH tick', d.tick); }
  }
}
console.log(`T-BT-1 扩展：采样 ${checked} tick，不一致 ${bad}`);

// bullets 快照：找有弹幕的 tick，验证字段与 x0 语义
const bf = diffs.find((d) => d.bullets.length > 0);
if (bf) {
  console.log('cast tick', bf.tick, 'bullets:', JSON.stringify(bf.bullets), 'bulletHits:', JSON.stringify(bf.bulletHits));
  const ok = bf.bullets.every((bd) => ['uid', 'owner', 'type', 'level', 'dir', 'x', 'len', 'v'].every((k) => k in bd));
  console.log('bullets 字段齐备:', ok, 'x0 整数:', bf.bullets.every((bd) => Number.isInteger(bd.x)));
}
// 全帧 x0/1px 检查
const nonInt = diffs.flatMap((d) => d.bullets.filter((bd) => !Number.isInteger(bd.x))).length;
console.log('非整数 bullet x0 计数:', nonInt);

// 基地扣血路径：让 p2 一直向右冲向 p1 基地
const b2 = engine.createBattle(undefined, { seed: 5, players: { p1: mkPlayer('p1'), p2: mkPlayer('p2') } });
const planB = {
  p1: () => 'wait',
  p2: (s) => (s.players.p2.x < 992 ? 'move_right' : 'wait'),
};
const d2 = [];
for (let i = 0; i < 40; i++) {
  const d = b2.step({ actions: { aiTrace: bufs.ai, p1: planB.p1, p2: planB.p2 } });
  d2.push(d);
  if (b2.state.verdict) break;
}
const baseFrames = d2.filter((d) => d.bases.p1.hp < 100 || d.bases.p2.hp < 100);
console.log('基地扣血帧数:', baseFrames.length, '示例:', JSON.stringify(baseFrames[0] && { tick: baseFrames[0].tick, bases: baseFrames[0].bases, players: baseFrames[0].players }));
console.log('最终 bases:', JSON.stringify(b2.state.bases), 'winner:', b2.state.verdict.winner);