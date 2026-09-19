'use strict';
/* tests/unit/auth-limiter.test.js —— 登录失败限速与锁定（P7-2/B28；D-129 §4.2/§4.6）
 * 纯单元：createFailureLimiter（注入时钟）——用户名连续失败锁定、IP 每分钟滑动窗口、成功清零、
 * 与 service-config 默认值（maxFailures=5 / lockMinutes=5 / rateLimitPerMinute=10）的接线。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFailureLimiter } = require('../../server/auth.js');
const { DEFAULT_SERVICE_CONFIG } = require('../../server/store/config.js');
const { makeClock } = require('../helpers/account.js');

test('LIM-1 同一用户名连续失败 maxFailures 次 → 锁 lockMinutes；锁定期满解锁且计数清零', () => {
  const clock = makeClock(1700000000000);
  const lim = createFailureLimiter({ config: { maxFailures: 3, lockMinutes: 5, rateLimitPerMinute: 100 }, now: clock });
  assert.equal(lim.begin({ usernameLower: 'u1', ip: '1.1.1.1' }).ok, true);
  assert.equal(lim.failure({ usernameLower: 'u1' }).locked, false);
  assert.equal(lim.failure({ usernameLower: 'u1' }).locked, false);
  const third = lim.failure({ usernameLower: 'u1' });
  assert.equal(third.locked, true, '第 maxFailures 次失败触发锁定');
  assert.equal(third.lockMs, 300000);
  const blocked = lim.begin({ usernameLower: 'u1', ip: '1.1.1.1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, 'too_many_attempts');
  assert.equal(blocked.reason, 'username_locked');
  assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 300000);
  assert.equal(lim.lockedUntil('U1'), third.lockedUntil, '用户名大小写不敏感');
  // 其他用户名不受影响
  assert.equal(lim.begin({ usernameLower: 'u2', ip: '1.1.1.1' }).ok, true);
  // 锁定期满：解锁 + 计数清零（再失败 1 次不锁）
  for (let i = 0; i < 301; i += 1) clock();
  assert.equal(lim.lockedUntil('u1'), null);
  assert.equal(lim.begin({ usernameLower: 'u1', ip: '1.1.1.1' }).ok, true);
  assert.equal(lim.failure({ usernameLower: 'u1' }).locked, false, '解锁后计数已清零');
  assert.equal(lim.failure({ usernameLower: 'u1' }).locked, false);
  assert.equal(lim.failure({ usernameLower: 'u1' }).locked, true);
});

test('LIM-2 同一 IP 每分钟 > rateLimitPerMinute 次尝试 → too_many_attempts（滑动窗口）', () => {
  const clock = makeClock(1700000000000);
  const lim = createFailureLimiter({ config: { maxFailures: 99, lockMinutes: 5, rateLimitPerMinute: 3 }, now: clock });
  assert.equal(lim.begin({ usernameLower: 'a', ip: '2.2.2.2' }).ok, true);
  assert.equal(lim.begin({ usernameLower: 'b', ip: '2.2.2.2' }).ok, true);
  assert.equal(lim.begin({ usernameLower: 'c', ip: '2.2.2.2' }).ok, true);
  const fourth = lim.begin({ usernameLower: 'd', ip: '2.2.2.2' });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, 'ip_rate_limited');
  assert.equal(fourth.code, 'too_many_attempts');
  assert.ok(fourth.retryAfterMs > 0);
  // 别的 IP / 不带 IP 不受影响
  assert.equal(lim.begin({ usernameLower: 'd', ip: '3.3.3.3' }).ok, true);
  assert.equal(lim.begin({ usernameLower: 'd' }).ok, true);
  // 窗口滑过 60s → 放行
  for (let i = 0; i < 61; i += 1) clock();
  assert.equal(lim.begin({ usernameLower: 'd', ip: '2.2.2.2' }).ok, true);
  assert.deepEqual(lim.stats(), { locked: 0, ips: 2, maxFailures: 99, lockMs: 300000, rateLimit: 3, windowMs: 60000 });
});

test('LIM-3 success 清零失败计数；reset 清空全部状态；缺省参数与 service-config 一致', () => {
  const clock = makeClock(1700000000000);
  const defaults = createFailureLimiter({ config: DEFAULT_SERVICE_CONFIG.auth, now: clock });
  assert.equal(defaults.maxFailures, 5, '§4.2：连续失败 5 次');
  assert.equal(defaults.lockMs, 5 * 60000, '§4.2：锁 5 分钟');
  assert.equal(defaults.rateLimit, 10, '§4.6：10 次/分/IP');
  const lim = createFailureLimiter({ config: { maxFailures: 2, lockMinutes: 1, rateLimitPerMinute: 10 }, now: clock });
  lim.begin({ usernameLower: 'x', ip: '4.4.4.4' });
  lim.failure({ usernameLower: 'x' });
  lim.success({ usernameLower: 'x' });
  assert.equal(lim.failure({ usernameLower: 'x' }).locked, false, '成功后续失败计数从 0 起');
  assert.equal(lim.failure({ usernameLower: 'x' }).locked, true);
  lim.reset();
  assert.equal(lim.lockedUntil('x'), null);
  assert.equal(lim.begin({ usernameLower: 'x', ip: '4.4.4.4' }).ok, true);
  // 无用户名键（非法形状）不记失败
  assert.equal(lim.failure({}).locked, false);
  assert.equal(lim.failure({ usernameLower: null }).threshold, 2);
});
