'use strict';
/* tests/frontend/ai-editor-flow.test.js —— F5/D-172：AI 编辑器（查看 / 新建 / 编辑 / 删除）机器核对
 *
 * 权威：docs/frontend/06-ai-editor.md §3（屏与交互）/§4（编辑器地址与节点表单）/§5.2（字段契约）/§8（AE-1…AE-12）；
 *      docs/decisions.md §14.10（D-172）；docs/interfaces.md §2/§2.1。
 * 与浏览器完全同构：public/{store,ai-editor,format,render,actions,api,app}.js + 进程内真实服务（真实 HTTP）。
 *
 * 覆盖：
 *   AE-1  动作双向闭合（F5 动作集合 == 注册表 F5 段；事件型 ai-field-commit 单列）
 *   AE-2  字段三方一致（contract.AI_ITEM_FIELDS == format.js 实读 == 06 §5.2）
 *   AE-3  节点表单表 == 服务端真源（16 类默认节点全部通过校验；枚举取值逐个被接受、表外取值被拒）
 *   AE-4  编辑器地址往返 + `cmp.left`/`cmp.right` **不互相串**（§2 R5 回归）
 *   AE-5  不复制判决（唯一例外 = 函数重名）；render.js 零 pick；fetch/innerHTML 单点
 *   AE-6  校验错误可定位（服务端 path → 编辑器地址）
 *   AE-7  真实 HTTP 全链路：新建草稿 → 打开 → 改好 → 自动校验通过 → 保存（aiId 不变）→ 绑定 → 删除被引用 409 → 换掉 → 删除 200
 *   AE-10 多行输入（textarea）只在导入区块出现，且是唯一用途（裁决 ③）
 *   AE-12 实时校验不逐键：连续 input 不发请求，change 才发一次
 *   AE-14 程序树层级可读：有序区块（标题紧跟内容）+ 可见缩进导轨 + 隐式主循环在最外层（用户实测反馈）
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startServer } = require('../helpers/http.js');
const store = require('../../public/store.js');
const aiEd = require('../../public/ai-editor.js');
const format = require('../../public/format.js');
const render = require('../../public/render.js');
const actions = require('../../public/actions.js');
const apiMod = require('../../public/api.js');
const appMod = require('../../public/app.js');
const contract = require('../../public/contract.js');
const ast = require('../../server/ai/ast.js');
const AI_LANG = require('../../server/data/ai-nodes.json');

const REPO = path.join(__dirname, '..', '..');
const PUBLIC_DIR = path.join(REPO, 'public');
const DOC6 = path.join(REPO, 'docs', 'frontend', '06-ai-editor.md');
const PW = 'pw12345678';

const ACTION_NAMES = Object.keys(actions.ACTIONS).sort();
const F5_ACTIONS = ['ai-refresh', 'ai-new', 'ai-open', 'ai-delete', 'ai-confirm-yes', 'ai-confirm-no',
  'ai-select-node', 'ai-insert', 'ai-replace', 'ai-set-field', 'ai-set-literal-type', 'ai-field-commit',
  'ai-move-up', 'ai-move-down', 'ai-wrap-if', 'ai-delete-node', 'ai-slot-clear', 'ai-block-remove',
  'ai-validate', 'ai-save', 'ai-save-draft', 'ai-save-as', 'ai-import-open', 'ai-import-close', 'ai-import-apply',
  'ai-close', 'ai-discard-yes', 'ai-discard-no'].sort();
// 事件型动作（由输入框 change 触发，不渲染为按钮）
const EVENT_ONLY = ['ai-field-commit'];

/* ---------- 与浏览器同构的夹具（app.js 的 buildCtx/run 同形） ---------- */

function fakeWin() {
  const map = new Map();
  return {
    map,
    localStorage: {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    },
  };
}

function harness(baseUrl) {
  const win = fakeWin();
  const st = store.createStore(store.initialState());
  const storage = appMod.createStorage(win);
  const raw = apiMod.createApi({ baseUrl });
  const counter = { n: 0, validate: 0 };
  const counting = (fn) => (...a) => { counter.n += 1; return fn(...a); };
  const api = {
    call: counting(raw.call),
    register: counting(raw.register), login: counting(raw.login), logout: counting(raw.logout),
    changePassword: counting(raw.changePassword), me: counting(raw.me),
    warehouse: counting(raw.warehouse), box: counting(raw.box), configs: counting(raw.configs),
    aiList: counting(raw.aiList), assemble: counting(raw.assemble), disassemble: counting(raw.disassemble),
    saveConfig: counting(raw.saveConfig), activateConfig: counting(raw.activateConfig),
    setNickname: counting(raw.setNickname), quickRun: counting(raw.quickRun), replay: counting(raw.replay),
    rankedRun: counting(raw.rankedRun), leaderboard: counting(raw.leaderboard), admin: counting(raw.admin),
    // F5：AI 编辑器的四个出口
    aiCreate: counting(raw.aiCreate),
    aiUpdate: counting(raw.aiUpdate),
    aiDelete: counting(raw.aiDelete),
    aiValidate: (token, input) => { counter.validate += 1; return raw.aiValidate(token, input); },
  };
  const h = {
    win, storage, api, counter,
    state: () => st.getState(),
    dispatch: (a) => st.dispatch(a),
    html: () => render.render(format.viewModel(st.getState())),
    notice: () => (st.getState().notice ? st.getState().notice.text : ''),
    labels: () => [...render.render(format.viewModel(st.getState())).matchAll(/>([^<>]+)<\/button>/g)].map((m) => m[1]),
    form: (values) => { for (const [k, v] of Object.entries(values)) st.dispatch({ type: 'form.set', field: k, value: v }); },
    aiName: (value) => st.dispatch({ type: 'screen.form.set', field: 'aiName', value }),
    // 模拟输入框：input（只记文本，不提交）→ change（提交 + 自动校验）
    typeField: (field, value) => st.dispatch({ type: 'ai.text.set', field, value }),
    commitField: (field) => h.run('ai-field-commit', { field }),
    run: (name, payload) => {
      const ctx = { state: st.getState(), dispatch: (a) => st.dispatch(a), api, format, storage, actions: actions.ACTIONS };
      return Promise.resolve(actions.ACTIONS[name].run(ctx, payload || null));
    },
    signUp: async (username) => {
      h.form({ username, password: PW, confirm: PW });
      await h.run('submit-register');
      assert.equal(h.state().view, 'hub', '注册后应落在主界面（FR-11）');
      return h.state().profile;
    },
  };
  return h;
}

async function withHarness(fn) {
  const s = await startServer({ prefix: 'dl-fe-ai-', level: 'warn' });
  try {
    return await fn(harness(s.baseUrl), s);
  } catch (e) {
    throw e;
  } finally {
    await s.cleanup();
  }
}

// 一个必定合法的程序（含 action）
function okProgram(actionName) {
  return { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: actionName || 'wait' }] } };
}

/* ---------- AE-1 ---------- */

test('AE-1 F5 动作集合 == 注册表 F5 段（双向；事件型动作单列）', () => {
  const registeredF5 = ACTION_NAMES.filter((a) => a.indexOf('ai-') === 0 && a !== 'ai-pick' && a !== 'ai-set');
  assert.deepEqual(registeredF5, F5_ACTIONS,
    `注册表里的 F5 动作与分册 §4 白名单不一致：${registeredF5.join(', ')}`);
  for (const name of F5_ACTIONS) {
    assert.equal(typeof actions.ACTIONS[name].run, 'function', `${name} 缺少 run`);
    assert.ok(actions.ACTIONS[name].label && actions.ACTIONS[name].label.length > 0, `${name} 缺少标签`);
  }
  assert.equal(EVENT_ONLY.length, 1, '事件型动作只有 ai-field-commit');
});

/* ---------- AE-2 ---------- */

test('AE-2 字段三方一致：contract.AI_ITEM_FIELDS == format.js 实读 == 06 §5.2', () => {
  const src = fs.readFileSync(path.join(PUBLIC_DIR, 'format.js'), 'utf8');
  const used = new Set();
  for (const m of src.matchAll(/pick\(\s*(aiItem|aiSaved)\s*,\s*'([^']+)'\s*\)/g)) used.add(m[2]);
  const declared = contract.AI_ITEM_FIELDS.slice().sort();
  const actual = [...used].sort();
  assert.deepEqual(actual, declared, `format.js 实读的 AI 条目字段与 contract 不一致：${actual.join(', ')} vs ${declared.join(', ')}`);
  const doc = fs.readFileSync(DOC6, 'utf8');
  for (const f of declared) assert.ok(doc.includes('items[].' + f), `06 §5.2 未登记 items[].${f}`);
});

/* ---------- AE-3 ---------- */

// 把默认节点放进一个合法上下文（break 必须位于循环体内；call 必须能解析到已定义函数），并补一个 action 满足 no_action_program
function programWithNode(type) {
  const node = aiEd.defaultNodeOf(type);
  const statements = type === 'break'
    ? [{ type: 'loop', kind: 'count', times: { type: 'literal', value: 1 }, body: { type: 'seq', statements: [node, { type: 'action', name: 'wait' }] } }]
    : [node];
  if (type === 'call') {
    // `call` 的默认名要能解析（服务端 unknown_call）——插入动作会经 contextualizeNode 改写为已定义函数名
    const defined = aiEd.collectFunctionNames({ type: 'program', version: 2, body: { type: 'seq', statements } });
    assert.equal(defined.length, 0, '程序里本来没有函数');
    statements.unshift({ type: 'function', name: 'myFunc', body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } });
  }
  if (type === 'set' || type === 'getVar') {
    // 默认变量名 `x` 必须先被 var 声明（服务端 undefined_var）——插入动作会经 contextualizeNode 改写为已声明名
    statements.unshift({ type: 'var', name: 'x', value: { type: 'literal', value: 0 } });
  }
  statements.push({ type: 'action', name: 'wait' });
  return { type: 'program', version: 2, body: { type: 'seq', statements } };
}

test('AE-3 节点表单表 == 服务端真源：16 类默认节点全部通过校验；枚举取值逐个被接受、表外被拒', () => {
  for (const type of aiEd.NODE_TYPES) {
    const v = ast.validate(programWithNode(type), 'mythic');
    assert.equal(v.ok, true,
      `${type} 的默认节点不合法（编辑器给的表单字段/枚举与服务端 ast.js 漂移）：${JSON.stringify(v.errors)}`);
  }
  // 枚举：编辑器给出的每个取值都必须被服务端接受
  const enumCases = [
    ['arith.op', (op) => ({ type: 'arith', op, left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 2 } })],
    ['cmp.op', (op) => ({ type: 'cmp', op, left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 2 } })],
    ['logic.op', (op) => ({ type: 'logic', op, left: { type: 'literal', value: true }, right: { type: 'literal', value: false } })],
  ];
  for (const [key, mk] of enumCases) {
    for (const opt of aiEd.ENUM_SPECS[key]) {
      const p = { type: 'program', version: 2, body: { type: 'seq', statements: [mk(opt.value), { type: 'action', name: 'wait' }] } };
      const v = ast.validate(p, 'mythic');
      assert.equal(v.ok, true, `编辑器提供的 ${key}=${opt.value} 被服务端拒绝：${JSON.stringify(v.errors)}`);
    }
    // 表外取值必须被拒（证明这一列是"受约束"的，而不是随便写）
    const bad = { type: 'program', version: 2, body: { type: 'seq', statements: [mk('%%bad%%'), { type: 'action', name: 'wait' }] } };
    const vb = ast.validate(bad, 'mythic');
    assert.equal(vb.ok, false, `${key} 的表外取值应被拒`);
    assert.ok(vb.errors.some((e) => e.code === 'bad_enum'), `${key} 表外取值应报 bad_enum`);
  }
  // loop.kind：count/while 两值各自补齐必填字段后合法；表外被拒
  for (const kind of ['count', 'while']) {
    const node = kind === 'count'
      ? { type: 'loop', kind: 'count', times: { type: 'literal', value: 2 }, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } }
      : { type: 'loop', kind: 'while', cond: { type: 'cmp', op: '<', left: { type: 'get', path: 'self.hp' }, right: { type: 'literal', value: 50 } }, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
    const v = ast.validate({ type: 'program', version: 2, body: { type: 'seq', statements: [node] } }, 'mythic');
    assert.equal(v.ok, true, `loop.kind=${kind} 的默认写法应合法：${JSON.stringify(v.errors)}`);
  }
  const badLoop = ast.validate({
    type: 'program', version: 2,
    body: { type: 'seq', statements: [{ type: 'loop', kind: 'forever', body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } }] },
  }, 'mythic');
  assert.equal(badLoop.ok, false, 'loop.kind 表外取值应被拒');
  // 动作词汇表：编辑器给的 10 个动作必须是"引擎词汇表内的固定名"或 `skill:skillN`
  const fixed = new Set(AI_LANG.actions.fixed);
  for (const a of aiEd.ACTION_VALUES) {
    const inFixed = fixed.has(a.value);
    const isSkill = /^skill:skill[123]$/.test(a.value);
    assert.ok(inFixed || isSkill, `动作 ${a.value} 既不在引擎词汇表也不是 skill:skillN`);
  }
  assert.equal(aiEd.ACTION_VALUES.length, fixed.size + 3, '动作下拉 = 7 个固定动作 + 3 个技能槽');
});

/* ---------- AE-4 ---------- */

test('AE-4 编辑器地址往返：cmp.left/right 不互相串（§2 R5 回归）', () => {
  const program = {
    type: 'program', version: 2,
    body: {
      type: 'seq',
      statements: [{
        type: 'if',
        cond: { type: 'cmp', op: '<', left: { type: 'get', path: 'self.hp' }, right: { type: 'literal', value: 30 } },
        then: { type: 'seq', statements: [{ type: 'action', name: 'defend' }] },
        else: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] },
      }],
    },
  };
  assert.equal(aiEd.nodeAt(program, 'body.s[0].cond.left').path, 'self.hp');
  assert.equal(aiEd.nodeAt(program, 'body.s[0].cond.right').value, 30);
  // 改 left 不能碰到 right
  const before = JSON.parse(JSON.stringify(program));
  aiEd.setAt(program, 'body.s[0].cond.left', { type: 'get', path: 'enemy.hp' });
  assert.equal(aiEd.nodeAt(program, 'body.s[0].cond.left').path, 'enemy.hp');
  assert.deepEqual(aiEd.nodeAt(program, 'body.s[0].cond.right'), before.body.statements[0].cond.right, 'right 必须原样');
  // 运行时路径口径（.expr 折叠）**不能**用来定位表达式：`cond.left` 与 `cond.right` 会折叠到同一条语句路径
  assert.equal(aiEd.runtimePathOfAddr('body.s[0].cond.left'), 'body.s[0]');
  assert.equal(aiEd.runtimePathOfAddr('body.s[0].cond.right'), 'body.s[0]');
  assert.equal(aiEd.runtimePathOfAddr('body.s[0].then.s[1]'), 'body.s[0].then.s[1]', '语句/结构路径原样');
  // 地址解析：字段名（最后一段）与地址（其余）正确切分
  assert.deepEqual(aiEd.parseFieldName('ai.body.s[1].cond.right'), { addr: 'body.s[1].cond', key: 'right' });
  assert.equal(aiEd.parseFieldName('aiName'), null);
  assert.equal(aiEd.parseFieldName('ai.body'), null);
  // 结构操作：插入/上移下移/包裹/删除
  const p2 = aiEd.emptyProgram();
  assert.equal(aiEd.insertAfter(p2, 'body.s[0]', 'defend' !== '' ? 'action' : 'action'), true);
  assert.equal(p2.body.statements.length, 2);
  assert.equal(aiEd.moveNode(p2, 'body.s[1]', -1), true);
  assert.equal(p2.body.statements[0].type, 'action');
  assert.equal(aiEd.wrapInIf(p2, 'body.s[0]'), true);
  assert.equal(p2.body.statements[0].type, 'if');
  assert.equal(aiEd.removeNode(p2, 'body.s[0]'), true);
  assert.equal(p2.body.statements.length, 1);
  assert.equal(aiEd.removeNode(p2, 'body'), false, '隐式主循环根节点不可删除');
});

/* ---------- AE-5 ---------- */

test('AE-5 前端不复制判决（唯一例外 = 函数重名）；render 零 pick；fetch/innerHTML 单点', () => {
  const files = fs.readdirSync(PUBLIC_DIR).filter((f) => f.endsWith('.js'));
  const renderSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'render.js'), 'utf8');
  assert.equal((renderSrc.match(/pick\(/g) || []).length, 0, 'render.js 不得出现 pick(');
  for (const f of files) {
    const src = fs.readFileSync(path.join(PUBLIC_DIR, f), 'utf8');
    if (f !== 'api.js') assert.ok(!/\bfetch\(/.test(src), `${f} 不得调用 fetch（唯一出口 = api.js）`);
    if (f !== 'app.js') assert.ok(!src.includes('innerHTML'), `${f} 不得写 DOM（唯一写入点 = app.js）`);
  }
  // 唯一的前端判决：函数重名（用户裁决 ⑧）
  const dupProgram = {
    type: 'program', version: 2,
    body: {
      type: 'seq',
      statements: [
        { type: 'function', name: 'g', body: { type: 'seq', statements: [] } },
        { type: 'function', name: 'g', body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } },
        { type: 'action', name: 'wait' },
      ],
    },
  };
  const dups = aiEd.duplicateFunctionNames(dupProgram);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].name, 'g');
  assert.equal(aiEd.duplicateFunctionNames(aiEd.emptyProgram()).length, 0);
  // 编辑器**不**自己判断合法性：非法程序在编辑器里照样可编辑，结论由服务端给
  const bad = { type: 'program', version: 2, body: { type: 'seq', statements: [] } };
  assert.ok(aiEd.treeLines(bad).length >= 0, '非法程序也能渲染（不抛）');
  const st = store.initialState();
  st.view = 'ai-editor';
  st.aiEditor.mode = 'edit';
  st.aiEditor.draft = bad;
  st.aiEditor.validate = null;
  const vm = format.viewModel(st);
  // F5：编辑态改用了**有序区块**（`vm.blocks`）；文本可能分布在若干个 lines 块里 —— 两种形态都收全
  const texts = (vm.blocks || []).filter((b) => b.kind === 'lines')
    .reduce((acc, b) => acc.concat(b.lines), []).concat(vm.lines || []);
  assert.ok(texts.some((l) => l.includes('校验')), '无校验回执时应给出"尚未校验"文案而不是判决');
});

/* ---------- AE-6 ---------- */

test('AE-6 校验错误可定位：服务端 path → 编辑器地址', () => {
  // ⚠️ 这里刻意只用**合法性层**的错误（`undefined_var` / `unknown_call` / `break_outside_loop` /
  //   `branch_without_action`）：`ast.validate` 在结构层报错时会**跳过**合法性层（结构错误优先报告），
  //   混着放会让"错误条数"对不上（F5 首版即踩这个）。
  const program = {
    type: 'program', version: 2,
    body: {
      type: 'seq',
      statements: [
        { type: 'getVar', name: 'never_declared' },
        { type: 'call', name: 'no_such_fn' },
        { type: 'break' },
        {
          type: 'loop', kind: 'count', times: { type: 'literal', value: 2 },
          body: {
            type: 'seq',
            statements: [{
              type: 'if', cond: { type: 'literal', value: true },
              then: { type: 'seq', statements: [] },
              else: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] },
            }],
          },
        },
        { type: 'action', name: 'wait' },
      ],
    },
  };
  const v = ast.validate(program, 'mythic');
  assert.equal(v.ok, false, '这个程序应当不合法（多类合法性错误）');
  assert.ok(v.errors.length >= 4, `应产出多条错误（实际 ${v.errors.length}：${v.errors.map((e) => e.code).join(',')}）`);
  const st = store.initialState();
  st.view = 'ai-editor';
  st.aiEditor.mode = 'edit';
  st.aiEditor.draft = program;
  st.aiEditor.validate = { ok: false, error: { code: 'ai_invalid', message: 'x', details: v.errors } };
  const rows = format.aiErrorRows(st);
  assert.equal(rows.length, v.errors.length, '每条错误一行');
  for (const r of rows) {
    assert.ok(typeof r.addr === 'string' && r.addr.startsWith('body'), `错误行必须能定位到地址：${JSON.stringify(r)}`);
    assert.ok(aiEd.nodeAt(program, r.addr), `地址必须能解析到真实节点：${r.addr}`);
  }
  const html = render.render(format.viewModel(st));
  assert.ok(html.includes('定位'), '错误行必须带「定位」按钮');
  // 结构层错误的 path（如 `….expr`）也要能回退到可解析的地址
  assert.equal(aiEd.addrOfRuntimeErrorPath(program, 'body.s[0].expr'), 'body.s[0]');
  assert.equal(aiEd.addrOfRuntimeErrorPath(program, 'body.s[3].body'), 'body.s[3].body');
  assert.equal(aiEd.addrOfRuntimeErrorPath(program, ''), 'body');
});

/* ---------- AE-7 ---------- */

test('AE-7 真实 HTTP 全链路：草稿 → 打开 → 改好 → 自动校验 → 保存（aiId 不变）→ 绑定 → 删除被拦 → 换掉 → 删除', async () => {
  await withHarness(async (h) => {
    await h.signUp('ae7user');
    await h.run('goto-ai-editor');
    assert.equal(h.state().view, 'ai-editor');
    const starterCount = h.state().aiEditor.list.data.count;
    assert.ok(starterCount >= 1, 'starter 应已登记一条默认 AI');

    // ① 新建 → 默认草稿天生合法 → 自动校验一次
    await h.run('ai-new');
    assert.equal(h.state().aiEditor.mode, 'edit');
    assert.ok(h.counter.validate >= 1, '新建后应自动校验一次（裁决 ⑨）');
    assert.equal(format.aiValidateOk(h.state()), true, '默认程序应当校验通过');

    // ② 名称（屏内输入框）
    h.aiName('端到端AI');

    // ③ 把动作改成 defend（走"选中节点 + 枚举按钮"的真实路径）
    await h.run('ai-select-node', { addr: 'body.s[0]' });
    await h.run('ai-set-field', { addr: 'body.s[0]', field: 'name', value: 'defend' });
    assert.equal(aiEd.nodeAt(h.state().aiEditor.draft, 'body.s[0]').name, 'defend');
    assert.equal(format.aiValidateOk(h.state()), true, '改完仍是合法的（defend 在词汇表内）');

    // ④ 存为草稿 → 列表出现草稿
    await h.run('ai-save-draft');
    assert.match(h.notice(), /已新建/, `保存回执：${h.notice()}`);
    const draftId = h.state().aiEditor.aiId;
    assert.ok(draftId && draftId.indexOf('ai_') === 0, '保存后应拿到 aiId');
    assert.equal(h.state().aiEditor.status, 'draft');
    assert.equal(h.state().aiEditor.dirty, false, '保存后应清 dirty');

    // ⑤ 关闭编辑 → 打开同一条 → 改程序 → 保存（**同一 aiId**、转正式）
    await h.run('ai-close');
    assert.equal(h.state().aiEditor.mode, 'list');
    await h.run('ai-open', { aiId: draftId });
    assert.equal(h.state().aiEditor.aiId, draftId);
    assert.equal(h.state().aiEditor.status, 'draft');
    await h.run('ai-select-node', { addr: 'body.s[0]' });
    await h.run('ai-set-field', { addr: 'body.s[0]', field: 'name', value: 'move_right' });
    await h.run('ai-save');
    assert.equal(h.state().aiEditor.aiId, draftId, '编辑保存不得换 aiId（D-172）');
    assert.equal(h.state().aiEditor.status, 'ready');
    const inList = h.state().aiEditor.list.data.items.find((x) => x.aiId === draftId);
    assert.ok(inList, '列表里应有这条');
    assert.equal(inList.status, 'ready');

    // ⑥ 绑定到出战配置（真实配置接口）→ 删除被拦（409 ai_in_use 文案）
    const ld = h.state().aiEditor.draft;
    const cfg = await h.run('config-open', { slot: 'slot1' });
    void cfg;
    const saved = await h.api.saveConfig(h.state().session.token, 'slot1', {
      loadout: Object.assign({}, h.state().configs.draft.loadout, { ai: ld, aiId: draftId }),
    });
    assert.equal(saved.status, 200, `绑定配置应 200：${saved.raw && saved.raw.slice(0, 200)}`);
    await h.run('ai-close');
    await h.run('ai-delete', { aiId: draftId });
    assert.equal(h.state().aiEditor.confirm.kind, 'delete');
    await h.run('ai-confirm-yes');
    assert.match(h.notice(), /出战配置/, `被出战配置引用必须给出可读文案：${h.notice()}`);
    assert.ok(h.state().aiEditor.list.data.items.some((x) => x.aiId === draftId), '被拦后条目仍在');

    // ⑦ 从出战配置换掉它（换成 starter 的那条）→ 再删 → 200
    const starterId = h.state().aiEditor.list.data.items.find((x) => x.aiId !== draftId).aiId;
    const back = await h.api.saveConfig(h.state().session.token, 'slot1', {
      loadout: Object.assign({}, h.state().configs.draft.loadout, { aiId: starterId }),
    });
    assert.equal(back.status, 200, `换回 starter 应 200：${back.raw && back.raw.slice(0, 200)}`);
    await h.run('ai-delete', { aiId: draftId });
    await h.run('ai-confirm-yes');
    assert.match(h.notice(), /已删除/, `删除回执：${h.notice()}`);
    assert.ok(!h.state().aiEditor.list.data.items.some((x) => x.aiId === draftId), '删除后列表不再包含');
  });
});

/* ---------- AE-10 ---------- */

test('AE-10 多行输入只在「导入 JSON」区块出现，且只有 ai-editor 渲染它（裁决 ③）', () => {
  const st = store.initialState();
  st.view = 'ai-editor';
  st.aiEditor.mode = 'edit';
  st.aiEditor.draft = aiEd.emptyProgram();
  st.aiEditor.name = 'x';
  assert.ok(!render.render(format.viewModel(st)).includes('<textarea'), '未打开导入区时不应渲染 textarea');
  st.aiEditor.importOpen = true;
  st.aiEditor.importText = '{"type":"program"}';
  const html = render.render(format.viewModel(st));
  assert.ok(html.includes('<textarea'), '导入区必须提供多行输入');
  assert.ok(html.includes('name="aiImport"'), '导入框的字段名必须是 aiImport');
  // 其它屏不得出现 textarea
  for (const view of store.VIEWS) {
    const s2 = store.initialState();
    s2.view = view;
    const out = render.render(format.viewModel(s2));
    if (view === 'ai-editor') continue;
    assert.ok(!out.includes('<textarea'), `${view} 屏不应出现多行输入（唯一用途 = AI 编辑器导入）`);
  }
  // 导入成功/失败都要有可见回落
  const bad = aiEd.importProgram('{oops');
  assert.equal(bad.ok, false);
  assert.match(bad.error, /JSON/);
  const good = aiEd.importProgram(JSON.stringify(okProgram()));
  assert.equal(good.ok, true);
});

/* ---------- AE-14（用户实测反馈：看不出逻辑之间的层级关系） ---------- */

test('AE-14 程序树：标题紧跟其内容（有序区块）+ 可见缩进导轨 + 隐式主循环在最外层', () => {
  const nested = {
    type: 'program', version: 2,
    body: {
      type: 'seq',
      statements: [
        {
          type: 'loop', kind: 'count', times: { type: 'literal', value: 3 },
          body: {
            type: 'seq',
            statements: [{
              type: 'if', cond: { type: 'cmp', op: '<', left: { type: 'get', path: 'self.hp' }, right: { type: 'literal', value: 30 } },
              then: { type: 'seq', statements: [{ type: 'action', name: 'defend' }] },
              else: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] },
            }],
          },
        },
        { type: 'action', name: 'wait' },
      ],
    },
  };
  const st = store.initialState();
  st.view = 'ai-editor';
  st.aiEditor.mode = 'edit';
  st.aiEditor.draft = nested;
  st.aiEditor.name = 'X';
  const vm = format.viewModel(st);

  // ① 编辑态必须用**有序区块**（否则 render 会把所有文字行甩到所有行之前 → 标题与树分离）
  assert.ok(Array.isArray(vm.blocks) && vm.blocks.length > 0, '编辑态必须声明 blocks');
  const kinds = vm.blocks.map((b) => b.kind);
  const iTreeHead = kinds.indexOf('lines', kinds.findIndex((k, i) => k === 'lines' && vm.blocks[i].lines.some((l) => l.includes('程序结构'))));
  assert.ok(iTreeHead >= 0, '必须有「程序结构」标题块');
  assert.equal(vm.blocks[iTreeHead + 1].kind, 'rows', '「程序结构」标题的下一个区块必须就是树（rows）');
  const treeRows = vm.blocks[iTreeHead + 1].rows;

  // ② 隐式主循环在最外层（第一行），其余语句一律缩进在它里面
  assert.match(treeRows[0].text, /引擎隐式主循环/, `第一行必须是隐式主循环：${treeRows[0].text}`);
  assert.ok(!treeRows[0].text.startsWith('│'), '根节点本身不带缩进');
  const loopLine = treeRows.find((r) => r.text.indexOf('│ 循环') === 0);
  assert.ok(loopLine, `顶层语句必须缩进一层：${treeRows.map((r) => r.text).join(' / ')}`);

  // ③ 缩进导轨**可见**（`│ ` 而不是被 HTML 折叠掉的普通空格/U+3000 单独使用）
  const guides = (t) => (t.match(/│ /g) || []).length;
  const ifLine = treeRows.find((r) => r.text.includes('如果'));
  const thenLabel = treeRows.find((r) => r.text.includes('那么：'));
  const defendLine = treeRows.find((r) => r.text.includes('动作 defend'));
  const elseLabel = treeRows.find((r) => r.text.includes('否则：'));
  const moveLine = treeRows.find((r) => r.text.includes('动作 move_right'));
  assert.ok(guides(loopLine.text) === 1, `顶层语句 1 层导轨（实际 ${guides(loopLine.text)}）`);
  assert.ok(guides(ifLine.text) === 3, `循环体内的 if 应 3 层导轨（实际 ${guides(ifLine.text)}）`);
  assert.equal(guides(thenLabel.text), guides(elseLabel.text), '同一 if 的「那么/否则」必须在同一层');
  assert.ok(guides(defendLine.text) === guides(thenLabel.text) + 1, '分支内的语句比分支标签再深一层');
  assert.equal(guides(defendLine.text), guides(moveLine.text), '两个分支内的语句同层');

  // ④ 渲染顺序：标题 → 树 → 当前节点表单（用户实测"几乎看不出关系"的直接原因就是顺序错乱）
  const html = render.render(vm);
  const iHead = html.indexOf('程序结构');
  const iRoot = html.indexOf('引擎隐式主循环');
  const iNode = html.indexOf('—— 当前节点');
  assert.ok(iHead !== -1 && iRoot !== -1 && iNode !== -1, '三处标记都必须渲染出来');
  assert.ok(iHead < iRoot, '「程序结构」标题必须在树之前');
  assert.ok(iRoot < iNode, '程序树必须在「当前节点」表单之前');
  // ⑤ 未声明 blocks 的屏不受影响（回归：F1 登录屏的渲染顺序与内容不变）
  const loginVm = format.viewModel(store.initialState());
  assert.equal(loginVm.blocks, undefined, '非 AI 编辑器的屏不得声明 blocks');
  assert.ok(render.render(loginVm).includes('登录'), '登录屏仍正常渲染');
});

/* ---------- AE-12 ---------- */

test('AE-12 实时校验不逐键：连续 input 不发请求；change 提交后只发一次', async () => {
  await withHarness(async (h) => {
    await h.signUp('ae12user');
    await h.run('goto-ai-editor');
    await h.run('ai-new');
    const afterNew = h.counter.validate;
    // 连续敲 5 次（input 事件）→ 不应产生任何校验请求
    await h.run('ai-select-node', { addr: 'body.s[0]' });
    for (const v of ['m', 'mo', 'mov', 'move', 'move_']) {
      h.typeField('ai.body.s[0].name', v);
    }
    assert.equal(h.counter.validate, afterNew, '输入过程中不得逐键发校验请求（防抖）');
    // change 提交一次 → 恰好一次校验
    await h.commitField('ai.body.s[0].name');
    assert.equal(h.counter.validate, afterNew + 1, '提交后应恰好校验一次');
    assert.equal(aiEd.nodeAt(h.state().aiEditor.draft, 'body.s[0]').name, 'move_', '提交后草稿应已更新');
    // 提交后未提交文本被清空（值是草稿里的值）
    assert.equal(h.state().aiEditor.texts['ai.body.s[0].name'], undefined, '提交后应清掉未提交文本');
  });
});
