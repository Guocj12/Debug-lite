'use strict';
// .review-b23/probe4.js —— 真实战斗帧分析：多 seed 扫描找命中/碰撞样本；
// 每 tick 事件数分布（slice(-12) 信息损失）、事件通道分布、命中帧链完整性（cast/spawn/hit/damage.calc/effect.add）、
// cid 唯一性/单调性、verdict 逐帧存在性、bulletHits↔damage.calc 对照（B22 P2-10 再评估物证）。
const battle = require('../server/battle.js');
const LD = require('../tests/fixtures/loadout-ok.json');

function analyze(name, frames) {
  const perTick = frames.map((f) => f.diff.events.length);
  const chans = {};
  for (const f of frames) for (const e of f.diff.events) chans[e.channel + '.' + e.event] = (chans[e.channel + '.' + e.event] || 0) + 1;
  let hitTicks = 0, collTicks = 0, bulletTicks = 0, cidDup = 0, cidNonMono = 0, noVerdictKey = 0;
  for (const f of frames) {
    if (f.diff.bulletHits && f.diff.bulletHits.length) hitTicks++;
    if (f.diff.collision) collTicks++;
    if (f.diff.bullets && f.diff.bullets.length) bulletTicks++;
    if (!('verdict' in f.diff)) noVerdictKey++;
    const seen = new Set(); let lastSeq = -1; let first = true;
    for (const e of f.diff.events) {
      if (seen.has(e.cid)) cidDup++;
      seen.add(e.cid);
      const m = /^t(\d+):(\d+)$/.exec(e.cid);
      if (m) { const s = +m[2]; if (first) { lastSeq = s; first = false; } else if (s !== lastSeq + 1) cidNonMono++; lastSeq = s; }
      else cidNonMono++;
    }
  }
  const tailLoss = perTick.filter((n) => n > 12).length;
  const chainTicks = frames.filter((f) => f.diff.bulletHits && f.diff.bulletHits.length).map((f) => {
    const ev = f.diff.events.map((e) => e.channel + '.' + e.event);
    return { tick: f.tick, hasSpawn: ev.includes('bullets.bullet.spawn'), hasHit: ev.includes('bullets.bullet.hit'), hasCalc: ev.includes('damage.damage.calc'), hasEnd: ev.includes('engine.tick.end'), n: ev.length };
  });
  return { perTick, chans, hitTicks, collTicks, bulletTicks, tailLoss, chainTicks, cidDup, cidNonMono, noVerdictKey };
}

// 1) 审计自跑 battle（seed 20260913）——它自己跑的那场
const a = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
const ra = analyze('audit-battle', a.data.frames);
console.log(`\n=== 审计自跑 battle（seed 20260913 mythic）：ticks=${a.data.ticks} winner=${a.data.winner}`);
console.log(`hitTicks=${ra.hitTicks} collTicks=${ra.collTicks} bulletTicks=${ra.bulletTicks}（含弹幕帧数）`);
console.log(`events/tick 分布: max=${Math.max(...ra.perTick)} min=${Math.min(...ra.perTick)} avg=${(ra.perTick.reduce((x, y) => x + y, 0) / ra.perTick.length).toFixed(1)}`);
console.log(`通道: ${JSON.stringify(ra.chans)}`);
console.log(`cid 重复=${ra.cidDup} 非单调=${ra.cidNonMono} 无 verdict 键帧=${ra.noVerdictKey}`);

// 2) seed 扫描：找有命中/有碰撞的样本
let hitSample = null, collSample = null;
for (let s = 1; s <= 60 && (!hitSample || !collSample); s++) {
  const rr = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: s, tier: 'mythic' });
  const r2 = analyze(`seed${s}`, rr.data.frames);
  if (!hitSample && r2.hitTicks > 0) hitSample = { seed: s, r2 };
  if (!collSample && r2.collTicks > 0) collSample = { seed: s, r2 };
}
for (const [label, smp] of [['命中样本', hitSample], ['碰撞样本', collSample]]) {
  if (!smp) { console.log(`\n${label}: 60 seed 内未找到`); continue; }
  const { seed, r2 } = smp;
  console.log(`\n=== ${label} seed=${seed}：hitTicks=${r2.hitTicks} collTicks=${r2.collTicks} bulletTicks=${r2.bulletTicks}`);
  console.log(`events/tick: max=${Math.max(...r2.perTick)} >12 的帧数=${r2.tailLoss}/${r2.perTick.length}（slice(-12) 会截断）`);
  console.log(`链完整性（命中帧）:`);
  for (const c of r2.chainTicks.slice(0, 6)) console.log(`  tick${c.tick}: spawn=${c.hasSpawn} hit=${c.hasHit} damage.calc=${c.hasCalc} tick.end=${c.hasEnd} n=${c.n}`);
  const top = Object.entries(r2.chans).sort((x, y) => y[1] - x[1]).slice(0, 20);
  console.log(`通道 top20: ${JSON.stringify(Object.fromEntries(top))}`);
  // bulletHits ↔ damage.calc 对照样本：取首个命中帧
  const rf = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed, tier: 'mythic' }).data.frames;
  const hf = rf.find((f) => f.diff.bulletHits && f.diff.bulletHits.length);
  if (hf) {
    console.log(`\n[首命中帧 tick${hf.tick}] bulletHits:`, JSON.stringify(hf.diff.bulletHits));
    console.log('damage.calc 事件:', hf.diff.events.filter((e) => e.event.includes('damage.calc') || e.event.includes('bullet.hit') || e.event.includes('bullet.spawn') || e.event.includes('effect.add')).map((e) => `${e.channel}.${e.event} cid=${e.cid} data=${JSON.stringify(e.data)}`).join('\n  '));
  }
}