'use strict';
// 测试基线指纹的契约测试（P7-7 测试审查 §⑤ 盲区 1 的 P0 第①条）
// 契约见 scripts/README.md「baseline.js 契约」。
// 单进程约束（gate.js:362-364 实测）：同一进程内第二次嵌套 run() 的流永不结束，且覆盖率会话中嵌套 run()
// 会破坏外层覆盖数据 → 本文件**绝不**真实 run()，全部走纯函数 / 注入假事件流。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const baseline = require('../../scripts/baseline.js');

// 假事件流工厂：形如 node:test 的 run() 事件（实测字段见 baseline.js 文件头）
function ev(type, name, opts) {
  const o = opts || {};
  return {
    type,
    data: {
      name,
      file: o.file,
      nesting: o.nesting || 0,
      details: { type: o.suite ? 'suite' : 'test' },
    },
  };
}

// ---------- BASE-1：指纹结构 + failedNames 排序 + digest 稳定 ----------

test('BASE-1 指纹字段齐全、failedNames 排序去重、digest 同输入恒同 / 输入变则变', () => {
  const fp = baseline.buildFingerprint({ total: 10, passed: 7, failed: 3, failedNames: ['乙', '甲', '甲'] });
  for (const k of ['total', 'passed', 'failed', 'failedNames', 'digest', 'generatedAt']) {
    assert.ok(Object.prototype.hasOwnProperty.call(fp, k), `指纹缺字段 ${k}`);
  }
  assert.equal(fp.total, 10);
  assert.equal(fp.failed, 3);
  assert.deepEqual(fp.failedNames, ['乙', '甲'].sort(), 'failedNames 必须去重并按名排序');
  assert.match(fp.digest, /^[0-9a-f]{12}$/, `digest 应是 12 位十六进制：${fp.digest}`);
  assert.ok(!Number.isNaN(Date.parse(fp.generatedAt)), 'generatedAt 应是可解析时间');

  // 同输入两次 → digest 相同（且与 generatedAt 无关：它不进 digest）
  const again = baseline.buildFingerprint({ total: 10, passed: 7, failed: 3, failedNames: ['甲', '乙'] });
  assert.equal(again.digest, fp.digest, '同输入两次 digest 必须相同');
  // suites 不进 digest（否则套件增删会伪造"指纹变了"）
  const withSuites = baseline.buildFingerprint({ total: 10, passed: 7, failed: 3, failedNames: ['甲', '乙'], suites: 4 });
  assert.equal(withSuites.digest, fp.digest, 'suites 不应影响 digest');
  assert.equal(withSuites.suites, 4);

  // 失败名变化 → digest 变
  const addedOne = baseline.buildFingerprint({ total: 10, passed: 6, failed: 4, failedNames: ['甲', '乙', '丙'] });
  assert.notEqual(addedOne.digest, fp.digest, '失败名增加必须改变 digest');
  // 只变总数（失败名不变）→ digest 也变
  const moreTotal = baseline.buildFingerprint({ total: 11, passed: 8, failed: 3, failedNames: ['甲', '乙'] });
  assert.notEqual(moreTotal.digest, fp.digest, '总数变化必须改变 digest');
});

// ---------- BASE-2：事件流折叠只认叶用例（套件事件不得计成"用例"） ----------

test('BASE-2 事件折叠：套件 pass/fail 不计入用例数，失败名带文件前缀', async () => {
  const root = path.join(os.tmpdir(), 'dl-baseline-fold');
  const file = path.join(root, 'tests', 'fake.test.js');
  const events = [
    ev('test:pass', '叶用例一', { file }),
    ev('test:pass', '叶用例二', { file }),
    ev('test:fail', '叶用例三', { file }),
    ev('test:pass', '外层套件', { file, suite: true }),
    ev('test:fail', '外层套件', { file, suite: true }), // 套件因内层失败也发一条 fail（实测）
    { type: 'test:summary', data: { counts: {} } },      // 无关事件必须被忽略
  ];
  const fp = baseline.fingerprintFromEvents(events, root);
  assert.equal(fp.total, 3, '套件事件不得计入总用例数（否则一个嵌套失败会被计 2 条）');
  assert.equal(fp.passed, 2);
  assert.equal(fp.failed, 1);
  assert.equal(fp.suites, 2);
  assert.deepEqual(fp.failedNames, [`tests/fake.test.js :: 叶用例三`], '失败名应带相对文件前缀');

  // collectBaseline 的注入缝（测试内不真实 run()）：假 runner + 显式 files
  const injected = await baseline.collectBaseline({ projectRoot: root, files: [file], runner: async () => events });
  assert.equal(injected.digest, fp.digest, 'collectBaseline(注入 runner) 必须与纯函数折叠同源同值');
  assert.equal(injected.files, 1);
});

// ---------- BASE-3：compareBaseline 三态 ----------

test('BASE-3 compareBaseline：新增失败→1 / 仅已修复→0 / 总数变化被记录', () => {
  const base = { total: 100, passed: 98, failed: 2, failedNames: ['A', 'B'] };

  // ① 无差异 → 退出码 0
  const same = baseline.compareBaseline(base, { total: 100, passed: 98, failed: 2, failedNames: ['B', 'A'] });
  assert.equal(same.ok, true);
  assert.equal(same.exitCode, 0);
  assert.deepEqual(same.added, []);
  assert.deepEqual(same.fixed, []);

  // ② 仅已修复（B 修好；总数因新增用例 +3）→ 退出码 0，且总数变化被记录
  const fixedOnly = baseline.compareBaseline(base, { total: 103, passed: 102, failed: 1, failedNames: ['A'] });
  assert.equal(fixedOnly.ok, true, '仅已修复不得判负');
  assert.equal(fixedOnly.exitCode, 0);
  assert.deepEqual(fixedOnly.fixed, ['B']);
  assert.deepEqual(fixedOnly.added, []);
  assert.deepEqual(fixedOnly.total, { from: 100, to: 103, delta: 3 }, '总数变化必须记录');
  assert.deepEqual(fixedOnly.failed, { from: 2, to: 1, delta: -1 });

  // ③ 新增失败 → 退出码 1
  const regression = baseline.compareBaseline(base, { total: 100, passed: 97, failed: 3, failedNames: ['A', 'B', 'C'] });
  assert.equal(regression.ok, false);
  assert.equal(regression.exitCode, 1);
  assert.deepEqual(regression.added, ['C']);
  assert.equal(regression.digest.changed, true);

  // ④ 失败数增长却没有新名字（重名折叠）→ 同样判负（防比较空转）
  const dup = baseline.compareBaseline({ total: 10, failed: 1, failedNames: ['X'] }, { total: 10, failed: 2, failedNames: ['X'] });
  assert.equal(dup.ok, false, '失败数增长但名字重复出现时必须判负');
  assert.equal(dup.countOnlyGrowth, true);
});

// ---------- BASE-4：投毒 —— 比较逻辑不得空转 ----------

test('BASE-4 投毒：假基线 1 失败 vs 真结果 3 失败 → 必判"新增 2 条失败"', () => {
  const realBaseline = { total: 500, passed: 499, failed: 1, failedNames: ['tests/x.test.js :: 老朋友失败'] };
  const poisonedRun = {
    total: 500,
    passed: 497,
    failed: 3,
    failedNames: ['tests/x.test.js :: 新红一', 'tests/x.test.js :: 老朋友失败', 'tests/y.test.js :: 新红二'],
  };
  const cmp = baseline.compareBaseline(realBaseline, poisonedRun);
  assert.equal(cmp.added.length, 2, `必须判出 2 条新增失败，实得 ${JSON.stringify(cmp.added)}`);
  assert.deepEqual(cmp.added, ['tests/x.test.js :: 新红一', 'tests/y.test.js :: 新红二'].sort(), '新增失败必须点名');
  assert.equal(cmp.unchanged.length, 1, '老失败不得被算成新增');
  assert.equal(cmp.exitCode, 1);

  // 反向对照：3 红 → 1 红 是"已修复 2 条"，退出码 0（证明不是恒判负）
  const reverse = baseline.compareBaseline(poisonedRun, realBaseline);
  assert.equal(reverse.added.length, 0);
  assert.equal(reverse.fixed.length, 2);
  assert.equal(reverse.exitCode, 0);
});

// ---------- BASE-5：缺基线文件 → 退出码语义 2；用法错误 → 3 ----------

// 捕获 CLI 标准输出（防止用法文本污染测试报告）
async function captureMain(args) {
  const orig = process.stdout.write;
  let out = '';
  process.stdout.write = (chunk) => { out += String(chunk); return true; };
  try {
    return { code: await baseline.main(args), out };
  } finally {
    process.stdout.write = orig;
  }
}

test('BASE-5 基线缺失/损坏 → 语义码 2（提示先 --write）；用法错误 → 3；合法文件可读回', async () => {
  assert.equal(baseline.EXIT.NO_BASELINE, 2);
  assert.equal(baseline.EXIT.USAGE, 3);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-baseline-'));
  try {
    // ① 文件缺失
    const missing = baseline.readBaseline(path.join(tmp, 'runtime', 'test-baseline.json'));
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 2);
    assert.ok(missing.message.includes('--write'), `提示应含 --write：${missing.message}`);

    // ② 内容损坏
    const corruptPath = path.join(tmp, 'corrupt.json');
    fs.writeFileSync(corruptPath, '{ 这不是 JSON', 'utf8');
    const corrupt = baseline.readBaseline(corruptPath);
    assert.equal(corrupt.ok, false);
    assert.equal(corrupt.code, 2);

    // ③ 结构不对（缺 failedNames）
    const shapePath = path.join(tmp, 'shape.json');
    fs.writeFileSync(shapePath, '{"total":1}', 'utf8');
    assert.equal(baseline.readBaseline(shapePath).code, 2);

    // ④ 合法写入（嵌套目录自动创建）→ 可读回
    const fp = baseline.buildFingerprint({ total: 5, passed: 5, failed: 0, failedNames: [] });
    const written = baseline.writeBaseline(fp, path.join(tmp, 'runtime', 'nested', 'test-baseline.json'));
    assert.ok(fs.existsSync(written), 'writeBaseline 应自动建目录');
    const rd = baseline.readBaseline(written);
    assert.equal(rd.ok, true);
    assert.equal(rd.code, 0);
    assert.equal(rd.baseline.digest, fp.digest);
    assert.deepEqual(rd.baseline.failedNames, []);

    // ⑤ CLI 用法分支（不跑真实套件）：--help → 0；未知参数 / --write+--compare → 3
    const help = await captureMain(['--help']);
    assert.equal(help.code, 0);
    assert.ok(help.out.includes('--compare'), `--help 应打印用法：${help.out}`);
    assert.equal((await captureMain(['--bogus'])).code, 3, '未知参数应退出 3');
    assert.equal((await captureMain(['--write', '--compare'])).code, 3, '互斥参数应退出 3');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- BASE-6：锚点必须落在**受版本控制**的路径（runtime/ 被 .gitignore 忽略 → 锚点永不入库） ----------

test('BASE-6 默认锚点路径入库：.audit/test-baseline.json（不在 runtime/ 下）且文件真实存在可用', () => {
  const rel = baseline.toPosix(path.relative(baseline.REPO, baseline.BASELINE_PATH));
  assert.equal(rel, '.audit/test-baseline.json', `默认锚点应是 .audit/test-baseline.json，实得 ${rel}`);
  assert.equal(/^runtime\//.test(rel), false, '锚点不得落在 runtime/（.gitignore 忽略 → 新克隆/CI 上 --compare 恒 exit 2）');
  assert.ok(rel.startsWith('.audit/'), '锚点应与既有审查快照同处 .audit/（已入库）');
  // 入库的锚点必须真的可读（否则 --compare 对新克隆仍退化为 exit 2）
  const rd = baseline.readBaseline(baseline.BASELINE_PATH);
  assert.equal(rd.ok, true, `仓库内锚点应可读：${rd.message || ''}`);
  assert.equal(rd.code, 0);
  assert.match(rd.baseline.digest, /^[0-9a-f]{12}$/);
  assert.ok(Array.isArray(rd.baseline.failedNames));
  // 默认 --help 文案也应指向新路径（防止文档/提示回退到 runtime/）
  const helpText = baseline.usage();
  assert.ok(helpText.includes('.audit/test-baseline.json'), `用法文本应指向新锚点：${helpText}`);
  assert.equal(helpText.includes('runtime/test-baseline.json'), false, '用法文本不得再提 runtime/ 锚点');
});

// ---------- BASE-7：--write 护栏（投毒：红状态必须拒绝覆写绿锚点） ----------

test('BASE-7 投毒：--write 护栏——有失败 → 拒绝（exit 3）；--force 才放行；绿状态放行', () => {
  const green = baseline.buildFingerprint({ total: 679, passed: 679, failed: 0, failedNames: [] });
  const red = baseline.buildFingerprint({
    total: 683, passed: 680, failed: 3, failedNames: ['tests/unit/ranked.test.js :: T-RK-1d'],
  });
  const greenOk = baseline.writeGuard(green, {});
  assert.equal(greenOk.ok, true);
  assert.equal(greenOk.code, 0);
  assert.equal(greenOk.forced, false);
  // 红状态：拒绝，且必须是"用法/内部错误"语义码 3（不是 0/1）
  const refused = baseline.writeGuard(red, {});
  assert.equal(refused.ok, false, '红状态必须拒绝 --write');
  assert.equal(refused.code, 3);
  assert.equal(refused.failed, 3);
  assert.ok(refused.message.includes('拒绝写入基线'), `拒绝文案应点明拒绝：${refused.message}`);
  assert.ok(refused.message.includes('--force'), `拒绝文案应提示 --force：${refused.message}`);
  // 显式 --force：放行但标记 forced（供 CLI 打印"已锚定含失败的基线"）
  const forced = baseline.writeGuard(red, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(forced.forced, true);
  // 护栏是"有失败"而非"总数"：failed 缺失时按 0 处理（不误拒）
  assert.equal(baseline.writeGuard({ total: 5, passed: 5, failedNames: [] }, {}).ok, true);
});
