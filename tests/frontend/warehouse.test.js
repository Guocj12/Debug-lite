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

test('warehouseLayout：buckets/grid/detail/points 容器 + 卡片 card<i> 坐标 + 详情（点数/槽位/候选/拆卸）', async () => {
  const { warehouseLayout } = await import('../../public/js/views/warehouse.js');
  const st = mkState({ ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r1' } });
  const boxes = warehouseLayout(st);
  // screens.md 容器四件（z2，父盒为 null；Tab/卡片/详情内容为容器内 z3）
  assert.deepEqual(['buckets', 'grid', 'detail', 'points'].map((id) => {
    const b = boxes.find((x) => x.id === id);
    return [b.x, b.y, b.w, b.h, b.z].join(',');
  }), ['16,80,168,500,2', '200,80,864,500,2', '1080,80,184,500,2', '16,592,1248,40,2']);
  assert.equal(boxes.filter((b) => b.kind === 'tab').length, 4);
  assert.equal(boxes.find((b) => b.id === 'wh_tab_role').style, 'on');
  assert.equal(boxes.find((b) => b.id === 'wh_tab_role').parent, 'buckets');
  const card = boxes.find((b) => b.id === 'card1');
  assert.deepEqual([card.x, card.y, card.w, card.h, card.z], [200, 80, 168, 108, 3], 'grid(200,80,4,168,108,16)');
  assert.deepEqual(card.payload, { uid: 'r1' });
  assert.equal(card.style, 'q-rare on', '品质色 + 选中态（style 多 token：dl-q-rare dl-on）');
  assert.equal(card.parent, 'grid');
  // 未选中卡只带品质色（两张同桶：r1 选中 / r2 未选中）
  const selState = mkState({
    warehouse: { buckets: { role: [{ uid: 'r1', kind: 'role', name: 'A', quality: 'rare', pluginPoints: 4, slots: [] }, { uid: 'r2', kind: 'role', name: 'B', quality: 'epic', pluginPoints: 4, slots: [] }], skill: [], rolePlugin: [], skillPlugin: [] } },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r1' },
  });
  const selBoxes = warehouseLayout(selState);
  assert.equal(selBoxes.find((b) => b.id === 'card1').style, 'q-rare on', '选中卡');
  assert.equal(selBoxes.find((b) => b.id === 'card2').style, 'q-epic', '未选中卡仅品质色');
  assert.deepEqual([selBoxes.find((b) => b.id === 'card2').x, selBoxes.find((b) => b.id === 'card2').y], [384, 80], '表 card2 行');
  const pts = boxes.find((b) => b.id === 'detail_pts');
  assert.equal(pts.text, '点数 0/4');
  assert.equal(pts.parent, 'detail');
  const putButtons = boxes.filter((b) => b.id && b.id.startsWith('wh_put_'));
  // F4 slot 预过滤语义：p1(slot atk) 仅 atk 槽；p3 无 slot 字段 → 双槽放行
  assert.equal(putButtons.length, 3, 'atk 槽 [p1,p3] + def 槽 [p3]（p2 已装备排除、p1 槽型不匹配 def）');
  const bySlot = (i) => putButtons.filter((b) => b.payload.slotIndex === i);
  assert.deepEqual(bySlot(0).map((b) => b.payload.pluginUid), ['p1', 'p3']);
  assert.deepEqual(bySlot(1).map((b) => b.payload.pluginUid), ['p3']);
  assert.deepEqual(putButtons[0].payload, { targetUid: 'r1', pluginUid: 'p1', slotIndex: 0 });
  assert.equal(putButtons[0].action, 'wh/assemble');
  // 装配点数条（表 points 行 + 内容）
  assert.equal(boxes.find((b) => b.id === 'points_text').text.includes('已用 0 / 上限 4'), true);
  assert.equal(boxes.find((b) => b.id === 'points_text').parent, 'points');
  // 空态：提示 + 去开箱（落在 grid 容器内 z3）
  const empty = mkState({ warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } });
  const eboxes = warehouseLayout(empty);
  assert.ok(eboxes.find((b) => b.id === 'wh_empty'));
  assert.equal(eboxes.find((b) => b.id === 'wh_goto_gacha').goto, 'gacha');
  assert.equal(eboxes.find((b) => b.id === 'wh_goto_gacha').parent, 'grid');
  assert.equal(eboxes.find((b) => b.id === 'points_text').text.includes('未选物品'), true);
  // 未选择态
  const noSel = warehouseLayout(mkState());
  assert.equal(noSel.find((b) => b.id === 'detail').text, '未选择');
});

test('itemsOf/itemByUid/equipInto：出战装配纯函数（角色就位 + 技能槽补齐/替换）', async () => {
  const { itemByUid, equipInto } = await import('../../public/js/views/warehouse.js');
  const st = mkState();
  assert.equal(itemByUid(st.warehouse, 'p1').uid, 'p1', '全桶查找（插件）');
  assert.equal(itemByUid(st.warehouse, 'nope'), null);
  assert.equal(itemByUid(null, 'x'), null, '无仓库安全');
  const role = st.warehouse.buckets.role[0];
  const skill = st.warehouse.buckets.skill[0];
  assert.equal(equipInto({ role: null, skills: [null, null, null] }, null, []), null, '无物品 → null');
  assert.equal(equipInto({}, st.warehouse.buckets.rolePlugin[0], []), null, '插件不走出战装配');
  // 角色就位：技能桶按序补齐空槽（缺省 loadout 三槽全空 + 桶内 1 技能 → 槽1 填，余 null）
  const withRole = equipInto({ role: null, skills: [null, null, null], ai: { p: 1 } }, role, [skill]);
  assert.equal(withRole.role.uid, 'r1');
  assert.deepEqual(withRole.skills.map((s) => (s ? s.uid : null)), ['s1', null, null]);
  assert.deepEqual(withRole.ai, { p: 1 }, 'ai 透传');
  // 无技能桶 → 三槽保持 null（不越界）
  const noPool = equipInto({ role: null, skills: [] }, role, []);
  assert.deepEqual(noPool.skills, [null, null, null], 'skills 归一为 3 槽');
  // 技能物品 → 首个空槽；全满 → 覆盖第 3 槽
  const s2 = { uid: 's2', kind: 'skill' };
  const s3 = { uid: 's3', kind: 'skill' };
  const s1 = { uid: 's1', kind: 'skill' };
  const fill = equipInto({ role, skills: [s1, null, null] }, s2, []);
  assert.deepEqual(fill.skills.map((x) => (x ? x.uid : null)), ['s1', 's2', null]);
  assert.equal(fill.role.uid, 'r1', '技能不覆盖角色');
  const overflow = equipInto({ role, skills: [s1, s2, s3] }, s2, []);
  assert.deepEqual(overflow.skills.map((x) => x.uid), ['s1', 's2', 's2'], '满槽 → 覆盖末槽');
  const noRole = equipInto({ skills: [] }, s3, []);
  assert.equal(noRole.role, null, '无角色时仅换技能');
});

test('effects: wh/equip → loadout/set + 落盘 + toast（角色/技能/失败臂）', async () => {
  const { runEffect } = await import('../../public/js/store/effects.js');
  const actions = [];
  const st = mkState();
  const ctx = {
    api: {}, store: () => st, dispatch: (a) => actions.push(a), log: null, save: null, doc: null,
  };
  await runEffect(ctx, { type: 'wh/equip', payload: { uid: 'r1' } });
  assert.equal(actions[0].type, 'loadout/set');
  assert.equal(actions[0].payload.loadout.role.uid, 'r1');
  assert.deepEqual(actions[0].payload.loadout.skills.map((s) => (s ? s.uid : null)), ['s1', null, null], '技能桶补齐');
  assert.ok(actions.some((a) => a.type === 'store/save'), '落盘');
  assert.equal(actions[2].payload.kind, 'ok');
  assert.ok(actions[2].payload.text.includes('均衡'));
  // 技能臂
  actions.length = 0;
  await runEffect(ctx, { type: 'wh/equip', payload: { uid: 's1' } });
  assert.equal(actions[0].payload.loadout.skills[0].uid, 's1');
  // 失败臂：uid 不存在 → bad_equip toast，不派发 loadout/set
  actions.length = 0;
  await runEffect(ctx, { type: 'wh/equip', payload: { uid: 'ghost' } });
  assert.equal(actions.some((a) => a.type === 'loadout/set'), false);
  assert.equal(actions[0].type, 'ui/toast');
  assert.equal(actions[0].payload.kind, 'danger');
  // 无 payload / 无 warehouse 安全
  actions.length = 0;
  await runEffect({ ...ctx, store: () => ({}) }, { type: 'wh/equip' });
  assert.equal(actions[0].payload.kind, 'danger');
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
  const slot = boxes.find((b) => b.id === 'detail_slot_0');
  assert.equal(slot.text, '槽1（atk）');
  assert.equal(slot.detail, '已装');
  assert.equal(slot.style, 'on');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  assert.deepEqual(verifyLayout(boxes).issues, [], '已装槽 + 空槽无重叠（F3 P1：take 按钮 h32 与下行步距曾 2px 相交）');
});

test('warehouseLayout 分支锤：无槽物品提示/长候选截断/无 warehouse 态/无 buckets 形状', async () => {
  const { warehouseLayout } = await import('../../public/js/views/warehouse.js');
  // 无槽物品 → （无插槽）
  const noSlots = mkState({
    warehouse: { buckets: { role: [{ uid: 'r0', kind: 'role', name: '裸', quality: 'common', pluginPoints: 3, slots: [] }], skill: [], rolePlugin: [], skillPlugin: [] } },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r0' },
  });
  assert.ok(warehouseLayout(noSlots).find((b) => b.id === 'detail_no_slots'), '无插槽提示');
  // 长候选 → sy 上限截断（不越界）
  const many = Array.from({ length: 12 }, (_, i) => ({ uid: `px${i}`, kind: 'rolePlugin', name: `p${i}`, quality: 'common', tier: 1, equipped: false }));
  const long = mkState({
    warehouse: { buckets: { role: [{ uid: 'r1', kind: 'role', name: '均衡', quality: 'common', pluginPoints: 3, slots: [{ type: 'atk', pluginUid: null }] }], skill: [], rolePlugin: many, skillPlugin: [] } },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r1' },
  });
  const lboxes = warehouseLayout(long);
  const puts = lboxes.filter((b) => b.action === 'wh/assemble');
  assert.ok(puts.length >= 1, '长候选仍渲染');
  assert.ok(puts.every((b) => b.y + b.h <= 564), '候选按钮不越 DETAIL_MAX_Y（564 = 容器底 580 − 16）');
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
  assert.equal(noUiBoxes.find((b) => b.id === 'detail').text, '未选择');
  // 无名/无品质物品（uid 兜底 + ? 兜底）
  const anon = mkState({
    warehouse: { buckets: { role: [{ uid: 'r9', kind: 'role', pluginPoints: 0, slots: [{ type: 'x', pluginUid: null }] }], skill: [], rolePlugin: [], skillPlugin: [] } },
    ui: { busy: false, snackbar: [], modal: null, activeTab: { warehouse: 'role' }, selected: 'r9' },
  });
  assert.equal(warehouseLayout(anon).find((b) => b.id === 'detail_name').text, 'r9（?）');
});

test('warehouseLayout F3 P1 回归：真实数据形状（后端 roleSlotRange 上限 4 槽 + 桶内 8 插件）不越详情容器且自检全绿', async () => {
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
  const inDetail = boxes.filter((b) => b.parent === 'detail');
  assert.ok(inDetail.every((b) => b.y + b.h <= 580), '详情容器内内容不越容器底（曾溢出至 672 / mythic 7 槽 → 720 clip）');
  assert.deepEqual(verifyLayout(boxes).issues, [], '真实形状全绿（曾 12 项 overlap）');
});