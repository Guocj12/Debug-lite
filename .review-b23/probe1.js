'use strict';
// .review-b23/probe1.js —— CLI replay 失败路径与边界退出码（对抗核查清单 3）
// 验证：坏 JSON/未知旗标/--tick 非数字/0/-1/1.5/越界/缺值 → 期望 2；不碰服务端（baseUrl 指向死端口）
const cli = require('../cli/index.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const battle = require('../server/battle.js');
const LD = require('../tests/fixtures/loadout-ok.json');

async function run(args, label) {
  let out = '';
  const origLog = console.log, origErr = console.error;
  console.log = (s) => { out += s + '\n'; };
  console.error = (s) => { out += s + '\n'; };
  const code = await cli.main(args, { baseUrl: 'http://127.0.0.1:1' });
  console.log = origLog; console.error = origErr;
  console.log(`[${label}] exit=${code} | ${out.trim().split('\n')[0] || '(silent)'}`);
  return code;
}

(async () => {
  // 一张合法回放文件
  const r = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
  const good = path.join(os.tmpdir(), `b23-p1-${Date.now()}.json`);
  fs.writeFileSync(good, JSON.stringify({ summary: {}, frames: r.data.frames }));

  // 坏 JSON
  const badJson = path.join(os.tmpdir(), `b23-badjson-${Date.now()}.json`);
  fs.writeFileSync(badJson, '{not json');
  await run(['replay', '--file', badJson], '坏 JSON → 期望 2');

  // 未知旗标
  await run(['replay', '--file', good, '--bogus'], '未知旗标 → 期望 2');

  // --tick 边界
  for (const t of ['abc', '0', '-1', '1.5', '999', '']) {
    const args = ['replay', '--file', good, '--tick'];
    if (t !== '') args.push(t);
    await run(args, `--tick ${JSON.stringify(t) || '(缺值)'} → 期望 2`);
  }

  // 无 frames 键 / frames 空数组 / frames 非数组
  const noFrames = path.join(os.tmpdir(), `b23-nof-${Date.now()}.json`);
  fs.writeFileSync(noFrames, JSON.stringify({ foo: 1 }));
  await run(['replay', '--file', noFrames], '无 frames 键 → 期望 2');
  const emptyF = path.join(os.tmpdir(), `b23-ef-${Date.now()}.json`);
  fs.writeFileSync(emptyF, JSON.stringify({ frames: [] }));
  await run(['replay', '--file', emptyF], 'frames=[] → 期望 2');
  const notArr = path.join(os.tmpdir(), `b23-na-${Date.now()}.json`);
  fs.writeFileSync(notArr, JSON.stringify({ frames: {} }));
  await run(['replay', '--file', notArr], 'frames 非数组 → 期望 2');

  // 未知命令
  await run(['replayx'], '未知命令 → 期望 2');

  // 合法路径回归
  await run(['replay', '--file', good, '--tick', '1'], '正常单帧 → 期望 0');
  await run(['replay', '--file', good], '全量 → 期望 0');

  fs.unlinkSync(good); fs.unlinkSync(badJson); fs.unlinkSync(noFrames); fs.unlinkSync(emptyF); fs.unlinkSync(notArr);
})();