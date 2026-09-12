'use strict';
/* tests/helpers/log.js —— 录制 logger + 日志断言（P0-4，契约见 shared/README.md）
 * §4.9：createRecordingLogger / assertEvent / countEvents / assertCidChain
 */
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');

// 便捷构造：全捕获 logger（level=all；ringSize/now 可注入）
function createRecordingLogger(opts) {
  const o = opts || {};
  return createLogger({ level: 'all', ringSize: o.ringSize, now: o.now });
}

// 存在 ≥1 条 (channel, event) 匹配记录（可选谓词）；否则抛 AssertionError；返回匹配记录
function assertEvent(logger, channel, event, predicate) {
  const matches = logger.records.filter(
    (r) => r.channel === channel && r.event === event && (!predicate || predicate(r))
  );
  assert.ok(matches.length > 0, `缺少事件 ${channel}.${event}（共 ${logger.records.length} 条记录）`);
  return matches;
}

// 统计事件条数；channel 缺省 = 全部通道
function countEvents(logger, event, channel) {
  return logger.records.filter(
    (r) => r.event === event && (channel === undefined || r.channel === channel)
  ).length;
}

// 同 cid 的事件链：按出现顺序（子序列，不必连续）；缺链/乱序抛错；返回匹配记录
function assertCidChain(logger, cid, events) {
  const byCid = logger.records.filter((r) => r.cid === cid);
  const chain = [];
  let cursor = 0;
  for (const ev of events) {
    let found = -1;
    for (let j = cursor; j < byCid.length; j++) {
      if (byCid[j].event === ev) { found = j; break; }
    }
    assert.ok(found !== -1,
      `cid ${cid} 的链路缺少事件 ${ev}（已匹配 ${chain.map((c) => c.event).join(' -> ')}）`);
    chain.push(byCid[found]);
    cursor = found + 1;
  }
  return chain;
}

module.exports = { createRecordingLogger, assertEvent, countEvents, assertCidChain };