'use strict';

/*
 * Старый открытый текст в комнатах. Теперь в комнату пишут только
 * зашифрованным, но то, что написали раньше (до шифрования, в пустую
 * комнату, собеседнику без ключей), лежит в messages.text и uploads/.
 *
 * Отличить эти случаи нельзя (времени входа участников раньше не было),
 * поэтому граница простая: все открытые сообщения в комнатах, кроме
 * системных строк. Миграция их не стирает, а только считает и назначает
 * срок: до него в чатах висит плашка «сохраните нужное», после — чистит
 * lib/plaintext-purge.js. Срок — PLAINTEXT_PURGE_DAYS дней (по умолчанию
 * 14; 0 — сразу, для базы, где только тестовые аккаунты).
 *
 * up_to_message_id фиксирует, что именно попало под чистку: новые открытые
 * сообщения в комнатах сервер уже не принимает, но граница по id —
 * страховка от лишнего.
 */

const DEFAULT_DAYS = 14;

function purgeDays(env = process.env) {
    const raw = env.PLAINTEXT_PURGE_DAYS;
    if (raw === undefined || raw === '') return DEFAULT_DAYS;
    const days = Number(raw);
    if (!Number.isFinite(days) || days < 0) throw new Error(`PLAINTEXT_PURGE_DAYS: ожидается число дней ≥ 0, а не «${raw}»`);
    return days;
}

async function up(client, { log, days = purgeDays() } = {}) {
    await client.query(`CREATE TABLE IF NOT EXISTS plaintext_purge (
        room_id INTEGER PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
        up_to_message_id INTEGER NOT NULL,
        message_count INTEGER NOT NULL,
        file_count INTEGER NOT NULL,
        purge_after TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query(
        `INSERT INTO plaintext_purge (room_id, up_to_message_id, message_count, file_count, purge_after)
         SELECT room_id, max(id), count(*), count(file_url), now() + make_interval(secs => $1)
         FROM messages
         WHERE room_id IS NOT NULL AND NOT encrypted AND message_type <> 'system' AND deleted = 0
         GROUP BY room_id
         ON CONFLICT (room_id) DO NOTHING
         RETURNING message_count, file_count`,
        [days * 86400]);
    const total = rows.reduce((n, r) => n + r.message_count, 0);
    const files = rows.reduce((n, r) => n + r.file_count, 0);
    if (log && total > 0) {
        log.warn({ rooms: rows.length, messages: total, files, days },
            'старый открытый текст в комнатах: назначена чистка, в чатах показано предупреждение');
    }
}

module.exports = { up, purgeDays };
