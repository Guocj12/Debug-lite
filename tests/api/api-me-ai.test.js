'use strict';
/* tests/api/api-me-ai.test.js —— D-161 AI 库（本批仅后端；前端只用 GET 列表）
 *
 * 契约：docs/frontend/03-hub-warehouse-loadout.md §1/§5.2/§6/§9.3；docs/interfaces.md §2（/me/ai* 行）
 * 覆盖：
 *   UAI-1 GET：库内默认 AI（starter 下发）+ max=100 + usage「被哪个配置引用」+ 401 负例
 *   UAI-2 POST 正例：命名保存（名称 trim、可被列表读到、program 原样回带）
 *   UAI-3 POST 参数错误：名称为空/超长、program 非程序对象
 *   UAI-4 DELETE：未被引用 → 200；未知 aiId → 404
 *   UAI-5 DELETE 被**出战配置**引用 → 409 ai_in_use（非出战配置引用不阻止删除）
 *   UAI-6 上限 100：第 101 条 → 409 ai_limit
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

async function slot1Loadout(s, p) {
  const cfg = await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(p.token));
  return cfg.body.data.slots.find((x) => x.slotId === 'slot1').loadout;
}

test('UAI-1 GET /me/ai：starter 默认 AI + max + usage + 401 负例', async () => {
  await h.withServer(null, async (s) => {
    const unauth = await h.request(s.port, 'GET', '/api/v1/me/ai');
    assert.equal(unauth.status, 401);

    const p = await freshPlayer(s, 'uai1');
    const r = await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(p.token));
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    assert.equal(d.max, 100, 'AI 与物品**分别计数**，上限来自 service-config.ai.maxPerPlayer');
    assert.equal(d.count, 1, 'D-159：starter 同时登记一条库内默认 AI');
    assert.equal(d.items[0].name, '新手AI');
    assert.equal(d.items[0].program.type, 'program');
    assert.ok(Number.isInteger(d.items[0].createdAt), '库条目带创建时间');
    // usage：出战配置（slot1）引用的 aiId 必须被标记
    const ld = await slot1Loadout(s, p);
    assert.equal(ld.aiId, d.items[0].aiId, 'slot1 的 loadout.aiId 指向库内默认 AI');
    assert.deepEqual(d.usage[ld.aiId], ['slot1'], 'usage 标记被哪个配置引用');
  });
});

test('UAI-2 POST /me/ai 正例：命名保存（trim）+ 列表可读 + program 原样回带', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uai2');
    const ld = await slot1Loadout(s, p);
    const r = await h.request(s.port, 'POST', '/api/v1/me/ai', {
      name: '  我的进攻AI  ', program: ld.ai,
    }, h.authed(p.token));
    assert.equal(r.status, 200, r.raw);
    assert.match(r.body.data.aiId, /^ai_[0-9a-f]{16}$/);
    assert.equal(r.body.data.ai.name, '我的进攻AI', '名称首尾空白被 trim');
    assert.equal(r.body.data.count, 2);
    assert.equal(r.body.data.max, 100);

    const list = await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(p.token));
    assert.equal(list.body.data.count, 2);
    const mine = list.body.data.items.find((x) => x.aiId === r.body.data.aiId);
    assert.equal(mine.name, '我的进攻AI');
    assert.deepEqual(mine.program, ld.ai, 'program 原样落库并回带');
    // 新建的 AI 尚未被任何配置引用 → usage 中不出现
    assert.equal(list.body.data.usage[r.body.data.aiId], undefined);
  });
});

test('UAI-3 POST 参数错误：名称为空/超长、program 非法', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uai3');
    const ld = await slot1Loadout(s, p);
    const cases = [
      { name: '', program: ld.ai, why: '空名称' },
      { name: '   ', program: ld.ai, why: '全空白名称' },
      { name: 'x'.repeat(25), program: ld.ai, why: '名称超过 24 字符' },
      { name: 'ok', program: null, why: 'program 缺失' },
      { name: 'ok', program: { type: 'seq' }, why: 'program.type 不是 program' },
      { name: 'ok', program: [1, 2], why: 'program 是数组' },
    ];
    for (const c of cases) {
      const r = await h.request(s.port, 'POST', '/api/v1/me/ai', { name: c.name, program: c.program }, h.authed(p.token));
      assert.equal(r.status, 400, `${c.why} 应 400（实际 ${r.status} ${r.raw}）`);
      assert.equal(r.body.error.code, 'bad_request');
      assert.ok(r.body.error.details.length > 0, `${c.why} 必须带 details`);
    }
    const list = await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(p.token));
    assert.equal(list.body.data.count, 1, '全部被拒 → 库内只剩 starter 那条');
  });
});

test('UAI-4 DELETE：未被引用 → 200；未知 aiId → 404', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uai4');
    const ld = await slot1Loadout(s, p);
    const created = await h.request(s.port, 'POST', '/api/v1/me/ai', { name: '临时', program: ld.ai }, h.authed(p.token));
    const aiId = created.body.data.aiId;

    const del = await h.request(s.port, 'DELETE', `/api/v1/me/ai/${aiId}`, undefined, h.authed(p.token));
    assert.equal(del.status, 200, del.raw);
    assert.equal(del.body.data.deleted, aiId);
    assert.equal(del.body.data.count, 1);
    const list = await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(p.token));
    assert.equal(list.body.data.items.some((x) => x.aiId === aiId), false, '删除后列表不再包含');

    const again = await h.request(s.port, 'DELETE', `/api/v1/me/ai/${aiId}`, undefined, h.authed(p.token));
    assert.equal(again.status, 404, '重复删除 → 404');
    assert.equal(again.body.error.code, 'store_not_found');
    const unknown = await h.request(s.port, 'DELETE', '/api/v1/me/ai/ai_ffffffffffffffff', undefined, h.authed(p.token));
    assert.equal(unknown.status, 404);
    const unauth = await h.request(s.port, 'DELETE', `/api/v1/me/ai/${aiId}`);
    assert.equal(unauth.status, 401);
  });
});

test('UAI-5 DELETE 被出战配置引用 → 409 ai_in_use；被**非出战**配置引用不阻止删除', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uai5');
    const ld = await slot1Loadout(s, p);
    const a = await h.request(s.port, 'POST', '/api/v1/me/ai', { name: 'A', program: ld.ai }, h.authed(p.token));
    const aiA = a.body.data.aiId;

    // ① 让**出战配置**（slot1 是 activeSlotId）引用它
    const save = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', {
      loadout: { ...ld, aiId: aiA },
    }, h.authed(p.token));
    assert.equal(save.status, 200, save.raw);
    const blocked = await h.request(s.port, 'DELETE', `/api/v1/me/ai/${aiA}`, undefined, h.authed(p.token));
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(blocked.body.error.code, 'ai_in_use');
    assert.ok(blocked.body.error.details.some((d) => /slot1/.test(d.message)), 'details 指出被哪个配置引用');

    // ② 切成非出战配置引用 → 允许删除（只提示 referencedBy）
    const b = await h.request(s.port, 'POST', '/api/v1/me/ai', { name: 'B', program: ld.ai }, h.authed(p.token));
    const aiB = b.body.data.aiId;
    const save2 = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot2', {
      loadout: { ...ld, aiId: aiB },
    }, h.authed(p.token));
    assert.equal(save2.status, 200, save2.raw);
    const del = await h.request(s.port, 'DELETE', `/api/v1/me/ai/${aiB}`, undefined, h.authed(p.token));
    assert.equal(del.status, 200, `非出战配置的引用不阻止删除（实际 ${del.raw}）`);
    assert.deepEqual(del.body.data.referencedBy, ['slot2'], '回带引用它的槽（供前端提示）');
  });
});

test('UAI-6 上限 100：第 101 条 → 409 ai_limit（与物品计数无关）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uai6');
    const ld = await slot1Loadout(s, p);
    // starter 已给 1 条 → 再建 99 条到满
    for (let i = 0; i < 99; i += 1) {
      const r = await h.request(s.port, 'POST', '/api/v1/me/ai', { name: `ai${i}`, program: ld.ai }, h.authed(p.token));
      assert.equal(r.status, 200, `第 ${i + 2} 条应成功（${r.raw}）`);
    }
    const list = await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(p.token));
    assert.equal(list.body.data.count, 100, '恰好满 100');

    const over = await h.request(s.port, 'POST', '/api/v1/me/ai', { name: 'overflow', program: ld.ai }, h.authed(p.token));
    assert.equal(over.status, 409, over.raw);
    assert.equal(over.body.error.code, 'ai_limit');
    assert.match(over.body.error.message, /100/);

    // 删一条后又能建（上限是"同时存在数"，不是总量）
    const first = list.body.data.items.find((x) => x.name !== '新手AI');
    const del = await h.request(s.port, 'DELETE', `/api/v1/me/ai/${first.aiId}`, undefined, h.authed(p.token));
    assert.equal(del.status, 200);
    const ok = await h.request(s.port, 'POST', '/api/v1/me/ai', { name: 'again', program: ld.ai }, h.authed(p.token));
    assert.equal(ok.status, 200, '腾出名额后可再建');
  });
});
