// views/shell.js —— 通用外壳布局（frontend-spec §6.0；盒子坐标以 docs/screens.md 各屏盒子表为准）
// screens.md 全屏共用行：logo(16,9,180,46,z1) / tierBadge(1080,20,72,24,z1)；主菜单另加 seedLit(1160,20,112,24,z1)。
// ★screens.md 的盒子表里没有全宽 header 盒（ASCII 只见 logo 框）→ 原 shell_header(0,0,1280,64,z5) 与 shell_log
// (1184,16,96,32) 已移除（未登记即不合规）；仅保留 z0 背景层与 shell_main 内容区（kind=region，供自检器豁免重叠）。
import { SHELL, SIZES } from '../ui/sizes.js';

export function shellLayout(state) {
  const st = state || {};
  const boxes = [
    {
      id: 'basemap_header', kind: 'region', parent: null,
      x: 0, y: 0, w: SIZES.viewportW, h: SIZES.headerH, z: 0, visible: true, style: 'header',
    },
    {
      id: 'logo', kind: 'logo', parent: null,
      x: SHELL.logo.x, y: SHELL.logo.y, w: SHELL.logo.w, h: SHELL.logo.h, z: SHELL.logo.z, visible: true,
      text: 'Debug-Lite v3',
      goto: 'menu', // 全屏唯一「返回主菜单」入口（表内不新增盒；配合 mount 的 Esc 快捷键）
    },
    {
      id: 'tierBadge', kind: 'badge', parent: null,
      x: SHELL.tierBadge.x, y: SHELL.tierBadge.y, w: SHELL.tierBadge.w, h: SHELL.tierBadge.h, z: SHELL.tierBadge.z,
      visible: true, style: `q-${st.tier || 'common'}`, text: st.tier || 'common',
    },
    {
      id: 'shell_main', kind: 'region', parent: null,
      x: 0, y: SIZES.headerH, w: SIZES.viewportW, h: SIZES.viewportH - SIZES.headerH, z: 0, visible: true,
    },
  ];
  // seedLit 仅主菜单（screens.md：menu 表列 seedLit，其余六屏表无此行）
  if (st.screen === 'menu') {
    boxes.push({
      id: 'seedLit', kind: 'text', parent: null,
      x: SHELL.seedLit.x, y: SHELL.seedLit.y, w: SHELL.seedLit.w, h: SHELL.seedLit.h, z: SHELL.seedLit.z,
      visible: true, style: 'right muted', text: `seed:${st.seed === null || st.seed === undefined ? '—' : st.seed}`,
    });
  }
  return boxes;
}