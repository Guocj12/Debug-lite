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
 *   DL_CONFIG_DIR 只读数据表目录（可选，默认 <repo>/server/data；用于 service-config/rating-config 覆盖与 dataVersion）
 *
 * 适配器契约（json 与 sqlite 必须逐项等价；契约测试 tests/contract/store-contract.test.js）：
 *   生命周期 open/close/isOpen；档案 loadArchive/saveArchive/updateArchive/listPlayerIds/getSummary；
 *   账号 createAccount/setPasswordHash/setBanned/setNickname/setPool/touchLastSeen/markRecordsSeen；
 *   配置槽 saveConfigSlot/createConfigSlot/activateConfigSlot/deleteConfigSlot/freezeSnapshot；
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

function resolveDataDir(explicit) {
  if (typeof explicit === 'string' && explicit !== '') return path.resolve(explicit);
  if (typeof process.env.DL_DATA_DIR === 'string' && process.env.DL_DATA_DIR !== '') {
    return path.resolve(process.env.DL_DATA_DIR);
  }
  return defaultDataDir();
}

function resolveAdapterName(explicit) {
  const name = typeof explicit === 'string' && explicit !== '' ? explicit
    : (typeof process.env.DL_STORE === 'string' && process.env.DL_STORE !== '' ? process.env.DL_STORE : jsonAdapter.ADAPTER_NAME);
  return String(name).toLowerCase();
}

function createStore(options) {
  const opts = options || {};
  const adapterName = resolveAdapterName(opts.adapter);
  const dataDir = resolveDataDir(opts.dataDir);
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
