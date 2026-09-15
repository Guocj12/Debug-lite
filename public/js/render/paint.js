'use strict';
/* render/paint.js —— 绘制器：只执行 planFrame 产出的图元（§7.3 禁止在绘制器里写业务判断）。
 * 每个图元绘制前打 render.box/render.sprite/render.text 日志（channel=render）；
 * 任何会改变画面的调用必有日志（§2.3）。ctx 为 canvas 2D 上下文；无 ctx → 跳过。
 */
export function paintCanvas(ctx, primitives, opts) {
  const o = opts || {};
  const log = o.log || null;
  if (!ctx) return [];
  const seen = [];
  ctx.clearRect(0, 0, 1024, 128);
  seen.push('clear');
  // 地面：16 格交替色（§7.2 步骤 2）
  for (let i = 0; i < 16; i++) {
    const x = i * 64;
    const fill = i % 2 === 0 ? '#141a21' : '#0e1116';
    ctx.fillStyle = fill;
    ctx.fillRect(x, 64, 64, 64);
    seen.push(`tile_${i}`);
    log && log.trace('render', 'render.box', 'tile', { kind: 'tile', id: `tile_${i}`, x, y: 64, w: 64, h: 64, z: 1, fill, scale: 1 });
  }
  for (const p of primitives || []) {
    if (p.kind === 'base') {
      ctx.fillStyle = p.owner === 'p1' ? '#2f6f4f' : '#6f2f2f';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      seen.push('base');
      log && log.trace('render', 'render.box', 'base', { kind: 'base', uid: p.owner, x: p.x, y: p.y, w: p.w, h: p.h, z: 2 });
    } else if (p.kind === 'player') {
      ctx.fillStyle = p.winner ? '#e67e22' : (p.owner === 'p1' ? '#58a6ff' : '#f85149');
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.strokeStyle = '#30363d';
      ctx.strokeRect(p.x, p.y, p.w, p.h);
      seen.push(`player_${p.owner}`);
      log && log.trace('render', 'render.sprite', 'player', { kind: 'actor', uid: p.owner, x: p.x, y: p.y, w: p.w, h: p.h, z: 3, fill: p.winner ? '#e67e22' : (p.owner === 'p1' ? '#58a6ff' : '#f85149'), hp: p.hp, maxHp: p.maxHp });
    } else if (p.kind === 'bullet') {
      ctx.fillStyle = bulletColor(p.level);
      ctx.fillRect(p.x, p.y, p.w, p.h);
      seen.push('bullet');
      log && log.trace('render', 'render.sprite', 'bullet', { kind: 'bullet', uid: `${p.owner}_b`, x: p.x, y: p.y, w: p.w, h: p.h, level: p.level, color: bulletColor(p.level) });
    } else if (p.kind === 'hit') {
      ctx.fillStyle = '#ffd166';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      seen.push('hit');
      log && log.trace('render', 'render.sprite', 'hit', { kind: 'spark', x: p.x, y: p.y, w: p.w, h: p.h, target: p.target });
    } else if (p.kind === 'collision') {
      ctx.fillStyle = '#ff9f43';
      ctx.fillRect(p.x, p.y, p.w, p.h);
      seen.push('collision');
      log && log.trace('render', 'render.sprite', 'collision', { kind: 'spark', x: p.x, y: p.y, w: p.w, h: p.h });
    } else if (p.kind === 'verdict') {
      ctx.fillStyle = '#e6edf3';
      ctx.font = '12px ui-monospace,monospace';
      ctx.fillText(p.text, p.x, p.y + 12);
      seen.push('verdict');
      log && log.trace('render', 'render.text', 'verdict', { kind: 'verdict', text: p.text, x: p.x, y: p.y, w: p.w, h: p.h });
    }
  }
  return seen;
}

function bulletColor(level) {
  const table = { 1: '#8b949e', 2: '#58a6ff', 3: '#3fb950', 4: '#e67e22' };
  return table[Math.max(1, Math.min(4, level || 1))];
}
