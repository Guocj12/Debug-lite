'use strict';
// B16 /api/v1/ai/* 端点测试 —— T-AP-1/2/3/4/5 + T-LG-8；契约 docs/interfaces.md §2
// （信封/错误码）、 systems/08-ai.md §4.7、examples A-10。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const FIXTURES = require('../fixtures/ai-programs.json');
const prog = (key) => JSON.parse(JSON.stringify(FIXTURES[key].program));

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: body ? { 'content-type': 'application/json' } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
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
  const logger = createLogger({ level: 'debug', ringSize: 20000 });
  const s = await serverMod.start({ logger });
  try {
    await fn({ port: s.port, logger });
  } finally {
    await s.close();
  }
}

test('T-AP-1 /ai/validate + /ai/compile 正常路径：信封 + programHash + 统计', async () => {
  await withServer(null, async ({ port }) => {
    const v = await request(port, 'POST', '/api/v1/ai/validate', { program: prog('a1Countdown'), tier: 'common' });
    assert.equal(v.status, 200);
    assert.equal(v.body.ok, true);
    assert.equal(v.body.data.ok, true);
    assert.ok(Array.isArray(v.body.data.warnings), 'B26 validate 回带 warnings 通道（无 warning 时为空数组）');
    assert.equal(typeof v.body.log.level, 'string');
    const c = await request(port, 'POST', '/api/v1/ai/compile', { program: prog('a1Countdown') });
    assert.equal(c.status, 200);
    assert.equal(c.body.ok, true);
    assert.equal(typeof c.body.data.programHash, 'string');
    assert.equal(c.body.data.programHash.length, 64);
    assert.equal(c.body.data.version, 2, 'v1 输入被迁移到当前版本');
    assert.equal(c.body.data.migrated, true);
    assert.ok(c.body.data.stats.nodes > 0 && typeof c.body.data.stats.depth === 'number');
    assert.ok(Array.isArray(c.body.data.stats.usedNodeTypes));
    assert.ok(Array.isArray(c.body.data.warnings), 'B26 compile 回带 warnings 通道');
    // 同程序两次 compile hash 一致（A-10a/b 经 API）
    const c2 = await request(port, 'POST', '/api/v1/ai/compile', { program: prog('a1Countdown') });
    assert.equal(c2.body.data.programHash, c.body.data.programHash, 'hash 确定性');
  });
});

test('T-AP-1/2 /ai/battle 正常路径：服务端执行 + 帧含 aiTraces + seed 回带', async () => {
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), seed: 20260912, opponent: 'kiter' });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.data.seed, 20260912, 'seed 显式回带（T-AP-5）');
    assert.ok(['p1', 'p2', 'draw'].includes(r.body.data.winner));
    assert.equal(typeof r.body.data.ticks, 'number');
    assert.equal(r.body.data.ticks, r.body.data.frames.length, '帧数 == tick 数');
    const f1 = r.body.data.frames[0];
    assert.ok(Array.isArray(f1.aiTrace) && f1.aiTrace.length > 0, '首帧含 AI trace（冻结字段 diff.aiTrace）');
    const last = f1.aiTrace[f1.aiTrace.length - 1];
    assert.equal(last.nodeType, 'action', '末条为 action');
    assert.equal(last.result, 'move_right', '首 tick 行动 = move_right（n=0 < 2 → then 分支）');
    assert.equal(last.path, 'body.s[1].then.s[1]', 'trace 路径规范');
    assert.equal(f1.aiTrace[0].path, 'body.s[0]', 'trace 从 var 语句开始');
  });
});

test('T-AP-4 服务端重新执行、不信任客户端结果：同 seed 两次一致；伪造 result 字段被忽略', async () => {
  await withServer(null, async ({ port }) => {
    const body = { program: prog('a2Breakpoint'), seed: 4242, opponent: 'charger' };
    const r1 = await request(port, 'POST', '/api/v1/ai/battle', body);
    const r2 = await request(port, 'POST', '/api/v1/ai/battle', body);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.deepEqual(
      { winner: r2.body.data.winner, ticks: r2.body.data.ticks, frames: r2.body.data.frames },
      { winner: r1.body.data.winner, ticks: r1.body.data.ticks, frames: r1.body.data.frames },
      '同 seed 完全复现',
    );
    // 客户端携带伪造结果 → 服务端忽略（不信任客户端结果，T-AP-4）
    const fake = await request(port, 'POST', '/api/v1/ai/battle', { ...body, result: { winner: 'p1', ticks: 1 } });
    assert.equal(fake.body.data.winner, r1.body.data.winner, '伪造 result 不影响服务端重执行');
    assert.equal(fake.body.data.ticks, r1.body.data.ticks);
  });
});

test('T-AP-5 seed 缺省：服务端生成并回带；携带回带 seed 可复现', async () => {
  await withServer(null, async ({ port }) => {
    const r1 = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a2Breakpoint') });
    assert.equal(r1.status, 200);
    const seed = r1.body.data.seed;
    assert.ok(Number.isInteger(seed) && seed >= 1, `服务端生成 seed=${seed}`);
    const r2 = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a2Breakpoint'), seed });
    assert.equal(r2.body.data.winner, r1.body.data.winner, '带 seed 复现同结果');
    assert.equal(r2.body.data.ticks, r1.body.data.ticks);
  });
});

test('T-AP-2 参数错误：bad_json / bad_ai / bad_tier / bad_seed → 400 + error.code', async () => {
  await withServer(null, async ({ port }) => {
    const badJson = await request(port, 'POST', '/api/v1/ai/validate', '{nope');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    const noProg = await request(port, 'POST', '/api/v1/ai/validate', {});
    assert.equal(noProg.status, 400);
    assert.equal(noProg.body.error.code, 'bad_ai');
    const badTier = await request(port, 'POST', '/api/v1/ai/validate', { program: prog('a1Countdown'), tier: 'diamond' });
    assert.equal(badTier.status, 400);
    assert.equal(badTier.body.error.code, 'bad_tier');
    // P2-2：battle 同样拒绝非法 tier（不得落入误导性 ai_invalid+node_locked）
    const battleBadTier = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), tier: 'diamond' });
    assert.equal(battleBadTier.status, 400);
    assert.equal(battleBadTier.body.error.code, 'bad_tier');
    const badSeed = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), seed: 'abc' });
    assert.equal(badSeed.status, 400);
    assert.equal(badSeed.body.error.code, 'bad_seed');
    const zeroSeed = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), seed: 0 });
    assert.equal(zeroSeed.status, 400);
    assert.equal(zeroSeed.body.error.code, 'bad_seed');
  });
});

test('T-AP-3 业务拒绝与校验失败：未知对手 409 unknown_opponent；病态程序 400 ai_invalid 带路径', async () => {
  await withServer(null, async ({ port }) => {
    const opp = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), opponent: 'nope' });
    assert.equal(opp.status, 409);
    assert.equal(opp.body.error.code, 'unknown_opponent');
    const bad = await request(port, 'POST', '/api/v1/ai/validate', { program: { type: 'program', version: 1, body: { type: 'seq', statements: [
      { type: 'loop', kind: 'count', times: { type: 'literal', value: 2 }, body: { type: 'seq', statements: [{ type: 'set', name: 'x', value: { type: 'literal', value: 1 } }] } },
    ] } }, tier: 'rare' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'ai_invalid');
    assert.ok(Array.isArray(bad.body.error.details) && bad.body.error.details.length > 0);
    assert.equal(bad.body.error.details[0].code, 'branch_without_action', '错误带节点路径与 code');
    assert.equal(typeof bad.body.error.details[0].path, 'string');
    // v3 版本 → 信封 ai_invalid，details 带 ai_version_unsupported
    const p3 = prog('a1Countdown');
    p3.version = 3;
    const v3 = await request(port, 'POST', '/api/v1/ai/validate', { program: p3 });
    assert.equal(v3.status, 400);
    assert.equal(v3.body.error.code, 'ai_invalid', 'validate 信封主码固定 ai_invalid');
    assert.equal(v3.body.error.details[0].code, 'ai_version_unsupported');
    // P2-7：compile v3 同样拒绝（信封码 = 首个错误码 ai_version_unsupported）
    const c3 = await request(port, 'POST', '/api/v1/ai/compile', { program: p3 });
    assert.equal(c3.status, 400);
    assert.equal(c3.body.error.code, 'ai_version_unsupported');
  });
});

test('T-LG-8 API 日志：ai 端点经服务端 logger 记录 ai.migrate/ai.validate/api.req/api.res 等事件', async () => {
  await withServer(null, async ({ port, logger }) => {
    await request(port, 'POST', '/api/v1/ai/compile', { program: prog('a1Countdown') });
    assert.ok(logger.records.some((x) => x.event === 'api.req' && x.data.path === '/api/v1/ai/compile'), 'api.req');
    assert.ok(logger.records.some((x) => x.event === 'api.res' && x.data.path === '/api/v1/ai/compile'), 'api.res');
    assert.ok(logger.records.some((x) => x.event === 'ai.migrate'), 'ai.migrate（v1 → v2）');
    await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a2Breakpoint'), seed: 11 });
    assert.ok(logger.records.some((x) => x.event === 'battle.create'), 'battle.create');
    assert.ok(logger.records.some((x) => x.event === 'tick.begin'), 'tick.begin');
    assert.ok(logger.records.some((x) => x.event === 'ai.action'), 'ai.action（运行时续执行接入引擎）');
  });
});

// B26：投影快照字段扩充（D-107 白名单投影）——baseHp 语义修正 + 上限/冷却/效果/基地/ tick
test('B26 projectSnapshot：baseHp=基地当前血量（≠ maxHp）；max*/cooldowns/effects/bases/tick 齐备且为只读副本', () => {
  const runner = require('../../server/runner.js');
  const engine = require('../../server/core/engine.js');
  const { createLogger } = require('../../shared/log.js');
  const p1 = runner.baselinePlayer('p1');
  const p2 = runner.baselinePlayer('p2');
  p1.cooldowns = { skill1: 3, skill2: 0 };
  p1.effects = [
    { uid: 'eff_1', kind: 'continuous', stat: 'hp', delta: -2, remaining: 2, addedTick: 0, target: 'p1' },
    { uid: 'eff_2', kind: 'control', displacement: 1, remaining: 1, addedTick: 0, target: 'p1' },
  ];
  const b = engine.createBattle(undefined, { seed: 1, players: { p1, p2 }, logger: createLogger({ level: 'silent' }) });
  const snap = runner.projectSnapshot(b.state, 'p1');
  // 字段齐备
  assert.equal(snap.tick, 0, 'tick 投影');
  for (const k of ['hp', 'maxHp', 'mp', 'maxMp', 'sp', 'maxSp', 'atk', 'def', 'x', 'facing', 'baseHp']) {
    assert.equal(typeof snap.self[k], 'number', `self.${k}`);
    assert.equal(typeof snap.enemy[k], 'number', `enemy.${k}`);
  }
  assert.equal(typeof snap.bases.self.hp, 'number', 'bases.self.hp（基地血量可读路径）');
  assert.equal(typeof snap.bases.enemy.hp, 'number', 'bases.enemy.hp');
  // D-138 防回归：快照**不投影** `bullets`（AI 无法观测弹幕＝设计，弹幕当 tick 全解算）
  assert.ok(!('bullets' in snap), 'snapshot 不得包含 bullets 字段（D-138）');
  assert.deepEqual(Object.keys(snap).sort(), ['bases', 'enemy', 'field', 'self', 'tick'], 'snapshot 顶层字段固定（无 bullets）');
  // 语义：baseHp = 基地当前血量；maxHp = 角色上限（两者概念不同）
  assert.equal(snap.self.baseHp, b.state.bases.p1.hp, 'self.baseHp 取基地当前血量');
  assert.equal(snap.enemy.baseHp, b.state.bases.p2.hp, 'enemy.baseHp 取对方基地当前血量');
  assert.equal(snap.self.maxHp, p1.maxHp, 'self.maxHp 取角色上限');
  assert.equal(snap.bases.self.hp, snap.self.baseHp, 'bases.self.hp 与 self.baseHp 同源');
  // 基地掉血后 baseHp 跟随变化，而 maxHp 不变（反例：旧实现把基地血量填成角色 maxHp）
  b.state.bases.p1.hp = 37;
  const snap2 = runner.projectSnapshot(b.state, 'p1');
  assert.equal(snap2.self.baseHp, 37, '基地掉血 → baseHp 跟随');
  assert.equal(snap2.self.maxHp, 100, 'maxHp 仍是角色上限');
  // cooldowns / effects：只读副本（与引擎状态不同一引用；数值/摘要形状正确）
  assert.deepEqual(snap.self.cooldowns, { skill1: 3, skill2: 0 });
  assert.notEqual(snap.self.cooldowns, p1.cooldowns, 'cooldowns 必须是副本（不泄漏引擎对象）');
  assert.equal(snap.self.effects.length, 2);
  assert.notEqual(snap.self.effects, p1.effects, 'effects 必须是副本');
  assert.deepEqual(snap.self.effects[0], { uid: 'eff_1', kind: 'continuous', stat: 'hp', delta: -2, displacement: null, remaining: 2 });
  assert.deepEqual(snap.self.effects[1], { uid: 'eff_2', kind: 'control', stat: null, delta: null, displacement: 1, remaining: 1 });
  assert.deepEqual(snap.enemy.cooldowns, {}, 'enemy 对称投影');
  assert.deepEqual(snap.enemy.effects, []);
  // 投影不得泄漏引擎引用：改写副本不影响引擎状态
  snap.self.cooldowns.skill1 = 99;
  snap.self.effects[0].remaining = 99;
  assert.equal(p1.cooldowns.skill1, 3, '副本可写性与引擎解耦');
  assert.equal(p1.effects[0].remaining, 2);
});

// B26：/ai/battle 明确回报"技能没生效"（C 方案：保持无技能，但响应可自证）
test('B26 /ai/battle 未生效动作回报：actionsEffective + ineffectiveActions + frames[].events(action.invalid)', async () => {
  await withServer(null, async ({ port }) => {
    const program = {
      type: 'program', version: 2,
      body: { type: 'seq', statements: [{ type: 'action', name: 'skill:skill1' }] },
    };
    const r = await request(port, 'POST', '/api/v1/ai/battle', { program, seed: 20260912, opponent: 'kiter' });
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    // 既有字段不破坏
    assert.equal(d.seed, 20260912);
    assert.equal(typeof d.programHash, 'string');
    assert.ok(['p1', 'p2', 'draw'].includes(d.winner));
    assert.equal(typeof d.ticks, 'number');
    assert.equal(d.ticks, d.frames.length);
    // 新增：未生效动作回报
    assert.equal(typeof d.actionsEffective, 'number', 'actionsEffective');
    assert.equal(typeof d.ineffectiveActions, 'object', 'ineffectiveActions');
    assert.ok(d.ineffectiveActions.count > 0, 'skill:skill1 未装配 → 未生效计数 > 0');
    assert.ok(d.ineffectiveActions.byReason.unknown_skill > 0, '原因归类 unknown_skill');
    assert.equal(d.actionsEffective + (d.ineffectiveActions.byOwner.p1 || 0), d.ticks, '生效 + 未生效 = tick 数');
    // 帧 events 能看出"我写了 skill:skill1 但一次都没放出来"
    const f1 = d.frames[0];
    assert.ok(f1.actions && typeof f1.actions === 'object', '帧级动作计数 {effective,ineffective}');
    assert.equal(f1.actions.ineffective, 1, '本帧 1 个未生效动作');
    assert.equal(f1.actions.effective, 0, 'skill:skill1 从未生效');
    assert.ok(Array.isArray(f1.events) && f1.events.length > 0, '帧 events 回带 action.invalid');
    const inv = f1.events.find((e) => e.event === 'action.invalid');
    assert.ok(inv, 'action.invalid 记录');
    assert.equal(inv.tick, 1, '事件带 tick（回放帧契约）');
    assert.equal(typeof inv.cid, 'string', '事件带 cid');
    assert.equal(inv.data.reason, 'unknown_skill');
    assert.equal(inv.data.sid, 'skill1');
    assert.equal(f1.aiTrace[f1.aiTrace.length - 1].result, 'skill:skill1', 'AI 确有产出该动作');
    // 无未生效动作时：计数为 0 + 帧 events 空数组（对照：纯引擎词汇表内的合法动作）
    const okProgram = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } };
    const ok = await request(port, 'POST', '/api/v1/ai/battle', { program: okProgram, seed: 20260912, opponent: 'kiter' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.ineffectiveActions.count, 0, '合法动作 → 0 个未生效');
    assert.equal(ok.body.data.actionsEffective, ok.body.data.ticks, '全部生效');
    assert.deepEqual(ok.body.data.frames[0].events, [], '无失败动作 → 帧 events 空');
    assert.ok(ok.body.data.frames[0].aiTrace.length > 0, '每 tick 仍有全量 aiTrace');
    // 迁移后的 a1Countdown 含词汇表外动作名 skill1（缺 skill: 前缀）→ 逐次未生效被抓到（D-80 仍归一化 wait）
    const legacy = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), seed: 20260912, opponent: 'kiter' });
    assert.equal(legacy.status, 200);
    assert.ok(legacy.body.data.ineffectiveActions.count > 0, '词汇表外动作名被计为未生效');
    assert.ok(legacy.body.data.ineffectiveActions.byReason.invalid_action > 0, '原因归类 invalid_action');
    assert.equal(legacy.body.data.actionsEffective + legacy.body.data.ineffectiveActions.count, legacy.body.data.ticks, '生效 + 未生效 = tick 数');
    assert.equal(typeof legacy.body.data.ineffectiveActions.actions[0].tick, 'number', '逐动作摘要带 tick');
    assert.ok(Array.isArray(legacy.body.data.ineffectiveActions.actions[0].reasons), '逐动作摘要带去重原因集');
    assert.ok(Array.isArray(legacy.body.data.warnings), 'warnings 通道恒为数组（B26 与并行任务的 ast.validate 对齐）');
  });
});

test('B26 每 tick 全量 aiTrace：不累积、不重复（trace 每 tick 重置的后司机契约）', async () => {
  await withServer(null, async ({ port }) => {
    const r = await request(port, 'POST', '/api/v1/ai/battle', { program: prog('a1Countdown'), seed: 20260912, opponent: 'kiter' });
    assert.equal(r.status, 200);
    const frames = r.body.data.frames;
    for (const f of frames) {
      for (const e of f.aiTrace) {
        assert.equal(e.tick, f.tick, `tick ${f.tick} 的 aiTrace 只含本 tick 条目`);
        assert.equal(typeof e.seq, 'number');
      }
      const seqs = f.aiTrace.map((e) => e.seq);
      assert.deepEqual(seqs, seqs.map((_, i) => i), `tick ${f.tick} trace seq 从 0 连续（本 tick 全量）`);
    }
  });
});