'use strict';
// B17 CLI box 子命令 —— 契约 docs/interfaces.md §3（只走 HTTP；退出码 0/1/2）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');

async function withServer(t, fn) {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    await fn({ port: s.port, baseUrl: `http://127.0.0.1:${s.port}` });
  } finally {
    await s.close();
  }
}

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

test('CLI box：--seed/--tier/--times 全给 → 0；缺省 → 0', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const a = await quiet(() => cli.main(['box', '--seed', '7', '--tier', 'rare', '--times', '3'], { baseUrl }));
    assert.equal(a, 0, '显式参数开箱 → 0');
    const b = await quiet(() => cli.main(['box'], { baseUrl }));
    assert.equal(b, 0, '全缺省开箱 → 0');
  });
});

test('CLI box 失败路径：业务拒绝 → 1；参数错误 → 2', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const badTier = await quiet(() => cli.main(['box', '--tier', 'diamond'], { baseUrl }));
    assert.equal(badTier, 1, '非法段位 → 1');
    const badTimes = await quiet(() => cli.main(['box', '--times', '0'], { baseUrl }));
    assert.equal(badTimes, 1, '非法次数 → 1');
    const badSeed = await quiet(() => cli.main(['box', '--seed', 'abc'], { baseUrl }));
    assert.equal(badSeed, 1, '非法 seed → 1');
    const flag = await quiet(() => cli.main(['box', '--bogus'], { baseUrl }));
    assert.equal(flag, 2, '未知参数 → 2');
  });
});