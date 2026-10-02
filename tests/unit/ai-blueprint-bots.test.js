'use strict';
// D-178：默认 AI 预设 = **绿档积木蓝图** → 编译成 AST。本文件冻结其行为基线：
//   ① 固定探针快照下的动作序列（回归护栏：改写预设/编译器若改变决策，这里立刻红）；
//   ② 蓝图约束（只用绿档、节点用量在新手预算内）→ 保证"starter 的默认 AI 自己装得上"。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const ranked = require('../../server/ranked.js');
const blueprint = require('../../server/ai/blueprint.js');
const runtime = require('../../server/ai/runtime.js');
const ast = require('../../server/ai/ast.js');

const PRESETS = ['steady', 'aggressive', 'kite'];

function snap(gap, hp) {
  return {
    tick: 0,
    self: { hp, maxHp: 95, mp: 0, maxMp: 1, sp: 0, maxSp: 1, atk: 1, def: 1, x: 3, facing: 1, baseHp: 100, cooldowns: {}, effects: [], skills: [] },
    enemy: { hp: 95, maxHp: 95, mp: 0, maxMp: 1, sp: 0, maxSp: 1, atk: 1, def: 1, x: 3 + gap, facing: -1, baseHp: 100, cooldowns: {}, effects: [], skills: [] },
    bases: { self: { hp: 100, maxHp: 100, def: 64 }, enemy: { hp: 100, maxHp: 100, def: 64 } },
    field: { fieldPx: 1024, cellPx: 64 },
  };
}
// 探针：远 / 刚好在阈值上 / 贴身 / 重叠 / 敌人已在身后 / 残血（血线）
const PROBES = [[9, 95], [3, 95], [1, 95], [0, 95], [-1, 95], [9, 20]];

function actionsOf(program) {
  const ctx = runtime.createContext(program);
  const rng = { chance: () => false };
  return PROBES.map(([gap, hp]) => runtime.resume(ctx, snap(gap, hp), rng).action).join(',');
}

// 冻结基线（2026-09-28，绿档蓝图版）：改预设/编译器若改变决策 → 此表必须显式更新
const GOLDEN = Object.freeze({
  'steady/0': 'move_right,move_right,skill:skill1,skill:skill1,move_left,defend',
  'steady/1': 'move_right,skill:skill1,skill:skill1,skill:skill1,move_left,defend',
  'steady/2': 'move_right,skill:skill1,skill:skill1,skill:skill1,move_left,defend',
  'aggressive/0': 'move_right,move_right,skill:skill1,skill:skill1,move_left,move_right',
  'aggressive/1': 'move_right,move_right,skill:skill1,skill:skill1,move_left,defend',
  'aggressive/2': 'move_right,move_right,skill:skill2,skill:skill2,move_left,defend',
  'kite/0': 'move_right,skill:skill1,skill:skill1,skill:skill1,move_left,move_right',
  'kite/1': 'move_right,skill:skill1,skill:skill1,skill:skill1,move_left,move_right',
  'kite/2': 'move_right,skill:skill1,skill:skill1,skill:skill1,move_left,move_right',
});

test('BB-1 9 个默认预设：编译产物在固定探针下的动作序列 == 冻结基线（9 个程序互不相同）', () => {
  let n = 0;
  const hashes = new Set();
  for (const preset of PRESETS) {
    for (let sub = 0; sub < 3; sub += 1) {
      const compiled = blueprint.compileBlueprint(ranked.blueprintOf(preset, sub));
      assert.equal(compiled.ok, true, `${preset}/${sub} 编译失败：${JSON.stringify(compiled.errors)}`);
      assert.equal(ast.validate(compiled.program).ok, true, `${preset}/${sub} 产物未过 ast.validate`);
      assert.equal(actionsOf(compiled.program), GOLDEN[`${preset}/${sub}`], `${preset}/${sub} 行为偏离基线`);
      hashes.add(ast.programHash(compiled.program));
      n += 1;
    }
  }
  assert.equal(n, 9, '覆盖 3 族 × 3 子变体');
  // P2-5 依赖"9 个子变体是 9 个不同程序"（否则同族镜像恒平局、匹配池退化成 7 个）→ 阈值必须保留小数差异
  assert.equal(hashes.size, 9, `9 个子变体必须是 9 个不同程序（实得 ${hashes.size}）`);
});

test('BB-2 默认预设蓝图**只用绿档**、用量在新手预算内（starter 的默认 AI 必须自己装得上）', () => {
  const cat = Object.fromEntries(blueprint.catalog().map((x) => [x.id, x]));
  const budget = { f_seq: 2, f_if: 3 }; // starterNodeStacks 的结构类额外份数
  for (const preset of PRESETS) {
    for (let sub = 0; sub < 3; sub += 1) {
      const stats = blueprint.statsOf(ranked.blueprintOf(preset, sub));
      for (const [id, count] of Object.entries(stats.byNode)) {
        assert.equal(cat[id].quality, 'common', `${preset}/${sub} 用了非绿档节点 ${id}`);
        assert.ok(count <= (budget[id] || 1), `${preset}/${sub} 的 ${id} 用了 ${count} 个，超过新手预算 ${budget[id] || 1}`);
      }
    }
  }
});

test('BB-3 default loadout 带蓝图三件套；ai 就是该蓝图的编译产物', () => {
  const lo = ranked.buildDefaultLoadout({ publicId: 'bb3', playerId: 'p' });
  assert.ok(lo.aiBlueprint && lo.aiBlueprint.type === 'blueprint', '带 aiBlueprint');
  assert.ok(lo.aiTraceMap && Object.keys(lo.aiTraceMap).length > 0, '带 traceMap（供积木层高亮）');
  assert.equal(lo.aiCompilerVersion, blueprint.limits.blueprintVersion);
  assert.equal(ast.validate(lo.ai).ok, true, 'ai 是编译后的合法 AST');
  const compiled = blueprint.compileBlueprint(lo.aiBlueprint);
  assert.equal(JSON.stringify(compiled.program), JSON.stringify(lo.ai), 'ai 就是该蓝图的编译产物（同一份）');
});

test('BB-4 同一身份 → 同一蓝图（确定性：身份哈希派生 preset/sub 不变）', () => {
  const a = ranked.buildDefaultLoadout({ publicId: 'same-id', playerId: 'x' });
  const b = ranked.buildDefaultLoadout({ publicId: 'same-id', playerId: 'x' });
  assert.deepEqual(a.aiBlueprint, b.aiBlueprint, '同身份蓝图一致');
  assert.equal(a.preset, b.preset);
  assert.equal(a.sub, b.sub);
});

test('BB-5 starter 的 AI 与身份派生默认 AI 完全一致（D-159 契约）', () => {
  const starter = require('../../server/starter.js');
  const r = starter.buildStarter({ publicId: 'bb5user', playerId: 'bb5' });
  assert.equal(r.ok, true);
  const expect = ranked.buildDefaultLoadout({ publicId: 'bb5user', playerId: 'bb5' });
  assert.equal(JSON.stringify(r.aiLibrary[0].program), JSON.stringify(expect.ai), 'starter AI = 默认 AI');
  assert.deepEqual(r.aiLibrary[0].blueprint, expect.aiBlueprint, 'starter AI 的蓝图 = 默认蓝图');
});
