'use strict';
/* .review-f0/probe2-modules.js —— P6 F0 模块层对抗（可复跑：node .review-f0/probe2-modules.js）
 * 1) 默认自启动：node 导入 app.js 不抛、无 unhandledRejection（相对 URL fetch → catch → warn → resolve null）
 * 2) util/log 三态细节：localStorage.getItem 抛 SecurityError 的 catch 臂；location.href 非法 URL 的 catch 臂
 * 3) noop 方法面与 shared createLogger 表面一致性（LEVELS 引导名集）
 * 4) boot 三态 + 非 ok 信封的日志语义
 * 5) 转发原样性：注入 logger 收到 (channel,event,msg,data) 原样四元组；data 缺省时不追加 undefined
 */
const assert = require('node:assert/strict');
const { createLogger } = require('../shared/log.js');

let passed = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { fails.push(`${name}: ${detail}`); console.log(`  FAIL ${name}: ${detail}`); }
}

(async () => {
  console.log('== 1) node 默认自启动 ==');
  const unhandled = [];
  process.on('unhandledRejection', (e) => unhandled.push(e));
  await new Promise((resolve) => setTimeout(resolve, 200)); // 让可能的拒绝先落地
  const app = await import('../public/js/app.js');
  await new Promise((resolve) => setTimeout(resolve, 200));
  check('import app.js 成功（模块级 boot() 不抛）', typeof app.boot === 'function', 'import 失败或 boot 未导出');
  check('默认自启动无 unhandledRejection', unhandled.length === 0, `${unhandled.map((e) => e.message).join('; ')}`);
  await new Promise((resolve) => setTimeout(resolve, 200));

  console.log('== 2) util/log catch 臂 ==');
  const mod = await import('../public/js/util/log.js');
  const created = [];
  const fakeDLLog = {
    parseLevel: (s) => ({ silent: -1, all: 99, info: 3 }[s] ?? null),
    createLogger: (o) => { created.push(o); return {
      info: () => {}, warn: () => {}, setLevel: () => {}, setChannelLevel: () => {}, log: () => {},
    }; },
  };
  // localStorage.getItem 抛异常（file:// 隐私模式场景）→ catch → 默认 all（URL ?log= 也一并丢弃——登记 P2）
  const win1 = { DLLog: fakeDLLog, location: { href: 'http://x/?log=info' }, localStorage: { getItem: () => { throw new Error('SecurityError'); } } };
  const l1 = mod.createFrontLog(win1, {});
  check('localStorage 抛错 → 不抛、默认 all（注意：已读到的 ?log=info 被同 try 丢弃，P2 观察）', created.length === 1 && created[0].level === 99, JSON.stringify(created));
  // location.href 非法 URL → catch（new URL 抛）
  const win2 = { DLLog: fakeDLLog, location: { href: 'not a url' }, localStorage: { getItem: () => '{"level":"info"}' } };
  const l2 = mod.createFrontLog(win2, {});
  check('location.href 非法 → catch → 默认 all', created.length === 2 && created[1].level === 99, JSON.stringify(created));
  // logPrefs JSON 损坏 → catch → 默认 all（URL ?log=info 已读到但被同 try 丢弃——P2 观察）
  const win3 = { DLLog: fakeDLLog, location: { href: 'http://x/?log=info' }, localStorage: { getItem: () => '{broken' } };
  const l3 = mod.createFrontLog(win3, {});
  check('logPrefs JSON 损坏 → catch → 默认 all（URL 值一并丢弃）', created.length === 3 && created[2].level === 99, JSON.stringify(created));

  console.log('== 3) noop 方法面 vs shared createLogger 表面 ==');
  const noop = mod.createFrontLog(undefined, {});
  const real = createLogger({ level: 'silent' });
  const noopKeys = Object.keys(noop).filter((k) => k !== 'raw').sort();
  const sharedKeys = Object.keys(real).sort();
  // facade 有意收窄：调用面（六级别 + log + setLevel/setChannelLevel）齐备；on/getLevel/dump/records/reset/stats 在 raw 上
  const callSurface = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'log', 'setLevel', 'setChannelLevel'];
  check('facade 调用面 = 六级别 + log + setLevel/setChannelLevel（其余经 raw 取）', JSON.stringify(noopKeys) === JSON.stringify(callSurface.slice().sort()),
    JSON.stringify(noopKeys));
  check('shared 调用面 ⊆ facade + raw 可补足（raw 暴露注入面）', callSurface.every((k) => sharedKeys.includes(k)) && noop.raw !== undefined,
    `缺: ${callSurface.filter((k) => !sharedKeys.includes(k))}`);

  console.log('== 4) 转发原样性 ==');
  const got = [];
  const stub = {
    info: (...a) => got.push(a),
    warn: (...a) => got.push(a),
    fatal: () => {}, error: () => {}, debug: () => {}, trace: () => {},
    log: (...a) => got.push(a),
    setLevel: () => {}, setChannelLevel: () => {},
  };
  const fl = mod.createFrontLog(undefined, { logger: stub });
  fl.info('store', 'store.boot', 'hello', { x: 1 });
  check('info 原样四元组', got[0].length === 4 && got[0][2] === 'hello' && got[0][3].x === 1, JSON.stringify(got[0]));
  fl.warn('store', 'store.boot', 'w'); // 无 data → wrap 恒传 4 参（data=undefined，与 shared 签名对齐，无害）
  check('无 data → data=undefined 传参（与 shared info/emit 语义一致）', got[1].length === 4 && got[1][3] === undefined, `len=${got[1].length}`);
  fl.log('debug', 'api', 'api.req', 'm');
  check('log 通用形转发 (level,ch,ev,msg)', got[2].length === 4 && got[2][0] === 'debug', JSON.stringify(got[2]));

  console.log('== 5) boot 三态 + 非 ok 信封 ==');
  const msgs = [];
  const slog = { info: (ch, ev, msg, d) => msgs.push(['info', ev, msg, d]), warn: (ch, ev, msg, d) => msgs.push(['warn', ev, msg, d]), setLevel: () => {}, setChannelLevel: () => {} };
  const r1 = await app.boot({ fetchImpl: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: { version: 'v1' } }) }), log: slog });
  check('成功分支返回 data', r1.ok === true && r1.data.version === 'v1', JSON.stringify(r1));
  check('成功分支日志 store.boot info {ok,version}', msgs.some(([l, ev, m, d]) => l === 'info' && ev === 'store.boot' && m === 'server ok' && d.ok === true && d.version === 'v1'), JSON.stringify(msgs));
  const r2 = await app.boot({ fetchImpl: () => Promise.resolve({ json: () => Promise.resolve({ ok: false, error: { code: 'x' } }) }), log: slog });
  check('非 ok 信封 → 返回信封本体（不抛）', r2.ok === false, JSON.stringify(r2));
  check('非 ok 信封日志仍为 info "server ok"（语义：请求成功非服务健康）', msgs.some(([l, ev, m, d]) => l === 'info' && m === 'server ok' && d.ok === false), JSON.stringify(msgs.slice(-2)));
  const r3 = await app.boot({ fetchImpl: null, log: slog });
  check('fetchImpl=null → resolve null + warn', r3 === null && msgs.some(([l, ev, m]) => l === 'warn' && m === 'server unreachable'), JSON.stringify(msgs.slice(-1)));
  const r4 = await app.boot({ fetchImpl: () => Promise.reject(new Error('boom')), log: slog });
  check('fetch 拒绝 → resolve null + warn(message)', r4 === null && msgs.some(([l, ev, m, d]) => l === 'warn' && m === 'server unreachable' && d.message === 'boom'), JSON.stringify(msgs.slice(-1)));
  const r5 = await app.boot({ log: slog }); // fetchImpl 缺省 → 全局 fetch（node 有）→ 相对 URL 拒绝 → catch（与自启动同路）
  check('fetchImpl 缺省（node 全局 fetch）→ catch → null 不抛', r5 === null, JSON.stringify(r5));
  check('缺省路径日志 warn server unreachable', msgs.some(([l, ev, m]) => l === 'warn' && m === 'server unreachable'), JSON.stringify(msgs.slice(-1)));

  console.log(`\nprobe2: ${passed} ok / ${fails.length} fail`);
  if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; }
})();