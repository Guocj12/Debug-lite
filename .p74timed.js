const h = require('./tests/helpers/http.js');
const battleApi = require('./server/battle.js');
const LD = require('./tests/fixtures/loadout-ok.json');
(async () => {
  const t0 = Date.now();
  const mark = (m) => console.log(((Date.now() - t0) / 1000).toFixed(2) + 's', m);
  const s = await h.startServer(); mark('up');
  const a = await h.register(s.port, h.uniqueName('ea'));
  const b = await h.register(s.port, h.uniqueName('eb'));
  const aId = await h.playerIdByPublicId(s.store, a.publicId);
  const bId = await h.playerIdByPublicId(s.store, b.publicId);
  const aSlot = await h.activeSlotOf(s.store, aId); const bSlot = await h.activeSlotOf(s.store, bId); mark('slots');
  const rec = await h.settleRecord(s.store, { mode: 'quick', seed: 777001, at: Date.now(),
    p1: { playerId: aId, publicId: a.publicId, role: 'attacker', snapshotHash: aSlot.snapshotHash, configHash: aSlot.configHash, pointsBefore: 0, pointsAfter: 0, result: 'win', tierBefore: 'common', tierAfter: 'common' },
    p2: { playerId: bId, publicId: b.publicId, role: 'defender', snapshotHash: bSlot.snapshotHash, configHash: bSlot.configHash, pointsBefore: 0, pointsAfter: 0, result: 'loss', tierBefore: 'common', tierAfter: 'common' },
    verdict: { winner: 'p1', reason: 'hero_dead', ticks: 20 }, versions: { engine: '0.0.0', data: s.store.versions.data } }); mark('settle');
  const exp = await h.request(s.port, 'GET', '/api/v1/replay/' + rec.record.battleId, undefined, h.authed(a.token)); mark('410 ' + exp.status);
  const ids = [];
  for (let i = 0; i < 70; i++) { const r = await h.request(s.port, 'POST', '/api/v1/battle', { p1: LD.loadout, p2: LD.loadout, warehouse: LD.warehouse, seed: 7, tier: 'mythic' }); ids.push(r.body.data.id); }
  mark('70 battles');
  const f = await h.request(s.port, 'GET', '/api/v1/replay/' + ids[0]); mark('first ' + f.status);
  const big = await h.request(s.port, 'POST', '/api/v1/log-level', { level: 'trace', pad: 'x'.repeat(1500000) }); mark('413 ' + big.status);
  const ch = await h.requestChunks(s.port, '/api/v1/log-level', ['{"level":"trace","pad":"', 'x'.repeat(1400000), '"}']); mark('413chunk ' + ch.status);
  mark('REPLAYS=' + battleApi.REPLAYS.size + ' own=' + s.runtime.ownReplays.length);
  await s.cleanup(); mark('cleanup');
})().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
