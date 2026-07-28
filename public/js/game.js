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
        const tip = facing > 0 ? x + s/2 : x - s/2;
        ctx.beginPath();
        ctx.moveTo(tip, y - s/2);
        ctx.lineTo(x + (facing > 0 ? -s/2 : s/2), y);
        ctx.closePath(); ctx.fill();

        const tip2 = facing > 0 ? x - s/2 : x + s/2;
        ctx.beginPath();
        ctx.moveTo(tip2, y - s);
        ctx.lineTo(x + (facing > 0 ? s/2 : -s/2), y - s/2);
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

  /** 绘制玩家 */
  drawPlayers(p1, p2) {
    if (!p1 || !p2) return;
    const p1c = getCharDef(p1.charId) || { shape: 'square', size: 18, color: '#00ffff' };
    const p2c = getCharDef(p2.charId) || { shape: 'square', size: 18, color: '#ff4444' };

    Sprites.drawCharacter(this.ctx, p1c,
      this.gridToPixelX(p1.x), this.baseY, p1c.size, p1.facing, p1._alpha ?? 1);

    Sprites.drawCharacter(this.ctx, p2c,
      this.gridToPixelX(p2.x), this.baseY, p2c.size, p2.facing, p2._alpha ?? 1);

    // 玩家名称标签
    const px1 = this.gridToPixelX(p1.x);
    const px2 = this.gridToPixelX(p2.x);
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
      // === 近战命中 ===
      case 'melee_hit':
      case 'stun_hit':
      case 'backstab_hit':
      case 'dash_hit': {
        // 近战弹幕：在目标格瞬间出现然后淡出
        const hitAnim = getAnim(ev.hit_anim);
        const x = Renderer.gridToPixelX(ev.bullet_x ?? ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.bullet_anim) {
          this.active.push(new MeleeBulletFX(ev.bullet_anim, x, y, color, anim?.fadeTime || 300));
        }
        // 命中环
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, x, y, color));
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
  constructor(spriteName, x, y, color, fadeTime = 300) {
    this.spriteName = spriteName;
    this.x = x;
    this.y = y;
    this.color = color;
    this.fadeTime = fadeTime;
    this.elapsed = 0;
    this.done = false;
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.fadeTime) this.done = true;
  }

  render(ctx, R) {
    const progress = this.elapsed / this.fadeTime;
    // 前 20% 时间保持全亮，之后淡出
    const alpha = progress < 0.2 ? 1 : Math.max(0, 1 - (progress - 0.2) / 0.8);
    const scale = 1 + progress * 0.3; // 微微放大
    R.drawBulletSprite(this.spriteName, this.x, this.y, scale, alpha, this.color);
  }
}

// ==================== 平射弹幕 FX ====================
// 从发射者平移至目标/最远点，速度递减
class ProjectileBulletFX {
  constructor(spriteName, fromX, toX, y, color, frameDuration, hasHit = true) {
    this.spriteName = spriteName;
    this.fromX = fromX;
    this.toX = toX;
    this.x = fromX;
    this.y = y;
    this.color = color;
    this.totalDuration = frameDuration * 0.8;
    this.elapsed = 0;
    this.done = false;
    this.hasHit = hasHit;
    // 从动画配置读取速度参数
    const anim = getAnim(spriteName);
    this.speedStart = anim?.speedStart || 4;
    this.speedEnd = anim?.speedEnd || 2;
    this.instant = anim?.instant || false;
    if (this.instant) this.totalDuration = frameDuration * 0.15;
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
// 从目标格上方屏幕边界生成，加速下落
class VerticalBulletFX {
  constructor(spriteName, x, startY, targetY, color, frameDuration) {
    this.spriteName = spriteName;
    this.x = x;
    this.startY = startY;
    this.targetY = targetY;
    this.y = startY;
    this.color = color;
    this.totalDuration = frameDuration * 0.7;
    this.elapsed = 0;
    this.done = false;
    const anim = getAnim(spriteName);
    this.speedStart = anim?.speedStart || 3;
    this.speedEnd = anim?.speedEnd || 15;
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

  reset() {
    this.p1 = null; this.p2 = null; this.actions = [];
    this.round = 0; this.timeLeft = 60; this.tick = 0;
    this.p1Actions = []; this.p2Actions = [];
    FX.clear(); Tween.clear();
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

    // 计算当前可用资源
    let curMp = G.p1?.mp || 0, curSp = G.p1?.sp || 0;
    // 减去已排入队列的技能消耗
    for (const a of G.actions) {
      const sk = getSkillById(a);
      if (sk) { curMp -= (sk.mpCost || 0); curSp -= (sk.spCost || 0); }
      else { const gs = (_skillsData?.genericSkills || []).find(g => g.id === a);
        if (gs) curSp -= (gs.spCost || 0); }
    }

    // tick cooldowns
    const cd = G._cooldowns || {};
    for (const k in cd) { if (cd[k] > 0) cd[k]--; }
    G._cooldowns = cd;

    // 技能按钮
    const skills = G.mySkillIds || [];
    skills.forEach((sid, idx) => {
      const sk = getSkillById(sid);
      if (!sk) return;
      const btn = document.createElement('button');
      btn.className = 'btn btn-b s';
      const onCD = (cd[sid] || 0) > 0;
      const enoughRes = curMp >= (sk.mpCost || 0) && curSp >= (sk.spCost || 0);
      btn.textContent = `${sk.name} [MP${sk.mpCost||0} SP${sk.spCost||0}]${onCD ? ` CD${cd[sid]}` : ''}`;
      btn.disabled = G.actions.length >= G.maxActions || onCD || !enoughRes;
      if (!enoughRes) btn.style.opacity = '0.5';
      btn.onclick = () => {
        const actionId = `skill${idx + 1}`;
        const skill = getSkillById(G.mySkillIds[idx]);
        if (G.actions.length >= G.maxActions) return;
        if ((cd[G.mySkillIds[idx]] || 0) > 0) return;
        if (curMp < (skill?.mpCost || 0) || curSp < (skill?.spCost || 0)) return;
        G.actions.push(actionId);
        curMp -= (skill?.mpCost || 0); curSp -= (skill?.spCost || 0);
        if (skill?.cooldown) cd[G.mySkillIds[idx]] = skill.cooldown;
        if (G.socket && G.roomId) G.socket.emit('updateActions', { actions: G.actions });
        UI.renderActionSlots();
        UI.renderActionButtons();
      };
      container.appendChild(btn);
    });

    // 通用技能按钮
    const generic = _skillsData?.genericSkills || [];
    generic.forEach(gs => {
      const btn = document.createElement('button');
      btn.className = 'btn btn-g s';
      btn.textContent = `${gs.name} [SP${gs.spCost||0}]`;
      btn.disabled = G.actions.length >= G.maxActions || curSp < (gs.spCost || 0);
      btn.onclick = () => {
        if (G.actions.length >= G.maxActions) return;
        if (curSp < (gs.spCost || 0)) return;
        G.actions.push(gs.id);
        curSp -= (gs.spCost || 0);
        if (G.socket && G.roomId) G.socket.emit('updateActions', { actions: G.actions });
        UI.renderActionSlots();
        UI.renderActionButtons();
      };
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
    G.actions = []; G._cooldowns = {};
    G.p1Actions = []; G.p2Actions = [];
    FX.clear();
    updatePrepareUI();
    UI.showScreen('battle');
    UI.renderActionSlots();
    UI.renderActionButtons();
    document.getElementById('actionQueuePanel').classList.remove('hidden');
    document.getElementById('battleQueuePanel').classList.add('hidden');
    document.getElementById('rdyBtn').disabled = false;

    if (G.mode === 'ai') {
      G.socket.emit('aiReady', { roomId: G.roomId });
      document.getElementById('actionQueuePanel').classList.add('hidden');
    }
    if (G.mode === 'train') {
      G.socket.emit('trainReady', { roomId: G.roomId });
    }
    UI.log(`Round ${d.round} — 准备阶段 (${d.time}s)`);
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

// ==================== 战斗动画播放 ====================
const FRAME_DURATION = 600; // ms per tick

function playBattleAnim(frames, final) {
  FX.clear();
  let tickIdx = 0;
  let lastTime = performance.now();
  let frameAccum = 0;

  // 设置初始状态
  if (frames.length > 0) {
    const f0 = frames[0];
    G.p1 = f0.p1; G.p2 = f0.p2;
    G.p1Actions = f0.p1Actions || []; G.p2Actions = f0.p2Actions || [];
  }

  function animate(now) {
    if (G._mode !== 'battle') return; // 可能已切换阶段

    let dt = now - lastTime;
    lastTime = now;
    if (dt > 200) dt = 16; // 防止跳帧过大

    FX.update(dt);
    Tween.update();

    // 处理帧步进
    frameAccum += dt;
    while (frameAccum >= FRAME_DURATION && tickIdx < frames.length) {
      const frame = frames[tickIdx];
      G.p1 = frame.p1; G.p2 = frame.p2;
      G.p1Actions = frame.p1Actions || []; G.p2Actions = frame.p2Actions || [];
      G.tick = tickIdx;

      // 从事件生成特效
      const events = frame.events || [];
      for (const ev of events) {
        FX.spawnFromEvent(ev, FRAME_DURATION, frame.p1, frame.p2);
      }

      // Buff 粒子
      FX.ensureBuffEmitter(frame.p1, 'p1');
      FX.ensureBuffEmitter(frame.p2, 'p2');

      // 更新战斗阶段队列面板
      UI.renderBattleQueue(tickIdx, G.p1Actions, G.p2Actions);

      // tick 音效
      if (events.length > 0) AE.play('tick');

      AE.play('tick');
      frameAccum -= FRAME_DURATION;
      tickIdx++;
    }

    // 渲染
    Renderer.resize();
    Renderer.drawGrid();
    Renderer.drawShields(frames[Math.min(tickIdx, frames.length - 1)]?.bullets || []);
    Renderer.drawPlayers(G.p1, G.p2);
    FX.render(Renderer.ctx);

    // 更新 HUD
    UI.updateHUD(G.p1, 'p1');
    UI.updateHUD(G.p2, 'p2');
    document.getElementById('tm').textContent = G.tick;
    document.getElementById('rnd').textContent = `ROUND ${G.round}`;

    if (tickIdx < frames.length || FX.active.length > 0) {
      requestAnimationFrame(animate);
    } else {
      // 动画播放完毕
      G.p1 = final.p1; G.p2 = final.p2;
      UI.updateHUD(G.p1, 'p1');
      UI.updateHUD(G.p2, 'p2');
      UI.log(`回合结束 — P1 HP:${final.p1.hp} P2 HP:${final.p2.hp}`);
      G.tick = frames.length;
      UI.renderBattleQueue(G.tick, G.p1Actions, G.p2Actions);
    }
  }

  requestAnimationFrame(animate);
}

// ==================== DOM 事件绑定 ====================
function nav(screen) {
  if (screen === 'menu') {
    G.reset();
    if (G.socket) G.socket.emit('leaveRoom');
  }
  UI.showScreen(screen);
  if (screen === 'battle') {
    const canvas = document.getElementById('fc');
    if (canvas) Renderer.init(canvas);
  }
}

function updatePrepareUI() {
  UI.updatePrepareUI(G.p1);
  // P2 side: always visible during prepare
  UI.updateHUD(G.p2, 'p2');
  document.getElementById('tm').textContent = G.timeLeft;
  document.getElementById('rnd').textContent = `ROUND ${G.round}`;
  // hide queue panel in prepare
  document.getElementById('battleQueuePanel').classList.add('hidden');
}

function clearActions() {
  G.actions = [];
  if (G.socket && G.roomId) G.socket.emit('updateActions', { actions: G.actions });
  UI.renderActionSlots();
  UI.renderActionButtons();
}

function undoAction() {
  if (G.actions.length === 0) return;
  G.actions.pop();
  if (G.socket && G.roomId) G.socket.emit('updateActions', { actions: G.actions });
  UI.renderActionSlots();
  UI.renderActionButtons();
}

function randomFill() {
  const pool = [];
  const generic = _skillsData?.genericSkills || [];
  generic.forEach(g => pool.push(g.id));
  (G.mySkillIds || []).forEach((sid, i) => {
    const sk = getSkillById(sid);
    if (sk) pool.push('skill' + (i + 1), 'skill' + (i + 1));
  });
  G.actions = [];
  for (let i = 0; i < G.maxActions; i++) {
    G.actions.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  if (G.socket && G.roomId) G.socket.emit('updateActions', { actions: G.actions });
  UI.renderActionSlots();
  UI.renderActionButtons();
}

function readyBattle() {
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
    card.innerHTML = `<div class="ccn">${c.name}</div><div class="ccs" style="color:${c.color}">${c.shape}</div><div class="ccd">${c.desc}<br>HP:${c.maxHp} MP:${c.maxMp} SP:${c.maxSp} ATK:${c.atk} DEF:${c.def}</div>`;
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
    card.className = 'cc';
    if (_selSkills.includes(sk.id)) card.classList.add('selected');
    card.innerHTML = `<div class="ccn">${sk.name}</div><div class="ccd">${sk.type} | ${sk.effect || 'none'}<br>${sk.desc||''}<br>MP:${sk.mpCost||0} SP:${sk.spCost||0} CD:${sk.cooldown||0}</div>`;
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
