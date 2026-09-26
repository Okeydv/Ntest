'use strict';

/*
 * Прочитано и доставлено (migrations/004_read_state.sql).
 *
 * У каждой записи чата участника — last_read_id и last_delivered_id.
 * Статус своего сообщения для участника — по остальным участникам
 * комнаты: «доставлено», когда дошло до всех, «прочитано», когда все
 * прочитали. Кто выключил отметки о прочтении, тот их не отправляет и не
 * видит чужих.
 */

const { dbGet, dbAll } = require('./db');

// Сообщения переписки этой записи чата.
const SCOPE = `((c.room_id IS NOT NULL AND m.room_id = c.room_id) OR (c.room_id IS NULL AND m.chat_id = c.id))`;
// Чужое для владельца записи: не своя реплика и не системная строка.
// Ответы бота лежат с user_id владельца, но sent = 0 — они чужие.
const FOREIGN = `m.message_type <> 'system' AND NOT (m.user_id IS NOT DISTINCT FROM c.user_id AND m.sent <> 0)`;

const UNREAD_COUNT_SQL = `(SELECT COUNT(*) FROM messages m
    WHERE ${SCOPE} AND m.id > c.last_read_id AND m.deleted = 0 AND ${FOREIGN})`;

/** Что видит участник о своих сообщениях: { read, delivered } или null. */
async function receiptsFor(roomId, userId) {
    const row = await dbGet(
        `SELECT count(*)::int AS n,
                COALESCE(min(c.last_delivered_id), 0) AS delivered,
                COALESCE(min(CASE WHEN u.send_read_receipts THEN c.last_read_id ELSE 0 END), 0) AS read,
                (SELECT send_read_receipts FROM users WHERE id = $2) AS mine
         FROM chats c JOIN users u ON u.id = c.user_id
         WHERE c.room_id = $1 AND c.user_id <> $2`,
        [roomId, userId]
    );
    if (!row || row.n === 0) return null;
    return { read: row.mine ? row.read : 0, delivered: Math.max(row.delivered, row.mine ? row.read : 0) };
}

function statusFor(messageId, receipts) {
    if (!receipts) return 'sent';
    if (messageId <= receipts.read) return 'read';
    if (messageId <= receipts.delivered) return 'delivered';
    return 'sent';
}

/**
 * Разослать участникам комнаты их статусы: у каждого свои «остальные»,
 * поэтому не одним событием на комнату, а каждому в его комнату user:<id>.
 */
async function broadcastReceipts(io, roomId) {
    if (!roomId) return;
    const members = await dbAll('SELECT user_id FROM chats WHERE room_id = $1', [roomId]);
    for (const { user_id: userId } of members) {
        const receipts = await receiptsFor(roomId, userId);
        if (receipts) io.to(`user:${userId}`).emit('receipts', { room_id: roomId, ...receipts });
    }
}

module.exports = { SCOPE, FOREIGN, UNREAD_COUNT_SQL, receiptsFor, statusFor, broadcastReceipts };
