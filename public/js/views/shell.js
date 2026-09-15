'use strict';
/* views/shell.js —— 通用外壳（frontend-spec §6.0 + docs/screens.md 每屏盒子表首三行）。
 * header：logo / tierBadge / seedLit（仅主菜单）；main 区 y=64..720；basemap z0 背景层。
 */
import { VIEW, HEADER_H, SHELL } from '../ui/sizes.js';
import { box, panel } from '../ui/layout.js';
import { boxesToHtml } from './html.js';

// basemap：整屏背景（z0；不遮内容，screens.md 表外通用层）
export function shellLayout(state, opts) {
  const o = opts || {};
  const screen = state.screen;
  return [
    box('basemap', 'basemap', 0, 0, VIEW.w, VIEW.h, { z: 0, text: '' }),
    box('logo', 'logo', SHELL.logo.x, SHELL.logo.y, SHELL.logo.w, SHELL.logo.h, { z: 1, text: 'Debug-Lite v3' }),
    box('tierBadge', 'badge', SHELL.tierBadge.x, SHELL.tierBadge.y, SHELL.tierBadge.w, SHELL.tierBadge.h, { z: 1, text: state.tier }),
    ...(screen === 'menu' ? [box('seedLit', 'seed', SHELL.seedLit.x, SHELL.seedLit.y, SHELL.seedLit.w, SHELL.seedLit.h, { z: 1, text: state.seed === null ? 'seed: --' : `seed: ${state.seed}` })] : []),
    ...(o.main !== false ? [box('shell_main', 'panel', 0, HEADER_H, VIEW.w, VIEW.h - HEADER_H, { z: 1 })] : []),
  ];
}

export function shellHtml(state, opts) {
  return boxesToHtml(shellLayout(state, opts));
}
