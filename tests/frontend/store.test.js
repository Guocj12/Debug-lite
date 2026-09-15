'use strict';
// P6 R1 store 契约测试 —— frontend-spec §4.1/§4.2（reducer 纯函数 + createStore 分发/effect）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let initialState, reducer, emptyWarehouse, createStore;
before(async () => {
  const rm = await import('../../public/js/store/reducer.js');
  const sm = await import('../../public/js/store/index.js');
  ({ initialState, reducer, emptyWarehouse } = rm);
  ({ createStore } = sm);
});

function sink() {
  const rec = [];
  const logger = {
    debug: (c, e, m, d) => rec.push({ c, e, m, d }),
    info: (c, e, m, d) => rec.push({ c, e, m, d }),
    warn: (c, e, m, d) => rec.push({ c, e, m, d }),
    error: (c, e, m, d) => rec.push({ c, e, m, d }),
    setLevel: () => {}, setChannelLevel: () => {},
  };
  return { rec, log: logger };
}

test('R1 reducer：initialState 形状与 §4.1 对齐（仓库为 B18 buckets 形状）', () => {
  const s = initialState();
  assert.equal(s.screen, 'menu');
  assert.equal(s.tier, 'common');
  assert.deepEqual(s.warehouse.buckets, { role: [], skill: [], rolePlugin: [], skillPlugin: [] });
  assert.deepEqual(s.loadout.skills, [null, null, null]);
  assert.deepEqual(s.logPrefs, { level: 'debug', channels: {}, panelOpen: false });
  assert.deepEqual(s.battle, { config: null, playing: false, frames: [], result: null, tick: 0, speed: 1 });
});

test('R1 reducer：goto/tier/meta/seed 基础流（goto 清 modal/selected）', () => {
  let s = initialState();
  s = reducer(s, { type: 'goto', screen: 'gacha' });
  assert.equal(s.screen, 'gacha');
  s = reducer({ ...s, ui: { ...s.ui, modal: { t: 1 }, selected: { warehouse: 'u1' } } }, { type: 'goto', screen: 'menu' });
  assert.equal(s.ui.modal, null);
  assert.deepEqual(s.ui.selected, {});
  s = reducer(s, { type: 'seed/set', seed: 42 });
  assert.equal(s.seed, 42);
  s = reducer(s, { type: 'meta/set', patch: { serverOk: true, version: '3.0.0' } });
  assert.equal(s.meta.serverOk, true);
  s = reducer(s, { type: 'tier/set', tier: 'rare' });
  assert.equal(s.tier, 'rare');
});

test('R1 reducer：box/open→done 分桶合并 + fail 复原', () => {
  let s = initialState();
  s = reducer(s, { type: 'box/open' });
  assert.equal(s.gacha.opening, true);
  assert.equal(s.ui.busy, true);
  s = reducer(s, {
    type: 'box/done',
    resp: { items: [
      { uid: 'a', kind: 'role', name: 'R1' },
      { uid: 'b', kind: 'skillPlugin', name: 'S1' },
      { uid: 'c', kind: 'bogus' },      // 未知 kind 跳过
      { uid: 'd', kind: 'role' },
    ] },
  });
  assert.equal(s.gacha.opening, false);
  assert.equal(s.ui.busy, false);
  assert.equal(s.warehouse.buckets.role.length, 2);
  assert.equal(s.warehouse.buckets.skillPlugin.length, 1);
  assert.deepEqual(s.gacha.lastResult.map((x) => x.uid), ['a', 'b', 'c', 'd']);
  // items 非数组防御
  const s2 = reducer(initialState(), { type: 'box/done', resp: { items: null } });
  assert.deepEqual(s2.gacha.lastResult, []);
  s = reducer(s, { type: 'box/fail' });
  assert.equal(s.gacha.opening, false);
});

test('R1 reducer：wh/set · wh/tab · wh/select', () => {
  let s = initialState();
  const wh = { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } };
  s = reducer(s, { type: 'wh/set', warehouse: wh });
  assert.deepEqual(s.warehouse, wh);
  s = reducer(s, { type: 'wh/tab', bucket: 'skill' });
  assert.equal(s.ui.activeTab.warehouse, 'skill');
  s = reducer(s, { type: 'wh/select', uid: 'r1' });
  assert.equal(s.ui.selected.warehouse, 'r1');
});

test('R1 reducer：loadout/panel/aiDraft 基本流', () => {
  let s = initialState();
  s = reducer(s, { type: 'loadout/set', loadout: { role: 'r1', skills: ['s1', 's2', 's3'], ai: { program: {} } } });
  assert.deepEqual(s.loadout.skills, ['s1', 's2', 's3']);
  s = reducer(s, { type: 'loadout/set', loadout: {} }); // 缺省归一
  assert.deepEqual(s.loadout.skills, [null, null, null]);
  s = reducer(s, { type: 'panel/set', panel: { atk: 22 } });
  assert.deepEqual(s.panel, { atk: 22 });
  s = reducer(s, { type: 'ai/edit', program: { version: 2 } });
  assert.deepEqual(s.aiDraft.program, { version: 2 });
  assert.equal(s.aiDraft.hash, null);
  s = reducer(s, { type: 'ai/compile' });
  assert.equal(s.aiDraft.compiling, true);
  s = reducer(s, { type: 'ai/compiled', hash: 'abcd1234' });
  assert.equal(s.aiDraft.hash, 'abcd1234');
  assert.equal(s.aiDraft.compiling, false);
  s = reducer(s, { type: 'ai/errors', errors: [{ code: 'x' }] });
  assert.deepEqual(s.aiDraft.errors, [{ code: 'x' }]);
});

test('R1 reducer：battle 装载/seek 钳制/播放与倍速', () => {
  let s = initialState();
  s = reducer(s, { type: 'ai/run' });
  assert.equal(s.battle.running, true);
  assert.equal(s.ui.busy, true);
  s = reducer(s, { type: 'battle/loaded', frames: [{ tick: 1 }, { tick: 2 }, { tick: 3 }], result: { winner: 'p1' } });
  assert.equal(s.battle.running, false);
  assert.equal(s.battle.playing, false);
  assert.equal(s.battle.frames.length, 3);
  assert.deepEqual(s.battle.result, { winner: 'p1' });
  s = reducer(s, { type: 'battle/seek', tick: 99 });
  assert.equal(s.battle.tick, 2, 'seek 钳制到末帧');
  s = reducer(s, { type: 'replay/play' });
  assert.equal(s.battle.playing, true);
  s = reducer(s, { type: 'replay/speed', speed: 4 });
  assert.equal(s.battle.speed, 4);
  s = reducer(s, { type: 'replay/speed', speed: 9 });
  assert.equal(s.battle.speed, 4, '非法倍速不变');
  s = reducer(s, { type: 'replay/pause' });
  assert.equal(s.battle.playing, false);
  s = reducer(s, { type: 'battle/seek', tick: -5 });
  assert.equal(s.battle.tick, 0, '负 tick 钳 0');
});

test('R1 reducer：logPrefs/save(ui.toast)/modal', () => {
  let s = initialState();
  s = reducer(s, { type: 'log/set', level: 'trace', channels: { ui: 'debug' }, panelOpen: true });
  assert.equal(s.logPrefs.level, 'trace');
  assert.deepEqual(s.logPrefs.channels, { ui: 'debug' });
  assert.equal(s.logPrefs.panelOpen, true);
  s = reducer(s, { type: 'save/set', tier: 'epic', warehouse: emptyWarehouse(), loadout: { role: 'r' }, lastResult: [{ uid: 'z' }] });
  assert.equal(s.tier, 'epic');
  assert.deepEqual(s.gacha.lastResult, [{ uid: 'z' }]);
  s = reducer(s, { type: 'ui/toast', text: 'a' });
  s = reducer(s, { type: 'ui/toast', text: 'b', kind: 'error' });
  assert.deepEqual(s.ui.snackbar.map((t) => t.text), ['a', 'b']);
  s = reducer(s, { type: 'ui/toast/pop' });
  assert.deepEqual(s.ui.snackbar.map((t) => t.text), ['b']);
  s = reducer(s, { type: 'ui/modal', modal: { kind: 'result' } });
  assert.deepEqual(s.ui.modal, { kind: 'result' });
  s = reducer(s, { type: 'ui/modal' });
  assert.equal(s.ui.modal, null);
});

test('R1 reducer：toast 上限 4 条 + 未知 action 原样返回 + 防御臂全开', () => {
  let s = initialState();
  for (let i = 0; i < 6; i++) s = reducer(s, { type: 'ui/toast', text: `t${i}` });
  assert.equal(s.ui.snackbar.length, 4);
  const s2 = reducer(s, { type: 'bogus/action' });
  assert.equal(s2, s, '未知 action 返回原状态');
  const s3 = reducer(null, { type: '@@init' });
  assert.equal(s3.screen, 'menu');
  // 缺参/空值归一（§4.2 各 action 兜底）
  assert.equal(reducer(s, { type: 'seed/set' }).seed, s.seed);
  assert.equal(reducer(s, { type: 'seed/set', seed: undefined }).seed, s.seed);
  assert.deepEqual(reducer(s, { type: 'meta/set' }).meta, s.meta);
  assert.equal(reducer(s, { type: 'tier/set' }).tier, s.tier);
  assert.equal(reducer(s, { type: 'tier/info' }).tierInfo, s.tierInfo);
  assert.equal(reducer(s, { type: 'wh/set' }).warehouse, s.warehouse);
  assert.equal(reducer(s, { type: 'wh/tab' }).ui.activeTab.warehouse, 'role');
  assert.equal(reducer(s, { type: 'wh/select' }).ui.selected.warehouse, null);
  assert.equal(reducer(s, { type: 'ai/edit' }).aiDraft.program, null);
  assert.equal(reducer(s, { type: 'ai/compiled' }).aiDraft.hash, null);
  assert.deepEqual(reducer(s, { type: 'ai/errors' }).aiDraft.errors, []);
  const bl = reducer(s, { type: 'battle/loaded' });
  assert.deepEqual(bl.battle.frames, []);
  assert.equal(bl.battle.result, null);
  assert.equal(bl.battle.config, s.battle.config, '缺 config 保持原值');
  assert.equal(reducer(s, { type: 'battle/seek', tick: 'x' }).battle.tick, 0);
  assert.equal(reducer(s, { type: 'replay/speed', speed: 2 }).battle.speed, 2);
  assert.equal(reducer(s, { type: 'ui/toast', text: null }).ui.snackbar[3].text, '', '空文本归一（cap 末位）');
  assert.equal(reducer(s, { type: 'ui/modal' }).ui.modal, null);
  assert.equal(reducer(s, { type: 'ui/busy' }).ui.busy, false);
  const sOnly = reducer(s, { type: 'save/set', tier: 'mythic' });
  assert.equal(sOnly.tier, 'mythic');
  assert.equal(sOnly.warehouse, s.warehouse, 'save/set 单字段只动该字段');
  const lo = reducer(s, { type: 'loadout/set' });
  assert.deepEqual(lo.loadout, { role: null, skills: [null, null, null], ai: null });
});

test('R1 createStore：订阅/退订 + dispatch 日志 + effect 异常不抛穿', async () => {
  const { log, rec } = sink();
  const seen = [];
  const store = createStore({
    reducer,
    effects: {
      'tier/set': async () => { throw new Error('boom'); },
    },
    log,
  });
  const off = store.subscribe((s) => seen.push(s.screen));
  store.dispatch({ type: 'tier/set', tier: 'epic' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.getState().tier, 'epic');
  assert.deepEqual(seen.length, 1);
  assert.ok(rec.some((r) => r.e === 'store.dispatch'));
  assert.ok(rec.some((r) => r.e === 'store.effect.err' && /tier\/set/.test(r.m)), 'effect 异常应被记录且不抛出');
  off();
  store.dispatch({ type: 'goto', screen: 'settings' });
  assert.deepEqual(seen.length, 1, '退订后不再通知');
  assert.equal(store.getState().screen, 'settings');
});

test('R1 createStore：initialPatch 并入 + 订阅者异常不炸 dispatch', async () => {
  const { log } = sink();
  const store = createStore({ reducer, effects: {}, log, initialPatch: { tier: 'legendary', seed: 11 } });
  assert.equal(store.getState().tier, 'legendary');
  assert.equal(store.getState().seed, 11);
  store.subscribe(() => { throw new Error('sub boom'); });
  assert.doesNotThrow(() => store.dispatch({ type: 'goto', screen: 'menu' }));
  await new Promise((r) => setTimeout(r, 5));
});

test('R1 createStore：裸构造（缺 opts/log/api/persist）+ 空动作分发', async () => {
  const store = createStore({ reducer });
  assert.doesNotThrow(() => store.dispatch(null), 'null action → noop 兜底');
  assert.doesNotThrow(() => store.dispatch({ type: 'goto', screen: 'menu' }));
  assert.equal(store.getState().screen, 'menu');
  const off = store.subscribe(() => {});
  off();
});

test('R1 createStore：无 reducer 构造 + 无 log 订阅者异常（兜底臂）', async () => {
  assert.doesNotThrow(() => createStore({}), 'reducer 缺省 → 空 state 构造');
  const store = createStore({ reducer });
  store.subscribe(() => { throw new Error('sub boom without log'); });
  assert.doesNotThrow(() => store.dispatch({ type: 'goto', screen: 'menu' }));
  await new Promise((r) => setTimeout(r, 5));
});
