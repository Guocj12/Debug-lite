// Debug-Lite 游戏核心逻辑

class GameState {
  constructor() {
    this.socket = null;
    this.roomId = null;
    this.playerNum = 0;
    this.gameMode = null; // 'ai' | 'online'
    this.selectedChar = null;
    this.selectedSkills = [];
    this.actions = [];
    this.maxActions = 6;
    this.battleState = null;
    this.isReady = false;
    this.prepareTime = 60;
    this.currentRound = 1;
  }

  reset() {
    this.actions = [];
    this.isReady = false;
    this.battleState = null;
  }
}

const game = new GameState();

// ======== Socket连接 ========
function connectSocket() {
  game.socket = io();
  
  game.socket.on('connect', () => {
    console.log('已连接服务器');
  });

  game.socket.on('roomCreated', (data) => {
    game.roomId = data.roomId;
    game.playerNum = data.playerNum;
    document.getElementById('onlineStatus').textContent = 
      `房间号: ${data.roomId} | 等待对手加入...`;
  });

  game.socket.on('roomJoined', (data) => {
    game.roomId = data.roomId;
    game.playerNum = data.playerNum;
    document.getElementById('onlineStatus').textContent = 
      `已加入房间: ${data.roomId}`;
  });

  game.socket.on('playerJoined', (data) => {
    document.getElementById('onlineStatus').textContent = 
      `对手已加入! 房间: ${game.roomId}`;
    // 进入角色选择
    setTimeout(() => {
      showScreen('characterSelect');
      initCharacterSelect();
    }, 1000);
  });

  game.socket.on('aiGameStart', (data) => {
    game.roomId = data.roomId;
    game.playerNum = data.playerNum;
    game.gameMode = 'ai';
    showScreen('preparePhase');
    initPreparePhase();
    audio.playBGM('battle');
  });

  game.socket.on('characterSelected', (data) => {
    // 双方角色选择确认
  });

  game.socket.on('preparePhase', (data) => {
    game.currentRound = data.round;
    game.prepareTime = data.timeLeft;
    game.reset();
    showScreen('preparePhase');
    initPreparePhase();
    audio.playBGM('prepare');
  });

  game.socket.on('roundReset', (data) => {
    // 新一轮开始
    game.currentRound = data.round;
    game.reset();
    
    // 重置ready按钮
    const readyBtn = document.getElementById('readyBtn');
    if (readyBtn) {
      readyBtn.disabled = false;
      readyBtn.textContent = '✅ 完成';
    }
    
    // 使用服务端传来的HP
    game.battleState = {
      p1Hp: data.p1Hp,
      p2Hp: data.p2Hp,
      p1Mp: data.p1Mp || 50,
      p2Mp: data.p2Mp || 50,
      p1Pos: { x: 1, y: 1 },
      p2Pos: { x: 7, y: 1 },
      p1Char: game.selectedChar || 'warrior',
      p2Char: 'warrior'
    };
    
    updateHPMPDisplay();
    renderActionSlots();
    renderBattleState();
    
    document.getElementById('roundText').textContent = `ROUND ${data.round}`;
    
    // 清除旧日志
    const logContent = document.getElementById('logContent');
    if (logContent) logContent.innerHTML = '';
  });

  game.socket.on('prepareTick', (data) => {
    game.prepareTime = data.timeLeft;
    updateTimer(data.timeLeft);
  });

  game.socket.on('playerReady', (data) => {
    const statusEl = document.getElementById('onlineStatus');
    if (statusEl) {
      statusEl.textContent = `对手已准备`;
    }
  });

  game.socket.on('battleStep', (data) => {
    game.battleState = data.results;
    animateBattleStep(data);
  });

  game.socket.on('playerLeft', (data) => {
    alert('对手已离开');
    showScreen('mainMenu');
  });

  game.socket.on('error', (data) => {
    alert(data.message);
  });

  game.socket.on('disconnect', () => {
    console.log('连接断开');
  });

  game.socket.on('gameOver', (data) => {
    audio.stopBGM();
    if (data.winner === 'P1' && game.playerNum === 1 || 
        data.winner === 'P2' && game.playerNum === 2 ||
        (game.gameMode === 'ai' && data.winner === 'P1')) {
      showResult('胜利!', data);
    } else if (data.winner === 'draw') {
      showResult('平局!', data);
    } else {
      showResult('失败...', data);
    }
    audio.playSFX(data.winner === 'P1' && game.playerNum === 1 ? 'skill' : 'death');
  });
}

// ======== 界面切换 ========
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(screenId);
  if (screen) {
    screen.classList.add('active');
  }
}

// ======== 主菜单背景动画 ========
function startMenuAnimation() {
  const canvas = document.getElementById('menuCanvas');
  if (!canvas) return;
  
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  const ctx = canvas.getContext('2d');
  
  function animate(time) {
    if (!document.getElementById('mainMenu').classList.contains('active')) {
      requestAnimationFrame(animate);
      return;
    }
    renderer.renderMenuBg(ctx, time);
    requestAnimationFrame(animate);
  }
  
  requestAnimationFrame(animate);
}

// ======== 角色选择 ========
let selectedCharId = null;
let selectedSkillIds = [];

function initCharacterSelect() {
  selectedCharId = null;
  selectedSkillIds = [];
  
  const grid = document.getElementById('charGrid');
  const skillSection = document.getElementById('skillSelection');
  const skillGrid = document.getElementById('skillGrid');
  
  grid.innerHTML = '';
  skillGrid.innerHTML = '';
  
  // 加载角色
  if (!renderer.charData) {
    renderer.init().then(() => renderCharacters());
  } else {
    renderCharacters();
  }
  
  // 加载技能
  if (!renderer.skillData) {
    renderer.init().then(() => renderSkills());
  } else {
    renderSkills();
  }
  
  skillSection.classList.add('hidden');
}

function renderCharacters() {
  const grid = document.getElementById('charGrid');
  if (!renderer.charData) return;
  
  renderer.charData.characters.forEach(char => {
    const card = document.createElement('div');
    card.className = 'char-card';
    card.onclick = () => selectCharacter(char.id, card);
    
    const canvas = document.createElement('canvas');
    renderer.drawCharAvatar(canvas, char.id, 64);
    
    card.innerHTML = `
      ${canvas.outerHTML}
      <div class="char-name">${char.name}</div>
      <div class="char-stats">HP:${char.maxHp} ATK:${char.atk} DEF:${char.def}</div>
      <div class="char-desc">${char.description}</div>
    `;
    
    grid.appendChild(card);
  });
}

function renderSkills() {
  const skillGrid = document.getElementById('skillGrid');
  if (!renderer.skillData) return;
  
  renderer.skillData.skills.forEach(skill => {
    const card = document.createElement('div');
    card.className = 'skill-card';
    card.onclick = () => toggleSkill(skill.id, card);
    
    const canvas = document.createElement('canvas');
    renderer.drawSkillIcon(canvas, skill.id, 32);
    
    card.innerHTML = `
      ${canvas.outerHTML}
      <div class="skill-name">${skill.name}</div>
    `;
    
    skillGrid.appendChild(card);
  });
}

function selectCharacter(charId, cardEl) {
  selectedCharId = charId;
  game.selectedChar = charId;
  
  document.querySelectorAll('.char-card').forEach(c => c.classList.remove('selected'));
  cardEl.classList.add('selected');
  
  // 显示技能选择
  document.getElementById('skillSelection').classList.remove('hidden');
  
  audio.playSFX('countdown');
}

function toggleSkill(skillId, cardEl) {
  const idx = selectedSkillIds.indexOf(skillId);
  if (idx >= 0) {
    selectedSkillIds.splice(idx, 1);
    cardEl.classList.remove('selected');
  } else {
    if (selectedSkillIds.length >= 3) {
      // 移除第一个
      const oldId = selectedSkillIds.shift();
      document.querySelectorAll('.skill-card').forEach(c => {
        if (c.querySelector('.skill-name')?.textContent === 
            renderer.skillData.skills.find(s => s.id === oldId)?.name) {
          c.classList.remove('selected');
        }
      });
    }
    selectedSkillIds.push(skillId);
    cardEl.classList.add('selected');
  }
  
  audio.playSFX('countdown');
}

// ======== AI对战启动 ========
function startAIGame() {
  if (!selectedCharId) {
    alert('请先选择角色!');
    return;
  }
  if (selectedSkillIds.length === 0) {
    selectedSkillIds = ['slash', 'shield', 'heal']; // 默认技能
  }
  
  game.selectedSkills = selectedSkillIds;
  game.selectedChar = selectedCharId;
  
  // 随机AI角色
  const aiChars = renderer.charData.characters.filter(c => c.id !== selectedCharId);
  const aiChar = aiChars[Math.floor(Math.random() * aiChars.length)];
  const aiSkills = ['slash', 'fireball', 'shield'];
  
  game.socket.emit('startAI', {
    name: '玩家',
    charId: selectedCharId,
    skillIds: selectedSkillIds,
    aiCharId: aiChar.id,
    aiSkillIds: aiSkills,
    difficulty: 'normal'
  });
}

// ======== 在线对战 ========
function initOnlineLobby() {
  if (!game.socket) connectSocket();
  document.getElementById('onlineStatus').textContent = '';
}

function createRoom() {
  const name = document.getElementById('playerName').value || 'Player';
  game.socket.emit('createRoom', { name });
  audio.playSFX('countdown');
}

function joinRoom() {
  const code = document.getElementById('roomCode').value.toUpperCase();
  const name = document.getElementById('playerName').value || 'Player';
  if (!code) {
    alert('请输入房间号');
    return;
  }
  game.socket.emit('joinRoom', { roomId: code, name });
  audio.playSFX('countdown');
}

// ======== 准备阶段 ========
function initPreparePhase() {
  game.reset();
  
  document.getElementById('roundText').textContent = `ROUND ${game.currentRound}`;
  document.getElementById('timerDisplay').textContent = game.prepareTime;
  
  // 更新HP/MP显示
  updateHPMPDisplay();
  
  // 清空行动队列
  renderActionSlots();
  
  // 初始化战斗场地渲染
  initBattleCanvas();
  renderBattleState();
  
  // 准备计时器(本地显示用)
  const timerDisplay = document.getElementById('timerDisplay');
  let timeLeft = game.prepareTime;
  
  if (game._localTimer) clearInterval(game._localTimer);
  game._localTimer = setInterval(() => {
    timeLeft--;
    if (timerDisplay) timerDisplay.textContent = timeLeft;
    if (timeLeft <= 5) {
      audio.playSFX('countdown');
    }
  }, 1000);
}

function updateTimer(time) {
  document.getElementById('timerDisplay').textContent = time;
}

function updateHPMPDisplay() {
  const defaultMaxHp = 100;
  const defaultMaxMp = 50;
  
  if (!game.battleState) {
    document.getElementById('p1HpBar').style.width = '100%';
    document.getElementById('p1HpText').textContent = `${defaultMaxHp}/${defaultMaxHp}`;
    document.getElementById('p1MpBar').style.width = '100%';
    document.getElementById('p1MpText').textContent = `${defaultMaxMp}/${defaultMaxMp}`;
    document.getElementById('p2HpBar').style.width = '100%';
    document.getElementById('p2HpText').textContent = `${defaultMaxHp}/${defaultMaxHp}`;
    document.getElementById('p2MpBar').style.width = '100%';
    document.getElementById('p2MpText').textContent = `${defaultMaxMp}/${defaultMaxMp}`;
    return;
  }
  
  const p1MaxHp = game.battleState.p1MaxHp || defaultMaxHp;
  const p2MaxHp = game.battleState.p2MaxHp || defaultMaxHp;
  const p1MaxMp = game.battleState.p1MaxMp || defaultMaxMp;
  const p2MaxMp = game.battleState.p2MaxMp || defaultMaxMp;
  
  const p1HpVal = Math.max(0, game.battleState.p1Hp || 0);
  const p2HpVal = Math.max(0, game.battleState.p2Hp || 0);
  const p1MpVal = Math.max(0, game.battleState.p1Mp || 0);
  const p2MpVal = Math.max(0, game.battleState.p2Mp || 0);
  
  document.getElementById('p1HpBar').style.width = Math.max(0, (p1HpVal / p1MaxHp) * 100) + '%';
  document.getElementById('p1HpText').textContent = `${p1HpVal}/${p1MaxHp}`;
  document.getElementById('p1MpBar').style.width = Math.max(0, (p1MpVal / p1MaxMp) * 100) + '%';
  document.getElementById('p1MpText').textContent = `${p1MpVal}/${p1MaxMp}`;
  document.getElementById('p2HpBar').style.width = Math.max(0, (p2HpVal / p2MaxHp) * 100) + '%';
  document.getElementById('p2HpText').textContent = `${p2HpVal}/${p2MaxHp}`;
  document.getElementById('p2MpBar').style.width = Math.max(0, (p2MpVal / p2MaxMp) * 100) + '%';
  document.getElementById('p2MpText').textContent = `${p2MpVal}/${p2MaxMp}`;
}

// ======== 行动队列操作 ========
function addAction(action) {
  if (game.actions.length >= game.maxActions) {
    return;
  }
  game.actions.push(action);
  renderActionSlots();
  
  // 同步到服务器
  if (game.socket) {
    game.socket.emit('updateActions', { actions: game.actions });
  }
  
  audio.playSFX('countdown');
}

function clearActions() {
  game.actions = [];
  renderActionSlots();
  if (game.socket) {
    game.socket.emit('updateActions', { actions: [] });
  }
}

function undoAction() {
  game.actions.pop();
  renderActionSlots();
  if (game.socket) {
    game.socket.emit('updateActions', { actions: game.actions });
  }
}

function fillRandom() {
  const actionList = ['左', '右', '上', '下', '攻', '防', '技1', '技2', '技3', '攻', '攻', '防'];
  game.actions = [];
  for (let i = 0; i < game.maxActions; i++) {
    game.actions.push(actionList[Math.floor(Math.random() * actionList.length)]);
  }
  renderActionSlots();
  if (game.socket) {
    game.socket.emit('updateActions', { actions: game.actions });
  }
  audio.playSFX('countdown');
}

function renderActionSlots() {
  const slots = document.getElementById('actionSlots');
  const lenDisplay = document.getElementById('actionLength');
  
  lenDisplay.textContent = `(${game.actions.length}/${game.maxActions})`;
  slots.innerHTML = '';
  
  game.actions.forEach((action, i) => {
    const slot = document.createElement('div');
    slot.className = 'action-slot';
    slot.innerHTML = `<span class="slot-num">${i + 1}</span>${action}`;
    slot.onclick = () => {
      game.actions.splice(i, 1);
      renderActionSlots();
      if (game.socket) {
        game.socket.emit('updateActions', { actions: game.actions });
      }
    };
    slots.appendChild(slot);
  });
  
  // 空槽位
  for (let i = game.actions.length; i < game.maxActions; i++) {
    const slot = document.createElement('div');
    slot.className = 'action-slot';
    slot.style.opacity = '0.3';
    slot.innerHTML = `<span class="slot-num">${i + 1}</span>⋯`;
    slots.appendChild(slot);
  }
}

function readyForBattle() {
  game.isReady = true;
  document.getElementById('readyBtn').disabled = true;
  document.getElementById('readyBtn').textContent = '⏳ 已准备';
  
  if (game.socket) {
    game.socket.emit('ready');
    
    if (game.gameMode === 'ai') {
      game.socket.emit('aiReady', { roomId: game.roomId, difficulty: 'normal' });
    }
  }
  
  audio.playSFX('skill');
}

// ======== 战斗场地渲染 ========
function initBattleCanvas() {
  const canvas = document.getElementById('battleCanvas');
  if (!canvas) return;
  
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = canvas.parentElement.clientHeight;
  
  const ctx = canvas.getContext('2d');
  renderBattleState();
}

function renderBattleState() {
  const canvas = document.getElementById('battleCanvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const state = game.battleState || {
    p1Pos: { x: 1, y: 1 },
    p2Pos: { x: 7, y: 1 },
    p1Char: game.selectedChar || 'warrior',
    p2Char: 'warrior',
    p1Hp: 100,
    p2Hp: 100
  };
  
  renderer.renderBattle(ctx, state);
}

// ======== 战斗动画 ========
function animateBattleStep(data) {
  const canvas = document.getElementById('battleCanvas');
  if (!canvas) return;
  
  const ctx = canvas.getContext('2d');
  const state = data.results;
  game.battleState = state;
  
  updateHPMPDisplay();
  
  // 更新日志
  if (state.log && state.log.length > 0) {
    const logContent = document.getElementById('logContent');
    if (logContent) {
      const latest = state.log.slice(-5);
      logContent.innerHTML = latest.map(l => {
        let cls = 'log-line';
        if (l.includes('伤害')) cls += ' log-damage';
        else if (l.includes('防御')) cls += ' log-defend';
        else if (l.includes('恢复')) cls += ' log-heal';
        else if (l.includes('技能')) cls += ' log-skill';
        return `<div class="${cls}">${l}</div>`;
      }).join('');
      logContent.scrollTop = logContent.scrollHeight;
    }
  }
  
  // 播放动画步骤
  if (state.animSteps && state.animSteps.length > 0) {
    let stepIdx = 0;
    
    function playNextStep() {
      if (stepIdx >= state.animSteps.length) return;
      
      const step = state.animSteps[stepIdx];
      renderer.renderAnimStep(ctx, step, state, canvas.width, canvas.height);
      
      // 播放音效
      switch (step.action) {
        case 'attack': audio.hit(); break;
        case 'defend': audio.block(); break;
        case 'skill': audio.skill(); break;
        case 'counter': audio.block(); break;
      }
      
      stepIdx++;
      setTimeout(playNextStep, 400);
    }
    
    playNextStep();
  }
  
  // 渲染最终状态
  renderBattleState();
}

// ======== 结果 ========
function showResult(title, data) {
  showScreen('resultScreen');
  document.getElementById('resultTitle').textContent = title;
  document.getElementById('resultTitle').style.color = 
    title === '胜利!' ? 'var(--neon-yellow)' : 'var(--neon-pink)';
  document.getElementById('resultDetail').innerHTML = `
    P1 HP: ${data.p1Hp} / 100<br>
    P2 HP: ${data.p2Hp} / 100<br>
    ${data.reason === 'maxRounds' ? '(回合上限)' : ''}
  `;
}

// ======== 窗口调整 ========
window.addEventListener('resize', () => {
  const canvas = document.getElementById('battleCanvas');
  if (canvas && document.getElementById('preparePhase').classList.contains('active')) {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    renderBattleState();
  }
  
  const menuCanvas = document.getElementById('menuCanvas');
  if (menuCanvas) {
    menuCanvas.width = window.innerWidth;
    menuCanvas.height = window.innerHeight;
  }
});

// ======== 初始化 ========
window.addEventListener('load', () => {
  audio.init();
  renderer.init();
  connectSocket();
  startMenuAnimation();
  
  // 主菜单BGM
  setTimeout(() => {
    audio.playBGM('menu');
  }, 1000);
});

// ======== 键盘快捷键(PC端补充) ========
document.addEventListener('keydown', (e) => {
  if (!document.getElementById('preparePhase').classList.contains('active')) return;
  
  switch(e.key.toLowerCase()) {
    case 'a': addAction('左'); break;
    case 'd': addAction('右'); break;
    case 'w': addAction('上'); break;
    case 's': addAction('下'); break;
    case 'j': addAction('攻'); break;
    case 'k': addAction('防'); break;
    case '1': addAction('技1'); break;
    case '2': addAction('技2'); break;
    case '3': addAction('技3'); break;
    case 'backspace': undoAction(); break;
    case 'escape': clearActions(); break;
    case 'enter': readyForBattle(); break;
    case 'r': fillRandom(); break;
  }
});

// 确保音频上下文在用户交互后启动
document.addEventListener('click', () => {
  if (audio.ctx && audio.ctx.state === 'suspended') {
    audio.ctx.resume();
  }
}, { once: true });
