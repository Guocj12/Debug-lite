'use strict';
// B18 CLI wh 子命令 —— 契约 docs/interfaces.md §3（只走 HTTP；退出码 0/1/2）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');

const WH_FILE = path.join(__dirname, '..', 'fixtures', 'wh-ok.json');

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

test('CLI wh list（本地摘要）→ 0；文件缺失 → 2', async () => {
  const baseUrl = 'http://127.0.0.1:1'; // list 不碰服务端
  const a = await quiet(() => cli.main(['wh', 'list', '--file', WH_FILE], { baseUrl }));
  assert.equal(a, 0, '本地仓库摘要 → 0');
  const b = await quiet(() => cli.main(['wh', 'list', '--file', path.join(__dirname, 'no.json')], { baseUrl }));
  assert.equal(b, 2, '文件不存在 → 2');
});

test('CLI wh assemble → 0；disassemble → 0；业务拒绝 → 1；参数错误 → 2', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const a = await quiet(() => cli.main(['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0', '--plugin', 'p1', '--tier', 'common'], { baseUrl }));
    assert.equal(a, 0, '装配成功 → 0');
    const d = await quiet(() => cli.main(['wh', 'disassemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0'], { baseUrl }));
    assert.equal(d, 1, '空槽拆卸 → 服务端 404 slot_empty → 1');
    const badKind = await quiet(() => cli.main(['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0', '--plugin', 'q1'], { baseUrl }));
    assert.equal(badKind, 1, '类别不匹配 → 1（服务端 409）');
    const noSub = await quiet(() => cli.main(['wh'], { baseUrl }));
    assert.equal(noSub, 2, '缺子命令 → 2');
    const badSub = await quiet(() => cli.main(['wh', 'bogus', '--file', WH_FILE], { baseUrl }));
    assert.equal(badSub, 2, '未知子命令 → 2');
    const noItem = await quiet(() => cli.main(['wh', 'assemble', '--file', WH_FILE], { baseUrl }));
    assert.equal(noItem, 2, '缺 --item/--slot → 2');
    const noPlugin = await quiet(() => cli.main(['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0'], { baseUrl }));
    assert.equal(noPlugin, 2, 'assemble 缺 --plugin → 2');
  });
});