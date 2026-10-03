'use strict';
/* tests/frontend/boot-wiring.test.js —— 入口装配契约（D-179）
 *
 * 背景（用户实测，2026 年交付期复盘）：`public/index.html` 漏载 `/ai-blueprint.js`。
 *   文件在磁盘上、被 format.js/actions.js 的 UMD 工厂当依赖使用，但浏览器从不加载它 →
 *   `window.DL.aiBlueprint === undefined` → 所有触碰积木蓝图的路径（战斗后的 AI 逻辑查看器、
 *   读取回放、AI 编辑器、保存 AI）抛 TypeError → mount 中断 → busy 永不复位 → 全屏按钮变灰。
 *   **当时的 147 个测试文件全绿**：因为它们一律 `require('public/format.js')`，走 CommonJS 分支，
 *   天然绕过了 index.html 的脚本清单。本文件补上这块盲区（BW-1…BW-7）。
 *
 * 机器判定：
 *   BW-1  脚本顺序满足模块依赖（依赖必须在前）
 *   BW-2  所有被依赖的运行时模块 + boot.js 都必须在清单里；清单项文件存在且非空
 *   BW-3  磁盘上的 public/*.js 要么被加载，要么显式登记为「仅测试用」（防新增漏接线）
 *   BW-4  按清单装配后 window.DL 的运行时命名空间齐全（含 aiBlueprint）
 *   BW-5  无数据态每个屏都渲染出真实内容（不落 D-179 兜底屏）
 *   BW-6  管理员态两屏（admin/accounts）同理
 *   BW-7  积木蓝图为草稿时 AI 编辑器屏可渲染（新手 AI 的形态；不需要服务端）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { PUBLIC_DIR, readIndexHtml, scriptSrcs, createBrowser } = require('../helpers/browser.js');

const SRC_LIST = scriptSrcs(readIndexHtml());
const LOADED = SRC_LIST.map((s) => s.replace(/^\/+/, ''));
const FILES = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.js')).sort();

// **仅测试用**的模块（浏览器不需要）：字段来源契约表 —— 只被 tests/ 读取，无任何运行时依赖它。
//   新增"仅测试用"模块必须显式登记在此（登记本身就是一道人工确认）。
const TEST_ONLY = ['contract.js'];

function moduleDecl(file) {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  const dl = src.match(/root\.DL\.(\w+)\s*=/);
  const browserDeps = [];
  const m = src.match(/root\.DL\.\w+\s*=\s*factory\(([^)]*)\)/);
  if (m) for (const d of m[1].matchAll(/root\.DL\.(\w+)/g)) browserDeps.push(d[1]);
  const cjsDeps = [...src.matchAll(/require\('\.\/([\w.-]+\.js)'\)/g)].map((x) => x[1]);
  return { file, dlName: dl ? dl[1] : null, browserDeps, cjsDeps };
}

const MODULES = FILES.map(moduleDecl);
const NAME_TO_FILE = new Map(MODULES.filter((m) => m.dlName).map((m) => [m.dlName, m.file]));

test('BW-1 index.html 的脚本顺序满足模块依赖（依赖必须先加载）', () => {
  const problems = [];
  for (const file of LOADED) {
    const mod = MODULES.find((m) => m.file === file);
    if (!mod) { problems.push(`${file} 不在 public/ 磁盘上`); continue; }
    for (const dep of mod.browserDeps) {
      const depFile = NAME_TO_FILE.get(dep);
      if (!depFile) { problems.push(`${file} 依赖 ${dep}，但没有任何模块声明 root.DL.${dep}`); continue; }
      const at = LOADED.indexOf(depFile);
      if (at === -1) { problems.push(`${file} 依赖 ${depFile}，但 index.html 没加载它`); continue; }
      if (at > LOADED.indexOf(file)) problems.push(`${file} 早于其依赖 ${depFile} 加载`);
    }
  }
  assert.deepEqual(problems, [], 'index.html 脚本清单与模块依赖不符');
});

test('BW-2 被依赖的运行时模块 + boot.js 都在清单里，且文件存在非空', () => {
  const required = new Set(['boot.js']);
  for (const mod of MODULES) {
    for (const dep of mod.browserDeps) {
      const f = NAME_TO_FILE.get(dep);
      if (f) required.add(f);
    }
    for (const dep of mod.cjsDeps) required.add(dep);   // CommonJS 分支的依赖同源，必须一起对齐
  }
  const missing = [...required].filter((f) => !LOADED.includes(f)).sort();
  assert.deepEqual(missing, [], 'index.html 漏载这些运行时模块');
  for (const f of LOADED) {
    const p = path.join(PUBLIC_DIR, f);
    assert.ok(fs.existsSync(p), `${f} 不在磁盘上`);
    assert.ok(fs.statSync(p).size > 0, `${f} 是空文件`);
  }
});

test('BW-3 磁盘上的 public/*.js 要么被加载，要么显式登记为仅测试用', () => {
  const unloaded = FILES.filter((f) => !LOADED.includes(f) && !TEST_ONLY.includes(f));
  assert.deepEqual(unloaded, [], '这些前端模块既没被 index.html 加载、也没登记为仅测试用');
  // 反向：登记为仅测试用的模块确实没被任何人依赖（否则登记是错的）
  for (const f of TEST_ONLY) {
    const used = MODULES.some((m) => m.browserDeps.some((d) => NAME_TO_FILE.get(d) === f) || m.cjsDeps.includes(f));
    assert.equal(used, false, `${f} 被其它模块依赖，不能再算「仅测试用」`);
  }
});

test('BW-4 按 index.html 清单装配后 window.DL 的运行时命名空间齐全', async () => {
  const h = await createBrowser();
  assert.deepEqual(h.errors, [], '脚本装配抛异常');
  assert.equal(h.loaded.length, SRC_LIST.length, '有脚本没加载成功');
  for (const name of ['store', 'aiEditor', 'aiBlueprint', 'layoutEngine', 'layoutData', 'format', 'render', 'actions', 'api', 'app']) {
    assert.ok(h.DL[name], `window.DL.${name} 缺失 —— index.html 很可能漏载了对应脚本`);
  }
  assert.equal(typeof h.DL.aiBlueprint.setCatalog, 'function', 'ai-blueprint 的对外接口应可用');
  // boot.js 的副作用入口：装配后 currentApp 必须在
  assert.ok(h.app, 'boot.js 应自动 createApp 并挂到 window.DL.currentApp');
});

const NON_ADMIN_VIEWS = ['login', 'register', 'password', 'hub', 'profile', 'warehouse', 'settings',
  'quick', 'tournament', 'leaderboard', 'ai-editor'];
const ADMIN_VIEWS = ['admin', 'accounts'];

function assertRendered(h, view) {
  const html = h.html;
  assert.ok(!html.includes(h.DL.format.FATAL_TITLE),
    `${view} 渲染落到了 D-179 兜底屏（说明该屏 viewModel/render 抛异常）：${h.text().slice(0, 240)}`);
  assert.ok(h.actions().size > 0, `${view} 没渲染出任何按钮`);
}

test('BW-5 无数据态：每个屏都渲染出真实内容（不落兜底屏）', async () => {
  const h = await createBrowser();
  assert.ok(await h.ready(), '启动自检未结束');
  h.app.dispatch({ type: 'session.set', token: 'tk', publicId: 'u_probe01', nickname: '探针', expiresAt: null, isAdmin: false });
  for (const view of NON_ADMIN_VIEWS) {
    h.app.dispatch({ type: 'view.go', view });
    assertRendered(h, view);
  }
});

test('BW-6 管理员态：admin/accounts 两屏渲染出真实内容', async () => {
  const h = await createBrowser();
  assert.ok(await h.ready());
  h.app.dispatch({ type: 'session.set', token: 'tk', publicId: 'u_admin01', nickname: '管理员', expiresAt: null, isAdmin: true });
  for (const view of ADMIN_VIEWS) {
    h.app.dispatch({ type: 'view.go', view });
    assertRendered(h, view);
  }
});

test('BW-7 蓝图草稿：AI 编辑器屏渲染出积木树（新手 AI 的形态，无需服务端）', async () => {
  const h = await createBrowser();
  assert.ok(await h.ready());
  // 目录注入（浏览器里由 loadAiLibrary 的 GET /me/ai/nodes 完成）
  const catalog = require('../../server/data/ai-node-catalog.json').nodes;
  h.DL.aiBlueprint.setCatalog(catalog, h.DL.aiBlueprint.limits());
  const preset = require('../../server/data/ai-blueprint-presets.json').presets[0].blueprint;
  h.app.dispatch({ type: 'session.set', token: 'tk', publicId: 'u_probe01', nickname: '探针', expiresAt: null, isAdmin: false });
  h.app.dispatch({ type: 'view.go', view: 'ai-editor' });
  h.app.dispatch({ type: 'ai.editor.open', aiId: 'ai_starter_x', name: '新手AI', program: preset, status: 'ready', dirty: false });
  assertRendered(h, 'ai-editor(blueprint)');
  assert.ok(h.text().includes('新手AI'), '屏上应出现该 AI 的名字');
});
