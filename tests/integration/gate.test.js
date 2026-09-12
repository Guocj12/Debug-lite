'use strict';
// T-DC-3/5/6/7 + 门禁项 7 的契约测试 —— 契约见 scripts/README.md「gate.js 契约」
// 用临时目录 fixture 验证各检查真抓违规（不靠打印通过）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('../../scripts/gate.js');

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-gate-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return root;
}

async function runCheck(checkFn, files) {
  const root = makeProject(files);
  const res = await checkFn({ projectRoot: root });
  fs.rmSync(root, { recursive: true, force: true });
  return res;
}

// ---------- 项 1：静态 Math.random / eval / new Function（T-DC-3，core+ai） ----------

test('GATE-1a core 内 Math.random/eval/new Function 均被抓', async () => {
  const r1 = await runCheck(gate.checkStaticRandEval, { 'server/core/rng.js': 'const x = Math.random();' });
  assert.equal(r1.status, 'fail', `Math.random 应 fail: ${r1.detail}`);
  const r2 = await runCheck(gate.checkStaticRandEval, { 'server/core/rng.js': "const x = eval('1+1');" });
  assert.equal(r2.status, 'fail');
  const r3 = await runCheck(gate.checkStaticRandEval, { 'server/core/rng.js': "const f = new Function('a','return a');" });
  assert.equal(r3.status, 'fail');
});

test('GATE-1b 注释里的违规词不抓；ai 目录同样扫描；core/ai 之外不扫描', async () => {
  const ok = await runCheck(gate.checkStaticRandEval, {
    'server/core/rng.js': '// 注释提到 Math.random 不算\nconst x = 1;',
  });
  assert.equal(ok.status, 'pass', `注释不应误报: ${ok.detail}`);
  const ai = await runCheck(gate.checkStaticRandEval, { 'server/ai/runtime.js': 'const r = Math.random();' });
  assert.equal(ai.status, 'fail', 'ai 目录应扫描');
  const cli = await runCheck(gate.checkStaticRandEval, { 'cli/index.js': 'const r = Math.random();' });
  assert.equal(cli.status, 'pass', 'cli 不在项 1 范围');
});

// ---------- 项 2：静态 console.*（T-DC-5，仅 core） ----------

test('GATE-2a core 内 console.* 被抓', async () => {
  const r = await runCheck(gate.checkStaticConsole, { 'server/core/engine.js': 'console.log("hi");' });
  assert.equal(r.status, 'fail');
  const r2 = await runCheck(gate.checkStaticConsole, { 'server/core/engine.js': 'const c = console;' });
  assert.equal(r2.status, 'fail', 'console 别名也抓');
});

test('GATE-2b ai/cli 的 console 不属项 2 范围；注释不误报', async () => {
  const ai = await runCheck(gate.checkStaticConsole, { 'server/ai/runtime.js': 'console.log("trace ok");' });
  assert.equal(ai.status, 'pass', '项 2 仅 core');
  const ok = await runCheck(gate.checkStaticConsole, { 'server/core/engine.js': '// console.log 注释\nconst x = 1;' });
  assert.equal(ok.status, 'pass');
});

// ---------- 项 6②：战斗数值未硬编码（T-DC-7，依赖 battle-config.json） ----------

test('GATE-3a 配置值以字面量出现在 core/ai → fail；配置缺失 → pending', async () => {
  const r = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': '{"cellPx": 64, "backstab": 1.5}',
    'server/core/field.js': 'const CELL = 64; const B = 1.5;',
  });
  assert.equal(r.status, 'fail', `two literals should fail: ${r.detail}`);
  assert.ok(r.detail.includes('64') && r.detail.includes('1.5'), `detail 应列出两个值: ${r.detail}`);
  const ok = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': '{"cellPx": 64}',
    'server/core/field.js': 'const CELL = 63;',
  });
  assert.equal(ok.status, 'pass', '非配置值不抓');
  const pend = await runCheck(gate.checkNumericHardcode, { 'server/core/field.js': 'const CELL = 64;' });
  assert.equal(pend.status, 'pending', '配置缺失 → pending');
});

test('GATE-3b 注释/字符串里的配置值不抓', async () => {
  const ok = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': '{"cellPx": 64}',
    'server/core/field.js': "// 64 是注释\nconst MSG = '64';",
  });
  assert.equal(ok.status, 'pass', `注释与字符串不应误报: ${ok.detail}`);
});

// ---------- 项 6①：日志事件命名（T-DC-6，core+ai） ----------

test('GATE-4a 未注册通道 / 事件无点 / 前缀不匹配 → fail', async () => {
  const badChan = await runCheck(gate.checkLogNaming, {
    'server/core/engine.js': "log.info('bogusChan', 'tick.begin', 'm');",
  });
  assert.equal(badChan.status, 'fail', `未注册通道应 fail: ${badChan.detail}`);
  const noDot = await runCheck(gate.checkLogNaming, {
    'server/core/bullets.js': "log.info('bullets', 'hit', 'm');",
  });
  assert.equal(noDot.status, 'fail', '事件无点应 fail');
  const badPrefix = await runCheck(gate.checkLogNaming, {
    'server/core/bullets.js': "log.info('bullets', 'damage.calc', 'm');",
  });
  assert.equal(badPrefix.status, 'fail', '前缀不匹配应 fail');
});

test('GATE-4b 合法调用（便捷方法与 log 通用形）通过；注释不误报；ai 通道合法', async () => {
  const ok = await runCheck(gate.checkLogNaming, {
    'server/core/engine.js':
      "log.info('engine', 'tick.begin', 'm');\n" +
      "log.log('debug', 'engine', 'move.resolve', 'm', {});\n" +
      "log.warn('log', 'log.suppressed', 'm');\n" +
      "// log.info('bullets', 'bad.event', '注释');",
  });
  assert.equal(ok.status, 'pass', `合法调用应通过: ${ok.detail}`);
  const ai = await runCheck(gate.checkLogNaming, {
    'server/ai/runtime.js': "log.debug('ai.runtime', 'ai.resume', 'm');",
  });
  assert.equal(ai.status, 'pass', 'ai.runtime 通道 + ai 前缀合法');
});

// ---------- 项 7：全量测试 + 覆盖率（进程内 run()） ----------
// 注意（Node v24.18.0 实测）：
//  1) 同一进程内第二次嵌套 run() 的流永不结束（与 coverage 无关）；
//  2) 覆盖率会话活动中执行嵌套 run() 会破坏外层覆盖率数据（gate 项 7 实测 shared/log.js 覆盖率被截断）。
// → 套件内**禁止**任何嵌套 run()：全部用假 runner 验证判定逻辑；
//    runSuite 真实路径由 `npm run gate` 本体自验证（实现缺陷 → 项 7 即红）。

test('GATE-5a 全部通过且测试数 ≥1 → pass（假 runner，withCoverage:false 分支）', async () => {
  const fakeRunner = async () => ({ pass: 1, fail: 0, coverageSummary: null });
  const r = await runCheck((o) => gate.checkTests({ projectRoot: o.projectRoot, runner: fakeRunner, withCoverage: false }), {
    'tests/ok.test.js': '// 假 runner 不会执行它',
  });
  assert.equal(r.status, 'pass', r.detail);
  assert.ok(r.detail.includes('未采集覆盖率'), r.detail);
});

test('GATE-5b 任一测试失败 → fail（假 runner：fail>0）', async () => {
  const fakeRunner = async () => ({ pass: 0, fail: 1, coverageSummary: null });
  const r = await runCheck((o) => gate.checkTests({ projectRoot: o.projectRoot, runner: fakeRunner }), {
    'tests/whatever.test.js': '// 假 runner 不会执行它',
  });
  assert.equal(r.status, 'fail', `失败用例必须 fail: ${r.detail}`);
  assert.ok(r.detail.includes('1 个用例失败'), r.detail);
});

test('GATE-5c 空测试目录（0 用例静默通过陷阱）→ fail', async () => {
  const r = await runCheck(gate.checkTests, { 'tests/README.md': '# no tests here' });
  assert.equal(r.status, 'fail', `0 用例必须 fail: ${r.detail}`);
  assert.ok(r.detail.includes('0'), 'detail 应说明用例数');
});

test('GATE-5d 覆盖阈值判定：四目录内不足 → fail；helpers 不做阈值 → pass（假 summary）', async () => {
  const root = makeProject({ 'tests/x.test.js': '// 占位测试（假 runner 不执行）', 'tests/README.md': '#', 'server/core/s.js': 'x', 'tests/helpers/low.js': 'y', 'cli/index.js': 'z', 'shared/log.js': 'w' });
  try {
    const mk = (dir, line, branch, func) => ({
      path: path.join(root, dir), coveredLinePercent: line, coveredBranchPercent: branch, coveredFunctionPercent: func,
    });
    const allDisk = [mk('server/core/s.js', 100, 100, 100), mk('cli/index.js', 100, 100, 100), mk('shared/log.js', 100, 100, 100)];
    // 判定函数本体（bad 场景：s.js 行 50%；其余磁盘文件以 100% 报告，避免盲区干扰）
    const bad = gate.judgeCoverage({ files: [mk('server/core/s.js', 50, 100, 100), ...allDisk.slice(1), mk('tests/helpers/low.js', 30, 30, 30)] }, root);
    assert.equal(bad.ok, false, 'core 行 50% 必须判负');
    assert.equal(bad.under.length, 1, '仅阈值目录内的文件计入');
    const okScope = gate.judgeCoverage({ files: [...allDisk, mk('tests/helpers/low.js', 30, 30, 30)] }, root);
    assert.equal(okScope.ok, true, 'helpers 不在阈值目录；（磁盘文件已全部报告）');
    const b3 = gate.judgeCoverage({ files: [mk('server/core/s.js', 100, 100, 100), mk('shared/log.js', 89, 100, 100), mk('cli/index.js', 100, 84, 100), mk('server/ai/ast.js', 100, 100, 89)] }, root);
    assert.equal(b3.under.length, 3, '四目录的行/分支/函数阈值各自生效');
    // 边界：恰好 90/85/90 → 通过（严格 < 语义）
    const boundary = gate.judgeCoverage({ files: [...allDisk, mk('shared/log.js', 90, 85, 90)] }, root);
    assert.equal(boundary.ok, true, '恰达阈值即通过');
    // 盲区兜底：磁盘上存在但报告缺失的四目录文件 → 0% 判负
    const blind = gate.judgeCoverage({ files: [] }, root);
    assert.equal(blind.ok, false, '磁盘文件未加载必须判负');
    assert.ok(blind.under.some((u) => u.includes('server/core/s.js')), `应点名未加载文件: ${blind.under.join(';')}`);
    // checkTests 走假 runner + 假 summary
    const fakeRunner = async () => ({ pass: 1, fail: 0, coverageSummary: { files: [mk('server/core/s.js', 50, 100, 100)] } });
    const r = await gate.checkTests({ projectRoot: root, runner: fakeRunner });
    assert.equal(r.status, 'fail', `core 覆盖不足应 fail: ${r.detail}`);
    const fakeOk = async () => ({ pass: 1, fail: 0, coverageSummary: { files: [...allDisk, mk('tests/helpers/low.js', 30, 30, 30)] } });
    const r2 = await gate.checkTests({ projectRoot: root, runner: fakeOk });
    assert.equal(r2.status, 'pass', `阈值目录外不判负: ${r2.detail}`);
    // pass=0 分支：0 通过 0 失败 → '0 个用例通过' fail
    const fakeZero = async () => ({ pass: 0, fail: 0, coverageSummary: { files: [] } });
    const r3 = await gate.checkTests({ projectRoot: root, runner: fakeZero });
    assert.equal(r3.status, 'fail', '0 通过必须 fail');
    assert.ok(r3.detail.includes('0 个用例通过'), r3.detail);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 项 4/5/8/9：pending 语义 ----------

test('GATE-6 前置缺失项报告 pending 而非 pass/fail（不伪造通过）', async () => {
  const schema = await runCheck(gate.checkSchema, { 'server/data/README.md': '#' });
  assert.equal(schema.status, 'pending');
  const docData = await runCheck(gate.checkDocData, { 'docs/README.md': '#' });
  assert.equal(docData.status, 'pending');
  const root = makeProject({
    'tests/ok.test.js': "const {test}=require('node:test');test('t',()=>{});",
    'server/data/README.md': '#',
    'docs/decisions.md': '# 决策记录（无 D 编号，避免项 5 误判）',
    'shared/README.md': '#',
  });
  let full;
  try {
    const fakeRunner = async () => ({ pass: 1, fail: 0, coverageSummary: { files: [] } });
    full = await gate.runGate({ projectRoot: root, runner: fakeRunner, quiet: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const pendIds = full.items.filter((i) => i.status === 'pending').map((i) => i.id);
  assert.ok(pendIds.includes(4) && pendIds.includes(8) && pendIds.includes(9), `4/8/9 应为 pending: ${pendIds}`);
  assert.equal(full.failed, 0, '无 FAIL 时 gate 通过');
});