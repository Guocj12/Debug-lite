'use strict';
/* tests/unit/store-concurrency.test.js —— 并发结算的记账完整性（P7-6 缺陷 A 回归）
 *
 * 缺陷 A（修复前实测）：同一玩家被两条链路并发结算时，`queueFor` 只保证**到达顺序**、不保证 **seq 顺序**，
 *   一条记录形如 [p1,p2]，两条并发结算 A(seq=10, p1=P/p2=Q) 与 B(seq=11, p1=Q/p2=P) 会交错成
 *   "Q 先应用 seq=11 → seq=10 被水位 appliedSeq>=record.seq 判 skipped" ⇒ journal 有、档案没有，
 *   且水位已过高 ⇒ 重放也跳过（永久丢失）。复现数字（26 场 / 6 玩家 / 并发 3）：
 *     ΣΔ(journal)=260 vs ΣΔ(档案)=50（差 210）、缺失记账 9 条、stats.skipped=9。
 * 修复（本文件锁定）：
 *   ① `withSettlementLock(playerIds, fn)` **参与集合锁**：同一玩家串行、不同玩家并行；append 与 apply
 *      都在锁内完成（seq 顺序 = 应用顺序），不再有一条全局结算链（P7-6 修复 2：锁粒度）；
 *   ② 幂等判定降级：水位只做加速，命中水位时用内容级幂等键（archive.isRecordApplied）证明；
 *      证明不了 → **补 apply**（stats.reapplied），绝不因水位前进而丢记录；
 *   ③ recent 按 seq 升序插入（窗口下界可作幂等判据）；
 *   ④ settleBattle 入参深拷贝（不再原地改写调用方对象）；
 *   ⑤ 锁内陈旧读补正（reconcileStaleSettlement，P7-6 修复 1）：调用方在锁外读到的 pointsBefore 已被
 *      并发结算推进时，锁内以当前档案值重算整场结算 → journal ΣΔ === 档案 ΣΔ 且档案 points = journal 末值；
 *   ⑥ `settleBatch(records)` 批量原语：一轮 N 场 = 1 次加锁 + 1 次 appendMany + 每参与玩家档案 1 次落盘。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../server/store/index.js');
const ledger = require('../../server/store/ledger.js');
const archiveMod = require('../../server/store/archive.js');
const { nullLogger } = require('../../shared/log.js');

const VERSIONS = { engine: '3.0.0', data: 'b25' };
const PLAYERS = 6;
const BATTLES = 26;
const CONCURRENCY = 3;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-conc-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function loadout(tag) {
  return { role: { uid: `r_${tag}` }, skills: [{ uid: `s_${tag}` }], ai: { version: 2, tag } };
}

// 建 6 个玩家（同一快照），返回 {store, dir, players}
async function seed(dir) {
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
  await store.open();
  const snap = store.freezeSnapshot(loadout('conc'));
  const slot = { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS };
  const players = [];
  for (let i = 0; i < PLAYERS; i += 1) {
    players.push(await store.createAccount({
      username: `conc_${i}`, nickname: `conc_${i}`, auth: { hash: `h${i}` }, slot,
    }));
  }
  return { store, players, snap };
}

// 并发跑 N 个任务（固定并发度，保证同一玩家会被并发卷入多场）
async function runConcurrent(jobs, worker, concurrency) {
  let cursor = 0;
  const out = [];
  const workers = [];
  for (let w = 0; w < concurrency; w += 1) {
    workers.push((async () => {
      for (;;) {
        const idx = cursor;
        cursor += 1;
        if (idx >= jobs.length) return;
        out[idx] = await worker(jobs[idx], idx);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// 固定配对：同一玩家既当攻方也当守方，并让"两条并发记录角色相反"必然出现
function pairPlan(players) {
  const jobs = [];
  for (let i = 0; i < BATTLES; i += 1) {
    const a = players[i % PLAYERS];
    const b = players[(i * 3 + 1) % PLAYERS] === a ? players[(i + 2) % PLAYERS] : players[(i * 3 + 1) % PLAYERS];
    jobs.push({ p1: a, p2: b, seed: 20260918 + i, winner: i % 3 === 0 ? 'p2' : 'p1' });
  }
  return jobs;
}

function journalBattles(store) {
  return store.readRecords({ includeCheckpoints: false }).filter((r) => r.type === 'battle.recorded');
}

test('CONC-1 无锁并发结算：每场双方记账齐全、recent 无缺失/无重复、零 skipped（缺陷 A 回归）', async () => {
  const dir = mkTmp();
  try {
    const { store, players, snap } = await seed(dir);
    const jobs = pairPlan(players);
    // 每条记录使用**显式 Δ**（不含调用方读改写语义），单测只验证"记录一份不少地落到双方档案"
    await runConcurrent(jobs, (job) => store.settleBattle({
      mode: 'quick', seed: job.seed,
      p1: { playerId: job.p1.playerId, publicId: job.p1.publicId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 14, result: 'win' },
      p2: { playerId: job.p2.playerId, publicId: job.p2.publicId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 0, result: 'loss' },
      verdict: { winner: 'p1', reason: 'hero_dead', ticks: 20 }, versions: VERSIONS,
    }), CONCURRENCY);

    const records = journalBattles(store);
    assert.equal(records.length, BATTLES, 'journal 场次数');
    assert.equal(new Set(records.map((r) => r.battleId)).size, BATTLES, '无重复 battleId');
    const expected = new Map();
    const deltas = new Map();
    for (const rec of records) {
      deltas.set(rec.battleId, rec.p1.pointsAfter - rec.p1.pointsBefore + (rec.p2.pointsAfter - rec.p2.pointsBefore));
      for (const side of ['p1', 'p2']) {
        const pid = rec[side].playerId;
        if (!expected.has(pid)) expected.set(pid, new Set());
        expected.get(pid).add(rec.battleId);
      }
    }
    const stats = store.stats();
    const missing = [];
    for (const p of players) {
      const a = await store.loadArchive(p.playerId);
      const have = a.record.recent.map((e) => e.battleId);
      assert.equal(new Set(have).size, have.length, `${p.playerId} recent 不得有重复 battleId`);
      for (const bid of expected.get(p.playerId) || []) if (!have.includes(bid)) missing.push(`${p.playerId} 缺 ${bid}`);
      // 攻守分桶总数 == 该玩家参与场次
      const total = a.record.stats.attack.wins + a.record.stats.attack.losses + a.record.stats.attack.draws
        + a.record.stats.defense.wins + a.record.stats.defense.losses + a.record.stats.defense.draws;
      assert.equal(total, (expected.get(p.playerId) || new Set()).size, `${p.playerId} 战绩分桶总数应等于参与场次`);
      // recent 必须 seq 递增（窗口下界=幂等判据）
      for (let i = 1; i < a.record.recent.length; i += 1) {
        assert.ok(a.record.recent[i].seq > a.record.recent[i - 1].seq, `${p.playerId} recent 必须 seq 升序`);
      }
    }
    assert.deepEqual(missing, [], '不得有任何一方缺记账（缺陷 A）');
    assert.equal(stats.skipped, 0, '链式结算下不应出现水位跳过');
    assert.equal(stats.reapplied, 0, '正常并发下不应触发补 apply');
    assert.equal(store.index.seq(), store.maxSeq(), '索引水位收敛到 journal');
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('CONC-2 锁内结算（推荐用法）：真 Elo δ 下 ΣΔ(journal) == ΣΔ(档案) 恒等成立', async () => {
  const dir = mkTmp();
  try {
    const { store, players, snap } = await seed(dir);
    const jobs = pairPlan(players);
    // 正确用法：读档案 → 算 δ → settle 全部在 withSettlementLock([参与玩家]) 内（+ settleBattleLocked 避免自锁）
    await runConcurrent(jobs, (job) => store.withSettlementLock([job.p1.playerId, job.p2.playerId], async () => {
      const a = await store.loadArchive(job.p1.playerId);
      const b = await store.loadArchive(job.p2.playerId);
      const settled = ledger.settleRating({
        p1Points: a.rating.points, p2Points: b.rating.points, winner: job.winner, config: store.ratingConfig,
      });
      return store.settleBattleLocked({
        mode: 'quick', seed: job.seed,
        p1: {
          playerId: job.p1.playerId, publicId: job.p1.publicId, role: 'attacker', snapshotHash: snap.hash,
          configHash: snap.configHash, pointsBefore: a.rating.points, pointsAfter: settled.p1.pointsAfter,
          result: settled.p1.result, tierBefore: a.progress.tier, tierAfter: a.progress.tier,
        },
        p2: {
          playerId: job.p2.playerId, publicId: job.p2.publicId, role: 'defender', snapshotHash: snap.hash,
          configHash: snap.configHash, pointsBefore: b.rating.points, pointsAfter: settled.p2.pointsAfter,
          result: settled.p2.result, tierBefore: b.progress.tier, tierAfter: b.progress.tier,
        },
        verdict: { winner: job.winner, reason: 'hero_dead', ticks: 20 }, versions: VERSIONS,
      });
    }), CONCURRENCY);

    const records = journalBattles(store);
    assert.equal(records.length, BATTLES);
    let sumDeltaJournal = 0;
    for (const rec of records) {
      sumDeltaJournal += (rec.p1.pointsAfter - rec.p1.pointsBefore) + (rec.p2.pointsAfter - rec.p2.pointsBefore);
    }
    let sumBefore = 0;
    let sumAfter = 0;
    for (const p of players) {
      const a = await store.loadArchive(p.playerId);
      sumBefore += 0; // 初始积分恒为 0（D-133 从 0 起）
      sumAfter += a.rating.points;
      // 逐玩家恒等：档案积分 = 该玩家全部记录的 δ 之和（δ 链一致时才成立 → 正是"锁内读改写"的意义）
      let mine = 0;
      for (const rec of records) {
        for (const side of ['p1', 'p2']) {
          if (rec[side].playerId === p.playerId) mine += rec[side].pointsAfter - rec[side].pointsBefore;
        }
      }
      assert.equal(a.rating.points, mine, `${p.playerId} 积分应等于其 δ 之和`);
    }
    assert.equal(sumBefore + sumDeltaJournal, sumAfter, `全局恒等：ΣR前(${sumBefore}) + ΣΔ(${sumDeltaJournal}) = ΣR后(${sumAfter})`);
    // 非零和是**有意设计**（D-133 分数汇）：本测试只锁"恒等式成立"，不锁符号（符号取决于对阵分布）
    const stats = store.stats();
    assert.equal(stats.skipped, 0);
    assert.equal(stats.reapplied, 0);
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('CONC-3 水位缺口补 apply：水位被更高 seq 推前也不丢记录（幂等判定降级为加速）', async () => {
  const dir = mkTmp();
  try {
    const { store, players, snap } = await seed(dir);
    const [a, b] = players;
    const mk = (seed) => ({
      mode: 'quick', seed,
      p1: { playerId: a.playerId, publicId: a.publicId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 10, result: 'win' },
      p2: { playerId: b.playerId, publicId: b.publicId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 0, result: 'loss' },
      verdict: { winner: 'p1', ticks: 15 }, versions: VERSIONS,
    });
    const first = await store.settleBattle(mk(1));
    const middle = await store.settleBattle(mk(2));
    const last = await store.settleBattle(mk(3));
    assert.ok(middle.record.seq > first.record.seq && last.record.seq > middle.record.seq);
    // 模拟"缺陷 A 遗留的损坏档案"：水位抬到 last，但抹掉**中间那条**的记账 —— 关键是让缺口落在
    // 环形窗口**之内**（更早的 first 仍在 recent 里 → 窗口下界 < middle.seq），这才是可检测的缺口。
    await store.updateArchive(a.playerId, (archive) => {
      archive.record.appliedSeq = last.record.seq;
      archive.record.recent = archive.record.recent.filter((e) => e.battleId !== middle.record.battleId);
      archive.record.stats.attack.wins -= 1;
      archive.record.unread.attack -= 1;
      return null;
    });
    const tampered = await store.loadArchive(a.playerId);
    assert.equal(tampered.record.recent.length, 2);
    assert.equal(tampered.record.appliedSeq, last.record.seq);
    // 再次 apply 更早的记录 → 内容键证明"未应用" → 补 apply（而不是被水位跳过）
    const again = await store.applyRecord(middle.record);
    assert.equal(again.applied, 1, '应补 apply 到 1 个档案（攻方）');
    const healed = await store.loadArchive(a.playerId);
    assert.equal(healed.record.recent.length, 3);
    assert.ok(healed.record.recent.some((e) => e.battleId === middle.record.battleId));
    assert.equal(healed.record.stats.attack.wins, 3, '战绩补齐');
    assert.equal(healed.record.appliedSeq, last.record.seq, '水位不回退（只前进）');
    assert.equal(store.stats().reapplied, 1, '补 apply 计数可观测');
    // 幂等：再补一次不再变化（内容键已证明应用）
    const third = await store.applyRecord(middle.record);
    assert.equal(third.applied, 0);
    assert.equal((await store.loadArchive(a.playerId)).record.stats.attack.wins, 3);
    // 窗口之外的旧记录：不得重复应用（水位 + 窗口下界共同保护）
    const ancient = { ...first.record, seq: 1, battleId: 'b_ancient' };
    assert.equal((await store.applyRecord(ancient)).applied, 0, '窗口外（seq < 窗口下界）视为早已应用 → 跳过');
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('CONC-4 重复 apply 幂等：战斗与计数器类记录（ranked.batch/promoted）均不重复累计', async () => {
  const dir = mkTmp();
  try {
    const { store, players, snap } = await seed(dir);
    const [a, b] = players;
    const settled = await store.settleBattle({
      mode: 'quick', seed: 5,
      p1: { playerId: a.playerId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 12, result: 'win' },
      p2: { playerId: b.playerId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 0, result: 'loss' },
      verdict: { winner: 'p1', ticks: 10 }, versions: VERSIONS,
    });
    for (let i = 0; i < 10; i += 1) await store.applyRecord(settled.record);
    const a1 = await store.loadArchive(a.playerId);
    assert.equal(a1.rating.games, 1);
    assert.equal(a1.record.recent.length, 1);
    assert.equal(a1.record.stats.attack.wins, 1);
    // 计数器类：ranked.batch / ranked.promoted 重复 apply 不得重复 +1
    const batch = await store.append(ledger.buildBatchRecord({ playerId: a.playerId, batchId: 'bt_c1', tier: 'common', seed: 1, opponentCount: 10 }));
    await store.applyRecord(batch);
    await store.applyRecord(batch);
    await store.applyRecord(batch);
    const promoted = await store.append(ledger.buildPromoteRecord({ playerId: a.playerId, batchId: 'bt_c1', tierBefore: 'common', tierAfter: 'rare' }));
    await store.applyRecord(promoted);
    await store.applyRecord(promoted);
    const a2 = await store.loadArchive(a.playerId);
    assert.equal(a2.progress.batchesPlayed, 1, '批次数不得重复累计');
    assert.equal(a2.progress.batchesPromoted, 1, '晋升次数不得重复累计');
    assert.equal(a2.progress.tier, 'rare');
    assert.equal(a2.progress.lastBatchId, 'bt_c1');
    assert.equal(a2.progress.lastPromotedBatchId, 'bt_c1');
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('CONC-5 settleBattle 不可变：不改入参、返回记录与入参无共享引用（item ④）', async () => {
  const dir = mkTmp();
  try {
    const { store, players, snap } = await seed(dir);
    const [a, b] = players;
    const input = {
      mode: 'ranked', batchId: 'bt_imm', matchIndex: 1, seed: 9,
      p1: { playerId: a.playerId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 50, pointsAfter: 999, result: 'win', tierBefore: 'common', tierAfter: 'epic' },
      p2: { playerId: b.playerId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 50, pointsAfter: 999, result: 'loss', tierBefore: 'common', tierAfter: 'epic' },
      verdict: { winner: 'p1', ticks: 12 }, versions: VERSIONS,
    };
    const before = JSON.parse(JSON.stringify(input));
    const res = await store.settleBattle(input);
    assert.deepEqual(input, before, 'ranked 规范化必须只作用于副本（入参不得被改写）');
    // 排位规范化 = pointsAfter/tierAfter 被压回 before 值（D-132/D-133 双轨：排位不改积分/段位）。
    // 注意（P7-6 修复 1）：本用例的入参 pointsBefore=50 与**锁内当前档案**（新账号 0 分）不一致
    //   → 属"调用方锁外陈旧读"，本层会在锁内用当前档案值补正 pointsBefore（0），故这里断言的是
    //   **规范化不变量**（after === before）而不是字面量 50。字面量路径由 CONC-5b 覆盖。
    assert.equal(res.record.p1.pointsAfter, res.record.p1.pointsBefore, '记录内被规范化为"排位不动积分"');
    assert.equal(res.record.p1.tierAfter, res.record.p1.tierBefore, '记录内被规范化为"排位不动段位"');
    assert.equal(res.record.p2.pointsAfter, res.record.p2.pointsBefore);
    assert.equal(res.record.p1.pointsBefore, 0, '锁内当前档案值（新账号 0 分）覆盖了锁外读到的 50');
    // 返回记录与入参无共享引用
    res.record.p1.result = 'loss';
    res.record.verdict.ticks = 999;
    const archived = await store.loadArchive(a.playerId);
    assert.equal(archived.record.stats.attack.wins, 1, '改写返回值不影响已落盘档案');
    const journalRecord = await store.findBattleRecord(res.record.battleId);
    assert.equal(journalRecord.verdict.ticks, 12, '改写返回值不影响 journal');
    assert.equal(journalRecord.p1.result, 'win');
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('CONC-6 结算与 A 类写并发交织：A 类写不丢、结算不丢（每玩家队列 + 参与集合锁协同）', async () => {
  const dir = mkTmp();
  try {
    const { store, players, snap } = await seed(dir);
    const [a, b] = players;
    const jobs = [];
    for (let i = 0; i < 12; i += 1) {
      jobs.push({ kind: 'battle', seed: 100 + i });
      jobs.push({ kind: 'nickname', name: `nick_${i}` });
    }
    await runConcurrent(jobs, (job) => {
      if (job.kind === 'battle') {
        return store.settleBattle({
          mode: 'quick', seed: job.seed,
          p1: { playerId: a.playerId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 7, result: 'win' },
          p2: { playerId: b.playerId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 0, result: 'loss' },
          verdict: { winner: 'p1', ticks: 8 }, versions: VERSIONS,
        });
      }
      return store.setNickname({ playerId: a.playerId, nickname: job.name });
    }, 4);
    const archiveA = await store.loadArchive(a.playerId);
    const records = journalBattles(store);
    assert.equal(records.length, 12, '结算一条不丢');
    assert.equal(archiveA.record.recent.length, 12, 'recent 完整');
    assert.equal(archiveA.record.stats.attack.wins, 12);
    // A 类写（昵称）最终值 = 最后一条 journal 里的改名记录（且不被结算覆盖）
    const nickRecords = store.readRecords({ includeCheckpoints: false }).filter((r) => r.type === 'player.nickname.changed');
    assert.equal(nickRecords.length, 12, '改名记录一条不丢');
    const lastNick = nickRecords[nickRecords.length - 1].nickname;
    assert.equal(archiveA.nickname, lastNick, 'nickname 应为最后一条改名记录的值');
    assert.equal(store.stats().skipped, 0);
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('CONC-7 archive.isRecordApplied：内容级幂等键逐类型判定（水位降级为加速的依据）', async () => {
  const c = {
    config: require('../../server/store/config.js').DEFAULT_SERVICE_CONFIG,
    now: () => 1, logger: nullLogger, loadSnapshot: async () => null,
  };
  const arch = archiveMod.createArchive({
    playerId: 'pl_1212121212121212', publicId: 'u_12121212', nickname: 'n', at: 1,
    auth: { algo: 'scrypt', hash: 'h' },
    slot: { slotId: 'slot1', snapshot: { hash: `sha256:${'d'.repeat(64)}` } },
  });
  arch.record.recent.push({ battleId: 'b_in', seq: 10, role: 'attacker' });
  // battle：命中 ring / 窗口之外 / 窗口之内的缺口
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'battle.recorded', seq: 10, battleId: 'b_in' }), true);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'battle.recorded', seq: 5, battleId: 'b_old' }), true, '窗口外视为早已应用');
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'battle.recorded', seq: 11, battleId: 'b_gap' }), false, '窗口内查不到 → 未应用');
  // 非战斗类型：按目标字段判定
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'account.created' }), true);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'account.password.changed', auth: { hash: 'h' } }), true);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'account.password.changed', auth: { hash: 'x' } }), false);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'account.banned' }), false);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'account.unbanned' }), true);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'player.nickname.changed', nickname: 'n' }), true);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'player.nickname.changed', nickname: 'z' }), false);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'player.pool.changed', inPool: true }), true);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'player.pool.changed', inPool: false }), false);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'player.config.saved', deleted: true, slotId: 'slotX' }), true);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'ranked.batch', batchId: 'bt' }), false);
  assert.equal(archiveMod.isRecordApplied(arch, { type: 'ranked.promoted', batchId: 'bt' }), false);
  assert.equal(archiveMod.isRecordApplied(null, { type: 'battle.recorded' }), false);
  void c;
});

/* ==========================================================================================
 * P7-6 修复 1/2 的回归用例（CONC-8/9/10）—— 规模下的记账守恒、锁粒度、批量原语
 * 复现数字（修复前，本文件同构场景）：journal ΣΔ ≠ 档案 ΣΔ；档案 points ≠ 该玩家 Σδ。
 * ========================================================================================== */

// 建 n 个玩家（同一快照）
async function seedN(dir, n) {
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: nullLogger });
  await store.open();
  const snap = store.freezeSnapshot(loadout('scale'));
  const slot = { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS };
  const players = [];
  for (let i = 0; i < n; i += 1) {
    players.push(await store.createAccount({ username: `scale_${i}`, nickname: `scale_${i}`, auth: { hash: `h${i}` }, slot }));
  }
  return { store, players, snap };
}

// quickmatch 的真实形状：**锁外**读档案 → 算 Elo δ → settleBattle
async function quickmatchFlow(store, snap, a, b, seed, winner) {
  const mine = await store.loadArchive(a.playerId);
  const foe = await store.loadArchive(b.playerId);
  const elo = ledger.settleRating({
    p1Points: mine.rating.points, p2Points: foe.rating.points, winner, config: store.ratingConfig,
  });
  return store.settleBattle({
    mode: 'quick', seed,
    p1: {
      playerId: a.playerId, publicId: mine.publicId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash,
      pointsBefore: mine.rating.points, pointsAfter: elo.p1.pointsAfter, result: elo.p1.result,
      tierBefore: mine.progress.tier, tierAfter: mine.progress.tier,
    },
    p2: {
      playerId: b.playerId, publicId: foe.publicId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash,
      pointsBefore: foe.rating.points, pointsAfter: elo.p2.pointsAfter, result: elo.p2.result,
      tierBefore: foe.progress.tier, tierAfter: foe.progress.tier,
    },
    verdict: { winner, reason: 'hero_dead', ticks: 20 }, versions: VERSIONS,
  });
}

test('CONC-8 规模下守恒（P7-6 修复 1 回归）：调用方锁外读档案 + 同玩家并发结算 → journal ΣΔ === 档案 ΣΔ 且末值一致', async () => {
  const dir = mkTmp();
  try {
    const PLAYERS = 24;
    const BATTLES = 240;
    const { store, players, snap } = await seedN(dir, PLAYERS);
    const jobs = [];
    for (let i = 0; i < BATTLES; i += 1) {
      // 固定轮转配对：同一玩家会同时作为多条并发链的攻方/守方（规模越大越容易撞上旧档案）
      const a = players[i % PLAYERS];
      let b = players[(i * 5 + 1) % PLAYERS];
      if (b.playerId === a.playerId) b = players[(i + 3) % PLAYERS];
      jobs.push({ a, b, seed: 20260918 + i, winner: i % 4 === 0 ? 'p2' : 'p1' });
    }
    await runConcurrent(jobs, (job) => quickmatchFlow(store, snap, job.a, job.b, job.seed, job.winner), 8);

    const records = journalBattles(store);
    assert.equal(records.length, BATTLES, 'journal 场次数（一条不少）');
    assert.equal(store.stats().skipped, 0, '零水位跳过');
    assert.equal(store.stats().reapplied, 0, '零补 apply（不靠兜底补记）');

    // ① ΣΔ(journal) === ΣΔ(档案)
    let journalDelta = 0;
    const perPlayerDelta = new Map(players.map((p) => [p.playerId, 0]));
    const lastPoints = new Map();
    for (const rec of records) {
      for (const side of ['p1', 'p2']) {
        const part = rec[side];
        const d = part.pointsAfter - part.pointsBefore;
        journalDelta += d;
        if (perPlayerDelta.has(part.playerId)) perPlayerDelta.set(part.playerId, perPlayerDelta.get(part.playerId) + d);
        lastPoints.set(part.playerId, part.pointsAfter);
      }
    }
    let archiveDelta = 0;
    for (const p of players) {
      const archive = await store.loadArchive(p.playerId);
      archiveDelta += archive.rating.points; // 初始积分恒为 0（D-133 从 0 起）
      // ② 档案 points === journal 末值
      assert.equal(archive.rating.points, lastPoints.get(p.playerId), `${p.playerId} 档案 points 应等于 journal 末值`);
      // ③ 档案 points === 该玩家全部 δ 之和
      assert.equal(archive.rating.points, perPlayerDelta.get(p.playerId), `${p.playerId} 档案 points 应等于其 δ 之和`);
      // ④ recent 无缺失
      const have = new Set(archive.record.recent.map((e) => e.battleId));
      for (const rec of records) {
        for (const side of ['p1', 'p2']) {
          if (rec[side].playerId === p.playerId) assert.ok(have.has(rec.battleId), `${p.playerId} recent 缺 ${rec.battleId}`);
        }
      }
    }
    assert.equal(journalDelta, archiveDelta, `journal ΣΔ(${journalDelta}) === 档案 ΣΔ(${archiveDelta})`);
    // 本用例刻意走"锁外读档案"的旧调用形状 → 兜底补正必须被触发过（证明覆盖到了缺陷路径）
    assert.ok(store.stats().reconciled > 0, `应触发锁内陈旧读补正（实际 ${store.stats().reconciled} 次）`);
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('CONC-9 锁粒度（P7-6 修复 2 回归）：同一玩家串行 / 不同玩家并行；settleBatch 一次 append + 每玩家一次落盘', async () => {
  const dir = mkTmp();
  try {
    const { store, players, snap } = await seedN(dir, 12);
    const [a, b] = players;
    // ① 不同玩家可并行：在 A 的锁内仍能取得 B 的锁（若锁仍是"一条全局结算链"，这里会自锁死）
    let innerAcquired = false;
    await store.withSettlementLock([a.playerId], async () => {
      await Promise.race([
        store.withSettlementLock([b.playerId], async () => { innerAcquired = true; }),
        new Promise((resolve) => { setTimeout(resolve, 3000); }),
      ]);
    });
    assert.equal(innerAcquired, true, '不同玩家的锁必须能同时持有（全局单链会自锁死）');

    // ② settleBatch：一次加锁 + 一次 appendMany + 每参与玩家档案一次落盘
    const stamp = (i) => ({
      mode: 'quick', seed: 7000 + i,
      p1: { playerId: a.playerId, publicId: a.publicId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 0, result: 'win' },
      p2: { playerId: players[2 + (i % (players.length - 2))].playerId, publicId: players[2 + (i % (players.length - 2))].publicId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 0, result: 'loss' },
      verdict: { winner: 'p1', ticks: 10 }, versions: VERSIONS,
    });
    const writesBefore = store.stats().writes;
    const seqBefore = store.maxSeq();
    const batch = await store.settleBatch([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(stamp));
    assert.equal(batch.count, 10);
    assert.equal(batch.duplicates, 0);
    assert.equal(batch.records.length, 10);
    assert.equal(store.maxSeq() - seqBefore, 10, '一轮 10 场只走一次 appendMany（seq 连号）');
    // 攻方 A 在 10 场里出现 10 次，但批次内只落盘一次；10 名守方各一次 → 共 11 次档案写
    assert.equal(store.stats().writes - writesBefore, 11, '每参与玩家档案只落盘一次（20 → 11）');
    assert.equal(store.stats().pendingArchives, 0, '批次结束不得残留延迟落盘');
    assert.ok(batch.records.every((r) => Number.isInteger(r.seq)));

    // ③ battleId 去重：同批重发 → 不重复写 journal、不重复记账
    const again = await store.settleBatch([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(stamp));
    assert.equal(again.duplicates, 10);
    assert.equal(again.applied, 0);
    assert.equal(store.maxSeq(), seqBefore + 10, '重复批次不得推进 journal 水位');

    // ④ 退化为单场：settleBatch([input]) 与 settleBattle 等价
    const one = await store.settleBatch([stamp(99)]);
    assert.equal(one.applied, 2, '双方各记一次');
    assert.equal(one.duplicates, 0);
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('CONC-10 ranked 陈旧积分补正（P7-6 修复 1 第二症状）：档案 points 必须等于 journal 末值', async () => {
  const dir = mkTmp();
  try {
    const { store, players, snap } = await seedN(dir, 3);
    const [p, q, r] = players;
    const start = await store.loadArchive(p.playerId); // ranked runFromStore 的锁外读
    const ranked = (i, winner) => ({
      mode: 'ranked', batchId: 'bt_stale', matchIndex: i, seed: 800 + i,
      p1: {
        playerId: p.playerId, publicId: start.publicId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash,
        pointsBefore: start.rating.points, pointsAfter: start.rating.points, result: winner, tierBefore: 'common', tierAfter: 'common',
      },
      p2: {
        playerId: q.playerId, publicId: q.publicId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash,
        pointsBefore: 0, pointsAfter: 0, result: winner === 'win' ? 'loss' : 'win', tierBefore: 'common', tierAfter: 'common',
      },
      verdict: { winner: winner === 'win' ? 'p1' : 'p2', reason: 'hero_dead', ticks: 20 }, versions: VERSIONS,
    });
    await store.settleBattle(ranked(1, 'win'));            // ranked 第 1 场：P 积分不变
    await quickmatchFlow(store, snap, r, p, 888, 'p2');    // 并发链路：R 打 P → P 被扣分
    const pAfterQuick = (await store.loadArchive(p.playerId)).rating.points;
    assert.ok(pAfterQuick > 0, '前置：P 必须因快速对战改变积分');
    await store.settleBattle(ranked(2, 'loss'));           // ranked 第 2 场仍带锁外读到的旧 points

    const records = journalBattles(store);
    let last = null;
    for (const rec of records) {
      for (const side of ['p1', 'p2']) if (rec[side].playerId === p.playerId) last = rec[side].pointsAfter;
    }
    const archive = await store.loadArchive(p.playerId);
    assert.equal(archive.rating.points, last, '档案 points 必须等于 journal 中该玩家最后一条的 pointsAfter');
    const rankedRecs = records.filter((rec) => rec.mode === 'ranked' && rec.p1.playerId === p.playerId);
    assert.equal(rankedRecs.length, 2);
    for (const rec of rankedRecs) {
      assert.equal(rec.p1.pointsAfter, rec.p1.pointsBefore, '排位记录仍满足"积分不变"双轨不变量');
    }
    assert.equal(rankedRecs[1].p1.pointsBefore, pAfterQuick, 'ranked 记录补正为锁内当前档案值');
    await store.close();
  } finally {
    rmTmp(dir);
  }
});
