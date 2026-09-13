'use strict';
/* .review-f4/probe-http.js —— F4 审查真后端 HTTP 探针（可复跑：node .review-f4/probe-http.js）
 * 服务真切 listen(0)；对每个 OPPONENTS 前端模板 POST /api/v1/battle（镜像 F4 battle/run effect 请求体——
 * 无 warehouse），验证模板 loadout 可被后端 /battle 消费；再验证 missing_warehouse / seed 域 / seed 回带。
 * 期望退出码 0；任一步失败 → 打印 [FAIL] 并退出 1。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');
process.chdir(REPO);
const file = (p) => pathToFileURL(path.join(REPO, p)).href;

(async () => {
  const { start } = require(path.join(REPO, 'server', 'index.js'));
  const srv = await start({ port: 0 });
  const base = `http://127.0.0.1:${srv.port}/api/v1`;
  const { OPPONENTS } = await import(file('public/js/views/battle.js'));

  async function post(p, body) {
    const r = await fetch(base + p, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    return { status: r.status, ...j };
  }

  // 合法 p1（与 B24 bot 同构：无插件引用 → wh 可空校验通过）
  const COMMON = require(path.join(REPO, 'server', 'data', 'skill-templates.json')).skillTemplates
    .filter((t) => !t.unlockTier || t.unlockTier === 'common');
  const mkSkill = (i) => ({ uid: `p1s${i + 1}`, kind: 'skill', templateId: COMMON[i % COMMON.length].id, quality: 'common', slotCount: 0, slots: [], params: { multiplier: 1, cost: { hp: 0, mp: 10, sp: 0 }, cooldown: 3, bulletLevel: 3 }, unlockTier: 'common' });
  const p1 = {
    role: { uid: 'p1r', kind: 'role', templateId: 'role_bal', quality: 'common', slotCount: 0, slots: [], stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 }, pluginPoints: 3, unlockTier: 'common' },
    skills: [mkSkill(0), mkSkill(1), mkSkill(2)],
    ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } },
  };

  // ① 三模板逐一真请求（无 warehouse，镜像 battle/run effect 请求体）
  const results = [];
  for (const o of OPPONENTS) {
    const r = await post('/battle', { p1, p2: o.loadout, seed: 7, tier: 'common' });
    const detail = r.ok ? `OK frames=${r.data.frames.length} winner=${r.data.winner} ticks=${r.data.ticks}` : `ERR ${r.error.code} :: ${(r.error.details || []).map((e) => e.message).join(' | ')}`;
    console.log(`[opp] ${o.id} -> HTTP ${r.status} ${detail}`);
    results.push({ id: o.id, ok: r.ok, status: r.status, code: r.error && r.error.code, details: (r.error && r.error.details) || [] });
  }

  // ② missing_warehouse：p1 含装配引用但请求无 warehouse
  const p1ref = JSON.parse(JSON.stringify(p1));
  p1ref.role.slots = [{ type: 'atk', pluginUid: 'ghost_plug' }];
  const r2 = await post('/battle', { p1: p1ref, p2: p1, seed: 7, tier: 'common' });
  console.log(`[wh-absent] p1 带引用无 warehouse -> HTTP ${r2.status} ${r2.error && r2.error.code} :: ${(r2.error && r2.error.details || []).map((e) => e.message).join(' | ')}`);

  // ③ 带 warehouse → 引用可解析 → 可对战
  const wh = { buckets: { rolePlugin: [{ uid: 'ghost_plug', kind: 'rolePlugin', slot: 'atk', quality: 'common', unlockTier: 'common', equipped: true, affixes: [] }] } };
  const r3 = await post('/battle', { p1: p1ref, p2: p1, seed: 7, tier: 'common', warehouse: wh });
  console.log(`[wh-present] -> HTTP ${r3.status} ${r3.ok ? `OK frames=${r3.data.frames.length} winner=${r3.data.winner}` : `ERR ${r3.error.code} :: ${(r3.error.details || []).map((e) => e.message).join(' | ')}`}`);

  // ④ seed 域：0 / 超界 → bad_seed；null → 后端生成回带（data.seed 在 [1, 0x7fffffff]）
  const r4 = await post('/battle', { p1, p2: p1, seed: 0, tier: 'common' });
  console.log(`[seed0] -> HTTP ${r4.status} ${r4.error && r4.error.code}`);
  const r5 = await post('/battle', { p1, p2: p1, seed: 0x7fffffff + 1, tier: 'common' });
  console.log(`[seed-over] -> HTTP ${r5.status} ${r5.error && r5.error.code}`);
  const r6 = await post('/battle', { p1, p2: p1, seed: null, tier: 'common' });
  console.log(`[seed-null] -> HTTP ${r6.status} ${r6.ok ? `回带 seed=${r6.data.seed}` : r6.error.code}`);

  // 断言（当前实现态；修复后应全绿）
  const allOppOk = results.every((x) => x.ok);
  assert.ok(allOppOk, `OPPONENTS 三模板经真后端 /battle 应全部可对战（当前 ${results.filter((x) => !x.ok).map((x) => `${x.id}:${x.code}:${x.details.map((e) => e.message).join(';')}`).join(' || ')}）`);
  console.log('① 三模板真后端全部 200 可对战 ✓');
  assert.equal(r2.status, 409, '引用+无 warehouse → 409（危险面，fix 为带 warehouse）');
  assert.ok(r2.error.details.some((e) => e.code === 'missing_warehouse'), `缺 warehouse 应报 missing_warehouse（got ${r2.error.details.map((e) => e.code).join(',')}）`);
  console.log('② 引用+无 warehouse → missing_warehouse ✓（前端 battle/run 现请求体缺失 → 修复必带）');
  assert.ok(r3.ok, `带 warehouse 引引用可对战（got ${r3.error && r3.error.code}）`);
  console.log('③ 带 warehouse → 200 ✓');
  assert.equal(r4.status, 400, 'seed 0 → 400');
  assert.equal(r4.error.code, 'bad_seed');
  assert.equal(r5.error.code, 'bad_seed');
  assert.ok(r6.ok && Number.isInteger(r6.data.seed) && r6.data.seed >= 1 && r6.data.seed <= 0x7fffffff, 'seed null → 后端生成回带');
  console.log(`④ seed 域 400 bad_seed（0/超界）+ null 生成回带 seed=${r6.data.seed} ✓`);

  console.log('PROBE-HTTP PASS');
  await srv.close();
})().catch((e) => { console.error('[FAIL]', e.message); console.error(e.stack); process.exit(1); });