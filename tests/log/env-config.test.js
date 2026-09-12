'use strict';
// T-LG-1/2 补充：env 解析与默认级别 —— DL_LOG_LEVEL / DL_LOG_CHANNELS 语义（§4.5）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger, parseLevel, parseChannelOverrides } = require('../../shared/log.js');

test('T-LG-1i parseLevel：名字（大小写不敏感）/数字串/非法', () => {
  assert.equal(parseLevel('trace'), 5);
  assert.equal(parseLevel('TRACE'), 5);
  assert.equal(parseLevel('Debug'), 4);
  assert.equal(parseLevel('silent'), -1);
  assert.equal(parseLevel('all'), 99);
  assert.equal(parseLevel('5'), 5);
  assert.equal(parseLevel('-1'), -1);
  assert.equal(parseLevel('bogus'), null);
  assert.equal(parseLevel(''), null);
  assert.equal(parseLevel(undefined), null);
  assert.equal(parseLevel('  warn  '), 2, '容忍空白');
});

test('T-LG-1j parseChannelOverrides：空串/畸形段跳过、合法段解析', () => {
  assert.deepEqual(parseChannelOverrides(''), {});
  assert.deepEqual(parseChannelOverrides('bullets=trace'), { bullets: 5 });
  assert.deepEqual(parseChannelOverrides('bullets=trace, ai.runtime=debug'), { bullets: 5, 'ai.runtime': 4 });
  assert.deepEqual(parseChannelOverrides('bad'), {}, '无等号丢弃');
  assert.deepEqual(parseChannelOverrides('a='), {}, '空级别丢弃');
  assert.deepEqual(parseChannelOverrides('=trace'), {}, '空通道丢弃');
  assert.deepEqual(parseChannelOverrides('x=bogus'), {}, '非法级别丢弃');
  assert.deepEqual(parseChannelOverrides(' a = 3 , bullets=all'), { a: 3, bullets: 99 });
});

test('T-LG-1k 默认级别：无 env → debug（开发）；DL_LOG_LEVEL 覆盖；production → warn', () => {
  const savedLevel = process.env.DL_LOG_LEVEL;
  const savedEnv = process.env.NODE_ENV;
  try {
    delete process.env.DL_LOG_LEVEL;
    delete process.env.NODE_ENV;
    assert.equal(createLogger().getLevel(), 'debug', '开发默认 debug');
    process.env.NODE_ENV = 'production';
    assert.equal(createLogger().getLevel(), 'warn', 'production 默认 warn');
    process.env.DL_LOG_LEVEL = 'trace';
    assert.equal(createLogger().getLevel(), 'trace', 'DL_LOG_LEVEL 覆盖一切');
    process.env.DL_LOG_LEVEL = 'bogus';
    assert.equal(createLogger().getLevel(), 'warn', '非法 DL_LOG_LEVEL 回退默认');
  } finally {
    if (savedLevel === undefined) delete process.env.DL_LOG_LEVEL; else process.env.DL_LOG_LEVEL = savedLevel;
    if (savedEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedEnv;
  }
});