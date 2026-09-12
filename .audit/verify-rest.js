'use strict';
/* .audit/verify-rest.js —— 剩余示例复算（B5/B7 遗留补齐，T-EN-13 走查可复算精神）
 * 机器复算示例数值（R-7 纪律：不手算）：05-effects E-1..E-5、07-movement M2/M5/N2/N3 关键数值。
 * 用法：`node .audit/verify-rest.js` → 全部通过 rc 0；任一不通过 rc 1。
 * 复算实现与引擎实现独立（纯公式），漂移即红。
 */
const assert = require('node:assert/strict');

function calcDamage(atk, mult, def) {
  const reduction = 1 - def / (def + 40);
  return { dmg: Math.max(1, Math.floor(atk * mult * reduction)), reduction };
}

let failures = 0;
function check(label, actual, expected) {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  ok  ${label}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`);
  }
}

function main() {
  console.log('verify-rest.js —— 示例数值机器复算');
  // 05-effects E-1：hp 132 −3×3 tick → 123（结算序列）
  const hp = [132, 129, 126, 123];
  const seq = [];
  let h = 132;
  for (let i = 0; i < 3; i++) { h -= 3; seq.push(h); }
  check('E-1 逐 tick 结算序列', seq, [129, 126, 123]);
  // E-2a 封顶：+5 满 132 → 132
  check('E-2a hp 封顶', Math.min(132, 132 + 5), 132);
  // E-5b 单方落位钳制：A500 B600 击退 +2 → 意图 628 → 钳 536
  {
    const to = 500 + 2 * 64;
    const clamped = to - 600 >= 64 || 600 - to >= 64 ? to : Math.min(to, 600 - 64);
    check('E-5b 钳到 gap 64（536）', clamped, 536);
  }
  // 07-movement M2：A504→568 vs B600 静止；碰撞 t=(64−96)/(0−64)=0.5 → A 536
  {
    const t = (64 - 96) / (0 - 64);
    check('M2 t*', Math.round(t * 10000) / 10000, 0.5);
    check('M2 A 停点 536', Math.round(504 + 64 * t), 536);
    check('M2 接触点 568', Math.round((536 + 600) / 2), 568);
  }
  // M5：位移撞静止（A400→656, B600）；t*=(64−200)/(0−256)=0.53125 → A 536、接触 568
  {
    const t = (64 - 200) / (0 - 256);
    check('M5 t*', Math.round(t * 100000) / 100000, 0.53125);
    const ax = Math.round(400 + 256 * t);
    check('M5 A 停点 536', ax, 536);
    check('M5 接触点 568', Math.round((ax + 600) / 2), 568);
  }
  // 伤害复算：A12×1.3 vs def9 → 12；碰撞 A→B 12×0.8 vs def9 → 7；B→A 19×0.8 vs def8 → 12
  check('P1/Q1 12×1.3×减伤(9) = 12', calcDamage(12, 1.3, 9).dmg, 12);
  check('碰撞 A→B 12×0.8×减伤(9) = 7', calcDamage(12, 0.8, 9).dmg, 7);
  check('碰撞 B→A 19×0.8×减伤(8) = 12', calcDamage(19, 0.8, 8).dmg, 12);
  // N2 相向交错：A500→564 B600→536；t=(64−100)/(−64−64)=0.28125 → A 518/B 582、接触 550
  {
    const t = (64 - 100) / (-64 - 64);
    check('N2 t*', Math.round(t * 100000) / 100000, 0.28125);
    const ax = Math.round(500 + 64 * t);
    const bx = Math.round(600 - 64 * t);
    check('N2 A 518', ax, 518);
    check('N2 B 582', bx, 582);
    check('N2 接触 550', Math.round((ax + bx) / 2), 550);
  }
  // 基地伤害：12×0.8×减伤(64)（base def 64 → 0.384615）→ 3
  check('M9 基地 12×0.8×0.384615 → 3', calcDamage(12, 0.8, 64).dmg, 3);
  // 超时：ceil(100×0.0625)
  check('超时扣血 ceil(100×0.0625) = 7', Math.ceil(100 * 0.0625), 7);
  // E-5c 越界 clamp：A 64 击退 −2 → 意图 −64 → clamp 32
  check('E-5c clampX 32', Math.max(32, Math.min(992, 64 - 2 * 64)), 32);
  // N3 相向同格：A400→464 B528→464；t=(64−128)/(−128)=0.5 → A 432/B 496、接触 464
  {
    const t = (64 - 128) / (0 - 128 - 0);
    const ax = Math.round(400 + 64 * t);
    const bx = Math.round(528 - 64 * t);
    check('N3 A 432', ax, 432);
    check('N3 B 496', bx, 496);
    check('N3 接触 464', Math.round((ax + bx) / 2), 464);
  }
  // 背击×暴击（追尾拍板后数值）：12×0.816327×2.25 → 22
  check('背击×暴击 12×2.25×减伤(9) = 22', calcDamage(12, 2.25, 9).dmg, 22);

  const total = 22;
  if (failures === 0) {
    console.log(`verify-rest.js 全部通过（${total} 项复算）`);
    return 0;
  }
  console.error(`verify-rest.js ${failures}/${total} 项失败`);
  return 1;
}

module.exports = { main };

if (require.main === module) {
  process.exitCode = main();
}