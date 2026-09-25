'use strict';
// B23 文本回放器 CLI + 帧充分性审计 —— 契约 docs/interfaces.md §3（replay --file/--tick）；
// tasks §6 B23 行（replay 文本回放含 px 位置与碰撞 + 帧数据充分性审计；T-CLI-1/2）。
//
// P7-7 §R5 重构：本地 `quiet()` / `capture()` / `makeReplayFile()` 换成 `tests/helpers/cli.js`
//   （三者在 7 个 CLI 测试里各有一份）；"缺 --file / 文件不存在 / --tick 越界 / 无 frames / 畸形帧 /
//   未知旗标 → 2"全部移入 tests/cli/cli-usage-rc2.test.js 的表驱动用例。本文件保留 0 与审计语义。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const cli = require('../../cli/index.js');
const { auditFrames } = require('../../.audit/replay-audit.js');
const c = require('../helpers/cli.js');

// 原实现把 stdout/stderr 合并成一个数组断言；helpers/cli.js 分开两个通道 → 这里保持合并口径
const merged = (r) => r.log.concat(r.err).join('\n');

test('CLI replay：--tick 单帧文本（px/碰撞/事件）→ 0；全量时间线 → 0', async () => {
  const { file, ticks, dir } = c.makeReplayFile();
  try {
    const a = await c.quiet(() => cli.main(['replay', '--file', file, '--tick', '1'], { baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(a, 0, '单帧文本回放 → 0（本地文件，不碰服务端）');
    const b = await c.quiet(() => cli.main(['replay', '--file', file, '--tick', String(ticks)], { baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(b, 0, '终帧（含 verdict）→ 0');
    const full = await c.quiet(() => cli.main(['replay', '--file', file], { baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(full, 0, '全量时间线 → 0');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('帧充分性审计（auditFrames）：字段/1px/tick 连续/事件 cid/帧间衔接/终帧 verdict 全过', () => {
  const battle = require('../../server/battle.js');
  const LD = require('../fixtures/loadout-ok.json');
  const ld = skillAi(LD);
  const r = battle.runBattle({ p1: ld, p2: ld, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
  assert.equal(r.status, 200);
  const audit = auditFrames(r.data.frames);
  assert.equal(audit.ok, true, audit.problems.join('；'));
  // D-167：对外帧不再携带引擎日志（events）；"这一帧发生了什么"改由结构化 damages/bullets 承载。
  //   断言强度不降：要求每一处 hp 变化都能在 damages 里找到归因（或本 tick 无伤害）。
  const dmgFrames = r.data.frames.filter((f) => (f.diff.damages || []).length > 0);
  assert.ok(dmgFrames.length > 0, '技能局应有带 damages 的帧（本用例不得空转）');
  for (const f of dmgFrames) {
    for (const dm of f.diff.damages) {
      assert.ok(Number.isInteger(dm.amount) && dm.amount >= 0, `damages.amount 非法: ${JSON.stringify(dm)}`);
      assert.ok(['bullet', 'collision', 'base', 'overtime'].includes(dm.kind), `damages.kind 非法: ${dm.kind}`);
    }
  }
  assert.equal('events' in r.data.frames[0].diff, false, 'D-167：对外帧不得携带 events（日志走 /admin/replay-frames）');
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

// p2 独立追击 loadout（相向才产生碰撞/命中）
// D-164（2026-09-25）：AI 一律按"玩家自己永远在左（p1）"书写；p2 由服务端做守方镜像。
//   故"追击"必须写成 move_right（镜像到 p2 的真实世界 = move_left = 朝对手推进）；
//   修前写 move_left 属"p2 帧"旧口径，镜像落地后会让 p2 掉头远离 → 本用例会因 0 命中而失败。
function chaserLoadout(LD) {
  const ld = JSON.parse(JSON.stringify(LD.loadout));
  ld.ai = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } };
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

// ================= B23 可读性增强（用户 2026-09-19 勾选项 2）：伤害值 + 暴击/背击标注 =================
// 素材：帧 `diff.damages[]` 的 `{srcUid,attacker,target,amount,crit,critM,backstab,backM}`（D-167 起）——只读帧，不改退出码契约（0/1/2）。

// 有命中的真实回放（skillAi vs 追击者：seed 20260913 稳定产生 bulletHits）
function makeHitReplayFile() {
  const battle = require('../../server/battle.js');
  const LD = require('../fixtures/loadout-ok.json');
  const r = battle.runBattle({ p1: skillAi(LD), p2: chaserLoadout(LD), warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
  assert.equal(r.status, 200);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-b23-dmg-'));
  const file = path.join(dir, 'replay.json');
  fs.writeFileSync(file, JSON.stringify({ summary: { winner: r.data.winner, ticks: r.data.ticks }, frames: r.data.frames }));
  return { file, frames: r.data.frames, dir };
}

// 手工帧：精确覆盖 暴击/背击/无标注/护栏 四个渲染分支（真实战斗不一定每次掷出暴击）
function makeSyntheticReplayFile() {
  const frame1 = {
    tick: 1,
    diff: {
      players: {
        p1: { fromX: 224, toX: 288, facing: 1, hp: 90, mp: 40, sp: 60 },
        p2: { fromX: 800, toX: 736, facing: -1, hp: 88, mp: 40, sp: 60 },
      },
      collision: { contactX: 256 },
      bulletHits: [{ uid: 'b_1', target: 'p2', atX: 500 }, { uid: 'b_2', target: 'p1', atX: 400 }],
      // D-167：伤害数值改由 damages[] 承载（不再有 events）
      damages: [
        { srcUid: 'b_1', attacker: 'p1', target: 'p2', amount: 12, atX: 500, kind: 'bullet', crit: true, critM: 1.5, backstab: true, backM: 1.5, dodged: false },
        { srcUid: 'b_2', attacker: 'p2', target: 'p1', amount: 7, atX: 400, kind: 'bullet', crit: false, critM: 1, backstab: false, backM: 1, dodged: false },
        { srcUid: null, attacker: 'p1', target: 'p2', amount: 5, atX: null, kind: 'collision', crit: false, critM: 1, backstab: true, backM: 1.5, dodged: false },
      ],
      verdict: null,
    },
  };
  const frame2 = {
    tick: 2,
    diff: {
      players: {
        p1: { fromX: 288, toX: 288, facing: 1, hp: 90, mp: 40, sp: 60 },
        p2: { fromX: 736, toX: 736, facing: -1, hp: 88, mp: 40, sp: 60 },
      },
      collision: null,
      bulletHits: [{ uid: 'b_9', target: 'p2', atX: 50 }],
      // 故意缺 damages 字段（护栏分支；命中无对应伤害 → 只显示命中坐标）
    },
  };
  const frame3 = {
    tick: 3,
    diff: {
      players: {
        p1: { fromX: 288, toX: 288, facing: 1, hp: 90, mp: 40, sp: 60 },
        p2: { fromX: 736, toX: 736, facing: -1, hp: 0, mp: 40, sp: 60 },
      },
      collision: null,
      bulletHits: [],
      damages: [null, { srcUid: null, attacker: 'p1', target: 'p2', amount: 3, atX: null, kind: 'overtime', crit: false, critM: 1, backstab: false, backM: 1, dodged: false }],
      verdict: { winner: 'p1', phase: 'role' },
    },
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-b23-syn-'));
  const file = path.join(dir, 'replay.json');
  fs.writeFileSync(file, JSON.stringify({ summary: { winner: 'p1', ticks: 3 }, frames: [frame1, frame2, frame3] }));
  return { file, dir };
}

test('B23 增强：真实战斗回放逐帧命中带伤害归属与数值（hitUid 对照）', async () => {
  const { file, frames, dir } = makeHitReplayFile();
  try {
    const { result, ...rest } = await c.capture(() => cli.main(['replay', '--file', file], { baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(result, 0, '全量时间线 → 0（契约不变）');
    const outText = rest.log.concat(rest.err).join('\n');
    const hits = frames.flatMap((f) => (f.diff.bulletHits || []).map((h) => ({ ...h })));
    assert.ok(hits.length > 0, '夹具局应有命中（否则本用例空转）');
    const dmgUids = new Set(frames.flatMap((f) => (f.diff.damages || [])
      .filter((dm) => dm && typeof dm.srcUid === 'string' && dm.srcUid !== '')
      .map((dm) => dm.srcUid)));
    assert.ok(dmgUids.size > 0, '夹具局应有带 srcUid 的伤害记录');
    for (const h of hits) {
      const base = `${h.uid}->${h.target}@${h.atX}`;
      assert.ok(outText.includes(base), `回放应含命中坐标 ${base}`);
      if (dmgUids.has(h.uid)) assert.ok(outText.includes(`${base}->`), `命中 ${h.uid} 应带伤害归属（uid->目标@坐标->攻方->受方 数值）`);
      else assert.ok(!outText.includes(`${base}->`), `命中 ${h.uid} 无 damages → 不应伪造伤害数字`);
    }
    // 帧里出现暴击/背击时，输出必须标注（条件断言；绝对值由下一条合成帧用例钉死）
    const dms = frames.flatMap((f) => f.diff.damages || []);
    if (dms.some((dm) => dm && dm.crit)) {
      assert.ok(outText.includes('暴击×'), '存在暴击 → 输出应标注暴击');
    }
    if (dms.some((dm) => dm && dm.backstab)) {
      assert.ok(outText.includes('背击×'), '存在背击 → 输出应标注背击');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('B23 增强：渲染分支钉死（暴击/背击/无标注/无 hitUid 伤害/缺 data 护栏）且退出码不变', async () => {
  const { file, dir } = makeSyntheticReplayFile();
  try {
    const all = await c.capture(() => cli.main(['replay', '--file', file], { baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(all.result, 0, '全量时间线 → 0');
    const outText = merged(all);
    assert.ok(outText.includes('b_1->p2@500->p1->p2 12 (暴击×1.5 背击×1.5)'), `暴击+背击应标注：${outText}`);
    assert.ok(outText.includes('b_2->p1@400->p2->p1 7'), '无暴击/背击 → 只有数值，无括号标注');
    assert.ok(!outText.includes('p2->p1 7 ('), '无标注时不得输出括号尾巴');
    assert.ok(outText.includes('| 伤害[p1->p2 5 (背击×1.5)]'), '无 srcUid 的伤害（碰撞/撞基地/超时）归入「伤害[]」段');
    assert.ok(outText.includes('| 伤害[p1->p2 3]'), '第 3 帧无 srcUid 伤害同样渲染');
    assert.ok(outText.includes('| 命中[b_9->p2@50]'), '命中无对应伤害记录 → 只显示坐标（不伪造数字）');
    assert.ok(outText.includes('tick 2: p1 288->288'), '帧 2 缺 damages 字段不抛（护栏）');
    assert.ok(outText.includes('verdict: winner=p1 phase=role（3 tick）'), '终帧 verdict 行保持');
    // 单帧路径（--tick 1）同样带伤害标注
    const one = await c.capture(() => cli.main(['replay', '--file', file, '--tick', '1'], { baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(one.result, 0, '--tick 1 → 0');
    assert.ok(merged(one).includes('b_1->p2@500->p1->p2 12 (暴击×1.5 背击×1.5)'), '单帧路径同样标注伤害');
    const two = await c.capture(() => cli.main(['replay', '--file', file, '--tick', '2'], { baseUrl: 'http://127.0.0.1:1' }));
    assert.equal(two.result, 0, '--tick 2（缺 damages 字段）→ 0 不抛');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
