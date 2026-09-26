'use strict';

// Регистрация, вход, приватный режим, выход, профиль и смена пароля.

const { log } = require('../lib/log');
const { pool, dbGet, dbAll, dbRun } = require('../lib/db');
const { secureCookieFor } = require('../lib/cookie-security');
const { addRandomDelay, generateSecureToken } = require('../lib/privacy');
const e2eeProxy = require('../lib/e2ee-proxy');
const { hashPassword, checkPassword, DUMMY_PASSWORD_HASH, PASSWORD_PREFIX } = require('../lib/passwords');
const { loginLimiter, loginEmailLimiter, registerLimiter, passwordLimiter } = require('../lib/rate-limits');
const {
    getCurrentTime, normalizeAvatarColor, generateUniqueCodeAsync, generateAnonymousUsernameAsync,
} = require('../lib/helpers');


module.exports = function registerAuthRoutes(app, ctx) {
    const { io } = ctx;

    /**
     * Начать сессию с новым id — при регистрации так же, как при входе. Иначе
     * id сессии, известный до входа (подброшенный в куку или подсмотренный),
     * после входа давал бы доступ к аккаунту.
     */
    function startSession(req, values) {
        return new Promise((resolve, reject) => req.session.regenerate(err => {
            if (err) return reject(err);
            // regenerate создаёт куку заново, с настройками по умолчанию, — а
            // Secure зависит от адреса (у .onion его нет).
            req.session.cookie.secure = secureCookieFor(req);
            Object.assign(req.session, values);
            resolve();
        }));
    }

    /** Отключить открытые сокеты: сессия уже удалена, а они об этом не знают. */
    function disconnectSockets(room) {
        io.in(room).disconnectSockets(true);
    }

    app.post('/api/register', registerLimiter, async (req, res) => {
        const { username, email, password, confirmPassword } = req.body;
        if (!username || !email || !password || !confirmPassword)
            return res.json({ success: false, message: 'Заполните все поля' });
        if (username.length > 32)
            return res.json({ success: false, message: 'Имя не может быть длиннее 32 символов' });
        if (email.length > 254)
            return res.json({ success: false, message: 'Email слишком длинный' });
        if (password.length > 128)
            return res.json({ success: false, message: 'Пароль не может быть длиннее 128 символов' });
        if (password !== confirmPassword)
            return res.json({ success: false, message: 'Пароли не совпадают' });
        if (password.length < 8)
            return res.json({ success: false, message: 'Пароль должен быть не менее 8 символов' });
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
            return res.json({ success: false, message: 'Введите корректный email' });

        try {
            const existing = await dbGet('SELECT id FROM users WHERE email = $1 OR username = $2', [email, username]);
            if (existing) return res.json({ success: false, message: 'Ошибка регистрации. Проверьте введённые данные.' });

            const uniqueCode = await generateUniqueCodeAsync();
            const hashedPassword = await hashPassword(password);

            const client = await pool.connect();
            let userId;
            try {
                await client.query('BEGIN');
                const userResult = await client.query(
                    'INSERT INTO users (unique_code, username, email, password, avatar) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                    [uniqueCode, username, email, hashedPassword, '#667EEA']
                );
                userId = userResult.rows[0].id;

                const botResult = await client.query(
                    'INSERT INTO chats (user_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                    [userId, 'Бот Помощник', 'Б', 1, 1]
                );
                const botChatId = botResult.rows[0].id;
                await client.query(
                    'INSERT INTO messages (chat_id, user_id, text, sent, time, status) VALUES ($1, $2, $3, $4, $5, $6)',
                    [botChatId, userId, 'Привет! Я бот-помощник. Чем могу помочь?', 0, getCurrentTime(), 'read']
                );
                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            } finally {
                client.release();
            }

            await startSession(req, { userId, username, uniqueCode, avatar: '#667EEA' });

            res.json({ success: true, message: 'Регистрация успешна!', user: { id: userId, username, uniqueCode, avatar: '#667EEA' } });
        } catch (error) {
            log.error({ err: error }, 'Register error');
            res.status(500).json({ success: false, message: 'Ошибка сервера' });
        }
    });

    app.post('/api/register/anonymous', registerLimiter, async (req, res) => {
        try {
            // Раньше код и имя выдавал отдельный сервис на Rust, слушавший все
            // сетевые интерфейсы. Случайную строку Node делает и сам.
            const uniqueCode = await generateUniqueCodeAsync();
            const username = await generateAnonymousUsernameAsync();

            // Генерация уникального session fingerprint для анонимного пользователя
            const sessionFingerprint = generateSecureToken(32);

            const client = await pool.connect();
            let userId;
            try {
                await client.query('BEGIN');
                const userResult = await client.query(
                    'INSERT INTO users (unique_code, username, email, password, avatar) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                    [uniqueCode, username, null, null, '#667EEA']
                );
                userId = userResult.rows[0].id;

                const botResult = await client.query(
                    'INSERT INTO chats (user_id, name, avatar, online, is_bot) VALUES ($1, $2, $3, $4, $5) RETURNING id',
                    [userId, 'Бот Помощник', 'Б', 1, 1]
                );
                const botChatId = botResult.rows[0].id;
                await client.query(
                    'INSERT INTO messages (chat_id, user_id, text, sent, time, status) VALUES ($1, $2, $3, $4, $5, $6)',
                    [botChatId, userId, '🔒 Приватный режим активирован!\n\nВаши данные:\n• Хранятся только в этой сессии\n• Будут удалены при выходе\n• Не связаны с email или телефоном\n\nДля максимальной анонимности:\n• Используйте Tor Browser\n• Не делитесь личной информацией\n• Включите disappearing messages', 0, getCurrentTime(), 'read']
                );
                await client.query('COMMIT');
            } catch (txErr) {
                await client.query('ROLLBACK');
                throw txErr;
            } finally {
                client.release();
            }

            await startSession(req, {
                userId, username, uniqueCode, avatar: '#667EEA',
                isAnonymous: true, sessionFingerprint, createdAt: Date.now(),
            });

            // Устанавливаем короткий срок жизни сессии для анонимных пользователей
            req.session.cookie.maxAge = 4 * 60 * 60 * 1000; // 4 часа

            res.json({
                success: true,
                message: 'Приватный режим активирован!',
                user: {
                    id: userId,
                    username,
                    uniqueCode,
                    avatar: '#667EEA',
                    isAnonymous: true,
                    sessionExpiresIn: 4 * 60 * 60 // секунды
                }
            });
        } catch (error) {
            log.error({ err: error }, 'Anonymous register error');
            res.status(500).json({ success: false, message: 'Ошибка сервера' });
        }
    });

    app.post('/api/login', loginLimiter, loginEmailLimiter, async (req, res) => {
        const { email, password } = req.body;
        if (!email || !password) return res.json({ success: false, message: 'Введите email и пароль' });
        if (email.length > 254 || password.length > 128) return res.json({ success: false, message: 'Неверный email или пароль' });

        try {
            // Добавляем случайную задержку для защиты от timing attacks
            await addRandomDelay(50, 150);

            const user = await dbGet('SELECT * FROM users WHERE email = $1', [email]);
            // bcrypt.compare выполняется независимо от того, найден ли юзер —
            // это убирает разницу во времени ответа между "нет такого email"
            // и "неверный пароль" (см. п.4 аудита).
            const hashToCheck = (user && user.password) ? user.password : DUMMY_PASSWORD_HASH;
            const validPassword = await checkPassword(password, hashToCheck);

            // Дополнительная случайная задержка
            await addRandomDelay(20, 80);

            if (!user || !user.password || !validPassword) {
                return res.json({ success: false, message: 'Неверный email или пароль' });
            }
            res.locals.loggedIn = true;
            if (!user.password.startsWith(PASSWORD_PREFIX)) {
                await dbRun('UPDATE users SET password = $1 WHERE id = $2', [await hashPassword(password), user.id]);
            }

            try {
                await startSession(req, {
                    userId: user.id, username: user.username, uniqueCode: user.unique_code, avatar: user.avatar || '',
                });
            } catch (error) {
                log.error({ err: error }, 'Session start error');
                return res.status(500).json({ success: false, message: 'Ошибка инициализации сессии' });
            }
            res.json({ success: true, message: 'Вход выполнен!', user: { id: user.id, username: user.username, uniqueCode: user.unique_code, avatar: user.avatar || '' } });
        } catch (error) {
            log.error({ err: error }, 'Login error');
            res.status(500).json({ success: false, message: 'Ошибка базы данных' });
        }
    });

    /**
     * Удалить анонимный аккаунт со всем содержимым. Ключи — первыми: после
     * удаления пользователя строки devices уйдут по ON DELETE CASCADE, и
     * отзывать станет нечего, а ключи останутся висеть в схеме key-server,
     * у которой нет внешнего ключа на users.
     */
    async function deleteAnonymousAccount(userId) {
        // Участники его комнат должны увидеть, что он ушёл: его сообщения
        // исчезают вместе с аккаунтом.
        const user = await dbGet('SELECT username FROM users WHERE id = $1', [userId]);
        const rooms = await dbAll(
            `SELECT DISTINCT rp.room_id FROM room_participants rp
             WHERE rp.user_id = $1
               AND EXISTS (SELECT 1 FROM room_participants o WHERE o.room_id = rp.room_id AND o.user_id <> $1)`,
            [userId]
        );
        for (const { room_id: roomId } of rooms) {
            await ctx.postSystemMessage({ roomId, chatId: null, text: `${user ? user.username : 'Участник'} вышел(ла) из чата` });
        }
        await e2eeProxy.revokeAllKeys(userId);
        await dbRun('DELETE FROM devices WHERE user_id = $1', [userId]);
        await dbRun('DELETE FROM messages WHERE user_id = $1', [userId]);
        await dbRun('DELETE FROM chats WHERE user_id = $1', [userId]);
        await dbRun('DELETE FROM room_participants WHERE user_id = $1', [userId]);
        await dbRun('DELETE FROM reactions WHERE user_id = $1', [userId]);
        await dbRun('DELETE FROM users WHERE id = $1', [userId]);
    }

    // Анонимный аккаунт живёт, пока жива его сессия (4 часа). Кнопкой «Выйти»
    // он удаляется сразу; раньше только ею — и если вкладку просто закрывали,
    // аккаунт с перепиской оставался на сервере навсегда. Теперь его находит
    // уборка: пароля и почты нет, живой сессии тоже. Десять минут форы — чтобы
    // не удалить аккаунт, сессия которого ещё не успела записаться.
    // Переменная окружения — для тестов: ждать десять минут там незачем.
    const ANON_SWEEP_INTERVAL_MS = Number(process.env.ANON_SWEEP_INTERVAL_MS) || 10 * 60 * 1000;

    async function sweepAnonymousAccounts() {
        try {
            const stale = await dbAll(
                `SELECT u.id FROM users u
                 WHERE u.email IS NULL AND u.password IS NULL
                   AND u.created_at < NOW() - INTERVAL '10 minutes'
                   AND NOT EXISTS (SELECT 1 FROM "session" s
                                   WHERE s.sess->>'userId' = u.id::text AND s.expire > NOW())`
            );
            for (const { id } of stale) {
                await deleteAnonymousAccount(id);
                disconnectSockets(`user:${id}`);
            }
            if (stale.length) log.info({ count: stale.length }, '[Anon] Удалены брошенные анонимные аккаунты');
        } catch (error) {
            // Таблицу сессий создаёт connect-pg-simple при первом входе — до
            // него убирать и некого.
            if (error.code !== '42P01') log.error({ err: error }, '[Anon] Sweep error');
        }
    }

    setInterval(sweepAnonymousAccounts, ANON_SWEEP_INTERVAL_MS).unref();

    app.post('/api/logout', async (req, res) => {
        const isAnonymous = req.session?.isAnonymous;
        const userId = req.session?.userId;

        if (isAnonymous && userId) {
            try {
                await deleteAnonymousAccount(userId);
            } catch (error) {
                log.error({ err: error }, '[Anon] Cleanup error');
            }
        }

        // Анонимный аккаунт удалён целиком — отключаем все его сокеты, обычный —
        // только сокеты этой сессии: на других устройствах вход остаётся.
        disconnectSockets(isAnonymous && userId ? `user:${userId}` : `session:${req.sessionID}`);
        req.session.destroy((err) => {
            res.clearCookie('connect.sid');
            res.clearCookie('csrf_token');
            if (err) log.error({ err: err }, 'Logout session destroy error');
            res.json({ success: true, message: isAnonymous ? 'Данные удалены' : 'Выход выполнен' });
        });
    });

    // Ничего не отдаёт: кука csrf_token выставляется общим обработчиком выше
    // на любом запросе, где её нет. Клиент зовёт это после выхода, когда
    // сервер куку стёр.
    app.get('/api/csrf', (req, res) => res.json({ success: true }));

    app.get('/api/auth', async (req, res) => {
        if (!req.session.userId) return res.json({ authenticated: false });
        try {
            const row = await dbGet('SELECT avatar FROM users WHERE id = $1', [req.session.userId]);
            if (!row && req.session.isAnonymous) {
                // Анонимный пользователь был удален, очищаем сессию
                req.session.destroy(() => {});
                return res.json({ authenticated: false, expired: true });
            }
            if (!row) return res.json({ authenticated: false });

            const avatar = row ? (row.avatar || '') : (req.session.avatar || '');
            req.session.avatar = avatar;

            // Проверка времени жизни анонимной сессии
            if (req.session.isAnonymous && req.session.createdAt) {
                const sessionAge = Date.now() - req.session.createdAt;
                const maxAge = 4 * 60 * 60 * 1000; // 4 часа
                if (sessionAge > maxAge) {
                    return res.json({
                        authenticated: false,
                        expired: true,
                        message: 'Анонимная сессия истекла'
                    });
                }
            }

            res.json({
                authenticated: true,
                user: {
                    id: req.session.userId,
                    username: req.session.username,
                    uniqueCode: req.session.uniqueCode,
                    avatar,
                    isAnonymous: req.session.isAnonymous || false
                }
            });
        } catch (error) {
            res.json({ authenticated: false });
        }
    });

    app.get('/api/user', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false });
        try {
            const user = await dbGet('SELECT id, unique_code, username, email, avatar, created_at FROM users WHERE id = $1', [req.session.userId]);
            if (!user) return res.json({ success: false });
            res.json({ success: true, user: { id: user.id, uniqueCode: user.unique_code, username: user.username, avatar: user.avatar || '', email: user.email, createdAt: user.created_at } });
        } catch (error) {
            res.json({ success: false });
        }
    });

    app.post('/api/user/avatar-color', async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const avatarColor = normalizeAvatarColor(req.body && req.body.avatarColor);
        try {
            await dbRun('UPDATE users SET avatar = $1 WHERE id = $2', [avatarColor, req.session.userId]);
            req.session.avatar = avatarColor;
            res.json({ success: true, avatar: avatarColor });
        } catch (error) {
            log.error({ err: error }, 'Avatar update error');
            res.status(500).json({ success: false, message: 'Ошибка обновления цвета аватара' });
        }
    });

    app.post('/api/change-password', passwordLimiter, async (req, res) => {
        if (!req.session.userId) return res.json({ success: false, message: 'Не авторизован' });
        const { currentPassword, newPassword, confirmPassword } = req.body;
        if (!currentPassword || !newPassword || !confirmPassword) return res.json({ success: false, message: 'Заполните все поля' });
        if (newPassword !== confirmPassword) return res.json({ success: false, message: 'Новые пароли не совпадают' });
        if (newPassword.length < 8) return res.json({ success: false, message: 'Пароль должен быть не менее 8 символов' });
        if (newPassword.length > 128 || currentPassword.length > 128) {
            return res.json({ success: false, message: 'Пароль не может быть длиннее 128 символов' });
        }

        try {
            const user = await dbGet('SELECT password FROM users WHERE id = $1', [req.session.userId]);
            if (!user) return res.json({ success: false, message: 'Пользователь не найден' });
            if (!user.password) return res.json({ success: false, message: 'У этого аккаунта нет пароля (приватный режим)' });
            const validPassword = await checkPassword(currentPassword, user.password);
            if (!validPassword) return res.json({ success: false, message: 'Неверный текущий пароль' });
            const hashedPassword = await hashPassword(newPassword);
            const userId = req.session.userId;

            await dbRun('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, userId]);
            // Пароль меняют чаще всего, когда он утёк. Значит, выйти надо везде:
            // сессия, открытая по старому паролю, иначе живёт до истечения срока.
            await dbRun(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [String(userId)]);
            disconnectSockets(`user:${userId}`);

            req.session.destroy((err) => {
                res.clearCookie('connect.sid');
                if (err) log.error({ err: err }, 'Session destroy error on password change');
                res.json({ success: true, message: 'Пароль успешно изменён. Войдите заново.' });
            });
        } catch (error) {
            log.error({ err: error }, 'Change password error');
            res.status(500).json({ success: false, message: 'Ошибка изменения пароля' });
        }
    });
};
