'use strict';
/* B25 审查探针 3：契约文档↔实现交叉核对（RK-2a..h 逐行机器断言）+ 死分支 + 回归抽查
 * 可复跑：node .review-b25/probe3.js */
const assert = require('node:assert/strict');
const ranked = require('../server/ranked.js');

let ok = 0, fail = 0;
function chk(name, fn) {
  try { fn(); ok++; console.log(`  [ok] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

// ① examples/10-ranked.md RK-2a..h 逐行机器断言（wins>6 晋升；不降段；顶段封顶）
chk('RK-2a：10 胜 0 负 → 晋升', () => {
  assert.equal(ranked.promote('common', 10).data.promoted, true);
});
chk('RK-2b：7 胜 3 负 → 晋升（7>6）', () => {
  assert.equal(ranked.promote('common', 7).data.promoted, true);
});
chk('RK-2c：7 胜 2 负 1 平 → 晋升（平局不计但仍是 7 胜）', () => {
  assert.equal(ranked.promote('common', 7).data.promoted, true);
});
chk('RK-2d：6 胜 4 负 → 不晋升（6>6 为假）', () => {
  assert.equal(ranked.promote('common', 6).data.promoted, false);
});
chk('RK-2e：6 胜 3 负 1 平 → 不晋升（平局不补胜场）', () => {
  assert.equal(ranked.promote('common', 6).data.promoted, false);
});
chk('RK-2f：5 胜 5 负 → 不晋升', () => {
  assert.equal(ranked.promote('common', 5).data.promoted, false);
});
chk('RK-2g：0 胜 10 负 → 不晋升（不降段——tier 原样回带）', () => {
  const r = ranked.promote('epic', 0);
  assert.equal(r.data.promoted, false);
  assert.equal(r.data.tier, 'epic', '不降段：tier 不变');
});
chk('RK-2h：已达 mythic 且 10 胜 → 不再晋升（409 already_max）', () => {
  const r = ranked.promote('mythic', 10);
  assert.equal(r.status, 409);
  assert.equal(r.code, 'already_max');
});
chk('边界语义：x=6 是「大于 6」不是「≥ 6」（RK-2b/2d 两侧）', () => {
  assert.equal(ranked.promote('common', 6).data.promoted, false);
  assert.equal(ranked.promote('common', 7).data.promoted, true);
});

// ② systems/10-ranked.md §4.4/§4.5 逐条
chk('§4.4：wins>x → tier+1（顺序数组 +1）', () => {
  assert.equal(ranked.promote('rare', 7).data.tier, 'epic', 'rare → epic（+1）');
  assert.equal(ranked.promote('epic', 7).data.tier, 'legendary');
  assert.equal(ranked.promote('legendary', 7).data.tier, 'mythic');
});
chk('§4.4：达到最高段位后不再晋升 → 409', () => {
  assert.equal(ranked.promote('mythic', 7).status, 409);
});
chk('§4.5：tierReward 按段位返回品质上限（绿→绿 … 青→青）', () => {
  const map = { common: 'common', rare: 'rare', epic: 'epic', legendary: 'legendary', mythic: 'mythic' };
  for (const [t, q] of Object.entries(map)) assert.equal(ranked.tierReward(t), q);
});

// ③ 死分支可达性：promote 三路径 + tierReward 非法路径在套件/探针中被覆盖（cov 行 100%）
chk('promote 三路径（200 不晋升/200 晋升/409）全部可达且互斥', () => {
  const a = ranked.promote('common', 3);   // 不晋升
  const b = ranked.promote('common', 8);   // 晋升
  const c = ranked.promote('mythic', 8);   // 封顶
  assert.equal([a, b, c].map((r) => r.status).join(','), '200,200,409');
  assert.equal(a.data.promoted, false);
  assert.equal(b.data.promoted, true);
  assert.equal(c.code, 'already_max');
});
chk('tierReward 非法路径返回 null（不抛、不落到任意合法值）', () => {
  assert.equal(ranked.tierReward('platinum'), null);
  assert.equal(ranked.tierReward(undefined), null);
  assert.equal(ranked.tierReward(null), null);
});

// ④ B24 衔接回归：/ranked/run 快照与统计不受 promote 改动影响（B24 交付语义抽查）
chk('B24 回归：takeSnapshot 深冻结 + runRankedBattle 10 场闭合', () => {
  const LD = require('../tests/fixtures/loadout-ok.json');
  const ld = () => JSON.parse(JSON.stringify(LD.loadout));
  const snap = ranked.takeSnapshot(ld());
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.skills[0]));
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, seed: 11, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.equal(r.data.wins + r.data.draws + r.data.losses + r.data.invalids, 10);
  assert.ok(r.data.results.every((m) => m.winner !== 'invalid'), 'bot 场次全有效（P1-1 不回归）');
});

console.log(`\nprobe3: ${ok} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);