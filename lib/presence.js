'use strict';

/*
 * Кто сейчас в сети: у пользователя есть хотя бы один открытый сокет.
 * Раньше «В сети» бралось из колонки chats.online, которую никто не менял,
 * — статус не обновлялся никогда. Теперь сокеты считает lib/sockets.js, а
 * смена статуса рассылается собеседникам из общих комнат (событие
 * presence в их комнаты user:<id>). Знают об этом только они — те, с кем
 * есть общий чат.
 */

const { dbAll, dbGet } = require('./db');
const { log } = require('./log');

const sockets = new Map();

const isOnline = userId => (sockets.get(Number(userId)) || 0) > 0;

// Событие всем, с кем у пользователя есть общий чат, — и больше никому.
async function emitToPeers(io, userId, event, payload) {
    try {
        const peers = await dbAll(
            `SELECT DISTINCT theirs.user_id FROM room_participants mine
             JOIN room_participants theirs ON theirs.room_id = mine.room_id AND theirs.user_id <> mine.user_id
             WHERE mine.user_id = $1`, [userId]);
        for (const { user_id: peer } of peers) io.to(`user:${peer}`).emit(event, payload);
    } catch (error) {
        log.error({ err: error, event }, 'Peer notify error');
    }
}

/*
 * Статус видят только собеседники, и только если ни он, ни они его не
 * скрывают («Скрывать, когда я в сети» в профиле): скрывший и сам не видит
 * чужой. Уходя из сети, пользователь оставляет время — «был(а) в 14:05».
 */
async function notifyPresence(io, userId, online, lastSeen = null) {
    try {
        const me = await dbGet('SELECT hide_presence FROM users WHERE id = $1', [userId]);
        if (!me || me.hide_presence) return;
        const peers = await dbAll(
            `SELECT DISTINCT theirs.user_id FROM room_participants mine
             JOIN room_participants theirs ON theirs.room_id = mine.room_id AND theirs.user_id <> mine.user_id
             JOIN users u ON u.id = theirs.user_id
             WHERE mine.user_id = $1 AND NOT u.hide_presence`, [userId]);
        const payload = { user_id: userId, online, last_seen: lastSeen };
        for (const { user_id: peer } of peers) io.to(`user:${peer}`).emit('presence', payload);
    } catch (error) {
        log.error({ err: error }, 'Presence error');
    }
}

function socketConnected(io, userId) {
    const count = (sockets.get(userId) || 0) + 1;
    sockets.set(userId, count);
    if (count === 1) notifyPresence(io, userId, true);
}

async function socketDisconnected(io, userId) {
    const count = (sockets.get(userId) || 1) - 1;
    if (count > 0) return sockets.set(userId, count);
    sockets.delete(userId);
    let lastSeen = null;
    try {
        const row = await dbGet('UPDATE users SET last_seen_at = now() WHERE id = $1 RETURNING last_seen_at', [userId]);
        lastSeen = row ? row.last_seen_at : null;
    } catch (error) {
        log.error({ err: error }, 'Last seen error');
    }
    // Пока писали время, мог открыться новый сокет — тогда он уже в сети.
    if (!isOnline(userId)) notifyPresence(io, userId, false, lastSeen);
}

// Скрыл — собеседники сразу перестают видеть статус; открыл — видят снова.
async function setPresenceHidden(io, userId, hidden) {
    if (hidden) {
        await emitToPeers(io, userId, 'presence', { user_id: userId, hidden: true });
    } else {
        const row = await dbGet('SELECT last_seen_at FROM users WHERE id = $1', [userId]);
        await notifyPresence(io, userId, isOnline(userId), row ? row.last_seen_at : null);
    }
}

module.exports = { isOnline, socketConnected, socketDisconnected, emitToPeers, setPresenceHidden };
