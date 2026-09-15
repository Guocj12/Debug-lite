'use strict';
// F2 视图测试 —— frontend-spec §6.0/§6.1/§6.7（shell/menu 四态/settings 日志面板 纯布局 + 过滤/导出）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const state = (patch) => Object.assign({
  screen: 'menu', tier: 'common', seed: null, meta: { serverOk: null },
  loadout: { role: null, skills: [null, null, null], ai: null },
  logPrefs: { level: 'debug', channels: {} },
}, patch || {});

test('menuPhase 四态：loading（serverOk null）/error（false）/empty（无角色）/ready', async () => {
  const { menuPhase } = await import('../../public/js/views/menu.js');
  assert.equal(menuPhase(state()), 'loading');
  assert.equal(menuPhase(state({ meta: { serverOk: false } })), 'error');
  assert.equal(menuPhase(state({ meta: { serverOk: true } })), 'empty');
  assert.equal(menuPhase(state({ meta: { serverOk: true }, loadout: { role: { uid: 'r' }, skills: [], ai: null } })), 'ready');
});

test('menu 布局：panel_menu(360,180,560,360,z2)+title+hint + 五按钮 y268 步距 52（screens.md menu 表）+ 四态自检', async () => {
  const { menuLayout, menuPhase } = await import('../../public/js/views/menu.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const ready = state({ meta: { serverOk: true }, loadout: { role: { uid: 'r' }, skills: [], ai: null } });
  const boxes = menuLayout(ready);
  const panel = boxes.find((b) => b.id === 'panel_menu');
  assert.deepEqual([panel.x, panel.y, panel.w, panel.h, panel.z], [360, 180, 560, 360, 2], 'screens.md menu 表 panel_menu 行');
  const title = boxes.find((b) => b.id === 'title');
  assert.deepEqual([title.x, title.y, title.w, title.h, title.z], [408, 216, 464, 32, 3], 'title 行');
  assert.equal(title.text, 'Debug-Lite v3');
  const btnAi = boxes.find((b) => b.id === 'btn_ai');
  assert.deepEqual([btnAi.x, btnAi.y, btnAi.w, btnAi.h, btnAi.z], [560, 268, 160, 40, 4], '表内首按钮 560,268（F2 旧实现 y260 与表差 8');
  assert.equal(btnAi.goto, 'editor');
  const ys = ['btn_ai', 'btn_wh', 'btn_gacha', 'btn_battle', 'btn_settings'].map((id) => boxes.find((b) => b.id === id).y);
  assert.deepEqual(ys, [268, 320, 372, 424, 476], '步距 52（表：268/320/372/424/476）；栈底 516 ≤ 面板底 540');
  assert.equal(boxes.find((b) => b.id === 'btn_battle').goto, 'battle');
  const hint = boxes.find((b) => b.id === 'hint');
  assert.deepEqual([hint.x, hint.y, hint.w, hint.h, hint.z], [408, 540, 464, 24, 4], 'hint 行');
  assert.equal(hint.text, '选择一项进入');
  // 四态布局自检（按钮栈/重试按钮 z 与几何）
  for (const [label, st] of [['ready', ready],
    ['error', state({ meta: { serverOk: false } })],
    ['empty', state({ meta: { serverOk: true } })],
    ['loading', state()]]) {
    const v = verifyLayout(menuLayout(st));
    assert.equal(v.ok, true, `menu ${label} 布局自检通过（${v.issues.map((i) => i.boxId + ':' + i.issue).join('|')}）`);
  }
  // loading：按钮栈保留但禁用（表内盒不消失）；hint 文案切加载
  const loading = menuLayout(state());
  assert.equal(loading.filter((b) => b.goto).length, 5, 'loading 保留五按钮（disabled）');
  assert.equal(loading.find((b) => b.id === 'btn_ai').disabled, true);
  assert.equal(loading.find((b) => b.id === 'title').text, '加载中');
  assert.equal(loading.find((b) => b.id === 'hint').text, '正在连接服务端…');
  assert.equal(menuPhase(state({ meta: { serverOk: false } })), 'error', 'error 态');
  // error：只放重试（同按钮栈位置 y476），无导航按钮；z4 > 面板 z2（无 zconflict）
  const err = menuLayout(state({ meta: { serverOk: false } }));
  assert.equal(err.filter((b) => b.goto).length, 0, 'error 态无导航按钮');
  const boot = err.find((b) => b.id === 'btn_boot');
  assert.equal(boot.action, 'boot');
  assert.deepEqual([boot.x, boot.y, boot.w, boot.h, boot.z], [560, 476, 160, 40, 4]);
  assert.equal(err.find((b) => b.id === 'hint').text, '连接失败：服务端不可达');
  // empty：提示 + 全按钮
  const empty = menuLayout(state({ meta: { serverOk: true } }));
  assert.equal(empty.find((b) => b.id === 'hint').text, '无存档：先开箱/装配，或直接开始');
  assert.equal(empty.filter((b) => b.goto).length, 5);
});

test('shell 布局：logo(16,9,180,46,z1)+tierBadge(1080,20,72,24,z1)+seedLit 仅主菜单+bg z0', async () => {
  const { shellLayout } = await import('../../public/js/views/shell.js');
  const boxes = shellLayout(state({ tier: 'rare', seed: 7 }));
  const logo = boxes.find((b) => b.id === 'logo');
  assert.deepEqual([logo.x, logo.y, logo.w, logo.h, logo.z], [16, 9, 180, 46, 1], '表 logo 行（全屏共用）');
  const tier = boxes.find((b) => b.id === 'tierBadge');
  assert.deepEqual([tier.x, tier.y, tier.w, tier.h, tier.z], [1080, 20, 72, 24, 1], '表 tierBadge 行');
  assert.equal(tier.style, 'q-rare');
  assert.equal(tier.text, 'rare');
  const seedLit = boxes.find((b) => b.id === 'seedLit');
  assert.deepEqual([seedLit.x, seedLit.y, seedLit.w, seedLit.h], [1160, 20, 112, 24], '表 seedLit 行');
  assert.equal(seedLit.text, 'seed:7');
  assert.equal(shellLayout(state({ seed: null })).find((b) => b.id === 'seedLit').text, 'seed:—');
  // seedLit 仅主菜单（screens.md 其余六屏表无此行）
  assert.equal(shellLayout(state({ screen: 'settings' })).find((b) => b.id === 'seedLit'), undefined);
  // 背景层：basemap_header/main y64 均为 z0（legend「1 basemap/header」；不占表行）
  const base = boxes.find((b) => b.id === 'basemap_header');
  assert.deepEqual([base.x, base.y, base.w, base.h, base.z], [0, 0, 1280, 64, 0]);
  const main = boxes.find((b) => b.id === 'shell_main');
  assert.deepEqual([main.x, main.y, main.w, main.h, main.z], [0, 64, 1280, 656, 0]);
  // 表内未登记的盒一律不产出（F8：旧 shell_header/shell_log 已移除）
  assert.equal(boxes.find((b) => b.id === 'shell_header'), undefined);
  assert.equal(boxes.find((b) => b.id === 'shell_log'), undefined);
});

test('settings：filterLogs 阈值（DLLog 刻度）/通道/空集 + 边界复算 + exportLogs + mapLevel 兜底', async () => {
  const { filterLogs, exportLogs, LOG_LEVELS } = await import('../../public/js/views/settings.js');
  // 夹具 levelValue 用 DLLog 真实刻度（shared/log.js LEVELS：info=3 debug=4 trace=5——F2 审查 P1）
  const records = [
    { seq: 1, level: 'info', levelValue: 3, channel: 'render', event: 'e1', msg: 'm1' },
    { seq: 2, level: 'debug', levelValue: 4, channel: 'api', event: 'e2' },
    { seq: 3, level: 'trace', levelValue: 5, channel: 'ui', event: 'e3' },
    { seq: 4, level: 'warn', channel: 'store', event: 'e4' }, // 无 levelValue → mapLevel 兜底（warn=2）
    { seq: 5, level: 'bogus', channel: 'store', event: 'e5' }, // 未知级别名 → 默认 4（debug）
  ];
  const at = filterLogs(records, { levelValue: 4 });
  assert.deepEqual(at.map((r) => r.seq), [1, 2, 4, 5], 'levelValue ≤ 4 保留（info3/debug4；warn→2；未知名→4——不含 trace5）');
  const ch = filterLogs(records, { levelValue: 99, channels: ['ui', 'api'] });
  assert.deepEqual(ch.map((r) => r.seq), [2, 3], '通道过滤（all=99 全级别）');
  const all = filterLogs(records, { levelValue: 99, channels: [] });
  assert.equal(all.length, 5, '空通道集合 = 全部');
  const def = filterLogs(records, {});
  assert.equal(def.length, 4, 'levelValue 缺省 → 4（seq1/2/4/5；debug 档含 debug 自身、不含 trace）');
  const noCh = filterLogs(records, { levelValue: 99 });
  assert.equal(noCh.length, 5, 'channels 缺省 → 不过滤');
  assert.equal(filterLogs(undefined, {}).length, 0, 'records 缺省安全');
  // 边界复算（F2 审查 P1 实证）：levelValue=0 → 仅 fatal；silent(-1) → 无记录（阈值常量）
  const fatalOnly = filterLogs([{ level: 'fatal', levelValue: 0 }, { level: 'info', levelValue: 3 }], { levelValue: 0 });
  assert.equal(fatalOnly.length, 1, 'levelValue=0 仅 fatal');
  assert.equal(filterLogs([{ level: 'debug', levelValue: 4 }], { levelValue: -1 }).length, 0, 'silent(-1) 阈值 → 空');
  // 通道大小写敏感（records.channel 恒来自 DLLog 小写规范，见 F2 登记）
  assert.equal(filterLogs(records, { levelValue: 99, channels: ['RENDER'] }).length, 0, '通道大小写敏感');
  assert.equal(typeof exportLogs([records[0]], { levelValue: 99 }), 'string');
  assert.ok(exportLogs([], {}).includes('[]'));
  assert.deepEqual(LOG_LEVELS, { silent: -1, fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5, all: 99 }, '刻度与 shared/log.js LEVELS 逐值一致');
});

test('settings 布局：left/logPanel/save_row 容器 + sel_level 循环 + channels chips + ring 行 + 导出/导入（screens.md 表）', async () => {
  const { settingsLayout, CHANNELS } = await import('../../public/js/views/settings.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const records = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, level: 'info', levelValue: 3, channel: 'ui', event: `ev${i}`, msg: `m${i}` }));
  const boxes = settingsLayout(state({ logPrefs: { level: 'trace', channels: { render: 'trace' } } }), { records });
  // 表内容器四件（left/logPanel/save_row/channels/ring）
  assert.deepEqual(['left', 'logPanel', 'save_row'].map((id) => {
    const b = boxes.find((x) => x.id === id);
    return [b.x, b.y, b.w, b.h, b.z].join(',');
  }), ['16,80,560,400,2', '600,80,664,400,2', '16,500,560,80,2']);
  const sel = boxes.find((b) => b.id === 'sel_level');
  assert.deepEqual([sel.x, sel.y, sel.w, sel.h, sel.z], [624, 120, 120, 40, 3], '表 sel_level 行');
  assert.equal(sel.text, 'trace', '当前级别回显');
  assert.equal(sel.action, 'log/level');
  assert.deepEqual(sel.payload, { level: 'info' }, 'payload 为循环下一档（trace → info；F2 审查 P1：原无 payload → 死控件）');
  // 通道 chips：全集 + z4（> channels 容器 z3）+ 开/关态来自 logPrefs.channels
  const chips = boxes.filter((b) => b.kind === 'chip');
  assert.equal(chips.length, CHANNELS.length, '通道全集 chip');
  assert.equal(chips.find((b) => b.id === 'ch_render').style, 'on', 'render 默认开（initialState channels.render=trace）');
  assert.equal(chips.find((b) => b.id === 'ch_api').style, 'off');
  assert.equal(chips.find((b) => b.id === 'ch_api').action, 'log/channel');
  assert.deepEqual(chips.find((b) => b.id === 'ch_api').payload, { channel: 'api', on: true });
  assert.deepEqual([chips[0].z, chips[0].parent], [4, 'channels'], 'z4 > 容器 z3，父盒 channels');
  // ring 记录行（≤3 行；容器内 z4）
  const rows = boxes.filter((b) => b.kind === 'listitem');
  assert.ok(rows.length > 0 && rows.length <= 3, 'ring 行数受容器高度约束（≤3）');
  assert.equal(rows[0].text.includes('ev19'), true, '最新（末条 ev19）在前');
  assert.equal(rows[0].parent, 'ring');
  // 日志导出/复位（ring 容器内，不再悬于面板外）
  assert.equal(boxes.find((b) => b.id === 'btn_log_export').action, 'log/export');
  assert.equal(boxes.find((b) => b.id === 'btn_log_reset').action, 'log/reset');
  assert.equal(boxes.find((b) => b.id === 'btn_log_export').parent, 'ring');
  // 存档行按钮：120×40（表值，非 SIZES.button 160×40）
  const exp = boxes.find((b) => b.id === 'btn_export');
  assert.deepEqual([exp.x, exp.y, exp.w, exp.h, exp.z, exp.action], [40, 516, 120, 40, 3, 'save/export']);
  assert.deepEqual(['btn_import', 'btn_export'].map((id) => boxes.find((b) => b.id === id).parent), ['save_row', 'save_row']);
  assert.equal(boxes.find((b) => b.id === 'btn_import').action, 'save/import');
  const vf = verifyLayout(boxes);
  assert.equal(vf.ok, true, `设置屏布局自检通过（${vf.issues.map((i) => i.boxId + ':' + i.issue).join('|')}）`);
  // 空记录 → ring 空态
  const none = settingsLayout(state(), {});
  assert.ok(none.find((b) => b.id === 'log_rec_empty'));
  assert.equal(none.filter((b) => b.kind === 'listitem').length, 0);
  // levelValue/channels 显式 opts 臂
  const filtered = settingsLayout(state(), { records, levelValue: 7, channels: ['ui'] });
  assert.equal(filtered.find((b) => b.id === 'ring').text.includes('20 条'), true, 'levelValue/channels 显式');
  assert.equal(verifyLayout(filtered).ok, true);
});

test('renderScreen：records 函数 → 解析为数组后再交给各屏（F8：原样透传 → 设置屏 TypeError 崩溃）', async () => {
  const { renderScreen } = await import('../../public/js/views/index.js');
  const records = [{ seq: 1, level: 'info', levelValue: 3, channel: 'ui', event: 'e1', msg: 'm' }];
  const st = { screen: 'settings', tier: 'common', seed: null, logPrefs: { level: 'debug', channels: {} } };
  const r1 = renderScreen(st, { records: () => records });
  assert.ok(r1.main.find((b) => b.id === 'ring').text.includes('1 条'), '函数源被解析（渲染 1 条）');
  const r2 = renderScreen(st, { records });
  assert.ok(r2.main.find((b) => b.id === 'ring').text.includes('1 条'), '数组源原样可用');
  const r3 = renderScreen(st, {});
  assert.ok(r3.main.find((b) => b.id === 'ring').text.includes('0 条'), '无 records → 0 条（不抛）');
  const r4 = renderScreen(st); // opts 缺省
  assert.equal(typeof r4.main.find((b) => b.id === 'ring').text, 'string');
});

test('F8 回归：真实 store 上 log/channel（通道 chip）不递归 + 写入 logPrefs', async () => {
  const { createStore } = await import('../../public/js/store/index.js');
  const levels = [];
  const store = createStore({ api: {}, log: { debug: () => {}, setChannelLevel: (ch, lv) => levels.push([ch, lv]) }, state: { logPrefs: { level: 'debug', channels: {} } } });
  store.dispatch({ type: 'log/channel', payload: { channel: 'api', on: true } });
  assert.equal(store.getState().logPrefs.channels.api, 'trace', '开 → trace');
  assert.deepEqual(levels[0], ['api', 'trace'], 'DLLog 通道级别同步');
  store.dispatch({ type: 'log/channel', payload: { channel: 'api', on: false } });
  assert.equal(store.getState().logPrefs.channels.api, 'silent', '关 → silent');
  assert.deepEqual(levels[1], ['api', 'silent']);
  store.dispatch({ type: 'log/channel', payload: {} });
  assert.equal(levels.length, 2, '缺 channel → noop');
});

test('renderScreen：已实现屏拼接 shell+main；未实现屏 fallback', async () => {
  const { renderScreen, allBoxes, VIEWS } = await import('../../public/js/views/index.js');
  const st = { screen: 'menu', tier: 'common', seed: null, meta: { serverOk: true }, loadout: { role: { uid: 'r' }, skills: [], ai: null } };
  const r = renderScreen(st, {});
  assert.equal(r.screen, 'menu');
  assert.ok(r.shell.length >= 4, 'shell 盒');
  assert.ok(r.main.some((b) => b.id === 'btn_ai'));
  const all = allBoxes(r);
  assert.equal(all.length, r.shell.length + r.main.length);
  const unimplemented = renderScreen({ ...st, screen: 'nope' }, {});
  assert.equal(unimplemented.main[0].id, 'screen_unimplemented');
  assert.equal(unimplemented.main[0].text.includes('nope'), true, '未知屏 fallback');
  // F3..F6：全部 7 屏已注册
  assert.ok(VIEWS.warehouse.layout && VIEWS.gacha.layout && VIEWS.battle.layout && VIEWS.replay.layout && VIEWS.editor.layout, '7 屏全部挂载');
  const whR = renderScreen({ ...st, screen: 'warehouse' }, {});
  assert.ok(whR.main.some((b) => b.id.startsWith('wh_tab_')), '仓库屏盒');
});