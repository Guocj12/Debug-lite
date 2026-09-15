'use strict';
/* store/reducer.js —— 状态唯一来源（frontend-spec §4.1/§4.2）。
 * 纯函数：无 IO/随机/时间；副作用全部在 effects.js。
 * 仓库形状：后端 B18 权威 {buckets:{role,skill,rolePlugin,skillPlugin}}（§4.1 扁平写法已被 B18 取代，见 docs/rewrite-issues.md）。
 */

const BUCKETS = ['role', 'skill', 'rolePlugin', 'skillPlugin'];

export function initialState() {
  return {
    screen: 'menu',
    meta: { serverOk: null, version: null, tableNames: [] },
    tier: 'common',
    tierInfo: { nodes: [], roleTemplates: [], skills: [], plugins: [] },
    seed: null,
    warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
    loadout: { role: null, skills: [null, null, null], ai: null },
    panel: null,
    aiDraft: { program: null, hash: null, errors: [], compiling: false },
    gacha: { opening: false, lastResult: null },
    battle: { config: null, playing: false, frames: [], result: null, tick: 0, speed: 1 },
    logPrefs: { level: 'debug', channels: {}, panelOpen: false },
    ui: { busy: false, snackbar: [], modal: null, activeTab: {}, selected: {} },
  };
}

export function emptyWarehouse() {
  return { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
}

function clone(v) {
  return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
}

// 开箱物品数组按 kind 分桶并入仓库（§4.2 box/done；内容级合并，uid 服务端权威）
function mergeItems(warehouse, items) {
  const buckets = { ...(warehouse && warehouse.buckets ? warehouse.buckets : {}) };
  for (const k of BUCKETS) if (!Array.isArray(buckets[k])) buckets[k] = [];
  const next = { ...warehouse, buckets };
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object' || !BUCKETS.includes(it.kind)) continue;
    next.buckets[it.kind] = [...next.buckets[it.kind], clone(it)];
  }
  return next;
}

function clampTick(frames, tick) {
  const max = Array.isArray(frames) ? frames.length - 1 : 0;
  return Math.max(0, Math.min(Number(tick) || 0, max));
}

export function reducer(state, action) {
  const s = state || initialState();
  const a = action || {};
  switch (a.type) {
    case '@@init':
      return s;
    case 'goto':
      // 切屏只走 goto；清临时 ui 态（modal/selected，保留 snackbar 与 busy 由 effect 层管理）
      return { ...s, screen: a.screen || s.screen, ui: { ...s.ui, modal: null, selected: {} } };
    case 'seed/set':
      return { ...s, seed: a.seed === undefined ? s.seed : a.seed };
    case 'meta/set':
      return { ...s, meta: { ...s.meta, ...(a.patch || {}) } };
    case 'tier/set':
      return { ...s, tier: a.tier || s.tier };
    case 'tier/info':
      return { ...s, tierInfo: a.tierInfo || s.tierInfo };
    case 'box/open':
      return { ...s, gacha: { ...s.gacha, opening: true }, ui: { ...s.ui, busy: true } };
    case 'box/done': {
      const resp = a.resp || {};
      const merged = mergeItems(s.warehouse, resp.items);
      return {
        ...s,
        warehouse: merged,
        gacha: { opening: false, lastResult: Array.isArray(resp.items) ? resp.items : [] },
        ui: { ...s.ui, busy: false },
      };
    }
    case 'box/fail':
      return { ...s, gacha: { ...s.gacha, opening: false }, ui: { ...s.ui, busy: false } };
    case 'gacha/times': {
      const n = Math.max(1, Math.min(Number(a.times) || 1, 10));
      return { ...s, gacha: { ...s.gacha, times: n } };
    }
    case 'wh/set':
      return { ...s, warehouse: a.warehouse || s.warehouse };
    case 'wh/tab':
      return { ...s, ui: { ...s.ui, activeTab: { ...s.ui.activeTab, warehouse: a.bucket || 'role' } } };
    case 'wh/select':
      return { ...s, ui: { ...s.ui, selected: { ...s.ui.selected, warehouse: a.uid || null } } };
    case 'loadout/set':
      return { ...s, loadout: { role: null, skills: [null, null, null], ai: null, ...(a.loadout || {}) } };
    case 'loadout/equip': {
      // 出战装配：角色就位；技能补首个空槽（无空槽 → 替换槽 0）
      const lo = { ...s.loadout, skills: [...s.loadout.skills] };
      if (a.kind === 'role') lo.role = a.uid;
      else if (a.kind === 'skill') {
        const i = lo.skills.indexOf(null);
        lo.skills[i === -1 ? 0 : i] = a.uid;
      }
      return { ...s, loadout: lo };
    }
    case 'panel/set':
      return { ...s, panel: a.panel === undefined ? null : a.panel };
    case 'ai/edit':
      return { ...s, aiDraft: { ...s.aiDraft, program: a.program || null, errors: [], hash: null } };
    case 'ai/compile':
      return { ...s, aiDraft: { ...s.aiDraft, compiling: true } };
    case 'ai/compiled':
      return { ...s, aiDraft: { ...s.aiDraft, compiling: false, hash: a.hash || null } };
    case 'ai/errors':
      return { ...s, aiDraft: { ...s.aiDraft, compiling: false, errors: Array.isArray(a.errors) ? a.errors : [] } };
    case 'battle/opp':
      return { ...s, ui: { ...s.ui, activeTab: { ...s.ui.activeTab, battle: a.id || 'kiter' } } };
    case 'battle/run':
      return { ...s, battle: { ...s.battle, running: true }, ui: { ...s.ui, busy: true } };
    case 'ai/run':
      return { ...s, battle: { ...s.battle, running: true }, ui: { ...s.ui, busy: true } };
    case 'battle/loaded': {
      const frames = Array.isArray(a.frames) ? a.frames : [];
      return {
        ...s,
        battle: {
          ...s.battle,
          running: false, playing: false,
          frames, result: a.result === undefined ? null : a.result,
          config: a.config === undefined ? s.battle.config : a.config,
          tick: 0, speed: s.battle.speed,
        },
        ui: { ...s.ui, busy: false },
      };
    }
    case 'battle/seek':
      return { ...s, battle: { ...s.battle, tick: clampTick(s.battle.frames, a.tick) } };
    case 'replay/play':
      return { ...s, battle: { ...s.battle, playing: true } };
    case 'replay/pause':
      return { ...s, battle: { ...s.battle, playing: false } };
    case 'replay/speed':
      return { ...s, battle: { ...s.battle, speed: [1, 2, 4].includes(a.speed) ? a.speed : s.battle.speed } };
    case 'log/set': {
      const channels = { ...s.logPrefs.channels };
      for (const [ch, lv] of Object.entries(a.channels || {})) {
        if (lv === null || lv === undefined) delete channels[ch]; // off：移除覆盖
        else channels[ch] = lv;
      }
      return {
        ...s,
        logPrefs: {
          ...s.logPrefs,
          level: a.level || s.logPrefs.level,
          channels,
          ...(a.panelOpen === undefined ? {} : { panelOpen: !!a.panelOpen }),
        },
      };
    }
    case 'save/set':
      // 存档导入（§8）：tier/warehouse/loadout(+lastResult) 全量替换
      return {
        ...s,
        ...(a.tier === undefined ? {} : { tier: a.tier }),
        ...(a.warehouse === undefined ? {} : { warehouse: a.warehouse }),
        ...(a.loadout === undefined ? {} : { loadout: a.loadout }),
        ...(a.lastResult === undefined ? {} : { gacha: { ...s.gacha, lastResult: a.lastResult } }),
      };
    case 'ui/busy':
      return { ...s, ui: { ...s.ui, busy: !!a.busy } };
    case 'ui/toast': {
      const list = [...s.ui.snackbar, { text: String(a.text || ''), kind: a.kind || 'info' }];
      return { ...s, ui: { ...s.ui, snackbar: list.slice(-4) } };
    }
    case 'ui/toast/pop':
      return { ...s, ui: { ...s.ui, snackbar: s.ui.snackbar.slice(1) } };
    case 'ui/modal':
      // modal 可传对象（{drawer,targetUid}）或用 modal 键直传；空参 → 关闭
      return { ...s, ui: { ...s.ui, modal: a.modal !== undefined ? a.modal : (a.drawer ? { drawer: a.drawer, targetUid: a.targetUid } : null) } };
    default:
      return s;
  }
}
