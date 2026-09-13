// views/warehouse.js —— 仓库/装配屏（frontend-spec §6.3；buckets Tab + grid(200,80,4,168,108,16) + detail 右）
import { SIZES, SPACES } from '../ui/sizes.js';
import { panel, button, grid } from '../ui/layout.js';

export const BUCKETS = [
  { key: 'role', label: '角色' },
  { key: 'skill', label: '技能' },
  { key: 'rolePlugin', label: '角色插件' },
  { key: 'skillPlugin', label: '技能插件' },
];

export function bucketOf(i) {
  return BUCKETS[i] && BUCKETS[i].key || BUCKETS[0].key;
}

// 当前 Tab 的物品列表（buckets 形状，F1 P1-1 定型）
export function itemsOf(state, tabKey) {
  const wh = state.warehouse && state.warehouse.buckets ? state.warehouse.buckets : {};
  return wh[tabKey] || [];
}

// 详情区几何（F3 审查 P1：按钮 h32 在 30px 步距下逐对重叠 2px 且真实数据溢出面板——改为 h+2 步距 + 预检上限）。
// DETAIL_MAX_Y：详情面板 1080,80,184,500 → 底 580；内容上限压到 560（底余 20px），
// 超出即截断（F3 审查登记：候选被截断无提示——见 F3.md P2）。
const DETAIL_MAX_Y = 560;
const BTN_PITCH = SIZES.buttonGhost.h + 2; // 34：按钮间 2px 间隙（行距 24 vs 行高 20 同理无交）

// 候选插件（纯函数预过滤——权威校验仍在后端；仅提示可装项）：
// kind 匹配（角色目标 ← 角色插件；技能目标 ← 技能插件）+ 未装备（equipped !== true）+ 段位门控（unlockTier ≤ tier）
// + slot 预过滤（F4，F3 P2★：插件模板 slot 与目标槽 type 匹配——真数据错配面 ~86% 由此消除）
export function candidatesFor(item, warehouse, tierName, slotType) {
  if (!item) return [];
  const wantKind = item.kind === 'role' ? 'rolePlugin' : item.kind === 'skill' ? 'skillPlugin' : null;
  if (!wantKind) return [];
  const tierRank = (n) => ['common', 'rare', 'epic', 'legendary', 'mythic'].indexOf(n);
  const wh = warehouse && warehouse.buckets ? warehouse.buckets : {};
  const myRank = tierRank(tierName);
  return (wh[wantKind] || []).filter((p) => {
    if (p.uid === item.uid) return false;
    if (p.equipped) return false;
    if (p.unlockTier && tierRank(p.unlockTier) > myRank) return false;
    if (slotType !== undefined && p.slot !== undefined && p.slot !== slotType) return false; // 仅槽型已知才过滤（无 slot 字段者放行给后端）
    return true;
  });
}

// 仓库屏布局
export function warehouseLayout(state) {
  const tabKey = (state.ui && state.ui.activeTab && state.ui.activeTab.warehouse) || 'role';
  const items = itemsOf(state, tabKey);
  const selected = (state.ui && state.ui.selected) || null;
  const selectedItem = items.find((i) => i.uid === selected) || null;
  const boxes = [
    // 左侧 Tab 四类
    ...BUCKETS.map((b, i) => ({
      id: `wh_tab_${b.key}`, kind: 'tab', parent: null,
      x: 16, y: 80 + i * 44, w: 144, h: 40, z: 1, visible: true,
      text: b.label, style: tabKey === b.key ? 'on' : 'off',
      action: 'wh/tab', payload: { key: b.key },
    })),
  ];
  // 中部物品网格（空态 → 提示 + 去开箱）
  if (items.length === 0) {
    boxes.push({ id: 'wh_empty', kind: 'text', parent: null, x: 200, y: 200, w: 600, h: 24, z: 0, visible: true, text: '此分类暂无物品：去开箱吧' });
    boxes.push(button('wh_goto_gacha', 200, 236, '去开箱', { parent: null, z: 1, goto: 'gacha' }));
  } else {
    const cards = items.map((it) => ({
      id: `wh_card_${it.uid}`, kind: 'gridcell', parent: null,
      style: `q-${it.quality || 'common'}`,
      text: it.name || it.templateId || it.uid, detail: it.kind,
      action: 'wh/select', payload: { uid: it.uid },
      ...(selected === it.uid ? { styleSec: 'selected' } : {}),
    }));
    boxes.push(...grid(200, 80, 4, SIZES.gridCell.w, SIZES.gridCell.h, 16, cards));
  }
  // 右侧详情
  boxes.push(panel(1080, 80, 184, 500, selectedItem ? '详情' : '未选择', 'wh_detail'));
  if (selectedItem) {
    boxes.push({
      id: 'wh_detail_name', kind: 'text', parent: 'wh_detail',
      x: 1096, y: 120, w: 152, h: 24, z: 1, visible: true,
      text: `${selectedItem.name || selectedItem.templateId || selectedItem.uid}（${selectedItem.quality || '?'}）`,
    });
    const used = (selectedItem.slots || []).filter((s) => s && s.pluginUid).length;
    boxes.push({
      id: 'wh_detail_pts', kind: 'text', parent: 'wh_detail',
      x: 1096, y: 152, w: 152, h: 20, z: 1, visible: true,
      text: `点数 ${used}/${selectedItem.pluginPoints || 0}`,
    });
    // 槽位清单 + 候选插件（每槽类型 + 已装/空 + 候选行）
    let sy = 184;
    const slots = selectedItem.slots || [];
    if (slots.length === 0) {
      boxes.push({ id: 'wh_no_slots', kind: 'text', parent: 'wh_detail', x: 1096, y: sy, w: 152, h: 20, z: 1, visible: true, text: '（无插槽）' });
      sy += 28;
    }
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      // 剩余空间不足以容纳下一槽行 → 停止渲染（F3 审查：截断无提示，登记 P2）
      if (sy + 20 > DETAIL_MAX_Y) break;
      boxes.push({
        id: `wh_slot_${i}`, kind: 'listitem', parent: 'wh_detail',
        x: 1096, y: sy, w: 152, h: 20, z: 1, visible: true,
        text: `槽${i + 1}(${s.type}) ${s.pluginUid ? '已装' : '空'}`,
      });
      sy += 24;
      if (s.pluginUid) {
        // 已装槽：拆卸入口（F3 审查缺口——候选过滤会排除已装备插件，须显式提供）
        boxes.push(button(`wh_take_${i}`, 1096, sy, '拆卸', {
          parent: 'wh_detail', z: 1, ghost: true, action: 'wh/take',
          payload: { targetUid: selectedItem.uid, slotIndex: i },
        }));
        sy += BTN_PITCH;
        continue;
      }
      const cands = candidatesFor(selectedItem, state.warehouse, state.tier, s.type); // F4：槽型预过滤
      for (const p of cands) {
        // 预检：按钮落地后不得越过 DETAIL_MAX_Y（F3 审查 P1 修复——原后置 break 让按钮底部越到 580 面板之下）
        if (sy + SIZES.buttonGhost.h > DETAIL_MAX_Y) break;
        boxes.push(button(`wh_put_${p.uid}_${i}`, 1096, sy, p.name || p.uid, {
          parent: 'wh_detail', z: 1, ghost: true, action: 'wh/assemble',
          payload: { targetUid: selectedItem.uid, pluginUid: p.uid, slotIndex: i },
        }));
        sy += BTN_PITCH;
      }
    }
  }
  return boxes;
}