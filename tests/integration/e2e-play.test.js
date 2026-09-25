'use strict';
/* tests/integration/e2e-play.test.js —— P7-5 全链路端到端（真实玩家路径）固化为测试
 *
 * 契约（唯一权威）：
 *   · docs/plan-p7-playable.md §P7-5（本阶段验收）+ §0（全局约束）
 *   · docs/reviews/P7-7-test-audit.md §B1「P7-5 应覆盖的检查点清单（22 条）」（本文件逐条断言）
 *   · docs/interfaces.md §2（端点表）/§7（环境变量）；docs/systems/11-account-store.md §10（状态码/端点）
 *   · decisions.md **D-159 / D-160 / D-161 / D-162**（本批后端契约变更；下文逐处标注依据）
 *
 * 与 `scripts/e2e.js` 的分工：脚本 = 一条命令、逐步打印真实响应（人工可读）；本文件 = 同样的链路固化为
 * 7 个用例（共用一份 `before` 夹具，避免每个用例重复注册），纳入 `npm test`，可单跑：
 *   `node --test --test-isolation=none tests/integration/e2e-play.test.js`
 *
 * 🚫 无 bot（用户 2026-09-16 明令 / D-152）：对局双方一律是 `/auth/register` 的真实档案；
 *   断言"对手 publicId ∈ 档案索引（可反查 playerId）且 isBot=false 且有出战快照"。
 *
 * 错误分支覆盖（§B1 要求 ≥1 条）：400 bad_json / 401 unauthorized + session_expired / 403 replay_forbidden
 *   （+ 404 unknown_replay） / 409 slot_limit + slot_locked + cannot_activate_incomplete / 410 replay_expired（帧缓存淘汰）
 *   + 429 锁定。
 *
 * 🆕 D-159 起夹具范式的变更（本文件迁移的核心）：
 *   ① **注册即发 starter**：服务端按身份派生种子生成 1 角色（必带 ≥1 插槽）+ 3 技能 + 1~2 角色插件 +
 *      1 技能插件，**全部已装配**并写进服务端权威仓库；该配置进 `slot1`（默认槽、出战），同时**建满 3 个槽**
 *      （slot2/slot3 空槽、无快照）。→ 旧夹具"注册后开箱 → 装配 → 拼 loadout → 保存"这套客户端编排
 *      **整体退役**（它也正是 D1/D1-residual 那批镜像缺口的来源）。本文件因此**不再调用**
 *      `h.openIntoWarehouse / h.assembleAll / h.loadoutOf / h.bareLoadout`，只保留夹具的注册/反查/鉴权原语，
 *      出战配置直接取 `GET /me/configs` 的 slot1 正文（真实、完整、已装配、已出战）。
 *   ② `GET /me/warehouse` 是**真源**（四种桶 + usage + caps + counts + starterIssued）；旧"未提交镜像 → 404
 *      warehouse_missing"已废除 → E2E-2 改为断言**真源往返一致 + 幂等**。
 *   ③ `PUT /me/warehouse` 退役为**只做形状校验**：形状非法仍 400；引用不覆盖出战配置**不再 409
 *      loadout_invalid**，改 200 + `verified:false` / `saved:true`。
 *   ④ 新增 `POST /me/warehouse/assemble|disassemble`（体 `{targetUid,pluginUid,slotIndex}` / `{targetUid,slotIndex}`，
 *      **不再传整仓**）与 `POST /me/box`（服务端权威开箱，入档；`POST /box` 遗留路径**不入档**）。
 *   ⑤ D-160：`PUT /me/configs/:slotId` 对**非出战槽**允许不完整（200 + complete:false + missing:[…]），
 *      **出战槽**不完整 → 409 loadout_invalid；`POST /me/configs/:slotId/activate` 才校验完整性
 *      （不完整 → 409 **cannot_activate_incomplete**）；`POST /me/configs` 建**空槽**。
 *   ⑥ D-161：AI 库 `GET/POST /me/ai` + `DELETE /me/ai/:aiId`（满 100 → 409 ai_limit；被出战配置引用 → 409 ai_in_use）。
 *   ⑦ D-162：HTTP 开箱**没有 seed 入参**（传了被静默忽略，不再有 bad_seed），seed 服务端独占。
 *
 * 测试设计说明（确定性）：
 *   ① 帧 LRU 淘汰的"第几条被淘汰"只由**本实例**决定 —— 夹具通过 `config.config.replayCacheSize = 3`
 *      注入实例级小上限（`server/store/config.js` 的合并顺序是「文件 > 内置 > opts」，故必须走 `config`
 *      而不能只传 `replayLimit`），与同进程其它测试文件的模块级 `REPLAYS` 无关；
 *   ② 断言一律**相对基线**（积分/被抽场次/未读/仓库计数），不依赖其它用例留下的绝对计数；
 *   ③ 匹配池快照 = 本文件注册过的玩家集合（本夹具 store 独立数据根），对手必在其中；
 *   ④ starter 的**内容**由身份派生（`server/starter.js` 的 seed = sha256('starter|publicId|playerId')），
 *      故本文件只断言 starter 的**结构性不变量**（1 角色 / 3 技能 / 1~2 角色插件 / 1 技能插件 / 引用已装配），
 *      不断言具体模板或品质（那会随 publicId 变化而 flaky）。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers/e2e.js');
const loadoutApi = require('../../server/loadout.js');
const quickmatch = require('../../server/quickmatch.js');
const ledger = require('../../server/store/ledger.js');
const RATING = require('../../server/data/rating-config.json');
const SERVICE_CONFIG = require('../../server/data/service-config.json');
const battleApi = require('../../server/battle.js');

const MODE = 'common';
const PW = h.PASSWORD;
const SEED_MAX = 0x7fffffff;
// D-160：非出战槽允许的"空配置"正文（角色/3 技能/AI 全缺）
const EMPTY_INCOMPLETE = { role: null, skills: [null, null, null], ai: null };

/* ---------- 本文件自带的纯数据小工具（刻意**不**依赖 helpers/e2e.js 的开箱/装配/裸配置函数） ---------- */

const cloneJson = (x) => JSON.parse(JSON.stringify(x));

// 仓库内按 uid 找物品（与 `server/loadout.js` findItem 同语义）
function findItem(wh, uid) {
  for (const list of Object.values((wh && wh.buckets) || {})) {
    if (!Array.isArray(list)) continue;
    const hit = list.find((x) => x && x.uid === uid);
    if (hit) return hit;
  }
  return null;
}

// 合并多份仓库（沿用旧夹具 mergeWarehouses 的语义：仅按桶拼接；uid 进程内全局唯一，故无需去重）
function mergeWarehouses(...list) {
  const out = { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
  for (const wh of list) {
    for (const [k, arr] of Object.entries((wh && wh.buckets) || {})) {
      if (!Array.isArray(arr)) continue;
      if (!Array.isArray(out.buckets[k])) out.buckets[k] = [];
      out.buckets[k] = out.buckets[k].concat(arr);
    }
  }
  return out;
}

// 出战配置引用到的全部插件 uid（角色槽 + 3 个技能槽）
function refUidsOf(ld) {
  return [].concat(
    ((ld && ld.role && ld.role.slots) || []).map((x) => x.pluginUid).filter(Boolean),
    ...(((ld && ld.skills) || []).map((sk) => ((sk && sk.slots) || []).map((x) => x.pluginUid).filter(Boolean))),
  );
}

// "引用 → 宿主物品 + 槽下标"（用于断言引用确实装在那件物品自己的槽上）
function refSitesOf(ld) {
  const out = [];
  const members = [ld.role].concat(ld.skills || []);
  for (const item of members) {
    if (!item) continue;
    (item.slots || []).forEach((s, i) => {
      if (s && s.pluginUid) out.push({ hostUid: item.uid, slotIndex: i, slotType: s.type, pluginUid: s.pluginUid });
    });
  }
  return out;
}

// D-159：注册即 starter → 直接取"该玩家的真实出战配置 + 服务端仓库真源 + /me 摘要"
async function starterOf(s, token) {
  const [cfgRes, whRes, meRes] = await Promise.all([
    s.request('GET', '/api/v1/me/configs', undefined, h.authed(token)),
    s.request('GET', '/api/v1/me/warehouse', undefined, h.authed(token)),
    s.request('GET', '/api/v1/me', undefined, h.authed(token)),
  ]);
  const slot1 = cfgRes.body.data.slots.find((x) => x.slotId === 'slot1');
  return { configs: cfgRes.body.data, warehouse: whRes.body.data, summary: meRes.body.data, slot1, loadout: slot1.loadout };
}

// `POST /me/box` 的掉落按桶归属（与 `server/store/adapter-json.js` grantBox 同口径）
function bucketOfItem(it) {
  if (it && it.kind === 'skillPlugin') return 'skillPlugin';
  if (it && it.kind === 'rolePlugin') return 'rolePlugin';
  if (it && it.kind === 'skill') return 'skill';
  return 'role';
}

// D-163（2026-09-25 用户裁定：一件物品同时只能被一份配置引用）：
//   非 slot1 的配置**不得**再复用 slot1（starter 出战配置）的角色/技能 —— 复用会被服务端
//   `409 item_in_use`（"物品 <uid> 已被配置 slot1 使用…"）拦下。这里按真实仓库的形状注入一套
//   **独立 uid** 的备用物品（角色 1 + 技能 3；插槽留空、不带装配引用），供 slot2/slot3 各自使用。
//   注入方式与前端夹具 `injectFixture` 同法：`store.updateArchive` 直改**服务端权威仓库**；
//   配置正文只用来指出 uid（数值/模板/品质一律由 `resolveItems` 取自仓库那份）。
async function injectSpareLoadoutItems(s, playerId, tag) {
  const view = await s.store.getWarehouse(playerId);
  const srcRole = (view.warehouse.buckets.role || [])[0];
  const srcSkills = (view.warehouse.buckets.skill || []).slice(0, 3);
  assert.ok(srcRole && srcSkills.length === 3, 'starter 必须含 1 角色 + 3 技能（备用物品的模板来源）');
  const role = cloneJson(srcRole);
  role.uid = `${tag}_role`;
  for (const slot of role.slots || []) slot.pluginUid = null; // 备用物品不携带装配引用（故也无需备用插件）
  const skills = srcSkills.map((sk) => {
    const copy = cloneJson(sk);
    copy.uid = `${tag}_${sk.uid.replace(/^item_/, 'skill')}`;
    for (const slot of copy.slots || []) slot.pluginUid = null;
    return copy;
  });
  await s.store.updateArchive(playerId, (a) => {
    a.warehouse.buckets.role.push(role);
    for (const sk of skills) a.warehouse.buckets.skill.push(sk);
    return null;
  });
  return { role, skills };
}

// 进程内回放注册表（`server/battle.js` 的模块级 Map）在**同一 node 进程**内跨测试文件共享：
// 本文件第 4 个用例会打 70 场遗留对战（为验证帧 LRU 上限），若结束后不清场，会污染同进程
// 其它用例对"帧注册表 ≤ replayCacheSize"的断言（实测会把 `load-integrity.test.js` 的 LOAD-4 顶红）。
// 故此处记录本文件运行前的既有键，after 只删除**本文件新增**的键（不干扰其他文件）。
const REPLAYS_BASELINE = new Set(battleApi.REPLAYS.keys());

// 共用夹具（一个进程内服务 + 3 名夹具玩家；本文件后续注册的玩家也全部登记在 registered）
const F = {
  s: null, A: null, B: null, outsider: null, tokens: {}, registered: new Map(),
  whA: null, whB: null, ldA: null, ldB: null, merged: null,
  battle: null, quick: null, pointsBeforeQuick: null, pointsAfterQuick: null,
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
  // D-159：出战配置与仓库真源直接来自注册下发的 starter（无客户端开箱/装配编排）
  for (const pair of [['A', F.A], ['B', F.B]]) {
    const st = await starterOf(s, pair[1].token);
    pair[1].starter = st;
    F[`wh${pair[0]}`] = st.warehouse;
    F[`starter${pair[0]}`] = st;
  }
  F.ldA = F.A.starter.loadout;
  F.ldB = F.B.starter.loadout;
  // 双方各自 starter 的并集（遗留 `POST /battle` 的**双方共用**仓库；uid 进程内唯一，拼接即可）
  F.merged = mergeWarehouses(F.whA, F.whB);

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

/* ---------- 2. GET /me 与仓库真源（检查点 3、4、5） ---------- */

test('E2E-2 档案与仓库：/me 幂等且 401 三态；starter 落档；GET /me/warehouse 真源往返一致；PUT 退役为只校验', async () => {
  const s = F.s;
  const authA = h.authed(F.A.token);

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
  const me1 = await s.request('GET', '/api/v1/me', undefined, authA);
  const me2 = await s.request('GET', '/api/v1/me', undefined, authA);
  assert.equal(me1.status, 200, me1.raw);
  assert.deepEqual(me1.body.data, me2.body.data, '连续两次 /me 必须逐值一致（幂等）');
  assert.equal(me1.body.data.publicId, F.A.publicId);
  assert.equal(me1.body.data.progress.tier, 'common');
  assert.equal(me1.body.data.rating.points, 0);
  // D-159：注册即发 starter → **建满 3 个槽**（旧契约"注册只有 1 个槽"被推翻）
  assert.equal(me1.body.data.slots.length, 3, '注册即建满 3 个槽（D-159）');
  const slot1 = me1.body.data.slots.find((x) => x.slotId === 'slot1');
  assert.equal(slot1.isDefault, true, 'slot1 为默认槽');
  assert.equal(typeof slot1.snapshotHash, 'string', 'slot1 必须带冻结快照（出战）');
  for (const sid of ['slot2', 'slot3']) {
    const sl = me1.body.data.slots.find((x) => x.slotId === sid);
    assert.ok(sl, `${sid} 必须存在（D-159 建满 3 槽）`);
    assert.equal(sl.isDefault, false);
    assert.equal(sl.snapshotHash, null, `${sid} 必须是空槽（无快照，D-160 非出战槽允许不完整）`);
  }
  assert.equal(me1.body.data.activeSlotId, 'slot1');
  // D-159：starter 已通过服务端真源校验 → 新号 unverifiedLoadout 必须为 false
  assert.equal(me1.body.data.flags.unverifiedLoadout, false, 'starter 已校验 → unverifiedLoadout=false（D-159）');
  assert.equal(me1.body.data.flags.isBot, false);
  assert.equal(typeof me1.body.data.record.unread.attack, 'number');
  assert.ok(!me1.raw.includes('pl_'), '/me 不得回带 playerId（§4.5）');

  // ---- GET /me/warehouse = 真源（D-159；旧"未提交镜像 → 404 warehouse_missing"断言已废除）----
  const wh0 = F.whA;
  assert.equal(wh0.starterIssued, true, 'starter 已发放（D-159）');
  assert.deepEqual(Object.keys(wh0.buckets).sort(), ['role', 'rolePlugin', 'skill', 'skillPlugin'], '四桶齐备');
  assert.equal(wh0.counts.role, 1, 'starter 恰 1 角色（D-159）');
  assert.equal(wh0.counts.skill, 3, 'starter 恰 3 技能（D-159）');
  assert.ok(wh0.counts.rolePlugin >= 1 && wh0.counts.rolePlugin <= 2,
    `starter 角色插件 1~2 个（实得 ${wh0.counts.rolePlugin}，D-159）`);
  assert.equal(wh0.counts.skillPlugin, 1, 'starter 技能插件恰 1 个（D-159）');
  // caps 必须接线 service-config.warehouse.maxPerBucket（配置单一来源）
  for (const k of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
    assert.equal(wh0.caps[k], SERVICE_CONFIG.warehouse.maxPerBucket, `caps.${k} 取自 service-config.warehouse.maxPerBucket`);
  }
  // starter 的插件必须全部"已装配"（D-159：全部装进槽）
  const starterPlugins = wh0.buckets.rolePlugin.concat(wh0.buckets.skillPlugin);
  assert.equal(starterPlugins.length, wh0.counts.rolePlugin + wh0.counts.skillPlugin);
  for (const p of starterPlugins) assert.equal(p.equipped, true, `starter 插件 ${p.uid} 必须 equipped=true（全部已装配）`);
  // 出战配置引用完整性（**比旧的"装配 HTTP 处数 > 0"更强**：直接对服务端真源逐引用核对）
  const refsA = refUidsOf(F.ldA);
  assert.ok(refsA.length >= 2, `starter 出战配置必须带真实装配引用（实得 ${refsA.length}）`);
  for (const site of refSitesOf(F.ldA)) {
    const p = findItem(wh0, site.pluginUid);
    assert.ok(p, `引用插件 ${site.pluginUid} 必须在服务端仓库中`);
    assert.equal(p.equipped, true, `引用插件 ${site.pluginUid} 必须 equipped=true`);
    const host = findItem(wh0, site.hostUid);
    assert.ok(host, `宿主物品 ${site.hostUid} 必须在服务端仓库中`);
    assert.equal(host.slots[site.slotIndex].pluginUid, site.pluginUid,
      `引用必须落在宿主自己的槽上：${site.hostUid}[${site.slotIndex}]`);
  }
  // usage = "该物品装配于哪个出战配置"（configs 派生）→ starter 全部物品标注 slot1
  const usedUids = [F.ldA.role.uid].concat(F.ldA.skills.map((x) => x.uid), refsA);
  for (const uid of usedUids) {
    assert.ok(wh0.usage[uid] && wh0.usage[uid].slotIds.includes('slot1'), `usage[${uid}] 应包含 slot1`);
  }
  // 真源幂等：连续两次 GET 逐值一致
  const wh0b = await s.request('GET', '/api/v1/me/warehouse', undefined, authA);
  assert.equal(wh0b.status, 200, wh0b.raw);
  assert.deepEqual(wh0b.body.data, wh0, 'GET /me/warehouse 幂等（真源无副作用）');
  // B 未提交任何镜像也必须 200（D-159 废除 warehouse_missing 404）
  const whB = await s.request('GET', '/api/v1/me/warehouse', undefined, h.authed(F.B.token));
  assert.equal(whB.status, 200, 'D-159：仓库是服务端真源，任何玩家都有仓库，不再 404 warehouse_missing');
  assert.equal(whB.body.data.starterIssued, true);
  assert.equal(whB.body.data.counts.role, 1);
  assert.equal(whB.body.data.counts.skill, 3);
  assert.ok(whB.body.data.counts.rolePlugin >= 1 && whB.body.data.counts.skillPlugin === 1);

  // ---- PUT /me/warehouse：D-159 退役为"只做形状校验" ----
  // ① 覆盖出战配置引用的镜像 → 200 + saved:true + verified:true，且**不得改动真源**
  const put = await s.request('PUT', '/api/v1/me/warehouse', { warehouse: { buckets: cloneJson(wh0.buckets) } }, authA);
  assert.equal(put.status, 200, put.raw);
  assert.equal(put.body.data.saved, true);
  assert.equal(put.body.data.verified, true, '镜像覆盖出战配置引用 → verified:true');
  const afterPut = await s.request('GET', '/api/v1/me/warehouse', undefined, authA);
  assert.deepEqual(afterPut.body.data, wh0, 'PUT 镜像不得改动服务端真源（D-159：真源=档案仓库）');
  // ② 不覆盖引用的镜像 → 200 + saved:true + verified:false（**旧 409 loadout_invalid 已废除**）
  const putBare = await s.request('PUT', '/api/v1/me/warehouse',
    { warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } } }, authA);
  assert.equal(putBare.status, 200, 'D-159：引用不覆盖出战配置时不再 409 loadout_invalid');
  assert.equal(putBare.body.data.saved, true);
  assert.equal(putBare.body.data.verified, false, '不覆盖引用 → verified:false');
  // ③ 形状非法仍 400（保留原有防护）
  const badShape = await s.request('PUT', '/api/v1/me/warehouse', { warehouse: { buckets: 'nope' } }, authA);
  assert.equal(badShape.status, 400);
  assert.equal(badShape.body.error.code, 'bad_request');
  // ④ 上述两条不覆盖/非法请求都不影响真源
  const afterBare = await s.request('GET', '/api/v1/me/warehouse', undefined, authA);
  assert.deepEqual(afterBare.body.data, wh0, '非覆盖镜像与坏形状都不得改动服务端真源');

  // ---- 开箱：遗留 `POST /box` 不入档（D-159）；`POST /me/box` 服务端权威入档（D-159 + D-162）----
  const baselineCounts = wh0.counts;
  const legacy = await s.request('POST', '/api/v1/box', { tier: MODE, times: 2, seed: 24680 });
  assert.equal(legacy.status, 200, '遗留无状态 POST /box 仍可用（无鉴权）');
  assert.equal(legacy.body.data.items.length, 2);
  assert.equal(legacy.body.data.grantId, undefined, '遗留 /box 不入档 → 无 grantId（D-159）');
  const afterLegacy = await s.request('GET', '/api/v1/me/warehouse', undefined, authA);
  assert.deepEqual(afterLegacy.body.data.counts, baselineCounts, '遗留 POST /box 不得改动服务端仓库（不入档，D-159）');

  // D-162：HTTP 开箱没有 seed 入参 —— body 里塞 seed（含非法值）必须被静默忽略、绝不 400 bad_seed
  const box = await s.request('POST', '/api/v1/me/box', { times: 4, tier: MODE, seed: -1 }, authA);
  assert.equal(box.status, 200, `POST /me/box 应 200（D-162：seed 入参被忽略，不再有 bad_seed）：${box.raw}`);
  const bd = box.body.data;
  assert.equal(bd.tier, MODE);
  assert.equal(bd.times, 4);
  assert.ok(Number.isInteger(bd.seed) && bd.seed >= 1 && bd.seed <= SEED_MAX,
    `seed 必须由服务端生成且在 1..${SEED_MAX}（实得 ${bd.seed}，D-162）`);
  assert.match(bd.grantId, /^bx_[0-9a-f]{16}$/, '入档开箱必须回带 grantId（D-159）');
  assert.equal(bd.items.length, 4);
  assert.deepEqual(bd.caps, wh0.caps, 'POST /me/box 回带 caps（D-159）');
  const expectCounts = { ...baselineCounts };
  for (const it of bd.items) expectCounts[bucketOfItem(it)] += 1;
  assert.deepEqual(bd.counts, expectCounts, 'POST /me/box 的 counts 必须等于 开箱前 + 本次掉落（按桶）');
  const afterBox = (await s.request('GET', '/api/v1/me/warehouse', undefined, authA)).body.data;
  assert.deepEqual(afterBox.counts, expectCounts, '开箱必须真的入档（D-159）');
  for (const it of bd.items) assert.ok(findItem(afterBox, it.uid), `掉落物 ${it.uid} 必须已入服务端仓库`);

  // ---- D-159 新装配/拆卸端点：请求体只有 {targetUid,pluginUid,slotIndex}，**不再传整仓** ----
  // ① 拒绝语义（全部确定性；请求体里没有 warehouse）：
  //    · 插件 uid 不存在 → 409 item_missing（core/items 第 1 道校验）
  //    · 技能插件装到角色目标 → 409 slot_type_mismatch（类别校验先于点数/占用）
  //    · 往**已占用**槽再装一次 → 409（拒绝码由"点数预算/插槽占用"两道校验的先后决定），
  //      且**失败必须原子**：服务端真源逐值不变（I-10"状态完全不变"）
  const occIdx = F.ldA.role.slots.findIndex((x) => x.pluginUid);
  assert.ok(occIdx >= 0, 'starter 角色必有 ≥1 已装配槽（D-159）');
  const missingPlugin = await s.request('POST', '/api/v1/me/warehouse/assemble', {
    targetUid: F.ldA.role.uid, pluginUid: 'item_不存在', slotIndex: occIdx,
  }, authA);
  assert.equal(missingPlugin.status, 409, missingPlugin.raw);
  assert.equal(missingPlugin.body.error.code, 'item_missing');
  const wrongKind = await s.request('POST', '/api/v1/me/warehouse/assemble', {
    targetUid: F.ldA.role.uid, pluginUid: wh0.buckets.skillPlugin[0].uid, slotIndex: occIdx,
  }, authA);
  assert.equal(wrongKind.status, 409, wrongKind.raw);
  assert.equal(wrongKind.body.error.code, 'slot_type_mismatch', '角色目标只能装角色插件');
  const beforeReject = (await s.request('GET', '/api/v1/me/warehouse', undefined, authA)).body.data;
  const occupied = await s.request('POST', '/api/v1/me/warehouse/assemble', {
    targetUid: F.ldA.role.uid, pluginUid: F.ldA.role.slots[occIdx].pluginUid, slotIndex: occIdx,
  }, authA);
  assert.equal(occupied.status, 409, occupied.raw);
  assert.ok(typeof occupied.body.error.code === 'string' && occupied.body.error.code !== '',
    '装配拒绝必须带业务错误码');
  const afterReject = (await s.request('GET', '/api/v1/me/warehouse', undefined, authA)).body.data;
  assert.deepEqual(afterReject, beforeReject, '装配失败必须原子：服务端仓库逐值不变（I-10）');
  // ② 正向往返：开箱拿一件全新角色 + 一个未装配的同类插件
  //    （D-159：请求体只有 {targetUid,pluginUid,slotIndex}；返回 {warehouse,usage,counts,caps}）
  let pair = null;
  for (let round = 0; round < 5 && !pair; round += 1) {
    const more = await s.request('POST', '/api/v1/me/box', { times: 20, tier: MODE }, authA);
    assert.equal(more.status, 200, more.raw);
    const wh = (await s.request('GET', '/api/v1/me/warehouse', undefined, authA)).body.data;
    const roles = wh.buckets.role.filter((r) => r.uid !== F.ldA.role.uid);
    const plugins = wh.buckets.rolePlugin.filter((p) => p.equipped !== true);
    for (const r of roles) {
      for (let i = 0; i < (r.slots || []).length && !pair; i += 1) {
        if (r.slots[i].pluginUid) continue;
        const cand = plugins.find((p) => p.slot === r.slots[i].type);
        if (cand) pair = { targetUid: r.uid, pluginUid: cand.uid, slotIndex: i };
      }
      if (pair) break;
    }
  }
  assert.ok(pair, '开箱后应能凑出"空槽角色 + 类型匹配的未装配插件"（真实掉落路径）');
  // ②a 空槽拆卸 → 404 slot_empty（此刻该槽确实为空；请求体只有 targetUid/slotIndex）
  const disEmpty = await s.request('POST', '/api/v1/me/warehouse/disassemble',
    { targetUid: pair.targetUid, slotIndex: pair.slotIndex }, authA);
  assert.equal(disEmpty.status, 404, disEmpty.raw);
  assert.equal(disEmpty.body.error.code, 'slot_empty');
  // ②b 装配 → 拆卸 → 再装配（D-159：两个新端点必须可逆；`equipped` 必须随槽引用同步）
  const asm = await s.request('POST', '/api/v1/me/warehouse/assemble',
    { targetUid: pair.targetUid, pluginUid: pair.pluginUid, slotIndex: pair.slotIndex }, authA);
  assert.equal(asm.status, 200, asm.raw);
  for (const k of ['warehouse', 'usage', 'counts', 'caps']) assert.ok(asm.body.data[k] !== undefined, `装配回执应含 ${k}`);
  const asmHost = findItem(asm.body.data.warehouse, pair.targetUid);
  assert.equal(asmHost.slots[pair.slotIndex].pluginUid, pair.pluginUid, '装配结果必须写进目标物品的槽');
  assert.equal(findItem(asm.body.data.warehouse, pair.pluginUid).equipped, true, '装配后插件必须 equipped=true');
  const asmTruth = (await s.request('GET', '/api/v1/me/warehouse', undefined, authA)).body.data;
  assert.deepEqual(asmTruth.buckets, asm.body.data.warehouse.buckets, '装配必须落服务端真源（回执 ≡ 真源）');
  assert.deepEqual(asmTruth.counts, asm.body.data.counts, '装配回执 counts ≡ 真源 counts');
  const dis = await s.request('POST', '/api/v1/me/warehouse/disassemble',
    { targetUid: pair.targetUid, slotIndex: pair.slotIndex }, authA);
  assert.equal(dis.status, 200, `拆卸应 200（D-159 新端点）：${dis.raw}`);
  assert.equal(findItem(dis.body.data.warehouse, pair.targetUid).slots[pair.slotIndex].pluginUid, null, '拆卸必须清空槽引用');
  assert.equal(findItem(dis.body.data.warehouse, pair.pluginUid).equipped, false,
    '拆卸后插件必须 equipped=false（否则该插件再也装不回去 —— 回归护栏）');
  const reasm = await s.request('POST', '/api/v1/me/warehouse/assemble',
    { targetUid: pair.targetUid, pluginUid: pair.pluginUid, slotIndex: pair.slotIndex }, authA);
  assert.equal(reasm.status, 200, `再装配应 200（拆卸可逆）：${reasm.raw}`);
  assert.equal(findItem(reasm.body.data.warehouse, pair.targetUid).slots[pair.slotIndex].pluginUid, pair.pluginUid,
    '再装配必须复原槽引用');
  assert.equal(findItem(reasm.body.data.warehouse, pair.pluginUid).equipped, true, '再装配后插件必须 equipped=true');
});

/* ---------- 3. 配置槽 + 面板 + AI 库（检查点 6、7、8、9 + D-160/D-161） ---------- */

test('E2E-3 配置槽/面板/AI：3 槽 + slot_limit + cannot_activate_incomplete + slot_locked；/panel ≡ buildPanel；AI 库', async () => {
  const s = F.s;
  const authA = h.authed(F.A.token);
  const authB = h.authed(F.B.token);

  // D-163（2026-09-25 用户裁定：一件物品同时只能被一份配置引用）：slot2/slot3 需要**各自**的物品 ——
  //   旧写法把 slot1（starter 出战配置）的 role/skills 原样写进 slot3/slot2，现被服务端 409 item_in_use 拦下
  //   （实测："物品 item_0 已被配置 slot1 使用…"）。故各注入一套独立备用物品（1 角色 + 3 技能）。
  const spare3 = await injectSpareLoadoutItems(s, F.A.playerId, 'e2e_spare3');
  const spare2 = await injectSpareLoadoutItems(s, F.A.playerId, 'e2e_spare2');

  // D-159/D-160：出战配置来自注册下发的 starter（真实、完整、已装配、已出战）。
  //   PUT 不带 warehouse → 引用校验走**服务端真源**（这正是 D-159 的语义变更点）。
  const save = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: F.ldA }, authA);
  assert.equal(save.status, 200, save.raw);
  assert.equal(typeof save.body.data.snapshot.hash, 'string', '保存应冻结快照');
  assert.equal(save.body.data.complete, true, '出战配置完整 → complete:true（D-160）');
  assert.deepEqual(save.body.data.missing, [], '完整配置 missing 必须为空（D-160）');
  const saveB = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: F.ldB }, authB);
  assert.equal(saveB.status, 200, saveB.raw);

  // D-159：注册即 3 槽 → 再建槽**直接** 409 slot_limit（旧用例"先建 2 个再 409"的前提已被推翻）
  const cfgList = await s.request('GET', '/api/v1/me/configs', undefined, authA);
  assert.equal(cfgList.status, 200);
  assert.equal(cfgList.body.data.slots.length, 3);
  assert.equal(cfgList.body.data.maxSlots, 3, 'maxSlots 取自 service-config.config.maxSlots');
  assert.equal(cfgList.body.data.activeSlotId, 'slot1');
  const c3 = await s.request('POST', '/api/v1/me/configs', { name: '第四套' }, authA);
  assert.equal(c3.status, 409, '第 4 槽应 409（D-159：注册即占满 3 槽）');
  assert.equal(c3.body.error.code, 'slot_limit');

  // D-160：**非出战槽允许不完整** → 200 + complete:false + missing:[…] + snapshot:null
  const inc2 = await s.request('PUT', '/api/v1/me/configs/slot2', { loadout: EMPTY_INCOMPLETE }, authA);
  assert.equal(inc2.status, 200, inc2.raw);
  assert.equal(inc2.body.data.complete, false, '非出战槽允许不完整（D-160）');
  assert.deepEqual(inc2.body.data.missing, ['role', 'skills[0]', 'skills[1]', 'skills[2]', 'ai'],
    '缺项必须逐位置回带（D-160）');
  assert.equal(inc2.body.data.snapshot, null, '不完整配置不冻结快照（D-160）');
  const incPartial = await s.request('PUT', '/api/v1/me/configs/slot3',
    { loadout: { role: spare3.role, skills: spare3.skills, ai: null } }, authA);
  assert.equal(incPartial.status, 200, incPartial.raw);
  assert.equal(incPartial.body.data.complete, false);
  assert.deepEqual(incPartial.body.data.missing, ['ai'], '逐位置缺项：只剩 ai（D-160）');

  // D-160：**出战槽必须完整** → 不完整 → 409 loadout_invalid（details 逐位置）
  const incActive = await s.request('PUT', '/api/v1/me/configs/slot1',
    { loadout: { role: F.ldA.role, skills: F.ldA.skills, ai: null } }, authA);
  assert.equal(incActive.status, 409, '出战槽不完整必须 409（D-160）');
  assert.equal(incActive.body.error.code, 'loadout_invalid');
  assert.ok(incActive.body.error.details.some((d) => d.path === 'ai'), 'details 必须逐位置指明缺项（D-160）');

  // D-160：**设为出战时才校验完整性** → 空槽 activate → 409 cannot_activate_incomplete
  const act2Bad = await s.request('POST', '/api/v1/me/configs/slot2/activate', {}, authA);
  assert.equal(act2Bad.status, 409, '不完整配置不得设为出战（D-160）');
  assert.equal(act2Bad.body.error.code, 'cannot_activate_incomplete');
  assert.ok(act2Bad.body.error.details.some((d) => d.path === 'role'), 'details 逐位置（D-160）');
  // 补全 slot2（D-163：用**它自己**那套备用物品 + 另一个 AI 程序；不能再借 slot1 的 starter 物品，
  //   否则 409 item_in_use）→ activate 200（完整但缺快照会自愈冻结）
  const ldA2 = {
    role: cloneJson(spare2.role),
    skills: spare2.skills.map((sk) => cloneJson(sk)),
    ai: h.programOf([h.action('move_left')]),
  };
  const full2 = await s.request('PUT', '/api/v1/me/configs/slot2', { loadout: ldA2 }, authA);
  assert.equal(full2.status, 200, full2.raw);
  assert.equal(full2.body.data.complete, true);
  assert.equal(typeof full2.body.data.snapshot.hash, 'string', '完整配置必须冻结快照');
  const act2 = await s.request('POST', '/api/v1/me/configs/slot2/activate', {}, authA);
  assert.equal(act2.status, 200, act2.raw);
  assert.equal(act2.body.data.activeSlotId, 'slot2', '唯一出战（D-131）');
  assert.equal(typeof act2.body.data.activeSnapshotHash, 'string', '激活应同步 activeSnapshotHash');
  const lockedDel = await s.request('DELETE', '/api/v1/me/configs/slot2', undefined, authA);
  assert.equal(lockedDel.status, 409);
  assert.equal(lockedDel.body.error.code, 'slot_locked', '出战槽禁止删除');
  const back = await s.request('POST', '/api/v1/me/configs/slot1/activate', {}, authA);
  assert.equal(back.status, 200, back.raw);
  assert.equal(back.body.data.activeSlotId, 'slot1');
  const del = await s.request('DELETE', '/api/v1/me/configs/slot2', undefined, authA);
  assert.equal(del.status, 200, del.raw);
  const delDefault = await s.request('DELETE', '/api/v1/me/configs/slot1', undefined, authA);
  assert.equal(delDefault.status, 409);
  assert.equal(delDefault.body.error.code, 'slot_locked', '默认槽禁止删除');
  const noAuth = await s.request('POST', '/api/v1/me/configs', { name: 'x' });
  assert.equal(noAuth.status, 401);

  // 面板：HTTP 与单测单一实现逐值一致（检查点 7）。
  // D-159：引用校验走服务端真源 → 显式传入真源仓库（`opts.warehouse` 仍旧优先，见 loadout.js）。
  const pan = await s.request('POST', '/api/v1/panel', { loadout: F.ldA, warehouse: F.whA, tier: MODE });
  assert.equal(pan.status, 200, pan.raw);
  const local = loadoutApi.buildPanel(F.ldA, { warehouse: F.whA, tier: MODE });
  assert.equal(local.ok, true, JSON.stringify(local.errors));
  assert.deepEqual(pan.body.data.panel, local.panel, 'POST /panel 必须与 buildPanel 逐值一致');
  for (const k of ['hp', 'atk', 'def', 'sp', 'mp']) assert.ok(pan.body.data.panel.role.stats[k] >= 1, `五维 ${k} 应 ≥1`);
  // 插件词条必须真的生效：与"剥掉全部装配引用"的**同一套物品**相比，面板必须不同（旧用例"带引用 ≡ 单测"）。
  // D-163（2026-09-25 用户裁定：一件物品同时只能被一份配置引用）：面板物品一律取自**服务端权威仓库**，
  //   故"把客户端正文里的 pluginUid 抹掉"已不再构成对照 —— resolveItems 会按 uid 换回仓库里那份**带引用**
  //   的物品（实测：抹掉正文 refs 后两侧 panel 逐值相同）。对照必须用仓库里**真正没有装配引用**的同模物品：
  //   注入的备用套 = starter 物品的克隆（同 templateId/quality/stats），只把插槽清空 ⇒ 面板差异只可能来自插件词条。
  const whNow = (await s.request('GET', '/api/v1/me/warehouse', undefined, authA)).body.data;
  const localRefs = loadoutApi.buildPanel(F.ldA, { warehouse: whNow, tier: MODE });
  assert.equal(localRefs.ok, true, JSON.stringify(localRefs.errors));
  const bare = { role: spare3.role, skills: spare3.skills, ai: F.ldA.ai };
  const localBare = loadoutApi.buildPanel(bare, { warehouse: whNow, tier: MODE });
  assert.equal(localBare.ok, true, JSON.stringify(localBare.errors));
  assert.notDeepEqual(localRefs.panel, localBare.panel, '装配引用必须真的改变面板（插件词条聚合生效）');
  // 上面这条整面板比较会因**技能条目的 uid 不同**（对照是另一件同模物品）而恒真，故再钉一条只覆盖
  // 插件词条作用面的断言（角色面板 stats/regen/special/点数 + 技能聚合参数），它不依赖任何 uid：
  const affected = (p) => ({ role: p.role, skills: p.skills.map((sk) => sk.params) });
  assert.notDeepEqual(affected(localRefs.panel), affected(localBare.panel),
    '装配引用必须真的改变面板数值（插件词条聚合生效，不因 uid 差异而恒真）');
  // T-PB-9：带引用但不给仓库 → 409 loadout_invalid（missing_warehouse），引用校验不得空转
  const panNoWh = await s.request('POST', '/api/v1/panel', { loadout: F.ldA, tier: MODE });
  assert.equal(panNoWh.status, 409, '带装配引用但无仓库 → 409（T-PB-9）');
  assert.equal(panNoWh.body.error.code, 'loadout_invalid');

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

  // ---- D-161：AI 库（GET/POST/DELETE + 上限 + 被引用保护）----
  const ai0 = await s.request('GET', '/api/v1/me/ai', undefined, authA);
  assert.equal(ai0.status, 200, ai0.raw);
  assert.equal(ai0.body.data.max, SERVICE_CONFIG.ai.maxPerPlayer, 'max 取自 service-config.ai.maxPerPlayer');
  assert.equal(ai0.body.data.count, ai0.body.data.items.length, 'count ≡ items.length（D-161）');
  assert.ok(ai0.body.data.items.some((x) => x.name === '新手AI'),
    'starter 的默认 AI 必须登记进 AI 库（name=新手AI，D-159/D-161）');
  assert.ok(F.ldA.aiId && ai0.body.data.items.some((x) => x.aiId === F.ldA.aiId),
    'slot1 的 loadout.aiId 必须指向库内条目（D-159）');
  assert.deepEqual(ai0.body.data.usage[F.ldA.aiId], ['slot1'], '被出战配置引用 → usage 标注 slot1（D-161）');
  for (const it of ai0.body.data.items) {
    assert.equal(typeof it.aiId, 'string');
    assert.equal(typeof it.name, 'string');
    assert.equal(it.program.type, 'program', '库内条目必须回带完整程序正文（D-161）');
    assert.ok(Number.isInteger(it.createdAt) && Number.isInteger(it.updatedAt), '库内条目必须带时间戳（D-161）');
  }
  const mkAi = await s.request('POST', '/api/v1/me/ai', { name: '测试AI', program: legal }, authA);
  assert.equal(mkAi.status, 200, mkAi.raw);
  assert.match(mkAi.body.data.aiId, /^ai_[0-9a-f]+$/, 'D-161：回带 aiId');
  assert.equal(mkAi.body.data.ai.name, '测试AI');
  assert.deepEqual(mkAi.body.data.ai.program, legal, '库内程序正文必须逐值一致');
  assert.equal(mkAi.body.data.count, ai0.body.data.count + 1);
  assert.equal(mkAi.body.data.max, SERVICE_CONFIG.ai.maxPerPlayer);
  const mkBad = await s.request('POST', '/api/v1/me/ai', { name: '', program: legal }, authA);
  assert.equal(mkBad.status, 400, '空名称必须 400');
  assert.equal(mkBad.body.error.code, 'bad_request');
  const delAi = await s.request('DELETE', `/api/v1/me/ai/${mkAi.body.data.aiId}`, undefined, authA);
  assert.equal(delAi.status, 200, delAi.raw);
  assert.equal(delAi.body.data.deleted, mkAi.body.data.aiId);
  assert.equal(delAi.body.data.count, ai0.body.data.count);
  // 删除被**出战配置**引用的 AI → 409 ai_in_use（D-161）
  const delInUse = await s.request('DELETE', `/api/v1/me/ai/${F.ldA.aiId}`, undefined, authA);
  assert.equal(delInUse.status, 409, '被出战配置引用的 AI 不得删除（D-161）');
  assert.equal(delInUse.body.error.code, 'ai_in_use');
  assert.ok(delInUse.body.error.details.some((d) => String(d.message).includes('slot1')), 'details 应指出引用方 slotId（D-161）');
  // 满库 → 409 ai_limit（D-161）
  let list = (await s.request('GET', '/api/v1/me/ai', undefined, authA)).body.data;
  for (let i = 0; i < SERVICE_CONFIG.ai.maxPerPlayer + 5 && list.count < SERVICE_CONFIG.ai.maxPerPlayer; i += 1) {
    const one = await s.request('POST', '/api/v1/me/ai', { name: `填充${i}`, program: legal }, authA);
    assert.equal(one.status, 200, `填充第 ${i + 1} 条 AI 应 200：${one.raw}`);
    list = (await s.request('GET', '/api/v1/me/ai', undefined, authA)).body.data;
  }
  assert.equal(list.count, SERVICE_CONFIG.ai.maxPerPlayer, `AI 库必须能装到上限 ${SERVICE_CONFIG.ai.maxPerPlayer}`);
  const over = await s.request('POST', '/api/v1/me/ai', { name: '溢出', program: legal }, authA);
  assert.equal(over.status, 409, '满库后必须 409（D-161）');
  assert.equal(over.body.error.code, 'ai_limit');
});

/* ---------- 4. 对战与回放（含 403/410/404/401 分支） ---------- */

test('E2E-4 对战与回放：POST /battle 帧完整；参与者 200；非参与者 403；淘汰 410；未知 404；未鉴权 401', async () => {
  const s = F.s;

  // 遗留无状态对战（同时覆盖 DL_LEGACY_STATELESS=1 的零回归，检查点 21）。
  // D-159：仓库是服务端真源，但仍接受显式 warehouse（遗留路径）→ 传双方 starter 的并集，
  //   于是"带真实装配引用的配置可实战"也在遗留路径上被验证。
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

  // 归档回放（真实对局）：A 用脆皮配置（胜负确定 + 积分非退化）。
  // D-159：**不再需要** `bareLoadout`（剥引用）与客户端镜像 —— 引用校验走服务端真源，
  //   归档回放按需重算也走 `rt.loadWarehouse`（服务端真源优先，快照子集仅作旧数据兜底）。
  //   故这里刻意**不传** `warehouse`：若保存不带镜像的配置导致该场对局回放 410，本用例必须红。
  const fragileA = cloneJson(F.ldA);
  fragileA.role.stats = { hp: 1, atk: 12, def: 0, sp: 60, mp: 40 };
  const saveFragile = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: fragileA }, h.authed(F.A.token));
  assert.equal(saveFragile.status, 200, saveFragile.raw);
  assert.equal(saveFragile.body.data.complete, true, '带装配引用的脆皮配置必须完整合法（D-159：真源校验）');

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
  F.pointsAfterQuick = qd.self.pointsAfter; // E2E-5 用它做"排位不改积分"的**相对基线**（避免绝对计数假设）
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

  // D-168 软冷却（取代 D-136 的 24h 硬底线）：紧接着再跑一轮 → 上一轮对手**仍可被抽中**（只是权重低），
  //   即"冷却只降低概率、不硬拒"；并如实回带回满小时数。
  const rk2 = await s.request('POST', '/api/v1/ranked/run', { seed: 12 }, h.authed(F.A.token));
  assert.equal(rk2.status, 200, rk2.raw);
  assert.equal(rk2.body.data.recoveryHours, 4, 'D-168：软冷却回满小时数如实回带');
  assert.ok(rk2.body.data.matches >= 1, 'D-168：刚打过的对手仍可被匹配（不再 0 场 / 不再 24h 硬拒）');
  const foes2 = rk2.body.data.results.map((r) => r.opponentPublicId);
  assert.equal(new Set(foes2).size, foes2.length, '同批次对手不得重复');
  for (const publicId of foes2) assert.ok(foes.includes(publicId), '第二轮对手仍来自同一真实玩家池（无 bot）');
  // 刚交手 → 权重 < 1（软冷却生效）；这是"降低概率"的可观测证据
  const archA = await s.store.loadArchive(await h.playerIdByPublicId(s.store, F.A.publicId));
  const rankedMod = require('../../server/ranked.js');
  for (const publicId of foes2) {
    const pid = await h.playerIdByPublicId(s.store, publicId);
    const w = rankedMod.cooldownWeightOf(archA, pid, Date.now(), 4);
    assert.ok(w < 1, `刚交手的对手权重应 <1（${publicId} → ${w}）`);
  }

  // 发起者同步结算：战绩条数 = 本批次场次；排位不改积分（D-133 双轨）
  const meA = await s.request('GET', '/api/v1/me', undefined, h.authed(F.A.token));
  assert.ok(meA.body.data.progress.batchesPlayed >= 2, '两轮批次计数应同步落盘');
  // 相对基线（E2E-4 的快速对战已经改过 A 的积分，故不能用绝对 0）
  assert.equal(meA.body.data.rating.points, F.pointsAfterQuick,
    `排位不改积分（D-133 双轨）：应为快速对战后的 ${F.pointsAfterQuick}`);
  const recA = await s.request('GET', '/api/v1/me/records?role=attack&limit=100', undefined, h.authed(F.A.token));
  const ranked = recA.body.data.records.filter((x) => x.mode === 'ranked');
  // D-168：第二轮同样有对局（软冷却不硬拒）→ 战绩总数 = 两场次之和
  assert.equal(ranked.length, rd.matches + rk2.body.data.matches, '排位战绩应逐场落盘（同步结算；两轮之和）');

  // 防守方离线记账（D-132）：被抽者按"两轮被抽次数"增加、不掉段、积分不变；未被抽者场次不变
  //   D-168：第二轮不再被硬拒 ⇒ 同一对手可能被抽两次，故期望值按两批实际抽中次数累计。
  const drawnCountExpect = new Map();
  for (const publicId of foes) drawnCountExpect.set(publicId, (drawnCountExpect.get(publicId) || 0) + 1);
  for (const publicId of foes2) drawnCountExpect.set(publicId, (drawnCountExpect.get(publicId) || 0) + 1);
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
    const want = drawnCountExpect.get(publicId) || 0;
    if (want > 0) {
      assert.equal(delta, want, `被抽方 ${publicId} 的被抽场次应为 +${want}（两轮累计；${drawnBefore[publicId]} → ${view.drawnCount}）`);
      assert.ok(Array.isArray(view.recent) && view.recent.length >= 1, `被抽方 ${publicId} 应有 recent 列表`);
      assert.equal(typeof view.recent[0].battleId, 'string');
      const pid = await h.playerIdByPublicId(s.store, publicId);
      const arch = await s.store.loadArchive(pid);
      assert.equal(arch.progress.tier, 'common', '防守方不掉段');
      assert.equal(arch.rating.points, pointsBefore[publicId], '防守方积分不变');
    } else {
      assert.equal(delta, 0, `${publicId} 未被任何批次抽中 → 被抽场次不得增加（${drawnBefore[publicId]} → ${view.drawnCount}）`);
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
  assert.ok(qd, 'E2E-4 必须已产出快速对战结果（共用夹具）');
  const selfCalc = quickmatch.ratingDelta({
    points: qd.self.pointsBefore, opponentPoints: qd.opponent.pointsBefore,
    result: qd.winner === 'p1' ? 'win' : qd.winner === 'p2' ? 'loss' : 'draw', config: RATING, // D-169
  });
  const foeCalc = quickmatch.ratingDelta({
    points: qd.opponent.pointsBefore, opponentPoints: qd.self.pointsBefore,
    result: qd.winner === 'p1' ? 'loss' : qd.winner === 'p2' ? 'win' : 'draw', config: RATING, // D-169
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
    // D-162：HTTP 开箱没有 seed 入参；这里 body 里的 seed 只为验证"旧端点被开关关闭"的 410 分支
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
    // D-159：新端点（服务端权威）在旧端点关闭后仍必须可用
    const whMe = await s2.request('GET', '/api/v1/me/warehouse', undefined, h.authed(p.token));
    assert.equal(whMe.status, 200, 'D-159 服务端仓库真源不受 DL_LEGACY_STATELESS 影响');
    assert.equal(whMe.body.data.starterIssued, true);
    const boxMe = await s2.request('POST', '/api/v1/me/box', { times: 1, tier: 'common' }, h.authed(p.token));
    assert.equal(boxMe.status, 200, 'D-159 POST /me/box 不受 DL_LEGACY_STATELESS 影响');
  } finally {
    await s2.close();
  }
});

/* ---------- 7. 装配链路独立覆盖（检查点 5/7/11 的"装配 → 实战"本意） ---------- */

// 独立服务实例 + 完全由 **starter** 供给的双方（真实装配引用、各自独立的服务端仓库）。
// D-159 之前这条链路要靠"客户端开箱 + `POST /warehouse/assemble` 传整仓 + 快照自带镜像子集"才能跑通，
// 且曾因"混合配置 + 进程内镜像缺失"出现 409 no_opponent（交付报告 D1-residual）；仓库上云后该缺口消失：
//   覆盖：带装配引用的配置可保存（校验走服务端真源）→ 可激活 → `POST /quick/run` 可打（对手=另一名带引用玩家）
//        → 归档回放按需重算 200 → `POST /ranked/run` 可打且 invalids=0。
test('E2E-7 装配链路：starter 的带装配引用出战配置可实战（quick + 归档回放重算 + ranked）', async () => {
  const s = await h.startE2E({ rateLimitPerMinute: h.RATE_LIMIT });
  try {
    const A = await h.registerPlayer(s, 'asmA');
    const B = await h.registerPlayer(s, 'asmB');
    assert.equal(A.status, 200, A.res.raw);
    assert.equal(B.status, 200, B.res.raw);
    const stA = await starterOf(s, A.token);
    const stB = await starterOf(s, B.token);
    const ldA = stA.loadout;
    const ldB = stB.loadout;
    const refsA = refUidsOf(ldA);
    const refsB = refUidsOf(ldB);
    assert.ok(refsA.length >= 1 && refsB.length >= 1,
      `starter 配置必须真的带装配引用（A=${refsA.length} B=${refsB.length}，D-159）`);
    // 引用必须落在**各自**的服务端真源仓库且已装配（D-159：校验优先用服务端仓库）
    for (const [wh, refs, who] of [[stA.warehouse, refsA, 'A'], [stB.warehouse, refsB, 'B']]) {
      for (const uid of refs) {
        const p = findItem(wh, uid);
        assert.ok(p && p.equipped === true, `${who} 的服务端仓库应含已装配插件 ${uid}`);
      }
    }

    // 保存（**不带 warehouse**：D-159 起引用校验走服务端真源；归档回放重算也走服务端真源，
    //   故"不提交客户端镜像"必须能完整跑通"保存 → 实战 → 回放"）
    const putA = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldA }, h.authed(A.token));
    assert.equal(putA.status, 200, putA.raw);
    assert.equal(typeof putA.body.data.snapshot.hash, 'string', '应冻结快照');
    const putB = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldB }, h.authed(B.token));
    assert.equal(putB.status, 200, putB.raw);
    // 快照必须自带到该配置引用到的插件（重启/镜像淘汰后仍可实例化）
    const aId = await h.playerIdByPublicId(s.store, A.publicId);
    const snapA = await s.store.snapshot.get(s.store.index.get(aId).activeSnapshotHash);
    assert.ok(snapA && snapA.loadout, 'A 的出战快照正文必须可读');
    const wA = await s.runtime.loadWarehouse(aId);
    assert.ok(wA, 'A 的仓库必须可解析（D-159：服务端真源为首选来源）');
    for (const uid of refsA) {
      assert.ok(findItem(wA, uid),
        `A 的仓库应含引用插件 ${uid}（插件数=${Object.values(wA.buckets).reduce((n, l) => n + l.length, 0)}；引用=${refsA.join(',')}）`);
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
