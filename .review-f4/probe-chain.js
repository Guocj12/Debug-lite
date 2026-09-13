'use strict';
/* .review-f4/probe-chain.js —— F4 审查 battle/run 全链探针（可复跑：node .review-f4/probe-chain.js）
 * 真 HTTP 服务端起 listen(0) + 真 fetch → createApi（信封/seed 回带）→ createStore → dispatch battle/run
 * → battle/loaded → goto replay；真 frames 灌入 replay 前端状态（§6.6 帧契约：frames[i].diff 自足）。
 * 期望退出码 0；任一步失败 → 打印 [FAIL] 并退出 1。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
process.chdir(REPO);
const file = (p) => pathToFileURL(path.join(REPO, p)).href;

(async () => {
  const { start } = require(path.join(REPO, 'server', 'index.js'));
  const srv = await start({ port: 0 });
  const base = `http://127.0.0.1:${srv.port}`;
  const { createStore } = await import(file('public/js/store/index.js'));
  const { createApi } = await import(file('public/js/api/client.js'));
  const { initialState } = await import(file('public/js/store/reducer.js'));
  const { OPPONENTS } = await import(file('public/js/views/battle.js'));

  // 我方合法 loadout（无插件引用；与 B24 bot 同构）
  const COMMON = require(path.join(REPO, 'server', 'data', 'skill-templates.json')).skillTemplates
    .filter((t) => !t.unlockTier || t.unlockTier === 'common');
  const mkSkill = (i) => ({ uid: `p1s${i + 1}`, kind: 'skill', templateId: COMMON[i % COMMON.length].id, quality: 'common', slotCount: 0, slots: [], params: { multiplier: 1, cost: { hp: 0, mp: 10, sp: 0 }, cooldown: 3, bulletLevel: 3 }, unlockTier: 'common' });
  const MY_LD = {
    role: { uid: 'p1r', kind: 'role', templateId: 'role_bal', quality: 'common', slotCount: 0, slots: [], stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 }, pluginPoints: 3, unlockTier: 'common' },
    skills: [mkSkill(0), mkSkill(1), mkSkill(2)],
    ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } },
  };

  const fetchImpl = (url, opts) => fetch(base + url, opts); // 相对路径 → 真服务
  const api = createApi({ fetchImpl });
  const initial = initialState();
  initial.tier = 'common';
  initial.seed = null; // 起战 seed 未设 → 后端生成回带
  initial.loadout = MY_LD;
  const store = createStore({ api, state: initial });
  api.setSeedHandler((seed) => store.dispatch({ type: 'seed/set', payload: { seed } })); // 镜像 app.js 接线
  const seen = [];
  store.subscribe((s) => seen.push(s));

  // 三对手各跑一场（模板为 p2；kiter ai=move_right / charger=move_left / cautious=wait）
  for (const o of OPPONENTS) {
    const before = seen.length;
    store.dispatch({ type: 'battle/run', payload: { opponent: o.loadout } });
    await new Promise((r) => setTimeout(r, 120));
    const st = store.getState();
    assert.equal(st.screen, 'replay', `${o.id} 起战后进入 replay`);
    assert.ok(Array.isArray(st.battle.frames) && st.battle.frames.length > 0, `${o.id} frames 非空（${st.battle.frames.length}）`);
    assert.ok(st.battle.result && typeof st.battle.result.winner === 'string', `${o.id} result.winner 存在`);
    assert.equal(st.battle.playing, false, 'battle/loaded 复位 playing');
    assert.equal(st.battle.tick, 0);
    assert.ok(Number.isInteger(st.seed) && st.seed >= 1 && st.seed <= 0x7fffffff, `${o.id} seed 后端生成回带（${st.seed}）`);
    // 帧契约 §4.3/§4.1 + B22 实装形状（replay-audit 同口径）：players/bases 为 {p1,p2} 对象，
    // bullets/events/aiTrace 数组；tick 1-based 连续（f.tick === i+1）
    const f0 = st.battle.frames[0];
    assert.equal(typeof f0.tick, 'number');
    assert.ok(f0.diff && typeof f0.diff.players === 'object' && f0.diff.players.p1 && f0.diff.players.p2, `${o.id} 帧 diff.players{p1,p2}`);
    assert.ok(Array.isArray(f0.diff.bullets) && Array.isArray(f0.diff.events) && Array.isArray(f0.diff.aiTrace), `${o.id} 帧 bullets/events/aiTrace 数组`);
    assert.ok(f0.diff.bases && typeof f0.diff.bases === 'object' && f0.diff.bases.p1 && f0.diff.bases.p2, `${o.id} 帧 diff.bases{p1,p2}`);
    st.battle.frames.forEach((f, i) => assert.equal(f.tick, i + 1, `${o.id} tick 连续（1-based，期望 ${i + 1}）`));
    console.log(`[run] ${o.id} -> ${st.battle.frames.length} ticks winner=${st.battle.result.winner} ticks=${st.battle.result.ticks} seed回带=${st.seed}`);
    void before;
  }

  // 确定性复现：同 seed 同配置 → 帧数/winner 一致（两场全等）
  const { runEffect } = await import(file('public/js/store/effects.js'));
  const results2 = [];
  const mkCtx = (d) => ({ api, store: () => ({ loadout: MY_LD, seed: 42, tier: 'common', warehouse: undefined }), dispatch: (a) => d(a), log: null, save: null, doc: null });
  for (let k = 0; k < 2; k++) {
    const d = (a) => { if (a.type === 'battle/loaded') results2.push(a.payload); };
    await runEffect(mkCtx(d), { type: 'battle/run', payload: { opponent: OPPONENTS[0].loadout } });
  }
  assert.equal(results2.length, 2);
  assert.equal(results2[0].frames.length, results2[1].frames.length, '同 seed 帧数一致');
  assert.deepEqual(results2[0].result, results2[1].result, '同 seed winner/ticks 一致');
  assert.deepEqual(results2[0].frames, results2[1].frames, '同 seed 帧数据全等（确定性复现）');
  console.log(`[repro] seed=42 ×2 帧全等（${results2[0].frames.length} ticks, winner=${results2[0].result.winner}）✓`);

  // 空 loadout（未装配）→ 409 loadout_invalid toast 链路（被动 409；§6.5 前置校验缺口见 F4.md P2-2）
  const storeBad = createStore({ api: createApi({ fetchImpl }), state: { ...initialState(), tier: 'common', seed: 1, loadout: { role: null, skills: [null, null, null], ai: null } } });
  let lastScreen = null;
  storeBad.subscribe((s) => { lastScreen = s.screen; });
  storeBad.dispatch({ type: 'battle/run', payload: { opponent: OPPONENTS[0].loadout } });
  await new Promise((r) => setTimeout(r, 120));
  const badSt = storeBad.getState();
  const toast = badSt.ui.snackbar[badSt.ui.snackbar.length - 1];
  assert.ok(toast && /battle\/run: loadout_invalid/.test(toast.text), `空 loadout 起战 → 409 toast（got "${toast && toast.text}"）`);
  assert.equal(badSt.screen, lastScreen, '起战失败不跳转（无 goto）');
  console.log(`[err] 空 loadout -> toast「${toast.text}」不跳转 ✓`);

  console.log('PROBE-CHAIN PASS');
  await srv.close();
})().catch((e) => { console.error('[FAIL]', e.message); console.error(e.stack); process.exit(1); });