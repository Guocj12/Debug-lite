'use strict';
// tests/helpers/gen.test.js —— gen.js 契约测试（tests/README.md「tests/helpers/gen.js 契约」）
// 归属：P0-3 测试基建（先红后绿 L7）；确定性/边界/出错路径全覆盖。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const gen = require('./gen.js');

test('G-1 mulberry32：标准公式序列（seed=42 前 5 值锁定）', () => {
  const r = gen.mulberry32(42);
  const got = [r(), r(), r(), r(), r()];
  // mulberry32(42) 标准值（2026-09-12 独立实现复算一致：
  // a+0x6D2B79F5; t=imul(a^a>>>15,1|a); t=t+imul(t^t>>>7,61|t)^t; (t^t>>>14)>>>0 / 2^32）
  assert.deepEqual(got, [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423]);
});

test('G-2 mulberry32：值域 [0,1) 且 两个种子首值不同', () => {
  const a = gen.mulberry32(1);
  const b = gen.mulberry32(2);
  for (let i = 0; i < 100; i++) {
    const v = a();
    assert.ok(v >= 0 && v < 1, `越界值 ${v}`);
  }
  const b0 = b();
  assert.ok(b0 >= 0 && b0 < 1);
  // 首值不同（种子 1 与 2 的流不同才是分布合理的散列）
  assert.notEqual(gen.mulberry32(1)(), b0);
});

test('G-3 createGen.float：默认 [0,1)，带参 [lo,hi) 且含边界 0', () => {
  const g1 = gen.createGen(7);
  const f0 = g1.float();
  assert.ok(f0 >= 0 && f0 < 1);
  const g2 = gen.createGen(7);
  const hi = 5;
  for (let i = 0; i < 200; i++) {
    const v = g2.float(2, hi);
    assert.ok(v >= 2 && v < hi, `float(2,5) 越界 ${v}`);
  }
  // 同 seed 同序列：两次 createGen(7) 的干流一致
  assert.equal(gen.createGen(7).float(), f0);
});

test('G-4 createGen.int：闭区间整数，两端可达，重复多次仍合规', () => {
  const g = gen.createGen(3);
  for (let i = 0; i < 500; i++) {
    const v = g.int(1, 4);
    assert.ok(Number.isInteger(v) && v >= 1 && v <= 4, `int(1,4) 越界 ${v}`);
  }
  assert.equal(gen.createGen(9).int(0, 0), 0, 'int(0,0) 恒 0');
  assert.equal(gen.createGen(9).int(5, 5), 5, 'int(5,5) 恒 5');
  assert.throws(() => gen.createGen(9).int(5, 3), /lo<=hi/, 'lo>hi 抛错');
  assert.throws(() => gen.createGen(9).int(1.5, 3), /整数/, '非整数参数抛错');
});

test('G-5 createGen.int：负数区间与上限==下限+1', () => {
  const g = gen.createGen(11);
  for (let i = 0; i < 300; i++) {
    const v = g.int(-3, -1);
    assert.ok(Number.isInteger(v) && v >= -3 && v <= -1, `int(-3,-1) 越界 ${v}`);
  }
  const g2 = gen.createGen(11);
  for (let i = 0; i < 300; i++) {
    const v = g2.int(6, 7);
    assert.ok(v === 6 || v === 7, `int(6,7) 越界 ${v}`);
  }
});

test('G-6 createGen.pick：单元素恒中；空数组抛错；多元素均匀性（统计）', () => {
  assert.equal(gen.createGen(1).pick(['only']), 'only');
  assert.throws(() => gen.createGen(1).pick([]), /空/, '空数组必须抛错');
  const g = gen.createGen(123);
  const arr = ['a', 'b', 'c', 'd'];
  const counts = { a: 0, b: 0, c: 0, d: 0 };
  const N = 10000;
  for (let i = 0; i < N; i++) counts[g.pick(arr)]++;
  for (const k of Object.keys(counts)) {
    const p = counts[k] / N;
    assert.ok(Math.abs(p - 0.25) < 0.02, `${k} 频率 ${p} 偏离 25% 超 2%`);
  }
});

test('G-7 createGen.chance：p=0 恒 false、p=1 恒 true、p=0.5 统计接近', () => {
  const c0 = gen.createGen(5);
  for (let i = 0; i < 100; i++) assert.equal(c0.chance(0), false);
  const c1 = gen.createGen(5);
  for (let i = 0; i < 100; i++) assert.equal(c1.chance(1), true);
  const cm = gen.createGen(5);
  let yes = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) if (cm.chance(0.5)) yes++;
  const p = yes / N;
  assert.ok(Math.abs(p - 0.5) < 0.02, `p=0.5 频率 ${p} 偏离超 2%`);
  assert.throws(() => cm.chance(-0.1), /0|1/, 'p<0 抛错');
  assert.throws(() => cm.chance(1.2), /0|1/, 'p>1 抛错');
});

test('G-8 createGen.shuffle：元素守恒、确定性、与顺序相关', () => {
  const arr = [1, 2, 3, 4, 5, 6, 7];
  const s1 = gen.createGen(13);
  const s2 = gen.createGen(13);
  const a1 = s1.shuffle(arr);
  const a2 = s2.shuffle(arr);
  assert.deepEqual(a1, a2, '同 seed 打乱结果一致');
  assert.deepEqual([...a1].sort((x, y) => x - y), arr, '元素守恒');
  assert.notDeepEqual(a1, arr, '7 元素打乱后应有序变化（概率上必然）');
  // 原数组不被修改（返回新数组）
  assert.deepEqual(arr, [1, 2, 3, 4, 5, 6, 7]);
});

test('G-9 createGen.deriveStream（D-91 对齐）：同参同流、异参异流、纯函数', () => {
  const d1 = gen.createGen(77).deriveStream(3, 'ai');
  const d2 = gen.createGen(77).deriveStream(3, 'ai');
  const d3 = gen.createGen(77).deriveStream(4, 'ai');
  const d4 = gen.createGen(77).deriveStream(3, 'crit');
  for (let i = 0; i < 50; i++) assert.equal(d1.float(), d2.float(), '同 tick+purpose 流一致');
  // 父流不因 deriveStream 而推进（纯函数派生）
  const parent = gen.createGen(77);
  parent.deriveStream(3, 'ai');
  const parent2 = gen.createGen(77);
  assert.equal(parent.float(), parent2.float(), 'deriveStream 不消耗父流');
  const got3 = d3.float();
  const got4 = d4.float();
  assert.notEqual(got3, got4, '不同 purpose 流应不同');
  const d5 = gen.createGen(77).deriveStream(4, 'ai');
  assert.equal(d5.float(), got3, '跨实例同参仍一致');
});

test('G-10 hash32：确定性、uint32 域、雪崩（微小输入差 → 输出差）', () => {
  assert.equal(gen.hash32('abc'), gen.hash32('abc'));
  const h1 = gen.hash32('abc');
  assert.ok(Number.isInteger(h1) && h1 >= 0 && h1 <= 0xffffffff, `hash32 越域 ${h1}`);
  const h2 = gen.hash32('abd');
  assert.notEqual(h1, h2, '1 字节差必须不同');
  assert.notEqual(gen.hash32('3:ai'), gen.hash32('3:crit'), 'purpose 差必须不同');
  assert.notEqual(gen.hash32('3:ai'), gen.hash32('4:ai'), 'tick 差必须不同');
});

test('G-11 seed 归一化：NaN/负数/字符串数字 → uint32，确定性不受影响', () => {
  const a = gen.createGen('42');
  const b = gen.createGen(42);
  assert.equal(a.float(), b.float(), '字符串数字 seed 与数字 seed 同流');
  const c = gen.createGen(-1);
  const d = gen.createGen(-1);
  assert.equal(c.float(), d.float(), '负 seed 确定性');
  assert.equal(gen.createGen(NaN).float(), gen.createGen(undefined).float(), '缺失 seed 视为 0');
});

test('G-12 大样本统计：int 均匀性（种子化，误差 <2%）', () => {
  const g = gen.createGen(20260912);
  const counts = [0, 0, 0, 0];
  const N = 10000;
  for (let i = 0; i < N; i++) counts[g.int(0, 3)]++;
  for (let c = 0; c < 4; c++) {
    const p = counts[c] / N;
    assert.ok(Math.abs(p - 0.25) < 0.02, `int(0,3) 第 ${c} 档频率 ${p} 偏离超 2%`);
  }
});