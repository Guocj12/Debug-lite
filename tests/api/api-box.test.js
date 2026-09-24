'use strict';
// B17 /api/v1/box 端点测试 —— T-AP-1/2/5；契约 docs/interfaces.md §2（信封与错误码）。
// D-162（2026-09-22）**随机性收归服务端**：HTTP 接口**没有 `seed` 入参**（请求体里带 `seed` 被静默忽略，
//   不报 bad_seed、不 400）；seed 一律服务端生成并回带。测试/e2e 的确定性由实例级注入缝
//   `start({boxSeed})`（第 n 次开箱 = 注入基值 + n − 1，回绕前逐次 +1）提供，见 docs/interfaces.md §7。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const h = { ...(headers || {}) };
    if (body !== undefined && h['content-type'] === undefined) h['content-type'] = 'application/json';
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// `options.boxSeed` → D-162 注入缝（`start({boxSeed})` 提供确定性 seed 序列）
async function withServer(t, fn, options) {
  const logger = createLogger({ level: 'debug', ringSize: 2000 });
  const o = options || {};
  const s = await serverMod.start({ logger, boxSeed: o.boxSeed });
  try {
    await fn({ port: s.port, logger, server: s });
  } finally {
    await s.close();
  }
}

function contentOf(item) {
  return { kind: item.kind, templateId: item.templateId, quality: item.quality };
}

test('T-AP-1 /api/v1/box 正常路径：信封 + 物品 + seed 服务端回带（客户端 seed 被忽略）+ api.* 日志', async () => {
  const BOX_SEED = 20260913; // D-162 注入基值
  await withServer(null, async ({ port, logger }) => {
    // D-162：HTTP 层不设 seed 入参 —— 传了被忽略（旧断言 `data.seed === 20260913` 已随契约废除）。
    //   这里刻意用与注入基值无关的客户端 seed（1），才能证明"回带的 seed 不是客户端给的那个"。
    const r = await request(port, 'POST', '/api/v1/box', { seed: 1, tier: 'rare', times: 5 });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.notEqual(r.body.data.seed, 1, '客户端 seed 被静默忽略（D-162：接口没有 seed 字段）');
    assert.ok(Number.isInteger(r.body.data.seed) && r.body.data.seed >= 1 && r.body.data.seed <= 0x7fffffff,
      `seed 一律服务端生成且合法: ${r.body.data.seed}`);
    // 服务端权威的更强证据：同一实例内 seed 取自确定性序列（回绕前逐次 +1）
    const rNext = await request(port, 'POST', '/api/v1/box', { tier: 'rare', times: 1 });
    assert.equal(rNext.status, 200, rNext.raw);
    assert.equal(rNext.body.data.seed, r.body.data.seed + 1, '第 n 次开箱 seed = 注入基值 + n（回绕前逐次 +1）');
    assert.equal(r.body.data.tier, 'rare');
    assert.equal(r.body.data.times, 5);
    assert.equal(r.body.data.items.length, 5);
    for (const it of r.body.data.items) {
      assert.equal(typeof it.uid, 'string');
      // 门控关闭（默认，用户决策 2026-09-16）：tier 只作回带信息，品质取自全池 dropRates
      assert.ok(['common', 'rare', 'epic', 'legendary', 'mythic'].includes(it.quality), `品质合法: ${it.quality}`);
    }
    assert.ok(logger.records.some((x) => x.event === 'api.req' && x.data.path === '/api/v1/box'));
    assert.ok(logger.records.some((x) => x.event === 'api.res' && x.data.path === '/api/v1/box'));
    assert.ok(logger.records.some((x) => x.event === 'items.generate'), 'items.generate 经服务端 logger');
  }, { boxSeed: BOX_SEED });
});

test('T-AP-5 /api/v1/box seed 服务端独占（D-162）：客户端 seed 静默忽略 + start({boxSeed}) 注入确定性序列（跨实例内容级复现）', async () => {
  const BOX_SEED = 616161;
  const logger = createLogger({ level: 'silent', ringSize: 100 });
  // 两个独立实例、同一注入基值 → 序列起点相同 → 内容级逐项一致（D-162 为测试/e2e 提供的复现能力）
  const A = await serverMod.start({ logger, boxSeed: BOX_SEED });
  const B = await serverMod.start({ logger, boxSeed: BOX_SEED });
  try {
    const a1 = await request(A.port, 'POST', '/api/v1/box', { seed: 7, tier: 'epic', times: 6 });
    assert.equal(a1.status, 200, a1.raw);
    // D-162：第 n 次开箱 = `boxSeed + n − 1`（字面契约）→ 首箱 seed = 注入基值本身
    assert.equal(a1.body.data.seed, BOX_SEED, '首箱 seed = boxSeed + 0（注入序列第 1 次）');
    // 客户端 seed=7 被忽略：第二次仍按服务端序列前进，而不是复用 7
    const a2 = await request(A.port, 'POST', '/api/v1/box', { seed: 7, tier: 'epic', times: 6 });
    assert.equal(a2.status, 200, a2.raw);
    assert.notEqual(a2.body.data.seed, 7, '客户端 seed 被静默忽略');
    assert.equal(a2.body.data.seed, a1.body.data.seed + 1, '同实例第二次 = 第一次 + 1（服务端序列独占）');
    const b1 = await request(B.port, 'POST', '/api/v1/box', { seed: 7, tier: 'epic', times: 6 });
    assert.equal(b1.status, 200, b1.raw);
    assert.equal(b1.body.data.seed, a1.body.data.seed, '同 boxSeed 的两实例首箱 seed 相同');
    assert.equal(b1.body.data.seed, BOX_SEED, '首箱 seed = boxSeed（`boxSeed + n − 1`，n=1）');
    assert.deepEqual(
      b1.body.data.items.map(contentOf),
      a1.body.data.items.map(contentOf),
      '同 boxSeed → 内容级复现（uid 为进程级自增，不在复现断言范围）',
    );
  } finally {
    await A.close();
    await B.close();
  }
});

test('T-AP-2 /api/v1/box 参数错误：bad_json/bad_tier/bad_times → 400 + code（seed 已非参数，D-162）', async () => {
  await withServer(null, async ({ port }) => {
    const badJson = await request(port, 'POST', '/api/v1/box', '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    const badTier = await request(port, 'POST', '/api/v1/box', { tier: 'diamond' });
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');
    const badTimes = await request(port, 'POST', '/api/v1/box', { times: 0 });
    assert.equal(badTimes.status, 400);
    assert.equal(badTimes.body.error.code, 'bad_times');
    // D-162：`seed` **不是接口入参** → 非法类型/非法数值都不再 400 bad_seed，而是被静默忽略后正常开箱。
    //   （旧契约的 `bad_seed` 只保留在**进程内** `openBoxes({seed})` 上，见 tests/unit/box.test.js B17-4。）
    const badSeedType = await request(port, 'POST', '/api/v1/box', { seed: 'x' });
    assert.equal(badSeedType.status, 200, 'seed 非数值不再 400（D-162：接口没有 seed 字段）');
    assert.equal(badSeedType.body.ok, true);
    assert.equal(badSeedType.body.data.times, 1, 'times 缺省仍为 1');
    assert.ok(Number.isInteger(badSeedType.body.data.seed) && badSeedType.body.data.seed >= 1,
      `seed 一律服务端生成: ${badSeedType.body.data.seed}`);
    const badSeedRange = await request(port, 'POST', '/api/v1/box', { seed: 0 });
    assert.equal(badSeedRange.status, 200, 'seed 越界值同样被忽略（不再 bad_seed）');
    assert.ok(Number.isInteger(badSeedRange.body.data.seed) && badSeedRange.body.data.seed >= 1);
  });
});

test('T-AP-6（D-159/D-162）POST /me/box 服务端权威：需 Bearer；seed 非入参；物品入档 + 回带 counts/caps/grantId', async () => {
  const os = require('node:os');
  const fs = require('node:fs');
  const path = require('node:path');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-ap-box-'));
  const logger = createLogger({ level: 'silent', ringSize: 500 });
  const s = await serverMod.start({
    logger, dataDir, boxSeed: 4242,
    authConfig: { auth: { scrypt: { N: 1024, r: 8, p: 1 } }, rateLimitPerMinute: 1000 },
  });
  try {
    // D-159：服务端权威开箱必须鉴权
    const anon = await request(s.port, 'POST', '/api/v1/me/box', { times: 1 });
    assert.equal(anon.status, 401, anon.raw);
    assert.equal(anon.body.error.code, 'unauthorized');
    const reg = await request(s.port, 'POST', '/api/v1/auth/register', { username: 'apbox1', password: 'pw12345678' });
    assert.equal(reg.status, 200, reg.raw);
    const token = reg.body.data.token;
    const before = await request(s.port, 'GET', '/api/v1/me/warehouse', undefined, { authorization: `Bearer ${token}` });
    assert.equal(before.status, 200, before.raw);
    const beforeTotal = Object.values(before.body.data.counts).reduce((a, b) => a + b, 0);

    // D-162：`seed` 不是入参（传了被忽略）；seed 一律服务端生成
    const r = await request(s.port, 'POST', '/api/v1/me/box', { seed: 1, tier: 'common', times: 3 },
      { authorization: `Bearer ${token}` });
    assert.equal(r.status, 200, r.raw);
    assert.notEqual(r.body.data.seed, 1, '客户端 seed 被忽略');
    assert.equal(r.body.data.times, 3);
    assert.equal(r.body.data.items.length, 3);
    assert.match(r.body.data.grantId, /^bx_/, '服务端权威开箱回带 grantId（幂等批次标识）');
    assert.ok(r.body.data.caps && Number.isInteger(r.body.data.caps.role), '回带 caps（每桶上限）');
    assert.ok(r.body.data.counts && Number.isInteger(r.body.data.counts.role), '回带 counts（落库后各桶数量）');

    // D-159：物品真的写进**服务端仓库**（不再是遗留 /box 的"无状态"语义）
    const after = await request(s.port, 'GET', '/api/v1/me/warehouse', undefined, { authorization: `Bearer ${token}` });
    assert.equal(after.status, 200, after.raw);
    const afterTotal = Object.values(after.body.data.counts).reduce((a, b) => a + b, 0);
    assert.equal(afterTotal, beforeTotal + 3, `3 件物品必须入档（${beforeTotal} → ${afterTotal}）`);
    assert.deepEqual(after.body.data.counts, r.body.data.counts, 'GET /me/warehouse 的 counts 与开箱回带一致');
    // 遗留无状态路径 `/box` 不入档（对照：同一 token 再走遗留端点，仓库数量不变）
    const legacy = await request(s.port, 'POST', '/api/v1/box', { tier: 'common', times: 2 });
    assert.equal(legacy.status, 200, legacy.raw);
    const after2 = await request(s.port, 'GET', '/api/v1/me/warehouse', undefined, { authorization: `Bearer ${token}` });
    assert.equal(
      Object.values(after2.body.data.counts).reduce((a, b) => a + b, 0),
      afterTotal,
      '遗留 /box 不入档（D-159：服务端权威路径只有 /me/box）',
    );
  } finally {
    await s.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
});
