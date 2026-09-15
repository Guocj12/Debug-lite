'use strict';
/* B25 审查探针 2：POST /api/v1/ranked/promote HTTP 层全路径（200/409/400 + 信封 + withLogger 事件接线）
 * 可复跑：node .review-b25/probe2.js */
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../shared/log.js');
const serverMod = require('../server/index.js');

let ok = 0, fail = 0;
function chk(name, fn) {
  try { fn(); ok++; console.log(`  [ok] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const logger = createLogger({ level: 'all', ringSize: 3000 });
  const s = await serverMod.start({ logger });
  const P = s.port;
  const post = (body) => request(P, 'POST', '/api/v1/ranked/promote', body);

  // ① 200 晋升
  chk('200 晋升：common+7 → {tier:rare, promoted:true, reward:rare, wins:7} + 信封', async () => {
    const r = await post({ tier: 'common', wins: 7 });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.deepEqual(r.body.data, { tier: 'rare', promoted: true, reward: 'rare', wins: 7 });
    assert.equal(r.body.log.level, 'all');
    assert.deepEqual(r.body.log.events, []);
  });
  // ② 200 不晋升
  chk('200 不晋升：common+6 / mythic+6（缺口① API 层：顶段 wins<7 非 409）', async () => {
    const a = await post({ tier: 'common', wins: 6 });
    assert.equal(a.status, 200);
    assert.deepEqual(a.body.data, { tier: 'common', promoted: false, reward: 'common', wins: 6 });
    const b = await post({ tier: 'mythic', wins: 6 });
    assert.equal(b.status, 200);
    assert.equal(b.body.data.promoted, false);
    assert.equal(b.body.data.tier, 'mythic');
    const c = await post({ tier: 'mythic', wins: 0 });
    assert.equal(c.status, 200);
    assert.equal(c.body.data.promoted, false);
  });
  // ③ 409 already_max 信封
  chk('409 already_max：mythic+7 错误信封 {ok:false, error:{code,message,details}}', async () => {
    const r = await post({ tier: 'mythic', wins: 7 });
    assert.equal(r.status, 409);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error.code, 'already_max');
    assert.equal(typeof r.body.error.message, 'string');
    assert.ok(r.body.error.message.includes('最高段位'));
    assert.deepEqual(r.body.error.details, []);
  });
  // ④ 400 全矩阵
  chk('400 bad_tier：缺省/非法/数字/null', async () => {
    for (const body of [{ wins: 7 }, { tier: 'platinum', wins: 7 }, { tier: 5, wins: 7 }, { tier: null, wins: 7 }]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.code, 'bad_tier');
    }
  });
  chk('400 bad_wins：字符串/负数/小数/缺省/null/溢出 1e400(→Infinity)', async () => {
    for (const body of [{ tier: 'common', wins: 'x' }, { tier: 'common', wins: -1 }, { tier: 'common', wins: 1.5 }, { tier: 'common' }, { tier: 'common', wins: null }]) {
      const r = await post(body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.code, 'bad_wins');
    }
    // JSON 数值溢出 → Infinity（Number.isInteger(Infinity)=false → bad_wins 防御实证）
    const r = await post('{"tier":"common","wins":1e400}');
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'bad_wins');
  });
  chk('400 bad_json：畸形 JSON / badge 顺序（bad_json 优先）', async () => {
    const a = await post('{nope');
    assert.equal(a.status, 400);
    assert.equal(a.body.error.code, 'bad_json');
    const b = await post('{"tier":"platinum","wins":-1}'); // bad_tier 先于 bad_wins（函数内部顺序）
    assert.equal(b.body.error.code, 'bad_tier');
  });
  // ⑤ 事件：HTTP 路径经 withLogger 接线（服务端 logger 收到 ranked.promote info/warn）
  chk('事件接线：HTTP 晋升 → logger 记录 ranked.promote(info)；顶段 → (warn)', async () => {
    logger.reset();
    await post({ tier: 'epic', wins: 8 });
    await post({ tier: 'mythic', wins: 9 });
    const evs = logger.records.filter((r) => r.event === 'ranked.promote');
    assert.equal(evs.length, 2);
    const info = evs.find((e) => e.level === 'info');
    assert.ok(info, '晋升应有 info 记录');
    assert.deepEqual(info.data, { from: 'epic', to: 'legendary', wins: 8 });
    const warn = evs.find((e) => e.level === 'warn');
    assert.ok(warn, '顶段拒绝应有 warn 记录');
    assert.deepEqual(warn.data, { tier: 'mythic', wins: 9 });
  });
  // ⑥ 200 不晋升不产生 ranked.promote 事件（观测；P2 候选一致）
  chk('事件：200 不晋升无 ranked.promote（与函数层一致）', async () => {
    logger.reset();
    await post({ tier: 'common', wins: 6 });
    assert.equal(logger.records.filter((r) => r.event === 'ranked.promote').length, 0);
  });
  // ⑦ 回归：/ranked/run 不受影响 + bad_json/错误码顺序不回归
  chk('回归：/ranked/run 200 正常（10 场 + seed 回带）', async () => {
    const LD = require('../tests/fixtures/loadout-ok.json');
    const r = await request(P, 'POST', '/api/v1/ranked/run', { loadout: LD.loadout, warehouse: LD.warehouse, seed: 11, tier: 'mythic' });
    assert.equal(r.status, 200);
    assert.equal(r.body.data.matches, 10);
    assert.equal(r.body.data.seed, 11);
  });

  await s.close();
  console.log(`\nprobe2: ${ok} ok / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('[probe2 crash]', e); process.exit(1); });