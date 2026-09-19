'use strict';
/* tests/api/api-battle-legacy-replay-trace.test.js —— P1-2：遗留 `r<seq>` 回放的参与者鉴权 + aiTrace 裁剪
 *
 * 证据（修前实测）：`POST /battle` 产生的 `r1..rN` 走 `side===null` 分支 → **匿名可读**且 `aiTrace` 不裁剪
 *   （匿名 GET 拿到 `owners=[p1,p2]`、376 条 trace）；而归档 `b_` 已按 side 裁剪。SEC-27 只对 `b_` 闭环。
 * 修法（与 `b_` 分支对齐）：
 *   · `POST /battle` 登记调用方参与者（Bearer 身份 + 可选 `body.side`，缺省 p1）；
 *   · `GET /replay/r*` 按 side 裁剪；非参与者（带 token）→ 403 replay_forbidden；
 *   · 调用方 side **不可判定**（匿名/无效 token）→ 返回帧但**剥离全部 aiTrace** + 记
 *     `api.replay.trace_denied`(warn)（"遗留可读"兼容性保留：帧本体仍 200 可取）；
 *   · `?trace=all` 仍需管理员令牌（否则 403）。
 * 契约：docs/systems/11-account-store.md §9.4（该行旧文"遗留 r<seq> 不裁剪"已过时，需中央同步）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');
const LD = require('../fixtures/loadout-ok.json');

const ADMIN = 'p12-admin-token';
const TIER = 'mythic';

const ownersOf = (body) => [...new Set(body.data.frames.flatMap((f) => f.diff.aiTrace).map((x) => x.owner))];
const traceCount = (body) => body.data.frames.flatMap((f) => f.diff.aiTrace).length;

async function legacyBattle(s, headers, extra) {
  const r = await h.request(s.port, 'POST', '/api/v1/battle',
    { p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 424242, tier: TIER, ...(extra || {}) }, headers);
  assert.equal(r.status, 200, r.raw);
  assert.match(r.body.data.id, /^r\d+$/);
  return r.body.data.id;
}

test('LR-1 参与者视角：带 token 的 POST /battle → GET /replay/r* 只含**自己一侧** aiTrace（修前 owners=[p1,p2]）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lra'));
    const id = await legacyBattle(s, h.authed(a.token)); // side 缺省 p1
    const mine = await h.request(s.port, 'GET', `/api/v1/replay/${id}`, undefined, h.authed(a.token));
    assert.equal(mine.status, 200, mine.raw);
    assert.deepEqual(ownersOf(mine.body), ['p1'], `参与者只应看到自己一侧（实得 ${ownersOf(mine.body).join(',')}）`);
    assert.ok(traceCount(mine.body) > 0, '不是空数组：自己那侧的 trace 仍返回');
    assert.ok(mine.body.data.frames.every((f) => Array.isArray(f.diff.aiTrace)), '逐帧保留 aiTrace 字段（只裁剪内容）');
    assert.equal(mine.body.data.frames.length > 0, true);
    // 元数据已登记（参与者 + sides）
    const meta = s.runtime.replayMeta.get(id);
    assert.equal(meta.kind, 'legacy');
    assert.equal(meta.participants.length, 1, '登记了调用方参与者（匿名时为 0）');
    assert.match(meta.participants[0], /^pl_[0-9a-f]{16}$/);
    assert.equal(meta.sides.p1, meta.participants[0], 'side = p1（缺省）');
    assert.equal(meta.sides.p2, null);
  });
});

test('LR-2 匿名读取（兼容性）：帧仍 200 可取，但 aiTrace **一律剥离**并记 api.replay.trace_denied(warn)', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lrb'));
    const id = await legacyBattle(s, h.authed(a.token));
    const anon = await h.request(s.port, 'GET', `/api/v1/replay/${id}`);
    assert.equal(anon.status, 200, '遗留可读兼容性保留（帧本体仍可取）');
    assert.deepEqual(ownersOf(anon.body), [], '匿名不得再拿到双方轨迹');
    assert.equal(traceCount(anon.body), 0);
    assert.ok(anon.body.data.frames.length > 0, '帧本体（players/bullets/events）不受影响');
    assert.ok(anon.body.data.frames.every((f) => f.diff.players && f.diff.players.p1), '帧结构完整');
    assert.ok(s.runtime.logger.records.some((x) => x.event === 'api.replay.trace_denied' && x.data.reason === 'anonymous'),
      '必须留下明确 warn（不静默改语义）');
    // 分片仍可用
    const slice = await h.request(s.port, 'GET', `/api/v1/replay/${id}?from=2&to=3`);
    assert.equal(slice.status, 200);
    assert.equal(slice.body.data.frames.length, 2);
  });
});

test('LR-3 非参与者（带 token）→ 403 replay_forbidden；side=p2 由调用方声明时按其裁剪', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lrc'));
    const outsider = await h.register(s.port, h.uniqueName('lrd'));
    const id = await legacyBattle(s, h.authed(a.token), { side: 'p2' }); // 调用方声明自己占 p2
    const mine = await h.request(s.port, 'GET', `/api/v1/replay/${id}`, undefined, h.authed(a.token));
    assert.equal(mine.status, 200, mine.raw);
    assert.deepEqual(ownersOf(mine.body), ['p2'], 'side 声明生效（不再固定 p1）');
    const other = await h.request(s.port, 'GET', `/api/v1/replay/${id}`, undefined, h.authed(outsider.token));
    assert.equal(other.status, 403, other.raw);
    assert.equal(other.body.error.code, 'replay_forbidden');
    assert.ok(s.runtime.logger.records.some((x) => x.event === 'api.reject' && x.data.code === 'replay_forbidden'));
    // 非法 side → 400（不静默按 p1）
    const bad = await h.request(s.port, 'POST', '/api/v1/battle', { p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 5, tier: TIER, side: 'p3' });
    assert.equal(bad.status, 400, bad.raw);
    assert.equal(bad.body.error.code, 'bad_request');
    // 匿名创建的 r* → participants 空 → 匿名读也剥离（不返回双方轨迹）
    const anonId = await legacyBattle(s, undefined);
    const anonRead = await h.request(s.port, 'GET', `/api/v1/replay/${anonId}`);
    assert.equal(anonRead.status, 200);
    assert.equal(traceCount(anonRead.body), 0, '匿名创建的回放同样不泄漏双方轨迹');
  });
});

test('LR-4 ?trace=all 无管理员令牌 → 403（管理员令牌则放行双方）；未知 trace 值 400', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lre'));
    const id = await legacyBattle(s, h.authed(a.token));
    const url = `/api/v1/replay/${id}`;
    const noTok = await h.request(s.port, 'GET', `${url}?trace=all`, undefined, h.authed(a.token));
    assert.equal(noTok.status, 403, noTok.raw);
    assert.equal(noTok.body.error.code, 'forbidden');
    const anonAll = await h.request(s.port, 'GET', `${url}?trace=all`);
    assert.equal(anonAll.status, 403, '匿名更不得放行');
    const adminAll = await h.request(s.port, 'GET', `${url}?trace=all`, undefined, { ...h.authed(a.token), 'x-admin-token': ADMIN });
    assert.equal(adminAll.status, 200, adminAll.raw);
    assert.deepEqual([...ownersOf(adminAll.body)].sort(), ['p1', 'p2'], '管理员可见双方 trace');
    const badVal = await h.request(s.port, 'GET', `${url}?trace=nope`, undefined, h.authed(a.token));
    assert.equal(badVal.status, 400);
    assert.equal(badVal.body.error.code, 'bad_request');
  }, { server: { adminToken: ADMIN } });
});

test('LR-5 DL_LEGACY_STATELESS=0：遗留回放仍 410 deprecated（开关语义不变）', async () => {
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'GET', '/api/v1/replay/r1');
    assert.equal(r.status, 410, r.raw);
    assert.equal(r.body.error.code, 'deprecated');
  }, { server: { legacyStateless: false } });
});
