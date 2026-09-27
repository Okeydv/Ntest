'use strict';

/*
 * Чистка старого открытого текста в комнатах (см. migrations/009). Когда
 * срок комнаты вышел, её открытые сообщения (кроме системных строк)
 * помечаются удалёнными, текст и ссылки на файлы стираются, файлы — с
 * диска, строки сроков исчезания — тоже. Участникам уходит messageDeleted,
 * чтобы открытые экраны не показывали стёртое.
 *
 * Резервные копии базы это не трогает: в них открытый текст остаётся, пока
 * копии не устареют (см. README).
 */

const { dbAll, dbRun } = require('./db');
const { log } = require('./log');
const { purgeMessageContent } = require('./storage');

async function purgeDuePlaintext(io) {
    const due = await dbAll('SELECT room_id, up_to_message_id FROM plaintext_purge WHERE purge_after <= now()');
    let purged = 0;
    for (const { room_id: roomId, up_to_message_id: upTo } of due) {
        const ids = (await dbAll(
            `SELECT id FROM messages
             WHERE room_id = $1 AND id <= $2 AND NOT encrypted AND message_type <> 'system' AND deleted = 0`,
            [roomId, upTo])).map(r => r.id);
        for (const id of ids) {
            await dbRun('UPDATE messages SET deleted = 1 WHERE id = $1', [id]);
            await purgeMessageContent(id);
        }
        if (ids.length) await dbRun('DELETE FROM message_expiry WHERE message_id = ANY($1::int[])', [ids]);
        await dbRun('DELETE FROM plaintext_purge WHERE room_id = $1', [roomId]);
        if (io) for (const id of ids) io.to(`room:${roomId}`).emit('messageDeleted', { id, room_id: roomId });
        purged += ids.length;
    }
    if (purged) log.info({ rooms: due.length, messages: purged }, 'старый открытый текст в комнатах стёрт');
    return purged;
}

// Срок чистки для комнаты — для плашки в чате. null — чистить нечего.
async function plaintextNotice(roomId) {
    if (!roomId) return null;
    const [row] = await dbAll('SELECT message_count, purge_after FROM plaintext_purge WHERE room_id = $1', [roomId]);
    return row ? { count: row.message_count, purgeAfter: row.purge_after } : null;
}

function startPlaintextPurge(io, intervalMs = Number(process.env.PLAINTEXT_PURGE_INTERVAL_MS) || 60 * 60 * 1000) {
    const run = () => purgeDuePlaintext(io).catch(error => log.error({ err: error }, 'Plaintext purge error'));
    run();
    return setInterval(run, intervalMs).unref();
}

module.exports = { purgeDuePlaintext, plaintextNotice, startPlaintextPurge };
