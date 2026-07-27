const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const Player = require('./game/Player');
const RoomManager = require('./game/RoomManager');
const BattleEngine = require('./game/BattleEngine');
const Timer = require('./game/Timer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    transports: ['websocket', 'polling'],
    cors: { origin: '*' }
});

const roomManager = new RoomManager();
const battleEngine = new BattleEngine();

const PREPARE_TIME = 60; // 准备阶段秒数
const PORT = 3000;

// ==================== 静态文件服务 ====================
app.use(express.static(path.join(__dirname, '..', 'public')));

// ==================== Socket.IO 事件 ====================
io.on('connection', (socket) => {
    console.log(`[连接] ${socket.id}`);

    let currentPlayer = null;
    let currentRoomId = null;

    // ---------- 创建房间 ----------
    socket.on('create_room', (data) => {
        const { playerName } = data;
        if (!playerName || playerName.trim() === '') {
            socket.emit('error_msg', { message: '请输入昵称' });
            return;
        }

        const characterId = roomManager.getRandomCharacterId();
        const player = new Player(socket.id, playerName.trim(), characterId);
        const room = roomManager.createRoom(player);

        currentPlayer = player;
        currentRoomId = room.id;
        socket.join(room.id);

        socket.emit('room_created', {
            roomId: room.id,
            playerId: player.id,
            character: player.characterConfig,
            skills: battleEngine.getAllSkills(),
            maxSkillSlots: battleEngine.getMaxSkillSlots()
        });

        console.log(`[房间] ${player.name} 创建了房间 ${room.id}`);
    });

    // ---------- 加入房间 ----------
    socket.on('join_room', (data) => {
        const { roomId, playerName } = data;
        if (!playerName || playerName.trim() === '') {
            socket.emit('error_msg', { message: '请输入昵称' });
            return;
        }
        if (!roomId) {
            socket.emit('error_msg', { message: '请输入房间号' });
            return;
        }

        const normalizedRoomId = roomId.toUpperCase();
        const room = roomManager.getRoom(normalizedRoomId);

        if (!room) {
            socket.emit('error_msg', { message: '房间不存在' });
            return;
        }
        if (room.players.size >= 2) {
            socket.emit('error_msg', { message: '房间已满' });
            return;
        }

        const characterId = roomManager.getRandomCharacterId();
        const player = new Player(socket.id, playerName.trim(), characterId);
        roomManager.addPlayerToRoom(normalizedRoomId, player);

        currentPlayer = player;
        currentRoomId = normalizedRoomId;
        socket.join(normalizedRoomId);

        // 通知加入者
        socket.emit('room_joined', {
            roomId: normalizedRoomId,
            playerId: player.id,
            character: player.characterConfig,
            skills: battleEngine.getAllSkills(),
            maxSkillSlots: battleEngine.getMaxSkillSlots()
        });

        // 通知房主：对手加入
        const opponent = roomManager.getOpponent(normalizedRoomId, player.id);
        if (opponent) {
            io.to(opponent.id).emit('opponent_joined', {
                opponentName: player.name,
                opponentCharacter: player.characterConfig
            });
        }

        // 双方就位，进入技能选择阶段
        startSkillSelect(normalizedRoomId);

        console.log(`[房间] ${player.name} 加入了房间 ${normalizedRoomId}`);
    });

    // ---------- 选择技能 ----------
    socket.on('select_skills', (data) => {
        const { skillIds } = data;
        const room = roomManager.getRoom(currentRoomId);
        if (!room || !currentPlayer) return;

        const maxSlots = battleEngine.getMaxSkillSlots();
        if (!skillIds || skillIds.length > maxSlots) {
            socket.emit('error_msg', { message: `最多选择 ${maxSlots} 个技能` });
            return;
        }

        currentPlayer.selectedSkills = skillIds;
        currentPlayer.skillsConfirmed = true;

        socket.emit('skills_confirmed', { skills: skillIds });

        // 通知对手：已选择技能（不暴露具体技能）
        const opponent = roomManager.getOpponent(currentRoomId, currentPlayer.id);
        if (opponent) {
            io.to(opponent.id).emit('opponent_skills_selected', {
                skillCount: skillIds.length
            });
        }

        // 双方都选好 → 开始准备阶段
        if (opponent && opponent.skillsConfirmed) {
            startPreparePhase(currentRoomId);
        }
    });

    // ---------- 更新行动队列 ----------
    socket.on('update_queue', (data) => {
        const { queue } = data;
        const room = roomManager.getRoom(currentRoomId);
        if (!room || !currentPlayer) return;
        if (room.phase !== 'prepare') return;
        if (currentPlayer.queueConfirmed) return;

        currentPlayer.actionQueue = queue || [];

        // 通知对手队列长度变化
        const opponent = roomManager.getOpponent(currentRoomId, currentPlayer.id);
        if (opponent) {
            io.to(opponent.id).emit('opponent_queue_update', {
                length: currentPlayer.actionQueue.length,
                confirmed: currentPlayer.queueConfirmed
            });
        }

        socket.emit('queue_updated', {
            queue: currentPlayer.actionQueue,
            confirmed: currentPlayer.queueConfirmed
        });
    });

    // ---------- 锁定队列 ----------
    socket.on('confirm_queue', (data) => {
        const room = roomManager.getRoom(currentRoomId);
        if (!room || !currentPlayer) return;
        if (room.phase !== 'prepare') return;

        currentPlayer.queueConfirmed = true;

        socket.emit('queue_updated', {
            queue: currentPlayer.actionQueue,
            confirmed: true
        });

        const opponent = roomManager.getOpponent(currentRoomId, currentPlayer.id);
        if (opponent) {
            io.to(opponent.id).emit('opponent_queue_update', {
                length: currentPlayer.actionQueue.length,
                confirmed: true
            });
        }

        // 检查是否双方都确认了
        checkBothConfirmed(currentRoomId);
    });

    // ---------- 离开房间 ----------
    socket.on('leave_room', () => {
        handleLeave(socket);
    });

    // ---------- 请求重赛 ----------
    socket.on('request_rematch', () => {
        if (!currentRoomId || !currentPlayer) return;
        const room = roomManager.getRoom(currentRoomId);
        if (!room) return;

        currentPlayer.wantsRematch = true;

        const opponent = roomManager.getOpponent(currentRoomId, currentPlayer.id);
        if (opponent && opponent.wantsRematch) {
            // 双方都想重赛
            startRematch(currentRoomId);
        } else if (opponent) {
            io.to(opponent.id).emit('rematch_requested', {
                from: currentPlayer.name
            });
        }
    });

    // ---------- 断开连接 ----------
    socket.on('disconnect', () => {
        console.log(`[断开] ${socket.id}`);
        if (!currentRoomId || !currentPlayer) return;

        const room = roomManager.getRoom(currentRoomId);
        if (!room) return;

        // 通知对手
        const opponent = roomManager.getOpponent(currentRoomId, currentPlayer.id);
        if (opponent) {
            io.to(opponent.id).emit('opponent_disconnected', {
                message: '对手已断开连接，等待重连...',
                timeout: 30
            });
        }

        // 不立即移除，给重连留机会
        currentPlayer.disconnectedAt = Date.now();
    });

    // ==================== 内部函数 ====================

    function startSkillSelect(roomId) {
        const room = roomManager.getRoom(roomId);
        if (!room || room.players.size < 2) return;

        room.phase = 'skill_select';

        for (const [pid, player] of room.players) {
            player.skillsConfirmed = false;
            player.selectedSkills = [];
        }

        io.to(roomId).emit('phase_change', { phase: 'skill_select' });
    }

    function startPreparePhase(roomId) {
        const room = roomManager.getRoom(roomId);
        if (!room) return;

        room.phase = 'prepare';
        room.round++;

        const players = [...room.players.values()];
        const p1 = players[0];
        const p2 = players[1];

        // 初始化位置
        p1.position = { x: 2, y: 5 };
        p2.position = { x: 17, y: 5 };
        p1.resetForNewRound();
        p2.resetForNewRound();

        // 通知游戏开始
        io.to(roomId).emit('game_start', {
            you: p1.getPublicState(true),
            opponent: p2.getPublicState(true),
            round: room.round
        });
        // 对 p2 反过来
        io.to(p1.id).emit('game_start', {
            you: p1.getPublicState(true),
            opponent: p2.getPublicState(true),
            round: room.round
        });
        io.to(p2.id).emit('game_start', {
            you: p2.getPublicState(true),
            opponent: p1.getPublicState(true),
            round: room.round
        });

        // 通知阶段切换
        io.to(roomId).emit('phase_change', { phase: 'prepare', timeLeft: PREPARE_TIME });

        // 启动计时器
        if (room.timer) room.timer.stop();

        room.timer = new Timer(
            PREPARE_TIME,
            (remaining) => {
                io.to(roomId).emit('tick', { timeLeft: remaining });
            },
            () => {
                // 时间到 → 截断队列并开始战斗
                const p1Now = room.players.get(p1.id);
                const p2Now = room.players.get(p2.id);
                if (p1Now && p2Now) {
                    // 截断到较短的长度
                    const minLen = Math.min(p1Now.actionQueue.length, p2Now.actionQueue.length);
                    p1Now.actionQueue = p1Now.actionQueue.slice(0, minLen);
                    p2Now.actionQueue = p2Now.actionQueue.slice(0, minLen);
                    p1Now.queueConfirmed = true;
                    p2Now.queueConfirmed = true;
                }
                startBattlePhase(roomId);
            }
        );
        room.timer.start();
    }

    function checkBothConfirmed(roomId) {
        const room = roomManager.getRoom(roomId);
        if (!room) return;

        const players = [...room.players.values()];
        const allConfirmed = players.every(p => p.queueConfirmed);

        if (allConfirmed) {
            if (room.timer) room.timer.stop();

            // 截断队列到较短长度
            const minLen = Math.min(players[0].actionQueue.length, players[1].actionQueue.length);
            players[0].actionQueue = players[0].actionQueue.slice(0, minLen);
            players[1].actionQueue = players[1].actionQueue.slice(0, minLen);

            startBattlePhase(roomId);
        }
    }

    function startBattlePhase(roomId) {
        const room = roomManager.getRoom(roomId);
        if (!room) return;

        room.phase = 'battle';
        io.to(roomId).emit('phase_change', { phase: 'battle', round: room.round });

        const players = [...room.players.values()];
        const p1 = players[0];
        const p2 = players[1];

        // 执行战斗
        const battleLog = battleEngine.executeRound(p1, p2, roomId);

        // 逐步发送战斗日志给双方
        for (const stepLog of battleLog) {
            // 针对每个玩家调整视角
            const stepLogForP1 = formatBattleActionForPlayer(stepLog, p1.id);
            const stepLogForP2 = formatBattleActionForPlayer(stepLog, p2.id);

            io.to(p1.id).emit('battle_action', stepLogForP1);
            io.to(p2.id).emit('battle_action', stepLogForP2);
        }

        // 检查胜负
        const winner = battleEngine.checkWinner(p1, p2);

        if (winner) {
            room.phase = 'game_over';
            const winnerPlayer = winner === 'draw' ? null : [...room.players.values()].find(p => p.id === winner);
            const loserPlayer = winner === 'draw' ? null : [...room.players.values()].find(p => p.id !== winner);

            io.to(roomId).emit('phase_change', { phase: 'game_over', winner: winner });

            io.to(roomId).emit('game_over', {
                winner: winnerPlayer ? { id: winnerPlayer.id, name: winnerPlayer.name } : null,
                loser: loserPlayer ? { id: loserPlayer.id, name: loserPlayer.name } : null,
                isDraw: winner === 'draw',
                totalRounds: room.round,
                stats: {
                    [p1.id]: { ...p1.stats },
                    [p2.id]: { ...p2.stats }
                }
            });

            if (room.timer) room.timer.stop();
        } else {
            // 回合结束
            io.to(roomId).emit('round_end', {
                round: room.round,
                players: [
                    {
                        playerId: p1.id,
                        hp: p1.hp,
                        maxHp: p1.maxHp,
                        buffs: p1.buffs.map(b => ({ ...b })),
                        skillCooldowns: { ...p1.skillCooldowns }
                    },
                    {
                        playerId: p2.id,
                        hp: p2.hp,
                        maxHp: p2.maxHp,
                        buffs: p2.buffs.map(b => ({ ...b })),
                        skillCooldowns: { ...p2.skillCooldowns }
                    }
                ]
            });

            // 进入下一回合准备阶段
            setTimeout(() => {
                startPreparePhase(roomId);
            }, 2000);
        }
    }

    function formatBattleActionForPlayer(stepLog, playerId) {
        return {
            stepIndex: stepLog.stepIndex,
            actions: stepLog.actions,
            results: stepLog.results
        };
    }

    function startRematch(roomId) {
        const room = roomManager.getRoom(roomId);
        if (!room) return;

        room.round = 0;

        for (const [pid, player] of room.players) {
            player.hp = player.maxHp;
            player.isAlive = true;
            player.buffs = [];
            player.skillCooldowns = {};
            player.stats = { damageDealt: 0, damageTaken: 0, healingDone: 0, skillsUsed: 0 };
            player.wantsRematch = false;
            player.skillsConfirmed = false;
            player.selectedSkills = [];
        }

        startSkillSelect(roomId);
    }

    function handleLeave(socket) {
        if (!currentRoomId || !currentPlayer) return;

        const room = roomManager.getRoom(currentRoomId);
        if (!room) return;

        const opponent = roomManager.getOpponent(currentRoomId, currentPlayer.id);

        roomManager.removePlayer(currentPlayer.id);

        if (opponent && room.players.size > 0) {
            io.to(opponent.id).emit('opponent_disconnected', {
                message: '对手已离开房间',
                timeout: 0
            });
        }

        socket.leave(currentRoomId);
        currentPlayer = null;
        currentRoomId = null;
    }
});

// ==================== API：获取配置数据 ====================
app.get('/api/skills', (req, res) => {
    const skills = require('./data/skills.json');
    res.json(skills);
});

app.get('/api/characters', (req, res) => {
    const chars = require('./data/characters.json');
    res.json(chars);
});

app.get('/api/pixel-sprites', (req, res) => {
    const sprites = require('./data/pixelSprites.json');
    res.json(sprites);
});

// ==================== 启动服务器 ====================
server.listen(PORT, () => {
    console.log(`🎮 霓虹像素对战游戏服务器已启动`);
    console.log(`📡 http://localhost:${PORT}`);
    console.log(`🔌 WebSocket (Socket.IO) 端口: ${PORT}`);
});
