'use strict';
/* scripts/play.js —— 离线可玩闭环（P6 前端 / P7 服务端新系统之前的最小可玩路径）
 *
 * 一条命令把现有零件串起来：
 *   开箱 → 合并进仓库（内存）→ 自动装配（按槽位/点数预算）→ 选 3 个技能槽 → 内置预设 AI
 *   → 角色面板（五维/regen/special/技能参数）→ 打一场（对手 = server/ranked.js 的内置 bot）
 *   → 逐 tick 战报（伤害数字 + 暴击/背击标注）→ 最终胜负。
 *
 * 用法：npm run play -- [--seed n] [--boxes n] [--tier t] [--preset steady|aggressive|kite]
 *                       [--quality q] [--out file.json] [--help]
 *
 * 约束（项目铁律）：零依赖；脚本内禁 child_process / Math.random（确定性全部来自 seed 派生的 rng 流）；
 *   只在显式 --out 时写文件（建议 runtime/，已 gitignore——不污染仓库）。
 * 层次：scripts/ 不参与 check-arch 分层；本脚本组合 L6 模块（不新增任何服务端接口）。
 */
const fs = require('node:fs');
const path = require('node:path');
const items = require('../server/core/items.js');
const unlock = require('../server/core/unlock.js');
const { createRng } = require('../server/core/rng.js');
const loadoutApi = require('../server/loadout.js');
const ranked = require('../server/ranked.js');
const battle = require('../server/battle.js');
const { BOX_TIMES_MAX } = require('../server/box.js');
const { replayLine } = require('../cli/index.js');
const QUALITIES = require('../server/data/qualities.json').qualities;
const SKILL_TYPES = Object.fromEntries(require('../server/data/skill-templates.json').skillTemplates.map((t) => [t.id, t.type]));

const TIERS = QUALITIES.map((q) => q.id); // 段位序 = 品质表顺序（unlock.js 同源口径）
const PRESETS = ['steady', 'aggressive', 'kite'];
const PRESET_LABEL = { steady: '稳健', aggressive: '激进', kite: '风筝' };
const DEFAULT_SEED = 20260912; // 与 gate 项 8 黄金战斗同 seed（便于对照复算）
const DEFAULT_BOXES = 12;
const TYPE_SCORE = { straight: 0, vertical: 1, melee: 2, displacement: 3 }; // 主攻技能偏好（远→近）
const TOPUP_CAP = Math.max(BOX_TIMES_MAX, DEFAULT_BOXES); // 补齐开箱的总次数上限（确定性）

const USAGE = `用法：npm run play -- [选项]        （等价于 node scripts/play.js [选项]）

离线可玩闭环：开箱 → 自动装配 → 选 3 技能 → 内置预设 AI → 角色面板 → 打一场 → 逐 tick 战报

选项：
  --seed <n>      随机种子（默认 ${DEFAULT_SEED}；全流程确定性来源，同 seed 结果完全一致）
  --boxes <n>     开箱次数（默认 ${DEFAULT_BOXES}，1..${BOX_TIMES_MAX}；不足 1 角色 + 3 技能时自动补齐并说明）
  --tier <t>      段位/掉落池门控：${TIERS.join('|')}（默认 mythic）
  --preset <p>    内置 AI 预设：steady(稳健)|aggressive(激进)|kite(风筝)（默认 steady）
  --quality <q>   装配选取的品质门槛（默认无门槛；达标不足时回落到仓库最优并说明）
  --out <file>    把生成的 {loadout, warehouse} 写盘（可直接喂给 cli battle --p1/--p2）
  -h, --help      本帮助

示例：
  npm run play
  npm run play -- --seed 7 --boxes 20 --preset kite --tier epic
  npm run play -- --out runtime/play-loadout.json`;

function parseArgs(argv) {
  const out = { seed: DEFAULT_SEED, boxes: DEFAULT_BOXES, tier: 'mythic', preset: 'steady', quality: null, out: null, help: false, bad: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--seed') out.seed = Number(argv[++i]);
    else if (a === '--boxes') out.boxes = Number(argv[++i]);
    else if (a === '--tier') out.tier = argv[++i];
    else if (a === '--preset') out.preset = argv[++i];
    else if (a === '--quality') out.quality = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (out.bad === null) out.bad = a;
  }
  return out;
}

// 参数校验 → null（合法）或错误说明
function validateArgs(a) {
  if (!Number.isInteger(a.seed) || a.seed < 1) return `--seed 必须是正整数（当前 ${JSON.stringify(a.seed)}）`;
  if (!Number.isInteger(a.boxes) || a.boxes < 1 || a.boxes > BOX_TIMES_MAX) return `--boxes 必须是 1..${BOX_TIMES_MAX} 的整数（当前 ${JSON.stringify(a.boxes)}）`;
  if (unlock.tierIndex(a.tier) === null) return `--tier 非法（可选 ${TIERS.join('/')}；当前 ${JSON.stringify(a.tier)}）`;
  if (!PRESETS.includes(a.preset)) return `--preset 非法（可选 ${PRESETS.join('/')}；当前 ${JSON.stringify(a.preset)}）`;
  if (a.quality !== null && unlock.tierIndex(a.quality) === null) return `--quality 非法（可选 ${TIERS.join('/')}；当前 ${JSON.stringify(a.quality)}）`;
  if (a.out !== null && (typeof a.out !== 'string' || a.out.trim() === '')) return '--out 需要文件路径';
  return null;
}

// ---------- 开箱与仓库（与 server/box.js 同一 rng 流口径：第 i 箱 = deriveStream(i,'box')）----------

function openIntoWarehouse(rng, tier, count, wh, from) {
  const opened = [];
  for (let i = 0; i < count; i++) {
    const item = items.openBox(rng.deriveStream(from + i, 'box'), { tier });
    opened.push(item);
    if (!Array.isArray(wh.buckets[item.kind])) wh.buckets[item.kind] = [];
    wh.buckets[item.kind].push(item);
  }
  return opened;
}

const bucketCount = (wh, kind) => ((wh.buckets[kind] || []).length);

// 仓库内按 uid 找物品：复用 loadout.js 导出的 findItem（与 core items.findItem 同语义，避免第三份实现）
const findItem = loadoutApi.findItem;

// ---------- 自动装配（items.assemble 语义：槽位类型匹配 + 段位门控 + 点数预算 + 唯一性）----------

function labelOf(item) {
  return `${item.name || item.templateId || item.uid}（${item.quality || '?'}${item.tier ? ` tier${item.tier}` : ''}）`;
}

function pickPlugin(wh, kind, slotType) {
  for (const p of (wh.buckets[kind] || [])) {
    if (!p || p.equipped === true) continue;      // 已被装走（唯一性）
    if (p.slot !== slotType) continue;            // 槽位类型不匹配
    return p;
  }
  return null;
}

function autoAssemble(wh, tier) {
  const placed = [];
  const skipped = [];
  let cur = wh;
  const targets = (wh.buckets.role || []).concat(wh.buckets.skill || []);
  for (const t0 of targets) {
    const slotCount = Array.isArray(t0.slots) ? t0.slots.length : 0;
    for (let i = 0; i < slotCount; i++) {
      const target = findItem(cur, t0.uid);
      if (!target) break;
      const slot = (target.slots || [])[i];
      if (!slot || slot.pluginUid) continue;      // 槽位已占用
      const pluginKind = target.kind === 'role' ? 'rolePlugin' : 'skillPlugin';
      const cand = pickPlugin(cur, pluginKind, slot.type);
      const where = `${labelOf(target)}[${slot.type}]`;
      if (!cand) { skipped.push({ where, reason: '仓库里没有该槽位类型的插件' }); continue; }
      const r = items.assemble(cur, { targetUid: target.uid, pluginUid: cand.uid, slotIndex: i, tier });
      if (r.ok) { cur = r.warehouse; placed.push({ where, plugin: cand, cost: cand.pointCost }); }
      else skipped.push({ where, reason: `${r.code}: ${r.message}`, plugin: cand });
    }
  }
  return { warehouse: cur, placed, skipped };
}

// ---------- 出战选取（角色 1 + 技能恰 3；可选品质门槛）----------

const qIdxOf = (q) => { const i = TIERS.indexOf(q); return i === -1 ? -1 : i; };

function selectByQuality(bucket, floorIdx, count, cmp) {
  const sorted = bucket.slice().sort(cmp);
  if (floorIdx === null) return { chosen: sorted.slice(0, count), short: false };
  const above = sorted.filter((x) => qIdxOf(x.quality) >= floorIdx);
  const chosen = above.slice(0, count);
  const rest = sorted.filter((x) => !chosen.includes(x));
  while (chosen.length < count && rest.length > 0) chosen.push(rest.shift());
  return { chosen, short: above.length < count };
}

// ---------- 内置预设 AI（只用 base 节点 + if：任意段位可校验通过；version 2 = 当前版本）----------

const lit = (value) => ({ type: 'literal', value });
const get = (p) => ({ type: 'get', path: p });
const act = (name) => ({ type: 'action', name });
const seq = (statements) => ({ type: 'seq', statements });
const cmp = (op, left, right) => ({ type: 'cmp', op, left, right });
const arith = (op, left, right) => ({ type: 'arith', op, left, right });
const ifElse = (cond, thenN, elseN) => ({ type: 'if', cond, then: thenN, else: elseN });
const programOf = (body) => ({ type: 'program', version: 2, body });
const gapExpr = () => arith('-', get('enemy.x'), get('self.x')); // 敌我 x 差（正 = 敌在右侧）

// slots = [{action:'skill:skill1', type:'straight'}, ...]（顺序 = 出战槽 1..3）
function buildPreset(preset, slots) {
  const p1 = slots[0].action;
  const p2 = slots[1].action;
  const p3 = slots[2].action;
  if (preset === 'steady') {
    // 稳健：残血先防 → 拉近到中距 → 背后则转身靠近 → 否则主技能开火
    return programOf(seq([
      ifElse(cmp('<', get('self.hp'), lit(30)), seq([act('defend')]),
        seq([ifElse(cmp('>', gapExpr(), lit(224)), seq([act('move_right')]),
          seq([ifElse(cmp('<', gapExpr(), lit(-224)), seq([act('move_left')]),
            seq([act(p1)]))]))])),
    ]));
  }
  if (preset === 'aggressive') {
    // 激进：贴脸为主，够近就交二技能，残血也继续压上（不给自己留退路）
    return programOf(seq([
      ifElse(cmp('>', gapExpr(), lit(96)), seq([act('move_right')]),
        seq([ifElse(cmp('<', gapExpr(), lit(-96)), seq([act('move_left')]),
          seq([act(p2)]))])),
    ]));
  }
  // 风筝：太近就拉开（有位移技能用位移，否则后撤）→ 太远就靠近 → 射程内开火
  const escape = slots[2].type === 'displacement' ? p3 : 'move_left';
  return programOf(seq([
    ifElse(cmp('<', gapExpr(), lit(224)), seq([act(escape)]),
      seq([ifElse(cmp('>', gapExpr(), lit(448)), seq([act('move_right')]),
        seq([act(p1)]))])),
  ]));
}

// ---------- 打印 ----------

function fmtStats(s) {
  return `hp ${s.hp}  atk ${s.atk}  def ${s.def}  sp ${s.sp}  mp ${s.mp}`;
}

function fmtRegen(regen) {
  const parts = Object.keys(regen || {}).filter((k) => regen[k]);
  return parts.length ? parts.map((k) => `${k} +${regen[k]}`).join(' / ') : '无';
}

function fmtSpecial(special) {
  const keys = Object.keys(special || {});
  if (keys.length === 0) return '无';
  return keys.map((k) => `${k} ${Number(special[k]).toFixed(2)}`).join('  ');
}

function fmtSkillParam(sid, sk) {
  const pr = (sk && sk.params) || {};
  const cost = pr.cost ? `hp${pr.cost.hp}/mp${pr.cost.mp}/sp${pr.cost.sp}` : '?';
  const range = pr.range === undefined ? '' : `  射程 ${Array.isArray(pr.range) ? pr.range.join('..') : pr.range}`;
  return `${sid}  ${pr.multiplier === undefined ? '?' : Number(pr.multiplier).toFixed(2)} 倍率  消耗 ${cost}  冷却 ${pr.cooldown}${range}`;
}

function main() {
  const out = (s) => process.stdout.write(`${s}\n`);
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { out(USAGE); return 0; }
  const bad = args.bad !== null ? `未知参数 ${args.bad}` : validateArgs(args);
  if (bad !== null) { out(`${bad}\n\n${USAGE}`); return 2; }

  const { seed, tier, preset } = args;
  const floorIdx = args.quality === null ? null : qIdxOf(args.quality);
  out('=== Debug-Lite 离线试玩（脚本版：不依赖前端/账号/存档/匹配） ===');
  out(`seed=${seed}  段位=${tier}  开箱=${args.boxes}  预设=${preset}(${PRESET_LABEL[preset]})  品质门槛=${args.quality || '无'}  仓库=内存`);

  // [1] 开箱
  const rng = createRng(seed);
  const wh = items.emptyWarehouse();
  let opened;
  try {
    opened = openIntoWarehouse(rng, tier, args.boxes, wh, 0);
    // 补齐：出战需 1 角色 + 3 技能（不足则继续开箱；确定性来自同一 seed 流的后续箱号）
    let extra = 0;
    while ((bucketCount(wh, 'role') < 1 || bucketCount(wh, 'skill') < 3) && args.boxes + extra < TOPUP_CAP) {
      opened = opened.concat(openIntoWarehouse(rng, tier, 1, wh, args.boxes + extra));
      extra += 1;
    }
    if (extra > 0) {
      out(`[1/6] 开箱：请求 ${args.boxes} 次；出战材料不足（需 ≥1 角色 + ≥3 技能），按同一 seed 流补齐 ${extra} 次 → 共 ${args.boxes + extra} 箱`);
    } else {
      out(`[1/6] 开箱：${args.boxes} 次（每次一箱，独立 rng 流 deriveStream(i,'box')；与 POST /api/v1/box 同口径）`);
    }
  } catch (e) {
    out(`[1/6] 开箱失败：${e.message}（段位 ${tier} 的掉落池为空？）`);
    return 1;
  }
  const shown = opened.slice(0, 4);
  for (const it of shown) out(`        · ${it.kind}  ${labelOf(it)}`);
  if (opened.length > shown.length) out(`        · …其余 ${opened.length - shown.length} 件见下方仓库统计`);

  // [2] 仓库合并
  const kinds = Object.keys(wh.buckets);
  out(`[2/6] 仓库合并（内存，不依赖尚不存在的服务端仓库）：${kinds.map((k) => `${k} ${wh.buckets[k].length}`).join('  ')}`);
  if (bucketCount(wh, 'role') < 1 || bucketCount(wh, 'skill') < 3) {
    out(`        出战材料仍不足（角色 ${bucketCount(wh, 'role')} / 技能 ${bucketCount(wh, 'skill')}）→ 无法组队`);
    return 1;
  }

  // [3] 自动装配
  const asm = autoAssemble(wh, tier);
  const wh2 = asm.warehouse;
  out(`[3/6] 自动装配（槽位类型 + 段位门控 + 点数预算 + 插件唯一性；失败即跳过并说明）：成功 ${asm.placed.length} 件，跳过 ${asm.skipped.length} 处`);
  for (const p of asm.placed.slice(0, 6)) {
    out(`        ✔ ${labelOf(p.plugin)}${p.cost === undefined ? '' : `（${p.cost} 点）`} → ${p.where}`);
  }
  if (asm.placed.length > 6) out(`        ✔ …其余 ${asm.placed.length - 6} 件已装配`);
  for (const s of asm.skipped.slice(0, 3)) {
    out(`        ✘ ${s.plugin ? `${labelOf(s.plugin)} → ` : ''}${s.where}：${s.reason}（跳过）`);
  }
  if (asm.skipped.length > 3) {
    const rest = new Map();
    for (const s of asm.skipped.slice(3)) rest.set(s.reason, (rest.get(s.reason) || 0) + 1);
    out(`        ✘ …其余 ${asm.skipped.length - 3} 处跳过：${[...rest.entries()].map(([r, n]) => `${r} ×${n}`).join('；')}`);
  }

  // [4] 出战选取（角色 = 品质最优；技能按 类型偏好 排序取 3）
  const rolePick = selectByQuality(wh2.buckets.role, floorIdx, 1,
    (a, b) => (qIdxOf(b.quality) - qIdxOf(a.quality)) || String(a.uid).localeCompare(String(b.uid)));
  const role = rolePick.chosen[0];
  const picked = selectByQuality(wh2.buckets.skill, floorIdx, 3, cmpSkill);
  const skills = picked.chosen;
  out(`[4/6] 出战选取：角色 ${labelOf(role)}；技能 ${skills.map((s, i) => `skill${i + 1}=${s.name || s.templateId}(${SKILL_TYPES[s.templateId] || '?'})`).join('  ')}`);
  if (floorIdx !== null && (rolePick.short || picked.short)) {
    out(`        ⚠ 品质门槛 ${args.quality} 下的达标物品不足，已回落到仓库内最优（确定性顺序：类型偏好 → 品质 → uid）`);
  }
  out('        说明：引擎只认动作名 `skill:<sid>`；本脚本按出战槽位把 3 个技能命名为 skill1/skill2/skill3');

  const program = buildPreset(preset, skills.map((s, i) => ({ action: `skill:skill${i + 1}`, type: SKILL_TYPES[s.templateId] || s.type })));
  const loadout = { role, skills, ai: program };
  const panel = loadoutApi.buildPanel(loadout, { warehouse: wh2, tier });
  if (!panel.ok) {
    out(`[4/6] 出战配置校验失败（loadout_invalid）：`);
    for (const e of panel.errors) out(`        ✘ ${e.where}: ${e.code} ${e.message}`);
    return 1;
  }

  // [5] 面板
  out('[5/6] 角色面板（最终数值 = 物品五维 + 已装角色插件词条；技能参数 = 模板 + 技能插件聚合）');
  out(`        角色：${role.name || role.templateId}（${role.templateId}，${role.quality}）  插件点数预算 ${role.pluginPoints}`);
  out(`        五维：${fmtStats(panel.panel.role.stats)}`);
  out(`        regen：${fmtRegen(panel.panel.role.regen)} 每 tick`);
  out(`        special：${fmtSpecial(panel.panel.role.special)}`);
  for (let i = 0; i < panel.panel.skills.length; i++) {
    out(`        技能参数：${fmtSkillParam(`skill${i + 1}`, panel.panel.skills[i])}`);
  }

  // [6] 打一场：对手 = server/ranked.js 的内置 bot（不新增服务端接口）
  const bot = ranked.buildBotLoadout();
  out(`[6/6] 战斗：seed=${seed}  我方 p1（预设 ${preset}/${PRESET_LABEL[preset]}） vs p2 内置 bot（${bot.role.templateId}/${bot.role.quality}，直线逼近、无插件）`);
  const r = battle.runBattle({ p1: loadout, p2: bot, warehouse: wh2, seed, tier });
  if (r.status !== 200) {
    out(`        对战被拒绝：${r.status} ${r.code} ${r.message || ''}`);
    if (r.details) for (const e of r.details) out(`        ✘ ${e.where}: ${e.code} ${e.message}`);
    return 1;
  }
  const { frames, winner, ticks, phase } = r.data;
  out('        战报格式：tick N: p1 x/hp/mp/sp | p2 x/hp/mp/sp | 碰撞@x | 命中[uid->目标@坐标->攻方->受方 伤害 (暴击×1.5 背击×1.5)] | 伤害[无弹幕归属的伤害：碰撞/附加真伤]');
  let dmgEvents = 0;
  let bulletHits = 0;
  let crits = 0;
  let backstabs = 0;
  for (const f of frames) {
    out(`        ${replayLine(f)}`);
    for (const e of (f.diff.events || [])) {
      if (!e || e.channel !== 'damage' || e.event !== 'damage.calc' || !e.data) continue;
      dmgEvents += 1;
      if (e.data.hitUid) bulletHits += 1;
      if (e.data.crit) crits += 1;
      if (e.data.backstab) backstabs += 1;
    }
  }
  const who = winner === 'p1' ? `我方 A 胜（预设 ${preset}）` : winner === 'p2' ? '内置 bot B 胜' : '平局/未分出胜负';
  out(`        结果：${who}  共 ${ticks} tick  phase=${phase}  seed=${seed}`);
  out(`        统计：伤害结算 ${dmgEvents} 次（其中带弹幕 id 的命中 ${bulletHits} 次）；暴击 ${crits} 次、背击 ${backstabs} 次`);
  if (crits === 0 && backstabs === 0) {
    out('        说明：暴击需 special.critChance > 0（装到「暴击」类角色插件才有）；背击需攻击方向与受击方朝向相同（追尾）。');
    out('              本局两者皆未触发——标注渲染由 tests/cli/cli-replay.test.js 的合成帧用例钉死，真实触发时自动出现。');
  }

  if (args.out !== null) {
    const file = path.resolve(args.out);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ loadout, warehouse: wh2 }, null, 2), 'utf8');
      out(`        已写出战配置：${file}`);
      out(`        （可直接喂给 CLI：先 npm start，再 npm run cli -- battle --p1 ${args.out} --p2 ${args.out} --seed ${seed} --tier ${tier}）`);
    } catch (e) {
      out(`        写出战配置失败：${e.message}`);
      return 1;
    }
  }
  out('=== 试玩结束：开箱 → 装配 → 面板 → 战斗逐 tick → 胜负，全流程离线完成 ===');
  return 0;
}

// 技能排序：类型偏好（远→近）→ 品质（高→低）→ uid（稳定）
function cmpSkill(a, b) {
  const ta = skillTypeScore(a);
  const tb = skillTypeScore(b);
  if (ta !== tb) return ta - tb;
  const qd = qIdxOf(b.quality) - qIdxOf(a.quality);
  if (qd !== 0) return qd;
  return String(a.uid).localeCompare(String(b.uid));
}

// 技能类型：优先物品自带 type；开箱产物无 type → 按 templateId 查模板表
function skillTypeScore(s) {
  const type = (s && s.type) || SKILL_TYPES[s && s.templateId] || 'unknown';
  const sc = TYPE_SCORE[type];
  return sc === undefined ? 4 : sc;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { parseArgs, validateArgs, buildPreset, autoAssemble, cmpSkill, skillTypeScore, labelOf };
