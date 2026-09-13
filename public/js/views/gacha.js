// views/gacha.js —— 开箱屏（frontend-spec §6.4；中心面板 center(480,300) + 结果 grid(96,420,6,168,108,16)）
import { SIZES, SPACES } from '../ui/sizes.js';
import { center, panel, button, grid } from '../ui/layout.js';

export const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
export const TIMES_OPTIONS = [1, 5, 10];

// 结果卡：品质色条 + 名称 + 类型徽标（质量等级由 card.style 表达）
export function gachaLayout(state) {
  const c = center(480, 300); // x=400 y=210
  const boxes = [
    panel(c.x, c.y, 480, 300, state.gacha.opening ? '开箱中…' : '开箱', 'gacha_panel'),
  ];
  // 段位选择（5 档 radio）
  let ty = c.y + 72;
  for (const t of TIERS) {
    boxes.push({
      id: `gacha_tier_${t}`, kind: 'radio', parent: 'gacha_panel',
      x: c.x + SPACES.s4, y: ty, w: 104, h: 28, z: 1, visible: true,
      text: t, style: state.tier === t ? 'on' : 'off',
      action: 'tier/set', payload: { tier: t },
    });
    ty += 34;
  }
  // 次数快选 + 开箱按钮
  let tx = c.x + 248;
  for (const n of TIMES_OPTIONS) {
    boxes.push(button(`gacha_times_${n}`, tx, c.y + 120, `×${n}`, {
      parent: 'gacha_panel', z: 1, ghost: true, action: 'box/open', payload: { times: n },
      disabled: state.gacha.opening,
    }));
    tx += SIZES.buttonGhost.w + 8;
  }
  boxes.push(button('gacha_go', c.x + 248, c.y + 180, state.gacha.opening ? '开箱中…' : '开箱', {
    parent: 'gacha_panel', z: 1, style: 'primary', action: 'box/open', payload: { times: 1 },
    disabled: state.gacha.opening,
  }));
  // 结果区（§6.4 结果 grid(96,420,6,168,108,16)）
  const items = (state.gacha.lastResult && state.gacha.lastResult.items) || [];
  if (items.length > 0) {
    const cards = items.map((it, i) => ({
      id: `gacha_card_${i}`, kind: 'gridcell', parent: null,
      style: `q-${it.quality || 'common'}`,
      text: it.name || it.templateId || it.kind, detail: it.kind,
    }));
    boxes.push(...grid(96, 420, 6, SIZES.gridCell.w, SIZES.gridCell.h, 16, cards));
  } else if (!state.gacha.opening) {
    // y=560：结果区（面板底 510 之下，避免与 z0 面板同层重叠——F3 审查实测 verifyLayout 曾报 gacha_panel∩gacha_empty overlap）
    boxes.push({
      id: 'gacha_empty', kind: 'text', parent: null, x: 96, y: 560, w: 600, h: 24, z: 0, visible: true,
      text: '暂无开箱结果：选择段位与次数后开始',
    });
  }
  return boxes;
}