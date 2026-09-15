'use strict';
/* B24 审查探针 3：错误码顺序 semantics（函数层 + API 层）
 * 可复跑：node .review-b24/probe3.js
 */
const assert = require('node:assert/strict');
const ranked = require('../server/ranked.js');
const serverMod = require('../server/index.js');
const { createLogger } = require('../shared/log.js');
const http = require('node:http');
const LD = require('../tests/fixtures/loadout-ok.json');
const ld = () => JSON.parse(JSON.stringify(LD.loadout));
const wh = () => JSON.parse(JSON.stringify(LD.warehouse));

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(data) }); } catch (e) { resolve({ status: res.statusCode, body: null, raw: data }); } });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

let ok = 0, fail = 0;
function chk(name, fn) {
  try { fn(); ok++; console.log(`  [ok] ${name}`); }
  catch (e) { fail++; console.log(`  [FAIL] ${name}: ${e.message}`); }
}

// 函数层顺序：no_loadout → validateLoadout → seed（无 loadout + 坏 seed → no_loadout 优先）
chk('函数层：无 loadout + 坏 seed → 409 no_loadout（no_loadout 优先于 bad_seed）', () => {
  const r = ranked.runRankedBattle({ seed: 'x', tier: 'mythic' });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'no_loadout');
});
chk('函数层：loadout 非法 + 坏 seed → 409 loadout_invalid（validate 先于 seed）', () => {
  const bad = ld(); bad.skills = bad.skills.slice(0, 2);
  const r = ranked.runRankedBattle({ loadout: bad, seed: 'x', tier: 'mythic' });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'loadout_invalid');
});
chk('函数层：loadout 合法 + 坏 seed → 400 bad_seed', () => {
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), seed: 'x', tier: 'mythic' });
  assert.equal(r.status, 400);
  assert.equal(r.code, 'bad_seed');
});
chk('函数层：seed 边界 1 / 0x7fffffff 合法；0 与 0x80000000 拒绝', () => {
  for (const s of [1, 0x7fffffff]) assert.equal(ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), seed: s, tier: 'mythic' }).status, 200);
  for (const s of [0, 0x80000000, 1.5, NaN]) {
    const r = ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), seed: s, tier: 'mythic' });
    assert.equal(r.status, 400);
    assert.equal(r.code, 'bad_seed');
  }
});
chk('函数层：seed 缺省生成（1..0x7fffffff 内，不抛）', () => {
  const r = ranked.runRankedBattle({ loadout: ld(), warehouse: wh(), tier: 'mythic' });
  assert.equal(r.status, 200);
  assert.ok(r.data.seed >= 1 && r.data.seed <= 0x7fffffff);
});

(async () => {
  // API 层
  const s = await serverMod.start({ logger: createLogger({ level: 'silent' }) });
  try {
    const port = s.port;
    chk('API：POST {} → 409 no_loadout', async () => {
      const r = await request(port, 'POST', '/api/v1/ranked/run', {});
      assert.equal(r.status, 409); assert.equal(r.body.error.code, 'no_loadout');
    });
    chk('API：无 loadout + seed x → 409 no_loadout（嵌套顺序）', async () => {
      const r = await request(port, 'POST', '/api/v1/ranked/run', { seed: 'x' });
      assert.equal(r.status, 409); assert.equal(r.body.error.code, 'no_loadout');
    });
    chk('API：无 loadout + 坏 tier → 400 bad_tier（tier 检查在 index 层，先于 no_loadout）', async () => {
      const r = await request(port, 'POST', '/api/v1/ranked/run', { tier: 'platinum' });
      assert.equal(r.status, 400); assert.equal(r.body.error.code, 'bad_tier');
    });
    chk('API：坏 JSON → 400 bad_json', async () => {
      const r = await request(port, 'POST', '/api/v1/ranked/run', '{nope');
      assert.equal(r.status, 400); assert.equal(r.body.error.code, 'bad_json');
    });
    chk('API：pool 非数组 → 静默视空池（200 全 bot 场——P2 登记候选）', async () => {
      const r = await request(port, 'POST', '/api/v1/ranked/run', { loadout: ld(), warehouse: wh(), seed: 1, pool: { a: 1 }, tier: 'mythic' });
      assert.equal(r.status, 200);
      console.log('    现象: pool 对象被当作空池（matches=10, results.length=' + r.body.data.results.length + ')');
    });
    chk('API：envelope 形状（ok/data/log；失败 error{code,message,details}）', async () => {
      const r = await request(port, 'POST', '/api/v1/ranked/run', { loadout: ld(), warehouse: wh(), seed: 3, tier: 'common' });
      assert.equal(r.body.ok, true);
      assert.ok(r.body.data && r.body.log && Array.isArray(r.body.log.events));
      const bad = await request(port, 'POST', '/api/v1/ranked/run', { loadout: ld(), seed: 1, tier: 'common' });
      // 注意：LD warehouse 含装配引用? 若含 → 409 loadout_invalid
      console.log('    注: 无 warehouse + 引用含插件时 →', bad.status, bad.body && bad.body.error && bad.body.error.code);
    });
  } finally {
    await s.close();
  }
  console.log(`\nprobe3: ${ok} ok / ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();