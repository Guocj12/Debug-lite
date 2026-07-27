// Debug-Lite 像素渲染引擎

class PixelRenderer {
  constructor() {
    this.charData = null;
    this.skillData = null;
    this.particleSystems = [];
  }

  async init() {
    try {
      const charResp = await fetch('/data/characters.json');
      this.charData = await charResp.json();
      const skillResp = await fetch('/data/skills.json');
      this.skillData = await skillResp.json();
    } catch (e) {
      console.error('渲染数据加载失败:', e);
    }
  }

  // 绘制像素精灵到canvas
  drawSprite(ctx, pixelData, x, y, scale, color, glowColor) {
    const pixelSize = scale || 4;
    for (let row = 0; row < pixelData.length; row++) {
      for (let col = 0; col < pixelData[row].length; col++) {
        if (pixelData[row][col] === 'x') {
          // 霓虹发光核心
          if (glowColor) {
            ctx.shadowColor = glowColor;
            ctx.shadowBlur = pixelSize * 3;
          }
          ctx.fillStyle = color || '#00ffff';
          ctx.fillRect(
            x + col * pixelSize,
            y + row * pixelSize,
            pixelSize - 1,
            pixelSize - 1
          );
          // 重置阴影
          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;
        } else if (pixelData[row][col] === 'o') {
          // 次要颜色（用于技能图标等）
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(
            x + col * pixelSize,
            y + row * pixelSize,
            pixelSize - 1,
            pixelSize - 1
          );
        }
      }
    }
  }

  // 获取角色像素数据
  getCharacterPixels(charId) {
    if (!this.charData) return null;
    return this.charData.characters.find(c => c.id === charId);
  }

  // 绘制角色到canvas
  drawCharacter(ctx, charId, x, y, scale, facingRight = true) {
    const char = this.getCharacterPixels(charId);
    if (!char) return;
    
    ctx.save();
    if (!facingRight) {
      ctx.translate(x * 2 + char.width * scale, 0);
      ctx.scale(-1, 1);
    }
    
    // 先画发光层
    ctx.globalAlpha = 0.3;
    this.drawSprite(ctx, char.pixels, x, y, scale, char.color, char.color);
    ctx.globalAlpha = 1;
    
    // 再画实体层
    this.drawSprite(ctx, char.pixels, x, y, scale, char.color, null);
    
    ctx.restore();
  }

  // 绘制背景网格
  drawGrid(ctx, width, height, cols, rows) {
    const cellW = width / cols;
    const cellH = height / rows;
    
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    
    for (let i = 1; i < cols; i++) {
      const x = i * cellW;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    
    for (let i = 1; i < rows; i++) {
      const y = i * cellH;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }

  // 绘制HP/MP条（像素风）
  drawBar(ctx, x, y, w, h, fillPercent, color, glowColor) {
    // 背景
    ctx.fillStyle = '#111';
    ctx.fillRect(x, y, w, h);
    
    // 边框
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    
    // 填充
    if (fillPercent > 0) {
      const fillW = Math.max(0, (w - 2) * fillPercent);
      const gradient = ctx.createLinearGradient(x, y, x + fillW, y);
      gradient.addColorStop(0, color);
      gradient.addColorStop(1, glowColor || color);
      ctx.fillStyle = gradient;
      ctx.fillRect(x + 1, y + 1, fillW, h - 2);
      
      // 发光效果
      ctx.shadowColor = glowColor || color;
      ctx.shadowBlur = 4;
      ctx.fillRect(x + 1, y + 1, fillW, h - 2);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
  }

  // 战斗场地的战斗渲染
  renderBattle(ctx, state) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    
    ctx.clearRect(0, 0, w, h);
    
    // 背景
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, w, h);
    
    // 地面线
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.75);
    ctx.lineTo(w, h * 0.75);
    ctx.stroke();
    
    // 网格
    this.drawGrid(ctx, w, h, 9, 3);
    
    // 绘制粒子
    this.renderParticles(ctx);
    
    // 绘制角色
    if (state) {
      const cellW = w / 9;
      const cellH = h / 3;
      const scale = Math.min(cellW / 8, cellH / 8) * 6;
      
      const p1Char = state.p1Char || 'warrior';
      const p2Char = state.p2Char || 'warrior';
      
      const p1X = state.p1Pos ? state.p1Pos.x * cellW + cellW * 0.1 : cellW * 0.5;
      const p1Y = state.p1Pos ? state.p1Pos.y * cellH + cellH * 0.2 : h * 0.45;
      const p2X = state.p2Pos ? state.p2Pos.x * cellW + cellW * 0.1 : w - cellW * 1.5;
      const p2Y = state.p2Pos ? state.p2Pos.y * cellH + cellH * 0.2 : h * 0.45;
      
      // P1
      this.drawCharacter(ctx, p1Char, p1X, p1Y, scale * 0.5, true);
      
      // P2
      this.drawCharacter(ctx, p2Char, p2X, p2Y, scale * 0.5, false);
    }
  }

  // 绘制技能图标
  drawSkillIcon(canvas, skillId, size = 32) {
    if (!this.skillData) return;
    const skill = this.skillData.skills.find(s => s.id === skillId);
    if (!skill || !skill.icon) return;
    
    const ctx = canvas.getContext('2d');
    const scale = size / 5;
    
    canvas.width = size;
    canvas.height = size;
    ctx.clearRect(0, 0, size, size);
    
    this.drawSprite(ctx, skill.icon, 0, 0, scale, skill.color, skill.color);
  }

  // 绘制角色头像
  drawCharAvatar(canvas, charId, size = 64) {
    const char = this.getCharacterPixels(charId);
    if (!char) return;
    
    const ctx = canvas.getContext('2d');
    canvas.width = size;
    canvas.height = size;
    ctx.clearRect(0, 0, size, size);
    
    const scale = size / char.width;
    this.drawSprite(ctx, char.pixels, 0, 0, scale, char.color, char.color);
  }

  // 粒子效果系统
  createParticles(x, y, color, count = 10) {
    const particles = [];
    for (let i = 0; i < count; i++) {
      particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 4,
        vy: (Math.random() - 0.5) * 4 - 2,
        life: 1,
        decay: 0.02 + Math.random() * 0.04,
        color,
        size: 2 + Math.random() * 3
      });
    }
    this.particleSystems.push(particles);
  }

  renderParticles(ctx) {
    for (let i = this.particleSystems.length - 1; i >= 0; i--) {
      const particles = this.particleSystems[i];
      for (let j = particles.length - 1; j >= 0; j--) {
        const p = particles[j];
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.1; // 重力
        p.life -= p.decay;
        
        if (p.life <= 0) {
          particles.splice(j, 1);
          continue;
        }
        
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 6;
        ctx.fillRect(p.x, p.y, p.size, p.size);
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
      }
      
      if (particles.length === 0) {
        this.particleSystems.splice(i, 1);
      }
    }
  }

  // 战斗动画步骤渲染
  renderAnimStep(ctx, step, state, w, h) {
    const cellW = w / 9;
    const cellH = h / 3;
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0a1a';
    ctx.fillRect(0, 0, w, h);
    
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, h * 0.75);
    ctx.lineTo(w, h * 0.75);
    ctx.stroke();
    
    this.drawGrid(ctx, w, h, 9, 3);
    
    const p1X = state.p1Pos.x * cellW + cellW * 0.5;
    const p1Y = state.p1Pos.y * cellH + h * 0.1;
    const p2X = state.p2Pos.x * cellW + cellW * 0.5;
    const p2Y = state.p2Pos.y * cellH + h * 0.1;
    
    const scale = Math.min(cellW / 8, cellH / 8) * 5;
    
    this.drawCharacter(ctx, state.p1Char || 'warrior', p1X, p1Y, scale * 0.5, true);
    this.drawCharacter(ctx, state.p2Char || 'warrior', p2X, p2Y, scale * 0.5, false);
    
    // 动画特效
    if (step) {
      switch (step.action) {
        case 'attack':
          const atkX = step.actor === 'P1' ? p2X : p1X;
          const atkY = step.actor === 'P1' ? p2Y : p1Y;
          this.createParticles(atkX + 20, atkY + 20, '#ff4444', 8);
          break;
        case 'skill':
          const skX = step.actor === 'P1' ? p2X : p1X;
          const skY = step.actor === 'P1' ? p2Y : p1Y;
          this.createParticles(skX + 20, skY + 20, '#ff88ff', 15);
          break;
        case 'defend':
          const defX = step.actor === 'P1' ? p1X + 20 : p2X + 20;
          const defY = step.actor === 'P1' ? p1Y + 20 : p2Y + 20;
          this.createParticles(defX, defY, '#4488ff', 5);
          break;
        case 'counter':
          const cntX = step.actor === 'P1' ? p1X + 20 : p2X + 20;
          const cntY = step.actor === 'P1' ? p1Y + 20 : p2Y + 20;
          this.createParticles(cntX, cntY, '#ffff00', 10);
          break;
      }
    }
    
    this.renderParticles(ctx);
  }

  // 主菜单背景动画
  renderMenuBg(ctx, time) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);
    
    // 飘落的像素
    for (let i = 0; i < 30; i++) {
      const x = ((i * 137.508 + time * 0.1) % w);
      const y = ((time * 0.5 + i * 50) % h);
      const alpha = 0.3 + Math.sin(time * 0.001 + i) * 0.2;
      
      ctx.fillStyle = i % 3 === 0 ? '#00ffff' : (i % 3 === 1 ? '#ff00ff' : '#ffff00');
      ctx.globalAlpha = alpha;
      ctx.fillRect(x, y, 4, 4);
    }
    ctx.globalAlpha = 1;
    
    // 网格线闪烁
    const gridSpacing = 40;
    ctx.strokeStyle = `rgba(0, 255, 255, ${0.03 + Math.sin(time * 0.002) * 0.02})`;
    ctx.lineWidth = 1;
    
    for (let x = gridSpacing; x < w; x += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let y = gridSpacing; y < h; y += gridSpacing) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }
}

const renderer = new PixelRenderer();
renderer.init();
