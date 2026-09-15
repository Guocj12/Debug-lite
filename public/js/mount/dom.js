'use strict';
/* mount/dom.js —— 浏览器专属 DOM 缝（下载/文件选择），effects 层经 ctx.dom 调用。
 * node 环境（无 doc）不参与——save/export 走 toast 提示臂。
 */
export function createDomHelpers(doc) {
  return {
    // 下载文本文件（存档/日志导出）
    download(filename, text) {
      const a = doc.createElement('a');
      const blob = new Blob([text], { type: 'application/json' });
      a.href = URL.createObjectURL(blob);
      a.download = String(filename || 'download.json');
      doc.body.appendChild(a);
      a.click();
      doc.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    },
    // 文件选择器 → Promise<text>（存档导入；用户取消 → null）
    pickText(accept) {
      return new Promise((resolve) => {
        const input = doc.createElement('input');
        input.type = 'file';
        input.accept = accept || '.json';
        let settled = false;
        input.addEventListener('change', () => {
          const file = input.files && input.files[0];
          if (!file) return; // 取消 → 不 resolve（保持弹窗关闭语义）
          const reader = new FileReader();
          reader.onload = () => { settled = true; resolve(String(reader.result || '')); };
          reader.onerror = () => { settled = true; resolve(''); };
          reader.readAsText(file);
        });
        doc.body.appendChild(input);
        input.click();
        doc.body.removeChild(input);
      });
    },
  };
}
