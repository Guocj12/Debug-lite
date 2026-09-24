'use strict';
/* tests/api/api-me-box.test.js —— D-159 服务端权威开箱 + D-162 seed 服务端独占
 *
 * 契约：docs/frontend/03-hub-warehouse-loadout.md §1/§6/§9.1/§9.4；docs/interfaces.md §2（/me/box 行）
 * 覆盖：
 *   UBX-1 正例：物品直接入档（响应 counts == GET /me/warehouse counts）+ grantId + 401 负例
 *   UBX-2 D-162：请求体带 seed 被**忽略**（含非法 seed 值不再 bad_seed）；两次调用服务端 seed 不同
 *   UBX-3 参数错误：bad_json / bad_tier / bad_times
 *   UBX-4 上限：任一桶已满 → 409 warehouse_full（不入档）
 *   UBX-5 服务端权威：重启进程后仓库仍在（不再依赖客户端 localStorage / 进程内镜像）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');

async function freshPlayer(s, tag) {
  const p = await h.register(s.port, h.uniqueName(tag));
  assert.equal(p.status, 200, JSON.stringify(p.res && p.res.body));
  const playerId = await h.playerIdByPublicId(s.store, p.publicId);
  return { ...p, playerId };
}

test('UBX-1 POST /me/box 正例：物品入档 + counts/grantId + 401 负例', async () => {
  await h.withServer(null, async (s) => {
    const unauth = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 1 });
    assert.equal(unauth.status, 401, '未鉴权 → 401');

    const p = await freshPlayer(s, 'ubx1');
    const before = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    const r = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 3 }, h.authed(p.token));
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    assert.equal(d.times, 3);
    assert.equal(d.items.length, 3, '回带 3 件物品');
    assert.ok(Number.isInteger(d.seed) && d.seed >= 1, `seed 必须由服务端生成并回带（实际 ${d.seed}）`);
    assert.match(d.grantId, /^bx_[0-9a-f]{16}$/, 'grantId 为内容寻址的开箱批次号');
    for (const b of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
      assert.equal(d.caps[b], 500);
    }

    const after = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    const delta = {};
    for (const b of ['role', 'skill', 'rolePlugin', 'skillPlugin']) delta[b] = after.counts[b] - before.counts[b];
    const sum = Object.values(delta).reduce((a, x) => a + x, 0);
    assert.equal(sum, 3, `三件物品必须全部入档（实际每桶增量 ${JSON.stringify(delta)}）`);
    assert.deepEqual(after.counts, d.counts, '响应 counts 与真源一致');
    // 每件物品都能在仓库里按 uid 找到
    const all = new Set();
    for (const b of ['role', 'skill', 'rolePlugin', 'skillPlugin']) for (const it of after.buckets[b]) all.add(it.uid);
    for (const it of d.items) assert.ok(all.has(it.uid), `${it.uid} 应在仓库中`);
  });
});

test('UBX-2 D-162：请求体的 seed 被忽略（非法值也不再 bad_seed）；seed 由服务端生成', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'ubx2');
    const a = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 2, seed: 'abc' }, h.authed(p.token));
    assert.equal(a.status, 200, `seed 不是入参 → 非法值也应被忽略（实际 ${a.raw}）`);
    const b = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 2, seed: 12345 }, h.authed(p.token));
    assert.equal(b.status, 200);
    assert.notEqual(a.body.data.seed, b.body.data.seed, '两次都是服务端新生成的 seed（客户端 seed 无效）');
    const c = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 2, seed: 12345 }, h.authed(p.token));
    assert.notEqual(b.body.data.seed, c.body.data.seed, '同一客户端 seed 重复提交也不会复现同一批');
  });
});

test('UBX-3 参数错误：bad_json / bad_tier / bad_times', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'ubx3');
    const badJson = await h.request(s.port, 'POST', '/api/v1/me/box', '{nope', h.authed(p.token));
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');

    const badTier = await h.request(s.port, 'POST', '/api/v1/me/box', { tier: 'diamond' }, h.authed(p.token));
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');

    for (const times of [0, -1, 1.5, 101]) {
      const r = await h.request(s.port, 'POST', '/api/v1/me/box', { times }, h.authed(p.token));
      assert.equal(r.status, 400, `times=${times} 应 400`);
      assert.equal(r.body.error.code, 'bad_times');
    }
  });
});

test('UBX-4 上限：任一桶已满 → 409 warehouse_full，且不入档', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'ubx4');
    // 把四个桶全部灌满到 500（任一类型都会超限 → 结果确定，不依赖随机开出什么）
    await s.store.updateArchive(p.playerId, (a) => {
      const mk = (bucket, n) => ({ uid: `${bucket}_fill_${n}`, kind: bucket, name: 'filler', quality: 'common', tier: 1, affixes: [], slots: [] });
      for (const bucket of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
        const list = a.warehouse.buckets[bucket];
        while (list.length < 500) list.push(mk(bucket, list.length));
      }
      return null;
    });
    const r = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 1 }, h.authed(p.token));
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error.code, 'warehouse_full');
    assert.ok(r.body.error.details.length > 0, '带逐桶 details');
    const after = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    for (const b of ['role', 'skill', 'rolePlugin', 'skillPlugin']) assert.equal(after.counts[b], 500, '拒绝后计数不变');
  });
});

test('UBX-5 服务端权威：重启进程后仓库与开箱结果仍可读（不依赖进程内缓存）', async () => {
  const s1 = await h.startServer();
  let dataDir = null;
  try {
    dataDir = s1.dataDir;
    const p = await freshPlayer(s1, 'ubx5');
    const box = await h.request(s1.port, 'POST', '/api/v1/me/box', { times: 5 }, h.authed(p.token));
    assert.equal(box.status, 200);
    const uids = box.body.data.items.map((x) => x.uid);
    const counts = (await h.request(s1.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data.counts;
    await s1.close(); // 只关服务与锁，保留数据根

    const s2 = await h.startServer({ dataDir });
    try {
      const r = await h.request(s2.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token));
      assert.equal(r.status, 200, '重启后仍可读真源（旧契约下这里会 404 warehouse_missing）');
      assert.deepEqual(r.body.data.counts, counts, '重启后计数一致');
      const all = new Set();
      for (const b of ['role', 'skill', 'rolePlugin', 'skillPlugin']) for (const it of r.body.data.buckets[b]) all.add(it.uid);
      for (const uid of uids) assert.ok(all.has(uid), `开箱物品 ${uid} 在重启后仍在仓库`);
    } finally {
      await s2.cleanup();
    }
  } finally {
    if (dataDir === null) await s1.cleanup();
  }
});
