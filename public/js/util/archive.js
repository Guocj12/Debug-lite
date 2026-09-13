// util/archive.js —— 存档导出/导入（frontend-spec §8；纯函数；schemaVersion 校验）
import { persistFields, SCHEMA_VERSION } from '../store/persist.js';

export function exportState(state) {
  return JSON.stringify(persistFields(state), null, 2);
}

// 仓库形状归一（与 store/index.js normWh 同语义）：扁平 {role,skill,rolePlugin,skillPlugin} → buckets 分层。
// ★F7 审查 P1：normWh 仅覆盖 createStore 的 loadPersist 合并路径；reducer 'save/import' case 直存
// p.warehouse（无 normWh）→ 扁平仓库 import 会以非 buckets 形状进入 state（warehouse 屏读 buckets 断裂）。
function normWarehouse(w) {
  if (!w) return null;
  if (w.buckets) return w;
  return {
    buckets: {
      role: w.role || [], skill: w.skill || [],
      rolePlugin: w.rolePlugin || [], skillPlugin: w.skillPlugin || [],
    },
  };
}

// loadout 归一（§4.1 形状：role||null / skills 三槽 / ai 透传）：非数组或长度 ≠3 → 三槽（空位 null，超长截断）
function normLoadout(ld) {
  if (!ld) return null;
  const raw = Array.isArray(ld.skills) ? ld.skills : [];
  const skills = [0, 1, 2].map((i) => (i < raw.length ? raw[i] : null));
  return {
    role: ld.role || null,
    skills,
    ai: ld.ai !== undefined ? ld.ai : null,
  };
}

// 导入：文本 → 状态补丁（含 schemaVersion 校验/形状归一）；非法 → {ok:false, code, message}
export function parseImport(text) {
  let data = null;
  if (typeof text !== 'string') {
    return { ok: false, code: 'bad_json', message: '不是合法 JSON' };
  }
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, code: 'bad_json', message: '不是合法 JSON' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, code: 'bad_json', message: '不是合法存档' };
  }
  if (data.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, code: 'bad_version', message: `存档版本不符（期望 ${SCHEMA_VERSION}）` };
  }
  return {
    ok: true,
    data: {
      tier: typeof data.tier === 'string' ? data.tier : 'common',
      warehouse: normWarehouse(data.warehouse),
      loadout: normLoadout(data.loadout),
      seed: data.seed === undefined ? null : data.seed,
    },
  };
}