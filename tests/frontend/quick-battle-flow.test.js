'use strict';
/* tests/frontend/quick-battle-flow.test.js —— F6 快速对战屏（真实 HTTP + 机器核对）
 *
 * 权威：docs/frontend/04-quickmatch.md §3/§4/§5/§6/§8/§10（QB-1…QB-10）。
 * 与浏览器完全同构：public/{store,format,render,actions,api}.js（fetch 由 Node 内建提供，baseUrl 指向进程内真实服务）。
 *
 * 覆盖：
 *   QB-1  真实对局：结果行逐字由真实字段拼出；帧数与 ticks 同源；state.viewer 与响应同源
 *   QB-2  帧投影：全帧遍历无 undefined/null 泄漏；首帧/末帧（判决行）结构完整
 *   QB-3  步进动作：夹取边界 + 本地动作不发请求
 *   QB-4  轨迹侧位切换：轨迹行与当前帧 aiTrace 同源（条数一致）
 *   QB-5  AI 逻辑查看器：真实 /me/configs + /me/ai → 弹窗含我方 AI 名 + 程序树 + 本帧执行标记
 *   QB-6  帧字段三方一致（contract == 04 §5.2 == format.js 实读）+ 真实帧可解析
 *   QB-7  AI 节点类型与 server/ai/ast.js 的 NODE_TYPES 逐值相等；出厂程序无未知节点
 *   QB-8  无帧/失败路径：步进空操作、AI 查看器失败不打开空弹窗、replay 错误文案
 *   QB-9  快速对战屏动作双向闭合（渲染集合 == 注册表的 F6 动作）
 *   QB-10 busy 时全部按钮禁用；quick-run 不重入
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../helpers/http.js');
const store = require('../../public/store.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const actions = require('../../public/actions.js');
const apiMod = require('../../public/api.js');
const contract = require('../../public/contract.js');
const ast = require('../../server/ai/ast.js');

const REPO = path.join(__dirname, '..', '..');
const PW = 'pw12345678';
const F6_ACTIONS = ['quick-run', 'viewer-first', 'viewer-prev', 'viewer-next', 'viewer-last',
  'viewer-trace-p1', 'viewer-trace-p2', 'viewer-ai-logic', 'viewer-load-replay'];

// QB-11 用的"别场帧"桩（合成数据：只验证门控，不假装是服务端响应）
const QUICK_FRAMES_STUB = [
  { tick: 1, diff: { tick: 1, players: {}, bullets: [], bases: {}, collision: null, baseHits: [], bulletHits: [], damages: [], verdict: null, aiTrace: [] } },
  { tick: 2, diff: { tick: 2, players: {}, bullets: [], bases: {}, collision: null, baseHits: [], bulletHits: [], damages: [], verdict: null, aiTrace: [] } },
  { tick: 3, diff: { tick: 3, players: {}, bullets: [], bases: {}, collision: null, baseHits: [], bulletHits: [], damages: [], verdict: { winner: 'p1', phase: 'role' }, aiTrace: [] } },
];

// 与 public/app.js 的 buildCtx/run 同形；api 出口逐个计数（用于"本地动作不发请求"类断言）
function harness(baseUrl) {
  const st = store.createStore(store.initialState());
  const raw = apiMod.createApi({ baseUrl });
  const counter = { n: 0 };
  const calls = [];
  const api = {};
  for (const name of ['register', 'login', 'logout', 'changePassword', 'me', 'warehouse', 'box',
    'configs', 'aiList', 'setNickname', 'admin', 'quickRun', 'replay']) {
    api[name] = (...a) => { counter.n += 1; calls.push(name); return raw[name](...a); };
  }
  const h = {
    api, counter, calls,
    state: () => st.getState(),
    dispatch: (a) => st.dispatch(a),
    html: () => render.render(format.viewModel(st.getState())),
    labels: () => [...render.render(format.viewModel(st.getState())).matchAll(/>([^<>]+)<\/button>/g)].map((m) => m[1]),
    actionsIn: (html) => new Set([...html.matchAll(/data-action="([^"]*)"/g)].map((m) => m[1]).filter((a) => a !== '')),
    notice: () => (st.getState().notice ? st.getState().notice.text : ''),
    run: (name, payload) => {
      const ctx = {
        state: st.getState(), dispatch: (a) => st.dispatch(a), api,
        format, storage: { clear() {} }, actions: actions.ACTIONS,
      };
      return Promise.resolve(actions.ACTIONS[name].run(ctx, payload || null));
    },
    // 用真实动作用户名注册（返回 {data, token}）；顺带把会话写进 state（模拟登录落点）
    signUp: async (username) => {
      const r = await raw.register({ username, password: PW });
      assert.equal(r.status, 200, `注册失败：${r.raw}`);
      const session = format.sessionOf(r.envelope);
      st.dispatch({
        type: 'session.set', token: session.token, publicId: session.publicId,
        nickname: session.nickname, expiresAt: session.expiresAt, isAdmin: false,
      });
      st.dispatch({ type: 'view.go', view: 'hub' });
      return { data: r.envelope.data, token: session.token, publicId: session.publicId, nickname: session.nickname };
    },
    // 显式切回某个账号的会话（多账号用例需要：最后一次 signUp 会覆盖会话）
    useSession: (who) => {
      st.dispatch({ type: 'session.set', token: who.token, publicId: who.publicId, nickname: who.nickname, isAdmin: false });
    },
  };
  return h;
}

async function withHarness(fn) {
  const s = await startServer({ prefix: 'dl-fe-qb-', level: 'warn' });
  try {
    return await fn(harness(s.baseUrl), s);
  } finally {
    await s.cleanup();
  }
}

// 造"我 + 一个对手"两账号，并跑一场真实快速对战（对手 = 池内唯一候选）
async function runOneBattle(h, tag) {
  const me = await h.signUp(tag + 'me');
  const foe = await h.signUp(tag + 'foe');
  h.useSession(me);          // 由 me 发起（否则最后一次 signUp 的账号会覆盖会话）
  await h.run('goto-quick');
  await h.run('quick-run');
  assert.equal(h.state().view, 'quick');
  assert.ok(h.state().quick.envelope, `对局应成功（对手=${foe.data.publicId}）：${h.notice()}`);
  return { me: me.data, foe: foe.data };
}

/* ---------- QB-1：真实对局 ---------- */

test('QB-1 真实快速对战：结果行逐字由真实字段拼出；帧与 ticks 同源；viewer 与响应同源', async () => {
  await withHarness(async (h) => {
    const { me, foe } = await runOneBattle(h, 'qb1');
    const env = h.state().quick.envelope;
    const d = env.data;
    assert.equal(h.notice(), format.quickOkText(env), '成功提示应来自投影（按钮永不无声）');
    assert.ok(/^快速对战完成：(你赢了|你输了|平局|无效对局)/.test(h.notice()), h.notice());

    // 对手身份来自真实响应（对手是唯一候选 = 刚注册的第二个账号）
    assert.equal(d.opponent.publicId, foe.publicId, '对手应是池内唯一候选');
    assert.equal(d.opponent.isBot, false);
    const text = format.quickResultText(env);
    for (const part of [d.opponent.nickname, d.opponent.publicId, d.opponent.tier,
      String(d.self.pointsBefore), String(d.self.pointsAfter), String(d.ticks)]) {
      assert.ok(text.indexOf(String(part)) !== -1, `结果行缺少真实字段值 ${part}：${text}`);
    }
    assert.ok(h.html().includes(format.esc ? text : text), '结果行必须渲染到屏幕上');

    // 内联帧：数量 == ticks（实测每 tick 一帧）
    assert.equal(Array.isArray(d.frames) && d.frames.length, d.ticks, 'frames 应逐 tick 一帧');
    assert.equal(h.state().viewer.frames.length, d.frames.length, 'viewer 必须与响应同源（同一份数组内容）');
    assert.equal(h.state().viewer.battleId, d.battleId);
    assert.equal(h.state().viewer.index, 0, '新对局游标归零');
    assert.equal(h.state().viewer.source, 'quick');
    assert.notEqual(me.publicId, foe.publicId);
  });
});

/* ---------- QB-2：帧投影 ---------- */

test('QB-2 帧投影：全帧遍历无 undefined/null 泄漏；末帧含判决行', async () => {
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb2');
    const frames = h.state().viewer.frames;
    let damageFrames = 0;
    let bulletFrames = 0;
    frames.forEach((frame, i) => {
      const lines = format.frameLines(frame, i, frames.length);
      assert.ok(lines[0].indexOf(`第 ${i + 1}/${frames.length} 帧（tick ${frame.tick}）`) === 0, lines[0]);
      assert.ok(lines.join('\n').indexOf('我方 p1：位置 ') !== -1, '每帧都要有 p1 行');
      assert.ok(lines.join('\n').indexOf('对手 p2：位置 ') !== -1, '每帧都要有 p2 行');
      for (const line of lines) {
        assert.ok(!String(line).includes('undefined'), `帧 ${i} 行泄漏 undefined：${line}`);
        assert.ok(!String(line).includes('null'), `帧 ${i} 行泄漏 null：${line}`);
      }
      if ((frame.diff.damages || []).length > 0) damageFrames += 1;
      if ((frame.diff.bullets || []).length > 0) bulletFrames += 1;
    });
    // 末帧必有判决（引擎只在终局帧写 verdict）
    const last = format.frameLines(frames[frames.length - 1], frames.length - 1, frames.length);
    assert.ok(last.some((l) => l.indexOf('判决：') === 0), `末帧缺少判决行：${last.join(' | ')}`);
    assert.ok(damageFrames > 0 || bulletFrames > 0, '真实对局应至少出现一次弹幕或伤害（否则夹具无意义）');
  });
});

/* ---------- QB-3：步进动作 ---------- */

test('QB-3 步进动作：夹取边界、本地动作不发任何请求', async () => {
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb3');
    const total = h.state().viewer.frames.length;
    const before = h.counter.n;
    await h.run('viewer-prev');
    assert.equal(h.state().viewer.index, 0, '第一帧再往前应夹在 0');
    await h.run('viewer-last');
    assert.equal(h.state().viewer.index, total - 1, '最后一帧');
    await h.run('viewer-next');
    assert.equal(h.state().viewer.index, total - 1, '末帧再往后应夹在 total-1');
    await h.run('viewer-first');
    assert.equal(h.state().viewer.index, 0);
    await h.run('viewer-next');
    assert.equal(h.state().viewer.index, 1);
    assert.equal(h.counter.n, before, '步进是纯本地动作，不得发请求');
    // 渲染：末帧时「下一帧/最后一帧」禁用，首帧时「上一帧/第一帧」禁用
    h.dispatch({ type: 'viewer.frame.set', index: total - 1 });
    const vmLast = format.viewModel(h.state());
    const dis = (a) => vmLast.buttons.filter((b) => b.action === a)[0].disabled === true;
    assert.ok(dis('viewer-next') && dis('viewer-last'), '末帧应禁用向后按钮');
    h.dispatch({ type: 'viewer.frame.set', index: 0 });
    const vmFirst = format.viewModel(h.state());
    const dis2 = (a) => vmFirst.buttons.filter((b) => b.action === a)[0].disabled === true;
    assert.ok(dis2('viewer-prev') && dis2('viewer-first'), '首帧应禁用向前按钮');
  });
});

/* ---------- QB-4：轨迹侧位 ---------- */

test('QB-4 轨迹侧位切换：轨迹行与当前帧 aiTrace 同源（条数一致）', async () => {
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb4');
    const frames = h.state().viewer.frames;
    // 找到 p1/p2 都有轨迹的一帧（出厂 AI 双方都会记录）
    let idx = -1;
    for (let i = 0; i < frames.length; i++) {
      if (format.traceEntriesOf(frames[i], 'p1').length > 0 && format.traceEntriesOf(frames[i], 'p2').length > 0) { idx = i; break; }
    }
    assert.ok(idx >= 0, '应存在双方都有 AI 轨迹的帧（D-167：双方 aiTrace 都给）');
    h.dispatch({ type: 'viewer.frame.set', index: idx });
    await h.run('viewer-trace-p1');
    assert.equal(h.state().viewer.traceOwner, 'p1');
    const p1Text = format.traceSummaryText(frames[idx], 'p1');
    assert.ok(p1Text.indexOf(`（${format.traceEntriesOf(frames[idx], 'p1').length} 条）`) !== -1, p1Text);
    assert.ok(p1Text.indexOf('我方(进攻方)') === 0, p1Text);
    await h.run('viewer-trace-p2');
    assert.equal(h.state().viewer.traceOwner, 'p2');
    const p2Text = format.traceSummaryText(frames[idx], 'p2');
    assert.ok(p2Text.indexOf(`（${format.traceEntriesOf(frames[idx], 'p2').length} 条）`) !== -1, p2Text);
    assert.ok(p2Text.indexOf('对手(防守方)') === 0, p2Text);
    // 每条轨迹条目都带 owner/path/nodeType（形状断言）
    for (const entry of format.traceEntriesOf(frames[idx], 'p2')) {
      assert.equal(entry.owner, 'p2');
      assert.ok(typeof entry.path === 'string' && entry.path.startsWith('body'));
      assert.ok(typeof entry.nodeType === 'string' && entry.nodeType !== '');
      assert.ok(format.traceEntryText(entry).indexOf(entry.path) !== -1);
    }
    // 屏上轨迹行随侧位切换
    const html = h.html();
    assert.ok(html.includes(format.traceSummaryText(frames[idx], 'p2')), '屏幕应渲染 p2 轨迹行');
  });
});

/* ---------- QB-5：AI 逻辑查看器 ---------- */

test('QB-5 AI 逻辑查看器：真实配置 + AI 库 → 程序树 + 本帧执行标记 + 对手只有轨迹', async () => {
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb5');
    const before = h.counter.n;
    await h.run('viewer-ai-logic');
    // 审查 F6-3：`configs` 是必需依赖、`aiList` 是软依赖；成功路径仍然是这两次请求
    assert.ok(h.calls.slice(-2).join(',') === 'configs,aiList' || h.calls.slice(-2).join(',') === 'aiList,configs',
      `应取配置与 AI 库（各一次）：${h.calls.slice(-3).join(',')}`);
    assert.equal(h.counter.n, before + 2);
    assert.equal(h.state().modal.kind, 'ai-logic', '弹窗应打开');
    assert.equal(h.notice(), format.AI_LOGIC_OK_TEXT);
    const vm = format.viewModel(h.state());
    assert.equal(vm.modal.title, 'AI 逻辑查看器');
    const text = vm.modal.lines.join('\n');
    assert.ok(text.indexOf('我方 AI：') === 0, `首行应是我方 AI 名：${vm.modal.lines[0]}`);
    assert.ok(text.indexOf('（该配置没有 AI）') === -1, '出厂配置必带新手 AI');
    assert.ok(text.indexOf('action ') !== -1, '程序树应含 action 行');
    assert.ok(text.indexOf('if ') !== -1, '程序树应含 if 行');
    // 审查 F6-4：程序树**每行行尾带稳定路径** —— 区段断言（程序段内至少一行含 body 路径），
    //   并核对路径语法与同帧 aiTrace[].path 有交集（删掉修前那个恒真的 `|| text.indexOf('body')`）
    const progStart = vm.modal.lines.findIndex((l) => l.indexOf('程序（') === 0);
    const progEnd = vm.modal.lines.findIndex((l) => l.indexOf('本帧执行轨迹') === 0);
    assert.ok(progStart >= 0 && progEnd > progStart, `弹窗应有"程序"段与"轨迹"段：${vm.modal.lines.slice(0, 4).join(' | ')}`);
    const progLines = vm.modal.lines.slice(progStart + 1, progEnd);
    assert.ok(progLines.length > 2, `程序段行数过少：${progLines.length}`);
    assert.ok(progLines.some((l) => l.indexOf('body') !== -1), `程序段每行必须带稳定路径：${progLines.join(' | ')}`);
    const progPaths = new Set();
    for (const line of progLines) {
      const m = /\s(body(?:\.\w+(?:\[\d+\])?)*)\s*(?:←|$)/.exec(line);
      if (m) progPaths.add(m[1]);
    }
    const frame = h.state().viewer.frames[h.state().viewer.index];
    const tracePaths = new Set(format.traceEntriesOf(frame, 'p1').map((e) => e.path));
    const overlap = [...progPaths].filter((p) => tracePaths.has(p));
    assert.ok(tracePaths.size === 0 || overlap.length > 0,
      `程序树路径应与同帧 aiTrace[].path 有交集（程序 ${[...progPaths].slice(0, 3)} vs 轨迹 ${[...tracePaths].slice(0, 3)}）`);
    assert.ok(text.indexOf(format.AI_LOGIC_TRACE_NOTE) !== -1, '必须声明对手只有轨迹（SEC-33）');
    // 本帧执行标记：p1 本帧有轨迹 → 程序树里至少有一行被标记
    if (format.traceEntriesOf(frame, 'p1').length > 0) {
      assert.ok(vm.modal.lines.some((l) => l.indexOf('← 本帧执行') !== -1),
        `本帧有 p1 轨迹时程序树应有执行标记：${text.slice(0, 400)}`);
    }
    for (const line of vm.modal.lines) assert.ok(!String(line).includes('undefined'), `弹窗行泄漏：${line}`);
    // 关闭（点背景 = modal-close）
    await h.run('modal-close');
    assert.equal(h.state().modal, null);
  });
});

/* ---------- QB-6：帧字段三方一致 ---------- */

function docFrameFields() {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'frontend', '04-quickmatch.md'), 'utf8');
  const start = doc.indexOf('### 5.2');
  const end = doc.indexOf('### 5.3');
  assert.ok(start !== -1 && end > start, '04 分册缺少 §5.2/§5.3 标记');
  const out = new Set();
  for (const m of doc.slice(start, end).matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)) out.add(m[1]);
  return out;
}

test('QB-6 帧字段三方一致：contract == 04 §5.2 == format.js 实读，且真实帧可解析', async () => {
  const declared = new Set();
  for (const [name, list] of Object.entries(contract)) {
    if (name.startsWith('FRAME_')) for (const f of list) declared.add(f);
  }
  assert.ok(declared.size >= 40, `帧字段声明过少（${declared.size}）`);
  // ① contract == 04 §5.2
  const doc = docFrameFields();
  const missingInDoc = [...declared].filter((f) => !doc.has(f)).sort();
  const extraInDoc = [...doc].filter((f) => !declared.has(f)).sort();
  assert.deepEqual(missingInDoc, [], `contract 声明了但 04 §5.2 未登记：${missingInDoc.join(', ')}`);
  assert.deepEqual(extraInDoc, [], `04 §5.2 登记了但 contract 未声明：${extraInDoc.join(', ')}`);
  // ② contract == format.js 实读（字面量出现）
  const src = fs.readFileSync(path.join(REPO, 'public', 'format.js'), 'utf8');
  const missingInCode = [...declared].filter((f) => src.indexOf("'" + f + "'") === -1).sort();
  assert.deepEqual(missingInCode, [], `contract 声明了但 format.js 没读：${missingInCode.join(', ')}`);
  // ③ 真实帧上逐字段可解析（区分"键缺失"与"值为 undefined"）
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb6');
    const frames = h.state().viewer.frames;
    const diff = frames[0].diff;
    const present = (obj, field) => obj !== null && obj !== undefined && typeof obj === 'object' && (field in obj);
    for (const f of contract.FRAME_FIELDS) assert.ok(present(frames[0], f), `真实帧缺少 ${f}`);
    for (const f of contract.FRAME_DIFF_FIELDS) assert.ok(present(diff, f), `真实 diff 缺少 ${f}`);
    for (const f of contract.FRAME_SIDE_FIELDS) {
      assert.ok(present(diff.players.p1, f), `真实 players.p1 缺少 ${f}`);
      assert.ok(present(diff.players.p2, f), `真实 players.p2 缺少 ${f}`);
    }
    // 至少一帧含弹幕/伤害/判决：用它们核对更深的字段（没有则跳过那一组）
    const withBullet = frames.find((f) => (f.diff.bullets || []).length > 0);
    if (withBullet) {
      const b = withBullet.diff.bullets[0];
      const optional = new Set(contract.FRAME_BULLET_OPTIONAL_FIELDS);
      for (const f of contract.FRAME_BULLET_FIELDS) {
        if (!optional.has(f)) assert.ok(present(b, f), `真实弹幕缺少 ${f}`);
      }
      // 可选字段：引擎只对有衰减的弹幕补 `falloffFactor`。全部弹幕都没有该键时，
      //   投影必须照样产出且不泄漏 undefined（这就是"可选"的实际含义）。
      for (const f of contract.FRAME_BULLET_OPTIONAL_FIELDS) {
        const withF = frames.some((fr) => (fr.diff.bullets || []).some((x) => present(x, f)));
        if (!withF) {
          const bulletLines = frames
            .map((fr, i) => format.frameLines(fr, i, frames.length).filter((l) => l.indexOf('弹幕 ') === 0))
            .reduce((a, b) => a.concat(b), []);
          assert.ok(bulletLines.length > 0, '本场应有弹幕行可供核对');
          for (const line of bulletLines) assert.ok(!line.includes('undefined'), `弹幕行泄漏：${line}`);
        }
      }
    }
    // 审查 F6-8：行动字段**每帧都有**，核对必须移出 `if (withBullet)` 之外
    for (const f of contract.FRAME_ACTION_FIELDS) assert.ok(f in diff.players.p1.action, `action 缺 ${f}`);
    // 可选字段（dir/sid/cells）按 kind 出现 —— 用**全部 9 种行动形态**各渲染一次，核对投影不泄漏
    const side = (action) => ({
      fromX: 0, toX: 0, facing: 1, hp: 1, mp: 1, sp: 1, maxHp: 1, maxMp: 1, maxSp: 1, atk: 1, def: 1,
      defending: false, dodging: false, fullDodge: false, action, effects: [],
    });
    const synthetic = (action) => ({
      tick: 1,
      diff: {
        tick: 1, players: { p1: side(action), p2: side(action) }, bullets: [],
        bases: { p1: { hp: 1, maxHp: 1, def: 1 }, p2: { hp: 1, maxHp: 1, def: 1 } },
        collision: null, baseHits: [], bulletHits: [], damages: [], verdict: null, aiTrace: [],
      },
    });
    const kinds = [
      { kind: 'move', dir: 1 }, { kind: 'move', dir: -1 }, { kind: 'dodge', dir: 1 },
      { kind: 'forced_move', dir: -1, cells: 2 }, { kind: 'cast', sid: 'skill_1' },
      { kind: 'displacement', sid: 'skill_1', dir: 1 }, { kind: 'defend' }, { kind: 'turn' }, { kind: 'wait' },
    ];
    for (const action of kinds) {
      const rendered = format.frameLines(synthetic(action), 0, 1).join('\n');
      assert.ok(!rendered.includes('undefined'), `行动 ${action.kind} 渲染泄漏 undefined`);
      assert.ok(rendered.includes('行动 '), `行动 ${action.kind} 应渲染行动文本`);
    }
    for (const f of contract.FRAME_ACTION_OPTIONAL_FIELDS) {
      const usesIt = kinds.some((k) => f in k);
      assert.ok(usesIt, `可选行动字段 ${f} 在合成用例里未被覆盖`);
    }
    // 审查 F6-8：`effects` / `baseHits` / `collision` 三组在真实对局里恒为空（实测 6 场 258 帧全为 0）
    //   → 用**合成帧**覆盖其投影分支与字段清单（明确标注：以下是合成数据，不是服务端响应）
    const synthFrame = {
      tick: 9,
      diff: {
        tick: 9,
        players: { p1: side({ kind: 'move', dir: 1 }), p2: side({ kind: 'defend' }) },
        bullets: [],
        bases: { p1: { hp: 1, maxHp: 100, def: 64 }, p2: { hp: 100, maxHp: 100, def: 64 } },
        collision: { contactX: 640, t: 9 },
        baseHits: [{ owner: 'p1', by: 'p2', atX: 608 }],
        bulletHits: [{ uid: 'b_x', target: 'p1', atX: 608 }],
        damages: [],
        verdict: null,
        aiTrace: [],
      },
    };
    synthFrame.diff.players.p1.effects = [{ uid: 'e_1', kind: 'burn', stat: 'hp', delta: -3, displacement: 0, remaining: 2 }];
    const synthLines = format.frameLines(synthFrame, 0, 1).join('\n');
    assert.ok(!synthLines.includes('undefined') && !synthLines.includes('null'), `合成帧投影泄漏：${synthLines}`);
    assert.ok(synthLines.includes('碰撞：接触点 640'), synthLines);
    assert.ok(synthLines.includes('撞基地：p1 被 p2 撞 @608'), synthLines);
    assert.ok(synthLines.includes('弹幕命中：b_x → p1 @608'), synthLines);
    assert.ok(synthLines.includes('buff burn（hp-3，剩2）'), synthLines);
    for (const f of contract.FRAME_EFFECT_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(synthFrame.diff.players.p1.effects[0], f),
        `合成 effects 缺少已声明字段 ${f}`);
    }
    for (const f of contract.FRAME_BASE_HIT_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(synthFrame.diff.baseHits[0], f), `合成 baseHits 缺少 ${f}`);
    }
    for (const f of contract.FRAME_COLLISION_FIELDS) {
      assert.ok(Object.prototype.hasOwnProperty.call(synthFrame.diff.collision, f), `合成 collision 缺少 ${f}`);
    }
    const withDamage = frames.find((f) => (f.diff.damages || []).length > 0);
    if (withDamage) {
      for (const f of contract.FRAME_DAMAGE_FIELDS) assert.ok(present(withDamage.diff.damages[0], f), `真实伤害缺少 ${f}`);
    }
    const withHit = frames.find((f) => (f.diff.bulletHits || []).length > 0);
    if (withHit) {
      for (const f of contract.FRAME_BULLET_HIT_FIELDS) assert.ok(present(withHit.diff.bulletHits[0], f), `真实弹幕命中缺少 ${f}`);
    }
    for (const f of contract.FRAME_VERDICT_FIELDS) {
      assert.ok(present(frames[frames.length - 1].diff.verdict, f), `末帧判决缺少 ${f}`);
    }
    for (const f of contract.FRAME_TRACE_FIELDS) {
      const withTrace = frames.find((fr) => (fr.diff.aiTrace || []).length > 0);
      assert.ok(present(withTrace.diff.aiTrace[0], f), `真实 aiTrace 缺少 ${f}`);
    }
    // 可选字段 `result`：只在 action 节点上出现，且必须等于该 action 名
    const actionEntry = frames
      .map((fr) => (fr.diff.aiTrace || []).filter((e) => e.nodeType === 'action')[0])
      .filter(Boolean)[0];
    assert.ok(actionEntry, '真实轨迹里应有 action 节点（否则"末条 action"无从核对）');
    for (const f of contract.FRAME_TRACE_OPTIONAL_FIELDS) {
      assert.ok(present(actionEntry, f), `action 轨迹节点缺少 ${f}`);
      assert.ok(typeof actionEntry.result === 'string' && actionEntry.result !== '', 'result 应为 action 名');
      assert.ok(format.traceEntryText(actionEntry).indexOf('→ ' + actionEntry.result) !== -1);
    }
  });
});

/* ---------- QB-7：AI 节点类型 ---------- */

test('QB-7 AI 节点类型与 server/ai/ast.js 的 NODE_TYPES 逐值相等；出厂程序无未知节点', async () => {
  assert.deepEqual([...format.AI_NODE_TYPES].sort(), [...ast.NODE_TYPES].sort(),
    'format.AI_NODE_TYPES 必须与后端 ast.NODE_TYPES 逐值相等（否则查看器会漏画/多画节点）');
  assert.ok(Number.isInteger(format.AI_MAX_DEPTH) && format.AI_MAX_DEPTH > 0);
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb7');
    const env = await h.api.configs(h.state().session.token);
    const slot = format.activeSlotOf(env.envelope);
    assert.ok(slot, '应有出战槽');
    const program = slot.loadout.ai;
    assert.ok(program && typeof program === 'object', '出战配置应带 AI 程序正文');
    const lines = format.programLines(program);
    assert.ok(lines.length > 3, `程序树行数过少：${lines.length}`);
    for (const line of lines) {
      assert.ok(line.text.indexOf('未知节点') === -1, `出现未知节点：${line.text}`);
      assert.ok(line.text.indexOf('undefined') === -1, line.text);
      assert.ok(line.text.indexOf('null') === -1, `程序树不得打印 null（审查 F6-12）：${line.text}`);
    }
    assert.ok(lines.every((l) => l.path === null || typeof l.path === 'string'));
    assert.ok(format.programLines(null).length === 0, '空程序应产出 0 行（不抛错）');
    // 深度截断：人为造一个超深程序
    let deep = { type: 'action', name: 'wait' };
    for (let i = 0; i < format.AI_MAX_DEPTH + 5; i++) deep = { type: 'if', cond: { type: 'literal', value: true }, then: { type: 'seq', statements: [deep] } };
    const deepLines = format.programLines({ type: 'program', body: { type: 'seq', statements: [deep] } });
    assert.ok(deepLines.some((l) => l.text.indexOf('超出显示深度') !== -1), '超深程序必须被截断并标注');
  });
});

/* ---------- QB-8：无帧 / 失败路径 ---------- */

test('QB-8 无帧与失败路径：步进空操作、AI 查看器失败不开弹窗、replay 文案', async () => {
  // ① 无帧：步进/轨迹是空操作，且不发请求
  const st = store.createStore(store.initialState());
  st.dispatch({ type: 'view.go', view: 'quick' });
  let calls = 0;
  const ctx = {
    state: st.getState(),
    dispatch: (a) => st.dispatch(a),
    api: { quickRun: () => { calls += 1; return Promise.resolve({}); }, configs: () => { calls += 1; return Promise.resolve({}); }, replay: () => { calls += 1; return Promise.resolve({}); }, aiList: () => { calls += 1; return Promise.resolve({}); } },
    format, storage: { clear() {} }, actions: actions.ACTIONS,
  };
  for (const name of ['viewer-first', 'viewer-prev', 'viewer-next', 'viewer-last']) {
    await actions.ACTIONS[name].run(ctx, null);
  }
  assert.equal(st.getState().viewer.index, 0, '无帧时游标不动');
  assert.equal(calls, 0, '无帧时步进不得发请求');
  // 无帧但无 id：屏上不渲染「读取本场回放」
  st.dispatch({ type: 'quick.set', envelope: { ok: true, data: { frames: null, battleId: null, winner: 'p1' } } });
  st.dispatch({ type: 'viewer.set', frames: null, source: 'quick', battleId: null });
  let vmA = format.viewModel(st.getState());
  assert.deepEqual(vmA.buttons.filter((b) => b.action === 'viewer-load-replay'), [], '无 id 不渲染读取回放');
  assert.ok(vmA.lines.join('').indexOf('无法读取回放') !== -1, vmA.lines.join(' | '));
  // 本屏有对局（envelope 带 battleId）但帧缺失：渲染「读取本场回放」且可用（审查 F6-2：判据取**本屏对局**）
  st.dispatch({
    type: 'quick.set',
    envelope: { ok: true, data: { frames: null, battleId: 'b_x', winner: 'p1', ticks: 3, self: { delta: 0 } } },
  });
  st.dispatch({ type: 'viewer.set', frames: null, source: 'quick', battleId: 'b_x' });
  const vmB = format.viewModel(st.getState());
  const replayBtn = vmB.buttons.filter((b) => b.action === 'viewer-load-replay')[0];
  assert.ok(replayBtn && replayBtn.disabled === false, '本屏有对局且无帧时必须有可点的读取回放入口（否则用户无路可走）');

  // ② AI 查看器失败（配置读取 500）→ 写文案、**不**打开弹窗
  const st2 = store.createStore(store.initialState());
  st2.dispatch({ type: 'session.set', token: 't', publicId: 'u_1', nickname: 'n', isAdmin: false });
  const failCtx = {
    state: st2.getState(),
    dispatch: (a) => st2.dispatch(a),
    api: {
      configs: () => Promise.resolve({ transport: 'response', status: 500, envelope: { ok: false, error: { code: 'internal_error', message: '服务端内部错误', details: [] } } }),
      aiList: () => { throw new Error('不应走到 aiList'); },
    },
    format, storage: { clear() {} }, actions: actions.ACTIONS,
  };
  await actions.ACTIONS['viewer-ai-logic'].run(failCtx, null);
  assert.equal(st2.getState().modal, null, '配置读取失败时不得打开空弹窗');
  assert.ok(st2.getState().notice && st2.getState().notice.kind === 'error', '失败必须可见（按钮永不无声）');

  // ③ 失败文案表（04 §6）
  const expired = { ok: false, error: { code: 'replay_expired', message: '回放已过期', details: [] } };
  assert.ok(format.quickNoticeText(expired).indexOf('回放已过期') !== -1);
  const noOpp = { ok: false, error: { code: 'no_opponent', message: '没有可用对手', details: [] } };
  assert.ok(format.quickNoticeText(noOpp).indexOf('注入调试 bot') !== -1, format.quickNoticeText(noOpp));
  const noCfg = { ok: false, error: { code: 'no_active_config', message: '没有出战配置', details: [] } };
  assert.ok(format.quickNoticeText(noCfg).indexOf('出战配置1') !== -1);
});

/* ---------- QB-9：动作双向闭合 ---------- */

test('QB-9 快速对战屏动作双向闭合（渲染集合 == 注册表的 F6 动作）', async () => {
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb9');
    const withFrames = h.actionsIn(h.html());
    for (const name of F6_ACTIONS.filter((a) => a !== 'viewer-load-replay')) {
      assert.ok(withFrames.has(name), `有帧态缺少动作入口：${name}`);
    }
    // 无帧态（有 battleId）才出现「读取本场回放」
    h.dispatch({ type: 'viewer.set', frames: null, source: 'quick', battleId: 'b_x' });
    const noFrames = h.actionsIn(h.html());
    assert.ok(noFrames.has('viewer-load-replay'), '无帧态缺少读取回放入口');
    const all = new Set([...withFrames, ...noFrames, ...h.actionsIn(h.html())]);
    const dead = [...all].filter((a) => actions.ACTIONS[a] === undefined);
    assert.deepEqual(dead, [], `渲染了未注册动作：${dead.join(', ')}`);
    for (const name of F6_ACTIONS) {
      assert.ok(actions.ACTIONS[name] && typeof actions.ACTIONS[name].run === 'function', `${name} 未注册`);
    }
  });
});

/* ---------- QB-11：跨屏门控（审查 F6-1/F6-2 的回归） ---------- */

test('QB-11 跨屏门控：快速对战屏只渲染属于本场的帧；本屏无对局时不出现「读取本场回放」', async () => {
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb11');
    const mine = h.state().quick.envelope.data;
    // 正常情况下本屏拥有帧：渲染查看区
    let vm = format.viewModel(h.state());
    assert.ok(vm.lines.some((l) => l.indexOf('第 1/' + mine.frames.length + ' 帧') === 0), '本场帧应渲染');
    // 别场（模拟 F7 的「看这一场」覆盖共享查看器）
    h.dispatch({ type: 'viewer.set', frames: QUICK_FRAMES_STUB, source: 'tournament', battleId: 'b_other' });
    vm = format.viewModel(h.state());
    assert.ok(!vm.lines.some((l) => l.indexOf('第 1/' + QUICK_FRAMES_STUB.length + ' 帧') === 0),
      '别场的帧**不得**被当作本场渲染');
    assert.ok(vm.lines.some((l) => l.indexOf('别处') !== -1), `应写明查看器里是别处的战斗：${vm.lines.join(' | ')}`);
    const dis = (a) => vm.buttons.filter((b) => b.action === a)[0].disabled === true;
    for (const a of ['viewer-first', 'viewer-prev', 'viewer-next', 'viewer-last', 'viewer-trace-p1', 'viewer-trace-p2']) {
      assert.ok(dis(a), `非本场帧时 ${a} 必须禁用`);
    }
    assert.equal(vm.buttons.some((b) => b.action === 'viewer-load-replay'), true, '本屏有对局且无本场帧 → 应能读本场回放');
    // 本屏**没跑过**对局 + viewer 持有别场 id → 不得渲染「读取本场回放」（审查 F6-2 的反例）
    h.dispatch({ type: 'quick.set', envelope: null });
    h.dispatch({ type: 'viewer.set', frames: null, source: 'tournament', battleId: 'b_other' });
    vm = format.viewModel(h.state());
    assert.equal(vm.buttons.some((b) => b.action === 'viewer-load-replay'), false,
      '本屏没有对局时不得渲染「读取本场回放」（点了会"成功但屏幕无任何变化"）');
    assert.equal(format.viewModel(h.state()).lines.join(''), format.QUICK_IDLE_TEXT);
    // 非法 source 进不了状态（白名单）
    h.dispatch({ type: 'viewer.set', frames: QUICK_FRAMES_STUB, source: 'nonsense', battleId: 'b_x' });
    assert.equal(h.state().viewer.source, 'tournament', '非法 source 应被白名单挡下（沿用旧值）');
  });
});

/* ---------- QB-12：AI 名是软依赖（审查 F6-3 的回归） ---------- */

test('QB-12 AI 名是软依赖：configs 成功 + aiList 失败 → 弹窗仍打开（名字回落 aiId）；configs 失败 → 不开弹窗', async () => {
  const makeCtx = (st, api) => ({
    state: st.getState(), dispatch: (a) => st.dispatch(a), api, format, storage: { clear() {} }, actions: actions.ACTIONS,
  });
  const okConfigs = () => Promise.resolve({
    transport: 'response', status: 200,
    envelope: { ok: true, data: { slots: [{ slotId: 'slot1', loadout: { role: null, skills: [null, null, null], ai: { type: 'program', body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } }, aiId: 'ai_x' } }], activeSlotId: 'slot1' } },
  });
  // aiList 500
  const st1 = store.createStore(store.initialState());
  st1.dispatch({ type: 'session.set', token: 't', publicId: 'u_1', nickname: 'n', isAdmin: false });
  st1.dispatch({ type: 'view.go', view: 'quick' });
  await actions.ACTIONS['viewer-ai-logic'].run(makeCtx(st1, {
    configs: okConfigs,
    aiList: () => Promise.resolve({ transport: 'response', status: 500, envelope: { ok: false, error: { code: 'internal_error', message: 'boom', details: [] } } }),
  }), null);
  assert.equal(st1.getState().modal.kind, 'ai-logic', 'AI 库失败不得阻断弹窗（F6-3）');
  assert.equal(st1.getState().notice.text, format.AI_LOGIC_NAME_FAIL_TEXT);
  const lines = format.viewModel(st1.getState()).modal.lines;
  assert.ok(lines[0].indexOf('我方 AI：ai_x') === 0, `AI 名应回落 aiId：${lines[0]}`);
  assert.ok(lines.some((l) => l.indexOf('程序（') === 0), '程序树照常渲染');
  // aiList 传输失败
  const st2 = store.createStore(store.initialState());
  st2.dispatch({ type: 'session.set', token: 't', publicId: 'u_1', nickname: 'n', isAdmin: false });
  st2.dispatch({ type: 'view.go', view: 'quick' });
  await actions.ACTIONS['viewer-ai-logic'].run(makeCtx(st2, {
    configs: okConfigs, aiList: () => Promise.resolve({ transport: 'error', message: '断网' }),
  }), null);
  assert.equal(st2.getState().modal.kind, 'ai-logic', 'AI 库传输失败同样不得阻断');
  assert.equal(st2.getState().notice.text, format.AI_LOGIC_NAME_FAIL_TEXT);
  // configs 失败 → 不打开弹窗
  const st3 = store.createStore(store.initialState());
  st3.dispatch({ type: 'session.set', token: 't', publicId: 'u_1', nickname: 'n', isAdmin: false });
  st3.dispatch({ type: 'view.go', view: 'quick' });
  await actions.ACTIONS['viewer-ai-logic'].run(makeCtx(st3, {
    configs: () => Promise.resolve({ transport: 'response', status: 500, envelope: { ok: false, error: { code: 'internal_error', message: 'boom', details: [] } } }),
    aiList: () => { throw new Error('不应走到 aiList'); },
  }), null);
  assert.equal(st3.getState().modal, null, 'configs 失败不得打开空弹窗');
  assert.equal(st3.getState().notice.kind, 'error');
});

/* ---------- QB-10：busy 语义 ---------- */

test('QB-10 busy 时全部按钮禁用；quick-run 不重入', async () => {
  await withHarness(async (h) => {
    await runOneBattle(h, 'qb10');
    h.dispatch({ type: 'busy.set', busy: true });
    const vm = format.viewModel(h.state());
    for (const b of vm.buttons) assert.equal(b.disabled, true, `busy 时按钮未禁用：${b.action}`);
    const before = h.counter.n;
    await h.run('quick-run');
    assert.equal(h.counter.n, before, 'busy 时 quick-run 不得发请求');
    h.dispatch({ type: 'busy.set', busy: false });
    await h.run('quick-run');
    assert.equal(h.counter.n, before + 1, '空闲时应能再次发起');
  });
});
