'use strict';
// P6 R2 视图契约测试 —— spec §6.0/§6.1/§6.7 + docs/screens.md menu/settings 盒子表逐行一致
const { test, before } = require('node:test');
const assert = require('node:assert/strict');

let shell, menu, settings, html, vi, rm;
before(async () => {
  shell = await import('../../public/js/views/shell.js');
  menu = await import('../../public/js/views/menu.js');
  settings = await import('../../public/js/views/settings.js');
  html = await import('../../public/js/views/html.js');
  vi = await import('../../public/js/views/index.js');
  rm = await import('../../public/js/store/reducer.js');
});

function st(patch) {
  const s = rm.reducer(undefined, { type: '@@init' });
  return { ...s, ...(patch || {}) };
}

function boxAt(boxes, id) {
  return boxes.find((b) => b.id === id);
}

function wantBox(b, id, x, y, w, h, z) {
  assert.ok(b, `${id} 应存在`);
  assert.deepEqual({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, z: b.z }, { id, x, y, w, h, z }, `${id} 坐标`);
}

test('R2 shell：logo/tierBadge/seedLit = screens.md 首三行；seedLit 仅主菜单', () => {
  const base = { screen: 'menu', tier: 'rare', seed: 42 };
  const boxes = shell.shellLayout(base);
  wantBox(boxAt(boxes, 'logo'), 'logo', 16, 9, 180, 46, 1);
  wantBox(boxAt(boxes, 'tierBadge'), 'tierBadge', 1080, 20, 72, 24, 1);
  wantBox(boxAt(boxes, 'seedLit'), 'seedLit', 1160, 20, 112, 24, 1);
  assert.equal(boxAt(boxes, 'seedLit').text, 'seed: 42');
  const none = shell.shellLayout({ ...base, screen: 'editor' });
  assert.equal(boxAt(none, 'seedLit'), undefined, '非主菜单无 seedLit');
  assert.ok(boxAt(none, 'basemap') && boxAt(none, 'basemap').z === 0, 'basemap 背景层 z0');
  assert.ok(shell.shellLayout({ ...base, screen: 'menu' }).find((b) => b.id === 'shell_main'), 'main 区容器');
});

test('R2 menu：screens.md 盒子表逐行坐标一致（ready 态）', () => {
  const s = st({ meta: { serverOk: true }, warehouse: { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } }, loadout: { role: 'u1' } });
  const boxes = menu.menuLayout(s);
  const want = [
    ['panel_menu', 360, 180, 560, 360, 2],
    ['title', 408, 216, 464, 32, 3],
    ['btn_ai', 560, 268, 160, 40, 4],
    ['btn_wh', 560, 320, 160, 40, 4],
    ['btn_gacha', 560, 372, 160, 40, 4],
    ['btn_battle', 560, 424, 160, 40, 4],
    ['btn_settings', 560, 476, 160, 40, 4],
    ['hint', 408, 540, 464, 24, 4],
  ];
  for (const [id, x, y, w, h, z] of want) wantBox(boxAt(boxes, id), id, x, y, w, h, z);
  assert.equal(boxAt(boxes, 'btn_ai').action, 'goto');
  assert.deepEqual(boxAt(boxes, 'btn_ai').payload, { screen: 'editor' });
  assert.deepEqual(boxAt(boxes, 'btn_settings').payload, { screen: 'settings' });
});

test('R2 menu：四态分支', () => {
  const emptyState = st({ meta: { serverOk: null } });
  assert.equal(menu.menuPhase(emptyState), 'loading');
  const err = st({ meta: { serverOk: false } });
  assert.equal(menu.menuPhase(err), 'error');
  const emptyBox = st({ meta: { serverOk: true } });
  assert.equal(menu.menuPhase(emptyBox), 'empty');
  const ready = st({ meta: { serverOk: true }, warehouse: { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } } });
  assert.equal(menu.menuPhase(ready), 'ready');
});

test('R2 menu：verifyLayout 全绿（四态逐一）', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const cases = [
    st({ meta: { serverOk: null } }),
    st({ meta: { serverOk: false } }),
    st({ meta: { serverOk: true } }),
    st({ meta: { serverOk: true }, warehouse: { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } } }),
  ];
  for (const s of cases) {
    const issues = verifyLayout(menu.menuLayout(s));
    assert.deepEqual(issues, [], `${menu.menuPhase(s)} 态布局应无 issue`);
  }
});

test('R2 settings：screens.md 盒子表逐行坐标一致 + 布局自检全绿', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const s = st({ meta: { version: '3.0.0' }, seed: 7, logPrefs: { level: 'debug', channels: { ui: 'debug' }, panelOpen: false } });
  const boxes = settings.settingsLayout(s, []);
  const want = [
    ['left', 16, 80, 560, 400, 2],
    ['logPanel', 600, 80, 664, 400, 2],
    ['save_row', 16, 500, 560, 80, 2],
    ['fld_seed', 40, 120, 280, 40, 3],
    ['sel_tier', 40, 176, 280, 40, 3],
    ['about', 40, 240, 512, 140, 3],
    ['sel_level', 624, 120, 120, 40, 3],
    ['channels', 624, 176, 616, 140, 2],
    ['ring', 624, 348, 616, 120, 3],
    ['btn_export', 40, 516, 120, 40, 3],
    ['btn_import', 176, 516, 120, 40, 3],
  ];
  for (const [id, x, y, w, h, z] of want) wantBox(boxAt(boxes, id), id, x, y, w, h, z);
  // 22 通道 chips：两行网格（11/行；52×24；间距 4）
  const chip0 = boxAt(boxes, 'ch_rng');
  const chip21 = boxAt(boxes, 'ch_log');
  assert.deepEqual({ x: chip0.x, y: chip0.y, w: chip0.w, h: chip0.h }, { x: 624, y: 180, w: 52, h: 24 });
  assert.deepEqual({ x: chip21.x, y: chip21.y }, { x: 624 + 10 * 56, y: 180 + 28 });
  assert.equal(chip0.action, 'log/set');
  assert.ok(chip0.payload.channels.rng === 'debug', 'off → 点击开 debug');
  assert.ok(boxAt(boxes, 'ch_ui').payload.channels.ui === null, '已勾选 → 点击关闭(null)');
  assert.deepEqual(verifyLayout(boxes), [], 'settings 布局应无 issue');
});

test('R2 settings：filterLogs 级别/通道过滤', () => {
  const records = [
    { seq: 1, level: 'trace', channel: 'render', event: 'render.frame', msg: 'f' },
    { seq: 2, level: 'debug', channel: 'store', event: 'store.dispatch', msg: 'd' },
    { seq: 3, level: 'warn', channel: 'ui', event: 'ui.layout.report', msg: 'w' },
  ];
  assert.equal(settings.filterLogs(records, { level: 'debug', channels: {} }).map((r) => r.seq).length, 2, 'debug 级别 → 排除更详尽的 trace');
  assert.deepEqual(settings.filterLogs(records, { level: 'trace', channels: {} }).map((r) => r.seq), [1, 2, 3], 'trace 级别 → 全部');
  assert.deepEqual(settings.filterLogs(records, { level: 'debug', channels: { store: 'debug' } }).map((r) => r.seq), [2], '通道过滤仅勾选通道');
  assert.equal(settings.filterLogs(null, { level: 'debug' }).length, 0);
});

test('R2 shell：shellHtml 输出可直接被 collectBoxes 解析', () => {
  const h = shell.shellHtml({ screen: 'menu', tier: 'common', seed: null });
  const parsed = html.collectBoxes(h);
  assert.ok(parsed.some((b) => b.id === 'logo' && b.x === 16 && b.y === 9));
  assert.ok(parsed.some((b) => b.id === 'seedLit' && b.w === 112));
});

test('R2 settings：settingsHtml + 畸形 records/级别臂', async () => {
  const { verifyLayout } = await import('../../public/js/ui/layout.js');
  const s = st({ screen: 'settings', meta: {}, seed: null, logPrefs: { level: 'debug', channels: {}, panelOpen: false } });
  const h = settings.settingsHtml(s, [{ seq: 1, level: 'LOUD', channel: 'store', event: 'store.dispatch' }]);
  assert.ok(h.includes('data-box-id="sel_level"'));
  assert.ok(h.includes('暂无日志记录') === false, '有一条记录应显示');
  const boxes = settings.settingsLayout(s, [{ seq: 1, level: 'LOUD', channel: 'store', event: 'store.dispatch' }]);
  assert.deepEqual(verifyLayout(boxes), [], '畸形记录也应有合法布局');
});

test('R2 html：boxHtml → collectBoxes 往返一致', () => {
  const box = {
    id: 'b1', kind: 'button', x: 10, y: 20, w: 160, h: 40, z: 4, visible: true,
    text: '开<b>箱</b>', action: 'goto', payload: { screen: 'gacha' }, valueKey: null,
  };
  const h = html.boxHtml(box);
  assert.ok(h.includes('data-box-id="b1"'));
  assert.ok(h.includes('left:10px;top:20px;width:160px;height:40px;z-index:4;'));
  assert.ok(h.includes('&lt;b&gt;'), 'text 应转义');
  assert.ok(h.includes('data-action="goto"'));
  assert.ok(h.includes('data-payload="'), 'payload JSON 转义注入');
  const parsed = html.collectBoxes(h);
  assert.deepEqual(parsed, [{ id: 'b1', x: 10, y: 20, w: 160, h: 40, z: 4, visible: true }]);
  const s = {
    id: 'sel', kind: 'field', x: 0, y: 0, w: 100, h: 40, z: 3, visible: true,
    value: 'rare', options: ['common', 'rare'], valueKey: 'tier',
  };
  const h2 = html.boxHtml(s);
  assert.ok(h2.includes('<select>') && h2.includes('<option value="rare" selected>'));
  assert.ok(h2.includes('data-value-key="tier"'));
  assert.deepEqual(html.collectBoxes(h2), [{ id: 'sel', x: 0, y: 0, w: 100, h: 40, z: 3, visible: true }]);
  assert.deepEqual(html.collectBoxes('no html'), []);
  assert.deepEqual(html.collectBoxes(null), []);
});

test('R2 renderScreen：已实现屏拼接 + 未实现屏 fallback + records 解析', () => {
  const s = st({ screen: 'menu', meta: { serverOk: true }, warehouse: { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } } });
  const ready = vi.renderScreen('menu', s, { records: [] });
  assert.ok(ready.includes('data-box-id="btn_ai"'), 'ready 菜单含按钮');
  assert.ok(ready.includes('data-box-id="logo"'), '拼装外壳');
  assert.ok(ready.includes('data-box-id="seedLit"'), '主菜单含 seedLit');
  const fb = vi.renderScreen('replay', s, {});
  assert.ok(fb.includes('尚未接线'), '未实现屏占位（replay 于 R5 接线）');
  const fnRecords = vi.renderScreen('settings', st({ screen: 'settings' }), { records: () => [{ seq: 1, level: 'debug', channel: 'store', event: 'store.dispatch', msg: 'x' }] });
  assert.ok(fnRecords.includes('store.dispatch'), 'records 函数 → 数组解析');
  // R3/R4：gacha/warehouse/battle 屏接线
  const sg = vi.renderScreen('gacha', st({ screen: 'gacha' }), {});
  assert.ok(sg.includes('data-box-id="btn_open"'), 'gacha 屏接线');
  const sw = vi.renderScreen('warehouse', { ...st({ screen: 'warehouse' }), warehouse: { buckets: { role: [{ uid: 'u1', kind: 'role', name: 'x', quality: 'common' }], skill: [], rolePlugin: [], skillPlugin: [] } } }, {});
  assert.ok(sw.includes('data-box-id="card1"'), 'warehouse 屏接线');
  const sb = vi.renderScreen('battle', st({ screen: 'battle' }), {});
  assert.ok(sb.includes('data-box-id="btn_start"'), 'battle 屏接线');
});

test('R2 menu：ready/empty 提示文案区分', () => {
  const sEmpty = st({ meta: { serverOk: true } });
  const sReady = st({ meta: { serverOk: true }, warehouse: { buckets: { role: [{ uid: 'r1' }], skill: [], rolePlugin: [], skillPlugin: [] } } });
  assert.ok(menu.menuHtml(sEmpty).includes('先到「开箱」'));
  assert.ok(menu.menuHtml(sReady).includes('按键 1..5'));
  const errHtml = menu.menuHtml(st({ meta: { serverOk: false } }));
  assert.ok(errHtml.includes('重试') && errHtml.includes('data-action="boot"'), 'error 态含重试按钮');
});
