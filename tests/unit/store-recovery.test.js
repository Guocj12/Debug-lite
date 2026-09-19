'use strict';
/* tests/unit/store-recovery.test.js —— 崩溃恢复（D-129 §6.4；T-ST-2/3/4/5/7 的等价验证）
 *
 * ⚠️ 沙箱限制：本项目禁止 child_process（架构铁律 + 沙箱 EPERM），无法实现"子进程跑到一半被 kill"式
 *    崩溃测试。**等价替代**：直接构造崩溃后的磁盘状态（journal 已落盘但档案未写、journal 末行半写、
 *    索引缺失/损坏、档案 appliedSeq 落后/超前、档案 JSON 损坏），再调用 store.open() 验证恢复路径。
 *    这一替代能覆盖 §6.4 的全部五个步骤，且比 kill 更可控（能精确指定崩溃点）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../server/store/index.js');
const { nullLogger } = require('../../shared/log.js');

const VERSIONS = { engine: '3.0.0', data: 'b25' };

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-recovery-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
}

function makeLogger() {
  const events = [];
  const push = (level) => (ch, ev, msg, data) => events.push({ level, ch, ev, msg, data });
  return {
    events,
    has: (ev) => events.some((e) => e.ev === ev),
    logger: {
      fatal: push('fatal'), error: push('error'), warn: push('warn'), info: push('info'),
      debug: push('debug'), trace: push('trace'), log: push('log'),
    },
  };
}

function loadout(tag) {
  return { role: { uid: `r_${tag}` }, skills: [{ uid: `s_${tag}` }], ai: { version: 2, tag } };
}

async function open(dir, logger) {
  const store = createStore({ dataDir: dir, versions: VERSIONS, logger: logger || nullLogger });
  await store.open();
  return store;
}

async function seedTwoPlayers(dir) {
  const store = await open(dir);
  const snap = store.freezeSnapshot(loadout('a'));
  const a = await store.createAccount({
    username: 'a', nickname: 'a', auth: { hash: 'a' },
    slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS },
  });
  const b = await store.createAccount({
    username: 'b', nickname: 'b', auth: { hash: 'b' },
    slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS },
  });
  const battle = await store.settleBattle({
    mode: 'quick', seed: 7,
    p1: { playerId: a.playerId, publicId: a.publicId, role: 'attacker', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 14, result: 'win' },
    p2: { playerId: b.playerId, publicId: b.publicId, role: 'defender', snapshotHash: snap.hash, configHash: snap.configHash, pointsBefore: 0, pointsAfter: 0, result: 'loss' },
    verdict: { winner: 'p1', reason: 'hero_dead', ticks: 23 },
    versions: VERSIONS,
  });
  await store.close();
  return { a: a.playerId, b: b.playerId, snap, seq: battle.record.seq };
}

function archivePath(dir, playerId) {
  return path.join(dir, 'players', playerId.slice(3, 5), `${playerId}.json`);
}

test('RCV-1 T-ST-3 等价：journal 已落盘但档案未写（人为删除 players/）→ 重启补放，双方战绩一致', async () => {
  const dir = mkTmp();
  try {
    const seeded = await seedTwoPlayers(dir);
    fs.rmSync(path.join(dir, 'players'), { recursive: true, force: true });
    assert.equal(fs.existsSync(path.join(dir, 'players')), false);
    const log = makeLogger();
    const store = await open(dir, log.logger);
    const a = await store.loadArchive(seeded.a);
    const b = await store.loadArchive(seeded.b);
    assert.ok(a && b, '双方档案都必须被 journal 重建（绝不产生单边记账）');
    assert.equal(a.rating.points, 14);
    assert.equal(a.record.stats.attack.wins, 1);
    assert.equal(b.record.stats.defense.losses, 1);
    assert.equal(a.record.recent.length, 1);
    assert.equal(b.record.recent.length, 1);
    assert.equal(a.record.recent[0].battleId, b.record.recent[0].battleId);
    assert.equal(store.maxSeq(), seeded.seq);
    assert.equal(store.index.seq(), seeded.seq);
    assert.equal(store.index.size(), 2);
    assert.ok(log.has('store.recover'));
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('RCV-2 T-ST-4 等价：journal 末行半写 → 截断 + store.journal.truncate(warn)（不产生半场战绩）', async () => {
  const dir = mkTmp();
  try {
    const seeded = await seedTwoPlayers(dir);
    const jdir = path.join(dir, 'journal');
    const seg = path.join(jdir, fs.readdirSync(jdir).find((f) => f.endsWith('.jsonl')));
    const text = fs.readFileSync(seg, 'utf8');
    fs.writeFileSync(seg, `${text}${JSON.stringify({ seq: 99, type: 'battle.recorded', battleId: 'b_half', at: 1 }).slice(0, 30)}`, 'utf8');
    fs.rmSync(path.join(dir, 'players'), { recursive: true, force: true });
    const log = makeLogger();
    const store = await open(dir, log.logger);
    assert.equal(store.maxSeq(), seeded.seq, '半写行不得进入水位（§6.4 步骤 4）');
    assert.ok(log.has('store.journal.truncate'));
    const a = await store.loadArchive(seeded.a);
    assert.equal(a.record.recent.length, 1, '只有完整的那一场');
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('RCV-3 journal 中间行损坏 → 拒绝启动（store_corrupt，fatal）且释放锁', async () => {
  const dir = mkTmp();
  try {
    await seedTwoPlayers(dir);
    const jdir = path.join(dir, 'journal');
    const seg = path.join(jdir, fs.readdirSync(jdir).find((f) => f.endsWith('.jsonl')));
    const text = fs.readFileSync(seg, 'utf8');
    const lines = text.trim().split('\n');
    fs.writeFileSync(seg, `${lines[0]}\n{{BROKEN}}\n${lines[1]}\n`, 'utf8');
    await assert.rejects(() => open(dir), (e) => e.code === 'store_corrupt' && e.fatal === true);
    assert.equal(fs.existsSync(path.join(dir, 'lock')), false, '启动失败必须释放单进程锁');
    // 修好后仍可正常启动（证明失败未污染数据）
    fs.writeFileSync(seg, text, 'utf8');
    const store = await open(dir);
    assert.equal(store.index.size(), 2);
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('RCV-4 T-ST-5 等价：index.json 删除/损坏 → 从 players 重建，排行榜与段位池一致', async () => {
  const dir = mkTmp();
  try {
    const seeded = await seedTwoPlayers(dir);
    const before = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    for (const mode of ['deleted', 'corrupt']) {
      if (mode === 'deleted') fs.rmSync(path.join(dir, 'index.json'));
      else fs.writeFileSync(path.join(dir, 'index.json'), '{ not json', 'utf8');
      const log = makeLogger();
      const store = await open(dir, log.logger);
      const after = store.index.toJSON();
      assert.equal(after.seq, before.seq, `${mode}: 水位由 journal 恢复`);
      assert.deepEqual(Object.keys(after.players).sort(), Object.keys(before.players).sort());
      assert.equal(after.players[seeded.a].points, 14);
      assert.deepEqual(store.index.byTier('common').sort(), before.byTier.common.sort());
      const board = store.index.leaderboard({});
      assert.equal(board.length, 2);
      assert.equal(board[0].publicId, before.players[seeded.a].publicId, '重建后排行榜首位 = 积分最高者');
      if (mode === 'corrupt') assert.ok(log.has('store.error'), '损坏索引要记 store.error');
      await store.close();
    }
  } finally {
    rmTmp(dir);
  }
});

test('RCV-5 档案 appliedSeq 落后 → 补放；超前 → 拒绝启动（fatal）', async () => {
  const dir = mkTmp();
  try {
    const seeded = await seedTwoPlayers(dir);
    const file = archivePath(dir, seeded.a);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.record.appliedSeq = 1; // 落后（应补放）
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    let store = await open(dir);
    assert.equal((await store.loadArchive(seeded.a)).record.appliedSeq, seeded.seq, '落后水位被补放修复');
    assert.equal((await store.loadArchive(seeded.a)).record.recent.length, 1, '补放幂等：战绩不重复');
    await store.close();
    // 超前（篡改）→ 拒绝启动
    const raw2 = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw2.record.appliedSeq = 99999;
    fs.writeFileSync(file, JSON.stringify(raw2), 'utf8');
    await assert.rejects(() => open(dir), (e) => e.code === 'store_corrupt' && e.fatal === true);
    assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
    void store;
  } finally {
    rmTmp(dir);
  }
});

test('RCV-6 档案 JSON 损坏 → 隔离为 .corrupt-* 并从 journal 重建（其余玩家不受影响）', async () => {
  const dir = mkTmp();
  try {
    const seeded = await seedTwoPlayers(dir);
    fs.writeFileSync(archivePath(dir, seeded.a), '{ broken json', 'utf8');
    const log = makeLogger();
    const store = await open(dir, log.logger);
    const a = await store.loadArchive(seeded.a);
    assert.ok(a, '损坏档案由 journal 重建');
    assert.equal(a.record.appliedSeq, seeded.seq);
    assert.equal(a.record.stats.attack.wins, 1);
    const shard = path.join(dir, 'players', seeded.a.slice(3, 5));
    assert.ok(fs.readdirSync(shard).some((f) => f.includes('.corrupt-')), '损坏文件被隔离保留供排查');
    assert.ok(log.has('store.error'));
    const b = await store.loadArchive(seeded.b);
    assert.equal(b.record.stats.defense.losses, 1, '其他玩家档案不受影响');
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('RCV-7 索引 seq 落后于 journal → 从 index.seq 重放，幂等不重复计分', async () => {
  const dir = mkTmp();
  try {
    const seeded = await seedTwoPlayers(dir);
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    idx.seq = 0;
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(idx), 'utf8');
    const store = await open(dir);
    const a = await store.loadArchive(seeded.a);
    assert.equal(a.rating.games, 1, '重放幂等（appliedSeq/battleId 双保险）');
    assert.equal(a.record.recent.length, 1);
    assert.equal(store.index.seq(), seeded.seq);
    await store.close();
  } finally {
    rmTmp(dir);
  }
});

test('RCV-8 索引与档案全损坏且 journal 为空 → 拒绝启动（提示从备份恢复）；空目录则视为全新库', async () => {
  const dir = mkTmp();
  try {
    fs.mkdirSync(path.join(dir, 'players', '11'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'players', '11', 'pl_1111111111111111.json'), '{ broken', 'utf8');
    fs.writeFileSync(path.join(dir, 'index.json'), '{ broken', 'utf8');
    await assert.rejects(() => open(dir), (e) => e.code === 'store_corrupt' && e.fatal === true);
    // 全新空目录：正常启动
    const fresh = mkTmp();
    try {
      const store = await open(fresh);
      assert.equal(store.index.size(), 0);
      assert.equal(store.maxSeq(), 0);
      await store.close();
    } finally {
      rmTmp(fresh);
    }
  } finally {
    rmTmp(dir);
  }
});

test('RCV-9 T-ST-2 等价：同一 battleId 记录重复 apply → 只记一次（重放期同样成立）', async () => {
  const dir = mkTmp();
  try {
    const store = await open(dir);
    const snap = store.freezeSnapshot(loadout('x'));
    const a = await store.createAccount({ username: 'a', auth: { hash: 'a' }, slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS } });
    const b = await store.createAccount({ username: 'b', auth: { hash: 'b' }, slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS } });
    const battle = await store.settleBattle({
      mode: 'quick', seed: 3,
      p1: { playerId: a.playerId, role: 'attacker', snapshotHash: snap.hash, pointsBefore: 0, pointsAfter: 10, result: 'win' },
      p2: { playerId: b.playerId, role: 'defender', snapshotHash: snap.hash, pointsBefore: 0, pointsAfter: 0, result: 'loss' },
      verdict: { winner: 'p1' }, versions: VERSIONS,
    });
    // 人为把两条记录的 appliedSeq 落后 + 把同一条记录复制进 journal（模拟历史遗留重复）
    const jdir = path.join(dir, 'journal');
    const seg = path.join(jdir, fs.readdirSync(jdir).find((f) => f.endsWith('.jsonl')));
    fs.appendFileSync(seg, `${JSON.stringify({ ...battle.record, seq: battle.record.seq + 1 })}\n`, 'utf8');
    for (const pid of [a.playerId, b.playerId]) {
      const file = archivePath(dir, pid);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      raw.record.appliedSeq = 1;
      fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    }
    await store.close();
    const store2 = await open(dir);
    const a2 = await store2.loadArchive(a.playerId);
    assert.equal(a2.rating.games, 1, '同一 battleId 不得重复计分（recent 去重兜底）');
    assert.equal(a2.record.recent.length, 1);
    assert.equal(store2.maxSeq(), battle.record.seq + 1);
    await store2.close();
  } finally {
    rmTmp(dir);
  }
});

test('RCV-10 T-ST-7 等价：档案 archiveVersion 高于本进程 → 拒绝启动', async () => {
  const dir = mkTmp();
  try {
    const seeded = await seedTwoPlayers(dir);
    const file = archivePath(dir, seeded.a);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    raw.archiveVersion = 99;
    fs.writeFileSync(file, JSON.stringify(raw), 'utf8');
    await assert.rejects(() => open(dir), (e) => e.code === 'store_version_unsupported' && e.fatal === true);
    assert.equal(fs.existsSync(path.join(dir, 'lock')), false);
  } finally {
    rmTmp(dir);
  }
});

test('RCV-11 T-ST-1 等价：反复原子写后档案永远是完整 JSON；崩溃残留 tmp 在启动时清理', async () => {
  const dir = mkTmp();
  try {
    const store = await open(dir);
    const snap = store.freezeSnapshot(loadout('t'));
    const a = await store.createAccount({ username: 'a', auth: { hash: 'a' }, slot: { slotId: 'slot1', snapshotHash: snap.hash, configHash: snap.configHash, versions: VERSIONS } });
    const file = archivePath(dir, a.playerId);
    for (let i = 0; i < 30; i += 1) {
      await store.touchLastSeen(a.playerId, 1000 + i);
      assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')), `第 ${i} 次写后档案必须是完整 JSON`);
    }
    await store.close();
    // 人为留下崩溃残留 tmp → 启动时清理
    fs.writeFileSync(`${file}.tmp-999-dead`, '{"half":', 'utf8');
    fs.writeFileSync(path.join(dir, 'index.json.tmp-999-dead'), '{"half":', 'utf8');
    const store2 = await open(dir);
    assert.equal(fs.existsSync(`${file}.tmp-999-dead`), false, 'players 下 tmp 被清理');
    assert.equal(fs.existsSync(path.join(dir, 'index.json.tmp-999-dead')), false, '数据根 tmp 被清理');
    assert.equal((await store2.loadArchive(a.playerId)).lastSeenAt, 1029);
    await store2.close();
  } finally {
    rmTmp(dir);
  }
});
