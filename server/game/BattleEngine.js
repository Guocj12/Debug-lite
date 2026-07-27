const SKILLS = require('../data/skills.json');

class BattleEngine {
    constructor() {
        this.BATTLEFIELD_WIDTH = 20;
        this.BATTLEFIELD_HEIGHT = 12;
        this.skillsMap = {};
        for (const skill of SKILLS.skills) {
            this.skillsMap[skill.id] = skill;
        }
    }

    // ==================== 回合执行 ====================

    executeRound(playerA, playerB, roomId) {
        const maxLen = Math.max(playerA.actionQueue.length, playerB.actionQueue.length);
        const battleLog = [];

        for (let step = 0; step < maxLen; step++) {
            let aAction = playerA.actionQueue[step] || { action: 'idle' };
            let bAction = playerB.actionQueue[step] || { action: 'idle' };

            // 眩晕检查
            const aStunned = this.hasBuff(playerA, 'stun');
            const bStunned = this.hasBuff(playerB, 'stun');

            const effectiveA = aStunned ? { action: 'idle' } : aAction;
            const effectiveB = bStunned ? { action: 'idle' } : bAction;

            const actionsThisStep = [];
            const resultsThisStep = [];

            // 第1步：移动
            const moveResults = this.resolveMovements(playerA, effectiveA, playerB, effectiveB);
            if (moveResults.a) actionsThisStep.push(moveResults.a);
            if (moveResults.b) actionsThisStep.push(moveResults.b);

            // 第2步：战斗行动
            const combatA = this.resolveAction(playerA, effectiveA, playerB);
            const combatB = this.resolveAction(playerB, effectiveB, playerA);

            if (combatA) actionsThisStep.push(combatA);
            if (combatB) actionsThisStep.push(combatB);

            // 记录结果
            resultsThisStep.push({
                playerId: playerA.id,
                hpChange: 0,
                newHp: playerA.hp,
                newPosition: { ...playerA.position }
            });
            resultsThisStep.push({
                playerId: playerB.id,
                hpChange: 0,
                newHp: playerB.hp,
                newPosition: { ...playerB.position }
            });

            // 应用持续效果
            this.applyBuffsTick(playerA, playerB, resultsThisStep);

            // 检查死亡
            if (playerA.hp <= 0) { playerA.hp = 0; playerA.isAlive = false; }
            if (playerB.hp <= 0) { playerB.hp = 0; playerB.isAlive = false; }

            const stepLog = {
                stepIndex: step,
                actions: actionsThisStep,
                results: resultsThisStep
            };

            battleLog.push(stepLog);

            if (!playerA.isAlive || !playerB.isAlive) break;
        }

        this.endRound(playerA, playerB);
        return battleLog;
    }

    // ==================== 移动判定 ====================

    resolveMovements(pA, actionA, pB, actionB) {
        const results = { a: null, b: null };
        const aMoves = actionA.action === 'move';
        const bMoves = actionB.action === 'move';

        let newPosA = null;
        let newPosB = null;

        if (aMoves) {
            newPosA = this.getNewPosition(pA.position, actionA.direction);
        }
        if (bMoves) {
            newPosB = this.getNewPosition(pB.position, actionB.direction);
        }

        // 冲突检测：两人移动到同一格
        const collision = aMoves && bMoves &&
            newPosA && newPosB &&
            newPosA.x === newPosB.x && newPosA.y === newPosB.y;

        if (aMoves && newPosA && this.isInBounds(newPosA) && !collision) {
            pA.position = newPosA;
            results.a = {
                playerId: pA.id,
                action: 'move',
                direction: actionA.direction,
                newPosition: { ...newPosA }
            };
        }

        if (bMoves && newPosB && this.isInBounds(newPosB) && !collision) {
            pB.position = newPosB;
            results.b = {
                playerId: pB.id,
                action: 'move',
                direction: actionB.direction,
                newPosition: { ...newPosB }
            };
        }

        return results;
    }

    getNewPosition(pos, direction) {
        const newPos = { x: pos.x, y: pos.y };
        switch (direction) {
            case 'left': newPos.x--; break;
            case 'right': newPos.x++; break;
            case 'up': newPos.y--; break;
            case 'down': newPos.y++; break;
        }
        return newPos;
    }

    isInBounds(pos) {
        return pos.x >= 0 && pos.x < this.BATTLEFIELD_WIDTH &&
               pos.y >= 0 && pos.y < this.BATTLEFIELD_HEIGHT;
    }

    // ==================== 行动解析 ====================

    resolveAction(actor, action, target) {
        switch (action.action) {
            case 'attack':
                return this.resolveAttack(actor, target);
            case 'defend':
                return this.resolveDefend(actor);
            case 'skill':
                return this.resolveSkill(actor, target, action.skillId);
            case 'idle':
                return null;
            default:
                return null;
        }
    }

    // ==================== 普通攻击 ====================

    resolveAttack(attacker, defender) {
        const distance = this.getDistance(attacker.position, defender.position);
        if (distance > 1) {
            return {
                playerId: attacker.id,
                action: 'attack',
                hit: false,
                reason: 'out_of_range'
            };
        }

        const defenderDefending = defender.isDefending;
        const defenseMultiplier = defenderDefending ? 0.4 : 1.0;

        let damage = attacker.baseAttack;
        damage *= this.getAttackMultiplier(attacker);
        damage *= this.getDefenseMultiplier(defender);
        damage *= defenseMultiplier;
        damage -= defender.baseDefense * 0.3;

        damage = Math.max(1, Math.round(damage));

        defender.hp -= damage;
        attacker.stats.damageDealt += damage;
        defender.stats.damageTaken += damage;

        return {
            playerId: attacker.id,
            action: 'attack',
            hit: true,
            damage: damage,
            target: defender.id,
            targetHp: defender.hp
        };
    }

    // ==================== 防御 ====================

    resolveDefend(actor) {
        actor.isDefending = true;
        return {
            playerId: actor.id,
            action: 'defend',
            effect: 'shield_up'
        };
    }

    // ==================== 技能释放 ====================

    resolveSkill(caster, target, skillId) {
        const skillData = this.skillsMap[skillId];
        if (!skillData) {
            return { playerId: caster.id, action: 'skill', skillId, success: false, reason: 'unknown_skill' };
        }

        // 冷却检查
        if (caster.skillCooldowns[skillId] && caster.skillCooldowns[skillId] > 0) {
            return { playerId: caster.id, action: 'skill', skillId, success: false, reason: 'on_cooldown' };
        }

        // 距离检查
        if (skillData.range && this.getDistance(caster.position, target.position) > skillData.range) {
            return { playerId: caster.id, action: 'skill', skillId, success: false, reason: 'out_of_range' };
        }

        const result = {
            playerId: caster.id,
            action: 'skill',
            skillId: skillId,
            skillName: skillData.name,
            skillIcon: skillData.icon,
            skillType: skillData.type,
            pixelAnimation: skillData.pixelAnimation,
            neonColor: skillData.neonColor,
            success: true
        };

        switch (skillData.type) {
            case 'attack': {
                let dmg = this.calculateSkillDamage(caster, target, skillData);
                target.hp -= dmg;
                caster.stats.damageDealt += dmg;
                target.stats.damageTaken += dmg;
                result.damage = dmg;
                result.target = target.id;

                // 击退
                if (skillData.knockback) {
                    const kbResult = this.applyKnockback(caster, target, skillData.knockback);
                    result.knockback = kbResult;
                }
                // 吸血
                if (skillData.lifeSteal) {
                    const heal = Math.round(dmg * skillData.lifeSteal);
                    caster.hp = Math.min(caster.maxHp, caster.hp + heal);
                    result.lifeSteal = heal;
                }
                // 附加效果
                if (skillData.effects) {
                    this.applyBuffs(target, skillData.effects);
                    result.effects = skillData.effects;
                }
                break;
            }
            case 'defense': {
                caster.isDefending = true;
                if (skillData.effects) {
                    this.applyBuffs(caster, skillData.effects);
                    result.effects = skillData.effects;
                }
                break;
            }
            case 'heal': {
                const healAmount = skillData.healAmount || 0;
                caster.hp = Math.min(caster.maxHp, caster.hp + healAmount);
                caster.stats.healingDone += healAmount;
                result.heal = healAmount;
                break;
            }
            case 'movement': {
                const dist = skillData.distance || 2;
                const dir = this.getDirectionToward(caster.position, target.position);
                let newPos = caster.position;
                for (let i = 0; i < dist; i++) {
                    const nextPos = this.getNewPosition(newPos, dir);
                    if (this.isInBounds(nextPos)) {
                        newPos = nextPos;
                    }
                }
                caster.position = newPos;
                result.teleportTo = { ...newPos };
                break;
            }
            case 'buff': {
                if (skillData.effects) {
                    this.applyBuffs(caster, skillData.effects);
                    result.effects = skillData.effects;
                }
                break;
            }
            case 'debuff': {
                if (skillData.effects) {
                    this.applyBuffs(target, skillData.effects);
                    result.effects = skillData.effects;
                    result.target = target.id;
                }
                if (skillData.damage) {
                    target.hp -= skillData.damage;
                    result.damage = skillData.damage;
                    result.target = target.id;
                }
                break;
            }
        }

        // 自伤
        if (skillData.selfDamage > 0) {
            caster.hp -= skillData.selfDamage;
            result.selfDamage = skillData.selfDamage;
        }

        // 设置冷却
        caster.skillCooldowns[skillId] = skillData.cooldown;
        caster.stats.skillsUsed++;

        return result;
    }

    calculateSkillDamage(caster, target, skillData) {
        let damage = skillData.damage || 0;
        const attackMult = this.getAttackMultiplier(caster);

        if (skillData.ignoreDefense) {
            damage *= attackMult;
        } else {
            const defenseMult = this.getDefenseMultiplier(target);
            const defendMult = target.isDefending ? 0.4 : 1.0;
            damage *= attackMult * defenseMult * defendMult;
            damage -= target.baseDefense * 0.3;
        }

        return Math.max(1, Math.round(damage));
    }

    // ==================== 击退 ====================

    applyKnockback(caster, target, distance) {
        const dir = this.getDirectionFrom(caster.position, target.position);
        let newPos = { ...target.position };
        for (let i = 0; i < distance; i++) {
            const next = this.getNewPosition(newPos, dir);
            if (this.isInBounds(next)) {
                newPos = next;
            } else {
                break;
            }
        }
        const oldPos = { ...target.position };
        target.position = newPos;
        return { from: oldPos, to: { ...newPos } };
    }

    // ==================== Buff 系统 ====================

    applyBuffs(player, effects) {
        for (const effect of effects) {
            const existing = player.buffs.find(b => b.type === effect.type);
            if (existing) {
                existing.remainingDuration = effect.duration;
                existing.value = effect.value || effect.damagePerTurn || existing.value;
            } else {
                player.buffs.push({
                    type: effect.type,
                    value: effect.value || effect.damagePerTurn || 0,
                    remainingDuration: effect.duration
                });
            }
        }
    }

    applyBuffsTick(playerA, playerB, resultsThisStep) {
        for (const player of [playerA, playerB]) {
            for (const buff of player.buffs) {
                switch (buff.type) {
                    case 'poison':
                    case 'burn':
                    case 'bleed': {
                        const dot = buff.value || 5;
                        player.hp -= dot;
                        const resultEntry = resultsThisStep.find(r => r.playerId === player.id);
                        if (resultEntry) {
                            resultEntry.hpChange -= dot;
                            resultEntry.newHp = player.hp;
                        }
                        break;
                    }
                }
                buff.remainingDuration--;
            }
            player.buffs = player.buffs.filter(b => b.remainingDuration > 0);
        }
    }

    hasBuff(player, buffType) {
        return player.buffs.some(b => b.type === buffType);
    }

    getAttackMultiplier(player) {
        let mult = 1.0;
        for (const b of player.buffs) {
            if (b.type === 'attack_up') mult *= (1 + b.value / 100);
            if (b.type === 'attack_down') mult *= (1 - b.value / 100);
        }
        return mult;
    }

    getDefenseMultiplier(player) {
        let mult = 1.0;
        for (const b of player.buffs) {
            if (b.type === 'defense_up') mult *= (1 - b.value / 100);
            if (b.type === 'defense_down') mult *= (1 + b.value / 100);
            if (b.type === 'damage_reduction') mult *= (1 - b.value / 100);
        }
        return Math.max(0.1, mult);
    }

    // ==================== 工具函数 ====================

    getDistance(posA, posB) {
        return Math.abs(posA.x - posB.x) + Math.abs(posA.y - posB.y);
    }

    getDirectionFrom(from, to) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        if (Math.abs(dx) >= Math.abs(dy)) {
            return dx >= 0 ? 'right' : 'left';
        } else {
            return dy >= 0 ? 'down' : 'up';
        }
    }

    getDirectionToward(from, to) {
        return this.getDirectionFrom(from, to);
    }

    // ==================== 回合结束 ====================

    endRound(playerA, playerB) {
        for (const player of [playerA, playerB]) {
            player.resetForNewRound();
            // 冷却-1
            for (const skillId in player.skillCooldowns) {
                if (player.skillCooldowns[skillId] > 0) {
                    player.skillCooldowns[skillId]--;
                }
            }
        }
    }

    // ==================== 胜负判定 ====================

    checkWinner(playerA, playerB) {
        if (!playerA.isAlive && !playerB.isAlive) return 'draw';
        if (!playerA.isAlive) return playerB.id;
        if (!playerB.isAlive) return playerA.id;
        return null;
    }

    // ==================== 获取技能信息 ====================

    getAllSkills() {
        return SKILLS.skills;
    }

    getMaxSkillSlots() {
        return SKILLS.maxSkillSlots;
    }

    getSkillById(skillId) {
        return this.skillsMap[skillId];
    }
}

module.exports = BattleEngine;
