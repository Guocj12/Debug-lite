// views/shell.js —— 通用外壳布局（frontend-spec §6.0；header y0..64 + main y64..720 纯布局）
import { SIZES, SPACES } from '../ui/sizes.js';
import { panel, button } from '../ui/layout.js';

const HEADER_H = SIZES.headerH;

export function shellLayout(state) {
  const boxes = [
    {
      id: 'shell_header', kind: 'fullwidth', parent: null,
      x: 0, y: 0, w: SIZES.viewportW, h: HEADER_H, z: 5, visible: true,
      style: 'header', text: 'Debug-Lite v3',
    },
    {
      id: 'shell_tier', kind: 'badge', parent: 'shell_header',
      x: 1120, y: (HEADER_H - 24) / 2, w: 24, h: 24, z: 6, visible: true,
      style: `q-${state.tier}`, text: state.tier,
    },
    {
      id: 'shell_seed', kind: 'text', parent: 'shell_header',
      x: 1156, y: (HEADER_H - 20) / 2, w: 28, h: 20, z: 6, visible: true,
      text: state.seed === null ? 'seed:—' : `seed:${state.seed}`,
    },
    button('shell_log', 1184, (HEADER_H - SIZES.buttonGhost.h) / 2, '日志', {
      ghost: true, z: 6, parent: 'shell_header', action: 'log/toggle',
    }),
  ];
  // main 区（y64..720）由各屏填充；外壳只占顶条
  boxes.push({
    id: 'shell_main', kind: 'region', parent: null,
    x: 0, y: HEADER_H, w: SIZES.viewportW, h: SIZES.viewportH - HEADER_H, z: 0, visible: true,
  });
  return boxes;
}