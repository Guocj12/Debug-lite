'use strict';
/* tests/frontend/auth-field-contract.test.js —— F1 字段来源契约（总纲 §4.2「字段名不得来自散文」）
 *
 * 三重一致（任一不一致即 FAIL）：
 *   ① public/contract.js 声明的路径集合；
 *   ② public/format.js 中 pick(env, '<路径>') 的字面量集合；
 *   ③ docs/frontend/01-auth.md §5 表格里反引号标注的路径集合。
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
const DOC_PATH = path.join(REPO, 'docs', 'frontend', '01-auth.md');

const ENVELOPE_PATHS = new Set(contract.AUTH_FIELD_CONTRACT.map((entry) => entry.path));
const PASSWORD = 'pw12345678';

// 真实响应采集（全部走真实 HTTP；不落任何样本文件，避免样本过期后变成假绿）
async function capture() {
  const s = await startServer({ prefix: 'dl-fe-contract-', level: 'warn' });
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

    return {
      register: reg.body, login: login.body, me: me.body, password: pwd.body, logout: logout.body,
      error: { dup: dup.body, weak: weak.body, noAuth: noAuth.body },
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

test('FC-3 docs/frontend/01-auth.md §5 表格路径集合 == 契约路径集合', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const start = doc.indexOf('## 5.');
  const end = doc.indexOf('## 6.');
  assert.ok(start !== -1 && end > start, '01-auth.md 缺少 §5/§6 章节标记');
  const section = doc.slice(start, end);
  const documented = new Set();
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue; // 只取表格行（散文里提到的"不读取字段"不参与）
    for (const m of line.matchAll(/`(data\.[A-Za-z0-9_.]+|error\.[A-Za-z0-9_.]+|ok)`/g)) documented.add(m[1]);
  }
  assert.ok(documented.size >= 30, `§5 表格解析到的路径过少（${documented.size}）`);
  const missingInDoc = [...ENVELOPE_PATHS].filter((p) => !documented.has(p));
  const extraInDoc = [...documented].filter((p) => !ENVELOPE_PATHS.has(p));
  assert.deepEqual(missingInDoc, [], `契约有但文档 §5 未登记：${missingInDoc.join(', ')}`);
  assert.deepEqual(extraInDoc, [], `文档 §5 登记了但契约没有：${extraInDoc.join(', ')}`);
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
});
