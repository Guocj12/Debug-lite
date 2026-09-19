#!/usr/bin/env node
'use strict';
/* scripts/e2e.js —— P7-5 全链路端到端：**真实玩家**从注册到快速对战的一条命令闭环
 *
 * 契约（唯一权威）：
 *   · docs/plan-p7-playable.md §P7-5（本阶段验收）+ §0（全局约束）
 *   · docs/reviews/P7-7-test-audit.md §B1「P7-5 应覆盖的检查点清单（22 条）」——本脚本**按该表顺序**逐步执行
 *   · docs/interfaces.md §2（端点表）/§7（环境变量）；docs/systems/11-account-store.md §10（端点/状态码）
 *   · decisions.md D-130/D-131/D-132/D-133/D-135/D-152
 *
 * 覆盖的 22 个检查点（编号 = §B1 表格行号，`[n/22]` 前缀即该行）：
 *   1 注册 200 + token；重名 409 user_exists；2 登录 / 错密码 401 / 连错 429 锁定 / logout 后 401；
 *   3 GET /me 401 三态与字段；4 GET /me 幂等；5 开箱 → PUT /me/warehouse → GET 往返一致；
 *   6 配置槽 ≤3 / 409 slot_limit / 409 slot_locked / 唯一出战 / 注册即默认配置；
 *   7 POST /panel 与单测 buildPanel 逐值一致；8 /ai/validate 三态（非法 400+path / 合法 warnings:[] /
 *     废弃动作 warnings 非空）；9 /ai/compile programHash 稳定；10 池空 quick/run **不注入 bot**；
 *   11 有对手时双方都是真实注册玩家；12 Elo 双向变动可复算 + cap 3000 不越界；13 积分守恒（对局 + 全局）；
 *   14 ranked/run 抽池排除自己 + 24h 去重 + 候选不足 shortfall；15 发起者同步结算 / 防守方离线只记战绩；
 *   16 战绩增量游标 + 未读归零；17 /me/defense 汇总；18 /leaderboard 降序且不暴露 playerId；
 *   19 回放：非参与者 403 / 过期或淘汰 410；20 CLI auth/me/quick/leaderboard + 退出码 3 = 未鉴权（并含
 *     `/ranked/promote`：兼容端点读档案、不越权落盘）；21 DL_LEGACY_STATELESS 兼容口径（=1 零回归 / =0 410）；
 *   22 一条命令退出码 0，且每一步打印真实响应关键字段。
 *
 * 约束（项目铁律）：零依赖；CommonJS；**禁 child_process / Math.random**（随机性一律来自显式 seed）；
 *   进程内起服务（`server/index.js` 导出的 handler + `node:http` 监听随机端口）；数据根 `os.tmpdir()` 隔离。
 *
 * 🚫 无占位 bot（用户 2026-09-16 明令 / D-152）：对局双方一律是 `/auth/register` 注册的**真实档案**；
 *   本脚本对每场对局涉及的每个 publicId 都回查 `store.index` → `playerId` → 档案 + 出战快照作为证据
 *   （末尾"无 bot 证据"清单逐条打印）。
 *
 * 已知后端缺陷（只报告，未修）：本脚本第 6 步的出战配置**剥离了装配引用**。
 *   原因：装配后的 loadout 一旦被激活，`POST /ranked/run` 与 `POST /quick/run` 都会失败——
 *   `server/ranked.js`/`server/quickmatch.js` 以 `warehouse=null` 调 `battle.buildPlayer`，
 *   而快照库不保存仓库镜像，`loadout.validateLoadout` 于是报 `missing_warehouse`（T-PB-9）。
 *   复现与建议修法见交付报告"发现的后端缺陷 D1"（docs/systems/11-account-store.md §7.4 已要求
 *   "对手配置来自服务端快照，其仓库镜像与快照一同保存在快照库里"，属该条款未落地）。
 *
 * 用法：npm run e2e   （或 node scripts/e2e.js）
 * 退出码：0 = 22 个检查点全过；1 = 任一步失败（并打印该步上游真实响应）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const httpMod = require('node:http');
const serverMod = require('../server/index.js');
const itemsCore = require('../server/core/items.js');
const loadoutApi = require('../server/loadout.js');
const quickmatch = require('../server/quickmatch.js');
const ledger = require('../server/store/ledger.js');
const authMod = require('../server/auth.js');
const cliMain = require('../cli/index.js'); // 检查点 20：CLI 子命令（只走 HTTP）
const RATING = require('../server/data/rating-config.json');

const PASSWORD = 'pw12345678';
// 端到端无需承担生产 scrypt 成本；`rateLimitPerMinute` 放宽是因为本链路有 6 次注册 + 6 次登录
// （同一 IP 计数），会撞上生产默认的"10 次/分/IP"防护——该防护本身由 `server/auth.js` 的
// `createFailureLimiter` 单测与 `tests/api/api-auth.test.js` AU-8 专门覆盖，这里保留的是**锁定**语义
// （`maxFailures`/`lockMinutes` 保持生产默认 5/5，检查点 2 的 429 因此依旧是真的业务锁定）。
const FAST_AUTH = { auth: { scrypt: { N: 1024, r: 8, p: 1 }, rateLimitPerMinute: 1000 } };
const RATE_LIMIT = 100000000; // 等价关闭全局限速（限速语义由 tests/api/api-auth.test.js AU-8 专测）
const MODE = 'common';        // 门控默认关闭（D-137），tier 仅作回带

const out = (s) => process.stdout.write(`${s}\n`);
const j = (v) => JSON.stringify(v);
const short = (v, n) => {
  const s = typeof v === 'string' ? v : j(v);
  const lim = n || 160;
  return s.length > lim ? `${s.slice(0, lim)}…` : s;
};

/* ---------- 运行框架：任一步失败 → 打印上游真实响应 + 非零退出 ---------- */

const state = { step: 0, steps: [], facts: {} };
const noBotLog = [];

function fail(msg, upstream) {
  const e = new Error(msg);
  e.upstream = upstream;
  throw e;
}

function expect(cond, msg, upstream) {
  if (!cond) fail(msg, upstream);
}

function okLine(n, title, detail) {
  out(`[${n}/22] ✔ ${title}${detail ? ` — ${detail}` : ''}`);
}

async function step(n, title, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    const ms = Date.now() - started;
    state.steps.push({ n, title, ok: true, ms, note: note === undefined ? '' : String(note) });
    return note;
  } catch (e) {
    const ms = Date.now() - started;
    state.steps.push({ n, title, ok: false, ms, note: e.message });
    out(`[${n}/22] ✘ ${title}`);
    if (e.upstream !== undefined) out(`        上游真实响应：${short(e.upstream, 900)}`);
    out(`        断言失败：${e.message}`);
    throw e;
  }
}

/* ---------- 真实玩家的唯一凭据：publicId → playerId → 档案 + 快照 ---------- */

async function playerIdByPublicId(store, publicId) {
  for (const id of store.index.playerIds()) {
    const entry = store.index.get(id);
    if (entry && entry.publicId === publicId) return id;
  }
  return null;
}

async function realPlayerProof(store, publicId) {
  const playerId = await playerIdByPublicId(store, publicId);
  if (!playerId) return null;
  const archive = await store.loadArchive(playerId);
  if (!archive) return null;
  const slot = archive.configs.slots.find((x) => x.slotId === archive.configs.activeSlotId);
  const snapshot = slot && slot.snapshot ? await store.snapshot.get(slot.snapshot.hash) : null;
  return {
    playerId, publicId,
    nickname: archive.nickname,
    isBot: !!(archive.flags && archive.flags.isBot),
    tier: archive.progress.tier,
    points: archive.rating.points,
    snapshotHash: slot ? slot.snapshot.hash : null,
    hasLoadout: !!(snapshot && snapshot.loadout),
  };
}

// 断言双方都是真实注册玩家（回查档案库；isBot 一律拒绝）
async function assertReal(store, publicIds, where) {
  for (const publicId of publicIds) {
    const proof = await realPlayerProof(store, publicId);
    expect(proof !== null, `${where}：publicId ${publicId} 无法从档案库反查到 playerId（疑似占位 bot）`);
    expect(proof.isBot === false, `${where}：publicId ${publicId} 的档案 flags.isBot=true（bot 参与了对局）`);
    expect(proof.hasLoadout === true, `${where}：publicId ${publicId} 无可用出战快照（无法证明是真实玩家）`);
    noBotLog.push({ where, ...proof });
  }
}

/* ---------- HTTP（node:http，零依赖） ---------- */

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const h = { ...(headers || {}) };
    if (body !== undefined && h['content-type'] === undefined) h['content-type'] = 'application/json';
    const req = httpMod.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, body: json, raw: data });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const authed = (token) => ({ authorization: `Bearer ${token}` });

// 清空某玩家档案里的对手冷却记录（等价"24h 已过"；仅用于让 CLI 快速对战这条独立检查点可复现）
async function clearOpponentHistory(store, playerId) {
  await store.updateArchive(playerId, (archive) => {
    archive.pool.lastOpponentAt = {};
    return null;
  });
  return store.loadArchive(playerId);
}

/* ---------- 物品/出战构造（只走真实端点） ---------- */

function findItem(wh, uid) {
  for (const list of Object.values((wh && wh.buckets) || {})) {
    if (!Array.isArray(list)) continue;
    const it = list.find((x) => x && x.uid === uid);
    if (it) return it;
  }
  return null;
}

async function openAndAssemble(port, token, seedBase, tag, wantRole, wantSkill) {
  const warehouse = itemsCore.emptyWarehouse();
  const opened = [];
  let round = 0;
  while ((warehouse.buckets.role.length < wantRole || warehouse.buckets.skill.length < wantSkill) && round < 8) {
    const r = await request(port, 'POST', '/api/v1/box', { seed: seedBase + round * 977, tier: MODE, times: 12 }, authed(token));
    expect(r.status === 200, `${tag} 开箱失败 ${r.status}`, r.raw);
    for (const it of r.body.data.items) {
      if (!Array.isArray(warehouse.buckets[it.kind])) warehouse.buckets[it.kind] = [];
      warehouse.buckets[it.kind].push(it);
      opened.push(it);
    }
    round += 1;
  }
  expect(warehouse.buckets.role.length >= wantRole && warehouse.buckets.skill.length >= wantSkill,
    `${tag} 开箱 ${round} 轮仍不足（角色 ${warehouse.buckets.role.length}/${wantRole}，技能 ${warehouse.buckets.skill.length}/${wantSkill}）`);
  let cur = warehouse;
  const placed = [];
  const skipped = [];
  for (const t0 of cur.buckets.role.concat(cur.buckets.skill)) {
    for (let i = 0; i < (t0.slots || []).length; i++) {
      const target = findItem(cur, t0.uid);
      if (!target || !target.slots[i] || target.slots[i].pluginUid) continue;
      const kind = target.kind === 'role' ? 'rolePlugin' : 'skillPlugin';
      const cand = (cur.buckets[kind] || []).find((p) => p.slot === target.slots[i].type && p.equipped !== true);
      if (!cand) { skipped.push(`${target.uid}[${i}] 无 ${target.slots[i].type} 槽插件`); continue; }
      const a = await request(port, 'POST', '/api/v1/warehouse/assemble',
        { warehouse: cur, targetUid: target.uid, pluginUid: cand.uid, slotIndex: i, tier: MODE }, authed(token));
      if (a.status === 200) { cur = a.body.data.warehouse; placed.push(`${cand.uid}→${target.uid}[${i}]`); }
      else skipped.push(`${target.uid}[${i}] ${a.body.error.code}`);
    }
  }
  return { warehouse: cur, opened, placed, skipped, rounds: round };
}

// 「裸」出战配置：剥离槽内装配引用（保留 slots 类型结构）——原因见文件头 D1
function bareLoadout(ld) {
  const copy = JSON.parse(JSON.stringify(ld));
  for (const s of copy.role.slots || []) s.pluginUid = null;
  for (const sk of copy.skills || []) for (const s of sk.slots || []) s.pluginUid = null;
  return copy;
}

// 确定性对局剧本（只改**客户端权威**的物品字段，§15.1 混合权威）：把一方的 hp 压到 1 且双方都"一直向右"
// → 双方会在场地中央接触，A 先手把 B 打到 1hp 归零 → A 胜（seed 无关、tick 恒定）。
// 用途：让 Elo 双向 Δ 非零、积分守恒可观测（否则同血同 AI 会长期平局 Δ=0）。
const HOLD_RIGHT = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } };

function scriptedLoadout(warehouse, fragile) {
  const ld = bareLoadout({
    role: warehouse.buckets.role[0],
    skills: warehouse.buckets.skill.slice(0, 3),
    ai: HOLD_RIGHT,
  });
  if (fragile) ld.role.stats = { hp: 1, atk: 12, def: 0, sp: 60, mp: 40 };
  return ld;
}

/* ---------- 主流程 ---------- */

async function main() {
  const t0 = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-p7-5-e2e-'));
  let s = null;
  try {
    process.env.DL_DATA_DIR = dataDir; // §7：运行时数据根隔离（os.tmpdir()）
    s = await serverMod.start({
      port: 0, // 随机端口
      dataDir,
      authConfig: FAST_AUTH,
      rateLimitPerMinute: RATE_LIMIT,
      env: { DL_DATA_DIR: dataDir, DL_LEGACY_STATELESS: '1' },
    });
    const port = s.port;
    const base = `http://127.0.0.1:${port}`;

    out('=== Debug-Lite v3 · P7-5 全链路端到端（npm run e2e） ===');
    out(`服务：${base}（随机端口，进程内 handler）  数据根：${dataDir}（DL_DATA_DIR，os.tmpdir 隔离）`);
    out(`覆盖：docs/reviews/P7-7-test-audit.md §B1 的 22 个检查点（按表顺序执行）  段位：${MODE}（D-137 门控默认关闭）`);
    out('🚫 无占位 bot：对局双方一律为 /auth/register 的真实档案（每个 publicId 回查 store.index → playerId → 快照）');
    out('');

    /* ---- [1/22] 注册两个真实玩家 ---- */
    await step(1, 'POST /auth/register → 200/201 + token；重名 → 409 user_exists', async () => {
      const a = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_alpha_1', password: PASSWORD, nickname: '阿尔法' });
      expect(a.status === 200 || a.status === 201, `注册状态码应为 200/201，实得 ${a.status}`, a.raw);
      expect(a.body.ok === true && typeof a.body.data.token === 'string' && a.body.data.token.length >= 40, '注册应下发 token', a.raw);
      expect(typeof a.body.data.publicId === 'string' && a.body.data.publicId.startsWith('u_'), '注册应下发 publicId', a.raw);
      expect(!a.raw.includes('pl_'), '注册响应不得回带 playerId（§4.5）', a.raw);
      state.facts.A = { token: a.body.data.token, publicId: a.body.data.publicId, username: 'e2e_alpha_1' };
      state.facts.A.playerId = await playerIdByPublicId(s.store, state.facts.A.publicId);
      expect(typeof state.facts.A.playerId === 'string' && state.facts.A.playerId.startsWith('pl_'),
        'A 的 publicId 必须能反查到真实 playerId（档案库）', j(a.body));

      const b = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_beta_2', password: PASSWORD, nickname: '贝塔' });
      expect(b.status === 200 || b.status === 201, `B 注册失败 ${b.status}`, b.raw);
      state.facts.B = { token: b.body.data.token, publicId: b.body.data.publicId, username: 'e2e_beta_2' };
      state.facts.B.playerId = await playerIdByPublicId(s.store, state.facts.B.publicId);

      const dup = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_alpha_1', password: PASSWORD });
      expect(dup.status === 409, `重名注册应 409，实得 ${dup.status}`, dup.raw);
      expect(dup.body.error && dup.body.error.code === 'username_taken', `重名错误码应为 username_taken，实得 ${j(dup.body.error)}`, dup.raw);
      okLine(1, '注册 2 个真实玩家', `A=${state.facts.A.publicId}(${state.facts.A.playerId}) B=${state.facts.B.publicId}(${state.facts.B.playerId})，token 长度 ${state.facts.A.token.length}；重名 → 409 username_taken`);
      return `A=${state.facts.A.publicId} B=${state.facts.B.publicId}`;
    });

    /* ---- [2/22] 登录 / 401 / 429 锁定 / logout ---- */
    await step(2, 'POST /auth/login → token；错密码 401；连错 N 次 → 429 锁定；logout 后旧 token → 401', async () => {
      const login = await request(port, 'POST', '/api/v1/auth/login', { username: state.facts.A.username, password: PASSWORD });
      expect(login.status === 200 && typeof login.body.data.token === 'string', `登录应 200 + token，实得 ${login.status}`, login.raw);
      const secondToken = login.body.data.token;

      const wrong = await request(port, 'POST', '/api/v1/auth/login', { username: state.facts.A.username, password: 'wrong-password' });
      expect(wrong.status === 401, `错密码应 401，实得 ${wrong.status}`, wrong.raw);
      expect(wrong.body.error.code === 'invalid_credentials', `错密码错误码应为 invalid_credentials，实得 ${j(wrong.body.error)}`, wrong.raw);

      const victim = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_lock_3', password: PASSWORD });
      expect(victim.status === 200 || victim.status === 201, `锁定用例注册失败 ${victim.status}`, victim.raw);
      state.facts.victim = { token: victim.body.data.token, publicId: victim.body.data.publicId };
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        const r = await request(port, 'POST', '/api/v1/auth/login', { username: 'e2e_lock_3', password: 'bad-password' });
        statuses.push(r.status);
      }
      const locked = await request(port, 'POST', '/api/v1/auth/login', { username: 'e2e_lock_3', password: PASSWORD });
      expect(locked.status === 429, `连续失败 5 次后应 429，实得 ${locked.status}（前 5 次 ${statuses.join(',')}）`, locked.raw);
      expect(locked.body.error.code === 'too_many_attempts', `锁定错误码应为 too_many_attempts，实得 ${j(locked.body.error)}`, locked.raw);

      const out1 = await request(port, 'POST', '/api/v1/auth/logout', {}, authed(secondToken));
      expect(out1.status === 200 && out1.body.data.revoked === true, `logout 应 200 revoked:true，实得 ${out1.status}`, out1.raw);
      const after = await request(port, 'GET', '/api/v1/me', undefined, authed(secondToken));
      expect(after.status === 401, `logout 后旧 token 应 401，实得 ${after.status}`, after.raw);
      okLine(2, '登录 / 401 / 429 锁定 / logout 撤销', `token 二次下发 OK；错密码 401 invalid_credentials；连错 5 次 → 429 too_many_attempts；logout → 200 revoked:true；旧 token → 401 ${after.body.error.code}`);
      return 'login 200；401/429/logout-401 全中';
    });

    /* ---- [3/22] GET /me 鉴权语义与字段 ---- */
    await step(3, 'GET /me：无 token 401 / 坏 token 401 / 过期 401 / 正常 → {publicId,progress,rating,slots,unread}', async () => {
      const none = await request(port, 'GET', '/api/v1/me');
      expect(none.status === 401 && none.body.error.code === 'unauthorized', `无 token 应 401 unauthorized，实得 ${none.status} ${j(none.body.error)}`, none.raw);
      const bad = await request(port, 'GET', '/api/v1/me', undefined, authed('not-a-real-token'));
      expect(bad.status === 401, `坏 token 应 401，实得 ${bad.status}`, bad.raw);
      const expiredToken = 'e2e-expired-token';
      const at = Date.now();
      s.store.sessions.put({
        tokenHash: authMod.tokenHashOf(expiredToken), playerId: state.facts.A.playerId,
        createdAt: at - 100000, lastUsedAt: at - 100000, expiresAt: at - 1000,
      });
      const exp = await request(port, 'GET', '/api/v1/me', undefined, authed(expiredToken));
      expect(exp.status === 401, `过期 token 应 401，实得 ${exp.status}`, exp.raw);
      expect(exp.body.error.code === 'session_expired', `过期错误码应为 session_expired，实得 ${j(exp.body.error)}`, exp.raw);

      const me = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(me.status === 200, `正常 /me 应 200，实得 ${me.status}`, me.raw);
      const d = me.body.data;
      expect(d.publicId === state.facts.A.publicId, 'publicId 应与注册一致', me.raw);
      expect(typeof d.progress.tier === 'string', '/me 应含 progress.tier', me.raw);
      expect(typeof d.rating.points === 'number', '/me 应含 rating.points', me.raw);
      expect(Array.isArray(d.slots) && d.slots.length === 1 && d.slots[0].isDefault === true, '注册即默认配置（D-131）', me.raw);
      expect(d.activeSlotId === 'slot1', `出战槽应为 slot1，实得 ${d.activeSlotId}`, me.raw);
      expect(typeof d.record.unread.attack === 'number' && typeof d.record.unread.defense === 'number', '/me 应含 unread 计数', me.raw);
      expect(!me.raw.includes('pl_'), '/me 不得回带 playerId（§4.5）', me.raw);
      okLine(3, 'GET /me 鉴权与字段', `401 unauthorized / 401（坏 token）/ 401 session_expired / 200 {publicId:${d.publicId}, tier:${d.progress.tier}, points:${d.rating.points}, slots:${d.slots.length}, unread:${j(d.record.unread)}}`);
      return `tier=${d.progress.tier} points=${d.rating.points} slots=${d.slots.length}`;
    });

    /* ---- [4/22] GET /me 幂等 ---- */
    await step(4, 'GET /me 幂等：连续两次逐值一致（无副作用）', async () => {
      const r1 = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      const r2 = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(r1.status === 200 && r2.status === 200, '两次 /me 都应 200', `${r1.status}/${r2.status}`);
      expect(j(r1.body.data) === j(r2.body.data), '两次 /me 的 data 必须逐值一致（幂等、无副作用）', `${short(r1.raw, 300)} VS ${short(r2.raw, 300)}`);
      okLine(4, 'GET /me 幂等', `两次 data 逐字节一致（${j(r1.body.data).length} 字节）`);
      return 'deepEqual';
    });

    /* ---- [5/22] 开箱 → 仓库镜像往返一致 ---- */
    await step(5, '开箱 → PUT /me/warehouse → GET /me/warehouse 往返一致（round-trip）', async () => {
      const asmA = await openAndAssemble(port, state.facts.A.token, 4242, 'A', 1, 3);
      const asmB = await openAndAssemble(port, state.facts.B.token, 9100, 'B', 1, 3);
      state.facts.asmA = asmA;
      state.facts.asmB = asmB;
      const merged = itemsCore.emptyWarehouse();
      for (const k of Object.keys(merged.buckets)) merged.buckets[k] = asmA.warehouse.buckets[k].concat(asmB.warehouse.buckets[k]);
      state.facts.merged = merged;

      const put = await request(port, 'PUT', '/api/v1/me/warehouse', { warehouse: asmA.warehouse }, authed(state.facts.A.token));
      expect(put.status === 200, `PUT /me/warehouse 应 200，实得 ${put.status}`, put.raw);
      expect(put.body.data.saved === true && typeof put.body.data.warehouseHash === 'string', 'PUT 应回带 saved/warehouseHash', put.raw);
      const get = await request(port, 'GET', '/api/v1/me/warehouse', undefined, authed(state.facts.A.token));
      expect(get.status === 200, `GET /me/warehouse 应 200，实得 ${get.status}`, get.raw);
      expect(get.body.data.warehouseHash === put.body.data.warehouseHash,
        `往返 hash 必须一致：PUT ${put.body.data.warehouseHash} ≠ GET ${get.body.data.warehouseHash}`, `${short(put.raw, 300)} VS ${short(get.raw, 300)}`);
      expect(j(get.body.data.warehouse) === j(put.body.data.warehouse), '往返正文必须逐值一致', short(get.raw, 400));
      const counts = {};
      for (const [k, arr] of Object.entries(asmA.warehouse.buckets)) counts[k] = arr.length;
      okLine(5, '开箱 → 装配 → 仓库镜像往返', `开箱 ${asmA.rounds * 12 + asmB.rounds * 12} 箱（A ${asmA.opened.length} 件/装配成功 ${asmA.placed.length} 处；B ${asmB.opened.length} 件/装配成功 ${asmB.placed.length} 处）；PUT hash=${short(put.body.data.warehouseHash, 24)} ≡ GET hash；A 仓库 buckets=${j(counts)}`);
      return `hash 往返一致`;
    });

    /* ---- [6/22] 配置槽规则 ---- */
    await step(6, '配置槽：建 ≤3；第 4 个 409 slot_limit；删出战槽 409 slot_locked；激活唯一；注册即默认配置', async () => {
      const me0 = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(me0.body.data.slots.length === 1 && me0.body.data.slots[0].isDefault === true, '注册即默认配置', me0.raw);

      // 出战配置来自真实开箱物品（此处剥离装配引用，原因见文件头 D1）
      const ldA = scriptedLoadout(state.facts.asmA.warehouse, false); // A：正常 hp（用于 /panel ≡ buildPanel）
      const ldB = scriptedLoadout(state.facts.asmB.warehouse, false);
      state.facts.ldA = ldA;
      const save = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: ldA, warehouse: state.facts.asmA.warehouse }, authed(state.facts.A.token));
      expect(save.status === 200, `PUT /me/configs/slot1 应 200，实得 ${save.status}`, save.raw);
      expect(typeof save.body.data.snapshot.hash === 'string', '保存应冻结新快照', save.raw);
      const saveB = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: ldB, warehouse: state.facts.asmB.warehouse }, authed(state.facts.B.token));
      expect(saveB.status === 200, `PUT /me/configs/slot1（B）应 200，实得 ${saveB.status}`, saveB.raw);

      const c1 = await request(port, 'POST', '/api/v1/me/configs', { name: '第二套' }, authed(state.facts.A.token));
      expect(c1.status === 200, `新建第 2 槽应 200，实得 ${c1.status}`, c1.raw);
      const c2 = await request(port, 'POST', '/api/v1/me/configs', { name: '第三套' }, authed(state.facts.A.token));
      expect(c2.status === 200, `新建第 3 槽应 200，实得 ${c2.status}`, c2.raw);
      expect(c2.body.data.slots.length === 3, `槽数应达 3，实得 ${c2.body.data.slots.length}`, c2.raw);
      const c3 = await request(port, 'POST', '/api/v1/me/configs', { name: '第四套' }, authed(state.facts.A.token));
      expect(c3.status === 409, `第 4 槽应 409，实得 ${c3.status}`, c3.raw);
      expect(c3.body.error.code === 'slot_limit', `第 4 槽错误码应为 slot_limit，实得 ${j(c3.body.error)}`, c3.raw);

      const act = await request(port, 'POST', '/api/v1/me/configs/slot2/activate', {}, authed(state.facts.A.token));
      expect(act.status === 200 && act.body.data.activeSlotId === 'slot2', `激活 slot2 应 200 且 activeSlotId=slot2，实得 ${act.status}`, act.raw);
      expect(typeof act.body.data.activeSnapshotHash === 'string', '激活应同步 activeSnapshotHash', act.raw);

      const lockedDel = await request(port, 'DELETE', '/api/v1/me/configs/slot2', undefined, authed(state.facts.A.token));
      expect(lockedDel.status === 409 && lockedDel.body.error.code === 'slot_locked', `删出战槽应 409 slot_locked，实得 ${lockedDel.status} ${j(lockedDel.body.error)}`, lockedDel.raw);
      const back = await request(port, 'POST', '/api/v1/me/configs/slot1/activate', {}, authed(state.facts.A.token));
      expect(back.status === 200 && back.body.data.activeSlotId === 'slot1', '切回 slot1', back.raw);
      const del = await request(port, 'DELETE', '/api/v1/me/configs/slot2', undefined, authed(state.facts.A.token));
      expect(del.status === 200 && del.body.data.deleted === 'slot2', `非出战槽应可删（200），实得 ${del.status}`, del.raw);
      const delDefault = await request(port, 'DELETE', '/api/v1/me/configs/slot1', undefined, authed(state.facts.A.token));
      expect(delDefault.status === 409 && delDefault.body.error.code === 'slot_locked', `默认槽不可删（409 slot_locked），实得 ${delDefault.status}`, delDefault.raw);

      const noAuth = await request(port, 'POST', '/api/v1/me/configs', { name: 'x' });
      expect(noAuth.status === 401, `未鉴权新建槽应 401，实得 ${noAuth.status}`, noAuth.raw);
      okLine(6, '配置槽规则', `注册即 slot1(isDefault) → 建到 3 槽 OK → 第 4 槽 409 slot_limit → 激活 slot2(activeSlotId=slot2, activeSnapshotHash 同步) → 删出战槽 409 slot_locked → 切回后可删 → 默认槽 409 slot_locked；未鉴权 401`);
      return 'slot_limit / slot_locked / 唯一出战全中';
    });

    /* ---- [7/22] 装配后 POST /panel ≡ buildPanel ---- */
    await step(7, '装配后 POST /panel 与单测 buildPanel 逐值一致（端到端认面板）', async () => {
      const pan = await request(port, 'POST', '/api/v1/panel', { loadout: state.facts.ldA, tier: MODE });
      expect(pan.status === 200, `POST /panel 应 200，实得 ${pan.status}`, pan.raw);
      const local = loadoutApi.buildPanel(state.facts.ldA, { warehouse: null, tier: MODE });
      expect(local.ok === true, '单测 buildPanel 应通过', j(local.errors));
      expect(j(pan.body.data.panel) === j(local.panel), 'HTTP /panel 与单测 buildPanel 必须逐值一致', `${short(j(pan.body.data.panel), 400)} VS ${short(j(local.panel), 400)}`);
      const st = pan.body.data.panel.role.stats;
      // 装配链路的独立证据：仓库里确实产生了 equipped=true 的插件（走 POST /warehouse/assemble）
      const equipped = state.facts.asmA.warehouse.buckets.rolePlugin.concat(state.facts.asmA.warehouse.buckets.skillPlugin).filter((p) => p.equipped === true);
      expect(equipped.length === state.facts.asmA.placed.length,
        `装配成功 ${state.facts.asmA.placed.length} 处，但仓库里 equipped=true 的插件 ${equipped.length} 个（不一致）`);
      okLine(7, 'POST /panel ≡ buildPanel', `五维 hp${st.hp}/atk${st.atk}/def${st.def}/sp${st.sp}/mp${st.mp}；技能参数 ${pan.body.data.panel.skills.length} 条；与单测逐值一致；本玩家仓库 equipped=true 插件 ${equipped.length} 个（=装配成功数）`);
      return `hp=${st.hp} atk=${st.atk} def=${st.def}`;
    });

    /* ---- [8/22] /ai/validate 三态 ---- */
    await step(8, '/ai/validate：非法 → 400 + details[].path；合法 → warnings:[]；废弃动作 → warnings 非空', async () => {
      const legal = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
      const v1 = await request(port, 'POST', '/api/v1/ai/validate', { program: legal, tier: MODE });
      expect(v1.status === 200 && v1.body.data.ok === true, `合法程序应 200 ok:true，实得 ${v1.status}`, v1.raw);
      expect(Array.isArray(v1.body.data.warnings) && v1.body.data.warnings.length === 0, `合法程序 warnings 应为 []，实得 ${j(v1.body.data.warnings)}`, v1.raw);

      const deprecated = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'teleport' }] } };
      const v2 = await request(port, 'POST', '/api/v1/ai/validate', { program: deprecated, tier: MODE });
      expect(v2.status === 200 && v2.body.data.ok === true, `未登记动作名不应拒绝（D-80），实得 ${v2.status}`, v2.raw);
      expect(Array.isArray(v2.body.data.warnings) && v2.body.data.warnings.length > 0, '未登记动作名应产生 warnings', v2.raw);
      expect(v2.body.data.warnings[0].code === 'unknown_action', `warnings[0].code 应为 unknown_action，实得 ${j(v2.body.data.warnings[0])}`, v2.raw);

      const illegal = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'if', cond: { type: 'cmp', op: '<', left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 2 } }, then: { type: 'seq', statements: [] } }] } };
      const v3 = await request(port, 'POST', '/api/v1/ai/validate', { program: illegal, tier: MODE });
      expect(v3.status === 400, `非法程序应 400，实得 ${v3.status}`, v3.raw);
      expect(v3.body.error.code === 'ai_invalid', `非法程序错误码应为 ai_invalid，实得 ${j(v3.body.error.code)}`, v3.raw);
      expect(Array.isArray(v3.body.error.details) && v3.body.error.details.length > 0 && typeof v3.body.error.details[0].path === 'string',
        '非法程序 details 应带 path', v3.raw);
      state.facts.aiProgram = legal;
      okLine(8, '/ai/validate 三态', `合法 → 200 warnings:[]；未登记动作 teleport → 200 warnings[0]=${v2.body.data.warnings[0].code}（不拒绝，D-80/D-146）；空分支 → 400 ai_invalid details[0]={path:'${v3.body.error.details[0].path}', code:'${v3.body.error.details[0].code}'}`);
      return '200 / 200+warning / 400 三态全中';
    });

    /* ---- [9/22] /ai/compile programHash 稳定 ---- */
    await step(9, '/ai/compile → programHash 稳定（同程序两次 hash 相同）', async () => {
      const c1 = await request(port, 'POST', '/api/v1/ai/compile', { program: state.facts.aiProgram });
      const c2 = await request(port, 'POST', '/api/v1/ai/compile', { program: state.facts.aiProgram });
      expect(c1.status === 200 && c2.status === 200, `compile 应 200，实得 ${c1.status}/${c2.status}`, c1.raw);
      expect(typeof c1.body.data.programHash === 'string' && c1.body.data.programHash.length === 64, 'programHash 应为 64 hex', c1.raw);
      expect(c1.body.data.programHash === c2.body.data.programHash, '同程序两次 compile 的 programHash 必须相同', `${c1.body.data.programHash} VS ${c2.body.data.programHash}`);
      okLine(9, '/ai/compile programHash 稳定', `hash=${short(c1.body.data.programHash, 32)}；nodes=${c1.body.data.stats.nodes}；两次逐字节一致`);
      return c1.body.data.programHash;
    });

    /* ---- [10/22] 池空 → 不注入 bot ---- */
    await step(10, 'POST /quick/run（池空）→ 不得注入 bot：409 no_opponent，且不产生任何对局记录', async () => {
      const solo = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_solo_4', password: PASSWORD });
      expect(solo.status === 200 || solo.status === 201, `独狼注册失败 ${solo.status}`, solo.raw);
      const soloToken = solo.body.data.token;
      const soloId = await playerIdByPublicId(s.store, solo.body.data.publicId);
      state.facts.solo = { token: soloToken, publicId: solo.body.data.publicId, playerId: soloId };
      expect(state.facts.solo.playerId === null || typeof state.facts.solo.playerId === 'string', '独狼档案应可回查', solo.raw);

      const r = await request(port, 'POST', '/api/v1/quick/run', {}, authed(soloToken));
      // 池中此刻只有 A/B（0 分或刚打完 1 场）——若窗口命中则必须抽真实档案；否则必须如实拒配。
      if (r.status === 200) {
        await assertReal(s.store, [state.facts.solo.publicId, r.body.data.opponent.publicId], 'quick/run(池空分支)');
        expect(r.body.data.opponent.isBot === false, '对手不得是 bot', r.raw);
      } else {
        expect(r.status === 409, `池空/无候选应 409，实得 ${r.status}`, r.raw);
        expect(r.body.error.code === 'no_opponent', `错误码应为 no_opponent，实得 ${j(r.body.error)}`, r.raw);
      }
      const rec = await request(port, 'GET', '/api/v1/me/records', undefined, authed(soloToken));
      expect(rec.status === 200, 'records 应 200', rec.raw);
      const expectCount = r.status === 200 ? 1 : 0;
      expect(rec.body.data.records.length === expectCount,
        `池空分支不得凭空产生对局：期望 ${expectCount} 条，实得 ${rec.body.data.records.length}`, rec.raw);
      const meta = s.store.index.get(soloId);
      expect(meta && meta.isBot !== true, '玩家档案不应被标记为 bot', j(meta));
      okLine(10, '池空 quick/run 不注入 bot', `结果 ${r.status}${r.status === 200 ? `（抽到真实玩家 ${r.body.data.opponent.publicId}，回查档案库 OK）` : ` ${r.body.error.code}（"${r.body.error.message}"）`}；该玩家战绩 ${rec.body.data.records.length} 条 → 无 bot 陪打（D-152）；档案 isBot=${meta ? meta.isBot : null}`);
      return `${r.status} / 战绩 ${rec.body.data.records.length} 条`;
    });

    /* ---- [11/22] 有对手 → 双方真实玩家 ---- */
    await step(11, 'POST /quick/run 有对手 → 双方 playerId 都是真实注册玩家（对手 ID 在注册表内）', async () => {
      // 剧本：把 A 压到 1hp（客户端权威的物品字段，§15.1）→ A 必败；同时让 Elo 双向 Δ 非零
      const fragileA = scriptedLoadout(state.facts.asmA.warehouse, true);
      const saveFragile = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: fragileA, warehouse: state.facts.asmA.warehouse }, authed(state.facts.A.token));
      expect(saveFragile.status === 200, `剧本配置（A 1hp）应保存成功，实得 ${saveFragile.status}`, saveFragile.raw);
      state.facts.ldA = fragileA;

      const pointsBefore = s.store.index.playerIds().reduce((a, id) => a + s.store.index.get(id).points, 0);
      state.facts.globalPointsBefore = pointsBefore;
      const r = await request(port, 'POST', '/api/v1/quick/run', { seed: 20260921 }, authed(state.facts.B.token));
      expect(r.status === 200, `快速对战应 200（池中有真实对手），实得 ${r.status}`, r.raw);
      const d = r.body.data;
      expect(typeof d.battleId === 'string' && /^b_[0-9a-f]{16}$/.test(d.battleId), `battleId 应为内容寻址 b_…，实得 ${d.battleId}`, r.raw);
      expect(d.opponent && typeof d.opponent.publicId === 'string', '响应应回带对手 publicId', r.raw);
      expect(d.opponent.isBot === false, '对手不得是 bot（isBot=true 即违约）', r.raw);
      expect(!r.raw.includes('pl_'), '快速对战响应不得回带 playerId（§4.5）', r.raw);
      await assertReal(s.store, [state.facts.B.publicId, d.opponent.publicId], 'quick/run');
      expect(d.opponent.publicId !== state.facts.B.publicId, '对手不得是自己', r.raw);
      state.facts.quick1 = d;
      okLine(11, 'quick/run 双方都是真实玩家', `发起者 ${state.facts.B.publicId}(${state.facts.B.playerId}) vs 对手 ${d.opponent.publicId} → 档案库回查 OK（isBot=false，出战快照可用）；battleId=${d.battleId}；响应无 pl_`);
      return `对手=${d.opponent.publicId}`;
    });

    /* ---- [12/22] Elo 可复算 + cap ---- */
    await step(12, "Elo：R' = R + K(S−E) 双向变动可复算；cap 3000 不越界", async () => {
      const d = state.facts.quick1;
      const selfResult = d.winner === 'win' ? 'win' : d.winner === 'loss' ? 'loss' : 'draw';
      const foeResult = d.winner === 'win' ? 'loss' : d.winner === 'loss' ? 'win' : 'draw';
      const selfCalc = quickmatch.ratingDelta({ points: d.self.pointsBefore, opponentPoints: d.opponent.pointsBefore, result: selfResult, config: RATING });
      const foeCalc = quickmatch.ratingDelta({ points: d.opponent.pointsBefore, opponentPoints: d.self.pointsBefore, result: foeResult, config: RATING });
      expect(d.self.pointsAfter === selfCalc.pointsAfter,
        `发起者积分应可复算：档案 ${d.self.pointsAfter} ≠ 公式 ${selfCalc.pointsAfter}（R=${d.self.pointsBefore}，E=${selfCalc.expected}）`, j(d));
      expect(d.opponent.pointsAfter === foeCalc.pointsAfter, `对手积分应可复算：档案 ${d.opponent.pointsAfter} ≠ 公式 ${foeCalc.pointsAfter}`, j(d));
      expect(d.self.delta === selfCalc.pointsAfter - d.self.pointsBefore, '发起者 Δ 应等于公式差', j(d.self));
      expect(d.opponent.delta === foeCalc.pointsAfter - d.opponent.pointsBefore, '对手 Δ 应等于公式差', j(d.opponent));
      for (const side of ['self', 'opponent']) {
        expect(d[side].pointsAfter >= 0 && d[side].pointsAfter <= RATING.cap, `${side}.pointsAfter=${d[side].pointsAfter} 越界 [0,${RATING.cap}]`, j(d[side]));
      }
      const atCap = ledger.ratingDelta({ points: RATING.cap, opponentPoints: RATING.cap, result: 'win', config: RATING });
      expect(atCap.pointsAfter === RATING.cap, `cap 处再胜应停在 ${RATING.cap}，实得 ${atCap.pointsAfter}`, j(atCap));
      okLine(12, 'Elo 双向可复算 + cap 不越界', `发起者 ${d.self.pointsBefore}→${d.self.pointsAfter}（Δ${d.self.delta}，E=${selfCalc.expected.toFixed(4)}，K=${selfCalc.k}）≡ 公式；对手 ${d.opponent.pointsBefore}→${d.opponent.pointsAfter}（Δ${d.opponent.delta}）≡ 公式；cap ${RATING.cap} 处再胜仍 ${atCap.pointsAfter}`);
      return `Δ self=${d.self.delta} foe=${d.opponent.delta}`;
    });

    /* ---- [13/22] 积分守恒 ---- */
    await step(13, '积分守恒：Σrating(前) + ΣΔ = Σrating(后)（对局粒度 + 全局粒度）', async () => {
      const d = state.facts.quick1;
      const sumBefore = d.self.pointsBefore + d.opponent.pointsBefore;
      const sumDelta = d.self.delta + d.opponent.delta;
      const sumAfter = d.self.pointsAfter + d.opponent.pointsAfter;
      expect(sumBefore + sumDelta === sumAfter, `对局粒度守恒式不成立：${sumBefore} + ${sumDelta} ≠ ${sumAfter}`, j({ self: d.self, opponent: d.opponent }));
      let total = 0;
      for (const id of s.store.index.playerIds()) total += s.store.index.get(id).points;
      const before = state.facts.globalPointsBefore;
      expect(Number.isInteger(before), '缺少全局积分基线');
      expect(before + sumDelta === total,
        `全局守恒式不成立：基线 ${before} + ΣΔ ${sumDelta} ≠ 当前总量 ${total}（差额 ${total - before - sumDelta}）`, j({ before, sumDelta, total }));
      const lb = await request(port, 'GET', '/api/v1/leaderboard');
      expect(lb.status === 200, 'leaderboard 应 200', lb.raw);
      const lbSum = lb.body.data.rows.reduce((acc, x) => acc + x.points, 0);
      expect(lbSum === total, `排行榜积分总和 ${lbSum} 应与档案合计 ${total} 一致`, lb.raw);
      okLine(13, '积分守恒（对局 + 全局）', `对局：${d.self.pointsBefore}+${d.opponent.pointsBefore} + (${d.self.delta}${d.opponent.delta >= 0 ? '+' : ''}${d.opponent.delta}) = ${sumAfter} ✔；全局：${before} + ${sumDelta} = ${total} ✔；排行榜合计 ${lbSum} ≡ 档案合计`);
      return `Σ前=${sumBefore} ΣΔ=${sumDelta} Σ后=${sumAfter}`;
    });

    /* ---- [14/22] ranked/run 抽池 + 去重 + shortfall ---- */
    await step(14, 'POST /ranked/run：抽池排除自己 + 24h 去重 + 候选不足 → shortfall（不注入 bot）', async () => {
      // 排位前采集全体积分基线（第 15 步断言"防守方积分不因排位变化"）
      const pointsBeforeRanked = {};
      for (const id of s.store.index.playerIds()) {
        const e = s.store.index.get(id);
        if (e && e.publicId) pointsBeforeRanked[e.publicId] = e.points;
      }
      state.facts.pointsBeforeRanked = pointsBeforeRanked;
      const r = await request(port, 'POST', '/api/v1/ranked/run', { seed: 11 }, authed(state.facts.A.token));
      expect(r.status === 200, `排位应 200，实得 ${r.status}`, r.raw);
      const d = r.body.data;
      expect(d.requested === 10, `批次目标应为 10 场（D-122），实得 ${d.requested}`, r.raw);
      expect(d.matches <= d.requested, `matches ${d.matches} 不得超过 requested ${d.requested}`, r.raw);
      expect(d.shortfall === d.requested - d.matches, `shortfall 应等于缺口：${d.shortfall} ≠ ${d.requested - d.matches}`, r.raw);
      expect(d.wins + d.draws + d.losses + d.invalids === d.matches, '胜负平+invalid 应闭合到 matches', r.raw);
      expect(d.promoted === false, '缺场批次不判晋升（未打满 10 场不结段位）', r.raw);
      expect(!r.raw.includes('pl_'), '排位响应不得回带 playerId（§4.5）', r.raw);
      const foes = d.results.map((m) => m.opponentPublicId);
      expect(new Set(foes).size === foes.length, `同一批次对手不得重复：${foes.join(',')}`, r.raw);
      await assertReal(s.store, foes, 'ranked/run');
      expect(!foes.includes(state.facts.A.publicId), '抽池必须排除自己', r.raw);
      state.facts.ranked1 = d;

      const r2 = await request(port, 'POST', '/api/v1/ranked/run', { seed: 12 }, authed(state.facts.A.token));
      expect(r2.status === 200, `第二轮排位应 200，实得 ${r2.status}`, r2.raw);
      expect(r2.body.data.matches === 0 && r2.body.data.shortfall === 10,
        `24h 去重后应 0 场 / shortfall 10，实得 ${r2.body.data.matches} 场 / shortfall ${r2.body.data.shortfall}（D-136）`, r2.raw);
      state.facts.ranked2 = r2.body.data;
      okLine(14, 'ranked/run 抽池与 shortfall', `第 1 轮：matches=${d.matches} shortfall=${d.shortfall}（对手 ${foes.join(',')} 全部回查档案库 OK，未抽自己）；第 2 轮：matches=${r2.body.data.matches} shortfall=${r2.body.data.shortfall} → 24h 去重生效，**未用 bot 凑满 10 场**（D-152）`);
      return `shortfall=${d.shortfall}`;
    });

    /* ---- [15/22] 发起者同步结算 / 防守方离线记账 ---- */
    await step(15, '发起者同步结算；防守方离线只记战绩、不掉段不掉分（D-132）', async () => {
      const d = state.facts.ranked1;
      const meA = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(meA.body.data.progress.batchesPlayed >= 1, '发起者批次计数应同步落盘', meA.raw);
      expect(meA.body.data.rating.points === 0, `排位不改积分（D-133 双轨），实得 ${meA.body.data.rating.points}`, meA.raw);
      const recA = await request(port, 'GET', '/api/v1/me/records?role=attack', undefined, authed(state.facts.A.token));
      const rankedRecA = recA.body.data.records.filter((x) => x.mode === 'ranked');
      expect(rankedRecA.length === d.matches, `发起者排位战绩应 ${d.matches} 条（同步结算），实得 ${rankedRecA.length}`, recA.raw);
      const foeIds = d.results.map((m) => m.opponentPublicId);
      const defenses = [];
      for (const publicId of foeIds) {
        const token = publicId === state.facts.B.publicId ? state.facts.B.token
          : publicId === state.facts.solo.publicId ? state.facts.solo.token
            : publicId === state.facts.victim.publicId ? state.facts.victim.token : null;
        let defData;
        let tierOfFoe;
        let pointsOfFoe;
        if (token) {
          const def = await request(port, 'GET', '/api/v1/me/defense', undefined, authed(token));
          expect(def.status === 200, `防守战绩应 200，实得 ${def.status}`, def.raw);
          defData = def.body.data;
          const meB = await request(port, 'GET', '/api/v1/me', undefined, authed(token));
          tierOfFoe = meB.body.data.progress.tier;
          pointsOfFoe = meB.body.data.rating.points;
        } else {
          // 其余对手由 CLI 注册（未持有 token）→ 直接读档案层同一视图
          const pid = await playerIdByPublicId(s.store, publicId);
          const ds = await s.store.defenseSummary(pid, { limit: 20 });
          const arch = await s.store.loadArchive(pid);
          defData = ds;
          tierOfFoe = arch.progress.tier;
          pointsOfFoe = arch.rating.points;
        }
        expect(defData.drawnCount >= 1, `被抽场次应 ≥1，实得 ${defData.drawnCount}`, j(defData));
        const s3 = defData.stats;
        expect(s3.wins + s3.losses + s3.draws === defData.drawnCount, '防守胜负平应闭合到 drawnCount', j(defData));
        expect(tierOfFoe === 'common', `防守方不掉段（应仍 common），实得 ${tierOfFoe}`, j(defData));
        pointsOfFoe = pointsOfFoe === undefined ? 0 : pointsOfFoe;
        // 排位不改积分：防守方当前积分必须与**排位批次前**采集的基线一致（第 14 步前采集）
        expect(pointsOfFoe === state.facts.pointsBeforeRanked[publicId],
          `排位不改积分（D-133 双轨）：防守方 ${publicId} 排位前 ${state.facts.pointsBeforeRanked[publicId]} → 排位后 ${pointsOfFoe}`, j(defData));
        defenses.push({ publicId, drawnCount: defData.drawnCount, tier: tierOfFoe, points: pointsOfFoe, pointsBefore: state.facts.pointsBeforeRanked[publicId] });
      }
      okLine(15, '发起者同步结算 / 防守方离线记账', `发起者 batchesPlayed=${meA.body.data.progress.batchesPlayed}、排位战绩 ${rankedRecA.length} 条、积分 ${meA.body.data.rating.points}（排位不改分）；防守方 ${defenses.map((x) => `${x.publicId}:drawn=${x.drawnCount},tier=${x.tier},points=${x.points}`).join(' ')} → 不掉段不掉分`);
      return `防守方 ${defenses.length} 人记账`;
    });

    /* ---- [16/22] 战绩增量 + 未读归零 ---- */
    await step(16, 'GET /me/records?since= 增量游标；unread 计数；markSeen 后 unread=0', async () => {
      const before = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      const unreadBefore = before.body.data.record.unread.attack;
      expect(unreadBefore > 0, `未读进攻战绩应 >0，实得 ${unreadBefore}`, before.raw);

      const all = await request(port, 'GET', '/api/v1/me/records?limit=100', undefined, authed(state.facts.A.token));
      expect(all.status === 200, 'records 应 200', all.raw);
      const list = all.body.data.records;
      expect(list.length > 0, '应有战绩', all.raw);
      expect(new Set(list.map((x) => x.battleId)).size === list.length, '战绩不得重复 battleId（不重）', all.raw);
      const seqs = list.map((x) => x.seq);
      const maxSeq = Math.max(...seqs);
      const inc0 = await request(port, 'GET', `/api/v1/me/records?since=${maxSeq}`, undefined, authed(state.facts.A.token));
      expect(inc0.status === 200 && inc0.body.data.records.length === 0, `since=${maxSeq} 应返回 0 条，实得 ${inc0.body.data && inc0.body.data.records.length}`, inc0.raw);
      const sorted = [...new Set(seqs)].sort((a, b) => a - b);
      const second = sorted.length > 1 ? sorted[sorted.length - 2] : sorted[sorted.length - 1];
      const inc1 = await request(port, 'GET', `/api/v1/me/records?since=${second}`, undefined, authed(state.facts.A.token));
      const got = inc1.body.data.records.map((x) => x.seq);
      expect(got.every((x) => x > second), `增量结果必须严格大于 since=${second}（不漏），实得 ${got.join(',')}`, inc1.raw);
      expect(got.length === 1 && got[0] === maxSeq, `增量应恰为最新 1 条（不重），实得 ${got.join(',')}`, inc1.raw);

      const seen = await request(port, 'POST', '/api/v1/me/records/seen', { uptoSeq: all.body.data.maxSeq }, authed(state.facts.A.token));
      expect(seen.status === 200, `markSeen 应 200，实得 ${seen.status}`, seen.raw);
      expect(seen.body.data.unread.attack === 0, `markSeen 后 unread.attack 应归零，实得 ${seen.body.data.unread.attack}`, seen.raw);
      const after = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(after.body.data.record.unread.attack === 0, 'GET /me 的 unread 也应归零', after.raw);
      const bad = await request(port, 'GET', '/api/v1/me/records?since=-1', undefined, authed(state.facts.A.token));
      expect(bad.status === 400, `since 负数应 400，实得 ${bad.status}`, bad.raw);
      okLine(16, '战绩增量与未读', `共 ${list.length} 条（seq ${sorted.join(',')}）；since=${maxSeq} → 0 条；since=${second} → 恰 [${got.join(',')}]（不漏不重）；unread ${unreadBefore} → markSeen → ${after.body.data.record.unread.attack}（maxSeq=${all.body.data.maxSeq}）；参数负例 since=-1 → 400`);
      return `records=${list.length} unread ${unreadBefore}→0`;
    });

    /* ---- [17/22] /me/defense 汇总 ---- */
    await step(17, 'GET /me/defense 汇总被抽场次 / 胜负 / 未读 / 最近列表', async () => {
      const def = await request(port, 'GET', '/api/v1/me/defense', undefined, authed(state.facts.B.token));
      expect(def.status === 200, `防守战绩应 200，实得 ${def.status}`, def.raw);
      const d = def.body.data;
      expect(d.drawnCount >= 1, `被抽场次应 ≥1，实得 ${d.drawnCount}`, def.raw);
      expect(d.stats && typeof d.stats.wins === 'number' && typeof d.stats.losses === 'number' && typeof d.stats.draws === 'number', '应含胜负平统计', def.raw);
      expect(d.stats.wins + d.stats.losses + d.stats.draws === d.drawnCount, '胜负平应闭合到被抽场次', def.raw);
      expect(Array.isArray(d.recent) && d.recent.length >= 1, '应有最近列表', def.raw);
      expect(typeof d.recent[0].battleId === 'string' && typeof d.recent[0].opponentPublicId === 'string', '最近列表应含 battleId/opponentPublicId', def.raw);
      expect(typeof d.unread === 'number', '应含未读计数', def.raw);
      expect(!def.raw.includes('pl_'), '防守战绩不得回带 playerId', def.raw);
      await assertReal(s.store, [d.recent[0].opponentPublicId], 'me/defense');
      okLine(17, 'GET /me/defense 汇总', `drawnCount=${d.drawnCount} wins=${d.stats.wins} losses=${d.stats.losses} draws=${d.stats.draws} unread=${d.unread}；recent[0]={battleId:${d.recent[0].battleId}, opponent:${d.recent[0].opponentPublicId}}（回查档案库 OK）`);
      return `drawn=${d.drawnCount}`;
    });

    /* ---- [18/22] /leaderboard ---- */
    await step(18, 'GET /leaderboard：与档案一致、points 降序、不暴露 playerId', async () => {
      const lb = await request(port, 'GET', '/api/v1/leaderboard');
      expect(lb.status === 200, `排行榜应 200，实得 ${lb.status}`, lb.raw);
      const rows = lb.body.data.rows;
      expect(Array.isArray(rows) && rows.length >= 3, `榜单至少应有 3 行，实得 ${rows && rows.length}`, lb.raw);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].points <= rows[i - 1].points, `排行榜必须按 points 非升序：第 ${i} 行 ${j(rows[i])} 优于上一行 ${j(rows[i - 1])}`, lb.raw);
      }
      expect(!lb.raw.includes('pl_'), '排行榜不得暴露 playerId（§8.6）', lb.raw);
      for (const row of rows) {
        const pid = await playerIdByPublicId(s.store, row.publicId);
        expect(typeof pid === 'string', `榜单行 ${row.publicId} 无法回查 playerId`, lb.raw);
        const entry = s.store.index.get(pid);
        expect(row.points === entry.points, `榜单积分与档案不一致：${row.publicId} ${row.points} ≠ ${entry.points}`, j(row));
        expect(row.tier === entry.tier, `榜单段位与档案不一致：${row.publicId} ${row.tier} ≠ ${entry.tier}`, j(row));
      }
      okLine(18, 'GET /leaderboard', `rows=${rows.length}：${rows.map((r) => `${r.rank}.${r.publicId}(${r.points})`).join(' ')}；非升序 ✔ 无 pl_ ✔ 逐行与档案一致 ✔`);
      return `rows=${rows.length}`;
    });

    /* ---- [19/22] 回放：403 / 410 ---- */
    await step(19, 'GET /replay/:id：参与者 200；未鉴权 401；非参与者 403 replay_forbidden；过期/淘汰 410 replay_expired', async () => {
      const d = state.facts.quick1;
      const mine = await request(port, 'GET', `/api/v1/replay/${d.battleId}`, undefined, authed(state.facts.B.token));
      expect(mine.status === 200, `参与者取回放应 200，实得 ${mine.status}`, mine.raw);
      expect(mine.body.data.id === d.battleId && Array.isArray(mine.body.data.frames), '回放应含 id 与 frames', mine.raw);
      expect(mine.body.data.frames.length === d.ticks, `重算帧数应等于 ticks（${d.ticks}），实得 ${mine.body.data.frames.length}`, mine.raw);
      const anon = await request(port, 'GET', `/api/v1/replay/${d.battleId}`);
      expect(anon.status === 401, `未鉴权取归档回放应 401，实得 ${anon.status}`, anon.raw);
      const outsider = await request(port, 'GET', `/api/v1/replay/${d.battleId}`, undefined, authed(state.facts.solo.token));
      expect(outsider.status === 403, `非参与者应 403，实得 ${outsider.status}`, outsider.raw);
      expect(outsider.body.error.code === 'replay_forbidden', `非参与者错误码应为 replay_forbidden，实得 ${j(outsider.body.error)}`, outsider.raw);

      const foeId = await playerIdByPublicId(s.store, d.opponent.publicId);
      const mineArch = await s.store.loadArchive(state.facts.B.playerId);
      const mineSlot = mineArch.configs.slots.find((x) => x.slotId === mineArch.configs.activeSlotId);
      const appended = await s.store.settleBattle({
        mode: 'quick', seed: 987654, at: Date.now(),
        p1: {
          playerId: state.facts.B.playerId, publicId: state.facts.B.publicId, role: 'attacker',
          snapshotHash: mineSlot.snapshot.hash, configHash: mineSlot.snapshot.configHash,
          pointsBefore: 0, pointsAfter: 0, result: 'win', tierBefore: 'common', tierAfter: 'common',
        },
        p2: {
          playerId: foeId, publicId: d.opponent.publicId, role: 'defender',
          snapshotHash: `sha256:${'0'.repeat(64)}`, configHash: `sha256:${'0'.repeat(64)}`,
          pointsBefore: 0, pointsAfter: 0, result: 'loss', tierBefore: 'common', tierAfter: 'common',
        },
        verdict: { winner: 'p1', reason: 'hero_dead', ticks: 12 },
        versions: { engine: s.store.versions.engine, data: s.store.versions.data },
      });
      const goneId = appended.record.battleId;
      const gone = await request(port, 'GET', `/api/v1/replay/${goneId}`, undefined, authed(state.facts.B.token));
      expect(gone.status === 410, `快照缺失的归档回放应 410，实得 ${gone.status}`, gone.raw);
      expect(gone.body.error.code === 'replay_expired', `410 错误码应为 replay_expired，实得 ${j(gone.body.error)}`, gone.raw);
      expect(/snapshot_gc|engine_mismatch|data_mismatch/.test(gone.body.error.message), `410 消息应带失效原因，实得 ${gone.body.error.message}`, gone.raw);
      const unknown = await request(port, 'GET', '/api/v1/replay/b_ffffffffffffffff', undefined, authed(state.facts.B.token));
      expect(unknown.status === 404 && unknown.body.error.code === 'unknown_replay', `未知回放应 404 unknown_replay，实得 ${unknown.status} ${j(unknown.body.error)}`, unknown.raw);
      okLine(19, '回放鉴权与失效', `参与者 200（${mine.body.data.frames.length} 帧 = ticks ${d.ticks}）；未鉴权 401；非参与者 403 replay_forbidden；快照缺失归档 ${goneId} → 410 replay_expired（${gone.body.error.message}）；未知 id → 404 unknown_replay`);
      return '200/401/403/410/404';
    });

    /* ---- [20/22] /ranked/promote ---- */
    await step(20, 'POST /ranked/promote：读档案段位 + 403 段位不一致 + 不越权落盘', async () => {
      const ok = await request(port, 'POST', '/api/v1/ranked/promote', { wins: 7 }, authed(state.facts.A.token));
      expect(ok.status === 200, `promote 应 200，实得 ${ok.status}`, ok.raw);
      expect(ok.body.data.tier === 'rare' && ok.body.data.promoted === true, `common + wins>6 → rare，实得 ${j(ok.body.data)}`, ok.raw);
      expect(ok.body.data.reward === 'rare', '应回带段位奖励品质', ok.raw);
      const mismatch = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'mythic', wins: 7 }, authed(state.facts.A.token));
      expect(mismatch.status === 403 && mismatch.body.error.code === 'forbidden', `伪造段位应 403 forbidden，实得 ${mismatch.status} ${j(mismatch.body.error)}`, mismatch.raw);
      const me = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(me.body.data.progress.tier === 'common', '兼容端点只做判定（晋升权威在 /ranked/run），不得"不打就升段"', me.raw);
      const badWins = await request(port, 'POST', '/api/v1/ranked/promote', { wins: 'x' }, authed(state.facts.A.token));
      expect(badWins.status === 400 && badWins.body.error.code === 'bad_wins', `非法 wins 应 400 bad_wins，实得 ${badWins.status} ${j(badWins.body.error)}`, badWins.raw);
      okLine(20, 'ranked/promote', `wins=7 → promoted=true tier=rare reward=rare（仅判定，不写档案）；入参 tier=mythic 与档案不符 → 403 forbidden；wins='x' → 400 bad_wins；档案段位仍 ${me.body.data.progress.tier}`);
      return 'promote 判定 + 403 + 400';
    });

    /* ---- [21/22] DL_LEGACY_STATELESS 兼容口径 ---- */
    await step(21, 'DL_LEGACY_STATELESS：=1（默认）旧无状态端点零回归；=0 → 410 deprecated', async () => {
      // 先把 A 的出战配置恢复为正常 hp（第 11 步的剧本配置只服务于 Elo 场景）
      const restore = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: scriptedLoadout(state.facts.asmA.warehouse, false), warehouse: state.facts.asmA.warehouse }, authed(state.facts.A.token));
      expect(restore.status === 200, `恢复 A 配置应 200，实得 ${restore.status}`, restore.raw);
      state.facts.ldA = scriptedLoadout(state.facts.asmA.warehouse, false);
      const box = await request(port, 'POST', '/api/v1/box', { seed: 1, tier: MODE, times: 1 });
      expect(box.status === 200, `legacy box 应 200，实得 ${box.status}`, box.raw);
      const wh = await request(port, 'GET', '/api/v1/warehouse');
      expect(wh.status === 200, `legacy warehouse 应 200，实得 ${wh.status}`, wh.raw);
      const lo = await request(port, 'POST', '/api/v1/loadout', { loadout: state.facts.ldA, tier: MODE });
      expect(lo.status === 200, `legacy loadout 应 200，实得 ${lo.status}`, lo.raw);
      const bat = await request(port, 'POST', '/api/v1/battle', { p1: state.facts.ldA, p2: state.facts.ldA, seed: 5, tier: MODE });
      expect(bat.status === 200, `legacy battle 应 200，实得 ${bat.status}`, bat.raw);
      expect(/^r\d+$/.test(bat.body.data.id), '遗留回放 id 应为 r<seq>', bat.raw);
      const legacyReplay = await request(port, 'GET', `/api/v1/replay/${bat.body.data.id}`);
      expect(legacyReplay.status === 200, `遗留回放（无 token）应 200，实得 ${legacyReplay.status}`, legacyReplay.raw);

      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-p7-5-e2e-off-'));
      let s2 = null;
      try {
        s2 = await serverMod.start({
          port: 0, dataDir: dir2, authConfig: FAST_AUTH, rateLimitPerMinute: RATE_LIMIT,
          env: { DL_DATA_DIR: dir2, DL_LEGACY_STATELESS: '0' },
        });
        const off = await request(s2.port, 'POST', '/api/v1/box', { seed: 1 });
        expect(off.status === 410 && off.body.error.code === 'deprecated', `STATELESS=0 时旧端点应 410 deprecated，实得 ${off.status} ${j(off.body.error)}`, off.raw);
        const health2 = await request(s2.port, 'GET', '/api/v1/health');
        expect(health2.status === 200, '基础设施端点应保持可用', health2.raw);
      } finally {
        if (s2) await s2.close();
        fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
      okLine(21, 'DL_LEGACY_STATELESS 兼容口径', `=1（默认）：box/warehouse/loadout/battle/replay(r…) 全 200 零回归；=0（另起实例）：旧端点 410 deprecated、health 仍 200`);
      return 'legacy 零回归 + 410 deprecated';
    });

    /* ---- [22/22] 真实玩家快速对战 + CLI 闭环 ---- */
    await step(22, 'POST /quick/run（真实玩家对手）Elo 可复算；CLI auth/me/quick/leaderboard + 退出码 3 = 未鉴权', async () => {
      const r = await request(port, 'POST', '/api/v1/quick/run', { seed: 777001 }, authed(state.facts.A.token));
      expect(r.status === 200, `A 的快速对战应 200（A 与 B 本轮尚未交手），实得 ${r.status}`, r.raw);
      const d = r.body.data;
      await assertReal(s.store, [state.facts.A.publicId, d.opponent.publicId], 'quick/run#2');
      const selfCalc = quickmatch.ratingDelta({
        points: d.self.pointsBefore, opponentPoints: d.opponent.pointsBefore,
        result: d.winner === 'win' ? 'win' : d.winner === 'loss' ? 'loss' : 'draw', config: RATING,
      });
      const foeCalc = quickmatch.ratingDelta({
        points: d.opponent.pointsBefore, opponentPoints: d.self.pointsBefore,
        result: d.winner === 'win' ? 'loss' : d.winner === 'loss' ? 'win' : 'draw', config: RATING,
      });
      expect(d.self.pointsAfter === selfCalc.pointsAfter, `A 积分可复算：${d.self.pointsAfter} ≠ ${selfCalc.pointsAfter}`, j(d.self));
      expect(d.opponent.pointsAfter === foeCalc.pointsAfter, `对手积分可复算：${d.opponent.pointsAfter} ≠ ${foeCalc.pointsAfter}`, j(d.opponent));
      expect(d.self.pointsAfter >= 0 && d.self.pointsAfter <= RATING.cap, `A 积分越界 ${d.self.pointsAfter}`, j(d.self));
      expect(d.opponent.pointsAfter >= 0 && d.opponent.pointsAfter <= RATING.cap, `对手积分越界 ${d.opponent.pointsAfter}`, j(d.opponent));
      const foeToken = d.opponent.publicId === state.facts.B.publicId ? state.facts.B.token
        : d.opponent.publicId === state.facts.solo.publicId ? state.facts.solo.token : state.facts.victim.token;
      const foeMe = await request(port, 'GET', '/api/v1/me', undefined, authed(foeToken));
      expect(foeMe.status === 200, '对手档案可读', foeMe.raw);
      expect(foeMe.body.data.rating.points === d.opponent.pointsAfter,
        `对手积分应已落盘（双向结算）：档案 ${foeMe.body.data.rating.points} ≠ 响应 ${d.opponent.pointsAfter}`, foeMe.raw);

      // CLI：清空 A 的对手冷却（等价 24h 已过）以让 quick 这条子命令确定性成功
      await clearOpponentHistory(s.store, state.facts.A.playerId);
      const runCli = async (argv) => {
        const logs = [];
        const errs = [];
        const origLog = console.log;
        const origErr = console.error;
        console.log = (...a) => logs.push(a.map((x) => (typeof x === 'string' ? x : j(x))).join(' '));
        console.error = (...a) => errs.push(a.map((x) => (typeof x === 'string' ? x : j(x))).join(' '));
        try {
          const code = await cliMain.main(argv, { baseUrl: base });
          return { code, text: logs.join('\n'), err: errs.join('\n') };
        } finally {
          console.log = origLog;
          console.error = origErr;
        }
      };
      const health = await runCli(['health']);
      expect(health.code === 0, `cli health 应退出码 0，实得 ${health.code}`, `${health.text}\n${health.err}`);
      const unauth = await runCli(['me']);
      expect(unauth.code === 3, `cli me 未鉴权应退出码 3（§10.4），实得 ${unauth.code}`, `${unauth.text}\n${unauth.err}`);
      const reg = await runCli(['auth', 'register', '--user', 'e2e_cli_5', '--pass', PASSWORD]);
      expect(reg.code === 0, `cli auth register 应退出码 0，实得 ${reg.code}`, `${reg.text}\n${reg.err}`);
      const login = await runCli(['auth', 'login', '--user', state.facts.A.username, '--pass', PASSWORD]);
      expect(login.code === 0, `cli auth login 应退出码 0，实得 ${login.code}`, `${login.text}\n${login.err}`);
      const me = await runCli(['me', '--token', state.facts.A.token]);
      expect(me.code === 0, `cli me 应退出码 0，实得 ${me.code}`, `${me.text}\n${me.err}`);
      expect(me.text.includes(state.facts.A.publicId), 'cli me 输出应含自己的 publicId', me.text);
      const lb = await runCli(['leaderboard', '--limit', '5']);
      expect(lb.code === 0, `cli leaderboard 应退出码 0，实得 ${lb.code}`, `${lb.text}\n${lb.err}`);
      expect(lb.text.includes(state.facts.A.publicId), 'cli leaderboard 输出应含榜单行', lb.text);
      const quick = await runCli(['quick', 'run', '--token', state.facts.A.token, '--seed', '31415']);
      expect(quick.code === 0, `cli quick 应退出码 0（已清冷却，池中有真实对手），实得 ${quick.code}`, `${quick.text}\n${quick.err}`);
      const cliData = JSON.parse(quick.text);
      await assertReal(s.store, [state.facts.A.publicId, cliData.opponent.publicId], 'cli quick');
      expect(cliData.opponent.isBot === false, 'CLI 快速对战的对手不得是 bot', quick.text);
      okLine(22, 'quick/run（真实对手）+ CLI 闭环', `A ${d.self.pointsBefore}→${d.self.pointsAfter}（Δ${d.self.delta}）vs ${d.opponent.publicId} ${d.opponent.pointsBefore}→${d.opponent.pointsAfter}（Δ${d.opponent.delta}）双方 Δ ≡ 公式、cap 未越界、对手档案已落盘；CLI：health→0，me 无 token→**3**，auth register→0，auth login→0，me→0，leaderboard→0，quick run→0（对手 ${cliData.opponent.publicId} 回查档案库 OK）`);
      return `Δ ${d.self.delta}/${d.opponent.delta}；CLI 0/3`;
    });

    /* ---------- 结果行 + 无 bot 证据 ---------- */
    const ms = Date.now() - t0;
    const passed = state.steps.filter((x) => x.ok).length;
    out('');
    out(`=== 结果：22/22 检查点通过（${passed} 步，用时 ${ms} ms）  退出码 0 ===`);
    out(`无 bot 证据（对局涉及的每个 publicId 均可从档案库追溯到 playerId + 出战快照）：`);
    const seen = new Set();
    for (const p of noBotLog) {
      if (seen.has(p.playerId)) continue;
      seen.add(p.playerId);
      out(`  · [${p.where}] ${p.publicId} → playerId=${p.playerId} nickname=${p.nickname} tier=${p.tier} points=${p.points} isBot=${p.isBot} snapshot=${short(p.snapshotHash, 26)}`);
    }
    out(`  · 结算对局：quick ${2} 场 + ranked ${state.facts.ranked1.matches} 场；双方 playerId 全部落在上述真实档案内（0 个 bot）`);
    out('');
    out('（已知后端缺陷 D1，只报告未修）第 6 步的出战配置剥离了装配引用：装配后的配置一旦激活，');
    out('   /ranked/run 与 /quick/run 会以 missing_warehouse 失败（快照库不保存仓库镜像 → buildPlayer(warehouse=null)）。');
    out(`摘要行：e2e PASS 检查点=22/22 步=${passed} 用时=${ms}ms 端口=${port} 数据根=${path.basename(dataDir)}`);
    return 0;
  } finally {
    if (s) await s.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    out('');
    out('=== 结果：e2e 失败 → 非零退出（退出码 1）===');
    if (e && e.stack) out(String(e.stack).split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
  });
}

module.exports = { main };
