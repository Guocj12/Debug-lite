'use strict';
// P0-4 tests/helpers/log.js 契约测试 —— 契约见 shared/README.md「tests/helpers/log.js 契约」
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRecordingLogger, assertEvent, countEvents, assertCidChain } = require('./log.js');

test('H-1 createRecordingLogger：level=all 全捕获，seq/ts 可注入', () => {
  const log = createRecordingLogger({ ringSize: 50 });
  log.info('engine', 'a', 'm');
  log.trace('bullets', 'b', 'm');
  assert.equal(log.records.length, 2);
  assert.equal(log.records[0].level, 'info');
  assert.equal(log.records[1].level, 'trace', 'trace 也捕获');

  const t0 = createRecordingLogger({ now: () => 777 });
  t0.trace('bullets', 'c', 'm');
  assert.equal(t0.records[0].ts, 777, 'now 注入生效');
});

test('H-2 assertEvent：命中返回匹配记录；缺失抛 AssertionError；谓词过滤', () => {
  const log = createRecordingLogger();
  log.info('skills', 'skill.cast', 'm', { sid: 'skill1' });
  log.info('skills', 'skill.cast', 'm', { sid: 'skill2' });
  const got = assertEvent(log, 'skills', 'skill.cast');
  assert.equal(got.length, 2);
  assert.throws(() => assertEvent(log, 'skills', 'skill.reject'), assert.AssertionError);
  const filtered = assertEvent(log, 'skills', 'skill.cast', (r) => r.data.sid === 'skill2');
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].data.sid, 'skill2');
  assert.throws(() => assertEvent(log, 'skills', 'skill.cast', (r) => r.data.sid === 'nope'), assert.AssertionError);
});

test('H-3 countEvents：带/不带通道统计', () => {
  const log = createRecordingLogger();
  log.info('engine', 'tick.begin', 'm');
  log.info('bullets', 'tick.begin', 'm');
  log.warn('engine', 'tick.begin', 'm');
  assert.equal(countEvents(log, 'tick.begin'), 3, '全通道');
  assert.equal(countEvents(log, 'tick.begin', 'engine'), 2);
  assert.equal(countEvents(log, 'tick.begin', 'bullets'), 1);
  assert.equal(countEvents(log, '不存在'), 0);
});

test('H-4 assertCidChain：同 cid 子序列（允许穿插）；缺链/乱序抛错；异 cid 互不干扰', () => {
  const log = createRecordingLogger();
  log.info('skills', 'skill.cast', 'm', { cid: 't1:p1:1' });
  log.info('engine', 'tick.end', 'm', { cid: 't1:p1:1' });           // 穿插（同 cid 的其它事件）
  log.info('bullets', 'bullet.hit', 'm', { cid: 't1:p1:1' });
  log.info('skills', 'skill.cast', 'm', { cid: 't1:p2:1' });         // 异 cid
  log.info('damage', 'damage.calc', 'm', { cid: 't1:p1:1' });

  const chain = assertCidChain(log, 't1:p1:1', ['skill.cast', 'bullet.hit', 'damage.calc']);
  assert.deepEqual(chain.map((r) => r.event), ['skill.cast', 'bullet.hit', 'damage.calc']);
  assert.ok(chain.every((r) => r.cid === 't1:p1:1'));

  assert.throws(() => assertCidChain(log, 't1:p1:1', ['skill.cast', 'missing', 'damage.calc']), assert.AssertionError);
  assert.throws(() => assertCidChain(log, 't1:p1:1', ['damage.calc', 'skill.cast']), assert.AssertionError, '乱序（skill.cast 在 damage.calc 之后出现）抛错');
  assert.deepEqual(assertCidChain(log, 't1:p1:1', []), [], '空链恒真');
  assert.throws(() => assertCidChain(log, 'cid_不存在', ['skill.cast']), assert.AssertionError);
});