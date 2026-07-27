const CHARACTERS = require('../data/characters.json');

class RoomManager {
    constructor() {
        this.rooms = new Map();
    }

    generateRoomId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let id;
        do {
            id = '';
            for (let i = 0; i < 4; i++) {
                id += chars[Math.floor(Math.random() * chars.length)];
            }
        } while (this.rooms.has(id));
        return id;
    }

    createRoom(player) {
        const roomId = this.generateRoomId();
        const room = {
            id: roomId,
            players: new Map(),
            phase: 'waiting', // waiting | skill_select | prepare | battle | game_over
            round: 0,
            timer: null,
            createdAt: Date.now()
        };
        room.players.set(player.id, player);
        this.rooms.set(roomId, room);
        return room;
    }

    getRoom(roomId) {
        return this.rooms.get(roomId);
    }

    addPlayerToRoom(roomId, player) {
        const room = this.rooms.get(roomId);
        if (!room) return null;
        if (room.players.size >= 2) return null;
        room.players.set(player.id, player);
        return room;
    }

    getOpponent(roomId, playerId) {
        const room = this.rooms.get(roomId);
        if (!room) return null;
        for (const [id, player] of room.players) {
            if (id !== playerId) return player;
        }
        return null;
    }

    getRoomByPlayerId(playerId) {
        for (const [roomId, room] of this.rooms) {
            if (room.players.has(playerId)) return room;
        }
        return null;
    }

    removePlayer(playerId) {
        const room = this.getRoomByPlayerId(playerId);
        if (!room) return null;
        room.players.delete(playerId);
        if (room.players.size === 0) {
            if (room.timer) {
                room.timer.stop();
            }
            this.rooms.delete(room.id);
        }
        return room;
    }

    bothPlayersReady(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return false;
        return room.players.size === 2;
    }

    getRandomCharacterId() {
        const chars = CHARACTERS.characters;
        return chars[Math.floor(Math.random() * chars.length)].id;
    }
}

module.exports = RoomManager;
