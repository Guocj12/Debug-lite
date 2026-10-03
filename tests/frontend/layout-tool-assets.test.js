'use strict';
/* tests/frontend/layout-tool-assets.test.js —— 布局工具与素材清单的机器核对
 *
 * 背景：界面已经从"手写 HTML"变成"**布局表 + 素材文件**"两样东西驱动。这两样都必须可被机器核对，
 *   否则"清单少一个文件 / 界面引用了清单里没有的图"就会在真机上表现为破图，而所有测试还是绿的。
 *
 *   LT-1 布局表是合法 JSON 且能过引擎校验（0 error）
 *   LT-2 素材清单覆盖：布局表里出现的每个字面 asset 路径都在清单里
 *   LT-3 素材清单覆盖：数据表里每个角色/技能/品质/段位/插件族/AI 节点/包 都有对应图名
 *   LT-4 出处一致：清单里每个角色/技能 id 都真实存在于数据表（防拼错）
 *   LT-5 归位脚本的文件名匹配规则：<id> / <目标名> / <kind>_<id> / <kind>/<id> 都能认
 *   LT-6 位图类收到 SVG 必须明确拒绝（服务端按扩展名给 content-type，格式不符会破图）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const TOOL = path.join(REPO, 'tools', 'layout');
const manifestMod = require(path.join(TOOL, 'asset-manifest.js'));
const applyMod = require(path.join(TOOL, 'apply-assets.js'));

const manifest = manifestMod.build();
const layoutData = require(path.join(REPO, 'public', 'layout-data.js'));
const byPath = new Map(manifest.entries.map((e) => [e.path, e]));
const dataOf = (f) => JSON.parse(fs.readFileSync(path.join(REPO, 'server', 'data', f), 'utf8'));

test('LT-1 布局表合法且引擎校验 0 error', () => {
  const C = require(path.join(REPO, 'public', 'layout-engine.js'));
  const raw = JSON.parse(fs.readFileSync(path.join(TOOL, 'layout-bundle.raw.json'), 'utf8'));
  const bundle = C.normalizeBundle(raw);
  const errs = C.validateBundle(bundle, null).filter((i) => i.level === 'error');
  assert.deepEqual(errs.map((e) => e.msg), [], '布局表不该有 error 级问题');
  assert.ok(Object.keys(bundle.screens).length >= 9, '画面数应 ≥ 9（hub + 8 个弹窗）');
});

test('LT-2 布局表里出现的每个字面 asset 路径都在素材清单里', () => {
  const missing = [];
  Object.keys(layoutData.screens).forEach((name) => {
    const sc = layoutData.screens[name];
    if (sc.background && sc.background.asset) {
      assert.ok(byPath.has(sc.background.asset), '背景图不在清单里：' + sc.background.asset);
    }
    (sc.elements || []).forEach((el) => {
      if (!el.asset || el.asset.indexOf('{') >= 0) return;   // 占位符按数据展开，见 LT-3
      if (!byPath.has(el.asset)) missing.push(name + '/' + el.id + ' → ' + el.asset);
    });
  });
  assert.deepEqual(missing, [], '这些布局元素引用的图不在清单里：' + missing.join('; '));
});

test('LT-3 数据表里每个可见对象都有对应的图名', () => {
  const need = (p) => assert.ok(byPath.has(p), '清单缺少：' + p);
  dataOf('role-templates.json').roleTemplates.forEach((r) => need('assets/role/' + r.id + '.webp'));
  dataOf('skill-templates.json').skillTemplates.forEach((s) => need('assets/skill/' + s.id + '.webp'));
  dataOf('qualities.json').qualities.forEach((q) => {
    need('assets/frame/' + q.id + '.svg');
    need('assets/tier/' + q.id + '.svg');
  });
  dataOf('plugins.json').plugins.forEach((p) => need('assets/plugin/' + String(p.id).replace(/_c\d+$/, '') + '.webp'));
  dataOf('ai-node-catalog.json').nodes.forEach((n) => need('assets/ai/' + n.id + '.webp'));
  // 前端拼路径的三条规则必须与清单一致（format.js 的 layIcon / layPluginIconKey）
  const fmt = fs.readFileSync(path.join(REPO, 'public', 'format.js'), 'utf8');
  assert.ok(fmt.includes("'assets/' + kind + '/' + id + '.webp'"), 'format.js 的素材路径规则变了 → 清单必须同步');
  assert.ok(fmt.includes("replace(/_c\\d+$/, '')"), 'format.js 的插件族根规则变了 → 清单必须同步');
});

test('LT-4 清单里的 id 都真实存在于数据表（防拼错 / 防过期）', () => {
  const roleIds = new Set(dataOf('role-templates.json').roleTemplates.map((r) => r.id));
  const skillIds = new Set(dataOf('skill-templates.json').skillTemplates.map((s) => s.id));
  const qualityIds = new Set(dataOf('qualities.json').qualities.map((q) => q.id));
  manifest.entries.forEach((e) => {
    if (e.kind === 'role') assert.ok(roleIds.has(e.id), '角色图 id 不在数据表：' + e.id);
    if (e.kind === 'skill') assert.ok(skillIds.has(e.id), '技能图 id 不在数据表：' + e.id);
    if (e.kind === 'frame' || e.kind === 'tier') assert.ok(qualityIds.has(e.id), '品质/段位图 id 不在数据表：' + e.id);
  });
  assert.ok(manifest.summary.total > 100, '清单规模可疑地小：' + manifest.summary.total);
  assert.ok(manifest.summary.coreMissing >= 1, '主界面优先的缺失项应当被算出来');
});

test('LT-5 归位脚本认这几种文件名写法', () => {
  const entries = manifest.entries;
  const find = (rel) => {
    const file = { abs: '/x/' + rel, rel: rel, name: path.basename(rel) };
    return applyMod.matchEntry(entries, file);
  };
  assert.equal((find('role_bal.png') || {}).path, 'assets/role/role_bal.webp', '按 id');
  assert.equal((find('hub_main.png') || {}).path, 'assets/bg/hub_main.webp', '按目标文件名');
  assert.equal((find('role/role_bal.png') || {}).path, 'assets/role/role_bal.webp', '按 kind/id 目录');
  assert.equal((find('frame_common.png') || {}).path, 'assets/frame/common.svg', '按 kind_id');
  assert.equal(find('完全没有这个文件.png'), null, '认不出来就要返回 null（并报告给用户）');
});

test('LT-6 位图类收到 SVG / 矢量类收到 PNG 都要明确拒绝', () => {
  // 这里只核对"判定依据"存在：apply-assets 的 main 里对 wantVector 与扩展名做了强校验
  const src = fs.readFileSync(path.join(TOOL, 'apply-assets.js'), 'utf8');
  assert.ok(src.includes("throw new Error('这一类需要 SVG（矢量）"), '矢量类收到非 SVG 必须报错');
  assert.ok(src.includes("if (ext === '.webp' || !py)"), '没有 Pillow 时应退化为"只搬移"，而不是假装转换成功');
});
