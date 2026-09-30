'use strict';
/* tests/api/api-me-ai-edit.test.js —— D-172 AI 库可编辑 + 草稿态 + 双校验（F5 后端）
 *
 * 契约：docs/interfaces.md §2（`PUT /me/ai/:aiId`、`POST /me/ai/validate`、`me/ai` 的 `status`）/§2.1（`ai_is_draft`）；
 *      docs/decisions.md §14.10（D-172）；设计 docs/frontend/06-ai-editor.md §5/§6。
 *
 * 覆盖：
 *   AIE-1  POST 收紧：ready（缺省）必须完整校验通过（非法 → 400 ai_invalid + details[].path）；
 *          `status='draft'` 只做结构检查（非法程序也能存成草稿）
 *   AIE-2  PUT 部分更新：只改 name / 只改 program / 只改 status；`aiId` 不变；空 body → 400
 *   AIE-3  PUT 负例：未知 aiId → 404；非法 program → 400 ai_invalid；非法 status → 400；未鉴权 → 401
 *   AIE-4  草稿 → 正式：`status='ready'` 时用**结果程序**校验（补全后转正）
 *   AIE-5  被出战配置引用的 AI **禁止降级为草稿**（409 ai_in_use）；但改名/改程序不受限
 *   AIE-6  草稿护栏（窄规则）：配置引用**库内存**在**的草稿 → 409 ai_is_draft；
 *         引用"不存在的 aiId" → 行为与改动前一致（不新增要求）
 *   AIE-7  持久化：改档 → 关服 → 同一 dataDir 重启 → 值仍在；重复 apply 幂等
 *   AIE-8  `POST /me/ai/validate`：合法 → programHash + stats + warnings；非法 → details[].path；401
 *   AIE-9  草稿占库位（与正式条目共用 100 上限）
 *   AIE-10 `duplicate_function`：重名函数校验期拒绝（含 path），改名后通过（D-172 附带修复）
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/http.js');

const VALID = Object.freeze({
  type: 'program', version: 2,
  body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] },
});
// 空 body → no_action_program（合法结构但不合法语义）
const INVALID = Object.freeze({ type: 'program', version: 2, body: { type: 'seq', statements: [] } });
// 重名函数（D-172 附带修复）：校验期现在应拒绝
const DUP_FN = Object.freeze({
  type: 'program', version: 2,
  body: {
    type: 'seq',
    statements: [
      { type: 'function', name: 'g', body: { type: 'seq', statements: [] } },
      { type: 'function', name: 'g', body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } },
      { type: 'action', name: 'wait' },
    ],
  },
});

async function freshPlayer(s, tag) {
  const p = await h.register(s.port, h.uniqueName(tag));
  assert.equal(p.status, 200, JSON.stringify(p.res && p.res.body));
  const playerId = await h.playerIdByPublicId(s.store, p.publicId);
  return { ...p, playerId };
}

async function slot1Loadout(s, p) {
  const cfg = await h.request(s.port, 'GET', '/api/v1/me/configs', undefined, h.authed(p.token));
  assert.equal(cfg.status, 200, cfg.raw);
  return cfg.body.data.slots.find((x) => x.slotId === 'slot1').loadout;
}

function createAi(s, p, body) {
  return h.request(s.port, 'POST', '/api/v1/me/ai', body, h.authed(p.token));
}
function updateAi(s, p, aiId, body) {
  return h.request(s.port, 'PUT', `/api/v1/me/ai/${aiId}`, body, h.authed(p.token));
}
function listAi(s, p) {
  return h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(p.token));
}

// D-163：一件物品同时只能被一份配置引用 → 需要第二套配置时注入**独立 uid** 的备用物品
//   （与 tests/api/api-me-ai.test.js 的 injectSpare 同手法）
const SPARE = { role: 'aie_spare_role', skills: ['aie_spare_sk0', 'aie_spare_sk1', 'aie_spare_sk2'] };
async function injectSpare(s, p) {
  await s.store.updateArchive(p.playerId, (a) => {
    a.warehouse.buckets.role.push({
      uid: SPARE.role, kind: 'role', templateId: 'role_bal', name: '备用角色', quality: 'common',
      slotCount: 1, slots: [{ type: 'atk', pluginUid: null }],
      stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 },
      unlockTier: 'common', pluginPoints: 3,
    });
    for (const uid of SPARE.skills) {
      a.warehouse.buckets.skill.push({
        uid, kind: 'skill', templateId: 'skill_melee', name: `备用技能 ${uid}`, quality: 'common',
        slotCount: 1, slots: [{ type: 'general', pluginUid: null }],
        params: { multiplier: 1, cost: { hp: 0, mp: 0, sp: 10 }, cooldown: 2, bulletLevel: 2 },
        unlockTier: 'common',
      });
    }
    return null;
  });
  const wh = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(p.token));
  assert.equal(wh.status, 200, wh.raw);
  const role = wh.body.data.buckets.role.find((x) => x.uid === SPARE.role);
  const skills = SPARE.skills.map((uid) => wh.body.data.buckets.skill.find((x) => x.uid === uid));
  assert.ok(role && skills.every(Boolean), '备用物品必须已入档（前置断言）');
  return { role, skills };
}

test('AIE-1 POST 收紧：ready 必须校验通过；draft 只做结构检查', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie1');

    // ① 非法程序 + 缺省 status（= ready）→ 400 ai_invalid（**旧行为是 200**，D-172 收紧）
    const bad = await createAi(s, p, { name: '坏AI', program: INVALID });
    assert.equal(bad.status, 400, bad.raw);
    assert.equal(bad.body.error.code, 'ai_invalid');
    assert.ok(bad.body.error.details.some((d) => d.code === 'no_action_program'), 'details 带具体语义码');
    assert.ok(typeof bad.body.error.details[0].path === 'string', 'details 必须带 path（供编辑器定位）');

    // ② 非法程序 + status='draft' → 200（草稿允许不合法）
    const draft = await createAi(s, p, { name: '半成品', program: INVALID, status: 'draft' });
    assert.equal(draft.status, 200, draft.raw);
    assert.equal(draft.body.data.ai.status, 'draft');

    // ③ 合法程序 + 缺省 status → 200 且 status='ready'
    const ok = await createAi(s, p, { name: '正式AI', program: VALID });
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.data.ai.status, 'ready');

    // ④ 列表回带 status 与 draftCount
    const list = await listAi(s, p);
    assert.equal(list.body.data.draftCount, 1, '列表直接给草稿数（界面用）');
    assert.equal(list.body.data.items.find((x) => x.aiId === draft.body.data.aiId).status, 'draft');
    assert.equal(list.body.data.items.find((x) => x.aiId === ok.body.data.aiId).status, 'ready');
  });
});

test('AIE-2 PUT 部分更新：aiId 不变；缺省字段不改；空 body → 400', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie2');
    const a = await createAi(s, p, { name: '原名', program: VALID });
    const aiId = a.body.data.aiId;

    // ① 只改 name
    const r1 = await updateAi(s, p, aiId, { name: '  新名字  ' });
    assert.equal(r1.status, 200, r1.raw);
    assert.equal(r1.body.data.aiId, aiId, 'aiId 必须不变（编辑不换 id）');
    assert.equal(r1.body.data.ai.name, '新名字', '名称 trim');
    assert.deepEqual(r1.body.data.ai.program, VALID, '未给的字段不改（program 保持）');

    // ② 只改 program
    const next = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'defend' }] } };
    const r2 = await updateAi(s, p, aiId, { program: next });
    assert.equal(r2.status, 200, r2.raw);
    assert.equal(r2.body.data.ai.name, '新名字', '上一次改的名字保留');
    assert.deepEqual(r2.body.data.ai.program, next, 'program 已替换');

    // ③ 空 body → 400（部分更新至少一项）
    const r3 = await updateAi(s, p, aiId, {});
    assert.equal(r3.status, 400, r3.raw);
    assert.equal(r3.body.error.code, 'bad_request');

    // ④ 列表里确实是同一个 aiId，且只有一条
    const list = await listAi(s, p);
    assert.equal(list.body.data.items.filter((x) => x.aiId === aiId).length, 1);
  });
});

test('AIE-3 PUT 负例：未知 aiId / 非法 program / 非法 status / 未鉴权', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie3');
    const a = await createAi(s, p, { name: 'A', program: VALID });
    const aiId = a.body.data.aiId;

    const unknown = await updateAi(s, p, 'ai_ffffffffffffffff', { name: 'x' });
    assert.equal(unknown.status, 404, unknown.raw);
    assert.equal(unknown.body.error.code, 'store_not_found');

    const badProgram = await updateAi(s, p, aiId, { program: INVALID });
    assert.equal(badProgram.status, 400, badProgram.raw);
    assert.equal(badProgram.body.error.code, 'ai_invalid');

    const badStatus = await updateAi(s, p, aiId, { status: 'published' });
    assert.equal(badStatus.status, 400, badStatus.raw);
    assert.equal(badStatus.body.error.code, 'bad_request');

    const badShape = await updateAi(s, p, aiId, { program: { type: 'seq' } });
    assert.equal(badShape.status, 400, badShape.raw);
    assert.equal(badShape.body.error.code, 'bad_request');

    const unauth = await h.request(s.port, 'PUT', `/api/v1/me/ai/${aiId}`, { name: 'x' });
    assert.equal(unauth.status, 401);
  });
});

test('AIE-4 草稿 → 正式：ready 用「结果程序」校验（补全后转正）', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie4');
    const d = await createAi(s, p, { name: '半成品', program: INVALID, status: 'draft' });
    const aiId = d.body.data.aiId;
    assert.equal(d.body.data.ai.status, 'draft');

    // ① 仍是坏程序却要转正 → 400（结果程序不是入参 program，而是"现值"）
    const badPublish = await updateAi(s, p, aiId, { status: 'ready' });
    assert.equal(badPublish.status, 400, badPublish.raw);
    assert.equal(badPublish.body.error.code, 'ai_invalid');
    const still = await listAi(s, p);
    assert.equal(still.body.data.items.find((x) => x.aiId === aiId).status, 'draft', '失败后仍是草稿');

    // ② 同一次请求里"补全程序 + 转正" → 200
    const good = await updateAi(s, p, aiId, { program: VALID, status: 'ready' });
    assert.equal(good.status, 200, good.raw);
    assert.equal(good.body.data.ai.status, 'ready');
  });
});

test('AIE-5 被出战配置引用的 AI 禁止降级为草稿；改名/改程序不受限', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie5');
    const ld = await slot1Loadout(s, p);
    const a = await createAi(s, p, { name: '要出战的AI', program: VALID });
    const aiId = a.body.data.aiId;

    // 绑进**出战**配置（slot1 即 activeSlotId）
    const save = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', {
      loadout: { ...ld, ai: VALID, aiId },
    }, h.authed(p.token));
    assert.equal(save.status, 200, save.raw);

    // ① 降级为草稿 → 409 ai_in_use
    const down = await updateAi(s, p, aiId, { status: 'draft' });
    assert.equal(down.status, 409, down.raw);
    assert.equal(down.body.error.code, 'ai_in_use');
    assert.ok(down.body.error.details.some((d) => /slot1/.test(d.message)), 'details 指出被哪个槽引用');

    // ② 改名 / 改程序（保持 ready）不受限
    const renamed = await updateAi(s, p, aiId, { name: '改名后', status: 'ready' });
    assert.equal(renamed.status, 200, renamed.raw);
    assert.equal(renamed.body.data.ai.name, '改名后');
    assert.deepEqual(renamed.body.data.referencedBy, ['slot1'], '回带引用它的槽（界面提示用）');
    assert.equal(renamed.body.data.active, true, '回带"是否被出战槽引用"');
  });
});

test('AIE-6 草稿护栏：配置引用库内草稿 → 409 ai_is_draft；不存在的 aiId 行为不变', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie6');
    const ld = await slot1Loadout(s, p);
    const d = await createAi(s, p, { name: '草稿', program: INVALID, status: 'draft' });
    const draftId = d.body.data.aiId;

    // ① 保存配置引用草稿 → 409 ai_is_draft
    const blocked = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', {
      loadout: { ...ld, aiId: draftId },
    }, h.authed(p.token));
    assert.equal(blocked.status, 409, blocked.raw);
    assert.equal(blocked.body.error.code, 'ai_is_draft');
    assert.ok(blocked.body.error.details.some((x) => x.path === 'aiId'));

    // ② 不存在的 aiId：**不新增要求**（D-172 ④ 的窄规则）——仍与改动前一致（200）
    const ghost = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', {
      loadout: { ...ld, aiId: 'ai_0000000000000000' },
    }, h.authed(p.token));
    assert.equal(ghost.status, 200, `不存在的 aiId 不应因本批被拒（实际 ${ghost.raw}）`);

    // ③ 草稿转正后，同样的配置就能保存
    const pub = await updateAi(s, p, draftId, { program: VALID, status: 'ready' });
    assert.equal(pub.status, 200, pub.raw);
    const ok = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', {
      loadout: { ...ld, ai: VALID, aiId: draftId },
    }, h.authed(p.token));
    assert.equal(ok.status, 200, ok.raw);
  });
});

test('AIE-7 持久化：改档 → 关服 → 同一 dataDir 重启 → 值仍在', async () => {
  const dataDir = h.makeTempDataDir('dl-aie7-');
  let s = await h.startServer({ dataDir });
  let token = null;
  let aiId = null;
  try {
    const p = await freshPlayer(s, 'aie7');
    token = p.token;
    const a = await createAi(s, p, { name: '改前', program: VALID });
    aiId = a.body.data.aiId;
    const next = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'dodge_left' }] } };
    const up = await updateAi(s, p, aiId, { name: '改后', program: next });
    assert.equal(up.status, 200, up.raw);
  } finally {
    await s.close(); // 保留 dataDir（重启场景）
  }
  s = await h.startServer({ dataDir });
  try {
    const list = await h.request(s.port, 'GET', '/api/v1/me/ai', undefined, h.authed(token));
    assert.equal(list.status, 200, list.raw);
    const mine = list.body.data.items.find((x) => x.aiId === aiId);
    assert.ok(mine, '重启后条目仍在');
    assert.equal(mine.name, '改后', 'journal 重放后名称已更新');
    assert.deepEqual(mine.program.body.statements, [{ type: 'action', name: 'dodge_left' }], '程序正文也已更新');
  } finally {
    await s.cleanup();
  }
});

test('AIE-8 POST /me/ai/validate：合法回带 hash/统计/警告；非法回带 path；401', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie8');

    const unauth = await h.request(s.port, 'POST', '/api/v1/me/ai/validate', { program: VALID });
    assert.equal(unauth.status, 401);

    const ok = await h.request(s.port, 'POST', '/api/v1/me/ai/validate', { program: VALID }, h.authed(p.token));
    assert.equal(ok.status, 200, ok.raw);
    assert.equal(ok.body.data.ok, true);
    assert.match(ok.body.data.programHash, /^[0-9a-f]{64}$/, '回带 programHash（编辑器头部显示，不必再调 /ai/compile）');
    assert.ok(Number.isInteger(ok.body.data.stats.nodes) && ok.body.data.stats.nodes > 0);
    assert.ok(Number.isInteger(ok.body.data.stats.depth));
    assert.ok(Array.isArray(ok.body.data.stats.usedNodeTypes));
    assert.ok(Array.isArray(ok.body.data.warnings));

    // 非法动作名只是 warning（D-80：不拒绝）
    const warn = await h.request(s.port, 'POST', '/api/v1/me/ai/validate', {
      program: { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'not_an_action' }] } },
    }, h.authed(p.token));
    assert.equal(warn.status, 200, warn.raw);
    assert.ok(warn.body.data.warnings.some((w) => w.code === 'unknown_action'), 'warnings 通道保留');

    const bad = await h.request(s.port, 'POST', '/api/v1/me/ai/validate', { program: INVALID }, h.authed(p.token));
    assert.equal(bad.status, 400, bad.raw);
    assert.equal(bad.body.error.code, 'ai_invalid');
    assert.ok(bad.body.error.details.length > 0);

    const shape = await h.request(s.port, 'POST', '/api/v1/me/ai/validate', { program: null }, h.authed(p.token));
    assert.equal(shape.status, 400);
    assert.equal(shape.body.error.code, 'bad_request');
  });
});

test('AIE-9 草稿占库位：草稿与正式共用 100 上限', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie9');
    // starter 已给 1 条 → 再建 99 条草稿到满（草稿走结构检查，快）
    for (let i = 0; i < 99; i += 1) {
      const r = await createAi(s, p, { name: `d${i}`, program: INVALID, status: 'draft' });
      assert.equal(r.status, 200, `第 ${i + 2} 条草稿应成功（${r.raw}）`);
    }
    const over = await createAi(s, p, { name: 'overflow', program: INVALID, status: 'draft' });
    assert.equal(over.status, 409, over.raw);
    assert.equal(over.body.error.code, 'ai_limit');
    const list = await listAi(s, p);
    assert.equal(list.body.data.count, 100);
    assert.equal(list.body.data.draftCount, 99);
  });
});

test('AIE-11 aiId 路径边界：编码斜杠/点点 → 400；PUT validate 子路径 → 404；末尾斜杠 → 404', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie11');
    for (const bad of ['ai%2Fx', '..%2Fai', '%2E%2E', 'ai%2F..%2Fme']) {
      const r = await h.request(s.port, 'PUT', `/api/v1/me/ai/${bad}`, { name: 'x' }, h.authed(p.token));
      assert.equal(r.status, 400, `${bad} 应 400（解码后仍必须无分节符）：${r.raw}`);
      assert.equal(r.body.error.code, 'bad_request');
    }
    // `validate` 子路径**只对 POST 分流**；PUT /me/ai/validate 会被当作 aiId=validate → 404（不是 500/越权）
    const putValidate = await h.request(s.port, 'PUT', '/api/v1/me/ai/validate', { name: 'x' }, h.authed(p.token));
    assert.equal(putValidate.status, 404, putValidate.raw);
    assert.equal(putValidate.body.error.code, 'store_not_found');
    // 末尾斜杠 → rest === '' → 未命中动态分支 → 静态/兜底 404
    const slash = await h.request(s.port, 'PUT', '/api/v1/me/ai/', { name: 'x' }, h.authed(p.token));
    assert.equal(slash.status, 404, slash.raw);
    assert.equal(slash.body.error.code, 'unknown_endpoint');
    // 未鉴权优先于 404（先鉴权后业务）
    const unauth = await h.request(s.port, 'PUT', '/api/v1/me/ai/ai_ffffffffffffffff', { name: 'x' });
    assert.equal(unauth.status, 401);
  });
});

test('AIE-12 核心不变量「ready ⇒ 通过 ast.validate」+ 同内容重复保存不丢/不重复 + journal 重放逐值一致', async () => {
  const ast = require('../../server/ai/ast.js');
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie12');
    // ① 一条正式（合法）+ 一条草稿（非法）
    const ready = await createAi(s, p, { name: '正式的', program: VALID });
    const draft = await createAi(s, p, { name: '草稿的', program: INVALID, status: 'draft' });
    assert.equal(ready.body.data.ai.status, 'ready');
    assert.equal(draft.body.data.ai.status, 'draft');
    // ② 草稿补全后转正
    const pub = await updateAi(s, p, draft.body.data.aiId, { program: VALID, status: 'ready' });
    assert.equal(pub.status, 200, pub.raw);
    // ③ 同内容重复保存（只改 name 两次，内容一致）：不重复、不丢、不产生"水位缺口补 apply"
    const r1 = await updateAi(s, p, ready.body.data.aiId, { name: '同一个名字' });
    const r2 = await updateAi(s, p, ready.body.data.aiId, { name: '同一个名字' });
    assert.equal(r1.status, 200, r1.raw);
    assert.equal(r2.status, 200, r2.raw);
    const list = await listAi(s, p);
    const same = list.body.data.items.filter((x) => x.aiId === ready.body.data.aiId);
    assert.equal(same.length, 1, '同 aiId 不得出现两条');
    assert.equal(same[0].name, '同一个名字');
    assert.equal(s.store.stats().reapplied, 0, `正常路径不应出现"水位缺口补 apply"（实际 ${s.store.stats().reapplied}）`);

    // ④ **核心不变量**：库里每一条 `status==='ready'` 的条目都必须能通过服务端完整校验
    const before = (await listAi(s, p)).body.data.items;
    assert.ok(before.length >= 3, `应有 starter + 两条（实际 ${before.length}）`);
    for (const item of before) {
      if (item.status !== 'ready') continue;
      const v = ast.validate(item.program, 'mythic');
      assert.equal(v.ok, true, `ready 条目「${item.name}」必须合法：${JSON.stringify(v.errors)}`);
    }
    // ⑤ journal 重放（档案丢失 → rebuildArchive）后 status/程序/名称逐值一致
    const rebuilt = await s.store.rebuildArchive(p.playerId);
    assert.ok(rebuilt, '重放后仍得到档案');
    const after = (await listAi(s, p)).body.data.items;
    const key = (x) => `${x.aiId}|${x.name}|${x.status}|${JSON.stringify(x.program)}`;
    assert.deepEqual(after.map(key).sort(), before.map(key).sort(), '重放后 AI 库（含 status 与正文）逐值一致');
    assert.equal(after.filter((x) => x.status === 'ready').length, before.filter((x) => x.status === 'ready').length);
  });
});

test('AIE-13 草稿护栏覆盖三条写路径：POST /me/configs（新建槽）、PUT /me/configs/:slotId、activate', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie13');
    const ld = await slot1Loadout(s, p);
    const d = await createAi(s, p, { name: '草稿', program: INVALID, status: 'draft' });
    const draftId = d.body.data.aiId;

    // ① 新建槽带草稿 → 409 ai_is_draft
    const created = await h.request(s.port, 'POST', '/api/v1/me/configs', {
      loadout: { ...ld, ai: INVALID, aiId: draftId },
    }, h.authed(p.token));
    assert.equal(created.status, 409, created.raw);
    assert.equal(created.body.error.code, 'ai_is_draft');

    // ② 保存已有槽带草稿 → 409 ai_is_draft（AE-6 已覆盖，这里做对照）
    const saved = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot2', {
      loadout: { ...ld, ai: INVALID, aiId: draftId },
    }, h.authed(p.token));
    assert.equal(saved.status, 409, saved.raw);
    assert.equal(saved.body.error.code, 'ai_is_draft');

    // ③ activate：**历史数据**路径（直接改档案造出"引用草稿的槽"，模拟护栏上线前存下的配置）→ 409
    await s.store.updateArchive(p.playerId, (a) => {
      const slot2 = a.configs.slots.find((x) => x.slotId === 'slot2');
      slot2.loadout = { ...ld, ai: INVALID, aiId: draftId };
      return null;
    });
    const act = await h.request(s.port, 'POST', '/api/v1/me/configs/slot2/activate', {}, h.authed(p.token));
    assert.equal(act.status, 409, act.raw);
    assert.equal(act.body.error.code, 'ai_is_draft');
    assert.ok(act.body.error.details.some((x) => x.path === 'aiId'));

    // ④ 草稿转正后同一条配置可保存（对照：护栏只拦草稿，不拦合法条目）
    //    D-163：一件物品同时只能被一份配置引用 → slot2 必须用**独立备用物品**（不能复用 slot1 的）
    const spare = await injectSpare(s, p);
    const pub = await updateAi(s, p, draftId, { program: VALID, status: 'ready' });
    assert.equal(pub.status, 200, pub.raw);
    const ok = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot2', {
      loadout: { role: spare.role, skills: spare.skills, ai: VALID, aiId: draftId },
    }, h.authed(p.token));
    assert.equal(ok.status, 200, `草稿转正后应可保存：${ok.raw && ok.raw.slice(0, 200)}`);
  });
});

test('AIE-10 duplicate_function：重名函数校验期拒绝（含 path），改名后通过', async () => {
  await h.withServer(null, async (s) => {
    const p = await freshPlayer(s, 'aie10');

    const dup = await h.request(s.port, 'POST', '/api/v1/me/ai/validate', { program: DUP_FN }, h.authed(p.token));
    assert.equal(dup.status, 400, dup.raw);
    assert.equal(dup.body.error.code, 'ai_invalid');
    const e = dup.body.error.details.find((x) => x.code === 'duplicate_function');
    assert.ok(e, '必须是 duplicate_function（而不是别的校验错误）');
    assert.match(e.path, /^body\.s\[\d+\]$/, 'path 指向第二个定义的位置');

    // 改名后通过（DUP_FN 的第二个函数改名 g2）
    const fixed = JSON.parse(JSON.stringify(DUP_FN));
    fixed.body.statements[1].name = 'g2';
    const ok = await h.request(s.port, 'POST', '/api/v1/me/ai/validate', { program: fixed }, h.authed(p.token));
    assert.equal(ok.status, 200, ok.raw);
  });
});
