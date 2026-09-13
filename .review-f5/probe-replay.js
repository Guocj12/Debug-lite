'use strict';
/* .review-f5/probe-replay.js —— F5 审查回放链探针（可复跑：node .review-f5/probe-replay.js）
 * 段1：真后端 listen(0) /battle 一局 → 真帧序列 → planFrame 全帧图元快照（1px 整数域/字段映射/无 NaN）
 * 段2：播放状态机在真实帧上模拟推进（假 timers，注入缝）→ tick 全链 → 末帧自动 pause + 结算文本
 * 段3：结算 Modal 时刻（tick0 无遮罩 / 末帧有遮罩）+ HUD 基地 hp / aiTrace 实装字段行文本
 * 段4：mount 盒坐标注入 + #battle 画布显隐/定位（style 感知假 doc）
 * 期望退出码 0；任一步失败 → [FAIL] + 退出 1。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
process.chdir(REPO);
const file = (p) => pathToFileURL(path.join(REPO, p)).href;

const INT = (v, what) => { assert.ok(Number.isInteger(v), `${what} 非整数: ${v}`); };

(async () => {
  const { start } = require(path.join(REPO, 'server', 'index.js'));
  const srv = await start({ port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const { createApi } = await import(file('public/js/api/client.js'));
  const { planFrame } = await import(file('public/js/render/planFrame.js'));
  const { replayLayout } = await import(file('public/js/views/replay.js'));
  const { verifyLayout } = await import(file('public/js/ui/verify.js'));
  const { paintCanvas } = await import(file('public/js/mount/canvas.js'));
  const { runEffect } = await import(file('public/js/store/effects.js'));
  const { mountApp } = await import(file('public/js/mount/index.js'));
  const { createStore } = await import(file('public/js/store/index.js'));
  const { initialState } = await import(file('public/js/store/reducer.js'));
  const { OPPONENTS } = await import(file('public/js/views/battle.js'));

  // 合法 loadout（与 .review-f4/probe-chain.js 同构；seed 固定 42 保证可复现）
  const COMMON = require(path.join(REPO, 'server', 'data', 'skill-templates.json')).skillTemplates
    .filter((t) => !t.unlockTier || t.unlockTier === 'common');
  const mkSkill = (i) => ({ uid: `p1s${i + 1}`, kind: 'skill', templateId: COMMON[i % COMMON.length].id, quality: 'common', slotCount: 0, slots: [], params: { multiplier: 1, cost: { hp: 0, mp: 10, sp: 0 }, cooldown: 3, bulletLevel: 3 }, unlockTier: 'common' });
  const MY_LD = {
    role: { uid: 'p1r', kind: 'role', templateId: 'role_bal', quality: 'common', slotCount: 0, slots: [], stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 }, pluginPoints: 3, unlockTier: 'common' },
    skills: [mkSkill(0), mkSkill(1), mkSkill(2)],
    ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } },
  };

  const fetchImpl = (url, opts) => fetch(base + url, opts);
  const api = createApi({ fetchImpl });
  const res = await api.post('/battle', { p1: MY_LD, p2: OPPONENTS[0].loadout, seed: 42, tier: 'common', warehouse: {} });
  assert.ok(res.ok, `起战失败: ${res.code || '?'} ${JSON.stringify(res.details || res.message)}`);
  const frames = res.data.frames;
  assert.ok(Array.isArray(frames) && frames.length > 1, `帧序列应有进度（got ${frames && frames.length}）`);

  // ---- 段1：planFrame 全帧图元快照（1px 投影、字段映射、无 NaN、确定性）----
  const snapshots = frames.map((f, i) => planFrame(f.diff, i));
  assert.equal(snapshots.length, frames.length);
  let withVerdict = 0, withHit = 0, withCollision = 0, withBullet = 0;
  const races = { player: 0, bullet: 0, hit: 0, collision: 0, verdict: 0 };
  snapshots.forEach((prims, i) => {
    const d = frames[i].diff;
    for (const p of prims) {
      INT(p.x, `f${i} ${p.kind}.x`);
      INT(p.y, `f${i} ${p.kind}.y`);
      if (p.kind === 'player') {
        assert.ok(Number.isFinite(p.hp) && Number.isFinite(p.mp) && Number.isFinite(p.sp), `f${i} player hp/mp/sp 有限`);
        INT(p.w, `f${i} player.w`);
      }
      races[p.kind] = (races[p.kind] || 0) + 1;
    }
    // 与帧字段一一对应：players→player×2（有数据时）；bulletHits→hit；collision→collision；verdict→verdict
    const expPlayers = d.players && d.players.p1 ? 2 : 0;
    assert.equal(prims.filter((p) => p.kind === 'player').length, expPlayers, `f${i} player 图元数`);
    assert.equal(prims.filter((p) => p.kind === 'hit').length, (d.bulletHits || []).length, `f${i} hit 图元数`);
    if (d.collision) assert.equal(prims.some((p) => p.kind === 'collision' && p.x === d.collision.contactX), true, `f${i} collision 投影`);
    if (d.verdict) { withVerdict++; assert.equal(prims.some((p) => p.kind === 'verdict' && p.text.includes(`winner=${d.verdict.winner}`)), true, `f${i} verdict 文本`); }
    withHit += (d.bulletHits || []).length;
    withBullet += (d.bullets || []).length;
  });
  // 确定性：同帧 planFrame 两次 deepEqual
  assert.deepEqual(planFrame(frames[1].diff, 1), planFrame(frames[1].diff, 1), 'planFrame 确定性');
  console.log(`[1] planFrame 全帧快照: ${frames.length} 帧 → player=${races.player} bullet=${races.bullet} hit=${races.hit} collision=${races.collision} verdict=${races.verdict}；子弹帧 ${withBullet} 命中 ${withHit} 结算帧 ${withVerdict}`);

  // ---- 段2：播放状态机在真实帧上模拟推进（假 timers）→ 末帧自动 pause ----
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
      if (a.type === 'battle/seek') state = { ...state, battle: { ...state.battle, tick: a.payload.tick } };
      if (a.type === 'battle/play') state = { ...state, battle: { ...state.battle, playing: true } };
      if (a.type === 'battle/pause') state = { ...state, battle: { ...state.battle, playing: false } };
    },
    timers: fakeTimers,
  };
  await runEffect(ctx, { type: 'replay/play' });
  assert.equal(intervals.length, 1, '启动 1 个定时器');
  assert.equal(intervals[0].ms, 1000, '×1 → 1000ms');
  let fireN = 0;
  while (state.battle.playing && fireN < frames.length + 2) {
    intervals[0].fn(); fireN++;
  }
  assert.equal(state.battle.tick, frames.length - 1, '推进到末帧');
  assert.equal(state.battle.playing, false, '末帧自动 pause');
  const seekCount = actions.filter((a) => a.type === 'battle/seek').length;
  assert.ok(seekCount >= frames.length - 1, `逐帧 seek 到末帧（seeks=${seekCount}，tick 0→${frames.length - 1} 需 ${frames.length - 1}）`);
  console.log(`[2] 播放状态机真实帧推进: ${frames.length} 帧 fires=${fireN} seeks=${seekCount} 末帧 tick=${state.battle.tick} auto-pause ✓`);
  // 防重入 + 暂停（contract 名 replay/pause）
  await runEffect(ctx, { type: 'replay/play' });
  assert.ok(intervals.length >= 2, '再播放新开定时器');
  state.battle.playing = true;
  ctx.playbackTimer = intervals.length; // 最新定时器 id（假 timers 以 length 为 id）
  const nCleared = intervals.filter((x) => x.cleared).length;
  await runEffect(ctx, { type: 'replay/pause' });
  assert.equal(state.battle.playing, false, 'replay/pause 复位 playing');
  assert.equal(intervals.filter((x) => x.cleared).length, nCleared + 1, 'replay/pause 清定时器');

  // ---- 段3：结算 Modal 时刻 + HUD 基地 hp + aiTrace 实装字段 ----
  const mkState = (tickNow) => ({
    screen: 'replay', tier: 'mythic', seed: 42, meta: { serverOk: true }, loadout: { role: null, skills: [] },
    gacha: { opening: false, lastResult: null }, aiDraft: { errors: [] },
    battle: { frames, result: { winner: res.data.winner, ticks: res.data.ticks }, tick: tickNow, speed: 1, playing: false, running: false },
    ui: { busy: false, snackbar: [], modal: null, activeTab: {} },
    warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
    logPrefs: { level: 'debug', channels: {}, panelOpen: false }, panel: null,
  });
  const b0 = replayLayout(mkState(0));
  assert.equal(b0.find((b) => b.id === 'replay_modal_mask'), undefined, '结算时刻：tick 0 无遮罩（控制条可用）');
  assert.equal(b0.find((b) => b.id === 'replay_play').action, 'replay/play', '控制条可操作');
  assert.equal(verifyLayout(b0).ok, true, `无结算布局：${verifyLayout(b0).issues.length} 项`);
  // 真实帧末帧：HUD 基地 hp 有真实值 + 结算遮罩 + 文本
  const last = frames[frames.length - 1];
  const bEnd = replayLayout(mkState(frames.length - 1));
  assert.ok(bEnd.find((b) => b.id === 'replay_modal_mask'), '末帧弹出结算遮罩');
  const hud = bEnd.find((b) => b.id === 'replay_hud_p1');
  const realBase = last.diff.bases && last.diff.bases.p1 && last.diff.bases.p1.hp;
  if (realBase !== undefined) assert.ok(hud.text.includes(`base ${realBase}`), `HUD 基地投影 ${realBase}（got: ${hud.text}）`);
  const hudP2 = bEnd.find((b) => b.id === 'replay_hud_p2');
  assert.ok(hudP2.text.includes('hp '), 'p2 HUD 存在');
  // 结算文本（§6.6）
  const modalText = bEnd.find((b) => b.id === 'replay_modal_text').text;
  assert.ok(modalText.startsWith(`winner=${res.data.winner}`), `结算文本 ${modalText}`);
  assert.ok(modalText.includes(`${res.data.ticks} tick`), `结算 tick 数 ${modalText}`);
  assert.equal(verifyLayout(bEnd).ok, true, `结算布局：${verifyLayout(bEnd).issues.map((i) => i.issue).join(',')}`);
  // aiTrace 实装字段（首帧若有轨迹 → 行文本非空且含 path/nodeType/result）
  const f1 = frames[0];
  const b1 = replayLayout(mkState(0));
  const rows = b1.filter((b) => b.id.startsWith('replay_ai_'));
  if ((f1.diff.aiTrace || []).length > 0) {
    assert.ok(rows.length > 0, 'aiTrace 行存在');
    const real = f1.diff.aiTrace[0];
    assert.ok(typeof real.nodeType === 'string' && typeof real.path === 'string', `aiTrace 实装字段（got ${JSON.stringify(real).slice(0, 80)}）`);
    assert.ok(rows.some((r) => r.text.startsWith(`${real.owner} `) && r.text.length > (real.owner || '').length + 1), `aiTrace 行文本非空（${rows.map((r) => r.text).join(' | ')}）`);
  }
  console.log(`[3] 末尾帧 tick=${frames.length - 1} 结算「${modalText}」+ HUD 基地 hp=${realBase} + aiTrace 行 ${rows.length}（实装字段）✓`);

  // ---- 段4：mount 盒坐标注入 + #battle 画布显隐/定位（style 感知假 doc）----
  const styles = {};
  const mkEl = () => ({ style: {}, getContext: () => null });
  const appEl = { innerHTML: '', parentNode: null, style: {} };
  const battleEl = mkEl();
  const doc = {
    getElementById: (id) => (id === 'app' ? appEl : id === 'battle' ? battleEl : styles[id] ? styles[id] : null),
    createElement: () => mkEl(),
    addEventListener: () => {}, removeEventListener: () => {},
  };
  const store = createStore({ api, log: null, doc, state: mkState(0) });
  const mount = mountApp({
    doc, store, log: null, records: () => [],
    renderScreen: (st) => ({ shell: [], main: replayLayout(st) }),
  });
  assert.equal(mount.mounted, true);
  const canvasBox = replayLayout(store.getState()).find((b) => b.kind === 'canvas');
  assert.equal(battleEl.style.display, 'block', '#battle 回放屏显示');
  assert.equal(battleEl.style.left, '16px', '#battle left 注入');
  assert.equal(battleEl.style.top, '80px', '#battle top 注入');
  assert.equal(battleEl.style.width, '1024px', '#battle width 注入');
  assert.equal(battleEl.style.zIndex, String(canvasBox.z), '#battle z 注入');
  // 其余屏隐藏
  store.dispatch({ type: 'goto', payload: { screen: 'menu' } });
  assert.equal(battleEl.style.display, 'none', '非回放屏 #battle 隐藏');
  console.log(`[4] mount 注入: #battle 定位 ${battleEl.style.left},${battleEl.style.top} ${battleEl.style.width}×${battleEl.style.height} z=${battleEl.style.zIndex}；非回放屏 display=none ✓`);

  // ---- 段5：技能局（真子弹/命中/碰撞帧）→ planFrame 投影 + paintCanvas stub ctx 全量绘制 ----
  const SKILL_LD = {
    ...MY_LD,
    ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'skill:skill1' }] } },
  };
  const HOLD_LD = {
    ...OPPONENTS[0].loadout,
    ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } },
  };
  const res2 = await api.post('/battle', { p1: SKILL_LD, p2: HOLD_LD, seed: 7, tier: 'common', warehouse: {} });
  assert.ok(res2.ok, `技能局起战失败: ${res2.code || '?'}`);
  const f2 = res2.data.frames;
  let bullets0 = 0, hits0 = 0, coll0 = 0, getCtx = 0;
  const calls = [];
  const stubCtx = {
    clearRect: (...a) => calls.push(['clearRect', ...a]),
    fillRect: (...a) => calls.push(['fillRect', ...a]),
    strokeStyle: null, fillStyle: null,
    beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {},
    fillText: (...a) => calls.push(['fillText', ...a]),
  };
  f2.forEach((f, i) => {
    const prims = planFrame(f.diff, i);
    for (const b of f.diff.bullets || []) {
      INT(b.x, `子弹局 f${i} bullet.x`);
      assert.ok(typeof b.len === 'number' && typeof b.dir === 'number', `f${i} bullet len/dir`);
    }
    bullets0 += (f.diff.bullets || []).length;
    hits0 += (f.diff.bulletHits || []).length;
    if (f.diff.collision) coll0++;
    for (const h of f.diff.bulletHits || []) {
      assert.ok(prims.some((p) => p.kind === 'hit' && p.x === h.atX && p.target === h.target), `f${i} hit 图元投影 atX=${h.atX}`);
    }
    const r = paintCanvas(null, prims, { ctx: stubCtx });
    assert.equal(r.painted, true, `f${i} paint 成功`);
    assert.equal(r.count, prims.length, `f${i} 图元数一致`);
  });
  const playerRects = calls.filter((c) => c[0] === 'fillRect').length;
  assert.ok(bullets0 > 0, `技能局应产生子弹帧（got ${bullets0}）`);
  console.log(`[5] 技能局 ${f2.length} 帧：bullets=${bullets0} bulletHits=${hits0} collision帧=${coll0}；paintCanvas 全帧 ${playerRects} 个 fillRect 无一异常 ✓`);

  // 第二局：直线技能（skill2=straight_precise）+ p2 相向推进 → 真实命中帧
  const STRAIGHT_LD = {
    ...MY_LD,
    ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'skill:skill2' }] } },
  };
  const HOLD2_LD = {
    ...OPPONENTS[0].loadout,
    ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } },
  };
  const res3 = await api.post('/battle', { p1: STRAIGHT_LD, p2: HOLD2_LD, seed: 9, tier: 'common', warehouse: {} });
  assert.ok(res3.ok, `直线局起战失败: ${res3.code || '?'}`);
  const f3 = res3.data.frames;
  let hits1 = 0;
  for (const f of f3) {
    for (const h of f.diff.bulletHits || []) {
      hits1++;
      const prims = planFrame(f.diff, 0);
      assert.ok(prims.some((p) => p.kind === 'hit' && p.x === h.atX && p.target === h.target), `hit 图元投影 atX=${h.atX} target=${h.target}`);
    }
  }
  assert.ok(hits1 > 0, `直线局应有命中帧（got ${hits1}）`);
  console.log(`[6] 直线局 ${f3.length} 帧：bulletHits=${hits1}（命中图元投影经真帧校验，winner=${res3.data.winner} phase=${res3.data.phase}）✓`);

  console.log('PROBE-REPLAY PASS');
  await srv.close();
})().catch((e) => { console.error('[FAIL]', e.message); console.error(e.stack); process.exit(1); });