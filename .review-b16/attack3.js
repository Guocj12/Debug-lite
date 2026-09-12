'use strict';
/* 补充核对：expr 路径反查 + trace 总量冻结语义 + diff 字段命名 */
const assert = require('node:assert/strict');
const ast = require('../server/ai/ast.js');
const runtime = require('../server/ai/runtime.js');
const FIX = require('../tests/fixtures/ai-programs.json');
const a1 = JSON.parse(JSON.stringify(FIX.a1Countdown.program));

// 1. expr 路径双向性：nodePathOf 给出 body.s[0].expr，getNodeAtPath 能否反查？
const map = ast.nodePathOf(a1);
const valueNode = a1.body.statements[0].value; // var n 的 value 节点（literal 0）
let pathOf = null;
for (const [n, p] of []) { /* WeakMap 不可遍历 */ }
// 直接构造：visit 里 expr 子节点路径 = `${path}.expr`
pathOf = map.get(valueNode);
console.log('nodePathOf(valueNode) =', pathOf);
console.log('getNodeAtPath(body.s[0].expr) =', ast.getNodeAtPath(a1, 'body.s[0].expr') ? 'RESOLVED' : 'null');
assert.equal(pathOf, 'body.s[0].expr');
if (!ast.getNodeAtPath(a1, 'body.s[0].expr')) {
  console.log('>> expr 段反查失效（nodePathOf 逆不成立）');
}

// 2. trace 跨 tick 总量语义（B15 P2-2 定稿检查）
const p = { type: 'program', version: 2, body: { type: 'seq', statements: [
  { type: 'var', name: 'n', value: { type: 'literal', value: 0 } },
  { type: 'set', name: 'n', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 1 } } },
  { type: 'action', name: 'a' },
] } };
const snap = { self: { hp: 1, atk: 1, def: 0, sp: 1, mp: 1, x: 224, baseHp: 1, facing: 1 }, enemy: { hp: 1 }, bullets: [], field: {} };
const ctx = runtime.createContext(p);
for (let i = 0; i < 1000; i++) runtime.resume(ctx, snap, { chance: () => false });
console.log('1000 tick 后 ctx.trace.length =', ctx.trace.length, 'traceTruncated =', ctx.traceTruncated);
assert.equal(ctx.trace.length, 2000, '总量冻结 2000（非每 tick 2000）');
console.log('>> trace 实现 = 总量冻结；docs/tasks 措辞为「单 tick 上限」——不一致，见登记');

// 3. engine diff 字段名（docs interfaces §4.3 aiTrace[] vs 实现 aiTraces）
const engine = require('../server/core/engine.js');
const mk = () => ({ id: 'A', owner: 'p1', x: 224, facing: 1, hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60, atk: 12, def: 8, regen: { mp: 1, sp: 2 }, special: {}, cooldowns: {}, effects: [] });
const b = engine.createBattle(undefined, { seed: 3, players: { p1: mk(), p2: Object.assign({}, mk(), { owner: 'p2' }) } });
const buf = [];
const d = b.step({ actions: { aiTrace: buf, p1: () => 'wait', p2: () => 'wait' } });
console.log('diff 键:', Object.keys(d).join(','));
console.log('diff.aiTraces 存在:', 'aiTraces' in d, '；diff.aiTrace 存在:', 'aiTrace' in d);
console.log('OK');