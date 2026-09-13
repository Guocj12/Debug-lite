'use strict';
// F1 store 测试 —— frontend-spec §4（reducer 全 action / persist 往返 / effects 假 api 闭环 / createStore）
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('reducer：goto/tier/meta/seed 基础流', async () => {
  const { reducer, initialState, SCREENS } = await import('../../public/js/store/reducer.js');
  const s0 = initialState();
  assert.equal(s0.screen, 'menu');
  assert.deepEqual(SCREENS, ['menu', 'editor', 'warehouse', 'gacha', 'battle', 'replay', 'settings']);
  assert.equal(reducer(s0, { type: 'goto', payload: { screen: 'nope' } }), s0, '非法屏不变');
  const s1 = reducer(s0, { type: 'goto', payload: { screen: 'warehouse' } });
  assert.equal(s1.screen, 'warehouse');
  assert.equal(reducer(s1, { type: 'tier/set', payload: { tier: 'rare' } }).tier, 'rare');
  assert.deepEqual(reducer(s0, { type: 'meta/loaded', payload: { ok: true, version: '3.0.0', tableNames: ['x'] } }).meta, { serverOk: true, version: '3.0.0', tableNames: ['x'] });
  assert.equal(reducer(s0, { type: 'seed/set', payload: { seed: 42 } }).seed, 42);
});

test('reducer：box/open→box/done 合并（items 数组按 kind 分桶 + seed 回带 + 失败还原）', async () => {
  const { reducer, initialState } = await import('../../public/js/store/reducer.js');
  const s0 = initialState();
  assert.deepEqual(s0.warehouse, { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, 'P1-1：buckets 形状');
  const s1 = reducer(s0, { type: 'box/open', payload: { times: 1 } });
  assert.equal(s1.gacha.opening, true);
  assert.equal(s1.ui.busy, true);
  const r = {
    ok: true,
    data: {
      seed: 7, tier: 'common',
      items: [
        { uid: 'r9', kind: 'role' },
        { uid: 'q8', kind: 'skill' },
        { uid: 'p7', kind: 'rolePlugin' },
        { uid: 'k6', kind: 'skillPlugin' },
        { uid: 'bad' }, // 无 kind → 跳过守卫
        { uid: 'w1', kind: 'gadget' }, // 未知 kind → 白名单跳过
        { uid: 'k5', kind: 'skillPlugin' },
      ],
    },
  };
  const s2 = reducer(s1, { type: 'box/done', payload: r });
  assert.equal(s2.gacha.opening, false);
  assert.equal(s2.ui.busy, false);
  assert.deepEqual(s2.warehouse.buckets.role.map((i) => i.uid), ['r9'], 'P1-2：数组按 kind 分桶（role）');
  assert.deepEqual(s2.warehouse.buckets.skill.map((i) => i.uid), ['q8']);
  assert.deepEqual(s2.warehouse.buckets.rolePlugin.map((i) => i.uid), ['p7']);
  assert.deepEqual(s2.warehouse.buckets.skillPlugin.map((i) => i.uid), ['k6', 'k5']);
  assert.equal(s2.seed, 7, 'seed 回带');
  assert.equal(s2.gacha.lastResult.seed, 7);
  assert.notEqual(s2.warehouse.buckets.role[0], r.data.items[0], 'P2-10：克隆引用（视图 mutate 不脏仓库）');
  const s3 = reducer(s2, { type: 'box/done', payload: { ok: false, code: 'bad_seed' } });
  assert.equal(s3.gacha.opening, false, '失败还原 busy');
  assert.equal(s3.warehouse.buckets.role.length, 1, '失败不合并');
});

test('reducer：仓库整体替换/loadout/ai/battle 全分支', async () => {
  const { reducer, initialState } = await import('../../public/js/store/reducer.js');
  const s0 = initialState();
  const wh = { buckets: { role: [{ uid: 'a' }], skill: [], rolePlugin: [], skillPlugin: [] } };
  const s1 = reducer(s0, { type: 'wh/replaced', payload: { warehouse: wh } });
  assert.deepEqual(s1.warehouse, wh, '整体替换（§4.2 行）');
  const ld = { role: { uid: 'r1' }, skills: [{ uid: 'q1' }, null, null], ai: null };
  const s2 = reducer(s1, { type: 'loadout/set', payload: { loadout: ld } });
  assert.deepEqual(s2.loadout.role, { uid: 'r1' });
  const s3 = reducer(s2, { type: 'ai/edit', payload: { program: { p: 1 } } });
  assert.equal(s3.aiDraft.program.p, 1);
  const s3c = reducer(s3, { type: 'ai/compile' });
  assert.equal(s3c.aiDraft.compiling, true, 'P1-3：ai/compile → compiling');
  const s4 = reducer(s3c, { type: 'ai/compiled', payload: { hash: 'h1', errors: [] } });
  assert.equal(s4.aiDraft.hash, 'h1');
  assert.equal(s4.aiDraft.compiling, false);
  const s4r = reducer(s4, { type: 'ai/run' });
  assert.equal(s4r.battle.running, true, 'P1-3：ai/run → running');
  const s5 = reducer(s4r, { type: 'battle/loaded', payload: { frames: [{ t: 1 }], result: { winner: 'A' } } });
  assert.equal(s5.battle.frames.length, 1);
  assert.equal(s5.battle.tick, 0);
  assert.equal(s5.battle.running, false);
  assert.equal(reducer(s5, { type: 'battle/seek', payload: { tick: 4 } }).battle.tick, 4);
  assert.equal(reducer(s5, { type: 'battle/play' }).battle.playing, true);
  assert.equal(reducer(s5, { type: 'battle/pause' }).battle.playing, false);
  assert.equal(reducer(s5, { type: 'battle/speed', payload: { speed: 2 } }).battle.speed, 2);
  const s6 = reducer(s5, { type: 'panel/loaded', payload: { role: { stats: { hp: 100 } } } });
  assert.equal(s6.panel.role.stats.hp, 100);
  const s7 = reducer(s0, { type: 'save/import', payload: { warehouse: wh, loadout: ld, tier: 'epic', seed: 9 } });
  assert.equal(s7.tier, 'epic');
  assert.equal(s7.seed, 9);
  assert.deepEqual(s7.warehouse, wh, 'save/import 恢复 buckets 仓库');
  const s8 = reducer(s0, { type: 'ui/toast', payload: { text: '错误', kind: 'danger' } });
  assert.equal(s8.ui.snackbar.length, 1);
  const s9 = reducer(s8, { type: 'ui/toast/dismiss', payload: { id: s8.ui.snackbar[0].id } });
  assert.equal(s9.ui.snackbar.length, 0);
});

test('persist：往返 + 字段白名单 + 版本不符清空 + 存储异常安全', async () => {
  const mod = await import('../../public/js/store/persist.js');
  const { initialState, reducer } = await import('../../public/js/store/reducer.js');
  const mem = {};
  const win = { localStorage: { setItem: (k, v) => { mem[k] = v; }, getItem: (k) => (k in mem ? mem[k] : null), removeItem: (k) => { delete mem[k]; } } };
  let st = initialState();
  st = reducer(st, { type: 'tier/set', payload: { tier: 'epic' } });
  st = reducer(st, { type: 'wh/replaced', payload: { warehouse: { buckets: { role: [{ uid: 'x' }], skill: [], rolePlugin: [], skillPlugin: [] } } } });
  assert.equal(mod.save(win, st), true);
  const loaded = mod.load(win);
  assert.equal(loaded.schemaVersion, 1);
  assert.equal(loaded.tier, 'epic');
  assert.equal(loaded.warehouse.buckets.role[0].uid, 'x');
  assert.ok(!('screen' in loaded), 'screen 不落盘（白名单）');
  // 版本不符 → null
  mem[mod.STATE_KEY] = JSON.stringify({ schemaVersion: 999, tier: 'rare' });
  assert.equal(mod.load(win), null, '版本不符 → 清空走迁移');
  // 异常安全
  const badWin = { localStorage: { setItem: () => { throw new Error('quota'); }, getItem: () => { throw new Error('denied'); } } };
  assert.equal(mod.save(badWin, st), false);
  assert.equal(mod.load(badWin), null);
  // node 无 window
  assert.equal(mod.save(null, st), false);
  assert.equal(mod.load(null), null);
});

test('effects：box/open→done 闭环、wh/assemble 失败 toast、store/save 委托', async () => {
  const { runEffect } = await import('../../public/js/store/effects.js');
  const calls = [];
  let seed = 3;
  const api = {
    post: (p, body) => {
      calls.push([p, body]);
      if (p === '/box') return Promise.resolve({ ok: true, data: { seed: 9, items: { role: [{ uid: 'n1' }], skill: [], rolePlugin: [], skillPlugin: [] } } });
      if (p === '/warehouse/assemble') return Promise.resolve({ ok: false, code: 'tier_locked', message: '段位不足' });
      return Promise.resolve({ ok: true, data: {} });
    },
    get: () => Promise.resolve({ ok: true, data: { nodes: [] } }),
  };
  const actions = [];
  const ctxStore = () => ({ seed, tier: 'common', warehouse: { role: [], skill: [], rolePlugin: [], skillPlugin: [] }, loadout: { role: null, skills: [] }, aiDraft: { program: null } });
  const ctx = {
    api,
    store: ctxStore,
    dispatch: (a) => actions.push(a),
    log: null,
    save: () => { calls.push(['save']); },
  };
  await runEffect(ctx, { type: 'box/open', payload: { times: 3 } });
  assert.deepEqual(calls[0], ['/box', { times: 3, tier: 'common', seed: 3 }], 'box/open 带 seed 请求');
  assert.deepEqual(actions.filter((a) => a.type === 'box/done')[0].payload.data.seed, 9);
  assert.ok(actions.some((a) => a.type === 'store/save'));
  await runEffect(ctx, { type: 'wh/assemble', payload: { targetUid: 'r', pluginUid: 'p', slotIndex: 0 } });
  assert.equal(actions.filter((a) => a.type === 'ui/toast').length, 1, '失败 → toast');
  assert.ok(!actions.some((a) => a.type === 'wh/replaced'));
  await runEffect(ctx, { type: 'store/save' });
  assert.ok(calls.some((c) => c[0] === 'save'), 'store/save 委托 ctx.save');
});

test('createStore：订阅/退订 + onChange 钩子 + dispatch 日志', async () => {
  const { createStore } = await import('../../public/js/store/index.js');
  const seen = [];
  const onChanges = [];
  const store = createStore({
    api: { get: async () => ({ ok: true, data: {} }), post: async () => ({ ok: true, data: {} }) },
    log: { debug: () => {} },
    onChange: (next, action) => onChanges.push(action.type),
  });
  const off = store.subscribe((s) => seen.push(s.tier));
  store.dispatch({ type: 'tier/set', payload: { tier: 'rare' } });
  assert.deepEqual(seen, ['rare'], '订阅收到新状态');
  assert.deepEqual(onChanges, ['tier/set'], 'onChange 钩子');
  off();
  store.dispatch({ type: 'tier/set', payload: { tier: 'epic' } });
  assert.equal(seen.length, 1, '退订后不再通知');
  assert.equal(store.getState().tier, 'epic');
});