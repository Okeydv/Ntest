'use strict';

/*
 * Пустая комната — та, где, кроме пишущего, никого нет. Писать туда
 * нельзя: шифровать не для кого, и всё написанное легло бы на сервер
 * открытым текстом. Бот в комнатах не участвует; чат с ботом — не
 * комната, его это не касается.
 */

const { randomCode, normalizeCode } = require('./codes');
const { dbGet, dbAll } = require('./db');

// Открытым текстом — только чат с ботом: бот отвечает на текст, который
// видит. В любой другой чат — только зашифрованное. Это страховка на
// случай, если клиент (свой, старый или подменённый) попробует отправить
// открытым: решение «шифровать или нет» не должно зависеть от того, что
// сервер отдал ему о собеседниках.
const E2EE_REQUIRED = {
    success: false,
    code: 'E2EE_REQUIRED',
    message: 'В этом чате сообщения отправляются только зашифрованными',
};

const ROOM_EMPTY = {
    success: false,
    code: 'ROOM_EMPTY',
    message: 'В чате пока никого нет — сначала пригласите участников',
};

async function roomHasOthers(roomId, userId) {
    return Boolean(await dbGet(
        'SELECT 1 FROM room_participants WHERE room_id = $1 AND user_id <> $2 LIMIT 1', [roomId, userId]));
}

// Можно ли писать в чат: не комната или комната, где есть кто-то ещё.
async function canWriteTo(chat, userId) {
    return !chat.room_id || roomHasOthers(chat.room_id, userId);
}

// Роль участника в комнате: 'admin', 'member' или null — не участник.
async function roleIn(roomId, userId) {
    const row = await dbGet('SELECT role FROM room_participants WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
    return row ? row.role : null;
}

async function adminIds(roomId) {
    return (await dbAll("SELECT user_id FROM room_participants WHERE room_id = $1 AND role = 'admin'", [roomId]))
        .map(r => r.user_id);
}

/*
 * Группа без администратора никого не впустит и ссылку не сменит. Когда
 * уходит (или удаляется вместе с анонимным аккаунтом) последний
 * администратор, им становится самый давний участник. Возвращает id
 * назначенного или null, если назначать не пришлось.
 */
async function ensureAdmin(roomId) {
    const promoted = await dbGet(
        `UPDATE room_participants SET role = 'admin'
         WHERE id = (SELECT min(id) FROM room_participants WHERE room_id = $1)
           AND NOT EXISTS (SELECT 1 FROM room_participants WHERE room_id = $1 AND role = 'admin')
         RETURNING user_id`, [roomId]);
    return promoted ? promoted.user_id : null;
}

/*
 * Блокировка в личном чате: 'you' — пишущий сам заблокировал собеседника,
 * 'them' — собеседник заблокировал его, null — писать можно. В группах
 * блокировка не действует: там решают администраторы.
 */
async function directBlock(chat, userId) {
    if (!chat.room_id) return null;
    const row = await dbGet(
        `SELECT b.blocker_id FROM rooms r
         JOIN room_participants o ON o.room_id = r.id AND o.user_id <> $2
         JOIN blocks b ON (b.blocker_id = $2 AND b.blocked_id = o.user_id) OR (b.blocker_id = o.user_id AND b.blocked_id = $2)
         WHERE r.id = $1 AND r.kind = 'direct' LIMIT 1`, [chat.room_id, userId]);
    if (!row) return null;
    return row.blocker_id === userId ? 'you' : 'them';
}

const BLOCKED = {
    you: { success: false, code: 'BLOCKED', message: 'Вы заблокировали собеседника — сначала разблокируйте его в меню чата' },
    them: { success: false, code: 'BLOCKED', message: 'Сообщение не доставлено: собеседник не принимает от вас сообщения' },
};

module.exports = {
    E2EE_REQUIRED, ROOM_EMPTY, roomHasOthers, canWriteTo,
    roleIn, adminIds, ensureAdmin, directBlock, BLOCKED,
    newLinkToken: randomCode, normalizeLinkToken: normalizeCode,
};
