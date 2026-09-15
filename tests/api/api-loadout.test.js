'use strict';
// B19 /api/v1/loadout + /api/v1/panel 端点测试 —— T-AP-1/2/3；契约 docs/interfaces.md §2。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const LOADOUT = require('../fixtures/loadout-ok.json');

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

test('T-AP-1 GET /loadout 骨架 + POST /loadout 校验回带 + POST /panel 数值', async () => {
  await withServer(null, async ({ port }) => {
    const sk = await request(port, 'GET', '/api/v1/loadout');
    assert.equal(sk.status, 200);
    assert.deepEqual(sk.body.data.loadout, { role: null, skills: [null, null, null], ai: null });
    const ok = await request(port, 'POST', '/api/v1/loadout', { loadout: LOADOUT.loadout, warehouse: LOADOUT.warehouse, tier: 'mythic' });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.data.loadout.role.uid, 'r1', '回带 loadout');
    const pnl = await request(port, 'POST', '/api/v1/panel', { loadout: LOADOUT.loadout, warehouse: LOADOUT.warehouse, tier: 'mythic' });
    assert.equal(pnl.status, 200, pnl.raw);
    assert.equal(pnl.body.data.panel.role.stats.atk, 22, '20×1.10 = 22');
    assert.equal(pnl.body.data.panel.role.stats.hp, 150, '100+50 = 150');
    assert.equal(pnl.body.data.panel.role.special.critChance, 0.5);
    assert.equal(pnl.body.data.panel.skills.length, 3);
  });
});

test('T-AP-3 业务拒绝 → 409 loadout_invalid + details（结构/引用/门控/AI）', async () => {
  await withServer(null, async ({ port }) => {
    const bad = JSON.parse(JSON.stringify(LOADOUT));
    bad.loadout.skills = bad.loadout.skills.slice(0, 2);
    const r1 = await request(port, 'POST', '/api/v1/loadout', { loadout: bad.loadout, warehouse: bad.warehouse });
    assert.equal(r1.status, 409);
    assert.equal(r1.body.error.code, 'loadout_invalid');
    assert.ok(r1.body.error.details.length > 0);
    const f2 = JSON.parse(JSON.stringify(LOADOUT));
    f2.loadout.role.slots[0].pluginUid = 'ghost';
    f2.warehouse.buckets.role[0].slots[0].pluginUid = 'ghost';
    const r2 = await request(port, 'POST', '/api/v1/loadout', { loadout: f2.loadout, warehouse: f2.warehouse });
    assert.equal(r2.status, 409);
    assert.ok(r2.body.error.details.some((e) => e.message.includes('悬挂引用')));
    const r3 = await request(port, 'POST', '/api/v1/panel', { loadout: f2.loadout, warehouse: f2.warehouse });
    assert.equal(r3.status, 409);
    assert.equal(r3.body.error.code, 'loadout_invalid');
  });
});

test('T-AP-2 参数错误：bad_json / bad_request / bad_tier → 400 + code', async () => {
  await withServer(null, async ({ port }) => {
    const bj = await request(port, 'POST', '/api/v1/loadout', '{nope');
    assert.equal(bj.status, 400);
    assert.equal(bj.body.error.code, 'bad_json');
    const br = await request(port, 'POST', '/api/v1/panel', {});
    assert.equal(br.status, 400);
    assert.equal(br.body.error.code, 'bad_request');
    const bt1 = await request(port, 'POST', '/api/v1/loadout', { loadout: LOADOUT.loadout, tier: 'diamond' });
    assert.equal(bt1.status, 400);
    assert.equal(bt1.body.error.code, 'bad_tier', 'P2-1：loadout 非法 tier 与 /ai/validate 口径一致');
    const bt2 = await request(port, 'POST', '/api/v1/panel', { loadout: LOADOUT.loadout, tier: 'diamond' });
    assert.equal(bt2.status, 400);
    assert.equal(bt2.body.error.code, 'bad_tier');
  });
});

test('P1 回归（HTTP）：skills 缺失 409 非 500；装配引用缺 warehouse → 409 missing_warehouse；双引用 409；api.reject 日志', async () => {
  await withServer(null, async ({ port, logger }) => {
    const f1 = JSON.parse(JSON.stringify(LOADOUT));
    f1.loadout.skills = null;
    const r1 = await request(port, 'POST', '/api/v1/loadout', { loadout: f1.loadout, warehouse: f1.warehouse });
    assert.equal(r1.status, 409, r1.raw);
    assert.equal(r1.body.error.code, 'loadout_invalid');
    // 无 warehouse + 有引用 → missing_warehouse
    const r2 = await request(port, 'POST', '/api/v1/panel', { loadout: LOADOUT.loadout });
    assert.equal(r2.status, 409, r2.raw);
    assert.equal(r2.body.error.details[0].code, 'missing_warehouse');
    // 双引用
    const f3 = JSON.parse(JSON.stringify(LOADOUT));
    f3.loadout.role.slots = [{ type: 'atk', pluginUid: 'pa' }, { type: 'atk', pluginUid: 'pa' }];
    const r3 = await request(port, 'POST', '/api/v1/loadout', { loadout: f3.loadout, warehouse: f3.warehouse });
    assert.equal(r3.status, 409);
    assert.ok(r3.body.error.details.some((e) => e.message.includes('双处引用')), JSON.stringify(r3.body.error.details));
    assert.ok(logger.records.some((x) => x.event === 'api.reject' && x.level === 'warn'), 'api.reject(warn) 记录（P2-5）');
  });
});

test('B20 P1-1 回归（HTTP）：未知技能模板 → 双端点 409 非 500；/panel 聚合值 1.38/16 显式断言', async () => {
  await withServer(null, async ({ port }) => {
    const f = JSON.parse(JSON.stringify(LOADOUT));
    f.loadout.skills[2].templateId = 'nope_not_a_template';
    const r1 = await request(port, 'POST', '/api/v1/loadout', { loadout: f.loadout, warehouse: f.warehouse });
    assert.equal(r1.status, 409, r1.raw);
    assert.equal(r1.body.error.code, 'loadout_invalid');
    assert.ok(r1.body.error.details.some((e) => e.message.includes('未知技能模板')), JSON.stringify(r1.body.error.details));
    const r2 = await request(port, 'POST', '/api/v1/panel', { loadout: f.loadout, warehouse: f.warehouse });
    assert.equal(r2.status, 409, r2.raw);
    assert.equal(r2.body.error.code, 'loadout_invalid', '面板不再 500');
    // 聚合值经 HTTP 显式断言（P2-⑥）
    const pnl = await request(port, 'POST', '/api/v1/panel', { loadout: LOADOUT.loadout, warehouse: LOADOUT.warehouse, tier: 'mythic' });
    assert.equal(pnl.status, 200);
    assert.equal(pnl.body.data.panel.skills[0].params.multiplier, 1.38, '倍率聚合经 HTTP');
    assert.equal(pnl.body.data.panel.skills[0].params.cost.mp, 16, '消耗补偿经 HTTP');
  });
});