'use strict';
// B18 /api/v1/warehouse* 端点测试 —— T-AP-1/2/3；契约 docs/interfaces.md §2（B18 行）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const WH = require('../fixtures/wh-ok.json');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
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

async function withServer(t, fn) {
  const logger = createLogger({ level: 'debug', ringSize: 2000 });
  const s = await serverMod.start({ logger });
  try {
    await fn({ port: s.port, logger });
  } finally {
    await s.close();
  }
}

test('T-AP-1 GET /warehouse 骨架 + assemble/disassemble 正常路径（信封 + 回带仓库）', async () => {
  await withServer(null, async ({ port }) => {
    const sk = await request(port, 'GET', '/api/v1/warehouse');
    assert.equal(sk.status, 200);
    assert.equal(sk.body.ok, true);
    assert.deepEqual(Object.keys(sk.body.data.buckets).sort(), ['role', 'rolePlugin', 'skill', 'skillPlugin']);
    const a = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
    assert.equal(a.status, 200, a.raw);
    assert.equal(a.body.data.warehouse.buckets.role[0].slots[0].pluginUid, 'p1');
    assert.equal(a.body.data.warehouse.buckets.rolePlugin[0].equipped, true);
    const d = await request(port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: a.body.data.warehouse, targetUid: 'r1', slotIndex: 0 });
    assert.equal(d.status, 200, d.raw);
    assert.equal(d.body.data.warehouse.buckets.role[0].slots[0].pluginUid, null);
  });
});

test('T-AP-3 装配业务拒绝 → 409 各错误码；拆卸 → 404 slot_empty/plugin_missing', async () => {
  await withServer(null, async ({ port }) => {
    // 类别不匹配
    const typeBad = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0, pluginUid: 'q1', tier: 'common' });
    assert.equal(typeBad.status, 409);
    assert.equal(typeBad.body.error.code, 'slot_type_mismatch');
    // 槽位占用（用同槽型 atk 插件；已装插件再装别处 → plugin_equipped 一并覆盖）
    const w1a = JSON.parse(JSON.stringify(WH));
    w1a.buckets.rolePlugin.push({ uid: 'p5', kind: 'rolePlugin', id: 'atk_up2', slot: 'atk', quality: 'common', tier: 1, pointCost: 1, affixes: [], equipped: false });
    w1a.buckets.role[0].slots.push({ type: 'atk', pluginUid: null }); // 多余 atk 槽（唯一性用例需同槽型空槽）
    const first = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: w1a, targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
    assert.equal(first.status, 200);
    const occ2 = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: first.body.data.warehouse, targetUid: 'r1', slotIndex: 0, pluginUid: 'p5', tier: 'common' });
    assert.equal(occ2.status, 409);
    assert.equal(occ2.body.error.code, 'slot_occupied');
    const re = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: first.body.data.warehouse, targetUid: 'r1', slotIndex: 2, pluginUid: 'p1', tier: 'common' });
    assert.equal(re.body.error.code, 'plugin_equipped', 'T-PB-8 唯一性经 API');
    // 点数超限（p2 为 def 槽插件 → 装配到 def 槽）
    const w2 = JSON.parse(JSON.stringify(WH));
    w2.buckets.role[0].pluginPoints = 1;
    const pts = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: w2, targetUid: 'r1', slotIndex: 1, pluginUid: 'p2', tier: 'common' });
    assert.equal(pts.body.error.code, 'points_exceeded');
    // 段位锁：**门控默认关闭**（用户决策 2026-09-16）→ 同一请求放行（不再 409 tier_locked）；
    //   409 tier_locked 的装配路径由 tests/unit/wh.test.js（withGating(true)）与 b20/b21 覆盖。
    const w3 = JSON.parse(JSON.stringify(WH));
    w3.buckets.rolePlugin.push({ uid: 'p3', kind: 'rolePlugin', id: 'hp_up', slot: 'atk', quality: 'legendary', tier: 5, pointCost: 5, affixes: [], unlockTier: 'legendary', equipped: false });
    w3.buckets.role[0].pluginPoints = 6;
    const tl = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: w3, targetUid: 'r1', slotIndex: 0, pluginUid: 'p3', tier: 'rare' });
    assert.equal(tl.status, 200, `门控关闭：legendary 插件 @ rare 段位放行（${tl.raw}）`);
    assert.equal(tl.body.data.warehouse.buckets.role[0].slots[0].pluginUid, 'p3');
    // 其余 409/404 错误码不受门控开关影响（同请求换成槽型不匹配 → 仍 409）
    const stillBad = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0, pluginUid: 'q1', tier: 'rare' });
    assert.equal(stillBad.status, 409);
    assert.equal(stillBad.body.error.code, 'slot_type_mismatch', '非段位类业务拒绝保持原状');
    // 拆卸：空槽 → 404 slot_empty
    const se = await request(port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0 });
    assert.equal(se.status, 404);
    assert.equal(se.body.error.code, 'slot_empty');
    // 拆卸：悬挂引用 → 404 plugin_missing
    const w4 = JSON.parse(JSON.stringify(WH));
    w4.buckets.role[0].slots[0].pluginUid = 'ghost';
    const pm = await request(port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: w4, targetUid: 'r1', slotIndex: 0 });
    assert.equal(pm.status, 404);
    assert.equal(pm.body.error.code, 'plugin_missing');
  });
});

test('P1-1 回归（HTTP）：插件当目标 → 409 而非 500；装配成功事件经服务端 logger', async () => {
  await withServer(null, async ({ port, logger }) => {
    const bad = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'p1', slotIndex: 0, pluginUid: 'p2', tier: 'common' });
    assert.equal(bad.status, 409, bad.raw);
    assert.equal(bad.body.error.code, 'slot_type_mismatch');
    const badD = await request(port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: WH, targetUid: 'p1', slotIndex: 0 });
    assert.equal(badD.status, 404, badD.raw);
    assert.equal(badD.body.error.code, 'slot_empty');
    const ok = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0, pluginUid: 'p1', tier: 'common' });
    assert.equal(ok.status, 200);
    assert.ok(logger.records.some((x) => x.event === 'items.assemble' && x.level === 'info'), 'HTTP 路径 items.assemble(info) 经服务端 logger');
    const rej = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1', slotIndex: 0, pluginUid: 'q1', tier: 'common' });
    assert.equal(rej.status, 409);
    assert.ok(logger.records.some((x) => x.event === 'items.reject' && x.level === 'warn'), 'HTTP 路径 items.reject(warn)');
  });
});

test('T-AP-2 参数错误：bad_json / bad_request → 400 + code', async () => {
  await withServer(null, async ({ port }) => {
    const badJson = await request(port, 'POST', '/api/v1/warehouse/assemble', '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    const badReq = await request(port, 'POST', '/api/v1/warehouse/assemble', { warehouse: WH, targetUid: 'r1' });
    assert.equal(badReq.status, 400);
    assert.equal(badReq.body.error.code, 'bad_request');
    const badReq2 = await request(port, 'POST', '/api/v1/warehouse/disassemble', { warehouse: WH, slotIndex: 'x' });
    assert.equal(badReq2.status, 400);
    assert.equal(badReq2.body.error.code, 'bad_request');
    const noWh = await request(port, 'POST', '/api/v1/warehouse/assemble', { targetUid: 'r1', pluginUid: 'p1', slotIndex: 0 });
    assert.equal(noWh.body.error.code, 'bad_request');
  });
});