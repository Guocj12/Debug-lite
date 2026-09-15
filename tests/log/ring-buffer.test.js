'use strict';
// T-LG-6 环形缓冲 / suppressed / dump / reset —— 契约见 shared/README.md「通道语义」
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');

function assertDroppedAfterPushes(log, pushes, dropExpect, suppressedExpect, label) {
  for (let i = 0; i < pushes; i++) log.log('info', 'engine', 'e', 'm');
  const st = log.stats();
  assert.equal(st.dropped, dropExpect, `${label}: dropped`);
  assert.equal(st.records, log.records.length, `${label}: stats.records 与 records 一致`);
  const sup = log.records.filter((r) => r.event === 'log.suppressed');
  assert.equal(sup.length, suppressedExpect, `${label}: suppressed 条数`);
  return sup;
}

test('T-LG-6a 环形缓冲上限：ringSize=10 只留最新 10 条', () => {
  const log = createLogger({ level: 'all', ringSize: 10 });
  for (let i = 0; i < 25; i++) log.log('info', 'engine', 'e', `msg-${i}`);
  assert.equal(log.records.length, 10);
  // 保留的是 seq 15..24（最早被丢弃）
  assert.deepEqual(log.records.map((r) => r.seq), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  assert.equal(log.stats().dropped, 15);
});

test('T-LG-6b suppressed 边界：每累计 100 次丢弃发一条 log.suppressed（warn）', () => {
  // 通过 sink 观测全部 suppressed（早期记录会被环形缓冲逐出，ring 过滤不可靠）
  const suppressedSeen = [];
  const log = createLogger({ level: 'all', ringSize: 10, onRecord: (r) => { if (r.event === 'log.suppressed') suppressedSeen.push(r); } });
  // 110 次 push：dropped 到 100 时触发一次（该次同时再移位一条 → dropped=101）
  for (let i = 0; i < 110; i++) log.log('info', 'engine', 'e', 'm');
  assert.equal(log.stats().dropped, 101, '阶段1 dropped');
  assert.equal(suppressedSeen.length, 1);
  assert.equal(suppressedSeen[0].data.dropped, 100);
  assert.equal(suppressedSeen[0].data.ringSize, 10);
  assert.equal(suppressedSeen[0].level, 'warn');
  // 再 100 次（共 210）：push 209 时 dropped=200 触发第二次（→201），push 210 再移位 → 202
  for (let i = 0; i < 100; i++) log.log('info', 'engine', 'e', 'm');
  assert.equal(log.stats().dropped, 202, '阶段2 dropped');
  assert.equal(suppressedSeen.length, 2);
  assert.equal(suppressedSeen[1].data.dropped, 200);
  // 再 50 次（共 260）未到 300 边界 → 仍 2 条
  for (let i = 0; i < 50; i++) log.log('info', 'engine', 'e', 'm');
  assert.equal(log.stats().dropped, 252, '阶段3 dropped');
  assert.equal(suppressedSeen.length, 2);
});

test('T-LG-6c suppressed 记录本身入环（计入 dropped 语义）', () => {
  const log = createLogger({ level: 'all', ringSize: 5 });
  for (let i = 0; i < 106; i++) log.log('info', 'engine', 'e', 'm');
  // 106 次 push + 1 次 suppressed = 107 记录，环容量 5 → dropped = 102
  assert.equal(log.stats().dropped, 102);
  assert.equal(log.records.filter((r) => r.event === 'log.suppressed').length, 1);
});

test('T-LG-6d reset：清空缓冲/计数、恢复初始级别与通道覆盖', () => {
  const log = createLogger({ level: 'warn', ringSize: 10 });
  log.setLevel('all');
  log.setChannelLevel('bullets', 'trace');
  for (let i = 0; i < 12; i++) log.log('trace', 'bullets', 'e', 'm');
  assert.equal(log.records.length, 10);
  log.reset();
  assert.equal(log.getLevel(), 'warn', '级别恢复初始');
  assert.equal(log.records.length, 0);
  assert.equal(log.stats().seq, 0);
  assert.equal(log.stats().dropped, 0);
  assert.equal(log.log('trace', 'bullets', 'e', 'm'), false, '通道覆盖被清除');
  assert.equal(log.log('warn', 'bullets', 'e', 'm'), true);
});

test('T-LG-6e ringSize 校验：非正整数回退默认 2000', () => {
  const log = createLogger({ level: 'all', ringSize: 0 });
  assert.equal(log.stats().records, 0);
  for (let i = 0; i < 2010; i++) log.log('info', 'engine', 'e', 'm');
  assert.equal(log.records.length, 2000, '回退默认 2000');
  assert.equal(log.stats().dropped, 10);
  // 再 90 次：总 2100 次 → dropped 到 100 的边界被越过并触发 suppressed（自身移位 +1 → 101）
  assertDroppedAfterPushes(log, 90, 101, 1, '默认环也触发 suppressed');
});