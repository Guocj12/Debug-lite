'use strict';
// .review-b17/probe.test.js —— 临时探针（不在 tests/ 下，不进门禁）：定位 items.js 分支缺口
// 差分测量：加入下列调用后 items.js 分支覆盖率是否回升 → 以判定 86.67 的缺口组成。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const items = require('../server/core/items.js');
const { createRng } = require('../server/core/rng.js');

test('probe-A rollQuality 非法 tier → 全池（交付要求「tier 缺省/非法 → 全池」）', () => {
  const q1 = items.rollQuality(createRng(1), 'diamond');
  const q2 = items.rollQuality(createRng(1), 42);
  const q3 = items.rollQuality(createRng(1), null);
  for (const q of [q1, q2, q3]) {
    assert.ok(['common', 'rare', 'epic', 'legendary', 'mythic'].includes(q));
  }
});

test('probe-B openBox 非法 tier → 门控池空 → RangeError（409 源头链路）', () => {
  assert.throws(() => items.openBox(createRng(2), { tier: 'diamond' }), RangeError);
});

test('probe-C 字符串模板入参分支 + validateUnlock 非法段位 + tierOf 字符串品质', () => {
  const r = items.generateRoleItem('role_bal', 'rare', createRng(3));
  assert.equal(r.templateId, 'role_bal');
  const s = items.generateSkillItem('skill_melee_whirl', 'rare', createRng(3));
  assert.equal(s.templateId, 'skill_melee_whirl');
  assert.equal(items.validateUnlock({ unlockTier: 42 }, 'common'), false);
  const t = items.tierOf(createRng(3), 'epic'); // tierOf(rng, quality) 签名
  assert.ok(t >= 1 && t <= 3);
});

test('probe-D 空池防御臂（插件池空 / 类别接管）', () => {
  // generatePlugin 空池（kind 无匹配）：直接传 poolOverride 空数组
  assert.throws(() => items.generatePlugin('rolePlugin', 'rare', createRng(3), []), RangeError);
  // openBox 空 role 池：用 stub rng 固定 kind=role + 无解锁角色（数据不可变 → 经 unlockTier 全超的 tier
  // 已在 probe-B 覆盖 role 池空臂；此处再覆盖 skill 池空臂：stub 固定 kind=skill
  const stub = {
    float: (lo, hi) => (lo === 0 && hi === 1 ? 0.05 : 0.5), // v=0.05 → 品质=common；kindWeights 加权 6 → 每次同值
    int: (lo, hi) => lo,
    pick: (a) => a[0],
  };
  // kind=skill 需要 v 落在 [1/6, 2/6)：v=0.05*6=0.3 → skill
  assert.throws(() => items.openBox(stub, { tier: 'diamond' }), RangeError);
});