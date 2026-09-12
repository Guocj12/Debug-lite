'use strict';
// T-LG-3 未知通道警告 —— 契约见 shared/README.md「通道语义」
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');

test('T-LG-3a 未注册通道发出记录时 → log.unknownChannels（warn，含通道名）', () => {
  const log = createLogger({ level: 'warn' });
  log.log('warn', 'bogus_chan', 'some.event', 'm');
  const warns = log.records.filter((r) => r.event === 'log.unknownChannels');
  assert.equal(warns.length, 1);
  assert.equal(warns[0].channel, 'log');
  assert.equal(warns[0].level, 'warn');
  assert.equal(warns[0].data.channel, 'bogus_chan');
  // 原始记录本身照常发出
  assert.ok(log.records.some((r) => r.channel === 'bogus_chan' && r.event === 'some.event'));
});

test('T-LG-3b 去重：同一未知通道只警告一次', () => {
  const log = createLogger({ level: 'all' });
  log.log('info', 'bogus_x', 'a', 'm');
  log.log('info', 'bogus_x', 'b', 'm');
  log.log('debug', 'bogus_x', 'c', 'm');
  const warns = log.records.filter((r) => r.event === 'log.unknownChannels');
  assert.equal(warns.length, 1, '同通道多次记录只警告一次');
  assert.equal(log.records.length, 4, '3 条原始记录 + 1 条警告');
});

test('T-LG-3c 不同未知通道各自警告一次', () => {
  const log = createLogger({ level: 'all' });
  log.log('info', 'bogus_1', 'a', 'm');
  log.log('info', 'bogus_2', 'a', 'm');
  const warns = log.records.filter((r) => r.event === 'log.unknownChannels').map((r) => r.data.channel);
  assert.deepEqual(warns, ['bogus_1', 'bogus_2']);
});

test('T-LG-3d 已注册通道与 log 通道自身永不触发未知通道警告', () => {
  const log = createLogger({ level: 'all' });
  for (const ch of ['rng', 'field', 'effects', 'items', 'roles', 'skills', 'bullets',
    'engine', 'damage', 'ai.ast', 'ai.runtime', 'unlock', 'api', 'cli', 'ranked',
    'store', 'view', 'render', 'editor', 'perf', 'log']) {
    log.log('info', ch, 'e', 'm');
  }
  assert.equal(log.records.filter((r) => r.event === 'log.unknownChannels').length, 0);
});

test('T-LG-3e 被过滤掉的未知通道记录不触发警告（廉价路径）', () => {
  const log = createLogger({ level: 'error' });
  assert.equal(log.log('trace', 'bogus_quiet', 'e', 'm'), false);
  assert.equal(log.log('debug', 'bogus_quiet', 'e', 'm'), false);
  assert.equal(log.records.length, 0, '无记录也无警告');
});

test('T-LG-3f reset 清空去重集：reset 后可再次警告', () => {
  const log = createLogger({ level: 'all' });
  log.log('info', 'bogus_r', 'a', 'm');
  assert.equal(log.records.filter((r) => r.event === 'log.unknownChannels').length, 1);
  log.reset();
  log.log('info', 'bogus_r', 'b', 'm');
  assert.equal(log.records.filter((r) => r.event === 'log.unknownChannels').length, 1, 'reset 后重新警告');
});