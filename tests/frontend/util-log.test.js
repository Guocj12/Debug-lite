'use strict';
// P6 F0：前端日志封装 —— frontend-spec §2（环境无关；注入 logger/sink；noop 兜底）
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('util/log：无 window 无注入 → noop 兜底安全（node 环境）', async () => {
  const mod = await import('../../public/js/util/log.js');
  const log = mod.createFrontLog(undefined, {});
  assert.doesNotThrow(() => {
    log.fatal('ui', 'ev.a', 'm');
    log.error('ui', 'ev.a', 'm');
    log.warn('ui', 'ev.a', 'm');
    log.info('ui', 'ev.a', 'm', { x: 1 });
    log.debug('ui', 'ev.a', 'm');
    log.trace('ui', 'ev.a', 'm');
    log.log('warn', 'ui', 'ev.a', 'm');
    log.setLevel('debug');
    log.setChannelLevel('render', 'trace');
  });
});

test('util/log：注入 logger → 方法面转发 + sink 收集（消息/数据原样）', async () => {
  const mod = await import('../../public/js/util/log.js');
  const sink = [];
  const stub = {
    warn: (...a) => sink.push(['warn', ...a]),
    log: (...a) => sink.push(['log', ...a]),
    setLevel: () => { sink.push(['setLevel']); },
    setChannelLevel: () => { sink.push(['setChannelLevel']); },
  };
  const log = mod.createFrontLog(undefined, { logger: stub, sink });
  log.warn('channelA', 'ev.a', 'msg', { x: 1 });
  log.log('info', 'channelB', 'ev.b', 'm2');
  log.setLevel('all');
  log.setChannelLevel('render', 'trace');
  assert.equal(sink.length, 4);
  assert.deepEqual(sink[0], ['warn', 'channelA', 'ev.a', 'msg', { x: 1 }]);
  assert.deepEqual(sink[1], ['log', 'info', 'channelB', 'ev.b', 'm2']);
  assert.equal(log.raw, stub);
});

test('util/log：浏览器形态（window.DLLog 桩）→ 引导级别/localStorage 通道 + sink/onRecord', async () => {
  const mod = await import('../../public/js/util/log.js');
  const records = [];
  const created = [];
  const LV = { silent: 0, fatal: 1, error: 2, warn: 3, info: 4, debug: 5, trace: 7, all: 8 };
  const fakeDLLog = {
    parseLevel: (s) => (LV[s] === undefined ? null : LV[s]),
    createLogger: (opts) => {
      created.push(opts);
      return {
        info: (...a) => {
          if (opts.onRecord) opts.onRecord({ level: 'info', channel: a[0], event: a[1], msg: a[2], tick: null, cid: null });
          records.push(a);
        },
        warn: () => {}, setLevel: () => {}, setChannelLevel: () => {}, log: () => {},
      };
    },
  };
  // 形态 A：localStorage.logPrefs（level + channels，含非法通道值走 parseLevel null 臂）
  const sinkA = [];
  const winA = {
    DLLog: fakeDLLog, location: { href: 'http://x/' },
    localStorage: { getItem: () => JSON.stringify({ level: 'info', channels: { render: 'trace', api: 'bogus' } }) },
  };
  const logA = mod.createFrontLog(winA, { sink: sinkA });
  logA.info('ui', 'ev.c', 'm3');
  assert.equal(created[0].level, 4, 'localStorage.logPrefs.level 引导（parseLevel → 数值 4=info）');
  assert.equal(created[0].level, LV.info, '与桩映射一致');
  assert.equal(sinkA.length, 1, 'onRecord → sink 收集');
  assert.equal(sinkA[0].event, 'ev.c');
  // 形态 B：URL ?log=bogus → parseLevel null → 默认 all
  const winB = { DLLog: fakeDLLog, location: { href: 'http://x/?log=bogus' }, localStorage: null };
  const logB = mod.createFrontLog(winB, {});
  logB.info('ui', 'ev.d', 'm4');
  assert.equal(created[1].level, 'all', '非法级别 → all');
  // 形态 C：win 存在但注入 logger 优先（不经 DLLog.createLogger）
  const stub = { info: (...a) => records.push(['stub', ...a]), setLevel: () => {}, setChannelLevel: () => {}, log: () => {} };
  const logC = mod.createFrontLog(winA, { logger: stub });
  logC.info('ui', 'ev.e', 'm5');
  assert.equal(created.length, 2, '注入 logger 优先，不再创建');
  assert.equal(records[records.length - 1][0], 'stub');
  // 形态 D：localStorage 抛异常 → catch 臂 + ?log= 回退引导（P2-2 修复实证）
  const winD = {
    DLLog: fakeDLLog,
    location: { href: 'http://x/?log=trace' },
    localStorage: { getItem: () => { throw new Error('denied'); } },
  };
  const logD = mod.createFrontLog(winD, {});
  logD.info('ui', 'ev.f', 'm6');
  assert.equal(created[2].level, 7, 'localStorage 异常 → ?log=trace 回退生效');
});

test('app.js boot：注入 fetch 成功/失败两分支 + 默认启动不抛', async () => {
  const mod = await import('../../public/js/app.js');
  const msgs = [];
  const stubLog = {
    info: (ch, ev, msg) => msgs.push([ev, msg]),
    warn: (ch, ev, msg) => msgs.push([ev, msg]),
    setLevel: () => {}, setChannelLevel: () => {},
  };
  const data = await mod.boot({
    fetchImpl: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { version: 'v1' } }) }),
    log: stubLog,
  });
  assert.equal(data.ok, true);
  assert.ok(msgs[0][1].includes('bootstrap'), 'store.boot 启动日志');
  const bad = await mod.boot({
    fetchImpl: () => Promise.reject(new Error('boom')),
    log: stubLog,
  });
  assert.equal(bad, null);
  assert.ok(msgs.some(([ev, msg]) => ev === 'store.boot' && msg === 'server unreachable'), '失败分支 warn');
  const none = await mod.boot({ fetchImpl: null, log: stubLog });
  assert.equal(none, null, '无 fetch 环境 → resolve null（!f 分支）');
});