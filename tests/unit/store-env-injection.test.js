'use strict';
/* tests/unit/store-env-injection.test.js —— C5：`DL_DATA_DIR` 注入缝 + 注入 env 的回退语义（+ P2-1/P2-4）
 *
 * 证据（修前实测）：
 *   · `start({env:{DL_DATA_DIR:T}})` → store 落到 `<repo>/runtime`（index.js 用注入 env 决定"是否装配"，
 *     而 store 只读真实 `process.env`）；
 *   · `start({env:{}})` → **整体屏蔽** process.env → store=null、legacyStateless=true、corsOrigin=''（与预期相反）；
 *   · `storeMod.createStore({env:{DL_DATA_DIR:T}})` → 落到 `<repo>/runtime`。
 * 修法：`store/envOf(explicit)` = `{...process.env, ...explicit}`（注入 = 覆盖层；未提供的键回退），
 *   `resolveDataDir/resolveAdapterName/createStore` 全部经由它；`server/index.js` 把已解析的 env 透传给 store。
 * 另：`enableStore:false` = 显式否决（测试用"确定不落盘"口径）；`DL_PORT=0` = 临时端口（P2-1）；
 *   全局限速分层命名 `global.rateLimitPerMinute`（P2-4）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const serverMod = require('../../server/index.js');
const storeMod = require('../../server/store/index.js');
const { nullLogger } = require('../../shared/log.js');

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'dl-env-'));
}
const clean = (dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); };
// Windows 上 process.env 的键名大小写不固定（`Path` vs `PATH`）→ 回退断言用大小写不敏感取值
const envGet = (obj, key) => {
  const hit = Object.keys(obj || {}).find((k) => k.toLowerCase() === key.toLowerCase());
  return hit === undefined ? undefined : obj[hit];
};

async function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k];
  }
  try { return await fn(); } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}

test('ENV-1 注入 env.DL_DATA_DIR 生效（修前落到 <repo>/runtime）；真实 env 亦生效', async () => {
  const t1 = tmp('dl-e1a-'); const t2 = tmp('dl-e1b-');
  try {
    // ① 仅注入 env（process.env 不设）→ 修前落到 <repo>/runtime
    const s = await serverMod.start({ logger: nullLogger, port: 0, env: { DL_DATA_DIR: t2 } });
    try {
      assert.equal(s.store.dataDir, path.resolve(t2), '注入 env 必须决定落盘位置（修前 = <repo>/runtime）');
    } finally { await s.close(); }
    // ② 显式 dataDir 优先于 env（沿用旧口径）
    const s2 = await serverMod.start({ logger: nullLogger, port: 0, dataDir: t1, env: { DL_DATA_DIR: t2 } });
    try { assert.equal(s2.store.dataDir, path.resolve(t1), '显式 dataDir 优先'); } finally { await s2.close(); }
    // ③ store 工厂直连：createStore({env})
    const direct = storeMod.createStore({ env: { DL_DATA_DIR: t2 }, versions: { engine: '3.0.0' }, logger: nullLogger });
    assert.equal(direct.dataDir, path.resolve(t2), 'createStore 也必须接受 env 注入（修前 = <repo>/runtime）');
    // ④ 解析函数（同步窗口；不跨 await 改 process.env，避免 --test-isolation=none 下的跨文件污染）
    assert.equal(storeMod.resolveDataDir(undefined, { DL_DATA_DIR: t2 }), path.resolve(t2));
    assert.deepEqual(storeMod.envOf({ A: 1 }).A, 1);
    assert.equal(storeMod.envOf({}) === process.env, false, '空对象 = 覆盖层（不是 process.env 本体）');
    assert.equal(envGet(storeMod.envOf({}), 'PATH'), process.env.PATH, '未提供的键回退真实 process.env');
    const savedDir = process.env.DL_DATA_DIR;
    try {
      process.env.DL_DATA_DIR = t1;
      assert.equal(storeMod.resolveDataDir(undefined, undefined), path.resolve(t1), '未注入 → 真实 process.env（真实 env 路径）');
      assert.equal(serverMod.storeWanted({}, serverMod.envOf({})), true, '真实 env 命中 → 装配 store');
      assert.equal(serverMod.storeWanted({}, serverMod.envOf({ env: { DL_DATA_DIR: undefined } })), false, 'env 显式给 undefined → 该键无值 → 不装配');
    } finally {
      if (savedDir === undefined) delete process.env.DL_DATA_DIR; else process.env.DL_DATA_DIR = savedDir;
    }
  } finally { clean([t1, t2]); }
});

test('ENV-2 空 env 对象不得整体屏蔽 process.env（语义 = 覆盖层；同步窗口 set→assert→restore）', () => {
  // 说明：本用例**不在 await 之间**改 process.env（`--test-isolation=none` 下同一进程并发跑多个测试文件，
  //   跨 await 的全局变量改写会污染其他用例）。同步窗口内 set→assert→restore 不可能被并发观测到。
  const keys = ['DL_DATA_DIR', 'DL_LEGACY_STATELESS', 'DL_CORS_ORIGIN'];
  const saved = {};
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.env.DL_DATA_DIR = 'probe-dir';
    process.env.DL_LEGACY_STATELESS = '0';
    process.env.DL_CORS_ORIGIN = 'https://probe.example';
    // 未提供的键（如 PATH）恒回退——不需要设置任何变量即可证明"注入 = 覆盖层"
    assert.equal(envGet(serverMod.envOf({}), 'PATH'), process.env.PATH, '空对象 → 回退真实 process.env');
    const env = serverMod.envOf({});
    assert.equal(env.DL_DATA_DIR, 'probe-dir', '空 env → DL_DATA_DIR 回退（修前整体屏蔽 → store 关掉）');
    assert.equal(env.DL_LEGACY_STATELESS, '0', '空 env → DL_LEGACY_STATELESS 回退（修前恒 true）');
    assert.equal(env.DL_CORS_ORIGIN, 'https://probe.example', '空 env → DL_CORS_ORIGIN 回退（修前恒空）');
    assert.equal(serverMod.storeWanted({}, env), true, '回退后确实要装配 store（修前 store=null）');
    assert.equal(storeMod.envOf({}).DL_DATA_DIR, 'probe-dir', 'store 侧同一口径');
    assert.equal(storeMod.resolveDataDir(undefined, {}), path.resolve('probe-dir'), 'store 落盘位置随之回退');
    // 注入键优先于真实 env（注意契约差异：`server/index.js` 的 envOf 吃 **start 选项对象** `{env}`；
    //   `server/store/index.js` 的 envOf 直接吃 **env 字典**）
    assert.equal(serverMod.envOf({ env: { DL_DATA_DIR: 'injected' } }).DL_DATA_DIR, 'injected');
    assert.equal(storeMod.envOf({ DL_DATA_DIR: 'injected' }).DL_DATA_DIR, 'injected');
    assert.equal(storeMod.resolveDataDir(undefined, { DL_DATA_DIR: 'injected' }), path.resolve('injected'));
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('ENV-2b 注入式开关行为（不碰 process.env）：落盘位置 + legacyStateless + CORS 全部按注入值生效', async () => {
  const t2 = tmp('dl-e2b-');
  try {
    const s = await serverMod.start({
      logger: nullLogger, port: 0,
      env: { DL_DATA_DIR: t2, DL_LEGACY_STATELESS: '0', DL_CORS_ORIGIN: 'https://probe.example' },
    });
    try {
      assert.equal(s.store.dataDir, path.resolve(t2), '注入 DL_DATA_DIR 决定落盘位置（修前 = <repo>/runtime）');
      assert.equal(s.runtime.legacyStateless, false, '注入 DL_LEGACY_STATELESS=0 生效');
      assert.equal(s.runtime.corsOrigin, 'https://probe.example', '注入 DL_CORS_ORIGIN 生效');
      assert.equal(envGet(s.runtime.env, 'PATH'), process.env.PATH, '未提供的键仍回退真实 process.env（覆盖层语义）');
    } finally { await s.close(); }
  } finally { clean([t2]); }
});

test('ENV-3 enableStore:false = 显式否决（即使注入 env 有 DL_DATA_DIR 也不落盘）；缺省 start() 仍不落盘', async () => {
  const t4 = tmp('dl-e3-');
  try {
    const s = await serverMod.start({ logger: nullLogger, port: 0, enableStore: false, dataDir: undefined, env: { DL_DATA_DIR: t4 } });
    try {
      assert.equal(s.store, null, '显式否决优先');
      assert.equal(fs.existsSync(path.join(t4, 'index.json')), false, '不得在注入目录留下运行时档案');
    } finally { await s.close(); }
    // 缺省 start()（无 dataDir / 无注入 / 真实 env 干净）→ 无状态基线
    await withEnv({ DL_DATA_DIR: undefined }, async () => {
      const s2 = await serverMod.start({ logger: nullLogger, port: 0 });
      try { assert.equal(s2.store, null, 'start() 缺省不落盘（无状态基线）'); } finally { await s2.close(); }
    });
  } finally { clean([t4]); }
});

test('ENV-4 P2-1：DL_PORT 显式解析 —— 0 = 临时端口（不再被 || 吞成 3000）；非法值 → null', () => {
  assert.equal(serverMod.resolvePort({}), 3000, '未设 → 默认端口');
  assert.equal(serverMod.resolvePort({ DL_PORT: '' }), 3000);
  assert.equal(serverMod.resolvePort({ DL_PORT: '0' }), 0, '0 = 临时端口（修前 3000）');
  assert.equal(serverMod.resolvePort({ DL_PORT: 0 }), 0);
  assert.equal(serverMod.resolvePort({ DL_PORT: '4321' }), 4321);
  assert.equal(serverMod.resolvePort({ DL_PORT: 'abc' }), null, '非法值如实拒绝');
  assert.equal(serverMod.resolvePort({ DL_PORT: '-1' }), null);
  assert.equal(serverMod.resolvePort({ DL_PORT: '70000' }), null);
  assert.equal(serverMod.resolvePort({ DL_PORT: '3.5' }), null);
});

test('ENV-5 P2-4：全局限速分层取值（opts 接缝 > config.global > store.config.global > 默认 600）', async () => {
  const t5 = tmp('dl-e5-');
  try {
    assert.equal(serverMod.globalRateLimitOf({}, null), 600, '默认 600（§4.6）');
    assert.equal(serverMod.globalRateLimitOf({ rateLimitPerMinute: 7 }, null), 7, '测试接缝最高优先');
    assert.equal(serverMod.globalRateLimitOf({ config: { global: { rateLimitPerMinute: 12 } } }, null), 12);
    assert.equal(serverMod.globalRateLimitOf({}, { global: { rateLimitPerMinute: 34 } }), 34, '表内值（store.config.global）');
    await withEnv({ DL_DATA_DIR: undefined }, async () => {
      const s = await serverMod.start({
        logger: nullLogger, port: 0, dataDir: t5,
        config: { global: { rateLimitPerMinute: 21 } },
      });
      try {
        assert.equal(s.runtime.rateLimiter.limit, 21, '装配后限速器按分层取值重建');
      } finally { await s.close(); }
    });
  } finally { clean([t5]); }
});
