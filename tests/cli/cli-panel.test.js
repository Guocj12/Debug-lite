'use strict';
// B19 CLI panel 子命令 —— 契约 docs/interfaces.md §3；退出码 0/1/2。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const cli = require('../../cli/index.js');
const serverMod = require('../../server/index.js');
const { createLogger } = require('../../shared/log.js');

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

test('CLI panel --loadout 合法 → 0；非法 loadout → 1；参数错误 → 2', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const ok = await quiet(() => cli.main(['panel', '--loadout', OK_FILE, '--tier', 'mythic'], { baseUrl }));
    assert.equal(ok, 0, '合法 loadout 面板 → 0');
    const bad = await quiet(() => cli.main(['panel', '--loadout', BAD_FILE], { baseUrl }));
    assert.equal(bad, 1, '非法 loadout（技能 2 个）→ 1');
    const noFile = await quiet(() => cli.main(['panel'], { baseUrl }));
    assert.equal(noFile, 2, '缺 --loadout → 2');
    const missing = await quiet(() => cli.main(['panel', '--loadout', path.join(__dirname, 'no.json')], { baseUrl }));
    assert.equal(missing, 2, '文件不存在 → 2');
  });
});