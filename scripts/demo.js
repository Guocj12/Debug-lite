'use strict';
/* scripts/demo.js —— 跑一场并打印逐 tick 摘要（B11 出口条件；README/tasks/acceptance 多处引用）
 * 用法：
 *   npm run demo                                # 默认 seed 20260912（与 gate 项 8 黄金战斗同 seed）
 *   npm run demo:log                            # trace 级（等价 DL_LOG_LEVEL=trace）
 *   node scripts/demo.js --seed 123 --log-level trace
 *   node scripts/demo.js --quality rare          # 换品质（品质系数影响实例化数值）
 * 说明：玩家由**数据表示例模板**实例化（内容待用户设计）；脚本内禁用 child_process / Math.random。
 */
const engine = require('../server/core/engine.js');
const skills = require('../server/core/skills.js');
const items = require('../server/core/items.js');
const { createRng } = require('../server/core/rng.js');
const { createLogger } = require('../shared/log.js');

const CONFIG = require('../server/data/battle-config.json');

function parseArgs(argv) {
  const out = { seed: 20260912, level: process.env.DL_LOG_LEVEL || 'info', quality: 'common' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--log-level') out.level = argv[++i];
    else if (a === '--quality') out.quality = argv[++i];
  }
  return out;
}

// 用数据表模板实例化出战玩家（示例数据；正式内容由用户设计后替换）
function buildPlayer(owner, roleId, skillIds, quality, rng) {
  const roles = require('../server/data/role-templates.json').roleTemplates;
  const roleTpl = roles.find((r) => r.id === roleId) || roles[0];
  const roleItem = items.generateRoleItem(roleTpl, quality, rng);
  const p = {
    id: owner === 'p1' ? 'A' : 'B', owner,
    x: CONFIG.startX[owner], facing: CONFIG.startFacing[owner],
    hp: roleItem.stats.hp, maxHp: roleItem.stats.hp,
    mp: roleItem.stats.mp, maxMp: roleItem.stats.mp,
    sp: roleItem.stats.sp, maxSp: roleItem.stats.sp,
    atk: roleItem.stats.atk, def: roleItem.stats.def,
    regen: roleItem.regen, special: {}, cooldowns: {}, effects: [], skills: {},
  };
  for (const sid of skillIds) {
    const inst = skills.instantiateSkill(sid, quality, rng);
    p.skills[inst.sid] = inst;
  }
  return p;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  // 逐 tick 摘要走 stdout；日志级别仅影响日志子系统（trace 时会打印内部事件）
  const logger = createLogger({ level: args.level });
  const rng = createRng(args.seed);
  const p1 = buildPlayer('p1', 'role_bal', ['skill_straight_precise', 'skill_melee_whirl'], args.quality, rng);
  const p2 = buildPlayer('p2', 'role_bal', ['skill_dash_bash', 'skill_straight_precise'], args.quality, rng);

  // 确定性脚本 AI：每 4 tick 平射一次，其余接近
  const battle = engine.createBattle(undefined, { seed: args.seed, logger, players: { p1, p2 } });
  const result = battle.runFull({
    actions: {
      p1: (state) => (state.tick % 4 === 0 ? 'skill:skill_straight_precise' : 'move_right'),
      p2: (state) => (state.tick % 4 === 0 ? 'skill:skill_straight_precise' : 'move_left'),
    },
  });

  const w = process.stdout.write.bind(process.stdout);
  w(`demo：seed=${args.seed} quality=${args.quality}（玩家由数据表示例模板实例化，内容待用户设计）\n`);
  w('tick | p1 x/hp/mp/sp | p2 x/hp/mp/sp | 命中 | 事件\n');
  w('-----+---------------+---------------+------+------\n');
  for (const d of result.diffs) {
    const e = d.players.p1;
    const f = d.players.p2;
    const hits = (d.bulletHits || []).map((h) => `${h.target}@${h.atX}`).join(',') || '-';
    const evs = (d.events || []).map((x) => x.event).filter(Boolean).slice(0, 3).join(',') || '-';
    w(`${String(d.tick).padStart(4)} | ${e.toX}/${e.hp}/${e.mp}/${e.sp} | ${f.toX}/${f.hp}/${f.mp}/${f.sp} | ${hits} | ${evs}\n`);
  }
  w(`结果：${result.winner ? `${result.winner} 胜` : '未分出胜负'}（${result.ticks} tick）\n`);
}

// 仅在被直接执行时运行（2026-09-16 修复 独立审查 R-9：原实现 require 即跑一场战斗并刷 stdout，
//   使任何 require('./scripts/demo.js') 的静态扫描/测试都会被意外触发）。
if (require.main === module) main();

module.exports = { main, buildPlayer, parseArgs };
