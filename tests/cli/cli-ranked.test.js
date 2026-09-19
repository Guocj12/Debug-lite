'use strict';
// B24 CLI ranked 子命令 —— 契约 docs/interfaces.md §3；退出码 0/1/2。
//
// P7-7 §R5 重构：本地 `quiet()` 换成 `tests/helpers/cli.js`；"缺 --loadout / 未知子命令 /
//   --loadout 文件不存在 → 2"三条移入 tests/cli/cli-usage-rc2.test.js 的表驱动用例。保留 0/1 语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');
const c = require('../helpers/cli.js');

const LD_FILE = path.join(__dirname, '..', 'fixtures', 'loadout-ok.json');

async function withServer(t, fn) {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    await fn({ port: s.port, baseUrl: `http://127.0.0.1:${s.port}` });
  } finally {
    await s.close();
  }
}

test('CLI ranked run → 0；非法 loadout → 业务拒绝 1（参数错误见表驱动用例）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const ok = await c.quiet(() => cli.main(['ranked', 'run', '--seed', '11', '--tier', 'mythic', '--loadout', LD_FILE], { baseUrl }));
    assert.equal(ok, 0, '排位 10 场 → 0');
    const badLd = await c.quiet(() => cli.main(['ranked', 'run', '--loadout', path.join(__dirname, '..', 'fixtures', 'loadout-bad.json')], { baseUrl }));
    assert.equal(badLd, 1, '非法 loadout → 服务端 409 → 1');
  });
});
