// ============================================
// BattleUI.js — 战斗界面
// ============================================

class BattleUI {
    constructor() {
        this.panel = document.getElementById('panel-battle');
        this.actionFeed = document.getElementById('action-feed');
        this.roundText = document.getElementById('round-text');

        // HP 条
        this.p1HpFill = document.getElementById('p1-hp-fill');
        this.p1HpText = document.getElementById('p1-hp-text');
        this.p2HpFill = document.getElementById('p2-hp-fill');
        this.p2HpText = document.getElementById('p2-hp-text');
        this.p1Name = document.getElementById('p1-name');
        this.p2Name = document.getElementById('p2-name');

        // 渲染器
        this.renderer = null;
        this.animator = null;

        this.myPlayer = null;
        this.opponentPlayer = null;
        this.myCharConfig = null;
        this.oppCharConfig = null;
        this.round = 1;

        this.battleSteps = [];
        this.currentHp = {};
    }

    init(myPlayer, opponentPlayer, myCharConfig, oppCharConfig, skillsData, spritesData) {
        this.myPlayer = myPlayer;
        this.opponentPlayer = opponentPlayer;
        this.myCharConfig = myCharConfig;
        this.oppCharConfig = oppCharConfig;

        // 更新名字
        this.p1Name.textContent = myPlayer.name;
        this.p2Name.textContent = opponentPlayer.name;

        // 更新 HP
        this.currentHp[myPlayer.id] = myPlayer.hp;
        this.currentHp[opponentPlayer.id] = opponentPlayer.hp;
        this.updateHpBars();

        // 初始化渲染器
        if (!this.renderer) {
            this.renderer = new PixelRenderer('battle-canvas');
        }
        this.renderer.setSpritesData(spritesData);
        this.renderer.setPlayers(myPlayer, opponentPlayer);
        this.renderer.setCharacterConfigs(myCharConfig, oppCharConfig);

        // 初始化动画器
        if (!this.animator) {
            this.animator = new BattleAnimator(this.renderer);
        }
        this.animator.setSkillData(skillsData);
    }

    setRound(round) {
        this.round = round;
        this.roundText.textContent = `回合 ${round}`;
    }

    updateHpBars() {
        const myHp = this.currentHp[this.myPlayer?.id] || 100;
        const oppHp = this.currentHp[this.opponentPlayer?.id] || 100;
        const myMaxHp = this.myPlayer?.maxHp || 100;
        const oppMaxHp = this.opponentPlayer?.maxHp || 100;

        const myPct = Math.max(0, (myHp / myMaxHp) * 100);
        const oppPct = Math.max(0, (oppHp / oppMaxHp) * 100);

        this.p1HpFill.style.width = myPct + '%';
        this.p2HpFill.style.width = oppPct + '%';
        this.p1HpText.textContent = `${Math.max(0, Math.round(myHp))}/${myMaxHp}`;
        this.p2HpText.textContent = `${Math.max(0, Math.round(oppHp))}/${oppMaxHp}`;

        // 低血量变色
        if (myPct < 30) {
            this.p1HpFill.style.background = 'linear-gradient(90deg, #ff0000, #ff4444)';
        }
        if (oppPct < 30) {
            this.p2HpFill.style.background = 'linear-gradient(90deg, #ff0000, #ff4444)';
        }
    }

    playBattleActions(steps) {
        this.battleSteps = steps;
        this.actionFeed.innerHTML = '';

        this.animator.loadSteps(steps);
        this.animator.play(
            (step) => {
                // 每步回调
                this.onStepPlayed(step);
            },
            () => {
                // 全部完成
                this.actionFeed.innerHTML = '<p style="color:#00ff88">回合结束 ⏳</p>';
            }
        );
    }

    onStepPlayed(step) {
        if (!step) return;

        const actions = step.actions || [];
        const results = step.results || [];

        // 更新 feed
        actions.forEach(action => {
            let msg = '';
            const player = action.playerId === this.myPlayer?.id ? '你' : '对手';

            if (action.action === 'move' && action.newPosition) {
                const dirMap = { left: '←', right: '→', up: '↑', down: '↓' };
                msg = `${player} 移动 ${dirMap[action.direction] || ''}`;
            } else if (action.action === 'attack' && action.hit) {
                msg = `${player} ⚔攻击! 造成 ${action.damage} 伤害`;
            } else if (action.action === 'skill' && action.success) {
                if (action.damage) {
                    msg = `${player} ${action.skillIcon || '✨'}${action.skillName}! 造成 ${action.damage} 伤害`;
                } else if (action.heal) {
                    msg = `${player} ${action.skillIcon || '💚'}${action.skillName}! 恢复 ${action.heal} HP`;
                } else {
                    msg = `${player} ${action.skillIcon || '✨'}${action.skillName}!`;
                }
            } else if (action.action === 'defend') {
                msg = `${player} 🛡防御!`;
            }

            if (msg) {
                this.appendFeed(msg);
            }
        });

        // 更新 HP
        results.forEach(result => {
            this.currentHp[result.playerId] = result.newHp;
        });
        this.updateHpBars();

        // 更新角色位置
        if (this.renderer.p1 && this.renderer.p2) {
            this.renderer.p1.position = { ...this.myPlayer.position };
            this.renderer.p2.position = { ...this.opponentPlayer.position };
        }
    }

    appendFeed(msg) {
        const div = document.createElement('p');
        div.textContent = msg;
        div.style.color = '#e0e0ff';
        div.style.margin = '2px 0';
        div.style.fontSize = '12px';
        this.actionFeed.appendChild(div);
        this.actionFeed.scrollTop = this.actionFeed.scrollHeight;
    }

    updatePositions(p1Pos, p2Pos) {
        if (this.renderer.p1) this.renderer.p1.position = { ...p1Pos };
        if (this.renderer.p2) this.renderer.p2.position = { ...p2Pos };
    }

    show() {
        switchPanel('battle');
    }

    hide() {}
}

window.BattleUI = BattleUI;
