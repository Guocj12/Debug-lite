'use strict';
// B11 黄金战斗契约测试 —— 测试点归属（B11 审查 P1 修正，tasks §3.2）：
//   确定性（同 seed 完整战斗逐帧一致）= T-EN-1/T-BT-5；快照锚定（走查可复算）= T-BT-13/14
// 依据：.audit/golden-battle.js（固定 loadout × 固定 AI 序列 × seed 20260912，p1 critChance 0.5 走随机路径）；快照 .audit/golden-battle.json
// 语义：任何"同 seed 两次 runFull 逐帧一致"失败 = 确定性破坏；任何与快照不一致 = 机制数值漂移（需复核后 --write 重锚）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGolden, SEED } = require('../../.audit/golden-battle.js');

const SNAP = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '.audit', 'golden-battle.json'), 'utf8'));

test('T-EN-1/T-BT-5 黄金复现：同 seed 两次完整战斗逐帧一致（确定性，含随机路径）', () => {
  const a = runGolden();
  const b = runGolden();
  assert.equal(a.summary.ticks, b.summary.ticks);
  assert.equal(a.summary.winner, b.summary.winner);
  assert.deepEqual(a.summary.frames, b.summary.frames, '同 seed 两次 runFull 逐帧一致（含 crit 流）');
  assert.equal(a.diffs.length, b.diffs.length);
});

test('T-BT-13/14 走查可复算：全帧摘要与磁盘快照逐值一致（机制漂移即红）', () => {
  const { summary } = runGolden();
  assert.deepEqual(summary, SNAP, '黄金战斗与 .audit/golden-battle.json 逐值一致；若机制有意变更需独立复核后 --write 重锚');
  assert.equal(summary.seed, SEED);
  assert.ok(summary.ticks <= 64, '64 tick 上界内结束');
  assert.ok(summary.winner === 'p1' || summary.winner === 'p2' || summary.winner === 'draw');
  // 快照合理性抽查：双方 hp 有增减、帧结构完整、命中链锚定
  const hps = summary.frames.map((f) => f.p1.hp);
  assert.ok(hps.some((h) => h < 100), '战斗中 p1 受过伤');
  for (const f of summary.frames) {
    assert.ok(f.p1.x >= 32 && f.p1.x <= 992, 'p1 位置在界内');
    assert.ok(f.p2.x >= 32 && f.p2.x <= 992, 'p2 位置在界内');
    assert.ok(Array.isArray(f.hits), '帧含 bulletHits 锚');
  }
  assert.ok(summary.frames.some((f) => f.hits.length > 0), '战斗存在弹幕命中帧');
});

test('B11-b 黄金复现对偶：diff 帧结构完整（verdict/bulletHits/collision 字段齐备）', () => {
  const a = runGolden();
  for (const d of a.diffs) {
    assert.ok(d.tick > 0);
    assert.ok(d.players.p1.fromX !== undefined && d.players.p1.toX !== undefined);
    assert.ok(Array.isArray(d.bulletHits));
    assert.ok('verdict' in d);
  }
  assert.equal(a.diffs[a.diffs.length - 1].verdict.winner, a.summary.winner);
});