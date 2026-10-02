'use strict';
/* tests/frontend/ai-editor-actions.test.js —— AI 编辑器**全部动作**的行为覆盖（D-179）
 *
 * 背景（独立审计结论）：public/actions.js 注册了 105 个动作，其中 24 个的 `run()` **从未被任何测试执行**
 *   —— 它们只在注册表/渲染层面被核对过（UI-1/AU-1 的"渲染集合 == 注册表"）。也就是说：
 *   这些按钮"渲染得出来、点下去从没被测过"。其中一处（积木编辑屏不渲染导入区/丢弃确认）
 *   在补测时立刻暴露出真实缺陷。本文件逐条执行这些动作并断言真实效果。
 *
 * 覆盖清单（AE2-*）：
 *   AE2-1 旧 AST 编辑器结构操作：ai-new / ai-insert / ai-replace / ai-select-node / ai-move-up / ai-move-down
 *         / ai-wrap-if / ai-delete-node / ai-slot-clear / ai-block-remove / ai-set-literal-type / ai-validate
 *   AE2-2 旧 AST 编辑器：ai-save-as（另存为新条目，真 HTTP）
 *   AE2-3 旧 AST 编辑器：ai-import-open / ai-import-apply / ai-import-close
 *   AE2-4 积木编辑器树上行操作：ai-node-up / ai-node-down / ai-node-del / ai-validate / ai-refresh
 *   AE2-5 积木编辑器：ai-import-open / ai-import-apply / ai-import-close（按草稿类型选解析器）
 *   AE2-6 关闭与丢弃：ai-close → ai-discard-no（留下）→ ai-close → ai-discard-yes（关掉）
 *   AE2-7 列表：ai-delete → ai-confirm-no（取消不删）+ ai-refresh；登录屏 goto-login
 *   AE2-8 管理面板：admin-account-patch（段位/积分，真 HTTP + 真管理员身份）
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer, register } = require('../helpers/http.js');
const { createBrowser } = require('../helpers/browser.js');

const FAST_AUTH = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };
const SERVER = { rateLimitPerMinute: 100000 };

async function withServer(fn, extra) {
  const s = await startServer({
    prefix: 'dl-ae2-', level: 'warn', authConfig: FAST_AUTH, server: Object.assign({}, SERVER, extra || {}),
  });
  try {
    return await fn(s);
  } finally {
    await s.cleanup();
  }
}

async function browserFor(s, account) {
  const h = await createBrowser({ baseUrl: s.baseUrl, storage: account ? [['dl.token', account.token]] : undefined });
  assert.deepEqual(h.errors, [], '脚本装配抛异常');
  assert.ok(await h.ready(), '启动自检未结束');
  return h;
}

function noticeOf(h) { return h.state.notice && h.state.notice.text ? String(h.state.notice.text) : ''; }

function assertNoFatal(h, label) {
  assert.ok(!h.html.includes(h.DL.format.FATAL_TITLE), `${label}：落到兜底屏 —— ${h.text().slice(0, 300)}`);
}

// 在当前屏上按 dataset 字段找按钮下标（找不到返回 -1）
function indexOf(h, action, key, value) {
  const list = h.buttons(action);
  for (let i = 0; i < list.length; i += 1) {
    if (value === undefined) { if (!list[i].disabled) return i; continue; }
    if (list[i].dataset[key] === value) return i;
  }
  return -1;
}

function clickBy(h, action, key, value, label) {
  const i = indexOf(h, action, key, value);
  assert.ok(i >= 0, `${label || action}：当前屏找不到 ${action}${key ? `[${key}=${value}]` : ''}`);
  h.click(action, i);
  return h.buttons(action)[i];
}

// 旧 AST 程序里语句条数（body.statements）
function stmtCount(h) {
  const d = h.state.aiEditor.draft;
  return d && d.body && Array.isArray(d.body.statements) ? d.body.statements.length : -1;
}

function bpCount(bp) {
  let n = 0;
  const walk = (list) => { for (const it of Array.isArray(list) ? list : []) { n += 1; walk(it.inputs); } };
  walk(bp && bp.body);
  return n;
}

/* ---------- AE2-1 / AE2-2 / AE2-3：旧 AST 编辑器 ---------- */

test('AE2-1 旧 AST 编辑器：插入/替换/上移/下移/包裹/删块/清槽/删节点/设值类型/重新校验', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'ae2a');
    const h = await browserFor(s, me);
    h.click('goto-ai-editor');
    await h.settle();

    // ai-new：新建 AI 走**旧 AST 编辑器**（空程序 = 一条 wait，天生合法）
    h.click('ai-new');
    await h.settle();
    assertNoFatal(h, 'ai-new');
    assert.equal(stmtCount(h), 1, '新建 AI 的初始程序应有一条语句（wait）');
    assert.ok(h.text().includes('当前节点'), '应渲染旧 AST 编辑器（含当前节点表单）');
    assert.ok(await h.waitFor((x) => x.state.aiEditor.validate !== null), 'ai-new 后应收到校验回执');

    // ai-validate（按钮自身的 run 此前从未被执行）
    const before = h.state.aiEditor.validate;
    h.click('ai-validate');
    assert.ok(await h.waitFor((x) => x.state.aiEditor.validate !== before), 'ai-validate 应刷新校验回执');
    assert.equal(h.DL.format.aiValidateOk(h.state), true, `校验应通过：${noticeOf(h)}`);

    // ai-insert：把光标放在隐式主循环（body）里插入一条动作语句
    clickBy(h, 'ai-select-node', 'addr', 'body', '选中主循环');
    await h.settle();
    clickBy(h, 'ai-insert', 'value', 'action', '插入动作');
    await h.settle();
    assert.equal(stmtCount(h), 2, `插入后语句数应为 2：${noticeOf(h)}`);
    assert.equal(h.state.aiEditor.cursor, 'body.s[1]', '插入后光标应落在新语句上');

    // ai-replace：把新语句换成循环（结构类替换）
    clickBy(h, 'ai-replace', 'value', 'loop', '替换为循环');
    await h.settle();
    assert.equal(h.state.aiEditor.draft.body.statements[1].type, 'loop', `替换应生效：${noticeOf(h)}`);

    // ai-move-up / ai-move-down：交换两条语句
    const firstType = h.state.aiEditor.draft.body.statements[0].type;
    clickBy(h, 'ai-move-up', undefined, undefined, '上移');
    await h.settle();
    assert.equal(h.state.aiEditor.draft.body.statements[0].type, 'loop', '上移后循环应到第 1 条');
    clickBy(h, 'ai-move-down', undefined, undefined, '下移');
    await h.settle();
    assert.equal(h.state.aiEditor.draft.body.statements[0].type, firstType, '下移后应恢复原顺序');

    // ai-wrap-if：把当前语句包进「如果」
    clickBy(h, 'ai-wrap-if', undefined, undefined, '包裹进如果');
    await h.settle();
    assert.equal(h.state.aiEditor.draft.body.statements[1].type, 'if', `包裹后应为 if：${noticeOf(h)}`);

    // ai-insert 到表达式槽（if 的 cond 槽地址由渲染出来的行给出，不硬编码）→ 再 ai-set-literal-type
    const condBtn = h.buttons('ai-select-node').find((b) => /\.cond$/.test(b.dataset.addr || ''));
    assert.ok(condBtn, 'if 节点应渲染 cond 表达式槽的「选中」');
    clickBy(h, 'ai-select-node', 'addr', condBtn.dataset.addr, '选中条件表达式槽');
    await h.settle();
    clickBy(h, 'ai-insert', 'value', 'literal', '插入常量');
    await h.settle();
    assert.equal(h.state.aiEditor.cursor, condBtn.dataset.addr, '插入后光标应落在表达式槽上');
    const litButtons = h.buttons('ai-set-literal-type');
    assert.ok(litButtons.length >= 2, `常量节点应渲染「值类型」按钮：${h.text().slice(-200)}`);
    clickBy(h, 'ai-set-literal-type', 'value', 'string', '设为文本');
    await h.settle();
    assert.equal(typeof h.state.aiEditor.draft.body.statements[1].cond.value, 'string',
      `值类型切换后应是字符串形态：${JSON.stringify(h.state.aiEditor.draft.body.statements[1].cond)}`);

    // 回到「如果」节点本体：此时同时有「语句块」与「表达式槽」两组行
    clickBy(h, 'ai-select-node', 'addr', 'body.s[1]', '选中 if 节点');
    await h.settle();

    // ai-block-remove：移掉「如果」的一个子块（then/else 之一）
    const blockBtn = h.buttons('ai-block-remove').find((b) => !b.disabled);
    assert.ok(blockBtn, `应存在可移除的语句块：${h.text().slice(-260)}`);
    clickBy(h, 'ai-block-remove', 'addr', blockBtn.dataset.addr, '移除语句块');
    await h.settle();
    assertNoFatal(h, 'ai-block-remove');

    // ai-slot-clear：清掉一个表达式槽（cond 已被上面的插入填上 → 可清）
    const slotBtn = h.buttons('ai-slot-clear').find((b) => !b.disabled);
    assert.ok(slotBtn, '应存在可清空的表达式槽');
    clickBy(h, 'ai-slot-clear', 'addr', slotBtn.dataset.addr, '清空表达式');
    await h.settle();
    assertNoFatal(h, 'ai-slot-clear');

    // ai-delete-node：删除当前选中的语句（回到主循环再选一条语句删）
    clickBy(h, 'ai-select-node', 'addr', 'body.s[1]', '选中第 2 条语句');
    await h.settle();
    const n1 = stmtCount(h);
    clickBy(h, 'ai-delete-node', undefined, undefined, '删除节点');
    await h.settle();
    assert.equal(stmtCount(h), n1 - 1, `删除后语句数应减一：${noticeOf(h)}`);
    assertNoFatal(h, 'AE2-1');
  });
});

test('AE2-2 旧 AST 编辑器：ai-save-as 另存为新条目（真 HTTP）', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'ae2b');
    const h = await browserFor(s, me);
    h.click('goto-ai-editor');
    await h.settle();
    h.click('ai-new');
    await h.settle();
    await h.waitFor((x) => x.state.aiEditor.validate !== null);

    const countBefore = (h.state.aiEditor.list && h.state.aiEditor.list.data && h.state.aiEditor.list.data.items
      ? h.state.aiEditor.list.data.items.length : 0);

    const saveAs = h.buttons('ai-save-as')[0];
    assert.ok(saveAs, '旧 AST 编辑器应渲染「另存为新的 AI」');
    assert.equal(saveAs.disabled, false, `校验通过后应可另存：${h.text().slice(0, 200)}`);
    h.click('ai-save-as');
    await h.settle();
    assert.equal(h.state.busy, false, '另存后 busy 必须复位');
    assert.ok(!/内部错误/.test(noticeOf(h)), `另存不得报内部错误：${noticeOf(h)}`);
    const countAfter = (h.state.aiEditor.list && h.state.aiEditor.list.data && h.state.aiEditor.list.data.items
      ? h.state.aiEditor.list.data.items.length : 0);
    assert.equal(countAfter, countBefore + 1, `另存应新增一条 AI：${noticeOf(h)}`);
    assertNoFatal(h, 'AE2-2');
  });
});

test('AE2-3 旧 AST 编辑器：导入 JSON（打开 → 应用 → 关闭）', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'ae2c');
    const h = await browserFor(s, me);
    h.click('goto-ai-editor');
    await h.settle();
    h.click('ai-new');
    await h.settle();
    await h.waitFor((x) => x.state.aiEditor.validate !== null);

    // ai-import-open：打开导入区（textarea 出现，且内容 = 当前草稿的导出文本）
    assert.equal(h.fields().filter((f) => f.name === 'aiImport').length, 0, '导入区默认不应出现');
    h.click('ai-import-open');
    await h.settle();
    assert.ok(h.state.aiEditor.importOpen === true, '点击后应进入导入态');
    const box = h.fields().find((f) => f.name === 'aiImport');
    assert.ok(box, '导入态应渲染 textarea（name=aiImport）');
    assert.ok(box.value.includes('"program"'), `导出文本应是程序 JSON：${box.value.slice(0, 80)}`);

    // 粘贴一份改过的程序并应用
    const program = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'defend' }] } };
    h.type('aiImport', JSON.stringify(program));
    h.click('ai-import-apply');
    await h.settle();
    assert.equal(h.state.aiEditor.importOpen, false, '应用后应关闭导入区');
    assert.equal(h.state.aiEditor.draft.body.statements[0].name, 'defend', `导入应替换草稿：${noticeOf(h)}`);
    assertNoFatal(h, 'AE2-3 应用');

    // 关闭路径：再打开导入区 → ai-import-close
    h.click('ai-import-open');
    await h.settle();
    h.type('aiImport', '{ 坏 JSON');
    h.click('ai-import-close');
    await h.settle();
    assert.equal(h.state.aiEditor.importOpen, false, '取消导入应关闭导入区');
    assert.equal(h.state.aiEditor.importText, '', '取消导入应丢弃文本');
    assert.equal(h.state.aiEditor.draft.body.statements[0].name, 'defend', '取消导入不得改草稿');
    assertNoFatal(h, 'AE2-3');
  });
});

/* ---------- AE2-4 / AE2-5：积木编辑器 ---------- */

async function openStarter(h) {
  h.click('goto-ai-editor');
  await h.settle();
  h.click('ai-open', 0);
  await h.settle();
  assert.equal(h.state.aiEditor.draft.type, 'blueprint', '应打开积木蓝图草稿');
  await h.waitFor((x) => x.state.aiEditor.validate !== null);
}

test('AE2-4 积木编辑器：树上行操作（上移/下移/删除）+ 重新校验 + 列表刷新', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'ae2d');
    const h = await browserFor(s, me);
    await openStarter(h);

    const order0 = h.state.aiEditor.draft.body.map((n) => n.uid);
    // 新手 AI 顶层只有 1 个节点（一个 if 套住全部）→ 先补一个顶层节点，让上下移有对象
    if (order0.length < 2) {
      const catalog = h.state.aiEditor.nodes.data.catalog;
      const minIn = new Map(catalog.map((c) => [c.id, c.inputs && typeof c.inputs.min === 'number' ? c.inputs.min : 0]));
      const kindOf = new Map(catalog.map((c) => [c.id, c.kind]));
      const addList = h.buttons('ai-node-append');
      const addIdx = addList.findIndex((b) => !b.disabled && kindOf.get(b.dataset.node) === 'stmt' && minIn.get(b.dataset.node) === 0);
      assert.ok(addIdx >= 0, '节点库里应有可用的语句节点');
      h.click('ai-node-append', addIdx);
      await h.settle();
    }
    const baseline = h.state.aiEditor.draft.body.map((n) => n.uid);
    assert.ok(baseline.length >= 2, '补齐后顶层应有至少两个节点');

    // 下移第一个节点 → 顺序变化
    clickBy(h, 'ai-node-down', 'addr', 'body[0]', '下移首节点');
    await h.settle();
    const afterDown = h.state.aiEditor.draft.body.map((n) => n.uid);
    assert.deepEqual(afterDown, [baseline[1], baseline[0]].concat(baseline.slice(2)), `下移应交换前两个：${noticeOf(h)}`);

    // 上移回来
    clickBy(h, 'ai-node-up', 'addr', 'body[1]', '上移');
    await h.settle();
    assert.deepEqual(h.state.aiEditor.draft.body.map((n) => n.uid), baseline, '上移应恢复原顺序');

    // 删除第一个顶层节点（它会带走整棵子树 → 用"顶层条数"判定）
    const n0 = h.state.aiEditor.draft.body.length;
    clickBy(h, 'ai-node-del', 'addr', 'body[0]', '删除节点');
    await h.settle();
    assert.equal(h.state.aiEditor.draft.body.length, n0 - 1, `删除应少一个顶层节点：${noticeOf(h)}`);
    assertNoFatal(h, 'ai-node-del');

    // 重新校验（积木模式的 ai-validate）
    assert.ok(await h.waitFor((x) => x.state.aiEditor.validate !== null), '删除后应有校验回执');
    h.click('ai-validate');
    await h.settle();
    assert.ok(await h.waitFor((x) => x.state.aiEditor.validate !== null), 'ai-validate 后仍应有回执');
    assertNoFatal(h, 'ai-validate');

    // ai-refresh（列表屏按钮）：回到列表再刷新
    h.click('ai-close');
    await h.settle();
    if (h.buttons('ai-discard-yes').length > 0) { h.click('ai-discard-yes'); await h.settle(); }
    assert.ok(h.buttons('ai-refresh').length > 0, '列表屏应有「刷新」');
    h.click('ai-refresh');
    await h.settle();
    assert.equal(h.state.busy, false, 'refresh 后 busy 必须复位');
    assert.ok(h.state.aiEditor.list && h.state.aiEditor.list.data, '刷新后应拿到 AI 库列表');
    assertNoFatal(h, 'ai-refresh');
  });
});

test('AE2-5 积木编辑器：导入 JSON 按**蓝图**解析（打开 → 应用 → 取消）', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'ae2e');
    const h = await browserFor(s, me);
    await openStarter(h);

    h.click('ai-import-open');
    await h.settle();
    const box = h.fields().find((f) => f.name === 'aiImport');
    assert.ok(box, '积木编辑器应渲染导入区（此前不渲染 → 按钮点了没反应）');
    assert.ok(box.value.includes('"blueprint"'), `积木草稿的导出文本应是蓝图 JSON：${box.value.slice(0, 80)}`);

    const preset = h.state.aiEditor.nodes.data.presets[1];
    h.type('aiImport', JSON.stringify(preset.blueprint));
    h.click('ai-import-apply');
    await h.settle();
    assert.equal(h.state.aiEditor.importOpen, false, '应用后应关闭导入区');
    assert.equal(bpCount(h.state.aiEditor.draft), bpCount(preset.blueprint), `导入的蓝图应整套生效：${noticeOf(h)}`);
    assert.equal(h.state.aiEditor.draft.type, 'blueprint', '导入后仍是蓝图草稿');
    assertNoFatal(h, 'AE2-5 应用');

    // 坏输入 → 可见错误（不是内部错误、不是静默）
    h.click('ai-import-open');
    await h.settle();
    h.type('aiImport', '{"type":"program"}');
    h.click('ai-import-apply');
    await h.settle();
    assert.match(noticeOf(h), /blueprint/, `非蓝图输入应给出可读错误：${noticeOf(h)}`);
    h.click('ai-import-close');
    await h.settle();
    assert.equal(h.state.aiEditor.importOpen, false);
    assertNoFatal(h, 'AE2-5');
  });
});

/* ---------- AE2-6：关闭与丢弃 ---------- */

test('AE2-6 ai-close/ai-discard-*：脏草稿先问、取消留下、确认才关（两种编辑器都要有弹层）', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'ae2f');
    const h = await browserFor(s, me);
    await openStarter(h);
    assert.equal(h.state.aiEditor.dirty, false, '刚打开应是干净草稿');

    // 干净草稿：直接关闭（不弹层）
    h.click('ai-close');
    await h.settle();
    assert.equal(h.buttons('ai-discard-yes').length, 0, '干净草稿不该弹「确认丢弃」');
    assert.ok(h.buttons('ai-refresh').length > 0, '应回到列表屏');

    // 脏草稿：先弹层；「取消」→ 留在编辑器
    h.click('ai-open', 0);
    await h.settle();
    clickBy(h, 'ai-node-del', 'addr', 'body[0]', '删除节点使草稿变脏');
    await h.settle();
    assert.equal(h.state.aiEditor.dirty, true, '改过之后草稿应变脏');
    h.click('ai-close');
    await h.settle();
    assert.ok(h.buttons('ai-discard-yes').length > 0, '脏草稿关闭应弹「确认丢弃」（积木屏此前不渲染该弹层）');
    h.click('ai-discard-no');
    await h.settle();
    assert.equal(h.state.aiEditor.confirm, null, '取消后弹层应消失');
    assert.equal(h.state.aiEditor.mode, 'edit', '取消后应留在编辑器');

    // 再关一次 → 确认丢弃 → 回列表
    h.click('ai-close');
    await h.settle();
    h.click('ai-discard-yes');
    await h.settle();
    assert.ok(h.buttons('ai-refresh').length > 0, '确认丢弃后应回到列表屏');
    assertNoFatal(h, 'AE2-6');
  });
});

/* ---------- AE2-7：列表删除取消 + 登录屏返回 ---------- */

test('AE2-7 列表：ai-delete → ai-confirm-no 取消不删；登录屏 goto-login 可回', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'ae2g');
    const h = await browserFor(s, me);
    h.click('goto-ai-editor');
    await h.settle();
    const count0 = h.state.aiEditor.list.data.items.length;

    h.click('ai-delete', 0);
    await h.settle();
    assert.equal(h.state.aiEditor.confirm && h.state.aiEditor.confirm.kind, 'delete', '应进入删除确认');
    assert.ok(h.buttons('ai-confirm-no').length > 0, '删除确认应有「取消」');
    h.click('ai-confirm-no');
    await h.settle();
    assert.equal(h.state.aiEditor.confirm, null, '取消后确认态应清空');
    const count1 = h.state.aiEditor.list.data.items.length;
    assert.equal(count1, count0, '取消删除不得真的删掉条目');
    assertNoFatal(h, 'AE2-7 取消删除');

    // goto-login：注册屏的「返回登录」（logout 按钮在设置屏）
    h.click('goto-hub');
    await h.settle();
    h.click('goto-settings');
    await h.settle();
    h.click('logout');
    await h.settle();
    assert.equal(h.state.view, 'login', '登出应回登录屏');
    h.click('goto-register');
    await h.settle();
    assert.equal(h.state.view, 'register');
    h.click('goto-login');
    await h.settle();
    assert.equal(h.state.view, 'login', '「返回登录」应回登录屏（该动作此前从未被执行）');
    assertNoFatal(h, 'AE2-7');
  });
});

/* ---------- AE2-8：管理面板的「改账号」（此前只有服务端 op 被测过） ---------- */

test('AE2-8 admin-account-patch：管理员从面板改目标账号段位/积分（真 HTTP）', async () => {
  const ADMIN = 'adm-token-ae2';
  const adminName = 'ae2admin';
  await withServer(async (s) => {
    const target = await register(s.port, 'ae2target');
    const admin = await register(s.port, adminName);
    const h = await browserFor(s, admin);
    h.app.dispatch({ type: 'session.set', token: admin.token, publicId: admin.publicId, nickname: admin.nickname, isAdmin: true });
    h.click('goto-admin');
    await h.settle();
    assert.equal(h.state.view, 'admin');

    // 本地拦截分支：目标为空 → 可见提示、不发请求
    h.click('admin-account-patch');
    await h.settle();
    assert.ok(/publicId/.test(String(h.state.admin.result && h.state.admin.result.text)),
      `空目标应本地拦下：${JSON.stringify(h.state.admin.result)}`);
    // 「段位与积分都空」的本地拦截
    h.type('adminPatchPublicId', target.publicId);
    h.click('admin-account-patch');
    await h.settle();
    assert.ok(/至少要填/.test(String(h.state.admin.result && h.state.admin.result.text)),
      `两个字段都空应本地拦下：${JSON.stringify(h.state.admin.result)}`);

    // 真改：publicId + 段位 + 积分
    h.type('adminPatchPublicId', target.publicId);
    h.type('adminPatchTier', 'rare');
    h.type('adminPatchPoints', '321');
    h.click('admin-account-patch');
    await h.settle();
    assert.equal(h.state.busy, false, '改账号后 busy 必须复位');
    assert.ok(!/内部错误/.test(noticeOf(h)), `不得报内部错误：${noticeOf(h)}`);
    assert.ok(h.state.admin.result && /321|rare/.test(String(h.state.admin.result.text)),
      `结果区应回带改后的段位/积分：${JSON.stringify(h.state.admin.result)}`);

    // 服务端真值核对（直接查 /me）
    const { request, authed } = require('../helpers/http.js');
    const meRes = await request(s.port, 'GET', '/api/v1/me', undefined, authed(target.token));
    assert.equal(meRes.body.data.progress.tier, 'rare', '目标账号段位应已改为 rare');
    assert.equal(meRes.body.data.rating.points, 321, '目标账号积分应已改为 321');
    assertNoFatal(h, 'AE2-8');
  }, { env: { DL_ADMIN_TOKEN: ADMIN, DL_ADMIN_USERS: adminName } });
});
