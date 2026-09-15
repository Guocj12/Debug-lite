'use strict';
/* views/replay.js —— 回放与结算屏（frontend-spec §6.6 + docs/screens.md replay 表）。
 * canvas 占位(16,80,1024,128)/HUD hp1·hp2(84 行)/控制条(16,220,1024,56)/aiTrace(1064,80,200,400)/
 * 结算 Modal(400,280,480,160,z90)+遮罩。渲染层只读 frames；画面内容经 paintCanvas 执行图元。
 */
import { box, panel, button, verifyLayout } from '../ui/layout.js';
import { boxesToHtml } from './html.js';

const TICKS = { x: 16 + 640, y: 220 + 16, w: 200, h: 24, z: 4 }; // T:5/18 标签

export function replayLayout(state) {
  const s = state;
  const bt = s.battle || { frames: [], tick: 0, speed: 1, playing: false, result: null };
  const frames = bt.frames || [];
  const tick = bt.tick;
  const n = frames.length;
  const atEnd = n > 0 && tick >= n - 1;
  const cur = frames[Math.min(tick, Math.max(0, n - 1))];
  const d = (cur && cur.diff) || {};
  const p1 = (d.players && d.players.p1) || {};
  const p2 = (d.players && d.players.p2) || {};
  const maxHp = n > 0 ? (((frames[0].diff || {}).players || {}).p1 || {}).hp || 100 : 100;
  const playing = !!bt.playing;
  const result = bt.result;
  const boxes = [
    box('canvas', 'canvas', 16, 80, 1024, 128, { z: 1, text: '' }),
    box('hp1', 'hp', 16, 84, 96, 8, { z: 4, hp: p1.hp === undefined ? 100 : p1.hp, maxHp }),
    box('hp2', 'hp', 912, 84, 96, 8, { z: 4, hp: p2.hp === undefined ? 100 : p2.hp, maxHp }),
    panel('controls', 16, 220, 1024, 56),
    panel('aiTrace', 1064, 80, 200, 400),
  ];
  // 控制条（spec §6.6：播放/暂停/步进/倍速/tick 滑块）
  boxes.push(box('btn_play', 'chip', 24, 236, 64, 24, { z: 4, parent: 'controls', text: '▶ 播放', action: playing || n === 0 ? null : 'replay/play', disabled: playing || n === 0 }));
  boxes.push(box('btn_pause', 'chip', 96, 236, 64, 24, { z: 4, parent: 'controls', text: '⏸ 暂停', action: !playing || n === 0 ? null : 'replay/pause', disabled: !playing || n === 0 }));
  boxes.push(box('btn_back', 'chip', 168, 236, 48, 24, { z: 4, parent: 'controls', text: '◀帧', action: tick <= 0 || n === 0 ? null : 'battle/seek', payload: { tick: tick - 1 }, disabled: tick <= 0 || n === 0 }));
  boxes.push(box('btn_step', 'chip', 224, 236, 48, 24, { z: 4, parent: 'controls', text: '帧▶', action: atEnd || n === 0 ? null : 'battle/seek', payload: atEnd ? undefined : { tick: tick + 1 }, disabled: atEnd || n === 0 }));
  const speeds = [1, 2, 4];
  speeds.forEach((sp, i) => {
    boxes.push(box(`speed_${sp}`, 'chip', 280 + i * 40, 236, 36, 24, { z: 4, parent: 'controls', text: `${sp}x`, action: 'replay/speed', payload: { speed: sp }, style: bt.speed === sp ? 'primary' : null }));
  });
  boxes.push(box('tick_slider', 'slider', 408, 236, 384, 24, { z: 4, parent: 'controls', action: 'battle/seek', valueKey: 'tick', min: 0, max: Math.max(0, n - 1), value: tick }));
  boxes.push(box('tick_lit', 'text', 800, 236, 208, 24, { z: 4, parent: 'controls', text: `T:${tick}/${Math.max(0, n - 1)}` }));
  // aiTrace：本 tick 轨迹列表（path/type/result）
  const trace = (d.aiTrace || []).slice(-10);
  if (trace.length === 0) {
    boxes.push(box('trace_none', 'text', 1072, 96, 184, 40, { z: 3, parent: 'aiTrace', text: '本 tick 无 AI 轨迹（无行动记录）' }));
  } else {
    trace.forEach((e, i) => {
      boxes.push(box(`trace${i + 1}`, 'chip', 1072, 96 + i * 26, 184, 22, { z: 3, parent: 'aiTrace', text: `${e.owner} ${e.path} → ${e.result}` }));
    });
  }
  // 结算 Modal（末帧且 result 已就绪）
  if (result && atEnd) {
    boxes.push(box('mask', 'mask', 0, 0, 1280, 720, { z: 90 }));
    boxes.push(box('modal', 'panel', 400, 280, 480, 160, { z: 91 }));
    boxes.push(box('result_lit', 'text', 416, 300, 448, 24, { z: 92, parent: 'modal', text: `对局结束：${result.winner === 'p1' ? '我方胜' : result.winner === 'p2' ? '对手胜' : '平局'}（${result.phase || '无判定'} · ${result.ticks} tick）` }));
    boxes.push(button('btn_again', 424, 348, { z: 92, parent: 'modal', text: '再来一局', action: 'goto', payload: { screen: 'battle' } }));
    boxes.push(button('btn_menu', 608, 348, { z: 92, parent: 'modal', text: '返回菜单', action: 'goto', payload: { screen: 'menu' } }));
  }
  return boxes;
}

export function replayHtml(state) {
  return boxesToHtml(replayLayout(state));
}
