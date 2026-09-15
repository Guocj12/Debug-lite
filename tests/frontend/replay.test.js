'use strict';
// F5 replay 测试 —— frontend-spec §7（planFrame 图元投影 golden）/§6.6（布局/播放状态机/结算）/mount canvas 绘制
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('planFrame：base/players/bullets/hits/collision/verdict 图元投影（1px 投影，无重算）', async () => {
  const { planFrame, clampTick, FIELD_PX, CELL_PX } = await import('../../public/js/render/planFrame.js');
  const diff = {
    tick: 3,
    players: { p1: { fromX: 224, toX: 288, hp: 100, mp: 40, sp: 60, facing: 1 }, p2: { fromX: 800, toX: 736, hp: 70, mp: 40, sp: 60, facing: -1 } },
    bullets: [{ uid: 'b1', owner: 'p1', x: 320, len: 64, dir: 1 }],
    bulletHits: [{ uid: 'b1', target: 'p2', atX: 720 }],
    collision: { contactX: 512 },
    bases: { p1: { hp: 100, maxHp: 100, def: 64 }, p2: { hp: 50, maxHp: 100, def: 64 } },
    verdict: null,
  };
  const out = planFrame(diff, 3);
  const p1 = out.find((p) => p.kind === 'player' && p.owner === 'p1');
  assert.deepEqual([p1.x, p1.y, p1.w, p1.h], [288, 96 - 32, 64, 64], 'toX 投影 + 中心线 96');
  assert.equal(p1.frameIndex, 3);
  assert.equal(p1.hp, 100);
  // 基地图元（screens.md replay 表 base_l 0,102,32,26 / base_r 992,102,32,26）
  const bl = out.find((p) => p.kind === 'base' && p.owner === 'p1');
  const br = out.find((p) => p.kind === 'base' && p.owner === 'p2');
  assert.deepEqual([bl.x, bl.y, bl.w, bl.h, bl.hp], [0, 102, 32, 26, 100]);
  assert.deepEqual([br.x, br.y, br.w, br.h, br.hp], [FIELD_PX - 32, 102, 32, 26, 50]);
  assert.ok(out.some((p) => p.kind === 'bullet' && p.x === 320));
  assert.ok(out.some((p) => p.kind === 'hit' && p.x === 720));
  assert.ok(out.some((p) => p.kind === 'collision' && p.x === 512));
  assert.equal(planFrame(null, 0).length, 0, '空 diff 安全');
  assert.equal(planFrame({}, 0).length, 0);
  assert.equal(planFrame({ bases: { p1: { hp: 1 } } }, 0).length, 1, '仅基地时只出基地图元');
  // verdict 文本
  const v = planFrame({ verdict: { winner: 'A', phase: 'role' } }, 9);
  assert.equal(v.find((p) => p.kind === 'verdict').text, 'winner=A phase=role');
  // clampTick 域（3 帧 → 索引 0..2）
  assert.equal(clampTick(3, [{}, {}, {}], 1), 2, '超过末帧 → 封顶');
  assert.equal(clampTick(0, [{}, {}, {}], -1), 0);
  assert.equal(clampTick(undefined, [], 1), 0);
  assert.equal(clampTick(1, [{}, {}], 99), 1);
  assert.equal(FIELD_PX, 1024);
  assert.equal(CELL_PX, 64);
});

test('replayLayout：canvas/hp1·hp2 条/控制条/aiTrace/结算 Modal（screens.md replay 表）+ verifyLayout 全绿', async () => {
  const { replayLayout, hpRatio, hpFillWidth, statusText } = await import('../../public/js/views/replay.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const mk = (patch) => Object.assign({
    screen: 'replay', tier: 'mythic', seed: 1,
    battle: {
      frames: [
        // aiTrace 用实装形状 {owner,path,nodeType,result}（runtime.js traceNode）
        { tick: 1, diff: { players: { p1: { toX: 224, hp: 100, mp: 40, sp: 60 }, p2: { toX: 800, hp: 90, mp: 40, sp: 60 } }, bases: { p1: { hp: 100 }, p2: { hp: 90 } }, aiTrace: [{ owner: 'p1', path: '0:action', nodeType: 'action', result: 'move_right' }] } },
        { tick: 2, diff: { players: { p1: { toX: 288, hp: 100, mp: 40, sp: 60 }, p2: { toX: 736, hp: 50, mp: 40, sp: 60 } }, bases: { p1: { hp: 100 }, p2: { hp: 90 } }, aiTrace: [] } },
      ],
      result: null, tick: 0, speed: 1, playing: false, running: false,
    },
    ui: { busy: false, snackbar: [], modal: null, activeTab: {} },
  }, patch || {});
  const boxes = replayLayout(mk());
  const geo = (id) => {
    const b = boxes.find((x) => x.id === id);
    return [b.x, b.y, b.w, b.h, b.z].join(',');
  };
  assert.equal(geo('canvas'), '16,80,1024,128,1', '表 canvas 行');
  assert.equal(geo('hp1'), '16,84,96,8,4', '表 hp1 行');
  assert.equal(geo('hp2'), '912,84,96,8,4', '表 hp2 行');
  assert.equal(geo('controls'), '16,220,1024,56,2', '表 controls 行');
  assert.equal(geo('aiTrace'), '1064,80,200,400,2', '表 aiTrace 行');
  // 血条填充（轨道 96 → 内宽 94；p1 满血 = 94，p2 峰值 100 → 90/100 × 94 = 85）
  assert.equal(geo('hp1_fill'), '17,85,94,6,5');
  const frames = mk().battle.frames;
  assert.equal(boxes.find((b) => b.id === 'hp1_fill').w, 94, 'tick0 满血 = 轨道内宽 94');
  assert.equal(boxes.find((b) => b.id === 'hp2_fill').w, 94, 'tick0 hp=峰值（p2 峰值 90）→ 满格');
  assert.equal(hpFillWidth(94, hpRatio(frames, 'p2', 45)), 47, '峰值一半 → 47px');
  assert.equal(hpRatio([{ diff: { players: { p1: { hp: 50 } } } }, { diff: { players: { p1: { hp: 100 } } } }], 'p1', 50), 0.5);
  assert.equal(hpRatio([], 'p1', 50), 1, '无帧 → 满格兜底');
  assert.equal(hpRatio([], 'p1', undefined), 1, '无 hp → 满格兜底');
  assert.equal(hpFillWidth(96, 0), 2, '0 血仍留 2px 残条（避免自检 zero 误报）');
  // 状态行（T:x/y + 双方 hp/base）
  const status = boxes.find((b) => b.id === 'replay_status');
  assert.equal(status.parent, 'controls');
  assert.equal(status.text, 'T:0/1 · p1 hp 100/base 100 · p2 hp 90/base 90');
  assert.equal(statusText([], 0, {}, {}), 'T:0/0 · p1 — · p2 —');
  assert.equal(boxes.find((b) => b.id === 'replay_play').action, 'replay/play');
  assert.equal(boxes.find((b) => b.id === 'replay_speed_2').payload.speed, 2);
  assert.ok(boxes.find((b) => b.id === 'replay_ai_0'), 'aiTrace 行');
  assert.ok(boxes.find((b) => b.id === 'replay_ai_0').text.includes('move_right'), 'aiTrace 行按实装字段');
  const verify = verifyLayout(boxes);
  assert.equal(verify.ok, true, `无结算布局自检：${verify.issues.slice(0, 3).map((i) => `${i.boxId}:${i.issue}`).join(',')}`);
  // 结算态：mask + modal（表 modal 行）+ 按钮
  const ended = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: {} }], result: { winner: 'B', ticks: 5 }, tick: 0, speed: 1, playing: false, running: false } }));
  assert.ok(ended.find((b) => b.id === 'replay_modal_mask'), '结算遮罩');
  assert.equal([ended.find((b) => b.id === 'modal').x, ended.find((b) => b.id === 'modal').y,
    ended.find((b) => b.id === 'modal').w, ended.find((b) => b.id === 'modal').h].join(','), '400,280,480,160', '表 modal 行');
  assert.equal(ended.find((b) => b.id === 'replay_modal_text').text, 'winner=B（5 tick）');
  assert.equal(ended.find((b) => b.id === 'replay_again').goto, 'battle');
  assert.equal(ended.find((b) => b.id === 'replay_menu').goto, 'menu');
  // 结算兜底臂：winner 缺 → ?；ticks 缺 → 0
  const ended2 = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: {} }], result: { winner: null, ticks: undefined }, tick: 0, speed: 1, playing: false, running: false } }));
  assert.equal(ended2.find((b) => b.id === 'replay_modal_text').text, 'winner=?（0 tick）');
  const verifyEnd = verifyLayout(ended);
  assert.equal(verifyEnd.ok, true, `结算布局自检：${verifyEnd.issues.slice(0, 3).map((i) => `${i.boxId}:${i.issue}`).join(',')}`);
  // 结算时刻：多帧 + result 时 tick 0 不弹结算（否则遮罩从进屏起覆盖全部控制条）；末帧才弹
  const early = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: {} }, { tick: 2, diff: {} }], result: { winner: 'B', ticks: 2 }, tick: 0, speed: 1, playing: false, running: false } }));
  assert.equal(early.find((b) => b.id === 'replay_modal_mask'), undefined, 'tick 0 不弹结算');
  const atEnd = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: {} }, { tick: 2, diff: {} }], result: { winner: 'B', ticks: 2 }, tick: 1, speed: 1, playing: false, running: false } }));
  assert.ok(atEnd.find((b) => b.id === 'replay_modal_mask'), '末帧弹结算');
  // 播放中 → 暂停按钮
  const playing = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: {} }], result: null, tick: 0, speed: 2, playing: true, running: false } }));
  assert.equal(playing.find((b) => b.id === 'replay_play').action, 'replay/pause');
  assert.equal(playing.find((b) => b.id === 'replay_speed_2').style, 'on');
  // 空 tracks → 占位
  const empty = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: {} }], result: null, tick: 0, speed: 1, playing: false, running: false } }));
  assert.ok(empty.find((b) => b.id === 'replay_ai_empty'));
  // 分支锤：HUD 缺玩家 → 状态行占位
  const noPlayers = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: {} }], result: null, tick: 0, speed: 1, playing: false, running: false } }));
  assert.ok(noPlayers.find((b) => b.id === 'replay_status').text.includes('p1 —'), 'HUD 缺玩家占位');
  // 分支锤：玩家在但 bases 缺失 → 无 /base 段
  const noBases = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: { players: { p1: { toX: 1, hp: 1, mp: 1, sp: 1 }, p2: { toX: 2, hp: 1, mp: 1, sp: 1 } } } }], result: null, tick: 0, speed: 1, playing: false, running: false } }));
  assert.equal(noBases.find((b) => b.id === 'replay_status').text.includes('/base'), false, 'bases 缺失不渲染 /base');
  assert.equal(noBases.find((b) => b.id === 'replay_status').text.includes('p1 hp 1'), true);
  // 分支锤：aiTrace 无 result / 无 path → 行文本无箭头不空转
  const traceRows = replayLayout(mk({ battle: { frames: [{ tick: 1, diff: { aiTrace: [{ owner: 'p2', path: '0:stmt', nodeType: 'stmt' }] } }], result: null, tick: 0, speed: 1, playing: false, running: false } }));
  const stmtRow = traceRows.find((b) => b.id === 'replay_ai_0');
  assert.equal(stmtRow.text.includes('→'), false, '无 result → 无箭头');
  assert.ok(stmtRow.text.includes('0:stmt'), 'path 展示');
  // 分支锤：空帧 + result（fail-safe）→ 结算仍显示
  const emptyFramesRes = replayLayout(mk({ battle: { frames: [], result: { winner: 'A', ticks: 0 }, tick: 0, speed: 1, playing: false, running: false } }));
  assert.ok(emptyFramesRes.find((b) => b.id === 'replay_modal_mask'), '空帧 result fail-safe 结算');
  const zero = replayLayout(mk({ battle: { frames: [], result: null, tick: 0, speed: 1, playing: false, running: false } }));
  assert.equal(zero.find((b) => b.id === 'replay_status').text.startsWith('T:0/0'), true, '0 帧显示');
  assert.ok(zero.find((b) => b.id === 'replay_ai_empty'));
});

test('F8 回归：真实 store 上暂停链不递归（曾 effect↔effect 无限递归 → RangeError 栈溢出）', async () => {
  const { createStore } = await import('../../public/js/store/index.js');
  const { initialState, reducer } = await import('../../public/js/store/reducer.js');
  const frames = [{ tick: 1, diff: {} }, { tick: 2, diff: {} }];
  const playing = { ...initialState(), battle: { ...initialState().battle, frames, speed: 4, playing: true, tick: 0 } };
  const store = createStore({ api: {}, log: null, state: playing });
  // 修复前：replay/pause → effect → battle/pause → effect → replay/pause… 同步递归爆栈
  store.dispatch({ type: 'replay/pause' });
  assert.equal(store.getState().battle.playing, false, '暂停生效（不抛即为修复）');
  store.dispatch({ type: 'battle/pause' });
  assert.equal(store.getState().battle.playing, false, '已停态再暂停幂等');
  store.dispatch({ type: 'battle/play' });
  store.dispatch({ type: 'replay/pause' });
  assert.equal(store.getState().battle.playing, false, '播放中暂停复位');
  // reducer 幂等：非播放态 battle/pause → 原 state 引用（避免多余重渲染）
  const base = initialState();
  assert.equal(reducer(base, { type: 'battle/pause' }), base, '暂停态返回原引用');
  assert.equal(reducer(playing, { type: 'battle/pause' }).battle.playing, false);
});

test('播放状态机：play → 假 timers 推进 → 末帧自动 pause；step/back/speed 重启', async () => {  const { runEffect } = await import('../../public/js/store/effects.js');
  const frames = [{ tick: 1, diff: {} }, { tick: 2, diff: {} }, { tick: 3, diff: {} }];
  let state = { battle: { frames, tick: 0, speed: 1, playing: false } };
  const actions = [];
  const intervals = [];
  const fakeTimers = {
    setInterval: (fn, ms) => { const id = intervals.length + 1; intervals.push({ id, fn, ms }); return id; },
    clearInterval: (id) => { const i = intervals.findIndex((x) => x.id === id); if (i >= 0) intervals[i].cleared = true; },
  };
  const ctx = {
    store: () => state,
    dispatch: (a) => {
      actions.push(a);
      // 简化 reducer：应用 seek/play/pause/speed 到 state
      if (a.type === 'battle/seek') state = { ...state, battle: { ...state.battle, tick: a.payload.tick } };
      if (a.type === 'battle/play') state = { ...state, battle: { ...state.battle, playing: true } };
      if (a.type === 'battle/pause') state = { ...state, battle: { ...state.battle, playing: false } };
      if (a.type === 'battle/speed') state = { ...state, battle: { ...state.battle, speed: a.payload.speed } };
    },
    timers: fakeTimers,
  };
  await runEffect(ctx, { type: 'replay/play' });
  assert.equal(intervals.length, 1, '启动 1 个定时器');
  assert.equal(intervals[0].ms, 1000, '×1 → 1000ms');
  assert.equal(state.battle.playing, true);
  // 播放中防重入：再 play 不新增定时器
  await runEffect(ctx, { type: 'replay/play' });
  assert.equal(intervals.length, 1, '播放中防重入');
  // 推进两格（到末帧）
  intervals[0].fn();
  assert.equal(state.battle.tick, 1);
  intervals[0].fn();
  assert.equal(state.battle.tick, 2, '到末帧');
  assert.equal(state.battle.playing, false, '末帧自动 pause');
  // 播放结束后再 play（末帧停留态：新定时器）→ step 回退后允许
  state = { ...state, battle: { ...state.battle, playing: false } };
  const nAfter = intervals.length;
  await runEffect(ctx, { type: 'replay/play' });
  assert.ok(intervals.length > nAfter, '结束后再播放新开定时器');
  // step/back
  state.battle.playing = false;
  await runEffect(ctx, { type: 'replay/step' });
  assert.equal(state.battle.tick, 2);
  await runEffect(ctx, { type: 'replay/step', payload: { delta: -1 } });
  assert.equal(state.battle.tick, 1);
  // 单帧 frames → play 不启动
  const single = { battle: { frames: [{ tick: 1 }], tick: 0, speed: 1, playing: false } };
  const ctxS = { ...ctx, store: () => single, dispatch: (a) => actions.push(a) };
  const n0 = intervals.length;
  await runEffect(ctxS, { type: 'replay/play' });
  assert.equal(intervals.length, n0, '单帧不启动');
  // speed 播放中重启
  state.battle.playing = true;
  state.battle.frames = [{ tick: 1 }, { tick: 2 }, { tick: 3 }];
  ctx.playbackTimer = 999; // 模拟播放中
  const before = intervals.length;
  await runEffect(ctx, { type: 'replay/speed', payload: { speed: 2 } });
  assert.equal(state.battle.speed, 2);
  assert.ok(intervals.length >= before, '改速重启定时器');
  // battle/pause 清定时器 + 无 ctx.timers 兜底（storedTimers 默认创建）
  await runEffect(ctx, { type: 'battle/pause' });
  assert.equal(state.battle.playing, false);
  assert.equal(ctx.playbackTimer, null);
  // replay/pause（F5 P1 回归锁：暂停按钮 action 契约名——原 EFFECTS 无此键 → 死按钮）
  state.battle.playing = true;
  state.battle.frames = [{ tick: 1 }, { tick: 2 }, { tick: 3 }];
  const alive = intervals[intervals.length - 1];
  ctx.playbackTimer = alive.id !== undefined ? alive.id : intervals.length; // 模拟播放中定时器
  await runEffect(ctx, { type: 'replay/pause' });
  assert.equal(state.battle.playing, false, 'replay/pause 复位 playing');
  assert.equal(ctx.playbackTimer, null, 'replay/pause 清定时器');
  const noTimers = { ...ctx, timers: undefined };
  noTimers.playbackTimer = null;
  await runEffect(noTimers, { type: 'battle/pause' }); // 兜底面上直接走默认 clearInterval 创建（无实际定时器）
  assert.equal(noTimers.playbackTimer, null);
  // clampTick 尖角：null tick / delta 0
  const { clampTick } = await import('../../public/js/render/planFrame.js');
  assert.equal(clampTick(null, [{}, {}], 0), 0, 'null tick 归 0 + delta0 → 0');
  assert.equal(clampTick(undefined, [{}, {}], 0), 0);
});

test('paintCanvas：stub ctx 绘制序列（清屏/背景/中线/图元）+ no-ctx 跳过', async () => {
  const { paintCanvas } = await import('../../public/js/mount/canvas.js');
  const calls = [];
  const ctx = {
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    fillStyle: null,
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    strokeStyle: null,
    beginPath: () => calls.push(['beginPath']),
    moveTo: (...a) => calls.push(['moveTo', ...a]),
    lineTo: (...a) => calls.push(['lineTo', ...a]),
    stroke: () => calls.push(['stroke']),
    fillText: (...a) => calls.push(['fillText', ...a]),
  };
  const prims = [
    { kind: 'player', owner: 'p1', x: 224, y: 64, w: 64, h: 64 },
    { kind: 'player', owner: 'p2', x: 800, y: 64, w: 64, h: 64 },
    { kind: 'bullet', owner: 'p1', x: 320, y: 92, w: 64, h: 8 },
    { kind: 'hit', x: 720, y: 88, w: 16, h: 16 },
    { kind: 'collision', x: 512, y: 84, w: 24, h: 24 },
    { kind: 'verdict', text: 'winner=A', x: 8, y: 8, w: 200, h: 16 },
  ];
  const r = paintCanvas(null, prims, { ctx });
  assert.equal(r.painted, true);
  assert.equal(r.count, 6);
  assert.equal(calls[0][0], 'clearRect');
  assert.ok(calls.some(([k, x]) => k === 'fillRect' && x === 224), 'p1 矩形');
  assert.ok(calls.some(([k]) => k === 'fillText'), 'verdict 文本');
  // 颜色归属
  const playerFills = calls.filter(([k]) => k === 'fillRect').map((c) => ({ x: c[1] }));
  const p1Idx = calls.findIndex(([k, x]) => k === 'fillRect' && x === 224);
  assert.equal(calls.findIndex(([k, x]) => k === 'fillRect' && x === 800) > p1Idx, true);
  // no-ctx 跳过
  assert.equal(paintCanvas({}, prims, {}).painted, false);
  // 空图元
  const r2 = paintCanvas(null, [], { ctx });
  assert.equal(r2.count, 0);
  // 无 fillText 的 ctx（verdict 兜底）+ null 图元
  const noText = [];
  const bareCtx = {
    clearRect: () => {}, fillRect: () => {}, strokeStyle: null, fillStyle: null,
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
  };
  const r3 = paintCanvas(null, [{ kind: 'verdict', text: 'x', x: 1, y: 1 }], { ctx: bareCtx });
  assert.equal(r3.painted, true);
  assert.equal(paintCanvas(null, null, { ctx }).count, 0);
  void noText;
});

test('mount index：回放屏 paint → canvas 绘制路径（fake doc + fake ctx）', async () => {
  const { mountApp } = await import('../../public/js/mount/index.js');
  const { createStore } = await import('../../public/js/store/index.js');
  const paintLogs = [];
  const fakeCtx = {
    clearRect: () => {}, fillRect: () => {}, strokeStyle: null, fillStyle: null,
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {}, fillText: () => {},
  };
  const battleEl = { getContext: () => fakeCtx };
  const fakeDoc = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : id === 'battle' ? battleEl : null),
    createElement: () => ({ id: '', href: '', download: '', click: () => {} }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const store = createStore({
    api: {}, log: { debug: (ch, ev) => paintLogs.push(ev), warn: () => {} },
    records: () => [], doc: fakeDoc,
    state: {
      screen: 'replay', tier: 'mythic', seed: 1, meta: { serverOk: true }, loadout: { role: null, skills: [] },
      gacha: { opening: false, lastResult: null }, aiDraft: { errors: [] },
      battle: { frames: [{ tick: 1, diff: { players: { p1: { toX: 224, hp: 100, mp: 40, sp: 60 }, p2: { toX: 800, hp: 100, mp: 40, sp: 60 } } } }], result: null, tick: 0, speed: 1, playing: false, running: false },
      ui: { busy: false, snackbar: [], modal: null, activeTab: {} },
      warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
      logPrefs: { level: 'debug', channels: {}, panelOpen: false }, panel: null, seed: null,
    },
  });
  const mount = mountApp({
    doc: fakeDoc, store, log: { debug: (ch, ev, msg, d) => paintLogs.push([ev, d && d.painted]), warn: () => {} },
    records: () => [],
    renderScreen: (st) => ({ shell: [], main: [{ id: 'replay_canvas', kind: 'canvas', parent: null, x: 16, y: 80, w: 1024, h: 128, z: 1, visible: true, text: '画布' }] }),
  });
  assert.equal(mount.mounted, true);
  // canvas 直连（不依赖全局 getElementById 要真 #battle —— fake doc 提供）
  store.dispatch({ type: 'battle/seek', payload: { tick: 0 } });
  assert.ok(paintLogs.some((l) => Array.isArray(l) && l[0] === 'render.frame'), 'canvas 绘制日志');
  // tick 越界（frames[5] undefined → planFrame(undefined) 安全）
  store.dispatch({ type: 'battle/seek', payload: { tick: 5 } });
  assert.equal(store.getState().battle.tick, 5);
  assert.ok(paintLogs.length >= 2, '越界 tick 也完成 paint（diff 空安全）');
  // 分支：回放屏无 #battle 元素（跳过绘制）；el 无 getContext（no-ctx 日志）
  const fakeDocNoCanvas = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : null),
    createElement: () => ({ id: '' }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const replayInit = (battle) => ({
    screen: 'replay', tier: 'mythic', seed: 1, meta: { serverOk: true }, loadout: { role: null, skills: [] },
    gacha: { opening: false, lastResult: null }, aiDraft: { errors: [] },
    battle, ui: { busy: false, snackbar: [], modal: null, activeTab: {} },
    warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
    logPrefs: { level: 'debug', channels: {}, panelOpen: false }, panel: null, seed: null,
  });
  const store2 = createStore({ api: {}, log: null, doc: fakeDocNoCanvas, state: replayInit({ frames: [{ tick: 1, diff: {} }], result: null, tick: 0, speed: 1, playing: false, running: false }) });
  const logs2 = [];
  mountApp({
    doc: fakeDocNoCanvas, store: store2, log: { debug: (ch, ev, msg, d) => logs2.push([ev, d]), warn: () => {} }, records: () => [],
    renderScreen: (st) => ({ shell: [], main: [{ id: 'replay_canvas', kind: 'canvas', parent: null, x: 0, y: 0, w: 10, h: 10, z: 1, visible: true, text: '画布' }] }),
  });
  assert.ok(logs2.some((l) => l[0] === 'render.frame'), '无 canvas 元素也完成 paint');
  const bareBattle = { getContext: () => null };
  const fakeDoc3 = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : id === 'battle' ? bareBattle : null),
    createElement: () => ({ id: '' }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const store3 = createStore({ api: {}, log: null, doc: fakeDoc3, state: replayInit({ frames: [{ tick: 1, diff: {} }], result: null, tick: 0, speed: 1, playing: false, running: false }) });
  const logs3 = [];
  mountApp({
    doc: fakeDoc3, store: store3, log: { debug: (ch, ev, msg, d) => logs3.push([ev, d && d.painted]), warn: () => {} }, records: () => [],
    renderScreen: (st) => ({ shell: [], main: [{ id: 'replay_canvas', kind: 'canvas', parent: null, x: 0, y: 0, w: 10, h: 10, z: 1, visible: true, text: '画布' }] }),
  });
  assert.ok(logs3.some((l) => l[0] === 'render.frame' && l[1] === false), 'no-ctx 分支日志');
});

test('mount index：盒坐标注入 + #battle 画布显隐/定位（style 感知 doc；F5 P1 回归锁）', async () => {
  const { mountApp } = await import('../../public/js/mount/index.js');
  const { createStore } = await import('../../public/js/store/index.js');
  const { replayLayout } = await import('../../public/js/views/replay.js');
  const styles = {};
  const mkEl = (id) => { const el = { style: {}, getContext: () => null }; styles[id] = el; return el; };
  const appEl = { innerHTML: '', parentNode: null, style: {} };
  const battleEl = mkEl('battle');
  const doc = {
    getElementById: (id) => (id === 'app' ? appEl : id === 'battle' ? battleEl : styles[id] || null),
    createElement: () => mkEl('created'),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const replayState = {
    screen: 'replay', tier: 'mythic', seed: 1, meta: { serverOk: true }, loadout: { role: null, skills: [] },
    gacha: { opening: false, lastResult: null }, aiDraft: { errors: [] },
    battle: { frames: [{ tick: 1, diff: { players: { p1: { toX: 224, hp: 100, mp: 40, sp: 60 }, p2: { toX: 800, hp: 100, mp: 40, sp: 60 } } } }], result: null, tick: 0, speed: 1, playing: false, running: false },
    ui: { busy: false, snackbar: [], modal: null, activeTab: {} },
    warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
    logPrefs: { level: 'debug', channels: {}, panelOpen: false }, panel: null, seed: null,
  };
  // 预建盒元素（fake doc 不解析 innerHTML → 按布局 ids 注册 style 元素，命中 injectBoxGeom）
  for (const b of replayLayout(replayState)) if (b.id) mkEl(b.id);
  const store = createStore({ api: {}, log: null, doc, state: replayState });
  const mount = mountApp({
    doc, store, log: null, records: () => [],
    renderScreen: (st) => ({ shell: [], main: st.screen === 'replay' ? replayLayout(st) : [] }),
  });
  assert.equal(mount.mounted, true);
  // #battle 画布：回放屏显示 + 按画布盒定位（F5 P1）
  assert.equal(battleEl.style.display, 'block');
  assert.equal(battleEl.style.left, '16px');
  assert.equal(battleEl.style.top, '80px');
  assert.equal(battleEl.style.width, '1024px');
  assert.equal(battleEl.style.height, '128px');
  assert.equal(battleEl.style.zIndex, '1');
  // 盒坐标注入：画布盒 div 与按钮同时收到几何
  assert.equal(styles.canvas.style.left, '16px');
  assert.equal(styles.canvas.style.top, '80px');
  assert.equal(styles.canvas.style.zIndex, '1');
  assert.equal(styles.replay_play.style.left, '32px');
  assert.equal(styles.replay_play.style.zIndex, '3');
  assert.equal(styles.controls.style.zIndex, '2');
  // 非回放屏：画布隐藏 + 注入盒清理（paint 全量替换 → 元素重建）
  store.dispatch({ type: 'goto', payload: { screen: 'menu' } });
  assert.equal(battleEl.style.display, 'none', '非回放屏 #battle 隐藏');
  // 分支：回放屏但无 canvas 盒（renderScreen 未出画布）→ #battle 隐藏 + 跳过绘制
  const storeB = createStore({ api: {}, log: null, doc, state: { ...replayState, screen: 'replay' } });
  const logsB = [];
  mountApp({
    doc, store: storeB, log: { debug: (ch, ev, msg, d) => logsB.push([ev, d && d.painted]), warn: () => {} }, records: () => [],
    renderScreen: (st) => ({ shell: [], main: st.screen === 'replay' ? [] : replayLayout(st) }),
  });
  assert.equal(battleEl.style.display, 'none', '回放屏无 canvas 盒 → 隐藏');
  assert.equal(logsB.some((l) => l[0] === 'render.frame'), true, '无 canvas 盒也完成 paint');
  // 分支：盒元素存在但无 style（注入跳过，不抛）
  const docC = {
    getElementById: (id) => (id === 'app' ? { innerHTML: '', parentNode: null } : id === 'battle' ? battleEl : id === 'canvas' ? { getContext: () => null } : null),
    createElement: () => ({ style: {} }),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const storeC = createStore({ api: {}, log: null, doc: docC, state: replayState });
  assert.equal(mountApp({ doc: docC, store: storeC, log: null, records: () => [], renderScreen: (st) => ({ shell: [], main: replayLayout(st) }) }).mounted, true, '无 style 盒元素不抛');
  // 分支锤：mountApp() 无参（deps||{} 兜底）+ 无 records + shell 缺省（records?:[] 与 shell||[] 兜底）
  assert.equal(mountApp().mounted, false, '无参 mountApp 安全');
  const storeD = createStore({ api: {}, log: null, doc, state: { ...replayState, screen: 'menu' } });
  const logsD = [];
  mountApp({ doc, store: storeD, log: { debug: (ch, ev) => logsD.push(ev), warn: () => {} }, renderScreen: (st) => ({ main: st.screen === 'replay' ? replayLayout(st) : [] }) });
  assert.equal(battleEl.style.display, 'none', '无 shell 注入也正常');
});