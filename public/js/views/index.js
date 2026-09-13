// views/index.js —— 视图注册表（frontend-spec §1.3/§6：7 屏；F2 先挂 shell/menu/settings）
import { shellLayout } from './shell.js';
import { menuLayout } from './menu.js';
import { settingsLayout } from './settings.js';

// 各屏 layout 签名统一 (state, opts) → Box[]（不含 shell；shell 由 renderScreen 拼装）
export const VIEWS = {
  menu: { layout: menuLayout },
  settings: { layout: settingsLayout },
  // F3/F4/F5/F6/F7 注册：warehouse/gacha/battle/replay/editor
  warehouse: null,
  gacha: null,
  battle: null,
  replay: null,
  editor: null,
};

export function renderScreen(state, opts) {
  const o = opts || {};
  const sel = o.views || VIEWS;
  const v = (sel[state.screen] || VIEWS[state.screen]);
  const screenBoxes = v && v.layout ? v.layout(state, o) : [{ id: 'screen_unimplemented', kind: 'text', parent: null, x: 16, y: 80, w: 640, h: 24, z: 1, visible: true, text: `${state.screen} 屏尚未实现（F2 进度）` }];
  return { shell: shellLayout(state), main: screenBoxes, screen: state.screen };
}

export function allBoxes(render) {
  return [...render.shell, ...render.main];
}