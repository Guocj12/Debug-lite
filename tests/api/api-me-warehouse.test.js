'use strict';
/* tests/api/api-me-warehouse.test.js —— D-159 服务端权威仓库（真源 + 装配/拆卸 + 上限）
 *
 * 契约：docs/frontend/03-hub-warehouse-loadout.md §1/§5.2/§6/§9.1；docs/interfaces.md §2（/me/warehouse* 行）
 * 覆盖：
 *   UWH-1 真源形状（buckets/usage/caps/counts/starterIssued）+ 401 负例
 *   UWH-2 usage「装配于配置几」：出战配置引用的角色/技能/插件都被标记，且同物品可多配置引用
 *   UWH-3 assemble 正例（按槽类型匹配）→ 仓库与 usage 同步；disassemble 正例
 *   UWH-4 装配拒绝码：类型不符 409 slot_type_mismatch（文案可读）、空槽拆卸 404 slot_empty
 *   UWH-5 每桶上限 500：接近上限时超限 → 409 warehouse_full（不写 journal，计数不变）
 *   UWH-6 PUT /me/warehouse 退役为只校验形状：引用不覆盖 → 200 + verified:false；形状非法 → 400
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');

const BUCKETS = ['role', 'skill', 'rolePlugin', 'skillPlugin'];

async function freshPlayer(s, tag) {
  const p = await h.register(s.port, h.uniqueName(tag));
  assert.equal(p.status, 200, JSON.stringify(p.res && p.res.body));
  const playerId = await h.playerIdByPublicId(s.store, p.publicId);
  return { ...p, playerId };
}

function usedUids(warehouse) {
  const used = new Set();
  for (const b of ['role', 'skill']) {
    for (const it of warehouse.buckets[b] || []) {
      for (const sl of it.slots || []) if (sl.pluginUid) used.add(sl.pluginUid);
    }
  }
  return used;
}

test('UWH-1 GET /me/warehouse 为真源（starter 已入档 + caps + usage）+ 401 负例', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uwh1');
    const unauth = await h.request(s.port, 'GET', '/api/v1/me/warehouse');
    assert.equal(unauth.status, 401, '未鉴权 → 401（不再是 404 warehouse_missing）');

    const r = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token));
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    const d = r.body.data;
    for (const b of BUCKETS) {
      assert.ok(Array.isArray(d.buckets[b]), `buckets.${b} 必须是数组`);
      assert.equal(d.caps[b], 500, `caps.${b} = service-config.warehouse.maxPerBucket`);
    }
    assert.equal(d.starterIssued, true, 'D-159：注册即发 starter');
    assert.equal(d.counts.role, 1, 'starter 恰 1 个角色');
    assert.equal(d.counts.skill, 3, 'starter 恰 3 个技能');
    assert.ok(d.counts.rolePlugin >= 1, 'starter 至少 1 个已装配的角色插件');
    assert.ok(d.counts.skillPlugin >= 1, 'starter 至少 1 个已装配的技能插件');
    assert.ok(d.usage && typeof d.usage === 'object', 'usage 必须存在');
  });
});

test('UWH-2 usage：出战配置引用的物品与插件都被标记为 slot1（同物品可被多配置引用）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uwh2');
    const cfg = await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(p.token));
    const slot1 = cfg.body.data.slots.find((x) => x.slotId === 'slot1');
    const ld = slot1.loadout;
    const wh = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token));
    const usage = wh.body.data.usage;

    assert.deepEqual(usage[ld.role.uid].slotIds, ['slot1'], '角色物品标记出战于 slot1');
    for (const sk of ld.skills) assert.deepEqual(usage[sk.uid].slotIds, ['slot1'], `技能 ${sk.uid} 标记 slot1`);
    const refs = [];
    for (const sl of ld.role.slots || []) if (sl.pluginUid) refs.push(sl.pluginUid);
    for (const sk of ld.skills) for (const sl of sk.slots || []) if (sl.pluginUid) refs.push(sl.pluginUid);
    assert.ok(refs.length >= 2, 'starter 应至少装了角色插件与技能插件各 1');
    for (const uid of refs) assert.deepEqual(usage[uid].slotIds, ['slot1'], `插件 ${uid} 标记 slot1`);

    // 同一物品被第二个配置引用 → usage 列出两个槽
    const r = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot2', { loadout: ld }, h.authed(p.token));
    assert.equal(r.status, 200, r.raw);
    const wh2 = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token));
    assert.deepEqual(wh2.body.data.usage[ld.role.uid].slotIds.sort(), ['slot1', 'slot2'], '同一物品被两个配置引用 → 两条记录');
  });
});

test('UWH-3 assemble/disassemble 正例：仓库与 usage 同步更新（记录可重演）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uwh3');
    // 先开箱拿到更多插件（starter 的插件都已装上）
    const box = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 30 }, h.authed(p.token));
    assert.equal(box.status, 200, box.raw);

    const wh0 = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    const cfg0 = (await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(p.token))).body.data;
    const slot1Uid = cfg0.slots.find((x) => x.slotId === 'slot1').loadout.role.uid;
    const used = usedUids(wh0.warehouse || wh0);
    // 找一个"有匹配空槽"的角色 + 匹配的未使用角色插件（优先出战配置里的那个角色，以便同时验证 usage）
    let target = null;
    const ordered = [...wh0.buckets.role].sort((a, b) => (a.uid === slot1Uid ? -1 : 0) - (b.uid === slot1Uid ? -1 : 0));
    for (const role of ordered) {
      const idx = (role.slots || []).findIndex((sl) => !sl.pluginUid);
      if (idx < 0) continue;
      const plugin = wh0.buckets.rolePlugin.find((x) => !used.has(x.uid) && x.slot === role.slots[idx].type);
      if (!plugin) continue;
      // 点数预算：装得上才算（core/items 的点数是硬约束）
      const usedPoints = (role.slots || []).reduce((sum, sl) => {
        if (!sl.pluginUid) return sum;
        const q = wh0.buckets.rolePlugin.find((x) => x.uid === sl.pluginUid);
        return sum + (q && Number.isFinite(q.pointCost) ? q.pointCost : 0);
      }, 0);
      if (usedPoints + (plugin.pointCost || 0) > (role.pluginPoints || 0)) continue;
      target = { role, idx, plugin };
      break;
    }
    assert.ok(target, '应能在开箱结果里找到"类型匹配且点数允许"的可装配组合');
    // usage 的语义是「该物品被哪个**出战配置**引用」：目标角色若正是出战配置用的那件 → 装配后应被标记；
    //   否则（开箱得到的、未被任何配置引用的物品）→ 不标记（这正是 usage 与"已装配"两个概念的区别）
    const targetInConfig = target.role.uid === slot1Uid;

    const asm = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: target.role.uid, pluginUid: target.plugin.uid, slotIndex: target.idx,
    }, h.authed(p.token));
    assert.equal(asm.status, 200, asm.raw);
    const after = asm.body.data.warehouse.buckets.role.find((x) => x.uid === target.role.uid);
    assert.equal(after.slots[target.idx].pluginUid, target.plugin.uid, '装配写入槽位引用');
    if (targetInConfig) {
      assert.ok(asm.body.data.usage[target.plugin.uid], 'usage 同步包含新装配的插件（目标在出战配置中）');
      assert.deepEqual(asm.body.data.usage[target.plugin.uid].slotIds, ['slot1']);
    } else {
      assert.equal(asm.body.data.usage[target.plugin.uid], undefined, '目标物品未被任何配置引用 → usage 不标记');
    }

    const dis = await h.request(s.port, 'POST', '/api/v1/me/warehouse/disassemble', {
      targetUid: target.role.uid, slotIndex: target.idx,
    }, h.authed(p.token));
    assert.equal(dis.status, 200, dis.raw);
    const after2 = dis.body.data.warehouse.buckets.role.find((x) => x.uid === target.role.uid);
    assert.equal(after2.slots[target.idx].pluginUid, null, '拆卸清空槽位引用');
    assert.equal(dis.body.data.usage[target.plugin.uid], undefined, '拆卸后 usage 不再标记该插件');
  });
});

test('UWH-4 装配拒绝：类型不符 409 slot_type_mismatch（玩家可读文案）；空槽拆卸 404 slot_empty', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uwh4');
    await h.request(s.port, 'POST', '/api/v1/me/box', { times: 30 }, h.authed(p.token));
    const wh = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    const used = usedUids(wh);

    // 目标槽：第一个有匹配类型插件的空槽；再找一个类型**不匹配**的插件
    let match = null;
    for (const role of wh.buckets.role) {
      const idx = (role.slots || []).findIndex((sl) => !sl.pluginUid);
      if (idx < 0) continue;
      const ok = wh.buckets.rolePlugin.find((x) => !used.has(x.uid) && x.slot === role.slots[idx].type);
      if (ok) { match = { role, idx, ok }; break; }
    }
    assert.ok(match, '需要一对匹配组合用于对照');
    const bad = wh.buckets.rolePlugin.find((x) => !used.has(x.uid) && x.slot !== match.role.slots[match.idx].type);
    if (bad) {
      const r = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
        targetUid: match.role.uid, pluginUid: bad.uid, slotIndex: match.idx,
      }, h.authed(p.token));
      assert.equal(r.status, 409, r.raw);
      assert.equal(r.body.error.code, 'slot_type_mismatch');
      assert.match(r.body.error.message, /不匹配|类型/, `文案应玩家可读（实际 ${r.body.error.message}）`);
    }

    // 空槽拆卸 → 404 slot_empty（core/items 口径）
    const emptyIdx = (match.role.slots || []).findIndex((sl) => !sl.pluginUid && sl.type !== match.ok.slot);
    if (emptyIdx >= 0) {
      const r2 = await h.request(s.port, 'POST', '/api/v1/me/warehouse/disassemble', {
        targetUid: match.role.uid, slotIndex: emptyIdx,
      }, h.authed(p.token));
      assert.equal(r2.status, 404, r2.raw);
      assert.equal(r2.body.error.code, 'slot_empty');
    }
  });
});

test('UWH-5 每桶上限 500：接近上限时超限请求 → 409 warehouse_full 且不入账', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uwh5');
    // 直接把档案仓库灌到 skillPlugin 499 件（走 store 层，避免 100 次开箱）
    const archiveMod = require('../../server/store/archive.js');
    await s.store.updateArchive(p.playerId, (a) => {
      const list = a.warehouse.buckets.skillPlugin;
      while (list.length < 499) {
        const n = list.length;
        list.push({ uid: `filler_${n}`, kind: 'skillPlugin', id: 'sp_mult', name: 'filler', slot: 'basic', quality: 'common', tier: 1, affixes: [] });
      }
      return null;
    });
    const before = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    assert.equal(before.counts.skillPlugin, 499);

    // 单个技能插件开箱：1 件 → 500 恰好允许；2 件 → 501 超限被拒
    const r = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 100 }, h.authed(p.token));
    // times=100 里技能插件数不可控 → 用"直接调用 grantBox"精确验证上限
    const item = { uid: 'over_1', kind: 'skillPlugin', id: 'sp_mult', name: 'x', slot: 'basic', quality: 'common', tier: 1, affixes: [] };
    const okFill = await s.store.grantBox({ playerId: p.playerId, seed: 1, tier: 'common', times: 1, items: [item] });
    assert.equal(okFill.counts.skillPlugin, 500, '第 500 件允许入账');
    await assert.rejects(
      () => s.store.grantBox({
        playerId: p.playerId, seed: 2, tier: 'common', times: 1,
        items: [{ ...item, uid: 'over_2' }],
      }),
      (err) => {
        assert.equal(err.code, 'warehouse_full', `超限错误码（实际 ${err.code}）`);
        assert.equal(err.status, 409);
        assert.ok(err.details.some((d) => d.path === 'warehouse.buckets.skillPlugin'));
        return true;
      },
    );
    const after = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    assert.equal(after.counts.skillPlugin, 500, '拒绝后计数不变（未写 journal）');
    assert.ok(r.status === 200 || r.status === 409, '前置开箱本身不受影响');
  });
});

test('UWH-7 闭环回归：开箱→装配（equipped 同步）→出战配置引用→实战→归档回放→拆卸→再装回', async () => {
  await h.withServer(null, async (s) => {
    // 两名玩家（quick/run 需要对手）
    const me = await freshPlayer(s, 'uwh7a');
    const foe = await h.register(s.port, h.uniqueName('uwh7b'));
    assert.equal(foe.status, 200);

    // ① 开箱补齐，并找一个"类型匹配 + 点数允许 + 未装配"的组合
    const box = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 40 }, h.authed(me.token));
    assert.equal(box.status, 200, box.raw);
    const wh0 = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(me.token))).body.data;
    const used = usedUids(wh0);
    let pick = null;
    for (const role of wh0.buckets.role) {
      const idx = (role.slots || []).findIndex((sl) => !sl.pluginUid);
      if (idx < 0) continue;
      const plugin = wh0.buckets.rolePlugin.find((x) => !used.has(x.uid) && x.slot === role.slots[idx].type);
      if (!plugin) continue;
      const usedPoints = (role.slots || []).reduce((sum, sl) => {
        if (!sl.pluginUid) return sum;
        const q = wh0.buckets.rolePlugin.find((x) => x.uid === sl.pluginUid);
        return sum + (q && Number.isFinite(q.pointCost) ? q.pointCost : 0);
      }, 0);
      if (usedPoints + (plugin.pointCost || 0) > (role.pluginPoints || 0)) continue;
      pick = { role, idx, plugin };
      break;
    }
    assert.ok(pick, '需要一对可装配组合');

    // ② 装配 → **插件的 equipped 必须置位**（loadout 校验用它判"插件未装配"）
    const asm = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: pick.role.uid, pluginUid: pick.plugin.uid, slotIndex: pick.idx,
    }, h.authed(me.token));
    assert.equal(asm.status, 200, asm.raw);
    const plugAfter = asm.body.data.warehouse.buckets.rolePlugin.find((x) => x.uid === pick.plugin.uid);
    assert.equal(plugAfter.equipped, true, 'D-159 回归：服务端装配必须把插件 equipped 置为 true');

    // ③ 用"装配后的角色物品"构造出战配置 → 必须保存成功（修前：插件未装配 → 409 loadout_invalid）
    const ld0 = (await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(me.token))).body.data.slots[0].loadout;
    const roleAssembled = asm.body.data.warehouse.buckets.role.find((r) => r.uid === pick.role.uid);
    const save = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot2', {
      loadout: { ...ld0, role: roleAssembled },
    }, h.authed(me.token));
    assert.equal(save.status, 200, `引用"服务端新装配插件"的配置必须可保存（实际 ${save.raw}）`);
    const act = await h.request(s.port, 'POST', '/api/v1/me/configs/slot2/activate', undefined, h.authed(me.token));
    assert.equal(act.status, 200, act.raw);

    // ④ 实战 + 归档回放重算（**不带 warehouse 保存的配置**也必须能重算：D-159-R1 回归）
    const quick = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 4242 }, h.authed(me.token));
    assert.equal(quick.status, 200, quick.raw);
    const replayId = quick.body.data.replayId;
    assert.match(replayId, /^b_/);
    const rep = await h.request(s.port, 'GET', `/api/v1/replay/${replayId}`, undefined, h.authed(me.token));
    assert.equal(rep.status, 200, `归档回放必须可重算（修前会 410 snapshot 无法实例化：${rep.raw}）`);
    assert.ok(rep.body.data.frames.length > 0);

    // ⑤ 拆卸 → **equipped 复位** → 同一插件可**再次装回**（修前：永久 409 plugin_equipped）
    const dis = await h.request(s.port, 'POST', '/api/v1/me/warehouse/disassemble', {
      targetUid: pick.role.uid, slotIndex: pick.idx,
    }, h.authed(me.token));
    assert.equal(dis.status, 200, dis.raw);
    const plugAfterDis = dis.body.data.warehouse.buckets.rolePlugin.find((x) => x.uid === pick.plugin.uid);
    assert.equal(plugAfterDis.equipped, false, 'D-159 回归：拆卸必须把插件 equipped 复位为 false');
    const re = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: pick.role.uid, pluginUid: pick.plugin.uid, slotIndex: pick.idx,
    }, h.authed(me.token));
    assert.equal(re.status, 200, `拆下的插件必须能再装回（实际 ${re.raw}）`);
  });
});

test('UWH-6 PUT /me/warehouse 退役为形状校验：引用不覆盖 → 200 + verified:false；形状非法 → 400', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uwh6');
    const shapeBad = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: { buckets: { role: 'x' } } }, h.authed(p.token));
    assert.equal(shapeBad.status, 400, '形状非法仍 400');
    assert.equal(shapeBad.body.error.code, 'bad_request');

    const empty = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', {
      warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
    }, h.authed(p.token));
    assert.equal(empty.status, 200, `D-159 起不再 409（实际 ${empty.raw}）`);
    assert.equal(empty.body.data.saved, true);
    assert.equal(empty.body.data.verified, false, '不覆盖出战配置引用 → verified:false（只记 warn）');
  });
});
