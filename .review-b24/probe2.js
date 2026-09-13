'use strict';
/* B24 审查探针 2：wait-only 全平局 / invalid 防御路径可达性物证 / 平局判定 winner 域交叉验证
 * 可复跑：node .review-b24/probe2.js
 */
const assert = require('node:assert/strict');
const ranked = require('../server/ranked.js');
const LD = require('../tests/fixtures/loadout-ok.json');
const ld = () => JSON.parse(JSON.stringify(LD.loadout));
const wh = () => JSON.parse(JSON.stringify(LD.warehouse));
const waitAi = () => ({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } });

let ok = 0, fail = 0;
function chk(name, fn) {
  try { fn(); ok++; console.log(`  [ok] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

chk('wait-only 双方 10 场全平局：wins 0 / draws 10 / losses 0 / promoted false（平局不计胜）', () => {
  const mine = ld(); mine.ai = waitAi();
  const pool = Array.from({ length: 10 }, (_, i) => { const x = ld(); x.ai = waitAi(); x.skills[0].uid = `b${i}`; return x; });
  const r = ranked.runRankedBattle({ loadout: mine, warehouse: wh(), pool, seed: 5, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.equal(r.data.wins, 0);
  assert.equal(r.data.draws, 10);
  assert.equal(r.data.losses, 0);
  assert.equal(r.data.promoted, false);
  assert.ok(r.data.results.every((m) => m.winner === 'draw'));
});

// 平局 winner 域交叉验证：battle.runBattle（B22 同管线）wait vs wait → draw
chk('engine 平局域交叉验证：battle.runBattle wait vs wait → winner draw（与 battleOne 同源）', () => {
  const battle = require('../server/battle.js');
  const mk = () => { const x = ld(); x.ai = waitAi(); return x; };
  const r = battle.runBattle({ p1: mk(), p2: mk(), warehouse: wh(), seed: 5, tier: 'mythic' });
  assert.equal(r.data.winner, 'draw');
  assert.ok(r.data.ticks > 0);
});

// ⚠️ P1 物证：BOT_LD 仅 2 技能 → buildPlayer 失败 → 无池场景 10 场全 invalid → 计 loss
chk('P1 复现：无池 10 场全 invalid（BOT_LD 技能数=2 < 3）→ losses 10', () => {
  assert.equal(ranked.BOT_LD.skills.length, 2, 'BOT_LD.skills 实际长度（common 模板仅 2 个）');
  const battle = require('../server/battle.js');
  const b = battle.buildPlayer('p2', ranked.BOT_LD, undefined, 'mythic');
  assert.equal(b.ok, false, 'BOT_LD 无法构建玩家（技能必须恰 3 个）');
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), seed: 11, tier: 'mythic' });
  assert.equal(r.data.losses, 10);
  assert.deepEqual(new Set(r.data.results.map((m) => m.winner)), new Set(['invalid']));
});

// invalid 场次计 loss 语义：results 行 winner='invalid'（非引擎域值）——防御路径可达性物证
chk('invalid 结果行语义（winner=invalid 非引擎域）', () => {
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), seed: 11, tier: 'mythic' });
  assert.ok(r.data.results.some((m) => m.winner === 'invalid' && m.ticks === 0));
});

// 修复方向可行性预验证：重复 common 模板补足 3 技能能通过 buildPanel（validateLoadout 不查 templateId 唯一）
chk('修复方向预验证：3 技能变体（重复模板）构建成功', () => {
  const battle = require('../server/battle.js');
  const bot3 = JSON.parse(JSON.stringify(ranked.BOT_LD));
  while (bot3.skills.length < 3) bot3.skills.push(JSON.parse(JSON.stringify(bot3.skills[0])));
  const b = battle.buildPlayer('p2', bot3, undefined, 'mythic');
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  const loadout = require('../server/loadout.js');
  const v = loadout.validateLoadout(bot3, { warehouse: null, tier: 'mythic' });
  assert.equal(v.ok, true);
});

console.log(`\nprobe2: ${ok} ok / ${fail} fail`);
process.exit(fail ? 1 : 0);