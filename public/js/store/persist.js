'use strict';
/* store/persist.js —— localStorage 存档（frontend-spec §8）。
 * 键：dl.v3.state（schemaVersion=1）/ dl.v3.logPrefs / dl.v3.seed；
 * 读写节流 500ms；版本不符 → 丢弃 + store.load warn；export/import 全量 JSON（UI 于 R7 接线）。
 */
const KEY_STATE = 'dl.v3.state';
const KEY_LOGPREFS = 'dl.v3.logPrefs';
const KEY_SEED = 'dl.v3.seed';
const SCHEMA_VERSION = 1;
const SAVE_THROTTLE_MS = 500;

function storageOf(opts) {
  const s = opts.storage;
  return s && typeof s.getItem === 'function' ? s : null;
}

// 桶形状归一：{buckets:{...}} 或旧扁平 {roles,skills,...} → 权威 buckets 形状
export function normWarehouse(v) {
  const empty = { role: [], skill: [], rolePlugin: [], skillPlugin: [] };
  if (!v || typeof v !== 'object') return { buckets: empty };
  const src = v.buckets && typeof v.buckets === 'object'
    ? v.buckets
    : { role: v.roles, skill: v.skills, rolePlugin: v.rolePlugins, skillPlugin: v.skillPlugins };
  const buckets = {};
  for (const k of Object.keys(empty)) buckets[k] = Array.isArray(src && src[k]) ? src[k] : [];
  return { buckets };
}

export function normLoadout(v) {
  const lo = v && typeof v === 'object' ? v : {};
  const skills = Array.isArray(lo.skills) ? [lo.skills[0] || null, lo.skills[1] || null, lo.skills[2] || null] : [null, null, null];
  return { role: lo.role || null, skills, ai: lo.ai === undefined ? null : lo.ai };
}

export function createPersist(options) {
  const opts = options || {};
  const storage = storageOf(opts);
  const log = opts.log || null;
  const timers = opts.timers || { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
  let saveTimer = null;
  let pendingState = null;

  function readState() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(KEY_STATE);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (!v || typeof v !== 'object') return { warn: 'shape' };
      if (v.schemaVersion !== SCHEMA_VERSION) return { warn: 'version' };
      return v;
    } catch (e) {
      return { warn: 'parse' };
    }
  }

  // 读取：返回可并入 initialState 的 patch（§4.3/§8）
  function load() {
    const raw = readState();
    if (raw === null) {
      log && log.info('store', 'store.load', '无存档', { schemaVersion: SCHEMA_VERSION, keys: [] });
      return {};
    }
    if (raw.warn) {
      log && log.warn('store', 'store.load', `存档不可用(${raw.warn}) 已丢弃`, { schemaVersion: SCHEMA_VERSION, keys: [] });
      return {};
    }
    const patch = {
      tier: typeof raw.tier === 'string' ? raw.tier : undefined,
      warehouse: raw.warehouse === undefined ? undefined : normWarehouse(raw.warehouse),
      loadout: raw.loadout === undefined ? undefined : normLoadout(raw.loadout),
    };
    if (raw.lastResult !== undefined && raw.lastResult !== null) {
      patch.gacha = { lastResult: raw.lastResult };
    }
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    log && log.info('store', 'store.load', '读取存档', { schemaVersion: SCHEMA_VERSION, keys: Object.keys(patch) });
    return patch;
  }

  // 写入（白名单字段 + 节流）：tier/warehouse/loadout(+lastResult)
  function save(state) {
    if (!storage || !state) return;
    pendingState = state;
    if (saveTimer) return; // 已有待写定时器
    saveTimer = timers.setTimeout(() => {
      saveTimer = null;
      const s = pendingState;
      pendingState = null;
      const payload = {
        schemaVersion: SCHEMA_VERSION,
        tier: s.tier,
        warehouse: s.warehouse,
        loadout: s.loadout,
        ...(s.gacha && s.gacha.lastResult ? { lastResult: s.gacha.lastResult } : {}),
      };
      try {
        const text = JSON.stringify(payload);
        storage.setItem(KEY_STATE, text);
        log && log.info('store', 'store.save', '写入存档', { schemaVersion: SCHEMA_VERSION, bytes: text.length, keys: Object.keys(payload) });
      } catch (e) {
        log && log.error('store', 'store.save', '写入失败', { message: (e && e.message) || String(e) });
      }
    }, SAVE_THROTTLE_MS);
  }

  function saveLogPrefs(prefs) {
    if (!storage) return;
    try {
      storage.setItem(KEY_LOGPREFS, JSON.stringify(prefs || {}));
    } catch (e) { /* 存储不可用（隐私模式）——静默 */ }
  }

  function loadLogPrefs() {
    if (!storage) return {};
    try {
      const raw = storage.getItem(KEY_LOGPREFS);
      const v = raw ? JSON.parse(raw) : null;
      return v && typeof v === 'object' ? v : {};
    } catch (e) {
      return {};
    }
  }

  function saveSeed(seed) {
    if (!storage) return;
    try {
      if (seed === null || seed === undefined) storage.removeItem(KEY_SEED);
      else storage.setItem(KEY_SEED, JSON.stringify(seed));
    } catch (e) { /* 静默 */ }
  }

  function loadSeed() {
    if (!storage) return null;
    try {
      const raw = storage.getItem(KEY_SEED);
      return raw === null ? null : JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  // 导出全量（§8）：只含白名单字段（R7 接 UI）
  function exportState(state) {
    const payload = {
      schemaVersion: SCHEMA_VERSION,
      tier: state.tier,
      warehouse: state.warehouse,
      loadout: state.loadout,
      ...(state.gacha && state.gacha.lastResult ? { lastResult: state.gacha.lastResult } : {}),
    };
    return JSON.stringify(payload);
  }

  // 导入解析（§8）：结构校验（缺字段 → 拒绝 bad_save）；成功返回归一 patch
  function parseImport(text) {
    let v = null;
    try {
      v = JSON.parse(text);
    } catch (e) {
      return { ok: false, code: 'bad_json' };
    }
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, code: 'bad_save' };
    if (v.schemaVersion !== SCHEMA_VERSION) return { ok: false, code: 'bad_version' };
    if (typeof v.tier !== 'string' || !v.warehouse || typeof v.warehouse !== 'object' || !v.loadout || typeof v.loadout !== 'object') {
      return { ok: false, code: 'bad_save' };
    }
    return { ok: true, patch: { tier: v.tier, warehouse: normWarehouse(v.warehouse), loadout: normLoadout(v.loadout), ...(v.lastResult === undefined ? {} : { lastResult: v.lastResult }) } };
  }

  return { load, save, saveLogPrefs, loadLogPrefs, saveSeed, loadSeed, exportState, parseImport, KEY_STATE, KEY_LOGPREFS, KEY_SEED };
}
