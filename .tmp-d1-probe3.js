'use strict';
/* 临时探针 3（P7-5 自用）：干净配对（无任何冷却）下，**带装配引用**的 quick 与 ranked 是否可用 */
const h = require('./tests/helpers/e2e.js');

async function main() {
  const s = await h.startE2E({ rateLimitPerMinute: h.RATE_LIMIT });
  try {
    const A = await h.registerPlayer(s, 'qa');
    const B = await h.registerPlayer(s, 'qb');
    const box = await h.openIntoWarehouse(s, A.token, 4242, 'common', 1, 3);
    const boxB = await h.openIntoWarehouse(s, B.token, 9100, 'common', 1, 3);
    const asmA = await h.assembleAll(s, A.token, box.warehouse, 'common');
    const asmB = await h.assembleAll(s, B.token, boxB.warehouse, 'common');
    const merged = h.mergeWarehouses(asmA.warehouse, asmB.warehouse);
    const ldA = h.loadoutOf(asmA.warehouse, h.programOf([h.action('move_right')]));
    const ldB = h.loadoutOf(asmB.warehouse, h.programOf([h.action('move_left')]));
    const refsA = (ldA.role.slots || []).filter((x) => x.pluginUid).length + ldA.skills.reduce((n, sk) => n + (sk.slots || []).filter((x) => x.pluginUid).length, 0);
    const refsB = (ldB.role.slots || []).filter((x) => x.pluginUid).length + ldB.skills.reduce((n, sk) => n + (sk.slots || []).filter((x) => x.pluginUid).length, 0);
    const pA = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldA, warehouse: merged }, h.authed(A.token));
    const pB = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldB, warehouse: merged }, h.authed(B.token));
    process.stdout.write(`装配引用：A=${refsA} B=${refsB}；PUT A=${pA.status} PUT B=${pB.status}\n`);
    const qk = await s.request('POST', '/api/v1/quick/run', { seed: 20 }, h.authed(A.token));
    process.stdout.write(`quick/run(A, 干净配对) = ${qk.status} ${qk.status === 200
      ? JSON.stringify({ winner: qk.body.data.winner, ticks: qk.body.data.ticks, foe: qk.body.data.opponent.publicId, selfDelta: qk.body.data.self.delta, foeDelta: qk.body.data.opponent.delta, battleId: qk.body.data.battleId })
      : qk.raw.slice(0, 240)}\n`);
    // 回放该场（按需重算需要双方快照 + 各自仓库镜像）
    if (qk.status === 200) {
      const rp = await s.request('GET', `/api/v1/replay/${qk.body.data.battleId}`, undefined, h.authed(A.token));
      process.stdout.write(`replay(带装配引用的对局) = ${rp.status} ${rp.status === 200 ? `frames=${rp.body.data.frames.length}` : rp.raw.slice(0, 200)}\n`);
    }
    const rk = await s.request('POST', '/api/v1/ranked/run', { seed: 11 }, h.authed(A.token));
    process.stdout.write(`ranked/run(A) = ${rk.status} ${rk.status === 200 ? JSON.stringify({ matches: rk.body.data.matches, shortfall: rk.body.data.shortfall, invalids: rk.body.data.invalids }) : rk.raw.slice(0, 240)}\n`);
  } finally {
    await s.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
