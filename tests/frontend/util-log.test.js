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
  // 形态 A：localStorage.logPrefs（dl.v3.logPrefs key，P1-5）——level + channels（含非法通道值走 parseLevel null 臂）
  const sinkA = [];
  const lsKeys = [];
  const winA = {
    DLLog: fakeDLLog, location: { href: 'http://x/' },
    localStorage: {
      getItem: (k) => {
        lsKeys.push(k);
        return JSON.stringify({ level: 'info', channels: { render: 'trace', api: 'bogus' } });
      },
    },
  };
  const logA = mod.createFrontLog(winA, { sink: sinkA });
  logA.info('ui', 'ev.c', 'm3');
  assert.equal(created[0].level, 4, 'localStorage.logPrefs.level 引导（parseLevel → 数值 4=info）');
  assert.equal(created[0].level, LV.info, '与桩映射一致');
  assert.ok(lsKeys.includes('dl.v3.logPrefs'), 'P1-5：读取 dl.v3.logPrefs 键');
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

test('app.js boot：健康检查两分支 + !f 分支 + 默认启动不抛 + menu goto', async () => {
  const mod = await import('../../public/js/app.js');
  const msgs = [];
  const stubLog = {
    info: (ch, ev, msg) => msgs.push([ev, msg]),
    warn: (ch, ev, msg) => msgs.push([ev, msg]),
    debug: () => {},
    error: () => {},
    setLevel: () => {}, setChannelLevel: () => {},
  };
  const bootA = await mod.boot({
    fetchImpl: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { version: 'v1', tableNames: ['x'] } }) }),
    log: stubLog,
  });
  await bootA.health; // meta/loaded 异步落定
  assert.equal(bootA.store.getState().screen, 'menu', 'boot 后 goto menu');
  assert.equal(bootA.store.getState().meta.serverOk, true, 'meta/loaded 生效');
  assert.ok(msgs.some(([ev]) => ev === 'store.boot'), 'store.boot 日志');
  const bootB = await mod.boot({
    fetchImpl: () => Promise.reject(new Error('boom')),
    log: stubLog,
  });
  await bootB.health; // 失败分支异步落定
  assert.ok(msgs.some(([ev, msg]) => ev === 'store.boot' && msg === 'server unreachable'), '失败分支 warn');
  const bootC = await mod.boot({ fetchImpl: null, log: stubLog });
  assert.equal(bootC.store.getState().screen, 'menu', '无 fetch 也正常 goto（!f 分支）');
  assert.equal(typeof bootC.api.raw, 'function', 'api 就绪（createApi 全局 fetch 兜底）');
  // skipMount 分支（doc 存在但跳过挂载）+ d.records 注入
  const fakeDoc = { getElementById: () => null, createElement: () => ({ id: '' }), addEventListener: () => {}, removeEventListener: () => {} };
  const recs = [{ level: 'info', levelValue: 4, channel: 'ui', event: 'x' }];
  const bootD = await mod.boot({
    fetchImpl: () => Promise.resolve({ text: () => Promise.resolve('{"ok":true,"data":{}}') }),
    log: stubLog, doc: fakeDoc, skipMount: true, records: () => recs, loadPersist: () => null,
  });
  assert.equal(bootD.mount, null, 'skipMount → 不挂载');
});