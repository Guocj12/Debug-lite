'use strict';
// P6 R5 replay 契约测试 —— planFrame 图元投影 + paintCanvas 执行器 + replay 屏布局/播放状态机
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let pf, paint, replay, rm, em, sm, inject;
before(async () => {
  pf = await import('../../public/js/render/planFrame.js');
  paint = await import('../../public/js/render/paint.js');
  replay = await import('../../public/js/views/replay.js');
  rm = await import('../../public/js/store/reducer.js');
  em = await import('../../public/js/store/effects.js');
  sm = await import('../../public/js/store/index.js');
  inject = await import('../../public/js/mount/canvas.js');
});

function boxAt(boxes, id) {
  return boxes.find((b) => b.id === id);
}

function st(patch) {
  let s = rm.reducer(undefined, { type: '@@init' });
  for (const [type, payload] of patch || []) s = rm.reducer(s, { type, ...payload });
  return s;
}

const DIFF = {
  players: { p1: { fromX: 224, toX: 288, facing: 1, hp: 90, mp: 30, sp: 40 }, p2: { fromX: 800, toX: 736, facing: -1, hp: 100, mp: 40, sp: 60 } },
  bases: { p1: { hp: 100, def: 64 }, p2: { hp: 80, def: 64 } },
  bullets: [{ owner: 'p1', x: 622, len: 64, level: 3 }],
  bulletHits: [{ target: 'p2', atX: 736 }],
  collision: null,
  aiTrace: [{ tick: 5, owner: 'p1', seq: 1, path: 'body.s[0]', nodeType: 'action', result: 'move_right' }],
  events: [],
};

test('R5 planFrame：图元投影（base/player/bullet/hit/verdict）1px 整数', () => {
  const prims = pf.planFrame(DIFF, { t: 1, winner: 'p1', maxHp: 100 });
  const baseL = prims.find((p) => p.kind === 'base' && p.owner === 'p1');
  const baseR = prims.find((p) => p.kind === 'base' && p.owner === 'p2');
  assert.deepEqual({ x: baseL.x, y: baseL.y, w: baseL.w, h: baseL.h }, { x: 0, y: 102, w: 32, h: 26 }, 'base_l=screens.md');
  assert.deepEqual({ x: baseR.x, y: baseR.y, w: baseR.w, h: baseR.h }, { x: 992, y: 102, w: 32, h: 26 }, 'base_r=screens.md');
  const p1 = prims.find((p) => p.kind === 'player' && p.owner === 'p1');
  assert.deepEqual({ x: p1.x, y: p1.y, w: p1.w, h: p1.h }, { x: 288, y: 64, w: 64, h: 64 }, 'player 投影 toX/64×64');
  assert.equal(p1.winner, true, '胜方标记');
  const p2 = prims.find((p) => p.kind === 'player' && p.owner === 'p2');
  assert.equal(p2.winner, false);
  const bullet = prims.find((p) => p.kind === 'bullet');
  assert.deepEqual({ x: bullet.x, y: bullet.y, w: bullet.w, h: bullet.h }, { x: 622, y: 92, w: 64, h: 8 });
  assert.equal(bullet.level, 3);
  const hit = prims.find((p) => p.kind === 'hit');
  assert.deepEqual({ x: hit.x, w: hit.w, h: hit.h }, { x: 736, w: 16, h: 16 });
  const verdict = prims.find((p) => p.kind === 'verdict');
  assert.ok(verdict && verdict.text.includes('p1'));
  for (const p of prims) assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y), '坐标整数');
});

test('R5 planFrame：插值 t=0.5/0 → fromX+Δt；缺字段安全（空 diff/null）', () => {
  const half = pf.planFrame(DIFF, { t: 0.5 });
  const p1 = half.find((p) => p.kind === 'player' && p.owner === 'p1');
  assert.equal(p1.x, 256, 'fromX+Δ×0.5');
  const zero = pf.planFrame(DIFF, { t: 0 });
  assert.equal(zero.find((p) => p.kind === 'player' && p.owner === 'p1').x, 224, 't=0 → fromX');
  assert.deepEqual(pf.planFrame(null, {}), [], 'null diff 安全');
  const minimal = pf.planFrame({}, {});
  assert.deepEqual(minimal, [], '空 diff 安全');
  const halfPlayers = pf.planFrame({ players: { p1: { toX: 300 } } }, {});
  assert.equal(halfPlayers.find((p) => p.kind === 'player').x, 300, '缺 bases/bullets 安全');
});

test('R5 clampTick：钳制与空 frames', () => {
  const frames = [{}, {}, {}];
  assert.equal(pf.clampTick(2, frames, 1), 2);
  assert.equal(pf.clampTick(0, frames, -1), 0);
  assert.equal(pf.clampTick(1, frames, 1), 2);
  assert.equal(pf.clampTick(5, [], 1), 0);
  assert.equal(pf.clampTick(undefined, frames), 0);
});

test('R5 paintCanvas：图元执行序列（tile/base/player/bullet/hit/collision/verdict）+ 日志', () => {
  const cmds = [];
  const fakeCtx = {
    fillStyle: null, font: null,
    fillRect(x, y, w, h) { cmds.push(['rect', x, y, w, h, this.fillStyle]); },
    strokeRect(x, y, w, h) { cmds.push(['stroke', x, y, w, h]); },
    clearRect(x, y, w, h) { cmds.push(['clear', x, y, w, h]); },
    fillText(t, x, y) { cmds.push(['text', t, x, y]); },
  };
  const recs = [];
  const log = { trace: (c, e, m, d) => recs.push([e]), debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  const prims = pf.planFrame(DIFF, { t: 1, winner: 'p1', maxHp: 100 });
  const seen = paint.paintCanvas(fakeCtx, prims, { log });
  assert.equal(cmds[0][0], 'clear', '先清屏');
  assert.equal(seen.filter((x) => x.startsWith('tile_')).length, 16, '16 地面格');
  assert.ok(seen.includes('base') && seen.includes('player_p1') || seen.includes('player'), 'base/player 绘制');
  assert.ok(seen.includes('bullet') && seen.includes('hit'));
  assert.ok(recs.some((r) => r[0] === 'render.box' && true), 'render.box 日志');
  assert.ok(recs.some((r) => r[0] === 'render.sprite'), 'render.sprite 日志');
  assert.ok(recs.some((r) => r[0] === 'render.text'), 'render.text 日志');
  // 无 ctx → 空表
  assert.deepEqual(paint.paintCanvas(null, prims), []);
});

test('R5 replay：screens.md 表逐行坐标一致 + verify 全绿（含结算 Modal）', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const s = st([['battle/loaded', { frames: [{ tick: 1, diff: DIFF }, { tick: 2, diff: DIFF }, { tick: 3, diff: { players: { p1: { fromX: 288, toX: 288, facing: 1, hp: 0, mp: 30, sp: 40 } }, bases: { p1: { hp: 100 }, p2: { hp: 100 } } } }], result: { winner: 'p1', phase: 'base', ticks: 3 } }], ['battle/seek', { tick: 2 }]]);
  const boxes = replay.replayLayout(s);
  const want = [
    ['canvas', 16, 80, 1024, 128, 1],
    ['hp1', 16, 84, 96, 8, 4],
    ['hp2', 912, 84, 96, 8, 4],
    ['controls', 16, 220, 1024, 56, 2],
    ['aiTrace', 1064, 80, 200, 400, 2],
    ['modal', 400, 280, 480, 160, 91],
  ];
  for (const [id, x, y, w, h, z] of want) {
    const b = boxAt(boxes, id);
    assert.ok(b, `${id} 应存在`);
    assert.deepEqual({ id, x: b.x, y: b.y, w: b.w, h: b.h, z: b.z }, { id, x, y, w, h, z }, `${id} 坐标`);
  }
  assert.ok(boxAt(boxes, 'mask'), '结算遮罩');
  assert.ok(boxAt(boxes, 'btn_again').action === 'goto' && boxAt(boxes, 'btn_again').payload.screen === 'battle');
  assert.ok(boxAt(boxes, 'btn_menu').payload.screen === 'menu');
  assert.ok(boxAt(boxes, 'tick_lit').text === 'T:2/2', '末帧 tick 标签');
  assert.deepEqual(verifyLayout(boxes), [], 'replay 布局（含 Modal）应无 issue');
});

test('R5 replay：非末帧无 Modal + 控制条状态 + aiTrace 行 + 死控件防护', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const s = st([['battle/loaded', { frames: [{ tick: 1, diff: DIFF }, { tick: 2, diff: DIFF }] }]]);
  let boxes = replay.replayLayout(s);
  assert.equal(boxAt(boxes, 'modal'), undefined, '非末帧无 Modal');
  assert.equal(boxAt(boxes, 'btn_play').action, 'replay/play');
  assert.equal(boxAt(boxes, 'btn_pause').action, null, '未播放 → 暂停禁用');
  assert.ok(boxAt(boxes, 'tick_lit').text === 'T:0/1');
  assert.ok(boxAt(boxes, 'trace1').text.includes('body.s[0]'), 'aiTrace 行渲染');
  assert.deepEqual(verifyLayout(boxes), [], '回放布局全绿');

  // 播放中：play 死按钮/pause 活
  const sPlay = st([['battle/loaded', { frames: [{ tick: 1, diff: DIFF }, { tick: 2, diff: DIFF }] }], ['replay/play']]);
  boxes = replay.replayLayout(sPlay);
  assert.equal(boxAt(boxes, 'btn_play').action, null);
  assert.equal(boxAt(boxes, 'btn_pause').action, 'replay/pause');
  // 空局：全部控制死
  const sEmpty = st([['goto', {}]]);
  boxes = replay.replayLayout(sEmpty);
  assert.equal(boxAt(boxes, 'btn_play').action, null);
  assert.equal(boxAt(boxes, 'btn_step').action, null);
  assert.ok(boxAt(boxes, 'trace_none').text.includes('无 AI 轨迹'), '无轨迹提示');
  // 步进 payload
  const sMid = st([['battle/loaded', { frames: [{ tick: 1, diff: DIFF }, { tick: 2, diff: DIFF }] }]]);
  boxes = replay.replayLayout(sMid);
  assert.deepEqual(boxAt(boxes, 'btn_step').payload, { tick: 1 });
});

test('R5 reducer：replay/speed 钳制 + battle/seek 边界', () => {
  const s = st([['replay/speed', { speed: 4 }], ['battle/seek', { tick: 2 }]]);
  assert.equal(s.battle.speed, 4);
  assert.equal(s.battle.tick, 0, '无 frames → seek 钳 0');
});

test('R5 effects：replay/play 定时链（注入 timers 推进→末帧 auto pause）', async () => {
  const pending = [];
  const timers = { setTimeout: (fn, ms) => { pending.push([fn, ms]); return 1; }, clearTimeout: () => {} };
  const persist = { save: () => {}, saveLogPrefs: () => {}, saveSeed: () => {} };
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {}, setChannelLevel: () => {} };
  const store = sm.createStore({
    reducer: rm.reducer, effects: em.effects(), persist, api: null, log, timers,
    initialPatch: { battle: { config: null, playing: false, frames: [{ tick: 1, diff: {} }, { tick: 2, diff: {} }, { tick: 3, diff: {} }], result: null, tick: 0, speed: 2 } },
  });
  store.dispatch({ type: 'replay/play' });
  await Promise.resolve(); // effect 微任务排程
  assert.equal(store.getState().battle.playing, true);
  // 每步 1000/speed=500ms；推进 2 步到末帧
  assert.equal(pending.length, 1);
  assert.equal(pending[0][1], 500, '1x speed=1 → 1000/speed');
  pending[0][0](); // tick 0→1
  assert.equal(store.getState().battle.tick, 1);
  assert.equal(pending.length, 2);
  pending[1][0](); // tick 1→2（末帧）
  assert.equal(store.getState().battle.tick, 2);
  assert.equal(store.getState().battle.playing, false, '末帧自动 pause');
  assert.equal(pending.length, 2, '末帧不再排程');
  // 中途 pause 停链
  const store2 = sm.createStore({
    reducer: rm.reducer, effects: em.effects(), persist, api: null, log, timers,
    initialPatch: { battle: { playing: false, frames: [{}, {}, {}], tick: 0, speed: 1 } },
  });
  store2.dispatch({ type: 'replay/play' });
  await Promise.resolve();
  pending[2][0](); // 0→1
  store2.dispatch({ type: 'replay/pause' });
  await Promise.resolve();
  const before = pending.length;
  pending[before - 1][0](); // 暂停后再触发旧 timer → 不推进
  assert.equal(store2.getState().battle.tick, 1, '暂停后旧定时器失效');
});

test('R5 injectCanvas：replay 显隐/坐标注入 + 绘制执行 + 非 replay 隐藏', () => {
  const shown = [];
  const cmds = [];
  const canvas = {
    style: {},
    getContext: () => ({
      fillStyle: null, font: null,
      fillRect(x, y, w, h) { cmds.push(['rect', x, y, w, h]); },
      strokeRect() {}, clearRect() { cmds.push(['clear']); }, fillText() {},
    }),
  };
  const doc = { getElementById: (id) => (id === 'battle' ? canvas : null) };
  const s = st([['battle/loaded', { frames: [{ tick: 1, diff: DIFF }] }]]);
  const r = inject.injectCanvas(doc, { ...s, screen: 'replay' }, {});
  assert.ok(r && r.primitives.length > 0, 'replay 屏 → 注入+绘制');
  assert.equal(canvas.style.display, 'block');
  assert.deepEqual({ left: canvas.style.left, top: canvas.style.top, w: canvas.style.width, h: canvas.style.height }, { left: '16px', top: '80px', w: '1024px', h: '128px' });
  assert.ok(cmds[0][0] === 'clear');
  // 非 replay → 隐藏
  const r2 = inject.injectCanvas(doc, { ...s, screen: 'menu' });
  assert.equal(r2, null);
  assert.equal(canvas.style.display, 'none');
  // 无 canvas / 无 getContext → 跳过
  assert.equal(inject.injectCanvas({ getElementById: () => null }, s), null);
  assert.equal(inject.injectCanvas(null, s), null);
  assert.equal(inject.injectCanvas({ getElementById: () => ({ getContext: null }) }, s), null);
});

test('R5 planFrame：分支锤 —— 缺 opts/t NaN/缺 fromX/缺 len/缺 level/collision/缺 delta', () => {
  let prims = pf.planFrame(DIFF); // 无 opts → t=1
  assert.ok(prims.length > 0);
  prims = pf.planFrame(DIFF, { t: 'x' }); // NaN → 视为 1
  assert.equal(prims.find((p) => p.kind === 'player' && p.owner === 'p1').x, 288);
  prims = pf.planFrame({ players: { p1: { toX: 300, facing: 1 } } }, {}); // 缺 fromX → 以 toX 为锚
  assert.equal(prims[0].x, 300);
  prims = pf.planFrame({ players: { p1: { fromX: 200, facing: -1 } } }, {}); // 缺 toX
  assert.equal(prims[0].x, 200);
  prims = pf.planFrame({ bullets: [{ owner: 'p1', x: 100 }] }, {}); // 缺 len/level
  assert.deepEqual({ x: prims[0].x, w: prims[0].w, level: prims[0].level }, { x: 100, w: 64, level: 1 });
  prims = pf.planFrame({ collision: { contactX: 960 } }, {}); // 碰撞图元
  assert.deepEqual({ x: prims.find((p) => p.kind === 'collision').x, w: 24, h: 24 }, { x: 960, w: 24, h: 24 });
  assert.equal(pf.clampTick(1, [{}, {}]), 1, '缺 delta → +0');
  assert.equal(pf.clampTick(1, [{}, {}], 0), 1);
  // collision null / bulletHits 缺省 / verdict 缺省
  assert.equal(pf.planFrame(DIFF, { t: 1 }).find((p) => p.kind === 'collision'), undefined);
  assert.equal(pf.planFrame({ players: { p1: { toX: 300 } } }, { winner: 'p2' }).find((p) => p.kind === 'verdict').text, 'winner=p2');
});

test('R5 replay：分支锤 —— 空局/无 phase/缺 result 字段/html 解析', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const sEmpty = st([['goto', {}]]);
  let boxes = replay.replayLayout(sEmpty);
  assert.deepEqual(verifyLayout(boxes), [], '空局布局全绿');
  assert.equal(boxAt(boxes, 'tick_lit').text, 'T:0/0');
  const s = st([['battle/loaded', { frames: [{ tick: 1, diff: DIFF }], result: { winner: 'p2', ticks: 9 } }], ['battle/seek', { tick: 0 }]]);
  boxes = replay.replayLayout(s);
  assert.ok(boxAt(boxes, 'result_lit').text.includes('对手胜') && boxAt(boxes, 'result_lit').text.includes('无判定'), 'phase 缺省臂');
  assert.equal(boxAt(boxes, 'tick_lit').text, 'T:0/0', '1 帧局 T:0/0');
  const h = replay.replayHtml(s);
  assert.ok(h.includes('data-box-id="tick_slider"'), 'replayHtml 输出');
  // battle null 的 state（防御）
  const sNoBattle = { ...st([['goto', {}]]), battle: null };
  assert.doesNotThrow(() => replay.replayLayout(sNoBattle));
  assert.deepEqual(verifyLayout(replay.replayLayout(sNoBattle)), [], 'battle null 防御布局全绿');
});

test('R5 injectCanvas：maxHp 派生（首帧 hp）+ 空帧安全', () => {
  assert.equal(inject.firstMaxHp([{ diff: { players: { p1: { hp: 120 } } } }]), 120);
  assert.equal(inject.firstMaxHp([]), 100);
  assert.equal(inject.firstMaxHp([{ diff: {} }]), 100);
  const canvas = { style: {}, getContext: () => null };
  const doc = { getElementById: () => canvas };
  const s = { screen: 'replay', battle: { frames: [], tick: 0 } };
  assert.equal(inject.injectCanvas(doc, s), null, '空帧 → null');
});
