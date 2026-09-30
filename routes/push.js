'use strict';

// Подписки Web Push (lib/push.js): браузер отдаёт адрес своей службы
// уведомлений, сервер шлёт туда пустой push, когда человек не в сети.

const { log } = require('../lib/log');
const { dbRun } = require('../lib/db');
const { allowedEndpoint, loadVapid } = require('../lib/push');

// Сколько подписок (браузеров) держим на аккаунт — лишние, самые старые, забываем.
const MAX_SUBSCRIPTIONS = 10;

module.exports = function registerPushRoutes(app) {
    const unauthorized = res => res.status(401).json({ success: false, message: 'Не авторизован' });

    app.get('/api/push/key', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        try {
            const { publicKey } = await loadVapid();
            res.json({ success: true, publicKey });
        } catch (error) {
            log.error({ err: error }, 'VAPID key error');
            res.status(500).json({ success: false, message: 'Push недоступен' });
        }
    });

    app.post('/api/push/subscription', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        const endpoint = req.body && req.body.endpoint;
        if (!allowedEndpoint(endpoint)) {
            return res.status(400).json({ success: false, message: 'Неизвестная служба уведомлений' });
        }
        try {
            // Адрес принадлежит браузеру: вошли в другой аккаунт — push
            // пойдёт ему, а не прежнему.
            await dbRun(
                `INSERT INTO push_subscriptions (user_id, endpoint) VALUES ($1, $2)
                 ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, created_at = now(), last_push_at = NULL`,
                [req.session.userId, endpoint]);
            await dbRun(
                `DELETE FROM push_subscriptions WHERE user_id = $1 AND id NOT IN
                 (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2)`,
                [req.session.userId, MAX_SUBSCRIPTIONS]);
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Push subscribe error');
            res.status(500).json({ success: false, message: 'Не удалось включить push' });
        }
    });

    app.delete('/api/push/subscription', async (req, res) => {
        if (!req.session.userId) return unauthorized(res);
        const endpoint = req.body && req.body.endpoint;
        if (typeof endpoint !== 'string') return res.status(400).json({ success: false, message: 'Нет адреса подписки' });
        try {
            await dbRun('DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2', [req.session.userId, endpoint]);
            res.json({ success: true });
        } catch (error) {
            log.error({ err: error }, 'Push unsubscribe error');
            res.status(500).json({ success: false, message: 'Не удалось выключить push' });
        }
    });
};
