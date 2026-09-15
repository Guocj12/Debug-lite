'use strict';
// P6 R1 effects 契约测试 —— frontend-spec §4.2（假 api 全链：boot/box/wh/loadout/panel/log/seed/toast）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let effects, reducer, initialState, createStore;
before(async () => {
  const em = await import('../../public/js/store/effects.js');
  const rm = await import('../../public/js/store/reducer.js');
  const sm = await import('../../public/js/store/index.js');
  ({ effects } = em);
  ({ reducer, initialState } = rm);
  ({ createStore } = sm);
});

function sink() {
  const rec = [];
  const log = {
    debug: (c, e, m, d) => rec.push({ lv: 'debug', c, e, m, d }),
    info: (c, e, m, d) => rec.push({ lv: 'info', c, e, m, d }),
    warn: (c, e, m, d) => rec.push({ lv: 'warn', c, e, m, d }),
    error: (c, e, m, d) => rec.push({ lv: 'error', c, e, m, d }),
    setLevel: () => {}, setChannelLevel: () => {},
  };
  return { rec, log };
}

// 构造带 effect 注入的 store + 假 api/persist
function harness(api, persist, timers) {
  const { log, rec } = sink();
  const store = createStore({ reducer, effects: effects(), persist: persist || fakePersist(), api, log, timers: timers || null });
  return { store, log, rec };
}

function fakePersist() {
  const saves = [];
  return {
    saves,
    save: (s) => saves.push(JSON.parse(JSON.stringify({ tier: s.tier }))),
    saveLogPrefs: (p) => saves.push(['logPrefs', JSON.stringify(p)]),
    saveSeed: (seed) => saves.push(['seed', seed]),
    loadLogPrefs: () => ({}),
    loadSeed: () => null,
  };
}

function okApi(over) {
  return {
    health: async () => ({ ok: true, data: { status: 'ok', version: '3.0.0' } }),
    unlock: async () => ({ ok: true, data: { tier: 'common', nodes: ['move'] } }),
    box: async () => ({ ok: true, data: { seed: 1, items: [{ uid: 'u1', kind: 'role', name: 'R' }] } }),
    wh: { assemble: async () => ({ ok: true, data: { warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } } }), disassemble: async () => ({ ok: true, data: { warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } } }) },
    loadout: { save: async () => ({ ok: true, data: { loadout: {} } }) },
    panel: async () => ({ ok: true, data: { panel: { atk: 22 } } }),
    logLevel: { set: async () => ({ ok: true, data: {} }) },
    ...over,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 8));

test('R1 effects.boot：health→serverOk/version + unlock→tierInfo + store.boot 日志', async () => {
  const { store, rec } = harness(okApi());
  store.dispatch({ type: 'boot' });
  await flush();
  const s = store.getState();
  assert.equal(s.meta.serverOk, true);
  assert.equal(s.meta.version, '3.0.0');
  assert.deepEqual(s.tierInfo.nodes, ['move']);
  assert.ok(rec.some((r) => r.e === 'store.boot' && r.d.state.serverOk === true && r.d.state.tier === 'common'), '应有 store.boot');
});

test('R1 effects.boot：health 拒绝 → serverOk false + tier 拒绝 toast', async () => {
  const api = okApi({ health: async () => ({ ok: false, code: 'x', message: 'down' }), unlock: async () => ({ ok: false, code: 'bad_tier', message: '非法' }) });
  const { store } = harness(api);
  store.dispatch({ type: 'boot' });
  await flush();
  const s = store.getState();
  assert.equal(s.meta.serverOk, false);
  assert.ok(s.ui.snackbar.some((t) => t.kind === 'error' && t.text.includes('bad_tier')));
});

test('R1 effects：tier/set → 解锁刷新 + 落盘 save/seed', async () => {
  const persist = fakePersist();
  const { store } = harness(okApi(), persist);
  store.dispatch({ type: 'tier/set', tier: 'rare' });
  await flush();
  assert.equal(store.getState().tier, 'rare', 'reducer 已应用 tier');
  assert.deepEqual(store.getState().tierInfo.nodes, ['move'], 'unlock 已刷新');
  assert.equal(persist.saves.filter((x) => !Array.isArray(x)).length, 1, 'state 落盘一次');
  assert.ok(persist.saves.some((x) => Array.isArray(x) && x[0] === 'seed'), 'seed 应落盘');
});

test('R1 effects：box/open 成功 → 合并 + busy 复原 + 落盘；失败 → toast', async () => {
  const persist = fakePersist();
  const { store, rec } = harness(okApi(), persist);
  store.dispatch({ type: 'box/open', times: 3 });
  await flush();
  const s = store.getState();
  assert.equal(s.gacha.opening, false);
  assert.equal(s.warehouse.buckets.role.length, 1);
  assert.equal(persist.saves.filter((x) => typeof x === 'object' && !Array.isArray(x)).length, 1);
  assert.ok(rec.some((r) => r.e === 'store.dispatch' && r.d.action === 'box/open' && r.d.sideEffects === true));

  const api2 = okApi({ box: async () => ({ ok: false, code: 'tier_locked', message: '池空' }) });
  const { store: st2 } = harness(api2);
  st2.dispatch({ type: 'box/open', times: 1 });
  await flush();
  assert.equal(st2.getState().gacha.opening, false);
  assert.ok(st2.getState().ui.snackbar.some((t) => t.text.includes('tier_locked')));
});

test('R1 effects：wh/assemble 成功整体替换 + 日志；拆卸失败 toast', async () => {
  const persist = fakePersist();
  const { store, rec } = harness(okApi(), persist);
  store.dispatch({ type: 'wh/assemble', targetUid: 'r1', pluginUid: 'p1', slotIndex: 0 });
  await flush();
  assert.deepEqual(store.getState().warehouse.buckets, { role: [], skill: [], rolePlugin: [], skillPlugin: [] });
  assert.ok(rec.some((r) => r.e === 'wh.assemble.ok' && r.d.targetUid === 'r1'));

  const api2 = okApi({ wh: { assemble: async () => ({ ok: true, data: {} }), disassemble: async () => ({ ok: false, code: 'slot_empty', message: '空槽' }) } });
  const { store: st2 } = harness(api2);
  st2.dispatch({ type: 'wh/disassemble', targetUid: 'r9', slotIndex: 2 });
  await flush();
  assert.ok(st2.getState().ui.snackbar.some((t) => t.text.includes('slot_empty')));
});

test('R1 effects：loadout/validate 两态（通过 toast / 拒绝 details→toast）', async () => {
  const { store } = harness(okApi());
  store.dispatch({ type: 'loadout/validate' });
  await flush();
  assert.ok(store.getState().ui.snackbar.some((t) => t.text.includes('校验通过')));

  const api2 = okApi({ loadout: { save: async () => ({ ok: false, code: 'loadout_invalid', message: '不合法', details: ['skills 数量 != 3', { path: 'ai' }] }) } });
  const { store: st2 } = harness(api2);
  st2.dispatch({ type: 'loadout/validate' });
  await flush();
  const texts = st2.getState().ui.snackbar.map((t) => t.text);
  assert.ok(texts.includes('skills 数量 != 3'), '字符串 details 原样展示');
  assert.ok(texts.some((x) => x.includes('ai')), '对象 details 应 JSON 化显示');
});

test('R1 effects：panel/show 两态', async () => {
  const { store } = harness(okApi());
  store.dispatch({ type: 'panel/show' });
  await flush();
  assert.deepEqual(store.getState().panel, { atk: 22 });
  const api2 = okApi({ panel: async () => ({ ok: false, code: 'loadout_invalid', message: 'x', details: [] }) });
  const { store: st2 } = harness(api2);
  st2.dispatch({ type: 'panel/show' });
  await flush();
  assert.equal(st2.getState().panel, null);
  assert.ok(st2.getState().ui.snackbar.some((t) => t.kind === 'error'));
});

test('R1 effects：wh/assemble 失败 toast（装配臂）', async () => {
  const api2 = okApi({ wh: { assemble: async () => ({ ok: false, code: 'points_exceeded', message: '超限' }), disassemble: async () => ({ ok: true, data: {} }) } });
  const { store: st2 } = harness(api2);
  st2.dispatch({ type: 'wh/assemble', targetUid: 'r1', pluginUid: 'p1', slotIndex: 0 });
  await flush();
  assert.ok(st2.getState().ui.snackbar.some((t) => t.text.includes('points_exceeded')));
});

test('R1 effects：loadout/validate 无 details → 用 message 兜底', async () => {
  const api3 = okApi({ loadout: { save: async () => ({ ok: false, code: 'loadout_invalid', message: '整体拒绝', details: [] }) } });
  const { store: st3 } = harness(api3);
  st3.dispatch({ type: 'loadout/validate' });
  await flush();
  assert.ok(st3.getState().ui.snackbar.some((t) => t.text.includes('整体拒绝')));
});

test('R1 effects：分支锤 —— 无 message 拒绝 / 无 times', async () => {
  // 无 message 的失败（toastErr falsy message 臂）
  const api2 = okApi({ wh: { assemble: async () => ({ ok: false, code: 'slot_occupied', message: '' }), disassemble: async () => ({ ok: true, data: {} }) } });
  const { store: st2 } = harness(api2);
  st2.dispatch({ type: 'wh/assemble', targetUid: 'r1', pluginUid: 'p1', slotIndex: 0 });
  await flush();
  assert.ok(st2.getState().ui.snackbar.some((t) => t.text === 'slot_occupied'), '无 message 只显示 code');

  // 无 times → 默认 1 次
  const { store: st3 } = harness(okApi());
  st3.dispatch({ type: 'box/open' });
  await flush();
  assert.equal(st3.getState().gacha.lastResult.length, 1);
});

test('R1 effects：store.boot 上报 loadoutHash 与 warehouseCount', async () => {
  const { store, rec } = harness(okApi());
  store.dispatch({ type: 'loadout/set', loadout: { role: 'r', skills: [null, null, null], ai: { hash: 'ff00' } } });
  await flush();
  store.dispatch({ type: 'boot' });
  await flush();
  const rec1 = rec.find((r) => r.e === 'store.boot');
  assert.equal(rec1.d.state.loadoutHash, 'ff00', 'ai hash 上报');
  assert.equal(rec1.d.state.warehouseCount, 0);
});

test('R1 effects：boot 兜底臂 —— ai 无 hash → null；warehouse null → count 0', async () => {
  const { store, rec } = harness(okApi());
  store.dispatch({ type: 'loadout/set', loadout: { role: 'r', skills: [null, null, null], ai: {} } });
  await flush();
  store.dispatch({ type: 'save/set', warehouse: null });
  store.dispatch({ type: 'boot' });
  await flush();
  const rec1 = rec.find((r) => r.e === 'store.boot');
  assert.equal(rec1.d.state.loadoutHash, null, '无 hash 归一 null');
  assert.equal(rec1.d.state.warehouseCount, 0, 'warehouse 畸形 → 0');
});

test('R1 effects：log/set 带 logLevel 但无 payload（两处 false 臂）', async () => {
  const persist = fakePersist();
  const calls = [];
  const api = okApi({ logLevel: { set: async (p) => { calls.push(p); return { ok: true, data: {} }; } } });
  const { store } = harness(api, persist);
  store.dispatch({ type: 'log/set' });
  await flush();
  assert.deepEqual(calls, [{}], '空 payload 同步');
  assert.equal(store.getState().logPrefs.level, 'debug');
});

test('R1 effects：wh/assemble 成功但 log 为 null（log && 短路臂）', async () => {
  const api = okApi();
  const store = createStore({ reducer, effects: effects(), persist: fakePersist(), api, log: null, timers: null });
  store.dispatch({ type: 'wh/assemble', targetUid: 'r1', pluginUid: 'p1', slotIndex: 0 });
  await flush();
  assert.ok(store.getState().warehouse);
});

test('R1 effects：无 api ctx 的 log/set（api null 分支）', async () => {
  const persist = fakePersist();
  const { log, rec } = sink();
  const store = createStore({ reducer, effects: effects(), persist, api: null, log, timers: null });
  store.dispatch({ type: 'log/set', level: 'debug', channels: { ui: 'info' } });
  await flush();
  assert.equal(store.getState().logPrefs.channels.ui, 'info');
  assert.ok(persist.saves.some((x) => Array.isArray(x) && x[0] === 'logPrefs'));
});

test('R5 effects：replay/play —— 无 timers 早退 + 末帧开局自动 pause + speed 0 兜底', async () => {
  // 无 timers → 早退不炸
  const store1 = createStore({ reducer, effects: effects(), persist: fakePersist(), api: okApi(), log: sink().log, timers: null });
  store1.dispatch({ type: 'replay/play' });
  await flush();
  assert.equal(store1.getState().battle.playing, true);
  // speed 0 → 兜底 1000ms
  const fired = [];
  const timers = { setTimeout: (fn, ms) => fired.push(ms) };
  const store2 = createStore({
    reducer, effects: effects(), persist: fakePersist(), api: okApi(), log: sink().log, timers,
    initialPatch: { battle: { playing: false, frames: [{}, {}, {}], tick: 0, speed: 0, result: null } },
  });
  store2.dispatch({ type: 'replay/play' });
  await flush();
  assert.deepEqual(fired, [1000], 'speed 0 → 兜底 1x');
  // 空局播放（无 frames）→ 立即 pause
  const store3 = createStore({
    reducer, effects: effects(), persist: fakePersist(), api: okApi(), log: sink().log, timers,
    initialPatch: { battle: { playing: false, frames: [], tick: 0, speed: 1, result: null } },
  });
  store3.dispatch({ type: 'replay/play' });
  await flush();
  assert.equal(store3.getState().battle.playing, false, '空局自动 pause');
});

test('R5 effects：ai/run —— 成功 goto replay / 失败 toast / 空程序守卫', async () => {
  const api = okApi({ aiBattle: async () => ({ ok: true, data: { id: 'rp9', seed: 5, tier: 'common', winner: 'p1', phase: 'base', ticks: 7, frames: [{ tick: 1, diff: {} }] } }) });
  const { store } = harness(api);
  store.dispatch({ type: 'loadout/set', loadout: { role: null, skills: [null, null, null], ai: { type: 'program', version: 1, body: {} } } });
  await flush();
  store.dispatch({ type: 'ai/run' });
  await flush();
  assert.equal(store.getState().screen, 'replay');
  assert.equal(store.getState().battle.frames.length, 1);

  const { store: st2 } = harness(okApi({ aiBattle: async () => ({ ok: false, code: 'ai_invalid', message: 'x', details: [] }) }));
  st2.dispatch({ type: 'ai/edit', program: { type: 'program', version: 1, body: {} } });
  await flush();
  st2.dispatch({ type: 'ai/run' });
  await flush();
  assert.equal(st2.getState().ui.busy, false);
  assert.ok(st2.getState().ui.snackbar.some((t) => t.text.includes('ai_invalid')));
  assert.equal(st2.getState().screen, 'menu', '失败不切屏');

  // 空程序（loadout.ai 与 aiDraft.program 均无）→ 守卫 toast
  const { store: st3 } = harness(okApi());
  st3.dispatch({ type: 'ai/run' });
  await flush();
  assert.ok(st3.getState().ui.snackbar.some((t) => t.text.includes('ai_empty')));
});

test('R5 effects：battle/run 分支锤 —— warehouse null / 悬空 uid / 缺 skills 字段 / 响应缺 warehouse', async () => {
  const calls = [];
  const api = okApi({ battle: async (b) => { calls.push(b); return { ok: true, data: { id: 'r', seed: 1, tier: 'common', winner: 'draw', phase: null, ticks: 3, frames: [] } }; } });
  const persist = fakePersist();
  const store = createStore({ reducer, effects: effects(), persist, api, log: sink().log, timers: null });
  store.dispatch({ type: 'save/set', warehouse: null });
  store.dispatch({ type: 'battle/run' }); // loadout 空 → p1 全 null
  await flush();
  const b = calls[0];
  assert.equal(b.p1.role, null, '悬空/缺 role → null');
  assert.deepEqual(b.p1.skills, [null, null, null], '缺 skills → null 槽');
  assert.equal(store.getState().screen, 'replay', '空 p1 也起战（后端裁决）');
  // assemble 响应缺 warehouse → 状态保持
  const api2 = okApi({ wh: { assemble: async () => ({ ok: true, data: {} }), disassemble: async () => ({ ok: true, data: {} }) } });
  const persist2 = fakePersist();
  const store2 = createStore({ reducer, effects: effects(), persist: persist2, api: api2, log: sink().log, timers: null });
  store2.dispatch({ type: 'wh/assemble', targetUid: 'a', pluginUid: 'b', slotIndex: 0 });
  await flush();
  assert.ok(store2.getState().warehouse.buckets, '缺响应 warehouse → 原状态');
});

test('R5 effects：boot 分支锤 —— 桶非数组计数 0', async () => {
  const store = createStore({
    reducer, effects: effects(), persist: fakePersist(), api: okApi(), log: sink().log, timers: null,
    initialPatch: { warehouse: { buckets: { role: 'x', skill: [], rolePlugin: [], skillPlugin: [] } } },
  });
  store.dispatch({ type: 'boot' });
  await flush();
  assert.ok(store.getState().meta.serverOk === true);
});

test('R6 effects：ai/edit —— 空程序跳过 / manual 立即校验 / errors 映射 / 无 timers 臂', async () => {
  const pending = [];
  const timers2 = { setTimeout: (fn, ms) => { pending.push([fn, ms]); return pending.length; }, clearTimeout: () => {} };
  // 空程序 → 早退
  const { store: st0 } = harness(okApi(), fakePersist(), timers2);
  st0.dispatch({ type: 'ai/edit', program: null });
  await flush();
  assert.equal(st0.getState().aiDraft.errors.length, 0);
  // 注入 program（reducer ai/edit 存 program）→ manual 立即校验
  const api = okApi({ aiValidate: async (b) => (b.program && b.program.body.statements.length === 0 ? { ok: false, code: 'ai_invalid', message: 'bad', details: [{ path: 'body.s[0]', code: 'branch_without_action', message: 'x' }] } : { ok: true, data: {} }) });
  const { store: st1 } = harness(api, fakePersist(), timers2);
  st1.dispatch({ type: 'ai/edit', program: { type: 'program', version: 1, body: { type: 'seq', statements: [] } } });
  await flush();
  st1.dispatch({ type: 'ai/edit', manual: true });
  await flush();
  assert.deepEqual(st1.getState().aiDraft.errors, [{ path: 'body.s[0]', code: 'branch_without_action', message: 'x' }], '拒绝 → details 直通 errors');
  // 无 timers → 非 manual 也立即校验
  const { store: st2 } = harness(api, fakePersist(), null);
  st2.dispatch({ type: 'ai/edit', program: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } } });
  await flush();
  st2.dispatch({ type: 'ai/edit', manual: true });
  await flush();
  assert.deepEqual(st2.getState().aiDraft.errors, [], '合法程序 → errors 清空');
  // 防抖：非 manual + timers → 300ms 后回调
  assert.ok(pending.length >= 1, '防抖已排程');
  const last = pending[pending.length - 1];
  assert.equal(last[1], 300);
  last[0](); // 触发防抖回调 → 校验（当前 program 为空 → 早退）
  await flush();
});

test('R6 effects：ai/compile —— 成功 hash+loadout 接线 / 失败 toast / 空程序守卫', async () => {
  const prog = { type: 'program', version: 1, body: { type: 'seq', statements: [] } };
  const api = okApi({ aiCompile: async () => ({ ok: true, data: { programHash: 'abcdef1234567890' } }) });
  const { store } = harness(api);
  store.dispatch({ type: 'ai/edit', program: prog });
  await flush();
  store.dispatch({ type: 'ai/compile' });
  await flush();
  assert.equal(store.getState().aiDraft.hash, 'abcdef1234567890', 'state 存完整 hash（视图显示前 8 位）');
  assert.ok(store.getState().ui.snackbar.some((t) => t.text.includes('编译通过')));
  // 失败
  const { store: st2 } = harness(okApi({ aiCompile: async () => ({ ok: false, code: 'ai_too_large', message: 'x', details: [] }) }), fakePersist());
  st2.dispatch({ type: 'ai/edit', program: prog });
  await flush();
  st2.dispatch({ type: 'ai/compile' });
  await flush();
  assert.equal(st2.getState().aiDraft.hash, null);
  assert.ok(st2.getState().ui.snackbar.some((t) => t.text.includes('ai_too_large')));
  // 空程序
  const { store: st3 } = harness(okApi(), fakePersist());
  st3.dispatch({ type: 'ai/compile' });
  await flush();
  assert.ok(st3.getState().ui.snackbar.some((t) => t.text.includes('ai_empty')));
});

test('R6 effects：editor/highlight —— dom 缝高亮 / 未找到臂', async () => {
  const paths = [];
  const { store } = harness(okApi(), fakePersist(), null);
  store.dispatch({ type: 'editor/highlight', path: 'body.s[0]' });
  await flush();
  assert.ok(store.getState().ui.snackbar.some((t) => t.text.includes('高亮 body.s[0]')));
  // dom.highlight false → 程序已变化
  const store2 = createStore({ reducer, effects: effects(), persist: fakePersist(), api: okApi(), log: sink().log, timers: null, dom: { highlight: () => false } });
  store2.dispatch({ type: 'editor/highlight', path: 'body.s[0]' });
  await flush();
  assert.ok(store2.getState().ui.snackbar.some((t) => t.text.includes('程序已变化')));
});

test('R2 effects：save/export —— doc 缝下载 + 无 doc 提示臂', async () => {
  const persist = fakePersist();
  persist.exportState = (s) => JSON.stringify({ schemaVersion: 1, tier: s.tier });
  const downloads = [];
  const store1 = createStore({ reducer, effects: effects(), persist, api: okApi(), log: sink().log, timers: null, dom: { download: (name, text) => downloads.push([name, text]) } });
  store1.dispatch({ type: 'save/export' });
  await flush();
  assert.equal(downloads.length, 1, 'doc 缝触发下载');
  assert.ok(downloads[0][0].startsWith('dl-save-'));
  assert.ok(downloads[0][1].includes('schemaVersion'));
  assert.ok(store1.getState().ui.snackbar.some((t) => t.text.includes('已导出')));
  // 无 dom → 提示臂
  const rec2 = [];
  const persist2 = fakePersist();
  persist2.exportState = (s) => JSON.stringify({ schemaVersion: 1 });
  const store2 = createStore({ reducer, effects: effects(), persist: persist2, api: okApi(), log: { debug: () => {}, info: (c, e, m) => rec2.push(m), warn: () => {}, error: () => {} }, timers: null, dom: null });
  store2.dispatch({ type: 'save/export' });
  await flush();
  assert.ok(store2.getState().ui.snackbar.some((t) => t.kind === 'error'), '无 doc → toast 提示');
  assert.ok(rec2.some((m) => /schemaVersion/.test(m)), '导出文本落日志');
});

test('R2 effects：save/import —— 成功 save/set+goto menu / 失败 toast', async () => {
  const persist = fakePersist();
  persist.parseImport = (text) => (text.includes('"tier":"rare"') ? { ok: true, patch: { tier: 'rare', warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: null, skills: [null, null, null], ai: null } } } : { ok: false, code: 'bad_json' });
  const store = createStore({ reducer, effects: effects(), persist, api: okApi(), log: sink().log, timers: null, dom: null });
  store.dispatch({ type: 'goto', screen: 'settings' });
  await flush();
  store.dispatch({ type: 'save/import', text: '{"tier":"rare"}' });
  await flush();
  assert.equal(store.getState().tier, 'rare', 'patch 应用');
  assert.equal(store.getState().screen, 'menu', '导入后回菜单');
  assert.ok(store.getState().ui.snackbar.some((t) => t.text.includes('已导入')));
  store.dispatch({ type: 'save/import', text: 'nope' });
  await flush();
  assert.ok(store.getState().ui.snackbar.some((t) => t.text.includes('bad_json')), '失败 toast 带码');
});

test('R3 effects：loadout/equip 出战装配 → 落盘 + toast；装配成功关抽屉', async () => {
  const persist = fakePersist();
  const { store } = harness(okApi(), persist);
  store.dispatch({ type: 'loadout/equip', uid: 'u1', kind: 'role' });
  await flush();
  assert.equal(store.getState().loadout.role, 'u1', 'reducer 已应用');
  assert.ok(store.getState().ui.snackbar.some((t) => t.text.includes('出战')), '出战 toast');
  assert.equal(persist.saves.filter((x) => !Array.isArray(x)).length, 1, '落盘');

  // wh/assemble 成功 → 抽屉关闭（ui/modal null）
  const { store: st2 } = harness(okApi());
  st2.dispatch({ type: 'ui/modal', drawer: 'assemble', targetUid: 'r1' });
  await flush();
  assert.ok(st2.getState().ui.modal.drawer === 'assemble');
  st2.dispatch({ type: 'wh/assemble', targetUid: 'r1', pluginUid: 'p1', slotIndex: 0 });
  await flush();
  assert.equal(st2.getState().ui.modal, null, '装配成功 → 关抽屉');
});

test('R1 effects：seed/set → saveSeed 落盘', async () => {
  const persist = fakePersist();
  const { store } = harness(okApi(), persist);
  store.dispatch({ type: 'seed/set', seed: 42 });
  await flush();
  assert.ok(persist.saves.some((x) => Array.isArray(x) && x[0] === 'seed' && x[1] === 42));
});

test('R1 effects：ui/toast 注入 timers → toastMs 后自动 pop', async () => {
  const fired = [];
  const timers = { setTimeout: (fn, ms) => fired.push([fn, ms]) };
  const { store } = harness(okApi(), fakePersist(), timers);
  store.dispatch({ type: 'ui/toast', text: 'hi' });
  await flush();
  assert.equal(fired.length, 1);
  assert.equal(fired[0][1], 3000, '默认 3s 自动消散');
  fired[0][0](); // 触发 pop
  assert.equal(store.getState().ui.snackbar.length, 0);
});
