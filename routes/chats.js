'use strict';

// Чаты: список, группы (ссылки, запросы на вход, участники и роли), выход,
// поиск и настройки.

const { log } = require('../lib/log');
const { pool, dbGet, dbAll, dbRun } = require('../lib/db');
const { normalizeExpiry, expiryLabel } = require('../lib/disappearing-messages');
const { joinLimiter } = require('../lib/rate-limits');
const { onlyStrings, BAD_FIELDS, getCurrentTime } = require('../lib/helpers');
const { roleIn, adminIds, ensureAdmin, newLinkToken, normalizeLinkToken } = require('../lib/rooms');
const { SCOPE, UNREAD_COUNT_SQL, broadcastReceipts, receiptsFor, statusFor } = require('../lib/read-state');
const { isOnline } = require('../lib/presence');


module.exports = function registerChatRoutes(app, ctx) {
    const { io } = ctx;

    app.get('/api/chats', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        try {
            const chats = await dbAll(`
                SELECT c.id, c.name, c.avatar, c.is_bot, c.room_id, r.kind, me.role AS my_role,
                       c.pin_position, c.muted, c.archived_at IS NOT NULL AS archived,
                       -- Сколько ждут одобрения — только администраторам.
                       CASE WHEN r.kind = 'direct' THEN EXISTS (SELECT 1 FROM blocks b
                            JOIN room_participants o ON o.room_id = c.room_id AND o.user_id <> c.user_id
                            WHERE b.blocker_id = c.user_id AND b.blocked_id = o.user_id) END AS peer_blocked,
                       CASE WHEN me.role = 'admin' THEN (SELECT count(*)::int FROM join_requests jr
                            WHERE jr.room_id = c.room_id AND jr.status = 'pending') END AS pending_requests,
                       (SELECT array_agg(rp.user_id) FROM room_participants rp
                        WHERE rp.room_id = c.room_id AND rp.user_id <> c.user_id) AS peers,
                       lm.text AS last_message, lm.created_at AS last_at, lm.id AS last_id,
                       lm.user_id AS last_user_id, lm.sent AS last_sent, lm.message_type AS last_type,
                       lm.username AS last_sender,
                       ${UNREAD_COUNT_SQL} as unread, c.last_read_id
                FROM chats c
                LEFT JOIN rooms r ON c.room_id = r.id
                LEFT JOIN room_participants me ON me.room_id = c.room_id AND me.user_id = c.user_id
                -- Последнее сообщение: для превью («Вы:», «Анна:»), времени
                -- и отметки ✓✓ у своего.
                LEFT JOIN LATERAL (
                    SELECT m.id, m.text, m.created_at, m.user_id, m.sent, m.message_type, u.username
                    FROM messages m LEFT JOIN users u ON u.id = m.user_id
                    WHERE ((c.room_id IS NOT NULL AND m.room_id = c.room_id) OR (c.room_id IS NULL AND m.chat_id = c.id))
                      AND m.deleted = 0
                    ORDER BY m.id DESC LIMIT 1
                ) lm ON true
                WHERE c.user_id = $1
                -- Закреплённые — сверху, в своём порядке; остальные — по
                -- последнему сообщению.
                ORDER BY c.pin_position NULLS LAST, lm.id DESC NULLS LAST
            `, [req.session.userId]);
            // «В сети» — если в сети хоть кто-то из собеседников; сколько их
            // всего — для подписи группы. Кто из них в сети сейчас — чтобы
            // клиент дальше вёл статус по событиям presence.
            // Статус собеседников — только если ни они, ни сам смотрящий его
            // не скрывают (lib/presence.js).
            const allPeers = [...new Set(chats.flatMap(c => c.peers || []))];
            const me = await dbGet('SELECT hide_presence FROM users WHERE id = $1', [req.session.userId]);
            const peerInfo = new Map((allPeers.length
                ? await dbAll('SELECT id, hide_presence, last_seen_at FROM users WHERE id = ANY($1::int[])', [allPeers])
                : []).map(u => [u.id, u]));
            const visible = id => !(me && me.hide_presence) && peerInfo.has(id) && !peerInfo.get(id).hide_presence;
            // Отметка у своего последнего сообщения — ✓ или ✓✓, как в ленте.
            for (const c of chats) {
                const own = c.last_user_id === req.session.userId && Number(c.last_sent) !== 0 && c.last_type !== 'system';
                c.last_status = own && c.room_id ? statusFor(c.last_id, await receiptsFor(c.room_id, req.session.userId)) : null;
            }
            res.json({ success: true, presenceHidden: Boolean(me && me.hide_presence), chats: chats.map(({ peers, ...c }) => {
                const ids = peers || [];
                const onlineIds = ids.filter(id => visible(id) && isOnline(id));
                return {
                    ...c,
                    unread: Number(c.unread),
                    peer_count: ids.length,
                    online: onlineIds.length ? 1 : 0,
                    peer_ids: ids,
                    online_ids: onlineIds,
                    // Когда был в сети — для чата на двоих; null — не видно.
                    last_seen: ids.length === 1 && visible(ids[0]) ? peerInfo.get(ids[0]).last_seen_at : null,
                };
            }) });

            // Список чатов с превью на экране — значит, сообщения до этого
            // устройства дошли: «доставлено» у собеседников.
            const moved = await dbAll(
                `WITH latest AS (
                     SELECT c.id, (SELECT max(m.id) FROM messages m WHERE ${SCOPE}) AS top
                     FROM chats c WHERE c.user_id = $1
                 )
                 UPDATE chats c SET last_delivered_id = l.top
                 FROM latest l WHERE c.id = l.id AND l.top > c.last_delivered_id
                 RETURNING c.room_id`, [req.session.userId]);
            for (const { room_id: roomId } of moved) await broadcastReceipts(io, roomId);
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
            // Участники — все, а не только те, у кого есть устройства: иначе
            // собеседник без ключей пропадал бы молча, и клиент не мог бы
            // сказать «у Марии нет устройства с шифрованием». Имена — и для
            // этого, и для окна сверки ключей.
            const participants = chat.room_id
                ? await dbAll(
                    `SELECT u.id, u.username FROM room_participants rp JOIN users u ON u.id = rp.user_id
                     WHERE rp.room_id = $1 ORDER BY rp.id`, [chat.room_id])
                : chat.is_bot ? [] : await dbAll('SELECT id, username FROM users WHERE id = $1', [chat.user_id]);
            const userIds = [...new Set(devices.map(d => d.user_id))];
            const users = participants.filter(u => userIds.includes(u.id));
            res.json({
                success: true,
                // room_id нужен клиенту для sender keys: у каждого участника своя
                // запись chats с другим id, а групповой ключ один на комнату.
                room_id: chat.room_id || null,
                devices: devices.map(d => ({ device_id: d.id, user_id: d.user_id })),
                users: users.map(u => ({ user_id: u.id, username: u.username })),
                participants: participants.map(u => ({ user_id: u.id, username: u.username })),
            });
        } catch (error) {
            log.error({ err: error }, 'Chat devices error');
            res.status(500).json({ success: false, message: 'Не удалось получить устройства чата' });
        }
    });

    /* ------------------------------------------------------------------
       Группы: создание, ссылки-приглашения, запросы на вход, участники
       ------------------------------------------------------------------ */

    const unauthorized = res => res.status(401).json({ success: false, message: 'Не авторизован' });
    const notFound = res => res.status(404).json({ success: false, message: 'Чат не найден' });
    const adminOnly = res => res.status(403).json({
        success: false, code: 'ADMIN_ONLY', message: 'Это может только администратор группы' });
    const groupOnly = res => res.status(400).json({ success: false, message: 'Это есть только у групп' });

    const usernameOf = async userId => {
        const row = await dbGet('SELECT username FROM users WHERE id = $1', [userId]);
        return row ? row.username : 'Участник';
    };

    /*
     * Своя запись чата вместе с комнатой и ролью в ней. null — чата нет
     * или он не свой. Для маршрутов групп: у чата с ботом комнаты нет.
     */
    async function loadGroupChat(chatId, userId) {
        if (!/^\d{1,10}$/.test(String(chatId))) return null;
        return dbGet(
            `SELECT c.id, c.room_id, r.kind, r.name AS room_name, rp.role
             FROM chats c
             JOIN rooms r ON r.id = c.room_id
             JOIN room_participants rp ON rp.room_id = c.room_id AND rp.user_id = c.user_id
             WHERE c.id = $1 AND c.user_id = $2`, [chatId, userId]);
    }

    // Для маршрутов, которые может вызывать только администратор группы.
    // Ответ об ошибке отправляет сам и тогда возвращает null.
    async function requireGroupAdmin(req, res) {
        if (!req.session.userId) { unauthorized(res); return null; }
        const chat = await loadGroupChat(req.params.chatId, req.session.userId);
        if (!chat) { notFound(res); return null; }
        if (chat.kind !== 'group') { groupOnly(res); return null; }
        if (chat.role !== 'admin') { adminOnly(res); return null; }
        return chat;
    }

    async function pendingCount(roomId) {
        const row = await dbGet(
            "SELECT count(*)::int AS n FROM join_requests WHERE room_id = $1 AND status = 'pending'", [roomId]);
        return row.n;
    }

    // Администраторам — что очередь запросов изменилась; сам список они
    // заберут запросом (в событии нет имён: сокет может быть и старым).
    async function notifyAdmins(roomId) {
        const pending = await pendingCount(roomId);
        for (const id of await adminIds(roomId)) {
            io.to(`user:${id}`).emit('joinRequestsChanged', { room_id: roomId, pending });
        }
    }

    // Участникам — что состав или роли поменялись: панель участников и
    // права в интерфейсе обновляются без перезагрузки.
    function notifyMembersChanged(roomId) {
        io.to(`room:${roomId}`).emit('membersChanged', { room_id: roomId });
    }

    // Если комната осталась без администратора — назначить и сказать.
    async function promoteIfNeeded(roomId) {
        const promoted = await ensureAdmin(roomId);
        if (!promoted) return;
        await postSystemMessage({ roomId, chatId: null, text: `${await usernameOf(promoted)} теперь администратор` });
    }

    const publicLink = link => link && ({
        code: link.token,
        expires_at: link.expires_at,
        member_limit: link.member_limit,
        require_approval: link.require_approval,
        created_at: link.created_at,
    });

    async function activeLink(roomId) {
        return dbGet(
            `SELECT * FROM invite_links WHERE room_id = $1 AND revoked_at IS NULL
               AND (expires_at IS NULL OR expires_at > now())`, [roomId]);
    }

    app.post('/api/chats', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const { name } = req.body;
        if (!onlyStrings(name)) return res.status(400).json(BAD_FIELDS);
        const title = String(name || '').trim();
        if (!title) return res.json({ success: false, message: 'Введите название группы' });
        if (title.length > 64) return res.json({ success: false, message: 'Название группы не может быть длиннее 64 символов' });

        const avatar = title.charAt(0).toUpperCase();
        try {
            const client = await pool.connect();
            let roomId, chatId;
            try {
                await client.query('BEGIN');
                // Кода у новой комнаты нет: войти можно только по ссылке,
                // которую создаст администратор.
                const roomResult = await client.query(
                    "INSERT INTO rooms (name, code, kind) VALUES ($1, NULL, 'group') RETURNING id", [title]);
                roomId = roomResult.rows[0].id;
                await client.query(
                    "INSERT INTO room_participants (room_id, user_id, role) VALUES ($1, $2, 'admin')",
                    [roomId, req.session.userId]);
                const chatResult = await client.query(
                    'INSERT INTO chats (user_id, room_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
                    [req.session.userId, roomId, title, avatar, 0, 0]
                );
                chatId = chatResult.rows[0].id;
                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            } finally {
                client.release();
            }
            res.json({ success: true, chat: {
                id: chatId, name: title, avatar, online: 0, is_bot: 0, room_id: roomId, kind: 'group', my_role: 'admin',
            } });
        } catch (error) {
            log.error({ err: error }, 'Create chat error');
            res.status(500).json({ success: false, message: 'Ошибка создания чата' });
        }
    });

    /**
     * Системное сообщение в комнате: кто вошёл, кто вышел, кто сменил ссылку.
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

    /*
     * Ссылка-приглашение группы: /join#<12 знаков>. Смотреть и менять —
     * только администратору: ссылка впускает в переписку, и раздавать её
     * решает он.
     */
    app.get('/api/chats/:chatId/link', async (req, res) => {
        try {
            const chat = await requireGroupAdmin(req, res);
            if (!chat) return;
            res.json({ success: true, link: publicLink(await activeLink(chat.room_id)) });
        } catch (error) {
            log.error({ err: error }, 'Get link error');
            res.status(500).json({ success: false, message: 'Не удалось получить ссылку' });
        }
    });

    // Сроки — только из списка: 1 час, 1 день, 7 дней или бессрочно (0).
    const LINK_EXPIRY = new Set([0, 3600, 86400, 7 * 86400]);

    /*
     * Создать ссылку или сменить её: прежняя тут же перестаёт действовать.
     * { expiresIn: секунды из LINK_EXPIRY, memberLimit: 2…1000 или null,
     *   requireApproval: по умолчанию true }.
     */
    app.post('/api/chats/:chatId/link', async (req, res) => {
        const body = req.body || {};
        const expiresIn = body.expiresIn === undefined ? 0 : Number(body.expiresIn);
        const memberLimit = body.memberLimit === undefined || body.memberLimit === null || body.memberLimit === ''
            ? null : Number(body.memberLimit);
        const requireApproval = body.requireApproval === undefined ? true : body.requireApproval;
        if (!LINK_EXPIRY.has(expiresIn)
            || (memberLimit !== null && (!Number.isInteger(memberLimit) || memberLimit < 2 || memberLimit > 1000))
            || typeof requireApproval !== 'boolean') {
            return res.status(400).json({ success: false, message: 'Неверные параметры ссылки' });
        }
        try {
            const chat = await requireGroupAdmin(req, res);
            if (!chat) return;
            const client = await pool.connect();
            let link, replaced;
            try {
                await client.query('BEGIN');
                const revoked = await client.query(
                    'UPDATE invite_links SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL', [chat.room_id]);
                replaced = revoked.rowCount > 0;
                for (let attempt = 0; !link; attempt++) {
                    try {
                        await client.query('SAVEPOINT token');
                        link = (await client.query(
                            `INSERT INTO invite_links (room_id, token, created_by, expires_at, member_limit, require_approval)
                             VALUES ($1, $2, $3, CASE WHEN $4::int > 0 THEN now() + make_interval(secs => $4::int) END, $5, $6)
                             RETURNING *`,
                            [chat.room_id, newLinkToken(), req.session.userId, expiresIn, memberLimit, requireApproval])).rows[0];
                    } catch (err) {
                        // Совпадение токена (60 бит) — почти невозможное, но не
                        // повод отдавать 500.
                        if (err.code !== '23505' || attempt > 3) throw err;
                        await client.query('ROLLBACK TO SAVEPOINT token');
                    }
                }
                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK').catch(() => {});
                throw txErr;
            } finally {
                client.release();
            }
            const name = await usernameOf(req.session.userId);
            await postSystemMessage({
                roomId: chat.room_id, chatId: chat.id,
                text: `${name} ${replaced ? 'сменил(а)' : 'создал(а)'} ссылку-приглашение`,
            });
            res.json({ success: true, link: publicLink(link), code: link.token });
        } catch (error) {
            log.error({ err: error }, 'Create link error');
            res.status(500).json({ success: false, message: 'Не удалось создать ссылку' });
        }
    });

    app.delete('/api/chats/:chatId/link', async (req, res) => {
        try {
            const chat = await requireGroupAdmin(req, res);
            if (!chat) return;
            const revoked = await dbAll(
                'UPDATE invite_links SET revoked_at = now() WHERE room_id = $1 AND revoked_at IS NULL RETURNING id', [chat.room_id]);
            if (revoked.length) {
                await postSystemMessage({
                    roomId: chat.room_id, chatId: chat.id,
                    text: `${await usernameOf(req.session.userId)} отключил(а) ссылку-приглашение`,
                });
            }
            res.json({ success: true, link: null });
        } catch (error) {
            log.error({ err: error }, 'Revoke link error');
            res.status(500).json({ success: false, message: 'Не удалось отключить ссылку' });
        }
    });

    /*
     * Добавить участника в комнату: запись участника и его чата — одной
     * транзакцией. Возвращает { chatId } или { already: true, chatId }, если
     * он уже там (двойное нажатие, повторное одобрение).
     */
    async function addParticipant(room, userId) {
        const client = await pool.connect();
        let chatId;
        try {
            await client.query('BEGIN');
            const added = await client.query(
                `INSERT INTO room_participants (room_id, user_id, role) VALUES ($1, $2, 'member')
                 ON CONFLICT (room_id, user_id) DO NOTHING RETURNING id`, [room.id, userId]);
            if (added.rowCount === 0) {
                await client.query('ROLLBACK');
                const existing = await dbGet('SELECT id FROM chats WHERE room_id = $1 AND user_id = $2', [room.id, userId]);
                return { already: true, chatId: existing ? existing.id : null };
            }
            // Всё, что было в комнате до входа, — не «непрочитанное»:
            // прочитать это новое устройство всё равно не может.
            const chatResult = await client.query(
                `INSERT INTO chats (user_id, room_id, name, avatar, online, is_bot, last_read_id, last_delivered_id)
                 SELECT $1, $2, $3, $4, 0, 0, top, top
                 FROM (SELECT COALESCE(max(id), 0) AS top FROM messages WHERE room_id = $2) t
                 RETURNING id`,
                [userId, room.id, room.name, room.name.charAt(0).toUpperCase()]);
            chatId = chatResult.rows[0].id;
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        await ctx.disappearingMessagesManager.copyRoomExpiry(chatId, room.id);
        notifyMembersChanged(room.id);
        return { chatId };
    }

    const joinedChat = (room, chatId) => ({
        id: chatId, name: room.name, avatar: room.name.charAt(0).toUpperCase(), online: 0, is_bot: 0,
        room_id: room.id, kind: room.kind, my_role: 'member',
    });

    // Одинаковый ответ на «такой ссылки нет», «отключена» и «истекла»: по
    // ответу не должно быть видно, существовала ли ссылка.
    const LINK_INVALID = { success: false, code: 'LINK_INVALID', message: 'Ссылка не действует — попросите новую' };

    /*
     * Вход по ссылке. { code } — сама ссылка, «/join#…» или 12 знаков.
     * { preview: true } — только узнать, куда ведёт ссылка (название,
     * сколько участников, нужно ли одобрение), ничего не меняя.
     *
     * Если ссылка требует одобрения, заводится запрос: участники видят
     * строку «просится в группу», администраторы — кнопки «Впустить» и
     * «Отклонить», а сам человек — экран «Запрос отправлен».
     */
    app.post('/api/chats/join', joinLimiter, async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        if (!onlyStrings(req.body && req.body.code)) return res.status(400).json(BAD_FIELDS);
        const token = normalizeLinkToken(req.body && req.body.code);
        if (!token) return res.json({ success: false, message: 'Вставьте ссылку-приглашение' });
        if (!/^[A-Z0-9]{12}$/.test(token)) return res.json(LINK_INVALID);
        const userId = req.session.userId;

        try {
            const link = await dbGet(
                `SELECT l.*, r.name AS room_name, r.kind
                 FROM invite_links l JOIN rooms r ON r.id = l.room_id
                 WHERE l.token = $1 AND l.revoked_at IS NULL AND (l.expires_at IS NULL OR l.expires_at > now())`, [token]);
            if (!link) return res.json(LINK_INVALID);
            // Ссылка настоящая — неудачей для лимита подбора это не считается.
            res.locals.joined = true;
            const room = { id: link.room_id, name: link.room_name, kind: link.kind };

            const member = await dbGet(
                'SELECT c.id FROM room_participants rp JOIN chats c ON c.room_id = rp.room_id AND c.user_id = rp.user_id WHERE rp.room_id = $1 AND rp.user_id = $2',
                [room.id, userId]);
            const count = (await dbGet('SELECT count(*)::int AS n FROM room_participants WHERE room_id = $1', [room.id])).n;
            if (req.body.preview === true) {
                return res.json({ success: true, preview: {
                    name: room.name, members: count, require_approval: link.require_approval, member: Boolean(member),
                } });
            }
            if (member) return res.json({ success: true, chat: { id: member.id } });
            if (link.member_limit && count >= link.member_limit) {
                return res.json({ success: false, code: 'ROOM_FULL', message: 'В группе нет свободных мест по этой ссылке' });
            }

            const name = await usernameOf(userId);
            if (link.require_approval) {
                const created = await dbGet(
                    `INSERT INTO join_requests (room_id, user_id, link_id) VALUES ($1, $2, $3)
                     ON CONFLICT (room_id, user_id) WHERE status = 'pending' DO NOTHING RETURNING id, created_at`,
                    [room.id, userId, link.id]);
                const request = created || await dbGet(
                    "SELECT id, created_at FROM join_requests WHERE room_id = $1 AND user_id = $2 AND status = 'pending'",
                    [room.id, userId]);
                if (created) {
                    await postSystemMessage({ roomId: room.id, chatId: null, text: `${name} просится в группу по ссылке` });
                    await notifyAdmins(room.id);
                }
                return res.json({ success: true, pending: true, request: {
                    id: request.id, room_name: room.name, created_at: request.created_at,
                } });
            }

            const added = await addParticipant(room, userId);
            if (added.already) {
                return res.json(added.chatId ? { success: true, chat: { id: added.chatId } } : { success: false, message: 'Чат уже добавлен' });
            }
            await postSystemMessage({ roomId: room.id, chatId: added.chatId, text: `${name} вошёл(ла) в группу по ссылке` });
            res.json({ success: true, chat: joinedChat(room, added.chatId) });
        } catch (error) {
            log.error({ err: error }, 'Join chat error');
            res.status(500).json({ success: false, message: 'Ошибка входа в чат' });
        }
    });

    // Свои ждущие запросы — для экрана «Запрос отправлен» после перезагрузки.
    app.get('/api/join-requests', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        try {
            const requests = await dbAll(
                `SELECT jr.id, jr.created_at, r.name AS room_name FROM join_requests jr JOIN rooms r ON r.id = jr.room_id
                 WHERE jr.user_id = $1 AND jr.status = 'pending' ORDER BY jr.id`, [req.session.userId]);
            res.json({ success: true, requests });
        } catch (error) {
            log.error({ err: error }, 'List own join requests error');
            res.status(500).json({ success: false, message: 'Не удалось получить запросы' });
        }
    });

    // «Отменить запрос».
    app.delete('/api/join-requests/:id', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        if (!/^\d{1,10}$/.test(req.params.id)) return res.status(404).json({ success: false, message: 'Запрос не найден' });
        try {
            const cancelled = await dbGet(
                `UPDATE join_requests SET status = 'cancelled', decided_at = now()
                 WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING room_id`, [req.params.id, req.session.userId]);
            if (!cancelled) return res.status(404).json({ success: false, message: 'Запрос не найден' });
            await notifyAdmins(cancelled.room_id);
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Cancel join request error');
            res.status(500).json({ success: false, message: 'Не удалось отменить запрос' });
        }
    });

    // «Ждут одобрения» — для администраторов.
    app.get('/api/chats/:chatId/requests', async (req, res) => {
        try {
            const chat = await requireGroupAdmin(req, res);
            if (!chat) return;
            const requests = await dbAll(
                `SELECT jr.id, jr.user_id, u.username, jr.created_at FROM join_requests jr JOIN users u ON u.id = jr.user_id
                 WHERE jr.room_id = $1 AND jr.status = 'pending' ORDER BY jr.id`, [chat.room_id]);
            res.json({ success: true, requests });
        } catch (error) {
            log.error({ err: error }, 'List join requests error');
            res.status(500).json({ success: false, message: 'Не удалось получить запросы' });
        }
    });

    // «Впустить» ({ action: 'approve' }) или «Отклонить» ({ action: 'decline' }).
    app.post('/api/chats/:chatId/requests/:id', async (req, res) => {
        const action = req.body && req.body.action;
        if (action !== 'approve' && action !== 'decline') {
            return res.status(400).json({ success: false, message: 'Неизвестное действие' });
        }
        if (!/^\d{1,10}$/.test(req.params.id)) return res.status(404).json({ success: false, message: 'Запрос не найден' });
        try {
            const chat = await requireGroupAdmin(req, res);
            if (!chat) return;
            // Решает первый: второй администратор, нажавший одновременно,
            // получит «уже решён», а не второе вступление.
            const decided = await dbGet(
                `UPDATE join_requests SET status = $1, decided_by = $2, decided_at = now()
                 WHERE id = $3 AND room_id = $4 AND status = 'pending' RETURNING user_id`,
                [action === 'approve' ? 'approved' : 'declined', req.session.userId, req.params.id, chat.room_id]);
            if (!decided) return res.status(409).json({ success: false, message: 'Запрос уже решён или отменён' });
            const room = { id: chat.room_id, name: chat.room_name, kind: chat.kind };
            let joined = null;
            if (action === 'approve') {
                const added = await addParticipant(room, decided.user_id);
                if (!added.already) {
                    await postSystemMessage({
                        roomId: room.id, chatId: added.chatId,
                        text: `${await usernameOf(decided.user_id)} вошёл(ла) в группу по ссылке, впустил(а) ${await usernameOf(req.session.userId)}`,
                    });
                }
                joined = added.chatId ? joinedChat(room, added.chatId) : null;
            }
            io.to(`user:${decided.user_id}`).emit('joinRequestDecided', {
                request_id: Number(req.params.id), status: action === 'approve' ? 'approved' : 'declined',
                room_name: room.name, chat: joined,
            });
            await notifyAdmins(room.id);
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Decide join request error');
            res.status(500).json({ success: false, message: 'Не удалось обработать запрос' });
        }
    });

    // Участники с ролями — для панели участников. Видят все участники.
    app.get('/api/chats/:chatId/members', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        try {
            const chat = await loadGroupChat(req.params.chatId, req.session.userId);
            if (!chat) return notFound(res);
            const members = await dbAll(
                `SELECT u.id AS user_id, u.username, rp.role, rp.joined_at
                 FROM room_participants rp JOIN users u ON u.id = rp.user_id
                 WHERE rp.room_id = $1 ORDER BY (rp.role = 'admin') DESC, rp.id`, [chat.room_id]);
            res.json({ success: true, kind: chat.kind, name: chat.room_name, my_role: chat.role, members });
        } catch (error) {
            log.error({ err: error }, 'List members error');
            res.status(500).json({ success: false, message: 'Не удалось получить участников' });
        }
    });

    const targetId = req => (/^\d{1,10}$/.test(req.params.userId) ? Number(req.params.userId) : null);

    // Назначить администратором ({ role: 'admin' }) или снять ({ role: 'member' }).
    app.post('/api/chats/:chatId/members/:userId/role', async (req, res) => {
        const role = req.body && req.body.role;
        if (role !== 'admin' && role !== 'member') return res.status(400).json({ success: false, message: 'Неизвестная роль' });
        try {
            const chat = await requireGroupAdmin(req, res);
            if (!chat) return;
            const target = targetId(req);
            // Последнего администратора не снять: иначе в группу больше никого
            // не впустить. Проверка и смена — одним запросом, без гонки двух
            // администраторов, снимающих друг друга.
            const changed = await dbGet(
                `UPDATE room_participants SET role = $1
                 WHERE room_id = $2 AND user_id = $3 AND role <> $1
                   AND ($1 = 'admin' OR EXISTS (SELECT 1 FROM room_participants o
                        WHERE o.room_id = $2 AND o.role = 'admin' AND o.user_id <> $3))
                 RETURNING user_id`, [role, chat.room_id, target]);
            if (!changed) {
                const current = await roleIn(chat.room_id, target);
                if (!current) return res.status(404).json({ success: false, message: 'Участник не найден' });
                if (current === role) return res.json({ success: true, role });
                return res.status(409).json({ success: false, code: 'LAST_ADMIN', message: 'В группе должен остаться хотя бы один администратор' });
            }
            const [admin, member] = [await usernameOf(req.session.userId), await usernameOf(target)];
            await postSystemMessage({
                roomId: chat.room_id, chatId: chat.id,
                text: role === 'admin' ? `${admin} назначил(а) администратором: ${member}` : `${admin} снял(а) права администратора: ${member}`,
            });
            notifyMembersChanged(chat.room_id);
            await notifyAdmins(chat.room_id);
            res.json({ success: true, role });
        } catch (error) {
            log.error({ err: error }, 'Change role error');
            res.status(500).json({ success: false, message: 'Не удалось изменить роль' });
        }
    });

    /*
     * Убрать участника из комнаты: сам ли он ушёл или его удалил
     * администратор. Ключи группы, которые он так и не забрал, ему больше не
     * нужны. Остальные участники сменят свои sender keys при следующей
     * отправке: клиент видит, что устройство пропало.
     */
    async function dropParticipant(roomId, userId) {
        await dbRun('DELETE FROM room_participants WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
        await dbRun(
            `DELETE FROM sender_key_envelopes WHERE room_id = $1
             AND recipient_device_id IN (SELECT id FROM devices WHERE user_id = $2)`, [roomId, userId]);
        const chat = await dbGet('SELECT id FROM chats WHERE room_id = $1 AND user_id = $2', [roomId, userId]);
        if (chat) {
            await dbRun('DELETE FROM unread WHERE chat_id = $1', [chat.id]);
            await dbRun('DELETE FROM chats WHERE id = $1', [chat.id]);
        }
        // Сокеты этого пользователя больше не должны получать сообщения чата.
        io.in(`user:${userId}`).socketsLeave(chat ? [`room:${roomId}`, `chat:${chat.id}`] : [`room:${roomId}`]);
        return chat;
    }

    // Администратор удаляет участника.
    app.delete('/api/chats/:chatId/members/:userId', async (req, res) => {
        try {
            const chat = await requireGroupAdmin(req, res);
            if (!chat) return;
            const target = targetId(req);
            if (target === req.session.userId) {
                return res.status(400).json({ success: false, message: 'Чтобы уйти самому, выйдите из группы' });
            }
            if (!target || !(await roleIn(chat.room_id, target))) {
                return res.status(404).json({ success: false, message: 'Участник не найден' });
            }
            const removed = await dropParticipant(chat.room_id, target);
            io.to(`user:${target}`).emit('removedFromChat', {
                chat_id: removed ? removed.id : null, room_id: chat.room_id, name: chat.room_name,
            });
            await postSystemMessage({
                roomId: chat.room_id, chatId: chat.id,
                text: `${await usernameOf(req.session.userId)} удалил(а) из группы: ${await usernameOf(target)}`,
            });
            notifyMembersChanged(chat.room_id);
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Remove member error');
            res.status(500).json({ success: false, message: 'Не удалось удалить участника' });
        }
    });

    // Переименовать группу. Название у группы одно на всех, и сменить его
    // может любой участник — все видят, кто это сделал.
    app.post('/api/chats/:chatId/name', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        if (!onlyStrings(req.body && req.body.name)) return res.status(400).json(BAD_FIELDS);
        const title = String((req.body && req.body.name) || '').trim();
        if (!title) return res.status(400).json({ success: false, message: 'Введите название группы' });
        if (title.length > 64) return res.status(400).json({ success: false, message: 'Название группы не может быть длиннее 64 символов' });
        try {
            const chat = await loadGroupChat(req.params.chatId, req.session.userId);
            if (!chat) return notFound(res);
            if (chat.kind !== 'group') return groupOnly(res);
            if (title === chat.room_name) return res.json({ success: true, name: title });
            const avatar = title.charAt(0).toUpperCase();
            await dbRun('UPDATE rooms SET name = $1 WHERE id = $2', [title, chat.room_id]);
            await dbRun('UPDATE chats SET name = $1, avatar = $2 WHERE room_id = $3', [title, avatar, chat.room_id]);
            await postSystemMessage({
                roomId: chat.room_id, chatId: chat.id,
                text: `${await usernameOf(req.session.userId)} переименовал(а) группу: ${title}`,
            });
            io.to(`room:${chat.room_id}`).emit('chatRenamed', { room_id: chat.room_id, name: title, avatar });
            res.json({ success: true, name: title, avatar });
        } catch (error) {
            log.error({ err: error }, 'Rename group error');
            res.status(500).json({ success: false, message: 'Не удалось переименовать группу' });
        }
    });

    app.delete('/api/chats/:chatId', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const chatId = req.params.chatId;
        try {
            const chat = await dbGet('SELECT * FROM chats WHERE id = $1 AND user_id = $2', [chatId, req.session.userId]);
            if (!chat) return res.json({ success: false, message: 'Чат не найден' });

            if (chat.room_id) {
                await dropParticipant(chat.room_id, req.session.userId);
                const remaining = await dbGet('SELECT COUNT(*) as cnt FROM room_participants WHERE room_id = $1', [chat.room_id]);
                if (remaining && Number(remaining.cnt) > 0) {
                    await postSystemMessage({
                        roomId: chat.room_id, chatId: null,
                        text: `${await usernameOf(req.session.userId)} вышел(ла) из чата`,
                    });
                    await promoteIfNeeded(chat.room_id);
                    notifyMembersChanged(chat.room_id);
                    await notifyAdmins(chat.room_id);
                } else {
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
                io.in(`user:${req.session.userId}`).socketsLeave([`chat:${chat.id}`]);
            }
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Delete chat error');
            res.status(500).json({ success: false, message: 'Ошибка удаления чата' });
        }
    });

    /* ------------------------------------------------------------------
       Закрепление, «Без звука», архив
       ------------------------------------------------------------------ */

    const MAX_PINNED = 5;
    const pinsChanged = userId => io.to(`user:${userId}`).emit('chatListChanged');

    /*
     * Закрепить ({ pinned: true }) или открепить. Закреплённый встаёт
     * последним среди закреплённых; открепили — остальные сдвигаются, дыр
     * в порядке нет. Закрепить архивный — значит вернуть его из архива.
     */
    app.post('/api/chats/:chatId/pin', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        if (typeof (req.body && req.body.pinned) !== 'boolean') return res.status(400).json(BAD_FIELDS);
        const userId = req.session.userId;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Два устройства закрепляют разом — по очереди.
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pins:${userId}`]);
            const chat = (await client.query('SELECT id, pin_position FROM chats WHERE id = $1 AND user_id = $2',
                [req.params.chatId, userId])).rows[0];
            if (!chat) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, message: 'Чат не найден' });
            }
            if (req.body.pinned && chat.pin_position === null) {
                const { n } = (await client.query(
                    'SELECT count(*)::int AS n FROM chats WHERE user_id = $1 AND pin_position IS NOT NULL', [userId])).rows[0];
                if (n >= MAX_PINNED) {
                    await client.query('ROLLBACK');
                    return res.status(409).json({ success: false, code: 'PIN_LIMIT', message: `Закрепить можно не больше ${MAX_PINNED} чатов` });
                }
                await client.query('UPDATE chats SET pin_position = $1, archived_at = NULL WHERE id = $2', [n + 1, chat.id]);
            } else if (!req.body.pinned && chat.pin_position !== null) {
                await client.query('UPDATE chats SET pin_position = NULL WHERE id = $1', [chat.id]);
                await client.query(
                    'UPDATE chats SET pin_position = pin_position - 1 WHERE user_id = $1 AND pin_position > $2',
                    [userId, chat.pin_position]);
            }
            await client.query('COMMIT');
            res.json({ success: true, pinned: req.body.pinned });
            pinsChanged(userId);
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            log.error({ err: error }, 'Pin chat error');
            res.status(500).json({ success: false, message: 'Не удалось закрепить чат' });
        } finally {
            client.release();
        }
    });

    // Новый порядок закреплённых: { order: [id чатов] } — ровно те же, что
    // закреплены сейчас.
    app.put('/api/chats/pins', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        const order = req.body && req.body.order;
        if (!Array.isArray(order) || order.length > MAX_PINNED || !order.every(id => Number.isInteger(id) && id > 0)
            || new Set(order).size !== order.length) {
            return res.status(400).json(BAD_FIELDS);
        }
        const userId = req.session.userId;
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`pins:${userId}`]);
            const pinned = (await client.query(
                'SELECT id FROM chats WHERE user_id = $1 AND pin_position IS NOT NULL', [userId])).rows.map(r => r.id);
            if (pinned.length !== order.length || !pinned.every(id => order.includes(id))) {
                await client.query('ROLLBACK');
                return res.status(409).json({ success: false, message: 'Закреплённые чаты изменились — обновите список' });
            }
            for (const [i, id] of order.entries()) {
                await client.query('UPDATE chats SET pin_position = $1 WHERE id = $2 AND user_id = $3', [i + 1, id, userId]);
            }
            await client.query('COMMIT');
            res.json({ success: true });
            pinsChanged(userId);
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            log.error({ err: error }, 'Reorder pins error');
            res.status(500).json({ success: false, message: 'Не удалось изменить порядок' });
        } finally {
            client.release();
        }
    });

    // «Без звука» ({ muted }) и архив ({ archived }): у каждого участника свои.
    // В архив уходит и закреплённый — тогда он открепляется.
    app.post('/api/chats/:chatId/flags', async (req, res) => {
        if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
        const { muted, archived } = req.body || {};
        if ((muted !== undefined && typeof muted !== 'boolean') || (archived !== undefined && typeof archived !== 'boolean')
            || (muted === undefined && archived === undefined)) {
            return res.status(400).json(BAD_FIELDS);
        }
        const userId = req.session.userId;
        try {
            const chat = await dbGet('SELECT id, pin_position FROM chats WHERE id = $1 AND user_id = $2', [req.params.chatId, userId]);
            if (!chat) return res.status(404).json({ success: false, message: 'Чат не найден' });
            if (muted !== undefined) await dbRun('UPDATE chats SET muted = $1 WHERE id = $2', [muted, chat.id]);
            if (archived !== undefined) {
                await dbRun('UPDATE chats SET archived_at = CASE WHEN $1 THEN now() END, pin_position = CASE WHEN $1 THEN NULL ELSE pin_position END WHERE id = $2',
                    [archived, chat.id]);
                if (archived && chat.pin_position !== null) {
                    await dbRun('UPDATE chats SET pin_position = pin_position - 1 WHERE user_id = $1 AND pin_position > $2',
                        [userId, chat.pin_position]);
                }
            }
            res.json({ success: true });
            pinsChanged(userId);
        } catch (error) {
            log.error({ err: error }, 'Chat flags error');
            res.status(500).json({ success: false, message: 'Не удалось изменить настройки чата' });
        }
    });

    app.get('/api/search', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        if (!onlyStrings(req.query.q)) return res.status(400).json(BAD_FIELDS);
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
                const text = !seconds ? `${name} выключил(а) исчезающие сообщения`
                    : before ? `${name} изменил(а) срок исчезающих сообщений: ${expiryLabel(seconds)}`
                        : `${name} включил(а) исчезающие сообщения: ${expiryLabel(seconds)}`;
                await postSystemMessage({ roomId: chat.room_id, chatId: chat.id, text });
                io.to(`room:${chat.room_id}`).emit('chatExpiryChanged', { room_id: chat.room_id, expirySeconds: seconds });
            }

            res.json({ success: true, expirySeconds: seconds });
        } catch (error) {
            log.error({ err: error }, 'Set chat default expiry error');
            res.status(500).json({ success: false, message: 'Ошибка настройки автоудаления' });
        }
    });

    /*
     * Отметки: прочитано (чат открыт, конец переписки на экране) и
     * доставлено (сообщение пришло на устройство). upTo — id последнего
     * сообщения, дальше последнего в чате не сдвигается и назад не идёт.
     */
    for (const kind of ['read', 'delivered']) {
        app.post(`/api/chats/:chatId/${kind}`, async (req, res) => {
            if (!req.session.userId) return res.status(401).json({ success: false, message: 'Не авторизован' });
            const upTo = Number(req.body && req.body.upTo);
            if (!Number.isInteger(upTo) || upTo < 1 || upTo > 2147483647) {
                return res.status(400).json({ success: false, message: 'Некорректный upTo' });
            }
            try {
                const column = kind === 'read' ? 'last_read_id' : 'last_delivered_id';
                // Прочитанное — заодно и доставленное.
                const also = kind === 'read' ? ', last_delivered_id = GREATEST(c.last_delivered_id, t.capped)' : '';
                const updated = await dbGet(
                    `WITH t AS (
                         SELECT LEAST($3::int, COALESCE((SELECT max(m.id) FROM messages m WHERE ${SCOPE}), 0)) AS capped
                         FROM chats c WHERE c.id = $1 AND c.user_id = $2
                     )
                     UPDATE chats c SET ${column} = GREATEST(c.${column}, t.capped)${also}
                     FROM t WHERE c.id = $1 AND c.user_id = $2
                     RETURNING c.room_id, (SELECT COUNT(*) FROM messages m WHERE ${SCOPE} AND m.id > c.last_read_id
                         AND m.deleted = 0 AND m.message_type <> 'system'
                         AND NOT (m.user_id IS NOT DISTINCT FROM c.user_id AND m.sent <> 0))::int AS unread`,
                    [req.params.chatId, req.session.userId, upTo]
                );
                if (!updated) return res.status(404).json({ success: false, message: 'Чат не найден' });
                res.json({ success: true, unread: updated.unread });
                await broadcastReceipts(io, updated.room_id);
            } catch (error) {
                log.error({ err: error }, 'Mark read error');
                if (!res.headersSent) res.status(500).json({ success: false, message: 'Ошибка отметки' });
            }
        });
    }

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

    return { postSystemMessage, resolveEnvelopeRecipients, promoteIfNeeded, notifyMembersChanged, notifyAdmins };
};
