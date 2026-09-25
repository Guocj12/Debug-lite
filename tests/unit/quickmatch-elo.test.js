'use strict';
/* tests/unit/quickmatch-elo.test.js —— 快速对战纯函数（非对称 Elo + 匹配窗口）测试
 * 权威：docs/systems/11-account-store.md §8.2（匹配）/§8.3（公式与四条性质）/§8.5；decisions.md D-133/D-136。
 * 本文件只测**纯函数**（不碰 store）：公式可复算、有界、非零和（有意）、均衡点解析值、窗口递进、去重窗口。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const qm = require('../../server/quickmatch.js');
const rankedMod = require('../../server/ranked.js');
const ledger = require('../../server/store/ledger.js');
const h = require('../helpers/ranked.js');

const CFG = h.RATING;

/* ---------- §8.3 公式与性质 ---------- */

test('T-QM-2a 期望胜率 E：同分 = 0.5；分差 ±400 → 1/(1+10^∓1)；对称性 E(a,b) + E(b,a) === 1', () => {
  assert.equal(qm.expectedScore(1500, 1500, CFG), 0.5);
  const up = qm.expectedScore(1900, 1500, CFG);
  assert.ok(Math.abs(up - 10 / 11) < 1e-12, `领先 400 分期望 ${up}（解析 10/11）`);
  const down = qm.expectedScore(1100, 1500, CFG);
  assert.ok(Math.abs(down - 1 / 11) < 1e-12, `落后 400 分期望 ${down}（解析 1/11）`);
  assert.ok(Math.abs(qm.expectedScore(1000, 2000, CFG) + qm.expectedScore(2000, 1000, CFG) - 1) < 1e-12, 'E 对称');
});

test('T-QM-2b 非对称系数：R=0 时 K_gain=kBase、K_loss=kBase；R=cap 时 K_gain 取 kMin、K_loss 取 kMax', () => {
  assert.equal(ledger.gainFactor(0, CFG), CFG.kBase);
  assert.equal(ledger.lossFactor(0, CFG), CFG.kBase);
  assert.equal(ledger.gainFactor(CFG.cap, CFG), CFG.kMin, '满积分赢加最少');
  assert.equal(ledger.lossFactor(CFG.cap, CFG), CFG.kMax, '满积分输扣最多');
});

test('T-QM-2c 有界：扣分 ≤ kMax（上限），加分 ≤ kBase；结果积分恒在 [0, cap]', () => {
  // 文档 §8.3 性质 1 写"Δ 恒 ≤ kBase/2 = 16（加分）"，但公式 Δ = +round(K_gain×(1−E)) 在 E→0（对满积分
  // 对手）时可达 K_gain ≤ kBase = 32。此处按**实现+公式**断言真实上界，并把该文档不一致登记在交付报告里。
  const gainMax = CFG.kBase;
  const lossMax = CFG.kMax;
  for (let points = 0; points <= CFG.cap; points += 25) {
    for (const opponentPoints of [0, 500, 1500, 2500, CFG.cap]) {
      for (const result of ['win', 'loss', 'draw']) {
        const r = qm.ratingDelta({ points, opponentPoints, result, config: CFG });
        assert.ok(Number.isInteger(r.delta), 'Δ 必须是整数（half_up）');
        assert.ok(r.pointsAfter >= 0 && r.pointsAfter <= CFG.cap, `结果积分越界 ${r.pointsAfter}`);
        if (result === 'win') assert.ok(r.delta <= gainMax, `加分上限 ${r.delta} > ${gainMax}（R=${points}）`);
        if (result === 'loss') assert.ok(-r.delta <= lossMax, `扣分上限 ${-r.delta} > ${lossMax}（R=${points}）`);
      }
    }
  }
  // 同分对手（E=0.5）时加分恰好 ≤ kBase/2（文档那句"16"的成立条件）
  const evenWin = qm.ratingDelta({ points: 0, opponentPoints: 0, result: 'win', config: CFG });
  assert.equal(evenWin.delta, Math.floor(CFG.kBase / 2), '同分且 R=0 → Δ=+kBase/2');
});

test('T-QM-2d 非对称：同分对手 R=1500 时，赢的加分 < 输的扣分（D-133"越高赢加越少、输扣越多"）', () => {
  const win = qm.ratingDelta({ points: 1500, opponentPoints: 1500, result: 'win', config: CFG });
  const loss = qm.ratingDelta({ points: 1500, opponentPoints: 1500, result: 'loss', config: CFG });
  assert.ok(win.delta > 0 && loss.delta < 0);
  assert.ok(win.delta < -loss.delta, `赢 +${win.delta} 应小于输 ${loss.delta}（非对称 Elo）`);
  // R=0（低分）恰好对称：K_gain=K_loss=kBase 且 E=0.5
  const win0 = qm.ratingDelta({ points: 0, opponentPoints: 0, result: 'win', config: CFG });
  const loss0 = qm.ratingDelta({ points: 0, opponentPoints: 0, result: 'loss', config: CFG });
  assert.equal(win0.delta, -loss0.delta, 'R=0 对称（Δ = ±kBase/2）');
});

test('T-QM-2e 边界：points=0 输球 → 仍为 0（下限保护）；points=cap 赢球 → 不超 cap', () => {
  const atZero = qm.ratingDelta({ points: 0, opponentPoints: CFG.cap, result: 'loss', config: CFG });
  assert.equal(atZero.pointsAfter, 0, '0 分玩家输球不产生负分');
  const atCap = qm.ratingDelta({ points: CFG.cap, opponentPoints: CFG.cap, result: 'win', config: CFG });
  assert.equal(atCap.pointsAfter, CFG.cap, '满积分赢球不越界');
});

test('T-QM-2f 均衡点解析值：仅在未触发 kMin/kMax 裁剪时 R* = cap × (2p − 1)；被裁剪档另立断言', () => {
  const expectancy = (points, p) => qm.ratingDelta({ points, opponentPoints: points, result: 'win', config: CFG }).delta * p
    + qm.ratingDelta({ points, opponentPoints: points, result: 'loss', config: CFG }).delta * (1 - p);
  // 被裁剪判据：K_gain 触 kMin 或 K_loss 触 kMax（此时 §8.3 的线性解不再成立）
  const clamped = (points) => ledger.gainFactor(points, CFG) <= CFG.kMin || ledger.lossFactor(points, CFG) >= CFG.kMax;
  for (const p of [0.6, 0.7, 0.8]) {
    const expected = CFG.cap * (2 * p - 1);
    assert.equal(CFG.cap * (2 * p - 1), expected, '解析式恒等');
    let flipLow = null;
    let flipHigh = null;
    for (let points = 0; points < CFG.cap; points += 10) {
      if (clamped(points) || clamped(points + 10)) continue; // 跳过被 kMin/kMax 裁剪的档
      if (expectancy(points, p) > 0 && expectancy(points + 10, p) <= 0 && flipLow === null) {
        flipLow = points;
        flipHigh = points + 10;
        break;
      }
    }
    assert.ok(flipLow !== null, `胜率 ${p} 在未裁剪区间应出现期望增量翻转`);
    // Δ 为整数（half_up）→ 实际翻转点与解析值差一个"取整带"（≤ kMax/2）；断言两者贴近即可
    const tol = CFG.kMax;
    assert.ok(Math.abs(expected - flipLow) <= tol,
      `解析均衡点 ${expected}（p=${p}）应贴近实测翻转点 [${flipLow}, ${flipHigh}]（容差 ${tol} = kMax，覆盖 half_up 取整）`);
  }
  // 被裁剪档（p=0.9 → R*=2400，K_gain(2400)=kMin 已触底）：净增量为正 → 积分继续上顶，不收敛到解析值
  const p09 = 0.9;
  assert.ok(clamped(CFG.cap * (2 * p09 - 1)), `R*=2400 的 K_gain 应被 kMin 裁剪（实际 ${ledger.gainFactor(2400, CFG)}）`);
  assert.ok(expectancy(2400, p09) > 0, '裁剪档净增量为正 → 继续向 cap 上顶');
  // 高胜率玩家的理论上限就是 cap（clamp 保证不越界）
  const atCap = qm.ratingDelta({ points: CFG.cap, opponentPoints: CFG.cap, result: 'win', config: CFG });
  assert.equal(atCap.pointsAfter, CFG.cap);
  // p=0.5 的均衡点是 0 分（下限），无法再往下探（clamp 到 0）
  assert.equal(CFG.cap * (2 * 0.5 - 1), 0, '胜率 50% → 均衡点 0 分');
});

test('T-QM-2g 平局：向期望值靠拢（强者平局扣分、弱者平局加分）', () => {
  const strong = qm.ratingDelta({ points: 2400, opponentPoints: 600, result: 'draw', config: CFG });
  const weak = qm.ratingDelta({ points: 600, opponentPoints: 2400, result: 'draw', config: CFG });
  assert.ok(strong.delta < 0, `高分平局应扣分（实际 ${strong.delta}）`);
  assert.ok(weak.delta > 0, `低分平局应加分（实际 ${weak.delta}）`);
  const equal = qm.ratingDelta({ points: 1500, opponentPoints: 1500, result: 'draw', config: CFG });
  assert.equal(equal.delta, 0, '同分平局 Δ=0');
});

/* ---------- 双向结算（D-133 有意非零和） ---------- */

test('T-QM-3 双向结算：双方 pointsAfter 都按各自公式更新；非零和（Δ1+Δ2 ≠ 0）属设计', () => {
  const r = qm.settle({ p1Points: 1500, p2Points: 1500, winner: 'p1', config: CFG });
  assert.equal(r.p1.result, 'win');
  assert.equal(r.p2.result, 'loss');
  assert.equal(r.p1.pointsAfter, r.p1.pointsBefore + r.p1.delta);
  assert.equal(r.p2.pointsAfter, r.p2.pointsBefore + r.p2.delta);
  assert.notEqual(r.p1.delta + r.p2.delta, 0, '同分局面下赢家加分 < 输家扣分 → 存在分数汇（D-133 有意）');
  assert.ok(r.p1.delta + r.p2.delta < 0, '同分局面净变化为负（抑制通胀）');
  assert.equal(r.zeroSum, false, 'zeroSum 恒 false（文档要求显式承认）');
  // 平局也双向
  const d = qm.settle({ p1Points: 2000, p2Points: 1000, winner: 'draw', config: CFG });
  assert.equal(d.p1.result, 'draw');
  assert.equal(d.p2.result, 'draw');
  assert.ok(d.p1.delta < 0 && d.p2.delta > 0, '平局：高分扣、低分加');
});

test('T-QM-3b Elo 可复算：用 ledger 原生公式独立算一遍，逐值与 quickmatch.settle 相等', () => {
  const cases = [
    { p1Points: 0, p2Points: 0, winner: 'p1' },
    { p1Points: 137, p2Points: 210, winner: 'p2' },
    { p1Points: 2900, p2Points: 100, winner: 'p1' },
    { p1Points: 100, p2Points: 2900, winner: 'p2' },
    { p1Points: 1500, p2Points: 1500, winner: 'draw' },
    { p1Points: 2999, p2Points: 1, winner: 'p1' },
  ];
  for (const c of cases) {
    const mine = qm.settle({ ...c, config: CFG });
    const p1Result = c.winner === 'p1' ? 'win' : c.winner === 'p2' ? 'loss' : 'draw';
    const p2Result = c.winner === 'p2' ? 'win' : c.winner === 'p1' ? 'loss' : 'draw';
    const e1 = ledger.ratingDelta({ points: c.p1Points, opponentPoints: c.p2Points, result: p1Result, config: CFG });
    const e2 = ledger.ratingDelta({ points: c.p2Points, opponentPoints: c.p1Points, result: p2Result, config: CFG });
    assert.equal(mine.p1.delta, e1.delta, `p1 Δ 可复算（${JSON.stringify(c)}）`);
    assert.equal(mine.p1.pointsAfter, e1.pointsAfter);
    assert.equal(mine.p1.expected, e1.expected);
    assert.equal(mine.p2.delta, e2.delta, `p2 Δ 可复算（${JSON.stringify(c)}）`);
    assert.equal(mine.p2.pointsAfter, e2.pointsAfter);
  }
});

test('T-QM-3c 对局级"守恒"改写形式：sum(前) + sum(Δ) === sum(后)（含非零和汇）', () => {
  const r = qm.settle({ p1Points: 1200, p2Points: 900, winner: 'p2', config: CFG });
  const before = r.p1.pointsBefore + r.p2.pointsBefore;
  const deltas = r.p1.delta + r.p2.delta;
  const after = r.p1.pointsAfter + r.p2.pointsAfter;
  assert.equal(before + deltas, after, 'Σ前 + ΣΔ === Σ后（恒等式；Δ 之和可为负 = 分数汇）');
  assert.ok(after <= before, '非零和汇：本场不创造分数（只能持平或下沉）');
});

/* ---------- §8.2 匹配窗口与去重（纯函数） ---------- */

function poolOf(list) {
  return list.map((p) => ({ playerId: p.playerId, points: p.points, publicId: p.playerId }));
}

test('T-QM-1 匹配窗口递进：100 → 200 → … → 600；用尽 → no_opponent', () => {
  const farPool = poolOf([{ playerId: 'b', points: 1000 }]); // |1000 − 10| = 990
  const near = qm.findMatch({ pool: farPool, selfPoints: 150, config: CFG, seed: 1, at: 0, foeArchive: null, isEligible: () => true });
  assert.equal(near.ok, false, '分差 850 超过 max 600 → 窗口用尽');
  const near2 = qm.findMatch({ pool: poolOf([{ playerId: 'a', points: 400 }]), selfPoints: 150, config: CFG, seed: 1, at: 0, foeArchive: null, isEligible: () => true });
  assert.equal(near2.ok, true);
  assert.equal(near2.window, 300, '|400−150|=250 → 窗口递进到 300 才命中');
  assert.equal(near2.opponent.playerId, 'a');
  const far = qm.findMatch({ pool: poolOf([{ playerId: 'b', points: 500 }]), selfPoints: 10, config: CFG, seed: 1, at: 0, foeArchive: null, isEligible: () => true });
  assert.equal(far.ok, true);
  assert.equal(far.window, 500, '|500−10|=490 → 窗口递进到 500 即命中（按 step=100 逐级）');
  const none = qm.findMatch({ pool: farPool, selfPoints: 0, config: { ...CFG, matchWindowMax: 100 }, seed: 1, at: 0, foeArchive: null, isEligible: () => true });
  assert.equal(none.ok, false, '窗口用尽 → no_opponent');
  assert.equal(none.opponent, null);
});

test('T-QM-1b 候选过滤：isEligible 为假的（封禁/退池/自己）一律不进候选', () => {
  const pool = poolOf([{ playerId: 'a', points: 100 }, { playerId: 'b', points: 110 }]);
  const found = qm.findMatch({
    pool, selfPoints: 100, config: CFG, seed: 1, at: 0, foeArchive: null,
    isEligible: (c) => c.playerId !== 'a',
  });
  assert.equal(found.ok, true);
  assert.equal(found.opponent.playerId, 'b');
});

test('T-QM-4 软冷却（D-168 纯函数）：权重随时间线性回满、永不硬拒；全员为 0 时取最久未打', () => {
  const hour = 3600 * 1000;
  const now = 1_800_000_000_000;
  const old = { pool: { lastOpponentAt: {} } };
  const pool = poolOf([{ playerId: 'a', points: 1500 }, { playerId: 'b', points: 1500 }, { playerId: 'c', points: 1500 }]);
  const w = (pid) => rankedMod.cooldownWeightOf(old, pid, now, 4);
  // 从未交手 → 1（完全恢复）；刚刚交手 → 0；4h 回满 → 1；2h → 0.5
  assert.equal(w('never'), 1, '从未交手 = 完全恢复');
  old.pool.lastOpponentAt = { a: now, b: now - 2 * hour, c: now - 4 * hour };
  assert.equal(w('a'), 0, '刚交手 = 0');
  assert.equal(w('b'), 0.5, '2h / 4h = 0.5');
  assert.equal(w('c'), 1, '4h 回满 = 1');
  old.pool.lastOpponentAt = { a: now - 8 * hour };
  assert.equal(w('a'), 1, '超过回满时间 → 封顶 1');
  // 权重为 0 的候选**仍可被抽中**（取代 D-136 的硬底线）：池里只有"刚打过"的对手 → 照样匹配
  const onlyJustFaced = { pool: { lastOpponentAt: { a: now, b: now, c: now } } };
  const still = qm.findMatch({ pool, selfPoints: 1500, config: CFG, seed: 1, at: now, foeArchive: onlyJustFaced, isEligible: () => true });
  assert.equal(still.ok, true, '全员冷却未恢复也不 no_opponent（D-168：永不硬拒）');
  assert.ok(['a', 'b', 'c'].includes(still.opponent.playerId));
  assert.equal(still.weight, 0, '选中者的权重如实回报为 0');
  // 很久没打的对手权重更高 → 抽签期望上优先（同 seed 断言可复现的具体结果）
  const mixed = { pool: { lastOpponentAt: { a: now, b: now - 3 * hour, c: now - 100 * hour } } };
  const picked = qm.findMatch({ pool, selfPoints: 1500, config: CFG, seed: 7, at: now, foeArchive: mixed, isEligible: () => true });
  assert.equal(picked.ok, true);
  assert.equal(picked.opponent.playerId, 'c', '权重 1 的最久未打者在本次抽签中被选中（seed=7 可复现）');
  const again = qm.findMatch({ pool, selfPoints: 1500, config: CFG, seed: 7, at: now, foeArchive: mixed, isEligible: () => true });
  assert.equal(again.opponent.playerId, picked.opponent.playerId, '同 seed 同结果（可复现）');
});

test('T-QM-4b 软冷却抽签（D-168）：权重 0 不会被"有恢复的"对手挤掉；已恢复者等权；全员 0 时退化为最久一组', () => {
  const hour = 3600 * 1000;
  const now = 1_800_000_000_000;
  const pool = poolOf([{ playerId: 'a', points: 1500 }, { playerId: 'b', points: 1500 }, { playerId: 'c', points: 1500 }]);
  // ① 有人已恢复（b: 4h → 权重 1）时，刚打过的 a（权重 0）**永不被抽中**（确定性；取代 D-136 的硬底线）
  const foe1 = { pool: { lastOpponentAt: { a: now, b: now - 4 * hour, c: now } } };
  for (let seed = 1; seed <= 24; seed++) {
    const f = qm.findMatch({ pool, selfPoints: 1500, config: CFG, seed, at: now, foeArchive: foe1, isEligible: () => true });
    assert.equal(f.ok, true);
    assert.equal(f.opponent.playerId, 'b', `seed ${seed}: 只有 b 有恢复权重 → 恒选 b（a/c 权重 0 不参与）`);
  }
  // ② 半恢复（a: 2h → 0.5）vs 已恢复（b: 4h → 1）：两者都可能被抽到，但 b 的频次显著更高
  const foe2 = { pool: { lastOpponentAt: { a: now - 2 * hour, b: now - 4 * hour, c: now } } };
  let countA = 0;
  let countB = 0;
  for (let seed = 1; seed <= 240; seed++) {
    const f = qm.findMatch({ pool, selfPoints: 1500, config: CFG, seed, at: now, foeArchive: foe2, isEligible: () => true });
    assert.ok(['a', 'b'].includes(f.opponent.playerId), `seed ${seed}: 只在有恢复权重的 a/b 中（c 权重 0）`);
    if (f.opponent.playerId === 'a') countA += 1;
    else countB += 1;
  }
  assert.ok(countA > 0, '半恢复者仍可能被抽中（软冷却不是硬拒）');
  assert.ok(countB > countA, `已恢复者频次应更高（实测 a=${countA} / b=${countB}）`);
  // ③ 全员权重 0（都很久没打过？不——都很"刚刚"）→ 退化为"最久未打"一组内抽签，永不 no_opponent
  const foe3 = { pool: { lastOpponentAt: { a: now, b: now - hour, c: now - 2 * hour } } };
  const picked = new Set();
  for (let seed = 1; seed <= 60; seed++) {
    const f = qm.findMatch({ pool, selfPoints: 1500, config: CFG, seed, at: now, foeArchive: foe3, isEligible: () => true });
    assert.equal(f.ok, true, '永不 no_opponent（D-168）');
    picked.add(f.opponent.playerId);
  }
  // 权重：a=0、b=0.25、c=0.5 → 三者都可能（无硬拒）；但**权重最高者**（c）应占多数
  assert.ok(picked.size >= 2, `软冷却下多个候选都可能（实得 ${[...picked].join(',')}）`);
});

test('T-QM-2h 突变告警判据 = 单场真实上界 max(kBase, kMax)（P1-3）：不再把合法败局判成突变', () => {
  // 文档 §8.3 旧表述"Δ ≤ kBase/2 = 16"只对"同分对手的加分"成立；实现曾据此设 16 的上限 → 合法败局误报
  const bound = qm.maxSingleMatchDelta(CFG);
  assert.equal(bound, CFG.kMax, '上界 = max(K_gain(base)=kBase, K_loss(cap)=kMax) = 64');
  // 全网格复算：任何合法 (R, R_opp, 结果) 的 |Δ| 都不超过该界，且**存在**超过旧阈值 16 的合法值
  let worstGain = 0;
  let worstLoss = 0;
  for (let points = 0; points <= CFG.cap; points += 25) {
    for (const opponentPoints of [0, 500, 1500, 2500, CFG.cap]) {
      for (const result of ['win', 'loss', 'draw']) {
        const d = qm.ratingDelta({ points, opponentPoints, result, config: CFG }).delta;
        if (d > worstGain) worstGain = d;
        if (-d > worstLoss) worstLoss = -d;
        assert.ok(Math.abs(d) <= bound, `|Δ| ≤ ${bound}（R=${points} R_opp=${opponentPoints} ${result} → ${d}）`);
      }
    }
  }
  assert.equal(worstGain, CFG.kBase, '加分上界 = kBase = 32（低分赢满积分对手）');
  assert.equal(worstLoss, CFG.kMax, '扣分上界 = kMax = 64（满积分输 0 分对手）');
  assert.ok(worstLoss > CFG.kMax / 2, 'kMax/2 根本不是上界（旧口径错处）');
  // 审查实测的两个"合法却被旧阈值误报"的场景
  const loss2900 = qm.ratingDelta({ points: 2900, opponentPoints: 2900, result: 'loss', config: CFG });
  assert.equal(loss2900.delta, -31, 'R=2900 输同分对手 → Δ=-31（旧阈值 16 会误报突变）');
  assert.ok(Math.abs(loss2900.delta) > CFG.kBase / 2 && Math.abs(loss2900.delta) <= bound, '不再误报：16 < 31 ≤ 64');
  const win0 = qm.ratingDelta({ points: 0, opponentPoints: CFG.cap, result: 'win', config: CFG });
  assert.equal(win0.delta, 32, 'R=0 胜满积分对手 → Δ=+32（旧阈值 16 会误报）');
  assert.ok(win0.delta > CFG.kBase / 2 && win0.delta <= bound, '不再误报：16 < 32 ≤ 64');
  // 真异常仍抓得住：同一判据（Math.abs(Δ) > bound）对篡改值成立
  assert.ok(Math.abs(bound + 1) > bound && Math.abs(200) > bound, '超过真实上界的篡改 Δ 仍会触发 store.abuse.suspect');
});


test('T-QM-1c 匹配参数：matchWindowConfig 缺省与非法值兜底（D-168：cooldown → recovery）', () => {
  const cfg = qm.matchWindowConfig({ matchWindowStart: 0, matchWindowStep: 0, matchWindowMax: 0, opponentRecoveryHours: 0 });
  assert.deepEqual(cfg, { start: 0, step: 0, max: 0, recovery: 0 }, '0 是合法值（不启用软冷却）');
  const dflt = qm.matchWindowConfig(undefined);
  assert.deepEqual(dflt, { start: 0, step: 0, max: 0, recovery: 0 }, '缺省 config → 全 0（不编造数值）');
  const bad = qm.matchWindowConfig({ matchWindowStart: 'x', matchWindowStep: -5, matchWindowMax: null, opponentRecoveryHours: 1.5 });
  assert.deepEqual(bad, { start: 0, step: 0, max: 0, recovery: 0 }, '非法值一律回落 0');
  const ok = qm.matchWindowConfig({ matchWindowStart: 100, matchWindowStep: 100, matchWindowMax: 600, opponentRecoveryHours: 4 });
  assert.deepEqual(ok, { start: 100, step: 100, max: 600, recovery: 4 }, 'D-168 冻结值：4h 线性回满');
});

test('候选字段与常量（D-168：软冷却取代双池）：MAX_LIMIT=100；splitByCooldown/COOLDOWN_RELAX_MULT 已删除', () => {
  assert.equal(qm.MAX_LIMIT, 100);
  assert.equal(qm.splitByCooldown, undefined, 'D-168：strict/relaxed 双池已删除');
  assert.equal(qm.COOLDOWN_RELAX_MULT, undefined, 'D-168：72h 放宽倍数已删除');
  assert.equal(typeof rankedMod.cooldownWeightOf, 'function', '软冷却权重在 ranked 单一实现（quickmatch 复用）');
  assert.equal(qm.matchCandidates(poolOf([{ playerId: 'a', points: 100 }]), 100, -1, () => true).length, 0, '负数窗口不命中');
  assert.equal(qm.matchCandidates(poolOf([{ playerId: 'a', points: 100 }]), 100, 0, () => true).length, 1, '窗口 0 = 仅同分');
});
