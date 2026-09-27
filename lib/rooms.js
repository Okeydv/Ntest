'use strict';

/*
 * Пустая комната — та, где, кроме пишущего, никого нет. Писать туда
 * нельзя: шифровать не для кого, и всё написанное легло бы на сервер
 * открытым текстом. Бот в комнатах не участвует; чат с ботом — не
 * комната, его это не касается.
 */

const crypto = require('crypto');
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
 * Ссылка-приглашение: 12 знаков без похожих друг на друга (0/O, 1/I/L) —
 * 60 бит, подбором не найти. Вводить её руками не придётся, но
 * продиктовать можно.
 */
const LINK_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newLinkToken() {
    // 31 знак: отбрасываем байты за границей кратного, чтобы знаки
    // выпадали равновероятно.
    const out = [];
    while (out.length < 12) {
        for (const b of crypto.randomBytes(16)) {
            if (b < 248 && out.length < 12) out.push(LINK_ALPHABET[b % 31]);
        }
    }
    return out.join('');
}

// Что угодно из того, что человек мог вставить: сам код, «/join#код»,
// полную ссылку, с пробелами и дефисами, в любом регистре.
function normalizeLinkToken(input) {
    const s = String(input || '');
    const tail = s.includes('#') ? s.slice(s.lastIndexOf('#') + 1) : s;
    return tail.toUpperCase().replace(/[\s-]/g, '');
}

module.exports = {
    E2EE_REQUIRED, ROOM_EMPTY, roomHasOthers, canWriteTo,
    roleIn, adminIds, ensureAdmin, newLinkToken, normalizeLinkToken,
};
