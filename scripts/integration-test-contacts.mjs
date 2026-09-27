// Личные чаты: код пользователя, запросы на переписку, блокировка
// (routes/contacts.js, migrations/013).
//
//   - код пользователя: 12 знаков, ищется без различия регистра, с
//     дефисами и пробелами; «Сменить код» — прежний больше не находит;
//   - «кода нет», «запросы выключены» и «вас заблокировали» — один ответ;
//   - не больше 20 поисков по коду в час;
//   - запрос без текста; отправитель не узнаёт, отклонён ли запрос;
//     повторный запрос не множит уведомления; встречный запрос — сразу чат;
//   - «Принять» — личный чат на двоих, название — имя собеседника, у
//     отправителя чат появляется событием; ссылок и названия у него нет;
//   - «Заблокировать»: ни запросов, ни сообщений; разблокировать можно;
//   - лимит запросов в сутки.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/integration-test-contacts.mjs

import { io as ioClient } from 'socket.io-client';
import pg from 'pg';
import { createRequire } from 'node:module';

const migration = createRequire(import.meta.url)('../migrations/013_direct_chats.js');
const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

let nextIp = 1;
function client() {
    const cookies = new Map();
    const ip = `10.33.0.${nextIp++}`;
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
                headers: { Cookie: c.header(), 'X-CSRF-Token': cookies.get('csrf_token'), 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
                body: body === undefined ? undefined : JSON.stringify(body) });
            c.absorb(r);
            let json = null;
            try { json = await r.json(); } catch { /* не JSON */ }
            return { status: r.status, json };
        },
        events: {},
        async listen() {
            c.sock = ioClient(BASE, { extraHeaders: { Cookie: c.header(), 'X-Forwarded-For': ip }, transports: ['websocket'], reconnection: false });
            c.sock.onAny((name, data) => (c.events[name] ||= []).push(data));
            await new Promise((resolve, reject) => {
                c.sock.once('connect', resolve);
                c.sock.once('connect_error', reject);
                c.sock.once('disconnect', () => reject(new Error('сокет отключён')));
            });
        },
        async code() {
            return (await c.req('GET', '/api/user/code')).json.code;
        },
    };
    return c;
}
async function register(name) {
    const c = client();
    const r = await c.req('POST', '/api/register', { username: name, email: `${name}@example.com`, password: 'password123', confirmPassword: 'password123' });
    if (!r.json?.user) throw new Error(`регистрация ${name}: ${r.status} ${JSON.stringify(r.json)}`);
    c.userId = r.json.user.id;
    await c.listen();
    return c;
}

const alice = await register('alice');
const bob = await register('bob');
const carol = await register('carol');
const mallory = await register('mallory');

/* ------------------------- код пользователя ------------------------- */

const aliceCode = await alice.code();
check('код — 12 знаков группами по 4', /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/.test(aliceCode), aliceCode);
const messy = ` ${aliceCode.toLowerCase().replace(/-/g, ' ')} `;
const found = (await bob.req('POST', '/api/contacts/lookup', { code: messy })).json;
check('поиск без различия регистра, с пробелами', found.success && found.user.username === 'alice' && found.chat === null, JSON.stringify(found));
check('свой код — «это ваш»', (await alice.req('POST', '/api/contacts/lookup', { code: aliceCode })).json.code === 'OWN_CODE');

const missing = (await bob.req('POST', '/api/contacts/lookup', { code: 'ABCD-EFGH-JKMN' })).json;
await carol.req('POST', '/api/user/code-requests', { enabled: false });
const closed = (await bob.req('POST', '/api/contacts/lookup', { code: await carol.code() })).json;
check('«кода нет» и «запросы выключены» — один и тот же ответ',
    missing.code === 'CODE_NOT_FOUND' && JSON.stringify(missing) === JSON.stringify(closed), JSON.stringify(closed));
const closedRequest = (await bob.req('POST', '/api/direct-requests', { code: await carol.code() })).json;
check('и запрос на выключенный код — тот же ответ', JSON.stringify(closedRequest) === JSON.stringify(missing));
await carol.req('POST', '/api/user/code-requests', { enabled: true });

const oldCode = aliceCode;
const rotated = (await alice.req('POST', '/api/user/code')).json;
check('«Сменить код»: новый код, прежний не находит', rotated.code !== oldCode
    && (await bob.req('POST', '/api/contacts/lookup', { code: oldCode })).json.code === 'CODE_NOT_FOUND'
    && (await bob.req('POST', '/api/contacts/lookup', { code: rotated.code })).json.success);

/* ------------------------- запрос и принятие ------------------------- */

const sent = (await bob.req('POST', '/api/direct-requests', { code: rotated.code })).json;
await sleep(300);
check('запрос отправлен, у получателя — событие', sent.success && sent.pending && sent.request.username === 'alice'
    && (alice.events.directRequestsChanged || []).length === 1, JSON.stringify(sent));
const again = (await bob.req('POST', '/api/direct-requests', { code: rotated.code })).json;
await sleep(300);
check('повторный запрос — тот же, без второго уведомления', again.request.id === sent.request.id
    && alice.events.directRequestsChanged.length === 1);
const inbox = (await alice.req('GET', '/api/direct-requests')).json;
check('у получателя — входящий, без текста: только кто и когда',
    inbox.incoming.length === 1 && JSON.stringify(Object.keys(inbox.incoming[0]).sort()) === '["created_at","id","user_id","username"]',
    JSON.stringify(inbox.incoming));
check('у отправителя — исходящий', (await bob.req('GET', '/api/direct-requests')).json.outgoing.length === 1);
const identities = await bob.req('GET', `/api/keys/identities/${alice.userId}`);
const bundle = await bob.req('GET', `/api/keys/bundle/${alice.userId}`);
check('с запросом на переписку публичные ключи видны (для QR при встрече), одноразовые prekeys — нет',
    identities.status === 200 && bundle.status === 404, `${identities.status} ${bundle.status}`);
check('без чата и запроса — не видны', (await mallory.req('GET', `/api/keys/identities/${alice.userId}`)).status === 404);
check('чужой запрос не принять', (await carol.req('POST', `/api/direct-requests/${sent.request.id}`, { action: 'accept' })).status === 404);

const accepted = (await alice.req('POST', `/api/direct-requests/${sent.request.id}`, { action: 'accept' })).json;
await sleep(400);
const aliceChat = (await alice.req('GET', '/api/chats')).json.chats.find(c => c.id === accepted.chat?.id);
const bobChats = (await bob.req('GET', '/api/chats')).json.chats;
const bobChat = bobChats.find(c => c.room_id === aliceChat?.room_id);
check('«Принять»: личный чат, название — имя собеседника',
    aliceChat?.kind === 'direct' && aliceChat.name === 'bob' && bobChat?.name === 'alice' && bobChat.kind === 'direct',
    JSON.stringify([aliceChat, bobChat]));
check('отправителю — событие с его чатом', bob.events.directRequestAccepted?.[0]?.chat?.id === bobChat?.id,
    JSON.stringify(bob.events.directRequestAccepted));
check('у личного чата нет ссылки, названия и ролей',
    (await alice.req('POST', `/api/chats/${aliceChat.id}/link`, {})).status === 400
    && (await alice.req('POST', `/api/chats/${aliceChat.id}/name`, { name: 'x' })).status === 400);
// Устройства и конверт-заглушка: чат и блокировку сервер проверяет раньше,
// чем адресатов конвертов.
for (const c of [alice, bob]) await c.req('POST', '/api/devices', { name: 'тест' });
const envelope = [{ deviceId: 1, type: 1, header: 'AA==', ciphertext: 'AA==' }];
const writeTo = (c, chatId) => c.req('POST', '/api/messages/encrypted', { chatId, envelopes: envelope });
const allowed = r => !['ROOM_EMPTY', 'BLOCKED'].includes(r.json?.code) && r.status !== 403;
const encrypted = await writeTo(bob, bobChat.id);
check('писать в него можно (сервер не отказывает ни из-за пустой комнаты, ни из-за блокировки)',
    allowed(encrypted), `${encrypted.status} ${JSON.stringify(encrypted.json)}`);
const repeat = (await bob.req('POST', '/api/direct-requests', { code: rotated.code })).json;
check('запрос тому, с кем уже есть чат, — просто этот чат', repeat.chat?.id === bobChat.id);
check('поиск показывает, что чат уже есть', (await bob.req('POST', '/api/contacts/lookup', { code: rotated.code })).json.chat?.id === bobChat.id);

/* ------------------------- встречный запрос ------------------------- */

await carol.req('POST', '/api/direct-requests', { code: await alice.code() });
const mutual = (await alice.req('POST', '/api/direct-requests', { code: await carol.code() })).json;
check('встречный запрос — сразу чат', mutual.success && mutual.chat?.id > 0 && !mutual.pending, JSON.stringify(mutual));

/* ------------------------- отказ и блокировка ------------------------- */

const pushy = (await mallory.req('POST', '/api/direct-requests', { code: await alice.code() })).json;
await alice.req('POST', `/api/direct-requests/${pushy.request.id}`, { action: 'decline' });
const afterDecline = (await mallory.req('GET', '/api/direct-requests')).json.outgoing;
check('отклонённый у отправителя выглядит как ждущий', afterDecline.length === 1 && !('status' in afterDecline[0]),
    JSON.stringify(afterDecline));
const eventsBefore = alice.events.directRequestsChanged.length;
const retry = (await mallory.req('POST', '/api/direct-requests', { code: await alice.code() })).json;
await sleep(300);
check('повтор после отказа — «отправлен», но получателя не беспокоит',
    retry.pending && alice.events.directRequestsChanged.length === eventsBefore
    && (await alice.req('GET', '/api/direct-requests')).json.incoming.length === 0);

const blocked = await alice.req('POST', '/api/blocks', { userId: mallory.userId });
check('заблокировать того, кто присылал запрос', blocked.json?.success === true);
const hidden = (await mallory.req('POST', '/api/contacts/lookup', { code: await alice.code() })).json;
check('заблокированный ищет — тот же ответ, что «кода нет»', JSON.stringify(hidden) === JSON.stringify(missing));
check('незнакомого по id не заблокировать', (await alice.req('POST', '/api/blocks', { userId: carol.userId + 1000 })).status === 404);

// Блокировка в личном чате: ни сообщений, ни вложений.
await alice.req('POST', '/api/blocks', { userId: bob.userId });
const fromBob = await writeTo(bob, bobChat.id);
const fromAlice = await writeTo(alice, aliceChat.id);
check('заблокированный не может писать, и заблокировавший тоже, пока не разблокирует',
    fromBob.status === 403 && fromBob.json.code === 'BLOCKED' && fromAlice.status === 403 && /разблокируйте/.test(fromAlice.json.message),
    `${fromBob.status} ${fromAlice.status}`);
const blob = await fetch(`${BASE}/api/blobs?chatId=${bobChat.id}`, { method: 'POST',
    headers: { Cookie: bob.header(), 'X-CSRF-Token': bob.header().match(/csrf_token=([^;]+)/)[1], 'Content-Type': 'application/octet-stream',
        'X-Forwarded-For': '10.33.0.2' }, body: new Uint8Array(64) });
check('и вложения тоже', blob.status === 403, String(blob.status));
check('в списке у заблокировавшего — отметка', (await alice.req('GET', '/api/chats')).json.chats.find(c => c.id === aliceChat.id).peer_blocked === true);
const list = (await alice.req('GET', '/api/blocks')).json.blocked.map(b => b.username).sort();
check('список заблокированных', JSON.stringify(list) === '["bob","mallory"]', JSON.stringify(list));
await alice.req('DELETE', `/api/blocks/${bob.userId}`);
check('разблокировали — писать снова можно',
    allowed(await writeTo(bob, bobChat.id)));

/* ------------------------- лимиты ------------------------- */

const spammer = await register('spammer');
const targets = [];
for (let i = 0; i < 3; i++) targets.push(await (await register(`target${i}`)).code());
// Двадцать запросов за сутки уже было.
for (let i = 0; i < 20; i++) {
    await db.query("INSERT INTO direct_requests (from_user_id, to_user_id, status) VALUES ($1, $2, 'cancelled')", [spammer.userId, alice.userId]);
}
const overDaily = await spammer.req('POST', '/api/direct-requests', { code: targets[0] });
check('больше 20 запросов в сутки — нельзя', overDaily.status === 429 && overDaily.json.code === 'DAILY_LIMIT', JSON.stringify(overDaily.json));

const prober = await register('prober');
let last;
for (let i = 0; i < 21; i++) last = await prober.req('POST', '/api/contacts/lookup', { code: 'ZZZZ-ZZZZ-ZZZZ' });
check('больше 20 поисков по коду в час — стоп', last.status === 429, `${last.status} ${last.json?.message}`);

/* ------------------------- миграция ------------------------- */

// Так выглядел пользователь до миграции: восьмизначный код в разном регистре.
await db.query("INSERT INTO users (unique_code, username, email, password) VALUES ('aB3dE5gH', 'old', 'old@example.com', 'x')");
const conn = await db.connect();
await migration.up(conn);
conn.release();
const codes = (await db.query('SELECT unique_code FROM users')).rows.map(r => r.unique_code);
check('миграция: у всех пользователей код нового вида, коды не повторяются',
    codes.every(c => /^[A-HJKMNP-Z2-9]{12}$/.test(c)) && new Set(codes).size === codes.length, codes.join(' '));
check('а уже новые коды миграция не трогает', codes.includes((await alice.code()).replace(/-/g, '')));

for (const c of [alice, bob, carol, mallory, spammer, prober]) c.sock.close();
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
