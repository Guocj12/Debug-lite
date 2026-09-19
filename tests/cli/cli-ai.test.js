'use strict';
// B16 CLI ai 子命令闭环 —— 契约 docs/interfaces.md §3（只走 HTTP；退出码 0/1/2，T-CLI-2）
// T-CLI-1（B16 部分）：validate → compile → battle 经 CLI 完成。
//
// P7-7 §R5 重构：本地 `quiet()` 换成 `tests/helpers/cli.js`；"缺子命令/未知子命令/缺 --file/
//   文件不存在 → 2"四条移入 tests/cli/cli-usage-rc2.test.js 的表驱动用例。本文件保留 0/1 语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');
const c = require('../helpers/cli.js');

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

test('CLI ai validate → compile → battle 闭环（T-CLI-1 B16 部分）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const v = await c.quiet(() => cli.main(['ai', 'validate', '--file', OK_FILE, '--tier', 'common'], { baseUrl }));
    assert.equal(v, 0, 'validate 合法程序 → 0');
    const cp = await c.quiet(() => cli.main(['ai', 'compile', '--file', OK_FILE], { baseUrl }));
    assert.equal(cp, 0, 'compile → 0');
    const b = await c.quiet(() => cli.main(['ai', 'battle', '--file', OK_FILE, '--opponent', 'kiter', '--seed', '7'], { baseUrl }));
    assert.equal(b, 0, 'battle → 0');
  });
});

test('CLI ai 失败路径：业务拒绝 → 1（参数错误 → 2 见表驱动用例）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const badProg = await c.quiet(() => cli.main(['ai', 'validate', '--file', BAD_FILE, '--tier', 'rare'], { baseUrl }));
    assert.equal(badProg, 1, '非法程序 → 1（业务拒绝）');
    const badOpp = await c.quiet(() => cli.main(['ai', 'battle', '--file', OK_FILE, '--opponent', 'nope'], { baseUrl }));
    assert.equal(badOpp, 1, '未知对手 → 1');
  });
});

test('CLI ai battle 无 --seed：服务端生成并回带（print 静音下的 0 退出码）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const code = await c.quiet(() => cli.main(['ai', 'battle', '--file', OK_FILE], { baseUrl }));
    assert.equal(code, 0, 'battle 无 seed → 0');
  });
});
