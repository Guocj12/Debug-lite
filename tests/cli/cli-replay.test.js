'use strict';
// B23 文本回放器 CLI + 帧充分性审计 —— 契约 docs/interfaces.md §3（replay --file/--tick）；
// tasks §6 B23 行（replay 文本回放含 px 位置与碰撞 + 帧数据充分性审计；T-CLI-1/2）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const cli = require('../../cli/index.js');
const { auditFrames } = require('../../.audit/replay-audit.js');

const LD_FILE = path.join(__dirname, '..', 'fixtures', 'loadout-ok.json');

// 生成一份回放文件（直接调用 battle 模块，不经 HTTP——replay 子命令本身不碰服务端）
function makeReplayFile() {
  const battle = require('../../server/battle.js');
  const LD = require('../fixtures/loadout-ok.json');
  const r = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
  assert.equal(r.status, 200);
  const file = path.join(os.tmpdir(), `b23-replay-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify({ summary: { winner: r.data.winner, ticks: r.data.ticks }, frames: r.data.frames }));
  return { file, ticks: r.data.ticks };
}

async function quiet(fn) {
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test('CLI replay：--tick 单帧文本（px/碰撞/事件）→ 0；全量时间线 → 0', async () => {
  const { file, ticks } = makeReplayFile();
  const a = await quiet(() => cli.main(['replay', '--file', file, '--tick', '1'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(a, 0, '单帧文本回放 → 0（本地文件，不碰服务端）');
  const b = await quiet(() => cli.main(['replay', '--file', file, '--tick', String(ticks)], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(b, 0, '终帧（含 verdict）→ 0');
  const c = await quiet(() => cli.main(['replay', '--file', file], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(c, 0, '全量时间线 → 0');
  fs.unlinkSync(file);
});

test('CLI replay 失败路径：无 --file/缺 frames/tick 越界/文件缺失 → 2', async () => {
  const { file } = makeReplayFile();
  const noFile = await quiet(() => cli.main(['replay'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(noFile, 2, '缺 --file → 2');
  const missing = await quiet(() => cli.main(['replay', '--file', path.join(__dirname, 'no.json')], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(missing, 2, '文件不存在 → 2');
  const badTick = await quiet(() => cli.main(['replay', '--file', file, '--tick', '999'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(badTick, 2, 'tick 越界 → 2');
  const noFrames = path.join(os.tmpdir(), `b23-noframes-${Date.now()}.json`);
  fs.writeFileSync(noFrames, JSON.stringify({ foo: 1 }));
  const badData = await quiet(() => cli.main(['replay', '--file', noFrames], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(badData, 2, '无 frames → 2');
  fs.unlinkSync(file);
  fs.unlinkSync(noFrames);
});

test('帧充分性审计（auditFrames）：字段/1px/tick 连续/事件 cid/帧间衔接/终帧 verdict 全过', () => {
  const battle = require('../../server/battle.js');
  const LD = require('../fixtures/loadout-ok.json');
  const ld = skillAi(LD);
  const r = battle.runBattle({ p1: ld, p2: ld, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
  assert.equal(r.status, 200);
  const audit = auditFrames(r.data.frames);
  assert.equal(audit.ok, true, audit.problems.join('；'));
  assert.ok(audit.stats.frames > 0 && audit.stats.events > 0, '事件密度非零（B22 P1-1 修复后 events 非空）');
  // 负向验证：篡改一帧 → 审计必抓
  const bad = JSON.parse(JSON.stringify(r.data.frames));
  delete bad[0].diff.bases;
  const audit2 = auditFrames(bad);
  assert.equal(audit2.ok, false);
  assert.ok(audit2.problems.some((p) => p.includes('bases')), '缺字段被抓');
});

// B23 P2-3 雕像局破除：fixture AI 行动名 'skill1' 非法（引擎只认 skill: 前缀）→ 审计/测试局用 'skill:skill1'
function skillAi(LD) {
  const ld = JSON.parse(JSON.stringify(LD.loadout));
  const elseStmts = ld.ai && ld.ai.body && ld.ai.body.statements[1] && ld.ai.body.statements[1].else && ld.ai.body.statements[1].else.statements || [];
  for (const s of elseStmts) if (s && s.type === 'action' && s.name === 'skill1') s.name = 'skill:skill1';
  return ld;
}

test('B23 P1-1 回归：畸形帧不抛穿（[{}]/缺 players/diff null/frames null）→ 2', async () => {
  const cases = [
    { frames: [{}] },
    { frames: [{ tick: 1, diff: { players: { p1: { fromX: 1, toX: 2 } }, events: [] } }] },
    { frames: [{ tick: 1, diff: null }] },
    { frames: null },
  ];
  for (const [i, data] of cases.entries()) {
    const file = path.join(os.tmpdir(), `b23-malformed-${i}-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(data));
    const code = await quiet(() => cli.main(['replay', '--file', file], { baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(code, 2, `畸形帧变体 ${i} → 2（非 1）`);
    fs.unlinkSync(file);
  }
  const flag = await quiet(() => cli.main(['replay', '--file', 'x.json', '--bogus'], { baseUrl: 'http://127.0.0.1:1' }));
  assert.equal(flag, 2, '未知旗标 → 2');
});

// p2 独立追击 loadout（相向才产生碰撞/命中）
function chaserLoadout(LD) {
  const ld = JSON.parse(JSON.stringify(LD.loadout));
  ld.ai = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } };
  return ld;
}

test('B23 audit 增强：NaN/Infinity hp 被抓；畸形帧 {frames:[null]} 不抛且 ok:false', () => {
  const battle = require('../../server/battle.js');
  const LD = require('../fixtures/loadout-ok.json');
  const r = battle.runBattle({ p1: skillAi(LD), p2: chaserLoadout(LD), warehouse: LD.warehouse, seed: 3, tier: 'mythic' });
  assert.equal(r.status, 200);
  const frames = JSON.parse(JSON.stringify(r.data.frames));
  frames[0].diff.players.p1.hp = NaN; // 直改内存对象（JSON 会吞 NaN，这里验证审计本体）
  const a1 = auditFrames(frames);
  assert.equal(a1.ok, false);
  assert.ok(a1.problems.some((p) => p.includes('数值域')), 'NaN hp 被抓（P2-1）');
  const a2 = auditFrames([null, null]); // 畸形帧不抛
  assert.equal(a2.ok, false);
  assert.ok(Array.isArray(a2.problems), '畸形帧 → {ok:false} 不抛（P2-2）');
});

test('B23 audit 第七维：技能局 hits>0 且链序/守恒通过（雕像局破除实证）', () => {
  const battle = require('../../server/battle.js');
  const LD = require('../fixtures/loadout-ok.json');
  const r = battle.runBattle({ p1: skillAi(LD), p2: chaserLoadout(LD), warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
  assert.equal(r.status, 200);
  const audit = auditFrames(r.data.frames);
  assert.equal(audit.ok, true, audit.problems.join('；'));
  assert.ok(audit.stats.hits > 0, `技能局应有命中（实际 ${audit.stats.hits}）——链/守恒维度真实执行`);
  assert.ok(audit.stats.hitFrames > 0, '存在命中帧（第七维链检查执行）');
});