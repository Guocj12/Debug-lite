'use strict';
/* server/store/config.js —— 服务配置默认值、可选数据表覆盖、dataVersion 指纹（D-129 §11.3/§5.4）
 * 权威：docs/interfaces.md §4.12（service-config.json）/ §4.11（rating-config.json）
 *      docs/systems/11-account-store.md §8.3（rating 默认值）/ §11.3（缓存上限）
 * 文件所有权说明（本轮 B27）：`server/data/service-config.json` 与 `server/data/rating-config.json`
 * 属数据层（后续批次），本轮**不创建**；本模块内置等价默认值，并在两文件存在时读取合并
 * （深合并，文件优先）。这样先落地存储层，且后续补数据表时零代码改动。
 */
const path = require('node:path');
const fsatomic = require('./fsatomic.js');
const { sha256Hex, deepClone } = require('./canonical.js');

const SERVICE_CONFIG_FILE = 'service-config.json';
const RATING_CONFIG_FILE = 'rating-config.json';

const DEFAULT_SERVICE_CONFIG = Object.freeze({
  auth: {
    scrypt: { N: 16384, r: 8, p: 1 },
    saltBytes: 16,
    hashBytes: 64,
    usernameMin: 3,
    usernameMax: 24,
    nicknameMax: 16,
    passwordMin: 8,
    passwordMax: 72,
    passwordMaxBytes: 256,
    maxFailures: 5,
    lockMinutes: 5,
    rateLimitPerMinute: 10,
  },
  session: { ttlDays: 7, maxPerPlayer: 5, maxTotalDays: 30 },
  config: { maxSlots: 3, slotIdPrefix: 'slot' },
  record: { recentLimit: 100 },
  store: { archiveCacheSize: 200, snapshotCacheSize: 500 },
  journal: { fsyncMode: 'batch', compactAfterDays: 30, bufferBytes: 1048576 },
  snapshot: { retentionDays: 90 },
  replayCacheSize: 64,
  // P2-8：`pool.ttlDays` 当前**零消费方**（对局/抽池路径均不读它）——按 §7.2 的"参数已留、未启用"口径登记，
  //   与 `rating.dailyBattleLimit` 的标注方式一致；文档 `11-account-store.md §7.2` 的表需同步为"⏸ 未启用"。
  pool: { ttlDays: 0, opponentCooldownHours: 24 },
  // D-159：仓库改为服务端权威（推翻 D-130 的"仓库由客户端持有"）——四桶各自上限；超限拒绝开箱
  warehouse: { maxPerBucket: 500 },
  // D-161：AI 库与物品**分别计数**；满则拒绝创建
  ai: { maxPerPlayer: 100 },
});

const DEFAULT_RATING_CONFIG = Object.freeze({
  base: 0,
  cap: 3000,
  scale: 400,
  kBase: 32,
  kMin: 8,
  kMax: 64,
  drawFactor: 0.5,
  matchWindowStart: 100,
  matchWindowStep: 100,
  matchWindowMax: 600,
  opponentCooldownHours: 24,
  dailyBattleLimit: 0,
  rounding: 'half_up',
  promoteWins: 6, // D-122：批次 10 场、胜 > 6 晋升（x = 6）
  batchSize: 10,
});

// D-129 §5.4：dataVersion = sha256(role-templates|skill-templates|plugins|qualities|battle-config)[0..7]
const DATA_VERSION_TABLES = Object.freeze([
  'role-templates.json', 'skill-templates.json', 'plugins.json', 'qualities.json', 'battle-config.json',
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep(base, override) {
  if (!isPlainObject(override)) return base === undefined ? override : base;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const key of Object.keys(override)) {
    const next = override[key];
    out[key] = isPlainObject(next) && isPlainObject(out[key]) ? mergeDeep(out[key], next) : next;
  }
  return out;
}

function defaultConfigDir(repoRoot) {
  return path.join(repoRoot || path.join(__dirname, '..', '..'), 'server', 'data');
}

// 元数据键（`_note`/`_sample`/…）不进入运行期配置：数据表与内容层同惯例，元数据与载荷同层存放
function stripMeta(obj) {
  const out = {};
  for (const key of Object.keys(obj || {})) {
    if (!key.startsWith('_')) out[key] = obj[key];
  }
  return out;
}

// 读取数据表并深合并到内置默认值；合并顺序 **文件 > 内置 > opts**（opts 为代码侧最终覆盖）
//   —— 表存在时以表为数值单一来源（"数值在表"），内置默认值仅在表缺失时兜底。
// 合并出口**深拷贝**（P7-2 审查 P2）：`mergeDeep` 只做浅展开（`{...base}`），文件/opts 未覆盖的嵌套键
//   会与模块级 `DEFAULT_*_CONFIG` **共享引用** —— 调用方就地写 `store.config.auth.X` 会污染默认值并跨实例
//   泄漏（第二个 store 也读到被改的值）。这里在出口用 canonical.js 的 `deepClone`（structuredClone 封装，
//   零新依赖）切断共享。**刻意不引入深冻结**：那会把将来"合法覆盖默认值"的代码变成硬报错。
function loadConfigs(options) {
  const opts = options || {};
  const configDir = opts.configDir || defaultConfigDir();
  const serviceFile = path.join(configDir, SERVICE_CONFIG_FILE);
  const ratingFile = path.join(configDir, RATING_CONFIG_FILE);
  const serviceFromFile = fsatomic.readJsonSync(serviceFile, null);
  const ratingFromFile = fsatomic.readJsonSync(ratingFile, null);
  const service = deepClone(mergeDeep(DEFAULT_SERVICE_CONFIG, mergeDeep(stripMeta(serviceFromFile), opts.service || {})));
  const rating = deepClone(mergeDeep(DEFAULT_RATING_CONFIG, mergeDeep(stripMeta(ratingFromFile), opts.rating || {})));
  const sources = [];
  if (serviceFromFile) sources.push(SERVICE_CONFIG_FILE);
  if (ratingFromFile) sources.push(RATING_CONFIG_FILE);
  return { service, rating, sources, configDir };
}

// 数据表指纹（启动时算一次；文件缺失 → 'unknown'，不阻塞启动）
function computeDataVersion(configDir) {
  const dir = configDir || defaultConfigDir();
  const parts = [];
  for (const table of DATA_VERSION_TABLES) {
    const stat = fsatomic.statSafe(path.join(dir, table));
    if (stat === null) return 'unknown';
    parts.push(fsatomic.readText(path.join(dir, table)));
  }
  return sha256Hex(parts.join('|')).slice(0, 8);
}

module.exports = {
  SERVICE_CONFIG_FILE,
  RATING_CONFIG_FILE,
  DEFAULT_SERVICE_CONFIG,
  DEFAULT_RATING_CONFIG,
  DATA_VERSION_TABLES,
  mergeDeep,
  stripMeta,
  defaultConfigDir,
  loadConfigs,
  computeDataVersion,
};
