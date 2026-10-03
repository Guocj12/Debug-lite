'use strict';
/* tools/layout/wire-assets-into-layout.js —— 把生成的占位素材接进布局表（幂等）
 *
 * 做两件事：
 *   ① 给布局表里**没有 asset 的按钮/角标**补上 `asset: 'assets/ui/<元素id>.webp'`
 *      （已经设了 asset 的、或用 `{roleIcon}` 这类占位符的：一律不动）
 *   ② 跑一次 import-layout.js → public/layout-data.js
 *
 * 幂等：重复跑不会重复写；`--dry` 只报告要改哪些。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const RAW = path.join(__dirname, 'layout-bundle.raw.json');
const DRY = process.argv.indexOf('--dry') >= 0;

const safeName = (id) => String(id).trim().replace(/[\\/:*?"<>|\s]+/g, '_');

const bundle = JSON.parse(fs.readFileSync(RAW, 'utf8'));
// 判断"哪些元素要底板"要看**修正后**的布局：真源里「设为出战 / 对战历史」还是 deco，
//   导入期才会变成 button（不看 normalized 就会漏掉它们，留下"还没指定素材"的 warn）。
const NORM = path.join(__dirname, 'layout-bundle.normalized.json');
const view = fs.existsSync(NORM) ? JSON.parse(fs.readFileSync(NORM, 'utf8')) : bundle;
const wantUi = new Set();
Object.keys(view.screens).forEach((sname) => {
  (view.screens[sname].elements || []).forEach((el) => {
    if (el.asset) return;                                   // 已设素材（含 {占位符}）→ 不动
    const isBadge = String(el.id).indexOf('battle_badge') === 0;
    if (el.kind !== 'button' && !isBadge) return;            // 纯装饰件（文字）不加底板
    if (!fs.existsSync(path.join(ROOT, 'public', 'assets', 'ui', safeName(el.id) + '.webp'))) return;
    wantUi.add(sname + '\u0000' + el.id);
  });
});
let wired = 0;
const planned = [];
Object.keys(bundle.screens).forEach((sname) => {
  bundle.screens[sname].elements.forEach((el) => {
    if (el.asset) return;
    if (!wantUi.has(sname + '\u0000' + el.id)) return;
    const rel = 'assets/ui/' + safeName(el.id) + '.webp';
    el.asset = rel;
    wired += 1;
    planned.push(sname + '/' + el.id + ' → ' + rel);
  });
});

if (wired === 0) {
  console.log('布局表已经全部接好（没有需要补 asset 的元素）');
} else if (DRY) {
  console.log('--dry：将给 ' + wired + ' 个元素补 asset：');
  planned.slice(0, 40).forEach((p) => console.log('  ' + p));
} else {
  fs.writeFileSync(RAW, JSON.stringify(bundle, null, 2) + '\n');
  console.log('已给 ' + wired + ' 个元素补上 asset（写入 ' + path.basename(RAW) + '）');
  const out = execFileSync(process.execPath, [path.join(__dirname, 'import-layout.js')], { cwd: ROOT, encoding: 'utf8' });
  console.log(out.trim().split('\n').slice(-2).join('\n'));
  planned.slice(0, 30).forEach((p) => console.log('  ' + p));
  if (planned.length > 30) console.log('  … 还有 ' + (planned.length - 30) + ' 个');
}
