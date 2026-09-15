'use strict';
// .review-b23/probe3.js —— auditFrames 负向篡改矩阵 + 数值域弱点探查（缺口自查 ①）
// 验证审计六维各自的抓取能力；重点：NaN/Infinity/hp>maxHp/bases 数值垃圾是否漏网；players 缺失是否抛异常
const { auditFrames } = require('../.audit/replay-audit.js');
const battle = require('../server/battle.js');
const LD = require('../tests/fixtures/loadout-ok.json');

const r = battle.runBattle({ p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 20260913, tier: 'mythic' });
const base = JSON.parse(JSON.stringify(r.data.frames));
const clone = () => JSON.parse(JSON.stringify(base));

const cases = [];
const tamper = (name, fn) => {
  const f = clone();
  try { fn(f); cases.push([name, auditFrames(f)]); }
  catch (e) { cases.push([name, { THREW: e.message }]); }
};

tamper('删 diff.bases（测试同款）', (f) => { delete f[0].diff.bases; });
tamper('删 diff.players', (f) => { delete f[0].diff.players; });
tamper('删整帧 diff', (f) => { delete f[0].diff; });
tamper('p1.hp = NaN', (f) => { f[0].diff.players.p1.hp = NaN; });
tamper('p1.hp = Infinity', (f) => { f[0].diff.players.p1.hp = Infinity; });
tamper('p1.hp = 1e9（远超 maxHp）', (f) => { f[0].diff.players.p1.hp = 1e9; });
tamper('p1.mp = -5', (f) => { f[0].diff.players.p1.mp = -5; });
tamper('p1.fromX = 10.5', (f) => { f[0].diff.players.p1.fromX = 10.5; });
tamper('bases.p1.hp = NaN', (f) => { f[0].diff.bases.p1.hp = NaN; });
tamper('bases.p1.def = "abc"', (f) => { f[0].diff.bases.p1.def = 'abc'; });
tamper('ab 帧 tick 跳号（tick2 → tick5）', (f) => { f[1].tick = 5; });
tamper('事件 cid 前缀错', (f) => { f[0].diff.events[0].cid = 'x1:1'; });
tamper('事件 tick 错位', (f) => { f[0].diff.events[0].tick = f[0].tick + 1; });
tamper('事件无 cid 键', (f) => { delete f[0].diff.events[0].cid; });
tamper('帧间位置不衔接（改第 2 帧 fromX）', (f) => { f[1].diff.players.p1.fromX = f[0].diff.players.p1.toX + 1; });
tamper('终帧删 verdict', (f) => { delete f[f.length - 1].diff.verdict; });
tamper('bulletHits[0].atX = 3.7（若存在命中）', (f) => { if (f[0].diff.bulletHits && f[0].diff.bulletHits.length) f[0].diff.bulletHits[0].atX = 3.7; });
tamper('bullet.x = 7.25（若帧有弹幕）', (f) => { if (f[0].diff.bullets && f[0].diff.bullets.length) f[0].diff.bullets[0].x = 7.25; });
tamper('事件数组含 null 元素', (f) => { f[0].diff.events.push(null); });

for (const [name, res] of cases) {
  if (res.THREW) { console.log(`✗ ${name} → 审计抛异常: ${res.THREW}`); continue; }
  const miss = res.ok ? '漏网（未抓）' : `被抓: ${res.problems.join(' | ')}`;
  console.log(`${res.ok ? '○' : '●'} ${name} → ok=${res.ok} ${miss}`);
}
console.log(`--- 对照：原始帧 auditFrames ok=${auditFrames(clone()).ok}（基线应 true）`);