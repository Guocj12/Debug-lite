'use strict';
/* scripts/fe-spec-check.js —— 前端文档自检器（P6 前端重设计配套，docs/frontend-spec.md §14）
 *
 * 目的：让 docs/frontend-spec.md 无法"写完就过期"。前两轮前端失败的根因是**文档与实现/真实响应脱节**
 * （字段名不存在、按钮无动作、动作无实现），本检查把这几类问题变成机器可判定的失败。
 *
 * C1 注册表可解析（JSON 合法、字段齐全）
 * C2 每个按钮的 action 都在动作表内
 * C3 每个动作都被至少一个按钮使用（无僵尸动作，toast/close 等系统动作除外）
 * C4 七屏齐全且每屏都有 goto 入口
 * C5 文档引用的每个数据字段都存在于 .audit/fe-samples.json 的真实响应样本中
 * C6 注册表取值与后端实现一致（段位 / 对手 / 品质与颜色 / AI 节点白名单 / 动作名 / 提示门槛）
 * C7 分层文件清单与文中提到的 public/js 文件一致
 * C8 日志事件名符合 <channel>.<name> 且通道已注册（shared/log.js）
 * C9 若 public/js 已存在实现：data-action 必须命中动作表、data-id 必须命中注册表
 *
 * 用法：node scripts/fe-spec-check.js     （退出码 0 = 全绿；1 = 有 FAIL）
 * 契约：tests/frontend/fe-spec.test.js 以断言方式跑同一函数（保证 npm test 覆盖）。
 * 维护：样本过期时重跑 `node .audit/fe-samples.js`；本文件属 scripts 层（不进 core/ai 分层表）。
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const SPEC = path.join(REPO, 'docs', 'frontend-spec.md');
const SAMPLES = path.join(REPO, '.audit', 'fe-samples.json');
const SCREEN_IDS = ['menu', 'gacha', 'warehouse', 'editor', 'battle', 'replay', 'settings'];

// 允许"无按钮引用"的系统动作（由 toast/弹窗/副作用内部触发）
const SYSTEM_ACTIONS = new Set(['toast/close']);

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

// ---------- 文本解析工具 ----------

// 抽出 ```<lang> <fenceName> … ``` 围栏内容
// 抽出 ```<lang> <fenceName> … ``` 围栏内容（lang 可省略；名与围栏间至少一个空格）
// 实现要点：**先定位开栏行**（indexOf），再从该行之后找闭栏 —— 不用单个正则跨围栏匹配
// （正则会从更早的 ``` 开始匹配，把两段围栏之间的正文吞进内容里，静默取到错内容）
function fenced(text, lang, name) {
  const label = '```' + (lang || '') + (lang ? ' ' : '') + name;
  const start = text.indexOf(label);
  if (start === -1) return null;
  const afterLabel = start + label.length;
  const nl = text.indexOf('\n', afterLabel);
  if (nl === -1) return null;
  // 标签行与内容之间只允许空白/换行差异（防止匹配到 `foo public/` 这类前缀）
  if (!/^[ \t]*$/.test(text.slice(afterLabel, nl))) return null;
  const end = text.indexOf('```', nl + 1);
  if (end === -1) return null;
  return text.slice(nl + 1, end);
}

// 抽取 markdown 表格（去掉加粗/反引号）；返回 [{line, cells:[]}]
// 两种形态都支持：
//  ① 多列表：`| a | b |` + 分隔行 `|---|---|`
//  ② 单列约定表：标题行（如 `| 通道 |`）后每行一个值，行内允许反引号/斜杠/空格（如 `store.boot` / `store.dispatch`）
function tableRows(text, headerFirstCell) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i];
    if (!t.startsWith('|')) continue;
    const cells = splitCells(t);
    if (cells[0].replace(/[*`]/g, '') !== headerFirstCell) continue;
    // 向后收集本表体
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const b = lines[j];
      if (b === '' || b.startsWith('```') || /^#{1,6}\s/.test(b)) break;
      if (!b.startsWith('|')) {
        if (cells.length === 1) { body.push(b); continue; } // 单列表：裸行也算内容
        break;
      }
      const bc = splitCells(b);
      if (bc.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))) continue; // 分隔行
      body.push(bc.length === 1 ? bc[0] : bc);
    }
    if (cells.length === 1) {
      for (const item of body) {
        if (typeof item === 'string' && item !== '') rows.push({ line: item, cells: [item] });
      }
    } else {
      for (const item of body) {
        if (Array.isArray(item)) rows.push({ line: item.join(' | '), cells: item });
      }
    }
  }
  return rows;
}

function splitCells(line) {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function unquote(s) {
  return String(s).replace(/[*`]/g, '').trim();
}

// 从 "`a` / `b` / `c`" 形式抽取值序列（必须全局匹配，否则 matchAll 抛错）
function tickValues(cell) {
  return [...String(cell).matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

// 从 "['a','b']" 或 "`a` | `b`" 形式抽取值序列
function looseValues(cell) {
  const ticks = tickValues(cell);
  if (ticks.length) return ticks;
  return [...String(cell).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// ---------- 各检查项 ----------

function loadRegistry(specFile) {
  const text = read(specFile || SPEC);
  const raw = fenced(text, 'json', 'fe-spec-registry');
  if (!raw) return { error: `${path.relative(REPO, specFile || SPEC)} 缺少 \`\`\`json fe-spec-registry 围栏（注册表）` };
  let reg;
  try {
    reg = JSON.parse(raw);
  } catch (e) {
    return { error: `注册表 JSON 解析失败: ${e.message}` };
  }
  return { text, reg };
}

function checkC1(text, reg) {
  const problems = [];
  if (!Array.isArray(reg.screens) || reg.screens.length === 0) problems.push('screens 缺失或为空');
  if (!Array.isArray(reg.actions) || reg.actions.length === 0) problems.push('actions 缺失或为空');
  if (!Array.isArray(reg.dataFields)) problems.push('dataFields 缺失');
  if (!Array.isArray(reg.screensRequired)) problems.push('screensRequired 缺失');
  for (const s of reg.screens || []) {
    if (!s.id || !s.title) problems.push(`screen 缺 id/title: ${JSON.stringify(s).slice(0, 60)}`);
    if (!Array.isArray(s.buttons) || s.buttons.length === 0) problems.push(`screen ${s.id} 无按钮`);
    const seen = new Set();
    for (const b of s.buttons || []) {
      if (!b.dataId || !b.action || !b.label) { problems.push(`screen ${s.id} 有按钮缺 dataId/action/label`); continue; }
      if (seen.has(b.dataId)) problems.push(`screen ${s.id} 内 dataId 重复: ${b.dataId}`);
      seen.add(b.dataId);
    }
  }
  for (const a of reg.actions || []) {
    if (!a.type || typeof a.effect !== 'boolean' || !a.desc) problems.push(`action 缺 type/effect/desc: ${JSON.stringify(a).slice(0, 60)}`);
  }
  for (const f of reg.dataFields || []) {
    if (!f.sample || !f.path) problems.push(`dataField 缺 sample/path: ${JSON.stringify(f).slice(0, 60)}`);
  }
  // 七屏名必须与 §1.1 一致（文中出现 `` `menu`（主菜单） `` 这类描述，改用注册表自身与常量比对）
  const ids = (reg.screens || []).map((s) => s.id).filter((id) => id !== 'shell');
  for (const id of SCREEN_IDS) {
    if (!ids.includes(id)) problems.push(`注册表缺少屏幕 ${id}`);
  }
  if (problems.length) return fail('C1', problems.join('；'));
  return pass('C1', `注册表可解析：${reg.screens.length} 个屏 / ${reg.actions.length} 个动作 / ${reg.dataFields.length} 个字段引用`);
}

function checkC2(reg) {
  const known = new Set(reg.actions.map((a) => a.type));
  const problems = [];
  for (const s of reg.screens) {
    for (const b of s.buttons) {
      if (!known.has(b.action)) problems.push(`${s.id}.${b.dataId} → 未登记动作 '${b.action}'`);
    }
  }
  if (problems.length) return fail('C2', problems.join('；'));
  return pass('C2', `${reg.screens.reduce((n, s) => n + s.buttons.length, 0)} 个按钮全部命中动作表（无死按钮）`);
}

function checkC3(reg) {
  const used = new Set();
  for (const s of reg.screens) for (const b of s.buttons) used.add(b.action);
  const zombies = reg.actions.map((a) => a.type).filter((t) => !used.has(t) && !SYSTEM_ACTIONS.has(t));
  if (zombies.length) return fail('C3', `无按钮使用的僵尸动作: ${zombies.join('、')}`);
  return pass('C3', `${reg.actions.length} 个动作均有按钮引用（系统动作 ${[...SYSTEM_ACTIONS].join('/')} 除外）`);
}

function checkC4(reg) {
  const problems = [];
  const ids = new Set(reg.screens.map((s) => s.id));
  for (const id of SCREEN_IDS) {
    if (!ids.has(id)) problems.push(`缺屏幕 ${id}`);
  }
  for (const s of reg.screens) {
    if (!s.buttons.some((b) => b.action === 'goto' || b.action === 'retry_boot')) {
      problems.push(`${s.id} 没有任何 goto 出口按钮（进去出不来）`);
    }
  }
  // 可达性：从 menu 出发按 goto 图遍历，七屏都必须可达
  const graph = new Map();
  for (const s of reg.screens) {
    graph.set(s.id, s.buttons.filter((b) => b.action === 'goto' && b.payload && b.payload.screen).map((b) => b.payload.screen));
  }
  const seen = new Set(['menu']);
  const queue = ['menu'];
  while (queue.length) {
    const cur = queue.shift();
    for (const nxt of graph.get(cur) || []) if (!seen.has(nxt)) { seen.add(nxt); queue.push(nxt); }
  }
  for (const id of SCREEN_IDS) {
    if (!seen.has(id)) problems.push(`${id} 从 menu 不可达（缺 goto 路径）`);
  }
  // 所有 goto 目标必须存在
  for (const s of reg.screens) {
    for (const b of s.buttons) {
      if (b.action === 'goto' && b.payload && b.payload.screen && !ids.has(b.payload.screen)) {
        problems.push(`${s.id}.${b.dataId} goto 目标不存在: ${b.payload.screen}`);
      }
    }
  }
  if (problems.length) return fail('C4', problems.join('；'));
  return pass('C4', `七屏齐全：goto 目标存在 + 从 menu 全部可达 + 每屏都有出口`);
}

function resolvePath(obj, dotted) {
  const segs = String(dotted).replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x !== '');
  let cur = obj;
  for (const seg of segs) {
    if (cur === null || cur === undefined) return { found: false, at: seg };
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, at: `${seg}（数组越界/非数字）` };
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return { found: false, at: `${seg}（父级不是对象）` };
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, at: seg };
    cur = cur[seg];
  }
  return { found: true, value: cur };
}

function checkC5(reg, opts) {
  const samplesFile = (opts && opts.samplesFile) || SAMPLES;
  if (!fs.existsSync(samplesFile)) {
    return fail('C5', `缺少真实响应样本 ${path.relative(REPO, samplesFile)}（先跑 node .audit/fe-samples.js）`);
  }
  let samples;
  try {
    samples = JSON.parse(read(samplesFile));
  } catch (e) {
    return fail('C5', `样本文件解析失败: ${e.message}`);
  }
  const problems = [];
  for (const f of reg.dataFields) {
    const sample = samples[f.sample];
    if (sample === undefined) { problems.push(`样本 ${f.sample} 不存在（字段 ${f.path}）`); continue; }
    const r = resolvePath(sample, f.path);
    if (!r.found) problems.push(`${f.sample} 缺字段 ${f.path}（断在 '${r.at}'）`);
  }
  // 反向：注册表用到的样本必须都在文件里
  const usedSamples = new Set(reg.dataFields.map((f) => f.sample));
  if (problems.length) return fail('C5', problems.join('；'));
  return pass('C5', `${reg.dataFields.length} 个字段引用全部命中 ${usedSamples.size} 个真实响应样本`);
}

function checkC6(reg, text) {
  const problems = [];
  const notes = [];
  const controls = reg.controls || {};
  // ① 段位：后端 TIERS 顺序 === 注册表 controls.tiers === 文中段位控件行
  const unlock = require(path.join(REPO, 'server', 'core', 'unlock.js'));
  const tiers = unlock.TIERS || ['common', 'rare', 'epic', 'legendary', 'mythic'];
  if (JSON.stringify(controls.tiers) !== JSON.stringify(tiers)) {
    problems.push(`注册表 controls.tiers 与后端不一致：${JSON.stringify(controls.tiers)} vs ${JSON.stringify(tiers)}`);
  }
  const tierRow = tableRows(text, '元素').find((r) => /段位/.test(r.cells[0]));
  if (tierRow) {
    // §7 顶栏控件表的列：元素 | data-id | 数据源 | 行为 —— 段位取值写在"行为"列（过滤动作名/字段名）
    const specTiers = tickValues(tierRow.cells[3] || '').filter((v) => !v.includes('/') && !v.includes('.'));
    if (specTiers.join(',') !== tiers.join(',')) {
      problems.push(`§7 段位下拉取值与后端 TIERS 不一致：文中 [${specTiers.join(',')}] vs 后端 [${tiers.join(',')}]`);
    }
  } else {
    problems.push('文中未找到"段位"控件行（§7 顶栏控件表）');
  }
  notes.push(`段位 ${tiers.length} 档一致`);

  // ② AI 节点白名单：ast.NODE_TYPES === 注册表 controls.aiNodes === 文中 §12.3 节点表
  const ast = require(path.join(REPO, 'server', 'ai', 'ast.js'));
  const sourceNodes = [...ast.NODE_TYPES];
  const regNodes = controls.aiNodes || [];
  const missingInReg = sourceNodes.filter((n) => !regNodes.includes(n));
  const extraInReg = regNodes.filter((n) => !ast.NODE_TYPES.has(n));
  if (missingInReg.length) problems.push(`注册表 controls.aiNodes 缺后端节点: ${missingInReg.join('、')}`);
  if (extraInReg.length) problems.push(`注册表 controls.aiNodes 有后端不认的节点: ${extraInReg.join('、')}`);
  const specNodes = new Set();
  for (const r of tableRows(text, '类别')) {
    // §12.3 节点表的列：类别 | 节点 | 表达式/语句 | 关键字段 —— 节点名在第 2 列
    for (const v of tickValues(r.cells[1] || '')) {
      if (ast.NODE_TYPES.has(v)) specNodes.add(v);
    }
  }
  const missingInDoc = sourceNodes.filter((n) => !specNodes.has(n));
  if (missingInDoc.length) problems.push(`§12.3 节点表缺少白名单节点: ${missingInDoc.join('、')}`);
  notes.push(`AI 节点 ${sourceNodes.length} 类一致`);

  // ③ 动作名：engine.ACTIONS + skill:skillN，注册表与文中 §12.4 三处一致
  const engineSrc = read(path.join(REPO, 'server', 'core', 'engine.js'));
  const m = /const ACTIONS = new Set\(\[([^\]]+)\]\)/.exec(engineSrc);
  const engineActions = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  if (engineActions.length === 0) problems.push('无法从 engine.js 解析 ACTIONS 白名单');
  if (JSON.stringify(controls.actionNames) !== JSON.stringify(engineActions)) {
    problems.push(`注册表 controls.actionNames 与引擎 ACTIONS 不一致：${JSON.stringify(controls.actionNames)} vs ${JSON.stringify(engineActions)}`);
  }
  const flatSpecActions = new Set();
  for (const key of ['移动', '转向', '闪避', '其他']) {
    const row = tableRows(text, '分类').find((r) => r.cells[0].includes(key));
    if (!row) { problems.push(`§12.4 动作表缺少「${key}」行`); continue; }
    tickValues(row.cells[1]).forEach((v) => flatSpecActions.add(v));
  }
  for (const a of engineActions) {
    if (!flatSpecActions.has(a)) problems.push(`§12.4 动作表缺少引擎动作 '${a}'`);
  }
  const extra = [...flatSpecActions].filter((a) => !engineActions.includes(a));
  if (extra.length) problems.push(`§12.4 出现引擎不认的动作 '${extra.join('、')}'（引擎会归一化成 wait）`);
  const skillRow = tableRows(text, '分类').find((r) => r.cells[0].includes('技能'));
  const specSkills = skillRow ? tickValues(skillRow.cells[1]) : [];
  if (JSON.stringify(specSkills) !== JSON.stringify(controls.skillActions)) {
    problems.push(`§12.4 技能行动取值与注册表不一致：文中 [${specSkills.join(',')}] vs 注册表 [${(controls.skillActions || []).join(',')}]`);
  }
  notes.push(`动作名 ${engineActions.length} 项 + 技能 ${specSkills.length} 位一致`);

  // ④ 对手：runner.OPPONENTS === 注册表 controls.opponents === 文中登记
  const runner = require(path.join(REPO, 'server', 'runner.js'));
  const opps = Object.keys(runner.OPPONENTS);
  if (JSON.stringify(controls.opponents) !== JSON.stringify(opps)) {
    problems.push(`注册表 controls.opponents 与后端 OPPONENTS 不一致：${JSON.stringify(controls.opponents)} vs ${JSON.stringify(opps)}`);
  }
  const oppRowText = text.split(/\r?\n/).filter((l) => l.includes('battle_opp') || l.includes('对手：') || l.includes('opponent')).join('\n');
  const missingOpps = opps.filter((o) => !oppRowText.includes(o));
  if (missingOpps.length) problems.push(`文中未登记示例对手: ${missingOpps.join('、')}（后端 OPPONENTS=${opps.join('/')}）`);
  notes.push(`对手 ${opps.join('/')} 已登记`);

  // ⑤ 品质 id 与颜色：qualities.json ↔ 注册表 ↔ tokens.css 片段
  const qualities = require(path.join(REPO, 'server', 'data', 'qualities.json')).qualities;
  if (JSON.stringify(controls.qualities) !== JSON.stringify(qualities.map((q) => q.id))) {
    problems.push(`注册表 controls.qualities 与 qualities.json 不一致`);
  }
  const tokenBlock = fenced(text, 'css', 'tokens') || text;
  const badColors = [];
  const badIds = [];
  for (const q of qualities) {
    if (!tokenBlock.includes(q.color)) badColors.push(`${q.id}=${q.color}`);
    if (!new RegExp(`--q-${q.id}\\b`).test(tokenBlock)) badIds.push(q.id);
  }
  if (badColors.length) problems.push(`tokens.css 片段缺品质色: ${badColors.join('、')}`);
  if (badIds.length) problems.push(`tokens.css 片段缺品质令牌: ${badIds.join('、')}`);
  notes.push(`品质 ${qualities.length} 档颜色/令牌一致`);

  // ⑥ 战场几何/提示门槛：battle-config.json 关键值必须在附录出现
  const cfg = require(path.join(REPO, 'server', 'data', 'battle-config.json'));
  const specTail = text.slice(text.indexOf('## 附录 A'));
  for (const k of ['fieldPx', 'cellPx', 'actorHalfPx', 'baseDef', 'hardCapTick']) {
    if (!specTail.includes(`${k}`) || !specTail.includes(String(cfg[k]))) {
      problems.push(`附录 A 未引用 battle-config.${k}=${cfg[k]}`);
    }
  }
  if (!String(tokenBlock).includes(String(cfg.fieldPx)) || !String(tokenBlock).includes(String(cfg.cellPx))) {
    problems.push(`tokens 片段未引用 battle-config 的 fieldPx/cellPx（${cfg.fieldPx}/${cfg.cellPx}）`);
  }
  notes.push('战场几何常量已引用');

  // ⑦ 开箱次数上限与 box.js 一致
  const box = require(path.join(REPO, 'server', 'box.js'));
  if (!new RegExp(`1[..]{1,2}${box.BOX_TIMES_MAX}|BOX_TIMES_MAX=${box.BOX_TIMES_MAX}|上限.*${box.BOX_TIMES_MAX}`).test(text)) {
    problems.push(`文中未登记开箱次数上限 BOX_TIMES_MAX=${box.BOX_TIMES_MAX}`);
  }
  notes.push(`开箱上限 ${box.BOX_TIMES_MAX} 一致`);

  // ⑧ 日志通道：注册表 controls.channels ⊆ shared/log.js 注册表
  const { CHANNELS } = require(path.join(REPO, 'shared', 'log.js'));
  const badChannels = (controls.channels || []).filter((c) => !CHANNELS.includes(c));
  if (badChannels.length) problems.push(`注册表 controls.channels 含未注册通道: ${badChannels.join('、')}`);
  notes.push(`日志通道 ${(controls.channels || []).length} 个已注册`);

  if (problems.length) return fail('C6', problems.join('；'));
  return pass('C6', notes.join('；'));
}

function checkC7(text) {
  const problems = [];
  const listed = new Set();
  // 清单行形如 `  js/api/client.js   说明文字`（两空格缩进 + 相对路径 + 说明）
  const block = fenced(text, '', 'public');  if (!block) problems.push('§1.2 未找到 ```public 目录清单围栏');
  if (block) {
    for (const line of block.split(/\r?\n/)) {
      const m = /^\s*([a-zA-Z0-9_./-]+\.(?:js|css|html))\s+\S/.exec(line) || /^\s*([a-zA-Z0-9_./-]+\.(?:js|css|html))\s*$/.exec(line);
      if (m && !m[1].includes('*')) listed.add('public/' + m[1]);
    }
  }
  // 清单内出现的具体路径（忽略通配符行，如 `js/views/*.js`）
  const mentioned = new Set();
  for (const line of (block || '').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_./-]+\.(?:js|css|html))(\s|$)/.exec(line);
    if (m && !m[1].includes('*')) mentioned.add('public/' + m[1]);
  }
  if (listed.size === 0) problems.push('§1.2 目录清单解析为空（围栏或缩进格式变了）');
  for (const f of mentioned) {
    if (!listed.has(f)) problems.push(`清单条目提取不一致: ${f}`);
  }
  // 磁盘上已有实现时，文件也必须在清单内
  const pubDir = path.join(REPO, 'public', 'js');
  if (fs.existsSync(pubDir)) {
    const walk = (dir) => {
      const out = [];
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...walk(p));
        else if (e.name.endsWith('.js')) out.push(p);
      }
      return out;
    };
    for (const abs of walk(pubDir)) {
      const rel = abs.split(path.sep).join('/').replace(/^.*?(public\/)/, 'public/');
      if (!listed.has(rel)) problems.push(`实现文件未在清单登记: ${rel}`);
    }
  }
  if (problems.length) return fail('C7', problems.join('；'));
  return pass('C7', `文件清单与文中引用一致（${listed.size} 个条目）`);
}

function checkC8(text) {
  const { CHANNELS } = require(path.join(REPO, 'shared', 'log.js'));
  const channelSet = new Set(CHANNELS);
  const problems = [];
  let count = 0;
  for (const r of tableRows(text, '通道')) {
    const channel = unquote(r.cells[0]);
    if (!channel || channel.includes(' ')) continue;
    if (!channelSet.has(channel)) { problems.push(`未注册通道 '${channel}'（§13.1）`); continue; }
    for (const ev of tickValues(r.cells[1] || '')) {
      count += 1;
      if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(ev)) {
        problems.push(`事件名不符合 name.dot.name: '${ev}'（通道 ${channel}）`);
      }
    }
  }
  if (count === 0) problems.push('§13.1 未列出任何日志事件');
  if (problems.length) return fail('C8', problems.join('；'));
  return pass('C8', `${count} 个日志事件名合规且通道已注册`);
}

function checkC9(reg) {
  const pubDir = path.join(REPO, 'public', 'js');
  if (!fs.existsSync(pubDir)) {
    return pass('C9', 'public/js 尚未实现（P6 未开工）；实现后本项自动生效');
  }
  const knownActions = new Set(reg.actions.map((a) => a.type));
  const ids = new Set();
  for (const s of reg.screens) for (const b of s.buttons) ids.add(b.dataId);
  const prefixOk = (id) => [...ids].some((k) => id === k || id.startsWith(k + '_'));
  const walk = (dir) => {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(p));
      else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
  };
  const problems = [];
  let actionCount = 0;
  let idCount = 0;
  for (const file of walk(pubDir)) {
    const src = read(file);
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    for (const m of src.matchAll(/data-action[="'\s:+]*['"`]?([a-z][a-z0-9/-]*)/g)) {
      actionCount += 1;
      if (!knownActions.has(m[1])) problems.push(`${rel}: data-action='${m[1]}' 不在动作表`);
    }
    for (const m of src.matchAll(/data-id[="'\s:+]*['"`]?([a-zA-Z0-9_$-]+)/g)) {
      idCount += 1;
      const id = m[1].replace(/\$\{[^}]*\}/g, '').replace(/_+$/, '');
      if (!id) continue;
      if (!prefixOk(id) && !ids.has(id)) problems.push(`${rel}: data-id='${m[1]}' 不在注册表`);
    }
  }
  if (problems.length) return fail('C9', problems.slice(0, 20).join('；'));
  return pass('C9', `实现侧 ${actionCount} 处 data-action / ${idCount} 处 data-id 全部命中注册表`);
}

// ---------- 结果与主流程 ----------

function pass(id, detail) { return { id, status: 'pass', detail }; }
function fail(id, detail) { return { id, status: 'fail', detail }; }

function checkSpec(options) {
  const opts = options || {};
  const specFile = opts.specFile || SPEC;
  if (!fs.existsSync(specFile)) return { ok: false, items: [fail('C0', `文档不存在: ${specFile}`)] };
  const text = read(specFile);
  const loaded = loadRegistry(specFile);
  if (loaded.error) return { ok: false, items: [fail('C1', loaded.error)] };
  const reg = loaded.reg;
  const items = [];
  items.push(checkC1(text, reg));
  if (items[0].status === 'fail') return { ok: false, items };
  for (const fn of [
    () => checkC2(reg),
    () => checkC3(reg),
    () => checkC4(reg),
    () => checkC5(reg, opts),
    () => checkC6(reg, text),
    () => checkC7(text),
    () => checkC8(text),
    () => checkC9(reg),
  ]) {
    try {
      items.push(fn());
    } catch (e) {
      items.push(fail('CX', `检查抛错: ${e.message}`));
    }
  }
  return { ok: items.every((i) => i.status === 'pass'), items };
}

function main() {
  const res = checkSpec({});
  for (const it of res.items) {
    console.log(`[${it.status === 'pass' ? 'PASS' : 'FAIL'}] ${it.id} ${it.detail}`);
  }
  console.log('---');
  console.log(`fe-spec-check: ${res.items.filter((i) => i.status === 'pass').length} PASS / ${res.items.filter((i) => i.status === 'fail').length} FAIL`);
  process.exitCode = res.ok ? 0 : 1;
  return res.ok ? 0 : 1;
}

module.exports = { checkSpec, SCREEN_IDS, SYSTEM_ACTIONS, resolvePath, tableRows, fenced, tickValues };

if (require.main === module) {
  main();
}
