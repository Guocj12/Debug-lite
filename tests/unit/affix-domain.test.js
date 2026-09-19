'use strict';
/* tests/unit/affix-domain.test.js —— P7-7 遗留项 E-1 / E-2 的闭环断言（2026-09-19）
 *
 * 来源：`docs/reviews/P7-7-wave2-code-review-residual.md` §未修项：
 *   · **E-1** `affix-registry.json` 的 `domain` 字段全仓库**零 JS 消费**，而 `docs/systems/01-items.md:18,56`
 *     称其声明 role/skill/both → 处置：让代码**消费**它（`items.generatePlugin` 域校验 + `schema.js` 前置校验），
 *     本文件既断言"消费真的发生"（含负例），也断言"内容层写错域会被门禁拦住"。
 *   · **E-2** 快照字段 `self.maxMp` / `self.maxSp` **零引用**（属给 AI 作者的只读面）
 *     → 处置：在 `docs/systems/08-ai.md §4.5` 写明用途（= 角色 mp/sp 上限，供阈值判断，非保留字段），
 *     本文件断言"可读（进白名单）且只读（AI 写自己的同名变量也动不了引擎状态）"，并把文档声明变成机器断言。
 *
 * 约束：零依赖；临时目录用 os.tmpdir() 隔离；不改动任何数据表（投毒只作用于临时副本）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const items = require('../../server/core/items.js');
const schema = require('../../server/data/schema.js');
const ast = require('../../server/ai/ast.js');
const runtime = require('../../server/ai/runtime.js');
const runner = require('../../server/runner.js');
const engine = require('../../server/core/engine.js');
const { createLogger } = require('../../shared/log.js');
const { createRng } = require('../../server/core/rng.js');

const REPO = path.join(__dirname, '..', '..');
const DATA = path.join(REPO, 'server', 'data');
const ASSETS = path.join(REPO, 'assets');
const REGISTRY = require('../../server/data/affix-registry.json');
const PLUGINS = require('../../server/data/plugins.json').plugins;

// ---------- E-1：词条适用域 domain 被消费 ----------

test('E1-1 注册表数据自洽：domain 取值合法（role/skill/both）且每个插件的词条都适用于该类别', () => {
  const vocab = [...Object.keys(REGISTRY._domains), 'both'];
  const map = REGISTRY._domainOfKind;
  assert.deepEqual(map, { rolePlugin: 'role', skillPlugin: 'skill' }, 'kind→域 映射必须由注册表声明（代码不另立清单）');
  const entries = Object.entries(REGISTRY.affixes);
  assert.ok(entries.length > 20, '词条注册表不应为空');
  for (const [id, def] of entries) {
    assert.ok(vocab.includes(def.domain), `affix ${id} 的 domain=${JSON.stringify(def.domain)} 非法（应为 ${vocab.join('/')}）`);
  }
  let roleOnly = 0;
  let skillOnly = 0;
  for (const p of PLUGINS) {
    const want = map[p.kind];
    for (const a of p.affixes) {
      const def = REGISTRY.affixes[a.id];
      assert.ok(def, `插件 ${p.id} 引用了未登记词条 ${a.id}`);
      if (def.domain !== 'both') {
        assert.equal(def.domain, want, `插件 ${p.id}(${p.kind}) 的词条 ${a.id} 域=${def.domain} 不适用于该类别`);
        if (want === 'role') roleOnly += 1; else skillOnly += 1;
      }
    }
  }
  assert.ok(roleOnly > 0 && skillOnly > 0, `两类域都应有实例（role ${roleOnly} / skill ${skillOnly}）`);
  // 三档并存：both 域确实存在（否则"域校验"退化成"类别校验"）
  assert.ok(entries.some(([, d]) => d.domain === 'both'), '应有 domain=both 的词条');
});

test('E1-2 消费（正例）：域匹配时词条保留 —— rolePlugin×role 与 skillPlugin×skill 都照常生成', () => {
  const rng = createRng(11);
  const role = items.generatePlugin('rolePlugin', 'rare', rng, [PLUGIN_DEF('t_role', 'rolePlugin', 'atk_pct')]);
  assert.equal(role.affixes.length, 1);
  assert.equal(role.affixes[0].id, 'atk_pct');
  const skill = items.generatePlugin('skillPlugin', 'rare', rng, [PLUGIN_DEF('t_skill', 'skillPlugin', 'mult_up')]);
  assert.equal(skill.affixes.length, 1);
  assert.equal(skill.affixes[0].id, 'mult_up');
  // both 域在两个类别都保留
  const both = items.generatePlugin('rolePlugin', 'rare', rng, [PLUGIN_DEF('t_both', 'rolePlugin', 'crit_chance')]);
  assert.equal(both.affixes.length, 1);
  assert.equal(both.affixes[0].id, 'crit_chance');
});

test('E1-3 消费（负例）：rolePlugin 挂 skill 专属词条 → 该词条被跳过并记 items.affix.domain warn', () => {
  const logger = createLogger({ level: 'all' });
  const p = items.withLogger(logger).generatePlugin('rolePlugin', 'rare', createRng(3),
    [PLUGIN_DEF('t_bad', 'rolePlugin', 'mult_up')]);
  assert.deepEqual(p.affixes, [], '不适用的词条必须被跳过（否则会静默失效：面板聚合读不到 mult_up）');
  const warns = logger.records.filter((r) => r.event === 'items.affix.domain');
  assert.equal(warns.length, 1, '必须记一条 warn（可观测，不静默）');
  assert.equal(warns[0].channel, 'items');
  assert.equal(warns[0].data.affixId, 'mult_up');
  assert.equal(warns[0].data.domain, 'skill');
  assert.equal(warns[0].data.kind, 'rolePlugin');
  assert.match(warns[0].msg, /不适用于 rolePlugin/);
});

test('E1-4 消费（负例）：skillPlugin 挂 role 专属词条 → 被跳过并记 warn（对称）', () => {
  const logger = createLogger({ level: 'all' });
  const p = items.withLogger(logger).generatePlugin('skillPlugin', 'epic', createRng(4),
    [PLUGIN_DEF('t_bad2', 'skillPlugin', 'atk_flat')]);
  assert.deepEqual(p.affixes, []);
  assert.equal(logger.records.filter((r) => r.event === 'items.affix.domain').length, 1);
  assert.match(logger.records.find((r) => r.event === 'items.affix.domain').msg, /不适用于 skillPlugin/);
});

test('E1-5 未登记词条仍按旧语义处置：warn items.affix.unknown 并保留（域校验不改变该分支）', () => {
  const logger = createLogger({ level: 'all' });
  const p = items.withLogger(logger).generatePlugin('rolePlugin', 'rare', createRng(5),
    [PLUGIN_DEF('t_unk', 'rolePlugin', 'not_registered_affix')]);
  assert.equal(p.affixes.length, 1, '未登记词条仍保留（历史语义，由 gate 项 4 拦配置错误）');
  assert.equal(logger.records.filter((r) => r.event === 'items.affix.unknown').length, 1);
  assert.equal(logger.records.filter((r) => r.event === 'items.affix.domain').length, 0);
});

test('E1-6 门禁前置：内容层写错域 / 注册表 domain 非法 → validateStructure 必须 FAIL', () => {
  withDataRoot((root) => {
    const p = readJSON(root, 'plugins.json');
    const plugged = p.plugins.find((x) => x.kind === 'rolePlugin');
    plugged.affixes.push({ id: 'mult_up', desc: '技能专属词条错挂角色插件', params: { v: 0.1 } });
    writeJSON(root, 'plugins.json', p);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, 'assets'));
    assert.equal(r.ok, false, '错域必须被门禁拦住（否则运行期才 warn）');
    assert.match(r.detail, /mult_up/);
    assert.match(r.detail, /domain=skill/);
  });
  withDataRoot((root) => {
    const reg = readJSON(root, 'affix-registry.json');
    reg.affixes.atk_pct.domain = 'anima';
    writeJSON(root, 'affix-registry.json', reg);
  }, (root) => {
    const r = schema.validateStructure(root, path.join(root, 'assets'));
    assert.equal(r.ok, false);
    assert.match(r.detail, /atk_pct: domain 非法/);
  });
});

test('E1-7 不误报：真实数据表在新增域校验下仍全过', () => {
  const r = schema.validateStructure(DATA, ASSETS);
  assert.equal(r.ok, true, `真实表必须通过：${r.detail}`);
  assert.equal(schema.validate(DATA, ASSETS).ok, true);
});

// ---------- E-2：self.maxMp / self.maxSp 可读且只读 ----------

test('E2-1 可读：读取 self|enemy.maxMp / maxSp 的 AI 程序必须通过校验（进白名单，不是保留字段）', () => {
  for (const side of ['self', 'enemy']) {
    for (const f of ['maxMp', 'maxSp']) {
      const prog = P(seq([ifGt(`${side}.${f}`, 999999, 'wait', 'wait')]));
      const v = ast.validate(prog, 'mythic');
      assert.equal(v.ok, true, `${side}.${f} 应可读：${JSON.stringify(v.errors)}`);
    }
  }
});

test('E2-2 取值：快照的 self.maxMp/maxSp = 角色 mp/sp 上限（与引擎上限同源）', () => {
  const { snap, state } = battleSnap();
  assert.equal(snap.self.maxMp, state.players.p1.maxMp);
  assert.equal(snap.self.maxSp, state.players.p1.maxSp);
  assert.equal(snap.enemy.maxMp, state.players.p2.maxMp);
  assert.equal(snap.enemy.maxSp, state.players.p2.maxSp);
  assert.ok(snap.self.maxMp > 0 && snap.self.maxSp > 0);
});

test('E2-3 只读：快照是值拷贝 —— 改写副本不影响引擎状态，且不是同一引用', () => {
  const { snap, state } = battleSnap();
  assert.notEqual(snap.self, state.players.p1, 'self 必须是副本（不泄漏引擎对象）');
  const before = { mp: state.players.p1.maxMp, sp: state.players.p1.maxSp };
  snap.self.maxMp = 1;
  snap.self.maxSp = 2;
  assert.equal(state.players.p1.maxMp, before.mp, '改写副本不得影响引擎 maxMp');
  assert.equal(state.players.p1.maxSp, before.sp, '改写副本不得影响引擎 maxSp');
});

test('E2-4 只读（语言层）：AI 可以声明/写入自己的同名变量，但碰不到快照与引擎', () => {
  const prog = P(seq([
    { type: 'var', name: 'self.maxMp', value: lit(1) },
    { type: 'set', name: 'self.maxMp', value: lit(2) },
    act('wait'),
  ]));
  assert.equal(ast.validate(prog, 'mythic').ok, true, '同名变量合法（它只是 AI 自己的变量表条目）');
  const { snap, state } = battleSnap();
  const ctx = runtime.createContext(prog);
  const r = runtime.resume(ctx, snap, { chance: () => false });
  assert.equal(r.action, 'wait');
  assert.equal(runtime.getVar(ctx, 'self.maxMp'), 2, '写的是 AI 自己的变量');
  assert.equal(snap.self.maxMp, 40, '快照值不变');
  assert.equal(state.players.p1.maxMp, 40, '引擎状态不变 → 快照字段对 AI 只读');
});

test('E2-5 文档契约：docs/systems/08-ai.md §4.5 必须写明 maxMp/maxSp 的用途（是上限、供阈值判断、非保留字段）', () => {
  const doc = fs.readFileSync(path.join(REPO, 'docs', 'systems', '08-ai.md'), 'utf8');
  const sec = doc.slice(doc.indexOf('### 4.5'), doc.indexOf('### 4.6'));
  assert.match(sec, /maxMp/, '§4.5 应提到 maxMp');
  assert.match(sec, /maxSp/, '§4.5 应提到 maxSp');
  assert.match(sec, /上限/, '用途必须写明是"上限"');
  assert.match(sec, /不是保留字段|用途/, '必须明确不是保留字段并给出 AI 作者的用法');
  assert.match(sec, /min\(p\.maxMp|engine\.js/, '应指向真实消费点（引擎回蓝/回体封顶）');
});

// ---------- 夹具 ----------

function PLUGIN_DEF(id, kind, affixId) {
  return {
    id, kind, slot: kind === 'rolePlugin' ? 'atk' : 'melee',
    name: id, desc: id, affixes: [{ id: affixId, desc: 'x', params: { v: 0.1 } }],
    pointCostByTier: [1, 2, 3], drop: true,
  };
}

const P = (body) => ({ type: 'program', version: 2, body });
const seq = (statements) => ({ type: 'seq', statements });
const lit = (value) => ({ type: 'literal', value });
const act = (name) => ({ type: 'action', name });
const ifGt = (pathStr, n, t, e) => ({
  type: 'if',
  cond: { type: 'cmp', op: '>', left: { type: 'get', path: pathStr }, right: lit(n) },
  then: seq([act(t)]), else: seq([act(e)]),
});

// 一局最小战斗 + p1 视角快照（不跑 tick，只投影 tick=0）
function battleSnap() {
  const p1 = runner.baselinePlayer('p1');
  const p2 = runner.baselinePlayer('p2');
  const b = engine.createBattle(undefined, { seed: 1, players: { p1, p2 }, logger: createLogger({ level: 'silent' }) });
  return { snap: runner.projectSnapshot(b.state, 'p1'), state: b.state, battle: b };
}

// 数据表投毒夹具（复制真实表 + assets 到 os.tmpdir()，与 data-schema.test.js 同手法）
function withDataRoot(mutate, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-affix-'));
  for (const f of fs.readdirSync(DATA)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(DATA, f), path.join(root, f));
  }
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  for (const f of fs.readdirSync(ASSETS)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(ASSETS, f), path.join(root, 'assets', f));
  }
  try {
    mutate(root);
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const readJSON = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const writeJSON = (dir, file, obj) => fs.writeFileSync(path.join(dir, file), JSON.stringify(obj, null, 1), 'utf8');
