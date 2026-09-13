'use strict';
/* B24 审查探针 1：统计闭合 / 确定性 / 排除自己（同 loadout 入池）/ 抽签流前缀不变性（同一池抽 4 vs 抽 10）
 * 可复跑：node .review-b24/probe1.js
 * 说明：排除自己的可观测等价性探针——mine(move_right) vs 弱对手(hp=1,wait) 确定性 p1 胜（8/8 seed 实证），
 *      弱对手互博恒平局；因此「池含自身深拷贝 + 9 弱对手」的抽签结果必须与「纯 9 弱对手」逐场一致。
 */
const assert = require('node:assert/strict');
const ranked = require('../server/ranked.js');
const { createRng } = require('../server/core/rng.js');
const LD = require('../tests/fixtures/loadout-ok.json');

const ld = () => JSON.parse(JSON.stringify(LD.loadout));
const wh = () => JSON.parse(JSON.stringify(LD.warehouse));
const ai = (name) => ({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name }] } });
const weak = (i) => { const x = ld(); x.ai = ai('wait'); x.skills[0].uid = `e${i}`; x.role.stats.hp = 1; return x; };

let ok = 0, fail = 0;
function chk(name, fn) {
  try { fn(); ok++; console.log(`  [ok] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

// ① 统计闭合 + 确定性
chk('统计闭合 wins+draws+losses==10（真人池）', () => {
  const pool = Array.from({ length: 10 }, (_, i) => weak(i));
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), pool, seed: 20260913, tier: 'mythic' });
  assert.equal(r.data.wins + r.data.draws + r.data.losses, 10);
  assert.equal(r.data.matches, 10);
  assert.equal(r.data.results.length, 10);
});
chk('确定性：同 seed + 同池双跑结果序列逐场一致（含真胜负场）', () => {
  // mine 用合法行动 move_right（fixture AI 的 skill1 无冒号 → 归一化 wait，属 B23 P2-3 残留，见审查记录）
  const mine = ld(); mine.ai = ai('move_right');
  const pool = Array.from({ length: 10 }, (_, i) => weak(i));
  const a = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool, seed: 777, tier: 'mythic' });
  const b = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool, seed: 777, tier: 'mythic' });
  assert.deepEqual(b.data.results, a.data.results);
  assert.equal(b.data.wins, a.data.wins);
  assert.ok(a.data.wins > 0, `真人池应产生胜场（实际 wins=${a.data.wins}）`); // 弱对手+追击 → p1 胜
});
chk('确定性跨调用（缺口①）：两次调用各自重建 rng → 第 1 场种子一致（结果同）', () => {
  const pool = Array.from({ length: 3 }, (_, i) => weak(i));
  const mk = () => ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), pool, seed: 999, tier: 'mythic' });
  assert.deepEqual(mk().data.results, mk().data.results);
});

// ② 排除自己：mine 深拷贝入池必须被滤除（等价池等价结果）
chk('敏感前提：move_right mine vs 弱对手(waithp1) → p1 胜（确定性 8/8）', () => {
  const mine = ld(); mine.ai = ai('move_right');
  const battle = require('../server/battle.js');
  for (const s of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const r = battle.runBattle({ p1: JSON.parse(JSON.stringify(mine)), p2: JSON.parse(JSON.stringify(weak(0))), warehouse: wh(), seed: s, tier: 'mythic' });
    assert.equal(r.data.winner, 'p1', `seed ${s} 应 p1 胜`);
  }
});
chk('排除自己：pool=[mine深拷贝 + 9 弱对手] ≡ pool=[9 弱对手]（同 seed 逐场一致）', () => {
  const mine = ld(); mine.ai = ai('move_right');
  const copy = JSON.parse(JSON.stringify(mine)); // 与 mine JSON 全等（含 uid）→ 必须被排除
  const es = Array.from({ length: 9 }, (_, i) => weak(i + 1));
  const rA = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool: [copy, ...es], seed: 4242, tier: 'mythic' });
  const rB = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool: es, seed: 4242, tier: 'mythic' });
  assert.deepEqual(rA.data.results, rB.data.results, '含自身拷贝的池应与等价池逐场一致（自身被排除、不抽到自己）');
  assert.equal(rA.data.wins, rB.data.wins);
  assert.equal(rA.data.draws, rB.data.draws);
  assert.equal(rA.data.losses, rB.data.losses);
});
chk('排除自己反证：若排除失效（注入异 uid 的“自己”）会改变结果（探针敏感度）', () => {
  const mine = ld(); mine.ai = ai('move_right');
  const notSelf = JSON.parse(JSON.stringify(mine)); notSelf.skills[0].uid = 'not-self-uid'; // JSON 不等 → 不排除
  const es = Array.from({ length: 9 }, (_, i) => weak(i + 1));
  const rA = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool: [notSelf, ...es], seed: 4242, tier: 'mythic' });
  const rB = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool: es, seed: 4242, tier: 'mythic' });
  assert.notDeepEqual(rA.data.results, rB.data.results, '异 uid 副本入池应改变抽签结果 → 排除逻辑确实生效');
});

// ③ 抽签流前缀不变性（同一池）：抽 4 场 ≡ 抽 10 场的前 4 次抽取（无回看、无 bot 扰动）
function drawSim(poolLen, draws) {
  const rng = createRng(20260913).deriveStream(0, 'ranked');
  const acc = Array.from({ length: poolLen }, (_, i) => i);
  const out = [];
  for (let i = 0; i < draws; i++) {
    if (acc.length === 0) { out.push('BOT'); continue; }
    const idx = rng.int(0, acc.length - 1);
    out.push(acc.splice(idx, 1)[0]);
  }
  return out;
}
chk('同一池：抽 4 场 == 抽 10 场的前 4 次抽取（索引序列不变性）', () => {
  const a4 = drawSim(15, 4);
  const a10 = drawSim(15, 10);
  assert.deepEqual(a4, a10.slice(0, 4), `抽4 ${JSON.stringify(a4)} vs 抽10前4 ${JSON.stringify(a10.slice(0, 4))}`);
});
chk('重建 rng 确定性：两次独立模拟索引序列一致（缺口①）', () => {
  assert.deepEqual(drawSim(15, 10), drawSim(15, 10));
});
// 消费量台账：池 3 → 3 索引 + 10 场种子；池 15 → 10 索引 + 10 场种子（bot 路径零消费）
function consumeTrace(poolLen) {
  const rng = createRng(999).deriveStream(0, 'ranked');
  let indexDraws = 0, seedDraws = 0, bots = 0;
  const acc = Array.from({ length: poolLen }, (_, i) => i);
  for (let i = 0; i < 10; i++) {
    if (acc.length === 0) { bots++; continue; }
    const idx = rng.int(0, acc.length - 1);
    acc.splice(idx, 1);
    indexDraws++;
  }
  for (let i = 0; i < 10; i++) rng.int(1, 0x7fffffff), seedDraws++;
  return { indexDraws, seedDraws, bots };
}
chk('消费量台账：bot 路径不消费索引；场种子恒 10 次且域一致', () => {
  const t3 = consumeTrace(3), t15 = consumeTrace(15), t0 = consumeTrace(0);
  assert.deepEqual(t3, { indexDraws: 3, seedDraws: 10, bots: 7 });
  assert.deepEqual(t15, { indexDraws: 10, seedDraws: 10, bots: 0 });
  assert.deepEqual(t0, { indexDraws: 0, seedDraws: 10, bots: 10 });
});

console.log(`\nprobe1: ${ok} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);