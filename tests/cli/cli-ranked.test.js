'use strict';
// B24 CLI ranked 子命令 —— 契约 docs/interfaces.md §3；退出码 0/1/2。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');

const LD_FILE = path.join(__dirname, '..', 'fixtures', 'loadout-ok.json');

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

test('CLI ranked run → 0；缺 --loadout → 2；业务拒绝 → 1', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const ok = await quiet(() => cli.main(['ranked', 'run', '--seed', '11', '--tier', 'mythic', '--loadout', LD_FILE], { baseUrl }));
    assert.equal(ok, 0, '排位 10 场 → 0');
    const noLd = await quiet(() => cli.main(['ranked', 'run', '--seed', '11'], { baseUrl }));
    assert.equal(noLd, 2, '缺 --loadout → 2');
    const badSub = await quiet(() => cli.main(['ranked', 'bogus'], { baseUrl }));
    assert.equal(badSub, 2, '未知子命令 → 2');
    const badLd = await quiet(() => cli.main(['ranked', 'run', '--loadout', path.join(__dirname, '..', 'fixtures', 'loadout-bad.json')], { baseUrl }));
    assert.equal(badLd, 1, '非法 loadout → 服务端 409 → 1');
    const missing = await quiet(() => cli.main(['ranked', 'run', '--loadout', path.join(__dirname, 'no.json')], { baseUrl }));
    assert.equal(missing, 2, '文件不存在 → 2');
  });
});