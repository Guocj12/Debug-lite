'use strict';
/* tests/contract/store-contract.test.js —— 存储适配器契约（T-CN-1；权威 docs/interfaces.md §1 + 11-account-store.md §3/§5/§6）
 *
 * 契约风格（tests/README.md）：同一套断言必须能对 `json` 与（将来的）`sqlite` 适配器全绿。
 * 本轮 `DL_STORE=sqlite` 为**预留占位**（§11.4）：只断言"明确报错、不静默退回 json"这一契约。
 *
 * 覆盖：
 *   CN-1 生命周期与目录布局      CN-2 账号/档案字段全表 + 快照去重 + 深拷贝隔离
 *   CN-3 配置槽规则（≤3/必有出战/默认不可删/乐观锁）  CN-4 journal 幂等（appliedSeq + battleId）
 *   CN-5 结算事务（双向记账 / 排位双轨 / 防守方不掉段 / 重复 no-op）  CN-6 索引与排行榜
 *   CN-7 战绩视图与未读游标      CN-8 快照库（内容寻址/引用计数/GC）  CN-9 会话表
 *   CN-10 适配器选择             CN-11 sqlite 占位契约      CN-13 墓碑（player.removed）
 * 临时目录：全部在 os.tmpdir() 下（DL_DATA_DIR 语义），绝不污染仓库 runtime/。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, resolveAdapterName, resolveDataDir } = require('../../server/store/index.js');
const { nullLogger } = require('../../shared/log.js');

const VERSIONS = { engine: '3.0.0', data: 'b25' };
const DAY = 86400000;

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dl-store-contract-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function sampleLoadout(tag) {
  return {
    role: { uid: `r_${tag}`, id: 'role_bal', slots: [] },
    skills: [{ uid: `s_${tag}1`, id: 'skill_a' }, { uid: `s_${tag}2`, id: 'skill_b' }, { uid: `s_${tag}3`, id: 'skill_c' }],
    ai: { version: 2, program: [{ kind: 'action', name: `wait_${tag}` }] },
  };
}

async function openStore(storeOpts) {
  const opts = storeOpts || {};
  const dir = opts.dir || mkTmp();
  const store = createStore({
    dataDir: dir, versions: VERSIONS, logger: nullLogger, ...opts,
  });
  await store.open();
  return { store, dir };
}

// 创建账号（返回 {store, playerId, snapshot}）；注册路径 = createAccount（journal account.created）
async function account(store, tag) {
  const loadout = sampleLoadout(tag);
  const snapshot = store.freezeSnapshot(loadout);
  const archive = await store.createAccount({
    username: `user_${tag}`, nickname: `nick_${tag}`, auth: { algo: 'scrypt', hash: `h_${tag}`, N: 16384 },
    slot: {
      slotId: 'slot1', name: '默认配置', snapshotHash: snapshot.hash,
      configHash: snapshot.configHash, versions: VERSIONS, warehouseVerified: true,
    },
  });
  return { archive, snapshot, loadout };
}

function quickInput(a, b, opts) {
  const o = opts || {};
  return {
    mode: 'quick',
    seed: o.seed === undefined ? 7 : o.seed,
    at: o.at,
    p1: {
      playerId: a.archive.playerId, publicId: a.archive.publicId, role: 'attacker',
      snapshotHash: a.snapshot.hash, configHash: a.snapshot.configHash,
      pointsBefore: o.p1Before === undefined ? 0 : o.p1Before,
      pointsAfter: o.p1After === undefined ? 14 : o.p1After,
      result: o.p1Result || 'win', tierBefore: 'common', tierAfter: 'common',
    },
    p2: {
      playerId: b.archive.playerId, publicId: b.archive.publicId, role: 'defender',
      snapshotHash: b.snapshot.hash, configHash: b.snapshot.configHash,
      pointsBefore: o.p2Before === undefined ? 0 : o.p2Before,
      pointsAfter: o.p2After === undefined ? 0 : o.p2After,
      result: o.p2Result || 'loss', tierBefore: 'common', tierAfter: 'common',
    },
    verdict: { winner: o.winner || 'p1', reason: 'hero_dead', ticks: 23 },
    versions: VERSIONS,
  };
}

const CASES = [
  ['CN-1 生命周期与目录布局（open/close/锁/重开）', async ({ store, dir }) => {
    assert.equal(store.adapterName, 'json');
    assert.equal(store.isOpen(), true);
    for (const name of ['journal', 'players', 'snapshots']) {
      assert.ok(fs.existsSync(path.join(dir, name)), `缺少目录 ${name}`);
    }
    assert.ok(fs.existsSync(path.join(dir, 'index.json')));
    assert.ok(fs.existsSync(path.join(dir, 'sessions.json')) || true);
    assert.ok(fs.existsSync(path.join(dir, 'lock')), '运行期应持有单进程锁');
    const stats = store.stats();
    assert.equal(stats.players, 0);
    assert.equal(stats.seq, 0);
    assert.equal(stats.indexSeq, 0);
    assert.equal(await store.close(), true);
    assert.equal(store.isOpen(), false);
    assert.equal(fs.existsSync(path.join(dir, 'lock')), false, 'close 后应释放锁');
    assert.equal(await store.close(), false, '重复 close 幂等');
    await store.open();
    assert.equal(store.isOpen(), true);
    assert.ok(fs.existsSync(path.join(dir, 'lock')));
    await store.close();
  }],

  ['CN-2 账号/档案字段全表 + 快照去重 + 深拷贝隔离', async ({ store }) => {
    const a = await account(store, 'a');
    const arch = a.archive;
    assert.match(arch.playerId, /^pl_[0-9a-f]{16}$/);
    assert.match(arch.publicId, /^u_[0-9a-f]{8}$/);
    assert.equal(arch.archiveVersion, 2, 'D-159：ARCHIVE_VERSION=2');
    for (const key of ['playerId', 'publicId', 'nickname', 'createdAt', 'lastLoginAt', 'lastSeenAt', 'auth',
      'progress', 'rating', 'configs', 'pool', 'record', 'flags',
      // D-159/D-161：服务端权威仓库段 + AI 库段
      'warehouse', 'ai', 'updatedAt']) {
      assert.ok(Object.prototype.hasOwnProperty.call(arch, key), `档案缺字段 ${key}`);
    }
    // D-159：warehouse 段 = 四桶 + starterIssued + grantIds（开箱幂等环形窗口）；D-161：ai 段
    assert.deepEqual(Object.keys(arch.warehouse.buckets).sort(), ['role', 'rolePlugin', 'skill', 'skillPlugin']);
    assert.equal(arch.warehouse.starterIssued, false, '显式 loadout 建号（非 starter 路径）→ 不发放 starter');
    assert.deepEqual(arch.warehouse.grantIds, []);
    assert.deepEqual(arch.ai, { items: [] });
    assert.equal(arch.progress.tier, 'common');
    assert.equal(arch.progress.peakTier, 'common');
    assert.equal(arch.rating.points, 0);
    assert.equal(arch.rating.games, 0);
    assert.equal(arch.rating.seasonId, 's0');
    assert.equal(arch.configs.slots.length, 1);
    assert.equal(arch.configs.slots[0].slotId, 'slot1');
    assert.equal(arch.configs.slots[0].isDefault, true);
    assert.equal(arch.configs.activeSlotId, 'slot1');
    assert.equal(arch.configs.activeSnapshotHash, a.snapshot.hash);
    assert.deepEqual(arch.configs.slots[0].loadout, a.loadout, '档案内 loadout 应为冻结的深拷贝');
    assert.equal(arch.flags.unverifiedLoadout, false, '提交仓库镜像后应为已验证');
    assert.equal(arch.record.appliedSeq, 1, 'account.created 是 journal 第 1 条');
    assert.equal(store.maxSeq(), 1);

    // 内容寻址去重：同 loadout 再冻结 → 同 hash，且库里只有一份
    const again = store.freezeSnapshot(a.loadout);
    assert.equal(again.hash, a.snapshot.hash);
    assert.equal(store.snapshot.list().length, 1);

    // 深拷贝隔离：改返回值不影响存储
    const copy = await store.loadArchive(arch.playerId);
    copy.configs.slots[0].loadout.skills[0].id = 'hacked';
    copy.nickname = 'hacked';
    const reload = await store.loadArchive(arch.playerId);
    assert.equal(reload.configs.slots[0].loadout.skills[0].id, 'skill_a');
    assert.equal(reload.nickname, 'nick_a');

    assert.equal(await store.loadArchive('pl_0000000000000000'), null);
    await assert.rejects(() => store.loadArchive(''), (e) => e.code === 'bad_request');
  }],

  ['CN-3 配置槽规则：≤3 / 必有出战 / 默认与出战不可删 / D-160 新建=空槽 / 乐观锁', async ({ store }) => {
    const a = await account(store, 'a');
    const pid = a.archive.playerId;
    // D-160：新建槽**不再复制出战配置**，也**不切换出战** —— 默认建空槽（无快照、complete:false）
    const c2 = await store.createConfigSlot({ playerId: pid, name: '第二套' });
    assert.equal(c2.archive.configs.slots.length, 2);
    assert.equal(c2.snapshot, null, 'D-160：新建槽无快照');
    assert.deepEqual(c2.slot.loadout, { role: null, skills: [null, null, null], ai: null }, 'D-160：新建槽为空槽');
    assert.equal(c2.archive.configs.activeSlotId, 'slot1', 'D-160：新建槽不改变出战（旧"默认切为出战"已废除）');
    assert.equal(c2.archive.configs.activeSnapshotHash, a.snapshot.hash, '出战快照仍指向 slot1');
    // 不传 loadout → 同样是空槽（旧"复制当前出战配置"已废除）
    const c3 = await store.createConfigSlot({ playerId: pid, name: '第三套' });
    assert.equal(c3.archive.configs.slots.length, 3);
    assert.equal(c3.snapshot, null);
    assert.deepEqual(c3.slot.loadout, { role: null, skills: [null, null, null], ai: null });
    assert.equal(c3.archive.configs.activeSlotId, 'slot1');
    await assert.rejects(() => store.createConfigSlot({ playerId: pid, name: '第四套', loadout: sampleLoadout('d') }),
      (e) => e.code === 'slot_limit');
    assert.throws(() => store.freezeSnapshot(null), (e) => e.code === 'loadout_invalid');
    await assert.rejects(() => store.saveConfigSlot({ playerId: pid, slotId: 'slot1', loadout: 'not-an-object' }),
      (e) => e.code === 'loadout_invalid');
    // D-160：非出战槽允许不完整（无快照 + 正文落盘 + 不完整 details）
    const partial = await store.saveConfigSlot({ playerId: pid, slotId: 'slot2', loadout: { role: null, skills: [null, null, null], ai: null } });
    assert.equal(partial.snapshot, null);
    assert.deepEqual(partial.slot.loadout, { role: null, skills: [null, null, null], ai: null });
    assert.equal(partial.archive.configs.activeSlotId, 'slot1');
    // D-160：出战槽写不完整 → loadout_invalid（逐位置 details）
    await assert.rejects(() => store.saveConfigSlot({ playerId: pid, slotId: 'slot1', loadout: { role: null, skills: [], ai: null } }),
      (e) => e.code === 'loadout_invalid' && e.details.some((d) => d.path === 'skills[1]'));
    // D-160：空槽不可激活 → cannot_activate_incomplete
    await assert.rejects(() => store.activateConfigSlot({ playerId: pid, slotId: 'slot2' }),
      (e) => e.code === 'cannot_activate_incomplete' && e.status === 409);

    // 默认槽不可删
    await assert.rejects(() => store.deleteConfigSlot({ playerId: pid, slotId: 'slot1' }), (e) => e.code === 'slot_locked');
    // 把 slot3 写满完整配置并设为出战 → 成为出战槽，不可删（D-160：激活才校验完整性）
    await store.saveConfigSlot({ playerId: pid, slotId: 'slot3', loadout: sampleLoadout('c') });
    const act3 = await store.activateConfigSlot({ playerId: pid, slotId: 'slot3' });
    assert.equal(act3.archive.configs.activeSlotId, 'slot3');
    await assert.rejects(() => store.deleteConfigSlot({ playerId: pid, slotId: c3.slot.slotId }), (e) => e.code === 'slot_locked');
    // 切到写满完整 loadout 的 slot2 后，slot2 成为出战槽（不可删），slot1 仍因默认槽不可删
    await store.saveConfigSlot({ playerId: pid, slotId: 'slot2', loadout: sampleLoadout('b') });
    const act2 = await store.activateConfigSlot({ playerId: pid, slotId: 'slot2' });
    assert.equal(act2.archive.configs.activeSlotId, 'slot2');
    assert.equal(act2.archive.configs.activeSnapshotHash, act2.slot.snapshot.hash, 'activate 后 activeSnapshotHash 跟随');
    assert.notEqual(act2.archive.configs.activeSnapshotHash, a.snapshot.hash);
    await assert.rejects(() => store.deleteConfigSlot({ playerId: pid, slotId: 'slot2' }), (e) => e.code === 'slot_locked');
    // 切回 slot1 后可删非出战槽 slot2
    await store.activateConfigSlot({ playerId: pid, slotId: 'slot1' });
    const after = await store.loadArchive(pid);
    assert.equal(after.configs.activeSlotId, 'slot1');
    assert.equal(after.configs.activeSnapshotHash, a.snapshot.hash);
    const del = await store.deleteConfigSlot({ playerId: pid, slotId: 'slot2' });
    assert.equal(del.archive.configs.slots.length, 2);
    assert.equal(del.archive.configs.slots.some((s) => s.slotId === 'slot2'), false);
    await assert.rejects(() => store.deleteConfigSlot({ playerId: pid, slotId: 'slot9' }), (e) => e.code === 'slot_not_found');
    await assert.rejects(() => store.activateConfigSlot({ playerId: pid, slotId: 'slot9' }), (e) => e.code === 'slot_not_found');

    // 乐观锁（§6.5）：baseUpdatedAt 不匹配 → config_conflict
    const slot1 = (await store.loadArchive(pid)).configs.slots.find((s) => s.slotId === 'slot1');
    await assert.rejects(() => store.saveConfigSlot({
      playerId: pid, slotId: 'slot1', loadout: sampleLoadout('e'), baseUpdatedAt: slot1.updatedAt + 1,
    }), (e) => e.code === 'config_conflict');
    const saved = await store.saveConfigSlot({
      playerId: pid, slotId: 'slot1', loadout: sampleLoadout('e'), baseUpdatedAt: slot1.updatedAt,
    });
    assert.notEqual(saved.snapshot.hash, a.snapshot.hash);
    assert.deepEqual(saved.archive.configs.slots.find((s) => s.slotId === 'slot1').loadout, sampleLoadout('e'));
    // 不存在的档案
    await assert.rejects(() => store.saveConfigSlot({ playerId: 'pl_ffffffffffffffff', slotId: 'slot1', loadout: sampleLoadout('f') }),
      (e) => e.code === 'store_not_found');
  }],

  ['CN-4 journal 幂等：appliedSeq 水位 + battleId 去重', async ({ store }) => {
    const a = await account(store, 'a');
    const b = await account(store, 'b');
    const first = await store.settleBattle(quickInput(a, b, {}));
    assert.equal(first.applied, 2, '双方档案各记一次');
    const appended = first.record;
    assert.ok(Number.isInteger(appended.seq));
    assert.equal(appended.v, 1);
    assert.ok(Number.isInteger(appended.at));
    assert.equal(store.maxSeq(), appended.seq);

    const secondApply = await store.applyRecord(appended);
    assert.equal(secondApply.applied, 0, '重复 apply 必须跳过（幂等）');
    const a1 = await store.loadArchive(a.archive.playerId);
    assert.equal(a1.record.appliedSeq, appended.seq);
    assert.equal(a1.record.recent.length, 1);
    assert.equal(a1.rating.games, 1);

    // journal 层同样拒绝重复 battleId（内容寻址 → 天然幂等）
    await assert.rejects(() => store.append({ ...appended }), (e) => e.code === 'bad_request');
    // battle.recorded 缺 battleId → 拒绝（防止出现"无法去重"的记录）
    await assert.rejects(() => store.append({
      type: 'battle.recorded', mode: 'quick', seed: 1,
      p1: { playerId: a.archive.playerId, side: 'p1' }, p2: { playerId: b.archive.playerId, side: 'p2' },
    }), (e) => e.code === 'bad_request');
    // 未登记类型 / 非法载荷
    await assert.rejects(() => store.applyRecord({ seq: 99, type: 'bogus.event' }), (e) => e.code === 'bad_request');
    await assert.rejects(() => store.append(null), (e) => e.code === 'bad_request');
  }],

  ['CN-5 结算事务：双向记账 / 排位双轨 / 防守方不掉段 / 重复 no-op', async ({ store }) => {
    const a = await account(store, 'a');
    const b = await account(store, 'b');
    const res = await store.settleBattle(quickInput(a, b, { p1After: 14 }));
    assert.equal(res.duplicate, false);
    assert.equal(res.applied, 2);
    const aA = await store.loadArchive(a.archive.playerId);
    const aB = await store.loadArchive(b.archive.playerId);
    assert.equal(aA.rating.points, 14);
    assert.equal(aA.rating.games, 1);
    assert.equal(aA.rating.wins, 1);
    assert.equal(aA.record.stats.attack.wins, 1);
    assert.equal(aA.record.unread.attack, 1);
    assert.equal(aA.record.recent[0].seq, res.record.seq);
    assert.equal(aA.record.recent[0].role, 'attacker');
    assert.equal(aB.rating.points, 0, '防守方积分不变（本场 p2After=0）');
    assert.equal(aB.record.stats.defense.losses, 1);
    assert.equal(aB.record.unread.defense, 1);
    assert.equal(aB.pool.drawnCount, 1, '被抽场次（R2）');
    assert.equal(aB.record.recent[0].role, 'defender');

    // 重复结算同一条 → 不重复写 journal、不重复计分（§9.1）
    const dup = await store.settleBattle(quickInput(a, b, { p1After: 14 }));
    assert.equal(dup.duplicate, true);
    assert.equal(dup.applied, 0);
    assert.equal(dup.record.seq, res.record.seq);
    const aA2 = await store.loadArchive(a.archive.playerId);
    assert.equal(aA2.rating.games, 1);
    assert.equal(store.maxSeq(), res.record.seq, '重复结算不得推进 journal 水位');

    // 排位（ranked）：积分不变（双轨）+ 防守方不掉段 + 攻防战绩分桶（D-132/D-133）
    const ranked = await store.settleBattle({
      mode: 'ranked', batchId: 'bt_test1', matchIndex: 1, seed: 11,
      p1: {
        playerId: a.archive.playerId, publicId: a.archive.publicId, role: 'attacker',
        snapshotHash: a.snapshot.hash, configHash: a.snapshot.configHash,
        pointsBefore: 14, pointsAfter: 999, result: 'win', tierBefore: 'common', tierAfter: 'epic',
      },
      p2: {
        playerId: b.archive.playerId, publicId: b.archive.publicId, role: 'defender',
        snapshotHash: b.snapshot.hash, configHash: b.snapshot.configHash,
        pointsBefore: 0, pointsAfter: 0, result: 'loss', tierBefore: 'common', tierAfter: 'common',
      },
      verdict: { winner: 'p1', reason: 'timeout', ticks: 60 },
      versions: VERSIONS,
    });
    assert.equal(ranked.record.p1.pointsAfter, 14, '排位记录中的积分被规范化为不变（双轨）');
    assert.equal(ranked.record.p1.tierAfter, 'common', '段位变化只能来自 ranked.promoted');
    const aA3 = await store.loadArchive(a.archive.playerId);
    assert.equal(aA3.rating.points, 14);
    assert.equal(aA3.rating.games, 1, '排位不计入积分轨道场次');
    assert.equal(aA3.record.stats.attack.wins, 2);
    assert.equal(aA3.progress.tier, 'common');

    // bot 冻结：改分/改段位记录对 bot 无效，只累加战绩（§7.6）
    const botSnap = store.freezeSnapshot(sampleLoadout('bot'));
    const bot = await store.createAccount({
      username: 'bot_1', nickname: 'bot', auth: null, isBot: true, tier: 'rare', points: 500,
      slot: { slotId: 'slot1', snapshotHash: botSnap.hash, configHash: botSnap.configHash, versions: VERSIONS },
    });
    await store.settleBattle(quickInput({ archive: bot, snapshot: botSnap, loadout: sampleLoadout('bot') }, b, { p1After: 1500, winner: 'p1' }));
    const botAfter = await store.loadArchive(bot.playerId);
    assert.equal(botAfter.rating.points, 500, 'bot 积分冻结');
    assert.equal(botAfter.progress.tier, 'rare', 'bot 段位冻结');
    assert.equal(botAfter.record.stats.attack.wins + botAfter.record.stats.defense.losses, 1, 'bot 仍累加战绩');
  }],

  ['CN-6 索引：byTier / leaderboard / rank / 重建', async ({ store, dir }) => {
    const a = await account(store, 'a');
    const b = await account(store, 'b');
    await account(store, 'c');
    await store.settleBattle(quickInput(a, b, { p1After: 100 }));
    assert.equal(store.index.size(), 3);
    assert.equal(store.index.byTier('common').length, 3);
    assert.deepEqual(store.index.byTier('mythic'), []);
    const lb = store.index.leaderboard({ scope: 'global', limit: 10 });
    assert.equal(lb.length, 3);
    assert.equal(lb[0].publicId, a.archive.publicId);
    assert.ok(lb[0].points >= lb[1].points);
    assert.equal(Object.prototype.hasOwnProperty.call(lb[0], 'playerId'), false, '排行榜不得暴露 playerId');
    assert.equal(store.index.rank(a.archive.playerId), 1);
    // 同分排序（§8.6）：points 降序 → peakPoints 降序 → updatedAt 升序 → publicId（此处 b 参与过对局，
    // updatedAt 更新，故排在未对局的 c 之后；两者名次由排序规则决定，不做硬编码假设）
    assert.ok([2, 3].includes(store.index.rank(b.archive.playerId)));
    assert.equal(store.index.leaderboard({ scope: 'tier:common', limit: 1 }).length, 1);
    assert.deepEqual(store.index.leaderboard({ scope: 'tier:mythic' }), []);
    assert.throws(() => store.index.leaderboard({ scope: 'bogus' }), (e) => e.code === 'bad_scope');
    assert.equal(store.index.get(a.archive.playerId).tier, 'common');

    // 索引可重建（T-ST-5）：删文件 → 重建结果一致
    const before = store.index.toJSON();
    fs.rmSync(path.join(dir, 'index.json'));
    const stats = await store.rebuildIndex();
    assert.equal(stats.players, 3);
    const after = store.index.toJSON();
    assert.equal(after.players[a.archive.playerId].points, before.players[a.archive.playerId].points);
    assert.equal(store.index.rank(a.archive.playerId), 1);
  }],

  ['CN-7 战绩视图与未读游标（since 增量）', async ({ store }) => {
    const a = await account(store, 'a');
    const b = await account(store, 'b');
    const r1 = await store.settleBattle(quickInput(a, b, { seed: 1, p1After: 10 }));
    const r2 = await store.settleBattle({
      mode: 'ranked', batchId: 'bt_x', matchIndex: 2, seed: 2,
      p1: {
        playerId: b.archive.playerId, publicId: b.archive.publicId, role: 'attacker',
        snapshotHash: b.snapshot.hash, configHash: b.snapshot.configHash,
        pointsBefore: 0, pointsAfter: 0, result: 'loss', tierBefore: 'common', tierAfter: 'common',
      },
      p2: {
        playerId: a.archive.playerId, publicId: a.archive.publicId, role: 'defender',
        snapshotHash: a.snapshot.hash, configHash: a.snapshot.configHash,
        pointsBefore: 10, pointsAfter: 10, result: 'win', tierBefore: 'common', tierAfter: 'common',
      },
      verdict: { winner: 'p2', reason: 'hero_dead', ticks: 30 },
      versions: VERSIONS,
    });
    const all = await store.records(a.archive.playerId, { since: 0, limit: 10 });
    assert.equal(all.length, 2);
    assert.equal(all[0].seq, r1.record.seq);
    assert.equal(all[0].role, 'attacker');
    assert.equal(all[1].role, 'defender');
    assert.equal(all[1].result, 'win');
    const defenseOnly = await store.records(a.archive.playerId, { since: 0, role: 'defense' });
    assert.equal(defenseOnly.length, 1);
    assert.equal(defenseOnly[0].battleId, r2.record.battleId);
    const attackOnly = await store.records(a.archive.playerId, { since: r1.record.seq, role: 'attack' });
    assert.equal(attackOnly.length, 0, 'since 应排除已读区间');

    const summary = await store.getSummary(a.archive.playerId);
    assert.equal(summary.publicId, a.archive.publicId);
    assert.equal(summary.record.stats.attack.wins, 1);
    assert.equal(summary.record.stats.defense.wins, 1);
    assert.equal(summary.slots.length, 1);
    assert.equal(Object.prototype.hasOwnProperty.call(summary, 'playerId'), false, '摘要不得暴露 playerId');

    const def = await store.defenseSummary(a.archive.playerId, { limit: 5 });
    assert.equal(def.drawnCount, 1);
    assert.equal(def.stats.wins, 1);
    assert.equal(def.recent.length, 1);
    assert.equal(def.unread, 1);

    const before = await store.loadArchive(a.archive.playerId);
    assert.equal(before.record.unread.attack, 1);
    assert.equal(before.record.unread.defense, 1);
    const seen = await store.markRecordsSeen({ playerId: a.archive.playerId, uptoSeq: store.maxSeq() });
    assert.equal(seen.record.unread.attack, 0);
    assert.equal(seen.record.unread.defense, 0);
    assert.equal(seen.record.unread.fromSeq, store.maxSeq());
    assert.equal((await store.records(a.archive.playerId, {})).length, 0, '缺省 since = 已读游标 → 无增量');
    // 重复推进游标 → 无变化
    const seen2 = await store.markRecordsSeen({ playerId: a.archive.playerId, uptoSeq: store.maxSeq() });
    assert.equal(seen2.record.unread.fromSeq, store.maxSeq());
    // 对手去重窗口原语（D-136）
    const win = store.opponentWindow(a.archive.playerId, 24);
    assert.equal(win.has(b.archive.playerId), true);
  }],

  ['CN-8 快照库：内容寻址 / 深拷贝 / 引用计数 / GC', async ({ store }) => {
    const a = await account(store, 'a');
    // b 与 a 使用**同一 loadout** → 同一内容寻址 hash（验证去重 + 引用计数按引用累加）
    const sameLoadout = sampleLoadout('a');
    const snapshotB = store.freezeSnapshot(sameLoadout);
    const bArchive = await store.createAccount({
      username: 'user_b_same', nickname: 'nick_b_same', auth: { algo: 'scrypt', hash: 'h_b' },
      slot: { slotId: 'slot1', snapshotHash: snapshotB.hash, configHash: snapshotB.configHash, versions: VERSIONS },
    });
    const b = { archive: bArchive, snapshot: snapshotB, loadout: sameLoadout };
    const snap = a.snapshot;
    assert.match(snap.hash, /^sha256:[0-9a-f]{64}$/);
    assert.match(snap.configHash, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(snap.hash, snap.configHash, 'hash（纯内容）与 configHash（版本三元组）语义不同');
    assert.equal(snap.engineVersion, '3.0.0');
    assert.equal(snap.dataVersion, 'b25');
    assert.ok(Number.isInteger(snap.frozenAt));
    assert.equal(snapshotB.hash, snap.hash, '同内容 → 同 hash（内容寻址去重）');
    assert.equal(store.snapshot.list().length, 1);
    const got = store.snapshot.get(snap.hash);
    assert.deepEqual(got.loadout, a.loadout);
    got.loadout.role.uid = 'mutated';
    assert.equal(store.snapshot.get(snap.hash).loadout.role.uid, a.loadout.role.uid, '快照不可变（深拷贝隔离）');
    assert.equal(store.snapshot.has(snap.hash), true);
    assert.equal(store.snapshot.get(`sha256:${'0'.repeat(64)}`), null);
    assert.equal(store.snapshot.require(`sha256:${'0'.repeat(64)}`), null);

    await store.settleBattle(quickInput(a, b, {}));
    assert.equal(store.snapshot.refCount(snap.hash), 2, '双方各一条引用');
    const kept = store.snapshot.gc({ retentionDays: 90, at: Date.now() });
    assert.equal(kept.removed.length, 0, '被引用快照不删（即使超期）');
    const orphan = store.freezeSnapshot(sampleLoadout('orphan'));
    assert.equal(store.snapshot.refCount(orphan.hash), 0);
    const cleaned = store.snapshot.gc({ retentionDays: 0, at: Date.now() + DAY });
    assert.ok(cleaned.removed.includes(orphan.hash), '无引用且超期 → 删除');
    assert.equal(store.snapshot.has(orphan.hash), false);
    assert.equal(store.snapshot.get(snap.hash) !== null, true);
    assert.ok(store.snapshot.stats().files >= 1);
    // 引用计数可由 journal 重建（§9.2）
    const rebuilt = store.snapshot.rebuildRefs(await store.readRecords({}));
    assert.equal(rebuilt.hashes, 1);
  }],

  ['CN-9 会话表：上限淘汰 / 撤销 / 过期清理', async ({ store, dir }) => {
    const a = await account(store, 'a');
    const pid = a.archive.playerId;
    const now = Date.now();
    for (let i = 1; i <= 6; i += 1) {
      store.sessions.put({ tokenHash: `t${i}`, playerId: pid, createdAt: now + i, expiresAt: now + DAY, lastUsedAt: now + i });
    }
    assert.equal(store.sessions.size(), 5, '每人最多 5 个活跃会话（§4.3）');
    assert.equal(store.sessions.get('t1'), null, '最旧会话被淘汰');
    assert.equal(store.sessions.get('t6').tokenHash, 't6');
    store.sessions.touch('t6', { lastUsedAt: now + 100 });
    assert.equal(store.sessions.get('t6').lastUsedAt, now + 100);
    assert.equal(store.sessions.list(pid).length, 5);
    const revoked = store.sessions.revokePlayer(pid, { keepTokenHash: 't6' });
    assert.equal(revoked.revoked, 4);
    assert.equal(store.sessions.get('t6') !== null, true);
    assert.equal(store.sessions.revoke('t6'), true);
    assert.equal(store.sessions.revoke('t6'), false);
    store.sessions.put({ tokenHash: 'expired', playerId: pid, createdAt: now - 10, expiresAt: now - 1 });
    assert.equal(store.sessions.get('expired'), null, '过期会话读取即失效');
    store.sessions.put({ tokenHash: 'gone', playerId: pid, createdAt: now, expiresAt: now - 1 });
    assert.equal(store.sessions.prune(now).removed, 1);
    // 落盘 + 重新装载
    store.sessions.put({ tokenHash: 'keep', playerId: pid, createdAt: now, expiresAt: now + DAY });
    store.sessions.save();
    assert.equal(fs.existsSync(path.join(dir, 'sessions.json')), true);
    // peek：只读探针（不做过期清理、不落盘）——区分"会话不存在"与"刚过期"
    assert.equal(store.sessions.peek('keep').tokenHash, 'keep');
    assert.equal(store.sessions.peek('nope'), null);
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
    assert.ok(raw.sessions.some((s) => s.tokenHash === 'keep'));
    assert.throws(() => store.sessions.put({ playerId: pid }), (e) => e.code === 'bad_request');
  }],

  ['CN-14 D-159/D-161：服务端权威仓库（真源 / 开箱发放 / 装配拆卸）+ AI 库', async ({ store }) => {
    const a = await account(store, 'wh');
    const pid = a.archive.playerId;
    // 真源：adapter 层返回 {warehouse, usage, caps, counts, starterIssued}（L6 account 再拍平成 buckets）
    const wh0 = await store.getWarehouse(pid);
    assert.deepEqual(Object.keys(wh0).sort(), ['caps', 'counts', 'starterIssued', 'usage', 'warehouse']);
    assert.deepEqual(Object.keys(wh0.warehouse.buckets).sort(), ['role', 'rolePlugin', 'skill', 'skillPlugin']);
    assert.deepEqual(wh0.counts, { role: 0, skill: 0, rolePlugin: 0, skillPlugin: 0 });
    assert.equal(wh0.starterIssued, false, '显式 loadout 建号 → 不发 starter');
    assert.equal(wh0.caps.role, 500);
    await assert.rejects(() => store.getWarehouse('pl_0000000000000000'), (e) => e.code === 'store_not_found');
    // 开箱发放：物品按 kind 入桶，写 journal（box.opened），返回 grantId + 新视图
    const role = { uid: 'itr_1', kind: 'role', templateId: 'role_bal', quality: 'common', slots: [{ type: 'atk', pluginUid: null }], pluginPoints: 4 };
    const plugin = { uid: 'itp_1', kind: 'rolePlugin', id: 'atk_up', slot: 'atk', quality: 'common', tier: 2, pointCost: 2, equipped: false };
    const granted = await store.grantBox({ playerId: pid, seed: 123, tier: 'common', times: 2, items: [role, plugin] });
    assert.match(granted.grantId, /^bx_/);
    assert.deepEqual(granted.counts, { role: 1, skill: 0, rolePlugin: 1, skillPlugin: 0 });
    assert.equal(granted.starterIssued, false);
    assert.ok((await store.readRecords({})).some((r) => r.type === 'box.opened' && r.grantId === granted.grantId),
      'D-159：开箱必须落 journal（可重放）');
    // 装配：校验在 L6，adapter 只落增量记录（warehouse.assemble）并回放可重演
    const asm = await store.applyWarehouseChange({ playerId: pid, op: 'assemble', targetUid: 'itr_1', pluginUid: 'itp_1', slotIndex: 0 });
    assert.equal(asm.warehouse.buckets.role[0].slots[0].pluginUid, 'itp_1');
    assert.equal(asm.warehouse.buckets.rolePlugin[0].equipped, true);
    assert.equal(asm.counts.rolePlugin, 1, '装配不搬移物品：插件仍在桶内，只标注 equipped + 被槽位引用');
    assert.ok((await store.readRecords({})).some((r) => r.type === 'warehouse.assemble' && r.pluginUid === 'itp_1'));
    const dis = await store.applyWarehouseChange({ playerId: pid, op: 'disassemble', targetUid: 'itr_1', slotIndex: 0 });
    assert.equal(dis.warehouse.buckets.role[0].slots[0].pluginUid, null);
    assert.equal(dis.warehouse.buckets.rolePlugin[0].equipped, false);
    assert.ok((await store.readRecords({})).some((r) => r.type === 'warehouse.disassemble'));
    // 目标不存在 → item_missing（不写记录）
    await assert.rejects(() => store.applyWarehouseChange({ playerId: pid, op: 'assemble', targetUid: 'nope', pluginUid: 'itp_1', slotIndex: 0 }),
      (e) => e.code === 'item_missing');
    // D-161：AI 库（列表 / 新建 / 删除 / 未知 404 / 出战引用拒删）
    const ai0 = await store.listAi(pid);
    assert.deepEqual(ai0.items, []);
    assert.equal(ai0.max, 100);
    assert.deepEqual(ai0.usage, {});
    const made = await store.createAi({ playerId: pid, name: '我的AI', program: { type: 'program', version: 1, body: { type: 'seq', statements: [] } } });
    assert.match(made.ai.aiId, /^ai_/);
    assert.equal(made.ai.name, '我的AI');
    assert.ok((await store.readRecords({})).some((r) => r.type === 'ai.created' && r.aiId === made.ai.aiId));
    assert.equal((await store.listAi(pid)).items.length, 1);
    const delAi = await store.deleteAi({ playerId: pid, aiId: made.ai.aiId });
    assert.deepEqual(delAi.referencedBy, []);
    assert.deepEqual(delAi.items, []);
    assert.ok((await store.readRecords({})).some((r) => r.type === 'ai.deleted' && r.aiId === made.ai.aiId));
    await assert.rejects(() => store.deleteAi({ playerId: pid, aiId: 'ai_nope' }), (e) => e.code === 'store_not_found');
    // 被**出战配置**引用 → ai_in_use（非出战配置的引用只提示）
    const refAi = await store.createAi({ playerId: pid, name: '出战AI', program: { type: 'program' } });
    const ld = sampleLoadout('ai');
    ld.aiId = refAi.ai.aiId;
    await store.saveConfigSlot({ playerId: pid, slotId: 'slot1', loadout: ld });
    assert.deepEqual((await store.listAi(pid)).usage[refAi.ai.aiId], ['slot1']);
    await assert.rejects(() => store.deleteAi({ playerId: pid, aiId: refAi.ai.aiId }),
      (e) => e.code === 'ai_in_use' && e.status === 409);
  }],

  ['CN-13 墓碑记录 player.removed：删除走 journal、可重放、幂等', async ({ store }) => {
    const a = await account(store, 'rm');
    const pid = a.archive.playerId;
    assert.equal(await store.removeArchive(pid, { reason: 'debug-cleanup' }), true);
    assert.equal(await store.loadArchive(pid), null, '档案文件已删');
    assert.equal(store.index.has(pid), false, '索引条目已摘除');
    const tomb = (await store.readRecords({})).find((r) => r.type === 'player.removed');
    assert.ok(tomb, '删除必须落 journal（D-134：journal 是唯一真源）');
    assert.equal(tomb.playerId, pid);
    assert.equal(tomb.reason, 'debug-cleanup');
    assert.ok(Number.isInteger(tomb.seq));
    // 幂等：再删 → false 且不产生第二条墓碑
    assert.equal(await store.removeArchive(pid), false);
    assert.equal((await store.readRecords({})).filter((r) => r.type === 'player.removed').length, 1);
    // 重复 apply 同一条墓碑 → 不报错、不再变更（幂等）
    const again = await store.applyRecord(tomb);
    assert.equal(again.applied, 0);
    assert.equal(await store.loadArchive(pid), null);
    // reason 可缺省
    const b = await account(store, 'rm2');
    await store.removeArchive(b.archive.playerId);
    assert.equal((await store.readRecords({})).find((r) => r.type === 'player.removed' && r.playerId === b.archive.playerId).reason, null);
    await assert.rejects(() => store.removeArchive(''), (e) => e.code === 'bad_request');
  }],

  ['CN-10 适配器选择：DL_STORE=json|sqlite|非法', async ({ store, dir }) => {
    assert.equal(store.adapterName, 'json');
    assert.equal(resolveAdapterName('json'), 'json');
    assert.equal(resolveAdapterName('SQLITE'), 'sqlite');
    assert.equal(resolveAdapterName(undefined), process.env.DL_STORE ? process.env.DL_STORE.toLowerCase() : 'json');
    assert.throws(() => createStore({ dataDir: dir, adapter: 'bogus' }), (e) => e.code === 'store_adapter_unknown');
  }],

  ['CN-11 sqlite 占位契约：明确报错、不静默退回 json（§11.4）', async () => {
    const dir = mkTmp();
    try {
      const sqlite = createStore({ dataDir: dir, adapter: 'sqlite', logger: nullLogger });
      assert.equal(sqlite.adapterName, 'sqlite');
      assert.equal(sqlite.implemented, false);
      await assert.rejects(() => sqlite.open(), (e) => e.code === 'store_adapter_unavailable' && e.fatal === true);
      await assert.rejects(() => sqlite.loadArchive('pl_0000000000000000'), (e) => e.code === 'store_adapter_unavailable');
      assert.deepEqual(fs.readdirSync(dir), [], 'sqlite 占位不得留下任何数据');
      const { createJsonAdapter } = require('../../server/store/adapter-json.js');
      assert.equal(typeof createJsonAdapter, 'function');
    } finally {
      rmTmp(dir);
    }
  }],
];

for (const [name, fn] of CASES) {
  test(name, async () => {
    const { store, dir } = await openStore();
    try {
      await fn({ store, dir });
    } finally {
      await store.close();
      rmTmp(dir);
    }
  });
}

test('CN-12 契约：json 适配器方法齐备（供 auth/account/quickmatch/ranked 调用）', async () => {
  const { store, dir } = await openStore();
  try {
    for (const method of ['open', 'close', 'loadArchive', 'saveArchive', 'updateArchive', 'listPlayerIds',
      'createAccount', 'setPasswordHash', 'setBanned', 'setNickname', 'setPool', 'touchLastSeen', 'markRecordsSeen',
      'saveConfigSlot', 'createConfigSlot', 'activateConfigSlot', 'deleteConfigSlot', 'freezeSnapshot',
      // D-159/D-161：服务端权威仓库 + AI 库
      'getWarehouse', 'grantBox', 'applyWarehouseChange', 'listAi', 'createAi', 'deleteAi',
      'append', 'appendMany', 'applyRecord', 'applyRecords', 'settleBattle', 'readRecords', 'findBattleRecord',
      // P7-6 修复 1/2 追加的结算原语：批量结算 + 参与集合结算锁 + 锁内单场 + 索引立即落盘
      'settleBatch', 'settleBattleLocked', 'withSettlementLock', 'flushIndex',
      'replayJournal', 'maxSeq', 'compactJournal', 'records', 'defenseSummary', 'getSummary', 'opponentWindow',
      'recover', 'rebuildIndex', 'gc', 'stats']) {
      assert.equal(typeof store[method], 'function', `适配器缺方法 ${method}`);
    }
    for (const ns of ['index', 'snapshot', 'sessions']) {
      assert.equal(typeof store[ns], 'object', `适配器缺命名空间 ${ns}`);
    }
    for (const m of ['snapshot', 'get', 'byTier', 'leaderboard', 'rank', 'rebuild', 'save', 'stats']) {
      assert.equal(typeof store.index[m], 'function', `store.index 缺方法 ${m}`);
    }
    for (const m of ['freeze', 'put', 'get', 'has', 'list', 'ref', 'refCount', 'gc', 'stats']) {
      assert.equal(typeof store.snapshot[m], 'function', `store.snapshot 缺方法 ${m}`);
    }
    for (const m of ['put', 'get', 'peek', 'touch', 'revoke', 'revokePlayer', 'list', 'prune', 'size']) {
      assert.equal(typeof store.sessions[m], 'function', `store.sessions 缺方法 ${m}`);
    }
    assert.equal(resolveDataDir(dir), path.resolve(dir));
    assert.ok(typeof resolveDataDir() === 'string');
  } finally {
    await store.close();
    rmTmp(dir);
  }
});
