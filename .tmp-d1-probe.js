'use strict';
/* 临时探针（P7-5 自用）：验证"装配引用进入出战配置"后 ranked/quick 是否已可用（D1 是否仍存在） */
const h = require('./tests/helpers/e2e.js');

async function main() {
  const s = await h.startE2E({ rateLimitPerMinute: h.RATE_LIMIT });
  try {
    const A = await h.registerPlayer(s, 'da');
    const B = await h.registerPlayer(s, 'db');
    const box = await h.openIntoWarehouse(s, A.token, 4242, 'common', 1, 3);
    const boxB = await h.openIntoWarehouse(s, B.token, 9100, 'common', 1, 3);
    const asmA = await h.assembleAll(s, A.token, box.warehouse, 'common');
    const asmB = await h.assembleAll(s, B.token, boxB.warehouse, 'common');
    const merged = h.mergeWarehouses(asmA.warehouse, asmB.warehouse);
    // **带装配引用**的出战配置（不剥离）
    const ldA = h.loadoutOf(asmA.warehouse, h.programOf([h.action('move_right')]));
    const ldB = h.loadoutOf(asmB.warehouse, h.programOf([h.action('move_left')]));
    const refs = (ldA.role.slots || []).filter((x) => x.pluginUid).length
      + ldA.skills.reduce((n, sk) => n + (sk.slots || []).filter((x) => x.pluginUid).length, 0);
    process.stdout.write(`装配引用数=${refs}（角色+技能槽）\n`);
    const putA = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldA, warehouse: merged }, h.authed(A.token));
    process.stdout.write(`PUT A(slot1, 带引用)=${putA.status} ${putA.status === 200 ? 'OK' : putA.raw.slice(0, 200)}\n`);
    const putB = await s.request('PUT', '/api/v1/me/configs/slot1', { loadout: ldB, warehouse: merged }, h.authed(B.token));
    process.stdout.write(`PUT B(slot1, 带引用)=${putB.status}\n`);
    const rk = await s.request('POST', '/api/v1/ranked/run', { seed: 11 }, h.authed(A.token));
    process.stdout.write(`ranked/run=${rk.status} ${rk.status === 200 ? JSON.stringify({ matches: rk.body.data.matches, shortfall: rk.body.data.shortfall }) : rk.raw.slice(0, 240)}\n`);
    const qk = await s.request('POST', '/api/v1/quick/run', { seed: 21 }, h.authed(A.token));
    process.stdout.write(`quick/run(A)=${qk.status} ${qk.status === 200 ? JSON.stringify({ winner: qk.body.data.winner, self: qk.body.data.self.pointsAfter, foe: qk.body.data.opponent.pointsAfter }) : qk.raw.slice(0, 160)}\n`);
    // B 尚未与任何人交手 → B 发起的快速对战必然抽到 A（双方都带装配引用）
    const qkB = await s.request('POST', '/api/v1/quick/run', { seed: 22 }, h.authed(B.token));
    process.stdout.write(`quick/run(B, 对手=A 带引用)=${qkB.status} ${qkB.status === 200 ? JSON.stringify({ winner: qkB.body.data.winner, foe: qkB.body.data.opponent.publicId, self: qkB.body.data.self.pointsAfter }) : qkB.raw.slice(0, 200)}\n`);
    // 面板端到端：装出来的插件是否真实生效（无插件 vs 有插件 面板差异）
    const pan = await s.request('POST', '/api/v1/panel', { loadout: ldA, warehouse: merged, tier: 'common' });
    process.stdout.write(`panel(带引用, 无 warehouse 校验路径)=${pan.status} ${pan.status === 200 ? JSON.stringify(pan.body.data.panel.role.stats) : pan.raw.slice(0, 200)}\n`);
  } finally {
    await s.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
