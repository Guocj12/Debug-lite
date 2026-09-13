// views/battle.js —— 对战配置屏（frontend-spec §6.5：config 左 16,80,640,400 / preview 右 680,80,584,400 / start y500）
import { SIZES, SPACES } from '../ui/sizes.js';
import { panel, button, center } from '../ui/layout.js';

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

export function battleLayout(state) {
  const pair = opponentOf(state.ui && state.ui.activeTab && state.ui.activeTab.battle);
  const boxes = [
    panel(16, 80, 640, 400, '对战配置', 'battle_config'),
  ];
  // 对手选择（3 档 radio）
  let oy = 116;
  for (const o of OPPONENTS) {
    boxes.push({
      id: `battle_opp_${o.id}`, kind: 'radio', parent: 'battle_config',
      x: 32, y: oy, w: 240, h: 32, z: 1, visible: true,
      text: `${o.label}（${o.note}）`, style: pair.id === o.id ? 'on' : 'off',
      action: 'battle/opp', payload: { id: o.id },
    });
    oy += 42;
  }
  // 我方 loadout 摘要
  boxes.push({ id: 'battle_ld_head', kind: 'text', parent: 'battle_config', x: 32, y: 250, w: 580, h: 20, z: 1, visible: true, text: '我方出战' });
  boxes.push({
    id: 'battle_ld_summary', kind: 'text', parent: 'battle_config',
    x: 32, y: 274, w: 580, h: 48, z: 1, visible: true, text: loadoutSummary(state),
  });
  // seed：当前值 + 随机按钮 + 面板预览按钮
  boxes.push({ id: 'battle_seed', kind: 'text', parent: 'battle_config', x: 32, y: 336, w: 300, h: 20, z: 1, visible: true, text: `seed：${state.seed === null ? '（未设，后端生成回带）' : state.seed}` });
  boxes.push(button('battle_seed_rand', 336, 328, '随机 seed', { parent: 'battle_config', z: 1, ghost: true, action: 'seed/random' }));
  boxes.push(button('battle_panel', 480, 328, '看面板', { parent: 'battle_config', z: 1, ghost: true, action: 'panel/show' }));
  // 校验错误提示（loadout/errors 首条）
  const errs = (state.aiDraft && state.aiDraft.errors) || [];
  if (errs.length > 0) {
    boxes.push({
      id: 'battle_ld_errors', kind: 'text', parent: 'battle_config', x: 32, y: 372, w: 580, h: 20, z: 1, visible: true,
      text: `⚠ 出战配置待修：${errs[0].code || errs[0].message || '不合法'}`,
    });
  }
  // preview 右：面板结果 + 对手简表
  boxes.push(panel(680, 80, 584, 400, '预览', 'battle_preview'));
  const p = state.panel;
  if (p && p.role) {
    const s = p.role.stats || {};
    const v = (k) => (s[k] === undefined ? '?' : s[k]);
    boxes.push({
      id: 'battle_panel_stats', kind: 'text', parent: 'battle_preview',
      x: 696, y: 116, w: 552, h: 60, z: 1, visible: true,
      text: `hp ${v('hp')} | atk ${v('atk')} | def ${v('def')} | mp ${v('mp')} | sp ${v('sp')}`,
    });
    const skills = (p.skills || []).map((sk) => sk.params && `· ${sk.params.multiplier ? `×${sk.params.multiplier}` : ''}${sk.params.cost ? ` mp${sk.params.cost.mp || 0}` : ''}`).join(' ');
    boxes.push({ id: 'battle_panel_skills', kind: 'text', parent: 'battle_preview', x: 696, y: 180, w: 552, h: 20, z: 1, visible: true, text: skills || '（技能摘要）' });
  } else {
    boxes.push({ id: 'battle_panel_hint', kind: 'text', parent: 'battle_preview', x: 696, y: 116, w: 552, h: 20, z: 1, visible: true, text: '未查看面板（点「看面板」）' });
  }
  boxes.push({ id: 'battle_opp_card', kind: 'text', parent: 'battle_preview', x: 696, y: 220, w: 552, h: 60, z: 1, visible: true, text: `对手：${pair.label}——${pair.note}` });
  // 开始对战（center 底部 y500 起，§6.5）
  const st = center(240, 48);
  boxes.push(button('battle_start', st.x - 120, 500, '开始对战', { parent: null, z: 2, style: 'primary', action: 'battle/run', payload: { opponent: pair.loadout } }));
  return boxes;
}