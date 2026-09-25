'use strict';
/* tests/helpers/ranked.js —— P7-3（B31/B32/B33）测试夹具
 *
 * 职责：在 `os.tmpdir()` 下装配一套**隔离**的 store（不污染仓库 runtime/），并提供
 *       "注册**真实玩家档案**"（走 store.createAccount → journal `account.created` + 冻结快照）的公共步骤。
 *
 * 关键约定：
 *   · 玩家档案是真实档案：真实默认出战配置 + 真实 AI + 内容寻址快照 + 入池（`pool.inPool=true`）；
 *   · `playerId` 由本夹具注入（`pl_` + 16 hex），因此 `registry` 可用于断言"每个对局对手都是注册表里的真实玩家"；
 *   · 单进程锁以 pid 判活 → 同一目录重开必须先 `close()`；
 *   · 时钟可注入（默认真实 Date.now + 每调用 +1s 单调递增），便于去重窗口（24h/72h）用例。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../../server/store/index.js');
const { nullLogger, createLogger } = require('../../shared/log.js');
const { createAccount } = require('../../server/account.js');
const archiveMod = require('../../server/store/archive.js');

const VERSIONS = Object.freeze({ engine: '3.0.0', data: 'b25' });
const RATING = Object.freeze({
  base: 0, cap: 3000, scale: 400, kBase: 32, kMin: 8, kMax: 64, drawFactor: 0.5,
  matchWindowStart: 100, matchWindowStep: 100, matchWindowMax: 600,
  opponentRecoveryHours: 4, dailyBattleLimit: 0, rounding: 'half_up',
  promoteWins: 6, batchSize: 10,
});
const SERVICE = Object.freeze({
  config: { maxSlots: 3, slotIdPrefix: 'slot' },
  record: { recentLimit: 100 },
  journal: { fsyncMode: 'sync', compactAfterDays: 30, bufferBytes: 1048576 },
  pool: { ttlDays: 0, opponentRecoveryHours: 4 },
});

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dl-p7-3-'));
}

function removeTempDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

// 单调时钟（默认起点 = 真实时间；默认每次调用 +10ms —— 远小于 24h 去重窗口，可用 `advance(ms)` 显式跨窗）
function makeClock(start, stepMs) {
  const step = Number.isInteger(stepMs) && stepMs > 0 ? stepMs : 10;
  let t = Number.isInteger(start) ? start : Date.now();
  const fn = () => { t += step; return t; };
  fn.now = () => t;
  fn.advance = (ms) => { t += ms; return t; };
  return fn;
}

function makeLogger() {
  return createLogger({ level: 'all', ringSize: 20000 });
}

// 确定性 playerId（`pl_` + 16 hex）；seq 从 1 起
function makePlayerId(seq) {
  return `pl_${String(seq).padStart(16, '0')}`;
}

async function openFixture(options) {
  const o = options || {};
  const dir = o.dir || makeTempDir(o.prefix);
  const logger = o.logger === undefined ? nullLogger : o.logger;
  const clock = o.clock || makeClock(o.startAt);
  const store = createStore({
    dataDir: dir,
    versions: VERSIONS,
    logger: o.storeLogger || logger,
    now: clock,
    service: SERVICE,
    ratingConfig: RATING,
    ...(o.storeOpts || {}),
  });
  await store.open();
  const account = createAccount({ store, logger, now: clock });
  let seq = 0;
  const registry = new Map(); // playerId → { publicId, nickname, tier, points, isBot }

  // 注册**真实玩家档案**（默认出战配置 + 冻结快照 + 入池）
  async function registerPlayer(overrides) {
    const p = overrides || {};
    seq += 1;
    const playerId = p.playerId || makePlayerId(seq);
    const res = await account.createPlayerArchive({
      playerId,
      nickname: p.nickname === undefined ? `玩家${seq}` : p.nickname,
      tier: p.tier,
      points: p.points,
      isBot: p.isBot === true,
      flags: p.flags,
      at: clock(),
    });
    if (!res.ok) throw new Error(`registerPlayer 失败：${res.code} ${res.message}`);
    const archive = res.data.archive;
    registry.set(playerId, {
      playerId, publicId: archive.publicId, nickname: archive.nickname,
      tier: archive.progress.tier, points: archive.rating.points, isBot: !!archive.flags.isBot,
    });
    return { playerId, publicId: archive.publicId, archive, res };
  }

  // 连续注册 N 个真实玩家
  async function registerPlayers(count, overrides) {
    const out = [];
    for (let i = 0; i < count; i++) out.push(await registerPlayer(typeof overrides === 'function' ? overrides(i) : overrides));
    return out;
  }

  // 玩家出战快照正文（对手 loadout）
  async function loadoutOf(playerId) {
    const archive = await store.loadArchive(playerId);
    const active = archiveMod.activeSlot(archive);
    const snapshot = await store.snapshot.get(active.snapshot.hash);
    return snapshot.loadout;
  }

  return {
    dir,
    store,
    account,
    clock,
    logger,
    registry,
    VERSIONS,
    RATING,
    registerPlayer,
    registerPlayers,
    loadoutOf,
    loadedout: loadoutOf,
    events: () => (logger.records ? logger.records.map((r) => r.event) : []),
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

// 改写一份 loadout（复制 + 变更）：用于"脆弱一方必输""等待型必平"等分支用例
function mutateLoadout(loadout, mutate, tag) {
  const copy = JSON.parse(JSON.stringify(loadout));
  if (typeof mutate === 'function') mutate(copy);
  if (tag !== undefined) copy.skills[0].uid = `u_${tag}`;
  return copy;
}

// wait-only 程序：双方互不攻击 → 平局
function waitOnly(loadout, tag) {
  return mutateLoadout(loadout, (ld) => {
    ld.ai = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
  }, tag);
}

// 脆弱一方：血量 1、攻击 0 → 真实对手打到即输
function fragile(loadout, tag) {
  return mutateLoadout(loadout, (ld) => {
    ld.role.stats = { hp: 1, atk: 0, def: 0, sp: 60, mp: 40 };
  }, tag);
}

module.exports = {
  VERSIONS,
  RATING,
  SERVICE,
  makeTempDir,
  removeTempDir,
  makeClock,
  makeLogger,
  makePlayerId,
  openFixture,
  mutateLoadout,
  waitOnly,
  fragile,
};
