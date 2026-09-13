'use strict';
// F4 battle 配置屏测试 —— frontend-spec §6.5（对手模板/config·preview 布局/摘要/seed/battle-run effect/对手选择）
const { test } = require('node:test');
const assert = require('node:assert/strict');

const mkState = (patch) => Object.assign({
  screen: 'battle', tier: 'mythic', seed: 7,
  meta: { serverOk: true },
  loadout: { role: { uid: 'r1', name: '均衡', quality: 'rare' }, skills: [{ uid: 's1', name: '平射' }, null, null], ai: null },
  panel: null,
  aiDraft: { program: null, hash: null, errors: [], compiling: false },
  gacha: { opening: false, lastResult: null },
  battle: { config: null, running: false, frames: [], result: null, tick: 0, speed: 1, playing: false },
  ui: { busy: false, snackbar: [], modal: null, activeTab: { battle: 'kiter' } },
  warehouse: { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } },
}, patch || {});

test('OPPONENTS 三模板 + opponentOf 缺省回退 + loadoutSummary', async () => {
  const { OPPONENTS, opponentOf, loadoutSummary } = await import('../../public/js/views/battle.js');
  assert.equal(OPPONENTS.length, 3);
  assert.deepEqual(OPPONENTS.map((o) => o.id), ['kiter', 'charger', 'cautious']);
  assert.equal(opponentOf('charger').label, '冲锋型');
  assert.equal(opponentOf('nope').id, 'kiter', '未知回退');
  assert.equal(opponentOf(undefined).id, 'kiter');
  const ld = { role: { name: '均衡', quality: 'rare' }, skills: [{ name: '平射' }, null, { templateId: 'skill_x' }] };
  const sum = loadoutSummary({ loadout: ld });
  assert.ok(sum.includes('角色：均衡（rare）') && sum.includes('技能1：平射') && sum.includes('技能2：skill_x'), `实际: ${sum}`);
  assert.equal(loadoutSummary({ loadout: { role: null, skills: [] } }), '未配置出战：先开箱/装配');
  // 模板 loadout 形状（battle 端点所需：role + skills + ai）
  for (const o of OPPONENTS) {
    assert.ok(o.loadout.role && Array.isArray(o.loadout.skills) && o.loadout.ai, `${o.id} 模板完整`);
    assert.equal(o.loadout.skills.length, 3);
  }
});

test('F4 审查 P1 回归：模板 loadout 与后端数据表同步（技能 id 存在 + common 门控可达）', () => {
  // 同步锁：前端 OPPONENTS 模板必须能被后端 /battle 的 validateLoadout 消费（F4 审查 P1：
  // 原第 3 技能 skill_displacement_bash 为不存在 id → 真后端三模板全 409；B24 bot 同构循环取 common 技能）
  const SKILLS = require('../../server/data/skill-templates.json').skillTemplates;
  const ROLES = require('../../server/data/role-templates.json').roleTemplates;
  const skillIds = new Set(SKILLS.map((s) => s.id));
  const roleIds = new Set(ROLES.map((r) => r.id));
  // 本批次：node:test 同步用例内 await import 不可用 → require(ESM)（node ≥22.12 默认支持）
  const { OPPONENTS } = require('../../public/js/views/battle.js');
  for (const o of OPPONENTS) {
    assert.ok(roleIds.has(o.loadout.role.templateId), `${o.id} 角色模板 ${o.loadout.role.templateId} 必须在数据表`);
    for (const sk of o.loadout.skills) {
      assert.ok(skillIds.has(sk.templateId), `${o.id} 技能 ${sk.templateId} 必须在数据表`);
      const t = SKILLS.find((x) => x.id === sk.templateId);
      assert.ok(!t.unlockTier || t.unlockTier === 'common', `${o.id} 技能 ${sk.templateId} 必须 common 门控可达（模板 unlockTier=${sk.unlockTier}）`);
    }
  }
});

test('battleLayout：config/preview 坐标 + 对手 radio + seed 行 + 开始按钮 + verifyLayout 全绿', async () => {
  const { battleLayout } = await import('../../public/js/views/battle.js');
  const { verifyLayout } = await import('../../public/js/ui/verify.js');
  const boxes = battleLayout(mkState());
  const config = boxes.find((b) => b.id === 'battle_config');
  assert.deepEqual([config.x, config.y, config.w, config.h], [16, 80, 640, 400]);
  const preview = boxes.find((b) => b.id === 'battle_preview');
  assert.deepEqual([preview.x, preview.y, preview.w, preview.h], [680, 80, 584, 400]);
  const radios = boxes.filter((b) => b.kind === 'radio');
  assert.equal(radios.length, 3);
  assert.equal(radios.find((b) => b.id === 'battle_opp_kiter').style, 'on');
  assert.equal(boxes.find((b) => b.id === 'battle_seed').text.includes('seed：7'), true);
  assert.equal(boxes.find((b) => b.id === 'battle_seed_rand').action, 'seed/random');
  const start = boxes.find((b) => b.id === 'battle_start');
  assert.equal(start.action, 'battle/run');
  assert.equal(start.payload.opponent.role.templateId, 'role_bal', '开始按钮携带对手 loadout');
  assert.equal(start.payload.opponent.skills.length, 3);
  const verify = verifyLayout(boxes);
  assert.equal(verify.ok, true, `布局自检全绿：${verify.issues.slice(0, 3).map((i) => `${i.boxId}:${i.issue}`).join(',')}`);
});

test('battleLayout 状态分支：未选对手/无面板提示/错误提示/seed 未设', async () => {
  const { battleLayout } = await import('../../public/js/views/battle.js');
  const none = battleLayout(mkState({ ui: { busy: false, snackbar: [], modal: null, activeTab: {}, selected: null } }));
  assert.equal(none.find((b) => b.id === 'battle_opp_kiter').style, 'on', '无 activeTab → 默认对手');
  const unset = battleLayout(mkState({ seed: null }));
  assert.equal(unset.find((b) => b.id === 'battle_seed').text.includes('后端生成回带'), true);
  const hint = battleLayout(mkState());
  assert.equal(hint.find((b) => b.id === 'battle_panel_hint').text.includes('点「看面板」'), true);
  const paneled = battleLayout(mkState({ panel: { role: { stats: { hp: 100, atk: 10, def: 8, mp: 40, sp: 60 } }, skills: [{ params: { multiplier: 1.2, cost: { mp: 16 } } }] } }));
  assert.ok(paneled.find((b) => b.id === 'battle_panel_stats').text.includes('hp 100'));
  const errState = mkState({ aiDraft: { errors: [{ code: 'missing_warehouse', message: 'x' }] } });
  assert.ok(battleLayout(errState).find((b) => b.id === 'battle_ld_errors').text.includes('missing_warehouse'));
});

test('battleLayout 分支锤：空技能/无 stats/技能无 params/错误无 code', async () => {
  const { battleLayout, loadoutSummary } = await import('../../public/js/views/battle.js');
  // skills 空数组 → 技能摘要兜底；stats 缺失 → ? 兜底（不渲染 undefined）
  const p1 = battleLayout(mkState({ panel: { role: { stats: undefined } } }));
  const statsText = p1.find((b) => b.id === 'battle_panel_stats');
  assert.equal(statsText.text.includes('undefined'), false, 'stats 缺失 ? 兜底');
  assert.ok(statsText.text.includes('hp ?'));
  const p2 = battleLayout(mkState({ panel: { role: { stats: { hp: 1 } }, skills: [{ params: { multiplier: 0, cost: { mp: 16 } } }, { params: {} }, { baz: 1 }] } }));
  assert.ok(p2.find((b) => b.id === 'battle_panel_skills').text.includes('mp16'), '多技能摘要含 mp16 段（multiplier 0 不渲染 ×）');
  const mp0 = battleLayout(mkState({ panel: { role: { stats: { hp: 1 } }, skills: [{ params: { cost: { mp: 0 } } }] } }));
  assert.ok(mp0.find((b) => b.id === 'battle_panel_skills').text.includes('mp0'), 'mp 0 段仍渲染');
  const emptySkills = battleLayout(mkState({ panel: { role: { stats: { hp: 1 } }, skills: [] } }));
  assert.equal(emptySkills.find((b) => b.id === 'battle_panel_skills').text, '（技能摘要）');
  // errors 无 code 无 message → 兜底 '不合法'
  const errNoCode = battleLayout(mkState({ aiDraft: { errors: [{ path: 'body.s[1]' }] } }));
  assert.ok(errNoCode.find((b) => b.id === 'battle_ld_errors').text.includes('不合法'));
  const errMsgOnly = battleLayout(mkState({ aiDraft: { errors: [{ message: '资源不足' }] } }));
  assert.ok(errMsgOnly.find((b) => b.id === 'battle_ld_errors').text.includes('资源不足'));
  // state.ui null（外壳缺 ui 层）→ 默认对手；loadoutSummary 缺 skills/role 无 name
  const noUi = mkState(undefined);
  delete noUi.ui;
  assert.equal(battleLayout(noUi).find((b) => b.id === 'battle_opp_kiter').style, 'on');
  assert.equal(loadoutSummary({ loadout: { role: { templateId: 'role_x' }, skills: undefined } }), '角色：role_x（?）');
  assert.equal(loadoutSummary({ loadout: { role: { uid: 'u1' } } }), '角色：u1（?）');
});

test('reducer/effects：battle/opp/set + battle/run 全链（ok → frames + goto replay；err → toast）', async () => {
  const { reducer, initialState } = await import('../../public/js/store/reducer.js');
  const s1 = reducer(initialState(), { type: 'battle/opp/set', payload: { id: 'charger' } });
  assert.equal(s1.ui.activeTab.battle, 'charger');
  const { runEffect } = await import('../../public/js/store/effects.js');
  const actions = [];
  const bodies = [];
  const api = {
    post: async (p, body) => {
      bodies.push([p, body]);
      return p === '/battle'
        ? { ok: true, data: { seed: 9, winner: 'A', ticks: 5, frames: [{ tick: 1, diff: {} }] } }
        : { ok: false };
    },
    get: async () => ({ ok: false }),
  };
  const warehouse = { buckets: { role: [], skill: [], rolePlugin: [], skillPlugin: [] } };
  const ctx = {
    api,
    store: () => ({ loadout: { role: null, skills: [] }, seed: 7, tier: 'mythic', warehouse }),
    dispatch: (a) => actions.push(a),
    log: null, save: null, doc: null,
  };
  await runEffect(ctx, { type: 'battle/run', payload: { opponent: { id: 'kiter' } } });
  const loaded = actions.find((a) => a.type === 'battle/loaded');
  assert.ok(loaded, 'battle/loaded');
  assert.equal(loaded.payload.frames.length, 1);
  assert.ok(actions.some((a) => a.type === 'goto' && a.payload.screen === 'replay'));
  // F4 审查 P1 回归：请求体必须携带 warehouse（缺失 → 真后端 409 missing_warehouse）
  const sent = bodies.find(([p]) => p === '/battle');
  assert.ok(sent, 'POST /battle 已发出');
  assert.equal(sent[1].warehouse, warehouse, 'battle/run 携带 st.warehouse（装配引用完整性校验需要）');
  assert.deepEqual(sent[1].p1, { role: null, skills: [] }, 'p1=st.loadout');
  assert.equal(sent[1].seed, 7);
  // err → toast 且不跳转
  const badApi = { ...api, post: async () => ({ ok: false, code: 'loadout_invalid' }) };
  const ctxBad = { ...ctx, api: badApi };
  const before = actions.length;
  await runEffect(ctxBad, { type: 'battle/run', payload: { opponent: null } });
  assert.ok(actions.slice(before).some((a) => a.type === 'ui/toast'));
  assert.ok(!actions.slice(before).some((a) => a.type === 'goto'));
  // seed/random（缺省 Date.now 派生 + 注入缝两态）
  const seeds = [];
  const ctxR = { ...ctx, dispatch: (a) => seeds.push(a) };
  await runEffect(ctxR, { type: 'seed/random' });
  const r1 = seeds.find((a) => a.type === 'seed/set').payload.seed;
  assert.ok(Number.isInteger(r1) && r1 >= 1 && r1 <= 0x7fffffff);
  const seeds2 = [];
  const ctxC = { ...ctxR, dispatch: (a) => seeds2.push(a), randomInt: () => 12345 };
  await runEffect(ctxC, { type: 'seed/random' });
  assert.equal(seeds2.find((a) => a.type === 'seed/set').payload.seed, 12345, '注入缝生效');
  // battle/run 无 payload（opponent 空臂）
  const acts3 = [];
  const ctx3 = { ...ctx, api: { post: async () => ({ ok: false, code: 'bad_request' }) }, dispatch: (a) => acts3.push(a) };
  await runEffect(ctx3, { type: 'battle/run' });
  assert.ok(acts3.some((a) => a.type === 'ui/toast'));
  // battle/opp（无副作用 → 只写 activeTab）
  const acts = [];
  await runEffect({ ...ctx, dispatch: (a) => acts.push(a) }, { type: 'battle/opp', payload: { id: 'cautious' } });
  assert.deepEqual(acts, [{ type: 'battle/opp/set', payload: { id: 'cautious' } }]);
});

test('candidatesFor slot 预过滤（F3 P2★）：槽型匹配/无 slot 字段放行', async () => {
  const { candidatesFor } = await import('../../public/js/views/warehouse.js');
  const item = { uid: 'r1', kind: 'role' };
  const wh = { buckets: { rolePlugin: [
    { uid: 'a', kind: 'rolePlugin', slot: 'atk', equipped: false },
    { uid: 'b', kind: 'rolePlugin', slot: 'def', equipped: false },
    { uid: 'c', kind: 'rolePlugin', equipped: false }, // 无 slot 字段 → 放行给后端
    { uid: 'd', kind: 'rolePlugin', slot: 'atk', equipped: true },
  ] } };
  const atk = candidatesFor(item, wh, 'mythic', 'atk');
  assert.deepEqual(atk.map((p) => p.uid), ['a', 'c'], 'atk 槽：a 匹配 + c 无字段放行；d 已装备排除');
  const def = candidatesFor(item, wh, 'mythic', 'def');
  assert.deepEqual(def.map((p) => p.uid), ['b', 'c']);
  const undef = candidatesFor(item, wh, 'mythic', undefined);
  assert.equal(undef.length, 3, '无槽型参数 → 不过滤');
});