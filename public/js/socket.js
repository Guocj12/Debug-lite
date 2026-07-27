// ============================================
// socket.js — Socket.IO 客户端连接管理
// ============================================

const SOCKET_URL = window.location.origin || 'http://localhost:3000';

const socket = io(SOCKET_URL, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10
});

// 全局事件转发器
const GameEvents = {
    listeners: {},

    on(event, callback) {
        if (!this.listeners[event]) this.listeners[event] = [];
        this.listeners[event].push(callback);
    },

    off(event, callback) {
        if (!this.listeners[event]) return;
        this.listeners[event] = this.listeners[event].filter(cb => cb !== callback);
    },

    emit(event, data) {
        if (!this.listeners[event]) return;
        this.listeners[event].forEach(cb => cb(data));
    }
};

// 连接状态
socket.on('connect', () => {
    console.log('[Socket] 已连接:', socket.id);
    document.getElementById('disconnect-overlay').classList.add('hidden');
});

socket.on('disconnect', () => {
    console.log('[Socket] 断开连接');
    document.getElementById('disconnect-overlay').classList.remove('hidden');
    document.getElementById('disconnect-msg').textContent = '正在重连...';
});

socket.on('connect_error', (err) => {
    console.error('[Socket] 连接错误:', err);
    showToast('无法连接到服务器');
});

// 将所有服务端事件转发到 GameEvents
const serverEvents = [
    'room_created', 'room_joined', 'opponent_joined',
    'opponent_skills_selected', 'skills_confirmed',
    'game_start', 'phase_change', 'tick',
    'opponent_queue_update', 'queue_updated',
    'battle_action', 'round_end', 'game_over',
    'opponent_disconnected', 'opponent_reconnected',
    'error_msg', 'rematch_requested'
];

serverEvents.forEach(event => {
    socket.on(event, (data) => {
        console.log(`[Socket] ← ${event}:`, data);
        GameEvents.emit(event, data);
    });
});

// Toast 工具
function showToast(message, duration = 3000) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => {
        toast.classList.add('hidden');
    }, duration);
}

// 切换面板
function switchPanel(panelId) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    const panel = document.getElementById('panel-' + panelId);
    if (panel) panel.classList.add('active');
}
