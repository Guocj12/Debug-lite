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

/** 生成 AI 的 16 tick 行动序列（简单随机） */
function generateAIActions(charId, skillIds) {
  const genericActions = ['move_left','move_right','dodge_left','dodge_right','defend','turn','wait'];
  const skillActions = (skillIds || []).map((_, i) => 'skill' + (i + 1));
  const pool = [...genericActions, ...skillActions];
  const actions = [];
  for (let i = 0; i < TICKS; i++) {
    actions.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return actions;
}

/**
 * 运行单局 AI/训练战斗，返回帧序列和最终状态。
 * 双方均使用 BattleEngine，p1=玩家, p2=对手(AI)
 */
function runSingleBattle(p1Def, p2Def, p1Actions, p2Actions) {
  const engine = new BattleEngine();
  engine.init({
    p1: {
      id: 'P1', charId: p1Def.charId, x: 5, facing: 1,
      hp: p1Def.maxHp, maxHp: p1Def.maxHp, mp: p1Def.maxMp, maxMp: p1Def.maxMp,
      sp: p1Def.maxSp, maxSp: p1Def.maxSp, atk: p1Def.atk, def: p1Def.def,
      skills: p1Def.skillIds, customSkills: p1Def.customSkills || {},
    },
    p2: {
      id: 'P2', charId: p2Def.charId, x: 10, facing: -1,
      hp: p2Def.maxHp, maxHp: p2Def.maxHp, mp: p2Def.maxMp, maxMp: p2Def.maxMp,
      sp: p2Def.maxSp, maxSp: p2Def.maxSp, atk: p2Def.atk, def: p2Def.def,
      skills: p2Def.skillIds, customSkills: p2Def.customSkills || {},
    },
  });
  engine.setActions(p1Actions, p2Actions);
  const frames = engine.executeAll();
  const state = engine.getState();
  return { frames, state };
}

// ==================== 联机战斗核心：双 AI 房间，独立运算 ====================

/**
 * 启动联机战斗。
 * 双方各自编写 16tick 序列（在自己视角中，自己是 P1 在左位，对手是 P2 在右位）。
 * 服务端创建两个独立的 BattleEngine，互不干扰：
 *   - Engine1（P1视角）：p1=P1角色+P1序列, p2=P2角色+P2序列镜像
 *   - Engine2（P2视角）：p1=P2角色+P2序列, p2=P1角色+P1序列镜像
 * 注意：双方序列"作为自己"时不镜像，"作为对手"时才镜像。
 */
function startOnlineBattle(lobby) {
  const p1Slot = lobby.slots[0];
  const p2Slot = lobby.slots[1];
  const chars = require('../data/characters.json').characters;

  const p1Char = chars.find(c => c.id === (p1Slot.charId || 'warrior')) || chars[0];
  const p2Char = chars.find(c => c.id === (p2Slot.charId || 'warrior')) || chars[0];

  // P1 编写的序列（自己是 P1 位）
  const p1Actions = (lobby.pActions[p1Slot.sid] || []).slice(0, TICKS);
  while (p1Actions.length < TICKS) p1Actions.push('wait');

  // P2 编写的序列（自己是 P1 位，所以不需要镜像）
  const p2Actions = (lobby.pActions[p2Slot.sid] || []).slice(0, TICKS);
  while (p2Actions.length < TICKS) p2Actions.push('wait');

  // 对手序列需要镜像（双方相对而立，坐标系相反）
  const p2AsOpponent = mirrorActions(p2Actions);
  const p1AsOpponent = mirrorActions(p1Actions);

  // 继承上一轮状态，首轮用默认值
  const prevS1 = lobby._p1State;
  const prevS2 = lobby._p2State;

  function inheritOrDefault(prev, which, def) {
    if (prev && prev[which]) {
      return {
        hp: prev[which].hp, mp: prev[which].mp, sp: prev[which].sp,
        x: prev[which].x, facing: prev[which].facing,
      };
    }
    return def;
  }

  function inheritBase(prev, which, def) {
    if (prev && prev.bases && prev.bases[which]) {
      return { hp: prev.bases[which].hp, maxHp: def.maxHp, def: def.def, atk: def.atk, x: def.x };
    }
    return def;
  }

  const i1p1 = inheritOrDefault(prevS1, 'p1', { hp: p1Char.maxHp, mp: p1Char.maxMp, sp: p1Char.maxSp, x: 5, facing: 1 });
  const i1p2 = inheritOrDefault(prevS1, 'p2', { hp: p2Char.maxHp, mp: p2Char.maxMp, sp: p2Char.maxSp, x: 10, facing: -1 });
  const i2p1 = inheritOrDefault(prevS2, 'p1', { hp: p2Char.maxHp, mp: p2Char.maxMp, sp: p2Char.maxSp, x: 5, facing: 1 });
  const i2p2 = inheritOrDefault(prevS2, 'p2', { hp: p1Char.maxHp, mp: p1Char.maxMp, sp: p1Char.maxSp, x: 10, facing: -1 });

  const baseDef1 = { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 };
  const baseDef2 = { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 };
  const b1p1 = inheritBase(prevS1, 'p1', baseDef1);
  const b1p2 = inheritBase(prevS1, 'p2', baseDef2);
  const b2p1 = inheritBase(prevS2, 'p1', baseDef1);
  const b2p2 = inheritBase(prevS2, 'p2', baseDef2);

  // ===== Engine1（P1 视角）：P1=自己, P2=对手(镜像序列) =====
  const engine1 = new BattleEngine();
  engine1.init({
    _inheritBases: { p1: b1p1, p2: b1p2 },
    p1: {
      id: 'P1', charId: p1Char.id, x: i1p1.x, facing: i1p1.facing,
      hp: i1p1.hp, maxHp: p1Char.maxHp, mp: i1p1.mp, maxMp: p1Char.maxMp,
      sp: i1p1.sp, maxSp: p1Char.maxSp, atk: p1Char.atk, def: p1Char.def,
      skills: p1Slot.skillIds || p1Char.defaultSkills, customSkills: p1Slot.customSkills || {},
    },
    p2: {
      id: 'P2', charId: p2Char.id, x: i1p2.x, facing: i1p2.facing,
      hp: i1p2.hp, maxHp: p2Char.maxHp, mp: i1p2.mp, maxMp: p2Char.maxMp,
      sp: i1p2.sp, maxSp: p2Char.maxSp, atk: p2Char.atk, def: p2Char.def,
      skills: p2Slot.skillIds || p2Char.defaultSkills, customSkills: p2Slot.customSkills || {},
    },
  });
  engine1.setActions(p1Actions, p2AsOpponent);
  const frames1 = engine1.executeAll();
  const s1 = engine1.getState();

  // ===== Engine2（P2 视角）：P1=自己(P2角色+原始序列), P2=对手(P1角色+镜像序列) =====
  const engine2 = new BattleEngine();
  engine2.init({
    _inheritBases: { p1: b2p1, p2: b2p2 },
    p1: {
      id: 'P1', charId: p2Char.id, x: i2p1.x, facing: i2p1.facing,
      hp: i2p1.hp, maxHp: p2Char.maxHp, mp: i2p1.mp, maxMp: p2Char.maxMp,
      sp: i2p1.sp, maxSp: p2Char.maxSp, atk: p2Char.atk, def: p2Char.def,
      skills: p2Slot.skillIds || p2Char.defaultSkills, customSkills: p2Slot.customSkills || {},
    },
    p2: {
      id: 'P2', charId: p1Char.id, x: i2p2.x, facing: i2p2.facing,
      hp: i2p2.hp, maxHp: p1Char.maxHp, mp: i2p2.mp, maxMp: p1Char.maxMp,
      sp: i2p2.sp, maxSp: p1Char.maxSp, atk: p1Char.atk, def: p1Char.def,
      skills: p1Slot.skillIds || p1Char.defaultSkills, customSkills: p1Slot.customSkills || {},
    },
  });
  // P2 自己的序列直接放 p1（不镜像），P1 序列镜像后放 p2
  engine2.setActions(p2Actions, p1AsOpponent);
  const frames2 = engine2.executeAll();
  const s2 = engine2.getState();

  // 保存双方各自视角的最终状态（用于下一轮继承）
  lobby._p1State = s1;
  lobby._p2State = s2;

  // 用 P1 视角结算（两个视角的胜负应该一致，取 s1 判断）
  const judge = BattleEngine.judge(s1, lobby.maxRounds, lobby.round + 1);

  // 分别发给两个玩家
  io.to(p1Slot.sid).emit('onlineBattleResult', {
    frames: frames1, final: s1, round: lobby.round + 1,
    myCharId: p1Char.id, opponentCharId: p2Char.id, opponentName: p2Slot.name,
    gameOver: judge !== null,
    winner: judge ? judge.winner : null,
    reason: judge ? judge.reason : null,
  });
  io.to(p2Slot.sid).emit('onlineBattleResult', {
    frames: frames2, final: s2, round: lobby.round + 1,
    myCharId: p2Char.id, opponentCharId: p1Char.id, opponentName: p1Slot.name,
    gameOver: judge !== null,
    winner: judge ? (judge.winner === 'P1' ? 'P1' : judge.winner === 'P2' ? 'P2' : 'draw') : null,
    reason: judge ? judge.reason : null,
  });

  // 如果游戏结束，直接结算不进入下一轮
  if (judge) {
    lobby.state = 'waiting';
    p1Slot.ready = false; p2Slot.ready = false;
    lobby.round++;
    lobby._p1State = null; lobby._p2State = null;
    io.to(lobby.id).emit('slotsUpdated', { slots: lobby.getSlotSummary(), hostId: lobby.hostId });
    return;
  }

  // 游戏未结束，保存状态等待双方回传后进入下一轮
  lobby.state = 'waiting';
  p1Slot.ready = false; p2Slot.ready = false;
  p1Slot.battleReady = false; p2Slot.battleReady = false;
  delete lobby.pActions[p1Slot.sid];
  delete lobby.pActions[p2Slot.sid];
  lobby.round++;
  console.log('[BATTLE_SAVE] room=' + lobby.id + ' round=' + lobby.round +
    ' s1.p1(hp='+s1.p1.hp+',x='+s1.p1.x+') s1.p2(hp='+s1.p2.hp+',x='+s1.p2.x+') ' +
    's2.p1(hp='+s2.p1.hp+',x='+s2.p1.x+') s2.p2(hp='+s2.p2.hp+',x='+s2.p2.x+')');
  // 保存双方各自看到的状态，等待客户端回传后校对
  lobby._p1Reported = false;
  lobby._p2Reported = false;
  lobby._p1ClientState = null;
  lobby._p2ClientState = null;
  io.to(lobby.id).emit('slotsUpdated', { slots: lobby.getSlotSummary(), hostId: lobby.hostId });
}

// ==================== 状态镜像校对 ====================

/**
 * 校对双端状态：
 *   P1 客户端回传的状态应 ≈ P1 服务端引擎状态（各自对比）
 *   P2 客户端回传的状态应 ≈ P2 服务端引擎状态（各自对比）
 * 同时校对两个引擎之间的镜像一致性（交叉验证）：
 *   s1.p1 应镜像于 s2.p2（同一角色在不同视角中）
 * 若误差超过容限，返回 false。
 */
function verifyBattleStates(s1, c1, s2, c2) {
  const TOL = 5;
  const MAX_X = 15; // 用于镜像坐标

  // 辅助：比较两个状态对象的指定字段
  function cmp(a, b, fields) {
    for (const f of fields) {
      if (Math.abs((a[f] ?? 0) - (b[f] ?? 0)) > TOL) return false;
    }
    return true;
  }

  // 检查 1：P1 服务端 vs P1 客户端（各自独立对比）
  const check1 = cmp(s1.p1, c1.p1, ['hp','mp','sp','x','facing']) &&
                 cmp(s1.p2, c1.p2, ['hp','mp','sp','x','facing']);

  // 检查 2：P2 服务端 vs P2 客户端（各自独立对比）
  const check2 = cmp(s2.p1, c2.p1, ['hp','mp','sp','x','facing']) &&
                 cmp(s2.p2, c2.p2, ['hp','mp','sp','x','facing']);

  // 检查 3：跨引擎镜像一致性
  // s1.p1 的角色 = s2.p2 的角色（P1角色在P2视角中是p2对手）
  // 坐标镜像：P1视角的 x <-> P2视角的 (MAX_X - x)
  const check3 = Math.abs(s1.p1.hp - s2.p2.hp) <= TOL &&
                 Math.abs(s1.p1.mp - s2.p2.mp) <= TOL &&
                 Math.abs(s1.p1.sp - s2.p2.sp) <= TOL &&
                 Math.abs((MAX_X - s1.p1.x) - s2.p2.x) <= 1 &&
                 Math.abs(s1.p2.hp - s2.p1.hp) <= TOL &&
                 Math.abs(s1.p2.mp - s2.p1.mp) <= TOL &&
                 Math.abs(s1.p2.sp - s2.p1.sp) <= TOL &&
                 Math.abs((MAX_X - s1.p2.x) - s2.p1.x) <= 1;

  // 检查 4：基地血量对比
  const b1hp1 = s1.bases?.p1?.hp ?? 100;
  const b1hp2 = s1.bases?.p2?.hp ?? 100;
  const b2hp1 = s2.bases?.p1?.hp ?? 100;
  const b2hp2 = s2.bases?.p2?.hp ?? 100;
  const check4 = Math.abs(b1hp1 - b2hp2) <= TOL &&
                 Math.abs(b1hp2 - b2hp1) <= TOL;

  console.log('[VERIFY] s1 p1(hp='+s1.p1.hp+',mp='+s1.p1.mp+',sp='+s1.p1.sp+',x='+s1.p1.x+',f='+s1.p1.facing+') p2(hp='+s1.p2.hp+',mp='+s1.p2.mp+',sp='+s1.p2.sp+',x='+s1.p2.x+',f='+s1.p2.facing+')');
  console.log('[VERIFY] c1 p1(hp='+c1.p1.hp+',mp='+c1.p1.mp+',sp='+c1.p1.sp+',x='+c1.p1.x+',f='+c1.p1.facing+') p2(hp='+c1.p2.hp+',mp='+c1.p2.mp+',sp='+c1.p2.sp+',x='+c1.p2.x+',f='+c1.p2.facing+')');
  console.log('[VERIFY] s2 p1(hp='+s2.p1.hp+',mp='+s2.p1.mp+',sp='+s2.p1.sp+',x='+s2.p1.x+',f='+s2.p1.facing+') p2(hp='+s2.p2.hp+',mp='+s2.p2.mp+',sp='+s2.p2.sp+',x='+s2.p2.x+',f='+s2.p2.facing+')');
  console.log('[VERIFY] c2 p1(hp='+c2.p1.hp+',mp='+c2.p1.mp+',sp='+c2.p1.sp+',x='+c2.p1.x+',f='+c2.p1.facing+') p2(hp='+c2.p2.hp+',mp='+c2.p2.mp+',sp='+c2.p2.sp+',x='+c2.p2.x+',f='+c2.p2.facing+')');
  console.log('[VERIFY] check1='+check1+' check2='+check2+' check3='+check3+' check4='+check4);

  return check1 && check2 && check3 && check4;
}

/** 校对通过后，发送下一轮 prepareStart */
function sendNextRound(lobby) {
  const p1Slot = lobby.slots[0];
  const p2Slot = lobby.slots[1];
  const chars = require('../data/characters.json').characters;
  const p1c = chars.find(c => c.id === p1Slot.charId) || chars[0];
  const p2c = chars.find(c => c.id === p2Slot.charId) || chars[0];

  const s1 = lobby._p1State;
  const s2 = lobby._p2State;

  console.log('[NEXT_ROUND] room=' + lobby.id + ' round=' + (lobby.round+1));
  console.log('[NEXT_ROUND] s1.p1 hp='+s1.p1.hp+' x='+s1.p1.x+' f='+s1.p1.facing+' s1.p2 hp='+s1.p2.hp+' x='+s1.p2.x+' f='+s1.p2.facing);
  console.log('[NEXT_ROUND] s2.p1 hp='+s2.p1.hp+' x='+s2.p1.x+' f='+s2.p1.facing+' s2.p2 hp='+s2.p2.hp+' x='+s2.p2.x+' f='+s2.p2.facing);
  if (s1.bases) console.log('[NEXT_ROUND] s1.bases p1hp='+s1.bases.p1.hp+' p2hp='+s1.bases.p2.hp);
  if (s2.bases) console.log('[NEXT_ROUND] s2.bases p1hp='+s2.bases.p1.hp+' p2hp='+s2.bases.p2.hp);

  lobby.state = 'playing';
  lobby.pActions = {};

  io.to(p1Slot.sid).emit('prepareStart', {
    round: lobby.round + 1, time: 60, opponent: p2Slot.name,
    p1: { id: 'P1', charId: p1c.id, x: s1.p1.x, facing: s1.p1.facing, hp: s1.p1.hp, maxHp: p1c.maxHp, mp: s1.p1.mp, maxMp: p1c.maxMp, sp: s1.p1.sp, maxSp: p1c.maxSp, atk: p1c.atk, def: p1c.def, skills: p1Slot.skillIds || p1c.defaultSkills },
    p2: { id: 'P2', charId: p2c.id, x: s1.p2.x, facing: s1.p2.facing, hp: s1.p2.hp, maxHp: p2c.maxHp, mp: s1.p2.mp, maxMp: p2c.maxMp, sp: s1.p2.sp, maxSp: p2c.maxSp, atk: p2c.atk, def: p2c.def, skills: p2Slot.skillIds || p2c.defaultSkills },
    p1Char: p1c.id, p2Char: p2c.id,
    bases: s1.bases || { p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 }, p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 } },
  });

  io.to(p2Slot.sid).emit('prepareStart', {
    round: lobby.round + 1, time: 60, opponent: p1Slot.name,
    p1: { id: 'P1', charId: p2c.id, x: s2.p1.x, facing: s2.p1.facing, hp: s2.p1.hp, maxHp: p2c.maxHp, mp: s2.p1.mp, maxMp: p2c.maxMp, sp: s2.p1.sp, maxSp: p2c.maxSp, atk: p2c.atk, def: p2c.def, skills: p2Slot.skillIds || p2c.defaultSkills },
    p2: { id: 'P2', charId: p1c.id, x: s2.p2.x, facing: s2.p2.facing, hp: s2.p2.hp, maxHp: p1c.maxHp, mp: s2.p2.mp, maxMp: p1c.maxMp, sp: s2.p2.sp, maxSp: p1c.maxSp, atk: p1c.atk, def: p1c.def, skills: p1Slot.skillIds || p1c.defaultSkills },
    p1Char: p2c.id, p2Char: p1c.id,
    bases: s2.bases || { p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 }, p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 } },
  });

  // 只清理回传标记，保留 _p1State/_p2State 给下一轮 startOnlineBattle 继承
  // _p1State/_p2State 会在下一轮 startOnlineBattle 中被覆盖
  lobby._p1Reported = false;
  lobby._p2Reported = false;
  lobby._p1ClientState = null;
  lobby._p2ClientState = null;
}

/** 校对失败，踢出所有玩家并关闭房间 */
function forceCloseRoom(lobby, reason) {
  console.log('[FORCE_CLOSE] room=' + lobby.id + ' reason=' + reason);
  for (const slot of lobby.slots) {
    if (slot.sid) {
      io.to(slot.sid).emit('roomForceClosed', { reason: reason });
    }
  }
  lobbyRooms.delete(lobby.id);
  io.emit('roomListRemove', { roomId: lobby.id });
}

// ==================== Socket Events ====================
io.on('connection', (socket) => {
  console.log('connect:', socket.id);

  // === 人机对战 ===
  socket.on('startAI', (d) => {
    console.log('[AI] startAI player=' + d.name + ' char=' + d.charId + ' vs AI char=' + d.aiCharId);
    const chars = require('../data/characters.json').characters;
    const pChar = chars.find(c => c.id === d.charId) || chars[0];
    const aiChar = chars.find(c => c.id === d.aiCharId) || chars[0];

    const p1Def = {
      charId: pChar.id, maxHp: pChar.maxHp, maxMp: pChar.maxMp, maxSp: pChar.maxSp,
      atk: pChar.atk, def: pChar.def, skillIds: d.skillIds, customSkills: d.customSkills || {},
    };
    const p2Def = {
      charId: aiChar.id, maxHp: aiChar.maxHp, maxMp: aiChar.maxMp, maxSp: aiChar.maxSp,
      atk: aiChar.atk, def: aiChar.def, skillIds: d.aiSkillIds, customSkills: {},
    };

    const aiActions = generateAIActions(aiChar.id, d.aiSkillIds);
    const playerActions = []; // 玩家在编排阶段填写，发到服务端时为空，由客户端本地模拟
    // AI 对战：玩家在前端编排序列后发给后端计算
    // 这里先返回准备数据，实际战斗在玩家提交序列后计算
    const bases = { p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 }, p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 } };

    socket.emit('aiPrepareStart', {
      round: 1, time: 60,
      p1: { id: 'P1', charId: pChar.id, x: 5, facing: 1, hp: pChar.maxHp, maxHp: pChar.maxHp, mp: pChar.maxMp, maxMp: pChar.maxMp, sp: pChar.maxSp, maxSp: pChar.maxSp, atk: pChar.atk, def: pChar.def, skills: d.skillIds || pChar.defaultSkills },
      p2: { id: 'P2', charId: aiChar.id, x: 10, facing: -1, hp: aiChar.maxHp, maxHp: aiChar.maxHp, mp: aiChar.maxMp, maxMp: aiChar.maxMp, sp: aiChar.maxSp, maxSp: aiChar.maxSp, atk: aiChar.atk, def: aiChar.def, skills: d.aiSkillIds || aiChar.defaultSkills },
      p1Char: pChar.id, p2Char: aiChar.id, bases,
    });
  });

  // AI 对战：玩家提交了行动序列 → 运算战斗
  socket.on('aiSubmitActions', (d) => {
    console.log('[AI] received player actions length=' + (d.actions?.length || 0));
    const chars = require('../data/characters.json').characters;
    const pChar = chars.find(c => c.id === d.charId) || chars[0];
    const aiChar = chars.find(c => c.id === d.aiCharId) || chars[0];

    const p1Def = {
      charId: pChar.id, maxHp: pChar.maxHp, maxMp: pChar.maxMp, maxSp: pChar.maxSp,
      atk: pChar.atk, def: pChar.def, skillIds: d.skillIds, customSkills: {},
    };
    const p2Def = {
      charId: aiChar.id, maxHp: aiChar.maxHp, maxMp: aiChar.maxMp, maxSp: aiChar.maxSp,
      atk: aiChar.atk, def: aiChar.def, skillIds: d.aiSkillIds, customSkills: {},
    };

    const playerActions = (d.actions || []).slice(0, TICKS);
    while (playerActions.length < TICKS) playerActions.push('wait');
    const aiActions = generateAIActions(aiChar.id, d.aiSkillIds);

    const { frames, state } = runSingleBattle(p1Def, p2Def, playerActions, aiActions);
    socket.emit('aiBattleResult', {
      frames, final: state, round: 1,
      myCharId: pChar.id, opponentCharId: aiChar.id, opponentName: 'AI',
    });
  });

  // === 训练场 ===
  socket.on('startTrain', (d) => {
    console.log('[TRAIN] startTrain player=' + d.name + ' char=' + d.charId);
    const chars = require('../data/characters.json').characters;
    const pChar = chars.find(c => c.id === d.charId) || chars[0];
    // 训练场：对手为木桩（不动的战士），只用 move_left 和 wait
    const dummyChar = chars[0]; // warrior as dummy
    const dummyActions = ['wait','wait','wait','wait','wait','wait','wait','wait',
      'wait','wait','wait','wait','wait','wait','wait','wait'];

    const p1Def = {
      charId: pChar.id, maxHp: pChar.maxHp, maxMp: pChar.maxMp, maxSp: pChar.maxSp,
      atk: pChar.atk, def: pChar.def, skillIds: d.skillIds, customSkills: {},
    };
    const p2Def = {
      charId: dummyChar.id, maxHp: dummyChar.maxHp, maxMp: dummyChar.maxMp, maxSp: dummyChar.maxSp,
      atk: dummyChar.atk, def: dummyChar.def, skillIds: dummyChar.defaultSkills, customSkills: {},
    };

    const bases = { p1: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 0 }, p2: { hp: 100, maxHp: 100, def: 10, atk: 0, x: 15 } };
    socket.emit('aiPrepareStart', {
      round: 1, time: 60,
      p1: { id: 'P1', charId: pChar.id, x: 5, facing: 1, hp: pChar.maxHp, maxHp: pChar.maxHp, mp: pChar.maxMp, maxMp: pChar.maxMp, sp: pChar.maxSp, maxSp: pChar.maxSp, atk: pChar.atk, def: pChar.def, skills: d.skillIds || pChar.defaultSkills },
      p2: { id: 'P2', charId: dummyChar.id, x: 10, facing: -1, hp: dummyChar.maxHp, maxHp: dummyChar.maxHp, mp: dummyChar.maxMp, maxMp: dummyChar.maxMp, sp: dummyChar.maxSp, maxSp: dummyChar.maxSp, atk: dummyChar.atk, def: dummyChar.def, skills: dummyChar.defaultSkills },
      p1Char: pChar.id, p2Char: dummyChar.id, bases,
    });
  });

  // 训练场：玩家提交序列 → 运算战斗
  socket.on('trainSubmitActions', (d) => {
    console.log('[TRAIN] received player actions length=' + (d.actions?.length || 0));
    const chars = require('../data/characters.json').characters;
    const pChar = chars.find(c => c.id === d.charId) || chars[0];
    const dummyChar = chars[0];

    const p1Def = {
      charId: pChar.id, maxHp: pChar.maxHp, maxMp: pChar.maxMp, maxSp: pChar.maxSp,
      atk: pChar.atk, def: pChar.def, skillIds: d.skillIds, customSkills: {},
    };
    const p2Def = {
      charId: dummyChar.id, maxHp: dummyChar.maxHp, maxMp: dummyChar.maxMp, maxSp: dummyChar.maxSp,
      atk: dummyChar.atk, def: dummyChar.def, skillIds: dummyChar.defaultSkills, customSkills: {},
    };

    const playerActions = (d.actions || []).slice(0, TICKS);
    while (playerActions.length < TICKS) playerActions.push('wait');
    const dummyActions = ['wait','wait','wait','wait','wait','wait','wait','wait',
      'wait','wait','wait','wait','wait','wait','wait','wait'];

    const { frames, state } = runSingleBattle(p1Def, p2Def, playerActions, dummyActions);
    socket.emit('aiBattleResult', {
      frames, final: state, round: 1,
      myCharId: pChar.id, opponentCharId: dummyChar.id, opponentName: '训练木桩',
    });
  });

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
    // 单人房间
    for (const [rid, room] of soloRooms) {
      if (room.playerSid === socket.id) { room.pActions[socket.id] = d.actions; break; }
    }
  });

  socket.on('reportBattleState', (d) => {
    for (const [rid, r] of lobbyRooms) {
      const slot = r.getPlayerSlot(socket.id);
      if (!slot || slot.type !== 'player') break;

      if (slot === r.slots[0]) {
        r._p1ClientState = d;
        r._p1Reported = true;
      } else if (slot === r.slots[1]) {
        r._p2ClientState = d;
        r._p2Reported = true;
      }

      console.log('[REPORT] room=' + rid + ' p' + (slot===r.slots[0]?'1':'2') +
        ' reported p1hp=' + d.p1.hp + ' p2hp=' + d.p2.hp);

      // 双方都回传了 → 校对
      if (r._p1Reported && r._p2Reported) {
        const s1 = r._p1State;
        const s2 = r._p2State;
        const c1 = r._p1ClientState;
        const c2 = r._p2ClientState;

        if (!s1 || !s2) {
          forceCloseRoom(r, '服务器状态丢失');
          break;
        }

        if (verifyBattleStates(s1, c1, s2, c2)) {
          console.log('[VERIFY] PASS room=' + rid);
          sendNextRound(r);
        } else {
          console.log('[VERIFY] FAIL room=' + rid);
          forceCloseRoom(r, '战斗状态不一致，房间已关闭');
        }
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

// ==================== AI/训练模式（单人房间，不入大厅） ====================
const soloRooms = new Map(); // solo room: { id, engine, round, timer, pActions, char, slot }

function startSoloPrepare(room) {
  room.round++;
  const s = room.engine.getState();
  io.to(room.playerSid).emit('prepareStart', {
    round: room.round, time: 60,
    p1: s.p1, p2: s.p2,
    p1Char: s.p1.charId, p2Char: s.p2.charId,
    bases: s.bases,
  });
  room.timer = setInterval(() => {
    // 倒计时由客户端自己处理，这里只是保底
  }, 1000);
}

function runSoloBattle(room) {
  clearInterval(room.timer);
  const playerSid = room.playerSid;
  const aiSid = room.aiSid;
  const pActions = (room.pActions[playerSid] || []).slice(0, TICKS);
  while (pActions.length < TICKS) pActions.push('wait');
  room.engine.setActions(pActions, room.pActions[aiSid] || []);
  const frames = room.engine.executeAll();
  const s = room.engine.getState();

  const judge = BattleEngine.judge(s, 30, room.round);
  const gameOver = judge !== null;

  io.to(playerSid).emit('battleFrames', { frames, final: s, round: room.round, gameOver });

  if (gameOver) {
    io.to(playerSid).emit('gameOver', {
      winner: judge.winner, p1Hp: s.p1.hp, p2Hp: s.p2.hp, reason: judge.reason,
    });
    soloRooms.delete(room.id);
  } else {
    // 保存状态继承，等待下一轮
    const prevState = room.engine.getState();
    room.engine = new BattleEngine();
    const chars = require('../data/characters.json').characters;
    room.engine.init({
      p1: {
        id: 'P1', charId: s.p1.charId, x: prevState.p1.x, facing: prevState.p1.facing,
        hp: prevState.p1.hp, maxHp: s.p1.maxHp, mp: prevState.p1.mp, maxMp: s.p1.maxMp,
        sp: prevState.p1.sp, maxSp: s.p1.maxSp, atk: s.p1.atk, def: s.p1.def,
        skills: s.p1.skills, customSkills: s.p1.customSkills || {},
      },
      p2: {
        id: 'P2', charId: s.p2.charId, x: prevState.p2.x, facing: prevState.p2.facing,
        hp: prevState.p2.hp, maxHp: s.p2.maxHp, mp: prevState.p2.mp, maxMp: s.p2.maxMp,
        sp: prevState.p2.sp, maxSp: s.p2.maxSp, atk: s.p2.atk, def: s.p2.def,
        skills: s.p2.skills, customSkills: s.p2.customSkills || {},
      },
    });
    setTimeout(() => startSoloPrepare(room), 11000);
  }
}

io.on('connection', (socket) => {

  // AI 对战
  socket.on('startAI', (d) => {
    const rid = 'AI-' + Math.random().toString(36).substring(2, 6);
    const chars = require('../data/characters.json').characters;
    const pChar = chars.find(c => c.id === d.charId) || chars[0];
    const aiChar = chars.find(c => c.id === d.aiCharId) || chars[1];

    const engine = new BattleEngine();
    engine.init({
      p1: { id: 'P1', charId: pChar.id, x: 5, facing: 1, hp: pChar.maxHp, maxHp: pChar.maxHp, mp: pChar.maxMp, maxMp: pChar.maxMp, sp: pChar.maxSp, maxSp: pChar.maxSp, atk: pChar.atk, def: pChar.def, skills: d.skillIds || pChar.defaultSkills },
      p2: { id: 'P2', charId: aiChar.id, x: 10, facing: -1, hp: aiChar.maxHp, maxHp: aiChar.maxHp, mp: aiChar.maxMp, maxMp: aiChar.maxMp, sp: aiChar.maxSp, maxSp: aiChar.maxSp, atk: aiChar.atk, def: aiChar.def, skills: d.aiSkillIds || aiChar.defaultSkills },
    });

    const room = {
      id: rid, engine, round: 0, timer: null,
      playerSid: socket.id, aiSid: 'AI-' + rid,
      pActions: {}, char: d.charId,
    };
    soloRooms.set(rid, room);
    startSoloPrepare(room);
  });

  // AI ready
  socket.on('aiReady', (d) => {
    const room = soloRooms.get(d.roomId);
    if (!room) return;
    if (d.actions && d.actions.length > 0) {
      room.pActions[room.aiSid] = d.actions.slice(0, TICKS);
    } else {
      // 随机 AI 序列
      const s = room.engine.getState();
      const hpPct = s.p2.hp / s.p2.maxHp;
      const dist = Math.abs(s.p1.x - s.p2.x);
      const pool = [];
      if (dist > 3) pool.push('move_right','move_left','move_left','move_right','skill1','skill2');
      else if (dist > 1) pool.push('skill1','skill2','defend','move_right','move_left');
      else pool.push('skill1','skill2','skill3','defend','dodge_left','dodge_right','move_left','move_right');
      if (hpPct < 0.3) pool.push('defend','defend','dodge_left','dodge_right');
      const actions = [];
      for (let i = 0; i < TICKS; i++) actions.push(pool[Math.floor(Math.random() * pool.length)]);
      room.pActions[room.aiSid] = actions;
    }
    room.pActions[socket.id] = []; // will be filled by updateActions
    // 自动设为 ready，等待玩家也 ready
  });

  // 训练模式
  socket.on('startTrain', (d) => {
    const rid = 'TR-' + Math.random().toString(36).substring(2, 6);
    const chars = require('../data/characters.json').characters;
    const pChar = chars.find(c => c.id === d.charId) || chars[0];

    const engine = new BattleEngine();
    engine.init({
      _training: true,
      p1: { id: 'P1', charId: pChar.id, x: 5, facing: 1, hp: pChar.maxHp, maxHp: pChar.maxHp, mp: pChar.maxMp, maxMp: pChar.maxMp, sp: pChar.maxSp, maxSp: pChar.maxSp, atk: pChar.atk, def: pChar.def, skills: d.skillIds || pChar.defaultSkills },
      p2: { id: 'P2', charId: 'warrior', x: 10, facing: -1, hp: 2147483647, maxHp: 2147483647, mp: 999, maxMp: 999, sp: 999, maxSp: 999, atk: 0, def: 0, skills: ['warrior_whirlwind','warrior_heavy','warrior_shieldbash'] },
    });

    const room = {
      id: rid, engine, round: 0, timer: null,
      playerSid: socket.id, aiSid: 'TRAIN-' + rid,
      pActions: {}, char: d.charId, training: true,
    };
    // pupppet does nothing
    room.pActions[room.aiSid] = new Array(TICKS).fill('wait');
    soloRooms.set(rid, room);
    startSoloPrepare(room);
  });

  // 训练 ready
  socket.on('trainReady', (d) => {
    const room = soloRooms.get(d.roomId);
    if (!room) return;
    room.pActions[socket.id] = [];
  });

  // 战斗阶段提交序列后 ready
  socket.on('ready', () => {
    // 先检查是否在大厅房间
    for (const [rid, r] of lobbyRooms) {
      const slot = r.getPlayerSlot(socket.id);
      if (slot && slot.type === 'player') {
        slot.battleReady = true;
        io.to(rid).emit('slotsUpdated', { slots: r.getSlotSummary(), hostId: r.hostId });
        if (r.state === 'playing' && r.bothPlayerSlotsFilled() &&
            r.slots[0].battleReady && r.slots[1].battleReady &&
            r.pActions[r.slots[0].sid] && r.pActions[r.slots[1].sid]) {
          r.slots[0].battleReady = false;
          r.slots[1].battleReady = false;
          startOnlineBattle(r);
        }
        return;
      }
    }
    // 检查单人房间
    for (const [rid, room] of soloRooms) {
      if (room.playerSid === socket.id) {
        runSoloBattle(room);
        return;
      }
    }
  });
});

const PORT = process.env.PORT || 3456;
server.listen(PORT, () => console.log('Debug-Lite v3 on http://localhost:' + PORT));
