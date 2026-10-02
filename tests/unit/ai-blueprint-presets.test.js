'use strict';
// D-178 预设蓝图模板：结构 + **全部可编译** + 只用绿档节点（保证任何新账号都能直接套用）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const blueprint = require('../../server/ai/blueprint.js');
const ast = require('../../server/ai/ast.js');
const data = require('../../server/data/ai-blueprint-presets.json');

test('PR-1 预设模板：结构齐备、id 唯一、数量 ≥ 3', () => {
  const list = blueprint.presets();
  assert.ok(list.length >= 3, `至少 3 套预设（实际 ${list.length}）`);
  assert.equal(new Set(list.map((p) => p.id)).size, list.length, 'id 唯一');
  for (const p of list) {
    assert.ok(p.id && p.name && p.desc, `${p.id} 需有 id/name/desc`);
    assert.equal(p.blueprint.type, 'blueprint');
    assert.equal(p.blueprint.version, data.version);
    assert.ok(Array.isArray(p.blueprint.body) && p.blueprint.body.length > 0);
  }
  // 返回的是深拷贝：改返回值不污染数据表
  const a = blueprint.presets();
  a[0].blueprint.body.length = 0;
  assert.ok(blueprint.presets()[0].blueprint.body.length > 0, 'presets() 必须返回深拷贝');
});

test('PR-2 预设模板全部可编译（过 ast.validate），且是可用的非空程序', () => {
  for (const p of blueprint.presets()) {
    const r = blueprint.compileBlueprint(p.blueprint);
    assert.equal(r.ok, true, `${p.id} 编译失败：${JSON.stringify(r.errors)}`);
    assert.equal(ast.validate(r.program).ok, true, `${p.id} 产物未过 ast.validate`);
    assert.ok(r.slotCount >= 3, `${p.id} 至少 3 个节点（实际 ${r.slotCount}）`);
    assert.ok(Object.keys(r.traceMap).length > 0, `${p.id} 必须有可高亮的语句`);
  }
});

test('PR-3 预设模板只用**绿档**节点（新账号必有全部绿档 → 可零成本套用）', () => {
  const cat = Object.fromEntries(blueprint.catalog().map((n) => [n.id, n]));
  for (const p of blueprint.presets()) {
    const stats = blueprint.statsOf(p.blueprint);
    for (const id of Object.keys(stats.byNode)) {
      assert.ok(cat[id], `${p.id} 引用了未知节点 ${id}`);
      assert.equal(cat[id].quality, 'common', `${p.id} 只能使用绿档节点，但用了 ${id}（${cat[id].quality}）`);
    }
  }
});

test('PR-4 预设模板的槽位用量在"新手自带"范围内（结构类多份，其余每种 1 个）', () => {
  const budget = { f_seq: 2, f_if: 3 };
  for (const p of blueprint.presets()) {
    const stats = blueprint.statsOf(p.blueprint);
    for (const [id, n] of Object.entries(stats.byNode)) {
      const max = budget[id] || 1;
      assert.ok(n <= max, `${p.id} 里 ${id} 用了 ${n} 次，超过新手自带上限 ${max}`);
    }
  }
});
