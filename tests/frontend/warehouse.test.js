'use strict';
// F3 warehouse 视图测试 —— frontend-spec §6.3（Tab/网格/详情/空态/候选插件过滤纯函数）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mkState = (patch) => Object.assign({
  screen: 'warehouse', tier: 'mythic', seed: null,
  meta: { serverOk: true }, loadout: { role: null, skills: [null, null, null] },
  gacha: { opening: false, lastResult: null },
  ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: null },
  warehouse: {
    buckets: {
      role: [{ uid: 'r1', kind: 'role', name: '均衡', quality: 'rare', pluginPoints: 4, slots: [{ type: 'atk', pluginUid: null }, { type: 'def', pluginUid: null }] }],
      skill: [{ uid: 's1', kind: 'skill', name: '平射', quality: 'rare', pluginPoints: 3, slots: [{ type: 'basic', pluginUid: null }] }],
      rolePlugin: [
        { uid: 'p1', kind: 'rolePlugin', name: 'atk_up', quality: 'rare', slot: 'atk', tier: 2, equipped: false },
        { uid: 'p2', kind: 'rolePlugin', name: 'def_up', quality: 'rare', slot: 'def', tier: 2, equipped: true },
        { uid: 'p3', kind: 'rolePlugin', name: 'sp_up', quality: 'legendary', tier: 3, equipped: false, unlockTier: 'legendary' },
      ],
      skillPlugin: [{ uid: 'q1', kind: 'skillPlugin', name: 'cost_down', quality: 'rare', tier: 1, equipped: false }],
    },
  },
}, patch || {});

test('BUCKETS/bucketOf/itemsOf：四类 Tab 与桶读取', async () => {
  const { BUCKETS, bucketOf, itemsOf } = await import('../../public/js/views/warehouse.js');
  assert.equal(BUCKETS.length, 4);
  assert.equal(bucketOf(0), 'role');
  assert.equal(bucketOf(3), 'skillPlugin');
  assert.equal(bucketOf(9), 'role', '越界回退第一桶');
  const st = mkState();
  assert.equal(itemsOf(st, 'role').length, 1);
  assert.equal(itemsOf(st, 'nope').length, 0);
});

test('candidatesFor：kind 匹配/已装备排除/段位门控/自排除', async () => {
  const { candidatesFor } = await import('../../public/js/views/warehouse.js');
  const st = mkState();
  const role = st.warehouse.buckets.role[0];
  const mythic = candidatesFor(role, st.warehouse, 'mythic');
  assert.deepEqual(mythic.map((p) => p.uid), ['p1', 'p3'], 'p2 已装备排除；p3 legendary 在 mythic 放行');
  const rare = candidatesFor(role, st.warehouse, 'rare');
  assert.deepEqual(rare.map((p) => p.uid), ['p1'], 'p3 被门控拦截');
  const skill = st.warehouse.buckets.skill[0];
  assert.deepEqual(candidatesFor(skill, st.warehouse, 'mythic').map((p) => p.uid), ['q1'], '技能目标 ← 技能插件');
  assert.deepEqual(candidatesFor(null, st.warehouse, 'mythic'), []);
  assert.deepEqual(candidatesFor({ kind: 'rolePlugin' }, st.warehouse, 'mythic'), [], '插件无候选');
});

test('warehouseLayout：Tab 四枚 + 网格卡坐标 + 详情（点数/槽位/候选按钮/拆卸）', async () => {
  const { warehouseLayout } = await import('../../public/js/views/warehouse.js');
  const st = mkState({ ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r1' } });
  const boxes = warehouseLayout(st);
  assert.equal(boxes.filter((b) => b.kind === 'tab').length, 4);
  assert.equal(boxes.find((b) => b.id === 'wh_tab_role').style, 'on');
  const card = boxes.find((b) => b.id === 'wh_card_r1');
  assert.deepEqual([card.x, card.y], [200, 80], 'grid(200,80,...)');
  assert.deepEqual(card.payload, { uid: 'r1' });
  assert.equal(card.style, 'q-rare');
  const detail = boxes.find((b) => b.id === 'wh_detail');
  assert.deepEqual([detail.x, detail.y, detail.w, detail.h], [1080, 80, 184, 500]);
  const pts = boxes.find((b) => b.id === 'wh_detail_pts');
  assert.equal(pts.text, '点数 0/4');
  const putButtons = boxes.filter((b) => b.id && b.id.startsWith('wh_put_'));
  // F4 slot 预过滤语义：p1(slot atk) 仅 atk 槽；p3 无 slot 字段 → 双槽放行
  assert.equal(putButtons.length, 3, 'atk 槽 [p1,p3] + def 槽 [p3]（p2 已装备排除、p1 槽型不匹配 def）');
  const bySlot = (i) => putButtons.filter((b) => b.payload.slotIndex === i);
  assert.deepEqual(bySlot(0).map((b) => b.payload.pluginUid), ['p1', 'p3']);
  assert.deepEqual(bySlot(1).map((b) => b.payload.pluginUid), ['p3']);
  assert.deepEqual(putButtons[0].payload, { targetUid: 'r1', pluginUid: 'p1', slotIndex: 0 });
  assert.equal(putButtons[0].action, 'wh/assemble');
  // 空态：提示 + 去开箱
  const empty = mkState({ warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } });
  const eboxes = warehouseLayout(empty);
  assert.ok(eboxes.find((b) => b.id === 'wh_empty'));
  assert.equal(eboxes.find((b) => b.id === 'wh_goto_gacha').goto, 'gacha');
  // 未选择态
  const noSel = warehouseLayout(mkState());
  assert.equal(noSel.find((b) => b.id === 'wh_detail').text, '未选择');
});

test('warehouseLayout：已装槽 → wh/take 拆卸按钮', async () => {
  const { warehouseLayout } = await import('../../public/js/views/warehouse.js');
  const st = mkState({
    warehouse: {
      buckets: {
        role: [{ uid: 'r1', kind: 'role', name: '均衡', quality: 'rare', pluginPoints: 4, slots: [{ type: 'atk', pluginUid: 'p1' }, { type: 'def', pluginUid: null }] }],
        skill: [], rolePlugin: [
          { uid: 'p1', kind: 'rolePlugin', name: 'atk_up', quality: 'rare', slot: 'atk', tier: 2, equipped: true },
          { uid: 'p2', kind: 'rolePlugin', name: 'def_up', quality: 'rare', slot: 'def', tier: 2, equipped: false },
        ],
        skillPlugin: [],
      },
    },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r1' },
  });
  const boxes = warehouseLayout(st);
  const taken = boxes.find((b) => b.action === 'wh/take');
  assert.ok(taken, '已装槽提供拆卸');
  assert.deepEqual(taken.payload, { targetUid: 'r1', slotIndex: 0 });
  const slotText = boxes.find((b) => b.id === 'wh_slot_0').text;
  assert.equal(slotText, '槽1(atk) 已装');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  assert.deepEqual(verifyLayout(boxes).issues, [], '已装槽 + 空槽无重叠（F3 P1：take 按钮 h32 与下行 30px 步距曾 2px 相交）');
});

test('warehouseLayout 分支锤：无槽物品提示/长候选截断/无 warehouse 态/无 buckets 形状', async () => {
  const { warehouseLayout } = await import('../../public/js/views/warehouse.js');
  // 无槽物品 → （无插槽）
  const noSlots = mkState({
    warehouse: { buckets: { role: [{ uid: 'r0', kind: 'role', name: '裸', quality: 'common', pluginPoints: 3, slots: [] }], skill: [], rolePlugin: [], skillPlugin: [] } },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r0' },
  });
  assert.ok(warehouseLayout(noSlots).find((b) => b.id === 'wh_no_slots'), '无插槽提示');
  // 长候选 → sy 上限截断（不越界）
  const many = Array.from({ length: 12 }, (_, i) => ({ uid: `px${i}`, kind: 'rolePlugin', name: `p${i}`, quality: 'common', tier: 1, equipped: false }));
  const long = mkState({
    warehouse: { buckets: { role: [{ uid: 'r1', kind: 'role', name: '均衡', quality: 'common', pluginPoints: 3, slots: [{ type: 'atk', pluginUid: null }] }], skill: [], rolePlugin: many, skillPlugin: [] } },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r1' },
  });
  const lboxes = warehouseLayout(long);
  const puts = lboxes.filter((b) => b.action === 'wh/assemble');
  assert.ok(puts.length >= 1, '长候选仍渲染');
  assert.ok(puts.every((b) => b.y + b.h <= 560), '候选按钮不越 DETAIL_MAX_Y（560；F3 P1 修复后锁死）');
  assert.deepEqual((await import('../../public/js/ui/verify.js')).verifyLayout(lboxes).issues, [], '长候选无重叠');
  // 无 warehouse / 无 buckets → itemsOf 兜底
  assert.equal(warehouseLayout(mkState({ warehouse: null })).find((b) => b.id === 'wh_empty').text.includes('去开箱'), true);
  const noBuckets = mkState(undefined);
  noBuckets.warehouse = { unexpected: true };
  assert.equal(warehouseLayout(noBuckets).filter((b) => b.kind === 'gridcell').length, 0, '无 buckets → 空网格');
  // 无 activeTab → 默认 role
  const noTab = mkState({ ui: { busy: false, snackbar: [], modal: null, activeTab: {}, selected: null } });
  assert.equal(warehouseLayout(noTab).find((b) => b.id === 'wh_tab_role').style, 'on');
  // state 无 ui 字段 → 默认 role + 无选中
  const noUi = mkState(undefined);
  delete noUi.ui;
  const noUiBoxes = warehouseLayout(noUi);
  assert.equal(noUiBoxes.find((b) => b.id === 'wh_tab_role').style, 'on');
  assert.equal(noUiBoxes.find((b) => b.id === 'wh_detail').text, '未选择');
  // 无名/无品质物品（uid 兜底 + ? 兜底）
  const anon = mkState({
    warehouse: { buckets: { role: [{ uid: 'r9', kind: 'role', pluginPoints: 0, slots: [{ type: 'x', pluginUid: null }] }], skill: [], rolePlugin: [], skillPlugin: [] } },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r9' },
  });
  assert.equal(warehouseLayout(anon).find((b) => b.id === 'wh_detail_name').text, 'r9（?）');
});

test('warehouseLayout F3 P1 回归：真实数据形状（后端 roleSlotRange 上限 4 槽 + 桶内 8 插件）不越详情面板且自检全绿', async () => {
  const { warehouseLayout } = await import('../../public/js/views/warehouse.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const slots = ['atk', 'def', 'hp', 'sp'].map((type) => ({ type, pluginUid: null }));
  const plugs = Array.from({ length: 8 }, (_, i) => ({
    uid: `p${i}`, kind: 'rolePlugin', id: 'x', name: `plug${i}`, desc: '',
    slot: ['atk', 'def', 'hp', 'sp', 'mp', 'special'][i % 6], category: 'stat',
    quality: 'rare', tier: 2, affixes: [], unlockTier: 'common', pointCost: 2,
  }));
  const st = mkState({
    warehouse: { buckets: { role: [{ uid: 'r1', kind: 'role', templateId: 't', name: 'R', quality: 'rare', slotCount: 4, slots, stats: {}, regen: {}, unlockTier: 'common', pluginPoints: 4 }], skill: [], rolePlugin: plugs, skillPlugin: [] } },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r1' },
  });
  const boxes = warehouseLayout(st);
  assert.ok(boxes.every((b) => b.y + b.h <= 580), '详情区内内容不越面板底（曾溢出至 672 / mythic 7 槽 → 720 clip）');
  assert.deepEqual(verifyLayout(boxes).issues, [], '真实形状全绿（曾 12 项 overlap）');
});