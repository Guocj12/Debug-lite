'use strict';
/* tests/frontend/fe-spec-poison.test.js —— fe-spec 检查器 C3/C4/C7/C9 **投毒**（P7-7 §P0 第⑦条 / §⑤ 盲区 2）
 *
 * 为什么必须存在（审查 §B6 投毒矩阵）：
 *   · C3（僵尸动作）与 C4（七屏/可达/goto 目标）此前**只有 pass 断言**（FE-SPEC-3），失败分支从未触发；
 *   · C7（文件清单一致）**连一条正断言都没有** —— 只靠 FE-SPEC-1 的 `failed.length===0` 间接覆盖；
 *   · C9（实现侧 data-action/data-id 命中注册表）在 `public/js` 不存在时**恒 pass**
 *     （旧实现 `fe-spec-check.js:448-450`），而 FE-SPEC-1 却断言"C1–C9 全绿" → **虚假保证**。
 *
 * 本次同时加了注入缝：`checkSpec({ repoRoot, publicDir })`（C6/C8 的后端模块、C7/C9 的实现目录），
 *   于是无需真的拥有前端实现，就能在 os.tmpdir() 里造出"实现文件未登记 / data-action 未命中"等错。
 *
 * 三组断言：
 *   ① 对照：真实仓库 → C1–C9 全绿，且 C9 明确 **applicable=false**（未生效 ≠ 已核对）；
 *   ② 投毒：C3/C4×3/C7×2/C9 → 必须 FAIL 且 detail 指向造错内容；
 *   ③ 正断言：C7/C9 在"有实现"的 fixture 上必须真的跑过判定（applicable=true 且计数 > 0）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const check = require('../../scripts/fe-spec-check.js');

const REPO = path.join(__dirname, '..', '..');
const SPEC = path.join(REPO, 'docs', 'frontend-spec.md');

// ---------- fixture ----------

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 复制真实文档到临时目录（可选改写文本） */
function withSpec(mutate) {
  const dir = mkTmp('dl-fespec-');
  const file = path.join(dir, 'frontend-spec.md');
  const text = fs.readFileSync(SPEC, 'utf8');
  fs.writeFileSync(file, mutate ? mutate(text) : text, 'utf8');
  return { file, dir };
}

/** 复制真实文档并**改写注册表 JSON**（围栏内容整体替换；用函数式替换避免 $ 语义） */
function withRegistry(mutateReg) {
  return withSpec((text) => {
    const raw = check.fenced(text, 'json', 'fe-spec-registry');
    assert.ok(raw, '真实文档必须有 ```json fe-spec-registry 围栏');
    const reg = JSON.parse(raw);
    mutateReg(reg);
    return text.replace(raw, () => JSON.stringify(reg, null, 2));
  });
}

/** 造一个"有实现"的 public/js（root/public/js/...），返回 {root, publicDir} */
function withPublicJs(files) {
  const root = mkTmp('dl-fepub-');
  const publicDir = path.join(root, 'public', 'js');
  fs.mkdirSync(publicDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(publicDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return { root, publicDir };
}

function itemOf(res, id) {
  return res.items.find((i) => i.id === id);
}

function cleanup(...dirs) {
  for (const d of dirs) if (d) fs.rmSync(d, { recursive: true, force: true });
}

// ---------- ① 对照 ----------

test('FE-P0 对照：真实仓库 C1–C9 全绿；C9 因 public/js 未落地必须标 applicable=false（关闭虚假保证）', () => {
  const res = check.checkSpec({});
  const failed = res.items.filter((i) => i.status === 'fail');
  assert.equal(failed.length, 0, `真实仓库应全绿：${failed.map((f) => `${f.id} ${f.detail}`).join(' | ')}`);
  const c9 = itemOf(res, 'C9');
  assert.equal(c9.status, 'pass');
  assert.equal(c9.applicable, false, 'public/js 不存在时 C9 未生效 → 不得当作实现侧证据');
  assert.match(c9.detail, /未生效/, 'detail 必须显式说明"未生效"');
  // 其余项都是真的跑过判定
  for (const it of res.items) {
    if (it.id === 'C9') continue;
    assert.equal(it.applicable, true, `${it.id} 应标 applicable=true`);
  }
});

test('FE-P0b 注入缝向后兼容：显式 repoRoot/publicDir = 真实仓库时结果与无参一致', () => {
  const a = check.checkSpec({});
  const b = check.checkSpec({ repoRoot: REPO, publicDir: path.join(REPO, 'public', 'js') });
  assert.deepEqual(b.items.map((i) => [i.id, i.status]), a.items.map((i) => [i.id, i.status]));
});

// ---------- ② 投毒：C3 / C4 ----------

test('FE-P1 C3 投毒：注册表新增一个无任何按钮引用的动作 → C3 必须 FAIL（僵尸动作）', () => {
  const { file, dir } = withRegistry((reg) => {
    reg.actions.push({ type: 'ghost/zombie', effect: false, desc: '没有任何按钮引用它' });
  });
  try {
    const res = check.checkSpec({ specFile: file });
    const c3 = itemOf(res, 'C3');
    assert.equal(c3.status, 'fail', `僵尸动作必须被抓：${JSON.stringify(c3)}`);
    assert.match(c3.detail, /ghost\/zombie/);
    assert.equal(res.ok, false);
  } finally { cleanup(dir); }
});

test('FE-P2 C4 投毒：注册表删掉一屏 → 必须 FAIL，并记录"C4 缺屏分支被 C1 遮蔽"（死分支）', () => {
  const { file, dir } = withRegistry((reg) => {
    reg.screens = reg.screens.filter((s) => s.id !== 'replay');
  });
  try {
    const res = check.checkSpec({ specFile: file });
    assert.equal(res.ok, false, '缺屏必须 FAIL');
    const c1 = itemOf(res, 'C1');
    assert.match(c1.detail, /注册表缺少屏幕 replay/);
    // 关键实测：C4 自己的 `缺屏幕` 分支**永远到不了** —— C1 先拦且 checkSpec 在 C1 fail 时短路。
    //   （C1 与 C4 都对 SCREEN_IDS 做齐全性判定，C4 那份是死代码；此处钉死该事实，避免误以为 C4 覆盖了缺屏。）
    assert.equal(itemOf(res, 'C4'), undefined, 'C1 fail 时不应继续跑 C4（短路语义）');
  } finally { cleanup(dir); }
});

test('FE-P3 C4 投毒：删掉通往 replay 的 goto → C4 必须 FAIL（从 menu 不可达）', () => {
  const { file, dir } = withRegistry((reg) => {
    for (const s of reg.screens) {
      s.buttons = s.buttons.filter((b) => !(b.action === 'goto' && b.payload && b.payload.screen === 'replay'));
    }
  });
  try {
    const res = check.checkSpec({ specFile: file });
    const c4 = itemOf(res, 'C4');
    assert.equal(c4.status, 'fail', `不可达必须被抓：${JSON.stringify(c4)}`);
    assert.match(c4.detail, /replay 从 menu 不可达/);
    // 不得误伤：replay 自身仍有 goto 出口 → 不应报"进去出不来"
    assert.ok(!/没有任何 goto 出口/.test(c4.detail), c4.detail);
  } finally { cleanup(dir); }
});

test('FE-P4 C4 投毒：goto 指向不存在的屏 → C4 必须 FAIL（goto 目标不存在）', () => {
  const { file, dir } = withRegistry((reg) => {
    const battle = reg.screens.find((s) => s.id === 'battle');
    const b = battle.buttons.find((x) => x.action === 'goto' && x.payload && x.payload.screen === 'replay');
    b.payload.screen = 'ghost_screen';
  });
  try {
    const res = check.checkSpec({ specFile: file });
    const c4 = itemOf(res, 'C4');
    assert.equal(c4.status, 'fail');
    assert.match(c4.detail, /goto 目标不存在: ghost_screen/);
  } finally { cleanup(dir); }
});

test('FE-P4b C4 不误报：把 editor 的 goto 出口换成 retry_boot → 仍 pass（retry_boot 也算出口）', () => {
  const { file, dir } = withRegistry((reg) => {
    const editor = reg.screens.find((s) => s.id === 'editor');
    let changed = 0;
    for (const b of editor.buttons) if (b.action === 'goto') { b.action = 'retry_boot'; delete b.payload; changed += 1; }
    assert.ok(changed > 0, 'fixture 前提：editor 屏原本有 goto 出口');
  });
  try {
    const res = check.checkSpec({ specFile: file });
    assert.equal(itemOf(res, 'C4').status, 'pass', itemOf(res, 'C4').detail);
  } finally { cleanup(dir); }
});

// ---------- ③ C7：正断言 + 投毒 ----------

test('FE-P7 C7 正断言：清单内的实现文件 → C7 真的跑过磁盘比对并 pass（此前连正断言都没有）', () => {
  const pub = withPublicJs({ 'api/client.js': '/* fixture */' });
  try {
    const res = check.checkSpec({ publicDir: pub.publicDir });
    const c7 = itemOf(res, 'C7');
    assert.equal(c7.status, 'pass', c7.detail);
    assert.equal(c7.applicable, true);
    assert.match(c7.detail, /文件清单与文中引用一致（\d+ 个条目）/, '必须给出条目数（证明清单解析成功）');
  } finally { cleanup(pub.root); }
});

test('FE-P8 C7 投毒：public/js 里有未登记的实现文件 → C7 必须 FAIL', () => {
  const pub = withPublicJs({ 'ghost_module.js': '/* 不在 §1.2 清单内 */' });
  try {
    const res = check.checkSpec({ publicDir: pub.publicDir });
    const c7 = itemOf(res, 'C7');
    assert.equal(c7.status, 'fail', `未登记实现文件必须被抓：${JSON.stringify(c7)}`);
    assert.match(c7.detail, /实现文件未在清单登记: public\/js\/ghost_module\.js/);
  } finally { cleanup(pub.root); }
});

test('FE-P9 C7 投毒：§1.2 清单围栏被清空 → C7 必须 FAIL（清单解析为空）', () => {
  const { file, dir } = withSpec((t) => t.replace('```public', '```public\n```\n```public'));
  try {
    const res = check.checkSpec({ specFile: file });
    const c7 = itemOf(res, 'C7');
    assert.equal(c7.status, 'fail', `清单为空必须被抓：${JSON.stringify(c7)}`);
    assert.match(c7.detail, /目录清单解析为空|实现文件未在清单登记/);
  } finally { cleanup(dir); }
});

// ---------- ④ C9：正断言 + 投毒（含"恒 pass 虚假保证"的封堵） ----------

test('FE-P10 C9 正断言：实现文件的 data-action/data-id 命中注册表 → pass 且计数 > 0', () => {
  const text = fs.readFileSync(SPEC, 'utf8');
  const reg = JSON.parse(check.fenced(text, 'json', 'fe-spec-registry'));
  const goodId = reg.screens[0].buttons[0].dataId;
  const pub = withPublicJs({
    'api/client.js': `const a = 'data-action="goto"'; const b = 'data-id="${goodId}"';`,
  });
  try {
    const res = check.checkSpec({ publicDir: pub.publicDir });
    const c9 = itemOf(res, 'C9');
    assert.equal(c9.status, 'pass', c9.detail);
    assert.equal(c9.applicable, true, '有实现时 C9 必须 applicable=true');
    assert.match(c9.detail, /实现侧 1 处 data-action \/ 1 处 data-id/);
  } finally { cleanup(pub.root); }
});

test('FE-P11 C9 投毒：data-action 不在动作表 → C9 必须 FAIL', () => {
  const pub = withPublicJs({ 'api/client.js': 'const a = \'data-action="ghost/action"\';' });
  try {
    const res = check.checkSpec({ publicDir: pub.publicDir });
    const c9 = itemOf(res, 'C9');
    assert.equal(c9.status, 'fail', `未命中动作表必须被抓：${JSON.stringify(c9)}`);
    assert.match(c9.detail, /data-action='ghost\/action' 不在动作表/);
  } finally { cleanup(pub.root); }
});

test('FE-P12 C9 投毒：data-id 不在注册表 → C9 必须 FAIL', () => {
  const pub = withPublicJs({ 'api/client.js': 'const a = \'data-id="btn_ghost_missing"\';' });
  try {
    const res = check.checkSpec({ publicDir: pub.publicDir });
    const c9 = itemOf(res, 'C9');
    assert.equal(c9.status, 'fail', `未命中注册表必须被抓：${JSON.stringify(c9)}`);
    assert.match(c9.detail, /data-id='btn_ghost_missing' 不在注册表/);
  } finally { cleanup(pub.root); }
});

test('FE-P13 C9 注入缝本身：publicDir 不存在 → pass 但 applicable=false；不存在不得被当成"已核对"', () => {
  const res = check.checkSpec({ publicDir: path.join(os.tmpdir(), 'dl-no-such-publicjs-9527') });
  const c9 = itemOf(res, 'C9');
  assert.equal(c9.status, 'pass');
  assert.equal(c9.applicable, false);
  assert.match(c9.detail, /尚未实现/);
});

// ---------- ⑤ 解析器分支（围栏/表格）：R-1 CRLF 回归 + 前缀干扰 + 缺围栏 ----------

test('FE-P14 R-1 回归：整篇文档是 CRLF 时 checkSpec 必须仍全绿（fenced 容忍 \\r）', () => {
  // 背景：仓库 core.autocrlf=true 且无 .gitattributes → 新克隆/checkout 后 frontend-spec.md 会是 CRLF。
  //   旧实现 `fenced()` 的标签行正则 `/^[ \t]*$/` 不容忍 `\r` → C1 报"缺少围栏"并连带 8 条 FE-SPEC 测试红
  //   （审查 R-1 实测 CRLF→0 PASS / LF→9 PASS）。修复已落地但**当时没有回归用例**。
  const text = fs.readFileSync(SPEC, 'utf8');
  const crlf = text.split('\n').join('\r\n');
  assert.notEqual(crlf, text, '前提：确实转成了 CRLF');
  const { file, dir } = withSpec(() => crlf);
  try {
    const res = check.checkSpec({ specFile: file });
    const failed = res.items.filter((i) => i.status === 'fail');
    assert.equal(failed.length, 0, `CRLF 下必须与 LF 同结果：${failed.map((f) => `${f.id} ${f.detail}`).join(' | ')}`);
    assert.equal(itemOf(res, 'C1').status, 'pass', 'C1 不得因 \\r 报"缺少围栏"');
    // 围栏内容解析结果必须与 LF 版逐字一致（只差换行）
    const lfRaw = check.fenced(text, 'json', 'fe-spec-registry');
    const crlfRaw = check.fenced(crlf, 'json', 'fe-spec-registry');
    assert.equal(crlfRaw.replace(/\r/g, ''), lfRaw, '注册表围栏内容应与 LF 版一致（忽略 \\r）');
  } finally { cleanup(dir); }
});

test('FE-P15 fenced 分支：标签行有多余内容 → null（防把 `foo public/` 当围栏）；尾部空白容忍', () => {
  const t = (label, body) => `${label}\n${body}\n\`\`\`\n`;
  assert.equal(check.fenced(t('```json fe-spec-registryXXX', '{}'), 'json', 'fe-spec-registry'), null,
    '标签行残留非空白字符时必须拒绝（否则会把别的围栏内容当注册表）');
  assert.equal(check.fenced(t('```public 目录清单', 'js/app.js'), '', 'public'), null, '同上（前缀干扰分支）');
  assert.equal(check.fenced(t('```json fe-spec-registry   ', '{"a":1}'), 'json', 'fe-spec-registry'), '{"a":1}\n',
    '标签行尾部空白应容忍（返回内容含行尾换行）');
  assert.equal(check.fenced('没有任何围栏', 'json', 'fe-spec-registry'), null, '缺标签 → null');
  assert.equal(check.fenced('```json fe-spec-registry', 'json', 'fe-spec-registry'), null, '只有标签行没有换行 → null');
  assert.equal(check.fenced('```json fe-spec-registry\n{"a":1}\n', 'json', 'fe-spec-registry'), null, '缺闭栏 → null');
});

test('FE-P16 tableRows 分支：多列表（跳过分隔行/遇标题停止）与单列约定表（裸行也算内容）', () => {
  const multi = [
    '| 元素 | data-id | 数据源 | 行为 |',
    '|---|---|---|---|',
    '| 段位 | tier | `unlock` | `common`/`rare` |',
    '| 种子 | seed | `state` | 数字 |',
    '',
  ].join('\n');
  const rows = check.tableRows(multi, '元素');
  assert.equal(rows.length, 2, '分隔行不得计入');
  assert.deepEqual(rows[0].cells, ['段位', 'tier', '`unlock`', '`common`/`rare`']);
  assert.equal(check.tableRows(multi, '不存在的表头').length, 0);

  const single = ['| 通道 |', '`store`', '`view`', ''].join('\n');
  assert.deepEqual(check.tableRows(single, '通道').map((r) => r.cells[0]), ['`store`', '`view`'], '单列表：裸行也是内容');
  // 遇标题（#）停止收集
  const stopped = ['| 通道 |', '`store`', '## 下一节', '`view`', ''].join('\n');
  assert.deepEqual(check.tableRows(stopped, '通道').map((r) => r.cells[0]), ['`store`']);
  // tickValues / unquote 由 inject 的检查路径覆盖；此处断言基础解析契约
  assert.deepEqual(check.tickValues('`a` / `b`'), ['a', 'b']);
});
