'use strict';

/*
 * Журнал событий безопасности (migrations/007_security_events.sql).
 *
 * Пишется только в базу и только для существующего аккаунта: неверный
 * пароль к несуществующей почте некому показывать. Сбой записи не мешает
 * самому действию — он только в журнал сервера.
 */

const { dbAll, dbRun } = require('./db');
const { log } = require('./log');
const { deviceLabelFromUa } = require('./helpers');

const KINDS = new Set(['login', 'login_failed', 'password_changed', 'device_added', 'device_revoked',
    'link_approved', 'link_login']);
const KEEP_DAYS = 90;

async function recordSecurityEvent(userId, kind, { req = null, label = null } = {}) {
    if (!userId || !KINDS.has(kind)) return;
    try {
        const text = label || (req ? deviceLabelFromUa(req.headers['user-agent']) : '');
        await dbRun('INSERT INTO security_events (user_id, kind, label) VALUES ($1, $2, $3)', [userId, kind, String(text).slice(0, 64)]);
        await dbRun(`DELETE FROM security_events WHERE user_id = $1 AND created_at < now() - interval '${KEEP_DAYS} days'`, [userId]);
    } catch (error) {
        log.error({ err: error, kind }, 'Security event error');
    }
}

const listSecurityEvents = userId => dbAll(
    'SELECT kind, label, created_at FROM security_events WHERE user_id = $1 ORDER BY id DESC LIMIT 50', [userId]);

module.exports = { recordSecurityEvent, listSecurityEvents };
