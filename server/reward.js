/**
 * ============================================================
 * Debug-Lite 训练奖励函数（得分制）
 * ============================================================
 *
 * 将"整局胜负"这一稀疏信号，替换为基于每回合战况的连续得分：
 *   - 角色血量净优势（打人 − 挨打，按各自 maxHp 归一化）→ 鼓励攻击敌人 + 保护自己
 *   - 基地血量净优势（拆塔 − 被拆，按基地 maxHp 归一化）→ 鼓励攻击敌方基地 + 防守己方基地
 *   - 整局胜负加分（保留"获胜"这一硬目标，但仅作为其中一个加权项）
 * 击杀 / 拆塔不再单独计分：击杀=敌方角色血量清零、拆塔=敌方基地血量清零，
 * 二者已完整计入上面的血量净优势项，同时它们又直接决定胜负，故由胜负加分兜底。
 *
 * 关键性质：得分是零和的（P2 得分 = -P1 得分），保证对抗压力，
 * 避免"双方互蹲、各得高分"的退化策略被奖励。
 *
 * 用法：
 *   const { computeRoundReward, computeGameReward, normalizeWeights, REWARD_DEFAULTS } = require('./reward');
 *   const w = normalizeWeights({ w_hp: 1.0, w_base: 1.5, w_win: 3.0 });
 *   const rr = computeRoundReward(before, after, w);      // { p2, p1 } 本回合双方得分
 *   const game = computeGameReward([rr, ...], winner, w); // { p2, p1, rounds } 整局得分
 */

const REWARD_DEFAULTS = {
  w_hp: 1.0,    // 角色血量净优势权重（击杀=敌方血量清零，已完全计入此项）
  w_base: 1.5,  // 基地血量净优势权重（略高，鼓励拆塔；拆塔=基地清零，已完全计入此项）
  w_win: 3.0,   // 整局胜负加分权重（击杀/拆塔同时决定胜负，不再单独计分）
};

/**
 * 合并 CLI / 用户覆盖到默认权重（容忍字符串、undefined、null、NaN）
 * @param {object} overrides - 需要覆盖的权重键值
 */
function normalizeWeights(overrides = {}) {
  const w = { ...REWARD_DEFAULTS };
  for (const key of Object.keys(REWARD_DEFAULTS)) {
    const v = overrides[key];
    const n = parseFloat(v);
    if (v !== undefined && v !== null && v !== '' && !isNaN(n)) {
      w[key] = n;
    }
  }
  return w;
}

/**
 * 计算单回合双方得分（零和：p2 + p1 = 0）。
 * 以 P2 视角计：P1 掉血/基地掉血为正（P2 造成的），P2 掉血/基地掉血为负（P1 造成的）。
 * 击杀/拆塔不额外加分——它们等价于把敌方血量/基地血量打到 0，已完整计入血量净优势。
 * @param {object} before - 回合开始状态（含 p1/p2/bases 的 hp、maxHp）
 * @param {object} after  - 回合结束状态
 * @param {object} weights - 权重
 * @returns {{ p2: number, p1: number }}
 */
function computeRoundReward(before, after, weights = REWARD_DEFAULTS) {
  const p1Max = Math.max(1, before.p1?.maxHp || 1);
  const p2Max = Math.max(1, before.p2?.maxHp || 1);
  const bMax  = Math.max(1, before.bases?.p1?.maxHp || 100);

  // 角色血量净优势（P2 视角）：P1 掉血(归一化) − P2 掉血(归一化)
  const p1Lost = Math.max(0, before.p1.hp - after.p1.hp) / p1Max;
  const p2Lost = Math.max(0, before.p2.hp - after.p2.hp) / p2Max;
  const hpAdv = p1Lost - p2Lost;

  // 基地血量净优势
  const b1Lost = Math.max(0, (before.bases?.p1?.hp ?? 0) - (after.bases?.p1?.hp ?? 0)) / bMax;
  const b2Lost = Math.max(0, (before.bases?.p2?.hp ?? 0) - (after.bases?.p2?.hp ?? 0)) / bMax;
  const baseAdv = b1Lost - b2Lost;

  const p2 = weights.w_hp * hpAdv + weights.w_base * baseAdv;

  return { p2, p1: -p2 };
}

/**
 * 计算整局得分：累加各回合得分 + 胜负加分（零和）。
 * @param {Array<{p2:number,p1:number}>} roundResults - 各回合双方得分
 * @param {string|null} winner - 'P1' | 'P2' | 'draw' | null
 * @param {object} weights - 权重
 * @returns {{ p2: number, p1: number, rounds: Array }}
 */
function computeGameReward(roundResults, winner, weights = REWARD_DEFAULTS) {
  let p2 = 0, p1 = 0;
  for (const r of roundResults) { p2 += r.p2; p1 += r.p1; }
  let winDelta = 0;
  if (winner === 'P2') winDelta = 1;
  else if (winner === 'P1') winDelta = -1;
  const wWin = weights.w_win * winDelta;
  p2 += wWin;
  p1 -= wWin;
  return { p2, p1, rounds: roundResults };
}

module.exports = { REWARD_DEFAULTS, normalizeWeights, computeRoundReward, computeGameReward };
