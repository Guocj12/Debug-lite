'use strict';
// T-DC-8 接口冻结契约测试 —— docs/interfaces.md 与 decisions/tasks 的机器核对
// 落点约定：decisions.md 每条 D-xx 必须以整词形式出现在 interfaces.md（或数据表文本）中。
//
// 2026-09-19 冗余清理（P7-7 §② R4）：删除原 `IF-5 gate 项 5 激活：真实仓库 T-DC-8 通过` ——
//   它对**真仓库**跑 `gate.checkDNumberLocations()` + `gate.checkDocData()` 并只断言 pass，
//   与 gate 项 5（每次 npm run gate 必经）及 `tests/integration/gate-extra.test.js` 的
//   GX-3（fail：D-999 无落点）/GX-4（真实仓库 pass + pending + fail 三态）**同一实现同一分支重复**。
//   分层说明：IF-1 本身已独立从 decisions/interfaces 文本复算落点（不是"调 gate"的分层），
//   IF-5 只是"再调一次 gate"——删它不减少任何独立判据；gate 项 5 的 fail 分支另有 GX-3 投毒。
//   （刻意**未**放宽 IF-1 的 `decided.size` 计数：那是查"decisions 编号被误删/写坏"的漂移护栏，
//     不是同层重复断言；代价是新增 D 编号时必须同步该数字，属有意保留的人工闸门。）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const INTERFACES = read('docs/interfaces.md');
const DECISIONS = read('docs/decisions.md');

function dNumbers(text) {
  const re = /D-(\d{2,3})/g;
  const out = new Set();
  let m;
  while ((m = re.exec(text)) !== null) out.add(`D-${m[1]}`);
  return out;
}

test('IF-1 T-DC-8：decisions.md 每条 D-编号在 interfaces.md 有落点（整词匹配）', () => {
  const decided = dNumbers(DECISIONS);
  const landed = dNumbers(INTERFACES);
  const missing = [...decided].filter((d) => !landed.has(d));
  assert.deepEqual(missing, [], `无落点的 D 编号：${missing.join('、')}`);
  // decisions.md 编号有跳段（D-01..D-08、D-10..D-19、D-20..D-35、D-40..D-46、D-50..51、
  // D-60..62、D-70..72、D-80..84、D-90..92、D-100..104、D-110..118、D-120..128、D-129..D-136、
  // D-137..D-153、D-154..D-157、D-158、D-159..D-163、D-164..D-166），共 118 条（2026-09-16：P7 冲刺组 D-137..D-153 共 17 条；
  //   2026-09-19：P7 收口补充 D-154..D-157 共 4 条；2026-09-22：F2 管理面补充 D-158；
  //   2026-09-22：F3 物品线补充 D-159..D-162 共 4 条；2026-09-25：D-163 热修 1 条；
  //   2026-09-25：战斗线后端修复批补充 D-164..D-166 共 3 条——守方镜像 / 回放 410 修复 / bot 多样化）
  assert.equal(decided.size, 118, `D 编号数量应为 118（decisions.md 无跳段之外的编号）`);
});

test('IF-1b 数据表文本也承载部分 D 落点（schema.js 注释，T-DC-2 侧）', () => {
  const dataText = fs.readdirSync(path.join(REPO, 'server', 'data'))
    .filter((f) => f !== 'README.md')
    .map((f) => fs.readFileSync(path.join(REPO, 'server', 'data', f), 'utf8'))
    .join('\n');
  // 数据表承载的决策：D-110/111/113/114/116/117/118 在 schema.js 注释；D-112/115 为代码契约（interfaces §1）
  for (const d of ['D-110', 'D-111', 'D-113', 'D-114', 'D-116', 'D-117', 'D-118']) {
    assert.ok(dNumbers(dataText).has(d), `${d} 应在数据表文本（schema.js 注释）中出现`);
  }
  for (const d of ['D-112', 'D-115']) {
    assert.ok(dNumbers(INTERFACES).has(d), `${d} 至少应在 interfaces.md 登记`);
  }
});

test('IF-2 模块 ICD 覆盖 tasks §2.2 的模块清单', () => {
  const modules = [
    'shared/log.js', 'core/rng.js', 'core/field.js', 'core/effects.js',
    'core/items.js', 'core/roles.js', 'core/skills.js', 'core/bullets.js',
    'core/engine.js', 'core/unlock.js', 'ai/ast.js', 'ai/runtime.js',
    'server/index.js', 'server/ranked.js', 'cli/index.js', 'server/data/schema.js',
  ];
  for (const m of modules) {
    assert.ok(INTERFACES.includes(m), `interfaces.md 缺模块 ${m}`);
  }
});

test('IF-3 API 契约 v1：§2.3 端点全部登记', () => {
  const endpoints = [
    '/api/v1/health', '/api/v1/data/:table', '/api/v1/unlock?tier=', '/api/v1/box',
    '/api/v1/warehouse', '/api/v1/warehouse/assemble', '/api/v1/warehouse/disassemble',
    '/api/v1/loadout', '/api/v1/panel', '/api/v1/ai/validate', '/api/v1/ai/compile',
    '/api/v1/ai/battle', '/api/v1/battle', '/api/v1/replay/:id',
    '/api/v1/ranked/run', '/api/v1/ranked/promote', '/api/v1/log-level',
  ];
  for (const e of endpoints) {
    assert.ok(INTERFACES.includes(e), `interfaces.md 缺端点 ${e}`);
  }
  for (const code of ['slot_type_mismatch', 'points_exceeded', 'slot_occupied', 'plugin_missing', 'tier_locked', 'loadout_invalid', 'ai_invalid', 'ai_too_large', 'no_loadout', 'bad_tier', 'bad_level', 'unknown_table', 'slot_empty']) {
    assert.ok(INTERFACES.includes(code), `interfaces.md 缺错误码 ${code}`);
  }
});

test('IF-4 CLI 契约 v1：子命令与退出码登记', () => {
  // D-162：`box` 不再接受 `--seed`（seed 服务端独占）→ 登记串改为 `box --tier`
  for (const cmd of ['box --tier', 'wh list', 'panel --loadout', 'ai validate', 'battle --p1', 'replay --file', 'ranked run', 'log --level', 'health', 'data <table>']) {
    assert.ok(INTERFACES.includes(cmd), `interfaces.md 缺 CLI 子命令 ${cmd}`);
  }
  assert.ok(INTERFACES.includes('退出码：`0` 成功 / `1` 业务拒绝 / `2` 参数错误'), '退出码契约缺失');
});