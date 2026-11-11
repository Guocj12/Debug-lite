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
  //   （按钮的目标经 data-player-id / data-public-id / data-uid / data-slot / data-bucket /
  //     data-pos / data-idx / data-empty / data-ai-id 携带）
  function rowListHtml(rows) {
    if (!rows || rows.length === 0) return '';
    return rows.map(function (row) {
      var text = row && row.text ? '<div class="line">' + esc(row.text) + '</div>' : '';
      return '<div class="row">' + text
        + '<div class="row-buttons">' + buttonsHtml(row.buttons) + '</div></div>';
    }).join('');
  }

  function rowsHtml(vm) {
    if (!vm.rows || vm.rows.length === 0) return '';
    return '<div id="rows">' + rowListHtml(vm.rows) + '</div>';
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
  //   提交③ 的两级弹窗复用同一机制：弹窗内也可以有**行列表**（候选：一行一个可点按钮；
  //   不匹配的候选由 format 置 disabled 并在该行文本里写明原因）。
  function modalHtml(vm) {
    if (!vm.modal) return '';
    var lines = (vm.modal.lines || []).map(function (line) {
      return '<div class="line">' + esc(line) + '</div>';
    }).join('');
    var rows = vm.modal.rows && vm.modal.rows.length > 0
      ? '<div class="modal-rows">' + rowListHtml(vm.modal.rows) + '</div>'
      : '';
    return '<div id="modal" class="modal">'
      + '<div class="modal-background" data-action="modal-close"></div>'
      + '<div class="modal-body">'
      + '<h3>' + esc(vm.modal.title) + '</h3>'
      + (vm.modal.hint ? '<p class="hint">' + esc(vm.modal.hint) + '</p>' : '')
      + lines
      + rows
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

  // F5/D-172：多行输入（**唯一用途** = AI 编辑器「导入 JSON」，用户裁决 ③）
  function textareaHtml(vm) {
    if (!vm.textarea) return '';
    return '<div class="field">'
      + '<label for="input-' + esc(vm.textarea.name) + '">' + esc(vm.textarea.label) + '</label>'
      + '<textarea id="input-' + esc(vm.textarea.name) + '" name="' + esc(vm.textarea.name) + '" rows="8">'
      + esc(vm.textarea.value) + '</textarea>'
      + '</div>';
  }

  function targetAttrs(button) {
    var out = '';
    if (typeof button.playerId === 'string' && button.playerId !== '') out += ' data-player-id="' + esc(button.playerId) + '"';
    if (typeof button.publicId === 'string' && button.publicId !== '') out += ' data-public-id="' + esc(button.publicId) + '"';
    if (typeof button.uid === 'string' && button.uid !== '') out += ' data-uid="' + esc(button.uid) + '"';
    if (typeof button.slot === 'string' && button.slot !== '') out += ' data-slot="' + esc(button.slot) + '"';
    if (typeof button.bucket === 'string' && button.bucket !== '') out += ' data-bucket="' + esc(button.bucket) + '"';
    // F3 提交③：配置编辑器的位置寻址（pos=角色/技能N/AI；idx=插槽序号；empty=`空`候选；aiId=库内引用）
    if (typeof button.pos === 'string' && button.pos !== '') out += ' data-pos="' + esc(button.pos) + '"';
    if (typeof button.idx === 'string' && button.idx !== '') out += ' data-idx="' + esc(button.idx) + '"';
    if (button.empty === true) out += ' data-empty="1"';
    if (typeof button.aiId === 'string' && button.aiId !== '') out += ' data-ai-id="' + esc(button.aiId) + '"';
    // F7：排行榜的"范围"按钮（board-scope）用 data-tier 携带段位（'' = 全部）
    if (typeof button.tier === 'string' && button.tier !== '') out += ' data-tier="' + esc(button.tier) + '"';
    // F10/D-180：战绩屏的筛选按钮（records-filter）用 data-role 携带 attacker/defender（'' = 全部）
    if (typeof button.role === 'string' && button.role !== '') out += ' data-role="' + esc(button.role) + '"';
    // F5/D-172：AI 编辑器——节点地址 / 字段键 / 枚举取值（按钮即"设值"）
    if (typeof button.addr === 'string' && button.addr !== '') out += ' data-addr="' + esc(button.addr) + '"';
    if (typeof button.field === 'string' && button.field !== '') out += ' data-field="' + esc(button.field) + '"';
    if (typeof button.value === 'string' && button.value !== '') out += ' data-value="' + esc(button.value) + '"';
    // D-179 修复：积木编辑器的「添加积木节点」与「套用模板」两个按钮的载荷。
    //   背景（用户实测复盘）：format.js 早就产出 `node`/`preset` 字段，但 render.js 不搬运、app.js 不收集
    //   → 点击后 payload 为空 → ai-node-append 直接 return、ai-bp-preset 报"模板不在清单里"，
    //   而积木编辑器的核心交互（加节点）就此完全失效。字段级契约见 tests/frontend/button-payload-contract.test.js。
    if (typeof button.node === 'string' && button.node !== '') out += ' data-node="' + esc(button.node) + '"';
    if (typeof button.preset === 'string' && button.preset !== '') out += ' data-preset="' + esc(button.preset) + '"';
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

  // F5/D-172：**有序区块**（`vm.blocks`）—— 让"小节标题 → 紧随其后的内容"按声明顺序渲染。
  //   背景（用户实测反馈）：扁平 vm 会把**所有 `lines` 先渲染、所有 `rows` 后渲染**，于是「程序结构」标题
  //   与程序树被拆到屏幕两端、分支标签/节点表单各归各块 —— 读者看不出逻辑之间的层级关系。
  //   未声明 `vm.blocks` 的屏走原路径（渲染结果逐字不变）。
  function blocksHtml(vm) {
    return (vm.blocks || []).map(function (b) {
      if (!b || typeof b !== 'object') return '';
      if (b.kind === 'lines') return linesHtml({ lines: b.lines });
      if (b.kind === 'rows') return rowsHtml({ rows: b.rows });
      if (b.kind === 'fields') return b.fields && b.fields.length > 0 ? '<div id="inputs">' + fieldsHtml({ fields: b.fields }) + '</div>' : '';
      if (b.kind === 'buttons') return b.buttons && b.buttons.length > 0 ? '<div class="buttons">' + buttonsHtml(b.buttons) + '</div>' : '';
      if (b.kind === 'textarea') return '<div id="inputs">' + textareaHtml({ textarea: b.textarea }) + '</div>';
      return '';
    }).filter(function (part) { return part !== ''; }).join('\n');
  }

  /* ---------- F9/D-180：布局表驱动的界面（主界面 + 径向弹窗） ----------
   * 只做「渲染指令 → HTML 字符串」：不读数据、不算几何（clip 与文案都由 format.js 算好）。
   * 载荷字段一律落到 data-*，与 app.js 的 payloadOf 收集表**双向相等**（BP-1 机器核对）——
   * 因此这里刻意用显式的 `button.<字段>` 读法，新增字段会被 BP-1 立刻发现。
   */
  function layPct(v, total) { return ((v / total) * 100).toFixed(4) + '%'; }

  /**
   * 把元素的 **payload** 落成 `data-*`（动作层靠它拿参数）。
   *
   * D-194：改成**通用透传**，不再维护白名单。白名单踩过两次同样的坑：
   *   · D-188 漏了 `bucket` → 仓库格子打不开正确的详情分组；
   *   · D-194 漏了 `node`  → 节点库的行拿不到"这是哪个节点"，拖放/追加全哑。
   *   凡是 payload 里的标量都该到 DOM；名字统一转成 kebab-case（`parentAddr` → `data-parent-addr`）。
   *   `null` / `undefined` / 空串 / 对象/数组 一律跳过（动作层只认标量）。
   */
  function layAttrs(button) {
    var out = '';
    if (!button || typeof button !== 'object') return out;
    Object.keys(button).forEach(function (k) {
      var v = button[k];
      if (v === undefined || v === null || v === '') return;
      if (typeof v === 'object') return;
      var name = String(k).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9-]/g, '').toLowerCase();
      if (name === '' || name === 'action') return;      // action 单独由调用方写成 data-action
      out += ' data-' + name + '="' + esc(String(v)) + '"';
    });
    return out;
  }

  function layoutElHtml(el, canvas, childrenHtml, parentRect) {
    // 只有**载荷**用 `button.` 读（BP-1 用 `button.<字段>` 提取"被搬运的载荷字段"，
    //   展示字段（rect/hit/asset/…）走 `el.`，否则会把展示字段误算成载荷）
    var button = el.payload || {};
    var isDeco = el.kind === 'deco';
    var isInput = el.kind === 'input' || el.kind === 'textarea';   // D-194：都不是按钮
    var cls = 'dl-el ' + (isInput ? 'dl-input' : (isDeco ? 'dl-deco' : 'dl-btn'));
    if (el.hit === 'path') cls += ' dl-hit-path';
    if (el.hit === 'ellipse') cls += ' dl-hit-ellipse';
    if (!el.asset && !isDeco && !isInput) cls += ' dl-ph';
    if (el.muted) cls += ' dl-muted';   // 候选不匹配：标灰（原因写在 label 里）
    if (el.scroll) cls += ' dl-scroll';                    // D-185：滚动容器
    // D-195：可平移的容器自己就是**交互表面**（空白处要接住滚轮 / 拖动 / 点空白收起）。
    //   `.dl-deco` 默认 pointer-events:none，空白处会穿到 `.dl-screen`，于是滚轮/平移都收不到。
    if (el.pan) cls += ' dl-pan';
    if (el.clickThrough) cls += ' dl-clickthrough';        // D-185：不可点（透给下层）
    if (el.dropHi) cls += ' dl-drop-hi';                   // 功能B：拖动落点高亮
    // D-188：按下行为四模式 —— 类名交给 CSS 处理（tap 走 :active、hover 走 :hover），
    //   sticky/state 由引擎算出的 `pressed` 直接落类（服务端状态驱动的"保持按下"）。
    if (el.press) cls += ' dl-press-' + String(el.press).replace(/[^a-z]/g, '');
    if (el.pressed) cls += ' dl-pressed';
    // D-194：行列表（rowsFrom）的选中态与"槽位头"弱化
    if (el.sel) cls += ' dl-row-sel';
    if (el.slot) cls += ' dl-row-slot';
    // 尺寸类：让 CSS 能给大控件配大字号（角色卡 300px 高，用 14px 字太小）
    if (el.rect[3] >= 160) cls += ' dl-lg'; else if (el.rect[3] <= 28) cls += ' dl-sm';
    // D-195：**子元素按父容器换算百分比**（因为现在真嵌套了：% 是相对父元素盒子的）。
    //   以前全部平铺在 .dl-screen 里，% 一律按画布算；嵌套后必须换成父容器的宽高，
    //   否则"树面板里的行"会被算成画布的 % ⇒ 尺寸和位置全错。
    var pw = parentRect ? parentRect[2] : canvas.w;
    var ph = parentRect ? parentRect[3] : canvas.h;
    var style = 'left:' + layPct(el.rect[0], pw) + ';top:' + layPct(el.rect[1], ph)
      + ';width:' + layPct(el.rect[2], pw) + ';height:' + layPct(el.rect[3], ph)
      + ';z-index:' + String(10 + (el.z || 1));
    if (el.rot) style += ';transform:rotate(' + Number(el.rot) + 'deg)';
    if (el.clip) style += ';--dl-clip:' + el.clip;
    if (el.opacity !== undefined && el.opacity < 1) style += ';opacity:' + Number(el.opacity);
    // 文字样式（D-185）：字号/颜色/对齐/行高走 CSS 变量，由 app.css 消费
    if (el.font) {
      if (el.font.size) style += ';--dl-fs:' + Number(el.font.size) + 'px';
      if (el.font.color) style += ';--dl-color:' + esc(String(el.font.color));
      if (el.font.align) style += ';--dl-align:' + esc(String(el.font.align));
      if (el.font.lineHeight) style += ';--dl-lh:' + Number(el.font.lineHeight);
    }
    // 滚动容器（D-185）：**用原生滚动**给"丝滑自然"的手感；设计期的 left/top 只是初始偏移
    // 滚动容器（D-185）：**用原生滚动**给"丝滑自然"的手感；设计期的 left/top 写成初始偏移
    var extraData = '';
    if (el.scroll) {
      var dir = el.scroll.dir || 'v';
      style += ';overflow-x:' + ((dir === 'h' || dir === 'both') ? 'auto' : 'hidden');
      style += ';overflow-y:' + ((dir === 'v' || dir === 'both') ? 'auto' : 'hidden');
      style += ';-webkit-overflow-scrolling:touch';
      if (el.scroll.fade) cls += ' dl-scroll-fade';
      if (el.scroll.top) extraData += ' data-scroll-top="' + Number(el.scroll.top) + '"';
      if (el.scroll.left) extraData += ' data-scroll-left="' + Number(el.scroll.left) + '"';
    }
    var attrs = ' class="' + cls + '" style="' + style + '" title="' + esc(el.id) + '"' + layAttrs(button) + extraData;
    if (!isDeco && el.action) attrs += ' data-action="' + esc(el.action) + '"';
    if (!isDeco && el.disabled) attrs += ' disabled';
    // D-194：拖拽平移（滚动容器才用得上）—— 交互在 app.js（按下移动 ≥4px 才进入平移）
    if (el.pan) attrs += ' data-pan="' + esc(String(el.pan)) + '"';
    // D-195：行列表容器带上行高/缩进，手势层据此把指针换算成"第几行、第几层"
    if (el.rowPitch) attrs += ' data-row-pitch="' + Number(el.rowPitch) + '"';
    if (el.rowIndent) attrs += ' data-row-indent="' + Number(el.rowIndent) + '"';
    // D-196：**落点容器**标记（程序树）。手势层据此区分"拖进树"与"拖到节点库"。
    if (el.dropBox) attrs += ' data-drop-box="1"';
    // D-195：容器的画布尺寸 —— 手势层用它把屏幕像素换算回画布单位（否则落点算错一个缩放比）
    if (el.canvasW) attrs += ' data-cw="' + Number(el.canvasW) + '"';
    if (el.canvasH) attrs += ' data-ch="' + Number(el.canvasH) + '"';
    // D-195：节点库的行可**拖**（拖动放置）；值 = 节点 id
    if (el.dragNode) attrs += ' data-drag-node="' + esc(String(el.dragNode)) + '"';
    // 树内节点也能拖（拖动=移动）：值是节点地址
    if (el.dragAddr) attrs += ' data-drag-addr="' + esc(String(el.dragAddr)) + '"';
    // D-194：**文本输入**。它既不是 button 也不是 div：
    //   用 <input>/<textarea> 才有原生光标、选中、输入法；提交走 change → `field.set`。
    if (el.kind === 'input' || el.kind === 'textarea') {
      var fieldAttrs = ' class="' + cls + '" style="' + style + '" title="' + esc(el.id) + '"'
        + ' data-field="' + esc(el.name) + '" name="' + esc(el.name) + '"'
        + ' placeholder="' + esc(el.placeholder || '') + '" spellcheck="false" autocomplete="off"';
      if (el.disabled) fieldAttrs += ' disabled';
      if (el.kind === 'textarea') {
        return '<textarea' + fieldAttrs + '>' + esc(el.inputValue === undefined ? '' : el.inputValue) + '</textarea>';
      }
      return '<input type="text"' + fieldAttrs + ' value="' + esc(el.inputValue === undefined ? '' : el.inputValue) + '">';
    }
    var inner = '';
    if (el.asset) {
      // 九宫格拉伸（D-185）：border-image 按 9 片拉伸，圆角/边框不糊
      if (el.nine && el.nine.slice > 0) {
        inner += '<img src="' + esc(el.asset) + '" alt=""'
          + ' style="border-image:url(' + esc(el.asset) + ') ' + Number(el.nine.slice) + ' fill stretch">';
      } else {
        inner += '<img src="' + esc(el.asset) + '" alt="">';
      }
    }
    // D-188：**按下态素材** —— 与常态图并存，由 CSS 按 `.dl-pressed` / `:hover` / `:active`
    //   切换显隐（两态都有图时"按下"才看得见变化）。只有常态图时不输出第二张（降级为无变化）。
    if (el.assetPressed) {
      inner += '<img class="dl-img-pressed" src="' + esc(el.assetPressed) + '" alt="">';
    }
    if (el.text) inner += '<span class="dl-txt">' + esc(el.text) + '</span>';
    // D-195：子元素（按 parent 嵌套）与滚动撑条
    if (childrenHtml && el.zoom && el.zoom !== 1) {
      // **整块缩放**：一个 wrapper 里装全部子元素，统一 transform: scale(z)。
      //   子元素仍按"容器盒子"取百分比（和缩放前完全一样的布局），只是整块被放大 ⇒ 像图片一样。
      //   另放一根撑条（sibling）负责撑出滚动范围，否则放大后滚不到底。
      var zf = Number(el.zoom);
      var contentPct = el.contentH && el.rect[3] ? (Number(el.contentH) / Number(el.rect[3]) * 100) : 100;
      var spH = (contentPct * zf).toFixed(3);
      var spW = (100 * zf).toFixed(3);
      inner += '<div class="dl-zsp" style="position:absolute;left:0;top:0;width:' + spW + '%;height:' + spH
        + '%;pointer-events:none"></div>'
        + '<div class="dl-zoom" style="position:absolute;inset:0;transform:scale(' + zf + ');transform-origin:0 0">'
        + childrenHtml + '</div>';
    } else {
      inner += childrenHtml || '';
    }
    // 滚动容器：**必须有可滚动的内容高度**，否则滚不动。
    //   布局里的子元素是绝对定位的，不会撑开父容器 ⇒ 容器始终只有自己那么高。
    //   这里按 format 算出的 `contentH`（画布单位）换算成百分比，塞一根撑条。
    if (el.scroll && el.contentH && el.contentH > (el.rect[3] || 0)) {
      var pctH = canvas && canvas.h ? (Number(el.contentH) / canvas.h * 100).toFixed(4) + '%' : (Number(el.contentH) + 'px');
      inner += '<div class="dl-spacer" style="position:absolute;left:0;top:0;width:1px;pointer-events:none;'
        + 'height:' + pctH + '"></div>';
    }
    return '<' + (isDeco ? 'div' : 'button type="button"') + attrs + '>' + inner + '</' + (isDeco ? 'div' : 'button') + '>';
  }

  function layoutHtml(layout) {
    var canvas = layout.canvas, parts = [];
    parts.push('<div class="dl-screen" style="aspect-ratio:' + canvas.w + '/' + canvas.h + '">');
    (layout.layers || []).forEach(function (layer, idx) {
      if (layer.role === 'modal') {
        var m = layer.mask || {};
        parts.push('<div class="dl-modal" data-depth="' + String(idx + 1) + '">');
        parts.push('<div class="dl-mask" data-action="modal-close" style="background:' + esc(m.color || '#000000')
          + ';opacity:' + String(m.opacity === undefined ? 0.5 : m.opacity) + '"></div>');
        parts.push('<div class="dl-layer">');
      }
      // D-195：**按 parent 真嵌套**。以前所有元素都平铺在 `.dl-screen` 里，
      //   于是"滚动容器里的行"其实不是容器的子元素 —— 容器 scrollHeight 永远等于自身高度：
      //   节点库滚不动、树也滚不动、拖动空白平移看不到内容移动。仓库网格是同一个病。
      var byId = {};
      layer.elements.forEach(function (el) { byId[el.id] = el; });
      var kids = {};
      layer.elements.forEach(function (el) {
        var p = el.parent && byId[el.parent] ? el.parent : '';
        (kids[p] = kids[p] || []).push(el);
      });
      var emit = function (el) {
        var ch = (kids[el.id] || []).map(emit).join('');
        return layoutElHtml(el, canvas, ch, byId[el.parent] ? byId[el.parent].rect : null);
      };
      (kids[''] || []).forEach(function (el) { parts.push(emit(el)); });
      if (layer.role === 'modal') parts.push('</div></div>');
    });
    parts.push('</div>');
    return parts.join('');
  }

  function render(vm) {
    if (vm && vm.layout && Array.isArray(vm.layout.layers)) {
      // D-192：**布局屏就是整个界面，不再额外输出 `<h2>` 标题**。
      //   用户口径：「预览和实际前端效果都应该直接只有这个屏」—— 屏上方不该有「Debug-Lite」字样。
      //   （标题仍保留在 `vm.title` 里，供 `<title>` 与文档使用；只是不画到屏上。）
      //
      // 顺序也是承重的：状态提示与兜底入口要排在 `.dl-screen` **之后**，
      //   这样 CSS 能用 `.dl-screen ~ …` 把它们叠成覆盖层（不占版面，屏才铺得满）。
      var lay = [layoutHtml(vm.layout)];
      var layNotice = noticeHtml(vm);
      if (layNotice !== '') lay.push(layNotice);
      if (vm.buttons && vm.buttons.length > 0) lay.push('<div class="buttons">' + buttonsHtml(vm.buttons) + '</div>');
      lay.push(modalHtml(vm));
      // D-194：**丢弃确认**也要在布局模式下渲染 —— 否则"有未保存改动时点返回列表"什么都不出现
      //   （D-179 在文字版踩过同一个坑）。`.dl-screen ~ #confirm` 由 CSS 叠在屏上。
      lay.push(confirmHtml(vm));
      return lay.filter(function (x) { return x !== ''; }).join('\n');
    }
    var parts = [];
    parts.push('<h2>' + esc(vm.title) + '</h2>');
    var notice = noticeHtml(vm);
    if (notice !== '') parts.push(notice);
    var result = resultHtml(vm);
    if (result !== '') parts.push(result);
    if (vm.hint) parts.push('<p class="hint">' + esc(vm.hint) + '</p>');

    // 有序区块模式：标题与内容就地成对出现（F5 的 AI 编辑器用它把程序树贴回标题下面）
    if (Array.isArray(vm.blocks) && vm.blocks.length > 0) {
      parts.push(blocksHtml(vm));
      parts.push(confirmHtml(vm));
      parts.push(modalHtml(vm));
      if (vm.buttons && vm.buttons.length > 0) parts.push('<div class="buttons">' + buttonsHtml(vm.buttons) + '</div>');
      return parts.filter(function (part) { return part !== ''; }).join('\n');
    }

    var fields = fieldsHtml(vm) + textareaHtml(vm);
    // 只有显式给了 enterAction 才包 <form>（回车提交那套）；否则是"纯输入区"——
    //   F5 的 AI 编辑器属于后者：字段随打随存（input/change 事件），不需要表单提交语义。
    var enterAction = typeof vm.enterAction === 'string' && vm.enterAction !== '' ? vm.enterAction : null;
    parts.push(linesHtml(vm));
    parts.push(rowsHtml(vm));
    parts.push(confirmHtml(vm));
    parts.push(modalHtml(vm));
    if (enterAction !== null) {
      parts.push('<form data-enter="' + esc(enterAction) + '" autocomplete="off">' + fields + '<div class="buttons">' + buttonsHtml(vm.buttons) + '</div></form>');
    } else {
      if (fields !== '') parts.push('<div id="inputs">' + fields + '</div>');
      parts.push('<div class="buttons">' + buttonsHtml(vm.buttons) + '</div>');
    }
    return parts.filter(function (part) { return part !== ''; }).join('\n');
  }

  return { esc: esc, render: render };
});
