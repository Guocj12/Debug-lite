// ============================================================
// Debug-Lite v2.3 — 霓虹像素格斗 前端引擎
// ============================================================
// 架构：
//   G   - 全局游戏状态（socket, 阶段机, 玩家数据）
//   AE  - 音效引擎 (Web Audio API)
//   Sprites - 像素角色精灵渲染
//   Renderer - 核心渲染器（网格、HUD、弹幕像素画）
//   FX   - 动画特效系统（近战弹幕、平射弹幕、垂直弹幕、命中环、拖尾、Buff粒子）
//   UI   - DOM UI 更新
//   Tween - 补间动画引擎
// ============================================================

// ==================== 全局数据缓存 ====================
let _skillsData = null;
let _charsData = null;

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Failed to load ${url}`);
  return r.json();
}

async function loadData() {
  [_skillsData, _charsData] = await Promise.all([
    fetchJSON('/data/skills.json'),
    fetchJSON('/data/characters.json')
  ]);
}

function getSkillById(id) {
  if (!_skillsData) return null;
  return _skillsData.skills?.[id] || null;
}

function getAnim(name) {
  if (!_skillsData) return null;
  return _skillsData.animations?.[name] || null;
}

function getBulletSprite(name) {
  if (!_skillsData) return null;
  return _skillsData.bulletSprites?.[name] || _skillsData.bulletSprites?.default || null;
}

function getCharDef(id) {
  if (!_charsData) return null;
  return _charsData.characters?.find(c => c.id === id) || null;
}

// ==================== 音效引擎 AE ====================
const AE = {
  ctx: null,
  init() {
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { this.ctx = null; }
  },
  play(type) {
    if (!this.ctx) return;
    try {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.connect(g); g.connect(this.ctx.destination);
      const now = this.ctx.currentTime;
      switch (type) {
        case 'hit': o.type = 'square'; o.frequency.setValueAtTime(200, now); o.frequency.linearRampToValueAtTime(80, now+0.12); g.gain.setValueAtTime(0.2, now); g.gain.linearRampToValueAtTime(0, now+0.12); o.start(now); o.stop(now+0.12); break;
        case 'block': o.type = 'triangle'; o.frequency.setValueAtTime(150, now); g.gain.setValueAtTime(0.15, now); g.gain.linearRampToValueAtTime(0, now+0.08); o.start(now); o.stop(now+0.08); break;
        case 'bullet': o.type = 'sawtooth'; o.frequency.setValueAtTime(600, now); o.frequency.linearRampToValueAtTime(200, now+0.06); g.gain.setValueAtTime(0.08, now); g.gain.linearRampToValueAtTime(0, now+0.06); o.start(now); o.stop(now+0.06); break;
        case 'dodge': o.type = 'sine'; o.frequency.setValueAtTime(300, now); o.frequency.linearRampToValueAtTime(600, now+0.1); g.gain.setValueAtTime(0.1, now); g.gain.linearRampToValueAtTime(0, now+0.1); o.start(now); o.stop(now+0.1); break;
        case 'skill': o.type = 'sawtooth'; o.frequency.setValueAtTime(400, now); o.frequency.linearRampToValueAtTime(100, now+0.2); g.gain.setValueAtTime(0.12, now); g.gain.linearRampToValueAtTime(0, now+0.2); o.start(now); o.stop(now+0.2); break;
        case 'tick': o.type = 'sine'; o.frequency.setValueAtTime(800, now); g.gain.setValueAtTime(0.04, now); g.gain.linearRampToValueAtTime(0, now+0.03); o.start(now); o.stop(now+0.03); break;
        default: o.type = 'sine'; o.frequency.setValueAtTime(440, now); g.gain.setValueAtTime(0.05, now); g.gain.linearRampToValueAtTime(0, now+0.05); o.start(now); o.stop(now+0.05);
      }
    } catch (e) {}
  }
};

// ==================== 像素角色精灵 Sprites ====================
const Sprites = {
  /** 角色头顶朝向三角 */
  drawFacingArrow(ctx, x, baseY, size, facing, color) {
    const arrowY = baseY - size - 4;
    const arrowW = 3; // 窄三角
    const tipX = x + facing * size * 0.33; // 在角色格中心1/3处
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = '#ffffff';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(tipX, arrowY);
    ctx.lineTo(x + (facing > 0 ? -arrowW : arrowW), arrowY - 3);
    ctx.lineTo(x + (facing > 0 ? -arrowW : arrowW), arrowY + 3);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore();
  },

  drawCharacter(ctx, charDef, x, y, size, facing, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const color = charDef.color || '#ffffff';
    const s = size || charDef.size || 18;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;

    switch (charDef.shape) {
      case 'square':
        ctx.fillRect(x - s/2, y - s, s, s);
        break;
      case 'triangle': {
        const tip = facing > 0 ? x + s/2 : x - s/2;
        ctx.beginPath();
        ctx.moveTo(tip, y - s/2);
        ctx.lineTo(x + (facing > 0 ? -s/2 : s/2), y - s);
        ctx.lineTo(x + (facing > 0 ? -s/2 : s/2), y);
        ctx.closePath(); ctx.fill();
        break;
      }
      case 'diamond':
        ctx.beginPath();
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s/2, y - s/2);
        ctx.lineTo(x, y);
        ctx.lineTo(x - s/2, y - s/2);
        ctx.closePath(); ctx.fill();
        break;
      case 'triangle2': {
        // 刺客：双刀造型（两个小三角上下排列）
        const s2 = s * 0.9;
        // 上方三角（正对方向）
        const tip1 = facing > 0 ? x + s2/2 : x - s2/2;
        ctx.beginPath();
        ctx.moveTo(tip1, y - s2);
        ctx.lineTo(x + (facing > 0 ? -s2/2 : s2/2), y - s2/2);
        ctx.lineTo(x + (facing > 0 ? -s2/2 : s2/2), y - s2);
        ctx.closePath(); ctx.fill();
        // 下方三角（反方向，刃朝后）
        ctx.beginPath();
        ctx.moveTo(x + (facing > 0 ? -s2/2 : s2/2), y);
        ctx.lineTo(x + (facing > 0 ? s2/2 : -s2/2), y - s2/2);
        ctx.lineTo(x + (facing > 0 ? -s2/2 : s2/2), y - s2);
        ctx.closePath(); ctx.fill();
        break;
      }
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }
};

// ==================== 像素画渲染器 Renderer ====================
const Renderer = {
  canvas: null,
  ctx: null,
  gridW: 16,
  cellW: 0,
  baseY: 0,
  gridH: 0,

  init(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
  },

  resize() {
    if (!this.canvas) return;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.cellW = this.canvas.width / this.gridW;
    this.baseY = this.canvas.height * 0.7;
    this.gridH = this.canvas.height * 0.3;
  },

  gridToPixelX(gx) {
    return gx * this.cellW + this.cellW / 2;
  },

  gridToPixelY(gy) {
    return this.canvas.height * 0.25;
  },

  /** 绘制弹幕像素画字符画 */
  drawBulletSprite(spriteName, bx, by, scale = 1, alpha = 1, colorOverride = null) {
    const spr = getBulletSprite(spriteName);
    if (!spr || !this.ctx) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = alpha;

    const color = colorOverride || spr.color || '#ffffff';
    const pw = this.cellW * 0.15 * scale;
    const ph = pw;
    const rows = spr.pixels;
    const gridW = spr.w, gridH = rows.length;
    const startX = bx - (gridW * pw) / 2;
    const startY = by - (gridH * ph) / 2;

    for (let py = 0; py < rows.length; py++) {
      const row = rows[py];
      for (let px = 0; px < row.length; px++) {
        if (row[px] === '#') {
          ctx.fillStyle = color;
          ctx.shadowColor = color;
          ctx.shadowBlur = 4;
          ctx.fillRect(startX + px * pw, startY + py * ph, pw, ph);
        }
      }
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  },

  /** 绘制网格与地面线 */
  drawGrid() {
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    // 背景
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // 网格竖线
    ctx.strokeStyle = '#1a1a2e';
    ctx.lineWidth = 1;
    for (let i = 0; i <= this.gridW; i++) {
      const x = i * this.cellW;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.canvas.height); ctx.stroke();
    }

    // 地面线
    ctx.strokeStyle = '#334';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#4488ff';
    ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(0, this.baseY); ctx.lineTo(this.canvas.width, this.baseY); ctx.stroke();
    ctx.shadowBlur = 0;

    // 网格数字
    ctx.fillStyle = '#333';
    ctx.font = `${Math.max(8, this.cellW*0.25)}px monospace`;
    ctx.textAlign = 'center';
    for (let i = 0; i < this.gridW; i++) {
      ctx.fillText(i, this.gridToPixelX(i), this.baseY + this.cellW * 0.4);
    }
  },

  /** 绘制玩家。p1/p2 如有 _isPixelX 则 x 已经是像素坐标 */
  drawPlayers(p1, p2) {
    if (!p1 || !p2) return;
    const p1c = getCharDef(p1.charId) || { shape: 'square', size: 18, color: '#00ffff' };
    const p2c = getCharDef(p2.charId) || { shape: 'square', size: 18, color: '#ff4444' };

    const p1px = p1._isPixelX ? p1.x : this.gridToPixelX(p1.x);
    const p2px = p2._isPixelX ? p2.x : this.gridToPixelX(p2.x);

    Sprites.drawCharacter(this.ctx, p1c, p1px, this.baseY, p1c.size, p1.facing, p1._alpha ?? 1);
    Sprites.drawCharacter(this.ctx, p2c, p2px, this.baseY, p2c.size, p2.facing, p2._alpha ?? 1);

    // 朝向指示三角（头顶）
    if ((p1._alpha ?? 1) > 0) Sprites.drawFacingArrow(this.ctx, p1px, this.baseY, p1c.size, p1.facing, p1c.color);
    if ((p2._alpha ?? 1) > 0) Sprites.drawFacingArrow(this.ctx, p2px, this.baseY, p2c.size, p2.facing, p2c.color);

    // 标签位置也用像素坐标
    const px1 = p1px;
    const px2 = p2px;
    this.ctx.fillStyle = '#ffffff';
    this.ctx.font = `${this.cellW*0.28}px monospace`;
    this.ctx.textAlign = 'center';
    this.ctx.fillText('P1', px1, this.baseY - 40);
    this.ctx.fillText('P2', px2, this.baseY - 40);

    // Debuff 状态指示
    if (p1._effects && p1._effects.length > 0) {
      this.ctx.fillStyle = '#ff0';
      this.ctx.font = `${this.cellW*0.22}px monospace`;
      p1._effects.forEach((e, i) => {
        this.ctx.fillText(e.type, px1 - 10 + i*18, this.baseY - 50);
      });
    }
    if (p2._effects && p2._effects.length > 0) {
      this.ctx.fillStyle = '#ff0';
      this.ctx.font = `${this.cellW*0.22}px monospace`;
      p2._effects.forEach((e, i) => {
        this.ctx.fillText(e.type, px2 - 10 + i*18, this.baseY - 50);
      });
    }
  },

  /** 绘制护盾弹幕 */
  drawShields(bullets) {
    for (const b of (bullets || [])) {
      if (b.isShield) {
        this.drawBulletSprite('shield', this.gridToPixelX(b.x), this.baseY - 10, 1.2, 0.7, b.color || '#4488ff');
      }
    }
  }
};

// ==================== FX 动画特效系统 ====================
// FX 管理所有动态特效的创建、更新与渲染
const FX = {
  active: [],   // 当前活跃的特效列表

  /** 从事件数据创建特效 */
  spawnFromEvent(ev, frameDuration, p1, p2) {
    const animName = ev.bullet_anim || ev.hit_anim;
    const anim = getAnim(animName);
    const color = ev.bullet_color || '#ffffff';

    switch (ev.type) {
      // === 近战弹幕（纯视觉，每个覆盖格子播一个） ===
      case 'melee_slash': {
        const x = Renderer.gridToPixelX(ev.bullet_x ?? ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.bullet_anim) {
          this.active.push(new MeleeBulletFX(ev.bullet_anim, x, y, color, anim?.fadeTime || 300));
        }
        AE.play('skill');
        break;
      }

      // === 近战命中（命中环 + 伤害） ===
      case 'melee_hit':
      case 'stun_hit':
      case 'backstab_hit':
      case 'dash_hit': {
        const hitX = Renderer.gridToPixelX(ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, hitX, y, color));
        }
        AE.play('hit');
        break;
      }

      // === 平射弹幕 ===
      case 'bullet_hit':
      case 'freeze_hit':
      case 'poison_hit':
      case 'burn_hit':
      case 'aoe_hit': {
        // 弹幕飞行 + 命中
        const fromX = Renderer.gridToPixelX(ev.bullet_from ?? ev.x ?? 0);
        const toX = Renderer.gridToPixelX(ev.bullet_to ?? ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.bullet_anim) {
          this.active.push(new ProjectileBulletFX(ev.bullet_anim, fromX, toX, y, color, frameDuration, true));
        }
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, toX, y, color));
        }
        AE.play('hit');
        break;
      }

      // === 弹幕飞到尽头消失（不触发命中环） ===
      case 'bullet_trail': {
        const fromX = Renderer.gridToPixelX(ev.bullet_from ?? ev.x ?? 0);
        const toX = Renderer.gridToPixelX(ev.bullet_to ?? ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.bullet_anim) {
          this.active.push(new ProjectileBulletFX(ev.bullet_anim, fromX, toX, y, color, frameDuration, false));
        }
        break;
      }

      // === 弹幕相撞 ===
      case 'bullet_clash': {
        const cx = Renderer.gridToPixelX(ev.x ?? 0);
        const cy = Renderer.baseY - 10;
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, cx, cy, ev.bullet_color || '#ffff00'));
        }
        AE.play('block');
        break;
      }

      // === 垂直弹幕 AOE ===
      case 'aoe_cast': {
        const ax = Renderer.gridToPixelX(ev.x ?? 0);
        const ay = 0; // 从屏幕顶部下落
        if (ev.bullet_anim) {
          this.active.push(new VerticalBulletFX(ev.bullet_anim, ax, ay, Renderer.baseY, color, frameDuration));
        }
        break;
      }

      // === 冲刺 ===
      case 'dash': {
        const dashFrom = Renderer.gridToPixelX(ev.bullet_from ?? ev.x ?? 0);
        const dashTo = Renderer.gridToPixelX(ev.bullet_to ?? ev.to ?? 0);
        const dy = Renderer.baseY - 5;
        if (ev.bullet_anim) {
          this.active.push(new TrailFX(ev.bullet_anim, dashFrom, dashTo, dy, color));
        }
        AE.play('dodge');
        break;
      }

      // === 闪避 ===
      case 'dodged': {
        const dx = Renderer.gridToPixelX(ev.x ?? 0);
        this.active.push(new TrailFX('dodgeTrail', dx - Renderer.cellW, dx + Renderer.cellW, Renderer.baseY - 5, '#8888ff'));
        AE.play('dodge');
        break;
      }

      // === 瞬移 ===
      case 'teleport': {
        const tx = Renderer.gridToPixelX(ev.to ?? 0);
        if (ev.bullet_anim) {
          this.active.push(new HitRingFX(ev.bullet_anim, tx, Renderer.baseY - 10, color));
        }
        AE.play('dodge');
        break;
      }

      // === 击退 ===
      case 'knockback': {
        const kx = Renderer.gridToPixelX(ev.x ?? ev.to ?? 0);
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, kx, Renderer.baseY - 10, ev.bullet_color || '#ffaa00'));
        }
        break;
      }

      // === 护盾 ===
      case 'shield_wall': {
        const sx = Renderer.gridToPixelX(ev.x ?? 0);
        this.active.push(new HitRingFX('shieldWall', sx, Renderer.baseY - 10, ev.color || '#4488ff'));
        AE.play('block');
        break;
      }

      // === 碰撞 ===
      case 'collision': {
        const cx = Renderer.gridToPixelX(ev.x ?? 0);
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, cx, Renderer.baseY - 10, ev.bullet_color || '#ffff00'));
        }
        AE.play('block');
        break;
      }
    }
  },

  /** 为 buff/debuff 生成持续粒子 */
  ensureBuffEmitter(player, playerKey, p1, p2) {
    const key = '_buffFx_' + playerKey;
    if (!player._effects || player._effects.length === 0) {
      // 清除 buff FX
      if (FX[key]) { FX[key] = null; }
      return;
    }
    const x = Renderer.gridToPixelX(player.x);
    const y = Renderer.baseY - 25;
    // 检查是否有活跃的 buff emitter
    if (!FX[key]) {
      const eff = player._effects[0];
      let animName = 'buffParticle';
      if (eff.type === 'burn') animName = 'dotBleed';
      else if (eff.type === 'poison') animName = 'dotBleed';
      else if (eff.type === 'stun') animName = 'stunSpark';
      FX[key] = new BuffEmitterFX(animName, x, y);
    }
    if (FX[key]) {
      FX[key].x = x;
      FX[key].y = y;
    }
  },

  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const fx = this.active[i];
      fx.update(dt);
      if (fx.done) this.active.splice(i, 1);
    }
    // 更新 buff emitters
    for (const k in this) {
      if (k.startsWith('_buffFx_') && this[k]) {
        this[k].update(dt);
        if (this[k].done) this[k] = null;
      }
    }
  },

  render(ctx) {
    for (const fx of this.active) fx.render(ctx, Renderer);
    // 渲染 buff emitters
    for (const k in this) {
      if (k.startsWith('_buffFx_') && this[k]) {
        this[k].render(ctx, Renderer);
      }
    }
  },

  clear() {
    this.active = [];
    for (const k in this) {
      if (k.startsWith('_buffFx_')) this[k] = null;
    }
  }
};

// ==================== 近战弹幕 FX ====================
// 瞬间出现在目标位置，闪亮后淡出
class MeleeBulletFX {
  constructor(animName, x, y, color, fadeTime = 300) {
    const anim = getAnim(animName);
    this.spriteName = anim?.sprite || animName;  // 从 anim 配置读 sprite
    this.x = x;
    this.y = y;
    this.color = color;
    this.fadeTime = anim?.fadeTime || fadeTime;
    this.elapsed = 0;
    this.done = false;
    DBG.log('[FX] MeleeBullet created sprite='+this.spriteName+' at pixel('+x.toFixed(0)+','+y.toFixed(0)+') fade='+this.fadeTime);
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.fadeTime) this.done = true;
  }

  render(ctx, R) {
    const progress = this.elapsed / this.fadeTime;
    const alpha = progress < 0.2 ? 1 : Math.max(0, 1 - (progress - 0.2) / 0.8);
    const scale = 1 + progress * 0.3;
    R.drawBulletSprite(this.spriteName, this.x, this.y, scale, alpha, this.color);
  }
}

// ==================== 平射弹幕 FX ====================
class ProjectileBulletFX {
  constructor(animName, fromX, toX, y, color, frameDuration, hasHit = true) {
    const anim = getAnim(animName);
    this.spriteName = anim?.sprite || animName;
    this.fromX = fromX;
    this.toX = toX;
    this.x = fromX;
    this.y = y;
    this.color = color;
    this.totalDuration = frameDuration * 0.8;
    this.elapsed = 0;
    this.done = false;
    this.hasHit = hasHit;
    this.speedStart = anim?.speedStart || 4;
    this.speedEnd = anim?.speedEnd || 2;
    this.instant = anim?.instant || false;
    if (this.instant) this.totalDuration = frameDuration * 0.15;
    DBG.log('[FX] ProjectileBullet created sprite='+this.spriteName+' from('+fromX.toFixed(0)+')->to('+toX.toFixed(0)+') dur='+this.totalDuration);
  }

  update(dt) {
    this.elapsed += dt;
    const t = Math.min(1, this.elapsed / this.totalDuration);
    // ease-out: 速度递减
    const ease = 1 - Math.pow(1 - t, 1.5);
    this.x = this.fromX + (this.toX - this.fromX) * ease;
    if (t >= 1) this.done = true;
  }

  render(ctx, R) {
    const t = Math.min(1, this.elapsed / this.totalDuration);
    // 到达末端后淡出（仅无命中时）
    let alpha = 1;
    if (t > 0.85 && !this.hasHit) alpha = Math.max(0, 1 - (t - 0.85) / 0.15);
    else if (t > 0.9 && this.hasHit) alpha = Math.max(0, 1 - (t - 0.9) / 0.1);
    R.drawBulletSprite(this.spriteName, this.x, this.y, 1, alpha, this.color);
  }
}

// ==================== 垂直弹幕 FX ====================
class VerticalBulletFX {
  constructor(animName, x, startY, targetY, color, frameDuration) {
    const anim = getAnim(animName);
    this.spriteName = anim?.sprite || animName;
    this.x = x;
    this.startY = startY;
    this.targetY = targetY;
    this.y = startY;
    this.color = color;
    this.totalDuration = frameDuration * 0.7;
    this.elapsed = 0;
    this.done = false;
    this.speedStart = anim?.speedStart || 3;
    this.speedEnd = anim?.speedEnd || 15;
    DBG.log('[FX] VerticalBullet created sprite='+this.spriteName+' y='+startY+'->'+targetY);
  }

  update(dt) {
    this.elapsed += dt;
    const t = Math.min(1, this.elapsed / this.totalDuration);
    // ease-in: 速度递增（加速下落）
    const ease = t * t;
    this.y = this.startY + (this.targetY - this.startY) * ease;
    if (t >= 1) this.done = true;
  }

  render(ctx, R) {
    const alpha = this.elapsed < 50 ? this.elapsed / 50 : 1;
    R.drawBulletSprite(this.spriteName, this.x, this.y, 1, alpha, this.color);
  }
}

// ==================== 命中圆环 FX ====================
// 扩散圆环淡出 + 粒子
class HitRingFX {
  constructor(animName, x, y, color) {
    const anim = getAnim(animName);
    this.x = x;
    this.y = y;
    this.color = anim?.color || color;
    this.particleColor = anim?.particleColor || this.color;
    this.ringStart = anim?.ringStartSize || 0.1;
    this.ringEnd = anim?.ringEndSize || 0.6;
    this.fadeTime = anim?.fadeTime || 300;
    this.particleCount = anim?.particles || 8;
    this.particleSpread = anim?.particleSpread || 4;
    this.elapsed = 0;
    this.done = false;
    // 初始化粒子
    this.particles = [];
    for (let i = 0; i < this.particleCount; i++) {
      const angle = (Math.PI * 2 * i) / this.particleCount + (Math.random() - 0.5) * 0.5;
      const speed = 2 + Math.random() * this.particleSpread;
      this.particles.push({ angle, speed, life: 0.6 + Math.random() * 0.4 });
    }
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.fadeTime) this.done = true;
  }

  render(ctx, R) {
    const t = Math.min(1, this.elapsed / this.fadeTime);
    const alpha = 1 - t;

    // 扩散圆环
    const ringRadius = (this.ringStart + (this.ringEnd - this.ringStart) * t) * R.cellW;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 3;
    ctx.shadowColor = this.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(this.x, this.y, ringRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // 粒子
    for (const p of this.particles) {
      const pLife = Math.min(1, this.elapsed / (this.fadeTime * p.life));
      const pAlpha = 1 - pLife;
      const dist = pLife * R.cellW * this.particleSpread;
      const px = this.x + Math.cos(p.angle) * dist;
      const py = this.y + Math.sin(p.angle) * dist;
      ctx.fillStyle = this.particleColor;
      ctx.globalAlpha = pAlpha * 0.8;
      ctx.fillRect(px - 2, py - 2, 4, 4);
    }
    ctx.restore();
  }
}

// ==================== 拖尾 FX ====================
// 带状拖尾，用于 dash/闪避
class TrailFX {
  constructor(animName, fromX, toX, y, color) {
    const anim = getAnim(animName);
    this.fromX = fromX;
    this.toX = toX;
    this.y = y;
    this.color = anim?.color || color;
    this.segments = anim?.segments || 8;
    this.fadeTime = anim?.fadeTime || 400;
    this.elapsed = 0;
    this.done = false;
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.fadeTime) this.done = true;
  }

  render(ctx, R) {
    const t = Math.min(1, this.elapsed / this.fadeTime);
    const alpha = 1 - t;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (let i = 0; i < this.segments; i++) {
      const segT = i / (this.segments - 1);
      const segX = this.fromX + (this.toX - this.fromX) * segT;
      const segAlpha = alpha * (1 - segT * 0.5);
      ctx.globalAlpha = segAlpha;
      ctx.fillStyle = this.color;
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 6;
      ctx.fillRect(segX - R.cellW * 0.3, this.y - 4, R.cellW * 0.6, 8);
    }
    ctx.shadowBlur = 0;
    ctx.restore();
  }
}

// ==================== Buff 粒子发射器 FX ====================
// 角色身上源源不断的粒子效果
class BuffEmitterFX {
  constructor(animName, x, y) {
    const anim = getAnim(animName);
    this.x = x;
    this.y = y;
    this.color = anim?.color || '#4488ff';
    this.emissionRate = anim?.emissionRate || 4;  // 每秒钟发射粒子数
    this.particleLife = anim?.particleLife || 600; // ms
    this.spread = anim?.spread || 3;
    this.elapsed = 0;
    this.done = false;
    this.particles = [];
    this.emissionAccum = 0;
  }

  update(dt) {
    this.elapsed += dt;
    // 发射新粒子
    this.emissionAccum += dt * (this.emissionRate / 1000);
    while (this.emissionAccum >= 1) {
      this.emissionAccum -= 1;
      this.particles.push({
        angle: Math.random() * Math.PI * 2,
        speed: 1 + Math.random() * this.spread,
        life: this.particleLife * (0.5 + Math.random() * 0.5),
        elapsed: 0
      });
    }

    // 更新现有粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.elapsed += dt;
      if (p.elapsed >= p.life) this.particles.splice(i, 1);
    }
  }

  render(ctx, R) {
    for (const p of this.particles) {
      const pT = p.elapsed / p.life;
      const alpha = 1 - pT;
      const dist = pT * R.cellW * this.spread;
      const px = this.x + Math.cos(p.angle) * dist;
      const py = this.y + Math.sin(p.angle) * dist - pT * 20; // 向上飘
      ctx.save();
      ctx.globalAlpha = alpha * 0.7;
      ctx.fillStyle = this.color;
      ctx.shadowColor = this.color;
      ctx.shadowBlur = 4;
      ctx.fillRect(px - 2, py - 2, 4, 4);
      ctx.shadowBlur = 0;
      ctx.restore();
    }
  }
}

// ==================== Tween 补间动画引擎 ====================
const Tween = {
  _tweens: [],
  add(obj, props, duration, easing = 'easeOutQuad') {
    const start = {}, startTime = performance.now();
    for (const k in props) start[k] = (obj[k] !== undefined ? obj[k] : 0);
    this._tweens.push({ obj, start, end: props, duration, startTime, easing });
  },
  update() {
    const now = performance.now();
    for (let i = this._tweens.length - 1; i >= 0; i--) {
      const tw = this._tweens[i];
      const t = Math.min(1, (now - tw.startTime) / tw.duration);
      const e = this._ease(t, tw.easing);
      for (const k in tw.end) {
        tw.obj[k] = tw.start[k] + (tw.end[k] - tw.start[k]) * e;
      }
      if (t >= 1) this._tweens.splice(i, 1);
    }
  },
  _ease(t, type) {
    switch (type) {
      case 'linear': return t;
      case 'easeInQuad': return t * t;
      case 'easeOutQuad': return t * (2 - t);
      case 'easeInOutQuad': return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      default: return t * (2 - t);
    }
  },
  clear() { this._tweens = []; }
};

// ==================== 调试 ====================
const DBG = {
  _on: true,
  log(...args) { if (this._on) console.log('[DBG]', ...args); },
  warn(...args) { if (this._on) console.warn('[DBG]', ...args); }
};

// ==================== 全局游戏状态 G ====================
const G = {
  socket: null,
  mode: null,        // 'ai' | 'train' | 'online'
  _mode: 'prepare',  // 'prepare' | 'battle' | 'result'
  roomId: null,
  playerN: 1,
  myCharId: null,
  mySkillIds: [],
  myCustomSkills: {},
  p1: null,          // 当前帧 p1 数据
  p2: null,          // 当前帧 p2 数据
  actions: [],       // 我的行动队列
  maxActions: 16,
  round: 0,
  timeLeft: 60,
  tick: 0,
  p1Actions: [],     // P1 的16 tick 行动
  p2Actions: [],     // P2 的16 tick 行动
  _cooldowns: {},    // 冷却追踪
  _snapshots: [],    // 编辑阶段快照栈，用于撤回
  _renderLoop: null, // raf id
  _lastFrameTime: 0,

  reset() {
    this.p1 = null; this.p2 = null; this.actions = [];
    this.round = 0; this.timeLeft = 60; this.tick = 0;
    this.p1Actions = []; this.p2Actions = [];
    this._cooldowns = {}; this._snapshots = [];
    if (this._renderLoop) { cancelAnimationFrame(this._renderLoop); this._renderLoop = null; }
    FX.clear(); Tween.clear();
  },

  /** 保存当前状态快照 */
  saveSnapshot() {
    this._snapshots.push({
      p1: JSON.parse(JSON.stringify(this.p1)),
      p2: JSON.parse(JSON.stringify(this.p2)),
      cooldowns: JSON.parse(JSON.stringify(this._cooldowns || {})),
      tick: this.tick,
    });
  },

  /** 恢复到上一个快照 */
  restoreSnapshot() {
    if (this._snapshots.length === 0) return false;
    const snap = this._snapshots.pop();
    this.p1 = snap.p1; this.p2 = snap.p2;
    this._cooldowns = snap.cooldowns;
    this.tick = snap.tick;
    DBG.log(`[STATE] 快照恢复 tick=${snap.tick} p1(x=${snap.p1.x},mp=${snap.p1.mp},sp=${snap.p1.sp})`);
    return true;
  },

  /** tick 资源恢复（每个角色个性化恢复速率） */
  tickResources() {
    if (!this.p1) return;
    const cd = getCharDef(this.p1.charId) || { mpRegen: 1, spRegen: 2 };
    const mr = cd.mpRegen || 1;
    const sr = cd.spRegen || 2;
    this.p1.sp = Math.min(this.p1.maxSp, (this.p1.sp || 0) + sr);
    this.p1.mp = Math.min(this.p1.maxMp, (this.p1.mp || 0) + mr);
    DBG.log(`[RESOURCE] tick=${this.tick} P1 MP+${mr} SP+${sr} => mp=${this.p1.mp} sp=${this.p1.sp}`);
    // tick cooldowns
    for (const k in this._cooldowns) { if (this._cooldowns[k] > 0) this._cooldowns[k]--; }
  }
};

// ==================== UI 工具 ====================
const UI = {
  updateHUD(p, prefix) {
    if (!p) return;
    const hpPct = Math.max(0, (p.hp || 0) / (p.maxHp || 1) * 100);
    const mpPct = Math.max(0, (p.mp || 0) / (p.maxMp || 1) * 100);
    const spPct = Math.max(0, (p.sp || 0) / (p.maxSp || 1) * 100);
    const hpEl = document.getElementById(prefix + 'hp');
    const mpEl = document.getElementById(prefix + 'mp');
    const spEl = document.getElementById(prefix + 'sp');
    if (hpEl) hpEl.style.width = hpPct + '%';
    if (mpEl) mpEl.style.width = mpPct + '%';
    if (spEl) spEl.style.width = spPct + '%';
    const hptEl = document.getElementById(prefix + 'hpt');
    const mptEl = document.getElementById(prefix + 'mpt');
    const sptEl = document.getElementById(prefix + 'spt');
    if (hptEl) hptEl.textContent = `${p.hp||0}/${p.maxHp||0}`;
    if (mptEl) mptEl.textContent = `${p.mp||0}/${p.maxMp||0}`;
    if (sptEl) sptEl.textContent = `${p.sp||0}/${p.maxSp||0}`;
  },

  updatePrepareUI(p) {
    if (!p) return;
    const hpEl = document.getElementById('p1hp');
    const mpEl = document.getElementById('p1mp');
    const spEl = document.getElementById('p1sp');
    const hptEl = document.getElementById('p1hpt');
    const mptEl = document.getElementById('p1mpt');
    const sptEl = document.getElementById('p1spt');
    if (hpEl) hpEl.style.width = Math.max(0, (p.hp || 0) / (p.maxHp || 1) * 100) + '%';
    if (mpEl) mpEl.style.width = 0 + '%';
    if (spEl) spEl.style.width = Math.max(0, (p.sp || 0) / (p.maxSp || 1) * 100) + '%';
    if (hptEl) hptEl.textContent = `${p.hp||0}/${p.maxHp||0}`;
    if (mptEl) mptEl.textContent = `${p.mp||0}/${p.maxMp||0}`;
    if (sptEl) sptEl.textContent = `${p.sp||0}/${p.maxSp||0}`;
  },

  log(msg) {
    const el = document.getElementById('logc');
    if (!el) return;
    const d = document.createElement('div');
    d.textContent = msg;
    el.appendChild(d);
    if (el.children.length > 20) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  },

  showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id)?.classList.add('active');
  },

  renderActionSlots() {
    const slotsEl = document.getElementById('aslots');
    const cntEl = document.getElementById('acnt');
    if (!slotsEl) return;
    slotsEl.innerHTML = '';
    for (let i = 0; i < G.maxActions; i++) {
      const slot = document.createElement('div');
      slot.className = 'bq-slot';
      if (i < G.actions.length) {
        slot.classList.add('active');
        const a = G.actions[i];
        const sk = getSkillById(a);
        const gs = _skillsData?.genericSkills?.find(g => g.id === a);
        slot.textContent = (sk?.name || gs?.name || a) + ' ';
        // cost hint
        const mpC = sk?.mpCost || 0, spC = sk?.spCost || gs?.spCost || 0;
        if (mpC || spC) {
          const costSpan = document.createElement('span');
          costSpan.style.cssText = 'font-size:0.6em;color:#888';
          costSpan.textContent = (mpC ? `MP${mpC}` : '') + (spC ? ` SP${spC}` : '');
          slot.appendChild(costSpan);
        }
      } else {
        slot.textContent = i + 1;
      }
      slotsEl.appendChild(slot);
    }
    if (cntEl) cntEl.textContent = `(${G.actions.length}/${G.maxActions})`;
  },

  renderActionButtons() {
    const container = document.getElementById('abtns');
    if (!container) return;
    container.innerHTML = '';

    const p1 = G.p1;
    if (!p1) return;
    let curMp = p1.mp || 0, curSp = p1.sp || 0;
    const cd = G._cooldowns || {};

    // 技能按钮
    const mySids = G.mySkillIds || [];
    mySids.forEach((sid, idx) => {
      const sk = getSkillById(sid);
      if (!sk) return;
      const actionId = 'skill' + (idx + 1);
      const onCD = (cd[sid] || 0) > 0;
      const enoughRes = curMp >= (sk.mpCost || 0) && curSp >= (sk.spCost || 0);
      const btn = document.createElement('button');
      btn.className = 'btn btn-b s';
      btn.textContent = `${sk.name} [MP${sk.mpCost||0} SP${sk.spCost||0}]${onCD ? ' CD'+cd[sid] : ''}`;
      btn.disabled = onCD || !enoughRes || G.actions.length >= G.maxActions;
      if (!enoughRes) btn.style.opacity = '0.5';
      btn.onclick = () => addActionToQueue(actionId, sid);
      container.appendChild(btn);
    });

    // 通用技能按钮
    const generic = _skillsData?.genericSkills || [];
    generic.forEach(gs => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-g s';
      btn.textContent = `${gs.name} [SP${gs.spCost||0}]`;
      btn.disabled = curSp < (gs.spCost || 0) || G.actions.length >= G.maxActions;
      btn.onclick = () => addActionToQueue(gs.id, gs.id);
      container.appendChild(btn);
    });
  },

  /** 战斗阶段双方行动队列面板 */
  renderBattleQueue(tick, p1Acts, p2Acts) {
    document.getElementById('bqTick').textContent = `Tick ${tick}/16`;
    const p1El = document.getElementById('bqP1');
    const p2El = document.getElementById('bqP2');
    if (!p1El || !p2El) return;

    const renderRow = (el, actions, currentIdx) => {
      el.innerHTML = '';
      for (let i = 0; i < 16; i++) {
        const slot = document.createElement('span');
        slot.className = 'bq-slot' + (i === currentIdx ? ' active' : '');
        const a = actions[i] || 'wait';
        if (a === 'wait') slot.textContent = '·';
        else {
          const sk = getSkillById(a);
          const gs = (_skillsData?.genericSkills || []).find(g => g.id === a);
          slot.textContent = sk?.name || gs?.name || a;
        }
        el.appendChild(slot);
      }
    };
    renderRow(p1El, p1Acts, tick);
    renderRow(p2El, p2Acts, tick);
  }
};

// ==================== Socket 事件处理 ====================
function setupSocket() {
  if (G.socket) { G.socket.removeAllListeners(); G.socket.disconnect(); }
  G.socket = io();

  G.socket.on('prepareStart', (d) => {
    G._mode = 'prepare'; G.round = d.round; G.timeLeft = d.time;
    G.p1 = d.p1; G.p2 = d.p2;
    // 保存原始状态（用于清空恢复）
    G._originP1 = JSON.parse(JSON.stringify(d.p1));
    G._originP2 = JSON.parse(JSON.stringify(d.p2));
    G.actions = []; G._cooldowns = {}; G._snapshots = []; G._shieldBullets = [];
    G.p1Actions = []; G.p2Actions = []; G.tick = 0;
    FX.clear();
    updatePrepareUI();
    UI.showScreen('battle');
    UI.renderActionSlots();
    UI.renderActionButtons();
    document.getElementById('actionQueuePanel').classList.remove('hidden');
    document.getElementById('battleQueuePanel').classList.add('hidden');
    document.getElementById('rdyBtn').disabled = false;

    DBG.log('[PHASE] 进入编辑阶段 round=' + d.round + ' p1(x='+d.p1.x+',mp='+d.p1.mp+',sp='+d.p1.sp+')');

    if (G.mode === 'ai') {
      G.socket.emit('aiReady', { roomId: G.roomId });
      // AI 模式也显示编辑UI，用户可以操作
    }
    if (G.mode === 'train') {
      G.socket.emit('trainReady', { roomId: G.roomId });
    }
    UI.log(`Round ${d.round} — 准备阶段 (${d.time}s)`);
    startRenderLoop();
  });

  G.socket.on('prepareTick', (d) => {
    G.timeLeft = d.t;
    document.getElementById('tm').textContent = d.t;
  });

  G.socket.on('battleFrames', (d) => {
    G._mode = 'battle';
    document.getElementById('actionQueuePanel').classList.add('hidden');
    document.getElementById('battleQueuePanel').classList.remove('hidden');
    document.getElementById('rdyBtn').disabled = true;
    DBG.log('[PHASE] 进入战斗阶段, frames=' + d.frames.length);
    playBattleAnim(d.frames, d.final);
  });

  G.socket.on('gameOver', (d) => {
    G._mode = 'result';
    FX.clear();
    UI.showScreen('result');
    document.getElementById('rtitle').textContent = d.winner === 'draw' ? '平局!' : `${d.winner} 获胜!`;
    document.getElementById('rdetail').textContent = `P1 HP: ${d.p1Hp} | P2 HP: ${d.p2Hp} | ${d.reason === 'maxRounds' ? '达到最大回合数' : '击杀获胜'}`;
  });

  G.socket.on('err', (d) => { UI.log('❌ ' + d.msg); });
  G.socket.on('roomCreated', (d) => { G.roomId = d.roomId; G.playerN = d.n; UI.log(`房间已创建: ${d.roomId}`); });
  G.socket.on('roomJoined', (d) => { G.roomId = d.roomId; G.playerN = d.n; UI.log(`已加入房间: ${d.roomId}`); });
  G.socket.on('playerJoined', (d) => { UI.log(`玩家已加入: ${d.players.map(p=>p.name).join(', ')}`); });
  G.socket.on('playerReady', (d) => { UI.log(`P${d.n} 已准备`); });
  G.socket.on('trainStart', (d) => { G.roomId = d.roomId; G.playerN = d.n; UI.log('训练场已就绪'); });
  G.socket.on('aiStart', (d) => { G.roomId = d.roomId; G.playerN = d.n; UI.log(`人机对战 (AI: ${d.aiChar})`); });
}

// ==================== 本地步进引擎 ====================
// 使用简化的战斗逻辑在编辑阶段本地模拟单个 tick
const LocalStep = {
  /** 模拟一个 tick 的战斗步进，返回 events。当 isEditStep=true 时只计算效果不扣血 */
  executeOneTick(actionId, p1, p2, isEditStep = false) {
    const events = [];
    const mySids = G.mySkillIds || [];
    let sk = null, idx = -1;
    const idxMap = { skill1: 0, skill2: 1, skill3: 2 };
    if (idxMap[actionId] !== undefined) {
      idx = idxMap[actionId];
      sk = getSkillById(mySids[idx]);
    }
    // 通用技能直接处理
    if (!sk) {
      return this._handleGeneric(actionId, p1, p2);
    }

    const sid = mySids[idx];
    if (!sk || !sid) return events;
    const cd = G._cooldowns || {};

    // 消耗资源
    const hasMp = (p1.mp || 0) >= (sk.mpCost || 0);
    const hasSp = (p1.sp || 0) >= (sk.spCost || 0);
    if (!hasMp || !hasSp) {
      events.push({ type: 'exhausted', actor: 'p1', skillId: sid });
      return events;
    }
    p1.mp -= (sk.mpCost || 0);
    p1.sp -= (sk.spCost || 0);
    if (sk.cooldown) G._cooldowns[sid] = sk.cooldown;

    const dir = p1.facing;
    const target = p2;

    DBG.log(`[STEP] action=${actionId} skill=${sk.name} type=${sk.type} range=${sk.range} p1(x=${p1.x},facing=${dir}) p2(x=${p2.x})`);

    switch (sk.type) {
      case 'melee': {
        const rg = sk.range || 1;
        const dist = Math.abs(p1.x - target.x);
        let inRange = true;
        if (sk.direction === 'forward') inRange = dist <= rg && ((dir === 1 && target.x >= p1.x) || (dir === -1 && target.x <= p1.x));
        else if (sk.direction === 'forward_and_back') inRange = dist <= rg;

        // ★ 近战弹幕：根据技能范围在覆盖的格子上各播一次
        const bulletGrids = [];
        if (sk.direction === 'forward') {
          for (let offset = 1; offset <= rg; offset++) {
            const gx = p1.x + dir * offset;
            if (gx >= 0 && gx <= 15) bulletGrids.push(gx);
          }
        } else if (sk.direction === 'forward_and_back') {
          for (let offset = -rg; offset <= rg; offset++) {
            const gx = p1.x + offset;
            if (gx >= 0 && gx <= 15) bulletGrids.push(gx);
          }
        } else {
          for (let offset = -rg; offset <= rg; offset++) {
            const gx = p1.x + offset;
            if (gx >= 0 && gx <= 15) bulletGrids.push(gx);
          }
        }
        // 每一个覆盖的格子生成一个 bulletFX 事件
        for (const gx of bulletGrids) {
          events.push({ type: 'melee_slash', actor: 'p1', skillId: sid,
            bullet_anim: sk.anim_bullet || 'meleeSwing', bullet_color: sk.color, bullet_x: gx });
          DBG.log(`[FX] melee bullet at grid=${gx} anim=${sk.anim_bullet}`);
        }

        // 伤害判定
        if (inRange) {
          const ratio = sk.damageRatio || 1;
          const dmg = Math.max(1, Math.floor((p1.atk || 10) * ratio - (target.def || 0)));
          if (!isEditStep) target.hp = Math.max(0, target.hp - dmg);
          const evT = sk.effect === 'stun_damage' ? 'stun_hit' : 'melee_hit';
          events.push({ type: evT, actor: 'p1', target: 'p2', dmg, x: target.x, skillId: sid,
            hit_anim: sk.anim_hit || 'hitSlash', bullet_color: sk.color });
          DBG.log(`[HIT] melee dmg=${dmg} at target.x=${target.x} hit_anim=${sk.anim_hit}${isEditStep?' (edit: no dmg)':''}`);
          if (!isEditStep && sk.effect === 'stun_damage') { target._effects = target._effects || []; target._effects.push({ type: 'stun', ticks: sk.stunDuration || 1 }); }
        } else { DBG.log('[MISS] melee out of range'); }
        break;
      }
      case 'projectile': {
        const range = sk.bulletRange || 99;
        const dir = p1.facing;
        let hitDone = false;
        for (let scan = 1; scan <= range; scan++) {
          const sx = p1.x + dir * scan;
          if (sx < 0 || sx > 15) break;
          if (sx === target.x) {
            const dmg = Math.max(1, Math.floor((p1.atk || 10) * (sk.damageRatio || 1) - (target.def || 0)));
            target.hp = Math.max(0, target.hp - dmg);
            const evT = sk.effect === 'freeze_damage' ? 'freeze_hit' : (sk.effect === 'poison_debuff' ? 'poison_hit' : 'bullet_hit');
            events.push({ type: evT, actor: 'p1', target: 'p2', dmg, x: sx, skillId: sid,
              bullet_anim: sk.anim_bullet || 'arrowFly', hit_anim: sk.anim_hit || 'hitExplosion',
              bullet_color: sk.color, bullet_from: p1.x, bullet_to: sx });
            DBG.log(`[HIT] projectile dmg=${dmg} from=${p1.x} to=${sx} bullet_anim=${sk.anim_bullet} hit_anim=${sk.anim_hit}`);
            hitDone = true; break;
          }
        }
        if (!hitDone) {
          const maxX = Math.max(0, Math.min(15, p1.x + dir * range));
          events.push({ type: 'bullet_trail', actor: 'p1', skillId: sid,
            bullet_anim: sk.anim_bullet || 'arrowFly', bullet_color: sk.color,
            bullet_from: p1.x, bullet_to: maxX, bullet_faded: true });
          DBG.log(`[TRAIL] bullet flew to max range ${maxX} bullet_anim=${sk.anim_bullet}`);
        }
        break;
      }
      case 'targeted_aoe': {
        const aoeR = sk.aoeRadius || 1;
        const tX = target.x;
        for (let ox = -aoeR; ox <= aoeR; ox++) {
          const ax = tX + ox;
          if (ax < 0 || ax > 15) continue;
          if (ax === target.x) {
            const dmg = Math.max(1, Math.floor((p1.atk || 10) * (sk.damageRatio || 1) - (target.def || 0)));
            if (!isEditStep) target.hp = Math.max(0, target.hp - dmg);
            events.push({ type: 'aoe_hit', actor: 'p1', target: 'p2', dmg, x: ax, skillId: sid,
              bullet_anim: sk.anim_bullet || 'arrowRainDrop', hit_anim: sk.anim_hit || 'hitAOE', bullet_color: sk.color });
            DBG.log(`[HIT] aoe dmg=${dmg} at x=${ax} bullet_anim=${sk.anim_bullet}${isEditStep?' (edit: no dmg)':''}`);
            if (!isEditStep && sk.effect === 'burn_debuff') { target._effects = target._effects || []; target._effects.push({ type: 'burn', ticks: sk.burnTicks || 3, dmgPerTick: Math.max(1, Math.floor(p1.atk * (sk.burnRatio || 0.1))) }); }
          } else {
            events.push({ type: 'aoe_cast', actor: 'p1', skillId: sid, x: ax,
              bullet_anim: sk.anim_bullet || 'arrowRainDrop', bullet_color: sk.color, bullet_noHit: true });
            DBG.log(`[CAST] aoe drop at x=${ax} (no hit)`);
          }
        }
        events.push({ type: 'aoe_cast', actor: 'p1', skillId: sid, x: tX,
          bullet_anim: sk.anim_bullet || 'arrowRainDrop', bullet_color: sk.color, bullet_noHit: false });
        break;
      }
      case 'dash': {
        const dDist = sk.range || 3;
        let dest = p1.x + dir * dDist;
        dest = Math.max(0, Math.min(15, dest));
        const oldX = p1.x;
        const startX = Math.min(oldX, dest), endX = Math.max(oldX, dest);
        if (target.x >= startX && target.x <= endX) {
          const dmg = Math.max(1, Math.floor((p1.atk || 10) * (sk.damageRatio || 1) - (target.def || 0)));
          if (!isEditStep) target.hp = Math.max(0, target.hp - dmg);
          events.push({ type: 'dash_hit', actor: 'p1', target: 'p2', dmg, skillId: sid,
            bullet_anim: sk.anim_bullet || 'dashTrail', hit_anim: sk.anim_hit || 'hitSlash',
            bullet_color: sk.color, bullet_from: oldX, bullet_to: dest });
          DBG.log(`[HIT] dash dmg=${dmg} from=${oldX} to=${dest}`);
          // 击退
          if (sk.knockback && !isEditStep) {
            const kbDir = dir;
            const oldTargetX = target.x;
            let tNewX = oldTargetX + kbDir * sk.knockback;
            tNewX = Math.max(0, Math.min(15, tNewX));
            if (tNewX === p1.x) tNewX += kbDir;
            if (tNewX === dest) tNewX += kbDir;
            tNewX = Math.max(0, Math.min(15, tNewX));
            target.x = tNewX;
            events.push({ type: 'knockback', actor: 'p2', from: oldTargetX, to: tNewX, hit_anim: 'knockbackFX', bullet_color: '#ffaa00' });
            DBG.log(`[KNOCKBACK] P2 knocked ${oldTargetX}->${tNewX} dir=${kbDir}`);
          }
          if (dest === target.x) dest = target.x + (dir > 0 ? -1 : 1);
        }
        p1.x = dest;
        events.push({ type: 'dash', actor: 'p1', to: dest, skillId: sid,
          bullet_anim: sk.anim_bullet || 'dashTrail', bullet_color: sk.color, bullet_from: oldX, bullet_to: dest });
        DBG.log(`[MOVE] dash from=${oldX} to=${dest}`);
        break;
      }
      case 'teleport_backstab': {
        const oldX = p1.x;
        // 目标敌人当前位置（编辑阶段敌人不移动，直接用p2.x。服务端会用位移前位置）
        const enemyX = p2.x;
        const enemyFacing = p2.facing;
        // 始终瞬移到敌人背后 = 敌人朝向的反方向一格
        let tpX = enemyX - enemyFacing;
        tpX = Math.max(0, Math.min(15, tpX));
        if (tpX === enemyX) tpX = Math.max(0, Math.min(15, enemyX + enemyFacing));
        p1.x = tpX;
        // 自动面向敌人
        if (p1.x > enemyX) p1.facing = -1; else if (p1.x < enemyX) p1.facing = 1;
        events.push({ type: 'teleport', actor: 'p1', to: tpX, skillId: sid,
          bullet_anim: sk.anim_bullet || 'teleportFlash', hit_anim: sk.anim_hit || 'teleportFlash', bullet_color: sk.color });
        DBG.log(`[BACKSTAB] teleport from=${oldX} to=${tpX}, enemy at ${enemyX} (facing=${enemyFacing}), myFacing=${p1.facing}`);
        break;
      }
      case 'shield_wall': {
        const sX = p1.x + dir;
        events.push({ type: 'shield_wall', actor: 'p1', x: sX, skillId: sid, color: sk.color });
        DBG.log(`[FX] shield at x=${sX}`);
        // 盾牌存到 G._shield 中 (简化)
        G._shieldBullets = G._shieldBullets || [];
        G._shieldBullets.push({ x: sX, dir, isShield: true, color: sk.color });
        break;
      }
    }
    return events;
  },

  _handleGeneric(actionId, p1, p2) {
    const events = [];
    const oldX = p1.x;
    const gs = (_skillsData?.genericSkills || []).find(g => g.id === actionId);
    if (!gs) return events;
    const spCost = gs.spCost || 0;
    if ((p1.sp || 0) < spCost) return events;
    p1.sp -= spCost;

    DBG.log(`[STEP] generic=${actionId} name=${gs.name} p1(x=${p1.x},facing=${p1.facing})`);
    switch (actionId) {
      case 'move_left': p1.x = Math.max(0, p1.x - 1); events.push({ type:'move', actor:'p1', from:oldX, to:p1.x }); DBG.log('[MOVE] left '+oldX+'->'+p1.x); break;
      case 'move_right': p1.x = Math.min(15, p1.x + 1); events.push({ type:'move', actor:'p1', from:oldX, to:p1.x }); DBG.log('[MOVE] right '+oldX+'->'+p1.x); break;
      case 'dodge_left': p1.x = Math.max(0, p1.x - 2); events.push({ type:'dodged', actor:'p1', x:p1.x }); DBG.log('[MOVE] dodge left '+oldX+'->'+p1.x); break;
      case 'dodge_right': p1.x = Math.min(15, p1.x + 2); events.push({ type:'dodged', actor:'p1', x:p1.x }); DBG.log('[MOVE] dodge right '+oldX+'->'+p1.x); break;
      case 'defend': events.push({ type:'defend', actor:'p1' }); DBG.log('[ACT] defend'); break;
      case 'turn': p1.facing *= -1; events.push({ type:'turn', actor:'p1' }); DBG.log('[ACT] turn facing='+p1.facing); break;
    }
    return events;
  }
};

// ==================== 持续渲染循环 ====================
function startRenderLoop() {
  if (G._renderLoop) cancelAnimationFrame(G._renderLoop);
  G._lastFrameTime = performance.now();
  // 渲染循环专用时间戳，不和 battleStep 共享
  G._renderLastTime = performance.now();

  function frame(now) {
    if (G._mode === 'result') { G._renderLoop = null; return; }
    G._renderLoop = requestAnimationFrame(frame);

    let dt = now - G._renderLastTime;
    G._renderLastTime = now;
    if (dt > 200) dt = 16;

    // 战斗阶段专用步进（必须在 FX.update 之前调用，以便新产生的 FX 在当帧就能渲染）
    if (G._mode === 'battle' && G._battleStep) G._battleStep();

    FX.update(dt);
    Tween.update();

    Renderer.resize();
    Renderer.drawGrid();

    // 护盾
    const shields = G._shieldBullets || [];
    if (G._mode === 'battle' && G._battleFrames) {
      const cf = G._battleFrames[Math.min(G.tick, G._battleFrames.length - 1)];
      if (cf) Renderer.drawShields(cf.bullets || []);
    } else {
      Renderer.drawShields(shields);
    }

    // 画玩家——使用渲染位置（如果有缓动动画就用缓动位置）
    if (G.p1 && G.p2) {
      const rp1 = Object.assign({}, G.p1, G._renderP1 ? { x: G._renderP1.x, _isPixelX: true } : {});
      const rp2 = Object.assign({}, G.p2, G._renderP2 ? { x: G._renderP2.x, _isPixelX: true } : {});
      if (G._mode !== 'prepare') {
        Renderer.drawPlayers(rp1, rp2);
      } else {
        const p2Hidden = Object.assign({}, rp2, { _alpha: 0 });
        Renderer.drawPlayers(rp1, p2Hidden);
      }
    }

    FX.render(Renderer.ctx);

    // 更新 HUD
    if (G.p1) UI.updateHUD(G.p1, 'p1');
    if (G.p2) UI.updateHUD(G.p2, 'p2');
    if (G._mode === 'battle' || G._mode === 'prepare') {
      document.getElementById('tm').textContent = G._mode === 'battle' ? G.tick : G.timeLeft;
      document.getElementById('rnd').textContent = `ROUND ${G.round}`;
    }
  }
  G._renderLoop = requestAnimationFrame(frame);
  DBG.log('[RENDER] 渲染循环启动 mode=' + G._mode);
}

// ==================== 编辑阶段：添加行动到队列并步进 ====================
function addActionToQueue(actionId, skillSid) {
  if (G.actions.length >= G.maxActions) return;
  if (G._mode !== 'prepare') return;

  const sk = getSkillById(skillSid);
  const gs = (_skillsData?.genericSkills || []).find(g => g.id === actionId);
  const mpCost = sk?.mpCost || 0;
  const spCost = sk?.spCost || gs?.spCost || 0;
  const cd = G._cooldowns || {};

  // 检查冷却
  if (sk && (cd[skillSid] || 0) > 0) return;
  // 检查资源
  if ((G.p1?.mp || 0) < mpCost || (G.p1?.sp || 0) < spCost) return;

  // 保存快照（步进前状态）
  G.saveSnapshot();
  const oldP1X = G.p1.x;
  DBG.log('========================================');
  DBG.log('[QUEUE] 添加行动 #' + G.actions.length + ' = ' + actionId + (sk ? ' ('+sk.name+')' : ''));

  // 执行本地步进
  const events = LocalStep.executeOneTick(actionId, G.p1, G.p2, true);

  // ★ 编辑阶段位移缓动
  if (G.p1.x !== oldP1X) {
    const fromPX = Renderer.gridToPixelX(oldP1X);
    const toPX = Renderer.gridToPixelX(G.p1.x);
    G._renderP1 = { x: fromPX, facing: G.p1.facing };
    Tween.add(G._renderP1, { x: toPX }, 400, 'easeOutQuad');
    DBG.log('[TWEEN] 编辑阶段P1位移缓动 grid='+oldP1X+'->'+G.p1.x+' pixel='+fromPX.toFixed(0)+'->'+toPX.toFixed(0));
  }

  // 步进后 tick 资源回复
  G.tickResources();
  G.tick++;

  // 从事件生成动画特效
  for (const ev of events) {
    FX.spawnFromEvent(ev, 600, G.p1, G.p2);
  }

  // 记录 action
  G.actions.push(actionId);

  // 通知后端
  if (G.socket && G.roomId) G.socket.emit('updateActions', { actions: G.actions });

  // 更新 UI
  UI.renderActionSlots();
  UI.renderActionButtons();

  DBG.log('[QUEUE] 步进完成 tick=' + G.tick + ' p1(x='+G.p1.x+',mp='+G.p1.mp+',sp='+G.p1.sp+',hp='+G.p1.hp+') p2(hp='+G.p2.hp+')');
  DBG.log('========================================');
}

// ==================== 编辑阶段：清空/撤销/填充 ====================
function clearActions() {
  DBG.log('[CLEAR] 清空所有' + G.actions.length + '个行动');
  // 恢复到最初状态（第一个快照）
  while (G._snapshots.length > 0) G.restoreSnapshot();
  // 还需要恢复到 round 开始时的状态：从 prepareStart 存一份原始状态
  if (G._originP1) { G.p1 = JSON.parse(JSON.stringify(G._originP1)); }
  if (G._originP2) { G.p2 = JSON.parse(JSON.stringify(G._originP2)); }
  G._cooldowns = {};
  G.tick = 0;
  G.actions = [];
  G._snapshots = [];
  G._shieldBullets = [];
  FX.clear();
  if (G.socket && G.roomId) G.socket.emit('updateActions', { actions: [] });
  UI.renderActionSlots();
  UI.renderActionButtons();
  DBG.log('[CLEAR] 状态已重置 p1(x='+G.p1.x+',mp='+G.p1.mp+',sp='+G.p1.sp+')');
}

function undoAction() {
  if (G.actions.length === 0) return;
  DBG.log('[UNDO] 撤销最后一个行动 #' + (G.actions.length-1) + ' = ' + G.actions[G.actions.length-1]);
  G.actions.pop();
  G.restoreSnapshot();
  G._shieldBullets = [];
  FX.clear();
  if (G.socket && G.roomId) G.socket.emit('updateActions', { actions: G.actions });
  UI.renderActionSlots();
  UI.renderActionButtons();
  DBG.log('[UNDO] 已恢复 tick=' + G.tick + ' p1(x='+G.p1.x+',mp='+G.p1.mp+',sp='+G.p1.sp+')');
}

function randomFill() {
  // 保留但不在 UI 中显示按钮，仅供 AI 使用
  const pool = [];
  (_skillsData?.genericSkills || []).forEach(g => pool.push(g.id));
  (G.mySkillIds || []).forEach((sid, i) => pool.push('skill' + (i + 1)));
  G.actions = [];
  for (let i = 0; i < G.maxActions; i++) {
    G.actions.push(pool[Math.floor(Math.random() * pool.length)]);
  }
}

function readyBattle() {
  DBG.log('[READY] 完成，发送队列 ' + G.actions.length + '个行动');
  if (G.socket && G.roomId) {
    G.socket.emit('updateActions', { actions: G.actions });
    G.socket.emit('ready');
  }
  document.getElementById('rdyBtn').disabled = true;
  UI.log('已准备，等待对手...');
}

function quitBattle() {
  if (G.socket) G.socket.emit('leaveRoom');
  G.reset();
  nav('menu');
}

// ==================== 战斗动画播放（服务端发来的帧序列） ====================
const FRAME_DURATION = 600;

function playBattleAnim(frames, final) {
  G._battleFrames = frames;
  G._battleFinal = final;
  FX.clear();
  G.tick = 0;
  G._shieldBullets = [];
  G._renderP1 = null; G._renderP2 = null; // 清除缓动渲染位置

  // ★ 恢复双方为本回合初始状态
  if (G._originP1) G.p1 = JSON.parse(JSON.stringify(G._originP1));
  if (G._originP2) G.p2 = JSON.parse(JSON.stringify(G._originP2));
  G._cooldowns = {};

  DBG.log('[BATTLE] 开始播放 ' + frames.length + ' 帧, p1(x='+G.p1.x+',hp='+G.p1.hp+') p2(x='+G.p2.x+',hp='+G.p2.hp+')');

  let tickIdx = 0;
  let battleAccum = 0;
  // 战斗步进专用时间戳，不和渲染循环共享
  let battleLastTime = performance.now();

  // 初始化第一帧 UI
  if (frames.length > 0) {
    G.p1Actions = frames[0].p1Actions || [];
    G.p2Actions = frames[0].p2Actions || [];
    UI.renderBattleQueue(0, G.p1Actions, G.p2Actions);
  }

  G._battleStep = () => {
    if (G._mode !== 'battle') return;

    const now = performance.now();
    let dt = now - battleLastTime;
    battleLastTime = now;
    if (dt > 500) dt = 16; // 防止大跳帧

    battleAccum += dt;

    if (tickIdx >= frames.length) {
      // 所有帧播完，等 FX 也播完
      if (FX.active.length === 0) {
        G.p1 = final.p1; G.p2 = final.p2;
        G._renderP1 = null; G._renderP2 = null;
        UI.updateHUD(G.p1, 'p1'); UI.updateHUD(G.p2, 'p2');
        UI.log(`回合结束 — P1 HP:${final.p1.hp} P2 HP:${final.p2.hp}`);
        G.tick = frames.length;
        UI.renderBattleQueue(G.tick, G.p1Actions, G.p2Actions);
        DBG.log('[BATTLE] 播放完毕');
        G._battleStep = null;
      }
      return;
    }

    if (battleAccum >= FRAME_DURATION) {
      battleAccum -= FRAME_DURATION;

      const prevP1 = G.p1 ? { x: G.p1.x, facing: G.p1.facing } : null;
      const prevP2 = G.p2 ? { x: G.p2.x, facing: G.p2.facing } : null;

      const frame = frames[tickIdx];
      G.p1 = frame.p1; G.p2 = frame.p2;
      G.p1Actions = frame.p1Actions || []; G.p2Actions = frame.p2Actions || [];
      G.tick = tickIdx;

      // ★ 位移缓动动画
      if (prevP1 && G.p1) {
        if (prevP1.x !== G.p1.x) {
          const fromPX = Renderer.gridToPixelX(prevP1.x);
          const toPX = Renderer.gridToPixelX(G.p1.x);
          G._renderP1 = { x: fromPX, facing: G.p1.facing };
          Tween.add(G._renderP1, { x: toPX }, FRAME_DURATION * 0.7, 'easeOutQuad');
          DBG.log('[TWEEN] P1 位移缓动 grid='+prevP1.x+'->'+G.p1.x+' pixel='+fromPX.toFixed(0)+'->'+toPX.toFixed(0));
        } else {
          G._renderP1 = null;
        }
      }
      if (prevP2 && G.p2) {
        if (prevP2.x !== G.p2.x) {
          const fromPX = Renderer.gridToPixelX(prevP2.x);
          const toPX = Renderer.gridToPixelX(G.p2.x);
          G._renderP2 = { x: fromPX, facing: G.p2.facing };
          Tween.add(G._renderP2, { x: toPX }, FRAME_DURATION * 0.7, 'easeOutQuad');
          DBG.log('[TWEEN] P2 位移缓动 grid='+prevP2.x+'->'+G.p2.x+' pixel='+fromPX.toFixed(0)+'->'+toPX.toFixed(0));
        } else {
          G._renderP2 = null;
        }
      }

      const events = frame.events || [];
      DBG.log('[BATTLE] tick=' + tickIdx + ' events=' + events.length + ' types=' + events.map(e=>e.type).join(','));
      for (const ev of events) {
        DBG.log('[BATTLE]   ev type='+ev.type+' bullet_anim='+ev.bullet_anim+' hit_anim='+ev.hit_anim+' x='+(ev.x??ev.bullet_x)+' from='+ev.bullet_from+' to='+ev.bullet_to);
        FX.spawnFromEvent(ev, FRAME_DURATION, frame.p1, frame.p2);
      }
      FX.ensureBuffEmitter(frame.p1, 'p1');
      FX.ensureBuffEmitter(frame.p2, 'p2');
      UI.renderBattleQueue(tickIdx, G.p1Actions, G.p2Actions);
      if (events.length > 0) AE.play('tick');

      tickIdx++;
    }

    // 战斗阶段也需要持续更新 FX（每帧）
    FX.update(Math.min(100, dt));
    Tween.update();
  };

  DBG.log('[BATTLE] step函数已挂载');
}

// ==================== DOM 导航 ====================
function nav(screen) {
  if (screen === 'menu') {
    G.reset();
    if (G.socket) G.socket.emit('leaveRoom');
  }
  UI.showScreen(screen);
  if (screen === 'battle') {
    const canvas = document.getElementById('fc');
    if (canvas) Renderer.init(canvas);
    startRenderLoop();
  }
  if (screen === 'wiki') {
    if (!_wikiActiveTab) initWiki();
    else { renderWikiChars(); renderWikiSkills(); }
  }
}

function updatePrepareUI() {
  UI.updatePrepareUI(G.p1);
  UI.updateHUD(G.p2, 'p2');
  document.getElementById('tm').textContent = G.timeLeft;
  document.getElementById('rnd').textContent = `ROUND ${G.round}`;
  document.getElementById('battleQueuePanel').classList.add('hidden');
}

// ==================== 角色选择 ====================
let _selChar = null;
let _selSkills = [];
let _selMode = 'ai';

async function enterCharSelect(mode) {
  _selMode = mode;
  if (!_skillsData) await loadData();
  _selChar = null; _selSkills = [];
  UI.showScreen('charSel');
  renderCharGrid();
  document.getElementById('skillSel').classList.add('hidden');
}

function renderCharGrid() {
  const cg = document.getElementById('cg');
  if (!cg || !_charsData) return;
  cg.innerHTML = '';
  _charsData.characters.forEach(c => {
    const card = document.createElement('div');
    card.className = 'cc';
    if (_selChar === c.id) card.classList.add('selected');
    const defPct = (c.def / (c.def + 40) * 100).toFixed(0);
    card.innerHTML = '<div class="ccn">' + c.name + '</div><div class="ccs" style="color:' + c.color + '">' + (c.shape === 'square' ? '■' : c.shape === 'triangle' ? '▶' : c.shape === 'diamond' ? '◆' : '▼') + '</div><div class="ccd">' + c.desc + '<br><span class="pix-label" style="color:var(--red)">[HP]</span>' + c.maxHp + ' <span class="pix-label" style="color:var(--blue)">[MP]</span>' + c.maxMp + ' <span class="pix-label" style="color:var(--green)">[SP]</span>' + c.maxSp + '<br><span class="pix-label" style="color:var(--cyan)">[ATK]</span>' + c.atk + ' <span class="pix-label" style="color:var(--blue)">[DEF]</span>' + c.def + ' (' + defPct + '%)<br><span class="pix-label" style="color:var(--green)">[REG]</span>MP+' + (c.mpRegen||1) + ' SP+' + (c.spRegen||2) + '</div>';
    card.onclick = () => {
      _selChar = c.id;
      _selSkills = [...c.defaultSkills];
      renderCharGrid();
      renderSkillGrid(c);
      document.getElementById('skillSel').classList.remove('hidden');
    };
    cg.appendChild(card);
  });
}

function renderSkillGrid(char) {
  const sg = document.getElementById('sg');
  if (!sg || !_skillsData) return;
  sg.innerHTML = '';
  const allSkills = Object.values(_skillsData.skills || {}).filter(s => s.charId === char.id);
  allSkills.forEach(sk => {
    const card = document.createElement('div');
    card.className = 'sc';
    if (_selSkills.includes(sk.id)) card.classList.add('selected');
    var typeName = {melee:'[MELEE]',projectile:'[RANGE]',targeted_aoe:'[AOE]',dash:'[DASH]',teleport_backstab:'[WARP]',shield_wall:'[SHIELD]'}[sk.type]||sk.type;
    card.innerHTML = '<div class="sn">' + sk.name + '</div><div class="st">' + typeName + ' | ' + (sk.desc||'') + '<br><span class="pix-label" style="color:var(--blue)">MP</span>' + (sk.mpCost||0) + ' <span class="pix-label" style="color:var(--green)">SP</span>' + (sk.spCost||0) + ' CD:' + (sk.cooldown||0) + ' x' + (sk.damageRatio||'-') + '</div>';
    card.onclick = () => {
      if (_selSkills.includes(sk.id)) {
        if (_selSkills.length <= 3) return;
        _selSkills = _selSkills.filter(s => s !== sk.id);
      } else {
        if (_selSkills.length >= 3) _selSkills.shift();
        _selSkills.push(sk.id);
      }
      renderSkillGrid(char);
    };
    sg.appendChild(card);
  });
  document.getElementById('startBtn').onclick = () => startGame();
}

function startGame() {
  if (!_selChar || _selSkills.length < 3) return;
  G.myCharId = _selChar;
  G.mySkillIds = [..._selSkills];
  setupSocket();

  if (_selMode === 'ai') {
    const aiChar = _charsData.characters.find(c => c.id !== _selChar) || _charsData.characters[0];
    G.socket.emit('startAI', {
      name: 'Player',
      charId: _selChar,
      skillIds: _selSkills,
      aiCharId: aiChar.id,
      aiSkillIds: [...aiChar.defaultSkills],
    });
    G.mode = 'ai';
  } else if (_selMode === 'train') {
    G.socket.emit('startTrain', {
      name: 'Player',
      charId: _selChar,
      skillIds: _selSkills,
    });
    G.mode = 'train';
  } else if (_selMode === 'online') {
    G.mode = 'online';
    UI.showScreen('lobby');
  }
}

function createRoom() {
  const name = document.getElementById('pname').value || 'Player';
  if (!G.socket) setupSocket();
  G.socket.emit('createRoom', { name });
  document.getElementById('ostatus').textContent = '创建中...';
}

function joinRoom() {
  const name = document.getElementById('pname').value || 'Player';
  const rid = document.getElementById('rcode').value.trim().toUpperCase();
  if (!rid) return;
  if (!G.socket) setupSocket();
  G.socket.emit('joinRoom', { roomId: rid, name });
  document.getElementById('ostatus').textContent = '加入中...';
  // 加入后角色选择
  const chars = _charsData?.characters || [];
  G.myCharId = chars[0]?.id || 'warrior';
  G.mySkillIds = [...(chars[0]?.defaultSkills || [])];
  if (G.socket && rid) {
    G.socket.emit('selectChar', { charId: G.myCharId, skillIds: G.mySkillIds, customSkills: {} });
  }
}

// ==================== 图鉴系统 Wiki ====================
let _wikiActiveTab = 'chars';

function initWiki() {
  _wikiActiveTab = 'chars';
  // Tab 切换事件
  document.querySelectorAll('#wikiTabs .wiki-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      _wikiActiveTab = btn.dataset.tab;
      document.querySelectorAll('#wikiTabs .wiki-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.querySelectorAll('#wiki .wiki-panel').forEach(p => p.classList.remove('active'));
      document.getElementById('wiki' + (_wikiActiveTab === 'chars' ? 'Chars' : _wikiActiveTab === 'skills' ? 'Skills' : 'Rules')).classList.add('active');
      if (_wikiActiveTab === 'chars') renderWikiChars();
      else if (_wikiActiveTab === 'skills') renderWikiSkills();
    });
  });
  renderWikiChars();
}

function renderWikiChars() {
  const el = document.getElementById('wikiChars');
  if (!el) return;
  const chars = _charsData?.characters || [];
  const skills = _skillsData?.skills || {};

  el.innerHTML = chars.map(c => {
    const reduction = (c.def / (c.def + 40) * 100).toFixed(1);
    const charSkills = Object.values(skills).filter(s => s.charId === c.id);
    return `
    <div class="wiki-char-card">
      <div class="wiki-char-header">
        <div class="wiki-char-avatar" style="border-color:${c.color};color:${c.color};box-shadow:0 0 8px ${c.color}">
          ${c.shape === 'square' ? '■' : c.shape === 'triangle' ? '▶' : c.shape === 'diamond' ? '◆' : '▼'}
        </div>
        <div>
          <div class="wiki-char-name" style="color:${c.color}">${c.name}</div>
          <div class="wiki-char-desc">${c.desc}</div>
        </div>
      </div>
      <div class="wiki-stat-grid">
        <div class="wiki-stat-item"><div class="wiki-stat-val">${c.maxHp}</div><div class="wiki-stat-label c-red">[ HP ]</div></div>
        <div class="wiki-stat-item"><div class="wiki-stat-val">${c.maxMp}</div><div class="wiki-stat-label c-blue">[ MP ]</div></div>
        <div class="wiki-stat-item"><div class="wiki-stat-val">${c.maxSp}</div><div class="wiki-stat-label c-green">[ SP ]</div></div>
        <div class="wiki-stat-item"><div class="wiki-stat-val">${c.atk}</div><div class="wiki-stat-label c-cyan">[ ATK ]</div></div>
        <div class="wiki-stat-item"><div class="wiki-stat-val">${c.def} <span style="font-size:.22rem;color:#888">(${reduction}%)</span></div><div class="wiki-stat-label c-blue">[ DEF ]</div></div>
        <div class="wiki-stat-item"><div class="wiki-stat-val" style="color:var(--green)">MP+${c.mpRegen||1} SP+${c.spRegen||2}</div><div class="wiki-stat-label regen">[ REGEN ]</div></div>
      </div>
      <div class="wiki-char-skills">
        <h4>📜 技能 (${charSkills.length})</h4>
        ${charSkills.map(s => `
        <div class="wiki-skill-item">
          <span class="ws-name" style="color:${s.color||'var(--c2)'}">${s.name}</span>
          <span class="ws-info">${s.desc||''}</span>
          <span class="ws-cost">${s.mpCost>0?'MP'+s.mpCost:''} ${s.spCost>0?'SP'+s.spCost:''} CD:${s.cooldown||0}</span>
        </div>`).join('')}
      </div>
    </div>`;
  }).join('');
}

function renderWikiSkills() {
  const el = document.getElementById('wikiSkills');
  if (!el) return;
  const skills = _skillsData?.skills || {};
  const chars = _charsData?.characters || [];
  const charMap = {};
  chars.forEach(c => { charMap[c.id] = c; });

  el.innerHTML = Object.values(skills).map(s => {
    const ch = charMap[s.charId];
    const typeLabel = { melee: '[MELEE]', projectile: '[RANGE]', targeted_aoe: '[AOE]', dash: '[DASH]', teleport_backstab: '[WARP]', shield_wall: '[SHIELD]' }[s.type] || s.type;
    const effectLabel = { normal_damage: 'DMG', stun_damage: 'STUN', freeze_damage: 'FREEZE', burn_debuff: 'BURN', poison_debuff: 'POISON', true_damage: 'TRUE', dash_knockback: 'KNOCK', shield_bullet: 'SHIELD', none: 'MOVE' }[s.effect] || s.effect;
    const backstabInfo = s.backstabRatio ? '<br>[BACKSTAB] x' + s.backstabRatio : '';
    const dotInfo = s.burnTicks ? '<br>[BURN] ' + s.burnTicks + 'tick ATKx' + (s.burnRatio||0) : (s.poisonTicks ? '<br>[POISON] ' + s.poisonTicks + 'tick ATKx' + (s.poisonRatio||0) : '');
    return `
    <div class="wiki-skill-card">
      <div class="wiki-skill-title">
        <span class="wst-name" style="color:${s.color||'var(--c2)'}">${s.name}</span>
        <span class="wst-char">${ch ? ch.name : s.charId}</span>
      </div>
      <div class="wiki-skill-desc">${typeLabel} · ${effectLabel}${backstabInfo}${dotInfo}</div>
      <div class="wiki-skill-stats">
        <div class="wiki-skill-stat"><div class="wss-val">${s.damageRatio ? '×'+s.damageRatio : '-'}</div><div class="wss-lbl">倍率</div></div>
        <div class="wiki-skill-stat"><div class="wss-val">${s.range||s.bulletRange||'-'}</div><div class="wss-lbl">射程</div></div>
        <div class="wiki-skill-stat"><div class="wss-val">${s.cooldown||0}tick</div><div class="wss-lbl">冷却</div></div>
        <div class="wiki-skill-stat"><div class="wss-val">${s.bulletPriority||'-'}</div><div class="wss-lbl">弹幕Lv</div></div>
      </div>
      <div style="font-size:.24rem;color:#555;margin-top:4px;">
        MP${s.mpCost||0} SP${s.spCost||0} ${s.multiShot ? 'x'+s.multiShot : ''} ${s.aoeRadius ? 'AOE±'+s.aoeRadius : ''} ${s.stunDuration ? 'STUN'+s.stunDuration+'t' : ''} ${s.freezeDuration ? 'FREEZE'+s.freezeDuration+'t' : ''} ${s.knockback ? 'KNOCK'+s.knockback : ''} ${s.defBuff ? 'DEF+'+(s.defBuff*100)+'%' : ''}
      </div>
    </div>`;
  }).join('');
}

// ==================== 初始化 ====================
async function init() {
  await loadData();
  AE.init();
  const canvas = document.getElementById('fc');
  if (canvas) Renderer.init(canvas);
  window.addEventListener('resize', () => Renderer.resize());

  // 默认显示菜单
  UI.showScreen('menu');
}

document.addEventListener('DOMContentLoaded', init);
