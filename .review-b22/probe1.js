'use strict';
// B22 审查探针 1：真实 runBattle 帧内容（events/cid/bullets/aiTrace）+ 同 seed 确定性 + 分片边界
const battle = require('../server/battle.js');
const LD = require('../tests/fixtures/loadout-ok.json');

const r1 = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 7, tier: 'mythic' });
console.log('status', r1.status, 'id', r1.data.id, 'winner', r1.data.winner, 'phase', r1.data.phase, 'ticks', r1.data.ticks);
console.log('frames', r1.data.frames.length, 'summary', JSON.stringify({ id: r1.data.id, seed: r1.data.seed, tier: r1.data.tier }));

// ticks 上有 cast 的帧（events 里找 skill.cast）→ 看该 tick 的完整 events 通道分布
const byEvent = {};
for (const f of r1.data.frames) {
  const evs = f.diff.events || [];
  for (const e of evs) {
    byEvent[e.event] = (byEvent[e.event] || 0) + 1;
    if (e.cid) console.log('HAS CID', f.tick, e.event, e.cid);
  }
}
console.log('events 通道分布（全帧）:', JSON.stringify(byEvent));
console.log('tick1 events:', JSON.stringify((r1.data.frames[0] ? r1.data.frames[0].diff.events : []).map((e) => `${e.channel}:${e.event}@tick${e.tick}`)));
// cid 是否全 null
let cidNonNull = 0, totalEv = 0;
for (const f of r1.data.frames) for (const e of f.diff.events || []) { totalEv++; if (e.cid) cidNonNull++; }
console.log(`events 总数 ${totalEv}, cid 非空 ${cidNonNull}`);

// bullets 快照：找非空帧
const bf = r1.data.frames.find((f) => f.diff.bullets.length > 0);
if (bf) console.log('bullets 快照示例 tick', bf.tick, JSON.stringify(bf.diff.bullets.slice(0, 2)));

// aiTrace owner 标注
const at = r1.data.frames.find((f) => (f.diff.aiTrace || []).length > 0);
if (at) console.log('aiTrace 示例 tick', at.tick, JSON.stringify(at.diff.aiTrace.slice(0, 3)));

// 同 seed 双跑确定性
const r2 = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 7, tier: 'mythic' });
const eq = JSON.stringify(r1.data.frames) === JSON.stringify(r2.data.frames);
console.log('同 seed 帧 deepEqual:', eq, 'id1', r1.data.id, 'id2', r2.data.id, 'id 变化:', r1.data.id !== r2.data.id);

// 分片边界
const g = (f, t) => {
  const rr = battle.getReplay(r1.data.id, f, t);
  return `${rr.status} frames=${rr.data ? rr.data.frames.length : '-'}`;
};
console.log('getReplay(2,4):', g(2, 4));
console.log('getReplay(0, 2):', g(0, 2));        // from=0
console.log('getReplay(5, 3):', g(5, 3));        // from>to
console.log('getReplay(1, 9999):', g(1, 9999));  // to 超长
console.log('getReplay(1.5, 3):', g(1.5, 3));    // 非整数
console.log('getReplay(unknown):', battle.getReplay('nope').status);
// GET 回读数据 vs POST 数据字段
const rep = battle.getReplay(r1.data.id);
console.log('GET data keys:', Object.keys(rep.data).join(','));
console.log('POST data keys:', Object.keys(r1.data).join(','));

// tier 是否校验（runBattle 直调）
const badTier = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 7, tier: 'platinum' });
console.log('runBattle tier=platinum →', badTier.status, badTier.code || badTier.data.winner);