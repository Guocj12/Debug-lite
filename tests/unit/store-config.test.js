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
  assert.equal(s.pool.opponentRecoveryHours, 4);
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
  assert.equal(r.opponentRecoveryHours, 4, 'D-168 软冷却：4 小时线性回满');
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

test('CFG-8 配置合并出口深拷贝（P7-2 审查 P2）：就地改配置不污染默认值、不跨实例泄漏', () => {
  const dir = mkTmp();
  try {
    // ① loadConfigs 出口不得与模块级默认值共享引用（含嵌套层）
    const a = configMod.loadConfigs({ configDir: dir });
    assert.notEqual(a.service, configMod.DEFAULT_SERVICE_CONFIG, 'service 根对象不共享');
    assert.notEqual(a.service.auth, configMod.DEFAULT_SERVICE_CONFIG.auth, 'auth 段不得 === DEFAULT_SERVICE_CONFIG.auth');
    assert.notEqual(a.service.auth.scrypt, configMod.DEFAULT_SERVICE_CONFIG.auth.scrypt, '嵌套 scrypt 也不共享');
    assert.notEqual(a.service.session, configMod.DEFAULT_SERVICE_CONFIG.session, 'session 段不共享');
    assert.notEqual(a.rating, configMod.DEFAULT_RATING_CONFIG, 'rating 根对象不共享');
    // ② 就地改一个实例 → 新建实例读到默认值，模块级默认值纹丝不动
    a.service.auth.maxFailures = 999;
    a.service.auth.scrypt.N = 2;
    a.service.session.ttlDays = 1;
    a.rating.cap = 1;
    const b = configMod.loadConfigs({ configDir: dir });
    assert.equal(b.service.auth.maxFailures, 5, '新实例必须读到默认 maxFailures');
    assert.equal(b.service.auth.scrypt.N, 16384, '新实例必须读到默认 scrypt.N');
    assert.equal(b.service.session.ttlDays, 7);
    assert.equal(b.rating.cap, 3000);
    assert.equal(configMod.DEFAULT_SERVICE_CONFIG.auth.maxFailures, 5, 'DEFAULT_SERVICE_CONFIG.auth 未被就地改动');
    assert.equal(configMod.DEFAULT_SERVICE_CONFIG.auth.scrypt.N, 16384);
    assert.equal(configMod.DEFAULT_SERVICE_CONFIG.session.ttlDays, 7);
    assert.equal(configMod.DEFAULT_RATING_CONFIG.cap, 3000);
    // ③ 真实 store 实例：改 store1.config → store2 读到默认（审查报告的最小复现路径）
    const store1 = entry.createStore({ dataDir: dir, versions: { engine: 't', data: 't' } });
    assert.notEqual(store1.config.auth, configMod.DEFAULT_SERVICE_CONFIG.auth, 'store.config.auth 不得 === DEFAULT_SERVICE_CONFIG.auth');
    store1.config.auth.maxFailures = 999;
    const store2 = entry.createStore({ dataDir: dir, versions: { engine: 't', data: 't' } });
    assert.equal(store2.config.auth.maxFailures, 5, 'store2 不得读到 store1 的改动（跨实例泄漏）');
    assert.equal(configMod.DEFAULT_SERVICE_CONFIG.auth.maxFailures, 5);
    // ④ 调用方传入的 opts 对象也不得被反向共享
    const injected = { auth: { maxFailures: 7 } };
    const c = configMod.loadConfigs({ configDir: dir, service: injected });
    c.service.auth.maxFailures = 8;
    assert.equal(injected.auth.maxFailures, 7, 'opts 入参对象不被反向污染');
    // ⑤ 语义保持：仍是**浅冻结**默认值（本次只切断共享引用，刻意不引入深冻结）
    assert.equal(Object.isFrozen(configMod.DEFAULT_SERVICE_CONFIG), true);
    assert.equal(Object.isFrozen(configMod.DEFAULT_SERVICE_CONFIG.auth), false, '不引入深冻结（避免合法覆盖变硬报错）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

test('CFG-9 数据表 = 代码默认值 = schema 冻结值（三源一致，防双源漂移）；元数据键不进入运行期配置', () => {
  const dataDir = configMod.defaultConfigDir();
  const serviceFile = JSON.parse(fs.readFileSync(path.join(dataDir, configMod.SERVICE_CONFIG_FILE), 'utf8'));
  const ratingFile = JSON.parse(fs.readFileSync(path.join(dataDir, configMod.RATING_CONFIG_FILE), 'utf8'));
  // ① 表载荷 = 代码默认值（config.js）
  assert.deepEqual(configMod.stripMeta(serviceFile), configMod.DEFAULT_SERVICE_CONFIG,
    'service-config.json 载荷必须与 DEFAULT_SERVICE_CONFIG 逐值一致（改一处必须改两处）');
  assert.deepEqual(configMod.stripMeta(ratingFile), configMod.DEFAULT_RATING_CONFIG,
    'rating-config.json 载荷必须与 DEFAULT_RATING_CONFIG 逐值一致');
  // ② 元数据键（_note/_sample）存在且不进入运行期配置
  for (const [name, body] of [['service-config', serviceFile], ['rating-config', ratingFile]]) {
    assert.equal(body._sample, false, `${name} 应显式标注 _sample=false（非示例内容）`);
    assert.ok(typeof body._note === 'string' && body._note.length > 20, `${name} 应有 _note 说明数值出处`);
    assert.ok(body._note.includes('D-'), `${name}._note 应引用决策编号（可追溯）`);
  }
  const loaded = configMod.loadConfigs({});
  assert.deepEqual(loaded.sources.slice().sort(), [configMod.RATING_CONFIG_FILE, configMod.SERVICE_CONFIG_FILE].sort(),
    '真实仓库：两张表都存在 → 都是来源');
  for (const cfg of [loaded.service, loaded.rating]) {
    for (const key of Object.keys(cfg)) assert.equal(key.startsWith('_'), false, `元数据键 ${key} 泄漏进运行期配置`);
  }
  // ③ 表 = schema.js 冻结值（门禁项 4 的同一判据，这里在存储层侧再断言一次）
  const schema = require('../../server/data/schema.js');
  const res = schema.validateStructure(dataDir);
  assert.equal(res.ok, true, `真实数据表结构/冻结值必须通过：${res.detail}`);
  // ④ 表是数值来源：覆盖仍由文件 > 内置 > opts 解析（显式 opts 最终胜出）
  const overridden = configMod.loadConfigs({ service: { config: { maxSlots: 2 } }, rating: { cap: 2500 } });
  assert.equal(overridden.service.config.maxSlots, 2);
  assert.equal(overridden.rating.cap, 2500);
  assert.equal(overridden.service.record.recentLimit, serviceFile.record.recentLimit, '未覆盖键来自表');
});

test('CFG-10 数据表校验能抓漂移（负例：篡改数值 / 未登记键 / 缺表）', () => {
  const root = mkTmp();
  const assetsDir = path.join(__dirname, '..', '..', 'assets');
  const dataDir = configMod.defaultConfigDir();
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(dataDir, f), path.join(root, f));
    }
    const schema = require('../../server/data/schema.js');
    assert.equal(schema.validateStructure(root, assetsDir).ok, true, '复制后应通过');
    const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
    const write = (f, o) => fs.writeFileSync(path.join(root, f), JSON.stringify(o, null, 2), 'utf8');
    // ① 篡改积分数值（与 schema 冻结值不符）
    const rc = read(configMod.RATING_CONFIG_FILE);
    rc.cap = 9999;
    write(configMod.RATING_CONFIG_FILE, rc);
    let res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false, '篡改 cap 必须被抓住');
    assert.ok(res.detail.includes('cap'), res.detail);
    // ② 未登记键
    const rc2 = read(configMod.RATING_CONFIG_FILE);
    rc2.cap = 3000;
    rc2.newKnob = 1;
    write(configMod.RATING_CONFIG_FILE, rc2);
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false);
    assert.ok(res.detail.includes('未登记键'), res.detail);
    // ③ 服务参数越界（maxSlots > 3 违反 D-131）
    const sc = read(configMod.SERVICE_CONFIG_FILE);
    sc.config.maxSlots = 5;
    write(configMod.SERVICE_CONFIG_FILE, sc);
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false);
    assert.ok(res.detail.includes('maxSlots'), res.detail);
    // ④ 缺表：service-config 缺失 → 必填（表是数值来源，不得静默回落）
    const sc2 = read(configMod.SERVICE_CONFIG_FILE);
    sc2.config.maxSlots = 3;
    write(configMod.SERVICE_CONFIG_FILE, sc2);
    fs.rmSync(path.join(root, configMod.SERVICE_CONFIG_FILE));
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false);
    assert.ok(res.detail.includes('service-config.json 缺失'), res.detail);
    // ⑤ 跨字段不变量：kMin ≤ kBase ≤ kMax
    fs.copyFileSync(path.join(dataDir, configMod.SERVICE_CONFIG_FILE), path.join(root, configMod.SERVICE_CONFIG_FILE));
    const rc3 = read(configMod.RATING_CONFIG_FILE);
    rc3.cap = 3000;
    delete rc3.newKnob;
    rc3.kBase = 100;
    write(configMod.RATING_CONFIG_FILE, rc3);
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false);
    assert.ok(res.detail.includes('kMin ≤ kBase ≤ kMax'), res.detail);
    // ⑥ 跨字段不变量：promoteWins < batchSize
    const rc4 = read(configMod.RATING_CONFIG_FILE);
    rc4.kBase = 32;
    rc4.promoteWins = 10;
    write(configMod.RATING_CONFIG_FILE, rc4);
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false);
    assert.ok(res.detail.includes('promoteWins < batchSize'), res.detail);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});

// P7-7 遗留项 S-3（2026-09-19 闭环）：`unlock.json` 的 `gating.enabled` 必须是**布尔**。
//   运行期口径是 `enabled !== false`（缺省/非 false → 按启用处理，旧表行为不变，见 core/unlock.js:34、
//   core/items.js:34、ai/ast.js:729、loadout.js），所以写成字符串 `"false"` 会被判成**启用**——
//   一个字符就静默翻转全部门控语义（段位门控/节点门控/掉落池/装配），必须在结构校验处拦住。
test('CFG-11 S-3：unlock.json 的 gating.enabled 非布尔 → validateStructure 必须 FAIL；缺省 gating 不阻塞', () => {
  const root = mkTmp();
  const assetsDir = path.join(__dirname, '..', '..', 'assets');
  const dataDir = configMod.defaultConfigDir();
  const schema = require('../../server/data/schema.js');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));
  const write = (f, o) => fs.writeFileSync(path.join(root, f), JSON.stringify(o, null, 2), 'utf8');
  try {
    for (const f of fs.readdirSync(dataDir)) {
      if (f.endsWith('.json')) fs.copyFileSync(path.join(dataDir, f), path.join(root, f));
    }
    // 基线：真实表（gating.enabled=false 布尔）通过，且运行期口径确实是"关闭门控"
    assert.equal(schema.validateStructure(root, assetsDir).ok, true, '复制后应通过');
    const unlockJson = read('unlock.json');
    assert.equal(typeof unlockJson.gating.enabled, 'boolean', '真实表应为布尔');
    assert.equal(unlockJson.gating.enabled, false, '当前默认 = 门控关闭（用户决策 2026-09-16）');

    // ① 字符串 "false" → FAIL（会被 `!== false` 判为启用 = 静默翻转语义）
    unlockJson.gating.enabled = 'false';
    write('unlock.json', unlockJson);
    let res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false, '字符串 "false" 必须被拦住（否则门控被静默打开）');
    assert.ok(res.detail.includes('gating.enabled 必须是布尔'), res.detail);

    // ② 数字 0 → FAIL（同理：0 !== false）
    unlockJson.gating.enabled = 0;
    write('unlock.json', unlockJson);
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false);
    assert.ok(res.detail.includes('gating.enabled 必须是布尔'), res.detail);

    // ③ gating 本身不是对象 → FAIL
    unlockJson.gating = 'off';
    write('unlock.json', unlockJson);
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, false);
    assert.ok(res.detail.includes('unlock.gating 必须是对象'), res.detail);

    // ④ 布尔 true（回退到旧行为）→ PASS（结构合法；语义由各自模块的 withGating 用例覆盖）
    unlockJson.gating = { enabled: true };
    write('unlock.json', unlockJson);
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, true, `布尔 true 应通过结构校验：${res.detail}`);

    // ⑤ 完全不写 gating 字段（旧表兼容）→ 结构校验不阻塞（运行期按"启用"处理）
    delete unlockJson.gating;
    write('unlock.json', unlockJson);
    res = schema.validateStructure(root, assetsDir);
    assert.equal(res.ok, true, `旧表（无 gating 字段）应继续通过：${res.detail}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
