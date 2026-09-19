'use strict';
/* tests/unit/store-ledger.test.js —— 非对称 Elo（D-133）与记录构造器（T-QM-2 的存储侧断言）
 * 权威：docs/systems/11-account-store.md §8.3（性质 1~5）/§8.4/§9.1。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../../server/store/ledger.js');
const { DEFAULT_RATING_CONFIG } = require('../../server/store/config.js');

const CFG = { rating: DEFAULT_RATING_CONFIG };

test('LED-1 有界性：Δ 的界 = K 系数上界（kBase / kMax），积分恒在 [0, cap]', () => {
  // 设计文档 §8.3 性质 1 写作"加分 Δ ≤ kBase/2 = 16、扣分 ≤ kMax/2 = 32"——该表述只在**同分对手（E=0.5）**
  // 时成立；按公式本身，Δ = K(R)·(1−E) / −K(R)·E，故真实界为 K_gain ≤ kBase（32）与 K_loss ≤ kMax（64）。
  // 本测试锁定公式给出的真实界，差异已登记在交付报告（与文档不一致处）。
  for (let points = 0; points <= 3000; points += 100) {
    for (const opp of [0, 500, 1500, 3000]) {
      const win = ledger.ratingDelta({ points, opponentPoints: opp, result: 'win', config: CFG });
      const loss = ledger.ratingDelta({ points, opponentPoints: opp, result: 'loss', config: CFG });
      assert.ok(win.delta <= CFG.rating.kBase, `win Δ 超过 kBase: ${win.delta}`);
      assert.ok(loss.delta >= -CFG.rating.kMax, `loss Δ 超过 kMax: ${loss.delta}`);
      assert.ok(win.pointsAfter >= 0 && win.pointsAfter <= CFG.rating.cap);
      assert.ok(loss.pointsAfter >= 0 && loss.pointsAfter <= CFG.rating.cap);
    }
  }
  // 同分对手（E=0.5）时回到文档口径的半界
  for (let points = 0; points <= 3000; points += 500) {
    const win = ledger.ratingDelta({ points, opponentPoints: points, result: 'win', config: CFG });
    const loss = ledger.ratingDelta({ points, opponentPoints: points, result: 'loss', config: CFG });
    assert.ok(win.delta <= CFG.rating.kBase / 2, `同分 win Δ 应 ≤ 16: ${win.delta}`);
    assert.ok(loss.delta >= -CFG.rating.kMax / 2, `同分 loss Δ 应 ≥ −32: ${loss.delta}`);
  }
});

test('LED-2 非对称：R=0 对称；R=1500 时加分 < 扣分（把玩家压在固定区间）', () => {
  const low = ledger.ratingDelta({ points: 0, opponentPoints: 0, result: 'win', config: CFG });
  const lowLoss = ledger.ratingDelta({ points: 0, opponentPoints: 0, result: 'loss', config: CFG });
  assert.equal(low.delta, 16, 'R=0 对同分：K_gain=32 × (1−0.5) = 16');
  assert.equal(lowLoss.delta, -16, 'R=0 对同分：K_loss=32 × 0.5 = 16');
  assert.equal(low.expected, 0.5);

  const high = ledger.ratingDelta({ points: 1500, opponentPoints: 1500, result: 'win', config: CFG });
  const highLoss = ledger.ratingDelta({ points: 1500, opponentPoints: 1500, result: 'loss', config: CFG });
  assert.equal(high.k, 16, 'K_gain(1500) = 32 × (1 − 0.5) = 16');
  assert.equal(highLoss.k, 48, 'K_loss(1500) = 32 × (1 + 0.5) = 48');
  assert.equal(high.delta, 8);
  assert.equal(highLoss.delta, -24);
  assert.ok(high.delta < Math.abs(highLoss.delta), '高分赢加得少、输扣得多');
});

test('LED-3 解析均衡点 R = cap × (2p − 1)（§8.3 性质 2，未触发 kMin/kMax 裁剪的区间精确）', () => {
  // 均衡：p·K_gain(R) = (1−p)·K_loss(R) → r = 2p − 1（同分对手 E=0.5）
  for (const p of [0.6, 0.7, 0.8]) {
    const r = CFG.rating.cap * (2 * p - 1);
    const gain = ledger.gainFactor(r, CFG);
    const loss = ledger.lossFactor(r, CFG);
    assert.ok(Math.abs(p * gain - (1 - p) * loss) < 0.51,
      `p=${p} 时均衡残差应≈0：p·K_gain=${p * gain}，(1−p)·K_loss=${(1 - p) * loss}`);
  }
  // p=0.9 时解析点 r=0.8 触发 kMin 裁剪（未裁剪值 6.4 < kMin=8）→ 实际均衡点**高于** cap×(2p−1)
  // （净增量为正 → 积分继续上行直至 cap）。文档未声明该裁剪区间，已登记为文档不一致项。
  const r09 = CFG.rating.cap * (2 * 0.9 - 1);
  assert.equal(ledger.gainFactor(r09, CFG), CFG.rating.kMin, '被 kMin 裁剪');
  assert.ok(0.9 * ledger.gainFactor(r09, CFG) > 0.1 * ledger.lossFactor(r09, CFG), '裁剪后净增量为正');
  assert.equal(ledger.gainFactor(0, CFG), 32);
  assert.equal(ledger.gainFactor(3000, CFG), 8, 'cap 时降到 kMin');
  assert.equal(ledger.lossFactor(0, CFG), 32);
  assert.equal(ledger.lossFactor(3000, CFG), 64, 'cap 时升到 kMax');
});

test('LED-4 下限保护与上限：0 分输球仍为 0；cap 赢球不超 cap；平局向期望值靠拢', () => {
  const zero = ledger.ratingDelta({ points: 0, opponentPoints: 0, result: 'loss', config: CFG });
  assert.equal(zero.pointsAfter, 0);
  const capped = ledger.ratingDelta({ points: 3000, opponentPoints: 3000, result: 'win', config: CFG });
  assert.equal(capped.pointsAfter, 3000);
  const strongDraw = ledger.ratingDelta({ points: 2400, opponentPoints: 600, result: 'draw', config: CFG });
  const weakDraw = ledger.ratingDelta({ points: 600, opponentPoints: 2400, result: 'draw', config: CFG });
  assert.ok(strongDraw.delta < 0, '强者平局扣分');
  assert.ok(weakDraw.delta > 0, '弱者平局加分');
  assert.ok(Math.abs(strongDraw.delta) <= 16 && Math.abs(weakDraw.delta) <= 16);
});

test('LED-5 非零和（有意，D-133）：高分输给低分时 Δ 之和 ≠ 0（分数汇）', () => {
  // 0 分同分对局：K_gain = K_loss = kBase → 严格零和
  const even = ledger.settleRating({ p1Points: 0, p2Points: 0, winner: 'p2', config: CFG });
  assert.equal(even.p1.delta, -16);
  assert.equal(even.p2.delta, 16);
  assert.equal(even.zeroSum, true);
  // 非 0 分同分对局即非零和（K_gain(R) < K_loss(R)，同样是"分数汇"的一部分）
  const mid = ledger.settleRating({ p1Points: 100, p2Points: 100, winner: 'p2', config: CFG });
  assert.equal(mid.p1.delta, -17);
  assert.equal(mid.p2.delta, 15);
  assert.equal(mid.zeroSum, false);
  // 高期望方输球 vs 低期望方赢球：加分（低分赢）小于扣分（高分输）→ 系统存在分数汇
  const upset = ledger.settleRating({ p1Points: 2400, p2Points: 600, winner: 'p2', config: CFG });
  assert.equal(upset.p1.result, 'loss');
  assert.equal(upset.p2.result, 'win');
  assert.equal(upset.p1.pointsBefore, 2400);
  assert.equal(upset.p2.pointsBefore, 600);
  assert.ok(upset.p2.delta > 0, '低分方赢球加分');
  assert.ok(upset.p1.delta < 0, '高分方输球扣分');
  assert.notEqual(upset.p1.delta + upset.p2.delta, 0, '系统存在分数汇（抑制通胀，属有意设计）');
  assert.equal(upset.zeroSum, false);
  // 预期内的胜负（高分赢低分）：双方 Δ 都≈0，属设计内的"分数冻结"区
  const expected = ledger.settleRating({ p1Points: 2400, p2Points: 600, winner: 'p1', config: CFG });
  assert.equal(expected.p1.delta, 0);
  assert.equal(expected.p2.delta, 0);
  // 平局
  const draw = ledger.settleRating({ p1Points: 100, p2Points: 100, winner: 'draw', config: CFG });
  assert.equal(draw.p1.result, 'draw');
  assert.equal(draw.p2.result, 'draw');
  assert.equal(draw.p1.delta, 0);
});

test('LED-6 roundHalfUp 与 rounding 配置', () => {
  assert.equal(ledger.roundHalfUp(0.5), 1);
  assert.equal(ledger.roundHalfUp(1.4), 1);
  assert.equal(ledger.roundHalfUp(-0.5), -1);
  assert.equal(ledger.roundHalfUp(-1.6), -2);
  assert.equal(ledger.roundBy(1.5, 'half_up'), 2);
  assert.equal(ledger.roundBy(-0.5, 'other'), -0);
});

test('LED-7 晋升（D-122）：胜 > 6 且非最高段位才晋升；mythic 封顶', () => {
  assert.deepEqual(ledger.promoteAfterBatch({ tier: 'common', wins: 7, config: CFG }),
    { promoted: true, tierBefore: 'common', tierAfter: 'rare', wins: 7, threshold: 6 });
  assert.equal(ledger.promoteAfterBatch({ tier: 'common', wins: 6, config: CFG }).promoted, false);
  assert.equal(ledger.promoteAfterBatch({ tier: 'mythic', wins: 10, config: CFG }).promoted, false);
  assert.equal(ledger.promoteAfterBatch({ tier: 'mythic', wins: 10, config: CFG }).tierAfter, 'mythic');
  assert.equal(ledger.promoteAfterBatch({ tier: 'bogus', wins: 10, config: CFG }).tierBefore, 'common');
});

test('LED-8 battleId 内容寻址：同输入同 id、任一要素变化即不同（§9.1）', () => {
  const base = { batchId: 'bt_1', matchIndex: 3, seed: 11, p1SnapshotHash: 'sha256:aa', p2SnapshotHash: 'sha256:bb' };
  const id = ledger.battleIdOf(base);
  assert.match(id, /^b_[0-9a-f]{16}$/);
  assert.equal(ledger.battleIdOf({ ...base }), id);
  assert.notEqual(ledger.battleIdOf({ ...base, seed: 12 }), id);
  assert.notEqual(ledger.battleIdOf({ ...base, matchIndex: 4 }), id);
  assert.notEqual(ledger.battleIdOf({ ...base, p2SnapshotHash: 'sha256:cc' }), id);
  assert.notEqual(ledger.battleIdOf({}), ledger.battleIdOf({ seed: 1 }));
});

test('LED-9 buildBattleRecord：§6.2 形状（含双方/verdict/versions/replay，不含帧）', () => {
  const rec = ledger.buildBattleRecord({
    mode: 'ranked', batchId: 'bt_9', matchIndex: 2, seed: 42, at: 1000,
    p1: {
      playerId: 'pl_1111111111111111', publicId: 'u_11111111', role: 'attacker', snapshotHash: 'sha256:a1',
      configHash: 'sha256:c1', pointsBefore: 10, pointsAfter: 999, result: 'win', tierBefore: 'rare', tierAfter: 'epic',
    },
    p2: {
      playerId: 'pl_2222222222222222', publicId: 'u_22222222', role: 'defender', snapshotHash: 'sha256:b2',
      configHash: 'sha256:c2', pointsBefore: 20, pointsAfter: 20, result: 'loss', tierBefore: 'epic',
    },
    verdict: { winner: 'p1', reason: 'hero_dead', ticks: 31 },
    versions: { engine: '3.0.0', data: 'b25' },
  });
  assert.equal(rec.type, 'battle.recorded');
  assert.equal(rec.v, 1);
  assert.equal(rec.at, 1000);
  assert.equal(rec.mode, 'ranked');
  assert.equal(rec.batchId, 'bt_9');
  assert.equal(rec.matchIndex, 2);
  assert.equal(rec.p1.side, 'p1');
  assert.equal(rec.p2.side, 'p2');
  assert.equal(rec.p1.role, 'attacker');
  assert.equal(rec.p2.role, 'defender');
  assert.equal(rec.p1.pointsAfter, 999, '构造器不改数值（规范化由 store.settleBattle 负责）');
  assert.equal(rec.verdict.ticks, 31);
  assert.equal(rec.versions.engine, '3.0.0');
  assert.equal(rec.versions.configHashP1, 'sha256:c1');
  assert.deepEqual(rec.replay, { from: '1', to: '31', phase: 'idle' });
  assert.equal(JSON.stringify(rec).includes('"frames"'), false, 'D-135：不存帧');
  // 缺 playerId → bad_request
  assert.throws(() => ledger.buildBattleRecord({ p1: { playerId: 'pl_1' } }), (e) => e.code === 'bad_request');
  // 缺省值：mode 默认 quick、verdict.winner 默认 draw、ticks null
  const minimal = ledger.buildBattleRecord({
    p1: { playerId: 'pl_1111111111111111' }, p2: { playerId: 'pl_2222222222222222' },
  });
  assert.equal(minimal.mode, 'quick');
  assert.equal(minimal.verdict.winner, 'draw');
  assert.equal(minimal.verdict.ticks, null);
  assert.equal(minimal.p1.tierBefore, 'common');
});

test('LED-10 单玩家记录构造器：账号/密码/封禁/昵称/池/配置/批次/晋升/bot', () => {
  const acc = ledger.buildAccountRecord({
    playerId: 'pl_1111111111111111', publicId: 'u_11111111', nickname: 'n', at: 5,
    auth: { algo: 'scrypt', hash: 'h' }, tier: 'rare', points: 120, flags: { unverifiedLoadout: true },
    slot: { slotId: 'slot1', snapshotHash: 'sha256:a' },
  });
  assert.equal(acc.type, 'account.created');
  assert.equal(acc.createdAt, 5);
  assert.equal(acc.tier, 'rare');
  assert.equal(acc.slot.snapshotHash, 'sha256:a');
  assert.equal(ledger.buildAccountRecord({ playerId: 'pl_1', at: 1, tier: 'bogus' }).tier, undefined);
  assert.equal(ledger.buildBotRecord({ playerId: 'pl_1', at: 1, tier: 'epic', points: 300, botKey: 'k' }).type, 'admin.bot.injected');
  assert.equal(ledger.buildBotRecord({ playerId: 'pl_1', at: 1, botKey: 'k' }).nickname, 'bot:k');
  assert.equal(ledger.buildBotRecord({ playerId: 'pl_1', at: 1, flags: { cheatSuspect: true } }).flags.isBot, true);
  assert.equal(ledger.buildPasswordRecord({ playerId: 'pl_1', auth: { hash: 'x' }, at: 1 }).type, 'account.password.changed');
  assert.equal(ledger.buildBanRecord({ playerId: 'pl_1', banned: true, reason: 'cheat', at: 1 }).type, 'account.banned');
  assert.equal(ledger.buildBanRecord({ playerId: 'pl_1', banned: false, at: 1 }).type, 'account.unbanned');
  assert.equal(ledger.buildBanRecord({ playerId: 'pl_1', at: 1 }).reason, null);
  assert.equal(ledger.buildNicknameRecord({ playerId: 'pl_1', nickname: 'x', at: 1 }).nickname, 'x');
  assert.equal(ledger.buildPoolRecord({ playerId: 'pl_1', at: 1 }).inPool, true);
  assert.equal(ledger.buildPoolRecord({ playerId: 'pl_1', inPool: false, at: 1 }).inPool, false);
  const cfg = ledger.buildConfigRecord({ playerId: 'pl_1', slotId: 'slot2', snapshotHash: 'sha256:s', configHash: 'sha256:c', create: true, activate: true, at: 1 });
  assert.equal(cfg.type, 'player.config.saved');
  assert.equal(cfg.create, true);
  assert.equal(cfg.deleted, false);
  assert.equal(ledger.buildBatchRecord({ playerId: 'pl_1', batchId: 'bt', tier: 'rare', seed: 3, opponentCount: 10, at: 1 }).opponentCount, 10);
  const promo = ledger.buildPromoteRecord({ playerId: 'pl_1', batchId: 'bt', tierBefore: 'rare', tierAfter: 'epic', at: 1 });
  assert.equal(promo.type, 'ranked.promoted');
  assert.equal(promo.tierAfter, 'epic');
});

test('LED-11 clamp 边界', () => {
  assert.equal(ledger.clamp(5, 0, 3), 3);
  assert.equal(ledger.clamp(-5, 0, 3), 0);
  assert.equal(ledger.clamp(2, 0, 3), 2);
});
