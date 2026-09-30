// Web Push (lib/push.js, routes/push.js).
//
//   - публичный ключ VAPID отдаётся и не меняется от запроса к запросу;
//   - подписка принимается только на службы уведомлений браузеров (иначе
//     сервер можно было бы натравить на любой адрес);
//   - push уходит получателю не в сети, пустой, с подписью VAPID, которая
//     проверяется публичным ключом; автору и тому, у кого открыт сокет, —
//     нет; заглушённому чату — нет; чаще раза в интервал — нет;
//   - служба ответила 410 — подписка забыта.
//
// Поддельная служба уведомлений — http://127.0.0.1:4599 (PUSH_EXTRA_HOSTS
// в scripts/run-all-tests.sh). Требует сервер на 3006 и ЧИСТУЮ базу.

import http from 'node:http';
import crypto from 'node:crypto';
import pg from 'pg';
import { io as ioClient } from 'socket.io-client';

const BASE = 'http://127.0.0.1:3006';
const PUSH = 'http://127.0.0.1:4599';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const b64 = s => Buffer.from(s, 'utf8').toString('base64');

// Поддельная служба: запоминает запросы; /gone/* отвечает 410.
const received = [];
const service = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
        received.push({ path: req.url, headers: req.headers, body });
        res.writeHead(req.url.startsWith('/gone/') ? 410 : 201).end();
    });
});
await new Promise(r => service.listen(4599, '127.0.0.1', r));

function jar() {
    const c = new Map();
    return { header: () => [...c].map(([k, v]) => `${k}=${v}`).join('; '), csrf: () => c.get('csrf_token') || '',
        absorb: r => { for (const s of (r.headers.getSetCookie?.() ?? [])) { const [p] = s.split(';'); const i = p.indexOf('='); c.set(p.slice(0, i), p.slice(i + 1)); } } };
}
let ip = 10;
async function req(j, method, path, body) {
    const headers = { Cookie: j.header(), 'X-Forwarded-For': j.ip };
    if (j.csrf()) headers['X-CSRF-Token'] = j.csrf();
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    j.absorb(r);
    let json = null;
    try { json = await r.json(); } catch { /* не JSON */ }
    return { status: r.status, json };
}
async function user(name) {
    const j = jar();
    j.ip = `10.0.44.${ip++}`;
    await req(j, 'GET', '/api/auth');
    const r = await req(j, 'POST', '/api/register', { username: name, email: `${name}@example.com`, password: 'password123', confirmPassword: 'password123' });
    const device = (await req(j, 'POST', '/api/devices', { name: 'ноутбук' })).json.device.id;
    return { j, id: r.json.user.id, device };
}

/* ------------------------- ключ и подписка ------------------------- */

const alice = await user('alice');
const bob = await user('bob');
const key1 = await req(bob.j, 'GET', '/api/push/key');
const key2 = await req(alice.j, 'GET', '/api/push/key');
const pub = Buffer.from(key1.json?.publicKey || '', 'base64url');
check('публичный ключ VAPID — несжатая точка P-256 и один на всех', pub.length === 65 && pub[0] === 4
    && key1.json.publicKey === key2.json.publicKey, key1.json?.publicKey);
check('без входа ключа нет', (await req(jar(), 'GET', '/api/push/key')).status === 401);

for (const bad of ['http://evil.example/push', 'https://127.0.0.1.evil.example/x', 'https://fcm.googleapis.com:8443/x', 'file:///etc/passwd', 42]) {
    const r = await req(bob.j, 'POST', '/api/push/subscription', { endpoint: bad });
    check(`чужой адрес не принимается: ${bad}`, r.status === 400);
}
check('адрес Google принимается', (await req(alice.j, 'POST', '/api/push/subscription', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' })).json?.success === true);
check('адрес Apple принимается', (await req(alice.j, 'POST', '/api/push/subscription', { endpoint: 'https://web.push.apple.com/QGx' })).json?.success === true);
await req(alice.j, 'DELETE', '/api/push/subscription', { endpoint: 'https://fcm.googleapis.com/fcm/send/abc' });
await req(alice.j, 'DELETE', '/api/push/subscription', { endpoint: 'https://web.push.apple.com/QGx' });
check('подписка Боба сохранена', (await req(bob.j, 'POST', '/api/push/subscription', { endpoint: `${PUSH}/bob` })).json?.success === true);

/* ------------------------- push ------------------------- */

const chat = (await req(alice.j, 'POST', '/api/chats', { name: 'Пуш' })).json.chat;
const code = (await req(alice.j, 'POST', `/api/chats/${chat.id}/link`, { requireApproval: false })).json.code;
const bobChat = (await req(bob.j, 'POST', '/api/chats/join', { code })).json.chat;
const send = (text) => req(alice.j, 'POST', '/api/messages/encrypted', {
    chatId: chat.id,
    envelopes: [
        { recipientDeviceId: alice.device, envelopeType: 1, header: b64('h'), ciphertext: b64(text) },
        { recipientDeviceId: bob.device, envelopeType: 1, header: b64('h'), ciphertext: b64(text) },
    ],
});

// Боб в сети — push не нужен.
const bobSocket = ioClient(BASE, { extraHeaders: { Cookie: bob.j.header(), 'X-Forwarded-For': bob.j.ip }, transports: ['websocket'] });
await sleep(800);
await send('первое');
await sleep(600);
check('получатель в сети — push нет', received.length === 0, JSON.stringify(received.map(r => r.path)));

// Боб закрыл вкладку.
bobSocket.close();
await sleep(600);
const sent = await send('второе');
check('сообщение принято', sent.json?.success === true);
await sleep(800);
const push = received.find(r => r.path === '/bob');
check('получатель не в сети — push ушёл', Boolean(push), JSON.stringify(received.map(r => r.path)));
check('push пустой — ни текста, ни чата', push && push.body === '' && push.headers['content-length'] === '0'
    && !JSON.stringify(push.headers).includes('второе'), JSON.stringify(push && push.headers));
check('TTL, срочность и тема заданы', push && push.headers.ttl === '86400' && push.headers.urgency === 'high' && push.headers.topic === 'new-message');

// Подпись VAPID проверяется публичным ключом.
const auth = push && /^vapid t=([^,]+), k=(.+)$/.exec(push.headers.authorization);
let verified = false;
let claims = null;
if (auth) {
    const [h, c, sig] = auth[1].split('.');
    claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    const jwk = { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
    verified = crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key: crypto.createPublicKey({ format: 'jwk', key: jwk }), dsaEncoding: 'ieee-p1363' },
        Buffer.from(sig, 'base64url')) && auth[2] === key1.json.publicKey;
}
check('подпись VAPID верна, aud — адрес службы, срок не больше суток', verified && claims.aud === PUSH
    && claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 86400 && /^mailto:|^https:/.test(claims.sub), JSON.stringify(claims));
check('автору push не шлётся', !received.some(r => r.path === '/alice'));

// Чаще интервала — нет.
const before = received.length;
await send('третье');
await sleep(600);
check('второй push подряд не уходит (не чаще интервала)', received.length === before);

// Заглушённый чат — нет.
await db.query('UPDATE push_subscriptions SET last_push_at = NULL');
await req(bob.j, 'POST', `/api/chats/${bobChat.id}/flags`, { muted: true });
await send('четвёртое');
await sleep(600);
check('заглушённому чату push нет', received.length === before);
await req(bob.j, 'POST', `/api/chats/${bobChat.id}/flags`, { muted: false });

// Служба ответила 410 — подписка забыта.
await req(bob.j, 'POST', '/api/push/subscription', { endpoint: `${PUSH}/gone/1` });
await db.query('UPDATE push_subscriptions SET last_push_at = NULL');
await send('пятое');
await sleep(800);
const left = (await db.query('SELECT endpoint FROM push_subscriptions WHERE user_id = $1', [bob.id])).rows.map(r => r.endpoint);
check('410 от службы — подписка удалена, живая осталась', left.length === 1 && left[0] === `${PUSH}/bob`, JSON.stringify(left));

// Отписка.
await req(bob.j, 'DELETE', '/api/push/subscription', { endpoint: `${PUSH}/bob` });
const none = (await db.query('SELECT count(*) FROM push_subscriptions WHERE user_id = $1', [bob.id])).rows[0].count;
check('отписка удаляет подписку', Number(none) === 0);

// Один адрес — один аккаунт: вошёл другой — push идёт ему.
await req(bob.j, 'POST', '/api/push/subscription', { endpoint: `${PUSH}/shared` });
await req(alice.j, 'POST', '/api/push/subscription', { endpoint: `${PUSH}/shared` });
const owner = (await db.query('SELECT user_id FROM push_subscriptions WHERE endpoint = $1', [`${PUSH}/shared`])).rows;
check('адрес подписки переходит к вошедшему аккаунту', owner.length === 1 && owner[0].user_id === alice.id);

service.close();
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
