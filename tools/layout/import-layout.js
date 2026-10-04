'use strict';
/* tools/layout/import-layout.js —— 把布局台导出的 JSON 变成前端可零依赖加载的模块
 *
 * 用法：node tools/layout/import-layout.js [raw.json]
 *   ① 读原始导出（默认 tools/layout/layout-bundle.raw.json）
 *   ② 应用「把功能写在名字里 / 布局台默认值」的修正（见 INTENT_FIXES 与 applyStructuralFixes）
 *   ③ 规范化后写两份产物：
 *        · tools/layout/layout-bundle.normalized.json ← 归一化结果（布局台再打开时用它）
 *        · public/layout-data.js       ← 前端 UMD 模块（DL.layoutData），不引 fetch、不引框架
 *   之所以生成 .js 而不是运行时 fetch：前端是零依赖双模模块，且 UI-8 规定 fetch 只能出现在 api.js。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const rawFile = process.argv[2] || path.join(__dirname, 'layout-bundle.raw.json');

/** 引擎：直接从布局台抽 `<script id="core">`（**单一真源**，避免两边逻辑漂移） */
function loadEngine() {
  const html = fs.readFileSync(path.join(__dirname, 'lab.html'), 'utf8');
  const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
  const sb = { window: {}, console };
  vm.createContext(sb);
  vm.runInContext(core + '\nthis.C = LAYOUT_CORE;', sb);
  return sb.C;
}

const SKILLS = [
  { n: 1, screen: 'model_skill1_slots', pos: 'skill1' },
  { n: 2, screen: 'modal_skill2_slots', pos: 'skill2' },
  { n: 3, screen: 'modal_skill3_slots', pos: 'skill3' },
];

/** 名字里写着功能 / 布局台默认值 → 翻译成真正的字段（跑完会打印清单，便于复核） */
const INTENT_FIXES = [
  {
    screen: 'hub', id: '设为出战（将当前配置设为出战）',
    why: '名字说明它是"把当前显示的配置设为出战"→ 按钮 + config-activate，槽位取当前显示的配置',
    apply(e) { e.kind = 'button'; e.action = 'config-activate'; e.payload = { slot: '{configId}' }; e.label = '设为出战'; return e; },
  },
  {
    screen: 'hub', id: '对战历史',
    why: '名字说明它是入口 → 按钮 + goto-records（战绩屏尚未实现，登记为计划动作）',
    apply(e) { e.kind = 'button'; e.action = 'goto-records'; e.label = '对战历史'; return e; },
  },
  {
    screen: 'hub', id: '用户名',
    why: '装饰件读数据：显示昵称文字（原来误挂了 {tierIcon} 素材）',
    apply(e) { delete e.asset; e.label = '{nickname}'; return e; },
  },
  {
    screen: 'hub', id: '段位名',
    why: '装饰件读数据：显示段位中文名（原来误挂了 {tierIcon} 素材）',
    apply(e) { delete e.asset; e.label = '{tierName}'; return e; },
  },
];

/** 列表屏：行内容必须来自后端 → 首行当"行原型"，渲染时按数据生成 N 行 */
const LIST_SCREENS = [
  { screen: 'modal_role_pick', source: 'roles', why: '候选角色模板 = 仓库里的角色物品' },
  { screen: 'modal_skill_pick', source: 'skills', why: '候选技能 = 仓库里的技能物品' },
  { screen: 'modal_role_plugin_pick', source: 'rolePlugins', why: '候选角色插件 = 仓库里匹配该插槽类型的角色插件' },
  { screen: 'modal_skill_plugin_pick', source: 'skillPlugins', why: '候选技能插件 = 仓库里匹配该技能类型的技能插件' },
];

function applyStructuralFixes(bundle, log) {
  // ① 屏幕名笔误：model_skill1_slots → modal_skill1_slots（并同步 hub 的 target）
  if (bundle.screens.model_skill1_slots && !bundle.screens.modal_skill1_slots) {
    bundle.screens.modal_skill1_slots = bundle.screens.model_skill1_slots;
    bundle.screens.modal_skill1_slots.name = 'modal_skill1_slots';
    delete bundle.screens.model_skill1_slots;
    const sk = bundle.screens.hub.elements.find((e) => e.id === 'skill_1');
    if (sk && sk.target === 'model_skill1_slots') sk.target = 'modal_skill1_slots';
    log.push({ id: 'model_skill1_slots', why: '屏幕名笔误（model→modal）→ 改名并同步 hub 的 target' });
  }
  // ①b 角色卡的文字：设计期占位名（"角色卡"）→ 绑定 {roleName}，这样它会跟着当前显示配置变
  {
    const crest = bundle.screens.hub.elements.find((e) => e.id === 'crest_role');
    if (crest && (crest.label === '角色卡' || !crest.label)) {
      crest.label = '{roleName}';
      log.push({ id: 'crest_role', why: '角色卡文字是设计期占位名 → 改为 {roleName}（随显示的配置切换）' });
    }
  }
  // ② 技能插槽弹窗的中心点：布局台新建元素留下的默认值（goto-hub / 新元素）
  SKILLS.forEach(function (sk) {
    const sc = bundle.screens[sk.screen];
    if (!sc) return;
    const center = sc.elements.find((e) => e.id === 'new_1');
    if (!center) return;
    center.action = 'config-open';
    center.label = '技能' + sk.n + '（再点一次看技能）';
    center.payload = { slot: '{configId}', pos: sk.pos };
    log.push({ id: sk.screen + '/new_1', why: '中心点默认值（goto-hub/新元素）→ 改成"再看一次 = 换技能"' });
  });
  // ③ 插槽弹窗：插槽数量由模板 slotCount 决定 → 标出中心元素与插槽原型，渲染时按数量生成
  ['modal_role_slots', 'modal_skill1_slots', 'modal_skill2_slots', 'modal_skill3_slots'].forEach(function (name) {
    const sc = bundle.screens[name];
    if (!sc) return;
    const center = sc.elements.find((e) => /^center_/.test(e.id)) || sc.elements.find((e) => e.id === 'new_1');
    const slots = sc.elements.filter((e) => /^slot_\d+$/.test(e.id));
    if (!center || !slots.length) return;
    const pos = name === 'modal_role_slots' ? 'role' : (SKILLS.find((s) => s.screen === name) || {}).pos;
    const target = name === 'modal_role_slots' ? 'modal_role_plugin_pick' : 'modal_skill_plugin_pick';
    slots.forEach(function (s, i) {                      // 补全 payload（布局台只填了 idx）
      s.payload = Object.assign({}, s.payload, { slot: '{configId}', pos, idx: i });
      s.target = target;
    });
    sc.slotsFrom = { center: center.id, prototype: slots[0].id, kind: name === 'modal_role_slots' ? 'role' : 'skill', pos };
    log.push({ id: name, why: '插槽数量由模板 slotCount 决定 → 已标出中心元素与插槽原型' });
  });
  // ④ 出战标识：三个配置按钮上方各加一条「出战」角标，显示哪个由 battleSlot（服务端 activeSlotId）决定
  {
    const hub = bundle.screens.hub;
    const slots = hub.elements.filter((e) => /^slot_\d+$/.test(e.id));
    slots.forEach(function (s, i) {
      const id = 'battle_badge_' + (i + 1);
      if (hub.elements.some((e) => e.id === id)) return;
      hub.elements.push({
        id, kind: 'deco', action: '', label: '出战', hit: 'rect', anchor: 'ct',
        rect: [s.rect[0], s.rect[1] - 22, s.rect[2], 18], z: 4,
        when: { battleSlot: i + 1 },
        // 角标底图由占位生成器或美术提供（assets/ui/battle_badge_N.webp）；文件缺失时界面显示占位框
        asset: 'assets/ui/' + id + '.webp',
      });
    });
    log.push({ id: 'battle_badge_1..N', why: '按需求补充：出战配置按钮上方的「出战」标识（when.battleSlot 决定显示哪个）' });
  }
  // ⑤ 列表屏：首行当原型，其余删除；行 payload 里用运行时上下文占位符
  LIST_SCREENS.forEach(function (item) {
    const sc = bundle.screens[item.screen];
    if (!sc) return;
    const rows = sc.elements.filter((e) => /_row\d+$/.test(e.id));
    if (!rows.length) return;
    sc.listFrom = {
      source: item.source,
      prototype: rows[0].id,
      pitch: rows.length > 1 ? rows[1].rect[1] - rows[0].rect[1] : rows[0].rect[3] + 8,
    };
    rows.forEach(function (r) {
      const p = Object.assign({}, r.payload);
      if (p.pos !== undefined) p.pos = '{pickPos}';             // 换技能时要知道换哪个技能位
      if (p.slotIndex !== undefined) p.slotIndex = '{pickIdx}';  // 换插件时要知道是哪个插槽
      r.payload = p;
      r.label = '{rowLabel}';                                   // 行文字由数据决定
      if (r.asset) r.asset = '{rowIcon}';
    });
    rows.slice(1).forEach(function (r) { sc.elements.splice(sc.elements.indexOf(r), 1); });
    log.push({ id: item.screen, why: item.why + ' → 已改为"列表屏"（首行原型 + 渲染时生成）' });
  });
}

function main() {
  const C = loadEngine();
  const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  const bundle = C.normalizeBundle(raw);
  const applied = [];
  INTENT_FIXES.forEach(function (fx) {
    const sc = bundle.screens[fx.screen];
    if (!sc) return;
    const e = sc.elements.find((x) => x.id === fx.id);
    if (!e) { applied.push({ id: fx.id, skipped: '元素不存在' }); return; }
    fx.apply(e);
    applied.push({ id: fx.id, why: fx.why });
  });
  applyStructuralFixes(bundle, applied);

  const normalized = C.normalizeBundle(bundle);
  Object.keys(bundle.screens).forEach(function (k) {          // 归一化会丢未知键 → 结构元数据挂回去
    if (bundle.screens[k].slotsFrom) normalized.screens[k].slotsFrom = bundle.screens[k].slotsFrom;
    if (bundle.screens[k].listFrom) normalized.screens[k].listFrom = bundle.screens[k].listFrom;
  });

  fs.writeFileSync(path.join(__dirname, 'layout-bundle.normalized.json'), JSON.stringify(normalized, null, 2) + '\n');
  const header = [
    "'use strict';",
    '/* public/layout-data.js —— **由 tools/layout/import-layout.js 生成，请勿手改**',
    ' * 真源：布局台导出的 JSON（runtime/layout-bundle.raw.json）。',
    ' * 生成方式：node tools/layout/import-layout.js',
    ' * 形态：零依赖双模模块（浏览器挂 window.DL.layoutData，Node 可 require）。',
    ' */',
    '(function (root, factory) {',
    '  var mod = factory();',
    "  if (typeof module !== 'undefined' && module.exports) module.exports = mod;",
    '  root.DL = root.DL || {};',
    '  root.DL.layoutData = mod;',
    "})(typeof window !== 'undefined' ? window : globalThis, function () {",
    '  return ' + JSON.stringify(normalized) + ';',
    '});',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(ROOT, 'public', 'layout-data.js'), header);

  const issues = C.validateBundle(normalized, null);
  const errs = issues.filter((i) => i.level === 'error');
  console.log('读入 ' + path.basename(rawFile));
  console.log('修正 ' + applied.filter((a) => !a.skipped).length + ' 条：');
  applied.forEach((a) => console.log('  · ' + a.id + (a.skipped ? '（跳过：' + a.skipped + '）' : ' → ' + a.why)));
  console.log('画面：' + Object.keys(normalized.screens).map((k) => k + '(' + normalized.screens[k].elements.length + ')').join(' + '));
  console.log('校验：' + errs.length + ' error / ' + issues.filter((i) => i.level === 'warn').length + ' warn');
  errs.slice(0, 12).forEach((i) => console.log('  ✕ ' + i.msg));
  console.log('已写 tools/layout/layout-bundle.normalized.json 与 public/layout-data.js');
}

main();
