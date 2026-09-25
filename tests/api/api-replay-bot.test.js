'use strict';
/* tests/api/api-replay-bot.test.js —— D-165 / D-166 回归
 * D-165（回放 410 修复）：修前"仓库覆盖判据只看 pluginUid"，管理端注入的 bot 仓库为空且无插件引用
 *   ⇒ 覆盖判定空转通过 ⇒ 对局成立但 GET /replay/:battleId **100% 410**（实测 10/10 场）。
 *   修后：① loadout.warehouseResolves 与 resolveItems 同谓词；② 注入 bot 时写入真实（合成）仓库。
 * D-166（bot 多样化）：修前所有 bot 共用同一个 steady/0 程序 ⇒ 互打恒平局（实测 10 场 0 胜 10 平）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('../helpers/http.js');
const ast = require('../../server/ai/ast.js');
const loadoutMod = require('../../server/loadout.js');
const ranked = require('../../server/ranked.js');

const ADMIN = 'admtok-replay-bot';
const BOT_OPTS = () => ({ server: { adminToken: ADMIN, env: { DL_ADMIN_TOKEN: ADMIN, DL_DEBUG_BOTS: '1' }, authConfig: h.FAST_AUTH } });
// helpers/http 的 withServer(t, fn, options)：本文件不用测试上下文，包一层避免漏参
const withSrv = (fn, opts) => h.withServer(null, fn, opts);

async function inject(s, body) {
  return h.request(s.port, 'POST', '/api/v1/admin/bots', body, { 'x-admin-token': ADMIN });
}
async function botSnapshotLoadout(store, playerId) {
  const archive = await store.loadArchive(playerId);
  const slot = archive.configs.slots.find((x) => x.slotId === archive.configs.activeSlotId) || archive.configs.slots[0];
  const snap = await store.snapshot.get(slot.snapshot.hash);
  return { archive, loadout: snap.loadout, hash: slot.snapshot.hash };
}

test('RB-1 注入 bot 对手的排位对局：回放可重算（修前 410 replay_expired）', async () => {
  await withSrv(async (s) => {
    const me = await h.register(s.port, h.uniqueName('rb1'), undefined, { publicId: 'u_rb100001', playerId: 'pl_rb10000000000001' });
    assert.equal(me.status, 200);
    const inj = await inject(s, { count: 2, tier: 'common', points: 0, botKey: 'rb1' });
    assert.equal(inj.status, 200);
    assert.equal(inj.body.data.injected, 2);

    const run = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 20260925 }, h.authed(me.token));
    assert.equal(run.status, 200, JSON.stringify(run.body));
    assert.ok(run.body.data.matches >= 1, '至少打一场');
    const battleId = run.body.data.results[0].battleId;
    assert.ok(battleId && battleId.startsWith('b_'), 'battleId 形状');

    const rep = await h.request(s.port, 'GET', `/api/v1/replay/${battleId}`, undefined, h.authed(me.token));
    assert.equal(rep.status, 200, `bot 对手的回放必须可取（修前 410）：${JSON.stringify(rep.body && rep.body.error)}`);
    assert.ok(rep.body.data.frames.length > 0, '帧非空');
    assert.equal(rep.body.data.ticks, rep.body.data.frames.length, 'ticks 与帧数一致');
  }, BOT_OPTS());
});

test('RB-2 注入的 bot 是完整账号：有真实仓库，且该仓库足以按 uid 重建其出战配置', async () => {
  await withSrv(async (s) => {
    const inj = await inject(s, { count: 1, tier: 'common', points: 0, botKey: 'rb2' });
    assert.equal(inj.status, 200);
    const botPid = inj.body.data.bots[0].playerId;

    const view = await s.store.getWarehouse(botPid);
    assert.ok(view && view.warehouse, 'bot 应有仓库视图');
    assert.equal(view.warehouse.buckets.role.length, 1, 'bot 仓库含自己的角色');
    assert.equal(view.warehouse.buckets.skill.length, 3, 'bot 仓库含自己的 3 个技能');

    const { archive, loadout } = await botSnapshotLoadout(s.store, botPid);
    assert.equal(archive.flags.isBot, true);
    assert.equal(archive.pool.inPool, true, 'bot 出生即入池（可被抽为对手）');
    assert.equal(loadoutMod.warehouseResolves(loadout, view.warehouse), true, '仓库足以重建 bot 的出战配置');
    // 反向锚：空仓库**不**算覆盖（这正是修前的漏洞）
    assert.equal(loadoutMod.warehouseResolves(loadout, { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } }), false);
  }, BOT_OPTS());
});

test('RB-3 同一批注入的 bot 各自不同预设（修前全同 ⇒ 互打恒平局，无法验收晋升）', async () => {
  await withSrv(async (s) => {
    const inj = await inject(s, { count: 6, tier: 'common', points: 0, botKey: 'rb3' });
    assert.equal(inj.status, 200);
    const hashes = new Set();
    for (const b of inj.body.data.bots) {
      const { loadout } = await botSnapshotLoadout(s.store, b.playerId);
      hashes.add(ast.programHash(loadout.ai));
    }
    assert.ok(hashes.size >= 2, `6 个 bot 应至少出现 2 个不同程序（实际 ${hashes.size}）`);
  }, BOT_OPTS());
});

test('RB-4 preset 参数：可指定预设族；非法 preset → 400 bad_request', async () => {
  await withSrv(async (s) => {
    const inj = await inject(s, { count: 2, tier: 'common', points: 0, botKey: 'rb4', preset: 'aggressive' });
    assert.equal(inj.status, 200);
    assert.equal(inj.body.data.preset, 'aggressive');
    for (const b of inj.body.data.bots) {
      const { loadout } = await botSnapshotLoadout(s.store, b.playerId);
      const want = ranked.buildDefaultLoadout({ botKey: b.botKey }, { preset: 'aggressive' });
      // 同一预设族下子变体仍按身份派生：逐字节比对"同身份同 preset"的程序
      assert.equal(ast.programHash(loadout.ai), ast.programHash(want.ai), 'preset 应被采纳（同身份同 preset 程序一致）');
    }
    const bad = await inject(s, { count: 1, botKey: 'rb4b', preset: 'nope' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad_request');
  }, BOT_OPTS());
});

test('RB-5 不回归：真人 vs 真人 的排位回放仍可重算', async () => {
  await withSrv(async (s) => {
    const a = await h.register(s.port, h.uniqueName('rb5a'), undefined, { publicId: 'u_rb500001', playerId: 'pl_rb50000000000001' });
    const b = await h.register(s.port, h.uniqueName('rb5b'), undefined, { publicId: 'u_rb500002', playerId: 'pl_rb50000000000002' });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const run = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 7 }, h.authed(a.token));
    assert.equal(run.status, 200);
    const rep = await h.request(s.port, 'GET', `/api/v1/replay/${run.body.data.results[0].battleId}`, undefined, h.authed(a.token));
    assert.equal(rep.status, 200, JSON.stringify(rep.body && rep.body.error));
    assert.ok(rep.body.data.frames.length > 0);
  }, { server: { authConfig: h.FAST_AUTH } });
});
