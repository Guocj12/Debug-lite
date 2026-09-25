#!/usr/bin/env node
'use strict';
/* scripts/e2e.js —— P7-5 全链路端到端：**真实玩家**从注册到快速对战的一条命令闭环
 *
 * 契约（唯一权威）：
 *   · docs/plan-p7-playable.md §P7-5（本阶段验收）+ §0（全局约束）
 *   · docs/reviews/P7-7-test-audit.md §B1「P7-5 应覆盖的检查点清单（22 条）」——本脚本**按该表顺序**逐步执行
 *   · docs/interfaces.md §2（端点表）/§7（环境变量）；docs/systems/11-account-store.md §10（端点/状态码）
 *   · decisions.md D-131/D-132/D-133/D-135/D-152 + **D-159（仓库服务端权威，推翻 D-130）/D-160（配置完整性校验时机）
 *     /D-161（AI 库）/D-162（开箱 seed 服务端独占）**
 *
 * 覆盖的 22 个检查点（编号 = §B1 表格行号，`[n/22]` 前缀即该行）：
 *   1 注册 200 + token；重名 409 user_exists；2 登录 / 错密码 401 / 连错 429 锁定 / logout 后 401；
 *   3 GET /me 401 三态与字段（**D-159：注册即 3 槽 + GET /me/warehouse 真源 starter 已发放**）；4 GET /me 幂等；
 *   5 **服务端权威仓库**：`POST /me/box`（无 seed 入参，D-162）→ `POST /me/warehouse/assemble`（不传整仓）
 *     → `GET /me/warehouse` 真源；`PUT /me/warehouse` 退役为只校验形状（不覆盖出战配置 → 200 verified:false）；
 *   6 配置槽 ≤3 / 409 slot_limit / 409 slot_locked / 唯一出战 / **注册即 3 槽（slot1 完整出战 + slot2·3 空槽）**
 *     / **D-160**：非出战槽可写不完整（200 complete:false）、出战槽不完整 409 loadout_invalid、空槽激活 409
 *     cannot_activate_incomplete；
 *   7 POST /panel 与单测 buildPanel 逐值一致；8 /ai/validate 三态（非法 400+path / 合法 warnings:[] /
 *     废弃动作 warnings 非空）；9 /ai/compile programHash 稳定；10 池空 quick/run **不注入 bot**；
 *   11 有对手时双方都是真实注册玩家；12 Elo 双向变动可复算 + cap 3000 不越界；13 积分守恒（对局 + 全局）；
 *   14 ranked/run 抽池排除自己 + 24h 去重 + 候选不足 shortfall；15 发起者同步结算 / 防守方离线只记战绩；
 *   16 战绩增量游标 + 未读归零；17 /me/defense 汇总；18 /leaderboard 降序且不暴露 playerId；
 *   19 回放：非参与者 403 / 过期或淘汰 410 + **D-159-R1 回归**（保存配置**不带 warehouse** → 打一场 → 回放 200）；
 *   20 CLI auth/me/quick/leaderboard + 退出码 3 = 未鉴权（并含 `/ranked/promote`：兼容端点读档案、不越权落盘）；
 *   21 DL_LEGACY_STATELESS 兼容口径（=1 零回归 / =0 410）；22 一条命令退出码 0，且每一步打印真实响应关键字段。
 *
 * 约束（项目铁律）：零依赖；CommonJS；**禁 child_process / Math.random**（随机性一律来自显式 seed；
 *   D-162 起**开箱**的随机性由服务端独占 —— `start({ boxSeed })` 注入确定性序列，见 `E2E_BOX_SEED`）；
 *   进程内起服务（`server/index.js` 导出的 handler + `node:http` 监听随机端口）；数据根 `os.tmpdir()` 隔离。
 *
 * 🚫 无占位 bot（用户 2026-09-16 明令 / D-152）：对局双方一律是 `/auth/register` 注册的**真实档案**；
 *   本脚本对每场对局涉及的每个 publicId 都回查 `store.index` → `playerId` → 档案 + 出战快照作为证据
 *   （末尾"无 bot 证据"清单逐条打印）。
 *
 * ✅ 装配引用端到端（**D-159 服务端权威口径；D-163 修订**）：第 5 步用 `POST /me/box` 开箱（物品入服务端仓库）+
 *   `POST /me/warehouse/assemble` 装配（只传 targetUid/pluginUid/slotIndex，不传整仓；服务端落档 `equipped=true`）；
 *   第 6 步保存出战配置**不再提交客户端镜像**——物品按 uid 从服务端仓库解析（D-163），且**同一件物品只能属于一份配置**
 *   （脚本因此先验证"重复引用 → 409 item_in_use"，再为 slot2 注入并使用另一套物品）；
 *   快照**不再内联**"引用到的插件项"（缺口 1 的镜像片段，HTTP 保存路径已不再写入），唯一真源 = 服务端仓库。
 *   第 7 步 `POST /panel` 用真源聚合并与单测 `buildPanel` 逐值比对（另有"去掉 warehouse 必 missing_warehouse"的反证）；
 *   第 11/14/19/22 步用**含装配插件的配置真的打完对局**（含 D-159-R1：保存时不带 warehouse 也能回放重算）。
 *   本脚本**不再**有任何"为绕过缺陷而剥离引用"的适配；客户端也不再是仓库权威（D-130 已被 D-159 推翻）。
 *
 * ⚠️ 抽池可控性（2026-09-19 复审修正）：`/quick/run`、`/ranked/run` 的**对手**由服务端抽池决定
 *   （池内任意真实玩家，默认配置者 0 处装配引用），故"含装配插件能出战"的判定一律**锚在发起者侧**
 *   （第 11 步 = B、第 14/21/22 步 = A，都是 `authed(<某玩家>.token)` 的确定侧），绝不假设"抽中的是 A"。
 *   对手抽中 A 时额外做同款全链核验；抽中默认配置玩家时**如实打印**该事实（不得伪装成已覆盖）。
 *   另在第 21 步用 legacy `/battle`（p1=p2=含装配引用的同一配置 + 真镜像）做**双方**确定性的出战证明。
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
// D-162：开箱随机性收归**服务端**（HTTP 层没有 `seed` 入参，传了被静默忽略）→ 本脚本改用实例级注入缝
//   `start({ boxSeed })` 提供**确定性 seed 序列**（第 n 次开箱 = boxSeed + n − 1），
//   使"同一条命令两次运行得到同一批物品"这一可复现性依旧成立（不依赖客户端 seed）。
const E2E_BOX_SEED = 20260921;

const out = (s) => process.stdout.write(`${s}\n`);
const j = (v) => JSON.stringify(v);
const short = (v, n) => {
  const s = typeof v === 'string' ? v : j(v);
  const lim = n || 160;
  return s.length > lim ? `${s.slice(0, lim)}…` : s;
};

/* ---------- 运行框架：任一步失败 → 打印上游真实响应 + 非零退出 ---------- */

const state = { step: 0, steps: [], facts: { tokens: {}, quickBattles: [] } }; // tokens: publicId → 会话 token（夹具持有全部注册玩家）
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

// 注册真实玩家并登记 token（`state.facts.tokens`：publicId → token，供后续按 publicId 反查）
async function registerPlayer(port, username, nickname) {
  const r = await request(port, 'POST', '/api/v1/auth/register', { username, password: PASSWORD, nickname });
  if (r.status === 200 || r.status === 201) state.facts.tokens[r.body.data.publicId] = r.body.data.token;
  return r;
}

// 防守战绩视图：夹具持有 token 时走 HTTP（覆盖端点），否则退回档案层同一视图（脚本内不应发生）
async function defenseViewOf(port, store, publicId) {
  const pid = await playerIdByPublicId(store, publicId);
  const token = state.facts.tokens[publicId];
  if (token) {
    const r = await request(port, 'GET', '/api/v1/me/defense', undefined, authed(token));
    expect(r.status === 200, `GET /me/defense 应 200，实得 ${r.status}`, r.raw);
    const me = await request(port, 'GET', '/api/v1/me', undefined, authed(token));
    return { via: 'http', data: r.body.data, tier: me.body.data.progress.tier, points: me.body.data.rating.points };
  }
  const arch = await store.loadArchive(pid);
  return { via: 'store', data: await store.defenseSummary(pid, { limit: 20 }), tier: arch.progress.tier, points: arch.rating.points };
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
      // 跨 chunk 多字节字符必须按 Buffer 累积后整段解码（`data += c` 逐 chunk toString → U+FFFD）
      const chunks = [];
      res.on('data', (c) => { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); });
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
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

// 该玩家是否参与过任何已结算对局（扫 journal；用于挑选确定性的"非参与者"）
async function battleParticipants(store) {
  const set = new Set();
  await store.replayJournal({ fromSeq: 0, includeCheckpoints: false }, (r) => {
    if (!r || r.type !== 'battle.recorded') return;
    if (r.p1 && typeof r.p1.playerId === 'string') set.add(r.p1.playerId);
    if (r.p2 && typeof r.p2.playerId === 'string') set.add(r.p2.playerId);
  });
  return set;
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

// GET /me/warehouse —— D-159 的**仓库真源**（客户端不再持权威镜像）
async function warehouseOf(port, token, tag) {
  const r = await request(port, 'GET', '/api/v1/me/warehouse', undefined, authed(token));
  expect(r.status === 200, `${tag ? `${tag} ` : ''}GET /me/warehouse（D-159 真源）应 200，实得 ${r.status}`, r.raw);
  const d = r.body.data;
  expect(d && d.buckets && Array.isArray(d.buckets.role) && Array.isArray(d.buckets.skill)
    && d.caps && d.counts && typeof d.starterIssued === 'boolean',
    'GET /me/warehouse 应含 buckets/caps/counts/starterIssued（D-159 契约）', short(r.raw, 300));
  return d;
}

/* 开箱 → 装配，**全部走服务端权威写路径**（D-159 / D-162）：
 *   · `POST /me/box`：体只 `{tier,times}` —— **没有 seed 入参**（D-162；确定性由 `start({boxSeed})` 提供），
 *     物品直接入服务端仓库（不再是遗留 `/box` 的"无状态、不入档"）；
 *   · `POST /me/warehouse/assemble`：体只 `{targetUid,pluginUid,slotIndex}` —— **不传整仓**（整仓版
 *     `/warehouse/assemble` 是遗留无状态路径）；点数/槽型/唯一性全部由服务端裁决，并落档 `equipped=true`；
 *   · 结束时回带 `GET /me/warehouse` 的**真源正文**，后续步骤一律用它构造出战配置。
 * 返回 { warehouse, opened, placed, skipped, rounds, countsBefore, equippedBefore, equippedAfter }。
 */
async function openAndAssemble(port, token, tag, wantRole, wantSkill) {
  const opened = [];
  let wh = await warehouseOf(port, token, tag);
  const countsBefore = { ...wh.counts };
  let rounds = 0;
  // 至少开一轮（检查点 5 的"开箱"必须是真请求；starter 已给角色/技能，故用 do-while）
  do {
    const r = await request(port, 'POST', '/api/v1/me/box', { tier: MODE, times: 12 }, authed(token));
    expect(r.status === 200, `${tag} POST /me/box 应 200，实得 ${r.status}`, r.raw);
    expect(Array.isArray(r.body.data.items) && r.body.data.items.length === 12,
      `${tag} 开箱应回带 12 件物品，实得 ${r.body.data && r.body.data.items && r.body.data.items.length}`, short(r.raw, 300));
    expect(typeof r.body.data.grantId === 'string' && r.body.data.grantId.startsWith('bx_'),
      `${tag} 服务端权威开箱应回带 grantId（幂等批次标识，D-159）`, short(r.raw, 300));
    for (const it of r.body.data.items) opened.push(it);
    rounds += 1;
    wh = await warehouseOf(port, token, tag);
  } while ((wh.buckets.role.length < wantRole || wh.buckets.skill.length < wantSkill) && rounds < 8);
  expect(wh.buckets.role.length >= wantRole && wh.buckets.skill.length >= wantSkill,
    `${tag} 开箱 ${rounds} 轮仍不足（角色 ${wh.buckets.role.length}/${wantRole}，技能 ${wh.buckets.skill.length}/${wantSkill}）`);
  const totalBefore = countsBefore.role + countsBefore.skill + countsBefore.rolePlugin + countsBefore.skillPlugin;
  const totalAfter = wh.counts.role + wh.counts.skill + wh.counts.rolePlugin + wh.counts.skillPlugin;
  expect(totalAfter >= totalBefore + opened.length,
    `${tag} 开箱物品必须真的入档（服务端权威仓库）：${totalBefore} + ${opened.length} ≤ ${totalAfter}`,
    j({ before: countsBefore, after: wh.counts }));

  const equippedBefore = wh.buckets.rolePlugin.concat(wh.buckets.skillPlugin).filter((p) => p.equipped === true).length;
  const placed = [];
  const skipped = [];
  const used = new Set();
  for (const t0 of wh.buckets.role.concat(wh.buckets.skill)) {
    if (placed.length >= 4) break; // 控制请求数：每玩家最多 4 处
    const target = findItem(wh, t0.uid);
    if (!target) continue;
    const kind = target.kind === 'role' ? 'rolePlugin' : 'skillPlugin';
    for (let i = 0; i < (target.slots || []).length; i++) {
      if (placed.length >= 4) break;
      const slot = target.slots[i];
      if (!slot || slot.pluginUid) continue;
      const cand = (wh.buckets[kind] || []).find((p) => p.slot === slot.type && p.equipped !== true && !used.has(p.uid));
      if (!cand) { skipped.push(`${target.uid}[${i}] 无 ${slot.type} 槽插件`); continue; }
      used.add(cand.uid);
      const a = await request(port, 'POST', '/api/v1/me/warehouse/assemble',
        { targetUid: target.uid, pluginUid: cand.uid, slotIndex: i }, authed(token));
      if (a.status === 200) {
        wh = a.body.data.warehouse;
        placed.push(`${cand.uid}→${target.uid}[${i}]`);
      } else {
        skipped.push(`${target.uid}[${i}] ${a.body.error && a.body.error.code}`);
      }
    }
  }
  // 装配响应里的 `warehouse` 只是仓库正文（不含 usage/caps/counts/starterIssued）→ 收尾统一回读真源
  wh = await warehouseOf(port, token, tag);
  const equippedAfter = wh.buckets.rolePlugin.concat(wh.buckets.skillPlugin).filter((p) => p.equipped === true).length;
  return { warehouse: wh, opened, placed, skipped, rounds, countsBefore, equippedBefore, equippedAfter };
}

// 出战配置里的**真实装配引用**条数（回收 D1 适配后的核心验收量）：
//   >0 即证明本脚本没有再把 pluginUid 清空/剥离 —— 第 6/7/11/14/22 步跑的是"含装配插件的配置"。
function pluginRefsOf(ld) {
  return pluginRefUidsOf(ld).length;
}

// 出战配置里被引用的**插件 uid 列表**（D-163：这些 uid 必须在服务端权威仓库里能找到且 equipped=true）
function pluginRefUidsOf(ld) {
  const out = [];
  const collect = (slots) => {
    for (const s of (Array.isArray(slots) ? slots : [])) {
      if (s && typeof s.pluginUid === 'string' && s.pluginUid !== '') out.push(s.pluginUid);
    }
  };
  if (ld && ld.role) collect(ld.role.slots);
  for (const sk of (ld && Array.isArray(ld.skills) ? ld.skills : [])) collect(sk && sk.slots);
  return out;
}

// 快照正文里**持久化下来的仓库镜像片段**（缺口 1 的时代产物；D-163 起 HTTP 保存不再写入）含多少个插件项
function warehouseItemsOf(snap) {
  const bk = (snap && snap.warehouse && snap.warehouse.buckets) || {};
  return ((bk.rolePlugin || []).length) + ((bk.skillPlugin || []).length);
}

// 玩家当前出战槽 + 其冻结快照正文（档案驱动路径的权威来源）
async function activeSnapshotOf(store, playerId) {
  const arch = await store.loadArchive(playerId);
  const slot = arch.configs.slots.find((x) => x.slotId === arch.configs.activeSlotId);
  return { slot, snap: await store.snapshot.get(slot.snapshot.hash) };
}

// D-163：核验用的仓库正文必须是**服务端权威真源**（`GET /me/warehouse` 的 `{buckets,usage,…}`），
//   而不是流程早期抓下来的事实快照（可能已陈旧，且不含物品的 `equipped` 状态）。
async function liveWarehouseOf(port, token) {
  const r = await request(port, 'GET', '/api/v1/me/warehouse', undefined, authed(token));
  return r && r.body && r.body.ok === true ? r.body.data : null;
}

/* 含装配引用的出战方**机器核验**（D-163 口径：物品一律来自**服务端权威仓库**；第 11/14/21/22 步共用同一判定）
 *   ① 快照正文确含真实装配引用（refs>0）—— 证明 e2e 没有靠剥离 pluginUid 换绿；
 *   ② 每个被引用的插件都能在**权威仓库**里解析到且 `equipped===true`（D-163 的装配不变量）；
 *   ③ 面板一致性：用**权威仓库**必须能算出面板；**同一配置去掉仓库**必须如实 `missing_warehouse`
 *      （反证引用是真的、校验没空转）；
 *   ④ 快照标记 `verifiedAgainstWarehouse=true`（保存时确实经服务端仓库校验过）；
 *   ⑤ D-163：HTTP 保存的快照**不再内联**仓库镜像片段（`snapshot.warehouse === undefined`），
 *      唯一真源 = 服务端仓库（`rt.loadWarehouse`）。
 * `fullWarehouse` 为必填：**必须**持有该玩家的完整仓库正文（`GET /me/warehouse` 的 buckets），否则③会空转。
 * 返回 { refs, whItems, stats }（`whItems` = 从权威仓库解析并确认已装配的引用项数）供打印。
 */
async function verifyPluginSide(store, label, playerId, fullWarehouse, tier) {
  expect(fullWarehouse && typeof fullWarehouse === 'object',
    `${label}：核验含装配引用的一侧必须提供完整仓库正文（否则一致性断言会空转）`);
  const side = await activeSnapshotOf(store, playerId);
  const refs = pluginRefsOf(side.snap.loadout);
  expect(refs > 0,
    `${label} 的出战快照必须含真实装配引用（实测 ${refs} 处）——不得靠剥离 pluginUid 换绿`, j(side.slot.snapshot));
  expect(side.slot.snapshot.verifiedAgainstWarehouse === true,
    `${label} 保存配置时经服务端仓库校验 → 快照应标记 verifiedAgainstWarehouse=true`, j(side.slot.snapshot));
  const refUids = pluginRefUidsOf(side.snap.loadout);
  const resolved = refUids.filter((uid) => {
    const it = findItem(fullWarehouse, uid);
    return !!(it && it.equipped === true);
  });
  expect(resolved.length === refUids.length,
    `${label}：快照引用的 ${refUids.length} 个插件必须全部能在服务端权威仓库解析到且 equipped=true（实测 ${resolved.length}）`,
    j(refUids.filter((u) => resolved.indexOf(u) === -1)));
  expect(side.snap.warehouse === undefined,
    `${label}：D-163 起 HTTP 保存的快照不再内联仓库镜像片段（唯一真源 = 服务端仓库）`,
    j(Object.keys(side.snap.warehouse || {})));
  const viaAuth = loadoutApi.buildPanel(side.snap.loadout, { warehouse: fullWarehouse, tier });
  expect(viaAuth.ok === true, `${label} 用服务端权威仓库必须能算出面板`, j(viaAuth.errors));
  const noWh = loadoutApi.buildPanel(side.snap.loadout, { warehouse: null, tier });
  expect(noWh.ok === false && (noWh.errors || []).some((e) => e.code === 'missing_warehouse'),
    `${label} 同一配置去掉仓库必须如实 missing_warehouse（反证引用为真、校验未空转）`, j(noWh.errors));
  const whItems = resolved.length;
  expect(whItems > 0, `${label} 至少要有 1 个引用能从权威仓库解析出来（否则配置是装饰）`, j(refUids));
  return { refs, whItems, stats: viaAuth.panel.role.stats };
}

// 确定性对局剧本（只改**客户端权威**的物品字段，§15.1 混合权威）：把一方的 hp 压到 1 且双方都"一直向右"
// → 双方会在场地中央接触，A 先手把 B 打到 1hp 归零 → A 胜（seed 无关、tick 恒定）。
// 用途：让 Elo 双向 Δ 非零、积分守恒可观测（否则同血同 AI 会长期平局 Δ=0）。
const HOLD_RIGHT = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } };

// 出战配置：**保留真实装配引用**（slot.pluginUid 原样带走，不剥离、不清空）——第 6/7/11/14/22 步据此
//   验收"含装配插件的配置能成功出战"。深拷贝以免污染仓库镜像（同一 warehouse 会被后续步骤继续使用）。
function scriptedLoadout(warehouse, fragile) {
  const ld = JSON.parse(JSON.stringify({
    role: warehouse.buckets.role[0],
    skills: warehouse.buckets.skill.slice(0, 3),
    ai: HOLD_RIGHT,
  }));
  if (fragile) ld.role.stats = { hp: 1, atk: 12, def: 0, sp: 60, mp: 40 };
  return ld;
}

// D-163：跨配置独占 —— 第二份配置必须用**另一套**物品（同一件物品同时只能属于一份配置）。
//   按偏移量取第 N 套（roles[N] + skills[N*3 .. N*3+2]）；不足则返回 null（调用方如实报错）。
function scriptedLoadoutAt(warehouse, offset) {
  const roles = (warehouse && warehouse.buckets && warehouse.buckets.role) || [];
  const skills = (warehouse && warehouse.buckets && warehouse.buckets.skill) || [];
  const role = roles[offset];
  const picked = skills.slice(offset * 3, offset * 3 + 3);
  if (!role || picked.length < 3) return null;
  return JSON.parse(JSON.stringify({ role, skills: picked, ai: HOLD_RIGHT }));
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
      boxSeed: E2E_BOX_SEED, // D-162：开箱 seed 服务端独占 → 用注入缝保证确定性序列
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
      const a = await registerPlayer(port, 'e2e_alpha_1', '阿尔法');
      expect(a.status === 200 || a.status === 201, `注册状态码应为 200/201，实得 ${a.status}`, a.raw);
      expect(a.body.ok === true && typeof a.body.data.token === 'string' && a.body.data.token.length >= 40, '注册应下发 token', a.raw);
      expect(typeof a.body.data.publicId === 'string' && a.body.data.publicId.startsWith('u_'), '注册应下发 publicId', a.raw);
      expect(!a.raw.includes('pl_'), '注册响应不得回带 playerId（§4.5）', a.raw);
      state.facts.A = { token: a.body.data.token, publicId: a.body.data.publicId, username: 'e2e_alpha_1' };
      state.facts.tokens[state.facts.A.publicId] = state.facts.A.token;
      state.facts.A.playerId = await playerIdByPublicId(s.store, state.facts.A.publicId);
      expect(typeof state.facts.A.playerId === 'string' && state.facts.A.playerId.startsWith('pl_'),
        'A 的 publicId 必须能反查到真实 playerId（档案库）', j(a.body));

      const b = await registerPlayer(port, 'e2e_beta_2', '贝塔');
      expect(b.status === 200 || b.status === 201, `B 注册失败 ${b.status}`, b.raw);
      state.facts.B = { token: b.body.data.token, publicId: b.body.data.publicId, username: 'e2e_beta_2' };
      state.facts.tokens[state.facts.B.publicId] = state.facts.B.token;
      state.facts.B.playerId = await playerIdByPublicId(s.store, state.facts.B.publicId);

      const dup = await request(port, 'POST', '/api/v1/auth/register', { username: 'e2e_alpha_1', password: PASSWORD });
      expect(dup.status === 409, `重名注册应 409，实得 ${dup.status}`, dup.raw);
      expect(dup.body.error && dup.body.error.code === 'username_taken', `重名错误码应为 username_taken，实得 ${j(dup.body.error)}`, dup.raw);

      // 第 4 个真实玩家：CLI 闭环用（同时作为回放"非参与者"分支的主体，必须确定不参与任何对局）
      const cliP = await registerPlayer(port, 'e2e_cli_5', '命令行');
      expect(cliP.status === 200 || cliP.status === 201, `CLI 玩家注册失败 ${cliP.status}`, cliP.raw);
      state.facts.cliPlayer = { token: cliP.body.data.token, publicId: cliP.body.data.publicId, username: 'e2e_cli_5' };
      state.facts.tokens[state.facts.cliPlayer.publicId] = state.facts.cliPlayer.token;
      state.facts.cliPlayer.playerId = await playerIdByPublicId(s.store, state.facts.cliPlayer.publicId);
      expect(typeof state.facts.cliPlayer.playerId === 'string', 'CLI 玩家档案应可回查', cliP.raw);

      okLine(1, '注册真实玩家', `A=${state.facts.A.publicId}(${state.facts.A.playerId}) B=${state.facts.B.publicId}(${state.facts.B.playerId}) CLI=${state.facts.cliPlayer.publicId}；token 长度 ${state.facts.A.token.length}；重名 → 409 username_taken`);
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

      const victim = await registerPlayer(port, 'e2e_lock_3');
      expect(victim.status === 200 || victim.status === 201, `锁定用例注册失败 ${victim.status}`, victim.raw);
      state.facts.victim = { token: victim.body.data.token, publicId: victim.body.data.publicId };
      state.facts.tokens[state.facts.victim.publicId] = state.facts.victim.token;
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
      expect(Array.isArray(d.slots) && d.slots.length === 3, `D-159：注册即建满 3 槽，实得 ${d.slots && d.slots.length}`, me.raw);
      expect(d.slots[0].slotId === 'slot1' && d.slots[0].isDefault === true
        && d.slots.filter((x) => x.isDefault === true).length === 1, 'slot1 且仅 slot1 为默认配置', me.raw);
      expect(typeof d.slots[0].snapshotHash === 'string', 'slot1 已有冻结快照（D-159 starter 出战配置）', me.raw);
      expect(d.slots[1].snapshotHash === null && d.slots[2].snapshotHash === null,
        'slot2/slot3 为**空槽**（无快照，D-160 允许非出战槽不完整）', me.raw);
      expect(d.activeSlotId === 'slot1', `出战槽应为 slot1，实得 ${d.activeSlotId}`, me.raw);
      expect(typeof d.record.unread.attack === 'number' && typeof d.record.unread.defense === 'number', '/me 应含 unread 计数', me.raw);
      expect(!me.raw.includes('pl_'), '/me 不得回带 playerId（§4.5）', me.raw);
      // D-159：仓库为服务端权威（真源）——注册即发放 starter 且**已装配**（1 角色 + 3 技能 + ≥1 角色插件 + 1 技能插件）
      const wh = await warehouseOf(port, state.facts.A.token, 'A');
      expect(wh.starterIssued === true, 'A 的 starter 应已发放（starterIssued=true）', short(wh ? j(wh.counts) : '', 200));
      expect(wh.counts.role === 1 && wh.counts.skill === 3 && wh.counts.rolePlugin >= 1 && wh.counts.skillPlugin === 1,
        `starter 应为 1 角色 + 3 技能 + 1~2 角色插件 + 1 技能插件，实得 ${j(wh.counts)}`, j(wh.counts));
      const whEquipped = wh.buckets.rolePlugin.concat(wh.buckets.skillPlugin).filter((p) => p.equipped === true).length;
      expect(whEquipped >= 2, `starter 的插件应**已装配**进槽（equipped=true ≥2），实得 ${whEquipped}`, j(wh.counts));
      const cfg0 = await request(port, 'GET', '/api/v1/me/configs', undefined, authed(state.facts.A.token));
      expect(cfg0.status === 200 && cfg0.body.data.unverifiedLoadout === false,
        'D-159：新号 flags.unverifiedLoadout 应为 false', cfg0.raw);
      const activeLd = cfg0.body.data.slots.find((x) => x.slotId === cfg0.body.data.activeSlotId).loadout;
      expect(activeLd && activeLd.role && Array.isArray(activeLd.skills) && activeLd.skills.length === 3
        && activeLd.skills.every((x) => x) && activeLd.ai,
        'slot1 的 starter 出战配置必须完整（角色 + 恰 3 技能 + AI）', short(cfg0.raw, 300));
      okLine(3, 'GET /me 鉴权与字段', `401 unauthorized / 401（坏 token）/ 401 session_expired / 200 {publicId:${d.publicId}, tier:${d.progress.tier}, points:${d.rating.points}, slots:${d.slots.length}（slot1 完整出战 + slot2/3 空槽）, unread:${j(d.record.unread)}}；GET /me/warehouse 真源 starterIssued=true，buckets=${j(wh.counts)}，已装配插件 ${whEquipped} 个`);
      return `tier=${d.progress.tier} points=${d.rating.points} slots=${d.slots.length} starter=${j(wh.counts)}`;
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

    /* ---- [5/22] 服务端权威仓库：开箱 → 装配 → 真源校验；PUT 退役为只校验形状 ---- */
    await step(5, 'POST /me/box → POST /me/warehouse/assemble（服务端权威，D-159/D-162）→ GET /me/warehouse 真源；PUT /me/warehouse 退役为只校验形状', async () => {
      const asmA = await openAndAssemble(port, state.facts.A.token, 'A', 1, 3);
      const asmB = await openAndAssemble(port, state.facts.B.token, 'B', 1, 3);
      state.facts.asmA = asmA;
      state.facts.asmB = asmB;

      // 真源形状与自洽性（D-159）
      const whA = asmA.warehouse;
      expect(whA.starterIssued === true, 'A 的 starterIssued 应为 true', j(whA.counts));
      expect(whA.caps.role === 500, `caps.role 应为 500，实得 ${whA.caps.role}`, j(whA.caps));
      expect(whA.counts.role === whA.buckets.role.length && whA.counts.skill === whA.buckets.skill.length
        && whA.counts.rolePlugin === whA.buckets.rolePlugin.length && whA.counts.skillPlugin === whA.buckets.skillPlugin.length,
        'counts 必须与四桶长度逐项一致', j({ counts: whA.counts }));
      expect(whA.usage && typeof whA.usage === 'object'
        && Object.values(whA.usage).every((v) => v && Array.isArray(v.slotIds)),
        'usage 应为 {uid:{slotIds:[]}}（D-159 契约）', short(j(whA.usage), 300));
      expect(whA.counts.role >= 1 && whA.counts.skill >= 3,
        `真源应备齐 1 角色 + 3 技能（starter + 开箱），实得 ${j(whA.counts)}`);

      // 装配真的落档：equipped=true 的插件数 = 装配前 + 本次装配成功数
      expect(asmA.equippedAfter === asmA.equippedBefore + asmA.placed.length,
        `装配落档：equipped ${asmA.equippedBefore} + 成功 ${asmA.placed.length} ≠ ${asmA.equippedAfter}`, j(asmA.skipped));
      expect(asmA.placed.length > 0, `本步必须真的装配成功过（实测 ${asmA.placed.length} 处）`, `skipped=${j(asmA.skipped)}`);
      // 引用齐备：出战材料（角色[0] + 技能[0..2]）引用的每个插件都在真源里且 equipped=true
      const materialRefs = [];
      for (const item of [whA.buckets.role[0]].concat(whA.buckets.skill.slice(0, 3))) {
        for (const s of item.slots || []) if (s && s.pluginUid) materialRefs.push(s.pluginUid);
      }
      expect(materialRefs.length > 0, 'A 的出战材料应含真实装配引用（否则后续"含插件出战"会空转）', j(whA.counts));
      const allA = whA.buckets.role.concat(whA.buckets.skill, whA.buckets.rolePlugin, whA.buckets.skillPlugin);
      for (const uid of materialRefs) {
        const hit = allA.find((x) => x.uid === uid);
        expect(hit && hit.equipped === true, `引用 ${uid} 必须在真源里 equipped=true (D-159)`, j(whA.counts));
      }

      // D-159：PUT /me/warehouse **退役为只做形状校验**（不再 409；引用不覆盖出战配置 → 200 + verified:false）
      const badShape = await request(port, 'PUT', '/api/v1/me/warehouse', { warehouse: { buckets: 'nope' } }, authed(state.facts.A.token));
      expect(badShape.status === 400 && badShape.body.error.code === 'bad_request',
        `形状非法仍应 400 bad_request，实得 ${badShape.status} ${j(badShape.body.error)}`, badShape.raw);
      const uncovered = await request(port, 'PUT', '/api/v1/me/warehouse', { warehouse: itemsCore.emptyWarehouse() }, authed(state.facts.A.token));
      expect(uncovered.status === 200,
        `形状合法但引用不覆盖出战配置 → 200（D-159 起不再 409），实得 ${uncovered.status}`, uncovered.raw);
      expect(uncovered.body.data.saved === true && uncovered.body.data.verified === false,
        'PUT 退役语义：saved:true + verified:false', short(uncovered.raw, 300));
      const putTruth = await request(port, 'PUT', '/api/v1/me/warehouse', { warehouse: whA }, authed(state.facts.A.token));
      expect(putTruth.status === 200 && putTruth.body.data.verified === true,
        `提交**真源**应 verified:true，实得 ${putTruth.status} ${j(putTruth.body.data)}`, putTruth.raw);
      expect(typeof putTruth.body.data.warehouseHash === 'string' && putTruth.body.data.warehouseHash !== uncovered.body.data.warehouseHash,
        'warehouseHash 为内容寻址（真源 ≠ 空仓）', short(putTruth.raw, 200));
      const putTruth2 = await request(port, 'PUT', '/api/v1/me/warehouse', { warehouse: whA }, authed(state.facts.A.token));
      expect(putTruth2.body.data.warehouseHash === putTruth.body.data.warehouseHash,
        '同正文两次 PUT → 同 warehouseHash（内容寻址稳定）', short(putTruth2.raw, 200));
      const whAfter = await warehouseOf(port, state.facts.A.token, 'A');
      expect(j(whAfter.counts) === j(whA.counts),
        'PUT 镜像不改变真源（服务端权威，D-159）', j({ before: whA.counts, after: whAfter.counts }));
      const cfgAfter = await request(port, 'GET', '/api/v1/me/configs', undefined, authed(state.facts.A.token));
      expect(cfgAfter.body.data.unverifiedLoadout === false,
        '不覆盖的镜像不得把档案标成 unverifiedLoadout', cfgAfter.raw);
      okLine(5, '服务端权威仓库（开箱 → 装配 → 真源 + PUT 退役）', `A：POST /me/box ${asmA.rounds} 轮（${asmA.opened.length} 件入档，grantId 校验通过）→ 装配成功 ${asmA.placed.length} 处（equipped ${asmA.equippedBefore}→${asmA.equippedAfter}）；B：${asmB.rounds} 轮/${asmB.placed.length} 处；真源 buckets=${j(whA.counts)} caps=${j(whA.caps)} starterIssued=true；出战材料引用 ${materialRefs.length} 处全部 equipped=true；PUT：非法形状 → 400 bad_request；空仓镜像 → 200 verified:false（不再 409）；真源镜像 → 200 verified:true 且 hash 稳定、真源不被镜像改写`);
      return `A 装配 ${asmA.placed.length} 处 / 真源 ${j(whA.counts)}`;
    });

    /* ---- [6/22] 配置槽规则（D-159 注册即 3 槽；D-160 完整性校验时机） ---- */
    await step(6, '配置槽：注册即 3 槽（slot1 完整出战 / slot2·3 空槽）→ 第 4 槽 409 slot_limit → 空槽激活 409 cannot_activate_incomplete → 完整后激活 200 → 删出战槽 409 slot_locked', async () => {
      const A = authed(state.facts.A.token);
      const me0 = await request(port, 'GET', '/api/v1/me', undefined, A);
      expect(me0.body.data.slots.length === 3, `D-159：注册即建满 3 槽，实得 ${me0.body.data.slots.length}`, me0.raw);
      expect(me0.body.data.slots[0].slotId === 'slot1' && me0.body.data.slots[0].isDefault === true,
        '注册即默认配置（slot1 = 默认配置，D-131 的唯一出战语义不变）', me0.raw);
      expect(me0.body.data.slots[1].snapshotHash === null && me0.body.data.slots[2].snapshotHash === null,
        'slot2/slot3 是空槽（无快照，D-160）', me0.raw);

      // D-160：非出战槽允许写**不完整**配置 → 200 + snapshot:null + complete:false + missing[...]
      const partial = { role: null, skills: [null, null, null], ai: null };
      const putPartial2 = await request(port, 'PUT', '/api/v1/me/configs/slot2', { loadout: partial }, A);
      expect(putPartial2.status === 200, `非出战槽写不完整配置应 200，实得 ${putPartial2.status}`, putPartial2.raw);
      expect(putPartial2.body.data.complete === false && putPartial2.body.data.snapshot === null,
        '非出战槽不完整 → complete:false 且**不冻结快照**', short(putPartial2.raw, 300));
      expect(Array.isArray(putPartial2.body.data.missing) && putPartial2.body.data.missing.length === 5,
        `missing 应逐位置列出 5 个缺项（role + skills[0..2] + ai），实得 ${j(putPartial2.body.data.missing)}`, putPartial2.raw);
      // D-160：**出战槽**写不完整 → 409 loadout_invalid（details 逐位置文案）
      const putPartial1 = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: partial }, A);
      expect(putPartial1.status === 409 && putPartial1.body.error.code === 'loadout_invalid',
        `出战槽写不完整应 409 loadout_invalid，实得 ${putPartial1.status} ${j(putPartial1.body.error)}`, putPartial1.raw);
      const msgs = putPartial1.body.error.details.map((x) => x.message).join('|');
      expect(/缺少角色物品/.test(msgs) && /技能位置缺失: 1/.test(msgs) && /缺少 AI 程序/.test(msgs),
        `details 应逐位置说明缺项（含"缺少角色物品"/"技能位置缺失: 1"/"缺少 AI 程序"），实得 ${msgs}`, putPartial1.raw);
      // D-160：**激活时**才校验完整性 → 不完整槽激活 409 cannot_activate_incomplete
      const actEmpty = await request(port, 'POST', '/api/v1/me/configs/slot2/activate', {}, A);
      expect(actEmpty.status === 409 && actEmpty.body.error.code === 'cannot_activate_incomplete',
        `激活不完整槽应 409 cannot_activate_incomplete，实得 ${actEmpty.status} ${j(actEmpty.body.error)}`, actEmpty.raw);
      // 3 槽已满 → 新建 409 slot_limit（D-160：POST /me/configs 建**空槽**，不再复制出战配置）
      const c3 = await request(port, 'POST', '/api/v1/me/configs', { name: '第四套' }, A);
      expect(c3.status === 409 && c3.body.error.code === 'slot_limit', `第 4 槽应 409 slot_limit，实得 ${c3.status} ${j(c3.body.error)}`, c3.raw);
      // 删掉空槽 → 再建：新槽必须仍是**空槽**（snapshot:null、loadout 空），且复用槽号
      const del3 = await request(port, 'DELETE', '/api/v1/me/configs/slot3', undefined, A);
      expect(del3.status === 200 && del3.body.data.deleted === 'slot3', `非出战空槽应可删（200），实得 ${del3.status}`, del3.raw);
      const c1 = await request(port, 'POST', '/api/v1/me/configs', { name: '第三套' }, A);
      expect(c1.status === 200, `删除后重建第 3 槽应 200，实得 ${c1.status}`, c1.raw);
      expect(c1.body.data.snapshot === null && c1.body.data.slot && c1.body.data.slot.loadout
        && c1.body.data.slot.loadout.role === null,
        'D-160：POST /me/configs 建空槽（snapshot:null + 空 loadout），不再复制出战配置', short(c1.raw, 300));
      expect(c1.body.data.slotId === 'slot3', `空出的槽号应复用为 slot3，实得 ${c1.body.data.slotId}`, c1.raw);

      // 出战配置来自真实开箱物品（**服务端权威真源**），装配引用（pluginUid）原样保留
      const ldA = scriptedLoadout(state.facts.asmA.warehouse, false); // A：正常 hp（用于 /panel ≡ buildPanel）
      const ldB = scriptedLoadout(state.facts.asmB.warehouse, false);
      state.facts.ldA = ldA;
      state.facts.pluginRefsA = pluginRefsOf(ldA);
      state.facts.pluginRefsB = pluginRefsOf(ldB);
      expect(state.facts.pluginRefsA > 0,
        `A 的出战配置必须含真实装配引用（实测 ${state.facts.pluginRefsA} 处）——为 0 则第 7/11 步的"含插件出战"验收会空转`,
        `placed=${j(state.facts.asmA.placed)}`);
      expect(state.facts.pluginRefsB > 0,
        `B 的出战配置必须含真实装配引用（实测 ${state.facts.pluginRefsB} 处）`,
        `placed=${j(state.facts.asmB.placed)}`);
      const save = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: ldA, warehouse: state.facts.asmA.warehouse }, A);
      expect(save.status === 200, `PUT /me/configs/slot1 应 200，实得 ${save.status}`, save.raw);
      expect(typeof save.body.data.snapshot.hash === 'string' && save.body.data.complete === true && save.body.data.missing.length === 0,
        '保存出战配置应冻结新快照且 complete:true/missing:[]', short(save.raw, 300));
      const saveB = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: ldB, warehouse: state.facts.asmB.warehouse }, authed(state.facts.B.token));
      expect(saveB.status === 200, `PUT /me/configs/slot1（B）应 200，实得 ${saveB.status}`, saveB.raw);
      // D-163：**一件物品同时只能被一份配置引用** —— 把 ldA 原样再写进 slot2 必须被拒（可读文案 + 逐 uid）
      const dupTry = await request(port, 'PUT', '/api/v1/me/configs/slot2', { loadout: ldA }, A);
      expect(dupTry.status === 409 && dupTry.body.error.code === 'item_in_use',
        `D-163：把已在 slot1 使用的物品再写进 slot2 应 409 item_in_use，实得 ${dupTry.status} ${j(dupTry.body.error)}`, dupTry.raw);
      expect(Array.isArray(dupTry.body.error.details) && dupTry.body.error.details.length > 0
        && dupTry.body.error.details.every((d) => typeof d.path === 'string' && /已被配置/.test(d.message)),
        'D-163：item_in_use 必须逐 uid 给出 details（并写明占用它的配置）', short(dupTry.raw, 200));
      // 独占规则下：slot2 用**另一套**物品。开箱产物未必凑得出第二套（实测 roles=6 / skills=4），
      //   故按 D-163 的"物品必须真实存在于服务端仓库"口径**注入一套备用品**（与 tests/unit/* 的夹具同法），
      //   再只通过 PUT 端点把它写成配置。
      const spareSrc = {
        role: state.facts.asmA.warehouse.buckets.role[0],
        skills: state.facts.asmA.warehouse.buckets.skill.slice(0, 3),
      };
      const spare = { roleUid: 'e2e_spare_role', skillUids: ['e2e_spare_skill0', 'e2e_spare_skill1', 'e2e_spare_skill2'] };
      await s.store.updateArchive(state.facts.A.playerId, (archive) => {
        const cloneInto = (bucket, src, uid) => {
          if (archive.warehouse.buckets[bucket].some((x) => x.uid === uid)) return;
          archive.warehouse.buckets[bucket].push(Object.assign({}, JSON.parse(JSON.stringify(src)), {
            uid,
            slots: (src.slots || []).map((sl) => ({ type: sl.type, pluginUid: null })), // 备用件不带装配引用
          }));
        };
        cloneInto('role', spareSrc.role, spare.roleUid);
        spareSrc.skills.forEach((sk, i) => cloneInto('skill', sk, spare.skillUids[i]));
        return null;
      });
      const whAfter = (await request(port, 'GET', '/api/v1/me/warehouse', undefined, A)).body.data;
      const ldA2 = JSON.parse(JSON.stringify({
        role: findItem(whAfter, spare.roleUid),
        skills: spare.skillUids.map((u) => findItem(whAfter, u)),
        ai: HOLD_RIGHT,
      }));
      expect(ldA2.role !== null && ldA2.skills.every((x) => x !== null),
        'D-163：备用物品应已入服务端仓库（配置只能引用仓库里真实存在的物品）', short(j(spare), 200));
      const saveOn2 = await request(port, 'PUT', '/api/v1/me/configs/slot2', { loadout: ldA2 }, A);
      expect(saveOn2.status === 200 && typeof saveOn2.body.data.snapshot.hash === 'string',
        `slot2 写入完整配置应 200 并冻结快照，实得 ${saveOn2.status}`, saveOn2.raw);
      const act = await request(port, 'POST', '/api/v1/me/configs/slot2/activate', {}, A);
      expect(act.status === 200 && act.body.data.activeSlotId === 'slot2', `激活 slot2 应 200 且 activeSlotId=slot2，实得 ${act.status}`, act.raw);
      expect(typeof act.body.data.activeSnapshotHash === 'string', '激活应同步 activeSnapshotHash', act.raw);

      const lockedDel = await request(port, 'DELETE', '/api/v1/me/configs/slot2', undefined, A);
      expect(lockedDel.status === 409 && lockedDel.body.error.code === 'slot_locked', `删出战槽应 409 slot_locked，实得 ${lockedDel.status} ${j(lockedDel.body.error)}`, lockedDel.raw);
      const back = await request(port, 'POST', '/api/v1/me/configs/slot1/activate', {}, A);
      expect(back.status === 200 && back.body.data.activeSlotId === 'slot1', '切回 slot1', back.raw);
      const del = await request(port, 'DELETE', '/api/v1/me/configs/slot2', undefined, A);
      expect(del.status === 200 && del.body.data.deleted === 'slot2', `非出战槽应可删（200），实得 ${del.status}`, del.raw);
      const delDefault = await request(port, 'DELETE', '/api/v1/me/configs/slot1', undefined, A);
      expect(delDefault.status === 409 && delDefault.body.error.code === 'slot_locked', `默认槽不可删（409 slot_locked），实得 ${delDefault.status}`, delDefault.raw);

      const noAuth = await request(port, 'POST', '/api/v1/me/configs', { name: 'x' });
      expect(noAuth.status === 401, `未鉴权新建槽应 401，实得 ${noAuth.status}`, noAuth.raw);
      okLine(6, '配置槽规则', `注册即 3 槽（slot1 完整出战/slot2·3 空槽）→ 非出战槽写不完整 200(complete:false, missing×5) / 出战槽写不完整 409 loadout_invalid（逐位置文案）→ 空槽激活 409 cannot_activate_incomplete → 3 槽满再建 409 slot_limit → 删空槽后重建为**空槽**（snapshot:null）→ 完整配置写入并激活 slot2（activeSlotId/activeSnapshotHash 同步）→ 删出战槽 409 slot_locked → 切回后可删 → 默认槽 409 slot_locked；未鉴权 401；A/B 出战配置各含**真实装配引用** ${state.facts.pluginRefsA}/${state.facts.pluginRefsB} 处（未剥离 pluginUid）`);
      return 'slot_limit / cannot_activate_incomplete / slot_locked / 唯一出战全中';
    });

    /* ---- [7/22] 装配后 POST /panel ≡ buildPanel（真仓库镜像） ---- */
    await step(7, '装配后 POST /panel 与单测 buildPanel 逐值一致（真镜像聚合；去 warehouse 必 missing_warehouse）', async () => {
      // 含装配引用的配置必须带**真仓库镜像**才能校验/聚合（P1-3 / T-PB-9）——这正是旧 D1 适配想回避的路径
      const pan = await request(port, 'POST', '/api/v1/panel',
        { loadout: state.facts.ldA, warehouse: state.facts.asmA.warehouse, tier: MODE });
      expect(pan.status === 200, `POST /panel（含装配引用 + 真仓库镜像）应 200，实得 ${pan.status}`, pan.raw);
      const local = loadoutApi.buildPanel(state.facts.ldA, { warehouse: state.facts.asmA.warehouse, tier: MODE });
      expect(local.ok === true, '单测 buildPanel（同一镜像）应通过', j(local.errors));
      expect(j(pan.body.data.panel) === j(local.panel), 'HTTP /panel 与单测 buildPanel 必须逐值一致', `${short(j(pan.body.data.panel), 400)} VS ${short(j(local.panel), 400)}`);
      // 反证（防"引用被剥离后空转"）：同一配置去掉 warehouse 必须如实 missing_warehouse
      const noWh = loadoutApi.buildPanel(state.facts.ldA, { warehouse: null, tier: MODE });
      expect(noWh.ok === false && noWh.errors.some((e) => e.code === 'missing_warehouse'),
        '反证：本配置确实含装配引用（去掉 warehouse 必报 missing_warehouse）→ 第 7 步不是空断言', j(noWh.errors));
      expect(pluginRefsOf(state.facts.ldA) === state.facts.pluginRefsA && state.facts.pluginRefsA > 0,
        '本步使用的配置必须仍是"含装配引用"的那一份（引用数不得被中途剥离）');
      const st = pan.body.data.panel.role.stats;
      // 装配链路的独立证据：真源里确实产生了 equipped=true 的插件（走 POST /me/warehouse/assemble；
      //   starter 本身也带已装配插件，故基线是 equippedBefore，而不是 0）
      const equipped = state.facts.asmA.warehouse.buckets.rolePlugin.concat(state.facts.asmA.warehouse.buckets.skillPlugin).filter((p) => p.equipped === true);
      expect(equipped.length === state.facts.asmA.equippedAfter,
        `真源里 equipped=true 的插件应为 ${state.facts.asmA.equippedAfter} 个，实得 ${equipped.length}`);
      expect(equipped.length === state.facts.asmA.equippedBefore + state.facts.asmA.placed.length,
        `equipped ${state.facts.asmA.equippedBefore}（starter）+ 装配成功 ${state.facts.asmA.placed.length} ≠ ${equipped.length}`);
      okLine(7, 'POST /panel ≡ buildPanel（真镜像）', `五维 hp${st.hp}/atk${st.atk}/def${st.def}/sp${st.sp}/mp${st.mp}；技能参数 ${pan.body.data.panel.skills.length} 条；与单测逐值一致；真源 equipped=true 插件 ${equipped.length} 个（= starter ${state.facts.asmA.equippedBefore} + 本次装配 ${state.facts.asmA.placed.length}）；配置含真实装配引用 ${state.facts.pluginRefsA} 处（去掉 warehouse 必 missing_warehouse → 反证引用为真）`);
      return `hp=${st.hp} atk=${st.atk} def=${st.def} refs=${state.facts.pluginRefsA}`;
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
      const solo = await registerPlayer(port, 'e2e_solo_4');
      expect(solo.status === 200 || solo.status === 201, `独狼注册失败 ${solo.status}`, solo.raw);
      const soloToken = solo.body.data.token;
      const soloId = await playerIdByPublicId(s.store, solo.body.data.publicId);
      state.facts.solo = { token: soloToken, publicId: solo.body.data.publicId, playerId: soloId };
      state.facts.tokens[state.facts.solo.publicId] = soloToken;
      expect(state.facts.solo.playerId === null || typeof state.facts.solo.playerId === 'string', '独狼档案应可回查', solo.raw);

      const r = await request(port, 'POST', '/api/v1/quick/run', {}, authed(soloToken));
      // 池中此刻只有 A/B（0 分或刚打完 1 场）——若窗口命中则必须抽真实档案；否则必须如实拒配。
      if (r.status === 200) {
        await assertReal(s.store, [state.facts.solo.publicId, r.body.data.opponent.publicId], 'quick/run(池空分支)');
        expect(r.body.data.opponent.isBot === false, '对手不得是 bot', r.raw);
        state.facts.quickBattles.push(r.body.data.battleId);
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
      // 剧本：让 A 必败。D-163 起**客户端改数值会被丢弃**（物品一律按 uid 从服务端仓库解析）⇒
      //   "脆弱一方"必须真的在仓库里：注入一件 hp=1/atk=0 的角色物品（无插件），再用它构造配置。
      const spareRole = state.facts.asmA.warehouse.buckets.role[1] || state.facts.asmA.warehouse.buckets.role[0];
      const fragileUid = `${spareRole.uid}_fragile`;
      await s.store.updateArchive(state.facts.A.playerId, (archive) => {
        if (!archive.warehouse.buckets.role.some((x) => x.uid === fragileUid)) {
          archive.warehouse.buckets.role.push(Object.assign({}, JSON.parse(JSON.stringify(spareRole)), {
            uid: fragileUid, name: '脆弱角色（e2e 夹具）',
            stats: { hp: 1, atk: 0, def: 0, sp: 60, mp: 40 },
            slots: (spareRole.slots || []).map((sl) => ({ type: sl.type, pluginUid: null })),
          }));
        }
        return null;
      });
      const fragileWh = (await request(port, 'GET', '/api/v1/me/warehouse', undefined, authed(state.facts.A.token))).body.data;
      const fragileRole = findItem(fragileWh, fragileUid);
      const fragileA = JSON.parse(JSON.stringify({
        role: fragileRole,
        skills: state.facts.asmA.warehouse.buckets.skill.slice(0, 3),
        ai: HOLD_RIGHT,
      }));
      expect(fragileRole !== null && fragileRole.stats.hp === 1,
        `应能从服务端仓库读到脆弱角色（hp=1）；实得 ${fragileRole ? j(fragileRole.stats) : 'null'}`, short(j({ fragileUid }), 200));
      const saveFragile = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: fragileA }, authed(state.facts.A.token));
      expect(saveFragile.status === 200, `剧本配置（A 1hp，仓库真值）应保存成功，实得 ${saveFragile.status}`, saveFragile.raw);
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
      // 真的跑起来了（不是 buildPlayer 失败退化成 0 tick 的 invalid 空局）
      expect(Number.isInteger(d.ticks) && d.ticks > 0,
        `对局必须真的跑起来：ticks=${d.ticks}（0 通常意味着某方 buildPlayer 失败 → invalid 空局）`, j(d));
      /* ⭐ 本脚本最有价值的端到端验收：**含装配插件的配置真的打完了一整场对局**（旧 D1 缺陷的回归钉）。
       * ⚠️ 抽池可控性（2026-09-19 复审修正）：本场**发起者固定 = B**（`authed(B.token)`），其第 6 步快照
       *    含真实装配引用 → **必然**进入本场战斗，故把"含装配引用能出战"的判定**锚在发起者侧**（确定性）；
       *    被抽中的对手是池内任意真实玩家（默认配置者 0 处引用）——对手侧按**实际抽中结果**分支核验，
       *    绝不假设"抽中的一定是 A"（旧写法假定了这点：抽到默认配置玩家就会假红/间歇红）。
       * 判定链由 `verifyPluginSide` 统一实现（引用为真 + 缺口 1 持久化 + 面板 ≡ 真镜像 + 去 warehouse 反证）。
       */
      const selfSide = await verifyPluginSide(s.store, '发起者 B（本场 p1，确定性进入战斗）',
        state.facts.B.playerId, await liveWarehouseOf(port, state.facts.B.token), MODE);
      const foeIdA = await playerIdByPublicId(s.store, d.opponent.publicId);
      const foeIsA = d.opponent.publicId === state.facts.A.publicId;
      // 对手侧：抽中 A（夹具里唯一另一个持装配引用的玩家）→ 同样做全链核验；抽中默认配置玩家 → 如实记录
      const foeSide = foeIsA
        ? await verifyPluginSide(s.store, `对手 A（本场 p2，publicId=${state.facts.A.publicId}）`, foeIdA,
          await liveWarehouseOf(port, state.facts.A.token), MODE)
        : null;
      const foeSnap = foeIsA ? null : (await activeSnapshotOf(s.store, foeIdA)).snap;
      const foeNote = foeSide
        ? `抽中对手 = A → **双方**快照均含真实装配引用（A ${foeSide.refs} / B ${selfSide.refs} 处，镜像片段 ${foeSide.whItems}/${selfSide.whItems} 项），两侧面板均 ≡ 完整真镜像`
        : `抽中对手 = ${d.opponent.publicId}（默认配置：${pluginRefsOf(foeSnap.loadout)} 处装配引用）→ 抽池不受控，本项验收锚在**发起者 B**（${selfSide.refs} 处引用 / 镜像片段 ${selfSide.whItems} 项；面板 ≡ 真镜像 hp${selfSide.stats.hp}/atk${selfSide.stats.atk}/def${selfSide.stats.def}/sp${selfSide.stats.sp}/mp${selfSide.stats.mp}）`;
      state.facts.refs = { b: selfSide.refs, bWh: selfSide.whItems, foeIsA, aRefs: foeSide ? foeSide.refs : null };
      state.facts.quick1 = d;
      state.facts.quickBattles.push(d.battleId);
      okLine(11, 'quick/run 双方都是真实玩家（含装配插件出战 ✔）', `发起者 ${state.facts.B.publicId}(${state.facts.B.playerId}) vs 对手 ${d.opponent.publicId} → 档案库回查 OK（isBot=false，出战快照可用）；battleId=${d.battleId}；ticks=${d.ticks}>0；响应无 pl_；**${foeNote}**`);
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
      // 排位发起者固定 = A（`authed(A.token)`）→ A 必然作为 p1 进入本批次**每一场**对局。
      //   故这里做一次**确定性**的"含装配引用的一侧确实出战"核验（不依赖任何抽池结果）：
      //   若本批次 matches>0 而 A 的快照不含装配引用，那"含插件能出战"就没有被验证过。
      const rankedSide = await verifyPluginSide(s.store, '排位发起者 A（本批次每场 p1）',
        state.facts.A.playerId, await liveWarehouseOf(port, state.facts.A.token), MODE);
      const r = await request(port, 'POST', '/api/v1/ranked/run', { seed: 11 }, authed(state.facts.A.token));
      expect(r.status === 200, `排位应 200，实得 ${r.status}`, r.raw);
      const d = r.body.data;
      expect(d.requested === 10, `批次目标应为 10 场（D-122），实得 ${d.requested}`, r.raw);
      expect(d.matches <= d.requested, `matches ${d.matches} 不得超过 requested ${d.requested}`, r.raw);
      expect(d.shortfall === d.requested - d.matches, `shortfall 应等于缺口：${d.shortfall} ≠ ${d.requested - d.matches}`, r.raw);
      expect(d.wins + d.draws + d.losses + d.invalids === d.matches, '胜负平+invalid 应闭合到 matches', r.raw);
      // 含装配引用的配置不得在服务端悄悄退化成 invalid 场次（否则"能出战"是假绿）
      expect(d.invalids === 0,
        `含装配引用的配置出战不得产生 invalid 场次（实测 ${d.invalids} 场）——invalid 通常意味着 buildPlayer 失败`, j(d.results || d));
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
      okLine(14, 'ranked/run 抽池与 shortfall', `第 1 轮：matches=${d.matches} shortfall=${d.shortfall}（对手 ${foes.join(',')} 全部回查档案库 OK，未抽自己）invalid=${d.invalids}；第 2 轮：matches=${r2.body.data.matches} shortfall=${r2.body.data.shortfall} → 24h 去重生效，**未用 bot 凑满 10 场**（D-152）；发起者 A 的配置含真实装配引用 ${rankedSide.refs} 处（镜像片段 ${rankedSide.whItems} 项，面板 ≡ 真镜像 hp${rankedSide.stats.hp}/sp${rankedSide.stats.sp}）→ 0 场 invalid`);
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
        // 防守战绩视图：夹具持有 token 时走 HTTP（端点），否则退回档案层同一视图
        const view = await defenseViewOf(port, s.store, publicId);
        const defData = view.data;
        const tierOfFoe = view.tier;
        let pointsOfFoe = view.points;
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
      okLine(15, '发起者同步结算 / 防守方离线记账', `发起者 batchesPlayed=${meA.body.data.progress.batchesPlayed}、排位战绩 ${rankedRecA.length} 条、积分 ${meA.body.data.rating.points}（排位不改分）；防守方 ${defenses.map((x) => `${x.publicId}:drawn=${x.drawnCount},tier=${x.tier},points=${x.pointsBefore}→${x.points}`).join(' ')} → 不掉段不掉分`);
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
      // 主体 = 本批次**实际被抽中的对手** ∪ {发起者 A, B, CLI 玩家}
      const subjects = [
        { tag: 'A（本批次发起者，未被抽）', publicId: state.facts.A.publicId },
        { tag: 'B', publicId: state.facts.B.publicId },
        { tag: 'CLI 玩家', publicId: state.facts.cliPlayer.publicId },
      ];
      for (const publicId of state.facts.ranked1.results.map((m) => m.opponentPublicId)) {
        if (!subjects.some((x) => x.publicId === publicId)) subjects.push({ tag: `排位对手`, publicId });
      }
      const views = [];
      for (const subj of subjects) {
        const view = await defenseViewOf(port, s.store, subj.publicId);
        const x = view.data;
        expect(x.stats && typeof x.stats.wins === 'number' && typeof x.stats.losses === 'number' && typeof x.stats.draws === 'number', `应含胜负平统计（${subj.tag}）`, j(x));
        expect(x.stats.wins + x.stats.losses + x.stats.draws === x.drawnCount, `胜负平应闭合到被抽场次（${subj.tag}）`, j(x));
        expect(Array.isArray(x.recent), `应含最近列表（${subj.tag}）`, j(x));
        expect(typeof x.unread === 'number', `应含未读计数（${subj.tag}）`, j(x));
        expect(!j(x).includes('pl_'), `防守战绩不得回带 playerId（${subj.tag}）`, j(x));
        views.push({ ...subj, data: x, via: view.via });
      }
      // 本批次真实被抽中的防守方：字段完整性 + 最近一条可回查对手
      const drawn = views.filter((v) => v.data.drawnCount >= 1);
      expect(drawn.length >= 1, `本排位批次至少应产生 1 名防守方记录，实得 ${views.map((v) => `${v.tag}:${v.data.drawnCount}`).join(' ')}`, views.map((v) => j(v.data)).join(' | '));
      const target = drawn[0];
      expect(target.data.recent.length >= 1, '被抽方应有 recent 列表', j(target.data));
      expect(typeof target.data.recent[0].battleId === 'string' && typeof target.data.recent[0].opponentPublicId === 'string', 'recent 应含 battleId/opponentPublicId', j(target.data));
      await assertReal(s.store, [target.data.recent[0].opponentPublicId], 'me/defense');
      // 未被抽中者的反向对照：drawnCount 必须为 0（不做无中生有的记录）
      for (const v of views.filter((x) => x.data.drawnCount === 0)) {
        expect(v.data.recent.length === 0 && v.data.unread === 0, `未被抽中者不得有防守记录（${v.tag}）`, j(v.data));
      }
      okLine(17, 'GET /me/defense 汇总', views.map((v) => `${v.tag} drawn=${v.data.drawnCount} w/l/d=${v.data.stats.wins}/${v.data.stats.losses}/${v.data.stats.draws} unread=${v.data.unread}`).join('；') + (target.data.recent[0] ? `；被抽方 recent[0]={battleId:${target.data.recent[0].battleId}, opponent:${target.data.recent[0].opponentPublicId}}（回查档案库 OK）` : ''));
      return `被抽方 ${drawn.map((v) => v.publicId).join(',')}`;
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
      // "非参与者"主体：注册 2 名全新玩家并**机器核对**其从未出现在任何 battle.recorded 记录里
      const fresh = [];
      for (let i = 0; i < 2; i++) {
        const p = await registerPlayer(port, `e2e_fresh_${7 + i}`, `旁观${i}`);
        expect(p.status === 200 || p.status === 201, `旁观玩家注册失败 ${p.status}`, p.raw);
        fresh.push({ token: p.body.data.token, publicId: p.body.data.publicId, playerId: await playerIdByPublicId(s.store, p.body.data.publicId) });
      }
      state.facts.fresh = fresh;
      const participants = await battleParticipants(s.store);
      const outsiderPlayer = fresh.find((x) => !participants.has(x.playerId));
      expect(outsiderPlayer !== undefined, `应存在从未参与对局的真实玩家（参与过对局者 ${participants.size} 人；本轮新注册 ${fresh.map((x) => x.playerId).join(',')}）`);
      const outsider = await request(port, 'GET', `/api/v1/replay/${d.battleId}`, undefined, authed(outsiderPlayer.token));
      expect(outsider.status === 403, `非参与者应 403（主体 ${outsiderPlayer.publicId}，journal 里无任何对局记录），实得 ${outsider.status}`, outsider.raw);
      expect(outsider.body.error.code === 'replay_forbidden', `非参与者错误码应为 replay_forbidden，实得 ${j(outsider.body.error)}`, outsider.raw);

      const foeId = await playerIdByPublicId(s.store, d.opponent.publicId);
      const mineArch = await s.store.loadArchive(state.facts.B.playerId);
      const mineSlot = mineArch.configs.slots.find((x) => x.slotId === mineArch.configs.activeSlotId);
      const defeatedB = await s.store.settleBattle({
        mode: 'quick', seed: 987655, at: Date.now(),
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
      const goneId = defeatedB.record.battleId;
      const gone = await request(port, 'GET', `/api/v1/replay/${goneId}`, undefined, authed(state.facts.B.token));
      expect(gone.status === 410, `快照缺失的归档回放应 410，实得 ${gone.status}`, gone.raw);
      expect(gone.body.error.code === 'replay_expired', `410 错误码应为 replay_expired，实得 ${j(gone.body.error)}`, gone.raw);
      expect(/snapshot_gc|engine_mismatch|data_mismatch/.test(gone.body.error.message), `410 消息应带失效原因，实得 ${gone.body.error.message}`, gone.raw);
      const unknown = await request(port, 'GET', '/api/v1/replay/b_ffffffffffffffff', undefined, authed(state.facts.B.token));
      expect(unknown.status === 404 && unknown.body.error.code === 'unknown_replay', `未知回放应 404 unknown_replay，实得 ${unknown.status} ${j(unknown.body.error)}`, unknown.raw);

      /* ⭐ D-159-R1 回归（用户裁决 + server 侧修复）：保存出战配置时**完全不传 warehouse**
       *   （引用校验与快照的镜像片段全部由**服务端权威仓库**自解析）→ 真的打一场 → 归档回放重算必须 200。
       *   修前该路径 `buildPlayer` 拿不到仓库 → 410 replay_expired（"服务端仓库已含真源、客户端不再提交镜像" 的闭环证据）。
       */
      const regP = await registerPlayer(port, 'e2e_replay_8', '回归');
      expect(regP.status === 200 || regP.status === 201, `回归用例注册失败 ${regP.status}`, regP.raw);
      state.facts.replayPlayer = {
        token: regP.body.data.token, publicId: regP.body.data.publicId,
        playerId: await playerIdByPublicId(s.store, regP.body.data.publicId),
      };
      state.facts.tokens[state.facts.replayPlayer.publicId] = state.facts.replayPlayer.token;
      const noWhLoadout = scriptedLoadout(state.facts.asmB.warehouse, false);
      const noWhSave = await request(port, 'PUT', '/api/v1/me/configs/slot1', { loadout: noWhLoadout }, authed(state.facts.B.token));
      expect(noWhSave.status === 200 && typeof noWhSave.body.data.snapshot.hash === 'string',
        `不带 warehouse 保存出战配置应 200 并冻结快照，实得 ${noWhSave.status}`, noWhSave.raw);
      const noWhCfg = await request(port, 'GET', '/api/v1/me/configs', undefined, authed(state.facts.B.token));
      const noWhActive = noWhCfg.body.data.slots.find((x) => x.slotId === noWhCfg.body.data.activeSlotId);
      expect(noWhActive.snapshot && noWhActive.snapshot.verifiedAgainstWarehouse === true,
        'D-159：服务端权威仓库足以完成引用校验（verifiedAgainstWarehouse=true，无需客户端镜像）', short(noWhCfg.raw, 300));
      await clearOpponentHistory(s.store, state.facts.B.playerId);
      const regRun = await request(port, 'POST', '/api/v1/quick/run', { seed: 606061 }, authed(state.facts.B.token));
      expect(regRun.status === 200, `不带 warehouse 保存后的快速对战应 200（池中有真实候选），实得 ${regRun.status}`, regRun.raw);
      state.facts.quickBattles.push(regRun.body.data.battleId);
      const regRecord = await s.store.findBattleRecord(regRun.body.data.battleId);
      const regSnap1 = await s.store.snapshot.get(regRecord.p1.snapshotHash);
      const regRefs = pluginRefsOf(regSnap1.loadout);
      expect(regRefs > 0, `D-159-R1 的前提：该侧快照确实含装配引用（实测 ${regRefs} 处），否则回放不需要仓库`, short(noWhSave.raw, 300));
      const regReplay = await request(port, 'GET', `/api/v1/replay/${regRun.body.data.battleId}`, undefined, authed(state.facts.B.token));
      expect(regReplay.status === 200,
        `D-159-R1：不带 warehouse 保存的出战配置，归档回放重算必须 200（实得 ${regReplay.status} ${regReplay.body.error ? j(regReplay.body.error) : ''}）`, regReplay.raw);
      expect(regReplay.body.data.frames.length === regRun.body.data.ticks,
        `回放帧数应等于 ticks（${regRun.body.data.ticks}），实得 ${regReplay.body.data.frames.length}`, regReplay.raw);

      okLine(19, '回放鉴权与失效 + D-159-R1', `参与者 200（${mine.body.data.frames.length} 帧 = ticks ${d.ticks}）；未鉴权 401；非参与者 403 replay_forbidden；快照缺失归档 ${goneId} → 410 replay_expired（${gone.body.error.message}）；未知 id → 404 unknown_replay；**D-159-R1**：不带 warehouse 保存（含真实引用 ${regRefs} 处、verifiedAgainstWarehouse=true）→ quick/run 成场 → 归档回放重算 200（${regReplay.body.data.frames.length} 帧 = ticks）`);
      return '200/401/403/410/404 + D-159-R1 回归';
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
      const box = await request(port, 'POST', '/api/v1/box', { tier: MODE, times: 1 });
      expect(box.status === 200, `legacy box 应 200，实得 ${box.status}`, box.raw);
      const wh = await request(port, 'GET', '/api/v1/warehouse');
      expect(wh.status === 200, `legacy warehouse 应 200，实得 ${wh.status}`, wh.raw);
      // 遗留端点同样支持 body.warehouse（含装配引用时必需）——一并带上真镜像，保持"零回归"语义真实
      const lo = await request(port, 'POST', '/api/v1/loadout', { loadout: state.facts.ldA, warehouse: state.facts.asmA.warehouse, tier: MODE });
      expect(lo.status === 200, `legacy loadout 应 200，实得 ${lo.status}`, lo.raw);
      // 遗留 /battle 端点在"含装配引用"时同样需要仓库正文（单仓库 = 双方共用），故显式带上真镜像
      const bat = await request(port, 'POST', '/api/v1/battle', { p1: state.facts.ldA, p2: state.facts.ldA, warehouse: state.facts.asmA.warehouse, seed: 5, tier: MODE });
      expect(bat.status === 200, `legacy battle 应 200，实得 ${bat.status}`, bat.raw);
      expect(/^r\d+$/.test(bat.body.data.id), '遗留回放 id 应为 r<seq>', bat.raw);
      // 双方都是**含装配引用**的同一份配置（确定性：不依赖抽池）→ 必须真的跑完（ticks>0、帧数 == ticks）
      expect(Number.isInteger(bat.body.data.ticks) && bat.body.data.ticks > 0,
        `含装配引用的双方对战必须真的跑完（ticks=${bat.body.data.ticks}；0 通常意味着 buildPlayer 失败）`, short(bat.raw, 400));
      expect(Array.isArray(bat.body.data.frames) && bat.body.data.frames.length === bat.body.data.ticks,
        `回放帧数应等于 ticks（${bat.body.data.ticks}），实得 ${bat.body.data.frames && bat.body.data.frames.length}`, short(bat.raw, 300));
      const legacyReplay = await request(port, 'GET', `/api/v1/replay/${bat.body.data.id}`);
      expect(legacyReplay.status === 200, `遗留回放（无 token）应 200，实得 ${legacyReplay.status}`, legacyReplay.raw);

      const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-p7-5-e2e-off-'));
      let s2 = null;
      try {
        s2 = await serverMod.start({
          port: 0, dataDir: dir2, authConfig: FAST_AUTH, rateLimitPerMinute: RATE_LIMIT,
          env: { DL_DATA_DIR: dir2, DL_LEGACY_STATELESS: '0' },
          boxSeed: E2E_BOX_SEED, // D-162：同上（该实例只验 410 deprecated，保持口径一致）
        });
        // D-162：旧无状态开箱路径同样不设 seed 入参（旧写法 `{seed: 1}` 会被静默忽略）
        const off = await request(s2.port, 'POST', '/api/v1/box', {});
        expect(off.status === 410 && off.body.error.code === 'deprecated', `STATELESS=0 时旧端点应 410 deprecated，实得 ${off.status} ${j(off.body.error)}`, off.raw);
        const health2 = await request(s2.port, 'GET', '/api/v1/health');
        expect(health2.status === 200, '基础设施端点应保持可用', health2.raw);
      } finally {
        if (s2) await s2.close();
        fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
      }
      okLine(21, 'DL_LEGACY_STATELESS 兼容口径', `=1（默认）：box/warehouse/loadout/battle/replay(r…) 全 200 零回归（/battle 双方均为含装配引用的配置：ticks=${bat.body.data.ticks}>0、帧数=${bat.body.data.frames.length}）；=0（另起实例）：旧端点 410 deprecated、health 仍 200`);
      return 'legacy 零回归 + 410 deprecated';
    });

    /* ---- [22/22] 真实玩家快速对战 + CLI 闭环 ---- */
    await step(22, 'POST /quick/run（真实玩家对手）Elo 可复算；CLI auth/me/quick/leaderboard + 退出码 3 = 未鉴权', async () => {
      // 本步发起者 = 第 11 步已压到 1hp 的脆皮 A（确定性必败 → 双向 Δ 均非零）；
      // 注册一名全新真实玩家并清掉 A 的对手冷却，保证池内确有可用候选（等价 24h 已过）
      const init = await registerPlayer(port, 'e2e_elo_6', '埃洛');
      expect(init.status === 200 || init.status === 201, `Elo 用例注册失败 ${init.status}`, init.raw);
      const initPlayer = { token: init.body.data.token, publicId: init.body.data.publicId, playerId: await playerIdByPublicId(s.store, init.body.data.publicId) };
      expect(typeof initPlayer.playerId === 'string', '新玩家档案应可回查', init.raw);
      state.facts.eloPlayer = initPlayer;
      state.facts.tokens[initPlayer.publicId] = initPlayer.token;
      await clearOpponentHistory(s.store, state.facts.A.playerId);
      // 每一步的真实对局使用**互不相同**的 seed：quick 的 battleId 由 seed + 双方快照内容寻址（§9.1），
      // 跨步骤复用同 seed 会命中同一 battleId（幂等去重），使 Δ 落盘值与本次 winner 不一致（缺陷 D2）。
      const r = await request(port, 'POST', '/api/v1/quick/run', { seed: 777001 }, authed(state.facts.A.token));
      expect(r.status === 200, `A 的快速对战应 200（已清冷却，池中有真实候选），实得 ${r.status}`, r.raw);
      const d = r.body.data;
      state.facts.quickBattles.push(d.battleId);
      // 发起者固定 = A（其第 21 步刚恢复的配置含真实装配引用）→ 又一次**确定性**的"含插件能出战"核验
      const eloSide = await verifyPluginSide(s.store, '第 22 步发起者 A（本场 p1）',
        state.facts.A.playerId, await liveWarehouseOf(port, state.facts.A.token), MODE);
      expect(Number.isInteger(d.ticks) && d.ticks > 0,
        `含装配引用的 A 出战必须真的跑起来：ticks=${d.ticks}`, j(d));
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
      // 双向结算：赢家 Δ>0；输家 Δ ≤0（0 分玩家负场被下限保护为 0，§8.3 性质 4）——
      // 对手由服务端抽池决定，故不断言"脆皮必败"，只断言"落盘值 ≡ 公式 + 方向/有界正确"。
      const winnerDelta = d.winner === 'win' ? d.self.delta : d.winner === 'loss' ? d.opponent.delta : 0;
      const loserDelta = d.winner === 'win' ? d.opponent.delta : d.winner === 'loss' ? d.self.delta : 0;
      if (d.winner === 'draw') {
        expect(d.self.delta === 0 && d.opponent.delta === 0, '平局且同分时应双方 Δ=0（E=0.5）', j(d));
      } else {
        expect(winnerDelta > 0, `赢家 Δ 应 >0，实得 ${winnerDelta}（winner=${d.winner}）`, j(d));
        expect(loserDelta <= 0, `输家 Δ 应 ≤0，实得 ${loserDelta}（winner=${d.winner}）`, j(d));
      }
      // 0 分玩家负场的下限保护（§8.3 性质 4）：机器复算，不依赖本场实际结果。
      // 注意：`ratingDelta` 的 `delta` 是**未 clamp 的原始 Δ**，`pointsAfter` 才是下限保护后的结果；
      // 生产路径（quickmatch）回带的 `delta` 一律取"档案落盘值之差"，故 0 分负场显示 0。
      const zeroLoss = quickmatch.ratingDelta({ points: 0, opponentPoints: 0, result: 'loss', config: RATING });
      expect(zeroLoss.pointsAfter === 0, `0 分玩家输球结果积分应仍为 0，实得 ${zeroLoss.pointsAfter}`, j(zeroLoss));
      expect(zeroLoss.pointsAfter - 0 === 0, '0 分玩家负场的**落盘 Δ** 应为 0（clamp 保护）', j(zeroLoss));
      const foeToken = state.facts.tokens[d.opponent.publicId];
      expect(typeof foeToken === 'string', `缺少对手 ${d.opponent.publicId} 的会话 token（夹具应持有全部注册玩家）`);
      const foeMe = await request(port, 'GET', '/api/v1/me', undefined, authed(foeToken));
      expect(foeMe.status === 200, '对手档案可读', foeMe.raw);
      expect(foeMe.body.data.rating.points === d.opponent.pointsAfter,
        `对手积分应已落盘（双向结算）：档案 ${foeMe.body.data.rating.points} ≠ 响应 ${d.opponent.pointsAfter}`, foeMe.raw);

      // CLI：CLI 玩家（e2e_cli_5）自注册起未参与任何对局 → 其冷却窗口为空，quick 子命令确定性可打
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
      const login = await runCli(['auth', 'login', '--user', state.facts.cliPlayer.username, '--pass', PASSWORD]);
      expect(login.code === 0, `cli auth login 应退出码 0，实得 ${login.code}`, `${login.text}\n${login.err}`);
      const me = await runCli(['me', '--token', state.facts.cliPlayer.token]);
      expect(me.code === 0, `cli me 应退出码 0，实得 ${me.code}`, `${me.text}\n${me.err}`);
      expect(me.text.includes(state.facts.cliPlayer.publicId), 'cli me 输出应含自己的 publicId', me.text);
      const lb = await runCli(['leaderboard', '--limit', '100']);
      expect(lb.code === 0, `cli leaderboard 应退出码 0，实得 ${lb.code}`, `${lb.text}\n${lb.err}`);
      expect(lb.text.includes(state.facts.cliPlayer.publicId), 'cli leaderboard 输出应含榜单行', lb.text);
      const quick = await runCli(['quick', 'run', '--token', state.facts.cliPlayer.token, '--seed', '31415']);
      let cliQuickNote;
      if (quick.code === 0) {
        const cliData = JSON.parse(quick.text);
        await assertReal(s.store, [state.facts.cliPlayer.publicId, cliData.opponent.publicId], 'cli quick');
        expect(cliData.opponent.isBot === false, 'CLI 快速对战的对手不得是 bot', quick.text);
        cliQuickNote = `quick run→0（对手 ${cliData.opponent.publicId} 回查档案库 OK）`;
      } else {
        // 该玩家累计交战对手多、24h 去重后可能已无可用候选 → 必须如实 409 no_opponent（仍不得注入 bot）
        expect(quick.code === 1 && /no_opponent/.test(quick.err), `cli quick 若失败必须是 1 + no_opponent，实得 code=${quick.code} err=${short(quick.err, 200)}`, quick.err);
        cliQuickNote = `quick run→1（${short(quick.err, 80)}：池内真实候选已被 24h 去重清空，未注入 bot）`;
      }
      const cliDataForNote = quick.code === 0 ? JSON.parse(quick.text) : null;
      const sumBefore = d.self.pointsBefore + d.opponent.pointsBefore;
      const sumAfter = d.self.pointsAfter + d.opponent.pointsAfter;
      expect(sumBefore + d.self.delta + d.opponent.delta === sumAfter,
        `本场守恒式不成立：${sumBefore} + ${d.self.delta} + ${d.opponent.delta} ≠ ${sumAfter}`, j(d));
      okLine(22, 'quick/run（真实对手）+ CLI 闭环', `${state.facts.A.publicId} ${d.self.pointsBefore}→${d.self.pointsAfter}（Δ${d.self.delta}，含装配引用 ${eloSide.refs} 处、ticks=${d.ticks}>0）vs ${d.opponent.publicId} ${d.opponent.pointsBefore}→${d.opponent.pointsAfter}（Δ${d.opponent.delta}）双方 Δ ≡ 公式、方向正确、守恒式 ${sumBefore}+(${d.self.delta}${d.opponent.delta >= 0 ? '+' : ''}${d.opponent.delta})=${sumAfter} ✔、cap 未越界、对手档案已落盘；CLI：health→0，me 无 token→**3**，auth login→0，me→0，leaderboard→0，${cliQuickNote}${cliDataForNote ? '' : ''}`);
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
    out(`  · 结算对局：quick ${state.facts.quickBattles.length} 场 + ranked ${state.facts.ranked1.matches} 场；双方 playerId 全部落在上述真实档案内（0 个 bot）`);
    out('');
    out('✅ 服务端权威仓库 + 装配引用端到端（D-159/D-162）：第 5 步 POST /me/box 开箱 '
      + state.facts.asmA.opened.length + '（A）/' + state.facts.asmB.opened.length + '（B）件 → **真源入档**；'
      + 'POST /me/warehouse/assemble 装配成功 ' + state.facts.asmA.placed.length + ' 处（A）/ '
      + state.facts.asmB.placed.length + ' 处（B）；第 6 步出战配置**原样保留 pluginUid**（A/B 各 '
      + state.facts.pluginRefsA + '/' + state.facts.pluginRefsB + ' 处引用）。');
    out('   → 含装配引用的出战方逐条核验：快照 refs>0 + verifiedAgainstWarehouse=true + 正文持久化仓库镜像片段'
      + '（发起者 B ' + state.facts.refs.b + ' 处引用 / 片段 ' + state.facts.refs.bWh + ' 项；'
      + (state.facts.refs.foeIsA ? 'quick/run 抽中 A → 双方均为含插件配置' : 'quick/run 抽中默认配置玩家 → 验收锚在发起者侧（抽池不受控）')
      + '）；面板 ≡ 完整真镜像（去 warehouse 必 missing_warehouse 反证引用为真）；'
      + 'quick/run、ranked/run 与 legacy /battle 均以含装配插件的配置成功出战（ticks>0、invalids=0）。');
    out('   → D-159-R1 回归（第 19 步）：保存出战配置**不传 warehouse**（引用校验由服务端权威仓库自解析，'
      + 'verifiedAgainstWarehouse=true）→ 真的打一场 → 归档回放按需重算 200（帧数 = ticks）；'
      + '该路径完全不依赖客户端镜像。');
    out('   → D-162：HTTP 开箱（`/box` 与 `/me/box`）**没有 seed 入参**（传了被静默忽略）；本脚本用 '
      + `start({boxSeed: ${E2E_BOX_SEED}}) 注入确定性序列（第 n 次开箱 = boxSeed + n − 1），`
      + 'CLI `box` 也不再接受 `--seed`（给了即参数错误 exit 2）。');
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
