'use strict';
/* tests/api/api-match-frames.test.js —— D-167：快速对战 / 排位批次**内联全量战斗过程**
 *
 * 用户口径（2026-09-25）：匹配成功后要能直接拿到"服务端算出来的完整战斗过程"，供前端逐 tick 表现；
 *   帧内容 = 画面数据（双方位置/朝向/五维/上限/行动/buff/基地血/碰撞/撞基地/弹幕生命周期/伤害数值）
 *   + **双方** aiTrace；**不含引擎日志 events**（日志走 `GET /replay/:id?frames=debug`，需管理员令牌）。
 * 体量实测（本文件断言 < 1 MB）：单场约 20–50 KB；10 场批次的响应体量必须远小于"带日志"的旧口径（约 2 MB）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');

const FRAME_KEYS = ['players', 'bullets', 'bases', 'collision', 'baseHits', 'bulletHits', 'damages', 'verdict', 'aiTrace'];

// N-7（既有已知项）：effect 的 uid 是**进程级自增**，两次重算之间会不同 → 比对前按"首现序"重编号
//   （与 tests/api/api-replay-auth.test.js 的 RP-3/RP-8 同一口径；只抹平 uid，不掩盖任何其它差异）
function normalizeEffectUids(frames) {
  const clone = JSON.parse(JSON.stringify(frames));
  const map = new Map();
  let n = 0;
  for (const f of clone) {
    for (const o of ['p1', 'p2']) {
      for (const e of f.diff.players[o].effects || []) {
        if (e.uid === null || e.uid === undefined) continue;
        if (!map.has(e.uid)) map.set(e.uid, `eff_${n++}`);
        e.uid = map.get(e.uid);
      }
    }
  }
  return clone;
}

function assertFrameShape(frames, ticks, label) {
  assert.ok(Array.isArray(frames), `${label}：frames 必须是数组`);
  assert.equal(frames.length, ticks, `${label}：帧数应等于 ticks`);
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    assert.equal(f.tick, i + 1, `${label}：tick 连续`);
    const d = f.diff;
    for (const k of FRAME_KEYS) assert.ok(k in d, `${label}：帧缺字段 ${k}`);
    assert.ok(!('events' in d), `${label}：对外帧不得带 events`);
    for (const o of ['p1', 'p2']) {
      const pl = d.players[o];
      for (const k of ['x', 'maxHp', 'atk', 'def']) assert.equal(typeof pl[k === 'x' ? 'toX' : k], 'number', `${label}：${o}.${k}`);
      assert.ok(pl.action && typeof pl.action.kind === 'string', `${label}：${o}.action 齐备`);
      assert.ok(Array.isArray(pl.effects), `${label}：${o}.effects 齐备`);
    }
  }
  const owners = new Set(frames.flatMap((f) => f.diff.aiTrace.map((x) => x.owner)));
  assert.deepEqual([...owners].sort(), ['p1', 'p2'], `${label}：must carry both sides' aiTrace`);
}

test('MF-1 快速对战：响应内联完整战斗过程（帧形状/双方 trace/无日志/体量上限）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('mfa'), undefined, { publicId: 'u_mf100001', playerId: 'pl_mf10000000000001' });
    const b = await h.register(s.port, h.uniqueName('mfb'), undefined, { publicId: 'u_mf100002', playerId: 'pl_mf10000000000002' });
    const r = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 20260925 }, h.authed(a.token));
    assert.equal(r.status, 200, r.raw.slice(0, 300));
    const d = r.body.data;
    assert.equal(typeof d.battleId, 'string');
    assert.ok(Number.isInteger(d.ticks) && d.ticks > 0);
    assertFrameShape(d.frames, d.ticks, 'quick');
    // 体量：单场内联远小于"带引擎日志"的旧口径（实测旧口径 92–219 KB，其中 76–84% 是 events）
    const bytes = Buffer.byteLength(JSON.stringify(d.frames), 'utf8');
    assert.ok(bytes < 300 * 1024, `单场帧体量应 < 300 KB（实测 ${Math.round(bytes / 1024)} KB）`);
    // 帧与归档回放（同一 battleId）**逐帧一致**：内联过程 = 服务端重算结果
    const rep = await h.request(s.port, 'GET', `/api/v1/replay/${d.battleId}`, undefined, h.authed(a.token));
    assert.equal(rep.status, 200, rep.raw.slice(0, 200));
    assert.deepEqual(normalizeEffectUids(rep.body.data.frames), normalizeEffectUids(d.frames), '内联帧与 GET /replay 的帧必须一致（同一真源；仅 effect uid 按 N-7 抹平）');
  });
});

test('MF-2 锦标赛：10 场每场内联过程 + 批次响应体量上限 + shortfall 如实', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('mfc'), undefined, { publicId: 'u_mf200001', playerId: 'pl_mf20000000000001' });
    // 造池：管理端注入 12 个 bot（D-166：各自不同预设）——避免注册限速并保证池充足
    const ADMIN = 'mf-admin';
    const inj = await h.request(s.port, 'POST', '/api/v1/admin/bots', { count: 12, tier: 'common', points: 0, botKey: 'mf' }, { 'x-admin-token': ADMIN });
    assert.equal(inj.status, 200, inj.raw.slice(0, 200));
    const r = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 20260925 }, h.authed(a.token));
    assert.equal(r.status, 200, r.raw.slice(0, 300));
    const d = r.body.data;
    assert.equal(d.requested, 10);
    assert.ok(d.matches >= 1, '至少一场');
    assert.ok(d.results.length === d.matches, 'results 数与 matches 一致');
    for (const m of d.results) {
      if (m.winner === 'invalid') continue;
      assertFrameShape(m.frames, m.ticks, `ranked#${m.match}`);
    }
    // 体量上限：10 场内联（含双方 trace）应远小于旧口径（events 占 76–84%）
    const bytes = Buffer.byteLength(r.raw, 'utf8');
    assert.ok(bytes < 1024 * 1024, `批次响应应 < 1 MB（实测 ${Math.round(bytes / 1024)} KB）`);
    // 每场都能按 battleId 取回同一份帧（归档回放与内联同源）
    const first = d.results.find((m) => m.battleId);
    const rep = await h.request(s.port, 'GET', `/api/v1/replay/${first.battleId}`, undefined, h.authed(a.token));
    assert.equal(rep.status, 200, rep.raw.slice(0, 200));
    assert.deepEqual(normalizeEffectUids(rep.body.data.frames), normalizeEffectUids(first.frames), '归档回放帧与内联帧一致（仅 effect uid 按 N-7 抹平）');
  }, { server: { adminToken: 'mf-admin', env: { DL_ADMIN_TOKEN: 'mf-admin', DL_DEBUG_BOTS: '1' } } });
});

test('MF-3 内联帧足以表现战斗：伤害/弹幕/碰撞都带位置与结局（不依赖 events）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('mfd'), undefined, { publicId: 'u_mf300001', playerId: 'pl_mf30000000000001' });
    const b = await h.register(s.port, h.uniqueName('mfe'), undefined, { publicId: 'u_mf300002', playerId: 'pl_mf30000000000002' });
    const r = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 7 }, h.authed(a.token));
    assert.equal(r.status, 200);
    const frames = r.body.data.frames;
    const bullets = frames.flatMap((f) => f.diff.bullets);
    if (bullets.length > 0) {
      for (const bd of bullets) {
        assert.ok(['hit', 'collide', 'expire'].includes(bd.outcome), `弹幕结局非法: ${bd.outcome}`);
        assert.ok(Number.isInteger(bd.spawnX) && Number.isInteger(bd.endX), '弹幕出现/消失位置都必须是 1px 整数');
        if (bd.outcome === 'hit') assert.ok(bd.hitTarget === 'p1' || bd.hitTarget === 'p2', 'hit 必须给出命中目标');
        if (bd.outcome === 'collide') assert.ok(typeof bd.collideWith === 'string' && bd.collideWith !== '', 'collide 必须给出对手弹幕 uid');
      }
    }
    const damages = frames.flatMap((f) => f.diff.damages);
    assert.ok(damages.length > 0, '本局应有伤害（否则用例空转）');
    for (const dm of damages) {
      assert.ok(['bullet', 'collision', 'base', 'overtime'].includes(dm.kind), `伤害来源非法: ${dm.kind}`);
      assert.ok(dm.target === 'p1' || dm.target === 'p2');
      assert.ok(Number.isInteger(dm.amount) && dm.amount >= 0);
    }
    // hp 变化必须能被 damages 解释（regen 只会让净下降变小）
    for (let i = 1; i < frames.length; i++) {
      for (const o of ['p1', 'p2']) {
        const before = frames[i - 1].diff.players[o].hp;
        const after = frames[i].diff.players[o].hp;
        if (after >= before) continue;
        const sum = frames[i].diff.damages.filter((dm) => dm.target === o).reduce((n, dm) => n + dm.amount, 0);
        assert.ok(before - after <= sum, `tick${i + 1} ${o} 掉血 ${before - after} 无法由 damages(${sum}) 解释`);
      }
    }
  });
});
