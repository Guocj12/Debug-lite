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

test('gachaLayout：panel_gacha(400,210,480,300)+sel_tier/fld_times/btn_open（screens.md gacha 表）', async () => {
  const { gachaLayout, TIERS, TIMES_MAX, nextIn } = await import('../../public/js/views/gacha.js');
  assert.deepEqual(TIERS, ['common', 'rare', 'epic', 'legendary', 'mythic']);
  assert.equal(TIMES_MAX, 10, '§6.4 次数 Field(1..10)');
  assert.equal(nextIn(TIERS, 'mythic'), 'common', '循环回绕');
  assert.equal(nextIn(TIERS, '未知'), 'common', '未命中 → 首项');
  const boxes = gachaLayout(mkState());
  const panel = boxes.find((b) => b.id === 'panel_gacha');
  assert.deepEqual([panel.x, panel.y, panel.w, panel.h, panel.z], [400, 210, 480, 300, 2], '表 panel_gacha 行');
  const sel = boxes.find((b) => b.id === 'sel_tier');
  assert.deepEqual([sel.x, sel.y, sel.w, sel.h, sel.z], [424, 250, 432, 40, 3], '表 sel_tier 行');
  assert.equal(sel.action, 'tier/set');
  assert.deepEqual(sel.payload, { tier: 'epic' }, '点击切下一档（rare → epic）');
  const fld = boxes.find((b) => b.id === 'fld_times');
  assert.deepEqual([fld.x, fld.y, fld.w, fld.h, fld.z], [424, 306, 432, 40, 3], '表 fld_times 行');
  assert.equal(fld.action, 'gacha/times');
  assert.deepEqual(fld.payload, { times: 2 }, '次数缺省 1 → 点击后 2');
  const open = boxes.find((b) => b.id === 'btn_open');
  assert.deepEqual([open.x, open.y, open.w, open.h, open.z, open.action], [560, 368, 160, 40, 4, 'box/open'], '表 btn_open 行');
  assert.deepEqual(open.payload, { times: 1 });
  // 次数到顶回绕 10 → 1
  const top = gachaLayout(mkState({ gacha: { opening: false, lastResult: null, times: 10 } }));
  assert.deepEqual(top.find((b) => b.id === 'fld_times').payload, { times: 1 });
  // 结果容器（表 results 行）+ 空态提示落在容器内
  const results = boxes.find((b) => b.id === 'results');
  assert.deepEqual([results.x, results.y, results.w, results.h, results.z], [96, 420, 1088, 240, 2], '表 results 行');
  assert.equal(boxes.find((b) => b.id === 'gacha_empty').parent, 'results');
});

test('gachaLayout：结果 res1.. 坐标（96+i*184,420,168,108）/品质色条/名 kind + 忙态禁用', async () => {
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
  assert.deepEqual(cards.map((b) => b.id), ['res1', 'res2', 'res3'], '表内 res<i> 位序 id');
  assert.deepEqual([cards[0].x, cards[0].y], [96, 420], '首卡原点（表 res1 行）');
  assert.deepEqual([cards[1].x, cards[1].y], [96 + 168 + 16, 420], '步进 184（表 res2 行 280）');
  assert.deepEqual([cards[0].w, cards[0].h, cards[0].z], [168, 108, 3]);
  assert.equal(cards[0].style, 'q-rare');
  assert.equal(cards[1].style, 'q-epic');
  assert.equal(cards[0].text, '均衡');
  assert.equal(cards[1].text, 'skill_x');
  assert.equal(cards[2].detail, 'skillPlugin');
  assert.equal(cards[0].parent, 'results');
  // 忙态：按钮禁用 + 标题变化
  const busy = gachaLayout(mkState({ gacha: { opening: true, lastResult: null } }));
  assert.equal(busy.find((b) => b.id === 'btn_open').disabled, true);
  assert.equal(busy.find((b) => b.id === 'btn_open').text, '开箱中…');
  assert.equal(busy.find((b) => b.id === 'panel_gacha').text, '开箱中…');
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

test('gachaLayout：verifyLayout 全绿（结果 6 列多行 / 忙态 / 空态）', async () => {
  const { gachaLayout, RESULT_COLS } = await import('../../public/js/views/gacha.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  // 6 列（容器 1088 = 6×168 + 5×16 精确铺满）；10 件 = 6+4 两行，行 2 y=544..652 落在 results(96,420,1088,240) 内
  assert.equal(RESULT_COLS, 6);
  const items = Array.from({ length: 10 }, (_, i) => ({ uid: `a${i}`, kind: 'role', name: `n${i}`, quality: 'rare' }));
  const st = { screen: 'gacha', tier: 'rare', gacha: { opening: false, lastResult: { items, seed: 1 } }, ui: { busy: false, snackbar: [], modal: null, activeTab: {} }, warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } };
  const boxes = gachaLayout(st);
  const cards = boxes.filter((b) => b.kind === 'gridcell');
  assert.equal(cards.length, 10);
  assert.deepEqual([cards[5].x, cards[5].y], [1016, 420], '首行末列右缘 1184（容器右缘 1184）');
  assert.deepEqual([cards[6].x, cards[6].y], [96, 544], '第二行首列');
  assert.ok(cards.every((b) => b.x + b.w <= 1184 && b.y + b.h <= 660), '卡片全在 results 容器内');
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