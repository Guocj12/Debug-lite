'use strict';
/* tests/api/api-replay-auth.test.js —— P7-4（B33/D-135）回放接线：LRU 64 + 参与者鉴权 + 410 失效
 *
 * 契约：docs/systems/11-account-store.md §9.1（只存引用）/§9.3（按需重算与失效）/§9.4（可见性与泄露面）
 *      /§11.3（帧 LRU 上限 64）；decisions.md D-135。
 * 覆盖：
 *   · 遗留 `r<seq>` 回放：零回归（无 token 可取）；LRU 淘汰后 → 410 replay_expired；未知 id → 404；
 *     DL_LEGACY_STATELESS=0 → 410 deprecated；
 *   · 归档 `b_…` 回放：无 token 401 / 非参与者 403 replay_forbidden / 参与者（双方）200 且帧可复算；
 *     版本不匹配 → 410（engine_mismatch）/ 快照缺失 → 410（snapshot_gc）/ 重算（帧缓存清空后仍可取）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');
const battleApi = require('../../server/battle.js');
const LD = require('../fixtures/loadout-ok.json');

const TIER = 'mythic';

// 双方同样的 loadout 也能跑（引擎确定；结果由 seed 定），但为了让被抽方"必然"是 B，池里只放 A/B
async function quickBattle(s, a, b) {
  const r = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 31337 }, h.authed(a.token));
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.data.opponent.publicId, b.publicId, '池内唯一候选应是 B');
  return r.body.data;
}

// 手工归档记录（回放 410 分支用）：versions/snapshotHash 可控
async function craftRecord(s, aId, bId, overrides) {
  const o = overrides || {};
  const aSlot = await h.activeSlotOf(s.store, aId);
  const bSlot = await h.activeSlotOf(s.store, bId);
  const res = await h.settleRecord(s.store, {
    mode: 'quick',
    seed: o.seed === undefined ? 8888 : o.seed,
    at: Date.now(),
    p1: {
      playerId: aId, publicId: aSlot.archive.publicId, role: 'attacker',
      snapshotHash: o.p1Hash === undefined ? aSlot.snapshotHash : o.p1Hash,
      configHash: aSlot.configHash,
      pointsBefore: 0, pointsAfter: 0, result: 'win', tierBefore: 'common', tierAfter: 'common',
    },
    p2: {
      playerId: bId, publicId: bSlot.archive.publicId, role: 'defender',
      snapshotHash: bSlot.snapshotHash, configHash: bSlot.configHash,
      pointsBefore: 0, pointsAfter: 0, result: 'loss', tierBefore: 'common', tierAfter: 'common',
    },
    verdict: { winner: 'p1', reason: 'hero_dead', ticks: 20 },
    versions: o.versions === undefined ? { engine: s.store.versions.engine, data: s.store.versions.data } : o.versions,
  });
  return res.record.battleId;
}

test('RP-1 遗留回放零回归：POST /battle → GET /replay/:id（无 token）可取全量与分片', async () => {
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'POST', '/api/v1/battle', { p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: TIER });
    assert.equal(r.status, 200, r.raw);
    const id = r.body.data.id;
    assert.match(id, /^r\d+$/);
    const full = await h.request(s.port, 'GET', `/api/v1/replay/${id}`);
    assert.equal(full.status, 200, full.raw);
    assert.equal(full.body.data.frames.length, r.body.data.ticks);
    const slice = await h.request(s.port, 'GET', `/api/v1/replay/${id}?from=2&to=3`);
    assert.equal(slice.status, 200);
    assert.equal(slice.body.data.frames.length, 2);
    assert.equal(slice.body.data.frames[0].tick, 2);
    const unknown = await h.request(s.port, 'GET', '/api/v1/replay/r999999');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'unknown_replay');
  });
});

test('RP-2 归档回放参与者鉴权：无 token 401 / 非参与者 403 replay_forbidden / 双方 200 且帧与记录一致', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('rpa'));
    const b = await h.register(s.port, h.uniqueName('rpb'));
    const data = await quickBattle(s, a, b);
    const c = await h.register(s.port, h.uniqueName('rpc'));
    const anon = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`);
    assert.equal(anon.status, 401, '归档回放需鉴权（D-135）');
    assert.equal(anon.body.error.code, 'unauthorized');
    const outsider = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`, undefined, h.authed(c.token));
    assert.equal(outsider.status, 403);
    assert.equal(outsider.body.error.code, 'replay_forbidden');
    assert.ok(s.logger.records.some((x) => x.event === 'api.reject' && x.data.code === 'replay_forbidden'));
    for (const p of [a, b]) {
      const view = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`, undefined, h.authed(p.token));
      assert.equal(view.status, 200, `${p.username} 应可查看（${view.raw.slice(0, 160)}）`);
      assert.equal(view.body.data.id, data.battleId, '归档回放 id = battleId');
      assert.equal(view.body.data.seed, data.seed);
      assert.equal(view.body.data.frames.length, data.ticks, '重算帧数 = 记录 ticks');
      assert.equal(view.body.data.winner, data.winner === 'win' ? 'p1' : data.winner === 'loss' ? 'p2' : 'draw', '重算结果与记录一致（确定性）');
      assert.ok(view.body.data.frames.every((f) => f.diff && f.diff.players && f.diff.players.p1), '帧结构完整');
    }
    const rec = await s.store.findBattleRecord(data.battleId);
    assert.ok(rec, 'journal 里只有引用（D-135）');
    assert.equal(rec.verdict.ticks, data.ticks);
    assert.ok(!JSON.stringify(rec).includes('"frames"'), 'journal 记录不含帧');
  });
});

test('RP-3 归档回放按需重算：帧缓存清空后仍可取自 journal 记录 + 快照库', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('rra'));
    const b = await h.register(s.port, h.uniqueName('rrb'));
    const data = await quickBattle(s, a, b);
    const first = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`, undefined, h.authed(a.token));
    assert.equal(first.status, 200, first.raw);
    const frameId = s.runtime.replayMeta.get(data.battleId).frameId;
    assert.ok(frameId, '首次取帧已登记进程内缓存');
    battleApi.REPLAYS.delete(frameId); // 模拟该场帧被 LRU 淘汰（引用仍在 journal，§9.1）
    const recomputed = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`, undefined, h.authed(a.token));
    assert.equal(recomputed.status, 200, recomputed.raw);
    assert.equal(recomputed.body.data.frames.length, first.body.data.frames.length);
    assert.deepEqual(recomputed.body.data.frames, first.body.data.frames, '同 seed + 同快照 → 帧逐字节一致（D-90/D-91）');
    assert.ok(s.logger.records.some((x) => x.event === 'store.read' && x.data.kind === 'archive'), '按需重算记 store.read(debug)');
  });
});

test('RP-4 归档回放 410：引擎版本不匹配（engine_mismatch）/ 数据版本不匹配（data_mismatch）/ 快照缺失（snapshot_gc）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('rxa'));
    const b = await h.register(s.port, h.uniqueName('rxb'));
    const aId = await h.playerIdByPublicId(s.store, a.publicId);
    const bId = await h.playerIdByPublicId(s.store, b.publicId);
    const engineBad = await craftRecord(s, aId, bId, { seed: 5001, versions: { engine: '0.0.0', data: s.store.versions.data } });
    const r1 = await h.request(s.port, 'GET', `/api/v1/replay/${engineBad}`, undefined, h.authed(a.token));
    assert.equal(r1.status, 410, r1.raw);
    assert.equal(r1.body.error.code, 'replay_expired');
    assert.match(r1.body.error.message, /engine_mismatch/);
    const dataBad = await craftRecord(s, aId, bId, { seed: 5002, versions: { engine: s.store.versions.engine, data: 'b00' } });
    const r2 = await h.request(s.port, 'GET', `/api/v1/replay/${dataBad}`, undefined, h.authed(a.token));
    assert.equal(r2.status, 410);
    assert.match(r2.body.error.message, /data_mismatch/);
    const noSnap = await craftRecord(s, aId, bId, { seed: 5003, p1Hash: `sha256:${'0'.repeat(64)}` });
    const r3 = await h.request(s.port, 'GET', `/api/v1/replay/${noSnap}`, undefined, h.authed(a.token));
    assert.equal(r3.status, 410);
    assert.match(r3.body.error.message, /snapshot_gc/);
    assert.ok(s.logger.records.some((x) => x.event === 'store.snapshot.missing'), '快照缺失记 store.snapshot.missing(warn)');
  });
});

test('RP-5 帧 LRU 上限 64（D-135）：第 65 场起淘汰最旧 → 410 replay_expired；本实例最多保留 64', async () => {
  await h.withServer(null, async (s) => {
    assert.equal(s.runtime.replayLimit, 64, '上限默认取 store.config.replayCacheSize = 64');
    const body = { p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 7, tier: TIER };
    const ids = [];
    for (let i = 0; i < 70; i++) {
      const r = await h.request(s.port, 'POST', '/api/v1/battle', body);
      assert.equal(r.status, 200);
      ids.push(r.body.data.id);
    }
    // 最旧 6 场被淘汰 → 410 replay_expired（区分于"未知 id"的 404）
    for (let i = 0; i < 6; i++) {
      const gone = await h.request(s.port, 'GET', `/api/v1/replay/${ids[i]}`);
      assert.equal(gone.status, 410, `第 ${i + 1} 场应已淘汰：${gone.raw.slice(0, 120)}`);
      assert.equal(gone.body.error.code, 'replay_expired');
    }
    // 最新 64 场仍在
    for (const id of [ids[6], ids[40], ids[69]]) {
      const alive = await h.request(s.port, 'GET', `/api/v1/replay/${id}`);
      assert.equal(alive.status, 200, `${id} 应在缓存内`);
    }
    assert.equal(s.runtime.ownReplays.length, 64, '本实例帧缓存恒 ≤ 64（D-135：修掉 battle.js 无上限增长）');
    const own = s.runtime.ownReplays;
    assert.ok(own.every((id) => battleApi.REPLAYS.has(id)));
    assert.ok(s.logger.records.some((x) => x.event === 'store.snapshot.missing' && x.data.reason === 'evicted'), '淘汰取帧记 warn');
  });
});

test('RP-6 DL_LEGACY_STATELESS=0：遗留端点 410 deprecated；归档回放不受影响', async () => {
  await h.withServer(null, async (s) => {
    const box = await h.request(s.port, 'POST', '/api/v1/box', { seed: 1 });
    assert.equal(box.status, 410, box.raw);
    assert.equal(box.body.error.code, 'deprecated');
    const wh = await h.request(s.port, 'GET', '/api/v1/warehouse');
    assert.equal(wh.status, 410);
    const loadout = await h.request(s.port, 'POST', '/api/v1/loadout', { loadout: LD.loadout, warehouse: LD.warehouse });
    assert.equal(loadout.status, 410);
    const ai = await h.request(s.port, 'POST', '/api/v1/ai/validate', { program: { type: 'program', version: 1 } });
    assert.equal(ai.status, 410);
    const legacyReplay = await h.request(s.port, 'GET', '/api/v1/replay/r1');
    assert.equal(legacyReplay.status, 410);
    assert.equal(legacyReplay.body.error.code, 'deprecated');
    // 健康检查等基础设施端点保持可用
    assert.equal((await h.request(s.port, 'GET', '/api/v1/health')).status, 200);
    // 归档回放仍走参与者鉴权 + 重算
    const a = await h.register(s.port, h.uniqueName('lsa'));
    const b = await h.register(s.port, h.uniqueName('lsb'));
    const data = await quickBattle(s, a, b);
    const anon = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`);
    assert.equal(anon.status, 401, '未鉴权 → 401（不是 410）');
    const view = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`, undefined, h.authed(a.token));
    assert.equal(view.status, 200, view.raw);
    // 无 token 的排位/晋升 → 401（旧无状态端点已关，不能再降级到无状态口径）
    const promoted = await h.request(s.port, 'POST', '/api/v1/ranked/promote', { tier: 'common', wins: 7 });
    assert.equal(promoted.status, 401);
    assert.equal(promoted.body.error.code, 'unauthorized');
    const ranked = await h.request(s.port, 'POST', '/api/v1/ranked/run', {});
    assert.equal(ranked.status, 401);
  }, { server: { legacyStateless: false } });
});
