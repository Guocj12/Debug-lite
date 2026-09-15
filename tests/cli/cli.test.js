'use strict';
// T-CLI-1/2 CLI 契约测试 —— 契约见 docs/interfaces.md §3（子命令/退出码 0/1/2；只走 HTTP）
// 闭环：同进程 start server (listen 0) + 注入 baseUrl 的 cli main（真实 node:http 传输，无 spawn）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const { start } = require('../../server/index.js');
const { main, bootstrap } = require('../../cli/index.js');

const SAVED_CONSOLE = { log: console.log, error: console.error };

// capture 必须等 fn() 的 Promise 落定后再恢复 console（CLI 输出发生在 await 之后）
async function capture(orig, fn) {
  const log = [];
  console[orig] = (...args) => log.push(args.map((a) => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
    return JSON.stringify(a);
  }).join(' '));
  try {
    const result = await fn();
    return { log, result };
  } finally {
    console[orig] = SAVED_CONSOLE[orig];
  }
}

async function withServer(t, fn) {
  const logger = createLogger({ level: 'debug', ringSize: 500 });
  const s = await start({ logger });
  try {
    await fn({ port: s.port, logger });
  } finally {
    await s.close();
  }
}

test('CLI-1 后端闭环：health → 退出码 0 + 信封输出', async () => {
  await withServer(null, async ({ port }) => {
    const out = await capture('log', () => main(['health'], { baseUrl: `http://127.0.0.1:${port}` }));
    assert.equal(out.result, 0, 'health 应 rc 0');
    assert.ok(out.log.some((l) => l.includes('"ok":true') || l.includes('"ok": true')), `stdout 应含 ok: ${out.log.join('|')}`);
  });
});

test('CLI-2 data battle-config：退出码 0 + 输出数据含 cellPx', async () => {
  await withServer(null, async ({ port }) => {
    const out = await capture('log', () => main(['data', 'battle-config'], { baseUrl: `http://127.0.0.1:${port}` }));
    assert.equal(out.result, 0);
    assert.ok(out.log.join('').includes('"cellPx": 64'), `输出应含 cellPx 64: ${out.log.join('|').slice(0, 200)}`);
  });
});

test('CLI-3 data 未知表 → 退出码 1（业务拒绝）+ 错误信息', async () => {
  await withServer(null, async ({ port }) => {
    const out = await capture('error', () => main(['data', 'nope'], { baseUrl: `http://127.0.0.1:${port}` }));
    assert.equal(out.result, 1, '404 业务拒绝应 rc 1');
    assert.ok(out.log.join('').includes('unknown_table'), `stderr 应含错误码: ${out.log.join('|')}`);
  });
});

test('CLI-4 未知子命令 → 退出码 2（参数错误）+ usage', async () => {
  const out = await capture('error', () => main(['frobnicate'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(out.result, 2);
  assert.ok(out.log.join('').includes('usage') || out.log.join('').toLowerCase().includes('unknown'), 'stderr 应含 usage/unknown');
});

test('CLI-5 data 缺参 / log 非法级别 → 退出码 2', async () => {
  const r1 = await capture('error', () => main(['data'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(r1.result, 2, 'data 缺参 rc 2');
  const r2 = await capture('error', () => main(['log', '--level', 'bogus'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(r2.result, 2, '非法级别 rc 2（本地校验）');
  const r3 = await capture('error', () => main(['log', '--channel', 'bad'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(r3.result, 2, '非法通道参数 rc 2');
});

test('CLI-6 服务端未运行 → 退出码 1（业务失败，连接拒绝）', async () => {
  const out = await capture('error', () => main(['health'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(out.result, 1, '连接拒绝应 rc 1');
  assert.ok(out.log.join('').length > 0, 'stderr 应有错误说明');
});

test('CLI-7 cli.invoke / cli.result 日志事件（信息完整性）', async () => {
  await withServer(null, async ({ port }) => {
    const logger = createLogger({ level: 'debug', ringSize: 500 });
    const out = await capture('log', () => main(['health'], { baseUrl: `http://127.0.0.1:${port}`, logger }));
    assert.equal(out.result, 0, 'health rc 0');
    assert.ok(logger.records.some((x) => x.event === 'cli.invoke' && x.data.argv.join(' ') === 'health'), '应有 cli.invoke');
    const res = logger.records.find((x) => x.event === 'cli.result');
    assert.ok(res, '应有 cli.result');
    assert.equal(res.data.code, 0);
    assert.equal(typeof res.data.durationMs, 'number');
  });
});

test('CLI-8 log 子命令闭环：--level trace 生效（真实服务端）', async () => {
  await withServer(null, async ({ port }) => {
    const base = `http://127.0.0.1:${port}`;
    const getLevel = () => new Promise((resolve, reject) => {
      const http = require('node:http');
      http.get(`${base}/api/v1/log-level`, (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve(JSON.parse(d)));
      }).on('error', reject);
    });
    const before = await getLevel();
    const out = await capture('log', () => main(['log', '--level', 'trace'], { baseUrl: base }));
    assert.equal(out.result, 0);
    const after = await getLevel();
    assert.equal(after.data.level, 'trace', '服务端级别应被 CLI 修改');
    assert.equal(before.data.level, 'debug');
    // 复位
    await capture('log', () => main(['log', '--level', 'debug'], { baseUrl: base }));
    assert.equal((await getLevel()).data.level, 'debug');
  });
});

test('CLI-9 log --channel ch=lv 闭环：通道覆盖生效', async () => {
  await withServer(null, async ({ port }) => {
    const base = `http://127.0.0.1:${port}`;
    const out = await capture('log', () => main(['log', '--channel', 'bullets=trace'], { baseUrl: base }));
    assert.equal(out.result, 0);
    // 服务端 logger 的 bullets 通道覆盖应生效（通过 CLI 再 GET 无法直接查到通道级别，但可再设置同级别不报错）
    const ok2 = await capture('log', () => main(['log', '--channel', 'bullets=trace'], { baseUrl: base }));
    assert.equal(ok2.result, 0, '重复设置通道级别不报错');
    // 非法通道级别 → CLI 本地校验 rc 2（参数错误）
    const bad = await capture('error', () => main(['log', '--channel', 'bullets=bogus'], { baseUrl: base }));
    assert.equal(bad.result, 2, '非法通道级别 rc 2');
  });
});

test('CLI-10 log 未知参数 → 退出码 2', async () => {
  const r = await capture('error', () => main(['log', '--nonsense'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(r.result, 2, '未知参数 rc 2');
});

test('CLI-11 服务端非 200 响应 → 退出码 1（health 500 / log-level 400 分支）', async () => {
  const routes = {
    GET: { '/api/v1/health': () => ({ status: 500, payload: { ok: false, error: { code: 'internal_error', message: 'boom', details: [] } } }) },
    POST: { '/api/v1/log-level': () => ({ status: 400, payload: { ok: false, error: { code: 'bad_level', message: 'bad', details: [] } } }) },
  };
  const logger = createLogger({ level: 'debug', ringSize: 500 });
  const s = await start({ logger, routes });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const h = await capture('error', () => main(['health'], { baseUrl: base }));
    assert.equal(h.result, 1, 'health 500 → rc 1');
    assert.ok(h.log.join('').includes('internal_error'), h.log.join(''));
    const l = await capture('error', () => main(['log', '--level', 'trace'], { baseUrl: base }));
    assert.equal(l.result, 1, 'log-level 400 → rc 1');
    assert.ok(l.log.join('').includes('bad_level'), l.log.join(''));
  } finally {
    await s.close();
  }
});

test('CLI-12 bootstrap 引导：可执行且设置 exitCode（进程内覆盖 standalone 路径）', async () => {
  const prev = process.exitCode;
  try {
    const out = await capture('error', () => bootstrap());
    assert.equal(process.exitCode, 2, 'bootstrap 对未知命令设 exitCode 2');
    assert.equal(out.result, undefined, 'bootstrap 无返回值');
  } finally {
    process.exitCode = prev;
  }
});

test('CLI-13 默认 baseUrl（无注入）→ 连接 127.0.0.1:3000 失败 → rc 1', async () => {
  const prevBase = process.env.DL_PORT;
  try {
    const out = await capture('error', () => main(['health'], {}));
    assert.equal(out.result, 1, '默认端口无服务 → rc 1');
  } finally {
    if (prevBase === undefined) delete process.env.DL_PORT; else process.env.DL_PORT = prevBase;
  }
});

test('CLI-13b log --level 缺值 → 退出码 2（args[++i] 未定义短路）', async () => {
  const r = await capture('error', () => main(['log', '--level'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(r.result, 2, '--level 缺值 rc 2');
});

test('CLI-14 bootstrap 异常路径：main reject → exitCode 2 + stderr（catch 分支）', async () => {
  const prev = process.exitCode;
  try {
    const badLogger = { info: () => { throw new Error('logger-boom'); } };
    const out = await capture('error', () => bootstrap({ logger: badLogger }));
    assert.equal(process.exitCode, 2, 'bootstrap catch 应设 exitCode 2');
    assert.ok(out.log.join('').includes('logger-boom'), `stderr 应含异常: ${out.log.join('|')}`);
  } finally {
    process.exitCode = prev;
  }
});