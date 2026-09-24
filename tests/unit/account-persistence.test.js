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
const authMod = require('../../server/auth.js');
const { openFixture, registerPlayer, sampleLoadout, quickRecord, makeLogger } = require('../helpers/account.js');

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
    assert.equal(fx2.store.maxSeq(), before.seq, 'journal 最大 seq 稳定');
    assert.equal(fx2.store.maxSeq() >= r2.record.seq, true, '两场 battle.recorded 仍在 journal 内');
    // 会话持久化：旧 token 仍有效
    const who = await fx2.auth.authenticate(token);
    assert.equal(who.ok, true, '重启后 token 仍有效');
    assert.equal(who.data.player.playerId, a.playerId);
    assert.equal(fx2.store.sessions.list(a.playerId).length, sessionsBefore, '会话数不变');
    // 用户名索引在冷启动后从磁盘重建 → 登录仍可用
    const relogin = await fx2.auth.login({ username: 'Persist_A', password: a.password });
    assert.equal(relogin.ok, true);
    assert.equal(relogin.data.playerId, a.playerId);
    // 干净关闭后的恢复必须幂等：重放只搬运已记录结果，不改任何档案
    //   （report.replayed 的计数口径由 store 定义——P7-1 已把它改为"实际产生变更的记录数"，
    //    故此处只断言"档案视图逐值不变"，不绑定计数口径）
    const beforeRecover = await snapshotViews(fx2, [a.playerId, b.playerId]);
    const report = await fx2.store.recover();
    assert.equal(report.journalSeq, before.seq);
    assert.equal(report.rebuiltIndex, false, '索引无需重建');
    assert.equal(report.quarantined.length, 0, '无损坏档案');
    assert.deepEqual(await snapshotViews(fx2, [a.playerId, b.playerId]), beforeRecover, '恢复幂等：档案逐值不变');
    // 每个档案的水位：不超过 journal 水位，且至少覆盖自己参与的最后一场（§6.3 单调水位）
    for (const playerId of [a.playerId, b.playerId]) {
      const archive = await fx2.store.loadArchive(playerId);
      assert.ok(archive.record.appliedSeq <= fx2.store.maxSeq(), `${playerId} 水位不超过 journal`);
      assert.ok(archive.record.appliedSeq >= r2.record.seq, `${playerId} 水位覆盖自己参与的最后一场`);
    }
    await fx2.cleanup();
  } finally {
    await fx1.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('PS-2 业务状态变更都在 journal（D-134）；A 类派生标志（未读游标/unverifiedLoadout）不走 journal', async () => {
  const fx = await openFixture({});
  try {
    const a = await registerPlayer(fx.auth, { username: 'Journal_A' });
    const b = await registerPlayer(fx.auth, { username: 'Journal_B' });
    await fx.account.saveConfig({ playerId: a.playerId, slotId: 'slot1', loadout: sampleLoadout(fx.account) });
    // D-159：注册即建满 3 槽 → 再建槽必撞 409 slot_limit（不落 journal 记录）
    const over = await fx.account.createSlot({ playerId: a.playerId });
    assert.equal(over.ok, false);
    assert.equal(over.code, 'slot_limit');
    // D-160：写满 slot2 后才能设为出战；空槽激活 → 409 cannot_activate_incomplete（同样不落记录）
    await fx.account.saveConfig({ playerId: a.playerId, slotId: 'slot2', loadout: sampleLoadout(fx.account) });
    const actEmpty = await fx.account.activateConfig({ playerId: a.playerId, slotId: 'slot3' });
    assert.equal(actEmpty.code, 'cannot_activate_incomplete');
    await fx.account.activateConfig({ playerId: a.playerId, slotId: 'slot2' });
    await fx.account.activateConfig({ playerId: a.playerId, slotId: 'slot1' });
    await fx.account.deleteSlot({ playerId: a.playerId, slotId: 'slot2' });
    await fx.account.setNickname({ playerId: a.playerId, nickname: '改名' });
    await settle(fx, a, b, { seed: 41 });
    const records = fx.store.readRecords({ includeCheckpoints: false });
    const count = (type) => records.filter((r) => r.type === type).length;
    assert.equal(count('account.created'), 2, '注册 2 条');
    // D-159/D-160：注册即 3 槽；本用例的配置类记录 = PUT slot1 + PUT slot2 + activate×2 + DELETE。
    //   （旧口径 5 条含"新建槽复制出战配置"语义，D-160 起新建槽是空槽，且注册已占满 3 槽。）
    //   被拒绝的请求（409 slot_limit / cannot_activate_incomplete）一律不落记录。
    const cfgRecords = records.filter((r) => r.type === 'player.config.saved');
    assert.equal(cfgRecords.length, 5, '保存×2 / 激活×2 / 删除 各 1 条：'
      + JSON.stringify(cfgRecords.map((r) => ({ slotId: r.slotId, create: r.create, activate: r.activate, deleted: r.deleted }))));
    assert.deepEqual(cfgRecords.map((r) => r.slotId), ['slot1', 'slot2', 'slot2', 'slot1', 'slot2']);
    assert.deepEqual(cfgRecords.map((r) => !!r.create), [false, false, false, false, false], '无新建记录（3 槽已满，POST /me/configs 被 409 slot_limit 拦下）');
    assert.deepEqual(cfgRecords.map((r) => !!r.activate), [false, false, true, true, false]);
    assert.deepEqual(cfgRecords.map((r) => !!r.deleted), [false, false, false, false, true]);
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
    // A 类派生写（未读游标 / 仓库镜像校验标志）不新增 journal 记录、不推进 appliedSeq
    const seqBefore = fx.store.maxSeq();
    const appliedBefore = (await fx.store.loadArchive(a.playerId)).record.appliedSeq;
    await fx.account.markSeen({ playerId: a.playerId, uptoSeq: seqBefore });
    const wh = await fx.account.saveWarehouseMirror({ playerId: a.playerId, warehouse: { buckets: { role: [] } } });
    assert.equal(wh.ok, true);
    assert.equal(wh.status, 200, 'D-159：PUT /me/warehouse 退役为只做形状校验（不再 409 loadout_invalid）');
    assert.equal(fx.store.maxSeq(), seqBefore, 'A 类派生写不写 journal');
    assert.equal((await fx.store.loadArchive(a.playerId)).record.appliedSeq, appliedBefore, '水位不推进');
    // D-159：仓库真源在服务端，未通过镜像校验也**不降级**档案标志（注册 starter 即已校验）
    assert.equal((await fx.store.loadArchive(a.playerId)).flags.unverifiedLoadout, false,
      'D-159：服务端权威仓库 → 标志源自真源，不被客户端镜像改写（旧"镜像校验才清标志"已废除）');
    assert.equal(wh.data.unverifiedLoadout, wh.data.verified !== true, '回执字段只描述本次提交的镜像（self-report）');
    assert.equal((await fx.account.getSummary(a.playerId)).data.record.unread.attack, 0, '未读游标同理（派生）');
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

test('PS-5 会话启动清理（§6.7）：过期会话落盘 → 重启 open() 时被 prune 清除', async () => {
  const fx1 = await openFixture({});
  const dir = fx1.dir;
  try {
    const u = await registerPlayer(fx1.auth, { username: 'Prune_1' });
    assert.equal(u.res.ok, true);
    // 写一条已过期会话（同时保留注册会话，证明只清过期的）
    const expiredHash = authMod.tokenHashOf('expired-token-for-prune-test');
    fx1.store.sessions.put({
      tokenHash: expiredHash,
      playerId: u.playerId,
      createdAt: fx1.clock.now() - 10 * 86400000,
      expiresAt: fx1.clock.now() - 86400000,
      lastUsedAt: fx1.clock.now() - 10 * 86400000,
    });
    assert.equal(fx1.store.sessions.size(), 2, '盘上 2 条（1 有效 + 1 过期）');
    const fx2 = await fx1.reopen();
    assert.equal(fx2.store.sessions.size(), 1, 'open() 内 prune 清掉过期会话');
    assert.equal(fx2.store.sessions.peek(expiredHash), null, '过期 token 已不存在');
    assert.equal((await fx2.auth.authenticate(u.token)).ok, true, '有效会话不受影响');
    // 清理结果已落盘（重启后仍为 1 条）
    const fx3 = await fx2.reopen();
    assert.equal(fx3.store.sessions.size(), 1);
    await fx3.cleanup();
  } finally {
    await fx1.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('PS-4 崩溃点补放：档案水位落后于 journal → 重启自动重放修复（不产生单边记账）', async () => {
  const logger = makeLogger();
  const fx1 = await openFixture({ logger, storeLogger: logger });
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
    // 重启 → 恢复流程按 journal 补放（open() 内的 store.open 事件带 replayed 计数）
    const fx2 = await fx1.reopen();
    const opens = logger.records.filter((r) => r.event === 'store.open');
    assert.ok(opens.length >= 2, 'store.open 事件');
    const openReport = opens[opens.length - 1].data;
    assert.ok(openReport.replayed >= 1, `重启时应补放记录（实际 ${openReport.replayed}）`);
    assert.equal(openReport.seq, fx2.store.maxSeq());
    const recovered = await fx2.store.recover();
    assert.equal(recovered.replayed, 0, '补放完成后再恢复无重复 apply');
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
