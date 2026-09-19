'use strict';
/* tests/integration/check-docs-poison.test.js —— check-docs D1–D6 **投毒**（P7-7 §P0 第⑥条 / §⑤ 盲区 2）
 *
 * 为什么必须存在：
 *   ① `tests/integration/check-docs.test.js` 此前只有一条"真实仓库 pass"，失败路径靠注释声明
 *      "开发期已实测触发"= **人工证据**，不是机器断言（审查 §2.3「自证式门禁断言」）。
 *   ② D5 曾经被真实绕过：旧正则要求批次 ID 后**紧跟** `|`，于是 `| B1 `[ ]` |`（ID 后是标记列内容）
 *      不匹配而被丢弃 → "已完成但未勾选"根本发现不了（修复见 `scripts/check-docs.js:92-95`）。
 *      修复**没有回归用例** = 历史上发生过的空转仍可再发生一次。
 *
 * 手法：`tests/helpers/docs-fixture.js` 在 os.tmpdir() 搭最小全绿工程 →
 *   `checkDocs({ projectRoot })`（本次新增的注入缝）→ 逐项造错 → 断言 `ok===false` 且问题行指向预期 ID。
 *   每条投毒都配"未投毒时同一夹具必须 pass"的隐性对照（CD-P0），证明失败来自造错而非夹具本身。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { makeDocsProject, runOn } = require('../helpers/docs-fixture.js');

// 统一"造错 → 必须 FAIL"的断言助手：跑完即清理临时目录
function poison(mutate, expect) {
  const root = makeDocsProject(mutate);
  try {
    const r = runOn(root);
    assert.equal(r.ok, false, `投毒后必须 FAIL，实际通过：${r.detail}`);
    assert.ok(Array.isArray(r.problems) && r.problems.length > 0, '必须给出 problems 明细');
    const joined = r.problems.join('；');
    if (expect.problem) assert.ok(r.problems.some((p) => p.includes(expect.problem)), `问题行应包含 ${expect.problem}，实际：${joined}`);
    if (expect.re) assert.match(joined, expect.re);
    return r;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('CD-P0 对照：未投毒的最小夹具 → checkDocs 必须 pass（证明失败来自造错）', () => {
  const root = makeDocsProject();
  try {
    const r = runOn(root);
    assert.equal(r.ok, true, `夹具本身应全绿：${r.detail}`);
    assert.ok(r.notes.some((n) => n.includes('npm 脚本')), 'D1 应输出统计行');
    assert.ok(r.notes.some((n) => n.includes('批次勾选')), 'D4/D5 应输出统计行');
    assert.ok(r.notes.some((n) => n.includes('审查记录')), 'D6 应输出统计行');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CD-P1 D1 投毒：package.json 多出一个未在文档登记的脚本 → FAIL', () => {
  poison((k) => {
    const pkg = k.readJSON('package.json');
    pkg.scripts.deploy = 'node scripts/deploy.js';
    k.writeJSON('package.json', pkg);
  }, { problem: 'D1 package.json 脚本未在文档登记', re: /deploy/ });
});

test('CD-P2 D1 投毒：文档引用不存在的 npm 脚本 → FAIL', () => {
  poison((k) => k.patch('README.md', (t) => `${t}\n执行 npm run ghost-script 即可部署。\n`),
    { problem: '引用了不存在的 npm 脚本', re: /ghost-script/ });
});

test('CD-P3 D2 投毒：文档引用不存在的 scripts/*.js → FAIL', () => {
  poison((k) => k.patch('docs/server.md', (t) => `${t}\n实现见 \`scripts/ghost-runner.js\`。\n`),
    { problem: '文档引用了不存在的文件', re: /scripts\/ghost-runner\.js/ });
});

test('CD-P4 D3 投毒：文档引用不存在的数据表 → FAIL', () => {
  poison((k) => k.patch('docs/server.md', (t) => `${t}\n表结构见 \`server/data/ghost-table.json\`。\n`),
    { problem: '文档引用了不存在的文件', re: /server\/data\/ghost-table\.json/ });
});

test('CD-P4b D2/D3 不误报：明确标注"计划"的引用放行（对照，非 FAIL）', () => {
  const root = makeDocsProject((k) => k.patch('docs/server.md', (t) => `${t}\n计划中：\`scripts/ghost-planned.js\`（未实现）。\n`));
  try {
    const r = runOn(root);
    assert.equal(r.ok, true, `标注"计划"的引用不应误报：${r.detail}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CD-P5 D4 投毒：tasks.md 声明 2 批但只有 1 个已勾选批次 → FAIL（计数不一致）', () => {
  poison((k) => k.patch('docs/tasks.md', (t) => t.replace('共 1 批', '共 2 批')),
    { problem: '批次计数不一致', re: /写 2.*勾选 1|批次计数/ });
});

test('CD-P6 D4 投毒：全仓找不到"共 N 批"声明 → FAIL', () => {
  poison((k) => {
    k.patch('docs/tasks.md', (t) => t.replace('共 1 批', '批次数量见附注'));
    k.patch('docs/progress.md', (t) => t.replace('共 1 批', '进度见附注'));
  }, { problem: '未在任何文档中找到' });
});

test('CD-P7 D5 投毒：真实格式的未勾选行 `| B1 `[ ]` |` → FAIL 且点名 B1', () => {
  poison((k) => k.patch('docs/tasks.md', (t) => t.replace('| B1 `[x]` |', '| B1 `[ ]` |')),
    { problem: 'D5 批次行缺 [x] 标记', re: /B1/ });
});

test('CD-P8 D5 历史绕过回归①：标记列在**独立单元格** `| B1 | [ ] |` 也必须被抓 → FAIL', () => {
  // 旧正则 `^\|\s*(B\d+)\s*\|` 只认"ID 后紧跟竖线"的行；标记写在别的单元格/形态稍变即被整行丢弃。
  poison((k) => k.patch('docs/tasks.md', (t) => t.replace('| B1 `[x]` | 已完成批次 |', '| B1 | [ ] | 说明文字 |')),
    { problem: 'D5 批次行缺 [x] 标记', re: /B1/ });
});

test('CD-P8c D5 历史绕过回归②：ID 后未紧跟 `|` 且无标记 `| B1 说明 |` 必须被抓', () => {
  // 这类行在旧实现里不匹配 `ID + |` 而被整行丢弃 → "已完成未勾选"看不见（历史逃逸形态）。
  poison((k) => k.patch('docs/tasks.md', (t) => t.replace('| B1 `[x]` | 已完成批次 |', '| B1 说明文字 | 补充 |')),
    { problem: 'D5 批次行缺 [x] 标记', re: /B1/ });
});

test('CD-P8b D5 历史绕过回归③：括号型标记 `| B1 (未完成) |` 也必须被抓', () => {
  poison((k) => k.patch('docs/tasks.md', (t) => t.replace('| B1 `[x]` | 已完成批次 |', '| B1 (未完成) | 说明文字 |')),
    { problem: 'D5 批次行缺 [x] 标记', re: /B1/ });
});

test('CD-P9 D5 不误报：P7 计划批次（B27–B33）未勾选不报错（对照，非 FAIL）', () => {
  const root = makeDocsProject((k) => k.write('docs/tasks.md', [
    '# 任务', '', '## 6. 阶段与批次', '', '共 1 批', '',
    '| 批次 | 状态 | 说明 |', '|---|---|---|',
    '| B1 `[x]` | 已完成批次 |',
    '| B28 `[ ]` | P7 计划批次（未实现，允许未勾选） |',
    '', '## 7. 附注', '',
  ].join('\n')));
  try {
    const r = runOn(root);
    assert.equal(r.ok, true, `计划批次未勾选不应报错：${r.detail}`);
    assert.ok(r.notes.some((n) => n.includes('计划中 1 个')), `应统计到 1 个计划批次：${r.notes.join(' | ')}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CD-P10 D5 投毒：非计划批次的第二个批次未勾选 → FAIL 且点名 B2', () => {
  poison((k) => k.write('docs/tasks.md', [
    '# 任务', '', '## 6. 阶段与批次', '', '共 1 批', '',
    '| 批次 | 状态 | 说明 |', '|---|---|---|',
    '| B1 `[x]` | 已完成批次 |',
    '| B2 `[ ]` | 未勾选的新批次 |',
    '', '## 7. 附注', '',
  ].join('\n')), { problem: 'D5 批次行缺 [x] 标记', re: /B2/ });
});

test('CD-P11 D6 投毒：已勾选批次缺 docs/reviews/<批次>.md → FAIL', () => {
  poison((k) => fs.rmSync(k.root + '/docs/reviews/B1.md'),
    { problem: 'D6 已勾选批次缺审查记录', re: /B1/ });
});

test('CD-P12 注入缝本身：无参调用仍走真实仓库且通过（向后兼容）', () => {
  // eslint-disable-next-line global-require
  const { checkDocs } = require('../../scripts/check-docs.js');
  const r = checkDocs();
  assert.equal(r.ok, true, `真实仓库应通过（注入缝不得破坏无参语义）：${r.detail}`);
  const explicit = checkDocs({ projectRoot: path.join(__dirname, '..', '..') });
  assert.equal(explicit.ok, true, '显式传入真实仓库根目录应与无参等价');
  // 不存在的根目录 → 必须 FAIL（而不是静默通过）
  const ghost = checkDocs({ projectRoot: path.join(os.tmpdir(), 'dl-no-such-dir-9527') });
  assert.equal(ghost.ok, false, '不存在的 projectRoot 不得静默通过');
  assert.ok(ghost.problems.some((p) => p.includes('不存在')), ghost.problems.join('；'));
});
