'use strict';
/* tests/helpers/docs-fixture.js —— check-docs 投毒夹具（P7-7 §P0 第⑥条）
 *
 * 背景：`scripts/check-docs.js` 原先硬绑 `REPO`，D1–D6 **零投毒**（tests/integration/check-docs.test.js
 *   只有一条"真实仓库 pass"，失败路径仅靠注释声明"开发期实测过"= 人工证据，不是机器断言）。
 *   本夹具在 `os.tmpdir()` 里搭一个**最小但全绿**的文档↔实现工程，供投毒用例逐项造错 → 必须 FAIL。
 *
 * 夹具覆盖 check-docs 的全部输入面：
 *   package.json(scripts) + README(引用 npm 脚本) + docs/{progress,tasks,acceptance,server,interfaces,
 *   ai-handoff-prompt}.md + scripts/README.md + server/data/README.md + docs/reviews/<批次>.md
 *
 * 约束：零依赖；只用 os.tmpdir() 隔离；不写仓库内任何文件（只读真实仓库用于对照）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PKG = { name: 'docs-fixture', version: '0.0.0', private: true, scripts: { start: 'node server/index.js', test: 'node --test' } };

const README = [
  '# 夹具仓库',
  '',
  '常用命令：`npm test`（全量用例）与 `npm start`（起服务）。',
  '',
].join('\n');

const PROGRESS = ['# 进度', '', '共 1 批', ''].join('\n');

// §6 段内：批量声明（共 N 批）+ 批次行（标记列 [x] / [ ]）+ §7 结束标记
function tasksText(batchCount, rows) {
  return [
    '# 任务',
    '',
    '## 6. 阶段与批次',
    '',
    `共 ${batchCount} 批`,
    '',
    '| 批次 | 状态 | 说明 |',
    '|---|---|---|',
    ...rows,
    '',
    '## 7. 附注',
    '',
    '（夹具结束）',
    '',
  ].join('\n');
}

const DEFAULT_ROWS = ['| B1 `[x]` | 已完成批次 |'];

const PLAIN_DOCS = {
  'docs/acceptance.md': '# 验收\n',
  'docs/server.md': '# 服务端\n',
  'docs/interfaces.md': '# 接口\n',
  'docs/ai-handoff-prompt.md': '# 交接\n',
  'scripts/README.md': '# 脚本\n',
  'server/data/README.md': '# 数据表\n',
  'docs/reviews/B1.md': '# B1 审查记录\n',
};

/**
 * 在临时目录搭最小全绿夹具。
 * @param {(kit: {root:string, write:(rel:string,text:string)=>void, read:(rel:string)=>string,
 *   writeJSON:(rel:string,obj:any)=>void, readJSON:(rel:string)=>any,
 *   patch:(rel:string,fn:(text:string)=>string)=>void}) => void} [mutate]
 * @returns {string} root（调用方负责 rmSync 清理）
 */
function makeDocsProject(mutate) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-docs-'));
  const abs = (rel) => path.join(root, rel);
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
    fs.writeFileSync(abs(rel), text, 'utf8');
  };
  const read = (rel) => fs.readFileSync(abs(rel), 'utf8');
  const writeJSON = (rel, obj) => write(rel, JSON.stringify(obj, null, 2));
  const readJSON = (rel) => JSON.parse(read(rel));
  const patch = (rel, fn) => write(rel, fn(read(rel)));

  writeJSON('package.json', PKG);
  write('README.md', README);
  write('docs/progress.md', PROGRESS);
  write('docs/tasks.md', tasksText(1, DEFAULT_ROWS));
  for (const [rel, text] of Object.entries(PLAIN_DOCS)) write(rel, text);

  if (mutate) mutate({ root, write, read, writeJSON, readJSON, patch });
  return root;
}

/** 跑夹具上的 checkDocs（require 延迟到调用点，避免测试文件顶层耦合） */
function runOn(root) {
  // eslint-disable-next-line global-require
  return require('../../scripts/check-docs.js').checkDocs({ projectRoot: root });
}

module.exports = { makeDocsProject, runOn, tasksText, PKG, README, PROGRESS };
