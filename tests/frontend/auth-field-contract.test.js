'use strict';
/* tests/frontend/auth-field-contract.test.js —— 字段来源契约（总纲 §4.2「字段名不得来自散文」）
 *
 * 三重一致（任一不一致即 FAIL）：
 *   ① public/contract.js 声明的路径集合；
 *   ② public/format.js 中 pick(env, '<路径>') 的字面量集合；
 *   ③ docs/frontend/01-auth.md §5 与 docs/frontend/02-accounts.md §5 表格里反引号路径的**并集**（F2 扩展）。
 * 另：逐条路径必须在**真实 HTTP 响应**中可解析（真起服务抓取，不依赖任何入库样本）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, request } = require('../helpers/http.js');
const contract = require('../../public/contract.js');
const format = require('../../public/format.js');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO, 'public');
// F1 分册 + F2 分册（§5 字段来源契约增量）
const DOC_PATHS = [
  path.join(REPO, 'docs', 'frontend', '01-auth.md'),
  path.join(REPO, 'docs', 'frontend', '02-accounts.md'),
];

const ENVELOPE_PATHS = new Set(contract.AUTH_FIELD_CONTRACT.map((entry) => entry.path));
const PASSWORD = 'pw12345678';

// F2：管理员账号白名单 + 管理员令牌 + 调试 bot 开关（覆盖 §5 增量的全部宿主响应）
const ADMIN_NAME = 'fec2admin';
const ADMIN_TOKEN = 'fec2-admin-token';
// 造 10 个以上账号会越过 auth 的「同 IP 每分钟 10 次尝试」限速（既有行为，非本批引入）→ 测试内放宽
const RELAXED_AUTH = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };

// 真实响应采集（全部走真实 HTTP；不落任何样本文件，避免样本过期后变成假绿）
async function capture() {
  const s = await startServer({
    prefix: 'dl-fe-contract-', level: 'warn', authConfig: RELAXED_AUTH,
    server: { env: { DL_ADMIN_TOKEN: ADMIN_TOKEN, DL_ADMIN_USERS: ADMIN_NAME, DL_DEBUG_BOTS: '1' } },
  });
  try {
    const port = s.port;
    const post = (url, body, token) => request(port, 'POST', url, body,
      token ? { authorization: `Bearer ${token}` } : undefined);
    const get = (url, token) => request(port, 'GET', url, undefined,
      token ? { authorization: `Bearer ${token}` } : undefined);

    const reg = await post('/api/v1/auth/register', { username: 'fec1user', password: PASSWORD, nickname: '契约' });
    assert.equal(reg.status, 200, `注册应 200，实际 ${reg.status} ${reg.raw}`);
    const token = reg.body.data.token;

    const login = await post('/api/v1/auth/login', { username: 'fec1user', password: PASSWORD });
    assert.equal(login.status, 200);

    const me = await get('/api/v1/me', token);
    assert.equal(me.status, 200);

    const pwd = await post('/api/v1/auth/password', { oldPassword: PASSWORD, newPassword: 'pw87654321' }, token);
    assert.equal(pwd.status, 200);

    const logout = await post('/api/v1/auth/logout', {}, token);
    assert.equal(logout.status, 200);

    // 错误信封样本（error.code / error.message / error.details 的宿主）
    const dup = await post('/api/v1/auth/register', { username: 'FEC1USER', password: PASSWORD });
    assert.equal(dup.status, 409, '重名注册应 409');
    const weak = await post('/api/v1/auth/register', { username: 'fec1weak', password: 'short' });
    assert.equal(weak.status, 400, '弱密码应 400');
    const noAuth = await get('/api/v1/me');
    assert.equal(noAuth.status, 401, '无 token 应 401');

    /* ----- F2：管理面（docs/frontend/02-accounts.md §2/§5） ----- */
    const adminReg = await post('/api/v1/auth/register', { username: ADMIN_NAME, password: PASSWORD, nickname: '管理员' });
    assert.equal(adminReg.status, 200, `管理员注册应 200：${adminReg.raw}`);
    assert.equal(adminReg.body.data.player.isAdmin, true, 'DL_ADMIN_USERS 白名单账号应回带 data.player.isAdmin=true');
    const adminAuth = { authorization: `Bearer ${adminReg.body.data.token}` };
    const adminPost = (op, body) => request(port, 'POST', `/api/v1/admin/${op}`, body, adminAuth);

    const victim = await post('/api/v1/auth/register', { username: 'fec2victim', password: PASSWORD });
    const bannedUser = await post('/api/v1/auth/register', { username: 'fec2banned', password: PASSWORD });
    assert.equal(victim.status, 200);
    assert.equal(bannedUser.status, 200);

    const accounts = await adminPost('accounts', { offset: 0, limit: 5 });
    assert.equal(accounts.status, 200, accounts.raw);
    const allRows = await adminPost('accounts', { offset: 0, limit: 200 });
    const banRow = allRows.body.data.rows.find((r) => r.publicId === bannedUser.body.data.publicId);
    assert.ok(banRow, '账号列表应含待封禁账号（playerId 只在 admin 通道回带）');

    const stats = await adminPost('stats', {});
    assert.equal(stats.status, 200, stats.raw);
    const rebuild = await adminPost('rebuild-index', {});
    assert.equal(rebuild.status, 200, rebuild.raw);
    const bots = await adminPost('bots', { count: 1 });
    assert.equal(bots.status, 200, `DL_DEBUG_BOTS=1 时注入调试 bot 应 200：${bots.raw}`);
    const clearBots = await adminPost('clear-bots', {});
    assert.equal(clearBots.status, 200, clearBots.raw);
    const ban = await adminPost('ban', { playerId: banRow.playerId, banned: true });
    assert.equal(ban.status, 200, ban.raw);
    const del = await adminPost('delete-account', { publicId: victim.body.data.publicId });
    assert.equal(del.status, 200, del.raw);

    return {
      register: reg.body, login: login.body, me: me.body, password: pwd.body, logout: logout.body,
      error: { dup: dup.body, weak: weak.body, noAuth: noAuth.body },
      adminAccounts: accounts.body, adminDelete: del.body, adminStats: stats.body,
      adminRebuild: rebuild.body, adminBots: bots.body, adminClearBots: clearBots.body, adminBan: ban.body,
    };
  } finally {
    await s.cleanup();
  }
}

// 按契约条目声明的端点分组，逐条断言「该路径在真实响应里确实存在」（用 in 判定，区分"键缺失"与"值为 undefined"）
function resolves(envelope, dottedPath) {
  let cur = envelope;
  for (const seg of String(dottedPath).split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return false;
    if (!(seg in cur)) return false;
    cur = cur[seg];
  }
  return true;
}

test('FC-1 每条契约路径都能在真实 HTTP 响应中解析到', async () => {
  const real = await capture();
  // 端点分组：'any' 组的路径分散在成功信封（ok）与错误信封（error.*）中，故用"至少一个"语义；
  // 其余分组要求在该端点的**每一个**真实响应里都存在。
  const groups = {
    'register|login': { envelopes: [real.register, real.login], anyOf: false },
    me: { envelopes: [real.me], anyOf: false },
    password: { envelopes: [real.password], anyOf: false },
    logout: { envelopes: [real.logout], anyOf: false },
    // F2：管理面各组（02-accounts.md §5）
    'admin/accounts': { envelopes: [real.adminAccounts], anyOf: false },
    'admin/delete-account': { envelopes: [real.adminDelete], anyOf: false },
    'admin/stats': { envelopes: [real.adminStats], anyOf: false },
    'admin/rebuild-index': { envelopes: [real.adminRebuild], anyOf: false },
    'admin/bots': { envelopes: [real.adminBots], anyOf: false },
    'admin/clear-bots': { envelopes: [real.adminClearBots], anyOf: false },
    'admin/ban': { envelopes: [real.adminBan], anyOf: false },
    any: { envelopes: [real.register, real.password, real.logout, real.error.dup, real.error.weak, real.error.noAuth], anyOf: true },
  };
  for (const entry of contract.AUTH_FIELD_CONTRACT) {
    const group = groups[entry.endpoint];
    assert.ok(group, `契约条目 endpoint=${entry.endpoint} 不是已知分组`);
    const hits = group.envelopes.filter((env) => resolves(env, entry.path));
    if (group.anyOf) {
      assert.ok(hits.length > 0, `字段 ${entry.path}（endpoint=${entry.endpoint}）在任何真实响应中都不存在`);
    } else {
      assert.equal(hits.length, group.envelopes.length,
        `字段 ${entry.path}（endpoint=${entry.endpoint}）在 ${group.envelopes.length - hits.length} 个真实响应中缺失`);
    }
  }
});

test('FC-2 public/format.js 的 pick() 字面量集合 == 契约路径集合（双向）', () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'format.js'), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/pick\(\s*env\s*,\s*'([^']+)'\s*\)/g)) used.add(m[1]);
  assert.ok(used.size >= 30, `format.js 的 pick 字面量过少（${used.size}），疑似扫描口径失效`);
  const missingInCode = [...ENVELOPE_PATHS].filter((p) => !used.has(p));
  const notInContract = [...used].filter((p) => !ENVELOPE_PATHS.has(p));
  assert.deepEqual(missingInCode, [], `契约声明了但 format.js 未读取：${missingInCode.join(', ')}`);
  assert.deepEqual(notInContract, [], `format.js 读取了但契约未登记：${notInContract.join(', ')}`);
});

test('FC-3 两份分册 §5 表格路径集合（并集）== 契约路径集合', () => {
  const documented = new Set();
  for (const docPath of DOC_PATHS) {
    const doc = fs.readFileSync(docPath, 'utf8');
    const start = doc.indexOf('## 5.');
    const end = doc.indexOf('## 6.');
    assert.ok(start !== -1 && end > start, `${path.basename(docPath)} 缺少 §5/§6 章节标记`);
    const section = doc.slice(start, end);
    for (const line of section.split('\n')) {
      if (!line.startsWith('|')) continue; // 只取表格行（散文里提到的"不读取字段"不参与）
      for (const m of line.matchAll(/`(data\.[A-Za-z0-9_.]+|error\.[A-Za-z0-9_.]+|ok)`/g)) documented.add(m[1]);
    }
  }
  assert.ok(documented.size >= 30, `§5 表格解析到的路径过少（${documented.size}）`);
  const missingInDoc = [...ENVELOPE_PATHS].filter((p) => !documented.has(p));
  const extraInDoc = [...documented].filter((p) => !ENVELOPE_PATHS.has(p));
  assert.deepEqual(missingInDoc, [], `契约有但分册 §5 未登记：${missingInDoc.join(', ')}`);
  assert.deepEqual(extraInDoc, [], `分册 §5 登记了但契约没有：${extraInDoc.join(', ')}`);
});

test('FC-4 「不读取」字段与契约无交集（防止散文式字段混入）', () => {
  const overlap = contract.UNUSED_FIELDS.filter((p) => ENVELOPE_PATHS.has(p));
  assert.deepEqual(overlap, [], `UNUSED_FIELDS 与契约重复：${overlap.join(', ')}`);
});

test('FC-5 投影函数只用契约字段就能产出全部主页文本（无 undefined 泄漏）', async () => {
  const real = await capture();
  const lines = format.profileLines(real.me);
  assert.ok(lines.length >= 10, `主页文本行过少：${lines.length}`);
  for (const line of lines) {
    assert.ok(typeof line === 'string' && line.length > 0, '主页文本行必须是非空字符串');
    assert.ok(!line.includes('undefined') && !line.includes('null'),
      `主页文本出现未投影值：${line}`);
  }
  const authLines = format.authLines(real.login);
  for (const line of authLines) {
    assert.ok(!line.includes('undefined') && !line.includes('null'), `首屏文本出现未投影值：${line}`);
  }
  assert.equal(format.isOk(real.me), true);
  assert.equal(format.isOk(real.error.dup), false);
  assert.equal(format.isSessionError(real.error.noAuth), true);
  assert.equal(format.errorCodeOf(real.error.dup), 'username_taken');
  // F2：管理面投影（列表行 / 分页行 / 统计行）不得泄漏未投影值
  assert.equal(format.isAdminOf(real.adminAccounts), false, 'admin 信封里没有身份字段 → 不判定为管理员');
  const info = format.accountsInfoText(real.adminAccounts);
  assert.match(info, /^共 \d+ 个账号，第 \d+\/\d+ 页（每页 \d+）$/, `分页信息行：${info}`);
  for (const row of format.accountRows(real.adminAccounts)) {
    assert.ok(row.playerId && row.publicId, '账号行必须含 playerId / publicId');
    assert.ok(!row.text.includes('undefined'), `账号行出现未投影值：${row.text}`);
  }
  assert.match(format.statsText(real.adminStats), /^players=\d+ seq=\d+ snapshots=.+$/);
  assert.match(format.rebuildText(real.adminRebuild), /^重建完成：\d+ 玩家$/);
  assert.match(format.botsText(real.adminBots), /^已注入 \d+ 个（跳过 \d+ 个）$/);
  assert.match(format.clearBotsText(real.adminClearBots), /^已清除 \d+ 个$/);
  assert.match(format.banText(real.adminBan, 'u_x'), /^已封禁 u_x$/);
  assert.match(format.deleteAccountText(real.adminDelete, null), /^已删除 u_/);
});
