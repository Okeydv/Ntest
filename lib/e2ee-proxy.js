// Прокси к e2ee-key-server.
//
// Rust-сервис слушает только loopback и не знает ничего про пользователей:
// он доверяет заголовкам X-User-Id и X-Device-Id, которые подставляет этот
// модуль после проверки сессии. Поэтому здесь и только здесь решается, от
// чьего имени идёт операция с ключами.
//
// device_id берётся из req.session.deviceId и НИКОГДА из запроса. Так
// подделать принадлежность устройства нельзя в принципе: положить id в
// сессию можно только через POST /api/devices или /api/devices/:id/bind,
// где принадлежность проверяется по таблице devices (см. lib/devices.js).

const express = require('express');
const { log } = require('./log');
const rateLimit = require('express-rate-limit');

const KEY_SERVER_URL = process.env.KEY_SERVER_URL || 'http://127.0.0.1:7420';
const KEY_SERVER_SECRET = process.env.INTERNAL_KEY_SERVER_SECRET;

// Без таймаута зависший key-server держал бы express-воркер до упора.
const REQUEST_TIMEOUT_MS = 5000;

function requireAuth(req, res, next) {
    if (!req.session.userId) {
        return res.status(401).json({ success: false, message: 'Не авторизован' });
    }
    next();
}

/**
 * Требует, чтобы сессия была привязана к устройству. Всё, что читает или
 * пишет ключевой материал, работает от имени устройства: после перехода на
 * per-device модель операция без device_id смысла не имеет.
 */
function requireDevice(req, res, next) {
    if (!req.session.deviceId) {
        return res.status(409).json({
            success: false,
            message: 'Устройство не зарегистрировано: сначала POST /api/devices',
        });
    }
    next();
}

/**
 * Единственное место, где формируется запрос к key-server. Раньше каждый из
 * шести эндпоинтов повторял этот блок целиком, и добавление X-Device-Id
 * означало шесть одинаковых правок — то есть шесть шансов забыть одну.
 */
async function forward(req, res, { method, path, scope = 'device', body }) {
    if (!KEY_SERVER_SECRET) {
        log.error('[E2EE] INTERNAL_KEY_SERVER_SECRET не задан — прокси отключён');
        return res.status(503).json({ success: false, message: 'E2EE не настроен на сервере' });
    }

    const headers = {
        'X-Internal-Secret': KEY_SERVER_SECRET,
        'X-User-Id': String(req.session.userId),
    };
    if (scope === 'device') {
        headers['X-Device-Id'] = String(req.session.deviceId);
    }
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
    }

    try {
        const response = await fetch(`${KEY_SERVER_URL}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        // Ответ не обязан быть JSON: при 5xx от прокси-слоя или обрыве
        // может прийти текст, и тогда response.json() бросит, маскируя
        // настоящую причину.
        const raw = await response.text();
        let data;
        try {
            data = raw ? JSON.parse(raw) : {};
        } catch {
            log.error({ status: response.status }, '[E2EE] key-server вернул не JSON');
            return res.status(502).json({ success: false, message: 'Некорректный ответ key-server' });
        }
        return res.status(response.status).json(data);
    } catch (error) {
        // Отдельный код для недоступности сервиса: 500 здесь вводил в
        // заблуждение — приложение цело, недоступен сосед.
        const timedOut = error.name === 'TimeoutError' || error.name === 'AbortError';
        // Путь не пишем: в нём id пользователей и устройств.
        log.error({ err: error, method }, '[E2EE] key-server недоступен');
        return res.status(503).json({
            success: false,
            message: timedOut ? 'Key-server не ответил' : 'Key-server недоступен',
        });
    }
}

// Есть ли у двух пользователей общий чат. Задаёт server.js: прокси о чатах
// ничего не знает.
let sharesChat = async () => false;
function setPeerCheck(fn) {
    sharesChat = fn;
}

/**
 * Ключи пользователя отдаются только тем, с кем у него общий чат, и ему
 * самому — для других своих устройств. Раньше их получал любой вошедший по
 * любому id: перебором можно было узнать, кто зарегистрирован и сколько у
 * него устройств, а запросами bundle — выбрать все одноразовые prekeys
 * жертвы, после чего новые сессии с ней шли бы без них.
 *
 * Чужой id и id без общего чата неразличимы: оба 404.
 */
async function requirePeer(req, res, next) {
    const targetUserId = Number(req.params.targetUserId);
    if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ success: false, message: 'Некорректный id пользователя' });
    }
    if (targetUserId === Number(req.session.userId)) return next();
    try {
        if (await sharesChat(Number(req.session.userId), targetUserId)) return next();
    } catch (error) {
        log.error({ err: error }, '[E2EE] Проверка общего чата не удалась');
        return res.status(503).json({ success: false, message: 'Не удалось проверить доступ к ключам' });
    }
    return res.status(404).json({ success: false, message: 'Ключи не найдены' });
}

// Каждый запрос bundle расходует одноразовый prekey на каждом устройстве
// собеседника. Даже собеседник не должен выбирать их все разом.
const bundleLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req => `user:${req.session.userId}`,
    message: { success: false, message: 'Слишком много запросов ключей. Попробуйте позже.' },
});

const router = express.Router();

// --- операции устройства над своим ключевым материалом ---

router.put('/api/keys/identity', requireAuth, requireDevice, (req, res) =>
    forward(req, res, { method: 'PUT', path: '/internal/v1/keys/identity', body: req.body })
);

router.put('/api/keys/signed-prekey', requireAuth, requireDevice, (req, res) =>
    forward(req, res, { method: 'PUT', path: '/internal/v1/keys/signed-prekey', body: req.body })
);

router.post('/api/keys/one-time-prekeys', requireAuth, requireDevice, (req, res) =>
    forward(req, res, { method: 'POST', path: '/internal/v1/keys/one-time-prekeys', body: req.body })
);

router.get('/api/keys/one-time-prekeys/count', requireAuth, requireDevice, (req, res) =>
    forward(req, res, { method: 'GET', path: '/internal/v1/keys/one-time-prekeys/count' })
);

// --- операции уровня аккаунта ---

/**
 * Bundle получателя. Ответ — НАБОР bundle, по одному на каждое устройство
 * получателя: отправитель обязан зашифровать сообщение для каждого, иначе
 * на части устройств оно не прочитается.
 */
router.get('/api/keys/bundle/:targetUserId', requireAuth, bundleLimiter, requirePeer, (req, res) => {
    const targetUserId = Number(req.params.targetUserId);
    return forward(req, res, {
        method: 'GET',
        path: `/internal/v1/keys/bundle/${targetUserId}`,
        scope: 'user',
    });
});

/**
 * Identity-ключи всех устройств пользователя — для кода безопасности.
 * В отличие от bundle не расходует одноразовые prekeys.
 */
router.get('/api/keys/identities/:targetUserId', requireAuth, requirePeer, (req, res) => {
    const targetUserId = Number(req.params.targetUserId);
    return forward(req, res, {
        method: 'GET',
        path: `/internal/v1/keys/identities/${targetUserId}`,
        scope: 'user',
    });
});

/** Удаление всего ключевого материала аккаунта — при удалении аккаунта. */
router.delete('/api/keys', requireAuth, (req, res) =>
    forward(req, res, { method: 'DELETE', path: '/internal/v1/keys', scope: 'user' })
);

/**
 * Удаление ключей одного устройства по инициативе сервера (отзыв
 * устройства из lib/devices.js), а не по запросу клиента. Поэтому это не
 * маршрут, а функция: отзывать чужое устройство через HTTP клиент не
 * должен, а отзыв идёт по id из таблицы devices, уже проверенному там.
 *
 * Возвращает true/false вместо исключения: отзыв устройства не должен
 * падать целиком из-за недоступности key-server — метка revoked_at важнее,
 * она уже не даст устройству привязаться к сессии.
 */
async function revokeDeviceKeys(userId, deviceId) {
    if (!KEY_SERVER_SECRET) {
        log.error('[E2EE] INTERNAL_KEY_SERVER_SECRET не задан — ключи устройства не удалены');
        return false;
    }
    try {
        const response = await fetch(`${KEY_SERVER_URL}/internal/v1/keys/device`, {
            method: 'DELETE',
            headers: {
                'X-Internal-Secret': KEY_SERVER_SECRET,
                'X-User-Id': String(userId),
                'X-Device-Id': String(deviceId),
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            log.error({ status: response.status }, '[E2EE] Не удалось удалить ключи устройства');
            return false;
        }
        return true;
    } catch (error) {
        log.error({ err: error }, '[E2EE] Не удалось удалить ключи устройства');
        return false;
    }
}

/**
 * Удаление всего ключевого материала аккаунта по инициативе сервера —
 * используется при очистке анонимного аккаунта на выходе. Как и
 * revokeDeviceKeys, возвращает признак успеха вместо исключения: выход
 * пользователя не должен падать из-за недоступности key-server.
 */
async function revokeAllKeys(userId) {
    if (!KEY_SERVER_SECRET) {
        log.error('[E2EE] INTERNAL_KEY_SERVER_SECRET не задан — ключи аккаунта не удалены');
        return false;
    }
    try {
        const response = await fetch(`${KEY_SERVER_URL}/internal/v1/keys`, {
            method: 'DELETE',
            headers: {
                'X-Internal-Secret': KEY_SERVER_SECRET,
                'X-User-Id': String(userId),
            },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
            log.error({ status: response.status }, '[E2EE] Не удалось удалить ключи аккаунта');
            return false;
        }
        return true;
    } catch (error) {
        log.error({ err: error }, '[E2EE] Не удалось удалить ключи аккаунта');
        return false;
    }
}

// Для /healthz основного сервера: жив ли сосед.
async function keyServerHealthy() {
    try {
        const response = await fetch(`${KEY_SERVER_URL}/healthz`, { signal: AbortSignal.timeout(2000) });
        return response.ok;
    } catch {
        return false;
    }
}

module.exports = router;
module.exports.router = router;
module.exports.requireAuth = requireAuth;
module.exports.requireDevice = requireDevice;
module.exports.revokeDeviceKeys = revokeDeviceKeys;
module.exports.revokeAllKeys = revokeAllKeys;
module.exports.setPeerCheck = setPeerCheck;
module.exports.keyServerHealthy = keyServerHealthy;
