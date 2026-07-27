const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/data', express.static(path.join(__dirname, '..', 'data')));

// 游戏房间管理
const rooms = new Map();

class GameRoom {
  constructor(id) {
    this.id = id;
    this.players = [];
    this.playerActions = {};
    this.playerReady = {};
    this.playerCharacters = {};
    this.playerSkills = {};
    this.gameState = 'waiting'; // waiting, prepare, battle, finished
    this.roundCount = 0;
    this.maxRounds = 20;
    this.prepareTime = 60;
    this.timer = null;
    this.battleResults = null;
  }

  addPlayer(socketId, name) {
    if (this.players.length >= 2) return false;
    const playerNum = this.players.length + 1;
    this.players.push({ 
      socketId, name, playerNum, 
      hp: 100, maxHp: 100, 
      mp: 50, maxMp: 50, 
      dead: false,
      baseAtk: 15,
      baseDef: 8
    });
    this.playerActions[socketId] = [];
    this.playerReady[socketId] = false;
    return playerNum;
  }

  removePlayer(socketId) {
    const idx = this.players.findIndex(p => p.socketId === socketId);
    if (idx >= 0) {
      this.players.splice(idx, 1);
    }
    delete this.playerActions[socketId];
    delete this.playerReady[socketId];
    delete this.playerCharacters[socketId];
    delete this.playerSkills[socketId];
  }

  getOtherPlayer(socketId) {
    return this.players.find(p => p.socketId !== socketId);
  }

  getPlayer(socketId) {
    return this.players.find(p => p.socketId === socketId);
  }

  setActions(socketId, actions) {
    this.playerActions[socketId] = actions;
  }

  setReady(socketId) {
    this.playerReady[socketId] = true;
  }

  setCharacter(socketId, charId) {
    this.playerCharacters[socketId] = charId;
  }

  setSkills(socketId, skillIds) {
    this.playerSkills[socketId] = skillIds;
  }

  bothReady() {
    return this.players.length === 2 &&
      this.playerReady[this.players[0].socketId] &&
      this.playerReady[this.players[1].socketId];
  }

  resetRound() {
    this.gameState = 'prepare';
    this.roundCount++;
    this.playerReady[this.players[0].socketId] = false;
    this.playerReady[this.players[1].socketId] = false;
    this.playerActions[this.players[0].socketId] = [];
    this.playerActions[this.players[1].socketId] = [];
    this.battleResults = null;
    
    // 通知前端重置准备状态
    io.to(this.id).emit('roundReset', {
      round: this.roundCount,
      p1Hp: this.players[0].hp,
      p2Hp: this.players[1].hp,
      p1Mp: this.players[0].mp,
      p2Mp: this.players[1].mp
    });
    
    this.startPrepareTimer();
  }

  startPrepareTimer() {
    this.clearTimer();
    let timeLeft = this.prepareTime;
    
    io.to(this.id).emit('preparePhase', { timeLeft, round: this.roundCount });
    
    this.timer = setInterval(() => {
      timeLeft--;
      io.to(this.id).emit('prepareTick', { timeLeft });
      
      if (timeLeft <= 0) {
        this.clearTimer();
        this.executeBattle();
      }
      
      if (this.bothReady()) {
        this.clearTimer();
        this.executeBattle();
      }
    }, 1000);
  }

  clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  executeBattle() {
    this.gameState = 'battle';
    const p1 = this.players[0];
    const p2 = this.players[1];
    const p1Actions = this.playerActions[p1.socketId] || [];
    const p2Actions = this.playerActions[p2.socketId] || [];

    // 确保双方行动队列等长
    const maxLen = Math.max(p1Actions.length, p2Actions.length);
    while (p1Actions.length < maxLen) p1Actions.push('wait');
    while (p2Actions.length < maxLen) p2Actions.push('wait');

    const battleLog = [];
    const p1State = { hp: p1.hp, mp: p1.mp, def: 0, atk: 0, effects: [], x: 1, y: 1 };
    const p2State = { hp: p2.hp, mp: p2.mp, def: 0, atk: 0, effects: [], x: 7, y: 1 };

    // 设置角色属性 (简化处理)
    const chars = {
      warrior: { atk: 15, def: 8, maxHp: 100, speed: 1 },
      assassin: { atk: 22, def: 4, maxHp: 70, speed: 2 },
      tank: { atk: 10, def: 14, maxHp: 150, speed: 0 },
      mage: { atk: 25, def: 3, maxHp: 60, speed: 1 }
    };

    const p1Char = this.playerCharacters[p1.socketId] || 'warrior';
    const p2Char = this.playerCharacters[p2.socketId] || 'warrior';
    const p1CharData = chars[p1Char] || chars.warrior;
    const p2CharData = chars[p2Char] || chars.warrior;
    
    p1State.maxHp = p1CharData.maxHp;
    p2State.maxHp = p2CharData.maxHp;
    p1State.maxMp = 50;
    p2State.maxMp = 50;
    p1State.atk = p1CharData.atk;
    p1State.def = p1CharData.def;
    p2State.atk = p2CharData.atk;
    p2State.def = p2CharData.def;
    
    // 初始化HP为角色最大HP
    p1State.hp = Math.min(p1State.hp, p1State.maxHp);
    p2State.hp = Math.min(p2State.hp, p2State.maxHp);

    function processEffects(state) {
      // 处理持续效果
      state.effects = state.effects.filter(e => {
        e.duration--;
        return e.duration > 0;
      });
      let defBonus = 0;
      let stunned = false;
      state.effects.forEach(e => {
        if (e.type === 'defense_buff') defBonus += e.value;
        if (e.type === 'stun') stunned = true;
      });
      return { defBonus, stunned };
    }

    function calcDamage(atkVal, defVal) {
      const dmg = Math.max(1, atkVal - defVal * 0.5);
      return Math.floor(dmg);
    }

    for (let i = 0; i < maxLen; i++) {
      const a1 = p1Actions[i];
      const a2 = p2Actions[i];

      // 计算距离
      const dist = Math.abs(p1State.x - p2State.x) + Math.abs(p1State.y - p2State.y);

      // 处理效果
      const p1Eff = processEffects(p1State);
      const p2Eff = processEffects(p2State);

      // 行动顺序取决于速度
      const firstActors = [];
      const char1Speed = p1CharData.speed || 0;
      const char2Speed = p2CharData.speed || 0;
      
      if (char1Speed >= char2Speed) {
        firstActors.push({ state: p1State, other: p2State, action: a1, name: 'P1', otherName: 'P2', stunned: p1Eff.stunned });
        firstActors.push({ state: p2State, other: p1State, action: a2, name: 'P2', otherName: 'P1', stunned: p2Eff.stunned });
      } else {
        firstActors.push({ state: p2State, other: p1State, action: a2, name: 'P2', otherName: 'P1', stunned: p2Eff.stunned });
        firstActors.push({ state: p1State, other: p2State, action: a1, name: 'P1', otherName: 'P2', stunned: p1Eff.stunned });
      }

      const animSteps = [];

      for (const actor of firstActors) {
        if (actor.state.hp <= 0) continue;

        if (actor.stunned) {
          battleLog.push(`${actor.name} 被眩晕，无法行动`);
          animSteps.push({ actor: actor.name, action: 'stunned' });
          continue;
        }

        const totalDef = actor.state.def + actor.defBonus;
        const action = actor.action;

        switch (action) {
          case 'attack':
          case '攻':
            if (dist <= 2) {
              const dmg = calcDamage(actor.state.atk, actor.other.def);
              actor.other.hp = Math.max(0, actor.other.hp - dmg);
              // 检查反击
              const otherEff = actor.other.effects.find(e => e.type === 'counter_stance');
              if (otherEff) {
                const counterDmg = Math.floor(otherEff.value * 0.8);
                actor.state.hp = Math.max(0, actor.state.hp - counterDmg);
                battleLog.push(`${actor.otherName} 反击造成 ${counterDmg} 点伤害`);
                animSteps.push({ actor: actor.otherName, action: 'counter', damage: counterDmg });
              }
              battleLog.push(`${actor.name} 攻击 ${actor.otherName}，造成 ${dmg} 点伤害`);
              animSteps.push({ actor: actor.name, action: 'attack', damage: dmg, target: actor.otherName });
            } else {
              battleLog.push(`${actor.name} 距离太远，攻击落空`);
              animSteps.push({ actor: actor.name, action: 'miss' });
            }
            break;

          case 'defend':
          case '防':
            actor.state.effects.push({ type: 'defense_buff', value: 10, duration: 1 });
            battleLog.push(`${actor.name} 进入防御姿态`);
            animSteps.push({ actor: actor.name, action: 'defend' });
            break;

          case 'skill1':
          case 'skill2':
          case 'skill3':
          case '技1':
          case '技2':
          case '技3':
            const skillIdx = ['skill1', 'skill2', 'skill3', '技1', '技2', '技3'].indexOf(action) % 3;
            const skillIds = actor.name === 'P1' ? (this.playerSkills[p1.socketId] || []) : (this.playerSkills[p2.socketId] || []);
            const skillId = skillIds[skillIdx];
            if (skillId) {
              const result = this.applySkill(skillId, actor.state, actor.other, dist);
              battleLog.push(result.log);
              animSteps.push({ actor: actor.name, action: 'skill', skillId, ...result });
            } else {
              battleLog.push(`${actor.name} 未装备技能`);
              animSteps.push({ actor: actor.name, action: 'miss' });
            }
            break;

          case 'move_left':
          case '左':
            if (actor.state.x > 0) actor.state.x--;
            battleLog.push(`${actor.name} 向左移动`);
            animSteps.push({ actor: actor.name, action: 'move', dir: 'left', pos: { x: actor.state.x, y: actor.state.y } });
            break;

          case 'move_right':
          case '右':
            if (actor.state.x < 8) actor.state.x++;
            battleLog.push(`${actor.name} 向右移动`);
            animSteps.push({ actor: actor.name, action: 'move', dir: 'right', pos: { x: actor.state.x, y: actor.state.y } });
            break;

          case 'move_up':
          case '上':
            if (actor.state.y > 0) actor.state.y--;
            battleLog.push(`${actor.name} 向上移动`);
            animSteps.push({ actor: actor.name, action: 'move', dir: 'up', pos: { x: actor.state.x, y: actor.state.y } });
            break;

          case 'move_down':
          case '下':
            if (actor.state.y < 2) actor.state.y++;
            battleLog.push(`${actor.name} 向下移动`);
            animSteps.push({ actor: actor.name, action: 'move', dir: 'down', pos: { x: actor.state.x, y: actor.state.y } });
            break;

          default:
            battleLog.push(`${actor.name} 等待`);
            animSteps.push({ actor: actor.name, action: 'wait' });
            break;
        }

        // MP回复
        actor.state.mp = Math.min(actor.state.maxMp || 50, (actor.state.mp || 0) + 3);

        if (actor.other.hp <= 0) break;
      }

      this.battleResults = {
        p1Hp: Math.max(0, p1State.hp),
        p2Hp: Math.max(0, p2State.hp),
        p1MaxHp: p1State.maxHp,
        p2MaxHp: p2State.maxHp,
        p1Mp: p1State.mp,
        p2Mp: p2State.mp,
        p1MaxMp: p1State.maxMp || 50,
        p2MaxMp: p2State.maxMp || 50,
        p1Pos: { x: p1State.x, y: p1State.y },
        p2Pos: { x: p2State.x, y: p2State.y },
        log: battleLog,
        animSteps,
        p1Effects: p1State.effects,
        p2Effects: p2State.effects
      };

      // 更新玩家HP
      p1.hp = Math.max(0, p1State.hp);
      p2.hp = Math.max(0, p2State.hp);
      p1.mp = p1State.mp;
      p2.mp = p2State.mp;

      io.to(this.id).emit('battleStep', {
        step: i,
        totalSteps: maxLen,
        results: this.battleResults
      });

      if (p1.hp <= 0 || p2.hp <= 0) break;
    }

    // 检查战斗结果
    if (p1.hp <= 0 || p2.hp <= 0 || this.roundCount >= this.maxRounds) {
      const winner = p1.hp <= 0 ? 'P2' : (p2.hp <= 0 ? 'P1' : 
        (p1.hp > p2.hp ? 'P1' : (p2.hp > p1.hp ? 'P2' : 'draw')));
      this.gameState = 'finished';
      io.to(this.id).emit('gameOver', { 
        winner, 
        p1Hp: p1.hp, 
        p2Hp: p2.hp,
        reason: this.roundCount >= this.maxRounds ? 'maxRounds' : 'death'
      });
      this.clearTimer();
    } else {
      this.resetRound();
    }
  }

  applySkill(skillId, caster, target, dist) {
    const skills = require('../data/skills.json').skills;
    const skill = skills.find(s => s.id === skillId);
    if (!skill) return { log: '未知技能', damage: 0 };

    if ((caster.mp || 0) < (skill.mpCost || 0)) {
      return { log: `${caster === this.players[0]?.socketId ? 'P1' : 'P2'} MP不足` };
    }
    caster.mp -= (skill.mpCost || 0);

    switch (skill.effect) {
      case 'direct_damage': {
        if (skill.range && dist > skill.range) return { log: '目标超出射程' };
        const dmg = Math.floor(skill.damage - target.def * 0.3);
        const actualDmg = Math.max(1, dmg);
        target.hp = Math.max(0, target.hp - actualDmg);
        return { log: `技能【${skill.name}】造成 ${actualDmg} 点伤害`, damage: actualDmg };
      }
      case 'defense_buff':
        caster.effects.push({ type: 'defense_buff', value: skill.defenseBonus, duration: skill.duration });
        return { log: `技能【${skill.name}】提升 ${skill.defenseBonus} 点防御` };
      case 'heal':
        caster.hp = Math.min(caster.maxHp || 100, (caster.hp || 0) + skill.healAmount);
        return { log: `技能【${skill.name}】恢复 ${skill.healAmount} 点生命` };
      case 'extra_move':
        return { log: `技能【${skill.name}】额外移动 ${skill.moveAmount} 格` };
      case 'counter_stance':
        caster.effects.push({ type: 'counter_stance', value: skill.counterDamage, duration: skill.duration });
        return { log: `技能【${skill.name}】进入反击姿态` };
      case 'multi_hit': {
        let totalDmg = 0;
        for (let i = 0; i < (skill.hits || 1); i++) {
          const hitDmg = Math.max(1, Math.floor(skill.damage - target.def * 0.2));
          target.hp = Math.max(0, target.hp - hitDmg);
          totalDmg += hitDmg;
        }
        return { log: `技能【${skill.name}】${skill.hits}连击，共 ${totalDmg} 点伤害`, damage: totalDmg, hits: skill.hits };
      }
      case 'stun': {
        const dmg = Math.max(1, Math.floor(skill.damage - target.def * 0.3));
        target.hp = Math.max(0, target.hp - dmg);
        target.effects.push({ type: 'stun', duration: skill.stunDuration });
        return { log: `技能【${skill.name}】造成 ${dmg} 点伤害并眩晕目标`, damage: dmg };
      }
      default:
        return { log: `技能【${skill.name}】` };
    }
  }
}

// AI系统
class AIPlayer {
  constructor(difficulty = 'normal') {
    this.difficulty = difficulty;
    this.actions = ['attack', 'defend', 'move_left', 'move_right', 'move_up', 'move_down', 'wait', 'skill1', 'skill2', 'skill3'];
    this.aggressiveActions = ['attack', 'skill1', 'skill2', 'skill3', 'move_right', 'move_left'];
  }

  generateActions(length, hpPercent, mpPercent, distance, hasSkills) {
    const actions = [];
    for (let i = 0; i < length; i++) {
      let pool = [...this.actions];
      
      if (hpPercent < 0.3) {
        // 低血量时倾向防守
        pool = ['defend', 'defend', 'move_left', 'move_right', 'move_up', 'move_down', 'attack'];
      }
      
      if (mpPercent > 0.4 && hasSkills && hasSkills.length > 0) {
        // MP充足时可能用技能
        pool.push('skill1', 'skill2', 'skill3');
      }

      if (distance <= 2) {
        // 近距离倾向攻击
        pool = ['attack', 'attack', 'attack', 'defend', 'skill1', 'skill2', 'move_left', 'move_right'];
      } else {
        // 远距离倾向靠近
        pool = ['move_right', 'move_left', 'move_up', 'move_down', 'defend'];
      }

      // 根据难度调整
      if (this.difficulty === 'easy') {
        pool = ['wait', 'move_left', 'move_right', 'attack', 'defend'];
      } else if (this.difficulty === 'hard') {
        pool = ['attack', 'attack', 'skill1', 'skill2', 'skill3', 'defend', 'move_left', 'move_right'];
      }

      actions.push(pool[Math.floor(Math.random() * pool.length)]);
    }
    return actions;
  }
}

io.on('connection', (socket) => {
  console.log(`玩家连接: ${socket.id}`);

  // 创建房间
  socket.on('createRoom', (data) => {
    const roomId = uuidv4().substring(0, 6).toUpperCase();
    const room = new GameRoom(roomId);
    rooms.set(roomId, room);
    const playerNum = room.addPlayer(socket.id, data.name || 'Player');
    socket.join(roomId);
    socket.emit('roomCreated', { roomId, playerNum });
    console.log(`房间创建: ${roomId}`);
  });

  // 加入房间
  socket.on('joinRoom', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) {
      socket.emit('error', { message: '房间不存在' });
      return;
    }
    if (room.players.length >= 2) {
      socket.emit('error', { message: '房间已满' });
      return;
    }
    const playerNum = room.addPlayer(socket.id, data.name || 'Player');
    if (playerNum) {
      socket.join(data.roomId);
      socket.emit('roomJoined', { roomId: data.roomId, playerNum });
      io.to(data.roomId).emit('playerJoined', { 
        players: room.players.map(p => ({ name: p.name, playerNum: p.playerNum }))
      });
      console.log(`玩家 ${socket.id} 加入房间 ${data.roomId}`);
    }
  });

  // 选择角色
  socket.on('selectCharacter', (data) => {
    for (const [roomId, room] of rooms) {
      if (room.players.find(p => p.socketId === socket.id)) {
        room.setCharacter(socket.id, data.charId);
        room.setSkills(socket.id, data.skillIds || []);
        io.to(roomId).emit('characterSelected', {
          playerNum: room.getPlayer(socket.id).playerNum,
          charId: data.charId,
          skillIds: data.skillIds
        });
        if (room.players.length === 2) {
          // 两个玩家都选好了角色，开始准备阶段
          room.resetRound();
        }
        break;
      }
    }
  });

  // 更新行动队列
  socket.on('updateActions', (data) => {
    for (const [roomId, room] of rooms) {
      if (room.players.find(p => p.socketId === socket.id)) {
        room.setActions(socket.id, data.actions);
        break;
      }
    }
  });

  // 准备完成
  socket.on('ready', () => {
    for (const [roomId, room] of rooms) {
      if (room.players.find(p => p.socketId === socket.id)) {
        room.setReady(socket.id);
        io.to(roomId).emit('playerReady', { 
          playerNum: room.getPlayer(socket.id).playerNum 
        });
        if (room.gameState === 'prepare' && room.bothReady()) {
          room.clearTimer();
          room.executeBattle();
        }
        break;
      }
    }
  });

  // 获取房间信息
  socket.on('getRoomInfo', (data) => {
    const room = rooms.get(data.roomId);
    if (room) {
      socket.emit('roomInfo', {
        roomId: room.id,
        players: room.players.map(p => ({ name: p.name, playerNum: p.playerNum })),
        gameState: room.gameState
      });
    }
  });

  // === AI对战 ===
  socket.on('startAI', (data) => {
    const roomId = 'AI-' + uuidv4().substring(0, 4);
    const room = new GameRoom(roomId);
    rooms.set(roomId, room);
    
    room.addPlayer(socket.id, data.name || 'Player');
    // AI作为第二个玩家
    room.addPlayer('AI-' + roomId, 'AI对手');
    socket.join(roomId);
    
    room.setCharacter(socket.id, data.charId || 'warrior');
    room.setSkills(socket.id, data.skillIds || ['slash', 'shield', 'heal']);
    room.setCharacter('AI-' + roomId, data.aiCharId || 'warrior');
    room.setSkills('AI-' + roomId, data.aiSkillIds || ['slash', 'fireball', 'shield']);
    
    socket.emit('aiGameStart', { roomId, playerNum: 1 });
    
    // 设置AI的行动队列
    const ai = new AIPlayer(data.difficulty || 'normal');
    const aiActions = ai.generateActions(6, 1, 0.5, 4, ['slash', 'fireball', 'shield']);
    room.setActions('AI-' + roomId, aiActions);
    room.setReady('AI-' + roomId);
    
    room.resetRound();
  });

  // AI回合完成时自动生成新行动
  socket.on('aiReady', (data) => {
    const room = rooms.get(data.roomId);
    if (!room) return;
    const aiId = room.players.find(p => p.name === 'AI对手')?.socketId;
    if (!aiId) return;

    const ai = new AIPlayer(data.difficulty || 'normal');
    const player = room.getPlayer(socket.id);
    const aiPlayer = room.getPlayer(aiId);
    const actionsLen = room.playerActions[socket.id]?.length || 6;
    const hpPercent = aiPlayer ? aiPlayer.hp / aiPlayer.maxHp : 1;
    const mpPercent = aiPlayer ? aiPlayer.mp / aiPlayer.maxMp : 0.5;
    const aiSkills = room.playerSkills[aiId] || [];
    const aiActions = ai.generateActions(actionsLen, hpPercent, mpPercent, 3, aiSkills);
    
    room.setActions(aiId, aiActions);
    room.setReady(aiId);
  });

  // 离开房间
  socket.on('leaveRoom', (data) => {
    for (const [roomId, room] of rooms) {
      if (room.players.find(p => p.socketId === socket.id)) {
        room.removePlayer(socket.id);
        socket.leave(roomId);
        io.to(roomId).emit('playerLeft', { playerNum: room.players.length > 0 ? 1 : 0 });
        if (room.players.length === 0 || room.id.startsWith('AI-')) {
          room.clearTimer();
          rooms.delete(roomId);
        }
        break;
      }
    }
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`玩家断开: ${socket.id}`);
    for (const [roomId, room] of rooms) {
      if (room.players.find(p => p.socketId === socket.id)) {
        room.removePlayer(socket.id);
        io.to(roomId).emit('playerLeft', { playerNum: room.players.length > 0 ? 1 : 0 });
        if (room.players.length === 0) {
          room.clearTimer();
          rooms.delete(roomId);
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => {
  console.log(`Debug-Lite 服务器运行在 http://localhost:${PORT}`);
  console.log('霓虹像素对战游戏已就绪!');
});
