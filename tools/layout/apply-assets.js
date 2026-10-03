'use strict';
/* tools/layout/apply-assets.js —— 把 assets-inbox/ 里的素材**自动归位**到 public/assets/ 对应路径
 *
 * 用户只需要：把图按"清单里的文件名"丢进仓库根目录的 `assets-inbox/`（可以带子目录、可以是 png/jpg/webp）。
 * 本脚本负责：识别 → 改名 → （位图）转 WebP + 缩放到建议尺寸 → 放进 `public/assets/<kind>/<id>.<ext>`
 *   → 打印"已归位 / 仍缺 / 认不出来的文件"。
 *
 * 支持的文件名写法（任选其一）：
 *   · `role_bal.png`                 ← 直接用品类 id（最省事，推荐）
 *   · `assets-inbox/role/role_bal.png` ← 按目标目录放
 *   · `role__role_bal.png`           ← `<kind>__<id>`
 *   · `hub_main.png`                 ← 背景图用屏幕名
 *
 * SVG 只用于矢量类（frame/tier）；位图类收到 SVG 会明确报错（避免"服务端按扩展名给错 content-type"）。
 *
 * 用法：
 *   node tools/layout/apply-assets.js            # 归位（会改动 public/assets/）
 *   node tools/layout/apply-assets.js --dry      # 只预演，不动文件
 *   node tools/layout/apply-assets.js --inbox D:\我的素材   # 指定收件夹
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const manifestMod = require('./asset-manifest.js');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC_ASSETS = path.join(ROOT, 'public', 'assets');
const RASTER = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const VECTOR = ['.svg'];

function findPython() {
  const cands = [process.env.DL_PYTHON,
    'C:/Users/12444/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe',
    'python', 'python3', 'py'];
  for (const c of cands) {
    if (!c) continue;
    try {
      execFileSync(c, ['-c', 'import PIL, sys; sys.stdout.write(PIL.__version__)'], { stdio: 'pipe' });
      return c;
    } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/** 用 Pillow 把任意位图转成 WebP（保留透明通道）+ 限制最长边 */
function convertToWebp(py, src, dest, maxEdge) {
  const script = [
    'import sys',
    'from PIL import Image',
    'src, dest, max_edge = sys.argv[1], sys.argv[2], int(sys.argv[3])',
    "im = Image.open(src)",
    "im = im.convert('RGBA') if im.mode in ('P','LA','RGBA') or 'transparency' in im.info else im.convert('RGB')",
    'w, h = im.size',
    'if max_edge > 0 and max(w, h) > max_edge:',
    '    k = max_edge / float(max(w, h))',
    '    im = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)',
    "im.save(dest, 'WEBP', quality=90, method=5)",
  ].join('\n');
  execFileSync(py, ['-c', script, src, dest, String(maxEdge)], { stdio: 'pipe' });
}

function walk(dir, base, out) {
  base = base || dir;
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  fs.readdirSync(dir).forEach((name) => {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) return walk(p, base, out);
    out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/'), name });
  });
  return out;
}

function maxEdgeOf(specSize) {
  const m = /(\d+)\s*[×x]\s*(\d+)/.exec(String(specSize || ''));
  return m ? Math.max(Number(m[1]), Number(m[2])) : 512;
}

/** 把一个收件夹文件匹配到清单条目（返回 entry 或 null） */
function matchEntry(entries, file) {
  const ext = path.extname(file.name).toLowerCase();
  const base = path.basename(file.name, path.extname(file.name));
  const relNoExt = file.rel.replace(/\.[^./]+$/, '');
  // 认这几种写法：<id> / <目标文件名> / <kind>__<id> / <kind>_<id> / <kind>/<id>（收件夹里带子目录）
  for (const e of entries) {
    const targetNoExt = e.path.replace(/^assets\//, '').replace(/\.[^.]+$/, '');
    const targetBase = path.basename(targetNoExt);
    const id = String(e.id);
    if (base === id || base === targetBase) return e;
    if (relNoExt === targetNoExt || relNoExt === e.kind + '/' + id) return e;
    if (base === e.kind + '__' + id || base === e.kind + '_' + id) return e;
  }
  void ext;
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  const dry = argv.indexOf('--dry') >= 0;
  const inIdx = argv.indexOf('--inbox');
  const INBOX = inIdx >= 0 ? path.resolve(argv[inIdx + 1]) : path.join(ROOT, 'assets-inbox');

  const m = manifestMod.build();
  const files = walk(INBOX);
  const py = findPython();

  console.log('收件夹：' + INBOX + (fs.existsSync(INBOX) ? '' : '（不存在 → 先建它并把素材丢进去）'));
  console.log('清单：共 ' + m.summary.total + ' 项，缺 ' + m.summary.missing + '（其中主界面优先 ' + m.summary.coreMissing + '）');
  console.log('收件夹文件：' + files.length + ' 个' + (py ? '｜Pillow 可用（位图会自动转 WebP + 缩放）' : '｜⚠ 未找到 Pillow：只做改名/搬移，位图需自己转成清单要求的格式'));
  console.log('');

  const applied = [];
  const failed = [];
  const unmatched = [];
  files.forEach((f) => {
    const ext = path.extname(f.name).toLowerCase();
    const e = matchEntry(m.entries, f);
    if (!e) { unmatched.push(f.rel); return; }
    const wantVector = e.format === 'svg';
    const dest = path.join(ROOT, 'public', e.path);
    const destExt = path.extname(dest).toLowerCase();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      if (wantVector) {
        if (VECTOR.indexOf(ext) < 0) throw new Error('这一类需要 SVG（矢量），收到的却是 ' + ext);
        if (!dry) fs.copyFileSync(f.abs, dest);
      } else if (RASTER.indexOf(ext) >= 0) {
        if (ext === '.webp' || !py) {
          // 已经是 WebP（或没有 Pillow）：只改名搬移
          if (destExt !== ext && destExt !== '.webp') throw new Error('目标要求 ' + destExt + '，收到 ' + ext + '（没有 Pillow 时无法转换）');
          if (!dry) fs.copyFileSync(f.abs, dest);
        } else if (!dry) {
          convertToWebp(py, f.abs, dest, maxEdgeOf(e.size));
        }
      } else {
        throw new Error('不支持的格式 ' + ext);
      }
      applied.push({ from: f.rel, to: e.path, label: e.label });
    } catch (err) {
      failed.push({ from: f.rel, want: e.path, why: err.message });
    }
  });

  console.log('✅ 已归位 ' + applied.length + ' 个' + (dry ? '（--dry 预演，未落盘）' : ''));
  applied.slice(0, 40).forEach((a) => console.log('   ' + a.from + '  →  ' + a.to + '   (' + (a.label || '') + ')'));
  if (applied.length > 40) console.log('   … 还有 ' + (applied.length - 40) + ' 个');
  if (failed.length) {
    console.log('\n⚠ 名字对上了但没成功 ' + failed.length + ' 个：');
    failed.forEach((x) => console.log('   ' + x.from + ' → 想要 ' + x.want + '：' + x.why));
  }
  if (unmatched.length) {
    console.log('\n❓ 认不出来的文件 ' + unmatched.length + ' 个（文件名要等于清单里的 ID，或按 kind/id 放）：');
    unmatched.slice(0, 30).forEach((x) => console.log('   ' + x));
  }

  // 归位后再算一次缺什么（dry 模式按"预计已归位"算）
  const after = manifestMod.build();
  const stillMissing = after.entries.filter((e) => e.status === '缺' && !e.optional);
  console.log('\n📋 归位后仍缺 ' + stillMissing.length + ' 项（主界面优先 ' +
    stillMissing.filter((e) => e.priority === 'core').length + '）：');
  stillMissing.slice(0, 25).forEach((e) => console.log('   ❌ ' + path.basename(e.path) + '  ← ' + (e.label || '')));
  if (stillMissing.length > 25) console.log('   … 完整清单见 docs/frontend/assets-manifest.md');
  fs.writeFileSync(path.join(__dirname, 'assets-manifest.json'), JSON.stringify(after, null, 1) + '\n');
  fs.writeFileSync(path.join(ROOT, 'docs', 'frontend', 'assets-manifest.md'), manifestMod.toMarkdown(after) + '\n');
  console.log('\n（清单已刷新：docs/frontend/assets-manifest.md）');
}

module.exports = { findPython, convertToWebp, matchEntry, walk };
if (require.main === module) main();
