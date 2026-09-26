// Интеграционный тест мелочей сервера.
//
//   - журнал безопасности: неверный пароль, вход, смена пароля,
//     подключение и отзыв устройства видны владельцу, чужому — нет;
//   - двойное нажатие «Войти по коду» не записывает участника дважды;
//   - поля запроса — только строки: объект вместо строки — 400, а не
//     проскочившая проверка длины;
//   - удалённый анонимный аккаунт: собеседникам сразу приходит
//     messageDeleted для его сообщений;
//   - CSP без 'unsafe-inline', в разметке нет атрибутов style;
//   - запрос через Tor действительно идёт через агент (встроенный fetch
//     агент молча игнорирует).
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-server.mjs

import { io as ioClient } from 'socket.io-client';
import { createRequire } from 'node:module';
import http from 'node:http';
import pg from 'pg';

const require = createRequire(import.meta.url);
const { requestViaAgent } = require('../lib/tor-support.js');

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let nextIp = 1;
function client() {
    const cookies = new Map();
    const ip = `10.21.0.${nextIp++}`;
    const c = {
        header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        absorb(r) {
            for (const s of (r.headers.getSetCookie?.() ?? [])) {
                const [pair] = s.split(';');
                const i = pair.indexOf('=');
                cookies.set(pair.slice(0, i), pair.slice(i + 1));
            }
        },
        async req(method, url, body) {
            if (!cookies.has('csrf_token')) c.absorb(await fetch(BASE + '/', { headers: { 'X-Forwarded-For': ip } }));
            const r = await fetch(BASE + url, { method,
                headers: { Cookie: c.header(), 'X-CSRF-Token': cookies.get('csrf_token'), 'Content-Type': 'application/json',
                    'X-Forwarded-For': ip, 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36' },
                body: body === undefined ? undefined : JSON.stringify(body) });
            c.absorb(r);
            let json = null;
            try { json = await r.json(); } catch { /* не JSON */ }
            return { status: r.status, json };
        },
    };
    return c;
}
async function register(name) {
    const c = client();
    const r = await c.req('POST', '/api/register', { username: name, email: `${name}@example.com`, password: 'password123', confirmPassword: 'password123' });
    if (!r.json?.success) throw new Error(`регистрация ${name}: ${r.json?.message}`);
    c.userId = r.json.user.id;
    return c;
}

/* ------------------------- журнал безопасности ------------------------- */

const alice = await register('alice');
await client().req('POST', '/api/login', { email: 'alice@example.com', password: 'не тот' });
const aliceAgain = client();
await aliceAgain.req('POST', '/api/login', { email: 'alice@example.com', password: 'password123' });
const device = await aliceAgain.req('POST', '/api/devices', { name: 'Ноутбук' });
await aliceAgain.req('DELETE', `/api/devices/${device.json.device.id}`);
await aliceAgain.req('POST', '/api/change-password', { currentPassword: 'password123', newPassword: 'password456', confirmPassword: 'password456' });
const relogged = client();
await relogged.req('POST', '/api/login', { email: 'alice@example.com', password: 'password456' });
const events = (await relogged.req('GET', '/api/security-events')).json?.events || [];
const kinds = events.map(e => e.kind);
check('в журнале: неверный пароль, вход, устройство, отзыв, смена пароля',
    ['login_failed', 'login', 'device_added', 'device_revoked', 'password_changed'].every(k => kinds.includes(k)), kinds.join(', '));
check('браузер — по User-Agent, устройство — по имени, адресов нет',
    events.find(e => e.kind === 'login')?.label === 'Chrome, Linux' && events.find(e => e.kind === 'device_added')?.label === 'Ноутбук'
    && !JSON.stringify(events).includes('10.21.'), JSON.stringify(events.slice(0, 3)));
const bob = await register('bob');
check('чужого журнала не видно', ((await bob.req('GET', '/api/security-events')).json?.events || []).every(e => e.kind !== 'login_failed'));

/* ------------------------- двойной вход по коду ------------------------- */

const created = await bob.req('POST', '/api/chats', { name: 'Двое' });
const code = (await bob.req('GET', `/api/chats/invite/${created.json.chat.id}`)).json.code;
const carol = await register('carol');
const [j1, j2] = await Promise.all([carol.req('POST', '/api/chats/join', { code }), carol.req('POST', '/api/chats/join', { code })]);
const counts = (await db.query(
    `SELECT (SELECT count(*) FROM room_participants WHERE room_id = $1 AND user_id = $2) AS p,
            (SELECT count(*) FROM chats WHERE room_id = $1 AND user_id = $2) AS c`,
    [created.json.chat.room_id, carol.userId])).rows[0];
check('двойное «Войти» — один участник и одна запись чата, оба ответа успешны',
    Number(counts.p) === 1 && Number(counts.c) === 1 && j1.json?.success && j2.json?.success, JSON.stringify(counts));

/* ------------------------- поля — только строки ------------------------- */

const bad = [
    await client().req('POST', '/api/register', { username: { length: 3 }, email: 'x@example.com', password: 'password123', confirmPassword: 'password123' }),
    await client().req('POST', '/api/login', { email: ['alice@example.com'], password: 'password456' }),
    await bob.req('POST', '/api/messages', { chatId: created.json.chat.id, text: { trim: 1 } }),
    await bob.req('POST', '/api/chats', { name: ['a'] }),
    await bob.req('GET', '/api/search?q=a&q=b'),
];
check('объект или массив вместо строки — 400', bad.every(r => r.status === 400), bad.map(r => r.status).join(' '));

/* ------------------------- удаление анонимного ------------------------- */

const anon = client();
const anonReg = await anon.req('POST', '/api/register/anonymous', {});
await anon.req('POST', '/api/chats/join', { code });
const anonChat = (await anon.req('GET', '/api/chats')).json.chats.find(c => c.room_id === created.json.chat.room_id);
const anonMessage = (await anon.req('POST', '/api/messages', { chatId: anonChat.id, text: 'от гостя' })).json.message;
const sock = ioClient(BASE, { extraHeaders: { Cookie: bob.header() }, transports: ['websocket'], reconnection: false });
const deleted = [];
sock.on('messageDeleted', m => deleted.push(m.id));
await new Promise(r => sock.once('connect', r));
sock.emit('joinChat', `room:${created.json.chat.room_id}`);
await sleep(300);
await anon.req('POST', '/api/logout');
await sleep(800);
sock.close();
check('гость вышел — собеседник сразу получает messageDeleted его сообщений',
    anonReg.json?.success && deleted.includes(anonMessage.id), JSON.stringify(deleted));

/* ------------------------- CSP ------------------------- */

const page = await fetch(BASE + '/');
const csp = page.headers.get('content-security-policy') || '';
const html = await page.text();
check("CSP без 'unsafe-inline', в разметке нет style=", !/unsafe-inline/.test(csp) && !/\sstyle="/.test(html), csp.match(/style-src[^;]*/)?.[0]);

/* ------------------------- Tor через агент ------------------------- */

const target = http.createServer((req, res) => res.end('{"ok":true}'));
await new Promise(r => target.listen(0, '127.0.0.1', r));
let viaAgent = 0;
class CountingAgent extends http.Agent {
    createConnection(...args) { viaAgent++; return super.createConnection(...args); }
}
const answer = await requestViaAgent(`http://127.0.0.1:${target.address().port}/`, { agent: new CountingAgent() });
target.close();
check('запрос через Tor идёт через агент', viaAgent === 1 && (await answer.json()).ok === true, `соединений через агент: ${viaAgent}`);

await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
