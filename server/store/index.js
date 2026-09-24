'use strict';
/* server/store/index.js —— 存储层入口：适配器装配与环境变量（D-129 §3.1/§11.4；契约 docs/interfaces.md §1）
 *
 * 对外只暴露一个工厂：
 *   const store = createStore({ logger, dataDir, versions, ... });   // 同步装配（不碰磁盘）
 *   await store.open();                                             // 建目录 → 加锁 → 加载 → 恢复
 *   await store.close();                                            // flush → 保存索引/会话 → 释放锁
 *   // 或一步到位：await openStore({...})
 *
 * 环境变量（docs/server.md §2 / docs/interfaces.md §7）：
 *   DL_DATA_DIR  运行时数据根，默认 <repo>/runtime（已在 .gitignore）
 *   DL_STORE     存储适配器：'json'（默认）| 'sqlite'（预留）
 *
 * 环境读取口径（C5 修复，2026-09-19）：所有 `DL_*` 一律经 `envOf(explicit)` 解析 ——
 *   · 显式注入（`createStore({env})`）**优先**；
 *   · 注入对象**未提供的键回退真实 `process.env`**（语义"注入 = 覆盖层"，空对象不得整体屏蔽）；
 *   · 未注入（undefined/null）→ 直接用 `process.env`。
 *   修前：`resolveDataDir` 只读真实 `process.env`，而 `server/index.js` 用注入 env 决定"是否装配"
 *   → `start({env:{DL_DATA_DIR:T}})` 落到 `<repo>/runtime`；`start({env:{}})` 反而把 store 整体关掉。
 *   注：`DL_CONFIG_DIR` 并不存在（本文件此前误记）；只读配置目录请用显式选项 `configDir`（等价于
 *   `<repo>/server/data` 覆盖），不以环境变量暴露——否则 `dataVersion` 指纹会因目录不完整退化为 unknown。
 *
 * 适配器契约（json 与 sqlite 必须逐项等价；契约测试 tests/contract/store-contract.test.js）：
 *   生命周期 open/close/isOpen；档案 loadArchive/saveArchive/updateArchive/listPlayerIds/getSummary；
 *   账号 createAccount/setPasswordHash/setBanned/setNickname/setPool/touchLastSeen/markRecordsSeen；
 *   配置槽 saveConfigSlot/createConfigSlot/activateConfigSlot/deleteConfigSlot/freezeSnapshot；
 *   **D-159 服务端权威仓库** getWarehouse/grantBox/applyWarehouseChange；
 *   **D-161 AI 库** listAi/createAi/deleteAi；
 *   journal append/appendMany/applyRecord/applyRecords/settleBattle/readRecords/findBattleRecord/replayJournal/maxSeq/compactJournal；
 *   战绩 records/defenseSummary/opponentWindow；索引 index.{snapshot,get,byTier,leaderboard,rank,rebuild,save,stats}；
 *   快照 snapshot.{freeze,put,get,has,list,ref,refCount,gc,stats}；会话 sessions.{put,get,touch,revoke,revokePlayer,list,prune,size}；
 *   维护 recover/rebuildIndex/gc/stats。
 */
const path = require('node:path');
const { nullLogger } = require('../../shared/log.js');
const { StoreError } = require('./errors.js');
const archiveMod = require('./archive.js');
const ledger = require('./ledger.js');
const fsatomic = require('./fsatomic.js');
const configMod = require('./config.js');
const snapMod = require('./snapshot-store.js');
const journalMod = require('./journal.js');
const indexMod = require('./index-file.js');
const lockMod = require('./lock.js');
const sessionMod = require('./session-table.js');
const recoveryMod = require('./recovery.js');
const jsonAdapter = require('./adapter-json.js');
const sqliteAdapter = require('./adapter-sqlite.js');

const DEFAULT_DATA_DIRNAME = 'runtime';

function repoRoot() {
  return path.join(__dirname, '..', '..');
}

function defaultDataDir() {
  return path.join(repoRoot(), DEFAULT_DATA_DIRNAME);
}

// 环境解析（C5）：显式注入优先；未提供的键回退真实 process.env（空对象 = 纯覆盖层，不屏蔽）
function envOf(explicit) {
  if (explicit === undefined || explicit === null) return process.env;
  return { ...process.env, ...explicit };
}

function resolveDataDir(explicit, env) {
  if (typeof explicit === 'string' && explicit !== '') return path.resolve(explicit);
  const e = envOf(env);
  if (typeof e.DL_DATA_DIR === 'string' && e.DL_DATA_DIR !== '') {
    return path.resolve(e.DL_DATA_DIR);
  }
  return defaultDataDir();
}

function resolveAdapterName(explicit, env) {
  const e = envOf(env);
  const name = typeof explicit === 'string' && explicit !== '' ? explicit
    : (typeof e.DL_STORE === 'string' && e.DL_STORE !== '' ? e.DL_STORE : jsonAdapter.ADAPTER_NAME);
  return String(name).toLowerCase();
}

function createStore(options) {
  const opts = options || {};
  const env = envOf(opts.env);
  const adapterName = resolveAdapterName(opts.adapter, env);
  const dataDir = resolveDataDir(opts.dataDir, env);
  const common = {
    dataDir,
    logger: opts.logger || nullLogger,
    now: opts.now,
    lock: opts.lock,
    versions: opts.versions,
    config: opts.config,
    ratingConfig: opts.ratingConfig,
    configDir: opts.configDir,
  };
  if (adapterName === jsonAdapter.ADAPTER_NAME) return jsonAdapter.createJsonAdapter(common);
  if (adapterName === sqliteAdapter.ADAPTER_NAME) return sqliteAdapter.createSqliteAdapter(common);
  throw new StoreError('store_adapter_unknown',
    `DL_STORE=${adapterName} 非法（可选：json | sqlite）`,
    [{ path: 'DL_STORE', code: 'store_adapter_unknown', message: `未知适配器 ${adapterName}` }],
    { fatal: true });
}

async function openStore(options) {
  const store = createStore(options);
  await store.open();
  return store;
}

module.exports = {
  DEFAULT_DATA_DIRNAME,
  repoRoot,
  defaultDataDir,
  envOf,
  resolveDataDir,
  resolveAdapterName,
  createStore,
  openStore,
  StoreError,
  // 供上层（account/quickmatch/ranked）直接复用的纯领域工具
  archive: archiveMod,
  ledger,
  fsatomic,
  config: configMod,
  snapshot: snapMod,
  journal: journalMod,
  indexFile: indexMod,
  lock: lockMod,
  sessionTable: sessionMod,
  recovery: recoveryMod,
  adapters: { json: jsonAdapter, sqlite: sqliteAdapter },
};
