// views/replay.js —— 回放屏（frontend-spec §6.6：canvas 16,80,1024,128 + HUD + 控制条 y220 + aiTrace 右 + 结算 Modal）
import { SIZES, SPACES } from '../ui/sizes.js';
import { panel, button } from '../ui/layout.js';

export function replayLayout(state) {
  const b = state.battle || {};
  const frames = b.frames || [];
  const tick = b.tick || 0;
  const frame = frames[tick] || null;
  const boxes = [
    // 画布容器（图元由 mount/canvas.js 经 planFrame 绘制；文本留空——盒本身不承载文字）
    { id: 'replay_canvas', kind: 'canvas', parent: null, x: 16, y: 80, w: 1024, h: 128, z: 1, visible: true, text: '' },
  ];
  // HUD：p1/p2 状态条（canvas 上方 y=84..112；帧数据只读投影）
  // F5 审查 P1：基地条数据缺失——diff.bases{p1,p2}{hp,def} 每帧可用（B22 实装），补 base hp 投影；
  // 条状视觉 vs 文本行属 F7 风格统一（F5.md P2）
  const diff = (frame && frame.diff) || {};
  const players = diff.players || {};
  const bases = diff.bases || {};
  for (const owner of ['p1', 'p2']) {
    const p = players[owner];
    const baseHp = bases[owner] ? bases[owner].hp : '—';
    const px = owner === 'p1' ? 16 : 560;
    boxes.push({
      id: `replay_hud_${owner}`, kind: 'text', parent: null,
      x: px, y: 84, w: 480, h: 24, z: 2, visible: true,
      text: p ? `${owner} hp ${p.hp} mp ${p.mp} sp ${p.sp} base ${baseHp} @${p.toX}` : `${owner} —`,
    });
  }
  // 控制条（y=220..276）
  boxes.push(panel(16, 220, 1024, 56, null, 'replay_controls'));
  boxes.push(button('replay_play', 32, 228, b.playing ? '暂停' : '播放', { parent: 'replay_controls', z: 1, action: b.playing ? 'replay/pause' : 'replay/play' }));
  boxes.push(button('replay_step', 200, 228, '步进', { parent: 'replay_controls', z: 1, ghost: true, action: 'replay/step' }));
  boxes.push(button('replay_back', 304, 228, '后退', { parent: 'replay_controls', z: 1, ghost: true, action: 'replay/step', payload: { delta: -1 } }));
  const SPEEDS = [1, 2, 4];
  const SPEED_X0 = 416;
  for (const sp of SPEEDS) {
    const idx = SPEEDS.indexOf(sp);
    boxes.push(button(`replay_speed_${sp}`, SPEED_X0 + idx * 104, 228, `×${sp}`, {
      parent: 'replay_controls', z: 1, ghost: true,
      style: b.speed === sp ? 'on' : 'off', action: 'replay/speed', payload: { speed: sp },
    }));
  }
  boxes.push({ id: 'replay_tick', kind: 'text', parent: 'replay_controls', x: 780, y: 232, w: 200, h: 20, z: 1, visible: true, text: `tick ${tick}/${frames.length - 1}` });
  // aiTrace 右栏（本 tick 轨迹摘要，≤8 条；实装形状 {tick,owner,seq,path,nodeType,phase,depth,result?}
  // ——runtime.js traceNode；F5 审查 P1：原读 t.name||t.type 恒空 → 行文本空转，改按实装字段）
  boxes.push(panel(1064, 80, 200, 400, 'AI 轨迹', 'replay_ai'));
  const traces = diff.aiTrace || [];
  let ty = 116;
  for (const t of traces.slice(-8)) {
    boxes.push({ id: `replay_ai_${ty}`, kind: 'listitem', parent: 'replay_ai', x: 1076, y: ty, w: 176, h: 20, z: 1, visible: true, text: traceText(t) });
    ty += 24;
  }
  if (traces.length === 0) {
    boxes.push({ id: 'replay_ai_empty', kind: 'text', parent: 'replay_ai', x: 1076, y: 116, w: 176, h: 20, z: 1, visible: true, text: '（无轨迹）' });
  }
  // 结算 Modal（§6.6：播放到最后一帧自动 pause + 结算；F5 审查 P1：原 result 存在即弹遮罩
  // ——battle/loaded 起 tick=0 即全屏覆盖，控制条（播放/暂停/步进/倍速）全程不可点，回放不可用；
  // 改为末帧（tick ≥ frames.length-1）才显示；空帧 fail-safe 仍显示）
  const res = b.result;
  if (res && (frames.length === 0 || tick >= frames.length - 1)) {
    boxes.push({ id: 'replay_modal_mask', kind: 'modal-mask', parent: null, x: 0, y: 0, w: 1280, h: 720, z: 90, visible: true, fullscreen: true });
    // 结算面板：显式盒（panel() 默认 z0 会撞 controls；z91 + parent mask，F5 自检修正）
    boxes.push({ id: 'replay_modal', kind: 'panel', parent: 'replay_modal_mask', x: 400, y: 260, w: 480, h: 200, z: 91, visible: true, text: '结算' });
    boxes.push({
      id: 'replay_modal_text', kind: 'text', parent: 'replay_modal',
      x: 416, y: 300, w: 448, h: 24, z: 92, visible: true,
      text: `winner=${res.winner || '?'}（${res.ticks || 0} tick）`,
    });
    boxes.push(button('replay_again', 416, 360, '再来一局', { parent: 'replay_modal', z: 92, goto: 'battle' }));
    boxes.push(button('replay_menu', 640, 360, '返回菜单', { parent: 'replay_modal', z: 92, ghost: true, goto: 'menu' }));
  }
  return boxes;
}

// aiTrace 行文本（实装字段映射：path/nodeType/result；result 仅 action 节点有值——runtime.js:134）
function traceText(t) {
  const head = t.path || t.nodeType || '';
  const tail = t.result !== undefined && t.result !== null ? ` →${t.result}` : '';
  return `${t.owner || ''} ${head}${tail}`.trim();
}