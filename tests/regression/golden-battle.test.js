'use strict';
/* tests/regression/golden-battle.test.js —— 黄金战斗正式回归（P1 B11 快照锚定；进入 npm test 计数）
 * 依据：.audit/golden-battle.js 的 runGolden（固定 loadout × 固定 AI 计划 × seed 20260912，18 tick/p2 胜）；
 *   快照 = .audit/golden-battle.json（本测试**只读**快照：口径变更时由人工复核后用 `node .audit/golden-battle.js --write` 重算，
 *   不在测试内自动改写，避免"实现漂移被快照悄悄吸收"）。
 * 覆盖：①同 seed 逐帧与快照一致（ticks/winner/phase + 逐帧 x/hp/mp/sp/碰撞/命中）②同 seed 两次运行完全一致（确定性）
 *   ③trace↔silent 逐帧一致 + 关键事件/cid 链（轻量复用 scripts/gate.js 项 8 的 checkLogSmoke，不重写行动计划）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { runGolden, SEED } = require('../../.audit/golden-battle.js');
const { checkLogSmoke } = require('../../scripts/gate.js');

const ROOT = path.join(__dirname, '..', '..');
const SNAPSHOT_FILE = path.join(ROOT, '.audit', 'golden-battle.json');

// 逐帧差异清单（对比逻辑与 .audit/golden-battle.js 同源：整帧 JSON 相等；最多列 5 条便于定位）
function diffFrames(cur, snap) {
  const out = [];
  const n = Math.max(cur.length, snap.length);
  for (let i = 0; i < n; i++) {
    const a = cur[i];
    const b = snap[i];
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const t = (a && a.t !== undefined) ? a.t : (b && b.t);
      out.push(`  t${t}: 现=${JSON.stringify(a)} / 快照=${JSON.stringify(b)}`);
      if (out.length >= 5) break;
    }
  }
  return out;
}

test('黄金战斗回归：同 seed(20260912) 逐帧与快照一致（ticks/winner/phase/x/hp/mp/sp/碰撞/命中）', () => {
  const { summary } = runGolden();
  assert.equal(summary.seed, SEED, 'seed 锚定 20260912');
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  assert.equal(summary.ticks, snap.ticks, `tick 数应与快照一致（现 ${summary.ticks} / 快照 ${snap.ticks}）`);
  assert.equal(summary.winner, snap.winner, `胜负应与快照一致（现 ${summary.winner} / 快照 ${snap.winner}）`);
  assert.equal(summary.phase, snap.phase, `结束 phase 应与快照一致（现 ${summary.phase} / 快照 ${snap.phase}）`);
  const bad = diffFrames(summary.frames, snap.frames);
  assert.equal(bad.length, 0, `黄金快照逐帧不一致（引擎口径变更？快照需人工重算，勿在测试内改）：\n${bad.join('\n')}`);
  assert.deepEqual(summary, snap, '整份摘要应与快照一致');
});

test('黄金战斗回归：同 seed 两次运行逐帧完全一致（确定性 T-EN-1/T-BT-5）', () => {
  const a = runGolden();
  const b = runGolden();
  assert.deepEqual(a.summary, b.summary, '两次运行摘要应完全一致');
  assert.equal(JSON.stringify(a.diffs), JSON.stringify(b.diffs), '两次运行 diff 帧应完全一致');
});

test('黄金战斗回归：trace 与 silent 逐帧一致 + 关键事件/cid 链齐备（T-LG-11/T-LG-5）', async () => {
  const res = await checkLogSmoke({ projectRoot: ROOT });
  assert.equal(res.status, 'pass', `日志冒烟（gate 项 8 同逻辑）应通过：${res.detail}`);
});
