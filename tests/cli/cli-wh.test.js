'use strict';
// B18 CLI wh 子命令 —— 契约 docs/interfaces.md §3（只走 HTTP；退出码 0/1/2）。
//
// P7-7 §R5 重构：本地 `quiet()` 换成 `tests/helpers/cli.js`；"文件不存在 / 缺子命令 / 未知子命令 /
//   缺 --item、--slot / 缺 --plugin → 2"五条移入 tests/cli/cli-usage-rc2.test.js 的表驱动用例。
//   本文件保留 0/1 语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');
const c = require('../helpers/cli.js');

const WH_FILE = path.join(__dirname, '..', 'fixtures', 'wh-ok.json');

async function withServer(t, fn) {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    await fn({ port: s.port, baseUrl: `http://127.0.0.1:${s.port}` });
  } finally {
    await s.close();
  }
}

test('CLI wh list（本地摘要）→ 0（文件缺失 → 2 见表驱动用例）', async () => {
  const baseUrl = 'http://127.0.0.1:1'; // list 不碰服务端
  const a = await c.quiet(() => cli.main(['wh', 'list', '--file', WH_FILE], { baseUrl }));
  assert.equal(a, 0, '本地仓库摘要 → 0');
});

test('CLI wh assemble → 0；disassemble → 1；业务拒绝 → 1（参数错误 → 2 见表驱动用例）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const a = await c.quiet(() => cli.main(['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0', '--plugin', 'p1', '--tier', 'common'], { baseUrl }));
    assert.equal(a, 0, '装配成功 → 0');
    const d = await c.quiet(() => cli.main(['wh', 'disassemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0'], { baseUrl }));
    assert.equal(d, 1, '空槽拆卸 → 服务端 404 slot_empty → 1');
    const badKind = await c.quiet(() => cli.main(['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0', '--plugin', 'q1'], { baseUrl }));
    assert.equal(badKind, 1, '类别不匹配 → 1（服务端 409）');
  });
});
