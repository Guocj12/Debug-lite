'use strict';
/* server/starter.js —— D-159 新手套装（starter）的**确定性生成**（L6）
 *
 * 契约：docs/frontend/03-hub-warehouse-loadout.md 附录 D（用户 2026-09-22 拍板：我出草案，他逐条改）。
 * 设计要点（全部可机器核对，见 tests/unit/starter.test.js）：
 *   1. **复用生成路径**（core/items.generateRoleItem/generateSkillItem/generatePlugin），不手写物品对象
 *      —— 否则字段形状会与生成路径漂移；品质/数值仍来自 qualities.json。
 *   2. **种子由身份派生**：seed = 前 8 位 hex(sha256('starter|publicId|playerId')) → 同账号永远同一套（可测），
 *      不同账号不同。
 *      ⚠️ 可复现的粒度 = **内容级**（模板/品质/数值/槽类型/插件/槽下标）：物品 `uid` 由 core/items 的
 *      **进程内计数器**分配（B17 登记口径："不参与内容级比较"），故同进程内两次生成 uid 不同、内容逐值相同。
 *   3. **保证装得上**：角色/技能生成后读其**实际** slots[].type，只从"类型匹配且 drop!==false"的插件池里
 *      生成插件，再走 core/items.assemble 装进第一个匹配空槽 → 不会出现实测过的
 *      `slot_type_mismatch：插件槽 special ≠ 插槽 def`。
 *   4. **插槽下限**：common 的 roleSlotRange 是 [1,3]（qualities.json）→ 角色必有 ≥1 槽；
 *      common 的 skillSlotRange 是 [0,1] → 3 个技能可能全 0 槽，故按上限 20 次重掷，直到至少 1 个技能有槽。
 *   5. **AI 单一来源**：直接复用 ranked.buildDefaultLoadout 的预设 AI（不复制程序正文），
 *      并**同时登记进 AI 库**（用户口径：配置编辑器的 AI 位置要能选到 starter 的默认 AI）。
 */
const crypto = require('node:crypto');
const itemsMod = require('./core/items.js');
const rngMod = require('./core/rng.js');
const rankedMod = require('./ranked.js');
const { nullLogger } = require('../shared/log.js');

const STARTER_ROLE_TEMPLATE = 'role_bal';
// 2026-09-28 §6.3：技能基础模板每类 1 条；starter 给近战 + 平射 + 定点（三个不同模板，满足"同配置内模板不可重复"）
const STARTER_SKILL_TEMPLATES = Object.freeze(['skill_melee', 'skill_straight', 'skill_vertical']);
const STARTER_QUALITY = 'common';
const SKILL_REROLL_MAX = 20;
const ROLE_REROLL_MAX = 8; // 角色重掷上限（common roleSlotRange [0,2]；8 次内全 0 槽概率 (1/3)^8 ≈ 1.5e-4）
const ROLE_PLUGIN_MAX = 2; // 草案：角色插件 1~2 个（受点数与匹配槽数量限制）
const SKILL_PLUGIN_MAX = 2; // 技能插件：1 个专属 + 1 个通用（2026-09-28 §6.2）
const STARTER_AI_NAME = '新手AI';

const PLUGIN_DEFS = require('./data/plugins.json').plugins;
const SKILL_DEFS = require('./data/skill-templates.json').skillTemplates;
const SKILL_TYPE_OF = Object.fromEntries(SKILL_DEFS.map((s) => [s.id, s.type]));

function starterSeedOf(publicId, playerId) {
  const hex = crypto.createHash('sha256')
    .update(`starter|${publicId || ''}|${playerId || ''}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
  // box/rng 口径的 seed 合法区间为 1..0x7fffffff（P2 落实：防 32 位回绕）
  return (parseInt(hex, 16) % 0x7ffffffe) + 1;
}

// 与目标物品插槽类型匹配、且允许掉落的插件定义（drop !== false 缺省视为 true）
//   2026-09-28：改用 items.slotMatches —— **万能槽 `any` 接受五维任一插件**（旧实现按精确等值匹配，
//   生成出 `any` 槽时池为空 → starter 拿不到角色插件）。
function pluginPoolFor(kind, slotTypes, itemsApi, skillType) {
  const I = itemsApi || itemsMod;
  const want = Array.isArray(slotTypes) ? slotTypes : [];
  return PLUGIN_DEFS.filter((p) => {
    if (!p || p.kind !== kind || p.drop === false) return false;
    if (!want.some((t) => I.slotMatches(p.slot, t))) return false;
    // 专属插件按技能类型绑定（2026-09-28 §6.2）：forTypes 不含该技能类型 → 不进池
    if (p.slot === 'exclusive' && skillType && Array.isArray(p.forTypes) && !p.forTypes.includes(skillType)) return false;
    return true;
  });
}

// 第一个"类型匹配且空闲"的槽下标；无 → -1
function freeSlotIndexOf(item, plugin, itemsApi) {
  const I = itemsApi || itemsMod;
  const slots = Array.isArray(item && item.slots) ? item.slots : [];
  for (let i = 0; i < slots.length; i += 1) {
    const s = slots[i];
    if (s && I.slotMatches(plugin.slot, s.type) && (s.pluginUid === null || s.pluginUid === undefined)) return i;
  }
  return -1;
}

/**
 * 生成一套 starter。
 * @param {{publicId?:string, playerId?:string, logger?:object}} input
 * @returns {{ok:boolean, seed:number, warehouse:object, loadout:object, aiLibrary:Array, stats:object}}
 */
function buildStarter(input) {
  const o = input || {};
  const log = o.logger || nullLogger;
  const items = itemsMod.withLogger(log);
  const seed = starterSeedOf(o.publicId, o.playerId);
  const rng = rngMod.createRng(seed, { logger: log });

  // ---- 角色（common → roleSlotRange [0,2]：**可能 0 槽** → 重掷直到 ≥1 槽）----
  //   2026-09-28 §3.3：插槽数下限 1 已作废，故 starter 必须自行保证"至少一个可装槽"
  //   （与下方技能同一策略）。重掷流下标 0..ROLE_REROLL_MAX-1 与技能流（≥10）不冲突。
  let role = null;
  let roleGenerateAttempts = 0;
  for (; roleGenerateAttempts < ROLE_REROLL_MAX; roleGenerateAttempts += 1) {
    role = items.generateRoleItem(STARTER_ROLE_TEMPLATE, STARTER_QUALITY, rng.deriveStream(roleGenerateAttempts, 'starter'));
    if ((role.slots || []).length > 0) break;
  }
  const roleSlotTypes = [...new Set((role.slots || []).map((s) => s && s.type).filter(Boolean))];

  // ---- 技能 ×3（专属槽恒有；**通用槽**按品质掷出、common 下可能全 0 → 重掷到至少 1 个技能有通用槽）----
  //   重掷目标 = "能发出 1 专属 + 1 通用"（用户 2026-09-28 裁定）；上限 SKILL_REROLL_MAX 次后接受实际掷出。
  let skills = [];
  let skillAttempts = 0;
  for (; skillAttempts < SKILL_REROLL_MAX; skillAttempts += 1) {
    skills = STARTER_SKILL_TEMPLATES.map((tid, i) => items.generateSkillItem(
      tid, STARTER_QUALITY, rng.deriveStream(10 + skillAttempts * 4 + i, 'starter'),
    ));
    if (skills.some((s) => (s.slots || []).some((sl) => sl && sl.type === 'general'))) break;
  }
  const skillSlotTotal = skills.reduce((a, s) => a + (s.slots || []).length, 0);

  // ---- 仓库四桶（先放角色与技能，插件随后依法入桶）----
  let warehouse = items.emptyWarehouse();
  warehouse.buckets.role.push(role);
  for (const s of skills) warehouse.buckets.skill.push(s);

  const assembled = [];
  // ---- 角色插件（1~2 个，按实际槽类型筛池；点数必须装得下）----
  //   注意：core/items.assemble 返回**新仓库**（入参不变）→ 每次都必须从当前仓库里取目标物品，
  //   否则会一直看到"空槽"并反复装配同一槽（占位失败 → 死循环；用 attempt 上限双保险）。
  const rolePool = pluginPoolFor('rolePlugin', roleSlotTypes, items);
  const roleInWarehouse = () => warehouse.buckets.role.find((x) => x.uid === role.uid) || role;
  let stream = 100;
  let roleAttempts = 0;
  while (assembled.filter((x) => x.kind === 'rolePlugin').length < ROLE_PLUGIN_MAX
    && rolePool.length > 0 && roleAttempts < ROLE_PLUGIN_MAX + 4) {
    roleAttempts += 1;
    const plugin = items.generatePlugin('rolePlugin', STARTER_QUALITY, rng.deriveStream(stream, 'starter'), rolePool);
    stream += 1;
    const slotIndex = freeSlotIndexOf(roleInWarehouse(), plugin, items);
    if (slotIndex < 0) break; // 没有匹配空槽 → 停止（不再生成新的）
    if ((plugin.pointCost || 0) > (role.pluginPoints || 0)) {
      log.warn('starter', 'store.starter.issued', `starter 角色插件点数超出预算，跳过（${plugin.id}）`, {
        pluginId: plugin.id, pointCost: plugin.pointCost, pluginPoints: role.pluginPoints,
      });
      continue;
    }
    warehouse.buckets.rolePlugin.push(plugin);
    const res = items.assemble(warehouse, { targetUid: role.uid, pluginUid: plugin.uid, slotIndex, tier: 'common' });
    if (!res.ok) {
      log.warn('starter', 'store.starter.issued', `starter 角色插件装配失败（${res.code}），跳过`, { pluginId: plugin.id, code: res.code });
      warehouse.buckets.rolePlugin.pop();
      continue;
    }
    warehouse = res.warehouse;
    assembled.push({ kind: 'rolePlugin', id: plugin.id, uid: plugin.uid, targetUid: role.uid, slotIndex });
  }

  // ---- 技能插件（**1 专属 + 1 通用**，2026-09-28 用户裁定：新号必须能体验专属形态）----
  //   两轮确定性选择：先 `exclusive` 槽（池按 `forTypes` 绑定技能类型），再 `general` 槽；
  //   每轮取第一个"有该类型匹配空槽"的技能，生成一个插件并装配（`SKILL_PLUGIN_MAX` 为总上限）。
  let skillPlugins = 0;
  for (const wantSlot of ['exclusive', 'general']) {
    if (skillPlugins >= SKILL_PLUGIN_MAX) break;
    for (const skill of skills) {
      const live = warehouse.buckets.skill.find((x) => x.uid === skill.uid) || skill;
      if (!(live.slots || []).some((s) => s && s.type === wantSlot && !s.pluginUid)) continue; // 该技能无该类型空槽 → 换下一个
      const pool = pluginPoolFor('skillPlugin', [wantSlot], items, SKILL_TYPE_OF[live.templateId]);
      if (pool.length === 0) continue;
      const plugin = items.generatePlugin('skillPlugin', STARTER_QUALITY, rng.deriveStream(stream, 'starter'), pool);
      stream += 1;
      const slotIndex = freeSlotIndexOf(live, plugin, items);
      if (slotIndex < 0) continue;
      warehouse.buckets.skillPlugin.push(plugin);
      const res = items.assemble(warehouse, { targetUid: live.uid, pluginUid: plugin.uid, slotIndex, tier: 'common' });
      if (!res.ok) {
        warehouse.buckets.skillPlugin.pop();
        continue;
      }
      warehouse = res.warehouse;
      skillPlugins += 1;
      assembled.push({ kind: 'skillPlugin', id: plugin.id, uid: plugin.uid, targetUid: live.uid, slotIndex });
      break; // 该轮完成（专属/通用各至多 1 个）→ 进入下一轮
    }
  }

  // ---- AI：复用默认预设（不复制正文），并登记进 AI 库 ----
  const aiProgram = rankedMod.buildDefaultLoadout({ publicId: o.publicId, playerId: o.playerId }).ai;
  const aiId = `ai_starter_${crypto.createHash('sha256')
    .update(`starter-ai|${o.publicId || ''}|${o.playerId || ''}`, 'utf8').digest('hex').slice(0, 8)}`;
  const aiLibrary = [{ aiId, name: STARTER_AI_NAME, program: aiProgram }];

  const loadout = {
    role: warehouse.buckets.role.find((x) => x.uid === role.uid) || role,
    skills: skills.map((s) => warehouse.buckets.skill.find((x) => x.uid === s.uid) || s),
    ai: aiProgram,
    aiId,
  };

  const stats = {
    seed,
    quality: STARTER_QUALITY,
    roleTemplate: role.templateId,
    roleSlotCount: (role.slots || []).length,
    roleSlotTypes,
    skillTemplates: skills.map((s) => s.templateId),
    skillSlotTotal,
    skillAttempts,
    plugins: assembled,
    aiId,
    counts: {
      role: warehouse.buckets.role.length,
      skill: warehouse.buckets.skill.length,
      rolePlugin: warehouse.buckets.rolePlugin.length,
      skillPlugin: warehouse.buckets.skillPlugin.length,
    },
  };
  log.info('starter', 'store.starter.issued', `新手套装已生成（seed=${seed}）`, {
    publicId: o.publicId || null, playerId: o.playerId || null,
    roleSlotCount: stats.roleSlotCount, plugins: assembled.length, skillSlotTotal,
  });
  return { ok: true, seed, warehouse, loadout, aiLibrary, stats };
}

module.exports = {
  STARTER_ROLE_TEMPLATE,
  STARTER_SKILL_TEMPLATES,
  STARTER_QUALITY,
  STARTER_AI_NAME,
  SKILL_REROLL_MAX,
  ROLE_REROLL_MAX,
  ROLE_PLUGIN_MAX,
  SKILL_PLUGIN_MAX,
  starterSeedOf,
  pluginPoolFor,
  freeSlotIndexOf,
  buildStarter,
};
