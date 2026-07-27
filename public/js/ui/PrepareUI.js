// ============================================
// PrepareUI.js — 准备阶段界面（核心交互）
// ============================================

class PrepareUI {
    constructor() {
        this.actionQueue = null;
        this.mySkills = [];
        this.confirmed = false;
        this.panel = document.getElementById('panel-prepare');
        this.timerEl = document.getElementById('prepare-timer');
        this.opponentStatusEl = document.getElementById('opponent-queue-status');
        this.queueDisplay = document.getElementById('action-queue-display');
        this.confirmedBadge = document.getElementById('queue-confirmed-badge');
        this.skillButtonsContainer = document.getElementById('skill-buttons');

        // 控制按钮
        this.deleteBtn = document.getElementById('btn-delete-action');
        this.clearBtn = document.getElementById('btn-clear-queue');
        this.confirmBtn = document.getElementById('btn-confirm-queue');

        this.setupEvents();
    }

    setupEvents() {
        // 行动按钮
        document.querySelectorAll('.action-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                if (this.confirmed) return;
                const action = btn.dataset.action;
                const direction = btn.dataset.direction;
                const skillId = btn.dataset.skillId;
                const skillName = btn.dataset.skillName;

                const actionObj = { action };
                if (direction) actionObj.direction = direction;
                if (skillId) {
                    actionObj.skillId = skillId;
                    actionObj.skillName = skillName;
                }

                this.actionQueue.add(actionObj);
                this.renderQueue();
                this.sendQueueUpdate();
            });
        });

        this.deleteBtn.addEventListener('click', () => {
            if (this.confirmed) return;
            this.actionQueue.removeSelected();
            this.renderQueue();
            this.sendQueueUpdate();
        });

        this.clearBtn.addEventListener('click', () => {
            if (this.confirmed) return;
            this.actionQueue.clear();
            this.renderQueue();
            this.sendQueueUpdate();
        });

        this.confirmBtn.addEventListener('click', () => {
            if (this.confirmed) return;
            this.confirmQueue();
        });
    }

    init(mySkillsData) {
        this.actionQueue = new ActionQueue();
        this.mySkills = mySkillsData || [];
        this.confirmed = false;
        this.confirmedBadge.classList.add('hidden');
        this.confirmBtn.disabled = false;
        this.renderSkillButtons();
        this.renderQueue();
        this.deleteBtn.disabled = true;
    }

    renderSkillButtons() {
        this.skillButtonsContainer.innerHTML = '';
        this.mySkills.forEach(skill => {
            const btn = document.createElement('button');
            btn.className = 'action-btn';
            btn.style.borderColor = skill.neonColor || '#ffcc00';
            btn.style.color = skill.neonColor || '#ffcc00';
            btn.dataset.action = 'skill';
            btn.dataset.skillId = skill.id;
            btn.dataset.skillName = skill.name;

            let cdText = '';
            if (skill._cooldown > 0) {
                btn.style.opacity = '0.4';
                btn.disabled = true;
                cdText = ` [CD:${skill._cooldown}]`;
            }

            btn.innerHTML = `${skill.icon} ${skill.name}${cdText}`;

            btn.addEventListener('mouseenter', () => {
                btn.style.background = (skill.neonColor || '#ffcc00') + '22';
                btn.style.boxShadow = `0 0 10px ${skill.neonColor || '#ffcc00'}`;
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.background = 'transparent';
                btn.style.boxShadow = 'none';
            });

            btn.addEventListener('click', () => {
                if (this.confirmed) return;
                if (skill._cooldown > 0) {
                    showToast('技能冷却中');
                    return;
                }
                this.actionQueue.add({
                    action: 'skill',
                    skillId: skill.id,
                    skillName: skill.name
                });
                this.renderQueue();
                this.sendQueueUpdate();
            });

            this.skillButtonsContainer.appendChild(btn);
        });
    }

    renderQueue() {
        this.queueDisplay.innerHTML = '';
        if (this.actionQueue.getLength() === 0) {
            this.queueDisplay.innerHTML = '<p class="empty-hint">从下方按钮添加行动</p>';
            this.deleteBtn.disabled = true;
            return;
        }

        this.actionQueue.queue.forEach((action, index) => {
            const item = document.createElement('div');
            item.className = `queue-item ${this.actionQueue.getActionType(action)}`;
            if (index === this.actionQueue.selectedIndex) {
                item.classList.add('selected');
            }
            item.textContent = this.actionQueue.getActionLabel(action);

            item.addEventListener('click', () => {
                if (this.confirmed) return;
                this.actionQueue.select(index);
                this.renderQueue();
                this.deleteBtn.disabled = this.actionQueue.selectedIndex < 0;
            });

            this.queueDisplay.appendChild(item);
        });

        this.deleteBtn.disabled = this.actionQueue.selectedIndex < 0;
    }

    sendQueueUpdate() {
        socket.emit('update_queue', { queue: this.actionQueue.getAll() });
    }

    confirmQueue() {
        this.confirmed = true;
        this.confirmedBadge.classList.remove('hidden');
        this.confirmBtn.disabled = true;
        socket.emit('confirm_queue', {});
    }

    setTimer(timeLeft) {
        this.timerEl.textContent = timeLeft;
        if (timeLeft <= 10) {
            this.timerEl.style.color = '#ff4444';
            this.timerEl.style.textShadow = '0 0 10px #ff4444';
        } else {
            this.timerEl.style.color = '#00ffff';
            this.timerEl.style.textShadow = '0 0 10px #00ffff';
        }
    }

    setOpponentStatus(length, confirmed) {
        this.opponentStatusEl.textContent = `对手: 队列 ${length} | ${confirmed ? '已确认 ✓' : '编辑中...'}`;
        if (confirmed) {
            this.opponentStatusEl.style.color = '#00ff88';
        } else {
            this.opponentStatusEl.style.color = '#ffaa00';
        }
    }

    show() {
        switchPanel('prepare');
    }

    hide() {}
}

window.PrepareUI = PrepareUI;
