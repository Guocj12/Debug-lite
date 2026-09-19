'use strict';
/* tests/api/api-ai-battle-skills.test.js —— P1-3：`/api/v1/ai/battle` 可选技能槽入参（技能类 AI 的通过路径）
 *
 * 背景：`baselinePlayer` 无 `skills` → 任何 `skill:*` 恒 `unknown_skill`（实测 62/62 ineffective），技能类 AI
 *      在该端点**没有任何通过路径**（R-4 开放）。修法：新增可选 `skills`（数组/对象）与 `loadout` 入参；
 *      **缺省仍走 baseline**（既有 62/62 语义与黄金快照零回归）。
 * 契约：`POST /api/v1/ai/battle {program, seed?, tier?, opponent?, skills?|loadout?, warehouse?}`；
 *      响应附加字段 `skillSource`(baseline|explicit|archive) 与 `skillSlots`(槽位键)。
 * 相关：docs/interfaces.md §2 `/api/v1/ai/battle` 行需补该入参/字段（见交付报告）。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');
const LD = require('../fixtures/loadout-ok.json');

const PROG = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'skill:skill1' }] } };
const PROG2 = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'skill:skill2' }] } };
const CD0 = { cooldown: 1, cost: { hp: 0, mp: 0, sp: 0 } };

test('AIS-1 缺省 baseline 零回归：无 skills/loadout → 62/62 unknown_skill（既有语义不变）', async () => {
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'POST', '/api/v1/ai/battle', { program: PROG, seed: 20260919, opponent: 'kiter' });
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    assert.equal(d.ticks, 62);
    assert.equal(d.actionsEffective, 0);
    assert.equal(d.ineffectiveActions.count, 62);
    assert.equal(d.ineffectiveActions.byReason.unknown_skill, 62);
    assert.deepEqual(d.frames[0].actions, { effective: 0, ineffective: 1 }, '帧级计数同既有契约');
    assert.equal(d.skillSource, 'baseline');
    assert.deepEqual(d.skillSlots, []);
  });
});

test('AIS-2 显式 skills：`skill:skill1` 真的放出来（actionsEffective = ticks，未生效 0）', async () => {
  await h.withServer(null, async (s) => {
    const r = await h.request(s.port, 'POST', '/api/v1/ai/battle', {
      program: PROG, seed: 20260919, opponent: 'kiter',
      skills: [{ templateId: 'skill_straight_precise', quality: 'common', params: CD0 }],
    });
    assert.equal(r.status, 200, r.raw);
    const d = r.body.data;
    assert.equal(d.ineffectiveActions.count, 0, `不得再有未生效动作：${JSON.stringify(d.ineffectiveActions.byReason)}`);
    assert.ok(d.actionsEffective > 0, 'actionsEffective > 0（技能类 AI 通过）');
    assert.equal(d.actionsEffective, d.ticks, '每 tick 都放出来（cd=1/cost=0）');
    assert.deepEqual(d.frames[0].events, [], '无 action.invalid/skill.reject 事件');
    assert.equal(d.skillSource, 'explicit');
    assert.deepEqual(d.skillSlots, ['skill1']);
    assert.ok(d.frames.every((f) => Array.isArray(f.aiTrace)), '帧契约不变（帧级 aiTrace 仍在）');
  });
});

test('AIS-3 对象形态 skills（键即槽位键）+ 字符串模板 shorthand', async () => {
  await h.withServer(null, async (s) => {
    const obj = await h.request(s.port, 'POST', '/api/v1/ai/battle', {
      program: PROG2, seed: 7, skills: { skill2: { templateId: 'skill_straight_precise', params: CD0 } },
    });
    assert.equal(obj.status, 200, obj.raw);
    assert.deepEqual(obj.body.data.skillSlots, ['skill2'], '对象键即槽位键（AI 动作 skill:skill2 命中）');
    assert.equal(obj.body.data.ineffectiveActions.count, 0);
    const sh = await h.request(s.port, 'POST', '/api/v1/ai/battle', {
      program: PROG, seed: 7, skills: ['skill_straight_precise'],
    });
    assert.equal(sh.status, 200, sh.raw);
    assert.equal(sh.body.data.skillSource, 'explicit', '字符串 shorthand（模板 id 数组）可用；参数走确定性 STUB_RNG');
    assert.ok(sh.body.data.actionsEffective > 0, '默认参数下也应能放（技能可实例化）');
  });
});

test('AIS-4 loadout 入参：走面板聚合单一实现（role 生效）+ 调用方可显式给 warehouse', async () => {
  await h.withServer(null, async (s) => {
    const ld = JSON.parse(JSON.stringify(LD.loadout));
    ld.role.slots = []; ld.skills.forEach((x) => { x.slots = []; });
    ld.skills[0].params = Object.assign({}, ld.skills[0].params, CD0);
    const r = await h.request(s.port, 'POST', '/api/v1/ai/battle', { program: PROG, seed: 20260919, loadout: ld });
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.data.skillSource, 'explicit');
    assert.equal(r.body.data.ineffectiveActions.count, 0);
    // 非法 loadout（缺 skills）→ 与 /panel、/battle 同源的 409 loadout_invalid + 逐条 errors
    const bad = await h.request(s.port, 'POST', '/api/v1/ai/battle', { program: PROG, seed: 1, loadout: { role: ld.role, skills: [], ai: ld.ai } });
    assert.equal(bad.status, 409, bad.raw);
    assert.equal(bad.body.error.code, 'loadout_invalid');
    assert.ok(bad.body.error.details.length > 0, '带逐条明细');
  });
});

test('AIS-5 调用方真实档案：带 token 且未显式给 skills → 用该玩家出战配置（skillSource=archive）', async () => {
  await h.withServer(null, async (s) => {
    const a = await h.register(s.port, h.uniqueName('aib'));
    const ld = JSON.parse(JSON.stringify(LD.loadout));
    ld.role.slots = []; ld.skills.forEach((x) => { x.slots = []; });
    ld.skills[0].params = Object.assign({}, ld.skills[0].params, CD0);
    const save = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', { loadout: ld }, h.authed(a.token));
    assert.equal(save.status, 200, save.raw);
    const r = await h.request(s.port, 'POST', '/api/v1/ai/battle', { program: PROG, seed: 20260919 }, h.authed(a.token));
    assert.equal(r.status, 200, r.raw);
    assert.equal(r.body.data.skillSource, 'archive', '带 token → 真实档案出战配置');
    assert.equal(r.body.data.ineffectiveActions.count, 0);
    assert.deepEqual(r.body.data.skillSlots, ['skill1', 'skill2', 'skill3'], '槽位来自档案快照');
    // 无效 token 按匿名处理（tolerant）→ 回落 baseline，而不是 401
    const badTok = await h.request(s.port, 'POST', '/api/v1/ai/battle', { program: PROG, seed: 20260919 }, { authorization: 'Bearer nope' });
    assert.equal(badTok.status, 200, badTok.raw);
    assert.equal(badTok.body.data.skillSource, 'baseline');
  });
});

test('AIS-6 参数负例：未知模板 / 超过 3 槽 / skills 与 loadout 互斥 → 400（不静默回落 baseline）', async () => {
  await h.withServer(null, async (s) => {
    const unknown = await h.request(s.port, 'POST', '/api/v1/ai/battle', { program: PROG, seed: 1, skills: [{ templateId: 'no_such_skill' }] });
    assert.equal(unknown.status, 400, unknown.raw);
    assert.equal(unknown.body.error.code, 'bad_skills');
    assert.equal(unknown.body.error.details[0].path, 'skills[0].templateId', 'details 用 path（P2-3 口径）');
    assert.equal(unknown.body.error.details[0].code, 'unknown_skill');
    const tooMany = await h.request(s.port, 'POST', '/api/v1/ai/battle', { program: PROG, seed: 1, skills: ['skill_straight_precise', 'skill_straight_precise', 'skill_straight_precise', 'skill_straight_precise'] });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, 'bad_skills');
    const both = await h.request(s.port, 'POST', '/api/v1/ai/battle', { program: PROG, seed: 1, skills: ['skill_straight_precise'], loadout: LD.loadout });
    assert.equal(both.status, 400, both.raw);
    assert.equal(both.body.error.code, 'bad_request');
    assert.equal(both.body.error.details[0].code, 'conflict', 'skills 与 loadout 互斥（明示，不隐式取舍）');
  });
});
