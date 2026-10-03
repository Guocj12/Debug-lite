'use strict';
/* tools/layout/asset-manifest.js —— UI 素材清单生成器（**单一真源**：数据表 + 布局表 + 前端约定）
 *
 * 为什么需要：界面里每一处图片（角色立绘、技能图、品质框、段位图标、插件图、AI 积木图标、包图标、
 *   主界面按钮底图、背景图）都必须有确定的**文件路径与名字**。这个脚本把"到底缺哪些图"一次性算出来：
 *
 *   来源 ① 数据表（server/data/*.json）：每种角色/技能/插件/品质/段位/AI 节点/包 各一张图
 *   来源 ② 布局表（runtime/layout-bundle.raw.json → public/layout-data.js）：背景图 + 每个界面元素
 *          没有素材时，给它一个**建议文件名**（assets/ui/<元素id>.webp），你照着出图即可
 *   来源 ③ 前端约定（public/format.js 里拼的路径）：tier/frame/role/skill/ai 的命名规则
 *
 * 产物：
 *   · runtime/assets-manifest.json   （机器可读：给 AI 或后续脚本用）
 *   · docs/frontend/assets-manifest.md（人读：按类分组，标注"已有 / 缺"）
 *   · 控制台打印缺失清单（可直接照单出图）
 *
 * 用法：node tools/layout/asset-manifest.js [--json] [--quiet]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'server', 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const ASSET_ROOT = path.join(PUBLIC_DIR, 'assets');
const INBOX_DIR = path.join(ROOT, 'assets-inbox');

/** 图片规格建议（出图时照这个尺寸，不会糊也不会浪费） */
const SPEC = {
  bg: { size: '1920×1080', format: 'webp', note: '背景图，等比铺满（cover）' },
  role: { size: '512×512', format: 'webp', note: '角色立绘/图标，透明底，正方形' },
  skill: { size: '256×256', format: 'webp', note: '技能图标，透明底，正方形' },
  plugin: { size: '128×128', format: 'webp', note: '插件图标，透明底，正方形' },
  ai: { size: '128×128', format: 'webp', note: 'AI 积木节点图标，透明底' },
  package: { size: '256×256', format: 'webp', note: '包/宝箱图标，透明底' },
  ui: { size: '按元素框（见布局表 rect）', format: 'webp', note: '按钮/控件底图；不规则形状交 PNG 透明底，我会描出多边形' },
  frame: { size: '256×256', format: 'svg', note: '品质边框（矢量，颜色按 qualities.json 的 color）' },
  tier: { size: '64×64', format: 'svg', note: '段位图标（矢量，颜色按 qualities.json 的 color）' },
  sfx: { size: '—', format: 'mp3', note: '技能音效（可选；布局表暂时不用）' },
};

function readJsonIf(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/** 数据表里可能把列表放在具名键下（roleTemplates / skillTemplates / plugins / nodes / qualities / packages） */
function listOf(json, names) {
  if (!json) return [];
  for (const n of names) if (Array.isArray(json[n])) return json[n];
  for (const k of Object.keys(json)) if (Array.isArray(json[k]) && json[k].length && typeof json[k][0] === 'object' && json[k][0].id) return json[k];
  return [];
}

/** 布局表（优先用已生成的 layout-data.js；没有再退回布局台原始导出） */
function layoutBundle() {
  try { return require(path.join(PUBLIC_DIR, 'layout-data.js')); } catch (e) { /* 继续 */ }
  return readJsonIf(path.join(__dirname, 'layout-bundle.raw.json')) || readJsonIf(path.join(__dirname, 'layout-bundle.normalized.json'));
}

/** 元素 id → 安全的文件名（中文 id 也保留：文件名用中文没问题，但空格/斜杠要换掉） */
function safeName(id) {
  return String(id).trim().replace(/[\\/:*?"<>|\s]+/g, '_');
}

function collect() {
  const entries = [];
  const seen = new Set();
  const add = (e) => {
    if (!e || !e.path || seen.has(e.path)) return;
    seen.add(e.path);
    entries.push(e);
  };

  // ① 数据表
  const roles = listOf(readJsonIf(path.join(DATA_DIR, 'role-templates.json')), ['roleTemplates']);
  roles.forEach((r) => add({ path: 'assets/role/' + r.id + '.webp', kind: 'role', id: r.id, label: r.name, source: 'server/data/role-templates.json' }));
  const skills = listOf(readJsonIf(path.join(DATA_DIR, 'skill-templates.json')), ['skillTemplates']);
  skills.forEach((s) => add({ path: 'assets/skill/' + s.id + '.webp', kind: 'skill', id: s.id, label: s.name, source: 'server/data/skill-templates.json' }));
  skills.forEach((s) => { if (s.sfxKey) add({ path: 'assets/sfx/' + s.sfxKey + '.mp3', kind: 'sfx', id: s.sfxKey, label: s.name + ' 音效', source: 'server/data/skill-templates.json', optional: true }); });
  listOf(readJsonIf(path.join(DATA_DIR, 'plugins.json')), ['plugins'])
    .forEach((p) => add({ path: 'assets/plugin/' + String(p.id).replace(/_c\d+$/, '') + '.webp', kind: 'plugin',
      id: String(p.id).replace(/_c\d+$/, ''), label: p.name + '（' + (p.category || p.kind) + '）',
      source: 'server/data/plugins.json', family: p.id }));
  listOf(readJsonIf(path.join(DATA_DIR, 'qualities.json')), ['qualities']).forEach((q) => {
    add({ path: 'assets/frame/' + q.id + '.svg', kind: 'frame', id: q.id, label: q.name + ' 品质框', source: 'server/data/qualities.json' });
    add({ path: 'assets/tier/' + q.id + '.svg', kind: 'tier', id: q.id, label: q.name + ' 段位图标', source: 'server/data/qualities.json' });
  });
  listOf(readJsonIf(path.join(DATA_DIR, 'ai-node-catalog.json')), ['nodes'])
    .forEach((n) => add({ path: 'assets/ai/' + n.id + '.webp', kind: 'ai', id: n.id, label: n.name + '（' + (n.category || '') + '）', source: 'server/data/ai-node-catalog.json' }));
  listOf(readJsonIf(path.join(DATA_DIR, 'package-config.json')), ['packages'])
    .forEach((p) => add({ path: 'assets/package/' + (p.id || p.kind) + '.webp', kind: 'package', id: p.id || p.kind, label: p.name || p.id, source: 'server/data/package-config.json' }));

  // ② 布局表：背景图 + 元素建议图名（没有素材的元素 = 需要你出图）
  const bundle = layoutBundle();
  const screens = (bundle && bundle.screens) || {};
  Object.keys(screens).forEach((name) => {
    const sc = screens[name];
    if (sc.background && sc.background.asset) add({ path: sc.background.asset, kind: 'bg', id: name, label: name + ' 背景', source: '布局表 ' + name, usedBy: [name] });
    (sc.elements || []).forEach((el) => {
      if (el.asset && el.asset.indexOf('{') < 0) {
        add({ path: el.asset, kind: 'ui', id: el.id, label: (el.label || el.id) + ' 素材', source: '布局表 ' + name, usedBy: [name] });
      } else if (el.kind === 'button') {
        // 没有素材的按钮：给一个建议文件名（用户按名出图 → 我把 asset 填进布局表）
        add({ path: 'assets/ui/' + safeName(el.id) + '.webp', kind: 'ui', id: el.id,
          label: (el.label || el.id) + (el.hit === 'path' ? '（不规则形状：PNG 透明底，我会描轮廓）' : ''),
          source: '布局表 ' + name, usedBy: [name], el: name + '/' + el.id });
      }
    });
  });

  // 优先级：core = 主界面/对局里立刻看得见的；secondary = 图鉴/编辑器类（可以后补）
  const CORE = { bg: 1, ui: 1, role: 1, skill: 1, frame: 1, tier: 1 };
  return entries.map((e) => {
    const spec = SPEC[e.kind] || SPEC.ui;
    return Object.assign({
      format: spec.format, size: spec.size, note: spec.note, optional: e.optional === true,
      priority: CORE[e.kind] ? 'core' : 'secondary',
    }, e);
  });
}

/** 扫描已有素材 + 收件夹（收件夹里同名文件也算"已备好，待归位"） */
function statusOf(entries) {
  const inbox = fs.existsSync(INBOX_DIR) ? fs.readdirSync(INBOX_DIR, { recursive: true }) : [];
  const byBase = {};
  inbox.forEach((f) => {
    const s = String(f);
    if (fs.statSync(path.join(INBOX_DIR, s)).isDirectory()) return;
    byBase[path.basename(s, path.extname(s))] = s;
  });
  return entries.map((e) => {
    const abs = path.join(PUBLIC_DIR, e.path);
    const inPlace = fs.existsSync(abs);
    const inInbox = byBase[e.id] || byBase[path.basename(e.path, path.extname(e.path))];
    return Object.assign({}, e, {
      present: inPlace,
      inbox: inInbox || null,
      status: inPlace ? '已有' : (inInbox ? '收件夹待归位' : '缺'),
      bytes: inPlace ? fs.statSync(abs).size : 0,
    });
  });
}

function build() {
  const entries = statusOf(collect());
  const byKind = {};
  entries.forEach((e) => { byKind[e.kind] = byKind[e.kind] || { total: 0, present: 0, missing: 0, inbox: 0, optional: 0 }; 
    const b = byKind[e.kind]; b.total += 1;
    if (e.present) b.present += 1; else if (e.inbox) b.inbox += 1; else if (e.optional) b.optional += 1; else b.missing += 1; });
  const missing = entries.filter((e) => e.status === '缺' && !e.optional);
  return {
    generatedAtNote: '由 node tools/layout/asset-manifest.js 生成（勿手改）',
    assetRoot: 'public/assets',
    inbox: 'assets-inbox',
    spec: SPEC,
    summary: {
      total: entries.length, present: entries.filter((e) => e.present).length,
      inInbox: entries.filter((e) => e.inbox).length,
      missing: missing.length, optional: entries.filter((e) => e.optional && !e.present).length,
      requiredMissing: missing.filter((e) => e.required !== false).length,
      byKind: byKind,
      coreMissing: missing.filter((e) => e.priority === 'core').length,
    },
    entries: entries,
  };
}

function toMarkdown(m) {
  const lines = [];
  lines.push('# UI 素材清单（自动生成，勿手改）');
  lines.push('');
  lines.push('> 生成命令：`node tools/layout/asset-manifest.js`（也可以用布局台的「素材清单」按钮）');
  lines.push('> 出图规范：把文件按 **文件名 = 清单里的 ID** 丢进仓库根目录的 `assets-inbox/`，');
  lines.push('> 然后跑 `node tools/layout/apply-assets.js` —— 它会改名/转格式/缩放并放进 `public/assets/` 对应目录。');
  lines.push('');
  const s = m.summary;
  lines.push('**总览**：共 ' + s.total + ' 项 ｜ 已有 ' + s.present + ' ｜ 收件夹待归位 ' + s.inInbox + ' ｜ **缺 ' + s.missing + '**（可选 ' + s.optional + '）');
  lines.push('');
  lines.push('| 类别 | 总数 | 已有 | 待归位 | 缺 | 建议规格 | 说明 |');
  lines.push('|---|---|---|---|---|---|---|');
  const KIND_CN = { bg: '背景图', role: '角色', skill: '技能', plugin: '插件', ai: 'AI 积木节点', package: '包/宝箱', ui: '界面按钮/控件', frame: '品质边框', tier: '段位图标', sfx: '音效（可选）' };
  Object.keys(m.spec).forEach((k) => {
    const b = s.byKind[k];
    if (!b) return;
    lines.push('| ' + (KIND_CN[k] || k) + ' | ' + b.total + ' | ' + b.present + ' | ' + b.inbox + ' | ' + (b.missing + b.optional) + ' | ' + m.spec[k].size + ' · ' + m.spec[k].format + ' | ' + m.spec[k].note + ' |');
  });
  lines.push('');
  const groups = {};
  m.entries.forEach((e) => { (groups[e.kind] = groups[e.kind] || []).push(e); });
  Object.keys(m.spec).forEach((k) => {
    const list = groups[k];
    if (!list || !list.length) return;
    lines.push('## ' + (KIND_CN[k] || k) + '（' + list.length + '）');
    lines.push('');
    lines.push('| 状态 | 优先级 | 文件名（放进 assets-inbox） | 目标路径 | 名称 | 用途 |');
    lines.push('|---|---|---|---|---|---|');
    list.forEach((e) => {
      const mark = e.present ? '✅ 已有' : (e.inbox ? '📥 待归位' : (e.optional ? '➖ 可选' : '❌ 缺'));
      const base = path.basename(e.path, path.extname(e.path));
      lines.push('| ' + mark + ' | ' + (e.priority === 'core' ? '★ 先做' : '· 后补') + ' | `' + base + path.extname(e.path) + '` | `' + e.path + '` | ' + (e.label || e.id) + ' | ' + (e.usedBy ? e.usedBy.join(' / ') : e.source) + ' |');
    });
    lines.push('');
  });
  return lines.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const m = build();
  fs.writeFileSync(path.join(__dirname, 'assets-manifest.json'), JSON.stringify(m, null, 1) + '\n');
  const docPath = path.join(ROOT, 'docs', 'frontend', 'assets-manifest.md');
  fs.writeFileSync(docPath, toMarkdown(m) + '\n');

  if (argv.indexOf('--json') >= 0) { console.log(JSON.stringify(m, null, 1)); return; }
  const s = m.summary;
  console.log('素材清单：共 ' + s.total + ' 项 ｜ ✅ 已有 ' + s.present + ' ｜ 📥 收件夹待归位 ' + s.inInbox + ' ｜ ❌ 缺 ' + s.missing + '（可选 ' + s.optional + '）');
  Object.keys(s.byKind).forEach((k) => {
    const b = s.byKind[k];
    console.log('  · ' + k.padEnd(8) + ' 共 ' + String(b.total).padStart(3) + ' ｜ 已有 ' + String(b.present).padStart(3) + ' ｜ 待归位 ' + String(b.inbox).padStart(2) + ' ｜ 缺 ' + String(b.missing + b.optional).padStart(3));
  });
  const missing = m.entries.filter((e) => e.status === '缺');
  if (missing.length && argv.indexOf('--quiet') < 0) {
    console.log('\n缺失清单（把同名文件丢进 assets-inbox/ 即可）：');
    missing.slice(0, 200).forEach((e) => console.log('  ❌ ' + path.basename(e.path) + '   ← ' + (e.label || '') + (e.optional ? '（可选）' : '')));
    if (missing.length > 200) console.log('  … 还有 ' + (missing.length - 200) + ' 项，见 docs/frontend/assets-manifest.md');
  }
  console.log('\n已写 docs/frontend/assets-manifest.md 与 runtime/assets-manifest.json');
}

module.exports = { build, toMarkdown, SPEC, ASSET_ROOT, INBOX_DIR, safeName };
if (require.main === module) main();
