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

// D-163：配置里的物品身份/数值一律取自**服务端权威仓库** → LD.loadout 用到的 r1/s1..s3/pa/pb/qx
//   必须先真的在档（修前靠 PUT 请求随带的 `warehouse` 镜像顶替权威仓库做校验/解析；该降级已废除）。
async function injectFixture(s, publicId) {
  const playerId = await h.playerIdByPublicId(s.store, publicId);
  await s.store.updateArchive(playerId, (ar) => {
    for (const [bucket, list] of Object.entries(LD.warehouse.buckets)) {
      for (const it of list) ar.warehouse.buckets[bucket].push(JSON.parse(JSON.stringify(it)));
    }
    return null;
  });
  return playerId;
}

/* 帧比对的确定性口径（D-159 暴露的引擎口径，见交付报告「疑似真缺陷」）：
 *   `server/core/effects.js` 的 effect `uid` 来自**进程级自增** `uidSeq`，并被写进 aiTrace 的 trace 文案
 *   （`eff_12: atk 10 -> 12`）→ 同一场对局在**同一进程内两次重算**必然得到不同的 uid 文本
 *   （复现：注册两个真实玩家 → quick/run(seed=31337) → GET /replay → 清帧缓存 → 再 GET，30%~50% 的运行里
 *    帧文本仅因 eff_N 编号不同而不同 —— 取决于 starter 随机出的插件是否带 castEffect/hitEffect 词条）。
 *   这违反 D-90/D-91「同 seed + 同快照 → 帧逐字节一致」；本文件不改 server/**，改为在**比对层**把这个
 *   已知的进程级计数器规范化掉，其余内容仍是逐字节断言：
 *     · normalizeEff：把 uid 数值抹平 → 除 uid 数值外**逐字节一致**；
 *     · canonEff：按首次出现顺序重编号 → effect 的**数量/顺序/引用关系**也必须是同一套。
 *   两条一起断言，强度 ≈ 原 `deepEqual(frames)`（只放过"uid 数值"这一个非确定性维度）。
 */
function normalizeEff(frames) {
  return JSON.stringify(frames).replace(/eff_\d+/g, 'eff_#');
}

function canonEff(frames) {
  const map = new Map();
  return JSON.stringify(frames).replace(/eff_\d+/g, (m) => {
    if (!map.has(m)) map.set(m, `eff_#${map.size}`);
    return map.get(m);
  });
}

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
    // D-90/D-91：同 seed + 同快照 → 帧一致。D-159 后注册即发 starter（可能带 castEffect/hitEffect 词条），
    //   而 effect uid 是进程级自增（见文件头说明）→ 用"uid 抹平 + 首现序重编号"两条断言替代裸 deepEqual。
    assert.equal(normalizeEff(recomputed.body.data.frames), normalizeEff(first.body.data.frames),
      '同 seed + 同快照 → 帧除进程级 effect uid 数值外逐字节一致（D-90/D-91）');
    assert.equal(canonEff(recomputed.body.data.frames), canonEff(first.body.data.frames),
      'effect 的数量/顺序/引用关系不得漂移（首现序规范化后逐字节一致）');
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

test('RP-7 归档回放的 aiTrace 策略（D-167）：双方 trace 永远都在；frames=debug 需管理员且额外带引擎日志', async () => {
  const ADMIN = 'trace-admin-token';
  await h.withServer(null, async (s) => {
    // D-167：本用例断言"帧内容"（含 damages/trace）→ 身份必须固定，否则 starter 与默认 AI 预设随
    //   随机 publicId 变化，战斗内容（是否交战/掉血）会变 → 断言 flaky（与 P2-5 的去 flaky 口径一致）。
    const a = await h.register(s.port, h.uniqueName('tra'), undefined, { publicId: 'u_tra00001', playerId: 'pl_tra000000000001' });
    const b = await h.register(s.port, h.uniqueName('trb'), undefined, { publicId: 'u_trb00001', playerId: 'pl_trb000000000002' });
    const data = await quickBattle(s, a, b);
    // ⚠ 顺序敏感：outsider 必须在**匹配之后**注册，否则它会进候选池 → `quickBattle` 的"唯一候选应是 B"断言 flaky
    const outsider = await h.register(s.port, h.uniqueName('trc'), undefined, { publicId: 'u_trc00001', playerId: 'pl_trc000000000003' });
    const url = `/api/v1/replay/${data.battleId}`;
    const traceOf = (body) => body.data.frames.flatMap((f) => f.diff.aiTrace);
    const ownersOf = (body) => [...new Set(traceOf(body).map((x) => x.owner))];
    // `store.read`(kind=archive) 只在**重算**路径记录 → 用它证明某次请求走的是缓存路径（P1-1 两条路径都要覆盖）
    const archiveReads = () => s.logger.records.filter((x) => x.event === 'store.read' && x.data && x.data.kind === 'archive').length;

    // ① p1 视角（重算路径）：D-167 起**双方** trace 都在（不再按 side 裁剪）
    const v1 = await h.request(s.port, 'GET', url, undefined, h.authed(a.token));
    assert.equal(v1.status, 200, v1.raw);
    assert.ok(traceOf(v1.body).length > 0, 'trace 非空');
    assert.deepEqual([...ownersOf(v1.body)].sort(), ['p1', 'p2'], `D-167：双方 trace 都在（实得 ${ownersOf(v1.body).join(',')}）`);
    assert.ok(v1.body.data.frames.every((f) => Array.isArray(f.diff.aiTrace)), '每帧带 aiTrace 数组');
    assert.ok(!('events' in v1.body.data.frames[0].diff), 'D-167：默认（render）帧不含引擎日志');

    // ② 命中**进程内帧缓存**路径：同样带双方 trace（两条路径一致）
    const frameId = s.runtime.replayMeta.get(data.battleId).frameId;
    assert.ok(frameId, '首次请求已登记帧缓存（走缓存路径的前提）');
    const readsBefore = archiveReads();
    const v1c = await h.request(s.port, 'GET', url, undefined, h.authed(a.token));
    assert.equal(v1c.status, 200);
    assert.equal(archiveReads(), readsBefore, '第二次请求未走重算 → 确实命中缓存路径（P1-1 覆盖两路径）');
    assert.deepEqual([...ownersOf(v1c.body)].sort(), ['p1', 'p2'], '缓存命中路径同样带双方 trace');

    // ③ p2 视角：同样双方（D-167 的核心变更）
    const v2 = await h.request(s.port, 'GET', url, undefined, h.authed(b.token));
    assert.equal(v2.status, 200, v2.raw);
    assert.deepEqual([...ownersOf(v2.body)].sort(), ['p1', 'p2'], 'p2 视角同样拿到双方 trace');

    // ④ 非参与者（无 debug）→ 403 不变（参与者鉴权仍由 record 判定）
    const other = await h.request(s.port, 'GET', url, undefined, h.authed(outsider.token));
    assert.equal(other.status, 403, other.raw);
    assert.equal(other.body.error.code, 'replay_forbidden');

    // ⑤ frames=debug：无/错管理员令牌 → 403；正确令牌 → 200、**含引擎日志 events**、且可越过参与者鉴权（非参与者也放行）
    const noTok = await h.request(s.port, 'GET', `${url}?frames=debug`, undefined, h.authed(a.token));
    assert.equal(noTok.status, 403, noTok.raw);
    assert.equal(noTok.body.error.code, 'forbidden');
    const badTok = await h.request(s.port, 'GET', `${url}?frames=debug`, undefined, { 'x-admin-token': 'nope' });
    assert.equal(badTok.status, 403);
    const dbg = await h.request(s.port, 'GET', `${url}?frames=debug`, undefined, { ...h.authed(outsider.token), 'x-admin-token': ADMIN });
    assert.equal(dbg.status, 200, dbg.raw);
    assert.ok(Array.isArray(dbg.body.data.frames[0].diff.events), 'debug 帧必须带 events（引擎日志真源）');
    assert.ok(dbg.body.data.frames[0].diff.events.length > 0, 'events 非空（每 tick 有 tick.begin/step/end）');
    assert.deepEqual([...ownersOf(dbg.body)].sort(), ['p1', 'p2'], 'debug 帧同样带双方 trace');
    assert.ok(s.logger.records.some((x) => x.event === 'store.abuse.suspect' && x.data && x.data.debug === true),
      '管理员读取非参与对局必须记审计 warn');
    // 调试帧逐帧 cid/tick 归属仍然正确（沿用 B22 P1-1 契约）
    for (const f of dbg.body.data.frames) {
      for (const e of f.diff.events) {
        assert.equal(e.tick, f.tick, '事件归属自己的 tick');
        assert.ok(typeof e.cid === 'string' && e.cid.startsWith(`t${f.tick}:`), '事件带 cid');
      }
    }

    // ⑥ 非法 frames 值 → 400；已废弃的 ?trace=* 被忽略（200，且不裁剪）
    const badVal = await h.request(s.port, 'GET', `${url}?frames=nope`, undefined, h.authed(a.token));
    assert.equal(badVal.status, 400, badVal.raw);
    assert.equal(badVal.body.error.code, 'bad_request');
    const legacyParam = await h.request(s.port, 'GET', `${url}?trace=nope`, undefined, h.authed(a.token));
    assert.equal(legacyParam.status, 200, 'trace 参数已废弃 → 忽略');
    assert.deepEqual([...ownersOf(legacyParam.body)].sort(), ['p1', 'p2']);
    const selfParam = await h.request(s.port, 'GET', `${url}?trace=self`, undefined, h.authed(a.token));
    assert.equal(selfParam.status, 200);
    assert.deepEqual([...ownersOf(selfParam.body)].sort(), ['p1', 'p2'], 'trace=self 不再裁剪');

    // ⑦ 遗留 r<seq> 回放零回归（同样带双方 trace）
    const legacy = await h.request(s.port, 'POST', '/api/v1/battle', { p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 4242, tier: TIER });
    assert.equal(legacy.status, 200, legacy.raw);
    const lr = await h.request(s.port, 'GET', `/api/v1/replay/${legacy.body.data.id}`);
    assert.equal(lr.status, 200, lr.raw);
    assert.ok(lr.body.data.frames.length > 0);
    assert.deepEqual([...ownersOf(lr.body)].sort(), ['p1', 'p2']);
  }, { server: { adminToken: ADMIN } });
});

test('RP-8 缺口 2：含装配引用的对局，帧缓存清空后归档回放重算仍 200，且帧与实战（首次重算）逐字节一致', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('p2a'));
    const b = await h.register(s.port, h.uniqueName('p2b'));
    // D-163：A 要用 LD 的 pa/pb/qx，物品必须先入**服务端权威仓库**（PUT 不再接收客户端 warehouse 镜像）
    const aId = await injectFixture(s, a.publicId);
    const save = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', { loadout: LD.loadout }, h.authed(a.token));
    assert.equal(save.status, 200, save.raw);
    const data = await quickBattle(s, a, b);
    // 修前：归档重算只把 loadout 交给 runBattle（无逐侧 warehouse）→ 含引用的一侧 missing_warehouse → 410
    const first = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`, undefined, h.authed(a.token));
    assert.equal(first.status, 200, `含装配引用的归档回放必须 200（修前 410）：${first.raw.slice(0, 200)}`);
    assert.equal(first.body.data.frames.length, data.ticks, '重算帧数 = 实战 tick 数');
    assert.equal(first.body.data.winner, data.winner === 'win' ? 'p1' : data.winner === 'loss' ? 'p2' : 'draw',
      '重算结果与实战一致（逐侧镜像生效 → 面板一致）');
    // 清掉帧缓存 → 触发按需重算路径
    const frameId = s.runtime.replayMeta.get(data.battleId).frameId;
    assert.ok(frameId, '首次取帧已登记进程内缓存');
    battleApi.REPLAYS.delete(frameId);
    const recomputed = await h.request(s.port, 'GET', `/api/v1/replay/${data.battleId}`, undefined, h.authed(a.token));
    assert.equal(recomputed.status, 200, recomputed.raw);
    // D-90/D-91 的逐字节一致性：本场 p2 是 D-159 的 starter（插件词条随机 → 可能带持续效果），
    //   effect uid 为进程级自增 → 同样按"uid 抹平 + 首现序重编号"两条断言比对（见文件头说明）。
    assert.equal(normalizeEff(recomputed.body.data.frames), normalizeEff(first.body.data.frames),
      '清缓存后按需重算帧与首次除进程级 effect uid 数值外逐字节一致');
    assert.equal(canonEff(recomputed.body.data.frames), canonEff(first.body.data.frames),
      'effect 的数量/顺序/引用关系不得漂移');
    // 逐侧仓库的真源：D-163 起 HTTP 配置保存**不再**把客户端 `warehouse` 镜像内联进快照
    //   （防止"自带 buff 的假镜像"顶替权威仓库）→ 回放重算走 `rt.loadWarehouse`，其首选来源是
    //   各自档案里的**服务端权威仓库**（随 journal 落盘）。旧断言（快照镜像恰等于引用集）随该热修废除，
    //   改为更强的真源断言：每侧权威仓库覆盖本侧引用、被引用插件 equipped=true、且两侧互不串仓。
    const rec = await s.store.findBattleRecord(data.battleId);
    const snap1 = await s.store.snapshot.get(rec.p1.snapshotHash);
    const snap2 = await s.store.snapshot.get(rec.p2.snapshotHash);
    assert.ok(snap1 && snap1.loadout && snap2 && snap2.loadout, '快照仍携带 loadout（按需重算的输入）');
    assert.equal(snap1.warehouse, undefined, 'D-163：HTTP 保存的快照不再内联客户端提交的镜像（真源 = 档案仓库）');
    const refUidsOf = (loadout) => {
      const out = [];
      for (const item of [loadout.role].concat(loadout.skills || [])) {
        for (const sl of item.slots || []) if (sl && sl.pluginUid) out.push(sl.pluginUid);
      }
      return out.sort();
    };
    const uidsOf = (wh) => Object.values(wh.buckets).flat().map((x) => x.uid).sort();
    const refA = refUidsOf(snap1.loadout);
    const refB = refUidsOf(snap2.loadout);
    // D-159：starter 侧的快照镜像由**服务端内部**的 starter 仓库冻结（不是客户端提交的正文）→ 仍保留，
    //   且恰为其 loadout 实际引用的插件集合（旧断言保留；D-163 只废除了"客户端镜像充当权威"的那条路径）。
    assert.ok(snap2.warehouse, 'starter 快照自带服务端生成的装配引用子集（D-159）');
    assert.deepEqual(uidsOf(snap2.warehouse), refB, 'p2 快照镜像恰为其 starter loadout 引用的插件');
    const whA = await s.runtime.loadWarehouse(aId);
    const whB = await s.runtime.loadWarehouse(await h.playerIdByPublicId(s.store, b.publicId));
    assert.ok(whA && whB && whA.buckets && whB.buckets, '双方权威仓库都覆盖各自配置引用（否则 loadWarehouse 退化落 null）');
    assert.ok(refA.length > 0 && refB.length > 0, '两侧都含装配引用（D-159 后默认配置也带真实引用）');
    assert.ok(refA.includes('pa') && refA.includes('pb') && refA.includes('qx'), `A 侧引用 LD 的 pa/pb/qx（实际 ${refA}）`);
    for (const ref of refA) assert.ok(uidsOf(whA).includes(ref), `A 的权威仓库覆盖引用 ${ref}`);
    for (const ref of refB) assert.ok(uidsOf(whB).includes(ref), `B 的权威仓库覆盖引用 ${ref}`);
    for (const ref of refA) assert.equal(refB.includes(ref), false, `两侧引用集不重叠（${ref}）`);
    for (const ref of refA) assert.equal(uidsOf(whB).includes(ref), false, `B 的仓库不含 A 的物品 ${ref}（逐侧互不串仓）`);
    // 被引用的插件必须 equipped=true（loadout 第二道引用检查），且必须在**本侧**仓库里
    for (const [wh, refs] of [[whA, refA], [whB, refB]]) {
      const plugins = (wh.buckets.rolePlugin || []).concat(wh.buckets.skillPlugin || []);
      for (const ref of refs) {
        const p = plugins.find((x) => x.uid === ref);
        assert.ok(p, `权威仓库含被引用插件 ${ref}`);
        assert.equal(p.equipped, true, `被引用插件 ${ref} 标记 equipped=true（loadout 第二道引用检查）`);
      }
    }
    assert.ok(s.logger.records.some((x) => x.event === 'store.read' && x.data.kind === 'archive'), '重算路径记 store.read(archive)');
  });
});

test('RP-9 缺口 2 根因对照：单仓库签名（旧调用口径）对含装配引用的一侧 → 409 loadout_invalid/missing_warehouse；逐侧签名 → 200', async () => {
  const battleApi2 = require('../../server/battle.js');
  const real = battleApi2.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 9, tier: TIER });
  assert.equal(real.status, 200, '旧签名（单仓库）仍向后兼容');
  const oldCall = battleApi2.runBattle({ p1: LD.loadout, p2: LD.loadout, seed: 9, tier: TIER });
  assert.equal(oldCall.status, 409, '修前归档重算的实际调用形态：无 warehouse → 含引用的一侧不合法');
  assert.ok(oldCall.details.some((d) => d.code === 'missing_warehouse'), '根因即 missing_warehouse（上层映射成 410）');
  const perSide = battleApi2.runBattle({ p1: LD.loadout, p2: LD.loadout, p1Warehouse: LD.warehouse, p2Warehouse: null, seed: 9, tier: TIER });
  assert.equal(perSide.status, 409, '逐侧：缺镜像的一侧仍如实拒绝（不放宽）');
  const both = battleApi2.runBattle({ p1: LD.loadout, p2: LD.loadout, p1Warehouse: LD.warehouse, p2Warehouse: LD.warehouse, seed: 9, tier: TIER });
  assert.equal(both.status, 200, '逐侧：两侧各自给镜像 → 200');
  assert.deepEqual(battleApi2.sideWarehouses({ warehouse: LD.warehouse }), { p1: LD.warehouse, p2: LD.warehouse }, '旧签名 → 双方共用');
  assert.deepEqual(battleApi2.sideWarehouses({ p1Warehouse: LD.warehouse, p2Warehouse: null }).p2, null, '逐侧优先且可一侧为空');
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
