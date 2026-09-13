// views/menu.js —— 主菜单（frontend-spec §6.1；四态：loading/ready/error/empty）
import { SIZES, SPACES } from '../ui/sizes.js';
import { center, panel, button } from '../ui/layout.js';

const BTN = [
  { id: 'btn_ai', text: 'AI 编辑', goto: 'editor' },
  { id: 'btn_wh', text: '仓库装配', goto: 'warehouse' },
  { id: 'btn_gacha', text: '开箱', goto: 'gacha' },
  { id: 'btn_battle', text: '对战', goto: 'battle' },
  { id: 'btn_settings', text: '设置', goto: 'settings' },
];

export function menuPhase(state) {
  if (state.meta.serverOk === null) return 'loading'; // 健康检查未回
  if (state.meta.serverOk === false) return 'error';
  if (state.loadout.role === null) return 'empty'; // 无存档：空态提示
  return 'ready';
}

export function menuLayout(state) {
  const phase = menuPhase(state);
  const c = center(560, 360);
  const boxes = [
    panel(c.x, c.y, 560, 360, phase === 'loading' ? '加载中' : 'Debug-Lite', 'menu_panel'),
  ];
  // 三态提示文本统一 y=236（面板 180 + 16 padding + 40 标题）；§6.1 按钮栈「y 从 260 起」为绝对坐标
  const textY = c.y + SPACES.s5 + SPACES.s4; // 180+24+16=236（SPACES 组合，无魔法数字）
  if (phase === 'loading') {
    boxes.push({ id: 'menu_loading', kind: 'text', parent: 'menu_panel', x: c.x + SPACES.s4, y: textY, w: 400, h: 24, z: 1, visible: true, text: '正在连接服务端…' });
  } else if (phase === 'error') {
    boxes.push({ id: 'menu_error', kind: 'text', parent: 'menu_panel', x: c.x + SPACES.s4, y: textY, w: 400, h: 24, z: 1, visible: true, text: '连接失败：服务端不可达' });
    boxes.push(button('btn_boot', c.x + 40, textY + SPACES.s8, '重试', { parent: 'menu_panel', action: 'boot', z: 1 }));
  } else {
    if (phase === 'empty') {
      boxes.push({ id: 'menu_empty', kind: 'text', parent: 'menu_panel', x: c.x + SPACES.s4, y: textY, w: 500, h: 24, z: 1, visible: true, text: '无存档：先开箱/装配，或直接开始' });
    }
    let y = 260; // §6.1「y 从 260 起」（绝对坐标；relative 会把 3/5 按钮推出面板，F2 审查 P1-1）
    for (const b of BTN) {
      boxes.push(button(b.id, c.x + (560 - SIZES.button.w) / 2, y, b.text, { parent: 'menu_panel', goto: b.goto, z: 1 }));
      y += SIZES.button.h + 12; // gap 12（§6.1）
    }
  }
  return boxes;
}