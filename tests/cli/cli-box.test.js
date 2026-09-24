'use strict';
// B17 CLI box 子命令 —— 契约 docs/interfaces.md §3（只走 HTTP；退出码 0/1/2）。
//
// P7-7 §R5 重构：本地 `quiet()` 换成 `tests/helpers/cli.js`；"未知参数 → 2"移入
//   tests/cli/cli-usage-rc2.test.js 的表驱动用例。本文件保留 0/1 语义。
//
// D-162（2026-09-22）**随机性收归服务端**：`seed` 不是接口参数 → `cli box` **不再接受 `--seed`**，
//   给了即"参数/用法错误" → 退出码 **2**（旧契约是把 seed 透传给服务端 → 400 bad_seed → 退出码 1，已废除）。
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

test('CLI box：--tier/--times 全给 → 0；缺省 → 0；--seed 不再接受 → 2（D-162）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const a = await c.quiet(() => cli.main(['box', '--tier', 'rare', '--times', '3'], { baseUrl }));
    assert.equal(a, 0, '显式参数开箱 → 0');
    const b = await c.quiet(() => cli.main(['box'], { baseUrl }));
    assert.equal(b, 0, '全缺省开箱 → 0');
    // D-162：`seed` 不是接口参数 → CLI 拒绝该旗标（参数错误口径，而非"透传给服务端报 400"）
    const withSeed = await c.quiet(() => cli.main(['box', '--seed', '7'], { baseUrl }));
    assert.equal(withSeed, 2, '--seed 不再接受 → 参数错误退出码 2（D-162）');
  });
});

test('CLI box 失败路径：业务拒绝 → 1；--seed 为参数错误 → 2（D-162）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const badTier = await c.quiet(() => cli.main(['box', '--tier', 'diamond'], { baseUrl }));
    assert.equal(badTier, 1, '非法段位 → 1');
    const badTimes = await c.quiet(() => cli.main(['box', '--times', '0'], { baseUrl }));
    assert.equal(badTimes, 1, '非法次数 → 1');
    // D-162：旧断言 `--seed abc` → 1（服务端 400 bad_seed 的业务拒绝）已随契约废除；
    //   现在任何 `--seed` 都是**本地参数错误** → 退出码 2（旧"非法 seed → 1"等价迁移为"任意 seed → 2"）。
    const badSeed = await c.quiet(() => cli.main(['box', '--seed', 'abc'], { baseUrl }));
    assert.equal(badSeed, 2, '--seed（含非法值）→ 参数错误 2（D-162）');
    const numericSeed = await c.quiet(() => cli.main(['box', '--seed', '5'], { baseUrl }));
    assert.equal(numericSeed, 2, '合法的数值 seed 同样不接受 → 2（D-162：接口无 seed 入参）');
  });
});
