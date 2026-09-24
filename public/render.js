'use strict';
/* public/render.js —— 纯渲染：视图模型 → HTML 字符串（总纲 §1.4「绘制方法零逻辑」）
 *
 * 硬约束（由 tests/frontend/auth-ui-contract.test.js 与 admin-ui-contract.test.js 机器核对）：
 *   · 本文件**不读响应字段**（不出现字段读取原语，也不出现契约路径字面量）；
 *   · 本文件**不接触应用状态对象**（只接收 format.viewModel 产出的视图模型 vm）；
 *   · 不做公式计算、不拼业务文案 —— 文字一律来自 vm 中已投影好的字符串。
 *
 * F2 增量（docs/frontend/02-accounts.md §3）：新增「结果区 / 行列表（每行按钮带 data-player-id、
 *   data-public-id）/ 二次确认块」三类纯搬运块；标签内文字仍全部来自 vm。
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

  // 结果区：最近一次管理操作的结果（02-accounts.md §3.1；文字由 format 投影）
  function resultHtml(vm) {
    if (!vm.result || !vm.result.text) return '';
    return '<div id="result" class="notice notice-' + esc(vm.result.kind) + '">' + esc(vm.result.text) + '</div>';
  }

  function linesHtml(vm) {
    if (!vm.lines || vm.lines.length === 0) return '';
    return '<div id="lines">' + vm.lines.map(function (line) {
      return '<div class="line">' + esc(line) + '</div>';
    }).join('') + '</div>';
  }

  // 行列表：每行 = 文本（可缺省：如仓库行只有可点的物品名按钮）+ 该行按钮
  //   （按钮的目标经 data-player-id / data-public-id / data-uid / data-slot / data-bucket 携带）
  function rowsHtml(vm) {
    if (!vm.rows || vm.rows.length === 0) return '';
    return '<div id="rows">' + vm.rows.map(function (row) {
      var text = row && row.text ? '<div class="line">' + esc(row.text) + '</div>' : '';
      return '<div class="row">' + text
        + '<div class="row-buttons">' + buttonsHtml(row.buttons) + '</div></div>';
    }).join('') + '</div>';
  }

  // 二次确认块（02-accounts.md §3.2；后端不再二次确认，故前端必须确认）
  function confirmHtml(vm) {
    if (!vm.confirm || !vm.confirm.text) return '';
    return '<div id="confirm" class="confirm">' + '<div class="line">' + esc(vm.confirm.text) + '</div>'
      + '<div class="confirm-buttons">' + buttonsHtml(vm.confirm.buttons) + '</div></div>';
  }

  // 屏内弹窗（F3 §3.7/§3.8；FR-10：弹窗 = 屏内绘制的区块，不是浏览器原生弹窗/新窗口）。
  //   背景元素一律带 data-action="modal-close" —— 点击背景 = 关闭并丢弃未提交输入；
  //   弹窗内另有显式「关闭/取消」按钮（同样来自 vm.modal.buttons）。
  function modalHtml(vm) {
    if (!vm.modal) return '';
    var lines = (vm.modal.lines || []).map(function (line) {
      return '<div class="line">' + esc(line) + '</div>';
    }).join('');
    return '<div id="modal" class="modal">'
      + '<div class="modal-background" data-action="modal-close"></div>'
      + '<div class="modal-body">'
      + '<h3>' + esc(vm.modal.title) + '</h3>'
      + (vm.modal.hint ? '<p class="hint">' + esc(vm.modal.hint) + '</p>' : '')
      + lines
      + '<div class="modal-buttons">' + buttonsHtml(vm.modal.buttons) + '</div>'
      + '</div></div>';
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

  function targetAttrs(button) {
    var out = '';
    if (typeof button.playerId === 'string' && button.playerId !== '') out += ' data-player-id="' + esc(button.playerId) + '"';
    if (typeof button.publicId === 'string' && button.publicId !== '') out += ' data-public-id="' + esc(button.publicId) + '"';
    if (typeof button.uid === 'string' && button.uid !== '') out += ' data-uid="' + esc(button.uid) + '"';
    if (typeof button.slot === 'string' && button.slot !== '') out += ' data-slot="' + esc(button.slot) + '"';
    if (typeof button.bucket === 'string' && button.bucket !== '') out += ' data-bucket="' + esc(button.bucket) + '"';
    return out;
  }

  function buttonsHtml(list) {
    if (!list || list.length === 0) return '';
    return list.map(function (button) {
      return '<button type="' + esc(button.kind === 'submit' ? 'submit' : 'button')
        + '" data-action="' + esc(button.action) + '"' + targetAttrs(button)
        + (button.disabled === true ? ' disabled' : '') + '>'
        + esc(button.label) + '</button>';
    }).join('');
  }

  function render(vm) {
    var parts = [];
    parts.push('<h2>' + esc(vm.title) + '</h2>');
    var notice = noticeHtml(vm);
    if (notice !== '') parts.push(notice);
    var result = resultHtml(vm);
    if (result !== '') parts.push(result);
    if (vm.hint) parts.push('<p class="hint">' + esc(vm.hint) + '</p>');
    parts.push(linesHtml(vm));
    parts.push(rowsHtml(vm));
    parts.push(confirmHtml(vm));
    parts.push(modalHtml(vm));
    var fields = fieldsHtml(vm);
    if (fields !== '') {
      parts.push('<form data-enter="' + esc(vm.enterAction) + '" autocomplete="off">' + fields + '<div class="buttons">' + buttonsHtml(vm.buttons) + '</div></form>');
    } else {
      parts.push('<div class="buttons">' + buttonsHtml(vm.buttons) + '</div>');
    }
    return parts.filter(function (part) { return part !== ''; }).join('\n');
  }

  return { esc: esc, render: render };
});
