// Интеграционный тест защиты сессии и заголовков.
//
// Проверяется:
//   - сокет не принимает подключение с чужого Origin, даже с настоящей
//     кукой пользователя (иначе любой сайт, открытый вошедшим
//     пользователем, получал бы события его чатов); свой Origin, Origin из
//     ALLOWED_ORIGINS и подключение без Origin проходят
//   - куки с SameSite=Lax, а не None
//   - Referrer-Policy: no-referrer — адрес мессенджера не уходит сайтам по
//     ссылкам из переписки
//   - служебные файлы не отдаются: .env, .git, исходники сервера,
//     node_modules, скрипты, обход пути — везде одинаковый 404; нет
//     X-Powered-By и страницы Express, по которым видно фреймворк
//   - чужое вложение в /uploads/ неотличимо от несуществующего
//   - через .onion кука ставится: без флага Secure, потому что соединение
//     до сервера — HTTP (транспорт шифрует Tor), а в остальных случаях в
//     production — с Secure. Это проверяется на настоящем express-session с
//     тем же middleware, что у сервера: поднять сервер в production здесь
//     нельзя — он требует SSL до базы.
//
// Требует server.js на 3006, запущенного с
// ALLOWED_ORIGINS=http://nyxotestaddress.onion, и чистой базы.
// Запуск: node scripts/integration-test-security.mjs

import { io as ioClient } from 'socket.io-client';
import express from 'express';
import session from 'express-session';
import { createRequire } from 'node:module';
import http from 'node:http';
import net from 'node:net';

const require = createRequire(import.meta.url);
const { sessionCookieSecurity } = require('../lib/cookie-security.js');

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };

function jar() {
    const c = new Map();
    return {
        header: () => [...c].map(([k, v]) => `${k}=${v}`).join('; '),
        csrf: () => c.get('csrf_token') || '',
        absorb: r => { for (const s of (r.headers.getSetCookie?.() ?? [])) { const [p] = s.split(';'); const i = p.indexOf('='); c.set(p.slice(0, i), p.slice(i + 1)); } },
    };
}

/* ------------------------- заголовки и куки ------------------------- */

const j = jar();
const home = await fetch(BASE + '/');
j.absorb(home);
check('Referrer-Policy: no-referrer', home.headers.get('referrer-policy') === 'no-referrer', home.headers.get('referrer-policy'));
const csrfCookie = (home.headers.getSetCookie?.() ?? []).find(c => c.startsWith('csrf_token='));
check('CSRF-кука с SameSite=Lax', /SameSite=Lax/i.test(csrfCookie || ''), csrfCookie);

const reg = await fetch(BASE + '/api/register', {
    method: 'POST',
    headers: { Cookie: j.header(), 'X-CSRF-Token': j.csrf(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'alice', email: 'alice@example.com', password: 'password123', confirmPassword: 'password123' }),
});
const sessionCookie = (reg.headers.getSetCookie?.() ?? []).find(c => c.startsWith('connect.sid='));
j.absorb(reg);
check('сессионная кука с SameSite=Lax', /SameSite=Lax/i.test(sessionCookie || ''), sessionCookie);

/* ------------------------- служебные файлы ------------------------- */

// Сырой запрос: fetch и http.request нормализуют «..» в пути.
function rawGet(pathname) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(3006, '127.0.0.1', () => sock.write(`GET ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
        let data = '';
        sock.on('data', d => { data += d; });
        sock.on('end', () => {
            const [head, ...body] = data.split('\r\n\r\n');
            resolve({ status: Number(head.split(' ')[1]), head, body: body.join('\r\n\r\n') });
        });
        sock.on('error', reject);
    });
}
const secretPaths = ['/.env', '/.git/config', '/server.js', '/package.json', '/package-lock.json', '/database.sql',
    '/scripts/run-all-tests.sh', '/node_modules/express/package.json', '/lib/privacy.js', '/e2ee-key-server/Cargo.toml',
    '/uploads/../.env', '/%2e%2e/.env', '/crypto/../../server.js', '/nothing-here'];
const answers = await Promise.all(secretPaths.map(rawGet));
check('служебные файлы и обход пути — 404', answers.every(a => a.status === 404),
    secretPaths.filter((p, i) => answers[i].status !== 404).join(', '));
check('и ответ везде один и тот же', new Set(answers.map(a => a.body.replace(/^[0-9a-f]+\r\n|\r\n0\r\n$/g, ''))).size === 1);
check('без страницы Express и без X-Powered-By', answers.every(a => !/Cannot GET|Express/i.test(a.body + a.head)));
const apiMissing = await fetch(BASE + '/api/no-such-thing');
check('несуществующий API — JSON 404', apiMissing.status === 404 && (await apiMissing.json()).success === false);
check('X-XSS-Protection: 0 (старый фильтр только мешал)', home.headers.get('x-xss-protection') === '0', home.headers.get('x-xss-protection'));

/* ------------------------- чужое вложение ------------------------- */

const owner = await fetch(BASE + '/api/chats', { method: 'POST',
    headers: { Cookie: j.header(), 'X-CSRF-Token': j.csrf(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Файлы' }) });
const ownerChat = (await owner.json()).chat.id;
const form = new FormData();
form.append('file', new Blob(['секретная заметка'], { type: 'text/plain' }), 'note.txt');
form.append('chatId', String(ownerChat));
const uploaded = await (await fetch(BASE + '/api/messages/file', { method: 'POST',
    headers: { Cookie: j.header(), 'X-CSRF-Token': j.csrf() }, body: form })).json();
const fileUrl = uploaded.message.file_url;
const stranger = jar();
stranger.absorb(await fetch(BASE + '/', { headers: { 'X-Forwarded-For': '10.3.3.3' } }));
stranger.absorb(await fetch(BASE + '/api/register', { method: 'POST',
    headers: { Cookie: stranger.header(), 'X-CSRF-Token': stranger.csrf(), 'Content-Type': 'application/json', 'X-Forwarded-For': '10.3.3.3' },
    body: JSON.stringify({ username: 'mallory', email: 'mallory@example.com', password: 'password123', confirmPassword: 'password123' }) }));
const foreign = await fetch(BASE + fileUrl, { headers: { Cookie: stranger.header() } });
const missing = await fetch(BASE + '/uploads/1700000000000-deadbeef.txt', { headers: { Cookie: stranger.header() } });
check('чужой файл неотличим от несуществующего', foreign.status === 404 && missing.status === 404
    && await foreign.text() === await missing.text(), `${foreign.status} / ${missing.status}`);
check('а владелец свой файл получает', (await fetch(BASE + fileUrl, { headers: { Cookie: j.header() } })).status === 200);

/* ------------------------- сокет и Origin ------------------------- */

function connect({ origin, transport = 'websocket' } = {}) {
    const headers = { Cookie: j.header() };
    if (origin) headers.Origin = origin;
    const sock = ioClient(BASE, { extraHeaders: headers, transports: [transport], reconnection: false, timeout: 3000 });
    return new Promise(resolve => {
        sock.once('connect', () => { sock.close(); resolve(true); });
        sock.once('connect_error', () => { sock.close(); resolve(false); });
    });
}

check('чужой сайт не подключается к сокету с кукой пользователя (WebSocket)',
    await connect({ origin: 'https://evil.example' }) === false);
check('и через long-polling тоже', await connect({ origin: 'https://evil.example', transport: 'polling' }) === false);
check('Origin null (песочница, file://) не проходит', await connect({ origin: 'null' }) === false);
check('свой Origin проходит', await connect({ origin: BASE }) === true);
check('Origin из ALLOWED_ORIGINS (.onion) проходит', await connect({ origin: 'http://nyxotestaddress.onion' }) === true);
check('подключение без Origin проходит (не браузер)', await connect() === true);

/* ------------------------- куки и .onion ------------------------- */

// Та же связка, что у сервера: express-session, доверие одному прокси и
// уточнение Secure на каждом запросе.
function miniApp({ withFix }) {
    const app = express();
    app.set('trust proxy', 1);
    app.use(session({
        secret: 'test-secret-at-least-32-characters-long',
        resave: false,
        saveUninitialized: false,
        proxy: true,
        cookie: { httpOnly: true, secure: true, sameSite: 'lax' },
    }));
    if (withFix) app.use(sessionCookieSecurity(true));
    app.get('/login', (req, res) => { req.session.userId = 1; res.json({ ok: true }); });
    return new Promise(resolve => { const srv = app.listen(0, '127.0.0.1', () => resolve(srv)); });
}
// Через http.request, а не fetch: fetch молча выбрасывает заголовок Host.
function loginCookie(srv, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: srv.address().port, path: '/login', headers }, res => {
            res.resume();
            const cookies = res.headers['set-cookie'] || [];
            resolve(cookies.find(c => c.startsWith('connect.sid=')) || null);
        });
        req.on('error', reject);
        req.end();
    });
}

const before = await miniApp({ withFix: false });
check('без поправки вход через .onion невозможен: кука не ставится вовсе',
    await loginCookie(before, { Host: 'nyxotestaddress.onion' }) === null);
before.close();

const fixed = await miniApp({ withFix: true });
const onion = await loginCookie(fixed, { Host: 'nyxotestaddress.onion' });
check('через .onion кука ставится, без Secure', !!onion && !/;\s*Secure/i.test(onion), onion);
const clearnet = await loginCookie(fixed, { Host: 'nyxo.example', 'X-Forwarded-Proto': 'https' });
check('на обычном домене по HTTPS — с Secure', !!clearnet && /;\s*Secure/i.test(clearnet), clearnet);
const plainHttp = await loginCookie(fixed, { Host: 'nyxo.example' });
check('на обычном домене по голому HTTP Secure-кука не уходит', plainHttp === null, plainHttp);
fixed.close();

console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
