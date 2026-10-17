'use strict';
/* public/boot.js —— 浏览器引导（唯一副作用入口：装配 DL.app 并启动）
 *
 * 之所以单独一个文件：public/app.js 保持"可无头 require 的纯装配"，浏览器侧的自动启动放这里，
 * 从而页面无需任何内联脚本（避免内联脚本带来的 XSS 面）。
 *
 * **D-188（2026-10-05）：重新打开布局表驱动渲染。**
 *   用户口径：「现在开始做布局表驱动的界面 删掉所有纯文字和按钮的约束」
 *   ⇒ 下面三行 `setLayout` 注入**放回来了**（D-182 曾把它们注释掉）。
 *   效果：`format.layoutReady()` 为真，主界面走**布局版**（百分比定位 / 多边形命中 / 径向弹窗流）。
 *
 *   主界面既有元素的 `rect` **没有改动**（用户口径：位置与大小由用户自己在布局台微调）；
 *   `grid.flow` / `press` / `assetPressed`（D-188 引擎新增）是**加法**，不影响既有元素的外观。
 *
 *   要**关掉**图形主界面（回到纯文字）：把下面三行注释掉即可（等价于 D-182 的状态）。
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var DL = typeof window !== 'undefined' ? window.DL : null;
  if (!DL || !DL.app || typeof DL.app.createApp !== 'function') return;
  // D-188：**注入布局表**（重新打开图形界面）
  if (DL.format && typeof DL.format.setLayout === 'function' && DL.layoutEngine && DL.layoutData) {
    DL.format.setLayout(DL.layoutEngine, DL.layoutData);
  }
  var app = DL.app.createApp({ doc: document, win: window, DL: DL });
  window.DL.currentApp = app;
  app.start();
})();
