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

// D-163：loadout 的物品身份/数值一律解析自**服务端权威仓库** —— LD.loadout 用到的 r1/s1..s3/pa/pb/qx
//   必须先真的在档（修前靠 PUT 请求里随带的 `warehouse` 镜像顶替权威仓库；该"客户端镜像即真源"的降级已废除）。
//   直接把 fixture 的仓库正文注入档案仓库（uid 与 starter 的 item_* 不冲突）。
async function injectFixture(s, playerId) {
  await s.store.updateArchive(playerId, (a) => {
    for (const [bucket, list] of Object.entries(LD.warehouse.buckets)) {
      for (const it of list) a.warehouse.buckets[bucket].push(JSON.parse(JSON.stringify(it)));
    }
    return null;
  });
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
    // D-159：注册即发 starter 并建满 3 槽（slot1 完整出战、slot2/slot3 空槽无快照）
    assert.equal(r.body.data.slots.length, 3);
    assert.deepEqual(r.body.data.slots.map((s) => s.slotId), ['slot1', 'slot2', 'slot3']);
    assert.equal(r.body.data.slots[0].isDefault, true);
    assert.equal(r.body.data.slots[0].snapshotHash, r.body.data.activeSnapshotHash, 'slot1 快照与 activeSnapshotHash 一致');
    assert.equal(r.body.data.slots[1].snapshotHash, null, 'D-160：非出战空槽可无快照');
    assert.equal(r.body.data.slots[2].snapshotHash, null);
    assert.equal(typeof r.body.data.record.unread.defense, 'number');
    assert.equal(r.body.data.pool.inPool, true);
    // D-159：starter 自带服务端权威仓库（并写入 slot1）→ 注册即已校验（旧断言"未提交镜像 → true"已废除）
    assert.equal(r.body.data.flags.unverifiedLoadout, false, 'D-159：注册发放 starter → 已校验');
    assert.ok(!r.raw.includes('pl_'), '不得回带 playerId');
    const noToken = await h.request(s.port, 'GET', '/api/v1/me');
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, 'unauthorized');
  });
});

test('ME-2 配置槽：GET 列表（注册即 3 槽）/ POST 建空槽 + 409 slot_limit / PUT 保存 + config_conflict + 仅出战槽要求完整 / activate / DELETE 保护', async () => {
  await h.withServer(null, async (s) => {
    const { a, aId } = await twoPlayers(s);
    const auth = h.authed(a.token);
    // D-163：LD 的物品必须先在**服务端权威仓库**（PUT 不再接收客户端 warehouse 镜像做解析来源）
    await injectFixture(s, aId);
    // D-159：注册即建满 3 槽（slot1 完整出战 + slot2/slot3 空槽）
    const list0 = await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, auth);
    assert.equal(list0.status, 200);
    assert.equal(list0.body.data.slots.length, 3, 'D-159：注册即 3 槽');
    assert.equal(list0.body.data.maxSlots, 3);
    assert.equal(list0.body.data.slots[0].loadout.skills.length, 3, '配置全文含 3 技能');
    assert.equal(list0.body.data.slots[0].snapshot.hash, list0.body.data.activeSnapshotHash);
    assert.equal(list0.body.data.slots[1].snapshot, null, 'D-160：注册出的非出战槽无快照');
    assert.equal(list0.body.data.slots[0].isDefault, true);
    // D-159 连带：已满 3 槽 → 再建必须 409 slot_limit（旧写法"新建成功 2 次再撞限"已废除）
    const over = await h.request(s.port, 'POST', '/api/v1/me/configs', { name: '第四套' }, auth);
    assert.equal(over.status, 409, over.raw);
    assert.equal(over.body.error.code, 'slot_limit', '最多 3 套（D-131）');
    // 先删一个非默认非出战槽（slot3），再新建 → D-160：新槽是**空槽**（不再复制出战配置），且不改变出战
    const del3 = await h.request(s.port, 'DELETE', '/api/v1/me/configs/slot3', undefined, auth);
    assert.equal(del3.status, 200, del3.raw);
    const c1 = await h.request(s.port, 'POST', '/api/v1/me/configs', { name: '第二套' }, auth);
    assert.equal(c1.status, 200, c1.raw);
    assert.equal(c1.body.data.slots.length, 3);
    assert.equal(c1.body.data.activeSlotId, 'slot1', 'D-160：新建槽不改变出战（切换是 activate 的职责）');
    assert.equal(c1.body.data.snapshot, null, 'D-160：新建槽无快照');
    assert.deepEqual(c1.body.data.slot.loadout, { role: null, skills: [null, null, null], ai: null }, 'D-160：新建槽为空槽');
    const slot2 = c1.body.data.slotId;
    assert.equal(slot2, 'slot3', '复用被释放的槽 id');
    // 保存第二套（fixture 完整 loadout + 匹配的仓库镜像 → 快照冻结 + warehouseVerified）
    const save = await h.request(s.port, 'PUT', `/api/v1/me/configs/${slot2}`, { loadout: LD.loadout, warehouse: LD.warehouse }, auth);
    assert.equal(save.status, 200, save.raw);
    assert.equal(save.body.data.slotId, slot2);
    assert.equal(typeof save.body.data.snapshot.hash, 'string');
    assert.equal(save.body.data.complete, true);
    assert.deepEqual(save.body.data.missing, []);
    assert.equal(save.body.data.unverifiedLoadout, false, '提供匹配镜像 → 清除 unverifiedLoadout');
    // 乐观锁冲突（baseUpdatedAt 过期）
    const conflict = await h.request(s.port, 'PUT', `/api/v1/me/configs/${slot2}`, { loadout: LD.loadout, warehouse: LD.warehouse, baseUpdatedAt: 1 }, auth);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'config_conflict');
    // D-160：**非出战槽**允许写不完整配置 → 200（快照置空、complete:false、missing 逐位置列出）
    const badLd = JSON.parse(JSON.stringify(LD.loadout));
    badLd.skills = badLd.skills.slice(0, 2);
    const nonActive = await h.request(s.port, 'PUT', `/api/v1/me/configs/${slot2}`, { loadout: badLd, warehouse: LD.warehouse }, auth);
    assert.equal(nonActive.status, 200, nonActive.raw);
    assert.equal(nonActive.body.data.complete, false);
    assert.deepEqual(nonActive.body.data.missing, ['skills[2]']);
    assert.equal(nonActive.body.data.snapshot, null, '不完整 → 不冻结快照');
    // D-163：落盘正文经 resolveItems 规范化 —— 技能位恒为**恰 3 个**（客户端少给的第 3 位补 null），
    //   而不是照抄客户端的 2 元素数组；"不完整正文照常落盘"仍成立（已给的两件逐值保留）。
    assert.equal(nonActive.body.data.slot.loadout.skills.length, 3, 'D-163：技能位规范化为恰 3 个（缺位为 null）');
    assert.deepEqual(nonActive.body.data.slot.loadout.skills.slice(0, 2).map((x) => x && x.uid),
      badLd.skills.map((x) => x.uid), '客户端给的两件技能逐值落盘（身份取自仓库）');
    assert.equal(nonActive.body.data.slot.loadout.skills[2], null, '缺的第 3 位为 null');
    // 但此时 activate 必须 409 cannot_activate_incomplete（完整性校验推迟到激活，D-160）
    const actInc = await h.request(s.port, 'POST', `/api/v1/me/configs/${slot2}/activate`, {}, auth);
    assert.equal(actInc.status, 409, actInc.raw);
    assert.equal(actInc.body.error.code, 'cannot_activate_incomplete');
    assert.deepEqual(actInc.body.error.details.map((d) => d.path), ['skills[2]']);
    // D-160：**出战槽**写不完整 → 409 loadout_invalid（details 逐位置）
    const badActive = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', { loadout: { role: null, skills: [], ai: null } }, auth);
    assert.equal(badActive.status, 409);
    assert.equal(badActive.body.error.code, 'loadout_invalid');
    assert.deepEqual(badActive.body.error.details.map((d) => d.path), ['role', 'skills[0]', 'skills[1]', 'skills[2]', 'ai']);
    // 修复为完整后激活第二套
    const fix = await h.request(s.port, 'PUT', `/api/v1/me/configs/${slot2}`, { loadout: LD.loadout, warehouse: LD.warehouse }, auth);
    assert.equal(fix.status, 200, fix.raw);
    assert.equal(fix.body.data.complete, true);
    const act = await h.request(s.port, 'POST', `/api/v1/me/configs/${slot2}/activate`, {}, auth);
    assert.equal(act.status, 200, act.raw);
    assert.equal(act.body.data.activeSlotId, slot2);
    assert.equal(typeof act.body.data.activeSnapshotHash, 'string');
    // 不存在槽位 → 404 slot_not_found
    const nf = await h.request(s.port, 'PUT', '/api/v1/me/configs/slotX', { loadout: LD.loadout, warehouse: LD.warehouse }, auth);
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error.code, 'slot_not_found');
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

test('ME-3 服务端权威仓库：GET 真源（不再 404）/ PUT 形状校验 400 / 引用不覆盖 → 200+verified:false / 匹配 → verified:true + 回读', async () => {
  await h.withServer(null, async (s) => {
    const { a } = await twoPlayers(s);
    const auth = h.authed(a.token);
    // D-159：仓库改为**服务端权威** —— GET /me/warehouse 是真源，注册即有 starter，**不再** 404 warehouse_missing
    const get0 = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, auth);
    assert.equal(get0.status, 200, get0.raw);
    assert.equal(get0.body.data.starterIssued, true);
    assert.deepEqual(Object.keys(get0.body.data).sort(), ['buckets', 'caps', 'counts', 'starterIssued', 'usage']);
    assert.deepEqual(Object.keys(get0.body.data.buckets).sort(), ['role', 'rolePlugin', 'skill', 'skillPlugin']);
    assert.equal(get0.body.data.counts.role, 1);
    assert.equal(get0.body.data.counts.skill, 3);
    assert.equal(get0.body.data.counts.skillPlugin, 1);
    assert.equal(get0.body.data.caps.skillPlugin, 500);
    // usage：starter 已把物品装配进 slot1 → 每个被引用 uid 都标注"装配于哪个配置"
    const starterSlot = (await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, auth)).body.data.slots
      .find((x) => x.slotId === 'slot1');
    const roleUid = starterSlot.loadout.role.uid;
    assert.deepEqual(get0.body.data.usage[roleUid], { slotIds: ['slot1'] });
    // PUT /me/warehouse 退役为**只做形状校验**
    const bad = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: { buckets: 'nope' } }, auth);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_request');
    const noWh = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', {}, auth);
    assert.equal(noWh.status, 400, '缺 warehouse 字段 → 400（形状校验保留）');
    // 引用不覆盖出战配置 → **不再 409 loadout_invalid**，改 200 + verified:false + saved:true（D-159）
    const empty = { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
    const mismatch = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: empty }, auth);
    assert.equal(mismatch.status, 200, mismatch.raw);
    assert.equal(mismatch.body.data.saved, true);
    assert.equal(mismatch.body.data.verified, false, 'D-159：引用不覆盖出战配置 → verified:false（旧 409 已废除）');
    assert.equal(typeof mismatch.body.data.warehouseHash, 'string');
    assert.ok(!mismatch.raw.includes('pl_'));
    // 服务端真源不受镜像影响（D-159：镜像非权威）→ 档案 flags.unverifiedLoadout 仍为 false
    const meAfterMirror = await h.request(s.port, 'GET', '/api/v1/me', undefined, auth);
    assert.equal(meAfterMirror.body.data.flags.unverifiedLoadout, false,
      'D-159：仓库真源未变（镜像不覆盖真源）→ 出战配置仍然已校验');
    // 提交与真源一致的镜像 → verified:true 且回读一致（round-trip）
    const realWh = { buckets: get0.body.data.buckets };
    const put = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: realWh }, auth);
    assert.equal(put.status, 200, put.raw);
    assert.equal(put.body.data.saved, true);
    assert.equal(put.body.data.verified, true, '覆盖出战配置全部装配引用 → verified:true');
    assert.deepEqual(put.body.data.buckets, get0.body.data.counts);
    assert.match(put.body.data.warehouseHash, /^sha256:[0-9a-f]{64}$/);
    const get = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, auth);
    assert.equal(get.status, 200, get.raw);
    assert.deepEqual(get.body.data.buckets, realWh.buckets, 'GET 真源与提交的镜像逐值一致（starter 未被改动）');
    assert.deepEqual(get.body.data.counts, get0.body.data.counts);
    // 未鉴权
    assert.equal((await h.request(s.port, 'GET', '/api/v1/me/warehouse')).status, 401);
    assert.equal((await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: LD.warehouse })).status, 401);
    assert.equal((await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', { targetUid: roleUid, pluginUid: 'x', slotIndex: 0 })).status, 401);
    assert.equal((await h.request(s.port, 'POST', '/api/v1/me/warehouse/disassemble', { targetUid: roleUid, slotIndex: 0 })).status, 401);
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
