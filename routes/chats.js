'use strict';

// Чаты: список, создание, приглашения, вход по коду, выход, поиск и настройки.

const { log } = require('../lib/log');
const { pool, dbGet, dbAll, dbRun } = require('../lib/db');
const { normalizeExpiry, expiryLabel } = require('../lib/disappearing-messages');
const { joinLimiter } = require('../lib/rate-limits');
const { getCurrentTime, generateInviteCodeAsync } = require('../lib/helpers');


module.exports = function registerChatRoutes(app, ctx) {
    const { io } = ctx;

    app.get('/api/chats', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        try {
            const chats = await dbAll(`
                SELECT c.id, c.name, c.avatar, c.online, c.is_bot, c.room_id, r.code as invite_code,
                       (SELECT text FROM messages WHERE ((c.room_id IS NOT NULL AND room_id = c.room_id) OR (c.room_id IS NULL AND chat_id = c.id)) AND deleted = 0 ORDER BY id DESC LIMIT 1) as last_message,
                       (SELECT created_at FROM messages WHERE ((c.room_id IS NOT NULL AND room_id = c.room_id) OR (c.room_id IS NULL AND chat_id = c.id)) AND deleted = 0 ORDER BY id DESC LIMIT 1) as last_at,
                       (SELECT COUNT(*) FROM messages m WHERE ((c.room_id IS NOT NULL AND m.room_id = c.room_id) OR (c.room_id IS NULL AND m.chat_id = c.id)) AND m.sent = 0 AND m.status != 'read') as unread
                FROM chats c
                LEFT JOIN rooms r ON c.room_id = r.id
                WHERE c.user_id = $1
                ORDER BY (SELECT MAX(id) FROM messages WHERE ((c.room_id IS NOT NULL AND room_id = c.room_id) OR (c.room_id IS NULL AND chat_id = c.id))) DESC NULLS LAST
            `, [req.session.userId]);
            res.json({ success: true, chats: chats.map(c => ({ ...c, unread: Number(c.unread) })) });
        } catch (error) {
            log.error({ err: error }, 'Get chats error');
            res.status(500).json({ success: false, message: 'Ошибка загрузки чатов' });
        }
    });

    /**
     * Устройства, которым нужен конверт этого сообщения.
     *
     * Включает ВСЕ устройства участников, в том числе устройство отправителя.
     * Клиент сам себе конверт не шлёт (своё он хранит локально), но запрещать
     * это серверу незачем: это всё ещё устройство участника.
     *
     * Для комнаты это все участники, для обычного чата — только владелец: у
     * групповых чатов участники лежат в room_participants, а одиночная запись
     * chats без room_id принадлежит одному человеку.
     *
     * Чат с ботом не шифруется вовсе: бот отвечает на открытый текст. Если бы
     * здесь вернулись устройства владельца, то при двух устройствах сообщения
     * боту уходили бы зашифрованными — бот бы молчал, а индикатор в шапке
     * говорил бы «без шифрования».
     */
    async function resolveEnvelopeRecipients(chat) {
        if (chat.is_bot) return [];
        const rows = chat.room_id
            ? await dbAll(
                `SELECT d.id, d.user_id FROM devices d
                 JOIN room_participants rp ON rp.user_id = d.user_id
                 WHERE rp.room_id = $1 AND d.revoked_at IS NULL
                 ORDER BY d.id ASC`,
                [chat.room_id]
            )
            : await dbAll(
                'SELECT id, user_id FROM devices WHERE user_id = $1 AND revoked_at IS NULL ORDER BY id ASC',
                [chat.user_id]
            );
        return rows;
    }

    /**
     * GET /api/chats/:chatId/devices
     *
     * Отправителю нужно знать, для скольких устройств шифровать. Сам он этого
     * знать не может: состав чата и список устройств живут на сервере.
     *
     * Отдаются только id — ключей здесь нет, за ними клиент идёт в
     * /api/keys/bundle/:userId. Разделение не косметическое: bundle расходует
     * одноразовый prekey, и запрашивать его ради простого пересчёта устройств
     * было бы расточительно.
     */
    app.get('/api/chats/:chatId/devices', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        try {
            const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2',
                [req.params.chatId, req.session.userId]);
            if (!chat) return res.status(404).json({ success: false, message: 'Чат не найден' });
            const devices = await resolveEnvelopeRecipients(chat);
            // Имена участников — для окна сверки ключей: код безопасности
            // строится на каждого собеседника, и подписать его нужно по-человечески.
            const userIds = [...new Set(devices.map(d => d.user_id))];
            const users = userIds.length
                ? await dbAll('SELECT id, username FROM users WHERE id = ANY($1::int[])', [userIds])
                : [];
            res.json({
                success: true,
                // room_id нужен клиенту для sender keys: у каждого участника своя
                // запись chats с другим id, а групповой ключ один на комнату.
                room_id: chat.room_id || null,
                devices: devices.map(d => ({ device_id: d.id, user_id: d.user_id })),
                users: users.map(u => ({ user_id: u.id, username: u.username })),
            });
        } catch (error) {
            log.error({ err: error }, 'Chat devices error');
            res.status(500).json({ success: false, message: 'Не удалось получить устройства чата' });
        }
    });

    /* ------------------------------------------------------------------
       Зашифрованные вложения
       ------------------------------------------------------------------ */

    app.post('/api/chats', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const { name } = req.body;
        if (!name) return res.json({ success: false, message: 'Введите имя чата' });
        if (name.length > 64) return res.json({ success: false, message: 'Название чата не может быть длиннее 64 символов' });

        const avatar = name.charAt(0).toUpperCase();
        try {
            const roomCode = await generateInviteCodeAsync();
            const client = await pool.connect();
            let roomId, chatId;
            try {
                await client.query('BEGIN');
                const roomResult = await client.query('INSERT INTO rooms (name, code) VALUES ($1, $2) RETURNING id', [name, roomCode]);
                roomId = roomResult.rows[0].id;
                await client.query('INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2)', [roomId, req.session.userId]);
                const chatResult = await client.query(
                    'INSERT INTO chats (user_id, room_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                    [req.session.userId, roomId, name, avatar, 0, 0]
                );
                chatId = chatResult.rows[0].id;
                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            } finally {
                client.release();
            }
            res.json({ success: true, chat: { id: chatId, name, avatar, online: 0, is_bot: 0, room_id: roomId, invite_code: roomCode } });
        } catch (error) {
            log.error({ err: error }, 'Create chat error');
            res.status(500).json({ success: false, message: 'Ошибка создания чата' });
        }
    });

    /**
     * Системное сообщение в комнате: кто вошёл, кто вышел, кто сменил код.
     * Раньше человек с кодом входил молча, и участники не знали, что их
     * читает ещё кто-то: его устройства получали ключи автоматически.
     * Шифровать тут нечего — сервер эти события и так знает.
     */
    //
    // Автора у него нет (user_id — NULL): имя — в самом тексте. Раньше автором
    // записывался тот, о ком строка, и она пропадала вместе с его сообщениями —
    // анонимный аккаунт, удаляясь, уходил из чата без следа.
    async function postSystemMessage({ roomId, chatId, text }) {
        const inserted = await pool.query(
            `INSERT INTO messages (chat_id, room_id, user_id, text, message_type, sent, time, status)
             VALUES ($1, $2, NULL, $3, 'system', 0, $4, 'read') RETURNING *`,
            [chatId, roomId, text, getCurrentTime()]
        );
        io.to(`room:${roomId}`).emit('newMessage', inserted.rows[0]);
    }

    app.get('/api/chats/invite/:chatId', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const chatId = req.params.chatId;
        try {
            const chat = await dbGet('SELECT room_id FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) return res.json({ success: false, message: 'Чат не найден' });
            if (!chat.room_id) return res.json({ success: false, message: 'У этого чата нет кода приглашения' });
            const room = await dbGet('SELECT code FROM rooms WHERE id = $1', [chat.room_id]);
            if (!room) return res.json({ success: false, message: 'Код не найден' });
            // code: null — приглашение отключено.
            res.json({ success: true, code: room.code });
        } catch (error) {
            log.error({ err: error }, 'Get invite error');
            res.status(500).json({ success: false, message: 'Ошибка получения кода' });
        }
    });

    /**
     * Сменить код приглашения ({ action: 'reset' }) или отключить приглашение
     * ({ action: 'disable' }). Утёкший код иначе действовал бы вечно. Может
     * любой участник — ролей в комнате нет, — и все видят, кто это сделал.
     */
    app.post('/api/chats/:chatId/invite', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const action = req.body && req.body.action;
        if (action !== 'reset' && action !== 'disable') {
            return res.status(400).json({ success: false, message: 'Неизвестное действие' });
        }
        try {
            const chat = await dbGet('SELECT id, room_id FROM chats WHERE id = $1 AND user_id = $2', [req.params.chatId, req.session.userId]);
            if (!chat || !chat.room_id) return res.json({ success: false, message: 'Чат не найден' });
            const code = action === 'reset' ? await generateInviteCodeAsync() : null;
            await dbRun('UPDATE rooms SET code = $1 WHERE id = $2', [code, chat.room_id]);
            const user = await dbGet('SELECT username FROM users WHERE id = $1', [req.session.userId]);
            await postSystemMessage({
                roomId: chat.room_id, chatId: chat.id,
                text: `${user.username} ${code ? 'сменил(а) код приглашения' : 'отключил(а) приглашение'}`,
            });
            res.json({ success: true, code });
        } catch (error) {
            log.error({ err: error }, 'Invite update error');
            res.status(500).json({ success: false, message: 'Не удалось изменить приглашение' });
        }
    });

    app.post('/api/chats/join', joinLimiter, async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        // Код вводят руками и копируют из переписки: регистр, пробелы и дефисы
        // («k7q2 mx», «K7Q-2MX») не должны мешать.
        const code = String((req.body && req.body.code) || '').toUpperCase().replace(/[\s-]/g, '');
        if (!code) return res.json({ success: false, message: 'Введите код приглашения' });

        try {
            const room = await dbGet('SELECT * FROM rooms WHERE code = $1', [code]);
            if (!room) return res.json({ success: false, message: 'Чат по этому коду не найден' });

            const participant = await dbGet('SELECT id FROM room_participants WHERE room_id = $1 AND user_id = $2', [room.id, req.session.userId]);
            if (participant) {
                res.locals.joined = true;
                const chat = await dbGet('SELECT id FROM chats WHERE room_id = $1 AND user_id = $2', [room.id, req.session.userId]);
                if (!chat) return res.json({ success: false, message: 'Чат уже добавлен' });
                return res.json({ success: true, chat: { id: chat.id } });
            }

            const otherUser = await dbGet('SELECT u.username FROM users u JOIN room_participants rp ON u.id = rp.user_id WHERE rp.room_id = $1 AND u.id != $2 LIMIT 1', [room.id, req.session.userId]);
            const chatName = otherUser ? `Чат с ${otherUser.username}` : room.name;
            const avatar = chatName.charAt(0).toUpperCase();

            await pool.query('INSERT INTO room_participants (room_id, user_id) VALUES ($1, $2)', [room.id, req.session.userId]);
            const chatResult = await pool.query(
                'INSERT INTO chats (user_id, room_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                [req.session.userId, room.id, chatName, avatar, 0, 0]
            );
            res.locals.joined = true;
            await ctx.disappearingMessagesManager.copyRoomExpiry(chatResult.rows[0].id, room.id);
            const me = await dbGet('SELECT username FROM users WHERE id = $1', [req.session.userId]);
            await postSystemMessage({
                roomId: room.id, chatId: chatResult.rows[0].id,
                text: `${me.username} вошёл(ла) в чат по коду приглашения`,
            });
            res.json({ success: true, chat: { id: chatResult.rows[0].id, name: chatName, avatar, online: 0, is_bot: 0, room_id: room.id, invite_code: room.code } });
        } catch (error) {
            log.error({ err: error }, 'Join chat error');
            res.status(500).json({ success: false, message: 'Ошибка входа в чат' });
        }
    });

    app.delete('/api/chats/:chatId', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const chatId = req.params.chatId;
        try {
            const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) return res.json({ success: false, message: 'Чат не найден' });

            if (chat.room_id) {
                await dbRun('DELETE FROM room_participants WHERE room_id = $1 AND user_id = $2', [chat.room_id, req.session.userId]);
                // Ключи группы, которые ушедший так и не забрал, ему больше не
                // нужны. Остальные участники сменят свои sender keys при
                // следующей отправке: клиент видит, что устройство пропало.
                await dbRun(
                    `DELETE FROM sender_key_envelopes WHERE room_id = $1
                     AND recipient_device_id IN (SELECT id FROM devices WHERE user_id = $2)`,
                    [chat.room_id, req.session.userId]
                );
                const remaining = await dbGet('SELECT COUNT(*) as cnt FROM room_participants WHERE room_id = $1', [chat.room_id]);
                if (remaining && Number(remaining.cnt) > 0) {
                    const me = await dbGet('SELECT username FROM users WHERE id = $1', [req.session.userId]);
                    await postSystemMessage({
                        roomId: chat.room_id, chatId: null,
                        text: `${me.username} вышел(ла) из чата`,
                    });
                }
                await dbRun('DELETE FROM unread WHERE chat_id = $1', [chatId]);
                await dbRun('DELETE FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
                if (!remaining || Number(remaining.cnt) === 0) {
                    // Последний участник вышел — сносим комнату целиком.
                    await dbRun('DELETE FROM messages WHERE room_id = $1', [chat.room_id]);
                    await dbRun('DELETE FROM rooms WHERE id = $1', [chat.room_id]);
                }
                // Если участники остались — историю не трогаем, она у них
                // по-прежнему доступна по room_id (chat_id этого сообщения,
                // если оно было отправлено уходящим, просто станет NULL).
            } else {
                await dbRun('DELETE FROM messages WHERE chat_id = $1', [chatId]);
                await dbRun('DELETE FROM unread WHERE chat_id = $1', [chatId]);
                await dbRun('DELETE FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            }
            // Сокеты этого пользователя больше не должны получать сообщения чата.
            io.in(`user:${req.session.userId}`).socketsLeave(
                chat.room_id ? [`room:${chat.room_id}`, `chat:${chat.id}`] : [`chat:${chat.id}`]);
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Delete chat error');
            res.status(500).json({ success: false, message: 'Ошибка удаления чата' });
        }
    });

    app.get('/api/search', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const query = req.query.q || '';
        // results всегда объект с chats: раньше на пустой запрос отдавался массив,
        // и форма ответа отличалась от успешного случая.
        if (!query || query.length < 1) return res.json({ success: true, results: { chats: [] } });
        if (query.length > 100) return res.json({ success: false, message: 'Запрос слишком длинный' });

        const safeTerm = query.replace(/[%_\\]/g, '\\$&');
        const searchTerm = `%${safeTerm}%`;
        try {
            // Ищем только по названиям чатов.
            //
            // Поиск по тексту сообщений убран намеренно и окончательно: он делал
            // `m.text ILIKE` на сервере, то есть требовал, чтобы сервер читал
            // переписку. Это прямо противоречит E2EE, к которому идёт проект, —
            // после включения шифрования сервер увидит только шифротекст, и
            // такой запрос перестанет находить что-либо в принципе.
            //
            // Клиент эти результаты и так никогда не показывал: performSearch()
            // рендерит только results.chats, а results.messages выбрасывал. То
            // есть запрос выполнялся на каждое нажатие клавиши (debounce 300 мс)
            // впустую.
            //
            // Если поиск по сообщениям понадобится снова, единственный
            // совместимый с E2EE вариант — индекс на клиенте, по расшифрованным
            // у него же сообщениям. Серверная реализация возможна только за счёт
            // отказа от шифрования.
            const chats = await dbAll('SELECT id, name, avatar FROM chats WHERE user_id = $1 AND name ILIKE $2 LIMIT 10', [req.session.userId, searchTerm]);
            res.json({ success: true, results: { chats } });
        } catch (error) {
            log.error({ err: error }, 'Search error');
            res.status(500).json({ success: false, message: 'Ошибка поиска' });
        }
    });

    app.post('/api/chats/:chatId/set-default-expiry', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const chatId = Number(req.params.chatId);
        const { expirySeconds } = req.body;

        if (!Number.isFinite(chatId) || (Number(expirySeconds) !== 0 && normalizeExpiry(expirySeconds) === null)) {
            return res.json({ success: false, message: 'Неверные параметры' });
        }

        try {
            // Проверка доступа к чату
            const chat = await dbGet('SELECT id, room_id FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) {
                return res.json({ success: false, message: 'Чат не найден' });
            }

            const seconds = Number(expirySeconds) === 0 ? null : normalizeExpiry(expirySeconds);
            const before = await ctx.disappearingMessagesManager.setChatDefaultExpiry(chatId, expirySeconds);
            // Собеседники должны знать, что их сообщения теперь исчезают.
            if (chat.room_id && before !== seconds) {
                const name = req.session.username || 'Участник';
                await postSystemMessage({ roomId: chat.room_id, chatId: chat.id, text: seconds
                    ? `${name} включил(а) исчезающие сообщения: ${expiryLabel(seconds)}`
                    : `${name} выключил(а) исчезающие сообщения` });
                io.to(`room:${chat.room_id}`).emit('chatExpiryChanged', { room_id: chat.room_id, expirySeconds: seconds });
            }

            res.json({ success: true, expirySeconds: seconds });
        } catch (error) {
            log.error({ err: error }, 'Set chat default expiry error');
            res.status(500).json({ success: false, message: 'Ошибка настройки автоудаления' });
        }
    });

    app.get('/api/chats/:chatId/settings', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const chatId = Number(req.params.chatId);

        try {
            const chat = await dbGet('SELECT id FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) {
                return res.json({ success: false, message: 'Чат не найден' });
            }

            const settings = await ctx.disappearingMessagesManager.getChatSettings(chatId);
            res.json({ success: true, settings: settings || {} });
        } catch (error) {
            log.error({ err: error }, 'Get chat settings error');
            res.status(500).json({ success: false, message: 'Ошибка получения настроек' });
        }
    });

    return { postSystemMessage, resolveEnvelopeRecipients };
};
