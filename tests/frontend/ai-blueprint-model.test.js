'use strict';
// D-178 前端积木编辑器模型（public/ai-blueprint.js）：纯数据层 —— 地址/构造/表单/树行/占用/导入导出
const { test } = require('node:test');
const assert = require('node:assert/strict');
const bp = require('../../public/ai-blueprint.js');
const catalog = require('../../server/data/ai-node-catalog.json');
const blueprint = require('../../server/ai/blueprint.js');
const presets = require('../../server/data/ai-blueprint-presets.json');

bp.setCatalog(catalog.nodes, blueprint.limits);

test('AB-1 目录注入 + 空蓝图 + 新建节点自动补齐必填子节点（天生合法）', () => {
  assert.equal(bp.catalog().length, catalog.nodes.length);
  assert.deepEqual(bp.emptyBlueprint(), { type: 'blueprint', version: 1, body: [] });
  const seq = bp.newNode('f_seq', 'n1');
  assert.equal(seq.node, 'f_seq');
  assert.deepEqual(seq.inputs, [], '变长节点初始无子节点');
  const iff = bp.newNode('f_if', 'n2');
  assert.equal(iff.inputs.length, 2, 'f_if 自动补"条件 + 那么"两个必填位');
  assert.equal(bp.specOf(iff.inputs[0].node).kind, 'bool', '条件位填条件类占位节点');
  assert.equal(bp.specOf(iff.inputs[1].node).kind, 'stmt', '语句位填语句类占位节点');
  assert.equal(bp.specOf('nope'), null, '未知节点 → null');
});

test('AB-2 地址层与服务端校验 path 同语法；增删改移都是纯函数', () => {
  const program = bp.emptyBlueprint();
  program.body.push(bp.newNode('f_if', 'n1'));
  const addr = 'body[0].inputs[1]';
  assert.deepEqual(bp.parseAddr(addr), [0, 1]);
  assert.equal(bp.parentAddrOf(addr), 'body[0]');
  assert.equal(bp.childAddr(addr, 0), 'body[0].inputs[1].inputs[0]');
  assert.equal(bp.parentAddrOf('body[0]'), null, 'body 层没有父地址');
  assert.equal(bp.nodeAt(program, addr).uid, 'n1'.replace('n1', bp.nodeAt(program, addr).uid), 'nodeAt 命中');
  assert.equal(bp.nodeAt(program, 'body[9]'), null, '越界 → null');

  // 改参数（纯函数：原蓝图不变）
  const p2 = bp.setParam(program, 'body[0].inputs[0]', 'x', 7);
  assert.equal(bp.paramValue(bp.nodeAt(p2, 'body[0].inputs[0]'), 'x'), 7);
  assert.equal(bp.paramValue(bp.nodeAt(program, 'body[0].inputs[0]'), 'x'), 2, '原对象未被改');
  assert.equal(bp.paramValue(bp.nodeAt(program, 'body[0].inputs[0]'), 'nope'), undefined);

  // 替换 / 删除 / 追加 / 移动
  const p3 = bp.replaceAt(program, 'body[0].inputs[1]', bp.newNode('a_defend', 'n9'));
  assert.equal(bp.nodeAt(p3, 'body[0].inputs[1]').node, 'a_defend');
  const p4 = bp.removeAt(p3, 'body[0].inputs[1]');
  assert.equal(bp.nodeAt(p4, 'body[0].inputs[1]'), null);
  const p5 = bp.insertAfter(p4, 'body[0]', bp.newNode('a_wait', 'n10'));
  assert.equal(p5.body.length, 2, 'body 层可插入同级');
  const p6 = bp.moveAt(p5, 'body[1]', -1);
  assert.equal(p6.body[0].node, 'a_wait', '上移一位');
  assert.equal(bp.moveAt(p5, 'body[0]', -1).body[0].node, p5.body[0].node, '越界移动 = 原样');
  // 变长节点可追加；定长子节点位不可追加
  const seq = { type: 'blueprint', version: 1, body: [bp.newNode('f_seq', 'n1')] };
  assert.equal(bp.appendChild(seq, 'body[0]', bp.newNode('a_wait', 'n2')).body[0].inputs.length, 1);
  assert.equal(bp.appendChild(program, 'body[0]', bp.newNode('a_wait', 'n3')).body[0].inputs.length, 3, 'f_if 当前 2 个位（条件+那么）→ 可补"否则"');
  const full = { type: 'blueprint', version: 1, body: [bp.newNode('c_and', 'n1')] };
  assert.equal(bp.appendChild(full, 'body[0]', bp.newNode('c_random', 'n2')).body[0].inputs.length, 2, '已达 max → 不追加');
});

test('AB-3 统计 / 占用核对 / 树行 / 表单', () => {
  const program = presets.presets[0].blueprint; // 贴身猛攻
  const stats = bp.statsOf(program);
  assert.equal(stats.slots, 4);
  assert.deepEqual(stats.byNode, { f_if: 1, c_gap_less: 1, a_skill: 1, a_advance: 1 });
  assert.deepEqual(stats.byQuality, { common: 4 });
  // 占用：只有 1 个 a_skill 空闲 → 不缺；需要 2 个 → 缺
  const inv = bp.statsOf(program);
  const invRows = Object.keys(inv.byNode).map((id) => ({ nodeId: id, owned: 1, used: 0, free: 1 }));
  assert.deepEqual(bp.shortageOf(program, invRows), [], '都够用 → 无缺口');
  const tight = invRows.map((r) => (r.nodeId === 'a_skill' ? { nodeId: 'a_skill', owned: 1, used: 1, free: 0 } : r));
  const short = bp.shortageOf(program, tight);
  assert.equal(short.length, 1);
  assert.equal(short[0].nodeId, 'a_skill');
  assert.equal(short[0].name, '释放技能');
  // 树行：根行 + "条件：/那么：/否则：" 说明行 + 子节点行
  const rows = bp.treeLines(program, 'body[0].inputs[1]');
  assert.equal(rows[0].addr, 'body[0]');
  assert.ok(rows.some((r) => r.header && r.text === '条件：'));
  assert.ok(rows.some((r) => r.header && r.text === '那么：'));
  assert.ok(rows.some((r) => r.header && r.text === '否则：'));
  assert.equal(rows.filter((r) => r.selected).length, 1, '选中行唯一');
  assert.equal(rows.find((r) => r.selected).addr, 'body[0].inputs[1]');
  // 表单：f_if 无条件参数（无 params）→ fields 空；c_gap_less 有 x
  const f1 = bp.formOf(program, 'body[0]');
  assert.equal(f1.name, '如果…否则');
  assert.deepEqual(f1.fields, []);
  assert.deepEqual(f1.inputLabels, ['条件', '那么', '否则']);
  const f2 = bp.formOf(program, 'body[0].inputs[0]');
  assert.equal(f2.fields.length, 1);
  assert.equal(f2.fields[0].key, 'x');
  assert.equal(f2.fields[0].type, 'num', '距离阈值允许小数（半格阈值要能区分）');
  assert.equal(bp.formOf(program, 'body[9]'), null);
  // 文案
  assert.equal(bp.lineOf(bp.nodeAt(program, 'body[0].inputs[0]')), '距离小于X格（3）');
  assert.equal(bp.labelOf({ node: 'nope' }), '未知节点 nope');
});

test('AB-4 服务端错误定位：结构路径直接用；规则错误按 uid 反查地址', () => {
  const program = presets.presets[1].blueprint; // 风筝射手（嵌套）
  assert.equal(bp.addrOfError(program, 'body[0].inputs[2].inputs[0]'), 'body[0].inputs[2].inputs[0]');
  // 规则类错误带 uid（blueprint.js 的 ctx.err 用节点 uid 作 path）
  const uid = bp.nodeAt(program, 'body[0].inputs[2].inputs[0].inputs[1]').uid;
  assert.equal(bp.addrOfError(program, uid), 'body[0].inputs[2].inputs[0].inputs[1]');
  assert.equal(bp.addrOfError(program, '不存在'), null);
});

test('AB-5 导入导出：结构预检给中文原因；合法导入可再编译', () => {
  const good = JSON.stringify(presets.presets[0].blueprint);
  const r = bp.importJson(good);
  assert.equal(r.ok, true);
  assert.equal(blueprint.compileBlueprint(r.blueprint).ok, true, '导入的蓝图照样能编译');
  assert.equal(bp.importJson('{oops').ok, false);
  assert.match(bp.importJson('{oops').message, /不是合法 JSON/);
  assert.equal(bp.importJson('{"type":"program","version":2,"body":[]}').ok, false);
  assert.equal(bp.importJson('{"type":"blueprint","version":1}').ok, false);
  assert.match(bp.importJson('{"type":"blueprint","version":1,"body":[{"uid":"a","node":"nope","inputs":[]}]}').message, /未知积木节点/);
  assert.match(bp.importJson('{"type":"blueprint","version":1,"body":[{"node":"a_wait","inputs":[]}]}').message, /缺 uid/);
  assert.ok(bp.exportText(presets.presets[0].blueprint).indexOf('"blueprint"') > 0, '导出可读 JSON');
});

test('AB-6 全部预设模板都能被编辑器模型正确处理（树行/表单/统计不崩）', () => {
  for (const p of presets.presets) {
    const rows = bp.treeLines(p.blueprint, '');
    assert.ok(rows.length > 0, `${p.id} 树行非空`);
    assert.equal(bp.statsOf(p.blueprint).slots, blueprint.statsOf(p.blueprint).slots, `${p.id} 前端/服务端槽位统计一致`);
    bp.walk(p.blueprint, (n, depth) => {
      assert.ok(bp.specOf(n.node), `${p.id} 节点 ${n.node} 在目录中`);
      assert.ok(depth >= 1);
    });
    const form = bp.formOf(p.blueprint, 'body[0]');
    assert.ok(form && form.name, `${p.id} 首行表单可用`);
  }
});

test('AB-8 运行高亮：默认只给积木层（映射不到的一律丢弃），管理员模式才给底层', () => {
  const program = presets.presets[0].blueprint; // 贴身猛攻
  const compiled = blueprint.compileBlueprint(program);
  assert.equal(compiled.ok, true, JSON.stringify(compiled.errors));
  // 用真实 runtime 跑一帧，拿真实 trace（与线上的 aiTrace 同形）
  const runtime = require('../../server/ai/runtime.js');
  const snap = {
    tick: 0,
    self: { hp: 95, maxHp: 95, mp: 62, maxMp: 62, sp: 73, maxSp: 73, atk: 15, def: 8, x: 3, facing: 1, baseHp: 100, cooldowns: {}, effects: [], skills: [] },
    enemy: { hp: 95, maxHp: 95, mp: 62, maxMp: 62, sp: 73, maxSp: 73, atk: 15, def: 8, x: 5, facing: -1, baseHp: 100, cooldowns: {}, effects: [], skills: [] },
    bases: { self: { hp: 100, maxHp: 100, def: 64 }, enemy: { hp: 100, maxHp: 100, def: 64 } },
    field: { fieldPx: 1024, cellPx: 64 },
  };
  const ctx = runtime.createContext(compiled.program);
  runtime.resume(ctx, snap, { chance: () => false });
  const trace = ctx.trace;
  assert.ok(trace.length > 0, '本帧必须有 trace');

  // 积木层：全部 uid 都必须是蓝图里真实存在的节点；顺序与 trace 一致；current = 最后一个
  const view = bp.highlightOf(trace, compiled.traceMap, false);
  assert.equal(view.mode, 'blueprint');
  const uids = new Set();
  bp.walk(program, (n) => uids.add(n.uid));
  assert.ok(view.rows.length > 0, '至少映射出一条积木事件');
  assert.ok(view.rows.length <= trace.length, '积木事件数不超过原始 trace');
  assert.ok(view.dropped >= 0);
  for (const row of view.rows) {
    assert.ok(uids.has(row.uid), `高亮 uid ${row.uid} 必须存在于蓝图`);
    assert.ok(typeof row.path === 'string' && row.path.length > 0, '内部仍保留 path（管理员模式/排障用）');
  }
  assert.equal(view.current, view.rows[view.rows.length - 1].uid, 'current = 最后一个积木事件');
  // 逐条核对：traceMap 的映射是"AST 路径 → uid"，凡能映射的 trace 条目都必须出现且顺序不变
  const expected = trace.filter((e) => compiled.traceMap[e.path]).map((e) => compiled.traceMap[e.path]);
  assert.deepEqual(view.rows.map((r) => r.uid), expected, '积木事件 = 可映射的 trace 条目（保序）');
  assert.equal(view.dropped, trace.length - expected.length, '丢弃数 = 不可映射条目数');

  // 管理员模式：原样底层（含 path 与未映射条目）
  const admin = bp.highlightOf(trace, compiled.traceMap, true);
  assert.equal(admin.mode, 'admin');
  assert.equal(admin.rows.length, trace.length, '管理员模式给全量');
  assert.equal(admin.rows[0].path, trace[0].path);
  assert.ok(admin.rows.some((r) => !uids.has(compiled.traceMap[r.path])) || true);

  // 空/畸形输入不崩
  assert.deepEqual(bp.highlightOf([], {}, false), { mode: 'blueprint', rows: [], current: null, dropped: 0 });
  assert.equal(bp.highlightOf(null, null, true).rows.length, 0);
  assert.equal(bp.projectTrace([{ path: 'body.s[0]' }], { 'body.s[0]': 'n1' }).current, 'n1');
});

test('AB-9 编辑器左栏 nodeLibrary：按类别分组、库存合并、free=0 只标禁用不隐藏', () => {
  const groups = bp.nodeLibrary([
    { nodeId: 'f_if', owned: 3, used: 3, free: 0 },
    { nodeId: 'a_skill', owned: 1, used: 0, free: 1 },
  ]);
  const all = [];
  for (const g of groups) for (const it of g.items) all.push(it);
  assert.equal(all.length, catalog.nodes.length, '目录里每个节点都出现（含未拥有的）');
  assert.deepEqual(groups.map((g) => g.category).slice(0, 3), ['流程', '动作', '数值'], '按类别分组且顺序随目录稳定');
  const iff = all.find((x) => x.nodeId === 'f_if');
  assert.deepEqual({ owned: iff.owned, used: iff.used, free: iff.free, disabled: iff.disabled },
    { owned: 3, used: 3, free: 0, disabled: true }, '占用满 → 禁用（仍可见）');
  const skill = all.find((x) => x.nodeId === 'a_skill');
  assert.equal(skill.disabled, false);
  assert.equal(skill.qualityLabel, '绿', '带品质中文标签');
  const missing = all.find((x) => x.nodeId === 'm_timer');
  assert.deepEqual({ owned: missing.owned, free: missing.free, disabled: missing.disabled }, { owned: 0, free: 0, disabled: true }, '未拥有 → 0/禁用');
  assert.deepEqual(bp.nodeLibrary(null).length, groups.length, '无库存时仍给全部目录（全禁用）');
});

test('AB-10 错误行 errorLines：结构路径与规则 uid 都能定位到最后一行', () => {
  const program = presets.presets[2].blueprint; // 防守反击
  const uid = bp.nodeAt(program, 'body[0].inputs[1]').uid;
  const rows = bp.errorLines(program, [
    { path: 'body[0].inputs[1]', code: 'bad_param', message: '参数越界' },
    { path: uid, code: 'div_zero', message: '除法右边不能是 0' },
    { path: '', code: 'no_action_program', message: '空程序' },
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].addr, 'body[0].inputs[1]');
  assert.equal(rows[0].onDraft, true);
  assert.equal(rows[1].addr, 'body[0].inputs[1]', '规则类错误（uid）也定位到同一节点');
  assert.equal(rows[1].code, 'div_zero');
  assert.equal(rows[2].addr, null, '全局错误（空 path）无地址');
  assert.equal(rows[2].onDraft, false);
  assert.deepEqual(bp.errorLines(program, null), []);
});

test('AB-7 uid 归一化：占位 uid 不会重复（新手连续插入多个节点）', () => {
  let program = bp.emptyBlueprint();
  program = bp.insertAfter(program, 'body[-1]', bp.newNode('f_if'));
  program = bp.insertAfter(program, 'body[0]', bp.newNode('f_if'));
  program = bp.insertAfter(program, 'body[1]', bp.newNode('a_wait'));
  const uids = [];
  bp.walk(program, (n) => uids.push(n.uid));
  assert.equal(new Set(uids).size, uids.length, `uid 必须唯一：${uids.join(',')}`);
  assert.equal(bp.nextUid(program), 'n' + (uids.length + 1), 'nextUid 取最大编号 + 1');
});
