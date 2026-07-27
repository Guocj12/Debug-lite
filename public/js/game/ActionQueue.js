// ============================================
// ActionQueue.js — 行动队列数据结构 + 编辑逻辑
// ============================================

class ActionQueue {
    constructor() {
        this.queue = [];
        this.selectedIndex = -1;
    }

    add(action) {
        this.queue.push({ ...action });
        this.selectedIndex = -1;
    }

    remove(index) {
        if (index >= 0 && index < this.queue.length) {
            this.queue.splice(index, 1);
            if (this.selectedIndex >= this.queue.length) {
                this.selectedIndex = -1;
            }
        }
    }

    removeSelected() {
        if (this.selectedIndex >= 0) {
            this.remove(this.selectedIndex);
        }
    }

    clear() {
        this.queue = [];
        this.selectedIndex = -1;
    }

    select(index) {
        if (index === this.selectedIndex) {
            this.selectedIndex = -1; // 取消选中
        } else {
            this.selectedIndex = index;
        }
    }

    getSelected() {
        if (this.selectedIndex >= 0 && this.selectedIndex < this.queue.length) {
            return this.queue[this.selectedIndex];
        }
        return null;
    }

    getLength() {
        return this.queue.length;
    }

    getAll() {
        return [...this.queue];
    }

    getActionLabel(action) {
        switch (action.action) {
            case 'move':
                const dirMap = { left: '←左', right: '→右', up: '↑上', down: '↓下' };
                return dirMap[action.direction] || '移动';
            case 'attack':
                return '⚔攻击';
            case 'defend':
                return '🛡防御';
            case 'skill':
                return `✨${action.skillName || action.skillId}`;
            default:
                return action.action;
        }
    }

    getActionType(action) {
        return action.action;
    }
}

window.ActionQueue = ActionQueue;
