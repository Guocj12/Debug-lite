'use strict';
/* tests/frontend/fe-spec.test.js —— 前端文档自检的可执行化（docs/frontend-spec.md §14 / §17）
 * 断言 checkSpec() 全绿（C1–C9），并用"投毒"用例证明它真的抓得住问题（不是空转通过）。
 * 依赖：scripts/fe-spec-check.js（scripts 层）+ .audit/fe-samples.json（真实响应样本）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const check = require('../../scripts/fe-spec-check.js');

const REPO = path.join(__dirname, '..', '..');
const SPEC = path.join(REPO, 'docs', 'frontend-spec.md');
const SAMPLES = path.join(REPO, '.audit', 'fe-samples.json');

// 把文档写到临时目录（可选改写），再对副本跑检查
function withSpec(mutate) {
  const text = fs.readFileSync(SPEC, 'utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-fespec-'));
  const file = path.join(dir, 'frontend-spec.md');
  fs.writeFileSync(file, mutate ? mutate(text) : text, 'utf8');
  return { file, dir };
}

test('FE-SPEC-1 文档自检 C1–C9 全绿（注册表/动作/字段/取值/清单/通道）', () => {
  const res = check.checkSpec({});
  const failed = res.items.filter((i) => i.status === 'fail');
  assert.equal(failed.length, 0, `自检未通过：${failed.map((f) => `${f.id} ${f.detail}`).join(' | ')}`);
  assert.ok(res.items.length >= 9, `检查项应 ≥9，实际 ${res.items.length}`);
  assert.equal(res.items[0].id, 'C1');
});

test('FE-SPEC-2 真实响应样本存在且包含关键帧字段（回放渲染的唯一输入）', () => {
  assert.ok(fs.existsSync(SAMPLES), '缺少 .audit/fe-samples.json（跑 node .audit/fe-samples.js 生成）');
  const samples = JSON.parse(fs.readFileSync(SAMPLES, 'utf8'));
  for (const key of ['battle_frame_first', 'battle2_frame_with_hit', 'battle2_frame_with_collision', 'battle2_frame_verdict', 'ranked_run', 'panel_valid', 'box_10_mythic']) {
    assert.ok(samples[key], `样本缺 ${key}`);
  }
  const f = samples.battle_frame_first.diff;
  assert.equal(typeof f.players.p1.toX, 'number', 'players 必须是 {p1,p2} 对象（不是数组）');
  assert.equal(typeof f.aiTrace[0].path, 'string', 'aiTrace 必须带 path（不是 name/type）');
  assert.ok(Array.isArray(samples.battle2_frame_with_hit.diff.bulletHits), 'bulletHits 必须是数组');
  assert.equal(typeof samples.battle2_frame_with_collision.diff.collision.contactX, 'number', 'collision.contactX 必须存在');
  assert.ok(samples.battle2_frame_verdict.diff.verdict.winner, 'verdict.winner 必须存在');
});

test('FE-SPEC-3 注册表完整性：按钮 action 命中动作表、dataId 同屏唯一', () => {
  const res = check.checkSpec({});
  assert.equal(res.items.find((i) => i.id === 'C2').status, 'pass');
  assert.equal(res.items.find((i) => i.id === 'C3').status, 'pass');
  assert.equal(res.items.find((i) => i.id === 'C4').status, 'pass');
});

test('FE-SPEC-4 投毒：按钮引用未登记动作 → C2 必须 FAIL（不是空转通过）', () => {
  const { file } = withSpec((t) => t.replace('"action": "gacha/roll"', '"action": "gacha/roll_typo"'));
  const res = check.checkSpec({ specFile: file });
  const c2 = res.items.find((i) => i.id === 'C2');
  assert.equal(c2.status, 'fail', '未登记动作必须被抓（旧实现的死按钮根因）');
  assert.match(c2.detail, /roll_typo/);
});

test('FE-SPEC-5 投毒：字段名写错（players 数组化/actor） → C5 必须 FAIL', () => {
  const { file } = withSpec((t) => t.replace('"path": "diff.players.p1.toX"', '"path": "diff.players[0].actor"'));
  const res = check.checkSpec({ specFile: file });
  const c5 = res.items.find((i) => i.id === 'C5');
  assert.equal(c5.status, 'fail', '错字段名必须被抓（旧实现渲染读不存在字段 → 空白 UI）');
});

test('FE-SPEC-6 投毒：段位/对手取值与后端不一致 → C6 必须 FAIL', () => {
  const { file } = withSpec((t) => t.replace('"opponents": ["kiter", "charger"]', '"opponents": ["kiter", "cautious"]'));
  const res = check.checkSpec({ specFile: file });
  const c6 = res.items.find((i) => i.id === 'C6');
  assert.equal(c6.status, 'fail', '与后端 OPPONENTS 不一致必须被抓（旧实现写了不存在的 cautious）');
});

test('FE-SPEC-7 投毒：未注册日志通道 → C8 必须 FAIL；坏事件名也被抓', () => {
  const bad = withSpec((t) => t.replace('`store.boot` / `store.dispatch`', '`store.BOOT` / `store.dispatch`'));
  let res = check.checkSpec({ specFile: bad.file });
  assert.equal(res.items.find((i) => i.id === 'C8').status, 'fail', '大写事件名必须被抓（name.dot.name 规范）');
  const bad2 = withSpec((t) => t.replace('| `api` | `api.req`', '| `ui` | `ui.click`'));
  res = check.checkSpec({ specFile: bad2.file });
  assert.equal(res.items.find((i) => i.id === 'C8').status, 'fail', '未注册通道必须被抓（ui 通道历史上不存在）');
});

test('FE-SPEC-8 投毒：注册表 JSON 破坏 → C1 必须 FAIL 且后续检查短路', () => {
  const { file } = withSpec((t) => t.replace('"version": 3,', '"version": 3,,'));
  const res = check.checkSpec({ specFile: file });
  assert.equal(res.ok, false);
  assert.equal(res.items[0].id, 'C1');
  assert.equal(res.items[0].status, 'fail');
  assert.match(res.items[0].detail, /JSON 解析失败/);
});

test('FE-SPEC-9 动作表语义：effect 标记齐全（副作用动作才能发请求）', () => {
  const res = check.checkSpec({});
  assert.equal(res.items.find((i) => i.id === 'C1').status, 'pass');
  const text = fs.readFileSync(SPEC, 'utf8');
  const raw = check.fenced(text, 'json', 'fe-spec-registry');
  const reg = JSON.parse(raw);
  const byType = new Map(reg.actions.map((a) => [a.type, a]));
  // 发请求的动作必须标 effect:true（渲染层不发请求，副作用层才发）
  for (const t of ['gacha/roll', 'assembly/run', 'assembly/take', 'panel/refresh', 'battle/run', 'ranked/run', 'ranked/promote', 'editor/validate', 'editor/compile', 'tier/set']) {
    assert.equal(byType.get(t).effect, true, `${t} 应标 effect:true`);
  }
  // 纯 UI 动作不应标 effect（避免"渲染即请求"的反模式）
  for (const t of ['goto', 'modal/open', 'modal/close', 'replay/step', 'replay/seek', 'battle/mode', 'editor/select', 'wh/tab']) {
    assert.equal(byType.get(t).effect, false, `${t} 不应标 effect:true`);
  }
});
