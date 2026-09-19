'use strict';
/* 临时诊断脚本（跑完即删）：开箱桶分布 + 装配计划 + loadout 校验细则 */
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const serverMod = require('./server/index.js');
const { createLogger } = require('./shared/log.js');
const L = require('./tests/helpers/load.js');
const loadoutMod = require('./server/loadout.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-dbg-'));
  const s = await serverMod.start({
    logger: createLogger({ level: 'error' }), dataDir: dir, port: 0, rateLimitPerMinute: 2000,
    authConfig: { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 5000 } },
  });
  const metrics = L.createMetrics();
  const ctx = {
    port: s.port, store: s.store, metrics, rng: new L.SeededRng(11), seed: 11,
    tier: 'common', boxes: 16, slotsMax: 2, warehouseBucketMax: 24,
  };
  const p = await L.registerPlayer(ctx, 1);
  const auth = L.bearer(p.token);
  const box = await L.call(metrics, 'box', s.port, 'POST', '/api/v1/box', { seed: 12345, tier: 'common', times: 16 }, auth);
  const items = box.body.data.items;
  const counts = {};
  for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
  console.log('box kinds', JSON.stringify(counts));
  const wh = require('./server/core/items.js').emptyWarehouse();
  for (const it of items) { if (!Array.isArray(wh.buckets[it.kind])) wh.buckets[it.kind] = []; wh.buckets[it.kind].push(it); }
  const planned = L.planLoadout(wh, { slotsMax: 2 });
  console.log('plan', planned.loadout ? 'ok' : planned.error, JSON.stringify(planned.stats), 'ops=', planned.plan.length);
  if (planned.loadout) {
    const mirror = L.mirrorOfLoadout(planned.loadout, wh, 24);
    const ld = planned.loadout;
    ld.ai = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
    const v = loadoutMod.validateLoadout(ld, { warehouse: mirror, tier: 'common' });
    console.log('validate mirror =', v.ok, JSON.stringify(v.errors).slice(0, 500));
    const v2 = loadoutMod.validateLoadout(ld, { warehouse: null, tier: 'common' });
    console.log('validate nowh  =', v2.ok, JSON.stringify(v2.errors).slice(0, 300));
    const res = await L.setupPlayer(ctx, { ...p, index: 1 });
    console.log('setup ok=', res.ok, res.code, JSON.stringify(res.detail.rejects), 'equipped', res.detail.equipped);
  }
  await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
