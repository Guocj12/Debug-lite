'use strict';
/* .audit/replay-audit.js —— 帧数据充分性审计（P4 B23；MS4 字段审计 + T-BT-1 强化）
 * 独立于测试套件：内部跑一场真实战斗（battleApi.runBattle）并对回放帧做六维审计——
 * ①字段齐备 ②1px/数值域 ③tick 连续 ④事件 cid/tick 归属 ⑤帧间衔接（位置继承）⑥终帧 verdict。
 * 用法：`node .audit/replay-audit.js`（exit 0=通过/1=不通过）；auditFrames(frames) 可 require 复用。
 */
const battle = require('../server/battle.js');
const LD = require('../tests/fixtures/loadout-ok.json');

function auditFrames(frames) {
  const problems = [];
  if (!Array.isArray(frames) || frames.length === 0) return { ok: false, problems: ['空帧集'], stats: { frames: 0 } };
  const need = ['players', 'bullets', 'bases', 'events', 'aiTrace', 'collision', 'bulletHits', 'verdict'];
  let events = 0;
  let collisions = 0;
  let hits = 0;
  const hitFrames = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const d = f && f.diff;
    if (!d) { problems.push(`frame[${i}] 缺 diff`); continue; }
    try {
      // ① 字段齐备
      for (const k of need) if (!(k in d)) problems.push(`tick${f.tick} 缺字段 ${k}`);
      // ③ tick 连续
      if (f.tick !== i + 1) problems.push(`tick 不连续: ${f.tick} @${i}`);
      // ② 1px 与有限数值域（B23 P2-1：isFinite + 上界，NaN/Infinity/hp=1e9 均拒）
      const finite = (v) => Number.isFinite(v);
      const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
      for (const o of ['p1', 'p2']) {
        const pl = d.players && d.players[o];
        if (!pl) { problems.push(`tick${f.tick} 缺 ${o}`); continue; }
        for (const v of [pl.fromX, pl.toX]) if (!Number.isInteger(v)) problems.push(`tick${f.tick} ${o} 位置非 1px: ${v}`);
        for (const v of [pl.hp, pl.mp, pl.sp]) if (!inRange(v, 0, 1e6)) problems.push(`tick${f.tick} ${o} 数值域异常（越界/NaN/Infinity）: ${v}`);
      }
      for (const bd of d.bullets || []) {
        if (!Number.isInteger(bd.x)) problems.push(`tick${f.tick} 弹幕 x 非 1px`);
        if (!bd.uid || !bd.owner || !finite(bd.v)) problems.push(`tick${f.tick} 弹幕字段不足（uid/owner/v）`);
      }
      for (const h of d.bulletHits || []) {
        if (!Number.isInteger(h.atX)) problems.push(`tick${f.tick} 命中位置非 1px`);
        hits += 1;
      }
      if (d.collision) collisions += 1;
      for (const bd of [d.bases && d.bases.p1, d.bases && d.bases.p2]) {
        if (!bd || !inRange(bd.hp, 0, 1e6) || !finite(bd.def)) problems.push(`tick${f.tick} bases 数值异常`);
      }
      // ④ 事件 cid/tick
      const evs = Array.isArray(d.events) ? d.events : [];
      if (!Array.isArray(d.events)) problems.push(`tick${f.tick} events 非数组`);
      for (const e of evs) {
        if (typeof e.cid !== 'string' || !e.cid.startsWith(`t${f.tick}:`)) problems.push(`tick${f.tick} 事件 cid 异常: ${e.cid}`);
        if (e.tick !== f.tick) problems.push(`tick${f.tick} 事件 tick 错位`);
        events += 1;
      }
      // ⑤ 帧间衔接（位置继承）
      if (i > 0) {
        for (const o of ['p1', 'p2']) {
          if (d.players[o].fromX !== frames[i - 1].diff.players[o].toX) {
            problems.push(`tick${f.tick} ${o} 帧间位置不衔接（${frames[i - 1].diff.players[o].toX} → ${d.players[o].fromX}）`);
          }
        }
      }
      if ((d.bulletHits || []).length > 0) hitFrames.push(i);
    } catch (e) {
      problems.push(`frame[${i}] 审计异常: ${e.message}`); // B23 P2-2：畸形帧不抛穿
    }
  }
  // ⑥ 终帧 verdict（末帧可能为 null/畸形 → 不抛）
  const last = frames[frames.length - 1];
  if (!last || !last.diff || !last.diff.verdict) problems.push('终帧无 verdict');
  // ⑦ 命中帧链完整性（B23 P2-7）：spawn→hit→(dodge|calc)→tick.end 顺序 + 无碰撞帧 hp 守恒
  for (const i of hitFrames) {
    const f = frames[i];
    const evs = Array.isArray(f.diff.events) ? f.diff.events : [];
    const findIdx = (ev) => evs.findIndex((e) => e.event === ev);
    const iSpawn = findIdx('bullet.spawn');
    const iHit = findIdx('bullet.hit');
    const iCalc = evs.findIndex((e) => e.event === 'damage.calc' || e.event === 'damage.dodge');
    const iEnd = findIdx('tick.end');
    if (iSpawn === -1 || iHit === -1 || iCalc === -1 || iEnd === -1) problems.push(`tick${f.tick} 命中帧链缺事件（spawn/hit/calc|dodge/end）`);
    else if (!(iSpawn < iHit && iHit < iCalc && iCalc < iEnd)) problems.push(`tick${f.tick} 命中帧链序异常`);
    if (!f.diff.collision) {
      const ownerOf = (id) => (id === 'A' ? 'p1' : id === 'B' ? 'p2' : null); // damage.calc 的 data.target 是玩家 id
      const byTarget = {};
      for (const e of evs) {
        if (e.event === 'damage.calc' && e.data && e.data.target) {
          const ow = ownerOf(e.data.target);
          if (ow) byTarget[ow] = (byTarget[ow] || 0) + (e.data.dmg || 0);
        }
      }
      for (const [t, sum] of Object.entries(byTarget)) {
        if (i > 0) {
          const prev = frames[i - 1].diff.players[t].hp;
          const cur = f.diff.players[t].hp;
          if (prev - cur !== sum) problems.push(`tick${f.tick} ${t} hp 差 ${prev - cur} ≠ Σdmg ${sum}`);
        }
      }
    }
  }
  return { ok: problems.length === 0, problems, stats: { frames: frames.length, events, collisions, hits, hitFrames: hitFrames.length } };
}

function run() {
  // B23 P2-3 雕像局破除：fixture AI 的 'skill1' 行动名非法（引擎只认 skill: 前缀）→
  // 审计局 p1 用 'skill:skill1'、p2 用独立追击程序（move_left）——双方相向才有碰撞/命中链真执行
  const LD = require('../tests/fixtures/loadout-ok.json');
  const ld = JSON.parse(JSON.stringify(LD.loadout));
  if (ld.ai && ld.ai.body && ld.ai.body.statements && ld.ai.body.statements[1] && ld.ai.body.statements[1].else) {
    const elseStmts = ld.ai.body.statements[1].else.statements || [];
    for (const s of elseStmts) if (s && s.type === 'action' && s.name === 'skill1') s.name = 'skill:skill1';
  }
  const p2 = JSON.parse(JSON.stringify(ld));
  p2.ai = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } };
  const r = battle.runBattle({ p1: ld, p2, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
  if (r.status !== 200) {
    console.error(`battle 失败: ${r.code} ${r.message}`);
    process.exitCode = 1;
    return;
  }
  const audit = auditFrames(r.data.frames);
  console.log(`回放审计: ${r.data.ticks} tick（winner=${r.data.winner}）frames=${audit.stats.frames} events=${audit.stats.events} collisions=${audit.stats.collisions} hits=${audit.stats.hits} hitFrames=${audit.stats.hitFrames}`);
  if (audit.ok && audit.stats.hits > 0) {
    console.log('[PASS] 帧数据充分性审计通过（含命中链）');
    process.exitCode = 0;
  } else {
    console.error(`[FAIL] ${audit.problems.length} 处问题` + (audit.stats.hits === 0 ? '（0 命中——雕像局，行动名是否非法？）' : '') + ':');
    for (const p of audit.problems.slice(0, 20)) console.error(`  - ${p}`);
    process.exitCode = 1;
  }
}

module.exports = { auditFrames, run };

if (require.main === module) run();