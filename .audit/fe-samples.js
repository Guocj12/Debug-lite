'use strict';
/* .audit/fe-samples.js —— 前端文档数据形状取样器（P6 前端文档重设计配套）
 * 目的：把前端要消费的**真实响应样本**从活体服务器抓下来（只走 HTTP，与前端同路径），
 *       供 docs/frontend-spec.md 附录 A 逐字引用、并供 scripts/fe-spec-check.js 校验字段名。
 * 用法：node .audit/fe-samples.js [outFile]   缺省 outFile=.audit/fe-samples.json
 * 注意：本文件是审计/取证脚本（不参与 npm test / gate 覆盖率），可随时复跑。
 */
const fs = require('node:fs');
const path = require('node:path');
const { start } = require('../server/index.js');
const { createLogger } = require('../shared/log.js');

const ROOT = path.join(__dirname, '..');
const SEED = 20260912;

// 兜底样本合成（模板驱动；结构与 core/items.js 生成物一致，仅数值取模板基准）
// 用途：开箱随机可能若干次不出角色/技能，探针需要确定性的 1 角色 + 3 技能 + 插件来跑通下游端点。
function synthItem(kind, templateId, quality, tier, uid) {
  const qualities = require('../server/data/qualities.json');
  const q = qualities.qualities.find((x) => x.id === quality);
  if (kind === 'role') {
    const t = require('../server/data/role-templates.json').roleTemplates.find((x) => x.id === templateId);
    return {
      uid, kind: 'role', templateId: t.id, name: t.name, quality, slotCount: 2,
      slots: [{ type: 'atk', pluginUid: null }, { type: 'special', pluginUid: null }],
      stats: { hp: t.baseStats.hp, atk: t.baseStats.atk, def: t.baseStats.def, sp: t.baseStats.sp, mp: t.baseStats.mp },
      regen: { mp: t.regen.mp, sp: t.regen.sp }, unlockTier: t.unlockTier, pluginPoints: q.pluginPoints,
    };
  }
  if (kind === 'skill') {
    const t = require('../server/data/skill-templates.json').skillTemplates.find((x) => x.id === templateId);
    return {
      uid, kind: 'skill', templateId: t.id, name: t.name, quality, slotCount: 1,
      slots: [{ type: 'basic', pluginUid: null }],
      params: {
        multiplier: t.baseMultiplier, cost: { hp: t.baseCost.hp, mp: t.baseCost.mp, sp: t.baseCost.sp },
        cooldown: t.cooldown, bulletLevel: t.bulletLevel, falloff: t.falloff,
      },
      unlockTier: t.unlockTier,
    };
  }
  const def = require('../server/data/plugins.json').plugins.find((x) => x.id === templateId);
  const it = {
    uid, kind, id: def.id, name: def.name, desc: def.desc, slot: def.slot, category: def.category,
    quality, tier, affixes: def.affixes.map((a) => ({ id: a.id, desc: a.desc, params: Object.assign({}, a.params) })),
    unlockTier: def.unlockTier,
  };
  if (kind === 'rolePlugin') it.pointCost = tier;
  if (kind === 'skillPlugin') it.costDeltaByTier = def.costDeltaByTier;
  return it;
}

function compactBrief(wh) {
  const brief = { buckets: {} };
  for (const [k, list] of Object.entries(wh.buckets)) {
    brief.buckets[k] = list.map((it) => ({
      uid: it.uid, kind: it.kind, name: it.name, quality: it.quality,
      templateId: it.templateId || null, id: it.id || null, unlockTier: it.unlockTier,
      slotCount: it.slotCount === undefined ? null : it.slotCount,
      slots: it.slots || null, stats: it.stats || null,
      pointCost: it.pointCost === undefined ? null : it.pointCost,
      tier: it.tier === undefined ? null : it.tier,
      equipped: it.equipped === undefined ? null : it.equipped,
      affixes: it.affixes || null, params: it.params || null,
    }));
  }
  return brief;
}

async function main() {
  const out = process.argv[2] || path.join(ROOT, '.audit', 'fe-samples.json');
  const s = await start({ logger: createLogger({ level: 'silent' }) });
  const base = `http://127.0.0.1:${s.port}`;
  const samples = { generatedAt: 'probe', base: '/api/v1', seed: SEED };

  const req = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  try {
    samples.health = (await req('GET', '/api/v1/health')).json;
    samples.data_battle_config = (await req('GET', '/api/v1/data/battle-config')).json;
    samples.data_qualities = (await req('GET', '/api/v1/data/qualities')).json;
    samples.data_skill_templates = (await req('GET', '/api/v1/data/skill-templates')).json;
    samples.data_role_templates = (await req('GET', '/api/v1/data/role-templates')).json;
    samples.data_plugins = (await req('GET', '/api/v1/data/plugins')).json;
    samples.data_sprites = (await req('GET', '/api/v1/data/sprites')).json;
    samples.data_animations = (await req('GET', '/api/v1/data/animations')).json;
    samples.unlock_common = (await req('GET', '/api/v1/unlock?tier=common')).json;
    samples.unlock_mythic = (await req('GET', '/api/v1/unlock?tier=mythic')).json;
    samples.warehouse_empty = (await req('GET', '/api/v1/warehouse')).json;
    samples.loadout_empty = (await req('GET', '/api/v1/loadout')).json;

    // 开箱：12 次 → 得到可装配的仓库（真实响应）
    const boxResp = await req('POST', '/api/v1/box', { seed: SEED, tier: 'mythic', times: 12 });
    samples.box_10_mythic = boxResp.json;

    // 用开箱结果拼一个合法仓库（4 桶分桶），继续真实装配/面板/对战
    const wh = { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
    for (const it of boxResp.json.data.items) {
      const key = it.kind;
      if (wh.buckets[key]) wh.buckets[key].push(it);
    }
    // 兜底：随机可能缺桶 → 用模板合成补齐（保证下游演示可复现）
    if (wh.buckets.role.length === 0) wh.buckets.role.push(synthItem('role', 'role_bal', 'rare', 2, 'item_demo_role'));
    while (wh.buckets.skill.length < 3) {
      const ids = ['skill_melee_whirl', 'skill_straight_precise', 'skill_melee_heavy'];
      wh.buckets.skill.push(synthItem('skill', ids[wh.buckets.skill.length % 3], 'rare', 2, `item_demo_skill${wh.buckets.skill.length + 1}`));
    }
    if (wh.buckets.rolePlugin.length === 0) wh.buckets.rolePlugin.push(synthItem('rolePlugin', 'rp_atk_pct', 'rare', 2, 'item_demo_rp'));
    if (wh.buckets.skillPlugin.length === 0) {
      const firstSp = require('../server/data/plugins.json').plugins.find((x) => x.kind === 'skillPlugin');
      wh.buckets.skillPlugin.push(synthItem('skillPlugin', firstSp.id, 'rare', 2, 'item_demo_sp'));
    }
    samples.warehouse_after_box = { ok: true, data: compactBrief(wh) };
    samples.warehouse_raw_shape = { ok: true, data: { buckets: {
      role: [wh.buckets.role[0]],
      skill: [wh.buckets.skill[0]],
      rolePlugin: [wh.buckets.rolePlugin[0]],
      skillPlugin: [wh.buckets.skillPlugin[0]],
    } } };

    // 装配：找一个槽位类型与插件 slot 匹配的组合（真实响应；失败样本也留档）
    const role = wh.buckets.role[0] || null;
    let asmOk = null;
    if (role && (role.slots || []).length > 0) {
      for (let si = 0; si < role.slots.length && !asmOk; si++) {
        const want = role.slots[si].type;
        const cand = wh.buckets.rolePlugin.find((p) => p.slot === want)
          || wh.buckets.rolePlugin.find((p) => p.slot === 'special' && want === 'special');
        if (!cand) continue;
        const asm = await req('POST', '/api/v1/warehouse/assemble', {
          warehouse: wh, targetUid: role.uid, pluginUid: cand.uid, slotIndex: si, tier: 'mythic',
        });
        samples[`assemble_role_slot${si}_${want}`] = asm.json;
        if (asm.json.ok) {
          wh.buckets.role = asm.json.data.warehouse.buckets.role;
          wh.buckets.rolePlugin = asm.json.data.warehouse.buckets.rolePlugin;
          asmOk = { slotIndex: si, type: want, pluginUid: cand.uid };
          samples.assemble_equipped_plugin_shape = {
            ok: true,
            data: { plugin: wh.buckets.rolePlugin.find((p) => p.uid === cand.uid) },
          };
          // 同槽重复装配 → slot_occupied；异类型装配 → slot_type_mismatch（错误样本）
          samples.assemble_error_occupied = (await req('POST', '/api/v1/warehouse/assemble', {
            warehouse: wh, targetUid: role.uid, pluginUid: cand.uid, slotIndex: si, tier: 'mythic',
          })).json;
          const other = wh.buckets.rolePlugin.find((p) => p.slot !== want && !p.equipped);
          if (other) {
            samples.assemble_error_type = (await req('POST', '/api/v1/warehouse/assemble', {
              warehouse: wh, targetUid: role.uid, pluginUid: other.uid, slotIndex: si, tier: 'mythic',
            })).json;
          }
          samples.disassemble_role_slot = (await req('POST', '/api/v1/warehouse/disassemble', {
            warehouse: wh, targetUid: role.uid, slotIndex: si,
          })).json;
          if (samples.disassemble_role_slot.ok) {
            wh.buckets.role = samples.disassemble_role_slot.data.warehouse.buckets.role;
            wh.buckets.rolePlugin = samples.disassemble_role_slot.data.warehouse.buckets.rolePlugin;
            // 复原：重新装上（后续 panel/battle 用带插件的 loadout）
            const re = await req('POST', '/api/v1/warehouse/assemble', {
              warehouse: wh, targetUid: role.uid, pluginUid: cand.uid, slotIndex: si, tier: 'mythic',
            });
            if (re.json.ok) {
              wh.buckets.role = re.json.data.warehouse.buckets.role;
              wh.buckets.rolePlugin = re.json.data.warehouse.buckets.rolePlugin;
            }
          }
        }
      }
      const emptyIdx = (role.slots || []).length > 1 ? 1 : 0;
      samples.disassemble_error_empty = (await req('POST', '/api/v1/warehouse/disassemble', { warehouse: wh, targetUid: role.uid, slotIndex: emptyIdx })).json;
    }
    samples.warehouse_after_assemble = { ok: true, data: compactBrief(wh) };

    // loadout：角色 + 前 3 个技能（不足则重复）+ 简单 AI
    const skills3 = [];
    for (let i = 0; i < 3; i++) {
      const cand = wh.buckets.skill[i % Math.max(1, wh.buckets.skill.length)];
      if (cand) skills3.push(cand);
    }
    const simpleAi = {
      type: 'program', version: 2,
      body: { type: 'seq', statements: [{ type: 'action', name: 'skill:skill1' }, { type: 'action', name: 'wait' }] },
    };
    const ld = { role, skills: skills3, ai: simpleAi };

    if (role && skills3.length === 3) {
      samples.loadout_valid = (await req('POST', '/api/v1/loadout', { loadout: ld, warehouse: wh, tier: 'mythic' })).json;
      samples.panel_valid = (await req('POST', '/api/v1/panel', { loadout: ld, warehouse: wh, tier: 'mythic' })).json;
      const bad = JSON.parse(JSON.stringify(ld));
      bad.skills = [bad.skills[0], bad.skills[1]];
      samples.loadout_invalid = (await req('POST', '/api/v1/loadout', { loadout: bad, warehouse: wh, tier: 'mythic' })).json;
      samples.panel_invalid = (await req('POST', '/api/v1/panel', { loadout: bad, warehouse: wh, tier: 'mythic' })).json;

      // 对战：p1=玩家 loadout，p2=bot 同构 loadout（数据表驱动，无插件引用）
      const roleT = require('../server/data/role-templates.json').roleTemplates.find((r) => r.id === 'role_bal');
      const common = require('../server/data/skill-templates.json').skillTemplates.filter((t) => !t.unlockTier || t.unlockTier === 'common');
      const bot = {
        role: {
          uid: 'bot_role', kind: 'role', templateId: roleT.id, quality: 'common', slotCount: 0, slots: [],
          stats: { hp: roleT.baseStats.hp, atk: roleT.baseStats.atk, def: roleT.baseStats.def, sp: roleT.baseStats.sp, mp: roleT.baseStats.mp },
          regen: roleT.regen, pluginPoints: roleT.pluginPoints || 3, unlockTier: 'common',
        },
        skills: [0, 1, 2].map((i) => {
          const t = common[i % common.length];
          return {
            uid: `bot_skill${i + 1}`, kind: 'skill', templateId: t.id, quality: 'common', slotCount: 0, slots: [],
            params: { multiplier: 1, cost: { hp: t.baseCost.hp, mp: t.baseCost.mp, sp: t.baseCost.sp }, cooldown: t.cooldown, bulletLevel: t.bulletLevel },
            unlockTier: 'common',
          };
        }),
        ai: { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } },
      };
      const bt = await req('POST', '/api/v1/battle', { p1: ld, p2: bot, warehouse: wh, seed: SEED, tier: 'mythic' });
      samples.battle_valid_meta = { status: bt.status, ok: bt.json.ok, data: bt.json.ok ? Object.assign({}, bt.json.data, { frames: `[${bt.json.data.frames.length} frames —— 见 battle_frame_*]` }) : bt.json.error };
      if (bt.json.ok) {
        const frames = bt.json.data.frames;
        samples.battle_frame_first = frames[0];
        samples.battle_frame_mid = frames[Math.min(3, frames.length - 1)];
        samples.battle_frame_last = frames[frames.length - 1];
        samples.battle_frames_len = frames.length;
        samples.battle_p1 = ld;
        samples.battle_p2 = bot;
        const rp = await req('GET', `/api/v1/replay/${bt.json.data.id}?from=1&to=2`);
        samples.replay_slice_1_2 = rp.json;
      }

      // AI 端点：校验（合法/非法）+ 编译
      samples.ai_validate_ok = (await req('POST', '/api/v1/ai/validate', { program: simpleAi, tier: 'mythic' })).json;
      const badAi = {
        type: 'program', version: 2,
        body: { type: 'seq', statements: [{ type: 'loop', kind: 'while', cond: { type: 'literal', value: true }, body: { type: 'seq', statements: [{ type: 'if', cond: { type: 'literal', value: true }, then: { type: 'action', name: 'wait' } }] } }] },
      };
      samples.ai_validate_invalid = (await req('POST', '/api/v1/ai/validate', { program: badAi, tier: 'mythic' })).json;
      samples.ai_compile_ok = (await req('POST', '/api/v1/ai/compile', { program: simpleAi })).json;
      const curAi = { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'defend' }, { type: 'action', name: 'move_right' }] } };
      samples.ai_battle_kiter = await (async () => {
        const r = await req('POST', '/api/v1/ai/battle', { program: curAi, seed: SEED, tier: 'mythic', opponent: 'kiter' });
        if (!r.json.ok) return r.json;
        return { ok: true, data: Object.assign({}, r.json.data, { frames: `[${r.json.data.frames.length} frames]`, firstFrame: r.json.data.frames[0] }) };
      })();
      samples.ai_battle_unknown_opponent = (await req('POST', '/api/v1/ai/battle', { program: curAi, seed: SEED, tier: 'mythic', opponent: 'nope' })).json;
    }

    // 排位：run + promote（真实响应；段位 common → 只用 common 段位物品的 loadout）
    if (role && skills3.length === 3) {
      const commonRole = synthItem('role', 'role_bal', 'common', 1, 'item_common_role');
      const commonSkills = ['skill_melee_whirl', 'skill_straight_precise', 'skill_melee_whirl']
        .map((id, i) => synthItem('skill', id, 'common', 1, `item_common_skill${i + 1}`));
      const commonLd = { role: commonRole, skills: commonSkills, ai: simpleAi };
      const rr = await req('POST', '/api/v1/ranked/run', { loadout: commonLd, seed: 11, tier: 'common' });
      samples.ranked_run = rr.json.ok ? { ok: true, data: rr.json.data } : rr.json;
      samples.ranked_run_bad_tier_items = (await req('POST', '/api/v1/ranked/run', { loadout: ld, warehouse: wh, seed: 11, tier: 'common' })).json;
      samples.ranked_promote_7 = (await req('POST', '/api/v1/ranked/promote', { tier: 'common', wins: 7 })).json;
      samples.ranked_promote_3 = (await req('POST', '/api/v1/ranked/promote', { tier: 'common', wins: 3 })).json;
      samples.ranked_promote_max = (await req('POST', '/api/v1/ranked/promote', { tier: 'mythic', wins: 10 })).json;
    }

    // 命中/碰撞样本：直线技对"原地等待"的对手必命中；制造 collision 与 verdict 帧
    const hitRole = synthItem('role', 'role_bal', 'rare', 2, 'item_hit_role');
    const straight = synthItem('skill', 'skill_straight_precise', 'rare', 2, 'item_hit_skill1');
    const filler = [1, 2].map((i) => synthItem('skill', 'skill_melee_whirl', 'rare', 2, `item_hit_filler${i}`));
    const hp1 = {
      role: hitRole,
      skills: [straight].concat(filler),
      ai: { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'skill:skill1' }] } },
    };
    const hp2 = {
      role: hitRole,
      skills: filler.concat([straight]),
      ai: { type: 'program', version: 2, body: { type: 'seq', statements: [{ type: 'action', name: 'move_left' }] } },
    };
    const rb = await req('POST', '/api/v1/battle', { p1: hp1, p2: hp2, seed: 7, tier: 'mythic' });
    if (rb.json.ok) {
      const frames = rb.json.data.frames;
      samples.battle2_meta = { winner: rb.json.data.winner, phase: rb.json.data.phase, ticks: rb.json.data.ticks, id: rb.json.data.id };
      samples.battle2_frame_with_hit = frames.find((f) => (f.diff.bulletHits || []).length > 0) || null;
      samples.battle2_frame_with_collision = frames.find((f) => f.diff.collision) || null;
      samples.battle2_frame_verdict = frames[frames.length - 1];
      samples.battle2_frames_len = frames.length;
      samples.battle2_p1 = hp1;
      samples.battle2_p2 = hp2;
    }

    // 错误信封样本
    samples.err_bad_tier = (await req('GET', '/api/v1/unlock?tier=nope')).json;
    samples.err_unknown_table = (await req('GET', '/api/v1/data/nope')).json;
    samples.err_box_times = (await req('POST', '/api/v1/box', { seed: 1, tier: 'common', times: 999 })).json;
    samples.err_bad_json = await (async () => {
      const res = await fetch(base + '/api/v1/box', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
      return { status: res.status, json: await res.json() };
    })();

    fs.writeFileSync(out, JSON.stringify(samples, null, 2), 'utf8');
    const keys = Object.keys(samples);
    console.log(`[fe-samples] ${keys.length} 个样本写入 ${path.relative(ROOT, out)}`);
    for (const k of keys) console.log(`  - ${k}`);
  } finally {
    await s.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
