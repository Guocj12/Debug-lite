'use strict';
/* views/gacha.js —— 开箱屏（frontend-spec §6.4 + docs/screens.md gacha 表）。
 * panel_gacha(400,210,480,300)：段位下拉/次数 Field/开箱按钮；results 面板 grid(96,420,6,168,108,16)。
 * busy → 按钮禁用；tier_locked 等 → snackbar（effects 层）；样式从简（品质色条 + 名称）。
 */
import { box, panel, button, verifyLayout } from '../ui/layout.js';
import { SIZES } from '../ui/sizes.js';
import { boxesToHtml } from './html.js';

const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const GRID_COLS = 6;
const MAX_CARDS = 12; // 6 列 × 2 行（420..528 / 544..652，与 results 面板 420..660 对齐）

export function gachaLayout(state, opts) {
  const o = opts || {};
  const busy = !!(state.gacha && state.gacha.opening);
  const times = (state.gacha && state.gacha.times) || 1;
  const boxes = [
    panel('panel_gacha', 400, 210, 480, 300),
    box('sel_tier', 'field', 424, 250, 432, 40, { z: 3, parent: 'panel_gacha', action: 'tier/set', valueKey: 'tier', value: state.tier, text: '开箱段位', options: TIERS, disabled: busy }),
    box('fld_times', 'field', 424, 306, 432, 40, { z: 3, parent: 'panel_gacha', action: 'gacha/times', valueKey: 'times', value: String(times), text: '开箱次数 1..10' }),
    button('btn_open', 560, 368, { text: busy ? '开箱中…' : '开箱', action: busy ? null : 'box/open', payload: busy ? undefined : { times }, disabled: busy, parent: 'panel_gacha' }),
    panel('results', 96, 420, 1088, 240),
  ];
  const items = (state.gacha && state.gacha.lastResult) || [];
  const shown = items.slice(-MAX_CARDS);
  if (items.length === 0) {
    boxes.push(box('empty_hint', 'text', 96, 460, 1088, 24, { z: 3, parent: 'results', text: '暂无开箱结果 —— 选择次数后点「开箱」', visible: true }));
  } else {
    shown.forEach((it, i) => {
      boxes.push(box(`res${i + 1}`, 'card', 96 + (i % GRID_COLS) * (SIZES.gridCell.w + SIZES.gridGap), 420 + Math.floor(i / GRID_COLS) * (SIZES.gridCell.h + SIZES.gridGap), SIZES.gridCell.w, SIZES.gridCell.h, { z: 3, parent: 'results', text: `${it.name || it.templateId || it.uid}`, action: null, q: it.quality || 'common' }));
    });
  }
  return boxes;
}

export function gachaHtml(state) {
  return boxesToHtml(gachaLayout(state));
}

export { TIERS };
