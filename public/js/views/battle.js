// views/battle.js —— 对战配置屏（frontend-spec §6.5；坐标口径 = docs/screens.md「对战配置 battle」盒子表）
import { button } from '../ui/layout.js';

// 内置对手模板（B22 端点需完整 loadout；与 B24 后端 bot 独立——前端模板登记）
// F4 审查 P1：模板技能必须能被后端 /battle 的 validateLoadout 消费——技能模板表 common 档仅 2 个
// （skill_melee_whirl / skill_straight_precise；实测原 skill_displacement_bash 为不存在 id → 全部 409）。
// 与 B24 后端 bot 同构：common 技能循环取满 3 槽（validateLoadout 不查 templateId 唯一）。
export const OPPONENTS = (() => {
  const COMMON_SKILL_IDS = ['skill_melee_whirl', 'skill_straight_precise'];
  const ROLE = { uid: 'opp_role', kind: 'role', templateId: 'role_bal', quality: 'common', slotCount: 0, slots: [], stats: { hp: 100, atk: 10, def: 8, sp: 60, mp: 40 }, regen: { mp: 1, sp: 2 }, pluginPoints: 3, unlockTier: 'common' };
  const SKILLS = Array.from({ length: 3 }, (_, i) => ({
    uid: `opp_skill${i + 1}`, kind: 'skill', templateId: COMMON_SKILL_IDS[i % COMMON_SKILL_IDS.length],
    quality: 'common', slotCount: 0, slots: [],
    params: { multiplier: 1, cost: { hp: 0, mp: 10, sp: 0 }, cooldown: 3, bulletLevel: 3 }, unlockTier: 'common',
  }));
  const mkAi = (kind) => ({ type: 'program', version: 1, body: { type: 'seq', statements: [{ type: 'action', name: kind }] } });
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

// 我方 loadout 摘要（纯函数；空 → 提示行）
export function loadoutSummary(state) {
  const ld = state.loadout || {};
  const role = ld.role;
  const skills = (ld.skills || []).filter(Boolean);
  if (!role && skills.length === 0) return '未配置出战：先开箱/装配';
  const roleLine = role ? `角色：${role.name || role.templateId || role.uid}（${role.quality || '?'}）` : '角色：未选';
  const skillLines = skills.map((s, i) => `技能${i + 1}：${s.name || s.templateId || s.uid}`);
  return [roleLine, ...skillLines].join('；');
}

// screens.md battle 表：config(16,80,640,400,z2) sel_opp(40,120,600,40,z3) loadoutSum(40,176,600,120,z3)
// fld_seed(40,312,280,40,z3) btn_seed(336,312,120,40,z3) preview(680,80,584,400,z2) stats(704,140,536,240,z3)
// btn_start(560,500,160,40,z4)
const CONFIG = { x: 16, y: 80, w: 640, h: 400, z: 2 };
const SEL_OPP = { x: 40, y: 120, w: 600, h: 40, z: 3 };
const LOADOUT_SUM = { x: 40, y: 176, w: 600, h: 120, z: 3 };
const FLD_SEED = { x: 40, y: 312, w: 280, h: 40, z: 3 };
const BTN_SEED = { x: 336, y: 312, w: 120, h: 40, z: 3 };
const PREVIEW = { x: 680, y: 80, w: 584, h: 400, z: 2 };
const STATS = { x: 704, y: 140, w: 536, h: 240, z: 3 };
const BTN_START = { x: 560, y: 500, w: 160, h: 40, z: 4 };
const STATS_IN = { x: STATS.x + 16, w: STATS.w - 32 }; // stats 容器内元素（左右各留 16）

export function battleLayout(state) {
  const pair = opponentOf(state.ui && state.ui.activeTab && state.ui.activeTab.battle);
  const next = OPPONENTS[(OPPONENTS.indexOf(pair) + 1) % OPPONENTS.length];
  const errs = (state.aiDraft && state.aiDraft.errors) || [];
  const p = state.panel;
  const boxes = [
    { id: 'config', kind: 'panel', parent: null, ...CONFIG, visible: true, text: '对战配置' },
    {
      id: 'sel_opp', kind: 'select', parent: 'config',
      x: SEL_OPP.x, y: SEL_OPP.y, w: SEL_OPP.w, h: SEL_OPP.h, z: SEL_OPP.z, visible: true,
      text: `对手：${pair.label}（${pair.id}）· ${pair.note}`, action: 'battle/opp', payload: { id: next.id },
    },
    {
      id: 'loadoutSum', kind: 'text', parent: 'config', style: 'wrap',
      x: LOADOUT_SUM.x, y: LOADOUT_SUM.y, w: LOADOUT_SUM.w, h: LOADOUT_SUM.h, z: LOADOUT_SUM.z, visible: true,
      text: loadoutSummary(state),
    },
    {
      id: 'fld_seed', kind: 'field', parent: 'config',
      x: FLD_SEED.x, y: FLD_SEED.y, w: FLD_SEED.w, h: FLD_SEED.h, z: FLD_SEED.z, visible: true,
      text: `seed：${state.seed === null || state.seed === undefined ? '（未设，后端生成回带）' : state.seed}`,
      action: 'seed/random',
    },
    {
      id: 'btn_seed', kind: 'button', parent: 'config', style: 'ghost',
      x: BTN_SEED.x, y: BTN_SEED.y, w: BTN_SEED.w, h: BTN_SEED.h, z: BTN_SEED.z, visible: true,
      text: '随机 seed', action: 'seed/random',
    },
  ];
  // 校验错误提示（loadout/errors 首条；config 容器底部一行，避开 sel_opp/loadoutSum/fld_seed）
  if (errs.length > 0) {
    boxes.push({
      id: 'battle_ld_errors', kind: 'text', parent: 'config', style: 'danger',
      x: LOADOUT_SUM.x, y: CONFIG.y + CONFIG.h - 40, w: LOADOUT_SUM.w, h: 24, z: 3, visible: true,
      text: `⚠ 出战配置待修：${errs[0].code || errs[0].message || '不合法'}`,
    });
  }
  // 右：预览容器 + stats 子容器（我方面板：点 stats 拉 /panel）
  boxes.push({ id: 'preview', kind: 'panel', parent: null, ...PREVIEW, visible: true, text: '预览' });
  boxes.push({
    id: 'stats', kind: 'region', parent: 'preview', style: 'panel',
    x: STATS.x, y: STATS.y, w: STATS.w, h: STATS.h, z: STATS.z, visible: true,
    text: p && p.role ? '我方面板' : '未加载面板（点击本框 / 或「看面板」）',
    action: 'panel/show',
  });
  if (p && p.role) {
    const s = p.role.stats || {};
    const v = (k) => (s[k] === undefined ? '?' : s[k]);
    boxes.push({
      id: 'battle_panel_stats', kind: 'text', parent: 'stats',
      x: STATS_IN.x, y: STATS.y + 32, w: STATS_IN.w, h: 60, z: 4, visible: true,
      text: `hp ${v('hp')} | atk ${v('atk')} | def ${v('def')} | mp ${v('mp')} | sp ${v('sp')}`
        + ` | regen mp${(p.role.regen && p.role.regen.mp) || 0}/sp${(p.role.regen && p.role.regen.sp) || 0}`
        + ` | 插件点 ${v('pluginPoints')}`,
    });
    const skills = (p.skills || []).map((sk) => (sk.params ? `· ×${sk.params.multiplier === undefined ? '?' : sk.params.multiplier} mp${(sk.params.cost && sk.params.cost.mp) || 0}` : '· —')).join(' ');
    boxes.push({
      id: 'battle_panel_skills', kind: 'text', parent: 'stats',
      x: STATS_IN.x, y: STATS.y + 100, w: STATS_IN.w, h: 40, z: 4, visible: true,
      text: skills || '（技能摘要）',
    });
  }
  boxes.push({
    id: 'battle_opp_card', kind: 'text', parent: 'stats', style: 'wrap',
    x: STATS_IN.x, y: STATS.y + 180, w: STATS_IN.w, h: 48, z: 4, visible: true,
    text: `对手：${pair.label}——${pair.note}（${OPPONENTS.map((o) => o.id).join(' / ')} 循环切换）`,
  });
  // 开始对战（表：btn_start 560,500,160,40,z4）
  boxes.push({
    id: 'btn_start', kind: 'button', parent: null, style: 'primary',
    x: BTN_START.x, y: BTN_START.y, w: BTN_START.w, h: BTN_START.h, z: BTN_START.z, visible: true,
    text: '开始对战', action: 'battle/run', payload: { opponent: pair.loadout },
  });
  return boxes;
}