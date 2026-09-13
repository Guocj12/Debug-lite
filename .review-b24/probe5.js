'use strict';
/* B24 审查探针 5：输场（loss）与晋升阈值边界——强对手池 → else losses 分支（ranked.js:108 覆盖缺口物证）
 * 可复跑：node .review-b24/probe5.js
 */
const assert = require('node:assert/strict');
const ranked = require('../server/ranked.js');
const LD = require('../tests/fixtures/loadout-ok.json');
const ld = () => JSON.parse(JSON.stringify(LD.loadout));
const wh = () => JSON.parse(JSON.stringify(LD.warehouse));
const ai = (name) => ({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name }] } });

// 强对手：hp 9999 / atk 100 / move_left 追击 → 确定性 p2 胜（3 seed 实证）
const strong = (i) => { const x = ld(); x.ai = ai('move_left'); x.skills[0].uid = `s${i}`; x.role.stats.hp = 9999; x.role.stats.atk = 100; return x; };
const weak = (i) => { const x = ld(); x.ai = ai('wait'); x.skills[0].uid = `w${i}`; x.role.stats.hp = 1; return x; };

let ok = 0, fail = 0;
function chk(name, fn) {
  try { fn(); ok++; console.log(`  [ok] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

chk('确定性前提：普通 mine vs 强对手 → p2 胜（3 seed）', () => {
  const battle = require('../server/battle.js');
  for (const s of [1, 11, 21]) {
    const r = battle.runBattle({ p1: ld(), p2: strong(0), warehouse: wh(), seed: s, tier: 'mythic' });
    assert.equal(r.data.winner, 'p2', `seed ${s}`);
  }
});
chk('输场分支（else losses，ranked.js:108）：10 强对手 → losses 10 / wins 0 / promoted false', () => {
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), pool: Array.from({ length: 10 }, (_, i) => strong(i + 1)), seed: 31337, tier: 'mythic' });
  assert.equal(r.data.losses, 10);
  assert.equal(r.data.wins, 0);
  assert.equal(r.data.promoted, false);
  assert.ok(r.data.results.every((m) => m.winner === 'p2' && m.ticks > 0), 'results 逐场 winner=p2 带 ticks');
});
chk('晋升阈值边界（D-122，x=6）：6 胜不晋升 / 7 胜晋升——9 弱 + 1 强（大概率 9 胜）', () => {
  const pool = [...Array.from({ length: 9 }, (_, i) => weak(i + 1)), strong(10)];
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), pool, seed: 11, tier: 'mythic' });
  assert.equal(r.data.promoted, r.data.wins > 6, 'promoted = wins > 6（与 X_PROMOTE 一致）');
  assert.equal(r.data.promoted, r.data.wins > ranked.X_PROMOTE);
  console.log(`    实证: wins=${r.data.wins} draws=${r.data.draws} losses=${r.data.losses} promoted=${r.data.promoted}（X_PROMOTE=${ranked.X_PROMOTE}）`);
});
chk('X_PROMOTE=6（D-122 frozen 值）', () => {
  assert.equal(ranked.X_PROMOTE, 6);
});

console.log(`\nprobe5: ${ok} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);