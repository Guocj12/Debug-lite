// store/persist.js —— localStorage 存档（frontend-spec §4.3/§8；D-123 客户端状态）
// key dl.v3.state（schemaVersion=1；不符 → 清空走迁移）+ dl.v3.logPrefs + dl.v3.seed。
export const STATE_KEY = 'dl.v3.state';
export const LOGPREFS_KEY = 'dl.v3.logPrefs';
export const SEED_KEY = 'dl.v3.seed';
export const SCHEMA_VERSION = 1;

// 落盘字段白名单（§4.3：tier/warehouse/loadout/gacha.lastResult/seed/logPrefs）
export function persistFields(state, rawLogPrefs) {
  return {
    schemaVersion: SCHEMA_VERSION,
    tier: state.tier,
    warehouse: state.warehouse,
    loadout: state.loadout,
    gachaLastResult: state.gacha.lastResult,
    seed: state.seed,
    logPrefs: rawLogPrefs || state.logPrefs,
  };
}

export function save(win, state) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || !w.localStorage) return false;
  try {
    w.localStorage.setItem(STATE_KEY, JSON.stringify(persistFields(state)));
    w.localStorage.setItem(LOGPREFS_KEY, JSON.stringify(state.logPrefs));
    if (state.seed !== null && state.seed !== undefined) w.localStorage.setItem(SEED_KEY, String(state.seed));
    return true;
  } catch (e) {
    return false;
  }
}

export function load(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || !w.localStorage) return null;
  let raw = null;
  try {
    raw = w.localStorage.getItem(STATE_KEY);
  } catch (e) {
    return null;
  }
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    if (!data || data.schemaVersion !== SCHEMA_VERSION) return null; // 版本不符 → 清空走迁移（§4.3）
    return data;
  } catch (e) {
    return null;
  }
}

export function remove(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || !w.localStorage) return;
  try {
    w.localStorage.removeItem(STATE_KEY);
  } catch (e) { /* 忽略 */ }
}