'use strict';
// B16 CLI ai 子命令闭环 —— 契约 docs/interfaces.md §3（只走 HTTP；退出码 0/1/2，T-CLI-2）
// T-CLI-1（B16 部分）：validate → compile → battle 经 CLI 完成。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');

const OK_FILE = path.join(__dirname, '..', 'fixtures', 'cli-ai-ok.json');
const BAD_FILE = path.join(__dirname, '..', 'fixtures', 'cli-ai-bad.json');

async function withServer(t, fn) {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    await fn({ port: s.port, baseUrl: `http://127.0.0.1:${s.port}` });
  } finally {
    await s.close();
  }
}

// CLI 子命令会向 stdout 打印结果（battle 帧很大）——测试期间静音，保持门禁/测试输出干净
async function quiet(fn) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test('CLI ai validate → compile → battle 闭环（T-CLI-1 B16 部分）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const v = await quiet(() => cli.main(['ai', 'validate', '--file', OK_FILE, '--tier', 'common'], { baseUrl }));
    assert.equal(v, 0, 'validate 合法程序 → 0');
    const c = await quiet(() => cli.main(['ai', 'compile', '--file', OK_FILE], { baseUrl }));
    assert.equal(c, 0, 'compile → 0');
    const b = await quiet(() => cli.main(['ai', 'battle', '--file', OK_FILE, '--opponent', 'kiter', '--seed', '7'], { baseUrl }));
    assert.equal(b, 0, 'battle → 0');
  });
});

test('CLI ai 失败路径：业务拒绝 → 1；参数错误 → 2', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const badProg = await quiet(() => cli.main(['ai', 'validate', '--file', BAD_FILE, '--tier', 'rare'], { baseUrl }));
    assert.equal(badProg, 1, '非法程序 → 1（业务拒绝）');
    const badOpp = await quiet(() => cli.main(['ai', 'battle', '--file', OK_FILE, '--opponent', 'nope'], { baseUrl }));
    assert.equal(badOpp, 1, '未知对手 → 1');
    const noSub = await quiet(() => cli.main(['ai'], { baseUrl }));
    assert.equal(noSub, 2, '缺子命令 → 2');
    const sub2 = await quiet(() => cli.main(['ai', 'bogus', '--file', OK_FILE], { baseUrl }));
    assert.equal(sub2, 2, '未知子命令 → 2');
    const noFile = await quiet(() => cli.main(['ai', 'validate'], { baseUrl }));
    assert.equal(noFile, 2, '缺 --file → 2');
    const missing = await quiet(() => cli.main(['ai', 'compile', '--file', path.join(__dirname, 'no-such.json')], { baseUrl }));
    assert.equal(missing, 2, '文件不存在 → 2');
  });
});

test('CLI ai battle 无 --seed：服务端生成并回带（print 静音下的 0 退出码）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const code = await quiet(() => cli.main(['ai', 'battle', '--file', OK_FILE], { baseUrl }));
    assert.equal(code, 0, 'battle 无 seed → 0');
  });
});