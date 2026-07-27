// ============================================
// PixelDrawer.js — 像素绘图工具函数
// 所有视觉渲染的底层基础
// ============================================

class PixelDrawer {
    /**
     * 绘制单个像素格子
     */
    static drawPixel(ctx, x, y, size, color, alpha = 1) {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(x), Math.round(y), size, size);
        ctx.globalAlpha = 1;
    }

    /**
     * 从字符串数组绘制像素精灵
     * spriteData: { width, height, pixels: string[], glowPixels?: string[] }
     */
    static drawSprite(ctx, spriteData, x, y, pixelSize, colorMap, frame = 0) {
        const pixels = spriteData.pixels;
        if (!pixels || pixels.length === 0) return;

        for (let row = 0; row < pixels.length; row++) {
            const line = pixels[row];
            for (let col = 0; col < line.length; col++) {
                const char = line[col];
                if (char === '.') continue;

                const color = colorMap[char];
                if (!color) continue;

                const px = x + col * pixelSize;
                const py = y + row * pixelSize;
                this.drawPixel(ctx, px, py, pixelSize, color, 1);
            }
        }
    }

    /**
     * 从 sprite 数据绘制不同帧
     */
    static drawSpriteFrame(ctx, frames, frameIndex, x, y, pixelSize, colorMap) {
        const frameData = frames[frameIndex];
        if (!frameData) return;
        this.drawSprite(ctx, { pixels: frameData, width: frameData[0].length, height: frameData.length }, x, y, pixelSize, colorMap);
    }

    /**
     * 绘制发光层
     */
    static drawGlowLayer(ctx, spriteData, x, y, pixelSize, glowColor, blurRadius = 12) {
        ctx.save();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = blurRadius;

        const pixels = spriteData.glowPixels || spriteData.pixels;
        if (!pixels) { ctx.restore(); return; }

        for (let row = 0; row < pixels.length; row++) {
            const line = pixels[row];
            for (let col = 0; col < line.length; col++) {
                const char = line[col];
                if (char === '.') continue;

                const px = x + col * pixelSize;
                const py = y + row * pixelSize;
                ctx.fillStyle = glowColor;
                ctx.fillRect(Math.round(px), Math.round(py), pixelSize, pixelSize);
            }
        }

        ctx.restore();
    }

    /**
     * 带霓虹发光的双层绘制
     */
    static drawWithNeonGlow(ctx, drawFn, glowColor, glowRadius = 15) {
        // 发光层
        ctx.save();
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = glowRadius;
        drawFn();
        ctx.restore();
        // 实体层
        drawFn();
    }

    /**
     * 绘制像素文字（用于 UI 标签）
     */
    static drawPixelText(ctx, text, x, y, pixelSize, color) {
        ctx.fillStyle = color;
        ctx.font = `${pixelSize * 2}px "Press Start 2P", monospace`;
        ctx.fillText(text, x, y);
    }

    /**
     * 绘制网格背景
     */
    static drawGridBackground(ctx, canvasWidth, canvasHeight, gridSize, bgColor, gridColor) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);

        ctx.strokeStyle = gridColor;
        ctx.lineWidth = 0.5;

        for (let x = 0; x <= canvasWidth; x += gridSize) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, canvasHeight);
            ctx.stroke();
        }

        for (let y = 0; y <= canvasHeight; y += gridSize) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(canvasWidth, y);
            ctx.stroke();
        }
    }

    /**
     * 绘制地面阴影
     */
    static drawGroundShadow(ctx, x, y, width, height, alpha = 0.3) {
        ctx.fillStyle = '#000000';
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.ellipse(x + width / 2, y + height, width / 2, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    }
}

// 全局暴露
window.PixelDrawer = PixelDrawer;
