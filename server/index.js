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

const rooms = new Map();
const TICKS = 16;

class GameRoom {
  constructor(id) {
    this.id = id; this.players = [];
    this.pActions = {}; this.pReady = {}; this.pChars = {}; this.pSkills = {}; this.pCustom = {};
    this.state = 'waiting'; this.round = 0; this.maxRounds = 30; this.prepTime = 60;
    this.timer = null; this.engine = null; this.puppet = false;
  }

  addPlayer(sid, name) {
    if (this.players.length >= 2) return false;
    const n = this.players.length + 1;
    this.players.push({ sid, name, n });
    this.pActions[sid] = []; this.pReady[sid] = false;
    return n;
  }

  remove(sid) {
    this.players = this.players.filter(p => p.sid !== sid);
    delete this.pActions[sid]; delete this.pReady[sid]; delete this.pChars[sid]; delete this.pSkills[sid];
  }
  getP(sid) { return this.players.find(p => p.sid === sid); }

  bothReady() {
    return this.players.length === 2 && this.pReady[this.players[0].sid] && this.pReady[this.players[1].sid];
  }

  initEngine() {
    const p1 = this.players[0], p2 = this.players[1];
    const chars = require('../data/characters.json').characters;
    const c1 = chars.find(c => c.id === (this.pChars[p1.sid] || 'warrior')) || chars[0];
    const c2 = chars.find(c => c.id === (this.pChars[p2.sid] || 'warrior')) || chars[0];

    const p2MaxHp = this.puppet ? 2147483647 : c2.maxHp;

    this.engine = new BattleEngine();
    this.engine.init({
      p1: { id: 'P1', charId: c1.id, x: 5, facing: 1, hp: c1.maxHp, maxHp: c1.maxHp, mp: c1.maxMp, maxMp: c1.maxMp, sp: c1.maxSp, maxSp: c1.maxSp, atk: c1.atk, def: c1.def, skills: this.pSkills[p1.sid] || c1.defaultSkills, customSkills: this.pCustom[p1.sid] || {} },
      p2: { id: 'P2', charId: c2.id, x: 10, facing: -1, hp: p2MaxHp, maxHp: p2MaxHp, mp: c2.maxMp, maxMp: c2.maxMp, sp: c2.maxSp, maxSp: c2.maxSp, atk: c2.atk, def: c2.def, skills: this.pSkills[p2.sid] || c2.defaultSkills, customSkills: this.pCustom[p2.sid] || {} },
    });
  }

  startPrepare() {
    if (this.players.length < 2) { this.state = 'finished'; return; }
    this.state = 'prepare'; this.round++;
    this.pReady[this.players[0].sid] = false;
    this.pReady[this.players[1].sid] = false;
    this.pActions[this.players[0].sid] = [];
    this.pActions[this.players[1].sid] = [];
    if (!this.engine) this.initEngine();

    const s = this.engine.getState();
    io.to(this.id).emit('prepareStart', {
      round: this.round, time: this.prepTime,
      p1: s.p1, p2: s.p2,
      p1Char: s.p1.charId, p2Char: s.p2.charId,
    });
    this.clearTimer();
    // 仅发送 tick 信息，不再自动倒计时到0触发战斗
    // 战斗仅在双方都 ready 后触发
    let t = this.prepTime;
    this.timer = setInterval(() => {
      t--;
      io.to(this.id).emit('prepareTick', { t });
      // 不再自动触发：if (t <= 0) { this.clearTimer(); this.runBattle(); }
      if (this.bothReady()) { this.clearTimer(); this.runBattle(); }
    }, 1000);
  }

  clearTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }

  runBattle() {
    if (this.players.length < 2) { this.state = 'finished'; return; }
    this.state = 'battle';
    const a1 = (this.pActions[this.players[0].sid] || []).slice(0, TICKS);
    const a2 = (this.pActions[this.players[1].sid] || []).slice(0, TICKS);
    while (a1.length < TICKS) a1.push('wait');
    while (a2.length < TICKS) a2.push('wait');

    this.engine.setActions(a1, a2);
    const frames = this.engine.executeAll();
    const s = this.engine.getState();

    io.to(this.id).emit('battleFrames', { frames, final: s, round: this.round });

    if (s.p1.hp <= 0 || s.p2.hp <= 0 || this.round >= this.maxRounds) {
      this.state = 'finished';
      const w = s.p1.hp <= 0 ? 'P2' : (s.p2.hp <= 0 ? 'P1' : (s.p1.hp > s.p2.hp ? 'P1' : 'draw'));
      io.to(this.id).emit('gameOver', { winner: w, p1Hp: s.p1.hp, p2Hp: s.p2.hp, reason: this.round >= this.maxRounds ? 'maxRounds' : 'death' });
      this.clearTimer();
    } else {
      // Wait for client animation (16 ticks * 600ms + buffer)
      setTimeout(() => this.startPrepare(), 11000);
    }
  }
}

io.on('connection', (socket) => {
  console.log('connect:', socket.id);

  socket.on('createRoom', (d) => {
    const rid = uuidv4().substring(0, 6).toUpperCase();
    const r = new GameRoom(rid); rooms.set(rid, r);
    r.addPlayer(socket.id, d.name || 'Player');
    socket.join(rid);
    socket.emit('roomCreated', { roomId: rid, n: 1 });
  });

  socket.on('joinRoom', (d) => {
    const r = rooms.get(d.roomId);
    if (!r) return socket.emit('err', { msg: '房间不存在' });
    if (r.players.length >= 2) return socket.emit('err', { msg: '房间已满' });
    const n = r.addPlayer(socket.id, d.name || 'Player');
    socket.join(d.roomId);
    socket.emit('roomJoined', { roomId: d.roomId, n });
    io.to(d.roomId).emit('playerJoined', { players: r.players.map(p => ({ name: p.name, n: p.n })) });
  });

  socket.on('selectChar', (d) => {
    for (const [rid, r] of rooms) {
      if (r.players.find(p => p.sid === socket.id)) {
        r.pChars[socket.id] = d.charId;
        r.pSkills[socket.id] = d.skillIds || [];
        if (d.customSkills) r.pCustom[socket.id] = d.customSkills;
        io.to(rid).emit('charSelected', { n: r.getP(socket.id).n, charId: d.charId });
        if (r.players.length === 2 && r.pChars[r.players[0].sid] && r.pChars[r.players[1].sid]) {
          r.startPrepare();
        }
        break;
      }
    }
  });

  socket.on('updateActions', (d) => {
    for (const [rid, r] of rooms) {
      if (r.players.find(p => p.sid === socket.id)) { r.pActions[socket.id] = d.actions; break; }
    }
  });

  socket.on('ready', () => {
    for (const [rid, r] of rooms) {
      if (r.players.find(p => p.sid === socket.id)) {
        r.pReady[socket.id] = true;
        io.to(rid).emit('playerReady', { n: r.getP(socket.id).n });
        if (r.state === 'prepare' && r.bothReady()) { r.clearTimer(); r.runBattle(); }
        break;
      }
    }
  });

  socket.on('startAI', (d) => {
    const rid = 'AI-' + uuidv4().substring(0, 4);
    const r = new GameRoom(rid); rooms.set(rid, r);
    r.addPlayer(socket.id, d.name || 'Player');
    r.addPlayer('AI-' + rid, 'AI');
    socket.join(rid);
    const chars = require('../data/characters.json').characters;
    const pChar = chars.find(c => c.id === d.charId) || chars[0];
    const aiChar = chars.find(c => c.id === d.aiCharId) || chars[1];
    r.pChars[socket.id] = d.charId || 'warrior';
    r.pSkills[socket.id] = d.skillIds || pChar.defaultSkills;
    r.pChars['AI-' + rid] = aiChar.id;
    r.pSkills['AI-' + rid] = d.aiSkillIds || aiChar.defaultSkills;
    socket.emit('aiStart', { roomId: rid, n: 1, aiChar: aiChar.id });
    r.startPrepare();
  });

  socket.on('aiReady', (d) => {
    const r = rooms.get(d.roomId);
    if (!r) return;
    const aiSid = r.players.find(p => p.name === 'AI')?.sid;
    if (!aiSid) return;
    const player = r.getP(socket.id);
    const ai = r.getP(aiSid);
    const hpPct = ai ? (r.engine?.state?.p2?.hp || 100) / (r.engine?.state?.p2?.maxHp || 100) : 1;
    const dist = r.engine?.state ? Math.abs(r.engine.state.p1.x - r.engine.state.p2.x) : 5;
    const pool = [];
    if (dist > 3) pool.push('move_right', 'move_left', 'move_left', 'move_right', 'skill1', 'skill2');
    else if (dist > 1) pool.push('skill1', 'skill2', 'defend', 'move_right', 'move_left');
    else pool.push('skill1', 'skill2', 'skill3', 'defend', 'dodge_left', 'dodge_right', 'move_left', 'move_right');
    if (hpPct < 0.3) pool.push('defend', 'defend', 'dodge_left', 'dodge_right');
    const actions = [];
    for (let i = 0; i < 16; i++) actions.push(pool[Math.floor(Math.random() * pool.length)]);
    r.pActions[aiSid] = actions;
    r.pReady[aiSid] = true;
    if (r.state === 'prepare' && r.bothReady()) { r.clearTimer(); r.runBattle(); }
  });

  // === Training Mode ===
  socket.on('startTrain', (d) => {
    const rid = 'TR-' + uuidv4().substring(0, 4);
    const r = new GameRoom(rid); rooms.set(rid, r);
    r.addPlayer(socket.id, d.name || 'Player');
    r.addPlayer('TRAIN-' + rid, '训练假人');
    socket.join(rid);
    const chars = require('../data/characters.json').characters;
    const pChar = chars.find(c => c.id === d.charId) || chars[0];
    r.pChars[socket.id] = d.charId || 'warrior';
    r.pSkills[socket.id] = d.skillIds || pChar.defaultSkills;
    // Puppet: any char, but massive HP
    r.pChars['TRAIN-' + rid] = 'warrior';
    r.pSkills['TRAIN-' + rid] = ['warrior_whirlwind', 'warrior_heavy', 'warrior_shieldbash'];
    r.puppet = true;
    socket.emit('trainStart', { roomId: rid, n: 1 });
    r.startPrepare();
  });

  socket.on('trainReady', (d) => {
    const r = rooms.get(d.roomId);
    if (!r) return;
    const trainSid = r.players.find(p => p.name === '训练假人')?.sid;
    if (!trainSid) return;
    // Puppet always does wait (does nothing)
    const actions = [];
    for (let i = 0; i < 16; i++) actions.push('wait');
    r.pActions[trainSid] = actions;
    r.pReady[trainSid] = true;
    if (r.state === 'prepare' && r.bothReady()) { r.clearTimer(); r.runBattle(); }
  });

  socket.on('leaveRoom', () => {
    for (const [rid, r] of rooms) {
      if (r.players.find(p => p.sid === socket.id)) {
        r.remove(socket.id); socket.leave(rid);
        io.to(rid).emit('playerLeft');
        if (r.players.length === 0 || rid.startsWith('AI-') || rid.startsWith('TR-')) { r.clearTimer(); rooms.delete(rid); }
        break;
      }
    }
  });

  socket.on('disconnect', () => {
    for (const [rid, r] of rooms) {
      if (r.players.find(p => p.sid === socket.id)) {
        r.remove(socket.id); io.to(rid).emit('playerLeft');
        if (r.players.length === 0 || rid.startsWith('AI-') || rid.startsWith('TR-')) { r.clearTimer(); rooms.delete(rid); }
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => console.log(`Debug-Lite v2 on http://localhost:${PORT}`));
