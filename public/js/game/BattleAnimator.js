// ============================================
// BattleAnimator.js — 战斗动画播放器
// ============================================

class BattleAnimator {
    constructor(pixelRenderer) {
        this.renderer = pixelRenderer;
        this.steps = [];
        this.currentStep = 0;
        this.stepDelay = 800;
        this.isPlaying = false;
        this.onStepComplete = null;
        this.onAllComplete = null;
        this.skillDataMap = {};
    }

    setSkillData(skills) {
        skills.forEach(s => {
            this.skillDataMap[s.id] = s;
        });
    }

    loadSteps(steps) {
        this.steps = steps;
        this.currentStep = 0;
    }

    play(onStepComplete, onAllComplete) {
        this.onStepComplete = onStepComplete;
        this.onAllComplete = onAllComplete;
        this.isPlaying = true;
        this.playNextStep();
    }

    playNextStep() {
        if (this.currentStep >= this.steps.length) {
            this.isPlaying = false;
            if (this.onAllComplete) this.onAllComplete();
            return;
        }

        const step = this.steps[this.currentStep];
        this.executeStep(step, () => {
            if (this.onStepComplete) this.onStepComplete(step);
            this.currentStep++;
            setTimeout(() => this.playNextStep(), this.stepDelay);
        });
    }

    executeStep(step, callback) {
        if (!step) { callback(); return; }

        const actions = step.actions || [];
        const results = step.results || [];

        // 1. 移动动画
        actions.forEach(action => {
            if (action.action === 'move' && action.newPosition) {
                this.animateMove(action);
            }
        });

        // 2. 攻击/技能效果
        actions.forEach(action => {
            if (action.action === 'attack' && action.hit) {
                this.animateAttack(action);
            } else if (action.action === 'skill' && action.success) {
                this.animateSkill(action);
            } else if (action.action === 'defend') {
                this.animateDefend(action);
            }
        });

        // 3. 更新 HP
        results.forEach(result => {
            if (result.hpChange !== 0) {
                this.animateHpChange(result);
            }
        });

        // 动画持续时间后回调
        setTimeout(callback, 400);
    }

    animateMove(action) {
        const player = action.playerId === (this.renderer.p1?.id) ? this.renderer.p1 : this.renderer.p2;
        if (player && action.newPosition) {
            player.position = action.newPosition;
        }
    }

    animateAttack(action) {
        const target = action.target === (this.renderer.p1?.id) ? this.renderer.p1 : this.renderer.p2;
        if (target) {
            const tx = target.position.x * this.renderer.pixelSize + this.renderer.pixelSize * 1.5;
            const ty = target.position.y * this.renderer.pixelSize;
            this.renderer.emitParticles(tx, ty, '#ff4444', 10, 4);
            this.renderer.triggerShake(3, 150);
        }
    }

    animateSkill(action) {
        const skillData = this.skillDataMap[action.skillId];
        const neonColor = skillData ? skillData.neonColor : '#ffcc00';

        const caster = action.playerId === (this.renderer.p1?.id) ? this.renderer.p1 : this.renderer.p2;
        const target = action.target === (this.renderer.p1?.id) ? this.renderer.p1 : this.renderer.p2;

        if (target) {
            const tx = target.position.x * this.renderer.pixelSize + this.renderer.pixelSize * 1.5;
            const ty = target.position.y * this.renderer.pixelSize;
            this.renderer.emitParticles(tx, ty, neonColor, 15, 5);
        }

        if (action.heal && caster) {
            const cx = caster.position.x * this.renderer.pixelSize + this.renderer.pixelSize * 1.5;
            const cy = caster.position.y * this.renderer.pixelSize;
            this.renderer.emitParticles(cx, cy, '#ff88ff', 12, 3);
        }

        this.renderer.triggerShake(4, 200);
    }

    animateDefend(action) {
        // 防御效果 — 角色周围短暂发光
    }

    animateHpChange(result) {
        // HP 变化由 BattleUI 处理
    }

    stop() {
        this.isPlaying = false;
        this.steps = [];
    }
}

window.BattleAnimator = BattleAnimator;
