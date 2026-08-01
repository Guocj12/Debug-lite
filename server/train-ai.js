/**
 * ============================================================
 * Debug-Lite AI 训练器 v2 — 双向对抗迭代训练
 * ============================================================
 * 
 * 原理说明：
 * 
 * 【训练流程】
 *   被训练角色为 P2，陪训角色为 P1。
 *   双方各自独立产出胜率高的行动序列。
 *
 * 【第 1 轮 — 纯随机基础训练】
 *   1a. P2 vs 随机P1：P2 用随机序列，P1 用随机序列，统计 P2 每种序列胜率
 *   1b. P1 vs 随机P2：P1 用随机序列，P2 用随机序列，统计 P1 每种序列胜率
 *   分别取 P2、P1 各自胜率前 10 的序列进入下一轮。
 *
 * 【第 2~N 轮 — 变异对抗训练】
 *   每一轮：
 *     - 从上一轮 P2 胜率前10 + P1 胜率前10 各变异出 POP 个新序列
 *     - P2 变异序列 vs P1 变异序列，两两对抗
 *     - 统计双方各自胜率，取前10 进入下一轮
 *
 * 【最终输出】
 *   达到训练轮次上限后，将 P2 胜率前三的序列写入 JSON 作为训练结果。
 * 
 * 用法：
 *   node server/train-ai.js                              # 全部角色互训
 *   node server/train-ai.js --p2 warrior --p1 archer     # 指定双方角色
 *   node server/train-ai.js --p2 warrior                 # 训练战士 vs 所有其他
 *   node server/train-ai.js --rounds 20 --pop 80         # 自定义轮次和种群
 *   node server/train-ai.js --quick                      # 快速模式
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
  ELITE: Math.floor((parseInt(args.pop) || 60) * 0.15),
  MATCHES_PER_EVAL: args.quick ? 10 : (parseInt(args.matches) || 200),
  MATCHES_PER_PAIR: args.quick ? 5 : (parseInt(args.matches) || 20),
  MUTATION_RATE: 0.05,                           // 变异率
  MAX_ROUNDS: 3,
  ITER_ROUNDS: parseInt(args.rounds) || 5,       // 迭代轮数
  TOP_K: 10,                                      // 每轮保留前K条序列
  TARGET_P2: args.p2 || null,                    // 被训练角色 P2
  TARGET_P1: args.p1 || null,                    // 陪训角色 P1（不指定则对所有角色）
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
 * 基因序列（简化版，不用 Individual 类）
 * { genes: string[16], wins: number, total: number }
 */

/** 生成随机基因 */
function randomGene(pool) {
  const genes = [];
  for (let i = 0; i < TICKS; i++) genes.push(pool[Math.floor(Math.random() * pool.length)]);
  return { genes, wins: 0, total: 0 };
}

/** 基于种子基因变异出 count 条新基因 */
function mutateFromSeeds(seeds, pool, count) {
  const result = [];
  for (let i = 0; i < count; i++) {
    const seed = seeds[Math.floor(Math.random() * seeds.length)];
    const genes = [...seed.genes];
    for (let j = 0; j < genes.length; j++) {
      if (Math.random() < CONFIG.MUTATION_RATE) {
        genes[j] = pool[Math.floor(Math.random() * pool.length)];
      }
    }
    // 随机打乱两个位置
    if (Math.random() < 0.03) {
      const a = Math.floor(Math.random() * TICKS);
      const b = Math.floor(Math.random() * TICKS);
      [genes[a], genes[b]] = [genes[b], genes[a]];
    }
    result.push({ genes, wins: 0, total: 0 });
  }
  return result;
}

/** 基因 → 实际行动序列 */
function geneToActions(gene, baseState, cKey, charDef, pool) {
  const simState = {
    ...JSON.parse(JSON.stringify(baseState)),
    _cooldowns_p1: JSON.parse(JSON.stringify(baseState._cooldowns_p1 || {})),
    _cooldowns_p2: JSON.parse(JSON.stringify(baseState._cooldowns_p2 || {})),
  };
  const p = simState[cKey];
  const actions = [];
  for (let tick = 0; tick < TICKS; tick++) {
    for (const k of ['p1', 'p2']) {
      const cd = simState['_cooldowns_' + k] || {};
      for (const sk in cd) { if (cd[sk] > 0) cd[sk]--; }
    }
    p.sp = Math.min(p.maxSp, p.sp + (charDef.spRegen || 5));
    p.mp = Math.min(p.maxMp, p.mp + (charDef.mpRegen || 4));

    let action = gene.genes[tick] || 'wait';
    if (!canUseActionInState(simState, cKey, action, charDef)) {
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      action = shuffled.find(a => canUseActionInState(simState, cKey, a, charDef)) || 'wait';
    }
    applyActionCostInState(simState, cKey, action);
    actions.push(action);
  }
  return actions;
}

// ==================== 核心：双向对抗训练 ====================

/**
 * 对一组基因进行双向对抗评估。
 * popA 作为 P2，popB 作为 P1。
 * 每对组合打 MATCHES_PER_PAIR 场（多回合），统计双方各自胜场。
 */
function runBidirectionalBattle(popA, charA, poolA, popB, charB, poolB) {
  // 重置
  popA.forEach(g => { g.wins = 0; g.total = 0; });
  popB.forEach(g => { g.wins = 0; g.total = 0; });

  const defA = makeCharDef(charA, charA.defaultSkills);
  const defB = makeCharDef(charB, charB.defaultSkills);

  for (let ai = 0; ai < popA.length; ai++) {
    for (let bi = 0; bi < popB.length; bi++) {
      const aGene = popA[ai];
      const bGene = popB[bi];

      for (let m = 0; m < CONFIG.MATCHES_PER_PAIR; m++) {
        // popA 作为 P2（被训练方），popB 作为 P1（陪训方）
        const state = makeBattleState(defB, defA); // P1=popB, P2=popA

        const p1Gen = (s, ck) => geneToActions(bGene, s, ck, charB, poolB);
        const p2Gen = (s, ck) => geneToActions(aGene, s, ck, charA, poolA);

        const result = runFullGame(defB, defA, p1Gen, p2Gen, CONFIG.MAX_ROUNDS);
        aGene.total++;
        bGene.total++;
        if (result.winner === 'P2') aGene.wins++;          // popA 作为 P2 赢了
        else if (result.winner === 'P1') bGene.wins++;     // popB 作为 P1 赢了
      }
    }

    if ((ai + 1) % 10 === 0 || ai === popA.length - 1) {
      const aAvg = popA.slice(0, ai + 1).reduce((s, g) => s + (g.total > 0 ? g.wins / g.total : 0), 0) / (ai + 1);
      process.stdout.write(`\r  │  评估中 ${ai+1}/${popA.length} | P2均胜率=${(aAvg*100).toFixed(1)}%`);
    }
  }
  console.log('');
}

/**
 * 取 topK
 */
function topK(pop, k) {
  return [...pop]
    .map(g => ({ genes: [...g.genes], fitness: g.total > 0 ? g.wins / g.total : 0 }))
    .sort((a, b) => b.fitness - a.fitness)
    .slice(0, k);
}

/**
 * 训练 P2 vs P1（多轮迭代）
 * 
 * 第1轮：P2 随机 vs P1 随机 → 各取 Top10
 * 第2~N轮：P2 Top10变异 vs P1 Top10变异 → 各取 Top10
 * 最终：返回 P2 Top3
 */
function trainPair(p2Char, p1Char) {
  const p2Name = p2Char.name, p1Name = p1Char.name;
  const { pool: poolP2 } = getActionPool(p2Char);
  const { pool: poolP1 } = getActionPool(p1Char);
  const totalStart = Date.now();

  console.log('');
  console.log('═'.repeat(55));
  console.log(`🎯 P2=${p2Name}(被训练) vs P1=${p1Name}(陪训) | 轮次:${CONFIG.ITER_ROUNDS} | 种群:${CONFIG.POP_SIZE} | 每对:${CONFIG.MATCHES_PER_PAIR}场`);
  console.log('═'.repeat(55));

  let p2Seeds = []; // P2 上一轮 Top10 基因 { genes, fitness }
  let p1Seeds = []; // P1 上一轮 Top10 基因

  for (let iter = 1; iter <= CONFIG.ITER_ROUNDS; iter++) {
    const iterStart = Date.now();

    // 生成当前轮的种群
    let popP2, popP1;
    if (iter === 1) {
      // 第1轮：纯随机
      popP2 = Array.from({ length: CONFIG.POP_SIZE }, () => randomGene(poolP2));
      popP1 = Array.from({ length: CONFIG.POP_SIZE }, () => randomGene(poolP1));
    } else {
      // 第2+轮：从种子变异
      popP2 = mutateFromSeeds(p2Seeds, poolP2, CONFIG.POP_SIZE);
      popP1 = mutateFromSeeds(p1Seeds, poolP1, CONFIG.POP_SIZE);
    }

    const seedLabel = iter === 1 ? '随机' : `种子(${p2Seeds.length}条)变异`;
    console.log(`\n  ── 第 ${iter}/${CONFIG.ITER_ROUNDS} 轮 [${seedLabel}] ──`);
    console.log(`  P2:${p2Name}(POP=${CONFIG.POP_SIZE}) vs P1:${p1Name}(POP=${CONFIG.POP_SIZE})`);

    runBidirectionalBattle(popP2, p2Char, poolP2, popP1, p1Char, poolP1);

    // 取双方 TopK
    const newP2Top = topK(popP2, CONFIG.TOP_K);
    const newP1Top = topK(popP1, CONFIG.TOP_K);

    // ★ 每轮只用本轮 TopK 作为下一轮种子，不跨轮累积
    // 这样双方在同一个起跑线上竞争，胜率更真实
    p2Seeds = newP2Top;
    p1Seeds = newP1Top;

    const iterTime = ((Date.now() - iterStart) / 1000).toFixed(1);
    const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
    console.log(`  ✅ P2 Top3: ${p2Seeds.slice(0,3).map(g=>(g.fitness*100).toFixed(1)+'%').join(', ')} | P1 Top3: ${p1Seeds.slice(0,3).map(g=>(g.fitness*100).toFixed(1)+'%').join(', ')} | ⏱${iterTime}s|总${totalTime}s`);
  }

  const totalTime = ((Date.now() - totalStart) / 1000).toFixed(1);
  const finalTop3 = p2Seeds.slice(0, 3);
  console.log(`\n🏁 ${p2Name} vs ${p1Name} 完成! ${totalTime}s | P2最终Top3: ${finalTop3.map(g=>(g.fitness*100).toFixed(1)+'%').join(', ')}`);

  return {
    vsCharId: p1Char.id,
    bestFitness: finalTop3.length > 0 ? finalTop3[0].fitness : 0,
    topGenes: finalTop3,
  };
}

// ==================== 保存结果 ====================

function saveResults(allResults) {
  const outputPath = path.join(__dirname, '..', 'data', 'ai-weights.json');
  
  let weights = {};
  try {
    if (fs.existsSync(outputPath)) {
      weights = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    }
  } catch (e) { /* ignore */ }

  // allResults: [{ charId, charName, vsResults: [{ vsCharId, topGenes }] }]
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
    weights[r.charId].config = { rounds: CONFIG.ITER_ROUNDS, pop: CONFIG.POP_SIZE };
  });

  const aiTemplates = {};
  Object.entries(weights).forEach(([charId, w]) => {
    aiTemplates[charId] = { name: w.name, vs: {} };
    Object.entries(w.vs || {}).forEach(([vsId, v]) => {
      aiTemplates[charId].vs[vsId] = { fitness: v.fitness, genes: v.topGenes };
    });
  });

  fs.writeFileSync(outputPath, JSON.stringify(weights, null, 2), 'utf-8');
  console.log(`\n💾 权重已保存到: ${outputPath}`);
  
  const templatePath = path.join(__dirname, '..', 'data', 'ai-templates.json');
  fs.writeFileSync(templatePath, JSON.stringify(aiTemplates, null, 2), 'utf-8');
  console.log(`💾 模板已保存到: ${templatePath}`);
}

// ==================== 入口 ====================

function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║  Debug-Lite AI 训练器 v2 — 双向对抗迭代训练       ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`配置: 种群=${CONFIG.POP_SIZE} | 轮次=${CONFIG.ITER_ROUNDS} | 每对=${CONFIG.MATCHES_PER_PAIR}场 | 变异率=${CONFIG.MUTATION_RATE}`);
  console.log('');

  const allChars = charsData.characters || [];

  // 确定 P2 角色列表
  let p2Chars;
  if (CONFIG.TARGET_P2) {
    const found = allChars.find(c => c.id === CONFIG.TARGET_P2 || c.name === CONFIG.TARGET_P2);
    if (!found) { console.error(`❌ 未找到P2角色: ${CONFIG.TARGET_P2}`); process.exit(1); }
    p2Chars = [found];
  } else {
    p2Chars = allChars;
  }

  // 确定 P1 角色列表
  let p1Chars;
  if (CONFIG.TARGET_P1) {
    const found = allChars.find(c => c.id === CONFIG.TARGET_P1 || c.name === CONFIG.TARGET_P1);
    if (!found) { console.error(`❌ 未找到P1角色: ${CONFIG.TARGET_P1}`); process.exit(1); }
    p1Chars = [found];
  } else {
    p1Chars = allChars;
  }

  const totalPairs = p2Chars.length * p1Chars.length;
  console.log(`P2(被训练): ${p2Chars.map(c=>c.name).join(', ')}`);
  console.log(`P1(陪训):   ${p1Chars.map(c=>c.name).join(', ')}`);
  console.log(`共 ${totalPairs} 组对战\n`);

  const globalStart = Date.now();
  const allResults = [];

  for (const p2Char of p2Chars) {
    const vsResults = [];
    for (const p1Char of p1Chars) {
      const result = trainPair(p2Char, p1Char);
      vsResults.push(result);
    }
    allResults.push({
      charId: p2Char.id,
      charName: p2Char.name,
      skillIds: p2Char.defaultSkills,
      vsResults,
    });
  }

  saveResults(allResults);

  const globalTime = ((Date.now() - globalStart) / 1000).toFixed(1);
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║               🎉 全部训练完成!                      ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  总耗时: ${globalTime}s | 对战组合: ${totalPairs} 组`);
  console.log('');
  allResults.forEach(r => {
    console.log(`  ${r.charName}:`);
    (r.vsResults || []).forEach(vr => {
      const oppName = allChars.find(c => c.id === vr.vsCharId)?.name || vr.vsCharId;
      const fits = vr.topGenes.map(g => (g.fitness*100).toFixed(1)+'%').join(', ');
      console.log(`    vs ${oppName.padEnd(6)} | ${fits}`);
    });
  });
}

main();
