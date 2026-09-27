'use strict';

// Личные чаты: код пользователя, запросы на переписку и блокировка.
//
// Личный чат начинается с запроса: по коду пользователя (или QR при
// встрече) уходит запрос без текста, получатель видит «Анна хочет
// переписываться» и решает — «Принять», «Отклонить» или «Заблокировать».
// Отправитель не узнаёт, видели ли его запрос: отклонённый для него
// выглядит так же, как ждущий.

const { log } = require('../lib/log');
const { pool, dbGet, dbAll, dbRun } = require('../lib/db');
const { onlyStrings, BAD_FIELDS } = require('../lib/helpers');
const { codeLookupLimiter } = require('../lib/rate-limits');
const { randomCode, normalizeCode, isCode, formatUserCode } = require('../lib/codes');

// Одинаковый ответ на «такого кода нет», «запросы выключены» и «вас
// заблокировали»: по ответу нельзя понять, существует ли человек.
const CODE_NOT_FOUND = {
    success: false, code: 'CODE_NOT_FOUND', message: 'Такого кода нет, или человек не принимает запросы',
};

// Сколько запросов на переписку можно отправить за сутки.
const DIRECT_REQUESTS_PER_DAY = Number(process.env.DIRECT_REQUESTS_PER_DAY) || 20;

module.exports = function registerContactRoutes(app, ctx) {
    const { io } = ctx;
    const unauthorized = res => res.status(401).json({ success: false, message: 'Не авторизован' });
    const idParam = value => (/^\d{1,10}$/.test(String(value)) ? Number(value) : null);

    /* ------------------------------------------------------------------
       Свой код
       ------------------------------------------------------------------ */

    app.get('/api/user/code', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        try {
            const me = await dbGet('SELECT unique_code, code_requests_enabled FROM users WHERE id = $1', [req.session.userId]);
            res.json({ success: true, code: formatUserCode(me.unique_code), requestsEnabled: me.code_requests_enabled });
        } catch (error) {
            log.error({ err: error }, 'Get user code error');
            res.status(500).json({ success: false, message: 'Не удалось получить код' });
        }
    });

    // «Сменить код»: прежний сразу перестаёт находить.
    app.post('/api/user/code', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        try {
            for (let attempt = 0; ; attempt++) {
                const code = randomCode();
                try {
                    await dbRun('UPDATE users SET unique_code = $1 WHERE id = $2', [code, req.session.userId]);
                    req.session.uniqueCode = code;
                    return res.json({ success: true, code: formatUserCode(code) });
                } catch (err) {
                    if (err.code !== '23505' || attempt > 3) throw err;
                }
            }
        } catch (error) {
            log.error({ err: error }, 'Rotate user code error');
            res.status(500).json({ success: false, message: 'Не удалось сменить код' });
        }
    });

    // «Запросы по коду»: выключены — по коду человека не найти.
    app.post('/api/user/code-requests', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        if (typeof (req.body && req.body.enabled) !== 'boolean') return res.status(400).json(BAD_FIELDS);
        try {
            await dbRun('UPDATE users SET code_requests_enabled = $1 WHERE id = $2', [req.body.enabled, req.session.userId]);
            res.json({ success: true, requestsEnabled: req.body.enabled });
        } catch (error) {
            log.error({ err: error }, 'Code requests toggle error');
            res.status(500).json({ success: false, message: 'Не удалось сохранить настройку' });
        }
    });

    /* ------------------------------------------------------------------
       Поиск по коду и личный чат
       ------------------------------------------------------------------ */

    // Кого можно найти по коду: код есть, запросы включены, этот человек
    // не заблокировал ищущего. Иначе null — и ответ один на всё.
    async function findByCode(input, meId) {
        const code = normalizeCode(input);
        if (!isCode(code)) return null;
        return dbGet(
            `SELECT u.id, u.username FROM users u
             WHERE u.unique_code = $1 AND u.code_requests_enabled
               AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = u.id AND b.blocked_id = $2)`,
            [code, meId]);
    }

    // Личный чат двоих, если он уже есть (и в нём оба): запись чата a.
    async function directChatBetween(a, b) {
        return dbGet(
            `SELECT c.id, c.room_id FROM chats c JOIN rooms r ON r.id = c.room_id
             WHERE c.user_id = $1 AND r.kind = 'direct'
               AND EXISTS (SELECT 1 FROM room_participants rp WHERE rp.room_id = r.id AND rp.user_id = $2)
             LIMIT 1`, [a, b]);
    }

    const iBlocked = async (me, other) => Boolean(await dbGet(
        'SELECT 1 FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [me, other]));

    /*
     * Личный чат: комната вида direct на двоих, у каждого своя запись чата
     * с именем собеседника. Названия у личного чата нет — это имя.
     */
    async function createDirectChat(a, b) {
        const [ua, ub] = [await dbGet('SELECT id, username FROM users WHERE id = $1', [a]),
            await dbGet('SELECT id, username FROM users WHERE id = $1', [b])];
        const client = await pool.connect();
        const chats = {};
        let roomId;
        try {
            await client.query('BEGIN');
            roomId = (await client.query(
                "INSERT INTO rooms (name, code, kind) VALUES ($1, NULL, 'direct') RETURNING id",
                [`${ua.username} и ${ub.username}`])).rows[0].id;
            for (const [me, peer] of [[ua, ub], [ub, ua]]) {
                await client.query("INSERT INTO room_participants (room_id, user_id, role) VALUES ($1, $2, 'member')", [roomId, me.id]);
                chats[me.id] = (await client.query(
                    'INSERT INTO chats (user_id, room_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, 0, 0) RETURNING id',
                    [me.id, roomId, peer.username, peer.username.charAt(0).toUpperCase()])).rows[0].id;
            }
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
        return { roomId, chats, users: { [a]: ua, [b]: ub } };
    }

    // Принять запрос: личный чат (или тот, что уже есть) и событие
    // отправителю — у него чат появится сразу.
    async function acceptRequest(request) {
        const existing = await directChatBetween(request.to_user_id, request.from_user_id);
        let chatFor;
        if (existing) {
            const theirs = await directChatBetween(request.from_user_id, request.to_user_id);
            chatFor = { [request.to_user_id]: existing.id, [request.from_user_id]: theirs && theirs.id };
        } else {
            const created = await createDirectChat(request.to_user_id, request.from_user_id);
            chatFor = created.chats;
            await ctx.postSystemMessage({
                roomId: created.roomId, chatId: created.chats[request.to_user_id],
                text: `${created.users[request.to_user_id].username} принял(а) запрос на переписку`,
            });
        }
        io.to(`user:${request.from_user_id}`).emit('directRequestAccepted', {
            request_id: request.id, chat: chatFor[request.from_user_id] ? { id: chatFor[request.from_user_id] } : null,
        });
        io.to(`user:${request.to_user_id}`).emit('directRequestsChanged');
        return chatFor;
    }

    // Что знает о коде ищущий: имя и есть ли уже с ним чат. Для «Найти»
    // перед отправкой запроса и для QR при встрече (там нужен ещё id, чтобы
    // сверить ключи с тем, что в QR).
    app.post('/api/contacts/lookup', codeLookupLimiter, async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        if (!onlyStrings(req.body && req.body.code)) return res.status(400).json(BAD_FIELDS);
        try {
            const me = req.session.userId;
            const user = await findByCode(req.body.code, me);
            if (!user) return res.json(CODE_NOT_FOUND);
            if (user.id === me) return res.json({ success: false, code: 'OWN_CODE', message: 'Это ваш собственный код' });
            const chat = await directChatBetween(me, user.id);
            res.json({ success: true, user: { id: user.id, username: user.username }, chat: chat ? { id: chat.id } : null });
        } catch (error) {
            log.error({ err: error }, 'Code lookup error');
            res.status(500).json({ success: false, message: 'Не удалось найти' });
        }
    });

    app.post('/api/direct-requests', codeLookupLimiter, async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        if (!onlyStrings(req.body && req.body.code)) return res.status(400).json(BAD_FIELDS);
        const me = req.session.userId;
        try {
            const user = await findByCode(req.body.code, me);
            if (!user) return res.json(CODE_NOT_FOUND);
            if (user.id === me) return res.json({ success: false, code: 'OWN_CODE', message: 'Это ваш собственный код' });
            const chat = await directChatBetween(me, user.id);
            if (chat) return res.json({ success: true, chat: { id: chat.id } });
            if (await iBlocked(me, user.id)) {
                return res.json({ success: false, code: 'YOU_BLOCKED', message: 'Вы заблокировали этого человека — сначала разблокируйте его в профиле' });
            }
            // Он уже просил о том же — это согласие с обеих сторон.
            const reverse = await dbGet(
                `UPDATE direct_requests SET status = 'accepted', decided_at = now()
                 WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending' RETURNING *`, [user.id, me]);
            if (reverse) {
                const chats = await acceptRequest(reverse);
                return res.json({ success: true, chat: { id: chats[me] } });
            }
            // Уже просил, и запрос ждёт или отклонён — для отправителя это
            // одно и то же, нового запроса (и уведомления) нет.
            const earlier = await dbGet(
                `SELECT id, created_at FROM direct_requests WHERE from_user_id = $1 AND to_user_id = $2
                   AND status IN ('pending', 'declined') ORDER BY id DESC LIMIT 1`, [me, user.id]);
            if (earlier) {
                return res.json({ success: true, pending: true, request: { id: earlier.id, username: user.username, created_at: earlier.created_at } });
            }
            const today = (await dbGet(
                "SELECT count(*)::int AS n FROM direct_requests WHERE from_user_id = $1 AND created_at > now() - interval '1 day'", [me])).n;
            if (today >= DIRECT_REQUESTS_PER_DAY) {
                return res.status(429).json({ success: false, code: 'DAILY_LIMIT', message: 'На сегодня запросов достаточно — попробуйте завтра' });
            }
            const created = await dbGet(
                `INSERT INTO direct_requests (from_user_id, to_user_id) VALUES ($1, $2)
                 ON CONFLICT (from_user_id, to_user_id) WHERE status = 'pending' DO NOTHING RETURNING id, created_at`, [me, user.id])
                || await dbGet("SELECT id, created_at FROM direct_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'", [me, user.id]);
            io.to(`user:${user.id}`).emit('directRequestsChanged');
            res.json({ success: true, pending: true, request: { id: created.id, username: user.username, created_at: created.created_at } });
        } catch (error) {
            log.error({ err: error }, 'Direct request error');
            res.status(500).json({ success: false, message: 'Не удалось отправить запрос' });
        }
    });

    // Входящие — с кнопками; исходящие — «ждёт ответа», отклонённые тоже.
    app.get('/api/direct-requests', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        try {
            const incoming = await dbAll(
                `SELECT dr.id, dr.from_user_id AS user_id, u.username, dr.created_at FROM direct_requests dr
                 JOIN users u ON u.id = dr.from_user_id
                 WHERE dr.to_user_id = $1 AND dr.status = 'pending' ORDER BY dr.id`, [req.session.userId]);
            const outgoing = await dbAll(
                `SELECT dr.id, u.username, dr.created_at FROM direct_requests dr
                 JOIN users u ON u.id = dr.to_user_id
                 WHERE dr.from_user_id = $1 AND dr.status IN ('pending', 'declined') ORDER BY dr.id`, [req.session.userId]);
            res.json({ success: true, incoming, outgoing });
        } catch (error) {
            log.error({ err: error }, 'List direct requests error');
            res.status(500).json({ success: false, message: 'Не удалось получить запросы' });
        }
    });

    // «Принять», «Отклонить», «Заблокировать» — только получателю.
    app.post('/api/direct-requests/:id', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        const action = req.body && req.body.action;
        if (!['accept', 'decline', 'block'].includes(action)) return res.status(400).json({ success: false, message: 'Неизвестное действие' });
        const id = idParam(req.params.id);
        const notFound = () => res.status(404).json({ success: false, message: 'Запрос не найден' });
        if (!id) return notFound();
        try {
            const request = await dbGet(
                `UPDATE direct_requests SET status = $1, decided_at = now()
                 WHERE id = $2 AND to_user_id = $3 AND status = 'pending' RETURNING *`,
                [action === 'accept' ? 'accepted' : 'declined', id, req.session.userId]);
            if (!request) return notFound();
            if (action === 'block') {
                await dbRun('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                    [req.session.userId, request.from_user_id]);
            }
            if (action !== 'accept') return res.json({ success: true });
            const chats = await acceptRequest(request);
            res.json({ success: true, chat: { id: chats[req.session.userId] } });
        } catch (error) {
            log.error({ err: error }, 'Decide direct request error');
            res.status(500).json({ success: false, message: 'Не удалось обработать запрос' });
        }
    });

    // Отправитель отзывает свой запрос.
    app.delete('/api/direct-requests/:id', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        const id = idParam(req.params.id);
        try {
            const cancelled = id && await dbGet(
                `UPDATE direct_requests SET status = 'cancelled', decided_at = now()
                 WHERE id = $1 AND from_user_id = $2 AND status IN ('pending', 'declined') RETURNING to_user_id, status`,
                [id, req.session.userId]);
            if (!cancelled) return res.status(404).json({ success: false, message: 'Запрос не найден' });
            io.to(`user:${cancelled.to_user_id}`).emit('directRequestsChanged');
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Cancel direct request error');
            res.status(500).json({ success: false, message: 'Не удалось отменить запрос' });
        }
    });

    /* ------------------------------------------------------------------
       Блокировка
       ------------------------------------------------------------------ */

    app.get('/api/blocks', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        try {
            const blocked = await dbAll(
                `SELECT b.blocked_id AS user_id, u.username, b.created_at FROM blocks b JOIN users u ON u.id = b.blocked_id
                 WHERE b.blocker_id = $1 ORDER BY b.created_at`, [req.session.userId]);
            res.json({ success: true, blocked });
        } catch (error) {
            log.error({ err: error }, 'List blocks error');
            res.status(500).json({ success: false, message: 'Не удалось получить список' });
        }
    });

    // Заблокировать можно того, с кем есть общий чат или от кого был запрос:
    // перебирать чужие id незачем.
    app.post('/api/blocks', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        const target = idParam(req.body && req.body.userId);
        const me = req.session.userId;
        if (!target || target === me) return res.status(400).json({ success: false, message: 'Некого блокировать' });
        try {
            const known = await dbGet(
                `SELECT 1 WHERE EXISTS (SELECT 1 FROM room_participants a JOIN room_participants b ON a.room_id = b.room_id
                                        WHERE a.user_id = $1 AND b.user_id = $2)
                            OR EXISTS (SELECT 1 FROM direct_requests WHERE from_user_id = $2 AND to_user_id = $1)`, [me, target]);
            if (!known) return res.status(404).json({ success: false, message: 'Пользователь не найден' });
            await dbRun('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [me, target]);
            // Его ждущие запросы больше не нужны.
            await dbRun(
                `UPDATE direct_requests SET status = 'declined', decided_at = now()
                 WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'`, [target, me]);
            io.to(`user:${me}`).emit('directRequestsChanged');
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Block error');
            res.status(500).json({ success: false, message: 'Не удалось заблокировать' });
        }
    });

    app.delete('/api/blocks/:userId', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        const target = idParam(req.params.userId);
        try {
            if (target) await dbRun('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.session.userId, target]);
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Unblock error');
            res.status(500).json({ success: false, message: 'Не удалось разблокировать' });
        }
    });

    return { directChatBetween };
};
