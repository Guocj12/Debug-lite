'use strict';
/* .review-f6/probe-f6.js —— F6 独立实证探针（可复跑）：
 * ① vendor 穿越矩阵：/vendor/blockly/* 前缀限定（不暴露其余 node_modules / 仓库根 / 服务器文件）+ 类型 + GET-only
 * ② bridge ↔ 后端 ast.validate 双向等价：tests/fixtures/ai-programs.json 全 6 程序
 *    toBlocks→toAst 后与后端 validate 判等（ok/errors 深等 + 迁移后 canonical/programHash 一致）+ 二次往返幂等
 *    （关键实证：F6 审查 P1「编辑器方言 vs 后端契约断裂」修复后的闭环证明）
 * ③ findBlockByPath 对真实后端 details.path 逐一命中（ast.validate 病态程序 + HTTP /ai/validate 实拍）
 * 运行：node .review-f6/probe-f6.js
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const ROOT = path.join(__dirname, '..');
const ast = require(path.join(ROOT, 'server', 'ai', 'ast.js'));
const { start } = require(path.join(ROOT, 'server', 'index.js'));
const FIXTURES = require(path.join(ROOT, 'tests', 'fixtures', 'ai-programs.json'));
const { createLogger } = require(path.join(ROOT, 'shared', 'log.js'));

let failures = 0;
function ok(name, cond, extra) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? `  →  ${extra}` : ''}`);
  if (!cond) failures += 1;
  return cond;
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function httpGet(port, p, method) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method: method || 'GET' });
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* 非 JSON */ }
  return { status: res.status, ct: res.headers.get('content-type') || '', body: buf.toString('utf8'), json };
}

// 原始套接字请求（undici fetch 会在客户端归一化 .. 段——穿越检测须用服务器视角的原始路径）
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, ct: res.headers['content-type'] || '', body: d }));
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // ============ ① vendor 穿越矩阵 ============
  console.log('\n=== ① /vendor/blockly 静态路由：前缀限定 + 穿越矩阵 + 类型 + GET-only ===');
  const s = await start({ logger: createLogger({ level: 'silent' }) });
  try {
    const pos = await httpGet(s.port, '/vendor/blockly/blockly_compressed.js');
    ok('blockly 主文件 200 + text/javascript + 内容含 Blockly', pos.status === 200 && pos.ct.includes('javascript') && pos.body.includes('Blockly'), `${pos.status} ${pos.ct}`);
    const msg = await httpGet(s.port, '/vendor/blockly/msg/en.js');
    ok('msg/en.js 200 JS 类型', msg.status === 200 && msg.ct.includes('javascript'));
    const lic = await httpGet(s.port, '/vendor/blockly/LICENSE');
    ok('LICENSE 200（Apache-2.0 登记源）', lic.status === 200);
    const variants = [
      ['/vendor/blockly/../package.json', '400', 'dotdot 直接'],
      ['/vendor/blockly/..%2f..%2fpackage.json', '400', '编码斜杠'],
      ['/vendor/blockly/..%2f..%2fserver%2findex.js', '400', '编码斜杠打 server'],
      ['/vendor/blockly/..%5c..%5cpackage.json', '400', '编码反斜杠'],
      ['/vendor/blockly/%2e%2e/%2e%2e/package.json', '400', '全编码 dotdot'],
      ['/vendor/blockly/..%252f..%252fpackage.json', '400', '双重编码（解码仍含 ..）'],
      ['/vendor/%2e%2e/package.json', '404', 'vendor 根穿越（非 blockly 前缀 → 404）'],
      ['/vendor/other/blockly_compressed.js', '404', '非 blockly 前缀'],
      ['/node_modules/blockly/blockly_compressed.js', '404', 'node_modules 直取不暴露'],
      ['/vendor/blockly/blockly_compressed.js.map', '200', 'map 文件可达（同目录合法）'],
    ];
    for (const [p, want, why] of variants) {
      const r = await rawGet(s.port, p); // 原始路径（服务器视角）
      const stabbed = r.body.includes('"lockfileVersion"') || r.body.includes('createServer') || r.body.includes('"name": "debug-lite"');
      ok(`穿越 ${why} → ${want}`, String(r.status) === want && !stabbed, `status=${r.status} stabbed=${stabbed}`);
      if (want === '400') {
        let j = null;
        try { j = JSON.parse(r.body); } catch (e) { /* ignore */ }
        ok(`穿越 ${why}: 400 信封 bad_static（非 200 泄漏）`, j && j.error && j.error.code === 'bad_static', j && j.error && j.error.code);
      }
    }
    const post = await httpGet(s.port, '/vendor/blockly/blockly_compressed.js', 'POST');
    ok('POST /vendor/* → 404（GET-only，F0 纪律）', post.status === 404);
  } finally {
    await s.close();
  }

  // ============ ② bridge ↔ 后端 ast.validate 双向等价 ============
  console.log('\n=== ② bridge 往返 ↔ 后端 ast.validate 判等（fixtures 全量）===');
  const bridge = await import('../public/js/editor/bridge.js');
  for (const name of Object.keys(FIXTURES)) {
    const P = FIXTURES[name].program;
    const v1 = ast.validate(P, 'mythic');
    const blocks = bridge.toBlocks(P);
    const R = bridge.toAst(blocks);
    // 形状判等
    ok(`${name}: toAst 形状=program/version/body`, R.type === 'program' && R.body && R.body.type === 'seq', `v=${R.version}`);
    ok(`${name}: 往返深等（version 归一 v2）`, eq(R, { ...P, version: 2 }));
    // 后端 validate 判等（ok + errors 全等）
    const v2 = ast.validate(R, 'mythic');
    ok(`${name}: validate 结果等价`, v1.ok === v2.ok && eq(v1.errors, v2.errors), `ok=${v2.ok} errors=${JSON.stringify(v2.errors)}`);
    // 编译口径等价：迁移后 canonical + programHash 全等（同一语义程序）
    const migP = ast.migrateProgram(P);
    const p2 = migP.migrated ? migP.program : P;
    ok(`${name}: programHash 与迁移后原程序一致`, ast.programHash(p2) === ast.programHash(R), ast.programHash(R).slice(0, 12));
    // 幂等：toAst∘toBlocks∘toAst ≡ toAst
    ok(`${name}: 二次往返幂等`, eq(bridge.toAst(bridge.toBlocks(R)), R));
    // 逐段位验证（common..mythic：合法程序在低段位可被门控拒——错误路径可高亮）
    for (const tier of ['common', 'rare', 'epic', 'legendary', 'mythic']) {
      const vv = ast.validate(R, tier);
      for (const e of vv.errors) {
        const id = bridge.findBlockByPath(blocks, e.path);
        if (e.path !== '' && !e.path.includes('.')) {
          ok(`${name}@${tier}: 路径 ${e.path} 高亮可定位`, id !== null, `${e.code}`);
        }
      }
    }
  }
  // 编辑器侧构造验证（手写后端程序 → 块 → 程序 → validate ok）
  const hand = {
    type: 'program', version: 2,
    body: { type: 'seq', statements: [
      { type: 'var', name: 'n', value: { type: 'literal', value: 0 } },
      { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'seq', statements: [
        { type: 'if', cond: { type: 'cmp', op: '<', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 3 } },
          then: { type: 'seq', statements: [{ type: 'set', name: 'n', value: { type: 'arith', op: '+', left: { type: 'getVar', name: 'n' }, right: { type: 'literal', value: 1 } } }, { type: 'action', name: 'move_right' }] },
          else: { type: 'seq', statements: [{ type: 'action', name: 'skill1' }] } },
      ] } },
    ] },
  };
  const hv = ast.validate(bridge.toAst(bridge.toBlocks(hand)), 'mythic');
  ok('编辑器侧构造（变量计数+主循环+分支行动规则）validate ok', hv.ok, JSON.stringify(hv.errors));
  ok('手写程序 二次往返深等', eq(bridge.toAst(bridge.toBlocks(hand)), hand));

  // ============ ③ findBlockByPath 对真实后端 details.path 逐一命中 ============
  console.log('\n=== ③ findBlockByPath × 真实后端 details.path（病态程序实证）===');
  // 病态程序集（各触发一类带路径错误）
  const sick = {
    burn: { type: 'program', version: 2, body: { type: 'seq', statements: [
      { type: 'loop', kind: 'count', times: { type: 'literal', value: 99999 }, body: { type: 'seq', statements: [
        { type: 'set', name: 'n', value: { type: 'literal', value: 1 } },
      ] } },
    ] } }, // branch_without_action @ body.s[0].body
    brk: { type: 'program', version: 2, body: { type: 'seq', statements: [
      { type: 'action', name: 'wait' }, { type: 'break' },
    ] } }, // break_outside_loop @ body.s[1]
    call: { type: 'program', version: 2, body: { type: 'seq', statements: [
      { type: 'call', name: 'ghost' },
    ] } }, // unknown_call @ body.s[0]
    lock: { type: 'program', version: 2, body: { type: 'seq', statements: [
      { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'seq', statements: [
        { type: 'random', prob: { type: 'literal', value: 0.5 }, then: { type: 'seq', statements: [{ type: 'action', name: 'a' }] }, else: { type: 'seq', statements: [{ type: 'action', name: 'b' }] } },
      ] } },
    ] } }, // common 下 node_locked(random/loop)
    badnode: { type: 'program', version: 2, body: { type: 'seq', statements: [
      { type: 'action', name: 'wait' }, { type: 'bogus' },
    ] } }, // unknown_node @ body.s[1]（toBlocks 丢块 → 高亮 miss 合法）
    noIf: { type: 'program', version: 2, body: { type: 'seq', statements: [
      { type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'seq', statements: [
        { type: 'if', cond: { type: 'literal', value: true }, then: { type: 'seq', statements: [{ type: 'set', name: 'x', value: { type: 'literal', value: 1 } }] }, else: null },
      ] } },
    ] } }, // branch_without_action @ body.s[0].body.then（循环内 if 无 action）
  };
  const tiers = { burn: 'rare', brk: 'rare', call: 'mythic', lock: 'common', badnode: 'mythic', noIf: 'mythic' };
  for (const [k, P] of Object.entries(sick)) {
    const v = ast.validate(P, tiers[k]);
    ok(`${k}: 病态程序确实报错`, !v.ok, `${v.errors.length} 条`);
    const blocks = bridge.toBlocks(P);
    for (const e of v.errors) {
      const id = bridge.findBlockByPath(blocks, e.path);
      const expectHit = !(e.path === '' || !/^(body)(\.|$)/.test(e.path) || k === 'badnode' && e.path === 'body.s[1]');
      ok(`${k}: path=${e.path} (${e.code}) → ${expectHit ? '命中' : 'miss'}`, expectHit ? id !== null : id === null, id || '-');
    }
  }
  // HTTP /ai/validate 实拍（真实信封 details.path → 高亮）
  const s2 = await start({ logger: createLogger({ level: 'silent' }) });
  try {
    const r = await fetch(`http://127.0.0.1:${s2.port}/api/v1/ai/validate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ program: sick.noIf, tier: 'mythic' }),
    });
    const j = await r.json();
    ok('HTTP /ai/validate 实拍：noIf → ai_invalid + details 带路径', r.status === 400 && j.error.code === 'ai_invalid' && j.error.details.some((d) => d.path === 'body.s[0].body.s[0].then' || d.path === 'body.s[0].body.then'), JSON.stringify((j.error.details || []).map((d) => d.path)));
    const blocks = bridge.toBlocks(sick.noIf);
    const ids = j.error.details.map((d) => bridge.findBlockByPath(blocks, d.path));
    ok('HTTP 实拍路径逐一命中积木（含缺 else 回退容器块）', ids.every((x) => x !== null), JSON.stringify(ids));
  } finally {
    await s2.close();
  }

  // 路径段语义逐字形核对：当前后端 ast.js childList 实装为 seq→s[i]、if→then/else、loop→body、表达式→.expr
  // ——任务清单所引旧样例 'body.s[2].then[0]'/'body.s[1].cond.a' 非当前后端产出形态（无 [0] 索引段/无 cond.a 段），
  // 已由真实 validate 路径逐条实证覆盖；'then[0]' 形态若出现 → findBlockByPath 按未知段 miss（安全）。
  ok('旧方言路径（then[0]/cond.a）按未知段 miss（不改形状不误命）', bridge.findBlockByPath(bridge.toBlocks(sick.call), 'body.s[0].then[0]') === null);

  console.log(`\n==== probe-f6: ${failures === 0 ? 'ALL PASS' : `${failures} FAILURES`} ====`);
  process.exitCode = failures === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });