// Debug-Lite v2.2 - Complete rewrite with pixel animation system
const $=id=>document.getElementById(id);
const AE={ctx:null,on:true,vol:0.15,init(){try{this.ctx=new(window.AudioContext||window.webkitAudioContext)}catch(e){}},tone(f,d,t,ty){if(!this.ctx||!this.on||f<=0)return;const o=this.ctx.createOscillator(),g=this.ctx.createGain(),n=this.ctx.currentTime+(t||0);o.type=ty||'square';o.frequency.setValueAtTime(f,n);g.gain.setValueAtTime(this.vol,n);g.gain.exponentialRampToValueAtTime(.001,n+d);o.connect(g);g.connect(this.ctx.destination);o.start(n);o.stop(n+d+.02)},sfx(n){const m={hit:[[200,.05],['square']],block:[[400,.05,'triangle']],skill:[[500,.06,'sawtooth'],[700,.06,'sawtooth']],tick:[[800,.04]],death:[[300,.15],[150,.3]],win:[[500,.1],[700,.1],[1000,.2]],dodge:[[600,.03],[800,.04]],bullet:[[300,.04],[500,.05]]};(m[n]||[]).forEach(x=>this.tone(x[0],x[1],0,x[2]||'square'))}};

// Pixel sprite animation system
const Sprites={_defs:{},_cache:{},load(d){this._defs=d||{}},get(name){if(this._cache[name])return this._cache[name];const d=this._defs[name];if(!d)return null;const frames=d.frames||[d.pixels||[]];this._cache[name]={frames,w:d.w||5,h:d.h||5,color:d.color||'#fff',dur:d.frameDur||100};return this._cache[name]},draw(ctx,spr,frame,x,y,scale,alpha){if(!spr)return;const f=spr.frames[Math.min(frame,spr.frames.length-1)];const s=scale||1;ctx.globalAlpha=alpha||1;for(let r=0;r<spr.h;r++)for(let c=0;c<spr.w;c++){const ch=f[r]?.[c];if(!ch||ch===' ')continue;ctx.fillStyle=ch==='#'?spr.color:ch;ctx.fillRect(x+c*s,y+r*s,s,s)}ctx.globalAlpha=1}};

// Particle system
const FX={list:[],spawn(x,y,cfg){const{dur=500,color='#fff',count=8,spread=4}=cfg||{};for(let i=0;i<count;i++){const a=Math.random()*Math.PI*2;const spd=(Math.random()*.5+.5)*spread;this.list.push({x,y,vx:Math.cos(a)*spd,vy:Math.sin(a)*spd-1.5,life:dur,mlife:dur,color,size:2+Math.random()*4})}},spawnTrail(x,y,cfg){const{color='#fff',len=5}=cfg||{};for(let i=0;i<len;i++)this.list.push({x:x-(Math.random()-.5)*10,y:y-(Math.random()-.5)*6,vx:Math.random()-.5,vy:-Math.random()*2,life:300+Math.random()*200,mlife:500,color,size:2+Math.random()*2,type:'trail'})},spawnRing(x,y,cfg){const{color='#fff',count=10}=cfg||{};for(let i=0;i<count;i++){const a=i/count*Math.PI*2;this.list.push({x,y,vx:Math.cos(a)*2.5,vy:Math.sin(a)*2.5,life:400,mlife:400,color,size:2.5,type:'ring'})}},update(dt){for(let i=this.list.length-1;i>=0;i--){const p=this.list[i];p.x+=p.vx*(dt/16);p.y+=p.vy*(dt/16);p.life-=dt;if(p.type==='ring'){p.vx*=.97;p.vy*=.97}if(p.life<=0)this.list.splice(i,1)}},draw(ctx){for(const p of this.list){const a=Math.max(0,p.life/p.mlife);ctx.globalAlpha=a;ctx.fillStyle=p.color;ctx.fillRect(p.x-p.size/2,p.y-p.size/2,p.size,p.size)}ctx.globalAlpha=1},clear(){this.list=[]}};

// Tween engine
const Tween={_list:[],to(target,props,dur,cb){const t={target,start:{},to:{...props},dur,elapsed:0,cb};for(const k in props)t.start[k]=target[k]??0;this._list.push(t)},update(dt){for(let i=this._list.length-1;i>=0;i--){const t=this._list[i];t.elapsed+=dt;const p=Math.min(1,t.elapsed/t.dur),ep=1-Math.pow(1-p,3);for(const k in t.to)t.target[k]=t.start[k]+(t.to[k]-t.start[k])*ep;if(p>=1){for(const k in t.to)t.target[k]=t.to[k];t.cb&&t.cb();this._list.splice(i,1)}}},clear(){this._list=[]}};

// Renderer
const R={chars:null,animData:null,async load(){try{this.chars=(await(await fetch('/data/characters.json')).json()).characters;this.animData=(await(await fetch('/data/skills.json')).json()).animations}catch(e){}},
getChar(id){return this.chars?.find(c=>c.id===id)||this.chars?.[0]},
drawShape(ctx,shape,x,y,s,c){ctx.fillStyle=c;switch(shape){case'square':ctx.fillRect(x-s/2,y-s/2,s,s);break;case'triangle':ctx.beginPath();ctx.moveTo(x,y-s/2);ctx.lineTo(x+s/2,y+s/2);ctx.lineTo(x-s/2,y+s/2);ctx.closePath();ctx.fill();break;case'triangle2':ctx.beginPath();ctx.moveTo(x,y+s/2);ctx.lineTo(x+s/2,y-s/2);ctx.lineTo(x-s/2,y-s/2);ctx.closePath();ctx.fill();break;case'diamond':ctx.beginPath();ctx.moveTo(x,y-s/2);ctx.lineTo(x+s/2,y);ctx.lineTo(x,y+s/2);ctx.lineTo(x-s/2,y);ctx.closePath();ctx.fill();break}},

render(cv,state,mode){const ctx=cv.getContext('2d'),W=cv.width=cv.parentElement.clientWidth,H=cv.height=cv.parentElement.clientHeight;ctx.clearRect(0,0,W,H);ctx.fillStyle='#000';ctx.fillRect(0,0,W,H);const cw=W/16,gy=H*.7,cy=gy-cw*.35;
// ground line
ctx.strokeStyle='#0066cc';ctx.shadowColor='#0066ff';ctx.shadowBlur=8;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(0,gy);ctx.lineTo(W,gy);ctx.stroke();ctx.shadowBlur=0;
// grid
ctx.strokeStyle='rgba(0,100,200,0.06)';ctx.lineWidth=.5;for(let i=0;i<=16;i++){ctx.beginPath();ctx.moveTo(i*cw,0);ctx.lineTo(i*cw,H);ctx.stroke()}
if(!state)return;
const showP2=(mode==='battle');
[state.p1,state.p2].forEach((p,idx)=>{
if(idx===1&&!showP2)return;
const cd=this.getChar(p.charId);if(!cd)return;
const cx=(p.x+.5)*cw;
// glow
ctx.shadowColor=cd.color;ctx.shadowBlur=12;
this.drawShape(ctx,cd.shape,cx,cy,cd.size*1.2,cd.color+'33');
ctx.shadowBlur=6;
this.drawShape(ctx,cd.shape,cx,cy,cd.size*.85,cd.color);ctx.shadowBlur=0;
// effects overlay
if(p._dotStacks>0){ctx.shadowColor='#44ff44';ctx.shadowBlur=8;ctx.fillStyle='#44ff4488';ctx.fillRect(cx-cd.size/2-2,cy-cd.size/2-2,cd.size+4,cd.size+4);ctx.shadowBlur=0}
if(p._stunned){ctx.shadowColor='#ffff00';ctx.shadowBlur=10;ctx.strokeStyle='#ffff00';ctx.lineWidth=2;ctx.strokeRect(cx-cd.size/2-3,cy-cd.size/2-3,cd.size+6,cd.size+6);ctx.shadowBlur=0}
// facing arrow
if(!showP2||idx===0||mode==='battle'){ctx.fillStyle='#fff';const ax=cx+p.facing*cd.size*.7;ctx.beginPath();ctx.moveTo(ax,cy-3);ctx.lineTo(ax+p.facing*5,cy);ctx.lineTo(ax,cy+3);ctx.fill()}
// dodge trail
if(p._isDodging){ctx.globalAlpha=.35;for(let j=1;j<=4;j++){ctx.fillStyle=cd.color;ctx.fillRect(cx-p.facing*j*6-2,cy-2,4,4)}ctx.globalAlpha=1}
// move trail (dash)
if(p._isDashing){ctx.globalAlpha=.4;for(let j=1;j<=5;j++){ctx.fillStyle=cd.color+'88';ctx.fillRect(cx-p.facing*j*5-3,cy-3,6,6)}ctx.globalAlpha=1}
});
// shield bullets
if(state.bullets)state.bullets.forEach(b=>{const bx=(b.x+.5)*cw;if(b.isShield){ctx.strokeStyle=b.color||'#4488ff';ctx.shadowColor=b.color;ctx.shadowBlur=8;ctx.lineWidth=2;ctx.strokeRect(bx-cw*.25,cy-cw*.25,cw*.5,cw*.5);ctx.shadowBlur=0}});
// particle FX
FX.draw(ctx);
// grid numbers
ctx.fillStyle='rgba(0,150,255,0.25)';ctx.font='7px monospace';for(let i=0;i<16;i++)ctx.fillText(i,i*cw+2,H-2);
}};

// ============ GAME STATE ============
const G={socket:null,roomId:null,n:0,mode:null,selChar:null,selSkills:[],actions:[],maxAct:16,round:1,ready:false,state:null,_mode:'idle',_animId:null,_previewStack:[],_origStateP1:null,_localTimer:null,_gameType:null};
function el(id){return $(id)}

async function init(){AE.init();await R.load();await loadCharData();}

async function loadCharData(){try{const r=await fetch('/data/characters.json');G.charData=await r.json()}catch(e){}}

function nav(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));$(id).classList.add('active')}

function enterCharSelect(type){G._gameType=type;nav('charSel');initCharSel(type)}

// ============ SOCKET ============
function connect(){if(G.socket)return;G.socket=io();
G.socket.on('roomCreated',d=>{G.roomId=d.roomId;G.n=d.n;$('ostatus').textContent='房间: '+d.roomId});
G.socket.on('roomJoined',d=>{G.roomId=d.roomId;G.n=d.n;$('ostatus').textContent='已加入: '+d.roomId});
G.socket.on('playerJoined',d=>{$('ostatus').textContent='对手已加入!';setTimeout(()=>{enterCharSelect('online')},800)});
G.socket.on('prepareStart',d=>enterPreparePhase(d));
G.socket.on('prepareTick',d=>{$('tm').textContent=d.t;if(d.t<=5)AE.sfx('tick')});
G.socket.on('battleFrames',d=>enterBattlePhase(d));
G.socket.on('gameOver',d=>showResult(d));
G.socket.on('playerLeft',()=>{stopAll();alert('对手离开');nav('menu')});
G.socket.on('err',d=>alert(d.msg));
G.socket.on('aiStart',d=>{G.roomId=d.roomId;G.n=d.n;G.mode='ai'});
G.socket.on('trainStart',d=>{G.roomId=d.roomId;G.n=d.n;G.mode='train'});
}

// ============ PHASE MACHINE ============
function enterPreparePhase(d){
stopAll();
G._mode='prepare';G.round=d.round;G.ready=false;G.actions=[];G._previewStack=[];
// Reset local cooldown tracking
[0,1,2].forEach(i=>{const sid=G.selSkills[i];if(sid)G['_cd_'+sid]=0});
G.state={p1:clonePlayer(d.p1),p2:clonePlayer(d.p2),bullets:d.bullets||[]};
G._origStateP1={x:d.p1.x,facing:d.p1.facing,mp:d.p1.mp,sp:d.p1.sp};
$('rnd').textContent='ROUND '+d.round;$('tm').textContent=d.time||60;
$('tmrArea').style.display='';$('actionQueuePanel').classList.remove('hidden');
$('rdyBtn').disabled=false;$('rdyBtn').textContent='✅ 完成';
$('logc').innerHTML='';
updateHUD(d.p1,d.p2);renderActionSlots();renderActionButtons();drawField();
nav('battle');startAnimLoop();
}

function enterBattlePhase(d){
stopAll();
G._mode='battle';
$('tmrArea').style.display='none';
$('actionQueuePanel').classList.add('hidden');
$('logc').innerHTML='';
// Start from previous state for smooth transition
playBattleAnim(d.frames,d.final);
nav('battle');
}

function clonePlayer(p){return{...p,_dotStacks:p._dotStacks||0,_stunned:p._stunned||false,_isDodging:false,_isDashing:false}}

// ============ HUD ============
function updateHUD(p1,p2){[['p1',p1],['p2',p2]].forEach(([pre,p])=>{const mh=p.maxHp||1,mm=p.maxMp||1,ms=p.maxSp||1;$(pre+'hp').style.width=Math.max(0,(p.hp||0)/mh*100)+'%';$(pre+'hpt').textContent=(p.hp||0)+'/'+mh;$(pre+'mp').style.width=Math.max(0,(p.mp||0)/mm*100)+'%';$(pre+'mpt').textContent=(p.mp||0)+'/'+mm;$(pre+'sp').style.width=Math.max(0,(p.sp||0)/ms*100)+'%';$(pre+'spt').textContent=(p.sp||0)+'/'+ms})}

// ============ ACTION QUEUE ============
function tickCooldowns(){G.selSkills.forEach(sid=>{if(!sid)return;const k='_cd_'+sid;if((G[k]||0)>0)G[k]--})}
function renderActionButtons(){tickCooldowns();const btns=[['◀左','move_left'],['▶右','move_right'],['◀◀闪','dodge_left'],['▶▶闪','dodge_right'],['🛡防','defend'],['🔄转','turn']];G.selSkills.forEach((sid,i)=>{const sk=G._skillDataCache?.[sid];const cdRem=G['_cd_'+sid]||0;const cdStr=cdRem>0?' CD'+cdRem:'';const mpCost=sk?.mpCost||0;const spCost=sk?.spCost||0;const label='技'+(i+1)+cdStr+' MP'+mpCost+' SP'+spCost;btns.push([label,'skill'+(i+1)])});const ab=$('abtns');ab.innerHTML='';btns.forEach(([l,v])=>{const b=document.createElement('button');b.className='ab';b.onclick=()=>addAction(v);b.textContent=l;ab.appendChild(b)})}
function addAction(a){if(G.actions.length>=G.maxAct)return;
const p1=G.state?.p1;if(!p1)return;
if(a==='skill1'||a==='skill2'||a==='skill3'){const idx={skill1:0,skill2:1,skill3:2}[a];const sid=G.selSkills[idx];if(!sid)return;const cdKey='_cd_'+sid;if((G[cdKey]||0)>0)return;const sk=G._skillDataCache?.[sid];if(sk){if((p1.mp||0)<(sk.mpCost||0)||(p1.sp||0)<(sk.spCost||0))return;G[cdKey]=sk.cooldown||0;// Set cooldown
// Deduct SP/MP from preview state
p1.mp-=sk.mpCost||0;p1.sp-=sk.spCost||0}}
G.actions.push(a);renderActionSlots();renderActionButtons();updateHUD(G.state.p1,G.state.p2);if(G.socket)G.socket.emit('updateActions',{actions:G.actions});previewAction(a);AE.sfx('tick')}
function previewAction(a){if(!G.state)return;const p1=G.state.p1;G._previewStack.push({x:p1.x,facing:p1.facing,mp:p1.mp,sp:p1.sp,act:a});if(a==='move_left')p1.x=Math.max(0,p1.x-1);if(a==='move_right')p1.x=Math.min(15,p1.x+1);if(a==='dodge_left'){p1.x=Math.max(0,p1.x-2);p1._isDodging=!0;setTimeout(()=>{if(p1)p1._isDodging=!1},400)}if(a==='dodge_right'){p1.x=Math.min(15,p1.x+2);p1._isDodging=!0;setTimeout(()=>{if(p1)p1._isDodging=!1},400)}if(a==='turn')p1.facing*=-1;drawField()}
function undoAction(){const removed=G.actions.pop();if(removed==='skill1'||removed==='skill2'||removed==='skill3'){const idx={skill1:0,skill2:1,skill3:2}[removed];const sid=G.selSkills[idx];if(sid){const cdKey='_cd_'+sid;if((G[cdKey]||0)>0)G[cdKey]--;const sk=G._skillDataCache?.[sid];if(sk&&G.state?.p1){G.state.p1.mp+=sk.mpCost||0;G.state.p1.sp+=sk.spCost||0}}}renderActionSlots();renderActionButtons();updateHUD(G.state?.p1,G.state?.p2);if(G.socket)G.socket.emit('updateActions',{actions:G.actions});if(G._previewStack.length){const prev=G._previewStack.pop();if(G.state?.p1){G.state.p1.x=prev.x;G.state.p1.facing=prev.facing}}drawField()}
function clearActions(){G.actions.forEach(a=>{if(a==='skill1'||a==='skill2'||a==='skill3'){const idx={skill1:0,skill2:1,skill3:2}[a];const sid=G.selSkills[idx];if(sid)G['_cd_'+sid]=0}});G.actions=[];G._previewStack=[];renderActionSlots();renderActionButtons();if(G.socket)G.socket.emit('updateActions',{actions:[]});if(G.state?.p1&&G._origStateP1){G.state.p1.x=G._origStateP1.x;G.state.p1.facing=G._origStateP1.facing;G.state.p1.mp=G._origStateP1.mp||G.state.p1.mp;G.state.p1.sp=G._origStateP1.sp||G.state.p1.sp}updateHUD(G.state?.p1,G.state?.p2);drawField()}
function randomFill(){const pool=['move_left','move_right','move_right','defend','skill1','skill2','skill3','dodge_left','dodge_right','turn'];G.actions=[];clearActions();for(let i=0;i<16;i++){const a=pool[Math.floor(Math.random()*pool.length)];if(a==='skill1'||a==='skill2'||a==='skill3'){const idx={skill1:0,skill2:1,skill3:2}[a];const sid=G.selSkills[idx];if(!sid)continue;if((G['_cd_'+sid]||0)>0)continue;const sk=G._skillDataCache?.[sid];if(sk&&G.state?.p1&&(G.state.p1.mp<(sk.mpCost||0)||G.state.p1.sp<(sk.spCost||0)))continue;G['_cd_'+sid]=sk?.cooldown||0;if(sk&&G.state?.p1){G.state.p1.mp-=sk.mpCost||0;G.state.p1.sp-=sk.spCost||0}}G.actions.push(a);if(G.actions.length>=16)break}renderActionSlots();renderActionButtons();updateHUD(G.state?.p1,G.state?.p2);if(G.socket)G.socket.emit('updateActions',{actions:G.actions});AE.sfx('tick')}
function renderActionSlots(){const slots=$('aslots');$('acnt').textContent='('+G.actions.length+'/16)';slots.innerHTML='';const lb={move_left:'◀',move_right:'▶',dodge_left:'◀◀',dodge_right:'▶▶',defend:'🛡',turn:'🔄',skill1:'技1',skill2:'技2',skill3:'技3'};G.actions.forEach((a,i)=>{const d=document.createElement('div');d.className='as';d.innerHTML='<span class="sn">'+(i+1)+'</span>'+(lb[a]||a);d.onclick=()=>{G.actions.splice(i,1);renderActionSlots();if(G.socket)G.socket.emit('updateActions',{actions:G.actions})};slots.appendChild(d)});for(let i=G.actions.length;i<16;i++){const d=document.createElement('div');d.className='as';d.style.opacity='0.3';d.innerHTML='<span class="sn">'+(i+1)+'</span>⋯';slots.appendChild(d)}}
function readyBattle(){G.ready=true;$('rdyBtn').disabled=true;$('rdyBtn').textContent='⏳ 已准备';G.socket.emit('ready');if(G.mode==='ai')G.socket.emit('aiReady',{roomId:G.roomId});if(G.mode==='train')G.socket.emit('trainReady',{roomId:G.roomId});AE.sfx('skill')}
function quitBattle(){stopAll();if(G.socket){G.socket.emit('leaveRoom');}nav('menu')}

// ============ BATTLE ANIMATION ============
function playBattleAnim(frames,final){
FX.clear();Tween.clear();
const TD=600;
function next(idx){
if(idx>=frames.length){
G.state={p1:clonePlayer(final.p1),p2:clonePlayer(final.p2),bullets:final.bullets||[]};
updateHUD(final.p1,final.p2);drawField();
return;}
const f=frames[idx];
const startP1X=f.p1FromX!==undefined?f.p1FromX:f.p1.x;
const startP2X=f.p2FromX!==undefined?f.p2FromX:f.p2.x;
const ist={p1:{...f.p1,x:startP1X,hp:f.p1.hp,mp:f.p1.mp,sp:f.p1.sp,_isDodging:f.p1Act==='dodge_left'||f.p1Act==='dodge_right',_isDashing:f.p1Act==='dash',_dotStacks:(f.p1.effects||[]).filter(e=>e.type==='dot'||e.type==='burn'||e.type==='poison').length,_stunned:f.p1Stunned},p2:{...f.p2,x:startP2X,hp:f.p2.hp,mp:f.p2.mp,sp:f.p2.sp,_isDodging:f.p2Act==='dodge_left'||f.p2Act==='dodge_right',_isDashing:f.p2Act==='dash',_dotStacks:(f.p2.effects||[]).filter(e=>e.type==='dot'||e.type==='burn'||e.type==='poison').length,_stunned:f.p2Stunned},bullets:f.bullets||[]};
G.state=ist;
Tween.to(ist.p1,{x:f.p1.x},TD*.5);
Tween.to(ist.p2,{x:f.p2.x},TD*.5);
// Spawn particles for ALL event types - generous and visible
const cw=$('fc').width/16,gy=$('fc').height*.7;
(f.events||[]).forEach(ev=>{
switch(ev.type){
case'collision':FX.spawnRing((ev.pos+.5)*cw,gy-12,{color:'#ffff00',count:16});FX.spawn((ev.pos+.5)*cw,gy-12,{color:'#ffff00',count:12,spread:6});AE.sfx('block');break;
case'melee_hit':FX.spawnRing((f.p2.x+.5)*cw,gy-8,{color:'#ff4444',count:12});FX.spawn((f.p2.x+.5)*cw,gy-8,{color:'#ff4444',count:14,spread:6});AE.sfx('hit');break;
case'stun_hit':FX.spawnRing((f.p2.x+.5)*cw,gy-8,{color:'#ffff00',count:14});FX.spawn((f.p2.x+.5)*cw,gy-8,{color:'#ffff00',count:10,spread:5});AE.sfx('hit');break;
case'backstab_hit':FX.spawnRing((f.p2.x+.5)*cw,gy-8,{color:'#ff0000',count:18});FX.spawn((f.p2.x+.5)*cw,gy-8,{color:'#ff0000',count:16,spread:7});AE.sfx('skill');break;
case'bullet_hit':{const bx=ev.x!==undefined?(ev.x+.5)*cw:(f.p2.x+.5)*cw;FX.spawnRing(bx,gy-18,{color:ev.color||'#ff8800',count:14});FX.spawn(bx,gy-18,{color:ev.color||'#ff8800',count:12,spread:6});AE.sfx('bullet');break;}
case'freeze_hit':{const bx=ev.x!==undefined?(ev.x+.5)*cw:(f.p2.x+.5)*cw;FX.spawnRing(bx,gy-18,{color:'#88ccff',count:14});FX.spawn(bx,gy-18,{color:'#88ccff',count:10,spread:4});AE.sfx('block');break;}
case'burn_hit':{const px=ev.pos!==undefined?(ev.pos+.5)*cw:(f.p2.x+.5)*cw;FX.spawnRing(px,gy-12,{color:'#ff6600',count:16});FX.spawn(px,gy-12,{color:'#ff6600',count:12,spread:5});AE.sfx('hit');break;}
case'poison_hit':{const px=ev.x!==undefined?(ev.x+.5)*cw:(f.p2.x+.5)*cw;FX.spawnRing(px,gy-18,{color:'#88ff00',count:10});FX.spawn(px,gy-18,{color:'#88ff00',count:8,spread:4});AE.sfx('bullet');break;}
case'bullet_clash':FX.spawnRing((ev.x+.5)*cw,gy-18,{color:'#ffffff',count:10});FX.spawn((ev.x+.5)*cw,gy-18,{color:'#ffffff',count:6,spread:3});break;
case'bullet_trail':FX.spawnTrail((ev.traj?.[0]+.5)*cw,gy-18,{color:ev.color||'#fff',len:5});break;
case'dash':case'dash_hit':ist.p1._isDashing=true;FX.spawnTrail(startP1X*cw,gy-8,{color:'#00ddff',len:6});AE.sfx('dodge');break;
case'dodged':FX.spawnTrail((f.p2.x+.5)*cw,gy-8,{color:'#8888ff',len:5});AE.sfx('dodge');break;
case'aoe_hit':case'aoe_cast':{const px=ev.pos!==undefined?(ev.pos+.5)*cw:(f.p2.x+.5)*cw;FX.spawnRing(px,gy-12,{color:ev.color||'#ff4444',count:20});FX.spawn(px,gy-12,{color:ev.color||'#ff4444',count:16,spread:8});break;}
case'knockback':FX.spawnRing((ev.to!==undefined?(ev.to+.5)*cw:(f.p2.x+.5)*cw),gy-12,{color:'#ffaa00',count:12});FX.spawn((f.p2.x+.5)*cw,gy-12,{color:'#ffaa00',count:8,spread:5});AE.sfx('block');break;
case'teleport':FX.spawnRing((ev.to+.5)*cw,gy-8,{color:'#ff00ff',count:14});FX.spawn((ev.to+.5)*cw,gy-8,{color:'#ff00ff',count:10,spread:5});AE.sfx('dodge');break;
case'shield_wall':FX.spawnRing((ev.x+.5)*cw,gy-12,{color:'#4488ff',count:8});break;
}
});
// Log
const logs=(f.events||[]).map(ev=>{const m={collision:'💥碰撞!',melee_hit:'⚔'+ev.actor+' 命中 -'+ev.dmg,melee_miss:ev.actor+' 落空',bullet_hit:'🎯弹幕 -'+ev.dmg,bullet_clash:'💫弹幕相消',dodged:'💨闪避!',dash:'🏃冲刺',dash_hit:'冲撞 -'+ev.dmg,aoe_hit:'💣AOE -'+ev.dmg,stun_hit:'⚡眩晕 -'+ev.dmg,freeze_hit:'❄冰冻 -'+ev.dmg,burn_hit:'🔥燃烧 -'+ev.dmg,poison_hit:'☠中毒 -'+ev.dmg,teleport:'✨传送',knockback:'💢击退'};return m[ev.type]?'<span class="l ld">'+m[ev.type]+'</span>':''}).filter(Boolean);
if(logs.length)$('logc').innerHTML=logs.slice(-3).join('');
const t0=performance.now();
function anim(ts){const dt=ts-t0;Tween.update(dt);FX.update(16);
if(dt<100&&Math.floor(dt/30)%2===0&&ist.p1._dotStacks>0)FX.spawn((ist.p1.x+.5)*$('fc').width/16,$('fc').height*.6,{color:'#44ff44',count:2,spread:2});
if(dt<100&&Math.floor(dt/30)%2===0&&ist.p2._dotStacks>0)FX.spawn((ist.p2.x+.5)*$('fc').width/16,$('fc').height*.6,{color:'#ff6600',count:2,spread:2});
drawField();
if(dt<TD)requestAnimationFrame(anim);
else{G.state={p1:clonePlayer(f.p1),p2:clonePlayer(f.p2),bullets:f.bullets||[]};updateHUD(f.p1,f.p2);drawField();setTimeout(()=>next(idx+1),20)}}
requestAnimationFrame(anim)}
next(0)}

// ============ ANIMATION LOOP ============
function startAnimLoop(){stopAnimLoop();function loop(ts){if(G._mode!=='prepare'){G._animId=null;return}FX.update(16);drawField();G._animId=requestAnimationFrame(loop)}G._animId=requestAnimationFrame(loop)}
function stopAnimLoop(){if(G._animId){cancelAnimationFrame(G._animId);G._animId=null}}
function stopAll(){stopAnimLoop();FX.clear();Tween.clear();if(G._localTimer){clearInterval(G._localTimer);G._localTimer=null}}

function drawField(){const cv=$('fc');if(!cv)return;R.render(cv,G.state,G._mode)}
window.addEventListener('resize',()=>{const cv=$('fc');if(cv){cv.width=cv.parentElement.clientWidth;cv.height=cv.parentElement.clientHeight;drawField()}});

// ============ CHAR SELECT ============
function initCharSel(type){G._gameType=type;G.selChar=null;G.selSkills=[];const cg=$('cg');cg.innerHTML='';const isTrain=type==='train';$('startBtn').textContent=isTrain?'🎯进入训练场':'⚔️开始对战';$('startBtn').onclick=isTrain?startTrainGame:startAIGame;$('skillSel').classList.add('hidden');(R.chars||[]).forEach(c=>{const d=document.createElement('div');d.className='cc';d.innerHTML='<canvas id="cav_'+c.id+'" width="48" height="48"></canvas><div class="cn">'+c.name+'</div><div class="cs">HP:'+c.maxHp+' ATK:'+c.atk+' DEF:'+c.def+'<br>'+c.desc+'</div>';d.onclick=()=>selectChar(c,d);cg.appendChild(d);setTimeout(()=>{const cv=$('cav_'+c.id);if(!cv)return;const ctx=cv.getContext('2d');R.drawShape(ctx,c.shape,24,24,c.size*1.5,c.color)},50)})}
function selectChar(c,div){G.selChar=c.id;G.selSkills=[...c.defaultSkills];document.querySelectorAll('.cc').forEach(x=>x.classList.remove('sel'));div.classList.add('sel');$('skillSel').classList.remove('hidden');renderSkillSel(c);AE.sfx('tick')}
function renderSkillSel(ch){const sg=$('sg');sg.innerHTML='';fetch('/data/skills.json').then(r=>r.json()).then(d=>{const all=d.skills||{};G._skillDataCache=all;ch.defaultSkills.forEach(sid=>{const s=all[sid];if(s)addSkillCard(sg,s,true)});Object.values(all).forEach(s=>{if(s.charId===ch.id&&!ch.defaultSkills.includes(s.id))addSkillCard(sg,s,false)})})}
function addSkillCard(sg,s,isDef){const d=document.createElement('div');d.className='sc'+(G.selSkills.includes(s.id)?' sel':'');d.innerHTML='<div class="sn">'+s.name+'</div><div class="st">'+s.type+(isDef?'(默认)':'')+'</div>';d.onclick=()=>{const i=G.selSkills.indexOf(s.id);if(i>=0){G.selSkills.splice(i,1);d.classList.remove('sel')}else{if(G.selSkills.length>=3)G.selSkills.shift();G.selSkills.push(s.id);d.classList.add('sel');sg.querySelectorAll('.sc').forEach(x=>x.classList.toggle('sel',G.selSkills.some(sid=>x.querySelector('.sn')?.textContent===s.name)))}AE.sfx('tick')};sg.appendChild(d)}

// ============ LOBBY & GAME START ============
function initLobby(){connect();$('ostatus').textContent=''}
function createRoom(){G.socket.emit('createRoom',{name:$('pname').value||'Player'});AE.sfx('tick')}
function joinRoom(){const c=$('rcode').value.toUpperCase();if(!c)return alert('输入房间号');G.socket.emit('joinRoom',{roomId:c,name:$('pname').value||'Player'});AE.sfx('tick')}
function startAIGame(){if(!G.selChar)return alert('请选角色');if(G.selSkills.length===0)G.selSkills=(R.chars.find(c=>c.id===G.selChar)?.defaultSkills||[]);const aiC=R.chars.filter(c=>c.id!==G.selChar),ac=aiC[Math.floor(Math.random()*aiC.length)];G.socket.emit('startAI',{name:'Player',charId:G.selChar,skillIds:G.selSkills,aiCharId:ac.id,aiSkillIds:[...ac.defaultSkills]})}
function startTrainGame(){if(!G.selChar)return alert('请选角色');if(G.selSkills.length===0)G.selSkills=(R.chars.find(c=>c.id===G.selChar)?.defaultSkills||[]);G.socket.emit('startTrain',{name:'Player',charId:G.selChar,skillIds:G.selSkills})}
function showResult(d){stopAll();G._mode='over';nav('result');const won=(d.winner==='P1'&&G.n===1)||(d.winner==='P2'&&G.n===2)||((G.mode==='ai'||G.mode==='train')&&d.winner==='P1');$('rtitle').textContent=won?'胜利!':(d.winner==='draw'?'平局':'失败...');$('rtitle').style.color=won?'var(--c3)':'var(--c2)';$('rdetail').innerHTML='P1 HP:'+d.p1Hp+' / P2 HP:'+d.p2Hp;AE.sfx(won?'win':'death')}

// ============ INIT ============
window.addEventListener('load',async()=>{await init();connect();setTimeout(()=>{document.addEventListener('click',()=>{if(AE.ctx?.state==='suspended')AE.ctx.resume()},{once:true})},500)});
document.addEventListener('keydown',e=>{if(!$('battle')?.classList.contains('active')||G._mode!=='prepare')return;const m={a:'move_left',d:'move_right',q:'dodge_left',e:'dodge_right',w:'defend',s:'turn','1':'skill1','2':'skill2','3':'skill3'};if(m[e.key]){addAction(m[e.key]);return}if(e.key==='Backspace')undoAction();if(e.key==='Escape')clearActions();if(e.key==='Enter')readyBattle();if(e.key==='r')randomFill()});
