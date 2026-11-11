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
    var lastKey = null;     // 上一次落点候选的 key（只在变化时重绘）

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
    /** 屏幕坐标 → **整屏画布坐标**（幽灵节点挂在屏级，坐标相对 `.dl-screen`） */
    function stagePos(ev) {
      var screen = el.querySelector ? el.querySelector('.dl-screen') : null;
      if (!screen) return null;
      var r = screen.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      var canvas = (DL && DL.layoutData && DL.layoutData.canvas) || { w: 1280, h: 720 };
      return {
        x: (ev.clientX - r.left) / r.width * canvas.w,
        y: (ev.clientY - r.top) / r.height * canvas.h,
      };
    }
    /** 幽灵节点**直接跟手**：只改 style，不重绘（重绘会丢帧、也会打断拖动）
     *  —— state 里同时记最新坐标（`ai.drag.set` 不重绘），下次因落点变化重绘时位置不会跳回去。 */
    function moveGhost(p) {
      if (!p) return;
      var g = el.querySelector ? el.querySelector('[title="ai_ghost"]') : null;
      if (!g) return;
      var canvas = (DL && DL.layoutData && DL.layoutData.canvas) || { w: 1280, h: 720 };
      g.style.left = (p.x / canvas.w * 100).toFixed(4) + '%';
      g.style.top = (p.y / canvas.h * 100).toFixed(4) + '%';
    }
    function pitchOf(box) { return Number(box.getAttribute('data-row-pitch')) || 26; }
    function indentOf(box) { return Number(box.getAttribute('data-row-indent')) || 18; }

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

    // ---------- 滚轮 = 缩放（**只对程序树**；节点库列表用原生滚动） ----------
    el.addEventListener('wheel', function (ev) {
      var box = panBoxOf(ev.target);
      if (!box) return;                       // 不是可平移容器 → 让页面正常滚
      // 用户 2026-10-18：「光标在左侧列表滚动滚轮时不应缩放中间的视图，应滚动左边的列表」
      //   节点库容器有 scroll 但没有 data-drop-box ⇒ 直接放行，交给浏览器原生滚动。
      if (!box.hasAttribute('data-drop-box')) return;
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
      var dragAddrEl = closest(t, '[data-drag-addr]');
      var dragRow = closest(t, '[data-drag-node]');
      var box = panBoxOf(t);
      if (dragAddrEl || (dragRow && !dragRow.disabled)) {
        var st0 = getState();
        var ed0 = st0.aiEditor;
        var bp0 = ed0 && ed0.draft;
        var addr = dragAddrEl ? (dragAddrEl.getAttribute('data-drag-addr') || '') : '';
        var nodeId = dragRow ? (dragRow.getAttribute('data-drag-node') || '') : '';
        var bpMod0 = DL && DL.aiBlueprint;
        if (addr !== '' && bpMod0 && bp0) {
          var nd = bpMod0.nodeAt(bp0, addr);
          nodeId = nd ? nd.node : '';
        }
        if (addr === '' && nodeId === '') return;
        var spec = bpMod0 && bpMod0.specOf ? bpMod0.specOf(nodeId) : null;
        drag = {
          addr: addr,
          node: nodeId,
          kind: (spec && spec.kind) || 'stmt',
          text: String((dragAddrEl || dragRow).textContent || '').replace(/\s+/g, ' ').trim(),
          x: ev.clientX, y: ev.clientY, active: false,
        };
        el.__dlLast = 'drag-armed';
        return;
      }
      if (!box) { el.__dlLast = 'no-pan-box'; return; }
      if (closest(t, '[data-action]')) { el.__dlLast = 'on-action'; return; } // 点在行/按钮上 → 交给点击
      pan = { box: box, x: ev.clientX, y: ev.clientY, top: box.scrollTop, left: box.scrollLeft, moved: false };
      el.__dlLast = 'pan-start';
    });

    el.addEventListener('mousemove', function (ev) {
      // 拖节点：幽灵跟手 + 算落点 + 显示预览线
      if (drag) {
        var dx0 = ev.clientX - drag.x, dy0 = ev.clientY - drag.y;
        if (!drag.active && Math.abs(dx0) < MOVE_PX && Math.abs(dy0) < MOVE_PX) return;
        var st = getState();
        var ed = st.aiEditor;
        var bp = ed && ed.draft;
        var bpMod = DL && DL.aiBlueprint;
        if (!bp || !bpMod) return;
        // **每次重新取容器**：落点变化会重绘，旧引用已脱离文档
        var treeBox = el.querySelector ? el.querySelector('[data-drop-box]') : null;
        var sp = stagePos(ev);
        if (!drag.active) {
          drag.active = true;
          lastKey = null;
          // 第一次进入拖动：**重绘一次**让幽灵节点出现（之后只改 style，不重绘）
          dispatch({ type: 'ai.drag.set', x: sp ? sp.x : 0, y: sp ? sp.y : 0, text: drag.text, active: true, redraw: true });
        } else {
          // 只更新 state（不重绘）—— app.js 的 dispatch 对 ai.drag.set 有"不重绘"约定
          dispatch({ type: 'ai.drag.set', x: sp ? sp.x : 0, y: sp ? sp.y : 0, text: drag.text, active: true });
        }
        moveGhost(sp);
        if (!treeBox) { ev.preventDefault(); return; }
        var p = posIn(treeBox, ev);
        var boxW = Number(treeBox.getAttribute('data-cw')) || 616;
        // 横向离开树干 = 树旁边的空白 → 没有合法位置（松手即退回仓库）
        var inside = p.x >= -2 && p.x <= boxW + 2 && p.y >= -pitchOf(treeBox) && p.y <= 1e6;
        var hit = inside ? bpMod.nearestDrop(bp, p, {
          kind: drag.kind,
          pitch: pitchOf(treeBox),
          indentPx: indentOf(treeBox),
          exclude: drag.addr || '',
        }) : null;
        var key = hit ? (hit.parentAddr + '|' + hit.index + '|' + hit.mode) : '';
        // 真实浏览器验收用的探针：拖动几何全在这里（只读，不影响行为）
        el.__dlDrag = {
          p: { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 },
          boxW: boxW, inside: inside, kind: drag.kind,
          pitch: pitchOf(treeBox), indent: indentOf(treeBox),
          hit: hit ? { parentAddr: hit.parentAddr, index: hit.index, mode: hit.mode, depth: hit.depth, y: hit.y } : null,
        };
        if (key !== lastKey) {
          lastKey = key;
          var ind = indentOf(treeBox);
          var dropX = hit ? Math.round((hit.depth || 0) * ind + 4) : null;
          dispatch({
            type: 'ai.drop.set',
            y: hit ? hit.y : null,
            x: dropX,
            w: hit ? Math.max(24, boxW - dropX - 8) : null,
            target: hit,
          });
        }
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
        if (!d.active) return;                      // 只是点了一下 → 交给 click（追加到末尾）
        swallowClick = true; swallowNextClick();    // 拖过之后吞掉浏览器补发的 click
        var st2 = getState();
        var hit2 = st2.aiEditor && st2.aiEditor.dropTarget;
        // 真实浏览器验收探针：这一笔最终走了哪条路
        el.__dlLast = (hit2 ? 'hit' : 'miss') + '|' + (d.addr ? ('addr:' + d.addr) : ('node:' + d.node))
          + (hit2 ? ('|t:' + String(hit2.parentAddr || '') + '#' + hit2.index + ':' + (hit2.mode || '-') + ':' + (hit2.y | 0)) : '');
        // 先把幽灵/预览线收掉（一次重绘），再执行落地动作（另一次重绘）
        dispatch({ type: 'ai.drag.set', x: null, y: null, active: false });
        dispatch({ type: 'ai.drop.set', y: null, x: null, w: null, target: null });
        if (d.addr) {
          // 树内节点：没落点 = **退回仓库**（从树里摘掉，库存 free 实时 +1）
          if (!hit2) { run('ai-node-eject', { addr: d.addr }); return; }
          run('ai-node-move', {
            from: d.addr, parentAddr: hit2.parentAddr, index: hit2.index,
            mode: hit2.mode || 'insert', where: hit2.where || '',
          });
          return;
        }
        if (!hit2) { run('ai-drop-cancel', null); return; }   // 节点库拖出：放回仓库（未消耗）
        run('ai-node-drop', {
          node: d.node, parentAddr: hit2.parentAddr, index: hit2.index,
          mode: hit2.mode || 'insert', where: hit2.where || '',
        });
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
