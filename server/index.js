const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const BattleEngine = require('./battle');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/data', express.static(path.join(__dirname, '..', 'data')));

const rooms = new Map();
const TICKS = 16;

// ==================== Room Class ====================
class GameRoom {
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
    this.state = 'waiting';
    this.round = 0;
    this.maxRounds = 30;
    this.prepTime = 60;
    this.timer = null;
    this.engine = null;
    this.pActions = {};
  }

  getSlotSummary() {
    return this.slots.map((s, i) => ({
      index: i,
      type: s.type,
      occupied: s.sid !== null,
      name: s.name,
      charId: s.type === 'player' ? (s.charId || null) : null,
      ready: s.type === 'player' ? s.ready : null,
    }));
  }

  getPlayerSlot(sid) {
    return this.slots.find(s => s.sid === sid);
  }

  addPlayer(sid, name, preferredSlot) {
    const existing = this.getPlayerSlot(sid);
    if (existing) {
      existing.sid = null; existing.name = null;
      existing.charId = null; existing.skillIds = [];
      existing.customSkills = {}; existing.ready = false;
    }
    if (preferredSlot !== undefined && preferredSlot !== null) {
      const slot = this.slots[preferredSlot];
      if (slot && !slot.sid) {
        slot.sid = sid; slot.name = name;
        if (slot.type === 'player') {
          slot.charId = null; slot.skillIds = [];
          slot.customSkills = {}; slot.ready = false;
        }
        if (!this.hostId) this.hostId = sid;
        return preferredSlot;
      }
    }
    for (let i = 0; i < 2; i++) {
      if (!this.slots[i].sid) {
        this.slots[i].sid = sid; this.slots[i].name = name;
        this.slots[i].charId = null; this.slots[i].skillIds = [];
        this.slots[i].customSkills = {}; this.slots[i].ready = false;
        if (!this.hostId) this.hostId = sid;
        return i;
      }
    }
    for (let i = 2; i < 8; i++) {
      if (!this.slots[i].sid) {
        this.slots[i].sid = sid; this.slots[i].name = name;
        if (!this.hostId) this.hostId = sid;
        return i;
      }
    }
    return null;
  }

  switchSlot(sid, targetIndex) {
    if (targetIndex < 0 || targetIndex >= 8) return false;
    const target = this.slots[targetIndex];
    if (target.sid && target.sid !== sid) return false;
    const current = this.getPlayerSlot(sid);
    if (!current || current === target) return false;
    const isCurPlayer = current.type === 'player';
    const isTgtPlayer = target.type === 'player';
    if (isCurPlayer && !isTgtPlayer) {
      target.sid = current.sid; target.name = current.name;
      current.sid = null; current.name = null;
      current.charId = null; current.skillIds = [];
      current.customSkills = {}; current.ready = false;
      return true;
    }
    if (!isCurPlayer && isTgtPlayer) {
      target.sid = current.sid; target.name = current.name;
      target.charId = null; target.skillIds = [];
      target.customSkills = {}; target.ready = false;
      current.sid = null; current.name = null;
      return true;
    }
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
    if (slot.type === 'player') {
      slot.charId = null; slot.skillIds = [];
      slot.customSkills = {}; slot.ready = false;
    }
    delete this.pActions[sid];
    if (this.hostId === sid) {
      this.hostId = null;
      for (const s of this.slots) {
        if (s.sid) { this.hostId = s.sid; break; }
      }
    }
  }

  getPlayers() { return this.slots.filter(s => s.type === 'player' && s.sid); }
  getAllPlayers() { return this.slots.filter(s => s.sid); }
  bothPlayerSlotsFilled() { return this.slots[0].sid && this.slots[1].sid; }
  bothCharsSelected() { return this.slots[0].charId && this.slots[1].charId; }
  bothReady() {
    const players = this.getPlayers();
    if (players.length < 2) return false;
    return players[0].ready && players[1].ready;
  }

  initEngine() {
    const p1Slot = this.slots[0];
    const p2Slot = this.slots[1];
    const chars = require('../data/characters.json').characters;
    const c1 = chars.find(c => c.id === (p1Slot.charId || 'warrior')) || chars[0];
    const c2 = chars.find(c => c.id === (p2Slot.charId || 'warrior')) || chars[0];
    this.engine = new BattleEngine();
    this.engine.init({
      p1: { id: 'P1', charId: c1.id, x: 5, facing: 1, hp: c1.maxHp, maxHp: c1.maxHp, mp: c1.maxMp, maxMp: c1.maxMp, sp: c1.maxSp, maxSp: c1.maxSp, atk: c1.atk, def: c1.def, skills: p1Slot.skillIds || c1.defaultSkills, customSkills: p1Slot.customSkills || {} },
      p2: { id: 'P2', charId: c2.id, x: 10, facing: -1, hp: c2.maxHp, maxHp: c2.maxHp, mp: c2.maxMp, maxMp: c2.maxMp, sp: c2.maxSp, maxSp: c2.maxSp, atk: c2.atk, def: c2.def, skills: p2Slot.skillIds || c2.defaultSkills, customSkills: p2Slot.customSkills || {} },
    });
  }

  startPrepare() {
    if (!this.bothPlayerSlotsFilled()) { this.state = 'waiting'; return; }
    this.state = 'playing'; this.round++;
    const players = this.getPlayers();
    players.forEach(p => { p.ready = false; delete this.pActions[p.sid]; });
    let prevState = null;
    if (this.engine) prevState = this.engine.getState();
    this.initEngine();
    if (prevState) {
      for (const key of ['hp','mp','sp','x','facing']) {
        this.engine.state.p1[key] = prevState.p1[key];
        this.engine.state.p2[key] = prevState.p2[key];
      }
      if (prevState.bases) {
        this.engine.state.bases.p1.hp = prevState.bases.p1.hp;
        this.engine.state.bases.p2.hp = prevState.bases.p2.hp;
      }
    }
    const s = this.engine.getState();
    io.to(this.id).emit('prepareStart', {
      round: this.round, time: this.prepTime,
      p1: s.p1, p2: s.p2,
      p1Char: s.p1.charId, p2Char: s.p2.charId,
      bases: s.bases,
    });
    this.clearTimer();
    let t = this.prepTime;
    this.timer = setInterval(() => {
      t--;
      io.to(this.id).emit('prepareTick', { t });
      if (this.bothReady()) { this.clearTimer(); this.runBattle(); }
    }, 1000);
  }

  clearTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  runBattle() {
    if (!this.bothPlayerSlotsFilled()) { this.state = 'waiting'; return; }
    this.state = 'playing';
    const p1Slot = this.slots[0];
    const p2Slot = this.slots[1];
    const a1 = (this.pActions[p1Slot.sid] || []).slice(0, TICKS);
    const a2 = (this.pActions[p2Slot.sid] || []).slice(0, TICKS);
    while (a1.length < TICKS) a1.push('wait');
    while (a2.length < TICKS) a2.push('wait');
    this.engine.setActions(a1, a2);
    const frames = this.engine.executeAll();
    const s = this.engine.getState();
    const gameOver = s.p1.hp <= 0 || s.p2.hp <= 0 || (s.bases && (s.bases.p1.hp <= 0 || s.bases.p2.hp <= 0)) || this.round >= this.maxRounds;
    io.to(this.id).emit('battleFrames', { frames, final: s, round: this.round, gameOver });
    if (gameOver) {
      this.state = 'waiting'; this.clearTimer();
      let winner, p1Hp = s.p1.hp, p2Hp = s.p2.hp, reason;
      if (s.p1.hp <= 0) { winner = 'P2'; reason = '对方被击杀'; }
      else if (s.p2.hp <= 0) { winner = 'P1'; reason = '对方被击杀'; }
      else if (s.bases && s.bases.p1.hp <= 0) { winner = 'P2'; reason = 'P1基地被摧毁'; }
      else if (s.bases && s.bases.p2.hp <= 0) { winner = 'P1'; reason = 'P2基地被摧毁'; }
      else if (s.p1.hp > s.p2.hp) { winner = 'P1'; reason = 'HP领先'; }
      else if (s.p2.hp > s.p1.hp) { winner = 'P2'; reason = 'HP领先'; }
      else { winner = 'draw'; reason = '平局'; }
      io.to(this.id).emit('gameOver', { winner, p1Hp, p2Hp, reason });
    } else {
      setTimeout(() => this.startPrepare(), 11000);
    }
  }

  getPublicInfo() {
    return {
      roomId: this.id,
      playerCount: this.getAllPlayers().length,
      maxSlots: 8,
      state: this.state,
    };
  }
}

io.on('connection', (socket) => {
  console.log('connect:', socket.id);

  socket.on('getRoomList', () => {
    const list = [];
    for (const [rid, r] of rooms) list.push(r.getPublicInfo());
    socket.emit('roomList', list);
  });

  socket.on('createRoom', (d) => {
    const name = d.name || 'Player';
    const rid = Math.floor(100000 + Math.random() * 900000).toString();
    const r = new GameRoom(rid);
    rooms.set(rid, r);
    const slotIdx = r.addPlayer(socket.id, name, 0);
    socket.join(rid);
    socket.emit('roomCreated', {
      roomId: rid, slotIndex: slotIdx,
      slots: r.getSlotSummary(), hostId: r.hostId,
    });
    io.emit('roomListUpdate', { roomId: rid, info: r.getPublicInfo() });
  });

  socket.on('joinRoom', (d) => {
    const r = rooms.get(d.roomId);
    if (!r) return socket.emit('err', { msg: 'Room not found' });
    if (r.getAllPlayers().length >= 8) return socket.emit('err', { msg: 'Room is full' });
    const name = d.name || 'Player';
    const slotIdx = r.addPlayer(socket.id, name, null);
    if (slotIdx === null) return socket.emit('err', { msg: 'Room is full' });
    socket.join(d.roomId);
    socket.emit('roomJoined', {
      roomId: d.roomId, slotIndex: slotIdx,
      slots: r.getSlotSummary(), hostId: r.hostId,
    });
    socket.to(d.roomId).emit('playerJoined', {
      slots: r.getSlotSummary(), joinerName: name,
    });
    io.emit('roomListUpdate', { roomId: d.roomId, info: r.getPublicInfo() });
  });

  socket.on('switchSlot', (d) => {
    for (const [rid, r] of rooms) {
      if (r.getPlayerSlot(socket.id)) {
        const success = r.switchSlot(socket.id, d.targetIndex);
        if (success) {
          io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
        } else {
          socket.emit('err', { msg: 'Slot switch failed' });
        }
        break;
      }
    }
  });

  socket.on('selectChar', (d) => {
    for (const [rid, r] of rooms) {
      const slot = r.getPlayerSlot(socket.id);
      if (slot && slot.type === 'player') {
        slot.charId = d.charId;
        slot.skillIds = d.skillIds || [];
        slot.customSkills = d.customSkills || {};
        io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
        break;
      }
    }
  });

  socket.on('toggleReady', () => {
    for (const [rid, r] of rooms) {
      const slot = r.getPlayerSlot(socket.id);
      if (slot && slot.type === 'player') {
        slot.ready = !slot.ready;
        io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
        const allReady = r.bothPlayerSlotsFilled() && r.bothCharsSelected() && r.bothReady();
        if (allReady) r.startPrepare();
        break;
      }
    }
  });

  socket.on('updateActions', (d) => {
    for (const [rid, r] of rooms) {
      if (r.getPlayerSlot(socket.id)) { r.pActions[socket.id] = d.actions; break; }
    }
  });

  socket.on('ready', () => {
    for (const [rid, r] of rooms) {
      const slot = r.getPlayerSlot(socket.id);
      if (slot && slot.type === 'player') {
        slot.ready = true;
        io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
        if (r.state === 'playing' && r.bothReady()) { r.clearTimer(); r.runBattle(); }
        break;
      }
    }
  });

  socket.on('leaveRoom', () => {
    for (const [rid, r] of rooms) {
      if (r.getPlayerSlot(socket.id)) {
        r.removePlayer(socket.id); socket.leave(rid);
        if (r.getAllPlayers().length === 0) {
          r.clearTimer(); rooms.delete(rid);
          io.emit('roomListRemove', { roomId: rid });
        } else {
          io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
          io.emit('roomListUpdate', { roomId: rid, info: r.getPublicInfo() });
        }
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    for (const [rid, r] of rooms) {
      if (r.getPlayerSlot(socket.id)) {
        r.removePlayer(socket.id);
        if (r.getAllPlayers().length === 0) {
          r.clearTimer(); rooms.delete(rid);
          io.emit('roomListRemove', { roomId: rid });
        } else {
          io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
          io.emit('roomListUpdate', { roomId: rid, info: r.getPublicInfo() });
        }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => console.log('Debug-Lite v3 on http://localhost:' + PORT));
