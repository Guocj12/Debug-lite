'use strict';
// B2 core/effects.js 契约测试 —— 接口见 docs/interfaces.md §1（addEffect/resolveContinuous/resolveControl）
// 依据：examples/05-effects.md E-1..E-8（数值期望唯一出处）；decisions D-35/D-70/D-71/D-83/D-84
// 归属：tasks.md §6 B2（T-EF-1..5 + T-FD-4 意图/单方落位部分）；日志 effect.add/continuous/expire/control.override（§4.6）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const fx = require('../../server/core/effects.js');

// 构造战场状态的 player 骨架（B8 前 effects 只读 hp/mp/sp/atk/def/max*）
function mkPlayer(overrides) {
  return Object.assign({
    effects: [], hp: 132, mp: 41, sp: 72, atk: 12, def: 8,
    maxHp: 132, maxMp: 41, maxSp: 72,
  }, overrides);
}
function mkState(tick, players) {
  return { tick, players };
}

test('EF-1 T-EF-4+5 持续效果逐 tick 结算与到期移除（E-1 全程）', () => {
  const p1 = mkPlayer();
  const state = mkState(0, { p1, p2: mkPlayer() });
  const eff = fx.addEffect(state, { kind: 'continuous', target: 'p1', stat: 'hp', delta: -3, remaining: 3, source: 'p2' });
  assert.ok(eff.uid, 'addEffect 补 uid');
  // 添加 tick 不结算（下一 tick 起效）
  fx.resolveContinuous(state);
  assert.equal(p1.hp, 132, '添加 tick 不结算');
  assert.equal(eff.remaining, 3);
  // t+1..3
  state.tick = 1; fx.resolveContinuous(state);
  assert.equal(p1.hp, 129); assert.equal(eff.remaining, 2);
  state.tick = 2; fx.resolveContinuous(state);
  assert.equal(p1.hp, 126); assert.equal(eff.remaining, 1);
  state.tick = 3; fx.resolveContinuous(state);
  assert.equal(p1.hp, 123);
  assert.equal(p1.effects.length, 0, 'remaining 归零移除');
  state.tick = 4; fx.resolveContinuous(state);
  assert.equal(p1.hp, 123, '移除后不再结算');
});

test('EF-2 T-EF-5 clamp：回血封顶 / 回蓝封顶 / 属性下限 0 / 负血钳 0（E-2a/c/e）', () => {
  const p1 = mkPlayer();
  const state = mkState(0, { p1, p2: mkPlayer() });
  fx.addEffect(state, { kind: 'continuous', target: 'p1', stat: 'hp', delta: 5, remaining: 2, source: 'x' });
  state.tick = 1; fx.resolveContinuous(state);
  assert.equal(p1.hp, 132, 'hp 满封顶');
  const p2 = mkPlayer({ mp: 39, maxMp: 41 });
  const s2 = mkState(0, { p1: mkPlayer(), p2 });
  fx.addEffect(s2, { kind: 'continuous', target: 'p2', stat: 'mp', delta: 3, remaining: 2, source: 'x' });
  s2.tick = 1; fx.resolveContinuous(s2);
  assert.equal(p2.mp, 41, 'mp 封顶');
  const p3 = mkPlayer({ atk: 12 });
  const s3 = mkState(0, { p1: p3, p2: mkPlayer() });
  fx.addEffect(s3, { kind: 'continuous', target: 'p1', stat: 'atk', delta: -4, remaining: 2, source: 'x' });
  fx.addEffect(s3, { kind: 'continuous', target: 'p1', stat: 'atk', delta: -20, remaining: 2, source: 'x' });
  s3.tick = 1; fx.resolveContinuous(s3);
  assert.equal(p3.atk, 0, 'atk 下限 0，不出现负值');
  const p4 = mkPlayer({ hp: 30 });
  const s4 = mkState(0, { p1: p4, p2: mkPlayer() });
  fx.addEffect(s4, { kind: 'continuous', target: 'p1', stat: 'hp', delta: -200, remaining: 1, source: 'x' });
  s4.tick = 1; fx.resolveContinuous(s4);
  assert.equal(p4.hp, 0, '负血钳 0（死亡判定在引擎步骤 12）');
});

test('EF-3 T-EF-1 同 stat 多效果独立结算、独立计时（E-2d）', () => {
  const p1 = mkPlayer();
  const state = mkState(0, { p1, p2: mkPlayer() });
  fx.addEffect(state, { kind: 'continuous', target: 'p1', stat: 'def', delta: 6, remaining: 3, source: 'a' });
  fx.addEffect(state, { kind: 'continuous', target: 'p1', stat: 'def', delta: -2, remaining: 2, source: 'b' });
  state.tick = 1; fx.resolveContinuous(state);
  assert.equal(p1.def, 12, '8+6-2=12');
  state.tick = 2; fx.resolveContinuous(state);
  assert.equal(p1.def, 16, '第二个到期，第一个继续：12+6-2=16');
  assert.equal(p1.effects.length, 1, '剩余 1 个');
});

test('EF-4 E-3 untilEnd：remaining 足够大即整场持续', () => {
  const p1 = mkPlayer();
  const state = mkState(0, { p1, p2: mkPlayer() });
  fx.addEffect(state, { kind: 'continuous', target: 'p1', stat: 'atk', delta: 2, remaining: 999, source: 'x' });
  for (let t = 1; t <= 100; t++) {
    state.tick = t;
    fx.resolveContinuous(state);
  }
  assert.equal(p1.atk, 212, '100 tick 后仍生效');
  assert.equal(p1.effects.length, 1);
});

test('EF-5 T-EF-2 眩晕复写行动 + override/expire 日志（E-4）', () => {
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const e = fx.withLogger(logger);
  const p1 = mkPlayer();
  const ctl = e.addEffect(mkState(4, { p1, p2: mkPlayer() }), { kind: 'control', target: 'p1', displacement: 0, remaining: 1, source: 'p2' });
  // 复写：AI 返回 move_right → wait
  const out = e.resolveControl(p1.effects, 'move_right');
  assert.equal(out.action, 'wait', '眩晕 → wait');
  assert.equal(p1.effects.length, 0, 'remaining 1→0 移除');
  const ov = logger.records.find((r) => r.event === 'effect.control.override');
  assert.ok(ov, '应有 effect.control.override');
  assert.equal(ov.data.from, 'move_right');
  assert.equal(ov.data.to, 'wait');
  const add = logger.records.find((r) => r.event === 'effect.add');
  assert.ok(add, '应有 effect.add');
  assert.equal(add.data.kind, 'control');
  const exp = logger.records.find((r) => r.event === 'effect.expire');
  assert.ok(exp, '应有 effect.expire');
});

test('EF-6 T-EF-2 强制位移意图：方向/格数正确 + 单方落位 clamp（E-5a/c）', () => {
  const p1 = mkPlayer();
  const ctl = fx.addEffect(mkState(0, { p1, p2: mkPlayer() }), { kind: 'control', target: 'p1', displacement: 2, remaining: 1, source: 'p2' });
  const out = fx.resolveControl(p1.effects, 'move_right');
  assert.equal(out.action, 'forced_move', '位移 → forced_move');
  assert.equal(out.dir, 1);
  assert.equal(out.cells, 2, 'displacement 2 → 右 2 格（+128px）');
  // 单方落位（对方静止）：E-5a 528→656
  assert.equal(fx.resolveControlMove(528, 800, 2), 656, 'E-5a');
  // E-5c：越界 → clamp 到 32
  assert.equal(fx.resolveControlMove(64, 800, -2), 32, 'E-5c');
  // E-5e：位移 0 视同眩晕（由 resolveControl 输出 wait，resolveControlMove 只服务非零）
  assert.equal(fx.resolveControlMove(500, 800, 0), 500, '位移 0 原地');
});

test('EF-7 T-FD-4 gap 约束：击退/拉近不使中心距 <64px（E-5b/d 单方落位）', () => {
  // E-5b：A=500、B=600，击退 +2 → 意图 628，gap 28<64 → 钳到 536
  assert.equal(fx.resolveControlMove(500, 600, 2), 536, 'E-5b');
  // E-5d：拉近 +1 → 意图 564，gap 36<64 → 钳到 536
  assert.equal(fx.resolveControlMove(500, 600, 1), 536, 'E-5d');
  // 反向：A=600、B=500，击退 -2 → 意图 472，gap 28<64 → 钳到 564（600-64）
  assert.equal(fx.resolveControlMove(600, 500, -2), 564, '反向钳位');
  // 无阻挡常规：gap 充足不动
  assert.equal(fx.resolveControlMove(500, 700, 2), 628);
});

test('EF-8 T-EF-3 多控制优先级：眩晕 > 位移；位移取首个加入顺序（E-6 全分支）', () => {
  const mk = (effects, ai) => {
    const p1 = mkPlayer({ effects });
    return fx.resolveControl(p1.effects, ai);
  };
  // E-6a 眩晕 + 击退 → wait
  const a = mk([{ uid: '1', kind: 'control', displacement: 2, remaining: 1 }, { uid: '2', kind: 'control', displacement: 0, remaining: 1 }], 'move_left');
  assert.equal(a.action, 'wait', 'E-6a 眩晕优先');
  // E-6b 击退 + 拉近 → 首个（先加击退 +2）
  const b = mk([{ uid: '3', kind: 'control', displacement: 2, remaining: 1 }, { uid: '4', kind: 'control', displacement: -1, remaining: 1 }], 'skill1');
  assert.equal(b.action, 'forced_move');
  assert.equal(b.dir, 1);
  assert.equal(b.cells, 2, 'E-6b 取首个');
  // E-6c 双眩晕 / E-6d 三位移 → 语义一致
  const c = mk([{ uid: '5', kind: 'control', displacement: 0, remaining: 1 }, { uid: '6', kind: 'control', displacement: 0, remaining: 1 }], 'move_right');
  assert.equal(c.action, 'wait', 'E-6c');
  const d = mk([{ uid: '7', kind: 'control', displacement: -1, remaining: 1 }, { uid: '8', kind: 'control', displacement: 2, remaining: 1 }, { uid: '9', kind: 'control', displacement: 3, remaining: 1 }], 'wait');
  assert.equal(d.action, 'forced_move');
  assert.equal(d.dir, -1, 'E-6d 取首个');
  assert.equal(d.cells, 1);
  // 无控制 → 原行动原样返回
  const none = mk([], 'move_right');
  assert.equal(none.action, 'move_right');
});

test('EF-9 T-EF-6 结算顺序语义：resolveControl 不触碰资源/冷却；返回原行动当无控制', () => {
  const p1 = mkPlayer({ effects: [] });
  const out = fx.resolveControl(p1.effects, 'skill1');
  assert.equal(out.action, 'skill1', '无控制原样');
  assert.equal(p1.hp, 132, 'resolveControl 不触碰资源');
  // E-7c：defend 不影响控制——控制照常复写
  const p2 = mkPlayer({ effects: [{ uid: 'x', kind: 'control', displacement: 1, remaining: 1 }] });
  const out2 = fx.resolveControl(p2.effects, 'defend');
  assert.equal(out2.action, 'forced_move', 'defend 不防控制');
  assert.equal(out2.cells, 1);
});

test('EF-10 T-EF-4 新效果下一 tick 起效（addedTick 语义；E-1 ①）', () => {
  const p1 = mkPlayer();
  const state = mkState(5, { p1, p2: mkPlayer() });
  fx.addEffect(state, { kind: 'continuous', target: 'p1', stat: 'hp', delta: -10, remaining: 5, source: 'x' });
  fx.resolveContinuous(state);
  assert.equal(p1.hp, 132, '添加同 tick 不结算');
  state.tick = 6;
  fx.resolveContinuous(state);
  assert.equal(p1.hp, 122, '下一 tick 起效');
});

test('EF-12 边界：remaining=0 立即移除且不结算、不采用（05-effects §5，审查 P1-b）', () => {
  const p1 = mkPlayer();
  const state = mkState(0, { p1, p2: mkPlayer() });
  // continuous remaining 0
  fx.addEffect(state, { kind: 'continuous', target: 'p1', stat: 'hp', delta: -10, remaining: 0, source: 'x' });
  state.tick = 1;
  fx.resolveContinuous(state);
  assert.equal(p1.hp, 132, 'remaining 0 不结算');
  assert.equal(p1.effects.length, 0, '立即移除');
  // control remaining 0
  const p2 = mkPlayer({ effects: [{ uid: 'z', kind: 'control', displacement: 2, remaining: 0 }] });
  const out = fx.resolveControl(p2.effects, 'move_right');
  assert.equal(out.action, 'move_right', 'remaining 0 不采用');
  assert.equal(p2.effects.length, 0, '立即移除');
});

test('EF-13 失败路径：addEffect 未知目标抛 RangeError（审查 P1-c）', () => {
  const state = mkState(0, { p1: mkPlayer(), p2: mkPlayer() });
  assert.throws(() => fx.addEffect(state, { kind: 'continuous', target: 'p9', stat: 'hp', delta: -1, remaining: 1, source: 'x' }), RangeError);
  assert.throws(() => fx.addEffect(state, { kind: 'continuous', target: 'nobody', stat: 'mp', delta: 1, remaining: 1, source: 'x' }), /未知目标/);
});

test('EF-11 日志：effect.continuous / effect.expire 事件与 stat/remaining 数据', () => {
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const e = fx.withLogger(logger);
  const p1 = mkPlayer();
  const state = mkState(0, { p1, p2: mkPlayer() });
  e.addEffect(state, { kind: 'continuous', target: 'p1', stat: 'hp', delta: -3, remaining: 1, source: 'x' });
  state.tick = 1;
  e.resolveContinuous(state);
  const cont = logger.records.filter((r) => r.event === 'effect.continuous');
  assert.equal(cont.length, 1, '一条 continuous');
  assert.equal(cont[0].data.stat, 'hp');
  assert.equal(cont[0].data.delta, -3);
  assert.equal(cont[0].data.after, 129);
  const tags = logger.records.filter((r) => r.event === 'effect.expire');
  assert.equal(tags.length, 1, '到期移除一条 expire');
  // 缺省 logger 安全
  const bare = fx;
  assert.doesNotThrow(() => {
    const p = mkPlayer();
    const s = mkState(0, { p1: p, p2: mkPlayer() });
    bare.addEffect(s, { kind: 'continuous', target: 'p1', stat: 'hp', delta: -1, remaining: 1, source: 'x' });
    s.tick = 1;
    bare.resolveContinuous(s);
    bare.resolveControl(p.effects, 'wait');
    bare.resolveControlMove(500, 600, 1);
  });
});