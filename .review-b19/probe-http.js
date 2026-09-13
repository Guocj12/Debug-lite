'use strict';
/* .review-b19/probe-http.js —— B19 HTTP 层探针（真实 socket loopback，T-AP-*）
 * 目标：① skills 畸形 + warehouse → 500 or 409?；② 双引用 → 200 接受?；③ 无 warehouse 面板 → 200 base stats;
 *       ④ tier='diamond' → 409 消息；⑤ GET 骨架；⑥ 400 边界；⑦ 200 回带深度相等。
 */
const http = require('node:http');
const { createLogger } = require('../shared/log.js');
const serverMod = require('../server/index.js');
const FIXTURE = require('../tests/fixtures/loadout-ok.json');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body !== undefined ? { 'content-type': 'application/json' } : {} }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (e) {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const s = await serverMod.start({ logger: createLogger({ level: 'info', ringSize: 1000 }) });
  const port = s.port;
  const fx = () => JSON.parse(JSON.stringify(FIXTURE));

  // 骨架
  const sk = await request(port, 'GET', '/api/v1/loadout');
  console.log(`[1] GET /loadout → ${sk.status} skeleton=${JSON.stringify(sk.body && sk.body.data && sk.body.data.loadout)}`);

  // ① skills 畸形 → 500 or 409?
  const fBad = fx(); fBad.loadout.skills = 'zzz';
  const r1 = await request(port, 'POST', '/api/v1/loadout', { loadout: fBad.loadout, warehouse: fBad.warehouse });
  console.log(`[2] POST /loadout skills='zzz'+warehouse → ${r1.status} code=${r1.body && r1.body.error && r1.body.error.code}（P1 候选：应 409 loadout_invalid）`);
  const fBad2 = fx(); delete fBad2.loadout.skills;
  const r1b = await request(port, 'POST', '/api/v1/panel', { loadout: fBad2.loadout, warehouse: fBad2.warehouse });
  console.log(`[3] POST /panel 无 skills + warehouse → ${r1b.status} code=${r1b.body && r1b.body.error && r1b.body.error.code}`);

  // ② 双引用 → 200 接受？
  const fDup = fx(); fDup.loadout.role.slots[1].pluginUid = 'pa'; fDup.warehouse.buckets.role[0].slots[1].pluginUid = 'pa';
  const r2 = await request(port, 'POST', '/api/v1/loadout', { loadout: fDup.loadout, warehouse: fDup.warehouse });
  console.log(`[4] POST /loadout 双引用同插件 → ${r2.status}（T-PB-8 候选：应 409）`);
  const r2p = await request(port, 'POST', '/api/v1/panel', { loadout: fDup.loadout, warehouse: fDup.warehouse });
  console.log(`[5] POST /panel 双引用 → ${r2p.status} atk=${r2p.body && r2p.body.data && r2p.body.data.panel.role.stats.atk}（正确应 22，双计得 24）`);

  // ③ 无 warehouse 面板
  const r3 = await request(port, 'POST', '/api/v1/panel', { loadout: FIXTURE.loadout });
  console.log(`[6] POST /panel 无 warehouse → ${r3.status} atk=${r3.body && r3.body.data && r3.body.data.panel.role.stats.atk}（应 22；现 20 = 非最终值）`);

  // ④ tier 非法
  const r4 = await request(port, 'POST', '/api/v1/loadout', { loadout: FIXTURE.loadout, warehouse: FIXTURE.warehouse, tier: 'diamond' });
  console.log(`[7] POST /loadout tier='diamond' → ${r4.status} details=${JSON.stringify(r4.body && r4.body.error && r4.body.error.details)}`);

  // ⑤ 合法回带 + 深度相等
  const r5 = await request(port, 'POST', '/api/v1/loadout', { loadout: FIXTURE.loadout, warehouse: FIXTURE.warehouse, tier: 'mythic' });
  const echoEq = JSON.stringify(r5.body && r5.body.data && r5.body.data.loadout) === JSON.stringify(FIXTURE.loadout);
  console.log(`[8] POST /loadout 合法 → ${r5.status} 回带深度相等=${echoEq}`);

  // ⑥ 400 边界
  const r6a = await request(port, 'POST', '/api/v1/loadout', {});
  const r6b = await request(port, 'POST', '/api/v1/panel', { loadout: 42 });
  const r6c = await request(port, 'POST', '/api/v1/loadout', '{nope');
  console.log(`[9] 400 边界：{}→${r6a.status}/${(r6a.body||{}).error&&r6a.body.error.code}；loadout:42→${r6b.status}/${(r6b.body||{}).error&&r6b.body.error.code}；坏 JSON→${r6c.status}/${(r6c.body||{}).error&&r6c.body.error.code}`);

  await s.close();
  process.exit(0);
})().catch((e) => { console.error('PROBE ERR', e); process.exit(1); });