'use strict';

// Вход на новом устройстве по QR-коду с устройства, где уже вошли, — без
// пароля. Новый браузер показывает код, старое устройство его сканирует,
// видит, какой браузер подключается, и подтверждает.
//
//   POST /api/link/start    новый браузер: выдать код (5 минут)
//   GET  /api/link/status   новый браузер: ждёт; после подтверждения входит
//   POST /api/link/inspect  старое устройство: что за браузер просится
//   POST /api/link/approve  старое устройство: пустить
//
// Код одноразовый и привязан к сессии браузера, который его показал:
// подсмотревший код войти по нему не может. Главный риск — обратный: код
// покажет злоумышленник и попросит «отсканировать». Поэтому перед
// подтверждением видно, какой браузер подключается (по User-Agent, из
// короткого списка — своё название клиент не пришлёт) и сколько времени
// назад показан код, и прямо сказано, что он получит доступ к аккаунту;
// а остальные устройства узнают о новом. Распознавания с фото нет: это
// ровно сценарий «пришли мне скриншот кода».

const crypto = require('crypto');
const { log } = require('../lib/log');
const { dbGet, dbRun } = require('../lib/db');
const { linkStartLimiter, joinLimiter } = require('../lib/rate-limits');
const { deviceLabelFromUa } = require('../lib/helpers');

const LINK_TTL_SECONDS = 5 * 60;
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// 26 знаков по 5 бит — 130 бит: не подобрать.
const TOKEN_RE = /^[A-Z2-7]{26}$/;

const hashToken = token => crypto.createHash('sha256').update(token).digest('hex');

function newToken() {
    return Array.from(crypto.randomBytes(26), b => TOKEN_ALPHABET[b & 31]).join('');
}

module.exports = function registerLinkRoutes(app, ctx) {
    app.post('/api/link/start', linkStartLimiter, async (req, res) => {
        if (req.session.userId) return res.status(400).json({ success: false, message: 'Вы уже вошли' });
        try {
            await dbRun('DELETE FROM device_links WHERE expires_at < now()');
            // Прежний код этого браузера больше не нужен.
            if (req.session.linkTokenHash) {
                await dbRun('DELETE FROM device_links WHERE token_hash = $1', [req.session.linkTokenHash]);
            }
            const token = newToken();
            req.session.linkTokenHash = hashToken(token);
            // Сессия должна быть в базе до того, как код отсканируют.
            await new Promise((resolve, reject) => req.session.save(err => (err ? reject(err) : resolve())));
            await dbRun(
                `INSERT INTO device_links (token_hash, session_id, label, expires_at)
                 VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
                [req.session.linkTokenHash, req.sessionID, deviceLabelFromUa(req.headers['user-agent']), LINK_TTL_SECONDS]
            );
            res.json({ success: true, token, expiresIn: LINK_TTL_SECONDS });
        } catch (error) {
            log.error({ err: error }, 'Link start error');
            res.status(500).json({ success: false, message: 'Не удалось начать привязку' });
        }
    });

    app.get('/api/link/status', async (req, res) => {
        const tokenHash = req.session.linkTokenHash;
        if (!tokenHash) return res.json({ success: true, status: 'expired' });
        try {
            const link = await dbGet(
                `SELECT l.user_id, l.expires_at < now() AS expired, u.username, u.unique_code, u.avatar
                 FROM device_links l LEFT JOIN users u ON u.id = l.user_id
                 WHERE l.token_hash = $1 AND l.session_id = $2`,
                [tokenHash, req.sessionID]
            );
            if (!link || (link.expired && !link.user_id)) {
                delete req.session.linkTokenHash;
                return res.json({ success: true, status: 'expired' });
            }
            if (!link.user_id) return res.json({ success: true, status: 'pending' });

            await dbRun('DELETE FROM device_links WHERE token_hash = $1', [tokenHash]);
            await ctx.startSession(req, {
                userId: link.user_id, username: link.username, uniqueCode: link.unique_code, avatar: link.avatar || '',
            });
            res.json({
                success: true, status: 'approved',
                user: { id: link.user_id, username: link.username, uniqueCode: link.unique_code, avatar: link.avatar || '' },
            });
        } catch (error) {
            log.error({ err: error }, 'Link status error');
            res.status(500).json({ success: false, message: 'Не удалось проверить привязку' });
        }
    });

    // Для подтверждения на старом устройстве: найти живую привязку по коду.
    async function pendingLink(req, res) {
        if (!req.session.userId) {
            res.status(401).json({ success: false, message: 'Не авторизован' });
            return null;
        }
        if (req.session.isAnonymous) {
            // У приватного аккаунта одно устройство: подключать нечего.
            res.status(403).json({ success: false, message: 'В приватном режиме второе устройство подключить нельзя' });
            return null;
        }
        const token = String((req.body && req.body.token) || '');
        const link = TOKEN_RE.test(token) && await dbGet(
            `SELECT token_hash, label, expires_at, EXTRACT(EPOCH FROM now() - created_at)::int AS age_seconds
             FROM device_links WHERE token_hash = $1 AND user_id IS NULL AND expires_at > now()`,
            [hashToken(token)]
        );
        if (!link) {
            res.status(404).json({ success: false, message: 'Код не найден или устарел. Обновите его на новом устройстве.' });
            return null;
        }
        return link;
    }

    app.post('/api/link/inspect', joinLimiter, async (req, res) => {
        try {
            const link = await pendingLink(req, res);
            if (!link) return;
            res.json({ success: true, label: link.label, ageSeconds: link.age_seconds, expiresAt: link.expires_at });
        } catch (error) {
            log.error({ err: error }, 'Link inspect error');
            res.status(500).json({ success: false, message: 'Не удалось проверить код' });
        }
    });

    app.post('/api/link/approve', joinLimiter, async (req, res) => {
        try {
            const link = await pendingLink(req, res);
            if (!link) return;
            const updated = await dbRun(
                'UPDATE device_links SET user_id = $1, approved_at = now() WHERE token_hash = $2 AND user_id IS NULL',
                [req.session.userId, link.token_hash]
            );
            if (updated.rowCount !== 1) return res.status(409).json({ success: false, message: 'Код уже использован' });
            res.locals.joined = true;
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Link approve error');
            res.status(500).json({ success: false, message: 'Не удалось подключить устройство' });
        }
    });
};
