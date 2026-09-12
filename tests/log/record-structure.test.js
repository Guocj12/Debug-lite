'use strict';
// T-LG-2 记录结构（含 cid/tick 提升）—— 契约见 shared/README.md
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');

test('T-LG-2a 完整字段：seq/ts/level/levelValue/channel/event/msg/data', () => {
  const log = createLogger({ level: 'all', now: () => 1234567890000 });
  log.log('debug', 'bullets', 'bullet.collide', 'L2 vs L4 @224', { atX: 224, winner: 'p1' });
  const r = log.records[0];
  assert.deepEqual(r, {
    seq: 0, ts: 1234567890000, cid: null, tick: null,
    level: 'debug', levelValue: 4, channel: 'bullets', event: 'bullet.collide',
    msg: 'L2 vs L4 @224', data: { atX: 224, winner: 'p1' },
  });
});

test('T-LG-2b cid/tick 从 data 提升到顶层并从 data 移除；缺省为 null', () => {
  const log = createLogger({ level: 'all' });
  log.log('info', 'skills', 'skill.cast', 'm', { cid: 't17:p1:3', tick: 17, mp: -8 });
  const r = log.records[0];
  assert.equal(r.cid, 't17:p1:3');
  assert.equal(r.tick, 17);
  assert.deepEqual(r.data, { mp: -8 }, 'cid/tick 不应残留在 data');
  log.log('info', 'engine', 'tick.begin', 'm');
  assert.equal(log.records[1].cid, null);
  assert.equal(log.records[1].tick, null);
});

test('T-LG-2c seq 单调递增；消息强制字符串（数字→串、undefined→空串）', () => {
  const log = createLogger({ level: 'all' });
  log.warn('engine', 'a', 42);
  log.warn('engine', 'b');
  log.warn('engine', 'c', '', { x: 1 });
  assert.deepEqual(log.records.map((r) => r.seq), [0, 1, 2]);
  assert.equal(log.records[0].msg, '42');
  assert.equal(log.records[1].msg, '');
  assert.equal(log.records[2].msg, '');
});

test('T-LG-2d dump() 是快照：修改返回值不影响内部', () => {
  const log = createLogger({ level: 'all' });
  log.info('engine', 'a', 'm');
  const snap = log.dump();
  snap.push({ fake: true });
  snap[0].data.x = 999;
  assert.equal(log.records.length, 1);
  assert.deepEqual(log.records[0].data, {});
  assert.deepEqual(log.dump(), log.records, 'dump 与 records 内容一致');
});

test('T-LG-2e 非法参数：级别/channel/event 校验', () => {
  const log = createLogger({ level: 'all' });
  assert.throws(() => log.log('bogus', 'engine', 'e', 'm'), RangeError);
  assert.throws(() => log.log('info', '', 'e', 'm'), RangeError);
  assert.throws(() => log.log('info', 'engine', '', 'm'), RangeError);
  assert.throws(() => log.log('info', 42, 'e', 'm'), RangeError, 'channel 非字符串');
});

test('T-LG-2f null data / data 非对象视为空', () => {
  const log = createLogger({ level: 'all' });
  log.info('engine', 'a', 'm', null);
  log.info('engine', 'b', 'm', 'not-an-object');
  assert.deepEqual(log.records[0].data, {});
  assert.deepEqual(log.records[1].data, {});
});