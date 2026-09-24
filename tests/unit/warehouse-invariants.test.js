'use strict';
/* tests/unit/warehouse-invariants.test.js —— 独立审查（F3 批次，commit 0a2e27e）发现的缺陷与加固的**回归网**
 *
 * 本文件的每一条都对应一次真实审查发现，不做"跑一遍不报错"式断言：
 *   WI-1（审查 F-1）`createPlayerArchive` 显式 loadout 路径必须把**入参 warehouse 落档**
 *        —— 修前只落 starter 的仓库 → 校验所用镜像 ≠ 落档镜像，配置引用在档案侧永久悬空，
 *        之后连"重存同一份出战配置"都会 409（悬挂引用）。
 *   WI-2（审查 疑似1 加固）journal 里出现"把 B 直接装进已被 A 占用的槽"时，A 必须被复位为未装配，
 *        否则 A 永久停在 equipped=true（再也装不回去）。HTTP 路径由 `slot_occupied` 拦死，本用例走
 *        store 层直接验证加固。
 *   WI-3（审查 F-2）`box.opened` 的防御分支超限时**不得静默漂移**：差额必须落进 grantIds 条目
 *        （`dropped` / `droppedUids`）并逐件 error 记录；桶计数不得越限。
 *   WI-4（审查"该测而未测"）grantIds 环形窗口（256）**溢出后**从 journal 重建不得丢物品/不得翻倍。
 *   WI-5（审查"该测而未测"）同一槽并发装配后仓库必须**自洽**：每个 equipped=true 的插件都被某个槽引用。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const archiveMod = require('../../server/store/archive.js');
const rankedMod = require('../../server/ranked.js');
const { openFixture, sampleLoadout } = require('../helpers/account.js');

const ROLE_UID = 'wi_role';
const PLUGIN_ATK = 'wi_plugin_atk';
const PLUGIN_ATK_2 = 'wi_plugin_atk2';

// 一个"角色带 **2** 个 atk 槽（槽0 已装配一个插件、槽1 空闲）+ 3 个无引用技能"的最小仓库
//   —— 2 个槽是为了让 WI-2（替换）与 WI-5（并发装配到同一**空闲**槽）都能构造出可达场景
function fixtureWarehouse() {
  const skills = [1, 2, 3].map((i) => ({
    uid: `wi_skill${i}`, kind: 'skill', templateId: 'skill_melee_whirl', name: `技能${i}`, quality: 'common',
    slotCount: 0, slots: [], params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 10 }, cooldown: 2, bulletLevel: 2 },
    unlockTier: 'common',
  }));
  const role = {
    uid: ROLE_UID, kind: 'role', templateId: 'role_bal', name: '均衡', quality: 'common',
    slotCount: 2, slots: [{ type: 'atk', pluginUid: PLUGIN_ATK }, { type: 'atk', pluginUid: null }],
    stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
    unlockTier: 'common', pluginPoints: 3,
  };
  const plugin = {
    uid: PLUGIN_ATK, kind: 'rolePlugin', id: 'rp_atk_flat', name: '攻击 +4', slot: 'atk',
    category: '攻击提升', quality: 'common', tier: 1, affixes: [{ id: 'atk_flat', desc: '攻击 +4', params: { v: 4 } }],
    unlockTier: 'common', pointCost: 1, equipped: true,
  };
  return { buckets: { role: [role], skill: skills, rolePlugin: [plugin], skillPlugin: [] } };
}

function loadoutOf(warehouse) {
  return {
    role: warehouse.buckets.role[0],
    skills: warehouse.buckets.skill.slice(0, 3),
    ai: rankedMod.buildDefaultLoadout({ publicId: 'u_wi000001' }).ai,
  };
}

const equippedUids = (wh) => ['rolePlugin', 'skillPlugin']
  .flatMap((b) => wh.buckets[b] || []).filter((p) => p.equipped === true).map((p) => p.uid);
const referencedUids = (wh) => ['role', 'skill']
  .flatMap((b) => wh.buckets[b] || [])
  .flatMap((it) => (it.slots || []).map((s) => s.pluginUid))
  .filter((u) => typeof u === 'string' && u !== '');

test('WI-1（审查 F-1 回归）：显式 loadout + warehouse 建档必须把 warehouse 落档，且配置可重存', async () => {
  const fx = await openFixture({ logger: require('../../shared/log.js').nullLogger });
  try {
    const warehouse = fixtureWarehouse();
    const loadout = loadoutOf(warehouse);
    const playerId = archiveMod.newPlayerId();
    const created = await fx.account.createPlayerArchive({
      playerId, publicId: archiveMod.newPublicId(), nickname: '显式', auth: { hash: 'h' },
      loadout, warehouse, tier: 'common',
    });
    assert.equal(created.ok, true, JSON.stringify(created).slice(0, 300));

    // ① 落档仓库必须就是入参仓库（修前为空桶）
    const view = await fx.store.getWarehouse(playerId);
    assert.deepEqual(view.counts, { role: 1, skill: 3, rolePlugin: 1, skillPlugin: 0 },
      `校验所用镜像必须落档（修前档案仓库为空：${JSON.stringify(view.counts)}）`);
    assert.equal(view.warehouse.buckets.role[0].uid, ROLE_UID);
    assert.equal(view.warehouse.buckets.rolePlugin[0].equipped, true, '装配状态随仓库一起落档');

    // ② 校验镜像 == 落档镜像 → 重存同一份出战配置必须成功（修前 409 悬挂引用）
    const slotId = created.data.activeSlotId;
    const resaved = await fx.account.saveConfig({ playerId, slotId, loadout });
    assert.equal(resaved.ok, true, `重存同一配置必须成功（修前 409：${JSON.stringify(resaved).slice(0, 220)}`);

    // ③ 引用完整性：档案仓库覆盖 loadout 的全部引用
    assert.deepEqual(referencedUids(view.warehouse), [PLUGIN_ATK]);
    for (const uid of referencedUids(view.warehouse)) {
      const found = archiveMod.findWarehouseItem(view.warehouse, uid);
      assert.ok(found, `${uid} 必须在档案仓库中（否则档案侧悬空）`);
    }
  } finally {
    await fx.cleanup();
  }
});

test('WI-2（加固回归）：把插件直接装进"已被占用"的槽时，旧插件必须被复位为未装配', async () => {
  const fx = await openFixture({ logger: require('../../shared/log.js').nullLogger });
  try {
    const warehouse = fixtureWarehouse();
    // 追加第二个 atk 插件（未装配）
    warehouse.buckets.rolePlugin.push({
      uid: PLUGIN_ATK_2, kind: 'rolePlugin', id: 'rp_atk_pct', name: '攻击 +8%', slot: 'atk',
      category: '攻击提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1,
    });
    const playerId = archiveMod.newPlayerId();
    const created = await fx.account.createPlayerArchive({
      playerId, publicId: archiveMod.newPublicId(), nickname: '替换', auth: { hash: 'h' },
      loadout: loadoutOf(warehouse), warehouse, tier: 'common',
    });
    assert.equal(created.ok, true);

    // 直接在 store 层落一条"替换"记录（绕过 L6 的 slot_occupied 拦截，模拟畸形/重放记录）
    const rec = require('../../server/store/ledger.js').buildWarehouseRecord({
      playerId, op: 'assemble', targetUid: ROLE_UID, slotIndex: 0, pluginUid: PLUGIN_ATK_2, at: fx.clock(),
    });
    const appended = await fx.store.append(rec); // seq 由 journal 分配（必须用返回值）
    await fx.store.applyRecord(appended);

    const view = await fx.store.getWarehouse(playerId);
    const wh = view.warehouse;
    assert.equal(wh.buckets.role[0].slots[0].pluginUid, PLUGIN_ATK_2, '槽位指向新插件');
    const oldOne = archiveMod.findWarehouseItem(wh, PLUGIN_ATK).item;
    const newOne = archiveMod.findWarehouseItem(wh, PLUGIN_ATK_2).item;
    assert.equal(oldOne.equipped, false, '被替换掉的旧插件必须复位为未装配（否则再也装不回去）');
    assert.equal(newOne.equipped, true, '新插件必须置为已装配');
    assert.deepEqual(equippedUids(wh).sort(), [PLUGIN_ATK_2], '任何时刻至多一个插件处于已装配态');
  } finally {
    await fx.cleanup();
  }
});

test('WI-3（审查 F-2 回归）：box.opened 防御分支超限时差额必须可审计（不得静默漂移）', async () => {
  const logger = require('../../shared/log.js').createLogger({ level: 'all', ringSize: 5000, now: () => 0 });
  // 注意：store 适配器用的是 `storeLogger`（缺省 nullLogger）—— 断言日志必须把它也指到同一个 logger
  const fx = await openFixture({ logger, storeLogger: logger });
  try {
    const playerId = archiveMod.newPlayerId();
    const created = await fx.account.createPlayerArchive({
      playerId, publicId: archiveMod.newPublicId(), nickname: '超限', auth: { hash: 'h' },
      loadout: rankedMod.buildDefaultLoadout({ publicId: 'u_wi000002' }), tier: 'common',
    });
    assert.equal(created.ok, true);
    // 把 skillPlugin 桶灌到 499（模拟"档案与 journal 不一致"的前置状态）
    await fx.store.updateArchive(playerId, (a) => {
      const list = a.warehouse.buckets.skillPlugin;
      while (list.length < 499) {
        const n = list.length;
        list.push({
          uid: `wi_fill_${n}`, kind: 'skillPlugin', id: 'sp_mult', name: 'filler', slot: 'basic',
          quality: 'common', tier: 1, affixes: [],
        });
      }
      return null;
    });

    // 直接落一条 3 件的开箱记录（第 2、3 件必然超限）
    const ledger = require('../../server/store/ledger.js');
    const items = [0, 1, 2].map((i) => ({
      uid: `wi_over_${i}`, kind: 'skillPlugin', id: 'sp_mult', name: `超限${i}`, slot: 'basic',
      quality: 'common', tier: 1, affixes: [],
    }));
    const rec = ledger.buildBoxRecord({ playerId, seed: 999, tier: 'common', times: 3, items, at: fx.clock() });
    const appended = await fx.store.append(rec); // seq 由 journal 分配（必须用返回值）
    await fx.store.applyRecord(appended); // 不得抛错（抛错会让 journal 重放永久失败）

    const view = await fx.store.getWarehouse(playerId);
    assert.equal(view.counts.skillPlugin, 500, '桶计数不得越限（500）');
    // 公开视图（`GET /me/warehouse` 形状）不暴露 grantIds（内部记账）→ 环形窗口断言读档案
    const archive = await fx.store.loadArchive(playerId);
    const ringEntry = archive.warehouse.grantIds.find((g) => g.grantId === rec.grantId);
    assert.ok(ringEntry, 'grantId 必须落进环形窗口');
    assert.equal(ringEntry.count, 1, '实际入档 1 件');
    assert.equal(ringEntry.dropped, 2, '差额必须被记录（修前静默丢弃、journal 与档案永久漂移）');
    assert.deepEqual((ringEntry.droppedUids || []).sort(), ['wi_over_1', 'wi_over_2']);
    assert.ok(logger.records.some((r) => r.event === 'store.warehouse.full' && r.level === 'error'
      && r.data && r.data.grantId === rec.grantId), '必须逐件 error 记录（带 grantId）');
  } finally {
    await fx.cleanup();
  }
});

test('WI-4（审查"该测而未测"）：grantIds 窗口（256）溢出后从 journal 重建不丢物品、不翻倍', async () => {
  const fx = await openFixture({ logger: require('../../shared/log.js').nullLogger });
  try {
    const playerId = archiveMod.newPlayerId();
    const created = await fx.account.createPlayerArchive({
      playerId, publicId: archiveMod.newPublicId(), nickname: '窗口', auth: { hash: 'h' },
      loadout: rankedMod.buildDefaultLoadout({ publicId: 'u_wi000003' }), tier: 'common',
    });
    assert.equal(created.ok, true);
    const before = (await fx.store.getWarehouse(playerId)).counts;
    const N = 300; // > GRANT_WINDOW(256)
    for (let i = 0; i < N; i += 1) {
      await fx.store.grantBox({
        playerId, seed: 10000 + i, tier: 'common', times: 1,
        items: [{
          uid: `wi_win_${i}`, kind: 'rolePlugin', id: 'rp_atk_flat', name: `窗口${i}`, slot: 'atk',
          category: '攻击提升', quality: 'common', tier: 1, affixes: [],
        }],
      });
    }
    const granted = (await fx.store.getWarehouse(playerId)).counts;
    assert.equal(granted.rolePlugin, before.rolePlugin + N, '300 件全部入档');
    const archiveAfter = await fx.store.loadArchive(playerId);
    assert.ok(archiveAfter.warehouse.grantIds.length <= archiveMod.GRANT_WINDOW,
      '环形窗口长度必须 ≤ 256');

    // 只靠 journal 重建（档案文件丢失）→ 不得丢物品、不得翻倍
    await fx.store.rebuildArchive(playerId);
    const rebuilt = (await fx.store.getWarehouse(playerId)).counts;
    assert.deepEqual(rebuilt, granted, `窗口溢出后重建必须逐桶一致（实际 ${JSON.stringify(rebuilt)}）`);
    await fx.store.rebuildArchive(playerId);
    assert.deepEqual((await fx.store.getWarehouse(playerId)).counts, granted, '重复重建不得翻倍');
    const stats = fx.store.stats();
    assert.equal(stats.reapplied, 0, `不得出现水位缺口补 apply（实际 ${stats.reapplied}）`);
  } finally {
    await fx.cleanup();
  }
});

test('WI-5（审查"该测而未测"）：同一槽并发装配后仓库自洽（每个 equipped=true 的插件都被引用）', async () => {
  const fx = await openFixture({ logger: require('../../shared/log.js').nullLogger });
  try {
    const warehouse = fixtureWarehouse();
    warehouse.buckets.rolePlugin.push({
      uid: PLUGIN_ATK_2, kind: 'rolePlugin', id: 'rp_atk_pct', name: '攻击 +8%', slot: 'atk',
      category: '攻击提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1,
    });
    const PLUGIN_ATK_3 = 'wi_plugin_atk3';
    warehouse.buckets.rolePlugin.push({
      uid: PLUGIN_ATK_3, kind: 'rolePlugin', id: 'rp_atk_flat', name: '攻击 +4', slot: 'atk',
      category: '攻击提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1,
    });
    const playerId = archiveMod.newPlayerId();
    const created = await fx.account.createPlayerArchive({
      playerId, publicId: archiveMod.newPublicId(), nickname: '并发', auth: { hash: 'h' },
      loadout: loadoutOf(warehouse), warehouse, tier: 'common',
    });
    assert.equal(created.ok, true);

    // 并发把**两个不同插件**装进同一个空闲槽（槽1）：
    //   · 若 B 的校验发生在 A 落档之后 → B 得 409 `slot_occupied`；
    //   · 若两者校验都发生在任一落档之前 → 两次都 200，**后写胜出**（last-write-wins）。
    //   L6 的"读→校验→写"不在 store 的同一把玩家锁里，故两种交错都可能发生；
    //   本用例断言的是**不变量**而非某一具体交错：终态必须自洽（引用 ↔ equipped 一一对应）。
    const [a, b] = await Promise.all([
      fx.account.assemblePlugin({ playerId, targetUid: ROLE_UID, pluginUid: PLUGIN_ATK_2, slotIndex: 1 }),
      fx.account.assemblePlugin({ playerId, targetUid: ROLE_UID, pluginUid: PLUGIN_ATK_3, slotIndex: 1 }),
    ]);
    const statuses = [a, b].map((r) => (r.ok ? 200 : r.status)).sort();
    const pair = JSON.stringify(statuses);
    assert.ok(pair === JSON.stringify([200, 200]) || pair === JSON.stringify([200, 409]),
      `并发装配状态只能是 [200,200]（后写胜出）或 [200,409]（占用拒绝），实际 ${pair}`);

    const wh = (await fx.store.getWarehouse(playerId)).warehouse;
    const slot1Uid = wh.buckets.role[0].slots[1].pluginUid;
    assert.ok([PLUGIN_ATK_2, PLUGIN_ATK_3].includes(slot1Uid), `槽1 必须指向其中一个插件（实际 ${slot1Uid}）`);
    const slot0Uid = wh.buckets.role[0].slots[0].pluginUid;
    assert.equal(slot0Uid, PLUGIN_ATK, '槽0 不受同槽并发影响');

    // **核心不变量**：equipped=true 的插件集合 == 被槽引用的插件集合（顺序无关）
    const equipped = equippedUids(wh).sort();
    const referenced = [...new Set(referencedUids(wh))].sort();
    assert.deepEqual(equipped, referenced,
      `已装配集合必须与引用集合一致（未胜出的插件不得停在 equipped=true）：equipped=${JSON.stringify(equipped)} referenced=${JSON.stringify(referenced)}`);
    for (const uid of referenced) {
      assert.equal(archiveMod.findWarehouseItem(wh, uid).item.equipped, true, `被引用插件 ${uid} 必须 equipped=true`);
    }
  } finally {
    await fx.cleanup();
  }
});
