'use strict';
/* tests/unit/account-persistence.test.js —— 持久化与幂等（P7-2；D-134 / §6.1~§6.4）
 * 覆盖：同一 DL_DATA_DIR 重新装配适配器后状态逐值一致（档案/配置/战绩/未读/会话）·
 *      journal 为唯一真源（水位收敛）· 重复 apply 幂等 · 档案水位落后 → 重启自动补放（不产生单边记账）。
 * 说明：store 的单进程锁按 pid 判活，重开同一目录必须先 close()（夹具 reopen() 已处理）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openFixture, registerPlayer, sampleLoadout, quickRecord } = require('../helpers/account.js');

async function facts(fx, playerId) {
  const archive = await fx.store.loadArchive(playerId);
  const active = archive.configs.slots.find((s) => s.slotId === archive.configs.activeSlotId);
  return { playerId, publicId: archive.publicId, snapshotHash: active.snapshot.hash, configHash: active.snapshot.configHash };
}

async function settle(fx, a, b, overrides) {
  return fx.store.settleBattle(quickRecord(await facts(fx, a.playerId), await facts(fx, b.playerId), overrides));
}

// 收集"全部玩家视图"用于重启前后逐值比较
async function snapshotViews(fx, playerIds) {
  const out = { seq: fx.store.maxSeq(), indexSeq: fx.store.index.seq(), players: {} };
  for (const playerId of playerIds) {
    out.players[playerId] = {
      summary: (await fx.account.getSummary(playerId)).data,
      configs: (await fx.account.listConfigs(playerId)).data,
      records: (await fx.account.records({ playerId, since: 0, limit: 100 })).data,
      defense: (await fx.account.defenseSummary(playerId)).data,
      archive: await fx.store.loadArchive(playerId),
    };
  }
  return out;
}

test('PS-1 重启一致：重新装配适配器后 summary/configs/records/defense/会话逐值一致', async () => {
  const fx1 = await openFixture({});
  const dir = fx1.dir;
  try {
    const a = await registerPlayer(fx1.auth, { username: 'Persist_A', nickname: '持久' });
    const b = await registerPlayer(fx1.auth, { username: 'Persist_B' });
    await fx1.account.saveConfig({ playerId: a.playerId, slotId: 'slot1', loadout: sampleLoadout(fx1.account) });
    await fx1.account.createSlot({ playerId: a.playerId, name: '二号' });
    await fx1.account.activateConfig({ playerId: a.playerId, slotId: 'slot2' });
    const r1 = await settle(fx1, a, b, { seed: 31 });
    const r2 = await settle(fx1, a, b, { seed: 32, winner: 'p2', p1Result: 'loss', p2Result: 'win' });
    await fx1.account.markSeen({ playerId: b.playerId, uptoSeq: r2.record.seq });
    await fx1.account.setNickname({ playerId: b.playerId, nickname: '乙方' });
    const before = await snapshotViews(fx1, [a.playerId, b.playerId]);
    const token = a.token;
    const sessionsBefore = fx1.store.sessions.list(a.playerId).length;
    assert.equal(sessionsBefore, 1);
    assert.ok(fs.existsSync(path.join(dir, 'sessions.json')), '会话表落盘');

    // ---- 重启（同一 DL_DATA_DIR；close 释放单进程锁）----
    const fx2 = await fx1.reopen();
    assert.equal(fx2.dir, dir);
    const after = await snapshotViews(fx2, [a.playerId, b.playerId]);
    assert.deepEqual(after.players, before.players, '档案/配置/战绩/未读/防守视图逐值一致');
    assert.equal(after.seq, before.seq, 'journal 水位不变');
    assert.equal(after.indexSeq, before.indexSeq, '索引水位不变');
    assert.equal(fx2.store.maxSeq(), r2.record.seq, 'journal 最大 seq 稳定');
    // 会话持久化：旧 token 仍有效
    const who = await fx2.auth.authenticate(token);
    assert.equal(who.ok, true, '重启后 token 仍有效');
    assert.equal(who.data.player.playerId, a.playerId);
    assert.equal(fx2.store.sessions.list(a.playerId).length, sessionsBefore, '会话数不变');
    // 用户名索引在冷启动后从磁盘重建 → 登录仍可用
    const relogin = await fx2.auth.login({ username: 'Persist_A', password: a.password });
    assert.equal(relogin.ok, true);
    assert.equal(relogin.data.playerId, a.playerId);
    // 干净关闭 → 恢复报告无重放、无索引重建
    const report = await fx2.store.recover();
    assert.equal(report.replayed, 0, '无多余重放');
    assert.equal(report.rebuiltIndex, false, '索引无需重建');
    assert.equal(report.journalSeq, r2.record.seq);
    // 每个档案的水位都收敛到 journal 最大 seq
    for (const playerId of [a.playerId, b.playerId]) {
      const archive = await fx2.store.loadArchive(playerId);
      assert.equal(archive.record.appliedSeq, fx2.store.maxSeq(), `${playerId} appliedSeq 收敛`);
    }
    await fx2.cleanup();
  } finally {
    await fx1.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('PS-2 journal 记录类型与读写路径：全部状态变更都在 journal 里（D-134，无旁路落盘）', async () => {
  const fx = await openFixture({});
  try {
    const a = await registerPlayer(fx.auth, { username: 'Journal_A' });
    const b = await registerPlayer(fx.auth, { username: 'Journal_B' });
    await fx.account.saveConfig({ playerId: a.playerId, slotId: 'slot1', loadout: sampleLoadout(fx.account) });
    await fx.account.createSlot({ playerId: a.playerId });
    await fx.account.activateConfig({ playerId: a.playerId, slotId: 'slot2' });
    await fx.account.deleteSlot({ playerId: a.playerId, slotId: 'slot2' });
    await fx.account.setNickname({ playerId: a.playerId, nickname: '改名' });
    await settle(fx, a, b, { seed: 41 });
    const records = fx.store.readRecords({ includeCheckpoints: false });
    const count = (type) => records.filter((r) => r.type === type).length;
    assert.equal(count('account.created'), 2, '注册 2 条');
    assert.ok(count('player.config.saved') >= 4, `配置写 ≥4 条（实际 ${count('player.config.saved')}）`);
    assert.equal(count('player.nickname.changed'), 1);
    assert.equal(count('battle.recorded'), 1);
    // seq 严格递增且连续覆盖
    for (let i = 1; i < records.length; i += 1) assert.ok(records[i].seq > records[i - 1].seq, 'seq 单调递增');
    assert.equal(records[records.length - 1].seq, fx.store.maxSeq());
    // 两个玩家的水位都等于 journal 水位
    assert.equal((await fx.store.loadArchive(a.playerId)).record.appliedSeq, fx.store.maxSeq());
    assert.equal((await fx.store.loadArchive(b.playerId)).record.appliedSeq, fx.store.maxSeq());
    // 战绩明细只带引用（不落帧，D-135）
    const battle = records.find((r) => r.type === 'battle.recorded');
    assert.equal(battle.frames, undefined);
    assert.ok(battle.p1.snapshotHash && battle.p2.snapshotHash);
    assert.ok(battle.versions.configHashP1 && battle.versions.configHashP2);
  } finally {
    await fx.cleanup();
  }
});

test('PS-3 重复 apply 幂等：同一 battle 记录再次 apply 不改战绩（D-134/§6.3）', async () => {
  const fx = await openFixture({});
  try {
    const a = await registerPlayer(fx.auth, { username: 'Idem_A' });
    const b = await registerPlayer(fx.auth, { username: 'Idem_B' });
    const settled = await settle(fx, a, b, { seed: 51 });
    const battleId = settled.record.battleId;
    const before = await snapshotViews(fx, [a.playerId, b.playerId]);
    // 1) 直接再 apply 同一记录
    const again = await fx.store.applyRecord(settled.record);
    assert.equal(again.applied, 0, '重复 apply 不产生任何变更');
    // 2) 再走一次 settleBattle（同 seed/双方快照 → 同 battleId → 内容寻址去重）
    const dup = await settle(fx, a, b, { seed: 51 });
    assert.equal(dup.duplicate, true, '同 battleId 不重复写 journal');
    assert.equal(dup.applied, 0);
    const after = await snapshotViews(fx, [a.playerId, b.playerId]);
    assert.deepEqual(after, before, '战绩/未读/积分完全不变');
    const records = fx.store.readRecords({ includeCheckpoints: false }).filter((r) => r.type === 'battle.recorded');
    assert.equal(records.length, 1, 'journal 里只有一场');
    assert.equal(records[0].battleId, battleId);
  } finally {
    await fx.cleanup();
  }
});

test('PS-4 崩溃点补放：档案水位落后于 journal → 重启自动重放修复（不产生单边记账）', async () => {
  const fx1 = await openFixture({});
  const dir = fx1.dir;
  try {
    const a = await registerPlayer(fx1.auth, { username: 'Crash_A' });
    const b = await registerPlayer(fx1.auth, { username: 'Crash_B' });
    const r1 = await settle(fx1, a, b, { seed: 61 });
    const r2 = await settle(fx1, a, b, { seed: 62, winner: 'p2', p1Result: 'loss', p2Result: 'win' });
    const expected = (await fx1.account.defenseSummary({ playerId: b.playerId })).data;
    assert.equal(expected.drawnCount, 2);
    assert.equal(expected.stats.wins, 1);
    // 模拟"journal 已落盘、档案还没 apply"：把防守方水位回退到第一场之后，并抹掉第二场的战绩
    await fx1.store.updateArchive(b.playerId, (archive) => {
      archive.record.appliedSeq = r1.record.seq;
      archive.record.recent = archive.record.recent.filter((e) => e.battleId !== r2.record.battleId);
      archive.record.stats.defense.wins -= 1;
      archive.record.unread.defense -= 1;
      archive.pool.drawnCount -= 1;
      return null;
    });
    const broken = (await fx1.account.defenseSummary({ playerId: b.playerId })).data;
    assert.equal(broken.drawnCount, 1, '模拟出的落后状态确实生效');
    // 重启 → 恢复流程按 journal 补放
    const fx2 = await fx1.reopen();
    const report = await fx2.store.recover();
    assert.ok(report.replayed >= 1, `应补放记录（实际 ${report.replayed}）`);
    const healed = (await fx2.account.defenseSummary({ playerId: b.playerId })).data;
    assert.deepEqual(healed.stats, expected.stats, '防守胜负被 journal 修复');
    assert.equal(healed.drawnCount, expected.drawnCount);
    assert.equal(healed.unread, expected.unread);
    const archiveB = await fx2.store.loadArchive(b.playerId);
    assert.equal(archiveB.record.appliedSeq, fx2.store.maxSeq());
    assert.ok(archiveB.record.recent.some((e) => e.battleId === r2.record.battleId), '缺的战绩条目被补回');
    // 双方水位一致 → 不存在"只有一方记了账"
    const archiveA = await fx2.store.loadArchive(a.playerId);
    assert.equal(archiveA.record.appliedSeq, archiveB.record.appliedSeq);
    await fx2.cleanup();
  } finally {
    await fx1.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
