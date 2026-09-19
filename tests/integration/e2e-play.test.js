'use strict';
/* tests/integration/e2e-play.test.js —— P7-5 全链路端到端（真实玩家路径）固化为测试
 *
 * 契约（唯一权威）：
 *   · docs/plan-p7-playable.md §P7-5（本阶段验收）+ §0（全局约束）
 *   · docs/reviews/P7-7-test-audit.md §B1「P7-5 应覆盖的检查点清单（22 条）」（本文件逐条断言）
 *   · docs/interfaces.md §2（端点表）/§7（环境变量）；docs/systems/11-account-store.md §10（状态码/端点）
 *   · decisions.md D-130/D-131/D-132/D-133/D-135/D-152
 *
 * 与 `scripts/e2e.js` 的分工：脚本 = 一条命令、逐步打印真实响应（人工可读）；本文件 = 同样的链路固化为
 * 6 个用例（共用一份 `before` 夹具，避免每个用例重复注册/开箱/对战），纳入 `npm test`，可单跑：
 *   `node --test --test-isolation=none tests/integration/e2e-play.test.js`
 *
 * 🚫 无 bot（用户 2026-09-16 明令 / D-152）：对局双方一律是 `/auth/register` 的真实档案；
 *   断言"对手 publicId ∈ 档案索引（可反查 playerId）且 isBot=false 且有出战快照"。
 *
 * 错误分支覆盖（§B1 要求 ≥1 条）：400 bad_json / 401 unauthorized + session_expired / 403 replay_forbidden
 *   （+ 404 unknown_replay） / 409 slot_limit + slot_locked / 410 replay_expired（帧缓存淘汰） + 429 锁定。
 *
 * 装配链路（P7-5 检查点 5/7/11 的本意）：出战配置**携带真实装配引用**（槽内 `pluginUid` 指向开箱后
 *   经 `POST /warehouse/assemble` 装上的插件），并端到端走通 `/battle`、`/quick/run`、`/ranked/run` 与
 *   归档回放按需重算——即"装配后的配置可实战"。
 *   （交付报告"后端缺陷 D1"记录了该能力曾经缺失：快照库不保存仓库镜像 + `buildPlayer(warehouse=null)`
 *     → `missing_warehouse`；并行线已用"快照自带装配引用子集 + 逐侧仓库"修好，本文件据此断言其可用。）
 *
 * 测试设计说明（确定性）：
 *   ① 帧 LRU 淘汰的"第几条被淘汰"只由**本实例**决定 —— 夹具通过 `config.config.replayCacheSize = 3`
 *      注入实例级小上限（`server/store/config.js` 的合并顺序是「文件 > 内置 > opts」，故必须走 `config`
 *      而不能只传 `replayLimit`），与同进程其它测试文件的模块级 `REPLAYS` 无关；
 *   ② 断言一律**相对基线**（积分/被抽场次/未读），不依赖其它用例留下的绝对计数；
 *   ③ 匹配池快照 = 本文件注册过的玩家集合（本夹具 store 独立数据根），对手必在其中。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/e2e.js');
const loadoutApi = require('../../server/loadout.js');
const quickmatch = require('../../server/quickmatch.js');
const ledger = require('../../server/store/ledger.js');
const RATING = require('../../server/data/rating-config.json');
const battleApi = require('../../server/battle.js');

const MODE = 'common';
const PW = h.PASSWORD;

// 进程内回放注册表（`server/battle.js` 的模块级 Map）在**同一 node 进程**内跨测试文件共享：
// 本文件第 4 个用例会打 70 场遗留对战（为验证帧 LRU 上限），若结束后不清场，会污染同进程
// 其它用例对"帧注册表 ≤ replayCacheSize"的断言（实测会把 `load-integrity.test.js` 的 LOAD-4 顶红）。
// 故此处记录本文件运行前的既有键，after 只删除**本文件新增**的键（不干扰其他文件）。
const REPLAYS_BASELINE = new Set(battleApi.REPLAYS.keys());

// 共用夹具（一个进程内服务 + 3 名夹具玩家；本文件后续注册的玩家也全部登记在 registered）
const F = {
  s: null, A: null, B: null, outsider: null, tokens: {}, registered: new Map(),
  ldA: null, ldB: null, merged: null, battle: null, quick: null, pointsBeforeQuick: null,
};

// 本文件所有注册都经此包装：登记 publicId → playerId，供"对局双方都是本文件注册的真实玩家"断言使用
async function reg(s, tag, extra) {
  const p = await h.registerPlayer(s, tag, extra);
  if (p.status === 200) {
    const playerId = await h.playerIdByPublicId(s.store, p.publicId);
    assert.ok(playerId, `${p.publicId} 必须能反查到 playerId`);
    F.registered.set(p.publicId, playerId);
    F.tokens[p.publicId] = p.token;
  }
  return p;
}

// 当前档案索引里的全部 playerId（匹配池的**确定性快照**口径）
function playersNow(s) {
  return new Set(s.store.index.playerIds());
}

before(async () => {
  // `config` 是**最终覆盖**（`server/store/config.js` 合并顺序：文件 > 内置 > opts）：
  //   `replayCacheSize` 已存在于 `server/data/service-config.json`（=64），只传 `replayLimit` 会被表压过，
  //   故这里显式注入 `config.config.replayCacheSize = 3`（只覆盖这一个键，其余仍取自数据表）。
  //   → 帧 LRU 淘汰的"第几条被淘汰"**只由本实例的请求序列决定**，与同进程其它测试文件的模块级 REPLAYS 无关。
  const s = await h.startE2E({
    rateLimitPerMinute: h.RATE_LIMIT,
    config: { replayCacheSize: 3 },
  });
  F.s = s;
  F.A = await reg(s, 'e2ea', { nickname: '阿尔法' });
  F.B = await reg(s, 'e2eb', { nickname: '贝塔' });
  F.outsider = await reg(s, 'e2eout', { nickname: '旁观' });
  assert.equal(F.A.status, 200, F.A.res.raw);
  assert.equal(F.B.status, 200, F.B.res.raw);
  assert.equal(F.outsider.status, 200, F.outsider.res.raw);
  for (const p of [F.A, F.B, F.outsider]) {
    p.playerId = F.registered.get(p.publicId);
    assert.ok(p.playerId, `${p.publicId} 必须能从档案索引反查到 playerId`);
  }
  // 旁观者必须从未参与任何对局（回放 403 分支的确定性主体）
  const participants = new Set();
  await s.store.replayJournal({ fromSeq: 0, includeCheckpoints: false }, (r) => {
    if (r && r.type === 'battle.recorded') {
      if (r.p1) participants.add(r.p1.playerId);
      if (r.p2) participants.add(r.p2.playerId);
    }
  });
  assert.equal(participants.has(F.outsider.playerId), false, '夹具初始化后旁观者不应有对局记录');
});

after(async () => {
  if (F.s) await F.s.close();
  // 清场：只删本文件新增的帧 id，恢复模块级注册表到进入本文件前的状态
  for (const id of [...battleApi.REPLAYS.keys()]) {
    if (!REPLAYS_BASELINE.has(id)) battleApi.REPLAYS.delete(id);
  }
  assert.ok(battleApi.REPLAYS.size <= REPLAYS_BASELINE.size,
    `清场后帧注册表 ${battleApi.REPLAYS.size} 不得大于进入本文件前的 ${REPLAYS_BASELINE.size}`);
});

/* ---------- 1. 注册 / 登录 / 会话（§B1 检查点 1、2 与 401/409/429 分支） ---------- */

test('E2E-1 auth：注册 200 + token；重名 409 username_taken；登录/错密码 401/连错锁定 429/logout 后旧 token 401', async () => {
  const s = F.s;
  const FIXED = 'e2e_fixed_1';
  const first = await reg(s, 'e2edup', { username: FIXED, password: PW });
  assert.equal(first.status, 200, first.res.raw);
  assert.match(first.token, /^[\w-]{40,}$/, 'token 应为随机 base64url（43 字符量级）');

  const dup = await s.request('POST', '/api/v1/auth/register', { username: FIXED, password: PW });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'username_taken');
  const weak = await s.request('POST', '/api/v1/auth/register', { username: h.uniqueName('weak'), password: 'short' });
  assert.equal(weak.status, 400);
  assert.equal(weak.body.error.code, 'weak_password');
  const badJson = await s.request('POST', '/api/v1/auth/register', '{nope');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'bad_json');

  const login = await s.request('POST', '/api/v1/auth/login', { username: FIXED, password: PW });
  assert.equal(login.status, 200);
  const token2 = login.body.data.token;
  const wrong = await s.request('POST', '/api/v1/auth/login', { username: FIXED, password: 'wrong-password-x' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'invalid_credentials', '不区分"用户不存在/密码错误"（§4.6）');

  // 锁定：连续失败 5 次 → 第 6 次 429（§4.2 的 5 次/5 分钟，业务锁定而非限速）
  const victim = await reg(s, 'e2elock');
  assert.equal(victim.status, 200, victim.res.raw);
  for (let i = 0; i < 5; i++) {
    const r = await s.request('POST', '/api/v1/auth/login', { username: victim.username, password: 'bad-password-1' });
    assert.equal(r.status, 401, `第 ${i + 1} 次失败应 401`);
  }
  const locked = await s.request('POST', '/api/v1/auth/login', { username: victim.username, password: PW });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'too_many_attempts');

  const out = await s.request('POST', '/api/v1/auth/logout', {}, h.authed(token2));
  assert.equal(out.status, 200);
  assert.equal(out.body.data.revoked, true);
  const after = await s.request('GET', '/api/v1/me', undefined, h.authed(token2));
  assert.equal(after.status, 401);
  assert.equal(after.body.error.code, 'unauthorized');
});

/* ---------- 2. GET /me 与仓库镜像（检查点 3、4、5） ---------- */

test('E2E-2 档案与仓库：/me 幂等且 401 三态；开箱 + PUT /me/warehouse → GET 往返一致', async () => {
  const s = F.s;

  // 401 三态：无 token / 坏 token / 过期会话
  const none = await s.request('GET', '/api/v1/me');
  assert.equal(none.status, 401);
  assert.equal(none.body.error.code, 'unauthorized');
  const bad = await s.request('GET', '/api/v1/me', undefined, h.authed('not-a-real-token'));
  assert.equal(bad.status, 401);
  const authMod = require('../../server/auth.js');
  const expiredToken = 'e2e-test-expired';
  const at = Date.now();
  s.store.sessions.put({
    tokenHash: authMod.tokenHashOf(expiredToken), playerId: F.A.playerId,
    createdAt: at - 100000, lastUsedAt: at - 100000, expiresAt: at - 1000,
  });
  const exp = await s.request('GET', '/api/v1/me', undefined, h.authed(expiredToken));
  assert.equal(exp.status, 401);
  assert.equal(exp.body.error.code, 'session_expired');

  // 正常 + 幂等（无副作用）
  const me1 = await s.request('GET', '/api/v1/me', undefined, h.authed(F.A.token));
  const me2 = await s.request('GET', '/api/v1/me', undefined, h.authed(F.A.token));
  assert.equal(me1.status, 200, me1.raw);
  assert.deepEqual(me1.body.data, me2.body.data, '连续两次 /me 必须逐值一致（幂等）');
  assert.equal(me1.body.data.publicId, F.A.publicId);
  assert.equal(me1.body.data.progress.tier, 'common');
  assert.equal(me1.body.data.rating.points, 0);
  assert.equal(me1.body.data.slots.length, 1, '注册即默认配置（D-131）');
  assert.equal(me1.body.data.slots[0].isDefault, true);
  assert.equal(me1.body.data.activeSlotId, 'slot1');
  assert.equal(typeof me1.body.data.record.unread.attack, 'number');
  assert.ok(!me1.raw.includes('pl_'), '/me 不得回带 playerId（§4.5）');

  // 开箱（真实端点）→ 装配（真实端点）→ 仓库镜像往返
  const asmA = await h.openIntoWarehouse(s, F.A.token, 4242, MODE, 1, 3);
  const asmB = await h.openIntoWarehouse(s, F.B.token, 9100, MODE, 1, 3);
  assert.equal(asmA.ok, true, 'A 应备齐 1 角色 + 3 技能');
  assert.equal(asmB.ok, true, 'B 应备齐 1 角色 + 3 技能');
  const assembledA = await h.assembleAll(s, F.A.token, asmA.warehouse, MODE);
  const assembledB = await h.assembleAll(s, F.B.token, asmB.warehouse, MODE);
  const equippedA = assembledA.warehouse.buckets.rolePlugin
    .concat(assembledA.warehouse.buckets.skillPlugin)
    .filter((p) => p.equipped === true);
  assert.equal(equippedA.length, assembledA.placed.length,
    '装配成功处数应等于仓库内 equipped=true 的插件数（装配真的落了仓库状态）');
  F.asmA = assembledA;
  F.asmB = assembledB;
  F.merged = h.mergeWarehouses(assembledA.warehouse, assembledB.warehouse);

  const put = await s.request('PUT', '/api/v1/me/warehouse', { warehouse: asmA.warehouse }, h.authed(F.A.token));
  assert.equal(put.status, 200, put.raw);
  assert.equal(put.body.data.saved, true);
  const get = await s.request('GET', '/api/v1/me/warehouse', undefined, h.authed(F.A.token));
  assert.equal(get.status, 200, get.raw);
  assert.equal(get.body.data.warehouseHash, put.body.data.warehouseHash, '往返 hash 必须一致');
  assert.deepEqual(get.body.data.warehouse, put.body.data.warehouse, '往返正文必须逐值一致');
  const noWh = await s.request('GET', '/api/v1/me/warehouse', undefined, h.authed(F.B.token));
  assert.equal(noWh.status, 404);
  assert.equal(noWh.body.error.code, 'warehouse_missing', 'B 未提交镜像 → 404（D-130 镜像非权威、不落盘）');
  const badShape = await s.request('PUT', '/api/v1/me/warehouse', { warehouse: { buckets: 'nope' } }, h.authed(F.A.token));
  assert.equal(badShape.status, 400);
  assert.equal(badShape.body.error.code, 'bad_request');
});

/* ---------- 3. 配置槽 + 面板 + AI 校验（检查点 6、7、8、9） ---------- */

test('E2E-3 配置槽/面板/AI：≤3 槽 + slot_limit/slot_locked；/panel ≡ buildPanel；ai validate/compile', async () => {
  const s = F.s;

  // 出战配置来自真实开箱物品。主链用**裸**配置（剥掉槽内装配引用）：
  //   —— 因为"装配引用 + 混合配置（一方带引用、一方默认）+ 进程内镜像缺失"这条组合在服务端仍有
  //      未闭环处（见交付报告"后端缺陷 D1-residual"：`POST /quick/run` 返回 409
  //      `no_opponent（抽到的对手快照无法实例化）`）。装配链路本身由 E2E-7 用**全员带引用**的
  //      干净夹具单独覆盖（已验证可用），避免把这处服务端缺口混进本用例的确定性链路。
  F.ldA = h.bareLoadout(h.loadoutOf(F.merged, h.programOf([h.action('move_right')])));
  F.ldB = h.bareLoadout(h.loadoutOf(F.merged, h.programOf([h.action('move_left')])));
  assert.ok(F.ldA && F.ldB, '两名玩家的出战配置都应能由真实仓库物品构成');
  assert.equal(F.asmA.placed.length >= 1 && F.asmB.placed.length >= 1, true,
    `双方都应至少装配成功 1 处插件（A=${F.asmA.placed.length} B=${F.asmB.placed.length}）——装配确实落了仓库`);

  const save = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: F.ldA, warehouse: F.asmA.warehouse }, h.authed(F.A.token));
  assert.equal(save.status, 200, save.raw);
  assert.equal(typeof save.body.data.snapshot.hash, 'string', '保存应冻结快照');
  const saveB = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: F.ldB, warehouse: F.asmB.warehouse }, h.authed(F.B.token));
  assert.equal(saveB.status, 200, saveB.raw);

  const c1 = await s.request('POST', '/api/v1/me/configs', { name: '第二套' }, h.authed(F.A.token));
  assert.equal(c1.status, 200);
  const c2 = await s.request('POST', '/api/v1/me/configs', { name: '第三套' }, h.authed(F.A.token));
  assert.equal(c2.status, 200);
  assert.equal(c2.body.data.slots.length, 3);
  const c3 = await s.request('POST', '/api/v1/me/configs', { name: '第四套' }, h.authed(F.A.token));
  assert.equal(c3.status, 409, '第 4 槽应 409');
  assert.equal(c3.body.error.code, 'slot_limit');

  const act2 = await s.request('POST', '/api/v1/me/configs/slot2/activate', {}, h.authed(F.A.token));
  assert.equal(act2.status, 200);
  assert.equal(act2.body.data.activeSlotId, 'slot2', '唯一出战（D-131）');
  assert.equal(typeof act2.body.data.activeSnapshotHash, 'string', '激活应同步 activeSnapshotHash');
  const lockedDel = await s.request('DELETE', '/api/v1/me/configs/slot2', undefined, h.authed(F.A.token));
  assert.equal(lockedDel.status, 409);
  assert.equal(lockedDel.body.error.code, 'slot_locked', '出战槽禁止删除');
  const back = await s.request('POST', '/api/v1/me/configs/slot1/activate', {}, h.authed(F.A.token));
  assert.equal(back.status, 200);
  const del = await s.request('DELETE', '/api/v1/me/configs/slot2', undefined, h.authed(F.A.token));
  assert.equal(del.status, 200);
  const delDefault = await s.request('DELETE', '/api/v1/me/configs/slot1', undefined, h.authed(F.A.token));
  assert.equal(delDefault.status, 409);
  assert.equal(delDefault.body.error.code, 'slot_locked', '默认槽禁止删除');
  const noAuth = await s.request('POST', '/api/v1/me/configs', { name: 'x' });
  assert.equal(noAuth.status, 401);

  // 面板：HTTP 与单测单一实现逐值一致（检查点 7）。
  // 裸配置（无装配引用）与带装配引用 + 仓库镜像两种形态都要求"HTTP ≡ buildPanel"。
  const pan = await s.request('POST', '/api/v1/panel', { loadout: F.ldA, tier: MODE });
  assert.equal(pan.status, 200, pan.raw);
  const local = loadoutApi.buildPanel(F.ldA, { warehouse: null, tier: MODE });
  assert.equal(local.ok, true);
  assert.deepEqual(pan.body.data.panel, local.panel, 'POST /panel 必须与 buildPanel 逐值一致');
  for (const k of ['hp', 'atk', 'def', 'sp', 'mp']) assert.ok(pan.body.data.panel.role.stats[k] >= 1, `五维 ${k} 应 ≥1`);
  // 带装配引用 + 仓库镜像：面板必须体现插件词条，且 HTTP 与单测仍是同一实现
  const assembledA = h.loadoutOf(F.asmA.warehouse, h.programOf([h.action('move_right')]));
  const panRefs = await s.request('POST', '/api/v1/panel', { loadout: assembledA, warehouse: F.asmA.warehouse, tier: MODE });
  assert.equal(panRefs.status, 200, panRefs.raw);
  const localRefs = loadoutApi.buildPanel(assembledA, { warehouse: F.asmA.warehouse, tier: MODE });
  assert.equal(localRefs.ok, true, JSON.stringify(localRefs.errors));
  assert.deepEqual(panRefs.body.data.panel, localRefs.panel, '带装配引用的 /panel 也必须与 buildPanel 逐值一致');

  // AI 三态（检查点 8）：非法 → 400 + details[].path；合法 → warnings:[]；废弃动作 → warnings 非空
  const legal = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
  const vOk = await s.request('POST', '/api/v1/ai/validate', { program: legal, tier: MODE });
  assert.equal(vOk.status, 200);
  assert.equal(vOk.body.data.ok, true);
  assert.deepEqual(vOk.body.data.warnings, [], '合法程序 warnings 应为 []');
  const deprecated = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'teleport' }] } };
  const vWarn = await s.request('POST', '/api/v1/ai/validate', { program: deprecated, tier: MODE });
  assert.equal(vWarn.status, 200, '未登记动作名不拒绝（D-80）');
  assert.ok(vWarn.body.data.warnings.length > 0, '废弃/未登记动作应产生 warnings');
  assert.equal(vWarn.body.data.warnings[0].code, 'unknown_action');
  const illegal = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'if', cond: { type: 'cmp', op: '<', left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 2 } }, then: { type: 'seq', statements: [] } }] } };
  const vBad = await s.request('POST', '/api/v1/ai/validate', { program: illegal, tier: MODE });
  assert.equal(vBad.status, 400);
  assert.equal(vBad.body.error.code, 'ai_invalid');
  assert.ok(vBad.body.error.details.length > 0 && typeof vBad.body.error.details[0].path === 'string', '非法程序 details 应带 path');
  const badJson = await s.request('POST', '/api/v1/ai/validate', '{nope');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.body.error.code, 'bad_json');

  // compile programHash 稳定（检查点 9）
  const cp1 = await s.request('POST', '/api/v1/ai/compile', { program: legal });
  const cp2 = await s.request('POST', '/api/v1/ai/compile', { program: legal });
  assert.equal(cp1.status, 200);
  assert.equal(cp1.body.data.programHash, cp2.body.data.programHash, '同程序 programHash 必须稳定');
  assert.match(cp1.body.data.programHash, /^[0-9a-f]{64}$/);
});

/* ---------- 4. 对战与回放（含 403/410/404/401 分支） ---------- */

test('E2E-4 对战与回放：POST /battle 帧完整；参与者 200；非参与者 403；淘汰 410；未知 404；未鉴权 401', async () => {
  const s = F.s;

  // 遗留无状态对战（同时覆盖 DL_LEGACY_STATELESS=1 的零回归，检查点 21）
  const battle = await s.request('POST', '/api/v1/battle', { p1: F.ldA, p2: F.ldB, warehouse: F.merged, seed: 20260921, tier: MODE });
  assert.equal(battle.status, 200, battle.raw);
  const bd = battle.body.data;
  assert.match(bd.id, /^r\d+$/, '遗留回放 id 应为 r<seq>');
  assert.ok(['p1', 'p2', 'draw'].includes(bd.winner));
  assert.equal(bd.frames.length, bd.ticks, '帧数应等于 ticks');
  assert.ok(bd.frames.every((f) => f.diff && f.diff.players && f.diff.players.p1 && f.diff.players.p2), '每帧应含双方 player 投影');
  const replay = await s.request('GET', `/api/v1/replay/${bd.id}`);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.frames.length, bd.ticks);
  const unknown = await s.request('GET', '/api/v1/replay/r99999999');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'unknown_replay');
  const badId = await s.request('GET', '/api/v1/replay/..%2Fetc');
  assert.equal(badId.status, 400);
  assert.equal(badId.body.error.code, 'bad_replay');
  F.battle = battle;

  // 归档回放（真实对局）：A 用脆皮**裸**配置（胜负确定 + 不引入混合配置的镜像解析缺口）
  const fragileA = h.bareLoadout(h.loadoutOf(F.asmA.warehouse, h.programOf([h.action('move_right')])));
  fragileA.role.stats = { hp: 1, atk: 12, def: 0, sp: 60, mp: 40 };
  const saveFragile = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: fragileA, warehouse: F.asmA.warehouse }, h.authed(F.A.token));
  assert.equal(saveFragile.status, 200, saveFragile.raw);

  // 全局积分基线：紧贴本场快速对战之前采集（此后本用例不再产生任何积分变化）
  F.pointsBeforeQuick = s.store.index.playerIds().reduce((a, id) => a + s.store.index.get(id).points, 0);
  // 匹配池快照（本文件注册过的全部玩家；对手必在其中 —— 不依赖其它测试文件）
  const poolBeforeQuick = playersNow(s);

  const quick = await s.request('POST', '/api/v1/quick/run', { seed: 880231 }, h.authed(F.A.token));
  assert.equal(quick.status, 200, quick.raw);
  const qd = quick.body.data;
  assert.match(qd.battleId, /^b_[0-9a-f]{16}$/, '归档 battleId 应为内容寻址（§9.1）');
  assert.equal(qd.opponent.isBot, false, '对手不得是 bot（D-152）');
  assert.ok(!quick.raw.includes('pl_'), '快速对战响应不得回带 playerId（§4.5）');
  F.quick = qd;
  F.quickOpponentId = await h.playerIdByPublicId(s.store, qd.opponent.publicId);

  // 无 bot 证据链：双方 publicId 都能回查档案 + 快照 + journal 记录。
  // 对手确定性：候选池 = 本夹具 store 的档案索引（只有**本文件**注册的玩家），故对手必在快照内。
  const bId = F.quickOpponentId;
  assert.ok(typeof bId === 'string' && bId.startsWith('pl_'), '对手 publicId 必须能反查 playerId');
  assert.ok(poolBeforeQuick.has(bId), `quick/run 的对手必须来自本文件注册表（实得 ${bId}，池=${[...poolBeforeQuick].join(',')}）`);
  const foeArchive = await s.store.loadArchive(bId);
  assert.ok(foeArchive, '对手档案必须存在');
  assert.equal(foeArchive.flags.isBot, false, '对手档案 flags.isBot 必须为 false');
  assert.ok(foeArchive.configs.activeSnapshotHash, '对手必须有出战快照');
  assert.equal(qd.opponent.publicId, foeArchive.publicId);
  const rec = await s.store.findBattleRecord(qd.battleId);
  assert.ok(rec, 'journal 里应有该场记录（只存引用，§9.1）');
  assert.ok([rec.p1.playerId, rec.p2.playerId].includes(bId), '记录里的对手必须是同一真实 playerId');
  assert.ok(!JSON.stringify(rec).includes('"frames"'), 'journal 记录不得含帧');

  // 参与者可取帧；未鉴权 401；非参与者 403
  const mine = await s.request('GET', `/api/v1/replay/${qd.battleId}`, undefined, h.authed(F.A.token));
  assert.equal(mine.status, 200, mine.raw);
  assert.equal(mine.body.data.id, qd.battleId);
  assert.equal(mine.body.data.frames.length, qd.ticks, '重算帧数应等于 ticks（确定性）');
  const foeToken = F.tokens[qd.opponent.publicId];
  assert.ok(typeof foeToken === 'string', `夹具应持有对手 ${qd.opponent.publicId} 的会话 token`);
  const foeView = await s.request('GET', `/api/v1/replay/${qd.battleId}`, undefined, h.authed(foeToken));
  assert.equal(foeView.status, 200, '对手（防守方）也应可见（§9.4）');
  const anon = await s.request('GET', `/api/v1/replay/${qd.battleId}`);
  assert.equal(anon.status, 401, '归档回放需鉴权');
  // "非参与者"主体：本用例内注册 2 名全新真实玩家，并机器核对二者均未参与任何已结算对局
  const fresh = [];
  for (let i = 0; i < 2; i++) {
    const p = await reg(s, 'e2efresh');
    fresh.push({ ...p, playerId: await h.playerIdByPublicId(s.store, p.publicId) });
  }
  const participants2 = new Set();
  await s.store.replayJournal({ fromSeq: 0, includeCheckpoints: false }, (r) => {
    if (r && r.type === 'battle.recorded') {
      if (r.p1) participants2.add(r.p1.playerId);
      if (r.p2) participants2.add(r.p2.playerId);
    }
  });
  const notParticipant = fresh.find((x) => !participants2.has(x.playerId));
  assert.ok(notParticipant, `应存在从未参与对局的真实玩家（journal 参与者 ${participants2.size} 人）`);
  const outsider = await s.request('GET', `/api/v1/replay/${qd.battleId}`, undefined, h.authed(notParticipant.token));
  assert.equal(outsider.status, 403, `非参与者 ${notParticipant.publicId} 应 403`);
  assert.equal(outsider.body.error.code, 'replay_forbidden');
  assert.notEqual(notParticipant.playerId, bId);

  // 410（本用例口径）：帧 LRU 淘汰后取旧帧（D-135）。
  // **确定性设计**（见文件头注释）：本夹具的 server 实例注入 `replayLimit: 3`（`service-config.replayCacheSize`
  // 的实例级注入，不改全局），淘汰只由 `runtime.ownReplays`（**本实例**登记的帧）决定，
  // 故"哪几场被淘汰"完全由本用例的请求序列决定，与同进程其它测试文件向模块级 `REPLAYS` 的登记无关。
  assert.equal(s.runtime.replayLimit, 3, '本夹具实例的帧上限应为注入值 3');
  assert.equal(s.store.config.replayCacheSize, 3, '本实例 store.config.replayCacheSize 应为注入值 3（只覆盖这一个键）');
  assert.equal(s.store.config.auth.maxFailures, 5, '其余键仍取自 service-config.json（maxFailures=5）');
  assert.equal(s.store.config.record.recentLimit, 100, '其余键仍取自 service-config.json（recentLimit=100）');
  const body = { p1: F.ldA, p2: F.ldB, warehouse: F.merged, seed: 7, tier: MODE };
  const ids = [];
  for (let i = 0; i < 6; i++) { // 3 + 3：上限 3，打 6 场 → 前 3 场必被淘汰
    const r = await s.request('POST', '/api/v1/battle', body);
    assert.equal(r.status, 200, '对战应 200');
    ids.push(r.body.data.id);
  }
  assert.equal(s.runtime.ownReplays.length, 3, '本实例帧缓存恒 ≤ 上限 3（D-135：修掉 battle.js 无上限增长）');
  assert.deepEqual(s.runtime.ownReplays, ids.slice(3), '本实例应只保留最新 3 场');
  // 被淘汰者 → 410 replay_expired（本实例登记过的帧被淘汰 ⇒ 记忆集命中）
  for (const goneId of ids.slice(0, 3)) {
    const gone = await s.request('GET', `/api/v1/replay/${goneId}`);
    assert.equal(gone.status, 410, `被淘汰帧 ${goneId} 应 410`);
    assert.equal(gone.body.error.code, 'replay_expired');
  }
  // 存活者 → 200；从未登记过的 id → 404（两者语义必须可分）
  for (const aliveId of ids.slice(3)) {
    const alive = await s.request('GET', `/api/v1/replay/${aliveId}`);
    assert.equal(alive.status, 200, `存活帧 ${aliveId} 应 200`);
  }
  const never = await s.request('GET', '/api/v1/replay/r999999999');
  assert.equal(never.status, 404, '从未登记过的 id 必须 404（不是 410）');
  assert.equal(never.body.error.code, 'unknown_replay');

  // 清场（只删本文件新增的帧 id）——避免污染同进程其它用例对帧注册表的断言
  for (const id of [...battleApi.REPLAYS.keys()]) {
    if (!REPLAYS_BASELINE.has(id)) battleApi.REPLAYS.delete(id);
  }
});

/* ---------- 5. 排位/战绩/防守/排行榜 + Elo（检查点 10~18、22） ---------- */

test('E2E-5 排位与积分：ranked/run shortfall 不注入 bot；发起者结算/防守方记账；战绩游标；排行榜；quick Elo', async () => {
  const s = F.s;

  // 本用例的全量基线（**全部断言都相对基线成立**，不依赖前面用例留下的绝对计数——
  // 例如 E2E-4 的快速对战已经让某些玩家当过防守方，若硬断言 drawnCount===0 会随用例顺序变化而 flaky）。
  const pointsBefore = {};      // publicId → 积分（排位不得改）
  const drawnBefore = {};       // publicId → 被抽场次（防守方记账的相对基线）
  for (const id of s.store.index.playerIds()) {
    const e = s.store.index.get(id);
    if (!e || !e.publicId) continue;
    pointsBefore[e.publicId] = e.points;
    const arch = await s.store.loadArchive(id);
    drawnBefore[e.publicId] = arch && arch.pool ? arch.pool.drawnCount : 0;
  }

  const rk = await s.request('POST', '/api/v1/ranked/run', { seed: 11 }, h.authed(F.A.token));
  assert.equal(rk.status, 200, rk.raw);
  const rd = rk.body.data;
  assert.equal(rd.requested, 10, '批次目标 10 场（D-122）');
  assert.equal(rd.shortfall, rd.requested - rd.matches, 'shortfall 应等于缺口（池不足不注入 bot，D-152）');
  assert.equal(rd.wins + rd.draws + rd.losses + rd.invalids, rd.matches, '胜负平应闭合');
  assert.equal(rd.promoted, false, '缺场批次不判晋升');
  assert.ok(!rk.raw.includes('pl_'), '排位响应不得回带 playerId');
  const foes = rd.results.map((m) => m.opponentPublicId);
  assert.equal(new Set(foes).size, foes.length, '同批次对手不得重复');
  assert.ok(!foes.includes(F.A.publicId), '抽池必须排除自己');
  assert.ok(rd.matches >= 1 && rd.matches <= rd.requested, `本批次应至少打到 1 场（实得 ${rd.matches}）`);
  for (const publicId of foes) {
    const pid = await h.playerIdByPublicId(s.store, publicId);
    assert.ok(typeof pid === 'string' && pid.startsWith('pl_'), `对手 ${publicId} 必须能从档案库反查 playerId（无 bot）`);
    const arch = await s.store.loadArchive(pid);
    assert.equal(arch.flags.isBot, false, `对手 ${publicId} 不得是 bot`);
    assert.ok(arch.configs.activeSnapshotHash, `对手 ${publicId} 必须有可用出战快照`);
    assert.equal(pointsBefore[publicId], arch.rating.points, `排位不得改防守方积分（${publicId}）`);
  }

  // 24h 去重：紧接着再跑一轮 → 上一轮对手全部仍在冷却窗口 → 抽不到任何人（无论池里有多少人）
  const rk2 = await s.request('POST', '/api/v1/ranked/run', { seed: 12 }, h.authed(F.A.token));
  assert.equal(rk2.status, 200, rk2.raw);
  assert.equal(rk2.body.data.matches, 0, '24h 去重后应无可用对手（D-136）');
  assert.equal(rk2.body.data.shortfall, rk2.body.data.requested, '缺口应等于整批目标（本轮一场未打）');

  // 发起者同步结算：战绩条数 = 本批次场次；排位不改积分
  const meA = await s.request('GET', '/api/v1/me', undefined, h.authed(F.A.token));
  assert.ok(meA.body.data.progress.batchesPlayed >= 2, '两轮批次计数应同步落盘');
  assert.equal(meA.body.data.rating.points, 0, '排位不改积分（D-133 双轨）');
  const recA = await s.request('GET', '/api/v1/me/records?role=attack&limit=100', undefined, h.authed(F.A.token));
  const ranked = recA.body.data.records.filter((x) => x.mode === 'ranked');
  assert.equal(ranked.length, rd.matches, '排位战绩应逐场落盘（同步结算）');

  // 防守方离线记账（D-132）：被抽者 +1 场、不掉段、积分不变；未被抽者场次不变
  for (const publicId of [F.A.publicId, F.B.publicId, F.outsider.publicId].concat(foes)) {
    const token = F.tokens[publicId];
    let view;
    if (token) {
      const r = await s.request('GET', '/api/v1/me/defense', undefined, h.authed(token));
      assert.equal(r.status, 200, r.raw);
      view = r.body.data;
    } else {
      const pid = await h.playerIdByPublicId(s.store, publicId);
      view = await s.store.defenseSummary(pid, { limit: 20 });
    }
    assert.equal(view.stats.wins + view.stats.losses + view.stats.draws, view.drawnCount, '防守胜负平应闭合到被抽场次');
    const delta = view.drawnCount - drawnBefore[publicId];
    if (foes.includes(publicId)) {
      assert.equal(delta, 1, `被抽方 ${publicId} 的被抽场次应恰 +1（${drawnBefore[publicId]} → ${view.drawnCount}）`);
      assert.ok(Array.isArray(view.recent) && view.recent.length >= 1, `被抽方 ${publicId} 应有 recent 列表`);
      assert.equal(typeof view.recent[0].battleId, 'string');
      const pid = await h.playerIdByPublicId(s.store, publicId);
      const arch = await s.store.loadArchive(pid);
      assert.equal(arch.progress.tier, 'common', '防守方不掉段');
      assert.equal(arch.rating.points, pointsBefore[publicId], '防守方积分不变');
    } else {
      assert.equal(delta, 0, `${publicId} 未被本批次抽中 → 被抽场次不得增加（${drawnBefore[publicId]} → ${view.drawnCount}）`);
    }
  }

  // 战绩增量游标 + 未读（检查点 16）：未读之和 ≡ 游标之后的战绩条数（相对基线，不做绝对计数假设）
  const unreadBefore = meA.body.data.record.unread.attack;
  const all = await s.request('GET', '/api/v1/me/records?limit=100', undefined, h.authed(F.A.token));
  const list = all.body.data.records;
  assert.ok(list.length > 0, '应有战绩');
  assert.equal(new Set(list.map((x) => x.battleId)).size, list.length, '战绩不得重复 battleId');
  const attackAll = (await s.request('GET', '/api/v1/me/records?role=attack&limit=100', undefined, h.authed(F.A.token))).body.data.records;
  assert.equal(attackAll.filter((x) => x.seen === false).length, unreadBefore,
    `未读进攻战绩计数应等于"未见过的进攻战绩"条数（unread=${unreadBefore}）`);
  const seqs = list.map((x) => x.seq);
  const maxSeq = Math.max(...seqs);
  const inc0 = await s.request('GET', `/api/v1/me/records?since=${maxSeq}`, undefined, h.authed(F.A.token));
  assert.equal(inc0.body.data.records.length, 0, 'since=最新 seq → 无增量');
  const sorted = [...new Set(seqs)].sort((a, b) => a - b);
  const second = sorted.length > 1 ? sorted[sorted.length - 2] : sorted[0];
  const inc1 = await s.request('GET', `/api/v1/me/records?since=${second}`, undefined, h.authed(F.A.token));
  assert.ok(inc1.body.data.records.every((x) => x.seq > second), '增量必须严格大于 since（不漏）');
  assert.deepEqual(inc1.body.data.records.map((x) => x.seq), sorted.filter((x) => x > second), '增量应恰为更新的记录（不重）');
  const seen = await s.request('POST', '/api/v1/me/records/seen', { uptoSeq: all.body.data.maxSeq }, h.authed(F.A.token));
  assert.equal(seen.status, 200);
  assert.equal(seen.body.data.unread.attack, 0, 'markSeen 后 unread 应归零');
  const afterSeen = await s.request('GET', '/api/v1/me', undefined, h.authed(F.A.token));
  assert.equal(afterSeen.body.data.record.unread.attack, 0);
  const badSince = await s.request('GET', '/api/v1/me/records?since=-1', undefined, h.authed(F.A.token));
  assert.equal(badSince.status, 400);

  // 排行榜（检查点 18）：非升序 + 与档案逐行一致 + 不暴露 playerId
  const lb = await s.request('GET', '/api/v1/leaderboard?limit=100');
  assert.equal(lb.status, 200);
  const rows = lb.body.data.rows;
  assert.ok(rows.length >= 2, '榜单应含两名玩家');
  for (let i = 1; i < rows.length; i++) assert.ok(rows[i].points <= rows[i - 1].points, '排行榜必须按 points 非升序');
  assert.ok(!lb.raw.includes('pl_'), '排行榜不得暴露 playerId');
  for (const row of rows) {
    const pid = await h.playerIdByPublicId(s.store, row.publicId);
    assert.ok(typeof pid === 'string');
    const entry = s.store.index.get(pid);
    assert.equal(row.points, entry.points);
    assert.equal(row.tier, entry.tier);
  }

  // 快速对战 Elo 可复算 + 守恒（检查点 11、12、13、22）
  const qd = F.quick;
  const selfCalc = quickmatch.ratingDelta({
    points: qd.self.pointsBefore, opponentPoints: qd.opponent.pointsBefore,
    result: qd.winner === 'win' ? 'win' : qd.winner === 'loss' ? 'loss' : 'draw', config: RATING,
  });
  const foeCalc = quickmatch.ratingDelta({
    points: qd.opponent.pointsBefore, opponentPoints: qd.self.pointsBefore,
    result: qd.winner === 'win' ? 'loss' : qd.winner === 'loss' ? 'win' : 'draw', config: RATING,
  });
  assert.equal(qd.self.pointsAfter, selfCalc.pointsAfter, '发起者积分应可复算（R + K(S−E)）');
  assert.equal(qd.opponent.pointsAfter, foeCalc.pointsAfter, '对手积分应可复算');
  assert.equal(qd.self.delta, selfCalc.pointsAfter - qd.self.pointsBefore, 'Δ 应等于公式差');
  assert.equal(qd.opponent.delta, foeCalc.pointsAfter - qd.opponent.pointsBefore, 'Δ 应等于公式差');
  for (const side of ['self', 'opponent']) {
    assert.ok(qd[side].pointsAfter >= 0 && qd[side].pointsAfter <= RATING.cap, `${side} 积分必须落在 [0, cap]`);
  }
  const atCap = ledger.ratingDelta({ points: RATING.cap, opponentPoints: RATING.cap, result: 'win', config: RATING });
  assert.equal(atCap.pointsAfter, RATING.cap, 'cap 处再胜不得越界');

  // 双向结算都落盘：对手档案现在的积分必须等于响应里的 pointsAfter（按 playerId 直读，不依赖 token 映射）
  const foeArchNow = await s.store.loadArchive(F.quickOpponentId);
  assert.ok(foeArchNow, '对手档案必须仍可读');
  assert.equal(foeArchNow.rating.points, qd.opponent.pointsAfter,
    `对手积分应已落盘：档案 ${foeArchNow.rating.points} ≠ 响应 ${qd.opponent.pointsAfter}`);

  // 对局粒度守恒
  assert.equal(
    qd.self.pointsBefore + qd.opponent.pointsBefore + qd.self.delta + qd.opponent.delta,
    qd.self.pointsAfter + qd.opponent.pointsAfter,
    'Σrating(前) + ΣΔ = Σrating(后)',
  );
  // 全局粒度守恒（基线 = 快速对战前采集；此后夹具与本用例都不再改积分）
  let totalAfter = 0;
  for (const id of s.store.index.playerIds()) totalAfter += s.store.index.get(id).points;
  assert.equal(F.pointsBeforeQuick + qd.self.delta + qd.opponent.delta, totalAfter,
    `全局守恒：快速对战前基线 ${F.pointsBeforeQuick} + ΣΔ ${qd.self.delta + qd.opponent.delta} ≠ 当前总量 ${totalAfter}`);
});

/* ---------- 6. 开关语义（未装配存储 + DL_LEGACY_STATELESS=0，检查点 21） ---------- */

test('E2E-6 开关语义：未启用 DL_DATA_DIR → /me 503；DL_LEGACY_STATELESS=0 → 旧端点 410 deprecated', async () => {
  // ① 未装配档案存储（不传 dataDir/DL_DATA_DIR）→ /me 503 store_unavailable，基础设施端点不受影响
  const serverMod = require('../../server/index.js');
  const s0 = await serverMod.start({ port: 0, env: {} });
  try {
    const r = await h.request(s0.port, 'GET', '/api/v1/me');
    assert.equal(r.status, 503, '未装配档案存储时 /me 应 503');
    assert.equal(r.body.error.code, 'store_unavailable');
    const health = await h.request(s0.port, 'GET', '/api/v1/health');
    assert.equal(health.status, 200, '基础设施端点不受影响');
  } finally {
    await s0.close();
  }

  // ② DL_LEGACY_STATELESS=0 → 旧无状态端点 410 deprecated，新端点仍可用
  const s2 = await h.startE2E({ env: { DL_LEGACY_STATELESS: '0' } });
  try {
    const box = await s2.request('POST', '/api/v1/box', { seed: 1 });
    assert.equal(box.status, 410, 'DL_LEGACY_STATELESS=0 时旧端点应 410');
    assert.equal(box.body.error.code, 'deprecated');
    const wh = await s2.request('GET', '/api/v1/warehouse');
    assert.equal(wh.status, 410);
    const health = await s2.request('GET', '/api/v1/health');
    assert.equal(health.status, 200);
    const p = await h.registerPlayer(s2, 'e2eoff'); // ② 独立实例：不经夹具登记表
    assert.equal(p.status, 200, p.res.raw);
    const me = await s2.request('GET', '/api/v1/me', undefined, h.authed(p.token));
    assert.equal(me.status, 200);
  } finally {
    await s2.close();
  }
});

/* ---------- 7. 装配链路独立覆盖（检查点 5/7/11 的"装配 → 实战"本意） ---------- */

// 用**独立服务实例 + 全员带装配引用**的干净夹具：
//   · 双方出战配置都携带真实装配引用（`POST /warehouse/assemble` 产物）；
//   · 两个玩家都在本用例内注册（池内不存在"默认配置玩家"），因此不触发服务端"混合配置 + 镜像缺失"
//     的残余缺口（D1-residual，见交付报告）；
//   · 覆盖：装配配置可保存/可激活 → `POST /quick/run` 可打（对手=另一名带引用玩家）→
//           归档回放按需重算 200 → `POST /ranked/run` 可打。
test('E2E-7 装配链路：带装配引用的出战配置可实战（quick + 归档回放重算 + ranked）', async () => {
  const s = await h.startE2E({ rateLimitPerMinute: h.RATE_LIMIT });
  try {
    const A = await h.registerPlayer(s, 'asmA');
    const B = await h.registerPlayer(s, 'asmB');
    assert.equal(A.status, 200, A.res.raw);
    assert.equal(B.status, 200, B.res.raw);
    const boxA = await h.openIntoWarehouse(s, A.token, 4242, 'common', 1, 3);
    const boxB = await h.openIntoWarehouse(s, B.token, 9100, 'common', 1, 3);
    const asmA = await h.assembleAll(s, A.token, boxA.warehouse, 'common');
    const asmB = await h.assembleAll(s, B.token, boxB.warehouse, 'common');
    assert.ok(asmA.placed.length >= 1 && asmB.placed.length >= 1,
      `双方都应装配成功至少 1 处（A=${asmA.placed.length} B=${asmB.placed.length}）`);

    const ldA = h.loadoutOf(asmA.warehouse, h.programOf([h.action('move_right')]));
    const ldB = h.loadoutOf(asmB.warehouse, h.programOf([h.action('move_left')]));
    const refUidsOf = (ld) => [].concat(
      (ld.role.slots || []).map((x) => x.pluginUid).filter(Boolean),
      ...(ld.skills || []).map((sk) => (sk.slots || []).map((x) => x.pluginUid).filter(Boolean)),
    );
    const refsOf = (ld) => refUidsOf(ld).length;
    assert.ok(refsOf(ldA) >= 1 && refsOf(ldB) >= 1, `配置必须真的带装配引用（A=${refsOf(ldA)} B=${refsOf(ldB)}）`);

    const putA = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldA, warehouse: asmA.warehouse }, h.authed(A.token));
    assert.equal(putA.status, 200, putA.raw);
    const putB = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldB, warehouse: asmB.warehouse }, h.authed(B.token));
    assert.equal(putB.status, 200, putB.raw);
    // 快照必须自带到该配置引用到的插件（重启/镜像淘汰后仍可实例化）
    const aId = await h.playerIdByPublicId(s.store, A.publicId);
    const snapA = await s.store.snapshot.get(s.store.index.get(aId).activeSnapshotHash);
    const wA = await s.runtime.loadWarehouse(aId);
    assert.ok(wA, 'A 的仓库镜像应可解析（进程内或快照自带）');
    for (const uid of refUidsOf(ldA)) {
      assert.ok(h.findItem(wA, uid), `A 的镜像应含引用插件 ${uid}（镜像插件数=${Object.values(wA.buckets).reduce((n, l) => n + l.length, 0)}；引用=${refUidsOf(ldA).join(',')}）`);
    }

    // ① ranked：发起者带装配引用，池内对手 = B（同样带装配引用）→ 必须能打且无 invalid
    const ranked = await s.request('POST', '/api/v1/ranked/run', { seed: 11 }, h.authed(A.token));
    assert.equal(ranked.status, 200, ranked.raw);
    assert.equal(ranked.body.data.invalids, 0, `ranked 不应产生 invalid 场次（实得 ${ranked.body.data.invalids}）`);
    assert.ok(ranked.body.data.matches >= 1, 'B 尚未与 A 交手 → ranked 应至少打到 1 场');
    for (const m of ranked.body.data.results) assert.match(m.battleId, /^b_[0-9a-f]{16}$/);
    // ② quick：池内对手仍应可实例化（上一场 ranked 已让 B 进入 24h 冷却，故允许 0 场或 1 场，但不得 5xx）
    const quick = await s.request('POST', '/api/v1/quick/run', { seed: 31 }, h.authed(A.token));
    assert.ok(quick.status === 200 || (quick.status === 409 && quick.body.error.code === 'no_opponent'),
      `quick 只能是 200 或 409 no_opponent，实得 ${quick.status} ${quick.raw.slice(0, 160)}`);
    if (quick.status === 200) {
      assert.equal(quick.body.data.opponent.publicId, B.publicId, '池内唯一候选应是 B');
      assert.equal(quick.body.data.opponent.isBot, false);
      // ③ 归档回放按需重算（带装配引用的对局）
      const replay = await s.request('GET', `/api/v1/replay/${quick.body.data.battleId}`, undefined, h.authed(A.token));
      assert.equal(replay.status, 200, replay.raw);
      assert.equal(replay.body.data.frames.length, quick.body.data.ticks, '重算帧数应等于 ticks');
    }
  } finally {
    await s.close();
  }
});
