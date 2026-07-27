// ============================================
// app.js — 主入口：初始化连接，管理面板切换
// ============================================

(async function () {
    // ====== 加载配置数据 ======
    let skillsData = null;
    let charactersData = null;
    let spritesData = null;

    async function loadConfig() {
        try {
            const [skillsRes, charsRes, spritesRes] = await Promise.all([
                fetch('/api/skills'),
                fetch('/api/characters'),
                fetch('/api/pixel-sprites')
            ]);
            skillsData = await skillsRes.json();
            charactersData = await charsRes.json();
            spritesData = await spritesRes.json();
            console.log('[Config] 配置数据加载完成');
        } catch (err) {
            console.warn('[Config] API 加载失败，使用本地备用数据', err);
            // 尝试从本地 data 目录加载
            try {
                const [skillsRes, charsRes, spritesRes] = await Promise.all([
                    fetch('data/skills.json'),
                    fetch('data/characters.json'),
                    fetch('data/pixelSprites.json')
                ]);
                skillsData = await skillsRes.json();
                charactersData = await charsRes.json();
                spritesData = await spritesRes.json();
            } catch (e2) {
                console.error('[Config] 本地数据也无法加载', e2);
            }
        }
    }

    await loadConfig();

    // ====== 初始化 UI 组件 ======
    const lobbyUI = new LobbyUI();
    const skillSelectUI = new SkillSelectUI();
    const prepareUI = new PrepareUI();
    const battleUI = new BattleUI();

    // ====== 游戏状态 ======
    let myPlayerId = null;
    let myCharacter = null;
    let opponentCharacter = null;
    let currentRoomId = null;

    // ====== 事件监听 ======

    // 房间创建成功
    GameEvents.on('room_created', (data) => {
        currentRoomId = data.roomId;
        myPlayerId = data.playerId;
        myCharacter = data.character;

        lobbyUI.setStatus(`✅ 房间号: ${data.roomId}（等待对手加入...）`);
    });

    // 加入房间成功
    GameEvents.on('room_joined', (data) => {
        currentRoomId = data.roomId;
        myPlayerId = data.playerId;
        myCharacter = data.character;
    });

    // 对手加入
    GameEvents.on('opponent_joined', (data) => {
        opponentCharacter = data.opponentCharacter;
        lobbyUI.setStatus('对手已加入！即将开始选择技能...');
    });

    // 阶段切换
    GameEvents.on('phase_change', (data) => {
        console.log('[Phase]', data.phase);
        switch (data.phase) {
            case 'skill_select':
                skillSelectUI.init(skillsData.skills, skillsData.maxSkillSlots);
                skillSelectUI.show();
                break;
            case 'prepare':
                // 初始化准备阶段（技能数据由 game_start 带过来）
                break;
            case 'battle':
                battleUI.show();
                battleUI.setRound(data.round);
                break;
            case 'game_over':
                break;
        }
    });

    // 技能确认
    GameEvents.on('skills_confirmed', (data) => {
        showToast('技能已确认，等待对手...', 2000);
    });

    // 对手选择了技能
    GameEvents.on('opponent_skills_selected', (data) => {
        showToast('对手已选择技能', 1500);
    });

    // 游戏开始
    GameEvents.on('game_start', (data) => {
        const you = data.you;
        const opponent = data.opponent;

        myPlayerId = you.id;
        myCharacter = charactersData.characters.find(c => c.id === you.characterId) || myCharacter;
        opponentCharacter = charactersData.characters.find(c => c.id === opponent.characterId) || opponentCharacter;

        // 为技能注入冷却信息
        const mySkillsWithCD = (you.skills || []).map(skillId => {
            const skill = skillsData.skills.find(s => s.id === skillId);
            const cd = you.skillCooldowns?.[skillId] || 0;
            return { ...skill, _cooldown: cd };
        });

        // 准备阶段
        prepareUI.init(mySkillsWithCD);
        prepareUI.show();
        prepareUI.setTimer(data.timeLeft || 60);
        prepareUI.setOpponentStatus(opponent.queueLength || 0, opponent.queueConfirmed || false);

        // 战斗 UI 初始化
        battleUI.init(you, opponent, myCharacter, opponentCharacter, skillsData.skills, spritesData);
        battleUI.setRound(data.round || 1);
    });

    // 计时
    GameEvents.on('tick', (data) => {
        prepareUI.setTimer(data.timeLeft);
    });

    // 对手队列更新
    GameEvents.on('opponent_queue_update', (data) => {
        prepareUI.setOpponentStatus(data.length, data.confirmed);
    });

    // 队列已更新（确认）
    GameEvents.on('queue_updated', (data) => {
        console.log('[Queue] 已更新', data);
    });

    // 战斗步骤
    GameEvents.on('battle_action', (data) => {
        battleUI.playBattleActions([data]);
    });

    // 回合结束
    GameEvents.on('round_end', (data) => {
        // 更新 HP 等信息
        data.players.forEach(p => {
            if (p.playerId === myPlayerId) {
                battleUI.currentHp[myPlayerId] = p.hp;
                battleUI.myPlayer.hp = p.hp;
                battleUI.myPlayer.buffs = p.buffs;
                battleUI.myPlayer.skillCooldowns = p.skillCooldowns;
            } else {
                battleUI.currentHp[p.playerId] = p.hp;
                battleUI.opponentPlayer.hp = p.hp;
                battleUI.opponentPlayer.buffs = p.buffs;
                battleUI.opponentPlayer.skillCooldowns = p.skillCooldowns;
            }
        });
        battleUI.updateHpBars();
    });

    // 游戏结束
    GameEvents.on('game_over', (data) => {
        const panel = document.getElementById('panel-game-over');
        const title = document.getElementById('game-over-title');
        const result = document.getElementById('game-over-result');
        const statsGrid = document.getElementById('game-over-stats');

        if (data.isDraw) {
            title.textContent = '🤝 平局！';
            result.textContent = '双方实力相当！';
        } else if (data.winner && data.winner.id === myPlayerId) {
            title.textContent = '🏆 胜利！';
            result.textContent = `你击败了 ${data.loser?.name || '对手'}！`;
        } else {
            title.textContent = '💀 败北...';
            result.textContent = `你被 ${data.winner?.name || '对手'} 击败了...`;
        }

        // 统计
        const myStats = data.stats[myPlayerId];
        if (myStats) {
            statsGrid.innerHTML = `
                <div class="stat-card">
                    <div class="stat-name">造成伤害</div>
                    <div class="stat-value" style="color:#ff4444">${myStats.damageDealt}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-name">承受伤害</div>
                    <div class="stat-value" style="color:#ff8844">${myStats.damageTaken}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-name">治疗量</div>
                    <div class="stat-value" style="color:#ff88ff">${myStats.healingDone}</div>
                </div>
                <div class="stat-card">
                    <div class="stat-name">使用技能</div>
                    <div class="stat-value" style="color:#ffcc00">${myStats.skillsUsed}</div>
                </div>
            `;
        }

        switchPanel('game-over');
    });

    // 错误消息
    GameEvents.on('error_msg', (data) => {
        showToast(data.message);
        lobbyUI.createBtn.disabled = false;
        lobbyUI.joinBtn.disabled = false;
        lobbyUI.setStatus('');
    });

    // 对手断开
    GameEvents.on('opponent_disconnected', (data) => {
        showToast(data.message);
    });

    // 重赛请求
    GameEvents.on('rematch_requested', (data) => {
        showToast(`${data.from} 请求重赛！`);
    });

    // ====== 按钮事件（非 UI 类绑定的） ======
    document.getElementById('btn-rematch').addEventListener('click', () => {
        socket.emit('request_rematch', { roomId: currentRoomId });
    });

    document.getElementById('btn-back-to-lobby').addEventListener('click', () => {
        socket.emit('leave_room', { roomId: currentRoomId });
        currentRoomId = null;
        myPlayerId = null;
        lobbyUI.show();
    });

    // ====== 启动：显示大厅 ======
    lobbyUI.show();
    console.log('🎮 霓虹像素对战 — 客户端就绪');
})();
