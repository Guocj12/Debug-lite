'use strict';
// P6 R0 util/log 三态契约测试 —— spec §1.3 步骤1 + §2.2 总控；实现 public/js/util/log.js（ESM，每用例动态导入）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');

// fake window：DLLog 桩（记录 setLevel/setChannelLevel 调用）+ localStorage 桩
function fakeDLLog() {
  const calls = { levels: [], channelLevels: [] };
  const stub = {
    setLevel: (l) => calls.levels.push(l),
    setChannelLevel: (c, l) => calls.channelLevels.push([c, l]),
    debug: () => true, info: () => true, warn: () => true, error: () => true, trace: () => true,
  };
  return { stub, calls };
}

function fakeStorage(map) {
  const m = map || {};
  return { getItem: (k) => (k in m ? m[k] : null) };
}

test('R0 形态1：无 window 无注入 → noop 兜底（node 环境），方法安全 dump 空表', async () => {
  const logMod = await import('../../public/js/util/log.js');
  const util = logMod.bootLogging({});
  assert.equal(typeof util.debug, 'function');
  assert.doesNotThrow(() => util.debug('ui', 'ui.click', 'x', {}));
  assert.doesNotThrow(() => util.info('ui', 'ui.click', 'x'));
  assert.doesNotThrow(() => util.warn('ui', 'ui.click', 'x'));
  assert.doesNotThrow(() => util.error('ui', 'ui.click', 'x'));
  assert.doesNotThrow(() => util.trace('ui', 'ui.click', 'x'));
  assert.doesNotThrow(() => util.setLevel('trace'));
  assert.doesNotThrow(() => util.setChannelLevel('render', 'debug'));
  assert.deepEqual(util.dump(), []);
  assert.deepEqual(util.records(), []);
});

test('R0 形态2：注入 logger → 方法面转发 + dump/records 透传', async () => {
  const logMod = await import('../../public/js/util/log.js');
  const logger = createLogger({ level: 'debug' });
  const util = logMod.bootLogging({ logger });
  util.info('ui', 'ui.click', '点击', { boxId: 'btn_x' });
  util.debug('ui', 'ui.debug', 'd');
  util.warn('ui', 'ui.warn', 'w');
  util.error('ui', 'ui.err', 'e');
  util.setLevel('trace');
  util.setChannelLevel('render', 'debug');
  util.trace('ui', 'ui.trace', 't');
  assert.ok(logger.records.some((r) => r.channel === 'ui' && r.event === 'ui.click' && r.data.boxId === 'btn_x'));
  assert.ok(logger.records.some((r) => r.event === 'ui.trace'), 'setLevel(trace) 后 trace 转发应有记录');
  assert.equal(util.dump().length, logger.dump().length);
  assert.equal(util.records(), logger.records);
});

test('R0 parseLogParam：纯级别 / 通道覆盖(:) / 后端兼容(=) / 畸形跳过 / 空', async () => {
  const logMod = await import('../../public/js/util/log.js');
  assert.deepEqual(logMod.parseLogParam('trace'), { level: 'trace', channels: {} });
  assert.deepEqual(logMod.parseLogParam('ui:trace,render:debug'), { level: null, channels: { ui: 'trace', render: 'debug' } });
  assert.deepEqual(logMod.parseLogParam('ui=trace'), { level: null, channels: { ui: 'trace' } });
  assert.deepEqual(logMod.parseLogParam('nope,x:,'), { level: null, channels: {} });
  assert.deepEqual(logMod.parseLogParam(''), { level: null, channels: {} });
  assert.deepEqual(logMod.parseLogParam(null), { level: null, channels: {} });
});

test('R0 readLogPrefs：合法/畸形 JSON/非对象/未知级别键剔除/缺 storage', async () => {
  const logMod = await import('../../public/js/util/log.js');
  assert.deepEqual(logMod.readLogPrefs(null), {});
  assert.deepEqual(logMod.readLogPrefs(fakeStorage({})), {});
  assert.deepEqual(
    logMod.readLogPrefs(fakeStorage({ 'dl.v3.logPrefs': JSON.stringify({ level: 'trace', channels: { render: 'debug' } }) })),
    { level: 'trace', channels: { render: 'debug' } }
  );
  assert.deepEqual(logMod.readLogPrefs(fakeStorage({ 'dl.v3.logPrefs': '{bad json' })), {});
  assert.deepEqual(logMod.readLogPrefs(fakeStorage({ 'dl.v3.logPrefs': JSON.stringify('arr') })), {});
  // 未知级别名被丢弃、channels 畸形被丢弃
  assert.deepEqual(
    logMod.readLogPrefs(fakeStorage({ 'dl.v3.logPrefs': JSON.stringify({ level: 'loud', channels: [1, 2] }) })),
    {}
  );
});

test('R0 urlLogParam：?log= 取值/解码/畸形编码/缺值', async () => {
  const logMod = await import('../../public/js/util/log.js');
  assert.equal(logMod.urlLogParam('?log=trace'), 'trace');
  assert.equal(logMod.urlLogParam('?a=1&log=ui%3Atrace'), 'ui:trace');
  assert.equal(logMod.urlLogParam('?log=%zz'), '%zz', '解码失败回退原值');
  assert.equal(logMod.urlLogParam('?log'), '');
  assert.equal(logMod.urlLogParam('?a=1'), '');
  assert.equal(logMod.urlLogParam(''), '');
});

test('R0 形态3：浏览器引导 —— 默认 debug + render:trace，应用至 DLLog', async () => {
  const logMod = await import('../../public/js/util/log.js');
  const { stub, calls } = fakeDLLog();
  const win = { DLLog: stub, localStorage: fakeStorage({}), location: { search: '' } };
  const util = logMod.bootLogging({ win, storage: win.localStorage });
  assert.deepEqual(calls.levels, ['debug']);
  assert.deepEqual(calls.channelLevels, [['render', 'trace']]);
  util.debug('ui', 'ui.click', 'c');
  util.info('ui', 'ui.info', 'i');
  util.warn('ui', 'ui.warn', 'w');
  util.error('ui', 'ui.err', 'e');
  util.trace('ui', 'ui.trace', 't');
  util.setLevel('trace');
  util.setChannelLevel('render', 'debug');
  assert.equal(calls.levels.length, 2, 'setLevel 透传应再应用一次');
  assert.equal(typeof util.dump, 'function');
});

test('R0 形态3：logPrefs 覆盖默认，URL ?log= 最高优先', async () => {
  const logMod = await import('../../public/js/util/log.js');
  const a = fakeDLLog();
  const winA = { DLLog: a.stub, location: { search: '' }, localStorage: fakeStorage({ 'dl.v3.logPrefs': JSON.stringify({ level: 'trace', channels: { ui: 'debug' } }) }) };
  logMod.bootLogging({ win: winA, storage: winA.localStorage });
  assert.deepEqual(a.calls.levels, ['trace']);
  assert.ok(a.calls.channelLevels.some(([c, l]) => c === 'ui' && l === 'debug'));
  assert.ok(a.calls.channelLevels.some(([c, l]) => c === 'render' && l === 'trace'));

  // URL 覆盖 prefs（级别 + 通道）
  const b = fakeDLLog();
  const winB = { DLLog: b.stub, location: { search: '?log=warn,ui:error' }, localStorage: fakeStorage({ 'dl.v3.logPrefs': JSON.stringify({ level: 'trace' }) }) };
  logMod.bootLogging({ win: winB, storage: winB.localStorage });
  assert.deepEqual(b.calls.levels, ['warn']);
  assert.deepEqual(b.calls.channelLevels, [['render', 'trace'], ['ui', 'error']]);
});

test('R0 形态3：无 DLLog / 无 setLevel 的 window → noop；location 缺失不抛', async () => {
  const logMod = await import('../../public/js/util/log.js');
  assert.deepEqual(Object.keys(logMod.bootLogging({ win: {} })), Object.keys(logMod.bootLogging({})));
  assert.doesNotThrow(() => logMod.bootLogging({ win: { DLLog: { setLevel: () => {} } } }));
  const { stub, calls } = fakeDLLog();
  logMod.bootLogging({ win: { DLLog: stub, location: undefined }, storage: fakeStorage({}) });
  assert.deepEqual(calls.levels, ['debug'], 'location 缺失时仍应用默认级别');
});
