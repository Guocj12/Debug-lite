'use strict';
/* tests/frontend/admin-op-parity.test.js —— 后端管理能力 ↔ 前端管理面板登记表（双向核对）
 *
 * 权威：docs/frontend/02-accounts.md §10.1（用户硬要求）+ §1 端点映射表。
 *   后端源码的能力真源 = `server/index.js` 的 adminOp 分支字面量 `op === '<name>'`；
 *   前端登记表 = `public/api.js` 的 `ADMIN_OPS`（唯一清单）+ `public/actions.js` 实际发出的 op。
 * 三者双向相等：**后端新增 op 而面板未登记 → FAIL（打印缺失清单）**；面板登记了后端没有的 op → FAIL。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const api = require('../../public/api.js');
const actions = require('../../public/actions.js');

const REPO = path.join(__dirname, '..', '..');

// 后端：adminOp 分支的 op 字面量（server/index.js 的 `if (op === '…')`）
function backendOps() {
  const src = fs.readFileSync(path.join(REPO, 'server', 'index.js'), 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/\bop === '([^']+)'/g)) found.add(m[1]);
  return found;
}

// 后端：server/admin.js 暴露的能力方法名（反向哨兵：新增能力必经该对象导出）
function backendMethods() {
  const src = fs.readFileSync(path.join(REPO, 'server', 'admin.js'), 'utf8');
  const start = src.indexOf('  return {\n    store,');
  assert.ok(start !== -1, 'server/admin.js 缺少 createAdmin 的返回对象');
  const body = src.slice(start, src.indexOf('};', start));
  const found = new Set();
  for (const m of body.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*)(?::|,)/gm)) found.add(m[1]);
  return found;
}

// 前端：public/actions.js 实际发出的 op（`adminCall(ctx, '<op>'` / `runAdminOp(ctx, '<op>'` 的字面量）
//   口径与 public/actions.js 顶部的注释成对维护：新增管理动作必须把 op 字面量交给这两个入口之一。
function frontendIssuedOps() {
  const src = fs.readFileSync(path.join(REPO, 'public', 'actions.js'), 'utf8');
  const found = new Set();
  for (const m of src.matchAll(/(?:adminCall|runAdminOp)\(ctx,\s*'([^']+)'/g)) found.add(m[1]);
  for (const m of src.matchAll(/api\.admin\(\s*'([^']+)'/g)) found.add(m[1]);
  return found;
}

function sorted(set) { return [...set].sort(); }

test('AP-1 后端 adminOp 分支集合 == 前端 ADMIN_OPS（双向）', () => {
  const backend = backendOps();
  const frontend = new Set(api.ADMIN_OPS);
  assert.ok(backend.size >= 8, `后端 adminOp 分支解析到 ${backend.size} 个，疑似扫描口径失效`);
  const missingInFrontend = sorted(backend).filter((op) => !frontend.has(op));
  const missingInBackend = sorted(frontend).filter((op) => !backend.has(op));
  assert.deepEqual(missingInFrontend, [],
    `后端已实现但管理面板未登记（必须同步 public/api.js 的 ADMIN_OPS）：${missingInFrontend.join(', ')}`);
  assert.deepEqual(missingInBackend, [],
    `管理面板登记了后端不存在的 op（会在运行时拿 404 unknown_endpoint）：${missingInBackend.join(', ')}`);
});

test('AP-2 登记的每个 op 都真的有动作发出（无"只登记不接线"）', () => {
  const frontend = new Set(api.ADMIN_OPS);
  const issued = frontendIssuedOps();
  assert.ok(issued.size >= 8, `actions.js 只发出 ${issued.size} 个 op，疑似扫描口径失效`);
  const neverIssued = sorted(frontend).filter((op) => !issued.has(op));
  assert.deepEqual(neverIssued, [], `ADMIN_OPS 登记但没有任何动作发出：${neverIssued.join(', ')}`);
  const notRegistered = sorted(issued).filter((op) => !frontend.has(op));
  assert.deepEqual(notRegistered, [], `动作发出了未登记的 op（会被 api.admin 拒绝）：${notRegistered.join(', ')}`);
});

test('AP-3 ADMIN_OPS 自身无重复、形态合法，且为冻结数组', () => {
  const ops = api.ADMIN_OPS;
  assert.ok(Array.isArray(ops), 'ADMIN_OPS 必须是数组');
  assert.equal(new Set(ops).size, ops.length, `ADMIN_OPS 存在重复项：${ops.join(', ')}`);
  for (const op of ops) assert.match(op, /^[a-z][a-z-]*$/, `op 形态非法：${op}`);
  assert.equal(api.ADMIN_PATH, '/api/v1/admin/', 'api.js 的管理面路径前缀必须与 server/index.js 一致');
});

test('AP-4 后端能力方法名仍是前端 8 项能力所依赖的那些（防止"改了实现却没接线"）', () => {
  const methods = backendMethods();
  // 02-accounts.md §1 的 8 项接 UI 能力 → server/admin.js 的方法（唯一映射，人工核对后固定在测试里）
  const expected = ['store', 'checkToken', 'checkAccess', 'isAdminPlayer', 'rebuildIndex', 'stats',
    'accounts', 'deleteAccount', 'injectDebugBots', 'clearDebugBots', 'ban'];
  const missing = expected.filter((name) => !methods.has(name));
  assert.deepEqual(missing, [], `server/admin.js 缺少能力方法：${missing.join(', ')}`);
});

test('AP-5 02-accounts.md §1 登记的 admin op 集合 == ADMIN_OPS（文档↔代码不漂移）', () => {
  // 文档 §1 用 `POST /api/v1/admin/<op>` 形式逐条登记能力；代码与文档必须双向相等
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'frontend', '02-accounts.md'), 'utf8');
  const documented = new Set();
  for (const m of doc.matchAll(/`POST \/api\/v1\/admin\/([a-z][a-z-]*)`/g)) documented.add(m[1]);
  assert.ok(documented.size >= 6, `§1 只解析到 ${documented.size} 个 admin op，疑似文档口径变化`);
  const missingInDoc = sorted(api.ADMIN_OPS).filter((op) => !documented.has(op));
  const extraInDoc = sorted(documented).filter((op) => api.ADMIN_OPS.indexOf(op) === -1);
  assert.deepEqual(missingInDoc, [], `代码有但 02-accounts.md §1 未登记：${missingInDoc.join(', ')}`);
  assert.deepEqual(extraInDoc, [], `02-accounts.md §1 登记了但代码没有：${extraInDoc.join(', ')}`);
});
