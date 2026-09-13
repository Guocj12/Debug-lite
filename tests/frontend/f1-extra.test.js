'use strict';
// F1 覆盖补全 —— 门禁项 7 每文件阈值（行90/分支85/函数90）驱动：reducer/effects/index/persist/app/layout/verify 残余分支
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('reducer 残余分支：box/done 缺桶守卫/loadout 默认/log 默认/save 部分 import', async () => {
  const { reducer, initialState } = await import('../../public/js/store/reducer.js');
  const s0 = initialState();
  // box/done：items 无桶 key（守卫分支）
  const s1 = reducer(s0, { type: 'box/done', payload: { ok: true, data: { items: {}, seed: 5 } } });
  assert.equal(s1.warehouse.buckets.role.length, 0, '缺桶守卫 → 不崩溃');
  assert.equal(s1.seed, 5);
  // box/done：data 无 seed → 保留原 seed（falsy 兜底臂）
  const s1b = reducer({ ...s0, seed: 99 }, { type: 'box/done', payload: { ok: true, data: { items: [] } } });
  assert.equal(s1b.seed, 99, '无 seed 响应保留原 seed');
  // meta/loaded 失败臂 + goto 无载荷臂
  assert.equal(reducer(s0, { type: 'meta/loaded', payload: { ok: false } }).meta.serverOk, false, '!!false 臂');
  assert.equal(reducer(s0, { type: 'goto' }), s0, 'goto 无载荷 → 不变');
  // ui/toast/dismiss 无载荷臂（不删任何 toast）
  const withToast = reducer(s0, { type: 'ui/toast', payload: { text: 'x' } });
  assert.equal(reducer(withToast, { type: 'ui/toast/dismiss' }).ui.snackbar.length, 1, '无载荷 dismiss 不变');
  // loadout/set：部分载荷（只给 skills/只给 ai）
  const s2 = reducer(s0, { type: 'loadout/set', payload: { loadout: { skills: [{ uid: 'a' }, { uid: 'b' }, { uid: 'c' }] } } });
  assert.equal(s2.loadout.role, null, 'role 保持默认');
  assert.equal(s2.loadout.skills.length, 3);
  const s3 = reducer(s0, { type: 'loadout/set', payload: { loadout: { ai: { p: 1 } } } });
  assert.equal(s3.loadout.ai.p, 1);
  // log/set：部分载荷
  const s4 = reducer(s0, { type: 'log/set', payload: { level: 'trace' } });
  assert.equal(s4.logPrefs.level, 'trace');
  assert.equal(s4.logPrefs.channels.render, 'trace', 'channels 合并保持');
  const s5 = reducer(s0, { type: 'log/set', payload: { panelOpen: true } });
  assert.equal(s5.logPrefs.panelOpen, true);
  // save/import：空载荷 → 保持
  const s6 = reducer(s0, { type: 'save/import', payload: {} });
  assert.deepEqual(s6.warehouse, s0.warehouse);
  // battle/loaded 空帧默认
  const s7 = reducer(s0, { type: 'battle/loaded', payload: {} });
  assert.deepEqual(s7.battle.frames, []);
  assert.equal(s7.battle.result, null);
  // 未知 action → 原对象
  assert.equal(reducer(s0, { type: 'nope' }), s0);
});

test('effects 全分支：tier/set、wh/disassemble ok、loadout/validate、ai/compile 两态、ai/run 两态、panel/show 两态', async () => {
  const { runEffect } = await import('../../public/js/store/effects.js');
  const actions = [];
  const log = [];
  let mode = 'ok';
  const api = {
    get: async (p) => {
      if (p.startsWith('/unlock')) return mode === 'ok' ? { ok: true, data: { nodes: [1] } } : { ok: false, code: 'bad_tier' };
      return { ok: false, code: 'x' };
    },
    post: async (p, body) => {
      log.push([p, body]);
      if (mode === 'err') return { ok: false, code: 'err', message: 'm', details: [{ code: 'd' }] };
      if (p === '/warehouse/disassemble') return { ok: true, data: { warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } } };
      if (p === '/loadout') return { ok: false, code: 'loadout_invalid', details: [{ code: 'missing_warehouse' }] };
      if (p === '/ai/compile') return { ok: true, data: { hash: 'h' } };
      if (p === '/ai/battle') return { ok: true, data: { frames: [{ t: 1 }], winner: 'A', ticks: 5 } };
      if (p === '/panel') return { ok: true, data: { panel: { role: {} } } };
      return { ok: false, code: 'nope' };
    },
  };
  const st = () => ({ tier: 'common', seed: 1, warehouse: { buckets: { role: [{ uid: 'r' }], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: null, skills: [null, null, null], ai: null }, aiDraft: { program: null } });
  const ctx = { api, store: st, dispatch: (a) => actions.push(a), log: null, save: null };
  await runEffect(ctx, { type: 'tier/set', payload: { tier: 'rare' } });
  assert.ok(actions.some((a) => a.type === 'tier/loaded'));
  await runEffect(ctx, { type: 'wh/disassemble', payload: { targetUid: 'r', slotIndex: 0 } });
  assert.ok(actions.some((a) => a.type === 'wh/replaced' && a.payload.warehouse.buckets && a.payload.warehouse.buckets.role && a.payload.warehouse.buckets.role.length === 0));
  await runEffect(ctx, { type: 'loadout/validate' });
  assert.deepEqual(actions.filter((a) => a.type === 'loadout/errors')[0].payload.errors, [{ code: 'missing_warehouse' }], 'details 展开');
  await runEffect(ctx, { type: 'ai/compile' });
  assert.equal(actions.filter((a) => a.type === 'ai/compiled')[0].payload.hash, 'h');
  await runEffect(ctx, { type: 'ai/run', payload: { opponent: 'bot' } });
  assert.ok(actions.some((a) => a.type === 'battle/loaded'));
  assert.ok(actions.some((a) => a.type === 'goto' && a.payload.screen === 'replay'));
  await runEffect(ctx, { type: 'panel/show' });
  assert.ok(actions.some((a) => a.type === 'panel/loaded'));
  // err 模式：toastCtx 全通道（断言自本轮起的新增 action）
  const before = actions.length;
  mode = 'err';
  await runEffect(ctx, { type: 'tier/set', payload: { tier: 'rare' } });
  await runEffect(ctx, { type: 'panel/show' });
  await runEffect(ctx, { type: 'ai/run', payload: { opponent: 'bot' } });
  const after = actions.slice(before);
  assert.ok(after.filter((a) => a.type === 'ui/toast').length >= 3, '失败全 toast');
  assert.ok(!after.some((a) => a.type === 'battle/loaded'), 'err 模式无 battle/loaded');
  // 覆盖缺口：loadout/validate ok 臂、wh/disassemble err 臂、ai/compile err 臂（gate 项 7 口径）
  mode = 'ok';
  api.post = async (p, body) => {
    log.push([p, body]);
    if (p === '/loadout') return { ok: true, data: {} };
    if (p === '/ai/compile') return { ok: false, code: 'ai_invalid', details: [{ path: 'body.s[1]' }] };
    if (p === '/warehouse/disassemble') return { ok: false, code: 'item_missing' };
    if (p === '/warehouse/assemble') return { ok: true, data: { warehouse: { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } } } };
    if (p === '/box') return { ok: false, code: 'bad_seed' };
    return { ok: false, code: 'x' };
  };
  await runEffect(ctx, { type: 'loadout/validate' });
  assert.deepEqual(actions.filter((a) => a.type === 'loadout/errors').slice(-1)[0].payload.errors, [], 'loadout ok → 清空 errors');
  await runEffect(ctx, { type: 'wh/disassemble', payload: { targetUid: 'r', slotIndex: 0 } });
  assert.ok(actions.some((a) => a.type === 'wh/replaced' && a.payload.warehouse.buckets && a.payload.warehouse.buckets.role.length === 0));
  assert.ok(actions.slice(before).some((a) => a.type === 'ui/toast' && a.payload.text.includes('item_missing')), 'disassemble err toast');
  const before2 = actions.length;
  await runEffect(ctx, { type: 'ai/compile' });
  const comp = actions.slice(before2).filter((a) => a.type === 'ai/compiled')[0];
  assert.equal(comp.payload.hash, null);
  assert.deepEqual(comp.payload.errors, [{ path: 'body.s[1]' }], 'ai/compile err 展开 details');
  await runEffect(ctx, { type: 'wh/assemble', payload: { targetUid: 'r1', pluginUid: 'p', slotIndex: 0 } });
  assert.ok(actions.some((a) => a.type === 'wh/replaced' && a.payload.warehouse.buckets && a.payload.warehouse.buckets.role && a.payload.warehouse.buckets.role[0] && a.payload.warehouse.buckets.role[0].uid === 'r1'), 'assemble ok → 整体替换');
  assert.ok(actions.some((a) => a.type === 'store/save'), 'assemble ok → 落盘');
  await runEffect(ctx, { type: 'box/open', payload: { times: 1 } });
  assert.ok(actions.filter((a) => a.type === 'box/done')[0].payload.ok === false, 'box err → box/done 失败载荷');
  assert.ok(actions.slice(before2).some((a) => a.type === 'ui/toast'), 'box err → toast');
});

test('store/index 残余：state 选项/loadPersist 部分数据合并/日志钩子/无 effect resolve', async () => {
  const { createStore } = await import('../../public/js/store/index.js');
  const { initialState } = await import('../../public/js/store/reducer.js');
  const pre = [];
  const noChange = createStore({ api: {}, log: null });
  noChange.dispatch({ type: 'goto', payload: { screen: 'gacha' } });
  assert.equal(noChange.getState().screen, 'gacha');
  // state 选项直接注入
  const s1 = createStore({ api: {}, log: null, state: { ...initialState(), tier: 'epic' } });
  assert.equal(s1.getState().tier, 'epic');
  // loadPersist 部分数据（缺 warehouse/loadout 字段 → 默认兜底）
  const s2 = createStore({ api: {}, log: null, loadPersist: () => ({ schemaVersion: 1, tier: 'legendary', seed: 5 }) });
  assert.equal(s2.getState().tier, 'legendary');
  assert.deepEqual(s2.getState().warehouse, { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, '缺字段默认兜底');
  assert.equal(s2.getState().loadout.ai, null);
  // 日志钩子（dispatch 记录）
  const logs = [];
  const s3 = createStore({ api: {}, log: { debug: (ch, ev) => logs.push(ev) } });
  s3.dispatch({ type: 'goto', payload: { screen: 'battle' } }); // 无 effect 的 action（避免 api:{} 触发未处理拒绝污染并行测试）
  assert.equal(logs[0], 'store.dispatch');
  // store 集成链：box/open 走 effect → box/done + store/save（ctx.dispatch/ctx.save 闭包）
  const chain = [];
  const s4 = createStore({
    api: {
      post: async (p) => (p === '/box' ? { ok: true, data: { seed: 1, items: {} } } : { ok: false }),
      get: async () => ({ ok: false, code: 'x' }),
    },
    log: null,
    save: (state) => chain.push(['save', state.seed]),
  });
  s4.dispatch({ type: 'box/open', payload: { times: 1 } });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(s4.getState().gacha.opening, false, 'effect 闭环');
  assert.deepEqual(chain, [['save', 1]], 'store/save 委托 ctx.save');
  // 无 effect 的 action → resolve 不抛
  const preStore = createStore({ api: {}, log: null, preDispatch: (a) => pre.push(a.type) });
  preStore.dispatch({ type: 'goto', payload: { screen: 'editor' } });
  assert.equal(preStore.getState().screen, 'editor');
  assert.deepEqual(pre, ['goto']);
  const s = createStore({ api: {}, log: null });
  const off = s.subscribe(() => {});
  off();
  off(); // 幂等
  s.dispatch({ type: 'goto', payload: { screen: 'settings' } });
  assert.equal(s.getState().screen, 'settings');
});

test('persist 残余：win 无 localStorage 分支', async () => {
  const mod = await import('../../public/js/store/persist.js');
  const { initialState } = await import('../../public/js/store/reducer.js');
  assert.equal(mod.save({}, initialState()), false, 'win 无 localStorage → false');
  assert.equal(mod.load({}), null);
  mod.remove(null);
});

test('persist 残余：seed/logPrefs 键、seed null 跳过、remove', async () => {
  const mod = await import('../../public/js/store/persist.js');
  const mem = {};
  const win = { localStorage: { setItem: (k, v) => { mem[k] = v; }, getItem: (k) => (k in mem ? mem[k] : null), removeItem: (k) => { delete mem[k]; } } };
  const { initialState, reducer } = await import('../../public/js/store/reducer.js');
  let st = initialState();
  st = reducer(st, { type: 'seed/set', payload: { seed: 123 } });
  st = reducer(st, { type: 'log/set', payload: { channels: { render: 'trace' } } });
  mod.save(win, st);
  assert.ok(mod.SEED_KEY in mem, 'dl.v3.seed 落盘');
  assert.ok(mod.LOGPREFS_KEY in mem, 'dl.v3.logPrefs 落盘');
  assert.equal(mod.load(win).seed, 123);
  // seed null：不写 seed 键
  const s2 = initialState();
  const mem2 = {};
  const win2 = { localStorage: { setItem: (k, v) => { mem2[k] = v; }, getItem: (k) => (k in mem2 ? mem2[k] : null), removeItem: (k) => { delete mem2[k]; } } };
  mod.save(win2, s2);
  assert.ok(!(mod.SEED_KEY in mem2), 'seed null 不落盘');
  // gachaLastResult 形状（box/done 的 r.data 原样）
  mod.save(win2, reducer(s2, { type: 'box/done', payload: { ok: true, data: { items: {} } } }));
  assert.deepEqual(mod.load(win2).gachaLastResult, { items: {} });
  // remove
  mod.remove(win2);
  assert.ok(!(mod.STATE_KEY in mem2));
  mod.remove(null);
  // 坏 JSON → load null
  const mem3 = { [mod.STATE_KEY]: 'not-json{{' };
  const win3 = { localStorage: { setItem: () => {}, getItem: (k) => (k in mem3 ? mem3[k] : null), removeItem: () => {} } };
  assert.equal(mod.load(win3), null, '坏 JSON → null');
  // persistFields 双参（rawLogPrefs 显式）+ remove 无 localStorage + seed undefined
  const fields = mod.persistFields(initialState(), { level: 'info' });
  assert.equal(fields.logPrefs.level, 'info');
  mod.remove({});
  mod.save(undefined, initialState());
});

test('app.js 残余：版本不符清空/存档合并/seed 回带链路', async () => {
  const mod = await import('../../public/js/app.js');
  const msgs = [];
  const stubLog = { info: (c, e, m) => msgs.push([e, m]), warn: (c, e, m) => msgs.push([e, m]), debug: () => {}, error: () => {}, setLevel: () => {}, setChannelLevel: () => {} };
  // 版本不符 → warn + 不合并
  const badPersist = () => ({ schemaVersion: 999, tier: 'epic' });
  const b1 = await mod.boot({
    fetchImpl: () => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: {} }) }),
    loadPersist: badPersist,
    log: stubLog,
  });
  await b1.health;
  assert.ok(msgs.some(([ev, m]) => ev === 'store.boot' && m.includes('版本不符')), '版本不符 warn');
  assert.equal(b1.store.getState().tier, 'common', '版本不符不合并');
  // 正常存档合并（schemaVersion=1；旧扁平仓库形状 → normWh 归一化，P1-1）
  const okPersist = () => ({ schemaVersion: 1, tier: 'legendary', warehouse: { role: [{ uid: 'r1' }] }, loadout: { role: null, skills: [null, null, null], ai: null }, seed: 42, gachaLastResult: null, logPrefs: { level: 'debug', channels: {} } });
  const b2 = await mod.boot({ fetchImpl: () => Promise.reject(new Error('x')), loadPersist: okPersist, log: stubLog });
  await b2.health;
  assert.equal(b2.store.getState().tier, 'legendary', '存档合并（loadPersist 注入）');
  assert.equal(b2.store.getState().seed, 42);
  assert.equal(b2.store.getState().warehouse.buckets.role[0].uid, 'r1', '旧扁平仓库归一化为 buckets');
  // seed 回带链路：真实 api + fetch 注入 → 响应 seed 落状态（客户端走 res.text()+JSON.parse，桩须提供 text）
  const fetchImpl = (url) => (url.includes('/unlock')
    ? Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ ok: true, data: { seed: 777, nodes: [] } })) })
    : Promise.resolve({ text: () => Promise.resolve(JSON.stringify({ ok: true, data: {} })) }));
  const b3 = await mod.boot({ fetchImpl, log: stubLog, loadPersist: () => null });
  await b3.health;
  await b3.api.get('/unlock?tier=common');
  assert.equal(b3.store.getState().seed, 777, 'seed 回带 → 状态');
});

test('layout/verify 残余分支：stack gap 默认/button 缺省 opts/遮罩低于内容/隐藏被引用', async () => {
  const { stack, button, panel } = await import('../../public/js/ui/layout.js');
  const out = stack(0, [{ id: 'a', h: 40 }]); // 无 opts → gap 默认 8
  assert.equal(out[0].y, 0);
  const b = button('b1', 1, 2, 'x'); // 无 opts → 主按钮
  assert.deepEqual([b.w, b.h], [160, 40]);
  const b2 = button('b2', 0, 0, 'y', { parent: 'p' });
  assert.equal(b2.parent, 'p');
  const p = panel(0, 0, 10, 10); // 无 title/id
  assert.equal(p.id, 'panel');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const r = verifyLayout([
    { id: 'm', x: 0, y: 0, w: 1280, h: 720, z: 90, visible: true, kind: 'modal-mask' },
    { id: 'content', x: 0, y: 0, w: 100, h: 100, z: 95, visible: true },
  ]);
  assert.ok(r.issues.some((i) => i.issue === 'zconflict' && i.boxId === 'm'), '遮罩低于其下内容 → zconflict');
  // 隐藏但被子盒引用 → zero（.some 回调分支）
  const r2 = verifyLayout([
    { id: 'h', x: 0, y: 0, w: 100, h: 50, z: 1, visible: false },
    { id: 'c', x: 10, y: 10, w: 20, h: 20, z: 2, visible: true, parent: 'h' },
  ]);
  assert.ok(r2.issues.some((i) => i.issue === 'zero' && i.boxId === 'h'), '隐藏被引用 → zero');
});