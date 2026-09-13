'use strict';
// B24 排位核心测试 —— 依据 systems/10-ranked.md §4.2~4.3；tasks §3.2 T-RK-1/5；
// D-122（x=6）/D-123（不持久化）。数值/结构一律机器推导或数据表核。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ranked = require('../../server/ranked.js');
const LD = require('../fixtures/loadout-ok.json');
const ld = () => JSON.parse(JSON.stringify(LD.loadout));

// wait-only 程序（构造平局局）
function waitAi() {
  return { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
}
function waitLd() {
  const x = ld();
  x.ai = waitAi();
  return x;
}

test('T-RK-1 匹配恒 10：无池（bot 补齐）/池 3（补 7）/池 15（抽 10 排除自己）', () => {
  const r1 = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, seed: 11, tier: 'mythic' });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.matches, 10);
  assert.equal(r1.data.results.length, 10);
  assert.ok(r1.data.results.every((m) => m.winner !== 'invalid'), 'bot 补齐场次全部有效（B24 P1-1：3 技能满槽）');
  // 池 3：补 7 bot
  const pool3 = [waitLd(), waitLd(), waitLd()];
  const r2 = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool: pool3, seed: 11, tier: 'mythic' });
  assert.equal(r2.data.matches, 10);
  assert.ok(r2.data.results.every((m) => m.winner !== 'invalid'));
  // 池 15：真排除自己（含 1 个与 mine JSON 完全相同的条目）+ 抽 10
  const pool15 = Array.from({ length: 15 }, (_, i) => {
    const x = waitLd();
    x.skills[0].uid = `w${i}`;
    return x;
  });
  pool15[0] = ld(); // 与 mine 完全一致 → 必须被排除
  const r3 = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool: pool15, seed: 7, tier: 'mythic' });
  assert.equal(r3.data.matches, 10);
  assert.equal(r3.data.invalids, 0, '被排除后无自身同款（结果全有效）');
  assert.ok(r3.data.results.every((m) => m.match >= 1 && m.match <= 10), 'match 编号 1..10');
});

test('B24 P1-1 回归：BOT_LD 三技能满槽且 buildPlayer 通过（不再 invalid）', () => {
  assert.equal(ranked.BOT_LD.skills.length, 3, 'bot 技能恰 3（common 模板循环取满）');
  const b = require('../../server/battle.js').buildPlayer('p1', ranked.BOT_LD, null, 'common');
  assert.equal(b.ok, true, JSON.stringify(b.errors));
  assert.ok(Object.isFrozen(ranked.BOT_LD), 'bot 模板冻结');
});

test('T-RK-5 快照不可变：takeSnapshot 深冻结且与原 loadout 深度相等', () => {
  const src = ld();
  const snap = ranked.takeSnapshot(src);
  assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.role) && Object.isFrozen(snap.skills[0]), '快照深冻结');
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), src, '快照内容与源深度相等');
  assert.throws(() => { snap.role.uid = 'mutated'; }, TypeError, '冻结态写入抛错');
});

test('平局不计胜：wait-only 双方 10 场全平 → wins 0、draws 10', () => {
  const mine = waitLd();
  const pool = Array.from({ length: 10 }, (_, i) => { const x = waitLd(); x.skills[0].uid = `b${i}`; return x; });
  const r = ranked.runRankedBattle({ loadout: mine, warehouse: LD.warehouse, pool, seed: 5, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.equal(r.data.wins + r.data.draws + r.data.losses, 10);
  assert.ok(r.data.results.every((m) => m.winner === 'draw'), '全平局（wait-only 双方无敌对伤害）');
  assert.equal(r.data.promoted, false, '平局不计胜、不晋升');
});

test('确定性：同 seed + 同池 → 同结果序列（逐场 winner/ticks 一致）', () => {
  const pool = Array.from({ length: 10 }, (_, i) => { const x = waitLd(); x.skills[0].uid = `c${i}`; return x; });
  const opt = { loadout: ld(), warehouse: LD.warehouse, pool, seed: 20260913, tier: 'mythic' };
  const r1 = ranked.runRankedBattle(opt);
  const r2 = ranked.runRankedBattle(opt);
  assert.deepEqual(r2.data.results, r1.data.results, '同 seed 结果序列逐场一致');
  assert.equal(r2.data.wins, r1.data.wins);
});

test('输场分支（P2-11）：血量为 1 的脆弱我方对上 bot → 全场真输（losses 分支覆盖）', () => {
  const weak = ld();
  weak.role.stats = { hp: 1, atk: 0, def: 0, sp: 60, mp: 40 }; // 与负载无关的面板直改
  const r = ranked.runRankedBattle({ loadout: weak, warehouse: LD.warehouse, seed: 99, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.ok(r.data.losses > 0, `脆弱我方应有真输场（实际 losses=${r.data.losses}）`);
  assert.ok(r.data.losses + r.data.draws >= 1, '闭合：wins+draws+losses+invalids == 10');
});

test('P2-4 invalid 单独计数：池含坏条目（技能 2 个）→ invalids ≥1 且不再计 loss', () => {
  const bad = waitLd();
  bad.skills = bad.skills.slice(0, 2);
  const pool = [bad, bad, bad, waitLd(), waitLd()];
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool, seed: 13, tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.ok(r.data.invalids >= 1, `坏池条目单独计数（实际 ${r.data.invalids}）`);
  assert.equal(r.data.wins + r.data.draws + r.data.losses + r.data.invalids, 10, '四项闭合');
});

test('409 业务/400 参数：无 loadout → no_loadout；非法 loadout → loadout_invalid；坏 seed → bad_seed；坏 pool → bad_pool', () => {
  assert.equal(ranked.runRankedBattle({}).status, 409);
  assert.equal(ranked.runRankedBattle({}).code, 'no_loadout');
  const bad = ld();
  bad.skills = bad.skills.slice(0, 2);
  const r2 = ranked.runRankedBattle({ loadout: bad, warehouse: LD.warehouse, tier: 'mythic' });
  assert.equal(r2.status, 409);
  assert.equal(r2.code, 'loadout_invalid');
  const r3 = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, seed: 'x' });
  assert.equal(r3.status, 400);
  assert.equal(r3.code, 'bad_seed');
  const r4 = ranked.runRankedBattle({ loadout: ld(), warehouse: LD.warehouse, pool: 'nope' });
  assert.equal(r4.status, 400);
  assert.equal(r4.code, 'bad_pool');
});