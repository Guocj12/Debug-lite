'use strict';
/* tests/frontend/hub-warehouse-flow.test.js —— F3 提交②（主界面线）真实 HTTP 全流程 + 机器核对
 *
 * 权威：docs/frontend/03-hub-warehouse-loadout.md §3/§4/§5/§6/§8/§10（UW-1…UW-11）。
 * 与浏览器完全同构：public/{store,format,render,actions,api,app}.js（fetch 由 Node 内建提供，
 *   baseUrl 指向**进程内起真实服务**）—— 证明"前端动作确实连上了后端"，不只是"接口能用"。
 *
 * 覆盖：
 *   WH-1  hub 摘要只读 GET /me（真实响应字段可追溯）+ 11 键 + 刷新
 *   WH-2  四个空页（标题 + 尚未实现（计划批次 F#）+ 返回键；不发请求）
 *   WH-3  仓库（容量行 / 四桶切换 / 行内名字 + [装配于配置N] / 详情弹窗 / 点背景关闭 / 空态）
 *   WH-4  开箱成功（真实 HTTP；**请求体只有 times、不传 seed**；结果区**不显示 seed**；回仓库可见新物品）
 *   WH-5  开箱次数越界（0/101/1.5/abc/空）→ 客户端拦下、不发请求（B-3）
 *   WH-6  某桶已达上限 → 按钮禁用 + 文案 + 不发请求（B-2；服务端 409 见 UBX-4/UWH-5）
 *   WH-7  设置（改昵称成功/客户端拦截、修改密码入口、登出**只在此屏**）
 *   WH-8  弹窗机制（UW-5：至多一个 / 必有 modal-close / 切屏即清 / 丢弃未提交输入）
 *   WH-9  DOM 装配层（假 DOM：data-uid → 弹窗、背景点击 → 关闭、开箱输入与回车）
 *   WH-10 失败路径落到可见提示（会话失效 / 网络失败）
 *   WH-11 物品详情字段三方一致（contract == 03 §5.1+§5.3 == format.js 实读）+ 真实响应可解析
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, playerIdByPublicId } = require('../helpers/http.js');
const store = require('../../public/store.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const actions = require('../../public/actions.js');
const apiMod = require('../../public/api.js');
const appMod = require('../../public/app.js');
const contract = require('../../public/contract.js');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO, 'public');
const PW1 = 'pw12345678';
const DOC3 = path.join(REPO, 'docs', 'frontend', '03-hub-warehouse-loadout.md');

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

// 与 public/app.js 的 buildCtx/run 同形；api 出口逐个计数并记录请求体（用于"不传 seed"断言）
function harness(baseUrl) {
  const win = fakeWin();
  const st = store.createStore(store.initialState());
  const storage = appMod.createStorage(win);
  const raw = apiMod.createApi({ baseUrl });
  const counter = { n: 0 };
  const boxCalls = [];
  const boxEnvelopes = [];
  const counting = (fn) => (...a) => { counter.n += 1; return fn(...a); };
  const api = {
    call: counting(raw.call),
    register: counting(raw.register),
    login: counting(raw.login),
    logout: counting(raw.logout),
    changePassword: counting(raw.changePassword),
    me: counting(raw.me),
    warehouse: counting(raw.warehouse),
    configs: counting(raw.configs),
    aiList: counting(raw.aiList),
    setNickname: counting(raw.setNickname),
    admin: counting(raw.admin),
    box: (token, input) => {
      counter.n += 1;
      boxCalls.push(input);
      return raw.box(token, input).then((r) => { boxEnvelopes.push(r.envelope); return r; });
    },
  };
  const h = {
    win, storage, api, counter, boxCalls, boxEnvelopes,
    state: () => st.getState(),
    dispatch: (a) => st.dispatch(a),
    html: () => render.render(format.viewModel(st.getState())),
    notice: () => (st.getState().notice ? st.getState().notice.text : ''),
    form: (values) => { for (const [k, v] of Object.entries(values)) st.dispatch({ type: 'form.set', field: k, value: v }); },
    times: (value) => st.dispatch({ type: 'screen.form.set', field: 'boxTimes', value }),
    nickname: (value) => st.dispatch({ type: 'screen.form.set', field: 'settingsNickname', value }),
    run: (name, payload) => {
      const ctx = { state: st.getState(), dispatch: (a) => st.dispatch(a), api, format, storage, actions: actions.ACTIONS };
      return Promise.resolve(actions.ACTIONS[name].run(ctx, payload || null));
    },
    // 注册一个真实账号（走真实动作；落点 = hub，并自动取一次 /me）
    signUp: async (username) => {
      h.form({ username, password: PW1, confirm: PW1 });
      await h.run('submit-register');
      assert.equal(h.state().view, 'hub', '注册后应落在主界面（FR-11）');
      assert.ok(h.state().profile, '落地后应已自动取到 /me');
      return h.state().profile;
    },
  };
  return h;
}

async function withHarness(fn) {
  const s = await startServer({ prefix: 'dl-fe-hub-', level: 'warn' });
  try {
    return await fn(harness(s.baseUrl), s);
  } finally {
    await s.cleanup();
  }
}

const buttonLabels = (html) => [...html.matchAll(/>([^<>]+)<\/button>/g)].map((m) => m[1]);

/* ---------- WH-1：主界面（hub） ---------- */

test('WH-1 主界面：摘要只读 GET /me（可追溯）＋ 11 个按钮 ＋ 刷新', async () => {
  await withHarness(async (h) => {
    const me = await h.signUp('wh1user');
    const html = h.html();
    // 摘要行 = `昵称 · 段位 · 积分 · 未读 进攻a/防守d · 在池`（03 §3.1 / §11 步 2）
    const expected = me.data.nickname + ' · ' + me.data.progress.tier + ' · ' + me.data.rating.points
      + ' · 未读 进攻' + me.data.record.unread.attack + '/防守' + me.data.record.unread.defense
      + ' · ' + (me.data.pool.inPool === true ? '在池' : '不在池');
    assert.equal(format.hubSummary(h.state()), expected, '摘要行必须逐字由 GET /me 的字段拼出');
    assert.ok(html.includes(expected), '摘要行必须渲染到屏幕上');
    // 摘要没有第二个数据源：清掉 profile 后立刻变成"尚未读取"占位
    h.dispatch({ type: 'profile.set', envelope: null });
    assert.match(format.hubSummary(h.state()), /尚未读取到档案数据/);
    h.dispatch({ type: 'profile.set', envelope: me });

    // 11 个按钮 + 刷新（03 §3.1）
    const labels = buttonLabels(html);
    for (const label of ['用户', '仓库', '开箱', '快速对战', '锦标赛', '排行榜',
      '出战配置1', '出战配置2', '出战配置3', 'AI编辑', '设置', '刷新']) {
      assert.ok(labels.includes(label), `主界面缺少按钮：${label}（实际 ${labels.join('/')}）`);
    }
    assert.equal(labels.filter((l) => l === '刷新').length, 1, '主界面只应有一个「刷新」');

    // 刷新：重取 GET /me（摘要随之更新）
    const before = h.counter.n;
    await h.run('refresh-hub');
    assert.equal(h.counter.n, before + 1, '刷新应重取一次 GET /me');
    assert.equal(h.notice(), format.REFRESH_OK_TEXT);
    // 用户 → 用户详情；返回主界面
    await h.run('goto-profile');
    assert.equal(h.state().view, 'profile');
    await h.run('goto-hub');
    assert.equal(h.state().view, 'hub');
  });
});

/* ---------- WH-2：四个空页 ---------- */

test('WH-2 四个空页：标题 + 尚未实现（计划批次 F#）+ 返回主界面；不发任何请求', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh2user');
    const pages = [
      ['goto-quick', '快速对战', 'F6'],
      ['goto-tournament', '锦标赛', 'F7'],
      ['goto-leaderboard', '排行榜', 'F7'],
      ['goto-ai-editor', 'AI 编辑', 'F5'],
    ];
    for (const [action, title, batch] of pages) {
      const before = h.counter.n;
      await h.run(action);
      assert.equal(h.counter.n, before, `${action} 不得发任何请求（FR-12）`);
      const html = h.html();
      assert.ok(html.includes(title), `${action} 缺少标题 ${title}`);
      assert.ok(html.includes('尚未实现（计划批次 ' + batch + '）'), `${action} 缺少计划批次行`);
      assert.equal(buttonLabels(html).length, 1, `${action} 只应有一个按钮（返回主界面）`);
      assert.deepEqual(buttonLabels(html), ['返回主界面']);
      await h.run('goto-hub');
      assert.equal(h.state().view, 'hub', '空页的返回键必须能回到主界面（B-13）');
    }
  });
});

/* ---------- WH-3：仓库 ---------- */

test('WH-3 仓库：容量行 / 四桶切换（本地）/ 行内名字 + [装配于配置1] / 详情弹窗与背景关闭', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh3user');
    await h.run('goto-warehouse');
    assert.equal(h.state().view, 'warehouse');
    const wr = h.state().warehouse.envelope;
    assert.ok(wr, '仓库屏应已取到 GET /me/warehouse');

    // 容量行：`角色 n/500 · 技能 n/500 · 角色插件 n/500 · 技能插件 n/500`（03 §3.3）
    const capacity = format.warehouseCapacityText(wr);
    assert.match(capacity, /^角色 \d+\/500 · 技能 \d+\/500 · 角色插件 \d+\/500 · 技能插件 \d+\/500$/, capacity);
    assert.ok(h.html().includes(capacity), '容量行必须渲染到屏幕上');
    for (const label of ['角色', '技能', '角色插件', '技能插件', '刷新', '返回主界面']) {
      assert.ok(buttonLabels(h.html()).includes(label), `仓库缺少分桶/动作按钮：${label}`);
    }

    // 行内**只显示物品名字**（+ [装配于配置N]）：starter 的角色被 slot1 引用
    const roleItem = format.bucketItems(wr, 'role')[0];
    assert.ok(roleItem, 'starter 应至少有 1 个角色');
    assert.ok(wr.data.usage[roleItem.uid].slotIds.includes('slot1'), 'starter 的角色应被 slot1 引用');
    assert.ok(h.html().includes('data-uid="' + roleItem.uid + '"'), '物品行应携带 data-uid');
    assert.ok(h.html().includes(roleItem.name + ' [装配于配置1]'), '行内应显示名字 + 装配标记');

    // 切桶 = 纯本地（不发请求），容量行不变
    const bucketBefore = h.counter.n;
    await h.run('warehouse-bucket', { bucket: 'skillPlugin' });
    assert.equal(h.counter.n, bucketBefore, '分桶切换不得发请求');
    assert.equal(h.state().warehouseBucket, 'skillPlugin');
    const pluginItem = format.bucketItems(wr, 'skillPlugin')[0];
    assert.ok(h.html().includes(pluginItem.name), '切换后应显示该桶的物品名');
    assert.ok(h.html().includes(capacity), '切桶后容量行不变');

    // 点物品行 → 屏内弹窗（03 §3.3/§5.3）
    await h.run('item-open', { uid: roleItem.uid });
    assert.deepEqual(h.state().modal, { kind: 'item-detail', uid: roleItem.uid });
    const modalHtml = h.html();
    assert.ok(modalHtml.includes('id="modal"'), '详情应是屏内区块（不是浏览器原生弹窗）');
    assert.ok(modalHtml.includes('data-action="modal-close"'), '弹窗必须有承担外部点击的背景元素');
    for (const line of format.itemDetailLines(wr, roleItem)) {
      assert.ok(modalHtml.includes(line), `详情弹窗缺少字段行：${line}`);
    }
    // 点背景（=modal-close）→ 关闭并回到仓库列表
    await h.run('modal-close');
    assert.equal(h.state().modal, null);
    assert.ok(!h.html().includes('id="modal"'), '关闭后不应再渲染弹窗');

    // 空仓库态（B-1）：形状取自真实响应的空桶（纯投影，不需要第二份夹具）
    const emptyEnv = JSON.parse(JSON.stringify(wr));
    emptyEnv.data.buckets.skill = [];
    emptyEnv.data.usage = {};
    const emptyState = store.initialState();
    emptyState.view = 'warehouse';
    emptyState.warehouseBucket = 'skill';
    emptyState.warehouse.envelope = emptyEnv;
    const emptyHtml = render.render(format.viewModel(emptyState));
    assert.ok(emptyHtml.includes(format.EMPTY_WAREHOUSE_TEXT), '空桶应显示空态文案');
  });
});

/* ---------- WH-4 / WH-5 / WH-6：开箱 ---------- */

test('WH-4 开箱：进入屏取一次仓库；times=5 逐件行；请求体无 seed；不显示 seed；成功后仓库状态已刷新', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh4user');
    await h.run('goto-warehouse');
    const countBefore = format.BUCKET_ORDER
      .reduce((sum, b) => sum + format.bucketItems(h.state().warehouse.envelope, b).length, 0);

    const enterBefore = h.counter.n;
    await h.run('goto-box');
    // 03 §3.4：进入开箱屏取**一次**仓库真源（"满仓 → 按钮禁用且不发请求"的前提），且不打扰用户
    assert.equal(h.counter.n, enterBefore + 1, '进入开箱屏应恰好取一次 GET /me/warehouse');
    assert.equal(h.notice(), '', '进入开箱屏的成功取数是静默的（失败才可见）');
    h.times('5');
    assert.equal(h.state().box.times, '5', '开箱次数应进 state.box.times（受控输入）');
    const reqBefore = h.counter.n;
    await h.run('box-open');
    // 开箱 1 次 + 成功后的静默仓库刷新 1 次
    assert.equal(h.counter.n, reqBefore + 2, '开箱 = POST /me/box(1) + 静默刷新仓库(1)');
    // D-162：请求体**只有 times**（不含 seed）
    assert.deepEqual(h.boxCalls, [{ times: 5 }], `开箱请求体：${JSON.stringify(h.boxCalls)}`);
    const env = h.boxEnvelopes[0];
    assert.equal(env.ok, true);

    // 结果区：`本次获得 5 件：` + 逐件 `<名字>（<分类>·<品质>）`（03 §3.4）
    const lines = h.state().box.result.lines;
    assert.equal(lines[0], '本次获得 5 件：');
    assert.equal(lines.length, 6, `times=5 应回 5 件：${lines.length - 1}`);
    for (const line of lines.slice(1)) {
      assert.match(line, /^.+（(角色|技能|角色插件|技能插件)·.+）$/, `逐件行：${line}`);
    }
    const html = h.html();
    for (const line of lines) assert.ok(html.includes(line), `结果区缺少行：${line}`);
    // seed 是服务端审计量：不传（上面已断言）**也不显示**（03 §3.4）
    assert.ok(typeof env.data.seed === 'number', '服务端应回带 seed（仅审计）');
    assert.ok(!html.includes(String(env.data.seed)), '开箱屏不得显示 seed');
    assert.ok(!html.includes('种子'), '开箱屏不得出现"种子"字样');

    // 成功后**本地仓库状态已刷新**（连续开箱时"满仓立刻禁用"才成立）
    const countNow = format.BUCKET_ORDER
      .reduce((sum, b) => sum + format.bucketItems(h.state().warehouse.envelope, b).length, 0);
    assert.equal(countNow, countBefore + 5, '开箱成功后 state.warehouse 应已更新（+5）');

    // 回仓库（真实走查步 7）→ 新物品可见，总数仍是 +5（不重复计数）
    const backBefore = h.counter.n;
    await h.run('goto-warehouse');
    assert.equal(h.counter.n, backBefore + 1, '再取一次仓库真源（goto-warehouse）');
    const countAfter = format.BUCKET_ORDER
      .reduce((sum, b) => sum + format.bucketItems(h.state().warehouse.envelope, b).length, 0);
    assert.equal(countAfter, countBefore + 5, `开箱 5 件后仓库总数应 +5（${format.warehouseCapacityText(h.state().warehouse.envelope)}）`);
  });
});

test('WH-5 开箱次数越界（0/101/1.5/abc/空）→ 客户端拦下、不发请求（B-3）', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh5user');
    const enterBefore = h.counter.n;
    await h.run('goto-box');
    assert.equal(h.counter.n, enterBefore + 1, '进入开箱屏取一次仓库真源（03 §3.4）');
    // 输入框名字必须与 app.js 的路由表（store.SCREEN_FIELDS）逐字一致，否则输入永远进不了状态
    assert.equal(format.viewModel(h.state()).fields[0].name, store.BOX_TIMES_FIELD);
    assert.ok(store.SCREEN_FIELDS.includes(store.BOX_TIMES_FIELD));
    for (const value of ['0', '101', '1.5', 'abc', '', '-1', '1e2', '  ']) {
      h.times(value);
      const before = h.counter.n;
      await h.run('box-open');
      assert.equal(h.counter.n, before, `次数 ${JSON.stringify(value)} 不得发请求`);
      assert.equal(h.notice(), format.BOX_TIMES_RANGE_TEXT, `次数 ${JSON.stringify(value)} 的文案`);
      assert.equal(h.state().box.result, null, '越界不得产生结果区');
    }
    // 边界内可用：1 与 100 都能过客户端预校验（真发请求：开箱 1 次 + 成功后静默刷新仓库 1 次）
    for (const value of ['1', '100']) {
      h.times(value);
      const before = h.counter.n;
      await h.run('box-open');
      assert.equal(h.counter.n, before + 2, `次数 ${value} 应发请求（box + 静默刷新仓库）`);
      assert.match(h.state().box.result.lines[0], new RegExp('^本次获得 ' + value + ' 件：$'));
    }
  });
});

test('WH-6 满仓：进入开箱屏即取仓 → 按钮禁用 → 零 POST /me/box；未读/读取失败时由服务端 409 兜底（B-2）', async () => {
  await withHarness(async (h, s) => {
    const me = await h.signUp('wh6user');
    // 把四桶灌满到 500（与 tests/api/api-me-box.test.js UBX-4 同法；走 store 门面，不打补丁）
    const playerId = await playerIdByPublicId(s.store, me.data.publicId);
    assert.ok(playerId, '应能用 publicId 反查到 playerId');
    await s.store.updateArchive(playerId, (archive) => {
      const mk = (bucket, n) => ({ uid: bucket + '_fill_' + n, kind: bucket, name: 'filler', quality: 'common', tier: 1, affixes: [], slots: [] });
      for (const bucket of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
        const list = archive.warehouse.buckets[bucket];
        while (list.length < 500) list.push(mk(bucket, list.length));
      }
      return null;
    });

    // ① 进入开箱屏即取仓 → 本地判定满仓 → 按钮禁用 + 精确文案 + **零** POST /me/box（03 §3.4）
    const enterBefore = h.counter.n;
    await h.run('goto-box');
    assert.equal(h.counter.n, enterBefore + 1, '进入开箱屏应恰好取一次 GET /me/warehouse');
    const wr = h.state().warehouse.envelope;
    assert.equal(format.bucketItems(wr, 'role').length, 500, '仓库真源应显示该桶 500 件');
    const text = '仓库已满（角色 500/500），请先清理';
    assert.equal(format.boxFullNotice(h.state()), text);
    assert.ok(h.html().includes(text), '已满提示必须渲染到屏幕上');
    assert.ok(h.html().includes('data-action="box-open" disabled'), '已满时开箱按钮必须禁用');
    const before = h.counter.n;
    h.times('1');
    await h.run('box-open');
    assert.equal(h.counter.n, before, '已满时一个请求都不许发');
    assert.deepEqual(h.boxCalls, [], '已满时不得发 POST /me/box');
    assert.equal(h.notice(), text, '被拦下时也要有可见文案（按钮永不无声）');
    // 仓库屏的容量行同样显示 500/500（两屏共用同一份 warehouse 状态）
    await h.run('goto-warehouse');
    assert.ok(h.html().includes('角色 500/500 · 技能 500/500'), '仓库屏容量行也应显示满仓');

    // ② 未读到仓库（人为清空信封）→ 不做本地预判、按钮可用、真问服务端 → 409 落到可见提示（03 §6）
    await h.run('goto-hub');
    h.dispatch({ type: 'warehouse.set', envelope: null });
    h.dispatch({ type: 'view.go', view: 'box' });   // 直接构造"没有信封"的开箱屏（模拟取数尚未回来）
    assert.equal(format.boxFullNotice(h.state()), null, '没有仓库信封时不做本地预判');
    assert.ok(!h.html().includes('data-action="box-open" disabled'), '未读仓库时按钮不应禁用');
    h.times('1');
    const before2 = h.counter.n;
    const boxBefore = h.boxCalls.length;
    await h.run('box-open');
    assert.equal(h.counter.n, before2 + 1, '未读仓库时必须真的问服务端（409 后不再刷新仓库）');
    assert.equal(h.boxCalls.length, boxBefore + 1, '应真的发了 POST /me/box');
    assert.match(h.notice(), /仓库已满/, `409 文案必须可读：${h.notice()}`);
    assert.ok(h.html().includes('仓库已满'), '409 文案必须渲染到屏幕上');
  });

  // ③ 仓库**读取失败**（服务未启动）→ 不影响进入开箱屏：按钮保持可用、失败文案可见、由服务端兜底
  const s2 = await startServer({ prefix: 'dl-fe-hub-boxfail-', level: 'warn' });
  const h2 = harness(s2.baseUrl);
  try {
    await h2.signUp('wh6fail');
    await s2.close();
    await h2.run('goto-box');
    assert.equal(h2.state().view, 'box', '取仓失败不得把用户挡在屏外');
    assert.match(h2.notice(), /^无法连接服务器：/, `取仓失败的文案必须可见：${h2.notice()}`);
    assert.ok(!h2.html().includes('data-action="box-open" disabled'), '读取失败时按钮必须仍可用（靠服务端兜底）');
    h2.times('1');
    await h2.run('box-open');
    assert.match(h2.notice(), /^无法连接服务器：/, '随后开箱失败同样可见');
  } finally {
    await s2.cleanup();
  }
});

/* ---------- WH-7：设置 ---------- */

test('WH-7 设置：改昵称成功/客户端拦截；修改密码入口；登出只在此屏', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh7user');
    await h.run('goto-settings');
    assert.equal(h.state().view, 'settings');
    const vm = format.viewModel(h.state());
    assert.equal(vm.fields[0].name, 'settingsNickname', '设置屏的新昵称输入框');
    // 与 app.js 的输入路由表（store.SCREEN_FIELDS）逐字一致（防止"输入框改名但路由没改"）
    assert.equal(vm.fields[0].name, store.NICKNAME_FIELD);
    assert.ok(store.SCREEN_FIELDS.includes(store.NICKNAME_FIELD));

    // 客户端拦截：空 / 超过 16 字符 → 不发请求
    for (const bad of ['', '   ', 'x'.repeat(17)]) {
      h.nickname(bad);
      const before = h.counter.n;
      await h.run('settings-nickname-save');
      assert.equal(h.counter.n, before, `昵称 ${JSON.stringify(bad)} 不得发请求`);
      assert.equal(h.notice(), format.NICKNAME_MAX_TEXT);
    }

    // 成功：PUT /me/nickname → `昵称已更新为 <n>`；主界面摘要同步
    h.nickname('  新昵称A  ');   // 首尾空白应被 trim
    const before = h.counter.n;
    await h.run('settings-nickname-save');
    assert.equal(h.counter.n, before + 2, '改名一次 + 静默重取一次 /me（摘要同步）');
    assert.equal(h.notice(), '昵称已更新为 新昵称A');
    assert.equal(h.state().settings.nickname, '', '成功后应清空输入框');
    assert.equal(h.state().session.nickname, '新昵称A', '本地会话昵称应同步');
    await h.run('goto-hub');
    assert.ok(h.html().includes('新昵称A · '), '主界面摘要应显示新昵称');

    // 修改密码 → F1 的 password 屏（两个返回入口，§4）
    await h.run('goto-settings');
    await h.run('goto-password');
    assert.equal(h.state().view, 'password');
    const pwdLabels = buttonLabels(h.html());
    assert.ok(pwdLabels.includes('返回用户详情') && pwdLabels.includes('返回设置'), `密码屏返回入口：${pwdLabels.join('/')}`);

    // 登出：设置屏是唯一入口（profile 屏不得有）
    await h.run('goto-hub');
    await h.run('goto-profile');
    assert.ok(!h.html().includes('data-action="logout"'), '用户详情屏不得有登出按钮（FR-11）');
    await h.run('goto-settings');
    assert.ok(h.html().includes('data-action="logout"'), '设置屏应有登出按钮');
    await h.run('logout');
    assert.equal(h.state().view, 'login');
    assert.equal(h.notice(), '已登出');
    assert.equal(h.win.map.get('dl.token'), undefined, '登出应清 dl.token');
    // F3：登出后仓库/开箱等用户态数据不得残留
    assert.equal(h.state().warehouse.envelope, null, '登出应清仓库数据（不残留上个账号的内容）');
    assert.equal(h.state().box.result, null);
  });
});

/* ---------- WH-8：弹窗机制（UW-5） ---------- */

test('WH-8 弹窗机制：至多一个 / 必有 modal-close / 切屏即清 / 丢弃未提交输入', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh8user');
    await h.run('goto-warehouse');
    const item = format.bucketItems(h.state().warehouse.envelope, 'role')[0];

    // 打开 → 只有一个弹窗，且背景元素存在
    await h.run('item-open', { uid: item.uid });
    assert.equal(h.state().modal.kind, 'item-detail');
    assert.equal((h.html().match(/id="modal"/g) || []).length, 1, '同一时刻至多一个弹窗');
    // 打开另一个弹窗即替换旧的（03 §3.8）
    await h.run('config-open', { slot: 'slot2' });
    assert.deepEqual(h.state().modal, { kind: 'config', slotId: 'slot2' });
    assert.equal((h.html().match(/id="modal"/g) || []).length, 1, '替换后仍只有一个弹窗');
    // 提交③：占位弹窗已换成真编辑器 —— 状态行含 slotId，草稿已从服务端副本灌入
    assert.ok(h.html().includes('出战配置2：'), '编辑器状态行必须含 slotId');
    assert.ok(h.html().includes(format.CONFIG_DRAFT_HINT), '编辑器应提示"编辑先落在本地草稿"');
    assert.ok(h.state().configs.draft, '打开配置弹窗应灌入本地草稿');
    assert.ok(h.html().includes('data-action="modal-close"'), '弹窗必须有背景关闭元素');
    // 缺省 slot（无 payload）→ slot1
    await h.run('config-open');
    assert.deepEqual(h.state().modal, { kind: 'config', slotId: 'slot1' });

    // 任何含弹窗的屏都必须渲染 modal-close
    for (const view of ['hub', 'profile', 'warehouse', 'box', 'settings']) {
      const state = store.initialState();
      state.view = view;
      state.modal = { kind: 'config', slotId: 'slot1' };
      state.warehouse.envelope = h.state().warehouse.envelope;
      const html = render.render(format.viewModel(state));
      assert.ok(html.includes('data-action="modal-close"'), `${view} 屏的弹窗缺少背景元素`);
    }
    // 打开物品详情（真实 uid）后，仓库屏也要有背景元素
    h.dispatch({ type: 'modal.set', modal: { kind: 'item-detail', uid: item.uid } });
    assert.ok(h.html().includes('data-action="modal-close"'));

    // 切屏即清弹窗（modal 不跨屏存活）
    await h.run('goto-box');
    assert.equal(h.state().modal, null, '切屏应清弹窗');
    // 关闭：丢弃未提交输入（提交③ 起弹窗内有**本地草稿** → 关闭必须一并丢弃）
    h.dispatch({ type: 'configs.draft.set', draft: { slotId: 'slot1', loadout: { role: null, skills: [null, null, null], ai: null } }, dirty: true });
    h.dispatch({ type: 'modal.set', modal: { kind: 'config', slotId: 'slot1' } });
    assert.equal(h.state().configs.dirty, true, '前置：草稿处于未保存态');
    await h.run('modal-close');
    assert.equal(h.state().modal, null);
    assert.equal(h.state().configs.draft, null, '关闭弹窗必须丢弃未提交草稿');
    assert.equal(h.state().configs.dirty, false, '丢弃草稿后脏标记必须归零');

    // 纯 reducer 守卫：未知弹窗种类不得进状态（防止"半个弹窗"渲染）
    const st2 = store.createStore(store.initialState());
    st2.dispatch({ type: 'modal.set', modal: { kind: 'unknown-kind' } });
    assert.equal(st2.getState().modal, null);
    assert.equal(st2.dispatch({ type: 'modal.close' }), st2.getState(), '无弹窗时关闭是幂等的');
  });
});

/* ---------- WH-9：DOM 装配层（手写假 DOM，零依赖；不用 jsdom） ---------- */

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

test('WH-9 DOM 装配层：data-uid → 弹窗、背景点击 → 关闭、开箱输入与回车提交', async () => {
  const dom = fakeDom();
  const calls = [];
  const fakeApi = {
    me: () => Promise.resolve({ transport: 'error', message: '本用例不发 /me' }),
    box: (token, input) => {
      calls.push({ op: 'box', token, input });
      return Promise.resolve({
        transport: 'response', status: 200,
        envelope: { ok: true, data: { seed: 424242, tier: 'common', times: 3, items: [{ uid: 'item_9', kind: 'role', name: '均衡', quality: 'common' }] } },
      });
    },
  };
  const map = new Map();
  const win = { localStorage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) } };
  const app = appMod.createApp({ doc: dom.doc, win, DL: { store, format, render, actions }, api: fakeApi });
  await app.start();
  assert.ok(dom.host.innerHTML.includes('登录'), '无会话时应渲染登录屏');

  // 造出"已登录 + 仓库已取到"的状态（形状来自真实响应）
  const me = { ok: true, data: { publicId: 'u_x', nickname: '甲', progress: { tier: 'common' }, rating: { points: 0 }, record: { unread: { attack: 0, defense: 0 } }, pool: { inPool: true }, flags: { isAdmin: false } } };
  const warehouse = {
    ok: true,
    data: {
      buckets: { role: [{ uid: 'item_0', kind: 'role', name: '均衡', quality: 'common', slotCount: 0, slots: [], stats: {}, regen: {}, pluginPoints: 0, templateId: 'role_bal' }], skill: [], rolePlugin: [], skillPlugin: [] },
      usage: { item_0: { slotIds: ['slot1'] } },
      caps: { role: 500, skill: 500, rolePlugin: 500, skillPlugin: 500 },
      counts: { role: 1, skill: 0, rolePlugin: 0, skillPlugin: 0 },
    },
  };
  app.dispatch({ type: 'session.set', token: 'tk', publicId: 'u_x', nickname: '甲', expiresAt: null, isAdmin: false });
  app.dispatch({ type: 'profile.set', envelope: me });
  app.dispatch({ type: 'warehouse.set', envelope: warehouse });
  app.dispatch({ type: 'view.go', view: 'warehouse' });
  assert.ok(dom.host.innerHTML.includes('均衡'), '仓库屏应列出物品名');

  // 物品行（data-uid）→ item-open → 屏内弹窗
  dom.fire('click', { target: { closest: () => fakeButton('item-open', { uid: 'item_0' }) } });
  assert.deepEqual(app.store.getState().modal, { kind: 'item-detail', uid: 'item_0' });
  assert.ok(dom.host.innerHTML.includes('id="modal"'));
  assert.ok(dom.host.innerHTML.includes('物品详情'));

  // 点弹窗背景（data-action=modal-close）→ 关闭
  dom.fire('click', { target: { closest: () => fakeButton('modal-close') } });
  assert.equal(app.store.getState().modal, null);
  assert.ok(!dom.host.innerHTML.includes('id="modal"'));

  // 开箱屏：进入屏走 goto-box（会静默取一次仓库），输入框走 screen.form.set（不重绘），回车提交走 box-open
  fakeApi.warehouse = () => {
    calls.push({ op: 'warehouse' });
    return Promise.resolve({ transport: 'error', message: '本用例不校验仓库取数结果' });
  };
  await app.run('goto-box');
  assert.equal(app.store.getState().view, 'box');
  assert.deepEqual(calls[calls.length - 1], { op: 'warehouse' }, '进入开箱屏应先取一次仓库真源');
  const writesBefore = dom.host.writes;
  dom.fire('input', { target: { name: 'boxTimes', value: '3' } });
  assert.equal(app.store.getState().box.times, '3', '开箱次数应进 state.box.times');
  assert.equal(dom.host.writes, writesBefore, '输入事件不得触发重绘');
  dom.fire('submit', { target: { getAttribute: (n) => (n === 'data-enter' ? 'box-open' : null) }, preventDefault: () => {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((c) => c.op === 'box'), [{ op: 'box', token: 'tk', input: { times: 3 } }], '回车应触发开箱，且请求体只有 times');
  assert.equal(app.store.getState().box.result.lines[0], '本次获得 3 件：');
  const finalHtml = dom.host.innerHTML;
  assert.ok(!finalHtml.includes('424242'), '开箱屏不得显示响应里的 seed');
  // 设置屏输入框：另一个 screen 字段
  app.dispatch({ type: 'view.go', view: 'settings' });
  dom.fire('input', { target: { name: 'settingsNickname', value: '乙' } });
  assert.equal(app.store.getState().settings.nickname, '乙');
});

/* ---------- WH-10：失败路径 ---------- */

test('WH-10 失败路径落在可见提示：会话失效（仓库/开箱）与网络失败', async () => {
  // ① 坏 token → 仓库真源 401 → 统一登出 + 文案（03 §6 unauthorized 行）
  await withHarness(async (h) => {
    await h.signUp('wh10a');
    h.dispatch({ type: 'session.set', token: 'not-a-real-token', publicId: h.state().session.publicId, nickname: 'x', expiresAt: null, isAdmin: false });
    await h.run('refresh-warehouse');
    assert.equal(h.state().view, 'login', '会话失效应切回登录屏');
    assert.ok(h.notice().indexOf('会话已失效，请重新登录') === 0, `实际文案：${h.notice()}`);
    assert.equal(h.state().warehouse.envelope, null, '会话失效应清仓库数据');
  });

  // ② 服务未启动 → 仓库/开箱都是可见网络失败文案（不是静默失败）
  const s = await startServer({ prefix: 'dl-fe-hub-net-', level: 'warn' });
  const h = harness(s.baseUrl);
  try {
    await h.signUp('wh10b');
    await s.close();
    await h.run('goto-warehouse');
    assert.equal(h.state().view, 'warehouse');
    assert.match(h.notice(), /^无法连接服务器：/, `网络失败文案：${h.notice()}`);
    h.dispatch({ type: 'view.go', view: 'box' });
    h.times('1');
    await h.run('box-open');
    assert.match(h.notice(), /^无法连接服务器：/, '开箱的网络失败同样必须可见');
  } finally {
    await s.cleanup();
  }
});

/* ---------- WH-12：启动自检的落点 ---------- */

test('WH-12 启动自检（本地 token）：校验通过 → 主界面 hub；401 → 清凭据回登录屏', async () => {
  const meEnv = {
    ok: true,
    data: {
      publicId: 'u_boot', nickname: '启动', progress: { tier: 'common' }, rating: { points: 0 },
      record: { unread: { attack: 0, defense: 0 } }, pool: { inPool: true }, flags: { isAdmin: false },
    },
  };
  const map = new Map([['dl.token', 'tk-boot'], ['dl.session', JSON.stringify({ publicId: 'u_boot', nickname: '启动', expiresAt: null })]]);
  const win = {
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
  const DL = { store, format, render, actions };

  // ① 有效 token → 落点 = hub（FR-11），摘要用启动时取到的 /me
  const dom = fakeDom();
  const calls = [];
  const app = appMod.createApp({
    doc: dom.doc, win, DL,
    api: { me: (token) => { calls.push(token); return Promise.resolve({ transport: 'response', status: 200, envelope: meEnv }); } },
  });
  await app.start();
  assert.deepEqual(calls, ['tk-boot'], '启动自检应带本地 token 取一次 /me');
  assert.equal(app.store.getState().view, 'hub');
  assert.equal(app.store.getState().booted, true);
  assert.ok(dom.host.innerHTML.includes('启动 · common · 0'), '启动后主界面应直接显示摘要');

  // ② 坏 token（401）→ 清凭据 + 回登录屏
  const dom2 = fakeDom();
  const app2 = appMod.createApp({
    doc: dom2.doc, win, DL,
    api: { me: () => Promise.resolve({ transport: 'response', status: 401, envelope: { ok: false, error: { code: 'unauthorized', message: '会话已失效' } } }) },
  });
  await app2.start();
  assert.equal(app2.store.getState().view, 'login');
  assert.equal(map.get('dl.token'), undefined, '会话失效应清 dl.token');
  assert.ok(dom2.host.innerHTML.includes('登录'), '应渲染登录屏');
});

/* ---------- WH-11：物品详情字段三方一致（03 §5.1 + §5.3） ---------- */

function expandBraces(token) {
  const out = [];
  const walk = (s) => {
    const i = s.indexOf('{');
    if (i === -1) { out.push(s); return; }
    let depth = 0;
    let j = -1;
    for (let k = i; k < s.length; k += 1) {
      if (s[k] === '{') depth += 1;
      else if (s[k] === '}') { depth -= 1; if (depth === 0) { j = k; break; } }
    }
    const prefix = s.slice(0, i);
    const body = s.slice(i + 1, j);
    const suffix = s.slice(j + 1);
    let d = 0;
    let start = 0;
    const parts = [];
    for (let k = 0; k < body.length; k += 1) {
      const c = body[k];
      if (c === '{') d += 1;
      else if (c === '}') d -= 1;
      else if (c === ',' && d === 0) { parts.push(body.slice(start, k)); start = k + 1; }
    }
    parts.push(body.slice(start));
    for (const p of parts) walk(prefix + p + suffix);
  };
  walk(token);
  return out;
}

// 归一：去掉 `[]`；`slots[].type` / `affixes[].id` 这类数组元素字段按其**在元素内的相对路径**登记
//   （前端是在 `slots[i]` / `affixes[i]` 子对象上读取的）
function normalizeField(p) {
  const segs = p.replace(/\[\]/g, '').split('.').filter((s) => s !== '');
  if (segs.length > 1 && (segs[0] === 'slots' || segs[0] === 'affixes')) segs.shift();
  return segs.join('.');
}

function documentedItemFields() {
  const doc = fs.readFileSync(DOC3, 'utf8');
  const fields = new Set();
  // §5.1 的 `box` 行：物品对象形状的裸字段清单（`data.items[]`（`uid`/`kind`/…））
  const s51 = doc.indexOf('## 5.');
  const e51 = doc.indexOf('## 6.');
  for (const line of doc.slice(s51, e51).split('\n')) {
    if (!line.startsWith('|') || !line.includes('data.items[]')) continue;
    let seen = false;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const token = m[1];
      if (token === 'data.items[]') { seen = true; continue; }
      if (!seen) continue;
      if (/^[a-z][A-Za-z0-9_]*(\[\])?$/.test(token)) fields.add(normalizeField(token));
    }
  }
  // §5.3：逐条字段清单（花括号分组要展开）
  const s53 = doc.indexOf('### 5.3');
  const e53 = doc.indexOf('## 6.');
  assert.ok(s53 !== -1 && e53 > s53, '03 分册缺少 §5.3');
  for (const line of doc.slice(s53, e53).split('\n')) {
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      for (const part of m[1].split('/')) {
        const token = part.trim();
        if (token === '' || token.includes(' ')) continue;
        for (const expanded of expandBraces(token)) fields.add(normalizeField(expanded));
      }
    }
  }
  return fields;
}

test('WH-11 物品详情字段三方一致：contract == 03 §5.1+§5.3 == format.js 实读；且真实响应可解析', async () => {
  const documented = documentedItemFields();
  const declared = new Set(contract.ITEM_DETAIL_FIELDS);
  assert.deepEqual([...documented].filter((f) => !declared.has(f)), [], '分册 §5 有但 contract 未登记');
  assert.deepEqual([...declared].filter((f) => !documented.has(f)), [], 'contract 登记了但分册 §5 没有');

  // format.js 必须真的读这些路径（容器字段允许通过其子路径读取）
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'format.js'), 'utf8');
  const reads = new Set([...src.matchAll(/pick\(\s*[A-Za-z_$][\w.$]*\s*,\s*'([^']+)'\s*\)/g)].map((m) => m[1]));
  const unread = [...declared].filter((f) => !reads.has(f) && ![...reads].some((p) => p.startsWith(f + '.')));
  assert.deepEqual(unread, [], `contract 登记了但 format.js 没读：${unread.join(', ')}`);

  // 每条字段都要能在**真实响应**的单件物品上解析到（不是只对文档成立）
  const COMMON_FIELDS = ['name', 'kind', 'quality', 'uid'];
  const FIELDS_BY_KIND = {
    role: ['templateId', 'slotCount', 'slots', 'stats', 'stats.hp', 'stats.atk', 'stats.def', 'stats.sp', 'stats.mp',
      'regen.mp', 'regen.sp', 'pluginPoints'],
    skill: ['templateId', 'slotCount', 'slots', 'params', 'params.multiplier', 'params.cooldown', 'params.bulletLevel',
      'params.cost.hp', 'params.cost.mp', 'params.cost.sp'],
    rolePlugin: ['id', 'desc', 'slot', 'category', 'tier', 'pointCost', 'affixes'],
    skillPlugin: ['id', 'desc', 'slot', 'category', 'tier', 'costDeltaByTier', 'affixes'],
  };
  // 子对象字段（slots[i].type / slots[i].pluginUid / affixes[i].params.v）在上面的清单里由容器覆盖，
  //   这里显式断言它们也能解析，并顺带核对"契约里的每个字段都有宿主（不会漏检）"
  const SUB_FIELDS = ['type', 'pluginUid', 'params.v'];
  const covered = new Set([...COMMON_FIELDS, ...FIELDS_BY_KIND.role, ...FIELDS_BY_KIND.skill,
    ...FIELDS_BY_KIND.rolePlugin, ...FIELDS_BY_KIND.skillPlugin, ...SUB_FIELDS]);
  assert.deepEqual([...declared].filter((f) => !covered.has(f)), [], '契约字段没有对应的真实响应核对项');

  await withHarness(async (h) => {
    await h.signUp('wh11user');
    await h.run('goto-warehouse');
    const wr = h.state().warehouse.envelope;
    const items = [];
    for (const bucket of format.BUCKET_ORDER) {
      for (const item of format.bucketItems(wr, bucket)) items.push(item);
    }
    assert.ok(items.length >= 5, `starter 应有 ≥5 件物品：${items.length}`);
    const kinds = new Set();
    for (const item of items) {
      const kind = format.pick(item, 'kind');
      const uid = format.pick(item, 'uid');
      kinds.add(kind);
      assert.ok(FIELDS_BY_KIND[kind], `未知物品类别 ${kind}`);
      for (const field of COMMON_FIELDS.concat(FIELDS_BY_KIND[kind])) {
        assert.notStrictEqual(format.pick(item, field), undefined, `真实物品（${kind} ${uid}）缺少字段 ${field}`);
      }
      const slots = format.pick(item, 'slots') || [];
      if (slots.length > 0) {
        for (const f of ['type', 'pluginUid']) {
          assert.notStrictEqual(format.pick(slots[0], f), undefined, `${kind} ${uid} 的插槽缺少字段 ${f}`);
        }
      }
      const affix = (format.pick(item, 'affixes') || [])[0];
      if (affix) {
        assert.notStrictEqual(format.pick(affix, 'params.v'), undefined, `${kind} ${uid} 的词条缺少 params.v`);
      }
    }
    assert.deepEqual([...kinds].sort(), ['role', 'rolePlugin', 'skill', 'skillPlugin'],
      `starter 应覆盖四桶全部类别：${[...kinds].join(', ')}`);
  });
});
