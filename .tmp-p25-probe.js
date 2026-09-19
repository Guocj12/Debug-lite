'use strict';
/* 临时探针（P2-5 验收）：默认出战配置按身份派生的变体 → AST 校验 + 变体分布 + 两两对战平局率
 * 用法：node .tmp-p25-probe.js   （用完即删；不进仓库） */
const ranked = require('./server/ranked.js');
const ast = require('./server/ai/ast.js');
const battle = require('./server/battle.js');

const byProgram = new Map();
const identityOf = (i) => `pl_${String(i).padStart(16, '0')}`;
let bad = 0;
for (let i = 1; i <= 2000 && byProgram.size < 9; i++) {
  const id = identityOf(i);
  const ld = ranked.buildDefaultLoadout(id);
  const key = JSON.stringify(ld.ai);
  if (!byProgram.has(key)) {
    const r = ast.validate(ld.ai);
    const okAst = r.ok === true || (Array.isArray(r.errors) && r.errors.length === 0);
    const b = battle.buildPlayer('p1', ld, null, 'common');
    if (!okAst || !b.ok) { bad += 1; console.log('FAIL', id, JSON.stringify(r).slice(0, 160), JSON.stringify(b.errors || '').slice(0, 160)); }
    byProgram.set(key, { id, variant: ranked.variantOf(id).preset + ':' + ranked.variantOf(id).sub, loadout: ld });
  }
}
console.log('AST/build 预检失败数 =', bad, '| 覆盖到的子变体 =', [...byProgram.values()].map((x) => x.variant).sort().join(', '));
if (bad > 0 || byProgram.size !== 9) process.exit(1);

const entries = [...byProgram.values()];
const tally = { p1: 0, p2: 0, draw: 0, invalid: 0 };
const pairDraws = [];
let total = 0;
for (const a of entries) {
  for (const b of entries) {
    let draws = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const r = ranked.battleOne(a.loadout, b.loadout, null, 'common', seed * 7919);
      total += 1;
      if (r.invalid) tally.invalid += 1;
      else { tally[r.winner] += 1; if (r.winner === 'draw') draws += 1; }
    }
    if (draws > 0) pairDraws.push(`${a.variant} vs ${b.variant}: ${draws}/8 平`);
  }
}
console.log('9×9×8 场：', JSON.stringify(tally), '平局率', (tally.draw / total * 100).toFixed(1) + '%', '| 含平局对阵对 =', pairDraws.length / 2);
for (const line of pairDraws) console.log('   ' + line);

// 真实玩家（HTTP 路径按 publicId 派生）分布抽样
const dist = {};
for (let i = 1; i <= 300; i++) {
  const id = `sha256:${String(i).padStart(64, '0')}`;
  const k = ranked.presetOf(id) + ':' + ranked.variantOf(id).sub;
  dist[k] = (dist[k] || 0) + 1;
}
console.log('300 个 publicId 抽样分布：', JSON.stringify(dist));
