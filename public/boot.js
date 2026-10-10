'use strict';
/* public/boot.js —— 浏览器引导（唯一副作用入口：装配 DL.app 并启动）
 *
 * 之所以单独一个文件：public/app.js 保持"可无头 require 的纯装配"，浏览器侧的自动启动放这里，
 * 从而页面无需任何内联脚本（避免内联脚本带来的 XSS 面）。
 *
 * **D-182：前端回到「纯文字 + 按钮」** —— 本文件**刻意不调用** `DL.format.setLayout(...)`。
 *   布局表驱动（F9 的径向插槽流 / 多边形命中 / 百分比定位）因此**不生效**，主界面走
 *   `format.hubViewModel` 的**文字版**（摘要行 + 12 颗按钮），与其余屏完全一致。
 *
 *   保留的东西（都还在，只是没有调用方）：
 *     · `public/layout-engine.js` / `public/layout-data.js` —— 布局引擎与布局表（仍在磁盘、仍由 index.html 加载）
 *     · `public/app.css` 的 `.dl-*` 规则 —— 布局渲染用的样式
 *     · `tools/layout/**` + 四条 npm 脚本 —— 画/改布局表的可视化工具
 *     · `actions.js` 的 7 个 `layout-*` 动作 —— 布局按钮的动作实现
 *   要**重新打开**图形主界面：把下面那段 `setLayout` 注入放回来即可（原本就写在注释位置）。
 */
(function () {
  'use strict';
  if (typeof document === 'undefined') return;
  var DL = typeof window !== 'undefined' ? window.DL : null;
  if (!DL || !DL.app || typeof DL.app.createApp !== 'function') return;
  // D-182：**不注入布局表**（下面三行是"重新打开图形主界面"的开关；当前为关闭状态）
  // if (DL.format && typeof DL.format.setLayout === 'function' && DL.layoutEngine && DL.layoutData) {
  //   DL.format.setLayout(DL.layoutEngine, DL.layoutData);
  // }
  var app = DL.app.createApp({ doc: document, win: window, DL: DL });
  window.DL.currentApp = app;
  app.start();
})();
