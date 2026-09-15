'use strict';
// F6 editor 测试 —— frontend-spec §6.2（bridge 后端 AST 往返矩阵 / 真实错误路径高亮 / toolbox 门控 / editorLayout /
// createEditor+presetLoop 注入流 / 兜底）+ ★F6 审查 P1 回归锁（方言→后端契约、门控键、高亮调用点、根循环真预置）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const FIXTURES = require('../fixtures/ai-programs.json');

// 供路径断言：收集积木 id → 积木
function collect(root) {
  const map = new Map();
  const walk = (b) => {
    if (!b || typeof b !== 'object' || map.has(b.id)) return;
    map.set(b.id, b);
    if (b.next && b.next.block) walk(b.next.block);
    for (const k of Object.keys(b.inputs || {})) {
      const slot = b.inputs[k];
      if (slot && slot.block) walk(slot.block);
    }
  };
  walk(root);
  return map;
}

const MYTHIC_NODES = ['seq', 'literal', 'get', 'bullets', 'var', 'set', 'getVar', 'arith', 'cmp', 'action',
  'if', 'loop', 'while', 'break', 'random', 'logic', 'arith_ext', 'function', 'call']; // unlock.json 累计（19 键）
const RARE_NODES = MYTHIC_NODES.filter((n) => !['random', 'logic', 'arith_ext', 'function', 'call'].includes(n));

test('bridge：真实后端程序（ai-programs 全 fixture）→ toBlocks → toAst 逐程序深等往返 + 空/畸形安全', async () => {
  const { toBlocks, toAst, AST_VERSION } = await import('../../public/js/editor/bridge.js');
  const names = Object.keys(FIXTURES);
  assert.ok(names.length >= 6, 'fixture 全量');
  for (const name of names) {
    const program = FIXTURES[name].program;
    const blocks = toBlocks(program);
    assert.equal(blocks.type, 'loop_forever', `${name}: 根为 D-100 显式主循环`);
    const round = toAst(blocks);
    assert.equal(round.type, 'program');
    assert.equal(round.version, AST_VERSION);
    assert.equal(round.body.type, 'seq');
    assert.deepEqual(round, { ...program, version: AST_VERSION }, `${name} 全类型往返深等（16 节点词表）`);
  }
  // 空/畸形安全
  assert.equal(toBlocks(null), null);
  assert.equal(toBlocks(undefined), null);
  const emptyRoot = toBlocks({});
  assert.equal(emptyRoot.type, 'loop_forever');
  assert.equal(emptyRoot.inputs.body0, null, '空程序 → 空循环体');
  assert.deepEqual(toAst(null), { type: 'program', version: AST_VERSION, body: { type: 'seq', statements: [] } });
  assert.deepEqual(toAst({ type: 'bogus' }), { type: 'program', version: AST_VERSION, body: { type: 'seq', statements: [] } }, '未知语句跳过');
  const unk = toBlocks({ body: { type: 'seq', statements: [{ nonsense: 1 }, null] } });
  assert.equal(unk.inputs.body0, null, '未知语句不产块');
});

test('bridge：findBlockByPath 对真实后端 details.path 形态逐段命中（body.s[i]/then/else/body/expr）+ 未找到 null', async () => {
  const { toBlocks, findBlockByPath } = await import('../../public/js/editor/bridge.js');
  const root = toBlocks(FIXTURES.coverageProgram.program);
  const blocks = collect(root);
  // 期望块类型（coverageProgram 语句序：0 literal 1 var 2 set 3 get 4 bullets 5 cmp 6 logic 7 random 8 if
  //   9 loop(count) 10 loop(while) 11 action 12 function 13 call 14 action）
  const cases = [
    ['body.s[0]', 'num'],
    ['body.s[1]', 'var'],
    ['body.s[1].expr', 'num'],
    ['body.s[2].expr', 'arith'],
    ['body.s[3]', 'get'],
    ['body.s[4]', 'bullets'],
    ['body.s[5]', 'cmp'],
    ['body.s[6]', 'logic'],
    ['body.s[7]', 'random'],
    ['body.s[7].then.s[0]', 'action'],
    ['body.s[7].else.s[0]', 'action'],
    ['body.s[8]', 'if'],
    ['body.s[8].then', 'action'],
    ['body.s[8].expr', 'cmp'],
    ['body.s[9]', 'loop_count'],
    ['body.s[9].expr', 'num'],
    ['body.s[9].body.s[0]', 'action'],
    ['body.s[9].body.s[1]', 'break'],
    ['body.s[10]', 'loop_forever'],
    ['body.s[10].expr', 'loop_forever'], // while(true) 的 cond 为桥合成（块上无 num 输入）→ 指向循环块本身
    ['body.s[10].body.s[0]', 'action'],
    ['body.s[11]', 'action'],
    ['body.s[12]', 'function'],
    ['body.s[12].body', 'action'],
    ['body.s[12].body.s[0]', 'action'],
    ['body.s[13]', 'call'],
    ['body', 'loop_forever'],
  ];
  for (const [p, type] of cases) {
    const id = findBlockByPath(root, p);
    assert.ok(id, `${p} 命中`);
    assert.equal(blocks.get(id).type, type, `${p} → ${type}`);
  }
  // 深路径（a5Function：函数体内 if 的 then/else）
  const rootA5 = toBlocks(FIXTURES.a5Function.program);
  assert.equal(collect(rootA5).get(findBlockByPath(rootA5, 'body.s[1].body.s[1].then.s[0]')).type, 'action');
  assert.equal(collect(rootA5).get(findBlockByPath(rootA5, 'body.s[1].body.s[1].else.s[0]')).type, 'action');
  // 未找到 → null（越界/未知段/无 body 前缀/非字符串/空）
  assert.equal(findBlockByPath(root, 'body.s[99]'), null);
  assert.equal(findBlockByPath(root, 'body.s[0].wat'), null);
  assert.equal(findBlockByPath(root, 'body.s[1].body'), null, '非函数节点无 body 段');
  assert.equal(findBlockByPath(root, '0.then'), null, '旧方言路径（无 body 前缀）不再接受');
  assert.equal(findBlockByPath(root, ''), null);
  assert.equal(findBlockByPath(root, null), null);
  assert.equal(findBlockByPath(null, 'body.s[0]'), null);
  // 空分支段回退（F6 探针实证）：loop 内 if 缺 else → details.path '...else' 高亮 if 容器块本身
  const noElse = toBlocks({ body: { type: 'seq', statements: [
    { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'seq', statements: [
      { type: 'if', cond: { type: 'literal', value: false }, then: { type: 'seq', statements: [{ type: 'action', name: 'x' }] }, else: null },
    ] } },
  ] } });
  const elseId = findBlockByPath(noElse, 'body.s[0].body.s[0].else');
  assert.ok(elseId, '缺 else → 回退 if 容器块');
  assert.equal(collect(noElse).get(elseId).type, 'if');
  // 非容器节点的 .body/.then 段仍 miss（不误回退）
  assert.equal(findBlockByPath(rootA5, 'body.s[0].then'), null, 'var 无 then 段 → miss');
});

test('bridge 畸形矩阵（分支锤）：缺字段/缺输入/未知块全臂安全 + _seq 单语句 seq 保真', async () => {
  const { toBlocks, toAst, findBlockByPath } = await import('../../public/js/editor/bridge.js');
  // 缺字段语句（后端合法性由 /ai/validate 报；桥本身不抛）
  const malformed = {
    type: 'program', version: 2,
    body: { type: 'seq', statements: [
      { type: 'var' }, { type: 'set', name: 'x' }, { type: 'if' }, { type: 'loop' },
      { type: 'loop', kind: 'count' }, { type: 'random' }, { type: 'function' }, { type: 'call' },
      { type: 'action' }, { type: 'break' }, { type: 'get' }, { type: 'getVar' }, { type: 'literal' },
      { type: 'arith' }, { type: 'cmp' }, { type: 'logic' }, { type: 'bullets' },
    ] },
  };
  const round = toAst(toBlocks(malformed));
  assert.equal(round.body.statements.length, 17, '全类型缺字段仍往返（不丢语句）');
  assert.equal(round.body.statements[0].name, '', 'var 空名');
  assert.equal(round.body.statements[0].value, null, 'var 无 value');
  assert.equal(round.body.statements[2].cond, null, 'if 无 cond');
  assert.equal(round.body.statements[2].then, null, 'if 无 then');
  assert.equal(round.body.statements[3].kind, 'while', 'loop 无 kind → while（无限循环语义）');
  assert.equal(round.body.statements[3].cond.value, true, 'loop 无 cond → literal true');
  assert.equal(round.body.statements[4].times, null, 'count loop 无 times');
  assert.equal(round.body.statements[13].op, undefined, 'arith 缺 op → undefined（不造默认值，交后端 bad_field）');
  assert.deepEqual(round.body.statements[16], { type: 'bullets' });
  // _seq 保真：单语句 seq 不塌缩为裸节点
  const seq1 = { type: 'program', version: 2, body: { type: 'seq', statements: [
    { type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: { type: 'seq', statements: [{ type: 'action', name: 'a' }] } },
  ] } };
  const r1 = toAst(toBlocks(seq1));
  assert.deepEqual(r1, seq1, 'seq[单语句] 保真往返');
  // 防御：手写多块链无 _seq 标记 → 仍按 seq 包装（不丢语句）
  const chain = { id: 'h', type: 'action', fields: { name: 'a' }, inputs: {}, next: { block: { id: 't', type: 'action', fields: { name: 'b' }, inputs: {}, next: null } } };
  const wrapped = toAst({ id: 'r', type: 'loop_forever', fields: {}, inputs: { body0: { block: chain } }, next: null });
  assert.equal(wrapped.body.statements.length, 2);
  // 分支容器非 seq 单节点（backend then=action 直挂）保真
  const bare = { type: 'program', version: 2, body: { type: 'seq', statements: [
    { type: 'if', cond: { type: 'literal', value: true }, then: { type: 'action', name: 'x' }, else: null },
  ] } };
  assert.deepEqual(toAst(toBlocks(bare)), bare, 'then=裸节点 保真');
  // 未知块类型 → 语句跳过 / 表达式 null
  assert.deepEqual(toAst({ id: 'r', type: 'loop_forever', fields: {}, inputs: { body0: { block: { id: 'x', type: 'zzz', fields: {}, inputs: {}, next: null } } }, next: null }).body.statements, []);
  const setUnknown = toAst(toBlocks({ body: { type: 'seq', statements: [{ type: 'set', name: 'n', value: { type: 'zzz' } }] } }));
  assert.equal(setUnknown.body.statements[0].value, null, '未知表达式 → null');
  // stmtToBlock default 臂：语句位 seq（AST 合法但编辑器词汇不产块）→ 跳过
  assert.equal(toBlocks({ body: { type: 'seq', statements: [{ type: 'seq', statements: [{ type: 'action', name: 'x' }] }] } }).inputs.body0, null);
  // bodyNodeFromBlock 防御臂：无 _seq 标记的多块链（手写畸形积木）→ 按 seq 包装不丢语句
  const hand = {
    id: 'r', type: 'loop_forever', fields: {}, inputs: { body0: { block: {
      id: 'i', type: 'if', fields: {}, inputs: {
        cond: { block: { id: 'n', type: 'num', fields: { value: 1 }, inputs: {}, next: null } },
        then0: { block: { id: 't', type: 'action', fields: { name: 'a' }, inputs: {}, next: { block: { id: 'u', type: 'action', fields: { name: 'b' }, inputs: {}, next: null } } } },
        else0: null,
      }, next: null,
    } } }, next: null,
  };
  const hAst = toAst(hand);
  assert.equal(hAst.body.statements[0].then.statements.length, 2, '无 _seq 多块链 → 防御 seq 包装');
  assert.equal(findBlockByPath(hand, 'body.s[0].then'), 't', '防御包装后路径仍命中链首块');
  // 路径锤：节点为字面量时 then/body 段安全
  const root = toBlocks({ body: { type: 'seq', statements: [{ type: 'set', name: 'n', value: { type: 'literal', value: 1 } }] } });
  assert.equal(findBlockByPath(root, 'body.s[0].expr.body'), null);
  assert.equal(findBlockByPath(root, 'body.s[0].expr.expr'), null);
});

test('buildToolbox：真实 availableNodes 键门控（19 键 mythic 16 条 / 14 键 rare 12 条 / 11 键 common 9 条）', async () => {
  const { buildToolbox } = await import('../../public/js/views/editor.js');
  const mythic = buildToolbox(MYTHIC_NODES);
  assert.equal(mythic.length, 16, 'mythic 全量 16 条（后端 16 节点词表——seq 隐式/arith_ext 并入 arith）');
  assert.ok(mythic.every((b) => b.kind === 'block' && b.type && b.label));
  assert.ok(mythic.some((b) => b.type === 'loop_forever') && mythic.some((b) => b.type === 'num'),
    '★F6 P1 回归锁：loop_forever/num 在真实 mythic 门控下必须可见（原门控键不匹配 → 永被剔除）');
  assert.ok(mythic.some((b) => b.type === 'function') && mythic.some((b) => b.type === 'call') && mythic.some((b) => b.type === 'break'));
  const rare = buildToolbox(RARE_NODES);
  assert.equal(rare.length, 12);
  assert.ok(!rare.some((b) => b.type === 'random'), 'rare 无 random（epic 解锁）');
  assert.ok(!rare.some((b) => b.type === 'function'), 'rare 无 function（mythic 解锁）');
  const common = buildToolbox(['seq', 'literal', 'get', 'bullets', 'var', 'set', 'getVar', 'arith', 'cmp', 'action', 'if']);
  assert.equal(common.length, 9, 'common 9 条（loop/break 未解锁）');
  assert.deepEqual(buildToolbox([]), []);
  assert.deepEqual(buildToolbox(null), []);
  assert.equal(buildToolbox(['random'])[0].label, '随机分支');
});

test('editorLayout：§6.2 坐标（blocklyDiv 注入盒/panel 三按钮/errors 行高亮 action）+ 编译态/缺层/verify 全绿', async () => {
  const { editorLayout } = await import('../../public/js/views/editor.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const mk = (patch) => Object.assign({
    screen: 'editor', tier: 'mythic', seed: 1,
    aiDraft: { program: null, hash: 'abcdef123456', errors: [], compiling: true },
    ui: { busy: false, snackbar: [], modal: null, activeTab: {} },
  }, patch || {});
  const boxes = editorLayout(mk());
  const ws = boxes.find((b) => b.id === 'blocklyDiv');
  assert.deepEqual([ws.x, ws.y, ws.w, ws.h, ws.z], [120, 64, 1024, 432, 2], '★F6 P1：workspace 盒 id=blocklyDiv（Blockly.inject 容器）；坐标=screens.md editor 表 workspace 行');
  assert.deepEqual([boxes.find((b) => b.id === 'toolbox').x, boxes.find((b) => b.id === 'toolbox').w], [0, 120], '表 toolbox 行');
  assert.equal(boxes.find((b) => b.id === 'panel_right').w, 136);
  assert.equal(boxes.find((b) => b.id === 'btn_validate').action, 'ai/validate');
  assert.equal(boxes.find((b) => b.id === 'btn_validate').y, 80);
  assert.equal(boxes.find((b) => b.id === 'btn_compile').action, 'ai/compile');
  assert.equal(boxes.find((b) => b.id === 'btn_compile').y, 120);
  assert.deepEqual(boxes.find((b) => b.id === 'btn_run').payload, { opponent: 'kiter' });
  assert.equal(boxes.find((b) => b.id === 'hash').text, 'HASH abcdef12');
  assert.equal(boxes.find((b) => b.id === 'hash').y, 216);
  assert.ok(boxes.find((b) => b.id === 'editor_err_ok'), '无错误占位');
  assert.equal(verifyLayout(boxes).ok, true, '布局自检');
  // 错误态：行渲染 + 计数 + 高亮 action/payload（★F6 P1：原行无任何点击标注）
  const errs = [
    { path: 'body.s[1]', code: 'bad_stmt', message: '未知语句类型' },
    { path: 'body.s[2].then[0]', code: 'unknown_action', message: 'x' },
  ];
  const errBoxes = editorLayout(mk({ aiDraft: { program: null, hash: null, errors: errs, compiling: false } }));
  assert.equal(errBoxes.find((b) => b.id === 'hash').text, '未编译');
  assert.equal(errBoxes.find((b) => b.id === 'errCount').text, '错误 2');
  assert.equal(errBoxes.find((b) => b.id === 'errCount').y, 272);
  const rows = errBoxes.filter((b) => b.id.startsWith('editor_err_') && b.kind === 'listitem');
  assert.equal(rows.length, 2);
  assert.ok(rows[0].text.includes('body.s[1]'));
  assert.equal(rows[0].action, 'editor/highlight');
  assert.deepEqual(rows[0].payload, { path: 'body.s[1]' });
  assert.equal(rows[0].parent, 'errors');
  assert.equal(verifyLayout(errBoxes).ok, true, '错误态自检');
  // 分支锤：aiDraft 缺层 / 错误无 path·code（无 path → 无高亮 action）
  const noDraft = editorLayout({ screen: 'editor', ui: { busy: false, snackbar: [], modal: null, activeTab: {} } });
  assert.equal(noDraft.find((b) => b.id === 'hash').text, '未编译');
  assert.equal(noDraft.find((b) => b.id === 'errCount').text, '错误 0');
  const bareErr = editorLayout({ screen: 'editor', aiDraft: { hash: null, errors: [{ message: '仅消息' }, { path: 'body.s[3]' }] }, ui: { busy: false, snackbar: [], modal: null, activeTab: {} } });
  const bareRows = bareErr.filter((b) => b.kind === 'listitem');
  assert.ok(bareRows[0].text.trim() === '', '无 path/code → 空文本');
  assert.equal(bareRows[0].detail, '仅消息', 'message → detail；缺 path 行不挂高亮');
  assert.equal(bareRows[0].action, null, '无 path → 不挂高亮 action');
  assert.equal(bareRows[1].detail, '', '有 path 无 message → detail 空');
});

test('createEditor：注入 Blockly stub 流（change → debounce 300 → 后端形状 program）+ presetLoop 真建根循环 + 分支全臂', async () => {
  const { createEditor, presetLoop, highlightByPath } = await import('../../public/js/editor/main.js');
  assert.equal(createEditor({}).created, false);
  assert.equal(createEditor({ Blockly: {} }).created, false, '无容器');
  const calls = [];
  let changeListener = null;
  const fakeB = {
    inject: (el, opts) => ({ opts, addChangeListener: (fn) => { changeListener = fn; } }),
  };
  const fakeContainer = { id: 'blocklyDiv' };
  let timerFn = null;
  const timers = {
    setTimeout: (fn, ms) => { timerFn = { fn, ms }; return 1; },
    clearTimeout: () => { timerFn = null; },
  };
  const editor = createEditor({
    Blockly: fakeB, container: fakeContainer, dispatch: (a) => calls.push(a),
    debounceMs: 300, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    programRoot: () => null,
  });
  assert.equal(editor.created, true);
  assert.equal(editor.widget.opts.grid.spacing, 24);
  assert.equal(editor.widget.opts.zoom.controls, true);
  assert.ok(changeListener, '监听器挂上');
  changeListener();
  assert.ok(timerFn && timerFn.ms === 300, 'debounce 300ms');
  timerFn.fn();
  assert.equal(calls[0].type, 'ai/edit');
  assert.deepEqual(calls[0].payload.program, { type: 'program', version: 2, body: { type: 'seq', statements: [] } }, '空根 → 空程序（后端形状）');
  changeListener();
  const snap = timerFn;
  changeListener();
  assert.equal(timerFn === snap, false, 'debounce 重置');
  editor.dispose();
  assert.equal(timerFn, null, 'dispose 清定时器');
  // 分支：无 clearTimeout（timer 排程中 dispose 安全）；无 programRoot → widget.getTopBlocks
  const fakeB2 = { inject: () => ({ addChangeListener: (fn) => { changeListener = fn; } }) };
  const e2 = createEditor({ Blockly: fakeB2, container: fakeContainer, dispatch: () => {}, debounceMs: 100, setTimeout: (fn) => { timerFn = { fn }; return 2; } });
  e2.dispose();
  const fakeB3 = {
    inject: () => ({ addChangeListener: (fn) => { changeListener = fn; }, getTopBlocks: () => [{ type: 'action', fields: { name: 'wait' }, id: 'blk_w' }], dispose: () => { timerFn = 'widget-disposed'; } }),
  };
  const withTop = [];
  const e3 = createEditor({
    Blockly: fakeB3, container: fakeContainer, dispatch: (a) => withTop.push(a), debounceMs: 1,
    toolbox: [{ type: 'num' }],
    setTimeout: (fn) => { timerFn = { fn }; return 3; }, clearTimeout: () => {},
  });
  changeListener();
  timerFn.fn();
  assert.equal(withTop[0].payload.program.body.statements[0].name, 'wait', 'widget.getTopBlocks 来源');
  e3.dispose();
  assert.equal(timerFn, 'widget-disposed', 'dispose 透传 widget.dispose');
  // 桥转换抛错 → 安全兜底（不中断监听）
  const errOut = [];
  const eErr = createEditor({
    Blockly: fakeB, container: fakeContainer, dispatch: (a) => errOut.push(a), debounceMs: 1,
    programRoot: () => { throw new Error('boom'); },
    setTimeout: (fn) => { timerFn = { fn }; return 4; }, clearTimeout: () => {},
  });
  changeListener();
  timerFn.fn();
  assert.equal(errOut.length, 0, '转换异常被吞（编辑器不崩）');
  // inject 抛错 → inject-failed
  const badInject = createEditor({ Blockly: { inject: () => { throw new Error('no dom'); } }, container: fakeContainer });
  assert.deepEqual({ created: badInject.created, reason: badInject.reason }, { created: false, reason: 'inject-failed' });
  // document 回退 + 无 dispatch 兜底
  const globalDoc = globalThis.document;
  globalThis.document = { getElementById: () => fakeContainer };
  try {
    const e4 = createEditor({ Blockly: fakeB, setTimeout: (fn) => { timerFn = { fn }; return 5; }, clearTimeout: () => {} });
    assert.equal(e4.created, true, 'document 回退容器');
    changeListener();
    timerFn.fn();
    e4.dispose();
  } finally {
    if (globalDoc === undefined) delete globalThis.document;
    else globalThis.document = globalDoc;
  }
  // presetLoop：真实 Blockly 语义（movable/deletable false + initSvg/render/moveBy）
  const made = [];
  const mkBlk = (type) => {
    const b = { type, flags: {} };
    for (const m of ['setMovable', 'setDeletable']) b[m] = (v) => { b.flags[m] = v; };
    for (const m of ['initSvg', 'render']) b[m] = () => { b.flags[m] = true; };
    b.moveBy = (x, y) => { b.flags.move = [x, y]; };
    return b;
  };
  const realish = { newBlock: (t) => { const b = mkBlk(t); made.push(b); return b; } };
  assert.equal(presetLoop(fakeB, realish), true, '真预置');
  assert.equal(made[0].type, 'loop_forever', 'D-100 根循环类型');
  assert.equal(made[0].flags.setMovable, false);
  assert.equal(made[0].flags.setDeletable, false);
  assert.equal(made[0].flags.initSvg, true);
  assert.equal(made[0].flags.render, true);
  assert.deepEqual(made[0].flags.move, [24, 0]);
  assert.equal(presetLoop(fakeB, {}), false, '无 newBlock → false（原桩返回 truthy——审查修正）');
  assert.equal(presetLoop(null, realish), false);
  assert.equal(presetLoop(fakeB, { newBlock: () => { throw new Error('x'); } }), false, '建块抛错 → false');
  assert.equal(presetLoop(fakeB, { newBlock: () => null }), false, 'newBlock 返回 null → false');
  // highlightByPath：命中 → 高亮；miss → null
  const hl = [];
  const root = { id: 'blk_root', type: 'loop_forever', fields: {}, inputs: { body0: { block: { id: 'blk_a', type: 'action', fields: { name: 'wait' }, inputs: {}, next: null } } }, next: null };
  assert.equal(highlightByPath({ highlightBlock: (id) => hl.push(id) }, root, 'body.s[0]'), 'blk_a');
  assert.deepEqual(hl, ['blk_a']);
  assert.equal(highlightByPath({ highlightBlock: () => {} }, root, 'body.s[9]'), null);
  assert.equal(highlightByPath(null, root, 'body.s[0]'), 'blk_a', '无 highlightBlock API 仍返回 id');
});

test('F6 兜底：桥空/畸形/null + 程序无边 段 + 表达式语句往返 + 版本迁移等价（fixture 全量再证）', async () => {
  const { toBlocks, toAst } = await import('../../public/js/editor/bridge.js');
  // 表达式语句（后端 runtime 支持"表达式语句"）往返不丢
  const exprStmt = { type: 'program', version: 2, body: { type: 'seq', statements: [
    { type: 'cmp', op: '<', left: { type: 'getVar', name: 'a' }, right: { type: 'literal', value: 2 } },
    { type: 'logic', op: 'and', left: { type: 'literal', value: true }, right: { type: 'literal', value: false } },
    { type: 'get', path: 'self.hp' },
    { type: 'bullets' },
  ] } };
  assert.deepEqual(toAst(toBlocks(exprStmt)), exprStmt);
  // 根不是 loop_forever（任意块）也能转换（getTopBlocks 首块可能是散块）
  const loose = toAst({ id: 'b', type: 'action', fields: { name: 'x' }, inputs: {}, next: null });
  assert.deepEqual(loose.body.statements, [{ type: 'action', name: 'x' }]);
  // get/getVar 双语义（path vs name 字段判别）
  const gv = toAst(toBlocks({ body: { type: 'seq', statements: [{ type: 'set', name: 'n', value: { type: 'getVar', name: 'v' } }] } }));
  assert.deepEqual(gv.body.statements[0].value, { type: 'getVar', name: 'v' });
  const gp = toAst(toBlocks({ body: { type: 'seq', statements: [{ type: 'set', name: 'n', value: { type: 'get', path: 'self.hp' } }] } }));
  assert.deepEqual(gp.body.statements[0].value, { type: 'get', path: 'self.hp' });
  // while 循环 cond 保真（非 true 条件）
  const whileCmp = { type: 'program', version: 2, body: { type: 'seq', statements: [
    { type: 'loop', kind: 'while', cond: { type: 'cmp', op: '>', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 0 } }, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } },
  ] } };
  assert.deepEqual(toAst(toBlocks(whileCmp)), whileCmp, 'while(cond) 非 true → cond 输入保留');
  // 全 fixture 二次往返（幂等：toAst∘toBlocks∘toAst == toAst）
  for (const name of Object.keys(FIXTURES)) {
    const once = toAst(toBlocks(FIXTURES[name].program));
    assert.deepEqual(toAst(toBlocks(once)), once, `${name} 二次往返幂等`);
  }
});