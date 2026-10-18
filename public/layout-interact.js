'use strict';
/* public/layout-interact.js —— 布局表的**手势层**（滚轮缩放 / 拖动空白平移 / 拖动节点放置 / 点空白收起）
 *
 * 为什么单独一个文件：这些手势以前只写在 `app.js` 里，而**布局台的预览**走的是自己的点击接线，
 * 于是"预览里滚不动、拖不动、点不动"——同一个界面两套行为。现在两边共用这一个模块。
 *
 * 用法：
 *   DL.layoutInteract.attach(rootEl, { DL, getState, dispatch, run })
 *   · rootEl  渲染出来的容器（产品是 #view，预览是 #pvstage）
 *   · run(name, payload) 执行动作（产品走 actions 注册表；预览走它自己的 pvRun）
 *
 * 手势约定（用户 2026-10-18 口径）：
 *   · 滚轮 = 缩放（不按 Ctrl；只对带 data-pan 的容器生效）
 *   · 空白处左键拖动 = 平移视图；**移动 < 4px 视为点击**（= 点空白，收起详情）
 *   · 按住带 data-drag-node 的行拖动 = 拖节点进程序树；移动时算最近可插入位并显示预览线
 *   · 点带 data-action 的元素 = 执行动作（拖过之后的那次 click 被吞掉，避免"拖完还触发点击"）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.layoutInteract = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MOVE_PX = 4;          // 位移超过这个才算"拖"，否则算"点"
  var ZOOM_STEP = 0.1;
  var ZOOM_MIN = 0.4;
  var ZOOM_MAX = 2;

  function payloadOf(node) {
    var out = null;
    var attrs = node.attributes || [];
    for (var i = 0; i < attrs.length; i += 1) {
      var a = attrs[i];
      if (a.name.indexOf('data-') !== 0 || a.name === 'data-action') continue;
      out = out || {};
      var k = a.name.slice(5).replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
      out[k] = a.value;
    }
    return out;
  }

  function attach(el, opts) {
    if (!el || el.__dlInteract) return el && el.__dlInteract;
    var o = opts || {};
    var DL = o.DL || (typeof window !== 'undefined' ? window.DL : null);
    var getState = o.getState || function () { return {}; };
    var dispatch = o.dispatch || function () {};
    var run = o.run || function () {};
    var drag = null;        // 拖动节点
    var pan = null;         // 平移
    var swallowClick = false;

    /** 吞掉"拖完之后浏览器补发的那一次 click"。
     *  宿主自己的点击接线（app.js 的 onClick）不经过本模块，所以要**在 document 捕获阶段**拦一次，
     *  否则拖完还会触发被拖那一行的 `ai-node-append`（真实事故：拖一个节点进树，结果又往末尾追加了一个）。 */
    function swallowNextClick() {
      if (typeof document === 'undefined') return;
      var kill = function (ev) { ev.stopPropagation(); ev.preventDefault(); document.removeEventListener('click', kill, true); };
      document.addEventListener('click', kill, true);
      setTimeout(function () { document.removeEventListener('click', kill, true); }, 400);
    }

    function closest(node, sel) {
      var walk = node;
      for (var g = 0; walk && g < 40; g += 1) {
        if (walk.matches && walk.matches(sel)) return walk;
        walk = walk.parentNode;
      }
      return null;
    }
    function panBoxOf(node) { return closest(node, '[data-pan]'); }
    /** 屏幕坐标 → 容器的**画布单位**坐标（容器在屏幕上被等比缩放，落点几何用的是画布单位） */
    function posIn(box, ev) {
      var r = box.getBoundingClientRect();
      var cw = Number(box.getAttribute('data-cw')) || 0;
      var scale = cw > 0 && r.width > 0 ? r.width / cw : 1;
      return {
        x: (ev.clientX - r.left + box.scrollLeft) / scale,
        y: (ev.clientY - r.top + box.scrollTop) / scale,
      };
    }

    // ---------- 点击（动作） ----------
    //   宿主如果自己已经有点击接线（产品 app.js 的 onClick / 预览的 pvWireOnce），
    //   传 `click:false` 就不会重复绑定，避免一个点击执行两遍动作。
    if (o.click !== false) {
      el.addEventListener('click', function (ev) {
        if (swallowClick) { swallowClick = false; ev.stopPropagation(); ev.preventDefault(); return; }
        var t = ev.target;
        var node = closest(t, '[data-action]');
        if (!node) return;
        ev.preventDefault();
        ev.stopPropagation();
        run(node.getAttribute('data-action'), payloadOf(node));
      });
    }

    // ---------- 滚轮 = 缩放 ----------
    el.addEventListener('wheel', function (ev) {
      var box = panBoxOf(ev.target);
      if (!box) return;                       // 不是可平移容器 → 让页面正常滚
      ev.preventDefault();
      var st = getState();
      var cur = (st.aiEditor && Number(st.aiEditor.zoom)) || 1;
      var step = (ev.deltaY || 0) > 0 ? -ZOOM_STEP : ZOOM_STEP;
      var next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((cur + step) * 100) / 100));
      if (next === cur) return;
      dispatch({ type: 'ai.zoom.set', zoom: next });
    }, { passive: false });

    // ---------- 按下：可能是拖动节点，也可能是平移 ----------
    el.addEventListener('mousedown', function (ev) {
      if (ev.button !== undefined && ev.button !== 0) return;
      var t = ev.target;
      var dragRow = closest(t, '[data-drag-node]');
      var box = panBoxOf(t);
      if (dragRow) {
        if (dragRow.disabled) return;         // 库存为 0 的行不能拖
        drag = { node: dragRow.getAttribute('data-drag-node'), x: ev.clientX, y: ev.clientY, moved: false, box: box };
        return;
      }
      if (!box) { el.__dlLast = 'no-pan-box'; return; }
      if (closest(t, '[data-action]')) { el.__dlLast = 'on-action'; return; } // 点在行/按钮上 → 交给点击
      pan = { box: box, x: ev.clientX, y: ev.clientY, top: box.scrollTop, left: box.scrollLeft, moved: false };
      el.__dlLast = 'pan-start';
    });

    el.addEventListener('mousemove', function (ev) {
      // 拖节点：算落点并显示预览线
      if (drag) {
        var dx0 = ev.clientX - drag.x, dy0 = ev.clientY - drag.y;
        if (!drag.moved && Math.abs(dx0) < MOVE_PX && Math.abs(dy0) < MOVE_PX) return;
        drag.moved = true;
        var st = getState();
        var ed = st.aiEditor;
        var bp = ed && ed.draft;
        // **落点容器 = 指针当前所在的那个**（不能用 querySelector 取第一个：
        //   节点库和程序树都带 data-row-pitch，取第一个会把落点算到节点库上）
        var treeBox = closest(ev.target, '[data-row-pitch]') || drag.box;
        var bpMod = DL && DL.aiBlueprint;
        if (!bp || !bpMod || !treeBox) return;
        var pitch = Number(treeBox.getAttribute('data-row-pitch')) || 24;
        var indent = Number(treeBox.getAttribute('data-row-indent')) || 16;
        var p = posIn(treeBox, ev);
        var kind = (bpMod.specOf && bpMod.specOf(drag.node) && bpMod.specOf(drag.node).kind) || 'stmt';
        var hit = bpMod.nearestDrop(bp, p, { kind: kind, pitch: pitch, indentPx: indent });
        el.__dlDrag = { p: p, pitch: pitch, indent: indent, kind: kind, hit: hit };   // 调试用（真实浏览器验收时读它）
        dispatch({ type: 'ai.drop.set', y: hit ? hit.anchorY : null, target: hit });
        ev.preventDefault();
        return;
      }
      // 平移
      if (!pan) return;
      var dx = ev.clientX - pan.x, dy = ev.clientY - pan.y;
      if (!pan.moved && Math.abs(dx) < MOVE_PX && Math.abs(dy) < MOVE_PX) return;
      pan.moved = true;
      var mode = pan.box.getAttribute('data-pan');
      if (mode === 'both' || mode === 'h') pan.box.scrollLeft = pan.left - dx;
      if (mode === 'both' || mode === 'v') pan.box.scrollTop = pan.top - dy;
      ev.preventDefault();
    });

    el.addEventListener('mouseup', function () {
      if (drag) {
        var d = drag;
        drag = null;
        var st = getState();
        var hit = st.aiEditor && st.aiEditor.dropTarget;
        dispatch({ type: 'ai.drop.set', y: null, target: null });
        if (!d.moved) return;                       // 只是点了一下 → 交给 click（追加到末尾）
        swallowClick = true; swallowNextClick();   // 拖过之后吞掉浏览器补发的 click
        if (!hit) return;                           // 没落点 = 取消放置
        run('ai-node-drop', { node: d.node, parentAddr: hit.parentAddr, index: hit.index, where: hit.where });
        return;
      }
      if (pan) {
        var wasMoved = pan.moved;
        pan = null;
        if (wasMoved) { swallowClick = true; swallowNextClick(); el.__dlLast = 'pan-moved'; return; }
        // 没移动 = 点空白 → 收起详情（用户口径："点击空白位置可收起右侧详情"）
        swallowClick = true; swallowNextClick();
        el.__dlLast = 'pan-click-close';
        run('ai-detail-close', null);
      }
    });

    var api = { detach: function () { el.__dlInteract = null; } };
    el.__dlInteract = api;
    return api;
  }

  return { attach: attach };
});
