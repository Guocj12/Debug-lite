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
    // ① 真实 env（无注入）
    await withEnv({ DL_DATA_DIR: t1 }, async () => {
      const s = await serverMod.start({ logger: nullLogger, port: 0 });
      try { assert.equal(s.store.dataDir, path.resolve(t1)); } finally { await s.close(); }
    });
    // ② 仅注入 env（process.env 不设）→ 修前落到 <repo>/runtime
    await withEnv({ DL_DATA_DIR: undefined }, async () => {
      const s = await serverMod.start({ logger: nullLogger, port: 0, env: { DL_DATA_DIR: t2 } });
      try {
        assert.equal(s.store.dataDir, path.resolve(t2), '注入 env 必须决定落盘位置（修前 = <repo>/runtime）');
      } finally { await s.close(); }
    });
    // ③ 注入优先于真实 env（同名键）
    await withEnv({ DL_DATA_DIR: t1 }, async () => {
      const s = await serverMod.start({ logger: nullLogger, port: 0, env: { DL_DATA_DIR: t2 } });
      try { assert.equal(s.store.dataDir, path.resolve(t2), '注入是覆盖层'); } finally { await s.close(); }
    });
    // ④ store 工厂直连：createStore({env})
    const direct = storeMod.createStore({ env: { DL_DATA_DIR: t2 }, versions: { engine: '3.0.0' }, logger: nullLogger });
    assert.equal(direct.dataDir, path.resolve(t2), 'createStore 也必须接受 env 注入（修前 = <repo>/runtime）');
    // ⑤ 解析函数本身
    assert.equal(storeMod.resolveDataDir(undefined, { DL_DATA_DIR: t2 }), path.resolve(t2));
    assert.deepEqual(storeMod.envOf({ A: 1 }).A, 1);
    assert.equal(storeMod.envOf({}) === process.env, false, '空对象 = 覆盖层（不是 process.env 本体）');
  } finally { clean([t1, t2]); }
});

test('ENV-2 空 env 对象不得整体屏蔽 process.env（修前 store=null / legacyStateless=true / CORS 空）', async () => {
  const t3 = tmp('dl-e2-');
  try {
    await withEnv({ DL_DATA_DIR: t3, DL_LEGACY_STATELESS: '0', DL_CORS_ORIGIN: 'https://probe.example' }, async () => {
      const s = await serverMod.start({ logger: nullLogger, port: 0, env: {} });
      try {
        assert.equal(s.store.dataDir, path.resolve(t3), '空 env → DL_DATA_DIR 回退 process.env（修前 store=null）');
        assert.equal(s.runtime.legacyStateless, false, '空 env → DL_LEGACY_STATELESS 回退（修前恒 true）');
        assert.equal(s.runtime.corsOrigin, 'https://probe.example', '空 env → DL_CORS_ORIGIN 回退（修前恒空）');
      } finally { await s.close(); }
    });
  } finally { clean([t3]); }
});

test('ENV-3 enableStore:false = 显式否决（即使 env 有 DL_DATA_DIR 也不落盘）；缺省 start() 仍不落盘', async () => {
  const t4 = tmp('dl-e3-');
  try {
    await withEnv({ DL_DATA_DIR: t4 }, async () => {
      const s = await serverMod.start({ logger: nullLogger, port: 0, enableStore: false, dataDir: undefined, env: {} });
      try {
        assert.equal(s.store, null, '显式否决优先');
        assert.equal(fs.existsSync(path.join(t4, 'index.json')), false, '不得在注入目录留下运行时档案');
      } finally { await s.close(); }
    });
    await withEnv({ DL_DATA_DIR: undefined }, async () => {
      const s = await serverMod.start({ logger: nullLogger, port: 0 });
      try { assert.equal(s.store, null, 'start() 缺省不落盘（无状态基线）'); } finally { await s.close(); }
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
