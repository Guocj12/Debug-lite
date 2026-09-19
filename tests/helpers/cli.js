'use strict';
/* tests/helpers/cli.js —— tests/cli/*.test.js 的**公共夹具**（P7-7 §R5「抽公共 + 表驱动」）
 *
 * 抽取前（重复）：7 个 CLI 测试文件各自复制了一份 console 捕获与调用包装 ——
 *   `quiet()` 5 份逐字相同、`capture()` 3 种形态（单通道/双通道/合并）、cli-auth 还有第 4 种 `cli()`；
 *   "缺子命令 / 未知旗标 / 文件不存在 → 退出码 2"的断言散落在 9 个文件的 ~47 处 assert 上。
 * 抽取后：捕获与调用**只有这一份实现**；退出码 2 的参数化用例集中在
 *   `tests/cli/cli-usage-rc2.test.js` 的**一张表**里（每条给 argv + 断言理由）。
 *
 * 契约（docs/interfaces.md §3 / docs/systems/11-account-store.md §10.4）：
 *   CLI 退出码 0=成功、1=业务拒绝、2=参数/用法错误、3=未鉴权；CLI **只走 HTTP**。
 *
 * 项目铁律：零依赖；CommonJS；**禁 child_process / Math.random** —— 因此 CLI 一律**进程内**调用
 *   （`cli/index.js` 的 `main(argv, { baseUrl })`，真实 `node:http` 传输，不 spawn 子进程）。
 *
 * 实现要点：CLI 的输出发生在 `await` 之后，故必须**等 fn() 的 Promise 落定**再恢复 console
 *   （否则会把"恢复后"才打印的输出漏掉 / 污染测试输出）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main: cliMain } = require('../../cli/index.js');

const SAVED_CONSOLE = { log: console.log, error: console.error };

// 与旧的 3 份实现保持同一序列化口径：字符串原样、Error 带栈、其余 JSON.stringify
function stringify(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
  return JSON.stringify(a);
}

/**
 * 捕获 console.log / console.error 后执行 fn（fn 可为 async）。
 * @param {Function} fn
 * @param {{passthrough?: boolean}} [opts] passthrough=true 时把捕获到的行原样转写回真 console（排查用）
 * @returns {Promise<{log: string[], err: string[], text: string, errText: string, result: any}>}
 *   log/err：两通道各自的行数组；text/errText：各自 join('\n')；result：fn 的返回值（CLI 即退出码）
 */
async function capture(fn, opts) {
  const o = opts || {};
  const log = [];
  const err = [];
  console.log = (...a) => { const s = a.map(stringify).join(' '); log.push(s); if (o.passthrough) SAVED_CONSOLE.log(s); };
  console.error = (...a) => { const s = a.map(stringify).join(' '); err.push(s); if (o.passthrough) SAVED_CONSOLE.error(s); };
  try {
    const result = await fn();
    return { log, err, text: log.join('\n'), errText: err.join('\n'), result };
  } finally {
    console.log = SAVED_CONSOLE.log;
    console.error = SAVED_CONSOLE.error;
  }
}

/**
 * 静音两个通道后执行 fn，只回返回值（用于"只看退出码"的用例）。
 * @returns {Promise<any>}
 */
async function quiet(fn) {
  return (await capture(fn)).result;
}

/**
 * 进程内调用 CLI 子命令并捕获输出。
 * @param {string[]} argv 形如 ['box','--seed','7']
 * @param {object} [opts] 透传给 cliMain（{ baseUrl, token, logger, ... }）
 * @returns {Promise<{code: any, out: string, err: string, log: string[], errLog: string[]}>}
 */
async function runCli(argv, opts) {
  const r = await capture(() => cliMain(argv, opts || {}));
  return { code: r.result, out: r.text, err: r.errText, log: r.log, errLog: r.err };
}

/** baseUrl 归一化：接受 baseUrl 字符串、或 `{ baseUrl }` / `{ port }` 形态的已启动服务端 */
function baseOf(server) {
  if (typeof server === 'string') return server;
  if (server && typeof server.baseUrl === 'string') return server.baseUrl;
  if (server && typeof server.port === 'number') return `http://127.0.0.1:${server.port}`;
  return undefined;
}

/** `runCli` 的便捷形态：第一个参数是服务端（或 baseUrl 字符串），自动注入 baseUrl */
async function runCliOn(server, argv, opts) {
  return runCli(argv, Object.assign({ baseUrl: baseOf(server) }, opts || {}));
}

/**
 * 生成一份**真实**回放文件（直接调 `server/battle.js`，不经 HTTP —— replay 子命令本身不碰服务端）。
 * 由 cli-replay.test.js 与 cli-usage-rc2.test.js 共用。
 * @param {{seed?: number, tier?: string}} [opts]
 * @returns {{file: string, ticks: number, dir: string}} 用完请 `fs.rmSync(dir, {recursive:true, force:true})`
 */
function makeReplayFile(opts) {
  const o = opts || {};
  // eslint-disable-next-line global-require
  const battle = require('../../server/battle.js');
  const LD = require('../fixtures/loadout-ok.json');
  const ld = JSON.parse(JSON.stringify(LD.loadout));
  // B23 P2-3 雕像局破除：fixture AI 里的 'skill1' 非法（引擎只认 skill: 前缀）
  const elseStmts = (ld.ai && ld.ai.body && ld.ai.body.statements[1] && ld.ai.body.statements[1].else
    && ld.ai.body.statements[1].else.statements) || [];
  for (const s of elseStmts) if (s && s.type === 'action' && s.name === 'skill1') s.name = 'skill:skill1';
  const r = battle.runBattle({ p1: ld, p2: ld, warehouse: LD.warehouse, seed: o.seed || 20260913, tier: o.tier || 'mythic' });
  if (r.status !== 200) throw new Error(`makeReplayFile: runBattle 失败 ${r.status} ${JSON.stringify(r.errors || r.message || {})}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-cli-replay-'));
  const file = path.join(dir, 'replay.json');
  fs.writeFileSync(file, JSON.stringify({ summary: { winner: r.data.winner, ticks: r.data.ticks }, frames: r.data.frames }));
  return { file, ticks: r.data.ticks, dir };
}

module.exports = {
  SAVED_CONSOLE,
  capture,
  quiet,
  runCli,
  runCliOn,
  baseOf,
  makeReplayFile,
};
