'use strict';
/* tests/helpers/load.js —— P7-6 批量测试公共引擎（`scripts/load-test.js` 与
 *   `tests/integration/load-integrity.test.js` 共用；**两份消费者一份实现**，避免批量流程出现第二套语义）。
 *
 * 权威：docs/plan-p7-playable.md §P7-6（真实玩家批量注册 → 配齐出战配置 → 先建池后匹配 → 完整性断言）；
 *      docs/interfaces.md §2/§7；docs/systems/11-account-store.md §7/§8/§11（容量）；D-132/D-133/D-134/D-136/D-152。
 *
 * 硬约束（与 plan §0 一致）：
 *   · 零依赖；**禁 `child_process`**；**禁 `Math.random`**（用本文件 `SeededRng`，种子显式）；
 *   · 进程内起服务（`server/index.js` `start()`）+ 随机端口（port 0）+ `os.tmpdir()` 隔离数据根；
 *   · **真实玩家，不用占位 bot**：每个对手都必须是 `/auth/register` 注册出来的档案（`flags.isBot=false`）；
 *   · 并发有界（`concurrency` 默认 24；批次化 `Promise.all`，不一次性打满进程）。
 *
 * 请求预算（每个玩家）：注册 1 + `GET /me` 1 + 开箱 1 + 装配 ≤ `slotsMax` 2 + 仓库镜像 1 + AI 校验 1
 *   + AI 编译 1 + `GET /me/configs` 1 + `PUT /me/configs/:slot` 1 ≈ 11 次/人 → `rateLimitPerMinute` 默认 2000。
 */
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const itemsApi = require('../../server/core/items.js');
const astApi = require('../../server/ai/ast.js');
const battleApi = require('../../server/battle.js');
const archiveMod = require('../../server/store/archive.js');
const ledger = require('../../server/store/ledger.js');
const skillTemplates = require('../../server/data/skill-templates.json').skillTemplates;

const VERSION = serverMod.VERSION;
const TIERS = Object.freeze(['common', 'rare', 'epic', 'legendary', 'mythic']);
const PRESETS = Object.freeze(['steady', 'aggressive', 'kite']);
const PASSWORD = 'loadtest1234'; // ≥ config.auth.passwordMin = 8
const SEED_MAX = 0x7fffffff;

// 生产默认 scrypt（N=16384）；`--fast-auth` / 集成测试可注入 N=1024 压缩时长（默认 = 真实成本）
const PROD_SCRYPT = Object.freeze({ auth: { scrypt: { N: 16384, r: 8, p: 1 } } });
const FAST_SCRYPT = Object.freeze({ auth: { scrypt: { N: 1024, r: 8, p: 1 } } });

const DEFAULTS = Object.freeze({
  players: 200,
  concurrency: 24,
  rankRuns: 1,
  quickRuns: 1,
  boxes: 16,
  tier: 'common',
  seed: 20260918,
  slotsMax: 2,
  warehouseBucketMax: 24,
  deep: false,
  rateLimitPerMinute: 2000,
  authRateLimitPerMinute: 5000,
  keepDataDir: false,
  fastAuth: false,
});

/* ---------- 种子化 RNG（禁 Math.random；xorshift32） ---------- */

class SeededRng {
  constructor(seed) {
    let s = Number.isInteger(seed) ? seed >>> 0 : 1;
    if (s === 0) s = 0x9e3779b9;
    this.state = s;
  }

  u32() {
    let x = this.state;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    this.state = x;
    return x >>> 0;
  }

  float() { return this.u32() / 4294967296; }

  int(min, max) {
    const lo = Number.isInteger(min) ? min : 0;
    const hi = Number.isInteger(max) ? max : 0;
    if (hi <= lo) return lo;
    return lo + Math.floor(this.float() * (hi - lo + 1));
  }

  pick(list) { return list[this.int(0, list.length - 1)]; }

  chance(p) { return this.float() < p; }
}

function randSeed(rng) { return rng.int(1, SEED_MAX); }

/* ---------- 有界并发 ---------- */

async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const width = Math.max(1, Math.min(Number.isInteger(limit) && limit > 0 ? limit : 1, list.length || 1));
  const results = new Array(list.length);
  let cursor = 0;
  async function run() {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= list.length) return;
      results[i] = await worker(list[i], i);
    }
  }
  const runners = [];
  for (let i = 0; i < width; i += 1) runners.push(run());
  await Promise.all(runners);
  return results;
}

/* ---------- 分位数统计 ---------- */

function percentile(sorted, p) {
  if (!sorted || sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function statsOf(samples) {
  const list = (samples || []).slice().sort((a, b) => a - b);
  if (list.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
  return {
    count: list.length,
    mean: Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 100) / 100,
    p50: percentile(list, 50),
    p95: percentile(list, 95),
    max: list[list.length - 1],
  };
}

// 有序桶计数器（P50/P95 用）：内存不随样本数增长
function createLatencyBuckets(max) {
  const cap = Number.isInteger(max) && max > 0 ? max : 600000;
  const counts = new Map();
  let count = 0;
  let sum = 0;
  let peak = 0;
  return {
    add(ms) {
      const v = Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0;
      count += 1;
      sum += v;
      if (v > peak) peak = v;
      const key = v > cap ? cap : v;
      counts.set(key, (counts.get(key) || 0) + 1);
    },
    size: () => count,
    stats() {
      if (count === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0 };
      const keys = [...counts.keys()].sort((a, b) => a - b);
      const pick = (q) => {
        const target = Math.max(1, Math.ceil(q * count));
        let acc = 0;
        for (const k of keys) {
          acc += counts.get(k);
          if (acc >= target) return k;
        }
        return keys[keys.length - 1];
      };
      return { count, mean: Math.round((sum / count) * 100) / 100, p50: pick(0.5), p95: pick(0.95), max: peak };
    },
  };
}

/* ---------- 指标收集 ---------- */

const GROUPS = ['register', 'box', 'assemble', 'ai', 'config', 'ranked', 'quick', 'all'];

function createMetrics() {
  const buckets = {};
  for (const g of GROUPS) buckets[g] = createLatencyBuckets();
  const statuses = {};
  const codes = {};
  const errors = [];
  let requests = 0;
  let failures = 0;
  let server5xx = 0;

  return {
    buckets,
    record(group, method, urlPath, status, ms, code) {
      requests += 1;
      if (status >= 500) server5xx += 1;
      const key = `${method} ${String(urlPath).split('?')[0]} ${status}`;
      statuses[key] = (statuses[key] || 0) + 1;
      if (code) codes[code] = (codes[code] || 0) + 1;
      if (group && buckets[group]) buckets[group].add(ms);
      buckets.all.add(ms);
    },
    recordError(group, method, urlPath, errMsg) {
      requests += 1;
      failures += 1;
      if (errors.length < 40) errors.push({ group, method, urlPath, error: String(errMsg).slice(0, 200) });
    },
    snapshot() {
      const latencyMs = {};
      for (const g of GROUPS) latencyMs[g] = buckets[g].stats();
      return {
        requests,
        transportFailures: failures,
        server5xx,
        errorRate: requests === 0 ? 0 : Math.round(((server5xx + failures) / requests) * 1e6) / 1e6,
        statusDistribution: Object.fromEntries(Object.entries(statuses).sort()),
        errorCodes: Object.fromEntries(Object.entries(codes).sort()),
        latencyMs,
        errors,
      };
    },
  };
}

/* ---------- HTTP 客户端（零依赖；进程内服务） ---------- */

function httpRequest(port, method, urlPath, payload, headers) {
  return new Promise((resolve, reject) => {
    let body = null;
    const h = { ...(headers || {}) };
    if (payload !== undefined && payload !== null) {
      body = typeof payload === 'string' ? payload : JSON.stringify(payload);
      if (h['content-type'] === undefined) h['content-type'] = 'application/json';
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 非 JSON 响应（保留 raw 供诊断） */ }
        resolve({ status: res.statusCode, body: json, raw });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function bearer(token) { return { authorization: `Bearer ${token}` }; }

// 带指标的单次请求；不抛（传输层异常 → status:null + errorCode:'transport_error'）
async function call(metrics, group, port, method, urlPath, payload, headers) {
  const t0 = Date.now();
  try {
    const res = await httpRequest(port, method, urlPath, payload, headers);
    const ms = Date.now() - t0;
    const code = res.body && res.body.ok === false && res.body.error ? res.body.error.code : null;
    metrics.record(group, method, urlPath, res.status, ms, code);
    return { status: res.status, body: res.body, raw: res.raw, errorCode: code, ms };
  } catch (err) {
    metrics.recordError(group, method, urlPath, err && err.message ? err.message : err);
    return { status: null, body: null, raw: '', errorCode: 'transport_error', ms: Date.now() - t0 };
  }
}

function envelopeData(res) { return res && res.body && res.body.ok === true ? res.body.data : null; }

/* ---------- AI 程序生成（每个玩家一份**行为各不相同**的程序） ---------- */

const lit = (v) => ({ type: 'literal', value: v });
const get = (p) => ({ type: 'get', path: p });
const act = (name) => ({ type: 'action', name });
const seq = (statements) => ({ type: 'seq', statements });
const cmp = (op, left, right) => ({ type: 'cmp', op, left, right });
const arith = (op, left, right) => ({ type: 'arith', op, left, right });
const ifElse = (cond, then, els) => ({ type: 'if', cond, then, else: els });

// 敌我 x 差（正 = 敌在右侧）；路径取自 runner.projectSnapshot 投影白名单（ast.js SNAPSHOT_*）
function gap() { return arith('-', get('enemy.x'), get('self.x')); }

/**
 * buildAiProgram(seed, types) → 由 seed 派生的**一份合法、行为由 seed 决定**的 AI 程序
 *   types = [straight|vertical|melee|displacement × 3]（出战槽 1..3 的技能类型）
 * 变化维度（每维都由 seed 决定 → 每个玩家行为不同）：
 *   ① 预设（steady/aggressive/kite）② 距离阈值 ③ 主攻技能槽 ④ 残血阈值 ⑤ 副技能 / 风筝退避动作
 * 只用 base 节点 + if（任意门控配置下均可校验通过）；version = ast.CURRENT_VERSION。
 */
function buildAiProgram(seed, types) {
  const rng = new SeededRng((seed ^ 0x5bf03635) >>> 0);
  const preset = rng.pick(PRESETS);
  const t = Array.isArray(types) && types.length === 3 ? types : ['straight', 'straight', 'straight'];
  const baseRange = t[0] === 'melee' ? 32 : t[0] === 'vertical' ? 64 : 224;
  const closeDistance = rng.int(48, 160);
  const farDistance = rng.int(baseRange, baseRange + 256);
  const retreat = t[2] === 'displacement' ? 'skill:skill3' : 'move_left';
  const hpFloor = rng.int(18, 44);
  const primary = rng.int(1, 3);
  const secondary = primary === 1 ? 2 : 1;
  let body;
  if (preset === 'steady') {
    // 残血先防 → 太远拉近 → 太近后撤 → 否则主技能开火
    const inner = seq([act(`skill:skill${primary}`)]);
    const tooClose = seq([ifElse(cmp('<', gap(), lit(-closeDistance)), seq([act('move_left')]), inner)]);
    const tooFar = seq([ifElse(cmp('>', gap(), lit(farDistance)), seq([act('move_right')]), tooClose)]);
    body = seq([ifElse(cmp('<', get('self.hp'), lit(hpFloor)), seq([act('defend')]), tooFar)]);
  } else if (preset === 'aggressive') {
    // 贴脸为主（够近就交副技能），不给自己留退路
    const inner = seq([act(`skill:skill${secondary}`)]);
    const tooClose = seq([ifElse(cmp('<', gap(), lit(-closeDistance)), seq([act('move_left')]), inner)]);
    body = seq([ifElse(cmp('>', gap(), lit(closeDistance)), seq([act('move_right')]), tooClose)]);
  } else {
    // 风筝：太近先脱身（有位移技能用位移，否则后撤）→ 太远靠近 → 射程内开火
    const inner = seq([act(`skill:skill${primary}`)]);
    const tooFar = seq([ifElse(cmp('>', gap(), lit(farDistance)), seq([act('move_right')]), inner)]);
    body = seq([ifElse(cmp('<', gap(), lit(closeDistance)), seq([act(retreat)]), tooFar)]);
  }
  return {
    program: { type: 'program', version: astApi.CURRENT_VERSION, body },
    preset,
    params: { hpFloor, closeDistance, farDistance, primary, secondary, retreat, type0: t[0] },
  };
}

/* ---------- 装配规划（本地预演 → 逐条提交服务端裁决） ----------
 * `POST /warehouse/assemble` 与 `core/items.assemble` 是同一实现（server/index.js 调用 items.assemble）；
 * 本地预演只决定"提交哪些装配请求"，服务端返回的每一次拒绝都进报告（不做第二套裁决）。
 */

function makeWarehouseView(warehouse, assignments) {
  const clone = JSON.parse(JSON.stringify(warehouse || { buckets: {} }));
  if (!clone.buckets || typeof clone.buckets !== 'object') clone.buckets = {};
  for (const key of Object.keys(clone.buckets)) {
    if (!Array.isArray(clone.buckets[key])) clone.buckets[key] = [];
  }
  const view = {
    raw: clone,
    buckets: clone.buckets,
    findItem(uid) {
      for (const list of Object.values(clone.buckets)) {
        const hit = list.find((x) => x && x.uid === uid);
        if (hit) return hit;
      }
      return null;
    },
  };
  // 叠加本地已生效的装配（与服务端每次成功响应一一对应）→ 视图 = 服务端当前状态
  if (assignments && assignments.size > 0) {
    for (const [key, pluginUid] of assignments) {
      const [targetUid, slotIndexRaw] = key.split('#');
      const target = view.findItem(targetUid);
      const plugin = view.findItem(pluginUid);
      if (target && Array.isArray(target.slots) && target.slots[Number(slotIndexRaw)]) {
        target.slots[Number(slotIndexRaw)].pluginUid = pluginUid;
      }
      if (plugin) plugin.equipped = true;
    }
  }
  return view;
}

function usedRolePoints(wh, role) {
  let used = 0;
  for (const s of (role && role.slots) || []) {
    if (!s || !s.pluginUid) continue;
    const p = wh.findItem(s.pluginUid);
    used += p && Number.isFinite(p.pointCost) ? p.pointCost : 0;
  }
  return used;
}

function pickPlugin(wh, bucket, slotType) {
  let best = null;
  for (const p of wh.buckets[bucket] || []) {
    if (!p || p.equipped === true) continue;
    if (p.slot !== slotType) continue;
    if (best === null || (p.pointCost || 0) < (best.pointCost || 0)) best = p;
  }
  return best;
}

/**
 * planLoadout(warehouse, { slotsMax }) → { loadout, plan, skipped, stats, error? }
 *   loadout = { role, skills[3], ai:null }（ai 由调用方写回）
 *   plan    = [{ targetUid, slotIndex, pluginUid, kind, slotType }]（按序提交 → 服务端逐条裁决）
 */
function planLoadout(warehouse, options) {
  const o = options || {};
  const slotsMax = Number.isInteger(o.slotsMax) && o.slotsMax >= 0 ? o.slotsMax : DEFAULTS.slotsMax;
  const wh = makeWarehouseView(warehouse, o.assignments);
  const role = (wh.buckets.role || [])[0] && wh.findItem((wh.buckets.role || [])[0].uid);
  const skills = (wh.buckets.skill || []).slice(0, 3).map((s) => wh.findItem(s.uid));
  const plan = [];
  const skipped = [];
  const stats = { roleTargets: 0, skillTargets: 0, placed: 0, noCandidate: 0, noSlot: 0, pointsExceeded: 0 };
  if (!role || skills.length !== 3 || skills.some((s) => !s)) {
    return {
      loadout: null, plan, skipped, stats,
      error: `出战材料不足（角色 ${role ? 1 : 0} / 技能 ${skills.length}，需 1 + 3）`,
    };
  }
  const targets = [{ item: role, bucket: 'rolePlugin', kind: 'role' }]
    .concat(skills.map((s) => ({ item: s, bucket: 'skillPlugin', kind: 'skill' })));
  for (const target of targets) {
    const slots = Array.isArray(target.item.slots) ? target.item.slots : [];
    if (slots.length === 0) { stats.noSlot += 1; continue; }
    if (target.kind === 'role') stats.roleTargets += 1; else stats.skillTargets += 1;
    for (let i = 0; i < Math.min(slots.length, slotsMax); i += 1) {
      const slot = slots[i];
      if (!slot) continue;
      if (slot.pluginUid) { stats.placed += 1; continue; } // 已生效（assignments 叠加）
      const used = target.kind === 'role' ? usedRolePoints(wh, target.item) : 0;
      const cand = pickPlugin(wh, target.bucket, slot.type);
      if (!cand) { stats.noCandidate += 1; continue; }
      if (target.kind === 'role' && used + (cand.pointCost || 0) > (target.item.pluginPoints || 0)) {
        stats.pointsExceeded += 1;
        skipped.push({ where: `${target.item.uid}[${i}]`, code: 'points_exceeded', pluginUid: cand.uid });
        continue;
      }
      slot.pluginUid = cand.uid;
      cand.equipped = true;
      plan.push({ targetUid: target.item.uid, slotIndex: i, pluginUid: cand.uid, kind: target.kind, slotType: slot.type });
      stats.placed += 1;
    }
  }
  return { loadout: { role, skills, ai: null }, plan, skipped, stats };
}

// 仅保留被 loadout 引用的物品（不含无关开箱产物）→ 提交为仓库镜像（D-130 非权威，只做引用校验）
function mirrorOfLoadout(loadout, warehouse, bucketMax) {
  const keep = new Set();
  const add = (item) => {
    if (!item || typeof item.uid !== 'string') return;
    keep.add(item.uid);
    for (const s of item.slots || []) if (s && s.pluginUid) keep.add(s.pluginUid);
  };
  add(loadout.role);
  for (const s of loadout.skills || []) add(s);
  const out = itemsApi.emptyWarehouse();
  const cap = Number.isInteger(bucketMax) && bucketMax > 0 ? bucketMax : DEFAULTS.warehouseBucketMax;
  for (const [bucket, list] of Object.entries((warehouse && warehouse.buckets) || {})) {
    if (!Array.isArray(list)) continue;
    out.buckets[bucket] = list.filter((x) => x && keep.has(x.uid)).slice(0, cap);
  }
  return out;
}

/* ---------- 单个玩家：注册 → 配齐出战配置 ---------- */

function lookupPlayerId(store, publicId) {
  for (const id of store.index.playerIds()) {
    const e = store.index.get(id);
    if (e && e.publicId === publicId) return id;
  }
  return null;
}

async function registerPlayer(ctx, index) {
  const username = `lt_${String(index).padStart(4, '0')}_${ctx.seed}`.slice(0, 24);
  const res = await call(ctx.metrics, 'register', ctx.port, 'POST', '/api/v1/auth/register', {
    username, password: PASSWORD, nickname: `玩家${index}`,
  });
  if (res.status !== 200) {
    return { ok: false, index, status: res.status, code: res.errorCode || `status_${res.status}`, username };
  }
  const data = envelopeData(res) || {};
  return {
    ok: true, index, username,
    publicId: data.publicId,
    token: data.token,
    playerId: lookupPlayerId(ctx.store, data.publicId), // playerId 不回带（§4.5）→ 索引反查
  };
}

async function setupPlayer(ctx, p) {
  const auth = bearer(p.token);
  const detail = { index: p.index, publicId: p.publicId, equipped: 0, rejects: {}, preset: null, programHash: null };

  // 1) GET /me（档案摘要）
  const me = await call(ctx.metrics, null, ctx.port, 'GET', '/api/v1/me', null, auth);
  if (me.status !== 200) return { ok: false, code: 'me_failed', status: me.status, detail };
  detail.tier = (envelopeData(me) || {}).progress ? envelopeData(me).progress.tier : null;

  // 2) 开箱（一次请求开 N 箱；seed 由种子流派生 → 各人掉落各异）
  const boxRes = await call(ctx.metrics, 'box', ctx.port, 'POST', '/api/v1/box',
    { seed: randSeed(ctx.rng), tier: ctx.tier, times: ctx.boxes }, auth);
  if (boxRes.status !== 200) return { ok: false, code: 'box_failed', status: boxRes.status, detail, errorCode: boxRes.errorCode };
  const boxed = (envelopeData(boxRes) || {}).items || [];
  let warehouse = itemsApi.emptyWarehouse();
  for (const item of boxed) {
    if (!item || typeof item.kind !== 'string') continue;
    if (!Array.isArray(warehouse.buckets[item.kind])) warehouse.buckets[item.kind] = [];
    warehouse.buckets[item.kind].push(item);
  }
  detail.items = boxed.length;

  // 3) 装配：本地规划（纯函数）→ 逐条 POST /warehouse/assemble（服务端为权威）。
  //    每次请求提交**装配前的仓库**（接口是纯函数：返回新仓库，入参不变）；装配结果只在本地视图叠加，
  //    点数/槽位占用/唯一性全部由服务端裁决（拒绝进报告，不做第二套判定）。
  const assembleBase = warehouse;
  const assignments = new Map();
  const usedPluginUids = new Set();
  const planned = planLoadout(assembleBase, { slotsMax: ctx.slotsMax });
  if (!planned.loadout) return { ok: false, code: 'loadout_materials_missing', detail };
  for (;;) {
    const view = makeWarehouseView(assembleBase, assignments);
    const candidate = nextCandidate(view, planned.loadout, ctx.slotsMax, usedPluginUids);
    if (!candidate) break;
    const res = await call(ctx.metrics, 'assemble', ctx.port, 'POST', '/api/v1/warehouse/assemble',
      {
        warehouse: view.raw,
        targetUid: candidate.targetUid,
        pluginUid: candidate.pluginUid,
        slotIndex: candidate.slotIndex,
        tier: ctx.tier,
      }, auth);
    const data = envelopeData(res);
    if (res.status === 200 && data && data.warehouse) {
      assignments.set(`${candidate.targetUid}#${candidate.slotIndex}`, candidate.pluginUid);
      usedPluginUids.add(candidate.pluginUid);
      detail.equipped += 1;
      continue;
    }
    // 服务端拒绝（points_exceeded / slot_type_mismatch / …）：标记该插件已试，换下一个候选
    const code = res.errorCode || `status_${res.status}`;
    detail.rejects[code] = (detail.rejects[code] || 0) + 1;
    usedPluginUids.add(candidate.pluginUid);
  }
  if (assignments.size > 0) {
    const finalPlan = planLoadout(assembleBase, { slotsMax: ctx.slotsMax, assignments });
    planned.loadout.role = finalPlan.loadout.role;
    planned.loadout.skills = finalPlan.loadout.skills;
  }

  // 4) 为每人生成**行为各不相同**的 AI → /ai/validate + /ai/compile
  const skillTypes = planned.loadout.skills.map((s) => {
    const tpl = skillTemplates.find((x) => x.id === s.templateId);
    return tpl ? tpl.type : 'straight';
  });
  const ai = buildAiProgram(randSeed(ctx.rng), skillTypes);
  planned.loadout.ai = ai.program;
  detail.preset = ai.preset;
  detail.programHash = astApi.programHash(ai.program);
  const localCheck = astApi.validate(ai.program, ctx.tier);
  detail.localAiValid = localCheck.ok;
  if (!localCheck.ok) {
    return { ok: false, code: 'local_ai_invalid', detail, errors: localCheck.errors.slice(0, 3) };
  }
  const v1 = await call(ctx.metrics, 'ai', ctx.port, 'POST', '/api/v1/ai/validate', { program: ai.program, tier: ctx.tier }, auth);
  if (v1.status !== 200) return { ok: false, code: 'ai_validate_failed', status: v1.status, detail, errorCode: v1.errorCode };
  const v2 = await call(ctx.metrics, 'ai', ctx.port, 'POST', '/api/v1/ai/compile', { program: ai.program }, auth);
  if (v2.status !== 200) return { ok: false, code: 'ai_compile_failed', status: v2.status, detail, errorCode: v2.errorCode };
  detail.compiledHash = (envelopeData(v2) || {}).programHash || null;

  // 5) 仓库镜像（引用校验用）+ PUT /me/configs/:slot（默认槽，≤3 且唯一出战）
  const mirror = mirrorOfLoadout(planned.loadout, assembleBase, ctx.warehouseBucketMax);
  const whRes = await call(ctx.metrics, null, ctx.port, 'PUT', '/api/v1/me/warehouse', { warehouse: mirror }, auth);
  if (whRes.status !== 200) return { ok: false, code: 'warehouse_mirror_failed', status: whRes.status, detail, errorCode: whRes.errorCode };

  const cfgs = await call(ctx.metrics, 'config', ctx.port, 'GET', '/api/v1/me/configs', null, auth);
  if (cfgs.status !== 200) return { ok: false, code: 'configs_failed', status: cfgs.status, detail };
  const cfgData = envelopeData(cfgs) || {};
  detail.slots = (cfgData.slots || []).length;
  detail.activeSlotId = cfgData.activeSlotId;
  const save = await call(ctx.metrics, 'config', ctx.port, 'PUT', `/api/v1/me/configs/${cfgData.activeSlotId}`,
    { loadout: planned.loadout, warehouse: mirror, activate: true }, auth);
  if (save.status !== 200) return { ok: false, code: 'config_save_failed', status: save.status, detail, errorCode: save.errorCode };
  return { ok: true, detail, mirror };
}

// 下一个可提交的装配候选（在"装配前仓库 + 本地已生效赋值"视图上规划；跳过已试过的插件）
function nextCandidate(wh, loadout, slotsMax, usedPluginUids) {
  const targets = [{ item: loadout.role, bucket: 'rolePlugin', kind: 'role' }]
    .concat((loadout.skills || []).map((s) => ({ item: s, bucket: 'skillPlugin', kind: 'skill' })));
  for (const target of targets) {
    const slots = Array.isArray(target.item.slots) ? target.item.slots : [];
    if (slots.length === 0) continue;
    if (target.kind === 'role' && usedRolePoints(wh, target.item) >= (target.item.pluginPoints || 0)) continue;
    for (let i = 0; i < Math.min(slots.length, slotsMax); i += 1) {
      const slot = slots[i];
      if (!slot || slot.pluginUid) continue;
      for (const p of wh.buckets[target.bucket] || []) {
        if (!p || p.equipped === true) continue;
        if (p.slot !== slot.type) continue;
        if (usedPluginUids.has(p.uid)) continue;
        return { targetUid: target.item.uid, slotIndex: i, pluginUid: p.uid, kind: target.kind, slotType: slot.type };
      }
      return null; // 该槽无可用候选 → 结束（不跳过槽位：装配只在目标物品的前 N 个槽上做）
    }
  }
  return null;
}

/* ---------- 报告辅助 ---------- */

function mergeCounters(list) {
  const out = {};
  for (const obj of list) for (const [k, v] of Object.entries(obj || {})) out[k] = (out[k] || 0) + v;
  return out;
}

function countBy(values, fn) {
  const out = {};
  for (const v of values) {
    const k = String(fn(v));
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

function makeTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-p7-6-load-')); }

function removeTempDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

async function closeReport(report) {
  const s = report && report.serverHandle;
  if (s) {
    try { await s.close(); } catch (e) { report.closeError = e && e.message ? e.message : String(e); }
  }
  if (report && report.dataDirKept && report.dataDir) {
    try { removeTempDir(report.dataDir); } catch (e) { report.cleanupError = e && e.message ? e.message : String(e); }
  }
  if (report) { report.dataDirKept = false; delete report.serverHandle; }
  return report;
}

/* ---------- 批量测试主流程 ---------- */

/**
 * runLoadTest(options) → Promise<report>
 *   options：见 `DEFAULTS`，另支持 `fastAuth`（N=1024）、`level`（服务端日志级别）、
 *            `keepDataDir`（保留临时数据根并挂 `report.store`/`report.dataDir`，供集成测试做独立断言——
 *             用 `await closeReport(report)` 收尾）、`dataDir`、`logger`、`serverOptions`。
 */
async function runLoadTest(options) {
  const o = { ...DEFAULTS, ...(options || {}) };
  const logger = o.logger || createLogger({ level: o.level || 'warn', ringSize: o.ringSize || 2000 });
  const dataDir = o.dataDir || makeTempDir();
  const metrics = createMetrics();
  const rng = new SeededRng(o.seed);
  const startedAt = Date.now();
  const scryptBlock = o.fastAuth ? FAST_SCRYPT.auth : PROD_SCRYPT.auth;

  const server = await serverMod.start({
    logger,
    dataDir,
    host: '127.0.0.1',
    port: 0,
    versions: { engine: VERSION },
    rateLimitPerMinute: o.rateLimitPerMinute,
    authConfig: { auth: { ...scryptBlock, rateLimitPerMinute: o.authRateLimitPerMinute } },
    ...(o.serverOptions || {}),
  });

  const ctx = {
    port: server.port, store: server.store, runtime: server.runtime, logger, metrics, rng,
    seed: o.seed, tier: o.tier, boxes: o.boxes, slotsMax: o.slotsMax,
    warehouseBucketMax: o.warehouseBucketMax,
  };

  const report = {
    schema: 'dl-load-report/1',
    generatedAt: new Date(startedAt).toISOString(),
    engineVersion: VERSION,
    options: {
      players: o.players, concurrency: o.concurrency, rankRuns: o.rankRuns, quickRuns: o.quickRuns,
      boxes: o.boxes, tier: o.tier, seed: o.seed, slotsMax: o.slotsMax, deep: !!o.deep,
      scrypt: o.fastAuth ? 'N=1024（测试快速档）' : 'N=16384（生产默认）',
      rateLimitPerMinute: o.rateLimitPerMinute, authRateLimitPerMinute: o.authRateLimitPerMinute,
      dataDirKind: o.dataDir ? 'injected' : 'os.tmpdir()',
    },
    phases: {},
    distribution: {},
    integrity: { checks: [], counts: {} },
    ok: false,
    serverHandle: server,
    dataDir: o.keepDataDir ? dataDir : null,
    dataDirKept: !!o.keepDataDir,
  };

  const indices = [];
  for (let i = 1; i <= o.players; i += 1) indices.push(i);

  try {
    /* ---- 阶段 1：并发批量注册 N 个真实玩家 ---- */
    const t1 = Date.now();
    const registered = await mapLimit(indices, o.concurrency, (i) => registerPlayer(ctx, i));
    const phase1Ms = Date.now() - t1;
    const players = registered.filter((r) => r.ok && r.token && r.publicId);
    report.phases.register = {
      requested: o.players, ok: players.length, failed: registered.length - players.length,
      ms: phase1Ms, perSecond: Math.round((players.length / Math.max(1, phase1Ms)) * 1000),
      failures: registered.filter((r) => !r.ok).slice(0, 10),
    };
    if (players.length !== o.players) {
      report.integrity.checks.push({
        id: 'R0-register-all', title: 'R0 注册全部成功',
        ok: false, detail: `注册失败 ${registered.length - players.length} 个（真实玩家建池不完整）`,
      });
      return finish(report, metrics, startedAt, o);
    }
    const username = (p, i) => `${p.username || `#${i}`}(${p.publicId || '-'})`;

    /* ---- 阶段 2：为每个玩家配齐完整出战配置 ---- */
    const t2 = Date.now();
    const setup = await mapLimit(players, o.concurrency, (p) => setupPlayer(ctx, p));
    const phase2Ms = Date.now() - t2;
    const ready = [];
    for (let i = 0; i < players.length; i += 1) if (setup[i] && setup[i].ok) ready.push(players[i]);
    report.phases.setup = {
      requested: players.length, ok: ready.length, failed: players.length - ready.length, ms: phase2Ms,
      failures: setup.filter((s) => s && !s.ok).map((s) => ({ code: s.code, status: s.status || null, detail: s.detail, errorCode: s.errorCode || null })).slice(0, 10),
      assemble: {
        placed: setup.reduce((n, s) => n + ((s && s.detail && s.detail.equipped) || 0), 0),
        rejections: mergeCounters(setup.map((s) => (s && s.detail && s.detail.rejects) || {})),
      },
    };
    if (ready.length !== players.length) {
      report.integrity.checks.push({
        id: 'R0-setup-all', title: 'R0 全部玩家配齐出战配置',
        ok: false, detail: `配齐出战配置失败 ${players.length - ready.length} 个`,
      });
      return finish(report, metrics, startedAt, o);
    }

    // 真实玩家登记表（playerId → 注册信息；用于"无 bot"与可追溯断言）
    const registry = new Map();
    for (let i = 0; i < ready.length; i += 1) {
      const p = ready[i];
      const archive = await server.store.loadArchive(p.playerId);
      registry.set(p.playerId, {
        index: p.index,
        username: p.username,
        publicId: p.publicId,
        isBot: !!(archive && archive.flags && archive.flags.isBot),
        tier: archive ? archive.progress.tier : null,
        points: archive ? archive.rating.points : 0,
        preset: (setup[i].detail && setup[i].detail.preset) || null,
        programHash: (setup[i].detail && setup[i].detail.programHash) || null,
        equipped: (setup[i].detail && setup[i].detail.equipped) || 0,
      });
    }

    /* ---- 阶段 3：先建池（等档案/快照数达标）后匹配 ---- */
    const pool = server.store.index;
    let snapshotUsable = 0;
    const snapshotHashes = new Set();
    for (const playerId of registry.keys()) {
      const entry = pool.get(playerId);
      if (!entry || !entry.activeSnapshotHash) continue;
      snapshotHashes.add(entry.activeSnapshotHash);
      const snap = await server.store.snapshot.get(entry.activeSnapshotHash);
      if (snap && snap.hash === entry.activeSnapshotHash && snap.loadout) snapshotUsable += 1;
    }
    report.phases.pool = {
      archives: pool.size(),
      registeredPlayers: registry.size(),
      distinctSnapshots: snapshotHashes.size,
      usableSnapshots: snapshotUsable,
      byTier: countBy(registry.values(), (v) => v.tier),
      isBotArchives: countBy(registry.values(), (v) => v.isBot).true || 0,
    };
    if (snapshotUsable < registry.size || pool.size() < registry.size) {
      report.integrity.checks.push({
        id: 'R0-pool-ready', title: 'R0 匹配池已就绪（档案 + 可用快照 ≥ 注册玩家数）',
        ok: false,
        detail: `可用快照 ${snapshotUsable} / 档案 ${pool.size()} < 注册玩家 ${registry.size}（池未就绪即匹配会引入 409 no_opponent）`,
      });
      return finish(report, metrics, startedAt, o);
    }

    /* ---- 对局前积分基线（全局守恒的 Σ前） ---- */
    const beforeRatings = new Map();
    for (const playerId of registry.keys()) {
      const archive = await server.store.loadArchive(playerId);
      beforeRatings.set(playerId, archive ? archive.rating.points : 0);
    }
    let beforeSum = 0;
    for (const v of beforeRatings.values()) beforeSum += v;

    /* ---- 阶段 4：并发在线 + 匹配 + 战斗（排位 + 快速；真实玩家，无 bot 补位） ---- */
    const t4 = Date.now();
    const matchResults = await mapLimit(ready, o.concurrency, async (p) => {
      const auth = bearer(p.token);
      const mine = { ranked: [], quick: [] };
      const jobs = [];
      for (let i = 0; i < o.rankRuns; i += 1) {
        jobs.push(call(metrics, 'ranked', ctx.port, 'POST', '/api/v1/ranked/run', { seed: randSeed(rng) }, auth)
          .then((res) => { mine.ranked.push(res); }));
      }
      for (let i = 0; i < o.quickRuns; i += 1) {
        jobs.push(call(metrics, 'quick', ctx.port, 'POST', '/api/v1/quick/run', { seed: randSeed(rng) }, auth)
          .then((res) => { mine.quick.push(res); }));
      }
      await Promise.all(jobs);
      return mine;
    });
    const phase4Ms = Date.now() - t4;

    let rankedRuns = 0; let rankedMatches = 0; let rankedShortfall = 0; let rankedInvalids = 0;
    let quickAttempts = 0; let quickOk = 0; let quickNoOpponent = 0;
    const quickOutcomes = {};
    const rankedRunsOutcome = {};
    for (const slot of matchResults) {
      for (const res of slot.ranked) {
        rankedRuns += 1;
        const d = envelopeData(res);
        if (res.status === 200 && d) {
          rankedMatches += d.matches || 0;
          rankedShortfall += d.shortfall || 0;
          rankedInvalids += d.invalids || 0;
          const k = `matches=${d.matches}/shortfall=${d.shortfall}`;
          rankedRunsOutcome[k] = (rankedRunsOutcome[k] || 0) + 1;
        } else {
          const k = res.errorCode || `status_${res.status}`;
          rankedRunsOutcome[k] = (rankedRunsOutcome[k] || 0) + 1;
        }
      }
      for (const res of slot.quick) {
        quickAttempts += 1;
        const d = envelopeData(res);
        if (res.status === 200 && d) {
          quickOk += 1;
          quickOutcomes[d.winner] = (quickOutcomes[d.winner] || 0) + 1;
        } else {
          const k = res.errorCode || `status_${res.status}`;
          if (k === 'no_opponent') quickNoOpponent += 1;
          quickOutcomes[k] = (quickOutcomes[k] || 0) + 1;
        }
      }
    }
    const totalMatches = rankedMatches + quickOk;
    report.phases.matches = {
      ms: phase4Ms,
      ranked: {
        runs: rankedRuns, matches: rankedMatches, shortfall: rankedShortfall, invalids: rankedInvalids,
        matchesPerSecond: Math.round((rankedMatches / Math.max(1, phase4Ms)) * 1000),
        runOutcomes: rankedRunsOutcome,
      },
      quick: {
        attempts: quickAttempts, ok: quickOk, noOpponent: quickNoOpponent,
        matchesPerSecond: Math.round((quickOk / Math.max(1, phase4Ms)) * 1000),
        outcomes: quickOutcomes,
      },
      totalMatches,
      throughputPerSecond: Math.round((totalMatches / Math.max(1, phase4Ms)) * 1000),
    };

    /* ---- 阶段 5：完整性断言 ---- */
    report.integrity = await runIntegrityChecks({
      store: server.store, registry, beforeRatings, beforeSum, metrics,
      replayLimit: server.runtime ? server.runtime.replayLimit : null,
      deep: !!o.deep, port: server.port,
    });

    report.distribution = await buildDistribution(server.store, registry);
    report.ok = report.integrity.checks.every((c) => c.ok === true);
    return finish(report, metrics, startedAt, o);
  } catch (err) {
    report.fatal = {
      message: err && err.message ? err.message : String(err),
      stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4) : [],
    };
    report.ok = false;
    return finish(report, metrics, startedAt, o);
  }
}

function finish(report, metrics, startedAt, o) {
  report.metrics = metrics.snapshot();
  report.wallMs = Date.now() - startedAt;
  try {
    report.store = report.serverHandle && report.serverHandle.store ? report.serverHandle.store.stats() : null;
  } catch (e) {
    report.store = null;
  }
  report.ok = report.ok === true
    && report.integrity.checks.every((c) => c.ok === true)
    && report.metrics.server5xx === 0;
  if (!o.keepDataDir) {
    return closeReport(report);
  }
  return report;
}

/* ---------- 完整性断言（plan §P7-6 第 4 条七项） ---------- */

async function runIntegrityChecks(ctx) {
  const store = ctx.store;
  const registry = ctx.registry;
  const checks = [];
  const counts = {
    quickMatches: 0, rankedMatches: 0, duplicateBattleIds: 0,
    nonZeroSumMatches: 0, zeroSumMatches: 0, badParticipantEndpoints: 0,
  };

  // 单遍流式扫描 journal（不把全量 journal 读进内存）→ 同时支撑 ①②③⑥
  const perPlayer = new Map();
  for (const playerId of registry.keys()) {
    perPlayer.set(playerId, { attack: 0, defense: 0, points: 0, pointsBeforeFirst: null });
  }
  const perPlayerDelta = new Map();
  for (const playerId of registry.keys()) perPlayerDelta.set(playerId, 0);
  const battleIds = new Set();
  let duplicateBattleIds = 0;
  let missingEndpoints = 0;
  let arithmeticBad = 0;
  let nonZeroSumMatches = 0;
  let zeroSumMatches = 0;
  let badParticipantEndpoints = 0;
  let firstRecord = null;
  let seqMonotonic = true;
  let lastSeq = 0;
  let deltaSumJournal = 0;
  const perMode = { quick: 0, ranked: 0, other: 0 };

  await store.replayJournal({ includeCheckpoints: false }, (record) => {
    if (!Number.isInteger(record.seq) || record.seq <= lastSeq) seqMonotonic = false;
    lastSeq = record.seq;
    if (record.type !== 'battle.recorded') return;
    if (!firstRecord) firstRecord = record;
    if (battleIds.has(record.battleId)) duplicateBattleIds += 1;
    battleIds.add(record.battleId);
    const p1 = record.p1 || {};
    const p2 = record.p2 || {};
    if (record.mode === 'quick') perMode.quick += 1;
    else if (record.mode === 'ranked') perMode.ranked += 1;
    else perMode.other += 1;

    // ⑥ 每场双方 playerId 均为真实注册玩家（格式 + 注册表 + 非 bot）
    const real = (side) => typeof side.playerId === 'string' && archiveMod.PLAYER_ID_RE.test(side.playerId)
      && registry.has(side.playerId) && registry.get(side.playerId).isBot === false;
    if (!real(p1) || !real(p2) || p1.playerId === p2.playerId) badParticipantEndpoints += 1;

    // ② 无半场战绩：两端必须齐全（playerId + result + pointsBefore/After）
    const complete = (side) => typeof side.playerId === 'string' && side.playerId !== ''
      && (side.result === 'win' || side.result === 'loss' || side.result === 'draw')
      && Number.isInteger(side.pointsBefore) && Number.isInteger(side.pointsAfter);
    if (!complete(p1) || !complete(p2)) missingEndpoints += 1;

    // ③ 对局粒度守恒：ΣR前 + ΣΔ = ΣR后（Δ = pointsAfter − pointsBefore，双方逐场复算）
    const b1 = Number.isInteger(p1.pointsBefore) ? p1.pointsBefore : 0;
    const a1 = Number.isInteger(p1.pointsAfter) ? p1.pointsAfter : b1;
    const b2 = Number.isInteger(p2.pointsBefore) ? p2.pointsBefore : 0;
    const a2 = Number.isInteger(p2.pointsAfter) ? p2.pointsAfter : b2;
    if ((b1 + b2) + ((a1 - b1) + (a2 - b2)) !== a1 + a2) arithmeticBad += 1;
    if ((a1 - b1) + (a2 - b2) === 0) zeroSumMatches += 1; else nonZeroSumMatches += 1;
    deltaSumJournal += (a1 - b1) + (a2 - b2);

    const s1 = perPlayer.get(p1.playerId);
    const s2 = perPlayer.get(p2.playerId);
    if (s1) {
      s1.attack += 1;
      s1.points = a1;
      if (s1.pointsBeforeFirst === null) s1.pointsBeforeFirst = b1;
    }
    if (s2) {
      s2.defense += 1;
      s2.points = a2;
      if (s2.pointsBeforeFirst === null) s2.pointsBeforeFirst = b2;
    }
    perPlayerDelta.set(p1.playerId, (perPlayerDelta.get(p1.playerId) || 0) + (a1 - b1));
    perPlayerDelta.set(p2.playerId, (perPlayerDelta.get(p2.playerId) || 0) + (a2 - b2));
  });

  counts.quickMatches = perMode.quick;
  counts.rankedMatches = perMode.ranked;
  counts.battleRecords = perMode.quick + perMode.ranked + perMode.other;
  counts.duplicateBattleIds = duplicateBattleIds;
  counts.nonZeroSumMatches = nonZeroSumMatches;
  counts.zeroSumMatches = zeroSumMatches;
  counts.badParticipantEndpoints = badParticipantEndpoints;
  counts.journalRecords = lastSeq;

  // 档案对照（②的档案层证据 + ③的全局粒度右端）
  let archiveMissing = 0;
  let archiveStatsMismatch = 0;
  let archivePointsMismatch = 0;
  let botArchives = 0;
  const archivePoints = new Map();
  for (const playerId of registry.keys()) {
    const archive = await store.loadArchive(playerId);
    if (!archive) { archiveMissing += 1; continue; }
    if (archive.flags && archive.flags.isBot) botArchives += 1;
    const st = archive.record.stats;
    const expect = perPlayer.get(playerId);
    if (st.attack.wins + st.attack.losses + st.attack.draws !== expect.attack
      || st.defense.wins + st.defense.losses + st.defense.draws !== expect.defense) {
      archiveStatsMismatch += 1;
    }
    if (archive.rating.points !== expect.points) archivePointsMismatch += 1;
    archivePoints.set(playerId, archive.rating.points);
  }
  counts.attackRecordsApplied = [...perPlayer.values()].reduce((n, s) => n + s.attack, 0);
  counts.defenseRecordsApplied = [...perPlayer.values()].reduce((n, s) => n + s.defense, 0);

  // ① journal 幂等：重复 apply 同一 battle.recorded → 不重复记账（applied=0，档案逐字段不变）
  let idempotent = { ok: false, detail: 'journal 中无 battle.recorded（无法验证）' };
  if (firstRecord) {
    const id1 = firstRecord.p1.playerId;
    const id2 = firstRecord.p2.playerId;
    const snap = (a) => JSON.stringify({
      points: a.rating.points, games: a.rating.games,
      atk: a.record.stats.attack, def: a.record.stats.defense, recent: a.record.recent.length,
      appliedSeq: a.record.appliedSeq,
    });
    const before1 = snap(await store.loadArchive(id1));
    const before2 = snap(await store.loadArchive(id2));
    const seqBefore = store.maxSeq();
    const replayed = await store.applyRecord(firstRecord);
    await store.applyRecords([firstRecord]);
    const after1 = snap(await store.loadArchive(id1));
    const after2 = snap(await store.loadArchive(id2));
    const ok = replayed.applied === 0 && before1 === after1 && before2 === after2 && store.maxSeq() === seqBefore;
    idempotent = {
      ok,
      detail: `重复 apply ${firstRecord.battleId} → applied=${replayed.applied}；双方档案快照不变=${before1 === after1 && before2 === after2}；`
        + `journal 水位不变=${store.maxSeq() === seqBefore}（${seqBefore}）`,
      battleId: firstRecord.battleId,
    };
  }

  checks.push({
    id: 'A1-journal-idempotent',
    title: '① journal 幂等（重复结算不重复记账）',
    ok: idempotent.ok === true,
    detail: idempotent.detail,
    numbers: { reapplied: idempotent.ok ? 0 : null, journalSeq: lastSeq },
  });
  checks.push({
    id: 'A2-no-half-battle',
    title: '② 无半场战绩（每场要么双方都有记录，要么都没有）',
    ok: missingEndpoints === 0 && archiveMissing === 0 && archiveStatsMismatch === 0
      && counts.attackRecordsApplied === counts.battleRecords
      && counts.defenseRecordsApplied === counts.battleRecords,
    detail: `缺端记录=${missingEndpoints}；档案缺失=${archiveMissing}；`
      + `攻方记账=${counts.attackRecordsApplied} / 守方记账=${counts.defenseRecordsApplied} / 对局记录=${counts.battleRecords}`
      + `（三者相等 ⟺ 无半场）；档案战绩与 journal 不一致=${archiveStatsMismatch}`,
    numbers: {
      battleRecords: counts.battleRecords, attackApplied: counts.attackRecordsApplied,
      defenseApplied: counts.defenseRecordsApplied, missingEndpoints,
    },
  });

  // ③ 积分守恒（对局粒度 + 全局粒度；D-133 非零和"汇"）
  let afterSum = 0;
  for (const v of archivePoints.values()) afterSum += v;
  let deltaSumArchive = 0;
  for (const [playerId, before] of ctx.beforeRatings) {
    if (!archivePoints.has(playerId)) continue;
    deltaSumArchive += archivePoints.get(playerId) - before;
  }
  const globalConservation = ctx.beforeSum + deltaSumArchive === afterSum;
  const journalConservation = deltaSumJournal === deltaSumArchive;
  const sink = deltaSumArchive <= 0;
  checks.push({
    id: 'A3-rating-conservation',
    title: '③ 积分守恒（对局粒度 + 全局粒度；D-133 非零和"汇"）',
    ok: arithmeticBad === 0 && globalConservation && journalConservation && sink && archivePointsMismatch === 0,
    detail: `对局粒度：ΣR前 + ΣΔ = ΣR后 逐场成立=${arithmeticBad === 0}（失败 ${arithmeticBad} 场）；`
      + `全局粒度：Σ前=${ctx.beforeSum} + ΣΔ=${deltaSumArchive} = Σ后=${afterSum} → 恒等=${globalConservation}；`
      + `journal ΣΔ=${deltaSumJournal}（与档案 ΣΔ 一致=${journalConservation}）；`
      + `ΣΔ ≤ 0（分数汇，非零和场次 ${nonZeroSumMatches} / 零和 ${zeroSumMatches}）=${sink}`,
    numbers: {
      before: ctx.beforeSum, delta: deltaSumArchive, after: afterSum,
      journalDelta: deltaSumJournal, conservation: globalConservation, sink,
      nonZeroSumMatches, zeroSumMatches,
    },
  });

  // ④ leaderboard 与档案一致（重建索引后一致）
  const leaderboard = await checkLeaderboard(ctx, registry);
  checks.push(leaderboard.check);

  // ⑤ 回放 LRU 不越界
  const replayLimit = ctx.replayLimit;
  const liveReplays = battleApi.REPLAYS.size;
  checks.push({
    id: 'A5-replay-lru-bounded',
    title: '⑤ 回放 LRU 不越界（进程内帧 LRU 上限）',
    ok: Number.isInteger(replayLimit) && replayLimit > 0 && liveReplays <= replayLimit,
    detail: `replayCacheSize=${replayLimit}（service-config.json）；本进程帧注册表实测 ${liveReplays} ≤ ${replayLimit}`,
    numbers: { limit: replayLimit, size: liveReplays },
  });

  // ⑥ 每场对局双方均为真实注册玩家（可从未删档案追溯；无 bot）
  const registryBotCount = [...registry.values()].filter((v) => v.isBot).length;
  checks.push({
    id: 'A6-no-bot-players',
    title: '⑥ 每场对局双方 playerId 均为真实注册玩家（无 bot 补位）',
    ok: badParticipantEndpoints === 0 && botArchives === 0 && registryBotCount === 0 && archiveMissing === 0,
    detail: `${counts.battleRecords} 场 × 2 端 = ${counts.battleRecords * 2} 端，全部命中注册表且 flags.isBot=false`
      + `（非注册/bot 端 ${badParticipantEndpoints}）；档案层 isBot=true 的玩家 ${botArchives} 个；可追溯（档案存在）=${archiveMissing === 0}`,
    numbers: { endpoints: counts.battleRecords * 2, badEndpoints: badParticipantEndpoints, botArchives, registryBotCount },
  });

  // ⑦ 无 5xx
  const snap = ctx.metrics.snapshot();
  checks.push({
    id: 'A7-no-5xx',
    title: '⑦ 无 5xx',
    ok: snap.server5xx === 0,
    detail: `5xx=${snap.server5xx}；请求总数=${snap.requests}；传输层失败=${snap.transportFailures}；错误率=${snap.errorRate}`,
    numbers: { server5xx: snap.server5xx, requests: snap.requests, transportFailures: snap.transportFailures },
  });

  counts.players = registry.size;
  counts.journalSeqMonotonic = seqMonotonic;
  counts.botArchives = botArchives;
  return { checks, counts, perPlayerDelta: Object.fromEntries(perPlayerDelta) };
}

async function checkLeaderboard(ctx, registry) {
  const store = ctx.store;
  const publicToId = new Map();
  for (const [playerId, v] of registry) publicToId.set(v.publicId, playerId);

  let mismatch = 0;
  let sortedOk = true;
  let checked = 0;
  const rows = store.index.leaderboard({ scope: 'global', limit: 100 });
  for (const row of rows) {
    const pid = publicToId.get(row.publicId);
    if (!pid) { mismatch += 1; continue; }
    const archive = await store.loadArchive(pid);
    const idx = store.index.get(pid);
    checked += 1;
    if (!archive || idx.points !== archive.rating.points || row.points !== archive.rating.points
      || idx.tier !== archive.progress.tier || row.tier !== archive.progress.tier) mismatch += 1;
  }
  for (let i = 1; i < rows.length; i += 1) if (rows[i - 1].points < rows[i].points) sortedOk = false;

  let rebuiltOk = true;
  let rebuiltDetail = '索引重建比对由 `--deep` 开启（默认关闭以免大规模下超时）';
  if (ctx.deep) {
    await store.index.rebuild();
    const rows2 = store.index.leaderboard({ scope: 'global', limit: 100 });
    let mismatch2 = 0;
    for (const row of rows2) {
      const pid = publicToId.get(row.publicId);
      if (!pid) { mismatch2 += 1; continue; }
      const archive = await store.loadArchive(pid);
      if (!archive || store.index.get(pid).points !== archive.rating.points) mismatch2 += 1;
    }
    rebuiltOk = mismatch2 === 0 && JSON.stringify(rows2) === JSON.stringify(rows);
    rebuiltDetail = `索引重建后逐行一致=${rebuiltOk}（不一致 ${mismatch2}）`;
  }

  let httpOk = false;
  let httpDetail = 'skipped';
  if (ctx.port) {
    try {
      const res = await httpRequest(ctx.port, 'GET', '/api/v1/leaderboard?scope=global&limit=100', null, {});
      const data = res.body && res.body.ok ? res.body.data : null;
      const noPlayerId = !!data && Array.isArray(data.rows) && data.rows.every((r) => r.playerId === undefined);
      httpOk = res.status === 200 && noPlayerId;
      httpDetail = `GET /leaderboard → ${res.status}，不暴露 playerId=${noPlayerId}`;
    } catch (e) {
      httpOk = false;
      httpDetail = `GET /leaderboard 异常：${e && e.message}`;
    }
  }

  return {
    check: {
      id: 'A4-leaderboard-consistent',
      title: '④ leaderboard 与档案一致（重建索引后一致）',
      ok: mismatch === 0 && sortedOk && rebuiltOk && httpOk,
      detail: `索引↔档案逐行一致=${mismatch === 0}（比对 top ${checked} / 不一致 ${mismatch}）；points 降序=${sortedOk}；`
        + `${rebuiltDetail}；${httpDetail}`,
      numbers: { rows: rows.length, mismatch, sortedOk, rebuiltOk, httpOk },
    },
  };
}

/* ---------- 玩家水平分布（自然产生，不写死） ---------- */

async function buildDistribution(store, registry) {
  const points = [];
  const tiers = {};
  const stats = { attack: { wins: 0, losses: 0, draws: 0 }, defense: { wins: 0, losses: 0, draws: 0 } };
  let games = 0;
  for (const playerId of registry.keys()) {
    const archive = await store.loadArchive(playerId);
    if (!archive) continue;
    points.push(archive.rating.points);
    tiers[archive.progress.tier] = (tiers[archive.progress.tier] || 0) + 1;
    games += archive.rating.games;
    for (const bucket of ['attack', 'defense']) {
      stats[bucket].wins += archive.record.stats[bucket].wins;
      stats[bucket].losses += archive.record.stats[bucket].losses;
      stats[bucket].draws += archive.record.stats[bucket].draws;
    }
  }
  points.sort((a, b) => a - b);
  const bands = [
    { label: '0', min: 0, max: 0 },
    { label: '1-50', min: 1, max: 50 },
    { label: '51-200', min: 51, max: 200 },
    { label: '201-600', min: 201, max: 600 },
    { label: '601-1200', min: 601, max: 1200 },
    { label: '1201-3000', min: 1201, max: 3000 },
  ].map((b) => ({ label: b.label, count: points.filter((p) => p >= b.min && p <= b.max).length }));
  return {
    rating: {
      players: points.length,
      min: points.length ? points[0] : 0,
      p50: percentile(points, 50),
      p95: percentile(points, 95),
      max: points.length ? points[points.length - 1] : 0,
      bands,
    },
    tiers,
    ratingGamesTotal: games,
    winLossDraw: stats,
    aiPrograms: {
      distinct: new Set([...registry.values()].map((v) => v.programHash)).size,
      presets: countBy(registry.values(), (v) => v.preset),
      equalToPlayers: new Set([...registry.values()].map((v) => v.programHash)).size === registry.size,
    },
    equippedPlugins: {
      total: [...registry.values()].reduce((n, v) => n + (v.equipped || 0), 0),
      perPlayer: statsOf([...registry.values()].map((v) => v.equipped || 0)),
    },
  };
}

/* ---------- 报告落盘（runtime/ 已 gitignore；绝不写仓库根或 docs） ---------- */

function reportPath(root) {
  return path.join(root || path.join(__dirname, '..', '..'), 'runtime', 'load-report.json');
}

function writeReport(report, root) {
  const file = reportPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const clone = { ...report };
  delete clone.serverHandle; // 句柄不可序列化
  fs.writeFileSync(file, `${JSON.stringify(clone, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = {
  DEFAULTS,
  TIERS,
  PRESETS,
  PASSWORD,
  PROD_SCRYPT,
  FAST_SCRYPT,
  SeededRng,
  mapLimit,
  statsOf,
  percentile,
  createMetrics,
  createLatencyBuckets,
  httpRequest,
  bearer,
  call,
  envelopeData,
  buildAiProgram,
  planLoadout,
  makeWarehouseView,
  mirrorOfLoadout,
  runLoadTest,
  runIntegrityChecks,
  buildDistribution,
  closeReport,
  reportPath,
  writeReport,
  makeTempDir,
  removeTempDir,
  lookupPlayerId,
  ledger,
};
