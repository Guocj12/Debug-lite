'use strict';
/* .audit/content-design.js —— 内容数值复算审计（依据 docs/content-design.md §1/§5/§6，D-173）
 *
 * 定位：**独立于测试套件**的内容配平复算 —— 直接读 server/data/*.json，按设计文档写明的模型
 *   机器复算期望值，与表内冻结值逐条比对；任何一条漂移即 exit 1（用于"文档 ↔ 表"防双源）。
 *
 * 复算范围：
 *   ① EP 权重（§1）：P = A×H×(D+defK) → 1 atk ≡ 6.33 hp ≡ 3.20 def
 *   ② 角色插件标准值（§5）：v = p = 0.085 × pointCost × 基准（pct 基准 1；数值型基准 = Ref_绿(stat)；
 *      **def 基准 = def + defK**）—— 覆盖 27 条五维插件（百分比 + 数值）
 *   ③ 技能 η（§6.1）：hit = atk×baseHitMul×(1−def/(def+defK))；D = hit×倍率×覆盖价值×p_pos×等级修正×暴击因子；
 *      adv = D + Σ等效收益 − 替代行动；cost = sp + mp + 4×CD；η = adv/cost ≈ 0.40
 *      —— 覆盖 4 条基础模板 + 16 条专属插件；并**冻结** sp/mp/CD 的推导结果
 *   ④ 通用技能插件词条（§6.5）：7 条的 v 与表内一致
 *
 * 用法：`node .audit/content-design.js`（exit 0 = 全一致 / 1 = 有漂移）
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKILLS = require(path.join(ROOT, 'server/data/skill-templates.json')).skillTemplates;
const PLUGINS = require(path.join(ROOT, 'server/data/plugins.json')).plugins;
const QUALITIES = require(path.join(ROOT, 'server/data/qualities.json'));
const ROLES = require(path.join(ROOT, 'server/data/role-templates.json'));
const CFG = require(path.join(ROOT, 'server/data/battle-config.json'));

// ---------- §1 EP 模型 ----------
const P_POINT = 0.085; // §1 每点战力旋钮
function epModel() {
  const B0 = ROLES.roleTemplates.find((r) => r.id === 'role_bal').baseStats;
  const K = CFG.defK;
  const marginal = { atk: 1 / B0.atk, hp: 1 / B0.hp, def: 1 / (B0.def + K) };
  return {
    B0,
    K,
    // 1 atk 等价多少 hp / def（§1 换算表：6.33 hp / 3.20 def）
    atkToHp: marginal.atk / marginal.hp,
    atkToDef: marginal.atk / marginal.def,
    marginal,
    // 基准普攻（§6.1）：hit = atk × baseHitMul × (1 − def/(def+defK))
    hit: B0.atk * CFG.baseHitMul * (1 - B0.def / (B0.def + K)),
  };
}

// ---------- §5 角色插件标准值 ----------
// 基准：pct 型 = 1；数值型 = Ref_绿(stat)（**def 用 def + defK**）
function rolePluginBench(B0, K) {
  return { atk_pct: 1, hp_pct: 1, sp_cap: 1, mp_cap: 1, atk_flat: B0.atk, hp_flat: B0.hp, def_flat: B0.def + K, sp_flat: B0.sp, mp_flat: B0.mp };
}

// ---------- §6.1 技能配平模型 ----------
const POS = { melee: 0.6, straight: 0.8, vertical: 0.8, displacement: 0.5 };
// 替代行动（§6.1：普攻类 = 同位置一次普攻的期望；位移类 = 0）
const ALT = { melee: 9.0, straight: 6.0, vertical: 6.0, displacement: 0 };
const SPLIT = {
  melee: { sp: 1, mp: 0 }, displacement: { sp: 1, mp: 0 },
  straight: { sp: 0.3, mp: 0.7 }, vertical: { sp: 0, mp: 1 },
};
const COST_CAP = 35; // 单技能单维资源上限（§6.1）
const CD_CAP = 8;
const ETA = 0.4;

const levelFactor = (L) => 1 + 0.05 * (L - 2);
const cdTier = (adv) => (adv < 5 ? 1 : adv < 9 ? 2 : adv < 14 ? 3 : adv < 20 ? 4 : adv < 26 ? 5 : adv < 32 ? 6 : 7);

// 覆盖价值：近战 = 格数 / 平射 = 弹幕数 / 定点 = Σ(1−衰减)^|偏移| / 位移 = 距离（造成伤害时）
function coveredValue(sk) {
  if (sk.type === 'melee') return sk.range[1] - sk.range[0] + 1;
  if (sk.type === 'straight') return sk.bulletCount;
  if (sk.type === 'vertical') {
    let s = 0;
    for (let off = sk.area[0]; off <= sk.area[1]; off += 1) s += Math.pow(1 - sk.falloff, Math.abs(off));
    return s;
  }
  return sk.dealDamage ? sk.distance : 0;
}

// 技能形态（模板 or 模板 + 专属覆盖）→ 期望收益 adv
function advantage(form, extras, ep) {
  const crit = 1 + (form.critChance || 0) * (1 + (form.critMul || 0));
  const D = form.type === 'displacement'
    ? (form.dealDamage ? ep.hit * form.multiplier * coveredValue(form) * POS[form.type] * levelFactor(form.bulletLevel) * crit : 0)
    : ep.hit * form.multiplier * coveredValue(form) * POS[form.type] * levelFactor(form.bulletLevel) * crit;
  const sum = Object.values(extras).reduce((a, b) => a + b, 0);
  return D + sum - ALT[form.type];
}

// 词条/效果 → 等效收益（§6.1 等效收益表；B0 分母）
function effectsValue(form, base, ex, ep) {
  const out = {};
  const B0 = ep.B0;
  // 射程：±1 格 = ±1
  if (form.type === 'melee') out.range = (form.range[1] - base.range[1]) * 1;
  else if (form.type === 'straight' || form.type === 'vertical') out.range = (form.range - base.range) * 1;
  // 位移 = (距离 − 1) × 3
  if (form.type === 'displacement') out.move = (form.distance - 1) * 3;
  // 穿敌 = 3；全程闪避 = 10
  if (form.passThroughEnemy && !base.passThroughEnemy) out.passThrough = 3;
  if (form.fullDodgeDuring && !base.fullDodgeDuring) out.fullDodge = 10;
  for (const h of (ex && ex.hitEffects) || []) {
    if (h.kind === 'control' && h.displacementFrom) out.control = (h.params ? h.params[h.displacementFrom] : 0) * 3; // 击退/拉近 1 格 = 3
    else if (h.kind === 'control') out.control = h.remaining * 10;                                                   // 眩晕 1 tick = 10
    else if (h.kind === 'continuous' && h.stat === 'def') out.defDown = (Math.abs(h.delta) / (B0.def + ep.K)) * ep.hit * h.remaining;
    else if (h.kind === 'continuous' && h.stat === 'hp') out.dot = Math.abs(h.delta) * h.remaining;                  // 直扣 HP：1 点 = 1
  }
  for (const c of (ex && ex.castEffects) || []) {
    const denom = c.stat === 'atk' ? B0.atk : c.stat === 'def' ? B0.def + ep.K : B0[c.stat];
    out[`self_${c.stat}`] = (c.delta / denom) * ep.hit * c.remaining;
  }
  return out;
}

// 由 adv 推导 cost/CD（§6.1：CD 档位 → cost = adv/η → 资源 = cost − 4×CD → 按类型分配；超上限则 CD +1）
function derive(formType, adv) {
  let cd = cdTier(adv);
  const cost = Math.max(1, Math.round(adv / ETA));
  let res = cost - 4 * cd;
  while (res > COST_CAP && cd < CD_CAP) { cd += 1; res = cost - 4 * cd; }
  const sp = Math.max(0, Math.round(res * SPLIT[formType].sp));
  const mp = Math.max(0, Math.round(res * SPLIT[formType].mp));
  return { cd, sp, mp, cost: sp + mp + 4 * cd };
}

// ---------- ③ 通用插件（§6.5）----------
const GENERAL_EXPECTED = {
  sk_mult: { affix: 'mult_up', v: 0.085 },
  sk_crit: { affix: 'crit_chance', v: 0.085 },
  sk_critdmg: { affix: 'critMul', v: 0.17 },
  sk_cd_down: { affix: 'cooldown_down', v: 0.25 },
  sk_sp_down: { affix: 'cost_down_sp', v: 0.2 },
  sk_mp_down: { affix: 'cost_down_mp', v: 0.2 },
  sk_true: null, // 双词条：mult_up −0.1 + true_convert（下方单独断言）
};

function audit() {
  const problems = [];
  const ep = epModel();

  // ① EP 权重
  if (Math.abs(ep.atkToHp - 6.33) > 0.01) problems.push(`§1 1 atk ≡ hp 应为 6.33，实得 ${ep.atkToHp.toFixed(3)}`);
  if (Math.abs(ep.atkToDef - 3.2) > 0.01) problems.push(`§1 1 atk ≡ def 应为 3.20，实得 ${ep.atkToDef.toFixed(3)}`);
  if (Math.abs(ep.hit - 10) > 1e-9) problems.push(`§6.1 基准普攻 hit 应为 10.0，实得 ${ep.hit}`);

  // ② 角色插件标准值（27 条五维插件）
  const bench = rolePluginBench(ep.B0, ep.K);
  let roleChecked = 0;
  for (const p of PLUGINS.filter((x) => x.kind === 'rolePlugin')) {
    for (const a of p.affixes || []) {
      const b = bench[a.id];
      if (b === undefined) continue; // 特殊型（dodge/crit/... 见 §5 特殊表）不套用本公式
      const want = Math.round(P_POINT * p.pointCost * b * 1000) / 1000;
      const got = Math.round(a.params.v * 1000) / 1000;
      roleChecked += 1;
      if (Math.abs(want - got) > 1e-9) problems.push(`§5 ${p.id}(${a.id}) v 应 ${want}（0.085×${p.pointCost}×${b}），实得 ${got}`);
    }
  }
  if (roleChecked !== 27) problems.push(`§5 五维角色插件词条应恰好 27 条，实得 ${roleChecked}`);

  // ④ 通用技能插件（§6.5）
  for (const [id, spec] of Object.entries(GENERAL_EXPECTED)) {
    const p = PLUGINS.find((x) => x.id === id);
    if (!p) { problems.push(`§6.5 缺通用插件 ${id}`); continue; }
    if (p.slot !== 'general') problems.push(`§6.5 ${id} 应 slot=general`);
    if (spec === null) continue;
    const a = (p.affixes || []).find((x) => x.id === spec.affix);
    if (!a) { problems.push(`§6.5 ${id} 缺词条 ${spec.affix}`); continue; }
    if (Math.abs(a.params.v - spec.v) > 1e-9) problems.push(`§6.5 ${id}.${spec.affix} 应 ${spec.v}，实得 ${a.params.v}`);
  }
  const skTrue = PLUGINS.find((x) => x.id === 'sk_true');
  if (!skTrue) problems.push('§6.5 缺 sk_true');
  else {
    const mu = (skTrue.affixes || []).find((x) => x.id === 'mult_up');
    if (!mu || Math.abs(mu.params.v + 0.1) > 1e-9) problems.push('§6.5 sk_true 的 mult_up 应为 −0.10');
    if (!(skTrue.affixes || []).some((x) => x.id === 'true_convert')) problems.push('§6.5 sk_true 应带 true_convert');
  }
  const generals = PLUGINS.filter((x) => x.kind === 'skillPlugin' && x.slot === 'general');
  if (generals.length !== 7) problems.push(`§6.5 通用技能插件应恰 7 条，实得 ${generals.length}`);
  const exclusives = PLUGINS.filter((x) => x.kind === 'skillPlugin' && x.slot === 'exclusive');
  if (exclusives.length !== 16) problems.push(`§6.4 专属技能插件应恰 16 条，实得 ${exclusives.length}`);

  // ③ 技能 η：基础模板
  const rows = [];
  const checkRow = (label, form, base, ex, cur) => {
    const extras = effectsValue(form, base, ex, ep);
    const adv = advantage(form, extras, ep);
    const d = derive(form.type, adv);
    const eta = adv / (cur.sp + cur.mp + 4 * cur.cd);
    rows.push({ label, adv, eta, d, cur });
    if (Math.abs(eta - ETA) > 0.02) problems.push(`§6 ${label} η=${eta.toFixed(3)} 偏离 0.40 超过 ±0.02`);
    if (d.cd !== cur.cd || d.sp !== cur.sp || d.mp !== cur.mp) {
      problems.push(`§6 ${label} 推导 sp${d.sp}/mp${d.mp}/cd${d.cd} ≠ 表内 sp${cur.sp}/mp${cur.mp}/cd${cur.cd}`);
    }
  };
  for (const t of SKILLS) {
    checkRow(t.id, { ...t, multiplier: t.baseMultiplier }, t, null, { sp: t.baseCost.sp, mp: t.baseCost.mp, cd: t.cooldown });
  }
  for (const p of exclusives) {
    const base = SKILLS.find((t) => t.type === p.forTypes[0]);
    if (!base) { problems.push(`§6.4 ${p.id} 的 forTypes 无对应基础模板`); continue; }
    const ov = p.exclusive.overrides || {};
    const form = { ...base, multiplier: base.baseMultiplier, bulletLevel: base.bulletLevel, ...ov, ...(p.exclusive.specials || {}) };
    if (form.cost) delete form.cost;
    checkRow(p.id, form, base, p.exclusive, { sp: ov.cost.sp, mp: ov.cost.mp, cd: ov.cooldown });
  }

  return { ok: problems.length === 0, problems, rows, ep, roleChecked };
}

// 打印 + 退出码（CLI 入口；gate 项 5 直接调用 audit() 取结构化结果）
function run() {
  const r = audit();
  const ep = r.ep;
  console.log('内容数值复算（docs/content-design.md §1/§5/§6）');
  console.log(`  EP：1 atk ≡ ${ep.atkToHp.toFixed(2)} hp ≡ ${ep.atkToDef.toFixed(2)} def；基准普攻 hit=${ep.hit.toFixed(2)}`);
  console.log(`  §5 五维角色插件逐值核对：${r.roleChecked} 条`);
  console.log('  §6 技能 η 复算：');
  for (const row of r.rows) {
    console.log(`    ${row.label.padEnd(16)} adv=${row.adv.toFixed(2).padStart(6)}  推导 sp${String(row.d.sp).padStart(2)}/mp${String(row.d.mp).padStart(2)}/cd${row.d.cd}  η=${row.eta.toFixed(3)}`);
  }
  if (r.ok) {
    console.log(`[PASS] 全一致（角色插件 ${r.roleChecked} 条 + 技能 ${r.rows.length} 条；η 全部落在 0.40±0.02）`);
    process.exitCode = 0;
    return r;
  }
  console.error(`[FAIL] ${r.problems.length} 处漂移：`);
  for (const p of r.problems) console.error(`  - ${p}`);
  process.exitCode = 1;
  return r;
}

module.exports = { run, audit, epModel, advantage, derive, effectsValue, cdTier, coveredValue };

if (require.main === module) run();
