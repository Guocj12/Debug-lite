'use strict';
// .review-b23/probe5.js —— 黄金战斗帧深挖（含事件缓冲）：
// ① auditFrames 对位移技(bash)/互穿/碰撞密集帧是否误报（衔接恒等式在特殊位置的实证）
// ② 命中帧链完整性（spawn→hit→damage.calc→tick.end）与 cid 单调
// ③ damage.calc 载荷 ↔ bulletHits 对照（B22 P2-10「帧是否足以重放伤害」物证）
// ④ slice(-12) 截断在该战斗的信息损失量化
const { runGolden, SEED } = require('../.audit/golden-battle.js');
const { createLogger } = require('../shared/log.js');
const engine = require('../server/core/engine.js');
const { auditFrames } = require('../.audit/replay-audit.js');

// 复刻 runGolden 但带事件缓冲
const skills = require('../server/core/skills.js');
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
const planCfg = {
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
const actions = { p1: (s) => planCfg.p1[s.tick - 1] || 'wait', p2: (s) => planCfg.p2[s.tick - 1] || 'wait' };
const p1 = mkPlayer('p1'); p1.special.critChance = 0.5;
const p2 = mkPlayer('p2');
p1.skills = { precise: skills.instantiateSkill('skill_straight_precise', 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }) };
p2.skills = { bash: skills.instantiateSkill('skill_dash_bash', 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }) };
p1.skills.precise.multiplier = 1.0;
p2.skills.bash.multiplier = 1.3; p2.skills.bash.distance = 4; p2.skills.bash.passThroughEnemy = false; p2.skills.bash.dealDamage = true;

const buf = [];
const logger = createLogger({ level: 'all', ringSize: 200000, onRecord: (r) => buf.push(r) });
const b = engine.createBattle(undefined, { seed: SEED, players: { p1, p2 }, logger });
const result = b.runFull({ actions, eventsBuf: buf });
const frames = result.diffs.map((d) => ({ tick: d.tick, diff: d }));

console.log(`黄金战斗 + eventsBuf: ticks=${result.ticks} winner=${result.winner}`);
const perTick = frames.map((f) => f.diff.events.length);
console.log(`events/tick: min=${Math.min(...perTick)} max=${Math.max(...perTick)} avg=${(perTick.reduce((x, y) => x + y, 0) / perTick.length).toFixed(1)} >12 帧数=${perTick.filter((n) => n > 12).length}/${frames.length}`);

const chans = {};
for (const f of frames) for (const e of f.diff.events) { const k = e.channel + '.' + e.event; chans[k] = (chans[k] || 0) + 1; }
console.log(`通道分布: ${JSON.stringify(chans, null, 0)}`);

// ① auditFrames 在位移技/碰撞帧上是否误报
const audit = auditFrames(frames);
console.log(`\nauditFrames(黄金帧): ok=${audit.ok} problems=${audit.problems.length ? audit.problems.slice(0, 5).join(' | ') : '(无)'} stats=${JSON.stringify(audit.stats)}`);
if (!audit.ok) console.log(audit.problems.join('\n'));

// ② 命中帧链完整性
const hitTicks = frames.filter((f) => f.diff.bulletHits.length).map((f) => f.tick);
console.log(`\n命中帧: ${hitTicks.join(',')}`);
let chainOk = true;
for (const t of hitTicks) {
  const f = frames[t - 1];
  const ev = f.diff.events.map((e) => e.channel + '.' + e.event);
  const seq = f.diff.events.map((e) => `${e.channel}.${e.event}`).join(' → ');
  const ok = ev.includes('bullets.bullet.spawn') && ev.includes('bullets.bullet.hit') && ev.includes('damage.damage.calc') && ev[ev.length - 1] === 'engine.tick.end';
  if (!ok) chainOk = false;
  console.log(`  tick${t}: n=${f.diff.events.length} spawn=${ev.includes('bullets.bullet.spawn')} hit=${ev.includes('bullets.bullet.hit')} calc=${ev.includes('damage.damage.calc')} 尾部=${ev.slice(-2).join('|')} 序=${seq}`);
}
console.log(`链完整性（spawn→hit→damage.calc→…→tick.end）: ${chainOk ? '全成立' : '有缺失'}`);

// ③ bulletHits ↔ damage.calc 对照（首个命中帧全展开）
const hf = frames.find((f) => f.diff.bulletHits.length);
console.log(`\n[首命中帧 tick${hf.tick}] diff.bulletHits = ${JSON.stringify(hf.diff.bulletHits)}`);
console.log('相关事件（含 data）:');
for (const e of hf.diff.events) {
  if (['bullets.bullet.spawn', 'bullets.bullet.hit', 'damage.damage.calc', 'damage.damage.dodge', 'skills.skill.cast', 'effects.effect.add'].includes(`${e.channel}.${e.event}`)) {
    console.log(`  [${e.cid}] ${e.channel}.${e.event} ${JSON.stringify(e.data)}`);
  }
}
// 命中后 hp 差值交叉验证：伤害与 damage.calc 之和一致性（该帧内 p2 hp 下降 vs dmg 汇总）
let calcSum = 0;
for (const e of hf.diff.events) if (e.event === 'damage.calc' && !e.data.trueDamage) calcSum += e.data.dmg || 0;
const hpBefore = frames[hf.tick - 2] ? frames[hf.tick - 2].diff.players.p2.hp : null;
console.log(`\nΣdamage.calc.dmg=${calcSum}；前帧 p2.hp=${hpBefore} → 本帧 ${hf.diff.players.p2.hp}（差 ${hpBefore - hf.diff.players.p2.hp}）——可交叉验证`);

// ④ slice(-12) 截断损失：命中帧在第 12 条内的链事件覆盖
for (const t of hitTicks.slice(0, 3)) {
  const f = frames[t - 1];
  const ev = f.diff.events.map((e) => `${e.channel}.${e.event}`);
  const tail = ev.slice(-12);
  const lost = ev.slice(0, ev.length - 12);
  console.log(`  tick${t}: tail12 含 [spawn=${tail.includes('bullets.bullet.spawn')}, hit=${tail.includes('bullets.bullet.hit')}, calc=${tail.includes('damage.damage.calc')}, tick.end=${tail[tail.length - 1] === 'engine.tick.end'}]；丢失头部=${lost.join(',') || '(无)'}`);
}