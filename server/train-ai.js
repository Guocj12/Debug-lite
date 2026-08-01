/**
 * ============================================================
 * Debug-Lite AI 训练器 — 遗传算法 + 蒙特卡洛模拟
 * ============================================================
 * 
 * 原理说明：
 * 
 * 【遗传算法】
 *   1. 初始种群：随机生成 POP_SIZE 个"个体"（每个个体是一个策略）
 *   2. 适应度评估：个体之间两两对战（或对抗随机基线），统计胜率
 *   3. 精英选择：保留胜率最高的 ELITE 个
 *   4. 交叉繁殖：随机选两个高胜率个体，交换片段产生后代
 *   5. 变异：以 MUTATION_RATE 概率随机修改后代中的某些 tick 行动
 *   6. 重复 2-5，直到收敛或达到最大代数
 *
 * 【蒙特卡洛方法】
 *   在评估适应度时，因为对战的随机性（对手也是随机策略），
 *   我们对每个个体打 N 场对局，用胜率作为适应度。
 *   这本质上是蒙特卡洛积分：通过大量随机抽样来估计期望胜率。
 *   
 * 【蒙特卡洛树搜索 (MCTS) 的区别】
 *   MCTS 是"在线"的：在每一步决策时实时模拟到终局。
 *   遗传算法是"离线"的：先训练出一个好的静态策略。
 *   对 16-tick 回合制来说，遗传算法更适合，因为行动序列是整回合一次性提交的。
 * 
 * 用法：
 *   node server/train-ai.js                      # 全部角色互训
 *   node server/train-ai.js --char warrior        # 仅训练战士
 *   node server/train-ai.js --gens 200 --pop 80  # 自定义代数和种群
 *   node server/train-ai.js --quick               # 快速模式（少模拟）
 */

// 训练模式下静默 BattleEngine 的战斗日志，避免终端输出溢出
const _origConsoleLog = console.log;
console.log = function(...args) {
  const msg = args.join(' ');
  // 过滤战斗引擎的每帧日志
  if (msg.includes('[FRAME]') || msg.includes('[EXECUTE_ALL]') ||
      msg.includes('[BULLET_') || msg.includes('[BASE_HIT]') ||
      msg.includes('[EFFECTS]') || msg.includes('[STUN]') ||
      msg.includes('[DASH_') || msg.includes('[KNOCKBACK]') ||
      msg.includes('[TRAIL_') || msg.includes('[BULLET_') ||
      msg.includes('[VERIFY]') || msg.includes('[REPORT]')) {
    return;
  }
  _origConsoleLog.apply(console, args);
};

const BattleEngine = require('./battle');
const charsData = require('../data/characters.json');
const skillsData = require('../data/skills.json');
const fs = require('fs');
const path = require('path');

// ==================== 命令行参数 ====================
const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) {
    const key = a.slice(2);
    const val = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true';
    args[key] = val;
  }
});

// ==================== 配置 ====================
const TICKS = 16;
const CONFIG = {
  POP_SIZE: parseInt(args.pop) || 60,          // 种群大小
  GENERATIONS: parseInt(args.gens) || 100,     // 迭代代数
  ELITE: Math.floor((parseInt(args.pop) || 60) * 0.15), // 精英保留数
  MATCHES_PER_EVAL: args.quick ? 10 : (parseInt(args.matches) || 200), // 每个个体评估时的对战场次
  MUTATION_RATE: 0.08,                          // 变异率（每个 tick 独立判定）
  CROSSOVER_RATE: 0.7,                          // 交叉率
  MAX_ROUNDS: 3,                                // 最大回合数
  TARGET_CHAR: args.char || null,               // 目标训练角色（null=全部）
};

// ==================== 行动池 ====================
const GENERIC_ACTIONS = ['move_left', 'move_right', 'dodge_left', 'dodge_right', 'defend', 'turn', 'wait'];

function getSkillActionsForChar(charDef) {
  const allSkills = skillsData.skills || {};
  const charSkills = Object.values(allSkills).filter(s => s.charId === charDef.id);
  return charSkills.map(s => s.id);
}

function getActionPool(charDef) {
  const pool = [...GENERIC_ACTIONS];
  const skills = getSkillActionsForChar(charDef);
  skills.forEach((_, i) => pool.push('skill' + (i + 1)));
  return { pool, skillIds: skills };
}

// ==================== 战斗模拟 ====================

/**
 * 创建战斗角色定义
 */
function makeCharDef(charDef, skillIds) {
  // skillIds 按顺序对应 skill1, skill2, skill3
  return {
    charId: charDef.id,
    maxHp: charDef.maxHp,
    maxMp: charDef.maxMp,
    maxSp: charDef.maxSp,
    atk: charDef.atk,
    def: charDef.def,
    skillIds: skillIds,
    customSkills: {},
  };
}

/**
 * 创建初始战斗状态
 */
function makeBattleState(p1Def, p2Def) {
  return {
    p1: {
      id: 'P1', charId: p1Def.charId,
      x: 5, facing: 1,
      hp: p1Def.maxHp, maxHp: p1Def.maxHp,
      mp: p1Def.maxMp, maxMp: p1Def.maxMp,
      sp: p1Def.maxSp, maxSp: p1Def.maxSp,
      atk: p1Def.atk, def: p1Def.def,
      skills: p1Def.skillIds, customSkills: {},
    },
    p2: {
      id: 'P2', charId: p2Def.charId,
      x: 10, facing: -1,
      hp: p2Def.maxHp, maxHp: p2Def.maxHp,
      mp: p2Def.maxMp, maxMp: p2Def.maxMp,
      sp: p2Def.maxSp, maxSp: p2Def.maxSp,
      atk: p2Def.atk, def: p2Def.def,
      skills: p2Def.skillIds, customSkills: {},
    },
    bases: {
      p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 },
      p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 },
    },
  };
}

/**
 * 深拷贝战斗状态（用于继承到下一回合）
 */
function cloneBattleState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * 运行完整一局（多回合），返回 winner 和统计数据
 */
function runFullGame(p1Def, p2Def, p1GenActions, p2GenActions, maxRounds = CONFIG.MAX_ROUNDS) {
  let state = makeBattleState(p1Def, p2Def);
  let totalFrames = 0;

  for (let round = 1; round <= maxRounds; round++) {
    // 生成当回合行动
    const p1Actions = p1GenActions(state, 'p1');
    const p2Actions = p2GenActions(state, 'p2');

    const engine = new BattleEngine();
    engine.init(cloneBattleState(state));
    engine.setActions(p1Actions, p2Actions);
    engine.executeAll();
    const finalState = engine.getState();

    totalFrames += 16;

    // 结算
    const judge = BattleEngine.judge(finalState, maxRounds, round);
    if (judge) {
      return {
        winner: judge.winner,
        reason: judge.reason,
        round,
        totalFrames,
        p1hp: finalState.p1.hp,
        p2hp: finalState.p2.hp,
        b1hp: finalState.bases?.p1?.hp ?? 100,
        b2hp: finalState.bases?.p2?.hp ?? 100,
      };
    }

    // 继承状态到下一回合
    state.p1 = finalState.p1;
    state.p2 = finalState.p2;
    state.bases = finalState.bases || state.bases;
  }

  // 达到最大回合数，HP 高者胜
  return {
    winner: state.p1.hp > state.p2.hp ? 'P1' : state.p2.hp > state.p1.hp ? 'P2' : 'draw',
    reason: '达到最大回合数',
    round: maxRounds,
    totalFrames,
    p1hp: state.p1.hp,
    p2hp: state.p2.hp,
    b1hp: state.bases?.p1?.hp ?? 100,
    b2hp: state.bases?.p2?.hp ?? 100,
  };
}

/**
 * 模拟校验：检查在给定状态下行动是否合法
 */
function canUseActionInState(simState, cKey, action, charDef) {
  const p = simState[cKey];
  const cd = simState['_cooldowns_' + cKey] || {};

  // 基础行动
  if (action === 'move_left' || action === 'move_right') return true;
  if (action === 'dodge_left' || action === 'dodge_right') return (p.sp || 0) >= 10;
  if (action === 'defend' || action === 'turn' || action === 'wait') return true;
  if (action === 'stunned') return false; // stunned 只能被系统设置

  // 技能
  const idxMap = { skill1: 0, skill2: 1, skill3: 2 };
  const idx = idxMap[action];
  if (idx === undefined) return false;

  const sid = p.skills?.[idx];
  if (!sid) return false;

  const allSk = skillsData.skills || {};
  const sk = allSk[sid];
  if (!sk) return false;

  if ((cd[sid] || 0) > 0) return false;
  if ((p.mp || 0) < (sk.mpCost || 0)) return false;
  if ((p.sp || 0) < (sk.spCost || 0)) return false;
  return true;
}

/**
 * 模拟执行行动消耗
 */
function applyActionCostInState(simState, cKey, action) {
  const p = simState[cKey];
  const cd = simState['_cooldowns_' + cKey] || {};
  simState['_cooldowns_' + cKey] = cd;

  if (action === 'dodge_left' || action === 'dodge_right') {
    p.sp = Math.max(0, p.sp - 10);
    return;
  }

  const idxMap = { skill1: 0, skill2: 1, skill3: 2 };
  const idx = idxMap[action];
  if (idx === undefined) return;

  const sid = p.skills?.[idx];
  if (!sid) return;

  const allSk = skillsData.skills || {};
  const sk = allSk[sid];
  if (!sk) return;

  p.mp = Math.max(0, p.mp - (sk.mpCost || 0));
  p.sp = Math.max(0, p.sp - (sk.spCost || 0));
  if (sk.cooldown) cd[sid] = sk.cooldown;
}

/**
 * 基于模拟状态生成合法随机序列（用于"随机对手"）
 */
function generateRandomValidSequence(state, cKey, charDef, pool) {
  const simState = {
    ...JSON.parse(JSON.stringify(state)),
    _cooldowns_p1: JSON.parse(JSON.stringify(state._cooldowns_p1 || {})),
    _cooldowns_p2: JSON.parse(JSON.stringify(state._cooldowns_p2 || {})),
  };
  const p = simState[cKey];
  const actions = [];

  for (let tick = 0; tick < TICKS; tick++) {
    // tick 冷却递减
    for (const k of ['p1', 'p2']) {
      const cd = simState['_cooldowns_' + k] || {};
      for (const sk in cd) { if (cd[sk] > 0) cd[sk]--; }
    }
    // 资源恢复
    const regen = charDef;
    p.sp = Math.min(p.maxSp, p.sp + (regen.spRegen || 5));
    p.mp = Math.min(p.maxMp, p.mp + (regen.mpRegen || 4));

    // 随机选一个可用的行动
    let picked = null;
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    for (const candidate of shuffled) {
      if (canUseActionInState(simState, cKey, candidate, charDef)) {
        picked = candidate;
        break;
      }
    }
    if (!picked) picked = 'wait';

    applyActionCostInState(simState, cKey, picked);
    actions.push(picked);
  }
  return actions;
}

// ==================== 遗传算法核心 ====================

/**
 * 个体：一个 16-tick 的行动序列模板（不是直接使用，而是按优先级生成）
 * 
 * 方案：直接存 16 个行动的列表。
 * 执行时逐个校验合法性，不合法则 fallback 到 wait。
 */
class Individual {
  constructor(genes) {
    this.genes = genes || []; // 16 个 action 字符串
    this.fitness = 0;          // 胜率（0-1）
    this.wins = 0;
    this.totalMatches = 0;
  }

  clone() {
    const ind = new Individual([...this.genes]);
    ind.fitness = this.fitness;
    ind.wins = this.wins;
    ind.totalMatches = this.totalMatches;
    return ind;
  }
}

/**
 * 生成随机个体
 */
function randomIndividual(pool) {
  const genes = [];
  for (let i = 0; i < TICKS; i++) {
    genes.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return new Individual(genes);
}

/**
 * 将个体转换为实际的行动序列（带模拟校验和 fallback）
 */
function individualToActions(individual, baseState, cKey, charDef, pool) {
  const simState = {
    ...JSON.parse(JSON.stringify(baseState)),
    _cooldowns_p1: JSON.parse(JSON.stringify(baseState._cooldowns_p1 || {})),
    _cooldowns_p2: JSON.parse(JSON.stringify(baseState._cooldowns_p2 || {})),
  };
  const p = simState[cKey];
  const actions = [];

  for (let tick = 0; tick < TICKS; tick++) {
    // tick 冷却递减
    for (const k of ['p1', 'p2']) {
      const cd = simState['_cooldowns_' + k] || {};
      for (const sk in cd) { if (cd[sk] > 0) cd[sk]--; }
    }
    // 资源恢复
    p.sp = Math.min(p.maxSp, p.sp + (charDef.spRegen || 5));
    p.mp = Math.min(p.maxMp, p.mp + (charDef.mpRegen || 4));

    // 尝试用基因中的行动
    let geneAction = individual.genes[tick] || 'wait';
    if (canUseActionInState(simState, cKey, geneAction, charDef)) {
      applyActionCostInState(simState, cKey, geneAction);
      actions.push(geneAction);
    } else {
      // fallback：随机选一个可用的
      let picked = null;
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      for (const candidate of shuffled) {
        if (canUseActionInState(simState, cKey, candidate, charDef)) {
          picked = candidate;
          break;
        }
      }
      if (!picked) picked = 'wait';
      applyActionCostInState(simState, cKey, picked);
      actions.push(picked);
    }
  }
  return actions;
}

/**
 * 交叉：均匀交叉 + 单点交叉混合
 * 以 CROSSOVER_RATE 的概率在随机位置交换基因段
 */
function crossover(parent1, parent2) {
  if (Math.random() > CONFIG.CROSSOVER_RATE) {
    return [parent1.clone(), parent2.clone()];
  }

  // 随机选交叉点
  const point = Math.floor(Math.random() * TICKS);
  const child1Genes = [
    ...parent1.genes.slice(0, point),
    ...parent2.genes.slice(point),
  ];
  const child2Genes = [
    ...parent2.genes.slice(0, point),
    ...parent1.genes.slice(point),
  ];

  return [new Individual(child1Genes), new Individual(child2Genes)];
}

/**
 * 变异：每个 tick 独立以 MUTATION_RATE 概率变为随机行动
 */
function mutate(individual, pool) {
  const genes = [...individual.genes];
  for (let i = 0; i < genes.length; i++) {
    if (Math.random() < CONFIG.MUTATION_RATE) {
      genes[i] = pool[Math.floor(Math.random() * pool.length)];
    }
  }
  // 额外：以较小概率随机打乱两个位置（微调节奏）
  if (Math.random() < 0.05) {
    const a = Math.floor(Math.random() * TICKS);
    const b = Math.floor(Math.random() * TICKS);
    [genes[a], genes[b]] = [genes[b], genes[a]];
  }
  return new Individual(genes);
}

/**
 * 精英选择：取 top K
 */
function selectElite(population) {
  const sorted = [...population].sort((a, b) => b.fitness - a.fitness);
  return sorted.slice(0, CONFIG.ELITE).map(ind => ind.clone());
}

/**
 * 锦标赛选择：随机选 3 个，取最优
 */
function tournamentSelect(population, tournamentSize = 3) {
  let best = null;
  for (let i = 0; i < tournamentSize; i++) {
    const idx = Math.floor(Math.random() * population.length);
    const candidate = population[idx];
    if (!best || candidate.fitness > best.fitness) {
      best = candidate;
    }
  }
  return best;
}

/**
 * 生成下一代
 */
function nextGeneration(population, pool) {
  const elites = selectElite(population);
  const newPop = [...elites];

  while (newPop.length < CONFIG.POP_SIZE) {
    const p1 = tournamentSelect(population);
    const p2 = tournamentSelect(population);
    const [c1, c2] = crossover(p1, p2);
    newPop.push(mutate(c1, pool));
    if (newPop.length < CONFIG.POP_SIZE) {
      newPop.push(mutate(c2, pool));
    }
  }

  return newPop;
}

// ==================== 评估：蒙特卡洛模拟 ====================

/**
 * 评估种群适应度（对抗指定对手）
 * 
 * 蒙特卡洛方法：对每个个体，跑 MATCHES_PER_EVAL 场对局。
 * 对手是"指定角色的随机合法序列"。
 * 用胜率作为适应度。
 * 
 * @param {string} opponentCharId - 对手角色 id，用于构建对手状态
 */
function evaluatePopulation(population, charDef, pool, skillIds, generation, opponentCharDef) {
  const total = population.length;
  const charDefObj = makeCharDef(charDef, skillIds);
  const oppDef = makeCharDef(opponentCharDef, opponentCharDef.defaultSkills);
  const { pool: oppPool } = getActionPool(opponentCharDef);
  
  // 重置
  population.forEach(ind => { ind.wins = 0; ind.totalMatches = 0; });

  // === 阶段 1：对抗指定对手的随机合法序列（蒙特卡洛） ===
  const oppName = opponentCharDef.name;
  console.log(`  ├─ 蒙特卡洛评估 (vs ${oppName}, ${CONFIG.MATCHES_PER_EVAL}场/个体)...`);

  for (let i = 0; i < total; i++) {
    const ind = population[i];
    for (let m = 0; m < CONFIG.MATCHES_PER_EVAL; m++) {
      const state = makeBattleState(charDefObj, oppDef);
      const oppActions = generateRandomValidSequence(state, 'p2', opponentCharDef, oppPool);
      
      const p1ActionGen = (s, ck) => individualToActions(ind, s, ck, charDef, pool);
      const p2ActionGen = (s, ck) => {
        if (ck === 'p2') return [...oppActions];
        return generateRandomValidSequence(s, ck, opponentCharDef, oppPool);
      };

      const result = runFullGame(charDefObj, oppDef, p1ActionGen, p2ActionGen, CONFIG.MAX_ROUNDS);
      ind.totalMatches++;
      if (result.winner === 'P1') ind.wins++;
    }

    if ((i + 1) % 10 === 0 || i === total - 1) {
      const avgFit = population.slice(0, i + 1).reduce((s, x) => s + x.wins / Math.max(1, x.totalMatches), 0) / (i + 1);
      process.stdout.write(`\r  │  已评估 ${i + 1}/${total} 个体, 平均胜率=${(avgFit * 100).toFixed(1)}%`);
    }
  }
  console.log('');

  // === 阶段 2：精英互相对战（交叉验证） ===
  const sorted = [...population].sort((a, b) => (b.wins / Math.max(1, b.totalMatches)) - (a.wins / Math.max(1, a.totalMatches)));
  const topN = Math.min(10, sorted.length);
  console.log(`  ├─ 精英互相对战 (Top ${topN} 个体)...`);
  
  for (let i = 0; i < topN; i++) {
    for (let j = i + 1; j < topN; j++) {
      const indA = sorted[i];
      const indB = sorted[j];
      const state = makeBattleState(charDefObj, oppDef);

      const p1ActionGen = (s, ck) => individualToActions(indA, s, ck, charDef, pool);
      const p2ActionGen = (s, ck) => individualToActions(indB, s, ck, charDef, pool);

      const result = runFullGame(charDefObj, oppDef, p1ActionGen, p2ActionGen, CONFIG.MAX_ROUNDS);
      indA.totalMatches++;
      indB.totalMatches++;
      if (result.winner === 'P1') indA.wins++;
      else if (result.winner === 'P2') indB.wins++;
    }
  }

  population.forEach(ind => {
    ind.fitness = ind.totalMatches > 0 ? ind.wins / ind.totalMatches : 0;
  });

  const fitnesses = population.map(ind => ind.fitness);
  const avgFit = fitnesses.reduce((a, b) => a + b, 0) / fitnesses.length;
  const maxFit = Math.max(...fitnesses);
  const minFit = Math.min(...fitnesses);

  return { avgFit, maxFit, minFit, sorted };
}

// ==================== 主训练流程 ====================

/**
 * 训练单个角色对抗指定对手
 * @param {object} charDef - 我方角色定义
 * @param {object} opponentCharDef - 对手角色定义
 * @param {number[]} skillIds - 我方技能列表
 */
function trainCharacterVs(charDef, skillIds, opponentCharDef) {
  const charName = charDef.name;
  const oppName = opponentCharDef.name;
  const { pool } = getActionPool(charDef);
  const totalStart = Date.now();

  console.log('');
  console.log('─'.repeat(50));
  console.log(`🎯 ${charName} vs ${oppName}`);
  console.log(`   种群: ${CONFIG.POP_SIZE} | 代数: ${CONFIG.GENERATIONS} | 变异率: ${CONFIG.MUTATION_RATE}`);
  console.log('─'.repeat(50));

  let population = [];
  for (let i = 0; i < CONFIG.POP_SIZE; i++) {
    population.push(randomIndividual(pool));
  }

  let bestEverFit = 0;
  let noImproveCount = 0;
  const NO_IMPROVE_LIMIT = 15;
  const topGenes = [];

  for (let gen = 1; gen <= CONFIG.GENERATIONS; gen++) {
    const genStart = Date.now();

    const { avgFit, maxFit, minFit, sorted } = evaluatePopulation(
      population, charDef, pool, skillIds, gen, opponentCharDef
    );

    if (maxFit > bestEverFit) {
      bestEverFit = maxFit;
      noImproveCount = 0;
    } else {
      noImproveCount++;
    }

    // ★ 维护 Top 3 基因池
    for (const ind of sorted) {
      if (ind.fitness <= 0) continue;
      const geneKey = ind.genes.join(',');
      const exists = topGenes.find(g => g.genes.join(',') === geneKey);
      if (!exists) {
        topGenes.push({ genes: [...ind.genes], fitness: ind.fitness });
        topGenes.sort((a, b) => b.fitness - a.fitness);
        if (topGenes.length > 3) topGenes.length = 3;
      }
    }

    const genTime = ((Date.now() - genStart) / 1000).toFixed(1);
    const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);

    if (gen % 5 === 0 || gen === 1 || maxFit >= bestEverFit) {
      console.log(`  Gen ${String(gen).padStart(3)}/${CONFIG.GENERATIONS} | ` +
        `平均: ${(avgFit * 100).toFixed(1)}% | 最高: ${(maxFit * 100).toFixed(1)}% | ` +
        `🏆: ${(bestEverFit * 100).toFixed(1)}% | ⏱ 本轮: ${genTime}s | 总: ${totalTime}s`);
    }

    if (noImproveCount >= NO_IMPROVE_LIMIT && gen > 25) {
      console.log(`  ⚠ 连续 ${NO_IMPROVE_LIMIT} 代无提升，提前终止`);
      break;
    }

    if (gen < CONFIG.GENERATIONS) {
      population = nextGeneration(population, pool);
    }
  }

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  console.log(`✅ ${charName} vs ${oppName} 完成! ${totalTime}s | 最佳: ${(bestEverFit * 100).toFixed(1)}% | Top3范围: ${(topGenes[topGenes.length-1]?.fitness*100||0).toFixed(1)}~${(topGenes[0]?.fitness*100||0).toFixed(1)}%`);

  return {
    vsCharId: opponentCharDef.id,
    bestFitness: bestEverFit,
    topGenes: topGenes.map(g => ({ genes: g.genes, fitness: g.fitness })),
  };
}

/**
 * 训练单个角色（对所有其他角色分别训练）
 */
function trainCharacter(charDef, skillIds) {
  const chars = charsData.characters || [];
  const vsResults = [];

  for (const oppChar of chars) {
    // 对每个对手角色分别训练（包括同职业内战）
    const result = trainCharacterVs(charDef, skillIds, oppChar);
    vsResults.push(result);
  }

  const totalTime = '';
  console.log(`\n🏁 ${charDef.name} 全部对阵训练完成!`);

  return {
    charId: charDef.id,
    charName: charDef.name,
    skillIds: skillIds,
    vsResults: vsResults,  // [{ vsCharId, bestFitness, topGenes }]
    config: { ...CONFIG },
  };
}

// ==================== 保存结果 ====================

function saveResults(allResults) {
  const outputPath = path.join(__dirname, '..', 'data', 'ai-weights.json');
  
  // ★ 加载已有权重，合并而非覆盖
  let weights = {};
  try {
    if (fs.existsSync(outputPath)) {
      weights = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    }
  } catch (e) { /* ignore */ }

  // ★ 新格式: weights[charId].vs[oppCharId] = { topGenes, fitness }
  allResults.forEach(r => {
    if (!weights[r.charId]) {
      weights[r.charId] = { name: r.charName, skillIds: r.skillIds, vs: {} };
    }
    (r.vsResults || []).forEach(vr => {
      weights[r.charId].vs[vr.vsCharId] = {
        fitness: vr.bestFitness,
        topGenes: vr.topGenes,
        trainedAt: new Date().toISOString(),
      };
    });
    weights[r.charId].trainedAt = new Date().toISOString();
    weights[r.charId].config = r.config;
  });

  // 简洁模板
  const aiTemplates = {};
  Object.entries(weights).forEach(([charId, w]) => {
    aiTemplates[charId] = { name: w.name, vs: {} };
    Object.entries(w.vs || {}).forEach(([vsId, v]) => {
      aiTemplates[charId].vs[vsId] = {
        fitness: v.fitness,
        genes: v.topGenes,
      };
    });
  });

  fs.writeFileSync(outputPath, JSON.stringify(weights, null, 2), 'utf-8');
  console.log(`\n💾 权重已保存到: ${outputPath}`);
  
  const templatePath = path.join(__dirname, '..', 'data', 'ai-templates.json');
  fs.writeFileSync(templatePath, JSON.stringify(aiTemplates, null, 2), 'utf-8');
  console.log(`💾 模板已保存到: ${templatePath}`);

  return weights;
}

// ==================== 入口 ====================

function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   Debug-Lite AI 训练器 — 遗传算法 + 蒙特卡洛模拟   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log('【蒙特卡洛方法】通过大量随机模拟对局来估计每个策略的期望胜率。');
  console.log('【遗传算法】  模拟自然选择：评估→精英保留→交叉→变异→迭代优化。');
  console.log('');
  console.log(`配置: 种群=${CONFIG.POP_SIZE} 代数=${CONFIG.GENERATIONS} 变异率=${CONFIG.MUTATION_RATE} 每体评估场次=${CONFIG.MATCHES_PER_EVAL}`);
  console.log('');

  const allChars = charsData.characters || [];
  
  // 确定训练目标
  let targetChars;
  if (CONFIG.TARGET_CHAR) {
    const found = allChars.find(c => c.id === CONFIG.TARGET_CHAR || c.name === CONFIG.TARGET_CHAR);
    if (!found) {
      console.error(`❌ 未找到角色: ${CONFIG.TARGET_CHAR}`);
      console.error(`   可用角色: ${allChars.map(c => c.id + '(' + c.name + ')').join(', ')}`);
      process.exit(1);
    }
    targetChars = [found];
  } else {
    targetChars = allChars;
  }

  console.log(`将训练 ${targetChars.length} 个角色，每个角色对 4 个对手分别训练（共 ${targetChars.length * 4} 组对战）`);
  
  const globalStart = Date.now();
  const allResults = [];
  let totalPairs = 0;

  for (const charDef of targetChars) {
    const skillIds = [...charDef.defaultSkills];
    const result = trainCharacter(charDef, skillIds);
    allResults.push(result);
    totalPairs += result.vsResults.length;
  }

  // 保存结果
  saveResults(allResults);

  const globalTime = ((Date.now() - globalStart) / 1000).toFixed(1);
  const perPairGames = CONFIG.POP_SIZE * 40 * CONFIG.MATCHES_PER_EVAL; // 约40代收敛 × 种群 × 评估场次
  const totalGames = totalPairs * perPairGames;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║               🎉 全部训练完成!                      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  总耗时: ${globalTime}s | 对战组合: ${totalPairs} 组 | 模拟对局约: ${totalGames.toLocaleString()} 场`);
  console.log('');
  console.log('  训练结果摘要:');
  allResults.forEach(r => {
    console.log(`  ${r.charName}:`);
    (r.vsResults || []).forEach(vr => {
      const oppName = charsData.characters.find(c => c.id === vr.vsCharId)?.name || vr.vsCharId;
      console.log(`    vs ${oppName.padEnd(6)} | ${(vr.bestFitness*100).toFixed(1)}% | Top3基因: ${vr.topGenes.length}条`);
    });
  });

  console.log('');
  console.log('  权重格式: charId.vs[oppCharId].topGenes[0~2]');
}

main();
