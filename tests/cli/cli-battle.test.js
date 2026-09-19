'use strict';
// B22 CLI battle 子命令 —— 契约 docs/interfaces.md §3；退出码 0/1/2；--out 落盘回放 JSON。
//
// P7-7 §R5 重构：本地 `quiet()` 换成 `tests/helpers/cli.js`；"缺 --p2 / --p1 文件缺失 / 未知旗标 → 2"
//   三条移入 tests/cli/cli-usage-rc2.test.js 的表驱动用例。本文件保留 0/1 语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
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

test('CLI battle：--p1/--p2 对战 → 0；--out 落盘回放 JSON 且可读', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const out = path.join(os.tmpdir(), `b22-replay-${Date.now()}.json`);
    const a = await c.quiet(() => cli.main(['battle', '--p1', LD_FILE, '--p2', LD_FILE, '--seed', '7', '--tier', 'mythic', '--out', out], { baseUrl }));
    assert.equal(a, 0, '对战 → 0');
    const disc = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(disc.summary && Number.isInteger(disc.summary.ticks) && disc.summary.ticks > 0, '回放文件含 summary');
    assert.equal(disc.frames.length, disc.summary.ticks, '回放文件帧数 == ticks');
    assert.ok('diff' in disc.frames[0] && 'events' in disc.frames[0].diff, '帧契约（B23 回放器输入）');
    fs.unlinkSync(out);
    const noOut = await c.quiet(() => cli.main(['battle', '--p1', LD_FILE, '--p2', LD_FILE, '--seed', '7'], { baseUrl }));
    assert.equal(noOut, 0, '无 --out 也成功');
  });
});

test('CLI battle 失败路径：业务错误 → 1（参数/文件错误 → 2 见表驱动用例）', async () => {
  await withServer(null, async ({ baseUrl }) => {
    const badSeed = await c.quiet(() => cli.main(['battle', '--p1', LD_FILE, '--p2', LD_FILE, '--seed', 'x'], { baseUrl }));
    assert.equal(badSeed, 1, '非法 seed → 服务端 400 → 1');
    const badTier = await c.quiet(() => cli.main(['battle', '--p1', LD_FILE, '--p2', LD_FILE, '--tier', 'platinum'], { baseUrl }));
    assert.equal(badTier, 1, '非法 tier → 1');
    // P2-7 补充分支：p2 非法 loadout → 1；--out 写入失败 → 1
    const badLd = path.join(__dirname, '..', 'fixtures', 'loadout-bad.json');
    const badP2 = await c.quiet(() => cli.main(['battle', '--p1', LD_FILE, '--p2', badLd], { baseUrl }));
    assert.equal(badP2, 1, 'p2 非法 loadout（技能 2 个）→ 1');
    const writeFail = await c.quiet(() => cli.main(['battle', '--p1', LD_FILE, '--p2', LD_FILE, '--out', path.join(os.tmpdir(), 'no-such-dir-xyz', 'r.json')], { baseUrl }));
    assert.equal(writeFail, 1, '--out 写入失败 → 1');
  });
});
