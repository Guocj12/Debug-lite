'use strict';
/* scripts/check-docs.js —— 文档 ↔ 实现一致性检查（2026-09-16 新增）
 *
 * 定位：把"文档写了但代码没有 / 进度写了但状态不对"变成**机器可判定**的失败。
 *   本项目此前的最大问题正是这类漂移（`npm run demo` 引用不存在的脚本、批次计数 34/31/35 三值、
 *   端点被标"尚未启用"却已实现、P7 设计被当成现状）。
 *
 * 用法：
 *   node scripts/check-docs.js        # 打印 PASS/FAIL，任一 FAIL 退出码 1
 *   require('../scripts/check-docs.js').checkDocs()   # 供 tests/ 断言（接入 gate 项 7）
 *
 * 检查项：
 *   D1 npm 脚本存在性：package.json 的 scripts 与文档中的 `npm run X` 双向一致
 *   D2 文档引用的脚本文件存在（scripts/*.js、.audit/*.js）
 *   D3 文档引用的数据表存在（server/data/*.json、assets/*.json）
 *   D4 批次计数一致（tasks.md 头部 / progress.md / acceptance.md）
 *   D5 任务清单勾选数 = 批次数（且不得有"已完成但未勾选"的行）
 *   D6 每个已勾选批次都有 docs/reviews/<批次>.md 审查记录
 *
 * 约束：与 gate 同风格，零依赖、单进程、无 child_process。
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(REPO, p));

// 文档集合：入口 + 状态/契约类（内容层设计文档不在此检查）
const DOC_FILES = [
  'README.md', 'docs/progress.md', 'docs/tasks.md', 'docs/acceptance.md', 'docs/server.md',
  'docs/interfaces.md', 'docs/ai-handoff-prompt.md', 'scripts/README.md', 'server/data/README.md',
];

function checkDocs() {
  const problems = [];
  const notes = [];
  const texts = {};
  for (const f of DOC_FILES) {
    if (exists(f)) texts[f] = read(f);
    else problems.push(`${f} 不存在（check-docs 的文档清单与实际不符）`);
  }
  const pkg = JSON.parse(read('package.json'));
  const scriptNames = Object.keys(pkg.scripts || {});

  // D1：npm 脚本双向一致
  const mentioned = new Set();
  for (const [f, text] of Object.entries(texts)) {
    // 2026-09-16 修复（检查器自身缺陷，独立审查已预警）：脚本名允许数字与点，
    //   否则 `npm run e2e` 会被截成 `e`，导致 D1 双向错报（README 引用不存在脚本 + package.json 未登记）。
    for (const m of text.matchAll(/npm run ([a-z0-9:_.-]+)/g)) mentioned.add(m[1]);
    for (const m of text.matchAll(/`npm (start|test)`/g)) mentioned.add(m[1]);
  }
  for (const name of mentioned) {
    const isBuiltin = name === 'start' || name === 'test';
    if (!isBuiltin && !scriptNames.includes(name)) problems.push(`D1 ${[...Object.keys(texts)].find((f) => texts[f].includes(`npm run ${name}`))} 引用了不存在的 npm 脚本: ${name}`);
  }
  const undocumented = scriptNames.filter((s) => !mentioned.has(s) && s !== 'hooks:install');
  if (undocumented.length) problems.push(`D1 package.json 脚本未在文档登记: ${undocumented.join(', ')}`);
  notes.push(`npm 脚本 ${scriptNames.length} 个，文档引用 ${mentioned.size} 个`);

  // D2/D3：文档引用的脚本与数据表存在
  const refRe = /`((?:scripts|\.audit|server\/data|assets)\/[A-Za-z0-9_./-]+\.(?:js|json))`/g;
  const refs = new Set();
  for (const text of Object.values(texts)) {
    for (const m of text.matchAll(refRe)) refs.add(m[1]);
  }
  // 明确标注为"计划/不存在"的引用不参与存在性检查：
  //   ① 该行含 计划/未实现/不存在/待实现/⏳；② 该行属于 P7 计划批次（B27~B33）
  const PLANNED_ROW = /\|\s*B(?:2[7-9]|3[0-3])\s*\|/;
  for (const ref of refs) {
    if (!exists(ref)) {
      const anywhere = Object.entries(texts).find(([, t]) => t.includes(`\`${ref}\``));
      const line = anywhere ? anywhere[1].split('\n').find((l) => l.includes(`\`${ref}\``)) || '' : '';
      if (/计划|未实现|不存在|待实现|⏳|已删除|删除|已移除|移除|废弃/.test(line) || PLANNED_ROW.test(line)) continue;
      problems.push(`D2/D3 文档引用了不存在的文件: ${ref}`);
    }
  }
  notes.push(`文档引用脚本/数据表 ${refs.size} 个，全部存在（或已标注计划中）`);

  // D4：批次计数一致（只在 §6 阶段与批次段内解析，避免把测试点/层级/风险表当成批次行）
  const counts = {};
  const tasksText = texts['docs/tasks.md'] || '';
  const secStart = tasksText.search(/^## 6\./m);
  const secEnd = tasksText.search(/^## 7\./m);
  const batchSection = secStart === -1 ? '' : tasksText.slice(secStart, secEnd === -1 ? undefined : secEnd);
  const mTasks = /共\s*(\d+)\s*批/.exec(batchSection);
  if (mTasks) counts['docs/tasks.md'] = Number(mTasks[1]);
  const progressText = texts['docs/progress.md'] || '';
  const mProg = /共\s*(\d+)\s*批/.exec(progressText);
  if (mProg) counts['docs/progress.md'] = Number(mProg[1]);
  // D5：批次行 = §6 段内 `| <P0-1 或 B1> | <标记列> | ...`
  //   2026-09-16 修正：原正则要求 ID 后紧跟 `|`，导致 `| B1 `[ ]` |`（未勾选）**不匹配而被丢弃**，
  //   从而"已完成未勾选"根本发现不了（独立复审实测可绕过）。现改为捕获标记列内容并判定 `[x]`。
  const batchRow = /^\|\s*(P\d+-\d+|B\d+)\s*([^|]*)\|/gm;
  const PLANNED_BATCH = /^B(?:2[7-9]|3[0-3])$/; // P7 计划批次：未实现，允许未勾选
  const checked = [];
  const missing = [];
  const planned = [];
  for (const m of batchSection.matchAll(batchRow)) {
    const marked = /\[x\]/.test(m[2] || '');
    if (marked) checked.push(m[1]);
    else if (PLANNED_BATCH.test(m[1])) planned.push(m[1]);
    else missing.push(m[1]);
  }
  if (missing.length) problems.push(`D5 批次行缺 [x] 标记（需确认是否已完成）: ${missing.join(', ')}`);
  const batchTotal = checked.length;
  for (const [f, n] of Object.entries(counts)) {
    if (n !== batchTotal) problems.push(`D4/D5 批次计数不一致：${f} 写 ${n}，tasks.md 勾选 ${batchTotal}`);
  }
  if (Object.keys(counts).length === 0) problems.push('D4 未在任何文档中找到"共 N 批"的批次数声明');
  notes.push(`批次勾选 ${batchTotal} 个（缺标记 ${missing.length} 个 / 计划中 ${planned.length} 个），文档声明 ${JSON.stringify(counts)}`);

  // D6：每个已勾选批次有审查记录
  const noReview = checked.filter((id) => !exists(`docs/reviews/${id}.md`));
  if (noReview.length) problems.push(`D6 已勾选批次缺审查记录 docs/reviews/<批次>.md: ${noReview.join(', ')}`);
  notes.push(`审查记录覆盖 ${checked.length - noReview.length}/${checked.length}`);

  return {
    ok: problems.length === 0,
    detail: problems.length === 0 ? '文档↔实现一致性检查通过' : `发现 ${problems.length} 处不一致：${problems.slice(0, 10).join('；')}${problems.length > 10 ? `…(+${problems.length - 10})` : ''}`,
    problems,
    notes,
  };
}

if (require.main === module) {
  const r = checkDocs();
  for (const n of r.notes) process.stdout.write(`  · ${n}\n`);
  if (r.ok) {
    process.stdout.write('[PASS] check-docs：文档 ↔ 实现一致性\n');
    process.exit(0);
  }
  for (const p of r.problems) process.stdout.write(`[FAIL] ${p}\n`);
  process.exit(1);
}

module.exports = { checkDocs };
