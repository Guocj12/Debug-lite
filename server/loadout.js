'use strict';
/* server/loadout.js —— 出战配置校验与最终面板（P3 B19；契约 docs/interfaces.md §2 /api/v1/loadout + /api/v1/panel）
 * L6 组合：结构（I-12a/b：角色 1 + 技能恰 3 + AI 合法）+ 引用完整性（T-PB-9/I-12d）+ 段位门控
 * （I-12e：物品级 items.validateUnlock + AI 节点 ast.validate(tier)）+ 面板聚合（五维/regen/special/技能参数）。
 * D-123：不持久化——POST 校验后回带；GET 返回规范骨架。事件：api.*（api 行）；unlock.reject/ai.validate（既有行）。
 *
 * **段位门控开关（用户决策 2026-09-16：默认所有功能全部解锁，段位不参与判定）**：
 *   本文件的段位判定**全部经由依赖模块**（items.validateUnlock / ast.validate，二者缺省按 server/data/unlock.json
 *   的 `gating.enabled` 取值 → 当前 false 即门控关闭），本文件**没有**硬编码段位比较（已逐行确认）。
 *   为让"开关打开（回退）"在 loadout 层可注入可测，提供同风格工厂：
 *     `loadout.withGating(enabled)` → 内部 items/ast 使用**同一**门控取值的视图（见文件尾 withGating）；
 *   亦可用 opts.items / opts.ast 单独注入（缺省 = 模块单例）。
 */
const items = require('./core/items.js'); // 含 buildRolePanel：角色面板聚合的单一实现（与 roles.getFinalStats 同源）
const skills = require('./core/skills.js'); // B20：技能插件词条聚合（消耗补偿/减耗/倍率冷却，L2 → L6 合法）
const ast = require('./ai/ast.js');

// 技能实例化基准 rng（面板聚合只需确定性基=1；物品参数随后覆盖）
const STUB_RNG = { float: () => 1, int: () => 0, pick: () => 0 };

// 数据表存在性索引（P1-1 修复：聚合路径不得对客户端注入的未知模板/品质崩溃）
const ROLE_IDS = new Set(require('./data/role-templates.json').roleTemplates.map((r) => r.id));
const SKILL_IDS = new Set(require('./data/skill-templates.json').skillTemplates.map((s) => s.id));
const QUALITY_IDS = new Set(require('./data/qualities.json').qualities.map((q) => q.id));

// 规范骨架（GET /api/v1/loadout）
const EMPTY_LOADOUT = { role: null, skills: [null, null, null], ai: null };

// 仓库内按 uid 找物品（与 items.findItem 同语义；L6 侧内联，避免导出依赖）
function findItem(wh, uid) {
  const buckets = (wh && wh.buckets) || {};
  for (const list of Object.values(buckets)) {
    if (!Array.isArray(list)) continue;
    const it = list.find((x) => x && x.uid === uid);
    if (it) return it;
  }
  return null;
}

function cloneItem(it) {
  return JSON.parse(JSON.stringify(it));
}

// D-163（2026-09-25 热修）：loadout 的**物品身份与数值一律取自服务端权威仓库**。
//   客户端正文只用来指出"要哪一件"（uid）；取回的是仓库里那份物品的副本，客户端给的 stats/templateId/
//   quality/params 一律丢弃。uid 不在仓库 → 错误（"物品不在仓库: <uid>"）。
//   修前的真实缺陷（已实测复现）：validateLoadout 只校验 kind/templateId/quality 与**插件**引用，
//   从不校验角色/技能物品是否属于该玩家、也不校验数值 ⇒ 客户端可 PUT 一件 stats.hp=999999 的角色
//   （甚至仓库里根本不存在的 uid），activate 后快照冻结该正文，而 quickmatch/ranked 用的正是
//   `snapshot.loadout`（battle.buildPlayer 直接读 role.stats）→ 战斗被"打穿"。
//   同时把"同配置内全 uid 去重"放在这里：角色/技能/插件都不得重复占位（修前只查插件双处引用，
//   一件**无插件**的技能物品可以占满 3 个技能位，连出战槽都 200）。
function resolveItems(loadout, warehouse) {
  const ld = loadout !== null && typeof loadout === 'object' && !Array.isArray(loadout) ? loadout : null;
  if (!ld || !warehouse) return { ok: true, errors: [], loadout: ld };
  const errors = [];
  const out = {
    role: null,
    skills: [null, null, null],
    ai: ld.ai === undefined ? null : ld.ai,
    aiId: ld.aiId === undefined ? null : ld.aiId,
  };
  const takeFrom = (raw, where, wantKind) => {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ where, code: 'loadout_invalid', message: `${where} 必须是物品对象` });
      return null;
    }
    const uid = raw.uid;
    if (typeof uid !== 'string' || uid === '') {
      errors.push({ where, code: 'loadout_invalid', message: `${where} 缺少 uid（物品身份必须来自服务端仓库）` });
      return null;
    }
    const it = findItem(warehouse, uid);
    if (!it) {
      errors.push({ where, code: 'loadout_invalid', message: `物品不在仓库: ${uid}` });
      return null;
    }
    if (it.kind !== wantKind) {
      errors.push({ where, code: 'loadout_invalid', message: `${where} 的物品类别不是 ${wantKind}: ${uid}` });
      return null;
    }
    return cloneItem(it);
  };
  out.role = takeFrom(ld.role, 'role', 'role');
  const skillsIn = Array.isArray(ld.skills) ? ld.skills : [];
  // 技能位置必须恰 3 个：多出来的不许"静默截断"（截断会掩盖客户端异常，且第 4 个技能会进快照正文）
  if (Array.isArray(ld.skills) && skillsIn.length > 3) {
    errors.push({ where: 'skills', code: 'loadout_invalid', message: `技能必须恰 3 个（实际 ${skillsIn.length}）` });
  }
  for (let i = 0; i < 3; i += 1) out.skills[i] = takeFrom(skillsIn[i], `skills[${i}]`, 'skill');

  // 同一份配置内：角色 / 3 个技能 / 全部插件引用必须两两不同（插件保持既有 T-PB-8 文案）
  const seen = new Set();
  const mark = (uid, where, isPlugin) => {
    if (typeof uid !== 'string' || uid === '') return;
    if (seen.has(uid)) {
      errors.push(isPlugin
        ? { where, code: 'loadout_invalid', message: `同一插件被双处引用: ${uid}（T-PB-8）` }
        : { where, code: 'loadout_invalid', message: `同一物品被多处引用: ${uid}（一件物品同时只能占一个位置）` });
      return;
    }
    seen.add(uid);
  };
  const markSlots = (item, where) => {
    if (!item) return;
    const slots = Array.isArray(item.slots) ? item.slots : [];
    slots.forEach((s, j) => mark(s && s.pluginUid, `${where}.slots[${j}]`, true));
  };
  mark(out.role && out.role.uid, 'role', false);
  markSlots(out.role, 'role');
  for (let i = 0; i < 3; i += 1) {
    mark(out.skills[i] && out.skills[i].uid, `skills[${i}]`, false);
    markSlots(out.skills[i], `skills[${i}]`);
  }
  return { ok: errors.length === 0, errors, loadout: out };
}

// 一份 loadout 引用到的**全部物品 uid**（角色 + 3 技能 + 全部插件）——用于跨配置独占判定（D-163）
function referencedUidsOf(loadout) {
  const out = new Set();
  const ld = loadout && typeof loadout === 'object' ? loadout : null;
  if (!ld) return out;
  const add = (uid) => { if (typeof uid === 'string' && uid !== '') out.add(uid); };
  add(ld.role && ld.role.uid);
  for (const s of Array.isArray(ld.role && ld.role.slots) ? ld.role.slots : []) add(s && s.pluginUid);
  for (const sk of Array.isArray(ld.skills) ? ld.skills : []) {
    add(sk && sk.uid);
    for (const s of Array.isArray(sk && sk.slots) ? sk.slots : []) add(s && s.pluginUid);
  }
  return out;
}


// 校验（I-12a/b/d/e + T-PB-9）：{ok, errors:[{where, code, message}]}
// opts.items：items.js 实例注入缝（缺省 = 模块单例）——段位门控开关由该实例承载
//   （unlock.json `gating.enabled`，用户决策 2026-09-16 默认关闭；测试可传 items.withGating(true) 复核旧行为）。
// opts.ast：ast.js 实例注入缝（缺省 = 模块单例）——AI 节点门控由该实例承载；配套用 ast.withGating(true)。
function validateLoadout(loadout, opts) {
  const tier = (opts && opts.tier) || 'mythic';
  const wh = (opts && opts.warehouse) || null;
  const itemsApi = (opts && opts.items) || items;
  const astApi = (opts && opts.ast) || ast;
  const ld = loadout || {};
  const errors = [];
  if (!ld.role || typeof ld.role !== 'object') errors.push({ where: 'role', code: 'loadout_invalid', message: '缺少角色物品' });
  else if (ld.role.kind !== 'role') errors.push({ where: 'role', code: 'loadout_invalid', message: '角色位置必须是角色物品' });
  else {
    if (!ROLE_IDS.has(ld.role.templateId)) errors.push({ where: 'role', code: 'loadout_invalid', message: `未知角色模板 ${ld.role.templateId}` });
    if (ld.role.quality !== undefined && ld.role.quality !== null && !QUALITY_IDS.has(ld.role.quality)) {
      errors.push({ where: 'role', code: 'loadout_invalid', message: `未知品质 ${ld.role.quality}` });
    }
  }
  const skills = Array.isArray(ld.skills) ? ld.skills : null;
  if (!skills || skills.length !== 3) errors.push({ where: 'skills', code: 'loadout_invalid', message: `技能必须恰 3 个（实际 ${skills ? skills.length : 0}）` });
  else {
    skills.forEach((s, i) => {
      if (!s || typeof s !== 'object') errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: `技能位置缺失: ${i}` });
      else if (s.kind !== 'skill') errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: '技能位置必须是技能物品' });
      else {
        if (!SKILL_IDS.has(s.templateId)) errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: `未知技能模板 ${s.templateId}` });
        if (s.quality !== undefined && s.quality !== null && !QUALITY_IDS.has(s.quality)) {
          errors.push({ where: `skills[${i}]`, code: 'loadout_invalid', message: `未知品质 ${s.quality}` });
        }
      }
    });
  }
  if (!ld.ai || typeof ld.ai !== 'object') errors.push({ where: 'ai', code: 'loadout_invalid', message: '缺少 AI 程序' });
  // 引用完整性（T-PB-9/I-12d + T-PB-8 双引用防御）：装配引用必须存在于仓库、equipped=true、且同一插件不得被双处引用。
  // 存在装配引用但无 warehouse → missing_warehouse（P1-3：引用校验不得空转）。
  const refs = [];
  if (ld.role && Array.isArray(ld.role.slots)) {
    ld.role.slots.forEach((s, i) => { if (s && s.pluginUid) refs.push({ where: `role.slots[${i}]`, uid: s.pluginUid, kind: 'role' }); });
  }
  (skills || []).forEach((sk, j) => {
    if (sk && Array.isArray(sk.slots)) sk.slots.forEach((s, i) => { if (s && s.pluginUid) refs.push({ where: `skills[${j}].slots[${i}]`, uid: s.pluginUid, kind: 'skill' }); });
  });
  if (refs.length > 0 && !wh) {
    errors.push({ where: 'warehouse', code: 'missing_warehouse', message: '出战配置含装配引用，需要 warehouse 校验引用完整性（T-PB-9）' });
  } else if (wh && refs.length > 0) {
    // D-163 热修：**去掉** `errors.length === 0` 前置条件 —— 修前只要 loadout 还有别的错误（典型：
    //   非出战槽允许的"技能位置缺失"），整个引用校验就被跳过 ⇒ 不完整的配置可以带**悬挂/未装配**的
    //   插件引用落盘（已实测：捏造 pluginUid 的非出战槽 PUT 返回 200）。
    const seen = new Set();
    for (const ref of refs) {
      if (seen.has(ref.uid)) {
        errors.push({ where: ref.where, code: 'loadout_invalid', message: `同一插件被双处引用: ${ref.uid}（T-PB-8）` });
        continue;
      }
      seen.add(ref.uid);
      const p = findItem(wh, ref.uid);
      if (!p) errors.push({ where: ref.where, code: 'loadout_invalid', message: `悬挂引用 ${ref.uid}` });
      else if (p.equipped !== true) errors.push({ where: ref.where, code: 'loadout_invalid', message: `插件未装配: ${ref.uid}` });
      else if (p.kind !== (ref.kind === 'role' ? 'rolePlugin' : 'skillPlugin')) errors.push({ where: ref.where, code: 'loadout_invalid', message: `插件类别与槽位不匹配: ${ref.uid}` });
      else if (ref.kind === 'skill' && (!Number.isInteger(p.tier) || p.tier < 1)) errors.push({ where: ref.where, code: 'loadout_invalid', message: `技能插件缺档位（tier 必须 ≥1）: ${ref.uid}` });
      else if (!itemsApi.validateUnlock(p, tier)) errors.push({ where: ref.where, code: 'loadout_invalid', message: `插件 ${ref.uid} 需 ${p.unlockTier} 段位（P2-2 复核）` });
    }
  }
  // 段位门控（I-12e）：物品级（unlockTier ≤ tier）+ AI 节点（ast.validate 含门控）
  if (errors.length === 0) {
    const members = [ld.role].concat(skills).filter(Boolean);
    for (const m of members) {
      if (!itemsApi.validateUnlock(m, tier)) {
        errors.push({ where: m.kind === 'role' ? 'role' : 'skills', code: 'loadout_invalid', message: `物品 ${m.templateId} 需 ${m.unlockTier} 段位` });
      }
    }
    const aiV = astApi.validate(ld.ai, tier);
    if (!aiV.ok) {
      for (const e of aiV.errors.slice(0, 5)) errors.push({ where: `ai:${e.path}`, code: 'loadout_invalid', message: `${e.code}: ${e.message}` });
      if (aiV.errors.length > 5) errors.push({ where: 'ai', code: 'loadout_invalid', message: `其余 ${aiV.errors.length - 5} 条 AI 错误已截断（P2-3 标记）` });
    }
  }
  return { ok: errors.length === 0, errors };
}

// 最终面板（B19 基础聚合）：角色五维/regen/special + 技能参数直透（消耗补偿 B20）。
// 2026-09-16 合并（用户拍板 A）：角色面板聚合改由 **items.buildRolePanel 单一实现**完成
//   （与 roles.getFinalStats 同源）——五维 + special + regen 一次算清，regen 不再两侧各加一次。
function buildPanel(loadout, opts) {
  // D-163 热修（纵深防御）：有仓库时**先把物品解析成仓库里那份**再算面板 —— 这样即便碰上一份
  //   历史遗留的、被篡改过数值的快照，战斗数值也仍以服务端仓库为准（而不是快照正文）。
  const resolved = resolveItems(loadout, (opts && opts.warehouse) || null);
  if (!resolved.ok) return { ok: false, errors: resolved.errors };
  const v = validateLoadout(resolved.loadout, opts);
  if (!v.ok) return { ok: false, errors: v.errors };
  const wh = (opts && opts.warehouse) || null;
  const role = resolved.loadout.role;
  const rPlugins = [];
  for (const s of role.slots || []) {
    if (!s || !s.pluginUid) continue;
    const p = findItem(wh, s.pluginUid);
    if (p) rPlugins.push(p);
  }
  const rp = items.buildRolePanel(role, rPlugins);
  return {
    ok: true,
    panel: {
      role: {
        stats: rp.stats,
        special: rp.special,
        regen: rp.regen,
        pluginPoints: rp.pluginPoints,
        quality: rp.quality,
      },
      skills: resolved.loadout.skills.map((sk) => {
        // B20：技能插件词条聚合——消耗补偿（D-113：costDeltaBase×tier）/减耗 ceil（S-3）/倍率·冷却·射程等
        const plugins = [];
        for (const s of sk.slots || []) {
          if (!s || !s.pluginUid) continue;
          const p = findItem(wh, s.pluginUid);
          if (p) plugins.push(p);
        }
        let params = Object.assign({}, sk.params || {});
        if (plugins.length > 0) {
          const base = skills.instantiateSkill(sk.templateId, sk.quality || 'common', STUB_RNG);
          const applied = skills.applySkillPlugins(Object.assign({}, base, sk.params || {}), plugins);
          params = {};
          // 投影白名单：含 specials/castEffects/affixes——否则技能插件的
          //   crit_chance/lifesteal（概率类）、cast_buff（释放类）、stun/knockback/pull/dot/true_dmg（命中类）
          //   会在 API 路径（/battle → battle.js buildPlayer 的 Object.assign）被丢掉，导致"文档已设计但实际不生效"。
          for (const k of ['multiplier', 'cost', 'cooldown', 'bulletLevel', 'bulletCount', 'range', 'area', 'distance', 'passThroughEnemy', 'dealDamage', 'fullDodgeDuring', 'falloff', 'specials', 'castEffects', 'affixes']) {
            if (applied[k] !== undefined) params[k] = applied[k];
          }
          // P2-②：未列入白名单的自定义字段保留透传（聚合投影不丢非标准字段）
          for (const k of Object.keys(sk.params || {})) {
            if (params[k] === undefined) params[k] = sk.params[k];
          }
        }
        return { templateId: sk.templateId, uid: sk.uid, params };
      }),
    },
  };
}

// 段位门控注入视图（用户决策 2026-09-16：默认关闭；本函数 = loadout 层的"一键回退"入口）：
//   items 与 ast 使用**同一**门控取值（ast 的节点门控经 unlock 实例，由 ast.withGating 转交）；
//   显式 opts.items / opts.ast 优先于本视图（单点覆盖仍可用）。gatingEnabled 为该视图的实际取值（自省用）。
function withGating(enabled) {
  const itemsApi = items.withGating(enabled);
  const astApi = ast.withGating(enabled);
  const bind = (opts) => Object.assign({}, opts || {}, {
    items: (opts && opts.items) || itemsApi,
    ast: (opts && opts.ast) || astApi,
  });
  return {
    EMPTY_LOADOUT,
    gatingEnabled: itemsApi.gatingEnabled,
    validateLoadout: (ld, opts) => validateLoadout(ld, bind(opts)),
    buildPanel: (ld, opts) => buildPanel(ld, bind(opts)),
    resolveItems,
    referencedUidsOf,
    findItem,
    withGating,
  };
}

module.exports = {
  EMPTY_LOADOUT, validateLoadout, buildPanel, findItem,
  // D-163 热修新增：权威仓库解析（身份/数值）+ 引用 uid 集合（跨配置独占判定）
  resolveItems, referencedUidsOf,
  // 缺省门控取值（= unlock.json gating.enabled，经 items 单例透传；门禁/文档可读）
  gatingEnabled: items.gatingEnabled,
  withGating,
};