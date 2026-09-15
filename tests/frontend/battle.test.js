'use strict';
// P6 R4 battle 配置屏契约测试 —— spec §6.5 + docs/screens.md battle 表逐行一致 + 起战链
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let battle, rm, em, sm;
before(async () => {
  battle = await import('../../public/js/views/battle.js');
  rm = await import('../../public/js/store/reducer.js');
  em = await import('../../public/js/store/effects.js');
  sm = await import('../../public/js/store/index.js');
});

function st(patch) {
  let s = rm.reducer(undefined, { type: '@@init' });
  for (const [type, payload] of patch || []) s = rm.reducer(s, { type, ...payload });
  return s;
}

function boxAt(boxes, id) {
  return boxes.find((b) => b.id === id);
}

const ROLE = { uid: 'r1', kind: 'role', templateId: 'role_bal', name: '守护者', quality: 'common', slots: [], stats: { hp: 150, atk: 22, def: 10, mp: 40, sp: 60 }, regen: { mp: 1, sp: 2 } };
const SK1 = { uid: 's1', kind: 'skill', templateId: 'skill_melee_whirl', name: '旋风', quality: 'common', slots: [], params: { multiplier: 1, cost: { mp: 10, sp: 0 }, cooldown: 3 } };
const SK2 = { uid: 's2', kind: 'skill', templateId: 'skill_straight_precise', name: '精准', quality: 'common', slots: [], params: { multiplier: 2, cost: { mp: 14, sp: 0 }, cooldown: 4 } };
const WH = { buckets: { role: [ROLE], skill: [SK1, SK2], rolePlugin: [], skillPlugin: [] } };

test('R4 battle：screens.md 表逐行坐标一致（默认 kiter / 无面板）', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const s = st([['goto', {}]]);
  const boxes = battle.battleLayout(s);
  const want = [
    ['config', 16, 80, 640, 400, 2],
    ['sel_opp', 40, 120, 600, 40, 3],
    ['loadoutSum', 40, 176, 600, 120, 3],
    ['fld_seed', 40, 312, 280, 40, 3],
    ['btn_seed', 336, 312, 120, 40, 3],
    ['preview', 680, 80, 584, 400, 2],
    ['stats', 704, 140, 536, 240, 3],
    ['btn_start', 560, 500, 160, 40, 4],
  ];
  for (const [id, x, y, w, h, z] of want) {
    const b = boxAt(boxes, id);
    assert.ok(b, `${id} 应存在`);
    assert.deepEqual({ id, x: b.x, y: b.y, w: b.w, h: b.h, z: b.z }, { id, x, y, w, h, z }, `${id} 坐标`);
  }
  assert.ok(boxAt(boxes, 'sel_opp').text.includes('kiter'), '默认对手 kiter');
  assert.deepEqual(boxAt(boxes, 'sel_opp').payload, { id: 'charger' }, '点击循环切换');
  assert.ok(boxAt(boxes, 'loadoutSum').text.includes('未配置出战'), '空 loadout 提示');
  assert.ok(boxAt(boxes, 'stats_none'), '无面板 → 预览提示');
  assert.equal(boxAt(boxes, 'stats_body'), undefined);
  assert.deepEqual(verifyLayout(boxes), [], 'battle 布局应无 issue');
});

test('R4 battle：对手三模板切换 + loadout 摘要 + 面板预览 + verify 全绿', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  assert.deepEqual(battle.OPPONENTS.map((o) => o.id), ['kiter', 'charger', 'cautious']);
  for (const o of battle.OPPONENTS) {
    const ld = o.loadout;
    assert.ok(ld.role.kind === 'role' && ld.skills.length === 3 && ld.ai && ld.ai.body.statements[0].type === 'action', `${o.id} 模板形状`);
    assert.ok(ld.skills.every((s) => ['skill_melee_whirl', 'skill_straight_precise'].includes(s.templateId)), `${o.id} 技能 id 与后端数据表同步`);
  }
  assert.deepEqual(battle.opponentOf('nope').id, 'kiter', '未知 key 回退默认');

  const s = st([['goto', {}], ['battle/opp', { id: 'charger' }], ['loadout/equip', { uid: 'r1', kind: 'role' }], ['loadout/equip', { uid: 's1', kind: 'skill' }], ['loadout/equip', { uid: 's2', kind: 'skill' }]]);
  const full = { ...s, warehouse: WH };
  const boxes = battle.battleLayout({ ...full, panel: { role: ROLE, skills: [SK1, SK2] } });
  assert.ok(boxAt(boxes, 'sel_opp').text.includes('charger'));
  assert.ok(boxAt(boxes, 'loadoutSum').text.includes('守护者') && boxAt(boxes, 'loadoutSum').text.includes('旋风'), 'loadout 摘要解析');
  assert.ok(boxAt(boxes, 'stats_body').text.includes('hp 150'), 'panel 正文');
  assert.deepEqual(verifyLayout(boxes), [], '满配 battle 布局全绿');

  // seed 文案与随机按钮
  const boxes2 = battle.battleLayout({ ...full, seed: 42 });
  assert.equal(boxAt(boxes2, 'fld_seed').value, '42');
  assert.equal(boxAt(boxes2, 'btn_seed').action, 'seed/random');
});

test('R4 reducer：battle/opp + battle/run busy 流', () => {
  let s = st([['battle/opp', { id: 'cautious' }]]);
  assert.equal(s.ui.activeTab.battle, 'cautious');
  s = st([['battle/opp']]);
  assert.equal(s.ui.activeTab.battle, 'kiter', '缺参回默认');
  s = st([['battle/run']]);
  assert.equal(s.battle.running, true);
  assert.equal(s.ui.busy, true);
});

test('R4 effects：battle/run 全链（成功 → frames+goto replay / 失败 → toast+busy 复原）', async () => {
  const calls = [];
  const api = {
    battle: async (b) => {
      calls.push(b);
      return { ok: true, data: { id: 'rp1', seed: 77, tier: 'common', winner: 'p1', phase: 'base', ticks: 18, frames: [{ tick: 1, diff: { players: [] } }, { tick: 2, diff: { players: [] } }] } };
    },
    unlock: async () => ({ ok: true, data: {} }),
    health: async () => ({ ok: true, data: { version: '1' } }),
  };
  const persist = { save: () => {}, saveLogPrefs: () => {}, saveSeed: () => {}, exportState: () => '{}', parseImport: () => ({ ok: false, code: 'x' }) };
  const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, setLevel: () => {}, setChannelLevel: () => {} };
  const store = sm.createStore({ reducer: rm.reducer, effects: em.effects(), persist, api, log, timers: null, initialPatch: { warehouse: WH } });
  store.dispatch({ type: 'loadout/equip', uid: 'r1', kind: 'role' });
  store.dispatch({ type: 'loadout/equip', uid: 's1', kind: 'skill' });
  store.dispatch({ type: 'loadout/equip', uid: 's2', kind: 'skill' });
  store.dispatch({ type: 'battle/opp', id: 'kiter' });
  store.dispatch({ type: 'battle/run' });
  await new Promise((r) => setTimeout(r, 10));
  const b = calls[0];
  assert.equal(b.p1.role.uid, 'r1', 'p1 角色解析为物品');
  assert.deepEqual(b.p1.skills.map((x) => x && x.uid), ['s1', 's2', null], 'p1 技能解析（含空槽）');
  assert.equal(b.p2.id, undefined, 'p2 = 对手模板 loadout');
  assert.ok(b.p2.role.uid === 'opp_role');
  assert.equal(b.warehouse.buckets.role.length, 1, '仓库原样携带（含 r1）');
  const s = store.getState();
  assert.equal(s.screen, 'replay', '起战成功 → goto replay');
  assert.equal(s.battle.frames.length, 2);
  assert.deepEqual(s.battle.result, { winner: 'p1', phase: 'base', ticks: 18 });
  assert.equal(s.battle.config.id, 'rp1');
  assert.equal(s.ui.busy, false, 'busy 复原');
  assert.equal(s.battle.playing, false);

  // 失败路径
  const api2 = { battle: async () => ({ ok: false, code: 'loadout_invalid', message: '不合法', details: ['role 缺失'] }), unlock: async () => ({ ok: true, data: {} }), health: async () => ({ ok: true, data: {} }) };
  const store2 = sm.createStore({ reducer: rm.reducer, effects: em.effects(), persist, api: api2, log, timers: null });
  store2.dispatch({ type: 'battle/run' });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(store2.getState().ui.busy, false, '失败 busy 复原');
  assert.ok(store2.getState().ui.snackbar.some((t) => t.text.includes('loadout_invalid')));
  assert.equal(store2.getState().screen, 'menu', '失败不切屏');
});

test('R4 effects：seed/random → seed/set（effect 层 Date.now 注入）', async () => {
  const store = sm.createStore({ reducer: rm.reducer, effects: em.effects(), persist: { save: () => {} }, api: { unlock: async () => ({ ok: true, data: {} }), health: async () => ({ ok: true, data: {} }) }, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }, timers: null });
  store.dispatch({ type: 'seed/random' });
  await new Promise((r) => setTimeout(r, 5));
  const seed = store.getState().seed;
  assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 1e9, 'seed 落 [0,1e9)');
});

test('R4 battle：busy 态死控件防护（running → 无 action + 文案）', () => {
  const s = st([['battle/run']]);
  const boxes = battle.battleLayout(s);
  assert.equal(boxAt(boxes, 'btn_start').action, null);
  assert.equal(boxAt(boxes, 'btn_start').disabled, true);
  assert.ok(boxAt(boxes, 'btn_start').text.includes('运行中'));
  assert.equal(boxAt(boxes, 'sel_opp').action, null, '运行中锁定对手切换');
});

test('R4 battle：分支锤 —— loadout 缺角色/悬空 uid/special 非空/技能无 name', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  // 有技能无角色 → 「角色：未选」
  const s = { ...st([['goto', {}], ['loadout/equip', { uid: 's1', kind: 'skill' }]]), warehouse: WH };
  let boxes = battle.battleLayout(s);
  assert.ok(boxAt(boxes, 'loadoutSum').text.includes('角色：未选'), '无角色臂');
  // 悬空 uid → 直接显示 uid
  const sHang = { ...s, loadout: { role: 'ghost', skills: ['zz', null, null], ai: null } };
  boxes = battle.battleLayout(sHang);
  assert.ok(boxAt(boxes, 'loadoutSum').text.includes('角色：ghost'), '悬空 uid 显示');
  // panel 特殊词条非空 + 技能无 name（回退 templateId）+ 技能项为 null（防御）
  const p = { role: { ...ROLE, special: { thorns: 1 } }, skills: [SK2, { uid: 's9', kind: 'skill', templateId: 'tp9' }, null] };
  boxes = battle.battleLayout({ ...s, panel: p });
  assert.ok(boxAt(boxes, 'stats_body').text.includes('thorns'), 'special 非空');
  assert.ok(boxAt(boxes, 'stats_body').text.includes('tp9'), '无名技能 → templateId');
  assert.deepEqual(verifyLayout(boxes), [], '分支锤布局全绿');
});

test('R4 battle：分支锤 2 —— skills 缺省/无 warehouse/panel 畸形档', async () => {
  // loadout 无 skills 字段 + warehouse null → whFind null 臂
  const s = { ...st([['goto', {}]]), warehouse: null, loadout: { role: 'r1' } };
  let boxes = battle.battleLayout(s);
  assert.ok(boxAt(boxes, 'loadoutSum').text.includes('角色：r1'), '无 buckets → uid 直显');
  // 有技能无角色（摘要 role 未选臂）
  const s2 = { ...s, warehouse: WH, loadout: { role: null, skills: ['s1', null, null], ai: null } };
  boxes = battle.battleLayout(s2);
  assert.ok(boxAt(boxes, 'loadoutSum').text.includes('角色：未选'), '无角色臂');
  // panel：role 无 name/stats/regen（回退臂）+ 无 skills 字段
  const p = { role: { uid: 'r', kind: 'role' }, skills: undefined };
  boxes = battle.battleLayout({ ...s, warehouse: WH, panel: p });
  assert.ok(boxAt(boxes, 'stats_body').text.includes('hp undefined'), '无 stats → undefined 文案不炸');
  assert.ok(boxAt(boxes, 'stats_body').text.includes('无'), 'special 空 → 无');
});

test('R4 battleHtml：输出可被 collectBoxes 解析', () => {
  const h = battle.battleHtml(st([['goto', {}]]));
  assert.ok(h.includes('data-box-id="btn_start"'));
});
