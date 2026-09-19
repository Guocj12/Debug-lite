'use strict';
/* tests/integration/gate-poison-extra.test.js —— gate 项 8 / 项 9 的 **FAIL 分支投毒**（P7-7 §P0 第⑦条）
 *
 * 背景（审查 §B6）：gate 九项里只有项 8（日志冒烟）与项 9（接口冒烟）**没有任何投毒用例**：
 *   · `checkLogSmoke` 的 4 个 FAIL 分支（关键事件缺失 / cid 链缺 cast / cid 链缺 spawn-hit-end /
 *     trace≠silent 帧不一致）从未触发；
 *   · `checkApiSmoke` 的 FAIL 分支（health 信封异常 / data 异常 / CLI 退出码非 0）从未触发；
 *   · 既有 `GX-12/GX-13` 只测 pass 与 pending（前置产物缺失）。
 *
 * 手法（沿用 `GX-9` 的 `projectRoot` fixture）：在 os.tmpdir() 造一个**最小假仓库**，
 *   用桩 `server/core/{engine,skills}.js`（项 8）与桩 `server/index.js` + `cli/index.js`（项 9）
 *   精确制造每一种错 → 断言 `status==='fail'` 且 detail 指向造错内容。
 *   真检查器的其余部分（shared/log.js、事件名规范、HTTP 客户端、CLI 调用协议）都是**真实**代码。
 *
 * 约束：零依赖；不 spawn 子进程；端口用 listen(0)（与 gate 项 9 同手法）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const gate = require('../../scripts/gate.js');

function makeProject(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-gate-poison-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return root;
}

async function runOn(files, checkFn) {
  const root = makeProject(files);
  try {
    return await checkFn({ projectRoot: root });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---------- 项 8：checkLogSmoke 的桩引擎 ----------

// 桩 skills.instantiateSkill：只需返回一个对象（真检查器只把它塞进 players[].skills）
const STUB_SKILLS = "'use strict';\nmodule.exports = { instantiateSkill: (id, tier) => ({ id, tier, params: {} }) };\n";

// expect 事件集（与 gate.js:487 的关键集逐字一致）
const KEY_EVENTS = ['battle.create', 'tick.begin', 'tick.step', 'tick.end', 'move.resolve', 'resource.regen', 'battle.judge', 'battle.end'];

/**
 * 生成桩 engine.js。
 * mode：
 *   'ok'            事件齐全 + cid 链顺序正确 + diffs 与日志级别无关 → pass（对照）
 *   'missing-event' 缺 battle.judge → '关键事件缺失'
 *   'no-cast'       无 skill.cast → 'cid 链事件缺失：skill.cast'
 *   'hit-first'     命中先于生成（乱序）→ 'cid 链事件缺失（spawn/hit/end）'
 *   'silent-drift'  diffs 随日志级别变化 → 'trace 与 silent 帧输出不一致'
 */
function stubEngine(mode) {
  return [
    "'use strict';",
    `const KEY = ${JSON.stringify(KEY_EVENTS)};`,
    'function mkRun(logger) {',
    '  const emit = (event, data) => logger.log("info", "engine", event, "fixture", data || {});',
    '  return {',
    '    runFull() {',
    mode === 'missing-event' ? '      for (const e of KEY) if (e !== "battle.judge") emit(e, {});' : '',
    mode === 'missing-event' ? '      emit("tick.end", {});' : '',
    mode === 'no-cast' ? '      for (const e of KEY) emit(e, {});' : '',
    mode === 'hit-first'
      ? [
        '      for (const e of KEY) emit(e, {});',
        '      emit("skill.cast", { cid: "c1" });',
        '      emit("bullet.hit", { cid: "c1" });   // 乱序：hit 先于 spawn',
        '      emit("bullet.spawn", { cid: "c1" });',
        '      emit("tick.end", { cid: "c1" });',
      ].join('\n') : '',
    (mode === 'ok' || mode === 'silent-drift')
      ? [
        '      for (const e of KEY) emit(e, {});',
        '      emit("skill.cast", { cid: "c1" });',
        '      emit("bullet.spawn", { cid: "c1" });',
        '      emit("bullet.hit", { cid: "c1" });',
        '      emit("tick.end", { cid: "c1" });',
      ].join('\n') : '',
    mode === 'silent-drift'
      ? '      return { diffs: [{ level: logger.getLevel() }], ticks: 3, winner: "p1" };'
      : '      return { diffs: [{ tick: 1, hp: 100 }], ticks: 3, winner: "p1" };',
    '    },',
    '  };',
    '}',
    'module.exports = { createBattle: (_cfg, opts) => mkRun(opts.logger) };',
  ].filter((l) => l !== '').join('\n') + '\n';
}

const LOG_SMOKE_FILES = (mode) => ({
  '.audit/golden-battle.js': '/* fixture：仅为激活项 8（真检查器只判断其存在） */\n',
  'server/core/skills.js': STUB_SKILLS,
  'server/core/engine.js': stubEngine(mode),
});

test('GX-P1 checkLogSmoke 对照：桩引擎事件齐全 + cid 链正确 + 帧一致 → pass（证明失败来自造错）', async () => {
  const r = await runOn(LOG_SMOKE_FILES('ok'), gate.checkLogSmoke);
  assert.equal(r.status, 'pass', r.detail);
  assert.match(r.detail, /事件齐全 \+ cid 链 \+ 与 silent 逐帧一致/);
});

test('GX-P2 项 8 投毒：关键事件 battle.judge 缺失 → FAIL', async () => {
  const r = await runOn(LOG_SMOKE_FILES('missing-event'), gate.checkLogSmoke);
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /关键事件缺失：battle\.judge/);
});

test('GX-P3 项 8 投毒：cid 链缺 skill.cast → FAIL', async () => {
  const r = await runOn(LOG_SMOKE_FILES('no-cast'), gate.checkLogSmoke);
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /cid 链事件缺失：skill\.cast/);
});

test('GX-P4 项 8 投毒：cid 链乱序（bullet.hit 先于 bullet.spawn）→ FAIL', async () => {
  const r = await runOn(LOG_SMOKE_FILES('hit-first'), gate.checkLogSmoke);
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /cid 链事件缺失（spawn\/hit\/end）/);
  // 实测记录（P7-7 §B6 的一处新发现）：gate.js:497 的 `!(c1<c2 && c2<c3 && c3<c4)` 是**不可达分支** ——
  //   c2/c3/c4 由 `findIndex(i > 前一个)` 求得，故顺序天然成立；乱序只能落到上面这条"缺失"分支。
  //   本用例断言的是"乱序必然 FAIL"，不断言具体分支文字（避免把死分支当成有效保护）。
});

test('GX-P5 项 8 投毒：日志影响确定性（trace 与 silent 帧不一致）→ FAIL', async () => {
  const r = await runOn(LOG_SMOKE_FILES('silent-drift'), gate.checkLogSmoke);
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /trace 与 silent 帧输出不一致/);
});

// ---------- 项 9：checkApiSmoke 的桩服务端 / 桩 CLI ----------

const STUB_SERVER = (health) => [
  "'use strict';",
  "const http = require('node:http');",
  `const HEALTH = ${JSON.stringify(health)};`,
  'module.exports = {',
  '  start() {',
  '    return new Promise((resolve) => {',
  '      const server = http.createServer((req, res) => {',
  "        res.setHeader('content-type', 'application/json');",
  "        if (req.url === '/api/v1/health') { res.writeHead(200); res.end(JSON.stringify(HEALTH)); return; }",
  "        if (req.url === '/api/v1/data/battle-config') { res.writeHead(200); res.end(JSON.stringify({ ok: true, data: { cellPx: 64 } })); return; }",
  "        res.writeHead(404); res.end('{}');",
  '      });',
  "      server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => new Promise((r) => server.close(() => r())) }));",
  '    });',
  '  },',
  '};',
].join('\n') + '\n';

const STUB_CLI = (rc) => `'use strict';\nmodule.exports = { main: async () => ${rc} };\n`;

const API_SMOKE_FILES = (opts) => ({
  'server/index.js': STUB_SERVER(opts.health),
  'cli/index.js': STUB_CLI(opts.rc),
});

test('GX-P6 checkApiSmoke 对照：health/data 正常 + CLI 退出码 0 → pass', async () => {
  const r = await runOn(API_SMOKE_FILES({ health: { ok: true }, rc: 0 }), gate.checkApiSmoke);
  assert.equal(r.status, 'pass', r.detail);
  assert.match(r.detail, /health\/data 端点 \+ CLI 闭环/);
});

test('GX-P7 项 9 投毒：health 信封异常（ok!==true）→ FAIL', async () => {
  const r = await runOn(API_SMOKE_FILES({ health: { ok: false, reason: 'fixture' }, rc: 0 }), gate.checkApiSmoke);
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /health 信封异常/);
  assert.ok(!/CLI 闭环退出码/.test(r.detail), 'CLI 正常时不应报 CLI 问题');
});

test('GX-P8 项 9 投毒：CLI 退出码非 0 → FAIL', async () => {
  const r = await runOn(API_SMOKE_FILES({ health: { ok: true }, rc: 1 }), gate.checkApiSmoke);
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /CLI 闭环退出码 health=1 data=1/);
});

test('GX-P9 项 9 投毒：data 端点返回体异常（cellPx 不符）→ FAIL（第三条 FAIL 分支）', async () => {
  const files = API_SMOKE_FILES({ health: { ok: true }, rc: 0 });
  // 篡改桩服务端：data 返回 cellPx=63
  files['server/index.js'] = files['server/index.js'].replace('cellPx: 64', 'cellPx: 63');
  const r = await runOn(files, gate.checkApiSmoke);
  assert.equal(r.status, 'fail', r.detail);
  assert.match(r.detail, /data battle-config 异常/);
});
