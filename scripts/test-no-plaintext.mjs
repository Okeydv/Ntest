// Открытым текстом — только боту.
//
//   - шифрование на устройстве не поднялось (здесь: сервер ключей не
//     отвечает) — сообщение не уходит ни открытым, ни как-то ещё; сказано
//     почему, текст остаётся в ленте пузырём «Не отправлено · Повторить ·
//     Удалить», «Повторить» (там или в тосте) поднимает шифрование и
//     отправляет;
//   - у собеседника нет ни одного устройства с ключами — сообщение ждёт на
//     устройстве («Уйдёт, когда … откроет Nyxo»), на сервер ничего не уходит, в
//     шапке «У … нет устройства с шифрованием»; ждущее переживает
//     перезагрузку, его можно отменить; когда у собеседника появляются
//     ключи, сервер сообщает об этом (peerKeysReady), и сообщение уходит
//     само;
//   - в группе, где ключей нет у одного участника, остальные получают
//     сообщение, а под ним — «Не доставлено: … — нет ключей» (и после
//     перезагрузки тоже).
//
// Требует поднятых Postgres, key-server и server.js на 3006 и ЧИСТОЙ базы.
// Запуск: TEST_DATABASE_URL=... node scripts/test-no-plaintext.mjs

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
    const context = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': `10.0.17.${nextIp++}` } });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return page;
}
// withKeys: false — аккаунт без единого устройства (ещё не открывал Nyxo).
const register = (page, u, { withKeys = true } = {}) => page.evaluate(async ([u, withKeys]) => {
    const r = await api('/api/register', { method: 'POST',
        body: JSON.stringify({ username: u, email: `${u}@example.com`, password: 'password123', confirmPassword: 'password123' }) });
    currentUser = r.user; showApp();
    if (withKeys) await setupE2EE();
    await loadChats();
}, [u, withKeys]);
const ROOM = '.chat-item[data-room-id]:not([data-room-id=""])';
async function openRoom(page, name) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator(name ? `.chat-item:has-text("${name}")` : ROOM).first().click();
    await page.waitForTimeout(1200);
}
async function newRoom(owner, name, ...guests) {
    const code = await owner.evaluate(async name => {
        const c = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name }) });
        return (await api(`/api/chats/${c.chat.id}/link`, { method: 'POST', body: JSON.stringify({ requireApproval: false }) })).code;
    }, name);
    for (const g of guests) await g.evaluate(c => api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code: c }) }), code);
}
const count = async text => Number((await db.query('SELECT count(*) FROM messages WHERE text = $1', [text])).rows[0].count);
async function send(page, text) {
    await page.fill('#message-input', text);
    await page.press('#message-input', 'Enter');
    await page.waitForTimeout(1500);
}
const lastText = page => page.evaluate(() => [...document.querySelectorAll('#chat-messages .message-text')].at(-1)?.textContent);

/* ------------------------- своё шифрование не поднялось ------------------------- */

const alice = await openApp('alice');
await register(alice, 'alice');
const carol = await openApp('carol');
// Сервер ключей «недоступен» — ключи этого устройства не публикуются.
await carol.route('**/api/keys/**', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ success: false, message: 'Сервер ключей недоступен' }) }));
await register(carol, 'carol');
check('у Кэрол шифрование не поднялось', await carol.evaluate(() => !e2ee.isReady()));
await newRoom(alice, 'С Кэрол', carol);
await carol.reload({ waitUntil: 'networkidle' });
await carol.waitForTimeout(1500);
await carol.locator(ROOM).first().click();
await carol.waitForTimeout(1200);
check('в шапке — «Шифрование на этом устройстве не работает»',
    (await carol.textContent('#chat-encryption')).includes('не работает'), await carol.textContent('#chat-encryption'));
const plainPosts = [];
carol.on('request', r => { if (r.method() === 'POST' && /\/api\/messages(\/file)?$/.test(new URL(r.url()).pathname)) plainPosts.push(r.url()); });
await send(carol, 'без шифрования не уйду');
const toast = await carol.textContent('#toast');
check('сообщение не ушло, и сказано почему', /не работает/.test(toast) && /сервер ключей/.test(toast), toast);
check('на открытый путь клиент не пошёл', plainPosts.length === 0 && await count('без шифрования не уйду') === 0, plainPosts.join(', '));
check('текст не пропал: пузырь «Не отправлено · Повторить · Удалить»', await carol.evaluate(() => {
    const bubble = [...document.querySelectorAll('#chat-messages .message.is-failed')].find(m => m.textContent.includes('без шифрования не уйду'));
    return bubble ? bubble.querySelector('.message-failed').textContent.replace(/\s+/g, ' ').trim() : null;
}) === 'Не отправлено · Повторить · Удалить');
check('в тосте — «Повторить»', (await carol.textContent('#toast .toast-action')) === 'Повторить');
await carol.unroute('**/api/keys/**');
await carol.click('#toast .toast-action');
await carol.waitForTimeout(3000);
check('«Повторить» поднял шифрование', await carol.evaluate(() => e2ee.isReady()));
await openRoom(alice);
check('и сообщение дошло зашифрованным', await lastText(alice) === 'без шифрования не уйду', await lastText(alice));
check('после повтора «Не отправлено» пропало, пузырь один', await carol.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message')].filter(m => m.textContent.includes('без шифрования не уйду')).length === 1
    && !document.querySelector('#chat-messages .message.is-failed')));

/* ------------------------- у собеседника нет ключей ------------------------- */

const erin = await openApp('erin');
await register(erin, 'erin', { withKeys: false });
await newRoom(alice, 'С Эрин', erin);
await openRoom(alice, 'С Эрин');
check('в шапке — «У erin нет устройства с шифрованием»',
    (await alice.textContent('#chat-encryption')).includes('У erin нет устройства с шифрованием'), await alice.textContent('#chat-encryption'));
await send(alice, 'подожду ключей');
const pendingView = await alice.evaluate(() => {
    const el = [...document.querySelectorAll('#chat-messages .message.is-pending')].at(-1);
    return el ? el.textContent : null;
});
check('сообщение ждёт на устройстве', pendingView && pendingView.includes('подожду ключей') && pendingView.includes('Уйдёт, когда erin откроет Nyxo. Не закрывайте вкладку'), pendingView);
check('на сервер ничего не ушло', await count('подожду ключей') === 0
    && (await db.query("SELECT count(*) FROM messages m JOIN chats c ON c.room_id = m.room_id WHERE c.name = 'С Эрин' AND m.message_type <> 'system'")).rows[0].count === '0');
check('поле очистилось', await alice.inputValue('#message-input') === '');
await send(alice, 'это отменю');
await alice.locator('.message.is-pending', { hasText: 'это отменю' }).locator('.pending-cancel').click();
await alice.waitForTimeout(500);
check('ждущее можно отменить', await alice.locator('.message.is-pending', { hasText: 'это отменю' }).count() === 0);
await openRoom(alice, 'С Эрин');
check('ждущее переживает перезагрузку, отменённое — нет',
    await alice.locator('.message.is-pending', { hasText: 'подожду ключей' }).count() === 1
    && await alice.locator('.message.is-pending', { hasText: 'это отменю' }).count() === 0);

// Эрин впервые открывает Nyxo на устройстве — появляются ключи.
await erin.evaluate(() => setupE2EE());
await alice.waitForTimeout(4000);
check('ключи у Эрин появились — ждущее ушло само', await alice.locator('.message.is-pending').count() === 0
    && await alice.locator('#chat-messages .message', { hasText: 'подожду ключей' }).count() === 1);
await openRoom(erin);
check('и Эрин его прочитала', await lastText(erin) === 'подожду ключей', await lastText(erin));
check('на сервере — только шифротекст', await count('подожду ключей') === 0);

/* ------------------------- в группе ключей нет у одного ------------------------- */

const bob = await openApp('bob');
await register(bob, 'bob');
const frank = await openApp('frank');
await register(frank, 'frank', { withKeys: false });
await newRoom(alice, 'Втроём', bob, frank);
await openRoom(alice, 'Втроём');
await send(alice, 'всем, у кого есть ключи');
const note = await alice.evaluate(() => [...document.querySelectorAll('#chat-messages .message')].at(-1)?.querySelector('.message-undelivered')?.textContent);
check('под сообщением — «Не доставлено: frank — нет ключей»', note === 'Не доставлено: frank — нет ключей', note);
await openRoom(bob);
check('Боб его получил', await lastText(bob) === 'всем, у кого есть ключи', await lastText(bob));
await openRoom(alice, 'Втроём');
check('пометка остаётся после перезагрузки', await alice.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message')].at(-1)?.querySelector('.message-undelivered')?.textContent) === note);

/* ------------------------- ответ потерялся ------------------------- */

// Сервер сообщение принял, а ответ до клиента не дошёл. Это обрыв сети:
// сообщение ждёт с часиками и досылается само (п. 170) — с тем же id,
// сервер отдаёт сохранённое, второго сообщения нет.
await openRoom(alice, 'Втроём');
const mark = Number((await db.query('SELECT max(id) FROM messages')).rows[0].max);
let dropped = false;
await alice.route('**/api/messages/encrypted', async route => {
    if (dropped) return route.continue();
    dropped = true;
    await route.fetch();
    await route.abort('connectionreset');
});
await send(alice, 'дойду один раз');
check('ответ потерялся — часики, а не «Не отправлено»', await alice.evaluate(() => {
    const b = [...document.querySelectorAll('#chat-messages .message.sent')].at(-1);
    return b.classList.contains('is-sending') && !b.classList.contains('is-failed');
}));
// Досылка — как на connect/online.
await alice.evaluate(() => flushPending());
await alice.waitForTimeout(1500);
await alice.unroute('**/api/messages/encrypted');
const copies = Number((await db.query('SELECT count(*) FROM messages WHERE id > $1 AND encrypted', [mark])).rows[0].count);
const bubbles = await alice.locator('#chat-messages .message', { hasText: 'дойду один раз' }).count();
check('на сервере одно сообщение, на экране один пузырь', bubbles === 1 && copies === 1, `пузырей ${bubbles}, записей ${copies}`);
await openRoom(bob);
check('и у Боба оно одно', await bob.locator('#chat-messages .message', { hasText: 'дойду один раз' }).count() === 1);

/* ------------------------- одно сообщение дважды ------------------------- */

const once = await bob.evaluate(async () => {
    const page = (await api(`/api/messages/${currentChatId}`)).messages;
    const message = page.filter(m => m.message_type !== 'system').at(-1);
    clearFeed();
    // Сокет и история принесли одно и то же разом.
    await Promise.all([appendMessageDecrypted({ ...message }), appendMessageDecrypted({ ...message })]);
    const shownTwice = document.querySelectorAll(`#chat-messages [data-message-id="${message.id}"]`).length;
    appendMessage({ ...message, text: 'заменено', encrypted: false });
    const afterReplace = document.querySelectorAll(`#chat-messages [data-message-id="${message.id}"]`);
    return { shownTwice, replaced: afterReplace.length, text: afterReplace[0]?.querySelector('.message-text')?.textContent };
});
check('одно сообщение, пришедшее дважды разом, — один пузырь', once.shownTwice === 1, JSON.stringify(once));
check('повторная отрисовка заменяет пузырь, а не добавляет второй', once.replaced === 1 && once.text === 'заменено', JSON.stringify(once));

/* ------------------------- сокет без шифрования ------------------------- */

// У Кэрол шифрование когда-то не поднималось; сокет после входа всё равно
// переподключается с её сессией — ответ бота приходит без перезагрузки.
const dan = await openApp('dan');
await dan.route('**/api/keys/**', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"success":false}' }));
await register(dan, 'dan');
await dan.locator('.chat-item[data-room-id=""]').first().click();
await dan.waitForTimeout(800);
const before = await dan.locator('#chat-messages .message.received').count();
await send(dan, 'бот, ты тут?');
await dan.waitForTimeout(2500);
check('без шифрования сокет живой: ответ бота пришёл сам', await dan.locator('#chat-messages .message.received').count() > before);

/* ------------------------- сервер ключей лёг ------------------------- */

const gina = await openApp('gina');
await register(gina, 'gina');
await newRoom(alice, 'С Гиной', gina);
await openRoom(alice, 'С Гиной');
await alice.route('**/api/keys/bundle/**', route => route.fulfill({ status: 503, contentType: 'application/json',
    body: JSON.stringify({ success: false, code: 'KEY_SERVER_UNAVAILABLE', message: 'Шифрование на сервере временно недоступно', errorId: 'abcdef012345' }) }));
await send(alice, 'без сервера ключей не уйду');
const downToast = await alice.textContent('#toast');
check('сервер ключей лёг — «Шифрование на сервере временно недоступно — сообщение не отправлено»',
    downToast.includes('Шифрование на сервере временно недоступно — сообщение не отправлено'), downToast);
check('код ошибки — отдельной строкой', /\nКод ошибки: abcdef012345/.test(downToast), JSON.stringify(downToast));
check('это не «нет ключей у собеседника»: сообщение не встало ждать, а «Не отправлено»',
    await alice.locator('.message.is-pending').count() === 0
    && await alice.locator('.message.is-failed', { hasText: 'без сервера ключей не уйду' }).count() === 1);
await alice.unroute('**/api/keys/bundle/**');
await alice.locator('.message.is-failed', { hasText: 'без сервера ключей не уйду' }).locator('button', { hasText: 'Удалить' }).click();

/* ------------------------- бот ------------------------- */

await alice.locator('.chat-item[data-room-id=""]').first().click();
await alice.waitForTimeout(800);
await send(alice, 'привет, бот');
check('боту — открытым текстом, как и раньше', await count('привет, бот') === 1);

check('ошибок на страницах нет', errors.length === 0, errors.join('; '));
await finish(browser, fails);
await db.end();
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
