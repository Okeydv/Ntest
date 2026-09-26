// Сквозной тест E2EE через интерфейс (этап A3).
//
// Два независимых окна браузера = два устройства с собственными
// IndexedDB. Сообщение набирается в поле ввода одного и должно появиться
// расшифрованным у другого — то есть проверяется вся цепочка: регистрация
// устройства, публикация ключей, X3DH, конверты, сокет, расшифровка,
// отрисовка.
//
// Плюс главное утверждение всего этапа: в базе сервера открытого текста
// нет. Его проверяет вызывающий скрипт по SQL, здесь — что приложение при
// этом работает.
//
// Требует поднятых Postgres, key-server и server.js на 3006 (см.
// scripts/integration-test-devices.mjs) и ЧИСТОЙ базы.
//
// Запуск: node scripts/test-e2ee-ui.mjs

import { launch, finish } from './lib/browser.mjs';

const BASE = 'http://127.0.0.1:3006';
let fails = 0;
const check = (l, c, d = '') => {
    console.log(`${c ? 'ok  ' : 'FAIL'}  ${l}${d ? '  — ' + d : ''}`);
    if (!c) fails++;
};

const browser = await launch();

/** Отдельный контекст = отдельный браузер = отдельное устройство. */
async function openApp(label) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(`${label}: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error') errors.push(`${label} console: ${m.text()}`); });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    return { ctx, page, errors, label };
}

const register = (app, username, email) => app.page.evaluate(async ([u, e]) => {
    const r = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({ username: u, email: e, password: 'password123', confirmPassword: 'password123' }),
    });
    if (!r.success) throw new Error(r.message);
    currentUser = r.user;
    showApp();
    await setupE2EE();
    await loadChats();
    return { userId: r.user.id, deviceId: e2eeDeviceId };
}, [username, email]);

/* ===================== регистрация и ключи ===================== */

const alice = await openApp('alice');
const aliceInfo = await register(alice, 'alice', 'alice@example.com');
check('устройство A зарегистрировано и ключи опубликованы', aliceInfo.deviceId > 0,
    `deviceId=${aliceInfo.deviceId}`);

check('приватный ключ устройства неизвлекаем', await alice.page.evaluate(async () => {
    const store = await import('/crypto/store.js');
    const identity = await store.identity.load();
    return identity.dh.privateKey.extractable === false && identity.signing.privateKey.extractable === false;
}));

check('пул одноразовых prekeys опубликован', await alice.page.evaluate(async () => {
    const info = await api('/api/keys/one-time-prekeys/count');
    return info.count >= 40;
}));

/* ===================== общий чат ===================== */

const chat = await alice.page.evaluate(async () => {
    const created = await api('/api/chats', { method: 'POST', body: JSON.stringify({ name: 'Тайная комната' }) });
    const invite = await api(`/api/chats/invite/${created.chat.id}`);
    return { chatId: created.chat.id, code: invite.code };
});

const bob = await openApp('bob');
const bobInfo = await register(bob, 'bob', 'bob@example.com');
const bobChatId = await bob.page.evaluate(async (code) => {
    const joined = await api('/api/chats/join', { method: 'POST', body: JSON.stringify({ code }) });
    return joined.chat.id;
}, chat.code);
check('устройство B зарегистрировано и вошло в чат', bobInfo.deviceId > 0 && bobChatId > 0);

// Чат открывается кликом по элементу списка, а не вызовом openChat с
// выдуманными аргументами: room_id известен только списку, а обработчик
// входящих сверяет именно его. Тест обязан идти тем же путём, что человек.
// Открываем общий чат, а не первый попавшийся. Первым в списке идёт чат с
// ботом: у него нет других устройств, шифровать там не для кого, и клиент
// штатно уходит на открытый путь.
//
// Выбираем по наличию room_id, а не по названию: у присоединившегося
// запись чата называется по пригласившему («Чат с alice»), а не так, как
// её назвал автор.
const ROOM_CHAT = '.chat-item[data-room-id]:not([data-room-id=""])';
const openFromList = async (app) => {
    await app.page.reload({ waitUntil: 'networkidle' });
    await app.page.waitForTimeout(1200);
    await app.page.waitForSelector('.chat-item', { timeout: 5000 });
    try {
        await app.page.locator(ROOM_CHAT).first().click({ timeout: 8000 });
    } catch (e) {
        const list = await app.page.evaluate(() =>
            [...document.querySelectorAll('.chat-item')].map(x => x.textContent.trim().replace(/\s+/g, ' ')));
        throw new Error(`${app.label}: общий чат не найден. В списке: ${JSON.stringify(list)}`);
    }
    await app.page.waitForTimeout(700);
};
await openFromList(alice);
await openFromList(bob);

/* ===================== отправка через интерфейс ===================== */

const SECRET = 'Это сообщение сервер прочитать не должен';
await alice.page.fill('#message-input', SECRET);
await alice.page.click('#send-btn');
await alice.page.waitForTimeout(1500);

const bobText = await bob.page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message-text')].map(e => e.textContent));
check('получатель увидел расшифрованный текст', bobText.includes(SECRET),
    JSON.stringify(bobText).slice(0, 120));

const aliceText = await alice.page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message-text')].map(e => e.textContent));
check('отправитель видит своё сообщение', aliceText.includes(SECRET));

check('заглушек «недоступно» нет', await bob.page.evaluate(() =>
    document.querySelectorAll('.message-locked').length === 0));

/* ===================== ответ в обратную сторону ===================== */

const REPLY = 'Ответ тоже зашифрован';
await bob.page.fill('#message-input', REPLY);
await bob.page.click('#send-btn');
await bob.page.waitForTimeout(1500);

check('ответ расшифрован у первого устройства', await alice.page.evaluate(t =>
    [...document.querySelectorAll('#chat-messages .message-text')].some(e => e.textContent === t), REPLY));

/* ===================== история после перезагрузки ===================== */

await openFromList(alice);
await alice.page.waitForTimeout(600);

const afterReload = await alice.page.evaluate(() =>
    [...document.querySelectorAll('#chat-messages .message-text')].map(e => e.textContent));
check('после перезагрузки своё сообщение на месте (локальный кэш)', afterReload.includes(SECRET),
    JSON.stringify(afterReload).slice(0, 140));
check('после перезагрузки чужое сообщение на месте (сессия из IndexedDB)', afterReload.includes(REPLY));

/* ===================== новое устройство истории не видит ===================== */

const alicePhone = await openApp('alice-phone');
await alicePhone.page.evaluate(async () => {
    const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ email: 'alice@example.com', password: 'password123' }) });
    currentUser = r.user;
    showApp();
    await setupE2EE();
    await loadChats();
});
const hasChat = await alicePhone.page.$('.chat-item');
if (hasChat) {
    await openFromList(alicePhone);
    await alicePhone.page.waitForTimeout(600);
    const locked = await alicePhone.page.evaluate(() => document.querySelectorAll('.message-locked').length);
    const visible = await alicePhone.page.evaluate(() =>
        [...document.querySelectorAll('#chat-messages .message-text')].map(e => e.textContent));
    check('новое устройство показывает заглушку, а не пустоту и не текст',
        locked > 0 && !visible.includes(SECRET), `заглушек: ${locked}`);
} else {
    check('новое устройство получило список чатов', false, 'чат не найден');
}

/* ===================== ошибок в консоли нет ===================== */

const allErrors = [...alice.errors, ...bob.errors, ...alicePhone.errors]
    .filter(e => !/favicon|Failed to load resource/i.test(e));
check('ошибок в консоли браузера нет', allErrors.length === 0, allErrors.slice(0, 3).join(' | '));

await finish(browser, fails);
console.log(fails ? `\n${fails} проверок провалено` : '\nвсе проверки пройдены');
process.exit(fails ? 1 : 0);
