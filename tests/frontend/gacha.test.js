'use strict';
// P6 R3 gacha+warehouse 视图契约测试 —— spec §6.3/§6.4 + docs/screens.md 表逐行一致 + 自检全绿
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let gacha, wh, rm, layout;
before(async () => {
  gacha = await import('../../public/js/views/gacha.js');
  wh = await import('../../public/js/views/warehouse.js');
  rm = await import('../../public/js/store/reducer.js');
  layout = await import('../../public/js/ui/layout.js');
});

function st(patch) {
  let s = rm.reducer(undefined, { type: '@@init' });
  for (const [type, payload] of patch || []) s = rm.reducer(s, { type, ...payload });
  return s;
}

function boxAt(boxes, id) {
  return boxes.find((b) => b.id === id);
}

function wantBox(b, id, x, y, w, h, z) {
  assert.ok(b, `${id} 应存在`);
  assert.deepEqual({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, z: b.z }, { id, x, y, w, h, z }, `${id} 坐标`);
}

const ITEM_ROLE = { uid: 'u_role', kind: 'role', templateId: 'guard', name: '守护者', quality: 'rare', slots: [{ pluginUid: null }, { pluginUid: 'p_atk' }, { pluginUid: null }] };
const ITEM_SKILL = { uid: 'u_skill', kind: 'skill', templateId: 'bolt', name: '闪电', quality: 'common', slots: [] };
const PLUG_ATK = { uid: 'p_atk', kind: 'rolePlugin', templateId: 'p_atk', name: '利刃', quality: 'rare', slots: [] };
const PLUG_FREE = { uid: 'p_free', kind: 'rolePlugin', templateId: 'p_free', name: '坚硬', quality: 'common', slots: [] };
const PLUG_GATED = { uid: 'p_myth', kind: 'rolePlugin', templateId: 'p_myth', name: '神插件', quality: 'mythic', unlockTier: 'mythic', slots: [] };
const FILLERS = Array.from({ length: 4 }, (_, i) => ({ uid: `fill${i}`, kind: 'role', templateId: `f${i}`, name: `路人甲${i}`, quality: 'common', slots: [] }));

const WH = { buckets: { role: [ITEM_ROLE, ...FILLERS], skill: [ITEM_SKILL], rolePlugin: [PLUG_ATK, PLUG_FREE, PLUG_GATED], skillPlugin: [] } };

test('R3 gacha：screens.md 表逐行坐标一致（含 busy/结果卡片）', async () => {
  let s = st([['box/open']]);
  let boxes = gacha.gachaLayout(s);
  wantBox(boxAt(boxes, 'panel_gacha'), 'panel_gacha', 400, 210, 480, 300, 2);
  wantBox(boxAt(boxes, 'sel_tier'), 'sel_tier', 424, 250, 432, 40, 3);
  wantBox(boxAt(boxes, 'fld_times'), 'fld_times', 424, 306, 432, 40, 3);
  wantBox(boxAt(boxes, 'btn_open'), 'btn_open', 560, 368, 160, 40, 4);
  wantBox(boxAt(boxes, 'results'), 'results', 96, 420, 1088, 240, 2);
  assert.equal(boxAt(boxes, 'btn_open').disabled, true, 'busy → 开箱禁用');
  assert.equal(boxAt(boxes, 'btn_open').action, null, 'busy 无 action（死按钮防护）');
  assert.ok(boxAt(boxes, 'empty_hint'), '空态提示');

  // 结果态：12 卡片网格（screens.md res1..4: 96/280/464/648 × 420）
  const s2 = st([['box/open'], ['box/done', { resp: { items: Array.from({ length: 7 }, (_, i) => ({ uid: `x${i}`, kind: 'role', name: `R${i}`, quality: ['common', 'rare', 'epic', 'legendary', 'mythic'][i % 5] })) } }]]);
  boxes = gacha.gachaLayout(s2);
  assert.ok(boxAt(boxes, 'res1'), '结果卡存在');
  assert.deepEqual({ x: boxAt(boxes, 'res1').x, y: boxAt(boxes, 'res1').y, w: boxAt(boxes, 'res1').w, h: boxAt(boxes, 'res1').h }, { x: 96, y: 420, w: 168, h: 108 }, 'res1 与 screens.md 表一致');
  assert.deepEqual({ x: boxAt(boxes, 'res2').x, y: boxAt(boxes, 'res2').y }, { x: 280, y: 420 });
  assert.deepEqual({ x: boxAt(boxes, 'res3').x, y: boxAt(boxes, 'res3').y }, { x: 464, y: 420 });
  assert.deepEqual({ x: boxAt(boxes, 'res4').x, y: boxAt(boxes, 'res4').y }, { x: 648, y: 420 });
  assert.deepEqual({ x: boxAt(boxes, 'res7').x, y: boxAt(boxes, 'res7').y }, { x: 96, y: 544 }, '第二行');
});

test('R3 gacha：gachaHtml + 无名/无品质卡片臂', () => {
  const s = st([['box/done', { resp: { items: [{ uid: 'q1', kind: 'role', templateId: 'tp', quality: 'epic' }, { uid: 'q2', kind: 'role' }] } }]]);
  const h = gacha.gachaHtml(s);
  assert.ok(h.includes('data-box-id="res1"'), 'gachaHtml 输出');
  const boxes = gacha.gachaLayout(s);
  assert.equal(boxAt(boxes, 'res1').text, 'tp', '无名 → templateId');
  assert.equal(boxAt(boxes, 'res2').text, 'q2', '无 templateId → uid');
  assert.equal(boxAt(boxes, 'res2').q, 'common', '无品质 → common');
});

test('R3 gacha：verifyLayout 全绿（空/忙/结果 12 卡）', async () => {
  const cases = [
    st([]),
    st([['box/open']]),
    st([['box/done', { resp: { items: Array.from({ length: 12 }, (_, i) => ({ uid: `x${i}`, kind: 'role', name: `R${i}`, quality: 'common' })) } }]]),
  ];
  for (const s of cases) {
    const issues = layout.verifyLayout(gacha.gachaLayout(s));
    assert.deepEqual(issues, [], 'gacha 布局应无 issue');
  }
});

test('R3 gacha：次数钳制（reducer gacha/times 1..10）', () => {
  assert.equal(st([['gacha/times', { times: 5 }]]).gacha.times, 5);
  assert.equal(st([['gacha/times', { times: 0 }]]).gacha.times, 1);
  assert.equal(st([['gacha/times', { times: 99 }]]).gacha.times, 10);
  assert.equal(st([['gacha/times', { times: 'x' }]]).gacha.times, 1);
});

test('R3 warehouse：screens.md 表逐行坐标一致 + Tab/卡片/详情/点数', () => {
  const s = st([
    ['wh/tab', { bucket: 'role' }],
    ['wh/set', { warehouse: WH }],
    ['wh/select', { uid: 'u_role' }],
  ]);
  const boxes = wh.warehouseLayout(s);
  const want = [
    ['buckets', 16, 80, 168, 500, 2],
    ['grid', 200, 80, 864, 500, 2],
    ['detail', 1080, 80, 184, 500, 2],
    ['points', 16, 592, 1248, 40, 2],
  ];
  for (const [id, x, y, w, h, z] of want) wantBox(boxAt(boxes, id), id, x, y, w, h, z);
  assert.deepEqual({ x: boxAt(boxes, 'card1').x, y: boxAt(boxes, 'card1').y, w: boxAt(boxes, 'card1').w, h: boxAt(boxes, 'card1').h }, { x: 200, y: 80, w: 168, h: 108 }, 'card1=screens.md');
  assert.deepEqual({ x: boxAt(boxes, 'card2').x, y: boxAt(boxes, 'card2').y }, { x: 384, y: 80 });
  assert.deepEqual({ x: boxAt(boxes, 'card5').x, y: boxAt(boxes, 'card5').y }, { x: 200, y: 204 });
  // Tab：4 个（激活 ▶ + 数量）
  assert.equal(boxAt(boxes, 'tab_role').text, '▶ 角色(5)');
  assert.equal(boxAt(boxes, 'tab_role').action, 'wh/tab');
  // 详情：选中角色 → 名称/槽位/装配/出战/拆卸
  assert.ok(boxAt(boxes, 'det_name').text.includes('守护者'));
  assert.ok(boxAt(boxes, 'btn_equip').action === 'loadout/equip');
  assert.ok(boxAt(boxes, 'btn_assemble').action === 'ui/modal');
  assert.ok(boxAt(boxes, 'slot2').text.includes('p_atk') || boxAt(boxes, 'slot2').text.includes('槽2'));
  assert.ok(boxAt(boxes, 'take2'), '槽 2 已装 → 拆卸按钮');
  assert.ok(boxAt(boxes, 'slot1').text.includes('空'));
});

test('R3 warehouse：空桶态/截断提示/出战已装/verify 全绿', async () => {
  // 空桶
  const sEmpty = st([['wh/tab', { bucket: 'skillPlugin' }]]);
  let boxes = wh.warehouseLayout(sEmpty);
  assert.ok(boxAt(boxes, 'grid_empty'), '空态提示');
  assert.equal(boxAt(boxes, 'btn_togacha').action, 'goto');
  assert.ok(boxAt(boxes, 'det_none'), '无选中详情');
  assert.deepEqual(layout.verifyLayout(boxes), [], '空态布局全绿');

  // 出战后 btn_equip disabled
  const sEquipped = st([
    ['wh/select', { uid: 'u_role' }],
    ['loadout/equip', { uid: 'u_role', kind: 'role' }],
  ]);
  boxes = wh.warehouseLayout({ ...sEmpty, warehouse: WH, ui: { ...sEmpty.ui, selected: { warehouse: 'u_role' } } });
  assert.equal(boxAt(boxes, 'btn_equip').action, 'loadout/equip');

  // 满仓截断（17 件）
  const big = { buckets: { role: Array.from({ length: 17 }, (_, i) => ({ uid: `u${i}`, kind: 'role', templateId: 'g', name: `g${i}`, quality: 'common', slots: [] })), skill: [], rolePlugin: [], skillPlugin: [] } };
  const sMore = { ...sEmpty, warehouse: big, ui: { activeTab: { warehouse: 'role' }, selected: {} } };
  boxes = wh.warehouseLayout(sMore);
  assert.equal(boxAt(boxes, 'card16') !== undefined, true, '16 卡封顶');
  assert.equal(boxAt(boxes, 'card17'), undefined);
  assert.ok(boxAt(boxes, 'grid_more').text.includes('17'), '截断提示');
  assert.deepEqual(layout.verifyLayout(boxes), [], '满仓布局全绿');

  // 完整态（含选中详情）
  const sFull = st([['wh/tab', { bucket: 'role' }], ['wh/select', { uid: 'u_role' }]]);
  boxes = wh.warehouseLayout({ ...sFull, warehouse: WH });
  assert.deepEqual(layout.verifyLayout(boxes), [], '选中态布局全绿');
});

test('R3 warehouse：候选预过滤 candidatesFor（kind/已装/门控）', () => {
  const s = st([['wh/tab', { bucket: 'role' }], ['wh/select', { uid: 'u_role' }]]);
  const target = wh.itemByUid({ ...s, warehouse: WH }, 'u_role').item;
  const cands = wh.candidatesFor({ ...s, warehouse: WH }, target, 0);
  assert.deepEqual(cands.map((c) => c.uid), ['p_free'], '已装(p_atk)与段位不足(p_myth)候选被滤除');
  const cands2 = wh.candidatesFor({ ...s, warehouse: WH, tier: 'mythic' }, target, 0);
  assert.deepEqual(cands2.map((c) => c.uid), ['p_free', 'p_myth'], 'mythic 段位 → 门控插件可用');
});

test('R3 warehouse：装配抽屉（Modal 480/槽位行+候选行不重叠 + 关闭）', async () => {
  const s = st([
    ['wh/tab', { bucket: 'role' }],
    ['wh/select', { uid: 'u_role' }],
    ['ui/modal', { drawer: 'assemble', targetUid: 'u_role' }],
  ]);
  const full = { ...s, warehouse: WH };
  const boxes = wh.assembleDrawerLayout(full);
  assert.ok(boxAt(boxes, 'mask') && boxAt(boxes, 'mask').z === 90, '遮罩 z90');
  const drawer = boxAt(boxes, 'drawer');
  assert.deepEqual({ x: drawer.x, y: drawer.y, w: drawer.w, h: drawer.h, z: drawer.z }, { x: 400, y: 180, w: 480, h: 360, z: 91 }, 'Modal 480 宽（spec §3.2）');
  assert.ok(boxAt(boxes, 'drawer_cand_0_0').action === 'wh/assemble');
  assert.deepEqual(boxAt(boxes, 'drawer_cand_0_0').payload, { targetUid: 'u_role', pluginUid: 'p_free', slotIndex: 0 });
  assert.equal(boxAt(boxes, 'drawer_close').action, 'ui/modal');
  assert.deepEqual(layout.verifyLayout(boxes), [], '抽屉布局全绿');
  // 无 modal → 空抽屉
  assert.deepEqual(wh.assembleDrawerLayout(st([['wh/select', { uid: 'u_role' }]])), []);
});

test('R3 warehouse：分支锤 —— 无名/无品质物品/未命中详情/抽屉未知目标/无槽目标', () => {
  // 无 name/quality 物品 → 逐级回退文案与 common 色条
  const weird = { buckets: { role: [{ uid: 'w1', kind: 'role' }], skill: [], rolePlugin: [], skillPlugin: [] } };
  const sW = { ...st([['wh/tab', { bucket: 'role' }], ['wh/select', { uid: 'w1' }]]), warehouse: weird };
  let boxes = wh.warehouseLayout(sW);
  assert.equal(boxAt(boxes, 'card1').text, 'w1', '无名 → uid');
  assert.equal(boxAt(boxes, 'card1').q, 'common', '无品质 → common');
  assert.equal(boxAt(boxes, 'det_name').text, 'w1（role）', '无名详情');
  // 抽屉：目标不存在 / 目标无槽位
  const sModal = st([['ui/modal', { drawer: 'assemble', targetUid: 'nope' }]]);
  assert.deepEqual(wh.assembleDrawerLayout({ ...sModal, warehouse: weird }), [], '未知 targetUid → 空抽屉');
  const noSlots = { buckets: { role: [{ uid: 'w1', kind: 'role' }], skill: [], rolePlugin: [], skillPlugin: [] } };
  assert.deepEqual(wh.assembleDrawerLayout({ ...sModal, warehouse: noSlots, ui: { ...sModal.ui, modal: { drawer: 'assemble', targetUid: 'w1' } } }), [], '无槽位目标 → 空抽屉');
  // itemByUid 全桶扫描未命中 / 空仓库
  assert.equal(wh.itemByUid({ ...st([]), warehouse: weird }, 'zzz'), null);
  assert.equal(wh.itemByUid(st([]), 'x'), null, '无 buckets → null');
  assert.deepEqual(wh.itemsOf({ ...st([]) }, 'role'), [], '缺 buckets → 空表');
  assert.deepEqual(wh.candidatesFor({ ...st([]), warehouse: null }, { kind: 'role' }, 0), [], '无 warehouse → 无候选');
  // 插件类物品详情：无出战/装配按钮（kind 插件）
  const sPlug = { ...st([['wh/tab', { bucket: 'skillPlugin' }], ['wh/select', { uid: 'p_free' }]]), warehouse: WH };
  boxes = wh.warehouseLayout(sPlug);
  assert.equal(boxAt(boxes, 'btn_equip'), undefined, '插件无出战按钮');
  assert.equal(boxAt(boxes, 'btn_assemble'), undefined, '插件无装配按钮');
  assert.deepEqual(layout.verifyLayout(boxes), [], '插件详情布局全绿');
});

test('R3 reducer：loadout/equip 出战装配（角色/技能补空槽/替换槽 0）', () => {
  let s = st([['loadout/equip', { uid: 'u_role', kind: 'role' }]]);
  assert.equal(s.loadout.role, 'u_role');
  s = st([['loadout/equip', { uid: 's1', kind: 'skill' }], ['loadout/equip', { uid: 's2', kind: 'skill' }], ['loadout/equip', { uid: 's3', kind: 'skill' }]]);
  assert.deepEqual(s.loadout.skills, ['s1', 's2', 's3']);
  s = st([['loadout/equip', { uid: 's4', kind: 'skill' }]]);
  assert.deepEqual(s.loadout.skills, ['s4', null, null], '无空槽 → 替换槽 0');
});

test('R3 warehouse：分支锤 2 —— warehouse null / 模板名回退 / 技能详情 / 空槽位哨兵', () => {
  // warehouse null → 全桶读取兜底 + 点数条 0
  const sNull = { ...st([['save/set', { warehouse: null }], ['goto', {}]]), screen: 'warehouse' };
  sNull.ui.selected.warehouse = null;
  let boxes = wh.warehouseLayout(sNull);
  assert.ok(boxAt(boxes, 'points_lit').text.includes('已装插件 0'), '无仓库 → 点数 0');
  assert.deepEqual(layout.verifyLayout(boxes), [], '空仓布局全绿');
  assert.equal(wh.itemByUid({ ...sNull }, 'x'), null, '无 buckets 哨兵');
  assert.deepEqual(wh.itemsOf(sNull, 'skill'), [], 'itemsOf 哨兵');
  // 模板名回退臂（无 name 有 templateId）
  const sTp = { ...st([['wh/tab', { bucket: 'skill' }], ['wh/select', { uid: 'tp1' }]]), warehouse: { buckets: { role: [], skill: [{ uid: 'tp1', kind: 'skill', templateId: 'bolt2' }], rolePlugin: [], skillPlugin: [] } } };
  boxes = wh.warehouseLayout(sTp);
  assert.equal(boxAt(boxes, 'card1').text, 'bolt2', '无 name → templateId');
  assert.equal(boxAt(boxes, 'det_name').text, 'bolt2（skill）');
  assert.equal(boxAt(boxes, 'btn_equip').action, 'loadout/equip', '技能也可出战');
  // 技能选中：无槽位 → 无装配按钮（false 臂）+ skills.includes 装配臂
  const sEq = { ...sTp, loadout: { role: null, skills: ['tp1', null, null], ai: null } };
  boxes = wh.warehouseLayout(sEq);
  assert.equal(boxAt(boxes, 'btn_equip').action, null, '已出战 → 无 action');
  assert.equal(boxAt(boxes, 'btn_equip').disabled, true);
  // 空槽位哨兵（slots 含 null 项）在候选扫描中不炸
  const sSent = { ...st([['wh/tab', { bucket: 'rolePlugin' }]]), warehouse: { buckets: { role: [{ uid: 'r', kind: 'role', slots: [null] }], skill: [], rolePlugin: [{ uid: 'pf', kind: 'rolePlugin', slots: [null] }], skillPlugin: [] } } };
  const cands = wh.candidatesFor({ ...sSent, warehouse: sSent.warehouse }, { kind: 'role' }, 0);
  assert.deepEqual(cands.map((c) => c.uid), ['pf'], 'null 槽位哨兵跳过');
  // 抽屉：drawer≠assemble 臂 / 无名目标臂 / 无名候选臂
  const sWrong = st([['ui/modal', { drawer: 'other' }]]);
  assert.deepEqual(wh.assembleDrawerLayout({ ...sWrong, warehouse: WH }), [], '非装配抽屉 → 空');
  const sNameless = st([['ui/modal', { drawer: 'assemble', targetUid: 'tp9' }]]);
  const sNameDrawer = { ...sNameless, warehouse: { buckets: { role: [{ uid: 'tp9', kind: 'role', templateId: 'g9', slots: [{ pluginUid: null }] }], skill: [], rolePlugin: [{ uid: 'pg', kind: 'rolePlugin' }], skillPlugin: [] } } };
  const dBoxes = wh.assembleDrawerLayout(sNameDrawer);
  assert.ok(boxAt(dBoxes, 'drawer_title').text.includes('g9'), '无名目标 → templateId');
  assert.ok(boxAt(dBoxes, 'drawer_cand_0_0').text.includes('pg'), '无名候选 → uid');
});

test('R3 html：卡片 q 品质类注入', async () => {
  const s = st([['wh/tab', { bucket: 'role' }], ['wh/select', { uid: 'u_role' }]]);
  const h = wh.warehouseHtml({ ...s, warehouse: WH });
  assert.ok(h.includes('dl-q-rare'), '守护者 rare 色条');
});
