'use strict';
/* scripts/baseline.js —— 测试基线指纹（P7-7 测试审查 `docs/reviews/P7-7-test-audit.md` §⑤ 盲区 1 的 P0 第①条）
 *
 * 要解决的问题：并行开发时"红 1 条（自己改坏）"与"红 9 条（他人半写）"在输出上无法区分 ——
 * 同一套测试 6 分钟内出现 fail 3 → 11 → 10 三种结果，而门禁只报"2 个用例失败(总 N)"。
 * 本脚本把任意一次全量测试结果压缩成**机器可读指纹**：
 *
 *   { total, passed, failed, failedNames: [按名排序], suites, digest, generatedAt }
 *
 * 采集方式（实现选择，勿随手改）：
 *   ① 调用 `node:test` 的 programmatic API `run()`，在**本进程内**单进程执行 tests 目录下全部 `*.test.js`
 *      （`isolation: 'none'`，与 scripts/gate.js 项 7 的 runSuite 同一做法）—— 不 spawn 任何子进程（沙箱禁
 *      `child_process`），也**不解析** TAP/默认 reporter 文本（脆弱）。
 *   ② 逐用例名直接从事件流取：`test:pass` / `test:fail` 事件的 `data.name` + `data.file`。
 *      实测（Node v24.18.0）事件形如：
 *        test:pass  data = { name, nesting, testNumber, testId, details:{type}, line, column, file }
 *        test:fail  data = { …, details:{ type:'test'|'suite', error, duration_ms } }
 *      **套件（describe / t.test 的子测试组）自己也会发一条 pass/fail 事件**，`details.type === 'suite'`；
 *      若不过滤，一个嵌套失败会被计成 2 条失败（叶用例 + 套件）。故本文件一律**只计叶用例**，
 *      套件事件只累加 `suites` 计数（用于解释与 gate 原口径的差值）。当前仓库 0 个套件，两口径数值相同。
 *   ③ 已知约束（gate.js:362-364 实测登记）：**同一进程内第二次嵌套 run() 的流永不结束** →
 *      每进程最多一次真实 run()。因此 `collectBaseline()` 支持注入 `runner`（测试用假事件流），
 *      测试套件内严禁真实 run()（也会破坏外层覆盖率会话）。
 *
 * 退出码（仅 `--compare` 有判定语义）：
 *   0 = 无差异 或 仅"已修复"    1 = 出现**新增失败**（回归）    2 = 基线文件缺失/不可用    3 = 用法或内部错误
 *
 * 约束：零依赖（只用 node 内置 fs/path/crypto）、CommonJS、禁 `Math.random`、禁 `child_process`。
 * 产物只写 `runtime/test-baseline.json`（`runtime/` 已 gitignore），不写仓库根、不写 docs。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.join(__dirname, '..');
// 基线文件落点：runtime/ 已 gitignore（不入库、不污染 git status）
const BASELINE_PATH = path.join(REPO, 'runtime', 'test-baseline.json');
// gate 项 7 明细里逐个打印的失败用例名上限（超出打印"剩余计数"）
const NAME_LIMIT = 10;
// digest 长度（sha256 十六进制前缀）——够短可读、够长防撞
const DIGEST_LEN = 12;

const EXIT = { OK: 0, NEW_FAILURES: 1, NO_BASELINE: 2, USAGE: 3 };

// ---------- 工具 ----------

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function toInt(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : (dflt || 0);
}

// 递归收集 *.test.js（排序 → 顺序确定，指纹才可复现）
function walkFiles(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, out);
    else if (entry.name.endsWith('.test.js')) out.push(p);
  }
}

function listTestFiles(projectRoot) {
  const root = projectRoot || REPO;
  const out = [];
  walkFiles(path.join(root, 'tests'), out);
  return out.sort();
}

// ---------- 指纹构造（纯函数，可单测） ----------

// 稳定哈希：sha256( `${total}\n${failedNames.join('\n')}` ) 的十六进制前 12 位。
// 只吃 total + 失败用例名 —— generatedAt / passed / suites 不进 digest，保证"同输入恒同指纹"。
function digestOf(total, failedNames) {
  const names = (failedNames || []).map(String);
  const canonical = `${toInt(total, 0)}\n${names.join('\n')}`;
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, DIGEST_LEN);
}

// 归一化并补 digest：failedNames 去重 + 按名排序（跨平台稳定：默认 sort 为码元序，不依赖 locale）
function buildFingerprint(part, opts) {
  const p = part || {};
  const total = toInt(p.total, 0);
  const passed = toInt(p.passed, 0);
  const failed = p.failed === undefined ? Math.max(0, total - passed) : toInt(p.failed, 0);
  const failedNames = [...new Set((p.failedNames || []).map(String))].sort();
  const suites = toInt(p.suites, 0);
  const generatedAt = (opts && opts.generatedAt) || new Date().toISOString();
  return { total, passed, failed, failedNames, suites, digest: digestOf(total, failedNames), generatedAt };
}

// 失败用例的稳定全名：`<相对文件名> :: <用例名>`。
// 带上文件是为了同名用例不互相折叠（仓库内多个文件存在同名用例），也让人眼能直接定位。
function qualifiedName(data, projectRoot) {
  const root = projectRoot || REPO;
  const file = data && data.file ? toPosix(path.relative(root, data.file)) : '(未知文件)';
  const name = (data && data.name) ? String(data.name) : '(未命名用例)';
  return `${file} :: ${name}`;
}

// 事件累加器：从 node:test 事件流折出 {total, passed, failed, suites, failedNames}
function createEventAccumulator(projectRoot) {
  const root = projectRoot || REPO;
  const names = new Set();
  const state = { total: 0, passed: 0, failed: 0, suites: 0 };
  return {
    // 只认 test:pass / test:fail；套件事件（details.type === 'suite'）不计入用例数
    add(e) {
      if (!e || (e.type !== 'test:pass' && e.type !== 'test:fail')) return;
      const data = e.data || {};
      if (data.details && data.details.type === 'suite') {
        state.suites += 1;
        return;
      }
      state.total += 1;
      if (e.type === 'test:pass') state.passed += 1;
      else {
        state.failed += 1;
        names.add(qualifiedName(data, root));
      }
    },
    state() { return { ...state }; },
    failedNames() { return [...names].sort(); },
    fingerprint(opts) {
      return buildFingerprint(Object.assign({}, state, { failedNames: [...names] }), opts);
    },
  };
}

// 纯函数：事件数组 → 指纹（测试可注入假事件流，避免第二次嵌套 run()）
function fingerprintFromEvents(events, projectRoot) {
  const acc = createEventAccumulator(projectRoot);
  for (const e of (events || [])) acc.add(e);
  return acc.fingerprint();
}

// ---------- 采集 ----------

// 默认采集缝：本进程内单进程跑全量测试（不 spawn、不解析 reporter 文本）。
// 注意：每进程最多一次真实 run()（见文件头 ③）。
async function collectEventsInProcess(files) {
  // eslint-disable-next-line global-require
  const { run } = require('node:test');
  const list = files || [];
  if (list.length === 0) {
    // 空匹配静默陷阱：绝不静默产出"0 用例"的基线（同 gate 项 7 的用例数 ≥ 1 断言）
    throw new Error('0 个测试文件可跑（tests/**/*.test.js 空匹配）——基线拒绝生成');
  }
  const r = run({ files: list.map((f) => path.resolve(f)), isolation: 'none' });
  const events = [];
  for await (const e of r) events.push(e);
  return events;
}

// options: { projectRoot, files, runner }
//   runner(files, projectRoot) → 事件数组，可注入（测试用假事件流）；默认 collectEventsInProcess
async function collectBaseline(options) {
  const opts = options || {};
  const root = opts.projectRoot || REPO;
  const files = opts.files || listTestFiles(root);
  const runner = opts.runner || collectEventsInProcess;
  const events = await runner(files, root);
  const fp = fingerprintFromEvents(events, root);
  fp.files = files.length; // 诊断用：本次采集覆盖的测试文件数（不进 digest）
  return fp;
}

// ---------- 对比（纯函数，可单测） ----------

function normalizeFingerprint(fp) {
  if (!fp || typeof fp !== 'object') throw new TypeError('指纹必须是对象');
  const total = toInt(fp.total, 0);
  const passed = toInt(fp.passed, 0);
  const failed = fp.failed === undefined ? Math.max(0, total - passed) : toInt(fp.failed, 0);
  const failedNames = [...new Set((fp.failedNames || []).map(String))].sort();
  return { total, passed, failed, failedNames, digest: fp.digest || digestOf(total, failedNames) };
}

// compareBaseline(base, current) → 差异对象（**纯函数**：CLI 与单测共用同一判定）
//   ok 语义：无新增失败（"仅已修复"与"无差异"都算 ok；总数变化只记录、不判负）
//   另判 `failed` 增长却没有新名字（重名折叠 / 无名失败）→ 同样视为回归，防止比较逻辑空转。
function compareBaseline(base, current) {
  const b = normalizeFingerprint(base);
  const c = normalizeFingerprint(current);
  const baseSet = new Set(b.failedNames);
  const curSet = new Set(c.failedNames);
  const added = c.failedNames.filter((n) => !baseSet.has(n));   // 新增失败 = 回归
  const fixed = b.failedNames.filter((n) => !curSet.has(n));    // 已修复
  const unchanged = c.failedNames.filter((n) => baseSet.has(n));
  const failedDelta = c.failed - b.failed;
  const countOnlyGrowth = failedDelta > added.length;           // 失败数增长多于"新增名字数"
  const totalDelta = c.total - b.total;
  const ok = added.length === 0 && !countOnlyGrowth;
  return {
    ok,
    exitCode: ok ? EXIT.OK : EXIT.NEW_FAILURES,
    added,
    fixed,
    unchanged,
    total: { from: b.total, to: c.total, delta: totalDelta },
    failed: { from: b.failed, to: c.failed, delta: failedDelta },
    digest: { from: b.digest, to: c.digest, changed: b.digest !== c.digest },
    countOnlyGrowth,
  };
}

// ---------- 基线文件读写 ----------

function readBaseline(filePath) {
  const p = filePath || BASELINE_PATH;
  if (!fs.existsSync(p)) {
    return {
      ok: false,
      code: EXIT.NO_BASELINE,
      message: `基线文件不存在：${toPosix(path.relative(REPO, p))}；先跑 node scripts/baseline.js --write`,
    };
  }
  try {
    const fp = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!fp || typeof fp !== 'object' || !Array.isArray(fp.failedNames)) {
      return { ok: false, code: EXIT.NO_BASELINE, message: `基线文件格式无效（缺 failedNames 数组）：${toPosix(path.relative(REPO, p))}；重跑 node scripts/baseline.js --write` };
    }
    return { ok: true, code: EXIT.OK, baseline: fp, path: p };
  } catch (e) {
    return { ok: false, code: EXIT.NO_BASELINE, message: `基线文件解析失败（${e.message}）：${toPosix(path.relative(REPO, p))}；重跑 node scripts/baseline.js --write` };
  }
}

function writeBaseline(fp, filePath) {
  const p = filePath || BASELINE_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(fp, null, 2)}\n`, 'utf8');
  return p;
}

// ---------- 展示 ----------

// gate 项 7 明细用：总用例数 / 失败数 / 失败用例名（截断 10 + 剩余计数）/ digest
function formatDetail(fp, opts) {
  const limit = (opts && opts.limit) || NAME_LIMIT;
  const names = (fp && fp.failedNames) || [];
  const shown = names.slice(0, limit).join('、');
  const rest = names.length > limit ? `…(+${names.length - limit})` : '';
  // 有失败却没有名字（如测试注入的假 runner 未提供 baseline）→ 明说缺名字，不要写成"无"（自相矛盾）
  const failText = names.length === 0
    ? (fp.failed > 0 ? '（未提供用例名）' : '无')
    : `${shown}${rest}`;
  const suiteText = fp.suites ? ` / 套件 ${fp.suites}` : '';
  return `基线 总 ${fp.total} / 通过 ${fp.passed} / 失败 ${fp.failed}${suiteText}；失败用例: ${failText}；digest=${fp.digest}`;
}

// 人类可读一行摘要：baseline: 545 tests / 6 failing [A、B…] digest=ab12cd34ef56
function formatSummary(fp, opts) {
  const limit = (opts && opts.limit) || 5;
  const names = (fp && fp.failedNames) || [];
  const shown = names.slice(0, limit).join('、');
  const rest = names.length > limit ? `…(+${names.length - limit})` : '';
  const failing = fp.failed > 0 ? ` / ${fp.failed} failing [${shown}${rest}]` : ' / 0 failing';
  return `baseline: ${fp.total} tests${failing} digest=${fp.digest}`;
}

function formatComparison(cmp, basePath) {
  const lines = [];
  lines.push(`对比基线：${basePath ? toPosix(path.relative(REPO, basePath)) : toPosix(path.relative(REPO, BASELINE_PATH))}`);
  lines.push(`  总用例数：${cmp.total.from} → ${cmp.total.to}（${cmp.total.delta >= 0 ? '+' : ''}${cmp.total.delta}）`);
  lines.push(`  失败数：  ${cmp.failed.from} → ${cmp.failed.to}（${cmp.failed.delta >= 0 ? '+' : ''}${cmp.failed.delta}）`);
  lines.push(`  新增失败（回归）：${cmp.added.length} 条`);
  for (const n of cmp.added) lines.push(`    + ${n}`);
  lines.push(`  已修复：${cmp.fixed.length} 条`);
  for (const n of cmp.fixed) lines.push(`    - ${n}`);
  lines.push(`  digest：${cmp.digest.from} → ${cmp.digest.to}${cmp.digest.changed ? '（已变）' : '（未变）'}`);
  if (cmp.countOnlyGrowth) lines.push('  ※ 失败数增长多于新增失败名（重名折叠或无名失败）→ 同样计为回归');
  lines.push(cmp.ok
    ? `  结论：无新增失败${cmp.fixed.length ? `；已修复 ${cmp.fixed.length} 条` : ''} → 退出码 0`
    : `  结论：检测到 ${cmp.added.length} 条新增失败（回归） → 退出码 1`);
  return lines.join('\n');
}

// ---------- CLI ----------

function usage() {
  return [
    '用法：node scripts/baseline.js [--write] [--compare] [--help]',
    '',
    '  （默认）    采集全量测试 → 打印指纹 JSON + 人类可读摘要',
    '  --write     采集并把指纹写入 runtime/test-baseline.json（runtime/ 已 gitignore）',
    '  --compare   与 runtime/test-baseline.json 对比：新增失败 / 已修复 / 总数变化',
    '',
    '退出码：0 = 无差异或仅"已修复"；1 = 出现新增失败（回归）；2 = 基线文件缺失/不可用；3 = 用法或内部错误',
  ].join('\n');
}

async function main(argv) {
  const args = argv || process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return EXIT.OK;
  }
  const unknown = args.filter((a) => !['--write', '--compare', '--help', '-h'].includes(a));
  if (unknown.length > 0) {
    process.stdout.write(`[FAIL] 未知参数：${unknown.join(' ')}\n${usage()}\n`);
    return EXIT.USAGE;
  }
  const wantWrite = args.includes('--write');
  const wantCompare = args.includes('--compare');
  if (wantWrite && wantCompare) {
    process.stdout.write(`[FAIL] --write 与 --compare 不能同时使用\n${usage()}\n`);
    return EXIT.USAGE;
  }

  if (wantCompare) {
    const rd = readBaseline();
    if (!rd.ok) {
      process.stdout.write(`[FAIL] ${rd.message}\n`);
      return rd.code; // 2
    }
    const current = await collectBaseline();
    process.stdout.write(`${formatSummary(current)}\n`);
    const cmp = compareBaseline(rd.baseline, current);
    process.stdout.write(`${formatComparison(cmp, rd.path)}\n`);
    return cmp.exitCode; // 0 或 1
  }

  const fp = await collectBaseline();
  process.stdout.write(`${JSON.stringify(fp, null, 2)}\n`);
  process.stdout.write(`${formatSummary(fp)}\n`);
  if (wantWrite) {
    const p = writeBaseline(fp);
    process.stdout.write(`已写入基线：${toPosix(path.relative(REPO, p))}\n`);
  }
  return EXIT.OK;
}

module.exports = {
  REPO, BASELINE_PATH, EXIT, NAME_LIMIT, DIGEST_LEN,
  toPosix, listTestFiles, digestOf, buildFingerprint, qualifiedName,
  createEventAccumulator, fingerprintFromEvents, collectEventsInProcess, collectBaseline,
  normalizeFingerprint, compareBaseline, readBaseline, writeBaseline,
  formatDetail, formatSummary, formatComparison, usage, main,
};

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((e) => {
    process.stderr.write(`[FAIL] baseline 采集失败：${e && e.stack ? e.stack : e}\n`);
    process.exitCode = EXIT.USAGE;
  });
}
