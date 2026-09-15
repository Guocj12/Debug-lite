'use strict';
/* views/warehouse.js —— 仓库与装配（frontend-spec §6.3 + docs/screens.md warehouse 表）。
 * buckets(16,80,168,500)：4 Tab 纵列；grid(200,80,864,500)：4 列卡片网格（品质色条）；
 * detail(1080,80,184,500)：选中详情/槽位表/装配入口/拆卸/出战；points(16,592,1248,40) 点数条；
 * 装配抽屉 Modal(480)：目标槽位 + 候选插件一键装配。
 */
import { box, panel, button, grid as gridOf, verifyLayout } from '../ui/layout.js';
import { SIZES } from '../ui/sizes.js';
import { boxesToHtml } from './html.js';

const BUCKETS = [
  { key: 'role', label: '角色' },
  { key: 'skill', label: '技能' },
  { key: 'rolePlugin', label: '角色插件' },
  { key: 'skillPlugin', label: '技能插件' },
];
const CARD_COLS = 4;
const MAX_CARDS = 16; // 4 列 × 4 行（80..188 / 204..312 / 328..436 / 452..560，与 grid 80..580 对齐）

// 桶物品读取（buckets 形状权威，RW-1）
export function itemsOf(state, key) {
  const b = state.warehouse && state.warehouse.buckets;
  return (b && b[key]) || [];
}

export function itemByUid(state, uid) {
  if (!state.warehouse || !state.warehouse.buckets) return null;
  for (const key of Object.keys(state.warehouse.buckets)) {
    const hit = (state.warehouse.buckets[key] || []).find((x) => x.uid === uid);
    if (hit) return { item: hit, bucket: key };
  }
  return null;
}

// 段位序（与 unlock 同口径；前端只读比较，不 require core）
const TIER_ORDER = ['common', 'rare', 'epic', 'legendary', 'mythic'];

// 槽位候选：同目标 kind 匹配 + 未装备 + 段位门控（预过滤，具体校验以后端为准）
export function candidatesFor(state, target, slotIndex) {
  const want = target.kind === 'role' ? 'rolePlugin' : 'skillPlugin';
  const used = new Set();
  const wh = state.warehouse && state.warehouse.buckets;
  if (!wh) return [];
  for (const key of [want, target.kind === 'role' ? 'skillPlugin' : 'rolePlugin']) {
    for (const it of wh[key] || []) {
      for (const slot of it.slots || []) if (slot && slot.pluginUid) used.add(slot.pluginUid);
    }
  }
  for (const it of wh['role'] || []) for (const s of it.slots || []) if (s && s.pluginUid) used.add(s.pluginUid);
  const ti = TIER_ORDER.indexOf(state.tier);
  return (wh[want] || []).filter((p) => !used.has(p.uid) && (!p.unlockTier || TIER_ORDER.indexOf(p.unlockTier) <= ti));
}

export function warehouseLayout(state) {
  const boxes = [
    panel('buckets', 16, 80, 168, 500),
    panel('grid', 200, 80, 864, 500),
    panel('detail', 1080, 80, 184, 500),
    panel('points', 16, 592, 1248, 40),
  ];
  const tab = state.ui.activeTab.warehouse || 'role';
  BUCKETS.forEach((b, i) => {
    const active = b.key === tab;
    boxes.push(box(`tab_${b.key}`, 'chip', 24, 96 + i * 56, 120, 40, { z: 3, parent: 'buckets', text: `${active ? '▶ ' : ''}${b.label}(${itemsOf(state, b.key).length})`, action: 'wh/tab', payload: { bucket: b.key }, style: active ? 'primary' : null }));
  });
  // 卡片网格（截断到 4 行；超出给提示）
  const items = itemsOf(state, tab);
  const shown = items.slice(0, MAX_CARDS);
  shown.forEach((it, i) => {
    boxes.push(box(`card${i + 1}`, 'card', 200 + (i % CARD_COLS) * (SIZES.gridCell.w + SIZES.gridGap), 80 + Math.floor(i / CARD_COLS) * (SIZES.gridCell.h + SIZES.gridGap), SIZES.gridCell.w, SIZES.gridCell.h, { z: 3, parent: 'grid', text: `${it.name || it.templateId || it.uid}`, action: 'wh/select', payload: { uid: it.uid }, q: it.quality || 'common' }));
  });
  if (items.length === 0) {
    boxes.push(box('grid_empty', 'text', 200, 320, 864, 24, { z: 3, parent: 'grid', text: `「${tab}」桶为空 —— 去「开箱」获取物品` }));
    boxes.push(button('btn_togacha', 544, 380, { z: 3, parent: 'grid', text: '去开箱', action: 'goto', payload: { screen: 'gacha' } }));
  } else if (items.length > MAX_CARDS) {
    boxes.push(box('grid_more', 'text', 200, 566, 864, 14, { z: 3, parent: 'grid', text: `共 ${items.length} 件，仅显示前 ${MAX_CARDS} 件` }));
  }
  // 详情：选中物品
  const selected = itemByUid(state, state.ui.selected.warehouse);
  if (selected) {
    const it = selected.item;
    const slots = it.slots || [];
    boxes.push(box('det_name', 'text', 1088, 96, 168, 24, { z: 3, parent: 'detail', text: `${it.name || it.templateId || it.uid}（${it.kind}）`, q: it.quality || 'common' }));
    boxes.push(box('det_quality', 'text', 1088, 124, 168, 20, { z: 3, parent: 'detail', text: `品质 ${it.quality || 'common'} · 槽位 ${slots.length}` }));
    if (it.kind === 'role' || it.kind === 'skill') {
      const equipped = it.kind === 'role' ? state.loadout.role === it.uid : (state.loadout.skills || []).includes(it.uid);
      boxes.push(button('btn_equip', 1088, 152, { z: 3, parent: 'detail', style: 'primary', text: equipped ? '已出战' : '出战', action: equipped ? null : 'loadout/equip', payload: equipped ? undefined : { uid: it.uid, kind: it.kind }, disabled: equipped }));
    }
    if (slots.length && (it.kind === 'role' || it.kind === 'skill')) {
      boxes.push(button('btn_assemble', 1088, 204, { z: 3, parent: 'detail', text: '装配插件', action: 'ui/modal', payload: { drawer: 'assemble', targetUid: it.uid } }));
    }
    slots.forEach((slot, si) => {
      const y = 252 + si * 28;
      const pl = slot && slot.pluginUid ? itemByUid(state, slot.pluginUid) : null;
      boxes.push(box(`slot${si + 1}`, 'chip', 1088, y, 128, 24, { z: 3, parent: 'detail', text: `槽${si + 1}:${pl ? (pl.item.name || pl.item.templateId) : '空'}`, q: pl ? (pl.item.quality || 'common') : null }));
      if (slot && slot.pluginUid) {
        boxes.push(box(`take${si + 1}`, 'chip', 1224, y, 32, 24, { z: 4, parent: 'detail', text: '拆', action: 'wh/disassemble', payload: { targetUid: it.uid, slotIndex: si } }));
      }
    });
  } else {
    boxes.push(box('det_none', 'text', 1088, 96, 168, 40, { z: 3, parent: 'detail', text: '点击左侧卡片查看详情' }));
  }
  // 点数条：插件装配汇总
  const whAll = state.warehouse && state.warehouse.buckets
    ? [...(state.warehouse.buckets.role || []), ...(state.warehouse.buckets.skill || [])]
    : [];
  const usedPoints = whAll.reduce((n, it) => n + (it.slots || []).filter((s) => s && s.pluginUid).length, 0);
  boxes.push(box('points_lit', 'text', 24, 600, 1232, 24, { z: 3, parent: 'points', text: `装配区 · 已装插件 ${usedPoints} 个 · 失败错误码（points_exceeded 等）经 toast 提示` }));
  return boxes;
}

// 装配抽屉（Modal 480 宽）：目标槽位行 + 候选一键装配（spec §6.3）
export function assembleDrawerLayout(state) {
  const modal = state.ui.modal;
  if (!modal || modal.drawer !== 'assemble') return [];
  const target = itemByUid(state, modal.targetUid);
  if (!target || !target.item.slots) return [];
  const boxes = [
    box('mask', 'mask', 0, 0, 1280, 720, { z: 90, action: 'ui/modal', payload: {} }),
    box('drawer', 'panel', 400, 180, 480, 360, { z: 91 }),
    box('drawer_title', 'text', 416, 196, 448, 24, { z: 92, parent: 'drawer', text: `为「${target.item.name || target.item.templateId}」装配插件（点击候选即装配）` }),
  ];
  target.item.slots.forEach((slot, si) => {
    const cands = candidatesFor(state, target.item, si);
    boxes.push(box(`drawer_slot${si + 1}`, 'text', 416, 228 + si * 56, 448, 24, { z: 92, parent: 'drawer', text: `槽${si + 1}：${cands.length} 个可用候选` }));
    cands.slice(0, 3).forEach((p, pi) => {
      boxes.push(box(`drawer_cand_${si}_${pi}`, 'chip', 416 + pi * 150, 252 + si * 56, 144, 24, { z: 92, parent: 'drawer', text: `+${p.name || p.templateId || p.uid}`, action: 'wh/assemble', payload: { targetUid: target.item.uid, pluginUid: p.uid, slotIndex: si } }));
    });
  });
  boxes.push(box('drawer_close', 'chip', 680, 492, 120, 32, { z: 92, parent: 'drawer', text: '关闭', action: 'ui/modal', payload: {} }));
  return boxes;
}

export function warehouseHtml(state) {
  return boxesToHtml([...warehouseLayout(state), ...assembleDrawerLayout(state)]);
}
