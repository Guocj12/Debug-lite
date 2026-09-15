'use strict';
// B1 core/rng.js 契约测试 —— 接口见 docs/interfaces.md §1（createRng/deriveStream/state-restore）
// 依据：decisions D-90/D-91/D-92（全局种子 / 每 tick 每用途派生流 / 引擎禁 Math.random）
// 归属：tasks.md §6 B1（rng 确定性）；日志事件 rng.create/rng.draw/rng.stream（§4.6）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRng } = require('../../server/core/rng.js');
const { createLogger } = require('../../shared/log.js');

test('R-1 确定性：同 seed 同调用序列 → 完全相同序列（浮点逐位）', () => {
  const a = createRng(42);
  const b = createRng(42);
  const seqA = [a.float(), a.float(), a.float(), a.float(), a.float()];
  const seqB = [b.float(), b.float(), b.float(), b.float(), b.float()];
  assert.deepEqual(seqA, seqB);
  // 值域 [0,1)
  for (const v of seqA) assert.ok(v >= 0 && v < 1, `越界值 ${v}`);
});

test('R-1b 固定值锚点：mulberry32(42) 前 5 值与独立复算一致（2026-09-12，与 gen.test.js G-1 同锚）', () => {
  // 独立实现（a+0x6D2B79F5; t=imul(a^a>>>15,1|a); t=t+imul(t^t>>>7,61|t)^t; (t^t>>>14)>>>0 / 2^32）
  const g = createRng(42);
  assert.deepEqual(
    [g.float(), g.float(), g.float(), g.float(), g.float()],
    [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423],
    '锚点漂移即算法被改坏'
  );
});

test('R-2 不同 seed 序列不同（分布合理性）', () => {
  const s1 = createRng(1).float();
  const s2 = createRng(2).float();
  assert.notEqual(s1, s2);
});

test('R-3 int 闭区间：边界可达、越界抛错、负区间', () => {
  const g = createRng(7);
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const v = g.int(0, 3);
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 3);
    seen.add(v);
  }
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3], '闭区间两端都应可达');
  const g2 = createRng(8);
  for (let i = 0; i < 100; i++) {
    const v = g2.int(-5, -2);
    assert.ok(v >= -5 && v <= -2);
  }
  assert.throws(() => createRng(9).int(3, 2), RangeError, 'lo>hi 抛错');
  assert.throws(() => createRng(9).int(1.5, 3), RangeError);
});

test('R-4 pick/chance：非空数组、空数组抛错、概率边界与越界', () => {
  const g = createRng(11);
  assert.equal(g.pick(['only']), 'only');
  assert.throws(() => g.pick([]), RangeError);
  const g2 = createRng(11);
  for (let i = 0; i < 100; i++) assert.equal(g2.chance(0), false);
  const g3 = createRng(11);
  for (let i = 0; i < 100; i++) assert.equal(g3.chance(1), true);
  assert.throws(() => createRng(12).chance(-0.1), RangeError);
  assert.throws(() => createRng(12).chance(1.2), RangeError);
});

test('R-5 大样本统计：chance(0.5) 与 pick 均匀性（种子化，误差 <2%）', () => {
  const g = createRng(20260912);
  let yes = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) if (g.chance(0.5)) yes++;
  assert.ok(Math.abs(yes / N - 0.5) < 0.02, `chance(0.5) 频率 ${yes / N}`);
  const g2 = createRng(20260913);
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < N; i++) counts[g2.int(0, 3)]++;
  for (let c = 0; c < 4; c++) assert.ok(Math.abs(counts[c] / N - 0.25) < 0.02, `int(0,3) 第 ${c} 档频率 ${counts[c] / N}`);
});

test('R-6 deriveStream（D-91）：同参同流、异参异流、不消耗父流、跨实例一致', () => {
  const parent = createRng(77);
  const d1 = parent.deriveStream(3, 'ai');
  const d2 = createRng(77).deriveStream(3, 'ai');
  const d3 = createRng(77).deriveStream(4, 'ai');
  const d4 = createRng(77).deriveStream(3, 'crit');
  for (let i = 0; i < 50; i++) assert.equal(d1.float(), d2.float(), '同 tick+purpose 流一致');
  assert.notEqual(d3.float(), d4.float(), '异参流不同');
  // 纯函数派生：deriveStream 不消耗父流
  const p1 = createRng(77);
  p1.deriveStream(3, 'ai');
  p1.deriveStream(9, 'crit');
  const p2 = createRng(77);
  assert.equal(p1.float(), p2.float(), 'deriveStream 不推进父流');
});

test('R-7 每用途流互不干扰（D-91）：交错消耗 ai/crit 流与独立创建一致', () => {
  const engine = createRng(2026);
  const aiRng = engine.deriveStream(1, 'ai');
  const critRng = engine.deriveStream(1, 'crit');
  const aiRef = createRng(2026).deriveStream(1, 'ai');
  const critRef = createRng(2026).deriveStream(1, 'crit');
  // 交错调用：AI 消耗不平移 crit 序列
  const aiSeq = [];
  const critSeq = [];
  for (let i = 0; i < 20; i++) {
    aiSeq.push(aiRng.float());
    critSeq.push(critRng.chance(0.3));
  }
  const aiRefSeq = [];
  const critRefSeq = [];
  for (let i = 0; i < 20; i++) {
    aiRefSeq.push(aiRef.float());
    critRefSeq.push(critRef.chance(0.3));
  }
  assert.deepEqual(aiSeq, aiRefSeq, 'ai 流不受 crit 消耗影响');
  assert.deepEqual(critSeq, critRefSeq, 'crit 流不受 ai 消耗影响');
});

test('R-8 state/restore：快照往返后序列与原样继续完全一致（可序列化）', () => {
  const g1 = createRng(999);
  g1.float();
  g1.int(0, 10);
  const snap = g1.state();
  const expected = [g1.float(), g1.chance(0.5), g1.int(1, 6)];
  // 从快照恢复的新实例
  const g2 = createRng(888);
  g2.restore(snap);
  const actual = [g2.float(), g2.chance(0.5), g2.int(1, 6)];
  assert.deepEqual(actual, expected, 'restore 后序列一致');
  // state 可 JSON 序列化
  const roundTrip = JSON.parse(JSON.stringify(g1.state()));
  const g3 = createRng(777).restore(roundTrip);
  assert.equal(g3.float(), g1.float(), 'state JSON 往返可用');
});

test('R-9 种子归一化：缺失/NaN/字符串数字 → 确定性一致', () => {
  assert.equal(createRng(undefined).float(), createRng(NaN).float());
  assert.equal(createRng('42').float(), createRng(42).float());
  assert.equal(createRng(-1).float(), createRng(-1).float());
});

test('R-10 日志：rng.create/rng.draw/rng.stream 事件与 purpose 标注；nullLogger 缺省安全', () => {
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const rng = createRng(5, { logger });
  rng.float(0, 1, 'crit');
  rng.deriveStream(1, 'ai');
  const createEvt = logger.records.find((r) => r.event === 'rng.create');
  assert.ok(createEvt, '应有 rng.create');
  assert.equal(createEvt.data.seed, 5);
  const draw = logger.records.filter((r) => r.event === 'rng.draw');
  assert.ok(draw.length >= 1, '应有 rng.draw');
  assert.equal(draw[0].data.purpose, 'crit');
  assert.ok(draw[0].data.value >= 0 && draw[0].data.value < 1);
  const stream = logger.records.find((r) => r.event === 'rng.stream');
  assert.ok(stream, '应有 rng.stream');
  assert.equal(stream.tick, 1, 'tick 提升到记录顶层（shared/log.js T-LG-2b 契约）');
  assert.equal(stream.data.purpose, 'ai');
  // 缺省 logger 不炸
  const bare = createRng(1);
  assert.ok(bare.float() >= 0);
  bare.deriveStream(1, 'ai').chance(0.5);
  bare.int(0, 3);
  bare.pick([1]);
  bare.state();
  bare.restore(bare.state());
});