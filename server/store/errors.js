'use strict';
/* server/store/errors.js —— 存储层错误（D-129 §3.4/§10.3；契约 docs/interfaces.md §1 store/*）
 * 约束：本层**不调用 process.exit**；只把语义放在错误的 code/status/exitCode 上，
 *       由 server/index.js（HTTP，后续批次 B28+）或 CLI 决定退出码与响应码。
 *   - status  ：对应的 HTTP 状态码（§10.3 错误码表）
 *   - exitCode：进程级致命错误的期望退出码（单进程锁/版本拒绝 → 1，见 §3.4/§6.4）
 *   - fatal   ：true = 该错误发生时服务不应继续启动（启动路径必须原样冒泡给调用方）
 */
const STATUS_BY_CODE = Object.freeze({
  // 生命周期 / 一致性
  store_locked: 409,              // 单进程锁被占用（启动路径 → exitCode 1）
  store_corrupt: 500,             // journal/档案损坏且不可自动修复
  store_version_unsupported: 500, // 数据版本高于本进程（拒绝启动，防新写旧）
  store_write_failed: 500,        // 原子写失败（§7.7 → HTTP 500 store_write_failed）
  store_inconsistent: 500,        // 不变量破损（如 activeSlotId 指向不存在的槽）
  store_adapter_unavailable: 500, // 适配器未实现（如 sqlite 占位）
  store_adapter_unknown: 500,     // DL_STORE 取值非法
  store_not_found: 404,           // 档案/槽位/快照不存在
  store_internal: 500,            // 内部误用（未 open 即调用等）
  // 业务规则（§5.3 / §10.3）
  bad_request: 400,
  bad_scope: 400,
  slot_limit: 409,
  slot_locked: 409,
  slot_not_found: 404,
  config_conflict: 409,
  loadout_invalid: 409,
  no_active_config: 409,
  // D-159：服务端权威仓库 / D-160：出战完整性 / D-161：AI 库（契约 docs/interfaces.md §2.1）
  warehouse_full: 409,               // 某分类已达上限（拒绝开箱；不写 journal）
  cannot_activate_incomplete: 409,   // 设为出战时配置不完整（保存非出战槽时不校验）
  ai_limit: 409,                     // AI 库已满（默认 100，与物品分别计数）
  ai_in_use: 409,                    // 删除被出战配置引用的 AI
  item_missing: 409,                 // 仓库内物品不存在（装配目标/插件）
  slot_type_mismatch: 409,           // 插件类型与插槽不匹配（core/items 装配拒绝）
  slot_occupied: 409,                // 插槽已占用
  points_exceeded: 409,              // 角色插件点数不足
  plugin_equipped: 409,              // 插件已装配别处
  tier_locked: 409,                  // 段位门控拒绝（门控开启时）
  slot_empty: 404,                   // 拆卸时槽为空（core/items 口径）
  plugin_missing: 404,               // 拆卸时悬挂引用/插件不在仓库
});

const FATAL_CODES = new Set([
  'store_locked', 'store_corrupt', 'store_version_unsupported',
  'store_adapter_unavailable', 'store_adapter_unknown', 'store_internal',
]);

class StoreError extends Error {
  constructor(code, message, details, options) {
    super(message === undefined ? String(code) : String(message));
    this.name = 'StoreError';
    this.code = code;
    this.status = STATUS_BY_CODE[code] || 500;
    const opts = options || {};
    this.details = details === undefined ? [] : details;
    // 退出码语义（§10.4）：0 成功 / 1 业务拒绝 / 2 参数错误；存储层错误一律属于"业务拒绝或致命" → 1
    this.exitCode = Number.isInteger(opts.exitCode) ? opts.exitCode : 1;
    this.fatal = opts.fatal === undefined ? FATAL_CODES.has(code) : !!opts.fatal;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details, status: this.status };
  }
}

function storeError(code, message, details, options) {
  return new StoreError(code, message, details, options);
}

function isStoreError(err) {
  return !!err && err.name === 'StoreError';
}

// details 统一为 §10.3 的 [{path, code, message}] 形状（HTTP 层直接回带）
function detail(code, message, path) {
  return { path: path === undefined ? '' : path, code, message: message === undefined ? code : message };
}

module.exports = { StoreError, STATUS_BY_CODE, FATAL_CODES, storeError, isStoreError, detail };
