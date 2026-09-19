'use strict';
/* 临时探针（P7-5 自用；完成后删除，不入库） */
const h = require('./tests/helpers/http.js');
const loadoutApi = require('./server/loadout.js');
const items = require('./server/core/items.js');

function log(...a) { process.stdout.write(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n'); }

async function main() {
  const s = await h.startServer({});
  try {
    const a = await h.register(s.port, h.uniqueName('pa'));
    const b = await h.register(s.port, h.uniqueName('pb'));
    log('A', a.status, a.publicId, 'token?', !!a.token);
    const box = await h.request(s.port, 'POST', '/api/v1/box', { seed: 4242, tier: 'common', times: 6 });
    log('box status', box.status);
    const its = box.body.data.items;
    log('kinds', its.map((i) => i.kind).join(','));
    for (const it of its) {
      log(' item', it.kind, it.uid, 'slots', JSON.stringify(it.slots), 'cost', it.pointCost, 'pp', it.pluginPoints, 'slot', it.slot);
    }
    // 合并两玩家仓库
    const whA = items.emptyWarehouse();
    const whB = items.emptyWarehouse();
    const boxB = await h.request(s.port, 'POST', '/api/v1/box', { seed: 999, tier: 'common', times: 6 });
    for (const it of its) whA.buckets[it.kind].push(it);
    for (const it of boxB.body.data.items) whB.buckets[it.kind].push(it);
    const merged = items.emptyWarehouse();
    for (const k of Object.keys(merged.buckets)) merged.buckets[k] = whA.buckets[k].concat(whB.buckets[k]);
    const counts = {};
    for (const k of Object.keys(merged.buckets)) counts[k] = merged.buckets[k].length;
    log('merged counts', JSON.stringify(counts));

    // 装配（角色/技能各槽位尝试）
    function assembleAll(wh, tier) {
      let cur = wh;
      const placed = [];
      const skipped = [];
      const targets = cur.buckets.role.concat(cur.buckets.skill);
      for (const t0 of targets) {
        for (let i = 0; i < (t0.slots || []).length; i++) {
          const target = items.findItem ? null : null;
          const t = cur.buckets.role.concat(cur.buckets.skill).find((x) => x.uid === t0.uid);
          if (!t || !t.slots[i] || t.slots[i].pluginUid) continue;
          const kind = t.kind === 'role' ? 'rolePlugin' : 'skillPlugin';
          const cand = cur.buckets[kind].find((p) => p.slot === t.slots[i].type && p.equipped !== true);
          if (!cand) { skipped.push(`${t0.uid}[${i}] no plugin for ${t.slots[i].type}`); continue; }
          const r = items.assemble(cur, { targetUid: t.uid, pluginUid: cand.uid, slotIndex: i, tier });
          if (r.ok) { cur = r.warehouse; placed.push(`${cand.uid}->${t.uid}[${i}]`); }
          else skipped.push(`${t0.uid}[${i}] ${r.code}`);
        }
      }
      return { wh: cur, placed, skipped };
    }
    const asmA = assembleAll(whA, 'common');
    log('assembleA placed', JSON.stringify(asmA.placed), 'skipped', JSON.stringify(asmA.skipped));
    const asmB = assembleAll(whB, 'common');
    log('assembleB placed', JSON.stringify(asmB.placed), 'skipped', JSON.stringify(asmB.skipped));

    const merged2 = items.emptyWarehouse();
    for (const k of Object.keys(merged2.buckets)) merged2.buckets[k] = asmA.wh.buckets[k].concat(asmB.wh.buckets[k]);
    const ldA = { role: asmA.wh.buckets.role[0], skills: asmA.wh.buckets.skill.slice(0, 3), ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_right' }] } } };
    const ldB = { role: asmB.wh.buckets.role[0], skills: asmB.wh.buckets.skill.slice(0, 3), ai: { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } } };
    log('ldA roles/skills', !!ldA.role, ldA.skills.length);
    const vMerged = loadoutApi.validateLoadout(ldA, { warehouse: merged2, tier: 'common' });
    log('validate ldA vs merged2', vMerged.ok, JSON.stringify(vMerged.errors.slice(0, 4)));
    const vOwn = loadoutApi.validateLoadout(ldA, { warehouse: asmA.wh, tier: 'common' });
    log('validate ldA vs whA', vOwn.ok, JSON.stringify(vOwn.errors.slice(0, 4)));

    // PUT 配置槽（带 warehouse=merged2 验证引用）
    const put = await h.request(s.port, 'PUT', '/api/v1/me/configs/slot1', { loadout: ldA, warehouse: merged2 }, h.authed(a.token));
    log('PUT slot1', put.status, put.raw.slice(0, 300));
    // PUT 仓库镜像
    const putWh = await h.request(s.port, 'PUT', '/api/v1/me/warehouse', { warehouse: merged2 }, h.authed(a.token));
    log('PUT wh', putWh.status, putWh.raw.slice(0, 200));
    const getWh = await h.request(s.port, 'GET', '/api/v1/me/warehouse', undefined, h.authed(a.token));
    log('GET wh', getWh.status, getWh.body.data ? getWh.body.data.warehouseHash : null);
    // panel
    const pan = await h.request(s.port, 'POST', '/api/v1/panel', { loadout: ldA, warehouse: merged2, tier: 'common' });
    log('panel', pan.status, pan.raw.slice(0, 260));
    const local = loadoutApi.buildPanel(ldA, { warehouse: merged2, tier: 'common' });
    log('panel equal', JSON.stringify(pan.body.data.panel) === JSON.stringify(local.panel));
    // battle
    const bt = await h.request(s.port, 'POST', '/api/v1/battle', { p1: ldA, p2: ldB, warehouse: merged2, seed: 777, tier: 'common' });
    log('battle', bt.status, bt.raw.slice(0, 260));
    if (bt.status === 200) {
      const id = bt.body.data.id;
      const rep = await h.request(s.port, 'GET', `/api/v1/replay/${id}`);
      log('replay', rep.status, rep.body.data ? rep.body.data.frames.length : null, 'ticks', bt.body.data.ticks);
      const c = await h.register(s.port, h.uniqueName('pc'));
      const rBad = await h.request(s.port, 'GET', `/api/v1/replay/${id}`, undefined, h.authed(c.token));
      log('replay by C', rBad.status, rBad.raw.slice(0, 120));
    }
    // ai validate 合法 + 非法 + 废弃动作
    const progOk = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'wait' }] } };
    const v1 = await h.request(s.port, 'POST', '/api/v1/ai/validate', { program: progOk, tier: 'common' });
    log('ai.validate ok', v1.status, v1.raw.slice(0, 200));
    const weird = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: 'teleport' }] } };
    const v2 = await h.request(s.port, 'POST', '/api/v1/ai/validate', { program: weird, tier: 'common' });
    log('ai.validate weird', v2.status, v2.raw.slice(0, 260));
    const bad = { type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'if', cond: { type: 'cmp', op: '<', left: { type: 'literal', value: 1 }, right: { type: 'literal', value: 2 } }, then: { type: 'seq', statements: [] } }] } };
    const v3 = await h.request(s.port, 'POST', '/api/v1/ai/validate', { program: bad, tier: 'common' });
    log('ai.validate bad', v3.status, v3.raw.slice(0, 300));
    const cp1 = await h.request(s.port, 'POST', '/api/v1/ai/compile', { program: progOk });
    const cp2 = await h.request(s.port, 'POST', '/api/v1/ai/compile', { program: progOk });
    log('compile', cp1.status, cp1.raw.slice(0, 220), 'stable', cp1.body.data.programHash === cp2.body.data.programHash);
    // ranked run
    const rk = await h.request(s.port, 'POST', '/api/v1/ranked/run', { seed: 12345 }, h.authed(a.token));
    log('ranked', rk.status, rk.raw.slice(0, 600));
    // quick run
    const qk = await h.request(s.port, 'POST', '/api/v1/quick/run', { seed: 20260101 }, h.authed(a.token));
    log('quick', qk.status, qk.raw.slice(0, 600));
    // leaderboard
    const lb = await h.request(s.port, 'GET', '/api/v1/leaderboard');
    log('lb', lb.status, lb.raw.slice(0, 300));
    log('has pl_ in lb?', lb.raw.includes('pl_'));
    // records / defense
    const rec = await h.request(s.port, 'GET', '/api/v1/me/records', undefined, h.authed(a.token));
    log('records', rec.status, rec.raw.slice(0, 400));
    const def = await h.request(s.port, 'GET', '/api/v1/me/defense', undefined, h.authed(b.token));
    log('defense', def.status, def.raw.slice(0, 300));
    const meA = await h.request(s.port, 'GET', '/api/v1/me', undefined, h.authed(a.token));
    log('me', meA.status, meA.raw.slice(0, 400));
  } finally {
    await s.cleanup();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
