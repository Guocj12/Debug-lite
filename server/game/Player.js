const CHARACTERS = require('../data/characters.json');

class Player {
    constructor(id, name, characterId) {
        this.id = id;
        this.name = name;

        const charConfig = CHARACTERS.characters.find(c => c.id === characterId);
        if (!charConfig) throw new Error(`Unknown character: ${characterId}`);

        this.characterId = charConfig.id;
        this.characterConfig = charConfig;

        // 战斗属性
        this.maxHp = charConfig.baseHp;
        this.hp = this.maxHp;
        this.baseAttack = charConfig.baseAttack;
        this.baseDefense = charConfig.baseDefense;
        this.speed = charConfig.speed;

        // 战场状态
        this.position = { x: 0, y: 5 };
        this.isAlive = true;
        this.isDefending = false;

        // 技能
        this.selectedSkills = [];
        this.skillCooldowns = {};

        // Buff/Debuff
        this.buffs = [];

        // 行动队列
        this.actionQueue = [];
        this.queueConfirmed = false;

        // 统计
        this.stats = {
            damageDealt: 0,
            damageTaken: 0,
            healingDone: 0,
            skillsUsed: 0
        };
    }

    resetForNewRound() {
        this.actionQueue = [];
        this.queueConfirmed = false;
        this.isDefending = false;
    }

    getPublicState(includeSkills = false) {
        const state = {
            id: this.id,
            name: this.name,
            characterId: this.characterId,
            hp: this.hp,
            maxHp: this.maxHp,
            position: { ...this.position },
            isAlive: this.isAlive,
            isDefending: this.isDefending,
            buffs: this.buffs.map(b => ({ ...b })),
            queueConfirmed: this.queueConfirmed,
            queueLength: this.actionQueue.length,
            skillCooldowns: { ...this.skillCooldowns }
        };
        if (includeSkills) {
            state.skills = [...this.selectedSkills];
        }
        return state;
    }
}

module.exports = Player;
