'use strict';
/* 临时探针（P2-5 调参）：候选默认 AI 程序两两对战的平局矩阵 → 选 9 个程序使平局对最少
 * 用法：node .tmp-p25-probe2.js   （用完即删；不进仓库） */
const ranked = require('./server/ranked.js');
const ast = require('./server/ai/ast.js');
const battle = require('./server/battle.js');
const tpl = require('./server/data/skill-templates.json').skillTemplates;

const lit = (v) => ({ type: 'literal', value: v });
const get = (p) => ({ type: 'get', path: p });
const act = (n) => ({ type: 'action', name: n });
const seq = (s) => ({ type: 'seq', statements: s });
const cmp = (op, l, r) => ({ type: 'cmp', op, left: l, right: r });
const arith = (op, l, r) => ({ type: 'arith', op, left: l, right: r });
const iff = (c, t, e) => ({ type: 'if', cond: c, then: t, else: e });
const gap = () => arith('-', get('enemy.x'), get('self.x'));

// 候选：{ family, threshold, slot, defendHp }
const CANDIDATES = [];
for (const th of [160, 192, 224, 256, 288, 320]) CANDIDATES.push({ family: 'steady', threshold: th, slot: 'skill:skill1', defendHp: 30 });
for (const th of [288, 320, 352, 384, 416, 448]) CANDIDATES.push({ family: 'kite', threshold: th, slot: 'skill:skill1', defendHp: null });
for (const slot of ['skill:skill1', 'skill:skill2']) {
  for (const dh of [null, 30]) CANDIDATES.push({ family: 'aggressive', threshold: 64, slot, defendHp: dh });
}

function programOf(c) {
  const fire = seq([act(c.slot)]);
  const back = iff(cmp('<', gap(), lit(-c.threshold)), seq([act('move_left')]), fire);
  const fwd = iff(cmp('>', gap(), lit(c.threshold)), seq([act('move_right')]), back);
  const body = c.defendHp === null
    ? seq([fwd])
    : seq([iff(cmp('<', get('self.hp'), lit(c.defendHp)), seq([act('defend')]), fwd)]);
  return { type: 'program', version: 2, body };
}

function loadoutOf(c) {
  const base = ranked.buildDefaultLoadout();
  const order = c.slot === 'skill:skill1'
    ? ['skill_straight_precise', 'skill_melee_whirl', 'skill_melee_whirl']
    : ['skill_melee_whirl', 'skill_straight_precise', 'skill_melee_whirl'];
  base.skills = order.map((id, i) => {
    const t = tpl.find((x) => x.id === id);
    return Object.assign({}, base.skills[i], {
      templateId: t.id,
      params: { multiplier: 1, cost: { hp: t.baseCost.hp, mp: t.baseCost.mp, sp: t.baseCost.sp }, cooldown: t.cooldown, bulletLevel: t.bulletLevel },
    });
  });
  base.ai = programOf(c);
  return base;
}

const SEEDS = 8;
const items = CANDIDATES.map((c, i) => ({ i, c, label: `${c.family}/th${c.threshold}/${c.slot.slice(6)}${c.defendHp === null ? '' : '/def' + c.defendHp}`, ld: loadoutOf(c) }));
let bad = 0;
for (const it of items) {
  const r = ast.validate(it.ld.ai);
  if (!(r.ok === true || (Array.isArray(r.errors) && r.errors.length === 0))) { bad++; console.log('AST FAIL', it.label); }
  const b = battle.buildPlayer('p1', it.ld, null, 'common');
  if (!b.ok) { bad++; console.log('BUILD FAIL', it.label, JSON.stringify(b.errors).slice(0, 120)); }
}
console.log('候选数', items.length, 'AST/build 失败', bad);
if (bad > 0) process.exit(1);

// 平局矩阵
const draw = {};
const decisive = {};
for (let x = 0; x < items.length; x++) {
  for (let y = x; y < items.length; y++) {
    let d = 0;
    let dec = 0;
    for (let s = 1; s <= SEEDS; s++) {
      const r = ranked.battleOne(items[x].ld, items[y].ld, null, 'common', s * 7919);
      if (r.winner === 'draw' || r.invalid) d += 1; else dec += 1;
    }
    draw[`${x}|${y}`] = d;
    decisive[`${x}|${y}`] = dec;
  }
}
const drawOf = (x, y) => draw[`${Math.min(x, y)}|${Math.max(x, y)}`];

const byFamily = { steady: [], kite: [], aggressive: [] };
items.forEach((it) => byFamily[it.c.family].push(it.i));

function combos(arr, k) {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...rest] = arr;
  return combos(rest, k - 1).map((c) => [head, ...c]).concat(combos(rest, k));
}

let best = null;
for (const st of combos(byFamily.steady, 3)) {
  for (const kt of combos(byFamily.kite, 3)) {
    for (const ag of combos(byFamily.aggressive, 3)) {
      const chosen = [...st, ...kt, ...ag];
      let badPairs = 0;
      let pairs = 0;
      for (let a = 0; a < chosen.length; a++) {
        for (let b = a + 1; b < chosen.length; b++) {
          pairs += 1;
          if (drawOf(chosen[a], chosen[b]) > 0) badPairs += 1;
        }
      }
      if (best === null || badPairs < best.bad) best = { chosen, bad: badPairs, pairs };
    }
  }
}
console.log('最优组合：全平局对阵数 =', best.bad, '/', best.pairs);
const chosenSet = new Set(best.chosen);
for (const i of best.chosen) {
  const foes = best.chosen.filter((j) => j !== i && drawOf(i, j) > 0).map((j) => items[j].label);
  console.log('  ', items[i].label, foes.length ? `→ 全平局对手：${foes.join(', ')}` : '→ 与组内所有对手均可分胜负');
}
console.log('（信息）组外候选中被淘汰的：', items.filter((it) => !chosenSet.has(it.i)).map((it) => it.label).join(', '));

