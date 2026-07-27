// ============================================
// LobbyUI.js — 大厅界面
// ============================================

class LobbyUI {
    constructor() {
        this.nicknameInput = document.getElementById('input-nickname');
        this.roomIdInput = document.getElementById('input-room-id');
        this.createBtn = document.getElementById('btn-create-room');
        this.joinBtn = document.getElementById('btn-join-room');
        this.statusEl = document.getElementById('lobby-status');

        this.setupEvents();
    }

    setupEvents() {
        this.createBtn.addEventListener('click', () => this.createRoom());
        this.joinBtn.addEventListener('click', () => this.joinRoom());

        // 回车快捷键
        this.roomIdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.joinRoom();
        });
        this.nicknameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.createRoom();
        });
    }

    createRoom() {
        const name = this.nicknameInput.value.trim();
        if (!name) {
            showToast('请输入昵称');
            return;
        }
        this.setStatus('正在创建房间...');
        this.createBtn.disabled = true;
        this.joinBtn.disabled = true;
        socket.emit('create_room', { playerName: name });
    }

    joinRoom() {
        const name = this.nicknameInput.value.trim();
        const roomId = this.roomIdInput.value.trim().toUpperCase();
        if (!name) {
            showToast('请输入昵称');
            return;
        }
        if (!roomId) {
            showToast('请输入房间号');
            return;
        }
        this.setStatus('正在加入房间...');
        this.createBtn.disabled = true;
        this.joinBtn.disabled = true;
        socket.emit('join_room', { roomId, playerName: name });
    }

    setStatus(msg) {
        this.statusEl.textContent = msg;
    }

    show() {
        switchPanel('lobby');
        this.createBtn.disabled = false;
        this.joinBtn.disabled = false;
        this.setStatus('');
    }

    hide() {
        // 由 switchPanel 处理
    }
}

window.LobbyUI = LobbyUI;
