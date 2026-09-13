'use strict';
/* B18 CLI 探针（真实子进程 + 真实服务）—— node .review-b18/probe-cli.js
 * 退出码 0/1/2 全路径；--slot 边界（1.5 / -1 / abc）；unknown 选项；
 * assemble 成功打印回带仓库；disassemble 成功打印回带仓库。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const { createLogger } = require('../shared/log.js');
const serverMod = require('../server/index.js');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');
const WH_FILE = path.join(__dirname, '..', 'tests', 'fixtures', 'wh-ok.json');

function runCli(baseUrl, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DL_PORT: String(new URL(baseUrl).port) } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  const baseUrl = `http://127.0.0.1:${s.port}`;
  try {
    const cases = [
      ['wh list --file wh.json', ['wh', 'list', '--file', WH_FILE], null],
      ['wh list 缺文件', ['wh', 'list', '--file', path.join(__dirname, 'nope.json')], null],
      ['wh assemble 成功', ['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0', '--plugin', 'p1', '--tier', 'common'], 0],
      ['wh disassemble 成功', ['wh', 'disassemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0'], null],
      ['wh assemble 类别错 → 1', ['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0', '--plugin', 'q1'], 1],
      ['wh assemble 槽位越界 → 1', ['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '9', '--plugin', 'p1'], 1],
      ['wh assemble --slot 1.5', ['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '1.5', '--plugin', 'p1'], null],
      ['wh assemble --slot -1', ['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '-1', '--plugin', 'p1'], null],
      ['wh assemble --slot abc', ['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', 'abc', '--plugin', 'p1'], 2],
      ['wh assemble 未知选项', ['wh', 'assemble', '--file', WH_FILE, '--item', 'r1', '--slot', '0', '--plugin', 'p1', '--bogus'], 2],
      ['wh list 未知选项', ['wh', 'list', '--file', WH_FILE, '--bogus'], 2],
      ['wh 缺子命令', ['wh'], 2],
      ['wh assemble 缺 --file', ['wh', 'assemble', '--item', 'r1', '--slot', '0', '--plugin', 'p1'], 2],
    ];
    for (const [label, args, expect] of cases) {
      const r = await runCli(baseUrl, args);
      const note = expect === null ? '' : (r.code === expect ? ' ✓' : ' ✗ 期望 ' + expect);
      console.log(`${r.code}  ${label}${note}`);
      if (label.includes('成功') && r.code === 0) {
        const w = JSON.parse(r.out);
        console.log(`     打印回带：role[0].slots[0].pluginUid=${w.buckets.role[0].slots[0].pluginUid}（assemble 应 p1）`);
      }
    }
  } finally {
    await s.close();
  }
})();