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
        // 刺客：单三角（与射手相同的三角形，但颜色不同）
        const tip = facing > 0 ? x + s/2 : x - s/2;
        ctx.beginPath();
        ctx.moveTo(tip, y - s/2);
        ctx.lineTo(x + (facing > 0 ? -s/2 : s/2), y - s);
        ctx.lineTo(x + (facing > 0 ? -s/2 : s/2), y);
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

  /** 绘制弹幕像素画字符画。facing < 0 时水平翻转（默认字符画向右） */
  drawBulletSprite(spriteName, bx, by, scale = 1, alpha = 1, colorOverride = null, facing = 1) {
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

    // 水平翻转：translate 到中心，scaleX(-1)，translate 回去
    if (facing < 0) {
      ctx.translate(bx, 0);
      ctx.scale(-1, 1);
      ctx.translate(-bx, 0);
    }

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

    // 基地标记
    this.drawBases(ctx);
  },

  /** 绘制两侧基地（地图左右边界变为基地颜色条） */
  drawBases(ctx) {
    if (!G.bases) return;
    const barW = this.cellW * 0.22;
    for (const key of ['p1', 'p2']) {
      const hpPct = G.bases[key].hp / G.bases[key].maxHp;
      // P1基地在左侧边界，颜色cyan→红（随受损变红）；P2在右侧，颜色红→暗
      let r, g, b;
      if (key === 'p1') {
        // cyan #00ffff → 受损变红
        r = Math.floor(255 * (1 - hpPct));
        g = Math.floor(255 * hpPct + 60 * (1 - hpPct));
        b = Math.floor(255 * hpPct + 40 * (1 - hpPct));
      } else {
        // red #ff4444
        r = Math.floor(255 * hpPct + 80 * (1 - hpPct));
        g = Math.floor(68 * hpPct + 20 * (1 - hpPct));
        b = Math.floor(68 * hpPct + 20 * (1 - hpPct));
      }
      const baseColor = `rgb(${r},${g},${b})`;
      const bx = key === 'p1' ? 0 : this.canvas.width - barW;
      const by = 0;
      const bh = this.canvas.height;

      ctx.save();
      // 填充
      ctx.fillStyle = baseColor;
      ctx.globalAlpha = 0.35 + hpPct * 0.35;
      ctx.fillRect(bx, by, barW, bh);
      ctx.globalAlpha = 1;
      // 发光边框
      ctx.strokeStyle = baseColor;
      ctx.lineWidth = 2;
      ctx.shadowColor = baseColor;
      ctx.shadowBlur = 8;
      ctx.strokeRect(bx, by, barW, bh);
      ctx.shadowBlur = 0;
      // HP文字（竖直写在中间）
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(9, this.cellW*0.2)}px monospace`;
      ctx.textAlign = 'center';
      ctx.save();
      const cx = bx + barW / 2;
      const cy = bh * 0.55;
      ctx.translate(cx, cy);
      ctx.rotate(-Math.PI / 2);
      ctx.fillText(`${G.bases[key].hp}`, 0, 4);
      ctx.restore();
      ctx.restore();
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

  /** 绘制护盾弹幕 — 已移除，护盾现在作为普通弹幕处理 */
};

// ==================== FX 动画特效系统 ====================
// FX 管理所有动态特效的创建、更新与渲染
const FX = {
  active: [],   // 当前活跃的特效列表

  /** 从事件数据创建特效 */
  spawnFromEvent(ev, frameDuration, p1, p2, isEdit = false) {
    const animName = ev.bullet_anim || ev.hit_anim;
    const anim = getAnim(animName);
    const color = ev.bullet_color || '#ffffff';
    const stagger = ev._stagger || 0; // 错时延迟(ms)
    // 弹幕朝向
    const facing = ev.facing || (
      (ev.bullet_from !== undefined && ev.bullet_to !== undefined)
        ? (ev.bullet_to > ev.bullet_from ? 1 : -1)
        : 1
    );

    switch (ev.type) {
      // === 近战弹幕（多格宽字符画，根据 spreadGrids 控制宽度） ===
      case 'melee_slash': {
        const x = Renderer.gridToPixelX(ev.bullet_x ?? ev.x ?? 0);
        const y = Renderer.baseY - 10;
        const spread = anim?.spreadGrids || 1;
        if (ev.bullet_anim) {
          const fx = new MeleeBulletFX(ev.bullet_anim, x, y, color, anim?.fadeTime || 350, spread, stagger);
          fx.facing = facing;
          this.active.push(fx);
        }
        if (!stagger && !isEdit) AE.play('skill');
        break;
      }

      // === 近战命中 ===
      case 'melee_hit':
      case 'stun_hit':
      case 'backstab_hit':
      case 'dash_hit': {
        const hitX = Renderer.gridToPixelX(ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, hitX, y, color));
        }
        // 伤害跳字
        if (ev.dmg && ev.dmg > 0) {
          this.active.push(new DamageTextFX(hitX, y - 10, ev.dmg, '#ff4444'));
        }
        if (!isEdit) AE.play('hit');
        break;
      }

      // === 平射弹幕（支持 stagger 错时延迟） ===
      case 'bullet_hit':
      case 'freeze_hit':
      case 'poison_hit': {
        const fromX = Renderer.gridToPixelX(ev.bullet_from ?? ev.x ?? 0);
        const toX = Renderer.gridToPixelX(ev.bullet_to ?? ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.bullet_anim) {
          const fx = new ProjectileBulletFX(ev.bullet_anim, fromX, toX, y, color, frameDuration, true, stagger);
          fx.facing = facing;
          this.active.push(fx);
        }
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, toX, y, color, stagger));
        }
        if (ev.dmg && ev.dmg > 0) {
          this.active.push(new DamageTextFX(toX, y - 10, ev.dmg, '#ff4444'));
        }
        if (!stagger && !isEdit) AE.play('hit');
        break;
      }

      // === 弹幕飞到尽头消失 ===
      case 'bullet_trail': {
        const fromX = Renderer.gridToPixelX(ev.bullet_from ?? ev.x ?? 0);
        const toX = Renderer.gridToPixelX(ev.bullet_to ?? ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.bullet_anim) {
          const fx = new ProjectileBulletFX(ev.bullet_anim, fromX, toX, y, color, frameDuration, false, stagger);
          fx.facing = facing;
          this.active.push(fx);
        }
        break;
      }

      // === 弹幕被碰撞截断（飞到碰撞位置后消失） ===
      case 'bullet_trail_cut': {
        const fromX = Renderer.gridToPixelX(ev.bullet_from ?? ev.x ?? 0);
        const toX = Renderer.gridToPixelX(ev.bullet_to ?? ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.bullet_anim) {
          const fx = new ProjectileBulletFX(ev.bullet_anim, fromX, toX, y, color, frameDuration, false, stagger);
          fx.facing = facing;
          this.active.push(fx);
        }
        break;
      }

      // === DOT tick 伤害（燃烧/中毒每tick扣血） ===
      case 'burn_tick':
      case 'poison_tick': {
        const dotX = Renderer.gridToPixelX(ev.x ?? 0);
        const dotY = Renderer.baseY - 10;
        if (ev.dmg && ev.dmg > 0) {
          this.active.push(new DamageTextFX(dotX, dotY - 10, ev.dmg, ev.bullet_color || '#88ff00'));
        }
        break;
      }

      // === 弹幕相撞（在碰撞对应格位置播放动画） ===
      case 'bullet_clash': {
        const cx = Renderer.gridToPixelX(ev.x ?? 0);
        const cy = Renderer.baseY - 10;
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, cx, cy, ev.bullet_color || '#ffff00'));
        }
        // 碰撞碎片粒子
        this.active.push(new BulletClashFragmentFX(cx, cy, ev.bullet_color || '#ffff00'));
        if (!isEdit) AE.play('block');
        break;
      }

      // === 垂直弹幕 AOE（箭雨接力下落 / 火球单发） ===
      case 'aoe_cast': {
        const ax = Renderer.gridToPixelX(ev.x ?? 0);
        const ay = ev._startY || 0;
        const endY = ev._endY || Renderer.baseY;
        const doExplode = true;
        if (ev.bullet_anim) {
          const fx = new VerticalBulletFX(ev.bullet_anim, ax, ay, endY, color, frameDuration, doExplode, stagger);
          fx.facing = facing;
          this.active.push(fx);
        }
        break;
      }

      // === AOE 命中（火球爆炸扩圈特效，箭雨由 VerticalBulletFX 落地处理） ===
      case 'burn_hit':
      case 'aoe_hit': {
        const hitX = Renderer.gridToPixelX(ev.x ?? 0);
        const y = Renderer.baseY - 10;
        if (ev.bullet_anim === 'fireballDrop') {
          const fx = new ExplosionRingFX('fireballExplosion', hitX, y, color, stagger);
          fx.facing = facing;
          this.active.push(fx);
          if (ev.hit_anim) {
            this.active.push(new HitRingFX(ev.hit_anim, hitX, y, color, stagger));
          }
        }
        if (ev.dmg && ev.dmg > 0) {
          this.active.push(new DamageTextFX(hitX, y - 10, ev.dmg, '#ff6600'));
        }
        if (!stagger && !isEdit) AE.play('hit');
        break;
      }

      // === 冲刺 ===
      case 'dash': {
        const dashFrom = Renderer.gridToPixelX(ev.bullet_from ?? ev.x ?? 0);
        const dashTo = Renderer.gridToPixelX(ev.bullet_to ?? ev.to ?? 0);
        const dy = Renderer.baseY;
        if (ev.bullet_anim) {
          const dashKey = ev.actor;
          const getPos = {
            getX: () => {
              const rp = dashKey === 'p1' ? G._renderP1 : G._renderP2;
              const p = dashKey === 'p1' ? G.p1 : G.p2;
              if (rp) return rp.x;
              if (p) return Renderer.gridToPixelX(p.x);
              return dashTo;
            },
            getFacing: () => {
              const p = dashKey === 'p1' ? G.p1 : G.p2;
              return p ? p.facing : 1;
            }
          };
          const charId = dashKey === 'p1' ? (p1||G.p1)?.charId : (p2||G.p2)?.charId;
          this.active.push(new AfterimageFX(charId, dashFrom, dashTo, dy, frameDuration * 0.7, getPos));
        }
        if (!isEdit) AE.play('dodge');
        break;
      }

      // === 突击盾金色冲锋光环（跟随角色移动的像素画特效） ===
      case 'dash_charge': {
        const chargeFrom = Renderer.gridToPixelX(ev.bullet_from ?? ev.x ?? 0);
        const chargeTo = Renderer.gridToPixelX(ev.bullet_to ?? ev.to ?? 0);
        const y = Renderer.baseY;
        const chargeKey = ev.actor;
        const getPos = {
          getX: () => {
            const rp = chargeKey === 'p1' ? G._renderP1 : G._renderP2;
            const p = chargeKey === 'p1' ? G.p1 : G.p2;
            if (rp) return rp.x;
            if (p) return Renderer.gridToPixelX(p.x);
            return chargeTo;
          },
          getFacing: () => {
            const p = chargeKey === 'p1' ? G.p1 : G.p2;
            return p ? p.facing : 1;
          }
        };
        const spriteName = ev.bullet_anim || 'dash_charge';
        this.active.push(new DashChargeFX(spriteName, ev.bullet_color || '#ffcc00',
          chargeFrom, chargeTo, y, frameDuration * 0.7, getPos));
        break;
      }

      // === 闪避 ===
      case 'dodged': {
        const dx = Renderer.gridToPixelX(ev.x ?? 0);
        const dodgeKey = ev.actor;
        // 从 Tween 获取起止位置
        const rp = dodgeKey === 'p1' ? G._renderP1 : G._renderP2;
        const p = dodgeKey === 'p1' ? G.p1 : G.p2;
        const fromX = rp ? rp.x : (p ? Renderer.gridToPixelX(p.x) - Renderer.cellW * 2 : dx - Renderer.cellW * 2);
        const toX = rp ? (Tween._tweens.find(t => t.obj === rp)?.end?.x || dx) : dx;
        const getPos = {
          getX: () => {
            const r = dodgeKey === 'p1' ? G._renderP1 : G._renderP2;
            const pl = dodgeKey === 'p1' ? G.p1 : G.p2;
            if (r) return r.x;
            if (pl) return Renderer.gridToPixelX(pl.x);
            return dx;
          },
          getFacing: () => {
            const pl = dodgeKey === 'p1' ? G.p1 : G.p2;
            return pl ? pl.facing : 1;
          }
        };
        const charId = dodgeKey === 'p1' ? (p1||G.p1)?.charId : (p2||G.p2)?.charId;
        this.active.push(new AfterimageFX(charId, fromX, toX, Renderer.baseY, 400, getPos));
        if (!isEdit) AE.play('dodge');
        break;
      }

      // === 瞬移 ===
      case 'teleport': {
        const tx = Renderer.gridToPixelX(ev.to ?? 0);
        if (ev.bullet_anim) {
          this.active.push(new HitRingFX(ev.bullet_anim, tx, Renderer.baseY - 10, color));
        }
        if (!isEdit) AE.play('dodge');
        break;
      }

      // === 击退（残影跟随被击退方） ===
      case 'knockback': {
        const kFrom = Renderer.gridToPixelX(ev.from ?? ev.x ?? 0);
        const kTo = Renderer.gridToPixelX(ev.to ?? ev.x ?? 0);
        const kbKey = ev.actor;
        const getPos = {
          getX: () => {
            const rp = kbKey === 'p1' ? G._renderP1 : G._renderP2;
            const p = kbKey === 'p1' ? G.p1 : G.p2;
            if (rp) return rp.x;
            if (p) return Renderer.gridToPixelX(p.x);
            return kTo;
          },
          getFacing: () => {
            const p = kbKey === 'p1' ? G.p1 : G.p2;
            return p ? p.facing : 1;
          }
        };
        const charId = kbKey === 'p1' ? (p1||G.p1)?.charId : (p2||G.p2)?.charId;
        this.active.push(new AfterimageFX(charId, kFrom, kTo, Renderer.baseY, 350, getPos));
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, kTo, Renderer.baseY - 10, ev.bullet_color || '#ffaa00'));
        }
        break;
      }

      // === 碰撞 ===
      case 'collision': {
        const cx = Renderer.gridToPixelX(ev.x ?? 0);
        if (ev.hit_anim) {
          this.active.push(new HitRingFX(ev.hit_anim, cx, Renderer.baseY - 10, ev.bullet_color || '#ffff00'));
        }
        if (ev.dmg1 && ev.dmg1 > 0) {
          this.active.push(new DamageTextFX(cx, Renderer.baseY - 20, ev.dmg1, '#ffff00'));
        }
        if (ev.dmg2 && ev.dmg2 > 0) {
          this.active.push(new DamageTextFX(cx, Renderer.baseY - 20, ev.dmg2, '#ffff00'));
        }
        if (!isEdit) AE.play('block');
        break;
      }

      // === 基地受到攻击 ===
      case 'base_hit': {
        const bx = Renderer.gridToPixelX(ev.x ?? 0);
        const by = Renderer.baseY - 20;
        this.active.push(new HitRingFX('baseHit', bx, by, ev.bullet_color || '#ff8800'));
        if (ev.dmg && ev.dmg > 0) {
          this.active.push(new DamageTextFX(bx, by - 10, ev.dmg, '#ff8800'));
        }
        if (!isEdit) AE.play('hit');
        break;
      }
    }
  },

  /** 为 buff/debuff 生成持续粒子 */
  ensureBuffEmitter(player, playerKey, p1, p2) {
    const key = '_buffFx_' + playerKey;
    // 兼容 _effects（服务端原始）和 effects（clonePlayer 后）
    const effects = player._effects || player.effects || [];
    if (effects.length === 0) {
      if (FX[key]) { FX[key] = null; }
      return;
    }
    const x = Renderer.gridToPixelX(player.x);
    const y = Renderer.baseY - 25;
    if (!FX[key]) {
      const eff = effects[0];
      let animName = 'buffParticle';
      if (eff.type === 'burn') animName = 'dotBleed';
      else if (eff.type === 'poison') animName = 'dotBleed';
      else if (eff.type === 'stun') animName = 'stunSpark';
      else if (eff.type === 'freeze') animName = 'buffParticle';
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
      if (fx.done) { this.active.splice(i, 1); }
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

// ==================== 近战弹幕 FX (单个大字符画) ====================
class MeleeBulletFX {
  constructor(animName, x, y, color, fadeTime = 350, spreadGrids = 1, stagger = 0) {
    const anim = getAnim(animName);
    this.spriteName = anim?.sprite || animName;
    this.x = x;
    this.y = y;
    this.color = color;
    this.fadeTime = anim?.fadeTime || fadeTime;
    this.stagger = stagger;
    this.facing = 1; // 默认向右，spawnFromEvent 会覆盖
    this.elapsed = -stagger;
    this.done = false;
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed < 0) return;
    if (this.elapsed >= this.fadeTime) this.done = true;
  }

  render(ctx, R) {
    if (this.elapsed < 0) return;
    const progress = Math.min(1, this.elapsed / this.fadeTime);
    const alpha = progress < 0.15 ? progress / 0.15 : Math.max(0, 1 - (progress - 0.15) / 0.85);
    const scale = 1.0 + progress * 0.15;
    R.drawBulletSprite(this.spriteName, this.x, this.y, scale, alpha, this.color, this.facing);
  }
}

// ==================== 平射弹幕 FX (支持错时发射) ====================
class ProjectileBulletFX {
  constructor(animName, fromX, toX, y, color, frameDuration, hasHit = true, stagger = 0) {
    const anim = getAnim(animName);
    this.spriteName = anim?.sprite || animName;
    this.fromX = fromX;
    this.toX = toX;
    this.x = fromX;
    this.y = y;
    this.color = color;
    this.totalDuration = frameDuration * 0.75;
    this.stagger = stagger;
    this.elapsed = -stagger; // 负值 = 延迟
    this.done = false;
    this.hasHit = hasHit;
    this.facing = 1;
    this.speedStart = anim?.speedStart || 10;
    this.speedEnd = anim?.speedEnd || 4;
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed < 0) return; // 还在延迟
    const t = Math.min(1, this.elapsed / this.totalDuration);
    // ease-out (快起慢停)
    const ease = 1 - Math.pow(1 - t, 2);
    this.x = this.fromX + (this.toX - this.fromX) * ease;
    if (t >= 1) this.done = true;
  }

  render(ctx, R) {
    if (this.elapsed < 0) return;
    const t = Math.min(1, this.elapsed / this.totalDuration);
    let alpha = 1;
    if (t > 0.85 && !this.hasHit) alpha = Math.max(0, 1 - (t - 0.85) / 0.15);
    else if (t > 0.9 && this.hasHit) alpha = Math.max(0, 1 - (t - 0.9) / 0.1);
    R.drawBulletSprite(this.spriteName, this.x, this.y, 1, alpha, this.color, this.facing);
  }
}

// ==================== 垂直弹幕 FX (每支箭落地触发独立hit环) ====================
class VerticalBulletFX {
  constructor(animName, x, startY, targetY, color, frameDuration, hasHit = true, stagger = 0) {
    const anim = getAnim(animName);
    this.spriteName = anim?.sprite || animName;
    this.x = x;
    this.startY = startY;
    this.targetY = targetY; // 落地位置（地面线）
    this.y = startY;
    this.color = color;
    this.hasHit = hasHit;
    this.stagger = stagger;
    this.elapsed = -stagger;
    this.totalDuration = frameDuration * 0.55;
    this.done = false;
    this.facing = 1;
    this.explosionAnim = anim?.explosion || null;
    this._hitSpawned = false; // 确保每支箭只触发一次命中环
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed < 0) return;
    const t = Math.min(1, this.elapsed / this.totalDuration);
    // ease-in (加速下落)
    const ease = t * t;
    this.y = this.startY + (this.targetY - this.startY) * ease;
    if (t >= 1) {
      // 落地瞬间：触发小爆炸环（每支箭独立）
      if (!this._hitSpawned && this.hasHit) {
        this._hitSpawned = true;
        FX.active.push(new HitRingFX('hitExplosion', this.x, this.targetY, this.color, 0));
        // 火球还有额外的大爆炸
        if (this.explosionAnim) {
          FX.active.push(new ExplosionRingFX(this.explosionAnim, this.x, this.targetY, this.color, 0));
        }
      }
      this.done = true;
    }
  }

  render(ctx, R) {
    if (this.elapsed < 0) return;
    const alpha = this.elapsed < 40 ? this.elapsed / 40 : 1;
    R.drawBulletSprite(this.spriteName, this.x, this.y, 1, alpha, this.color, this.facing);
  }
}

// ==================== 命中像素圈 FX (像素风：方框扩圈 + 方块粒子) ====================
class HitRingFX {
  constructor(animName, x, y, color, stagger = 0) {
    const anim = getAnim(animName);
    this.x = x;
    this.y = y;
    this.color = anim?.color || color;
    this.particleColor = anim?.particleColor || this.color;
    this.ringStart = anim?.ringStartSize || 0.1;
    this.ringEnd = anim?.ringEndSize || 0.6;
    this.fadeTime = anim?.fadeTime || 350;
    this.particleCount = anim?.particles || 10;
    this.particleSpread = anim?.particleSpread || 5;
    this.stagger = stagger;
    this.elapsed = -stagger;
    this.done = false;
    this.particles = [];
    for (let i = 0; i < this.particleCount; i++) {
      const angle = (Math.PI * 2 * i) / this.particleCount + (Math.random() - 0.5) * 0.5;
      const speed = 2 + Math.random() * this.particleSpread;
      this.particles.push({ angle, speed, life: 0.6 + Math.random() * 0.4 });
    }
    // 预计算像素圈路径（方形像素环）
    this._pixelRingSize = 2; // 像素块大小
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed < 0) return;
    if (this.elapsed >= this.fadeTime) this.done = true;
  }

  /** 绘制像素化方框环 */
  _drawPixelRing(ctx, cx, cy, radius, alpha) {
    const ps = this._pixelRingSize;
    // 用 step 量化半径，产生像素锯齿感
    const step = ps * 1.5;
    const snappedR = Math.floor(radius / step) * step;
    if (snappedR < step) return;
    // 在 snappedR ± step 范围内绘制像素方块（多条错位像素环）
    for (let offset = -step; offset <= step; offset += step) {
      const r = snappedR + offset;
      if (r <= 0) continue;
      const circ = Math.floor(2 * Math.PI * r / step);
      const skipChance = offset === 0 ? 0.2 : 0.5;
      for (let i = 0; i < circ; i++) {
        if (Math.random() < skipChance) continue;
        const a = (i / circ) * Math.PI * 2;
        const px = Math.floor((cx + Math.cos(a) * r) / step) * step;
        const py = Math.floor((cy + Math.sin(a) * r) / step) * step;
        ctx.fillStyle = this.color;
        ctx.globalAlpha = alpha * 0.8;
        ctx.fillRect(px, py, ps, ps);
      }
    }
  }

  render(ctx, R) {
    if (this.elapsed < 0) return;
    const t = Math.min(1, this.elapsed / this.fadeTime);
    const alpha = 1 - t;
    const ringRadius = (this.ringStart + (this.ringEnd - this.ringStart) * t) * R.cellW;
    ctx.save();

    // 像素风方框环（替代圆环）
    this._drawPixelRing(ctx, this.x, this.y, ringRadius, alpha);

    // 像素粒子：飞出的像素方块
    for (const p of this.particles) {
      const pLife = Math.min(1, this.elapsed / (this.fadeTime * p.life));
      const pAlpha = 1 - pLife;
      const dist = pLife * R.cellW * this.particleSpread;
      const px = this.x + Math.cos(p.angle) * dist;
      const py = this.y + Math.sin(p.angle) * dist;
      // 像素风：用 step 量化位置
      const ps = 3;
      const sx = Math.floor(px / ps) * ps;
      const sy = Math.floor(py / ps) * ps;
      ctx.fillStyle = this.particleColor;
      ctx.globalAlpha = pAlpha * 0.9;
      ctx.fillRect(sx, sy, ps, ps);
    }
    ctx.restore();
  }
}

// ==================== 弹幕碰撞碎片 FX（碰撞瞬间飞溅的像素碎片） ====================
class BulletClashFragmentFX {
  /**
   * @param {number} x - 碰撞像素X坐标
   * @param {number} y - 碰撞像素Y坐标
   * @param {string} color - 碎片颜色
   */
  constructor(x, y, color = '#ffff00') {
    this.x = x;
    this.y = y;
    this.color = color;
    this.duration = 300; // ms
    this.elapsed = 0;
    this.done = false;
    // 生成 6-10 个随机方向的碎片
    const count = 6 + Math.floor(Math.random() * 5);
    this.fragments = [];
    for (let i = 0; i < count; i++) {
      this.fragments.push({
        angle: Math.random() * Math.PI * 2,
        speed: 2 + Math.random() * 6,
        size: 2 + Math.floor(Math.random() * 4),
        life: 0.5 + Math.random() * 0.5
      });
    }
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.duration) this.done = true;
  }

  render(ctx, R) {
    if (this.elapsed >= this.duration) return;
    const t = Math.min(1, this.elapsed / this.duration);
    // ease-out 减速
    const moveEase = 1 - Math.pow(1 - t, 3);
    const alpha = 1 - t;

    for (const f of this.fragments) {
      const dist = moveEase * R.cellW * f.speed * 0.7;
      const px = this.x + Math.cos(f.angle) * dist;
      const py = this.y + Math.sin(f.angle) * dist;
      const ps = f.size;
      ctx.save();
      ctx.globalAlpha = alpha * 0.8;
      ctx.fillStyle = this.color;
      // 像素风量化
      const sx = Math.floor(px / 3) * 3;
      const sy = Math.floor(py / 3) * 3;
      ctx.fillRect(sx, sy, ps, ps);
      ctx.restore();
    }
  }
}

// ==================== 爆炸扩圈 FX (纯像素风：像素方框扩圈 + 乱飞方块粒子) ====================
class ExplosionRingFX {
  constructor(animName, x, y, color, stagger = 0) {
    const anim = getAnim(animName);
    this.x = x;
    this.y = y;
    this.color = anim?.color || color;
    this.particleColor = anim?.particleColor || this.color;
    this.spriteName = anim?.sprite || null;
    this.ringStart = anim?.ringStartSize || 0.15;
    this.ringEnd = anim?.ringEndSize || 1.5;
    this.fadeTime = anim?.fadeTime || 600;
    this.particleCount = anim?.particles || 24;
    this.particleSpread = anim?.particleSpread || 12;
    this.stagger = stagger;
    this.elapsed = -stagger;
    this.done = false;
    this.facing = 1;
    this.particles = [];
    for (let i = 0; i < this.particleCount; i++) {
      const angle = (Math.PI * 2 * i) / this.particleCount + (Math.random() - 0.5) * 0.4;
      const speed = 3 + Math.random() * this.particleSpread;
      // 随机决定粒子是方形还是长条
      const pW = 2 + Math.floor(Math.random() * 4);
      const pH = 2 + Math.floor(Math.random() * 4);
      this.particles.push({ angle, speed, life: 0.4 + Math.random() * 0.6, pw: pW, ph: pH });
    }
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed < 0) return;
    if (this.elapsed >= this.fadeTime) this.done = true;
  }

  /** 像素方框环 */
  _drawPixelRing(ctx, cx, cy, radius, alpha) {
    const step = 4;
    const snappedR = Math.floor(radius / step) * step;
    if (snappedR < step) return;
    // 多层错位像素环，产生厚重爆炸感
    for (let offset = -step * 1.5; offset <= step * 1.5; offset += step) {
      const r = snappedR + offset;
      if (r <= 0) continue;
      const circ = Math.floor(2 * Math.PI * r / step);
      for (let i = 0; i < circ; i++) {
        if (Math.random() < 0.35) continue; // 随机空缺
        const a = (i / circ) * Math.PI * 2;
        const px = Math.floor((cx + Math.cos(a) * r) / step) * step;
        const py = Math.floor((cy + Math.sin(a) * r) / step) * step;
        ctx.fillStyle = this.color;
        ctx.globalAlpha = alpha * 0.7;
        ctx.fillRect(px, py, step * 0.7, step * 0.7);
      }
    }
  }

  render(ctx, R) {
    if (this.elapsed < 0) return;
    const t = Math.min(1, this.elapsed / this.fadeTime);
    const alpha = t < 0.3 ? 1 : Math.max(0, 1 - (t - 0.3) / 0.7);
    const ringRadius = (this.ringStart + (this.ringEnd - this.ringStart) * t) * R.cellW;
    ctx.save();

    // 像素扩圈
    this._drawPixelRing(ctx, this.x, this.y, ringRadius, alpha);

    // 中心像素字符画（如果有）
    if (this.spriteName) {
      const sprScale = 1 + t * 1.0;
      const sprAlpha = t < 0.2 ? t / 0.2 : Math.max(0, 1 - (t - 0.2) / 0.8);
      ctx.globalAlpha = sprAlpha;
      R.drawBulletSprite(this.spriteName, this.x, this.y, sprScale, sprAlpha, this.color, this.facing);
    }

    // 像素粒子：飞出的像素方块（大小不一）
    for (const p of this.particles) {
      const pLife = Math.min(1, this.elapsed / (this.fadeTime * p.life));
      const pAlpha = 1 - pLife;
      const dist = pLife * R.cellW * this.particleSpread * 1.2;
      const px = this.x + Math.cos(p.angle) * dist;
      const py = this.y + Math.sin(p.angle) * dist;
      ctx.fillStyle = this.particleColor;
      ctx.globalAlpha = pAlpha * 0.9;
      ctx.fillRect(px - p.pw / 2, py - p.ph / 2, p.pw, p.ph);
    }
    ctx.restore();
  }
}

// ==================== 伤害跳字 FX (像素风数字，上飘淡出) ====================
class DamageTextFX {
  /**
   * @param {number} x - 像素X坐标
   * @param {number} y - 像素Y坐标
   * @param {number} dmg - 伤害值
   * @param {string} color - 数字颜色
   */
  constructor(x, y, dmg, color = '#ff4444') {
    // 位置加随机偏移
    this.x = x + (Math.random() - 0.5) * 30;
    this.y = y - 10 + (Math.random() - 0.5) * 20;
    this.dmg = Math.floor(dmg);
    this.color = color;
    this.duration = 700; // 持续时间 ms
    this.elapsed = 0;
    this.done = false;
    // 随机水平偏移方向
    this.driftX = (Math.random() - 0.5) * 20;
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.duration) this.done = true;
  }

  render(ctx, R) {
    if (this.elapsed >= this.duration) return;
    const t = this.elapsed / this.duration;
    // 上飘
    const offsetY = -30 * t;
    // 淡出（前10%闪烁，之后渐隐）
    let alpha;
    if (t < 0.1) alpha = t / 0.1;
    else alpha = Math.max(0, 1 - (t - 0.1) / 0.9);
    // 微缩放
    const scale = 1 + t * 0.2;

    const px = this.x + this.driftX * t;
    const py = this.y + offsetY;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(px, py);
    ctx.scale(scale, scale);

    // 像素风字体：用 fillRect 画数字
    this._drawPixelNumber(ctx, this.dmg, this.color);

    ctx.restore();
  }

  /** 简易像素数字渲染（5x3 像素网格） */
  _drawPixelNumber(ctx, num, color) {
    const ps = 3; // 像素块大小
    const digits = String(num).split('');
    const digitW = 4; // 每位数字宽度（像素块单位）
    const totalW = digits.length * (digitW + 1) * ps;
    const startX = -totalW / 2;

    digits.forEach((ch, di) => {
      const glyph = this._digitGlyph(ch);
      if (!glyph) return;
      const ox = startX + di * (digitW + 1) * ps;
      for (let row = 0; row < glyph.length; row++) {
        for (let col = 0; col < glyph[row].length; col++) {
          if (glyph[row][col] === '#') {
            ctx.fillStyle = color;
            ctx.fillRect(ox + col * ps, -10 + row * ps, ps, ps);
          }
        }
      }
    });
  }

  /** 5x7 像素数字字模 */
  _digitGlyph(ch) {
    const glyphs = {
      '0': [' ### ', '#   #','#   #','#   #','#   #','#   #',' ### '],
      '1': ['  #  ',' ##  ','  #  ','  #  ','  #  ','  #  ','#####'],
      '2': [' ### ','#   #','    #','   # ','  #  ',' #   ','#####'],
      '3': [' ### ','#   #','    #','  ## ','    #','#   #',' ### '],
      '4': ['#   #','#   #','#   #','#####','    #','    #','    #'],
      '5': ['#####','#    ','#    ','#### ','    #','#   #',' ### '],
      '6': [' ### ','#    ','#    ','#### ','#   #','#   #',' ### '],
      '7': ['#####','    #','   # ','  #  ',' #   ','#    ','#    '],
      '8': [' ### ','#   #','#   #',' ### ','#   #','#   #',' ### '],
      '9': [' ### ','#   #','#   #',' ####','    #','    #',' ### '],
    };
    return glyphs[ch] || glyphs['0'];
  }
}

// ==================== 像素残影 FX（角色移动时身后留下半透明残影） ====================
class AfterimageFX {
  /**
   * @param {string} charId   - 角色 ID，用于获取颜色和形状
   * @param {number} fromX    - 像素起点
   * @param {number} toX      - 像素终点
   * @param {number} y        - 角色脚底像素 Y（Renderer.baseY）
   * @param {number} duration - 整个位移持续时间 ms
   * @param {object} getActorPos - { getX: () => pixelX, getFacing: () => ±1 } 实时位置
   */
  constructor(charId, fromX, toX, y, duration, getActorPos) {
    this.charDef = getCharDef(charId) || { color:'#ffffff', shape:'square', size:18 };
    this.fromX = fromX;
    this.toX = toX;
    this.y = y;
    this.duration = duration;
    this.getActorPos = getActorPos;
    this.elapsed = 0;
    this.done = false;
    // 残影列表：{ x, facing, life, maxLife }
    this.images = [];
    this._lastSnapshotX = fromX;
    this._snapInterval = 25; // 每 25ms 拍一个残影
    this._snapAccum = 0;
    const facing = getActorPos ? getActorPos.getFacing() : 1;
    this.images.push({ x: fromX, facing, life: 250, maxLife: 250 });
  }

  update(dt) {
    this.elapsed += dt;
    if (this.elapsed >= this.duration + 600) { this.done = true; return; }

    // 持续在角色当前位置拍残影
    if (this.getActorPos && this.elapsed < this.duration + 200) {
      this._snapAccum += dt;
      const currentX = this.getActorPos.getX();
      const currentFacing = this.getActorPos.getFacing();
      if (currentX !== null && Math.abs(currentX - this._lastSnapshotX) > 1) {
        while (this._snapAccum >= this._snapInterval) {
          this._snapAccum -= this._snapInterval;
          this.images.push({ x: currentX, facing: currentFacing, life: 250, maxLife: 250 });
          this._lastSnapshotX = currentX;
        }
      }
    }

    // 更新残影生命
    for (let i = this.images.length - 1; i >= 0; i--) {
      this.images[i].life -= dt;
      if (this.images[i].life <= 0) this.images.splice(i, 1);
    }
  }

  render(ctx, R) {
    if (this.images.length === 0) return;
    const cd = this.charDef;
    for (const img of this.images) {
      const lifeT = img.life / img.maxLife;
      const alpha = lifeT * 0.45; // 最大 45% 透明度
      if (alpha < 0.02) continue;
      const scale = 0.7 + lifeT * 0.3; // 逐渐缩小
      Sprites.drawCharacter(ctx, cd, img.x, this.y, cd.size * scale, img.facing, alpha);
    }
  }
}

// ==================== 突击盾金色冲锋光环 FX ====================
// 角色 dash 时始终跟随的金色像素画光环
class DashChargeFX {
  /**
   * @param {string} spriteName - bulletSprites 中的精灵名
   * @param {string} color      - 覆盖颜色
   * @param {number} fromX      - 起始像素 X
   * @param {number} toX        - 终点像素 X
   * @param {number} y          - Y 坐标
   * @param {number} duration   - 持续时间 ms
   * @param {object} getActorPos - { getX: () => pixelX, getFacing: () => ±1 }
   */
  constructor(spriteName, color, fromX, toX, y, duration, getActorPos) {
    this.sprite = getBulletSprite(spriteName);
    this.color = color || '#ffcc00';
    this.fromX = fromX;
    this.toX = toX;
    this.y = y;
    this.duration = duration;
    this.getActorPos = getActorPos;
    this.elapsed = 0;
    this.done = false;
    // 闪烁脉冲
    this._pulsePhase = 0;
  }

  update(dt) {
    this.elapsed += dt;
    this._pulsePhase += dt * 0.01;
    if (this.elapsed > this.duration + 400) {
      this.done = true;
    }
  }

  render(ctx, R) {
    if (!this.sprite || this.elapsed > this.duration + 300) return;

    // 获取角色实时位置
    let currentX = this.toX;
    let facing = 1;
    if (this.getActorPos) {
      currentX = this.getActorPos.getX() ?? currentX;
      facing = this.getActorPos.getFacing() ?? facing;
    }

    // 闪烁脉冲 alpha：0.35 ~ 0.85
    const pulse = 0.6 + 0.25 * Math.sin(this._pulsePhase);
    // 开始和结束时淡入淡出
    let fadeAlpha = 1;
    const fadeIn = 80, fadeOut = 250;
    if (this.elapsed < fadeIn) fadeAlpha = this.elapsed / fadeIn;
    else if (this.elapsed > this.duration - fadeOut) {
      fadeAlpha = Math.max(0, (this.duration - this.elapsed) / fadeOut);
    }
    const alpha = pulse * fadeAlpha;

    const size = this.sprite.w * 2.5; // 像素画放大到合适大小
    const offsetX = currentX - (this.sprite.w * 1.25);
    const offsetY = this.y - size * 0.75;

    ctx.save();
    ctx.globalAlpha = alpha;

    // 绘制像素画
    for (let row = 0; row < this.sprite.h; row++) {
      for (let col = 0; col < this.sprite.w; col++) {
        const ch = this.sprite.pixels[row][col];
        if (ch !== ' ' && ch !== '.') {
          const px = offsetX + col * 2.5;
          const py = offsetY + row * 2.5;
          // 水平翻转跟随 facing
          const drawX = facing === -1
            ? currentX + (this.sprite.w * 1.25) - (col + 1) * 2.5
            : px;
          ctx.fillStyle = this.color;
          ctx.fillRect(drawX, py, 2.5, 2.5);
        }
      }
    }

    ctx.restore();
  }
}

// ==================== Buff 像素粒子发射器 FX ====================
// 角色身上源源不断的像素粒子效果
class BuffEmitterFX {
  constructor(animName, x, y) {
    const anim = getAnim(animName);
    this.x = x;
    this.y = y;
    this.color = anim?.color || '#4488ff';
    this.emissionRate = anim?.emissionRate || 4;
    this.particleLife = anim?.particleLife || 600;
    this.spread = anim?.spread || 3;
    this.elapsed = 0;
    this.done = false;
    this.particles = [];
    this.emissionAccum = 0;
  }

  update(dt) {
    this.elapsed += dt;
    this.emissionAccum += dt * (this.emissionRate / 1000);
    while (this.emissionAccum >= 1) {
      this.emissionAccum -= 1;
      const pw = 2 + Math.floor(Math.random() * 3);
      const ph = 2 + Math.floor(Math.random() * 3);
      this.particles.push({
        angle: Math.random() * Math.PI * 2,
        speed: 1 + Math.random() * this.spread,
        life: this.particleLife * (0.5 + Math.random() * 0.5),
        elapsed: 0,
        pw, ph
      });
    }
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
      ctx.fillRect(px - p.pw / 2, py - p.ph / 2, p.pw, p.ph);
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
  mySlotIndex: null, // 我在房间中的槽位索引
  myCharId: null,
  mySkillIds: [],
  myCustomSkills: {},
  p1: null,          // 当前帧 p1 数据
  p2: null,          // 当前帧 p2 数据
  bases: null,       // 基地数据 {p1:{hp,maxHp}, p2:{hp,maxHp}}
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
  _roomSlots: [],    // 房间槽位列表
  _roomHostId: null, // 房主sid

  // ---- 音乐引擎关联 ----
  _musicReady: false,       // 音乐引擎是否已初始化
  _musicLoopSync: false,    // 是否在等待循环结束再进入战斗
  _musicPendingBattle: false, // 是否有待处理的战斗开始（等音乐循环）
  _musicBeatDriven: false,  // 是否使用节拍驱动步进（替代独立计时器）
  _musicReadyForFrames: false, // 音乐循环已结束，等待 battleFrames
  _pendingOnlineResult: null, // 联机模式暂存的战斗结果
  _pendingBattleFrames: null, // AI/训练模式暂存的 battleFrames 数据

  reset() {
    this.p1 = null; this.p2 = null; this.bases = null; this.actions = [];
    this.round = 0; this.timeLeft = 60; this.tick = 0;
    this.p1Actions = []; this.p2Actions = [];
    this._cooldowns = {}; this._snapshots = [];
    this._battleFrames = null; this._battleFinal = null;
    this._battleStep = null; this._battleGameOver = false;
    this._originP1 = null; this._originP2 = null;
    this._originBases = null;
    this._renderP1 = null; this._renderP2 = null;
    this._pendingCreate = null; this._pendingJoin = null;
    this._mode = 'prepare';
    this._roomSlots = [];
    this._roomHostId = null;
    this.mySlotIndex = null;
    this._onBattleEnd = null; // 联机模式战斗播放结束回调

    // 音乐状态重置
    this._musicLoopSync = false;
    this._musicPendingBattle = false;
    this._musicBeatDriven = false;
    this._musicReadyForFrames = false;
    this._pendingOnlineResult = null;
    this._pendingBattleFrames = null;
    this._tickIdx = 0;
    this._beatAccum = 0;

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

  updateBaseHUD(bases) {
    if (!bases) return;
    const b1hp = document.getElementById('b1hp');
    const b1hpt = document.getElementById('b1hpt');
    const b2hp = document.getElementById('b2hp');
    const b2hpt = document.getElementById('b2hpt');
    if (b1hp && bases.p1) {
      b1hp.style.width = Math.max(0, bases.p1.hp / bases.p1.maxHp * 100) + '%';
      if (b1hpt) b1hpt.textContent = `${bases.p1.hp}/${bases.p1.maxHp}`;
    }
    if (b2hp && bases.p2) {
      b2hp.style.width = Math.max(0, bases.p2.hp / bases.p2.maxHp * 100) + '%';
      if (b2hpt) b2hpt.textContent = `${bases.p2.hp}/${bases.p2.maxHp}`;
    }
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

    // 构建 skill1/2/3 → 技能名称的映射
    const p1SkillMap = {};
    const p1Skills = G.p1?.skills || G.mySkillIds || [];
    p1Skills.forEach((sid, i) => { p1SkillMap['skill' + (i + 1)] = sid; });
    const p2SkillMap = {};
    const p2Skills = G.p2?.skills || [];
    p2Skills.forEach((sid, i) => { p2SkillMap['skill' + (i + 1)] = sid; });

    const renderRow = (el, actions, currentIdx, skillMap) => {
      el.innerHTML = '';
      for (let i = 0; i < 16; i++) {
        const slot = document.createElement('span');
        slot.className = 'bq-slot' + (i === currentIdx ? ' active' : '');
        const a = actions[i] || 'wait';
        if (a === 'wait') { slot.textContent = '·'; }
        else if (a === 'stunned') { slot.textContent = '⚡'; }
        else {
          // 尝试 skill1/2/3 → 真实技能ID → 技能名
          const realId = skillMap[a] || a;
          const sk = getSkillById(realId);
          const gs = (_skillsData?.genericSkills || []).find(g => g.id === a);
          const name = sk?.name || gs?.name || null;
          if (name) {
            slot.textContent = name;
          } else {
            // fallback：显示简短标识
            const shortMap = {
              move_left: '←', move_right: '→', dodge_left: '⇐', dodge_right: '⇒',
              defend: '🛡', turn: '↻', wait: '·', stunned: '⚡'
            };
            slot.textContent = shortMap[a] || a;
          }
        }
        el.appendChild(slot);
      }
    };
    renderRow(p1El, p1Acts, tick, p1SkillMap);
    renderRow(p2El, p2Acts, tick, p2SkillMap);
  }
};

// ==================== Socket 事件处理 ====================
function setupSocket() {
  if (G.socket) { G.socket.removeAllListeners(); G.socket.disconnect(); }
  G.socket = io();

  G.socket.on('connect', () => {
    if (G._pendingCreate) { G.socket.emit('createRoom', G._pendingCreate); G._pendingCreate = null; }
    if (G._pendingJoin) { G.socket.emit('joinRoom', G._pendingJoin); G._pendingJoin = null; }
    if (G._pendingLobbyRefresh) { G.socket.emit('getRoomList'); G._pendingLobbyRefresh = false; }
  });

  // 联机战斗事件（在 enterRoomUI / toggleReady 触发开始后激活）
  bindOnlineBattleEvents();

  // --- 大厅事件 ---
  G.socket.on('roomList', (list) => {
    renderRoomList(list);
  });

  G.socket.on('roomListUpdate', (data) => {
    // 局部更新：刷新整个大厅列表最简单
    if (G.socket) G.socket.emit('getRoomList');
  });

  G.socket.on('roomListRemove', (data) => {
    if (G.socket) G.socket.emit('getRoomList');
  });

  // --- 房间事件 ---
  G.socket.on('roomCreated', (d) => {
    G.roomId = d.roomId;
    G.mySlotIndex = d.slotIndex;
    G._roomSlots = d.slots;
    G._roomHostId = d.hostId;
    enterRoomUI();
  });

  G.socket.on('roomJoined', (d) => {
    G.roomId = d.roomId;
    G.mySlotIndex = d.slotIndex;
    G._roomSlots = d.slots;
    G._roomHostId = d.hostId;
    enterRoomUI();
  });

  G.socket.on('playerJoined', (d) => {
    G._roomSlots = d.slots;
    renderRoomSlots();
  });

  G.socket.on('slotsUpdated', (d) => {
    G._roomSlots = d.slots;
    G._roomHostId = d.hostId;
    renderRoomSlots();
  });

  G.socket.on('err', (d) => { alert(d.msg); });
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
    const isTraining = G.mode === 'train';

    // 消耗资源（训练场跳过）
    if (!isTraining) {
      const hasMp = (p1.mp || 0) >= (sk.mpCost || 0);
      const hasSp = (p1.sp || 0) >= (sk.spCost || 0);
      if (!hasMp || !hasSp) {
        events.push({ type: 'exhausted', actor: 'p1', skillId: sid });
        return events;
      }
      p1.mp -= (sk.mpCost || 0);
      p1.sp -= (sk.spCost || 0);
      if (sk.cooldown) G._cooldowns[sid] = sk.cooldown;
    }

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

        // ★ 近战弹幕：中心格 = 攻击范围的中心
        let centerGX = p1.x;
        if (sk.direction === 'forward') {
          const midOffset = Math.floor((rg + 1) / 2);
          centerGX = p1.x + dir * midOffset;
        }
        events.push({ type: 'melee_slash', actor: 'p1', skillId: sid,
          bullet_anim: sk.anim_bullet || 'meleeSwing', bullet_color: sk.color, bullet_x: centerGX, facing: dir });
        DBG.log(`[FX] melee bullet center at grid=${centerGX} anim=${sk.anim_bullet}`);

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
        const shots = sk.multiShot || 1;
        let anyHit = false;
        for (let s = 0; s < shots; s++) {
          let hitDone = false;
          for (let scan = 1; scan <= range; scan++) {
            const sx = p1.x + dir * scan;
            if (sx < 0 || sx > 15) break;
            if (sx === target.x && !anyHit) {
              const dmg = Math.max(1, Math.floor((p1.atk || 10) * (sk.damageRatio || 1) - (target.def || 0)));
              if (!isEditStep) target.hp = Math.max(0, target.hp - dmg);
              const evT = sk.effect === 'freeze_damage' ? 'freeze_hit' : (sk.effect === 'poison_debuff' ? 'poison_hit' : 'bullet_hit');
              events.push({ type: evT, actor: 'p1', target: 'p2', dmg, x: sx, skillId: sid,
                bullet_anim: sk.anim_bullet || 'arrowFly', hit_anim: sk.anim_hit || 'hitExplosion',
                bullet_color: sk.color, bullet_from: p1.x, bullet_to: sx, facing: dir });
              DBG.log(`[HIT] projectile dmg=${dmg} from=${p1.x} to=${sx} bullet_anim=${sk.anim_bullet} hit_anim=${sk.anim_hit} shot=${s}`);
              hitDone = true; anyHit = true; break;
            }
          }
          if (!hitDone) {
            const maxX = Math.max(0, Math.min(15, p1.x + dir * range));
            events.push({ type: 'bullet_trail', actor: 'p1', skillId: sid,
              bullet_anim: sk.anim_bullet || 'arrowFly', bullet_color: sk.color,
              bullet_from: p1.x, bullet_to: maxX, bullet_faded: true, facing: dir });
            DBG.log(`[TRAIL] bullet flew to max range ${maxX} bullet_anim=${sk.anim_bullet} shot=${s}`);
          }
        }
        break;
      }
      case 'targeted_aoe': {
        const aoeR = sk.aoeRadius || 1;
        const tX = target.x;
        // 伤害判定（仅目标格）
        const dmg = Math.max(1, Math.floor((p1.atk || 10) * (sk.damageRatio || 1) - (target.def || 0)));
        if (!isEditStep) target.hp = Math.max(0, target.hp - dmg);
        const evT = sk.effect === 'burn_debuff' ? 'burn_hit' : 'aoe_hit';
        events.push({ type: evT, actor: 'p1', target: 'p2', dmg, x: tX, skillId: sid,
          bullet_anim: sk.anim_bullet || 'arrowRainDrop', hit_anim: sk.anim_hit || 'hitAOE', bullet_color: sk.color });
        DBG.log(`[HIT] aoe dmg=${dmg} at x=${tX} bullet_anim=${sk.anim_bullet}${isEditStep?' (edit: no dmg)':''}`);
        if (!isEditStep && sk.effect === 'burn_debuff') { target._effects = target._effects || []; target._effects.push({ type: 'burn', ticks: sk.burnTicks || 3, dmgPerTick: Math.max(1, Math.floor(p1.atk * (sk.burnRatio || 0.1))) }); }

        // 火球术：只落一个弹幕
        if (sk.effect === 'burn_debuff') {
          events.push({ type: 'aoe_cast', actor: 'p1', skillId: sid, x: tX,
            bullet_anim: sk.anim_bullet || 'fireballDrop', bullet_color: sk.color, bullet_noHit: false });
        } else {
          // 箭雨：多根箭接力下落
          for (let ox = -aoeR; ox <= aoeR; ox++) {
            const ax = tX + ox;
            if (ax < 0 || ax > 15) continue;
            if (ax !== tX) {
              events.push({ type: 'aoe_cast', actor: 'p1', skillId: sid, x: ax,
                bullet_anim: sk.anim_bullet || 'arrowRainDrop', bullet_color: sk.color, bullet_noHit: true });
              DBG.log(`[CAST] aoe drop at x=${ax} (no hit)`);
            }
          }
          events.push({ type: 'aoe_cast', actor: 'p1', skillId: sid, x: tX,
            bullet_anim: sk.anim_bullet || 'arrowRainDrop', bullet_color: sk.color, bullet_noHit: false });
        }
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
          const hitX = target.x; // 保存命中位置
          if (!isEditStep) target.hp = Math.max(0, target.hp - dmg);
          events.push({ type: 'dash_hit', actor: 'p1', target: 'p2', dmg, x: hitX, skillId: sid,
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
        // 金色冲锋特效：编辑阶段也需要播放
        events.push({ type: 'dash_charge', actor: 'p1', skillId: sid,
          bullet_from: oldX, bullet_to: dest, facing: dir,
          bullet_anim: 'dash_charge', bullet_color: '#ffcc00' });
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

    // 战斗阶段：不再由渲染循环驱动步进
    // 步进由 MusicEngine.onBeat 回调触发（如果音乐引擎启用）
    // 如果音乐引擎未启用，回退到原来的独立计时器模式
    if (G._mode === 'battle' && G._battleStep && !G._musicBeatDriven) {
      // 回退模式：使用性能计时器（FRAME_DURATION）
      G._battleStep();
    }

    FX.update(dt);
    Tween.update();

    Renderer.resize();
    Renderer.drawGrid();

    // 画玩家
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
    if (G.bases) UI.updateBaseHUD(G.bases);
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
    // 编辑阶段位移残影
    const getPos = { getX: () => G._renderP1 ? G._renderP1.x : toPX, getFacing: () => G.p1.facing };
    FX.active.push(new AfterimageFX(G.p1.charId, fromPX, toPX, Renderer.baseY, 400, getPos));
    DBG.log('[TWEEN] 编辑阶段P1位移缓动 grid='+oldP1X+'->'+G.p1.x);
  }

  // 步进后 tick 资源回复
  G.tickResources();
  G.tick++;

  // 从事件生成动画特效（编辑阶段：只播放弹幕/位移动画，不播放命中特效和音效）
  const isEdit = G._mode === 'prepare';

  // 编辑阶段：剥离命中特效，只保留弹幕飞行/施法/位移
  let filteredEvents = events;
  if (isEdit) {
    filteredEvents = [];
    for (const ev of events) {
      // 命中类事件：剥离命中部分，转为纯弹幕飞行/施法事件
      if (ev.type === 'bullet_hit' || ev.type === 'freeze_hit' || ev.type === 'poison_hit') {
        // 平射弹幕命中 → 转为 bullet_trail（弹幕飞到命中点消失）
        if (ev.bullet_anim) {
          filteredEvents.push({
            type: 'bullet_trail',
            actor: ev.actor, skillId: ev.skillId,
            bullet_anim: ev.bullet_anim,
            bullet_color: ev.bullet_color,
            bullet_from: ev.bullet_from, bullet_to: ev.bullet_to,
            bullet_faded: true
          });
        }
      } else if (ev.type === 'burn_hit' || ev.type === 'aoe_hit') {
        // AOE 命中 → 保留 aoe_cast（火球/箭雨下落）
        // aoe_cast 已经在 LocalStep 中单独生成，burn_hit/aoe_hit 只含命中数据，跳过
      } else if (ev.type === 'melee_hit' || ev.type === 'stun_hit' ||
                 ev.type === 'backstab_hit' || ev.type === 'dash_hit' ||
                 ev.type === 'collision' || ev.type === 'base_hit' ||
                 ev.type === 'knockback' || ev.type === 'bullet_clash' ||
                 ev.type === 'burn_tick' || ev.type === 'poison_tick') {
        // 纯命中/碰撞事件：直接跳过
      } else if (ev.type === 'dodged') {
        // 闪避：保留拖尾动画但去掉音效（spawnFromEvent 的 isEdit 会跳过音效）
        filteredEvents.push(ev);
      } else {
        // 其他事件保留（melee_slash, bullet_trail, bullet_trail_cut, aoe_cast, dash, dash_charge, teleport, move, turn, defend 等）
        filteredEvents.push(ev);
      }
    }

    // 为弹幕/施法事件添加 stagger 错时（箭雨多箭、连射等）
    const staggerTypes = ['bullet_trail','bullet_trail_cut','aoe_cast','melee_slash','dash','dash_charge','teleport'];
    const staggerEvents = filteredEvents.filter(ev => staggerTypes.includes(ev.type));
    const nonStaggerEvents = filteredEvents.filter(ev => !staggerTypes.includes(ev.type));

    let staggerCount = 0;
    for (const ev of staggerEvents) {
      const anim = getAnim(ev.bullet_anim || ev.hit_anim);
      const interval = anim?.stagger || 0;
      if (interval > 0 && staggerEvents.length > 1) {
        ev._stagger = staggerCount * interval;
        staggerCount++;
      } else {
        ev._stagger = 0;
      }
    }
    staggerEvents.sort((a, b) => (a._stagger || 0) - (b._stagger || 0));
    filteredEvents = [...nonStaggerEvents, ...staggerEvents];
  }

  for (const ev of filteredEvents) {
    FX.spawnFromEvent(ev, 600, G.p1, G.p2, isEdit);
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
  while (G._snapshots.length > 0) G.restoreSnapshot();
  if (G._originP1) { G.p1 = JSON.parse(JSON.stringify(G._originP1)); }
  if (G._originP2) { G.p2 = JSON.parse(JSON.stringify(G._originP2)); }
  G._cooldowns = {};
  G.tick = 0;
  G.actions = [];
  G._snapshots = [];
  G._renderP1 = null;  // 清除缓动渲染位置
  G._renderP2 = null;
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
  FX.clear();
  G._renderP1 = null;  // 清除缓动渲染位置
  G._renderP2 = null;
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
  if (G.mode === 'ai' || G.mode === 'train') {
    if (G.socket) {
      G.socket.emit('updateActions', { actions: G.actions });
      G.socket.emit('ready');
    }
  } else if (G.socket && G.roomId) {
    G.socket.emit('updateActions', { actions: G.actions });
    G.socket.emit('ready');
  }
  document.getElementById('rdyBtn').disabled = true;

  // 如果音乐引擎正在运行，标记等待循环完成后进入战斗
  if (G._musicReady && MusicEngine.isRunning) {
    G._musicLoopSync = true;
    G._musicPendingBattle = true;
    UI.log('已准备，等待音乐循环结束...');
  } else {
    UI.log('已准备，等待对手...');
  }
}

function quitBattle() {
  if (G._musicReady && MusicEngine.isRunning) {
    MusicEngine.stop();
  }
  if (G.socket) G.socket.emit('leaveRoom');
  G.reset();
  nav('menu');
}

// ==================== 联机战斗事件 ====================
/**
 * 绑定联机战斗相关的 socket 事件。
 * 联机模式流程：
 *   1. 房间内双方选角色+准备 → 服务端发 prepareStart → 进入编排界面
 *   2. 玩家编排序列+点"完成" → 发 updateActions + ready → 服务端运算
 *   3. 服务端发 onlineBattleResult → 播放帧回放
 */
function bindOnlineBattleEvents() {
  if (!G.socket) return;

  G.socket.off('prepareStart');
  G.socket.off('onlineBattleResult');
  G.socket.off('opponentDisconnected');
  G.socket.off('roomForceClosed');

  G.socket.on('prepareStart', (d) => {
    onOnlinePrepareStart(d);
  });

  G.socket.on('onlineBattleResult', (d) => {
    onOnlineBattleResult(d);
  });

  G.socket.on('opponentDisconnected', (d) => {
    onOpponentDisconnected(d);
  });

  G.socket.on('roomForceClosed', (d) => {
    onRoomForceClosed(d);
  });
}

/** 联机模式/单人模式的 prepareStart 处理（含音乐启动） */
function onOnlinePrepareStart(d) {
  G._mode = 'prepare';
  G.round = d.round;
  G.timeLeft = d.time || 60;
  G.p1 = d.p1;
  G.p2 = d.p2;
  G.bases = d.bases || null;
  G._originP1 = JSON.parse(JSON.stringify(d.p1));
  G._originP2 = JSON.parse(JSON.stringify(d.p2));
  G._originBases = d.bases ? JSON.parse(JSON.stringify(d.bases)) : null;
  G.actions = [];
  G._cooldowns = {};
  G._snapshots = [];
  G.p1Actions = [];
  G.p2Actions = [];
  G.tick = 0;
  G._musicLoopSync = false;
  G._musicPendingBattle = false;
  G._musicBeatDriven = false;
  FX.clear();

  // 确保编辑阶段音乐（bass + hi-hat）
  if (G._musicReady) {
    if (!MusicEngine.isRunning) {
      MusicEngine.start('edit');
      console.log('[MUSIC] 编辑阶段音乐启动');
    } else if (MusicEngine.isBattleMode) {
      // 从战斗模式切回编辑模式（旋律淡出）
      MusicEngine.enterEditMode();
      console.log('[MUSIC] 切回编辑阶段音乐');
    }
  }

  updatePrepareUI();
  UI.showScreen('battle');
  UI.renderActionSlots();
  UI.renderActionButtons();
  UI.updateBaseHUD(G.bases);
  document.getElementById('actionQueuePanel').classList.remove('hidden');
  document.getElementById('battleQueuePanel').classList.add('hidden');
  document.getElementById('rdyBtn').disabled = false;
  document.getElementById('tm').textContent = G.timeLeft;
  document.getElementById('rnd').textContent = 'ROUND ' + d.round + (G.mode === 'online' ? ' (联机)' : '');

  UI.log('Round ' + d.round + ' — 编排你的序列 (' + G.timeLeft + 's)');

  startRenderLoop();
}

/**
 * 【联机/单人】收到服务端战斗结果 → 播放帧回放
 * 如果音乐引擎启用且处于编辑阶段，等待循环完成后再播放；
 * 如果音乐引擎未启用，直接播放（回退模式）
 */
function onOnlineBattleResult(d) {
  // 如果音乐引擎正在运行且我们在编辑阶段，标记等待同步
  if (G._musicReady && MusicEngine.isRunning && G._mode === 'prepare') {
    // 数据先存起来，等 handleMusicLoopComplete 触发后使用
    G._pendingOnlineResult = d;
    // readyBattle 已经设置了 _musicLoopSync 和 _musicPendingBattle
    // 如果还没设置（比如联机模式对方先准备好了），现在设置
    if (!G._musicLoopSync) {
      G._musicLoopSync = true;
      G._musicPendingBattle = true;
      UI.log('战斗结果已到达，等待音乐循环结束...');
    }
    return;
  }

  // 回退模式：直接播放
  startOnlineBattlePlayback(d);
}

function startOnlineBattlePlayback(d) {
  G._mode = 'battle';
  G._battleGameOver = d.gameOver || false;
  G._onlineResult = d;
  G.round = d.round;
  G.p1 = d.final.p1;
  G.p2 = d.final.p2;
  G.bases = d.final.bases || null;

  FX.clear();
  UI.showScreen('battle');
  document.getElementById('actionQueuePanel').classList.add('hidden');
  document.getElementById('battleQueuePanel').classList.remove('hidden');
  document.getElementById('rdyBtn').disabled = true;
  document.getElementById('rnd').textContent = 'VS ' + d.opponentName;
  document.getElementById('tm').textContent = '';

  UI.updateBaseHUD(G.bases);
  UI.log('对战 ' + d.opponentName + ' | Round ' + d.round);

  // 播放结束后的回调（仅在回退模式/联机非音乐驱动时使用）
  // 音乐驱动模式下，战斗结束由 handleMusicLoopComplete → onBattleToEditTransition 处理
  G._onBattleEnd = (final) => {
    if (G._battleGameOver) {
      if (G._musicReady) MusicEngine.stop();
      G._mode = 'result';
      FX.clear();
      if (G._renderLoop) { cancelAnimationFrame(G._renderLoop); G._renderLoop = null; }
      UI.showScreen('result');
      const w = d.winner;
      document.getElementById('rtitle').textContent = w === 'draw' ? '平局!' : (w === 'P1' ? '你获胜了!' : '你落败了');
      document.getElementById('rdetail').textContent = d.reason;
      G._onBattleEnd = null;
      G._onlineResult = null;
      return;
    }
    // 未结束，回传状态给服务端
    if (G.socket) {
      G.socket.emit('reportBattleState', {
        roomId: G.roomId,
        p1: { hp: final.p1.hp, mp: final.p1.mp, sp: final.p1.sp, x: final.p1.x, facing: final.p1.facing },
        p2: { hp: final.p2.hp, mp: final.p2.mp, sp: final.p2.sp, x: final.p2.x, facing: final.p2.facing },
        bases: {
          p1: { hp: final.bases?.p1?.hp ?? 100 },
          p2: { hp: final.bases?.p2?.hp ?? 100 }
        },
      });
    }
    UI.log('等待对方确认...');
  };

  startRenderLoop();
  playBattleAnim(d.frames, d.final);
}

/**
 * 【联机】对手断线 → 我方直接胜利
 */
function onOpponentDisconnected(d) {
  if (G._musicReady) MusicEngine.stop();
  if (G._renderLoop) { cancelAnimationFrame(G._renderLoop); G._renderLoop = null; }
  FX.clear();
  UI.showScreen('result');
  document.getElementById('rtitle').textContent = '你获胜了!';
  document.getElementById('rdetail').textContent = d.reason || '对手断开了连接';
}

/**
 * 【联机】房间被强制关闭（状态不一致等异常）
 */
function onRoomForceClosed(d) {
  if (G._musicReady) MusicEngine.stop();
  if (G._renderLoop) { cancelAnimationFrame(G._renderLoop); G._renderLoop = null; }
  FX.clear();
  G.reset();
  alert(d.reason || '房间已关闭');
  nav('menu');
}

// ==================== 战斗动画播放（音乐节拍驱动版） ====================
// FRAME_DURATION 现在从音乐引擎获取（若不可用则回退到 600ms）
function getBeatDuration() {
  if (G._musicReady && MusicEngine.beatDuration) {
    return MusicEngine.beatDuration * 1000; // 转毫秒
  }
  return 600; // 回退
}

function playBattleAnim(frames, final) {
  G._battleFrames = frames;
  G._battleFinal = final;
  FX.clear();
  G.tick = 0;
  G._renderP1 = null; G._renderP2 = null;

  // 恢复双方为本回合初始状态
  if (G._originP1) G.p1 = JSON.parse(JSON.stringify(G._originP1));
  if (G._originP2) G.p2 = JSON.parse(JSON.stringify(G._originP2));
  if (G._originBases) G.bases = JSON.parse(JSON.stringify(G._originBases));
  G._cooldowns = {};

  const beatDur = getBeatDuration();
  DBG.log('[BATTLE] 开始播放 ' + frames.length + ' 帧, beatDur=' + beatDur + 'ms, musicDriven=' + G._musicBeatDriven);

  let tickIdx = 0;
  // 回退模式专用：独立计时器
  let battleAccum = 0;
  let battleLastTime = performance.now();

  // 初始化第一帧 UI
  if (frames.length > 0) {
    G.p1Actions = frames[0].p1Actions || [];
    G.p2Actions = frames[0].p2Actions || [];
    UI.renderBattleQueue(0, G.p1Actions, G.p2Actions);
  }

  G._battleStep = () => {
    if (G._mode !== 'battle') return;

    // 回退模式：独立计时器驱动（音乐引擎不可用时）
    if (!G._musicBeatDriven) {
      const now = performance.now();
      let dt = now - battleLastTime;
      battleLastTime = now;
      if (dt > 500) dt = 16;
      battleAccum += dt;
      if (battleAccum < beatDur) {
        FX.update(Math.min(100, dt));
        Tween.update();
        return;
      }
      battleAccum -= beatDur;
    }

    if (tickIdx >= frames.length) {
      // 所有帧播完
      G.p1 = final.p1; G.p2 = final.p2;
      if (final.bases) G.bases = final.bases;
      UI.updateBaseHUD(G.bases);
      G._renderP1 = null; G._renderP2 = null;
      UI.updateHUD(G.p1, 'p1'); UI.updateHUD(G.p2, 'p2');
      UI.log('回合结束 — P1 HP:' + final.p1.hp + ' P2 HP:' + final.p2.hp + (final.bases ? ' BASE1:' + final.bases.p1.hp + ' BASE2:' + final.bases.p2.hp : ''));
      G.tick = frames.length;
      UI.renderBattleQueue(G.tick, G.p1Actions, G.p2Actions);
      DBG.log('[BATTLE] 播放完毕');
      G._battleStep = null;

      if (G._battleGameOver) {
        finishGameOver(final);
      } else if (G._musicBeatDriven) {
        // 音乐驱动模式：等待循环结束回到编辑
        G._mode = 'battle-waiting-edit';
        UI.log('等待音乐循环结束...');
      } else if (G._onBattleEnd) {
        // 回退模式：直接回调
        G._onBattleEnd(final);
        G._onBattleEnd = null;
        if (!G._battleGameOver) {
          document.getElementById('actionQueuePanel').classList.remove('hidden');
          document.getElementById('actionQueuePanel').querySelector('h3').textContent = '等待对方确认...';
          document.getElementById('rdyBtn').disabled = true;
        }
      }
      return;
    }

    // ---- 处理当前 tick 帧 ----
    const prevP1 = G.p1 ? { x: G.p1.x, facing: G.p1.facing } : null;
    const prevP2 = G.p2 ? { x: G.p2.x, facing: G.p2.facing } : null;
    const frame = frames[tickIdx];
    G.p1 = frame.p1; G.p2 = frame.p2;
    if (frame.bases) G.bases = frame.bases;
    UI.updateBaseHUD(G.bases);
    G.p1Actions = frame.p1Actions || []; G.p2Actions = frame.p2Actions || [];
    G.tick = tickIdx;

    executeTickFrame(frame, tickIdx, prevP1, prevP2, beatDur);

    FX.ensureBuffEmitter(frame.p1, 'p1');
    FX.ensureBuffEmitter(frame.p2, 'p2');
    UI.renderBattleQueue(tickIdx, G.p1Actions, G.p2Actions);

    tickIdx++;
  };

  DBG.log('[BATTLE] step函数已挂载');
}

/** 处理一个 tick 帧的所有动画（从 playBattleAnim 提取） */
function executeTickFrame(frame, tickIdx, prevP1, prevP2, beatDur) {
  const hasCollision = (frame.events || []).some(e => e.type === 'collision');
  const hasBaseHit = (frame.events || []).some(e => e.type === 'base_hit');

  if (hasBaseHit && prevP1 && prevP2 && G.p1 && G.p2) {
    const baseEv = (frame.events || []).find(e => e.type === 'base_hit');
    const actorKey = baseEv.actor;
    const actorPrev = actorKey === 'p1' ? prevP1 : prevP2;
    const actorNow = actorKey === 'p1' ? G.p1 : G.p2;
    const actorFromGrid = actorKey === 'p1' ? (frame.p1FromX ?? actorPrev.x) : (frame.p2FromX ?? actorPrev.x);

    const fromPX = Renderer.gridToPixelX(actorFromGrid);
    const dir = actorKey === 'p1' ? 1 : -1;
    const bumpPX = fromPX + dir * Renderer.cellW * 0.5;
    const finalPX = Renderer.gridToPixelX(actorNow.x);

    if (actorKey === 'p1') {
      G._renderP1 = { x: fromPX, facing: G.p1.facing };
      Tween.add(G._renderP1, { x: bumpPX }, beatDur * 0.25, 'easeInQuad');
    } else {
      G._renderP2 = { x: fromPX, facing: G.p2.facing };
      Tween.add(G._renderP2, { x: bumpPX }, beatDur * 0.25, 'easeInQuad');
    }

    const baseCharId = actorKey === 'p1' ? G.p1.charId : G.p2.charId;
    const baseGetPos = {
      getX: () => { const r = actorKey === 'p1' ? G._renderP1 : G._renderP2; return r ? r.x : finalPX; },
      getFacing: () => actorNow.facing
    };
    FX.active.push(new AfterimageFX(baseCharId, fromPX, finalPX, Renderer.baseY, beatDur * 0.55, baseGetPos));

    setTimeout(() => {
      const renderObj = actorKey === 'p1' ? G._renderP1 : G._renderP2;
      if (renderObj) { renderObj.x = bumpPX; Tween.add(renderObj, { x: finalPX }, beatDur * 0.3, 'easeOutQuad'); }
      for (const ev of (frame.events || [])) {
        if (ev.type === 'base_hit') FX.spawnFromEvent(ev, beatDur, frame.p1, frame.p2);
      }
    }, beatDur * 0.22);

  } else if (hasCollision && prevP1 && prevP2 && G.p1 && G.p2) {
    const colEv = (frame.events || []).find(e => e.type === 'collision');
    const colGrid = colEv ? colEv.x : Math.round((prevP1.x + prevP2.x) / 2);
    const colPX = Renderer.gridToPixelX(colGrid);
    const p1FromGrid = frame.p1FromX ?? prevP1.x;
    const p2FromGrid = frame.p2FromX ?? prevP2.x;
    const p1Moved = p1FromGrid !== colGrid;
    const p2Moved = p2FromGrid !== colGrid;
    const p1FromPX = Renderer.gridToPixelX(p1FromGrid);
    const p2FromPX = Renderer.gridToPixelX(p2FromGrid);
    const p1FinalPX = Renderer.gridToPixelX(G.p1.x);
    const p2FinalPX = Renderer.gridToPixelX(G.p2.x);

    if (p1Moved) {
      G._renderP1 = { x: p1FromPX, facing: G.p1.facing };
      Tween.add(G._renderP1, { x: colPX }, beatDur * 0.3, 'easeInQuad');
      FX.active.push(new AfterimageFX(G.p1.charId, p1FromPX, p1FinalPX, Renderer.baseY, beatDur * 0.65, { getX: () => G._renderP1 ? G._renderP1.x : p1FinalPX, getFacing: () => G.p1.facing }));
    }
    if (p2Moved) {
      G._renderP2 = { x: p2FromPX, facing: G.p2.facing };
      Tween.add(G._renderP2, { x: colPX }, beatDur * 0.3, 'easeInQuad');
      FX.active.push(new AfterimageFX(G.p2.charId, p2FromPX, p2FinalPX, Renderer.baseY, beatDur * 0.65, { getX: () => G._renderP2 ? G._renderP2.x : p2FinalPX, getFacing: () => G.p2.facing }));
    }

    setTimeout(() => {
      if (p1Moved && G._renderP1) { G._renderP1.x = colPX; Tween.add(G._renderP1, { x: p1FinalPX }, beatDur * 0.35, 'easeOutQuad'); }
      if (p2Moved && G._renderP2) { G._renderP2.x = colPX; Tween.add(G._renderP2, { x: p2FinalPX }, beatDur * 0.35, 'easeOutQuad'); }
    }, beatDur * 0.3);
    setTimeout(() => {
      for (const ev of (frame.events || [])) { if (ev.type === 'collision') FX.spawnFromEvent(ev, beatDur, frame.p1, frame.p2); }
    }, beatDur * 0.28);

  } else {
    if (prevP1 && G.p1 && prevP1.x !== G.p1.x) {
      const fromPX = Renderer.gridToPixelX(prevP1.x), toPX = Renderer.gridToPixelX(G.p1.x);
      G._renderP1 = { x: fromPX, facing: G.p1.facing };
      Tween.add(G._renderP1, { x: toPX }, beatDur * 0.7, 'easeOutQuad');
      FX.active.push(new AfterimageFX(G.p1.charId, fromPX, toPX, Renderer.baseY, beatDur * 0.7, { getX: () => G._renderP1 ? G._renderP1.x : toPX, getFacing: () => G.p1.facing }));
    } else { G._renderP1 = null; }

    if (!hasCollision && !hasBaseHit && prevP2 && G.p2 && prevP2.x !== G.p2.x) {
      const fromPX = Renderer.gridToPixelX(prevP2.x), toPX = Renderer.gridToPixelX(G.p2.x);
      G._renderP2 = { x: fromPX, facing: G.p2.facing };
      Tween.add(G._renderP2, { x: toPX }, beatDur * 0.7, 'easeOutQuad');
      FX.active.push(new AfterimageFX(G.p2.charId, fromPX, toPX, Renderer.baseY, beatDur * 0.7, { getX: () => G._renderP2 ? G._renderP2.x : toPX, getFacing: () => G.p2.facing }));
    } else if (!hasBaseHit) { G._renderP2 = null; }
  }

  // 处理事件
  const events = frame.events || [];
  const staggerTypes = ['bullet_hit','freeze_hit','poison_hit','bullet_trail','bullet_trail_cut','aoe_cast','burn_hit','aoe_hit','melee_slash'];
  let staggerCount = 0;
  const sortedEvents = [];
  const staggerEvents = [];
  for (const ev of events) {
    if (staggerTypes.includes(ev.type)) staggerEvents.push(ev);
    else sortedEvents.push(ev);
  }
  for (const ev of staggerEvents) {
    const anim = getAnim(ev.bullet_anim || ev.hit_anim);
    const interval = anim?.stagger || 0;
    ev._stagger = (interval > 0 && staggerEvents.length > 1) ? staggerCount++ * interval : 0;
    sortedEvents.push(ev);
  }
  sortedEvents.sort((a, b) => (a._stagger || 0) - (b._stagger || 0));

  const skipTypes = ['collision', 'base_hit'];
  const nonColEvents = sortedEvents.filter(ev => !skipTypes.includes(ev.type));
  for (const ev of nonColEvents) {
    FX.spawnFromEvent(ev, beatDur, frame.p1, frame.p2);
  }
  if (nonColEvents.length > 0) AE.play('tick');
}

/** 游戏结束结算 */
function finishGameOver(final) {
  if (G._musicReady) MusicEngine.stop();
  const d = G._pendingGameOverData;
  if (d) {
    G._mode = 'result';
    FX.clear();
    if (G._renderLoop) { cancelAnimationFrame(G._renderLoop); G._renderLoop = null; }
    UI.showScreen('result');
    document.getElementById('rtitle').textContent = d.winner === 'draw' ? '平局!' : d.winner + ' 获胜!';
    document.getElementById('rdetail').textContent = 'P1 HP: ' + d.p1Hp + ' | P2 HP: ' + d.p2Hp + ' | ' + d.reason;
    G._pendingGameOverData = null;
  } else {
    const b1hp = final.bases?.p1?.hp ?? 100, b2hp = final.bases?.p2?.hp ?? 100;
    const p1Dead = final.p1.hp <= 0, p2Dead = final.p2.hp <= 0;
    const b1Dead = b1hp <= 0, b2Dead = b2hp <= 0;
    let w, reason;
    if (b1Dead && b2Dead) { w = 'draw'; reason = '双方基地均被摧毁'; }
    else if (b1Dead) { w = 'P2'; reason = 'P1基地被摧毁'; }
    else if (b2Dead) { w = 'P1'; reason = 'P2基地被摧毁'; }
    else if (p1Dead && p2Dead) { w = 'draw'; reason = '双方同时阵亡'; }
    else if (p1Dead) { w = 'P2'; reason = 'P1被击杀'; }
    else if (p2Dead) { w = 'P1'; reason = 'P2被击杀'; }
    else { w = final.p1.hp > final.p2.hp ? 'P1' : final.p2.hp > final.p1.hp ? 'P2' : 'draw'; reason = '达到最大回合数'; }
    G._mode = 'result';
    FX.clear();
    UI.showScreen('result');
    document.getElementById('rtitle').textContent = w === 'draw' ? '平局!' : w + ' 获胜!';
    document.getElementById('rdetail').textContent = 'P1 HP: ' + final.p1.hp + ' | P2 HP: ' + final.p2.hp + ' | ' + reason;
  }
  G._onBattleEnd = null;
}

// ==================== DOM 导航 ====================
function nav(screen) {
  if (screen === 'menu') {
    G.reset();
    if (G._musicReady) MusicEngine.stop();
    if (G.socket) { G.socket.emit('leaveRoom'); G.socket.removeAllListeners(); G.socket.disconnect(); G.socket = null; }
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
  if (screen === 'tutorial') {
    initTutorial();
  }
}

// ==================== 教程系统 ====================
let _tutChapter = 1;

function initTutorial() {
  _tutChapter = 1;
  document.querySelectorAll('#tutorial .tut-chapter').forEach((btn, i) => {
    btn.classList.toggle('active', i === 0);
    btn.onclick = () => {
      _tutChapter = parseInt(btn.dataset.ch);
      document.querySelectorAll('#tutorial .tut-chapter').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderTutContent();
    };
  });
  renderTutContent();
}

function renderTutContent() {
  const el = document.getElementById('tutContent');
  if (!el) return;

  const sections = {
    1: // 基础 — 战斗流程
    '<div class="wiki-section">'+
      '<h3>[FLOW] 游戏总览</h3>'+
      '<p>Debug-Lite 是一款<strong>同步回合制策略格斗</strong>游戏。16 格横版场地，双方同时编排行动，逐 tick 执行。</p>'+
      '<div class="tut-flow"><span class="tut-step">主菜单</span><span class="tut-arrow">></span><span class="tut-step">选角色+技能</span><span class="tut-arrow">></span><span class="tut-step">编辑阶段</span><span class="tut-arrow">></span><span class="tut-step">战斗阶段</span><span class="tut-arrow">></span><span class="tut-step">下一回合</span></div>'+
    '</div>'+
    '<div class="wiki-section">'+
      '<h3>[EDIT] 编辑阶段 (60秒)</h3>'+
      '<div class="wiki-card"><p>编排<strong>16 个行动格</strong>的行动队列。每格选择：技能攻击 / 移动 / 闪避 / 防御 / 转向。</p><p>点击「完成」提交队列。双方都提交后，<strong>立即进入战斗阶段</strong>。</p></div>'+
    '</div>'+
    '<div class="wiki-section">'+
      '<h3>[FIGHT] 战斗阶段 (16 tick)</h3>'+
      '<div class="wiki-card"><p>双方行动队列<strong>同时逐 tick 执行</strong>。每 tick 的执行顺序：</p>'+
      '<p><strong>1.</strong> 冷却递减 <strong>2.</strong> 效果处理(眩晕/冰冻/燃烧/中毒) <strong>3.</strong> 移动+碰撞检测 <strong>4.</strong> 技能执行+弹幕碰撞 <strong>5.</strong> 资源恢复</p>'+
      '<p>一 tick 内双方行动<strong>完全同步</strong>——先同时移动，再同时释放技能。16 tick 结束或一方 HP 归零即回合终止。</p></div>'+
    '</div>'+
    '<div class="wiki-section">'+
      '<h3>[ACTIONS] 行动队列</h3>'+
      '<table class="wiki-table"><tr><th>行动</th><th>效果</th><th>SP</th></tr>'+
      '<tr><td>左移 / 右移</td><td>向该方向走 1 格</td><td>0</td></tr>'+
      '<tr><td>左闪 / 右闪</td><td>冲刺 2 格，可穿越敌人，闪避本 tick 伤害</td><td>10</td></tr>'+
      '<tr><td>防御</td><td>本 tick 获得 DEF*0.8 额外护甲</td><td>0</td></tr>'+
      '<tr><td>转向</td><td>转身 180 度</td><td>0</td></tr>'+
      '<tr><td>技能1/2/3</td><td>使用角色携带的技能(消耗 MP+SP)</td><td>各异</td></tr>'+
      '</table></div>'+
    '</div>'+
    '<div class="wiki-section">'+
      '<h3>[BASE] 基地系统</h3>'+
      '<div class="wiki-card"><p>双方各有一个<strong>基地</strong>（HP 100，位于地图<strong>边界之外</strong>）。玩家无法站在基地格上——当你位于左右边界格并<strong>向敌方方向移动</strong>时，即触发<strong>攻击基地</strong>。</p>'+
      '<p class="wiki-formula">基地伤害 = ATK × 0.75 × (1 − 基地减伤率)</p>'+
      '<p>基地反弹伤害恒为 <strong>1</strong>（基地ATK=0）。但多次撞击会快速消耗自身HP。</p></div>'+
    '</div>'+
    '<div class="wiki-section">'+
      '<h3>[WIN] 胜利条件</h3>'+
      '<p>一方 HP 归零 <strong>或 基地被摧毁</strong> 则立即判负。击杀对手后再拆基地是迟早的事。30 回合打满以 HP 多者胜。</p>'+
    '</div>',

    2: // 角色
    '<div class="wiki-section">'+
      '<h3>[STATS] 角色属性</h3>'+
      '<table class="wiki-table"><tr><th>属性</th><th>含义</th></tr>'+
      '<tr><td>HP</td><td>生命值。归零落败，跨回合继承</td></tr>'+
      '<tr><td>MP</td><td>法力值。技能消耗，每 tick 自动回复(各角色不同)</td></tr>'+
      '<tr><td>SP</td><td>体力值。移动/闪避/技能消耗，每 tick 自动回复</td></tr>'+
      '<tr><td>ATK</td><td>攻击力。影响所有非真伤技能的伤害基数</td></tr>'+
      '<tr><td>DEF</td><td>防御力。决定减伤率 = DEF/(DEF+40)</td></tr>'+
      '</table></div>'+
    '<div class="wiki-section">'+
      '<h3>[HEROES] 四角色一览</h3>'+
      (()=>{var ch=(_charsData?.characters||[]);var r='';
        ch.forEach(c=>{
          var d=c.def/(c.def+40)*100;
          r+='<div class="wiki-card"><h4 style="color:'+c.color+'">'+c.name+' — '+c.desc+'</h4>'+
          '<p>HP:'+c.maxHp+' | MP:'+c.maxMp+' | SP:'+c.maxSp+' | ATK:'+c.atk+' | DEF:'+c.def+' ('+d.toFixed(0)+'%减伤)</p>'+
          '<p>回复/tick: MP+'+c.mpRegen+' SP+'+c.spRegen+'</p></div>';
        });
        return r;
      })()+
    '</div>'+
    '<div class="wiki-section">'+
      '<h3>[COUNTER] 克制关系</h3>'+
      '<p><strong>战士</strong>(高防) 克制 射手多段 → <strong>刺客</strong>(真伤无视防御) 克制 战士 → <strong>法师</strong>(高爆发) 克制 刺客脆皮 → <strong>射手</strong>(远程全屏) 克制 法师短手</p>'+
    '</div>',

    3: // 技能
    '<div class="wiki-section">'+
      '<h3>[SKILLS] 技能属性</h3>'+
      '<table class="wiki-table"><tr><th>属性</th><th>含义</th></tr>'+
      '<tr><td>damageRatio</td><td>伤害倍率。公式: ATK * ratio * (1-减伤率)</td></tr>'+
      '<tr><td>mpCost / spCost</td><td>MP/SP 消耗。资源不足时技能<strong>空过(exhausted)</strong></td></tr>'+
      '<tr><td>cooldown (CD)</td><td>冷却 tick 数。CD 期间再次使用会空过。跨回合继承</td></tr>'+
      '<tr><td>bulletPriority</td><td>弹幕等级(Lv)。数字越小等级越高</td></tr>'+
      '<tr><td>range / bulletRange</td><td>射程(格)。超过射程打不到</td></tr>'+
      '<tr><td>multiShot</td><td>连射数。一 tick 内连续发射多次</td></tr>'+
      '<tr><td>aoeRadius</td><td>AOE 半径。从目标格向两侧展开</td></tr>'+
      '<tr><td>stunDuration / freezeDuration</td><td>眩晕/冰冻持续 tick 数。目标无法行动</td></tr>'+
      '<tr><td>burnTicks / poisonTicks</td><td>燃烧/中毒持续 tick 数。每 tick 扣血</td></tr>'+
      '<tr><td>backstabRatio</td><td>背刺倍率。从背后攻击时使用此倍率代替 damageRatio</td></tr>'+
      '<tr><td>defBuff</td><td>防御 buff 倍率。释放后获得 def*defBuff 额外护甲</td></tr>'+
      '<tr><td>knockback</td><td>击退格数。命中后将目标向后推</td></tr>'+
      '</table></div>'+
    '<div class="wiki-section">'+
      '<h3>[TYPES] 技能类型</h3>'+
      '<table class="wiki-table"><tr><th>类型</th><th>说明</th></tr>'+
      '<tr><td>melee</td><td>近战。方向限定(foward/forward_and_back)，有范围</td></tr>'+
      '<tr><td>projectile</td><td>弹幕。沿方向扫描飞行，受弹幕等级碰撞影响</td></tr>'+
      '<tr><td>targeted_aoe</td><td>垂直 AOE。无视距离锁定目标格，aoeRadius 范围伤害</td></tr>'+
      '<tr><td>dash</td><td>冲刺。角色高速位移，路径上碰撞造成伤害+效果</td></tr>'+
      '<tr><td>teleport_backstab</td><td>瞬移背刺。直接传送到目标身后并转身</td></tr>'+
      '</table></div>'+
    '<div class="wiki-section">'+
      '<h3>[EFFECTS] 效果类型</h3>'+
      '<table class="wiki-table"><tr><th>效果</th><th>说明</th></tr>'+
      '<tr><td>normal_damage</td><td>普通伤害(受减伤影响)</td></tr>'+
      '<tr><td>true_damage</td><td>真实伤害(完全无视防御和减伤)</td></tr>'+
      '<tr><td>stun_damage</td><td>伤害+眩晕；freeze_damage=伤害+冰冻</td></tr>'+
      '<tr><td>burn_debuff</td><td>伤害+燃烧 DOT(每 tick 扣 ATK*burnRatio)</td></tr>'+
      '<tr><td>poison_debuff</td><td>伤害+中毒 DOT(每 tick 扣 ATK*poisonRatio)</td></tr>'+
      '<tr><td>dash_knockback</td><td>冲刺伤害+击退+防御 buff</td></tr>'+
      '</table></div>',

    4: // 弹幕
    '<div class="wiki-section">'+
      '<h3>[BULLET] 弹幕等级与碰撞</h3>'+
      '<p>每个投射物技能都有 <strong>bulletPriority</strong> 属性（数值越小等级越高）：</p>'+
      '<table class="wiki-table"><tr><th>Lv</th><th>归属</th><th>碰撞行为</th></tr>'+
      '<tr><td>Lv2</td><td>魔法盾</td><td>挡 Lv3+Lv4；遇 Lv2 抵消</td></tr>'+
      '<tr><td>Lv3</td><td>精准射击、旋风斩、重击、突击盾</td><td>穿透 Lv4；遇 Lv2 消失；同级抵消</td></tr>'+
      '<tr><td>Lv4</td><td>连续射击、冰锥、匕首、毒瓶</td><td>遇 Lv2/Lv3 消失；同级抵消</td></tr>'+
      '</table>'+
      '<div class="wiki-card"><h4>碰撞规则</h4>'+
      '<p><strong>高 Lv(数字小) > 低 Lv(数字大)</strong>：低等级弹幕直接消失，高等级继续飞行。</p>'+
      '<p><strong>同级相遇</strong>：双方弹幕都消失。</p>'+
      '<p><strong>连射多弹幕</strong>：每发独立判碰撞。第一发遇到同级弹幕后，该敌方弹幕被移除，后续连射弹无需再判。</p>'+
      '<p><strong>近战/冲刺/AOE</strong>：不受弹幕碰撞影响，直接判定命中。</p></div>'+
    '</div>'+
    '<div class="wiki-section">'+
      '<h3>[DMG] 伤害公式</h3>'+
      '<div class="wiki-card">'+
      '<h4>普通伤害</h4>'+
      '<p class="wiki-formula">DMG = ATK * ratio * (1 - DEF/(DEF+40))</p>'+
      '<p>最低伤害 <strong>1</strong>。防御 buff(来自防御指令/突击盾) 临时提高 DEF。</p>'+
      '</div>'+
      '<div class="wiki-card">'+
      '<h4>真实伤害</h4>'+
      '<p class="wiki-formula">DMG = ATK * ratio</p>'+
      '<p>完全无视防御和防御 buff。刺客匕首攻击(正面 ratio=1.2, 背刺 ratio=2.4)即为真伤。</p>'+
      '</div>'+
      '<div class="wiki-card">'+
      '<h4>碰撞伤害</h4>'+
      '<p class="wiki-formula">DMG = 对方ATK * 0.75 * (1 - 我方DEF/(DEF+40))</p>'+
      '<p>同时移动到同一格，或走入对方占据的格子时触发。向敌方边界外移动则改为攻击基地。</p>'+
      '</div>'+
    '</div>'+
    '<div class="wiki-section">'+
      '<h3>[STATUS] 异常状态</h3>'+
      '<table class="wiki-table"><tr><th>状态</th><th>效果</th><th>来源技能</th></tr>'+
      '<tr><td>STUN 眩晕</td><td>本 tick 无法行动(动作变为 stunned)</td><td>重击(1tick)</td></tr>'+
      '<tr><td>FREEZE 冰冻</td><td>本 tick 无法行动。在眩晕之后判定</td><td>冰锥(1tick)</td></tr>'+
      '<tr><td>BURN 燃烧</td><td>每 tick 扣 ATK*0.10 HP(3tick)</td><td>火球术</td></tr>'+
      '<tr><td>POISON 中毒</td><td>每 tick 扣 ATK*0.07 HP(4tick)</td><td>毒瓶</td></tr>'+
      '</table>'+
      '<p>DOT(持续伤害)每 tick 在效果处理阶段扣除，<strong>无视闪避</strong>。</p>'+
    '</div>',

    5: // 进阶
    '<div class="wiki-section">'+
      '<h3>[TIPS] 进阶策略</h3>'+
      '<div class="wiki-card"><h4>基地攻防</h4>'+
      '<p>基地位于场地<strong>边界之外</strong>，走到边界格再向敌方方向移动即可攻击基地。</p>'+
      '<p>对手一定会来攻击你的基地——这就是<strong>预测对方位置的依据</strong>。你不需要猜他在哪，你只需要想："他会走哪条路来拆我的基地？"</p>'+
      '<p>击杀对手后，无人防守的基地随便拆。也可以<strong>绕过敌人直取基地</strong>（刺客暗影步+冲刺）。</p></div>'+
      '<div class="wiki-card"><h4>行动编排</h4>'+
      '<p>预判对手位置再放技能。打不中=浪费一 tick。</p>'+
      '<p>闪避可穿越敌人且躲伤害，但消耗 SP 较多。</p>'+
      '<p>防御只持续 <strong>1 tick</strong>——精准预判对手攻击时刻。</p>'+
      '<p>技能 CD 跨回合继承。合理安排释放节奏。</p></div>'+
      '<div class="wiki-card"><h4>资源管理</h4>'+
      '<p>每 tick MP 和 SP 自动恢复。但没有"省着用"的必要——</p>'+
      '<p>16 tick 中 <strong>总恢复量 > 大部分技能消耗</strong>。关键是在对的 tick 有足够资源。</p>'+
      '<p>战士依赖 SP(无 MP 技能)；法师依赖 MP(高回蓝)；刺客 SP 回最快。</p></div>'+
      '<div class="wiki-card"><h4>弹幕博弈</h4>'+
      '<p>魔法盾(Lv2)可挡大部分弹幕——但会被同级抵消，且射程仅 1 格。</p>'+
      '<p>连射弹幕遇到同级只抵消第一发，后续会<strong>继续飞行并命中</strong>。</p>'+
      '<p>近战和 AOE 不受弹幕碰撞影响——无法被盾挡。</p></div>'+
      '<div class="wiki-card"><h4>背刺判定</h4>'+
      '<p>攻击方面朝方向与目标位置相反即为背刺。暗影步传送到敌后可触发背刺倍率。</p>'+
      '<p>背刺倍率<strong>替换</strong>普通倍率(不是相乘)。匕首正面 1.2，背刺 2.4。</p></div>'+
    '</div>'
  };

  el.innerHTML = sections[_tutChapter] || '';
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
  G.reset();
  if (!_skillsData) await loadData();
  _selChar = null; _selSkills = [];
  UI.showScreen('charSel');
  renderCharGrid();
  document.getElementById('skillSel').classList.add('hidden');
}

// ==================== 联机大厅 ====================
async function enterLobby() {
  _selMode = 'online';
  G.mode = 'online';
  G.reset();
  if (!_skillsData) await loadData();
  _selChar = null; _selSkills = [];
  setupSocket();
  UI.showScreen('lobby');
  // socket 可能还没连接好，等 connect 后再请求房间列表
  if (G.socket && G.socket.connected) {
    G.socket.emit('getRoomList');
  } else {
    // 标记：连接后立即请求
    G._pendingLobbyRefresh = true;
  }
}

function showJoinDialog() {
  document.getElementById('joinDialog').classList.remove('hidden');
  document.getElementById('rcode').focus();
}

function hideJoinDialog() {
  document.getElementById('joinDialog').classList.add('hidden');
}

function createRoom() {
  const name = document.getElementById('pname').value || 'Player';
  if (!G.socket || !G.socket.connected) {
    setupSocket();
    G._pendingCreate = { name };
  } else {
    G.socket.emit('createRoom', { name });
  }
}

function joinRoom() {
  const name = document.getElementById('pname').value || 'Player';
  const rid = document.getElementById('rcode').value.trim();
  if (!rid) return;
  hideJoinDialog();
  if (!G.socket || !G.socket.connected) {
    setupSocket();
    G._pendingJoin = { roomId: rid, name };
  } else {
    G.socket.emit('joinRoom', { roomId: rid, name });
  }
}

function leaveLobby() {
  if (G.socket) { G.socket.removeAllListeners(); G.socket.disconnect(); G.socket = null; }
  G.reset();
  nav('menu');
}

// --- 房间列表渲染 ---
function getStateLabel(state) {
  return state === 'playing' ? '游戏中' : '准备中';
}

function renderRoomList(list) {
  const el = document.getElementById('roomList');
  if (!el) return;
  if (!list || list.length === 0) {
    el.innerHTML = '<p class="room-list-empty">暂无房间，创建一个吧！</p>';
    return;
  }
  el.innerHTML = '';
  list.forEach(r => {
    const item = document.createElement('div');
    item.className = 'room-item';
    item.innerHTML = '<div class="room-item-info">' +
      '<span class="room-item-id">#' + r.roomId + '</span>' +
      '<span class="room-item-meta">' + r.playerCount + '/' + r.maxSlots + ' 人</span>' +
      '</div>' +
      '<span class="room-item-state ' + r.state + '">' + getStateLabel(r.state) + '</span>';
    item.onclick = () => {
      const name = document.getElementById('pname').value || 'Player';
      if (!G.socket || !G.socket.connected) {
        setupSocket();
        G._pendingJoin = { roomId: r.roomId, name };
      } else {
        G.socket.emit('joinRoom', { roomId: r.roomId, name });
      }
    };
    el.appendChild(item);
  });
}

// --- 房间页面 ---
function enterRoomUI() {
  UI.showScreen('room');
  document.getElementById('roomIdDisplay').textContent = G.roomId;
  document.getElementById('roomCharSelect').classList.add('hidden');
  renderRoomSlots();
  updateRoomCharSelect();
}

function renderRoomSlots() {
  const grid = document.getElementById('slotGrid');
  if (!grid) return;
  grid.innerHTML = '';
  const slots = G._roomSlots || [];
  const mySid = G.socket ? G.socket.id : null;

  slots.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'slot-card';
    if (s.type === 'player') card.classList.add('player-slot');
    else card.classList.add('spectator-slot');
    if (s.occupied && s.index === G.mySlotIndex) card.classList.add('my-slot');
    if (s.occupied && s.index !== G.mySlotIndex) card.classList.add('occupied');

    const label = s.type === 'player' ? '游戏位 ' + (i + 1) : '观战位 ' + (i - 1);
    let inner = '<span class="slot-label">' + label + '</span>';

    if (s.occupied) {
      inner += '<span class="slot-name">' + (s.name || '?') + '</span>';
      if (s.type === 'player') {
        if (s.charId) {
          const char = getCharDef(s.charId);
          inner += '<span class="slot-char">' + (char ? char.name : s.charId) + '</span>';
        } else {
          inner += '<span class="slot-char" style="color:var(--tx-muted);">未选择</span>';
        }
        const readyText = s.ready ? '已准备' : '未准备';
        const readyClass = s.ready ? '' : 'not';
        inner += '<span class="slot-ready ' + readyClass + '">' + readyText + '</span>';
      }
    } else {
      inner += '<span class="slot-name" style="color:var(--tx-dim);">空位</span>';
    }

    // 点击交互：如果位置为空或者是自己的位置，可以切换
    if (!s.occupied || s.index === G.mySlotIndex) {
      card.style.cursor = 'pointer';
    }

    card.innerHTML = inner;
    card.onclick = () => {
      if (s.occupied && s.index !== G.mySlotIndex) return; // 别人的位置不能点
      if (s.index === G.mySlotIndex) return; // 已经是自己的位置
      if (G.socket) G.socket.emit('switchSlot', { targetIndex: s.index });
    };
    grid.appendChild(card);
  });

  updateRoomCharSelect();
}

function updateRoomCharSelect() {
  const panel = document.getElementById('roomCharSelect');
  const readyBtn = document.getElementById('roomReadyBtn');
  if (!panel) return;

  // 检查当前槽位是否是游戏位
  const mySlot = G._roomSlots.find(s => s.index === G.mySlotIndex);
  if (mySlot && mySlot.type === 'player') {
    panel.classList.remove('hidden');
    if (!_selChar) {
      // 还没选角色，渲染角色选择
      if (!_charsData) return;
      renderRoomCharGrid();
      document.getElementById('roomSkillSel').classList.add('hidden');
    }
    // 更新准备按钮文字
    if (readyBtn) {
      readyBtn.textContent = mySlot.ready ? '取消准备' : '准备';
    }
  } else {
    panel.classList.add('hidden');
    if (readyBtn) readyBtn.textContent = '准备';
  }
}

function renderRoomCharGrid() {
  const cg = document.getElementById('roomCharGrid');
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
      renderRoomCharGrid();
      renderRoomSkillGrid(c);
      document.getElementById('roomSkillSel').classList.remove('hidden');
    };
    cg.appendChild(card);
  });
}

function renderRoomSkillGrid(char) {
  const sg = document.getElementById('roomSkillGrid');
  if (!sg || !_skillsData) return;
  sg.innerHTML = '';
  const allSkills = Object.values(_skillsData.skills || {}).filter(s => s.charId === char.id);
  allSkills.forEach(sk => {
    const card = document.createElement('div');
    card.className = 'sc';
    if (_selSkills.includes(sk.id)) card.classList.add('selected');
    var typeName = {melee:'[MELEE]',projectile:'[RANGE]',targeted_aoe:'[AOE]',dash:'[DASH]',teleport_backstab:'[WARP]'}[sk.type]||sk.type;
    card.innerHTML = '<div class="sn">' + sk.name + '</div><div class="st">' + typeName + ' | ' + (sk.desc||'') + '<br><span class="pix-label" style="color:var(--blue)">MP</span>' + (sk.mpCost||0) + ' <span class="pix-label" style="color:var(--green)">SP</span>' + (sk.spCost||0) + ' CD:' + (sk.cooldown||0) + ' x' + (sk.damageRatio||'-') + '</div>';
    card.onclick = () => {
      if (_selSkills.includes(sk.id)) {
        if (_selSkills.length <= 3) return;
        _selSkills = _selSkills.filter(s => s !== sk.id);
      } else {
        if (_selSkills.length >= 3) _selSkills.shift();
        _selSkills.push(sk.id);
      }
      renderRoomSkillGrid(char);
    };
    sg.appendChild(card);
  });
}

function confirmRoomChar() {
  if (!_selChar || _selSkills.length < 3) return;
  G.myCharId = _selChar;
  G.mySkillIds = [..._selSkills];
  if (G.socket) {
    G.socket.emit('selectChar', { charId: _selChar, skillIds: _selSkills, customSkills: {} });
  }
}

function toggleReady() {
  if (!G.socket) return;
  // 如果还没确认角色，先确认
  if (_selChar && _selSkills.length >= 3) {
    const mySlot = G._roomSlots.find(s => s.index === G.mySlotIndex);
    if (mySlot && mySlot.type === 'player' && !mySlot.charId) {
      confirmRoomChar();
    }
  }
  G.socket.emit('toggleReady');
}

function leaveRoom() {
  if (G.socket) G.socket.emit('leaveRoom');
  G.roomId = null;
  G.mySlotIndex = null;
  G._roomSlots = [];
  G._selChar = null;
  G._selSkills = [];
  UI.showScreen('lobby');
  if (G.socket) G.socket.emit('getRoomList');
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
    var typeName = {melee:'[MELEE]',projectile:'[RANGE]',targeted_aoe:'[AOE]',dash:'[DASH]',teleport_backstab:'[WARP]'}[sk.type]||sk.type;
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
    bindSoloBattleEvents(); // 绑定 AI/训练事件
    G.mode = 'ai';
    // 对手由服务端随机选择（非玩家职业）
    G.socket.emit('startAI', { name:'Player', charId:_selChar, skillIds:_selSkills });
  } else if (_selMode === 'train') {
    bindSoloBattleEvents(); // 绑定 AI/训练事件
    G.mode = 'train';
    G.socket.emit('startTrain', { name:'Player', charId:_selChar, skillIds:_selSkills });
  }
}

/** 绑定 AI/训练模式的战斗事件 */
function bindSoloBattleEvents() {
  if (!G.socket) return;
  G.socket.off('prepareStart');
  G.socket.off('battleFrames');
  G.socket.off('gameOver');

  G.socket.on('prepareStart', (d) => {
    onOnlinePrepareStart(d);
  });

  G.socket.on('battleFrames', (d) => {
    // ★ 音乐同步检查：如果正在等待循环结束，暂存数据
    if (G._musicReady && MusicEngine.isRunning && G._musicLoopSync) {
      // 战斗帧数据先存起来，等 handleMusicLoopComplete 触发后处理
      G._pendingBattleFrames = d;
      UI.log('战斗帧已到达，等待音乐循环结束...');
      return;
    }

    G._mode = 'battle';
    G._battleGameOver = d.gameOver;
    G._pendingGameOver = d.gameOver ? { gameOver: true } : null;
    document.getElementById('actionQueuePanel').classList.add('hidden');
    document.getElementById('battleQueuePanel').classList.remove('hidden');
    document.getElementById('rdyBtn').disabled = true;

    // 如果是音乐驱动模式且刚进入战斗，注册节拍步进
    if (G._musicReadyForFrames) {
      G._musicReadyForFrames = false;
      startMusicDrivenBattle();
    }

    playBattleAnim(d.frames, d.final);
  });

  G.socket.on('gameOver', (d) => {
    // 不立即显示结算，等 battleFrames 播放完
    // 存储结算数据供 playBattleAnim 结束时使用
    G._pendingGameOverData = d;
    G._battleGameOver = true;
  });
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
    const typeLabel = { melee: '[MELEE]', projectile: '[RANGE]', targeted_aoe: '[AOE]', dash: '[DASH]', teleport_backstab: '[WARP]' }[s.type] || s.type;
    const effectLabel = { normal_damage: 'DMG', stun_damage: 'STUN', freeze_damage: 'FREEZE', burn_debuff: 'BURN', poison_debuff: 'POISON', true_damage: 'TRUE', dash_knockback: 'KNOCK', none: 'MOVE' }[s.effect] || s.effect;
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

  // 初始化音乐引擎
  initMusic();

  const canvas = document.getElementById('fc');
  if (canvas) Renderer.init(canvas);
  window.addEventListener('resize', () => Renderer.resize());

  // 默认显示菜单
  UI.showScreen('menu');
}

// ==================== 音乐引擎初始化与生命周期 ====================

/** 初始化背景音乐模块 */
async function initMusic() {
  // 检查配置中音乐是否启用
  try {
    const cfgResp = await fetch('/data/config.json');
    const cfg = await cfgResp.json();
    if (!cfg.music?.enabled) {
      console.log('[MUSIC] 音乐已禁用');
      return;
    }
  } catch (e) {
    // config 加载失败，仍尝试初始化
  }

  // 初始化引擎
  if (!MusicEngine.init()) {
    console.warn('[MUSIC] 引擎初始化失败，使用无音乐模式');
    return;
  }

  // 加载乐谱
  const loaded = await MusicConfig.load();
  if (!loaded) {
    console.warn('[MUSIC] 乐谱加载失败');
    return;
  }

  G._musicReady = true;

  // 注册循环完成回调
  MusicEngine.onLoopComplete(() => {
    handleMusicLoopComplete();
  });

  console.log('[MUSIC] 音乐引擎就绪 BPM=' + (60 / MusicEngine.beatDuration));
}

/** 音乐循环完成时的处理 */
function handleMusicLoopComplete() {
  // 如果正在等待音乐循环结束以进入战斗阶段
  if (G._musicLoopSync && G._musicPendingBattle) {
    G._musicLoopSync = false;
    G._musicPendingBattle = false;

    // 通知音乐引擎进入战斗模式
    MusicEngine.enterBattleMode();

    // 使用 pending data 开始战斗
    if (G._pendingOnlineResult) {
      const d = G._pendingOnlineResult;
      G._pendingOnlineResult = null;
      startOnlineBattlePlayback(d);
      startMusicDrivenBattle();
    } else if (G._pendingBattleFrames) {
      // AI/训练模式：暂存的 battleFrames 数据
      const d = G._pendingBattleFrames;
      G._pendingBattleFrames = null;
      G._mode = 'battle';
      G._battleGameOver = d.gameOver;
      G._pendingGameOver = d.gameOver ? { gameOver: true } : null;
      document.getElementById('actionQueuePanel').classList.add('hidden');
      document.getElementById('battleQueuePanel').classList.remove('hidden');
      document.getElementById('rdyBtn').disabled = true;
      startMusicDrivenBattle();
      playBattleAnim(d.frames, d.final);
    } else {
      // 设置标记等待 battleFrames 到来（理论上不应走这里，因为有 pendingBattleFrames 检查）
      G._musicReadyForFrames = true;
    }
    return;
  }

  // 战斗阶段中，16 tick 已播完——等待循环结束回到编辑
  if (G._mode === 'battle-waiting-edit' && G._musicBeatDriven) {
    G._mode = 'prepare';
    G._musicBeatDriven = false;
    MusicEngine.enterEditMode();
    onBattleToEditTransition();
    return;
  }
}

/** 在音乐节拍驱动下开始战斗播放 */
function startMusicDrivenBattle() {
  G._musicBeatDriven = true;
  G._tickIdx = 0;

  // 注册节拍回调：每拍步进 1 tick
  MusicEngine.onBeat((beatNumber, ctxTime) => {
    if (!G._musicBeatDriven) return;
    if (G._mode !== 'battle') return;

    // 步进 1 tick
    if (G._battleStep && G._tickIdx < 16) {
      G._battleStep();
      G._tickIdx++;
    }
  });

  // 立即执行第 0 tick（当前拍）
  if (G._battleStep) {
    G._battleStep();
    G._tickIdx = 1;
  }

  UI.log('战斗开始 — 音乐同步驱动');
}

/** 战斗结束后回到编辑阶段的过渡 */
function onBattleToEditTransition() {
  if (G._onBattleEnd) {
    G._onBattleEnd(G._battleFinal || { p1: G.p1, p2: G.p2, bases: G.bases });
    G._onBattleEnd = null;
  }

  // 回到编辑 UI
  document.getElementById('actionQueuePanel').classList.remove('hidden');
  document.getElementById('battleQueuePanel').classList.add('hidden');
  document.getElementById('rdyBtn').disabled = false;

  // 重置编辑状态
  G.actions = [];
  G.tick = 0;
  G._cooldowns = {};
  G._snapshots = [];
  if (G._originP1) { G.p1 = JSON.parse(JSON.stringify(G._originP1)); }
  if (G._originP2) { G.p2 = JSON.parse(JSON.stringify(G._originP2)); }
  if (G._originBases) { G.bases = JSON.parse(JSON.stringify(G._originBases)); }
  G._renderP1 = null;
  G._renderP2 = null;
  FX.clear();

  UI.renderActionSlots();
  UI.renderActionButtons();
  UI.updateHUD(G.p1, 'p1');
  UI.updateHUD(G.p2, 'p2');
  if (G.bases) UI.updateBaseHUD(G.bases);

  UI.log('等待编排下一回合...');
}

document.addEventListener('DOMContentLoaded', init);
