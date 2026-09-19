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

// ---- B25：晋升与段位奖励（T-RK-2/4，D-122）----

test('T-RK-4 段位→品质上限 tierReward（RK-5a..e 逐档；非法段位 null）', () => {
  assert.equal(ranked.tierReward('common'), 'common', 'RK-5a');
  assert.equal(ranked.tierReward('rare'), 'rare', 'RK-5b');
  assert.equal(ranked.tierReward('epic'), 'epic', 'RK-5c');
  assert.equal(ranked.tierReward('legendary'), 'legendary', 'RK-5d');
  assert.equal(ranked.tierReward('mythic'), 'mythic', 'RK-5e');
  assert.equal(ranked.tierReward('platinum'), null, '非法段位');
});

test('T-RK-2 晋升阈值 x=6：wins=6 不晋升；7 晋升；连续段位递增；顶段 409 already_max', () => {
  const r6 = ranked.promote('common', 6);
  assert.equal(r6.status, 200);
  assert.deepEqual(r6.data, { tier: 'common', promoted: false, reward: 'common', wins: 6 }, 'wins=6 不晋升');
  const r7 = ranked.promote('common', 7);
  assert.equal(r7.status, 200);
  assert.deepEqual(r7.data, { tier: 'rare', promoted: true, reward: 'rare', wins: 7 }, 'wins=7 晋升 + 奖励品质=新段位');
  const r8 = ranked.promote('rare', 8);
  assert.equal(r8.data.tier, 'epic');
  const rM = ranked.promote('mythic', 7);
  assert.equal(rM.status, 409);
  assert.equal(rM.code, 'already_max', '最高段位不再晋升');
});

test('promote 参数错误：bad_tier / bad_wins（非整数/负数/缺省/超上限）', () => {
  assert.equal(ranked.promote('platinum', 7).code, 'bad_tier');
  assert.equal(ranked.promote(undefined, 7).code, 'bad_tier');
  assert.equal(ranked.promote('common', 'x').code, 'bad_wins');
  assert.equal(ranked.promote('common', -1).code, 'bad_wins');
  assert.equal(ranked.promote('common', 1.5).code, 'bad_wins');
  assert.equal(ranked.promote('common', undefined).code, 'bad_wins');
  assert.equal(ranked.promote('common', 11).code, 'bad_wins', 'P2-2：wins ≤ 10 上限');
});

test('P2-1：promotedAt 顶段不判定晋升（与 /ranked/run 口径同源分离）', () => {
  assert.equal(ranked.promotedAt('mythic', 7), false, '顶段 wins=7 不判定晋升');
  assert.equal(ranked.promotedAt('legendary', 7), true, '次顶段 wins=7 判定晋升');
  assert.equal(ranked.promotedAt('common', 6), false, 'wins=6 不达阈值');
  assert.equal(ranked.promote('mythic', 7).status, 409, 'promote 顶段仍 409 already_max');
});

test('P2-3：tierReward 与开箱品质上限交叉一致（门控开启 = 回退模式；B17 同源 D-122；逐档 5000 样本 max 品质）', () => {
  // 门控关闭（默认）后"品质上限"不再是开箱约束（用户决策 2026-09-16）→ 本交叉绑定只在门控开启时成立，
  //   用 withGating(true) 实例断言旧口径；tierReward 本身（段位→奖励品质映射）仍按段位，不受开关影响。
  const items = require('../../server/core/items.js').withGating(true);
  const { createRng } = require('../../server/core/rng.js');
  for (const t of ranked.TIERS) {
    const rng = createRng(20260913 + ranked.TIERS.indexOf(t));
    let maxQ = null;
    for (let i = 0; i < 5000; i++) {
      const q = items.rollQuality(rng, t);
      if (maxQ === null || ranked.TIERS.indexOf(q) > ranked.TIERS.indexOf(maxQ)) maxQ = q;
    }
    assert.equal(maxQ, ranked.tierReward(t), `${t} 段位开箱上限 == tierReward（交叉绑定）`);
  }
});

test('P2-3b：门控关闭（默认）时开箱品质不受段位限制，tierReward 仍按段位返回奖励品质', () => {
  const items = require('../../server/core/items.js');
  const { createRng } = require('../../server/core/rng.js');
  const rng = createRng(20260913);
  const seen = new Set();
  for (let i = 0; i < 5000; i++) seen.add(items.rollQuality(rng, 'common'));
  assert.ok(seen.has('mythic'), `common 段位也能开出 mythic（实际 ${[...seen].join('/')}）`);
  assert.equal(ranked.tierReward('common'), 'common', '奖励映射与门控无关：common → common');
  assert.equal(ranked.tierReward('mythic'), 'mythic');
});