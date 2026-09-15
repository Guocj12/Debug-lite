'use strict';
/* .review-b19/probe-cli.js —— B19 CLI panel 探针（真实子进程 + 真实服务，退出码全路径）
 * 场景：包装文件合法→0；裸 loadout 合法→0（面板非最终？）；bad→1；缺参/未知选项/缺文件→2；连接失败→1。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../shared/log.js');
const serverMod = require('../server/index.js');
const FIXTURE = require('../tests/fixtures/loadout-ok.json');

const CLI = path.join(__dirname, '..', 'cli', 'index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b19-cli-'));
const okWrapped = path.join(tmp, 'ok-wrapped.json');
const okBare = path.join(tmp, 'ok-bare.json');
const badFile = path.join(tmp, 'bad.json');
fs.writeFileSync(okWrapped, JSON.stringify(FIXTURE));
fs.writeFileSync(okBare, JSON.stringify(FIXTURE.loadout));
fs.writeFileSync(badFile, JSON.stringify({ loadout: { role: null, skills: [null, null], ai: null } }));

function runCli(baseUrl, args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, DL_PORT: String(new URL(baseUrl).port) } });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
  });
}

(async () => {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  const baseUrl = `http://127.0.0.1:${s.port}`;

  const c1 = await runCli(baseUrl, ['panel', '--loadout', okWrapped, '--tier', 'mythic']);
  const atk1 = /"atk": (\d+)/.exec(c1.out);
  console.log(`[1] 包装文件合法 → exit=${c1.code} atk=${atk1 ? atk1[1] : '?'}（应 0 / 22）`);

  const c2 = await runCli(baseUrl, ['panel', '--loadout', okBare]);
  const atk2 = /"atk": (\d+)/.exec(c2.out);
  console.log(`[2] 裸 loadout 无 warehouse → exit=${c2.code} atk=${atk2 ? atk2[1] : '?'}（P1-3 候选：0 但 20 非最终）`);

  const c3 = await runCli(baseUrl, ['panel', '--loadout', badFile]);
  console.log(`[3] 非法 loadout → exit=${c3.code}（应 1）`);

  const c4 = await runCli(baseUrl, ['panel']);
  console.log(`[4] 缺 --loadout → exit=${c4.code}（应 2）`);

  const c5 = await runCli(baseUrl, ['panel', '--loadout', okWrapped, '--nope', 'x']);
  console.log(`[5] 未知选项 → exit=${c5.code}（应 2）`);

  const c6 = await runCli(baseUrl, ['panel', '--loadout', path.join(tmp, 'no.json')]);
  console.log(`[6] 文件不存在 → exit=${c6.code}（应 2）`);

  const c7 = await runCli(baseUrl, ['panel', '--loadout', okWrapped, '--tier', 'diamond']);
  console.log(`[7] tier=diamond → exit=${c7.code}（应 1，409）`);

  await s.close();
  // 连接失败（无服务）
  const c8 = await runCli(`http://127.0.0.1:${s.port}`, ['panel', '--loadout', okWrapped]);
  console.log(`[8] 服务已关 → exit=${c8.code}（应 1 连接失败）`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
})().catch((e) => { console.error('PROBE ERR', e); process.exit(1); });