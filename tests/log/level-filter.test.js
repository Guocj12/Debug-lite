'use strict';
// T-LG-1 级别/通道过滤 —— 契约见 shared/README.md「shared/log.js 契约」
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, LEVELS } = require('../../shared/log.js');

test('T-LG-1a 全局级别门控：warn 级别只发 warn 及以上', () => {
  const log = createLogger({ level: 'warn' });
  assert.equal(log.log('error', 'engine', 'e', 'm'), true, 'error 应发出');
  assert.equal(log.log('warn', 'engine', 'e', 'm'), true, 'warn 应发出');
  assert.equal(log.log('info', 'engine', 'e', 'm'), false, 'info 应被过滤');
  assert.equal(log.log('debug', 'engine', 'e', 'm'), false, 'debug 应被过滤');
  assert.equal(log.log('trace', 'engine', 'e', 'm'), false, 'trace 应被过滤');
  assert.equal(log.records.length, 2);
});

test('T-LG-1b 边界级别：silent 全静默、all 全发、fatal 恒发', () => {
  const silent = createLogger({ level: 'silent' });
  assert.equal(silent.log('fatal', 'engine', 'e', 'm'), false);
  assert.equal(silent.records.length, 0);
  const all = createLogger({ level: 'all' });
  assert.equal(all.log('trace', 'engine', 'e', 'm'), true);
  assert.equal(all.records.length, 1);
  const fatal = createLogger({ level: 'fatal' });
  assert.equal(fatal.log('fatal', 'engine', 'e', 'm'), true);
  assert.equal(fatal.log('error', 'engine', 'e', 'm'), false, 'fatal 级别下 error 被过滤');
});

test('T-LG-1c 数值级别：setLevel 接受数值、数字串、名字', () => {
  const log = createLogger({ level: 4 }); // debug
  assert.equal(log.log('trace', 'engine', 'e', 'm'), false);
  log.setLevel('all');
  assert.equal(log.log('trace', 'engine', 'e', 'm'), true);
  log.setLevel(2); // warn
  assert.equal(log.log('info', 'engine', 'e', 'm'), false);
  assert.equal(log.log('warn', 'engine', 'e', 'm'), true);
  assert.equal(log.getLevel(), 'warn');
});

test('T-LG-1d 按通道覆盖：setChannelLevel 只影响该通道', () => {
  const log = createLogger({ level: 'warn' });
  log.setChannelLevel('bullets', 'trace');
  assert.equal(log.log('trace', 'bullets', 'e', 'm'), true, 'bullets 覆盖 trace 生效');
  assert.equal(log.log('trace', 'engine', 'e', 'm'), false, 'engine 仍被全局 warn 过滤');
  log.setChannelLevel('damage', 'silent');
  assert.equal(log.log('warn', 'damage', 'e', 'm'), false, 'damage 覆盖 silent 生效');
  assert.equal(log.log('warn', 'engine', 'e', 'm'), true, 'engine 不受影响');
  log.reset();
  assert.equal(log.log('trace', 'bullets', 'e', 'm'), false, 'reset 清除通道覆盖');
  assert.equal(log.log('warn', 'bullets', 'e', 'm'), true);
});

test('T-LG-1e 构建期 channels 选项生效；非法值抛错', () => {
  const log = createLogger({ level: 'error', channels: { bullets: 'all' } });
  assert.equal(log.log('trace', 'bullets', 'e', 'm'), true);
  assert.equal(log.log('trace', 'engine', 'e', 'm'), false);
  assert.throws(() => createLogger({ channels: { bullets: 'bogus' } }), RangeError, '非法通道级别 fail-fast');
  assert.throws(() => createLogger({ level: 'bogus' }), RangeError, '非法全局级别 fail-fast');
});

test('T-LG-1f on() 谓词与 payload 门控惯用法（§4.7）', () => {
  const log = createLogger({ level: 'debug' });
  assert.equal(log.on('engine', 'trace'), false);
  assert.equal(log.on('engine', 'debug'), true);
  assert.equal(log.on('engine', 'info'), true);
  log.setChannelLevel('engine', 'trace');
  assert.equal(log.on('engine', 'trace'), true);
  assert.throws(() => log.on('engine', 'bogus'), RangeError);
  // 惯用法：门控通过才构造载荷
  const gated = createLogger({ level: 'warn' });
  let built = 0;
  if (gated.on('bullets', 'trace')) built = 1; // 不应构造
  assert.equal(built, 0);
  if (gated.on('bullets', 'warn')) built = 2; // 应构造
  assert.equal(built, 2);
});

test('T-LG-1g 便捷方法级别映射', () => {
  const log = createLogger({ level: 'all' });
  log.fatal('engine', 'a'); log.error('engine', 'b'); log.warn('engine', 'c');
  log.info('engine', 'd'); log.debug('engine', 'e'); log.trace('engine', 'f');
  const expected = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];
  assert.deepEqual(log.records.map((r) => r.level), expected);
  assert.deepEqual(log.records.map((r) => r.levelValue), expected.map((n) => LEVELS[n]));
});

test('T-LG-1h 非字符串/非数字级别（null/对象）→ RangeError', () => {
  const log = createLogger({ level: 'all' });
  assert.throws(() => log.log(null, 'engine', 'e', 'm'), RangeError, 'null 级别');
  assert.throws(() => log.log({}, 'engine', 'e', 'm'), RangeError, '对象级别');
  assert.throws(() => createLogger({ level: {} }), RangeError, '构建期对象级别');
  assert.throws(() => log.setLevel(true), RangeError, '布尔级别');
});