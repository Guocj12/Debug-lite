'use strict';
/* tests/unit/ai-mirror.test.js —— D-164 守方镜像（用户 2026-09-25 口径）
 * 规则：玩家编写的出战配置 AI 一律按"自己永远在 p1（左）坐标系"书写；
 *   服务端在 p2 侧给它**镜像世界**（x/facing/位移取反），并把产出的方向动作**反镜像**回真实世界。
 * 契约：docs/interfaces.md §1 runner.js（mirrorSnapshot / unmirrorAction / makeAiDriver）；
 *       docs/systems/08-ai.md（快照投影与侧位语义）。
 *
 * 为什么必须用**完整镜像**而不是"只翻动作名"（本文件 M-4 就是那条反例的行为锚）：
 *   出厂默认 AI 用有符号距离 `enemy.x − self.x` 选绝对方向，两侧本来就自洽；
 *   只翻动作会让它当守方时掉头退回自己基地角、永不交战。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const runner = require('../../server/runner.js');
const ranked = require('../../server/ranked.js');
const battle = require('../../server/battle.js');

const act = (name) => ({ type: 'action', name });
const always = (name) => ({ type: 'program', version: 2, body: { type: 'seq', statements: [act(name)] } });
const LOADOUT = ranked.buildDefaultLoadout({ publicId: 'u_mirror_a', playerId: 'pl_mirror_a' });
const withAi = (ai) => Object.assign({}, LOADOUT, { ai });

function runMatch(p1ai, p2ai, seed) {
  const r = battle.runBattle({ p1: withAi(p1ai), p2: withAi(p2ai), seed: seed === undefined ? 20260925 : seed, tier: 'common' });
  assert.equal(r.status, 200, '对局应可执行：' + JSON.stringify(r.details || r.code));
  return r.data.frames;
}
const firstLast = (frames, side) => {
  const xs = frames.map((f) => f.diff.players[side].toX);
  return { x0: xs[0], xEnd: xs[xs.length - 1], net: xs[xs.length - 1] - xs[0] };
};

test('M-1 反镜像只映射四个方向动作，其余原样（含未登记动作名交给引擎按 D-80 归一化）', () => {
  const m = runner.MIRROR_ACTION;
  assert.deepEqual(Object.keys(m).sort(), ['dodge_left', 'dodge_right', 'move_left', 'move_right']);
  assert.equal(runner.unmirrorAction('move_right'), 'move_left');
  assert.equal(runner.unmirrorAction('move_left'), 'move_right');
  assert.equal(runner.unmirrorAction('dodge_right'), 'dodge_left');
  assert.equal(runner.unmirrorAction('dodge_left'), 'dodge_right');
  // 自反/无方向/前缀式动作不参与映射
  for (const a of ['turn', 'wait', 'defend', 'skill:skill1', 'skill:skill3', 'not_a_real_action']) {
    assert.equal(runner.unmirrorAction(a), a, a + ' 不应被映射');
  }
  // 缺省/空值 → wait（与引擎 normalizeAction 的兜底一致）
  assert.equal(runner.unmirrorAction(undefined), 'wait');
  assert.equal(runner.unmirrorAction(null), 'wait');
  assert.equal(runner.unmirrorAction(''), 'wait');
});

test('M-2 mirrorSnapshot：只翻 x/facing/位移，归属与其他字段不变，且不改动入参', () => {
  const snap = {
    tick: 7,
    self: { hp: 90, x: 800, facing: -1, baseHp: 100, effects: [{ uid: 'e1', kind: 'move', displacement: -2, remaining: 1 }] },
    enemy: { hp: 80, x: 224, facing: 1, baseHp: 100, effects: [] },
    bases: { self: { hp: 100, maxHp: 100, def: 64 }, enemy: { hp: 100, maxHp: 100, def: 64 } },
    field: { fieldPx: 1024, cellPx: 64 },
  };
  const before = JSON.parse(JSON.stringify(snap));
  const out = runner.mirrorSnapshot(snap);
  assert.equal(out.tick, 7);
  assert.equal(out.self.x, 224, 'x → fieldPx − x');
  assert.equal(out.enemy.x, 800);
  assert.equal(out.self.facing, 1, 'facing → −facing');
  assert.equal(out.enemy.facing, -1);
  assert.equal(out.self.effects[0].displacement, 2, '位移取反');
  assert.equal(out.self.hp, 90, '资源不参与镜像');
  assert.equal(out.self.baseHp, 100);
  assert.deepEqual(out.bases, snap.bases, 'bases 归属不变（self/enemy 已是视角相对）');
  assert.deepEqual(out.field, snap.field);
  assert.deepEqual(snap, before, '不得就地修改入参（引擎状态只读）');
  // 非对象入参原样返回（防御）
  assert.equal(runner.mirrorSnapshot(null), null);
  assert.equal(runner.mirrorSnapshot(undefined), undefined);
});

test('M-3 用户口径：写死"永远右移"的 AI，当进攻方右移、当防守方左移（迎面推进）', () => {
  const frames = runMatch(always('move_right'), always('move_right'));
  const p1 = firstLast(frames, 'p1');
  const p2 = firstLast(frames, 'p2');
  assert.ok(p1.net > 0, `进攻方应向右推进（实测 net=${p1.net}，${p1.x0}→${p1.xEnd}）`);
  assert.ok(p2.net < 0, `防守方应向左推进（镜像生效；实测 net=${p2.net}，${p2.x0}→${p2.xEnd}）`);
});

test('M-4 回归锚：出厂默认 AI（有符号距离型）当守方仍迎面推进——只翻动作名会打坏它', () => {
  const frames = runMatch(LOADOUT.ai, LOADOUT.ai);
  const p2 = firstLast(frames, 'p2');
  assert.ok(p2.net < 0, `默认 AI 守方应朝对手推进（net=${p2.net}，${p2.x0}→${p2.xEnd}）；若 >0 说明镜像语义错了`);
});

test('M-5 内置对手 OPPONENTS 不参与镜像（charger 仍直扑 p1，而非被二次翻转后逃跑）', () => {
  const r = runner.runAiBattle({ program: always('move_right'), seed: 20260925, tier: 'common', opponent: 'charger' });
  assert.equal(r.status, 200);
  // 注意：/ai/battle 的帧是**扁平**形状（players 在顶层，不是 diff.players），与 /battle 的 {tick,diff} 不同
  const xs = r.data.frames.map((f) => f.players.p2.toX);
  assert.ok(xs[xs.length - 1] <= xs[0], `charger 当 p2 应向 p1 逼近（${xs[0]}→${xs[xs.length - 1]}）`);
});

test('M-6 看 facing 的程序：p2 经镜像后仍面向敌人（turn 自反，不被误翻）', () => {
  const faceAwayIfNegative = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'if', cond: { type: 'cmp', op: '<', left: { type: 'get', path: 'self.facing' }, right: { type: 'literal', value: 0 } }, then: { type: 'seq', statements: [act('turn')] }, else: { type: 'seq', statements: [act('wait')] } }] } };
  const frames = runMatch(LOADOUT.ai, faceAwayIfNegative);
  const last = frames[frames.length - 1];
  assert.equal(last.diff.players.p2.facing, -1, 'p2 应仍面向 p1（facing=−1）；若为 +1 说明镜像把 turn 也翻了');
});

test('M-7 p2 的 aiTrace 记录的是镜像坐标系下的判定值（trace 与帧坐标口径不同，属设计）', () => {
  const frames = runMatch(LOADOUT.ai, LOADOUT.ai);
  const traces = frames.flatMap((f) => f.diff.aiTrace || []);
  const p2trace = traces.filter((t) => t.owner === 'p2');
  assert.ok(p2trace.length > 0, 'p2 应有 trace');
  // owner 标记必须存在（回放按 owner 分侧展示）
  for (const t of p2trace) assert.equal(t.owner, 'p2');
  const p1trace = traces.filter((t) => t.owner === 'p1');
  assert.ok(p1trace.length > 0, 'p1 也应有 trace');
});
