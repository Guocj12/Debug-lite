'use strict';
// B1 core/field.js 契约测试 —— 接口见 docs/interfaces.md §1（FIELD_PX..BASE_DEF/clampX/cellOf/xCenter/cellRange/baseOf/touchesBase）
// 依据：decisions D-01~D-08、D-60~D-62；示例 06-field.md F-01..F-36（数值期望全部取自该文）
// 归属：tasks.md §6 B1（T-FD-1/2/3）；日志事件 field.clamp/field.base（§4.6）。
// 部署：所有数值来自 server/data/battle-config.json（L9）——本文件断言值来自 06-field 示例与 §2.5.7 冻结表。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const f = require('../../server/core/field.js');

test('F-1 常量 = battle-config 冻结值（§2.5.7/06-field §3）', () => {
  assert.equal(f.CELL_PX, 64);
  assert.equal(f.FIELD_PX, 1024);
  assert.equal(f.ACTOR_HALF, 32);
  assert.equal(f.MIN_GAP_PX, 64);
  assert.equal(f.START_X.p1, 224);
  assert.equal(f.START_X.p2, 800);
  assert.equal(f.START_FACING.p1, 1);
  assert.equal(f.START_FACING.p2, -1);
  assert.equal(f.BASE_DEF, 64);
});

test('T-FD-1 初始位置与朝向（D-03）', () => {
  assert.equal(f.START_X.p1, 224, 'P1 格 3 中心');
  assert.equal(f.START_X.p2, 800, 'P2 格 12 中心');
  assert.equal(f.START_FACING.p1, 1);
  assert.equal(f.START_FACING.p2, -1);
});

test('T-FD-2 clampX 全分支（06-field F-01..F-08）', () => {
  assert.equal(f.clampX(-1), 32, 'F-01');
  assert.equal(f.clampX(0), 32, 'F-02');
  assert.equal(f.clampX(32), 32, 'F-03');
  assert.equal(f.clampX(500), 500, 'F-04');
  assert.equal(f.clampX(992), 992, 'F-05');
  assert.equal(f.clampX(1024), 992, 'F-06');
  assert.equal(f.clampX(1025), 992, 'F-07');
  assert.equal(f.clampX(500.4), 500.4, 'F-08：clamp 不量化（1px 量化在移动结算）');
});

test('cellOf 半开区间归属（F-10..F-15）+ 越界 clamp', () => {
  assert.equal(f.cellOf(32), 0, 'F-10');
  assert.equal(f.cellOf(63), 0, 'F-11');
  assert.equal(f.cellOf(64), 1, 'F-12');
  assert.equal(f.cellOf(736), 11, 'F-13');
  assert.equal(f.cellOf(992), 15, 'F-14');
  assert.equal(f.cellOf(1023), 15, 'F-15');
  assert.equal(f.cellOf(-1), 0, '越界贴 0');
  assert.equal(f.cellOf(1024), 15, '越界贴 15');
});

test('xCenter 格心（F-16）', () => {
  assert.equal(f.xCenter(0), 32);
  assert.equal(f.xCenter(3), 224);
  assert.equal(f.xCenter(12), 800);
  assert.equal(f.xCenter(15), 992);
});

test('cellRange 相对朝向格区间含越界丢弃（F-20..F-27 全 8 例）', () => {
  assert.deepEqual(f.cellRange(-1, 1, 1, 736), [10, 11, 12], 'F-20');
  assert.deepEqual(f.cellRange(0, 2, 1, 736), [11, 12, 13], 'F-21');
  assert.deepEqual(f.cellRange(-2, 0, 1, 736), [9, 10, 11], 'F-22');
  assert.deepEqual(f.cellRange(0, 2, -1, 224), [3, 2, 1], 'F-23');
  assert.deepEqual(f.cellRange(-1, 1, -1, 224), [4, 3, 2], 'F-24');
  assert.deepEqual(f.cellRange(-1, 1, 1, 32), [0, 1], 'F-25 贴边截断');
  assert.deepEqual(f.cellRange(0, 2, 1, 992), [15], 'F-26');
  assert.deepEqual(f.cellRange(0, 2, -1, 32), [0], 'F-27');
});

test('baseOf 基地区域与防御（D-05/D-61）', () => {
  const p1 = f.baseOf('p1');
  const p2 = f.baseOf('p2');
  assert.deepEqual(p1.range, [-64, 0], 'P1 基地 [-64,0)');
  assert.deepEqual(p2.range, [1024, 1088], 'P2 基地 (1024,1088]');
  assert.equal(p1.hp, 100);
  assert.equal(p2.maxHp, 100);
  assert.equal(p1.def, f.BASE_DEF);
});

test('T-FD-3 touchesBase：面向基地且意图越界（F-30..F-36 语义）', () => {
  const actor = (x, facing) => ({ x, facing });
  // F-30：P1 在 992 朝 +1 右移（意图 1056 越界）→ 撞基地
  assert.equal(f.touchesBase(actor(992, 1), 1056, 1), true, 'F-30');
  // F-31：意图恰好 992 未越界 → 普通移动
  assert.equal(f.touchesBase(actor(992, 1), 992, 1), false, 'F-31');
  // F-32：朝基地但背离移动（move_left）→ 不算
  assert.equal(f.touchesBase(actor(992, 1), 928, -1), false, 'F-32');
  // F-33：远未触及边界
  assert.equal(f.touchesBase(actor(500, 1), 564, 1), false, 'F-33');
  // F-34：P2 在 32 朝 -1 左移（意图 -32）→ 撞基地
  assert.equal(f.touchesBase(actor(32, -1), -32, -1), true, 'F-34');
  // F-35：位移技同理（意图 1248 越界）
  assert.equal(f.touchesBase(actor(992, 1), 1248, 1), true, 'F-35');
  // 边界哨兵：原地不动不算
  assert.equal(f.touchesBase(actor(32, -1), 32, 0), false, 'dir=0 不算');
});

test('F-9 日志：field.clamp / field.base 事件（withLogger 注入契约）', () => {
  const logger = createLogger({ level: 'all', ringSize: 100 });
  assert.ok(typeof f.withLogger === 'function', 'field.js 应导出 withLogger（日志注入，interfaces.md B1 冻结）');
  const f2 = f.withLogger(logger);
  f2.clampX(1050);
  const clamp = logger.records.find((r) => r.event === 'field.clamp');
  assert.ok(clamp, '应有 field.clamp');
  assert.equal(clamp.data.from, 1050);
  assert.equal(clamp.data.to, 992);
  f2.touchesBase({ x: 992, facing: 1 }, 1056, 1);
  const base = logger.records.find((r) => r.event === 'field.base');
  assert.ok(base, '应有 field.base');
  assert.equal(base.data.owner, 'p2', '撞 P2 基地');
  // 缺省 logger 安全
  assert.equal(f.clampX(1050), 992);
  assert.equal(f.touchesBase({ x: 992, facing: 1 }, 1056, 1), true);
});