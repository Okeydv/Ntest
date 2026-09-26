'use strict';

// Вложения: открытые (uploads/) и зашифрованные (encrypted-blobs/).

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { log } = require('../lib/log');
const { pool, dbGet, dbAll, dbRun } = require('../lib/db');
const { shared } = require('../lib/shared');
const { stripMetadataInWorker } = require('../lib/metadata-stripper');
const { getCurrentTime, getSocketRoomKey } = require('../lib/helpers');
const {
    BLOBS_DIR, BLOB_ID_RE, MAX_BLOB_BYTES, MIN_BLOB_BYTES, ORPHAN_BLOB_TTL_MS, blobPath,
} = require('../lib/storage');

const ROOT = path.join(__dirname, '..');

module.exports = function registerFileRoutes(app, ctx) {
    const { io } = ctx;

    // Какие вложения принимаются — общий с браузером список
    // (public/crypto/filetypes.js): один на оба пути, открытый и
    // зашифрованный. Тип определяется по содержимому файла, а не по тому, что
    // объявил клиент. Расширение на диске берётся из этого же списка по уже
    // проверенному типу и НИКОГДА из file.originalname (см. п.2 аудита): имя,
    // присланное клиентом, — просто строка, и path.extname() от неё может
    // вернуть что угодно вплоть до '.png"><svg onload=alert(1)>'.
    let fileTypes = null;

    const fileTypesReady = shared('filetypes.js').then(m => { fileTypes = m; return m; });

    // '.svg' явно в блок-листе как доп. защита (defense-in-depth, п.7 аудита):
    // image/svg+xml и так не входит в список типов, но SVG может нести
    // <script>, поэтому расширение блокируется отдельно на случай, если формат
    // когда-либо попадёт в разрешённый список по ошибке.
    const BLOCKED_EXTENSIONS = new Set(['.html', '.htm', '.php', '.exe', '.js', '.sh', '.py', '.rb', '.pl', '.bat', '.cmd', '.ps1', '.vbs', '.jar', '.msi', '.svg']);

    // Итоговое имя файла на диске должно состоять только из "безопасных" для
    // файловой системы символов — доп. страховка на случай, если список типов
    // когда-нибудь получит некорректное значение (п.2 аудита, "валидировать
    // итоговое имя файла регуляркой").
    const SAFE_FILENAME_RE = /^[\w.-]+$/;

    const upload = multer({
        storage: multer.diskStorage({
            destination: (req, file, cb) => {
                const dir = path.join(ROOT, 'uploads');
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                cb(null, dir);
            },
            filename: (req, file, cb) => {
                // Расширение — только из общего списка типов (по уже
                // проверенному в fileFilter mimetype), никогда из
                // file.originalname — см. комментарий у fileTypes выше.
                const ext = fileTypes.ATTACHMENT_TYPES[file.mimetype].ext;
                const safeName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
                if (!SAFE_FILENAME_RE.test(safeName)) {
                    return cb(new Error('Не удалось сформировать безопасное имя файла'));
                }
                cb(null, safeName);
            }
        }),
        limits: { fileSize: 50 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
            fileTypesReady.then(types => {
                const ext = path.extname(file.originalname).toLowerCase();
                if (BLOCKED_EXTENSIONS.has(ext) || !types.ATTACHMENT_TYPES[file.mimetype]) {
                    return cb(new Error('Неподдерживаемый тип файла'), false);
                }
                cb(null, true);
            }, cb);
        }
    });

    app.get('/uploads/:filename', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        const filename = path.basename(req.params.filename);
        const filePath = path.join(ROOT, 'uploads', filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ success: false, message: 'Файл не найден' });
        try {
            const allowed = await userCanAccessFile(req.session.userId, filename);
            // Тот же 404, что и на несуществующий файл: иначе по 403 было бы
            // видно, что файл с таким именем есть.
            if (!allowed) return res.status(404).json({ success: false, message: 'Файл не найден' });
        } catch (err) {
            log.error({ err: err }, 'Uploads access check error');
            return res.status(500).json({ success: false, message: 'Ошибка проверки доступа' });
        }
        res.sendFile(filePath);
    });

    /**
     * POST /api/blobs?chatId=N — загрузить зашифрованное вложение.
     *
     * Тело — сырые байты шифротекста (application/octet-stream). Проверить
     * их содержимое сервер не может и не должен: magic bytes, EXIF, тип файла —
     * всё это теперь забота отправителя. Проверяется только, что чат свой и
     * размер в пределах.
     */
    app.post('/api/blobs',
        express.raw({ type: 'application/octet-stream', limit: MAX_BLOB_BYTES }),
        async (req, res) => {
            if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
            const chatId = Number(req.query.chatId);
            if (!Number.isInteger(chatId) || chatId <= 0) {
                return res.status(400).json({ success: false, message: 'Не указан чат' });
            }
            const body = req.body;
            if (!Buffer.isBuffer(body) || body.length < MIN_BLOB_BYTES) {
                return res.status(400).json({ success: false, message: 'Пустое или некорректное вложение' });
            }
            try {
                const chat = await dbGet('SELECT id, room_id FROM chats WHERE id = $1 AND user_id = $2',
                    [chatId, req.session.userId]);
                if (!chat) return res.status(404).json({ success: false, message: 'Чат не найден' });

                const id = crypto.randomBytes(16).toString('hex');
                await fs.promises.writeFile(blobPath(id), body, { flag: 'wx' });
                await pool.query(
                    `INSERT INTO encrypted_blobs (id, uploader_user_id, chat_id, room_id, size)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [id, req.session.userId, chat.id, chat.room_id || null, body.length]
                );
                res.json({ success: true, blobId: id });
            } catch (error) {
                log.error({ err: error }, 'Blob upload error');
                res.status(500).json({ success: false, message: 'Не удалось сохранить вложение' });
            }
        }
    );

    /**
     * GET /api/blobs/:id — скачать зашифрованное вложение.
     *
     * Доступ — как к самому сообщению: участникам чата. Пока вложение не
     * привязано к сообщению, скачать его может только загрузивший. Отдаётся
     * всегда как octet-stream: это шифротекст, и браузер не должен пытаться
     * его интерпретировать.
     */
    app.get('/api/blobs/:id', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        const id = req.params.id;
        // Один ответ 404 на всё: и на кривой id, и на чужое, и на удалённое —
        // иначе по кодам ответа можно перебором узнавать, какие id существуют.
        const notFound = () => res.status(404).json({ success: false, message: 'Вложение не найдено' });
        if (!BLOB_ID_RE.test(id)) return notFound();
        try {
            const blob = await dbGet(
                `SELECT b.id, b.uploader_user_id, b.message_id, m.deleted
                 FROM encrypted_blobs b LEFT JOIN messages m ON m.id = b.message_id
                 WHERE b.id = $1`,
                [id]
            );
            if (!blob) return notFound();
            const allowed = blob.message_id
                ? !blob.deleted && await ctx.userCanAccessMessage(req.session.userId, blob.message_id)
                : blob.uploader_user_id === req.session.userId;
            if (!allowed) return notFound();

            res.set('Content-Type', 'application/octet-stream');
            res.set('Cache-Control', 'private, no-store');
            res.set('Content-Disposition', 'attachment');
            res.sendFile(blobPath(id), err => {
                if (err && !res.headersSent) notFound();
            });
        } catch (error) {
            log.error({ err: error }, 'Blob download error');
            res.status(500).json({ success: false, message: 'Ошибка загрузки вложения' });
        }
    });

    /**
     * Уборка вложений, которые никому не принадлежат: загружены, но сообщение
     * так и не отправлено, либо строка ушла каскадом вместе с сообщением,
     * чатом или анонимным пользователем, а файл на диске остался.
     */
    async function sweepOrphanBlobs() {
        try {
            const stale = await dbAll(
                `SELECT id FROM encrypted_blobs
                 WHERE message_id IS NULL AND created_at < now() - ($1 || ' milliseconds')::interval`,
                [String(ORPHAN_BLOB_TTL_MS)]
            );
            for (const b of stale) {
                await fs.promises.unlink(blobPath(b.id)).catch(() => {});
                await dbRun('DELETE FROM encrypted_blobs WHERE id = $1', [b.id]);
            }

            const known = new Set((await dbAll('SELECT id FROM encrypted_blobs')).map(r => r.id));
            const cutoff = Date.now() - ORPHAN_BLOB_TTL_MS;
            for (const name of await fs.promises.readdir(BLOBS_DIR)) {
                const id = name.replace(/\.bin$/, '');
                if (known.has(id)) continue;
                const full = path.join(BLOBS_DIR, name);
                const stat = await fs.promises.stat(full).catch(() => null);
                // Свежие файлы не трогаем: между записью файла и строки в базе
                // есть окно, и уборщик не должен съедать загрузку на лету.
                if (stat && stat.isFile() && stat.mtimeMs < cutoff) {
                    await fs.promises.unlink(full).catch(() => {});
                }
            }
        } catch (error) {
            log.error({ err: error }, 'Blob sweep error');
        }
    }

    setInterval(sweepOrphanBlobs, ORPHAN_BLOB_TTL_MS).unref();

    /**
     * Имя файла из multipart. Браузер присылает его в UTF-8, а multer (busboy)
     * читает как latin1 — русские имена превращались в «Ð·Ð°Ð¼ÐµÑ…». Если после
     * перекодировки получается некорректный UTF-8, значит имя и было latin1 —
     * оставляем как есть.
     */
    function decodeUploadName(name) {
        const utf8 = Buffer.from(String(name || ''), 'latin1').toString('utf8');
        return utf8.includes('\uFFFD') ? String(name || '') : utf8;
    }

    // multer(upload.single('file')) уже записал файл на диск ДО этого хендлера —
    // значит, ранние return (401/400/404) должны сами убирать за собой, иначе
    // каждая неудачная/подделанная попытка загрузки будет накапливать файлы-сироты.
    function cleanupUploadedFile(file) {
        if (!file) return;
        try {
            const p = path.join(ROOT, 'uploads', file.filename);
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (e) { /* ignore */ }
    }

    app.post('/api/messages/file', upload.single('file'), async (req, res) => {
        if (!req.session.userId) {
            cleanupUploadedFile(req.file);
            return res.status(401).json({ success: false, message: 'Не авторизован' });
        }
        const { chatId, text } = req.body;
        const file = req.file;

        if (!file) return res.status(400).json({ success: false, message: 'Файл не выбран' });
        if (!chatId) {
            cleanupUploadedFile(file);
            return res.status(400).json({ success: false, message: 'Указан чат' });
        }

        const uploadedFilePath = path.join(ROOT, 'uploads', file.filename);
        try {
            // Тип — по всему содержимому, а не по первым байтам: text/plain
            // раньше не проверялся вовсе, и JPEG с координатами, названный
            // .txt, уходил мимо очистки. Видео MP4/MOV/3GP — один контейнер, и
            // расхождение внутри семейства не считается подменой.
            const detected = fileTypes.detectType(await fs.promises.readFile(uploadedFilePath));
            const sameFamily = detected === file.mimetype
                || (fileTypes.ISO_BMFF_TYPES.has(detected) && fileTypes.ISO_BMFF_TYPES.has(file.mimetype));
            if (!sameFamily) {
                fs.unlinkSync(uploadedFilePath);
                return res.status(400).json({ success: false, message: 'Содержимое файла не соответствует его типу' });
            }

            // Удаление метаданных из файла для защиты приватности. Не удалось —
            // файл не отправляется: молча раздать фото с координатами хуже,
            // чем не отправить его вовсе.
            if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf'
                || file.mimetype === 'video/webm' || fileTypes.ISO_BMFF_TYPES.has(file.mimetype)) {
                try {
                    // В отдельном процессе с пределом памяти и времени: разбор
                    // чужого файла не должен уметь уронить или повесить сервер.
                    await stripMetadataInWorker(uploadedFilePath, file.mimetype);
                } catch (stripErr) {
                    log.error({ err: stripErr }, 'Metadata strip error');
                    try { if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath); } catch (_) { /* ignore */ }
                    // У PDF причина бывает двух видов — защищён паролем или
                    // повреждён, — и советы для них разные.
                    return res.status(400).json({ success: false, message: stripErr.name === 'PdfCleanError'
                        ? `Файл не отправлен: ${stripErr.message}`
                        : stripErr.name === 'WorkerLimitError'
                            ? 'Файл слишком сложный: очистка не уложилась в пределы — он не отправлен'
                            : 'Не удалось удалить метаданные из файла — он не отправлен' });
                }
            }
        } catch (magicErr) {
            // Раньше при исключении здесь проверка молча пропускалась и файл
            // проходил дальше — теоретическая лазейка мимо проверки типа файла.
            // Теперь любая ошибка проверки = отказ (fail closed), а не fail open.
            log.error({ err: magicErr }, 'Magic bytes check error');
            try { if (fs.existsSync(uploadedFilePath)) fs.unlinkSync(uploadedFilePath); } catch (_) { /* ignore */ }
            return res.status(400).json({ success: false, message: 'Не удалось проверить содержимое файла' });
        }

        try {
            const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) {
                cleanupUploadedFile(file);
                return res.status(404).json({ success: false, message: 'Чат не найден' });
            }

            const time = getCurrentTime();
            const roomId = chat.room_id || null;
            const socketRoomKey = getSocketRoomKey(chatId, roomId);
            const fileUrl = `/uploads/${file.filename}`;
            const fileType = file.mimetype;
            // Имя фото и видео выдаёт дату, время и приложение — оно
            // заменяется нейтральным; имя документа остаётся (см. filetypes.js).
            const sanitizedFileName = fileTypes.attachmentName(fileType, path.basename(decodeUploadName(file.originalname)))
                .slice(0, 200).replace(/[<>&"']/g, '');

            const messageType = fileType.startsWith('image/') ? 'image' : fileType.startsWith('video/') ? 'video' : 'file';
            const messageText = text ? String(text).trim() : sanitizedFileName;

            const result = await pool.query(
                'INSERT INTO messages (chat_id, room_id, user_id, text, file_url, file_name, file_type, message_type, sent, time, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id, created_at',
                [chatId, roomId, req.session.userId, messageText, fileUrl, sanitizedFileName, fileType, messageType, 1, time, 'sent']
            );
            const messageId = result.rows[0].id;
            const createdAt = result.rows[0].created_at;

            const senderUser = await dbGet('SELECT username, avatar FROM users WHERE id = $1', [req.session.userId]);
            const senderUsername = senderUser ? senderUser.username : '';
            const senderAvatar = senderUser ? (senderUser.avatar || '') : '';

            // «Доставлено» и «прочитано» больше не подделываются таймерами:
            // их ставят отметки собеседников (lib/read-state.js).

            // Срок чата — и для файлов: раньше они не исчезали вовсе.
            const expiresAt = await ctx.applyExpiry(messageId, chatId, null);

            const fileMessage = {
                id: messageId, chat_id: Number(chatId), room_id: roomId, user_id: req.session.userId,
                sender_username: senderUsername, sender_avatar: senderAvatar,
                text: messageText, file_url: fileUrl, file_name: sanitizedFileName,
                file_type: fileType, message_type: messageType, sent: true, time, status: 'sent',
                // Без него получатель не знал дня и показывал время сервера.
                created_at: createdAt,
                expires_at: expiresAt,
            };
            io.to(socketRoomKey).emit('newMessage', fileMessage);
            res.json({ success: true, message: fileMessage });
        } catch (error) {
            log.error({ err: error }, 'Upload file error');
            res.status(500).json({ success: false, message: 'Ошибка отправки файла' });
        }
    });

    async function userCanAccessFile(userId, filename) {
        const fileUrl = `/uploads/${filename}`;
        // Файл удалённого сообщения не отдаётся никому, даже если он ещё не
        // успел исчезнуть с диска.
        const message = await dbGet('SELECT id FROM messages WHERE file_url = $1 AND deleted = 0 LIMIT 1', [fileUrl]);
        if (!message) return false;
        return ctx.userCanAccessMessage(userId, message.id);
    }
};
