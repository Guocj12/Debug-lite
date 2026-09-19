'use strict';
// B19 CLI panel 子命令 —— 契约 docs/interfaces.md §3；退出码 0/1/2。
//
// P7-7 §R5 重构：本地 `quiet()` 换成 `tests/helpers/cli.js`；"缺 --loadout / 文件不存在 → 2"
//   两条移入 tests/cli/cli-usage-rc2.test.js 的表驱动用例。本文件保留 0/1 语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');
const c = require('../helpers/cli.js');

const OK_FILE = path.join(__dirname, '..', 'fixtures', 'loadout-ok.json');
const BAD_FILE = path.join(__dirname, '..', 'fixtures', 'loadout-bad.json');

async function withServer(t, fn) {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    await fn({ port: s.port, baseUrl: `http://127.0.0.1:${s.port}` });
  } finally {
    await s.close();
  }
}

test('CLI panel --loadout 合法 → 0；非法 loadout → 业务拒绝 1（参数错误见表驱动用例）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const ok = await c.quiet(() => cli.main(['panel', '--loadout', OK_FILE, '--tier', 'mythic'], { baseUrl }));
    assert.equal(ok, 0, '合法 loadout 面板 → 0');
    const bad = await c.quiet(() => cli.main(['panel', '--loadout', BAD_FILE], { baseUrl }));
    assert.equal(bad, 1, '非法 loadout（技能 2 个）→ 1');
  });
});
