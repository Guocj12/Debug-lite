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
// F9/D-180：主界面改由布局表渲染 —— 本文件必须注入引擎与布局数据，否则 hub 走旧的文字界面
format.setLayout(require('../../public/layout-engine.js'), require('../../public/layout-data.js'));

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
  // F8/D-177：开包请求体与响应（"请求体只有 packageUids、不传 seed"的断言依据）
  const pkgCalls = [];
  const pkgEnvelopes = [];
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
    // F9/D-180：布局路径的写出口（装配 / 清空 / 换装 / 设为出战）——不登记会 TypeError
    assemble: counting(raw.assemble),
    disassemble: counting(raw.disassemble),
    saveConfig: counting(raw.saveConfig),
    activateConfig: counting(raw.activateConfig),
    aiList: counting(raw.aiList),
    setNickname: counting(raw.setNickname),
    // F6：快速对战与归档回放出口（新出口必须在此登记，否则动作调用 ctx.api.xxx 会 TypeError）
    quickRun: counting(raw.quickRun),
    replay: counting(raw.replay),
    // F7：锦标赛批次与排行榜出口
    rankedRun: counting(raw.rankedRun),
    leaderboard: counting(raw.leaderboard),
    admin: counting(raw.admin),
    // F8/D-177：开包出口（仓库屏「包」桶）
    openPackage: (token, input) => {
      counter.n += 1;
      pkgCalls.push(input);
      return raw.openPackage(token, input).then((r) => { pkgEnvelopes.push(r.envelope); return r; });
    },
  };
  const h = {
    win, storage, api, counter, pkgCalls, pkgEnvelopes,
    state: () => st.getState(),
    dispatch: (a) => st.dispatch(a),
    html: () => render.render(format.viewModel(st.getState())),
    notice: () => (st.getState().notice ? st.getState().notice.text : ''),
    form: (values) => { for (const [k, v] of Object.entries(values)) st.dispatch({ type: 'form.set', field: k, value: v }); },
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
// D-188：布局表的按钮把文字包在 `<span class="dl-txt">…</span>` 里（为了叠在底图上），
//   故"按钮文字"不能只看 `</button>` 前面那一段 —— 这里按 `data-action` 抓取按钮块再取其中的文字。
function layoutButtonTexts(html) {
  const out = [];
  for (const m of html.matchAll(/<button\b[^>]*data-action="([^"]+)"[^>]*>([\s\S]*?)<\/button>/g)) {
    const texts = [...m[2].matchAll(/<span class="dl-txt">([^<]*)<\/span>/g)].map((x) => x[1]);
    out.push({ action: m[1], text: texts.join('') });
  }
  return out;
}

/* ---------- WH-1：主界面（hub） ---------- */

test('WH-1 主界面：摘要只读 GET /me（可追溯）＋ 10 个按钮 ＋ 刷新', async () => {
  await withHarness(async (h) => {
    const me = await h.signUp('wh1user');
    const html = h.html();
    // 摘要行 = `昵称 · 段位 · 积分 · 未读 进攻a/防守d · 在池`（03 §3.1 / §11 步 2）
    const expected = me.data.nickname + ' · ' + me.data.progress.tier + ' · ' + me.data.rating.points
      + ' · 未读 进攻' + me.data.record.unread.attack + '/防守' + me.data.record.unread.defense
      + ' · ' + (me.data.pool.inPool === true ? '在池' : '不在池');
    assert.equal(format.hubSummary(h.state()), expected, '摘要行必须逐字由 GET /me 的字段拼出');
    // 摘要没有第二个数据源：清掉 profile 后立刻变成"尚未读取"占位
    h.dispatch({ type: 'profile.set', envelope: null });
    assert.match(format.hubSummary(h.state()), /尚未读取到档案数据/);
    assert.ok(!h.html().includes('class="dl-screen"'), '没有 /me 时主界面退回文字界面（不渲染半屏空布局）');
    h.dispatch({ type: 'profile.set', envelope: me });
    const html2 = h.html();

    // F9/D-180：主界面 = 布局表渲染 —— 绑定数据落到元素上，入口来自布局表
    assert.ok(html2.includes('class="dl-screen"'), '主界面应由布局表渲染（.dl-screen）');
    assert.ok(html2.includes('>' + me.data.nickname + '<'), '昵称由 /me 绑定到布局元素（用户名）');
    assert.ok(html2.includes('>绿<'), '段位中文名由 /me 绑定到布局元素（段位名）');
    for (const id of ['用户头像', 'btn_warehouse', 'btn_ai', 'btn_settings', 'btn_board', 'btn_tournament',
      'btn_quick', 'crest_role', 'skill_1', 'skill_2', 'skill_3', '对战历史']) {
      assert.ok(html2.includes('title="' + id + '"'), `主界面缺少布局元素：${id}`);
    }
    // 出战角标只出现在"出战那份配置"上方（服务端 activeSlotId 决定）
    const activeIdx = String(me.data.activeSlotId || 'slot1').replace(/[^0-9]/g, '') || '1';
    assert.ok(html2.includes('title="battle_badge_' + activeIdx + '"'), '出战角标应出现在出战配置上方');
    // 底部保留布局表之外的入口：阵容编辑（旧编辑器，详细编辑用）+ 刷新
    const labels = buttonLabels(html2);
    for (const label of ['阵容编辑', '刷新']) {
      assert.ok(labels.includes(label), `主界面底部缺少入口：${label}（实际 ${labels.join('/')}）`);
    }
    assert.ok(!labels.includes('开箱'), 'F8/D-176：开箱入口已随开箱屏删除');
    assert.equal(labels.filter((l) => l === '刷新').length, 1, '主界面只应有一个「刷新」');

    // 刷新：重取**三份数据**（/me + /me/configs + /me/warehouse）——布局表驱动的界面全靠它们
    const before = h.counter.n;
    await h.run('refresh-hub');
    assert.equal(h.counter.n, before + 3, '刷新应重取 /me + /me/configs + /me/warehouse');
    assert.equal(h.notice(), format.REFRESH_OK_TEXT);

    // 径向插槽流：打开角色插槽层（点角色卡触发的就是这个动作）→ 插槽数量 = 角色物品 slotCount → 关闭
    const slots = h.state().configs.data.data.slots;
    const curSlot = slots.filter((s) => s.slotId === me.data.activeSlotId)[0] || slots[0];
    await h.run('layout-open', { screen: 'modal_role_slots', idx: 0, pos: 'role', targetUid: curSlot.loadout.role.uid });
    const withModal = h.html();
    assert.ok(withModal.includes('class="dl-modal"'), '打开布局弹窗后应渲染弹窗层');
    assert.ok(withModal.includes('data-action="modal-close"'), '弹窗必须带可关闭的遮罩');
    const slotCount = (withModal.match(/data-screen="modal_role_plugin_pick"/g) || []).length;
    assert.equal(slotCount, curSlot.loadout.role.slots.length, '插槽数量必须等于角色物品的 slotCount');
    await h.run('modal-close');
    assert.ok(!h.html().includes('class="dl-modal"'), '点遮罩后应逐层关闭');

    // F9/D-180：径向流**真的写服务端** —— 打开某插槽的候选层 → 装配 → 仓库里那件物品的 pluginUid 变更
    //   判据必须读**仓库**（实测 /me/configs 是快照，卸下插件后它仍显示旧 pluginUid）
    const roleUid = curSlot.loadout.role.uid;
    const bucket = h.state().warehouse.envelope.data.buckets.rolePlugin;
    const liveSlots = () => h.state().warehouse.envelope.data.buckets.role
      .filter((r) => r.uid === roleUid)[0].slots;
    const fitIdx = liveSlots().findIndex((sl) => bucket.some((p) => p.slot === sl.type));
    if (fitIdx >= 0) {
      const cand = bucket.filter((p) => p.slot === liveSlots()[fitIdx].type)[0];
      const beforeUid = liveSlots()[fitIdx].pluginUid;
      if (beforeUid !== null) await h.run('layout-disassemble', { uid: roleUid, slotIndex: fitIdx });
      await h.run('layout-assemble', { uid: cand.uid, targetUid: roleUid, slotIndex: fitIdx });
      if (liveSlots()[fitIdx].pluginUid === cand.uid) {
        assert.equal(liveSlots()[fitIdx].pluginUid, cand.uid, '装配必须真的写进仓库物品的插槽');
        assert.match(h.notice(), /装配插件成功/, '装配成功应有可见文案：' + h.notice());
        await h.run('layout-disassemble', { uid: roleUid, slotIndex: fitIdx });
        assert.equal(liveSlots()[fitIdx].pluginUid, null, '清空插槽必须真的生效');
      } else {
        // 点数不够等业务拒绝：必须是**可读文案**且状态不变（不能是内部错误）
        assert.equal(liveSlots()[fitIdx].pluginUid, beforeUid, '被拒绝时状态不得改变');
        assert.ok(!/内部错误/.test(h.notice()) && h.notice().length > 0, '拒绝必须可读：' + h.notice());
      }
    }
    // 换角色：候选角色行写入配置（applySlotChoice + PUT /me/configs）
    await h.run('layout-set-slot', { pos: 'role', uid: roleUid });
    assert.ok(!/内部错误/.test(h.notice()), '换角色不应是内部错误：' + h.notice());
    // 用户 → 用户详情；返回主界面
    await h.run('goto-profile');
    assert.equal(h.state().view, 'profile');
    await h.run('goto-hub');
    assert.equal(h.state().view, 'hub');
  });
});

/* ---------- WH-2：空页已全部落地（F5 起） ---------- */

test('WH-2 四个空页已全部落地：EMPTY_PAGES 为空，ai-editor 是真屏（会发请求、有真按钮）', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh2user');
    // F6 落地 quick、F7 落地 tournament/leaderboard、F5 落地 ai-editor ⇒ 占位页表必须为空
    assert.deepEqual(Object.keys(format.EMPTY_PAGES), [], 'F5 之后不应再有空页（FR-12 的占位页已全部落地）');
    const before = h.counter.n;
    await h.run('goto-ai-editor');
    assert.equal(h.state().view, 'ai-editor');
    assert.ok(h.counter.n > before, 'ai-editor 是真屏：进屏要拉一次 GET /me/ai（不再是"零请求"的空页）');
    const labels = buttonLabels(h.html());
    assert.ok(labels.includes('新建 AI') && labels.includes('返回主界面'), `真屏按钮缺失：${labels.join('、')}`);
    assert.ok(!h.html().includes('尚未实现'), '真屏不应再出现「尚未实现」占位文案');
    await h.run('goto-hub');
    assert.equal(h.state().view, 'hub');
  });
});

/* ---------- WH-3：仓库 ---------- */

test('WH-3 [D-188] 仓库弹窗：6 个选项卡 / 网格按数量排布 / 详情弹窗 / 遮罩关闭', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh3user');
    // D-188：仓库是**弹窗**（覆盖在主界面上），不是独立屏
    await h.run('warehouse-open');
    assert.equal(h.state().view, 'hub', '仓库弹窗承载在主界面上（不切屏）');
    assert.ok(h.state().warehouse.envelope, '开弹窗应已取到 GET /me/warehouse');
    assert.deepEqual(h.state().hub.modals.map((m) => m.name), ['modal_warehouse'], '弹窗栈应压入 modal_warehouse');

    const wr = h.state().warehouse.envelope;
    // ① 6 个选项卡（按**实际物品类型**——用户口径：「顶部选项卡数量要按照实际物品类型来」）
    const html = h.html();
    const tabTexts = layoutButtonTexts(html).filter((b) => b.action === 'warehouse-tab').map((b) => b.text);
    assert.deepEqual(tabTexts, ['角色', '技能', '角色插件', '技能插件', '包', 'AI节点'],
      `仓库应有 6 个分类选项卡，实际：${JSON.stringify(tabTexts)}`);
    // ② 当前分类的容量行（读真响应 counts/caps）
    const roleItem = format.bucketItems(wr, 'role')[0];
    assert.ok(roleItem, 'starter 应至少有 1 个角色');
    assert.ok(html.includes('data-uid="' + roleItem.uid + '"'), '网格格子应携带 data-uid');
    assert.ok(html.includes(format.warehouseCapacityLine(h.state(), 'role')), '容量行必须渲染到屏幕上');

    // ③ 切分类 = 纯本地（不发请求）
    const before = h.counter.n;
    await h.run('warehouse-tab', { bucket: 'skillPlugin' });
    assert.equal(h.counter.n, before, '切分类不得发请求');
    assert.equal(h.state().warehouseTab, 'skillPlugin');
    const pluginItem = format.bucketItems(wr, 'skillPlugin')[0];
    assert.ok(h.html().includes('data-uid="' + pluginItem.uid + '"'), '切换后应显示该桶的格子');

    // ④ 点格子 → **物品详情弹窗**（叠在仓库弹窗之上）
    await h.run('warehouse-item-open', { uid: pluginItem.uid, bucket: 'skillPlugin' });
    assert.deepEqual(h.state().hub.modals.map((m) => m.name), ['modal_warehouse', 'modal_item_detail']);
    assert.deepEqual(h.state().warehouseItem, { uid: pluginItem.uid, bucket: 'skillPlugin' });
    const detHtml = h.html();
    assert.ok(detHtml.includes('【基本信息】'), '详情应按类别分组（用户口径：全部属性、按类别分组）');
    assert.ok(detHtml.includes('【词条】'), '插件详情应有词条分组');

    // ⑤ 遮罩点击 = 关闭（仓库弹窗的遮罩元素带 data-action="modal-close"）
    assert.ok(detHtml.includes('data-action="modal-close"'), '弹窗必须有承担外部点击的遮罩元素');
    await h.run('modal-close');
    assert.equal(h.state().hub.modals.length, 1, '关闭详情后回到仓库弹窗');

    // ⑥ 空分类态：形状取自真实响应的空桶（纯投影，不需要第二份夹具）
    const emptyEnv = JSON.parse(JSON.stringify(wr));
    emptyEnv.data.buckets.skill = [];
    emptyEnv.data.counts.skill = 0;
    const emptyState = store.initialState();
    emptyState.view = 'hub';
    emptyState.session = { token: 't', publicId: 'u_x', isAdmin: false };
    emptyState.profile = { ok: true, data: { nickname: '甲', progress: { tier: 'common' },
      rating: { points: 0 }, record: { unread: { attack: 0, defense: 0 } }, pool: { inPool: true }, activeSlotId: 'slot1' } };
    emptyState.configs = { data: { ok: true, data: { slots: [], activeSlotId: 'slot1', maxSlots: 3 } } };
    emptyState.warehouse = { envelope: emptyEnv };
    emptyState.warehouseTab = 'skill';
    emptyState.hub = { slot: 0, modals: [{ name: 'modal_warehouse', ctx: {} }] };
    const emptyHtml = render.render(format.viewModel(emptyState));
    assert.ok(emptyHtml.includes('这个分类里还没有东西'), '空分类应显示空态文案');
  });
});

/* ---------- WH-4 / WH-5 / WH-6：开包（F8/D-176/D-177；D-188 改由详情弹窗承载） ---------- */

test('WH-4 [D-188] 开包（详情弹窗内）：请求体只有 packageUids；结果逐件行；不显示 seed；成功后仓库已刷新', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh4user');
    await h.run('warehouse-open');
    const before = h.counter.n;
    await h.run('warehouse-tab', { bucket: 'package' });
    assert.equal(h.counter.n, before, '切分类不得发请求');
    const pkg = format.bucketItems(h.state().warehouse.envelope, 'package')[0];
    assert.ok(pkg, 'starter 应带 1 个包（D-176）');
    assert.equal(pkg.kind, 'package');

    // 打开详情 → 包只有「开包」按钮（D-188：包可开包、不可分解）
    await h.run('warehouse-item-open', { uid: pkg.uid, bucket: 'package' });
    const detHtml = h.html();
    assert.ok(detHtml.includes('data-action="warehouse-package-open"'), '包的详情必须有「开包」按钮');
    assert.ok(!detHtml.includes('data-action="warehouse-dismantle"'), '包**不可**分解（D-187）');
    assert.ok(detHtml.includes('data-uid="' + pkg.uid + '"'), '开包按钮必须携带 data-uid');

    const countBefore = format.bucketItems(h.state().warehouse.envelope, 'package').length;
    const reqBefore = h.counter.n;
    await h.run('warehouse-package-open', { uid: pkg.uid });
    // 开包 1 次 + 成功后的静默仓库刷新 1 次
    assert.equal(h.counter.n, reqBefore + 2, '开包 = POST /me/warehouse/open-package(1) + 静默刷新仓库(1)');
    // 请求体**只有 packageUids**（无 seed 入参 —— 随机性归服务端，D-162 口径）
    assert.deepEqual(h.pkgCalls, [{ packageUids: [pkg.uid] }], `开包请求体：${JSON.stringify(h.pkgCalls)}`);
    const env = h.pkgEnvelopes[0];
    assert.equal(env.ok, true);
    assert.equal(env.data.opened.length, 1);
    assert.equal(env.data.opened[0].packageUid, pkg.uid);

    // 结果区：`本次开包获得 <n> 件：` + 逐件行（由 state.packages.result 承载）
    const lines = h.state().packages.result.lines;
    const n = env.data.items.length;
    assert.equal(lines[0], '本次开包获得 ' + n + ' 件：');
    for (const line of lines.slice(1, 1 + n)) {
      assert.match(line, /^.+（(角色|技能|角色插件|技能插件|AI节点)·.+）$/, `逐件行：${line}`);
    }
    // seed 是服务端审计量：不传（上面已断言）**也不显示**
    assert.ok(typeof env.data.seed === 'number', '服务端应回带 seed（仅审计）');
    assert.ok(!h.html().includes(String(env.data.seed)), '界面不得显示开包 seed');
    assert.ok(!h.html().includes('种子'), '不得出现"种子"字样');
    assert.equal(h.notice(), format.PACKAGE_OK_TEXT);

    // 成功后**本地仓库状态已刷新**：包被消耗（-1）
    assert.equal(format.bucketItems(h.state().warehouse.envelope, 'package').length, countBefore - 1,
      '开包后包桶应 -1（包被消耗）');
    // 详情弹窗被收起（开完不该停在已消耗物品的详情上）
    assert.deepEqual(h.state().hub.modals.map((m) => m.name), ['modal_warehouse'], '开包后应收起详情弹窗');
    // 重开仓库再取一次真源 → 计数与本地一致（不重复计数）
    await h.run('warehouse-open');
    assert.equal(format.bucketItems(h.state().warehouse.envelope, 'package').length, countBefore - 1);
  });
});

test('WH-5 [D-178] AI 节点包：可开、产出积木节点、入库堆叠、不报错', async () => {
  await withHarness(async (h, s) => {
    const me = await h.signUp('wh5user');
    const playerId = await playerIdByPublicId(s.store, me.data.publicId);
    assert.ok(playerId, '应能用 publicId 反查到 playerId');
    // 注入一个 AI 节点包（D-178 起 openable=true：产出积木节点）
    await s.store.updateArchive(playerId, (archive) => {
      archive.warehouse.buckets.package.push({
        uid: 'pkg_ainode_1', kind: 'package', packageKind: 'aiNode', name: 'AI节点包',
        quality: 'common', qualityPercent: 20,
      });
      return null;
    });
    await h.run('warehouse-open');
    await h.run('warehouse-tab', { bucket: 'package' });
    await h.run('warehouse-item-open', { uid: 'pkg_ainode_1', bucket: 'package' });
    await h.run('warehouse-package-open', { uid: 'pkg_ainode_1' });
    const env = h.pkgEnvelopes[0];
    assert.equal(env.ok, true, '开 AI 节点包必须 200');
    assert.ok(env.data.items.length >= 1 && env.data.items.length <= 3, '产出 1~3 条节点堆叠');
    for (const it of env.data.items) {
      assert.equal(it.kind, 'aiNode', '产出是积木节点条目');
      assert.equal(it.quality, 'common', '绿包只出绿节点（本级及以下均匀 = 100% 本级）');
      assert.ok(it.nodeId && it.count >= 1, '条目带 nodeId 与堆叠数量');
    }
    const lines = h.state().packages.result.lines;
    assert.equal(lines[0], '本次开包获得 ' + env.data.items.length + ' 件：');
    assert.ok(lines.some((l) => l.includes('AI节点')), `结果区必须显示节点行：${lines.join(' | ')}`);
    assert.equal(h.notice(), format.PACKAGE_OK_TEXT, '不报错：成功文案');
    // 包确实被消耗了
    assert.equal(format.bucketItems(h.state().warehouse.envelope, 'package')
      .filter((p) => p.uid === 'pkg_ainode_1').length, 0, '包被消耗');
    // 产出的节点确实进了 aiNode 桶（且与 starter 的绿节点堆叠合并）
    const stacks = format.bucketItems(h.state().warehouse.envelope, 'aiNode');
    assert.ok(stacks.length >= 22, `aiNode 桶应含 starter 绿节点 + 本次产出（实际 ${stacks.length}）`);
    for (const it of env.data.items) {
      const st = stacks.find((x) => x.nodeId === it.nodeId);
      assert.ok(st && st.count >= 1, `节点 ${it.nodeId} 应已入库`);
    }
  });
});

test('WH-6 满仓：本地拦下「开包」且零请求；未读仓库时由服务端 409 兜底；取仓失败不挡人', async () => {
  await withHarness(async (h, s) => {
    const me = await h.signUp('wh6user');
    // 把五桶灌满到 500（走 store 门面，不打补丁）
    const playerId = await playerIdByPublicId(s.store, me.data.publicId);
    assert.ok(playerId, '应能用 publicId 反查到 playerId');
    await s.store.updateArchive(playerId, (archive) => {
      const mk = (bucket, n) => ({ uid: bucket + '_fill_' + n, kind: bucket === 'package' ? 'package' : bucket, name: 'filler', quality: 'common', tier: 1, affixes: [], slots: [] });
      for (const bucket of ['role', 'skill', 'rolePlugin', 'skillPlugin', 'package']) {
        const list = archive.warehouse.buckets[bucket];
        while (list.length < 500) list.push(mk(bucket, list.length));
      }
      return null;
    });

    // ① 进入仓库即取仓 → 本地判定满仓 → 「开包」被拦下 + 精确文案 + **零**请求
    await h.run('warehouse-open');
    await h.run('warehouse-tab', { bucket: 'package' });
    const wr = h.state().warehouse.envelope;
    assert.equal(format.bucketItems(wr, 'package').length, 500, '仓库真源应显示包桶 500 件');
    const text = '仓库已满（角色 500/500），请先清理';
    assert.equal(format.packageFullNotice(h.state()), text, '满仓判定按 BUCKET_ORDER 的首个满桶（角色）');
    const target = format.bucketItems(wr, 'package')[0];
    const before = h.counter.n;
    await h.run('warehouse-package-open', { uid: target.uid });
    assert.equal(h.counter.n, before, '已满时一个请求都不许发');
    assert.deepEqual(h.pkgCalls, [], '已满时不得发 open-package');
    assert.equal(h.notice(), text, '被拦下时也要有可见文案（按钮永不无声）');

    // ② 未读到仓库（人为清空信封）→ 不做本地预判、真问服务端 → 409 `warehouse_full` 落到可见提示
    h.dispatch({ type: 'warehouse.set', envelope: null });
    assert.equal(format.packageFullNotice(h.state()), null, '没有仓库信封时不做本地预判');
    const before2 = h.counter.n;
    const pkgBefore = h.pkgCalls.length;
    await h.run('warehouse-package-open', { uid: target.uid });
    assert.equal(h.counter.n, before2 + 1, '未读仓库时必须真的问服务端（409 后不再刷新仓库）');
    assert.equal(h.pkgCalls.length, pkgBefore + 1, '应真的发了 open-package');
    assert.match(h.notice(), /仓库已满/, `409 文案必须可读：${h.notice()}`);
  });

  // ③ 缺 uid（无 data-uid 的格子）→ 客户端拦下、不发请求、文案可见
  await withHarness(async (h) => {
    await h.signUp('wh6nouser');
    await h.run('warehouse-open');
    await h.run('warehouse-tab', { bucket: 'package' });
    const before = h.counter.n;
    await h.run('warehouse-package-open', null);
    assert.equal(h.counter.n, before, '缺 uid 不得发请求');
    assert.match(h.notice(), /缺少包 uid/, `缺 uid 的文案：${h.notice()}`);
  });

  // ④ **读取失败**（服务已关）→ 开包失败文案可见（不做本地预判、由服务端兜底）
  const s2 = await startServer({ prefix: 'dl-fe-hub-pkgfail-', level: 'warn' });
  const h2 = harness(s2.baseUrl);
  try {
    await h2.signUp('wh6fail');
    await s2.close();
    await h2.run('warehouse-package-open', { uid: 'pkg_whatever' });
    assert.match(h2.notice(), /^无法连接服务器：/, `网络失败必须可见：${h2.notice()}`);
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
    assert.ok(h.html().includes('>新昵称A<'), '主界面应显示新昵称（布局元素绑定）');

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
    // F3：登出后仓库/开包等用户态数据不得残留
    assert.equal(h.state().warehouse.envelope, null, '登出应清仓库数据（不残留上个账号的内容）');
    assert.equal(h.state().packages.result, null);
  });
});

/* ---------- WH-8：弹窗机制（UW-5） ---------- */

test('WH-8 弹窗机制：至多一个 / 必有 modal-close / 切屏即清 / 丢弃未提交输入', async () => {
  await withHarness(async (h) => {
    await h.signUp('wh8user');
    // D-188：仓库改为弹窗 —— 走新入口
    await h.run('warehouse-open');
    const item = format.bucketItems(h.state().warehouse.envelope, 'role')[0];

    // 打开 → 只有仓库弹窗一层，且遮罩元素存在
    assert.deepEqual(h.state().hub.modals.map((m) => m.name), ['modal_warehouse']);
    assert.ok(h.html().includes('data-action="modal-close"'), '弹窗必须有遮罩关闭元素');
    // 打开物品详情 → 叠第二层
    await h.run('warehouse-item-open', { uid: item.uid, bucket: 'role' });
    assert.deepEqual(h.state().hub.modals.map((m) => m.name), ['modal_warehouse', 'modal_item_detail']);
    // 关闭一层 → 回到仓库弹窗
    await h.run('modal-close');
    assert.deepEqual(h.state().hub.modals.map((m) => m.name), ['modal_warehouse']);

    // 旧屏内弹窗（`state.modal`）机制仍在：config-open 打开编辑器，同一时刻至多一个
    await h.run('config-open', { slot: 'slot2' });
    assert.deepEqual(h.state().modal, { kind: 'config', slotId: 'slot2' });
    assert.equal((h.html().match(/id="modal"/g) || []).length, 1, '同一时刻至多一个屏内弹窗');
    assert.ok(h.html().includes('出战配置2：'), '编辑器状态行必须含 slotId');
    assert.ok(h.html().includes(format.CONFIG_DRAFT_HINT), '编辑器应提示"编辑先落在本地草稿"');
    assert.ok(h.state().configs.draft, '打开配置弹窗应灌入本地草稿');
    assert.ok(h.html().includes('data-action="modal-close"'), '弹窗必须有背景关闭元素');
    // 缺省 slot（无 payload）→ slot1
    await h.run('config-open');
    assert.deepEqual(h.state().modal, { kind: 'config', slotId: 'slot1' });

    // 任何含弹窗的屏都必须渲染 modal-close（F8/D-176：`box` 屏已删除；D-188：`warehouse` 屏已删除）
    for (const view of ['hub', 'profile', 'settings']) {
      const state = store.initialState();
      state.view = view;
      state.modal = { kind: 'config', slotId: 'slot1' };
      state.warehouse.envelope = h.state().warehouse.envelope;
      const html = render.render(format.viewModel(state));
      assert.ok(html.includes('data-action="modal-close"'), `${view} 屏的弹窗缺少背景元素`);
    }

    // 切屏即清弹窗（modal 不跨屏存活）
    await h.run('goto-hub');
    assert.equal(h.state().modal, null, '切屏应清弹窗');
    // 关闭：丢弃未提交输入（弹窗内有**本地草稿** → 关闭必须一并丢弃）
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
    // D-188：仓库弹窗栈的 reducer 守卫（压入未知画面 → 仍入栈，但渲染层跳过未知画面）
    st2.dispatch({ type: 'hub.modal.push', screen: 'modal_warehouse', ctx: {} });
    assert.deepEqual(st2.getState().hub.modals.map((m) => m.name), ['modal_warehouse']);
    st2.dispatch({ type: 'hub.modals.clear' });
    assert.equal(st2.getState().hub.modals.length, 0, 'hub.modals.clear 应清空弹窗栈');
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

test('WH-9 DOM 装配层：data-uid → 弹窗、背景点击 → 关闭、包行「开包」与结果区', async () => {
  const dom = fakeDom();
  const calls = [];
  const fakeApi = {
    me: () => Promise.resolve({ transport: 'error', message: '本用例不发 /me' }),
    // F8/D-177：开包出口（取代原 box 出口）
    openPackage: (token, input) => {
      calls.push({ op: 'openPackage', token, input });
      return Promise.resolve({
        transport: 'response', status: 200,
        envelope: {
          ok: true,
          data: {
            seed: 424242,
            opened: [{ packageUid: 'pkg_0', packageKind: 'role', quality: 'common', qualityPercent: 15, count: 1, items: [{ uid: 'item_9', kind: 'role', name: '均衡', quality: 'common' }] }],
            items: [{ uid: 'item_9', kind: 'role', name: '均衡', quality: 'common' }],
            warehouse: { buckets: { role: [{ uid: 'item_0', kind: 'role', name: '均衡', quality: 'common', slotCount: 0, slots: [], stats: {}, regen: {}, pluginPoints: 0, templateId: 'role_bal' }], skill: [], rolePlugin: [], skillPlugin: [], package: [] }, usage: {}, caps: {}, counts: {} },
            usage: {}, caps: {}, counts: {},
          },
        },
      });
    },
  };
  const map = new Map();
  const win = { localStorage: { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) } };
  const app = appMod.createApp({ doc: dom.doc, win, DL: { store, format, render, actions }, api: fakeApi });
  await app.start();
  assert.ok(dom.host.innerHTML.includes('登录'), '无会话时应渲染登录屏');

  // 造出"已登录 + 仓库已取到"的状态（形状来自真实响应；F8 起含包桶）
  const me = { ok: true, data: { publicId: 'u_x', nickname: '甲', progress: { tier: 'common' }, rating: { points: 0 }, record: { unread: { attack: 0, defense: 0 } }, pool: { inPool: true }, flags: { isAdmin: false } } };
  const warehouse = {
    ok: true,
    data: {
      buckets: {
        role: [{ uid: 'item_0', kind: 'role', name: '均衡', quality: 'common', slotCount: 0, slots: [], stats: {}, regen: {}, pluginPoints: 0, templateId: 'role_bal' }],
        skill: [], rolePlugin: [], skillPlugin: [],
        package: [{ uid: 'pkg_0', kind: 'package', packageKind: 'role', name: '角色模块包', quality: 'common', qualityPercent: 15 }],
      },
      usage: { item_0: { slotIds: ['slot1'] } },
      caps: { role: 500, skill: 500, rolePlugin: 500, skillPlugin: 500, package: 500 },
      counts: { role: 1, skill: 0, rolePlugin: 0, skillPlugin: 0, package: 1 },
    },
  };
  app.dispatch({ type: 'session.set', token: 'tk', publicId: 'u_x', nickname: '甲', expiresAt: null, isAdmin: false });
  app.dispatch({ type: 'profile.set', envelope: me });
  app.dispatch({ type: 'warehouse.set', envelope: warehouse });
  // D-188：仓库是**弹窗**（压在 hub 的弹窗栈上），不是屏
  app.dispatch({ type: 'view.go', view: 'hub' });
  app.dispatch({ type: 'warehouse.tab.set', bucket: 'package' });
  app.dispatch({ type: 'hub.modal.push', screen: 'modal_warehouse', ctx: {} });
  assert.ok(dom.host.innerHTML.includes('角色模块包'), '仓库弹窗的包格子应显示包名');

  // 包格子（data-action=warehouse-item-open + data-uid）→ 详情弹窗
  dom.fire('click', { target: { closest: () => fakeButton('warehouse-item-open', { uid: 'pkg_0', bucket: 'package' }) } });
  assert.deepEqual(app.store.getState().warehouseItem, { uid: 'pkg_0', bucket: 'package' });
  assert.deepEqual(app.store.getState().hub.modals.map((m) => m.name), ['modal_warehouse', 'modal_item_detail']);

  // 详情里的「开包」（data-action=warehouse-package-open + data-uid）→ 请求体只有 packageUids；不显示 seed
  dom.fire('click', { target: { closest: () => fakeButton('warehouse-package-open', { uid: 'pkg_0' }) } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.filter((c) => c.op === 'openPackage'),
    [{ op: 'openPackage', token: 'tk', input: { packageUids: ['pkg_0'] } }], '开包请求体只有 packageUids');
  assert.equal(app.store.getState().packages.result.lines[0], '本次开包获得 1 件：');
  assert.ok(!dom.host.innerHTML.includes('424242'), '界面不得显示响应里的 seed');
  // 开包后详情弹窗被收起（回到仓库弹窗）
  assert.deepEqual(app.store.getState().hub.modals.map((m) => m.name), ['modal_warehouse'], '开包后应收起详情');

  // 点弹窗遮罩（data-action=modal-close）→ 关闭仓库弹窗
  dom.fire('click', { target: { closest: () => fakeButton('modal-close') } });
  assert.equal(app.store.getState().hub.modals.length, 0, '遮罩点击应关闭弹窗');
  assert.ok(!dom.host.innerHTML.includes('modal_warehouse'), '关闭后不应再渲染仓库弹窗');

  // 设置屏输入框：另一个 screen 字段
  app.dispatch({ type: 'view.go', view: 'settings' });
  dom.fire('input', { target: { name: 'settingsNickname', value: '乙' } });
  assert.equal(app.store.getState().settings.nickname, '乙');
});

/* ---------- WH-10：失败路径 ---------- */

test('WH-10 失败路径落在可见提示：会话失效（仓库/开包）与网络失败', async () => {
  // ① 坏 token → 仓库真源 401 → 统一登出 + 文案（03 §6 unauthorized 行）
  await withHarness(async (h) => {
    await h.signUp('wh10a');
    h.dispatch({ type: 'session.set', token: 'not-a-real-token', publicId: h.state().session.publicId, nickname: 'x', expiresAt: null, isAdmin: false });
    await h.run('warehouse-open');
    assert.equal(h.state().view, 'login', '会话失效应切回登录屏');
    assert.ok(h.notice().indexOf('会话已失效，请重新登录') === 0, `实际文案：${h.notice()}`);
    assert.equal(h.state().warehouse.envelope, null, '会话失效应清仓库数据');
  });

  // ② 服务未启动 → 开仓库/开包都是可见网络失败文案（不是静默失败）
  const s = await startServer({ prefix: 'dl-fe-hub-net-', level: 'warn' });
  const h = harness(s.baseUrl);
  try {
    await h.signUp('wh10b');
    await s.close();
    await h.run('warehouse-open');
    // D-188：开弹窗本身是本地动作（不挡人），失败文案来自随后的取真源
    assert.equal(h.state().view, 'hub', '仓库弹窗仍在主界面（不因取数失败而"打不开"）');
    assert.match(h.notice(), /^无法连接服务器：/, `网络失败文案：${h.notice()}`);
    await h.run('warehouse-package-open', { uid: 'pkg_whatever' });
    assert.match(h.notice(), /^无法连接服务器：/, '开包的网络失败同样必须可见');
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

  // ① 有效 token → 落点 = hub（FR-11），主界面由布局表渲染、绑定启动时取到的 /me
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
  assert.ok(dom.host.innerHTML.includes('>启动<'), '启动后主界面应把 /me 的昵称绑定到布局元素上');

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
      'params.cost.hp', 'params.cost.mp', 'params.cost.sp', 'animKey', 'sfxKey'],
    rolePlugin: ['id', 'desc', 'slot', 'category', 'tier', 'pointCost', 'affixes'],
    skillPlugin: ['id', 'desc', 'slot', 'category', 'tier', 'affixes'],
    // 技能**专属**插件追加字段（§6.2；通用插件没有这两个字段 → 按内容变体核对）
    skillPluginExclusive: ['forTypes', 'exclusive'],
    // F8/D-176：包（模块包）—— 种类 + 质量百分比（03 §5.3 的包行）
    package: ['packageKind', 'qualityPercent'],
    // D-178：AI 积木节点堆叠条目（03 §5.4 的节点行）—— 节点 id + 堆叠数量（品质见 COMMON_FIELDS）
    aiNode: ['nodeId', 'count'],
  };
  // 子对象字段（slots[i].type / slots[i].pluginUid / affixes[i].params.v）在上面的清单里由容器覆盖，
  //   这里显式断言它们也能解析，并顺带核对"契约里的每个字段都有宿主（不会漏检）"
  const SUB_FIELDS = ['type', 'pluginUid', 'params.v'];
  const covered = new Set([...COMMON_FIELDS, ...FIELDS_BY_KIND.role, ...FIELDS_BY_KIND.skill,
    ...FIELDS_BY_KIND.rolePlugin, ...FIELDS_BY_KIND.skillPlugin, ...FIELDS_BY_KIND.skillPluginExclusive,
    ...FIELDS_BY_KIND.package, ...FIELDS_BY_KIND.aiNode, ...SUB_FIELDS]);
  assert.deepEqual([...declared].filter((f) => !covered.has(f)), [], '契约字段没有对应的真实响应核对项');

  await withHarness(async (h) => {
    await h.signUp('wh11user');
    await h.run('warehouse-open');   // D-188：仓库改弹窗（取真源的那一步不变）
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
      // 技能专属插件的追加字段按内容变体核对（通用插件不带 forTypes/exclusive；
      //   starter 掷出的插件未必含专属 → 本核对是**条件式**的，见上方 covered 断言保证不漏检）
      const extra = (kind === 'skillPlugin' && format.pick(item, 'slot') === 'exclusive')
        ? FIELDS_BY_KIND.skillPluginExclusive : [];
      for (const field of COMMON_FIELDS.concat(FIELDS_BY_KIND[kind], extra)) {
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
    // F8/D-176：starter 必带 1 个包 → `package` 也必须在覆盖集合内；D-178：新增 aiNode 桶
    assert.deepEqual([...kinds].sort(), ['aiNode', 'package', 'role', 'rolePlugin', 'skill', 'skillPlugin'],
      `starter 应覆盖六桶全部类别：${[...kinds].join(', ')}`);
  });
});
