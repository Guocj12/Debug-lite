'use strict';
// .review-b23/probe2.js —— CLI replay 帧内容畸形处理（对抗：缺 diff/缺 players/缺 events/events 非数组）
// 期望：输入数据非法应归为参数错误 → 2；实际路径疑似落入外层 catch → 1 + 「连接失败（服务端未运行？）」误导信息
const cli = require('../cli/index.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function runWith(desc, frames, tickArg) {
  const f = path.join(os.tmpdir(), `b23-mal-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(f, JSON.stringify({ frames }));
  let out = '';
  const origLog = console.log, origErr = console.error;
  console.log = (s) => { out += s + '\n'; };
  console.error = (s) => { out += s + '\n'; };
  let code = -1, threw = false;
  try {
    const args = ['replay', '--file', f];
    if (tickArg !== undefined) args.push('--tick', String(tickArg));
    code = await cli.main(args, { baseUrl: 'http://127.0.0.1:1' });
  } catch (e) {
    threw = true;
    out += `THREW: ${e.message}\n`;
  }
  console.log = origLog; console.error = origErr;
  console.log(`[${desc}] exit=${code} threw=${threw} | ${out.trim().split('\n')[0] || '(silent)'}`);
  fs.unlinkSync(f);
}

(async () => {
  await runWith('frames=[{}] 全量', [{}]);
  await runWith('frames=[{tick:1}] 全量（无 diff）', [{ tick: 1 }]);
  await runWith('frames=[{tick:1,diff:{players:{}}}] 全量', [{ tick: 1, diff: { players: {} } }]);
  await runWith('frames=[{tick:1,diff:{players:{},events:null}}] --tick 1', [{ tick: 1, diff: { players: { p1: { fromX: 0, toX: 0, hp: 10, mp: 1, sp: 1 }, p2: { fromX: 0, toX: 0, hp: 10, mp: 1, sp: 1 } }, events: null } }], 1);
  await runWith('frames=[null] 全量', [null]);
  await runWith('frames=[{tick:1,diff:null}] 全量', [{ tick: 1, diff: null }]);
})();