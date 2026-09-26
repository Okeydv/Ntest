// Непрочитанное и статусы сообщений.
//
//   - счётчик непрочитанного в списке чатов и в заголовке вкладки считает
//     сообщения собеседника (раньше был всегда 0);
//   - «доставлено» — когда сообщение дошло до устройства собеседника,
//     «прочитано» — когда он открыл чат и конец переписки у него на экране;
//     галочки у отправителя меняются сразу, без перезагрузки;
//   - пришедшее во вкладку в фоне — только доставлено; вкладка на экране —
//     прочитано;
//   - кто выключил отметки о прочтении, тот их не отправляет и не видит;
//   - у файлов «прочитано» больше не ставится таймером;
//   - отметку не сдвинуть за конец чата и не поставить в чужом чате;
//   - обрыв сокета виден плашкой, а после переподключения пропущенное
//     догружается и новые сообщения снова приходят вживую.
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-read-state.mjs

import { launch, finish } from './lib/browser.mjs';
import pg from 'pg';

const BASE = 'http://127.0.0.1:3006';
const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
let fails = 0;
const check = (l, c, d = '') => { console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await launch();
const errors = [];
let nextIp = 10;
async function openApp(label) {
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.12.${nextIp++}` } });
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
async function openRoom(page) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator(ROOM).first().click();
    await page.waitForTimeout(1000);
}
async function send(page, text) {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForTimeout(1200);
}
const badge = page => page.evaluate(sel => document.querySelector(`${sel} .chat-badge`)?.textContent || '0', ROOM);
const statuses = page => page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message.sent .message-status')].map(s => s.dataset.status));
const setHidden = (page, hidden) => page.evaluate(hidden => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
}, hidden);

const alice = await openApp('alice');
await register(alice, 'alice');
const bob = await openApp('bob');
await register(bob, 'bob');
const room = await alice.evaluate(async () => {
    const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Двое' }) });
    return { chatId: c.chat.id, roomId: c.chat.room_id, code: (await api(`/api/chats/invite/${c.chat.id}`)).code };
});
await bob.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), room.code);
await openRoom(alice);
await bob.reload({ waitUntil: 'networkidle' });
await bob.waitForTimeout(1200);

/* ------------------------- непрочитанное ------------------------- */

await send(alice, 'первое');
await send(alice, 'второе');
await bob.waitForTimeout(800);
check('у собеседника счётчик непрочитанного — 2', await badge(bob) === '2', await badge(bob));
check('и в заголовке вкладки', (await bob.title()).startsWith('(2) '), await bob.title());
check('у отправителя — «доставлено»: сообщения дошли до устройства',
    JSON.stringify(await statuses(alice)) === '["delivered","delivered"]', JSON.stringify(await statuses(alice)));

await bob.locator(ROOM).first().click();
await bob.waitForTimeout(1500);
check('открыл чат — у отправителя сразу «прочитано»', JSON.stringify(await statuses(alice)) === '["read","read"]',
    JSON.stringify(await statuses(alice)));
check('а у читателя счётчик пропал', await badge(bob) === '0' && !(await bob.title()).startsWith('('), await bob.title());
check('после перезагрузки статусы те же', await (async () => { await openRoom(alice); return JSON.stringify(await statuses(alice)); })()
    === '["read","read"]');

/* ------------------------- вкладка в фоне ------------------------- */

await setHidden(bob, true);
await send(alice, 'пока вкладка в фоне');
await bob.waitForTimeout(800);
check('вкладка в фоне — только «доставлено»', (await statuses(alice)).at(-1) === 'delivered', JSON.stringify(await statuses(alice)));
await setHidden(bob, false);
await bob.waitForTimeout(1000);
check('вернулся на вкладку — «прочитано»', (await statuses(alice)).at(-1) === 'read', JSON.stringify(await statuses(alice)));

/* ------------------------- отметки выключены ------------------------- */

await bob.evaluate(() => api('/api/user/read-receipts', { method: 'POST', body: JSON.stringify({ enabled: false }) }));
await send(alice, 'прочитает молча');
await bob.waitForTimeout(1200);
check('выключил отметки — отправитель видит только «доставлено»', (await statuses(alice)).at(-1) === 'delivered',
    JSON.stringify(await statuses(alice)));
await send(bob, 'и я не узнаю, прочитали ли');
await alice.waitForTimeout(1200);
check('и сам не видит, прочитали ли его', (await statuses(bob)).at(-1) === 'delivered', JSON.stringify(await statuses(bob)));
await bob.evaluate(() => api('/api/user/read-receipts', { method: 'POST', body: JSON.stringify({ enabled: true }) }));
await alice.waitForTimeout(800);
check('включил снова — прочитанное видно', (await statuses(alice)).at(-1) === 'read', JSON.stringify(await statuses(alice)));

/* ------------------------- обрыв соединения ------------------------- */

// Сокет Боба рвётся и 4 секунды не может переподключиться.
await bob.evaluate(() => {
    socket.io.reconnectionDelay(4000);
    socket.io.reconnectionDelayMax(4000);
    socket.io.engine.close();
});
await bob.waitForTimeout(2000);
check('обрыв виден: «Нет соединения»', await bob.isVisible('#connection-status'));
const doomedId = (await db.query(
    "SELECT max(id) FROM messages WHERE room_id = $1 AND message_type <> 'system' AND user_id = (SELECT user_id FROM chats WHERE id = $2)",
    [room.roomId, room.chatId])).rows[0].max;
await send(alice, 'пока Боба не было');
await alice.evaluate(id => api(`/api/messages/${id}`, { method: 'DELETE' }), doomedId);
await bob.waitForFunction(() => document.getElementById('connection-status').hidden, null, { timeout: 10000 }).catch(() => {});
await bob.waitForTimeout(2500);
const afterReconnect = await bob.evaluate(id => ({
    texts: [...document.querySelectorAll('#chat-messages .message-text')].map(t => t.textContent),
    deletedShown: Boolean(document.querySelector(`[data-message-id="${id}"]`)),
    banner: !document.getElementById('connection-status').hidden,
}), doomedId);
check('после переподключения пропущенное догружено, удалённое убрано, плашки нет',
    afterReconnect.texts.includes('пока Боба не было') && !afterReconnect.deletedShown && !afterReconnect.banner,
    JSON.stringify(afterReconnect));
await send(alice, 'снова вживую');
await bob.waitForTimeout(800);
check('и новые сообщения снова приходят вживую: сокет вернулся в комнату',
    await bob.evaluate(() => [...document.querySelectorAll('#chat-messages .message-text')].some(t => t.textContent === 'снова вживую')));

/* ------------------------- файл ------------------------- */

await bob.goto('about:blank');
const fileId = await alice.evaluate(async () => {
    // Открытый путь: в комнате с шифрованием его не шлёт интерфейс, но
    // сервер его принимает — и раньше ставил «прочитано» через 2 секунды.
    const form = new FormData();
    form.append('file', new Blob(['заметка'], { type: 'text/plain' }), 'note.txt');
    form.append('chatId', String(currentChatId));
    const r = await fetch('/api/messages/file', { method: 'POST', headers: { 'X-CSRF-Token': await csrfToken() }, body: form });
    return (await r.json()).message.id;
});
await sleep(3000);
const fileStatus = await alice.evaluate(async id =>
    (await api(`/api/messages/${currentChatId}`)).messages.find(m => m.id === id)?.status, fileId);
check('файл, который никто не открывал, — не «прочитано»', fileStatus === 'sent', fileStatus);

/* ------------------------- границы ------------------------- */

const bobChat = (await db.query('SELECT id FROM chats WHERE room_id = $1 AND user_id <> (SELECT user_id FROM chats WHERE id = $2)',
    [room.roomId, room.chatId])).rows[0].id;
const capped = await alice.evaluate(async id => {
    const r = await api(`/api/chats/${id}/read`, { method: 'POST', body: JSON.stringify({ upTo: 2000000000 }) });
    return r;
}, room.chatId);
const maxId = Number((await db.query('SELECT max(id) FROM messages WHERE room_id = $1', [room.roomId])).rows[0].max);
const stored = (await db.query('SELECT last_read_id FROM chats WHERE id = $1', [room.chatId])).rows[0].last_read_id;
check('отметку не сдвинуть за конец чата', capped.success && stored === maxId, `${stored} vs ${maxId}`);
const foreign = await alice.evaluate(id => api(`/api/chats/${id}/read`, { method: 'POST', body: JSON.stringify({ upTo: 1 }) }), bobChat);
check('в чужом чате отметку не поставить', foreign.success === false, foreign.message);

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
