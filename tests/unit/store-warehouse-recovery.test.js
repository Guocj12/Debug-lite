'use strict';
/* tests/unit/store-warehouse-recovery.test.js —— D-159/D-161 新记录类型的**崩溃恢复/重放**正确性
 *
 * 为什么必须有这条：新记录（`account.created` 携带 starter 仓库、`box.opened`、`warehouse.assemble`/
 *   `disassemble`、`ai.created`/`ai.deleted`）承载的是**状态量**。journal 是唯一真源 —— 档案文件丢失后
 *   必须能**只靠 journal 重放**把仓库与 AI 库重建出来（`store.rebuildArchive` 就是这条路径）。
 *   本测试同时验证：含状态量记录的 journal 段**不参与 compact**（真源不被压掉）。
 *
 * 断言意图：
 *   WR-1 档案文件丢失后 `rebuildArchive` → 仓库逐值恢复（starter + 开箱 + 装配结果）
 *   WR-2 AI 库经重放恢复（含 starter 默认 AI 与玩家自建条目）
 *   WR-3 重复重放幂等：再 rebuild 一次结果不变（`grantIds`/`isRecordApplied` 生效）
 *   WR-4 compact 保护：含状态量记录的段被跳过（`store.journal.compact.skip`），重放后仓库不缩水
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');

const BUCKETS = ['role', 'skill', 'rolePlugin', 'skillPlugin'];

function countsOf(warehouse) {
  const out = {};
  for (const b of BUCKETS) out[b] = (warehouse.buckets[b] || []).length;
  return out;
}

// 仓库内容的稳定指纹（uid → 该物品的槽位引用与关键身份字段），用于"逐值恢复"比较
function fingerprint(warehouse) {
  const out = {};
  for (const b of BUCKETS) {
    for (const it of warehouse.buckets[b] || []) {
      out[`${b}:${it.uid}`] = {
        kind: it.kind, templateId: it.templateId || null, id: it.id || null,
        quality: it.quality, tier: it.tier === undefined ? null : it.tier,
        pointCost: it.pointCost === undefined ? null : it.pointCost,
        slots: (it.slots || []).map((s) => `${s.type}|${s.pluginUid === undefined ? '' : s.pluginUid}`),
        stats: it.stats || null,
      };
    }
  }
  return out;
}

async function freshPlayer(s, tag) {
  const p = await h.register(s.port, h.uniqueName(tag));
  assert.equal(p.status, 200, JSON.stringify(p.res && p.res.body));
  const playerId = await h.playerIdByPublicId(s.store, p.publicId);
  return { ...p, playerId };
}

test('WR-1/WR-2 档案丢失后仅靠 journal 重放即可恢复仓库与 AI 库（D-159/D-161）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'wr1');

    // 造出"三种来源"的状态：starter（account.created 携带）+ 开箱（box.opened）+ 装配（warehouse.assemble）
    const box = await h.request(s.port, 'POST', '/api/v1/me/box', { times: 30 }, h.authed(p.token));
    assert.equal(box.status, 200, box.raw);
    const before = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;

    const used = new Set();
    for (const b of ['role', 'skill']) {
      for (const it of before.buckets[b]) for (const sl of it.slots || []) if (sl.pluginUid) used.add(sl.pluginUid);
    }
    let target = null;
    for (const role of before.buckets.role) {
      const idx = (role.slots || []).findIndex((sl) => !sl.pluginUid);
      if (idx < 0) continue;
      const plugin = before.buckets.rolePlugin.find((x) => !used.has(x.uid) && x.slot === role.slots[idx].type);
      if (!plugin) continue;
      const usedPoints = (role.slots || []).reduce((sum, sl) => {
        if (!sl.pluginUid) return sum;
        const q = before.buckets.rolePlugin.find((x) => x.uid === sl.pluginUid);
        return sum + (q && Number.isFinite(q.pointCost) ? q.pointCost : 0);
      }, 0);
      if (usedPoints + (plugin.pointCost || 0) > (role.pluginPoints || 0)) continue;
      target = { role, idx, plugin };
      break;
    }
    assert.ok(target, '需要一对可装配组合用于验证 warehouse.assemble 的重放');
    const asm = await h.request(s.port, 'POST', '/api/v1/me/warehouse/assemble', {
      targetUid: target.role.uid, pluginUid: target.plugin.uid, slotIndex: target.idx,
    }, h.authed(p.token));
    assert.equal(asm.status, 200, asm.raw);
    const asmState = asm.body.data.warehouse;

    // 自建一条 AI（`ai.created` 的重放）
    const ld = (await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(p.token))).body.data.slots[0].loadout;
    const created = await h.request(s.port, 'POST', '/api/v1/me/ai', { name: '重放AI', program: ld.ai }, h.authed(p.token));
    assert.equal(created.status, 200, created.raw);

    const beforeWh = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    const beforeAi = (await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(p.token))).body.data;
    const fpBefore = fingerprint(asmState);

    assert.deepEqual(countsOf(asmState), beforeWh.counts, '前置：装配不改变件数');

    // 模拟"档案文件丢失"：rebuildArchive 会以 null 档案启动该玩家的 journal 重放
    const rebuilt = await s.store.rebuildArchive(p.playerId);
    assert.ok(rebuilt, '重放后仍得到档案');

    const afterWh = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    const afterAi = (await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(p.token))).body.data;

    assert.deepEqual(afterWh.counts, beforeWh.counts, `重放后每桶件数一致（before ${JSON.stringify(beforeWh.counts)}）`);
    assert.equal(afterWh.starterIssued, true, 'starterIssued 由 account.created 重放恢复');
    assert.deepEqual(fingerprint(afterWh), fpBefore, '仓库逐值恢复（含装配后的槽位引用）');
    assert.deepEqual(
      afterAi.items.map((x) => `${x.name}:${x.aiId}`).sort(),
      beforeAi.items.map((x) => `${x.name}:${x.aiId}`).sort(),
      'AI 库经 ai.created 重放恢复（含 starter 默认 AI）',
    );
    assert.equal(afterAi.max, beforeAi.max);
  });
});

test('WR-3 重复重放幂等：再 rebuild 一次结果逐值不变（grantIds 环形窗口 + 内容键生效）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'wr3');
    await h.request(s.port, 'POST', '/api/v1/me/box', { times: 10 }, h.authed(p.token));
    await s.store.rebuildArchive(p.playerId);
    const first = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    await s.store.rebuildArchive(p.playerId);
    const second = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    assert.deepEqual(second.counts, first.counts, '重复重放不得重复发放（否则会翻倍）');
    assert.deepEqual(fingerprint(second), fingerprint(first), '逐值一致');
    const stats = s.store.stats();
    assert.equal(stats.reapplied, 0, `正常重放不应出现"水位缺口补 apply"（实际 ${stats.reapplied}）`);
  });
});

test('WR-4 compact 保护：含状态量记录的 journal 段被跳过（真源不被压掉）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'wr4');
    await h.request(s.port, 'POST', '/api/v1/me/box', { times: 5 }, h.authed(p.token));
    const before = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;

    // 强制压缩：把"现在"推到 70 天后再取整月，使**当前月段**落在 cutoff 之前；并显式给出
    //   appliedSeq（默认取派生索引水位，A 类写路径下它可能滞后 → 段会先被"未物化"挡掉，测不到
    //   NON_COMPACTABLE 分支）。
    const far = Date.now() + 70 * 86400000;
    const res = await s.store.compactJournal({ retentionDays: 0, at: far, appliedSeq: s.store.maxSeq() });
    const monthKey = new Date().toISOString().slice(0, 7);
    assert.equal(res.compacted.includes(monthKey), false,
      `含 box.opened 的段不得被压缩（实际 compacted=${JSON.stringify(res.compacted)}）`);
    assert.equal(res.compacted.length, 0, `本测试只有当前月段 → 不得压缩任何段（实际 ${JSON.stringify(res.compacted)}）`);
    assert.ok(s.logger.records.some((r) => r.event === 'store.journal.compact.skip'),
      '必须留下可观测的 skip 日志（store.journal.compact.skip）');

    // 压缩后真源仍在 → 重放后仓库不缩水
    await s.store.rebuildArchive(p.playerId);
    const after = (await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token))).body.data;
    assert.deepEqual(after.counts, before.counts, '重放后件数不缩水');
  });
});
