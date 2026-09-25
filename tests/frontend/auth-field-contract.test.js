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
const { startServer, request, playerIdByPublicId } = require('../helpers/http.js');
const contract = require('../../public/contract.js');
const format = require('../../public/format.js');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO, 'public');
// F1 分册 + F2 分册 + F3 分册（§5 字段来源契约增量；FC-3 的并集口径见下）
const DOC_PATHS = [
  path.join(REPO, 'docs', 'frontend', '01-auth.md'),
  path.join(REPO, 'docs', 'frontend', '02-accounts.md'),
  path.join(REPO, 'docs', 'frontend', '03-hub-warehouse-loadout.md'),
];

const ENVELOPE_PATHS = new Set(contract.AUTH_FIELD_CONTRACT.map((entry) => entry.path));
const PASSWORD = 'pw12345678';

// F2：管理员账号白名单 + 管理员令牌 + 调试 bot 开关（覆盖 §5 增量的全部宿主响应）
const ADMIN_NAME = 'fec2admin';
const ADMIN_TOKEN = 'fec2-admin-token';
// 造 10 个以上账号会越过 auth 的「同 IP 每分钟 10 次尝试」限速（既有行为，非本批引入）→ 测试内放宽
const RELAXED_AUTH = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };

// 真实响应采集（全部走真实 HTTP；不落任何样本文件，避免样本过期后变成假绿）
//
// 提交③ 追加两个宿主响应：
//   · `GET /me/configs`（编辑器读 `data.slots` / `data.activeSlotId`）；
//   · `POST /me/warehouse/assemble`（两步顺序第①步的回带：`data.warehouse` / `data.usage` / `data.caps`）——
//     装配需要一个"类型匹配且空闲的插槽 + 同类型插件"的**确定性夹具**（starter 的插件已装在原插槽上，
//     不能保证还有空位），故按 tests/api/api-me-warehouse.test.js UWH-3/4 的同一手法注入。
const FIX_ROLE = 'fec3_fix_role';
const FIX_PLUGIN_MATCH = 'fec3_fix_plugin_atk';
async function injectAssemblable(store, playerId) {
  await store.updateArchive(playerId, (a) => {
    a.warehouse.buckets.role.push({
      uid: FIX_ROLE, kind: 'role', templateId: 'role_bal', name: '契约夹具角色', quality: 'common',
      slotCount: 1, slots: [{ type: 'atk', pluginUid: null }],
      stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
      unlockTier: 'common', pluginPoints: 3,
    });
    a.warehouse.buckets.rolePlugin.push({
      uid: FIX_PLUGIN_MATCH, kind: 'rolePlugin', id: 'rp_atk_flat', name: '攻击 +4', slot: 'atk',
      category: '攻击提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1,
    });
    return null;
  });
}

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

    // F3（03 §5.1/§5.2）：本批新接 UI 的端点 —— 注册即发 starter，故仓库/开箱立即有内容。
    //   注意顺序：这些请求必须排在 logout 之前（logout 会撤销本会话）
    const wh = await get('/api/v1/me/warehouse', token);
    assert.equal(wh.status, 200, `仓库真源应 200（D-159 起不再 404 warehouse_missing）：${wh.raw.slice(0, 200)}`);
    const configs = await get('/api/v1/me/configs', token);
    assert.equal(configs.status, 200, configs.raw);
    // 提交③：装配（两步顺序第①步）—— 注入确定性夹具后再装配，响应即 `{warehouse,usage,counts,caps}`
    const playerId = await playerIdByPublicId(s.store, reg.body.data.publicId);
    assert.ok(playerId, '应能用 publicId 反查到 playerId');
    await injectAssemblable(s.store, playerId);
    const asm = await post('/api/v1/me/warehouse/assemble',
      { targetUid: FIX_ROLE, pluginUid: FIX_PLUGIN_MATCH, slotIndex: 0 }, token);
    assert.equal(asm.status, 200, `装配应 200：${asm.raw.slice(0, 200)}`);
    const boxResp = await post('/api/v1/me/box', { times: 2 }, token);
    assert.equal(boxResp.status, 200, boxResp.raw);
    const ai = await get('/api/v1/me/ai', token);
    assert.equal(ai.status, 200, ai.raw);
    const nick = await request(port, 'PUT', '/api/v1/me/nickname', { nickname: '契约昵称' },
      { authorization: `Bearer ${token}` });
    assert.equal(nick.status, 200, nick.raw);

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
    // D-170：改账号（段位/积分）—— 5 条契约路径（§2.5/§5）的宿主响应
    const patch = await adminPost('account-patch', { publicId: bannedUser.body.data.publicId, tier: 'rare', points: 100 });
    assert.equal(patch.status, 200, `改账号应 200：${patch.raw.slice(0, 200)}`);
    assert.equal(patch.body.data.tier, 'rare');
    assert.equal(patch.body.data.points, 100);
    const del = await adminPost('delete-account', { publicId: victim.body.data.publicId });
    assert.equal(del.status, 200, del.raw);

    return {
      register: reg.body, login: login.body, me: me.body, password: pwd.body, logout: logout.body,
      warehouse: wh.body, box: boxResp.body, ai: ai.body, nickname: nick.body,
      configs: configs.body, assemble: asm.body,
      error: { dup: dup.body, weak: weak.body, noAuth: noAuth.body },
      adminAccounts: accounts.body, adminDelete: del.body, adminStats: stats.body,
      adminRebuild: rebuild.body, adminBots: bots.body, adminClearBots: clearBots.body, adminBan: ban.body,
      adminPatch: patch.body,
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
    // F3：本批新接 UI 的端点（真起服务抓取；03 §5.1/§5.2）
    'me/warehouse': { envelopes: [real.warehouse], anyOf: false },
    'me/box': { envelopes: [real.box], anyOf: false },
    'me/ai': { envelopes: [real.ai], anyOf: false },
    'me/nickname': { envelopes: [real.nickname], anyOf: false },
    // 提交③：配置列表（编辑器）与装配回带（两步顺序第①步）
    'me/configs': { envelopes: [real.configs], anyOf: false },
    'me/warehouse/assemble': { envelopes: [real.assemble], anyOf: false },
    // F2：管理面各组（02-accounts.md §5）
    'admin/accounts': { envelopes: [real.adminAccounts], anyOf: false },
    'admin/delete-account': { envelopes: [real.adminDelete], anyOf: false },
    'admin/stats': { envelopes: [real.adminStats], anyOf: false },
    'admin/rebuild-index': { envelopes: [real.adminRebuild], anyOf: false },
    'admin/bots': { envelopes: [real.adminBots], anyOf: false },
    'admin/clear-bots': { envelopes: [real.adminClearBots], anyOf: false },
    'admin/ban': { envelopes: [real.adminBan], anyOf: false },
    // D-170：改账号（段位/积分）
    'admin/account-patch': { envelopes: [real.adminPatch], anyOf: false },
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

/* ---------- 分册 §5 表格的路径抽取（FC-3）
 *
 * 三份分册（01/02/03）的 §5 表格写法不完全一致，抽取必须能把三种写法归一：
 *   ① 绝对路径：`data.progress.tier`
 *   ② **兄弟延续**：`data.buckets.role[]` / `.skill[]`（= 同一父级下的兄弟桶）→ 替换最后一段
 *   ③ 花括号分组：`data.caps.{role,skill,rolePlugin,skillPlugin}`（= `data.caps`）
 * 归一后：去掉 `[]`、去掉 `{…}` 之后的部分、去掉尾随 `.`。
 */
function baseOfPath(token) {
  const cut = token.search(/[\[{=]/);
  const head = cut === -1 ? token : token.slice(0, cut);
  return head.replace(/\.$/, '');
}

function parentPath(p) {
  const i = p.lastIndexOf('.');
  return i === -1 ? '' : p.slice(0, i);
}

function documentedPaths(doc) {
  const start = doc.indexOf('## 5.');
  const end = doc.indexOf('## 6.');
  assert.ok(start !== -1 && end > start, '分册缺少 §5/§6 章节标记');
  const out = new Set();
  for (const line of doc.slice(start, end).split('\n')) {
    if (!line.startsWith('|')) continue; // 只取表格行（散文里提到的"不读取字段"不参与）
    let last = null;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const token = m[1];
      if (/^data\./.test(token) || /^error\./.test(token)) {
        last = baseOfPath(token);
        out.add(last);
      } else if (token === 'ok') {
        last = 'ok';
        out.add('ok');
      } else if (/^\.[A-Za-z0-9_]/.test(token) && last !== null) {
        last = parentPath(last) + '.' + baseOfPath(token.slice(1));
        out.add(last);
      }
    }
  }
  return out;
}

test('FC-3 三份分册 §5 表格路径集合（并集）== 契约 ∪ 显式「本批不读取」登记', () => {
  const documented = new Set();
  for (const docPath of DOC_PATHS) {
    for (const p of documentedPaths(fs.readFileSync(docPath, 'utf8'))) documented.add(p);
  }
  assert.ok(documented.size >= 30, `§5 表格解析到的路径过少（${documented.size}）`);
  // ① 每条契约路径都必须有分册依据（规则 4.2：字段名不得来自散文）
  const missingInDoc = [...ENVELOPE_PATHS].filter((p) => !documented.has(p));
  assert.deepEqual(missingInDoc, [], `契约有但分册 §5 未登记：${missingInDoc.join(', ')}`);
  // ② 分册 §5 登记了、本批前端**明确不读**的路径（如 `data.seed`：D-162 规定前端不传也不显示）
  //    必须在 contract.DOC_NOT_READ 里逐条登记理由 —— 双向闭合，不允许"文档有、代码不管、也没登记"
  const notRead = new Map(contract.DOC_NOT_READ.map((e) => [e.path, e.reason]));
  const unaccounted = [...documented].filter((p) => !ENVELOPE_PATHS.has(p) && !notRead.has(p));
  assert.deepEqual(unaccounted, [], `分册 §5 登记了但既未读取也未登记"不读取"：${unaccounted.join(', ')}`);
  // ③ 登记为"不读取"的路径必须真的在分册里（防止用它来掩盖漏读），且不能同时又出现在契约里
  const phantom = [...notRead.keys()].filter((p) => !documented.has(p));
  assert.deepEqual(phantom, [], `DOC_NOT_READ 登记了分册里不存在的路径：${phantom.join(', ')}`);
  for (const [p, reason] of notRead) {
    assert.ok(typeof reason === 'string' && reason.length > 10, `DOC_NOT_READ 的 ${p} 必须写明理由`);
  }
});

test('FC-4 「不读取」字段与契约无交集（防止散文式字段混入）', () => {
  const overlap = contract.UNUSED_FIELDS.filter((p) => ENVELOPE_PATHS.has(p));
  assert.deepEqual(overlap, [], `UNUSED_FIELDS 与契约重复：${overlap.join(', ')}`);
  const overlapDoc = contract.DOC_NOT_READ.map((e) => e.path).filter((p) => ENVELOPE_PATHS.has(p));
  assert.deepEqual(overlapDoc, [], `DOC_NOT_READ 与契约重复：${overlapDoc.join(', ')}`);
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

test('FC-6 F3 三个新投影只用契约字段就能产出可见文本（真实响应；无 undefined 泄漏）', async () => {
  const real = await capture();
  // hub 摘要（只读 GET /me；03 §3.1）
  const summary = format.hubSummary({ profile: real.me });
  assert.match(summary, /^.+( · .+){4}$/, `hub 摘要格式：${summary}`);
  assert.match(summary, /^契约 · common · 0 · 未读 进攻0\/防守0 · 在池$/, `hub 摘要内容：${summary}`);
  // 仓库容量行 + 物品行 + 物品详情（03 §3.3/§5.3）
  const capacity = format.warehouseCapacityText(real.warehouse);
  assert.match(capacity, /^角色 \d+\/500 · 技能 \d+\/500 · 角色插件 \d+\/500 · 技能插件 \d+\/500$/, `容量行：${capacity}`);
  const buckets = ['role', 'skill', 'rolePlugin', 'skillPlugin'];
  let items = 0;
  for (const bucket of buckets) {
    for (const item of format.bucketItems(real.warehouse, bucket)) {
      items += 1;
      const lines = format.itemDetailLines(real.warehouse, item);
      assert.ok(lines.length >= 4, `物品详情行过少：${lines.join(' | ')}`);
      for (const line of lines) {
        assert.ok(typeof line === 'string' && line.length > 0, '详情行必须是非空字符串');
        assert.ok(!line.includes('undefined') && !line.includes('null'), `详情行出现未投影值：${line}`);
      }
      const label = format.itemLabel(real.warehouse, item);
      assert.ok(!label.includes('undefined'), `物品行出现未投影值：${label}`);
    }
  }
  assert.ok(items >= 5, `starter 应至少有 5 件物品（1 角色 + 3 技能 + 插件），实际 ${items}`);
  // 开箱结果逐件行（03 §3.4）：**不显示 seed**（D-162）
  const boxLines = format.boxResultLines(real.box);
  assert.match(boxLines[0], /^本次获得 2 件：$/, `开箱结果首行：${boxLines[0]}`);
  assert.equal(boxLines.length, 3, 'times=2 时应回两件物品');
  for (const line of boxLines.slice(1)) assert.match(line, /^.+（(角色|技能|角色插件|技能插件)·.+）$/, `逐件行：${line}`);
  const seed = String(real.box.data.seed);
  assert.ok(seed !== 'undefined', '响应应回带 seed（仅服务端审计）');
  assert.ok(!boxLines.join('\n').includes(seed), '开箱结果区不得显示 seed（D-162）');
});
