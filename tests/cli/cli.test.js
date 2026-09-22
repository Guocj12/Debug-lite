'use strict';
// T-CLI-1/2 CLI 契约测试 —— 契约见 docs/interfaces.md §3（子命令/退出码 0/1/2/3；只走 HTTP）
// 闭环：同进程 start server (listen 0) + 注入 baseUrl 的 cli main（真实 node:http 传输，无 spawn）。
//
// P7-7 §R5 重构：console 捕获与 CLI 调用包装抽到 `tests/helpers/cli.js`（原先本文件自建一份 capture）；
//   「用法/参数错误 → 退出码 2」的用例集中到 tests/cli/cli-usage-rc2.test.js 的表驱动用例 ——
//   本文件移出：原 CLI-4 / CLI-5 / CLI-10 / CLI-13b 的全部断言，以及 CLI-9 的"非法通道级别"一条；
//   本条保留：成功路径（0）、业务拒绝（1）、bootstrap 与"服务端非 200"等**非**用法错误分支。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { createLogger } = require('../../shared/log.js');
const { start } = require('../../server/index.js');
const { main, bootstrap } = require('../../cli/index.js');
const c = require('../helpers/cli.js');

// CLI-13 用：判断端口是否已有服务在听（用于规避"开发服务占用 3000"的假红）
function isPortOpen(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    sock.setTimeout(800, () => done(false));
  });
}

// CLI-13 用：拿到一个"当前可用"的端口（绑定后立即释放 → 该端口此刻无服务）
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
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
    const out = await c.runCli(['health'], { baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(out.code, 0, 'health 应 rc 0');
    assert.ok(out.log.some((l) => l.includes('"ok":true') || l.includes('"ok": true')), `stdout 应含 ok: ${out.log.join('|')}`);
  });
});

test('CLI-2 data battle-config：退出码 0 + 输出数据含 cellPx', async () => {
  await withServer(null, async ({ port }) => {
    const out = await c.runCli(['data', 'battle-config'], { baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(out.code, 0);
    assert.ok(out.out.includes('"cellPx": 64'), `输出应含 cellPx 64: ${out.out.slice(0, 200)}`);
  });
});

test('CLI-3 data 未知表 → 退出码 1（业务拒绝）+ 错误信息', async () => {
  await withServer(null, async ({ port }) => {
    const out = await c.runCli(['data', 'nope'], { baseUrl: `http://127.0.0.1:${port}` });
    assert.equal(out.code, 1, '404 业务拒绝应 rc 1');
    assert.ok(out.err.includes('unknown_table'), `stderr 应含错误码: ${out.err}`);
  });
});

test('CLI-6 服务端未运行 → 退出码 1（业务失败，连接拒绝）', async () => {
  const out = await c.runCli(['health'], { baseUrl: 'http://127.0.0.1:1' });
  assert.equal(out.code, 1, '连接拒绝应 rc 1');
  assert.ok(out.err.length > 0, 'stderr 应有错误说明');
});

test('CLI-7 cli.invoke / cli.result 日志事件（信息完整性）', async () => {
  await withServer(null, async ({ port }) => {
    const logger = createLogger({ level: 'debug', ringSize: 500 });
    const out = await c.capture(() => main(['health'], { baseUrl: `http://127.0.0.1:${port}`, logger }));
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
        // 跨 chunk 多字节字符必须整段解码（逐 chunk toString → U+FFFD；与 tests/helpers/http.js 同源修复）
        const chunks = [];
        res.on('data', (ch) => { chunks.push(Buffer.isBuffer(ch) ? ch : Buffer.from(String(ch))); });
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      }).on('error', reject);
    });
    const before = await getLevel();
    const out = await c.runCli(['log', '--level', 'trace'], { baseUrl: base });
    assert.equal(out.code, 0);
    const after = await getLevel();
    assert.equal(after.data.level, 'trace', '服务端级别应被 CLI 修改');
    assert.equal(before.data.level, 'debug');
    // 复位
    await c.runCli(['log', '--level', 'debug'], { baseUrl: base });
    assert.equal((await getLevel()).data.level, 'debug');
  });
});

test('CLI-9 log --channel ch=lv 闭环：通道覆盖生效（非法级别一条已移入表驱动用例）', async () => {
  await withServer(null, async ({ port }) => {
    const base = `http://127.0.0.1:${port}`;
    const out = await c.runCli(['log', '--channel', 'bullets=trace'], { baseUrl: base });
    assert.equal(out.code, 0);
    // 服务端 logger 的 bullets 通道覆盖应生效（通过 CLI 再 GET 无法直接查到通道级别，但可再设置同级别不报错）
    const ok2 = await c.runCli(['log', '--channel', 'bullets=trace'], { baseUrl: base });
    assert.equal(ok2.code, 0, '重复设置通道级别不报错');
  });
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
    const h = await c.runCli(['health'], { baseUrl: base });
    assert.equal(h.code, 1, 'health 500 → rc 1');
    assert.ok(h.err.includes('internal_error'), h.err);
    const l = await c.runCli(['log', '--level', 'trace'], { baseUrl: base });
    assert.equal(l.code, 1, 'log-level 400 → rc 1');
    assert.ok(l.err.includes('bad_level'), l.err);
  } finally {
    await s.close();
  }
});

test('CLI-12 bootstrap 引导：可执行且设置 exitCode（进程内覆盖 standalone 路径）', async () => {
  const prev = process.exitCode;
  try {
    const out = await c.capture(() => bootstrap());
    assert.equal(process.exitCode, 2, 'bootstrap 对未知命令设 exitCode 2');
    assert.equal(out.result, undefined, 'bootstrap 无返回值');
    assert.ok(out.errText.length > 0, 'bootstrap 应打印用法到 stderr');
  } finally {
    process.exitCode = prev;
  }
});

test('CLI-13 默认 baseUrl（无注入）→ 连接失败 → rc 1', async (t) => {
  // 2026-09-22 修复（假红根因）：
  //   本用例原断言"默认端口 3000 无服务 → rc 1"，但**开发时按文档跑 `npm start`（监听 3000）再跑
  //   `npm test`/`npm run gate`** 是常规用法 —— 此时 CLI 会真的连上那个开发服务 → rc 0 → 本用例假红，
  //   且现场表现为"时红时绿、无法区分"（仓库明确要求红必须可区分）。
  //   现在：3000 空闲 → 行为与原用例完全一致；3000 被占用 → 改用"刚确认可用即释放"的端口，
  //   仍走**无 `--base` 注入**的默认解析路径（`cli/index.js` 的 opts.baseUrl || DL_PORT || 3000）。
  const prevBase = process.env.DL_PORT;
  try {
    let target = 3000;
    if (await isPortOpen(3000)) {
      target = await freePort();
      t.diagnostic(`127.0.0.1:3000 正被占用（如 npm start）→ 改用临时端口 ${target} 走同一条默认解析路径`);
    }
    process.env.DL_PORT = String(target);
    const out = await c.runCli(['health'], {});
    assert.equal(out.code, 1, `端口 ${target} 无服务 → rc 1`);
  } finally {
    if (prevBase === undefined) delete process.env.DL_PORT; else process.env.DL_PORT = prevBase;
  }
});

test('CLI-14 bootstrap 异常路径：main reject → exitCode 2 + stderr（catch 分支）', async () => {
  const prev = process.exitCode;
  try {
    const badLogger = { info: () => { throw new Error('logger-boom'); } };
    const out = await c.capture(() => bootstrap({ logger: badLogger }));
    assert.equal(process.exitCode, 2, 'bootstrap catch 应设 exitCode 2');
    assert.ok(out.errText.includes('logger-boom'), `stderr 应含异常: ${out.errText}`);
  } finally {
    process.exitCode = prev;
  }
});
