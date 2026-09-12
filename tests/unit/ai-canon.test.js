'use strict';
// B16 ast 增补：canonicalize / programHash / 版本迁移 / getNodeAtPath / statsOf
// 依据：examples/08-ai.md A-10a..e；systems/08-ai.md §4.6；interfaces §1（ast 行 B14~B16）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../../shared/log.js');
const ast = require('../../server/ai/ast.js');
const FIXTURES = require('../fixtures/ai-programs.json');
const prog = (key) => JSON.parse(JSON.stringify(FIXTURES[key].program));

test('A-10a/b canonicalize 与 programHash：键序/空白无关', () => {
  const p1 = prog('a1Countdown');
  // 键序打乱（确定性：整树键逆序）→ canonical/hash 相同
  const rev = (n) => {
    if (Array.isArray(n)) return n.map(rev);
    if (!n || typeof n !== 'object') return n;
    const out = {};
    for (const k of Object.keys(n).reverse()) out[k] = rev(n[k]);
    return out;
  };
  const p2 = rev(p1);
  // 空白无关：带缩进重新序列化后解析（AST 对象一致；语义等价展示）
  const p3 = JSON.parse(JSON.stringify(p1, null, 4));
  assert.equal(ast.canonicalize(p1), ast.canonicalize(p2), 'canonical 键序无关');
  assert.equal(ast.canonicalize(p1), ast.canonicalize(p3), 'canonical 空白无关');
  assert.equal(ast.programHash(p1), ast.programHash(p2), 'hash 键序无关');
  assert.equal(ast.programHash(p1), ast.programHash(p3), 'hash 空白无关');
  assert.equal(typeof ast.programHash(p1), 'string');
  assert.equal(ast.programHash(p1).length, 64, 'sha256 hex 64 字符');
});

test('A-10c programHash：字面量一变即变', () => {
  const p1 = prog('a1Countdown');
  const p2 = JSON.parse(JSON.stringify(p1));
  const m = p2.body.statements[0].value;
  assert.equal(m.type, 'literal');
  m.value += 1; // n 初值 0 → 1
  assert.notEqual(ast.programHash(p1), ast.programHash(p2), '字面量变更 → hash 变更');
});

test('A-10d/e 版本：高版本拒绝 ai_version_unsupported；v1 自动迁移 + ai.migrate(info)；v2 幂等', () => {
  const logger = createLogger({ level: 'all', ringSize: 500 });
  const astApi = ast.withLogger(logger);
  const p = prog('a2Breakpoint'); // version 1
  const v1 = astApi.validate(p, 'mythic');
  assert.equal(v1.ok, true, 'v1 迁移后合法');
  assert.ok(logger.records.some((r) => r.event === 'ai.migrate' && r.data.from === 1 && r.data.to === 2 && r.level === 'info'), 'ai.migrate(info) 记录');
  // 高版本 → ai_version_unsupported
  const p3 = JSON.parse(JSON.stringify(p));
  p3.version = 3;
  const v3 = astApi.validate(p3, 'mythic');
  assert.equal(v3.ok, false);
  assert.equal(v3.errors[0].code, 'ai_version_unsupported');
  // version 0 → bad_version（结构校验职责，迁移不接管）
  const p0 = JSON.parse(JSON.stringify(p));
  p0.version = 0;
  const v0 = astApi.validate(p0, 'mythic');
  assert.equal(v0.ok, false);
  assert.ok(v0.errors.some((e) => e.code === 'bad_version'), 'bad_version');
  // 当前版本（2）不迁移、不记事件
  const p2v = JSON.parse(JSON.stringify(p));
  p2v.version = 2;
  const migsBefore = logger.records.filter((r) => r.event === 'ai.migrate').length;
  const v2 = astApi.validate(p2v, 'mythic');
  assert.equal(v2.ok, true);
  assert.equal(logger.records.filter((r) => r.event === 'ai.migrate').length, migsBefore, 'v2 不再迁移');
});

test('B16 statsOf：节点数/深度/用到的节点集（/ai/compile 统计）', () => {
  const p = prog('a1Countdown');
  const s = ast.statsOf(p);
  // 机器推导（walk 含表达式子节点）：body seq(1) → var/if(2) → then seq(3) → set/action(4) → arith(5) → literal/getVar(6)
  assert.equal(s.depth, 6);
  assert.ok(s.nodes >= 9 && Number.isInteger(s.nodes), '节点数正整数');
  for (const t of ['seq', 'var', 'if', 'set', 'action', 'arith', 'cmp', 'literal', 'getVar']) {
    assert.ok(s.usedNodeTypes.includes(t), `应含 ${t}`);
  }
});

test('B16 programHash 与 node:crypto sha256 锚定（纯 JS 实现逐字节对齐；含非 BMP 代理对 P2-1）', () => {
  const crypto = require('node:crypto');
  const samples = [null, 0, '', 'abc', 'hello 世界', 'emoji 😀 mixed 𝌆']; // 4 字节 UTF-8 字符
  for (const s of samples) {
    const canon = ast.canonicalize({ literal: s }); // 同一 canonical 串双向哈希
    const expect = crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
    assert.equal(ast.programHash({ literal: s }), expect, `sha256(${JSON.stringify(canon).slice(0, 30)}) 与 crypto 一致`);
  }
});

test('B16 getNodeAtPath：path → 节点反查（nodePathOf 的逆）', () => {
  const p = prog('a1Countdown');
  assert.equal(ast.getNodeAtPath(p, 'body'), p.body);
  assert.equal(ast.getNodeAtPath(p, 'body.s[0]').type, 'var');
  assert.equal(ast.getNodeAtPath(p, 'body.s[1]').type, 'if');
  assert.equal(ast.getNodeAtPath(p, 'body.s[1].then.s[1]').type, 'action');
  assert.equal(ast.getNodeAtPath(p, 'body.s[1].then.s[0]').type, 'set');
  assert.equal(ast.getNodeAtPath(p, 'body.s[9]'), null, '越界 → null');
  assert.equal(ast.getNodeAtPath(p, 'fn:r'), null, 'fn: 路径不在 AST 反查范围（B16 起帧路径已规范）');
  assert.equal(ast.getNodeAtPath(p, 'nope'), null);
  assert.equal(ast.getNodeAtPath(p, 'body.s[1].then.s[1].zzz'), null, '非法段 → null');
  assert.equal(ast.getNodeAtPath(null, 'body'), null);
  // P2-4：.expr 段反查（var 的 value 表达式；多表达式字段取首个对象）
  assert.equal(ast.getNodeAtPath(p, 'body.s[0].expr').type, 'literal', 'var value 经 .expr 反查');
  assert.equal(ast.getNodeAtPath(p, 'body.s[1].expr').type, 'cmp', 'if cond 经 .expr 反查');
});