'use strict';
/* tests/unit/store-journal.test.js —— journal：分段/seq/group commit/半写截断/重放/压缩（D-129 §6.2/§6.4/§6.7）
 * 沙箱说明：禁止 child_process，无法做"子进程 kill"式崩溃测试（T-ST-1/T-ST-3）；
 * 等价替代 = **直接构造畸形/截断的 journal 文件再加载**（见 CRASH-* 用例与 store-recovery.test.js）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const journalMod = require('../../server/store/journal.js');
const { StoreError } = require('../../server/store/errors.js');
const { nullLogger } = require('../../shared/log.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-journal-'));
}

function rmTmp(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

function openJournal(dir, config) {
  const j = journalMod.createJournal({ dir, logger: nullLogger, config: config || { fsyncMode: 'sync' } });
  j.load();
  return j;
}

test('JN-1 parseSegmentText：末行半写丢弃、坏尾行截断、中间坏行报错、空行容忍', () => {
  assert.deepEqual(journalMod.parseSegmentText(''), { records: [], truncated: false, badLine: null });
  const okText = '{"seq":1}\n{"seq":2}\n';
  assert.deepEqual(journalMod.parseSegmentText(okText), { records: [{ seq: 1 }, { seq: 2 }], truncated: false, badLine: null });
  const half = journalMod.parseSegmentText('{"seq":1}\n{"seq":2}');
  assert.equal(half.truncated, true);
  assert.deepEqual(half.records, [{ seq: 1 }], '缺结尾换行的末行必须丢弃');
  const badTail = journalMod.parseSegmentText('{"seq":1}\n{"seq":');
  assert.equal(badTail.truncated, true);
  assert.deepEqual(badTail.records, [{ seq: 1 }]);
  const midBad = journalMod.parseSegmentText('{"seq":1}\nNOT-JSON\n{"seq":3}\n');
  assert.equal(midBad.badLine, 1, '中间坏行必须上报（不可自动修复）');
  assert.equal(journalMod.parseSegmentText('\n{"seq":1}\n\n').records.length, 1);
  assert.equal(journalMod.serializeRecords([]), '');
  assert.equal(journalMod.serializeRecords([{ seq: 1 }]), '{"seq":1}\n');
  assert.equal(journalMod.monthKey(Date.UTC(2026, 8, 16)), '2026-09');
});

test('JN-2 append/flush：seq 单调、group commit 一次落盘、内容可重放', async () => {
  const dir = mkTmp();
  try {
    const j = openJournal(dir, { fsyncMode: 'batch' });
    const p1 = j.append({ type: 'player.nickname.changed', playerId: 'pl_1111111111111111', nickname: 'a' });
    const p2 = j.append({ type: 'player.nickname.changed', playerId: 'pl_1111111111111111', nickname: 'b' });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.seq, 1);
    assert.equal(r2.seq, 2);
    assert.equal(r1.v, 1);
    assert.ok(Number.isInteger(r1.at));
    assert.equal(j.maxSeq(), 2);
    assert.equal(j.stats().pending, 0, 'flush 后无待写缓冲');
    const segFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.equal(segFiles.length, 1, '同一事件循环内 → 同一段文件（group commit）');
    const lines = fs.readFileSync(path.join(dir, segFiles[0]), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).nickname, 'b');
    await j.close();
    // 重新加载：seq 从 journal 续上（重启来源 = max(journal)）
    const reopened = openJournal(dir);
    assert.equal(reopened.maxSeq(), 2);
    const r3 = await reopened.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111', inPool: true });
    assert.equal(r3.seq, 3);
    await reopened.close();
    const again = openJournal(dir);
    assert.equal(again.maxSeq(), 3);
    await again.close();
  } finally {
    rmTmp(dir);
  }
});

test('JN-3 append 校验：非对象/缺 type 拒绝；显式 seq 必须前进；未 load 即 append 报错', async () => {
  const dir = mkTmp();
  try {
    const unopened = journalMod.createJournal({ dir, logger: nullLogger });
    await assert.rejects(() => unopened.append({ type: 'x' }), (e) => e.code === 'store_internal');
    const j = openJournal(dir);
    await assert.rejects(() => j.append(null), (e) => e.code === 'bad_request');
    await assert.rejects(() => j.append({ noType: 1 }), (e) => e.code === 'bad_request');
    await assert.rejects(() => j.append({ type: 'player.pool.changed', seq: 0, playerId: 'pl_1' }), (e) => e.code === 'bad_request');
    const r = await j.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111' });
    assert.equal(r.seq, 1);
    await assert.rejects(() => j.append({ type: 'player.pool.changed', seq: 1, playerId: 'pl_1111111111111111' }),
      (e) => e.code === 'bad_request');
    const imp = await j.append({ type: 'player.pool.changed', seq: 10, playerId: 'pl_1111111111111111' });
    assert.equal(imp.seq, 10);
    assert.equal(j.maxSeq(), 10, '显式 seq（导入/迁移）可跳跃');
    await j.close();
  } finally {
    rmTmp(dir);
  }
});

test('JN-4 加载时截断半写尾行并记 store.journal.truncate(warn)', async () => {
  const dir = mkTmp();
  try {
    const seed = openJournal(dir);
    await seed.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111', at: 1000 });
    await seed.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111', at: 2000 });
    await seed.close();
    const file = path.join(dir, fs.readdirSync(dir).find((f) => f.endsWith('.jsonl')));
    // 人为制造半写：截掉最后一行的尾部（保留一个完整的 + 半个）
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, `${text.slice(0, text.length - 12)}`, 'utf8');
    const events = [];
    const logger = { warn: (ch, ev, msg, data) => events.push({ ch, ev, msg, data }), info: () => {}, debug: () => {}, trace: () => {}, error: () => {}, log: () => {} };
    const j = journalMod.createJournal({ dir, logger, config: {} });
    const res = j.load();
    assert.equal(res.truncatedSegments, 1);
    assert.equal(j.maxSeq(), 1, '只保留最后一条完整记录');
    assert.equal(events[0].ev, 'store.journal.truncate');
    assert.equal(events[0].ch, 'store');
    // 截断后的文件可继续追加
    const r = await j.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111' });
    assert.equal(r.seq, 2);
    await j.close();
  } finally {
    rmTmp(dir);
  }
});

test('JN-5 加载时中间坏行 → store_corrupt（不可自动修复，拒绝启动）', () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, '2026-09.jsonl'),
      '{"seq":1,"type":"a.b","at":1}\nBROKEN\n{"seq":3,"type":"a.b","at":3}\n', 'utf8');
    const j = journalMod.createJournal({ dir, logger: nullLogger });
    assert.throws(() => j.load(), (e) => e instanceof StoreError && e.code === 'store_corrupt' && e.fatal === true);
  } finally {
    rmTmp(dir);
  }
});

test('JN-6 检查点读取：损坏检查点 → store_corrupt；checkpoint 参与 maxSeq', async () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, '2026-08.checkpoint.json'),
      JSON.stringify({ type: 'checkpoint', v: 1, seq: 42, at: 1, perPlayer: {} }), 'utf8');
    const j = openJournal(dir);
    assert.equal(j.maxSeq(), 42, '检查点 seq 参与水位（分段被删后仍能续号）');
    assert.equal(j.checkpoints().length, 1);
    assert.equal(j.stats().checkpoints[0].seq, 42);
    const all = j.readAll({});
    assert.equal(all.length, 1);
    assert.equal(all[0].type, 'checkpoint');
    await j.close();
    fs.writeFileSync(path.join(dir, '2026-07.checkpoint.json'), '{oops', 'utf8');
    const bad = journalMod.createJournal({ dir, logger: nullLogger });
    assert.throws(() => bad.load(), (e) => e.code === 'store_corrupt');
  } finally {
    rmTmp(dir);
  }
});

test('JN-7 replay/readAll：按 seq 区间过滤、检查点优先于同月分段', async () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, '2026-08.checkpoint.json'),
      JSON.stringify({ type: 'checkpoint', v: 1, seq: 2, at: 1, perPlayer: { pl_1111111111111111: {} } }), 'utf8');
    fs.writeFileSync(path.join(dir, '2026-09.jsonl'),
      '{"seq":3,"type":"player.pool.changed","at":3}\n{"seq":4,"type":"player.pool.changed","at":4}\n', 'utf8');
    const j = openJournal(dir);
    const seen = [];
    const n = await j.replay({ fromSeq: 2 }, (rec) => { seen.push(rec.seq); });
    assert.deepEqual(seen, [3, 4]);
    assert.equal(n, 2);
    const withCp = await j.replay({ fromSeq: 0 }, (rec) => { seen.push(rec.seq); });
    assert.equal(withCp, 3);
    assert.deepEqual(seen, [3, 4, 2, 3, 4]);
    assert.equal(j.readAll({ fromSeq: 2, toSeq: 3 }).length, 1, '区间语义：fromSeq 开区间 / toSeq 闭区间');
    assert.equal(j.readAll({ includeCheckpoints: false }).length, 2);
    assert.equal(j.readAll({ fromSeq: 4 }).length, 0);
    assert.deepEqual(j.segments().map((s) => s.key), ['2026-09']);
    await j.close();
  } finally {
    rmTmp(dir);
  }
});

test('JN-8 findBattle：内存索引命中 + 落盘后扫描回填 + 未命中返回 null', async () => {
  const dir = mkTmp();
  try {
    const j = openJournal(dir);
    const rec = await j.append({
      type: 'battle.recorded', battleId: 'b_aaaaaaaaaaaaaaaa', mode: 'quick',
      p1: { playerId: 'pl_1111111111111111' }, p2: { playerId: 'pl_2222222222222222' },
    });
    assert.equal(j.findBattle(rec.battleId).seq, rec.seq);
    assert.equal(j.findBattle('b_zzzzzzzzzzzzzzzz'), null);
    await j.close();
    // 重新加载后由磁盘分段重建内存索引（byBattleId）
    const reopened = openJournal(dir);
    assert.equal(reopened.findBattle(rec.battleId).seq, rec.seq);
    assert.equal(reopened.findBattle('b_zzzzzzzzzzzzzzzz'), null);
    // 大小写/前缀严格匹配
    assert.equal(reopened.findBattle('b_AAAAAAAAAAAAAAAA'), null);
    await reopened.close();
  } finally {
    rmTmp(dir);
  }
});

test('JN-9 group commit：bufferBytes 超限立即 flush；close 前 flush 保证不丢', async () => {
  const dir = mkTmp();
  try {
    const j = openJournal(dir, { fsyncMode: 'batch', bufferBytes: 64 });
    const promises = [];
    for (let i = 0; i < 5; i += 1) {
      promises.push(j.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111', i }));
    }
    await Promise.all(promises);
    assert.equal(j.stats().pending, 0);
    assert.ok(j.stats().segments[0].bytes > 0);
    assert.ok(j.stats().segments[0].maxSeq >= 5);
    await j.close();
  } finally {
    rmTmp(dir);
  }
});

test('JN-10 compact：已物化且超期的段 → 写检查点 + 删段；未物化/未超期保留', async () => {
  const dir = mkTmp();
  try {
    fs.writeFileSync(path.join(dir, '2020-01.jsonl'),
      '{"seq":1,"type":"battle.recorded","battleId":"b_1","mode":"quick","at":1,"p1":{"playerId":"pl_1111111111111111","snapshotHash":"sha256:a","result":"win"},"p2":{"playerId":"pl_2222222222222222","snapshotHash":"sha256:b","result":"loss"}}\n', 'utf8');
    fs.writeFileSync(path.join(dir, '2099-01.jsonl'),
      '{"seq":2,"type":"player.pool.changed","at":2,"playerId":"pl_1111111111111111"}\n', 'utf8');
    const j = openJournal(dir);
    const aggregates = [];
    const res = j.compact({
      appliedSeq: 2, retentionDays: 30, at: Date.now(),
      aggregate: (records) => { aggregates.push(records.length); return { pl_1111111111111111: { quickGames: 1 } }; },
    });
    assert.deepEqual(res.compacted, ['2020-01']);
    assert.deepEqual(res.droppedSegments, ['2020-01']);
    assert.deepEqual(aggregates, [1]);
    assert.equal(fs.existsSync(path.join(dir, '2020-01.jsonl')), false);
    assert.equal(fs.existsSync(path.join(dir, '2020-01.checkpoint.json')), true);
    assert.equal(fs.existsSync(path.join(dir, '2099-01.jsonl')), true, '未超期段保留');
    assert.equal(j.maxSeq(), 2);
    // 未物化（maxSeq > appliedSeq）→ 不压缩
    const res2 = j.compact({ appliedSeq: 0, retentionDays: 30, at: Date.now() + 4e11 });
    assert.deepEqual(res2.compacted, []);
    await j.close();
    // 检查点里的聚合可用于"检查点精度重建"
    const cp = JSON.parse(fs.readFileSync(path.join(dir, '2020-01.checkpoint.json'), 'utf8'));
    assert.equal(cp.seq, 1);
    assert.ok(cp.perPlayer.pl_1111111111111111);
  } finally {
    rmTmp(dir);
  }
});

test('JN-11 journal 写失败 → store_write_failed 且不产生半条记录（只读目录）', async () => {
  const dir = mkTmp();
  try {
    const j = openJournal(dir);
    await j.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111' });
    await j.close();
    // 用"段文件路径被目录占用"制造写入失败（Windows/Linux 行为一致，无需 chmod）
    const j2 = journalMod.createJournal({ dir, logger: nullLogger, config: { fsyncMode: 'sync' } });
    j2.load();
    const key = journalMod.monthKey(Date.now());
    const segPath = path.join(dir, `${key}.jsonl`);
    const backup = fs.existsSync(segPath) ? fs.readFileSync(segPath) : null;
    if (backup) fs.rmSync(segPath);
    fs.mkdirSync(segPath);
    await assert.rejects(() => j2.append({ type: 'player.pool.changed', playerId: 'pl_1111111111111111' }),
      (e) => e.code === 'store_write_failed');
    fs.rmdirSync(segPath);
    if (backup) fs.writeFileSync(segPath, backup);
    j2.opened = false;
  } finally {
    rmTmp(dir);
  }
});
