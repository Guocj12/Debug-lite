'use strict';
/* public/boot.js —— 浏览器引导（唯一副作用入口：装配 DL.app 并启动）
 *
 * 之所以单独一个文件：public/app.js 保持"可无头 require 的纯装配"，浏览器侧的自动启动放这里，
 * 从而页面无需任何内联脚本（避免内联脚本带来的 XSS 面）。
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var DL = typeof window !== 'undefined' ? window.DL : null;
  if (!DL || !DL.app || typeof DL.app.createApp !== 'function') return;
  var app = DL.app.createApp({ doc: document, win: window, DL: DL });
  window.DL.currentApp = app;
  app.start();
})();
