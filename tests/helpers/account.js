'use strict';
/* tests/helpers/account.js —— P7-2（B28/B29/B30）测试夹具
 *
 * 职责：在 `os.tmpdir()` 下装配一套**隔离**的 store + account + auth（不污染仓库 runtime/），
 *       并提供注册、战绩结算、重开同一 DL_DATA_DIR 等公共步骤。
 *
 * 关键约定：
 *   · 临时目录 + 注入时钟（自 Date.now() 起每调用 +1s 单调递增）：让槽位 updatedAt（乐观锁）、
 *     会话 createdAt/expiresAt（会话表的过期判定用真实 Date.now()，故时钟必须贴近真实时间）都可复现；
 *   · 测试用 scrypt N=1024（默认 16384 每次约 60ms）；`tests/unit/auth.test.js` 另有一条默认参数用例；
 *   · 单进程锁（store/lock.js）以 pid 判活：**重开同一目录必须先 close()**（同进程 pid 相同会被判占用）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../server/store/index.js');
const { nullLogger, createLogger } = require('../../shared/log.js');
const { createAuth } = require('../../server/auth.js');
const { createAccount } = require('../../server/account.js');

const VERSIONS = Object.freeze({ engine: '3.0.0', data: 'b25' });
const FAST_AUTH = Object.freeze({ auth: { scrypt: { N: 1024, r: 8, p: 1 } } });
const PASSWORD = 'pw12345678';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dl-p7-2-'));
}

function removeTempDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

// 单调时钟：起点 = 真实当前时间（保证会话 TTL 判定有效），每次调用 +1s
function makeClock(start) {
  let t = Number.isInteger(start) ? start : Date.now();
  const fn = () => { t += 1000; return t; };
  fn.now = () => t;
  return fn;
}

function makeLogger() {
  return createLogger({ level: 'all', ringSize: 20000 });
}

// 装配夹具：{ dir, store, account, auth, clock, logger, events(), reopen(), close(), cleanup() }
async function openFixture(options) {
  const o = options || {};
  const dir = o.dir || makeTempDir(o.prefix);
  const logger = o.logger === undefined ? nullLogger : o.logger;
  const clock = o.clock || makeClock(o.startAt);
  const store = createStore({
    dataDir: dir,
    versions: VERSIONS,
    logger: o.storeLogger || nullLogger,
    now: clock,
    ...(o.storeOpts || {}),
  });
  await store.open();
  const account = createAccount({ store, logger, now: clock });
  // config: 省略 → 测试用快速 scrypt；显式 `null` → 用 store.config.auth（默认 N=16384）
  const authConfig = o.config === undefined ? FAST_AUTH : (o.config === null ? undefined : o.config);
  const auth = createAuth({ store, logger, now: clock, account, config: authConfig });
  return {
    dir,
    store,
    account,
    auth,
    clock,
    logger,
    // 收集到的日志事件名（断言事件矩阵用）
    events: () => (logger.records ? logger.records.map((r) => r.event) : []),
    // 关掉当前适配器后用**同一目录**重新装配（重启一致性/锁语义）
    reopen: async (reopenOptions) => {
      await store.close();
      return openFixture({ ...o, ...(reopenOptions || {}), dir, clock });
    },
    close: () => store.close(),
    cleanup: async () => {
      await store.close();
      removeTempDir(dir);
    },
  };
}

// 注册一个玩家；返回 {res, playerId, publicId, username, password, token}
let usernameSeq = 0;

function nextUsername(tag) {
  usernameSeq += 1;
  const base = tag === undefined || tag === null ? 'user' : String(tag).replace(/[^A-Za-z0-9_-]/g, '') || 'user';
  return `${base}_${usernameSeq}`.slice(0, 24);
}

async function registerPlayer(auth, overrides) {
  const o = overrides || {};
  const username = o.username || nextUsername(o.tag);
  const password = o.password || PASSWORD;
  const res = await auth.register({
    username,
    password,
    nickname: o.nickname,
    ip: o.ip,
    userAgent: o.userAgent,
    warehouse: o.warehouse,
  });
  return {
    res,
    username,
    password,
    playerId: res.ok ? res.data.playerId : null,
    publicId: res.ok ? res.data.publicId : null,
    token: res.ok ? res.data.token : null,
  };
}

// 有效 loadout（非默认槽用）：默认配置改一个技能参数 → 内容不同但结构/门控仍合法
function sampleLoadout(account, mutate) {
  const ld = account.defaultLoadout();
  ld.skills[0].params = Object.assign({}, ld.skills[0].params, { cooldown: 3 });
  if (typeof mutate === 'function') mutate(ld);
  return ld;
}

// 一场快速对战的 journal 输入（B 类跨玩家结算；与 tests/contract/store-contract.test.js 同口径）
function quickRecord(a, b, overrides) {
  const o = overrides || {};
  return {
    mode: 'quick',
    seed: o.seed === undefined ? 7 : o.seed,
    at: o.at,
    p1: {
      playerId: a.playerId,
      publicId: a.publicId,
      role: 'attacker',
      snapshotHash: a.snapshotHash,
      configHash: a.configHash,
      pointsBefore: o.p1Before === undefined ? 100 : o.p1Before,
      pointsAfter: o.p1After === undefined ? 114 : o.p1After,
      result: o.p1Result || 'win',
      tierBefore: 'common',
      tierAfter: 'common',
    },
    p2: {
      playerId: b.playerId,
      publicId: b.publicId,
      role: 'defender',
      snapshotHash: b.snapshotHash,
      configHash: b.configHash,
      pointsBefore: o.p2Before === undefined ? 100 : o.p2Before,
      pointsAfter: o.p2After === undefined ? 86 : o.p2After,
      result: o.p2Result || 'loss',
      tierBefore: 'common',
      tierAfter: 'common',
    },
    verdict: { winner: o.winner || 'p1', reason: 'hero_dead', ticks: o.ticks === undefined ? 23 : o.ticks },
    versions: VERSIONS,
  };
}

// 取玩家的出战快照 hash/configHash（战绩记录需要）
function activeSnapshot(archive) {
  const active = (archive.configs.slots || []).find((s) => s.slotId === archive.configs.activeSlotId);
  return { snapshotHash: active.snapshot.hash, configHash: active.snapshot.configHash };
}

module.exports = {
  VERSIONS,
  FAST_AUTH,
  PASSWORD,
  makeTempDir,
  removeTempDir,
  makeClock,
  makeLogger,
  openFixture,
  registerPlayer,
  sampleLoadout,
  quickRecord,
  activeSnapshot,
};
