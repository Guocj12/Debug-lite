'use strict';
/* public/ai-blueprint.js —— 积木蓝图编辑器核心（D-178）：**纯数据模型**，不碰 DOM、不发请求、不做合法性判决
 *
 * 分工（与 public/{store,format,render,actions}.js）：
 *   · 节点目录 = 服务端 `GET /me/ai/nodes` 的 `catalog`（**单一来源**；本文件的 INPUT_LABELS 只提供界面文案）；
 *   · 蓝图的**地址**语法与**服务端校验错误 path 完全一致**（`body[0].inputs[1]`）→ 出错能直接定位到节点；
 *   · 增删改查（纯函数，返回新蓝图）、表单模型、树行渲染、占用核对、导入导出；
 *   · **不做**"合法/非法"判决：编译与校验一律由服务端 `POST /me/ai/validate` 裁决（前端不复制编译器）。
 *
 * 蓝图格式：{ type:'blueprint', version:1, body:[{ uid, node, params:{}, inputs:[] }] }
 *   · `uid` 蓝图内唯一（记忆变量名与高亮映射都由它派生 → 必须稳定）；
 *   · 子节点顺序 = 目录里 `inputs.kinds` 的顺序（服务端按同一顺序校验与编译）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.aiBlueprint = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CATALOG = [];                 // 服务端目录（setCatalog 注入）
  var BY_ID = {};
  var LIMITS = { maxSlots: 128, maxDepth: 24, blueprintVersion: 1 };

  /* ================= 1. 目录 ================= */

  function setCatalog(catalog, limits) {
    CATALOG = Array.isArray(catalog) ? catalog.slice() : [];
    BY_ID = {};
    for (var i = 0; i < CATALOG.length; i++) BY_ID[CATALOG[i].id] = CATALOG[i];
    if (limits && typeof limits === 'object') LIMITS = Object.assign({}, LIMITS, limits);
  }
  function catalog() { return CATALOG.slice(); }
  function specOf(nodeId) { return BY_ID[nodeId] || null; }
  function limits() { return Object.assign({}, LIMITS); }

  // 界面文案（**前端唯一出处**）：每个节点的子节点位说明 + 类别中文名
  var INPUT_LABELS = Object.freeze({
    f_seq: ['第 %d 步'], f_if: ['条件', '那么', '否则'], f_loop_n: ['循环体'], f_loop_until: ['直到（条件）', '循环体'],
    f_forever: ['循环体'], r_sub: ['子程序内容'], m_timer: ['到点执行'], m_remember: ['记住这个值'],
    c_and: ['并且', '并且'], c_or: ['或者', '或者'], c_not: ['条件'],
    c_compare: ['左边', '右边'], v_arith: ['左边', '右边'],
  });
  var CATEGORY_LABELS = Object.freeze({
    '流程': '流程', '动作': '动作', '感知': '感知', '条件': '条件', '取值': '数值', '记忆': '记忆', '结构': '结构',
  });
  var QUALITY_LABELS = Object.freeze({ common: '绿', rare: '蓝', epic: '紫', legendary: '橙', mythic: '青' });
  var KIND_LABELS = Object.freeze({ stmt: '语句', bool: '条件', value: '数值' });

  function inputLabel(nodeId, index) {
    var arr = INPUT_LABELS[nodeId];
    if (!arr) return '子节点 ' + (index + 1);
    var t = arr[index] !== undefined ? arr[index] : arr[arr.length - 1];
    return t.indexOf('%d') >= 0 ? t.replace('%d', String(index + 1)) : t;
  }

  /* ================= 2. 蓝图与节点构造 ================= */

  function emptyBlueprint() { return { type: 'blueprint', version: LIMITS.blueprintVersion || 1, body: [] }; }
  function clone(bp) { return JSON.parse(JSON.stringify(bp)); }

  // uid 生成：`n1`、`n2`…（扫全树取最大编号 + 1 → 稳定且不与既有冲突）
  function nextUid(bp) {
    var max = 0;
    walk(bp, function (n) {
      var m = /^n(\d+)$/.exec(String(n.uid || ''));
      if (m) max = Math.max(max, Number(m[1]));
    });
    return 'n' + (max + 1);
  }

  function defaultParams(spec) {
    var out = {};
    var ps = spec.params || [];
    for (var i = 0; i < ps.length; i++) out[ps[i].key] = ps[i].default;
    return out;
  }

  // 新建节点：按目录的**必填子节点**自动填默认子节点（"天生合法"，玩家只需改参数）
  function newNode(nodeId, uid) {
    var spec = specOf(nodeId);
    if (!spec) return null;
    var inputs = [];
    var specIn = spec.inputs || { min: 0, max: 0, kinds: [] };
    for (var i = 0; i < specIn.min; i++) {
      var kind = specIn.kinds[i] !== undefined ? specIn.kinds[i] : specIn.kinds[specIn.kinds.length - 1];
      inputs.push(filler(kind));
    }
    return { uid: uid || 'n1', node: nodeId, params: defaultParams(spec), inputs: inputs };
  }

  // 占位子节点（只用于"刚插入时不是空的"；玩家随后替换）
  function filler(kind) {
    if (kind === 'bool') return { uid: 'tmp_c', node: 'c_gap_less', params: { x: 2 }, inputs: [] };
    if (kind === 'value') return { uid: 'tmp_v', node: 's_gap', params: {}, inputs: [] };
    return { uid: 'tmp_s', node: 'a_wait', params: {}, inputs: [] };
  }

  // 修好占位 uid（新增节点后统一重排 uid，避免 tmp_* 重复）
  function normalizeUids(bp) {
    var used = {};
    var seq = 0;
    walk(bp, function (n) {
      seq += 1;
      var cur = String(n.uid || '');
      if (cur === '' || cur.indexOf('tmp_') === 0 || used[cur]) n.uid = 'n' + seq;
      used[n.uid] = true;
    });
    return bp;
  }

  /* ================= 3. 地址层（与服务端校验 path 同语法） ================= */

  // 地址：`body[0]`、`body[0].inputs[1]`、…
  function parseAddr(addr) {
    var s = String(addr || '');
    var m = /^body\[(\d+)\](.*)$/.exec(s);
    if (!m) return null;
    var idxs = [Number(m[1])];
    var rest = m[2];
    var re = /^\.inputs\[(\d+)\]/;
    while (rest.length > 0) {
      var mm = re.exec(rest);
      if (!mm) return null;
      idxs.push(Number(mm[1]));
      rest = rest.slice(mm[0].length);
    }
    return idxs;
  }
  function addrOfIdxs(idxs) {
    var out = 'body[' + idxs[0] + ']';
    for (var i = 1; i < idxs.length; i++) out += '.inputs[' + idxs[i] + ']';
    return out;
  }
  function parentAddrOf(addr) {
    var idxs = parseAddr(addr);
    if (!idxs || idxs.length <= 1) return null;
    return addrOfIdxs(idxs.slice(0, -1));
  }
  function childAddr(addr, i) { return String(addr) + '.inputs[' + i + ']'; }

  function nodeAt(bp, addr) {
    var idxs = parseAddr(addr);
    if (!idxs) return null;
    var list = bp && bp.body;
    var node = null;
    for (var d = 0; d < idxs.length; d++) {
      if (!Array.isArray(list) || !list[idxs[d]]) return null;
      node = list[idxs[d]];
      list = node.inputs;
    }
    return node || null;
  }

  // 纯函数：把 addr 处的节点替换为 newNode（返回新蓝图）
  function replaceAt(bp, addr, newNodeObj) {
    var out = clone(bp);
    var idxs = parseAddr(addr);
    if (!idxs) return out;
    var container = { inputs: out.body };
    for (var d = 0; d < idxs.length - 1; d++) container = container.inputs[idxs[d]];
    container.inputs[idxs[idxs.length - 1]] = newNodeObj;
    return out;
  }

  function removeAt(bp, addr) {
    var out = clone(bp);
    var idxs = parseAddr(addr);
    if (!idxs) return out;
    var container = { inputs: out.body };
    for (var d = 0; d < idxs.length - 1; d++) container = container.inputs[idxs[d]];
    container.inputs.splice(idxs[idxs.length - 1], 1);
    return out;
  }

  // 在 addr 之后插入同级节点（body 层）
  function insertAfter(bp, addr, nodeObj) {
    var out = clone(bp);
    var idxs = parseAddr(addr);
    if (!idxs || idxs.length !== 1) {
      // 子节点位不允许"加同级"（目录用 min/max 固定），改为追加到 body
      out.body.push(nodeObj);
      return normalizeUids(out);
    }
    out.body.splice(idxs[0] + 1, 0, nodeObj);
    return normalizeUids(out);
  }

  // 追加子节点（仅当目录 max 允许：max<0 或当前 < max）
  function appendChild(bp, addr, nodeObj) {
    var out = clone(bp);
    var idxs = parseAddr(addr);
    if (!idxs) return out;
    var container = { inputs: out.body };
    for (var d = 0; d < idxs.length - 1; d++) container = container.inputs[idxs[d]];
    var node = container.inputs[idxs[idxs.length - 1]];
    if (!node) return out;
    var spec = specOf(node.node);
    var specIn = (spec && spec.inputs) || { min: 0, max: 0 };
    node.inputs = node.inputs || [];
    if (specIn.max >= 0 && node.inputs.length >= specIn.max) return out;
    node.inputs.push(nodeObj);
    return normalizeUids(out);
  }

  function moveAt(bp, addr, delta) {
    var out = clone(bp);
    var idxs = parseAddr(addr);
    if (!idxs || idxs.length !== 1) return out;
    var i = idxs[0];
    var j = i + delta;
    if (j < 0 || j >= out.body.length) return out;
    var tmp = out.body[i];
    out.body[i] = out.body[j];
    out.body[j] = tmp;
    return out;
  }

  function setParam(bp, addr, key, value) {
    var out = clone(bp);
    var node = nodeAt(out, addr);
    if (!node) return out;
    node.params = node.params || {};
    node.params[key] = value;
    return out;
  }

  function paramValue(node, key) {
    var spec = specOf(node.node);
    var ps = (spec && spec.params) || [];
    for (var i = 0; i < ps.length; i++) {
      if (ps[i].key === key) {
        var v = node.params ? node.params[key] : undefined;
        return v === undefined || v === null || v === '' ? ps[i].default : v;
      }
    }
    return undefined;
  }

  /* ================= 4. 遍历与统计 ================= */

  function walk(bp, fn) {
    var visit = function (n, depth) {
      if (!n || typeof n !== 'object') return;
      fn(n, depth);
      var ins = Array.isArray(n.inputs) ? n.inputs : [];
      for (var i = 0; i < ins.length; i++) visit(ins[i], depth + 1);
    };
    var body = (bp && bp.body) || [];
    for (var i = 0; i < body.length; i++) visit(body[i], 1);
  }

  function statsOf(bp) {
    var byNode = {};
    var byQuality = {};
    var slots = 0;
    walk(bp, function (n) {
      var spec = specOf(n.node);
      if (!spec) return;
      slots += 1;
      byNode[n.node] = (byNode[n.node] || 0) + 1;
      byQuality[spec.quality] = (byQuality[spec.quality] || 0) + 1;
    });
    return { slots: slots, byNode: byNode, byQuality: byQuality };
  }

  // 与库存核对：返回「超出可用的节点」清单（**只做提示**，最终判决在服务端）
  function shortageOf(bp, inventory) {
    var inv = {};
    var list = Array.isArray(inventory) ? inventory : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].nodeId) inv[list[i].nodeId] = list[i];
    var stats = statsOf(bp);
    var out = [];
    for (var id in stats.byNode) {
      if (!Object.prototype.hasOwnProperty.call(stats.byNode, id)) continue;
      var row = inv[id] || { owned: 0, used: 0, free: 0 };
      var need = stats.byNode[id];
      var free = typeof row.free === 'number' ? row.free : 0;
      if (need > free) {
        var spec = specOf(id);
        out.push({ nodeId: id, name: spec ? spec.name : id, need: need, free: free });
      }
    }
    return out;
  }

  // D-179：把「正在编辑的既有条目」自身的占用从库存里扣掉（前端对齐服务端的 excludeAiId 口径）。
  //   服务端 `PUT /me/ai/:aiId` 校验占用时先扣掉该条目自己的旧占用；前端此前不扣 →
  //   打开自己的 AI 就显示「⚠ 节点不足」，节点库里自己用着的节点全是 0 空闲，玩家会以为存不了。
  function excludeOwnUsage(inventory, blueprint) {
    var list = Array.isArray(inventory) ? inventory : [];
    if (!blueprint) return list;
    var back = statsOf(blueprint).byNode;
    return list.map(function (row) {
      if (!row || typeof row.nodeId !== 'string') return row;
      var n = back[row.nodeId] || 0;
      if (n === 0) return row;
      var owned = typeof row.owned === 'number' ? row.owned : 0;
      var used = typeof row.used === 'number' ? row.used : 0;
      return {
        nodeId: row.nodeId, quality: row.quality, category: row.category,
        owned: owned, used: Math.max(0, used - n), free: owned - Math.max(0, used - n),
      };
    });
  }

  /* ================= 5. 展示（文案摘要 + 树行） ================= */

  function paramText(node) {
    var spec = specOf(node.node);
    if (!spec) return '';
    var ps = spec.params || [];
    var parts = [];
    for (var i = 0; i < ps.length; i++) {
      var v = paramValue(node, ps[i].key);
      if (v === undefined || v === '') continue;
      if (ps[i].type === 'slot') parts.push('技能' + v);
      else if (ps[i].type === 'uid') parts.push('→' + String(v));
      else if (ps[i].type === 'enum') parts.push(String(v));
      else parts.push(String(v));
    }
    return parts.length > 0 ? '（' + parts.join('·') + '）' : '';
  }

  function labelOf(node) {
    var spec = specOf(node && node.node);
    return spec ? spec.name : ('未知节点 ' + (node && node.node));
  }

  function lineOf(node) { return labelOf(node) + paramText(node); }

  // 树行：[{addr, depth, text, header}]（header = 分支/子节点位说明行）
  function treeLines(bp, selectedAddr) {
    return treeRows(bp, selectedAddr).map(function (r) {
      return { addr: r.addr, depth: r.depth, text: r.text, selected: r.selected, header: r.header, kind: r.kind };
    });
  }

  /**
   * D-194：树行（**带几何/归属信息**，供拖放吸附用）。
   * 在 treeLines 的基础上多给：`parentAddr` / `slotIndex` / `nodeId` / `subtreeEnd`。
   *   · 节点行：`parentAddr` = 它装在哪（'' = 顶层 body），`slotIndex` = 它在父的哪个子位
   *   · 槽位头行：`parentAddr` = 拥有这个槽的节点地址，`slotIndex` = 槽号
   *   · `subtreeEnd` = 该节点**整棵子树**最后一行的下标（拖到"块下方"时用它算锚点）
   */
  function treeRows(bp, selectedAddr) {
    var rows = [];
    var visit = function (n, addr, depth, parentAddr, slotIndex) {
      if (!n) return;
      var start = rows.length;
      var spec = specOf(n.node);
      rows.push({ addr: addr, depth: depth, text: lineOf(n), selected: addr === selectedAddr,
                  kind: spec ? spec.kind : null, header: false, rowKind: 'node',
                  parentAddr: parentAddr, slotIndex: slotIndex, nodeId: n.node, subtreeEnd: start });
      var ins = Array.isArray(n.inputs) ? n.inputs : [];
      for (var i = 0; i < ins.length; i++) {
        rows.push({ addr: '', depth: depth + 1, text: inputLabel(n.node, i) + '：', header: true, selected: false,
                    kind: null, rowKind: 'slot', parentAddr: addr, slotIndex: i, nodeId: n.node, subtreeEnd: rows.length });
        visit(ins[i], childAddr(addr, i), depth + 2, addr, i);
      }
      rows[start].subtreeEnd = rows.length - 1;
    };
    var body = (bp && bp.body) || [];
    for (var i = 0; i < body.length; i++) visit(body[i], 'body[' + i + ']', 0, '', i);
    return rows;
  }

  /** 某个节点的第 i 个子位期望什么类型的子节点（stmt / bool / value） */
  function slotKindOf(nodeId, slotIndex) {
    var spec = specOf(nodeId);
    var kinds = spec && spec.inputs && spec.inputs.kinds;
    if (Array.isArray(kinds) && kinds[slotIndex]) return kinds[slotIndex];
    return 'stmt';
  }
  /** 某个节点最多能装几个子节点（<0 或未声明 = 不限） */
  function slotMaxOf(nodeId) {
    var spec = specOf(nodeId);
    var max = spec && spec.inputs ? spec.inputs.max : 0;
    if (max === undefined || max === null) return Array.isArray(spec && spec.inputs && spec.inputs.labels) ? 0 : 0;
    return max;
  }
  /** 类型兼容：语句位只收语句；条件位收 bool；数值位收 value */
  function kindFits(movingKind, wantKind) {
    if (!wantKind) return true;
    if (wantKind === 'stmt') return movingKind === 'stmt';
    return movingKind === wantKind;
  }

  /**
   * D-194：**枚举可插入位 + 锚点**（拖放吸附的唯一几何出处）。
   * @param {object} bp   蓝图
   * @param {string} kind 被拖动节点的类型（stmt / bool / value）
   * @param {object} opts {pitch, indentPx, movingAddr}
   * @returns {Array} [{parentAddr, index, indent, anchorY, anchorX, wantKind, where}]
   */
  function dropTargets(bp, kind, opts) {
    var o = opts || {};
    var pitch = num2(o.pitch, 28);
    var indPx = num2(o.indentPx, 16);
    var rows = treeRows(bp, '');
    var rowOf = {};
    rows.forEach(function (r, i) { if (r.addr) rowOf[r.addr] = i; });
    var endY = rows.length * pitch;
    var out = [];

    // ① 顶层（body）的同级插入位：index 0..len
    var body = (bp && bp.body) || [];
    for (var i = 0; i <= body.length; i++) {
      var anchorY = rowOf['body[' + i + ']'] !== undefined ? rowOf['body[' + i + ']'] * pitch : endY;
      if (!kindFits(kind, 'stmt')) continue;            // 顶层只收语句
      out.push({ parentAddr: '', index: i, indent: 0, anchorX: 0, anchorY: anchorY,
                 wantKind: 'stmt', where: 'body' });
    }

    // ② 每个容器的**子位追加位**（inputs 是定长子位数组：append 就是填下一个槽）
    //   锚点放在**该节点自己那一行**（用户口径："拖到节点上视为放进槽位"）——
    //   之前用"整棵子树之后"，块一大就把指针甩到几十行外，根本吸不上。
    rows.forEach(function (r, rowIdx) {
      if (r.rowKind !== 'node') return;
      var max = slotMaxOf(r.nodeId);
      var node = nodeAt(bp, r.addr);
      var len = node && Array.isArray(node.inputs) ? node.inputs.length : 0;
      if (max >= 0 && len >= max) return;               // 满了 → 没有候选（放不进就取消）
      var want = slotKindOf(r.nodeId, len);
      if (!kindFits(kind, want)) return;                // 类型不合 → 候选根本不存在
      out.push({
        parentAddr: r.addr, index: len, indent: r.depth + 1,
        anchorX: (r.depth + 1) * indPx,
        anchorY: rowIdx * pitch,                         // = 这一行所在的位置
        band: [rowIdx * pitch, (rowIdx + 1) * pitch],    // 这一行占据的纵向区间（用来判"拖到节点上"）
        wantKind: want, where: 'slot',
      });
    });

    // 拖已有节点时，不能放进自己的子树里（会成环）
    var moving = String(o.movingAddr || '');
    if (moving !== '') {
      out = out.filter(function (t) {
        return !(t.parentAddr === moving || t.parentAddr.indexOf(moving + '.inputs[') === 0);
      });
    }
    return out;
  }

  /**
   * D-195：**最近可插入位吸附**。
   * 判据（按用户口径"不光看上下，还要看缩进"）：
   *   · **纵向**决定是哪个落点（离某行越近越优先，容差 = 两行高）
   *   · **横向缩进**决定要落在第几层（`round(px / indentPx)`），层级权重 10（比 1px 的纵向差重要得多）
   * 早前的写法是"加权欧氏距离"，但行的宽度有 300+，指针落在行右半边时 x 差就有 100+，
   * 直接把所有候选都顶出阈值 ⇒ 拖了没反应。现在 x 只用来定层级，不再当成距离。
   * @returns {object|null} 命中的候选（附 score），或 null（不吸附 = 取消放置）
   */
  function nearestDrop(bp, pointer, opts) {
    var o = opts || {};
    var px = num2(pointer && pointer.x, 0), py = num2(pointer && pointer.y, 0);
    var pitch = num2(o.pitch, 24);
    var indPx = num2(o.indentPx, 16) || 16;
    var tolerance = o.threshold !== undefined ? num2(o.threshold, pitch * 2.5) : pitch * 2.5;
    var cands = dropTargets(bp, o.kind, o);
    if (!cands.length) return null;
    var wantDepth = Math.max(0, Math.round(px / indPx));
    // ① 先看"指针落在哪一行里" —— 落在节点行内 = 放进这个节点的槽位（用户口径：拖到节点上）
    var inBand = null;
    cands.forEach(function (t) {
      if (t.where !== 'slot' || !t.band) return;
      if (py >= t.band[0] && py < t.band[1]) inBand = t;
    });
    if (inBand) return Object.assign({}, inBand, { score: 0, hit: 'row', pitch: pitch });
    // ② 否则找最近的"两行之间"的插入位（用户口径：拖到两个节点之间 = 插入其之间）
    var best = null;
    cands.forEach(function (t) {
      if (t.where === 'slot') return;
      var dy = Math.abs(py - t.anchorY);
      if (dy > tolerance) return;                       // 太远：不吸附
      var score = dy + Math.abs((t.indent || 0) - wantDepth) * 10;
      if (!best || score < best.score) {
        best = Object.assign({}, t, { score: Math.round(score * 100) / 100, hit: 'gap', pitch: pitch });
      }
    });
    return best;
  }

  /** D-194：按命中的候选把节点放进去（顶层=插到 index；子位=填下一个槽） */
  function placeNode(bp, target, nodeObj) {
    if (!target) return clone(bp);
    if (target.where === 'body' || target.parentAddr === '') {
      var out = clone(bp);
      out.body = out.body || [];
      var idx = Math.max(0, Math.min(num2(target.index, out.body.length), out.body.length));
      out.body.splice(idx, 0, nodeObj);
      return normalizeUids(out);
    }
    return appendChild(bp, target.parentAddr, nodeObj);
  }

  function num2(v, d) { var n = Number(v); return isFinite(n) ? n : d; }

  // 表单模型：参数行（服务端目录的 params 直接映射为控件）
  function formOf(bp, addr) {
    var node = nodeAt(bp, addr);
    if (!node) return null;
    var spec = specOf(node.node);
    if (!spec) return null;
    var fields = [];
    var ps = spec.params || [];
    for (var i = 0; i < ps.length; i++) {
      fields.push({
        key: ps[i].key, label: ps[i].label, type: ps[i].type,
        values: ps[i].values || null, min: ps[i].min, max: ps[i].max,
        value: paramValue(node, ps[i].key),
        kind: ps[i].type === 'slot' ? 'slot' : (ps[i].type === 'enum' ? 'enum' : 'number'),
      });
    }
    return {
      addr: addr, node: node.node, name: spec.name, desc: spec.desc, quality: spec.quality,
      kind: spec.kind, fields: fields,
      inputLabels: (node.inputs || []).map(function (_, k) { return inputLabel(node.node, k); }),
      canAddInput: (function () {
        var specIn = spec.inputs || { max: 0 };
        return specIn.max < 0 || (node.inputs || []).length < specIn.max;
      })(),
    };
  }

  /* ================= 6. 服务端错误的定位 ================= */

  // 服务端错误 path 有两种：结构类 `body[0].inputs[1]`（直接是地址）；规则类 = 节点 uid → 二分查找成地址
  function addrOfError(bp, path) {
    var s = String(path || '');
    if (parseAddr(s)) return s;
    var hit = null;
    var visit = function (n, addr) {
      if (!n || hit) return;
      if (n.uid === s) { hit = addr; return; }
      var ins = Array.isArray(n.inputs) ? n.inputs : [];
      for (var i = 0; i < ins.length && !hit; i++) visit(ins[i], childAddr(addr, i));
    };
    var body = (bp && bp.body) || [];
    for (var i = 0; i < body.length && !hit; i++) visit(body[i], 'body[' + i + ']');
    return hit;
  }

  /* ================= 7. 导入导出 ================= */

  function exportText(bp) { return JSON.stringify(bp, null, 2); }

  // 导入 JSON：**只做结构预检**（能不能当蓝图用），不做合法性判决
  function importJson(text) {
    var obj;
    try {
      obj = JSON.parse(String(text));
    } catch (e) {
      return { ok: false, message: '不是合法 JSON：' + e.message };
    }
    if (!obj || typeof obj !== 'object' || obj.type !== 'blueprint') return { ok: false, message: '根必须是 {"type":"blueprint"}' };
    if (!Array.isArray(obj.body)) return { ok: false, message: 'body 必须是节点数组' };
    obj.version = obj.version || LIMITS.blueprintVersion || 1;
    var bad = null;
    walk(obj, function (n) {
      if (bad) return;
      if (typeof n.uid !== 'string' || n.uid === '') bad = '有节点缺 uid';
      else if (!specOf(n.node)) bad = '未知积木节点 ' + JSON.stringify(n.node);
      else if (!Array.isArray(n.inputs)) bad = '节点 ' + n.uid + ' 缺 inputs 数组';
    });
    if (bad) return { ok: false, message: bad };
    return { ok: true, blueprint: normalizeUids(obj) };
  }

  /* ================= 7. 编辑器左栏 / 错误行（给界面用的两份派生数据） ================= */

  // 节点库：目录 × 库存（GET /me/ai/nodes 的 inventory）→ 按类别分组的可点条目。
  //   `free<=0` 的条目**不隐藏**（玩家要看见"我还没拿到 / 已被别的 AI 占用"），只标 disabled。
  function nodeLibrary(inventory) {
    var inv = {};
    var list = Array.isArray(inventory) ? inventory : [];
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].nodeId) inv[list[i].nodeId] = list[i];
    var groups = [];
    var byCat = {};
    for (var j = 0; j < CATALOG.length; j++) {
      var spec = CATALOG[j];
      var row = inv[spec.id] || { owned: 0, used: 0, free: 0 };
      var item = {
        nodeId: spec.id, name: spec.name, quality: spec.quality, qualityLabel: QUALITY_LABELS[spec.quality] || spec.quality,
        kind: spec.kind, desc: spec.desc, category: spec.category,
        owned: row.owned || 0, used: row.used || 0, free: row.free || 0,
        disabled: (row.free || 0) <= 0,
      };
      var cat = CATEGORY_LABELS[spec.category] || spec.category;
      if (!byCat[cat]) { byCat[cat] = { category: cat, items: [] }; groups.push(byCat[cat]); }
      byCat[cat].items.push(item);
    }
    return groups;
  }

  // 服务端校验回执 → 可渲染的错误行：[{addr, path, code, message, onDraft}]
  //   `addr` 命中蓝图节点（结构类 path / 规则类 uid 两种都能定位）；未命中 → addr=null（只显示文字）
  function errorLines(bp, details) {
    var list = Array.isArray(details) ? details : [];
    return list.map(function (d) {
      var path = d && d.path !== undefined ? d.path : '';
      var addr = addrOfError(bp, path);
      return { addr: addr, path: path, code: d ? d.code : null, message: d ? d.message : '', onDraft: addr !== null };
    });
  }

  /* ================= 8. 运行高亮（积木层；管理员模式才看底层） ================= */
  // 运行时 trace 的每条 = {seq, path, nodeType, phase, result, depth}（单 tick 全量）。
  //   投影规则（D-178⑩）：`path` 经 AI 记录的 `traceMap` 映射到**积木节点 uid**；
  //   映射不到的一律**丢弃**（合成语句：记忆声明块、编译器自动补的 wait、以及表达式节点——
  //   表达式运行时不留 trace，故本来就不在表里）。玩家界面**只**看到积木节点。
  function projectTrace(trace, traceMap) {
    var list = Array.isArray(trace) ? trace : [];
    var map = traceMap && typeof traceMap === 'object' ? traceMap : {};
    var events = [];
    var dropped = 0;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object') continue;
      var uid = map[e.path];
      if (typeof uid !== 'string' || uid === '') { dropped += 1; continue; }
      events.push({ seq: e.seq, uid: uid, nodeType: e.nodeType, phase: e.phase, path: e.path });
    }
    return {
      events: events,
      current: events.length > 0 ? events[events.length - 1].uid : null,
      dropped: dropped,
    };
  }

  // 管理员/调试模式：原样给底层（完整 path + 未映射条目），供排障
  function rawTrace(trace) {
    var list = Array.isArray(trace) ? trace : [];
    return list.map(function (e) {
      return { seq: e ? e.seq : null, path: e ? e.path : null, nodeType: e ? e.nodeType : null, phase: e ? e.phase : null, depth: e ? e.depth : null };
    });
  }

  // 统一入口：`isAdmin` 决定看积木层还是看底层
  function highlightOf(trace, traceMap, isAdmin) {
    if (isAdmin === true) return { mode: 'admin', rows: rawTrace(trace), current: null, dropped: 0 };
    var p = projectTrace(trace, traceMap);
    return { mode: 'blueprint', rows: p.events, current: p.current, dropped: p.dropped };
  }

  return {
    // 目录
    setCatalog: setCatalog, catalog: catalog, specOf: specOf, limits: limits,
    inputLabel: inputLabel, categoryLabel: function (c) { return CATEGORY_LABELS[c] || c; },
    qualityLabel: function (q) { return QUALITY_LABELS[q] || q; },
    kindLabel: function (k) { return KIND_LABELS[k] || k; },
    // 构造
    emptyBlueprint: emptyBlueprint, clone: clone, nextUid: nextUid, newNode: newNode, normalizeUids: normalizeUids,
    // 地址
    parseAddr: parseAddr, parentAddrOf: parentAddrOf, childAddr: childAddr, nodeAt: nodeAt,
    replaceAt: replaceAt, removeAt: removeAt, insertAfter: insertAfter, appendChild: appendChild,
    moveAt: moveAt, setParam: setParam, paramValue: paramValue,
    // 统计 / 展示
    walk: walk, statsOf: statsOf, shortageOf: shortageOf, excludeOwnUsage: excludeOwnUsage,
    labelOf: labelOf, lineOf: lineOf, treeLines: treeLines, formOf: formOf,
    // D-194：拖放吸附（纯几何 + 类型过滤，产品与布局台共用）
    treeRows: treeRows, slotKindOf: slotKindOf, slotMaxOf: slotMaxOf, kindFits: kindFits,
    dropTargets: dropTargets, nearestDrop: nearestDrop, placeNode: placeNode,
    // 错误定位 / 导入导出 / 高亮 / 编辑器左栏
    addrOfError: addrOfError, exportText: exportText, importJson: importJson,
    projectTrace: projectTrace, rawTrace: rawTrace, highlightOf: highlightOf,
    nodeLibrary: nodeLibrary, errorLines: errorLines,
  };
});
