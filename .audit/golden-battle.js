'use strict';
/* .audit/golden-battle.js —— 黄金战斗复算（P1 B11）
 * 测试点归属（B11 审查 P1 修正）：确定性（同 seed 逐帧一致）= T-EN-1/T-BT-5；快照锚定（走查可复算）= T-BT-13/14。
 * 用法：`node .audit/golden-battle.js`（打印摘要并核对磁盘快照）；`--write`（重新写入快照；需独立复核数值后提交）。
 * 依据：07-engine 全链路；固定 loadout × 固定 AI 序列 × 固定 seed → 全帧摘要（每 tick 双方
 *   fromX/toX/hp/mp/sp + bulletHits + verdict）。数值锚定：快照 .audit/golden-battle.json。
 * 随机路径：p1 critChance 0.5（确保 crit 流被真实消费，确定性经种子保证——B11 审查 P2b 修复）。
 * 与 B11 测试（tests/unit/golden.test.js）共用同一入口：runGolden() 返回 {summary, diffs}。
 */
const path = require('node:path');
const fs = require('node:fs');
const engine = require('../server/core/engine.js');

const SNAPSHOT_FILE = path.join(__dirname, 'golden-battle.json');
const SEED = 20260912;

// 固定面板（黄金锚定：不经过任何随机生成）
function mkPlayer(P) {
  const base = {
    id: P === 'p1' ? 'A' : 'B', owner: P,
    x: P === 'p1' ? 224 : 800, facing: P === 'p1' ? 1 : -1,
    hp: 100, mp: 40, sp: 60, maxHp: 100, maxMp: 40, maxSp: 60,
    atk: P === 'p1' ? 12 : 19, def: P === 'p1' ? 8 : 9,
    regen: { mp: 1, sp: 2 }, special: { critChance: 0, dodgeChance: 0, lifesteal: 0 },
    cooldowns: {}, effects: [],
  };
  return base;
}

// 固定技能实例（模板 + 固定系数 1.00；倍率对齐示例参数）
function skillOf(skills, templateId, overrides) {
  const sk = skills.instantiateSkill(templateId, 'rare', { float: () => 1.0, int: () => 0, pick: () => 0 });
  return Object.assign(sk, overrides || {});
}

// 行动计划：数组化（tick→owner 行动）；B11 登记：长度 40 + wait 兜底
function makeActionPlan() {
  const plan = {
    p1: ['dodge_right', 'move_left', 'wait', 'skill:precise', 'move_right', 'skill:precise', 'dodge_left', 'wait',
         'move_right', 'move_left', 'skill:precise', 'dodge_right', 'wait', 'move_left', 'skill:precise', 'dodge_left',
         'move_right', 'wait', 'move_left', 'skill:precise', 'dodge_right', 'move_right', 'wait', 'skill:precise',
         'dodge_left', 'move_left', 'wait', 'dodge_right', 'move_right', 'skill:precise', 'wait', 'move_left',
         'dodge_left', 'skill:precise', 'wait', 'move_right', 'dodge_right', 'wait', 'move_left', 'skill:precise'],
    p2: ['move_left', 'wait', 'skill:bash', 'dodge_left', 'move_right', 'wait', 'skill:bash', 'dodge_right',
         'wait', 'move_left', 'skill:bash', 'wait', 'dodge_right', 'move_left', 'skill:bash', 'wait',
         'dodge_left', 'move_right', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'skill:bash', 'wait',
         'move_right', 'wait', 'dodge_left', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'skill:bash',
         'wait', 'move_right', 'dodge_left', 'skill:bash', 'wait', 'move_left', 'dodge_right', 'wait'],
  };
  return {
    p1: (state) => plan.p1[state.tick - 1] || 'wait',
    p2: (state) => plan.p2[state.tick - 1] || 'wait',
  };
}

function runGolden() {
  const skills = require('../server/core/skills.js');
  const p1 = mkPlayer('p1');
  const p2 = mkPlayer('p2');
  p1.special.critChance = 0.5; // 随机路径真实消费（crit 流；seed 保证确定性）
  p1.skills = { precise: skillOf(skills, 'skill_straight_precise', { multiplier: 1.0 }) };
  p2.skills = { bash: skillOf(skills, 'skill_dash_bash', { multiplier: 1.3, distance: 4, passThroughEnemy: false, dealDamage: true }) };
  const b = engine.createBattle(undefined, { seed: SEED, players: { p1, p2 } });
  const actions = makeActionPlan();
  const result = b.runFull({ actions });
  const summary = {
    seed: SEED,
    ticks: result.ticks,
    winner: result.winner,
    phase: b.state.verdict ? b.state.verdict.phase : null,
    frames: result.diffs.map((d) => ({
      t: d.tick,
      p1: { x: d.players.p1.toX, hp: d.players.p1.hp, mp: d.players.p1.mp, sp: d.players.p1.sp },
      p2: { x: d.players.p2.toX, hp: d.players.p2.hp, mp: d.players.p2.mp, sp: d.players.p2.sp },
      collision: d.collision ? d.collision.contactX : null,
      hits: d.bulletHits.map((h) => ({ uid: h.uid, target: h.target, atX: h.atX })),
    })),
  };
  return { summary, diffs: result.diffs };
}

function main() {
  const { summary } = runGolden();
  const write = process.argv.includes('--write');
  if (write) {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(summary, null, 1) + '\n', 'utf8');
    console.log(`golden-battle.json 已写入（${summary.ticks} tick, winner=${summary.winner}）`);
    return 0;
  }
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    console.error('缺少快照 .audit/golden-battle.json —— 先运行 node .audit/golden-battle.js --write 生成');
    return 2;
  }
  const snap = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  const cur = JSON.stringify(summary);
  if (cur !== JSON.stringify(snap)) {
    console.error('黄金战斗与快照不一致（数值漂移或机制变更）');
    return 1;
  }
  console.log(`黄金战斗复算通过（${summary.ticks} tick, winner=${summary.winner}, phase=${summary.phase}）`);
  return 0;
}

module.exports = { runGolden, SEED };

if (require.main === module) {
  process.exitCode = main();
}