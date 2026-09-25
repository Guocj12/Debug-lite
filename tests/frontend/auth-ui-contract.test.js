'use strict';
/* tests/frontend/auth-ui-contract.test.js —— F1 界面契约（总纲 §4.1「按钮永不无声」+ §1.5「投影单一真源」）
 *   （F3 提交②同步：非管理员态口径从「F1 四屏恰好 9 个动作」改为「非管理动作集合」，见 UW-2）
 *
 * 机器判定：
 *   ① 非管理员态全部屏（含弹窗子态）渲染出的 data-action 集合 == ACTIONS 注册表中**非管理动作**集合
 *      （双向：无死按钮、无无入口实现）；
 *   ② 每个动作都有可实现分支（run 是函数）与非空标签；
 *   ③ render.js 零逻辑（不读响应字段、不接触应用状态对象）；
 *   ④ 单一网络出口（fetch 只在 api.js）／单一 DOM 写入点（innerHTML 只在 app.js）。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const store = require('../../public/store.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const actions = require('../../public/actions.js');
const api = require('../../public/api.js');
const appMod = require('../../public/app.js');
const contract = require('../../public/contract.js');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const EXPECTED_FILES = ['index.html', 'boot.js', 'app.js', 'api.js', 'store.js', 'format.js', 'render.js', 'actions.js', 'contract.js'];
const ACTION_NAMES = Object.keys(actions.ACTIONS).sort();

// 02-accounts.md §4 的十七个管理动作（F2 十六 + D-170 一个；只在管理员态渲染，非管理员态**完全不出现**，A-1）
const ADMIN_ACTIONS = new Set(['goto-admin', 'admin-refresh-accounts', 'accounts-prev', 'accounts-next',
  'accounts-size-20', 'accounts-size-50', 'accounts-size-100', 'admin-delete-account', 'confirm-yes', 'confirm-no',
  'admin-stats', 'admin-rebuild-index', 'admin-bots', 'admin-clear-bots', 'admin-ban-row', 'admin-unban-row',
  'admin-account-patch']);

function readPublic(name) {
  return fs.readFileSync(path.join(PUBLIC_DIR, name), 'utf8');
}

function stateFor(view) {
  const state = store.initialState();
  state.view = view;
  return state;
}

// 真实的仓库响应形状（真起服务抓取过：docs/frontend/03 §5.2 / tests/api/api-me-warehouse.test.js）
const WAREHOUSE_ENVELOPE = {
  ok: true,
  data: {
    buckets: {
      role: [{ uid: 'item_0', kind: 'role', name: '均衡', quality: 'common', slotCount: 1, slots: [{ type: 'mp', pluginUid: null }], stats: { hp: 96, atk: 9, def: 7, sp: 58, mp: 41 }, regen: { mp: 1, sp: 2 }, pluginPoints: 3, templateId: 'role_bal' }],
      skill: [{ uid: 'item_1', kind: 'skill', name: '旋风斩', quality: 'common', slotCount: 1, slots: [{ type: 'basic', pluginUid: null }], params: { multiplier: 0.88, cost: { hp: 0, mp: 0, sp: 12 }, cooldown: 2, bulletLevel: 2 }, templateId: 'skill_melee_whirl' }],
      rolePlugin: [{ uid: 'item_4', kind: 'rolePlugin', id: 'rp_mp_regen', name: 'MP 优化·回复', desc: 'mp 回复 +1', slot: 'mp', category: 'MP 优化', quality: 'common', tier: 1, pointCost: 1, affixes: [{ id: 'mp_regen', desc: 'mp 回复 +1', params: { v: 1 } }] }],
      skillPlugin: [{ uid: 'item_6', kind: 'skillPlugin', id: 'sp_displacement', name: '位移增强', desc: '位移距离 +1', slot: 'basic', category: '位移增强', quality: 'common', tier: 1, costDeltaByTier: { sp: [2, 4, 6] }, affixes: [{ id: 'distance_plus', desc: '位移距离 +1', params: { v: 1 } }] }],
    },
    usage: { item_0: { slotIds: ['slot1'] }, item_1: { slotIds: ['slot1'] } },
    caps: { role: 500, skill: 500, rolePlugin: 500, skillPlugin: 500 },
    counts: { role: 1, skill: 1, rolePlugin: 1, skillPlugin: 1 },
  },
};

// 提交③：出战配置编辑器的真实响应形状（真起服务抓取过：docs/frontend/03 §5.1/§5.2）
const CONFIG_LOADOUT = {
  role: WAREHOUSE_ENVELOPE.data.buckets.role[0],
  skills: [WAREHOUSE_ENVELOPE.data.buckets.skill[0], null, null],
  ai: { type: 'program', version: 1, body: [] },
  aiId: 'ai_cfg_1',
};
const CONFIGS_ENVELOPE = {
  ok: true,
  data: {
    slots: [{ slotId: 'slot1', name: '默认配置', isDefault: true, createdAt: 1, updatedAt: 2, loadout: CONFIG_LOADOUT, snapshot: { hash: 'h_1' } }],
    activeSlotId: 'slot1',
    maxSlots: 3,
  },
};
const AI_ENVELOPE = {
  ok: true,
  data: {
    items: [
      { aiId: 'ai_cfg_1', name: '新手AI', program: { type: 'program' }, createdAt: 1, updatedAt: 2 },
      { aiId: 'ai_cfg_2', name: '稳健AI', program: { type: 'program' }, createdAt: 3, updatedAt: 4 },
    ],
    count: 2,
    max: 100,
    usage: { ai_cfg_1: ['slot1'] },
  },
};

// 非管理员态下**可能出现的全部渲染**：14 屏 + 五类弹窗子态
//   （item-detail / config（提交③ 编辑器）/ slot-pick / plugin-pick / ai-pick）
//   —— 注册表里的每个非管理动作都应在此出现（「按钮永不消失」：无死按钮、无不可达入口）。
function configEditorState(view, modal) {
  const state = stateFor(view || 'hub');
  state.warehouse.envelope = WAREHOUSE_ENVELOPE;
  state.configs.data = CONFIGS_ENVELOPE;
  state.configs.ai = AI_ENVELOPE;
  state.configs.draft = { slotId: 'slot1', loadout: CONFIG_LOADOUT };
  state.modal = modal;
  return state;
}

function nonAdminRenderings() {
  const list = store.VIEWS.map((view) => stateFor(view));
  const itemDetail = stateFor('warehouse');
  itemDetail.warehouse.envelope = WAREHOUSE_ENVELOPE;
  itemDetail.modal = { kind: 'item-detail', uid: 'item_0' };
  list.push(itemDetail);
  // 提交③：编辑器（弹窗 A）+ 三个二级选择弹窗（弹窗 B）—— slot-set / ai-set / plugin-set /
  //   plugin-clear 只在二级弹窗里出现，故必须把它们作为可达状态纳入渲染集合
  list.push(configEditorState('hub', { kind: 'config', slotId: 'slot1' }));
  list.push(configEditorState('hub', { kind: 'slot-pick', slotId: 'slot1', pos: 'role' }));
  list.push(configEditorState('hub', { kind: 'plugin-pick', slotId: 'slot1', pos: 'role', idx: 0 }));
  list.push(configEditorState('hub', { kind: 'ai-pick', slotId: 'slot1' }));
  return list;
}

function htmlFor(view) {
  return render.render(format.viewModel(stateFor(view)));
}

function attrValues(html, attr) {
  const out = new Set();
  for (const m of html.matchAll(new RegExp(attr + '="([^"]*)"', 'g'))) if (m[1] !== '') out.add(m[1]);
  return out;
}

test('UI-1 public/ 文件清单与设计文档一致（无多无少）', () => {
  const onDisk = fs.readdirSync(PUBLIC_DIR).filter((f) => fs.statSync(path.join(PUBLIC_DIR, f)).isFile()).sort();
  assert.deepEqual(onDisk, EXPECTED_FILES.slice().sort(),
    `public/ 文件清单漂移：${onDisk.join(', ')}`);
});

test('UI-2 非管理员态全部屏的 data-action 集合 == 注册表的非管理动作集合（按钮永不无声，双向）', () => {
  const rendered = new Set();
  for (const state of nonAdminRenderings()) {
    for (const a of attrValues(render.render(format.viewModel(state)), 'data-action')) rendered.add(a);
  }
  const dead = [...rendered].filter((a) => ACTION_NAMES.indexOf(a) === -1);
  assert.deepEqual(dead, [], `渲染出的按钮没有实现分支（死按钮）：${dead.join(', ')}`);

  // F3 提交③ 口径（03-hub-warehouse-loadout.md §4 / §10 UW-2）：提交③ 落地配置编辑器后，
  //   「渲染集合 == 注册表中**非管理动作**集合」的口径不变，数字随实现推进：
  //     注册表 52 = F1 9 + F2 17（含 D-170 的 admin-account-patch）+ F3 提交② 17 + F3 提交③ 9
  //     非管理 35 = 52 − 17（管理动作）
  //   数字一律由**实际注册表**推出（不写死），失败时打印实际集合便于定位。
  const managed = ACTION_NAMES.filter((a) => !ADMIN_ACTIONS.has(a));
  const expected = [...new Set(managed)].sort();
  const extra = expected.filter((a) => !rendered.has(a));
  assert.deepEqual(extra, [], `注册了非管理动作但没有入口（不可达）：${extra.join(', ')}`);
  assert.equal(rendered.size, expected.length,
    `非管理员态动作数应等于注册表非管理动作数 ${expected.length}，实际 ${rendered.size}`);
  const leaked = [...rendered].filter((a) => ADMIN_ACTIONS.has(a));
  assert.deepEqual(leaked, [], `非管理员态渲染了管理动作：${leaked.join(', ')}`);
});

test('UI-3 每个动作都有可实现分支与非空标签', () => {
  for (const [name, def] of Object.entries(actions.ACTIONS)) {
    assert.equal(typeof def.run, 'function', `动作 ${name} 缺少 run 实现`);
    assert.ok(typeof def.label === 'string' && def.label !== '', `动作 ${name} 缺少可见标签`);
  }
});

test('UI-4 回车提交入口（data-enter）全部命中注册表，且每个 submit 按钮都绑定在它所在表单上', () => {
  const enter = new Set();
  for (const view of store.VIEWS) for (const a of attrValues(htmlFor(view), 'data-enter')) enter.add(a);
  // F1 三屏（login/register/password）+ F3 两屏（box/settings）
  assert.deepEqual([...enter].sort(), ['box-open', 'settings-nickname-save', 'submit-login', 'submit-password', 'submit-register']);
  for (const a of enter) assert.ok(ACTION_NAMES.indexOf(a) !== -1, `data-enter=${a} 不在注册表`);
  // 每个 submit 型按钮的 data-action 必须等于其所在表单的 data-enter（否则点按钮与回车会跑两个动作）
  for (const view of store.VIEWS) {
    const html = htmlFor(view);
    const formAction = (html.match(/<form data-enter="([^"]+)"/) || [])[1];
    const submits = [...html.matchAll(/<button type="submit" data-action="([^"]+)"/g)].map((m) => m[1]);
    for (const s of submits) assert.equal(s, formAction, `${view} 屏 submit 按钮 ${s} 与表单 data-enter=${formAction} 不一致`);
  }
});

test('UI-5 busy 状态下全部屏（含弹窗）的按钮都被禁用（防重复提交）', () => {
  const states = nonAdminRenderings();
  // 管理员两屏也要覆盖（F2 §4）
  const admin = store.initialState();
  admin.session = { token: 't', publicId: 'u_admin01', nickname: '管理员', expiresAt: null, isAdmin: true };
  admin.view = 'admin';
  states.push(admin);
  for (const state of states) {
    state.busy = true;
    const html = render.render(format.viewModel(state));
    const buttons = [...html.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    assert.ok(buttons.length > 0, `${state.view} 屏应至少有一个按钮`);
    for (const b of buttons) assert.ok(b.includes('disabled'), `${state.view} 屏 busy 时按钮未禁用：${b}`);
  }
});

test('UI-6 输入框数值来自状态（受控输入），且视图模型不含未投影值', () => {
  const state = stateFor('register');
  state.form.username = 'alice';
  const vm = format.viewModel(state);
  const userField = vm.fields.find((f) => f.name === 'username');
  assert.equal(userField.value, 'alice');
  for (const view of store.VIEWS) {
    const model = format.viewModel(stateFor(view));
    for (const line of model.lines) assert.ok(!String(line).includes('undefined'), `视图模型文本含 undefined：${line}`);
  }
});

test('UI-7 render.js 零逻辑：不读响应字段、不接触应用状态对象、不做投影', () => {
  const src = readPublic('render.js');
  assert.equal((src.match(/pick\(/g) || []).length, 0, 'render.js 不得出现 pick(');
  assert.ok(!/\bstate\b/.test(src), 'render.js 不得接触应用状态对象（只接收视图模型 vm）');
  for (const entry of contract.AUTH_FIELD_CONTRACT) {
    assert.ok(!src.includes(`'${entry.path}'`) && !src.includes(`"${entry.path}"`),
      `render.js 不得出现契约字段字面量：${entry.path}`);
  }
  assert.ok(!/\bfetch\(/.test(src), 'render.js 不得发请求');
});

test('UI-8 单一网络出口 / 单一 DOM 写入点', () => {
  const files = EXPECTED_FILES.filter((f) => f.endsWith('.js'));
  for (const f of files) {
    const src = readPublic(f);
    if (f !== 'api.js') assert.ok(!/\bfetch\(/.test(src), `${f} 不得调用 fetch（唯一出口 = api.js）`);
    if (f !== 'app.js') assert.ok(!src.includes('innerHTML'), `${f} 不得写 DOM（唯一写入点 = app.js）`);
  }
  assert.ok(readPublic('api.js').includes('fetch'), 'api.js 应持有唯一的 fetch 调用');
  assert.ok(readPublic('app.js').includes('innerHTML'), 'app.js 应持有唯一的 DOM 写入');
});

test('UI-9 响应字段只在 format.js 出现（投影单一真源）', () => {
  const files = EXPECTED_FILES.filter((f) => f.endsWith('.js') && f !== 'format.js' && f !== 'contract.js');
  for (const f of files) {
    const src = readPublic(f);
    for (const entry of contract.AUTH_FIELD_CONTRACT) {
      assert.ok(!src.includes(`'${entry.path}'`) && !src.includes(`"${entry.path}"`),
        `${f} 出现响应字段字面量 ${entry.path}（应只在 format.js 读取）`);
    }
  }
});

test('UI-10 动作注册表只依赖注入的 ctx（可用假 ctx 无头执行，不触 DOM）', async () => {
  const calls = [];
  const state = store.createStore(store.initialState()).getState();
  const ctx = {
    state,
    dispatch: (a) => calls.push(a),
    api: {},
    format,
    storage: { clear: () => calls.push({ type: 'storage.clear' }) },
    actions: actions.ACTIONS,
  };
  await actions.ACTIONS['goto-register'].run(ctx);
  assert.deepEqual(calls[calls.length - 1], { type: 'view.go', view: 'register' });
  calls.length = 0;
  await actions.ACTIONS['goto-password'].run(ctx);
  assert.deepEqual(calls.map((c) => c.type), ['form.clear', 'view.go']);
});

test('UI-11 客户端预校验拦在请求之前（空输入 / 格式 / 两次不一致）', async () => {
  const notes = [];
  const base = store.createStore(store.initialState()).getState();
  // 已登录态（设置密码屏只在有会话时可达），以便预校验先于鉴权分支生效
  base.session = { token: 'test-token', publicId: 'u_test', nickname: 't', expiresAt: null };
  const makeCtx = (form) => ({
    state: Object.assign({}, base, { form: Object.assign({}, base.form, form) }),
    dispatch: (a) => { if (a.type === 'notice.set') notes.push(a.notice.text); },
    api: { login: () => { throw new Error('不应发请求'); }, register: () => { throw new Error('不应发请求'); }, changePassword: () => { throw new Error('不应发请求'); } },
    format,
    storage: { clear: () => {} },
    actions: actions.ACTIONS,
  });
  await actions.ACTIONS['submit-login'].run(makeCtx({ username: '', password: '' }));
  assert.deepEqual(notes, ['请填写用户名与密码']);
  notes.length = 0;
  await actions.ACTIONS['submit-register'].run(makeCtx({ username: 'a!', password: 'pw12345678', confirm: 'pw12345678' }));
  assert.deepEqual(notes, ['用户名需 3~24 字符，且只含 [A-Za-z0-9_-]']);
  notes.length = 0;
  await actions.ACTIONS['submit-register'].run(makeCtx({ username: 'alice', password: 'pw12345678', confirm: 'pw87654321' }));
  assert.deepEqual(notes, ['两次输入的密码不一致']);
  notes.length = 0;
  await actions.ACTIONS['submit-password'].run(makeCtx({ oldPassword: 'pw12345678', newPassword: 'short', newConfirm: 'short' }));
  assert.deepEqual(notes, ['密码需 8~72 字符']);
});

test('UI-12 api.js 不解释信封（不读 ok/error/data），只回 transport', () => {
  const src = readPublic('api.js');
  assert.ok(!/\.error\b/.test(src), 'api.js 不得读 error 字段（信封解读属 format.js）');
  assert.ok(!/\bok\b\s*[=:]/.test(src), 'api.js 不得判定 ok');
  assert.equal(typeof api.createApi, 'function');
  assert.equal(typeof appMod.createApp, 'function');
  assert.equal(typeof appMod.createStorage, 'function');
});
