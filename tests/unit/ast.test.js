'use strict';
// B12 server/ai/ast.js 契约测试 —— 接口见 docs/interfaces.md §1（validateProgram/nodePathOf/limits/NODE_TYPES）
// 依据：systems/08-ai.md §3 节点清单/§4.2 结构校验（深度 32/节点 2000/字节 256KB/危险键）/§4.6 canonicalize 前置；
//   examples/08-ai.md A-6（路径格式 body.s[i].then...）/A-10f/g（上限与危险键）；T-AF-8（原型污染防）
// 归属：tasks.md §6 B12（T-AI-2/11 + T-AF-8/9 结构侧）；日志 ai.validate（debug，§4.6 L5 行）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const ast = require('../../server/ai/ast.js');
const FIXTURES = require('../fixtures/ai-programs.json');

// 深克隆夹具（防止测试间共享引用）
const prog = (key) => JSON.parse(JSON.stringify(FIXTURES[key].program));

test('AF-1 白名单：17 节点类型全覆盖 fixture 合法通过；未知类型拒绝', () => {
  const r = ast.validateProgram(prog('coverageProgram'));
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  // 全部 17 个类型各出现（白名单 17 = 16 语义节点 + seq；fixture 覆盖型）
  const used = ast.collectUsedNodeTypes(prog('coverageProgram'));
  assert.equal(used.length, ast.NODE_TYPES.size, '全部节点类型出现');
  assert.equal(new Set(used).size, ast.NODE_TYPES.size);
  // 未知类型
  const evil = prog('a2Breakpoint');
  evil.body.statements.push({ type: 'eval', value: 'x' });
  const bad = ast.validateProgram(evil);
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, 'unknown_node');
  assert.ok(bad.errors[0].path.startsWith('body.s[3]'), `path 定位: ${bad.errors[0].path}`);
});

test('AF-2 字段类型：合法字段类型通过、非法类型拒绝（带 path）', () => {
  // if 缺 cond
  const p1 = prog('a2Breakpoint');
  p1.body.statements.push({ type: 'if', then: { type: 'seq', statements: [] } });
  const r1 = ast.validateProgram(p1);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.code === 'bad_field' && e.path === 'body.s[3]'), JSON.stringify(r1.errors));
  // if 无 then（then 必填 seq 或空）
  const p2 = prog('a2Breakpoint');
  p2.body.statements.push({ type: 'if', cond: { type: 'literal', value: true } });
  const r2 = ast.validateProgram(p2);
  assert.equal(r2.ok, false);
  // action name 非字符串
  const p3 = prog('a2Breakpoint');
  p3.body.statements[0].name = 42;
  const r3 = ast.validateProgram(p3);
  assert.equal(r3.ok, false);
  assert.equal(r3.errors[0].path, 'body.s[0]');
});

test('AF-3 深度上限 32：33 层嵌套 → ai_too_deep', () => {
  let node = { type: 'action', name: 'wait' };
  for (let i = 0; i < 33; i++) node = { type: 'seq', statements: [node] };
  const p = { type: 'program', version: 1, body: node };
  const r = ast.validateProgram(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'ai_too_deep'), JSON.stringify(r.errors));
  // 30 层包装（+body = 深度 32）恰好通过
  let okNode = { type: 'action', name: 'wait' };
  for (let i = 0; i < 30; i++) okNode = { type: 'seq', statements: [okNode] };
  const okP = { type: 'program', version: 1, body: { type: 'seq', statements: [okNode] } };
  assert.equal(ast.validateProgram(okP).ok, true, '深度 32 内通过');
});

test('AF-4 节点数上限 2000：>2000 → ai_too_large', () => {
  const statements = [];
  for (let i = 0; i < 2001; i++) statements.push({ type: 'action', name: 'wait' });
  const p = { type: 'program', version: 1, body: { type: 'seq', statements } };
  const r = ast.validateProgram(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'ai_too_large'), JSON.stringify(r.errors));
});

test('AF-5 字节上限 256KB：超限 → ai_too_large', () => {
  const big = 'x'.repeat(256 * 1024);
  const p = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'literal', value: big }] } };
  const r = ast.validateProgram(p);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.code === 'ai_too_large'), JSON.stringify(r.errors));
});

test('T-AF-8 危险键：__proto__/constructor/prototype 拒绝（原型污染防）', () => {
  // 注意：直接赋值 __proto__ 会触发原型 setter——必须经 JSON.parse 构造（JSON 解析创建自身属性）
  const injectKey = (program, key) => JSON.parse(
    JSON.stringify(program).replace('{', `{"${key}":{"polluted":1},`)
  );
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const p = injectKey(prog('a2Breakpoint'), key);
    const r = ast.validateProgram(p);
    assert.equal(r.ok, false, `${key} 应拒绝`);
    assert.ok(r.errors.some((e) => e.code === 'forbidden_key'), JSON.stringify(r.errors));
  }
});

test('AF-7 nodePathOf：稳定路径 id（seq→s[i]、if→then/else、loop/function→body；A-6h 风格登记）', () => {
  const p = prog('a1Countdown');
  const pathOf = ast.nodePathOf(p);
  // body.s[1] = if；then 直接是 seq → s[i] 段（文档 A-6h 的 .body. 段出现于 then 为 loop 等容器时）
  assert.equal(pathOf.get(p.body.statements[0]), 'body.s[0]');
  assert.equal(pathOf.get(p.body.statements[1]), 'body.s[1]');
  assert.equal(pathOf.get(p.body.statements[1].then.statements[0]), 'body.s[1].then.s[0]');
  assert.equal(pathOf.get(p.body.statements[1].then.statements[1]), 'body.s[1].then.s[1]');
  assert.equal(pathOf.get(p.body.statements[1].else.statements[0]), 'body.s[1].else.s[0]');
  // 稳定性：同一程序（同引用）两次遍历路径一致
  const again = ast.nodePathOf(p);
  assert.equal(again.get(p.body.statements[1].then.statements[0]), 'body.s[1].then.s[0]');
});

test('AF-8 隐式主循环契约：body 必须是 seq（D-100 结构前提）', () => {
  const p = { type: 'program', version: 1, body: { type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: { type: 'seq', statements: [] } } };
  const r = ast.validateProgram(p);
  assert.equal(r.ok, false, 'body 非 seq 拒绝');
  assert.ok(r.errors.some((e) => e.code === 'bad_root'), JSON.stringify(r.errors));
  // 顶层无限循环结构由编辑器保证（校验只拦结构非法）；A-6f while(true) 在循环内合法（B13 合法性）
});

test('AF-9 边界结构：空 statements / 非数组 statements / 缺 version', () => {
  const p1 = { type: 'program', version: 1, body: { type: 'seq', statements: [] } };
  assert.equal(ast.validateProgram(p1).ok, true, '空 body 合法（运行时 wait 兜底）');
  const p2 = { type: 'program', version: 1, body: { type: 'seq', statements: 'not-array' } };
  assert.equal(ast.validateProgram(p2).ok, false);
  const p3 = { type: 'program', body: { type: 'seq', statements: [] } };
  const r3 = ast.validateProgram(p3);
  assert.equal(r3.ok, false, '缺 version 拒绝');
  assert.ok(r3.errors.some((e) => e.code === 'bad_version'), JSON.stringify(r3.errors));
});

test('AF-10 limits 导出与全局阈值一致（depth 32/nodes 2000/bytes 256KB）', () => {
  assert.equal(ast.limits.maxDepth, 32);
  assert.equal(ast.limits.maxNodes, 2000);
  assert.equal(ast.limits.maxBytes, 256 * 1024);
  assert.equal(ast.limits.stepLimit, 10000);
  assert.equal(ast.limits.traceLimit, 2000);
  assert.equal(ast.limits.recursionLimit, 64);
});

test('AF-12 补充分支：literal 缺 value / loop 缺 kind / expr 路径段 / 多错误并行', () => {
  // literal 缺 value → bad_field
  const p1 = prog('a2Breakpoint');
  p1.body.statements.push({ type: 'literal' });
  const r1 = ast.validateProgram(p1);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => e.code === 'bad_field' && e.path === 'body.s[3]'), JSON.stringify(r1.errors));
  // loop 缺 kind → bad_field（string 字段）
  const p2 = prog('a2Breakpoint');
  p2.body.statements.push({ type: 'loop', body: { type: 'seq', statements: [] } });
  const r2 = ast.validateProgram(p2);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => e.code === 'bad_field' && e.path === 'body.s[3]'), JSON.stringify(r2.errors));
  // 表达式子节点错误走 .expr 段（cond 缺失字段）
  const p3 = prog('a1Countdown');
  p3.body.statements[1].cond = { type: 'cmp', op: '<', left: { type: 'getVar' } };
  const r3 = ast.validateProgram(p3);
  assert.equal(r3.ok, false);
  assert.ok(r3.errors.some((e) => typeof e.path === 'string' && e.path.includes('.expr')), JSON.stringify(r3.errors));
  // 多错误并行：未知节点 + 危险键 + 深度同时报
  let deep = { type: 'action', name: 'wait' };
  for (let i = 0; i < 40; i++) deep = { type: 'seq', statements: [deep] };
  const p4 = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'eval' }, deep] } };
  const r4 = ast.validateProgram(p4);
  assert.ok(r4.errors.some((e) => e.code === 'unknown_node'), JSON.stringify(r4.errors));
  assert.ok(r4.errors.some((e) => e.code === 'ai_too_deep'), JSON.stringify(r4.errors));
});

test('AF-13 random 分支盲区（审查 P1-1）：分支子树纳入校验/收集/路径；自引用环防御（P2-2）', () => {
  // random.then 内嵌未知节点 → 拒绝（此前盲区）
  const p1 = prog('a2Breakpoint');
  p1.body.statements.push({ type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'seq', statements: [{ type: 'eval' }] }, else: null });
  const r1 = ast.validateProgram(p1);
  assert.equal(r1.ok, false, 'random 分支内未知节点应拒绝');
  assert.ok(r1.errors.some((e) => e.code === 'unknown_node'), JSON.stringify(r1.errors));
  // random.else 内危险键 → 拒绝（JSON 构造 else 对象）
  const evilElse = JSON.parse('{"prototype": 1, "type": "seq", "statements": []}');
  const p2 = prog('a2Breakpoint');
  p2.body.statements.push({ type: 'random', prob: { type: 'literal', value: 0.5 }, then: null, else: evilElse });
  const r2 = ast.validateProgram(p2);
  assert.equal(r2.ok, false, 'random.else 内危险键应拒绝');
  assert.ok(r2.errors.some((e) => e.code === 'forbidden_key'), JSON.stringify(r2.errors));
  // collectUsedNodeTypes 收 random 分支类型
  const p3 = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] }, else: null }] } };
  const used = ast.collectUsedNodeTypes(p3);
  assert.ok(used.includes('random') && used.includes('action'), `分支类型被收集: ${used}`);
  // 节点路径含 random 分支段
  const pathOf = ast.nodePathOf(p3);
  assert.equal(pathOf.get(p3.body.statements[0].then.statements[0]), 'body.s[0].then.s[0]');
  // 自引用环防御：cycle 对象 → ai_cycle，不栈溢出（返回 {ok, errors}）
  const cyc = prog('a2Breakpoint');
  cyc.body.statements[0] = cyc.body; // seq 自引用
  const r5 = ast.validateProgram(cyc);
  assert.equal(r5.ok, false, '自引用应拒绝');
  assert.ok(r5.errors.some((e) => e.code === 'ai_cycle'), JSON.stringify(r5.errors));
});

test('AF-11 日志：ai.validate（debug）记录 ok/版本', () => {
  const logger = createLogger({ level: 'all', ringSize: 200 });
  const a = ast.withLogger(logger);
  a.validateProgram(prog('coverageProgram'));
  const evt = logger.records.find((x) => x.event === 'ai.validate');
  assert.ok(evt, '应有 ai.validate');
  assert.equal(evt.data.ok, true);
  assert.equal(evt.data.version, 1);
  // 非法时 detail 记 errors 数
  const bad = prog('a2Breakpoint');
  bad.body.statements.push({ type: 'eval' });
  a.validateProgram(bad);
  const evt2 = logger.records.filter((x) => x.event === 'ai.validate').pop();
  assert.equal(evt2.data.ok, false);
  // 缺省 logger 安全
  assert.doesNotThrow(() => {
    ast.validateProgram(prog('a2Breakpoint'));
    ast.nodePathOf(prog('a2Breakpoint'));
    ast.collectUsedNodeTypes(prog('coverageProgram'));
  });
});