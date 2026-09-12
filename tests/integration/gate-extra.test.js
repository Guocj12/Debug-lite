'use strict';
// P0-5 门禁覆盖补充测试 —— 覆盖 checkSchema/checkDocData/checkNumericHardcode/checkLogNaming
// 的分支路径（假 runner，无嵌套 run()）。契约见 scripts/README.md「gate.js 契约」。
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
  try {
    return await checkFn({ projectRoot: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------- 项 4：checkSchema（validateStructure）全分支 ----------

test('GX-1 checkSchema：schema.js 存在但无 validateStructure → fail', async () => {
  const r = await runCheck(gate.checkSchema, { 'server/data/schema.js': 'module.exports = {};' });
  assert.equal(r.status, 'fail');
  assert.ok(r.detail.includes('validateStructure'), r.detail);
});

test('GX-2 checkSchema：validateStructure 返回 ok/fail/抛错', async () => {
  const ok = await runCheck(gate.checkSchema, {
    'server/data/schema.js': "module.exports = { validateStructure: () => ({ ok: true, detail: '全过' }) };",
  });
  assert.equal(ok.status, 'pass');
  const bad = await runCheck(gate.checkSchema, {
    'server/data/schema.js': "module.exports = { validateStructure: () => ({ ok: false, detail: 'regen 缺失' }) };",
  });
  assert.equal(bad.status, 'fail');
  assert.ok(bad.detail.includes('regen 缺失'), bad.detail);
  const boom = await runCheck(gate.checkSchema, {
    'server/data/schema.js': "module.exports = { validateStructure: () => { throw new Error('boom'); } };",
  });
  assert.equal(boom.status, 'fail');
  assert.ok(boom.detail.includes('boom'), boom.detail);
});

// ---------- 项 5 子 A：T-DC-8 D 编号落点（checkDNumberLocations 全分支） ----------

test('GX-3 checkDNumberLocations：interfaces.md 存在且含 D 编号 → pass；缺 D → fail；无 interfaces → pending', async () => {
  const ok = await runCheck(gate.checkDNumberLocations, {
    'docs/interfaces.md': '## D-001 落点：battle-config\n## D-002 落点：rng\n',
    'docs/decisions.md': '# D-001 决策\n# D-002 决策\n',
  });
  assert.equal(ok.status, 'pass', ok.detail);
  assert.ok(ok.detail.includes('interfaces.md 已建立'), ok.detail);
  const bad = await runCheck(gate.checkDNumberLocations, {
    'docs/interfaces.md': '## D-001 落点\n',
    'docs/decisions.md': '# D-001 决策\n# D-999 决策\n',
  });
  assert.equal(bad.status, 'fail', 'D-999 无落点必须 fail');
  assert.ok(bad.detail.includes('D-999'), bad.detail);
  const pend = await runCheck(gate.checkDNumberLocations, {
    'docs/decisions.md': '# D-001 决策\n',
  });
  assert.equal(pend.status, 'pending', '无 interfaces.md 必须 pending');
});

// ---------- 项 5 子 B：T-DC-2 items-data ↔ 数据表（checkDocConsistency） ----------

test('GX-4 checkDocConsistency：真实仓库 → pass；无 schema.js → pending；validateConsistency 缺失 → fail', async () => {
  const repo = gate.checkDocConsistency();
  assert.equal(repo.status, 'pass', `真实仓库一致性应通过: ${repo.detail}`);
  const pend = await runCheck(gate.checkDocConsistency, { 'server/data/README.md': '#' });
  assert.equal(pend.status, 'pending', '无 schema.js 必须 pending');
  const bad = await runCheck(gate.checkDocConsistency, {
    'server/data/schema.js': "module.exports = { validateConsistency: () => ({ ok: false, detail: '找不到 rp_atk_pct' }) };",
  });
  assert.equal(bad.status, 'fail', bad.detail);
});

// ---------- 项 6②：checkNumericHardcode 全分支 ----------

test('GX-5 checkNumericHardcode：配置解析失败 → fail；嵌套数组取值也抓', async () => {
  const bad = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': '{"cellPx": }', // 非法 JSON
  });
  assert.equal(bad.status, 'fail');
  assert.ok(bad.detail.includes('解析失败'), bad.detail);
  const nested = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': '{"tiers": [[0.80, 0.88], [0.88, 0.97]]}',
    'server/core/field.js': 'const LO = 0.88;',
  });
  assert.equal(nested.status, 'fail', '嵌套数组内的 0.88 应被认作配置值');
});

test('GX-5b 通用常量 {0,1,-1} 不判硬编码（P2-3：朝向/计数器与机制数值无关）', async () => {
  const ok = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': '{"cellPx": 64, "startFacing": {"p1": 1, "p2": -1}, "bases": {"p1": {"hp": 100}}, "overtimeRatio": 0.0625}',
    'server/core/move.js': 'const dir = 1; const flip = -1; const idx = 0;',
  });
  assert.equal(ok.status, 'pass', `1/-1/0 不应误报: ${ok.detail}`);
  const bad = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': '{"overtimeRatio": 0.0625}',
    'server/core/move.js': 'const r = 0.0625;',
  });
  assert.equal(bad.status, 'fail', '真实机制数值仍必须来自配置');
});

test('GX-5c 标识符中的数字不误报（B1：mulberry32/uint32/hash32 的 "32"）', async () => {
  const config = '{"actorHalfPx": 32, "fieldPx": 1024}';
  const ok = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': config,
    'server/core/rng.js': 'function mulberry32(seed){} function hash32(s){} const u = uint32; const x = mulberry32(1);',
  });
  assert.equal(ok.status, 'pass', `标识符数字不应误报: ${ok.detail}`);
  const bad = await runCheck(gate.checkNumericHardcode, {
    'server/data/battle-config.json': config,
    'server/core/rng.js': 'const HALF = 32;',
  });
  assert.equal(bad.status, 'fail', '真正的字面量仍抓');
});

// ---------- 项 6①：checkLogNaming 通用形坏通道分支 ----------

test('GX-6 checkLogNaming：通用形 log.log 的未注册通道也抓', async () => {
  const r = await runCheck(gate.checkLogNaming, {
    'server/core/engine.js': "log.log('info', 'bogusChan', 'x.y', 'm');",
  });
  assert.equal(r.status, 'fail', r.detail);
  assert.ok(r.detail.includes('bogusChan'), r.detail);
});

// ---------- 项 1/2：模板字符串/字符串剥离边界 ----------

test('GX-7 字符串内容里的违规词不抓（模板/双引号），真代码抓', async () => {
  const ok = await runCheck(gate.checkStaticRandEval, {
    'server/core/rng.js': "const s1 = 'Math.random 在字符串里'; const s2 = `console 模板`; const s3 = \"new Function 字符串\";",
  });
  assert.equal(ok.status, 'pass', `字符串应剥除: ${ok.detail}`);
  const bad = await runCheck(gate.checkStaticRandEval, {
    'server/core/rng.js': 'class Foo { run() { return Math.random(); } }',
  });
  assert.equal(bad.status, 'fail', '真实代码中的调用仍抓');
});

test('GX-7b 块注释/行注释中的违规词不抓（剥注释分支）', async () => {
  const ok = await runCheck(gate.checkStaticRandEval, {
    'server/core/rng.js': '/* 块注释提到 Math.random */\nconst x = 1; // 行注释 new Function',
  });
  assert.equal(ok.status, 'pass', `块注释应剥除: ${ok.detail}`);
});

// ---------- gate/check-arch 的 main 入口（process.exitCode 化，可测试） ----------

test('GX-8 check-arch main：真实仓库无违规 → 0 退出码', () => {
  const prev = process.exitCode;
  const origLog = console.log;
  console.log = () => {}; // 捕获 main 的输出（避免污染门禁/套件报告）
  try {
    const rc = require('../../scripts/check-arch.js').main();
    assert.equal(rc, 0);
    assert.equal(process.exitCode, 0);
  } finally {
    process.exitCode = prev;
    console.log = origLog;
  }
});

test('GX-9 gate main：注入 runner 的临时仓库 → 0 失败', async () => {
  const root = makeProject({
    'tests/ok.test.js': "const {test}=require('node:test');test('t',()=>{});",
    'server/data/README.md': '#',
    'shared/README.md': '#',
  });
  const prev = process.exitCode;
  try {
    const fakeRunner = async () => ({ pass: 1, fail: 0, coverageSummary: { files: [] } });
    const rc = await gate.main({ projectRoot: root, runner: fakeRunner, quiet: true });
    assert.equal(rc, 0);
    assert.equal(process.exitCode, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    process.exitCode = prev;
  }
});

test('GX-10 runGate：架构违规 → 项 3 fail；项 6 全过路径（配置齐 + 代码干净）', async () => {
  const root = makeProject({
    'tests/ok.test.js': "const {test}=require('node:test');test('t',()=>{});",
    'server/data/battle-config.json': '{"cellPx": 64}',
    'server/core/engine.js': "module.exports = {};\nrequire('fs');",
    'server/core/rng.js': "module.exports = {};\nconst ok = true;",
    'shared/README.md': '#',
  });
  try {
    // 假 runner 的 summary 必须覆盖磁盘上的四目录文件（盲区判定 P1-3）
    const mk = (p) => ({ path: p, coveredLinePercent: 100, coveredBranchPercent: 100, coveredFunctionPercent: 100 });
    const fakeRunner = async () => ({
      pass: 1, fail: 0,
      coverageSummary: { files: [mk(path.join(root, 'server/core/engine.js')), mk(path.join(root, 'server/core/rng.js'))] },
    });
    const full = await gate.runGate({ projectRoot: root, runner: fakeRunner, quiet: true });
    const item3 = full.items.find((i) => i.id === 3);
    assert.equal(item3.status, 'fail', '架构违规必须 fail');
    const item6 = full.items.find((i) => i.id === 6);
    assert.equal(item6.status, 'pass', '配置齐且代码干净 → 项 6 全过分支');
    assert.equal(full.failed, 1, '仅项 3 失败');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GX-11 runGate：项 6 的 pending 组合（日志过 + 数值缺配置）', async () => {
  const root = makeProject({
    'tests/ok.test.js': "const {test}=require('node:test');test('t',()=>{});",
    'server/core/rng.js': "module.exports = {};",
    'shared/README.md': '#',
  });
  try {
    const mk = (p) => ({ path: p, coveredLinePercent: 100, coveredBranchPercent: 100, coveredFunctionPercent: 100 });
    const fakeRunner = async () => ({
      pass: 1, fail: 0,
      coverageSummary: { files: [mk(path.join(root, 'server/core/rng.js'))] },
    });
    const full = await gate.runGate({ projectRoot: root, runner: fakeRunner, quiet: true });
    const item6 = full.items.find((i) => i.id === 6);
    assert.equal(item6.status, 'pending', '数值硬编码缺配置 → pending');
    assert.equal(full.failed, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- 项 9：接口冒烟（checkApiSmoke） ----------

test('GX-12 checkApiSmoke：真实仓库 pass（health/data + CLI 闭环）；无服务端文件 → pending', async () => {
  const real = await gate.checkApiSmoke();
  assert.equal(real.status, 'pass', real.detail);
  const pend = await runCheck(gate.checkApiSmoke, { 'server/README.md': '#', 'cli/README.md': '#' });
  assert.equal(pend.status, 'pending', '无 server/index.js 与 cli/index.js 必须 pending');
});