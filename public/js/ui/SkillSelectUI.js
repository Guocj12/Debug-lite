// ============================================
// SkillSelectUI.js — 技能选择面板
// ============================================

class SkillSelectUI {
    constructor() {
        this.skills = [];
        this.maxSlots = 3;
        this.selectedSkills = [];
        this.confirmed = false;

        this.panel = document.getElementById('panel-skill-select');
        this.skillList = document.getElementById('skill-list');
        this.confirmBtn = document.getElementById('btn-confirm-skills');
        this.countSpan = document.getElementById('skill-select-count');
        this.maxSlotsSpan = document.getElementById('max-skill-slots');

        this.confirmBtn.addEventListener('click', () => this.confirmSkills());
    }

    init(skillsData, maxSlots) {
        this.skills = skillsData;
        this.maxSlots = maxSlots || 3;
        this.selectedSkills = [];
        this.confirmed = false;
        this.maxSlotsSpan.textContent = this.maxSlots;
        this.renderSkills();
        this.updateConfirmButton();
    }

    renderSkills() {
        this.skillList.innerHTML = '';
        this.skills.forEach(skill => {
            const card = document.createElement('div');
            card.className = 'skill-card';
            card.dataset.skillId = skill.id;

            const effectText = skill.effects
                ? skill.effects.map(e => {
                    switch (e.type) {
                        case 'stun': return `眩晕${e.duration}回合`;
                        case 'poison': return `中毒${e.duration}回合`;
                        case 'attack_up': return `攻击+${e.value}%`;
                        case 'defense_up': return `防御+${e.value}%`;
                        default: return e.type;
                    }
                }).join(', ')
                : '';

            card.innerHTML = `
                <div class="skill-icon">${skill.icon}</div>
                <div class="skill-name">${skill.name}</div>
                <div class="skill-desc">${this.formatDescription(skill)}</div>
                ${effectText ? `<div class="skill-desc" style="color:#ffaa00">${effectText}</div>` : ''}
                <div class="skill-cd">⏳ 冷却: ${skill.cooldown}回合</div>
            `;

            card.addEventListener('click', () => this.toggleSkill(skill.id, card));
            this.skillList.appendChild(card);
        });
    }

    formatDescription(skill) {
        let desc = skill.description;
        if (skill.damage) desc = desc.replace('{damage}', skill.damage);
        if (skill.healAmount) desc = desc.replace('{healAmount}', skill.healAmount);
        if (skill.distance) desc = desc.replace('{distance}', skill.distance);
        if (skill.dotDamage) desc = desc.replace('{dotDamage}', skill.dotDamage);
        if (skill.duration) desc = desc.replace('{duration}', skill.duration);
        if (skill.effects) {
            const atkUp = skill.effects.find(e => e.type === 'attack_up');
            if (atkUp) desc = desc.replace('{value}', atkUp.value);
        }
        return desc;
    }

    toggleSkill(skillId, card) {
        if (this.confirmed) return;

        const index = this.selectedSkills.indexOf(skillId);
        if (index >= 0) {
            this.selectedSkills.splice(index, 1);
            card.classList.remove('selected');
        } else {
            if (this.selectedSkills.length >= this.maxSlots) {
                showToast(`最多选择 ${this.maxSlots} 个技能`);
                return;
            }
            this.selectedSkills.push(skillId);
            card.classList.add('selected');
        }
        this.updateConfirmButton();
    }

    updateConfirmButton() {
        this.countSpan.textContent = `已选 ${this.selectedSkills.length}/${this.maxSlots}`;
        this.confirmBtn.disabled = this.selectedSkills.length === 0 || this.confirmed;
    }

    confirmSkills() {
        if (this.selectedSkills.length === 0) {
            showToast('请至少选择一个技能');
            return;
        }
        this.confirmed = true;
        this.confirmBtn.disabled = true;
        socket.emit('select_skills', { skillIds: this.selectedSkills });
    }

    show() {
        switchPanel('skill-select');
    }

    hide() {}
}

window.SkillSelectUI = SkillSelectUI;
