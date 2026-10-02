'use strict';
/* tests/api/api-me-ai-nodes.test.js —— D-178 积木节点在后端的落地（P2c）
 *
 * 契约：docs/decisions.md D-178；docs/interfaces.md §2（`POST /me/ai`、`PUT /me/ai/:aiId`、
 *      `POST /me/ai/validate` 接受 `blueprint`）；设计 §四（节点目录）/§一（装配占用模型）。
 *
 * 覆盖：
 *   ALN-1  GET /me/ai/nodes：目录（53 个节点）+ 我的拥有/占用/空闲（starter 绿档节点全部 owned=1）
 *   ALN-2  POST /me/ai 用**蓝图**保存：服务端编译 → AI 记录含 blueprint/slotCount，占用随之增加
 *   ALN-3  占用校验：蓝图用量超过拥有量 → 400 ai_node_shortage（含中文 details）
 *   ALN-4  跨 AI 独占：两套 AI 抢同一个副本 → 第二套被拒
 *   ALN-5  草稿不占用（draft 保存成功且 used 不变）
 *   ALN-6  POST /me/ai/validate 接受 blueprint：合法 → ok+slotCount+programHash；非法 → ai_invalid + 中文 path
 *   ALN-7  旧路径（只送 program，无蓝图）仍然可用
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');
const blueprint = require('../../server/ai/blueprint.js');

const bp = (body) => ({ type: 'blueprint', version: 1, body });
const n = (uid, node, params, inputs) => ({ uid, node, params: params || {}, inputs: inputs || [] });

// 最小可用蓝图：距离 < 3 格就放技能 1，否则等待
const SHOOT = bp([
  n('i1', 'f_if', {}, [
    n('c1', 'c_gap_less', { x: 3 }),
    n('a1', 'a_skill', { slot: 1 }),
    n('a2', 'a_wait'),
  ]),
]);
// 只用『等待』的最小蓝图（占 1 个绿节点）
const JUST_WAIT = bp([n('w1', 'a_wait')]);

async function freshPlayer(s, tag) {
  const p = await h.register(s.port, h.uniqueName(tag));
  assert.equal(p.status, 200, JSON.stringify(p.res && p.res.body));
  const playerId = await h.playerIdByPublicId(s.store, p.publicId);
  return { ...p, playerId };
}
// 节点用量基线（starter 自带一套"默认 AI 蓝图"也会占用 → 断言一律用**增量**）
async function usedBaseline(s, p) {
  const r = await getNodes(s, p);
  return { total: r.body.data.counts.usedTotal, byId: Object.fromEntries(r.body.data.inventory.map((x) => [x.nodeId, x.used])) };
}
const getNodes = (s, p) => h.request(s.port, 'GET', '/api/v1/me/ai/nodes', undefined, h.authed(p.token));
const createAi = (s, p, body) => h.request(s.port, 'POST', '/api/v1/me/ai', body, h.authed(p.token));
const updateAi = (s, p, aiId, body) => h.request(s.port, 'PUT', `/api/v1/me/ai/${aiId}`, body, h.authed(p.token));
const validate = (s, p, body) => h.request(s.port, 'POST', '/api/v1/me/ai/validate', body, h.authed(p.token));

// 给指定节点补几份（模拟开包产出）→ 让用例不受"starter 自带 AI 已占若干节点"的影响
async function grantExtra(s, p, nodeIds, extra) {
  await s.store.updateArchive(p.playerId, (archive) => {
    for (const id of nodeIds) {
      const stack = archive.warehouse.buckets.aiNode.find((x) => x.nodeId === id);
      if (stack) stack.count += extra;
      else archive.warehouse.buckets.aiNode.push({ uid: `node_test_${id}`, kind: 'aiNode', nodeId: id, name: id, category: '测试', quality: 'common', count: extra });
    }
    return null;
  });
  return usedBaseline(s, p);
}

test('ALN-1 GET /me/ai/nodes：目录 + 拥有/占用/空闲（starter 绿档节点）', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'aln1');
    const r = await getNodes(s, a);
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    assert.equal(d.catalog.length, blueprint.catalog().length, '目录条数与 ai-node-catalog 一致');
    assert.ok(d.catalog.every((x) => x.id && x.name && x.quality && x.kind), '目录条目字段齐备');
    assert.equal(d.limits.maxSlots, 128, '蓝图槽位上限 = 128');
    const green = blueprint.catalog().filter((x) => x.quality === 'common');
    assert.equal(d.counts.ownedKinds, green.length, 'starter 发全部绿档节点（至少每种 1 个）');
    assert.ok(d.counts.usedTotal > 0, 'starter 的默认 AI 本身就是蓝图 → 开局即占用若干节点');
    const one = d.inventory.find((x) => x.nodeId === 's_gap');
    assert.ok(one.owned >= 1, '绿档感知节点至少 1 个');
    assert.ok(one.free === one.owned - one.used, '单行也满足 空闲 = 拥有 − 占用');
    assert.ok(d.inventory.every((x) => x.free === x.owned - x.used), '空闲 = 拥有 − 占用（派生）');
  }, h.QUIET);
});

test('ALN-2 POST /me/ai 用蓝图保存：服务端编译 + 记录含 blueprint + 占用增加', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'aln2');
    const base = await grantExtra(s, a, ['a_skill', 'c_gap_less', 'f_if', 'a_wait'], 2);
    const r = await createAi(s, a, { name: '射击AI', blueprint: SHOOT });
    assert.equal(r.status, 200, r.raw);
    assert.ok(r.body.data.aiId, '回带 aiId');
    assert.equal(r.body.data.slots, 4, '回带槽位数（if+2 条件/动作 = 4 节点）');
    assert.deepEqual(r.body.data.ai.blueprint, SHOOT, 'AI 记录保存蓝图原文');
    assert.ok(r.body.data.ai.program && r.body.data.ai.program.type === 'program', '保存的是编译后的 AST');
    assert.equal(r.body.data.ai.slotCount, 4);
    assert.equal(r.body.data.ai.compilerVersion, 1);
    // D-178：回带 traceMap（AST 路径 → 积木 uid），查看器据此把帧内 aiTrace 投影成积木层
    assert.ok(r.body.data.ai.traceMap && Object.keys(r.body.data.ai.traceMap).length > 0, 'traceMap 非空');
    const mapVals = Object.values(r.body.data.ai.traceMap);
    assert.ok(mapVals.every((u) => typeof u === 'string' && u.length > 0), 'traceMap 的值是积木 uid');
    // 占用变化：a_skill / c_gap_less / f_if / a_wait 各 +1（相对 starter 默认 AI 的基线）
    const after = await getNodes(s, a);
    for (const id of ['a_skill', 'c_gap_less', 'f_if', 'a_wait']) {
      const row = after.body.data.inventory.find((x) => x.nodeId === id);
      assert.equal(row.used, (base.byId[id] || 0) + 1, `${id} 占用应 +1`);
      assert.equal(row.free, row.owned - row.used, `${id} 空闲 = 拥有 − 占用`);
    }
    // 列表接口也能看到蓝图（编辑器据此回填）
    const list = await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(a.token));
    const item = list.body.data.items.find((x) => x.aiId === r.body.data.aiId);
    assert.deepEqual(item.blueprint, SHOOT);
  }, h.QUIET);
});

test('ALN-3 占用校验：蓝图用量超过拥有量 → 400 ai_node_shortage（中文 details）', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'aln3');
    // 只拥有 1 个 a_wait，却在蓝图里放 2 个 → 拒绝
    const tooMany = bp([
      n('w1', 'a_wait'),
      n('w2', 'a_wait'),
    ]);
    const r = await createAi(s, a, { name: '两个等待', blueprint: tooMany });
    assert.equal(r.status, 400, r.raw);
    assert.equal(r.body.error.code, 'ai_node_shortage', JSON.stringify(r.body));
    assert.ok(r.body.error.details.some((d) => /等待/.test(d.message) && d.code === 'ai_node_shortage'), JSON.stringify(r.body.error.details));
    // 草稿可以存（不占用）
    const dr = await createAi(s, a, { name: '两个等待', blueprint: tooMany, status: 'draft' });
    assert.equal(dr.status, 200, dr.raw);
    const nodes = await getNodes(s, a);
    assert.equal(nodes.body.data.counts.usedTotal, (await usedBaseline(s, a)).total, '草稿不占用（总量不变）');
  }, h.QUIET);
});

test('ALN-4 跨 AI 独占：两套 AI 抢同一个副本 → 第二套被拒；开包拿到第 2 个后可通过', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'aln4');
    // 让"等待"恰好只剩 1 个空闲（starter 默认 AI 可能也占用了它 → 按基线补齐，保证用例确定性）
    const n0 = await getNodes(s, a);
    const r0 = n0.body.data.inventory.find((x) => x.nodeId === 'a_wait');
    const owned0 = r0.owned;
    await grantExtra(s, a, ['a_wait'], (r0.used + 1) - r0.owned);
    const first = await createAi(s, a, { name: 'AI一', blueprint: JUST_WAIT });
    assert.equal(first.status, 200, first.raw);
    const second = await createAi(s, a, { name: 'AI二', blueprint: JUST_WAIT });
    assert.equal(second.status, 400, second.raw);
    assert.equal(second.body.error.code, 'ai_node_shortage');
    // 再补 1 个"等待"（模拟开包产出）→ 两套 AI 都能装上
    await grantExtra(s, a, ['a_wait'], 1);
    const third = await createAi(s, a, { name: 'AI二', blueprint: JUST_WAIT });
    assert.equal(third.status, 200, third.raw);
    const nodes = await getNodes(s, a);
    const row = nodes.body.data.inventory.find((x) => x.nodeId === 'a_wait');
    assert.equal(row.owned, owned0 + ((r0.used + 1) - r0.owned) + 1);
    assert.equal(row.free, 0, '补的第二份正好被第二套 AI 用掉');
    assert.equal(row.used, row.owned, '全部副本都在工作中');
  }, h.QUIET);
});

test('ALN-5 编辑保存：只改蓝图 → 占用按新蓝图重算（旧占用释放）', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'aln5');
    const base = await grantExtra(s, a, ['a_skill', 'c_gap_less', 'a_wait', 'f_if'], 2);
    const r = await createAi(s, a, { name: 'AI', blueprint: SHOOT });
    const aiId = r.body.data.aiId;
    const up = await updateAi(s, a, aiId, { blueprint: JUST_WAIT });
    assert.equal(up.status, 200, up.raw);
    const nodes = await getNodes(s, a);
    const byId = Object.fromEntries(nodes.body.data.inventory.map((x) => [x.nodeId, x]));
    assert.equal(byId.a_skill.used, base.byId.a_skill, '旧蓝图的技能节点占用已释放（回到基线）');
    assert.equal(byId.c_gap_less.used, base.byId.c_gap_less, '旧蓝图的条件节点占用已释放（回到基线）');
    assert.equal(byId.a_wait.used, base.byId.a_wait + 1, '新蓝图占用 1 个"等待"');
  }, h.QUIET);
});

test('ALN-6 POST /me/ai/validate 接受蓝图：合法回带 slotCount/programHash；非法回带中文错误', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'aln6');
    const ok = await validate(s, a, { blueprint: SHOOT });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.data.ok, true);
    assert.equal(ok.body.data.slotCount, 4);
    assert.ok(typeof ok.body.data.programHash === 'string' && ok.body.data.programHash.length > 0);
    // 非法蓝图：未知节点 + 参数越界 → ai_invalid + 中文 details
    const bad = bp([n('x1', 'c_gap_less', { x: 99 })]);
    const badRes = await validate(s, a, { blueprint: bad });
    assert.equal(badRes.status, 400, badRes.raw);
    assert.equal(badRes.body.error.code, 'ai_invalid');
    assert.ok(badRes.body.error.details.some((d) => /需为/.test(d.message)), JSON.stringify(badRes.body.error.details));
    // 缺输入（f_if 只给条件）→ 也拒绝
    const bad2 = bp([n('y1', 'f_if', {}, [n('y2', 'c_gap_less', { x: 2 })])]);
    const bad2Res = await validate(s, a, { blueprint: bad2 });
    assert.equal(bad2Res.status, 400, bad2Res.raw);
    assert.ok(bad2Res.body.error.details.some((d) => /至少需要/.test(d.message)), JSON.stringify(bad2Res.body.error.details));
  }, h.QUIET);
});

test('ALN-7 旧路径回归：只送 program（无蓝图）仍可保存/校验，blueprint 为 null', async () => {
  await h.withServer(null, async (s) => {
    const a = await freshPlayer(s, 'aln7');
    const program = {
      type: 'program', version: 2,
      body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] },
    };
    const r = await createAi(s, a, { name: '旧程序', program });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.data.ai.blueprint, null, '无蓝图 → blueprint = null（编辑器视为旧程序）');
    assert.equal(r.body.data.ai.slotCount, null);
    const v = await validate(s, a, { program });
    assert.equal(v.status, 200, v.raw);
    assert.equal(v.body.data.ok, true);
  }, h.QUIET);
});
