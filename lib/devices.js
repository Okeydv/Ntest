// Реестр устройств пользователя.
//
// Зачем он нужен: ключи E2EE привязаны к устройству, а не к аккаунту (см.
// e2ee-key-server/migrations/0002_device_scoped_keys.sql). Каждое устройство
// имеет свой identity-ключ, свой signed prekey и свой пул one-time prekeys,
// а отправитель шифрует сообщение для каждого устройства получателя
// отдельно. Поэтому у сервера должен быть список устройств: без него
// непонятно, кому раздавать ключи и что отзывать.
//
// ГЛАВНОЕ РЕШЕНИЕ ЭТОГО МОДУЛЯ: device_id хранится в сессии и НИКОГДА не
// принимается из запроса. Альтернатива — брать его из заголовка или тела и
// проверять принадлежность — работает ровно до первого места, где проверку
// забыли: тогда клиент сможет писать ключи в слот чужого устройства, то
// есть подменить собеседника. Здесь подделать нечего: id берётся из
// серверной сессии, а положить его туда можно только через /bind, который
// принадлежность проверяет.

const express = require('express');

const MAX_DEVICE_NAME = 64;

// В приватном режиме multi-device отключён — решение зафиксировано отдельно.
// Ноль устройств при этом недопустим: без устройства не будет и ключей, то
// есть самый приватный режим остался бы единственным без E2EE. Поэтому
// лимит — ровно одно устройство: та сессия, в которой аноним сидит.
const ANONYMOUS_DEVICE_LIMIT = 1;

// И у обычного аккаунта устройств не бесконечно. Каждое — ещё один
// получатель каждого сообщения: без лимита тот, кто узнал пароль, мог бы
// тихо заводить устройства одно за другим. Десяти хватает с запасом.
const MAX_DEVICES = 10;

/**
 * onDeviceAdded(userId, device) — вызывается после регистрации устройства:
 * остальные устройства аккаунта должны узнать о новом сразу, а не когда
 * человек сам заглянет в список.
 */
function createDevicesRouter({ pool, dbGet, dbAll, dbRun, revokeDeviceKeys, onDeviceAdded = null }) {
    const router = express.Router();

    function requireAuth(req, res, next) {
        if (!req.session.userId) {
            return res.status(401).json({ success: false, message: 'Не авторизован' });
        }
        next();
    }

    // Анонимные аккаунты создаются без email и пароля (/api/register/anonymous),
    // поэтому отсутствие email — и есть признак приватного режима. Отдельной
    // колонки is_anonymous в схеме нет, клиент определяет режим так же.
    async function isAnonymous(userId) {
        const row = await dbGet('SELECT email FROM users WHERE id = $1', [userId]);
        return !row || row.email === null || row.email === undefined;
    }

    function sanitizeName(raw) {
        const name = String(raw || '').trim().slice(0, MAX_DEVICE_NAME);
        return name || 'Неизвестное устройство';
    }

    /** POST /api/devices — зарегистрировать текущую сессию как устройство. */
    router.post('/api/devices', requireAuth, async (req, res) => {
        const userId = req.session.userId;
        try {
            const active = await dbAll(
                'SELECT id FROM devices WHERE user_id = $1 AND revoked_at IS NULL',
                [userId]
            );

            if (await isAnonymous(userId) && active.length >= ANONYMOUS_DEVICE_LIMIT) {
                return res.status(403).json({
                    success: false,
                    message: 'В приватном режиме доступно только одно устройство',
                });
            }
            if (active.length >= MAX_DEVICES) {
                return res.status(403).json({
                    success: false,
                    message: `Подключено ${MAX_DEVICES} устройств — больше нельзя. Отзовите лишнее в профиле на другом устройстве.`,
                });
            }

            const result = await pool.query(
                `INSERT INTO devices (user_id, name, created_at, last_seen_at)
                 VALUES ($1, $2, now(), now()) RETURNING id, name, created_at`,
                [userId, sanitizeName(req.body && req.body.name)]
            );
            const device = result.rows[0];

            req.session.deviceId = device.id;
            if (onDeviceAdded) onDeviceAdded(userId, device);
            res.json({ success: true, device });
        } catch (error) {
            console.error('[Devices] Registration error:', error.message);
            res.status(500).json({ success: false, message: 'Не удалось зарегистрировать устройство' });
        }
    });

    /**
     * POST /api/devices/:id/bind — привязать к этой сессии уже
     * существующее устройство.
     *
     * Нужно после повторного входа: приватные ключи остались в хранилище
     * браузера, а сессия новая, и серверу надо заново сказать, какое это
     * устройство. Единственное место, где id приходит извне, — поэтому
     * принадлежность и статус отзыва проверяются здесь.
     */
    router.post('/api/devices/:id/bind', requireAuth, async (req, res) => {
        const deviceId = Number(req.params.id);
        if (!Number.isInteger(deviceId) || deviceId <= 0) {
            return res.status(400).json({ success: false, message: 'Некорректный id устройства' });
        }
        try {
            const device = await dbGet(
                'SELECT id, revoked_at FROM devices WHERE id = $1 AND user_id = $2',
                [deviceId, req.session.userId]
            );
            // Один и тот же 404 и когда устройства нет, и когда оно чужое:
            // иначе по коду ответа можно перебором узнать, какие id заняты.
            if (!device) {
                return res.status(404).json({ success: false, message: 'Устройство не найдено' });
            }
            if (device.revoked_at) {
                return res.status(403).json({ success: false, message: 'Устройство отозвано' });
            }

            await dbRun('UPDATE devices SET last_seen_at = now() WHERE id = $1', [deviceId]);
            req.session.deviceId = deviceId;
            res.json({ success: true, device: { id: deviceId } });
        } catch (error) {
            console.error('[Devices] Bind error:', error.message);
            res.status(500).json({ success: false, message: 'Не удалось привязать устройство' });
        }
    });

    /** GET /api/devices — список своих устройств. */
    router.get('/api/devices', requireAuth, async (req, res) => {
        try {
            const devices = await dbAll(
                `SELECT id, name, created_at, last_seen_at, revoked_at
                 FROM devices WHERE user_id = $1 ORDER BY created_at ASC`,
                [req.session.userId]
            );
            res.json({
                success: true,
                currentDeviceId: req.session.deviceId || null,
                devices,
            });
        } catch (error) {
            console.error('[Devices] List error:', error.message);
            res.status(500).json({ success: false, message: 'Не удалось получить список устройств' });
        }
    });

    /**
     * DELETE /api/devices/:id — отозвать устройство.
     *
     * Строка помечается revoked_at, а не удаляется: id устройства
     * встречается в ключевом материале и (в дальнейшем) в конвертах
     * сообщений, и переиспользовать его нельзя.
     *
     * ВАЖНО, что здесь НЕ делается: в схеме sender keys отозванное
     * устройство продолжит расшифровывать групповые сообщения теми
     * групповыми ключами, которые уже получило. Удаление ключевого
     * материала это не отменяет. Полноценный отзыв обязан вызвать ротацию
     * sender key у всех участников общих групп — этого кода ещё нет,
     * потому что нет и самих sender keys. Здесь стоит явное напоминание,
     * чтобы при добавлении групп этот шаг не потерялся.
     */
    router.delete('/api/devices/:id', requireAuth, async (req, res) => {
        const deviceId = Number(req.params.id);
        if (!Number.isInteger(deviceId) || deviceId <= 0) {
            return res.status(400).json({ success: false, message: 'Некорректный id устройства' });
        }
        try {
            const device = await dbGet(
                'SELECT id, revoked_at FROM devices WHERE id = $1 AND user_id = $2',
                [deviceId, req.session.userId]
            );
            if (!device) {
                return res.status(404).json({ success: false, message: 'Устройство не найдено' });
            }

            if (!device.revoked_at) {
                await dbRun('UPDATE devices SET revoked_at = now() WHERE id = $1', [deviceId]);
            }
            // Ключи групп, которые отозванное устройство не успело забрать,
            // ему больше не достанутся. Отправители сменят sender keys сами:
            // устройство пропадёт из списка получателей.
            await dbRun('DELETE FROM sender_key_envelopes WHERE recipient_device_id = $1', [deviceId]);

            // Ключи чистятся после отметки об отзыве: если key-server
            // недоступен, устройство всё равно уже помечено отозванным и не
            // сможет привязаться к сессии.
            const keysRemoved = await revokeDeviceKeys(req.session.userId, deviceId);

            if (req.session.deviceId === deviceId) {
                delete req.session.deviceId;
            }

            res.json({
                success: true,
                keysRemoved,
                message: keysRemoved
                    ? 'Устройство отозвано'
                    : 'Устройство отозвано, но ключи на key-server удалить не удалось',
            });
        } catch (error) {
            console.error('[Devices] Revoke error:', error.message);
            res.status(500).json({ success: false, message: 'Не удалось отозвать устройство' });
        }
    });

    return router;
}

module.exports = { createDevicesRouter, MAX_DEVICE_NAME, ANONYMOUS_DEVICE_LIMIT, MAX_DEVICES };
