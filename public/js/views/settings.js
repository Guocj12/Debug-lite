// views/settings.js —— 设置屏（frontend-spec §6.7；坐标口径 = docs/screens.md「设置 settings」盒子表）
import { SIZES } from '../ui/sizes.js';
import { button } from '../ui/layout.js';

// 级别数值刻度与 shared/log.js LEVELS 一致（F2 审查 P1：info=3/debug=4/trace=5 —— 原索引刻度 0..7 与 DLLog 记录
// levelValue 偏差一档，导致 info 档混入 debug、debug 档混入 trace）。silent=-1/all=99 为阈值常量。
export const LOG_LEVELS = Object.freeze({ silent: -1, fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5, all: 99 });

// 日志通道全集（shared/log.js CHANNELS + 前端新增 'ui'，§2.1「通道：render|ui|api|store|editor|perf|log」）
export const CHANNELS = Object.freeze([
  'rng', 'field', 'effects', 'items', 'roles', 'skills', 'bullets', 'engine', 'damage',
  'ai.ast', 'ai.runtime', 'unlock', 'api', 'cli', 'ranked',
  'store', 'view', 'render', 'editor', 'ui', 'perf', 'log',
]);
export const LOG_LEVEL_CYCLE = ['info', 'debug', 'trace']; // sel_level 循环档（§6.7 级别下拉）

// screens.md settings 表：left(16,80,560,400,z2) fld_seed(40,120,280,40,z3) sel_tier(40,176,280,40,z3)
// about(40,240,512,140,z3) logPanel(600,80,664,400,z2) sel_level(624,120,120,40,z3)
// channels(624,176,616,140,z3) ring(624,348,616,120,z3) save_row(16,500,560,80,z2)
// btn_export(40,516,120,40,z3) btn_import(176,516,120,40,z3)
const LEFT = { x: 16, y: 80, w: 560, h: 400, z: 2 };
const FLD_SEED = { x: 40, y: 120, w: 280, h: 40, z: 3 };
const SEL_TIER = { x: 40, y: 176, w: 280, h: 40, z: 3 };
const ABOUT = { x: 40, y: 240, w: 512, h: 140, z: 3 };
const LOG_PANEL = { x: 600, y: 80, w: 664, h: 400, z: 2 };
const SEL_LEVEL = { x: 624, y: 120, w: 120, h: 40, z: 3 };
const CHANNELS_BOX = { x: 624, y: 176, w: 616, h: 140, z: 3 };
const RING = { x: 624, y: 348, w: 616, h: 120, z: 3 };
const SAVE_ROW = { x: 16, y: 500, w: 560, h: 80, z: 2 };
const BTN_EXPORT = { x: 40, y: 516, w: 120, h: 40, z: 3 };
const BTN_IMPORT = { x: 176, y: 516, w: 120, h: 40, z: 3 };
// 容器内元素几何（screens.md 未逐列的小盒；均落在对应容器内且互不相交）
const CHIP = { x0: CHANNELS_BOX.x + 16, y0: CHANNELS_BOX.y + 38, w: 80, h: 20, cols: 6, gx: 6, gy: 6 };
const RING_ROW = { x: RING.x + 16, y0: RING.y + 32, w: RING.w - 32, h: 20, pitch: 24, max: 2 }; // 标题行 360..378 之下
const RING_BTN_Y = RING.y + 80; // 428：记录行底 424 之下、容器底 468 之上

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

// 通道开关状态（纯）：channels 映射里非 silent/off 视为开
export function channelOn(channels, ch) {
  const v = (channels || {})[ch];
  return v !== undefined && v !== null && v !== 'silent' && v !== 'off' && v !== false;
}

// 布局：左（种子/段位/关于）+ 右（级别/通道/环形缓冲）+ 底部（导出/导入/日志导出复位）
export function settingsLayout(state, opts) {
  const o = opts || {};
  const prefs = state.logPrefs || {};
  const records = filterLogs(o.records || [], {
    levelValue: o.levelValue === undefined ? mapLevel(prefs.level) : o.levelValue,
    channels: o.channels || null,
  });
  const tierNext = ['common', 'rare', 'epic', 'legendary', 'mythic'];
  const boxes = [
    { id: 'left', kind: 'panel', parent: null, ...LEFT, visible: true, text: '设置' },
    {
      id: 'fld_seed', kind: 'field', parent: 'left',
      x: FLD_SEED.x, y: FLD_SEED.y, w: FLD_SEED.w, h: FLD_SEED.h, z: FLD_SEED.z, visible: true,
      text: state.seed === null || state.seed === undefined ? 'SEED：（未设，点击随机）' : `SEED：${state.seed}（点击随机）`,
      action: 'seed/random',
    },
    {
      id: 'sel_tier', kind: 'select', parent: 'left',
      x: SEL_TIER.x, y: SEL_TIER.y, w: SEL_TIER.w, h: SEL_TIER.h, z: SEL_TIER.z, visible: true,
      text: `TIER：${state.tier}（点击下一档）`,
      action: 'tier/set', payload: { tier: tierNext[(tierNext.indexOf(state.tier) + 1) % tierNext.length] },
    },
    {
      id: 'about', kind: 'text', parent: 'left', style: 'wrap muted',
      x: ABOUT.x, y: ABOUT.y, w: ABOUT.w, h: ABOUT.h, z: ABOUT.z, visible: true,
      text: `Debug-Lite v3 — 编程式自动对战（零构建原生 ESM）。\n`
        + `段位：${state.tier}　seed：${state.seed === null || state.seed === undefined ? '—' : state.seed}　`
        + `存档版本 schemaVersion=${state.schemaVersion === undefined ? 1 : state.schemaVersion}\n`
        + `存档：localStorage dl.v3.state（仓库 / 装配 / 段位 / seed）\n`
        + `布局基准 1280×720；坐标由 layout(state)→Box[] 产出（docs/screens.md 为期望快照）`,
    },
    { id: 'logPanel', kind: 'panel', parent: null, ...LOG_PANEL, visible: true, text: '日志面板' },
    {
      id: 'sel_level', kind: 'select', parent: 'logPanel',
      x: SEL_LEVEL.x, y: SEL_LEVEL.y, w: SEL_LEVEL.w, h: SEL_LEVEL.h, z: SEL_LEVEL.z, visible: true,
      text: prefs.level || 'debug',
      action: 'log/level', payload: { level: LOG_LEVEL_CYCLE[(LOG_LEVEL_CYCLE.indexOf(prefs.level) + 1) % LOG_LEVEL_CYCLE.length] },
    },
    {
      id: 'channels', kind: 'region', parent: 'logPanel', style: 'panel',
      x: CHANNELS_BOX.x, y: CHANNELS_BOX.y, w: CHANNELS_BOX.w, h: CHANNELS_BOX.h, z: CHANNELS_BOX.z,
      visible: true, text: '通道（点击开关）',
    },
  ];
  // 通道勾选（19+ 通道；容器内 z4）
  const chMap = prefs.channels || {};
  CHANNELS.forEach((ch, i) => {
    const on = channelOn(chMap, ch);
    boxes.push({
      id: `ch_${ch}`, kind: 'chip', parent: 'channels', style: on ? 'on' : 'off',
      x: CHIP.x0 + (i % CHIP.cols) * (CHIP.w + CHIP.gx),
      y: CHIP.y0 + Math.floor(i / CHIP.cols) * (CHIP.h + CHIP.gy),
      w: CHIP.w, h: CHIP.h, z: 4, visible: true, text: ch,
      action: 'log/channel', payload: { channel: ch, on: !on },
    });
  });
  // 环形缓冲（最近记录；容器内 z4 行）
  boxes.push({
    id: 'ring', kind: 'region', parent: 'logPanel', style: 'panel',
    x: RING.x, y: RING.y, w: RING.w, h: RING.h, z: RING.z, visible: true,
    text: `环形缓冲（${records.length} 条）`,
  });
  const tail = records.slice(-RING_ROW.max).reverse();
  tail.forEach((r, i) => {
    boxes.push({
      id: `log_rec_${i}`, kind: 'listitem', parent: 'ring',
      x: RING_ROW.x, y: RING_ROW.y0 + i * RING_ROW.pitch, w: RING_ROW.w, h: RING_ROW.h, z: 4, visible: true,
      text: `[${r.level}] ${r.channel}.${r.event}`, detail: typeof r.msg === 'string' ? r.msg : '',
    });
  });
  if (tail.length === 0) {
    boxes.push({ id: 'log_rec_empty', kind: 'text', parent: 'ring', x: RING_ROW.x, y: RING_ROW.y0, w: RING_ROW.w, h: RING_ROW.h, z: 4, visible: true, text: '（无记录）' });
  }
  // 日志导出/复位（表内未列；置于 ring 容器底部一行，与记录行不重叠）
  boxes.push(button('btn_log_export', RING_ROW.x, RING_BTN_Y, '导出日志', {
    parent: 'ring', ghost: true, z: 4, action: 'log/export',
  }));
  boxes.push(button('btn_log_reset', RING_ROW.x + SIZES.buttonGhost.w + 12, RING_BTN_Y, '复位日志', {
    parent: 'ring', ghost: true, z: 4, action: 'log/reset',
  }));
  // 存档行（表内 save_row + 导出/导入 120×40 + 说明）
  boxes.push({ id: 'save_row', kind: 'panel', parent: null, ...SAVE_ROW, visible: true, text: '' });
  boxes.push({
    id: 'btn_export', kind: 'button', parent: 'save_row',
    x: BTN_EXPORT.x, y: BTN_EXPORT.y, w: BTN_EXPORT.w, h: BTN_EXPORT.h, z: BTN_EXPORT.z, visible: true,
    text: '导出存档', action: 'save/export',
  });
  boxes.push({
    id: 'btn_import', kind: 'button', parent: 'save_row',
    x: BTN_IMPORT.x, y: BTN_IMPORT.y, w: BTN_IMPORT.w, h: BTN_IMPORT.h, z: BTN_IMPORT.z, visible: true,
    text: '导入存档', action: 'save/import',
  });
  boxes.push({
    id: 'save_hint', kind: 'text', parent: 'save_row', style: 'wrap muted',
    x: 312, y: BTN_EXPORT.y, w: 248, h: 40, z: 3, visible: true,
    text: '导入：选择存档 JSON（校验 schemaVersion 后整体替换仓库/装配）',
  });
  return boxes;
}

