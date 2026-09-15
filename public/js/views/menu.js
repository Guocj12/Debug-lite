// views/menu.js —— 主菜单（frontend-spec §6.1；坐标口径 = docs/screens.md「主菜单 menu」盒子表）
import { button } from '../ui/layout.js';

// screens.md menu 表：panel_menu(360,180,560,360,z2) title(408,216,464,32,z3) hint(408,540,464,24,z4)
// btn_ai/wh/gacha/battle/settings = (560,268/320/372/424/476,160,40,z4)（步距 52 = 40 + 12）
const PANEL = { x: 360, y: 180, w: 560, h: 360, z: 2 };
const TITLE = { x: 408, y: 216, w: 464, h: 32, z: 3 };
const HINT = { x: 408, y: 540, w: 464, h: 24, z: 4 };
const BTN_X = 560;
const BTN_Y0 = 268;
const BTN_PITCH = 52;

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

// 四态文案（loading/error/empty/ready；title 与 hint 分别承载）
const TITLE_TEXT = { loading: '加载中', error: '连接失败', empty: 'Debug-Lite v3', ready: 'Debug-Lite v3' };
const HINT_TEXT = {
  loading: '正在连接服务端…',
  error: '连接失败：服务端不可达',
  empty: '无存档：先开箱/装配，或直接开始',
  ready: '选择一项进入',
};

export function menuLayout(state) {
  const phase = menuPhase(state);
  const boxes = [
    {
      id: 'panel_menu', kind: 'panel', parent: null,
      x: PANEL.x, y: PANEL.y, w: PANEL.w, h: PANEL.h, z: PANEL.z, visible: true, text: '',
    },
    {
      id: 'title', kind: 'title', parent: 'panel_menu',
      x: TITLE.x, y: TITLE.y, w: TITLE.w, h: TITLE.h, z: TITLE.z, visible: true, text: TITLE_TEXT[phase],
    },
  ];
  // error 态：按钮栈位置只放「重试」（其余屏在服务端不可达时均不可用）；z4 与按钮同层且不共存 → 无重叠
  if (phase === 'error') {
    boxes.push(button('btn_boot', BTN_X, BTN_Y0 + BTN_PITCH * 4, '重试', {
      parent: 'panel_menu', action: 'boot', z: 4,
    }));
  } else {
    BTN.forEach((b, i) => {
      boxes.push(button(b.id, BTN_X, BTN_Y0 + BTN_PITCH * i, b.text, {
        parent: 'panel_menu', goto: b.goto, z: 4,
        disabled: phase === 'loading',
      }));
    });
  }
  boxes.push({
    id: 'hint', kind: 'text', parent: null, style: 'center muted',
    x: HINT.x, y: HINT.y, w: HINT.w, h: HINT.h, z: HINT.z, visible: true, text: HINT_TEXT[phase],
  });
  return boxes;
}