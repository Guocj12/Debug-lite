'use strict';
/* views/battle.js —— 对战配置屏（frontend-spec §6.5 + docs/screens.md battle 表）。
 * config(16,80,640,400)：对手选择（三模板循环）/ 我方 loadout 摘要 / seed Field+随机；
 * preview(680,80,584,400)：己方 panel（调 /panel）与对手简表；btn_start(560,500)。
 */
import { box, panel, button, verifyLayout } from '../ui/layout.js';
import { boxesToHtml } from './html.js';

// 内置对手模板（与 B24 后端 bot 同构；技能 id 必须存在于后端数据表——F4 审查教训）
export const OPPONENTS = (() => {
  const COMMON_SKILL_IDS = ['skill_melee_whirl', 'skill_straight_precise'];
  const ROLE = { uid: 'opp_role', kind: 'role', templateId: 'role_bal', quality: 'common', slots: [], stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 }, pluginPoints: 3, unlockTier: 'common' };
  const SKILLS = Array.from({ length: 3 }, (_, i) => ({
    uid: `opp_skill${i + 1}`, kind: 'skill', templateId: COMMON_SKILL_IDS[i % COMMON_SKILL_IDS.length],
    quality: 'common', slots: [],
    params: { multiplier: 1, cost: { hp: 0, mp: 10, sp: 0 }, cooldown: 3, bulletLevel: 3 }, unlockTier: 'common',
  }));
  const mkAi = (name) => ({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name }] } });
  const mk = (id, aiName, label, note) => ({ id, label, note, loadout: { role: ROLE, skills: SKILLS, ai: mkAi(aiName) } });
  return [
    mk('kiter', 'move_right', '风筝型', '持续右移，拉扯走位'),
    mk('charger', 'move_left', '冲锋型', '直线逼近'),
    mk('cautious', 'wait', '稳健型', '原地蓄力'),
  ];
})();

export function opponentOf(tabKey) {
  return OPPONENTS.find((o) => o.id === tabKey) || OPPONENTS[0];
}

// 我方 loadout 摘要（uid → 物品名回退；空 → 提示）
export function loadoutSummary(state) {
  const ld = state.loadout || {};
  const find = (uid) => {
    const hit = whFind(state, uid);
    return hit ? hit.name || hit.templateId || uid : String(uid);
  };
  const role = ld.role ? find(ld.role) : null;
  const skills = (ld.skills || []).filter(Boolean);
  if (!role && skills.length === 0) return '未配置出战：先开箱/装配（角色+3技能）';
  const roleLine = role ? `角色：${role}` : '角色：未选';
  const skillLines = skills.map((s, i) => `技能${i + 1}：${find(s)}`);
  return [roleLine, ...skillLines].join('；');
}

function whFind(state, uid) {
  const b = state.warehouse && state.warehouse.buckets;
  if (!b) return null;
  for (const key of ['role', 'skill', 'rolePlugin', 'skillPlugin']) {
    const hit = (b[key] || []).find((x) => x.uid === uid);
    if (hit) return hit;
  }
  return null;
}

const STATS_IN = { x: 704 + 16, y: 156, w: 536 - 32 };

export function battleLayout(state) {
  const s = state;
  const pair = opponentOf(s.ui.activeTab.battle);
  const next = OPPONENTS[(OPPONENTS.indexOf(pair) + 1) % OPPONENTS.length];
  const running = !!s.battle.running;
  const p = s.panel;
  const boxes = [
    panel('config', 16, 80, 640, 400),
    panel('preview', 680, 80, 584, 400),
    box('sel_opp', 'chip', 40, 120, 600, 40, { z: 3, parent: 'config', text: `对手：${pair.label}（${pair.id}）· ${pair.note}（点击切换为 ${next.label}）`, action: running ? null : 'battle/opp', payload: running ? undefined : { id: next.id }, disabled: running }),
    box('loadoutSum', 'text', 40, 176, 600, 120, { z: 3, parent: 'config', text: loadoutSummary(s) }),
    box('fld_seed', 'field', 40, 312, 280, 40, { z: 3, parent: 'config', action: 'seed/random', valueKey: 'seed', value: s.seed === null || s.seed === undefined ? '' : String(s.seed), text: 'seed（留空 = 后端生成回带）' }),
    button('btn_seed', 336, 312, { z: 3, parent: 'config', style: 'ghost', w: 120, h: 40, text: '随机', action: 'seed/random' }),
    box('stats', 'panel', 704, 140, 536, 240, { z: 3, parent: 'preview' }),
    box('opp_note', 'text', 704 + 16, 140 + 208, 536 - 32, 24, { z: 4, parent: 'stats', text: `对手（${pair.id}）：${pair.note} · 三模板与后端数据表同步（技能 id 可校验）` }),
    button('btn_start', 560, 500, { z: 4, text: running ? '对战运行中…' : '开始对战', action: running ? null : 'battle/run', disabled: running }),
  ];
  if (p) {
    boxes.push(box('stats_body', 'text', STATS_IN.x, 176, STATS_IN.w, 168, { z: 4, parent: 'stats', text: panelText(p) }));
  } else {
    boxes.push(box('stats_none', 'text', STATS_IN.x, 176, STATS_IN.w, 40, { z: 4, parent: 'stats', text: '预览未加载：点「刷新面板」（/panel）后显示五维/regen/技能参数' }));
  }
  boxes.push(box('btn_panel', 'chip', 704 + 16, 148, 96, 24, { z: 4, parent: 'stats', text: '刷新面板', action: 'panel/show' }));
  return boxes;
}

function panelText(p) {
  const r = p.role || {};
  const st = r.stats || {};
  const lines = [
    `角色 ${r.name || r.templateId || '?'}：hp ${st.hp} atk ${st.atk} def ${st.def} mp ${st.mp} sp ${st.sp}`,
    `regen：mp ${JSON.stringify(r.regen || {})} · special：${Object.keys(r.special || {}).join(',') || '无'}`,
  ];
  for (const sk of p.skills || []) {
    const pr = (sk && sk.params) || {};
    const nm = sk ? (sk.name || sk.templateId || '?') : '（空槽）';
    lines.push(`技能 ${nm}：倍率 ${pr.multiplier} 消耗 ${JSON.stringify(pr.cost || {})} CD ${pr.cooldown}`);
  }
  return lines.join('\n');
}

export function battleHtml(state) {
  return boxesToHtml(battleLayout(state));
}
