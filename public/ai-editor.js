'use strict';
/* public/ai-editor.js —— AI 编辑器核心（F5/D-172）：**纯数据**模块，不碰 DOM、不读响应字段、不发请求
 *
 * 职责（与 public/{store,format,render,actions}.js 的分工）：
 *   · 16 类节点的**目录**（中文标签、字段、枚举取值、动作词汇表、合法读取路径）——界面文案的唯一出处；
 *   · **编辑器地址**的解析/序列化与增删改（§4.3：`body.s[0].cond.right`）；
 *   · 程序树 → 文本行（带地址，供"选节点"）；
 *   · 当前节点的**表单模型**（字段 / 表达式槽 / 语句块）；
 *   · 导入 JSON 的解析与结构预检（**不做**合法性判决——那是服务端的事，D-172 ⑩）。
 *
 * ⚠️ 为什么需要"编辑器地址"而不是直接用运行时路径（`aiTrace[].path`）：
 *   `server/ai/runtime.js` 的 walkChildren 把节点的**所有表达式字段折叠成同一个 `.expr` 段**
 *   （`cmp.left` 与 `cmp.right` 得到完全相同的路径），照它定位会"改左边改到右边"。
 *   因此编辑器地址**把字段名写进地址**；运行时路径只用于"本帧执行"标记，且只标语句/结构节点。
 *
 * ⚠️ 本文件**不产生任何"合法/非法"判决**（唯一例外：函数重名，见 duplicateFunctionNames——
 *   用户裁决 ⑧ 要求编辑器直接禁止重名；其余一律由服务端 `POST /me/ai/validate` 裁决）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DL = root.DL || {}; root.DL.aiEditor = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ================= 1. 目录（中文标签） ================= */

  // 16 类节点的中文名（与 server/data/ai-nodes.json 的 nodes 逐值对应）
  var NODE_LABELS = Object.freeze({
    seq: '语句块', action: '动作', if: '如果', random: '随机', loop: '循环', break: '跳出循环',
    function: '函数定义', call: '调用函数', var: '声明变量', set: '赋值', getVar: '读变量',
    get: '读战场数据', literal: '常量', arith: '算术', cmp: '比较', logic: '逻辑',
  });
  var NODE_TYPES = Object.freeze(Object.keys(NODE_LABELS));

  // 语句块 / 表达式槽的结构（与 ast.js 的 childList/exprChildren 同规则）
  var BLOCK_FIELDS = Object.freeze({ seq: ['statements'], if: ['then', 'else'], random: ['then', 'else'], loop: ['body'], function: ['body'] });
  var EXPR_FIELDS_OF = Object.freeze({
    var: ['value'], set: ['value'],
    arith: ['left', 'right'], cmp: ['left', 'right'], logic: ['left', 'right'],
    random: ['prob'], if: ['cond'], loop: ['cond', 'times'],
  });
  var ALL_EXPR_FIELDS = Object.freeze(['value', 'left', 'right', 'cond', 'prob', 'times']);

  // 枚举取值（与 ast.js 的 FIELD_ENUMS 逐值一致）+ 中文标签
  var ENUM_SPECS = Object.freeze({
    'arith.op': [{ value: '+', label: '加 +' }, { value: '-', label: '减 -' }, { value: '*', label: '乘 *' }, { value: '/', label: '整除 /（向下取整）' }],
    'cmp.op': [{ value: '>', label: '大于 >' }, { value: '<', label: '小于 <' }, { value: '>=', label: '大于等于 >=' },
      { value: '<=', label: '小于等于 <=' }, { value: '==', label: '等于 ==（严格相等）' }, { value: '!=', label: '不等于 !=' }],
    'logic.op': [{ value: 'and', label: '并且 and（左侧为假则不评右侧）' }, { value: 'or', label: '或者 or（左侧为真则不评右侧）' }],
    'loop.kind': [{ value: 'count', label: '计次循环 count（按次数）' }, { value: 'while', label: '条件循环 while（每轮判条件）' }],
  });

  // 动作词汇表（引擎词汇表 + 三个技能槽键 `skill1..3`；共 10 项）
  var ACTION_VALUES = Object.freeze([
    { value: 'move_right', label: '右移（朝敌方推进）' },
    { value: 'move_left', label: '左移（朝己方后退）' },
    { value: 'dodge_right', label: '向右闪避' },
    { value: 'dodge_left', label: '向左闪避' },
    { value: 'defend', label: '防御（本帧减伤）' },
    { value: 'turn', label: '转身（只改朝向，不移动）' },
    { value: 'wait', label: '等待（什么都不做）' },
    { value: 'skill:skill1', label: '释放技能 1' },
    { value: 'skill:skill2', label: '释放技能 2' },
    { value: 'skill:skill3', label: '释放技能 3' },
  ]);

  // 合法读取路径（服务端白名单，见 ast.js 的 SNAPSHOT_*）——界面给中文标签，值必须是白名单里的原文
  var ACTOR_FIELDS = Object.freeze([
    { key: 'hp', label: '当前血量' }, { key: 'maxHp', label: '血量上限' },
    { key: 'mp', label: '当前法力' }, { key: 'maxMp', label: '法力上限' },
    { key: 'sp', label: '当前体力' }, { key: 'maxSp', label: '体力上限' },
    { key: 'atk', label: '攻击力' }, { key: 'def', label: '防御力' },
    { key: 'x', label: '位置（格序号，0 起）' }, { key: 'facing', label: '朝向（+1 右 / -1 左）' },
    { key: 'baseHp', label: '基地当前血量' },
  ]);
  var EFFECT_FIELDS = Object.freeze([
    { key: 'remaining', label: '剩余帧数' }, { key: 'kind', label: '效果种类' },
    { key: 'stat', label: '影响属性' }, { key: 'delta', label: '每帧增减' },
    { key: 'displacement', label: '位移格数' }, { key: 'uid', label: '效果编号' },
  ]);
  var BASE_FIELDS = Object.freeze([
    { key: 'hp', label: '基地当前血量' }, { key: 'maxHp', label: '基地血量上限' }, { key: 'def', label: '基地防御' },
  ]);

  function actorPaths(side, sideLabel) {
    var out = ACTOR_FIELDS.map(function (f) { return { value: side + '.' + f.key, label: sideLabel + '·' + f.label }; });
    out.push({ value: side + '.cooldowns.skill1', label: sideLabel + '·技能1 剩余冷却' });
    out.push({ value: side + '.cooldowns.skill2', label: sideLabel + '·技能2 剩余冷却' });
    out.push({ value: side + '.cooldowns.skill3', label: sideLabel + '·技能3 剩余冷却' });
    EFFECT_FIELDS.forEach(function (f) {
      out.push({ value: side + '.effects[0].' + f.key, label: sideLabel + '·第1个效果·' + f.label });
    });
    return out;
  }

  // 分组展示（界面按组渲染「读取项」按钮）
  var GET_PATH_GROUPS = Object.freeze([
    { label: '战场', paths: [{ value: 'tick', label: '当前帧数' }, { value: 'field.fieldPx', label: '战场宽度' }, { value: 'field.cellPx', label: '格子宽度' }] },
    { label: '自身', paths: actorPaths('self', '自身') },
    { label: '对手', paths: actorPaths('enemy', '对手') },
    {
      label: '基地',
      paths: BASE_FIELDS.map(function (f) { return { value: 'bases.self.' + f.key, label: '我方基地·' + f.label }; })
        .concat(BASE_FIELDS.map(function (f) { return { value: 'bases.enemy.' + f.key, label: '敌方基地·' + f.label }; })),
    },
  ]);
  function allGetPaths() {
    var out = [];
    GET_PATH_GROUPS.forEach(function (g) { g.paths.forEach(function (p) { out.push(p); }); });
    return out;
  }

  var LITERAL_TYPES = Object.freeze([
    { value: 'number', label: '数字' }, { value: 'string', label: '文本' }, { value: 'boolean', label: '真/假' },
  ]);

  /* ================= 2. 默认节点与空程序 ================= */

  function lit(v) { return { type: 'literal', value: v }; }
  function get(p) { return { type: 'get', path: p }; }
  function act(n) { return { type: 'action', name: n }; }
  function seq(list) { return { type: 'seq', statements: list || [] }; }
  function cmpLt(left, right) { return { type: 'cmp', op: '<', left: left, right: right }; }

  // 新建节点的默认值：**尽量天生合法**（含 action 的分支 / random 必带 else），避免用户一插入就报错
  function defaultNodeOf(type) {
    if (type === 'seq') return seq([]);
    if (type === 'action') return act('move_right');
    if (type === 'if') return { type: 'if', cond: cmpLt(get('self.hp'), lit(30)), then: seq([act('defend')]), else: seq([act('wait')]) };
    if (type === 'random') return { type: 'random', prob: lit(0.5), then: seq([act('move_right')]), else: seq([act('wait')]) };
    if (type === 'loop') return { type: 'loop', kind: 'count', times: lit(3), body: seq([act('wait')]) };
    if (type === 'break') return { type: 'break' };
    if (type === 'function') return { type: 'function', name: 'myFunc', body: seq([act('wait')]) };
    if (type === 'call') return { type: 'call', name: 'myFunc' };
    if (type === 'var') return { type: 'var', name: 'x', value: lit(0) };
    if (type === 'set') return { type: 'set', name: 'x', value: lit(0) };
    if (type === 'getVar') return { type: 'getVar', name: 'x' };
    if (type === 'get') return get('self.hp');
    if (type === 'literal') return lit(0);
    if (type === 'arith') return { type: 'arith', op: '+', left: lit(0), right: lit(1) };
    if (type === 'cmp') return cmpLt(get('self.hp'), lit(30));
    if (type === 'logic') return { type: 'logic', op: 'and', left: cmpLt(get('self.hp'), lit(50)), right: cmpLt(get('enemy.x'), get('self.x')) };
    return seq([]);
  }

  // 空程序（「新建 AI」的初始草稿）：一个"等待"动作，天生合法、且能立刻保存
  function emptyProgram() {
    return { type: 'program', version: 2, body: seq([act('wait')]) };
  }
  function cloneProgram(p) {
    return p === null || p === undefined ? null : JSON.parse(JSON.stringify(p));
  }

  /* ================= 3. 编辑器地址 ================= */

  // 地址 = `body` + 若干步：`.s[i]` | `.then` | `.else` | `.body` | `.value/.left/.right/.cond/.prob/.times`
  var STEP_RE = /^(s\[\d+\]|then|else|body|value|left|right|cond|prob|times)$/;

  function normalizeAddr(addr) {
    var a = addr === undefined || addr === null ? '' : String(addr);
    if (a === '') return 'body';
    return a;
  }
  function parseAddr(addr) {
    var a = normalizeAddr(addr);
    var parts = a.split('.');
    return { root: parts[0], steps: parts.slice(1) };
  }
  function isIndexStep(seg) { return /^s\[\d+\]$/.test(seg); }
  function indexOfStep(seg) { return Number(/^s\[(\d+)\]$/.exec(seg)[1]); }
  function parentAddrOf(addr) {
    var a = normalizeAddr(addr);
    if (a === 'body') return null;
    var i = a.lastIndexOf('.');
    return i < 0 ? null : a.slice(0, i);
  }
  function lastStepOf(addr) {
    var a = normalizeAddr(addr);
    if (a === 'body') return null;
    var i = a.lastIndexOf('.');
    return i < 0 ? null : a.slice(i + 1);
  }
  function childAddr(addr, step) { return normalizeAddr(addr) + '.' + step; }

  function stepInto(node, step) {
    if (!node || typeof node !== 'object') return null;
    if (isIndexStep(step)) {
      var list = Array.isArray(node.statements) ? node.statements : null;
      return list ? (list[indexOfStep(step)] === undefined ? null : list[indexOfStep(step)]) : null;
    }
    if (step === 'then' || step === 'else' || step === 'body') return node[step] === undefined ? null : node[step];
    if (ALL_EXPR_FIELDS.indexOf(step) >= 0) return node[step] === undefined ? null : node[step];
    return null;
  }

  function nodeAt(program, addr) {
    if (!program || typeof program !== 'object') return null;
    var a = normalizeAddr(addr);
    var parsed = parseAddr(a);
    if (parsed.root !== 'body') return null;
    var cur = program.body;
    for (var i = 0; i < parsed.steps.length; i += 1) {
      if (!STEP_RE.test(parsed.steps[i])) return null;
      cur = stepInto(cur, parsed.steps[i]);
      if (cur === null || cur === undefined) return null;
    }
    return cur === undefined ? null : cur;
  }

  // 写回：`s[i]` 走数组下标，其余走字段
  function writeStep(parent, step, value) {
    if (!parent || typeof parent !== 'object') return false;
    if (isIndexStep(step)) {
      if (!Array.isArray(parent.statements)) return false;
      parent.statements[indexOfStep(step)] = value;
      return true;
    }
    parent[step] = value;
    return true;
  }
  function setAt(program, addr, node) {
    var a = normalizeAddr(addr);
    if (a === 'body') { program.body = node; return true; }
    var parent = nodeAt(program, parentAddrOf(a));
    if (!parent) return false;
    return writeStep(parent, lastStepOf(a), node);
  }

  // 父容器信息（结构操作都要用）：{ kind:'list', list, index } | { kind:'field', parent, field }
  function containerOf(program, addr) {
    var a = normalizeAddr(addr);
    if (a === 'body') return { kind: 'root' };
    var parentAddr = parentAddrOf(a);
    var step = lastStepOf(a);
    var parent = nodeAt(program, parentAddr);
    if (!parent) return null;
    if (isIndexStep(step)) {
      if (!Array.isArray(parent.statements)) return null;
      return { kind: 'list', parentAddr: parentAddr, list: parent.statements, index: indexOfStep(step) };
    }
    return { kind: 'field', parentAddr: parentAddr, parent: parent, field: step };
  }

  function isStatementAddr(addr) {
    var c = lastStepOf(addr);
    return c !== null && isIndexStep(c);
  }
  function isExprAddr(addr) {
    var c = lastStepOf(addr);
    return c !== null && ALL_EXPR_FIELDS.indexOf(c) >= 0;
  }

  /* ---- 结构操作（全部只改传入的程序对象，返回 true/false） ---- */

  // 在"其后插入同级语句"：仅对 `…s[i]` 有效
  function insertAfter(program, addr, type) {
    var c = containerOf(program, addr);
    if (!c || c.kind !== 'list') return false;
    c.list.splice(c.index + 1, 0, defaultNodeOf(type || 'action'));
    return true;
  }
  // 往块里追加语句：块可能是 seq（有 statements）或单个节点（会被包成 seq）
  function appendIntoBlock(program, blockAddr, type) {
    var node = nodeAt(program, blockAddr);
    var fresh = defaultNodeOf(type || 'action');
    if (!node) {
      return setAt(program, blockAddr, seq([fresh]));
    }
    if (node.type === 'seq' && Array.isArray(node.statements)) {
      node.statements.push(fresh);
      return true;
    }
    // 块里只有一个非 seq 节点 → 包成 seq（保持原节点在前）
    return setAt(program, blockAddr, seq([node, fresh]));
  }
  function removeNode(program, addr) {
    var a = normalizeAddr(addr);
    if (a === 'body') return false; // 隐式主循环根节点：不可删除
    var c = containerOf(program, a);
    if (!c) return false;
    if (c.kind === 'list') { c.list.splice(c.index, 1); return true; }
    if (c.kind === 'field') {
      if (c.field === 'else') { delete c.parent.else; return true; }        // else 可缺省
      if (c.field === 'then' || c.field === 'body' || ALL_EXPR_FIELDS.indexOf(c.field) >= 0) {
        c.parent[c.field] = null;                                            // 置空（由界面提示"未填写"）
        return true;
      }
    }
    return false;
  }
  function moveNode(program, addr, delta) {
    var c = containerOf(program, addr);
    if (!c || c.kind !== 'list') return false;
    var to = c.index + (delta < 0 ? -1 : 1);
    if (to < 0 || to >= c.list.length) return false;
    var tmp = c.list[c.index];
    c.list[c.index] = c.list[to];
    c.list[to] = tmp;
    return true;
  }
  function replaceNode(program, addr, type) {
    return setAt(program, addr, defaultNodeOf(type));
  }
  // 包裹进 if：把选中语句变成 `if (条件) { 原语句 } else { 等待 }`
  function wrapInIf(program, addr) {
    var node = nodeAt(program, addr);
    if (!node) return false;
    var fresh = defaultNodeOf('if');
    fresh.then = seq([node]);
    return setAt(program, addr, fresh);
  }

  /* ================= 4. 节点摘要文本（中文） ================= */

  function literalText(value) {
    if (value === undefined) return '（未填）';
    if (typeof value === 'string') return '「' + value + '」';
    if (value === null) return 'null';
    try { return String(JSON.stringify(value)); } catch (e) { return '（无法显示）'; }
  }
  function exprText(node) {
    if (!node || typeof node !== 'object') return '（未填）';
    var t = node.type;
    if (t === 'literal') return literalText(node.value);
    if (t === 'get') return String(node.path === undefined ? '（未填）' : node.path);
    if (t === 'getVar') return '变量 ' + String(node.name === undefined ? '?' : node.name);
    if (t === 'arith' || t === 'cmp' || t === 'logic') {
      return '(' + exprText(node.left) + ' ' + String(node.op === undefined ? '?' : node.op) + ' ' + exprText(node.right) + ')';
    }
    if (t === 'random') return '随机(' + exprText(node.prob) + ')';
    if (t === 'call') return '调用 ' + String(node.name === undefined ? '?' : node.name) + '()';
    return NODE_LABELS[t] || String(t === undefined ? '未知节点' : t);
  }
  function nodeSummary(node) {
    if (!node || typeof node !== 'object') return '（未填）';
    var t = node.type;
    if (t === 'action') return '动作 ' + String(node.name === undefined ? '?' : node.name);
    if (t === 'if') return '如果 ' + exprText(node.cond);
    if (t === 'random') return '随机 概率 ' + exprText(node.prob);
    if (t === 'loop') {
      if (node.kind === 'count') return '循环 计次 ' + exprText(node.times) + ' 次';
      return '循环 当 ' + exprText(node.cond);
    }
    if (t === 'function') return '函数 ' + String(node.name === undefined ? '?' : node.name);
    if (t === 'call') return '调用 ' + String(node.name === undefined ? '?' : node.name) + '()';
    if (t === 'var') return '声明 ' + String(node.name === undefined ? '?' : node.name) + ' = ' + exprText(node.value);
    if (t === 'set') return '赋值 ' + String(node.name === undefined ? '?' : node.name) + ' = ' + exprText(node.value);
    if (t === 'break') return '跳出循环';
    if (t === 'seq') return '语句块（' + (Array.isArray(node.statements) ? node.statements.length : 0) + ' 条）';
    return (NODE_LABELS[t] || String(t)) + ' ' + exprText(node);
  }

  /* ================= 5. 程序树 → 带地址的文本行 ================= */

  var MAX_LINES = 400;   // 与 format.js 的树渲染同量级上限（防超大程序把界面撑爆）
  var MAX_DEPTH = 24;

  // 返回 [{ addr, depth, kind:'root'|'stmt'|'expr'|'block-label', text, nodeType }]
  function treeLines(program) {
    var out = [];
    function push(addr, depth, kind, text, nodeType) {
      if (out.length >= MAX_LINES) return;
      out.push({ addr: addr, depth: depth, kind: kind, text: text, nodeType: nodeType === undefined ? null : nodeType });
    }
    function walkStatements(list, baseAddr, depth) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i += 1) {
        walkNode(list[i], baseAddr + '.s[' + i + ']', depth);
      }
    }
    function walkNode(node, addr, depth) {
      if (out.length >= MAX_LINES) return;
      if (depth > MAX_DEPTH) { push(addr, depth, 'block-label', '…（层级过深，不再展开）', null); return; }
      if (!node || typeof node !== 'object') { push(addr, depth, 'stmt', '（未填）', null); return; }
      var t = node.type;
      if (t === 'seq') { walkStatements(node.statements, addr, depth); return; }
      push(addr, depth, 'stmt', nodeSummary(node), t);
      if (t === 'if' || t === 'random') {
        push(addr + '.cond', depth + 1, 'expr', (t === 'if' ? '条件：' : '概率：') + exprText(t === 'if' ? node.cond : node.prob), t === 'if' ? 'cond' : null);
        push(addr + '.then', depth + 1, 'block-label', '那么：', null);
        walkNode(node.then, addr + '.then', depth + 2);
        if (node.else !== undefined && node.else !== null) {
          push(addr + '.else', depth + 1, 'block-label', '否则：', null);
          walkNode(node.else, addr + '.else', depth + 2);
        }
        return;
      }
      if (t === 'loop') {
        var kf = node.kind === 'count' ? 'times' : 'cond';
        push(addr + '.' + kf, depth + 1, 'expr', (kf === 'times' ? '次数：' : '条件：') + exprText(node[kf]), kf);
        push(addr + '.body', depth + 1, 'block-label', '循环体：', null);
        walkNode(node.body, addr + '.body', depth + 2);
        return;
      }
      if (t === 'function') {
        push(addr + '.body', depth + 1, 'block-label', '函数体：', null);
        walkNode(node.body, addr + '.body', depth + 2);
        return;
      }
      // 其余：把表达式字段各出一行（可点选编辑）
      (EXPR_FIELDS_OF[t] || []).forEach(function (f) {
        if (node[f] === undefined || node[f] === null) return;
        push(addr + '.' + f, depth + 1, 'expr', fieldLabelOf(f) + '：' + exprText(node[f]), f);
      });
    }
    if (!program || typeof program !== 'object' || !program.body) return out;
    walkStatements(program.body.statements, 'body', 0);
    return out;
  }

  function fieldLabelOf(key) {
    return { value: '值', left: '左', right: '右', cond: '条件', prob: '概率', times: '次数' }[key] || key;
  }

  // 运行时路径 → 编辑器地址（去掉尾部的表达式字段步；用于"本帧执行"标记）
  //   `body.s[0].then.s[1]` 原样；`…expr` 一律映射到**该节点的所有表达式槽**（返回 null 表示"整节点"）
  function runtimePathOfAddr(addr) {
    var parts = normalizeAddr(addr).split('.');
    while (parts.length > 1 && ALL_EXPR_FIELDS.indexOf(parts[parts.length - 1]) >= 0) parts.pop();
    return parts.join('.');
  }

  /* ================= 6. 表单模型（当前节点） ================= */

  function optionsOf(key, specs) { return specs ? specs.map(function (o) { return { value: o.value, label: o.label }; }) : []; }

  // 返回 { addr, type, typeLabel, isRoot, isStatement, isExpr, fields[], slots[], blocks[], hints[] }
  function formOf(program, addr) {
    var a = normalizeAddr(addr);
    var node = nodeAt(program, a);
    var isRoot = a === 'body';
    if (!node || typeof node !== 'object') {
      return { addr: a, type: null, typeLabel: '（未填写）', isRoot: isRoot, isStatement: isStatementAddr(a) || isRoot, isExpr: isExprAddr(a), fields: [], slots: [], blocks: [], hints: ['该位置还没有内容：用下面的「插入」按钮添加一个节点。'] };
    }
    var t = node.type;
    var fields = [];
    var slots = [];
    var blocks = [];
    var hints = [];

    // ① 自身字段
    if (t === 'action') fields.push({ key: 'name', label: '执行动作', kind: 'action', value: String(node.name === undefined ? '' : node.name), options: optionsOf('action', ACTION_VALUES) });
    if (t === 'get') fields.push({ key: 'path', label: '读取项', kind: 'path', value: String(node.path === undefined ? '' : node.path), groups: GET_PATH_GROUPS });
    if (t === 'getVar') fields.push({ key: 'name', label: '变量名', kind: 'text', value: String(node.name === undefined ? '' : node.name) });
    if (t === 'var' || t === 'set') fields.push({ key: 'name', label: '变量名', kind: 'text', value: String(node.name === undefined ? '' : node.name) });
    if (t === 'function' || t === 'call') fields.push({ key: 'name', label: '函数名', kind: 'text', value: String(node.name === undefined ? '' : node.name) });
    if (t === 'literal') {
      fields.push({ key: 'value', label: '值', kind: 'literal', value: literalInputOf(node.value), literalType: literalKindOf(node.value), options: LITERAL_TYPES });
    }
    if (t === 'arith' || t === 'cmp' || t === 'logic') {
      var spec = ENUM_SPECS[t + '.op'];
      fields.push({ key: 'op', label: '运算符', kind: 'enum', value: String(node.op === undefined ? '' : node.op), options: optionsOf(t + '.op', spec) });
    }
    if (t === 'loop') {
      var kspec = ENUM_SPECS['loop.kind'];
      fields.push({ key: 'kind', label: '循环类型', kind: 'enum', value: String(node.kind === undefined ? '' : node.kind), options: optionsOf('loop.kind', kspec) });
      hints.push('计次循环的「次数」只在进入循环时算一次；条件循环每轮都重新判断条件。');
    }
    if (t === 'random') {
      hints.push(nodeHintsForRandom());
    }
    if (t === 'if') hints.push('「否则」可以留空（留空表示条件不成立时什么都不做）。');
    if (t === 'break') hints.push('「跳出循环」只能放在循环体内，会直接结束最近的一层循环。');
    if (t === 'function') hints.push('函数没有参数、也没有返回值；内部声明的变量不会影响外面。函数定义本身不执行，只登记名字。');
    if (t === 'call') hints.push('调用的函数必须在程序里定义过（可以先调用后定义）。');

    // ② 表达式槽（子节点）
    (EXPR_FIELDS_OF[t] || []).forEach(function (f) {
      if (t === 'loop' && ((node.kind === 'count' && f === 'cond') || (node.kind !== 'count' && f === 'times'))) return;
      var child = node[f];
      var has = child !== undefined && child !== null && typeof child === 'object';
      slots.push({
        key: f, label: fieldLabelOf(f), addr: a + '.' + f, present: has,
        summary: has ? exprText(child) : '（未填写）',
        typeLabel: has ? (NODE_LABELS[child.type] || String(child.type)) : null,
        canWrap: false, canDelete: has,
      });
    });

    // ③ 语句块（子节点）
    (BLOCK_FIELDS[t] || []).forEach(function (f) {
      if (f === 'statements') return; // seq 的子语句由"插入语句"按钮管理
      if (f === 'else' && (node.else === undefined || node.else === null) && t === 'if') {
        blocks.push({ key: f, label: '否则', addr: a + '.else', present: false, count: 0, canRemove: false });
        return;
      }
      var blk = node[f];
      var present = blk !== undefined && blk !== null && typeof blk === 'object';
      blocks.push({
        key: f, label: fieldLabelOf(f) === f ? (f === 'then' ? '那么' : f === 'else' ? '否则' : '循环体') : fieldLabelOf(f),
        addr: a + '.' + f, present: present,
        count: present && Array.isArray(blk.statements) ? blk.statements.length : (present ? 1 : 0),
        canRemove: f === 'else' && t === 'if' && present,
      });
    });

    return {
      addr: a, type: t, typeLabel: NODE_LABELS[t] || String(t),
      isRoot: isRoot, isStatement: isStatementAddr(a) || isRoot, isExpr: isExprAddr(a),
      fields: fields, slots: slots, blocks: blocks, hints: hints,
      duplicateFunction: t === 'function' && duplicateFunctionNames(program).some(function (d) { return d.name === node.name; }),
    };
  }

  function nodeHintsForRandom() {
    return '「随机」按位置有两种含义：放在语句位置 = 概率分支（真的执行「那么」或「否则」）；放在条件/数值位置 = 取真假（只按概率，不执行分支）。';
  }

  function literalKindOf(v) {
    if (typeof v === 'number') return 'number';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'string') return 'string';
    return 'number';
  }
  function literalInputOf(v) {
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    try { return String(JSON.stringify(v)); } catch (e) { return ''; }
  }
  // 文本 → 值（按所选类型解析；解析不了就用兜底值，界面会提示——合法性仍由服务端裁决）
  function parseTypedField(kind, text, extra) {
    if (kind === 'literal') {
      var lt = extra && extra.literalType ? extra.literalType : 'number';
      if (lt === 'number') {
        var n = Number(String(text).trim());
        return isFinite(n) ? n : 0;
      }
      if (lt === 'boolean') return String(text).trim() === 'true';
      return String(text);
    }
    return String(text);
  }

  /* ================= 7. 重名函数（唯一的前端判决，用户裁决 ⑧） ================= */

  function walkAll(node, addr, cb) {
    if (!node || typeof node !== 'object') return;
    cb(node, addr);
    if (node.type === 'seq' && Array.isArray(node.statements)) {
      node.statements.forEach(function (c, i) { walkAll(c, addr + '.s[' + i + ']', cb); });
    }
    ['then', 'else', 'body'].forEach(function (k) { if (node[k]) walkAll(node[k], addr + '.' + k, cb); });
    ALL_EXPR_FIELDS.forEach(function (k) { if (node[k] && typeof node[k] === 'object') walkAll(node[k], addr + '.' + k, cb); });
  }
  // 返回重复定义的函数名（每个名字一条；用于界面红字提示 + 禁止保存）
  function duplicateFunctionNames(program) {
    if (!program || typeof program !== 'object' || !program.body) return [];
    var seen = Object.create(null);
    var dups = Object.create(null);
    walkAll(program.body, 'body', function (n, addr) {
      if (n.type !== 'function' || typeof n.name !== 'string') return;
      if (seen[n.name]) { if (!dups[n.name]) dups[n.name] = { name: n.name, addrs: [seen[n.name], addr] }; else dups[n.name].addrs.push(addr); return; }
      seen[n.name] = addr;
    });
    return Object.keys(dups).map(function (k) { return dups[k]; });
  }

  function collectNames(program, type) {
    var out = [];
    if (!program || typeof program !== 'object' || !program.body) return out;
    walkAll(program.body, 'body', function (n) { if (n.type === type && typeof n.name === 'string' && out.indexOf(n.name) < 0) out.push(n.name); });
    return out;
  }
  function collectFunctionNames(program) { return collectNames(program, 'function'); }
  function collectVarNames(program) { return collectNames(program, 'var'); }

  // 插入/替换后按**当前程序**补齐默认名（否则"插入一个 call"必然立刻报 unknown_call）：
  //   · `call` → 若默认名不在已定义函数里，改用第一个已定义函数名（程序里一个函数都没有时保持默认，
  //     由界面的校验错误提示用户"先定义一个函数"）；
  //   · `getVar`/`set` → 同理改用第一个已声明的变量名（否则立刻 undefined_var）。
  function contextualizeNode(program, addr) {
    var node = nodeAt(program, addr);
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'call') {
      var fns = collectFunctionNames(program);
      if (fns.length > 0 && fns.indexOf(node.name) < 0) node.name = fns[0];
      return true;
    }
    if (node.type === 'getVar' || node.type === 'set') {
      var vars = collectVarNames(program);
      if (vars.length > 0 && vars.indexOf(node.name) < 0) node.name = vars[0];
      return true;
    }
    return true;
  }

  // 服务端校验错误里的 `path`（形如 `body.s[1].cond` / `body.s[1].op` / `body.s[1].expr` /
  //   `body.s[0].then` / `body.s[2].body`）→ 编辑器地址：**逐级回退**直到能解析出一个节点。
  //   用途：校验错误行的「定位」按钮（裁决 ⑨：错误要能点到具体节点）。
  var WRAPPER_STEPS = ['path', 'op', 'kind', 'name', 'value', 'expr', 'left', 'right', 'cond', 'prob', 'times', 'statements'];
  function addrOfRuntimeErrorPath(program, errorPath) {
    var p = String(errorPath === undefined || errorPath === null ? '' : errorPath);
    if (p === '') return 'body';
    var candidates = [p];
    var parts = p.split('.');
    while (parts.length > 1) {
      parts.pop();
      candidates.push(parts.join('.'));
    }
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i] === 'body') return 'body';
      if (nodeAt(program, candidates[i])) return candidates[i];
    }
    return 'body';
  }

  // 该错误是否落在表达式位上（用于文案："这一项要求填一个表达式"）
  function isExprErrorPath(errorPath) {
    var parts = String(errorPath === undefined ? '' : errorPath).split('.');
    var last = parts[parts.length - 1];
    return last === 'expr' || ALL_EXPR_FIELDS.indexOf(last) >= 0;
  }

  /* ================= 8. 导入 JSON（结构预检；合法性由服务端裁决） ================= */

  function importProgram(text) {
    var raw = String(text === undefined || text === null ? '' : text).trim();
    if (raw === '') return { ok: false, error: '请先粘贴 AI 程序的 JSON 内容。' };
    var parsed = null;
    try { parsed = JSON.parse(raw); } catch (e) { return { ok: false, error: '不是合法的 JSON：' + (e && e.message ? e.message : '解析失败') }; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'JSON 顶层必须是一个对象（形如 {"type":"program",...}）。' };
    if (parsed.type !== 'program') return { ok: false, error: '顶层 type 必须是 "program"。' };
    if (!parsed.body || typeof parsed.body !== 'object') return { ok: false, error: '缺少 body（程序主体）。' };
    return { ok: true, program: parsed };
  }
  function exportProgramText(program) {
    try { return JSON.stringify(program, null, 2); } catch (e) { return ''; }
  }

  // 输入框字段名 `ai.<编辑器地址>.<字段键>` → { addr, key }
  //   地址本身含点与方括号（如 `body.s[1].cond`），故**字段键一律取最后一段**。
  //   返回 null 表示不是合法的 AI 字段名（调用方据此忽略）。
  function parseFieldName(field) {
    var f = String(field === undefined || field === null ? '' : field);
    if (f.indexOf('ai.') !== 0) return null;
    var rest = f.slice(3);
    var i = rest.lastIndexOf('.');
    if (i <= 0) return null;
    var addr = rest.slice(0, i);
    var key = rest.slice(i + 1);
    if (key === '') return null;
    if (addr !== 'body' && !/^body(\.|$)/.test(addr)) return null;
    return { addr: addr, key: key };
  }

  // 该字段在节点上属于哪一类（决定提交时怎么解析文本）
  function fieldKindOf(node, key) {
    if (!node || typeof node !== 'object') return 'text';
    if (key === 'value' && node.type === 'literal') return 'literal';
    return 'text';
  }

  return {
    NODE_LABELS: NODE_LABELS,
    NODE_TYPES: NODE_TYPES,
    ENUM_SPECS: ENUM_SPECS,
    ACTION_VALUES: ACTION_VALUES,
    GET_PATH_GROUPS: GET_PATH_GROUPS,
    LITERAL_TYPES: LITERAL_TYPES,
    defaultNodeOf: defaultNodeOf,
    emptyProgram: emptyProgram,
    cloneProgram: cloneProgram,
    normalizeAddr: normalizeAddr,
    parentAddrOf: parentAddrOf,
    lastStepOf: lastStepOf,
    childAddr: childAddr,
    nodeAt: nodeAt,
    setAt: setAt,
    insertAfter: insertAfter,
    appendIntoBlock: appendIntoBlock,
    removeNode: removeNode,
    moveNode: moveNode,
    replaceNode: replaceNode,
    wrapInIf: wrapInIf,
    isStatementAddr: isStatementAddr,
    isExprAddr: isExprAddr,
    containerOf: containerOf,
    exprText: exprText,
    nodeSummary: nodeSummary,
    treeLines: treeLines,
    runtimePathOfAddr: runtimePathOfAddr,
    formOf: formOf,
    fieldLabelOf: fieldLabelOf,
    parseTypedField: parseTypedField,
    literalKindOf: literalKindOf,
    literalInputOf: literalInputOf,
    duplicateFunctionNames: duplicateFunctionNames,
    addrOfRuntimeErrorPath: addrOfRuntimeErrorPath,
    isExprErrorPath: isExprErrorPath,
    collectFunctionNames: collectFunctionNames,
    collectVarNames: collectVarNames,
    contextualizeNode: contextualizeNode,
    allGetPaths: allGetPaths,
    importProgram: importProgram,
    exportProgramText: exportProgramText,
    parseFieldName: parseFieldName,
    fieldKindOf: fieldKindOf,
  };
});
