// Debug-Lite v2 前端

// ============ Audio Engine ============
const AE = {
  ctx: null, on: true, vol: 0.15,
  init() {
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  },
  tone(f, d, t, type) {
    if (!this.ctx || !this.on || f <= 0) return;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    const now = this.ctx.currentTime + (t || 0);
    o.type = type || 'square'; o.frequency.setValueAtTime(f, now);
    g.gain.setValueAtTime(this.vol, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + d);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(now); o.stop(now + d + 0.02);
  },
  sfx(name) {
    const m = { hit: [[200,0.05,0,'square'],[100,0.06,0.03,'square']],
      block: [[400,0.05,0,'triangle'],[300,0.05,0.03,'triangle']],
      skill: [[500,0.06,0,'sawtooth'],[700,0.06,0.05,'sawtooth'],[900,0.1,0.1,'sawtooth']],
      tick: [[800,0.04,0,'square']], death: [[300,0.15,0,'sawtooth'],[150,0.3,0.2,'sawtooth']],
      win: [[500,0.1,0,'square'],[700,0.1,0.12,'square'],[1000,0.2,0.25,'square']],
      dodge: [[600,0.03,0,'sine'],[800,0.04,0.02,'sine']],
      projectile: [[300,0.04,0,'square'],[500,0.05,0.03,'square']],
    };
    (m[name]||[]).forEach(n => this.tone(n[0],n[1],n[2],n[3]));
  },
};

// ============ Renderer ============
const R = {
  shapes: {
    square: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.fillRect(x-s/2, y-s/2, s, s); },
    triangle: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x, y-s/2); ctx.lineTo(x+s/2, y+s/2); ctx.lineTo(x-s/2, y+s/2); ctx.closePath(); ctx.fill(); },
    triangle2: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x, y+s/2); ctx.lineTo(x+s/2, y-s/2); ctx.lineTo(x-s/2, y-s/2); ctx.closePath(); ctx.fill(); },
    diamond: (ctx, x, y, s, c) => { ctx.fillStyle = c; ctx.beginPath(); ctx.moveTo(x, y-s/2); ctx.lineTo(x+s/2, y); ctx.lineTo(x, y+s/2); ctx.lineTo(x-s/2, y); ctx.closePath(); ctx.fill(); },
  },

  renderField(canvas, state, previewMode, actions, actionIdx) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width = canvas.parentElement.clientWidth;
    const H = canvas.height = canvas.parentElement.clientHeight;
    ctx.clearRect(0, 0, W, H);

    // 纯黑背景
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    const cellW = W / 16;
    const groundY = H * 0.7;
    const charY = groundY - cellW * 0.4;

    // 蓝线
    ctx.strokeStyle = '#0066cc';
    ctx.shadowColor = '#0066ff';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, groundY); ctx.lineTo(W, groundY); ctx.stroke();
    ctx.shadowBlur = 0;

    // 网格竖线
    ctx.strokeStyle = 'rgba(0,100,200,0.08)';
    ctx.lineWidth = 0.5;
    for (let i = 0; i <= 16; i++) {
      ctx.beginPath(); ctx.moveTo(i * cellW, 0); ctx.lineTo(i * cellW, H); ctx.stroke();
    }

    // 角色
    const chars = G.charData?.characters || [];
    if (!state) return;

    [state.p1, state.p2].forEach((p, idx) => {
      const cd = chars.find(c => c.id === p.charId) || chars[0];
      const cx = (p.x + 0.5) * cellW;
      const cy = charY;

      // 角色朝向（第二个角色镜像）
      ctx.save();
      if (idx === 1) {
        // P2 facing
      }

      // 发光
      ctx.shadowColor = cd.color;
      ctx.shadowBlur = 15;
      this.shapes[cd.shape || 'square'](ctx, cx, cy, cd.size, cd.color + '44');
      ctx.shadowBlur = 8;
      this.shapes[cd.shape || 'square'](ctx, cx, cy, cd.size * 0.8, cd.color);
      ctx.shadowBlur = 0;

      // 朝向箭头
      ctx.fillStyle = '#fff';
      const ax = cx + p.facing * cd.size * 0.7;
      ctx.beginPath();
      ctx.moveTo(ax, cy - 4);
      ctx.lineTo(ax + p.facing * 6, cy);
      ctx.lineTo(ax, cy + 4);
      ctx.fill();

      // dodge特效(拖尾)
      if (p.dodging) {
        ctx.globalAlpha = 0.4;
        for (let i = 1; i <= 3; i++) {
          const tx = cx - p.facing * i * 8;
          ctx.fillStyle = cd.color;
          ctx.fillRect(tx - 3, cy - 3, 6, 6);
        }
        ctx.globalAlpha = 1;
      }

      ctx.restore();
    });

    // 弹幕
    if (state.bullets) {
      state.bullets.forEach(b => {
        const bx = (b.x + 0.5) * cellW;
        const by = groundY - 25;
        ctx.fillStyle = b.color || '#fff';
        ctx.shadowColor = b.color;
        ctx.shadowBlur = 10;
        if (b.isShield) {
          ctx.strokeStyle = b.color;
          ctx.lineWidth = 3;
          ctx.strokeRect(bx - cellW * 0.3, by - cellW * 0.3, cellW * 0.6, cellW * 0.6);
        } else {
          const sz = 5 + (4 - (b.priority || 4)) * 3;
          ctx.fillRect(bx - sz/2, by - sz/2, sz, sz);
        }
        ctx.shadowBlur = 0;
      });
    }

    // 碰撞粒子
    (state._particles || []).forEach(pt => {
      ctx.fillStyle = pt.c;
      ctx.globalAlpha = pt.a || 1;
      ctx.fillRect(pt.x, pt.y, pt.s || 3, pt.s || 3);
    });
    ctx.globalAlpha = 1;

    // Grid labels
    ctx.fillStyle = 'rgba(0,150,255,0.3)';
    ctx.font = '8px monospace';
    for (let i = 0; i < 16; i++) {
      ctx.fillText(i, i * cellW + 2, H - 3);
    }
  },
};

// ============ GAME STATE ============
const G = {
  socket: null, roomId: null, n: 0, mode: null,
  selChar: null, selSkills: [], actions: [], maxAct: 16,
  round: 1, ready: false,
  state: null, // current battle state
  charData: null, skillData: null,
  _timer: null,
};

async function loadData() {
  try {
    G.charData = await (await fetch('/data/characters.json')).json();
    G.skillData = await (await fetch('/data/skills.json')).json();
  } catch(e) { console.error(e); }
}

// ============ NAV ============
function nav(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ============ SOCKET ============
function connect() {
  if (G.socket) return;
  G.socket = io();

  G.socket.on('roomCreated', d => { G.roomId = d.roomId; G.n = d.n; el('ostatus').textContent = `房间: ${d.roomId} | 等待对手...`; });
  G.socket.on('roomJoined', d => { G.roomId = d.roomId; G.n = d.n; el('ostatus').textContent = `已加入: ${d.roomId}`; });
  G.socket.on('playerJoined', d => { el('ostatus').textContent = '对手已加入!'; setTimeout(() => { nav('charSel'); initCharSel(); }, 800); });
  G.socket.on('charSelected', d => {});

  G.socket.on('prepareStart', d => {
    G.round = d.round; G.ready = false; G.actions = [];
    G.state = { p1: d.p1, p2: d.p2, bullets: [], _particles: [] };
    nav('battle'); initBattleUI(d);
  });
  G.socket.on('prepareTick', d => { el('tm').textContent = d.t; if (d.t <= 5) AE.sfx('tick'); });
  G.socket.on('playerReady', d => {});

  G.socket.on('battleFrames', d => {
    G.state = d.final;
    playBattleFrames(d.frames, d.final);
  });

  G.socket.on('gameOver', d => {
    if (G._timer) clearInterval(G._timer);
    nav('result');
    const won = (d.winner === 'P1' && G.n === 1) || (d.winner === 'P2' && G.n === 2) || (G.mode === 'ai' && d.winner === 'P1');
    el('rtitle').textContent = won ? '胜利!' : (d.winner === 'draw' ? '平局' : '失败...');
    el('rtitle').style.color = won ? 'var(--c3)' : 'var(--c2)';
    el('rdetail').innerHTML = `P1 HP: ${d.p1Hp} / P2 HP: ${d.p2Hp}<br>${d.reason === 'maxRounds' ? '(回合上限)' : ''}`;
    AE.sfx(won ? 'win' : 'death');
  });

  G.socket.on('playerLeft', () => { alert('对手离开'); nav('menu'); });
  G.socket.on('err', d => alert(d.msg));

  G.socket.on('aiStart', d => { G.roomId = d.roomId; G.n = d.n; G.mode = 'ai'; });
}

// ============ CHAR SELECT ============
function initCharSel() {
  G.selChar = null; G.selSkills = [];
  const cg = el('cg'); cg.innerHTML = '';
  (G.charData?.characters || []).forEach(c => {
    const div = doc('div'); div.className = 'cc';
    div.innerHTML = `<canvas id="cav_${c.id}" width="48" height="48"></canvas><div class="cn">${c.name}</div><div class="cs">HP:${c.maxHp} ATK:${c.atk} DEF:${c.def}<br>${c.desc}</div>`;
    div.onclick = () => selectChar(c, div);
    cg.appendChild(div);
    // draw shape
    setTimeout(() => {
      const cv = el('cav_' + c.id); if (!cv) return;
      const ctx = cv.getContext('2d');
      R.shapes[c.shape](ctx, 24, 24, c.size * 1.5, c.color);
    }, 50);
  });
  el('skillSel').classList.add('hidden');
}

function selectChar(c, div) {
  G.selChar = c.id; G.selSkills = [...c.defaultSkills];
  document.querySelectorAll('.cc').forEach(x => x.classList.remove('sel'));
  div.classList.add('sel');
  el('skillSel').classList.remove('hidden');
  renderSkillSelect(c);
  AE.sfx('tick');
}

function renderSkillSelect(char) {
  const sg = el('sg'); sg.innerHTML = '';
  const allSkills = G.skillData?.skills || {};
  // default skills first
  char.defaultSkills.forEach(sid => {
    const s = allSkills[sid]; if (!s) return;
    addSkillCard(sg, s, true);
  });
  // other skills for this char
  Object.values(allSkills).forEach(s => {
    if (s.charId === char.id && !char.defaultSkills.includes(s.id)) {
      addSkillCard(sg, s, false);
    }
  });
  // custom skills (placeholder)
}

function addSkillCard(sg, s, isDefault) {
  const div = doc('div'); div.className = 'sc' + (G.selSkills.includes(s.id) ? ' sel' : '');
  div.innerHTML = `<div class="sn">${s.name}</div><div class="st">${s.type} ${isDefault ? '(默认)' : ''}</div>`;
  div.onclick = () => {
    const idx = G.selSkills.indexOf(s.id);
    if (idx >= 0) { G.selSkills.splice(idx, 1); div.classList.remove('sel'); }
    else {
      if (G.selSkills.length >= 3) { const old = G.selSkills.shift(); sg.querySelectorAll('.sc').forEach(c => { if (c.querySelector('.sn')?.textContent === G.skillData.skills[old]?.name) c.classList.remove('sel'); }); }
      G.selSkills.push(s.id); div.classList.add('sel');
    }
    AE.sfx('tick');
  };
  sg.appendChild(div);
}

// ============ LOBBY ============
function initLobby() { connect(); el('ostatus').textContent = ''; }
function createRoom() {
  const n = el('pname').value || 'Player';
  G.socket.emit('createRoom', { name: n });
  AE.sfx('tick');
}
function joinRoom() {
  const c = el('rcode').value.toUpperCase();
  const n = el('pname').value || 'Player';
  if (!c) return alert('输入房间号');
  G.socket.emit('joinRoom', { roomId: c, name: n });
  AE.sfx('tick');
}

// ============ AI GAME ============
function startAIGame() {
  if (!G.selChar) return alert('请选角色');
  if (G.selSkills.length === 0) G.selSkills = (G.charData.characters.find(c => c.id === G.selChar)?.defaultSkills || []);
  const aiChars = G.charData.characters.filter(c => c.id !== G.selChar);
  const aiChar = aiChars[Math.floor(Math.random() * aiChars.length)];
  G.socket.emit('startAI', {
    name: 'Player', charId: G.selChar, skillIds: G.selSkills,
    aiCharId: aiChar.id, aiSkillIds: [...aiChar.defaultSkills]
  });
}

// ============ BATTLE UI ============
function initBattleUI(d) {
  el('rnd').textContent = `ROUND ${d.round}`;
  el('tm').textContent = d.time || 60;
  el('rdyBtn').disabled = false; el('rdyBtn').textContent = '✅ 完成';
  el('logc').innerHTML = '';

  updateHUD(d);
  renderActionSlots();
  renderActionButtons();
  drawField();
}

function updateHUD(d) {
  const p1 = d?.p1 || G.state?.p1 || {};
  const p2 = d?.p2 || G.state?.p2 || {};

  [ ['p1', p1], ['p2', p2] ].forEach(([pre, p]) => {
    el(pre + 'hp').style.width = Math.max(0, (p.hp||0) / (p.maxHp||1) * 100) + '%';
    el(pre + 'hpt').textContent = `${p.hp||0}/${p.maxHp||0}`;
    el(pre + 'mp').style.width = Math.max(0, (p.mp||0) / (p.maxMp||1) * 100) + '%';
    el(pre + 'mpt').textContent = `${p.mp||0}/${p.maxMp||0}`;
    el(pre + 'sp').style.width = Math.max(0, (p.sp||0) / (p.maxSp||1) * 100) + '%';
    el(pre + 'spt').textContent = `${p.sp||0}/${p.maxSp||0}`;
  });
}

// ============ ACTION QUEUE ============
function renderActionButtons() {
  const btns = [
    ['◀左','move_left'],['▶右','move_right'],['◀◀闪','dodge_left'],['▶▶闪','dodge_right'],
    ['🛡防','defend'],['🔄转','turn'],
    ['技1','skill1'],['技2','skill2'],['技3','skill3'],
  ];
  const ab = el('abtns'); ab.innerHTML = '';
  btns.forEach(([label, val]) => {
    const btn = doc('button'); btn.className = 'ab'; btn.textContent = label;
    btn.onclick = () => addAction(val);
    ab.appendChild(btn);
  });
}

function addAction(a) {
  if (G.actions.length >= G.maxAct) return;
  G.actions.push(a);
  renderActionSlots();
  if (G.socket) G.socket.emit('updateActions', { actions: G.actions });
  // 预览——本地预览移动
  previewAction(a);
  AE.sfx('tick');
}

function previewAction(a) {
  if (!G.state) return;
  const p1 = G.state.p1;
  // 简单本地预览（不影响服务端状态）
  const intent = { dx: 0, isDodge: false };
  if (a === 'move_left') intent.dx = -1;
  if (a === 'move_right') intent.dx = 1;
  if (a === 'dodge_left') { intent.dx = -2; intent.isDodge = true; }
  if (a === 'dodge_right') { intent.dx = 2; intent.isDodge = true; }
  if (a === 'turn') p1.facing *= -1;

  if (intent.dx !== 0) {
    let dest = p1.x + intent.dx;
    dest = Math.max(0, Math.min(15, dest));
    if (intent.isDodge) {
      p1._previewDodge = true;
    } else {
      if (dest === G.state.p2.x) dest = p1.x;
    }
    G.state.p2._previewDodge = false;
    // save old for undo
    if (!G._previewStack) G._previewStack = [];
    G._previewStack.push({ x: p1.x, facing: p1.facing });
    p1.x = dest;
  }

  drawField();

  // 清除over 1s后的dodge预览效果
  if (intent.isDodge) {
    setTimeout(() => { if (G.state?.p1) G.state.p1._previewDodge = false; drawField(); }, 600);
  }
}

function undoAction() {
  G.actions.pop();
  renderActionSlots();
  if (G.socket) G.socket.emit('updateActions', { actions: G.actions });
  // undo preview
  if (G._previewStack && G._previewStack.length > 0) {
    const prev = G._previewStack.pop();
    if (G.state?.p1) {
      G.state.p1.x = prev.x;
      G.state.p1.facing = prev.facing;
    }
  }
  drawField();
}

function clearActions() {
  G.actions = []; G._previewStack = [];
  renderActionSlots();
  if (G.socket) G.socket.emit('updateActions', { actions: [] });
  // 重置预览位置
  if (G.state?.p1) {
    // reset to original pos from server
  }
  drawField();
}

function randomFill() {
  const pool = ['move_left','move_right','move_right','defend','skill1','skill2','skill3','dodge_left','dodge_right','turn'];
  G.actions = [];
  for (let i = 0; i < 16; i++) G.actions.push(pool[Math.floor(Math.random() * pool.length)]);
  renderActionSlots();
  if (G.socket) G.socket.emit('updateActions', { actions: G.actions });
  AE.sfx('tick');
}

function renderActionSlots() {
  const slots = el('aslots');
  el('acnt').textContent = `(${G.actions.length}/16)`;
  slots.innerHTML = '';
  G.actions.forEach((a, i) => {
    const div = doc('div'); div.className = 'as';
    const labels = { move_left: '◀', move_right: '▶', dodge_left: '◀◀', dodge_right: '▶▶', defend: '🛡', turn: '🔄', skill1: '技1', skill2: '技2', skill3: '技3' };
    div.innerHTML = `<span class="sn">${i+1}</span>${labels[a] || a}`;
    div.onclick = () => {
      G.actions.splice(i, 1); renderActionSlots();
      if (G.socket) G.socket.emit('updateActions', { actions: G.actions });
    };
    slots.appendChild(div);
  });
  for (let i = G.actions.length; i < 16; i++) {
    const div = doc('div'); div.className = 'as'; div.style.opacity = '0.3';
    div.innerHTML = `<span class="sn">${i+1}</span>⋯`;
    slots.appendChild(div);
  }
}

function readyBattle() {
  G.ready = true;
  el('rdyBtn').disabled = true; el('rdyBtn').textContent = '⏳ 已准备';
  G.socket.emit('ready');
  if (G.mode === 'ai') G.socket.emit('aiReady', { roomId: G.roomId });
  AE.sfx('skill');
}

// ============ BATTLE ANIMATION ============
function playBattleFrames(frames, final) {
  let idx = 0;
  function next() {
    if (idx >= frames.length) {
      G.state = final;
      updateHUD({ p1: final.p1, p2: final.p2 });
      drawField();
      return;
    }
    const f = frames[idx];
    G.state = { p1: f.p1, p2: f.p2, bullets: f.bullets || [], _particles: [] };

    // events → particles
    (f.events || []).forEach(ev => {
      if (ev.type === 'collision') {
        const px = (ev.pos + 0.5) * (el('fc').width / 16);
        for (let i = 0; i < 12; i++) {
          G.state._particles.push({ x: px + (Math.random()-0.5)*30, y: el('fc').height*0.65 + (Math.random()-0.5)*30, c: '#ffff00', s: 2+Math.random()*4, a: 1 });
        }
        AE.sfx('block');
      }
      if (ev.type === 'melee_hit') { AE.sfx('hit'); }
      if (ev.type === 'projectile_fired') { AE.sfx('projectile'); }
      if (ev.type === 'dodged') { AE.sfx('dodge'); }
    });

    updateHUD({ p1: f.p1, p2: f.p2 });
    drawField();

    // log
    const logs = (f.events || []).map(ev => {
      if (ev.type === 'collision') return `<span class="l ld">碰撞! P1:-${ev.dmg1} P2:-${ev.dmg2}</span>`;
      if (ev.type === 'melee_hit') return `<span class="l ld">${ev.actor} 近战命中 ${ev.target} -${ev.dmg}</span>`;
      if (ev.type === 'melee_miss') return `<span class="l">${ev.actor} 攻击落空</span>`;
      if (ev.type === 'projectile_fired') return `<span class="l ls">${ev.actor} 发射弹幕</span>`;
      if (ev.type === 'dodged') return `<span class="l lb">${ev.target} 闪避!</span>`;
      if (ev.type === 'dash') return `<span class="l ls">${ev.actor} 冲刺!</span>`;
      if (ev.type === 'dash_hit') return `<span class="l ld">${ev.actor} 冲撞击中 -${ev.dmg}</span>`;
      if (ev.type === 'aoe_hit') return `<span class="l ld">${ev.actor} AOE命中 -${ev.dmg}</span>`;
      if (ev.type === 'teleport') return `<span class="l ls">${ev.actor} 传送!</span>`;
      if (ev.type === 'noMp') return `<span class="l">${ev.actor} MP不足</span>`;
      return '';
    }).filter(Boolean);
    if (logs.length > 0) {
      el('logc').innerHTML = logs.slice(-4).join('');
    }

    idx++;
    setTimeout(next, 800); // ~1 tick per second but slightly faster for animation
  }
  next();
}

// ============ CANVAS ============
function drawField() {
  const canvas = el('fc');
  if (!canvas) return;
  R.renderField(canvas, G.state, false, G.actions, G.actions.length);
}

window.addEventListener('resize', () => {
  const canvas = el('fc');
  if (canvas) { canvas.width = canvas.parentElement.clientWidth; canvas.height = canvas.parentElement.clientHeight; drawField(); }
});

// ============ INIT ============
function el(id) { return document.getElementById(id); }
function doc(tag) { return document.createElement(tag); }

window.addEventListener('load', async () => {
  AE.init();
  await loadData();
  connect();
  setTimeout(() => {
    document.addEventListener('click', () => { if (AE.ctx?.state === 'suspended') AE.ctx.resume(); }, { once: true });
  }, 500);
});

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (!el('battle')?.classList.contains('active')) return;
  const map = { a: 'move_left', d: 'move_right', q: 'dodge_left', e: 'dodge_right', w: 'defend', s: 'turn', '1': 'skill1', '2': 'skill2', '3': 'skill3' };
  if (map[e.key]) { addAction(map[e.key]); return; }
  if (e.key === 'Backspace') undoAction();
  if (e.key === 'Escape') clearActions();
  if (e.key === 'Enter') readyBattle();
  if (e.key === 'r') randomFill();
});
