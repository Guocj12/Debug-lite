'use strict';
// T-DC-4 架构依赖检查的契约测试 —— 契约见 scripts/README.md「check-arch.js 契约」
// 用临时目录构造违规/合规 fixture，验证 analyze() 真抓违规（不靠打印通过）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('../../scripts/check-arch.js');

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-arch-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return root;
}

function violations(projectRoot, files) {
  const root = makeProject(files);
  const res = analyze({ projectRoot: root });
  fs.rmSync(root, { recursive: true, force: true });
  return res;
}

test('ARCH-1 反向依赖：L0 不得依赖 L2（rng → bullets）', () => {
  const res = violations({}, {
    'server/core/rng.js': "module.exports = {}; require('./bullets.js');",
    'server/core/bullets.js': 'module.exports = {};',
  });
  assert.ok(res.violations.some((v) => v.rule === 'layer' && v.file.includes('rng.js')),
    `应为 layer 违规，实际: ${JSON.stringify(res.violations)}`);
});

test('ARCH-2 engine 不得 require ai（L5 由 server 层注入）', () => {
  const res = violations({}, {
    'server/core/engine.js': "module.exports = {}; require('../ai/runtime.js');",
    'server/ai/runtime.js': 'module.exports = {};',
  });
  assert.ok(res.violations.some((v) => v.rule === 'layer' && v.file.includes('engine.js')));
});

test('ARCH-3 ai 不得 require engine（L5 只依赖 L0/L1）', () => {
  const res = violations({}, {
    'server/core/engine.js': 'module.exports = {};',
    'server/ai/runtime.js': "module.exports = {}; require('../core/engine.js');",
  });
  assert.ok(res.violations.some((v) => v.rule === 'layer' && v.file.includes('runtime.js')));
});

test('ARCH-4 core 禁 require fs/express 等（内置/三方 IO）', () => {
  const res = violations({}, {
    'server/core/field.js': "module.exports = {}; require('fs'); require('express');",
  });
  const rules = res.violations.map((v) => v.rule);
  assert.ok(rules.includes('forbidden'), `应含 forbidden，实际 ${rules}`);
  assert.equal(res.violations.filter((v) => v.rule === 'forbidden' && v.file.includes('field.js')).length, 2, 'fs 与 express 各报一条');
});

test('ARCH-5 cli 不得 require core/ai（L14 只走 HTTP）', () => {
  const res = violations({}, {
    'server/core/engine.js': 'module.exports = {};',
    'cli/index.js': "module.exports = {}; require('../server/core/engine.js');",
  });
  assert.ok(res.violations.some((v) => v.rule === 'cli-core' && v.file.includes('cli')));
});

test('ARCH-6 循环依赖：effects→unlock→effects 报出完整环', () => {
  const res = violations({}, {
    'server/core/effects.js': "module.exports = {}; require('./unlock.js');",
    'server/core/unlock.js': "module.exports = {}; require('./effects.js');",
  });
  const cyc = res.violations.filter((v) => v.rule === 'cycle');
  assert.equal(cyc.length, 1, `每个环报一条后向边（含完整路径）: ${JSON.stringify(res.violations)}`);
  assert.ok(cyc[0].detail.includes('effects') && cyc[0].detail.includes('unlock'), `detail 应含完整环路径: ${cyc[0].detail}`);
});

test('ARCH-7 合法依赖不误报：engine→低层+shared+data；server→express/core/ai；cli→http/shared', () => {
  const res = violations({}, {
    'shared/log.js': 'module.exports = {};',
    'server/data/battle-config.json': '{"cellPx": 64}',
    'server/core/rng.js': 'module.exports = {};',
    'server/core/bullets.js': 'module.exports = {};',
    'server/core/engine.js':
      "module.exports = {}; require('./rng.js'); require('./bullets.js'); require('../../shared/log.js'); require('../data/battle-config.json');",
    'server/index.js':
      "module.exports = {}; require('express'); require('./core/engine.js'); require('./ai/ast.js'); require('../shared/log.js');",
    'server/ai/ast.js': "module.exports = {}; require('../core/unlock.js'); require('../../shared/log.js');",
    'server/core/unlock.js': 'module.exports = {};',
    'cli/index.js': "module.exports = {}; require('http'); require('../shared/log.js');",
  });
  assert.deepEqual(res.violations, [], `不应有违规: ${JSON.stringify(res.violations)}`);
});

test('ARCH-8 同层依赖与跨层放行：L2→L2、L2→L1、L1→L0 均合法', () => {
  const res = violations({}, {
    'server/core/rng.js': 'module.exports = {};',
    'server/core/items.js': "module.exports = {}; require('./rng.js');",
    'server/core/roles.js': "module.exports = {}; require('./items.js'); require('./bullets.js');",
    'server/core/bullets.js': 'module.exports = {};',
  });
  assert.deepEqual(res.violations, [], `roles(L2)→items(L1)/bullets(L2)、items(L1)→rng(L0) 均合法: ${JSON.stringify(res.violations)}`);
});

test('ARCH-9 未解析的相对 require（拼写错误）报 unresolved', () => {
  const res = violations({}, {
    'server/core/rng.js': "module.exports = {}; require('./rnng.js');",
  });
  assert.ok(res.violations.some((v) => v.rule === 'unresolved' && v.file.includes('rng.js')));
});

test('ARCH-10 注释中的 require 不参与（剥注释）', () => {
  const res = violations({}, {
    'server/core/rng.js': "module.exports = {}; // require('fs') 仅注释\nconst x = 1;",
  });
  assert.deepEqual(res.violations, [], '注释内的 require 不应被解析');
});

test('ARCH-11 外部模块（builtin/node_modules）不参加层比较与成环', () => {
  const res = violations({}, {
    'server/core/field.js': "module.exports = {}; require('node:path'); require('some-npm-pkg');",
  });
  // node:path 是 builtin（core 禁止清单含 path——但 node:path 前缀需按短名 path 判定）
  const rules = res.violations.map((v) => v.rule);
  assert.ok(rules.includes('forbidden'), `node:path 应被判为 forbidden: ${rules}`);
});

test('ARCH-12 唯一跨层共享仅限 shared/log.js：shared 下其他文件 → unknown-layer', () => {
  const res = violations({}, {
    'shared/other.js': 'module.exports = {};',
    'server/core/rng.js': "module.exports = {}; require('../../shared/other.js');",
  });
  assert.ok(res.violations.some((v) => v.rule === 'unknown-layer' && v.file.includes('other.js')),
    `shared/other.js 必须在分层表外: ${JSON.stringify(res.violations)}`);
});