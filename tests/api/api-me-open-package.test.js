'use strict';
/* tests/api/api-me-open-package.test.js —— D-176/D-177：战斗掉落包 + 仓库开包端点
 *
 * 契约：docs/interfaces.md §2（/me/warehouse/open-package）、§2.1（package_invalid）；docs/content-design.md §10
 * 覆盖：
 *   OP-1 快速对战返回 `drops`（字段恒在；幂等重放不重复发放；包品质 = 玩家段位）
 *   OP-2 开包成功：包被消耗 + 物品入桶 + counts 同步 + seed 回带
 *   OP-3 负例：401 / 400 bad_request（缺参、空数组、重复、超上限）/ 409 package_invalid（不在仓库）
 *   OP-4 AI 节点包：200 + items:[] + notice:'package_reserved'（**不报错**，包被消耗）
 *   OP-5 仓库满：产出超上限 → 409 warehouse_full 且**原子**（包未被消耗、journal 不落）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');
const cfg = require('../../server/data/package-config.json');

const QUIET = { level: 'error' };

async function freshPlayer(s, tag) {
  const p = await h.register(s.port, h.uniqueName(tag));
  assert.equal(p.status, 200, JSON.stringify(p.res && p.res.body));
  const playerId = await h.playerIdByPublicId(s.store, p.publicId);
  return { ...p, playerId };
}

// 直接注入一个包（走 store 真源；不依赖战斗随机）
async function injectPackage(s, playerId, pkg) {
  await s.store.updateArchive(playerId, (a) => {
    a.warehouse.buckets.package.push(pkg);
    return null;
  });
}

const PKG = (uid, extra) => ({
  uid, kind: 'package', packageKind: 'role', name: '角色模块包', quality: 'common', qualityPercent: 15, ...(extra || {}),
});

test('OP-1 快速对战掉落：drops 字段恒在、幂等重放不重复发放、品质=玩家段位', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'opa');
    await freshPlayer(s, 'opb');
    const before = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(a.token));
    const beforePkg = before.body.data.counts.package; // starter 1 个（D-176 新手引导包）
    const first = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 424242 }, h.authed(a.token));
    assert.equal(first.status, 200, first.raw);
    const d1 = first.body.data;
    assert.ok(Array.isArray(d1.drops), 'drops 必须恒为数组（前端契约 FC-1）');
    assert.equal(d1.duplicate, false);
    for (const p of d1.drops) {
      assert.equal(p.kind, 'package');
      assert.equal(p.quality, 'common', '包品质 = 玩家当前段位');
      assert.ok(cfg.qualityPercentBands.common.includes(p.qualityPercent));
      assert.equal(typeof p.uid, 'string');
      assert.ok(d1.drops.length <= 2, '单场最多掉 2 个包');
    }
    const wh1 = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(a.token));
    assert.equal(wh1.body.data.counts.package, beforePkg + d1.drops.length, '掉落已入服务端仓库');
    // 幂等：同 seed 重放 → duplicate:true、drops 相同、仓库包数不变（不重复发放）
    const second = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 424242 }, h.authed(a.token));
    assert.equal(second.status, 200, second.raw);
    assert.equal(second.body.data.duplicate, true);
    assert.deepEqual(second.body.data.drops, d1.drops, '同一场得到同一批包（确定性）');
    const wh2 = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(a.token));
    assert.equal(wh2.body.data.counts.package, beforePkg + d1.drops.length, '幂等重放不得重复发放');
    // 日志：quick.droppackage（通道 ranked，首段 quick）—— 本用例**需要 info 级记录**，故不套 QUIET
    if (d1.drops.length > 0) {
      assert.ok(s.logger.records.some((x) => x.event === 'quick.droppackage'), '掉落应记日志');
    }
  });
});

test('OP-2 开包成功：消耗包 + 物品入桶 + counts 同步', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'opc');
    await injectPackage(s, a.playerId, PKG('pkg_test_1'));
    await injectPackage(s, a.playerId, PKG('pkg_test_2'));
    const before = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(a.token));
    const beforeRole = before.body.data.counts.role;
    const beforePkg = before.body.data.counts.package;
    assert.equal(beforePkg, 3, '前置：starter 1 个包 + 注入 2 个');
    const r = await h.request(s.port, 'POST', '/api/v1/me/warehouse/open-package',
      { packageUids: ['pkg_test_1'] }, h.authed(a.token));
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    assert.ok(Number.isInteger(d.seed) && d.seed >= 1, 'seed 回带（服务端独占随机性，D-162 口径）');
    assert.equal(d.opened.length, 1);
    assert.equal(d.opened[0].packageUid, 'pkg_test_1');
    assert.equal(d.opened[0].packageKind, 'role');
    assert.ok(d.opened[0].items.length >= 1 && d.opened[0].items.length <= 3, '单包 1~3 件');
    assert.equal(d.items.length, d.opened[0].items.length);
    assert.equal(d.counts.package, beforePkg - 1, '被开的包已从仓库移除');
    assert.equal(d.counts.role, beforeRole + d.items.length, '产出物品入角色桶');
    assert.ok(!d.notice, '非保留包不带 notice');
    // 回读一致
    const after = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(a.token));
    assert.equal(after.body.data.counts.package, beforePkg - 1);
    assert.equal(after.body.data.counts.role, beforeRole + d.items.length);
    assert.ok(after.body.data.buckets.package.some((p) => p.uid === 'pkg_test_2'));
  }, QUIET);
});

test('OP-3 负例：401 / 400 / 409 package_invalid', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'opd');
    const noAuth = await h.request(s.port, 'POST', '/api/v1/me/warehouse/open-package', { packageUids: ['x'] });
    assert.equal(noAuth.status, 401);
    const cases = [
      [{}, 'bad_request'],
      [{ packageUids: [] }, 'bad_request'],
      [{ packageUids: 'x' }, 'bad_request'],
      [{ packageUids: [1] }, 'bad_request'],
      [{ packageUids: ['a', 'a'] }, 'bad_request'],
    ];
    for (const [body, code] of cases) {
      const r = await h.request(s.port, 'POST', '/api/v1/me/warehouse/open-package', body, h.authed(a.token));
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(r.body.error.code, code);
    }
    const many = await h.request(s.port, 'POST', '/api/v1/me/warehouse/open-package',
      { packageUids: Array.from({ length: 101 }, (_, i) => `p${i}`) }, h.authed(a.token));
    assert.equal(many.status, 400);
    const missing = await h.request(s.port, 'POST', '/api/v1/me/warehouse/open-package',
      { packageUids: ['pkg_nope'] }, h.authed(a.token));
    assert.equal(missing.status, 409);
    assert.equal(missing.body.error.code, 'package_invalid');
    // 目标不是包（伪造成 role 物品的 uid）→ 同样 409
    await s.store.updateArchive(a.playerId, (ar) => {
      ar.warehouse.buckets.role.push({ uid: 'not_a_pkg', kind: 'role', templateId: 'role_bal', quality: 'common', slots: [], pluginPoints: 0 });
      return null;
    });
    const wrong = await h.request(s.port, 'POST', '/api/v1/me/warehouse/open-package',
      { packageUids: ['not_a_pkg'] }, h.authed(a.token));
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.error.code, 'package_invalid');
  }, QUIET);
});

test('OP-4 AI 节点包：200 + 零产出 + notice（保留包，不报错）', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'ope');
    const b0 = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(a.token));
    const beforePkg = b0.body.data.counts.package;
    await injectPackage(s, a.playerId, PKG('pkg_ai_1', { packageKind: 'aiNode', name: 'AI节点包' }));
    const r = await h.request(s.port, 'POST', '/api/v1/me/warehouse/open-package',
      { packageUids: ['pkg_ai_1'] }, h.authed(a.token));
    assert.equal(r.status, 200, r.raw);
    assert.deepEqual(r.body.data.items, [], '保留包零产出');
    assert.equal(r.body.data.opened[0].notice, 'package_reserved');
    assert.equal(r.body.data.notice, 'package_reserved', '顶层也回带提示（便于前端直接显示）');
    assert.equal(r.body.data.counts.package, beforePkg, '保留包仍被消耗（用户裁定：静默消耗 + 提示）');
  }, QUIET);
});

test('OP-6 掉落发放原语：grantPackages 真入桶（package.granted 用 packages 字段）+ grantId 幂等', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'opg');
    const before = await s.store.getWarehouse(a.playerId);
    const itemsMod = require('../../server/core/items.js');
    const pkg = itemsMod.generatePackage({
      packageKind: 'role', quality: 'common', qualityPercent: 15, uid: 'pkg_grant_fix_1',
    });
    const grantId = 'pk_fixture_1';
    const r = await s.store.grantPackages({
      playerId: a.playerId, packages: [pkg], source: 'quick', battleId: 'b_fixture', grantId,
    });
    assert.equal(r.counts.package, before.counts.package + 1, '掉落必须真的入档（package.granted 记录用 packages 字段）');
    assert.ok(r.warehouse.buckets.package.some((p) => p.uid === 'pkg_grant_fix_1'));
    // 同一 grantId 重复发放 → 幂等（不重复入仓）
    const r2 = await s.store.grantPackages({
      playerId: a.playerId, packages: [pkg], source: 'quick', battleId: 'b_fixture', grantId,
    });
    assert.equal(r2.counts.package, before.counts.package + 1, '同 grantId 不得重复发放（grantIds 环幂等）');
    // 新 grantId 再发一次 → 正常入仓
    const r3 = await s.store.grantPackages({
      playerId: a.playerId, packages: [pkg], source: 'quick', battleId: 'b_fixture_2', grantId: 'pk_fixture_2',
    });
    assert.equal(r3.counts.package, before.counts.package + 2);
  }, QUIET);
});

test('OP-5 仓库满：产出超上限 → 409 warehouse_full 且原子（包未被消耗）', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'opf');
    // 灌满角色桶（上限 500）→ 开包产出角色物品必然超限
    await s.store.updateArchive(a.playerId, (ar) => {
      const cap = 500;
      while (ar.warehouse.buckets.role.length < cap) {
        ar.warehouse.buckets.role.push({
          uid: `filler_${ar.warehouse.buckets.role.length}`, kind: 'role', templateId: 'role_bal',
          quality: 'common', slots: [], pluginPoints: 0,
        });
      }
      ar.warehouse.buckets.package.push(PKG('pkg_full_1'));
      return null;
    });
    const r = await h.request(s.port, 'POST', '/api/v1/me/warehouse/open-package',
      { packageUids: ['pkg_full_1'] }, h.authed(a.token));
    assert.equal(r.status, 409, r.raw);
    assert.equal(r.body.error.code, 'warehouse_full');
    const wh = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(a.token));
    assert.equal(wh.body.data.counts.package, 2, '失败时包不得被消耗（原子：starter 1 + 注入 1）');
    assert.equal(wh.body.data.counts.role, 500);
  }, QUIET);
});
