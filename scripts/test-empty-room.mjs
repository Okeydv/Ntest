// Пустая группа.
//
//   - сервер не принимает в комнату без собеседников ни текст, ни файл, ни
//     зашифрованное сообщение, ни вложение, ни правку: шифровать там не для
//     кого, и текст лёг бы на сервер открытым. Чат с ботом — не комната;
//   - в пустой группе вместо ленты экран «Пригласите участников», поле
//     ввода выключено; кто-то вошёл — поле включается само, без
//     перезагрузки, и сообщения уходят зашифрованными;
//   - все остальные вышли — история остаётся, приглашение встаёт полосой,
//     писать снова нельзя.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-empty-room.mjs

import { launch, finish } from './lib/browser.mjs';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
process.on('beforeExit', () => { console.log('FAIL  набор оборвался, не дойдя до конца'); process.exit(1); });

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.16.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return page;
}
const register = (page, u) => page.evaluate(async u => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp(); await setupE2EE(); await loadChats();
}, u);
const ROOM = '.chat-item[data-room-id]:not([data-room-id=""])';
const BOT = '.chat-item[data-room-id=""]';
const view = page => page.evaluate(() => ({
    empty: !document.getElementById('room-empty').hidden,
    strip: document.getElementById('room-empty').classList.contains('is-strip'),
    feed: !document.getElementById('chat-messages').hidden,
    input: !document.getElementById('message-input').disabled,
    attach: !document.getElementById('attach-btn').disabled,
}));

const alice = await openApp('alice');
await register(alice, 'alice');

// Создаём группу так же, как человек: через окно «Новый чат».
await alice.click('#new-chat-btn');
await alice.fill('#new-chat-name', 'Пусто');
await alice.click('#create-chat-btn');
await alice.waitForTimeout(1500);
const chat = await alice.evaluate(() => ({ id: currentChatId, room: currentRoomId }));
let state = await view(alice);
check('новая группа — экран «Пригласите участников» вместо ленты', state.empty && !state.strip && !state.feed, JSON.stringify(state));
check('поле ввода и скрепка выключены', !state.input && !state.attach, JSON.stringify(state));
check('на экране — кнопка кода приглашения', await alice.isVisible('#room-empty-invite'));
await alice.click('#room-empty-invite');
await alice.waitForFunction(() => document.getElementById('invite-modal').open);
const code = (await alice.textContent('#invite-code-display')).trim();
check('кнопка открывает код приглашения', /\S{4,}/.test(code), code);
await alice.keyboard.press('Escape');

/* ------------------------- сервер ------------------------- */

const post = (path, body, headers = { 'Content-Type': 'application/json' }) => alice.evaluate(async ([path, body, headers]) => {
    const r = await fetch(path, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': await csrfToken() },
        body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
}, [path, body, headers]);

const plain = await post('/api/messages', { chatId: chat.id, text: 'секрет в пустой комнате' });
check('открытый текст в пустую комнату — отказ', plain.status === 409 && plain.code === 'ROOM_EMPTY', JSON.stringify(plain));
const stored = (await db.query("SELECT count(*)::int AS n FROM messages WHERE text LIKE '%секрет в пустой%'")).rows[0].n;
check('на сервере текста нет', stored === 0, String(stored));

const file = await alice.evaluate(async id => {
    const form = new FormData();
    form.append('file', new Blob(['заметка'], { type: 'text/plain' }), 'note.txt');
    form.append('chatId', String(id));
    const r = await fetch('/api/messages/file', { method: 'POST', headers: { 'X-CSRF-Token': await csrfToken() }, body: form });
    return { status: r.status, ...(await r.json()) };
}, chat.id);
check('файл в пустую комнату — отказ', file.status === 409 && file.code === 'ROOM_EMPTY', JSON.stringify(file));

const blob = await alice.evaluate(async id => {
    const r = await fetch(`/api/blobs?chatId=${id}`, { method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': await csrfToken() }, body: new Uint8Array(64) });
    return { status: r.status, ...(await r.json()) };
}, chat.id);
check('зашифрованное вложение в пустую комнату — отказ', blob.status === 409 && blob.code === 'ROOM_EMPTY', JSON.stringify(blob));

const enc = await post('/api/messages/encrypted', { chatId: chat.id, envelopes: [{ deviceId: 1, type: 1, header: 'AA==', ciphertext: 'AA==' }] });
check('зашифрованное сообщение в пустую комнату — отказ', enc.status === 409 && enc.code === 'ROOM_EMPTY', JSON.stringify(enc));

const botChat = await alice.evaluate(async () => (await api('/api/chats')).chats.find(c => c.is_bot).id);
const toBot = await post('/api/messages', { chatId: botChat, text: 'привет, бот' });
check('чат с ботом — не комната, туда писать можно', toBot.success === true, JSON.stringify(toBot));

/* ------------------------- кто-то вошёл ------------------------- */

await alice.locator(ROOM).first().click();
await alice.waitForTimeout(800);
const bob = await openApp('bob');
await register(bob, 'bob');
const joined = await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
check('Боб входит по коду', joined.success, JSON.stringify(joined));
await alice.waitForTimeout(2000);
state = await view(alice);
check('Боб вошёл — у Алисы поле включилось без перезагрузки', !state.empty && state.feed && state.input && state.attach, JSON.stringify(state));
check('и в шапке — «В сети» или «Не в сети», а не «Пока никого»',
    /сети/.test(await alice.textContent('#chat-status')), await alice.textContent('#chat-status'));
await alice.fill('#message-input', 'теперь есть кому');
await alice.press('#message-input', 'Enter');
await alice.waitForTimeout(1500);
const sent = (await db.query("SELECT encrypted, text FROM messages WHERE room_id = $1 AND sent = 1 ORDER BY id DESC LIMIT 1", [chat.room])).rows[0];
check('сообщение ушло зашифрованным', sent && sent.encrypted === true && sent.text === null, JSON.stringify(sent));
await bob.reload({ waitUntil: 'networkidle' });
await bob.waitForTimeout(1000);
await bob.locator(ROOM).first().click();
await bob.waitForTimeout(1500);
check('Боб его прочитал', (await bob.textContent('#chat-messages')).includes('теперь есть кому'));

/* ------------------------- все вышли ------------------------- */

const bobChat = await bob.evaluate(() => currentChatId);
await bob.evaluate(id => api(`/api/chats/${id}`, { method: 'DELETE' }), bobChat);
await alice.waitForTimeout(2000);
state = await view(alice);
check('Боб вышел — история на месте, приглашение полосой', state.empty && state.strip && state.feed, JSON.stringify(state));
check('писать снова нельзя', !state.input && !state.attach, JSON.stringify(state));

// Старое открытое сообщение (например, до этой проверки) не правится в пустой комнате.
const old = (await db.query(
    `INSERT INTO messages (chat_id, room_id, user_id, text, message_type, sent, time, status)
     SELECT $1, $2, user_id, 'старое', 'text', 1, '00:00', 'sent' FROM chats WHERE id = $1 RETURNING id`,
    [chat.id, chat.room])).rows[0].id;
const edit = await alice.evaluate(async id => {
    const r = await fetch(`/api/messages/${id}`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await csrfToken() }, body: JSON.stringify({ text: 'новый секрет' }) });
    return { status: r.status, ...(await r.json()) };
}, old);
check('правка в опустевшей комнате — отказ', edit.status === 409 && edit.code === 'ROOM_EMPTY', JSON.stringify(edit));

await alice.locator(BOT).first().click();
await alice.waitForTimeout(800);
state = await view(alice);
check('в чате с ботом поле включено', state.input && !state.empty && state.feed, JSON.stringify(state));

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
