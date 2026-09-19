'use strict';
/* 临时探针 2（P7-5 自用）：定位 quick 候选池"带装配引用的对手被判不可用"的具体分支 */
const h = require('./tests/helpers/e2e.js');
const ranked = require('./server/ranked.js');
const archiveMod = require('./server/store/archive.js');

async function main() {
  const s = await h.startE2E({ rateLimitPerMinute: h.RATE_LIMIT });
  try {
    const A = await h.registerPlayer(s, 'ea');
    const B = await h.registerPlayer(s, 'eb');
    const box = await h.openIntoWarehouse(s, A.token, 4242, 'common', 1, 3);
    const boxB = await h.openIntoWarehouse(s, B.token, 9100, 'common', 1, 3);
    const asmA = await h.assembleAll(s, A.token, box.warehouse, 'common');
    const asmB = await h.assembleAll(s, B.token, boxB.warehouse, 'common');
    const merged = h.mergeWarehouses(asmA.warehouse, asmB.warehouse);
    const ldA = h.loadoutOf(asmA.warehouse, h.programOf([h.action('move_right')]));
    const ldB = h.loadoutOf(asmB.warehouse, h.programOf([h.action('move_left')]));
    await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldA, warehouse: merged }, h.authed(A.token));
    await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldB, warehouse: merged }, h.authed(B.token));

    for (const [tag, p] of [['A', A], ['B', B]]) {
      const pid = await h.playerIdByPublicId(s.store, p.publicId);
      const arch = await s.store.loadArchive(pid);
      const active = archiveMod.activeSlot(arch);
      const snap = await s.store.snapshot.get(active.snapshot.hash);
      const loadout = snap[ranked.RAW_SNAPSHOT_FIELD];
      const entry = s.store.index.get(pid);
      process.stdout.write(`[${tag}] needsWarehouse=${ranked.needsWarehouse(loadout)} isUsableSnapshot=${ranked.isUsableSnapshot(snap)}`
        + ` verifiedFlag=${active.snapshot.verifiedAgainstWarehouse} archiveVerified=${arch.flags.unverifiedLoadout === false}`
        + ` isWarehouseVerified(archive,active)=${ranked.isWarehouseVerified(arch, active)}`
        + ` synthetic=${ranked.syntheticVerifiedWarehouse(loadout) ? 'ok' : 'null'}`
        + ` indexHash==activeHash=${entry.activeSnapshotHash === active.snapshot.hash}`
        + ` snapshotWarehouse=${snap.warehouse ? 'present' : 'absent'}\n`);
    }
    const qp = await s.runtime.quick.candidatePool(await h.playerIdByPublicId(s.store, A.publicId));
    process.stdout.write(`candidatePool(A) = ${JSON.stringify({ pool: qp.pool.map((x) => ({ publicId: x.publicId, hasWh: !!x.warehouse })), skipped: qp.skipped, poolSize: qp.poolSize })}\n`);
    const fo = await s.runtime.quick.findOpponent({ playerId: await h.playerIdByPublicId(s.store, A.publicId), seed: 20 });
    process.stdout.write(`findOpponent(A) = ${JSON.stringify(fo && fo.status !== undefined ? fo : { seed: fo.seed, found: { ok: fo.found && fo.found.ok, window: fo.found && fo.found.window, relaxed: fo.found && fo.found.relaxed, cooldown: fo.found && fo.found.cooldown, candidateCount: fo.found && fo.found.candidateCount, opponent: fo.found && fo.found.opponent && fo.found.opponent.publicId }, poolInfo: fo.poolInfo && { pool: fo.poolInfo.pool.length, skipped: fo.poolInfo.skipped, poolSize: fo.poolInfo.poolSize } })}\n`);
  } finally {
    await s.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
