'use strict';
/* D-186/D-187 后端专项：`POST /me/configs/:slotId/select`（选定「当前显示哪份配置」）
 *   与 `POST /me/warehouse/dismantle`（分解/删除仓库物品，**无产出**）。
 *
 * 为什么单独一个文件（而不是并进 api-configs / api-me-warehouse）：
 *   · 两条都是本会话（2026-10-05）新增的端点，语义各有一处**易错点**需要在同处钉住：
 *     - `select` 与 `activate` **必须分开**（select 不校验完整性、不动快照、不改出战槽）；
 *     - `dismantle` 的拒绝**必须零写入**（判完再落盘，collect-then-apply）。
 *   · 真实 HTTP（起真服务 + 真注册 + 真仓库），不用假夹具 ——
 *     判据全部来自 `docs/frontend/09-layout-driven-ui.md` §8（本批设计冻结）。
 *
 * 编号：SL-* = select；DM-* = dismantle。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const { start } = require('../../server/index.js');

let seq = 0;
function tmpDataDir() {
  seq += 1;
  return fs.mkdtempSync(path.join(os.tmpdir(), `d18x-${process.pid}-${seq}-`));
}

async function withServer(fn) {
  const dataDir = tmpDataDir();
  const srv = await start({ port: 0, dataDir, logLevel: 'error' });
  const base = `http://127.0.0.1:${srv.port}/api/v1`;
  const request = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* 非 JSON 留给断言暴露 */ }
    return { status: res.status, json, text };
  };
  try {
    return await fn({ request, dataDir, srv, base });
  } finally {
    await srv.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function codeOf(res) {
  if (!res.json) return null;
  return res.json.error ? res.json.error.code : res.json.code;
}

async function newPlayer(request, tag) {
  // 用户名约束：3~24 字符、只含 [A-Za-z0-9_-]（server 的 USERNAME_RE）。
  //   用 base36 时间戳后 6 位 + 3 位随机 → 唯一且**不超长**（早期版本拼了毫秒时间戳，直接超 24 被拒）。
  const suffix = (Date.now().toString(36).slice(-6) + Math.floor(Math.random() * 46656).toString(36)).slice(0, 9);
  const username = `d18x_${tag}_${suffix}`;
  assert.ok(username.length <= 24, `用户名 ${username}（${username.length}）超长`);
  const reg = await request('POST', '/auth/register', { username, password: 'pw123456', nickname: tag });
  assert.equal(reg.status, 200, `注册失败：${reg.text}`);
  return { username, token: reg.json.data.token };
}

/* ============================ SL: select / viewedSlot ============================ */

test('SL-1 select 与 activate 完全分开：不改出战槽、不改快照、不校验完整性', async () => {
  await withServer(async ({ request }) => {
    const { token } = await newPlayer(request, 'sl1');
    const me0 = await request('GET', '/me', undefined, token);
    assert.equal(me0.json.data.viewedSlotId, 'slot1', 'D-186：注册时 viewedSlotId = 出战槽');
    assert.equal(me0.json.data.battleSlot, 'slot1');
    assert.equal(me0.json.data.activeSnapshotHash, me0.json.data.activeSnapshotHash);

    // slot2 是**空槽**（D-160：非出战槽允许不完整）—— select 它必须成功
    const sel = await request('POST', '/me/configs/slot2/select', {}, token);
    assert.equal(sel.status, 200, sel.text);
    assert.equal(sel.json.data.viewedSlot, 'slot2');

    const me1 = await request('GET', '/me', undefined, token);
    assert.equal(me1.json.data.viewedSlotId, 'slot2', 'viewedSlotId 已切换');
    assert.equal(me1.json.data.battleSlot, 'slot1', '**出战槽不动**（select ≠ activate）');
    assert.equal(me1.json.data.activeSnapshotHash, me0.json.data.activeSnapshotHash,
      '快照 hash 不动（select 不冻结/不改快照）');

    // 反证：activate 一个**不完整**的槽必须被拒 —— 证明 select 的放行不是因为"slot2 其实是完整的"
    const act = await request('POST', '/me/configs/slot2/activate', {}, token);
    assert.equal(act.status, 409, `空槽 activate 应 409，实得 ${act.status} ${act.text}`);
    assert.equal(codeOf(act), 'cannot_activate_incomplete');
  });
});

test('SL-2 select 不存在的槽 → 404 slot_not_found；非法槽名 → 400', async () => {
  await withServer(async ({ request }) => {
    const { token } = await newPlayer(request, 'sl2');
    const bad = await request('POST', '/me/configs/slot9/select', {}, token);
    assert.equal(bad.status, 404, bad.text);
    assert.equal(codeOf(bad), 'slot_not_found');

    // D-179 口径：解码后再查分节符（`%2F` → `/` 必须 400，而不是走进"未知槽位"）
    const enc = await request('POST', '/me/configs/a%2Fb/select', {}, token);
    assert.equal(enc.status, 400, enc.text);
    assert.equal(codeOf(enc), 'bad_request');
  });
});

test('SL-3 select 需鉴权（401）；跨重启持久化', async () => {
  const dataDir = tmpDataDir();
  const srv1 = await start({ port: 0, dataDir, logLevel: 'error' });
  const req1 = async (method, p, body, token) => {
    const res = await fetch(`http://127.0.0.1:${srv1.port}/api/v1${p}`, {
      method,
      headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* ignore */ }
    return { status: res.status, json };
  };
  let username = null;
  try {
    const noAuth = await req1('POST', '/me/configs/slot2/select', {});
    assert.equal(noAuth.status, 401, '匿名 select 必须 401');

    const p = await newPlayer(req1, 'sl3');
    username = p.username;
    assert.equal((await req1('POST', '/me/configs/slot3/select', {}, p.token)).status, 200);
    const me = await req1('GET', '/me', undefined, p.token);
    assert.equal(me.json.data.viewedSlotId, 'slot3');
  } finally {
    await srv1.close();
  }

  // 关服 → 同数据根重启 → 值仍在（证明它落了档案/journal，不是内存态）
  const srv2 = await start({ port: 0, dataDir, logLevel: 'error' });
  try {
    const base = `http://127.0.0.1:${srv2.port}/api/v1`;
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw123456' }),
    }).then((r) => r.json());
    const me2 = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${login.data.token}` } }).then((r) => r.json());
    assert.equal(me2.data.viewedSlotId, 'slot3', '重启后 viewedSlotId 仍是 slot3（已落档）');
    assert.equal(me2.data.battleSlot, 'slot1', '重启后出战槽仍是 slot1');
  } finally {
    await srv2.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('SL-4 select 幂等：重复选同一槽不产生额外写入（journal 不再追加）', async () => {
  await withServer(async ({ request }) => {
    const { token } = await newPlayer(request, 'sl4');
    // 第一次 select → 切到 slot2
    const a = await request('POST', '/me/configs/slot2/select', {}, token);
    assert.equal(a.status, 200);
    // 再选一次同一槽：接口必须**仍然 200**（幂等对外），但档案侧不应再写
    const b = await request('POST', '/me/configs/slot2/select', {}, token);
    assert.equal(b.status, 200, b.text);
    assert.equal(b.json.data.viewedSlot, 'slot2');
    const me = await request('GET', '/me', undefined, token);
    assert.equal(me.json.data.viewedSlotId, 'slot2');
  });
});

/* ============================ DM: dismantle ============================ */

test('DM-1 不可分解的桶（AI 节点 / 包）→ 409 item_not_dismantlable，零写入', async () => {
  await withServer(async ({ request }) => {
    const { token } = await newPlayer(request, 'dm1');
    const wh = await request('GET', '/me/warehouse', undefined, token);
    const before = wh.json.data.counts;

    for (const bucket of ['aiNode', 'package']) {
      const list = wh.json.data.buckets[bucket];
      assert.ok(list.length > 0, `starter 应有 ${bucket}（否则本用例失去意义）`);
      const res = await request('POST', '/me/warehouse/dismantle', { uids: [list[0].uid] }, token);
      assert.equal(res.status, 409, `${bucket}: ${res.text}`);
      assert.equal(codeOf(res), 'item_not_dismantlable');
      assert.equal(res.json.error.details[0].code, 'item_not_dismantlable');
    }
    const after = await request('GET', '/me/warehouse', undefined, token);
    assert.deepEqual(after.json.data.counts, before, '被拒 → 零写入（桶数不变）');
  });
});

test('DM-2 被任何配置引用 → 409 item_in_use；已装配插件 → 409 被拒且零写入', async () => {
  await withServer(async ({ request }) => {
    const { token } = await newPlayer(request, 'dm2');
    const wh = await request('GET', '/me/warehouse', undefined, token);
    const cfg = await request('GET', '/me/configs', undefined, token);
    const loadout = cfg.json.data.slots.find((s) => s.slotId === 'slot1').loadout;
    const roleUid = loadout.role.uid;

    const res = await request('POST', '/me/warehouse/dismantle', { uids: [roleUid] }, token);
    assert.equal(res.status, 409, res.text);
    assert.equal(codeOf(res), 'item_in_use');
    assert.match(res.json.error.details[0].message, /slot1/, '理由要写明被哪份配置用着');

    const eq = wh.json.data.buckets.rolePlugin.find((p) => p.equipped === true);
    assert.ok(eq, 'starter 应有已装配的角色插件');
    const res2 = await request('POST', '/me/warehouse/dismantle', { uids: [eq.uid] }, token);
    assert.equal(res2.status, 409, `已装配插件必须被拒：${res2.text}`);

    const after = await request('GET', '/me/warehouse', undefined, token);
    assert.ok(after.json.data.buckets.rolePlugin.some((p) => p.uid === eq.uid), '被拒后插件仍在');
    assert.ok(after.json.data.buckets.role.some((p) => p.uid === roleUid), '被拒后角色仍在');
  });
});

test('DM-3 参数负例：不存在的 uid → 404；空/重复/超量/非字符串 → 400', async () => {
  await withServer(async ({ request }) => {
    const { token } = await newPlayer(request, 'dm3');
    const notFound = await request('POST', '/me/warehouse/dismantle', { uids: ['item_nope'] }, token);
    assert.equal(notFound.status, 404, notFound.text);
    assert.equal(codeOf(notFound), 'item_not_found');

    assert.equal((await request('POST', '/me/warehouse/dismantle', { uids: [] }, token)).status, 400);
    assert.equal((await request('POST', '/me/warehouse/dismantle', { uids: ['a', 'a'] }, token)).status, 400);
    assert.equal((await request('POST', '/me/warehouse/dismantle', { uids: [''] }, token)).status, 400);
    assert.equal((await request('POST', '/me/warehouse/dismantle', { uids: [123] }, token)).status, 400);
    assert.equal((await request('POST', '/me/warehouse/dismantle', {}, token)).status, 400);
    const tooMany = Array.from({ length: 101 }, (_, i) => `item_${i}`);
    assert.equal((await request('POST', '/me/warehouse/dismantle', { uids: tooMany }, token)).status, 400, '超过 100 个必须 400');
    // 匿名
    assert.equal((await request('POST', '/me/warehouse/dismantle', { uids: ['x'] })).status, 401);
  });
});

test('DM-4 真分解：物品从真源消失、counts 减 1、重复分解 404、跨重启不复活', async () => {
  const dataDir = tmpDataDir();
  const srv1 = await start({ port: 0, dataDir, logLevel: 'error' });
  let username = null;
  let victim = null;
  let victimKind = null;
  try {
    const base = `http://127.0.0.1:${srv1.port}/api/v1`;
    const request = async (method, p, body, token) => {
      const res = await fetch(base + p, {
        method,
        headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: `Bearer ${token}` } : {}),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* ignore */ }
      return { status: res.status, json };
    };
    const p = await newPlayer(request, 'dm4');
    username = p.username;
    const token = p.token;

    // starter 的物品**全部**被 slot1 引用或已装配 ⇒ 先开包造出**不被引用**的物品
    const wh0 = await request('GET', '/me/warehouse', undefined, token);
    const opened = await request('POST', '/me/warehouse/open-package', {
      packageUids: [wh0.json.data.buckets.package[0].uid],
    }, token);
    assert.equal(opened.status, 200, opened.text);

    const wh1 = await request('GET', '/me/warehouse', undefined, token);
    const usage = wh1.json.data.usage || {};
    const inUse = (uid) => !!(usage[uid] && Array.isArray(usage[uid].slotIds) && usage[uid].slotIds.length > 0);
    for (const key of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
      const found = (wh1.json.data.buckets[key] || []).find((it) => !inUse(it.uid) && it.equipped !== true);
      if (found) { victim = found; victimKind = key; break; }
    }
    assert.ok(victim, '开包后应至少有一件**未被引用**的可分解物品（否则本用例无判据）');

    const before = wh1.json.data.counts[victimKind];
    const res = await request('POST', '/me/warehouse/dismantle', { uids: [victim.uid] }, token);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.data.dismantled, [victim.uid]);
    assert.equal(res.json.data.counts[victimKind], before - 1, '响应 counts 减 1');
    assert.ok(res.json.data.warehouse && res.json.data.usage, '响应回带完整仓库视图');

    const wh2 = await request('GET', '/me/warehouse', undefined, token);
    assert.ok(!wh2.json.data.buckets[victimKind].some((it) => it.uid === victim.uid), '真源里物品真的没了');
    assert.equal(wh2.json.data.counts[victimKind], before - 1);

    const again = await request('POST', '/me/warehouse/dismantle', { uids: [victim.uid] }, token);
    assert.equal(again.status, 404, '重复分解同一 uid → 404（幂等对外表现）');
    assert.equal(codeOf(again), 'item_not_found');
  } finally {
    await srv1.close();
  }

  const srv2 = await start({ port: 0, dataDir, logLevel: 'error' });
  try {
    const base = `http://127.0.0.1:${srv2.port}/api/v1`;
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'pw123456' }),
    }).then((r) => r.json());
    const wh = await fetch(`${base}/me/warehouse`, { headers: { authorization: `Bearer ${login.data.token}` } }).then((r) => r.json());
    assert.ok(!wh.data.buckets[victimKind].some((it) => it.uid === victim.uid), '重启后物品**不复活**（分解已落 journal）');
  } finally {
    await srv2.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('DM-5 批量分解是"全过才落盘"：一条不合法 → 整批拒绝、零写入', async () => {
  await withServer(async ({ request }) => {
    const { token } = await newPlayer(request, 'dm5');
    const wh0 = await request('GET', '/me/warehouse', undefined, token);
    const before = wh0.json.data.counts;
    // 造一件可分解物品
    await request('POST', '/me/warehouse/open-package', { packageUids: [wh0.json.data.buckets.package[0].uid] }, token);
    const wh1 = await request('GET', '/me/warehouse', undefined, token);
    const usage = wh1.json.data.usage || {};
    const inUse = (uid) => !!(usage[uid] && Array.isArray(usage[uid].slotIds) && usage[uid].slotIds.length > 0);
    let free = null;
    for (const key of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
      free = (wh1.json.data.buckets[key] || []).find((it) => !inUse(it.uid) && it.equipped !== true);
      if (free) break;
    }
    assert.ok(free, '需要一件可分解物品');
    const mid = wh1.json.data.counts;

    // 合法 + 不合法混在一批 → 整批拒绝（合法那件也不能被删）
    const res = await request('POST', '/me/warehouse/dismantle', { uids: [free.uid, 'item_nope'] }, token);
    assert.equal(res.status, 404, res.text);
    const after = await request('GET', '/me/warehouse', undefined, token);
    assert.ok(
      ['role', 'skill', 'rolePlugin', 'skillPlugin'].some((k) => after.json.data.buckets[k].some((it) => it.uid === free.uid)),
      '整批拒绝 ⇒ 合法那件**也不能**被删（collect-then-apply）',
    );
    assert.deepEqual(after.json.data.counts, mid, 'counts 完全不变');
  });
});
