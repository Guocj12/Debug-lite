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

test('menu 布局：中心面板 center(560,360)=x360,y180 + 五按钮栈 y260 起 gap12 + goto 标注 + 三态自检', async () => {
  const { menuLayout, menuPhase } = await import('../../public/js/views/menu.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const boxes = menuLayout(state({ meta: { serverOk: true }, loadout: { role: { uid: 'r' }, skills: [], ai: null } }));
  const panel = boxes.find((b) => b.id === 'menu_panel');
  assert.deepEqual([panel.x, panel.y, panel.w, panel.h], [360, 180, 560, 360], 'center(560,360) = (720-360)/2=180（§3.4 函数权威；§6.1 散文 y184 笔误登记）');
  const btnAi = boxes.find((b) => b.id === 'btn_ai');
  assert.deepEqual([btnAi.x, btnAi.y, btnAi.w, btnAi.h], [560, 260, 160, 40], '首个按钮 x=360+(560-160)/2=560, y=260（§6.1 绝对坐标；F2 审查 P1：原 y=180+260=440 → 3/5 按钮溢出面板）');
  assert.equal(btnAi.goto, 'editor');
  const ys = ['btn_ai', 'btn_wh', 'btn_gacha', 'btn_battle', 'btn_settings'].map((id) => boxes.find((b) => b.id === id).y);
  assert.deepEqual(ys, [260, 312, 364, 416, 468], 'gap 12 步进（40+12）；栈底 508 ≤ 面板底 540');
  assert.equal(boxes.find((b) => b.id === 'btn_battle').goto, 'battle');
  // 三态布局自检（按钮栈/重试按钮 z 与几何——F2 审查 P1 回归）
  for (const [label, st] of [['ready', state({ meta: { serverOk: true }, loadout: { role: { uid: 'r' }, skills: [], ai: null } })],
    ['error', state({ meta: { serverOk: false } })],
    ['empty', state({ meta: { serverOk: true } })]]) {
    const v = verifyLayout(menuLayout(st));
    assert.equal(v.ok, true, `menu ${label} 布局自检通过（${v.issues.map((i) => i.boxId + ':' + i.issue).join('|')}）`);
  }
  // loading 态：无按钮
  const loading = menuLayout(state());
  assert.ok(!loading.some((b) => b.action || b.goto), 'loading 无按钮');
  assert.equal(menuPhase(state({ meta: { serverOk: false } })), 'error', 'error 态');
  // error 态：重试 boot + z=1（≥ 面板 z0，无 zconflict）
  const err = menuLayout(state({ meta: { serverOk: false } }));
  assert.equal(err.find((b) => b.id === 'btn_boot').action, 'boot');
  assert.equal(err.find((b) => b.id === 'btn_boot').z, 1, '重试按钮 z=1（F2 审查 P1：缺省 z=0 → zconflict 误报）');
  // empty 态：提示 + 全按钮
  const empty = menuLayout(state({ meta: { serverOk: true } }));
  assert.ok(empty.find((b) => b.id === 'menu_empty'));
  assert.equal(empty.filter((b) => b.goto).length, 5);
});

test('shell 布局：header y0..64 / tier badge x1120 / seed 1156 / log 按钮 1184（右缘 1280 不越界）/ main y64', async () => {
  const { shellLayout } = await import('../../public/js/views/shell.js');
  const boxes = shellLayout(state({ tier: 'rare', seed: 7 }));
  const h = boxes.find((b) => b.id === 'shell_header');
  assert.deepEqual([h.x, h.y, h.w, h.h], [0, 0, 1280, 64]);
  const tier = boxes.find((b) => b.id === 'shell_tier');
  assert.equal(tier.x, 1120);
  assert.equal(tier.style, 'q-rare');
  assert.equal(boxes.find((b) => b.id === 'shell_seed').text, 'seed:7');
  const seedNull = shellLayout(state({ seed: null })).find((b) => b.id === 'shell_seed').text;
  assert.equal(seedNull, 'seed:—');
  const logBtn = boxes.find((b) => b.id === 'shell_log');
  assert.equal(logBtn.action, 'log/toggle');
  assert.equal(logBtn.x + logBtn.w, 1280, '右缘贴合视图（自检器复验）');
  assert.deepEqual([boxes.find((b) => b.id === 'shell_main').x, boxes.find((b) => b.id === 'shell_main').y], [0, 64]);
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

test('settings 布局：左面板 16,80 + 日志面板 600,80,664,560 + 级别 radio 选中态/payload + 记录行（10 行不压按钮）+ 导出/复位', async () => {
  const { settingsLayout } = await import('../../public/js/views/settings.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const records = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, level: 'info', levelValue: 3, channel: 'ui', event: `ev${i}`, msg: `m${i}` }));
  const boxes = settingsLayout(state({ logPrefs: { level: 'trace' } }), { records });
  const left = boxes.find((b) => b.id === 'settings_left');
  assert.deepEqual([left.x, left.y, left.w, left.h], [16, 80, 560, 560]);
  const logPanel = boxes.find((b) => b.id === 'settings_log');
  assert.deepEqual([logPanel.x, logPanel.y, logPanel.w, logPanel.h], [600, 80, 664, 560]);
  const rb = boxes.filter((b) => b.kind === 'radio');
  assert.equal(rb.length, 3);
  assert.equal(rb.find((b) => b.id === 'log_level_trace').style, 'on', '当前级别高亮');
  assert.equal(rb.find((b) => b.id === 'log_level_debug').style, 'off');
  assert.equal(rb[0].action, 'log/level');
  assert.deepEqual(rb.find((b) => b.id === 'log_level_trace').payload, { level: 'trace' }, 'radio payload 带 level（F2 审查 P1：原无 payload → 死控件）');
  const rows = boxes.filter((b) => b.kind === 'listitem');
  assert.equal(rows.length, 10, '最多 10 行（最近倒序；F2 审查 P1：12 行与 y560 按钮行几何冲突 → 10 行）');
  assert.equal(rows[0].text.includes('ev19'), true, '最新（seq20=ev19）在前');
  assert.equal(boxes.find((b) => b.id === 'btn_log_export').action, 'log/export');
  assert.equal(boxes.find((b) => b.id === 'btn_log_reset').action, 'log/reset');
  assert.equal(boxes.find((b) => b.id === 'btn_log_export').z, 1, '导出按钮 z=1（F2 审查 P1：缺省 z=0 ≤ 面板 z0 → zconflict）');
  const vf = verifyLayout(boxes);
  assert.equal(vf.ok, true, `20 条记录布局自检通过（${vf.issues.map((i) => i.boxId + ':' + i.issue).join('|')}）`);
  // 无 records 参数 → 0 条头部
  const none = settingsLayout(state(), {});
  assert.equal(none.find((b) => b.id === 'log_records_head').text.includes('0 条'), true, 'records 缺省');
  assert.equal(none.filter((b) => b.kind === 'listitem').length, 0);
  // levelValue/channels 显式 opts 臂
  const filtered = settingsLayout(state(), { records, levelValue: 7, channels: ['ui'] });
  assert.equal(filtered.find((b) => b.id === 'log_records_head').text.includes('20 条'), true, 'levelValue/channels 显式');
  // 缺口⑤：缺省阈值 mapLevel(state.logPrefs.level='debug')=4 与 filterLogs 缺省 4 一致
  const defaults = settingsLayout(state({ logPrefs: { level: 'debug' } }), { records });
  assert.equal(defaults.find((b) => b.id === 'log_records_head').text.includes('20 条'), true, 'debug 档含 info 记录（≤4）');
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