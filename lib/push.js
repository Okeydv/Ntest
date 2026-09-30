'use strict';

/*
 * Web Push — пустой. Служба уведомлений браузера (Google, Apple, Mozilla,
 * Microsoft) получает только «этому устройству что-то пришло»: ни текста,
 * ни имени, ни номера чата. Service worker (public/sw.js) показывает на
 * это «Новое сообщение». Содержимое не шифруется, потому что его нет, —
 * нужна только подпись VAPID (ES256), чтобы служба приняла push от нашего
 * сервера.
 *
 * Шлётся тем получателям, у кого сейчас нет ни одного открытого сокета:
 * открытая вкладка уведомит сама. Не чаще раза в PUSH_MIN_INTERVAL_MS на
 * подписку, заглушённым чатам — не шлётся.
 *
 * На iPhone это единственный способ получать уведомления: только из
 * приложения на экране «Домой», iOS 16.4+.
 */

const crypto = require('crypto');
const { dbAll, dbGet, dbRun } = require('./db');
const { log } = require('./log');
const { isOnline } = require('./presence');

const PUSH_MIN_INTERVAL_MS = Number(process.env.PUSH_MIN_INTERVAL_MS) || 10_000;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:push@nyxo.invalid';

// Сервер шлёт POST на адрес из подписки — адрес задаёт клиент. Чтобы
// сервер нельзя было натравить на чужой адрес (SSRF), принимаются только
// службы уведомлений браузеров. Для тестов — PUSH_EXTRA_HOSTS
// («127.0.0.1:4567», можно по http).
const PUSH_HOSTS = [
    /^fcm\.googleapis\.com$/,
    /^[\w.-]+\.push\.apple\.com$/,
    /^[\w.-]+\.push\.services\.mozilla\.com$/,
    /^[\w.-]+\.notify\.windows\.com$/,
];
const EXTRA_HOSTS = (process.env.PUSH_EXTRA_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);

function allowedEndpoint(value) {
    if (typeof value !== 'string' || value.length > 1024) return false;
    let url;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (EXTRA_HOSTS.includes(url.host)) return url.protocol === 'https:' || url.protocol === 'http:';
    return url.protocol === 'https:' && !url.port && PUSH_HOSTS.some(re => re.test(url.hostname));
}

const b64url = buf => Buffer.from(buf).toString('base64url');

/*
 * Ключи VAPID: из VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY (base64url: публичный —
 * 65 байт несжатой точки, закрытый — 32 байта), иначе — созданные однажды
 * и сохранённые в server_settings. Подписки привязаны к публичному ключу:
 * новый ключ на каждом старте сделал бы их недействительными.
 */
let vapid = null;

function keysFromRaw(publicKey, privateKey) {
    const pub = Buffer.from(publicKey, 'base64url');
    if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC_KEY — не несжатая точка P-256');
    const key = crypto.createPrivateKey({ format: 'jwk', key: {
        kty: 'EC', crv: 'P-256', d: privateKey, x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)),
    } });
    return { publicKey, key };
}

async function loadVapid() {
    if (vapid) return vapid;
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        vapid = keysFromRaw(process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
        return vapid;
    }
    const stored = await dbGet("SELECT value FROM server_settings WHERE key = 'vapid'");
    if (stored) {
        const { publicKey, privateKey } = JSON.parse(stored.value);
        vapid = keysFromRaw(publicKey, privateKey);
        return vapid;
    }
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    const publicKey = b64url(Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]));
    // Два сервера могли создать ключ разом — остаётся первый записанный.
    await dbRun(`INSERT INTO server_settings (key, value) VALUES ('vapid', $1) ON CONFLICT (key) DO NOTHING`,
        [JSON.stringify({ publicKey, privateKey: jwk.d })]);
    vapid = null;
    return loadVapid();
}

function vapidHeader(endpoint, keys) {
    const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const claims = b64url(JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: VAPID_SUBJECT,
    }));
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: keys.key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

async function sendOne(subscription, keys) {
    try {
        const response = await fetch(subscription.endpoint, {
            method: 'POST',
            headers: {
                Authorization: vapidHeader(subscription.endpoint, keys),
                TTL: String(24 * 60 * 60),
                Urgency: 'high',
                // Непоказанные push одной подписки служба схлопывает в один.
                Topic: 'new-message',
                'Content-Length': '0',
            },
            signal: AbortSignal.timeout(10_000),
        });
        // Подписки больше нет (отписались, удалили приложение) — забываем.
        if (response.status === 404 || response.status === 410) {
            await dbRun('DELETE FROM push_subscriptions WHERE id = $1', [subscription.id]);
        } else if (!response.ok) {
            log.warn({ status: response.status, host: new URL(subscription.endpoint).host }, 'Push отклонён службой');
        }
    } catch (error) {
        log.warn({ err: error, host: new URL(subscription.endpoint).host }, 'Push не отправлен');
    }
}

/**
 * Новое сообщение в комнате: push участникам, кроме автора, у кого нет
 * открытых сокетов и чат не заглушён. Не ждёт отправки.
 */
async function notifyRoom(roomId, senderId) {
    try {
        const subscriptions = await dbAll(
            `SELECT s.id, s.user_id, s.endpoint FROM room_participants p
             JOIN push_subscriptions s ON s.user_id = p.user_id
             JOIN chats c ON c.room_id = p.room_id AND c.user_id = p.user_id
             WHERE p.room_id = $1 AND p.user_id <> $2 AND NOT c.muted
               AND (s.last_push_at IS NULL OR s.last_push_at < now() - make_interval(secs => $3))`,
            [roomId, senderId, PUSH_MIN_INTERVAL_MS / 1000]);
        const due = subscriptions.filter(s => !isOnline(s.user_id));
        if (!due.length) return;
        const keys = await loadVapid();
        await dbRun('UPDATE push_subscriptions SET last_push_at = now() WHERE id = ANY($1)', [due.map(s => s.id)]);
        await Promise.all(due.map(s => sendOne(s, keys)));
    } catch (error) {
        log.error({ err: error }, 'Push error');
    }
}

module.exports = { allowedEndpoint, loadVapid, notifyRoom };
