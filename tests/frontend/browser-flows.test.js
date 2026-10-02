'use strict';
/* tests/frontend/browser-flows.test.js —— 浏览器等价全链路（D-179）
 *
 * 与 quick-battle-flow / ai-editor-flow 等既有用例的区别：那些用例 `require` 模块后**直接调用动作函数**，
 *   于是绕过了两处真实缺陷的所在地：
 *     ① public/index.html 的脚本清单（漏载 ai-blueprint.js → 整屏崩 + busy 卡死）；
 *     ② render.js 的 targetAttrs / app.js 的 payloadOf（积木编辑器的 `node`/`preset` 载荷到不了动作）。
 * 本文件用 tests/helpers/browser.js 按 index.html 的真实清单装配前端（真 DOM 事件委托 + 真 HTTP），
 *   逐条重放用户实测的失败路径：
 *   BF-1  快速对战 → AI 逻辑查看器 → 读取回放 → 返回主界面（**全程不得卡死/全屏变灰**）
 *   BF-2  AI 编辑器：打开新手 AI → 加积木节点 → 保存 → 套用模板 → 保存 → 新建空白 → 返回列表
 *   BF-3  锦标赛 → 看这一场 → 翻页 → 排行榜（切榜/换范围）
 *   BF-4  渲染抛异常 → D-179 兜底屏（可操作，不是白屏/卡死；busy 复位）
 *   BF-5  动作同步抛异常 → 可见错误提示 + busy 复位（「按钮永不无声」）
 */
const test = require('node:test');
const assert = require('node:assert');
const { startServer, register } = require('../helpers/http.js');
const { createBrowser } = require('../helpers/browser.js');

const FAST_AUTH = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };
const SERVER = { rateLimitPerMinute: 100000 };

async function withServer(fn) {
  const s = await startServer({ prefix: 'dl-bf-', level: 'warn', authConfig: FAST_AUTH, server: SERVER });
  try {
    return await fn(s);
  } finally {
    await s.cleanup();
  }
}

// 装配一个"浏览器"；account 给定时预置 localStorage 的 token（走 boot 的 GET /me 落 hub）
async function browserFor(s, account) {
  const h = await createBrowser({
    baseUrl: s.baseUrl,
    storage: account ? [['dl.token', account.token]] : undefined,
  });
  assert.deepEqual(h.errors, [], '脚本装配抛异常');
  assert.equal(h.loaded.length, h.srcs.length, '有脚本未加载成功');
  assert.ok(await h.ready(), '启动自检未结束（booted 一直为 false）');
  return h;
}

function assertNoFatal(h, label) {
  assert.ok(!h.html.includes(h.DL.format.FATAL_TITLE),
    `${label}：界面落到 D-179 兜底屏 —— ${h.text().slice(0, 300)}`);
}

// notice 可能为 null（从未写过提示）
function noticeOf(h) {
  return h.state.notice && h.state.notice.text ? String(h.state.notice.text) : '';
}

// 点某个动作的"第一个可用按钮"（禁用按钮点不到，索引由渲染结果决定）
function clickEnabled(h, action) {
  const list = h.buttons(action);
  const idx = list.findIndex((b) => !b.disabled);
  assert.ok(idx >= 0, `当前屏没有可用的 ${action} 按钮（共 ${list.length} 个，全被禁用？）`);
  h.click(action, idx);
  return list[idx];
}

/* ---------- BF-1：用户实测的"卡死"路径 ---------- */

test('BF-1 快速对战全链路：登录 → 对局 → AI 逻辑查看器 → 读取回放 → 返回主界面（不得卡死）', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'bf1me');
    await register(s.port, 'bf1foe');            // 池内唯一对手
    const h = await browserFor(s, null);

    // 无 token → 登录屏；用真实表单提交（覆盖 app.js 的 submit 委托 + 输入事件）
    assert.ok(h.text().includes('登录'), `应渲染登录屏：${h.text().slice(0, 120)}`);
    h.type('username', me.username);
    h.type('password', me.password);
    h.submitForm('submit-login');
    await h.settle();
    assert.equal(h.state.view, 'hub', `登录后应落主界面：${noticeOf(h)}`);
    assert.equal(h.state.busy, false, '登录后 busy 必须复位');

    // 快速对战
    h.click('goto-quick');
    await h.settle();
    assert.equal(h.state.view, 'quick');
    h.click('quick-run');
    await h.settle();
    assert.ok(h.state.quick.envelope && h.DL.format.isOk(h.state.quick.envelope),
      `对局应成功：${noticeOf(h)}`);
    assert.equal(h.state.busy, false, '对局后 busy 必须复位');
    assertNoFatal(h, 'quick');
    const frames = h.state.viewer.frames;
    assert.ok(Array.isArray(frames) && frames.length > 0, '对局应带回内联帧');

    // ① AI 逻辑查看器（用户报"点了没反应"）
    assert.ok(!h.disabledActions().has('viewer-ai-logic'), 'AI 逻辑查看器按钮不该被禁用');
    h.click('viewer-ai-logic');
    await h.settle();
    assert.equal(h.state.busy, false, 'AI 逻辑查看器后 busy 必须复位');
    assert.equal(h.state.modal && h.state.modal.kind, 'ai-logic', `弹窗应打开：${noticeOf(h)}`);
    assertNoFatal(h, 'ai-logic');
    assert.ok(h.actions().has('modal-close'), '弹窗应有「关闭」按钮');
    h.click('modal-close');
    await h.settle();
    assert.equal(h.state.modal, null, '关闭后弹窗应消失');

    // ② 读取本场回放：该按钮只在「本屏有对局、但本场没有可显示的内联帧」时出现（format F6-2 的修法）
    //    这里模拟服务端只回 battleId 的情形（viewer.set 正是回放加载自己用的状态动作）
    h.app.dispatch({ type: 'viewer.set', frames: null, source: 'quick', battleId: h.state.viewer.battleId });
    const replayBtn = h.buttons('viewer-load-replay')[0];
    assert.ok(replayBtn, '无内联帧时应渲染「读取本场回放」按钮');
    assert.equal(replayBtn.disabled, false, '读取回放按钮不该被禁用');
    h.click('viewer-load-replay');
    await h.settle();
    assert.equal(h.state.busy, false, '读取回放后 busy 必须复位');
    assert.equal(h.state.viewer.source, 'replay', `回放应载入：${noticeOf(h)}`);
    assert.equal(h.state.viewer.frames.length, frames.length, '归档回放帧数应与内联帧一致');
    assertNoFatal(h, 'replay');

    // ③ 返回主界面：按钮必须可点（"全灰"就是这里暴露的）
    assert.ok(!h.disabledActions().has('goto-hub'), '返回主界面按钮被禁用 = 界面卡死');
    h.click('goto-hub');
    await h.settle();
    assert.equal(h.state.view, 'hub');
    assertNoFatal(h, 'hub');
    assert.equal(h.state.busy, false);
    // 主界面各入口按钮都还活着
    for (const a of ['goto-warehouse', 'goto-quick', 'goto-tournament', 'goto-ai-editor', 'goto-leaderboard']) {
      assert.ok(!h.disabledActions().has(a), `主界面 ${a} 被永久禁用（界面卡死）`);
    }
  });
});

/* ---------- BF-2：AI 编辑器（新手 AI + 积木节点载荷） ---------- */

function countNodes(bp) {
  let n = 0;
  const walk = (list) => {
    for (const it of Array.isArray(list) ? list : []) {
      n += 1;
      walk(it.inputs);
    }
  };
  walk(bp && bp.body);
  return n;
}

test('BF-2 AI 编辑器：打开新手 AI → 加积木节点 → 保存 → 套用模板 → 保存 → 新建空白 → 返回列表', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'bf2me');
    const h = await browserFor(s, me);
    assert.equal(h.state.view, 'hub');

    h.click('goto-ai-editor');
    await h.settle();
    assert.equal(h.state.view, 'ai-editor', `应进入 AI 编辑器：${noticeOf(h)}`);
    assertNoFatal(h, 'ai-editor 列表');

    // ① 打开新手 AI（用户报"新手ai无法打开"）
    const openBtn = h.buttons('ai-open')[0];
    assert.ok(openBtn, 'AI 列表里应有「打开」按钮');
    h.click('ai-open', 0);
    await h.settle();
    assertNoFatal(h, 'ai-editor 打开新手AI');
    assert.equal(h.state.busy, false, '打开后 busy 必须复位');
    assert.ok(h.state.aiEditor.draft, '应载入草稿');
    assert.equal(h.state.aiEditor.draft.type, 'blueprint', '新手 AI 应带蓝图（D-178）');
    assert.ok(h.state.aiEditor.draft.body.length > 0, '新手 AI 的蓝图不应为空');
    assert.ok(h.text().includes('积木'), '积木编辑器屏应有积木字样');
    assert.ok(h.text().includes('新手AI'), '屏上应出现该 AI 的名字');
    // D-179 修复：编辑**自己的** AI 时，其自身占用要扣掉 → 不该误报「节点不足」
    //   （服务端 PUT 用 excludeAiId 扣自身；前端不扣就会让玩家以为存不了）
    assert.ok(!h.text().includes('⚠ 节点不足'),
      `编辑自己的 AI 不该报节点不足：${h.text().slice(0, 400)}`);
    // 校验是后台动作（不置 busy）→ 必须显式等它落地（用真实服务端回执）
    const validated = await h.waitFor((x) => x.state.aiEditor.validate !== null);
    assert.ok(validated, '服务端校验回执应到达（ai.validate.set）');
    assert.equal(h.DL.format.aiValidateOk(h.state), true, `校验应通过：${JSON.stringify(h.state.aiEditor.validate)}`);

    // ② 加一个积木节点：**这一步判定 data-node 是否真的到达动作**（D-179 修复点）
    const before = countNodes(h.state.aiEditor.draft);
    const catalog = h.state.aiEditor.nodes.data.catalog;
    const kindOf = new Map(catalog.map((c) => [c.id, c.kind]));
    // 挑一个「无必填子节点」的语句节点（f_if/循环这类要带子节点，单独追加会合法性地失败）
    const minIn = new Map(catalog.map((c) => [c.id, c.inputs && typeof c.inputs.min === 'number' ? c.inputs.min : 0]));
    const addList = h.buttons('ai-node-append');
    const addIdx = addList.findIndex((b) => !b.disabled
      && kindOf.get(b.dataset.node) === 'stmt' && minIn.get(b.dataset.node) === 0);
    assert.ok(addIdx >= 0, '节点库里应有可用的「语句」积木节点（stmt 且无必填子节点）');
    const pickedNode = addList[addIdx].dataset.node;
    h.click('ai-node-append', addIdx);
    await h.settle();
    assert.equal(countNodes(h.state.aiEditor.draft), before + 1,
      `点「${pickedNode}」应真的把节点加进程序（data-node 载荷丢失则数量不变）`);
    assertNoFatal(h, 'ai-editor 加节点');
    assert.ok(await h.waitFor((x) => x.state.aiEditor.validate !== null), '加节点后应收到新的校验回执');

    // ③ 保存（编辑既有条目 → PUT）
    const saveBtn = h.buttons('ai-save')[0];
    assert.equal(saveBtn.disabled, false, `服务端校验通过后「保存」应可用：${h.text().slice(0, 200)}`);
    h.click('ai-save');
    await h.settle();
    assert.equal(h.state.busy, false, '保存后 busy 必须复位');
    assert.ok(!/内部错误/.test(noticeOf(h)), `保存不得报内部错误：${noticeOf(h)}`);
    assert.ok(/保存|已保存/.test(noticeOf(h)), `保存应有成功文案：${noticeOf(h)}`);
    assert.equal(h.state.aiEditor.dirty, false, '保存后应回到「无改动」态');
    assertNoFatal(h, 'ai-editor 保存');

    // ④ 套用模板（**这一步判定 data-preset 是否真的到达动作**）
    const presetBtn = h.buttons('ai-bp-preset')[0];
    assert.ok(presetBtn, '模板区应有模板按钮');
    assert.ok(presetBtn.dataset.preset, '模板按钮必须携带 data-preset（否则点了只会报"模板不在清单里"）');
    const presetId = presetBtn.dataset.preset;
    h.click('ai-bp-preset', 0);
    await h.settle();
    assert.equal(h.state.busy, false);
    assert.ok(await h.waitFor((x) => x.state.aiEditor.validate !== null), '套用模板后应收到新的校验回执');
    assert.ok(!/模板不在/.test(noticeOf(h)), `套用模板不该报"模板不在清单里"（data-preset 丢失？）：${noticeOf(h)}`);
    const presets = h.state.aiEditor.nodes.data.presets;
    const picked = presets.find((p) => p.id === presetId);
    assert.ok(picked, 'data-preset 应是本次读到的模板 id');
    assert.equal(countNodes(h.state.aiEditor.draft), countNodes(picked.blueprint), '套用模板应整套替换程序');
    assertNoFatal(h, 'ai-editor 套用模板');

    // 套用后再保存一次（走 PUT 的完整编译 + 节点占用校验）
    h.click('ai-save');
    await h.settle();
    assert.equal(h.state.busy, false);
    assert.ok(!/内部错误/.test(noticeOf(h)), `套用模板后保存不得报内部错误：${noticeOf(h)}`);
    assert.ok(/保存|已保存/.test(noticeOf(h)), `套用模板后应有保存成功文案：${noticeOf(h)}`);

    // ⑤ 新建空白蓝图（空蓝图的另一个分支）
    clickEnabled(h, 'ai-bp-new');
    await h.settle();
    assert.equal(h.state.busy, false, '新建空白后 busy 必须复位');
    assertNoFatal(h, 'ai-editor 空白蓝图');
    assert.equal(countNodes(h.state.aiEditor.draft), 0, '空白蓝图应没有节点');
    assert.ok(h.text().includes('空蓝图'), '空蓝图应有引导行');

    // ⑥ 返回列表：有未保存改动 → 先弹「确认丢弃」（ai-close 的脏草稿分支）
    assert.ok(h.buttons('ai-close')[0], '编辑屏应有「返回列表」按钮');
    h.click('ai-close');
    await h.settle();
    assert.equal(h.state.busy, false);
    assert.ok(h.buttons('ai-discard-yes')[0], '脏草稿时关闭应先要求确认丢弃');
    h.click('ai-discard-yes');
    await h.settle();
    assertNoFatal(h, 'ai-editor 返回列表');
    assert.equal(h.state.busy, false);
    assert.ok(h.text().includes('打开'), `返回列表后应回到列表屏：${h.text().slice(0, 120)}`);
  });
});

/* ---------- BF-3：锦标赛 + 排行榜 ---------- */

test('BF-3 锦标赛全链路：跑批次 → 看这一场 → 翻页 → 排行榜切榜换范围', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'bf3me');
    await register(s.port, 'bf3foe0');
    await register(s.port, 'bf3foe1');
    const h = await browserFor(s, me);

    h.click('goto-tournament');
    await h.settle();
    assert.equal(h.state.view, 'tournament');
    h.click('tournament-run');
    await h.settle();
    assert.equal(h.state.busy, false, '锦标赛后 busy 必须复位');
    assert.ok(h.state.tournament.envelope && h.DL.format.isOk(h.state.tournament.envelope),
      `批次应成功：${noticeOf(h)}`);
    assertNoFatal(h, 'tournament');

    // 「看这一场」：挑一个有帧的场次
    const results = h.state.tournament.envelope.data.results;
    const idx = results.findIndex((r) => Array.isArray(r.frames) && r.frames.length > 0);
    assert.ok(idx >= 0, '批次结果应带回内联帧');
    h.click('tournament-open-battle', idx);
    await h.settle();
    assert.equal(h.state.viewer.source, 'tournament');
    assert.equal(h.state.busy, false);
    assertNoFatal(h, 'tournament 看这一场');

    // 翻页（纯本地）
    const pageBefore = h.state.tournament.page;
    h.click('tournament-page-next');
    await h.settle();
    assert.ok(h.state.tournament.page >= pageBefore, '翻页不得回退');

    // 排行榜：进屏是**空态**（按设计要用户点「积分榜/段位榜/刷新」才取数）
    h.click('goto-leaderboard');
    await h.settle();
    assert.equal(h.state.view, 'leaderboard');
    assertNoFatal(h, 'leaderboard 空态');
    assert.ok(h.text().includes('尚未读取榜单'), `进屏应给出去取数的引导：${h.text().slice(0, 160)}`);
    h.click('board-refresh');
    await h.settle();
    assert.ok(h.state.board.envelope && h.DL.format.isOk(h.state.board.envelope),
      `点刷新后榜单应加载：${noticeOf(h)}`);
    assert.equal(h.state.busy, false);
    assertNoFatal(h, 'leaderboard 已加载');
    h.click('board-tier');
    await h.settle();
    assert.equal(h.state.board.board, 'arrival', '应切到段位榜');
    assert.equal(h.state.busy, false);
    assertNoFatal(h, 'leaderboard 段位榜');
    h.click('board-scope', 0);
    await h.settle();
    assert.equal(h.state.board.scope, 'global', '「全部」范围应切回 global');
    assert.equal(h.state.busy, false);
    assertNoFatal(h, 'leaderboard 范围切换');
    h.click('goto-hub');
    await h.settle();
    assert.equal(h.state.view, 'hub');
    assertNoFatal(h, 'hub（锦标赛之后）');
  });
});

/* ---------- BF-4 / BF-5：D-179 的两道兜底 ---------- */

test('BF-4 渲染抛异常 → 落到可操作的兜底屏（不是白屏/卡死），且 busy 被复位', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'bf4me');
    const h = await browserFor(s, me);
    const real = h.DL.format.viewModel;
    h.DL.format.viewModel = function () { throw new Error('模拟投影崩溃'); };
    try {
      h.app.dispatch({ type: 'busy.set', busy: true });   // 模拟"异常前已置 busy"
      h.app.dispatch({ type: 'notice.set', notice: { kind: 'info', text: '触发重绘' } });
      assert.ok(h.html.includes('界面内部错误'), `应渲染兜底屏：${h.text().slice(0, 200)}`);
      assert.equal(h.state.busy, false, '渲染失败必须复位 busy（否则全屏按钮永久变灰）');
      assert.ok(h.actions().has('goto-hub'), '兜底屏必须有可点的返回按钮');
      assert.ok(!h.disabledActions().has('goto-hub'), '兜底屏的返回按钮不得被禁用');
    } finally {
      h.DL.format.viewModel = real;
    }
    // 恢复后点「返回主界面」应真的回到主界面
    h.click('goto-hub');
    await h.settle();
    assert.equal(h.state.view, 'hub');
    assertNoFatal(h, '兜底屏返回');
  });
});

test('BF-5 动作同步抛异常 → 可见错误提示 + busy 复位（按钮永不无声）', async () => {
  await withServer(async (s) => {
    const me = await register(s.port, 'bf5me');
    const h = await browserFor(s, me);
    const real = h.DL.actions.ACTIONS['refresh-hub'].run;
    h.DL.actions.ACTIONS['refresh-hub'].run = function () { throw new Error('模拟同步崩溃'); };
    try {
      h.click('refresh-hub');
      await h.settle();
      assert.match(noticeOf(h), /内部错误.*模拟同步崩溃/, `应可见地报错：${noticeOf(h)}`);
      assert.equal(h.state.busy, false, '同步异常后 busy 必须复位');
      assertNoFatal(h, '同步异常');
    } finally {
      h.DL.actions.ACTIONS['refresh-hub'].run = real;
    }
    // 恢复后功能正常
    h.click('refresh-hub');
    await h.settle();
    assert.ok(!/内部错误/.test(noticeOf(h)), `恢复后应正常：${noticeOf(h)}`);
  });
});
