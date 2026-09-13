'use strict';
// F3 gacha 视图测试 —— frontend-spec §6.4（中心面板/段位 radio/次数快选/结果 grid/空态/忙态）+ reducer wh/select·wh/tab
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mkState = (patch) => Object.assign({
  screen: 'gacha', tier: 'rare', seed: 5,
  meta: { serverOk: true }, loadout: { role: null, skills: [] },
  gacha: { opening: false, lastResult: null },
  ui: { busy: false, snackbar: [], modal: null, activeTab: {} },
  warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
}, patch || {});

test('gachaLayout：中心面板 center(480,300)=400,210 + 段位 5 档 + 次数快选 + 开箱按钮', async () => {
  const { gachaLayout, TIERS, TIMES_OPTIONS } = await import('../../public/js/views/gacha.js');
  assert.deepEqual(TIERS, ['common', 'rare', 'epic', 'legendary', 'mythic']);
  assert.deepEqual(TIMES_OPTIONS, [1, 5, 10]);
  const boxes = gachaLayout(mkState());
  const panel = boxes.find((b) => b.id === 'gacha_panel');
  assert.deepEqual([panel.x, panel.y, panel.w, panel.h], [400, 210, 480, 300], 'center(480,300)');
  const radios = boxes.filter((b) => b.kind === 'radio');
  assert.equal(radios.length, 5);
  assert.equal(radios.find((b) => b.id === 'gacha_tier_rare').style, 'on', '当前段位高亮');
  for (const r of radios) assert.deepEqual(r.payload, { tier: r.id.slice(11) }, 'radio 载荷（id gacha_tier_ 前缀 11 字符）');
  const go = boxes.find((b) => b.id === 'gacha_go');
  assert.deepEqual(go.payload, { times: 1 });
  assert.equal(boxes.find((b) => b.id === 'gacha_times_10').text, '×10');
  // 空结果提示
  assert.ok(boxes.find((b) => b.id === 'gacha_empty'), '空态提示');
});

test('gachaLayout：结果 grid(96,420,6,168,108,16) 坐标/品质色条/名 kind + 忙态禁用', async () => {
  const { gachaLayout } = await import('../../public/js/views/gacha.js');
  const items = [
    { uid: 'a', kind: 'role', name: '均衡', quality: 'rare' },
    { uid: 'b', kind: 'skill', templateId: 'skill_x', quality: 'epic' },
    { uid: 'c', kind: 'skillPlugin', quality: 'common' },
  ];
  const st = mkState({ gacha: { opening: false, lastResult: { items, seed: 9 } } });
  const boxes = gachaLayout(st);
  const cards = boxes.filter((b) => b.kind === 'gridcell');
  assert.equal(cards.length, 3);
  assert.deepEqual([cards[0].x, cards[0].y], [96, 420], '首卡原点');
  assert.deepEqual([cards[1].x, cards[1].y], [96 + 168 + 16, 420], '步进 184');
  assert.equal(cards[0].style, 'q-rare');
  assert.equal(cards[1].style, 'q-epic');
  assert.equal(cards[0].text, '均衡');
  assert.equal(cards[1].text, 'skill_x');
  assert.equal(cards[2].detail, 'skillPlugin');
  // 忙态：按钮禁用 + 标题变化
  const busy = gachaLayout(mkState({ gacha: { opening: true, lastResult: null } }));
  assert.equal(busy.find((b) => b.id === 'gacha_go').disabled, true);
  assert.equal(busy.find((b) => b.id === 'gacha_go').text, '开箱中…');
  assert.equal(busy.find((b) => b.id === 'gacha_panel').text, '开箱中…');
});

test('reducer：wh/tab 切桶 + wh/select 选中（F3 状态）', async () => {
  const { reducer, initialState } = await import('../../public/js/store/reducer.js');
  const s0 = initialState();
  const s1 = reducer(s0, { type: 'wh/tab', payload: { key: 'skill' } });
  assert.equal(s1.ui.activeTab.warehouse, 'skill');
  const s2 = reducer(s1, { type: 'wh/select', payload: { uid: 'u9' } });
  assert.equal(s2.ui.selected, 'u9');
  assert.equal(s2.ui.activeTab.warehouse, 'skill', 'select 不清 tab');
  const s3 = reducer(s2, { type: 'wh/tab', payload: { key: 'rolePlugin' } });
  assert.equal(s3.ui.selected, 'u9', 'tab 不清 select（跨桶选中由视图按当前桶查找兜底）');
  const s4 = reducer(s0, { type: 'wh/select', payload: { uid: 'x' } });
  assert.deepEqual(s4.ui.activeTab, {}, 'select 不建 tab');
});

test('gachaLayout：verifyLayout 全绿（结果 grid 2 行 / 忙态 / 空态）', async () => {
  const { gachaLayout } = await import('../../public/js/views/gacha.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  // 10 件 = 6+4 两行：行 2 y=544..652 不越 720；grid 右缘 1184 不越 1280
  const items = Array.from({ length: 10 }, (_, i) => ({ uid: `a${i}`, kind: 'role', name: `n${i}`, quality: 'rare' }));
  const st = { screen: 'gacha', tier: 'rare', gacha: { opening: false, lastResult: { items, seed: 1 } }, ui: { busy: false, snackbar: [], modal: null, activeTab: {} }, warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } };
  const boxes = gachaLayout(st);
  const cards = boxes.filter((b) => b.kind === 'gridcell');
  assert.equal(cards.length, 10);
  assert.deepEqual([cards[6].x, cards[6].y], [96, 544], '第二行（6 列步进 184）');
  assert.deepEqual(verifyLayout(boxes).issues, [], '10 件两行无 clip/overlap/zconflict');
  assert.deepEqual(verifyLayout(gachaLayout({ ...st, gacha: { opening: true, lastResult: null } })).issues, [], '忙态全绿');
  assert.deepEqual(verifyLayout(gachaLayout({ ...st, gacha: { opening: false, lastResult: null } })).issues, [], '空态全绿');
});

test('effects：wh/take 复用拆卸链（ok 替换 + err toast）', async () => {
  const { runEffect, EFFECTS } = await import('../../public/js/store/effects.js');
  assert.equal(EFFECTS['wh/take'], EFFECTS['wh/disassemble'], '同一实现');
  const actions = [];
  const ctx = {
    api: { post: async (p, body) => (p === '/warehouse/disassemble'
      ? { ok: true, data: { warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } } }
      : { ok: false }) },
    store: () => ({ warehouse: { buckets: {} } }),
    dispatch: (a) => actions.push(a),
    log: null, save: null,
  };
  await runEffect(ctx, { type: 'wh/take', payload: { targetUid: 'r', slotIndex: 0 } });
  assert.ok(actions.some((a) => a.type === 'wh/replaced'));
  assert.ok(actions.some((a) => a.type === 'store/save'));
});