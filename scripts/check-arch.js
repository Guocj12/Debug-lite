'use strict';
/* scripts/check-arch.js —— 架构依赖方向检查（P0-5，T-DC-4）
 * 契约：scripts/README.md「check-arch.js 契约」；分层映射见 tasks.md §2.1。
 * 单进程、无 IO 之外的额外要求；main 对仓库实跑，任一违例退出码 1。
 */
const fs = require('node:fs');
const path = require('node:path');

// 相对路径 → 层号（未命中 → null = 未知层，报违规强制登记）
const LAYER_RULES = [
  [/^shared\/log\.js$/, -1], // 唯一跨层共享单文件（§4.10；其它 shared/* 一律 unknown-layer）
  [/^server\/data\//, -1], // 数据层：任何 server 模块可读
  [/^server\/core\/rng\.js$/, 0],
  [/^server\/core\/field\.js$/, 0],
  [/^server\/core\/effects\.js$/, 1],
  [/^server\/core\/items\.js$/, 1],
  [/^server\/core\/unlock\.js$/, 1],
  [/^server\/core\/roles\.js$/, 2],
  [/^server\/core\/skills\.js$/, 2],
  [/^server\/core\/bullets\.js$/, 2],
  [/^server\/core\/engine\.js$/, 4],
  [/^server\/ai\//, 5],
  [/^server\/(index|ranked|runner|box|loadout|battle)\.js$/, 6],
  [/^cli\//, 6],
];

// L5 允许的目标层（只依赖 L0/L1 + 数据/shared，不依赖 engine）
const AI_ALLOWED_LAYERS = new Set([0, 1, -1]);

const CORE_FORBIDDEN = new Set(['fs', 'http', 'https', 'express', 'net', 'child_process', 'os', 'path']);

const SCAN_ROOTS = ['server', 'cli', 'shared'];

// 注释剥离（引用感知，避免 https:// 等串内 // 误判；保长保换行以保留行号）
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

function walkJs(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// 解析相对 require：target / target.js / target.json
function resolveRel(baseDir, target) {
  const candidates = [target, `${target}.js`, `${target}.json`];
  for (const c of candidates) {
    const p = path.resolve(baseDir, c);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

function layerOf(rel) {
  for (const [re, lv] of LAYER_RULES) {
    if (re.test(rel)) return lv;
  }
  return null;
}

// 依赖图：relPath -> Set<relPath>
function analyze(options) {
  const projectRoot = (options && options.projectRoot) || path.join(__dirname, '..');
  const violations = [];
  const allFiles = [];
  for (const root of SCAN_ROOTS) {
    walkJs(path.join(projectRoot, root), allFiles);
  }
  allFiles.sort();

  const relOf = (abs) => toPosix(path.relative(projectRoot, abs));
  const scanSet = new Set(allFiles.map((f) => path.resolve(f)));
  const graph = new Map(); // rel -> [rel...]
  const layers = new Map(); // rel -> layer

  for (const file of allFiles) {
    const rel = relOf(file);
    const lv = layerOf(rel);
    if (lv === null) {
      violations.push({ file: rel, rule: 'unknown-layer', detail: '文件不在分层表中（scripts/README.md 需登记）' });
      continue;
    }
    layers.set(rel, lv);
    graph.set(rel, []);
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    const reqRe = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = reqRe.exec(src)) !== null) {
      const target = m[1];
      const idx = m.index;
      if (target.startsWith('.')) {
        const resolved = resolveRel(path.dirname(file), target);
        if (!resolved) {
          violations.push({ file: rel, rule: 'unresolved', detail: `require('${target}') 无法解析（目标不存在，或未登记扩展名）` });
          continue;
        }
        const relTarget = relOf(resolved);
        if (scanSet.has(path.resolve(resolved))) graph.get(rel).push(relTarget);
        continue;
      }
      // 外部模块
      const bare = target.startsWith('node:') ? target.slice(5) : target;
      if (lv >= 0 && lv <= 5) {
        violations.push({
          file: rel, rule: 'forbidden',
          detail: `core/ai(层${lv}) 禁止 require 外部模块 '${target}'` +
            (CORE_FORBIDDEN.has(bare) ? '（IO/三方黑名单）' : '（只允许相对路径/shared/log.js/data）'),
        });
        continue;
      }
      // L6（server/index、cli）：外部模块放行（express/http 等）
    }
  }

  // 层方向
  for (const [rel, deps] of graph) {
    const ls = layers.get(rel);
    for (const dep of deps) {
      const lt = layers.get(dep);
      if (lt === null) continue; // 目标层未知已在前面报
      if (ls === 5 && !AI_ALLOWED_LAYERS.has(lt)) {
        violations.push({ file: rel, rule: 'layer', detail: `L5 ai 只允许依赖 L0/L1/数据/shared（→ ${dep} 层 ${lt}）` });
        continue;
      }
      if (lt > ls) {
        violations.push({ file: rel, rule: 'layer', detail: `依赖了更高层 ${dep}（层 ${ls} → ${lt}）` });
        continue;
      }
      if (rel.startsWith('cli/') && (dep.startsWith('server/core') || dep.startsWith('server/ai'))) {
        violations.push({ file: rel, rule: 'cli-core', detail: `CLI 禁止 require core/ai（只走 HTTP，L14）→ ${dep}` });
      }
    }
  }

  // 循环依赖（DFS 找后向边）
  const color = new Map(); // 0 未访问 1 栈中 2 完成
  function dfs(rel, stack) {
    color.set(rel, 1);
    stack.push(rel);
    for (const dep of graph.get(rel) || []) {
      const c = color.get(dep);
      if (c === 1) {
        violations.push({ file: rel, rule: 'cycle', detail: `循环依赖：${[...stack, dep].join(' → ')}` });
      } else if (c === undefined) {
        dfs(dep, stack);
      }
    }
    stack.pop();
    color.set(rel, 2);
  }
  for (const rel of graph.keys()) {
    if (!color.has(rel)) dfs(rel, []);
  }

  return { violations, files: allFiles.length };
}

function main() {
  const res = analyze({ projectRoot: path.join(__dirname, '..') });
  if (res.violations.length === 0) {
    console.log(`[PASS] check-arch: ${res.files} 个文件无依赖违规`);
    process.exitCode = 0;
    return 0;
  }
  for (const v of res.violations) {
    console.log(`[FAIL] ${v.file} [${v.rule}] ${v.detail}`);
  }
  process.exitCode = 1;
  return 1;
}

module.exports = { analyze, layerOf, stripComments, main };

if (require.main === module) {
  main();
}