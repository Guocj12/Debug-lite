'use strict';
// B17 CLI box 子命令 —— 契约 docs/interfaces.md §3（只走 HTTP；退出码 0/1/2）。
//
// P7-7 §R5 重构：本地 `quiet()` 换成 `tests/helpers/cli.js`；"未知参数 → 2"移入
//   tests/cli/cli-usage-rc2.test.js 的表驱动用例。本文件保留 0/1 语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');
const c = require('../helpers/cli.js');

async function withServer(t, fn) {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    await fn({ port: s.port, baseUrl: `http://127.0.0.1:${s.port}` });
  } finally {
    await s.close();
  }
}

test('CLI box：--seed/--tier/--times 全给 → 0；缺省 → 0', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const a = await c.quiet(() => cli.main(['box', '--seed', '7', '--tier', 'rare', '--times', '3'], { baseUrl }));
    assert.equal(a, 0, '显式参数开箱 → 0');
    const b = await c.quiet(() => cli.main(['box'], { baseUrl }));
    assert.equal(b, 0, '全缺省开箱 → 0');
  });
});

test('CLI box 失败路径：业务拒绝 → 1（参数错误 → 2 见表驱动用例）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const badTier = await c.quiet(() => cli.main(['box', '--tier', 'diamond'], { baseUrl }));
    assert.equal(badTier, 1, '非法段位 → 1');
    const badTimes = await c.quiet(() => cli.main(['box', '--times', '0'], { baseUrl }));
    assert.equal(badTimes, 1, '非法次数 → 1');
    const badSeed = await c.quiet(() => cli.main(['box', '--seed', 'abc'], { baseUrl }));
    assert.equal(badSeed, 1, '非法 seed → 1');
  });
});
