'use strict';
/* tests/frontend/tournament-board-flow.test.js —— F7 锦标赛屏 + 排行榜屏（真实 HTTP + 机器核对）
 *
 * 权威：docs/frontend/05-tournament.md §3/§4/§5/§6/§8/§10（TB-1…TB-10）；后端契约扩展见 D-171。
 * 与浏览器完全同构：public/{store,format,render,actions,api,app}.js（fetch 由 Node 内建提供，baseUrl 指向真实服务）。
 *
 * 覆盖：
 *   TB-1  真实锦标赛：批次结果行逐字来自真实字段；页码归 0；viewer 清空
 *   TB-2  分页：每页 5 场、页数正确、翻页零请求、越界夹取、按钮禁用随页码
 *   TB-3  「看这一场」：真实帧入 state.viewer（source=tournament），与 F6 同一投影且无 undefined
 *   TB-4  缺口诚实：shortfall>0 时必须出现缺口行且含"缺场批次不判晋升"；=0 时不出现
 *   TB-5  无内联帧（重放批次形状）→ 自动读回放；无效场（无 battleId）→ 按钮禁用且行内写明原因
 *   TB-6  子对象字段三方一致（contract == 05 §5.2 == format.js 实读 + 真实响应逐字段）
 *   TB-7  排行榜：榜头/本人名次/行列表逐字来自真实响应；self=null 时不伪造
 *   TB-8  切榜/换范围/翻页：请求参数（order/scope/offset/limit）正确、禁用随 offset/hasMore
 *   TB-9  动作双向闭合（两屏渲染集合 == 注册表）
 *   TB-10 busy 全禁用 + 不重入；data-tier 寻址链（渲染 / payload 白名单 / 动作消费）三处可核
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

const REPO = path.join(__dirname, '..', '..');
const PW = 'pw12345678';
const F7_ACTIONS = ['tournament-run', 'tournament-page-prev', 'tournament-page-next', 'tournament-open-battle',
  'board-points', 'board-tier', 'board-scope', 'board-prev', 'board-next', 'board-refresh'];

// TB-12 用的"别场帧"桩（合成数据：只验证门控，不假装是服务端响应）
const QUICK_FRAMES_STUB = [
  { tick: 1, diff: { tick: 1, players: {}, bullets: [], bases: {}, collision: null, baseHits: [], bulletHits: [], damages: [], verdict: null, aiTrace: [] } },
  { tick: 2, diff: { tick: 2, players: {}, bullets: [], bases: {}, collision: null, baseHits: [], bulletHits: [], damages: [], verdict: null, aiTrace: [] } },
];

function harness(baseUrl) {
  const st = store.createStore(store.initialState());
  const raw = apiMod.createApi({ baseUrl });
  const calls = [];
  const boardQueries = [];
  const api = {};
  for (const name of ['register', 'login', 'logout', 'changePassword', 'me', 'warehouse', 'box',
    'configs', 'aiList', 'setNickname', 'admin', 'quickRun', 'replay', 'rankedRun']) {
    api[name] = (...a) => { calls.push(name); return raw[name](...a); };
  }
  api.leaderboard = (token, query) => { calls.push('leaderboard'); boardQueries.push(query); return raw.leaderboard(token, query); };
  const h = {
    api, calls, boardQueries,
    state: () => st.getState(),
    dispatch: (a) => st.dispatch(a),
    html: () => render.render(format.viewModel(st.getState())),
    actionsIn: () => new Set([...h.html().matchAll(/data-action="([^"]*)"/g)].map((m) => m[1]).filter((a) => a !== '')),
    notice: () => (st.getState().notice ? st.getState().notice.text : ''),
    run: (name, payload) => {
      const ctx = {
        state: st.getState(), dispatch: (a) => st.dispatch(a), api,
        format, storage: { clear() {} }, actions: actions.ACTIONS,
      };
      return Promise.resolve(actions.ACTIONS[name].run(ctx, payload || null));
    },
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
  };
  return h;
}

// 造 12 个账号会越过 auth 的同 IP 每分钟 10 次限速（既有行为，非本批引入）→ 用例内放宽
const FAST_AUTH = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000, maxFailures: 5000 } };

async function withHarness(fn) {
  const s = await startServer({ prefix: 'dl-fe-tb-', level: 'warn', authConfig: FAST_AUTH });
  try {
    return await fn(harness(s.baseUrl), s);
  } finally {
    await s.cleanup();
  }
}

// 造 n 个账号（第一个是"我"，其余进池当对手）并跑一批锦标赛
async function runBatch(h, tag, foes) {
  const me = await h.signUp(tag + 'me');
  const others = [];
  for (let i = 0; i < foes; i++) others.push(await h.signUp(tag + 'foe' + i));
  // signUp 会把会话切到最后一个账号 → 显式切回"我"
  h.dispatch({ type: 'session.set', token: me.token, publicId: me.publicId, nickname: me.nickname, isAdmin: false });
  await h.run('goto-tournament');
  await h.run('tournament-run');
  assert.ok(h.state().tournament.envelope, `批次应成功：${h.notice()}`);
  return { me, others };
}

/* ---------- TB-1：真实锦标赛 ---------- */

test('TB-1 真实锦标赛：批次结果行逐字来自真实字段；页码归 0；新批次清空查看器', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb1', 11);
    const env = h.state().tournament.envelope;
    const d = env.data;
    assert.equal(d.requested, 10, '批次规模 = rating-config.batchSize（10）');
    assert.equal(d.matches, 10, '池内有 11 个候选 → 打满 10 场');
    assert.equal(d.shortfall, 0);
    assert.equal(h.state().tournament.page, 0);
    assert.equal(h.state().viewer.frames, null, '新批次必须清掉上一批的查看器');
    assert.equal(h.notice(), format.rankedOkText(env), '成功提示来自投影');
    const text = format.rankedResultText(env);
    for (const part of [String(d.matches), String(d.requested), String(d.wins), String(d.losses), d.tier, d.tierAfter, d.reward]) {
      assert.ok(text.indexOf(String(part)) !== -1, `结果区缺少真实字段值 ${part}：${text}`);
    }
    assert.ok(h.html().includes(text), '结果区必须渲染到屏幕');
    assert.equal(h.state().view, 'tournament');
  });
});

/* ---------- TB-2：分页 ---------- */

test('TB-2 分页：每页 5 场、页数正确、翻页零请求、越界夹取、按钮禁用随页码', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb2', 11);
    const total = h.state().tournament.envelope.data.matches;
    const pages = Math.ceil(total / format.TOURNAMENT_PAGE_SIZE);
    assert.equal(pages, 2, `10 场应分 2 页（实际 ${total} 场 → ${pages} 页）`);
    const pager = format.tournamentPager(h.state());
    assert.deepEqual({ total: pager.total, pages: pager.pages, page: pager.page }, { total: total, pages: 2, page: 0 });
    // 第 1 页应有 5 行场次
    let vm = format.viewModel(h.state());
    assert.equal(vm.rows.length, 5, '第 1 页 5 行');
    const before = h.calls.length;
    await h.run('tournament-page-next');
    assert.equal(h.state().tournament.page, 1);
    assert.equal(h.calls.length, before, '翻页是纯本地动作，不得发请求');
    vm = format.viewModel(h.state());
    assert.equal(vm.rows.length, total - 5, '第 2 页剩余场次');
    const dis = (a) => vm.buttons.filter((b) => b.action === a)[0].disabled === true;
    assert.ok(dis('tournament-page-next'), '末页应禁用「下一页」');
    assert.ok(!dis('tournament-page-prev'), '末页「上一页」应可用');
    await h.run('tournament-page-next');
    assert.equal(h.state().tournament.page, 1, '末页再往后应夹取');
    await h.run('tournament-page-prev');
    await h.run('tournament-page-prev');
    assert.equal(h.state().tournament.page, 0, '首页再往前应夹取');
    assert.ok(dis('tournament-page-prev') === false || true);
    const vm0 = format.viewModel(h.state());
    assert.ok(vm0.buttons.filter((b) => b.action === 'tournament-page-prev')[0].disabled === true, '首页应禁用「上一页」');
    // 每页 5 场且无重复（按对局 id 核对）
    const ids = [];
    for (let p = 0; p < pages; p++) {
      h.dispatch({ type: 'tournament.page.set', page: p });
      const rows = format.viewModel(h.state()).rows;
      for (const row of rows) ids.push(row.text);
    }
    assert.equal(ids.length, total, '逐页拼起来 == 全量场次');
    assert.equal(new Set(ids).size, total, '分页不得重复展示同一场');
  });
});

/* ---------- TB-3：「看这一场」 ---------- */

test('TB-3 「看这一场」：真实帧入 viewer（source=tournament），帧文本与 F6 同一投影', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb3', 11);
    const results = h.state().tournament.envelope.data.results;
    const idx = results.findIndex((r) => Array.isArray(r.frames) && r.frames.length > 0);
    assert.ok(idx >= 0, '内联帧应存在（D-167）');
    await h.run('tournament-open-battle', { idx: String(idx) });
    assert.equal(h.state().viewer.source, 'tournament');
    assert.equal(h.state().viewer.battleId, results[idx].battleId);
    assert.equal(h.state().viewer.frames.length, results[idx].frames.length);
    assert.ok(h.notice().indexOf('已载入本场战斗') === 0, h.notice());
    const vm = format.viewModel(h.state());
    const viewerLine = vm.lines.filter((l) => l.indexOf('第 1/' + results[idx].frames.length + ' 帧') === 0);
    assert.equal(viewerLine.length, 1, `应渲染查看区：${vm.lines.slice(0, 6).join(' | ')}`);
    for (const line of vm.lines) assert.ok(!String(line).includes('undefined'), `泄漏：${line}`);
    // 点某个「看这一场」按钮（真 DOM 语义：data-idx → payload）
    assert.ok(h.actionsIn().has('tournament-open-battle'));
  });
});

/* ---------- TB-4：缺口诚实 ---------- */

test('TB-4 缺口诚实：池内只有 1 个候选 → shortfall>0 且缺口行含「缺场批次不判晋升」', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb4', 1);
    const env = h.state().tournament.envelope;
    assert.equal(env.data.requested, 10);
    assert.equal(env.data.matches, 1, '池内只有 1 个候选 → 只打 1 场');
    assert.equal(env.data.shortfall, 9);
    assert.equal(env.data.promoted, false, '缺场批次不判晋升（server/ranked.js:749）');
    const line = format.rankedShortfallText(env);
    assert.ok(line && line.indexOf('少打 9 场') !== -1, String(line));
    assert.ok(line.indexOf('缺场批次不判晋升') !== -1, '必须写明"缺场批次不判晋升"（否则用户以为打够了只是没赢够）');
    assert.ok(h.html().includes(line), '缺口行必须渲染到屏幕');
    // 满场批次不出现缺口行
    assert.equal(format.rankedShortfallText({ ok: true, data: { shortfall: 0 } }), null);
  });
});

/* ---------- TB-5：无内联帧 / 无效场 ---------- */

test('TB-5 无内联帧自动读回放；无效场（无 battleId）按钮禁用并写明原因', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb5', 2);
    const real = h.state().tournament.envelope.data.results.find((r) => Array.isArray(r.frames) && r.frames.length > 0);
    assert.ok(real, '需一场真实对局作为回放来源');
    // 合成"重放批次"形状：results[i] **没有 frames 键**（实测 ranked.js:527-559）
    h.dispatch({
      type: 'tournament.set',
      envelope: {
        ok: true,
        data: Object.assign({}, h.state().tournament.envelope.data, {
          results: [
            { match: 1, opponentPublicId: real.opponentPublicId, winner: real.winner, ticks: real.ticks, battleId: real.battleId },
            { match: 2, opponentPublicId: 'u_invalid', winner: 'invalid', ticks: 0, battleId: null },
          ],
          matches: 2,
        }),
      },
    });
    const vm = format.viewModel(h.state());
    assert.equal(vm.rows.length, 2);
    assert.ok(vm.rows[0].text.indexOf('本场无内联帧：点「看这一场」读回放') !== -1, vm.rows[0].text);
    assert.equal(vm.rows[0].buttons[0].disabled, false, '有 battleId → 可用');
    assert.ok(vm.rows[1].text.indexOf('无效') !== -1 && vm.rows[1].text.indexOf('无对局 id') !== -1, vm.rows[1].text);
    assert.equal(vm.rows[1].buttons[0].disabled, true, '无 battleId → 禁用（不得让用户点了没反应）');
    // 无内联帧 → 自动读回放（真实 HTTP）
    const before = h.calls.filter((c) => c === 'replay').length;
    await h.run('tournament-open-battle', { idx: '0' });
    assert.equal(h.calls.filter((c) => c === 'replay').length, before + 1, '应发一次回放请求');
    assert.ok(h.notice().indexOf('已读取回放') === 0, h.notice());
    assert.ok(h.state().viewer.frames.length > 0, '回放帧应入查看器');
    assert.equal(h.state().viewer.source, 'tournament');
    // 无效场：点了写可见文案（按钮虽禁用，动作仍需兜底）
    h.dispatch({ type: 'notice.set', notice: null });
    await h.run('tournament-open-battle', { idx: '1' });
    assert.equal(h.notice(), format.NO_BATTLE_ID_TEXT);
  });
});

/* ---------- TB-6：字段三方一致 ---------- */

function docSection(text, from, to) {
  const start = text.indexOf(from);
  const end = text.indexOf(to);
  assert.ok(start !== -1 && end > start, `05 分册缺少 ${from}/${to} 标记`);
  return text.slice(start, end);
}

test('TB-6 子对象字段三方一致：contract == 05 §5.2 == format.js 实读 + 真实响应逐字段', async () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'frontend', '05-tournament.md'), 'utf8');
  const sec = docSection(doc, '### 5.2', '## 6.');
  const declared = new Set([...contract.RANKED_RESULT_FIELDS, ...contract.RANKED_RESULT_OPTIONAL_FIELDS,
    ...contract.LEADERBOARD_ROW_FIELDS, ...contract.LEADERBOARD_SELF_FIELDS]);
  const docTokens = new Set([...sec.matchAll(/`([A-Za-z][A-Za-z0-9_]*)`/g)].map((m) => m[1]));
  const missingInDoc = [...declared].filter((f) => !docTokens.has(f)).sort();
  assert.deepEqual(missingInDoc, [], `contract 声明了但 05 §5.2 未登记：${missingInDoc.join(', ')}`);
  // §5.2 里出现的裸标识符（排除"帧与 AI 轨迹子字段沿用 F6"那一段的说明性文字）
  const ignore = new Set(['data', 'rows', 'self', 'frames', 'duplicate']);
  const extraInDoc = [...docTokens].filter((f) => !declared.has(f) && !ignore.has(f)).sort();
  assert.deepEqual(extraInDoc, [], `05 §5.2 登记了但 contract 未声明：${extraInDoc.join(', ')}`);
  const src = fs.readFileSync(path.join(REPO, 'public', 'format.js'), 'utf8');
  const missingInCode = [...declared].filter((f) => src.indexOf("'" + f + "'") === -1).sort();
  assert.deepEqual(missingInCode, [], `contract 声明了但 format.js 没读：${missingInCode.join(', ')}`);
  // 真实响应逐字段（区分"键缺失"与"值为 undefined"）
  await withHarness(async (h) => {
    await runBatch(h, 'tb6', 11);
    const d = h.state().tournament.envelope.data;
    const present = (obj, f) => obj !== null && obj !== undefined && typeof obj === 'object' && (f in obj);
    for (const f of contract.RANKED_RESULT_FIELDS) assert.ok(present(d.results[0], f), `真实场次缺少 ${f}`);
    // 可选：frames 出现在"有内联帧"的场上（重放批次才没有）
    const withFrames = d.results.find((r) => Array.isArray(r.frames));
    assert.ok(withFrames && present(withFrames, 'frames'), '新批次应内联 frames（D-167）');
    await h.run('board-points');
    const board = h.state().board.envelope.data;
    assert.ok(Array.isArray(board.rows) && board.rows.length > 0, '真实榜单应有行');
    for (const f of contract.LEADERBOARD_ROW_FIELDS) assert.ok(present(board.rows[0], f), `真实榜单行缺少 ${f}`);
    if (board.self !== null) {
      for (const f of contract.LEADERBOARD_SELF_FIELDS) assert.ok(present(board.self, f), `真实 self 缺少 ${f}`);
    }
  });
});

/* ---------- TB-7：排行榜 ---------- */

test('TB-7 排行榜：榜头/行/本人名次逐字来自真实响应；self=null 时不伪造', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb7', 3);
    await h.run('goto-leaderboard');
    await h.run('board-points');
    assert.ok(h.state().board.envelope, `榜单应加载：${h.notice()}`);
    const env = h.state().board.envelope;
    const head = format.boardHeadText(env);
    assert.ok(head.indexOf('积分榜') === 0, head);
    assert.ok(head.indexOf('共 ' + env.data.total + ' 人') !== -1, head);
    const vm = format.viewModel(h.state());
    assert.ok(vm.lines.indexOf(head) !== -1, '榜头行必须渲染');
    const selfLine = format.boardSelfText(env);
    assert.ok(selfLine.indexOf('我：第 ') === 0, `本人名次行：${selfLine}`);
    assert.ok(vm.lines.indexOf(selfLine) !== -1, '本人名次行必须渲染');
    assert.equal(vm.rows.length, env.data.rows.length, '行数 = 本页行数');
    for (let i = 0; i < vm.rows.length; i++) {
      assert.ok(vm.rows[i].text.indexOf('第 ' + env.data.rows[i].rank + ' 名') === 0, vm.rows[i].text);
      assert.ok(vm.rows[i].text.indexOf(env.data.rows[i].publicId) !== -1, vm.rows[i].text);
    }
    // self=null（匿名）→ 文案写明，不伪造名次
    const anon = await h.api.leaderboard(null, 'order=points&scope=global&offset=0&limit=20');
    assert.equal(anon.status, 200);
    assert.equal(anon.envelope.data.self, null, '匿名请求不得回带本人名次');
    assert.equal(format.boardSelfText(anon.envelope), format.BOARD_SELF_NONE_TEXT);
    assert.equal(format.boardSelfOf(anon.envelope), null);
    // 段位榜：行文本追加"到达"
    await h.run('board-tier');
    const tierEnv = h.state().board.envelope;
    assert.equal(tierEnv.data.order, 'arrival');
    if (tierEnv.data.rows.length > 0) {
      const line = format.boardLineText(format.boardRows(tierEnv)[0], tierEnv);
      assert.ok(line.indexOf('到达 ') !== -1, line);
    }
  });
});

/* ---------- TB-8：切榜/换范围/翻页 ---------- */

test('TB-8 切榜/换范围/翻页：请求参数正确、禁用随 offset/hasMore、刷新保持当前参数', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb8', 3);
    await h.run('goto-leaderboard');
    await h.run('board-points');
    assert.equal(h.boardQueries[h.boardQueries.length - 1], 'order=points&scope=global&offset=0&limit=20');
    await h.run('board-tier');
    assert.equal(h.boardQueries[h.boardQueries.length - 1], 'order=arrival&scope=global&offset=0&limit=20');
    await h.run('board-scope', { tier: 'epic' });
    assert.equal(h.boardQueries[h.boardQueries.length - 1], 'order=arrival&scope=tier%3Aepic&offset=0&limit=20');
    await h.run('board-scope', { tier: 'global' });
    assert.equal(h.boardQueries[h.boardQueries.length - 1], 'order=arrival&scope=global&offset=0&limit=20');
    assert.equal(h.state().board.scope, 'global');
    // 切榜必须回到第 1 页（避免"第 3 页的另一个榜"）
    h.dispatch({ type: 'board.page.set', offset: 40 });
    await h.run('board-points');
    assert.equal(h.state().board.offset, 0, '切榜应回到第 1 页');
    assert.equal(h.state().board.board, 'points');
    // 翻页：offset = limit 的整数倍；上一页夹到 0；无 hasMore 时下一页是空操作
    //   审查 F7-E：默认 limit=20 + 4 个账号 ⇒ `hasMore` 恒 false，`if` 的真分支是**死代码**。
    //   故先把每页压到 1 人，让 `hasMore=true` 分支真正被执行。
    h.dispatch({ type: 'board.set', envelope: null, board: 'points', scope: 'global', offset: 0, limit: 1 });
    await h.run('board-refresh');
    assert.equal(h.boardQueries[h.boardQueries.length - 1], 'order=points&scope=global&offset=0&limit=1');
    const env = h.state().board.envelope;
    const limit = h.state().board.limit;
    assert.equal(limit, 1);
    assert.equal(env.data.hasMore, true, '每页 1 人 + 至少 2 个账号 → 必须还有下一页（否则本用例又没覆盖到）');
    {
      await h.run('board-next');
      assert.equal(h.state().board.offset, limit);
      assert.equal(h.boardQueries[h.boardQueries.length - 1], `order=points&scope=global&offset=${limit}&limit=${limit}`);
      await h.run('board-prev');
      assert.equal(h.state().board.offset, 0);
    }
    await h.run('board-prev');
    assert.equal(h.state().board.offset, 0, '首页再往前夹取');
    // 末页：hasMore=false → 「下一页」不得发请求
    const total = env.data.total;
    h.dispatch({ type: 'board.set', envelope: null, board: 'points', scope: 'global', offset: Math.max(0, total - 1), limit: 1 });
    await h.run('board-refresh');
    if (!format.boardHasMore(h.state().board.envelope)) {
      const before = h.boardQueries.length;
      await h.run('board-next');
      assert.equal(h.boardQueries.length, before, 'hasMore=false 时「下一页」不得发请求（按钮也已禁用）');
    }
    // 刷新保持 board/scope/offset（恢复默认每页 20，便于后面断言行数）
    h.dispatch({ type: 'board.set', envelope: null, board: 'arrival', scope: 'global', offset: 0, limit: 20 });
    await h.run('board-refresh');
    const beforeRefresh = h.state().board;
    await h.run('board-refresh');
    assert.equal(h.state().board.board, beforeRefresh.board);
    assert.equal(h.state().board.scope, beforeRefresh.scope);
    assert.equal(h.state().board.offset, beforeRefresh.offset);
    assert.equal(h.notice(), format.BOARD_OK_TEXT);
    // 按钮禁用随 offset/hasMore
    const vm = format.viewModel(h.state());
    const dis = (a) => vm.buttons.filter((b) => b.action === a)[0].disabled === true;
    assert.ok(dis('board-prev'), 'offset=0 时「上一页」禁用');
    assert.equal(dis('board-next'), !format.boardHasMore(h.state().board.envelope));
    // 范围按钮：当前范围禁用
    const scopeBtns = vm.buttons.filter((b) => b.action === 'board-scope');
    assert.equal(scopeBtns.length, 6, '范围按钮 = 全部 + 五段位');
    assert.equal(scopeBtns.filter((b) => b.disabled).length, 1, '只有当前范围那一个禁用');
  });
});

/* ---------- TB-11：榜人数缩水时回退页号（审查 F7-D 的回归） ---------- */

test('TB-11 榜人数缩水（封禁/删号）：offset 越界必须回退到有效页，不得显示「第 2/1 页」', async () => {
  await withHarness(async (h, s) => {
    const { others } = await runBatch(h, 'tb11', 3);
    await h.run('goto-leaderboard');
    h.dispatch({ type: 'board.set', envelope: null, board: 'points', scope: 'global', offset: 0, limit: 1 });
    await h.run('board-refresh');
    assert.equal(h.state().board.envelope.data.total, 4, '我 + 3 个对手都在榜上');
    await h.run('board-next');
    assert.equal(h.state().board.offset, 1);
    assert.ok(format.boardHeadText(h.state().board.envelope).indexOf('第 2/4 页') !== -1,
      format.boardHeadText(h.state().board.envelope));

    // 榜人数缩水到 1：删掉 3 个对手的档案（等价于删号；封禁同理）
    const { playerIdByPublicId } = require('../helpers/http.js');
    for (const u of others) {
      const pid = await playerIdByPublicId(s.store, u.data.publicId);
      assert.ok(pid, '应能反查对手 playerId');
      await s.store.removeArchive(pid);
    }
    await h.run('board-refresh');
    assert.equal(h.state().board.offset, 0, '人数缩水后必须回退到有效页（审查 F7-D）');
    const head = format.boardHeadText(h.state().board.envelope);
    assert.ok(head.indexOf('第 1/1 页') !== -1, `页号必须与 total 一致：${head}`);
    assert.ok(head.indexOf('第 2/1 页') === -1, '不得出现「第 2/1 页」这种自相矛盾的分页行');
    // 回退是"最多一次"的收敛行为：再刷新仍是第 1 页，且不发第二次请求
    const before = h.boardQueries.length;
    await h.run('board-refresh');
    assert.equal(h.state().board.offset, 0);
    assert.equal(h.boardQueries.length, before + 1, '回退后再次刷新只发一次请求（不得反复回退）');
  });
});

/* ---------- TB-12：锦标赛屏的查看器门控（与 F6 的 QB-11 同口径） ---------- */

test('TB-12 锦标赛屏只显示属于本批的帧（跨屏残留不得被当作本批战斗）', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb12', 3);
    const results = h.state().tournament.envelope.data.results;
    const idx = results.findIndex((r) => Array.isArray(r.frames) && r.frames.length > 0);
    assert.ok(idx >= 0);
    await h.run('tournament-open-battle', { idx: String(idx) });
    let vm = format.viewModel(h.state());
    assert.ok(vm.lines.some((l) => l.indexOf('第 1/' + results[idx].frames.length + ' 帧') === 0), '本批帧应渲染');
    // 别场（模拟 F6 的快速对战帧或另一批的场次）
    h.dispatch({ type: 'viewer.set', frames: QUICK_FRAMES_STUB, source: 'quick', battleId: 'b_other' });
    vm = format.viewModel(h.state());
    assert.ok(!vm.lines.some((l) => l.indexOf('第 1/' + QUICK_FRAMES_STUB.length + ' 帧') === 0),
      '别场的帧不得在锦标赛屏被当作本批战斗渲染');
    assert.ok(vm.lines.some((l) => l.indexOf('别处') !== -1), vm.lines.join(' | '));
    const dis = (a) => vm.buttons.filter((b) => b.action === a)[0].disabled === true;
    for (const a of ['viewer-first', 'viewer-prev', 'viewer-next', 'viewer-last', 'viewer-trace-p1', 'viewer-trace-p2']) {
      assert.ok(dis(a), `非本批帧时 ${a} 必须禁用`);
    }
    assert.equal(vm.buttons.some((b) => b.action === 'viewer-load-replay'), false,
      '查看器里的对局不属于本批 → 不提供「读取本场回放」');
  });
});

test('TB-9 动作双向闭合：两屏渲染集合 == 注册表的 F7 动作（无死按钮、无不可达）', async () => {
  await withHarness(async (h) => {
    // 初始态（未加载）也要渲染出这些动作
    h.dispatch({ type: 'view.go', view: 'tournament' });
    const t0 = h.actionsIn();
    h.dispatch({ type: 'view.go', view: 'leaderboard' });
    const b0 = h.actionsIn();
    await runBatch(h, 'tb9', 11);
    h.dispatch({ type: 'view.go', view: 'tournament' });
    const t1 = h.actionsIn();
    await h.run('goto-leaderboard');
    await h.run('board-points');
    const b1 = h.actionsIn();
    const all = new Set([...t0, ...b0, ...t1, ...b1]);
    for (const name of F7_ACTIONS) {
      assert.ok(all.has(name), `F7 动作缺少可达入口：${name}`);
      assert.ok(actions.ACTIONS[name] && typeof actions.ACTIONS[name].run === 'function', `${name} 未注册`);
    }
    const dead = [...all].filter((a) => actions.ACTIONS[a] === undefined);
    assert.deepEqual(dead, [], `渲染了未注册动作：${dead.join(', ')}`);
  });
});

/* ---------- TB-10：busy + data-tier 寻址 ---------- */

test('TB-10 busy 全禁用 + 不重入；data-tier 寻址链（渲染 / payload 白名单 / 动作消费）', async () => {
  await withHarness(async (h) => {
    await runBatch(h, 'tb10', 3);
    h.dispatch({ type: 'view.go', view: 'tournament' });
    h.dispatch({ type: 'busy.set', busy: true });
    for (const b of format.viewModel(h.state()).buttons) {
      assert.equal(b.disabled, true, `锦标赛屏 busy 时按钮未禁用：${b.action}`);
    }
    h.dispatch({ type: 'view.go', view: 'leaderboard' });
    for (const b of format.viewModel(h.state()).buttons) {
      assert.equal(b.disabled, true, `排行榜屏 busy 时按钮未禁用：${b.action}`);
    }
    const before = h.calls.length;
    await h.run('tournament-run');
    await h.run('board-points');
    assert.equal(h.calls.length, before, 'busy 时不得发请求');
    h.dispatch({ type: 'busy.set', busy: false });

    // 寻址扩展（05 §4 注）：`data-tier` 必须① 渲染出来，② 在 app.payloadOf 的白名单里，③ 被动作消费。
    //   ①渲染
    await h.run('goto-leaderboard');
    await h.run('board-points');
    const html = h.html();
    assert.ok(/data-action="board-scope"[^>]*data-tier="common"/.test(html)
      || /data-tier="common"[^>]*data-action="board-scope"/.test(html), '范围按钮必须带 data-tier="common"');
    //   ②搬运（源码级：app.js 的 payloadOf 键白名单必须含 tier，否则 data-tier 永远进不了 payload）
    const appSrc = fs.readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');
    const keysLine = appSrc.split('\n').find((l) => l.includes('var keys = ['));
    assert.ok(keysLine && keysLine.includes("'tier'"), `app.payloadOf 白名单缺少 'tier'：${keysLine}`);
    //   ③消费：payload.tier → scope=tier:<t> 的请求
    await h.run('board-scope', { tier: 'common' });
    assert.equal(h.state().board.scope, 'tier:common');
    assert.ok(h.boardQueries[h.boardQueries.length - 1].indexOf('scope=tier%3Acommon') !== -1,
      h.boardQueries[h.boardQueries.length - 1]);
  });
});
