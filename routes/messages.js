'use strict';

// Сообщения: история, отправка открытых и зашифрованных, правка, удаление, реакции, сроки.

const { log } = require('../lib/log');
const { pool, dbGet, dbAll, dbRun } = require('../lib/db');
const { normalizeExpiry } = require('../lib/disappearing-messages');
const { sanitizeText } = require('../lib/privacy');
const { getCurrentTime, getSocketRoomKey } = require('../lib/helpers');
const { receiptsFor, statusFor } = require('../lib/read-state');
const { BLOB_ID_RE, MAX_BLOBS_PER_MESSAGE, purgeMessageContent } = require('../lib/storage');


module.exports = function registerMessageRoutes(app, ctx) {
    const { io } = ctx;

    const MAX_ENVELOPES = 256;

    const MAX_HEADER_B64 = 2048;

    const MAX_CIPHERTEXT_B64 = 16384;

    // Строгий base64: иначе в BYTEA уехал бы мусор, а ошибка всплыла бы только
    // у получателя при расшифровке, где её уже не с чем связать.
    const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

    function decodeB64(value, maxLen, field) {
        if (typeof value !== 'string' || value.length === 0 || value.length > maxLen) {
            return { error: `${field}: ожидается base64 до ${maxLen} символов` };
        }
        if (!B64_RE.test(value)) return { error: `${field}: некорректный base64` };
        const buf = Buffer.from(value, 'base64');
        if (buf.length === 0) return { error: `${field}: пустое значение` };
        // Buffer.from не бросает на мусоре, а молча отбрасывает лишнее —
        // сверяем обратной кодировкой, что ничего не потерялось.
        if (buf.toString('base64').replace(/=+$/, '') !== value.replace(/=+$/, '')) {
            return { error: `${field}: некорректный base64` };
        }
        return { buf };
    }

    // Групповой заголовок: версия + id распространения (16) + номер (4).
    const GROUP_HEADER_BYTES = 21;

    const GROUP_SIGNATURE_BYTES = 64;

    /**
     * Разобрать список конвертов. Каждый обязан быть адресован устройству
     * участника чата: иначе сервер превращается в хранилище, куда можно писать
     * кому угодно. Возвращает { parsed } или { status, message }.
     */
    function parseEnvelopeList(list, allowedIds, label) {
        const parsed = [];
        const seen = new Set();
        for (const item of list) {
            const deviceId = Number(item && item.recipientDeviceId);
            if (!Number.isInteger(deviceId) || deviceId <= 0) {
                return { status: 400, message: `${label}: некорректный recipientDeviceId` };
            }
            if (seen.has(deviceId)) {
                return { status: 400, message: `${label}: дубликат для устройства ${deviceId}` };
            }
            if (!allowedIds.has(deviceId)) {
                return { status: 403, message: `Устройство ${deviceId} не участвует в чате` };
            }
            const type = Number(item.envelopeType);
            if (type !== 1 && type !== 2) {
                return { status: 400, message: 'envelopeType должен быть 1 (prekey) или 2 (normal)' };
            }
            const header = decodeB64(item.header, MAX_HEADER_B64, 'header');
            if (header.error) return { status: 400, message: header.error };
            const ciphertext = decodeB64(item.ciphertext, MAX_CIPHERTEXT_B64, 'ciphertext');
            if (ciphertext.error) return { status: 400, message: ciphertext.error };

            seen.add(deviceId);
            parsed.push({ deviceId, type, header: header.buf, ciphertext: ciphertext.buf });
        }
        return { parsed, seen };
    }

    function parseGroupPayload(group) {
        if (!group || typeof group !== 'object') return { message: 'group: ожидается объект' };
        const header = decodeB64(group.header, MAX_HEADER_B64, 'group.header');
        if (header.error) return { message: header.error };
        if (header.buf.length !== GROUP_HEADER_BYTES) return { message: 'group.header: неверная длина' };
        const signature = decodeB64(group.signature, MAX_HEADER_B64, 'group.signature');
        if (signature.error) return { message: signature.error };
        if (signature.buf.length !== GROUP_SIGNATURE_BYTES) return { message: 'group.signature: неверная длина' };
        const ciphertext = decodeB64(group.ciphertext, MAX_CIPHERTEXT_B64, 'group.ciphertext');
        if (ciphertext.error) return { message: ciphertext.error };
        return { header: header.buf, ciphertext: ciphertext.buf, signature: signature.buf };
    }

    const b64 = buf => buf.toString('base64');

    /**
     * POST /api/messages/encrypted
     *
     * Отправка зашифрованного сообщения. Сервер не видит содержимого: он
     * проверяет, что конверты адресованы участникам чата, складывает их и
     * рассылает каждому устройству то, что ему адресовано.
     *
     * Два режима:
     *   - попарный (envelopes): конверт с содержимым на каждое устройство;
     *   - групповой (group + keyEnvelopes): один шифротекст на всех, и конверты
     *     с sender key только тем устройствам, у которых его ещё нет. Только
     *     для комнат.
     *
     * Открытый путь POST /api/messages оставлен рядом для чата с ботом и чатов,
     * где пока не для кого шифровать.
     */
    /** Срок жизни из запроса: null — не задан, false — недопустим. */
    // Срок жизни нового сообщения: свой, если его прислали, иначе — срок
    // чата. Возвращает момент исчезновения или null.
    async function applyExpiry(messageId, chatId, expiry) {
        const seconds = expiry || (await ctx.disappearingMessagesManager.getChatSettings(chatId))?.default_message_expiry;
        return seconds ? ctx.disappearingMessagesManager.setMessageExpiry(messageId, seconds, false) : null;
    }

    function expiryFrom(value) {
        if (value === undefined || value === null || value === '' || Number(value) === 0) return null;
        return normalizeExpiry(value) ?? false;
    }

    /**
     * Проверить, на что отвечает сообщение. Ответить можно только на живое
     * сообщение этой же переписки: история отдаёт вместе с ответом текст
     * цитаты, и чужой id открывал бы текст из чужого чата.
     */
    async function replyTargetFor(chat, replyToId) {
        if (replyToId === undefined || replyToId === null || replyToId === '') return { id: null };
        const id = Number(replyToId);
        if (!Number.isSafeInteger(id) || id <= 0) return { error: 'Некорректный ответ' };
        const target = chat.room_id
            ? await dbGet('SELECT id FROM messages WHERE id = $1 AND room_id = $2 AND deleted = 0', [id, chat.room_id])
            : await dbGet('SELECT id FROM messages WHERE id = $1 AND chat_id = $2 AND room_id IS NULL AND deleted = 0', [id, chat.id]);
        return target ? { id } : { error: 'Сообщение, на которое вы отвечаете, не найдено' };
    }

    app.post('/api/messages/encrypted', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        if (!req.session.deviceId) {
            return res.status(409).json({ success: false, message: 'Устройство не зарегистрировано' });
        }

        const {
            chatId, replyToId, expirySeconds, envelopes = [], keyEnvelopes = [], group = null, blobIds = [],
        } = req.body || {};

        if (!Array.isArray(blobIds) || blobIds.length > MAX_BLOBS_PER_MESSAGE
            || !blobIds.every(id => typeof id === 'string' && BLOB_ID_RE.test(id))) {
            return res.status(400).json({ success: false, message: 'Некорректный список вложений' });
        }

        if (!Array.isArray(envelopes) || !Array.isArray(keyEnvelopes)) {
            return res.status(400).json({ success: false, message: 'Конверты должны быть массивом' });
        }
        // Содержимое идёт либо попарно, либо одним групповым шифротекстом. Оба
        // сразу означали бы, что разные устройства прочтут разное.
        if (group ? envelopes.length > 0 : envelopes.length === 0) {
            return res.status(400).json({ success: false, message: group
                ? 'Групповое сообщение не несёт попарных конвертов'
                : 'Нет конвертов' });
        }
        if (!group && keyEnvelopes.length > 0) {
            return res.status(400).json({ success: false, message: 'Раздача ключа — только с групповым сообщением' });
        }
        if (envelopes.length > MAX_ENVELOPES || keyEnvelopes.length > MAX_ENVELOPES) {
            return res.status(400).json({ success: false, message: `Не больше ${MAX_ENVELOPES} конвертов` });
        }
        const groupPayload = group ? parseGroupPayload(group) : null;
        if (groupPayload && groupPayload.message) {
            return res.status(400).json({ success: false, message: groupPayload.message });
        }

        try {
            const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) return res.status(404).json({ success: false, message: 'Чат не найден' });

            if (groupPayload && !chat.room_id) {
                return res.status(400).json({ success: false, message: 'Групповое шифрование — только для комнат' });
            }
            const reply = await replyTargetFor(chat, replyToId);
            if (reply.error) return res.status(400).json({ success: false, message: reply.error });
            const replyTo = reply.id;
            const expiry = expiryFrom(expirySeconds);
            if (expiry === false) return res.status(400).json({ success: false, message: 'Недопустимый срок жизни сообщения' });

            const senderDeviceId = req.session.deviceId;
            const allowed = await ctx.resolveEnvelopeRecipients(chat);
            const allowedIds = new Set(allowed.map(d => d.id));

            // Разбор и проверка до единой записи в БД: половина вставленных
            // конвертов хуже отказа — сообщение прочитается у части устройств.
            const content = parseEnvelopeList(envelopes, allowedIds, 'envelopes');
            if (content.status) return res.status(content.status).json({ success: false, message: content.message });
            const keys = parseEnvelopeList(keyEnvelopes, allowedIds, 'keyEnvelopes');
            if (keys.status) return res.status(keys.status).json({ success: false, message: keys.message });
            const parsed = content.parsed;
            const seen = content.seen;

            // Привязать можно только своё, ещё не отправленное вложение из этого
            // же чата. Иначе можно было бы «переотправить» чужой файл в другой
            // чат и открыть к нему доступ его участникам.
            if (blobIds.length > 0) {
                const owned = await dbAll(
                    `SELECT id FROM encrypted_blobs
                     WHERE id = ANY($1::text[]) AND uploader_user_id = $2 AND chat_id = $3 AND message_id IS NULL`,
                    [blobIds, req.session.userId, chat.id]
                );
                if (owned.length !== new Set(blobIds).size) {
                    return res.status(403).json({ success: false, message: 'Вложение не найдено или уже отправлено' });
                }
            }

            const time = getCurrentTime();
            const roomId = chat.room_id || null;
            const socketRoomKey = getSocketRoomKey(chatId, roomId);

            const client = await pool.connect();
            let messageId;
            let createdAt;
            try {
                await client.query('BEGIN');
                const inserted = await client.query(
                    `INSERT INTO messages (chat_id, room_id, user_id, text, message_type, sent, time, status, reply_to_id, encrypted, sender_device_id)
                     VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, $8, TRUE, $9) RETURNING id, created_at`,
                    [chatId, roomId, req.session.userId, 'text', 1, time, 'sent', replyTo, senderDeviceId]
                );
                messageId = inserted.rows[0].id;
                createdAt = inserted.rows[0].created_at;
                if (blobIds.length > 0) {
                    const linked = await client.query(
                        'UPDATE encrypted_blobs SET message_id = $1 WHERE id = ANY($2::text[]) AND message_id IS NULL',
                        [messageId, blobIds]
                    );
                    // Проверка выше была до транзакции: параллельный запрос мог
                    // успеть привязать то же вложение. Тогда это сообщение
                    // ссылалось бы на файл, доступ к которому решает чужое.
                    if (linked.rowCount !== new Set(blobIds).size) {
                        const conflict = new Error('вложение уже привязано');
                        conflict.status = 409;
                        throw conflict;
                    }
                }
                for (const e of parsed) {
                    await client.query(
                        `INSERT INTO message_envelopes (message_id, recipient_device_id, sender_device_id, envelope_type, header, ciphertext)
                         VALUES ($1, $2, $3, $4, $5, $6)`,
                        [messageId, e.deviceId, senderDeviceId, e.type, e.header, e.ciphertext]
                    );
                }
                if (groupPayload) {
                    await client.query(
                        'INSERT INTO message_group_payloads (message_id, header, ciphertext, signature) VALUES ($1, $2, $3, $4)',
                        [messageId, groupPayload.header, groupPayload.ciphertext, groupPayload.signature]
                    );
                }
                for (const e of keys.parsed) {
                    const row = await client.query(
                        `INSERT INTO sender_key_envelopes
                            (room_id, sender_user_id, sender_device_id, recipient_device_id, envelope_type, header, ciphertext)
                         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                        [chat.room_id, req.session.userId, senderDeviceId, e.deviceId, e.type, e.header, e.ciphertext]
                    );
                    e.id = Number(row.rows[0].id);
                }
                await client.query('COMMIT');
            } catch (err) {
                await client.query('ROLLBACK');
                throw err;
            } finally {
                client.release();
            }

            const expiresAt = await applyExpiry(messageId, chatId, expiry);

            const sender = await dbGet('SELECT username, avatar FROM users WHERE id = $1', [req.session.userId]);
            const base = {
                id: messageId,
                chat_id: Number(chatId),
                room_id: roomId,
                user_id: req.session.userId,
                sender_username: sender ? sender.username : '',
                sender_avatar: sender ? sender.avatar || '' : '',
                sender_device_id: senderDeviceId,
                encrypted: true,
                text: null,
                message_type: 'text',
                reply_to_id: replyTo,
                sent: true,
                time,
                created_at: createdAt,
                expires_at: expiresAt,
                status: 'sent',
            };

            if (groupPayload) {
                // Групповой шифротекст — всем устройствам комнаты, кроме
                // отправляющего (оно дорисует сообщение само). Конверт с ключом —
                // только тем, кому он предназначен.
                const groupOut = {
                    header: b64(groupPayload.header),
                    ciphertext: b64(groupPayload.ciphertext),
                    signature: b64(groupPayload.signature),
                };
                const keyByDevice = new Map(keys.parsed.map(e => [e.deviceId, {
                    id: e.id,
                    room_id: roomId,
                    sender_device_id: senderDeviceId,
                    envelope_type: e.type,
                    header: b64(e.header),
                    ciphertext: b64(e.ciphertext),
                }]));
                for (const d of allowed) {
                    if (d.id === senderDeviceId) continue;
                    io.to(`device:${d.id}`).emit('newMessage', {
                        ...base,
                        envelope: null,
                        group: groupOut,
                        keyEnvelope: keyByDevice.get(d.id) || null,
                    });
                }
            } else {
                // Каждому устройству — только его конверт. Общий broadcast тут не
                // годится: конверты разные, и отдать устройству чужой означало бы
                // рассылать шифротекст, который оно всё равно не прочитает.
                for (const e of parsed) {
                    io.to(`device:${e.deviceId}`).emit('newMessage', {
                        ...base,
                        envelope: {
                            envelope_type: e.type,
                            header: b64(e.header),
                            ciphertext: b64(e.ciphertext),
                        },
                    });
                }
            }

            res.json({
                success: true,
                message: base,
                // Устройства чата, для которых конверта не прислали: клиент
                // должен увидеть это и добрать их ключи, иначе там сообщение
                // не прочитается. У группового сообщения конверта нет почти ни у
                // кого (ключ у них уже есть), и кто его прочтёт, знает только
                // отправитель.
                missingDeviceIds: groupPayload ? [] : allowed.filter(d => !seen.has(d.id)).map(d => d.id),
                socketRoomKey,
            });
        } catch (error) {
            if (error.status === 409) {
                return res.status(409).json({ success: false, message: 'Вложение уже отправлено' });
            }
            log.error({ err: error }, 'Encrypted message error');
            res.status(500).json({ success: false, message: 'Не удалось отправить сообщение' });
        }
    });

    /**
     * POST /api/sender-keys/ack — устройство забрало конверты с sender key.
     * Удалять можно только адресованное этому устройству.
     */
    app.post('/api/sender-keys/ack', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        if (!req.session.deviceId) return res.status(409).json({ success: false, message: 'Устройство не зарегистрировано' });
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number) : [];
        if (ids.length === 0 || ids.length > MAX_ENVELOPES || !ids.every(id => Number.isInteger(id) && id > 0)) {
            return res.status(400).json({ success: false, message: 'Некорректный список конвертов' });
        }
        try {
            const result = await pool.query(
                'DELETE FROM sender_key_envelopes WHERE id = ANY($1::bigint[]) AND recipient_device_id = $2',
                [ids, req.session.deviceId]
            );
            res.json({ success: true, deleted: result.rowCount });
        } catch (error) {
            log.error({ err: error }, 'Sender key ack error');
            res.status(500).json({ success: false, message: 'Не удалось подтвердить получение ключей' });
        }
    });

    const HISTORY_PAGE = 50;

    const HISTORY_PAGE_MAX = 200;

    const EXISTING_CHECK_MAX = 1000;

    /*
     * Какие из этих сообщений чата ещё есть. Клиент хранит расшифрованный
     * текст всех сообщений, что видел, а история теперь приходит страницами:
     * по одной странице не понять, удалено ли сообщение постарше или просто
     * не загружено. Клиент спрашивает про такие id и стирает у себя те,
     * которых больше нет.
     */
    app.post('/api/messages/:chatId/existing', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : null;
        if (!ids || ids.length > EXISTING_CHECK_MAX || !ids.every(id => Number.isInteger(id) && id > 0 && id <= 2147483647)) {
            return res.status(400).json({ success: false, message: `Нужен список id, не больше ${EXISTING_CHECK_MAX}` });
        }
        try {
            const chat = await dbGet('SELECT id, room_id FROM chats WHERE id = $1 AND user_id = $2', [req.params.chatId, req.session.userId]);
            if (!chat) return res.status(404).json({ success: false, message: 'Чат не найден' });
            const rows = await dbAll(chat.room_id
                ? 'SELECT id FROM messages WHERE id = ANY($1::int[]) AND room_id = $2 AND deleted = 0'
                : 'SELECT id FROM messages WHERE id = ANY($1::int[]) AND chat_id = $2 AND room_id IS NULL AND deleted = 0',
            [ids, chat.room_id || chat.id]);
            res.json({ success: true, ids: rows.map(r => r.id) });
        } catch (error) {
            log.error({ err: error }, 'Existing messages error');
            res.status(500).json({ success: false, message: 'Ошибка проверки сообщений' });
        }
    });

    app.get('/api/messages/:chatId', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const chatId = req.params.chatId;
        // История страницами, от новых к старым: before — id самого старого из
        // уже показанных. Без before — последние limit сообщений.
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || HISTORY_PAGE, 1), HISTORY_PAGE_MAX);
        const before = req.query.before === undefined ? null : Number(req.query.before);
        if (before !== null && !(Number.isInteger(before) && before > 0)) {
            return res.status(400).json({ success: false, message: 'Некорректный before' });
        }
        try {
            const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) return res.json({ success: false, message: 'Чат не найден' });

            const selectParam = chat.room_id || chatId;
            const selectQuery = chat.room_id
                ? `SELECT m.*, u.username as sender_username, u.avatar as sender_avatar, ex.expires_at,
                          rt.id as reply_to_id, rt.text as reply_to_text, rt.deleted as reply_to_deleted, ru.username as reply_to_sender_username, ru.avatar as reply_to_sender_avatar
                   FROM messages m
                   LEFT JOIN users u ON m.user_id = u.id
                   LEFT JOIN message_expiry ex ON ex.message_id = m.id
                   LEFT JOIN messages rt ON m.reply_to_id = rt.id AND rt.room_id = m.room_id
                   LEFT JOIN users ru ON rt.user_id = ru.id
                   WHERE m.room_id = $1 AND m.deleted = 0 AND ($2::int IS NULL OR m.id < $2)
                   ORDER BY m.id DESC
                   LIMIT $3`
                : `SELECT m.*, u.username as sender_username, u.avatar as sender_avatar, ex.expires_at,
                          rt.id as reply_to_id, rt.text as reply_to_text, rt.deleted as reply_to_deleted, ru.username as reply_to_sender_username, ru.avatar as reply_to_sender_avatar
                   FROM messages m
                   LEFT JOIN users u ON m.user_id = u.id
                   LEFT JOIN message_expiry ex ON ex.message_id = m.id
                   LEFT JOIN messages rt ON m.reply_to_id = rt.id AND rt.chat_id = m.chat_id AND rt.room_id IS NULL
                   LEFT JOIN users ru ON rt.user_id = ru.id
                   WHERE m.chat_id = $1 AND m.deleted = 0 AND ($2::int IS NULL OR m.id < $2)
                   ORDER BY m.id DESC
                   LIMIT $3`;

            // На одно больше: так видно, есть ли что-то ещё раньше.
            let messages = await dbAll(selectQuery, [selectParam, before, limit + 1]);
            const hasMore = messages.length > limit;
            messages = messages.slice(0, limit).reverse();

            // Прочитанным чат отмечает клиент (POST /api/chats/:id/read), когда
            // конец переписки у него на экране, — открыть историю ещё не
            // значит прочитать. Статусы своих сообщений — по отметкам
            // собеседников (lib/read-state.js). С ботом отвечает сервер —
            // значит, прочитано.
            const receipts = chat.room_id ? await receiptsFor(chat.room_id, req.session.userId)
                : chat.is_bot ? { read: 2147483647, delivered: 2147483647 } : null;

            // Срок исчезающих сообщений чата — вместе с первой страницей.
            const expirySeconds = before === null
                ? (await ctx.disappearingMessagesManager.getChatSettings(chat.id))?.default_message_expiry || null
                : undefined;

            if (messages.length === 0) {
                return res.json({ success: true, messages: [], hasMore: false, chat, expirySeconds });
            }

            const messageIds = messages.map(m => m.id);
            const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(',');
            const reactions = await dbAll(
                `SELECT message_id, STRING_AGG(DISTINCT emoji, ',') as emojis FROM reactions WHERE message_id IN (${placeholders}) GROUP BY message_id`,
                messageIds
            );

            const reactionsMap = {};
            reactions.forEach(r => { reactionsMap[r.message_id] = r.emojis.split(','); });

            // Конверты — только адресованные ЭТОМУ устройству. Чужие сервер
            // отдавать не должен: прочитать их устройство всё равно не может,
            // а отдача чужого шифротекста — лишняя утечка без пользы.
            const envelopeMap = {};
            if (req.session.deviceId) {
                const encryptedIds = messages.filter(m => m.encrypted).map(m => m.id);
                if (encryptedIds.length > 0) {
                    const envPlaceholders = encryptedIds.map((_, i) => `$${i + 2}`).join(',');
                    const envelopes = await dbAll(
                        `SELECT message_id, envelope_type, header, ciphertext, sender_device_id
                         FROM message_envelopes
                         WHERE recipient_device_id = $1 AND message_id IN (${envPlaceholders})`,
                        [req.session.deviceId, ...encryptedIds]
                    );
                    envelopes.forEach(e => {
                        envelopeMap[e.message_id] = {
                            envelope_type: e.envelope_type,
                            header: e.header.toString('base64'),
                            ciphertext: e.ciphertext.toString('base64'),
                            sender_device_id: e.sender_device_id,
                        };
                    });
                }
            }

            // Групповой шифротекст одинаков для всех устройств комнаты.
            const groupMap = {};
            const encryptedMessageIds = messages.filter(m => m.encrypted).map(m => m.id);
            if (encryptedMessageIds.length > 0) {
                const payloads = await dbAll(
                    'SELECT message_id, header, ciphertext, signature FROM message_group_payloads WHERE message_id = ANY($1::int[])',
                    [encryptedMessageIds]
                );
                payloads.forEach(p => {
                    groupMap[p.message_id] = { header: b64(p.header), ciphertext: b64(p.ciphertext), signature: b64(p.signature) };
                });
            }

            // Ещё не забранные этим устройством sender keys этой комнаты. Клиент
            // обрабатывает их ДО сообщений: без ключа групповые не расшифровать.
            let keyEnvelopes = [];
            if (req.session.deviceId && chat.room_id) {
                keyEnvelopes = (await dbAll(
                    `SELECT id, sender_user_id, sender_device_id, envelope_type, header, ciphertext
                     FROM sender_key_envelopes
                     WHERE recipient_device_id = $1 AND room_id = $2
                     ORDER BY id ASC`,
                    [req.session.deviceId, chat.room_id]
                )).map(e => ({
                    id: Number(e.id),
                    room_id: chat.room_id,
                    sender_user_id: e.sender_user_id,
                    sender_device_id: e.sender_device_id,
                    envelope_type: e.envelope_type,
                    header: b64(e.header),
                    ciphertext: b64(e.ciphertext),
                }));
            }

            messages = messages.map(m => ({
                ...m,
                status: statusFor(m.id, receipts),
                reactions: reactionsMap[m.id] || [],
                group: m.encrypted ? (groupMap[m.id] || null) : undefined,
                // Для зашифрованного сообщения без конверта клиент обязан
                // показать заглушку, а не пустое сообщение: это либо устройство
                // подключили после отправки (историю оно не получает), либо
                // отправитель не прислал конверт для него.
                envelope: m.encrypted ? (envelopeMap[m.id] || null) : undefined,
                reply_to: m.reply_to_id ? { id: m.reply_to_id, text: m.reply_to_text, deleted: Number(m.reply_to_deleted) === 1, sender_username: m.reply_to_sender_username, sender_avatar: m.reply_to_sender_avatar } : null
            }));

            res.json({ success: true, messages, hasMore, chat, keyEnvelopes, expirySeconds });
        } catch (error) {
            log.error({ err: error }, 'Get messages error');
            res.status(500).json({ success: false, message: 'Ошибка загрузки сообщений' });
        }
    });

    app.post('/api/messages', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const { chatId, text, replyToId, expirySeconds } = req.body;
        if (!text || text.trim() === '' || !chatId) return res.json({ success: false, message: 'Введите текст сообщения' });
        if (text.length > 4000) return res.json({ success: false, message: 'Сообщение не может быть длиннее 4000 символов' });

        try {
            const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) return res.json({ success: false, message: 'Чат не найден' });
            const reply = await replyTargetFor(chat, replyToId);
            if (reply.error) return res.json({ success: false, message: reply.error });
            const replyTo = reply.id;
            const expiry = expiryFrom(expirySeconds);
            if (expiry === false) return res.json({ success: false, message: 'Недопустимый срок жизни сообщения' });

            const time = getCurrentTime();
            const roomId = chat.room_id || null;
            const socketRoomKey = getSocketRoomKey(chatId, roomId);

            // Очистка текста от опасных метаданных
            const safeText = sanitizeText(text.trim());

            const result = await pool.query(
                'INSERT INTO messages (chat_id, room_id, user_id, text, message_type, sent, time, status, reply_to_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
                [chatId, roomId, req.session.userId, safeText, 'text', 1, time, 'sent', replyTo]
            );
            const messageId = result.rows[0].id;

            const expiresAt = await applyExpiry(messageId, chatId, expiry);

            const fullMessage = await dbGet(
                'SELECT m.*, u.username, u.avatar as user_avatar FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = $1',
                [messageId]
            );

            const messageForSocket = {
                ...fullMessage, sender_username: fullMessage.username, sender_avatar: fullMessage.user_avatar, expires_at: expiresAt,
                // Бот читает сразу; в остальных чатах статус сдвинут отметки.
                status: chat.is_bot ? 'read' : 'sent',
            };
            io.to(socketRoomKey).emit('newMessage', messageForSocket);
            res.json({ success: true, message: messageForSocket });

            if (chat.is_bot) {
                const botUserId = req.session.userId;
                setTimeout(async () => {
                    const stillExists = await dbGet(
                        'SELECT id FROM chats WHERE id = $1 AND user_id = $2 AND is_bot = 1',
                        [chatId, botUserId]
                    );
                    if (!stillExists) return;

                    const botResponses = ['Интересный вопрос! Расскажите подробнее.', 'Я получил ваше сообщение!', 'Хмм, дайте подумать...', 'Отличное сообщение! Продолжайте.', 'Я бот, но стараюсь быть полезным!', 'Можете уточнить, что именно вас интересует?'];
                    const randomResponse = botResponses[Math.floor(Math.random() * botResponses.length)];
                    const botTime = getCurrentTime();
                    try {
                        const botResult = await pool.query(
                            'INSERT INTO messages (chat_id, room_id, user_id, text, sent, time, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
                            [chatId, roomId, botUserId, randomResponse, 0, botTime, 'read']
                        );
                        const botMessageId = botResult.rows[0].id;
                        const botMessage = await dbGet(
                            'SELECT m.*, u.username, u.avatar as user_avatar FROM messages m JOIN users u ON m.user_id = u.id WHERE m.id = $1',
                            [botMessageId]
                        );
                        if (botMessage) {
                            io.to(socketRoomKey).emit('newMessage', { ...botMessage, sender_username: botMessage.username, sender_avatar: botMessage.user_avatar });
                        }
                    } catch (e) { log.error({ err: e }, 'Bot error'); }
                }, 1500);
            }
        } catch (error) {
            log.error({ err: error }, 'Send message error');
            res.status(500).json({ success: false, message: 'Ошибка отправки' });
        }
    });

    app.put('/api/messages/:messageId', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const { messageId } = req.params;
        const { text } = req.body;
        if (!text || text.trim() === '') return res.json({ success: false, message: 'Текст не может быть пустым' });
        if (text.length > 4000) return res.json({ success: false, message: 'Сообщение не может быть длиннее 4000 символов' });

        try {
            // sent = 0 — не реплика пользователя: ответ бота или системное «вошёл в
            // чат», где автором записан вошедший. Иначе он мог бы стереть или
            // переписать строку о своём входе.
            const message = await dbGet('SELECT * FROM messages WHERE id = $1 AND user_id = $2 AND sent <> 0', [messageId, req.session.userId]);
            if (!message) return res.json({ success: false, message: 'Сообщение не найдено' });
            // Правка шла бы открытым текстом: этот эндпоинт кладёт новый текст в
            // messages.text и рассылает его всем. Для зашифрованного сообщения
            // это означало бы выложить на сервер то, что было зашифровано.
            if (message.encrypted) {
                return res.status(409).json({ success: false, message: 'Зашифрованные сообщения нельзя редактировать' });
            }
            const editedAt = new Date().toISOString();
            const trimmedText = text.trim();
            await dbRun('UPDATE messages SET text = $1, edited_at = $2 WHERE id = $3', [trimmedText, editedAt, messageId]);

            // Раньше правки не рассылались по сокету — у остальных участников
            // комнаты изменение не появлялось без перезагрузки (см. "Мелочи").
            const socketRoomKey = getSocketRoomKey(message.chat_id, message.room_id);
            io.to(socketRoomKey).emit('messageEdited', {
                id: Number(messageId), text: trimmedText, edited_at: editedAt,
                chat_id: message.chat_id, room_id: message.room_id
            });

            res.json({ success: true, edited_at: editedAt });
        } catch (error) {
            log.error({ err: error }, 'Edit message error');
            res.status(500).json({ success: false, message: 'Ошибка редактирования' });
        }
    });

    app.delete('/api/messages/:messageId', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const { messageId } = req.params;
        try {
            // sent = 0 — не реплика пользователя: ответ бота или системное «вошёл в
            // чат», где автором записан вошедший. Иначе он мог бы стереть или
            // переписать строку о своём входе.
            const message = await dbGet('SELECT * FROM messages WHERE id = $1 AND user_id = $2 AND sent <> 0', [messageId, req.session.userId]);
            if (!message) return res.json({ success: false, message: 'Сообщение не найдено' });
            await dbRun('UPDATE messages SET deleted = 1 WHERE id = $1', [messageId]);
            await purgeMessageContent(message.id);

            const socketRoomKey = getSocketRoomKey(message.chat_id, message.room_id);
            io.to(socketRoomKey).emit('messageDeleted', {
                id: Number(messageId), chat_id: message.chat_id, room_id: message.room_id
            });

            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Delete message error');
            res.status(500).json({ success: false, message: 'Ошибка удаления' });
        }
    });

    async function userCanAccessMessage(userId, messageId) {
        // LEFT JOIN, не INNER JOIN (см. п.3 аудита): если автор сообщения вышел
        // из групповой комнаты, его персональная строка в chats удаляется и
        // m.chat_id уходит в NULL (ON DELETE SET NULL). INNER JOIN на chats
        // тогда терял строку сообщения целиком, и функция возвращала false для
        // абсолютно любого пользователя — файл переставал открываться вообще
        // всем, включая оставшихся участников комнаты. m.room_id при этом всегда
        // записан прямо на сообщении в момент отправки (см. /api/messages,
        // /api/messages/file) и не зависит от того, жива ли ещё запись chats
        // автора, поэтому для групповых чатов JOIN для доступа не обязателен.
        const row = await dbGet(
            `SELECT m.room_id, c.room_id AS chat_room_id, c.user_id AS chat_owner_id
             FROM messages m
             LEFT JOIN chats c ON m.chat_id = c.id
             WHERE m.id = $1`,
            [messageId]
        );
        if (!row) return false;
        const roomId = row.room_id || row.chat_room_id;
        if (!roomId) {
            // Не групповой (1:1) чат — доступ только у владельца самой записи
            // chats. Если chat_id уже NULL, значит запись chats удалена вместе
            // со всем DM-чатом (см. DELETE /api/chats/:chatId, ветка без
            // room_id — там messages удаляются явно перед чатом), и доступа ни
            // у кого больше нет.
            return row.chat_owner_id != null && row.chat_owner_id === userId;
        }
        const participant = await dbGet(
            'SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2',
            [roomId, userId]
        );
        return Boolean(participant);
    }

    // Файлы отдаются только тому, кто реально является участником чата/комнаты,
    // к которому относится сообщение с этим файлом — а не просто "залогинен ли
    // кто-то вообще" (см. п.1 аудита). Имя файла уникально (Date.now() + random),
    // поэтому джойн messages.file_url -> chats/room_participants однозначно
    // определяет владельца.
    // В UI предлагается фиксированный набор из 5 эмодзи для реакций. Раньше на
    // бэке проверялась только длина строки (≤10 символов), а не содержимое — это
    // пропускало вход в message.reactions, который на фронте рендерится в
    // innerHTML без escapeHtml (см. п.3 аудита). Теперь бэк принимает только
    // эмодзи из этого списка.
    const ALLOWED_REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😢', '🔥']);

    app.post('/api/reactions', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const { messageId, emoji } = req.body;
        if (!messageId || !emoji) return res.json({ success: false, message: 'Параметры отсутствуют' });
        if (typeof emoji !== 'string' || !ALLOWED_REACTION_EMOJIS.has(emoji)) return res.json({ success: false, message: 'Недопустимый emoji' });

        try {
            if (!(await userCanAccessMessage(req.session.userId, messageId))) {
                return res.json({ success: false, message: 'Сообщение недоступно' });
            }
            await pool.query('INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [messageId, req.session.userId, emoji]);
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Add reaction error');
            res.status(500).json({ success: false, message: 'Ошибка добавления реакции' });
        }
    });

    app.delete('/api/reactions/:messageId/:emoji', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const messageId = Number(req.params.messageId);
        const emoji = decodeURIComponent(req.params.emoji);
        if (!Number.isFinite(messageId) || !ALLOWED_REACTION_EMOJIS.has(emoji)) {
            return res.json({ success: false, message: 'Недопустимые параметры' });
        }

        try {
            if (!(await userCanAccessMessage(req.session.userId, messageId))) {
                return res.json({ success: false, message: 'Сообщение недоступно' });
            }
            await dbRun(
                'DELETE FROM reactions WHERE message_id = $1 AND user_id = $2 AND emoji = $3',
                [messageId, req.session.userId, emoji]
            );
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Remove reaction error');
            res.status(500).json({ success: false, message: 'Ошибка удаления реакции' });
        }
    });

    // API для disappearing messages
    app.post('/api/messages/:messageId/set-expiry', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const messageId = Number(req.params.messageId);
        const { expirySeconds, autoDeleteOnRead } = req.body;

        if (!Number.isFinite(messageId) || normalizeExpiry(expirySeconds) === null) {
            return res.json({ success: false, message: 'Неверные параметры' });
        }

        try {
            // Проверка доступа к сообщению
            const message = await dbGet('SELECT user_id, sent FROM messages WHERE id = $1', [messageId]);
            // Системному «вошёл в чат» срок не поставить: исчезнув, оно скрыло
            // бы вход (см. PUT и DELETE сообщения).
            if (!message || message.user_id !== req.session.userId || Number(message.sent) === 0) {
                return res.json({ success: false, message: 'Сообщение не найдено или нет доступа' });
            }

            await ctx.disappearingMessagesManager.setMessageExpiry(
                messageId,
                expirySeconds,
                autoDeleteOnRead || false
            );

            res.json({ success: true, message: 'Таймер самоуничтожения установлен' });
        } catch (error) {
            log.error({ err: error }, 'Set expiry error');
            res.status(500).json({ success: false, message: 'Ошибка установки таймера' });
        }
    });

    return { userCanAccessMessage };
};
