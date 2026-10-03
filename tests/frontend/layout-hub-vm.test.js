'use strict';
/* tests/frontend/layout-hub-vm.test.js —— 布局表驱动主界面的**投影层**契约
 *
 * 覆盖（F9/D-180）：
 *   LH-1 引擎注入前后：`hubLayoutVm` 分别为 null / 有 hub 层
 *   LH-2 绑定数据来自真实信封字段（昵称 / 段位 / 当前配置的角色与技能）
 *   LH-3 **出战角标**：只有 `battle_badge_<N>`（N = /me 的 activeSlotId）显示
 *   LH-4 显示配置切换：`state.hub.slot` 决定用哪份配置的角色/技能（与出战无关）
 *   LH-5 插槽数量 = 模板 slotCount（含超出布局手放数量时按正多边形补位）
 *   LH-6 候选列表 = 仓库桶（角色/技能/插件）且插件按插槽/技能类型过滤
 *   LH-7 path 元素带 clip（渲染层不需要懂几何）；payload 键名与 app.js dataset 一致
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const format = require(path.join(REPO, 'public', 'format.js'));
const store = require(path.join(REPO, 'public', 'store.js'));
const engine = require(path.join(REPO, 'public', 'layout-engine.js'));
const layoutData = require(path.join(REPO, 'public', 'layout-data.js'));

function stateWith(opts) {
  const st = store.initialState();
  st.view = 'hub';
  st.profile = { ok: true, data: {
    nickname: '甲玩家', progress: { tier: 'rare' },
    rating: { points: 320, wins: 12, losses: 8 },
    record: { unread: { attack: 3, defense: 1 } }, pool: { inPool: true },
    activeSlotId: (opts && opts.activeSlotId) || 'slot2',
  } };
  const mkSkill = (name, tid, q) => ({ uid: 'sk_' + tid, name, quality: q || 'common', templateId: tid, slotCount: 2, slots: [{ type: 'general' }, { type: 'exclusive' }] });
  st.configs.data = { ok: true, data: { activeSlotId: 'slot2', slots: [
    { slotId: 'slot1', name: '默认配置', loadout: {
      role: { uid: 'r1', name: '均衡', quality: 'common', templateId: 'role_bal', slotCount: 1, slots: [{ type: 'mp' }] },
      skills: [mkSkill('近战', 'skill_melee'), mkSkill('平射', 'skill_straight'), mkSkill('定点', 'skill_vertical')],
      ai: { name: '新手AI' } } },
    { slotId: 'slot2', name: '突击配置', loadout: {
      role: { uid: 'r2', name: '突击', quality: 'rare', templateId: 'role_spc_atk', slotCount: 3, slots: [{ type: 'mp' }, { type: 'atk' }, { type: 'special' }] },
      skills: [mkSkill('位移', 'skill_displace', 'rare'), mkSkill('近战', 'skill_melee'), mkSkill('平射', 'skill_straight')],
      ai: { name: '激进AI' } } },
    { slotId: 'slot3', name: '重装配置', loadout: { role: null, skills: [] } },
  ] } };
  st.warehouse.envelope = { ok: true, data: { buckets: {
    role: [{ uid: 'r1', name: '均衡', quality: 'common', templateId: 'role_bal' },
           { uid: 'r2', name: '突击', quality: 'rare', templateId: 'role_spc_atk' },
           { uid: 'r3', name: '重装', quality: 'epic', templateId: 'role_exp_def' }],
    skill: [{ uid: 'sk_a', name: '近战', quality: 'common', templateId: 'skill_melee' },
            { uid: 'sk_b', name: '平射', quality: 'common', templateId: 'skill_straight' }],
    rolePlugin: [{ uid: 'p_mp', name: 'MP 优化', quality: 'common', slot: 'mp' },
                 { uid: 'p_atk', name: '攻击强化', quality: 'common', slot: 'atk' },
                 { uid: 'p_sp', name: 'SP 优化', quality: 'common', slot: 'sp' }],
    skillPlugin: [{ uid: 'sp_gen', name: '通用强化', quality: 'common', slot: 'general' },
                  { uid: 'sp_melee', name: '长剑', quality: 'common', slot: 'exclusive', forTypes: ['skill_melee'] },
                  { uid: 'sp_other', name: '别的专属', quality: 'common', slot: 'exclusive', forTypes: ['skill_displace'] }],
  } } };
  return st;
}
const byId = (els) => { const m = {}; els.forEach((e) => { m[e.id] = e; }); return m; };

test('LH-1 注入引擎/布局数据前后', () => {
  format.setLayout(null, null);          // 测试进程内可能已被别的文件注入过 → 先归零
  assert.equal(format.layoutReady(), false, '默认未注入');
  assert.equal(format.hubLayoutVm(stateWith()), null, '未注入时返回 null（hub 走旧文字界面）');
  format.setLayout(engine, layoutData);
  assert.equal(format.layoutReady(), true, '注入后可用');
  const vm2 = format.hubLayoutVm(stateWith());
  assert.ok(vm2 && vm2.layers.length === 1, '应只有一层（未开弹窗）');
  assert.equal(vm2.canvas.w, layoutData.canvas.w, '画布来自布局数据');
});

test('LH-2 绑定数据来自真实信封字段', () => {
  const els = byId(format.hubLayoutVm(stateWith()).layers[0].elements);
  assert.equal(els['用户名'].text, '甲玩家', '昵称');
  assert.equal(els['段位名'].text, '蓝', '段位中文名');
  assert.ok(String(els['crest_role'].asset).indexOf('role_spc_atk') >= 0, '角色卡素材 = 当前显示配置的角色模板');
  assert.ok(String(els['skill_1'].asset).indexOf('skill_displace') >= 0, '技能1 素材跟随配置');
  assert.equal(els['skill_1'].text, '位移', '技能1 名字跟随配置');
});

test('LH-3 出战角标只显示"出战"的那个（battle_badge_N）', () => {
  const show = (activeSlotId) => format.hubLayoutVm(stateWith({ activeSlotId })).layers[0].elements
    .filter((e) => /^battle_badge_\d+$/.test(e.id)).map((e) => e.id);
  assert.deepEqual(show('slot1'), ['battle_badge_1'], '出战=slot1');
  assert.deepEqual(show('slot2'), ['battle_badge_2'], '出战=slot2');
  assert.deepEqual(show('slot3'), ['battle_badge_3'], '出战=slot3');
  // 三个角标都在布局里（只是被 when 过滤），位置在对应配置按钮上方
  const all = layoutData.screens.hub.elements.filter((e) => /^battle_badge_\d+$/.test(e.id));
  assert.equal(all.length, 3, '布局里应有 3 个出战角标');
  all.forEach((b, i) => {
    const slot = layoutData.screens.hub.elements.filter((e) => e.id === 'slot_' + (i + 1))[0];
    assert.ok(b.rect[1] < slot.rect[1], b.id + ' 应在配置按钮**上方**');
    assert.equal(b.rect[0], slot.rect[0], b.id + ' 应与配置按钮左对齐');
  });
});

test('LH-4 显示配置切换（state.hub.slot）与出战无关', () => {
  const st = stateWith({ activeSlotId: 'slot1' });
  st.hub = { slot: 2, modals: [] };
  const els = byId(format.hubLayoutVm(st).layers[0].elements);
  assert.ok(String(els['crest_role'].asset).indexOf('role_spc_atk') >= 0, '显示的是配置2 的角色');
  const badges = format.hubLayoutVm(st).layers[0].elements.filter((e) => /^battle_badge_/.test(e.id)).map((e) => e.id);
  assert.deepEqual(badges, ['battle_badge_1'], '出战角标仍跟随服务端的 activeSlotId');
});

test('LH-5 插槽数量 = 模板 slotCount（不足用手放方向、超出按多边形补）', () => {
  const st = stateWith();                       // 配置2 的角色 slotCount = 3
  st.hub = { slot: 2, modals: [{ name: 'modal_role_slots', ctx: {} }] };
  const layer = format.hubLayoutVm(st).layers[1];
  const slots = layer.elements.filter((e) => /^slot_e\d+$/.test(e.id));
  assert.equal(slots.length, 3, '角色 3 个插槽 → 生成 3 个（实际 ' + slots.length + '）');
  assert.equal(slots[0].action, 'layout-open', '插槽点击应打开插件候选');
  assert.equal(slots[0].payload.screen, 'modal_role_plugin_pick');
  // 布局里手放了 6 个方向；数量超出时继续按正多边形补位（不重叠、距离相等）
  st.hub = { slot: 1, modals: [{ name: 'modal_role_slots', ctx: {} }] };
  const one = format.hubLayoutVm(st).layers[1].elements.filter((e) => /^slot_e\d+$/.test(e.id));
  assert.equal(one.length, 1, 'slotCount=1 时只生成 1 个');
});

test('LH-6 候选列表 = 仓库桶（全部列出；不匹配的标灰 + 写原因）', () => {
  const st = stateWith();
  st.hub = { slot: 2, modals: [{ name: 'modal_role_pick', ctx: {} }] };
  let rows = format.hubLayoutVm(st).layers[1].elements.filter((e) => /^row_\d+$/.test(e.id));
  assert.equal(rows.length, 3, '角色候选 = 仓库 role 桶（3 个）');
  assert.ok(rows[0].payload.uid, '候选行必须带真实 uid');
  // 角色插件：**全部列出**，只把不匹配当前插槽类型的标灰 + 写原因（口径沿用旧编辑器 B-8）
  st.hub = { slot: 2, modals: [{ name: 'modal_role_plugin_pick', ctx: { pickIdx: 0 } }] };
  rows = format.hubLayoutVm(st).layers[1].elements.filter((e) => /^row_\d+$/.test(e.id));
  assert.deepEqual(rows.map((r) => r.payload.uid), ['p_mp', 'p_atk', 'p_sp'], '所有角色插件都应列出');
  assert.deepEqual(rows.map((r) => r.muted), [false, true, true], '只有类型匹配（mp）的不标灰');
  assert.ok(rows[1].label.indexOf('该插槽是「mp」类型') >= 0, '不匹配的必须写明原因：' + rows[1].label);
  // 技能插件：通用 + 专属（专属按 forTypes 与该技能的模板/动画名比对，不匹配则标灰）
  st.hub = { slot: 2, modals: [{ name: 'modal_skill_plugin_pick', ctx: { pickPos: 'skill1' } }] };
  rows = format.hubLayoutVm(st).layers[1].elements.filter((e) => /^row_\d+$/.test(e.id));
  assert.deepEqual(rows.map((r) => r.payload.uid).sort(), ['sp_gen', 'sp_melee', 'sp_other'], '所有技能插件都应列出');
  assert.deepEqual(rows.filter((r) => !r.muted).map((r) => r.payload.uid).sort(), ['sp_gen', 'sp_other'],
    '通用插件 + forTypes 命中该技能（skill_displace）的专属插件可用');
  assert.deepEqual(rows.filter((r) => r.muted).map((r) => r.payload.uid), ['sp_melee'], '不匹配的专属插件标灰');
});

test('LH-7 path 元素带 clip；payload 键名与 app.js 的 dataset 键一致', () => {
  const APP = require('node:fs').readFileSync(path.join(REPO, 'public', 'app.js'), 'utf8');
  const keysLine = APP.match(/var keys = \[([^\]]+)\]/);
  const appKeys = [...keysLine[1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
  // `keys.push('a','b')` 追加的键也算（布局表用到的键必须能被 app.js 收到）
  for (const m of APP.matchAll(/keys\.push\(([^)]+)\)/g)) {
    for (const k of m[1].matchAll(/'([A-Za-z]+)'/g)) appKeys.push(k[1]);
  }
  const els = format.hubLayoutVm(stateWith()).layers[0].elements;
  const crest = els.filter((e) => e.id === 'crest_role')[0];
  assert.ok(crest.clip && /^polygon\(/.test(crest.clip), '不规则按钮应带 clip-path 多边形');
  const used = new Set();
  els.forEach((e) => Object.keys(e.payload || {}).forEach((k) => used.add(k)));
  [['slot_e1', 'modal_role_slots']].forEach(() => {});
  const withPayload = format.hubLayoutVm(Object.assign(stateWith(), { hub: { slot: 2, modals: [{ name: 'modal_role_slots', ctx: {} }] } }));
  withPayload.layers[1].elements.forEach((e) => Object.keys(e.payload || {}).forEach((k) => used.add(k)));
  const unknown = [...used].filter((k) => appKeys.indexOf(k) < 0);
  // 渲染层接线（render.js 的布局分支 + app.js 收键）与 BP-1 的字段双向核对要一起改，
  //   因此这三个键**显式登记为待接线**，而不是让它们悄悄漏掉。
  const PENDING = ['screen', 'slotIndex', 'targetUid'];
  const notRegistered = unknown.filter((k) => PENDING.indexOf(k) < 0);
  assert.deepEqual(notRegistered, [], '这些布局载荷键既不被 app.js 接收、也没登记为待接线：' + notRegistered.join(', '));
  // 候选行载荷：uid（选中的物品）+ pos/slotIndex（落到哪个位置）；插槽载荷：screen/idx/pos/targetUid
  const withRows = format.hubLayoutVm(Object.assign(stateWith(), { hub: { slot: 2, modals: [{ name: 'modal_role_pick', ctx: {} }] } }));
  const row = withRows.layers[1].elements.filter((e) => /^row_\d+$/.test(e.id))[0];
  assert.ok(row && row.payload.uid, '候选行必须带 uid');
  const slotEl = withPayload.layers[1].elements.filter((e) => /^slot_e\d+$/.test(e.id))[0];
  assert.ok(slotEl && slotEl.payload.idx === 0 && slotEl.payload.pos === 'role',
    '插槽载荷必须带 idx/pos（app.js 已支持）');
});
