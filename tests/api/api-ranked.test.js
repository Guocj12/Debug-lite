'use strict';
// B24 /api/v1/ranked/run 端点测试 —— T-AP-1/2/3；契约 docs/interfaces.md §2。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const LD = require('../fixtures/loadout-ok.json');

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

async function withServer(t, fn) {
  const logger = createLogger({ level: 'debug', ringSize: 3000 });
  const s = await serverMod.start({ logger });
  try {
    await fn({ port: s.port, logger });
  } finally {
    await s.close();
  }
}

test('T-AP-1a POST /ranked/run：真实池 10 场全平（requested=10/matches=10/shortfall=0）+ seed 回带', async () => {
  await withServer(null, async ({ port }) => {
    const h = require('../helpers/ranked.js');
    // 10 个**真实构造**的对手档案快照（wait-only → 全平局），每个都带 playerId 溯源
    const pool = Array.from({ length: 10 }, (_, i) => {
      const x = h.waitOnly(LD.loadout, `w${i}`);
      x.playerId = h.makePlayerId(i + 1);
      return x;
    });
    const r = await request(port, 'POST', '/api/v1/ranked/run', {
      loadout: LD.loadout, warehouse: LD.warehouse, pool, seed: 20260913, tier: 'mythic',
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.requested, 10);
    assert.equal(r.body.data.matches, 10, '池里 10 个真实对手 → 打满 10 场');
    assert.equal(r.body.data.shortfall, 0);
    assert.equal(r.body.data.results.length, 10);
    assert.equal(r.body.data.seed, 20260913, 'seed 回带');
    assert.equal(r.body.data.wins + r.body.data.draws + r.body.data.losses + r.body.data.invalids, 10);
    assert.equal(r.body.data.wins, 0, '双方 wait-only → 全平局（平局不计胜）');
    assert.equal(typeof r.body.data.promoted, 'boolean');
    // HTTP 层当前只回带场次与胜负（不回带对手标识，见 QU-3 的"不暴露 playerId"口径）→
    // 这一段让位于 HTTP 契约：真实玩家可追溯性在模块层用同一份池逐场断言（见下）
    assert.equal(r.body.data.matches + r.body.data.shortfall, r.body.data.requested);
    // 模块层（同一份真实池）：每场对手都能追溯到真实 playerId
    const ranked = require('../../server/ranked.js');
    const direct = ranked.runRankedBattle({ loadout: LD.loadout, warehouse: LD.warehouse, pool, seed: 20260913, tier: 'mythic' });
    const poolIds = new Set(pool.map((x) => x.playerId));
    assert.ok(direct.data.results.every((m) => poolIds.has(m.opponentPlayerId)), '每场对手都是池中的真实 playerId');
    assert.equal(new Set(direct.data.results.map((m) => m.opponentPlayerId)).size, 10, '批次内 10 个互不相同的真实对手');
  });
});

test('T-AP-1b POST /ranked/run：无池 → 少打并如实回报 shortfall（禁止 bot 凑 10 场）', async () => {
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'POST', '/api/v1/ranked/run', {
      loadout: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic',
    });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.requested, 10);
    assert.equal(r.body.data.matches, 0, '无真实对手 → 一场都不打（不注入占位 bot）');
    assert.equal(r.body.data.shortfall, 10);
    assert.equal(r.body.data.results.length, 0);
    assert.equal(r.body.data.matches + r.body.data.shortfall, r.body.data.requested, 'matches + shortfall === requested');
    assert.equal(r.body.data.wins + r.body.data.draws + r.body.data.losses + r.body.data.invalids, r.body.data.matches);
  });
});

test('T-AP-3/T-AP-2 错误路径：409 no_loadout/loadout_invalid；400 bad_seed/bad_tier/bad_json', async () => {
  await withServer(null, async ({ port }) => {
    const noLd = await request(port, 'POST', '/api/v1/ranked/run', {});
    assert.equal(noLd.status, 409);
    assert.equal(noLd.body.error.code, 'no_loadout');
    const bad = JSON.parse(JSON.stringify(LD.loadout));
    bad.skills = bad.skills.slice(0, 2);
    const inv = await request(port, 'POST', '/api/v1/ranked/run', { loadout: bad, warehouse: LD.warehouse });
    assert.equal(inv.status, 409);
    assert.equal(inv.body.error.code, 'loadout_invalid');
    const badSeed = await request(port, 'POST', '/api/v1/ranked/run', { loadout: LD.loadout, warehouse: LD.warehouse, seed: 'x' });
    assert.equal(badSeed.status, 400);
    assert.equal(badSeed.body.error.code, 'bad_seed');
    const badTier = await request(port, 'POST', '/api/v1/ranked/run', { loadout: LD.loadout, tier: 'platinum' });
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');
    const bj = await request(port, 'POST', '/api/v1/ranked/run', '{nope');
    assert.equal(bj.status, 400);
    assert.equal(bj.body.error.code, 'bad_json');
    const badPool = await request(port, 'POST', '/api/v1/ranked/run', { loadout: LD.loadout, warehouse: LD.warehouse, pool: 'nope' });
    assert.equal(badPool.status, 400);
    assert.equal(badPool.body.error.code, 'bad_pool');
  });
});

test('B25 POST /ranked/promote：晋升/不晋升/顶段 409/参数 400', async () => {
  await withServer(null, async ({ port }) => {
    const ok = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'common', wins: 7 });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.data.tier, 'rare');
    assert.equal(ok.body.data.promoted, true);
    assert.equal(ok.body.data.reward, 'rare');
    const no = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'common', wins: 6 });
    assert.equal(no.status, 200);
    assert.equal(no.body.data.promoted, false);
    const max = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'mythic', wins: 7 });
    assert.equal(max.status, 409);
    assert.equal(max.body.error.code, 'already_max');
    const bt = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'platinum', wins: 7 });
    assert.equal(bt.status, 400);
    assert.equal(bt.body.error.code, 'bad_tier');
    const bw = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'common', wins: 'x' });
    assert.equal(bw.status, 400);
    assert.equal(bw.body.error.code, 'bad_wins');
    const bj = await request(port, 'POST', '/api/v1/ranked/promote', '{nope');
    assert.equal(bj.status, 400);
    assert.equal(bj.body.error.code, 'bad_json');
  });
});

/* ---------- P7-3 批次/身份接线（需要已装配 store；用 helpers/http.js 起落盘服务） ---------- */

const h = require('../helpers/http.js');

test('P1-4 排位批次级幂等（HTTP）：同 seed 重发 → 同 batchId、batchesPlayed 仅 +1、journal 零新增', async () => {
  await h.withServer(null, async (s) => {
    const me = await h.register(s.port, h.uniqueName('idem'));
    await h.register(s.port, h.uniqueName('idem2'));
    await h.register(s.port, h.uniqueName('idem3'));
    const meId = await h.playerIdByPublicId(s.store, me.publicId);
    const first = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 777001 }, h.authed(me.token));
    assert.equal(first.status, 200, first.raw);
    const d1 = first.body.data;
    assert.match(d1.batchId, /^bt_[0-9a-f]{16}$/, 'batchId 形状不变');
    assert.equal(d1.matches, 2, '同段位另 2 名真实玩家 → 2 场');
    assert.equal((await s.store.loadArchive(meId)).progress.batchesPlayed, 1);
    const seq1 = s.store.maxSeq();
    const countBatch = () => {
      const ids = [];
      return s.store.replayJournal({ fromSeq: 0 }, (rec) => {
        if (rec.type === 'battle.recorded' && rec.batchId === d1.batchId) ids.push(rec.battleId);
      }).then(() => ids);
    };
    assert.equal((await countBatch()).length, 2);

    // 同 seed 重发
    const again = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 777001 }, h.authed(me.token));
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.data.batchId, d1.batchId, '同 seed → 同 batchId');
    assert.equal(again.body.data.duplicate, true, '标注为回放');
    assert.equal(again.body.data.matches, d1.matches);
    assert.deepEqual(again.body.data.results.map((x) => x.battleId), d1.results.map((x) => x.battleId));
    assert.equal((await s.store.loadArchive(meId)).progress.batchesPlayed, 1, 'batchesPlayed 仅 +1（修前 1→2）');
    assert.equal(s.store.maxSeq(), seq1, 'journal 无任何新增（修前会新增 battle.recorded + ranked.batch）');
    assert.equal((await countBatch()).length, 2, 'battle.recorded 无新增');
    // 不同 seed → 新批次
    const other = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 777002 }, h.authed(me.token));
    assert.equal(other.status, 200, other.raw);
    assert.notEqual(other.body.data.batchId, d1.batchId);
    assert.equal((await s.store.loadArchive(meId)).progress.batchesPlayed, 2, '新 seed 才 +1');
  });
});

test('P2-5 真实注册玩家的默认出战配置按身份派生（HTTP）：≥2 种 AI 程序且对局能分出胜负', async () => {
  await h.withServer(null, async (s) => {
    const players = [];
    for (let i = 0; i < 6; i++) players.push(await h.register(s.port, h.uniqueName('p25')));
    const programs = new Set();
    for (const p of players) {
      const pid = await h.playerIdByPublicId(s.store, p.publicId);
      const slot = await h.activeSlotOf(s.store, pid);
      programs.add(JSON.stringify(slot.loadout.ai));
    }
    assert.ok(programs.size >= 2, `6 名真实注册玩家的默认 AI 至少 2 种（实得 ${programs.size}；修前恒为 move_left 一种）`);
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      const r = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 9000 + i }, h.authed(players[i].token));
      assert.equal(r.status, 200, r.raw);
      outcomes.push(r.body.data.winner);
    }
    assert.ok(outcomes.some((w) => w !== 'draw'), `真实玩家对局应出现非平局（实得 ${JSON.stringify(outcomes)}；修前 move_left 恒平）`);
  });
});

test('P2-1 门控同源：DL_DEBUG_BOTS=1 时 quick.match 与 ranked.pool 都标注 debug:true', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('dbg'));
    await h.register(s.port, h.uniqueName('dbg2'));
    const q = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 31 }, h.authed(a.token));
    assert.equal(q.status, 200, q.raw);
    const r = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 32 }, h.authed(a.token));
    assert.equal(r.status, 200, r.raw);
    assert.ok(s.logger.records.some((x) => x.event === 'quick.match' && x.data && x.data.debug === true),
      'quick 路径读到注入的 env（debug=true）');
    assert.ok(s.logger.records.some((x) => x.event === 'ranked.pool' && x.data && x.data.debug === true),
      'ranked 路径同样读到注入的 env（修前 withLogger 未注入 env → debug=false）');
  }, { server: { env: { ...process.env, DL_DEBUG_BOTS: '1' } } });
});
