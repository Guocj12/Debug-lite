'use strict';
/* tests/frontend/admin-ui-contract.test.js —— F2 界面契约（总纲 §4.1「按钮永不无声」+ §1.5「投影单一真源」）
 *
 * 权威：docs/frontend/02-accounts.md §10.2/§3/§4/§8。
 * 机器判定：
 *   ① 管理员态下全部屏渲染出的 data-action 集合 == ACTIONS 注册表（双向：无死按钮、无无入口实现）；
 *   ② 非管理员态**完全不渲染**任何管理入口（A-1），admin/accounts 两屏兜底回主页；
 *   ③ 管理动作在 busy 时全部禁用（§4）；
 *   ④ render.js 零逻辑（复用 F1 UI-7 口径）；
 *   ⑤ 账号行字段三方一致（contract.js == format.js == 02-accounts.md §5）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../../public/store.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const actions = require('../../public/actions.js');
const contract = require('../../public/contract.js');
const appMod = require('../../public/app.js');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO, 'public');
const ACTION_NAMES = Object.keys(actions.ACTIONS).sort();

// 02-accounts.md §4 的动作白名单（F1 九个 + F2 增量十六个；文档标题写"新增 15 个（合计 24）"，
//   但其表格逐行枚举出来的新增项是 16 个 —— 测试以**表格逐行枚举**为准，见 admin-ui-contract 的 AU-1）
const F1_ACTIONS = ['submit-login', 'submit-register', 'submit-password', 'refresh-profile', 'logout',
  'goto-register', 'goto-login', 'goto-password', 'goto-home'];
const F2_ACTIONS = ['goto-admin', 'admin-refresh-accounts', 'accounts-prev', 'accounts-next',
  'accounts-size-20', 'accounts-size-50', 'accounts-size-100', 'admin-delete-account', 'confirm-yes', 'confirm-no',
  'admin-stats', 'admin-rebuild-index', 'admin-bots', 'admin-clear-bots', 'admin-ban-row', 'admin-unban-row'];

const ROW = {
  playerId: 'pl_row0001', publicId: 'u_row0001', nickname: '行一', tier: 'common', points: 120,
  peakPoints: 200, inPool: true, isBot: false, banned: false, lastSeenAt: 1789911067638, updatedAt: 1789911067638,
};

function accountsEnvelope(extra) {
  return { ok: true, data: Object.assign({ total: 1, offset: 0, limit: 20, hasMore: false, rows: [ROW] }, extra || {}) };
}

// 管理员态（state.session.isAdmin === true）的初始状态
function adminState(view, extra) {
  const state = store.initialState();
  state.session = { token: 'token-for-test', publicId: 'u_admin01', nickname: '管理员', expiresAt: null, isAdmin: true };
  state.view = view || 'home';
  state.admin.accounts = accountsEnvelope();
  return Object.assign(state, extra || {});
}

function htmlFor(state) { return render.render(format.viewModel(state)); }

function attrValues(html, attr) {
  const out = new Set();
  for (const m of html.matchAll(new RegExp(attr + '="([^"]*)"', 'g'))) if (m[1] !== '') out.add(m[1]);
  return out;
}

// 管理员态下**全部**屏的渲染（含账号列表的二次确认子态）—— F2 全部 25 个动作都应在此出现
function adminRenderings() {
  const list = ['login', 'register', 'home', 'password', 'admin'].map((view) => htmlFor(adminState(view)));
  list.push(htmlFor(adminState('accounts')));
  list.push(htmlFor(adminState('accounts', { admin: Object.assign(store.emptyAdmin(), {
    accounts: accountsEnvelope(), confirm: { kind: 'delete', playerId: ROW.playerId, publicId: ROW.publicId },
  }) })));
  return list;
}

test('AU-1 管理员态全部屏的 data-action 集合 == ACTIONS 注册表（双向；含 F2 十六个）', () => {
  assert.deepEqual([...F1_ACTIONS, ...F2_ACTIONS].sort(), ACTION_NAMES,
    `动作白名单与 02-accounts.md §4 表格不一致：${ACTION_NAMES.join(', ')}`);
  const rendered = new Set();
  for (const html of adminRenderings()) for (const a of attrValues(html, 'data-action')) rendered.add(a);
  const dead = [...rendered].filter((a) => ACTION_NAMES.indexOf(a) === -1);
  const unreachable = ACTION_NAMES.filter((a) => !rendered.has(a));
  assert.deepEqual(dead, [], `渲染出的按钮没有实现分支（死按钮）：${dead.join(', ')}`);
  assert.deepEqual(unreachable, [], `注册了动作但没有入口（不可达）：${unreachable.join(', ')}`);
  assert.equal(rendered.size, 25, `F2 动作数应为 25（F1 九个 + F2 十六个），实际 ${rendered.size}`);
});

test('AU-2 非管理员态完全不渲染管理入口（A-1）；admin/accounts 两屏兜底回主页', () => {
  const adminActions = new Set(['goto-admin', ...F2_ACTIONS]);
  for (const view of store.VIEWS) {
    const state = store.initialState();
    state.view = view; // 含被强制构造的 admin / accounts
    const html = htmlFor(state);
    const rendered = attrValues(html, 'data-action');
    const leaked = [...rendered].filter((a) => adminActions.has(a));
    assert.deepEqual(leaked, [], `非管理员态在 ${view} 屏渲染了管理入口：${leaked.join(', ')}`);
    assert.ok(!html.includes('管理员面板'), `${view} 屏出现「管理员面板」文本`);
    assert.ok(!html.includes('管理员令牌'), `${view} 屏出现管理员令牌输入框`);
    if (view === 'admin' || view === 'accounts') {
      assert.equal(format.viewModel(state).title, '已登录', `${view} 屏在非管理员态应兜底为主页`);
    }
  }
});

test('AU-3 每个动作都有 run 与非空标签；管理动作在 busy 时全部禁用（§4）', () => {
  for (const [name, def] of Object.entries(actions.ACTIONS)) {
    assert.equal(typeof def.run, 'function', `动作 ${name} 缺少 run 实现`);
    assert.ok(typeof def.label === 'string' && def.label !== '', `动作 ${name} 缺少可见标签`);
  }
  for (const view of ['home', 'admin', 'accounts']) {
    const state = adminState(view, { busy: true });
    const html = htmlFor(state);
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length > 0, `${view} 屏应至少有一个按钮`);
    for (const b of buttons) assert.ok(b.includes('disabled'), `${view} 屏 busy 时按钮未禁用：${b}`);
  }
});

test('AU-4 render.js 零逻辑：不读字段、不接触应用状态对象、不拼文案', () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'render.js'), 'utf8');
  assert.equal((src.match(/pick\(/g) || []).length, 0, 'render.js 不得出现 pick(');
  assert.ok(!/\bstate\b/.test(src), 'render.js 不得接触应用状态对象（只接收视图模型 vm）');
  assert.ok(!/\bfetch\(/.test(src), 'render.js 不得发请求');
  for (const entry of contract.AUTH_FIELD_CONTRACT) {
    assert.ok(!src.includes(`'${entry.path}'`) && !src.includes(`"${entry.path}"`),
      `render.js 不得出现契约字段字面量：${entry.path}`);
  }
  // F2：行按钮的目标必须来自 vm（render 只搬运），且必须真的渲染出来
  const html = htmlFor(adminState('accounts'));
  assert.ok(html.includes(`data-player-id="${ROW.playerId}"`), '行按钮必须携带 data-player-id');
  assert.ok(html.includes(`data-public-id="${ROW.publicId}"`), '行按钮必须携带 data-public-id');
});

test('AU-5 账号行字段三方一致：contract.js == format.js == 02-accounts.md §5', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'frontend', '02-accounts.md'), 'utf8');
  const cell = doc.match(/逐项取\s*`([^`]+)`/);
  assert.ok(cell, '02-accounts.md §5 缺少 `data.rows` 行的「逐项取 …」字段串');
  const documented = cell[1].split('/').map((s) => s.trim()).filter((s) => s !== '');
  assert.ok(documented.length >= 8, `文档行字段解析过少：${documented.join(', ')}`);
  assert.deepEqual([...contract.ADMIN_ROW_FIELDS].sort(), [...documented].sort(),
    `contract.js 的行字段与文档 §5 不一致`);
  assert.deepEqual([...format.ADMIN_ROW_FIELDS].sort(), [...documented].sort(),
    `format.js 的行字段与文档 §5 不一致`);
});

test('AU-6 三屏静态文案与分页/边界（§3、§8 A-2/A-3/A-7）', () => {
  // 主页：管理员才出现「管理员面板」
  const homeHtml = htmlFor(adminState('home'));
  assert.ok(homeHtml.includes('>管理员面板</button>'), '管理员主页应有「管理员面板」按钮');

  // 面板：提示行含管理员 publicId 与「令牌仅内存」的已知代价（§3.1 + A-9）
  const adminHtml = htmlFor(adminState('admin'));
  assert.ok(adminHtml.includes('你是管理员账号：u_admin01'), '面板提示行应含管理员 publicId');
  assert.ok(adminHtml.includes('刷新页面后需重填'), '面板提示行应写明令牌仅内存（A-9）');
  for (const label of ['刷新账号列表', '服务统计', '重建索引', '注入调试 bot', '清除调试 bot', '返回主页']) {
    assert.ok(adminHtml.includes('>' + label + '</button>'), `面板缺少按钮：${label}`);
  }
  assert.ok(adminHtml.includes('管理员令牌'), '面板应有管理员令牌输入框');
  assert.ok(adminHtml.includes('封禁目标 publicId'), '面板应有封禁目标输入框');
  assert.ok(adminHtml.includes('>注入数量<'), '面板应有注入数量输入框');

  // 账号列表：分页信息行 + 行文本 + 页脚按钮
  const listHtml = htmlFor(adminState('accounts'));
  assert.ok(listHtml.includes('共 1 个账号，第 1/1 页（每页 20）'), `分页信息行不符：${listHtml}`);
  assert.ok(listHtml.includes(ROW.publicId) && listHtml.includes('playerId=' + ROW.playerId), '账号行应含 publicId 与 playerId');
  assert.ok(listHtml.includes('段位common') && listHtml.includes('积分120'), '账号行应含段位与积分');
  assert.ok(listHtml.includes('[在池]'), '账号行应含匹配池标记');
  for (const label of ['上一页', '下一页', '刷新', '返回面板', '每页 20', '每页 50', '每页 100']) {
    assert.ok(listHtml.includes('>' + label + '</button>'), `列表页脚缺少按钮：${label}`);
  }

  // A-2：0 个账号 → 无行、翻页按钮禁用
  const emptyHtml = htmlFor(adminState('accounts', {
    admin: Object.assign(store.emptyAdmin(), { accounts: accountsEnvelope({ total: 0, rows: [] }) }),
  }));
  assert.ok(emptyHtml.includes('共 0 个账号'), 'A-2：应显示「共 0 个账号」');
  assert.ok(!emptyHtml.includes('data-action="admin-delete-account"'), 'A-2：无账号时不应有行按钮');
  assert.ok(emptyHtml.includes('data-action="accounts-next" disabled'), 'A-2：下一页应禁用');
  assert.ok(emptyHtml.includes('data-action="accounts-prev" disabled'), 'A-2：上一页应禁用');

  // A-3：hasMore=false（最后一页不满）→ 下一页禁用
  const lastHtml = htmlFor(adminState('accounts', {
    admin: Object.assign(store.emptyAdmin(), { accounts: accountsEnvelope({ total: 40, offset: 20, limit: 20, hasMore: false }) }),
  }));
  assert.ok(lastHtml.includes('第 2/2 页'), `A-3：页码应为 2/2：${lastHtml}`);
  assert.ok(lastHtml.includes('data-action="accounts-next" disabled'), 'A-3：hasMore=false → 下一页禁用');

  // A-7：offset 越界 → 空 rows + 正确 total，页码按最后一页钳制
  const beyondHtml = htmlFor(adminState('accounts', {
    admin: Object.assign(store.emptyAdmin(), { accounts: accountsEnvelope({ total: 40, offset: 9999, limit: 20, hasMore: false, rows: [] }) }),
  }));
  assert.ok(beyondHtml.includes('共 40 个账号，第 2/2 页'), `A-7：越界 offset 应钳到最后一页：${beyondHtml}`);

  // 二次确认块（§3.2）：文案 + 两个按钮
  const confirmHtml = htmlFor(adminState('accounts', {
    admin: Object.assign(store.emptyAdmin(), {
      accounts: accountsEnvelope(), confirm: { kind: 'delete', playerId: ROW.playerId, publicId: ROW.publicId },
    }),
  }));
  assert.ok(confirmHtml.includes('确认删除 ' + ROW.publicId + '？此操作不可撤销'), '二次确认文案不符');
  assert.ok(confirmHtml.includes('data-action="confirm-yes"') && confirmHtml.includes('data-action="confirm-no"'), '二次确认缺按钮');
});

test('AU-7 管理面板输入框是受控输入（值来自状态，且令牌不落任何持久化）', () => {
  const state = adminState('admin', { adminToken: 'tok-in-memory' });
  state.admin.target = 'u_target';
  state.admin.count = '3';
  const vm = format.viewModel(state);
  const byName = (name) => vm.fields.find((f) => f.name === name);
  assert.equal(byName('adminToken').value, 'tok-in-memory');
  assert.equal(byName('adminToken').type, 'password', '管理员令牌应遮蔽输入');
  assert.equal(byName('adminTarget').value, 'u_target');
  assert.equal(byName('adminCount').value, '3');
  // store.js 只把令牌放在内存字段上（结构与 §7 一致），不存在任何持久化入口
  assert.equal(store.initialState().adminToken, '', '初始管理员令牌必须为空串');
  const storeSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'store.js'), 'utf8');
  assert.ok(!/localStorage\s*[.[]/.test(storeSrc), 'store.js 不得调用 localStorage（令牌仅内存）');
  const appSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  assert.ok(!appSrc.includes("'adminToken'") && !appSrc.includes('"adminToken"'),
    'app.js 不得把管理员令牌写进任何存储键（令牌仅内存）');
  assert.ok(appSrc.includes("KEY_TOKEN = 'dl.token'") && appSrc.includes("KEY_SESSION = 'dl.session'"),
    'app.js 的持久化键应仍只有 dl.token / dl.session（01-auth.md §7.3）');
});

/* ---------- AU-8：DOM 装配层（事件委托）真的把按钮变成动作 ----------
 * 用**手写假 DOM**（非 jsdom，零依赖）：只提供 app.js 真正用到的那几个成员，
 * 从而把「行按钮的 data-player-id → payload → 管理动作」与「管理输入框 → admin.form.set」钉死。
 */
function fakeDom() {
  const listeners = {};
  const host = {
    writes: 0,
    _html: '',
    set innerHTML(value) { this.writes += 1; this._html = String(value); },
    get innerHTML() { return this._html; },
  };
  return {
    host,
    doc: {
      title: '',
      getElementById: (id) => (id === 'view' ? host : null),
      addEventListener: (type, fn) => { listeners[type] = fn; },
    },
    fire: (type, event) => listeners[type](event),
  };
}

function fakeButton(action, dataset) {
  return {
    tagName: 'BUTTON',
    type: 'button',
    dataset: dataset || {},
    getAttribute: (name) => (name === 'data-action' ? action : null),
  };
}

test('AU-8 DOM 装配层：行按钮的 data-player-id 变成动作 payload；管理输入框只进内存不重绘', async () => {
  const dom = fakeDom();
  const calls = [];
  const fakeApi = {
    admin: (op, body, adminToken, bearerToken) => {
      calls.push({ op, body, adminToken, bearerToken });
      return Promise.resolve({
        transport: 'response', status: 200,
        envelope: { ok: true, data: { total: 0, offset: 0, limit: 20, hasMore: false, rows: [] } },
      });
    },
  };
  const map = new Map();
  const win = { localStorage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) } };
  const app = appMod.createApp({ doc: dom.doc, win, DL: { store, format, render, actions }, api: fakeApi });
  await app.start();
  assert.equal(app.store.getState().booted, true, '启动自检应完成');
  assert.ok(dom.host.innerHTML.includes('登录'), '无会话时应渲染登录屏');

  app.dispatch({ type: 'session.set', token: 'tk', publicId: 'u_admin01', nickname: '管理员', expiresAt: null, isAdmin: true });
  app.dispatch({ type: 'profile.set', envelope: null });
  app.dispatch({ type: 'view.go', view: 'admin' });
  assert.ok(dom.host.innerHTML.includes('管理员面板'), '管理员态应渲染管理面板');
  assert.ok(dom.host.innerHTML.includes('data-enter="admin-refresh-accounts"'), '面板表单应绑定回车动作');

  // 输入事件：管理字段走 admin.form.set，且不重绘（避免光标跳动）
  const writesBefore = dom.host.writes;
  dom.fire('input', { target: { name: 'adminToken', value: 'tok-1' } });
  dom.fire('input', { target: { name: 'adminTarget', value: 'u_row0001' } });
  dom.fire('input', { target: { name: 'adminCount', value: '2' } });
  assert.equal(app.store.getState().adminToken, 'tok-1', '管理员令牌应进内存状态');
  assert.equal(app.store.getState().admin.target, 'u_row0001');
  assert.equal(app.store.getState().admin.count, '2');
  assert.equal(dom.host.writes, writesBefore, '输入事件不得触发重绘');

  // 面板回车：submit 事件委托到 data-enter 指向的动作
  dom.fire('submit', { target: { getAttribute: (n) => (n === 'data-enter' ? 'admin-refresh-accounts' : null) }, preventDefault: () => {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls[0].op, 'accounts', '回车应触发刷新账号列表');
  assert.equal(calls[0].adminToken, 'tok-1', '面板里填的令牌必须随请求带上（X-Admin-Token）');
  assert.equal(calls[0].bearerToken, 'tk', '同时带 Bearer（账号身份优先，服务端判定）');

  // 行按钮：data-player-id / data-public-id → payload → 二次确认态（不发请求）
  const before = calls.length;
  dom.fire('click', { target: { closest: () => fakeButton('admin-delete-account', { playerId: 'pl_row0001', publicId: 'u_row0001' }) } });
  assert.equal(calls.length, before, '删除按钮不得直接发请求');
  assert.deepEqual(app.store.getState().admin.confirm, { kind: 'delete', playerId: 'pl_row0001', publicId: 'u_row0001' });

  // 确认删除 → 真发 delete-account（playerId 来自确认态）→ 自动重拉当前页
  dom.fire('click', { target: { closest: () => fakeButton('confirm-yes') } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((c) => c.op), ['accounts', 'delete-account', 'accounts']);
  assert.deepEqual(calls[1].body, { playerId: 'pl_row0001' });
  assert.equal(app.store.getState().view, 'accounts', '删除后应回到账号列表屏');
  assert.equal(app.store.getState().admin.confirm, null);
});
