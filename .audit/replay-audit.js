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
  // D-167：对外帧的字段契约（events 可选——日志走 POST /admin/replay-frames；缺失时跳过 ④ cid 检查）
  const need = ['players', 'bullets', 'bases', 'aiTrace', 'collision', 'bulletHits', 'baseHits', 'damages', 'verdict'];
  const OUTCOMES = new Set(['hit', 'collide', 'expire']);
  const DMG_KINDS = new Set(['bullet', 'collision', 'base', 'overtime']);
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
        // D-167 新增：五维/上限必须齐备且有限；行动与 buff 形状必须可消费
        for (const v of [pl.maxHp, pl.maxMp, pl.maxSp, pl.atk, pl.def]) if (!inRange(v, 0, 1e6)) problems.push(`tick${f.tick} ${o} 五维/上限异常: ${v}`);
        if (!pl.action || typeof pl.action.kind !== 'string') problems.push(`tick${f.tick} ${o} 缺 action.kind`);
        if (!Array.isArray(pl.effects)) problems.push(`tick${f.tick} ${o} effects 非数组`);
      }
      // ②b 弹幕完整生命周期（D-167）：出现/消失位置 1px + 结局与字段自洽
      for (const bd of d.bullets || []) {
        if (!bd.uid || !bd.owner || !finite(bd.v)) problems.push(`tick${f.tick} 弹幕字段不足（uid/owner/v）`);
        for (const v of [bd.spawnX, bd.endX]) if (!Number.isInteger(v)) problems.push(`tick${f.tick} 弹幕出现/消失位置非 1px: ${v}`);
        if (!OUTCOMES.has(bd.outcome)) problems.push(`tick${f.tick} 弹幕 outcome 非法: ${bd.outcome}`);
        if (bd.outcome === 'hit' && !bd.hitTarget) problems.push(`tick${f.tick} 弹幕 outcome=hit 但缺 hitTarget`);
        if (bd.outcome === 'collide' && !bd.collideWith) problems.push(`tick${f.tick} 弹幕 outcome=collide 但缺 collideWith`);
      }
      for (const h of d.bulletHits || []) {
        if (!Number.isInteger(h.atX)) problems.push(`tick${f.tick} 命中位置非 1px`);
        hits += 1;
      }
      // ②c 撞基地（数组）与伤害数值（D-167）
      for (const bh of d.baseHits || []) {
        if (bh.owner !== 'p1' && bh.owner !== 'p2') problems.push(`tick${f.tick} baseHits.owner 非法: ${bh.owner}`);
        if (!Number.isInteger(bh.atX)) problems.push(`tick${f.tick} 撞基地位置非 1px: ${bh.atX}`);
      }
      for (const dm of d.damages || []) {
        if (dm.target !== 'p1' && dm.target !== 'p2') problems.push(`tick${f.tick} damages.target 非法: ${dm.target}`);
        if (!DMG_KINDS.has(dm.kind)) problems.push(`tick${f.tick} damages.kind 非法: ${dm.kind}`);
        if (!Number.isInteger(dm.amount) || dm.amount < 0) problems.push(`tick${f.tick} damages.amount 非非负整数: ${dm.amount}`);
        if (dm.atX !== null && !Number.isInteger(dm.atX)) problems.push(`tick${f.tick} damages.atX 非 1px: ${dm.atX}`);
      }
      if (d.collision) collisions += 1;
      for (const bd of [d.bases && d.bases.p1, d.bases && d.bases.p2]) {
        if (!bd || !inRange(bd.hp, 0, 1e6) || !finite(bd.def)) problems.push(`tick${f.tick} bases 数值异常`);
      }
      // ④ 事件 cid/tick（**仅当帧携带 events 时检查**——D-167 起对外帧不含日志，日志由
      //    `POST /api/v1/admin/replay-frames` 提供；此处对带日志的帧仍逐条核对 cid/tick 归属）
      const hasEvents = Object.prototype.hasOwnProperty.call(d, 'events');
      if (hasEvents && !Array.isArray(d.events)) problems.push(`tick${f.tick} events 非数组`);
      const evs = Array.isArray(d.events) ? d.events : [];
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
  // ⑦ 命中帧链完整性（B23 P2-7 → D-167 起改为**无日志**口径）：
  //   链 = bullets[](spawnX/outcome=hit/hitTarget) → bulletHits[](uid/target/atX) → damages[](srcUid=uid)
  //   hp 归因 = 每一次 hp 下降都必须有 damages 条目解释，且 Σamount ≥ 实际下降（regen 只能让净下降变小）
  for (const i of hitFrames) {
    const f = frames[i];
    const d = f.diff;
    for (const h of d.bulletHits || []) {
      const bullet = (d.bullets || []).find((b) => b.uid === h.uid);
      if (!bullet || bullet.outcome !== 'hit') problems.push(`tick${f.tick} 命中链缺 bullets[](uid=${h.uid}, outcome=hit)`);
      else if (bullet.hitTarget !== h.target) problems.push(`tick${f.tick} 命中链 target 不一致（bullets=${bullet.hitTarget} / bulletHits=${h.target}）`);
      const dmg = (d.damages || []).find((dm) => dm.srcUid === h.uid);
      if (!dmg) problems.push(`tick${f.tick} 命中链缺 damages[](srcUid=${h.uid})（闪避也应有 amount=0/dodged=true 的条目）`);
      else if (dmg.target !== h.target) problems.push(`tick${f.tick} 命中链 damages.target 不一致（${dmg.target} / ${h.target}）`);
    }
  }
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    // B23 P2-2：畸形帧（null/缺 diff/缺 players）不得抛穿审计
    if (!prev || !cur || !prev.diff || !cur.diff || !prev.diff.players || !cur.diff.players) continue;
    for (const o of ['p1', 'p2']) {
      const before = prev.diff.players[o].hp;
      const after = cur.diff.players[o].hp;
      if (after > before) continue; // 回复（regen）不在本审计范围
      const sum = (cur.diff.damages || []).filter((dm) => dm.target === o).reduce((n, dm) => n + dm.amount, 0);
      if (before - after > sum) {
        problems.push(`tick${cur.tick} ${o} hp 下降 ${before - after} > Σdamages ${sum}（血条变化无法归因）`);
      }
      if (after > cur.diff.players[o].maxHp) problems.push(`tick${cur.tick} ${o} hp 超过 maxHp`);
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