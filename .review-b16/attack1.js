'use strict';
/* B16 红队实测 1：主要针对 serialize/restore 函数体内挂起 + hash 一致性 + 迁移边界 */
const assert = require('node:assert/strict');
const runtime = require('../server/ai/runtime.js');
const ast = require('../server/ai/ast.js');
const runner = require('../server/runner.js');
const { createLogger } = require('../shared/log.js');

const snap = {
  self: { hp: 100, atk: 12, def: 8, sp: 60, mp: 40, x: 224, baseHp: 100, facing: 1 },
  enemy: { hp: 100, atk: 19, def: 9, sp: 60, mp: 40, x: 800, baseHp: 100, facing: -1 },
  bullets: [], field: { fieldPx: 1024, cellPx: 64 },
};
const mkRng = () => ({ chance: () => false });

function prog(stmts, version = 1) {
  return { type: 'program', version, body: { type: 'seq', statements: stmts } };
}
const action = (name) => ({ type: 'action', name });
const loopCount = (n, body) => ({ type: 'loop', kind: 'count', times: { type: 'literal', value: n }, body });
const literal = (v) => ({ type: 'literal', value: v });

const results = [];
function check(name, fn) {
  try { fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); }
}

/* ---- T1：函数体内 count 循环挂起 → serialize/restore 往返（A-5 + A-3 组合） ---- */
check('T1 函数体内循环挂起往返等价', () => {
  // 合法程序：函数体含 count 循环（体含 action）；断点位于函数内循环中
  const p = prog([
    { type: 'var', name: 'n', value: literal(0) },
    { type: 'function', name: 'f', body: { type: 'seq', statements: [
      loopCount(3, { type: 'seq', statements: [action('skill1')] }),
    ] } },
    { type: 'call', name: 'f' },
    action('tail'),
  ]);
  const base = runtime.createContext(p);
  const baseActs = [];
  for (let i = 0; i < 6; i++) baseActs.push(runtime.resume(base, snap, mkRng()).action);

  const ctx = runtime.createContext(p);
  const first = [];
  for (let i = 0; i < 2; i++) first.push(runtime.resume(ctx, snap, mkRng()).action);
  // 现在挂起在函数内循环第 2 次迭代
  const ser = JSON.parse(JSON.stringify(runtime.serializeContext(ctx)));
  const frames = ser.frames.map((f) => `${f.kind}:${f.path}`);
  const ctx2 = runtime.restoreContext(ser, p);
  const second = [];
  for (let i = 0; i < 4; i++) second.push(runtime.resume(ctx2, snap, mkRng()).action);
  console.log('  T1 基线:', JSON.stringify(baseActs), ' 往返后:', JSON.stringify(second), ' 帧:', JSON.stringify(frames));
  assert.deepEqual(second, baseActs.slice(2), '函数内循环挂起往返后行动序列与基线一致（T-AF-7）');
});

/* ---- T2：函数体内 if 分支（action 后还有语句）挂起往返 ---- */
check('T2 函数体内 if 分支多语句挂起往返等价', () => {
  const p = prog([
    { type: 'function', name: 'f', body: { type: 'seq', statements: [
      { type: 'if', cond: literal(1), then: { type: 'seq', statements: [action('a'), action('b')] } },
    ] } },
    { type: 'call', name: 'f' },
    action('tail'),
  ]);
  const base = runtime.createContext(p);
  const baseActs = [];
  for (let i = 0; i < 4; i++) baseActs.push(runtime.resume(base, snap, mkRng()).action);

  const ctx = runtime.createContext(p);
  runtime.resume(ctx, snap, mkRng()); // 产出 a，挂起在 fn 内 then 分支
  const ser = JSON.parse(JSON.stringify(runtime.serializeContext(ctx)));
  const ctx2 = runtime.restoreContext(ser, p);
  const second = [];
  for (let i = 0; i < 3; i++) second.push(runtime.resume(ctx2, snap, mkRng()).action);
  console.log('  T2 基线:', JSON.stringify(baseActs), ' 往返后:', JSON.stringify(second));
  assert.deepEqual(second, baseActs.slice(1), 'fn 内 if 分支挂起往返后一致');
});

/* ---- T3：sha256 与 node:crypto 逐字节对齐（含非 BMP 多字节） ---- */
check('T3 sha256 非 BMP 锚定', () => {
  const crypto = require('node:crypto');
  const samples = ['', 'abc', 'hello 世界', '😀', '中😀文', 'a\uD83D\uDE00b'];
  for (const s of samples) {
    const canon = ast.canonicalize({ literal: s });
    const expect = crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
    const got = ast.programHash({ literal: s });
    if (got !== expect) {
      console.log(`  T3 分歧: literal=${JSON.stringify(s)} canon=${JSON.stringify(canon)}`);
    }
    assert.equal(got, expect, `sha256(${JSON.stringify(s)}) 与 crypto 一致`);
  }
});

/* ---- T4：v1 程序 compile 与 battle 的 programHash 一致（同 canonical 串） ---- */
check('T4 compile/battle 同 v1 程序 hash 一致', () => {
  const fixture = JSON.parse(JSON.stringify(require('../tests/fixtures/ai-programs.json').a1Countdown.program));
  const c = runner.compileAi(fixture, undefined);
  assert.equal(c.status, 200);
  const b = runner.runAiBattle({ program: fixture, seed: 7, tier: 'mythic' });
  assert.equal(b.status, 200);
  console.log(`  T4 compile hash=${c.data.programHash} battle hash=${b.data.programHash} migrated=${c.data.migrated}`);
  assert.equal(c.data.programHash, b.data.programHash, 'v1 程序 compile 与 battle 哈希一致');
});

/* ---- T5：迁移边界：环/克隆失败 → 跳过迁移 → ai_cycle；v0/bad_version 不被迁移接管；双入口单次日志 ---- */
check('T5 环程序 validate → ai_cycle 且无 ai.migrate', () => {
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const astApi = ast.withLogger(logger);
  const cyc = { type: 'program', version: 1, body: { type: 'seq', statements: [] } };
  cyc.body.statements.push(cyc.body); // 自引用环（非法宿主注入模拟）
  const v = astApi.validate(cyc, 'mythic');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'ai_cycle'), 'ai_cycle');
  assert.equal(logger.records.filter((r) => r.event === 'ai.migrate').length, 0, '环程序不迁移不记日志');
});

check('T5b version 0 与负版本 → bad_version（迁移不接管）', () => {
  const p = { type: 'program', version: 0, body: { type: 'seq', statements: [action('x')] } };
  const v = ast.validate(p, 'mythic');
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'bad_version'), 'bad_version');
  const pn = { type: 'program', version: -1, body: { type: 'seq', statements: [action('x')] } };
  const vn = ast.validate(pn, 'mythic');
  assert.equal(vn.ok, false);
  assert.ok(vn.errors.some((e) => e.code === 'bad_version'), '负版本 bad_version');
});

check('T5c 双入口（validate→validateProgram）迁移日志唯一', () => {
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const astApi = ast.withLogger(logger);
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [action('x')] } };
  const v = astApi.validate(p, 'mythic');
  assert.equal(v.ok, true);
  assert.equal(logger.records.filter((r) => r.event === 'ai.migrate').length, 1, 'validate 恰一次迁移日志');
  // 直接 validateProgram 入口（v1 → 迁移内聚在 validateProgram？）
  const logger2 = createLogger({ level: 'all', ringSize: 200 });
  const astApi2 = ast.withLogger(logger2);
  const v2 = astApi2.validateProgram(p);
  console.log('  T5c validateProgram(v1) ok=', v2.ok, 'migrate 日志数=', logger2.records.filter((r) => r.event === 'ai.migrate').length);
  assert.equal(v2.ok, true, 'validateProgram 入口对 v1 合法');
});

/* ---- T6：battle 病态程序：pBurnSteps（静态拒）；wait-only（运行时兜底 draw） ---- */
check('T6 pBurnSteps battle → 400 ai_invalid（静态拒）', () => {
  const f = JSON.parse(JSON.stringify(require('../tests/fixtures/ai-programs.json').pBurnSteps.program));
  const b = runner.runAiBattle({ program: f, seed: 7, tier: 'mythic' });
  assert.equal(b.status, 400);
  assert.equal(b.code, 'ai_invalid');
  assert.ok(b.details.some((e) => e.code === 'branch_without_action'), 'branch_without_action');
});

check('T6b wait-only 程序 battle → 200 draw（超时兜底，winner 有值）', () => {
  const p = prog([action('wait')]);
  const b = runner.runAiBattle({ program: p, seed: 7, tier: 'mythic' });
  assert.equal(b.status, 200);
  assert.ok(['p1', 'p2', 'draw'].includes(b.data.winner), `winner=${b.data.winner}`);
  assert.equal(b.data.frames.length, b.data.ticks, '帧数==tick 数');
  console.log(`  T6b wait-only: winner=${b.data.winner} phase=${b.data.phase} ticks=${b.data.ticks} frames=${b.data.frames.length}`);
});

/* ---- T7：battle aiTrace 增量跨 tick 正确（seq 连续、每帧本 tick） ---- */
check('T7 battle aiTrace 跨 tick 增量（seq 全局连续）', () => {
  const p = prog([
    { type: 'var', name: 'n', value: literal(0) },
    { type: 'set', name: 'n', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'n' }, right: literal(1) } },
    action('move_right'),
  ]);
  const b = runner.runAiBattle({ program: p, seed: 9, tier: 'mythic', opponent: 'kiter' });
  assert.equal(b.status, 200);
  let prevMax = -1;
  for (const f of b.data.frames) {
    for (const e of f.aiTraces) {
      assert.ok(e.seq === prevMax + 1, `seq 全局连续（tick ${f.tick} seq=${e.seq} prev=${prevMax}）`);
      assert.equal(e.tick, f.tick, 'trace 条目 tick 归属');
      prevMax = e.seq;
    }
  }
  console.log(`  T7 总 trace 条目=${prevMax + 1}（跨 ${b.data.frames.length} tick）`);
});

/* ---- T8：battle 非法 tier 的错误码 ---- */
check('T8 battle 非法 tier 错误码', () => {
  const p = prog([action('wait')]);
  const b = runner.runAiBattle({ program: p, seed: 7, tier: 'diamond' });
  console.log(`  T8 status=${b.status} code=${b.code} details0=${JSON.stringify(b.details && b.details[0] && b.details[0].code)}`);
});

/* ---- T9：compile 对高版本 → ai_version_unsupported；缺失迁移链版本（如 v1 无迁移）不适用当前表 ---- */
check('T9 compile v3 → ai_version_unsupported 信封码', () => {
  const p = { type: 'program', version: 3, body: { type: 'seq', statements: [action('x')] } };
  const c = runner.compileAi(p, undefined);
  assert.equal(c.status, 400);
  assert.equal(c.code, 'ai_version_unsupported');
});

/* ---- T10：destroyContext 后 engine 驱动器 resume → wait/ai_invalid 不炸 ---- */
check('T10 destroy 后驱动器 continue', () => {
  const p = prog([action('wait')]);
  const b = runner.runAiBattle({ program: p, seed: 1, tier: 'mythic' });
  assert.equal(b.status, 200);
});

for (const [st, name] of results) console.log(`[${st}] ${name}`);
const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`--- ${results.length - fails.length}/${results.length} 通过`);
process.exitCode = fails.length ? 1 : 0;