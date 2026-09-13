// store/reducer.js —— 纯函数状态归约（frontend-spec §4.1/§4.2；reducer 只改状态、不碰副作用）
// 仓库形状沿用后端契约（{buckets:{role,skill,rolePlugin,skillPlugin}}，B18/interfaces §1——F1 审查 P1-1 定型）。
export const SCREENS = ['menu', 'editor', 'warehouse', 'gacha', 'battle', 'replay', 'settings'];

export function emptyWarehouse() {
  return { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
}

export function initialState() {
  return {
    screen: 'menu',
    meta: { serverOk: null, version: null, tableNames: [] },
    tier: 'common',
    tierInfo: null,
    seed: null,
    warehouse: emptyWarehouse(),
    loadout: { role: null, skills: [null, null, null], ai: null },
    panel: null,
    aiDraft: { program: null, hash: null, errors: [], compiling: false },
    gacha: { opening: false, lastResult: null },
    battle: { config: null, running: false, frames: [], result: null, tick: 0, speed: 1, playing: false },
    logPrefs: { level: 'debug', channels: { render: 'trace' }, panelOpen: false },
    ui: { busy: false, snackbar: [], modal: null, activeTab: {} },
  };
}

function pushToast(state, text, kind) {
  const snackbar = [...state.ui.snackbar, { id: `t${Date.now()}_${state.ui.snackbar.length}`, text, kind: kind || 'info' }];
  return { ...state, ui: { ...state.ui, snackbar } };
}

export function reducer(state, action) {
  switch (action.type) {
    case 'goto': {
      const screen = action.payload && action.payload.screen;
      if (!SCREENS.includes(screen)) return state;
      return { ...state, screen, ui: { ...state.ui, modal: null } };
    }
    case 'meta/loaded':
      return { ...state, meta: { serverOk: !!action.payload.ok, version: action.payload.version || null, tableNames: action.payload.tableNames || [] } };
    case 'tier/set':
      return { ...state, tier: action.payload.tier, aiDraft: { ...state.aiDraft, errors: [] } };
    case 'tier/loaded':
      return { ...state, tierInfo: action.payload };
    case 'seed/set':
      return { ...state, seed: action.payload.seed };
    case 'box/open':
      return { ...state, gacha: { ...state.gacha, opening: true }, ui: { ...state.ui, busy: true } };
    case 'box/done': {
      const r = action.payload;
      if (!r.ok) return { ...state, gacha: { ...state.gacha, opening: false }, ui: { ...state.ui, busy: false } };
      // F1 P1-2：/box 的 data.items 是数组（每元素带 kind）——按 kind 分桶追加（克隆防共享引用，P2-10）
      const BUCKET_KEYS = ['role', 'skill', 'rolePlugin', 'skillPlugin'];
      const items = r.data && Array.isArray(r.data.items) ? r.data.items : [];
      const wh = { buckets: {
        role: [...(state.warehouse.buckets.role || [])],
        skill: [...(state.warehouse.buckets.skill || [])],
        rolePlugin: [...(state.warehouse.buckets.rolePlugin || [])],
        skillPlugin: [...(state.warehouse.buckets.skillPlugin || [])],
      } };
      for (const it of items) {
        if (!it || !BUCKET_KEYS.includes(it.kind)) continue; // 未知 kind 跳过（不造垃圾桶）
        wh.buckets[it.kind] = [...wh.buckets[it.kind], { ...it }];
      }
      return {
        ...state,
        warehouse: wh,
        gacha: { opening: false, lastResult: r.data },
        ui: { ...state.ui, busy: false },
        seed: r.data.seed || state.seed,
      };
    }
    case 'wh/replaced':
      return { ...state, warehouse: action.payload.warehouse };
    case 'wh/tab':
      return { ...state, ui: { ...state.ui, activeTab: { ...state.ui.activeTab, warehouse: action.payload.key } } };
    case 'wh/select':
      return { ...state, ui: { ...state.ui, selected: action.payload.uid } };
    case 'battle/opp/set':
      return { ...state, ui: { ...state.ui, activeTab: { ...state.ui.activeTab, battle: action.payload.id } } };
    case 'loadout/set': {
      const ld = action.payload.loadout;
      const next = { role: ld.role || state.loadout.role, skills: ld.skills || state.loadout.skills, ai: ld.ai === undefined ? state.loadout.ai : ld.ai };
      return { ...state, loadout: next };
    }
    case 'loadout/errors':
      return { ...state, aiDraft: { ...state.aiDraft, errors: action.payload.errors || [] } };
    case 'ai/edit':
      return { ...state, aiDraft: { ...state.aiDraft, program: action.payload.program, errors: [] } };
    case 'ai/compile':
      return { ...state, aiDraft: { ...state.aiDraft, compiling: true } }; // F1 P1-3：§4.2 行
    case 'ai/compiled':
      return { ...state, aiDraft: { ...state.aiDraft, hash: action.payload.hash || null, errors: action.payload.errors || [], compiling: false } };
    case 'ai/validate/result':
      return { ...state, aiDraft: { ...state.aiDraft, errors: action.payload.errors || [] } };
    case 'ai/run':
      return { ...state, battle: { ...state.battle, running: true } }; // F1 P1-3：§4.2 行
    case 'battle/loaded': {
      const p = action.payload;
      return {
        ...state,
        battle: { ...state.battle, frames: p.frames || [], result: p.result || null, tick: 0, playing: false, running: false },
      };
    }
    case 'battle/seek':
      return { ...state, battle: { ...state.battle, tick: action.payload.tick } };
    case 'battle/pause':
      return { ...state, battle: { ...state.battle, playing: false } };
    case 'battle/play':
      return { ...state, battle: { ...state.battle, playing: true } };
    case 'battle/speed':
      return { ...state, battle: { ...state.battle, speed: action.payload.speed } };
    case 'panel/loaded':
      return { ...state, panel: action.payload };
    case 'log/set': {
      const p = action.payload || {};
      const channels = p.channels || {};
      return { ...state, logPrefs: { level: p.level || state.logPrefs.level, channels: { ...state.logPrefs.channels, ...channels }, panelOpen: p.panelOpen === undefined ? state.logPrefs.panelOpen : p.panelOpen } };
    }
    case 'save/import': {
      const p = action.payload || {};
      return {
        ...state,
        warehouse: p.warehouse || state.warehouse,
        loadout: p.loadout || state.loadout,
        tier: p.tier || state.tier,
        seed: p.seed === undefined ? state.seed : p.seed,
      };
    }
    case 'ui/toast':
      return pushToast(state, action.payload.text, action.payload.kind);
    case 'ui/toast/dismiss': {
      const id = action.payload && action.payload.id;
      return { ...state, ui: { ...state.ui, snackbar: state.ui.snackbar.filter((t) => t.id !== id) } };
    }
    default:
      return state;
  }
}