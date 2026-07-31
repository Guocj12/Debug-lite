const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const BattleEngine = require('./battle');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/data', express.static(path.join(__dirname, '..', 'data')));

const lobbyRooms = new Map(); // 大厅房间（8人房间，仅管理玩家状态）
const TICKS = 16;

// ==================== 序列镜像处理 ====================
function mirrorActions(actions) {
  const mirrorMap = {
    'move_left': 'move_right',
    'move_right': 'move_left',
    'dodge_left': 'dodge_right',
    'dodge_right': 'dodge_left',
    'turn_left': 'turn_right',
    'turn_right': 'turn_left',
  };
  return actions.map(a => mirrorMap[a] || a);
}

// ==================== Lobby Room（大厅房间） ====================
class LobbyRoom {
  constructor(id) {
    this.id = id;
    this.hostId = null;
    this.slots = [
      { type: 'player', sid: null, name: null, charId: null, skillIds: [], customSkills: {}, ready: false },
      { type: 'player', sid: null, name: null, charId: null, skillIds: [], customSkills: {}, ready: false },
      { type: 'spectator', sid: null, name: null },
      { type: 'spectator', sid: null, name: null },
      { type: 'spectator', sid: null, name: null },
      { type: 'spectator', sid: null, name: null },
      { type: 'spectator', sid: null, name: null },
      { type: 'spectator', sid: null, name: null },
    ];
    this.state = 'waiting'; // waiting | playing
    this.round = 0;
    this.pActions = {}; // sid -> actions[]
  }

  getSlotSummary() {
    return this.slots.map((s, i) => ({
      index: i, type: s.type, occupied: s.sid !== null,
      name: s.name,
      charId: s.type === 'player' ? (s.charId || null) : null,
      ready: s.type === 'player' ? s.ready : null,
    }));
  }

  getPlayerSlot(sid) { return this.slots.find(s => s.sid === sid); }

  addPlayer(sid, name, preferredSlot) {
    const existing = this.getPlayerSlot(sid);
    if (existing) {
      existing.sid = null; existing.name = null;
      existing.charId = null; existing.skillIds = []; existing.customSkills = {}; existing.ready = false;
    }
    if (preferredSlot !== undefined && preferredSlot !== null) {
      const slot = this.slots[preferredSlot];
      if (slot && !slot.sid) {
        slot.sid = sid; slot.name = name;
        if (slot.type === 'player') { slot.charId = null; slot.skillIds = []; slot.customSkills = {}; slot.ready = false; }
        if (!this.hostId) this.hostId = sid;
        return preferredSlot;
      }
    }
    for (let i = 0; i < 2; i++) {
      if (!this.slots[i].sid) {
        this.slots[i].sid = sid; this.slots[i].name = name;
        this.slots[i].charId = null; this.slots[i].skillIds = []; this.slots[i].customSkills = {}; this.slots[i].ready = false;
        if (!this.hostId) this.hostId = sid;
        return i;
      }
    }
    for (let i = 2; i < 8; i++) {
      if (!this.slots[i].sid) { this.slots[i].sid = sid; this.slots[i].name = name; if (!this.hostId) this.hostId = sid; return i; }
    }
    return null;
  }

  switchSlot(sid, targetIndex) {
    if (targetIndex < 0 || targetIndex >= 8) return false;
    const target = this.slots[targetIndex];
    if (target.sid && target.sid !== sid) return false;
    const current = this.getPlayerSlot(sid);
    if (!current || current === target) return false;
    const keys = ['sid','name','charId','skillIds','customSkills','ready'];
    const tmp = {}; keys.forEach(k => tmp[k] = target[k]);
    keys.forEach(k => target[k] = current[k]);
    keys.forEach(k => current[k] = tmp[k]);
    return true;
  }

  removePlayer(sid) {
    const slot = this.getPlayerSlot(sid);
    if (!slot) return;
    slot.sid = null; slot.name = null;
    if (slot.type === 'player') { slot.charId = null; slot.skillIds = []; slot.customSkills = {}; slot.ready = false; }
    delete this.pActions[sid];
    if (this.hostId === sid) {
      this.hostId = null;
      for (const s of this.slots) { if (s.sid) { this.hostId = s.sid; break; } }
    }
  }

  getAllPlayers() { return this.slots.filter(s => s.sid); }
  bothPlayerSlotsFilled() { return this.slots[0].sid && this.slots[1].sid; }
  bothCharsSelected() { return this.slots[0].charId && this.slots[1].charId; }
  bothReady() {
    const players = this.slots.filter(s => s.type === 'player' && s.sid);
    if (players.length < 2) return false;
    return players[0].ready && players[1].ready;
  }

  getPublicInfo() {
    return { roomId: this.id, playerCount: this.getAllPlayers().length, maxSlots: 8, state: this.state };
  }
}

// ==================== 辅助函数 ====================

/** 获取某个玩家在房间中的对手（另一游戏位玩家），没有则返回 null */
function getOpponentInRoom(room, sid) {
  const slot = room.getPlayerSlot(sid);
  if (!slot || slot.type !== 'player') return null;
  const opponentIndex = room.slots[0].sid === sid ? 1 : 0;
  if (room.slots[opponentIndex].sid) return room.slots[opponentIndex];
  return null;
}

// ==================== 联机战斗核心：双 AI 房间，独立运算 ====================

function startOnlineBattle(lobby) {
  const p1Slot = lobby.slots[0];
  const p2Slot = lobby.slots[1];
  const chars = require('../data/characters.json').characters;

  // P1 角色的完整数据
  const p1Char = chars.find(c => c.id === (p1Slot.charId || 'warrior')) || chars[0];
  const p2Char = chars.find(c => c.id === (p2Slot.charId || 'warrior')) || chars[0];

  // P1 的序列（玩家序列，P1位）
  const p1Actions = (lobby.pActions[p1Slot.sid] || []).slice(0, TICKS);
  while (p1Actions.length < TICKS) p1Actions.push('wait');

  // P2 的序列（玩家序列，P2位）
  const p2Actions = (lobby.pActions[p2Slot.sid] || []).slice(0, TICKS);
  while (p2Actions.length < TICKS) p2Actions.push('wait');

  // 镜像处理：P2 序列镜像后变成 P1 视角的对手序列
  // 同样 P1 序列镜像后变成 P2 视角的对手序列
  const p2Mirrored = mirrorActions(p2Actions);
  const p1Mirrored = mirrorActions(p1Actions);

  // ===== P1 的战斗：P1 = 玩家 P1 序列, P2 = P2 镜像序列(作为AI) =====
  const engine1 = new BattleEngine();
  engine1.init({
    p1: {
      id: 'P1', charId: p1Char.id, x: 5, facing: 1,
      hp: p1Char.maxHp, maxHp: p1Char.maxHp, mp: p1Char.maxMp, maxMp: p1Char.maxMp,
      sp: p1Char.maxSp, maxSp: p1Char.maxSp, atk: p1Char.atk, def: p1Char.def,
      skills: p1Slot.skillIds || p1Char.defaultSkills, customSkills: p1Slot.customSkills || {},
    },
    p2: {
      id: 'P2', charId: p2Char.id, x: 10, facing: -1,
      hp: p2Char.maxHp, maxHp: p2Char.maxHp, mp: p2Char.maxMp, maxMp: p2Char.maxMp,
      sp: p2Char.maxSp, maxSp: p2Char.maxSp, atk: p2Char.atk, def: p2Char.def,
      skills: p2Slot.skillIds || p2Char.defaultSkills, customSkills: p2Slot.customSkills || {},
    },
  });
  engine1.setActions(p1Actions, p2Mirrored);
  const frames1 = engine1.executeAll();
  const s1 = engine1.getState();

  // ===== P2 的战斗：P1 = P2 玩家序列(但放在P1位，已镜像), P2 = P1 镜像序列(作为AI) =====
  // 注意：给 P2 看的时候，"他自己"总是 P1，"对手"总是 P2
  const engine2 = new BattleEngine();
  engine2.init({
    p1: {
      id: 'P1', charId: p2Char.id, x: 5, facing: 1,
      hp: p2Char.maxHp, maxHp: p2Char.maxHp, mp: p2Char.maxMp, maxMp: p2Char.maxMp,
      sp: p2Char.maxSp, maxSp: p2Char.maxSp, atk: p2Char.atk, def: p2Char.def,
      skills: p2Slot.skillIds || p2Char.defaultSkills, customSkills: p2Slot.customSkills || {},
    },
    p2: {
      id: 'P2', charId: p1Char.id, x: 10, facing: -1,
      hp: p1Char.maxHp, maxHp: p1Char.maxHp, mp: p1Char.maxMp, maxMp: p1Char.maxMp,
      sp: p1Char.maxSp, maxSp: p1Char.maxSp, atk: p1Char.atk, def: p1Char.def,
      skills: p1Slot.skillIds || p1Char.defaultSkills, customSkills: p1Slot.customSkills || {},
    },
  });
  // P2 的序列需要镜像后放在 P1 位（因为他现在站在 P1 视角）
  const p2Reversed = mirrorActions(p2Actions);
  engine2.setActions(p2Reversed, p1Mirrored);
  const frames2 = engine2.executeAll();
  const s2 = engine2.getState();

  // 分别发给两个玩家
  io.to(p1Slot.sid).emit('onlineBattleResult', {
    frames: frames1, final: s1, round: lobby.round + 1,
    myCharId: p1Char.id, opponentCharId: p2Char.id, opponentName: p2Slot.name,
  });
  io.to(p2Slot.sid).emit('onlineBattleResult', {
    frames: frames2, final: s2, round: lobby.round + 1,
    myCharId: p2Char.id, opponentCharId: p1Char.id, opponentName: p1Slot.name,
  });

  // 重置准备状态，发送下一轮 prepareStart
  lobby.state = 'waiting';
  p1Slot.ready = false; p2Slot.ready = false;
  p1Slot.battleReady = false; p2Slot.battleReady = false;
  delete lobby.pActions[p1Slot.sid];
  delete lobby.pActions[p2Slot.sid];
  lobby.round++;
  io.to(lobby.id).emit('slotsUpdated', { slots: lobby.getSlotSummary(), hostId: lobby.hostId });

  // 等待播放结束后自动进入下一轮准备（延迟略大于帧播放时长）
  const roundDelay = TICKS * 650 + 2000;
  setTimeout(() => {
    // 检查房间还存在且两个玩家都在
    if (!lobbyRooms.has(lobby.id)) return;
    if (!lobby.slots[0].sid || !lobby.slots[1].sid) return;

    lobby.state = 'playing';
    lobby.pActions = {};
    const chars = require('../data/characters.json').characters;
    const p1c = chars.find(c => c.id === p1Slot.charId) || chars[0];
    const p2c = chars.find(c => c.id === p2Slot.charId) || chars[0];

    io.to(p1Slot.sid).emit('prepareStart', {
      round: lobby.round + 1, time: 60, opponent: p2Slot.name,
      p1: { id: 'P1', charId: p1c.id, x: 5, facing: 1, hp: s1.p1.hp, maxHp: p1c.maxHp, mp: s1.p1.mp, maxMp: p1c.maxMp, sp: s1.p1.sp, maxSp: p1c.maxSp, atk: p1c.atk, def: p1c.def, skills: p1Slot.skillIds || p1c.defaultSkills },
      p2: { id: 'P2', charId: p2c.id, x: 10, facing: -1, hp: s1.p2.hp, maxHp: p2c.maxHp, mp: s1.p2.mp, maxMp: p2c.maxMp, sp: s1.p2.sp, maxSp: p2c.maxSp, atk: p2c.atk, def: p2c.def, skills: p2Slot.skillIds || p2c.defaultSkills },
      p1Char: p1c.id, p2Char: p2c.id,
      bases: s1.bases || { p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 }, p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 } },
    });

    io.to(p2Slot.sid).emit('prepareStart', {
      round: lobby.round + 1, time: 60, opponent: p1Slot.name,
      p1: { id: 'P1', charId: p2c.id, x: 5, facing: 1, hp: s2.p1.hp, maxHp: p2c.maxHp, mp: s2.p1.mp, maxMp: p2c.maxMp, sp: s2.p1.sp, maxSp: p2c.maxSp, atk: p2c.atk, def: p2c.def, skills: p2Slot.skillIds || p2c.defaultSkills },
      p2: { id: 'P2', charId: p1c.id, x: 10, facing: -1, hp: s2.p2.hp, maxHp: p1c.maxHp, mp: s2.p2.mp, maxMp: p1c.maxMp, sp: s2.p2.sp, maxSp: p1c.maxSp, atk: p1c.atk, def: p1c.def, skills: p1Slot.skillIds || p1c.defaultSkills },
      p1Char: p2c.id, p2Char: p1c.id,
      bases: s2.bases || { p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 }, p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 } },
    });
  }, roundDelay);
}

// ==================== Socket Events ====================
io.on('connection', (socket) => {
  console.log('connect:', socket.id);

  socket.on('getRoomList', () => {
    const list = [];
    for (const [rid, r] of lobbyRooms) list.push(r.getPublicInfo());
    socket.emit('roomList', list);
  });

  socket.on('createRoom', (d) => {
    const name = d.name || 'Player';
    const rid = Math.floor(100000 + Math.random() * 900000).toString();
    const r = new LobbyRoom(rid);
    lobbyRooms.set(rid, r);
    const slotIdx = r.addPlayer(socket.id, name, 0);
    socket.join(rid);
    socket.emit('roomCreated', { roomId: rid, slotIndex: slotIdx, slots: r.getSlotSummary(), hostId: r.hostId });
    io.emit('roomListUpdate', { roomId: rid, info: r.getPublicInfo() });
  });

  socket.on('joinRoom', (d) => {
    const r = lobbyRooms.get(d.roomId);
    if (!r) return socket.emit('err', { msg: 'Room not found' });
    if (r.getAllPlayers().length >= 8) return socket.emit('err', { msg: 'Room is full' });
    const name = d.name || 'Player';
    const slotIdx = r.addPlayer(socket.id, name, null);
    if (slotIdx === null) return socket.emit('err', { msg: 'Room is full' });
    socket.join(d.roomId);
    socket.emit('roomJoined', { roomId: d.roomId, slotIndex: slotIdx, slots: r.getSlotSummary(), hostId: r.hostId });
    socket.to(d.roomId).emit('playerJoined', { slots: r.getSlotSummary(), joinerName: name });
    io.emit('roomListUpdate', { roomId: d.roomId, info: r.getPublicInfo() });
  });

  socket.on('switchSlot', (d) => {
    for (const [rid, r] of lobbyRooms) {
      if (r.getPlayerSlot(socket.id)) {
        const ok = r.switchSlot(socket.id, d.targetIndex);
        if (ok) io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
        else socket.emit('err', { msg: 'Slot switch failed' });
        break;
      }
    }
  });

  socket.on('selectChar', (d) => {
    for (const [rid, r] of lobbyRooms) {
      const slot = r.getPlayerSlot(socket.id);
      if (slot && slot.type === 'player') {
        slot.charId = d.charId; slot.skillIds = d.skillIds || []; slot.customSkills = d.customSkills || {};
        io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
        break;
      }
    }
  });

  socket.on('toggleReady', () => {
    for (const [rid, r] of lobbyRooms) {
      const slot = r.getPlayerSlot(socket.id);
      if (slot && slot.type === 'player') {
        slot.ready = !slot.ready;
        io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });

        // 双方都准备，角色都选了 → 通知双方进入准备阶段（编排序列）
        if (r.bothPlayerSlotsFilled() && r.bothCharsSelected() && r.bothReady()) {
          r.state = 'playing';
          r.pActions = {};
          const chars = require('../data/characters.json').characters;
          const p1Char = chars.find(c => c.id === r.slots[0].charId) || chars[0];
          const p2Char = chars.find(c => c.id === r.slots[1].charId) || chars[0];

          // 分别给 P1 和 P2 发各自的视角：自己始终是 P1，对手是 P2
          io.to(r.slots[0].sid).emit('prepareStart', {
            round: r.round + 1, time: 60,
            p1: { id: 'P1', charId: p1Char.id, x: 5, facing: 1, hp: p1Char.maxHp, maxHp: p1Char.maxHp, mp: p1Char.maxMp, maxMp: p1Char.maxMp, sp: p1Char.maxSp, maxSp: p1Char.maxSp, atk: p1Char.atk, def: p1Char.def, skills: r.slots[0].skillIds || p1Char.defaultSkills },
            p2: { id: 'P2', charId: p2Char.id, x: 10, facing: -1, hp: p2Char.maxHp, maxHp: p2Char.maxHp, mp: p2Char.maxMp, maxMp: p2Char.maxMp, sp: p2Char.maxSp, maxSp: p2Char.maxSp, atk: p2Char.atk, def: p2Char.def, skills: r.slots[1].skillIds || p2Char.defaultSkills },
            p1Char: p1Char.id, p2Char: p2Char.id,
            bases: { p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 }, p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 } },
          });

          io.to(r.slots[1].sid).emit('prepareStart', {
            round: r.round + 1, time: 60,
            p1: { id: 'P1', charId: p2Char.id, x: 5, facing: 1, hp: p2Char.maxHp, maxHp: p2Char.maxHp, mp: p2Char.maxMp, maxMp: p2Char.maxMp, sp: p2Char.maxSp, maxSp: p2Char.maxSp, atk: p2Char.atk, def: p2Char.def, skills: r.slots[1].skillIds || p2Char.defaultSkills },
            p2: { id: 'P2', charId: p1Char.id, x: 10, facing: -1, hp: p1Char.maxHp, maxHp: p1Char.maxHp, mp: p1Char.maxMp, maxMp: p1Char.maxMp, sp: p1Char.maxSp, maxSp: p1Char.maxSp, atk: p1Char.atk, def: p1Char.def, skills: r.slots[0].skillIds || p1Char.defaultSkills },
            p1Char: p2Char.id, p2Char: p1Char.id,
            bases: { p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 }, p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 } },
          });
        }
        break;
      }
    }
  });

  socket.on('updateActions', (d) => {
    for (const [rid, r] of lobbyRooms) {
      if (r.getPlayerSlot(socket.id)) { r.pActions[socket.id] = d.actions; break; }
    }
  });

  socket.on('ready', () => {
    for (const [rid, r] of lobbyRooms) {
      const slot = r.getPlayerSlot(socket.id);
      if (!slot || slot.type !== 'player') break;
      // 标记此玩家已提交序列
      slot.battleReady = true;
      io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });

      // 两个玩家都提交了序列 → 开始联机战斗运算
      if (r.state === 'playing' &&
          r.bothPlayerSlotsFilled() &&
          r.slots[0].battleReady && r.slots[1].battleReady &&
          r.pActions[r.slots[0].sid] && r.pActions[r.slots[1].sid]) {
        r.slots[0].battleReady = false;
        r.slots[1].battleReady = false;
        startOnlineBattle(r);
      }
      break;
    }
  });

  socket.on('leaveRoom', () => {
    for (const [rid, r] of lobbyRooms) {
      if (r.getPlayerSlot(socket.id)) {
        const opponentSlot = getOpponentInRoom(r, socket.id);
        r.removePlayer(socket.id); socket.leave(rid);
        if (r.getAllPlayers().length === 0) {
          lobbyRooms.delete(rid);
          io.emit('roomListRemove', { roomId: rid });
        } else {
          io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
          io.emit('roomListUpdate', { roomId: rid, info: r.getPublicInfo() });
          // 如果是游戏位玩家离开，通知对手获胜
          if (opponentSlot && opponentSlot.type === 'player' && r.state === 'playing') {
            io.to(opponentSlot.sid).emit('opponentDisconnected', { reason: '对手离开了房间' });
          }
        }
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    for (const [rid, r] of lobbyRooms) {
      if (r.getPlayerSlot(socket.id)) {
        const opponentSlot = getOpponentInRoom(r, socket.id);
        r.removePlayer(socket.id);
        if (r.getAllPlayers().length === 0) {
          lobbyRooms.delete(rid);
          io.emit('roomListRemove', { roomId: rid });
        } else {
          io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
          io.emit('roomListUpdate', { roomId: rid, info: r.getPublicInfo() });
          // 如果在战斗中掉线，通知对手获胜
          if (opponentSlot && opponentSlot.type === 'player' && (r.state === 'playing' || r.state === 'waiting')) {
            io.to(opponentSlot.sid).emit('opponentDisconnected', { reason: '对手断开了连接' });
          }
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => console.log('Debug-Lite v3 on http://localhost:' + PORT));