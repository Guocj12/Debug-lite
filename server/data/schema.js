'use strict';
/* server/data/schema.js —— 数据表校验器（P0-6，T-DC-1 结构 + T-DC-2 items-data 一致性）
 * 契约：server/data/README.md；被 scripts/gate.js 项 4（validateStructure）与项 5（validateConsistency）调用。
 * 期望值硬编码于此（校验器而非战斗代码，注释标明文档出处）；战斗代码必须读取数据表而非本文件。
 * 产物：validateStructure(dataDir) / validateConsistency(dataDir) / validate(dataDir) → {ok, detail}
 * P0-9：assets/ 占位表（sprites/animations）纳入 T-DC-1 校验范围（dataDir 的兄弟目录，经 API 作为数据表提供）。
 */
const fs = require('node:fs');
const path = require('node:path');

const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const TIER_SEQ = Object.fromEntries(TIERS.map((t, i) => [t, i]));

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// assets 形状枚举（items-data §1 占位规范；技能四形状 + 插件固定几何形——几何形清单为 P0-9 占位定义，B21 前可扩展）
const ASSET_SHAPES = {
  roleTemplate: ['square16'],
  skillTemplate: ['melee_bar', 'straight_arrow', 'vertical_bar', 'displacement_trail'],
  rolePlugin: ['sword', 'shield', 'heart', 'bolt', 'bolt_regen', 'drop', 'drop_regen', 'wind', 'fang', 'star', 'cross'],
  skillPlugin: ['up_arrow', 'down_arrow', 'clock', 'ruler', 'multi_dot', 'star_up', 'arrow_shift', 'spiral', 'push', 'pull', 'flame', 'pierce', 'star', 'fang', 'aura'],
};
const BASE_ANIMS = ['idle', 'move', 'dodge', 'hit', 'cast', 'dead'];

// ---------- T-DC-1 冻结数值（出处：tasks.md §2.5.7 / systems/06-field.md §3） ----------

const BATTLE_CONFIG_FROZEN = {
  cellPx: 64, cells: 16, fieldPx: 1024, actorHalfPx: 32, minGapPx: 64,
  movePx: 64, dodgePx: 128,
  collisionDmgMul: 0.8, baseHitMul: 0.8, baseDef: 64, defendDefMul: 1.6,
  dodgeChanceBonus: 0.2, backstab: 1.5, crit: 1.5,
  defK: 40, // B21 校准入表（D-128：减伤公式常数 1 − def/(def+defK)）
  overtimeStart: 48, overtimeRatio: 0.0625, hardCapTick: 64,
};

const QUALITY_PLUGIN_POINTS = { common: 3, rare: 4, epic: 5, legendary: 6, mythic: 7 }; // D-116 / items-data §2

const AI_NODES_BY_TIER = { // examples/09-unlock.md §1（增量；累积 11/14/17/17/19）
  common: ['if'], rare: ['loop', 'while', 'break'], epic: ['random', 'logic', 'arith_ext'],
  legendary: [], mythic: ['function', 'call'],
};
const AI_BASE_NODES = ['seq', 'literal', 'get', 'bullets', 'var', 'set', 'getVar', 'arith', 'cmp', 'action'];

// ---------- T-DC-2 items-data 期望表（出处：items-data.md §3/§4/§2/§5/§6） ----------

const ROLE_EXPECTED = [
  ['role_bal', '均衡', 'balanced'],
  ['role_spc_hp', '特化·HP', 'specialized'], ['role_spc_atk', '特化·攻击', 'specialized'],
  ['role_spc_def', '特化·防御', 'specialized'], ['role_spc_sp', '特化·SP', 'specialized'],
  ['role_spc_mp', '特化·MP', 'specialized'],
  ['role_exp_hp', '专家·HP', 'expert'], ['role_exp_atk', '专家·攻击', 'expert'],
  ['role_exp_def', '专家·防御', 'expert'], ['role_exp_sp', '专家·SP', 'expert'],
  ['role_exp_mp', '专家·MP', 'expert'],
];

// [id, name, type, mult, cost{mp,sp}, cd, bulletLevel, 类型参数, unlockTier]（items-data §4.1~4.4）
const SKILL_EXPECTED = [
  ['skill_melee_whirl', '旋风斩', 'melee', 1.0, { mp: 0, sp: 12 }, 2, 2, { range: [-1, 1] }, 'common'],
  ['skill_melee_heavy', '重击', 'melee', 1.3, { mp: 10, sp: 8 }, 4, 2, { range: [0, 2] }, 'rare'],
  ['skill_straight_precise', '精准射击', 'straight', 0.9, { mp: 0, sp: 6 }, 2, 3, { range: 8, bulletCount: 1 }, 'common'],
  ['skill_straight_rapid', '连续射击', 'straight', 0.5, { mp: 8, sp: 0 }, 4, 4, { range: 5, bulletCount: 4 }, 'rare'],
  ['skill_straight_ice', '冰锥', 'straight', 1.3, { mp: 8, sp: 0 }, 3, 4, { range: 5, bulletCount: 1 }, 'rare'],
  ['skill_straight_poison', '毒瓶', 'straight', 0.5, { mp: 6, sp: 0 }, 4, 4, { range: 5, bulletCount: 1 }, 'epic'],
  ['skill_vert_rain', '箭雨', 'vertical', 0.9, { mp: 12, sp: 0 }, 5, 4, { range: 8, area: [-2, 2] }, 'epic'],
  ['skill_vert_fireball', '火球术', 'vertical', 0.8, { mp: 14, sp: 0 }, 5, 3, { range: 8, area: [-1, 1] }, 'legendary'],
  ['skill_dash_bash', '突击盾', 'displacement', 0.8, { mp: 0, sp: 10 }, 3, 2, { distance: 4, passThroughEnemy: false, dealDamage: true, fullDodgeDuring: false }, 'mythic'],
  ['skill_dash_shadow', '暗影步', 'displacement', 0, { mp: 0, sp: 8 }, 3, 3, { distance: 3, passThroughEnemy: true, dealDamage: false, fullDodgeDuring: true }, 'mythic'],
];

// [id, name, color, statRange, roleSlotRange, skillSlotRange]（items-data §2）
const QUALITY_EXPECTED = [
  ['common', '绿', '#2ecc71', [0.80, 1.05], [1, 3], [0, 1]],
  ['rare', '蓝', '#3498db', [1.00, 1.25], [2, 4], [0, 2]],
  ['epic', '紫', '#9b59b6', [1.20, 1.45], [3, 5], [1, 3]],
  ['legendary', '橙', '#e67e22', [1.40, 1.70], [4, 6], [2, 4]],
  ['mythic', '青', '#1abc9c', [1.60, 2.00], [5, 7], [3, 4]],
];

// [id, slot, category, 词条基础值 v]（items-data §5 角色插件 / §6 技能插件）
// v 为 affixes[0].params.v 的期望基础值（实例化时乘以档位系数，01-items I-6）
const PLUGIN_EXPECTED = [
  ['rp_atk_pct', 'atk', '攻击提升', 0.08], ['rp_atk_flat', 'atk', '攻击提升', 4],
  ['rp_def_pct', 'def', '防御强化', 0.08], ['rp_def_flat', 'def', '防御强化', 3],
  ['rp_hp_pct', 'hp', '生命强化', 0.08], ['rp_hp_flat', 'hp', '生命强化', 20],
  ['rp_sp_opt', 'sp', 'SP 优化', 0.15], ['rp_sp_regen', 'sp', 'SP 优化', 1],
  ['rp_mp_opt', 'mp', 'MP 优化', 0.15], ['rp_mp_regen', 'mp', 'MP 优化', 1],
  ['rp_dodge', 'special', '闪避', 0.05], ['rp_lifesteal', 'special', '吸血', 0.10],
  ['rp_crit', 'special', '暴击', 0.08], ['rp_regen', 'special', '回复', 1],
  ['sp_mult', 'basic', '倍率提升', 0.15], ['sp_cost_down', 'basic', '消耗优化', 0.20],
  ['sp_cooldown', 'basic', '冷却缩减', 1], ['sp_range', 'basic', '射程增强', 2],
  ['sp_bullet', 'basic', '弹幕增强', 1], ['sp_level', 'basic', '等级凝练', 1],
  ['sp_displacement', 'basic', '位移增强', 1],
  ['sp_stun', 'special', '眩晕', 1], ['sp_knockback', 'special', '击退', 1],
  ['sp_pull', 'special', '拉近', 1], ['sp_dot', 'special', '持续伤害', 3],
  ['sp_true_dmg', 'special', '真实伤害', 1], ['sp_crit', 'special', '暴击', 0.10],
  ['sp_lifesteal', 'special', '吸血', 0.20], ['sp_buff', 'special', '释放增益', 2],
];

// ---------- 工具 ----------

function loadJSON(dataDir, file) {
  const p = path.join(dataDir, file);
  return { p, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
}

function problemsOf(problems) {
  if (problems.length === 0) return { ok: true, detail: '全表校验通过' };
  return { ok: false, detail: `校验失败 ${problems.length} 处：${problems.slice(0, 20).join('；')}${problems.length > 20 ? `…(+${problems.length - 20})` : ''}` };
}

function isInt(n) { return Number.isInteger(n); }
function isNum(n) { return typeof n === 'number' && Number.isFinite(n); }

// ---------- T-DC-1：结构 + 冻结数值 ----------

function validateStructure(dataDir, assetsDir) {
  const problems = [];
  const tables = {};
  // assets 占位表（P0-9）：默认推导 <repo>/assets；fixture 测试可显式传入
  const assetsDirResolved = assetsDir || path.join(dataDir, '..', '..', 'assets');
  try {
    tables.battle = loadJSON(dataDir, 'battle-config.json').data;
  } catch (e) { problems.push(`battle-config.json 缺失或解析失败: ${e.message}`); }
  try {
    tables.roleTable = loadJSON(dataDir, 'role-templates.json').data;
    tables.roles = tables.roleTable.roleTemplates;
  } catch (e) { problems.push(`role-templates.json 缺失或解析失败: ${e.message}`); }
  try {
    tables.skills = loadJSON(dataDir, 'skill-templates.json').data.skillTemplates;
  } catch (e) { problems.push(`skill-templates.json 缺失或解析失败: ${e.message}`); }
  try {
    tables.plugins = loadJSON(dataDir, 'plugins.json').data.plugins;
  } catch (e) { problems.push(`plugins.json 缺失或解析失败: ${e.message}`); }
  try {
    tables.qualities = loadJSON(dataDir, 'qualities.json').data;
  } catch (e) { problems.push(`qualities.json 缺失或解析失败: ${e.message}`); }
  try {
    tables.itemsConfig = loadJSON(dataDir, 'items-config.json').data;
  } catch (e) { problems.push(`items-config.json 缺失或解析失败: ${e.message}`); }
  try {
    tables.unlock = loadJSON(dataDir, 'unlock.json').data;
  } catch (e) { problems.push(`unlock.json 缺失或解析失败: ${e.message}`); }
  // assets 占位表（P0-9：path.join(dataDir, '..', '..', 'assets') —— dataDir=server/data）
  try {
    tables.sprites = loadJSON(assetsDirResolved, 'sprites.json').data;
  } catch (e) { problems.push(`assets/sprites.json 缺失或解析失败: ${e.message}`); }
  try {
    tables.animations = loadJSON(assetsDirResolved, 'animations.json').data;
  } catch (e) { problems.push(`assets/animations.json 缺失或解析失败: ${e.message}`); }
  if (problems.length > 0) return problemsOf(problems);

  // battle-config：冻结数值逐值相等（D-117：tasks.md §2.5.7 + 06-field §3）
  const bc = tables.battle;
  for (const [k, v] of Object.entries(BATTLE_CONFIG_FROZEN)) {
    if (bc[k] !== v) problems.push(`battle-config.${k} = ${bc[k]}，应为 ${v}（§2.5.7 冻结）`);
  }
  if (bc.startX && (bc.startX.p1 !== 224 || bc.startX.p2 !== 800)) problems.push(`startX 应为 {p1:224,p2:800}，实际 ${JSON.stringify(bc.startX)}`);
  if (bc.startFacing && (bc.startFacing.p1 !== 1 || bc.startFacing.p2 !== -1)) problems.push('startFacing 应为 {p1:1,p2:-1}');
  for (const owner of ['p1', 'p2']) {
    const base = bc.bases && bc.bases[owner];
    if (!base) { problems.push(`bases.${owner} 缺失`); continue; }
    if (base.def !== bc.baseDef) problems.push(`bases.${owner}.def(${base.def}) 应等于 baseDef(${bc.baseDef})`);
    if (base.hp !== 100 || base.maxHp !== 100) problems.push(`bases.${owner} hp 应为 100/100`);
  }

  // role-templates（D-110 regen 必填；D-112 unlockTier 可选；typeModifiers L9 入表，B5）
  const tm = tables.roleTable ? tables.roleTable.typeModifiers : null;
  if (!tm) {
    problems.push('role-templates.json 缺 typeModifiers（L9：修饰系数必须入表）');
  } else {
    // 冻结值核对（02-roles R-2/R-3：特化 +15%/-15%；专家 +30% 与 略高/极低/略低/标准）
    if (tm.specialized.high !== 1.15 || tm.specialized.low !== 0.85) problems.push('typeModifiers.specialized 应为 {high:1.15, low:0.85}');
    if (tm.expert.high !== 1.30) problems.push('typeModifiers.expert.high 应为 1.30');
    if (JSON.stringify(tm.expert.spread) !== JSON.stringify([1.1, 0.7, 0.9, 1.0])) problems.push('typeModifiers.expert.spread 应为 [1.1,0.7,0.9,1.0]');
  }
  const roleIds = new Set();
  for (const r of tables.roles) {
    if (roleIds.has(r.id)) problems.push(`角色模板 id 重复: ${r.id}`);
    roleIds.add(r.id);
    if (!r.name) problems.push(`${r.id}: 缺 name`);
    if (!['balanced', 'specialized', 'expert'].includes(r.type)) problems.push(`${r.id}: type 非法 ${r.type}`);
    if (r.type !== 'balanced' && !['hp', 'atk', 'def', 'sp', 'mp'].includes(r.highStat)) problems.push(`${r.id}: ${r.type} 必须带 highStat`);
    const bs = r.baseStats;
    if (!bs || !['hp', 'atk', 'def', 'sp', 'mp'].every((k) => isNum(bs[k]))) problems.push(`${r.id}: baseStats 必须五维数值`);
    if (!r.regen || !isNum(r.regen.mp) || !isNum(r.regen.sp)) problems.push(`${r.id}: regen{mp,sp} 必填（D-110）`);
    if (!r.slotWeights || !['atk', 'def', 'hp', 'sp', 'mp', 'special'].every((k) => isInt(r.slotWeights[k]) && r.slotWeights[k] >= 0)) problems.push(`${r.id}: slotWeights 六键非负整数`);
    if (!isInt(r.pluginPoints) || r.pluginPoints < 1) problems.push(`${r.id}: pluginPoints 正整数`);
    if (r.unlockTier !== undefined && !(r.unlockTier in TIER_SEQ)) problems.push(`${r.id}: unlockTier 非法 ${r.unlockTier}`);
  }
  if (tables.roles.length !== 11) problems.push(`角色模板应 11 个，实际 ${tables.roles.length}（items-data §3）`);

  // skill-templates（无 bulletSpeed / 类型参数 / falloff / bulletLevel 1..4）
  const skillIds = new Set();
  for (const s of tables.skills) {
    if (skillIds.has(s.id)) problems.push(`技能模板 id 重复: ${s.id}`);
    skillIds.add(s.id);
    if ('bulletSpeed' in s) problems.push(`${s.id}: 出现已删除字段 bulletSpeed（D-21）`);
    if (!['melee', 'straight', 'vertical', 'displacement'].includes(s.type)) problems.push(`${s.id}: type 非法`);
    if (!isNum(s.baseMultiplier)) problems.push(`${s.id}: baseMultiplier 数值`);
    const cost = s.baseCost;
    if (!cost || !['hp', 'mp', 'sp'].every((k) => isNum(cost[k]))) problems.push(`${s.id}: baseCost {hp,mp,sp}`);
    if (!isInt(s.cooldown) || s.cooldown < 0) problems.push(`${s.id}: cooldown 非负整数`);
    if (!isInt(s.bulletLevel) || s.bulletLevel < 1 || s.bulletLevel > 4) problems.push(`${s.id}: bulletLevel 1..4（D-118：位移模板同样携带）`);
    if (!isNum(s.falloff) || s.falloff < 0) problems.push(`${s.id}: falloff ≥0（D-29）`);
    if (!s.slotWeights || !isInt(s.slotWeights.basic) || !isInt(s.slotWeights.special)) problems.push(`${s.id}: slotWeights {basic,special}（D-111）`);
    if (s.type === 'melee' && !(Array.isArray(s.range) && s.range.length === 2 && isInt(s.range[0]) && isInt(s.range[1]) && s.range[0] <= s.range[1])) problems.push(`${s.id}: melee 需 range[lo,hi] 整数`);
    if (s.type === 'straight' && (!isInt(s.range) || s.range < 1 || !isInt(s.bulletCount) || s.bulletCount < 1)) problems.push(`${s.id}: straight 需 range≥1 与 bulletCount≥1`);
    if (s.type === 'vertical' && (!isInt(s.range) || s.range < 1 || !(Array.isArray(s.area) && s.area.length === 2 && isInt(s.area[0]) && isInt(s.area[1])))) problems.push(`${s.id}: vertical 需 range≥1 与 area[lo,hi]`);
    if (s.type === 'displacement') {
      if (!isInt(s.distance) || s.distance < 1) problems.push(`${s.id}: displacement 需 distance≥1`);
      for (const k of ['passThroughEnemy', 'dealDamage', 'fullDodgeDuring']) {
        if (typeof s[k] !== 'boolean') problems.push(`${s.id}: ${k} 布尔`);
      }
    }
    if (s.unlockTier !== undefined && !(s.unlockTier in TIER_SEQ)) problems.push(`${s.id}: unlockTier 非法`);
  }
  if (tables.skills.length !== 10) problems.push(`技能模板应 10 个，实际 ${tables.skills.length}（items-data §4）`);

  // plugins（D-113 costDeltaByTier / D-114 一个变体一个 id）
  const pluginIds = new Set();
  let nRole = 0;
  let nSkill = 0;
  const costDeltaShape = (cd) => cd === null
    || (typeof cd === 'object' && cd !== null
      && Object.keys(cd).length >= 1 && Object.keys(cd).every((k) => ['hp', 'mp', 'sp'].includes(k))
      && Object.values(cd).every((arr) => Array.isArray(arr) && arr.length === 3 && arr.every(isNum)));
  for (const p of tables.plugins) {
    if (pluginIds.has(p.id)) problems.push(`插件 id 重复: ${p.id}`);
    pluginIds.add(p.id);
    if (p.kind === 'rolePlugin') {
      nRole++;
      if (!['atk', 'def', 'hp', 'sp', 'mp', 'special'].includes(p.slot)) problems.push(`${p.id}: rolePlugin 槽位非法`);
      if (!Array.isArray(p.pointCostByTier) || JSON.stringify(p.pointCostByTier) !== JSON.stringify([1, 2, 3])) problems.push(`${p.id}: pointCostByTier 应 [1,2,3]（D-113）`);
    } else if (p.kind === 'skillPlugin') {
      nSkill++;
      if (!['basic', 'special'].includes(p.slot)) problems.push(`${p.id}: skillPlugin 槽位非法`);
      if (!costDeltaShape(p.costDeltaByTier)) problems.push(`${p.id}: costDeltaByTier 应逐档数组或 null（D-113）`);
    } else {
      problems.push(`${p.id}: kind 非法 ${p.kind}`);
    }
    if (!p.name || !p.desc || !Array.isArray(p.affixes) || p.affixes.length === 0) problems.push(`${p.id}: name/desc/affixes 必填`);
    if (p.unlockTier !== undefined && !(p.unlockTier in TIER_SEQ)) problems.push(`${p.id}: unlockTier 非法`);
  }
  if (nRole !== 14 || nSkill !== 15) problems.push(`插件应 14 角色 + 15 技能，实际 ${nRole}+${nSkill}（items-data §5/§6）`);

  // qualities（tiers 三等分接续；D-116 pluginPoints）
  const qIds = new Set();
  for (const q of tables.qualities.qualities) {
    if (qIds.has(q.id)) problems.push(`品质 id 重复: ${q.id}`);
    qIds.add(q.id);
    if (!TIERS.includes(q.id)) problems.push(`品质 id 非法: ${q.id}`);
    if (QUALITY_PLUGIN_POINTS[q.id] !== undefined && q.pluginPoints !== QUALITY_PLUGIN_POINTS[q.id]) problems.push(`${q.id}: pluginPoints 应 ${QUALITY_PLUGIN_POINTS[q.id]}（D-116）`);
    const [lo, hi] = q.statRange;
    if (!isNum(lo) || !isNum(hi) || lo > hi) problems.push(`${q.id}: statRange 非法`);
    if (!Array.isArray(q.tiers) || q.tiers.length !== 3) { problems.push(`${q.id}: tiers 须 3 段`); continue; }
    const eps = 1e-4;
    q.tiers.forEach((seg, i) => {
      if (!Array.isArray(seg) || seg.length !== 2 || !isNum(seg[0]) || !isNum(seg[1]) || seg[0] > seg[1]) {
        problems.push(`${q.id}: tiers[${i}] 非法`);
        return;
      }
      if (i === 0 && Math.abs(seg[0] - lo) > eps) problems.push(`${q.id}: tiers[0] 起点应等于 statRange[0]`);
      if (i === 2 && Math.abs(seg[1] - hi) > eps) problems.push(`${q.id}: tiers[2] 终点应等于 statRange[1]`);
      if (i > 0 && Math.abs(seg[0] - q.tiers[i - 1][1]) > eps) problems.push(`${q.id}: tiers 段间不接续（${q.tiers[i - 1][1]} → ${seg[0]}）`);
    });
  }
  if (tables.qualities.qualities.length !== 5) problems.push(`品质应 5 个`);
  const cdb = tables.qualities.costDeltaBase;
  if (!cdb || TIERS.some((t) => !isInt(cdb[t])) || cdb.common !== 2 || cdb.rare !== 3 || cdb.mythic !== 6) problems.push(`costDeltaBase 应 {common:2,rare:3,epic:4,legendary:5,mythic:6}`);

  // items-config（dropRates 和 = 1）
  const dr = tables.itemsConfig.dropRates;
  const kw = tables.itemsConfig.kindWeights;
  if (!dr || TIERS.some((t) => !isNum(dr[t]))) problems.push('dropRates 五键数值');
  else {
    const sum = TIERS.reduce((a, t) => a + dr[t], 0);
    if (Math.abs(sum - 1.0) > 1e-9) problems.push(`dropRates 之和 = ${sum}，应为 1.0`);
  }
  if (!kw || !['role', 'skill', 'rolePlugin', 'skillPlugin'].every((k) => isNum(kw[k]) && kw[k] > 0)) problems.push('kindWeights 四键正数');

  // unlock（段位齐全；AI 节点增量表；与三表 unlockTier 交叉一致）
  const byTier = Object.fromEntries(tables.unlock.unlocks.map((u) => [u.tier, u]));
  for (const t of TIERS) {
    if (!byTier[t]) { problems.push(`unlock 缺段位 ${t}`); continue; }
    const expect = JSON.stringify([...AI_BASE_NODES].concat(TIERS.slice(0, TIER_SEQ[t] + 1).reduce((acc, tt) => acc.concat(AI_NODES_BY_TIER[tt]), [])));
    const actual = [...AI_BASE_NODES].concat(TIERS.slice(0, TIER_SEQ[t] + 1).reduce((acc, tt) => acc.concat((byTier[tt] && byTier[tt].aiNodes) || []), []));
    if (JSON.stringify(actual) !== expect) problems.push(`unlock ${t}: 累积 aiNodes 应为 09-unlock §1 的 11/14/17/17/19 增量（${expect}）`);
    // 与三表 unlockTier 交叉一致
    const roleIdsOfTier = new Set(tables.roles.filter((r) => r.unlockTier === t || (r.unlockTier === undefined && t === 'common')).map((r) => r.id));
    const skillIdsOfTier = new Set(tables.skills.filter((s) => s.unlockTier === t || (s.unlockTier === undefined && t === 'common')).map((s) => s.id));
    const uRoles = new Set(byTier[t].roleTemplates || []);
    const uSkills = new Set(byTier[t].skills || []);
    for (const id of roleIdsOfTier) if (!uRoles.has(id)) problems.push(`unlock ${t}: 角色 ${id} 的 unlockTier 未登记`);
    for (const id of uRoles) if (!roleIdsOfTier.has(id)) problems.push(`unlock ${t}: 登记了角色 ${id} 但表内 unlockTier 不符`);
    for (const id of skillIdsOfTier) if (!uSkills.has(id)) problems.push(`unlock ${t}: 技能 ${id} 的 unlockTier 未登记`);
    for (const id of uSkills) if (!skillIdsOfTier.has(id)) problems.push(`unlock ${t}: 登记了技能 ${id} 但表内 unlockTier 不符`);
  }
  if (tables.unlock.unlocks.length !== 5) problems.push(`unlock 应 5 段位`);

  // assets（P0-9 占位表）：sprites 交叉一致 + 形状枚举；animations 帧规格
  const sp = tables.sprites;
  const roleIdSet = new Set(tables.roles.map((r) => r.id));
  const skillIdSet = new Set(tables.skills.map((s) => s.id));
  const idSetOf = (list, key) => new Set(list.map((x) => x[key]));
  if (!['pixel-placeholder-v1'].includes(sp.format)) problems.push(`sprites.format 应为 pixel-placeholder-v1`);
  if (!isInt(sp.tileSize) || sp.tileSize <= 0 || !isInt(sp.iconSize) || sp.iconSize <= 0) problems.push('sprites.tileSize/iconSize 正整数');
  if (!sp.palette || !COLOR_RE.test(sp.palette.outline || '')) problems.push('sprites.palette.outline 应为 #rrggbb');
  for (const t of TIERS) {
    const c = sp.palette && sp.palette.quality && sp.palette.quality[t];
    const q = tables.qualities.qualities.find((x) => x.id === t);
    if (!c || !COLOR_RE.test(c)) problems.push(`sprites.palette.quality.${t} 缺失或非 #rrggbb`);
    else if (q && c !== q.color) problems.push(`sprites.palette.quality.${t}(${c}) 应与 qualities.${t}.color(${q.color}) 一致`);
  }
  const expectIds = (actual, expected, label, key, shapes, shapeList) => {
    const a = idSetOf(actual, key);
    const diff = [...a].filter((x) => !expected.has(x));
    const missing = [...expected].filter((x) => !a.has(x));
    if (diff.length || missing.length) problems.push(`${label} 与数据表交叉不一致（多余: ${diff.join(',')} / 缺失: ${missing.join(',')}）`);
    for (const item of actual) {
      if (!COLOR_RE.test(item.color || '')) problems.push(`${label} ${item[key]} 颜色非 #rrggbb`);
      if (shapes && !shapeList.includes(item.shape)) problems.push(`${label} ${item[key]} 形状 ${item.shape} 不在枚举 ${shapeList.join('/')}`);
    }
    if (actual.length !== expected.size) problems.push(`${label} 条数应为 ${expected.size}，实际 ${actual.length}`);
  };
  expectIds(sp.roleTemplates, roleIdSet, 'sprites.roleTemplates', 'templateId', true, ASSET_SHAPES.roleTemplate);
  expectIds(sp.skillTemplates, skillIdSet, 'sprites.skillTemplates', 'templateId', true, ASSET_SHAPES.skillTemplate);
  const rolePluginIds = new Set(tables.plugins.filter((p) => p.kind === 'rolePlugin').map((p) => p.id));
  const skillPluginIds = new Set(tables.plugins.filter((p) => p.kind === 'skillPlugin').map((p) => p.id));
  expectIds(sp.rolePlugins, rolePluginIds, 'sprites.rolePlugins', 'pluginId', true, ASSET_SHAPES.rolePlugin);
  expectIds(sp.skillPlugins, skillPluginIds, 'sprites.skillPlugins', 'pluginId', true, ASSET_SHAPES.skillPlugin);

  const an = tables.animations;
  if (an.format !== 'placeholder-v1') problems.push('animations.format 应为 placeholder-v1');
  for (const group of ['role', 'bullet', 'base']) {
    if (!an.animations || !an.animations[group]) { problems.push(`animations.${group} 缺失`); continue; }
    const anims = an.animations[group];
    if (group === 'role') {
      for (const n of BASE_ANIMS) {
        if (!anims[n]) problems.push(`animations.role.${n} 必填（基础动画六件套）`);
      }
    }
    for (const [name, a] of Object.entries(anims)) {
      if (!isInt(a.frames) || a.frames < 1) problems.push(`animations.${group}.${name}.frames 应为 ≥1 整数`);
      if (!isNum(a.durationMs) || a.durationMs <= 0) problems.push(`animations.${group}.${name}.durationMs 应为正数`);
      if (typeof a.loop !== 'boolean') problems.push(`animations.${group}.${name}.loop 应为布尔`);
      if (!Array.isArray(a.offsetPx) || a.offsetPx.length !== 2 || !a.offsetPx.every(isInt)) problems.push(`animations.${group}.${name}.offsetPx 应为 2 元素整数数组`);
    }
  }

  // ---------- 机制表完整性（2026-09-16 新增） ----------
  // 目的：内容层（role/skill/plugins/qualities/items-config/unlock）引用的每个词条 id、技能类型、
  //   节点权限都必须在机制层登记，否则运行期会"静默失效"（词条被跳过 / 类型抛错 / 编辑器插入不可用节点）。
  //   机制层 = affix-registry.json / skill-mechanics.json / ai-nodes.json；其词汇表自描述（_opVocabulary 等）。
  const EMIT_PATTERNS = ['cellsFromRange', 'repeatCount', 'impactCells', 'pathCells']; // 镜像 server/core/skills.js 的 EMITTERS 键
  const PARAM_MODES = ['pair', 'intMin', 'copy'];
  try {
    const reg = loadJSON(dataDir, 'affix-registry.json').data;
    const mech = loadJSON(dataDir, 'skill-mechanics.json').data;
    const aiNodes = loadJSON(dataDir, 'ai-nodes.json').data;
    const affixes = reg.affixes || {};
    const OPS = reg._opVocabulary || [];
    const HIT_KINDS = reg._hitKindVocabulary || [];
    const CAST_KINDS = reg._castKindVocabulary || [];
    // ① 内容表引用的词条必须登记
    for (const p of tables.plugins || []) {
      for (const a of p.affixes || []) {
        if (!affixes[a.id]) problems.push(`plugins.${p.id}: 词条 ${a.id} 未登记（affix-registry.json）`);
      }
    }
    // ② 注册表自身自洽
    for (const [id, def] of Object.entries(affixes)) {
      const destinations = ['agg', 'special', 'regen', 'skillOp', 'hitEffect', 'castEffect'].filter((k) => def[k] !== undefined);
      if (destinations.length === 0) problems.push(`affix-registry.${id}: 未声明去向（agg/special/regen/skillOp/hitEffect/castEffect 至少一个）`);
      if (def.roll !== undefined && !['int', 'stat'].includes(def.roll)) problems.push(`affix-registry.${id}: roll 非法 ${def.roll}`);
      if (def.agg && !['pct', 'flat'].includes(def.agg.mode)) problems.push(`affix-registry.${id}: agg.mode 非法 ${def.agg.mode}`);
      if (def.skillOp && !OPS.includes(def.skillOp.op)) problems.push(`affix-registry.${id}: skillOp.op ${def.skillOp.op} 未登记（_opVocabulary）`);
      if (def.hitEffect && !HIT_KINDS.includes(def.hitEffect.kind)) problems.push(`affix-registry.${id}: hitEffect.kind ${def.hitEffect.kind} 未登记`);
      if (def.castEffect && !CAST_KINDS.includes(def.castEffect.kind)) problems.push(`affix-registry.${id}: castEffect.kind ${def.castEffect.kind} 未登记`);
    }
    // ③ 技能模板类型必须在类型机制表登记；机制表自洽
    for (const s of tables.skills || []) {
      if (!mech.types || !mech.types[s.type]) problems.push(`skill-templates.${s.id}: 类型 ${s.type} 未登记（skill-mechanics.json）`);
    }
    for (const [type, def] of Object.entries(mech.types || {})) {
      for (const [field, mode] of Object.entries(def.params || {})) {
        if (!PARAM_MODES.includes(mode)) problems.push(`skill-mechanics.types.${type}.params.${field}: 滚动模式非法 ${mode}`);
      }
      if (def.emit && !EMIT_PATTERNS.includes(def.emit.pattern)) problems.push(`skill-mechanics.types.${type}.emit.pattern ${def.emit.pattern} 未登记（EMITTERS）`);
      for (const [slot, target] of Object.entries(def.slots || {})) {
        if (typeof target !== 'string') problems.push(`skill-mechanics.types.${type}.slots.${slot}: 必须映射到字段名字符串`);
      }
    }
    // ④ AI 节点与段位权限
    const nodeSet = new Set(aiNodes.nodes || []);
    for (const b of aiNodes.base || []) if (!nodeSet.has(b)) problems.push(`ai-nodes.base.${b} 不在 nodes 清单中`);
    if (!Array.isArray(aiNodes.actions && aiNodes.actions.fixed) || aiNodes.actions.fixed.length === 0) problems.push('ai-nodes.actions.fixed 缺失或为空（引擎动作词汇表）');
    const perms = (tables.unlock && tables.unlock.nodePermissions) || {};
    for (const u of (tables.unlock && tables.unlock.unlocks) || []) {
      for (const perm of u.aiNodes || []) {
        if (!nodeSet.has(perm) && !perms[perm]) problems.push(`unlock.${u.tier}: 权限/节点 ${perm} 既不是真实节点也未在 nodePermissions 登记`);
      }
    }
    for (const [perm, decl] of Object.entries(perms)) {
      for (const g of decl.grants || []) if (!nodeSet.has(g)) problems.push(`unlock.nodePermissions.${perm}: 授予了不存在的节点 ${g}`);
      if (decl.implemented === false && Array.isArray(decl.grants) && decl.grants.length > 0) problems.push(`unlock.nodePermissions.${perm}: implemented=false 不得授予节点`);
    }
  } catch (e) {
    problems.push(`机制表（affix-registry/skill-mechanics/ai-nodes）加载失败: ${e.message}`);
  }

  return problemsOf(problems);
}

// ---------- T-DC-2：items-data 文档 ↔ 数据表逐条对齐 ----------

function validateConsistency(dataDir) {
  const problems = [];
  let roles;
  let skills;
  let qualities;
  let plugins;
  let sampleMode = false;
  try {
    const rawRoles = loadJSON(dataDir, 'role-templates.json').data;
    const rawSkills = loadJSON(dataDir, 'skill-templates.json').data;
    const rawQualities = loadJSON(dataDir, 'qualities.json').data;
    const rawPlugins = loadJSON(dataDir, 'plugins.json').data;
    roles = rawRoles.roleTemplates;
    skills = rawSkills.skillTemplates;
    qualities = rawQualities.qualities;
    plugins = rawPlugins.plugins;
    // 示例内容标记（2026-09-16）：内容层表标 `_sample: true` 时按"示例期望表"逐值比对；
    //   用户正式设计内容后去掉标记（或改标记），则只做结构 + 机制完整性校验，不阻塞正式内容。
    sampleMode = [rawRoles, rawSkills, rawQualities, rawPlugins].some((t) => t && t._sample === true);
  } catch (e) {
    return { ok: false, detail: `T-DC-2 表读取失败: ${e.message}` };
  }
  if (!sampleMode) {
    return { ok: true, detail: '非示例内容（未标 _sample）：跳过示例期望表逐值比对（结构与机制完整性仍由 T-DC-1 校验）' };
  }

  const byId = (list) => Object.fromEntries(list.map((x) => [x.id, x]));
  const roleMap = byId(roles);
  const skillMap = byId(skills);
  for (const [id, name, type] of ROLE_EXPECTED) {
    const r = roleMap[id];
    if (!r) { problems.push(`items-data §3 的 ${id} 缺失`); continue; }
    if (r.name !== name || r.type !== type) problems.push(`${id}: 名称/类型应为 ${name}/${type}`);
  }
  for (const [id, name, type, mult, cost, cd, level, params, tier] of SKILL_EXPECTED) {
    const s = skillMap[id];
    if (!s) { problems.push(`items-data §4 的 ${id} 缺失`); continue; }
    if (s.name !== name || s.type !== type) problems.push(`${id}: 名称/类型应为 ${name}/${type}`);
    if (s.baseMultiplier !== mult) problems.push(`${id}: baseMultiplier 应为 ${mult}`);
    if (s.baseCost.mp !== cost.mp || s.baseCost.sp !== cost.sp || s.baseCost.hp !== 0) problems.push(`${id}: baseCost 应为 {hp:0,mp:${cost.mp},sp:${cost.sp}}`);
    if (s.cooldown !== cd || s.bulletLevel !== level) problems.push(`${id}: cooldown/bulletLevel 应为 ${cd}/${level}`);
    if (s.unlockTier !== tier) problems.push(`${id}: unlockTier 应为 ${tier}`);
    for (const [k, v] of Object.entries(params)) {
      if (JSON.stringify(s[k]) !== JSON.stringify(v)) problems.push(`${id}: ${k} 应为 ${JSON.stringify(v)}`);
    }
  }
  for (const [id, name, color, statRange, roleSlot, skillSlot] of QUALITY_EXPECTED) {
    const q = qualities.find((x) => x.id === id);
    if (!q) { problems.push(`items-data §2 的品质 ${id} 缺失`); continue; }
    if (q.name !== name || q.color !== color) problems.push(`${id}: 名称/颜色应为 ${name}/${color}`);
    if (JSON.stringify(q.statRange) !== JSON.stringify(statRange)) problems.push(`${id}: statRange 应为 ${JSON.stringify(statRange)}`);
    if (JSON.stringify(q.roleSlotRange) !== JSON.stringify(roleSlot) || JSON.stringify(q.skillSlotRange) !== JSON.stringify(skillSlot)) problems.push(`${id}: 插槽区间不符`);
  }
  const pluginMap = byId(plugins);
  for (const [id, slot, category, v] of PLUGIN_EXPECTED) {
    const p = pluginMap[id];
    if (!p) { problems.push(`items-data §5/§6 的 ${id} 缺失`); continue; }
    if (p.slot !== slot || p.category !== category) problems.push(`${id}: slot/category 应为 ${slot}/${category}`);
    if (!p.affixes || !p.affixes[0] || p.affixes[0].params.v !== v) {
      problems.push(`${id}: 词条基础值 v 应为 ${v}（items-data 表列）`);
    }
    if (id === 'sp_buff' && (!p.affixes[0] || p.affixes[0].params.duration !== 2)) {
      problems.push(`${id}: 释放增益 duration 应为 2`);
    }
  }
  const expectedCount = { role: 0, skill: 0 };
  for (const [id] of PLUGIN_EXPECTED) {
    const p = pluginMap[id];
    if (p) expectedCount[p.kind === 'skillPlugin' ? 'skill' : 'role']++;
  }
  if (expectedCount.role !== 14 || expectedCount.skill !== 15) problems.push(`插件应为 14 角色 + 15 技能，期望表中 ${expectedCount.role}+${expectedCount.skill}`);

  return problemsOf(problems);
}

function validate(dataDir) {
  const a = validateStructure(dataDir);
  const b = validateConsistency(dataDir);
  if (!a.ok) return a;
  if (!b.ok) return b;
  return { ok: true, detail: 'T-DC-1/2 全部通过' };
}

module.exports = { validateStructure, validateConsistency, validate };