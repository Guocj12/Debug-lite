'use strict';
/* tests/frontend/admin-flow.test.js —— F2 真实 HTTP 全流程（无头驱动**同一套**前端动作代码）
 *
 * 权威：docs/frontend/02-accounts.md §6/§8/§10.3。
 * 与浏览器完全同构：public/store.js + public/format.js + public/render.js + public/actions.js + public/api.js
 *   （fetch 由 Node 内建提供，baseUrl 指向进程内起真实服务）。所以本文件证明的是"管理面板确实连上了后端"，
 *   而不只是"接口能用"。人工浏览器走查剧本见 02-accounts.md §11。
 *
 * 覆盖：管理员身份 → 面板各按钮 → 真实响应文案；非管理员 → 403 文案且不切屏；
 *      令牌路径（X-Admin-Token）；分页（>100 个账号，total 不被截断、无重复无遗漏、每页条数切换）；
 *      删除（二次确认 → 删除 → 列表缩小 → 被删账号登录失效；删自己 → 409；A-4 空页回退）；
 *      封禁/解封（行按钮与面板 publicId 两条入口）；bots 未开调试 → 403 debug_bots_disabled 文案；令牌仅内存。
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/http.js');
const store = require('../../public/store.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const actions = require('../../public/actions.js');
const apiMod = require('../../public/api.js');
const appMod = require('../../public/app.js');

const PW1 = 'pw12345678';
const ADMIN_NAME = 'af2admin';
const ADMIN_TOKEN = 'af2-admin-token';
const ADMIN_ENV = { DL_ADMIN_USERS: ADMIN_NAME, DL_ADMIN_TOKEN: ADMIN_TOKEN };
// 造 >100 个账号会越过 auth 的「同 IP 每分钟 10 次尝试」与全局限速（既有行为，非本批引入）→ 测试内放宽
const RELAXED_AUTH = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };

// 假 localStorage（与真实接口同形），用于验证令牌只进内存、持久化键仍只有 F1 两个
function fakeWin() {
  const map = new Map();
  return {
    map,
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
}

function harness(baseUrl) {
  const win = fakeWin();
  const st = store.createStore(store.initialState());
  const storage = appMod.createStorage(win);
  const raw = apiMod.createApi({ baseUrl });
  const counter = { n: 0 };
  const count = (fn) => (...a) => { counter.n += 1; return fn(...a); };
  const api = {
    call: count(raw.call), register: count(raw.register), login: count(raw.login), logout: count(raw.logout),
    changePassword: count(raw.changePassword), me: count(raw.me), admin: count(raw.admin),
  };
  return {
    win, storage, api, counter,
    state: () => st.getState(),
    dispatch: (a) => st.dispatch(a),
    form: (values) => { for (const [k, v] of Object.entries(values)) st.dispatch({ type: 'form.set', field: k, value: v }); },
    setAdmin: (field, value) => st.dispatch({ type: 'admin.form.set', field, value }),
    // 与 public/app.js 的 run(action, payload) 同形
    run: (name, payload) => {
      const ctx = { state: st.getState(), dispatch: (a) => st.dispatch(a), api, format, storage, actions: actions.ACTIONS };
      return Promise.resolve(actions.ACTIONS[name].run(ctx, payload || null));
    },
  };
}

const htmlOf = (h) => render.render(format.viewModel(h.state()));
const noticeOf = (h) => (h.state().notice ? h.state().notice.text : '');
const resultOf = (h) => (h.state().admin.result ? h.state().admin.result.text : '');
const resultKind = (h) => (h.state().admin.result ? h.state().admin.result.kind : null);

async function withServer(fn, env, authConfig) {
  const s = await startServer({
    prefix: 'dl-fe-admin-', level: 'warn',
    authConfig: authConfig || RELAXED_AUTH,
    server: { rateLimitPerMinute: 100000, env: env || ADMIN_ENV },
  });
  try {
    return await fn(harness(s.baseUrl), s);
  } finally {
    await s.cleanup();
  }
}

// 走真实动作登录/注册一个管理员账号（面板只在管理员账号下可达，§3）
async function loginAdmin(h, name) {
  h.form({ username: name || ADMIN_NAME, password: PW1, confirm: PW1 });
  await h.run('submit-register');
  assert.equal(h.state().view, 'home');
  assert.equal(h.state().session.isAdmin, true, `${name || ADMIN_NAME} 应被判为管理员（DL_ADMIN_USERS）`);
  return h.state().session;
}

// 用真实动作逐页取完账号列表（页大小 size），返回全部行（{playerId,publicId,text}）
async function loadAllRows(h, size) {
  await h.run('accounts-size-' + size);
  const rows = [];
  for (let guard = 0; guard < 30; guard += 1) {
    rows.push(...format.accountRows(h.state().admin.accounts));
    if (!format.accountsHasMore(h.state().admin.accounts)) break;
    await h.run('accounts-next');
  }
  return rows;
}

test('AF-1 管理员登录 → 主页出现管理入口 → 面板按钮产出真实响应文案', async () => {
  await withServer(async (h) => {
    const session = await loginAdmin(h);
    assert.ok(htmlOf(h).includes('>管理员面板</button>'), '管理员主页应出现「管理员面板」按钮');
    await h.run('goto-admin');
    assert.equal(h.state().view, 'admin');
    assert.ok(htmlOf(h).includes('你是管理员账号：' + session.publicId), '面板提示行应含管理员 publicId');

    await h.run('admin-stats');
    assert.match(resultOf(h), /^players=\d+ seq=\d+ snapshots=.+$/, `服务统计文案：${resultOf(h)}`);
    assert.equal(resultKind(h), 'info');

    await h.run('admin-rebuild-index');
    assert.match(resultOf(h), /^重建完成：\d+ 玩家$/, `重建索引文案：${resultOf(h)}`);

    // 刷新档案（/me 的 data.flags.isAdmin）后管理入口仍在 —— 否则管理员"刷新一下就掉权限"
    await h.run('goto-home');
    assert.equal(h.state().view, 'home');
    await h.run('refresh-profile');
    assert.equal(h.state().session.isAdmin, true);
    assert.ok(htmlOf(h).includes('>管理员面板</button>'), '刷新档案后管理入口不应消失');
  });
});

test('AF-2 非管理员：管理入口完全不渲染；强制调用 → 403 文案且不切屏（A-1）', async () => {
  await withServer(async (h) => {
    h.form({ username: 'af2plain', password: PW1, confirm: PW1 });
    await h.run('submit-register');
    assert.equal(h.state().session.isAdmin, false);
    assert.ok(!htmlOf(h).includes('管理员面板'), '普通账号主页不得出现管理入口');
    assert.ok(!htmlOf(h).includes('管理员令牌'), '普通账号主页不得出现管理员令牌输入框');

    // 手工构造管理调用（等价于在控制台直接触发动作）：服务端仍是权威 → 403
    const before = h.counter.n;
    await h.run('admin-refresh-accounts');
    assert.equal(h.counter.n, before + 1, '强制调用必须真的到服务端（前端不做越权兜底）');
    assert.equal(h.state().view, 'home', '403 不得切到账号列表屏');
    assert.match(resultOf(h), /需要管理员权限/, `403 文案：${resultOf(h)}`);
    assert.match(noticeOf(h), /需要管理员权限/, '非管理屏也要有可见文案（按钮永不无声）');

    // 强制切屏：入口动作自身也拦（状态被篡改时不进面板）
    await h.run('goto-admin');
    assert.equal(h.state().view, 'home');
  });
});

test('AF-3 令牌路径（X-Admin-Token）仍可用；未登记 op 不发请求', async () => {
  await withServer(async (h) => {
    const ok = await h.api.admin('stats', {}, ADMIN_TOKEN, null);
    assert.equal(ok.status, 200, `令牌路径应 200：${ok.raw}`);
    assert.equal(format.isOk(ok.envelope), true);
    const bad = await h.api.admin('stats', {}, 'wrong-token', null);
    assert.equal(bad.status, 403);
    assert.equal(format.errorCodeOf(bad.envelope), 'forbidden');
    // 02-accounts.md §2.2 的 503 路径：未配置 DL_ADMIN_TOKEN 且请求者非管理员
    await withServer(async (h2) => {
      const missing = await h2.api.admin('stats', {}, null, null);
      assert.equal(missing.status, 503);
      assert.equal(format.errorCodeOf(missing.envelope), 'admin_token_missing');
      assert.match(format.adminNoticeText(missing.envelope), /服务端未配置管理员令牌/);
    }, { DL_ADMIN_USERS: 'nobody-at-all' });
    // 未登记的 op：前端登记表是唯一入口 → 本地拒绝（不经唯一网络出口发请求）
    const unknown = await h.api.admin('not-an-op', {}, ADMIN_TOKEN, null);
    assert.equal(unknown.transport, 'error', '未登记 op 应回传输层错误而不是响应');
    assert.match(unknown.message, /未登记的管理端点/, `未登记 op 文案：${unknown.message}`);
    assert.equal(unknown.status, undefined, '未登记 op 不应产生任何 HTTP 响应（未发请求）');
  });
});

test('AF-4 分页：造 105 个账号 → total 不受 100 上限约束、无重复无遗漏、每页条数可切换', async () => {
  await withServer(async (h) => {
    const admin = await loginAdmin(h);
    const created = [admin.publicId];
    const TOTAL = 105;
    for (let i = 0; i < TOTAL; i += 1) {
      const r = await h.api.register({ username: 'af4u' + String(i).padStart(3, '0'), password: PW1 });
      assert.equal(r.status, 200, `造账号失败：${r.raw}`);
      created.push(r.envelope.data.publicId);
    }
    const expected = new Set(created);
    assert.equal(expected.size, TOTAL + 1);

    // 每页 50：逐页取完（>25 个账号的分页，§10.3）
    const rows50 = await loadAllRows(h, 50);
    assert.equal(h.state().admin.limit, 50);
    assert.equal(rows50.length, expected.size, `每页 50 应取完全部账号：${rows50.length}`);
    assert.equal(new Set(rows50.map((r) => r.publicId)).size, rows50.length, '分页出现重复行');

    // 每页 100：同样取完，且 total>100 未被截断（02-accounts.md §2.3）
    const rows100 = await loadAllRows(h, 100);
    assert.equal(h.state().admin.limit, 100);
    assert.equal(rows100.length, expected.size, `每页 100 应取完全部账号：${rows100.length}`);
    assert.equal(new Set(rows100.map((r) => r.publicId)).size, rows100.length, '分页出现重复行');
    for (const row of rows100) {
      assert.ok(expected.has(row.publicId), `列表出现未注册账号：${row.publicId}`);
      assert.ok(expected.delete(row.publicId), `列表出现重复账号：${row.publicId}`);
    }
    assert.equal(expected.size, 0, '有账号未被任何一页列出（遗漏）');

    const info = format.accountsInfoText(h.state().admin.accounts);
    assert.match(info, /^共 106 个账号，第 2\/2 页（每页 100）$/, `分页信息行：${info}`);
    assert.ok(htmlOf(h).includes('共 106 个账号'), '分页信息行必须渲染到屏幕上');
    // 最后一页：hasMore=false → 下一页禁用（A-3）
    assert.equal(format.accountsHasMore(h.state().admin.accounts), false);
    assert.ok(htmlOf(h).includes('data-action="accounts-next" disabled'), 'A-3：最后一页「下一页」应禁用');

    // 上一页 → 回到第 1 页
    await h.run('accounts-prev');
    assert.equal(h.state().admin.offset, 0);
    assert.ok(htmlOf(h).includes('第 1/2 页'), '上一页应回到第 1 页');

    // 每页 20 → 回第 1 页且行数 20
    await h.run('accounts-size-20');
    assert.equal(h.state().admin.offset, 0);
    assert.equal(format.accountRows(h.state().admin.accounts).length, 20);
    const info20 = format.accountsInfoText(h.state().admin.accounts);
    assert.match(info20, /^共 106 个账号，第 1\/6 页（每页 20）$/, `分页信息行：${info20}`);
  });
});

test('AF-5 删除：二次确认 → 删除 → 列表缩小 → 被删账号登录失效；删自己 → 409；空页回退（A-4）', async () => {
  await withServer(async (h) => {
    await loginAdmin(h);
    const victim = await h.api.register({ username: 'af5victim', password: PW1 });
    const victimId = victim.envelope.data.publicId;

    // 再补 20 个账号：让列表刚好有两页（每页 20），便于验证 A-4 的空页回退
    for (let i = 0; i < 20; i += 1) {
      const r = await h.api.register({ username: 'af5fill' + String(i).padStart(2, '0'), password: PW1 });
      assert.equal(r.status, 200, r.raw);
    }
    const before = await loadAllRows(h, 100);
    const total = before.length;
    assert.ok(total >= 22, `应至少 22 个账号：${total}`);

    const row = before.find((r) => r.publicId === victimId);
    assert.ok(row, '列表应含待删除账号');

    // 点「删除」→ 只进二次确认态，不发请求（§3.2：后端不再二次确认）
    const noRequest = h.counter.n;
    await h.run('admin-delete-account', { playerId: row.playerId, publicId: row.publicId });
    assert.equal(h.counter.n, noRequest, '删除必须先在屏上二次确认，不得直接发请求');
    assert.equal(h.state().admin.confirm.kind, 'delete');
    assert.equal(h.state().admin.confirm.publicId, victimId);
    assert.ok(htmlOf(h).includes('确认删除 ' + victimId + '？此操作不可撤销'), '确认文案不符');

    // 「取消」→ 账号仍在（§11 步 8）
    await h.run('confirm-no');
    assert.equal(h.state().admin.confirm, null);
    assert.ok(htmlOf(h).includes(victimId), '取消后该账号仍应显示在列表里');

    // 再次删除 → 确认 → 列表少一行 + 结果区文案
    await h.run('admin-delete-account', { playerId: row.playerId, publicId: row.publicId });
    await h.run('confirm-yes');
    assert.equal(h.state().admin.confirm, null, '确认后应退出确认态');
    assert.match(resultOf(h), new RegExp('^已删除 ' + victimId + '$'), `删除结果文案：${resultOf(h)}`);
    assert.equal(h.state().view, 'accounts');
    const after = format.accountRows(h.state().admin.accounts);
    const listed = await loadAllRows(h, 100);
    assert.equal(listed.length, total - 1, '删除后总数应减 1');
    assert.ok(!listed.some((r) => r.publicId === victimId), '列表不应再含被删账号');
    assert.ok(after.length > 0, '删除后应仍显示当前页内容');

    // 被删账号无法再登录（墓碑语义）
    const relogin = await h.api.login({ username: 'af5victim', password: PW1 });
    assert.equal(relogin.status, 401, '被删账号应登录失败');
    assert.match(format.noticeText(relogin.envelope), /用户名或密码错误/);

    // 删自己 → 服务端 409（§6 cannot_delete_self）
    const selfRow = listed.find((r) => r.publicId === h.state().session.publicId);
    assert.ok(selfRow, '列表应含管理员自己');
    await h.run('admin-delete-account', { playerId: selfRow.playerId, publicId: selfRow.publicId });
    await h.run('confirm-yes');
    assert.match(resultOf(h), /不能删除当前登录的管理员账号/, `删自己文案：${resultOf(h)}`);
    assert.equal(resultKind(h), 'error');
    assert.ok(h.state().session.token, '删自己失败不应影响管理员会话');
  });
});

test('AF-6 A-4 删除当前页最后一行 → 自动回退一页；A-2 空列表无行按钮', async () => {
  await withServer(async (h) => {
    // 21 个普通账号 + 1 个管理员 = 22：每页 20 → 第 2 页 2 行
    // 注意：列表按 updatedAt 降序 → 最后注册的管理员在第 1 页，第 2 页是可删的普通账号
    for (let i = 0; i < 21; i += 1) {
      const r = await h.api.register({ username: 'af6u' + String(i).padStart(2, '0'), password: PW1 });
      assert.equal(r.status, 200, r.raw);
    }
    await loginAdmin(h);
    await h.run('admin-refresh-accounts');
    assert.equal(h.state().admin.offset, 0);
    await h.run('accounts-next');
    assert.equal(h.state().admin.offset, 20);
    const secondPage = format.accountRows(h.state().admin.accounts);
    assert.equal(secondPage.length, 2, '第 2 页应有 2 行');
    for (const r of secondPage) assert.notEqual(r.publicId, h.state().session.publicId, '第 2 页不应含管理员自己');

    // 删掉第 2 页的两行 → 该页变空且 offset>0 → 自动回退一页（A-4）
    for (let i = 0; i < 2; i += 1) {
      const row = format.accountRows(h.state().admin.accounts)[0];
      assert.ok(row, '第 2 页应还有待删除行');
      await h.run('admin-delete-account', { playerId: row.playerId, publicId: row.publicId });
      await h.run('confirm-yes');
    }
    assert.equal(h.state().admin.offset, 0, 'A-4：空页应自动回退一页');
    assert.equal(format.accountRows(h.state().admin.accounts).length, 20, 'A-4：回退后应显示第 1 页 20 行');

    // A-2：账号总数 0 时列表显示「共 0 个账号」且没有行按钮
    const empty = store.initialState();
    empty.session = { token: 't', publicId: 'u_a', nickname: 'a', expiresAt: null, isAdmin: true };
    empty.view = 'accounts';
    empty.admin.accounts = { ok: true, data: { total: 0, offset: 0, limit: 20, hasMore: false, rows: [] } };
    const emptyHtml = render.render(format.viewModel(empty));
    assert.ok(emptyHtml.includes('共 0 个账号'), 'A-2：应显示「共 0 个账号」');
    assert.ok(!emptyHtml.includes('data-action="admin-delete-account"'), 'A-2：无账号不应有行按钮');
  });
});

test('AF-7 封禁/解封：行按钮与面板 publicId 两条入口；刷新后标记出现/消失', async () => {
  await withServer(async (h) => {
    await loginAdmin(h);
    const target = await h.api.register({ username: 'af7victim', password: PW1 });
    const targetId = target.envelope.data.publicId;
    let rows = await loadAllRows(h, 100);
    let row = rows.find((r) => r.publicId === targetId);
    assert.ok(row, '列表应含待封禁账号');
    assert.ok(!row.text.includes('[已封禁]'), '初始不应有已封禁标记');

    // ① 行按钮（data-player-id 直连）
    await h.run('admin-ban-row', { playerId: row.playerId, publicId: row.publicId });
    assert.match(resultOf(h), new RegExp('^已封禁 ' + targetId + '$'), `封禁文案：${resultOf(h)}`);
    rows = await loadAllRows(h, 100);
    row = rows.find((r) => r.publicId === targetId);
    assert.ok(row.text.includes('[已封禁]'), `刷新后该行应出现已封禁标记：${row.text}`);
    assert.ok(htmlOf(h).includes('[已封禁]'), '已封禁标记必须渲染到屏幕上');

    // ② 解封行
    await h.run('admin-unban-row', { playerId: row.playerId, publicId: row.publicId });
    assert.match(resultOf(h), new RegExp('^已解封 ' + targetId + '$'), `解封文案：${resultOf(h)}`);
    rows = await loadAllRows(h, 100);
    row = rows.find((r) => r.publicId === targetId);
    assert.ok(!row.text.includes('[已封禁]'), '解封后标记应消失');

    // ③ 面板输入框路径（只给 publicId：前端经账号列表解析 playerId 后封禁）
    h.setAdmin('adminTarget', targetId);
    assert.equal(h.state().admin.target, targetId);
    await h.run('admin-ban-row');
    assert.match(resultOf(h), new RegExp('^已封禁 ' + targetId + '$'), `面板封禁文案：${resultOf(h)}`);
    rows = await loadAllRows(h, 100);
    assert.ok(rows.find((r) => r.publicId === targetId).text.includes('[已封禁]'), '面板封禁应真实生效');

    // 面板目标留空 → 客户端拦下，不发请求
    h.setAdmin('adminTarget', '');
    const before = h.counter.n;
    await h.run('admin-ban-row');
    assert.equal(h.counter.n, before, '空目标不得发请求');
    assert.match(resultOf(h), /请填写封禁目标 publicId/);

    // 目标不存在 → 提示（服务端 404 语义在前端可读）
    h.setAdmin('adminTarget', 'u_not_exist_0001');
    await h.run('admin-ban-row');
    assert.match(resultOf(h), /没有 publicId=u_not_exist_0001 的账号/);
  });
});

test('AF-8 注入调试 bot：未开 DL_DEBUG_BOTS → 403 文案；开启后可注入并清除', async () => {
  // ① 未设 DL_DEBUG_BOTS（服务端默认关闭）
  await withServer(async (h) => {
    await loginAdmin(h);
    const before = h.counter.n;
    await h.run('admin-bots');
    assert.equal(h.counter.n, before + 1, '必须真的发请求，由服务端判定调试开关');
    assert.match(resultOf(h), /调试 bot 注入已关闭（需服务端设 DL_DEBUG_BOTS=1）/, `403 文案：${resultOf(h)}`);
    assert.equal(resultKind(h), 'error');
  });

  // ② 注入数量非法 → 客户端拦下（不发请求）
  await withServer(async (h) => {
    await loginAdmin(h);
    h.setAdmin('adminCount', 'abc');
    const before = h.counter.n;
    await h.run('admin-bots');
    assert.equal(h.counter.n, before, '非法数量不得发请求');
    assert.match(resultOf(h), /注入数量需为 1~200 的整数/);
  });

  // ③ DL_DEBUG_BOTS=1 → 注入 2 个并清除
  await withServer(async (h) => {
    await loginAdmin(h);
    h.setAdmin('adminCount', '2');
    await h.run('admin-bots');
    assert.match(resultOf(h), /^已注入 2 个（跳过 0 个）$/, `注入文案：${resultOf(h)}`);
    const rows = await loadAllRows(h, 100);
    assert.ok(rows.some((r) => r.text.includes('[bot]')), '注入后列表应出现 bot 行');
    await h.run('admin-clear-bots');
    assert.match(resultOf(h), /^已清除 2 个$/, `清除文案：${resultOf(h)}`);
  }, Object.assign({}, ADMIN_ENV, { DL_DEBUG_BOTS: '1' }));
});

test('AF-9 令牌仅内存（A-9）：不进 localStorage，刷新（新会话）后需重填', async () => {
  const s = await startServer({ prefix: 'dl-fe-admin-tok-', level: 'warn', authConfig: RELAXED_AUTH, server: { rateLimitPerMinute: 100000, env: ADMIN_ENV } });
  try {
    const h = harness(s.baseUrl);
    await loginAdmin(h);
    h.setAdmin('adminToken', ADMIN_TOKEN);
    assert.equal(h.state().adminToken, ADMIN_TOKEN, '令牌应在内存状态里可用');
    // 持久化键仍只有 F1 的两个，且任何值都不含管理员令牌
    assert.deepEqual([...h.win.map.keys()].sort(), ['dl.session', 'dl.token'], '持久化键只能是 dl.token / dl.session');
    for (const [, value] of h.win.map) assert.ok(!String(value).includes(ADMIN_TOKEN), '管理员令牌不得写入 localStorage');

    // 刷新页面 = 新建 store + 同一份 localStorage → 令牌丢失（A-9 的已知代价，面板提示行已写明）
    const h2 = harness(s.baseUrl);
    h2.win.map.clear();
    for (const [k, v] of h.win.map) h2.win.map.set(k, v);
    h2.dispatch({ type: 'session.set', token: h.state().session.token, publicId: h.state().session.publicId, nickname: 'n', expiresAt: null, isAdmin: true });
    assert.equal(h2.state().adminToken, '', '刷新后管理员令牌应需重填');
    assert.ok(render.render(format.viewModel(Object.assign(h2.state(), { view: 'admin' }))).includes('刷新页面后需重填'), '面板提示行应写明该代价');
  } finally {
    await s.cleanup();
  }
});
