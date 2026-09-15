'use strict';
/* views/menu.js —— 主菜单四态（frontend-spec §6.1 + docs/screens.md menu 表）。
 * loading（health 未回）→ error（serverOk=false，重试）→ empty（无角色物品，先去仓库）→ ready（五按钮）。
 */
import { button, panel, box, stack } from '../ui/layout.js';
import { boxesToHtml } from './html.js';

const BTN_Y0 = 268;   // 按钮栈起点（screens.md：btn_ai y=268）
const BTN_STEP = 52;  // 步距（40 + gap 12）

// 四态判定（供视图与测试共用）
export function menuPhase(state) {
  if (state.meta.serverOk === null) return 'loading';
  if (state.meta.serverOk === false) return 'error';
  const hasRole = !!(state.warehouse && state.warehouse.buckets && state.warehouse.buckets.role && state.warehouse.buckets.role.length);
  if (!hasRole && !(state.loadout && state.loadout.role)) return 'empty';
  return 'ready';
}

export function menuLayout(state) {
  const phase = menuPhase(state);
  const boxes = [panel('panel_menu', 360, 180, 560, 360)];
  boxes.push(box('title', 'text', 408, 216, 464, 32, { z: 3, parent: 'panel_menu', text: phase === 'error' ? '连接失败' : phase === 'loading' ? '加载中…' : phase === 'empty' ? '暂无可用角色' : 'Debug-Lite v3' }));
  if (phase === 'loading') {
    return [...boxes, box('hint', 'text', 408, 540, 464, 24, { z: 4, text: '正在连接服务器 /api/v1…' })];
  }
  if (phase === 'error') {
    return [
      ...boxes,
      box('hint', 'text', 408, 540, 464, 24, { z: 4, text: '无法连接后端，可点击重试', parent: 'panel_menu' }),
      button('btn_retry', 560, 268, { text: '重试', action: 'boot', parent: 'panel_menu' }),
    ];
  }
  const items = [
    { id: 'btn_ai', text: 'AI 编辑', action: 'goto', payload: { screen: 'editor' } },
    { id: 'btn_wh', text: '仓库装配', action: 'goto', payload: { screen: 'warehouse' } },
    { id: 'btn_gacha', text: '开箱', action: 'goto', payload: { screen: 'gacha' } },
    { id: 'btn_battle', text: '对战', action: 'goto', payload: { screen: 'battle' } },
    { id: 'btn_settings', text: '设置', action: 'goto', payload: { screen: 'settings' } },
  ].map((x) => ({ ...x, parent: 'panel_menu' }));
  const btns = stack(BTN_Y0, items.map((x) => button(x.id, 560, 0, { text: x.text, action: x.action, payload: x.payload, parent: x.parent })), { gap: 12 });
  const hint = phase === 'empty'
    ? box('hint', 'text', 408, 540, 464, 24, { z: 4, text: '提示：先到「开箱」获得角色物品，再到「仓库装配」出战', parent: 'panel_menu' })
    : box('hint', 'text', 408, 540, 464, 24, { z: 4, text: '按键 1..5 可快速进入对应屏（ Enter = AI 编辑 ）', parent: 'panel_menu' });
  return [...boxes, ...btns, hint];
}

export function menuHtml(state) {
  return boxesToHtml(menuLayout(state));
}
