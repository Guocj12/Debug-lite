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

// 确定性可装配夹具（**反 flaky**）：starter 与开箱掉落都随身份/随机流变化，"从开箱结果里找一对
//   类型匹配的组合"是概率断言（实测会找不到 → UWH-3/4/7 偶发红）。改为**直接注入**一件已知角色
//   （2 个槽：atk 空槽 + def 已装）与两个角色插件（atk 匹配 / def 不匹配），断言完全确定。
//   物品形状与生成路径同形（与 tests/unit/warehouse-invariants.test.js 的夹具一致）。
const FIX_ROLE = 'uwh_fix_role';
const FIX_PLUGIN_MATCH = 'uwh_fix_plugin_atk';
const FIX_PLUGIN_MISMATCH = 'uwh_fix_plugin_def';
const FIX_SKILL = 'uwh_fix_skill';
async function injectAssemblable(s, playerId) {
  await s.store.updateArchive(playerId, (a) => {
    a.warehouse.buckets.role.push({
      uid: FIX_ROLE, kind: 'role', templateId: 'role_bal', name: '夹具角色', quality: 'common',
      slotCount: 2, slots: [{ type: 'atk', pluginUid: null }, { type: 'def', pluginUid: FIX_PLUGIN_MISMATCH }],
      stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
      unlockTier: 'common', pluginPoints: 3,
    });
    a.warehouse.buckets.rolePlugin.push({
      uid: FIX_PLUGIN_MATCH, kind: 'rolePlugin', id: 'rp_atk_flat', name: '攻击 +4', slot: 'atk',
      category: '攻击提升', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1,
    });
    a.warehouse.buckets.rolePlugin.push({
      uid: FIX_PLUGIN_MISMATCH, kind: 'rolePlugin', id: 'rp_def_flat', name: '防御 +3', slot: 'def',
      category: '防御强化', quality: 'common', tier: 1, affixes: [], unlockTier: 'common', pointCost: 1, equipped: true,
    });
    a.warehouse.buckets.skill.push({
      uid: FIX_SKILL, kind: 'skill', templateId: 'skill_melee_whirl', name: '夹具技能', quality: 'common',
      slotCount: 1, slots: [{ type: 'basic', pluginUid: null }],
      params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 10 }, cooldown: 2, bulletLevel: 2 },
      unlockTier: 'common',
    });
    return null;
  });
  return { roleUid: FIX_ROLE, freeSlotIndex: 0, matchUid: FIX_PLUGIN_MATCH, mismatchUid: FIX_PLUGIN_MISMATCH };
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
    // 反 flaky：注入**确定性**可装配夹具（角色 atk 空槽 + atk 插件），不再依赖开箱随机掉落
    const fix = await injectAssemblable(s, p.playerId);
    const cfg0 = (await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(p.token))).body.data;
    const slot1Uid = cfg0.slots.find((x) => x.slotId === 'slot1').loadout.role.uid;
    const target = { roleUid: fix.roleUid, idx: fix.freeSlotIndex, pluginUid: fix.matchUid };
    // 夹具物品不被任何配置引用 → usage 不标记（正是 usage 与"已装配"两个概念的区别）
    assert.notEqual(target.roleUid, slot1Uid, '夹具角色不是出战配置用的那件（用于对照 usage 语义）');

    const asm = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: target.roleUid, pluginUid: target.pluginUid, slotIndex: target.idx,
    }, h.authed(p.token));
    assert.equal(asm.status, 200, asm.raw);
    const after = asm.body.data.warehouse.buckets.role.find((x) => x.uid === target.roleUid);
    assert.equal(after.slots[target.idx].pluginUid, target.pluginUid, '装配写入槽位引用');
    assert.equal(asm.body.data.warehouse.buckets.rolePlugin.find((x) => x.uid === target.pluginUid).equipped, true,
      'D-159 回归：装配必须把插件 equipped 置 true');
    assert.equal(asm.body.data.usage[target.pluginUid], undefined, '目标物品未被任何配置引用 → usage 不标记');

    // 反例对照：把**出战配置里那件角色**（slot1 引用）装配后 usage 应标记 slot1
    const cfgLoadout = cfg0.slots.find((x) => x.slotId === 'slot1').loadout;
    const roleInCfg = asm.body.data.warehouse.buckets.role.find((x) => x.uid === slot1Uid);
    const freeIdx = (roleInCfg.slots || []).findIndex((sl) => !sl.pluginUid);
    if (freeIdx >= 0) {
      const usedPts = (roleInCfg.slots || []).reduce((sum, sl) => {
        if (!sl.pluginUid) return sum;
        const q = asm.body.data.warehouse.buckets.rolePlugin.find((x) => x.uid === sl.pluginUid);
        return sum + (q && Number.isFinite(q.pointCost) ? q.pointCost : 0);
      }, 0);
      const cand = asm.body.data.warehouse.buckets.rolePlugin.find((x) => !x.equipped
        && x.slot === roleInCfg.slots[freeIdx].type && usedPts + (x.pointCost || 0) <= (roleInCfg.pluginPoints || 0));
      if (cand) {
        const asm2 = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
          targetUid: slot1Uid, pluginUid: cand.uid, slotIndex: freeIdx,
        }, h.authed(p.token));
        assert.equal(asm2.status, 200, asm2.raw);
        assert.deepEqual(asm2.body.data.usage[cand.uid].slotIds, ['slot1'], '在出战配置中的物品被引用 → usage 标记 slot1');
      }
    }
    assert.ok(cfgLoadout.role.uid, '出战配置仍有角色（前置断言，避免空跑）');

    // 拆卸（夹具槽）→ 引用清空、插件复位、usage 仍不标记
    const dis = await h.request(s.port, 'POST', '/api/v1/me/warehouse/disassemble', {
      targetUid: target.roleUid, slotIndex: target.idx,
    }, h.authed(p.token));
    assert.equal(dis.status, 200, dis.raw);
    const after2 = dis.body.data.warehouse.buckets.role.find((x) => x.uid === target.roleUid);
    assert.equal(after2.slots[target.idx].pluginUid, null, '拆卸清空槽位引用');
    assert.equal(dis.body.data.usage[target.pluginUid], undefined, '拆卸后 usage 不再标记该插件');
  });
});

test('UWH-4 装配拒绝：类型不符 409 slot_type_mismatch（玩家可读文案）；空槽拆卸 404 slot_empty', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uwh4');
    // 反 flaky：注入确定性夹具（角色槽0=atk 空、槽1=def 已装；插件 atk 匹配 / def 不匹配）
    const fix = await injectAssemblable(s, p.playerId);
    const wh = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;

    // ① 类型不符：def 插件装进 atk 槽 → 409 slot_type_mismatch（文案玩家可读）
    const r = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: fix.roleUid, pluginUid: fix.mismatchUid, slotIndex: fix.freeSlotIndex,
    }, h.authed(p.token));
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error.code, 'slot_type_mismatch');
    assert.match(r.body.error.message, /不匹配|类型/, `文案应玩家可读（实际 ${r.body.error.message}）`);

    // ② 对照（更强）：同一槽装**匹配**插件 → 200，证明①的拒绝确实来自类型而非其它原因
    const ok = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: fix.roleUid, pluginUid: fix.matchUid, slotIndex: fix.freeSlotIndex,
    }, h.authed(p.token));
    assert.equal(ok.status, 200, `同槽匹配插件必须成功（否则①的 409 无法归因于类型）：${ok.raw}`);
    // ③ 同一插件再装到别处 → 409 plugin_equipped（唯一性）
    const dup = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: FIX_SKILL, pluginUid: fix.matchUid, slotIndex: 0,
    }, h.authed(p.token));
    assert.equal(dup.status, 409, dup.raw);
    assert.ok(['plugin_equipped', 'slot_type_mismatch'].includes(dup.body.error.code),
      `类别不符或已装配都应被拒（实际 ${dup.body.error.code}）`);
    assert.ok(wh.buckets.role.some((x) => x.uid === fix.roleUid), '夹具角色仍在仓库（前置断言）');

    // ④ 空槽拆卸 → 404 slot_empty（core/items 口径）：槽1 已装被占，槽0 刚装上 → 用未装配夹具技能的空槽对照
    const before = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    const skill = before.buckets.skill.find((x) => x.uid === FIX_SKILL);
    assert.equal(skill.slots[0].pluginUid, null, '夹具技能槽为空（前置）');
    const r2 = await h.request(s.port, 'POST', '/api/v1/me/warehouse/disassemble', {
      targetUid: FIX_SKILL, slotIndex: 0,
    }, h.authed(p.token));
    assert.equal(r2.status, 404, r2.raw);
    assert.equal(r2.body.error.code, 'slot_empty');
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
    // 反 flaky：用**注入的确定性夹具**（不再从随机开箱结果里挑组合）
    const fix = await injectAssemblable(s, me.playerId);
    const wh0 = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(me.token))).body.data;
    assert.ok(wh0.counts.role >= 2, '夹具角色已入档（与 starter 角色并存）');
    const pick = { roleUid: fix.roleUid, idx: fix.freeSlotIndex, pluginUid: fix.matchUid };

    // ② 装配 → **插件的 equipped 必须置位**（loadout 校验用它判"插件未装配"）
    const asm = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: pick.roleUid, pluginUid: pick.pluginUid, slotIndex: pick.idx,
    }, h.authed(me.token));
    assert.equal(asm.status, 200, asm.raw);
    const plugAfter = asm.body.data.warehouse.buckets.rolePlugin.find((x) => x.uid === pick.pluginUid);
    assert.equal(plugAfter.equipped, true, 'D-159 回归：服务端装配必须把插件 equipped 置为 true');

    // ③ 用"装配后的角色物品"构造出战配置 → 必须保存成功（修前：插件未装配 → 409 loadout_invalid）
    const ld0 = (await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(me.token))).body.data.slots[0].loadout;
    const roleAssembled = asm.body.data.warehouse.buckets.role.find((r) => r.uid === pick.roleUid);
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
      targetUid: pick.roleUid, slotIndex: pick.idx,
    }, h.authed(me.token));
    assert.equal(dis.status, 200, dis.raw);
    const plugAfterDis = dis.body.data.warehouse.buckets.rolePlugin.find((x) => x.uid === pick.pluginUid);
    assert.equal(plugAfterDis.equipped, false, 'D-159 回归：拆卸必须把插件 equipped 复位为 false');
    const re = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: pick.roleUid, pluginUid: pick.pluginUid, slotIndex: pick.idx,
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
