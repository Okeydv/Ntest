// Уборка каталога uploads/.
//
// Удаляются только файлы, на которые не ссылается ни одно живое сообщение:
// оборванные загрузки, вложения сообщений, удалённых до того, как удаление
// стало стирать файлы, и чатов, удалённых целиком.
//
// Раньше здесь раз в час удалялись ВСЕ файлы старше суток, без сверки с
// базой: вложения пропадали, а в переписке оставались битые ссылки. Для
// исчезновения по времени в приложении есть исчезающие сообщения.

const fs = require('fs');
const path = require('path');

/**
 * ttlMs — сколько живёт файл без ссылки на него: между записью файла и
 * строки в базе есть окно, и уборщик не должен съедать загрузку на лету.
 * Возвращает список удалённых имён.
 */
async function sweepOrphanUploads(dir, { dbAll, ttlMs, now = Date.now() }) {
    const referenced = new Set((await dbAll(
        'SELECT file_url FROM messages WHERE file_url IS NOT NULL AND deleted = 0'
    )).map(r => path.basename(r.file_url)));

    const removed = [];
    for (const name of await fs.promises.readdir(dir)) {
        if (referenced.has(name)) continue;
        const full = path.join(dir, name);
        const stat = await fs.promises.stat(full).catch(() => null);
        if (stat && stat.isFile() && stat.mtimeMs < now - ttlMs) {
            await fs.promises.unlink(full).catch(() => {});
            removed.push(name);
        }
    }
    return removed;
}

module.exports = { sweepOrphanUploads };
