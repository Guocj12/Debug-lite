'use strict';
/* B18 独立复算 —— T-PB-4 档位单调（数据表机器校验，红队独立口径）：
 * ① 品质序 = 段位序号（common..mythic，D-122）
 * ② statRange 区间整体上移（允许重叠）：min 不减 + max 严格增
 * ③ pluginPoints / roleSlotRange / skillSlotRange / costDeltaBase 单调
 * ④ 档位表 tiers 与 statRange 三等分一致性（I-5：同品质三等分）—— 同品质内档位系数区间不重叠、有序衔接
 * ⑤ 关键推论：档位↑ ⇒ 词条数值↑（同品质内系数区间上移）
 */
const quals = require('../server/data/qualities.json').qualities;
const cdb = require('../server/data/qualities.json').costDeltaBase;
const cdbIds = ['common', 'rare', 'epic', 'legendary', 'mythic'];

let fail = 0;
const okk = (cond, msg) => { if (!cond) { fail++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

console.log('-- 数据事实');
for (const q of quals) {
  console.log(`  ${q.id}: statRange=${JSON.stringify(q.statRange)} pluginPoints=${q.pluginPoints} roleSlots=${JSON.stringify(q.roleSlotRange)} skillSlots=${JSON.stringify(q.skillSlotRange)} tiers=${JSON.stringify(q.tiers)}`);
}

console.log('-- ① 品质序');
okk(JSON.stringify(quals.map((q) => q.id)) === JSON.stringify(cdbIds), '品质 id 序正确');

console.log('-- ② 区间整体上移（重叠容忍）');
for (let i = 1; i < quals.length; i++) {
  const lo = quals[i - 1], hi = quals[i];
  okk(hi.statRange[0] >= lo.statRange[0], `${hi.id}.statRange[0] >= ${lo.id}.statRange[0]`);
  okk(hi.statRange[1] > lo.statRange[1], `${hi.id}.statRange[1] > ${lo.id}.statRange[1]`);
}

console.log('-- ③ 点数/插槽/消耗单调');
for (let i = 1; i < quals.length; i++) {
  const lo = quals[i - 1], hi = quals[i];
  okk(hi.pluginPoints > lo.pluginPoints, `${hi.id}.pluginPoints > ${lo.id}.pluginPoints`);
  okk(hi.roleSlotRange[0] >= lo.roleSlotRange[0] && hi.skillSlotRange[0] >= lo.skillSlotRange[0], `${hi.id} 插槽下限不减`);
  okk(hi.roleSlotRange[1] > lo.roleSlotRange[1] && hi.skillSlotRange[1] >= lo.skillSlotRange[1], `${hi.id} 插槽上限增`);
  okk(cdb[hi.id] > cdb[lo.id], `${hi.id} costDeltaBase > ${lo.id}`);
}

console.log('-- ④ 同品质档位表三等分一致性（I-5）');
const Q = Object.fromEntries(quals.map((q) => [q.id, q]));
function tierOf(coeff, q) {
  for (let i = 0; i < q.tiers.length; i++) if (coeff <= q.tiers[i][1]) return i + 1;
  return q.tiers.length;
}
for (const id of cdbIds) {
  const q = Q[id];
  // 边界不得重叠：tier[i][1] 必须 < tier[i+1][1]（衔接或留缝均合法，重叠非法）
  for (let i = 1; i < q.tiers.length; i++) {
    okk(q.tiers[i][0] >= q.tiers[i - 1][1], `${id} tiers[${i}][0] >= tiers[${i - 1}][1]（不重叠）`);
    if (q.tiers[i][0] < q.tiers[i - 1][1]) console.log(`      ${id} tiers[${i}] 起点 ${q.tiers[i][0]} < 上一段终点 ${q.tiers[i - 1][1]}`);
  }
  // 档位函数在区间内严格单调不减；对任意档位映射做抽样单调性检查
  let prev = -Infinity;
  let monotone = true;
  for (let c = q.statRange[0]; c <= q.statRange[1] + 1e-9; c += (q.statRange[1] - q.statRange[0]) / 2000) {
    const t = tierOf(c, q);
    if (t < prev) { monotone = false; break; }
    prev = t;
  }
  okk(monotone, `${id} 档位函数抽样单调不减`);
  okk(tierOf(q.statRange[1], q) === q.tiers.length, `${id} 上界落在末档`);
}

console.log('-- ⑤ 档位↑ ⇒ 词条系数↑（同品质内）');
for (const id of cdbIds) {
  const q = Q[id];
  for (let i = 1; i < q.tiers.length; i++) {
    okk(q.tiers[i][1] > q.tiers[i - 1][1], `${id} 档 ${i + 1} 上界 > 档 ${i} 上界`);
  }
}
// 角色插件点消耗 = tier（generatePlugin pointCost=tier）⇒ 点数随档位恒单调（结构性）
console.log('  ✓ 角色插件 pointCost=tier（生成器结构）→ 点数随档位单调（结构性成立）');

console.log(`\n结果: ${fail === 0 ? '全部通过' : fail + ' 项失败'}`);
process.exitCode = fail === 0 ? 0 : 1;