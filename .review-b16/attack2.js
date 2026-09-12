'use strict';
/* B16 红队实测 2：CLI 闭环 + seed 回带 + 退出码 + engine 缓冲引用安全 */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const cli = require('../cli/index.js');
const serverMod = require('../server/index.js');
const engine = require('../server/core/engine.js');
const runner = require('../server/runner.js');
const ast = require('../server/ai/ast.js');
const { createLogger } = require('../shared/log.js');
const FIX = require('../tests/fixtures/ai-programs.json');

const OK_FILE = path.join(__dirname, '..', 'tests', 'fixtures', 'cli-ai-ok.json');

async function capture(fn) {
  const origLog = console.log, origErr = console.error;
  const out = [];
  console.log = (...a) => out.push('out:' + a.join(' '));
  console.error = (...a) => out.push('err:' + a.join(' '));
  try { const code = await fn(); return { code, out }; }
  finally { console.log = origLog; console.error = origErr; }
}

const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message]); }
}

(async () => {
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  const baseUrl = `http://127.0.0.1:${s.port}`;
  try {
    await check('C1 CLI battle 无 seed：打印内容含服务端回带 seed', async () => {
      const { code, out } = await capture(() => cli.main(['ai', 'battle', '--file', OK_FILE], { baseUrl }));
      assert.equal(code, 0, '退出码 0');
      const line = out.find((l) => l.startsWith('out:'));
      assert.ok(line, '有 stdout 输出');
      const data = JSON.parse(line.slice(4));
      assert.ok(Number.isInteger(data.seed) && data.seed >= 1, '打印 seed 为服务端回带正整数');
      assert.ok(['p1', 'p2', 'draw'].includes(data.winner), 'winner 有值');
      assert.equal(data.frames.length, data.ticks);
    });
    await check('C2 CLI battle --seed 7 回带一致；--seed abc -> 1 + bad_seed', async () => {
      const r1 = await capture(() => cli.main(['ai', 'battle', '--file', OK_FILE, '--seed', '7'], { baseUrl }));
      assert.equal(r1.code, 0);
      const data = JSON.parse(r1.out.find((l) => l.startsWith('out:')).slice(4));
      assert.equal(data.seed, 7, '显式 seed 回带一致');
      const r2 = await capture(() => cli.main(['ai', 'battle', '--file', OK_FILE, '--seed', 'abc'], { baseUrl }));
      assert.equal(r2.code, 1, '非法 seed -> 业务拒绝 1');
      assert.ok(r2.out.some((l) => l.includes('bad_seed')), '服务端 400 bad_seed');
    });
    await check('C3 validate 非法 tier -> bad_tier；battle 非法 tier -> ai_invalid', async () => {
      const r1 = await capture(() => cli.main(['ai', 'validate', '--file', OK_FILE, '--tier', 'diamond'], { baseUrl }));
      assert.equal(r1.code, 1);
      assert.ok(r1.out.some((l) => l.includes('bad_tier')), 'validate bad_tier');
      const r2 = await capture(() => cli.main(['ai', 'battle', '--file', OK_FILE, '--tier', 'diamond'], { baseUrl }));
      assert.equal(r2.code, 1);
      console.log('  C3 battle 非法 tier 服务端码:', JSON.stringify(r2.out));
    });
    await check('C4 compile 打印 hash == 迁移后程序本地 hash', async () => {
      const r = await capture(() => cli.main(['ai', 'compile', '--file', OK_FILE], { baseUrl }));
      assert.equal(r.code, 0);
      const data = JSON.parse(r.out.find((l) => l.startsWith('out:')).slice(4));
      const local = JSON.parse(fs.readFileSync(OK_FILE, 'utf8'));
      const mig = ast.migrateProgram(local);
      assert.equal(data.programHash, ast.programHash(mig.program), 'CLI 打印 hash == 迁移后程序 hash');
    });
  } finally {
    await s.close();
  }

  await check('E1 diff.aiTraces 为 slice 拷贝 + 每 tick 清空语义', () => {
    const mk = () => ({ id: 'A', owner: 'p1', x: 224, facing: 1, hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60, atk: 12, def: 8, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [] });
    const b = engine.createBattle(undefined, { seed: 3, players: { p1: mk(), p2: Object.assign({}, mk(), { owner: 'p2' }) } });
    const buf = [];
    const actions = { aiTrace: buf, p1: () => { buf.push({ tick: 99, seq: 1 }); return 'wait'; }, p2: () => 'wait' };
    const diffs = [];
    for (let i = 0; i < 3; i++) diffs.push(b.step({ actions }));
    for (const d of diffs) assert.equal(d.aiTraces.length, 1, '每帧恰 1 条（清空语义）');
    assert.equal(diffs[0].aiTraces[0].tick, 99, '帧内条目为当 tick 增量');
    assert.notEqual(diffs[0].aiTraces, diffs[1].aiTraces, '互不共享引用');
    buf.push({ extra: true });
    const d4 = b.step({ actions });
    assert.deepEqual(d4.aiTraces, [{ tick: 99, seq: 1 }], '步骤外追加被下一 tick 清空；历史帧不受影响');
  });

  await check('E2 pDeepRec 递归内挂起 serialize/restore 往返', () => {
    const runtime = require('../server/ai/runtime.js');
    const p = JSON.parse(JSON.stringify(FIX.pDeepRec.program));
    const snap = { self: { hp: 100, atk: 1, def: 0, sp: 1, mp: 1, x: 224, baseHp: 100, facing: 1 }, enemy: { hp: 100, atk: 1, def: 0, sp: 1, mp: 1, x: 800, baseHp: 100, facing: -1 }, bullets: [], field: { fieldPx: 1024, cellPx: 64 } };
    const rng = () => ({ chance: () => false });
    const base = runtime.createContext(p);
    const baseActs = [];
    for (let i = 0; i < 10; i++) baseActs.push(runtime.resume(base, snap, rng()).action);
    const ctx = runtime.createContext(p);
    for (let i = 0; i < 5; i++) runtime.resume(ctx, snap, rng());
    const ser = JSON.parse(JSON.stringify(runtime.serializeContext(ctx)));
    const serFrames = ser.frames.map((f) => `${f.kind}:${f.path}`);
    const ctx2 = runtime.restoreContext(ser, p);
    const second = [];
    for (let i = 0; i < 5; i++) second.push(runtime.resume(ctx2, snap, rng()).action);
    console.log('  E2 帧:', JSON.stringify(serFrames));
    console.log('  E2 基线:', JSON.stringify(baseActs.slice(5)), '往返后:', JSON.stringify(second));
    assert.deepEqual(second, baseActs.slice(5), '递归深层挂起往返一致');
  });

  await check('E3 引擎路径函数跨 tick 续执行（无序列化）', () => {
    const p = JSON.parse(JSON.stringify(FIX.a5Function.program));
    const r = runner.runAiBattle({ program: p, seed: 5, tier: 'mythic' });
    assert.equal(r.status, 200);
    const acts = r.data.frames.flatMap((f) => f.aiTraces.filter((e) => e.nodeType === 'action')).map((e) => e.result);
    assert.ok(acts.includes('skill1'), '行动含 skill1');
    console.log('  E3 前 8 行动:', JSON.stringify(acts.slice(0, 8)));
  });

  await check('E4 serializeContext(null) 防御', () => {
    const runtime = require('../server/ai/runtime.js');
    try { runtime.serializeContext(null); }
    catch (e) { throw new Error('serializeContext(null) 未防御: ' + e.message); }
  });

  await check('E5 restoreContext 坏帧内容防御', () => {
    const runtime = require('../server/ai/runtime.js');
    const p = JSON.parse(JSON.stringify(FIX.a1Countdown.program));
    const ser = { frames: [null, 42, { kind: 'seq', path: 'body', childIndex: 0 }, { kind: 'loop', path: 'body.s[0]' }], vars: {}, entry: 'body' };
    const ctx = runtime.restoreContext(ser, p);
    assert.ok(Array.isArray(ctx.frames));
    const a = runtime.resume(ctx, { self: { hp: 1 }, enemy: { hp: 1 }, bullets: [], field: {} }, { chance: () => false }).action;
    assert.equal(typeof a, 'string');
  });

  await check('E6 seed 边界：0.5 / 负数 / 字符串 / 2^31-1', () => {
    const p = JSON.parse(JSON.stringify(FIX.a1Countdown.program));
    const b0 = runner.runAiBattle({ program: p, seed: 0.5, tier: 'mythic' });
    assert.equal(b0.status, 400); assert.equal(b0.code, 'bad_seed');
    const bn = runner.runAiBattle({ program: p, seed: -3, tier: 'mythic' });
    assert.equal(bn.status, 400); assert.equal(bn.code, 'bad_seed');
    const bbig = runner.runAiBattle({ program: p, seed: 2147483647, tier: 'mythic' });
    assert.equal(bbig.status, 200, '2^31-1 合法 seed');
    const bstr = runner.runAiBattle({ program: p, seed: '42', tier: 'mythic' });
    assert.equal(bstr.status, 400, '字符串 seed 拒绝');
  });

  for (const [st, name] of results) console.log(`[${st}] ${name}`);
  const fails = results.filter((r) => r[0] === 'FAIL');
  console.log(`--- ${results.length - fails.length}/${results.length} 通过`);
  process.exitCode = fails.length ? 1 : 0;
})();