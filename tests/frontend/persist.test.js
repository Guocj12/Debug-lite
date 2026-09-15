'use strict';
// P6 R1 persist 契约测试 —— frontend-spec §8（往返/白名单/版本丢弃/logPrefs/seed/export/import）
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let createPersist, normWarehouse, normLoadout;
before(async () => {
  const pm = await import('../../public/js/store/persist.js');
  ({ createPersist, normWarehouse, normLoadout } = pm);
});

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

test('R1 persist：读档空/往返一致（keys 白名单）', () => {
  const st = memStorage();
  const p = createPersist({ storage: st });
  assert.deepEqual(p.load(), {});
  const state = { tier: 'rare', warehouse: { buckets: { role: [{ uid: 'u1' }], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: 'u1', skills: [null, null, null], ai: null }, gacha: { lastResult: [{ uid: 'z' }] } };
  p.save(state);
  // 节流：默认 timers 未注入 → 真 setTimeout；手动等 550ms 不可取 → 注入假 timers
  const timers = { setTimeout: (fn) => fn(), clearTimeout: () => {} };
  const p2 = createPersist({ storage: st, timers });
  p2.save(state);
  assert.ok(st.getItem('dl.v3.state').includes('"schemaVersion":1'));
  const loaded = p2.load();
  assert.equal(loaded.tier, 'rare');
  assert.deepEqual(loaded.warehouse, state.warehouse);
  assert.deepEqual(loaded.loadout, state.loadout);
  assert.deepEqual(loaded.gacha, { lastResult: [{ uid: 'z' }] });
  assert.equal(Object.prototype.hasOwnProperty.call(st.getItem('dl.v3.state').match(/\{.+\}/) ? JSON.parse(st.getItem('dl.v3.state')) : {}, 'schemaVersion'), true);
});

test('R1 persist：节流 500ms（同 tick 多次 save 只写一次）', () => {
  const st = memStorage();
  const pending = [];
  const timers = { setTimeout: (fn, ms) => pending.push([fn, ms]), clearTimeout: () => {} };
  const p = createPersist({ storage: st, timers });
  p.save({ tier: 'a', warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: {} });
  p.save({ tier: 'b', warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: 'x' } });
  assert.equal(pending.length, 1, '第二条应复用同一定时器');
  assert.equal(pending[0][1], 500, '节流间隔 500ms');
  pending[0][0]();
  assert.ok(st.getItem('dl.v3.state').includes('"tier":"b"'), '节流后写入最新值');
});

test('R1 persist：版本不符/坏 JSON/非对象 → 丢弃 + 无存储安全', () => {
  const st = memStorage();
  st.setItem('dl.v3.state', JSON.stringify({ schemaVersion: 2, tier: 'x' }));
  assert.deepEqual(createPersist({ storage: st }).load(), {});
  st.setItem('dl.v3.state', '{oops');
  assert.deepEqual(createPersist({ storage: st }).load(), {});
  st.setItem('dl.v3.state', 'null');
  assert.deepEqual(createPersist({ storage: st }).load(), {});
  assert.deepEqual(createPersist({ storage: null }).load(), {});
  assert.doesNotThrow(() => createPersist({ storage: null }).save({ tier: 'x' }));
});

test('R1 persist：lastResult 缺省不写入；logPrefs/seed 往返与 remove', () => {
  const st = memStorage();
  const timers = { setTimeout: (fn) => fn(), clearTimeout: () => {} };
  const p = createPersist({ storage: st, timers });
  p.save({ tier: 'a', warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: null } });
  const raw = JSON.parse(st.getItem('dl.v3.state'));
  assert.equal('lastResult' in raw, false, '无 lastResult 不写入');
  assert.equal('gacha' in raw, false);
  p.saveLogPrefs({ level: 'trace', channels: { ui: 'debug' } });
  assert.deepEqual(p.loadLogPrefs(), { level: 'trace', channels: { ui: 'debug' } });
  p.saveSeed(42);
  assert.equal(p.loadSeed(), 42);
  p.saveSeed(null);
  assert.equal(p.loadSeed(), null);
  st.setItem('dl.v3.logPrefs', '{bad');
  assert.deepEqual(p.loadLogPrefs(), {});
  st.setItem('dl.v3.seed', '{bad');
  assert.equal(p.loadSeed(), null);
});

test('R1 persist：normWarehouse/normLoadout（buckets/扁平/畸形归一）', () => {
  assert.deepEqual(normWarehouse({ buckets: { role: [1] } }), { buckets: { role: [1], skill: [], rolePlugin: [], skillPlugin: [] } });
  assert.deepEqual(normWarehouse({ roles: [2], skillPlugins: [3] }), { buckets: { role: [2], skill: [], rolePlugin: [], skillPlugin: [3] } });
  assert.deepEqual(normWarehouse(null).buckets, { role: [], skill: [], rolePlugin: [], skillPlugin: [] });
  assert.deepEqual(normWarehouse({ buckets: { role: 'x' } }).buckets.role, []);
  const lo = normLoadout({ role: 'r', skills: ['a', 'b', 'c'] });
  assert.deepEqual(lo, { role: 'r', skills: ['a', 'b', 'c'], ai: null });
  assert.deepEqual(normLoadout({ skills: ['a'] }).skills, ['a', null, null]);
  assert.deepEqual(normLoadout(null), { role: null, skills: [null, null, null], ai: null });
  assert.deepEqual(normLoadout({ ai: { program: 1 } }).ai, { program: 1 });
});

test('R1 persist：exportState/parseImport 全案（往返/坏版本/缺字段/坏 JSON）', () => {
  const st = memStorage();
  const p = createPersist({ storage: st });
  const state = { tier: 'epic', warehouse: { buckets: { role: [{ uid: 'u1', kind: 'role', templateId: 'guard' }], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: 'u1', skills: [null, null, null], ai: { program: { version: 2 } } }, gacha: { lastResult: null } };
  const text = p.exportState(state);
  const back = p.parseImport(text);
  assert.equal(back.ok, true);
  assert.equal(back.patch.tier, 'epic');
  assert.deepEqual(back.patch.warehouse, state.warehouse);
  assert.deepEqual(back.patch.loadout, state.loadout);
  assert.equal('lastResult' in back.patch, false, 'lastResult 为 null 不进 patch');
  assert.equal(p.parseImport('nope{').code, 'bad_json');
  assert.equal(p.parseImport('[]').code, 'bad_save');
  assert.equal(p.parseImport(JSON.stringify({ schemaVersion: 9 })).code, 'bad_version');
  assert.equal(p.parseImport(JSON.stringify({ schemaVersion: 1 })).code, 'bad_save', '缺 tier/warehouse/loadout');
  const ok = p.parseImport(p.exportState({ ...state, gacha: { lastResult: [{ uid: 'q' }] } }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.patch.lastResult, [{ uid: 'q' }]);
});
