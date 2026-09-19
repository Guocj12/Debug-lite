'use strict';
/* tests/unit/store-config.test.js —— 服务/积分配置默认值与数据表覆盖；存储层入口的环境变量解析
 * 权威：docs/interfaces.md §4.11/§4.12、docs/server.md §2（DL_DATA_DIR/DL_STORE）、11-account-store §8.3/§11.3。
 * 注意：`server/data/service-config.json` 与 `rating-config.json` 属数据层（后续批次），本轮不创建；
 *       本测试用**临时 configDir** 验证"存在即覆盖、缺失用内置默认值"两条路径。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const configMod = require('../../server/store/config.js');
const entry = require('../../server/store/index.js');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-store-config-'));
}

test('CFG-1 默认 service config 覆盖 interfaces §4.12 的全部键与 §11.3 的缓存上限', () => {
  const s = configMod.DEFAULT_SERVICE_CONFIG;
  for (const key of ['auth', 'session', 'config', 'record', 'store', 'journal', 'snapshot', 'replayCacheSize', 'pool']) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, key), `缺 ${key}`);
  }
  assert.equal(s.config.maxSlots, 3);
  assert.equal(s.record.recentLimit, 100);
  assert.equal(s.store.archiveCacheSize, 200);
  assert.equal(s.store.snapshotCacheSize, 500);
  assert.equal(s.replayCacheSize, 64);
  assert.equal(s.journal.fsyncMode, 'batch');
  assert.equal(s.journal.compactAfterDays, 30);
  assert.equal(s.journal.bufferBytes, 1048576);
  assert.equal(s.snapshot.retentionDays, 90);
  assert.equal(s.session.ttlDays, 7);
  assert.equal(s.session.maxPerPlayer, 5);
  assert.equal(s.pool.opponentCooldownHours, 24);
  assert.equal(s.auth.scrypt.N, 16384);
  assert.equal(s.auth.maxFailures, 5);
  assert.equal(s.auth.lockMinutes, 5);
  assert.equal(Object.isFrozen(s), true);
});

test('CFG-2 默认 rating config 与 §8.3 数值逐项一致', () => {
  const r = configMod.DEFAULT_RATING_CONFIG;
  assert.deepEqual(
    { base: r.base, cap: r.cap, scale: r.scale, kBase: r.kBase, kMin: r.kMin, kMax: r.kMax, drawFactor: r.drawFactor },
    { base: 0, cap: 3000, scale: 400, kBase: 32, kMin: 8, kMax: 64, drawFactor: 0.5 },
  );
  assert.equal(r.matchWindowStart, 100);
  assert.equal(r.matchWindowStep, 100);
  assert.equal(r.matchWindowMax, 600);
  assert.equal(r.opponentCooldownHours, 24);
  assert.equal(r.dailyBattleLimit, 0);
  assert.equal(r.rounding, 'half_up');
  assert.equal(r.promoteWins, 6, 'D-122 晋升阈值');
  assert.equal(r.batchSize, 10);
  assert.equal(Object.isFrozen(r), true);
});

test('CFG-3 loadConfigs：数据表存在即深合并覆盖（文件 > 内置）；缺失用默认值', () => {
  const dir = mkTmp();
  try {
    const empty = configMod.loadConfigs({ configDir: dir });
    assert.deepEqual(empty.sources, []);
    assert.equal(empty.service.config.maxSlots, 3);
    assert.equal(empty.rating.cap, 3000);
    fs.writeFileSync(path.join(dir, configMod.SERVICE_CONFIG_FILE),
      JSON.stringify({ config: { maxSlots: 5 }, record: { recentLimit: 20 } }), 'utf8');
    fs.writeFileSync(path.join(dir, configMod.RATING_CONFIG_FILE), JSON.stringify({ cap: 2000, kMin: 4 }), 'utf8');
    const merged = configMod.loadConfigs({ configDir: dir });
    assert.deepEqual(merged.sources.sort(), [configMod.RATING_CONFIG_FILE, configMod.SERVICE_CONFIG_FILE].sort());
    assert.equal(merged.service.config.maxSlots, 5);
    assert.equal(merged.service.record.recentLimit, 20);
    assert.equal(merged.service.session.ttlDays, 7, '未覆盖的键保持默认');
    assert.equal(merged.rating.cap, 2000);
    assert.equal(merged.rating.kMin, 4);
    assert.equal(merged.rating.kMax, 64);
    // 代码侧覆盖（opts.service/rating）优先级最高
    const overridden = configMod.loadConfigs({ configDir: dir, service: { config: { maxSlots: 1 } }, rating: { cap: 100 } });
    assert.equal(overridden.service.config.maxSlots, 1);
    assert.equal(overridden.rating.cap, 100);
    assert.equal(overridden.configDir, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('CFG-4 computeDataVersion：真实数据表 → 8 位 hex 指纹；目录缺失 → unknown', () => {
  const real = configMod.computeDataVersion(configMod.defaultConfigDir());
  assert.match(real, /^[0-9a-f]{8}$/, `dataVersion 应为 8 位 hex（实测 ${real}）`);
  assert.equal(configMod.computeDataVersion(path.join(os.tmpdir(), 'dl-store-no-such-dir-xyz')), 'unknown');
  assert.equal(configMod.DATA_VERSION_TABLES.length, 5);
  assert.ok(configMod.DATA_VERSION_TABLES.includes('battle-config.json'));
});

test('CFG-5 mergeDeep：嵌套对象深合并、数组/标量整体覆盖、null 覆盖', () => {
  const base = { a: { x: 1, y: 2 }, b: [1, 2], c: 'k', d: { z: 1 } };
  const out = configMod.mergeDeep(base, { a: { y: 3, w: 4 }, b: [9], c: null, d: 'str' });
  assert.deepEqual(out, { a: { x: 1, y: 3, w: 4 }, b: [9], c: null, d: 'str' });
  assert.equal(out.a === base.a, false, '不修改原对象');
  assert.deepEqual(base.a, { x: 1, y: 2 });
  assert.equal(configMod.mergeDeep({ a: 1 }, 'not-object').a, 1);
  assert.equal(configMod.mergeDeep(undefined, { a: 1 }).a, 1);
});

test('CFG-6 存储层入口：DL_DATA_DIR / DL_STORE / 默认 runtime 的解析', () => {
  const oldData = process.env.DL_DATA_DIR;
  const oldStore = process.env.DL_STORE;
  const tmp = mkTmp();
  try {
    delete process.env.DL_DATA_DIR;
    delete process.env.DL_STORE;
    assert.equal(entry.resolveDataDir(), path.join(entry.repoRoot(), 'runtime'));
    assert.equal(entry.resolveDataDir(''), path.join(entry.repoRoot(), 'runtime'));
    assert.equal(entry.resolveDataDir(tmp), path.resolve(tmp));
    process.env.DL_DATA_DIR = tmp;
    assert.equal(entry.resolveDataDir(), path.resolve(tmp));
    assert.equal(entry.resolveDataDir('rel'), path.resolve('rel'), '显式参数优先于环境变量');
    assert.equal(entry.resolveAdapterName(), 'json');
    process.env.DL_STORE = 'SQLITE';
    assert.equal(entry.resolveAdapterName(), 'sqlite');
    assert.equal(entry.resolveAdapterName('json'), 'json', '显式参数优先');
    assert.equal(entry.DEFAULT_DATA_DIRNAME, 'runtime');
    assert.equal(entry.defaultDataDir(), path.join(entry.repoRoot(), 'runtime'));
    assert.throws(() => entry.createStore({ dataDir: tmp, adapter: 'mysql' }), (e) => e.code === 'store_adapter_unknown');
    // createStore 默认适配器（不 open，不碰磁盘）；先清掉上面为验证环境变量而设的 DL_STORE
    delete process.env.DL_STORE;
    const store = entry.createStore({ dataDir: tmp });
    assert.equal(store.adapterName, 'json');
    assert.equal(store.dataDir, path.resolve(tmp));
    assert.equal(store.versions.engine, '0.0.0');
    assert.match(store.versions.data, /^[0-9a-f]{8}$|^unknown$/);
    assert.equal(typeof entry.openStore, 'function');
    assert.equal(typeof entry.StoreError, 'function');
    assert.ok(entry.archive && entry.ledger && entry.snapshot && entry.journal && entry.adapters.json && entry.adapters.sqlite);
  } finally {
    if (oldData === undefined) delete process.env.DL_DATA_DIR; else process.env.DL_DATA_DIR = oldData;
    if (oldStore === undefined) delete process.env.DL_STORE; else process.env.DL_STORE = oldStore;
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('CFG-7 openStore：一步装配 + 打开 + 关闭（临时目录）', async () => {
  const dir = mkTmp();
  try {
    const store = await entry.openStore({ dataDir: dir, versions: { engine: '1.2.3', data: 'zz' }, logger: require('../../shared/log.js').nullLogger });
    assert.equal(store.isOpen(), true);
    assert.equal(store.versions.engine, '1.2.3');
    assert.equal(store.versions.data, 'zz');
    assert.equal(store.adapterName, entry.resolveAdapterName());
    await store.close();
    assert.equal(store.isOpen(), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
