'use strict';
// B16 engine aiTrace 缓冲：actions.aiTrace（数组）→ 每 tick diff.aiTraces 输出本 tick 增量
// 依据：interfaces §4.3 回放帧 diff.aiTrace[]；systems/07-engine 行动注入模式（B8）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../../server/core/engine.js');

function mkPlayer(P) {
  return {
    id: P === 'p1' ? 'A' : 'B', owner: P,
    x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
    hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
    atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9,
    regen: { mp: 1, sp: 2 }, special: { critChance: 0, dodgeChance: 0, lifesteal: 0 },
    cooldowns: {}, effects: [],
  };
}

test('actions.aiTrace 缓冲：每 tick 输出本 tick 增量到 diff.aiTrace（冻结字段名 §4.3）', () => {
  const b = engine.createBattle(undefined, { seed: 7, players: { p1: mkPlayer('p1'), p2: mkPlayer('p2') } });
  const buf = [];
  const actions = {
    aiTrace: buf,
    p1: (state) => { buf.push({ tick: state.tick, owner: 'p1', seq: 1 }); return 'move_right'; },
    p2: () => 'move_left',
  };
  const r = b.runFull({ actions });
  assert.ok(r.diffs.length >= 2, '战斗应有至少 2 tick');
  for (const d of r.diffs) {
    assert.deepEqual(d.aiTrace, [{ tick: d.tick, owner: 'p1', seq: 1 }], `tick ${d.tick} 恰一条本 tick 增量`);
  }
});

test('未提供 aiTrace 缓冲：diff.aiTrace 保持空数组（兼容旧调用）', () => {
  const b = engine.createBattle(undefined, { seed: 8, players: { p1: mkPlayer('p1'), p2: mkPlayer('p2') } });
  const r = b.runFull({ actions: { p1: () => 'wait', p2: () => 'wait' } });
  assert.ok(r.diffs.length >= 1);
  assert.deepEqual(r.diffs[0].aiTrace, [], '无缓冲 → 空');
});