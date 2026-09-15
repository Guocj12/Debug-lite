// views/index.js —— 视图注册表（frontend-spec §1.3/§6：7 屏；F5 挂 replay）
import { shellLayout } from './shell.js';
import { menuLayout } from './menu.js';
import { settingsLayout } from './settings.js';
import { gachaLayout } from './gacha.js';
import { warehouseLayout } from './warehouse.js';
import { battleLayout } from './battle.js';
import { replayLayout } from './replay.js';
import { editorLayout } from './editor.js';

// 各屏 layout 签名统一 (state, opts) → Box[]（不含 shell；shell 由 renderScreen 拼装）
export const VIEWS = {
  menu: { layout: menuLayout },
  settings: { layout: settingsLayout },
  gacha: { layout: gachaLayout },
  warehouse: { layout: warehouseLayout },
  battle: { layout: battleLayout },
  replay: { layout: replayLayout },
  editor: { layout: editorLayout },
};

export function renderScreen(state, opts) {
  const o = opts || {};
  const sel = o.views || VIEWS;
  // ★F8 修复：mount 传下的 records 是**函数**（日志源），而 settingsLayout 期望数组（filterLogs(records)）
  // ——原样透传 → 真实浏览器打开设置屏即 TypeError: (records||[]).filter is not a function（整屏 paint 崩溃）。
  // 此处统一解析为数组后再交给各屏 layout（layout 保持纯函数、入参形状稳定）。
  const rec = typeof o.records === 'function' ? o.records() : o.records;
  const pass = { ...o, records: rec };
  const v = (sel[state.screen] || VIEWS[state.screen]);
  const screenBoxes = v && v.layout ? v.layout(state, pass) : [{ id: 'screen_unimplemented', kind: 'text', parent: null, x: 16, y: 80, w: 640, h: 24, z: 1, visible: true, text: `${state.screen} 屏尚未实现` }];
  return { shell: shellLayout(state), main: screenBoxes, screen: state.screen };
}

export function allBoxes(render) {
  return [...render.shell, ...render.main];
}