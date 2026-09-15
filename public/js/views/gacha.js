// views/gacha.js —— 开箱屏（frontend-spec §6.4；坐标口径 = docs/screens.md「开箱 gacha」盒子表）
import { SIZES } from '../ui/sizes.js';
import { grid } from '../ui/layout.js';

export const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
export const TIMES_MAX = 10; // §6.4 次数 Field(1..10)
// 结果列数：容器 results 宽 1088 = 6×168 + 5×16（精确铺满）→ 6 列；表内 res1..res4 为快照里实际存在的四张
// （x 步距 184 与 6 列公式一致：96/280/464/648/832/1016）。10 次开箱 → 6+4 两行，行 2 y=544..652 仍在容器内。
export const RESULT_COLS = 6;

// screens.md gacha 表：panel_gacha(400,210,480,300,z2) sel_tier(424,250,432,40,z3) fld_times(424,306,432,40,z3)
// btn_open(560,368,160,40,z4) results(96,420,1088,240,z2) res<i>(96+i*184,420,168,108,z3)
const PANEL = { x: 400, y: 210, w: 480, h: 300, z: 2 };
const SEL = { x: 424, y: 250, w: 432, h: 40, z: 3 };
const FLD = { x: 424, y: 306, w: 432, h: 40, z: 3 };
const BTN = { x: 560, y: 368, w: 160, h: 40, z: 4 };
// results 是「容器」：kind=region（自检器对容器豁免同层重叠）+ style=panel（视觉仍是面板）。
// 依据：screens.md 表 panel_gacha 高 300（210..510）与 results y=420 必然相交——表里两盒同 z=2，
// 唯一自洽解释是 results 为底层容器、浮层面板悬于其上（ASCII 图亦见结果行在面板之下）。
const RESULTS = { x: 96, y: 420, w: 1088, h: 240, z: 2 };

// 循环取值（下拉/字段的零依赖交互：点击切到下一项；未命中 → 首项）
export function nextIn(list, cur) {
  const i = (list || []).indexOf(cur);
  return list[(i + 1) % list.length];
}

export function gachaLayout(state) {
  const g = state.gacha || {};
  const times = g.times || 1;
  const boxes = [
    {
      id: 'panel_gacha', kind: 'panel', parent: null,
      x: PANEL.x, y: PANEL.y, w: PANEL.w, h: PANEL.h, z: PANEL.z, visible: true,
      text: g.opening ? '开箱中…' : '开箱（GACHA）',
    },
    {
      id: 'sel_tier', kind: 'select', parent: 'panel_gacha', style: '',
      x: SEL.x, y: SEL.y, w: SEL.w, h: SEL.h, z: SEL.z, visible: true,
      text: `段位：${state.tier}（点击下一档）`, action: 'tier/set', payload: { tier: nextIn(TIERS, state.tier) },
    },
    {
      id: 'fld_times', kind: 'field', parent: 'panel_gacha',
      x: FLD.x, y: FLD.y, w: FLD.w, h: FLD.h, z: FLD.z, visible: true,
      text: `次数：${times}（1..${TIMES_MAX}，点击 +1）`,
      action: 'gacha/times', payload: { times: (times % TIMES_MAX) + 1 },
    },
    {
      id: 'btn_open', kind: 'button', parent: 'panel_gacha', style: 'primary',
      x: BTN.x, y: BTN.y, w: BTN.w, h: BTN.h, z: BTN.z, visible: true,
      text: g.opening ? '开箱中…' : '开箱', action: 'box/open', payload: { times }, disabled: !!g.opening,
    },
    {
      id: 'results', kind: 'region', parent: null, style: 'panel',
      x: RESULTS.x, y: RESULTS.y, w: RESULTS.w, h: RESULTS.h, z: RESULTS.z, visible: true, text: '',
    },
  ];
  const items = (g.lastResult && g.lastResult.items) || [];
  if (items.length > 0) {
    const cards = items.map((it, i) => ({
      id: `res${i + 1}`, kind: 'gridcell', parent: 'results', z: 3,
      style: `q-${it.quality || 'common'}`,
      text: it.name || it.templateId || it.uid, detail: it.kind,
    }));
    boxes.push(...grid(RESULTS.x, RESULTS.y, RESULT_COLS, SIZES.gridCell.w, SIZES.gridCell.h, SIZES.gridGap, cards));
  } else if (!g.opening) {
    boxes.push({
      id: 'gacha_empty', kind: 'text', parent: 'results',
      x: RESULTS.x + 16, y: RESULTS.y + 16, w: 600, h: 24, z: 3, visible: true,
      text: `暂无开箱结果：选择段位与次数后点「开箱」（上限 ${TIMES_MAX} 次）`,
    });
  }
  return boxes;
}