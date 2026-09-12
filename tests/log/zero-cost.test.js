'use strict';
// T-LG-7 禁用零成本 / nullLogger —— 契约见 shared/README.md
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, nullLogger } = require('../../shared/log.js');

test('T-LG-7a nullLogger：on 恒 false、方法全无害、records 冻结空', () => {
  assert.equal(nullLogger.on('engine', 'fatal'), false);
  assert.equal(nullLogger.on('anything', 'trace'), false);
  assert.equal(nullLogger.log('info', 'engine', 'e', 'm'), false);
  assert.doesNotThrow(() => nullLogger.fatal('e', 'ev', 'm'));
  assert.doesNotThrow(() => nullLogger.error('e', 'ev', 'm'));
  assert.doesNotThrow(() => nullLogger.warn('e', 'ev', 'm'));
  assert.doesNotThrow(() => nullLogger.info('e', 'ev', 'm'));
  assert.doesNotThrow(() => nullLogger.debug('e', 'ev', 'm'));
  assert.doesNotThrow(() => nullLogger.trace('e', 'ev', 'm'));
  assert.doesNotThrow(() => nullLogger.setLevel('all'));
  assert.doesNotThrow(() => nullLogger.setChannelLevel('x', 'all'));
  assert.doesNotThrow(() => nullLogger.reset());
  assert.deepEqual(nullLogger.dump(), []);
  assert.equal(nullLogger.getLevel(), 'silent');
  assert.deepEqual(nullLogger.records, []);
  assert.equal(Object.isFrozen(nullLogger.records), true, 'records 冻结');
});

test('T-LG-7b silent 级 logger：载荷永不触碰（getter 陷阱）', () => {
  const log = createLogger({ level: 'silent' });
  const data = {};
  Object.defineProperty(data, 'boom', { get() { throw new Error('载荷被构造了！'); } });
  assert.equal(log.log('info', 'bullets', 'e', 'm', data), false, '被过滤，不触碰载荷');
  assert.equal(log.log('fatal', 'bullets', 'e', 'm', data), false, 'silent 下 fatal 也不发');
  assert.equal(log.records.length, 0);
});

test('T-LG-7c 过滤路径不构造记录对象（返回值为证，载荷 getter 不触发）', () => {
  const log = createLogger({ level: 'error' });
  const data = {};
  Object.defineProperty(data, 'boom', { get() { throw new Error('载荷被构造了！'); } });
  assert.equal(log.log('debug', 'engine', 'e', 'm', data), false);
  assert.equal(log.records.length, 0);
});

test('T-LG-7d onRecord sink：只收到已发出的记录', () => {
  const seen = [];
  const log = createLogger({ level: 'warn', onRecord: (r) => seen.push(r) });
  log.log('info', 'engine', 'filtered', 'm');   // 被过滤
  log.log('warn', 'engine', 'emitted', 'm');    // 发出
  log.trace('bullets', 'filtered2', 'm');       // 被过滤
  assert.equal(seen.length, 1);
  assert.equal(seen[0].event, 'emitted');
  assert.equal(log.records.length, 1);
  // sink 收到与 records 相同对象（同一引用链）
  assert.equal(seen[0], log.records[0]);
});

test('T-LG-7e 未知通道警告属于 log 通道：sink 也会收到（warn 级别）', () => {
  const seen = [];
  const log = createLogger({ level: 'all', onRecord: (r) => seen.push(r) });
  log.log('info', 'bogus', 'e', 'm');
  assert.equal(seen.filter((r) => r.event === 'log.unknownChannels').length, 1);
});