'use strict';
/* 临时探针（缺陷 B 验收）：装配插件的出战配置的三态行为
 *   ① 有镜像（PUT /me/warehouse）→ 快速/排位都能打
 *   ② 已校验但镜像不在本进程（模拟：清 rt.warehouses + 从未 PUT /me/warehouse）→ 基准面板退化，仍能打
 *   ③ 未校验 + 无镜像 → 如实 409（quick=loadout_invalid(missing_warehouse) / ranked=loadout_invalid）
 * 用法：node .tmp-b-probe.js   （用完即删；不进仓库） */
const h = require('./tests/helpers/http.js');
const e2e = require('./tests/helpers/e2e.js');

const TIER = 'common';
const brief = (x) => JSON.stringify(x).slice(0, 220);

async function makePluginPlayer(fake, s, tag, seedBase, opts) {
  const o = opts || {};
  const p = await e2e.registerPlayer(fake, tag);
  const op = await e2e.openIntoWarehouse(fake, p.token, seedBase, TIER);
  const asm = await e2e.assembleAll(fake, p.token, op.warehouse, TIER);
  const ld = e2e.loadoutOf(asm.warehouse, e2e.programOf([e2e.action('skill:skill1')]));
  if (o.submitMirror) {
    const w = await fake.request('PUT', '/api/v1/me/warehouse', { warehouse: asm.warehouse }, h.authed(p.token));
    if (w.status !== 200) throw new Error('PUT /me/warehouse 失败 ' + w.status);
  }
  const cfg = await fake.request('PUT', '/api/v1/me/configs/slot1', { loadout: ld, warehouse: asm.warehouse }, h.authed(p.token));
  if (cfg.status !== 200) throw new Error(`保存配置失败 ${cfg.status} ${brief(cfg.body)}`);
  const playerId = await e2e.playerIdByPublicId(s.store, p.publicId);
  const refs = (ld.role.slots || []).filter((x) => x.pluginUid).length
    + ld.skills.reduce((n, sk) => n + (sk.slots || []).filter((x) => x.pluginUid).length, 0);
  if (o.unverify) {
    await s.store.updateArchive(playerId, (a) => {
      a.flags.unverifiedLoadout = true;
      for (const slot of a.configs.slots) if (slot.snapshot) slot.snapshot.verifiedAgainstWarehouse = false;
      return null;
    });
  }
  if (o.dropMirror) s.runtime.warehouses.delete(playerId);
  const slot = await e2e.activeSlotOf(s.store, playerId);
  return { player: p, playerId, ld, warehouse: asm.warehouse, refs, archive: slot.archive, loadout: slot.loadout };
}

(async () => {
  await h.withServer(null, async (s) => {
    const fake = { request: (m, p, b, hd) => h.request(s.port, m, p, b, hd) };
    // 5 个"普通对手"（各自默认配置；由 index 装配层按身份派生 P2-5 变体）
    for (let i = 0; i < 5; i++) await e2e.registerPlayer(fake, `plain${i}`);

    // ① 有镜像
    const a = await makePluginPlayer(fake, s, 'wa', 9101, { submitMirror: true });
    console.log('[A] unverified=%s refs=%d 镜像在进程内=%s', a.archive.flags.unverifiedLoadout, a.refs,
      !!(await s.runtime.loadWarehouse(a.playerId)));
    const q1 = await fake.request('POST', '/api/v1/quick/run', { seed: 11 }, h.authed(a.player.token));
    console.log('[A] quick →', q1.status, brief(q1.body));
    const r1 = await fake.request('POST', '/api/v1/ranked/run', { seed: 21 }, h.authed(a.player.token));
    console.log('[A] ranked →', r1.status, r1.body.data ? `matches=${r1.body.data.matches} shortfall=${r1.body.data.shortfall} invalids=${r1.body.data.invalids}` : brief(r1.body));

    // ② 已校验但镜像不在本进程（从未 PUT /me/warehouse；清掉保存配置时登记的镜像）
    const c = await makePluginPlayer(fake, s, 'wc', 9202, { dropMirror: true });
    console.log('[C] unverified=%s refs=%d 镜像在进程内=%s', c.archive.flags.unverifiedLoadout, c.refs,
      !!(await s.runtime.loadWarehouse(c.playerId)));
    const q2 = await fake.request('POST', '/api/v1/quick/run', { seed: 12 }, h.authed(c.player.token));
    console.log('[C] quick →', q2.status, brief(q2.body));
    const r2 = await fake.request('POST', '/api/v1/ranked/run', { seed: 22 }, h.authed(c.player.token));
    console.log('[C] ranked →', r2.status, r2.body.data ? `matches=${r2.body.data.matches} shortfall=${r2.body.data.shortfall} invalids=${r2.body.data.invalids}` : brief(r2.body));

    // ③ 未校验 + 无镜像 → 如实报错（不放宽）
    const d = await makePluginPlayer(fake, s, 'wd', 9303, { dropMirror: true, unverify: true });
    console.log('[D] unverified=%s refs=%d 镜像在进程内=%s', d.archive.flags.unverifiedLoadout, d.refs,
      !!(await s.runtime.loadWarehouse(d.playerId)));
    const q3 = await fake.request('POST', '/api/v1/quick/run', { seed: 13 }, h.authed(d.player.token));
    console.log('[D] quick →', q3.status, brief(q3.body));
    const r3 = await fake.request('POST', '/api/v1/ranked/run', { seed: 23 }, h.authed(d.player.token));
    console.log('[D] ranked →', r3.status, brief(r3.body));
  });
})();
