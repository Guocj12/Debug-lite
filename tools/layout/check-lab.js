'use strict';
/* tools/layout/check-lab.js —— 布局台自检：脚本语法 + 新按钮元素齐备 + core/app 双脚本存在 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const html = fs.readFileSync(path.join(__dirname, 'lab.html'), 'utf8');
let bad = 0;
['core', 'app'].forEach((id) => {
  const m = html.match(new RegExp('<script id="' + id + '">([\\s\\S]*?)</script>'));
  if (!m) { console.log('✗ 缺少 <script id="' + id + '">'); bad += 1; return; }
  try { new vm.Script(m[1], { filename: 'lab-' + id + '.js' }); console.log('✓ ' + id + ' 脚本语法 OK（' + m[1].split('\n').length + ' 行）'); }
  catch (e) { console.log('✗ ' + id + ' 脚本语法错误：' + e.message); bad += 1; }
});
['btnSaveWs', 'btnManifest', 'btnAssets', 'btnApplyAll', 'btnStatus', 'btnMissing', 'btnMissingAll', 'toolInfo', 'toolPanel'].forEach((id) => {
  if (html.indexOf('id="' + id + '"') < 0) { console.log('✗ 缺少元素 #' + id); bad += 1; }
});
if (!bad) console.log('✓ 新工具按钮与面板齐备');
process.exit(bad ? 1 : 0);
