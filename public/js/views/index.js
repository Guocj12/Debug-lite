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
  const v = (sel[state.screen] || VIEWS[state.screen]);
  const screenBoxes = v && v.layout ? v.layout(state, o) : [{ id: 'screen_unimplemented', kind: 'text', parent: null, x: 16, y: 80, w: 640, h: 24, z: 1, visible: true, text: `${state.screen} 屏尚未实现` }];
  return { shell: shellLayout(state), main: screenBoxes, screen: state.screen };
}

export function allBoxes(render) {
  return [...render.shell, ...render.main];
}