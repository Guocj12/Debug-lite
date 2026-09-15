// views/warehouse.js —— 仓库/装配屏（frontend-spec §6.3；坐标口径 = docs/screens.md「仓库与装配 warehouse」盒子表）
import { SIZES } from '../ui/sizes.js';
import { button, grid } from '../ui/layout.js';

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

// screens.md warehouse 表：
// buckets(16,80,168,500,z2) grid(200,80,864,500,z2) detail(1080,80,184,500,z2) points(16,592,1248,40,z2)
// 卡片 card<k>(200+(k-1)%4*184, 80+floor((k-1)/4)*124, 168,108,z3)——即 grid(200,80,4,168,108,16)
const BUCKETS_BOX = { x: 16, y: 80, w: 168, h: 500, z: 2 };
const GRID_BOX = { x: 200, y: 80, w: 864, h: 500, z: 2 };
const DETAIL_BOX = { x: 1080, y: 80, w: 184, h: 500, z: 2 };
const POINTS_BOX = { x: 16, y: 592, w: 1248, h: 40, z: 2 };
const TAB = { x: 32, y: 96, w: 136, h: 36, pitch: 44 }; // buckets 容器内四个 Tab（容器内元素，表未逐列）
const DETAIL_IN = { x: 1096, w: 152 }; // detail 容器内元素（容器 1080..1264，左右各留 16）
const DETAIL_MAX_Y = 564; // detail 底 580 − 16（内容上限，超出即截断——F3 审查登记）
const BTN_PITCH = SIZES.buttonGhost.h + 2; // 34：按钮间 2px 间隙

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

// 按 uid 全桶查找（纯）
export function itemByUid(warehouse, uid) {
  const wh = warehouse && warehouse.buckets ? warehouse.buckets : {};
  for (const k of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
    const hit = (wh[k] || []).find((i) => i && i.uid === uid);
    if (hit) return hit;
  }
  return null;
}

// 出战装配（纯）：loadout + 选中物品 → 新 loadout（角色就位时用技能桶补齐空技能槽；1..3 槽恒填满至 3）
export function equipInto(loadout, item, skillsPool) {
  if (!item) return null;
  const ld = loadout || {};
  const skills = Array.isArray(ld.skills) ? ld.skills.slice(0, 3) : [];
  while (skills.length < 3) skills.push(null);
  const ai = ld.ai === undefined ? null : ld.ai;
  if (item.kind === 'role') {
    const pool = (skillsPool || []).filter((s) => s && s.kind === 'skill').slice();
    for (let i = 0; i < 3; i++) if (!skills[i] && pool.length > 0) skills[i] = pool.shift();
    return { role: item, skills, ai };
  }
  if (item.kind === 'skill') {
    const empty = skills.indexOf(null);
    skills[empty === -1 ? 2 : empty] = item;
    return { role: ld.role || null, skills, ai };
  }
  return null; // 插件走槽位装配（wh/assemble），不进出战配置
}

// 仓库屏布局
export function warehouseLayout(state) {
  const tabKey = (state.ui && state.ui.activeTab && state.ui.activeTab.warehouse) || 'role';
  const items = itemsOf(state, tabKey);
  const selected = (state.ui && state.ui.selected) || null;
  const selectedItem = items.find((i) => i.uid === selected) || null;
  const boxes = [
    // 左：四个分类 Tab（buckets 容器，表内 z2；Tab 为容器内元素 z3）
    { id: 'buckets', kind: 'panel', parent: null, ...BUCKETS_BOX, visible: true, text: '' },
    ...BUCKETS.map((b, i) => ({
      id: `wh_tab_${b.key}`, kind: 'tab', parent: 'buckets',
      x: TAB.x, y: TAB.y + i * TAB.pitch, w: TAB.w, h: TAB.h, z: 3, visible: true,
      text: b.label, style: tabKey === b.key ? 'on' : 'off',
      action: 'wh/tab', payload: { key: b.key },
    })),
    // 中：物品网格容器（表内 z2）+ 卡片 z3
    { id: 'grid', kind: 'panel', parent: null, ...GRID_BOX, visible: true, text: '' },
  ];
  if (items.length === 0) {
    boxes.push({ id: 'wh_empty', kind: 'text', parent: 'grid', x: GRID_BOX.x + 16, y: GRID_BOX.y + 16, w: 600, h: 24, z: 3, visible: true, text: '此分类暂无物品：去开箱吧' });
    boxes.push(button('wh_goto_gacha', GRID_BOX.x + 16, GRID_BOX.y + 52, '去开箱', { parent: 'grid', z: 3, goto: 'gacha' }));
  } else {
    const cards = items.map((it, i) => ({
      id: `card${i + 1}`, kind: 'gridcell', parent: 'grid', z: 3,
      style: `q-${it.quality || 'common'}${selected === it.uid ? ' on' : ''}`,
      text: it.name || it.templateId || it.uid, detail: it.kind,
      action: 'wh/select', payload: { uid: it.uid },
    }));
    boxes.push(...grid(GRID_BOX.x, GRID_BOX.y, 4, SIZES.gridCell.w, SIZES.gridCell.h, SIZES.gridGap, cards));
  }
  // 右：详情（表内 z2；内容 z3）
  boxes.push({ id: 'detail', kind: 'panel', parent: null, ...DETAIL_BOX, visible: true, text: selectedItem ? '详情' : '未选择' });
  if (selectedItem) {
    boxes.push({
      id: 'detail_name', kind: 'text', parent: 'detail',
      x: DETAIL_IN.x, y: 96, w: DETAIL_IN.w, h: 24, z: 3, visible: true,
      text: `${selectedItem.name || selectedItem.templateId || selectedItem.uid}（${selectedItem.quality || '?'}）`,
    });
    const used = (selectedItem.slots || []).filter((s) => s && s.pluginUid).length;
    boxes.push({
      id: 'detail_pts', kind: 'text', parent: 'detail',
      x: DETAIL_IN.x, y: 124, w: DETAIL_IN.w, h: 20, z: 3, visible: true,
      text: `点数 ${used}/${selectedItem.pluginPoints || 0}`,
    });
    // 设为出战（表内未列；detail 容器内动作。必要性：无此入口则 loadout 恒空 → /battle、/panel、回放屏均不可达）
    const equipable = selectedItem.kind === 'role' || selectedItem.kind === 'skill';
    if (equipable) {
      boxes.push({
        id: 'btn_equip', kind: 'button', parent: 'detail', style: 'ghost',
        x: DETAIL_IN.x, y: 152, w: DETAIL_IN.w, h: 32, z: 3, visible: true,
        text: selectedItem.kind === 'role' ? '设为出战角色' : '装入技能槽',
        action: 'wh/equip', payload: { uid: selectedItem.uid },
      });
    }
    // 槽位清单 + 候选插件（每槽类型 + 已装/空 + 候选按钮）
    let sy = equipable ? 192 : 152;
    const slots = selectedItem.slots || [];
    if (slots.length === 0) {
      boxes.push({ id: 'detail_no_slots', kind: 'text', parent: 'detail', x: DETAIL_IN.x, y: sy, w: DETAIL_IN.w, h: 20, z: 3, visible: true, text: '（无插槽）' });
      sy += 28;
    }
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (sy + 20 > DETAIL_MAX_Y) break; // 剩余空间不足 → 停止渲染（截断登记见 F3.md P2）
      boxes.push({
        id: `detail_slot_${i}`, kind: 'slot', parent: 'detail',
        x: DETAIL_IN.x, y: sy, w: DETAIL_IN.w, h: 20, z: 3, visible: true,
        style: s.pluginUid ? 'on' : 'off',
        text: `槽${i + 1}（${s.type}）`, detail: s.pluginUid ? '已装' : '空',
      });
      sy += 24;
      if (s.pluginUid) {
        boxes.push(button(`wh_take_${i}`, DETAIL_IN.x, sy, '拆卸', {
          parent: 'detail', z: 3, ghost: true, action: 'wh/take',
          payload: { targetUid: selectedItem.uid, slotIndex: i },
        }));
        sy += BTN_PITCH;
        continue;
      }
      const cands = candidatesFor(selectedItem, state.warehouse, state.tier, s.type); // F4：槽型预过滤
      for (const p of cands) {
        if (sy + SIZES.buttonGhost.h > DETAIL_MAX_Y) break; // 预检：按钮底不得越出容器
        boxes.push(button(`wh_put_${p.uid}_${i}`, DETAIL_IN.x, sy, p.name || p.uid, {
          parent: 'detail', z: 3, ghost: true, action: 'wh/assemble',
          payload: { targetUid: selectedItem.uid, pluginUid: p.uid, slotIndex: i },
        }));
        sy += BTN_PITCH;
      }
    }
  }
  // 底：装配点数条（§6.3「y592..640 装配区：已用点数/上限」——F3 审查登记 P2 未实现，此处补齐）
  const usedAll = selectedItem ? (selectedItem.slots || []).filter((s) => s && s.pluginUid).length : 0;
  const maxAll = selectedItem ? (selectedItem.pluginPoints || 0) : 0;
  boxes.push(
    { id: 'points', kind: 'panel', parent: null, ...POINTS_BOX, visible: true, text: '' },
    {
      id: 'points_text', kind: 'text', parent: 'points',
      x: POINTS_BOX.x + 16, y: POINTS_BOX.y + 8, w: 704, h: 24, z: 3, visible: true,
      text: selectedItem
        ? `装配点数：已用 ${usedAll} / 上限 ${maxAll}（${selectedItem.name || selectedItem.uid}）`
        : '装配点数：未选物品（点击中间卡片查看槽位与可装插件）',
    },
    {
      id: 'points_hint', kind: 'text', parent: 'points', style: 'right muted',
      x: POINTS_BOX.x + 736, y: POINTS_BOX.y + 8, w: 496, h: 24, z: 3, visible: true,
      text: `仓库 ${BUCKETS.reduce((n, b) => n + itemsOf(state, b.key).length, 0)} 件 · 当前分类 ${items.length} 件`,
    },
  );
  return boxes;
}