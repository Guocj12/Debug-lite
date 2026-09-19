'use strict';
/* tests/api/api-me.test.js —— P7-4（B29/B30）档案端点：/me、配置槽、仓库镜像、战绩/未读/防守
 *
 * 契约：docs/systems/11-account-store.md §5.3（配置槽 D-131）/§5.4（快照冻结）/§7.5（未读游标）
 *      /§10.1（端点总表）；docs/interfaces.md §2（/me* 行）
 * 覆盖：正例（摘要/槽位 CRUD/仓库镜像/战绩/防守/改昵称）+ 负例（401 无 token、403 越权、404 slot_not_found、
 *      409 slot_limit/slot_locked/config_conflict、400 参数与坏 JSON）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');
const LD = require('../fixtures/loadout-ok.json');

const PW = h.PASSWORD;

async function twoPlayers(s) {
  const a = await h.register(s.port, h.uniqueName('mea'));
  const b = await h.register(s.port, h.uniqueName('meb'));
  const aId = await h.playerIdByPublicId(s.store, a.publicId);
  const bId = await h.playerIdByPublicId(s.store, b.publicId);
  return { a, b, aId, bId };
}

// 手工结算一场（双方真实档案；走 journal → apply，与 quickmatch 同口径）
async function settleQuick(s, aId, bId, seed) {
  const aSlot = await h.activeSlotOf(s.store, aId);
  const bSlot = await h.activeSlotOf(s.store, bId);
  return h.settleRecord(s.store, {
    mode: 'quick',
    seed: seed === undefined ? 4242 : seed,
    at: Date.now(),
    p1: {
      playerId: aId, publicId: aSlot.archive.publicId, role: 'attacker',
      snapshotHash: aSlot.snapshotHash, configHash: aSlot.configHash,
      pointsBefore: 100, pointsAfter: 114, result: 'win', tierBefore: 'common', tierAfter: 'common',
    },
    p2: {
      playerId: bId, publicId: bSlot.archive.publicId, role: 'defender',
      snapshotHash: bSlot.snapshotHash, configHash: bSlot.configHash,
      pointsBefore: 100, pointsAfter: 86, result: 'loss', tierBefore: 'common', tierAfter: 'common',
    },
    verdict: { winner: 'p1', reason: 'hero_dead', ticks: 23 },
    versions: { engine: s.store.versions.engine, data: s.store.versions.data },
  });
}

test('ME-1 GET /me：档案摘要字段 + 401 负例', async () => {
  await h.withServer(null, async (s) => {
    const { a } = await twoPlayers(s);
    const r = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(a.token));
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.publicId, a.publicId);
    assert.equal(r.body.data.progress.tier, 'common');
    assert.equal(r.body.data.rating.points, 0);
    assert.equal(r.body.data.activeSlotId, 'slot1');
    assert.equal(r.body.data.slots.length, 1);
    assert.equal(typeof r.body.data.record.unread.defense, 'number');
    assert.equal(r.body.data.pool.inPool, true);
    assert.equal(r.body.data.flags.unverifiedLoadout, true, '未提交仓库镜像 → unverifiedLoadout=true（§5.2）');
    assert.ok(!r.raw.includes('pl_'), '不得回带 playerId');
    const noToken = await h.request(s.port, 'GET', '/api/v1/me');
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, 'unauthorized');
  });
});

test('ME-2 配置槽：GET 列表 / POST 新建（复制出战）/ 409 slot_limit / PUT 保存 + config_conflict / activate / DELETE 保护', async () => {
  await h.withServer(null, async (s) => {
    const { a } = await twoPlayers(s);
    const auth = h.authed(a.token);
    const list0 = await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, auth);
    assert.equal(list0.status, 200);
    assert.equal(list0.body.data.slots.length, 1);
    assert.equal(list0.body.data.maxSlots, 3);
    assert.equal(list0.body.data.slots[0].loadout.skills.length, 3, '配置全文含 3 技能');
    // 新建（默认复制出战配置，不切换）
    const c1 = await h.request(s.port, 'POST', '/api/v1/me/configs', { name: '第二套' }, auth);
    assert.equal(c1.status, 200, c1.raw);
    assert.equal(c1.body.data.slots.length, 2);
    assert.equal(c1.body.data.activeSlotId, 'slot1', '新建不改变出战（切换是 activate 的职责）');
    const c2 = await h.request(s.port, 'POST', '/api/v1/me/configs', { name: '第三套' }, auth);
    assert.equal(c2.status, 200);
    assert.equal(c2.body.data.slots.length, 3);
    const c3 = await h.request(s.port, 'POST', '/api/v1/me/configs', { name: '第四套' }, auth);
    assert.equal(c3.status, 409);
    assert.equal(c3.body.error.code, 'slot_limit', '最多 3 套（D-131）');
    // 保存第二套（带匹配的仓库镜像 → warehouseVerified）
    const slot2 = c1.body.data.slotId;
    const save = await h.request(s.port, 'PUT', `/api/v1/me/configs/${slot2}`, { loadout: LD.loadout, warehouse: LD.warehouse }, auth);
    assert.equal(save.status, 200, save.raw);
    assert.equal(save.body.data.slotId, slot2);
    assert.equal(typeof save.body.data.snapshot.hash, 'string');
    assert.equal(save.body.data.unverifiedLoadout, false, '提供匹配镜像 → 清除 unverifiedLoadout');
    // 乐观锁冲突（baseUpdatedAt 过期）
    const conflict = await h.request(s.port, 'PUT', `/api/v1/me/configs/${slot2}`, { loadout: LD.loadout, warehouse: LD.warehouse, baseUpdatedAt: 1 }, auth);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'config_conflict');
    // 非法 loadout → 409 loadout_invalid
    const badLd = JSON.parse(JSON.stringify(LD.loadout));
    badLd.skills = badLd.skills.slice(0, 2);
    const invalid = await h.request(s.port, 'PUT', `/api/v1/me/configs/${slot2}`, { loadout: badLd, warehouse: LD.warehouse }, auth);
    assert.equal(invalid.status, 409);
    assert.equal(invalid.body.error.code, 'loadout_invalid');
    // 不存在槽位 → 404 slot_not_found
    const nf = await h.request(s.port, 'PUT', '/api/v1/me/configs/slotX', { loadout: LD.loadout, warehouse: LD.warehouse }, auth);
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, 'slot_not_found');
    // 激活第二套
    const act = await h.request(s.port, 'POST', `/api/v1/me/configs/${slot2}/activate`, {}, auth);
    assert.equal(act.status, 200, act.raw);
    assert.equal(act.body.data.activeSlotId, slot2);
    assert.equal(typeof act.body.data.activeSnapshotHash, 'string');
    const actNf = await h.request(s.port, 'POST', '/api/v1/me/configs/slotX/activate', {}, auth);
    assert.equal(actNf.status, 404);
    // 出战槽不可删；切回后可删
    const locked = await h.request(s.port, 'DELETE', `/api/v1/me/configs/${slot2}`, undefined, auth);
    assert.equal(locked.status, 409);
    assert.equal(locked.body.error.code, 'slot_locked', '出战槽禁止删除');
    await h.request(s.port, 'POST', '/api/v1/me/configs/slot1/activate', {}, auth);
    const del = await h.request(s.port, 'DELETE', `/api/v1/me/configs/${slot2}`, undefined, auth);
    assert.equal(del.status, 200, del.raw);
    assert.equal(del.body.data.deleted, slot2);
    // 默认槽不可删
    const delDefault = await h.request(s.port, 'DELETE', '/api/v1/me/configs/slot1', undefined, auth);
    assert.equal(delDefault.status, 409);
    assert.equal(delDefault.body.error.code, 'slot_locked');
    // 坏 JSON
    const badJson = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', '{nope', auth);
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
  });
});

test('ME-3 仓库镜像：GET 未提交 404 warehouse_missing / PUT 结构校验 400 / 引用校验 409 / PUT+GET 正例', async () => {
  await h.withServer(null, async (s) => {
    const { a } = await twoPlayers(s);
    const auth = h.authed(a.token);
    const missing = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, auth);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'warehouse_missing', '镜像不落盘（D-130），本进程未提交即缺失');
    const bad = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: { buckets: 'nope' } }, auth);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_request');
    const noWh = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', {}, auth);
    assert.equal(noWh.status, 400);
    // 先保存与镜像一致的出战配置，再提交镜像 → 引用校验通过
    const save = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', { loadout: LD.loadout, warehouse: LD.warehouse }, auth);
    assert.equal(save.status, 200, save.raw);
    const put = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: LD.warehouse }, auth);
    assert.equal(put.status, 200, put.raw);
    assert.equal(put.body.data.saved, true);
    assert.equal(put.body.data.verified, true);
    assert.equal(typeof put.body.data.warehouseHash, 'string');
    assert.ok(!put.raw.includes('pl_'));
    const get = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, auth);
    assert.equal(get.status, 200, get.raw);
    assert.equal(get.body.data.warehouseHash, put.body.data.warehouseHash);
    assert.equal(get.body.data.unverifiedLoadout, false);
    // 与出战配置不一致的镜像 → 409 loadout_invalid（引用校验失败）
    const empty = { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
    const mismatch = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: empty }, auth);
    assert.equal(mismatch.status, 409);
    assert.equal(mismatch.body.error.code, 'loadout_invalid');
    // 未鉴权
    assert.equal((await h.request(s.port, 'GET', '/api/v1/me/warehouse')).status, 401);
    assert.equal((await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: LD.warehouse })).status, 401);
  });
});

test('ME-4 战绩 / 未读 / 防守战绩：增量游标、seen 推进、参数负例', async () => {
  await h.withServer(null, async (s) => {
    const { a, b, aId, bId } = await twoPlayers(s);
    await settleQuick(s, aId, bId, 7001);
    const recA = await h.request(s.port, 'GET', '/api/v1/me/records', undefined, h.authed(a.token));
    assert.equal(recA.status, 200, recA.raw);
    assert.equal(recA.body.data.records.length, 1);
    const entry = recA.body.data.records[0];
    assert.equal(entry.role, 'attacker');
    assert.equal(entry.result, 'win');
    assert.equal(entry.pointsDelta, 14);
    assert.equal(typeof entry.seq, 'number');
    assert.equal(recA.body.data.unread.attack, 1);
    assert.equal(recA.body.data.unread.defense, 0);
    assert.ok(!recA.raw.includes('pl_'), '战绩不得回带 playerId');
    // since 游标增量
    const inc = await h.request(s.port, 'GET', `/api/v1/me/records?since=${entry.seq}`, undefined, h.authed(a.token));
    assert.equal(inc.status, 200);
    assert.equal(inc.body.data.records.length, 0, 'since=已读 seq → 无增量');
    assert.equal(inc.body.data.since, entry.seq);
    // role 过滤 / limit
    const def = await h.request(s.port, 'GET', '/api/v1/me/records?role=defense', undefined, h.authed(a.token));
    assert.equal(def.status, 200);
    assert.equal(def.body.data.records.length, 0);
    const lim = await h.request(s.port, 'GET', '/api/v1/me/records?limit=1', undefined, h.authed(a.token));
    assert.equal(lim.status, 200);
    // 参数负例
    const badSince = await h.request(s.port, 'GET', '/api/v1/me/records?since=-1', undefined, h.authed(a.token));
    assert.equal(badSince.status, 400);
    assert.equal(badSince.body.error.code, 'bad_request');
    const badRole = await h.request(s.port, 'GET', '/api/v1/me/records?role=nope', undefined, h.authed(a.token));
    assert.equal(badRole.status, 400);
    const badLimit = await h.request(s.port, 'GET', '/api/v1/me/records?limit=0', undefined, h.authed(a.token));
    assert.equal(badLimit.status, 400);
    // 推进未读游标（设计口径 /me/records/seen 与任务口径 /me/seen 等价）
    const upto = recA.body.data.maxSeq;
    const seen = await h.request(s.port, 'POST', '/api/v1/me/records/seen', { uptoSeq: upto }, h.authed(a.token));
    assert.equal(seen.status, 200, seen.raw);
    assert.equal(seen.body.data.unread.attack, 0);
    const meAfter = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(a.token));
    assert.equal(meAfter.body.data.record.unread.attack, 0);
    const seenAlias = await h.request(s.port, 'POST', '/api/v1/me/seen', { uptoSeq: 0 }, h.authed(a.token));
    assert.equal(seenAlias.status, 200, seenAlias.raw);
    const badSeq = await h.request(s.port, 'POST', '/api/v1/me/records/seen', { uptoSeq: -5 }, h.authed(a.token));
    assert.equal(badSeq.status, 400);
    assert.equal(badSeq.body.error.code, 'bad_request');
    // 防守方视角：被抽 1 场、未读 1、段位与积分不变
    const defB = await h.request(s.port, 'GET', '/api/v1/me/defense', undefined, h.authed(b.token));
    assert.equal(defB.status, 200, defB.raw);
    assert.equal(defB.body.data.stats.losses, 1);
    assert.equal(defB.body.data.drawnCount, 1);
    assert.equal(defB.body.data.recent.length, 1);
    const meB = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(b.token));
    assert.equal(meB.body.data.record.unread.defense, 1);
    assert.equal(meB.body.data.rating.points, 86, '防守方积分按记录落盘（quick 双向结算，D-133）');
    assert.equal(meB.body.data.progress.tier, 'common', '本场记录不含段位变更（tierBefore=tierAfter）');
    const badDefLimit = await h.request(s.port, 'GET', '/api/v1/me/defense?limit=999', undefined, h.authed(b.token));
    assert.equal(badDefLimit.status, 400);
    assert.equal(badDefLimit.body.error.code, 'bad_request');
    // 未鉴权
    assert.equal((await h.request(s.port, 'GET', '/api/v1/me/records')).status, 401);
    assert.equal((await h.request(s.port, 'GET', '/api/v1/me/defense')).status, 401);
    assert.equal((await h.request(s.port, 'POST', '/api/v1/me/records/seen', { uptoSeq: 1 })).status, 401);
  });
});

test('ME-5 改昵称：正例 + 非法 400 + 未鉴权 401', async () => {
  await h.withServer(null, async (s) => {
    const { a } = await twoPlayers(s);
    const ok = await h.request(s.port, 'PUT', '/api/v1/me/nickname', { nickname: '新昵称' }, h.authed(a.token));
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.data.nickname, '新昵称');
    assert.equal(ok.body.data.publicId, a.publicId);
    const bad = await h.request(s.port, 'PUT', '/api/v1/me/nickname', { nickname: 'x'.repeat(40) }, h.authed(a.token));
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_request');
    assert.equal((await h.request(s.port, 'PUT', '/api/v1/me/nickname', { nickname: 'x' })).status, 401);
  });
});

test('ME-6 未装配档案存储（无 DL_DATA_DIR）：/me 一律 503 store_unavailable', async () => {
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'GET', '/api/v1/me');
    assert.equal(r.status, 503);
    assert.equal(r.body.error.code, 'store_unavailable');
    const reg = await h.request(s.port, 'POST', '/api/v1/auth/register', { username: 'nostore', password: PW });
    assert.equal(reg.status, 503);
    // 遗留无状态端点不受影响（零回归）
    const health = await h.request(s.port, 'GET', '/api/v1/health');
    assert.equal(health.status, 200);
  }, { server: { enableStore: false, dataDir: undefined, env: {} } });
});
