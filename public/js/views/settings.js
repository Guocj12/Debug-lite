// views/settings.js —— 设置屏（frontend-spec §6.7：日志面板——级别/通道勾选/记录列表/导出/复位）
import { SIZES, SPACES } from '../ui/sizes.js';
import { panel, button } from '../ui/layout.js';

// 级别数值刻度与 shared/log.js LEVELS 一致（F2 审查 P1：info=3/debug=4/trace=5 —— 原索引刻度 0..7 与 DLLog 记录
// levelValue 偏差一档，导致 info 档混入 debug、debug 档混入 trace）。silent=-1/all=99 为阈值常量。
export const LOG_LEVELS = Object.freeze({ silent: -1, fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5, all: 99 });

// 过滤（纯函数）：按 levelValue 阈值 + 通道集合（空集合 = 全部）
// 方向论证：与 DLLog log() 一致——lv ≤ 阈值才保留（shared/log.js: lv > effective → 丢弃；same direction）
export function filterLogs(records, opts) {
  const o = opts || {};
  const levelValue = o.levelValue === undefined ? 4 : o.levelValue; // 默认 debug（DLLog 刻度）
  const channels = o.channels || null;
  return (records || []).filter((r) => {
    const lv = r.levelValue === undefined ? mapLevel(r.level) : r.levelValue;
    if (lv > levelValue) return false;
    if (channels && channels.length > 0 && !channels.includes(r.channel)) return false;
    return true;
  });
}

function mapLevel(name) {
  const v = LOG_LEVELS[name];
  return v === undefined ? 4 : v; // 未知名兜底 4（debug）
}

// 导出（纯函数）：过滤后的 JSON 文本
export function exportLogs(records, opts) {
  return JSON.stringify(filterLogs(records, opts), null, 2);
}

// 布局：左面板（外观选项占位）+ 右面板（日志控制面）
export function settingsLayout(state, opts) {
  const o = opts || {};
  const records = filterLogs(o.records || [], {
    levelValue: o.levelValue === undefined ? mapLevel(state.logPrefs.level) : o.levelValue,
    channels: o.channels || null,
  });
  const boxes = [
    panel(16, 80, 560, 560, '外观', 'settings_left'),
    { id: 'settings_left_hint', kind: 'text', parent: 'settings_left', x: 32, y: 112, w: 500, h: 24, z: 1, visible: true, text: '（F7 打磨期扩展）' },
  ];
  boxes.push(panel(600, 80, 664, 560, '日志面板', 'settings_log'));
  // 级别下拉（三个常用级别；payload 带 level——F2 审查 P1：原 radio 无 payload → log/level 死控件）
  let ly = 116;
  for (const lv of ['info', 'debug', 'trace']) {
    boxes.push({ id: `log_level_${lv}`, kind: 'radio', parent: 'settings_log', x: 616, y: ly, w: 96, h: 28, z: 1, visible: true, text: lv, style: state.logPrefs.level === lv ? 'on' : 'off', action: 'log/level', payload: { level: lv } });
    ly += 36;
  }
  // 记录列表（最多列 10 行摘要——F2 审查 P1：12 行 30px 步进从 y260 起会与 y560 按钮行相交/遮蔽
  // （≥10 条即触发）；10 行 = 260..558 与按钮 560..592 无交。§6.7「最近 200 条」为数据窗口非渲染行数）
  boxes.push({ id: 'log_records_head', kind: 'text', parent: 'settings_log', x: 616, y: 236, w: 400, h: 20, z: 1, visible: true, text: `最近记录（${records.length} 条）` });
  let ry = 260;
  for (const r of records.slice(-10).reverse()) {
    boxes.push({
      id: `log_rec_${r.seq || ry}`, kind: 'listitem', parent: 'settings_log',
      x: 616, y: ry, w: 632, h: SIZES.listItem.h / 2, z: 1, visible: true,
      text: `[${r.level}] ${r.channel}.${r.event}`, detail: typeof r.msg === 'string' ? r.msg : '',
    });
    ry += 30;
  }
  // 导出/复位（z=1——F2 审查 P1：button() 缺省 z=0 ≤ 面板 z=0 → zconflict 自检每帧误报）
  boxes.push(button('btn_log_export', 616, 560, '导出', { parent: 'settings_log', action: 'log/export', ghost: true, z: 1 }));
  boxes.push(button('btn_log_reset', 732, 560, '复位', { parent: 'settings_log', action: 'log/reset', ghost: true, z: 1 }));
  return boxes;
}