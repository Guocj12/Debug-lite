'use strict';
/* views/index.js —— 屏注册表（spec §1.3 步骤4：views 注册（7 屏））。
 * renderScreen(screen, state, ctx) → HTML 字符串（未实现屏走 fallback 占位）。
 */
import { shellLayout } from './shell.js';
import { menuLayout, menuPhase } from './menu.js';
import { settingsLayout } from './settings.js';
import { boxesToHtml } from './html.js';

// 各屏视图实现（R3..R6 逐批补齐；此处只列已实现屏）
const SCREENS = {
  menu: (state) => boxesToHtml([...shellLayout(state, { main: false }), ...menuLayout(state)]),
  settings: (state, ctx) => boxesToHtml([...shellLayout(state, { main: false }), ...settingsLayout(state, ctx && ctx.records)]),
};

function fallbackHtml(screen) {
  return boxesToHtml([
    { id: 'fallback', kind: 'text', x: 480, y: 300, w: 320, h: 80, z: 3, visible: true, text: `「${screen}」屏尚未接线（后续批次交付）` },
  ]);
}

// records：函数（环形缓冲 dump）或数组 —— 统一解析为数组（mount 层注入缝）
export function renderScreen(screen, state, ctx) {
  const c = ctx || {};
  const records = Array.isArray(c.records) ? c.records : (typeof c.records === 'function' ? c.records() : []);
  const fn = SCREENS[screen];
  return fn ? fn(state, { ...c, records }) : fallbackHtml(screen);
}

export { SCREENS, menuPhase };
