'use strict';

// Где лежат вложения и как по-настоящему стереть содержимое сообщения.

const fs = require('fs');
const path = require('path');
const { dbGet, dbAll, dbRun } = require('./db');

const ROOT = path.join(__dirname, '..');

// Отдельный каталог, а не uploads/: фоновый уборщик раз в час удаляет из
// uploads/ ВСЕ файлы старше суток, не сверяясь с базой, — вложения
// зашифрованных сообщений он уничтожал бы вместе с остальными. Здесь
// время жизни файла совпадает со временем жизни сообщения.
const BLOBS_DIR = path.join(ROOT, 'encrypted-blobs');

if (!fs.existsSync(BLOBS_DIR)) fs.mkdirSync(BLOBS_DIR, { recursive: true });

const BLOB_ID_RE = /^[0-9a-f]{32}$/;

const MAX_BLOB_BYTES = 50 * 1024 * 1024;   // как у открытых вложений

// Пустой файл после AES-GCM — это 16 байт тега. Меньше быть не может.
const MIN_BLOB_BYTES = 16;

const MAX_BLOBS_PER_MESSAGE = 10;

// Сколько живёт загруженное, но так и не отправленное вложение.
const ORPHAN_BLOB_TTL_MS = 60 * 60 * 1000;

const blobPath = id => path.join(BLOBS_DIR, `${id}.bin`);

/**
 * Удалить всё зашифрованное содержимое сообщения: конверты и вложения.
 *
 * Удаление сообщения в приложении мягкое (deleted = 1), и для открытого
 * текста это частично работает — исчезающие сообщения затирают text. Но у
 * зашифрованного сообщения содержимое живёт в конвертах и файлах, и мягкое
 * удаление оставляло бы их на сервере навсегда. Здесь они удаляются
 * по-настоящему.
 */
async function purgeEncryptedContent(messageId) {
    const blobs = await dbAll('SELECT id FROM encrypted_blobs WHERE message_id = $1', [messageId]);
    for (const b of blobs) {
        await fs.promises.unlink(blobPath(b.id)).catch(() => {});
    }
    await dbRun('DELETE FROM encrypted_blobs WHERE message_id = $1', [messageId]);
    await dbRun('DELETE FROM message_envelopes WHERE message_id = $1', [messageId]);
    await dbRun('DELETE FROM message_group_payloads WHERE message_id = $1', [messageId]);
}

const UPLOADS_DIR = path.join(ROOT, 'uploads');

// Сколько живёт файл в uploads/, на который не ссылается ни одно
// сообщение: загрузка, оборвавшаяся между записью файла и строки в базе.
const ORPHAN_UPLOAD_TTL_MS = 60 * 60 * 1000;

/**
 * Удалить содержимое удалённого сообщения по-настоящему.
 *
 * Удаление в приложении мягкое (deleted = 1): строка нужна, на неё ссылаются
 * ответы и реакции. Но содержимому на сервере после удаления делать нечего:
 * раньше текст оставался в базе (и всплывал в цитате ответа), а файл —
 * на диске и по-прежнему скачивался по прямой ссылке.
 */
async function purgeMessageContent(messageId) {
    const message = await dbGet('SELECT file_url, encrypted FROM messages WHERE id = $1', [messageId]);
    if (!message) return;
    if (message.file_url) {
        const filename = path.basename(message.file_url);
        await fs.promises.unlink(path.join(UPLOADS_DIR, filename)).catch(() => {});
    }
    await dbRun('UPDATE messages SET text = NULL, file_url = NULL, file_name = NULL WHERE id = $1', [messageId]);
    if (message.encrypted) await purgeEncryptedContent(messageId);
}

module.exports = {
    BLOBS_DIR, BLOB_ID_RE, MAX_BLOB_BYTES, MIN_BLOB_BYTES, MAX_BLOBS_PER_MESSAGE, ORPHAN_BLOB_TTL_MS, blobPath,
    UPLOADS_DIR, ORPHAN_UPLOAD_TTL_MS, purgeEncryptedContent, purgeMessageContent,
};
