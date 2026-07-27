// ============================================
// PixelRenderer.js — 像素渲染总调度
// ============================================

class PixelRenderer {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');

        this.pixelSize = 12;
        this.gridWidth = 20;
        this.gridHeight = 12;

        this.bgColor = '#0a0a0f';
        this.gridColor = '#111133';

        this.p1 = null;
        this.p2 = null;
        this.spritesData = null;
        this.animationFrame = 0;
        this.animationTimer = 0;

        this.particles = [];
        this.screenShake = { active: false, dx: 0, dy: 0, timer: 0 };

        this.resize();
        window.addEventListener('resize', () => this.resize());

        this.startRenderLoop();
    }

    resize() {
        const container = this.canvas.parentElement;
        const containerWidth = container.clientWidth;
        const aspectRatio = this.gridWidth / this.gridHeight;
        // 设置 canvas 实际像素
        const width = Math.min(containerWidth, 800);
        this.canvas.width = width;
        this.canvas.height = width / aspectRatio;
        this.pixelSize = this.canvas.width / this.gridWidth;
    }

    setPlayers(p1, p2) {
        this.p1 = p1;
        this.p2 = p2;
        // P1 在左边 (x=2)，P2 在右边 (x=17)
        this.p1.position = p1.position || { x: 2, y: 5 };
        this.p2.position = p2.position || { x: 17, y: 5 };
    }

    setCharacterConfigs(p1Char, p2Char) {
        this.p1Char = p1Char;
        this.p2Char = p2Char;
    }

    setSpritesData(data) {
        this.spritesData = data;
    }

    // ==================== 渲染循环 ====================

    startRenderLoop() {
        const loop = () => {
            this.render();
            this.animationTimer++;
            if (this.animationTimer % 30 === 0) {
                this.animationFrame = (this.animationFrame + 1) % 2;
            }
            this.updateParticles();
            this.updateScreenShake();
            requestAnimationFrame(loop);
        };
        loop();
    }

    render() {
        const ctx = this.ctx;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ps = this.pixelSize;

        ctx.save();

        // 屏幕震动
        if (this.screenShake.active) {
            ctx.translate(this.screenShake.dx, this.screenShake.dy);
        }

        // 1. 清空
        ctx.fillStyle = this.bgColor;
        ctx.fillRect(-10, -10, w + 20, h + 20);

        // 2. 网格背景
        this.drawGrid(ctx, w, h, ps);

        // 3. 地面装饰
        this.drawDecorations(ctx, ps);

        // 4. 角色
        if (this.p1) this.drawCharacter(ctx, this.p1, this.p1Char, ps);
        if (this.p2) this.drawCharacter(ctx, this.p2, this.p2Char, ps);

        // 5. 粒子
        this.drawParticles(ctx);

        ctx.restore();
    }

    drawGrid(ctx, w, h, ps) {
        ctx.strokeStyle = this.gridColor;
        ctx.lineWidth = 0.5;
        ctx.globalAlpha = 0.3;

        for (let x = 0; x <= w; x += ps) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (let y = 0; y <= h; y += ps) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;
    }

    drawDecorations(ctx, ps) {
        if (!this.spritesData || !this.spritesData.battlefield) return;
        const decors = this.spritesData.battlefield.grid.decorations;
        if (!decors) return;

        ctx.fillStyle = '#222244';
        ctx.globalAlpha = 0.3;
        decors.forEach(d => {
            ctx.fillText(d.char, d.x * ps + 2, (d.y + 1) * ps - 2);
        });
        ctx.globalAlpha = 1;
    }

    drawCharacter(ctx, player, charConfig, ps) {
        if (!player || !player.isAlive) return;
        if (!charConfig) return;

        const x = player.position.x * ps;
        const y = player.position.y * ps;
        const scale = charConfig.pixelScale || 12;
        const scaleRatio = scale / 12;
        const charPs = ps * scaleRatio;

        const neonColor = charConfig.neonColor || '#00ffff';
        const glowColor = charConfig.glowColor || neonColor + '44';
        const shape = charConfig.shape || 'humanoid';
        const shapeConfig = charConfig.shapeConfig || {};

        // 绘制阴影
        PixelDrawer.drawGroundShadow(ctx, x, y + charPs * 4, charPs * 3, charPs * 6, 0.2);

        // 发光层
        ctx.save();
        ctx.shadowColor = neonColor;
        ctx.shadowBlur = 12 + Math.sin(this.animationTimer * 0.05) * 4; // 呼吸发光
        this.drawCharacterShape(ctx, shape, shapeConfig, x, y, charPs, 0.5);
        ctx.restore();

        // 实体层
        this.drawCharacterShape(ctx, shape, shapeConfig, x, y, charPs, 1);
    }

    drawCharacterShape(ctx, shape, config, x, y, ps, alpha) {
        ctx.globalAlpha = alpha;
        const bodyColor = config.bodyColor || '#00ffff';
        const innerColor = config.innerColor || '#ffffff';
        const outlineColor = config.outlineColor || '#008888';

        ctx.fillStyle = bodyColor;

        switch (shape) {
            case 'humanoid':
                // 头
                ctx.fillRect(x + ps, y, ps, ps);
                // 眼睛
                ctx.fillStyle = config.eyeColor || '#ffffff';
                ctx.fillRect(x + ps + 2, y + 2, ps * 0.3, ps * 0.3);
                ctx.fillRect(x + ps + ps - 4, y + 2, ps * 0.3, ps * 0.3);
                ctx.fillStyle = bodyColor;
                // 身体
                ctx.fillRect(x + ps * 0.5, y + ps, ps * 2, ps * 1.5);
                // 手臂
                ctx.fillRect(x, y + ps * 1.2, ps * 0.5, ps * 1);
                ctx.fillRect(x + ps * 2.5, y + ps * 1.2, ps * 0.5, ps * 1);
                // 腿
                ctx.fillRect(x + ps * 0.5, y + ps * 2.5, ps * 0.8, ps * 1.5);
                ctx.fillRect(x + ps * 1.7, y + ps * 2.5, ps * 0.8, ps * 1.5);
                break;

            case 'circle':
                const cx = x + ps * 1.5;
                const cy = y + ps * 1.5;
                const r = ps * 1.3;
                ctx.beginPath();
                ctx.arc(cx, cy, r, 0, Math.PI * 2);
                ctx.fill();
                // 内圈
                ctx.fillStyle = innerColor;
                ctx.beginPath();
                ctx.arc(cx, cy - 1, r * 0.4, 0, Math.PI * 2);
                ctx.fill();
                break;

            case 'triangle':
                ctx.beginPath();
                ctx.moveTo(x + ps * 1.5, y);
                ctx.lineTo(x, y + ps * 3);
                ctx.lineTo(x + ps * 3, y + ps * 3);
                ctx.closePath();
                ctx.fill();
                // 内三角
                ctx.fillStyle = innerColor;
                ctx.beginPath();
                ctx.moveTo(x + ps * 1.5, y + ps * 0.8);
                ctx.lineTo(x + ps * 0.8, y + ps * 2.2);
                ctx.lineTo(x + ps * 2.2, y + ps * 2.2);
                ctx.closePath();
                ctx.fill();
                break;

            case 'square':
                ctx.fillRect(x + ps * 0.3, y + ps * 0.3, ps * 2.4, ps * 2.4);
                // 脸
                ctx.fillStyle = config.faceColor || innerColor;
                ctx.fillRect(x + ps * 0.8, y + ps * 0.8, ps * 1.4, ps * 1.4);
                // 眼睛
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(x + ps, y + ps, ps * 0.4, ps * 0.3);
                ctx.fillRect(x + ps * 1.6, y + ps, ps * 0.4, ps * 0.3);
                break;
        }
        ctx.globalAlpha = 1;
    }

    // ==================== 粒子系统 ====================

    emitParticles(x, y, color, count, spread = 3) {
        for (let i = 0; i < count; i++) {
            this.particles.push({
                x: x,
                y: y,
                vx: (Math.random() - 0.5) * spread * 2,
                vy: (Math.random() - 0.5) * spread * 2 - 1,
                color: color,
                life: 20 + Math.random() * 20,
                maxLife: 40,
                size: 2 + Math.random() * 3
            });
        }
    }

    updateParticles() {
        this.particles = this.particles.filter(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.1; // 重力
            p.life--;
            return p.life > 0;
        });
    }

    drawParticles(ctx) {
        this.particles.forEach(p => {
            const alpha = p.life / p.maxLife;
            PixelDrawer.drawPixel(ctx, p.x, p.y, p.size, p.color, alpha);
        });
    }

    // ==================== 屏幕震动 ====================

    triggerShake(intensity = 4, duration = 200) {
        this.screenShake.active = true;
        this.screenShake.intensity = intensity;
        this.screenShake.timer = duration;
    }

    updateScreenShake() {
        if (!this.screenShake.active) return;
        this.screenShake.timer -= 16; // ~60fps
        if (this.screenShake.timer <= 0) {
            this.screenShake.active = false;
            this.screenShake.dx = 0;
            this.screenShake.dy = 0;
        } else {
            const i = this.screenShake.intensity;
            this.screenShake.dx = (Math.random() - 0.5) * i * 2;
            this.screenShake.dy = (Math.random() - 0.5) * i * 2;
        }
    }

    // ==================== 伤害数字 ====================

    drawDamageNumber(ctx, x, y, damage, color = '#ff4444') {
        ctx.save();
        ctx.fillStyle = color;
        ctx.font = `bold ${this.pixelSize * 2}px "Press Start 2P", monospace`;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8;
        ctx.fillText(`-${damage}`, x, y);
        ctx.restore();
    }

    drawHealNumber(ctx, x, y, amount) {
        ctx.save();
        ctx.fillStyle = '#00ff88';
        ctx.font = `bold ${this.pixelSize * 2}px "Press Start 2P", monospace`;
        ctx.shadowColor = '#00ff88';
        ctx.shadowBlur = 8;
        ctx.fillText(`+${amount}`, x, y);
        ctx.restore();
    }
}

window.PixelRenderer = PixelRenderer;
