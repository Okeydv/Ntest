'use strict';

/*
 * Пустая комната — та, где, кроме пишущего, никого нет. Писать туда
 * нельзя: шифровать не для кого, и всё написанное легло бы на сервер
 * открытым текстом. Бот в комнатах не участвует; чат с ботом — не
 * комната, его это не касается.
 */

const { dbGet } = require('./db');

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

module.exports = { E2EE_REQUIRED, ROOM_EMPTY, roomHasOthers, canWriteTo };
