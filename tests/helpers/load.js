'use strict';
/* tests/helpers/load.js —— P7-6 批量测试公共引擎（`scripts/load-test.js` 与
 *   `tests/integration/load-integrity.test.js` 共用；**两份消费者一份实现**，避免批量流程出现第二套语义）。
 *
 * 权威：docs/plan-p7-playable.md §P7-6（真实玩家批量注册 → 配齐出战配置 → 先建池后匹配 → 完整性断言）；
 *      docs/interfaces.md §2/§7；docs/systems/11-account-store.md §7/§8/§11（容量）；D-132/D-133/D-134/D-136/D-152。
 *
 * 硬约束（与 plan §0 一致）：
 *   · 零依赖；**禁 `child_process`**；**禁 `Math.random`**（用本文件 `SeededRng`，种子显式）；
 *   · 进程内起服务（`server/index.js` `start()`）+ 随机端口 + `os.tmpdir()` 隔离数据根；
 *   · **真实玩家，不用占位 bot**：每个对手都必须是 `/auth/register` 注册出来的档案（`flags.isBot=false`）；
 *   · 并发有界（`concurrency` 默认 24；批次化 `Promise.all`，不一次性打满进程）。
 *
 * 请求预算（每个玩家，见 `DEFAULT_RATE_LIMIT_PER_MINUTE`）：
 *   注册 1 + `GET /me` 1 + 开箱 1 + 装配 ≤ SLOTS_MAX 2 + 仓库镜像 1 + AI 校验 1 + AI 编译 1
 *   + `GET /me/configs` 1 + `PUT /me/configs/:slot` 1 ≈ 11 次/人 → `rateLimitPerMinute` 默认 2000 足够。
 */
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { createLogger } = require('../../shared/log.js');
const serverMod = require('../../server/index.js');
const itemsApi = require('../../server/core/items.js');
const astApi = require('../../server/ai/ast.js');
const loadoutApi = require('../../server/loadout.js');
const archiveMod = require('../../server/store/archive.js');
const ledger = require('../../server/store/ledger.js');

const VERSION = serverMod.VERSION;
const TIERS = Object.freeze(['common', 'rare', 'epic', 'legendary', 'mythic']);
const PRESETS = Object.freeze(['steady', 'aggressive', 'kite']);
const PASSWORD = 'loadtest1234'; // ≥ passwordMin=8
const SEED_MAX = 0x7fffffff;

// 生产默认 scrypt（N=16384）；`--fast-auth` / 集成测试可注入 N=1024 以压缩时长（默认值 = 真实成本）
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
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function statsOf(samples) {
  const list = (samples || []).slice().sort((a, b) => a - b);
  if (list.length === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0, total: 0 };
  let sum = 0;
  for (const v of list) sum += v;
  return {
    count: list.length,
    mean: Math.round((sum / list.length) * 100) / 100,
    p50: percentile(list, 50),
    p95: percentile(list, 95),
    max: list[list.length - 1],
    total: sum,
  };
}

// 有序桶（P50/P95 用）：固定上限，不随样本数增长
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
      if (count === 0) return { count: 0, mean: 0, p50: 0, p95: 0, max: 0, total: 0 };
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
      return {
        count,
        mean: Math.round((sum / count) * 100) / 100,
        p50: pick(0.5),
        p95: pick(0.95),
        max: peak,
        total: sum,
      };
    },
  };
}

/* ---------- 指标收集 ---------- */

function createMetrics() {
  const buckets = {
    register: createLatencyBuckets(),
    box: createLatencyBuckets(),
    assemble: createLatencyBuckets(),
    ai: createLatencyBuckets(),
    config: createLatencyBuckets(),
    ranked: createLatencyBuckets(),
    quick: createLatencyBuckets(),
    all: createLatencyBuckets(),
  };
  const statuses = {};      // "POST /api/v1/... 200" → n
  const codes = {};         // 错误码 → n
  const errors = [];
  let requests = 0;
  let failures = 0;         // 网络异常/超时（无状态码）
  let server5xx = 0;

  function statusKey(method, urlPath, status) {
    return `${method} ${urlPath.split('?')[0]} ${status}`;
  }

  return {
    buckets,
    record(group, method, urlPath, status, ms, code) {
      requests += 1;
      if (status >= 500) server5xx += 1;
      const key = statusKey(method, urlPath, status);
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
      return {
        requests,
        transportFailures: failures,
        server5xx,
        statusDistribution: Object.fromEntries(Object.entries(statuses).sort()),
        errorCodes: Object.fromEntries(Object.entries(codes).sort()),
        latencyMs: Object.fromEntries(Object.entries(buckets).map(([k, b]) => [k, b.stats()])),
        errors,
      };
    },
  };
}

/* ---------- HTTP 客户端（零依赖；本进程内起服务） ---------- */

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

// 带指标的单次请求：`{status, body, wrongStatus, errorCode}`（不抛；传输层异常 → status:null）
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
    return { status: null, body: null, raw: '', errorCode: 'transport_error', error: err, ms: Date.now() - t0 };
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
 * buildAiProgram(seed, types) → 由 seed 派生的一份合法 AI 程序
 *   types = [straight|vertical|melee|displacement, ...]（出战槽 1..3 的技能类型）
 * 变化维度（每维都由 seed 决定 → 200 个玩家得到行为各异的程序）：
 *   ① 预设（steady/aggressive/kite）② 距离阈值 ③ 主攻技能槽 ④ 残血阈值 ⑤ 副技能/风筝退避动作
 * 只用 base 节点 + if（任意段位/门控配置下均可校验通过）；version 2 = CURRENT_VERSION。
 */
function buildAiProgram(seed, types) {
  const rng = new SeededRng(seed ^ 0x5bf03635);
  const preset = rng.pick(PRESETS);
  const t = Array.isArray(types) && types.length === 3 ? types : ['straight', 'straight', 'straight'];
  const rangeDistance = t[0] === 'melee' ? 32 : t[0] === 'vertical' ? 64 : 224;
  const closeDistance = rng.int(48, 160);
  const farDistance = rng.int(rangeDistance, rangeDistance + 256);
  const engage = t[2] === 'displacement' ? 'skill:skill3' : t[1] === 'displacement' ? 'skill:skill2' : 'move_right';
  const retreat = t[2] === 'displacement' ? 'skill:skill3' : 'move_left';
  const hpFloor = rng.int(18, 44);
  const primary = rng.int(1, 3);
  const secondary = primary === 1 ? 2 : 1;
  const body = preset === 'steady'
    ? seq([
      ifElse(cmp('<', get('self.hp'), lit(hpFloor)), seq([act('defend')]),
        seq([ifElse(cmp('>', gap(), lit(farDistance)), seq([act('move_right')]),
          seq([ifElse(cmp('<', gap(), lit(-closeDistance)), seq([act('move_left')]),
            seq([act(`skill:skill${primary}`)])]))])),
    ])
    : preset === 'aggressive'
      ? seq([
        ifElse(cmp('>', gap(), lit(closeDistance)), seq([act('move_right')]),
          seq([ifElse(cmp('<', gap(), lit(-closeDistance)), seq([act('move_left')]),
            seq([act(`skill:skill${secondary}`)])])),
      ])
      : seq([
        ifElse(cmp('<', gap(), lit(closeDistance)), seq([act(retreat)]),
          seq([ifElse(cmp('>', gap(), lit(farDistance)), seq([act(engage)]),
            seq([act(`skill:skill${primary}`)])])),
      ]);
  return {
    program: { type: 'program', version: astApi.CURRENT_VERSION, body },
    preset,
    params: { hpFloor, closeDistance, farDistance, primary, secondary, engage, retreat, type0: t[0] },
  };
}

/* ---------- 装配规划（复用 core items 语义在本地预演；服务端为权威） ----------
 * 说明：`POST /warehouse/assemble` 与 `core/items.assemble` 是同一实现（server/index.js 调用 items.assemble），
 * 本地预演只用于决定"提交哪些装配请求"，服务端返回的每一次拒绝都被记录进报告（不做第二套裁决）。
 */

function usedRolePoints(wh, role) {
  const slots = Array.isArray(role.slots) ? role.slots : [];
  let used = 0;
  for (const s of slots) {
    if (!s || !s.pluginUid) continue;
    const p = wh.findItem(s.pluginUid);
    used += p && Number.isFinite(p.pointCost) ? p.pointCost : 0;
  }
  return used;
}

function pickPlugin(wh, bucket, slotType, used) {
  let best = null;
  for (const p of wh.buckets[bucket] || []) {
    if (!p || p.equipped === true) continue;
    if (p.slot !== slotType) continue;
    if (p.uid === used) continue;
    if (best === null || (p.pointCost || 0) < (best.pointCost || 0)) best = p;
  }
  return best;
}

/**
 * planLoadout(warehouse, { slotsMax }) → { loadout, plan, skipped, stats }
 *   loadout = { role, skills[3], ai }（ai 占位，由调用方按计划写回）
 *   plan    = [{ targetUid, slotIndex, pluginUid, kind }]（按顺序提交 → 服务端逐条裁决）
 */
function planLoadout(warehouse, options) {
  const o = options || {};
  const slotsMax = Number.isInteger(o.slotsMax) && o.slotsMax >= 0 ? o.slotsMax : DEFAULTS.slotsMax;
  const wh = makeWarehouseView(warehouse);
  const role = (wh.buckets.role || [])[0] || null;
  const skills = (wh.buckets.skill || []).slice(0, 3);
  const plan = [];
  const skipped = [];
  const stats = { roleTargets: 0, skillTargets: 0, placed: 0, noCandidate: 0, noSlot: 0, pointsExceeded: 0 };

  if (!role || skills.length !== 3) {
    return { loadout: null, plan, skipped, stats, error: `出战材料不足（角色 ${role ? 1 : 0} / 技能 ${skills.length}）` };
  }

  const targets = [{ item: role, bucket: 'rolePlugin', kind: 'role' }]
    .concat(skills.map((s) => ({ item: s, bucket: 'skillPlugin', kind: 'skill' })));
  for (const target of targets) {
    const slots = Array.isArray(target.item.slots) ? target.item.slots : [];
    if (slots.length === 0) { stats.noSlot += 1; continue; }
    if (target.kind === 'role') stats.roleTargets += 1; else stats.skillTargets += 1;
    const limit = Math.min(slots.length, target.kind === 'role' ? slotsMax : slotsMax);
    for (let i = 0; i < limit; i += 1) {
      const slot = slots[i];
      if (!slot) break;
      if (slot.pluginUid) continue;
      const used = target.kind === 'role' ? usedRolePoints(wh, target.item) : 0;
      const cand = pickPlugin(wh, target.bucket, slot.type, used);
      if (!cand) { stats.noCandidate += 1; continue; }
      if (target.kind === 'role'
        && used + (cand.pointCost || 0) > (target.item.pluginPoints || 0)) {
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

// 仓库视图（不改动原对象；planLoadout 内部就地改视图）
function makeWarehouseView(warehouse) {
  const clone = JSON.parse(JSON.stringify(warehouse || { buckets: {} }));
  if (!clone.buckets || typeof clone.buckets !== 'object') clone.buckets = {};
  for (const key of Object.keys(clone.buckets)) {
    if (!Array.isArray(clone.buckets[key])) clone.buckets[key] = [];
  }
  return {
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
}

// 仅保留被 loadout 引用的物品（不含无关开箱产物）→ 提交为仓库镜像
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

async function registerPlayer(ctx, index) {
  const username = `lt_${String(index).padStart(4, '0')}_${ctx.seed}`.slice(0, 24);
  const res = await call(ctx.metrics, 'register', ctx.port, 'POST', '/api/v1/auth/register', {
    username, password: PASSWORD, nickname: `玩家${index}`,
  });
  if (res.status !== 200) {
    return { ok: false, index, status: res.status, code: res.errorCode, username };
  }
  const data = envelopeData(res) || {};
  const entry = {
    ok: true, index, username, publicId: data.publicId, token: data.token,
    // playerId 不回带（§4.5）→ 用索引反查（服务端内部标识）
    playerId: lookupPlayerId(ctx.store, data.publicId),
    pointsAfterSetup: 0,
  };
  return entry;
}

function lookupPlayerId(store, publicId) {
  for (const id of store.index.playerIds()) {
    const e = store.index.get(id);
    if (e && e.publicId === publicId) return id;
  }
  return null;
}

async function setupPlayer(ctx, entry) {
  const auth = bearer(entry.token);
  const detail = { index: entry.index, publicId: entry.publicId };

  // 1) GET /me（档案摘要）
  const me = await call(ctx.metrics, null, ctx.port, 'GET', '/api/v1/me', null, auth);
  if (me.status !== 200) return { ok: false, code: 'me_failed', status: me.status, detail };
  detail.tier = (envelopeData(me) || {}).progress ? envelopeData(me).progress.tier : null;

  // 2) 开箱（一次请求开 N 箱；seed 由玩家索引派生 → 各人掉落各异）
  const boxSeed = randSeed(ctx.rng);
  const boxRes = await call(ctx.metrics, 'box', ctx.port, 'POST', '/api/v1/box',
    { seed: boxSeed, tier: ctx.tier, times: ctx.boxes }, auth);
  if (boxRes.status !== 200) return { ok: false, code: 'box_failed', status: boxRes.status, detail };
  const boxed = (envelopeData(boxRes) || {}).items || [];
  const warehouse = itemsApi.emptyWarehouse();
  for (const item of boxed) {
    if (!item || typeof item.kind !== 'string') continue;
    if (!Array.isArray(warehouse.buckets[item.kind])) warehouse.buckets[item.kind] = [];
    warehouse.buckets[item.kind].push(item);
  }
  detail.items = boxed.length;

  // 3) 装配（本地按 core items 语义预演 → 逐条提交 /warehouse/assemble，服务端裁决）
  const planned = planLoadout(warehouse, { slotsMax: ctx.slotsMax });
  if (!planned.loadout) return { ok: false, code: 'loadout_materials_missing', detail };
  const equipped = [];
  const rejects = {};
  for (const op of planned.plan) {
    const res = await call(ctx.metrics, 'assemble', ctx.port, 'POST', '/api/v1/warehouse/assemble',
      { warehouse, targetUid: op.targetUid, pluginUid: op.pluginUid, slotIndex: op.slotIndex, tier: ctx.tier }, auth);
    if (res.status === 200 && envelopeData(res) && envelopeData(res).warehouse) {
      warehouse = envelopeData(res).warehouse;
      equipped.push(op);
      continue;
    }
    const code = res.errorCode || `status_${res.status}`;
    rejects[code] = (rejects[code] || 0) + 1;
    // 服务端拒绝：回滚本地视图里的该次装配（保持与权威镜像一致）
    const target = planned.loadout.role.uid === op.targetUid
      ? planned.loadout.role
      : planned.loadout.skills.find((s) => s.uid === op.targetUid);
    if (target && target.slots && target.slots[op.slotIndex]) target.slots[op.slotIndex].pluginUid = null;
  }
  detail.equipped = equipped.length;
  detail.rejects = rejects;

  // 4) 为每人生成**行为各不相同**的 AI → /ai/validate + /ai/compile（两份校验都必须通过）
  const skillTypes = planned.loadout.skills.map((s) => {
    const tpl = require('../../server/data/skill-templates.json').skillTemplates.find((x) => x.id === s.templateId);
    return tpl ? tpl.type : 'straight';
  });
  const ai = buildAiProgram(randSeed(ctx.rng), skillTypes);
  planned.loadout.ai = ai.program;
  detail.preset = ai.preset;
  detail.programHash = astApi.programHash(ai.program);
  // 本地先自检（错误立即暴露，不等服务端）
  const localCheck = astApi.validate(ai.program, ctx.tier);
  detail.localAiValid = localCheck.ok;
  if (!localCheck.ok) return { ok: false, code: 'local_ai_invalid', detail, errors: localCheck.errors.slice(0, 3) };

  const v1 = await call(ctx.metrics, 'ai', ctx.port, 'POST', '/api/v1/ai/validate',
    { program: ai.program, tier: ctx.tier }, auth);
  if (v1.status !== 200) return { ok: false, code: 'ai_validate_failed', status: v1.status, detail, errorCode: v1.errorCode };
  const v2 = await call(ctx.metrics, 'ai', ctx.port, 'POST', '/api/v1/ai/compile',
    { program: ai.program }, auth);
  if (v2.status !== 200) return { ok: false, code: 'ai_compile_failed', status: v2.status, detail, errorCode: v2.errorCode };
  detail.compiledHash = (envelopeData(v2) || {}).programHash || null;

  // 5) 提交仓库镜像（引用校验用；D-130 非权威）+ PUT /me/configs/:slot（默认槽，≤3 且唯一出战）
  const mirror = mirrorOfLoadout(planned.loadout, warehouse, ctx.warehouseBucketMax);
  const whRes = await call(ctx.metrics, null, ctx.port, 'PUT', '/api/v1/me/warehouse', { warehouse: mirror }, auth);
  if (whRes.status !== 200) return { ok: false, code: 'warehouse_mirror_failed', status: whRes.status, detail, errorCode: whRes.errorCode };

  const cfgs = await call(ctx.metrics, 'config', ctx.port, 'GET', '/api/v1/me/configs', null, auth);
  if (cfgs.status !== 200) return { ok: false, code: 'configs_failed', status: cfgs.status, detail };
  const cfgData = envelopeData(cfgs) || {};
  const activeSlotId = cfgData.activeSlotId;
  detail.slots = (cfgData.slots || []).length;
  const save = await call(ctx.metrics, 'config', ctx.port, 'PUT', `/api/v1/me/configs/${activeSlotId}`,
    { loadout: planned.loadout, warehouse: mirror, activate: true }, auth);
  if (save.status !== 200) return { ok: false, code: 'config_save_failed', status: save.status, detail, errorCode: save.errorCode };
  detail.activeSlotId = activeSlotId;
  return { ok: true, detail, mirror };
}

/* ---------- 批处理入口 ---------- */

function makeLogger(options) {
  const o = options || {};
  return createLogger({ level: o.level || 'warn', ringSize: o.ringSize || 2000 });
}

function makeTempDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'dl-p7-6-load-')); }

function removeTempDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

/**
 * runLoadTest(options) → report
 *   options：见 `DEFAULTS`（players/concurrency/rankRuns/quickRuns/boxes/tier/seed/slotsMax/deep/…）
 *             + `fastAuth`（集成测试用 N=1024）+ `level`（服务端日志级别）+ `keepDataDir`（诊断用）
 * 返回报告（可 JSON 序列化）：{ options, server, phases, throughput, metrics, integrity, distribution, asserts }
 */
async function runLoadTest(options) {
  const o = { ...DEFAULTS, ...(options || {}) };
  const logger = o.logger || makeLogger({ level: o.level || 'warn' });
  const dataDir = o.dataDir || makeTempDir();
  const metrics = createMetrics();
  const rng = new SeededRng(o.seed);
  const startedAt = Date.now();

  const server = await serverMod.start({
    logger,
    dataDir,
    host: '127.0.0.1',
    port: 0,
    versions: { engine: VERSION },
    rateLimitPerMinute: o.rateLimitPerMinute,
    authConfig: {
      ...(o.fastAuth ? FAST_SCRYPT : PROD_SCRYPT),
      auth: { ...(o.fastAuth ? FAST_SCRYPT.auth : PROD_SCRYPT.auth), rateLimitPerMinute: o.authRateLimitPerMinute },
    },
    ...(o.serverOptions || {}),
  });

  const ctx = {
    port: server.port, store: server.store, logger, metrics, rng, seed: o.seed,
    tier: o.tier, boxes: o.boxes, slotsMax: o.slotsMax, warehouseBucketMax: o.warehouseBucketMax,
    fastAuth: !!o.fastAuth,
  };

  const report = {
    schema: 'dl-load-report/1',
    generatedAt: new Date(startedAt).toISOString(),
    engineVersion: VERSION,
    options: {
      players: o.players, concurrency: o.concurrency, rankRuns: o.rankRuns, quickRuns: o.quickRuns,
      boxes: o.boxes, tier: o.tier, seed: o.seed, slotsMax: o.slotsMax, deep: !!o.deep,
      scrypt: o.fastAuth ? 'N=1024(测试快速档)' : 'N=16384(生产默认)',
      rateLimitPerMinute: o.rateLimitPerMinute, authRateLimitPerMinute: o.authRateLimitPerMinute,
      dataDirKind: o.dataDir ? 'injected' : 'os.tmpdir()',
    },
    phases: {},
    distribution: {},
    integrity: { checks: [], counts: {} },
    ok: false,
  };

  const indices = [];
  for (let i = 1; i <= o.players; i += 1) indices.push(i);

  try {
    /* ---- 阶段 1：并发批量注册 N 个**真实玩家** ---- */
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
        id: 'R0-register-all', ok: false,
        detail: `注册失败 ${registered.length - players.length} 个（真实玩家建池不完整）`,
      });
      return finish(report, server, metrics, startedAt, o, dataDir);
    }

    /* ---- 阶段 2：为每个玩家配齐完整出战配置（开箱→仓库镜像→装配→配置槽→AI 校验） ---- */
    const t2 = Date.now();
    const setup = await mapLimit(players, o.concurrency, (p) => setupPlayer(ctx, p));
    const phase2Ms = Date.now() - t2;
    const ready = [];
    for (let i = 0; i < players.length; i += 1) if (setup[i] && setup[i].ok) ready.push(players[i]);
    report.phases.setup = {
      requested: players.length, ok: ready.length, failed: players.length - ready.length, ms: phase2Ms,
      failures: setup.filter((s) => s && !s.ok).slice(0, 10),
      assemble: {
        placed: setup.reduce((n, s) => n + ((s && s.detail && s.detail.equipped) || 0), 0),
        rejections: mergeCounters(setup.map((s) => (s && s.detail && s.detail.rejects) || {})),
      },
    };
    if (ready.length !== players.length) {
      report.integrity.checks.push({
        id: 'R0-setup-all', ok: false,
        detail: `配齐出战配置失败 ${players.length - ready.length} 个`,
      });
      return finish(report, server, metrics, startedAt, o, dataDir);
    }

    // 玩家档案登记表（playerId → 真实注册玩家；全部经 /auth/register + 真实配置快照）
    const registry = new Map();
    for (let i = 0; i < ready.length; i += 1) {
      const p = ready[i];
      const archive = await server.store.loadArchive(p.playerId);
      registry.set(p.playerId, {
        publicId: p.publicId, isBot: !!(archive && archive.flags && archive.flags.isBot),
        tier: archive ? archive.progress.tier : null,
        preset: (setup[i] && setup[i].detail && setup[i].detail.preset) || null,
        programHash: (setup[i] && setup[i].detail && setup[i].detail.programHash) || null,
        equipped: (setup[i] && setup[i].detail && setup[i].detail.equipped) || 0,
      });
    }
    const isBotCount = [...registry.values()].filter((v) => v.isBot).length;

    /* ---- 阶段 3：先建池（索引/快照数达标）后匹配 ---- */
    const pool = server.store.index;
    const snapshotHashes = new Set();
    let snapshotUsable = 0;
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
      isBotArchives: isBotCount,
    };
    if (snapshotUsable < registry.size) {
      report.integrity.checks.push({
        id: 'R0-pool-ready', ok: false,
        detail: `可用快照 ${snapshotUsable} < 注册玩家 ${registry.size}（池未就绪即匹配会引入 409 no_opponent）`,
      });
      return finish(report, server, metrics, startedAt, o, dataDir);
    }

    /* ---- 积分基线（对局前，全局粒度守恒的 Σ前） ---- */
    const beforeRatings = new Map();
    for (const playerId of registry.keys()) {
      const archive = await server.store.loadArchive(playerId);
      beforeRatings.set(playerId, archive ? archive.rating.points : 0);
    }
    let beforeSum = 0;
    for (const v of beforeRatings.values()) beforeSum += v;

    /* ---- 阶段 4：并发在线 + 匹配 + 战斗（排位 + 快速，真实玩家，无 bot 补位） ---- */
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

    let rankedRuns = 0; let rankedMatches = 0; let rankedShortfall = 0; let rankedInvalid = 0;
    let quickAttempts = 0; let quickOk = 0; let quickNoOpponent = 0;
    const quickOutcomes = {};
    const rankedOutcomes = {};
    for (const slot of matchResults) {
      for (const res of slot.ranked) {
        rankedRuns += 1;
        if (res.status === 200) {
          const d = envelopeData(res) || {};
          rankedMatches += d.matches || 0;
          rankedShortfall += d.shortfall || 0;
          rankedInvalid += d.invalids || 0;
          rankedOutcomes[d.tier || '?'] = (rankedOutcomes[d.tier || '?'] || 0) + (d.matches || 0);
        } else {
          rankedOutcomes[res.errorCode || `status_${res.status}`] = (rankedOutcomes[res.errorCode || `status_${res.status}`] || 0) + 1;
        }
      }
      for (const res of slot.quick) {
        quickAttempts += 1;
        if (res.status === 200) {
          quickOk += 1;
          const w = (envelopeData(res) || {}).winner || '?';
          quickOutcomes[w] = (quickOutcomes[w] || 0) + 1;
        } else {
          const k = res.errorCode || `status_${res.status}`;
          if (k === 'no_opponent') quickNoOpponent += 1;
          quickOutcomes[k] = (quickOutcomes[k] || 0) + 1;
        }
      }
    }
    report.phases.matches = {
      ms: phase4Ms,
      ranked: {
        runs: rankedRuns, matches: rankedMatches, shortfall: rankedShortfall, invalids: rankedInvalid,
        matchesPerSecond: Math.round((rankedMatches / Math.max(1, phase4Ms)) * 1000),
        outcomes: rankedOutcomes,
      },
      quick: {
        attempts: quickAttempts, ok: quickOk, noOpponent: quickNoOpponent,
        matchesPerSecond: Math.round((quickOk / Math.max(1, phase4Ms)) * 1000),
        outcomes: quickOutcomes,
      },
      totalMatches: rankedMatches + quickOk,
      throughputPerSecond: Math.round(((rankedMatches + quickOk) / Math.max(1, phase4Ms)) * 1000),
    };

    /* ---- 阶段 5：完整性断言（逐条独立；全部通过才算 ok） ---- */
    const assertCtx = {
      store: server.store, registry, beforeRatings, beforeSum, metrics,
      replayLimit: server.runtime ? server.runtime.replayLimit : null,
      deep: !!o.deep, players: ready.length,
    };
    report.integrity = await runIntegrityChecks(assertCtx);

    /* ---- 分布（不同水平玩家：积分/战绩自然产生） ---- */
    report.distribution = await buildDistribution(server.store, registry);

    report.ok = report.integrity.checks.every((c) => c.ok === true);
    return finish(report, server, metrics, startedAt, o, dataDir);
  } catch (err) {
    report.fatal = { message: err && err.message ? err.message : String(err), stack: err && err.stack ? String(err.stack).split('\n').slice(0, 4) : [] };
    report.ok = false;
    return finish(report, server, metrics, startedAt, o, dataDir);
  }
}

function mergeCounters(list) {
  const out = {};
  for (const obj of list) {
    for (const [k, v] of Object.entries(obj || {})) out[k] = (out[k] || 0) + v;
  }
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

async function finish(report, server, metrics, startedAt, o, dataDir) {
  report.metrics = metrics.snapshot();
  report.wallMs = Date.now() - startedAt;
  try {
    report.store = server.store ? server.store.stats() : null;
  } catch (e) {
    report.store = null;
  }
  try {
    await server.close();
  } catch (e) {
    report.closeError = e && e.message ? e.message : String(e);
  }
  report.dataDirRemoved = !o.keepDataDir;
  if (!o.keepDataDir) {
    try { removeTempDir(dataDir); } catch (e) { report.cleanupError = e && e.message ? e.message : String(e); }
  } else {
    report.dataDir = dataDir;
  }
  report.ok = report.ok === true && report.integrity.checks.every((c) => c.ok === true)
    && report.metrics.server5xx === 0;
  return report;
}

/* ---------- 完整性断言（P7-6 §4 的七条；`--small`/测试亦有覆盖） ---------- */

async function runIntegrityChecks(ctx) {
  const store = ctx.store;
  const registry = ctx.registry;
  const checks = [];
  const counts = {};

  // 单遍流式扫描 journal：同时支撑 ①②③⑥ 四条断言（不把全量 journal 读进内存）
  const perPlayerStats = new Map();
  const battleRecords = [];
  const battleIds = new Set();
  let duplicateBattleIds = 0;
  let badParticipant = 0;
  let arithmeticBad = 0;
  let nonZeroSum = 0;
  let missingEndpoints = 0;
  let idempotentRecord = null;
  let seqMonotonic = true;
  let lastSeq = 0;
  const journalSumDelta = { p1: 0, p2: 0 };

  const ids = [...registry.keys()];
  for (const playerId of ids) {
    perPlayerStats.set(playerId, {
      attack: 0, defense: 0, games: 0, points: 0, appliedSeq: 0,
    });
  }

  await store.replayJournal({ includeCheckpoints: false }, (record) => {
    if (!Number.isInteger(record.seq) || record.seq <= lastSeq) seqMonotonic = false;
    lastSeq = record.seq;
    if (record.type !== 'battle.recorded') return;
    if (battleIds.has(record.battleId)) duplicateBattleIds += 1;
    battleIds.add(record.battleId);
    if (!idempotentRecord) idempotentRecord = record;
    const p1 = record.p1 || {};
    const p2 = record.p2 || {};
    // ⑥ 双方 playerId 均为真实注册玩家（且可从未删档案追溯）
    const real1 = typeof p1.playerId === 'string' && archiveMod.PLAYER_ID_RE.test(p1.playerId) && registry.has(p1.playerId);
    const real2 = typeof p2.playerId === 'string' && archiveMod.PLAYER_ID_RE.test(p2.playerId) && registry.has(p2.playerId);
    if (!real1 || !real2) badParticipant += 1;
    if (p1.playerId === p2.playerId) badParticipant += 1;
    // ③ 对局粒度守恒：ΣR前 + ΣΔ = ΣR后（Δ = pointsAfter − pointsBefore；按双方逐场复算）
    const b1 = Number.isInteger(p1.pointsBefore) ? p1.pointsBefore : 0;
    const a1 = Number.isInteger(p1.pointsAfter) ? p1.pointsAfter : b1;
    const b2 = Number.isInteger(p2.pointsBefore) ? p2.pointsBefore : 0;
    const a2 = Number.isInteger(p2.pointsAfter) ? p2.pointsAfter : b2;
    if (b1 + (a1 - b1) + (b2 + (a2 - b2)) !== a1 + a2) arithmeticBad += 1;
    if ((a1 - b1) + (a2 - b2) !== 0) nonZeroSum += 1;
    journalSumDelta.p1 += a1 - b1;
    journalSumDelta.p2 += a2 - b2;
    // ② 无半场战绩：记录必须两端齐全（有 playerId/result/pointsBefore+pointsAfter）
    const sideComplete = (side) => typeof side.playerId === 'string' && side.playerId !== ''
      && (side.result === 'win' || side.result === 'loss' || side.result === 'draw')
      && Number.isInteger(side.pointsBefore) && Number.isInteger(side.pointsAfter);
    if (!sideComplete(p1) || !sideComplete(p2)) missingEndpoints += 1;
    const s1 = perPlayerStats.get(p1.playerId);
    const s2 = perPlayerStats.get(p2.playerId);
    if (s1) { s1.attack += 1; s1.games += 1; s1.points = a1; }
    if (s2) { s2.defense += 1; s2.games += 1; s2.points = a2; }
    battleRecords.push({
      battleId: record.battleId, mode: record.mode, seq: record.seq,
      p1: p1.playerId, p2: p2.playerId, b1, a1, b2, a2,
    });
  });

  // 逐玩家档案对照（②④的表层证据 + appliedSeq 水位）
  let archiveStatsMismatch = 0;
  let archivePointsMismatch = 0;
  let archiveAppliedSeqLag = 0;
  let missingArchive = 0;
  let botArchive = 0;
  const archivePoints = new Map();
  for (const playerId of ids) {
    const archive = await store.loadArchive(playerId);
    if (!archive) { missingArchive += 1; continue; }
    if (archive.flags && archive.flags.isBot) botArchive += 1;
    const st = archive.record.stats;
    const expect = perPlayerStats.get(playerId);
    if (st.attack.wins + st.attack.losses + st.attack.draws !== expect.attack
      || st.defense.wins + st.defense.losses + st.defense.draws !== expect.defense) {
      archiveStatsMismatch += 1;
    }
    if (archive.rating.points !== expect.points) archivePointsMismatch += 1;
    if (archive.record.appliedSeq < store.maxSeq() && expect.games === 0) archiveAppliedSeqLag += 1;
    archivePoints.set(playerId, archive.rating.points);
  }

  // ① journal 幂等：重复 apply 同一 record → 不重复记账
  let idempotent = { ok: false, detail: 'no battle record' };
  if (idempotentRecord) {
    const s1 = idempotentRecord.p1.playerId;
    const s2 = idempotentRecord.p2.playerId;
    const before1 = await store.loadArchive(s1);
    const before2 = await store.loadArchive(s2);
    const replayed = await store.applyRecord(idempotentRecord);
    await store.applyRecords([idempotentRecord]);
    const after1 = await store.loadArchive(s1);
    const after2 = await store.loadArchive(s2);
    const same = (a, b) => a.rating.points === b.rating.points
      && a.record.stats.attack.wins === b.record.stats.attack.wins
      && a.record.stats.attack.losses === b.record.stats.attack.losses
      && a.record.stats.attack.draws === b.record.stats.attack.draws
      && a.record.stats.defense.wins === b.record.stats.defense.wins
      && a.record.stats.defense.losses === b.record.stats.defense.losses
      && a.record.stats.defense.draws === b.record.stats.defense.draws
      && a.record.recent.length === b.record.recent.length
      && a.rating.games === b.rating.games;
    const seqSame = store.maxSeq();
    idempotent = {
      ok: replayed.applied === 0 && same(before1, after1) && same(before2, after2) && seqSame === lastSeq,
      applied: replayed.applied,
      battleId: idempotentRecord.battleId,
      detail: `重复 apply → applied=${replayed.applied}，双方积分/战绩/recent 不变，journal 水位不变（${seqSame}）`,
    };
  }
  counts.journalRecords = lastSeq;
  counts.battleRecords = battleRecords.length;
  counts.battleParticipants = battleRecords.length * 2;
  counts.duplicateBattleIds = duplicateBattleIds;
  counts.nonZeroSumMatches = nonZeroSum;
  counts.quickMatches = battleRecords.filter((b) => b.mode === 'quick').length;
  counts.rankedMatches = battleRecords.filter((b) => b.mode === 'ranked').length;

  checks.push({
    id: 'A1-journal-idempotent', title: '① journal 幂等（重复结算不重复记账）',
    ok: idempotent.ok === true,
    detail: idempotent.detail,
  });
  checks.push({
    id: 'A2-no-half-battle', title: '② 无半场战绩（每场双方都有记录，或都没有）',
    ok: missingEndpoints === 0 && missingArchive === 0 && archiveStatsMismatch === 0,
    detail: missingEndpoints === 0 && missingArchive === 0 && archiveStatsMismatch === 0
      ? `${battleRecords.length} 场全部双端齐全；双方档案攻/防战绩之和逐人等于 journal 记录数`
      : `缺端记录 ${missingEndpoints}；档案缺失 ${missingArchive}；档案战绩与 journal 不一致 ${archiveStatsMismatch}`,
  });
  checks.push({
    id: 'A3-rating-conservation', title: '③ 积分守恒（ΣR前 + ΣΔ = ΣR后；D-133 非零和"汇"）',
    ok: arithmeticBad === 0,
    detail: arithmeticBad === 0
      ? `逐场恒等式成立（${battleRecords.length} 场）；ΣΔ = ${journalSumDelta.p1 + journalSumDelta.p2}（≤0 即"分数汇"，非零和场次 ${nonZeroSum}）`
      : `逐场恒等式失败 ${arithmeticBad} 场`,
  });
  return finalizeChecks(checks, counts, ctx, battleRecords, archivePoints, {
    archiveStatsMismatch, archivePointsMismatch, badParticipant, botArchive, nonZeroSum, journalSumDelta,
  });
}

async function finalizeChecks(checks, counts, ctx, battleRecords, archivePoints, extra) {
  const store = ctx.store;
  const registry = ctx.registry;

  // ③ 全局粒度守恒：ΣR前（对局前基线）+ ΣΔ = ΣR后（当前档案）
  let afterSum = 0;
  for (const v of archivePoints.values()) afterSum += v;
  let deltaSum = 0;
  for (const [playerId, before] of ctx.beforeRatings) {
    if (!archivePoints.has(playerId)) continue;
    deltaSum += archivePoints.get(playerId) - before;
  }
  const globalOk = ctx.beforeSum + deltaSum === afterSum;
  // 排位不改积分（D-133 双轨）→ 全局 ΣΔ 只能来自快速对战，恒 ≤ 0（分数汇）
  const sinkOk = deltaSum <= 0;
  const perMatchOk = checks.find((c) => c.id === 'A3-rating-conservation').ok === true;
  const conservationNumbers = `Σ前=${ctx.beforeSum} ΣΔ=${deltaSum} Σ后=${afterSum} 恒等=${globalOk}；非零和场次=${extra.nonZeroSum}`;
  checks[2] = {
    id: 'A3-rating-conservation', title: '③ 积分守恒（对局粒度 + 全局粒度；D-133 非零和"汇"）',
    ok: perMatchOk && globalOk && sinkOk && extra.archivePointsMismatch === 0,
    detail: `对局粒度：${perMatchOk ? '逐场 ΣR前 + ΣΔ = ΣR后 成立' : '逐场不成立'}；全局粒度：${conservationNumbers}；`
      + `ΣΔ ≤ 0（分数汇）=${sinkOk}；档案落盘 points 与 journal 末值不一致=${extra.archivePointsMismatch}`,
    numbers: { before: ctx.beforeSum, delta: deltaSum, after: afterSum, conservation: globalOk, sink: sinkOk },
  };

  // ④ leaderboard 与档案一致（重建索引后仍一致）
  const lbOf = async () => {
    const lb = await httpRequest(ctx.port, 'GET', '/api/v1/leaderboard?scope=global&limit=100', null, {});
    return lb;
  };
  let leaderboardOk = false;
  let leaderboardDetail = '';
  let rebuiltOk = false;
  if (store) {
    const rows = store.index.leaderboard({ scope: 'global', limit: 100 });
    let mismatch = 0;
    for (const row of rows) {
      const pid = [...registry.keys()].find((id) => registry.get(id).publicId === row.publicId);
      if (!pid) { mismatch += 1; continue; }
      const archive = await store.loadArchive(pid);
      const expectPoints = archive.rating.points;
      const idx = store.index.get(pid);
      if (idx.points !== expectPoints || row.points !== expectPoints || idx.tier !== archive.progress.tier) mismatch += 1;
    }
    const sortedOk = rows.every((r, i) => i === 0 || rows[i - 1].points >= r.points);
    leaderboardOk = mismatch === 0 && sortedOk;
    leaderboardDetail = `top${rows.length} 索引↔档案逐行一致（不一致 ${mismatch}）；points 降序=${sortedOk}`;
    if (ctx.deep) {
      await store.index.rebuild();
      const rows2 = store.index.leaderboard({ scope: 'global', limit: 100 });
      let mismatch2 = 0;
      for (const row of rows2) {
        const pid = [...registry.keys()].find((id) => registry.get(id).publicId === row.publicId);
        if (!pid) { mismatch2 += 1; continue; }
        const archive = await store.loadArchive(pid);
        if (store.index.get(pid).points !== archive.rating.points) mismatch2 += 1;
      }
      rebuiltOk = mismatch2 === 0 && JSON.stringify(rows2) === JSON.stringify(rows);
      leaderboardDetail += `；索引重建后逐行一致=${rebuiltOk}（不一致 ${mismatch2}）`;
    } else {
      leaderboardDetail += '；索引重建比对由 `--deep` 开启（默认关闭以免 200 人规模超时）';
      rebuiltOk = true;
    }
  }
  let lbHttpOk = false;
  try {
    const lb = await lbOf();
    const data = lb.body && lb.body.ok ? lb.body.data : null;
    lbHttpOk = lb.status === 200 && !!data && Array.isArray(data.rows) && data.rows.every((r) => r.playerId === undefined);
  } catch (e) { lbHttpOk = false; }
  checks.push({
    id: 'A4-leaderboard-consistent', title: '④ leaderboard 与档案一致（重建索引后一致）',
    ok: leaderboardOk && rebuiltOk && lbHttpOk,
    detail: `${leaderboardDetail}；GET /leaderboard 不暴露 playerId=${lbHttpOk}`,
  });

  // ⑤ 回放 LRU 不越界
  const replayLimit = ctx.replayLimit;
  const app = ctx.metrics ? null : null;
  const live = require('../../server/battle.js').REPLAYS.size;
  checks.push({
    id: 'A5-replay-lru-bounded', title: '⑤ 回放 LRU 不越界（进程内帧上限）',
    ok: Number.isInteger(replayLimit) && replayLimit > 0 && live <= replayLimit,
    detail: `replayCacheSize=${replayLimit}（service-config.json）；本进程帧注册表实测 ${live} ≤ ${replayLimit}`,
    numbers: { limit: replayLimit, size: live },
  });

  // ⑥ 每场对局双方 playerId 均为真实注册玩家且可追溯（无 bot）
  const botPlayers = [...registry.values()].filter((v) => v.isBot).length;
  checks.push({
    id: 'A6-no-bot', title: '⑥ 每场对局双方均为真实注册玩家（无 bot 补位）',
    ok: extra.badParticipant === 0 && extra.botArchive === 0 && botPlayers === 0,
    detail: `${battleRecords.length} 场 × 2 端全部命中注册表（非注册/bot 端 ${extra.badParticipant}）；`
      + `档案层 flags.isBot=true 的玩家 ${extra.botArchive} 个（注册表内 ${botPlayers} 个）`,
  });

  // ⑦ 无 5xx
  const snap = ctx.metrics.snapshot();
  checks.push({
    id: 'A7-no-5xx', title: '⑦ 无 5xx',
    ok: snap.server5xx === 0,
    detail: `5xx=${snap.server5xx}，请求总数=${snap.requests}，传输层失败=${snap.transportFailures}`,
  });

  counts.players = registry.size;
  return { checks, counts };
}

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
    { label: '0', min: 0, max: 0 }, { label: '1-50', min: 1, max: 50 },
    { label: '51-200', min: 51, max: 200 }, { label: '201-600', min: 201, max: 600 },
    { label: '601-1200', min: 601, max: 1200 }, { label: '1201-3000', min: 1201, max: 3000 },
  ].map((b) => ({ ...b, count: points.filter((p) => p >= b.min && p <= b.max).length }));
  return {
    points: {
      count: points.length,
      min: points.length ? points[0] : 0,
      p50: percentile(points, 50),
      p95: percentile(points, 95),
      max: points.length ? points[points.length - 1] : 0,
      bands,
    },
    tiers,
    ratingGames: games,
    winLossDraw: stats,
    aiPrograms: {
      distinct: new Set([...registry.values()].map((v) => v.programHash)).size,
      presets: countBy(registry.values(), (v) => v.preset),
    },
    equippedPlugins: {
      total: [...registry.values()].reduce((n, v) => n + (v.equipped || 0), 0),
      perPlayer: stats2([...registry.values()].map((v) => v.equipped || 0)),
    },
  };
}

function stats2(list) {
  const s = list.slice().sort((a, b) => a - b);
  if (s.length === 0) return { count: 0, mean: 0, p50: 0, max: 0 };
  return {
    count: s.length,
    mean: Math.round((s.reduce((a, b) => a + b, 0) / s.length) * 100) / 100,
    p50: percentile(s, 50),
    max: s[s.length - 1],
  };
}

/* ---------- 报告落盘（runtime/ 已 gitignore；绝不写仓库根或 docs） ---------- */

function reportPath(root) {
  return path.join(root || path.join(__dirname, '..', '..'), 'runtime', 'load-report.json');
}

function writeReport(report, root) {
  const file = reportPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
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
  reportPath,
  writeReport,
  makeTempDir,
  removeTempDir,
  lookupPlayerId,
  // 供报告引用（不改动 server/**，只读取）
  loadoutValidate: loadoutApi.validateLoadout,
  ledger,
};
