'use strict';
/* public/render.js —— 纯渲染：视图模型 → HTML 字符串（总纲 §1.4「绘制方法零逻辑」）
 *
 * 硬约束（由 tests/frontend/auth-ui-contract.test.js 机器核对）：
 *   · 本文件**不读响应字段**（不出现字段读取原语，也不出现契约路径字面量）；
 *   · 本文件**不接触应用状态对象**（只接收 format.viewModel 产出的视图模型 vm）；
 *   · 不做公式计算、不拼业务文案 —— 文字一律来自 vm 中已投影好的字符串。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.render = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function noticeHtml(vm) {
    if (!vm.notice || !vm.notice.text) return '';
    return '<div id="notice" class="notice notice-' + esc(vm.notice.kind) + '">' + esc(vm.notice.text) + '</div>';
  }

  function linesHtml(vm) {
    if (!vm.lines || vm.lines.length === 0) return '';
    return '<div id="lines">' + vm.lines.map(function (line) {
      return '<div class="line">' + esc(line) + '</div>';
    }).join('') + '</div>';
  }

  function fieldsHtml(vm) {
    if (!vm.fields || vm.fields.length === 0) return '';
    return vm.fields.map(function (field) {
      return '<div class="field">'
        + '<label for="input-' + esc(field.name) + '">' + esc(field.label) + '</label>'
        + '<input id="input-' + esc(field.name) + '" name="' + esc(field.name) + '" type="' + esc(field.type)
        + '" value="' + esc(field.value) + '" autocomplete="off">'
        + '</div>';
    }).join('');
  }

  function buttonsHtml(vm) {
    if (!vm.buttons || vm.buttons.length === 0) return '';
    return vm.buttons.map(function (button) {
      return '<button type="' + esc(button.kind === 'submit' ? 'submit' : 'button')
        + '" data-action="' + esc(button.action) + '"' + (button.disabled === true ? ' disabled' : '') + '>'
        + esc(button.label) + '</button>';
    }).join('');
  }

  function render(vm) {
    var parts = [];
    parts.push('<h2>' + esc(vm.title) + '</h2>');
    var notice = noticeHtml(vm);
    if (notice !== '') parts.push(notice);
    if (vm.hint) parts.push('<p class="hint">' + esc(vm.hint) + '</p>');
    parts.push(linesHtml(vm));
    var fields = fieldsHtml(vm);
    if (fields !== '') {
      parts.push('<form data-enter="' + esc(vm.enterAction) + '" autocomplete="off">' + fields + '<div class="buttons">' + buttonsHtml(vm) + '</div></form>');
    } else {
      parts.push('<div class="buttons">' + buttonsHtml(vm) + '</div>');
    }
    return parts.join('\n');
  }

  return { esc: esc, render: render };
});
