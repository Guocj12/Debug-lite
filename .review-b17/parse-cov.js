'use strict';
// 解析 .review-b17/v8cov/*.json —— 定位 items.js 未覆盖分支（branchMap/counts）
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, 'v8cov');
let file = null;
for (const f of fs.readdirSync(dir)) {
  const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (raw.result) {
    for (const r of raw.result) {
      if (r.url && r.url.endsWith('/server/core/items.js')) file = r;
    }
  }
}
if (!file) {
  console.log('未找到 items.js 覆盖记录');
  process.exit(1);
}
console.log('items.js functions:', file.functions.length);
// 每个 function：ranges(count>0 覆盖率) + 未覆盖行
const uncoveredRanges = [];
const branchInfo = [];
for (const fn of file.functions) {
  const fnName = fn.functionName || '(anon)';
  const { ranges } = fn;
  // 由 ranges 定位未覆盖行（V8 稀疏化后 range.count===0 且非前置空区）
  const zeroRanges = ranges.filter((r) => r.count === 0);
  // 分支：blockCounts 数组（V8 branch-level tag 不一定存在）
  if (fn.blockCounts && Array.isArray(fn.blockCounts)) {
    for (let i = 0; i < fn.blockCounts.length; i++) {
      if (fn.blockCounts[i] === 0) branchInfo.push({ fn: fnName, block: i });
    }
  }
  for (const z of zeroRanges) {
    if (z.endOffset - z.startOffset < 12) continue; // 忽略极小空隙
    uncoveredRanges.push({ fn: fnName, start: z.startOffset, end: z.endOffset });
  }
}
console.log('未覆盖零计数大区间:', uncoveredRanges.length);
for (const u of uncoveredRanges) console.log(' ', JSON.stringify(u));
console.log('blockCounts 为零的分块:', branchInfo.length);
for (const b of branchInfo) console.log(' ', JSON.stringify(b));

// 若顶层有 branchMap（部分 Node 版本提供），输出
if (file.branchMap && file.branchMap.length) {
  console.log('branchMap 顶层条目:', file.branchMap.length);
  for (let i = 0; i < file.branchMap.length; i++) {
    const bm = file.branchMap[i];
    console.log(`  #${i} ${JSON.stringify(bm)}`);
  }
}

// 行号定位：用源码偏移 → 行
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'core', 'items.js'), 'utf8');
function lineOf(offset) {
  return src.slice(0, offset).split('\n').length;
}
console.log('未覆盖零计数区间对应源码行:');
for (const u of uncoveredRanges) {
  console.log(`  fn=${u.fn} L${lineOf(u.start)}..L${lineOf(u.end)}`);
}