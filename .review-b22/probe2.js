'use strict';
// B22 审查探针 2：同 seed 帧差异定位（ts 归一化后是否 deepEqual）
const battle = require('../server/battle.js');
const LD = require('../tests/fixtures/loadout-ok.json');

const norm = (frames) => JSON.parse(JSON.stringify(frames, (k, v) => (k === 'ts' ? 0 : v)));

const r1 = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 7, tier: 'mythic' });
const r2 = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 7, tier: 'mythic' });
const rawEq = JSON.stringify(r1.data.frames) === JSON.stringify(r2.data.frames);
const normEq = JSON.stringify(norm(r1.data.frames)) === JSON.stringify(norm(r2.data.frames));
console.log('raw 同 seed 帧相等:', rawEq);
console.log('ts 归一化后相等:', normEq);

// 逐帧找首差异（raw）
const f1 = r1.data.frames, f2 = r2.data.frames;
for (let i = 0; i < Math.min(f1.length, f2.length); i++) {
  const a = JSON.stringify(f1[i]), b = JSON.stringify(f2[i]);
  if (a !== b) {
    console.log('首差异帧 i=', i, 'tick=', f1[i].tick);
    // 定位字段级差异
    const diffFields = [];
    for (const k of ['tick', 'players', 'bullets', 'bases', 'aiTrace', 'collision', 'bulletHits', 'verdict']) {
      if (JSON.stringify(f1[i].diff[k]) !== JSON.stringify(f2[i].diff[k])) diffFields.push(k);
    }
    console.log('差异字段:', diffFields.join(','));
    const e1 = (f1[i].diff.events || [])[0], e2 = (f2[i].diff.events || [])[0];
    console.log('events[0] r1 keys:', e1 ? Object.keys(e1).join(',') : '-');
    console.log('events[0] r2 keys:', e2 ? Object.keys(e2).join(',') : '-');
    console.log('events[0] r1:', JSON.stringify(e1));
    console.log('events[0] r2:', JSON.stringify(e2));
    break;
  }
}
const eAny = f1[0].diff.events[0];
console.log('events 顶层字段样板:', JSON.stringify(eAny));