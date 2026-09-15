// 临时探针：解析 V8 覆盖率 JSON → 指定文件的未覆盖区域（行: 片段）
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const target = process.argv[3]; // 正则
const srcPath = process.argv[4];
const f = fs.readdirSync(dir).find((x) => x.endsWith('.json'));
const cov = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const r = cov.result.find((x) => new RegExp(target).test(x.url));
if (!r) { console.log('result not found'); process.exit(0); }
const src = fs.readFileSync(srcPath, 'utf8');
const lineAt = (off) => src.slice(0, off).split('\n').length;
const out = new Map();
for (const fn of r.functions || []) {
  for (const rg of fn.ranges || []) {
    if ((rg.count || 0) > 0) continue;
    const l = lineAt(rg.start);
    out.set(l, src.slice(rg.start, rg.start + 64).replace(/\n/g, ' '));
  }
}
for (const [l, s] of [...out.entries()].sort((a, b) => a[0] - b[0])) console.log(`${l}: ${s}`);
