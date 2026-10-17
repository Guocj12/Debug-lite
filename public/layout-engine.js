'use strict';
/* public/layout-engine.js —— **由 tools/layout/make-engine.js 生成，请勿手改**
 * 真源：tools/layout/lab.html 的 <script id="core">（core digest: 761b6693c57b95af）
 * 职责：布局表的纯逻辑 —— 归一化 / 断点解算 / 锚点 / 占位符替换 / 多边形解析 / 校验。
 *   不碰 DOM、不发请求、不读响应字段（投影仍归 format.js）。
 * 形态：零依赖双模模块（浏览器挂 window.DL.layoutEngine，Node 可 require）。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  root.DL = root.DL || {};
  root.DL.layoutEngine = mod;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  var CORE = (function () {
  'use strict';
  var ANCHOR_X = { l: 0, c: 0.5, r: 1 };
  var ANCHOR_Y = { t: 0, c: 0.5, b: 1 };
  var HIT_MODES = ['rect', 'ellipse', 'path', 'alpha'];
  // 滚动容器方向（D-185）：none = 只裁剪不滚
  var SCROLL_DIRS = ['v', 'h', 'both', 'none'];
  var TEXT_ALIGNS = ['left', 'center', 'right'];
  var FIT_MODES = ['contain', 'cover', 'stretch'];
  var BP_KEYS = ['landscape', 'portrait', 'tablet'];
  var BP_LABEL = { landscape: '横屏', portrait: '竖屏', tablet: '平板' };
  var DEFAULT_BP = {
    landscape: { w: 1280, h: 720, adapt: 'fit', fit: 'contain' },
    portrait: { w: 390, h: 844, adapt: 'fit', fit: 'contain' },
    tablet: { w: 1024, h: 768, adapt: 'fit', fit: 'contain' }
  };


  /* ---------------- 默认画面集合 ----------------
   * hub（整屏）+ 三个弹窗：
   *   modal_role_slots   点角色展开 → 插槽按**正六边形六个方向**径向展开（数量 = 模板 slotCount）
   *   modal_role_pick    在弹窗里**再点角色** → 旁边显示可替换的角色模板
   *   modal_role_plugin_pick / modal_skill_plugin_pick  点插槽 → 旁边显示该位置可装/可换的插件（角色插件 / 技能插件分开）
   *   modal_skill_pick   技能弹窗里再点技能 → 旁边显示可替换的技能
   * 交互闭环：点弹窗外任意处（遮罩）= 关闭。技能按钮同理（modal_skill_slots）。
   */
  var ROLE_SLOT_RECT = [556, 226, 168, 168];                 // 弹窗里角色卡的位置
  var ROLE_SLOT_C = [ROLE_SLOT_RECT[0] + ROLE_SLOT_RECT[2] / 2, ROLE_SLOT_RECT[1] + ROLE_SLOT_RECT[3] / 2];
  var SKILL_SLOT_RECT = [576, 316, 128, 128];                // 弹窗里技能卡的位置
  var SKILL_SLOT_C = [SKILL_SLOT_RECT[0] + SKILL_SLOT_RECT[2] / 2, SKILL_SLOT_RECT[1] + SKILL_SLOT_RECT[3] / 2];
  var SLOT_W = 64, SLOT_H = 64, SLOT_COUNT = 6;              // 默认 6 个方向（真代码按 slotCount 渲染）

  function slotElements(prefix, center, radius, action, payloadBase, targetScreen) {
    return radialRects(center[0], center[1], radius, SLOT_COUNT, SLOT_W, SLOT_H, -90)
      .map(function (r, i) {
        var payload = {};
        Object.keys(payloadBase || {}).forEach(function (k) { payload[k] = payloadBase[k]; });
        payload.idx = i;
        return { id: prefix + (i + 1), kind: 'button', label: '插槽' + (i + 1), action: action,
                 target: targetScreen || 'modal_slot_plugins', payload: payload, hit: 'rect', anchor: 'ct',
                 rect: r, z: 3 };
      });
  }

  var DEFAULT_BUNDLE = {
    version: 1,
    canvas: { w: 1280, h: 720 },
    breakpoints: {
      landscape: { w: 1280, h: 720, adapt: 'fit', fit: 'contain' },
      portrait: { w: 390, h: 844, adapt: 'fit', fit: 'contain' },
      tablet: { w: 1024, h: 768, adapt: 'fit', fit: 'contain' }
    },
    screens: {
      hub: {
        role: 'screen',
        background: { asset: 'assets/bg/hub_main.webp', fit: 'cover' },
        elements: [
          { id: 'identity', kind: 'button', label: '{nickname}', action: 'goto-profile', hit: 'rect', anchor: 'lt', rect: [36, 30, 320, 92] },
          { id: 'tier_chip', kind: 'deco', label: '{tierName} · {points} 分', asset: '{tierIcon}', hit: 'rect', anchor: 'lt', rect: [120, 76, 216, 26], z: 2 },
          { id: 'btn_warehouse', kind: 'button', label: '仓库', action: 'goto-warehouse', hit: 'alpha', anchor: 'lt', rect: [36, 250, 180, 58] },
          { id: 'btn_ai', kind: 'button', label: 'AI 编辑', action: 'goto-ai-editor', hit: 'alpha', anchor: 'lt', rect: [36, 322, 180, 58] },
          { id: 'btn_settings', kind: 'button', label: '设置', action: 'goto-settings', hit: 'alpha', anchor: 'lb', rect: [36, 394, 180, 58] },
          { id: 'btn_board', kind: 'button', label: '排行', action: 'goto-leaderboard', hit: 'alpha', anchor: 'rt', rect: [1064, 250, 180, 58] },
          { id: 'btn_tournament', kind: 'button', label: '锦标赛', action: 'goto-tournament', hit: 'alpha', anchor: 'rt', rect: [1064, 322, 180, 58] },
          { id: 'btn_quick', kind: 'button', label: '快速对战', action: 'goto-quick', hit: 'alpha', anchor: 'rb', rect: [1064, 394, 180, 58], z: 2 },
          // 角色卡：素材与文字都**绑定当前配置** → 切配置时内容跟着换（不是一张固定素材图）
          { id: 'crest_role', kind: 'button', label: '角色卡', asset: '{roleIcon}',
            action: 'config-open', target: 'modal_role_slots',
            payload: { slot: 'slot1' }, hit: 'path', path: 'M50,0 L100,30 L100,100 L0,100 L0,30 Z', anchor: 'ct', rect: [482, 62, 316, 306] },
          { id: 'role_name', kind: 'deco', label: '{roleName}（{roleQuality}）', hit: 'rect', anchor: 'ct', rect: [542, 330, 196, 24], z: 2 },
          // 三个技能：素材/文字同样绑定当前配置
          { id: 'skill_1', kind: 'button', label: '{skill1Name}', asset: '{skill1Icon}', action: 'config-open', target: 'modal_skill_slots', payload: { slot: 'slot1', pos: 'skill1' }, hit: 'alpha', anchor: 'ct', rect: [452, 362, 124, 58], rot: -7 },
          { id: 'skill_2', kind: 'button', label: '{skill2Name}', asset: '{skill2Icon}', action: 'config-open', target: 'modal_skill_slots', payload: { slot: 'slot1', pos: 'skill2' }, hit: 'alpha', anchor: 'ct', rect: [578, 352, 124, 58] },
          { id: 'skill_3', kind: 'button', label: '{skill3Name}', asset: '{skill3Icon}', action: 'config-open', target: 'modal_skill_slots', payload: { slot: 'slot1', pos: 'skill3' }, hit: 'alpha', anchor: 'ct', rect: [704, 362, 124, 58], rot: 7 },
          // 出战配置 1/2/3：**只切换主界面显示的配置**（setState = 本地状态，不导航、不进编辑界面）
          { id: 'slot_1', kind: 'button', label: '1', setState: { activeSlot: 1 }, hit: 'rect', anchor: 'ct', rect: [530, 474, 52, 52] },
          { id: 'slot_2', kind: 'button', label: '2', setState: { activeSlot: 2 }, hit: 'rect', anchor: 'ct', rect: [590, 474, 52, 52] },
          { id: 'slot_3', kind: 'button', label: '3', setState: { activeSlot: 3 }, hit: 'rect', anchor: 'ct', rect: [650, 474, 52, 52] },
          { id: 'badge_1', kind: 'deco', label: '出战', when: { activeSlot: 1 }, hit: 'rect', anchor: 'ct', rect: [530, 456, 52, 18], z: 4 },
          { id: 'badge_2', kind: 'deco', label: '出战', when: { activeSlot: 2 }, hit: 'rect', anchor: 'ct', rect: [590, 456, 52, 18], z: 4 },
          { id: 'badge_3', kind: 'deco', label: '出战', when: { activeSlot: 3 }, hit: 'rect', anchor: 'ct', rect: [650, 456, 52, 18], z: 4 },
          { id: 'label_loadout', kind: 'deco', label: '出战配置 · {slotName}', hit: 'rect', anchor: 'ct', rect: [540, 552, 200, 30] },
          { id: 'btn_unread', kind: 'deco', label: '{unread}', hit: 'rect', anchor: 'rt', rect: [1150, 34, 130, 40] },
          { id: 'btn_refresh', kind: 'button', label: '刷新', action: 'refresh-hub', hit: 'rect', anchor: 'rt', rect: [1080, 34, 96, 40] }
        ]
      },
      modal_role_slots: {
        role: 'modal',
        mask: { color: '#000000', opacity: 0.6, closeOnMaskClick: true },
        background: { asset: '', fit: 'cover' },
        elements: [
          { id: 'center_role', kind: 'button', label: '角色（再点一次看角色模板）', action: 'config-open', target: 'modal_role_pick',
            hit: 'path', path: 'M50,0 L100,30 L100,100 L0,100 L0,30 Z', anchor: 'ct', rect: ROLE_SLOT_RECT, z: 2 }
        ].concat(slotElements('rslot_', ROLE_SLOT_C, 250, 'plugin-pick', { slot: 'slot1', pos: 'role' }, 'modal_role_plugin_pick'))
      },
      modal_skill_slots: {
        role: 'modal',
        mask: { color: '#000000', opacity: 0.6, closeOnMaskClick: true },
        background: { asset: '', fit: 'cover' },
        elements: [
          // 技能弹窗与角色弹窗**功能不同**：中心点是"换技能"，插槽是"换技能插件"
          { id: 'center_skill', kind: 'button', label: '技能（再点一次看技能）', action: 'config-open', target: 'modal_skill_pick',
            hit: 'rect', anchor: 'ct', rect: SKILL_SLOT_RECT, z: 2 }
        ].concat(slotElements('sslot_', SKILL_SLOT_C, 210, 'plugin-pick', { slot: 'slot1', pos: 'skill2' }, 'modal_skill_plugin_pick'))
      },
      modal_role_pick: {
        role: 'modal',
        mask: { color: '#000000', opacity: 0.35, closeOnMaskClick: true },
        background: { asset: '', fit: 'cover' },
        elements: [
          { id: 'pick_panel', kind: 'deco', label: '候选角色模板', hit: 'rect', anchor: 'rc', rect: [860, 150, 380, 420], z: 5 },
          { id: 'pick_title', kind: 'deco', label: '可替换的角色模板', hit: 'rect', anchor: 'rc', rect: [880, 168, 340, 28], z: 6 },
          { id: 'pick_row1', kind: 'button', label: '{roleName}（当前）', action: 'slot-set', payload: { slot: 'slot1', pos: 'role' }, hit: 'rect', anchor: 'rc', rect: [880, 208, 340, 56], z: 6 },
          { id: 'pick_row2', kind: 'button', label: '重装（蓝）', action: 'slot-set', payload: { slot: 'slot1', pos: 'role' }, hit: 'rect', anchor: 'rc', rect: [880, 272, 340, 56], z: 6 },
          { id: 'pick_row3', kind: 'button', label: '突击（紫）', action: 'slot-set', payload: { slot: 'slot1', pos: 'role' }, hit: 'rect', anchor: 'rc', rect: [880, 336, 340, 56], z: 6 },
          { id: 'pick_row4', kind: 'button', label: '探针（绿）', action: 'slot-set', payload: { slot: 'slot1', pos: 'role' }, hit: 'rect', anchor: 'rc', rect: [880, 400, 340, 56], z: 6 }
        ]
      },
      modal_skill_pick: {
        role: 'modal',
        mask: { color: '#000000', opacity: 0.35, closeOnMaskClick: true },
        background: { asset: '', fit: 'cover' },
        elements: [
          { id: 'spick_panel', kind: 'deco', label: '候选技能', hit: 'rect', anchor: 'rc', rect: [860, 150, 380, 420], z: 5 },
          { id: 'spick_title', kind: 'deco', label: '可替换的技能', hit: 'rect', anchor: 'rc', rect: [880, 168, 340, 28], z: 6 },
          { id: 'spick_row1', kind: 'button', label: '近战', action: 'slot-set', payload: { slot: 'slot1', pos: 'skill2' }, hit: 'rect', anchor: 'rc', rect: [880, 208, 340, 56], z: 6 },
          { id: 'spick_row2', kind: 'button', label: '平射', action: 'slot-set', payload: { slot: 'slot1', pos: 'skill2' }, hit: 'rect', anchor: 'rc', rect: [880, 272, 340, 56], z: 6 },
          { id: 'spick_row3', kind: 'button', label: '定点', action: 'slot-set', payload: { slot: 'slot1', pos: 'skill2' }, hit: 'rect', anchor: 'rc', rect: [880, 336, 340, 56], z: 6 },
          { id: 'spick_row4', kind: 'button', label: '位移', action: 'slot-set', payload: { slot: 'slot1', pos: 'skill2' }, hit: 'rect', anchor: 'rc', rect: [880, 400, 340, 56], z: 6 }
        ]
      },
      modal_role_plugin_pick: {
        role: 'modal',
        mask: { color: '#000000', opacity: 0.35, closeOnMaskClick: true },
        background: { asset: '', fit: 'cover' },
        elements: [
          { id: 'plug_panel', kind: 'deco', label: '该插槽的**角色插件**候选', hit: 'rect', anchor: 'rc', rect: [860, 150, 380, 420], z: 5 },
          { id: 'plug_title', kind: 'deco', label: '可装 / 可换的角色插件', hit: 'rect', anchor: 'rc', rect: [880, 168, 340, 28], z: 6 },
          { id: 'plug_row1', kind: 'button', label: 'MP 优化·回复', action: 'plugin-set', payload: { slotIndex: 0 }, hit: 'rect', anchor: 'rc', rect: [880, 208, 340, 56], z: 6 },
          { id: 'plug_row2', kind: 'button', label: 'HP 强化', action: 'plugin-set', payload: { slotIndex: 0 }, hit: 'rect', anchor: 'rc', rect: [880, 272, 340, 56], z: 6 },
          { id: 'plug_row3', kind: 'button', label: '清空此槽', action: 'plugin-clear', payload: { slotIndex: 0 }, hit: 'rect', anchor: 'rc', rect: [880, 336, 340, 56], z: 6 }
        ]
      },
      modal_skill_plugin_pick: {
        role: 'modal',
        mask: { color: '#000000', opacity: 0.35, closeOnMaskClick: true },
        background: { asset: '', fit: 'cover' },
        elements: [
          { id: 'splug_panel', kind: 'deco', label: '该插槽的**技能插件**候选', hit: 'rect', anchor: 'rc', rect: [860, 150, 380, 420], z: 5 },
          { id: 'splug_title', kind: 'deco', label: '可装 / 可换的技能插件', hit: 'rect', anchor: 'rc', rect: [880, 168, 340, 28], z: 6 },
          { id: 'splug_row1', kind: 'button', label: '长剑（范围 0-3）', action: 'plugin-set', payload: { slotIndex: 0 }, hit: 'rect', anchor: 'rc', rect: [880, 208, 340, 56], z: 6 },
          { id: 'splug_row2', kind: 'button', label: '连击', action: 'plugin-set', payload: { slotIndex: 0 }, hit: 'rect', anchor: 'rc', rect: [880, 272, 340, 56], z: 6 },
          { id: 'splug_row3', kind: 'button', label: '清空此槽', action: 'plugin-clear', payload: { slotIndex: 0 }, hit: 'rect', anchor: 'rc', rect: [880, 336, 340, 56], z: 6 }
        ]
      }
    }
  };

  /** 只为"单画面"用途派生：导出脚本/旧测试要 hub 这一屏的 {canvas,breakpoints,elements} */
  var DEFAULT_LAYOUT = screenLayout(DEFAULT_BUNDLE, 'hub');

  /* ---------- 多边形（命中区形状）----------
   * 坐标空间固定为 **0..100 的归一化盒**，渲染时按元素 rect 拉伸：
   *   这样做的好处 = 改 rect（换素材尺寸）不用重画形状；素材 @2x 也不用改。
   * 只支持 M / L / H / V / Z（多边形）。遇到曲线等其它指令一律**判为不支持**（返回 null），
   *   以免布局台把手写的曲线路径改坏。
   *
   * ⚠ 「正多边形」必须**按 rect 的宽高比现算**：path 坐标是百分比，同一个 0..100 的六边形
   *   在非正方形 rect 上会被拉伸成不等边。所以正 N 边形预设是函数（make），不是固定字符串。
   */

  /** 像素空间里的正 N 边形顶点（保证等边），换算到 0..100 盒；恰好贴住盒的一轴 */
  function regularPolygonPoints(n, w, h, flatTop) {
    n = Math.max(3, Math.min(24, Math.round(num(n, 6))));
    var ww = num(w, 0) > 0 ? num(w, 0) : 100, hh = num(h, 0) > 0 ? num(h, 0) : 100;
    var start = flatTop ? 0 : -Math.PI / 2;
    var maxCos = 0, maxSin = 0, i, a;
    for (i = 0; i < n; i++) {
      a = start + i * 2 * Math.PI / n;
      maxCos = Math.max(maxCos, Math.abs(Math.cos(a)));
      maxSin = Math.max(maxSin, Math.abs(Math.sin(a)));
    }
    var R = 0.5 * Math.min(ww / (maxCos || 1e-9), hh / (maxSin || 1e-9));
    var pts = [];
    for (i = 0; i < n; i++) {
      a = start + i * 2 * Math.PI / n;
      pts.push([round(50 + R * Math.cos(a) / ww * 100, 2), round(50 + R * Math.sin(a) / hh * 100, 2)]);
    }
    return pts;
  }
  function regularPolygonPath(n, w, h, flatTop) { return formatPath(regularPolygonPoints(n, w, h, flatTop), true); }

  // 预设：`path` = 固定形状（随 rect 拉伸的风格化形状）；`make` = 按当前 rect 现算
  var PATH_PRESETS = {
    rect: { label: '矩形', path: 'M0,0 L100,0 L100,100 L0,100 Z' },
    pentagon: { label: '五边形（盾/徽章，拉伸）', path: 'M50,0 L100,30 L100,100 L0,100 L0,30 Z' },
    octagon: { label: '圆角八边形（拉伸）', path: 'M20,0 L80,0 L100,20 L100,80 L80,100 L20,100 L0,80 L0,20 Z' },
    diamond: { label: '菱形（拉伸）', path: 'M50,0 L100,50 L50,100 L0,50 Z' },
    poly3: { label: '正三角形（等边）', make: function (w, h) { return regularPolygonPath(3, w, h, true); } },
    poly4: { label: '正方形（等边，居中）', make: function (w, h) { return regularPolygonPath(4, w, h, true); } },
    poly5: { label: '正五边形（等边）', make: function (w, h) { return regularPolygonPath(5, w, h, false); } },
    poly6: { label: '正六边形·平顶（等边）', make: function (w, h) { return regularPolygonPath(6, w, h, true); } },
    poly6p: { label: '正六边形·尖顶（等边）', make: function (w, h) { return regularPolygonPath(6, w, h, false); } },
    poly8: { label: '正八边形（等边）', make: function (w, h) { return regularPolygonPath(8, w, h, true); } }
  };
  var PATH_PRESET_LABEL = {};
  Object.keys(PATH_PRESETS).forEach(function (k) { PATH_PRESET_LABEL[k] = PATH_PRESETS[k].label; });

  /** 取预设形状：make 型按当前 rect 现算 */
  function presetPath(key, rectW, rectH) {
    var p = PATH_PRESETS[key];
    if (!p) return '';
    return p.make ? p.make(rectW, rectH) : p.path;
  }

  /**
   * 解析 SVG 路径里的**多边形**部分。支持：
   *   M/m L/l H/h V/v Z/z（大小写=绝对/相对）、一个命令后跟多组坐标（隐含重复 lineto）。
   * 明确**不支持** C/Q/A 等曲线/圆弧 → 返回 null（不猜、不改坏）。
   * 之所以要支持相对指令与 H/V：从 Figma / Illustrator 导出的轮廓几乎都是这个写法。
   */
  function parsePath(d) {
    if (typeof d !== 'string' || !d.trim()) return null;
    // 关键：先拒绝未知指令。否则 `C10,10 20,20 …` 里的字母会被分词器**静默丢弃**，
    //   曲线坐标就被当成直线顶点，形状被悄悄改错（这是必须显式挡住的失败模式）。
    if (/[A-Za-z]/.test(d.replace(/[MLHVZmlhvz]/g, ''))) return null;
    var tokens = d.trim().match(/[MLHVZmlhvz]|-?\d*\.?\d+/g);
    if (!tokens) return null;
    var pts = [], closed = false, cur = [0, 0], last = null, i = 0, first = true;
    var readNum = function () { var v = parseFloat(tokens[i]); if (!isFinite(v)) return null; i += 1; return v; };
    while (i < tokens.length) {
      var t = tokens[i];
      if (/^[MLHVZmlhvz]$/.test(t)) { last = t; i += 1; }
      else if (last === null) return null;              // 数字出现在任何命令之前 → 非法
      var cmd = String(last).toUpperCase();
      if (cmd === 'Z') { closed = true; last = null; continue; }
      var rel = last !== cmd;                           // 小写 = 相对
      if (first && cmd === 'M') rel = false;            // SVG 规范：首个 m 视作绝对
      var nx = cur[0], ny = cur[1];
      if (cmd === 'M' || cmd === 'L') {
        var x = readNum(), y = readNum();
        if (x === null || y === null) return null;
        nx = rel ? cur[0] + x : x; ny = rel ? cur[1] + y : y;
        pts.push([round(nx, 2), round(ny, 2)]);
        if (cmd === 'M') last = rel ? 'l' : 'L';        // M 之后的重复坐标 = 隐含 lineto
      } else if (cmd === 'H') {
        var hx = readNum(); if (hx === null) return null;
        nx = rel ? cur[0] + hx : hx;
        pts.push([round(nx, 2), round(ny, 2)]);
      } else if (cmd === 'V') {
        var vy = readNum(); if (vy === null) return null;
        ny = rel ? cur[1] + vy : vy;
        pts.push([round(nx, 2), round(ny, 2)]);
      } else return null;                               // C/Q/A/S/T → 不支持
      cur = [nx, ny];
      first = false;
    }
    if (pts.length < 3) return null;
    return { points: pts, closed: closed };
  }
  function formatPath(points, closed) {
    if (!Array.isArray(points) || points.length < 3) return '';
    var out = points.map(function (p, i) {
      return (i === 0 ? 'M' : 'L') + round(p[0], 1) + ',' + round(p[1], 1);
    }).join(' ');
    return closed === false ? out : out + ' Z';
  }
  function pathPointsOf(el) { return parsePath(el && el.path); }

  /** 归一化 0..100 → 元素在舞台上的绝对坐标 */
  function pathToStage(points, rect) {
    return points.map(function (p) {
      return [rect[0] + p[0] / 100 * rect[2], rect[1] + p[1] / 100 * rect[3]];
    });
  }
  /** 舞台绝对坐标 → 归一化 0..100（夹在盒内：形状以 rect 为界，要更大就改 rect） */
  function stageToPath(x, y, rect) {
    var px = rect[2] ? (x - rect[0]) / rect[2] * 100 : 0;
    var py = rect[3] ? (y - rect[1]) / rect[3] * 100 : 0;
    return [round(clamp(px, 0, 100), 1), round(clamp(py, 0, 100), 1)];
  }
  /** 在第 i 条边（i → i+1）中点插入顶点 */
  function insertVertex(points, i) {
    var n = points.length;
    if (n < 3) return points.slice();
    var idx = ((i % n) + n) % n;
    var a = points[idx], b = points[(idx + 1) % n];
    var out = points.slice();
    out.splice(idx + 1, 0, [round((a[0] + b[0]) / 2, 1), round((a[1] + b[1]) / 2, 1)]);
    return out;
  }
  /** 删顶点；少于 3 个顶点时拒绝（多边形下限） */
  function removeVertex(points, i) {
    if (!Array.isArray(points) || points.length <= 3) return points.slice();
    var idx = ((i % points.length) + points.length) % points.length;
    var out = points.slice();
    out.splice(idx, 1);
    return out;
  }
  /** 射线法：点是否在多边形内（两边坐标系一致即可） */
  function pointInPolygon(points, x, y) {
    var inside = false, n = (points || []).length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = points[i][0], yi = points[i][1], xj = points[j][0], yj = points[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }

  /* ---------- 画面集合（弹窗设计）----------
   * 核心观念：**"切屏"与"弹窗"不是布局的属性，而是动作（action）的语义。**
   *   布局表只负责"按钮画在哪 + 派发哪个 action"；这个 action 是切屏还是开弹窗，
   *   由真代码的 actions.js 决定（例：`item-open` → 设 state.modal；`goto-warehouse` → view.go）。
   * 但要让**弹窗本身也能设计**，就必须把布局从"单画面"升级成"画面集合"：
   *   screens: { hub: {role:'screen'}, modal_loadout: {role:'modal', mask:{...}} }
   *   元素上的 `target` 是**设计期注解**（"点我会打开哪个画面"），供预览演弹窗流程；
   *   真代码可以忽略它（真跳转仍由 action 决定），也可以用来自检"注解与 action 是否一致"。
   */
  var DEFAULT_MASK = { color: '#000000', opacity: 0.55, closeOnMaskClick: true, blocksBackground: true };
  var SCREEN_ROLES = ['screen', 'modal'];

  function normalizeScreen(s, name) {
    var src = s || {};
    var out = {
      role: src.role === 'modal' ? 'modal' : 'screen',
      name: String(name || ''),
      background: { asset: String((src.background && src.background.asset) || ''),
                    fit: (src.background && src.background.fit) === 'contain' ? 'contain' : 'cover' },
      elements: (Array.isArray(src.elements) ? src.elements : []).map(normalizeElement)
    };
    // 结构元数据（由 tools/layout/import-layout.js 写入）：插槽屏 / 列表屏的展开规则，必须随归一化保留
    if (src.slotsFrom && typeof src.slotsFrom === 'object') out.slotsFrom = src.slotsFrom;
    if (src.listFrom && typeof src.listFrom === 'object') out.listFrom = src.listFrom;
    if (out.role === 'modal') {
      var m = src.mask || {};
      out.mask = { color: /^#[0-9a-fA-F]{6}$/.test(String(m.color)) ? String(m.color) : DEFAULT_MASK.color,
                   opacity: typeof m.opacity === 'number' && isFinite(m.opacity) ? round(clamp(m.opacity, 0, 1), 2) : DEFAULT_MASK.opacity,
                   closeOnMaskClick: m.closeOnMaskClick !== false,
                   // 只要有弹窗，**遮罩必须吞掉背景的一切交互**（背景按钮不可点）——默认开，不建议关
                   blocksBackground: m.blocksBackground !== false };
    }
    return out;
  }

  function normalizeBundle(b) {
    var src = b || {};
    var canvas = { w: num(src.canvas && src.canvas.w, 1280), h: num(src.canvas && src.canvas.h, 720) };
    var bps = {};
    BP_KEYS.forEach(function (k) {
      var d = DEFAULT_BP[k], s = (src.breakpoints && src.breakpoints[k]) || {};
      bps[k] = { w: num(s.w, d.w), h: num(s.h, d.h),
                 adapt: s.adapt === 'anchor' ? 'anchor' : 'fit',
                 fit: FIT_MODES.indexOf(s.fit) >= 0 ? s.fit : 'contain' };
    });
    var screens = {};
    if (src.screens && typeof src.screens === 'object') {
      Object.keys(src.screens).forEach(function (k) { screens[k] = normalizeScreen(src.screens[k], k); });
    } else {
      // 向后兼容：根上有 elements ⇒ 当作单画面（旧的 layout-hub.json 也能导入）
      screens[String(src.screen || 'hub')] = normalizeScreen(src, src.screen || 'hub');
    }
    if (!Object.keys(screens).length) screens.hub = normalizeScreen({}, 'hub');
    return { version: 1, canvas: canvas, breakpoints: bps, screens: screens };
  }

  /** 把某个画面包成 layoutAt 能吃的形状（elements 与 breakpoints 保持**同一引用**，便于就地编辑） */
  function screenLayout(bundle, name) {
    var sc = bundle.screens[name];
    if (!sc) return null;
    return { name: name, role: sc.role, mask: sc.mask, canvas: bundle.canvas, breakpoints: bundle.breakpoints,
             background: sc.background, elements: sc.elements };
  }

  function validateBundle(bundle, knownActions) {
    var issues = [];
    var names = Object.keys(bundle.screens);
    if (!names.length) issues.push({ level: 'error', msg: '没有任何画面' });
    if (!bundle.screens.hub) issues.push({ level: 'warn', msg: '没有名为 hub 的主画面（真代码默认落在 hub）' });
    names.forEach(function (n) {
      var sc = bundle.screens[n];
      if (!/^[a-zA-Z][\w-]*$/.test(n)) issues.push({ level: 'error', msg: '画面名不合法：' + n + '（要字母开头，只含字母数字下划线连字符）' });
      var lay = screenLayout(bundle, n);
      validateLayout(lay, knownActions).forEach(function (i) {
        issues.push({ level: i.level, msg: '[' + n + '] ' + i.msg });
      });
      if (sc.role === 'modal') {
        if (!sc.elements.length) issues.push({ level: 'warn', msg: '[' + n + '] 弹窗画面还没有任何元素' });
        if (!sc.mask || typeof sc.mask.opacity !== 'number') issues.push({ level: 'error', msg: '[' + n + '] 弹窗缺少遮罩配置' });
      }
    });
    // 层级（界面/弹窗的包含关系）与注释：target 存在性、target↔action 一致性、孤立画面
    validateHierarchy(bundle).forEach(function (i) { issues.push({ level: i.level, msg: i.msg }); });
    return issues;
  }

  /** 预览用：算出某个画面在某断点下的元素（目标空间坐标；可带设计期状态） */
  function screenAt(bundle, name, bp, sstate, data) {
    var lay = screenLayout(bundle, name);
    return lay ? layoutAt(lay, bp, sstate, data) : [];
  }

  /**
   * 径向排布：以 (cx,cy) 为圆心，把 n 个 w×h 的框依次放在正 n 边形的 n 个方向上。
   *   startDeg = -90 时第一个在正上方，n=6 就是**正六边形的六个方向**（上/右上/右下/下/左下/左上）。
   * 返回 rect 数组（左上角坐标），与元素 rect 同坐标系。
   */
  function radialRects(cx, cy, r, n, w, h, startDeg) {
    var cnt = Math.max(1, Math.round(num(n, 6)));
    var start = num(startDeg, -90) * Math.PI / 180;
    var out = [], i, a;
    for (i = 0; i < cnt; i++) {
      a = start + i * 2 * Math.PI / cnt;
      out.push([round(cx + r * Math.cos(a) - w / 2, 2), round(cy + r * Math.sin(a) - h / 2, 2), w, h]);
    }
    return out;
  }

  /**
   * 元素级"显示条件"（设计期状态）：`when: { activeSlot: 1 }` 或 `{ activeSlot: [1, 3] }`。
   * 用途：同一份布局在不同状态下某些元素显示/隐藏（例：三个出战配置各自的「出战」角标）。
   * 真代码的渲染层照同一条规则过滤即可（比在 CSS 里堆状态类更好测）。
   */
  var WHEN_KEYS = ['activeSlot', 'battleSlot'];
  function whenMatches(el, sstate) {
    var w = el && el.when;
    if (!w || typeof w !== 'object') return true;
    var st = sstate || {};
    for (var i = 0; i < WHEN_KEYS.length; i++) {
      var k = WHEN_KEYS[i];
      if (w[k] === undefined || w[k] === null) continue;
      var want = Array.isArray(w[k]) ? w[k] : [w[k]];
      var got = st[k];
      if (got === undefined || got === null) return false;    // 声明了条件但当前态没给值 → 视为不满足
      var hit = want.some(function (v) { return String(v) === String(got); });
      if (!hit) return false;
    }
    return true;
  }

  function num(v, dflt) { return typeof v === 'number' && isFinite(v) ? v : dflt; }

  /* ---------- 数据绑定：占位符 ----------
   * 装饰控件与按钮都能"读数据"：label / asset 里写 {key}，渲染时用数据替换。
   *   label: "{nickname}" / asset: "{roleIcon}"
   * 键表是**封闭白名单**：拼错的键会被校验器抓出来（不会静默显示成 {nicknmae}）。
   * 真代码由 format.js 提供同一份扁平数据（单一投影真源），引擎只做字符串替换。
   */
  var TIER_CN = { common: '绿', rare: '蓝', epic: '紫', legendary: '橙', mythic: '青' };
  var TPL_TEXT_KEYS = ['nickname', 'tierName', 'tier', 'points', 'wins', 'losses', 'unread',
    'slotName', 'roleName', 'roleQuality', 'skill1Name', 'skill2Name', 'skill3Name', 'aiName', 'configLabel',
    'activeSlot', 'configId', 'battleSlot', 'rowLabel', 'rowUid', 'pickPos', 'pickIdx', 'pickTargetUid'];
  var TPL_ASSET_KEYS = ['roleIcon', 'skill1Icon', 'skill2Icon', 'skill3Icon', 'aiIcon', 'tierIcon', 'qualityFrame', 'rowIcon'];
  var TPL_KEYS = {};
  TPL_TEXT_KEYS.concat(TPL_ASSET_KEYS).forEach(function (k) { TPL_KEYS[k] = TPL_ASSET_KEYS.indexOf(k) >= 0 ? 'asset' : 'text'; });

  /** 把"玩家数据 + 各配置"展开成扁平键值（真代码里这份数据来自 /me 与 /me/configs） */
  function bindData(src, activeSlot) {
    var d = src || {};
    var slots = d.slots || {};
    var cur = slots[String(activeSlot)] || slots[activeSlot] || {};
    var role = cur.role || {}, skills = cur.skills || [];
    var icon = function (kind, id) { return id ? ('assets/' + kind + '/' + id + '.webp') : ''; };
    return {
      nickname: d.nickname || '', tier: d.tier || '', tierName: TIER_CN[d.tier] || (d.tier || ''),
      points: d.points == null ? '' : String(d.points),
      wins: d.wins == null ? '' : String(d.wins), losses: d.losses == null ? '' : String(d.losses),
      unread: '未读 进攻' + (d.unreadAttack || 0) + '/防守' + (d.unreadDefense || 0),
      slotName: cur.name || '', configLabel: '配置' + (activeSlot || 1),
      activeSlot: String(activeSlot || 1), configId: 'slot' + (activeSlot || 1),
      battleSlot: String(d.battleSlot || activeSlot || 1),
      roleName: role.name || '', roleQuality: TIER_CN[role.quality] || (role.quality || ''),
      skill1Name: (skills[0] || {}).name || '', skill2Name: (skills[1] || {}).name || '',
      skill3Name: (skills[2] || {}).name || '', aiName: typeof cur.ai === 'string' ? cur.ai : ((cur.ai || {}).name || ''),
      roleIcon: icon('role', role.id), skill1Icon: icon('skill', (skills[0] || {}).id),
      skill2Icon: icon('skill', (skills[1] || {}).id), skill3Icon: icon('skill', (skills[2] || {}).id),
      aiIcon: '', tierIcon: d.tier ? ('assets/tier/' + d.tier + '.svg') : '',
      qualityFrame: 'assets/frame/' + (role.quality || 'common') + '.svg'
    };
  }

  /** 替换 {key}；返回替换结果 + 未识别的键（供校验器报警） */
  function resolveTpl(str, data) {
    if (typeof str !== 'string' || str.indexOf('{') < 0) return { text: str == null ? '' : str, unknown: [] };
    var unknown = [];
    var text = str.replace(/\{([A-Za-z][\w]*)\}/g, function (m, k) {
      if (!TPL_KEYS[k]) { unknown.push(k); return m; }
      var v = data ? data[k] : undefined;
      if (v === undefined || v === null) return m;
      return String(v);
    });
    return { text: text, unknown: unknown };
  }
  /** 找出元素里用到的所有占位符键（校验用） */
  function tplKeysOf(el) {
    var out = [];
    [el && el.label, el && el.asset].forEach(function (s) {
      if (typeof s !== 'string') return;
      var m = s.match(/\{([A-Za-z][\w]*)\}/g) || [];
      m.forEach(function (t) { out.push(t.slice(1, -1)); });
    });
    return out;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round(v, p) { var f = Math.pow(10, p == null ? 2 : p); var r = Math.round(v * f) / f; return r === 0 ? 0 : r; }
  function isValidAnchor(a) {
    if (typeof a !== 'string' || a.length !== 2) return false;
    return ANCHOR_X[a.charAt(0)] !== undefined && ANCHOR_Y[a.charAt(1)] !== undefined;
  }
  function anchorFractions(a) {
    if (!isValidAnchor(a)) return { ax: 0, ay: 0 };
    return { ax: ANCHOR_X[a.charAt(0)], ay: ANCHOR_Y[a.charAt(1)] };
  }

  /** 整屏等比缩放：把基准画布映射到目标视口 */
  function sceneFit(baseW, baseH, targetW, targetH, fit) {
    var sx = targetW / baseW, sy = targetH / baseH;
    var s = fit === 'cover' ? Math.max(sx, sy) : (fit === 'stretch' ? sx : Math.min(sx, sy));
    return { scale: s, scaleY: fit === 'stretch' ? sy : s,
             offsetX: (targetW - baseW * s) / 2, offsetY: (targetH - baseH * s) / 2 };
  }

  function breakpointOf(layout, bp) {
    var s = (layout && layout.breakpoints && layout.breakpoints[bp]) || {};
    var d = DEFAULT_BP[bp] || { w: 1280, h: 720, adapt: 'fit', fit: 'contain' };
    return { w: num(s.w, d.w), h: num(s.h, d.h),
             adapt: s.adapt === 'anchor' ? 'anchor' : 'fit',
             fit: FIT_MODES.indexOf(s.fit) >= 0 ? s.fit : 'contain' };
  }

  /**
   * 把元素解算到某个断点的目标空间。
   * - 若该断点有 overrides[bp].rect → 直接使用（该矩形就是**目标空间**坐标，"固化独立布局"）
   * - 否则按断点适配方式算：fit = 整屏等比缩放；anchor = 按锚点跟随（保持像素尺寸）
   */
  function resolveElement(el, base, bp, bpDef) {
    var ov = (el.overrides && el.overrides[bp]) || null;
    var src = (ov && Array.isArray(ov.rect)) ? ov.rect : el.rect;
    var x = num(src[0], 0), y = num(src[1], 0), w = num(src[2], 1), h = num(src[3], 1);
    if (ov && Array.isArray(ov.rect)) return { x: x, y: y, w: w, h: h, scale: 1, fromOverride: true };
    if (bpDef.adapt === 'fit') {
      var f = sceneFit(base.w, base.h, bpDef.w, bpDef.h, bpDef.fit);
      return { x: f.offsetX + x * f.scale, y: f.offsetY + y * f.scale,
               w: w * f.scale, h: h * f.scale, scale: f.scale, fromOverride: false };
    }
    var fr = anchorFractions(el.anchor);
    var k = num(el.scale, 1) || 1;
    return { x: x + (bpDef.w - base.w) * fr.ax, y: y + (bpDef.h - base.h) * fr.ay,
             w: w * k, h: h * k, scale: k, fromOverride: false };
  }

  function layoutAt(layout, bp, sstate, data) {
    var base = layout.canvas, bpDef = breakpointOf(layout, bp), out = [];
    (layout.elements || []).forEach(function (el) {
      var ov = el.overrides && el.overrides[bp];
      if (el.hidden || (ov && ov.hidden)) return;
      if (!whenMatches(el, sstate)) return;             // 设计期状态过滤
      var r = resolveElement(el, base, bp, bpDef);
      var rawLabel = el.label || '', rawAsset = el.asset || '';
      var rt = data ? resolveTpl(rawLabel, data) : { text: rawLabel };
      var ra = data ? resolveTpl(rawAsset, data) : { text: rawAsset };
      var payload = el.payload;
      if (data && payload && typeof payload === 'object') {
        var pl = {};
        Object.keys(payload).forEach(function (k) {
          var v = payload[k];
          pl[k] = (typeof v === 'string') ? resolveTpl(v, data).text : v;
        });
        payload = pl;
      }
      out.push({ id: el.id, label: rawLabel, text: rt.text, asset: ra.text, assetRaw: rawAsset, payload: payload,
                 kind: el.kind || 'button', action: el.action || '', target: el.target || '',
                 setState: el.setState, when: el.when,
                 parent: el.parent || '', scroll: el.scroll, font: el.font, grid: el.grid, nine: el.nine,
                 opacity: num(el.opacity, 1), clickThrough: el.clickThrough === true,
                 hit: el.hit || 'rect', path: el.path || '',
                 rot: num(el.rot, 0), z: num(el.z, 1),
                 rect: [round(r.x, 2), round(r.y, 2), round(r.w, 2), round(r.h, 2)],
                 fromOverride: !!r.fromOverride });
    });
    // D-185：把**祖先滚动容器的偏移**从子元素位置上扣掉 —— 这样产品渲染层与设计器的算法完全一致
    //   （两边都只是"画在算好的坐标上"，不各写一遍语义）。若用原生 overflow 滚动，这些偏移量为 0。
    applyScrollOffsets(out);
    return out;
  }

  /** 把每个元素沿 parent 链向上累积的 scroll(left/top) 从 rect 上扣掉（就地改 out） */
  function applyScrollOffsets(out) {
    var byId = {};
    out.forEach(function (e) { byId[e.id] = e; });
    out.forEach(function (e) {
      var dx = 0, dy = 0, walk = e.parent, guard = 0;
      while (walk && guard++ < 64) {
        var p = byId[walk];
        if (!p) break;
        if (p.scroll) { dx += num(p.scroll.left, 0); dy += num(p.scroll.top, 0); }
        walk = p.parent;
      }
      if (dx || dy) e.rect = [round(e.rect[0] - dx, 2), round(e.rect[1] - dy, 2), e.rect[2], e.rect[3]];
    });
  }

  /* ---------- 吸附与辅助线 ---------- */
  function bestSnap(value, cands, tol) {
    var best = null;
    for (var i = 0; i < (cands || []).length; i++) {
      var d = cands[i] - value;
      if (Math.abs(d) <= tol && (best === null || Math.abs(d) < Math.abs(best.delta))) best = { value: cands[i], delta: d };
    }
    return best;
  }

  function guideCandidates(elements, skipId, canvas) {
    var xs = [0, canvas.w / 2, canvas.w], ys = [0, canvas.h / 2, canvas.h];
    (elements || []).forEach(function (el) {
      if (!el || el.id === skipId || el.hidden) return;
      var r = el.rect || [];
      if (r.length !== 4) return;
      xs.push(r[0], r[0] + r[2] / 2, r[0] + r[2]);
      ys.push(r[1], r[1] + r[3] / 2, r[1] + r[3]);
    });
    return { xs: xs, ys: ys };
  }

  /**
   * 移动吸附：左/中/右（上/中/下）三条参考线里取最近的一条。
   * 注意：三个参考点都随矩形整体平移，所以对 x（或 y）的修正量就是**参考点自身的 delta**，
   *   与其是左边/中心/右边无关（早期写成 offset+delta 会把右边对齐算错）。
   */
  function snapMove(rect, cands, grid, tol) {
    var out = rect.slice(), guides = [];
    var axis = function (i, cross) {
      var v = out[i];
      var picks = [v, v + out[cross] / 2, v + out[cross]];
      var best = null;
      picks.forEach(function (at) {
        var s = bestSnap(at, i === 0 ? cands.xs : cands.ys, tol);
        if (s && (best === null || Math.abs(s.delta) < Math.abs(best.delta))) best = s;
      });
      if (best) { out[i] = v + best.delta; guides.push({ axis: i === 0 ? 'v' : 'h', pos: best.value }); }
      else if (grid > 0) out[i] = Math.round(v / grid) * grid;
    };
    axis(0, 2); axis(1, 3);
    return { rect: out, guides: guides };
  }

  /** 缩放吸附：只吸附被拖的那条边 */
  function snapEdge(value, cands, grid, tol) {
    var s = bestSnap(value, cands, tol);
    if (s) return { value: s.value, guide: true };
    return { value: grid > 0 ? Math.round(value / grid) * grid : value, guide: false };
  }

  /* ---------- 归一化 / 校验 ---------- */
  function normalizeElement(el) {
    var out = {
      id: String(el.id == null ? '' : el.id),
      kind: el.kind === 'deco' ? 'deco' : 'button',
      action: String(el.action == null ? '' : el.action),
      hit: HIT_MODES.indexOf(el.hit) >= 0 ? el.hit : 'rect',
      anchor: isValidAnchor(el.anchor) ? el.anchor : 'lt',
      rect: [0, 0, 1, 1].map(function (_, i) { return round(num((el.rect || [])[i], [0, 0, 1, 1][i]), 2); })
    };
    if (el.target) out.target = String(el.target);      // 设计期注解：点我会打开哪个画面（弹窗流程预览用）
    // desc：**自然语言注释**（这一块是干什么的）。设计期字段，产品渲染不读它，
    //   只用于：① 工具里看清每个元素的职责；② 以后照它把"不完整/未实现"的功能补齐。
    if (el.desc) out.desc = String(el.desc);
    // parent：这一块**装在哪一块里面**（把平铺列表变成层级）。父块必须会裁剪（见 validateLayout）。
    //   rect 语义随之变成"相对父块内容原点" —— 与 CSS absolute 定位的直觉一致。
    if (el.parent) out.parent = String(el.parent);
    // scroll：这一块是**滚动容器**（固定大小的框，内容超出后可以丝滑上下/左右滚动）。
    //   dir: v 纵向（默认）/ h 横向 / both 双向 / none 只裁剪不滚
    //   left/top: **设计期初始偏移**（渲染层写成 scrollLeft/scrollTop，同时用作设计器里的定格）
    //   fade: 两端渐隐遮罩（提示"还有内容"）
    if (el.scroll && typeof el.scroll === 'object') {
      var scr = {};
      var dir = String(el.scroll.dir == null ? '' : el.scroll.dir);
      // ⚠️ 非法值**原样保留**交给 validateLayout 报错 —— 静默改成 'v' 会让"看着像滚动容器但没生效"
      //    变成最难查的一类问题（改了配置、界面上什么提示都没有）
      if (dir !== '') scr.dir = dir;
      var sleft = Math.max(0, num(el.scroll.left, 0));
      var stop = Math.max(0, num(el.scroll.top, 0));
      if (sleft) scr.left = round(sleft, 1);
      if (stop) scr.top = round(stop, 1);
      if (el.scroll.fade === true) scr.fade = true;
      // 声明了 scroll 就一定留个 dir —— 否则"看着像滚动容器但没生效"
      out.scroll = Object.keys(scr).length ? scr : { dir: 'v' };
    }
    // font：文字块的排版（标题/说明/数值这类纯文字块用）。**不叫 text** —— 解析后的元素里 	ext 是渲染后的文字，改叫 text 会撞车
    if (el.font && typeof el.font === 'object') {
      var tx = {};
      var fsize = num(el.font.size, 0);
      if (fsize > 0) tx.size = Math.round(fsize);           // 越界值由校验器报（不在这里夹）
      if (el.font.align !== undefined && el.font.align !== null && el.font.align !== '') tx.align = String(el.font.align);
      if (typeof el.font.color === 'string' && el.font.color !== '') tx.color = el.font.color;
      if (el.font.bold === true) tx.bold = true;
      if (num(el.font.lineHeight, 0) > 0) tx.lineHeight = round(num(el.font.lineHeight, 0), 2);
      if (el.font.wrap === false) tx.wrap = false;
      if (Object.keys(tx).length) out.font = tx;
    }
    // grid：把**子元素**按等距网格自动排（图标大小 = cell 尺寸）。只在"容器 + 子元素"里有意义。
    if (el.grid && typeof el.grid === 'object') {
      var gr = {};
      var gw = num(el.grid.cellW, 0), gh = num(el.grid.cellH, 0);
      if (gw > 0) gr.cellW = round(gw, 1);
      if (gh > 0) gr.cellH = round(gh, 1);
      if (num(el.grid.gapX, 0) > 0) gr.gapX = round(num(el.grid.gapX, 0), 1);
      if (num(el.grid.gapY, 0) > 0) gr.gapY = round(num(el.grid.gapY, 0), 1);
      if (num(el.grid.padX, 0) > 0) gr.padX = round(num(el.grid.padX, 0), 1);
      if (num(el.grid.padY, 0) > 0) gr.padY = round(num(el.grid.padY, 0), 1);
      if (num(el.grid.cols, 0) > 0) gr.cols = Math.round(num(el.grid.cols, 0));
      if (num(el.grid.maxRows, 0) > 0) gr.maxRows = Math.round(num(el.grid.maxRows, 0));
      if (Object.keys(gr).length) out.grid = gr;
    }
    // nine：九宫格拉伸（面板/按钮底图按 9 片拉伸，圆角不糊）；slice = 四边切片厚度（px）
    if (el.nine && typeof el.nine === 'object' && num(el.nine.slice, 0) > 0) {
      out.nine = { slice: Math.round(num(el.nine.slice, 0)) };
    }
    // 通用视觉：不透明度（0..1）；clickThrough = 不可点（把点击透给下层）
    var op = num(el.opacity, 1);
    if (op >= 0 && op < 1) out.opacity = round(op, 2);
    if (el.clickThrough === true) out.clickThrough = true;
    // setState：点击后只改**本地显示状态**（例：切换主界面显示哪个出战配置），不导航、不写服务端
    if (el.setState && typeof el.setState === 'object' && Object.keys(el.setState).length) out.setState = el.setState;
    if (el.label) out.label = String(el.label);
    if (el.payload && typeof el.payload === 'object' && Object.keys(el.payload).length) out.payload = el.payload;
    if (el.asset) out.asset = String(el.asset);
    if (out.hit === 'path' && el.path) {
      var parsed = parsePath(el.path);
      // 能解析 → 规范化写法（保证 diff 稳定）；不能解析（曲线等）→ 原样保留，由校验提示
      out.path = parsed ? formatPath(parsed.points, parsed.closed) : String(el.path);
    }
    if (num(el.rot, 0)) out.rot = round(el.rot, 1);
    if (num(el.z, 1) !== 1) out.z = num(el.z, 1);
    if (el.hidden) out.hidden = true;
    if (el.when && typeof el.when === 'object') {
      var w = {};
      WHEN_KEYS.forEach(function (k) { if (el.when[k] !== undefined && el.when[k] !== null) w[k] = el.when[k]; });
      if (Object.keys(w).length) out.when = w;
    }
    var ov = {};
    BP_KEYS.forEach(function (bp) {
      var o = el.overrides && el.overrides[bp];
      if (!o) return;
      var keep = {};
      if (Array.isArray(o.rect)) keep.rect = o.rect.map(function (v) { return round(num(v, 0), 2); });
      if (o.hidden) keep.hidden = true;
      if (Object.keys(keep).length) ov[bp] = keep;
    });
    if (Object.keys(ov).length) out.overrides = ov;
    return out;
  }

  function normalizeLayout(layout) {
    var l = layout || {};
    var canvas = { w: num(l.canvas && l.canvas.w, 1280), h: num(l.canvas && l.canvas.h, 720) };
    var bps = {};
    BP_KEYS.forEach(function (k) {
      var d = DEFAULT_BP[k], s = (l.breakpoints && l.breakpoints[k]) || {};
      bps[k] = { w: num(s.w, d.w), h: num(s.h, d.h),
                 adapt: s.adapt === 'anchor' ? 'anchor' : 'fit',
                 fit: FIT_MODES.indexOf(s.fit) >= 0 ? s.fit : 'contain' };
    });
    return {
      screen: String(l.screen || 'hub'),
      canvas: canvas,
      background: { asset: String((l.background && l.background.asset) || ''),
                    fit: (l.background && l.background.fit) === 'contain' ? 'contain' : 'cover' },
      breakpoints: bps,
      elements: (Array.isArray(l.elements) ? l.elements : []).map(normalizeElement)
    };
  }

  function validateLayout(layout, knownActions) {
    var issues = [], seen = {};
    var canvas = layout.canvas || { w: 0, h: 0 };
    var known = (Array.isArray(knownActions) && knownActions.length) ? knownActions : null;
    (layout.elements || []).forEach(function (el, i) {
      var tag = el.id || ('第 ' + (i + 1) + ' 个元素');
      if (!el.id) issues.push({ level: 'error', msg: tag + '：缺少 id' });
      else if (seen[el.id]) issues.push({ level: 'error', msg: tag + '：id 重复' });
      seen[el.id] = 1;
      // 按钮必须"有反应"：要么有 action（走注册表），要么有 setState（只改本地显示状态，
      //   例：切换主界面显示哪个出战配置 —— 不导航、不进编辑界面）
      if (el.kind !== 'deco' && !el.action && !(el.setState && Object.keys(el.setState).length))
        issues.push({ level: 'error', msg: tag + '：按钮既没有 action 也没有 setState（点了不会有任何反应）' });
      else if (el.kind !== 'deco' && el.action && known && known.indexOf(el.action) < 0)
        issues.push({ level: 'warn', msg: tag + '：动作「' + el.action + '」不在当前注册表里（可能是尚未实现的计划动作 → 会变死按钮）' });
      if (HIT_MODES.indexOf(el.hit) < 0) issues.push({ level: 'error', msg: tag + '：hit 非法（' + el.hit + '）' });
      var r = el.rect || [];
      if (r.length !== 4 || r.some(function (v) { return typeof v !== 'number' || !isFinite(v); }))
        issues.push({ level: 'error', msg: tag + '：rect 必须是 4 个数字' });
      else {
        if (r[2] <= 0 || r[3] <= 0) issues.push({ level: 'error', msg: tag + '：宽高必须为正' });
        if (r[0] < 0 || r[1] < 0 || r[0] + r[2] > canvas.w || r[1] + r[3] > canvas.h)
          issues.push({ level: 'warn', msg: tag + '：超出基准画布 ' + canvas.w + '×' + canvas.h });
      }
      if (el.hit === 'path') {
        if (!el.path) issues.push({ level: 'warn', msg: tag + '：声明 path 命中但没有 path（会按 rect 兜底）' });
        else {
          var pp = parsePath(el.path);
          if (!pp) issues.push({ level: 'error', msg: tag + '：path 解析失败（只支持 M/L/Z 多边形，曲线请改用 rect/alpha 命中）' });
          else {
            var bad = pp.points.filter(function (p) { return p[0] < 0 || p[0] > 100 || p[1] < 0 || p[1] > 100; });
            if (bad.length) issues.push({ level: 'warn', msg: tag + '：path 有 ' + bad.length + ' 个顶点超出 0..100 盒（会被裁切）' });
          }
        }
      }
      if (el.kind !== 'deco' && !el.asset) issues.push({ level: 'warn', msg: tag + '：还没指定素材路径（暂时显示占位）' });
      // ---- D-185：容器 / 滚动 / 网格 / 文字 / 九宫格 ----
      if (el.scroll) {
        if (SCROLL_DIRS.indexOf(String(el.scroll.dir || '')) < 0)
          issues.push({ level: 'error', msg: tag + '：scroll.dir 非法（' + el.scroll.dir + '，只能是 v / h / both / none）' });
        if (el.kind !== 'deco' && !el.action && !(el.setState && Object.keys(el.setState).length))
          issues.push({ level: 'warn', msg: tag + '：滚动容器自己有 action 的话会与"滑动"抢手势，确认是有意的' });
      }
      if (el.font) {
        if (el.font.size !== undefined && !(el.font.size > 0 && el.font.size <= 200))
          issues.push({ level: 'error', msg: tag + '：text.size 必须在 1..200 之间' });
        if (el.font.align !== undefined && TEXT_ALIGNS.indexOf(el.font.align) < 0)
          issues.push({ level: 'error', msg: tag + '：text.align 非法（' + el.font.align + '）' });
      }
      if (el.grid) {
        if (!(el.grid.cellW > 0) && !(el.grid.cellH > 0) && !(el.grid.cols > 0))
          issues.push({ level: 'warn', msg: tag + '：grid 既没写 cellW/cellH 也没写 cols，排不出网格' });
        if (el.kind !== 'deco' && !el.scroll && el.parent === undefined)
          issues.push({ level: 'warn', msg: tag + '：grid 是给**子元素**排位置用的，但这一块没有子元素也没有滚动区（自己不会动）' });
      }
      if (el.nine && !el.asset) issues.push({ level: 'warn', msg: tag + '：九宫格要配一张底图（asset），否则看不出拉伸效果' });
      tplKeysOf(el).forEach(function (k) {
        if (!TPL_KEYS[k]) issues.push({ level: 'error', msg: tag + '：占位符 {' + k + '} 不在键表里（可用：' + TPL_TEXT_KEYS.concat(TPL_ASSET_KEYS).join('/') + '）' });
      });
      if (el.kind !== 'deco' && !el.action && !(el.setState && Object.keys(el.setState).length))
        issues.push({ level: 'error', msg: tag + '：按钮既没有 action 也没有 setState（点了不会有任何反应）' });
    });
    // parent 关系（D-185）：父块必须存在、不能自指、不能成环；装进 path 命中的父块要提醒（不裁剪）
    var byId = {};
    (layout.elements || []).forEach(function (x) { byId[x.id] = x; });
    (layout.elements || []).forEach(function (el) {
      var tag = el.id || '(无 id)';
      if (el.parent === undefined) return;
      if (el.parent === el.id) { issues.push({ level: 'error', msg: tag + '：parent 指向自己' }); return; }
      if (!byId[el.parent]) { issues.push({ level: 'error', msg: tag + '：parent 指向不存在的元素「' + el.parent + '」' }); return; }
      var walk = el.parent, guard = 0;
      while (walk !== undefined && guard++ < 64) {
        if (walk === el.id) { issues.push({ level: 'error', msg: tag + '：parent 关系成环（' + el.id + ' → … → ' + el.id + '）' }); break; }
        var up = byId[walk];
        walk = up ? up.parent : undefined;
      }
      var par = byId[el.parent];
      if (par && par.hit === 'path') {
        issues.push({ level: 'warn', msg: tag + '：装进了一个 path 命中的父块（多边形不裁剪子元素，只有滚动容器/rect 才会裁）' });
      }
    });
    if (!(layout.elements || []).length) issues.push({ level: 'warn', msg: '一个元素都没有' });
    return issues;
  }

  /* ---------------- 整包校验：层级 + 注释 ---------------- */

  /**
   * **层级（界面/弹窗的包含关系）**校验 —— 只在本包层面能判的事：
   *   ① 每个元素的 target 必须指向一个真实存在的画面（否则"点它打开哪里"是断的）；
   *   ② 带 target 的元素**必须有一个能进画面的动作**，否则"声明了要进那个画面、点下去却进不去"；
   *   ③ role==='screen' 且**没有任何元素指向它** → 提醒（要么是死页面，要么该给它加个入口）；
   *   ④ role==='modal' 且没有元素指向它 → 提醒（弹窗永远不会出现）。
   *
   * ⚠️ ② 的判据刻意**不写成固定动作白名单**：本项目的布局表在导入期会被 `import-layout.js` 重写动作
   *   （`config-open` / `plugin-pick` / `slot-set` … → `layout-open`），所以合法取值是**一整个家族**。
   *   这里只判"**明显进不去画面的**"：动作空、或动作是纯本地动作（`wait`/`none`/`noop`）。
   *   目标画面存在性顺带覆盖循环引用 —— 循环**合法**（返回主界面、来回弹窗都算），不报错。
   */
  function validateHierarchy(bundle) {
    var issues = [];
    var names = Object.keys(bundle.screens || {});
    var incoming = {};                                  // 画面 → 指向它的元素（用于 ③/④ 与树状图）
    names.forEach(function (n) { incoming[n] = []; });
    // "明显进不去画面"的动作（纯本地等待/空操作）—— 其余一律放行（含导入期会被重写的那些）
    var NO_NAV = ['', 'wait', 'none', 'noop'];
    names.forEach(function (sn) {
      var sc = bundle.screens[sn];
      (sc.elements || []).forEach(function (el) {
        // 消息一律带 [画面名] 前缀 —— 多画面下必须能定位（与 validateBundle 的既有约定一致）
        var tag = '[' + sn + '] ' + (el.id || '(无 id)');
        if (!el.target) return;
        if (names.indexOf(el.target) < 0) {
          issues.push({ level: 'error', msg: tag + '：target 指向不存在的画面「' + el.target + '」（点它会跳进空处）' });
          return;
        }
        incoming[el.target].push(sn + '/' + el.id);
        var act = String(el.action || '');
        if (NO_NAV.indexOf(act) >= 0) {
          issues.push({
            level: 'error',
            msg: tag + '：声明了 target「' + el.target + '」，但 action 是「' + (act || '（空）')
              + '」—— 点了**不会**进那个画面（要给它一个能进画面的 action，或删掉 target）',
          });
        }
      });
    });
    names.forEach(function (n) {
      var sc = bundle.screens[n];
      var src = incoming[n];
      if (!src.length) {
        issues.push({
          level: 'warn',
          msg: '[' + n + '] ' + (sc.role === 'modal' ? '弹窗' : '整屏')
            + '没有任何元素指向它' + (sc.role === 'modal' ? '（永远不会弹出来）' : '（从别的画面进不去）'),
        });
      }
    });
    return issues;
  }

  return {
    DEFAULT_LAYOUT: DEFAULT_LAYOUT, DEFAULT_BUNDLE: DEFAULT_BUNDLE,
    ANCHOR_X: ANCHOR_X, ANCHOR_Y: ANCHOR_Y, HIT_MODES: HIT_MODES, FIT_MODES: FIT_MODES,
    SCROLL_DIRS: SCROLL_DIRS, TEXT_ALIGNS: TEXT_ALIGNS, applyScrollOffsets: applyScrollOffsets,
    BP_KEYS: BP_KEYS, BP_LABEL: BP_LABEL, DEFAULT_BP: DEFAULT_BP,
    num: num, round: round, isValidAnchor: isValidAnchor, anchorFractions: anchorFractions,
    sceneFit: sceneFit, breakpointOf: breakpointOf, resolveElement: resolveElement, layoutAt: layoutAt,
    bestSnap: bestSnap, guideCandidates: guideCandidates, snapMove: snapMove, snapEdge: snapEdge,
    PATH_PRESETS: PATH_PRESETS, PATH_PRESET_LABEL: PATH_PRESET_LABEL, presetPath: presetPath,
    regularPolygonPoints: regularPolygonPoints, regularPolygonPath: regularPolygonPath,
    SCREEN_ROLES: SCREEN_ROLES, DEFAULT_MASK: DEFAULT_MASK, WHEN_KEYS: WHEN_KEYS,
    radialRects: radialRects, whenMatches: whenMatches,
    TPL_KEYS: TPL_KEYS, TPL_TEXT_KEYS: TPL_TEXT_KEYS, TPL_ASSET_KEYS: TPL_ASSET_KEYS, TIER_CN: TIER_CN,
    bindData: bindData, resolveTpl: resolveTpl, tplKeysOf: tplKeysOf,
    normalizeScreen: normalizeScreen, normalizeBundle: normalizeBundle,
    screenLayout: screenLayout, validateBundle: validateBundle, screenAt: screenAt,
    parsePath: parsePath, formatPath: formatPath, pathPointsOf: pathPointsOf,
    pathToStage: pathToStage, stageToPath: stageToPath,
    insertVertex: insertVertex, removeVertex: removeVertex, pointInPolygon: pointInPolygon,
    clamp: clamp,
    normalizeElement: normalizeElement, normalizeLayout: normalizeLayout, validateLayout: validateLayout,
    validateHierarchy: validateHierarchy
  };
})();
  CORE.CORE_DIGEST = "761b6693c57b95af";
  return CORE;
});
