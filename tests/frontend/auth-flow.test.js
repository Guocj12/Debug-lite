'use strict';
/* tests/frontend/auth-flow.test.js —— F1 真实 HTTP 全流程（无头驱动**同一套**前端动作代码）
 *
 * 与浏览器完全同构：public/store.js + public/format.js + public/actions.js + public/api.js
 * （fetch 由 Node 内建提供，baseUrl 指向进程内起真实服务）。所以本文件证明的是"前端动作确实连上了后端"，
 * 而不只是"接口能用"。人工浏览器走查剧本见 docs/frontend/01-auth.md §11。
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../helpers/http.js');
const store = require('../../public/store.js');
const format = require('../../public/format.js');
const actions = require('../../public/actions.js');
const apiMod = require('../../public/api.js');
const appMod = require('../../public/app.js');

const PW1 = 'pw12345678';
const PW2 = 'pw87654321';

// 假 localStorage（与真实接口同形），用于验证 dl.token / dl.session 两个键的落盘与清除
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
  const api = {
    call: (...a) => { counter.n += 1; return raw.call(...a); },
    register: (...a) => { counter.n += 1; return raw.register(...a); },
    login: (...a) => { counter.n += 1; return raw.login(...a); },
    logout: (...a) => { counter.n += 1; return raw.logout(...a); },
    changePassword: (...a) => { counter.n += 1; return raw.changePassword(...a); },
    me: (...a) => { counter.n += 1; return raw.me(...a); },
  };
  const h = {
    win, storage, api, counter,
    state: () => st.getState(),
    dispatch: (a) => st.dispatch(a),
    set: (field, value) => st.dispatch({ type: 'form.set', field, value }),
    form: (values) => { for (const [k, v] of Object.entries(values)) st.dispatch({ type: 'form.set', field: k, value: v }); },
    run: (name) => {
      const ctx = { state: st.getState(), dispatch: (a) => st.dispatch(a), api, format, storage, actions: actions.ACTIONS };
      return Promise.resolve(actions.ACTIONS[name].run(ctx));
    },
  };
  return h;
}

function noticeOf(h) {
  const n = h.state().notice;
  return n ? n.text : '';
}

const LINES = (h) => format.homeLines(h.state());

async function withHarness(fn) {
  const s = await startServer({ prefix: 'dl-fe-flow-', level: 'warn' });
  try {
    return await fn(harness(s.baseUrl), s);
  } finally {
    await s.cleanup();
  }
}

test('FL-1 注册 → 主页（含首屏段位/积分）并落盘 dl.token / dl.session', async () => {
  await withHarness(async (h) => {
    h.form({ username: 'flow1', password: PW1, confirm: PW1 });
    await h.run('submit-register');
    assert.equal(h.state().view, 'home');
    assert.match(noticeOf(h), /^注册成功：/);
    assert.equal(h.state().session.publicId.indexOf('u_'), 0, '会话应含 publicId');
    const lines = LINES(h).join('\n');
    assert.match(lines, /段位：common/);
    assert.match(lines, /积分：0/);
    // localStorage：两个键（01-auth.md §7.3）
    assert.ok(h.win.map.get('dl.token'), 'dl.token 应已写入');
    const saved = JSON.parse(h.win.map.get('dl.session'));
    assert.equal(saved.publicId, h.state().session.publicId);
  });
});

test('FL-2 刷新档案 → /me 全量文本（配置槽/战绩/未读）', async () => {
  await withHarness(async (h) => {
    h.form({ username: 'flow2', password: PW1, confirm: PW1 });
    await h.run('submit-register');
    await h.run('refresh-profile');
    assert.equal(noticeOf(h), '档案已刷新');
    const lines = LINES(h).join('\n');
    assert.match(lines, /配置槽：/);
    assert.match(lines, /战绩·进攻：/);
    assert.match(lines, /战绩·防守：/);
    assert.match(lines, /未读：进攻 0 \/ 防守 0/);
    assert.match(lines, /匹配池：在池/);
    assert.match(lines, /仓库校验：/);
    assert.match(lines, /机器人账号：否/);
    assert.equal(h.state().profile !== null, true, 'profile 应为完整信封');
  });
});

test('FL-3 改密成功（含撤销其他会话数）+ 新密码可登录 + 旧密码失效', async () => {
  await withHarness(async (h) => {
    h.form({ username: 'flow3', password: PW1, confirm: PW1 });
    await h.run('submit-register');
    // 造出第二个会话，使 revokedOthers ≥ 1
    const second = await h.api.login({ username: 'flow3', password: PW1 });
    assert.equal(second.transport, 'response');
    await h.run('goto-password');
    assert.equal(h.state().view, 'password');
    h.form({ oldPassword: PW1, newPassword: PW2, newConfirm: PW2 });
    await h.run('submit-password');
    assert.match(noticeOf(h), /^改密成功：已撤销其他设备会话 \d+ 个$/);
    assert.equal(h.state().view, 'password', '改密成功应停留在设置密码屏');
    assert.equal(h.state().form.newPassword, '', '成功后应清空密码输入');
    const relogin = await h.api.login({ username: 'flow3', password: PW2 });
    assert.equal(format.isOk(relogin.envelope), true, '新密码应可登录');
    const old = await h.api.login({ username: 'flow3', password: PW1 });
    assert.equal(format.errorCodeOf(old.envelope), 'invalid_credentials', '旧密码应失效');
  });
});

test('FL-4 原密码错误 → 展示服务端文案（不改会话、不切屏）', async () => {
  await withHarness(async (h) => {
    h.form({ username: 'flow4', password: PW1, confirm: PW1 });
    await h.run('submit-register');
    await h.run('goto-password');
    h.form({ oldPassword: 'pw00000000', newPassword: PW2, newConfirm: PW2 });
    await h.run('submit-password');
    assert.equal(h.state().view, 'password');
    assert.match(noticeOf(h), /原密码错误/);
    assert.ok(h.state().session.token, '失败不应清会话');
  });
});

test('FL-5 登出 → 清本地凭据 + 切登录屏；随后任何动作按会话失效处理', async () => {
  await withHarness(async (h) => {
    h.form({ username: 'flow5', password: PW1, confirm: PW1 });
    await h.run('submit-register');
    assert.ok(h.win.map.get('dl.token'));
    await h.run('logout');
    assert.equal(h.state().view, 'login');
    assert.equal(noticeOf(h), '已登出');
    assert.equal(h.state().session.token, null);
    assert.equal(h.win.map.get('dl.token'), undefined, '登出应清 dl.token');
    assert.equal(h.win.map.get('dl.session'), undefined, '登出应清 dl.session');
    await h.run('refresh-profile');
    assert.equal(noticeOf(h), '会话已失效，请重新登录');
    assert.equal(h.state().view, 'login');
  });
});

test('FL-6 坏 token → /me 401 → 统一登出并清凭据', async () => {
  await withHarness(async (h) => {
    h.form({ username: 'flow6', password: PW1, confirm: PW1 });
    await h.run('submit-register');
    // 模拟本地凭据被篡改后刷新：写入坏 token，再走正常动作路径
    h.dispatch({ type: 'session.set', token: 'not-a-real-token', publicId: 'u_x', nickname: 'x', expiresAt: null });
    h.storage.saveSession({ token: 'not-a-real-token', publicId: 'u_x', nickname: 'x', expiresAt: null });
    await h.run('refresh-profile');
    assert.equal(h.state().view, 'login');
    assert.ok(noticeOf(h).indexOf('会话已失效，请重新登录') === 0, `实际文案：${noticeOf(h)}`);
    assert.equal(h.state().session.token, null, '会话失效应清内存会话');
    assert.equal(h.win.map.get('dl.token'), undefined, '会话失效应清 dl.token');
  });
});

test('FL-7 重名注册 → 409 服务端文案 + 附加指引', async () => {
  await withHarness(async (h) => {
    h.form({ username: 'flow7', password: PW1, confirm: PW1 });
    await h.run('submit-register');
    await h.run('logout');
    await h.run('goto-register');
    assert.equal(h.state().view, 'register');
    h.form({ username: 'FLOW7', password: PW1, confirm: PW1 });
    const before = h.counter.n;
    await h.run('submit-register');
    assert.equal(h.counter.n, before + 1, '重名不是客户端预校验能拦的，必须真的发请求');
    assert.equal(h.state().view, 'register', '失败应停留注册屏');
    const text = noticeOf(h);
    assert.match(text, /换个用户名试试/);
    assert.match(text, /用户名已被占用/);
    assert.match(text, /字段：username/);
  });
});

test('FL-8 服务端弱密码信封 → 投影文案含规则前缀与服务端原文', async () => {
  await withHarness(async (h) => {
    const r = await h.api.register({ username: 'flow8', password: 'short' });
    assert.equal(r.transport, 'response');
    assert.equal(format.errorCodeOf(r.envelope), 'weak_password');
    const text = format.noticeText(r.envelope);
    assert.match(text, /^密码需 8~72 字符：/);
    assert.match(text, /密码长度需 8~72 字符/);
    assert.match(text, /字段：password/);
  });
});

test('FL-9 客户端预校验不发请求（计数不变）', async () => {
  await withHarness(async (h) => {
    const before = h.counter.n;
    h.form({ username: '', password: '' });
    await h.run('submit-login');
    assert.equal(h.counter.n, before, '空输入不得发请求');
    assert.equal(noticeOf(h), '请填写用户名与密码');
    h.form({ username: 'alice', password: PW1, confirm: 'mismatch' });
    await h.run('submit-register');
    assert.equal(h.counter.n, before, '两次密码不一致不得发请求');
    assert.equal(noticeOf(h), '两次输入的密码不一致');
  });
});

test('FL-10 服务未启动 → 可见网络失败文案且保留表单', async () => {
  const s = await startServer({ prefix: 'dl-fe-flow-net-', level: 'warn' });
  const h = harness(s.baseUrl);
  await s.close(); // 端口关闭：模拟服务未启动
  h.form({ username: 'flow10', password: PW1, confirm: PW1 });
  await h.run('submit-register');
  assert.match(noticeOf(h), /^无法连接服务器：/);
  assert.equal(h.state().form.username, 'flow10', '网络失败应保留已填表单');
  assert.equal(h.state().view, 'login');
});

test('FL-11 提交中（busy）重复点击不再发请求', async () => {
  await withHarness(async (h) => {
    h.form({ username: 'flow11', password: PW1, confirm: PW1 });
    const before = h.counter.n;
    const first = h.run('submit-register');
    const second = h.run('submit-register'); // busy 期间的第二击
    await Promise.all([first, second]);
    assert.equal(h.counter.n, before + 1, 'busy 期间不得重复发请求');
    assert.equal(h.state().view, 'home');
    assert.match(noticeOf(h), /^注册成功：/);
  });
});
