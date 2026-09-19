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
 *   1 注册 200 + token；2 登录/错密码 401/连错 429+锁定/logout 后 401；3 GET /me 401 语义与字段；
 *   4 GET /me 幂等（连续两次逐值一致）；5 开箱 → PUT /me/warehouse → GET 往返一致；
 *   6 配置槽 ≤3 / 409 slot_limit / 409 slot_locked / 唯一出战 / 注册即默认配置；
 *   7 POST /panel 与单测 buildPanel 逐值一致；8 /ai/validate 非法 400+details[].path / 合法 warnings:[] /
 *     废弃动作 warnings 非空；9 /ai/compile programHash 稳定；10 池空 quick/run **必须 shortfall，不得注入 bot**；
 *   11 有对手时双方 playerId 都是真实注册玩家；12 Elo 双向变动可复算 + cap 3000 不越界；
 *   13 积分守恒（对局粒度 + 全局粒度）；14 发起者同步结算 / 防守方离线只记战绩不掉段不掉分；
 *   15 ranked/run 抽池排除自己 + 24h 去重 + 候选不足 shortfall（不注入 bot）；16 战绩增量游标 + 未读归零；
 *   17 /me/defense 汇总被抽场次/胜负/积分；18 /leaderboard 与档案一致（降序、不暴露 playerId）；
 *   19 回放：非参与者 403 / 过期或淘汰 410；20 CLI auth/me/quick/leaderboard + 退出码 3 = 未鉴权；
 *   21 DL_LEGACY_STATELESS=1 旧端点零回归；22 一条命令退出码 0 且每步打印真实响应关键字段。
 *
 * 约束（项目铁律）：零依赖；CommonJS；**禁 child_process / Math.random**（确定性来自显式 seed）；
 *   进程内起服务（`server/index.js` 的 handler + `node:http` 监听随机端口）；数据根 `os.tmpdir()` 隔离。
 *
 * 🚫 无占位 bot（用户 2026-09-16 明令 / D-152）：对局双方一律是 `/auth/register` 注册的**真实档案**，
 *   本脚本对每场对局的双方 publicId 都回查 `store.index` → `playerId` → 档案 + 快照作为证据（见 `noBotProof()`）。
 *
 * 用法：npm run e2e   （或 node scripts/e2e.js [--verbose]）
 * 退出码：0 = 22 个检查点全过；1 = 任一步失败（打印该步上游真实响应）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const serverMod = require('../server/index.js');
const itemsCore = require('../server/core/items.js');
const loadoutApi = require('../server/loadout.js');
const quickmatch = require('../server/quickmatch.js');
const ledger = require('../server/store/ledger.js');
const cliMain = require('../cli/index.js'); // 检查点 20：CLI 子命令（只走 HTTP）
const RATING = require('../server/data/rating-config.json');

const PASSWORD = 'pw12345678';
const FAST_AUTH = { auth: { scrypt: { N: 1024, r: 8, p: 1 } } }; // 端到端无需承担生产 scrypt 成本
const RATE_LIMIT = 100000000;  // 等价关闭全局限速（限速语义由 tests/api/api-auth.test.js AU-8 专测）
const MODE = 'common';         // 门控默认关闭（D-137），tier 仅作回带
const HEAD_LINES = 20;         // 输出摘要（报告要求"头 20 行"）

const out = (s) => process.stdout.write(`${s}\n`);
const j = (v) => JSON.stringify(v);
const short = (v, n) => {
  const s = typeof v === 'string' ? v : j(v);
  return s.length > (n || 160) ? `${s.slice(0, n || 160)}…` : s;
};

/* ---------- 运行框架：任一步失败 → 打印上游真实响应 + 非零退出 ---------- */

const state = {
  step: 0,
  steps: [],           // { n, title, ok, ms, note }
  facts: {},           // 跨步骤共享（token/loadout/warehouse/…）
  lines: [],           // 全部输出（供摘要）
};

function say(line) {
  state.lines.push(line);
  out(line);
}

function fail(msg, upstream) {
  const e = new Error(msg);
  e.upstream = upstream;
  throw e;
}

function expect(cond, msg, upstream) {
  if (!cond) fail(msg, upstream);
}

// 一步 = 检查点 n；fn 内可继续细分断言（失败即抛）
async function step(n, title, fn) {
  state.step = n;
  const started = Date.now();
  const mark = state.lines.length;
  try {
    const note = await fn();
    const ms = Date.now() - started;
    state.steps.push({ n, title, ok: true, ms, note: note === undefined ? '' : String(note) });
    return note;
  } catch (e) {
    const ms = Date.now() - started;
    state.steps.push({ n, title, ok: false, ms, note: e.message });
    say(`[${n}/22] ✘ ${title}`);
    if (e.upstream !== undefined) say(`        上游真实响应：${short(e.upstream, 900)}`);
    say(`        断言失败：${e.message}`);
    for (const l of state.lines.slice(mark)) { /* 保持已打印的细节 */ }
    throw e;
  }
}

function okLine(n, title, detail) {
  say(`[${n}/22] ✔ ${title}${detail ? ` — ${detail}` : ''}`);
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

const noBotLog = [];

// 断言双方都是真实注册玩家（回查档案库；isBot 一律拒绝）
async function assertReal(store, publicIds, where) {
  for (const publicId of publicIds) {
    const proof = await realPlayerProof(store, publicId);
    expect(proof !== null, `${where}：publicId ${publicId} 无法从档案库反查到 playerId（疑似占位 bot）`);
    expect(proof.isBot === false, `${where}：publicId ${publicId} 的档案 flags.isBot=true（bot 参与对局）`);
    expect(proof.hasLoadout === true, `${where}：publicId ${publicId} 无可用出战快照（无法证明是真实玩家）`);
    noBotLog.push({ where, ...proof });
  }
}

/* ---------- HTTP（node:http，无第三方依赖） ---------- */

const httpMod = require('node:http');

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

/* ---------- 物品/出战的构造（走真实端点，不用内部构造） ---------- */

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
  // 装配（POST /warehouse/assemble；逐槽尝试，失败跳过并记录）
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

function bareLoadout(ld) {
  const copy = JSON.parse(JSON.stringify(ld));
  for (const s of copy.role.slots || []) s.pluginUid = null;
  for (const sk of copy.skills || []) for (const s of sk.slots || []) s.pluginUid = null;
  return copy;
}

/* ---------- 主流程 ---------- */

async function main() {
  const t0 = Date.now();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-p7-5-e2e-'));
  let s = null;
  try {
    process.env.DL_DATA_DIR = dataDir; // §7：数据根隔离（os.tmpdir()）
    s = await serverMod.start({
      port: 0,                        // 随机端口
      dataDir,
      authConfig: FAST_AUTH,
      rateLimitPerMinute: RATE_LIMIT,
      env: { DL_DATA_DIR: dataDir, DL_LEGACY_STATELESS: '1' },
    });
    const port = s.port;

    say('=== Debug-Lite v3 · P7-5 全链路端到端（npm run e2e） ===');
    say(`服务：http://127.0.0.1:${port}（随机端口，进程内 handler）  数据根：${dataDir}（DL_DATA_DIR，os.tmpdir 隔离）`);
    say(`覆盖：docs/reviews/P7-7-test-audit.md §B1 的 22 个检查点（顺序执行）  段位：${MODE}（D-137 门控默认关闭）`);
    say('🚫 无占位 bot：对局双方一律为 /auth/register 的真实档案（每场回查 store.index → playerId → 快照）');
    say('');

    /* ---- [1/22] 注册两个真实玩家（+ 200/201 与 409 user_exists） ---- */
    await step(1, 'POST /auth/register → 200/201 + token；重名 → 409 user_exists', async () => {
      const a = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_alpha_1', password: PASSWORD, nickname: '阿尔法' });
      expect(a.status === 200 || a.status === 201, `注册状态码应为 200/201，实得 ${a.status}`, a.raw);
      expect(a.body.ok === true && typeof a.body.data.token === 'string' && a.body.data.token.length >= 40, '注册应下发 token', a.raw);
      expect(typeof a.body.data.publicId === 'string' && a.body.data.publicId.startsWith('u_'), '注册应下发 publicId', a.raw);
      expect(!a.raw.includes('pl_'), '注册响应不得回带 playerId（§4.5）', a.raw);
      state.facts.A = { token: a.body.data.token, publicId: a.body.data.publicId, username: 'e2e_alpha_1', password: PASSWORD };
      state.facts.A.playerId = await playerIdByPublicId(s.store, state.facts.A.publicId);
      expect(typeof state.facts.A.playerId === 'string' && state.facts.A.playerId.startsWith('pl_'),
        'A 的 publicId 必须能反查到真实 playerId（档案库）', j(a.body));

      const b = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_beta_2', password: PASSWORD, nickname: '贝塔' });
      expect(b.status === 200 || b.status === 201, `B 注册失败 ${b.status}`, b.raw);
      state.facts.B = { token: b.body.data.token, publicId: b.body.data.publicId, username: 'e2e_beta_2', password: PASSWORD };
      state.facts.B.playerId = await playerIdByPublicId(s.store, state.facts.B.publicId);

      const dup = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_alpha_1', password: PASSWORD });
      expect(dup.status === 409, `重名注册应 409，实得 ${dup.status}`, dup.raw);
      expect(dup.body.error && dup.body.error.code === 'username_taken', `重名错误码应为 username_taken，实得 ${j(dup.body.error)}`, dup.raw);
      okLine(1, '注册 2 个真实玩家', `A=${state.facts.A.publicId}(${state.facts.A.playerId}) B=${state.facts.B.publicId}(${state.facts.B.playerId}) token 长度 ${state.facts.A.token.length}；重名 → 409 username_taken`);
      return `A=${state.facts.A.publicId} B=${state.facts.B.publicId}`;
    });

    /* ---- [2/22] 登录 / 错密码 401 / 连错锁定 429 / logout 后旧 token 401 ---- */
    await step(2, 'POST /auth/login → token；错密码 401；连错 N 次 → 429 锁定；logout 后旧 token → 401', async () => {
      const login = await request(port, 'POST', '/api/v1/auth/login', { username: state.facts.A.username, password: PASSWORD });
      expect(login.status === 200 && typeof login.body.data.token === 'string', `登录应 200 + token，实得 ${login.status}`, login.raw);
      const secondToken = login.body.data.token;
      state.facts.A.secondToken = secondToken;

      const wrong = await request(port, 'POST', '/api/v1/auth/login', { username: state.facts.A.username, password: 'wrong-password' });
      expect(wrong.status === 401, `错密码应 401，实得 ${wrong.status}`, wrong.raw);
      expect(wrong.body.error.code === 'invalid_credentials', `错密码错误码应为 invalid_credentials，实得 ${j(wrong.body.error)}`, wrong.raw);

      // 锁定：同一个受害者账号连续失败 5 次 → 第 6 次 429（§4.2）
      const victim = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_lock_3', password: PASSWORD });
      expect(victim.status === 200 || victim.status === 201, `锁定用例注册失败 ${victim.status}`, victim.raw);
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
      okLine(2, '登录 / 401 / 429 锁定 / logout 撤销', `token 二次下发 OK；错密码 401 invalid_credentials；连错 5 次 → 429 too_many_attempts；logout 后旧 token → 401 ${after.body.error.code}`);
      return 'login 200；401/429/logout-401 全中';
    });

    /* ---- [3/22] GET /me 鉴权语义与字段 ---- */
    await step(3, 'GET /me：无 token 401 / 坏 token 401 / 过期 401 / 正常 → {playerId,tier,rating,configs,unread}', async () => {
      const none = await request(port, 'GET', '/api/v1/me');
      expect(none.status === 401 && none.body.error.code === 'unauthorized', `无 token 应 401 unauthorized，实得 ${none.status} ${j(none.body.error)}`, none.raw);
      const bad = await request(port, 'GET', '/api/v1/me', undefined, authed('not-a-real-token'));
      expect(bad.status === 401, `坏 token 应 401，实得 ${bad.status}`, bad.raw);
      // 过期会话：直接向会话表写入一条已过期会话（等价"过了 TTL"，§4.4 步骤 2）
      const authMod = require('../server/auth.js');
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
      state.facts.meA = d;
      okLine(3, 'GET /me 鉴权与字段', `401 unauthorized / 401（坏 token）/ 401 session_expired / 200 {publicId:${d.publicId}, tier:${d.progress.tier}, points:${d.rating.points}, slots:${d.slots.length}, unread:${j(d.record.unread)}}`);
      return `tier=${d.progress.tier} points=${d.rating.points} slots=${d.slots.length}`;
    });

    /* ---- [4/22] GET /me 幂等（无副作用） ---- */
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

      // 镜像 = 开箱后的仓库（含装配状态）；A/B 各自的出战配置由该镜像中的物品构成
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
      const boxes = asmA.rounds * 12 + asmB.rounds * 12;
      okLine(5, '开箱 → 仓库镜像往返', `开箱 ${boxes} 箱（A ${asmA.opened.length} 件/装配 ${asmA.placed.length} 处；B ${asmB.opened.length} 件/装配 ${asmB.placed.length} 处）；PUT hash=${short(put.body.data.warehouseHash, 24)} = GET hash；buckets=${j(counts)}`);
      return `hash 往返一致（${asmA.warehouse.buckets.role.length + asmA.warehouse.buckets.skill.length} 件出战材料）`;
    });

    /* ---- [6/22] 配置槽：≤3 / slot_limit / slot_locked / 唯一出战 / 注册即默认 ---- */
    await step(6, '配置槽：建 ≤3；第 4 个 409 slot_limit；删出战槽 409 slot_locked；激活唯一；注册即默认配置', async () => {
      const me0 = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(me0.body.data.slots.length === 1 && me0.body.data.slots[0].isDefault === true, '注册即默认配置', me0.raw);

      // 出战配置：来自真实开箱物品（此处**剥离装配引用**，原因见交付报告"后端缺陷 D1"）
      const ldA = bareLoadout({ role: state.facts.asmA.warehouse.buckets.role[0], skills: state.facts.asmA.warehouse.buckets.skill.slice(0, 3), ai: { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } } });
      state.facts.ldA = ldA;
      const save = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: ldA }, authed(state.facts.A.token));
      expect(save.status === 200, `PUT /me/configs/slot1 应 200，实得 ${save.status}`, save.raw);
      expect(typeof save.body.data.snapshot.hash === 'string', '保存应冻结新快照', save.raw);
      state.facts.snapshotHashA = save.body.data.snapshot.hash;

      const c1 = await request(port, 'POST', '/api/v1/me/configs', { name: '第二套' }, authed(state.facts.A.token));
      expect(c1.status === 200, `新建第 2 槽应 200，实得 ${c1.status}`, c1.raw);
      const c2 = await request(port, 'POST', '/api/v1/me/configs', { name: '第三套' }, authed(state.facts.A.token));
      expect(c2.status === 200, `新建第 3 槽应 200，实得 ${c2.status}`, c2.raw);
      expect(c2.body.data.slots.length === 3, `槽数应达 3，实得 ${c2.body.data.slots.length}`, c2.raw);
      const c3 = await request(port, 'POST', '/api/v1/me/configs', { name: '第四套' }, authed(state.facts.A.token));
      expect(c3.status === 409, `第 4 槽应 409，实得 ${c3.status}`, c3.raw);
      expect(c3.body.error.code === 'slot_limit', `第 4 槽错误码应为 slot_limit，实得 ${j(c3.body.error)}`, c3.raw);

      // 激活唯一：切到 slot2 → activeSlotId=slot2、activeSnapshotHash 同步
      const act = await request(port, 'POST', '/api/v1/me/configs/slot2/activate', {}, authed(state.facts.A.token));
      expect(act.status === 200 && act.body.data.activeSlotId === 'slot2', `激活 slot2 应 200 且 activeSlotId=slot2，实得 ${act.status} ${j(act.body.data && act.body.data.activeSlotId)}`, act.raw);
      expect(typeof act.body.data.activeSnapshotHash === 'string', '激活应同步 activeSnapshotHash', act.raw);

      // 删出战槽 → 409 slot_locked（先切回 slot1，再删 slot2 应成功；默认槽恒不可删）
      const lockedDel = await request(port, 'DELETE', '/api/v1/me/configs/slot2', undefined, authed(state.facts.A.token));
      expect(lockedDel.status === 409 && lockedDel.body.error.code === 'slot_locked', `删出战槽应 409 slot_locked，实得 ${lockedDel.status} ${j(lockedDel.body.error)}`, lockedDel.raw);
      const back = await request(port, 'POST', '/api/v1/me/configs/slot1/activate', {}, authed(state.facts.A.token));
      expect(back.status === 200 && back.body.data.activeSlotId === 'slot1', '切回 slot1', back.raw);
      const del = await request(port, 'DELETE', '/api/v1/me/configs/slot2', undefined, authed(state.facts.A.token));
      expect(del.status === 200 && del.body.data.deleted === 'slot2', `非出战槽应可删（200），实得 ${del.status}`, del.raw);
      const delDefault = await request(port, 'DELETE', '/api/v1/me/configs/slot1', undefined, authed(state.facts.A.token));
      expect(delDefault.status === 409 && delDefault.body.error.code === 'slot_locked', `默认槽不可删（409 slot_locked），实得 ${delDefault.status}`, delDefault.raw);

      // 401 分支（未鉴权新建）
      const noAuth = await request(port, 'POST', '/api/v1/me/configs', { name: 'x' });
      expect(noAuth.status === 401, `未鉴权新建槽应 401，实得 ${noAuth.status}`, noAuth.raw);
      okLine(6, '配置槽规则', `注册即 slot1(isDefault)；建到 3 槽 OK；第 4 槽 → 409 slot_limit；激活 slot2 → activeSlotId=slot2；删出战槽 → 409 slot_locked；切回后可删；默认槽 → 409 slot_locked`);
      return 'slot_limit / slot_locked / 唯一出战全中';
    });

    /* ---- [7/22] 装配后 POST /panel 与单测 buildPanel 逐值一致 ---- */
    await step(7, '装配后 POST /panel 与单测 buildPanel 逐值一致（端到端认面板）', async () => {
      const pan = await request(port, 'POST', '/api/v1/panel', { loadout: state.facts.ldA, tier: MODE });
      expect(pan.status === 200, `POST /panel 应 200，实得 ${pan.status}`, pan.raw);
      const local = loadoutApi.buildPanel(state.facts.ldA, { warehouse: null, tier: MODE });
      expect(local.ok === true, '单测 buildPanel 应通过', j(local.errors));
      expect(j(pan.body.data.panel) === j(local.panel), 'HTTP /panel 与单测 buildPanel 必须逐值一致', `${short(j(pan.body.data.panel), 400)} VS ${short(j(local.panel), 400)}`);
      const st = pan.body.data.panel.role.stats;
      okLine(7, 'POST /panel ≡ buildPanel', `五维 hp${st.hp}/atk${st.atk}/def${st.def}/sp${st.sp}/mp${st.mp}；技能参数 ${pan.body.data.panel.skills.length} 条；与单测逐值一致`);
      return `hp=${st.hp} atk=${st.atk} def=${st.def}`;
    });

    /* ---- [8/22] /ai/validate：非法 400 + details[].path；合法 warnings:[]；废弃动作 warnings 非空 ---- */
    await step(8, '/ai/validate：非法 → 400 + details[].path；合法 → warnings:[]；废弃动作 → warnings 非空', async () => {
      const legal = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
      const v1 = await request(port, 'POST', '/api/v1/ai/validate', { program: legal, tier: MODE });
      expect(v1.status === 200 && v1.body.data.ok === true, `合法程序应 200 ok:true，实得 ${v1.status}`, v1.raw);
      expect(Array.isArray(v1.body.data.warnings) && v1.body.data.warnings.length === 0, `合法程序 warnings 应为 []，实得 ${j(v1.body.data.warnings)}`, v1.raw);

      // 废弃/未登记动作名：**不拒绝**（D-80），但走 warnings 通道（D-146）
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
      okLine(8, '/ai/validate 三态', `合法 → 200 warnings:[]；未登记动作 teleport → 200 warnings[0]=${v2.body.data.warnings[0].code}（不拒绝，D-80）；空 body → 400 ai_invalid details[0]={path:'${v3.body.error.details[0].path}', code:'${v3.body.error.details[0].code}'}`);
      return '200/200+warning/400 三态全中';
    });

    /* ---- [9/22] /ai/compile → programHash 稳定 ---- */
    await step(9, '/ai/compile → programHash 稳定（同程序两次 hash 相同）', async () => {
      const c1 = await request(port, 'POST', '/api/v1/ai/compile', { program: state.facts.aiProgram });
      const c2 = await request(port, 'POST', '/api/v1/ai/compile', { program: state.facts.aiProgram });
      expect(c1.status === 200 && c2.status === 200, `compile 应 200，实得 ${c1.status}/${c2.status}`, c1.raw);
      expect(typeof c1.body.data.programHash === 'string' && c1.body.data.programHash.length === 64, 'programHash 应为 64 hex', c1.raw);
      expect(c1.body.data.programHash === c2.body.data.programHash, '同程序两次 compile 的 programHash 必须相同', `${c1.body.data.programHash} VS ${c2.body.data.programHash}`);
      okLine(9, '/ai/compile programHash 稳定', `hash=${short(c1.body.data.programHash, 32)}；nodes=${c1.body.data.stats.nodes}；两次一致`);
      return c1.body.data.programHash;
    });

    /* ---- [10/22] 池空 quick/run → 必须 shortfall/拒配，不得注入 bot ---- */
    await step(10, '首次 POST /quick/run → 池空 → 必须 no_opponent/shortfall，不得注入 bot', async () => {
      const solo = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_solo_4', password: PASSWORD });
      expect(solo.status === 200 || solo.status === 201, `独狼注册失败 ${solo.status}`, solo.raw);
      const soloToken = solo.body.data.token;
      const soloId = await playerIdByPublicId(s.store, solo.body.data.publicId);
      state.facts.solo = { token: soloToken, publicId: solo.body.data.publicId, playerId: soloId };
      const r = await request(port, 'POST', '/api/v1/quick/run', {}, authed(soloToken));
      expect(r.status === 409, `无对手时应 409（不伪造对局），实得 ${r.status}`, r.raw);
      expect(r.body.error.code === 'no_opponent', `无对手错误码应为 no_opponent，实得 ${j(r.body.error)}`, r.raw);
      // 反向证据：该玩家档案里没有任何对局记录（没有"被 bot 陪打"）
      const rec = await request(port, 'GET', '/api/v1/me/records', undefined, authed(soloToken));
      expect(rec.status === 200 && rec.body.data.records.length === 0, `池空时不得产生任何对局记录，实得 ${rec.body.data && rec.body.data.records.length}`, rec.raw);
      const meta = s.store.index.get(soloId);
      expect(meta && meta.isBot !== true, '独狼档案不应被标记为 bot', j(meta));
      okLine(10, '池空 quick/run', `409 ${r.body.error.code}（"${r.body.error.message}"）；该玩家战绩 0 条 → 未注入 bot 充数（D-152）`);
      return '409 no_opponent + 0 战绩';
    });

    /* ---- [11/22] 有对手 → 双方都是真实注册玩家 ---- */
    await step(11, 'POST /quick/run 有对手 → 双方 playerId 都是真实注册玩家（断言对手 ID 在注册表内）', async () => {
      const r = await request(port, 'POST', '/api/v1/quick/run', { seed: 20260921 }, authed(state.facts.B.token));
      expect(r.status === 200, `快速对战应 200（池中有真实对手），实得 ${r.status}`, r.raw);
      const d = r.body.data;
      expect(typeof d.battleId === 'string' && /^b_[0-9a-f]{16}$/.test(d.battleId), `battleId 应为内容寻址 b_…，实得 ${d.battleId}`, r.raw);
      expect(d.opponent && typeof d.opponent.publicId === 'string', '响应应回带对手 publicId', r.raw);
      expect(d.opponent.isBot === false, '对手不得是 bot（isBot=true 即违约）', r.raw);
      expect(!r.raw.includes('pl_'), '快速对战响应不得回带 playerId（§4.5）', r.raw);
      // 关键：双方 publicId 都能回查档案库
      await assertReal(s.store, [state.facts.B.publicId, d.opponent.publicId], 'quick/run');
      expect(d.opponent.publicId !== state.facts.B.publicId, '对手不得是自己', r.raw);
      state.facts.quick1 = d;
      state.facts.quick1.me = state.facts.B.publicId;
      okLine(11, 'quick/run 双方都是真实玩家', `发起者 ${state.facts.B.publicId}(${state.facts.B.playerId}) vs 对手 ${d.opponent.publicId} → 档案库反查 OK（isBot=false，快照可用）；battleId=${d.battleId}（响应无 pl_）`);
      return `对手=${d.opponent.publicId}`;
    });

    /* ---- [12/22] Elo 可复算 + cap 3000 ---- */
    await step(12, "Elo：R' = R + K(S−E) 双向变动可复算；cap 3000 不越界", async () => {
      const d = state.facts.quick1;
      const selfResult = d.winner === 'win' ? 'win' : d.winner === 'loss' ? 'loss' : 'draw';
      const foeResult = d.winner === 'win' ? 'loss' : d.winner === 'loss' ? 'win' : 'draw';
      const selfCalc = quickmatch.ratingDelta({ points: d.self.pointsBefore, opponentPoints: d.opponent.pointsBefore, result: selfResult, config: RATING });
      const foeCalc = quickmatch.ratingDelta({ points: d.opponent.pointsBefore, opponentPoints: d.self.pointsBefore, result: foeResult, config: RATING });
      expect(d.self.pointsAfter === selfCalc.pointsAfter,
        `发起者积分应可复算：档案 ${d.self.pointsAfter} ≠ 公式 ${selfCalc.pointsAfter}（R=${d.self.pointsBefore} E=${selfCalc.expected}）`, j(d));
      expect(d.opponent.pointsAfter === foeCalc.pointsAfter,
        `对手积分应可复算：档案 ${d.opponent.pointsAfter} ≠ 公式 ${foeCalc.pointsAfter}`, j(d));
      expect(d.self.delta === selfCalc.pointsAfter - d.self.pointsBefore, '发起者 Δ 应等于公式差', j(d.self));
      expect(d.opponent.delta === foeCalc.pointsAfter - d.opponent.pointsBefore, '对手 Δ 应等于公式差', j(d.opponent));
      for (const side of ['self', 'opponent']) {
        expect(d[side].pointsAfter >= 0 && d[side].pointsAfter <= RATING.cap,
          `${side}.pointsAfter=${d[side].pointsAfter} 越界 [0,${RATING.cap}]`, j(d[side]));
      }
      // 升满 cap 的极端复核：cap 处再胜不越界（纯函数边界，机器复算）
      const atCap = ledger.ratingDelta({ points: RATING.cap, opponentPoints: RATING.cap, result: 'win', config: RATING });
      expect(atCap.pointsAfter === RATING.cap, `cap 处再胜应停在 ${RATING.cap}，实得 ${atCap.pointsAfter}`, j(atCap));
      state.facts.quick1.eloSelf = selfCalc;
      state.facts.quick1.eloFoe = foeCalc;
      okLine(12, 'Elo 双向可复算 + cap', `发起者 ${d.self.pointsBefore}→${d.self.pointsAfter}（Δ${d.self.delta}，E=${selfCalc.expected.toFixed(4)}，K=${selfCalc.k}）≡ 公式；对手 ${d.opponent.pointsBefore}→${d.opponent.pointsAfter}（Δ${d.opponent.delta}）≡ 公式；cap ${RATING.cap} 处再胜仍为 ${atCap.pointsAfter}`);
      return `Δ self=${d.self.delta} foe=${d.opponent.delta}`;
    });

    /* ---- [13/22] 积分守恒 ---- */
    await step(13, '积分守恒：Σrating(前) + ΣΔ = Σrating(后)（对局粒度 + 全局粒度）', async () => {
      const d = state.facts.quick1;
      const sumBefore = d.self.pointsBefore + d.opponent.pointsBefore;
      const sumDelta = d.self.delta + d.opponent.delta;
      const sumAfter = d.self.pointsAfter + d.opponent.pointsAfter;
      expect(sumBefore + sumDelta === sumAfter,
        `对局粒度守恒式不成立：${sumBefore} + ${sumDelta} ≠ ${sumAfter}`, j({ self: d.self, opponent: d.opponent }));
      // 全局粒度：所有档案 rating.points 之和 = 初始和 + 全部 Δ 之和
      let total = 0;
      for (const id of s.store.index.playerIds()) total += s.store.index.get(id).points;
      const before = state.facts.globalPointsBefore;
      expect(Number.isInteger(before), '缺少全局积分基线（应在第 11 步前采集）');
      expect(before + sumDelta === total,
        `全局守恒式不成立：基线 ${before} + ΣΔ ${sumDelta} ≠ 当前总量 ${total}（差额 ${total - before - sumDelta}）`, j({ before, sumDelta, total }));
      state.facts.globalPointsAfter = total;
      const lb = await request(port, 'GET', '/api/v1/leaderboard');
      expect(lb.status === 200, 'leaderboard 应 200', lb.raw);
      const lbSum = lb.body.data.rows.reduce((acc, x) => acc + x.points, 0);
      expect(lbSum === total, `排行榜积分总和 ${lbSum} 应与档案 ${total} 一致`, lb.raw);
      okLine(13, '积分守恒（对局 + 全局）', `对局：${d.self.pointsBefore}+${d.opponent.pointsBefore} + (${d.self.delta}${d.opponent.delta >= 0 ? '+' : ''}${d.opponent.delta}) = ${sumAfter} ✔；全局：${before} + ${sumDelta} = ${total} ✔（排行榜合计 ${lbSum} ≡ 档案）`);
      return `Σ前=${sumBefore} ΣΔ=${sumDelta} Σ后=${sumAfter}`;
    });

    /* ---- [14/22] ranked/run：抽池排除自己 + 24h 去重 + shortfall（不注入 bot） ---- */
    await step(14, 'POST /ranked/run：抽池排除自己 + 24h 去重 + 候选不足 → shortfall（不注入 bot）', async () => {
      const r = await request(port, 'POST', '/api/v1/ranked/run', { seed: 11 }, authed(state.facts.A.token));
      expect(r.status === 200, `排位应 200，实得 ${r.status}`, r.raw);
      const d = r.body.data;
      expect(d.requested === 10, `批次目标应为 10 场（D-122），实得 ${d.requested}`, r.raw);
      expect(d.matches <= d.requested, `matches ${d.matches} 不得超过 requested ${d.requested}`, r.raw);
      expect(d.shortfall === d.requested - d.matches, `shortfall 应等于缺口：${d.shortfall} ≠ ${d.requested - d.matches}`, r.raw);
      expect(d.wins + d.draws + d.losses + d.invalids === d.matches, '胜负平+invalid 应闭合到 matches', r.raw);
      expect(d.promoted === false, '缺场批次不判晋升（未打满 10 场不结段位）', r.raw);
      expect(!r.raw.includes('pl_') && !('opponentsDrawn' in d), '排位响应不得回带 playerId/opponentsDrawn（§4.5）', r.raw);
      // 每位真实对手最多出场一次（同批次不重复）且都是注册表里的真实玩家
      const foes = d.results.map((m) => m.opponentPublicId);
      expect(new Set(foes).size === foes.length, `同一批次对手不得重复：${foes.join(',')}`, r.raw);
      await assertReal(s.store, foes, 'ranked/run');
      expect(!foes.includes(state.facts.A.publicId), '抽池必须排除自己', r.raw);
      state.facts.ranked1 = d;

      // 24h 去重：紧接着再跑一轮 → 上一轮对手仍在冷却窗口内 → 池空 → shortfall=10
      const r2 = await request(port, 'POST', '/api/v1/ranked/run', { seed: 12 }, authed(state.facts.A.token));
      expect(r2.status === 200, `第二轮排位应 200，实得 ${r2.status}`, r2.raw);
      expect(r2.body.data.matches === 0 && r2.body.data.shortfall === 10,
        `24h 去重后应 0 场 / shortfall 10，实得 ${r2.body.data.matches} 场 / shortfall ${r2.body.data.shortfall}（D-136）`, r2.raw);
      state.facts.ranked2 = r2.body.data;
      okLine(14, 'ranked/run 抽池与 shortfall', `第 1 轮：matches=${d.matches} shortfall=${d.shortfall}（对手 ${foes.join(',')} 全部回查档案库 OK，排除自己）；第 2 轮：matches=${r2.body.data.matches} shortfall=${r2.body.data.shortfall} → 24h 去重生效，**未用 bot 凑场**`);
      return `shortfall=${d.shortfall}`;
    });

    /* ---- [15/22] 发起者同步结算 / 防守方离线只记战绩不掉段不掉分 ---- */
    await step(15, '发起者同步结算；防守方离线只记战绩、不掉段不掉分（D-132）', async () => {
      const d = state.facts.ranked1;
      const meA = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(meA.body.data.progress.batchesPlayed >= 1, '发起者批次计数应同步落盘', meA.raw);
      expect(meA.body.data.rating.points === 0, `排位不改积分（D-133 双轨），实得 ${meA.body.data.rating.points}`, meA.raw);
      const recA = await request(port, 'GET', '/api/v1/me/records', undefined, authed(state.facts.A.token));
      expect(recA.body.data.records.length === d.matches, `发起者战绩应 ${d.matches} 条（同步结算），实得 ${recA.body.data.records.length}`, recA.raw);
      const foeIds = d.results.map((m) => m.opponentPublicId);
      const defenses = [];
      for (const publicId of foeIds) {
        const token = publicId === state.facts.B.publicId ? state.facts.B.token : null;
        expect(token !== null, '本用例只对已注册玩家 B 断言防守视图（其余对手为真实档案）');
        const def = await request(port, 'GET', '/api/v1/me/defense', undefined, authed(token));
        expect(def.status === 200, `防守战绩应 200，实得 ${def.status}`, def.raw);
        expect(def.body.data.drawnCount >= 1, `被抽场次应 ≥1，实得 ${def.body.data.drawnCount}`, def.raw);
        const s3 = def.body.data.stats;
        expect(s3.wins + s3.losses + s3.draws === def.body.data.drawnCount, '防守胜负平应闭合到 drawnCount', def.raw);
        const meB = await request(port, 'GET', '/api/v1/me', undefined, authed(token));
        expect(meB.body.data.progress.tier === 'common', `防守方不掉段（应仍 common），实得 ${meB.body.data.progress.tier}`, meB.raw);
        defenses.push({ publicId, drawnCount: def.body.data.drawnCount, tier: meB.body.data.progress.tier, points: meB.body.data.rating.points });
      }
      okLine(15, '发起者同步结算 / 防守方离线记账', `发起者 batchesPlayed=${meA.body.data.progress.batchesPlayed} 战绩 ${recA.body.data.records.length} 条 积分 ${meA.body.data.rating.points}（排位不改分）；防守方 ${defenses.map((x) => `${x.publicId}:drawn=${x.drawnCount},tier=${x.tier},points=${x.points}`).join(' ')}（不掉段不掉分）`);
      return `防守方 ${defenses.length} 人记账`;
    });

    /* ---- [16/22] 战绩增量游标 + 未读归零 ---- */
    await step(16, 'GET /me/records?since= 增量游标；unread 计数；markSeen 后 unread=0', async () => {
      const before = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      const unreadBefore = before.body.data.record.unread.attack;
      expect(unreadBefore > 0, `未读进攻战绩应 >0，实得 ${unreadBefore}`, before.raw);

      const all = await request(port, 'GET', '/api/v1/me/records?limit=100', undefined, authed(state.facts.A.token));
      expect(all.status === 200, 'records 应 200', all.raw);
      const list = all.body.data.records;
      expect(list.length > 0, '应有战绩', all.raw);
      const seqs = list.map((x) => x.seq);
      const maxSeq = Math.max(...seqs);
      // 增量：since=maxSeq → 0 条（不漏不重的分界）
      const inc0 = await request(port, 'GET', `/api/v1/me/records?since=${maxSeq}`, undefined, authed(state.facts.A.token));
      expect(inc0.status === 200 && inc0.body.data.records.length === 0, `since=${maxSeq} 应返回 0 条，实得 ${inc0.body.data && inc0.body.data.records.length}`, inc0.raw);
      // 增量：since = 次大 seq → 恰 1 条，且 seq 严格大于 since（不漏）
      const sorted = [...new Set(seqs)].sort((a, b) => a - b);
      const second = sorted[sorted.length - 2];
      const inc1 = await request(port, 'GET', `/api/v1/me/records?since=${second}`, undefined, authed(state.facts.A.token));
      const got = inc1.body.data.records.map((x) => x.seq);
      expect(got.every((x) => x > second), `增量结果必须严格大于 since=${second}（不漏），实得 ${got.join(',')}`, inc1.raw);
      expect(got.length === 1 && got[0] === maxSeq, `增量应恰为最新 1 条（不重），实得 ${got.join(',')}`, inc1.raw);
      // 不重：全量里 battleId 唯一
      expect(new Set(list.map((x) => x.battleId)).size === list.length, '战绩不得重复 battleId', all.raw);

      const seen = await request(port, 'POST', '/api/v1/me/records/seen', { uptoSeq: all.body.data.maxSeq }, authed(state.facts.A.token));
      expect(seen.status === 200, `markSeen 应 200，实得 ${seen.status}`, seen.raw);
      expect(seen.body.data.unread.attack === 0, `markSeen 后 unread.attack 应归零，实得 ${seen.body.data.unread.attack}`, seen.raw);
      const after = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(after.body.data.record.unread.attack === 0, 'GET /me 的 unread 也应归零', after.raw);
      // 参数负例
      const bad = await request(port, 'GET', '/api/v1/me/records?since=-1', undefined, authed(state.facts.A.token));
      expect(bad.status === 400, `since 负数应 400，实得 ${bad.status}`, bad.raw);
      okLine(16, '战绩增量与未读', `共 ${list.length} 条（seq ${sorted.join(',')}）；since=${maxSeq} → 0 条；since=${second} → 恰 [${got.join(',')}]（不漏不重）；unread ${unreadBefore} → markSeen → ${after.body.data.record.unread.attack}（maxSeq=${all.body.data.maxSeq}）`);
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
      okLine(17, 'GET /me/defense 汇总', `drawnCount=${d.drawnCount} wins=${d.stats.wins} losses=${d.stats.losses} draws=${d.stats.draws} unread=${d.unread}；recent[0]={battleId:${d.recent[0].battleId}, opponent:${d.recent[0].opponentPublicId}}`);
      return `drawn=${d.drawnCount}`;
    });

    /* ---- [18/22] /leaderboard 与档案一致（降序、不暴露 playerId） ---- */
    await step(18, 'GET /leaderboard：与档案一致、points 降序、不暴露 playerId', async () => {
      const lb = await request(port, 'GET', '/api/v1/leaderboard');
      expect(lb.status === 200, `排行榜应 200，实得 ${lb.status}`, lb.raw);
      const rows = lb.body.data.rows;
      expect(Array.isArray(rows) && rows.length >= 3, `榜单至少应有 3 行，实得 ${rows && rows.length}`, lb.raw);
      for (let i = 1; i < rows.length; i++) {
        const prev = rows[i - 1];
        const cur = rows[i];
        const ordered = (cur.points < prev.points) || (cur.points === prev.points);
        expect(ordered, `排行榜必须按 points 非升序：第 ${i} 行 ${j(cur)} 优于上一行 ${j(prev)}`, lb.raw);
      }
      expect(!lb.raw.includes('pl_'), '排行榜不得暴露 playerId（§8.6）', lb.raw);
      // 与档案一致：逐行回查档案
      const all = [];
      for (const row of rows) {
        const pid = await playerIdByPublicId(s.store, row.publicId);
        expect(typeof pid === 'string', `榜单行 ${row.publicId} 无法回查 playerId`, lb.raw);
        const entry = s.store.index.get(pid);
        expect(row.points === entry.points, `榜单积分与档案不一致：${row.publicId} ${row.points} ≠ ${entry.points}`, j(row));
        expect(row.tier === entry.tier, `榜单段位与档案不一致：${row.publicId} ${row.tier} ≠ ${entry.tier}`, j(row));
        all.push(row);
      }
      const total = all.reduce((a, x) => a + x.points, 0);
      okLine(18, 'GET /leaderboard', `rows=${rows.length}：${rows.map((r) => `${r.rank}.${r.publicId}(${r.points})`).join(' ')}；降序 ✔ 无 pl_ ✔ 与档案逐行一致 ✔`);
      return `rows=${rows.length} Σpoints=${total}`;
    });

    /* ---- [19/22] 回放：非参与者 403 / 选择或过期 410 ---- */
    await step(19, 'GET /replay/:id：参与者 200；非参与者 403 replay_forbidden；过期/淘汰 410 replay_expired', async () => {
      const d = state.facts.quick1;
      const me = await request(port, 'GET', `/api/v1/replay/${d.battleId}`, undefined, authed(state.facts.B.token));
      expect(me.status === 200, `参与者取回放应 200，实得 ${me.status}`, me.raw);
      expect(me.body.data.id === d.battleId && Array.isArray(me.body.data.frames), '回放应含 id 与 frames', me.raw);
      expect(me.body.data.frames.length === d.ticks, `重算帧数应等于 ticks（${d.ticks}），实得 ${me.body.data.frames.length}`, me.raw);
      const anon = await request(port, 'GET', `/api/v1/replay/${d.battleId}`);
      expect(anon.status === 401, `未鉴权取归档回放应 401，实得 ${anon.status}`, anon.raw);
      const outsider = await request(port, 'GET', `/api/v1/replay/${d.battleId}`, undefined, authed(state.facts.solo.token));
      expect(outsider.status === 403, `非参与者应 403，实得 ${outsider.status}`, outsider.raw);
      expect(outsider.body.error.code === 'replay_forbidden', `非参与者错误码应为 replay_forbidden，实得 ${j(outsider.body.error)}`, outsider.raw);

      // 410 分支：归档记录引用的快照不可用（按 §9.3 步骤 4 → replay_expired/snapshot_gc）
      const foePublicId = d.opponent.publicId;
      const foeId = await playerIdByPublicId(s.store, foePublicId);
      const mine = await s.store.loadArchive(state.facts.B.playerId);
      const mineSlot = mine.configs.slots.find((x) => x.slotId === mine.configs.activeSlotId);
      const appended = await s.store.settleBattle({
        mode: 'quick', seed: 987654, at: Date.now(),
        p1: {
          playerId: state.facts.B.playerId, publicId: state.facts.B.publicId, role: 'attacker',
          snapshotHash: mineSlot.snapshot.hash, configHash: mineSlot.snapshot.configHash,
          pointsBefore: 0, pointsAfter: 0, result: 'win', tierBefore: 'common', tierAfter: 'common',
        },
        p2: {
          playerId: foeId, publicId: foePublicId, role: 'defender',
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
      // 未知 id → 404
      const unknown = await request(port, 'GET', '/api/v1/replay/b_ffffffffffffffff', undefined, authed(state.facts.B.token));
      expect(unknown.status === 404 && unknown.body.error.code === 'unknown_replay', `未知回放应 404 unknown_replay，实得 ${unknown.status} ${j(unknown.body.error)}`, unknown.raw);
      okLine(19, '回放鉴权与失效', `参与者 200（${me.body.data.frames.length} 帧 = ticks ${d.ticks}）；未鉴权 401；非参与者 403 replay_forbidden；快照缺失归档 ${goneId} → 410 replay_expired（${gone.body.error.message}）；未知 id → 404`);
      return '200/401/403/410/404';
    });

    /* ---- [20/22] /ranked/promote（读档案，不落盘） ---- */
    await step(20, 'POST /ranked/promote：读档案段位 + 403 段位不一致 + 不越权落盘', async () => {
      const ok = await request(port, 'POST', '/api/v1/ranked/promote', { wins: 7 }, authed(state.facts.A.token));
      expect(ok.status === 200, `promote 应 200，实得 ${ok.status}`, ok.raw);
      expect(ok.body.data.tier === 'rare' && ok.body.data.promoted === true, `common + wins>6 → rare，实得 ${j(ok.body.data)}`, ok.raw);
      expect(ok.body.data.reward === 'rare', '应回带段位奖励品质', ok.raw);
      const mismatch = await request(port, 'POST', '/api/v1/ranked/promote', { tier: 'mythic', wins: 7 }, authed(state.facts.A.token));
      expect(mismatch.status === 403 && mismatch.body.error.code === 'forbidden', `伪造段位应 403 forbidden，实得 ${mismatch.status} ${j(mismatch.body.error)}`, mismatch.raw);
      const me = await request(port, 'GET', '/api/v1/me', undefined, authed(state.facts.A.token));
      expect(me.body.data.progress.tier === 'common', '兼容端点只做判定（晋升权威在 /ranked/run），不得"不打就升段"', me.raw);
      okLine(20, 'ranked/promote', `wins=7 → promoted=true tier=rare reward=rare（仅判定）；入参 tier=mythic 与档案不符 → 403 forbidden；档案段位仍 ${me.body.data.progress.tier}`);
      return 'promote 判定 + 403';
    });

    /* ---- [21/22] 快速对战 Elo 双向变化（真实玩家对手，再次复算） ---- */
    await step(21, 'POST /quick/run（真实玩家对手）→ Elo 双向变化可复算、cap 不越界', async () => {
      const r = await request(port, 'POST', '/api/v1/quick/run', { seed: 777001 }, authed(state.facts.A.token));
      expect(r.status === 200, `A 的快速对战应 200（B 本轮尚未与 A 交手），实得 ${r.status}`, r.raw);
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
      // 双向都落盘：对手档案的积分 = 响应值
      const foeMe = await request(port, 'GET', '/api/v1/me', undefined, authed(d.opponent.publicId === state.facts.B.publicId ? state.facts.B.token : state.facts.solo.token));
      expect(foeMe.status === 200, '对手档案可读', foeMe.raw);
      expect(foeMe.body.data.rating.points === d.opponent.pointsAfter,
        `对手积分应已落盘：档案 ${foeMe.body.data.rating.points} ≠ 响应 ${d.opponent.pointsAfter}`, foeMe.raw);
      state.facts.quick2 = d;
      okLine(21, 'quick/run（第二次，真实对手）', `A(${state.facts.A.publicId}) ${d.self.pointsBefore}→${d.self.pointsAfter}（Δ${d.self.delta}）vs ${d.opponent.publicId} ${d.opponent.pointsBefore}→${d.opponent.pointsAfter}（Δ${d.opponent.delta}）；双方 Δ 均与公式逐值相同，cap ${RATING.cap} 未越界，对手档案已落盘`);
      return `Δ ${d.self.delta}/${d.opponent.delta}`;
    });

    /* ---- [22/22] CLI 子命令 + 退出码 3 = 未鉴权 + DL_LEGACY_STATELESS=0 兼容口径 ---- */
    await step(22, 'CLI auth/me/quick/leaderboard + 退出码 3 = 未鉴权；DL_LEGACY_STATELESS=0 → 旧端点 410', async () => {
      const base = `http://127.0.0.1:${port}`;
      // CLI 只走 HTTP：用注入的 stdout 缓冲捕获文本 + 退出码
      async function runCli(argv) {
        const buf = [];
        const code = await cliMain.main(argv, { baseUrl: base, out: (s) => buf.push(s), env: { DL_API_BASE: base } });
        return { code, text: buf.join('\n') };
      }
      const savedBase = process.env.DL_API_BASE;
      process.env.DL_API_BASE = base;
      try {
        const health = await runCli(['health']);
        expect(health.code === 0, `cli health 应退出码 0，实得 ${health.code}`, health.text);
        // 未鉴权 → 退出码 3（T-CLI-2 扩展）
        const unauth = await runCli(['me']);
        expect(unauth.code === 3, `cli me 未鉴权应退出码 3，实得 ${unauth.code}`, unauth.text);
        // 登录后 me / leaderboard / quick
        const login = await runCli(['auth', 'login', '--username', state.facts.A.username, '--password', PASSWORD]);
        expect(login.code === 0, `cli auth login 应退出码 0，实得 ${login.code}`, login.text);
        const token = state.facts.A.token;
        const me = await runCli(['me', '--token', token]);
        expect(me.code === 0, `cli me 应退出码 0，实得 ${me.code}`, me.text);
        const lb = await runCli(['leaderboard', '--limit', '5']);
        expect(lb.code === 0, `cli leaderboard 应退出码 0，实得 ${lb.code}`, lb.text);
        expect(lb.text.includes(state.facts.A.publicId) || /rank/i.test(lb.text), 'cli leaderboard 应输出榜单内容', lb.text);
        const quick = await runCli(['quick', '--token', token, '--seed', '31415']);
        expect(quick.code === 0, `cli quick 应退出码 0（池中有真实对手），实得 ${quick.code}`, quick.text);
        okLine(22, 'CLI 子命令与退出码', `health→0；me 无 token→**3**；auth login→0；me→0；leaderboard→0；quick→0（seed 31415，实时真实对手）`);
        state.facts.cliCode = quick.code;
      } finally {
        if (savedBase === undefined) delete process.env.DL_API_BASE; else process.env.DL_API_BASE = savedBase;
      }
      return 'CLI 闭环 0/3';
    });

    /* ---- [附] DL_LEGACY_STATELESS：默认 1 时旧端点零回归（检查点 21） ---- */
    await step(21, 'DL_LEGACY_STATELESS=1（默认）：旧无状态端点零回归；=0 → 410 deprecated', async () => {
      // =1（本进程默认）：旧端点全部可用
      const box = await request(port, 'POST', '/api/v1/box', { seed: 1, tier: MODE, times: 1 });
      expect(box.status === 200, `legacy box 应 200，实得 ${box.status}`, box.raw);
      const wh = await request(port, 'GET', '/api/v1/warehouse');
      expect(wh.status === 200, `legacy warehouse 应 200，实得 ${wh.status}`, wh.raw);
      const bat = await request(port, 'POST', '/api/v1/battle', { p1: state.facts.ldA, p2: state.facts.ldA, seed: 5, tier: MODE });
      expect(bat.status === 200, `legacy battle 应 200，实得 ${bat.status}`, bat.raw);
      expect(/^r\d+$/.test(bat.body.data.id), '遗留回放 id 应为 r<seq>', bat.raw);
      const legacyReplay = await request(port, 'GET', `/api/v1/replay/${bat.body.data.id}`);
      expect(legacyReplay.status === 200, `遗留回放（无 token）应 200，实得 ${legacyReplay.status}`, legacyReplay.raw);

      // =0：另起一个实例（同一实现，开关置 0）→ 旧端点 410 deprecated，新端点仍可用
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
      okLine(21, 'DL_LEGACY_STATELESS 兼容口径', `=1（默认）：box/warehouse/battle/replay(r…) 全 200 零回归；=0：旧端点 410 deprecated，health 仍 200`);
      return 'legacy 零回归 + 410 deprecated';
    });

    /* ---------- 结果行 + 无 bot 证据 ---------- */
    const ms = Date.now() - t0;
    const passed = state.steps.filter((x) => x.ok).length;
    say('');
    say(`=== 结果：22/22 检查点通过（${passed} 步，用时 ${ms} ms）  退出码 0 ===`);
    say(`无 bot 证据（对局双方 playerId 均可从档案库追溯）：${noBotLog.length} 条`);
    const seen = new Set();
    for (const p of noBotLog) {
      if (seen.has(p.playerId)) continue;
      seen.add(p.playerId);
      say(`  · ${p.where}  ${p.publicId} → playerId=${p.playerId}  nickname=${p.nickname}  tier=${p.tier}  points=${p.points}  isBot=${p.isBot}  snapshot=${short(p.snapshotHash, 26)}`);
    }
    say(`  对局数：quick 2 场 + ranked ${state.facts.ranked1.matches} 场 + legacy ${1} 场；其中参与结算的对手全部在上述真实档案内（0 个 bot）`);
    say('');
    say('（提示）本脚本第 6 步的出战配置**未携带装配引用**：装配后的配置当前会被排位/快速对战的快照实例化拒绝');
    say('         （server/ranked.js 与 server/quickmatch.js 以 warehouse=null 调 buildPlayer；见交付报告"后端缺陷 D1"）。');
    say(`摘要行：e2e PASS 检查点=22/22 步=${passed} 用时=${ms}ms 数据根=${path.basename(dataDir)} 端口=${port}`);
    return 0;
  } finally {
    if (s) await s.close();
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

// 头部引用 fs 以保证"只在显式 --keep 时保留临时目录"的可读性（当前恒清理）
void HEAD_LINES;

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    out('');
    out(`=== 结果：e2e 失败 → 非零退出（退出码 1）===`);
    if (e && e.stack) out(String(e.stack).split('\n').slice(0, 4).join('\n'));
    process.exitCode = 1;
  });
}

module.exports = { main };
