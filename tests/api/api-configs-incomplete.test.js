'use strict';
/* tests/api/api-configs-incomplete.test.js —— D-159（注册三槽）/ D-160（完整性校验时机）
 *
 * 契约：docs/frontend/03-hub-warehouse-loadout.md §1/§6/§8/§9.1/§9.2；docs/interfaces.md §2（/me/configs* 行）
 * 覆盖：
 *   UCI-1 注册即建满 3 槽：slot1 完整+快照+出战；slot2/slot3 为空槽（loadout 全 null、无快照）
 *   UCI-2 非出战槽可写不完整配置（200 + complete:false + missing + snapshot:null），且**重启后仍在**
 *   UCI-3 出战槽写不完整 → 409 loadout_invalid（details 逐位置、文案可读）
 *   UCI-4 activate 不完整 → 409 cannot_activate_incomplete（不是 500；details 逐位置）
 *   UCI-5 写完整 → 200（有快照）→ activate 200 且 activeSlotId 切换
 *   UCI-6 槽位上限：注册即 3 → 再建 409 slot_limit；删一个后可再建**空槽**
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

async function configs(s, p) {
  const r = await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(p.token));
  assert.equal(r.status, 200, r.raw);
  return r.body.data;
}

const EMPTY_LOADOUT = { role: null, skills: [null, null, null], ai: null };

// D-163（用户 2026-09-25 裁定：**一件物品同时只能被一份配置引用**）——slot2/slot3 不能复用 slot1（starter）
//   的物品，因此给玩家注入一套**独立 uid** 的备用物品，并从服务端权威仓库回读：
//   落盘的 loadout 正文恒为"仓库里那一份"的副本（D-163 起客户端正文的 stats/templateId 一律丢弃），
//   断言与回读件逐值比较才能反映真实落盘内容。
const SPARE = { role: 'uci_spare_role', skills: ['uci_spare_sk0', 'uci_spare_sk1', 'uci_spare_sk2'] };
// 从权威仓库回读备用物品（落盘正文 = 仓库副本 → 逐值断言必须拿仓库那一份做基准）；兼作"注入已持久"的前置检查。
async function readSpare(s, p) {
  const wh = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token));
  assert.equal(wh.status, 200, wh.raw);
  const role = wh.body.data.buckets.role.find((x) => x.uid === SPARE.role);
  const skills = SPARE.skills.map((uid) => wh.body.data.buckets.skill.find((x) => x.uid === uid));
  assert.ok(role && skills.every(Boolean), '备用物品必须已入档（前置断言）');
  return { role, skills };
}
async function injectSpare(s, p) {
  await s.store.updateArchive(p.playerId, (a) => {
    a.warehouse.buckets.role.push({
      uid: SPARE.role, kind: 'role', templateId: 'role_bal', name: '备用角色', quality: 'common',
      slotCount: 1, slots: [{ type: 'atk', pluginUid: null }],
      stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
      unlockTier: 'common', pluginPoints: 3,
    });
    for (const uid of SPARE.skills) {
      a.warehouse.buckets.skill.push({
        uid, kind: 'skill', templateId: 'skill_melee_whirl', name: `备用技能 ${uid}`, quality: 'common',
        slotCount: 1, slots: [{ type: 'basic', pluginUid: null }],
        params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 10 }, cooldown: 2, bulletLevel: 2 },
        unlockTier: 'common',
      });
    }
    return null;
  });
  return readSpare(s, p);
}

test('UCI-1 注册即建满 3 槽：slot1 完整出战 + slot2/3 空槽（无快照）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uci1');
    const d = await configs(s, p);
    assert.equal(d.maxSlots, 3);
    assert.deepEqual(d.slots.map((x) => x.slotId), ['slot1', 'slot2', 'slot3']);
    assert.equal(d.activeSlotId, 'slot1', '注册即出战 slot1（D-131 不变量：必有出战）');

    const s1 = d.slots[0];
    assert.equal(s1.isDefault, true);
    assert.ok(s1.snapshot && s1.snapshot.hash, 'slot1 有已冻结快照');
    assert.deepEqual(s1.loadout.skills.map((x) => !!x), [true, true, true], 'slot1 技能恰 3 个');
    assert.ok(s1.loadout.role && s1.loadout.role.uid, 'slot1 有角色');
    assert.ok(s1.loadout.ai && s1.loadout.ai.type === 'program', 'slot1 有 AI');
    assert.ok(s1.loadout.role.slots.length >= 1, 'D-159：starter 角色必带插槽（否则玩家无法装配）');

    for (const id of ['slot2', 'slot3']) {
      const slot = d.slots.find((x) => x.slotId === id);
      assert.equal(slot.isDefault, false);
      assert.deepEqual(slot.loadout, EMPTY_LOADOUT, `${id} 为空槽（5 个位置全空）`);
      assert.equal(slot.snapshot, null, `${id} 无快照（D-160 非出战槽允许不完整）`);
    }
  });
});

test('UCI-2 非出战槽可写不完整配置：200 + complete:false + missing + snapshot:null，且重启后仍在', async () => {
  const s1 = await h.startServer();
  const dataDir = s1.dataDir;
  let s2 = null;
  let p = null;
  try {
    // 阶段①：写不完整配置。**无条件**在 finally 关服（修前只在成功路径 close，UCI-2 一红就泄漏 HTTP
    //   服务器 → 整个 npm test 挂住不退出）；此处 close 而非 cleanup，因为阶段②要用同一数据根重启。
    try {
      p = await freshPlayer(s1, 'uci2');
      // D-163：slot2 不能复用 slot1 的物品（同物品跨配置引用 → 409 item_in_use）→ 用独立备用物品。
      const spare = await injectSpare(s1, p);
      // 只有角色 + 1 个技能 + 无 AI
      const partial = { role: spare.role, skills: [spare.skills[0], null, null], ai: null };
      const r = await h.request(s1.port, 'PUT', '/api/v1/me/configs/slot2', { loadout: partial }, h.authed(p.token));
      assert.equal(r.status, 200, `非出战槽允许不完整（实际 ${r.raw}）`);
      assert.equal(r.body.data.complete, false);
      assert.deepEqual(r.body.data.missing, ['skills[1]', 'skills[2]', 'ai']);
      assert.equal(r.body.data.snapshot, null, '不完整配置不冻结快照（K-2 建议）');
      assert.equal(r.body.data.activeSlotId, 'slot1', '写非出战槽不改变出战配置');

      // 状态行/槽 brief 也要反映"非出战"
      const listed = r.body.data.slots.find((x) => x.slotId === 'slot2');
      assert.equal(listed.isDefault, false);
    } finally {
      await s1.close();
    }

    // 重启（同一数据根）：不完整配置必须持久（走 journal 的 loadout 正文，而不是客户端内存）
    s2 = await h.startServer({ dataDir });
    const spare = await readSpare(s2, p); // 同一数据根 → 注入的备用物品跨重启仍在（不强加第二次注入）
    const partial = { role: spare.role, skills: [spare.skills[0], null, null], ai: null };
    const d = await configs(s2, p);
    const slot2 = d.slots.find((x) => x.slotId === 'slot2');
    // D-163：落盘正文是**权威仓库副本**解析后的形状 —— resolveItems 恒定补出 `aiId`（缺省 null）。
    assert.deepEqual(slot2.loadout, { ...partial, aiId: null }, '重启后不完整配置逐值仍在');
    assert.equal(slot2.snapshot, null);
    assert.equal(d.slots.find((x) => x.slotId === 'slot3').loadout.role, null, '未动过的槽仍为空');
  } finally {
    // 阶段②起服失败/断言失败同样不泄漏；s2 缺席时直接清掉数据根（s1 已在阶段①关闭）。
    if (s2) await s2.cleanup();
    else h.removeTempDir(dataDir);
  }
});

test('UCI-3 出战槽写不完整 → 409 loadout_invalid（details 逐位置、文案可读）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uci3');
    const r = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', { loadout: EMPTY_LOADOUT }, h.authed(p.token));
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error.code, 'loadout_invalid');
    const msgs = r.body.error.details.map((d) => d.message);
    assert.ok(msgs.includes('缺少角色物品'), `details 含角色缺失（实际 ${JSON.stringify(msgs)}）`);
    assert.ok(msgs.includes('技能位置缺失: 0'));
    assert.ok(msgs.includes('缺少 AI 程序'));
    for (const d of r.body.error.details) assert.equal(d.code, 'loadout_invalid');

    // 出战配置未被破坏
    const ld = (await configs(s, p)).slots[0].loadout;
    assert.ok(ld.role && ld.ai, '被拒的写入不得改动出战配置');
  });
});

test('UCI-4 activate 不完整 → 409 cannot_activate_incomplete（不是 500）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uci4');
    const r = await h.request(s.port, 'POST', '/api/v1/me/configs/slot2/activate', undefined, h.authed(p.token));
    assert.equal(r.status, 409, `HTTP 码必须是 409（STATUS_BY_CODE 登记；实际 ${r.raw}）`);
    assert.equal(r.body.error.code, 'cannot_activate_incomplete');
    assert.match(r.body.error.message, /不完整/);
    const msgs = r.body.error.details.map((d) => d.message);
    assert.ok(msgs.includes('缺少角色物品'));
    assert.ok(msgs.includes('缺少 AI 程序'));
    for (const d of r.body.error.details) assert.equal(d.code, 'cannot_activate_incomplete');

    const d = await configs(s, p);
    assert.equal(d.activeSlotId, 'slot1', '失败后出战配置不变');

    // 只补上角色仍不够（还缺 3 技能与 AI）→ 依旧拒绝，且 details 只剩确实缺的位置
    // D-163（用户 2026-09-25 裁定：一件物品同时只能被一份配置引用）：不能借 slot1 的角色（→ 409 item_in_use），
    //   改用独立备用角色；本用例只关心"补上的位置不再报缺失"，物品是否与 slot1 相同无关紧要。
    const spare = await injectSpare(s, p);
    const put = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot2', { loadout: { ...EMPTY_LOADOUT, role: spare.role } }, h.authed(p.token));
    assert.equal(put.status, 200, `补角色（非出战槽允许不完整）：${put.raw}`);
    const again = await h.request(s.port, 'POST', '/api/v1/me/configs/slot2/activate', undefined, h.authed(p.token));
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'cannot_activate_incomplete');
    assert.equal(again.body.error.details.some((x) => x.message === '缺少角色物品'), false, '已补的位置不再出现在 details');
  });
});

test('UCI-5 写完整配置 → 200（有快照）→ activate 200 且 activeSlotId 切换', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uci5');
    const ld = (await configs(s, p)).slots[0].loadout;
    // D-163（一件物品同时只能被一份配置引用）：slot3 用独立备用物品 + slot1 的 AI 程序（AI 不参与独占判定）
    const spare = await injectSpare(s, p);
    const full = { role: spare.role, skills: spare.skills, ai: ld.ai };
    const save = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot3', { loadout: full }, h.authed(p.token));
    assert.equal(save.status, 200, save.raw);
    assert.equal(save.body.data.complete, true);
    assert.deepEqual(save.body.data.missing, []);
    assert.ok(save.body.data.snapshot && save.body.data.snapshot.hash, '完整配置必然冻结快照');
    assert.equal(save.body.data.activeSlotId, 'slot1', 'PUT 不自动切换出战');

    const act = await h.request(s.port, 'POST', '/api/v1/me/configs/slot3/activate', undefined, h.authed(p.token));
    assert.equal(act.status, 200, act.raw);
    assert.equal(act.body.data.activeSlotId, 'slot3');
    assert.ok(act.body.data.activeSnapshotHash, 'activeSnapshotHash 同步');

    // 出战槽此时是 slot3：再写不完整 → 409（出战必须完整）
    const bad = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot3', { loadout: EMPTY_LOADOUT }, h.authed(p.token));
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, 'loadout_invalid');
  });
});

test('UCI-6 槽位上限与建空槽：注册即 3 → POST 409 slot_limit；删一个后可再建空槽', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'uci6');
    const over = await h.request(s.port, 'POST', '/api/v1/me/configs', { name: '第四套' }, h.authed(p.token));
    assert.equal(over.status, 409, over.raw);
    assert.equal(over.body.error.code, 'slot_limit');

    const del = await h.request(s.port, 'DELETE', '/api/v1/me/configs/slot3', undefined, h.authed(p.token));
    assert.equal(del.status, 200, del.raw);
    const created = await h.request(s.port, 'POST', '/api/v1/me/configs', { name: '新槽' }, h.authed(p.token));
    assert.equal(created.status, 200, created.raw);
    assert.equal(created.body.data.slotId, 'slot3', '空出的 id 被复用');
    assert.deepEqual(created.body.data.slot.loadout, EMPTY_LOADOUT, 'D-160：新建槽是**空槽**（不再复制出战配置）');
    assert.equal(created.body.data.snapshot, null, '空槽无快照');
    assert.equal(created.body.data.activeSlotId, 'slot1', '建槽不切换出战');

    // 默认槽与出战槽不可删
    const delDefault = await h.request(s.port, 'DELETE', '/api/v1/me/configs/slot1', undefined, h.authed(p.token));
    assert.equal(delDefault.status, 409);
    assert.equal(delDefault.body.error.code, 'slot_locked');
  });
});
