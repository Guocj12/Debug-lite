'use strict';
/* tests/api/api-battle-legacy-replay-trace.test.js —— 遗留 `r<seq>` 回放的参与者鉴权 + aiTrace 策略（D-167）
 *
 * 沿革：P1-2（2026-09-19）曾让 `GET /replay/r*` 按调用方 side **裁剪** aiTrace（匿名则整段剥离，记
 *   `api.replay.trace_denied`），并把 `?trace=all` 置于管理员令牌之后。
 * **D-167（2026-09-25，用户口径）推翻该策略**：**回放帧永远返回双方 `aiTrace`**（前端绘制时只画自己那一侧），
 *   故本文件改为钉死新契约：
 *   · 参与者在场/匿名/非参与者（创建者）三种情形下，帧都带**双方** trace；
 *   · **非参与者（带 token）仍 403 replay_forbidden**（参与者鉴权不变，D-135）；
 *   · `?trace=*` 已废弃（被忽略）；新增 `frames=render|debug`：`debug` 需管理员令牌，且对**归档回放**
 *     额外返回引擎日志 `events`（本文件的 `r<seq>` 帧来自进程内注册表，已是 lean 形状，故 debug 也不含 events）；
 *   · 非法 `frames` 值 → 400 bad_request。
 * 契约：docs/decisions.md D-167、docs/interfaces.md §2（`GET /replay/:id`）、§4.3（帧字段）、
 *      docs/security-backlog.md SEC-33（"双方 trace 可见"= 已接受风险）。
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

test('LR-1 参与者视角：帧带**双方** aiTrace（D-167 起不再按 side 裁剪）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lra'));
    const id = await legacyBattle(s, h.authed(a.token)); // side 缺省 p1
    const mine = await h.request(s.port, 'GET', `/api/v1/replay/${id}`, undefined, h.authed(a.token));
    assert.equal(mine.status, 200, mine.raw);
    assert.deepEqual([...ownersOf(mine.body)].sort(), ['p1', 'p2'], `D-167：双方 trace 都要在（实得 ${ownersOf(mine.body).join(',')}）`);
    assert.ok(traceCount(mine.body) > 0, 'trace 非空');
    assert.ok(mine.body.data.frames.every((f) => Array.isArray(f.diff.aiTrace)), '逐帧保留 aiTrace 字段');
    assert.equal(mine.body.data.frames.length > 0, true);
    // 元数据仍登记（参与者 + sides）——参与者鉴权仍靠它
    const meta = s.runtime.replayMeta.get(id);
    assert.equal(meta.kind, 'legacy');
    assert.equal(meta.participants.length, 1, '登记了调用方参与者（匿名时为 0）');
    assert.match(meta.participants[0], /^pl_[0-9a-f]{16}$/);
    assert.equal(meta.sides.p1, meta.participants[0], 'side = p1（缺省）');
    assert.equal(meta.sides.p2, null);
  });
});

test('LR-2 匿名读取：帧 200 且同样带双方 aiTrace；不再有 trace_denied（策略已推翻）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lrb'));
    const id = await legacyBattle(s, h.authed(a.token));
    const anon = await h.request(s.port, 'GET', `/api/v1/replay/${id}`);
    assert.equal(anon.status, 200, '遗留可读兼容性保留（帧本体仍可取）');
    assert.deepEqual([...ownersOf(anon.body)].sort(), ['p1', 'p2'], 'D-167：匿名读取同样返回双方 trace');
    assert.ok(anon.body.data.frames.length > 0, '帧本体（players/bullets/damages）不受影响');
    assert.ok(anon.body.data.frames.every((f) => f.diff.players && f.diff.players.p1), '帧结构完整');
    assert.ok(!s.runtime.logger.records.some((x) => x.event === 'api.replay.trace_denied'),
      'D-167 起不再产生 trace_denied（该裁剪逻辑已删除）');
    // 分片仍可用
    const slice = await h.request(s.port, 'GET', `/api/v1/replay/${id}?from=2&to=3`);
    assert.equal(slice.status, 200);
    assert.equal(slice.body.data.frames.length, 2);
  });
});

test('LR-3 非参与者（带 token）→ 403 replay_forbidden；side 声明只影响登记、不再影响裁剪', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lrc'));
    const outsider = await h.register(s.port, h.uniqueName('lrd'));
    const id = await legacyBattle(s, h.authed(a.token), { side: 'p2' }); // 调用方声明自己占 p2
    const mine = await h.request(s.port, 'GET', `/api/v1/replay/${id}`, undefined, h.authed(a.token));
    assert.equal(mine.status, 200, mine.raw);
    assert.deepEqual([...ownersOf(mine.body)].sort(), ['p1', 'p2'], 'D-167：不因 side 声明而裁剪');
    assert.equal(s.runtime.replayMeta.get(id).sides.p2, s.runtime.replayMeta.get(id).participants[0], 'side 声明仍登记');
    const other = await h.request(s.port, 'GET', `/api/v1/replay/${id}`, undefined, h.authed(outsider.token));
    assert.equal(other.status, 403, other.raw);
    assert.equal(other.body.error.code, 'replay_forbidden');
    assert.ok(s.runtime.logger.records.some((x) => x.event === 'api.reject' && x.data.code === 'replay_forbidden'));
    // 非法 side → 400（不静默按 p1）
    const bad = await h.request(s.port, 'POST', '/api/v1/battle', { p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 5, tier: TIER, side: 'p3' });
    assert.equal(bad.status, 400, bad.raw);
    assert.equal(bad.body.error.code, 'bad_request');
    // 匿名创建的 r* → participants 空 → 任意读取都带双方 trace（D-167）
    const anonId = await legacyBattle(s, undefined);
    const anonRead = await h.request(s.port, 'GET', `/api/v1/replay/${anonId}`);
    assert.equal(anonRead.status, 200);
    assert.deepEqual([...ownersOf(anonRead.body)].sort(), ['p1', 'p2'], '匿名创建的回放同样带双方 trace');
  });
});

test('LR-4 frames=debug 需管理员令牌；非法 frames 值 → 400；已废弃的 ?trace=* 被忽略', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('lre'));
    const id = await legacyBattle(s, h.authed(a.token));
    const url = `/api/v1/replay/${id}`;
    // 普通请求默认 render：不带 events（对外帧契约）
    const plain = await h.request(s.port, 'GET', url, undefined, h.authed(a.token));
    assert.equal(plain.status, 200);
    assert.ok(!('events' in plain.body.data.frames[0].diff), '默认帧不含引擎日志');
    // frames=debug 无（或错）管理员令牌 → 403
    const noTok = await h.request(s.port, 'GET', `${url}?frames=debug`, undefined, h.authed(a.token));
    assert.equal(noTok.status, 403, noTok.raw);
    assert.equal(noTok.body.error.code, 'forbidden');
    const badTok = await h.request(s.port, 'GET', `${url}?frames=debug`, undefined, { 'x-admin-token': 'nope' });
    assert.equal(badTok.status, 403);
    // 管理员 → 200（遗留 r<seq> 来自进程内注册表，已是 lean 形状 → 不含 events；归档回放才有日志）
    const adminDbg = await h.request(s.port, 'GET', `${url}?frames=debug`, undefined, { ...h.authed(a.token), 'x-admin-token': ADMIN });
    assert.equal(adminDbg.status, 200, adminDbg.raw);
    assert.ok(Array.isArray(adminDbg.body.data.frames) && adminDbg.body.data.frames.length > 0);
    // 非法 frames 值 → 400
    const badVal = await h.request(s.port, 'GET', `${url}?frames=nope`, undefined, h.authed(a.token));
    assert.equal(badVal.status, 400);
    assert.equal(badVal.body.error.code, 'bad_request');
    // 已废弃的 trace 参数被忽略（不再 400，也不再裁剪）
    const legacyParam = await h.request(s.port, 'GET', `${url}?trace=nope`, undefined, h.authed(a.token));
    assert.equal(legacyParam.status, 200, 'trace 参数已废弃 → 忽略');
    assert.deepEqual([...ownersOf(legacyParam.body)].sort(), ['p1', 'p2']);
  }, { server: { adminToken: ADMIN } });
});

test('LR-5 DL_LEGACY_STATELESS=0：遗留回放仍 410 deprecated（开关语义不变）', async () => {
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'GET', '/api/v1/replay/r1');
    assert.equal(r.status, 410, r.raw);
    assert.equal(r.body.error.code, 'deprecated');
  }, { server: { legacyStateless: false } });
});
