'use strict';
/* views/settings.js —— 设置屏（frontend-spec §6.7 + docs/screens.md settings 表）。
 * left：seed Field / 段位选择 / 关于；logPanel：级别下拉 / 通道 chips / 环形缓冲列表；
 * save_row：导出/导入存档（R7 打磨文件选择器）。
 */
import { box, panel, button, verifyLayout } from '../ui/layout.js';
import { boxesToHtml } from './html.js';

const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const LEVELS = ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'];
const CHANNELS = [
  'rng', 'field', 'effects', 'items', 'roles', 'skills', 'bullets', 'engine',
  'damage', 'ai.ast', 'ai.runtime', 'unlock', 'api', 'cli', 'ranked',
  'store', 'view', 'ui', 'render', 'editor', 'perf', 'log',
];

export { TIERS, LEVELS, CHANNELS };

// 日志面板：环形缓冲过滤（级别 ≥ 当前级别；通道勾选清空时不过滤）
export function filterLogs(records, prefs) {
  const order = { silent: -1, fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
  const min = order[prefs.level] === undefined ? 4 : order[prefs.level];
  const chans = prefs.channels || {};
  const hasChan = Object.keys(chans).length > 0;
  return (records || []).filter((r) => (order[r.level] === undefined ? true : order[r.level] <= min))
    .filter((r) => (hasChan ? chans[r.channel] !== undefined : true));
}

export function settingsLayout(state, records) {
  const s = state;
  const boxes = [
    panel('left', 16, 80, 560, 400),
    panel('logPanel', 600, 80, 664, 400),
    panel('save_row', 16, 500, 560, 80),
    box('channels', 'panel', 624, 176, 616, 140, { z: 2, parent: 'logPanel' }),
    box('fld_seed', 'field', 40, 120, 280, 40, { z: 3, parent: 'left', action: 'seed/set', valueKey: 'seed', value: s.seed === null || s.seed === undefined ? '' : String(s.seed), text: 'seed' }),
    box('sel_tier', 'field', 40, 176, 280, 40, { z: 3, parent: 'left', action: 'tier/set', valueKey: 'tier', value: s.tier, text: '段位', options: TIERS }),
    box('about', 'text', 40, 240, 512, 140, { z: 3, parent: 'left', text: `Debug-Lite v3${s.meta.version ? ' @' + s.meta.version : ''}\n编程式自动对战 / 零框架前端 / 1280×720 基准\n日志：URL ?log=trace 或本屏调整；F12 控制台可 DLLog.setLevel` }),
    box('sel_level', 'field', 624, 120, 120, 40, { z: 3, parent: 'logPanel', action: 'log/set', valueKey: 'level', value: s.logPrefs.level, text: '日志级别', options: LEVELS }),
    box('ring', 'text', 624, 348, 616, 120, { z: 3, parent: 'logPanel', text: ringText(filterLogs(records || [], s.logPrefs)) }),
  ];
  // 通道 chips（§6.7 通道勾选）：两行网格（11/行 × 2）；on ⇄ off
  for (let i = 0; i < CHANNELS.length; i++) {
    const col = i % 11;
    const row = Math.floor(i / 11);
    const on = (s.logPrefs.channels || {})[CHANNELS[i]] !== undefined;
    boxes.push(box(`ch_${CHANNELS[i]}`, 'chip', 624 + col * 56, 180 + row * 28, 52, 24, { z: 3, parent: 'channels', text: (on ? '●' : '○') + CHANNELS[i], action: 'log/set', payload: { channels: { [CHANNELS[i]]: on ? null : 'debug' } } }));
  }
  boxes.push(box('btn_export', 'button', 40, 516, 120, 40, { z: 3, parent: 'save_row', style: 'primary', text: '导出存档', action: 'save/export' }));
  boxes.push(box('btn_import', 'button', 176, 516, 120, 40, { z: 3, parent: 'save_row', text: '导入存档', action: 'save/import' }));
  return boxes;
}

function ringText(list) {
  const tail = (list || []).slice(-12);
  if (tail.length === 0) return '（暂无日志记录）';
  return tail.map((r) => `#${r.seq} [${r.level}] ${r.channel} ${r.event} ${r.msg === undefined ? '' : String(r.msg).slice(0, 60)}`).join('\n');
}

export function settingsHtml(state, records) {
  return boxesToHtml(settingsLayout(state, records));
}
