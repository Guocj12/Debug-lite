'use strict';
/* B18 对抗性红队 HTTP 探针（真实 socket）—— node .review-b18/probe-http.js
 * ① GET /warehouse 骨架；200 信封
 * ② assemble 正常路径 200 回带；409 item_missing / plugin_equipped / points_exceeded / tier_locked / slot_type_mismatch
 * ③ 插件作目标 → 观察（预期：应 409 slot_type_mismatch；若 500 = P1 实证）
 * ④ buckets 结构畸形（字符串桶）→ 观察（预期：防御语义；若 500 = 实证）
 * ⑤ disassemble 404 slot_empty / plugin_missing / 目标缺失 plugin_missing
 * ⑥ bad_json / bad_request 400
 * ⑦ 日志事件级别：items.assemble / items.disassemble 实际级别；api.req/res 存在
 */
const http = require('node:http');
const { createLogger } = require('../shared/log.js');
const serverMod = require('../server/index.js');
const WH = require('../tests/fixtures/wh-ok.json');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const logger = createLogger({ level: 'trace', ringSize: 5000 });
  const s = await serverMod.start({ logger });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    // ① 骨架
    const sk = await request(s.port, 'GET', '/api/v1/warehouse');
    console.log(`① GET /warehouse → ${sk.status} buckets=${JSON.stringify(Object.keys(sk.body.data.buckets))}`);
    // ② 正常 + 409 各码
    const ok = await request(s.port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
    console.log(`② 正常装配 → ${ok.status} slot=${ok.body.data.warehouse.buckets.role[0].slots[0].pluginUid} equipped=${ok.body.data.warehouse.buckets.rolePlugin[0].equipped}`);
    const miss = await request(s.port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'ghost', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
    console.log(`   目标缺失 → ${miss.status} ${miss.body.error.code}`);
    const miss2 = await request(s.port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0, pluginUid: 'ghost2', tier: 'common' });
    console.log(`   插件缺失 → ${miss2.status} ${miss2.body.error.code}`);
    // ③ 插件作目标（P1 路径）
    const ptarget = await request(s.port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'p1', slotIndex: 0, pluginUid: 'p2', tier: 'common' });
    console.log(`③ 插件作目标 → ${ptarget.status} ${JSON.stringify(ptarget.body.error || 'no error obj')}`);
    const ptargetD = await request(s.port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: WH, targetUid: 'p1', slotIndex: 0 });
    console.log(`   插件作目标（拆卸）→ ${ptargetD.status} ${JSON.stringify(ptargetD.body.error || 'no error obj')}`);
    // ④ buckets 畸形
    const badBuckets = await request(s.port, 'POST', '/api/v1/warehouse/assemble', { warehouse: { buckets: 'abc' }, targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
    console.log(`④ buckets='abc' → ${badBuckets.status} ${JSON.stringify(badBuckets.body.error || 'no error obj')}`);
    // ⑤ 拆卸 404
    const se = await request(s.port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0 });
    console.log(`⑤ 空槽拆卸 → ${se.status} ${se.body.error.code}`);
    const ghostWh = JSON.parse(JSON.stringify(WH));
    ghostWh.buckets.role[0].slots[0].pluginUid = 'ghostx';
    const pm = await request(s.port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: ghostWh, targetUid: 'r1', slotIndex: 0 });
    console.log(`   悬挂引用 → ${pm.status} ${pm.body.error.code}`);
    const pm2 = await request(s.port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: WH, targetUid: 'ghostT', slotIndex: 0 });
    console.log(`   目标缺失 → ${pm2.status} ${pm2.body.error.code}`);
    // ⑥ 400
    const bj = await request(s.port, 'POST', '/api/v1/warehouse/assemble', '{oops');
    console.log(`⑥ bad_json → ${bj.status} ${bj.body.error.code}`);
    const br = await request(s.port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1' });
    console.log(`   bad_request → ${br.status} ${br.body.error.code}`);
    const br2 = await request(s.port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1', pluginUid: 'p1', slotIndex: 1.5 });
    console.log(`   slotIndex=1.5 → ${br2.status} ${br2.body.error.code}`);
    // ⑦ 日志级别观察
    const recs = logger.records;
    const asm = recs.filter((r) => r.event === 'items.assemble');
    const dis = recs.filter((r) => r.event === 'items.disassemble');
    const apiErr = recs.filter((r) => r.event === 'api.err');
    console.log(`⑦ items.assemble 记录数=${asm.length} 级别=${asm.map((r) => r.level).join(',')}（§6 冻结级别=info）`);
    console.log(`   items.disassemble 记录数=${dis.length} 级别=${dis.map((r) => r.level).join(',')}`);
    console.log(`   api.err 记录数=${apiErr.length}：${apiErr.map((r) => r.data.message).join(' | ').slice(0, 200)}`);
  } finally {
    await s.close();
  }
})();