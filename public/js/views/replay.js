// views/replay.js —— 回放屏（frontend-spec §6.6/§7；坐标口径 = docs/screens.md「回放与结算 replay」盒子表）
import { SIZES } from '../ui/sizes.js';
import { button } from '../ui/layout.js';

// screens.md replay 表（画布带 y80..208）：
// canvas(16,80,1024,128,z1) hp1(16,84,96,8,z4) hp2(912,84,96,8,z4) controls(16,220,1024,56,z2)
// aiTrace(1064,80,200,400,z2) modal(400,280,480,160,z90)
// 表内 p1/p2/bullet/base_l/base_r 为**画布内容**（引擎 px：base_l x=0、base_r 992+32=1024 仅画布局部坐标成立），
// 由 render/planFrame 绘制、不建 DOM 盒；其位置经 render.frame 日志核对（见 tests/frontend/screens.test.js）。
const CANVAS = { x: 16, y: 80, w: 1024, h: 128, z: 1 };
const HP1 = { x: 16, y: 84, w: 96, h: 8, z: 4 };
const HP2 = { x: 912, y: 84, w: 96, h: 8, z: 4 };
const CONTROLS = { x: 16, y: 220, w: 1024, h: 56, z: 2 };
const AI_TRACE = { x: 1064, y: 80, w: 200, h: 400, z: 2 };
const MODAL = { x: 400, y: 280, w: 480, h: 160, z: 91 }; // 表内 z90；遮罩占 90、面板须在其上 → 91（≤1 层差）
const SPEEDS = [1, 2, 4];
const CTRL = { y: 228, w: 96, h: 32, z: 3 }; // controls 容器内元素（240..276 内居中）

// 血条填充比（纯投影：帧内该方 hp / 全帧最大值；缺数据 → 满格。渲染层只读 frames、不重算战斗）
export function hpRatio(frames, owner, hp) {
  if (!Number.isFinite(hp)) return 1;
  let max = 0;
  for (const f of frames || []) {
    const p = f && f.diff && f.diff.players && f.diff.players[owner];
    if (p && Number.isFinite(p.hp) && p.hp > max) max = p.hp;
  }
  if (!(max > 0)) return 1;
  return Math.max(0, Math.min(1, hp / max));
}

// 填充宽度（≥2px：0 血仍留可见残条，同时避免 verifyLayout 的 zero 误报）
export function hpFillWidth(trackW, ratio) {
  return Math.max(2, Math.round(trackW * ratio));
}

// 控制条数值行（表内 controls 右侧 T:x/y 位；hp 数值一并在此呈现——表内 hp1/hp2 仅 8px 条无文字位）
export function statusText(frames, tick, players, bases) {
  const last = frames.length > 0 ? frames.length - 1 : 0;
  const read = (owner) => {
    const p = players[owner];
    const b = bases[owner];
    if (!p) return `${owner} —`;
    return `${owner} hp ${p.hp}${b && b.hp !== undefined ? `/base ${b.hp}` : ''}`;
  };
  return `T:${tick}/${last} · ${read('p1')} · ${read('p2')}`;
}

export function replayLayout(state) {
  const b = state.battle || {};
  const frames = b.frames || [];
  const tick = b.tick || 0;
  const frame = frames[tick] || null;
  const diff = (frame && frame.diff) || {};
  const players = diff.players || {};
  const bases = diff.bases || {};
  const boxes = [
    // 画布容器（图元由 mount/canvas.js 经 planFrame 绘制；盒本身不承载文字）
    { id: 'canvas', kind: 'canvas', parent: null, ...CANVAS, visible: true, text: '' },
  ];
  // HUD 血条（表内 z4，叠在画布上方）：轨道 + 填充（填充宽度 = 轨道 96 × 当前 hp/峰值 hp）
  for (const [id, owner, geo] of [['hp1', 'p1', HP1], ['hp2', 'p2', HP2]]) {
    const p = players[owner];
    const ratio = hpRatio(frames, owner, p ? p.hp : undefined);
    boxes.push({
      id, kind: 'bar', parent: 'canvas', style: `hp ${id}`,
      x: geo.x, y: geo.y, w: geo.w, h: geo.h, z: geo.z, visible: true, text: '',
    });
    boxes.push({
      id: `${id}_fill`, kind: 'bar-fill', parent: id, style: `hp ${id}`,
      x: geo.x + 1, y: geo.y + 1, w: hpFillWidth(geo.w - 2, ratio), h: geo.h - 2, z: geo.z + 1, visible: true, text: '',
    });
  }
  // 控制条（播放/暂停/步进/后退/倍速 + 状态行）
  boxes.push({ id: 'controls', kind: 'panel', parent: null, ...CONTROLS, visible: true, text: '' });
  boxes.push(button('replay_play', 32, CTRL.y, b.playing ? '暂停' : '播放', {
    parent: 'controls', z: CTRL.z, ghost: true, style: b.playing ? 'on' : '',
    action: b.playing ? 'replay/pause' : 'replay/play',
  }));
  boxes.push(button('replay_step', 136, CTRL.y, '步进', { parent: 'controls', z: CTRL.z, ghost: true, action: 'replay/step' }));
  boxes.push(button('replay_back', 240, CTRL.y, '后退', { parent: 'controls', z: CTRL.z, ghost: true, action: 'replay/step', payload: { delta: -1 } }));
  SPEEDS.forEach((sp, i) => {
    boxes.push(button(`replay_speed_${sp}`, 352 + i * 104, CTRL.y, `×${sp}`, {
      parent: 'controls', z: CTRL.z, ghost: true,
      style: b.speed === sp ? 'on' : 'off', action: 'replay/speed', payload: { speed: sp },
    }));
  });
  boxes.push({
    id: 'replay_status', kind: 'text', parent: 'controls', style: 'right muted',
    x: 700, y: CTRL.y + 4, w: 320, h: 24, z: CTRL.z, visible: true,
    text: statusText(frames, tick, players, bases),
  });
  // 右侧 AI 轨迹（表内 aiTrace 1064,80,200,400,z2；行 z3）
  boxes.push({ id: 'aiTrace', kind: 'panel', parent: null, ...AI_TRACE, visible: true, text: 'AI 轨迹' });
  const traces = diff.aiTrace || [];
  const shown = traces.slice(-8);
  shown.forEach((t, i) => {
    boxes.push({
      id: `replay_ai_${i}`, kind: 'listitem', parent: 'aiTrace',
      x: AI_TRACE.x + 12, y: 120 + i * 24, w: AI_TRACE.w - 24, h: 20, z: 3, visible: true, text: traceText(t),
    });
  });
  if (shown.length === 0) {
    boxes.push({ id: 'replay_ai_empty', kind: 'text', parent: 'aiTrace', x: AI_TRACE.x + 12, y: 120, w: AI_TRACE.w - 24, h: 20, z: 3, visible: true, text: '（无轨迹）' });
  }
  // 结算 Modal（末帧才显示；遮罩 z90、面板 z91、内容 z92）
  const res = b.result;
  if (res && (frames.length === 0 || tick >= frames.length - 1)) {
    boxes.push({ id: 'replay_modal_mask', kind: 'modal-mask', parent: null, x: 0, y: 0, w: SIZES.viewportW, h: SIZES.viewportH, z: 90, visible: true, fullscreen: true });
    boxes.push({ id: 'modal', kind: 'panel', parent: 'replay_modal_mask', style: 'modal', ...MODAL, visible: true, text: '结算' });
    boxes.push({
      id: 'replay_modal_text', kind: 'title', parent: 'modal',
      x: MODAL.x + 16, y: MODAL.y + 48, w: MODAL.w - 32, h: 32, z: 92, visible: true,
      text: `winner=${res.winner || '?'}（${res.ticks || 0} tick）`,
    });
    boxes.push(button('replay_again', MODAL.x + 32, MODAL.y + 104, '再来一局', { parent: 'modal', z: 92, goto: 'battle' }));
    boxes.push(button('replay_menu', MODAL.x + 288, MODAL.y + 104, '返回菜单', { parent: 'modal', z: 92, ghost: true, goto: 'menu' }));
  }
  return boxes;
}

// aiTrace 行文本（实装字段映射：path/nodeType/result；result 仅 action 节点有值——runtime.js:134）
function traceText(t) {
  const head = t.path || t.nodeType || '';
  const tail = t.result !== undefined && t.result !== null ? ` →${t.result}` : '';
  return `${t.owner || ''} ${head}${tail}`.trim();
}