'use strict';
/* server/data/schema.js —— 数据表校验器（P0-6，T-DC-1 结构 + T-DC-2 items-data 一致性）
 * 契约：server/data/README.md；被 scripts/gate.js 项 4（validateStructure）与项 5（validateConsistency）调用。
 *
 * 2026-09-16 用户拍板 A —— **只校验结构与机制自洽，不锁内容数量**：
 *   · 删除具体数量期望（角色 11 / 技能 10 / 插件 14+15 / 品质 5 / sprites 条数 …），改为"至少 1 项"；
 *   · 数值期望表（ROLE_EXPECTED / SKILL_EXPECTED / QUALITY_EXPECTED / PLUGIN_EXPECTED）与 T-DC-2
 *     **仅当对应内容表带 `_sample: true` 时**才逐值比对（示例数据语义）；去掉 `_sample`
 *     （或某表去掉）后该表只做结构与机制校验，用户改表即扩展，门禁不再因增删条目失败；
 *   · 技能 `type` / 插件词条 id / AI 权限名 一律以**机制层表**为准（skill-mechanics.json /
 *     affix-registry.json / ai-nodes.json），代码不另立清单、不硬编码节点数量。
 * 冻结数值仍逐值校验：battle-config（D-117）、typeModifiers（B5/D-…）、品质 tiers 三等分与
 *   costDeltaBase（D-113/D-116）——这些是**机制数值**，不是内容条目数量。
 * 产物：validateStructure(dataDir) / validateConsistency(dataDir) / validate(dataDir) → {ok, detail}
 * P0-9：assets/ 占位表（sprites/animations）纳入 T-DC-1 校验范围（dataDir 的兄弟目录，经 API 作为数据表提供）。
 */
const fs = require('node:fs');
const path = require('node:path');

// ---------- P7 冲刺决策在数据层的落点登记（2026-09-16，D-137…D-153） ----------
// 用途：gate 项 5 子 A（T-DC-8）要求 decisions.md 的每条 D 编号在 `docs/interfaces.md` **或数据表文本**中
//   可检索。本块是**数据层侧的落点清单**（形如 D-xxx）；interfaces.md §6 的 D 落点表由接口冻结维护者同步补行。
//   逐条口径（决策正文只在 docs/decisions.md §14，此处不重复、不新增语义）：
//   D-137 段位门控总开关 gating.enabled（unlock.json；默认关闭、逻辑与字段保留）→ 本目录 unlock.json + core/unlock.js
//   D-138 AI 语言删除 bullets 节点与 bullets[i].* 路径，快照不投影 bullets（设计）→ ai-nodes.json
//   D-139 random 双语义（语句位分支 / 表达式位布尔，消费每 tick ai 流）→ ai-nodes.json + ai/runtime.js
//   D-140 aiTrace 每 tick 上限 2000（非整场累计）→ ai-nodes.json 契约 + server/battle.js
//   D-141 超时扣血：基地按自身 maxHp、角色按角色 maxHp → battle-config.json
//   D-142 typeModifiers 接入开箱生成路径 → role-templates.json + core/items.js
//   D-143 掉落/解锁完全由 JSON 配置（drop/dropWeight/unlockTier 每项自带）→ 本目录各内容表
//   D-144 本文件只校验结构与机制自洽（不锁内容条目数量）；`_sample: true` 仅控示例期望表逐值比对
//   D-145 校验期硬化四类（get.path 白名单/变量先声明/表达式位/必含 action）+ 运行层兜底→ ai-nodes.json
//   D-146 非法动作名走 warnings（不拒绝，D-80）；/ai/validate|compile 响应带 data.warnings → ai-nodes.json actions
//   D-147 快照字段补齐与 baseHp 语义（＝基地当前血量）→ 本目录 schema.js 冻结清单无涉，落 server/runner.js 投影
//   D-148 /ai/battle 回报 actionsEffective / ineffectiveActions / frames[].actions|events → ai-nodes.json actions
//   D-149 面板聚合单一实现（items.buildRolePanel；regen 只叠一次）→ qualities.json + 本目录
//   D-150 只补黄金战斗回归（不补空 contract/property 目录）+ 阶段级代码审查 + 测试冗余/缺口审查 → tests/
//   D-151 npm run play 离线闭环 + cli replay 伤害/暴击/背击标注 → scripts/play.js（数据侧无落点）
//   D-152 真实玩家匹配，禁止占位 bot 充数（池不足回报 shortfall）→ 计划落 server/ranked.js（P7-3）
//   D-153 安全登记册只登记不修复；被顺手修掉的条目更新证据与状态 → docs/security-backlog.md
const TIERS = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const TIER_SEQ = Object.fromEntries(TIERS.map((t, i) => [t, i]));

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// 动画基础六件套（role 组必填；其余动画与形状枚举一律允许扩展——2026-09-16 起不再锁条数/枚举）
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

// ---------- P7 服务参数与积分配置的冻结数值（D-129 §11.3 / D-133 §8.3） ----------
// 原则"机制在代码、数值在表"：两张表的**数值单一来源是 JSON**，代码侧 server/store/config.js 只保留
// 同值默认值（表缺失时的兜底）。此处逐值冻结比对，防止"改了表没改默认值 / 改了默认值没改表"的双源漂移
// （与 battle-config 的 BATTLE_CONFIG_FROZEN 同一手法）。键集也校验：表内出现未登记键即报错。
const SERVICE_CONFIG_FROZEN = Object.freeze({
  auth: {
    scrypt: { N: 16384, r: 8, p: 1 },
    saltBytes: 16,
    hashBytes: 64,
    usernameMin: 3,
    usernameMax: 24,
    nicknameMax: 16,
    passwordMin: 8,
    passwordMax: 72,
    passwordMaxBytes: 256,
    maxFailures: 5,
    lockMinutes: 5,
    rateLimitPerMinute: 10,
  },
  session: { ttlDays: 7, maxPerPlayer: 5, maxTotalDays: 30 },
  config: { maxSlots: 3, slotIdPrefix: 'slot' },
  record: { recentLimit: 100 },
  store: { archiveCacheSize: 200, snapshotCacheSize: 500 },
  journal: { fsyncMode: 'batch', compactAfterDays: 30, bufferBytes: 1048576 },
  snapshot: { retentionDays: 90 },
  replayCacheSize: 64,
  pool: { ttlDays: 0, opponentCooldownHours: 24 },
});

const RATING_CONFIG_FROZEN = Object.freeze({
  base: 0,
  cap: 3000,
  scale: 400,
  kBase: 32,
  kMin: 8,
  kMax: 64,
  drawFactor: 0.5,
  matchWindowStart: 100,
  matchWindowStep: 100,
  matchWindowMax: 600,
  opponentCooldownHours: 24,
  dailyBattleLimit: 0,
  rounding: 'half_up',
  promoteWins: 6,
  batchSize: 10,
});

// 深比较：返回首个差异的路径描述（无差异 → null）；元数据键（`_note`/`_sample`/…）由调用方过滤，不参与比对
function firstDiff(actual, expected, prefix) {
  const path0 = prefix || '';
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return `${path0 || '<root>'} 应为对象`;
    for (const key of Object.keys(expected)) {
      const sub = firstDiff(actual[key], expected[key], path0 === '' ? key : `${path0}.${key}`);
      if (sub) return sub;
    }
    return null;
  }
  return actual === expected ? null : `${path0 || '<root>'} = ${JSON.stringify(actual)}，应为 ${JSON.stringify(expected)}`;
}

// ---------- T-DC-2 items-data 期望表（出处：items-data.md §3/§4/§2/§5/§6） ----------
// 语义（2026-09-16 补完）：这些**示例期望**仅在对应内容表带 `_sample: true` 时逐值比对；
//   用户正式设计内容后去掉标记 → 该表只走 T-DC-1 的结构与机制校验。

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
  // 机制层表（机制词汇的单一来源）：内容层的 type / 词条 / AI 权限名自洽校验全部以它们为准，
  //   本文件**不再硬编码**类型清单、词条 id、AI 节点数量（2026-09-16 拍板 A）。
  let mechTables = null;
  try {
    mechTables = {
      registry: loadJSON(dataDir, 'affix-registry.json').data,
      mechanics: loadJSON(dataDir, 'skill-mechanics.json').data,
      aiNodes: loadJSON(dataDir, 'ai-nodes.json').data,
    };
  } catch (e) { problems.push(`机制表（affix-registry/skill-mechanics/ai-nodes）加载失败: ${e.message}`); }
  // P7 服务参数/积分配置（D-129 §11.3 / D-133 §8.3）：存储层与匹配层运行期读取的数值表
  try {
    tables.serviceConfig = loadJSON(dataDir, 'service-config.json').data;
  } catch (e) { problems.push(`service-config.json 缺失或解析失败: ${e.message}`); }
  try {
    tables.ratingConfig = loadJSON(dataDir, 'rating-config.json').data;
  } catch (e) { problems.push(`rating-config.json 缺失或解析失败: ${e.message}`); }
  if (problems.length > 0) return problemsOf(problems);
  const MECH_TYPES = (mechTables && mechTables.mechanics && mechTables.mechanics.types) || {};

  // 内容条目通用字段：drop（是否进掉落池）/ dropWeight（同类池内相对权重）——缺省 true / 1
  const checkDropFields = (item, label) => {
    if (item.drop !== undefined && typeof item.drop !== 'boolean') problems.push(`${label}: drop 必须是布尔（是否进入掉落池）`);
    if (item.dropWeight !== undefined && (!isNum(item.dropWeight) || item.dropWeight <= 0)) problems.push(`${label}: dropWeight 必须是正数（同类池内相对权重）`);
  };

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
    checkDropFields(r, r.id);
  }
  if (tables.roles.length < 1) problems.push('角色模板表为空（至少 1 项；数量不再锁定，items-data §3 仅为示例）');

  // skill-templates（无 bulletSpeed / 类型参数 / falloff / bulletLevel 1..4）
  //   类型**不再硬编码**：只要求已在 skill-mechanics.json 的 types 登记（机制自洽；加类型 = 只改机制表）。
  const skillIds = new Set();
  for (const s of tables.skills) {
    if (skillIds.has(s.id)) problems.push(`技能模板 id 重复: ${s.id}`);
    skillIds.add(s.id);
    if ('bulletSpeed' in s) problems.push(`${s.id}: 出现已删除字段 bulletSpeed（D-21）`);
    if (!MECH_TYPES[s.type]) problems.push(`${s.id}: type 非法 ${s.type}（未在 skill-mechanics.json 的 types 登记）`);
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
    checkDropFields(s, s.id);
  }
  if (tables.skills.length < 1) problems.push('技能模板表为空（至少 1 项；数量不再锁定，items-data §4 仅为示例）');

  // plugins（D-113 costDeltaByTier / D-114 一个变体一个 id）
  const pluginIds = new Set();
  const costDeltaShape = (cd) => cd === null
    || (typeof cd === 'object' && cd !== null
      && Object.keys(cd).length >= 1 && Object.keys(cd).every((k) => ['hp', 'mp', 'sp'].includes(k))
      && Object.values(cd).every((arr) => Array.isArray(arr) && arr.length === 3 && arr.every(isNum)));
  for (const p of tables.plugins) {
    if (pluginIds.has(p.id)) problems.push(`插件 id 重复: ${p.id}`);
    pluginIds.add(p.id);
    if (p.kind === 'rolePlugin') {
      if (!['atk', 'def', 'hp', 'sp', 'mp', 'special'].includes(p.slot)) problems.push(`${p.id}: rolePlugin 槽位非法`);
      if (!Array.isArray(p.pointCostByTier) || JSON.stringify(p.pointCostByTier) !== JSON.stringify([1, 2, 3])) problems.push(`${p.id}: pointCostByTier 应 [1,2,3]（D-113）`);
    } else if (p.kind === 'skillPlugin') {
      if (!['basic', 'special'].includes(p.slot)) problems.push(`${p.id}: skillPlugin 槽位非法`);
      if (!costDeltaShape(p.costDeltaByTier)) problems.push(`${p.id}: costDeltaByTier 应逐档数组或 null（D-113）`);
    } else {
      problems.push(`${p.id}: kind 非法 ${p.kind}`);
    }
    if (!p.name || !p.desc || !Array.isArray(p.affixes) || p.affixes.length === 0) problems.push(`${p.id}: name/desc/affixes 必填`);
    if (p.unlockTier !== undefined && !(p.unlockTier in TIER_SEQ)) problems.push(`${p.id}: unlockTier 非法`);
    checkDropFields(p, p.id);
  }
  if (tables.plugins.length < 1) problems.push('插件表为空（至少 1 项；数量不再锁定，items-data §5/§6 仅为示例）');

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
  if (tables.qualities.qualities.length < 1) problems.push('品质表为空（至少 1 项；数量不再锁定）');
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

  // unlock（段位齐全 + 条目结构 + 与两表 unlockTier 交叉一致）
  //   2026-09-16：**删除 AI 节点累计数量/增量表核对**（不再硬编码 11/14/17/17/19 或 AI_BASE_NODES）；
  //   权限名合法性改由机制层 ai-nodes.json 判定（见下"④ AI 节点与段位权限"）。
  const byTier = Object.fromEntries(tables.unlock.unlocks.map((u) => [u.tier, u]));
  for (const u of tables.unlock.unlocks) {
    if (!(u.tier in TIER_SEQ)) problems.push(`unlock 段位非法: ${u.tier}`);
    if (!Array.isArray(u.aiNodes)) problems.push(`unlock ${u.tier}: aiNodes 必须是数组`);
    if (!Array.isArray(u.roleTemplates)) problems.push(`unlock ${u.tier}: roleTemplates 必须是数组`);
    if (!Array.isArray(u.skills)) problems.push(`unlock ${u.tier}: skills 必须是数组`);
  }
  for (const t of TIERS) {
    if (!byTier[t]) { problems.push(`unlock 缺段位 ${t}`); continue; }
    // 与两表 unlockTier 交叉一致（防双源漂移：改表必须同步登记，或反之）
    const roleIdsOfTier = new Set(tables.roles.filter((r) => r.unlockTier === t || (r.unlockTier === undefined && t === 'common')).map((r) => r.id));
    const skillIdsOfTier = new Set(tables.skills.filter((s) => s.unlockTier === t || (s.unlockTier === undefined && t === 'common')).map((s) => s.id));
    const uRoles = new Set(byTier[t].roleTemplates || []);
    const uSkills = new Set(byTier[t].skills || []);
    for (const id of roleIdsOfTier) if (!uRoles.has(id)) problems.push(`unlock ${t}: 角色 ${id} 的 unlockTier 未登记`);
    for (const id of uRoles) if (!roleIdsOfTier.has(id)) problems.push(`unlock ${t}: 登记了角色 ${id} 但表内 unlockTier 不符`);
    for (const id of skillIdsOfTier) if (!uSkills.has(id)) problems.push(`unlock ${t}: 技能 ${id} 的 unlockTier 未登记`);
    for (const id of uSkills) if (!skillIdsOfTier.has(id)) problems.push(`unlock ${t}: 登记了技能 ${id} 但表内 unlockTier 不符`);
  }

  // assets（P0-9 占位表）：sprites 逐条结构校验；**允许多余条目、不再锁形状枚举与条数**
  //   （2026-09-16 拍板 A：新增模板/形状只改表即可；缺失占位不阻塞——占位素材是表现层，不是机制）
  const sp = tables.sprites;
  if (!['pixel-placeholder-v1'].includes(sp.format)) problems.push(`sprites.format 应为 pixel-placeholder-v1`);
  if (!isInt(sp.tileSize) || sp.tileSize <= 0 || !isInt(sp.iconSize) || sp.iconSize <= 0) problems.push('sprites.tileSize/iconSize 正整数');
  if (!sp.palette || !COLOR_RE.test(sp.palette.outline || '')) problems.push('sprites.palette.outline 应为 #rrggbb');
  for (const t of TIERS) {
    const c = sp.palette && sp.palette.quality && sp.palette.quality[t];
    const q = tables.qualities.qualities.find((x) => x.id === t);
    if (!c || !COLOR_RE.test(c)) problems.push(`sprites.palette.quality.${t} 缺失或非 #rrggbb`);
    else if (q && c !== q.color) problems.push(`sprites.palette.quality.${t}(${c}) 应与 qualities.${t}.color(${q.color}) 一致`);
  }
  const checkAssetList = (list, label, key) => {
    if (!Array.isArray(list)) { problems.push(`${label} 缺失或非数组`); return; }
    const seen = new Set();
    for (const item of list) {
      const id = item && item[key];
      if (typeof id !== 'string' || id === '') { problems.push(`${label} 条目缺 ${key}`); continue; }
      if (seen.has(id)) problems.push(`${label} ${id} 重复`);
      seen.add(id);
      if (!COLOR_RE.test((item && item.color) || '')) problems.push(`${label} ${id} 颜色非 #rrggbb`);
      if (typeof item.shape !== 'string' || item.shape === '') problems.push(`${label} ${id} 形状缺失（shape 必须是非空字符串；形状枚举不再锁定）`);
    }
  };
  checkAssetList(sp.roleTemplates, 'sprites.roleTemplates', 'templateId');
  checkAssetList(sp.skillTemplates, 'sprites.skillTemplates', 'templateId');
  checkAssetList(sp.rolePlugins, 'sprites.rolePlugins', 'pluginId');
  checkAssetList(sp.skillPlugins, 'sprites.skillPlugins', 'pluginId');

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

  // ---------- 机制表完整性（2026-09-16 新增；拍板 A 后成为**唯一的类型/词条/权限判据**） ----------
  // 目的：内容层（role/skill/plugins/qualities/items-config/unlock）引用的每个词条 id、技能类型、
  //   节点权限都必须在机制层登记，否则运行期会"静默失效"（词条被跳过 / 类型抛错 / 编辑器插入不可用节点）。
  //   机制层 = affix-registry.json / skill-mechanics.json / ai-nodes.json；其词汇表自描述（_opVocabulary 等）。
  const EMIT_PATTERNS = ['cellsFromRange', 'repeatCount', 'impactCells', 'pathCells']; // 镜像 server/core/skills.js 的 EMITTERS 键
  const PARAM_MODES = ['pair', 'intMin', 'copy'];
  if (mechTables) {
    const reg = mechTables.registry;
    const mech = mechTables.mechanics;
    const aiNodes = mechTables.aiNodes;
    const affixes = reg.affixes || {};
    const OPS = reg._opVocabulary || [];
    const HIT_KINDS = reg._hitKindVocabulary || [];
    const CAST_KINDS = reg._castKindVocabulary || [];
    // ① 内容表引用的词条必须登记
    for (const p of tables.plugins || []) {
      for (const a of (p && p.affixes) || []) {
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
    // ③ 类型机制表自身自洽（技能模板 type 的登记校验在内容层循环内完成：未登记即 type 非法）
    for (const [type, def] of Object.entries(mech.types || {})) {
      for (const [field, mode] of Object.entries(def.params || {})) {
        if (!PARAM_MODES.includes(mode)) problems.push(`skill-mechanics.types.${type}.params.${field}: 滚动模式非法 ${mode}`);
      }
      if (def.emit && !EMIT_PATTERNS.includes(def.emit.pattern)) problems.push(`skill-mechanics.types.${type}.emit.pattern ${def.emit.pattern} 未登记（EMITTERS）`);
      for (const [slot, target] of Object.entries(def.slots || {})) {
        if (typeof target !== 'string') problems.push(`skill-mechanics.types.${type}.slots.${slot}: 必须映射到字段名字符串`);
      }
    }
    // ④ AI 节点与段位权限（以 ai-nodes.json 为唯一节点清单；不硬编码节点数量）
    const nodeSet = new Set(aiNodes.nodes || []);
    for (const b of aiNodes.base || []) if (!nodeSet.has(b)) problems.push(`ai-nodes.base.${b} 不在 nodes 清单中`);
    if (!Array.isArray(aiNodes.actions && aiNodes.actions.fixed) || aiNodes.actions.fixed.length === 0) problems.push('ai-nodes.actions.fixed 缺失或为空（引擎动作词汇表）');
    const perms = (tables.unlock && tables.unlock.nodePermissions) || {};
    for (const u of (tables.unlock && tables.unlock.unlocks) || []) {
      for (const perm of (Array.isArray(u.aiNodes) ? u.aiNodes : [])) {
        if (!nodeSet.has(perm) && !perms[perm]) problems.push(`unlock.${u.tier}: 权限/节点 ${perm} 既不是真实节点也未在 nodePermissions 登记`);
      }
    }
    for (const [perm, decl] of Object.entries(perms)) {
      for (const g of decl.grants || []) if (!nodeSet.has(g)) problems.push(`unlock.nodePermissions.${perm}: 授予了不存在的节点 ${g}`);
      if (decl.implemented === false && Array.isArray(decl.grants) && decl.grants.length > 0) problems.push(`unlock.nodePermissions.${perm}: implemented=false 不得授予节点`);
    }
  }

  // ---------- P7 服务参数表：键集 + 类型/范围 + 冻结数值（D-129 §11.3；interfaces §4.12） ----------
  {
    const sc = tables.serviceConfig;
    const unknownKeys = Object.keys(sc).filter((k) => !k.startsWith('_') && !(k in SERVICE_CONFIG_FROZEN));
    for (const k of unknownKeys) problems.push(`service-config 未登记键 ${k}（键集以 SERVICE_CONFIG_FROZEN 为准）`);
    const diff = firstDiff(sc, SERVICE_CONFIG_FROZEN);
    if (diff) problems.push(`service-config 冻结数值不符：${diff}（D-129 §11.3）`);
    const a = sc.auth || {};
    const scr = a.scrypt || {};
    if (!isInt(scr.N) || scr.N < 1024) problems.push('service-config.auth.scrypt.N 应为 ≥1024 的整数（算力下限；默认 16384）');
    if (!isInt(scr.r) || scr.r < 1) problems.push('service-config.auth.scrypt.r 应为 ≥1 的整数');
    if (!isInt(scr.p) || scr.p < 1) problems.push('service-config.auth.scrypt.p 应为 ≥1 的整数');
    if (!isInt(a.usernameMin) || !isInt(a.usernameMax) || a.usernameMin < 1 || a.usernameMax < a.usernameMin) problems.push('service-config.auth.usernameMin/Max 非法（1 ≤ min ≤ max）');
    if (!isInt(a.passwordMin) || !isInt(a.passwordMax) || a.passwordMin < 1 || a.passwordMax < a.passwordMin) problems.push('service-config.auth.passwordMin/Max 非法（1 ≤ min ≤ max）');
    if (!isInt(a.nicknameMax) || a.nicknameMax < 1) problems.push('service-config.auth.nicknameMax 应为正整数');
    if (!isInt(a.maxFailures) || a.maxFailures < 1) problems.push('service-config.auth.maxFailures 应为正整数');
    if (!isNum(a.lockMinutes) || a.lockMinutes <= 0) problems.push('service-config.auth.lockMinutes 应为正数');
    if (!isNum(a.rateLimitPerMinute) || a.rateLimitPerMinute <= 0) problems.push('service-config.auth.rateLimitPerMinute 应为正数');
    const se = sc.session || {};
    if (!isNum(se.ttlDays) || se.ttlDays <= 0) problems.push('service-config.session.ttlDays 应为正数（会话 TTL）');
    if (!isInt(se.maxPerPlayer) || se.maxPerPlayer < 1) problems.push('service-config.session.maxPerPlayer 应为正整数（每人最多活跃会话数）');
    if (!isNum(se.maxTotalDays) || se.maxTotalDays < se.ttlDays) problems.push('service-config.session.maxTotalDays 应 ≥ ttlDays（滑动续期上限）');
    const conf = sc.config || {};
    if (!isInt(conf.maxSlots) || conf.maxSlots < 1 || conf.maxSlots > 3) problems.push('service-config.config.maxSlots 应为 1..3（D-131：最多 3 套配置槽）');
    if (typeof conf.slotIdPrefix !== 'string' || conf.slotIdPrefix === '') problems.push('service-config.config.slotIdPrefix 应为非空字符串');
    if (!isInt(sc.record && sc.record.recentLimit) || sc.record.recentLimit < 1) problems.push('service-config.record.recentLimit 应为正整数（战绩环形容量）');
    if (!isInt(sc.store && sc.store.archiveCacheSize) || sc.store.archiveCacheSize < 1) problems.push('service-config.store.archiveCacheSize 应为正整数');
    if (!isInt(sc.store && sc.store.snapshotCacheSize) || sc.store.snapshotCacheSize < 1) problems.push('service-config.store.snapshotCacheSize 应为正整数');
    const jr = sc.journal || {};
    if (!['batch', 'sync'].includes(jr.fsyncMode)) problems.push(`service-config.journal.fsyncMode 应为 batch|sync（实际 ${jr.fsyncMode}）`);
    if (!isNum(jr.compactAfterDays) || jr.compactAfterDays < 0) problems.push('service-config.journal.compactAfterDays 应为 ≥0 的数');
    if (!isInt(jr.bufferBytes) || jr.bufferBytes < 1024) problems.push('service-config.journal.bufferBytes 应为 ≥1024 的整数（group commit 阈值）');
    if (!isNum(sc.snapshot && sc.snapshot.retentionDays) || sc.snapshot.retentionDays < 0) problems.push('service-config.snapshot.retentionDays 应为 ≥0 的数');
    if (!isInt(sc.replayCacheSize) || sc.replayCacheSize < 1) problems.push('service-config.replayCacheSize 应为正整数（帧 LRU 上限）');
    const pl = sc.pool || {};
    // P2-8：`pool.ttlDays` 只做形状校验 —— 当前**无任何消费方**（参数已留、未启用，与 rating.dailyBattleLimit 同口径）
    if (!isNum(pl.ttlDays) || pl.ttlDays < 0) problems.push('service-config.pool.ttlDays 应为 ≥0 的数（0 = 池不过期；当前参数已留、未启用）');
    if (!isNum(pl.opponentCooldownHours) || pl.opponentCooldownHours < 0) problems.push('service-config.pool.opponentCooldownHours 应为 ≥0 的数');
  }

  // ---------- P7 积分配置表：键集 + 类型/范围 + 冻结数值（D-133 §8.3；D-122/D-136） ----------
  {
    const rc = tables.ratingConfig;
    const unknownKeys = Object.keys(rc).filter((k) => !k.startsWith('_') && !(k in RATING_CONFIG_FROZEN));
    for (const k of unknownKeys) problems.push(`rating-config 未登记键 ${k}（键集以 RATING_CONFIG_FROZEN 为准）`);
    const diff = firstDiff(rc, RATING_CONFIG_FROZEN);
    if (diff) problems.push(`rating-config 冻结数值不符：${diff}（D-133 §8.3）`);
    if (!isNum(rc.base) || rc.base < 0) problems.push('rating-config.base 应为 ≥0 的数（积分起点 D-133）');
    if (!isNum(rc.cap) || rc.cap <= 0) problems.push('rating-config.cap 应为正数（积分上限 D-133）');
    if (!isNum(rc.scale) || rc.scale <= 0) problems.push('rating-config.scale 应为正数（Elo 尺度）');
    if (!isNum(rc.kBase) || rc.kBase <= 0) problems.push('rating-config.kBase 应为正数');
    if (!isNum(rc.kMin) || rc.kMin <= 0) problems.push('rating-config.kMin 应为正数');
    if (!isNum(rc.kMax) || rc.kMax <= 0) problems.push('rating-config.kMax 应为正数');
    if (isNum(rc.kMin) && isNum(rc.kBase) && isNum(rc.kMax) && !(rc.kMin <= rc.kBase && rc.kBase <= rc.kMax)) {
      problems.push('rating-config 应满足 kMin ≤ kBase ≤ kMax（非对称 Elo 的加分/扣分系数上下界）');
    }
    if (!isNum(rc.drawFactor) || rc.drawFactor < 0 || rc.drawFactor > 1) problems.push('rating-config.drawFactor 应在 [0,1]');
    if (!isNum(rc.matchWindowStart) || rc.matchWindowStart <= 0) problems.push('rating-config.matchWindowStart 应为正数');
    if (!isNum(rc.matchWindowStep) || rc.matchWindowStep <= 0) problems.push('rating-config.matchWindowStep 应为正数');
    if (!isNum(rc.matchWindowMax) || rc.matchWindowMax < rc.matchWindowStart) problems.push('rating-config.matchWindowMax 应 ≥ matchWindowStart（窗口递进上界）');
    if (!isNum(rc.opponentCooldownHours) || rc.opponentCooldownHours < 0) problems.push('rating-config.opponentCooldownHours 应为 ≥0 的数（D-136 去重窗口）');
    if (!isInt(rc.dailyBattleLimit) || rc.dailyBattleLimit < 0) problems.push('rating-config.dailyBattleLimit 应为 ≥0 的整数（0 = 不限制）');
    if (!['half_up', 'round'].includes(rc.rounding)) problems.push(`rating-config.rounding 应为 half_up|round（实际 ${rc.rounding}）`);
    if (!isInt(rc.promoteWins) || rc.promoteWins < 0) problems.push('rating-config.promoteWins 应为 ≥0 的整数（D-122：胜 > 6 晋升）');
    if (!isInt(rc.batchSize) || rc.batchSize < 1) problems.push('rating-config.batchSize 应为正整数（排位批次场次）');
    if (isInt(rc.promoteWins) && isInt(rc.batchSize) && rc.promoteWins >= rc.batchSize) {
      problems.push('rating-config 应满足 promoteWins < batchSize（否则批次必晋级）');
    }
  }

  return problemsOf(problems);
}

// ---------- T-DC-2：items-data 文档 ↔ 数据表逐条对齐 ----------
// `_sample` 语义（2026-09-16 补完，用户拍板 A）：
//   · 内容层表（role-templates / skill-templates / qualities / plugins）**各自**用 `_sample: true`
//     声明"我当前是示例内容"；声明了的表才按本文件顶部的示例期望表（ROLE_/SKILL_/QUALITY_/PLUGIN_EXPECTED）
//     **逐值**比对，未声明或整表去掉标记的表**跳过**逐值比对（只做 T-DC-1 的结构 + 机制校验）。
//   · 因此用户正式设计内容时：删掉 `_sample`（或逐表删）→ 门禁不再因"数值/名称与示例文档不同"失败；
//     想继续用示例期望兜底，就保留标记。
//   · 本函数**不比对数量**：示例期望表只是"这些 id 若存在则数值应为 …"，增删条目不再触发 FAIL。
function validateConsistency(dataDir) {
  const problems = [];
  let roles;
  let skills;
  let qualities;
  let plugins;
  let sample = { role: false, skill: false, quality: false, plugin: false };
  try {
    const rawRoles = loadJSON(dataDir, 'role-templates.json').data;
    const rawSkills = loadJSON(dataDir, 'skill-templates.json').data;
    const rawQualities = loadJSON(dataDir, 'qualities.json').data;
    const rawPlugins = loadJSON(dataDir, 'plugins.json').data;
    roles = rawRoles.roleTemplates;
    skills = rawSkills.skillTemplates;
    qualities = rawQualities.qualities;
    plugins = rawPlugins.plugins;
    sample = {
      role: rawRoles._sample === true,
      skill: rawSkills._sample === true,
      quality: rawQualities._sample === true,
      plugin: rawPlugins._sample === true,
    };
  } catch (e) {
    return { ok: false, detail: `T-DC-2 表读取失败: ${e.message}` };
  }
  const sampleTables = Object.keys(sample).filter((k) => sample[k]);
  if (sampleTables.length === 0) {
    return { ok: true, detail: '非示例内容（四张内容表均未标 _sample）：跳过示例期望表逐值比对（结构与机制校验仍由 T-DC-1 执行）' };
  }

  const byId = (list) => Object.fromEntries((list || []).map((x) => [x.id, x]));
  const roleMap = byId(roles);
  const skillMap = byId(skills);
  if (sample.role) {
    for (const [id, name, type] of ROLE_EXPECTED) {
      const r = roleMap[id];
      if (!r) { problems.push(`items-data §3 的示例角色 ${id} 缺失（role-templates.json 标了 _sample）`); continue; }
      if (r.name !== name || r.type !== type) problems.push(`${id}: 名称/类型应为 ${name}/${type}`);
    }
  }
  if (sample.skill) {
    for (const [id, name, type, mult, cost, cd, level, params, tier] of SKILL_EXPECTED) {
      const s = skillMap[id];
      if (!s) { problems.push(`items-data §4 的示例技能 ${id} 缺失（skill-templates.json 标了 _sample）`); continue; }
      if (s.name !== name || s.type !== type) problems.push(`${id}: 名称/类型应为 ${name}/${type}`);
      if (s.baseMultiplier !== mult) problems.push(`${id}: baseMultiplier 应为 ${mult}`);
      if (s.baseCost.mp !== cost.mp || s.baseCost.sp !== cost.sp || s.baseCost.hp !== 0) problems.push(`${id}: baseCost 应为 {hp:0,mp:${cost.mp},sp:${cost.sp}}`);
      if (s.cooldown !== cd || s.bulletLevel !== level) problems.push(`${id}: cooldown/bulletLevel 应为 ${cd}/${level}`);
      if (s.unlockTier !== tier) problems.push(`${id}: unlockTier 应为 ${tier}`);
      for (const [k, v] of Object.entries(params)) {
        if (JSON.stringify(s[k]) !== JSON.stringify(v)) problems.push(`${id}: ${k} 应为 ${JSON.stringify(v)}`);
      }
    }
  }
  if (sample.quality) {
    for (const [id, name, color, statRange, roleSlot, skillSlot] of QUALITY_EXPECTED) {
      const q = (qualities || []).find((x) => x.id === id);
      if (!q) { problems.push(`items-data §2 的示例品质 ${id} 缺失（qualities.json 标了 _sample）`); continue; }
      if (q.name !== name || q.color !== color) problems.push(`${id}: 名称/颜色应为 ${name}/${color}`);
      if (JSON.stringify(q.statRange) !== JSON.stringify(statRange)) problems.push(`${id}: statRange 应为 ${JSON.stringify(statRange)}`);
      if (JSON.stringify(q.roleSlotRange) !== JSON.stringify(roleSlot) || JSON.stringify(q.skillSlotRange) !== JSON.stringify(skillSlot)) problems.push(`${id}: 插槽区间不符`);
    }
  }
  if (sample.plugin) {
    const pluginMap = byId(plugins);
    for (const [id, slot, category, v] of PLUGIN_EXPECTED) {
      const p = pluginMap[id];
      if (!p) { problems.push(`items-data §5/§6 的示例插件 ${id} 缺失（plugins.json 标了 _sample）`); continue; }
      if (p.slot !== slot || p.category !== category) problems.push(`${id}: slot/category 应为 ${slot}/${category}`);
      if (!p.affixes || !p.affixes[0] || p.affixes[0].params.v !== v) {
        problems.push(`${id}: 词条基础值 v 应为 ${v}（items-data 表列）`);
      }
      if (id === 'sp_buff' && (!p.affixes[0] || p.affixes[0].params.duration !== 2)) {
        problems.push(`${id}: 释放增益 duration 应为 2`);
      }
    }
  }

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