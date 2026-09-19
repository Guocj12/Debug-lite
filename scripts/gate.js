'use strict';
/* scripts/gate.js —— 全量门禁（P0-5，tasks.md §3.4 九项）
 * 单进程内联：不 spawn 任何子进程；测试用 node:test run() 在本进程内执行。
 * 契约：scripts/README.md「gate.js 契约」；任一 FAIL → 退出码 1；PEND = 前置产物未落地（自动激活）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { run } = require('node:test');
const { analyze } = require('./check-arch.js');
// 项 7 明细用：测试基线指纹（P7-7 §⑤ 盲区 1"红不可区分"的 P0 第①条）
const { createEventAccumulator, buildFingerprint, formatDetail } = require('./baseline.js');

const REPO = path.join(__dirname, '..');
const STATIC_SCOPE = ['server/core', 'server/ai']; // 项 1 范围（T-DC-3）
const CONSOLE_SCOPE = ['server/core'];             // 项 2 范围（T-DC-5）
const THRESHOLD_DIRS = ['server/core', 'server/ai', 'shared', 'cli']; // 覆盖率阈值目录（§3.4）
const LINE_PCT = 90;
const BRANCH_PCT = 85;
const FUNC_PCT = 90;

const EVENT_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;
// 通道 → 允许的事件首段（§4.6 导出，见 scripts/README.md）
const PREFIX_MAP = {
  rng: ['rng'], field: ['field'], effects: ['effect'], items: ['items'],
  roles: ['role'], skills: ['skill'], bullets: ['bullet'],
  engine: ['tick', 'battle', 'move', 'collision', 'resource', 'action'],
  damage: ['damage'], 'ai.ast': ['ai'], 'ai.runtime': ['ai', 'trace'], unlock: ['unlock'],
  api: ['api'], cli: ['cli'], ranked: ['ranked', 'quick'], log: ['log'],
  store: ['store'], view: ['view'], render: ['render'], editor: ['editor'], perf: ['perf'],
};
// 通道注册表延迟加载：门禁进程不得在项 7 覆盖率会话开始前 require shared/log.js
// （V8 precise coverage 只统计会话开始之后加载的脚本 —— 预加载会使其覆盖率永久残缺，已实测）。
function channelRegistry() {
  const { CHANNELS } = require('../shared/log.js');
  return new Set(CHANNELS);
}

// ---------- 工具 ----------

function stripComments(src) {
  let out = '';
  let inLine = false;
  let inBlock = false;
  let inStr = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inLine) {
      out += c === '\n' ? c : ' ';
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      out += c === '\n' ? c : ' ';
      if (c === '*' && n === '/') { out += ' '; i++; inBlock = false; }
      continue;
    }
    if (inStr !== null) {
      out += c;
      if (c === inStr && src[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; out += c; continue; }
    if (c === '/' && n === '/') { out += '  '; i++; inLine = true; continue; }
    if (c === '/' && n === '*') { out += '  '; i++; inBlock = true; continue; }
    out += c;
  }
  return out;
}

// 先剥注释，再把字符串/模板挖空（保留换行），用于数值/静态匹配
function stripCommentsAndStrings(src) {
  const noComments = stripComments(src);
  let out = '';
  let inStr = null;
  for (let i = 0; i < noComments.length; i++) {
    const c = noComments[i];
    if (inStr !== null) {
      out += c === '\n' ? c : ' ';
      if (c === inStr && noComments[i - 1] !== '\\') inStr = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; out += ' '; continue; }
    out += c;
  }
  return out;
}

function walkFiles(dir, ext, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(p, ext, out);
    else if (entry.name.endsWith(ext)) out.push(p);
  }
}

function scopeFiles(projectRoot, dirs, ext) {
  const out = [];
  for (const d of dirs) walkFiles(path.join(projectRoot, d), ext, out);
  return out.sort();
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function resultOf(status, detail) {
  return { status, detail };
}

// ---------- 项 1：静态 Math.random / eval / new Function（T-DC-3） ----------

function checkStaticRandEval(options) {
  const root = (options && options.projectRoot) || REPO;
  const files = scopeFiles(root, STATIC_SCOPE, '.js');
  const patterns = [
    [/Math\s*\.\s*random\s*\(/g, 'Math.random'],
    [/\beval\s*\(/g, 'eval('],
    [/\bnew\s+Function\s*\(/g, 'new Function('],
  ];
  const hits = [];
  for (const f of files) {
    const src = stripCommentsAndStrings(fs.readFileSync(f, 'utf8'));
    for (const [re, label] of patterns) {
      let m;
      while ((m = re.exec(src)) !== null) {
        hits.push(`${toPosix(path.relative(root, f))} 含 ${label}`);
      }
    }
  }
  if (hits.length > 0) return resultOf('fail', hits.join('；'));
  return resultOf('pass', `${files.length} 个文件无 ${patterns.map((p) => p[1]).join('/')}`);
}

// ---------- 项 2：静态 console.*（T-DC-5，仅 core） ----------

function checkStaticConsole(options) {
  const root = (options && options.projectRoot) || REPO;
  const files = scopeFiles(root, CONSOLE_SCOPE, '.js');
  const hits = [];
  for (const f of files) {
    const src = stripCommentsAndStrings(fs.readFileSync(f, 'utf8'));
    const re = /\bconsole\b/g; // 剥注释/字符串后，裸 console 标识符即为违规（含别名形式）
    let m;
    while ((m = re.exec(src)) !== null) {
      hits.push(`${toPosix(path.relative(root, f))} 含 console`);
    }
  }
  if (hits.length > 0) return resultOf('fail', hits.join('；'));
  return resultOf('pass', `${files.length} 个 core 文件无 console.*`);
}

// ---------- 项 6②：战斗数值未硬编码（T-DC-7） ----------

function collectNumbers(obj, out) {
  if (Array.isArray(obj)) {
    for (const v of obj) collectNumbers(v, out);
    return;
  }
  if (obj !== null && typeof obj === 'object') {
    for (const k of Object.keys(obj)) collectNumbers(obj[k], out);
    return;
  }
  if (typeof obj === 'number' && Number.isFinite(obj)) out.push(obj);
}

function checkNumericHardcode(options) {
  const root = (options && options.projectRoot) || REPO;
  const configPath = path.join(root, 'server', 'data', 'battle-config.json');
  if (!fs.existsSync(configPath)) {
    return resultOf('pending', 'battle-config.json 缺失（P0-6 落地后激活）');
  }
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return resultOf('fail', `battle-config.json 解析失败: ${e.message}`);
  }
  const configValues = new Set();
  const vals = [];
  collectNumbers(config, vals);
  // 排除通用常量 {0,1,-1}：计数器/朝向/布尔数值与战斗机制数值无关（P0-6 审查 P2-3）
  for (const v of vals) {
    if (v !== 0 && v !== 1 && v !== -1) configValues.add(v);
  }

  const files = scopeFiles(root, STATIC_SCOPE, '.js');
  // token 边界：前后不得是标识符/小数点字符（避免 mulberry32/uint32/hash32 里的 "32" 误报，B1 实测）
  const numRe = /(?<![\w.])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w.])/g;
  // 行级豁免标记（审查可见）：源码行尾 `// cl:100` 标注"该数值为通用精度常量、非战斗数值"——
  // 先于注释剥离收集，扫描时跳过（P0-5 起登记，B3 实测 round2 精度常量与 baseDef 撞值）。
  const exemption = [];
  const hits = [];
  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8');
    const exemptNow = new Set();
    const exRe = /\/\/\s*cl:\s*([^\n]+)/g;
    let ex;
    while ((ex = exRe.exec(raw)) !== null) {
      for (const tok of (ex[1].match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || [])) {
        const n = Number(tok);
        if (Number.isFinite(n)) exemptNow.add(n);
      }
    }
    const src = stripCommentsAndStrings(raw);
    let m;
    while ((m = numRe.exec(src)) !== null) {
      const n = Number(m[0]);
      if (configValues.has(n) && !exemptNow.has(n)) {
        hits.push(`${toPosix(path.relative(root, f))} 硬编码数值 ${m[0]}（应读取 battle-config.json）`);
      }
    }
  }
  if (hits.length > 0) return resultOf('fail', hits.join('；'));
  return resultOf('pass', `${files.length} 个文件无战斗数值硬编码`);
}

// ---------- 项 6①：日志事件命名（T-DC-6，core+ai） ----------

// logger 接收者限定：log/logger/_log/L/ctx.log 等标识符（启发式，见契约；L 为 items/effects 惯用短名，B3 加）
const LOG_CALL_RE =
  /(?:(?:this|self|ctx|state|battle)\.)?(?:log(?:ger|Fn)?|logger|_log|L)\.(fatal|error|warn|info|debug|trace)\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
const LOG_GENERIC_RE =
  /(?:(?:this|self|ctx|state|battle)\.)?(?:log(?:ger|Fn)?|logger|_log|L)\.log\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;

function checkLogNaming(options) {
  const root = (options && options.projectRoot) || REPO;
  const files = scopeFiles(root, STATIC_SCOPE, '.js');
  const hits = [];
  const CHANNEL_SET = channelRegistry();
  for (const f of files) {
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    let m;
    // 便捷方法形：.info('channel', 'event', ...)
    while ((m = LOG_CALL_RE.exec(src)) !== null) {
      const channel = m[2];
      const event = m[3];
      if (!CHANNEL_SET.has(channel)) {
        hits.push(`${toPosix(path.relative(root, f))} 未注册通道 '${channel}'`);
        continue;
      }
      const check = validateEvent(channel, event);
      if (check) hits.push(`${toPosix(path.relative(root, f))} ${check}`);
    }
    // 通用形：.log('level', 'channel', 'event', ...)
    while ((m = LOG_GENERIC_RE.exec(src)) !== null) {
      const channel = m[2];
      const event = m[3];
      if (!CHANNEL_SET.has(channel)) {
        hits.push(`${toPosix(path.relative(root, f))} 未注册通道 '${channel}'`);
        continue;
      }
      const check = validateEvent(channel, event);
      if (check) hits.push(`${toPosix(path.relative(root, f))} ${check}`);
    }
  }
  if (hits.length > 0) return resultOf('fail', hits.join('；'));
  return resultOf('pass', `${files.length} 个文件的日志事件命名合规`);
}

function validateEvent(channel, event) {
  if (!EVENT_RE.test(event)) return `事件 '${event}' 不符合 name.dot.name 规范`;
  const first = event.split('.')[0];
  const allowed = PREFIX_MAP[channel] || [];
  if (!allowed.includes(first)) {
    return `事件 '${event}' 首段 '${first}' 与通道 ${channel} 的前缀映射不符（允许: ${allowed.join('/')}）`;
  }
  return null;
}

// ---------- 项 4：数据表 schema（T-DC-1，P0-6 激活） ----------

function checkSchema(options) {
  const root = (options && options.projectRoot) || REPO;
  const schemaPath = path.join(root, 'server', 'data', 'schema.js');
  if (!fs.existsSync(schemaPath)) {
    return resultOf('pending', 'server/data/schema.js 缺失（P0-6 落地后激活）');
  }
  // eslint-disable-next-line global-require
  const schema = require(schemaPath);
  if (typeof schema.validateStructure !== 'function') {
    return resultOf('fail', 'schema.js 未导出 validateStructure(dataDir)');
  }
  try {
    const res = schema.validateStructure(path.join(root, 'server', 'data'));
    if (res.ok) return resultOf('pass', res.detail || '数据表 schema 校验通过');
    return resultOf('fail', res.detail || '数据表 schema 校验失败');
  } catch (e) {
    return resultOf('fail', `schema 校验抛错: ${e.message}`);
  }
}

// ---------- 项 5 子 A：D 编号落点（T-DC-8，P0-7 激活） ----------

function checkDNumberLocations(options) {
  const root = (options && options.projectRoot) || REPO;
  const interfacesPath = path.join(root, 'docs', 'interfaces.md');
  if (!fs.existsSync(interfacesPath)) {
    return resultOf('pending', 'docs/interfaces.md 缺失（P0-7 落地后激活）');
  }
  const problems = [];
  const decisionsPath = path.join(root, 'docs', 'decisions.md');
  if (fs.existsSync(decisionsPath)) {
    const decisions = fs.readFileSync(decisionsPath, 'utf8');
    const dRe = /D-(\d{2,3})/g;
    const dList = new Set();
    let m;
    while ((m = dRe.exec(decisions)) !== null) dList.add(`D-${m[1]}`);
    let haystack = fs.readFileSync(interfacesPath, 'utf8');
    const dataDir = path.join(root, 'server', 'data');
    if (fs.existsSync(dataDir)) {
      for (const f of fs.readdirSync(dataDir)) {
        if (f.endsWith('.json') || f.endsWith('.js')) {
          haystack += fs.readFileSync(path.join(dataDir, f), 'utf8');
        }
      }
    }
    const missing = [...dList].filter((d) => !haystack.includes(d));
    if (missing.length > 0) {
      problems.push(`decisions.md 的 ${missing.join('、')} 在 interfaces.md/数据表无落点`);
    }
  }
  if (problems.length > 0) return resultOf('fail', problems.join('；'));
  return resultOf('pass', 'D 编号落点检查通过（interfaces.md 已建立）');
}

// ---------- 项 5 子 B：items-data ↔ 数据表一致性（T-DC-2，P0-6 激活） ----------

function checkDocConsistency(options) {
  const root = (options && options.projectRoot) || REPO;
  const schemaPath = path.join(root, 'server', 'data', 'schema.js');
  if (!fs.existsSync(schemaPath)) {
    return resultOf('pending', 'server/data/schema.js 缺失（T-DC-2 随 P0-6 接线后激活）');
  }
  // eslint-disable-next-line global-require
  const schema = require(schemaPath);
  if (typeof schema.validateConsistency !== 'function') {
    return resultOf('fail', 'schema.js 未导出 validateConsistency(dataDir)');
  }
  try {
    const res = schema.validateConsistency(path.join(root, 'server', 'data'));
    if (res.ok) return resultOf('pass', res.detail || 'items-data ↔ 数据表一致');
    return resultOf('fail', res.detail || 'items-data ↔ 数据表不一致');
  } catch (e) {
    return resultOf('fail', `一致性校验抛错: ${e.message}`);
  }
}

// ---------- 项 5：合并（fail > pend > pass） ----------

function checkDocData(options) {
  const a = checkDNumberLocations(options);
  const b = checkDocConsistency(options);
  const worst = (x, y) => (x.status === 'fail' || y.status === 'fail' ? 'fail'
    : x.status === 'pending' || y.status === 'pending' ? 'pending' : 'pass');
  const status = worst(a, b);
  const detail = `T-DC-8(${a.status}): ${a.detail}；T-DC-2(${b.status}): ${b.detail}`;
  return status === 'pass' ? resultOf('pass', detail) : resultOf(status, detail);
}

// ---------- 项 7：全量测试 + 覆盖率（进程内 run()） ----------

// 注意（2026-09-12 实测，Node v24.18.0）：同一进程内**第二次**嵌套 run() 的流永不结束
// （测试能跑、但 for-await 收不到结束事件），与是否带 coverage 无关。
// → 每进程最多一次真实 run()：gate 主流程恰好一次（项 7）；测试注入 runner 覆盖其它分支。

// 真实执行一套测试（coverage 可选）；返回 {pass, fail, coverageSummary, baseline|null}
// 注意：pass/fail 仍按事件原口径累加（判定与阈值一字未改）；`baseline` 是新增的**指纹**附件
// （叶用例口径，套件事件不计入用例数）——只用于项 7 的明细描述。
async function runSuite(files, withCoverage) {
  const r = run({ files: files.map((f) => path.resolve(f)), isolation: 'none', coverage: withCoverage });
  let pass = 0;
  let fail = 0;
  let coverageSummary = null;
  const acc = createEventAccumulator(REPO); // 真实全量套件恒在仓库根运行，相对路径才稳定可读
  for await (const e of r) {
    if (e.type === 'test:pass') pass++;
    else if (e.type === 'test:fail') fail++;
    else if (e.type === 'test:coverage') coverageSummary = e.data && e.data.summary;
    acc.add(e);
  }
  return { pass, fail, coverageSummary, baseline: acc.fingerprint() };
}

// 纯判定：仅 THRESHOLD_DIRS 四目录、每文件阈值；返回 {ok, under[]}
// 盲区兜底（P0-5 审查 P1-3）：磁盘上存在、但从未被测试加载（不在 summary）的四目录文件
// 覆盖率视为 0% —— 否则新文件可凭"未加载"逃过门禁。
function judgeCoverage(coverageSummary, projectRoot) {
  const reported = new Set();
  const under = [];
  for (const f of (coverageSummary && coverageSummary.files) || []) {
    const rel = f.path ? toPosix(path.relative(projectRoot, f.path)) : '';
    if (!THRESHOLD_DIRS.some((d) => rel.startsWith(`${d}/`) || rel === d)) continue;
    reported.add(rel);
    if (f.coveredLinePercent < LINE_PCT || f.coveredBranchPercent < BRANCH_PCT || f.coveredFunctionPercent < FUNC_PCT) {
      under.push(`${rel} 行${f.coveredLinePercent}%/分支${f.coveredBranchPercent}%/函数${f.coveredFunctionPercent}%`);
    }
  }
  // 磁盘扫描：四目录内 *.js 但报告缺失 → 0%
  const onDisk = [];
  for (const d of THRESHOLD_DIRS) walkFiles(path.join(projectRoot, d), '.js', onDisk);
  for (const f of onDisk) {
    const rel = toPosix(path.relative(projectRoot, f));
    if (!reported.has(rel)) {
      under.push(`${rel} 未被任何测试加载（覆盖率 0%）`);
    }
  }
  return { ok: under.length === 0, under };
}

// 全仓聚合覆盖率（**诊断值，不参与判定**）：P7-7 §P0 第⑨条口径统一 ——
//   门禁项 7 是**每文件**语义（仅 THRESHOLD_DIRS 四目录）；`npm run cov` 是**聚合**语义（全文件合计）。
//   两套语义「互不覆盖」曾导致"gate 绿 / cov 红"的自我欺骗（审查 §B8）。现把聚合值一并打印在项 7 明细里，
//   于是**同一条命令输出两个口径**；判定仍只按每文件阈值（scripts/README.md「覆盖率口径统一」）。
function aggregateCoverage(coverageSummary) {
  const t = coverageSummary && coverageSummary.totals;
  if (!t) return null;
  const pct = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : null);
  return { line: pct(t.coveredLinePercent), branch: pct(t.coveredBranchPercent), func: pct(t.coveredFunctionPercent) };
}

function aggregateText(coverageSummary) {
  const agg = aggregateCoverage(coverageSummary);
  if (!agg) return '';
  return `；全仓聚合（含 tests/scripts/.audit，诊断值非门禁）行${agg.line}/分支${agg.branch}/函数${agg.func}`;
}

// options: {projectRoot, runner, withCoverage}
//   runner(files, withCoverage) 可注入（测试用假 runner 避免第二次嵌套 run）
//   withCoverage 默认 true（gate 主流程）；测试传 false —— 嵌套 coverage 会话会破坏外层覆盖率
//   报告（已实测：外层 cov 下 shared/log.js 覆盖率被截断），且进程内第二次嵌套 run() 流永不结束。
//   假 runner 未提供 baseline 指纹时，退化为"由 pass/fail 计数现造一个（失败名未知）"——仅为打印。
async function checkTests(options) {
  const opts = options || {};
  const root = opts.projectRoot || REPO;
  const withCoverage = opts.withCoverage !== false;
  const testFiles = scopeFiles(root, ['tests'], '.test.js');
  if (testFiles.length === 0) {
    return resultOf('fail', '0 个测试文件（空匹配静默陷阱：门禁必须断言测试数 ≥ 1）');
  }
  const doRun = opts.runner || runSuite;
  const res = await doRun(testFiles, withCoverage);
  // 指纹明细（P7-7 §⑤ 盲区 1）：无论 PASS/FAIL 都打印 总用例数 / 失败数 / 失败用例名 / digest。
  // 只影响描述文本，不参与任何判定（阈值与语义见上方注释与 scripts/README.md）。
  const fp = res.baseline || buildFingerprint({
    total: res.pass + res.fail, passed: res.pass, failed: res.fail, failedNames: [],
  });
  const fpText = formatDetail(fp);
  if (res.fail > 0) return resultOf('fail', `${res.fail} 个用例失败（总 ${res.pass + res.fail}）${aggregateText(res.coverageSummary)}；${fpText}`);
  if (res.pass === 0) return resultOf('fail', `0 个用例通过；${fpText}`);
  if (!withCoverage) {
    // 非 coverage 模式（仅测试/诊断）：不断言覆盖率
    return resultOf('pass', `${res.pass} 用例通过（未采集覆盖率）；${fpText}`);
  }
  if (!res.coverageSummary) return resultOf('fail', `未产生覆盖率报告（可疑）；${fpText}`);
  const judged = judgeCoverage(res.coverageSummary, root);
  const aggText = aggregateText(res.coverageSummary);
  if (!judged.ok) {
    return resultOf('fail', `覆盖率低于阈值（行${LINE_PCT}/分支${BRANCH_PCT}/函数${FUNC_PCT}）：${judged.under.join('；')}${aggText}；${fpText}`);
  }
  return resultOf('pass', `${res.pass} 用例通过；四目录覆盖率行≥${LINE_PCT}/分支≥${BRANCH_PCT}/函数≥${FUNC_PCT}${aggText}；${fpText}`);
}

// ---------- 项 8：日志冒烟（B11 激活） ----------
// trace 跑黄金战斗（固定 loadout/AI/seed）→ 关键事件齐备 + cid 链 + 与 silent 同 seed 逐帧一致（T-LG-11/5）。
// 注意：项 8 在项 7 覆盖率会话后执行——此处 require 均为 lazy（V8 机制见 scripts/README）。
async function checkLogSmoke(options) {
  const root = (options && options.projectRoot) || REPO;
  if (!fs.existsSync(path.join(root, '.audit', 'golden-battle.js'))) {
    return resultOf('pending', '.audit/golden-battle.js 缺失（B11 落地后激活）');
  }
  // eslint-disable-next-line global-require
  const { createLogger } = require('../shared/log.js');
  // eslint-disable-next-line global-require
  const engine = require(path.join(root, 'server', 'core', 'engine.js'));
  // eslint-disable-next-line global-require
  const skills = require(path.join(root, 'server', 'core', 'skills.js'));

  const mk = (P) => ({
    id: P === 'p1' ? 'A' : 'B', owner: P,
    x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
    hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
    atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9,
    regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [],
  });
  const sk = (id, ov) => Object.assign(skills.instantiateSkill(id, 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 }), ov || {});

  const battleOf = (logger) => {
    const p1 = mk('p1');
    const p2 = mk('p2');
    p1.skills = { precise: sk('skill_straight_precise', { multiplier: 1.0 }) };
    p2.skills = { bash: sk('skill_dash_bash', { multiplier: 1.3, distance: 4, passThroughEnemy: false, dealDamage: true }) };
    return engine.createBattle({}, { seed: 20260912, logger, players: { p1, p2 } });
  };
  const actions = goldenActions();

  // trace 场
  const traceLogger = createLogger({ level: 'all', ringSize: 5000 });
  const traceBattle = battleOf(traceLogger);
  const traceRes = traceBattle.runFull({ actions });

  // 事件齐备（§4.6 L4 行关键集）
  const recs = traceLogger.records;
  const expect = ['battle.create', 'tick.begin', 'tick.step', 'tick.end', 'move.resolve', 'resource.regen', 'battle.judge', 'battle.end'];
  const missing = expect.filter((e) => !recs.some((r) => r.event === e));
  if (missing.length) return resultOf('fail', `关键事件缺失：${missing.join('，')}`);
  // cid 链：事件流顺序 cast → spawn → hit → end（首个 cast 之后的依次首现；tick 归属由 diff 帧承担）
  const c1 = recs.findIndex((r) => r.event === 'skill.cast');
  if (c1 === -1) return resultOf('fail', 'cid 链事件缺失：skill.cast');
  const c2 = recs.findIndex((r, i) => i > c1 && r.event === 'bullet.spawn');
  const c3 = recs.findIndex((r, i) => i > c2 && r.event === 'bullet.hit');
  const c4 = recs.findIndex((r, i) => i > c3 && r.event === 'tick.end');
  if (c2 === -1 || c3 === -1 || c4 === -1) return resultOf('fail', 'cid 链事件缺失（spawn/hit/end）');
  // 此处原有 `if (!(c1 < c2 && c2 < c3 && c3 < c4)) return fail('cid 链顺序异常…')`——
  //   2026-09-19 死代码清理（P7-7 §B6）：**不可达**。c2/c3/c4 由 `findIndex((r,i) => i > 前一个 && …)`
  //   求得，findIndex 返回的索引必然 > 前一个；`-1` 已由上一行拦住。故 `c1<c2 && c2<c3 && c3<c4`
  //   是**重言式**。实测：7 元素事件序列（含重复 bullet.spawn/tick.end）的全部相异排列中，
  //   133 例顺序成立、1127 例落到上一行的"缺失"分支、**0 例**顺序异常。
  //   "cid 乱序必 FAIL"这条语义由上一行承担（乱序会让某个后继事件再也找不到）；
  //   回归钉 = tests/integration/gate-poison-extra.test.js GX-P4（断言"缺失"分支文字，不依赖本分支）。

  // 与 silent 同 seed 逐帧一致（日志不影响确定性）
  const silentBattle = battleOf(createLogger({ level: 'silent' }));
  const silentRes = silentBattle.runFull({ actions });
  if (JSON.stringify(silentRes.diffs) !== JSON.stringify(traceRes.diffs)) {
    return resultOf('fail', 'trace 与 silent 帧输出不一致（日志影响确定性）');
  }
  return resultOf('pass', `黄金战斗 ${traceRes.ticks} tick（winner=${traceRes.winner}）事件齐全 + cid 链 + 与 silent 逐帧一致`);
}

// 黄金行动序列（与 .audit/golden-battle.js 相同的 40 tick 计划 + wait 兜底）
function goldenActions() {
  const plan = {
    p1: ['dodge_right', 'move_left', 'wait', 'skill:precise', 'move_right', 'skill:precise', 'dodge_left', 'wait',
      'move_right', 'move_left', 'skill:precise', 'dodge_right', 'wait', 'move_left', 'skill:precise', 'dodge_left',
      'move_right', 'wait', 'move_left', 'skill:precise', 'dodge_right', 'move_right', 'wait', 'skill:precise',
      'dodge_left', 'move_left', 'wait', 'dodge_right', 'move_right', 'skill:precise', 'wait', 'move_left',
      'dodge_left', 'skill:precise', 'wait', 'move_right', 'dodge_right', 'wait', 'move_left', 'skill:precise'],
    p2: ['move_left', 'wait', 'skill:bash', 'dodge_left', 'move_right', 'wait', 'skill:bash', 'dodge_right',
      'wait', 'move_left', 'skill:bash', 'wait', 'dodge_right', 'move_left', 'skill:bash', 'wait',
      'dodge_left', 'move_right', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'skill:bash', 'wait',
      'move_right', 'wait', 'dodge_left', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'skill:bash',
      'wait', 'move_right', 'dodge_left', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'wait'],
  };
  return {
    p1: (state) => plan.p1[state.tick - 1] || 'wait',
    p2: (state) => plan.p2[state.tick - 1] || 'wait',
  };
}

// ---------- 项 9：接口冒烟（P0-8 激活） ----------
// 同进程 listen(0) 起服务 → GET /api/v1 关键端点 → 进程内 CLI 闭环（无 spawn，真实 HTTP 传输）。
// 注意：shared/log.js 在本函数内 require 是安全的——项 9 在项 7 的覆盖率会话结束后执行（V8 机制见 scripts/README）。
async function checkApiSmoke(options) {
  const root = (options && options.projectRoot) || REPO;
  const indexPath = path.join(root, 'server', 'index.js');
  const cliPath = path.join(root, 'cli', 'index.js');
  if (!fs.existsSync(indexPath) || !fs.existsSync(cliPath)) {
    return resultOf('pending', 'server/index.js 与 cli/index.js 缺失（P0-8 落地后激活）');
  }
  // eslint-disable-next-line global-require
  const { createLogger } = require('../shared/log.js');
  // eslint-disable-next-line global-require
  const { start } = require(indexPath);
  // eslint-disable-next-line global-require
  const { main: cliMain } = require(cliPath);
  const http = require('node:http');

  const getJson = (port, urlPath) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
      // 跨 chunk 多字节字符必须按 Buffer 累积后整段解码（`d += c` 逐 chunk toString → U+FFFD）
      const chunks = [];
      res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
      res.on('end', () => {
        const d = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(d); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: j });
      });
    }).on('error', reject);
  });

  const s = await start({ logger: createLogger({ level: 'silent' }) });
  try {
    const checks = [];
    const health = await getJson(s.port, '/api/v1/health');
    checks.push(health.status === 200 && health.body && health.body.ok === true ? null : 'health 信封异常');
    const data = await getJson(s.port, '/api/v1/data/battle-config');
    checks.push(data.status === 200 && data.body && data.body.data && data.body.data.cellPx === 64 ? null : 'data battle-config 异常');
    // CLI 闭环：捕获其 stdout 输出避免污染门禁报告
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const rcHealth = await cliMain(['health'], { baseUrl: base });
      const rcData = await cliMain(['data', 'battle-config'], { baseUrl: base });
      checks.push(rcHealth === 0 && rcData === 0 ? null : `CLI 闭环退出码 health=${rcHealth} data=${rcData}`);
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    const problems = checks.filter(Boolean);
    if (problems.length > 0) return resultOf('fail', problems.join('；'));
    return resultOf('pass', 'health/data 端点 + CLI 闭环（退出码 0）通过');
  } finally {
    await s.close();
  }
}

// ---------- 主入口 ----------

async function runGate(options) {
  const root = (options && options.projectRoot) || REPO;
  const runner = (options && options.runner) || undefined; // 测试注入：避免第二次嵌套 run()（见项 7 注释）
  const quiet = !!(options && options.quiet);              // 测试静默（避免门禁输出被套件吞并）
  const items = [
    { id: 1, name: '静态：无 Math.random/eval/new Function（T-DC-3）', fn: checkStaticRandEval },
    { id: 2, name: '静态：server/core 无 console.*（T-DC-5）', fn: checkStaticConsole },
    { id: 3, name: '架构依赖方向（T-DC-4）', fn: async () => {
      const res = analyze({ projectRoot: root });
      if (res.violations.length > 0) {
        return resultOf('fail', res.violations.slice(0, 5).map((v) => `${v.file} [${v.rule}] ${v.detail}`).join('；'));
      }
      return resultOf('pass', `${res.files} 个文件无依赖违规`);
    } },
    { id: 4, name: '数据表 schema（T-DC-1）', fn: checkSchema },
    { id: 5, name: '文档↔数据一致性 + D 编号落点（T-DC-2/8）', fn: checkDocData },
    { id: 6, name: '日志事件命名 + 数值未硬编码（T-DC-6/7）', fn: async () => {
      const a = checkLogNaming({ projectRoot: root });
      const b = checkNumericHardcode({ projectRoot: root });
      if (a.status === 'fail') return a;
      if (b.status === 'fail') return b;
      if (a.status === 'pending' || b.status === 'pending') {
        return resultOf('pending', `${[a, b].filter((x) => x.status === 'pending').map((x) => x.detail).join('；')}`);
      }
      return resultOf('pass', `${a.detail}；${b.detail}`);
    } },
    { id: 7, name: '全量测试 + 覆盖率（§3.4 第 7 项）', fn: (o) => checkTests({ projectRoot: o.projectRoot, runner }), },
    { id: 8, name: '日志冒烟：trace 跑一场 + cid 链路 + 与 silent 逐帧一致（T-LG-11/5）', fn: checkLogSmoke },
    { id: 9, name: '接口冒烟：listen(0) → /api/v1 → CLI 闭环（T-AP-*/T-CLI-*）', fn: checkApiSmoke },
  ];
  const results = [];
  let failed = 0;
  // 执行顺序：项 7 最先行 —— 它的覆盖率会话必须先于任何 shared/log.js 加载（懒加载配合，
  // 使 log.js 在会话开始后被套件首次 require，覆盖率才完整；V8 precise coverage 只统计会话后加载的脚本）。
  const execOrder = [7, 1, 2, 3, 4, 5, 6, 8, 9];
  for (const id of execOrder) {
    const item = items.find((i) => i.id === id);
    const res = await item.fn({ projectRoot: root });
    results.push({ id: item.id, name: item.name, ...res });
    if (quiet) {
      if (res.status === 'fail') failed++;
      continue;
    }
    const tag = res.status === 'pass' ? 'PASS' : res.status === 'fail' ? 'FAIL' : 'PEND';
    console.log(`[${tag}] 项${item.id} ${item.name}`);
    console.log(`        ${res.detail}`);
    if (res.status === 'fail') failed++;
  }
  if (!quiet) {
    console.log('---');
    console.log(`gate: ${results.filter((r) => r.status === 'pass').length} PASS / ${failed} FAIL / ${results.filter((r) => r.status === 'pending').length} PEND`);
    if (failed > 0) console.log('※ FAIL 只能通过修代码/修测试解决；禁止放宽阈值（tasks.md §3.4/§10）');
  }
  return { failed, items: results };
}

async function main(options) {
  const { failed } = await runGate(options || {}); // options.runner 仅供测试注入
  process.exitCode = failed > 0 ? 1 : 0;
  return failed;
}

module.exports = {
  REPO, checkStaticRandEval, checkStaticConsole, checkNumericHardcode,
  checkLogNaming, checkSchema, checkDocData, checkDNumberLocations, checkDocConsistency,
  checkTests, runSuite, judgeCoverage, aggregateCoverage, aggregateText,
  validateEvent, checkApiSmoke, checkLogSmoke, runGate, main,
};

if (require.main === module) {
  main();
}