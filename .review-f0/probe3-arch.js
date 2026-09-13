'use strict';
/* .review-f0/probe3-arch.js —— check-arch 对 public ESM 扫描的对抗（可复跑：node .review-f0/probe3-arch.js）
 * 临时仓库 fixture：import-bare 拒绝 / public→server 禁入 / public→shared 放行 / unresolved /
 * from-字符串字面量误报风险 / 模板字符串与动态 import 漏网实证 / require 扫描不受 public 影响。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze } = require('../scripts/check-arch.js');

let passed = 0;
const fails = [];
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok ${name}`); }
  else { fails.push(`${name}: ${detail}`); console.log(`  FAIL ${name}: ${detail}`); }
}
function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-f0-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return root;
}
const V = (files) => {
  const root = makeProject(files);
  const res = analyze({ projectRoot: root });
  fs.rmSync(root, { recursive: true, force: true });
  return res;
};
const rules = (res) => res.violations.map((v) => v.rule);
const detail = (res) => res.violations.map((v) => `${v.file}[${v.rule}]${v.detail}`);

(async () => {
  console.log('== import-bare / unresolved / public→server ==');
  let res = V({
    'shared/log.js': 'module.exports = {};',
    'server/index.js': 'module.exports = {};',
    'public/js/app.js': "import x from 'lodash';",
  });
  check('裸导入 lodash → import-bare', rules(res).includes('import-bare'), detail(res));
  res = V({
    'server/index.js': 'module.exports = {};',
    'public/js/app.js': "import x from './nope.js';",
  });
  check('相对导入无法解析 → unresolved', rules(res).includes('unresolved'), detail(res));
  res = V({
    'server/index.js': 'module.exports = {};',
    'public/js/app.js': "import x from '../../server/index.js';",
  });
  check('public→server → public-server', rules(res).includes('public-server'), detail(res));
  res = V({
    'shared/log.js': 'module.exports = {};',
    'public/js/util/log.js': 'export const a = 1;',
    'public/js/app.js': "import { a } from './util/log.js'; import { b } from 'shared/log.js';",
  });
  check('public→public 相对 + public→shared 均放行（零违规）', res.violations.length === 0, detail(res));
  res = V({
    'server/core/rng.js': "require('fs');",
    'public/js/app.js': 'export const a = 1;',
  });
  check('core require(fs) 仍报 forbidden（require 扫描不受影响）', rules(res).includes('forbidden'), detail(res));
  res = V({
    'public/js/app.js': "export const a = 1; require('./nope.js');",
  });
  check('public 内相对 require 也进 CJS 扫描 → unresolved（防御性，附带收紧）', rules(res).includes('unresolved'), detail(res));
  res = V({
    'public/js/app.js': "export const a = 1; require('fs');",
  });
  check('public 内裸 require 静默放行（CJS 分支 only 拦 0..5 层；L7 不报）', rules(res).length === 0, detail(res));

  console.log('== 正则盲区（登记用实证） ==');
  res = V({
    'server/core/rng.js': 'module.exports = {};',
    'public/js/app.js': "const s = \"copy from './nope.js'\"; export const a = 1;",
  });
  check('字符串字面量含 from 短语 → 误报 unresolved（正则盲区实证）', rules(res).includes('unresolved'), detail(res));
  res = V({
    'public/js/a.js': 'export const a = 1;',
    'public/js/app.js': "import('./a.js'); const f = (n) => import(`./${n}.js`);",
  });
  check('动态 import() 与模板字符串导入不漏网（登记盲区）', rules(res).length === 0, detail(res));
  check('注释内 import 不参与', (() => {
    const res2 = V({ 'public/js/app.js': "// import x from './nope.js'\nexport const a = 1;" });
    return rules(res2).length === 0;
  })(), detail(res));

  console.log('== 真实仓库构成 ==');
  const real = analyze({ projectRoot: path.join(__dirname, '..') });
  check('真实仓库 22 文件 0 违规', real.files === 22 && real.violations.length === 0, `files=${real.files} v=${real.violations.length}`);
  const { analyze: analyze2 } = require('../scripts/check-arch.js');
  const fs2 = require('node:fs');
  const path2 = require('node:path');
  // 按根目录统计
  const ROOT = path2.join(__dirname, '..');
  const { layerOf } = require('../scripts/check-arch.js');
  const walk = (dir, out) => { if (!fs2.existsSync(dir)) return; for (const e of fs2.readdirSync(dir, { withFileTypes: true })) { const p = path2.join(dir, e.name); if (e.isDirectory()) walk(p, out); else if (e.name.endsWith('.js')) out.push(p); } };
  const all = [];
  for (const r of ['server', 'cli', 'shared', 'public']) walk(path2.join(ROOT, r), all);
  const byRoot = {};
  for (const f of all) { const rel = path2.relative(ROOT, f).split(path2.sep)[0]; byRoot[rel] = (byRoot[rel] || 0) + 1; }
  check('server 文件数', byRoot.server === 18, JSON.stringify(byRoot)); // 9 core + 2 ai + data/schema + index/ranked/runner/box/loadout/battle = 18
  check('cli/shared/public 分布', byRoot.cli === 1 && byRoot.shared === 1 && byRoot.public === 2, JSON.stringify(byRoot)); // cli 仅 index.js（P0-8 起单文件）；18+1+1+2=22
  check('public 两文件层号 = 7', layerOf('public/js/app.js') === 7 && layerOf('public/js/util/log.js') === 7, `${layerOf('public/js/app.js')}/${layerOf('public/js/util/log.js')}`);

  console.log(`\nprobe3: ${passed} ok / ${fails.length} fail`);
  if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1; }
})();