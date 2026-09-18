'use strict';
// 文档 ↔ 实现一致性检查（scripts/check-docs.js）的接线测试。
// 作用：把"文档写了但代码没有 / 批次计数三值不一 / 进度状态过期"这类漂移接入 gate 项 7（全量测试）。
// 说明：本用例断言**真实仓库**通过（D1–D6 全绿）；检查器本身的失败路径在开发期已实测触发
//   （例如 package.json 缺 `check:docs` 时 D1 FAIL、P7 批次未勾选时 D5 FAIL），故非空转。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkDocs } = require('../../scripts/check-docs.js');

test('D1–D6 文档↔实现一致性：真实仓库全绿（npm 脚本/文件引用/批次计数/勾选/审查记录）', () => {
  const r = checkDocs();
  assert.equal(r.ok, true, r.detail);
  assert.ok(Array.isArray(r.notes) && r.notes.length >= 4, '检查器应输出可读的统计行');
  assert.ok(r.notes.some((n) => n.includes('npm 脚本')), 'D1 覆盖 npm 脚本一致性');
  assert.ok(r.notes.some((n) => n.includes('批次勾选')), 'D4/D5 覆盖批次计数与勾选');
  assert.ok(r.notes.some((n) => n.includes('审查记录')), 'D6 覆盖审查记录覆盖度');
});
