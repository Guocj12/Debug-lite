'use strict';
/* traceTruncated 往返保留 + restore 后不再重复 warn */
const runtime = require('../server/ai/runtime.js');
const { createLogger } = require('../shared/log.js');
const p = { type: 'program', version: 2, body: { type: 'seq', statements: [
  { type: 'var', name: 'n', value: { type: 'literal', value: 0 } },
  { type: 'set', name: 'n', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 1 } } },
  { type: 'action', name: 'a' },
] } };
const snap = { self: { hp: 1, atk: 1, def: 0, sp: 1, mp: 1, x: 224, baseHp: 1, facing: 1 }, enemy: { hp: 1 }, bullets: [], field: {} };
const logger = createLogger({ level: 'all', ringSize: 5000 });
const rt = runtime.withLogger(logger);
const ctx = rt.createContext(p);
for (let i = 0; i < 700; i++) rt.resume(ctx, snap, { chance: () => false }); // 2100 条目 → 截断
const warnsBefore = logger.records.filter((r) => r.event === 'trace.truncated').length;
const ser = JSON.parse(JSON.stringify(rt.serializeContext(ctx)));
console.log('ser.traceTruncated =', ser.traceTruncated, 'traceLen =', ser.trace.length);
const ctx2 = rt.restoreContext(ser, p);
for (let i = 0; i < 100; i++) rt.resume(ctx2, snap, { chance: () => false });
const warnsAfter = logger.records.filter((r) => r.event === 'trace.truncated').length;
console.log('restore 后 warn 次数：', warnsBefore, '->', warnsAfter);
console.log(warnsAfter === warnsBefore ? 'OK: 往返保留且不重复 warn' : 'NG: 重复 warn');