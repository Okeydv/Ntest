'use strict';

/*
 * Кто сейчас в сети: у пользователя есть хотя бы один открытый сокет.
 * Раньше «В сети» бралось из колонки chats.online, которую никто не менял,
 * — статус не обновлялся никогда. Теперь сокеты считает lib/sockets.js, а
 * смена статуса рассылается собеседникам из общих комнат (событие
 * presence в их комнаты user:<id>). Знают об этом только они — те, с кем
 * есть общий чат.
 */

const { dbAll } = require('./db');
const { log } = require('./log');

const sockets = new Map();

const isOnline = userId => (sockets.get(Number(userId)) || 0) > 0;

async function notifyPeers(io, userId, online) {
    try {
        const peers = await dbAll(
            `SELECT DISTINCT theirs.user_id FROM room_participants mine
             JOIN room_participants theirs ON theirs.room_id = mine.room_id AND theirs.user_id <> mine.user_id
             WHERE mine.user_id = $1`, [userId]);
        for (const { user_id: peer } of peers) io.to(`user:${peer}`).emit('presence', { user_id: userId, online });
    } catch (error) {
        log.error({ err: error }, 'Presence error');
    }
}

function socketConnected(io, userId) {
    const count = (sockets.get(userId) || 0) + 1;
    sockets.set(userId, count);
    if (count === 1) notifyPeers(io, userId, true);
}

function socketDisconnected(io, userId) {
    const count = (sockets.get(userId) || 1) - 1;
    if (count > 0) return sockets.set(userId, count);
    sockets.delete(userId);
    notifyPeers(io, userId, false);
}

module.exports = { isOnline, socketConnected, socketDisconnected };
