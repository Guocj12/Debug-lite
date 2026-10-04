'use strict';
/* tools/layout/art-spec.js —— 生成《美术素材规格表》（docs/frontend/art-spec.md + tools/layout/art-spec.json）
 *
 * 与素材清单（assets-manifest）的分工：
 *   · 素材清单回答"缺哪些文件"（状态：已有/占位/缺）
 *   · 规格表回答"这张图该怎么画"：文件名（PNG）、尺寸、比例、形状、内容要求、用在哪、是不是弹窗
 *
 * 数据来源：布局表（每个元素的位置/尺寸/多边形/所属画面）+ 数据表（角色/技能/插件/节点/包的属性）+ 清单（规格与用途）
 * 用法：node tools/layout/art-spec.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const DATA = path.join(ROOT, 'server', 'data');
const manifestMod = require('./asset-manifest.js');
const C = require(path.join(ROOT, 'public', 'layout-engine.js'));

const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const bundle = C.normalizeBundle(require(path.join(__dirname, 'layout-bundle.normalized.json')));

const gcd = (a, b) => (b ? gcd(b, a % b) : a);
function ratio(w, h) {
  const g = gcd(Math.round(w), Math.round(h)) || 1;
  const a = Math.round(w) / g, b = Math.round(h) / g;
  return a <= 32 && b <= 32 ? a + ':' + b : (w / h).toFixed(2) + ':1';
}
function poly(p) {
  if (!p) return '';
  const pts = [...p.matchAll(/(-?\d*\.?\d+),(-?\d*\.?\d+)/g)].map((m) => '(' + m[1] + '%,' + m[2] + '%)');
  return pts.join(' → ');
}
function shapeOf(el) {
  if (el.hit === 'path' && el.path) return '不规则多边形（按布局表裁切；**整张画满即可**）';
  if (el.hit === 'ellipse') return '椭圆';
  const w = el.rect[2], h = el.rect[3];
  if (Math.abs(w - h) < 2) return '圆角方形（正方形）';
  return w > h ? '横向圆角矩形' : '纵向圆角矩形';
}

/* ---------- 内容建议：按类别/属性给出"该画什么" ---------- */
const ROLE_HINT = {
  balanced: '均衡型：盾牌 + 交叉双刃，色调偏青蓝，体现"攻守兼备"',
  specialized: '特化型：单一属性极度突出（如重锤/尖矛/书卷），色调整体偏亮，主体占画面 60%',
  expert: '专家型：更华丽的结构（双翼/多刃/护罩），带明显高光与纹路，比前两档更有"高级感"',
};
const SKILL_HINT = {
  melee: '挥砍动作 + 斩击轨迹（弧线/残影），主体是近战武器或拳锋，方向从左下到右上',
  straight: '直线弹道：一支发射物（弹丸/光束/箭）水平向右，尾部带速度线',
  vertical: '定点打击：由上向下的落点标记（准星/箭矢向下）+ 地面冲击环',
  displace: '位移：人物剪影 + 两个错开的方向箭头（进/出），带"残影"效果',
};
const AI_HINT = {
  流程: '流程控制：分支/循环的抽象符号（分叉箭头、回环箭头）',
  条件: '判断：菱形判定框 + 问号/天平',
  动作: '行动：齿轮、脚步、出拳等"做事"的图标',
  数据: '数据：数据库柱体、表格、标签',
  字面量: '数值/文本：数字方块、引号、开关',
  比较: '比较：大于/小于/等于符号，或用天平表示',
  逻辑: '逻辑：与/或/非的门电路符号',
  扫描: '感知：雷达波、眼睛、扫描线',
};
const PLUGIN_KEYWORD = [
  ['攻击', '剑/向上箭头/爆炸星芒'], ['生命', '心形/十字/血滴'], ['防御', '盾牌/护甲片'],
  ['暴击', '四角星芒 + 惊叹号'], ['闪避', '残影/燕子/风'],
  ['MP', '蓝色水滴/电池'], ['SP', '黄色闪电/能量槽'], ['冷却', '沙漏/时钟'],
  ['范围', '同心圆扩散'], ['连击', '三重箭头/连环'], ['吸血', '尖牙/血滴入心'],
  ['命中', '靶心'], ['速度', '羽翼/速度线'], ['反伤', '尖刺护盾'], ['护盾', '气泡/力场'],
  ['回复', '绿色十字/循环箭头'], ['消耗', '递减箭头/空电池'], ['点数', '齿轮/铜板'],
  ['通用', '拼图块'], ['专属', '钥匙/锁扣'],
];
function pluginHint(p) {
  const cat = String(p.category || '');
  const hit = PLUGIN_KEYWORD.filter(([k]) => cat.indexOf(k) >= 0).map(([, v]) => v)[0];
  const kind = String(p.kind) === 'skillPlugin' ? '技能插件' : '角色插件';
  return kind + '·' + (cat || '通用') + '：' + (hit || '体现该词条效果的抽象图标') +
    '；点数 ' + (p.pointCost || 1) + '（右上角画 1/' + (p.pointCost || 1) + ' 个小点）';
}
function packageHint(p) {
  const k = p.packageKind;
  const map = { role: '角色模块包', skill: '技能模块包', rolePlugin: '角色插件包', skillPlugin: '技能插件包', aiNode: 'AI 节点包（科技感数据盒）' };
  return (map[k] || k) + '：' + (k === 'aiNode' ? '数据盒 + 电路纹路' : '箱体 + 缎带，缎带颜色区分种类');
}

/* ---------- 收集：目录物（角色/技能/插件/节点/包/品质框/段位/背景/音效） ---------- */
const roles = read('role-templates.json').roleTemplates;
const skills = read('skill-templates.json').skillTemplates;
const plugins = read('plugins.json').plugins;
const quals = read('qualities.json').qualities;
const nodes = read('ai-node-catalog.json').nodes;
const pkgs = read('package-config.json').packages;
const m = manifestMod.build();
const byPath = new Map(m.entries.map((e) => [e.path, e]));

const catalog = [];
function addCatalog(kind, id, png, size, shape, content, where, extra) {
  const path2 = (byPath.get(extra && extra.path) || {}).path;
  catalog.push(Object.assign({
    kind, id, png, size, ratio: size.split('×').length === 2 ? ratio(...size.split('×').map(Number)) : '—',
    shape, content, where, target: path2 || '',
    priority: (byPath.get(path2) || {}).priority || 'core', placeholder: (byPath.get(path2) || {}).placeholder === true,
  }, extra || {}));
}

addCatalog('bg', 'hub_main', 'hub_main.png', '1920×1080', '整屏矩形（铺满）',
  '主界面背景：深色科技感大厅/训练场，中央留出角色卡的位置（不要有强烈细节抢主体）；' +
  '建议：暗蓝紫渐变 + 中央柔光 + 极淡几何纹路 + 四周暗角', '主界面底图', { path: 'assets/bg/hub_main.webp' });

roles.forEach((r) => addCatalog('role', r.id, r.id + '.png', '512×512', '六边形盾牌轮廓（内部自由构图，透明底）',
  (ROLE_HINT[r.type] || '角色主题') + '；属性 HP' + r.baseStats.hp + '/ATK' + r.baseStats.atk + '/DEF' + r.baseStats.def +
  '/SP' + r.baseStats.sp + '/MP' + r.baseStats.mp + '（可在构图里体现强项）', '主界面角色卡（六边形内）/ 仓库 / 配置编辑器',
  { path: 'assets/role/' + r.id + '.webp' }));

skills.forEach((s) => addCatalog('skill', s.id, s.id + '.png', '256×256', '菱形（旋转 45° 的方牌，透明底）',
  (SKILL_HINT[s.type] || '技能主题') + '；射程 ' + JSON.stringify(s.range) + '，冷却 ' + s.cooldown +
  '，消耗 SP' + (s.baseCost && s.baseCost.sp) + '；主界面技能盘还会按**不规则多边形**裁切，画满整张即可',
  '主界面技能盘 / 插槽弹窗中心 / 仓库', { path: 'assets/skill/' + s.id + '.webp' }));

const seen = new Set();
plugins.forEach((p) => {
  const fam = String(p.id).replace(/_c\d+$/, '');
  if (seen.has(fam)) return;
  seen.add(fam);
  addCatalog('plugin', fam, fam + '.png', '128×128', '圆角方牌（透明底，四周留 8% 安全区）',
    pluginHint(p), '径向插槽弹窗的插件候选行 / 仓库·插件桶', { path: 'assets/plugin/' + fam + '.webp' });
});

nodes.forEach((n) => addCatalog('ai', n.id, n.id + '.png', '128×128', '圆角矩形"代码块"（透明底，左侧留出色条位置）',
  (AI_HINT[n.category] || '积木节点') + '；节点名「' + n.name + '」（' + n.category + '/' + n.kind + '）——**不要在图里写字**，界面会渲染名字',
  'AI 编辑器左侧积木调色板 / 积木树', { path: 'assets/ai/' + n.id + '.webp' }));

pkgs.forEach((p) => addCatalog('package', p.packageKind, p.packageKind + '.png', '256×256', '箱体（透视或正视，透明底）',
  packageHint(p), '开包屏 / 仓库·包桶', { path: 'assets/package/' + p.packageKind + '.webp' }));

quals.forEach((q, i) => {
  addCatalog('frame', q.id, q.id + '.png', '256×256', '圆角矩形边框（透明中心，四角可加装饰）',
    q.name + '（' + q.id + '）品质框，主色 ' + q.color + '；可交 SVG（矢量）或 PNG 透明底',
    '角色卡/技能盘/物品外框（按品质替换）', { path: 'assets/frame/' + q.id + '.webp' });
  addCatalog('tier', q.id, q.id + '.png', '64×64', '盾形徽章（透明底）',
    q.name + '段位徽章，主色 ' + q.color + '；档位 ' + (i + 1) + '/5（可用 ' + (i + 1) + ' 颗星/角表示）',
    '主界面左上角段位图标 / 排行榜', { path: 'assets/tier/' + q.id + '.webp' });
});

/* ---------- 界面控件该画什么（按 id / 动作给具体建议） ---------- */
const UI_HINT = {
  '用户头像': '头像框（圆角方形或圆形，内部留空给玩家头像图），描边 + 品质色微光',
  btn_warehouse: '箱柜/货架图标（仓储感），深色玻璃底板',
  btn_ai: '芯片 + 代码符号（AI/逻辑感），底板与其它导航按钮同风格',
  btn_settings: '齿轮图标',
  btn_board: '奖杯或榜单图标',
  btn_tournament: '锦标赛奖杯 + 对阵括号（或绶带）',
  btn_quick: '交叉双剑（快速对战），底板可带暖色描边以示强调',
  '对战历史': '卷轴/回放图标（时钟 + 列表）',
  '设为出战（将当前配置设为出战）': '旗帜/星形 + "启用"高光（小按钮，点击后表示把当前配置设为出战）',
};
const UI_HINT_PREFIX = [
  ['battle_badge', '小丝带/徽标条（"出战"标识的底版；字由界面渲染）'],
  ['slot_', '数字牌底版（配置 1/2/3 共用同一造型；选中态由界面加高亮）'],
  ['center_role', '中心的**角色卡副本**（点它进入角色模板候选；造型与主界面角色卡一致）'],
  ['center_skill', '中心的**技能盘副本**（点它进入技能候选）'],
  ['new_1', '中心的**技能盘副本**（点它进入技能候选；造型与该技能在主界面上的形状一致）'],
  ['pick_', '候选**列表行**/面板（左侧留图标位，行内留空给名字）'],
  ['spick_', '候选**列表行**/面板（技能候选，风格同上）'],
  ['plug_', '候选**列表行**/面板（插件候选）'],
  ['splug_', '候选**列表行**/面板（技能插件候选）'],
];
const PLACEHOLDER_HINT = {
  roleIcon: '当前配置的角色立绘（见第 2 节）',
  skill1Icon: '当前配置第 1 个技能的图标（见第 3 节）',
  skill2Icon: '当前配置第 2 个技能的图标（见第 3 节）',
  skill3Icon: '当前配置第 3 个技能的图标（见第 3 节）',
  tierIcon: '当前段位徽章（见第 8 节）',
  qualityFrame: '当前品质框（见第 7 节）',
  aiIcon: '当前 AI 的头像（可复用 ai 节点风格）',
  rowIcon: '这一行候选的图标（角色/技能/插件，来自仓库数据）——**行底版**见第 11 节',
  rowLabel: '这一行候选的名字（来自仓库数据，界面渲染）',
};
function uiHint(el) {
  if (UI_HINT[el.id]) return UI_HINT[el.id];
  // 插槽有两类：主界面上的「配置 1/2/3」按钮，与弹窗里的「插件插槽」——文案必须分开
  if (String(el.id).indexOf('slot_') === 0) {
    return String(el.action || '') === 'plugin-pick'
      ? '插件插槽底版（建议画成"空槽/凹槽"外观；已装插件时界面会叠加插件图标）'
      : '数字牌底版（主界面「配置 1/2/3」按钮共用同一造型；选中态由界面加高亮）';
  }
  const byPrefix = UI_HINT_PREFIX.find(([p]) => String(el.id).indexOf(p) === 0);
  if (byPrefix) return byPrefix[1];
  const a = String(el.action || '');
  if (a.indexOf('config-open') === 0) return '进入编辑/候选的按钮底板';
  if (a.indexOf('goto-') === 0) return '导航按钮：一个具象图标 + 同风格底板（所有导航按钮保持一致的圆角与描边）';
  if (a.indexOf('layout-') === 0) return '布局路径按钮底板（点击后打开对应弹窗/执行操作）';
  return '控件底板（圆角/多边形，风格与其它控件一致）';
}

/* ---------- 收集：界面控件（含弹窗），逐个元素给出比例与形状 ---------- */
const ui = [];
const seenUi = new Set();
Object.keys(bundle.screens).forEach((sname) => {
  const sc = bundle.screens[sname];
  (sc.elements || []).forEach((el) => {
    const isModal = sc.role === 'modal';
    const key = el.id;
    if (seenUi.has(key) && !isModal) return;                  // 同名元素只列一次（优先整屏）
    const hasTpl = el.asset && el.asset.indexOf('{') >= 0;     // 角色卡/技能盘：由数据绑定决定
    const png = hasTpl ? el.asset.replace(/^.*\{|\}.*$/g, '') : el.id + '.png';
    const row = {
      kind: isModal ? 'ui-modal' : 'ui',
      screen: sname, id: el.id,
      png: hasTpl ? '' : png,
      size: Math.round(el.rect[2]) + '×' + Math.round(el.rect[3]),
      shape: shapeOf(el),
      polygon: el.hit === 'path' ? poly(el.path) : '',
      content: hasTpl
        ? '**不用单独出图**：' + (PLACEHOLDER_HINT[String(el.asset).replace(/[{}]/g, '')] || ('由数据绑定决定（' + el.asset + '）'))
        : (isModal ? '弹窗控件：' : '主界面控件：') + '「' + (el.label || el.id) + '」——' + uiHint(el) +
          '；**不要在图里写字**' + (el.label ? '（界面会渲染「' + el.label + '」）' : ''),
      where: (isModal ? '弹窗 ' : '') + sname + ' · ' + el.id,
      priority: 'core',
    };
    if (!hasTpl) {
      const target = 'assets/ui/' + String(el.id).trim().replace(/[\\/:*?"<>|\s]+/g, '_') + '.webp';
      row.target = target;
      row.placeholder = (byPath.get(target) || {}).placeholder === true;
      if (seenUi.has(key)) { ui[ui.findIndex((x) => x.id === key)].where += ' / ' + sname; return; }
      seenUi.add(key);
    }
    row.ratio = ratio(el.rect[2], el.rect[3]);
    ui.push(row);
  });
});
// 运行时才生成的控件：径向插槽（数量由模板 slotCount 决定，共用一个底版）
const slotProto = Object.keys(bundle.screens).map((s) => (bundle.screens[s].elements || [])
  .find((e) => /^slot_\d+$/.test(e.id))).find(Boolean);
if (slotProto) {
  ui.push({
    kind: 'ui-runtime', screen: '(径向弹窗，运行时生成)', id: 'slot_e*',
    png: 'slot_e.png', size: Math.round(slotProto.rect[2]) + '×' + Math.round(slotProto.rect[3]),
    ratio: ratio(slotProto.rect[2], slotProto.rect[3]), shape: '圆角方形',
    content: '径向弹窗里的**插槽**底版（数量由角色/技能的 slotCount 决定，全部共用这一张）；' +
      '建议画成"空槽"外观（虚线/凹槽），已装插件时界面会叠加插件图标',
    where: '角色插槽弹窗 / 技能插槽弹窗', priority: 'core',
    target: 'assets/ui/slot_e.webp', placeholder: false,
  });
}
// 列表行（候选角色/技能/插件）
['pick_row1', 'plug_row1'].forEach((proto) => {
  const el = Object.keys(bundle.screens).map((s) => (bundle.screens[s].elements || []).find((e) => e.id === proto)).find(Boolean);
  if (!el) return;
  const target = 'assets/ui/' + proto.replace(/\d+$/, '') + '.webp';
  ui.push({
    kind: 'ui-runtime', screen: '(候选列表，运行时生成 N 行)', id: proto,
    png: proto.replace(/\d+$/, '') + '.png', size: Math.round(el.rect[2]) + '×' + Math.round(el.rect[3]),
    ratio: ratio(el.rect[2], el.rect[3]), shape: '圆角横向长条',
    content: '**候选行**底版（' + (proto.indexOf('pick') === 0 ? '角色模板 / 技能' : '插件') + '候选都共用这一张）；' +
      '建议画成"列表条目"外观（左侧留图标位，行内不要写字）',
    where: '弹窗 ' + (proto.indexOf('pick') === 0 ? 'modal_role_pick / modal_skill_pick' : 'modal_role_plugin_pick / modal_skill_plugin_pick'),
    priority: 'core', target, placeholder: (byPath.get(target) || {}).placeholder === true,
  });
});

/* ---------- 输出 ---------- */
const spec = {
  note: '由 node tools/layout/art-spec.js 生成（勿手改）',
  howto: {
    format: 'PNG（透明底）+ 少量 SVG（品质框/段位）',
    delivery: '把 PNG 放进仓库根的 assets-inbox/，文件名 = 表里的「文件名」列，然后跑 npm run assets:apply（自动改名→转 WebP→缩放→落位）',
    size: '表里的尺寸是界面上的 CSS 像素；出图建议按 **2 倍**（如 512×512 就出 1024×1024），脚本会自动缩放',
    rule: ['所有图都不要在图里写字（名字由界面渲染，写了会重影）',
      '透明底：除背景外都要留 alpha 通道',
      '安全区：四周留 8% 空白，避免被圆角/多边形裁掉',
      '不规则多边形元素：**整张画满**即可，界面按多边形裁切',
      '风格统一：光源统一从左上、描边统一 2px 深色外描边、饱和度别拉满'],
  },
  counts: { catalog: catalog.length, ui: ui.length },
  catalog, ui,
};

fs.writeFileSync(path.join(__dirname, 'art-spec.json'), JSON.stringify(spec, null, 1) + '\n');

const L = [];
L.push('# 美术素材规格表（照着画就行）');
L.push('');
L.push('> 生成命令：`node tools/layout/art-spec.js`（本文件自动生成，勿手改）');
L.push('> 与[素材清单](assets-manifest.md)的分工：清单说"缺不缺"，本表说"**该怎么画**"。');
L.push('');
L.push('## 0. 交付方式（先读）');
L.push('');
L.push('| 项 | 约定 |');
L.push('|---|---|');
L.push('| 格式 | ' + spec.howto.format + ' |');
L.push('| 交付 | ' + spec.howto.delivery + ' |');
L.push('| 尺寸 | ' + spec.howto.size + ' |');
L.push('| 命名 | **文件名必须和表里一致**（例 `role_bal.png`、`btn_warehouse.png`、`用户头像.png`）；改名脚本才能认出来 |');
L.push('');
L.push('**画图规则**：');
L.push('');
spec.howto.rule.forEach((r) => L.push('- ' + r));
L.push('');
L.push('**本轮规模**：目录物（角色/技能/插件/节点/包/品质框/段位/背景）**' + catalog.length + '** 张；' +
  '界面控件（含弹窗）**' + ui.length + '** 张。共 ' + (catalog.length + ui.length) + ' 张。');
L.push('');
L.push('**形状速查**：角色=六边形盾牌；技能=菱形盘（主界面会再按不规则多边形裁切）；插件=圆角方牌；' +
  'AI 节点=代码块；包=箱体；品质框=圆角矩形边框；段位=盾形徽章；界面按钮=按表的比例做圆角矩形（不规则的元素已标注多边形顶点）。');
L.push('');

const GROUPS = [
  ['bg', '1. 背景（1 张）', '整屏铺满；中央留白给角色卡'],
  ['role', '2. 角色立绘（' + roles.length + ' 张）', '六边形盾牌轮廓内构图，透明底'],
  ['skill', '3. 技能图标（' + skills.length + ' 张）', '菱形盘；主界面技能盘会按多边形裁切'],
  ['plugin', '4. 插件图标（' + seen.size + ' 张）', '按族根命名（点数变体共用一张）'],
  ['ai', '5. AI 积木节点（' + nodes.length + ' 张）', '代码块外观；不要写字'],
  ['package', '6. 包/宝箱（' + pkgs.length + ' 张）', '箱体 + 缎带'],
  ['frame', '7. 品质框（' + quals.length + ' 张）', '可 SVG；颜色见主色'],
  ['tier', '8. 段位徽章（' + quals.length + ' 张）', '可 SVG；建议用星/角表示档位'],
];
GROUPS.forEach(([kind, title, note]) => {
  const list = catalog.filter((c) => c.kind === kind);
  if (!list.length) return;
  L.push('## ' + title);
  L.push('');
  L.push('> ' + note);
  L.push('');
  L.push('| PNG 文件名 | 尺寸 | 比例 | 形状 | 内容要求 | 用在哪 | 状态 |');
  L.push('|---|---|---|---|---|---|---|');
  list.forEach((c) => L.push('| `' + c.png + '` | ' + c.size + ' | ' + c.ratio + ' | ' + c.shape + ' | ' + c.content + ' | ' +
    c.where + ' | ' + (c.placeholder ? '🧩 已有占位' : '✅ 已有真图') + ' |'));
  L.push('');
});

L.push('## 9. 主界面控件（' + ui.filter((u) => u.kind === 'ui').length + ' 张）');
L.push('');
L.push('> 全部是**主界面**上的按钮/装饰件；比例就是它在 1280×720 画布上的实际占位。都不要写字（界面渲染）。');
L.push('');
L.push('| PNG 文件名 | 尺寸 | 比例 | 形状 | 内容要求 | 位置 | 状态 |');
L.push('|---|---|---|---|---|---|---|');
ui.filter((u) => u.kind === 'ui').forEach((u) => L.push('| ' + (u.png ? '`' + u.png + '`' : '—（数据绑定）') + ' | ' + u.size + ' | ' + u.ratio + ' | ' +
  u.shape + (u.polygon ? '：' + u.polygon : '') + ' | ' + u.content + ' | ' + u.where + ' | ' +
  (u.png ? (u.placeholder ? '🧩 已有占位' : '待出图') : '—') + ' |'));
L.push('');

L.push('## 10. 弹窗控件（' + ui.filter((u) => u.kind === 'ui-modal').length + ' 张）');
L.push('');
L.push('> 点角色卡 / 插槽 / 候选行之后弹出的那些层。面板与标题建议做成"半透明深色卡片 + 描边"的统一风格。');
L.push('');
L.push('| PNG 文件名 | 尺寸 | 比例 | 形状 | 内容要求 | 弹窗 | 状态 |');
L.push('|---|---|---|---|---|---|---|');
ui.filter((u) => u.kind === 'ui-modal').forEach((u) => L.push('| ' + (u.png ? '`' + u.png + '`' : '—（数据绑定）') + ' | ' + u.size + ' | ' + u.ratio + ' | ' +
  u.shape + (u.polygon ? '：' + u.polygon : '') + ' | ' + u.content + ' | ' + u.screen + ' · ' + u.id + ' | ' +
  (u.png ? (u.placeholder ? '🧩 已有占位' : '待出图') : '—') + ' |'));
L.push('');

L.push('## 11. 运行时生成的控件（' + ui.filter((u) => u.kind === 'ui-runtime').length + ' 张）');
L.push('');
L.push('> 这些元素的数量在运行时才知道（插槽数 = 模板 slotCount；候选行数 = 仓库里有多少候选），但**共用同一张底版**。');
L.push('');
L.push('| PNG 文件名 | 尺寸 | 比例 | 形状 | 内容要求 | 用在哪 |');
L.push('|---|---|---|---|---|---|');
ui.filter((u) => u.kind === 'ui-runtime').forEach((u) => L.push('| `' + u.png + '` | ' + u.size + ' | ' + u.ratio + ' | ' + u.shape + ' | ' +
  u.content + ' | ' + u.where + ' |'));
L.push('');
L.push('## 12. 音效（可选，4 个）');
L.push('');
L.push('| 文件名 | 格式 | 内容 | 用在哪 |');
L.push('|---|---|---|---|');
skills.forEach((s) => { if (s.sfxKey) L.push('| `' + s.sfxKey + '.mp3` | MP3 | 「' + s.name + '」施放音效（短促、<1s） | 战斗回放（当前界面未使用，可后补） |'); });
L.push('');
L.push('## 13. 优先级建议');
L.push('');
L.push('1. **先画主界面那 25 张**（第 9 节 + 背景 + 角色 1~2 张 + 技能 4 张）：画完主界面就完全成型；');
L.push('2. 再补**弹窗控件**（第 10 节）与**插件候选**：换装流程的观感；');
L.push('3. 最后补 AI 节点 54 张与其余角色（图鉴/编辑器用）。');
L.push('');

fs.writeFileSync(path.join(ROOT, 'docs', 'frontend', 'art-spec.md'), L.join('\n') + '\n');
console.log('规格表：目录物 ' + catalog.length + ' 张 + 界面控件 ' + ui.length + ' 张（其中弹窗 ' +
  ui.filter((u) => u.kind === 'ui-modal').length + '、运行时 ' + ui.filter((u) => u.kind === 'ui-runtime').length + '）');
console.log('已写 docs/frontend/art-spec.md 与 tools/layout/art-spec.json');
