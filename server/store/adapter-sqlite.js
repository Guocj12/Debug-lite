'use strict';
/* server/store/adapter-sqlite.js —— `node:sqlite` 适配器（**预留占位**，D-129 §11.4）
 * 权威：docs/systems/11-account-store.md §11.4（何时引入数据库：判据 + 迁移路径）。
 *
 * 触发判据（任一命中即启动迁移，非本批次）：
 *   1) 玩家数 > 5 万（索引/档案管理别扭）；
 *   2) 写 QPS > 500（JSON 原子写 + fsync 撑不住）；
 *   3) 需要多进程/多机写入（JSON 方案为单进程设计）；
 *   4) 排行榜分页、审计查询、段位池抽样等复杂查询成为日常。
 *
 * 切换点（**业务代码零改动**）：`server/store/index.js` 按 `DL_STORE`（默认 `json`）选择适配器；
 *   届时只需实现本文件并保证 `tests/contract/store-contract.test.js` 的同一套断言全绿。
 *
 * 表结构（§11.4 步骤 2，落地时按此建表）：
 *   players(player_id PK, public_id, nickname, tier, points, in_pool, is_bot, archive_json, applied_seq, updated_at)
 *   journal(seq PK, type, battle_id, payload_json, at)
 *   snapshots(hash PK, body_json, ref_count, created_at)
 *   sessions(token_hash PK, player_id, expires_at)
 *
 * 本轮行为：`open()` 抛出 store_adapter_unavailable（不静默退回 json，避免"以为在用 SQLite"）。
 *   直接 require 'node:sqlite' 会在未启用实验标志的环境告警/失败，故本文件**不 require**，只在错误信息里注明。
 */
const { StoreError } = require('./errors.js');

const ADAPTER_NAME = 'sqlite';

const TRIGGERS = Object.freeze([
  'playerCount > 50000',
  'writeQps > 500',
  'needs multi-process writes',
  'complex queries (leaderboard paging / audit / pool sampling)',
]);

const TABLES = Object.freeze([
  'players(player_id PK, public_id, nickname, tier, points, in_pool, is_bot, archive_json, applied_seq, updated_at)',
  'journal(seq PK, type, battle_id, payload_json, at)',
  'snapshots(hash PK, body_json, ref_count, created_at)',
  'sessions(token_hash PK, player_id, expires_at)',
]);

function createSqliteAdapter(options) {
  const opts = options || {};
  const unavailable = () => new StoreError('store_adapter_unavailable',
    `DL_STORE=sqlite 尚未实现（预留：Node 24 内置 node:sqlite；判据见 server/store/adapter-sqlite.js 与设计文档 §11.4）`,
    [{ path: opts.dataDir || '', code: 'store_adapter_unavailable', message: `触发判据：${TRIGGERS.join(' / ')}` }],
    { fatal: true });
  const adapter = {
    adapterName: ADAPTER_NAME,
    implemented: false,
    dataDir: opts.dataDir || null,
    triggers: TRIGGERS,
    tables: TABLES,
    async open() { throw unavailable(); },
    async close() { throw unavailable(); },
  };
  // 未实现的其余方法统一拒绝（Promise 形态，防止调用方误以为可用）
  const notImpl = async () => { throw unavailable(); };
  for (const name of [
    'loadArchive', 'saveArchive', 'updateArchive', 'createAccount', 'setPasswordHash', 'setBanned',
    'setNickname', 'setPool', 'saveConfigSlot', 'createConfigSlot', 'activateConfigSlot', 'deleteConfigSlot',
    'freezeSnapshot', 'append', 'applyRecord', 'settleBattle', 'records', 'defenseSummary', 'recover',
    'rebuildIndex', 'stats',
  ]) {
    adapter[name] = notImpl;
  }
  return adapter;
}

module.exports = { ADAPTER_NAME, TRIGGERS, TABLES, createSqliteAdapter };
