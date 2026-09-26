// Интеграционный тест доступа: кто что видит после того, как доступ
// должен был закончиться, и что можно подставить чужого.
//
// Проверяется:
//   - ответ на сообщение из чужого чата не принимается, а старые такие
//     ответы не вытаскивают в историю текст чужой цитаты
//   - вышедший из чата больше не получает его сообщения по сокету
//   - выход из аккаунта отключает сокет этой сессии, а сокет на другом
//     устройстве остаётся
//   - смена пароля завершает все остальные сессии и отключает их сокеты
//   - регистрация выдаёт новый id сессии (не тот, что был до неё)
//   - ключи собеседника — только при общем чате; посторонний получает 404
//     так же, как на несуществующий id
//   - сообщение со сроком жизни в месяц не исчезает сразу (setTimeout не
//     умеет ждать дольше 24,8 суток), недопустимый срок отклоняется
//   - брошенный анонимный аккаунт (сессии нет) удаляется уборкой
//   - CSP не пускает соединения на чужие адреса; HSTS — только по HTTPS
//
// Требует поднятых Postgres, key-server и server.js на 3006, запущенного с
// ANON_SWEEP_INTERVAL_MS=2000, и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-access.mjs

import { io as ioClient } from 'socket.io-client';
import pg from 'pg';
import { createRequire } from 'node:module';

const bcrypt = createRequire(import.meta.url)('bcryptjs');

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });

let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Свой адрес у каждого клиента: регистраций с одного IP не больше трёх в час.
let nextIp = 1;
function client() {
    const cookies = new Map();
    const ip = `10.9.0.${nextIp++}`;
    const c = {
        sid: () => cookies.get('connect.sid'),
        header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        async req(method, url, body) {
            if (!cookies.has('csrf_token')) c.absorb(await fetch(BASE + '/', { headers: { 'X-Forwarded-For': ip } }));
            const r = await fetch(BASE + url, {
                method,
                headers: { Cookie: c.header(), 'X-CSRF-Token': cookies.get('csrf_token'), 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
                body: body === undefined ? undefined : JSON.stringify(body),
            });
            c.absorb(r);
            const text = await r.text();
            let json = null;
            try { json = JSON.parse(text); } catch { /* не JSON */ }
            return { status: r.status, json, headers: r.headers };
        },
        absorb(r) {
            for (const s of (r.headers.getSetCookie?.() ?? [])) {
                const [pair] = s.split(';');
                const i = pair.indexOf('=');
                cookies.set(pair.slice(0, i), pair.slice(i + 1));
            }
        },
        // Сокет с кукой этого клиента; собирает все newMessage.
        socket(roomKey) {
            const sock = ioClient(BASE, { extraHeaders: { Cookie: c.header() }, transports: ['websocket'], reconnection: false });
            sock.received = [];
            sock.on('newMessage', m => sock.received.push(m));
            return new Promise((resolve, reject) => {
                sock.once('connect', () => { if (roomKey) sock.emit('joinChat', roomKey); setTimeout(() => resolve(sock), 300); });
                sock.once('connect_error', reject);
            });
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
async function login(name, password = 'password123') {
    const c = client();
    const r = await c.req('POST', '/api/login', { email: `${name}@example.com`, password });
    if (!r.json?.success) throw new Error(`вход ${name}: ${r.json?.message}`);
    c.userId = r.json.user.id;
    return c;
}
async function roomChat(owner, name, ...guests) {
    const created = await owner.req('POST', '/api/chats', { name });
    const code = (await owner.req('GET', `/api/chats/invite/${created.json.chat.id}`)).json.code;
    const chats = { [owner.userId]: created.json.chat.id };
    for (const g of guests) {
        await g.req('POST', '/api/chats/join', { code });
        const list = (await g.req('GET', '/api/chats')).json.chats;
        chats[g.userId] = list.find(ch => ch.room_id === created.json.chat.room_id).id;
    }
    return { roomId: created.json.chat.room_id, chats };
}
const connected = sock => new Promise(resolve => {
    if (!sock.connected) return resolve(false);
    setTimeout(() => resolve(sock.connected), 800);
});

/* ------------------------- ответы только внутри своего чата ------------------------- */

const alice = await register('alice');
const bob = await register('bob');
const eve = await register('eve');
const secret = await roomChat(alice, 'Секретный', bob);
const eveRoom = await roomChat(eve, 'Свой у Евы', bob);

const secretMsg = await alice.req('POST', '/api/messages', { chatId: secret.chats[alice.userId], text: 'пароль от сейфа 1234' });
const secretId = secretMsg.json.message.id;
const stolen = await eve.req('POST', '/api/messages', { chatId: eveRoom.chats[eve.userId], text: 'цитирую', replyToId: secretId });
check('ответ на сообщение из чужого чата не принимается', stolen.json?.success === false, stolen.json?.message);

// Такие ответы могли остаться в базе с прежних времён — история не должна
// вытаскивать по ним чужой текст.
const planted = await eve.req('POST', '/api/messages', { chatId: eveRoom.chats[eve.userId], text: 'старый ответ' });
await db.query('UPDATE messages SET reply_to_id = $1 WHERE id = $2', [secretId, planted.json.message.id]);
const history = (await eve.req('GET', `/api/messages/${eveRoom.chats[eve.userId]}`)).json.messages;
check('и старый такой ответ не открывает в истории чужую цитату',
    !JSON.stringify(history).includes('пароль от сейфа'), JSON.stringify(history.find(m => m.id === planted.json.message.id)?.reply_to));

const ownReply = await bob.req('POST', '/api/messages', { chatId: secret.chats[bob.userId], text: 'понял', replyToId: secretId });
check('ответ внутри своего чата проходит', ownReply.json?.success === true && ownReply.json.message.reply_to_id === secretId,
    ownReply.json?.message?.reply_to_id);

/* ------------------------- вышедший из чата не слышит его ------------------------- */

const bobSock = await bob.socket(`room:${secret.roomId}`);
await alice.req('POST', '/api/messages', { chatId: secret.chats[alice.userId], text: 'пока Боб здесь' });
await sleep(400);
check('участник получает сообщения по сокету', bobSock.received.some(m => m.text === 'пока Боб здесь'));
await bob.req('DELETE', `/api/chats/${secret.chats[bob.userId]}`);
await alice.req('POST', '/api/messages', { chatId: secret.chats[alice.userId], text: 'Боб уже ушёл' });
await sleep(400);
check('после выхода из чата — нет', !bobSock.received.some(m => m.text === 'Боб уже ушёл'));
bobSock.close();

/* ------------------------- выход из аккаунта и смена пароля ------------------------- */

const aliceLaptop = await login('alice');
const phoneSock = await alice.socket();
const laptopSock = await aliceLaptop.socket();
await aliceLaptop.req('POST', '/api/logout');
check('выход отключает сокет этой сессии', !(await connected(laptopSock)));
check('а сокет на другом устройстве остаётся', await connected(phoneSock));

const aliceTablet = await login('alice');
const tabletSock = await aliceTablet.socket();
const changed = await alice.req('POST', '/api/change-password',
    { currentPassword: 'password123', newPassword: 'password456', confirmPassword: 'password456' });
check('пароль сменён', changed.json?.success === true, changed.json?.message);
const tabletAuth = (await aliceTablet.req('GET', '/api/auth')).json;
check('после смены пароля другая сессия больше не вошедшая', tabletAuth?.authenticated === false, JSON.stringify(tabletAuth));
check('и её сокет отключён', !(await connected(tabletSock)));
const left = await db.query(`SELECT count(*) FROM "session" WHERE sess->>'userId' = $1`, [String(alice.userId)]);
check('в базе не осталось ни одной сессии Алисы', Number(left.rows[0].count) === 0);
phoneSock.close();

/* ------------------------- новая сессия при регистрации ------------------------- */

const fixated = client();
await fixated.req('POST', '/api/register/anonymous');
const sidBefore = fixated.sid();
await fixated.req('POST', '/api/register', { username: 'carol', email: 'carol@example.com', password: 'password123', confirmPassword: 'password123' });
check('регистрация выдаёт новый id сессии', !!sidBefore && !!fixated.sid() && fixated.sid() !== sidBefore);

/* ------------------------- ключи — только собеседникам ------------------------- */

const alice2 = await login('alice', 'password456');
const stranger = await eve.req('GET', `/api/keys/identities/${alice2.userId}`);
const nobody = await eve.req('GET', '/api/keys/identities/999999');
check('посторонний не получает ключи устройств', stranger.status === 404, stranger.status);
check('и не отличит чужой id от несуществующего', stranger.status === nobody.status
    && stranger.json?.message === nobody.json?.message, `${stranger.json?.message} / ${nobody.json?.message}`);
const strangerBundle = await eve.req('GET', `/api/keys/bundle/${alice2.userId}`);
check('и bundle тоже', strangerBundle.status === 404 && strangerBundle.json?.message === stranger.json?.message);
const peer = await bob.req('GET', `/api/keys/identities/${eve.userId}`);
check('собеседник (общий чат) — получает', peer.json?.message !== stranger.json?.message, `${peer.status} ${peer.json?.message}`);
const self = await alice2.req('GET', `/api/keys/identities/${alice2.userId}`);
check('и сам пользователь — свои', self.json?.message !== stranger.json?.message, `${self.status} ${self.json?.message}`);

/* ------------------------- дальние сроки исчезающих сообщений ------------------------- */

const MONTH = 30 * 24 * 3600;
const longLived = await bob.req('POST', '/api/messages', { chatId: eveRoom.chats[bob.userId], text: 'живу месяц', expirySeconds: MONTH });
await sleep(1500);
const row = await db.query(
    `SELECT m.deleted, extract(epoch FROM e.expires_at - now()) AS left FROM messages m
     JOIN message_expiry e ON e.message_id = m.id WHERE m.id = $1`, [longLived.json.message.id]);
check('сообщение со сроком в месяц не исчезло сразу', row.rows[0]?.deleted === 0, JSON.stringify(row.rows[0]));
check('и срок записан верно', Math.abs(Number(row.rows[0]?.left) - MONTH) < 60, row.rows[0]?.left);
const tooLong = await bob.req('POST', '/api/messages', { chatId: eveRoom.chats[bob.userId], text: 'десять лет', expirySeconds: 10 * 365 * 24 * 3600 });
check('срок больше года отклоняется', tooLong.json?.success === false, tooLong.json?.message);
const negative = await bob.req('POST', '/api/messages', { chatId: eveRoom.chats[bob.userId], text: 'минус', expirySeconds: -5 });
check('отрицательный — тоже', negative.json?.success === false, negative.json?.message);
const short = await bob.req('POST', '/api/messages', { chatId: eveRoom.chats[bob.userId], text: 'две секунды', expirySeconds: 2 });
await sleep(3000);
const shortRow = await db.query('SELECT deleted FROM messages WHERE id = $1', [short.json.message.id]);
check('короткий срок по-прежнему срабатывает по таймеру', shortRow.rows[0]?.deleted === 1);

/* ------------------------- брошенный анонимный аккаунт ------------------------- */

const anon = client();
const anonReg = await anon.req('POST', '/api/register/anonymous');
const anonId = anonReg.json.user.id;
await anon.req('POST', '/api/chats', { name: 'Мои заметки' });
// Вкладку закрыли: сессия истекла, аккаунт создан давно.
await db.query(`DELETE FROM "session" WHERE sess->>'userId' = $1`, [String(anonId)]);
await db.query(`UPDATE users SET created_at = now() - interval '5 hours' WHERE id = $1`, [anonId]);
const liveAnon = client();
const liveReg = await liveAnon.req('POST', '/api/register/anonymous');
await db.query(`UPDATE users SET created_at = now() - interval '1 hour' WHERE id = $1`, [liveReg.json.user.id]);
await sleep(3500);
const anonLeft = await db.query('SELECT id FROM users WHERE id = $1', [anonId]);
const anonChats = await db.query('SELECT id FROM chats WHERE user_id = $1', [anonId]);
check('брошенный анонимный аккаунт удалён уборкой', anonLeft.rows.length === 0 && anonChats.rows.length === 0);
const liveLeft = await db.query('SELECT id FROM users WHERE id = $1', [liveReg.json.user.id]);
check('а тот, чья сессия жива, — на месте', liveLeft.rows.length === 1);

/* ------------------------- вход по коду приглашения ------------------------- */

const host = await register('host');
const guest = await register('guest');
const room = await host.req('POST', '/api/chats', { name: 'По приглашению' });
const hostChat = room.json.chat.id;
const firstCode = (await host.req('GET', `/api/chats/invite/${hostChat}`)).json.code;
await guest.req('POST', '/api/chats/join', { code: firstCode });
const systemLines = async () => (await host.req('GET', `/api/messages/${hostChat}`)).json.messages
    .filter(m => m.message_type === 'system').map(m => m.text);
check('вошедший по коду виден всем: системное сообщение', (await systemLines()).some(t => t.startsWith('guest вошёл')),
    JSON.stringify(await systemLines()));
const joinLine = (await guest.req('GET', `/api/messages/${(await guest.req('GET', '/api/chats')).json.chats
    .find(c => c.room_id === room.json.chat.room_id).id}`)).json.messages.find(m => m.message_type === 'system');
await guest.req('DELETE', `/api/messages/${joinLine.id}`);
await guest.req('PUT', `/api/messages/${joinLine.id}`, { text: 'ничего не было' });
await guest.req('POST', `/api/messages/${joinLine.id}/set-expiry`, { expirySeconds: 1 });
await sleep(2500);
check('вошедший не может стереть, переписать или «состарить» строку о своём входе',
    (await systemLines()).some(t => t.startsWith('guest вошёл')) && !(await systemLines()).includes('ничего не было'),
    JSON.stringify(await systemLines()));

const reset = await host.req('POST', `/api/chats/${hostChat}/invite`, { action: 'reset' });
check('код можно сменить', reset.json?.success === true && reset.json.code && reset.json.code !== firstCode);
const late = await register('late');
const byOld = await late.req('POST', '/api/chats/join', { code: firstCode });
check('по старому коду больше не войти', byOld.json?.success === false, byOld.json?.message);
const byNew = await late.req('POST', '/api/chats/join', { code: reset.json.code });
check('по новому — можно', byNew.json?.success === true);
check('смена кода видна в переписке', (await systemLines()).some(t => t.includes('сменил(а) код')));

const disabled = await host.req('POST', `/api/chats/${hostChat}/invite`, { action: 'disable' });
check('приглашение можно отключить', disabled.json?.success === true && disabled.json.code === null);
const shown = await host.req('GET', `/api/chats/invite/${hostChat}`);
check('отключённое показывается как отсутствие кода', shown.json?.success === true && shown.json.code === null);
const lateChats = (await late.req('GET', '/api/chats')).json.chats;
await late.req('DELETE', `/api/chats/${lateChats.find(c => c.room_id === room.json.chat.room_id).id}`);
check('выход из чата тоже виден', (await systemLines()).some(t => t.startsWith('late вышел')));

// Перебор кода: после десяти неудачных попыток — стоп.
const guesser = await register('guesser');
let lastGuess;
for (let i = 0; i < 11; i++) lastGuess = await guesser.req('POST', '/api/chats/join', { code: `ZZZZZ${i}` });
check('перебор кода упирается в лимит', lastGuess.status === 429, `${lastGuess.status} ${lastGuess.json?.message}`);
const honest = await register('honest');
for (let i = 0; i < 3; i++) {
    const r = await host.req('POST', `/api/chats/${hostChat}/invite`, { action: 'reset' });
    const joined = await honest.req('POST', '/api/chats/join', { code: r.json.code });
    if (i === 2) check('удачные входы в лимит не считаются', joined.json?.success === true);
}

/* ------------------------- анонимный участник уходит ------------------------- */

const anonGuest = client();
await anonGuest.req('POST', '/api/register/anonymous');
const anonRoom = await host.req('POST', '/api/chats', { name: 'С анонимом' });
const anonRoomChat = anonRoom.json.chat.id;
const anonCode = (await host.req('GET', `/api/chats/invite/${anonRoomChat}`)).json.code;
await anonGuest.req('POST', '/api/chats/join', { code: anonCode });
const anonName = (await anonGuest.req('GET', '/api/auth')).json.user.username;
await anonGuest.req('POST', '/api/logout');
const afterAnon = (await host.req('GET', `/api/messages/${anonRoomChat}`)).json.messages
    .filter(m => m.message_type === 'system').map(m => m.text);
check('анонимный участник не уходит без следа: вход и выход видны после удаления аккаунта',
    afterAnon.some(t => t.startsWith(`${anonName} вошёл`)) && afterAnon.some(t => t.startsWith(`${anonName} вышел`)),
    JSON.stringify(afterAnon));

/* ------------------------- пароли и вход ------------------------- */

// bcrypt видит только 72 байта: два пароля с общим началом такой длины
// раньше были одним и тем же паролем.
const longA = 'пароль'.repeat(12) + 'А';
const longB = 'пароль'.repeat(12) + 'Б';
const longUser = client();
await longUser.req('POST', '/api/register', { username: 'longpass', email: 'longpass@example.com', password: longA, confirmPassword: longA });
const wrongTail = await client().req('POST', '/api/login', { email: 'longpass@example.com', password: longB });
check('пароль учитывается целиком, а не первые 72 байта', wrongTail.json?.success === false, wrongTail.json?.message);
const rightTail = await client().req('POST', '/api/login', { email: 'longpass@example.com', password: longA });
check('верный длинный пароль подходит', rightTail.json?.success === true);

// Старый хеш (bcrypt от самого пароля) подходит и при входе пересчитывается.
const legacy = await register('legacy');
await db.query('UPDATE users SET password = $1 WHERE id = $2', [bcrypt.hashSync('password123', 10), legacy.userId]);
const legacyLogin = await client().req('POST', '/api/login', { email: 'legacy@example.com', password: 'password123' });
const upgraded = (await db.query('SELECT password FROM users WHERE id = $1', [legacy.userId])).rows[0].password;
check('старый хеш пароля подходит и переводится в новый формат',
    legacyLogin.json?.success === true && upgraded.startsWith('sha256-bcrypt$'), upgraded.slice(0, 20));

// Подбор пароля к одному email с разных адресов.
let guessed;
for (let i = 0; i < 21; i++) guessed = await client().req('POST', '/api/login', { email: 'legacy@example.com', password: `guess${i}` });
check('подбор к одному email с разных адресов упирается в лимит', guessed.status === 429, `${guessed.status} ${guessed.json?.message}`);

// Изменяющий запрос с чужого сайта.
const csrfVictim = await login('bob');
const crossSite = await fetch(BASE + '/api/chats', { method: 'POST',
    headers: { Cookie: csrfVictim.header(), 'X-CSRF-Token': /csrf_token=([^;]+)/.exec(csrfVictim.header())[1],
        'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ name: 'от чужого сайта' }) });
check('изменяющий запрос с чужим Origin отклоняется, даже с токеном', crossSite.status === 403);
const sameSite = await fetch(BASE + '/api/chats', { method: 'POST',
    headers: { Cookie: csrfVictim.header(), 'X-CSRF-Token': /csrf_token=([^;]+)/.exec(csrfVictim.header())[1],
        'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ name: 'со своего' }) });
check('а со своего — проходит', sameSite.status === 200 && (await sameSite.json()).success === true);

/* ------------------------- заголовки ------------------------- */

const plain = await fetch(BASE + '/');
const csp = plain.headers.get('content-security-policy') || '';
check("CSP: connect-src только 'self'", /connect-src 'self';/.test(csp) && !/connect-src[^;]*ws:/.test(csp), csp.match(/connect-src[^;]*/)?.[0]);
check('по HTTP заголовка HSTS нет', !plain.headers.get('strict-transport-security'));
const https = await fetch(BASE + '/', { headers: { 'X-Forwarded-Proto': 'https' } });
check('по HTTPS (за прокси) — есть', /max-age=\d{7,}/.test(https.headers.get('strict-transport-security') || ''),
    https.headers.get('strict-transport-security'));

await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
